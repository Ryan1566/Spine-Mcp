import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { backupDir, backupFile, backupIfExists } from '../src/backup.mjs';
import { compareExportSkeletons, verifyExport } from '../src/verify-export.mjs';
import { TOOLS } from '../src/tools.mjs';
import { exportArgs } from '../src/spine-cli.mjs';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'spine-p1-'));
}

test('backupIfExists：写前备份内容与源文件一致，可关闭', () => {
  const dir = tempDir();
  const source = path.join(dir, 'project.spine');
  fs.writeFileSync(source, 'original-bytes');
  try {
    assert.equal(backupIfExists(source, false), null);
    assert.equal(backupIfExists(path.join(dir, 'missing.spine'), true), null);
    const backup = backupIfExists(source, true);
    assert.ok(backup.startsWith(backupDir()));
    assert.equal(fs.readFileSync(backup, 'utf8'), 'original-bytes');
    fs.writeFileSync(source, 'changed-bytes');
    assert.equal(fs.readFileSync(source, 'utf8'), 'changed-bytes');
    assert.equal(fs.readFileSync(backup, 'utf8'), 'original-bytes');
    assert.equal(typeof backupFile(source), 'string');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const SOURCE = {
  skeletons: [
    { name: 'skeleton', bones: ['root'], slots: [], animations: ['animation'] },
    { name: 'citizen_001', bones: ['root', 'head'], slots: ['face'], animations: ['idle', 'run'] },
  ],
};

test('compareExportSkeletons：一致 / 字段差异 / 缺失产物', () => {
  const ok = compareExportSkeletons(SOURCE, [
    { file: 'skeleton.json', parsed: { skeletons: [SOURCE.skeletons[0]] } },
    { file: 'citizen_001.json', parsed: { skeletons: [SOURCE.skeletons[1]] } },
  ]);
  assert.equal(ok.ok, true);
  assert.equal(ok.matched.length, 2);
  assert.deepEqual(ok.missing, []);

  const bad = compareExportSkeletons(SOURCE, [
    { file: 'citizen_001.json', parsed: { skeletons: [{ name: 'citizen_001', bones: ['root'], slots: ['face'], animations: ['idle', 'run'] }] } },
    { file: 'weird.json', parsed: null },
  ]);
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.missing, ['skeleton']);
  assert.equal(bad.mismatches[0].fields.includes('bones'), true);
  assert.match(bad.mismatches[1].reason, /没有解析出唯一/);
});

test('verifyExport：路径校验在调用 CLI 之前', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'not-a-dir.txt');
  fs.writeFileSync(file, 'x');
  try {
    await assert.rejects(() => verifyExport({ projectPath: path.join(dir, 'missing.spine'), exportDir: dir }), /projectPath 不存在/);
    await assert.rejects(() => verifyExport({ projectPath: file, exportDir: path.join(dir, 'missing-dir') }), /exportDir 不存在/);
    await assert.rejects(() => verifyExport({ projectPath: file, exportDir: file }), /exportDir 不是目录/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('工具表：写操作带 backup 参数，新工具与 binary 格式已开放', () => {
  const byName = (name) => TOOLS.find((t) => t.name === name);
  for (const name of ['spine_export', 'spine_import_json', 'spine_clean']) {
    assert.ok(byName(name).inputSchema.properties.backup, `${name} 缺少 backup 参数`);
  }
  assert.deepEqual(byName('spine_make_export_settings').inputSchema.properties.format.enum, ['json', 'binary', 'png', 'mov', 'avi', 'gif']);
  assert.deepEqual(byName('spine_verify_export').inputSchema.required, ['projectPath', 'exportDir']);
  assert.ok(byName('spine_export').inputSchema.properties.extraInputs, '缺少批量导出参数');
});

test('exportArgs：多组 -i/-e 批量导出参数构造', () => {
  const dir = tempDir();
  const a = path.join(dir, 'a.json');
  const b = path.join(dir, 'b.json');
  fs.writeFileSync(a, '{}');
  fs.writeFileSync(b, '{}');
  try {
    assert.deepEqual(
      exportArgs({ inputPath: a, outputDir: 'D:/out', exportSettingsPath: b }),
      ['-i', a, '-o', 'D:/out', '-e', b],
    );
    assert.deepEqual(
      exportArgs({
        inputPath: a,
        outputDir: 'D:/out',
        exportSettingsPath: b,
        extraInputs: [{ inputPath: a, exportSettingsPath: b }],
        clean: true,
      }),
      ['-i', a, '-o', 'D:/out', '-e', b, '-i', a, '-e', b, '-m'],
    );
    assert.throws(() => exportArgs({ inputPath: a, outputDir: 'D:/out', exportSettingsPath: b, extraInputs: 'x' }), /extraInputs 必须是数组/);
    assert.throws(() => exportArgs({ inputPath: a, outputDir: 'D:/out', exportSettingsPath: b, extraInputs: [{ inputPath: path.join(dir, 'missing.spine'), exportSettingsPath: b }] }), /extraInputs\[0\]\.inputPath 不存在/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
