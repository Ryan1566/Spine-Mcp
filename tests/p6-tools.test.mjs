import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { modifySlots, modifySkins, inspectConstraints } from '../src/structure-ops.mjs';
import { inspectAtlas, auditAssets } from '../src/asset-audit.mjs';
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

function withAnimationReferences() {
  const skeleton = hero();
  skeleton.animations.idle.slots = { eye: { attachment: [{ time: 0, name: 'eye_closed' }] } };
  skeleton.animations.idle.drawOrder = [{ time: 0, offsets: [{ slot: 'eye', offset: 1 }] }];
  return skeleton;
}

test('modifySlots：list / add / set / rename 同步皮肤与动画', () => {
  const source = withAnimationReferences();
  assert.equal(modifySlots(source, {}).slots.length, 2);

  const added = modifySlots(source, {
    mode: 'add',
    slots: [{ name: 'aura', bone: 'head', color: 'FFFFFFFF', attachment: null }],
  });
  assert.deepEqual(added.summary.added, [{ name: 'aura', bone: 'head' }]);
  assert.throws(() => modifySlots(source, { mode: 'add', slots: [{ name: 'bad', bone: 'ghost' }] }), /骨骼不存在/);

  const set = modifySlots(added.json, { mode: 'set', slots: [{ name: 'weapon_slot', color: 'FF0000FF' }] });
  assert.equal(set.json.slots.find((slot) => slot.name === 'weapon_slot').color, 'FF0000FF');

  const renamed = modifySlots(withAnimationReferences(), { mode: 'rename', rename: { from: 'eye', to: 'left_eye' } });
  assert.ok(renamed.json.skins.default.left_eye);
  assert.ok(renamed.json.animations.idle.slots.left_eye);
  assert.equal(renamed.json.animations.idle.drawOrder[0].offsets[0].slot, 'left_eye');
  assert.equal(source.slots[1].name, 'eye');
});

test('modifySlots：remove 引用保护与显式清理，reorder 严格校验', () => {
  const source = withAnimationReferences();
  assert.throws(() => modifySlots(source, { mode: 'remove', slots: ['eye'] }), /皮肤附件|动画引用/);
  assert.throws(() => modifySlots(source, { mode: 'remove', slots: ['weapon_slot'] }), /皮肤附件/);
  const removed = modifySlots(source, {
    mode: 'remove', slots: ['eye'], dropAttachments: true, dropAnimationTracks: true,
  });
  assert.equal(removed.json.slots.some((slot) => slot.name === 'eye'), false);
  assert.equal(removed.json.skins.default.eye, undefined);
  assert.equal(removed.json.animations.idle.slots.eye, undefined);
  assert.deepEqual(removed.json.animations.idle.drawOrder[0].offsets, []);
  const reordered = modifySlots(source, { mode: 'reorder', order: ['eye', 'weapon_slot'] });
  assert.deepEqual(reordered.json.slots.map((slot) => slot.name), ['eye', 'weapon_slot']);
  assert.throws(() => modifySlots(source, { mode: 'reorder', order: ['eye'] }), /order/);
  assert.throws(() => modifySlots(source, { mode: 'unknown' }), /未知 mode/);
});

