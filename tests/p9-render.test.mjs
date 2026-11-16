import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  RENDER_EXTENSION_BY_FORMAT,
  buildExportSettings,
  formatForRenderClass,
  isRenderClass,
  isRenderFormat,
  makeExportSettings,
  outputPathKind,
  parseColor,
  readExportClass,
} from '../src/export-settings.mjs';
import { collectRenderOutputs } from '../src/render-outputs.mjs';
import { TOOLS } from '../src/tools.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const heroPath = path.join(here, '..', 'fixtures', 'hero.json');
const serverPath = path.join(here, '..', 'src', 'index.mjs');

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

test('buildExportSettings：渲染格式的 class / exportType / 扩展名映射', () => {
  const cases = [
    ['png', 'export-png', 'image', '.png'],
    ['mov', 'export-mov', 'video', '.mov'],
    ['avi', 'export-avi', 'video', '.avi'],
    ['gif', 'export-gif', 'video', '.gif'],
  ];
  for (const [format, className, exportType, extension] of cases) {
    const settings = buildExportSettings({ format });
    assert.equal(settings.class, className);
    assert.equal(settings.exportType, exportType);
    assert.equal(RENDER_EXTENSION_BY_FORMAT[format], extension);
    assert.equal(isRenderFormat(format), true);
    assert.equal(isRenderClass(className), true);
    assert.equal(formatForRenderClass(className), format);
  }
  assert.equal(isRenderFormat('json'), false);
  assert.equal(isRenderClass('export-json'), false);
  assert.equal(formatForRenderClass('export-json'), null);
});

test('buildExportSettings：不写 output / extension，也不写未验证的 scale', () => {
  const png = buildExportSettings({ format: 'png', outputDir: 'D:/out' });
  assert.equal(png.output, undefined);
  assert.equal(png.extension, undefined);
  assert.equal(png.scale, undefined);
  // 实测 scale 按「世界单位 → 像素」解释，0.5 会把 1281px 变成 13px，故不开放。
  assert.equal(buildExportSettings({ format: 'png', scale: 0.5 }).scale, undefined);
});

test('buildExportSettings：动画范围 / 逐帧 / msaa 参数校验', () => {
  assert.equal(buildExportSettings({ format: 'png', animationType: 'all' }).animationType, 'all');
  assert.equal(buildExportSettings({ format: 'gif', animationType: 'single' }).animationType, 'single');
  assert.throws(() => buildExportSettings({ format: 'png', animationType: 'bogus' }), /animationType 只支持/);
  assert.equal(buildExportSettings({ format: 'png', lastFrame: true }).lastFrame, true);
  assert.throws(() => buildExportSettings({ format: 'png', lastFrame: 'yes' }), /lastFrame 必须是布尔值/);
  assert.equal(buildExportSettings({ format: 'png', msaa: 4 }).msaa, 4);
  assert.throws(() => buildExportSettings({ format: 'png', msaa: 2.5 }), /msaa 必须是非负整数/);
});

