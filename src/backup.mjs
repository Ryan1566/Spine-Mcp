// 写前备份：spine_clean 实测会原地改写 .spine（10750 -> 7994 字节），
// spine_import_json 在 overwrite:true 时会覆盖目标，两者都需要留退路。
// 备份统一放系统临时目录，不污染工程目录 / git 工作区。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function backupDir() {
  return path.join(os.tmpdir(), 'spine-mcp-backups');
}

export function backupFile(sourcePath) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = backupDir();
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${path.basename(sourcePath)}.${stamp}.bak`);
  fs.copyFileSync(sourcePath, target);
  return target;
}

export function backupIfExists(filePath, enabled = true) {
  if (!enabled || typeof filePath !== 'string' || !filePath) return null;
  try {
    if (!fs.statSync(filePath).isFile()) return null;
  } catch {
    return null;
  }
  return backupFile(filePath);
}
