import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { packArgs, unpackArgs } from '../src/atlas.mjs';
import { restoreBackup } from '../src/restore.mjs';
import { TOOLS } from '../src/tools.mjs';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'spine-p2-'));
}

test('packArgs：图集名形式、设置文件形式与 -j', () => {
  const dir = tempDir();
  const images = path.join(dir, 'images');
  fs.mkdirSync(images);
  const packJson = path.join(dir, 'pack.json');
  const project = path.join(dir, 'p.spine');
  fs.writeFileSync(packJson, '{}');
  fs.writeFileSync(project, 'x');
  try {
    assert.deepEqual(
      packArgs({ inputDir: images, outputDir: 'D:/out', atlasName: 'atlas1' }),
      ['-i', images, '-o', 'D:/out', '-p', 'atlas1'],
    );
    assert.deepEqual(
      packArgs({ inputDir: images, outputDir: 'D:/out', atlasName: 'atlas2', packSettingsPath: packJson, projectPaths: [project] }),
      ['-i', images, '-j', project, '-o', 'D:/out', '-n', 'atlas2', '-p', packJson],
    );
    assert.throws(() => packArgs({ inputDir: images, outputDir: 'D:/out' }), /必须给 atlasName/);
    assert.throws(() => packArgs({ inputDir: packJson, outputDir: 'D:/out', atlasName: 'x' }), /不是目录/);
    assert.throws(() => packArgs({ inputDir: images, outputDir: 'D:/out', atlasName: 'x', projectPaths: 'bad' }), /projectPaths 必须是数组/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('unpackArgs：参数构造与 atlas 文件校验', () => {
  const dir = tempDir();
  const images = path.join(dir, 'images');
  fs.mkdirSync(images);
  const atlas = path.join(dir, 'a.atlas');
  fs.writeFileSync(atlas, 'x');
  try {
    assert.deepEqual(
      unpackArgs({ inputDir: images, outputDir: 'D:/out', atlasPath: atlas }),
      ['-i', images, '-o', 'D:/out', '-c', atlas],
    );
    assert.throws(() => unpackArgs({ inputDir: images, outputDir: 'D:/out', atlasPath: path.join(dir, 'missing.atlas') }), /atlasPath 不存在/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('restoreBackup：覆盖保护、恢复内容、恢复前再备份与重载提示', () => {
  const dir = tempDir();
  const backup = path.join(dir, 'backup.bak');
  fs.writeFileSync(backup, 'OLD');
  const target = path.join(dir, 'nested', 'project.spine');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, 'NEW');
  try {
    assert.throws(() => restoreBackup({ backupPath: backup, targetPath: target }), /overwrite=true/);
    const result = restoreBackup({ backupPath: backup, targetPath: target, overwrite: true });
    assert.equal(fs.readFileSync(target, 'utf8'), 'OLD');
    assert.equal(result.requiresManualReload, true);
    assert.match(result.reloadHint, /Ctrl\+O/);
    assert.equal(fs.readFileSync(result.preRestoreBackup, 'utf8'), 'NEW');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('工具表：P2/P3 工具已注册', () => {
  assert.equal(TOOLS.length, 20);
  for (const name of ['spine_pack_atlas', 'spine_unpack_atlas', 'spine_restore_backup']) {
    assert.ok(TOOLS.some((t) => t.name === name), `缺少 ${name}`);
  }
});