test('parseColor：十六进制转 CLI 要求的 {r,g,b,a}', () => {
  assert.deepEqual(parseColor('#000000'), { r: 0, g: 0, b: 0, a: 1 });
  assert.deepEqual(parseColor('ffffff'), { r: 1, g: 1, b: 1, a: 1 });
  assert.deepEqual(parseColor('#11223344'), { r: 0.066667, g: 0.133333, b: 0.2, a: 0.266667 });
  assert.equal(buildExportSettings({ format: 'mov', backgroundColor: '#FF0000' }).background.r, 1);
  // 实测十六进制字符串直接塞给 background 会被 CLI 拒绝，必须转对象。
  assert.throws(() => parseColor('red'), /#RRGGBB/);
  assert.throws(() => parseColor(0), /必须是十六进制颜色字符串/);
});

test('outputPathKind：png 多动画当目录，其余当文件基名', () => {
  assert.equal(outputPathKind('json'), 'directory');
  assert.equal(outputPathKind('binary'), 'directory');
  assert.equal(outputPathKind('png', 'all'), 'directory');
  assert.equal(outputPathKind('png', 'single'), 'fileBase');
  assert.equal(outputPathKind('png'), 'fileBase');
  assert.equal(outputPathKind('mov', 'all'), 'fileBase');
  assert.equal(outputPathKind('gif'), 'fileBase');
});

test('makeExportSettings：渲染设置落盘、覆盖保护与 readExportClass', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-p9-'));
  const target = path.join(dir, 'gif.json');
  try {
    const result = await makeExportSettings({ outputPath: target, format: 'gif', animationType: 'all' });
    assert.equal(result.render, true);
    assert.equal(result.format, 'gif');
    assert.equal(result.outputPathKind, 'fileBase');
    assert.match(result.note, /文件基名/);
    assert.equal(await readExportClass(target), 'export-gif');
    const settings = JSON.parse(fs.readFileSync(target, 'utf8'));
    assert.equal(settings.class, 'export-gif');
    assert.equal(settings.exportType, 'video');

    const png = path.join(dir, 'png.json');
    const pngResult = await makeExportSettings({ outputPath: png, format: 'png', animationType: 'all' });
    assert.equal(pngResult.outputPathKind, 'directory');
    await assert.rejects(() => makeExportSettings({ outputPath: target, format: 'gif' }), /已存在/);
    await makeExportSettings({ outputPath: target, format: 'gif', overwrite: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('collectRenderOutputs：只认本次新写出的产物，覆盖文件基名与目录两种落点', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-p9-out-'));
  try {
    // 视频：产物在基名同级，名字是 <基名>.mov
    const base = path.join(dir, 'raptor');
    fs.writeFileSync(`${base}.mov`, Buffer.alloc(32, 1));
    // 同目录里的旧产物必须被 mtime 过滤掉
    const stale = path.join(dir, 'old.mov');
    fs.writeFileSync(stale, Buffer.alloc(16, 2));
    const past = new Date(Date.now() - 3600_000);
    fs.utimesSync(stale, past, past);
    fs.writeFileSync(path.join(dir, 'unrelated.gif'), Buffer.alloc(8, 3));

    const video = await collectRenderOutputs({ outputPath: base, format: 'mov', startedAt: Date.now() });
    assert.equal(video.count, 1);
    assert.equal(video.outputs[0].path, `${base}.mov`);
    assert.equal(video.outputs[0].sizeBytes, 32);
    assert.equal(video.totalBytes, 32);

    // png + animationType=all：产物写在基名目录里
    const frameDir = path.join(dir, 'frames');
    fs.mkdirSync(frameDir);
    fs.writeFileSync(path.join(frameDir, 'raptor-walk_0.png'), Buffer.alloc(24, 4));
    fs.writeFileSync(path.join(frameDir, 'raptor-walk_1.png'), Buffer.alloc(24, 4));
    const frames = await collectRenderOutputs({ outputPath: frameDir, format: 'png', startedAt: Date.now() });
    assert.equal(frames.count, 2);
    assert.equal(frames.totalBytes, 48);

    // 找不到时要有明确说明，而不是静默返回空数组
    const empty = await collectRenderOutputs({ outputPath: path.join(dir, 'nothing'), format: 'avi', startedAt: Date.now() });
    assert.equal(empty.count, 0);
    assert.match(empty.note, /找不到/);
    await assert.rejects(() => collectRenderOutputs({ outputPath: base, format: 'json' }), /不是渲染导出格式/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('stdio 集成：渲染设置可生成，工作流仍只做数据导出', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-p9-stdio-'));
  const settingsPath = path.join(dir, 'mov.json');
  try {
    const responses = await runServer([
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'spine_make_export_settings', arguments: { outputPath: settingsPath, format: 'mov', animationType: 'all', backgroundColor: '#000000FF' } } },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'spine_export_workflow', arguments: { projectPath: heroPath, outputDir: path.join(dir, 'export'), format: 'png', dryRun: true } } },
    ]);
    assert.equal(responses.find((item) => item.id === 1).result.tools.length, TOOLS.length);
    const toolNames = TOOLS.map((tool) => tool.name);
    assert.ok(toolNames.includes('spine_export'));

    const made = responses.find((item) => item.id === 2).result.structuredContent;
    assert.equal(made.render, true);
    assert.equal(made.outputPathKind, 'fileBase');
    assert.equal(made.settings.class, 'export-mov');
    assert.deepEqual(made.settings.background, { r: 0, g: 0, b: 0, a: 1 });

    const workflow = responses.find((item) => item.id === 3);
    assert.match(JSON.stringify(workflow), /只支持 json\/binary/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
