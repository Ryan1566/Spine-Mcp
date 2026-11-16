import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { projectInfoArgs, parseProjectInfo } from '../src/project-info.mjs';
import { SUPPORTED_FORMATS, buildExportSettings, makeExportSettings } from '../src/export-settings.mjs';
import { RELOAD_HINT, GUI_RUNNING_HINT } from '../src/gui-link.mjs';
import { TOOLS, withReloadHint } from '../src/tools.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const existingFile = path.join(here, '..', 'fixtures', 'hero.json');
const serverPath = path.join(here, '..', 'src', 'index.mjs');

const INFO_STDOUT = [
  'Spine Launcher 3.8.75',
  'Spine 3.8.75 Professional',
  'WARNING: Welcome data download failed, server error: 410',
  'Project info: C:\\proj\\spinemcp_test.spine',
  '  Spine version: 3.8.75',
  '  Dopesheet FPS: 30',
  '  Skeleton: skeleton',
  '    Size: <unknown>',
  '    Bones (1): root',
  '    Animations (1): animation',
  '  Skeleton: citizen_001',
  '    Size: 128.84 x 96.56',
  '    Bones (17): root, bone_body_01, bone_head',
  '    Slots (17): hand_left, face',
  '    Animations (5): Attack_001, Attack_002, Idle_001, Run_001, Walk_001',
  'Complete.',
].join('\r\n');

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
        resolve(out.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)));
      } catch (err) {
        reject(new Error(`${err.message}\nstdout=${out}\nstderr=${errOut}`));
      }
    });
    child.stdin.write(`${messages.map((m) => JSON.stringify(m)).join('\n')}\n`);
    child.stdin.end();
  });
}

test('parseProjectInfo：解析多 skeleton 的 Info 输出', () => {
  const parsed = parseProjectInfo(INFO_STDOUT);
  assert.equal(parsed.spineVersion, '3.8.75');
  assert.equal(parsed.dopesheetFps, 30);
  assert.equal(parsed.skeletons.length, 2);
  assert.equal(parsed.skeletons[0].name, 'skeleton');
  assert.deepEqual(parsed.skeletons[0].bones, ['root']);
  assert.deepEqual(parsed.skeletons[0].animations, ['animation']);
  assert.equal(parsed.skeletons[1].size, '128.84 x 96.56');
  assert.equal(parsed.skeletons[1].bones.length, 3);
  assert.equal(parsed.skeletons[1].slots.length, 2);
  assert.equal(parsed.skeletons[1].animations.length, 5);
});

test('parseProjectInfo：非 Info 输出返回 null', () => {
  assert.equal(parseProjectInfo('Spine Launcher 3.8.75'), null);
  assert.equal(parseProjectInfo(null), null);
});

test('projectInfoArgs：只接受存在的文件', () => {
  assert.deepEqual(projectInfoArgs(existingFile), ['-i', existingFile]);
  assert.throws(() => projectInfoArgs(path.join(here, 'nope.spine')), /inputPath 不存在/);
});

test('buildExportSettings：数据格式与渲染格式分别生成合法设置', () => {
  assert.deepEqual(SUPPORTED_FORMATS, ['json', 'binary', 'png', 'mov', 'avi', 'gif']);
  const settings = buildExportSettings();
  assert.equal(settings.class, 'export-json');
  assert.equal(settings.cleanUp, false);
  assert.equal(settings.prettyPrint, true);
  assert.equal(settings.packAtlas.atlasExtension, '.atlas.txt');
  assert.equal(buildExportSettings({ outputDir: 'D:/out', prettyPrint: false }).output, 'D:/out');
  assert.equal(buildExportSettings({ format: 'binary' }).class, 'export-binary');
  assert.equal(buildExportSettings({ format: 'binary' }).extension, '.skel');
  assert.throws(() => buildExportSettings({ format: 'video' }), /不支持的导出格式/);
});

test('makeExportSettings：写文件、覆盖保护、参数生效', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-p0-'));
  const target = path.join(dir, 'nested', 'settings.json');
  try {
    const result = await makeExportSettings({ outputPath: target, outputDir: 'D:/export', prettyPrint: false });
    assert.equal(result.writtenTo, target);
    assert.equal(result.format, 'export-json');
    assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).prettyPrint, false);
    await assert.rejects(() => makeExportSettings({ outputPath: target }), /已存在/);
    await makeExportSettings({ outputPath: target, overwrite: true, cleanUp: true });
    assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).cleanUp, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('重载约定：提示文案固化在代码里，且只在成功时附加', () => {
  assert.match(RELOAD_HINT, /手动 Ctrl\+O/);
  assert.match(GUI_RUNNING_HINT, /单实例锁/);
  const failed = { success: false, exitCode: 1 };
  assert.deepEqual(withReloadHint(failed), failed);
  const ok = withReloadHint({ success: true, exitCode: 0 });
  assert.equal(ok.requiresManualReload, true);
  assert.match(ok.reloadHint, /Ctrl\+O/);
});

test('工具表：33 个工具，P0-P9 新工具已注册', () => {
  assert.equal(TOOLS.length, 33);
  for (const name of ['spine_project_info', 'spine_version', 'spine_make_export_settings', 'spine_verify_export', 'spine_pack_atlas', 'spine_unpack_atlas', 'spine_restore_backup', 'spine_diff_animations', 'spine_merge_animations', 'spine_manage_events', 'spine_build_batch_animations', 'spine_modify_bones', 'spine_edit_weights', 'spine_audit_project', 'spine_inspect_animation', 'spine_edit_animation', 'spine_edit_slots', 'spine_edit_skins', 'spine_inspect_constraints', 'spine_edit_constraints', 'spine_inspect_atlas', 'spine_audit_assets', 'spine_export_workflow', 'spine_list_backups']) {
    assert.ok(TOOLS.some((t) => t.name === name), `缺少 ${name}`);
  }
  assert.ok(TOOLS.every((t) => t.inputSchema && t.inputSchema.type === 'object'));
});

test('stdio 集成：新工具可见，生成设置文件不依赖 Spine', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-p0-stdio-'));
  const target = path.join(dir, 'settings.json');
  try {
    const responses = await runServer([
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'spine_make_export_settings', arguments: { outputPath: target } } },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'spine_project_info', arguments: { inputPath: path.join(here, 'nope.spine') } } },
    ]);
    assert.equal(responses.find((r) => r.id === 1).result.tools.length, TOOLS.length);
    const made = responses.find((r) => r.id === 2).result;
    assert.equal(made.isError, false);
    assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).class, 'export-json');
    const bad = responses.find((r) => r.id === 3).result;
    assert.equal(bad.isError, true);
    assert.match(bad.structuredContent.error, /inputPath 不存在/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
