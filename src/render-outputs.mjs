// 渲染导出（png / mov / avi / gif）的产物定位。
// 3.8.75 的 -o 在渲染导出里是文件基名，产物会出现在「基名 + 扩展名」或「基名目录内」，
// 所以不能照着数据导出的习惯去列目录，必须按实际落盘结果回报。
import fs from 'node:fs/promises';
import path from 'node:path';
import { RENDER_EXTENSION_BY_FORMAT } from './export-settings.mjs';

const MAX_OUTPUTS = 5000;

async function statOrNull(target) {
  try {
    return await fs.stat(target);
  } catch {
    return null;
  }
}

export async function collectRenderOutputs({ outputPath, format, startedAt = 0, toleranceMs = 3000 } = {}) {
  const extension = RENDER_EXTENSION_BY_FORMAT[format];
  if (!extension) throw new Error(`不是渲染导出格式: ${format}`);
  if (typeof outputPath !== 'string' || outputPath.length === 0) throw new Error('outputPath 必须是非空字符串');

  // 只认本次导出期间新写出的文件，避免把上一次的旧产物算进来。
  const threshold = startedAt - toleranceMs;
  const found = new Map();
  const scannedDirs = [];

  const record = async (file) => {
    if (found.size >= MAX_OUTPUTS) return;
    const stat = await statOrNull(file);
    if (!stat?.isFile() || stat.size === 0) return;
    if (stat.mtimeMs < threshold) return;
    found.set(file, { path: file, sizeBytes: stat.size });
  };

  const walk = async (dir, depth) => {
    if (depth < 0) return;
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.size >= MAX_OUTPUTS) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, depth - 1);
      else if (entry.name.toLowerCase().endsWith(extension)) await record(full);
    }
  };

  // 1) -o 本身就是目录（png + animationType=all 走这里），帧直接在目录里。
  const outputStat = await statOrNull(outputPath);
  if (outputStat?.isDirectory()) {
    scannedDirs.push(outputPath);
    await walk(outputPath, 3);
  }

  // 2) 同级目录里以基名开头的产物（out.mov / out.gif / out_0.png），也覆盖用户自己带了后缀的情况。
  const parentDir = path.dirname(outputPath);
  if (parentDir && parentDir !== outputPath) {
    const baseName = path.basename(outputPath);
    const baseStem = baseName.toLowerCase().endsWith(extension) ? baseName.slice(0, -extension.length) : baseName;
    let entries = [];
    try {
      entries = await fs.readdir(parentDir, { withFileTypes: true });
    } catch {
      entries = [];
    }
    if (entries.length > 0) {
      scannedDirs.push(parentDir);
      for (const entry of entries) {
        if (found.size >= MAX_OUTPUTS) break;
        if (!entry.isFile()) continue;
        const lower = entry.name.toLowerCase();
        if (!lower.endsWith(extension)) continue;
        if (!lower.startsWith(baseStem.toLowerCase())) continue;
        await record(path.join(parentDir, entry.name));
      }
    }
  }

  const outputs = [...found.values()].sort((a, b) => a.path.localeCompare(b.path));
  const totalBytes = outputs.reduce((sum, item) => sum + item.sizeBytes, 0);
  const result = {
    format,
    extension,
    outputPath,
    scannedDirs: [...new Set(scannedDirs)],
    count: outputs.length,
    totalBytes,
    outputs,
  };
  if (outputs.length === 0) {
    result.note = `本次导出找不到 ${extension} 产物（已扫描 ${scannedDirs.join(' / ') || outputPath}）：请确认设置文件的 class 与导出格式一致，且 -o 传的是文件基名而不是目录。`;
  }
  return result;
}
