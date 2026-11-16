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

// 备份清单：只读列出 spine-mcp-backups 下的文件，按修改时间倒序。
export function listBackups({ limit = 100 } = {}) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('limit 必须是正整数');
  const dir = backupDir();
  if (!fs.existsSync(dir)) return { backupDir: dir, count: 0, files: [] };
  const files = fs.readdirSync(dir)
    .filter((name) => name.endsWith('.bak'))
    .map((name) => {
      const filePath = path.join(dir, name);
      const stat = fs.statSync(filePath);
      // <原文件名>.<ISO 时间戳>.bak
      const match = /^(.*)\.\d{4}-\d{2}-\d{2}T.*\.bak$/.exec(name);
      return {
        file: filePath,
        name,
        likelyTarget: match ? match[1] : null,
        sizeBytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
      };
    })
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
    .slice(0, limit);
  return { backupDir: dir, count: files.length, files };
}
