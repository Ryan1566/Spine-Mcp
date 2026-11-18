// 一行式渲染预览：给工程路径 + 输出目录，自动生成临时导出设置、调 CLI 出图、回收产物、清理设置。
// 与 spine_export 的区别：不需要事先准备 export-settings.json，专为「看一眼实际渲染」设计。
// 3.8.75 的 -o 语义：渲染导出是文件基名，png + animationType=all 例外（当目录）。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertSafePath, runSpine } from './spine-cli.mjs';
import { buildExportSettings, isRenderFormat, outputPathKind, RENDER_FORMATS } from './export-settings.mjs';
import { collectRenderOutputs } from './render-outputs.mjs';
import { failureHint } from './export-workflow.mjs';
import { renderGif } from './render-gif.mjs';

const DEFAULT_TIMEOUT = 600000;

export function previewOutputBase(projectPath, outputDir, format, animationType) {
  const stem = path.basename(projectPath).replace(/\.spine$/i, '');
  return outputPathKind(format, animationType) === 'directory' ? outputDir : path.join(outputDir, stem);
}

export async function renderPreview({
  projectPath,
  outputDir,
  format = 'png',
  animation,
  animationType = animation === undefined ? 'all' : 'single',
  skeleton,
  skin,
  fps,
  lastFrame,
  msaa,
  backgroundColor,
  timeoutMs = DEFAULT_TIMEOUT,
  dryRun = false,
} = {}) {
  assertSafePath(projectPath, 'projectPath', { mustExist: true });
  assertSafePath(outputDir, 'outputDir', {});
  if (!isRenderFormat(format)) throw new Error(`format 只支持 ${RENDER_FORMATS.join('/')}，收到 ${format}`);

  const settings = buildExportSettings({ format, animationType, animation, skeleton, skin, fps, lastFrame, msaa, backgroundColor });
  const outputBase = previewOutputBase(projectPath, outputDir, format, animationType);
  const plan = {
    strategy: 'render-preview',
    projectPath,
    outputDir,
    format,
    animationType,
    ...(animation === undefined ? {} : { animation }),
    ...(skeleton === undefined ? {} : { skeleton }),
    ...(skin === undefined ? {} : { skin }),
    ...(settings.fps === undefined ? {} : { fps: settings.fps }),
    outputPath: outputBase,
    outputKind: outputPathKind(format, animationType),
    dryRun,
    note: format === 'gif'
      ? '使用 Spine 渲染完整 PNG 序列，再按帧时长编码 GIF。每个动画和皮肤组合单独生成 GIF。'
      : '渲染导出的 -o 是文件基名；png + animationType=all 时当目录。设置文件由本工具临时生成并在结束后删除。',
  };
  if (dryRun) return { ...plan, success: false, exitCode: null, count: 0, outputs: [] };
  if (format === 'gif') {
    const { command, args, stdout, stderr, ...result } = await renderGif({ projectPath, outputPath: outputBase, settings, timeoutMs });
    return {
      ...plan, ...result,
      previewFiles: result.outputs.slice(0, 20).map(({ path }) => path),
      ...(result.count > 20 ? { previewFilesTruncated: true } : {}),
    };
  }

  let stat = null;
  try {
    stat = await fs.stat(outputDir);
  } catch {
    stat = null;
  }
  if (stat && !stat.isDirectory()) throw new Error(`outputDir 已存在但不是目录: ${outputDir}`);
  await fs.mkdir(outputDir, { recursive: true });

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'spine-preview-'));
  const settingsPath = path.join(tmpDir, 'preview.json');
  const startedAt = Date.now();
  let run;
  try {
    await fs.writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
    run = await runSpine(['-i', projectPath, '-o', outputBase, '-e', settingsPath], { timeoutMs });
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }

  const found = await collectRenderOutputs({ outputPath: outputBase, format, startedAt });
  const result = {
    ...plan,
    success: run.success && found.count > 0,
    exitCode: run.exitCode,
    settings: { temporary: true, removed: true, class: settings.class },
    count: found.count,
    totalBytes: found.totalBytes,
    outputs: found.outputs,
    scannedDirs: found.scannedDirs,
  };
  if (found.count > 0) {
    result.previewFiles = found.outputs.slice(0, 20).map((o) => o.path);
    if (found.outputs.length > 20) result.previewFilesTruncated = true;
    result.nextStep = '这些是实际渲染出的帧，可直接查看；若与 spine_inspect_mesh 的结构数据（面片数 / 权重骨骼）对不上，说明工程里有结构问题或导出设置不对。评审浅色美术时建议传 backgroundColor: "#202020"，白底容易看不出细节。';
  } else {
    result.error = failureHint(run.stdout, run.stderr) ?? 'CLI 退出码为 0 但没有找到产物';
    result.note = `${result.note} 已扫描: ${found.scannedDirs.join(' / ') || outputBase}`;
  }
  if (run.stderr && (run.stderr.match(/ERROR|Exception|Caused by/i))) {
    result.stderrHint = failureHint(run.stdout, run.stderr);
  }
  return result;
}
