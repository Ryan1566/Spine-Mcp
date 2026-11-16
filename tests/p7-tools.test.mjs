import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describeJsonChanges, writeJsonCopy } from '../src/write-safety.mjs';
import { buildExportWorkflowPlan, runExportWorkflow } from '../src/export-workflow.mjs';
import { listBackups } from '../src/backup.mjs';
import { TOOLS } from '../src/tools.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const heroPath = path.join(here, '..', 'fixtures', 'hero.json');
const serverPath = path.join(here, '..', 'src', 'index.mjs');
const hero = () => JSON.parse(fs.readFileSync(heroPath, 'utf8'));

function runServer(messages) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serverPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, SPINE_EXE: '' },
    });
    let out = '';
    let errOut = '';
    child.stdout.on('data', (chunk) => { out += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { errOut += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', () => {
      try {
        resolve(out.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line)));
      } catch (error) {
        reject(new Error(`${error.message}\nstdout=${out}\nstderr=${errOut}`));
      }
    });
    child.stdin.write(`${messages.map((message) => JSON.stringify(message)).join('\n')}\n`);
    child.stdin.end();
  });
}

test('describeJsonChanges：顶层 section 与动画名级差异', () => {
  const source = hero();
  const next = structuredClone(source);
  next.animations.attack = { bones: { head: { rotate: [{ time: 0, angle: 1 }] } } };
  next.animations.idle.bones.head.rotate[0].angle = -3;
  next.slots[0].color = 'FF0000FF';
  const changes = describeJsonChanges(source, next);
  assert.ok(changes.changedSections.includes('animations'));
  assert.ok(changes.changedSections.includes('slots'));
  assert.deepEqual(changes.animationChanges.added, ['attack']);
  assert.deepEqual(changes.animationChanges.changed, ['idle']);
  assert.deepEqual(changes.animationChanges.removed, []);
  assert.equal(changes.summary.animationsAdded, 1);
  assert.equal(changes.summary.animationsChanged, 1);
});

