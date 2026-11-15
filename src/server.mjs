// 零依赖 MCP 协议层，dual-era：
//  - legacy（2025-11-25 及更早）：initialize 握手 + tools/list + tools/call
//  - modern（2026-07-28）：每请求 _meta 版本 + server/discover（无握手）
import { currentRuntime } from './build-info.mjs';
import { TOOLS, callTool } from './tools.mjs';

// spine_doctor 会带上这份指纹：MCP 进程是宿主 spawn 的，代码停留在启动那一刻，
// 磁盘上被 WorkBuddy 改过之后它不会自动升级 —— 用它能立刻看出「跑的是旧版」。
function runtimeStamp() {
  const runtime = currentRuntime();
  return {
    pid: runtime.pid,
    startedAt: runtime.startedAt,
    sourceHash: runtime.sourceHash,
    fileCount: runtime.fileCount,
    toolCount: TOOLS.length,
    checkCommand: 'node D:/Spine-Mcp/scripts/check-update.mjs',
  };
}

export const SERVER_INFO = { name: 'spine-mcp-local', version: '0.1.0' };
export const MODERN_VERSIONS = ['2026-07-28'];
export const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

// 2026-07-28 时代把 tools/list、prompts/list、resources/list、resources/templates/list、
// resources/read、server/discover 的结果定义为 CacheableResult，客户端会按 schema
// 强制校验 ttlMs（非负整数）与 cacheScope（'public' | 'private'）。
// 缺失即报 “Invalid result for tools/list: ttlMs ... cacheScope ...”，整段工具同步失败。
// 这里用规范默认值 0 / 'private'；本机工具结果不具备跨会话复用价值，不缓存。
const CACHE_FIELDS = { ttlMs: 0, cacheScope: 'private' };

const INSTRUCTIONS = [  '本机 Spine 3.8.75 动画 MCP。',
  '用 spine_frames_to_seconds 把「N 帧 @ fps」规格换算成 Spine 秒数，',
  '再用 spine_build_combat_animation 在 JSON 副本上写关键帧与事件帧。',
  '涉及官方 CLI 的工具需要环境变量 SPINE_EXE 指向本机 Spine.com；3.8.75 导出必须带 exportSettingsPath。',
].join(' ');

function ok(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id: id ?? null, error };
}

function discoverResult(id) {
  return ok(id, {
    resultType: 'complete',
    supportedVersions: MODERN_VERSIONS,
    capabilities: { tools: {} },
    _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
    instructions: INSTRUCTIONS,
    ...CACHE_FIELDS,
  });
}

function legacyInitialize(id, params) {
  const requested = params?.protocolVersion;
  return ok(id, {
    protocolVersion: LEGACY_VERSIONS.includes(requested) ? requested : '2025-11-25',
    capabilities: { tools: {} },
    serverInfo: SERVER_INFO,
    instructions: INSTRUCTIONS,
  });
}

async function toolsCall(id, params) {
  const name = params?.name;
  if (typeof name !== 'string') {
    return rpcError(id, -32602, 'tools/call 缺少 name');
  }
  const args = params.arguments ?? {};
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return rpcError(id, -32602, 'tools/call 的 arguments 必须是对象');
  }
  try {
    const raw = await callTool(name, args);
    const result = name === 'spine_doctor' && raw && typeof raw === 'object' ? { ...raw, build: runtimeStamp() } : raw;
    return ok(id, {
      resultType: 'complete',
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
      isError: false,
    });
  } catch (err) {
    const message = err?.message ?? String(err);
    const payload = { tool: name, error: message, hint: '工具参数或本地环境不满足要求，请检查路径与 SPINE_EXE' };
    return ok(id, {
      resultType: 'complete',
      content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
      structuredContent: payload,
      isError: true,
    });
  }
}

// 是否见过现代时代的 server/discover。用来区分「现代客户端声明了未知版本」
// 与「旧时代客户端只是把协商到的版本号回显进 _meta」。
let modernSeen = false;

export async function handle(req) {
  if (!req || req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
    return rpcError(req?.id, -32600, 'Invalid Request');
  }
  const hasId = Object.prototype.hasOwnProperty.call(req, 'id');
  const meta = req.params?._meta ?? {};
  const requested = meta['io.modelcontextprotocol/protocolVersion'];

  // 版本判定：
  //  - 现代版本在 _meta 里 -> 放行
  //  - 旧时代版本在 _meta 里 -> 放行（客户端回显协商结果，不是现代声明）
  //  - 未知版本：只有在客户端做过 server/discover（即确实走现代时代）后才回 -32022；
  //    旧时代会话里宽松放行，避免把工具同步整段打死。
  if (requested !== undefined && req.method !== 'initialize') {
    const known = MODERN_VERSIONS.includes(requested) || LEGACY_VERSIONS.includes(requested);
    if (!known && modernSeen) {
      return rpcError(req.id, -32022, 'Unsupported protocol version', {
        supported: MODERN_VERSIONS,
        requested,
      });
    }
  }

  switch (req.method) {
    case 'initialize':
      return legacyInitialize(req.id, req.params);
    case 'server/discover':
      modernSeen = true;
      return discoverResult(req.id);
    case 'notifications/initialized':
    case 'notifications/cancelled':
    case 'notifications/progress':
      return null;
    case 'ping':
      return ok(req.id, {});
    case 'tools/list':
      return ok(req.id, { resultType: 'complete', tools: TOOLS, ...CACHE_FIELDS });
    case 'tools/call':
      return toolsCall(req.id, req.params);
    case 'resources/list':
      return ok(req.id, { resultType: 'complete', resources: [], ...CACHE_FIELDS });
    case 'resources/templates/list':
      return ok(req.id, { resultType: 'complete', resourceTemplates: [], ...CACHE_FIELDS });
    case 'prompts/list':
      return ok(req.id, { resultType: 'complete', prompts: [], ...CACHE_FIELDS });
    default:
      return hasId
        ? rpcError(req.id, -32601, `Method not found: ${req.method}`)
        : null;
  }
}
