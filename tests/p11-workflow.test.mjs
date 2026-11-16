import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildExportWorkflowPlan, mergeRunFiles, runExportWorkflow } from '../src/export-workflow.mjs';

const fixtureA = path.join(process.cwd(), 'fixtures', 'hero.json');
const fixtureB = path.join(process.cwd(), 'fixtures', 'hero.attack.demo.json');

test('buildExportWorkflowPlan：单工程多格式仍是扁平目录', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-p11-plan-'));
  const outputDir = path.join(dir, 'export');
  try {
    const plan = buildExportWorkflowPlan({
      projectPath: fixtureA,
      projects: [fixtureA],
      outputDir,
      formats: ['json', 'binary'],
      dryRun: true,
    });
    assert.equal(plan.jobCount, 2);
    assert.deepEqual(plan.formats, ['json', 'binary']);
    assert.equal(plan.layout, 'flat');
    assert.deepEqual(plan.projects, [fixtureA], '重复工程应去重');
    assert.ok(plan.jobs.every((job) => job.outputDir === outputDir));
    assert.equal(fs.existsSync(outputDir), false, 'dryRun 不建目录');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildExportWorkflowPlan：多工程矩阵按工程分子目录', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-p11-matrix-'));
  const outputDir = path.join(dir, 'export');
  try {
    const plan = buildExportWorkflowPlan({
      projects: [fixtureA, fixtureB],
      outputDir,
      formats: ['json', 'binary'],
      dryRun: true,
    });
    assert.equal(plan.jobCount, 4);
    assert.equal(plan.layout, 'perProject');
    assert.equal(plan.projectDirs.length, 2);
    assert.deepEqual(plan.projectDirs.map((item) => path.basename(item.dir)), ['0-hero', '1-hero.attack.demo']);
    // 同一工程的 json / binary 落在同一子目录，不同工程互不干扰
    assert.equal(plan.jobs[0].outputDir, plan.jobs[1].outputDir);
    assert.notEqual(plan.jobs[0].outputDir, plan.jobs[2].outputDir);
    assert.deepEqual(plan.jobs.map((job) => job.format), ['json', 'binary', 'json', 'binary']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildExportWorkflowPlan：参数校验与单 job 设置限制', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-p11-bad-'));
  const outputDir = path.join(dir, 'export');
  const settings = path.join(dir, 'settings.json');
  fs.writeFileSync(settings, '{}');
  try {
    assert.throws(() => buildExportWorkflowPlan({ outputDir }), /必须提供 projectPath 或 projects/);
    assert.throws(() => buildExportWorkflowPlan({ projectPath: fixtureA, outputDir, formats: ['png'] }), /只支持 json\/binary/);
    assert.throws(() => buildExportWorkflowPlan({ projectPath: fixtureA, outputDir, formats: 'json' }), /formats 必须是数组/);
    assert.throws(() => buildExportWorkflowPlan({ projectPath: path.join(dir, 'missing.spine'), outputDir }), /不存在/);
    assert.throws(
      () => buildExportWorkflowPlan({ projectPath: fixtureA, outputDir, formats: ['json', 'binary'], exportSettingsPath: settings }),
      /只能用于单工程单格式/,
    );
    const single = buildExportWorkflowPlan({ projectPath: fixtureA, outputDir, exportSettingsPath: settings, dryRun: true });
    assert.equal(single.jobCount, 1);
    assert.equal(single.jobs[0].settingsSource, 'provided');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runExportWorkflow：矩阵失败时逐 job 记录，报告汇总为空产物', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-p11-fail-'));
  const outputDir = path.join(dir, 'export');
  const previous = process.env.SPINE_EXE;
  process.env.SPINE_EXE = path.join(dir, 'missing-spine.exe');
  try {
    const result = await runExportWorkflow({
      projects: [fixtureA, fixtureB],
      outputDir,
      formats: ['json', 'binary'],
    });
    assert.equal(result.success, false);
    assert.equal(result.runs.length, 4);
    assert.ok(result.runs.every((run) => run.success === false && run.fileCount === 0));
    assert.equal(result.report.jobCount, 4);
    assert.equal(result.report.succeeded, 0);
    assert.equal(result.report.failed, 4);
    assert.equal(result.report.fileCount, 0);
    assert.equal(result.report.totalBytes, 0);
    assert.deepEqual(Object.keys(result.report.byFormat).sort(), ['binary', 'json']);
    // 4 个 job 的临时设置都在临时目录内，返回前已清理
    assert.equal(result.settingsFiles.length, 4);
    assert.ok(result.settingsFiles.every((item) => item.source === 'generated' && item.retained === false && item.path === null));
    assert.ok(result.temporarySettingsDeleted);
    assert.equal(result.generatedSettingsDir, null);
    assert.ok(result.settingsFiles.every((item) => fs.existsSync(item.temporaryPath) === false));
  } finally {
    if (previous === undefined) delete process.env.SPINE_EXE;
    else process.env.SPINE_EXE = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runExportWorkflow：dryRun 矩阵不落盘', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-p11-dry-'));
  const outputDir = path.join(dir, 'export');
  try {
    const result = await runExportWorkflow({ projects: [fixtureA, fixtureB], outputDir, formats: ['json'], dryRun: true });
    assert.equal(result.dryRun, true);
    assert.equal(result.jobCount, 2);
    assert.equal(result.layout, 'perProject');
    assert.equal(fs.existsSync(outputDir), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('mergeRunFiles：同目录多 job 的产物按路径去重，主产物标记取并集', () => {
  const merged = mergeRunFiles([
    {
      job: 'a-json',
      files: [
        { path: 'D:/out/x.json', name: 'x.json', sizeBytes: 10, primary: true },
        { path: 'D:/out/x.atlas.txt', name: 'x.atlas.txt', sizeBytes: 3, primary: false },
      ],
    },
    {
      job: 'b-binary',
      files: [
        { path: 'D:/out/x.json', name: 'x.json', sizeBytes: 10, primary: false },
        { path: 'D:/out/x.skel', name: 'x.skel', sizeBytes: 20, primary: true },
        { path: 'D:/out/x.atlas.txt', name: 'x.atlas.txt', sizeBytes: 3, primary: false },
      ],
    },
  ]);
  assert.equal(merged.length, 3);
  const byName = Object.fromEntries(merged.map((file) => [file.name, file]));
  assert.equal(byName['x.json'].primary, true, 'json job 认定为主产物后不能被后续 job 覆盖');
  assert.equal(byName['x.skel'].primary, true);
  assert.equal(byName['x.atlas.txt'].primary, false);
  assert.equal(merged.reduce((sum, file) => sum + file.sizeBytes, 0), 33);
});
