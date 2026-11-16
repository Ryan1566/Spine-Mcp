// 方案 C：CLI 改写工程后，请求 Spine GUI 重新打开该工程。
// 只使用官方 Editor 模式（Spine.exe <project.spine>），不模拟鼠标键盘、不抢焦点、不改动工程文件。
//
// 实测（3.8.75，2026-11-16 复核）：GUI 已运行时再启动 Spine.exe，新进程会把工程路径**转发给已有实例**
// 后自行退出，原窗口随即加载该工程（窗口标题从 `Spine` 变成 `Spine - 工程名`）。也就是说单实例锁
// 的表现是「转发」而不是「拒绝」，因此默认放行（allowWhenRunning = true）。
//
// 另一个坑：Spine 是 Java 应用，用的是 java.nio 区间文件锁，不会独占打开句柄，所以 detectGuiLock
// 的 'r+' 探测在有 GUI 运行时依旧成功，**判断不出「GUI 正在运行」**。它的结果只作参考，不能用来阻断启动。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { assertSafePath } from './spine-cli.mjs';

// 优先用显式 SPINE_GUI_EXE；否则把 SPINE_EXE 同目录的 .com 换成 .exe。
export function resolveGuiExe(env = process.env) {
  const explicit = env.SPINE_GUI_EXE?.trim();
  if (explicit) return explicit;
  const cli = env.SPINE_EXE?.trim();
  if (!cli) {
    throw new Error('未配置 SPINE_EXE / SPINE_GUI_EXE，无法定位 Spine.exe');
  }
  const dir = path.dirname(cli);
  const base = path.basename(cli).replace(/\.com$/i, '.exe');
  return path.join(dir, base);
}

// 仅供记录锁文件状态：Spine 用 Java 区间锁，'r+' 在有 GUI 时也能打开，因此 guiRunning 不可靠。
// 只读打开（'r'）始终可用，所以这个探测不会改动锁文件。
export function detectGuiLock(env = process.env) {
  const home = env.SPINE_HOME?.trim() || env.USERPROFILE?.trim() || env.HOME?.trim();
  if (!home) return { guiRunning: false, lockPath: null, reason: '无法确定用户目录，跳过锁检测' };
  const lockPath = path.join(home, 'Spine', '.lock');
  if (!fs.existsSync(lockPath)) {
    return { guiRunning: false, lockPath, reason: '锁文件不存在' };
  }
  let fd;
  try {
    fd = fs.openSync(lockPath, 'r+');
    return { guiRunning: false, lockPath, reason: '锁文件可写（Java 区间锁不阻止 r+ 打开，不能据此判定 GUI 未运行）' };
  } catch (err) {
    return { guiRunning: true, lockPath, reason: `锁被占用（${err.code ?? 'unknown'}），已有 Spine GUI 实例` };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export const GUI_RUNNING_HINT = [
  'Spine 3.8.75 的单实例锁实测表现是「转发」而非「拒绝」：GUI 已运行时启动 Spine.exe <工程路径>，',
  '新进程会把路径交给已有实例后自行退出，原窗口随即加载该工程（窗口标题变成「工程名 - Spine」）。',
  '注意 .lock 是 Java 区间锁，r+ 探测不出占用，所以 guiRunning 字段仅供参考。',
  'GUI 里若有未保存改动，请先 Ctrl+S；否则重新打开会用磁盘版本覆盖。',
].join(' ');

// 启动后如何确认真的打开了：新进程会退出，只能看原窗口标题。
export const GUI_FORWARDED_HINT = '已把工程路径交给 Spine；工程若成功打开，原窗口标题会变成「工程名 - Spine」，新拉起的 launcher 会自行退出（进程列表里只剩原实例）。';

// 所有会写 .spine 的工具统一附带这个提示。按用户约定：只告知，不自动重载、不模拟按键。
export const RELOAD_HINT = 'CLI 已写入 .spine 工程文件；Spine GUI 不会自动刷新，请在编辑器里手动 Ctrl+O 重新打开（若 GUI 里有未保存改动，先 Ctrl+S）。';

// dryRun 只返回计划；真实执行时以 detached 方式启动，不等待 GUI 退出。
// allowWhenRunning 默认 true：实测 GUI 已运行时会把工程路径转发给已有实例，这是可用的路径。
// 显式传 false 可恢复保守行为（探测到锁被占用就返回 blocked）。
export async function requestGuiReload({
  projectPath,
  dryRun = false,
  allowWhenRunning = true,
  env = process.env,
  spawnImpl = spawn,
  lockProbe = detectGuiLock,
} = {}) {
  assertSafePath(projectPath, 'projectPath', { mustExist: true });

  let guiExe = null;
  let configError = null;
  try {
    guiExe = resolveGuiExe(env);
  } catch (err) {
    configError = err.message;
    if (!dryRun) throw err;
  }

  const lock = lockProbe(env);
  const wouldBlock = lock.guiRunning && !allowWhenRunning;
  const plan = {
    strategy: 'editor-open',
    guiExe,
    projectPath,
    args: [projectPath],
    dryRun,
    guiRunning: lock.guiRunning,
    lockPath: lock.lockPath,
    lockReason: lock.reason,
    wouldBlock,
    note: '若 GUI 里有未保存改动，请先在编辑器里 Ctrl+S，否则重新打开会被磁盘版本覆盖。',
  };

  if (dryRun) {
    return { ...plan, launched: false, pid: null, blocked: false, warning: configError };
  }

  if (wouldBlock) {
    return { ...plan, launched: false, pid: null, blocked: true, hint: GUI_RUNNING_HINT };
  }

  if (!fs.existsSync(guiExe)) {
    throw new Error(`找不到 Spine GUI 可执行文件: ${guiExe}`);
  }

  return new Promise((resolve) => {
    const child = spawnImpl(guiExe, [projectPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.once('error', (err) => {
      resolve({ ...plan, launched: false, pid: null, blocked: false, error: `无法启动 Spine GUI: ${err.message}` });
    });
    child.once('spawn', () => {
      child.unref();
      resolve({ ...plan, launched: true, pid: child.pid ?? null, blocked: false, verifyHint: GUI_FORWARDED_HINT });
    });
  });
}
