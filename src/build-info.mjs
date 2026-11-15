// 运行实例指纹：用来回答「我现在调用的是不是磁盘上最新的那版代码」。
//
// 背景：MCP server 是宿主在启动/重载插件时 spawn 的独立进程，它的代码在 spawn
// 那一刻就固定了。之后 WorkBuddy 改了 src/*.mjs，正在跑的实例不会跟着变，
// 工具清单和实现都会停留在旧版本 —— 而且不会有任何报错，只会「行为对不上」。
//
// 所以每个实例启动时把自身指纹写到 .runtime/server-<pid>.json，
// scripts/check-update.mjs 再拿磁盘现状跟它比对。
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.dirname(SRC_DIR);
export const STATE_DIR = path.join(REPO_ROOT, '.runtime');

// 存活判定不用 pid（沙箱/权限不同会误判），用心跳：进程每隔 HEARTBEAT_MS 刷新
// 自己那份指纹文件的 mtime，超过 LIVE_WINDOW_MS 没刷新就算已退出。
export const HEARTBEAT_MS = 30_000;
export const LIVE_WINDOW_MS = 70_000;

/** 只统计 .mjs：本仓库没有构建步骤，src 下的源码就是运行时真相。 */
export function sourceFingerprint(dir = SRC_DIR) {
  const files = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.mjs'))
    .sort();
  const combined = createHash('sha256');
  const perFile = {};
  let newest = { file: null, mtimeMs: 0 };
  for (const file of files) {
    const full = path.join(dir, file);
    const buf = fs.readFileSync(full);
    perFile[file] = createHash('sha256').update(buf).digest('hex').slice(0, 12);
    combined.update(file).update(buf);
    const { mtimeMs } = fs.statSync(full);
    if (mtimeMs > newest.mtimeMs) newest = { file, mtimeMs };
  }
  return {
    hash: combined.digest('hex').slice(0, 12),
    fileCount: files.length,
    files: perFile,
    newest,
  };
}

let cached = null;

/**
 * 当前进程的指纹。进程启动后源码不会变，所以只算一次。
 */
export function currentRuntime() {
  if (cached !== null) return cached;
  const fp = sourceFingerprint();
  cached = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    sourceHash: fp.hash,
    fileCount: fp.fileCount,
    files: fp.files,
    node: process.version,
  };
  return cached;
}

/** 把指纹落到 .runtime/server-<pid>.json，供外部比对脚本读取。 */
export function recordRuntime(extra = {}) {
  const state = { ...currentRuntime(), ...extra };
  const file = path.join(STATE_DIR, `server-${process.pid}.json`);
  const write = () => {
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(state, null, 2));
    } catch {
      /* 指纹落盘失败不影响服务本身 */
    }
  };
  write();

  // 心跳：让「这个实例还活着」这件事在文件系统上可见，不依赖 pid 列表权限。
  const beat = setInterval(write, HEARTBEAT_MS);
  if (typeof beat.unref === 'function') beat.unref();

  const cleanup = () => {
    clearInterval(beat);
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* 退出清理失败无所谓，check-update 会按心跳过期清掉 */
    }
  };
  process.once('exit', cleanup);
  return state;
}

/** 心跳是否还在有效窗口内（不依赖 pid 可见性）。 */
export function isLive(state, now = Date.now()) {
  const last = Date.parse(state?.lastHeartbeat ?? state?.startedAt ?? 0);
  if (!Number.isFinite(last)) return false;
  return now - last <= LIVE_WINDOW_MS;
}

/** 列出仍活着的实例指纹，按启动时间倒序；顺手清掉过期很久的垃圾文件。 */
export function listRuntimeStates(dir = STATE_DIR, { prune = false } = {}) {
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => /^server-\d+\.json$/.test(n));
  } catch {
    return [];
  }
  const states = [];
  for (const name of names) {
    const full = path.join(dir, name);
    try {
      const state = JSON.parse(fs.readFileSync(full, 'utf8'));
      const { mtimeMs } = fs.statSync(full);
      state.lastHeartbeat = new Date(mtimeMs).toISOString();
      state.heartbeatAgeMs = Date.now() - mtimeMs;
      state.alive = isLive(state);
      states.push(state);
      if (prune && state.heartbeatAgeMs > LIVE_WINDOW_MS * 20) fs.rmSync(full, { force: true });
    } catch {
      /* 半截文件不算数 */
    }
  }
  return states.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}