test('modifySkins：list / add / assign / rename / remove 与 deform 同步', () => {
  const source = withAnimationReferences();
  source.animations.idle.deform = { default: { eye: { eye_open: [{ time: 0, offset: 0 }] } } };
  const listed = modifySkins(source, {});
  assert.equal(listed.skins[0].name, 'default');
  assert.equal(listed.skins[0].attachmentCount, 3);

  const added = modifySkins(source, { mode: 'add', skins: ['battle'] });
  assert.ok(added.json.skins.battle);
  const assigned = modifySkins(added.json, {
    mode: 'assign',
    attachments: [{ skin: 'battle', slot: 'weapon_slot', name: 'sword', attachment: { width: 32, height: 64 } }],
  });
  assert.equal(assigned.json.skins.battle.weapon_slot.sword.width, 32);
  const removedAttachment = modifySkins(assigned.json, {
    mode: 'assign', attachments: [{ skin: 'battle', slot: 'weapon_slot', name: 'sword', attachment: null }],
  });
  assert.equal(removedAttachment.json.skins.battle.weapon_slot.sword, undefined);

  assert.throws(() => modifySkins(source, { mode: 'remove', skins: ['default'] }), /deform 动画引用/);
  const renamed = modifySkins(source, { mode: 'rename', rename: { from: 'default', to: 'base' } });
  assert.ok(renamed.json.skins.base);
  assert.ok(renamed.json.animations.idle.deform.base);
  const removed = modifySkins(source, { mode: 'remove', skins: ['default'], dropDeformTracks: true });
  assert.equal(removed.json.skins.default, undefined);
  assert.equal(removed.json.animations.idle.deform.default, undefined);
  assert.throws(() => modifySkins(source, { mode: 'unknown' }), /未知 mode/);
});

test('inspectConstraints：定义、缺失骨骼与动画使用', () => {
  const skeleton = hero();
  skeleton.ik = [{ name: 'head_ik', bones: ['head'], target: 'weapon', mix: 0.5 }];
  skeleton.animations.idle.ik = { head_ik: [{ time: 0, mix: 0.2 }] };
  const report = inspectConstraints(skeleton);
  assert.equal(report.counts.ik, 1);
  assert.equal(report.issueCount, 0);
  assert.deepEqual(report.constraints[0].animations, [{ name: 'idle', keyframes: 1 }]);
  skeleton.ik[0].target = 'ghost';
  assert.equal(inspectConstraints(skeleton).issueCount, 1);
});

test('inspectAtlas：页面、region、重叠、越界与缺图', () => {
  const atlas = [
    '',
    'page.png',
    'size: 64,64',
    'format: RGBA8888',
    'filter: Linear,Linear',
    'repeat: none',
    'sword',
    '  rotate: false',
    '  xy: 0,0',
    '  size: 32,32',
    '  orig: 32,32',
    '  offset: 0,0',
    '  index: -1',
    'eye_open',
    '  rotate: false',
    '  xy: 0,0',
    '  size: 16,16',
    '  orig: 16,16',
    '  offset: 0,0',
    '  index: -1',
    'overflow',
    '  rotate: false',
    '  xy: 60,60',
    '  size: 16,16',
    '  orig: 16,16',
    '  offset: 0,0',
    '  index: -1',
  ].join('\n');
  const report = inspectAtlas(atlas, { source: 'test.atlas', imageDir: null });
  assert.equal(report.pageCount, 1);
  assert.equal(report.regionCount, 3);
  assert.ok(report.issues.some((issue) => issue.reason.includes('重叠')));
  assert.ok(report.issues.some((issue) => issue.reason.includes('超出页面')));
  const withImageDir = inspectAtlas(atlas, { source: 'test.atlas', imageDir: path.join(os.tmpdir(), 'definitely-not-exists') });
  assert.ok(withImageDir.issues.some((issue) => issue.reason.includes('图集页图片不存在')));
  const duplicate = inspectAtlas(atlas.replace('eye_open', 'sword'), { source: 'dup.atlas' });
  assert.equal(duplicate.duplicateRegions.length, 1);
});

