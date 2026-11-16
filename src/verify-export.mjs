// 导出产物一致性校验：源工程用官方 -i Info 读取，产物分两路
//   .json → 同样走 -i Info（与源工程口径一致）
//   .skel → 本地二进制解析（skel-parse），不依赖 CLI
// 比对每个 skeleton 的骨骼 / 插槽 / 动画 / IK 名称集合。只读，不修改任何文件。
import fs from 'node:fs/promises';
import path from 'node:path';
import { assertSafePath } from './spine-cli.mjs';
import { projectInfo } from './project-info.mjs';
import { parseSkelFile } from './skel-parse.mjs';

// .skel 里没有 skeleton 名字（运行时用文件名代替），这里按文件名推导
export function binarySkeletonName(file) {
  return path.basename(file).replace(/\.skel$/i, '');
}

export function normalizeBinarySkeleton(parsed, file) {
  return {
    name: binarySkeletonName(file),
    bones: (parsed.bones ?? []).map((b) => b.name),
    slots: (parsed.slots ?? []).map((s) => s.name),
    animations: (parsed.animations ?? []).map((a) => a.name),
    ik: (parsed.constraints?.ik ?? []).map((c) => c.name),
  };
}

// 纯函数，便于离线单测。sourceParsed / item.parsed 都来自 parseProjectInfo 或 normalizeBinarySkeleton。
export function compareExportSkeletons(sourceParsed, items) {
  const skeletons = sourceParsed?.skeletons ?? [];
  const sourceByName = new Map(skeletons.map((s) => [s.name, s]));
  const matched = [];
  const mismatches = [];
  const seen = new Set();

  for (const item of items) {
    const list = item.parsed?.skeletons ?? [];
    if (list.length !== 1) {
      mismatches.push({ file: item.file, kind: item.kind ?? 'json', reason: '产物里没有解析出唯一的 skeleton' });
      continue;
    }
    const s = list[0];
    // 二进制产物按文件名推导名字；对不上时若源工程只有一个 skeleton 就认它
    let base = sourceByName.get(s.name);
    let matchedBy = 'name';
    if (!base && skeletons.length === 1) {
      base = skeletons[0];
      matchedBy = 'sole-skeleton';
    }
    if (!base) {
      mismatches.push({ file: item.file, kind: item.kind ?? 'json', skeleton: s.name, reason: '源工程里没有同名 skeleton' });
      continue;
    }
    seen.add(base.name);

    const fields = [];
    const details = [];
    for (const key of ['bones', 'slots', 'animations', 'ik']) {
      const a = base[key] ?? [];
      const b = s[key] ?? [];
      if (!a.length && !b.length) continue;
      const sa = [...a].sort();
      const sb = [...b].sort();
      if (sa.length !== sb.length || sa.some((v, i) => v !== sb[i])) {
        fields.push(key);
        details.push({ field: key, sourceCount: a.length, exportCount: b.length });
      }
    }

    const row = {
      file: item.file,
      kind: item.kind ?? 'json',
      skeleton: base.name,
      matchedBy,
      bones: s.bones.length,
      slots: s.slots.length,
      animations: s.animations.length,
    };
    if (item.structural) row.structural = item.structural;
    if (fields.length) mismatches.push({ ...row, fields, details });
    else matched.push(row);
  }

  const missing = [...sourceByName.keys()].filter((name) => !seen.has(name));
  const binaryProblems = items.filter((it) => it.structural && it.structural.ok === false).map((it) => ({ file: it.file, issues: it.structural.issueSample ?? [], errorCount: it.structural.errorCount, trailingBytes: it.structural.trailingBytes }));
  return { ok: mismatches.length === 0 && missing.length === 0 && binaryProblems.length === 0, matched, missing, mismatches, binaryProblems };
}

export async function verifyExport({ projectPath, exportDir, includeBinary = true } = {}) {
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

  const entries = await fs.readdir(exportDir);
  const jsonFiles = entries.filter((f) => /\.json$/i.test(f));
  const skelFiles = includeBinary ? entries.filter((f) => /\.skel$/i.test(f)) : [];

  const items = [];
  for (const file of jsonFiles) {
    const result = await projectInfo(path.join(exportDir, file));
    items.push({ file, kind: 'json', parsed: result.parsed, exitCode: result.exitCode });
  }
  for (const file of skelFiles) {
    const parsed = await parseSkelFile(path.join(exportDir, file));
    items.push({
      file,
      kind: 'binary',
      parsed: { skeletons: [normalizeBinarySkeleton(parsed, file)] },
      structural: {
        ok: parsed.ok && parsed.trailingBytes === 0,
        bytes: parsed.bytes,
        trailingBytes: parsed.trailingBytes,
        errorCount: parsed.errorCount,
        warningCount: parsed.warningCount,
        counts: parsed.counts,
        issueSample: parsed.issues.slice(0, 5),
      },
    });
  }

  return {
    projectPath,
    exportDir,
    sourceSkeletons: source.parsed.skeletons.map((s) => s.name),
    checkedFiles: [...jsonFiles, ...skelFiles],
    ...compareExportSkeletons(source.parsed, items),
  };
}
