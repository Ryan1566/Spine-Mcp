// 只通过官方 Spine CLI 操作 .spine 工程。
// 3.8.75 关键约束：导出必须用 -e <export-settings.json>，且该文件必须真实存在。
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { backupFile } from './backup.mjs';
import { inspectGuiProject } from './gui-status.mjs';

export const SPINE_TARGET_VERSION = '3.8.75';

export function resolveSpineExe() {
  return process.env.SPINE_EXE?.trim() || 'Spine';
}

export function isSpineConfigured() {
  const exe = resolveSpineExe();
  if (exe === 'Spine') return false;
  try {
    return fs.statSync(exe).isFile();
  } catch {
    return false;
  }
}

export function assertSafePath(value, label, { mustExist = false } = {}) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} 必须是非空字符串路径`);
  }
  if (value.includes('\0') || value.includes('\n') || value.includes('\r')) {
    throw new Error(`${label} 含有非法字符`);
  }
  if (value.startsWith('-')) {
    throw new Error(`${label} 不能以 '-' 开头（会被 CLI 当成参数）`);
  }
  if (mustExist) {
    let stat;
    try {
      stat = fs.statSync(value);
    } catch {
      throw new Error(`${label} 不存在或无法访问: ${value}`);
    }
    if (!stat.isFile()) throw new Error(`${label} 不是文件: ${value}`);
  }
  return value;
}

export function assertWritableOutput(value, label, overwrite = false) {
  assertSafePath(value, label);
  if (fs.existsSync(value) && !overwrite) {
    throw new Error(`${label} 已存在；需要覆盖请显式传 overwrite=true: ${value}`);
  }
  const dir = path.dirname(value);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return value;
}

// shell:false + 参数数组，避免任何命令注入；stdout/stderr 全部回传给 AI 客户端便于排错。
export function runSpine(args, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve) => {
    const exe = resolveSpineExe();
    let settled = false;
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(exe, args, {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ command: exe, args, stdout, stderr, exitCode: -1, success: false, error: err.message });
      return;
    }

    const finish = (exitCode, error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        command: exe,
        args,
        stdout: stdout.slice(0, 20000),
        stderr: stderr.slice(0, 20000),
        exitCode,
        success: exitCode === 0 && error === null,
        error,
      });
    };

    const timer = setTimeout(() => {
      child.kill();
      finish(-1, `Spine CLI 超时（${timeoutMs}ms）`);
    }, timeoutMs);

    child.stdout?.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', (err) => finish(-1, `无法启动 Spine CLI: ${err.message}`));
    child.on('close', (code) => finish(code ?? -1));
  });
}

// 3.8.75 导出：Spine -i <in> -o <out> -e <settings.json> [-m]
export function exportArgs({ inputPath, outputDir, exportSettingsPath, clean = false, extraInputs = [] }) {
  assertSafePath(inputPath, 'inputPath', { mustExist: true });
  assertSafePath(outputDir, 'outputDir');
  assertSafePath(exportSettingsPath, 'exportSettingsPath', { mustExist: true });
  if (!Array.isArray(extraInputs)) throw new Error('extraInputs 必须是数组');
  // 3.8.75 支持一次调用里多组 -i/-e，实测可混合 JSON 与 Binary 导出。
  const args = ['-i', inputPath, '-o', outputDir, '-e', exportSettingsPath];
  for (const [index, item] of extraInputs.entries()) {
    assertSafePath(item?.inputPath, `extraInputs[${index}].inputPath`, { mustExist: true });
    assertSafePath(item?.exportSettingsPath, `extraInputs[${index}].exportSettingsPath`, { mustExist: true });
    args.push('-i', item.inputPath, '-e', item.exportSettingsPath);
  }
  if (clean) args.push('-m');
  return args;
}

// 3.8.75 导回：Spine -i <in.json> [-s <scale>] -o <out.spine> -r [<skeletonName>]
export function importArgs({ inputPath, outputPath, scale, skeletonName }) {
  assertSafePath(inputPath, 'inputPath', { mustExist: true });
  assertSafePath(outputPath, 'outputPath');
  const args = ['-i', inputPath];
  if (scale !== undefined) {
    if (typeof scale !== 'number' || !Number.isFinite(scale) || scale <= 0) {
      throw new Error('scale 必须是正数');
    }
    args.push('-s', String(scale));
  }
  args.push('-o', outputPath, '-r');
  if (skeletonName) {
    assertSafePath(skeletonName, 'skeletonName');
    args.push(skeletonName);
  }
  return args;
}

export async function replaceProjectFromImport(options, { run = runSpine, inspectGui = inspectGuiProject } = {}) {
  const { outputPath } = options;
  assertSafePath(outputPath, 'outputPath');
  const target = path.resolve(outputPath);
  if (path.extname(target).toLowerCase() !== '.spine') throw new Error('outputPath 必须是 .spine 工程路径');
  const before = fs.statSync(target, { bigint: true, throwIfNoEntry: false });
  if (!before?.isFile()) {
    throw new Error('replaceProject:true 时 outputPath 必须是已存在的工程（要替换的就是它）；新建工程请用 replaceProject:false');
  }
  const assertCurrentProject = () => {
    const gui = inspectGui({ projectPath: outputPath });
    if (gui.matchesCurrent !== true || gui.dirty !== false) {
      throw new Error('替换工程要求 Spine GUI 已打开对应工程且已保存改动；请检查 spine_gui_status');
    }
    return gui;
  };
  const gui = assertCurrentProject();
  const staging = path.join(path.dirname(target), `.spine-import-${randomUUID()}.spine`);
  const cliArgs = importArgs({ ...options, outputPath: staging });
  try {
    const result = await run(cliArgs);
    const imported = fs.statSync(staging, { throwIfNoEntry: false });
    if (!result.success || !imported?.isFile() || imported.size === 0) {
      return {
        ...result, success: false, replaceProject: true, replaced: false, gui,
        error: result.error ?? (result.success ? 'Spine CLI 未生成有效的临时工程' : null),
        note: 'CLI 未生成有效的临时 .spine 文件，目标工程未改动。',
      };
    }
    const currentGui = assertCurrentProject();
    // CLI 运行期间，编辑器或另一个请求可能已经保存了新版本。
    const current = fs.statSync(target, { bigint: true, throwIfNoEntry: false });
    if (!current || ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some((key) => current[key] !== before[key])) {
      throw new Error('导入期间目标工程已变化，本次替换已中止');
    }
    const backupPath = options.backup === false ? null : backupFile(target);
    try {
      // 同目录 rename 直接替换，即使重命名失败也不会先删除原件。
      fs.renameSync(staging, target);
    } catch (error) {
      throw new Error(`无法替换工程: ${error.message}${backupPath ? `（备份: ${backupPath}）` : ''}`, { cause: error });
    }
    return {
      ...result, replaceProject: true, replaced: true, replacedPath: outputPath,
      gui: currentGui, backupPath,
      note: '已整体替换工程，只保留导入的骨架。CLI 导入不写骨架画布尺寸；需要时在 GUI 中设置 Skeleton Size。',
    };
  } finally {
    fs.rmSync(staging, { force: true });
  }
}

// 3.8.75 清理：Spine -i <in.spine> -m
export function cleanArgs({ inputPath }) {
  assertSafePath(inputPath, 'inputPath', { mustExist: true });
  return ['-i', inputPath, '-m'];
}
