import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildExportWorkflowPlan, runExportWorkflow } from '../src/export-workflow.mjs';

const fixtureA = path.join(process.cwd(), 'fixtures', 'hero.json');
const fixtureB = path.join(process.cwd(), 'fixtures', 'hero.attack.demo.json');

function fakeImageDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-p12-img-'));
  fs.writeFileSync(path.join(dir, 'page.png'), Buffer.alloc(8, 1));
  return dir;
}

test('buildExportWorkflowPlan：pack 用图集名时参数是 -i/-o/-p', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-p12-plan-'));
  const imageDir = fakeImageDir();
  const outputDir = path.join(dir, 'export');
  try {
    const plan = buildExportWorkflowPlan({
      projectPath: fixtureA,
      outputDir,
      pack: { imageDir, name: 'hero-atlas' },
      dryRun: true,
    });
    assert.equal(plan.pack.imageDir, imageDir);
    assert.equal(plan.pack.outputDir, outputDir);
    assert.deepEqual(plan.pack.args, ['-i', imageDir, '-o', outputDir, '-p', 'hero-atlas']);
    assert.equal(fs.existsSync(outputDir), false, 'dryRun 不建目录');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(imageDir, { recursive: true, force: true });
  }
});

test('buildExportWorkflowPlan：pack 用设置文件时追加 -n 与 -j', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-p12-settings-'));
  const imageDir = fakeImageDir();
  const outputDir = path.join(dir, 'export');
  const settings = path.join(dir, 'atlas-1.0.json');
  fs.writeFileSync(settings, '{}');
  try {
    const plan = buildExportWorkflowPlan({
      projectPath: fixtureA,
      outputDir,
      pack: { imageDir, settingsPath: settings, name: 'hero-atlas', projectPaths: [fixtureA] },
      dryRun: true,
    });
    assert.deepEqual(plan.pack.args, ['-i', imageDir, '-j', fixtureA, '-o', outputDir, '-n', 'hero-atlas', '-p', settings]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(imageDir, { recursive: true, force: true });
  }
});

test('buildExportWorkflowPlan：pack 的必填与多工程限制', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-p12-bad-'));
  const imageDir = fakeImageDir();
  const outputDir = path.join(dir, 'export');
  try {
    assert.throws(() => buildExportWorkflowPlan({ projectPath: fixtureA, outputDir, pack: { name: 'x' } }), /pack.imageDir 必须是非空字符串/);
    assert.throws(() => buildExportWorkflowPlan({ projectPath: fixtureA, outputDir, pack: { imageDir } }), /必须给 atlasName/);
    assert.throws(() => buildExportWorkflowPlan({ projectPath: fixtureA, outputDir, pack: { imageDir: path.join(dir, 'nope'), name: 'x' } }), /不存在或无法访问/);
    assert.throws(() => buildExportWorkflowPlan({ projectPath: fixtureA, outputDir, pack: 'yes' }), /pack 必须是对象/);
    // 多工程时图集放哪必须显式指定，否则会把两个工程的图混到一个目录里
    assert.throws(
      () => buildExportWorkflowPlan({ projects: [fixtureA, fixtureB], outputDir, pack: { imageDir, name: 'x' } }),
      /必须显式指定 pack.outputDir/,
    );
    const explicit = buildExportWorkflowPlan({
      projects: [fixtureA, fixtureB],
      outputDir,
      pack: { imageDir, name: 'x', outputDir: path.join(dir, 'atlas') },
      dryRun: true,
    });
    assert.equal(explicit.pack.outputDir, path.join(dir, 'atlas'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(imageDir, { recursive: true, force: true });
  }
});

test('runExportWorkflow：数据导出失败时不打包，报告里 pack 为 null', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-p12-fail-'));
  const imageDir = fakeImageDir();
  const outputDir = path.join(dir, 'export');
  const previous = process.env.SPINE_EXE;
  process.env.SPINE_EXE = path.join(dir, 'missing-spine.exe');
  try {
    const result = await runExportWorkflow({
      projectPath: fixtureA,
      outputDir,
      pack: { imageDir, name: 'hero-atlas' },
    });
    assert.equal(result.success, false);
    assert.equal(result.packResult, null, '数据导出失败就不该再打图集');
    assert.equal(result.report.pack, null);
    assert.equal(result.report.succeeded, 0);
  } finally {
    if (previous === undefined) delete process.env.SPINE_EXE;
    else process.env.SPINE_EXE = previous;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(imageDir, { recursive: true, force: true });
  }
});

test('failureHint：从 CLI 输出里提取有用的一行', async () => {
  const { failureHint } = await import('../src/export-workflow.mjs');
  assert.equal(failureHint('', ''), null);
  assert.match(
    failureHint('Spine Launcher 3.8.75\nComplete.\n', 'Caused by: java.lang.RuntimeException: Image does not fit within max page size 1024x1024\n'),
    /does not fit within max page size/,
  );
  // 没有明显错误关键字时退回最后一行
  assert.equal(failureHint('line one\nline two\n', ''), 'line two');
});
