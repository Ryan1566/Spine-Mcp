// 零依赖 MCP 协议层，dual-era：
//  - legacy（2025-11-25 及更早）：initialize 握手 + tools/list + tools/call
//  - modern（2026-07-28）：每请求 _meta 版本 + server/discover（无握手）
import { TOOLS, callTool } from './tools.mjs';

export const SERVER_INFO = { name: 'spine-mcp-local', version: '0.1.0' };
export const MODERN_VERSIONS = ['2026-07-28'];
export const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const INSTRUCTIONS = [
  '本机 Spine 3.8.75 动画 MCP。',
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
    const result = await callTool(name, args);
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

export async function handle(req) {
  if (!req || req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
    return rpcError(req?.id, -32600, 'Invalid Request');
  }
  const hasId = Object.prototype.hasOwnProperty.call(req, 'id');
  const meta = req.params?._meta ?? {};
  const requested = meta['io.modelcontextprotocol/protocolVersion'];

  // 现代客户端显式声明了版本但不受支持 -> 规范要求的 -32022，并列出支持版本。
  if (requested !== undefined && req.method !== 'initialize' && !MODERN_VERSIONS.includes(requested)) {
    return rpcError(req.id, -32022, 'Unsupported protocol version', {
      supported: MODERN_VERSIONS,
      requested,
    });
  }

  switch (req.method) {
    case 'initialize':
      return legacyInitialize(req.id, req.params);
    case 'server/discover':
      return discoverResult(req.id);
    case 'notifications/initialized':
    case 'notifications/cancelled':
    case 'notifications/progress':
      return null;
    case 'ping':
      return ok(req.id, {});
    case 'tools/list':
      return ok(req.id, { resultType: 'complete', tools: TOOLS });
    case 'tools/call':
      return toolsCall(req.id, req.params);
    case 'resources/list':
      return ok(req.id, { resultType: 'complete', resources: [] });
    case 'prompts/list':
      return ok(req.id, { resultType: 'complete', prompts: [] });
    default:
      return hasId
        ? rpcError(req.id, -32601, `Method not found: ${req.method}`)
        : null;
  }
}
