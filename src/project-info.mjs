// 官方 CLI 的 Info 模式：Spine -i <path>（只读，不改动工程文件）。
// 之前一直是直接调底层 runSpine，没有对应的 MCP 工具，这里补上并做轻量结构化解析。
import { assertSafePath, runSpine } from './spine-cli.mjs';

export function projectInfoArgs(inputPath) {
  assertSafePath(inputPath, 'inputPath', { mustExist: true });
  return ['-i', inputPath];
}

const splitNames = (value) => value.split(',').map((s) => s.trim()).filter(Boolean);

// 把 CLI 的 Project info 输出解析成结构化摘要；解析不出来返回 null，不影响原始 stdout 回传。
export function parseProjectInfo(stdout) {
  if (typeof stdout !== 'string' || !/Project info:/.test(stdout)) return null;
  const parsed = { spineVersion: null, dopesheetFps: null, skeletons: [] };
  let current = null;
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    let m;
    if ((m = /^Spine version:\s*(.+)$/.exec(line))) { parsed.spineVersion = m[1]; continue; }
    if ((m = /^Dopesheet FPS:\s*(\d+)$/.exec(line))) { parsed.dopesheetFps = Number(m[1]); continue; }
    if ((m = /^Skeleton:\s*(.+)$/.exec(line))) {
      current = { name: m[1], size: null, bones: [], slots: [], ik: [], animations: [] };
      parsed.skeletons.push(current);
      continue;
    }
    if (!current) continue;
    if ((m = /^Size:\s*(.+)$/.exec(line))) { current.size = m[1]; continue; }
    if ((m = /^Bones \(\d+\):\s*(.+)$/.exec(line))) { current.bones = splitNames(m[1]); continue; }
    if ((m = /^Slots \(\d+\):\s*(.+)$/.exec(line))) { current.slots = splitNames(m[1]); continue; }
    if ((m = /^IK constraints \(\d+\):\s*(.+)$/.exec(line))) { current.ik = splitNames(m[1]); continue; }
    if ((m = /^Animations \(\d+\):\s*(.+)$/.exec(line))) { current.animations = splitNames(m[1]); continue; }
  }
  return parsed;
}

export async function projectInfo(inputPath) {
  const result = await runSpine(projectInfoArgs(inputPath), { timeoutMs: 60000 });
  return { ...result, parsed: result.success ? parseProjectInfo(result.stdout) : null };
}