test('writeJsonCopy：dryRun 预览、原子写入与覆盖前备份', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-p7-'));
  const output = path.join(dir, 'copy.json');
  const source = hero();
  const next = structuredClone(source);
  next.animations.attack = { bones: { head: { rotate: [{ time: 0, angle: 1 }] } } };
  try {
    const blocked = await writeJsonCopy({ sourceSkeleton: source, outputJsonPath: output, json: next, overwrite: false, dryRun: true });
    assert.equal(blocked.dryRun, true);
    assert.equal(blocked.wouldWrite, true);
    assert.equal(fs.existsSync(output), false);

    fs.writeFileSync(output, '{"old":true}\n');
    const blockedExisting = await writeJsonCopy({ sourceSkeleton: source, outputJsonPath: output, json: next, overwrite: false, dryRun: true });
    assert.equal(blockedExisting.blocked, true);
    assert.equal(blockedExisting.wouldWrite, false);
    assert.equal(blockedExisting.wouldBackup, false);
    assert.equal(fs.readFileSync(output, 'utf8'), '{"old":true}\n');

    const overwriting = await writeJsonCopy({ sourceSkeleton: source, outputJsonPath: output, json: next, overwrite: true, dryRun: true });
    assert.equal(overwriting.wouldWrite, true);
    assert.equal(overwriting.wouldBackup, true);
    assert.equal(fs.readFileSync(output, 'utf8'), '{"old":true}\n');

    const written = await writeJsonCopy({ sourceSkeleton: source, outputJsonPath: output, json: next, overwrite: true, backup: true });
    assert.equal(written.writtenTo, output);
    assert.ok(written.backupPath);
    assert.equal(fs.readFileSync(written.backupPath, 'utf8'), '{"old":true}\n');
    assert.equal(JSON.parse(fs.readFileSync(output, 'utf8')).animations.attack.bones.head.rotate[0].angle, 1);
    assert.ok(written.changedSections.includes('animations'));
    assert.equal(source.animations.attack, undefined);
    await assert.rejects(() => writeJsonCopy({ sourceSkeleton: source, outputJsonPath: output, json: next, overwrite: false }), /已存在/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildExportWorkflowPlan：dryRun 计划、批量格式与未验证格式拒绝', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-p7-plan-'));
  const outputDir = path.join(dir, 'export');
  try {
    const plan = buildExportWorkflowPlan({ projectPath: heroPath, outputDir, dryRun: true });
    assert.equal(plan.dryRun, true);
    assert.equal(plan.jobCount, 1);
    assert.deepEqual(plan.formats, ['json']);
    assert.equal(fs.existsSync(outputDir), false);

    const batch = buildExportWorkflowPlan({
      projectPath: heroPath,
      outputDir,
      extraInputs: [{ inputPath: heroPath, format: 'binary' }],
      dryRun: true,
    });
    assert.equal(batch.jobCount, 2);
    assert.deepEqual(batch.formats, ['json', 'binary']);
    assert.equal(fs.existsSync(outputDir), false);
    assert.throws(() => buildExportWorkflowPlan({ projectPath: heroPath, outputDir, format: 'png' }), /只支持/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runExportWorkflow：CLI 失败时如实返回，并清理临时设置', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-p7-fail-'));
  const outputDir = path.join(dir, 'export');
  const previous = process.env.SPINE_EXE;
  process.env.SPINE_EXE = path.join(dir, 'missing-spine.exe');
  try {
    const result = await runExportWorkflow({ projectPath: heroPath, outputDir, format: 'json' });
    assert.equal(result.success, false);
    assert.equal(result.settingsFiles.length, 1);
    assert.equal(result.settingsFiles[0].source, 'generated');
    assert.equal(result.settingsFiles[0].retained, false);
    assert.equal(result.settingsFiles[0].path, null);
    assert.ok(result.temporarySettingsDeleted);
    assert.equal(result.generatedSettingsDir, null);
    assert.equal(fs.existsSync(result.settingsFiles[0].temporaryPath), false);
  } finally {
    if (previous === undefined) delete process.env.SPINE_EXE;
    else process.env.SPINE_EXE = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('stdio 集成：dryRun 不落盘，workflow 计划与备份清单可用', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-p7-stdio-'));
  const output = path.join(dir, 'edit.json');
  const exportDir = path.join(dir, 'export');
  try {
    const responses = await runServer([
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'spine_edit_animation', arguments: { sourceJsonPath: heroPath, outputJsonPath: output, animationName: 'idle', mode: 'duplicate', newName: 'idle_copy', dryRun: true } } },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'spine_export_workflow', arguments: { projectPath: heroPath, outputDir: exportDir, extraInputs: [{ inputPath: heroPath, format: 'binary' }], dryRun: true } } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'spine_list_backups', arguments: { limit: 5 } } },
    ]);
    assert.equal(responses.find((item) => item.id === 1).result.tools.length, TOOLS.length);
    assert.ok(TOOLS.some((tool) => tool.name === 'spine_export_workflow'));
    assert.ok(TOOLS.some((tool) => tool.name === 'spine_list_backups'));
    const edit = responses.find((item) => item.id === 2).result.structuredContent;
    assert.equal(edit.dryRun, true);
    assert.equal(edit.wouldWrite, true);
    assert.deepEqual(edit.animationChanges.added, ['idle_copy']);
    assert.equal(fs.existsSync(output), false);
    const workflow = responses.find((item) => item.id === 3).result.structuredContent;
    assert.equal(workflow.dryRun, true);
    assert.equal(workflow.jobCount, 2);
    assert.equal(fs.existsSync(exportDir), false);
    const backups = responses.find((item) => item.id === 4).result.structuredContent;
    assert.ok(Array.isArray(backups.files));
    assert.equal(backups.count, backups.files.length);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
