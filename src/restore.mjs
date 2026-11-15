// 备份回滚：把 P1 写前备份的文件复制回目标工程。
// 这是写 .spine 的操作，按约定只提示人工重载，不自动重载。
import fs from 'node:fs';
import path from 'node:path';
import { assertSafePath } from './spine-cli.mjs';
import { backupIfExists } from './backup.mjs';
import { RELOAD_HINT } from './gui-link.mjs';

export function restoreBackup({ backupPath, targetPath, overwrite = false } = {}) {
  assertSafePath(backupPath, 'backupPath', { mustExist: true });
  assertSafePath(targetPath, 'targetPath');
  if (fs.existsSync(targetPath) && !overwrite) {
    throw new Error(`targetPath 已存在；恢复会覆盖它，请显式传 overwrite=true: ${targetPath}`);
  }
  // 恢复前先把当前目标也备份一次，避免「恢复错版本」后无法回退。
  const preRestoreBackup = backupIfExists(targetPath, true);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(backupPath, targetPath);
  return {
    restoredTo: targetPath,
    from: backupPath,
    preRestoreBackup,
    requiresManualReload: true,
    reloadHint: RELOAD_HINT,
  };
}
