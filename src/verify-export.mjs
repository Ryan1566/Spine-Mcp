// 导出产物一致性校验：分别用官方 -i Info 读取源工程与导出目录里的产物，
// 比较每个 skeleton 的骨骼 / 插槽 / 动画列表。只读，不修改任何文件。
import fs from 'node:fs/promises';
import path from 'node:path';
import { assertSafePath } from './spine-cli.mjs';
import { projectInfo } from './project-info.mjs';

// 纯函数，便于离线单测。sourceParsed / item.parsed 都来自 parseProjectInfo。
export function compareExportSkeletons(sourceParsed, items) {
  const sourceByName = new Map((sourceParsed?.skeletons ?? []).map((s) => [s.name, s]));
  const matched = [];
  const mismatches = [];
  const seen = new Set();

  for (const item of items) {
    const skeletons = item.parsed?.skeletons ?? [];
    if (skeletons.length !== 1) {
      mismatches.push({ file: item.file, reason: '产物里没有解析出唯一的 skeleton' });
      continue;
    }
    const s = skeletons[0];
    const base = sourceByName.get(s.name);
    if (!base) {
      mismatches.push({ file: item.file, skeleton: s.name, reason: '源工程里没有同名 skeleton' });
      continue;
    }
    seen.add(s.name);
    const fields = [];
    for (const key of ['bones', 'slots', 'animations']) {
      const a = base[key] ?? [];
      const b = s[key] ?? [];
      if (a.length !== b.length || a.some((v, i) => v !== b[i])) fields.push(key);
    }
    const row = { file: item.file, skeleton: s.name, bones: s.bones.length, slots: s.slots.length, animations: s.animations.length };
    if (fields.length) mismatches.push({ ...row, fields });
    else matched.push(row);
  }

  const missing = [...sourceByName.keys()].filter((name) => !seen.has(name));
  return { ok: mismatches.length === 0 && missing.length === 0, matched, missing, mismatches };
}

export async function verifyExport({ projectPath, exportDir } = {}) {
  assertSafePath(projectPath, 'projectPath', { mustExist: true });
  let stat;
  try {
    stat = await fs.stat(exportDir);
  } catch {
    throw new Error(`exportDir 不存在或无法访问: ${exportDir}`);
  }
  if (!stat.isDirectory()) throw new Error(`exportDir 不是目录: ${exportDir}`);

  const source = await projectInfo(projectPath);
  if (!source.success || !source.parsed) {
    throw new Error(`无法读取源工程信息: ${projectPath}`);
  }

  const files = (await fs.readdir(exportDir)).filter((f) => f.toLowerCase().endsWith('.json'));
  const items = [];
  for (const file of files) {
    const result = await projectInfo(path.join(exportDir, file));
    items.push({ file, parsed: result.parsed, exitCode: result.exitCode });
  }

  return {
    projectPath,
    exportDir,
    sourceSkeletons: source.parsed.skeletons.map((s) => s.name),
    checkedFiles: files,
    ...compareExportSkeletons(source.parsed, items),
  };
}
