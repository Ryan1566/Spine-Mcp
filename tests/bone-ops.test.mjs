import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { listBones, modifyBones } from '../src/bone-ops.mjs';
import { TOOLS } from '../src/tools.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const heroPath = path.join(here, '..', 'fixtures', 'hero.json');
const serverPath = path.join(here, '..', 'src', 'index.mjs');
const hero = () => JSON.parse(fs.readFileSync(heroPath, 'utf8'));

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'spine-bones-'));
}

function runServer(messages) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serverPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, SPINE_EXE: '' },
    });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { /* 忽略日志 */ });
    child.on('error', reject);
    child.on('close', () => {
      try {
        resolve(out.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)));
      } catch (err) {
        reject(new Error(`${err.message}\nstdout=${out}`));
      }
    });
    child.stdin.write(`${messages.map((m) => JSON.stringify(m)).join('\n')}\n`);
    child.stdin.end();
  });
}

test('listBones：按数组下标列出骨骼与 setup pose', () => {
  const bones = listBones(hero());
  assert.equal(bones.length, 4);
  assert.deepEqual(bones.map((b) => b.name), ['root', 'body', 'head', 'weapon']);
  assert.equal(bones[1].parent, 'root');
  assert.equal(modifyBones(hero(), { mode: 'list' }).bones.length, 4);
});

test('add：追加到末尾，校验重名/父级/字段类型', () => {
  const source = hero();
  const { json, summary } = modifyBones(source, {
    mode: 'add',
    bones: [{ name: 'cape', parent: 'body', x: 10, y: -4, rotation: 15, length: 40 }],
  });
  assert.equal(json.bones.length, 5);
  assert.equal(json.bones[4].name, 'cape');
  assert.equal(json.bones[4].rotation, 15);
  assert.equal(source.bones.length, 4); // 源对象未被改动
  assert.equal(summary.added[0].parent, 'body');
  assert.throws(() => modifyBones(source, { mode: 'add', bones: [{ name: 'head' }] }), /已存在/);
  assert.throws(() => modifyBones(source, { mode: 'add', bones: [{ name: 'x', parent: 'nope' }] }), /父骨骼不存在/);
  assert.throws(() => modifyBones(source, { mode: 'add', bones: [{ name: 'x', x: 'bad' }] }), /必须是有限数字/);
});

test('set：只改 setup pose 白名单字段', () => {
  const { json, summary } = modifyBones(hero(), {
    mode: 'set',
    bones: [{ name: 'head', x: 12.5, rotation: -30, length: 20, bogus: 1 }],
  });
  const head = json.bones.find((b) => b.name === 'head');
  assert.equal(head.x, 12.5);
  assert.equal(head.rotation, -30);
  assert.equal(head.length, 20);
  assert.equal(head.bogus, undefined);
  assert.deepEqual(summary.updated[0].fields.sort(), ['length', 'rotation', 'x']);
  assert.throws(() => modifyBones(hero(), { mode: 'set', bones: [{ name: 'ghost', x: 1 }] }), /骨骼不存在/);
});

test('rename：同步 parent / slots / animations / IK', () => {
  const source = hero();
  source.slots[0].bone = 'weapon';
  source.animations.idle.bones = { weapon: { rotate: [{ time: 0, angle: 1 }] }, head: { rotate: [] } };
  source.ik = [{ name: 'aim', bones: ['weapon', 'body'], target: 'weapon' }];
  const { json, summary } = modifyBones(source, { mode: 'rename', rename: { from: 'weapon', to: 'weapon_r' } });
  assert.equal(json.bones.find((b) => b.name === 'weapon_r').parent, 'body');
  assert.equal(json.slots[0].bone, 'weapon_r');
  assert.ok(json.animations.idle.bones.weapon_r);
  assert.equal(json.animations.idle.bones.weapon, undefined);
  assert.deepEqual(json.ik[0].bones, ['weapon_r', 'body']);
  assert.equal(json.ik[0].target, 'weapon_r');
  assert.deepEqual(summary.renamed, [{ from: 'weapon', to: 'weapon_r' }]);
  assert.throws(() => modifyBones(source, { mode: 'rename', rename: { from: 'ghost', to: 'x' } }), /骨骼不存在/);
  assert.throws(() => modifyBones(source, { mode: 'rename', rename: { from: 'head', to: 'body' } }), /已存在/);
});

