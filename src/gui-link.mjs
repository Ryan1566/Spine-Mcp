// 方案 C：CLI 改写工程后，请求 Spine GUI 重新打开该工程。
// 只使用官方 Editor 模式（Spine.exe <project.spine>），不模拟鼠标键盘、不抢焦点、不改动工程文件。
//
// 实测（3.8.75）：GUI 已运行时再启动 Spine.exe 不会转发工程路径，launcher 会因单实例锁
// `C:\Users\<user>\Spine\.lock` 报 "Unable to obtain file lock" 后退出，原窗口不会重载。
// 因此本模块默认在检测到锁被占用时阻止启动，避免产生注定失败的实例与错误日志。
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

// GUI 运行时 Spine 会独占打开 <home>/Spine/.lock；此时以 'r+' 打开会得到 EPERM/EACCES/EBUSY。
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
    return { guiRunning: false, lockPath, reason: '锁文件可写，未发现运行的 GUI' };
  } catch (err) {
    return { guiRunning: true, lockPath, reason: `锁被占用（${err.code ?? 'unknown'}），已有 Spine GUI 实例` };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export const GUI_RUNNING_HINT = [
  'Spine 3.8.75 有单实例锁：GUI 开着时第二个 Spine.exe 不会转发工程路径，只会报 Unable to obtain file lock。',
  '可选做法：① 在 GUI 里手动 Ctrl+O 重新打开（或 Import Data 导入生成的 JSON）；',
  '② 先在编辑器里 Ctrl+S 并关闭 GUI，再调用本工具以 Editor 模式重新打开工程；',
  '③ 显式传 allowWhenRunning=true 仍会尝试启动，但结果通常是失败。',
].join(' ');

// 所有会写 .spine 的工具统一附带这个提示。按用户约定：只告知，不自动重载、不模拟按键。
export const RELOAD_HINT = 'CLI 已写入 .spine 工程文件；Spine GUI 不会自动刷新，请在编辑器里手动 Ctrl+O 重新打开（若 GUI 里有未保存改动，先 Ctrl+S）。';

// dryRun 只返回计划；真实执行时以 detached 方式启动，不等待 GUI 退出。
export async function requestGuiReload({
  projectPath,
  dryRun = false,
  allowWhenRunning = false,
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
    note: 'CLI 改写工程后调用；若 GUI 里有未保存改动，请先在编辑器里 Ctrl+S，否则可能被覆盖。',
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
      resolve({ ...plan, launched: true, pid: child.pid ?? null, blocked: false });
    });
  });
}
