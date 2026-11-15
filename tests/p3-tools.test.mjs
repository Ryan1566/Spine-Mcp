import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { diffAnimations, mergeAnimations, manageEvents, listEvents, buildBatch } from '../src/animation-ops.mjs';
import { TOOLS } from '../src/tools.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const heroPath = path.join(here, '..', 'fixtures', 'hero.json');
const demoPath = path.join(here, '..', 'fixtures', 'hero.attack.demo.json');
const serverPath = path.join(here, '..', 'src', 'index.mjs');
const hero = () => JSON.parse(fs.readFileSync(heroPath, 'utf8'));

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'spine-p3-'));
}

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

test('diffAnimations：新增 / 修改 / 未变 / 事件定义差异', () => {
  const base = hero();
  const other = structuredClone(base);
  other.animations.attack = { bones: { weapon: { rotate: [{ time: 0, angle: 0 }] } } };
  other.animations.idle.bones.head.rotate[0].angle = -9;
  other.events.recover = {};
  const diff = diffAnimations(base, other);
  assert.equal(diff.identical, false);
  assert.deepEqual(diff.added.map((a) => a.name), ['attack']);
  assert.deepEqual(diff.changed.map((a) => a.name), ['idle']);
  assert.deepEqual(diff.events.added, ['recover']);
  assert.equal(diff.counts.base, 1);
  assert.equal(diff.counts.other, 2);
  assert.equal(diffAnimations(base, structuredClone(base)).identical, true);
});

test('mergeAnimations：跳过同名、补齐事件定义、overwrite 覆盖', () => {
  const base = hero();
  const donor = {
    events: { hit2: { int: 1 } },
    animations: {
      attack: { events: [{ time: 0, name: 'hit2' }] },
      idle: { bones: { head: { rotate: [{ time: 0, angle: 1 }] } } },
    },
  };
  const first = mergeAnimations(base, donor);
  assert.deepEqual(first.summary.merged, ['attack']);
  assert.deepEqual(first.summary.skipped, ['idle']);
  assert.deepEqual(first.summary.eventsAdded, ['hit2']);
  assert.equal(first.json.events.hit2.int, 1);
  assert.equal(base.animations.attack, undefined); // 源对象未被改动

  const forced = mergeAnimations(base, donor, { overwrite: true });
  assert.deepEqual(forced.summary.skipped, []);
  assert.equal(forced.json.animations.idle.bones.head.rotate[0].angle, 1);
  const picked = mergeAnimations(base, donor, { animationNames: ['attack'] });
  assert.deepEqual(picked.summary.merged, ['attack']);
});

test('manageEvents：list / add / remove / rename', () => {
  const base = hero();
  assert.deepEqual(listEvents(base).map((e) => e.name), ['hit']);

  const added = manageEvents(base, { mode: 'add', events: ['recover', { name: 'footstep', string: 'walk' }] });
  assert.deepEqual(added.summary.added, ['recover', 'footstep']);
  assert.equal(added.json.events.footstep.string, 'walk');

  const removed = manageEvents(added.json, { mode: 'remove', events: ['recover'] });
  assert.deepEqual(removed.summary.removed, ['recover']);
  assert.equal(removed.json.events.recover, undefined);

  const withEvent = structuredClone(base);
  withEvent.animations.idle.events = [{ time: 0, name: 'hit' }];
  const renamed = manageEvents(withEvent, { mode: 'rename', rename: { from: 'hit', to: 'damage' } });
  assert.deepEqual(renamed.summary.renamed, [{ from: 'hit', to: 'damage' }]);
  assert.equal(renamed.json.events.damage.string, undefined);
  assert.equal(renamed.json.animations.idle.events[0].name, 'damage');
  assert.throws(() => manageEvents(base, { mode: 'unknown' }), /未知 mode/);
});

test('buildBatch：多 skeleton 逐个生成，skipMissingBones 容错', () => {
  const items = [
    { name: 'hero', skeleton: hero() },
    { name: 'other', skeleton: { ...hero(), bones: [{ name: 'root' }] } },
  ];
  const spec = {
    animationName: 'attack', fps: 12, frames: 8,
    boneControls: [{ bone: 'weapon', rotate: [{ frame: 1, angle: 0 }, { frame: 8, angle: 0 }] }],
  };
  const strict = buildBatch(items, spec);
  assert.equal(strict.results.length, 1);
  assert.equal(strict.failures.length, 1);
  const tolerant = buildBatch(items, { ...spec, skipMissingBones: true });
  assert.equal(tolerant.results.length, 2);
  assert.equal(tolerant.failures.length, 0);
  assert.equal(tolerant.results[0].json.animations.attack.bones.weapon.rotate.length, 2);
});

test('stdio 集成：P3 四个工具可用且只写副本', async () => {
  const dir = tempDir();
  const mergedPath = path.join(dir, 'merged.json');
  try {
    const responses = await runServer([
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'spine_diff_animations', arguments: { baseJsonPath: heroPath, otherJsonPath: heroPath } } },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'spine_manage_events', arguments: { sourceJsonPath: heroPath, mode: 'list' } } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'spine_merge_animations', arguments: { baseJsonPath: heroPath, donorJsonPath: demoPath, outputJsonPath: mergedPath } } },
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'spine_build_batch_animations', arguments: { sourceJsonPaths: [heroPath, demoPath], outputDir: dir, animationName: 'p3_attack', fps: 12, frames: 8, skipMissingBones: true } } },
    ]);
    assert.equal(responses.find((r) => r.id === 1).result.tools.length, TOOLS.length);
    const diff = responses.find((r) => r.id === 2).result;
    assert.equal(diff.isError, false);
    assert.equal(diff.structuredContent.identical, true);
    const listed = responses.find((r) => r.id === 3).result;
    assert.equal(listed.isError, false);
    assert.ok(listed.structuredContent.events.some((e) => e.name === 'hit'));
    const merged = responses.find((r) => r.id === 4).result;
    assert.equal(merged.isError, false);
    assert.match(merged.structuredContent.nextStep, /Import Data/);
    assert.ok(fs.existsSync(mergedPath));
    const batch = responses.find((r) => r.id === 5).result;
    assert.equal(batch.isError, false);
    assert.equal(batch.structuredContent.written.length, 2);
    assert.equal(batch.structuredContent.failures.length, 0);
    assert.match(batch.structuredContent.nextStep, /Import Data/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
