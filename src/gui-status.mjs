// 查询 Spine GUI **当前打开的是哪个工程**。
//
// 为什么不能靠文件 mtime：打开工程是只读操作，不落盘也就不会更新 mtime；
// 只有保存才写文件。所以「mtime 最新」完全可能是一个早已关掉的工程，
// 「mtime 很旧」也完全可能是正开着的那个（实测踩过：spinemcp_test.spine 的
// mtime 停在 01:50，窗口从 19:59 一直开着它）。
//
// 可靠判据是进程的窗口标题：Spine 3.8.75 打开工程后标题是
// `Spine - <工程名>`（不带扩展名），没开工程时就是 `Spine`。
// 这里用 tasklist 读它，零依赖、不截图、不模拟 UI。
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const GUI_PROCESS = 'Spine.exe';

// tasklist 的 CSV 用系统的 OEM 代码页输出（中文 Windows 是 GBK），
// 只按逗号切会把 "253,024 K" 这类带逗号的字段切坏，所以老老实实按引号状态扫。
function parseCsvLine(line) {
  const cells = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (ch === ',' && !quoted) {
      cells.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur);
  return cells;
}

function decodeOem(buffer) {
  // Node 20+ 自带 full-icu，gbk 可用；万一不可用就退回 utf8 保证不抛
  try {
    return new TextDecoder('gbk').decode(buffer);
  } catch {
    return buffer.toString('utf8');
  }
}

export function parseWindowTitle(title) {
  const text = String(title ?? '').trim();
  if (!text) return { projectName: null, dirty: false };
  const sep = text.indexOf(' - ');
  if (sep < 0) return { projectName: null, dirty: false };
  let name = text.slice(sep + 3).trim();
  // 带未保存改动时 Java 桌面应用可能在标题尾部加 *，Spine 3.8.75 实测是加在**工程名前**：
  // `Spine - *Turn_AnimTest`。两种位置都要识别，否则会把 dirty 误判为 false，
  // 并且 projectName 带上 * 导致 matchesCurrent 误判为 false。
  let dirty = false;
  if (name.startsWith('*')) {
    dirty = true;
    name = name.slice(1).trim();
  }
  if (name.endsWith('*')) {
    dirty = true;
    name = name.slice(0, -1).trim();
  }
  return { projectName: name || null, dirty };
}

const baseName = (p) => path.basename(p, path.extname(p));

/** 读 GUI 进程与窗口标题。任何异常都降级成 available:false，绝不抛。 */
export function readGuiWindow() {
  if (process.platform !== 'win32') {
    return { available: false, guiRunning: false, reason: `当前平台 ${process.platform} 不支持窗口标题探测` };
  }
  let text;
  try {
    const buffer = execFileSync('tasklist', ['/v', '/fo', 'csv', '/fi', `imagename eq ${GUI_PROCESS}`], {
      windowsHide: true,
      timeout: 10000,
    });
    text = decodeOem(buffer);
  } catch (error) {
    return { available: false, guiRunning: false, reason: `tasklist 调用失败: ${error.message}` };
  }
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  // 第一行是表头；没有数据行说明进程没跑（tasklist 会输出 "INFO: No tasks..."，不是 CSV）
  const rows = lines.slice(1).filter((line) => line.startsWith('"'));
  if (!rows.length) {
    return { available: true, guiRunning: false, pid: null, windowTitle: null, projectName: null, dirty: false };
  }
  const cells = parseCsvLine(rows[0]);
  const pid = Number.parseInt(cells[1], 10) || null;
  const windowTitle = cells[cells.length - 1]?.trim() ?? null;
  const { projectName, dirty } = parseWindowTitle(windowTitle);
  return { available: true, guiRunning: true, pid, windowTitle, projectName, dirty };
}

/**
 * 查询 GUI 当前工程，并可选地核对某个工程路径是否就是它。
 * 只比文件名（去扩展名）——窗口标题里没有目录信息，同名不同目录区分不了，会在 hint 里写明。
 */
export function inspectGuiProject({ projectPath } = {}) {
  const win = readGuiWindow();
  const queriedName = projectPath ? baseName(projectPath) : null;
  const matchesCurrent = queriedName && win.projectName ? queriedName === win.projectName : null;
  const warnings = [];
  if (win.guiRunning && matchesCurrent === false) {
    warnings.push(
      `目标工程 ${queriedName} 不是 GUI 当前打开的工程（当前是 ${win.projectName}）；确认是否改错了文件`,
    );
  }
  if (win.guiRunning && win.dirty) {
    warnings.push('GUI 窗口标题带 *，可能有未保存改动；写盘后重载会覆盖它们，先让用户在编辑器里 Ctrl+S');
  }
  return {
    ...win,
    queried: projectPath ? { path: projectPath, name: queriedName } : null,
    matchesCurrent,
    warnings,
    hint: win.guiRunning
      ? `当前 GUI 打开的是 ${win.projectName ?? '(未打开工程)'}；仅按文件名匹配，同名不同目录无法区分`
      : win.available
        ? 'Spine GUI 没在运行'
        : '无法探测 GUI 窗口（原因见 reason）',
  };
}
