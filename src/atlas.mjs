// 图集打包 / 解包的官方 CLI 参数构造（3.8.75 已实测）。
// Pack:  Spine -i <images> [-j <project>]... -o <out> -p <name>
//        Spine -i <images> [-j <project>]... -o <out> [-n <name>] -p <pack.json>
// Unpack:Spine -i <atlas images> -o <out> -c <atlas file>
import fs from 'node:fs';
import { assertSafePath } from './spine-cli.mjs';

// assertSafePath 的 mustExist 只接受文件；目录需要单独校验。
export function assertDirectory(value, label) {
  assertSafePath(value, label);
  let stat;
  try {
    stat = fs.statSync(value);
  } catch {
    throw new Error(`${label} 不存在或无法访问: ${value}`);
  }
  if (!stat.isDirectory()) throw new Error(`${label} 不是目录: ${value}`);
  return value;
}

export function packArgs({
  inputDir,
  outputDir,
  atlasName,
  packSettingsPath,
  projectPaths = [],
} = {}) {
  assertDirectory(inputDir, 'inputDir');
  assertSafePath(outputDir, 'outputDir');
  if (!Array.isArray(projectPaths)) throw new Error('projectPaths 必须是数组');

  const args = ['-i', inputDir];
  for (const [index, project] of projectPaths.entries()) {
    assertSafePath(project, `projectPaths[${index}]`, { mustExist: true });
    args.push('-j', project);
  }
  args.push('-o', outputDir);

  if (packSettingsPath) {
    assertSafePath(packSettingsPath, 'packSettingsPath', { mustExist: true });
    if (atlasName) {
      assertSafePath(atlasName, 'atlasName');
      args.push('-n', atlasName);
    }
    args.push('-p', packSettingsPath);
  } else {
    if (!atlasName) throw new Error('未提供 packSettingsPath 时必须给 atlasName（图集名）');
    assertSafePath(atlasName, 'atlasName');
    args.push('-p', atlasName);
  }
  return args;
}

export function unpackArgs({ inputDir, outputDir, atlasPath } = {}) {
  assertDirectory(inputDir, 'inputDir');
  assertSafePath(outputDir, 'outputDir');
  assertSafePath(atlasPath, 'atlasPath', { mustExist: true });
  return ['-i', inputDir, '-o', outputDir, '-c', atlasPath];
}