test('reparent：改父级并阻止循环', () => {
  const { json } = modifyBones(hero(), { mode: 'reparent', reparent: { name: 'weapon', parent: 'head' } });
  assert.equal(json.bones.find((b) => b.name === 'weapon').parent, 'head');
  assert.throws(() => modifyBones(hero(), { mode: 'reparent', reparent: { name: 'root', parent: 'weapon' } }), /循环/);
  assert.throws(() => modifyBones(hero(), { mode: 'reparent', reparent: { name: 'head', parent: 'ghost' } }), /父骨骼不存在/);
});

test('remove：引用保护、自动重接子级与清理时间轴', () => {
  const source = hero();
  assert.throws(() => modifyBones(source, { mode: 'remove', bones: ['body'] }), /仍被引用/);
  const { json, summary } = modifyBones(source, {
    mode: 'remove',
    bones: ['body'],
    reparentChildren: true,
    dropAnimationTracks: true,
  });
  assert.equal(json.bones.some((b) => b.name === 'body'), false);
  assert.equal(json.bones.find((b) => b.name === 'head').parent, 'root');
  assert.equal(json.bones.find((b) => b.name === 'weapon').parent, 'root');
  assert.equal(summary.removed[0].reparentedChildren.length, 2);

  const withSlot = hero();
  withSlot.slots[0].bone = 'weapon';
  assert.throws(() => modifyBones(withSlot, { mode: 'remove', bones: ['weapon'], reparentChildren: true, dropAnimationTracks: true }), /插槽/);
});

test('remove：含加权 mesh 的工程拒绝删除，避免权重索引错位', () => {
  const source = hero();
  source.skins = [{
    name: 'default',
    attachments: {
      weapon_slot: {
        sword: { type: 'mesh', uvs: [0, 0, 1, 0, 1, 1], vertices: [1, 3, 1, 2, 1], triangles: [0, 1, 2] },
      },
    },
  }];
  assert.throws(() => modifyBones(source, { mode: 'remove', bones: ['weapon'] }), /含加权 mesh/);
  // rename / set 不受影响
  assert.doesNotThrow(() => modifyBones(source, { mode: 'set', bones: [{ name: 'weapon', x: 1 }] }));
  assert.throws(() => modifyBones(source, { mode: 'unknown' }), /未知 mode/);
});

test('stdio 集成：list 只读，add/set 写副本并提示 Import Data', async () => {
  const dir = tempDir();
  const added = path.join(dir, 'added.json');
  const changed = path.join(dir, 'changed.json');
  try {
    const responses = await runServer([
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'spine_modify_bones', arguments: { sourceJsonPath: heroPath, mode: 'list' } } },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'spine_modify_bones', arguments: { sourceJsonPath: heroPath, mode: 'add', outputJsonPath: added, bones: [{ name: 'cape', parent: 'body' }] } } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'spine_modify_bones', arguments: { sourceJsonPath: added, mode: 'set', outputJsonPath: changed, bones: [{ name: 'cape', rotation: 45 }] } } },
    ]);
    assert.equal(responses.find((r) => r.id === 1).result.tools.length, TOOLS.length);
    assert.ok(TOOLS.some((t) => t.name === 'spine_modify_bones'));
    const listed = responses.find((r) => r.id === 2).result;
    assert.equal(listed.isError, false);
    assert.equal(listed.structuredContent.bones.length, 4);
    const made = responses.find((r) => r.id === 3).result;
    assert.equal(made.isError, false);
    assert.match(made.structuredContent.nextStep, /Import Data/);
    const updated = responses.find((r) => r.id === 4).result;
    assert.equal(updated.isError, false);
    const j = JSON.parse(fs.readFileSync(changed, 'utf8'));
    assert.equal(j.bones.find((b) => b.name === 'cape').rotation, 45);
    assert.equal(JSON.parse(fs.readFileSync(heroPath, 'utf8')).bones.length, 4); // 源 fixture 未变
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