test('auditAssets：附件与图集/散图对应关系', () => {
  const skeleton = withAnimationReferences();
  const atlas = inspectAtlas([
    '', 'page.png', 'size: 64,64', 'sword',
    '  rotate: false', '  xy: 0,0', '  size: 32,32', '  orig: 32,32', '  offset: 0,0', '  index: -1',
  ].join('\n'), { source: 'page.atlas' });
  const report = auditAssets({ skeleton, atlasReports: [atlas] });
  assert.equal(report.attachmentCount, 3);
  assert.deepEqual(report.missingInAtlas, [
    { attachment: 'eye_closed', region: 'eye_closed' },
    { attachment: 'eye_open', region: 'eye_open' },
  ]);
  assert.deepEqual(report.unusedRegions.map((item) => item.name), []);
  assert.ok(report.issues.some((issue) => issue.type === 'atlas.missingRegion'));

  const pathed = withAnimationReferences();
  pathed.skins.default.eye.eye_open = { type: 'mesh', path: 'sword', uvs: [0, 0, 1, 0, 1, 1], vertices: [0, 0, 1, 1, 2, 3], triangles: [0, 1, 2] };
  const pathedReport = auditAssets({ skeleton: pathed, atlasReports: [atlas] });
  assert.deepEqual(pathedReport.missingInAtlas, [{ attachment: 'eye_closed', region: 'eye_closed' }]);
  assert.equal(pathedReport.attachments.find((row) => row.name === 'eye_open').imageSource, 'sword');

  const noAtlas = auditAssets({ skeleton, atlasReports: [] });
  assert.equal(noAtlas.issueCount, 0);
});

test('stdio 集成：P6 五个工具可用且写操作只落副本', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-p6-'));
  const sourcePath = path.join(dir, 'hero.json');
  const slotsPath = path.join(dir, 'slots.json');
  const atlasPath = path.join(dir, 'hero.atlas');
  const pagePath = path.join(dir, 'page.png');
  fs.writeFileSync(sourcePath, JSON.stringify(withAnimationReferences(), null, 2));
  fs.writeFileSync(pagePath, 'fake png bytes');
  fs.writeFileSync(atlasPath, ['', 'page.png', 'size: 64,64', 'sword', '  rotate: false', '  xy: 0,0', '  size: 32,32', '  orig: 32,32', '  offset: 0,0', '  index: -1'].join('\n'));
  try {
    const responses = await runServer([
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'spine_edit_slots', arguments: { sourceJsonPath: sourcePath, mode: 'list' } } },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'spine_edit_slots', arguments: { sourceJsonPath: sourcePath, outputJsonPath: slotsPath, mode: 'rename', rename: { from: 'eye', to: 'left_eye' } } } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'spine_edit_skins', arguments: { sourceJsonPath: sourcePath, mode: 'list' } } },
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'spine_inspect_constraints', arguments: { jsonPath: sourcePath } } },
      { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'spine_inspect_atlas', arguments: { atlasPath } } },
      { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'spine_audit_assets', arguments: { jsonPath: sourcePath, atlasPaths: [atlasPath], imageDir: dir } } },
    ]);
    assert.equal(responses.find((item) => item.id === 1).result.tools.length, TOOLS.length);
    assert.equal(responses.find((item) => item.id === 2).result.structuredContent.slots.length, 2);
    const renamed = responses.find((item) => item.id === 3).result;
    assert.equal(renamed.isError, false);
    assert.match(renamed.structuredContent.nextStep, /Import Data/);
    assert.equal(JSON.parse(fs.readFileSync(slotsPath, 'utf8')).slots[1].name, 'left_eye');
    assert.equal(responses.find((item) => item.id === 4).result.structuredContent.skins[0].attachmentCount, 3);
    assert.equal(responses.find((item) => item.id === 5).result.structuredContent.counts.ik, 0);
    const atlas = responses.find((item) => item.id === 6).result.structuredContent;
    assert.equal(atlas.pageCount, 1);
    assert.equal(atlas.pages[0].imageExists, true);
    const assets = responses.find((item) => item.id === 7).result.structuredContent;
    assert.equal(assets.attachmentCount, 3);
    assert.deepEqual(assets.missingInAtlas, [
      { attachment: 'eye_closed', region: 'eye_closed' },
      { attachment: 'eye_open', region: 'eye_open' },
    ]);
    assert.equal(JSON.parse(fs.readFileSync(sourcePath, 'utf8')).slots[1].name, 'eye');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
