// P7：JSON 副本写操作的安全层：dryRun 预览、顶层变更摘要、原子写入与覆盖前备份。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { assertSafePath } from './spine-cli.mjs';
import { backupIfExists } from './backup.mjs';

const isPlainObject = (value) => value && typeof value === 'object' && !Array.isArray(value);

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (isPlainObject(value)) {
    return Object.keys(value).sort().reduce((acc, key) => {
      acc[key] = stable(value[key]);
      return acc;
    }, {});
  }
  return value;
}
const stableStringify = (value) => JSON.stringify(stable(value));

// 只做「够用」的变更摘要：顶层 section 是否变化 + 动画名级增删改。
export function describeJsonChanges(source, next) {
  const sections = new Set([...Object.keys(source ?? {}), ...Object.keys(next ?? {})]);
  const changedSections = [];
  for (const section of sections) {
    if (stableStringify(source?.[section]) !== stableStringify(next?.[section])) changedSections.push(section);
  }
  const animationChanges = { added: [], removed: [], changed: [] };
  const before = source?.animations ?? {};
  const after = next?.animations ?? {};
  for (const name of Object.keys(after)) {
    if (!(name in before)) animationChanges.added.push(name);
    else if (stableStringify(before[name]) !== stableStringify(after[name])) animationChanges.changed.push(name);
  }
  for (const name of Object.keys(before)) {
    if (!(name in after)) animationChanges.removed.push(name);
  }
  const animationTouched = animationChanges.added.length || animationChanges.removed.length || animationChanges.changed.length;
  return {
    changedSections,
    animationChanges,
    summary: {
      sectionsChanged: changedSections.length,
      animationsAdded: animationChanges.added.length,
      animationsRemoved: animationChanges.removed.length,
      animationsChanged: animationChanges.changed.length,
      animationTouched: animationTouched > 0,
    },
  };
}

// 原子写：先写同目录临时文件，再 rename 到目标，避免半截 JSON。
async function atomicWriteJson(outputPath, json) {
  const temporary = `${outputPath}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  await fsp.writeFile(temporary, `${JSON.stringify(json, null, 2)}\n`, 'utf8');
  try {
    await fsp.rename(temporary, outputPath);
  } catch (error) {
    await fsp.rm(temporary, { force: true });
    throw error;
  }
}

export async function writeJsonCopy({
  sourceSkeleton,
  sourcePaths = [],
  outputJsonPath,
  json,
  overwrite = false,
  dryRun = false,
  backup = true,
  label = 'outputJsonPath',
} = {}) {
  assertSafePath(outputJsonPath, label);
  if (!isPlainObject(json)) throw new Error('json 必须是 skeleton 对象');
  const outputExists = fs.existsSync(outputJsonPath);
  if (outputExists && sourcePaths.length) {
    const canonical = (file) => process.platform === 'win32' ? file.toLowerCase() : file;
    const output = canonical(await fsp.realpath(outputJsonPath));
    const inputs = await Promise.all(sourcePaths.map((file) => fsp.realpath(file)));
    if (inputs.some((file) => canonical(file) === output)) {
      throw new Error(`${label} 指向输入 JSON；请指定独立的输出路径`);
    }
  }
  const changes = describeJsonChanges(sourceSkeleton, json);
  const wouldWrite = !outputExists || overwrite === true;

  if (dryRun) {
    return {
      dryRun: true,
      wouldWrite,
      blocked: !wouldWrite,
      outputJsonPath,
      outputExists,
      overwrite: overwrite === true,
      wouldOverwrite: outputExists,
      wouldBackup: outputExists && overwrite === true && backup !== false,
      ...changes,
      note: wouldWrite ? 'dryRun：未写任何文件。' : 'dryRun：输出已存在且未允许 overwrite，实际执行会被拒绝。',
    };
  }

  if (outputExists && overwrite !== true) {
    throw new Error(`${label} 已存在；需要覆盖请显式传 overwrite=true: ${outputJsonPath}`);
  }
  const backupPath = backupIfExists(outputJsonPath, outputExists && overwrite === true && backup !== false);
  const directory = path.dirname(outputJsonPath);
  await fsp.mkdir(directory, { recursive: true });
  await atomicWriteJson(outputJsonPath, json);
  const result = {
    writtenTo: outputJsonPath,
    sourceUnchanged: true,
    outputExisted: outputExists,
    ...changes,
  };
  if (backupPath) {
    result.backupPath = backupPath;
    result.backupHint = '覆盖前已把旧输出备份到系统临时目录。';
  }
  return result;
}
