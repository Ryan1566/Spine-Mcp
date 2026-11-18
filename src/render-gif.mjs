import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { encodeGif } from './gif-encode.mjs';
import { readPng } from './png-read.mjs';
import { collectRenderOutputs } from './render-outputs.mjs';
import { exportArgs, runSpine } from './spine-cli.mjs';
import { failureHint } from './export-workflow.mjs';
import { DEFAULT_GIF_FPS } from './export-settings.mjs';

// CLI 可按动画或皮肤分目录。按实际帧号排序，避免把 10 排到 2 前面。
function groupFrames(files) {
  const groups = new Map();
  for (const { path: file } of files) {
    const stem = path.basename(file, path.extname(file));
    const suffix = /^(.*)_(\d+)$/.exec(stem);
    const name = suffix?.[1] ?? stem;
    const key = path.join(path.dirname(file), name);
    const group = groups.get(key) ?? { name, frames: [] };
    group.frames.push({ file, index: suffix ? Number(suffix[2]) : 0 });
    groups.set(key, group);
  }
  return [...groups.values()].map(({ name, frames }) => {
    frames.sort((a, b) => a.index - b.index);
    if (frames.some(({ index }, i) => index !== frames[0].index + i)) {
      throw new Error(`PNG 序列 ${name} 存在重复或缺失的帧号`);
    }
    return { name, files: frames.map(({ file }) => file) };
  });
}

async function* readFrames(files) {
  for (const file of files) yield readPng(await fs.readFile(file));
}

export async function renderGif({ projectPath, outputPath, settings, clean, timeoutMs }, { run = runSpine } = {}) {
  const fps = settings.fps ?? DEFAULT_GIF_FPS;
  const repeat = settings.repeat ?? 0;
  if (!Number.isInteger(fps) || fps < 1 || fps > 50) throw new Error('GIF fps 必须是 1 到 50 的整数');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'spine-gif-'));
  let rendered;
  const outputs = [];
  const fail = (error) => ({
    ...rendered, success: false, renderFormat: 'gif', outputs, error,
    count: outputs.length, totalBytes: outputs.reduce((sum, file) => sum + file.sizeBytes, 0),
  });
  try {
    const frameBase = path.join(directory, 'frames');
    const settingsFile = path.join(directory, 'frames.json');
    // 原生 GIF 在 3.8.75 上会从空白淡入；原生 PNG 序列从动画的第一帧就有贴图。
    const png = {
      animationType: 'all', skinType: 'all', rangeStart: -1, rangeEnd: -1, maxBounds: true,
      ...settings, class: 'export-png', exportType: 'animation', outputType: 'filePerFrame',
      project: projectPath, output: frameBase, open: false, renderImages: true, fps,
    };
    if (png.animationType === 'all') await fs.mkdir(frameBase);
    await fs.writeFile(settingsFile, JSON.stringify(png), 'utf8');
    rendered = await run(exportArgs({
      inputPath: projectPath, outputDir: frameBase, exportSettingsPath: settingsFile, clean,
    }), { timeoutMs });
    if (!rendered.success) return fail(rendered.error ?? failureHint(rendered.stdout, rendered.stderr) ?? 'Spine PNG 序列导出失败');
    const frames = await collectRenderOutputs({ outputPath: frameBase, format: 'png' });
    if (!frames.count) return fail('Spine 未生成 PNG 序列，请检查动画、骨架和皮肤选择');
    if (frames.truncated) return fail('PNG 序列超过可处理的帧数，无法生成完整 GIF');
    const groups = groupFrames(frames.outputs);
    const stem = outputPath.replace(/\.gif$/i, '');
    const staged = [];
    const targets = new Set();
    for (const [index, group] of groups.entries()) {
      const target = groups.length === 1 ? `${stem}.gif` : `${stem}-${group.name}.gif`;
      const key = process.platform === 'win32' ? target.toLowerCase() : target;
      if (targets.has(key)) return fail(`GIF 输出文件名重复: ${target}`);
      targets.add(key);
      const { bytes, ...info } = await encodeGif(readFrames(group.files), { fps, repeat });
      const temporaryGif = path.join(directory, `${index}.gif`);
      await fs.writeFile(temporaryGif, bytes);
      staged.push({ temporaryGif, path: target, sizeBytes: bytes.length, ...info });
    }
    await fs.mkdir(path.dirname(stem), { recursive: true });
    for (const { temporaryGif, ...file } of staged) {
      const pending = `${file.path}.${randomUUID()}.tmp`;
      try {
        await fs.copyFile(temporaryGif, pending);
        await fs.rename(pending, file.path);
      } finally {
        await fs.rm(pending, { force: true });
      }
      outputs.push(file);
    }
    return {
      ...rendered, success: true, renderFormat: 'gif', renderSource: 'spine-png-sequence',
      outputPath, count: outputs.length, outputs, totalBytes: outputs.reduce((sum, file) => sum + file.sizeBytes, 0),
    };
  } catch (error) {
    return fail(error.message);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}
