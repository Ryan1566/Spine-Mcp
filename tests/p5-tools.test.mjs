import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { auditProject } from '../src/project-audit.mjs';
import { inspectAnimation, editAnimation } from '../src/animation-detail.mjs';
import { mergeAnimations } from '../src/animation-ops.mjs';
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

test('auditProject：正常 fixture 通过，引用与事件错误可定位', () => {
  const valid = auditProject(hero());
  assert.equal(valid.ok, true);
  assert.equal(valid.errors, 0);
  assert.equal(valid.counts.bones, 4);
  assert.equal(valid.animations[0].name, 'idle');

  const broken = hero();
  broken.slots[0].bone = 'ghost';
  broken.animations.idle.events = [{ time: 0.5, name: 'missing_event' }];
  broken.animations.idle.slots = {
    ghost_slot: { attachment: [{ time: 0, name: null }] },
    weapon_slot: { attachment: [{ time: 0.5, name: 'sword' }, { time: 0.2, name: null }] },
  };
  const report = auditProject(broken);
  assert.equal(report.ok, false);
  assert.ok(report.issues.some((issue) => issue.code === 'slot.bone'));
  assert.ok(report.issues.some((issue) => issue.message.includes('missing_event')));
  assert.ok(report.issues.some((issue) => issue.code === 'animation.reference' && issue.target === 'ghost_slot'));
  assert.ok(report.issues.some((issue) => issue.message.includes('slots.weapon_slot.attachment') && issue.message.includes('未严格递增')));
  assert.equal(report.animations[0].valid, false);
});

test('inspectAnimation：时间轴明细、曲线与返回数量截断', () => {
  const skeleton = hero();
  delete skeleton.animations.idle.bones.head.rotate[0].time; // 官方 JSON 会把默认 time=0 省略
  skeleton.animations.idle.bones.head.rotate[1].curve = 'stepped';
  const full = inspectAnimation(skeleton, 'idle');
  assert.equal(full.durationSec, 1);
  assert.equal(full.timelineCount, 1);
  assert.equal(full.keyframeCount, 3);
  assert.equal(full.timelines[0].startTimeSec, 0);
  assert.equal(full.timelines[0].path, 'bones.head.rotate');
  assert.deepEqual(full.curveTypes, ['linear', 'stepped']);
  const limited = inspectAnimation(skeleton, 'idle', { maxKeyframes: 2 });
  assert.equal(limited.returnedKeyframeCount, 2);
  assert.equal(limited.truncated, true);
  assert.equal(limited.timelines[0].keyframesTruncated, true);
  const summary = inspectAnimation(skeleton, 'idle', { includeKeyframes: false });
  assert.equal(summary.timelines[0].keyframes.length, 0);
  assert.throws(() => inspectAnimation(skeleton, 'ghost'), /动画不存在/);
});

test('editAnimation：duplicate / rename / remove 不改源对象', () => {
  const source = hero();
  const duplicated = editAnimation(source, { mode: 'duplicate', animationName: 'idle', newName: 'idle_copy' });
  assert.ok(duplicated.json.animations.idle);
  assert.ok(duplicated.json.animations.idle_copy);
  assert.equal(source.animations.idle_copy, undefined);
  const renamed = editAnimation(duplicated.json, { mode: 'rename', animationName: 'idle_copy', newName: 'idle_alt' });
  assert.equal(renamed.json.animations.idle_copy, undefined);
  assert.ok(renamed.json.animations.idle_alt);
  const removed = editAnimation(renamed.json, { mode: 'remove', animationName: 'idle_alt' });
  assert.equal(removed.json.animations.idle_alt, undefined);
  assert.ok(removed.json.animations.idle);
});

test('editAnimation：shift / scale / crop 覆盖骨骼、事件与 deform 时间', () => {
  const source = hero();
  delete source.animations.idle.bones.head.rotate[0].time;
  source.animations.idle.events = [{ time: 0.5, name: 'hit' }];
  source.animations.idle.deform = {
    default: { weapon_slot: { sword: [{ time: 1, offset: 0, vertices: [0.1] }] } },
  };
  const shifted = editAnimation(source, { mode: 'shift', animationName: 'idle', offset: 0.25 });
  assert.equal(shifted.json.animations.idle.bones.head.rotate[0].time, 0.25);
  assert.equal(shifted.json.animations.idle.events[0].time, 0.75);
  assert.equal(shifted.json.animations.idle.deform.default.weapon_slot.sword[0].time, 1.25);
  assert.equal(shifted.summary.durationSec, 1.25);

  const scaled = editAnimation(source, { mode: 'scale', animationName: 'idle', scale: 2 });
  assert.equal(scaled.json.animations.idle.bones.head.rotate[2].time, 2);
  assert.equal(scaled.json.animations.idle.events[0].time, 1);
  const cropped = editAnimation(source, { mode: 'crop', animationName: 'idle', start: 0.25, end: 0.75 });
  assert.equal(cropped.json.animations.idle.bones.head.rotate.length, 1);
  assert.equal(cropped.json.animations.idle.bones.head.rotate[0].time, 0.5);
  assert.equal(cropped.summary.removedKeyframes, 3); // 骨骼首尾 + deform；事件保留
  assert.throws(() => editAnimation(source, { mode: 'shift', animationName: 'idle', offset: -1 }), /负 time/);
  assert.throws(() => editAnimation(source, { mode: 'scale', animationName: 'idle', scale: 0 }), /scale/);
});

test('mergeAnimations：boneMap / timeOffset / skipMissingBones', () => {
  const donor = {
    bones: [{ name: 'donor_head' }],
    events: { hit: {} },
    animations: {
      attack: {
        bones: {
          donor_head: { rotate: [{ time: 0, angle: 1 }, { time: 1, angle: 2 }] },
          ghost: { translate: [{ time: 0.5, x: 1 }] },
        },
        events: [{ time: 0.5, name: 'hit' }],
      },
    },
  };
  assert.throws(() => mergeAnimations(hero(), donor, { boneMap: { donor_head: 'head' } }), /不存在的骨骼/);
  const merged = mergeAnimations(hero(), donor, {
    boneMap: { donor_head: 'head' }, skipMissingBones: true, timeOffset: 0.25,
  });
  const animation = merged.json.animations.attack;
  assert.equal(animation.bones.head.rotate[1].time, 1.25);
  assert.equal(animation.bones.ghost, undefined);
  assert.equal(animation.events[0].time, 0.75);
  assert.deepEqual(merged.summary.remappedBones, [{ animation: 'attack', from: 'donor_head', to: 'head' }]);
  assert.deepEqual(merged.summary.droppedBoneTracks, [{ animation: 'attack', bone: 'ghost' }]);
});

test('stdio 集成：P5 三个工具与增强合并可用', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-p5-'));
  const editedPath = path.join(dir, 'edited.json');
  const mergedPath = path.join(dir, 'merged.json');
  const donorPath = path.join(dir, 'donor.json');
  const donor = hero();
  donor.animations.attack = { bones: { head: { rotate: [{ time: 0, angle: 10 }] } } };
  fs.writeFileSync(donorPath, JSON.stringify(donor));
  try {
    const responses = await runServer([
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'spine_audit_project', arguments: { jsonPath: heroPath } } },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'spine_inspect_animation', arguments: { jsonPath: heroPath, animationName: 'idle' } } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'spine_edit_animation', arguments: { sourceJsonPath: heroPath, outputJsonPath: editedPath, animationName: 'idle', mode: 'scale', scale: 2 } } },
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'spine_merge_animations', arguments: { baseJsonPath: heroPath, donorJsonPath: donorPath, outputJsonPath: mergedPath, animationNames: ['attack'], boneMap: { head: 'weapon' }, timeOffset: 0.5 } } },
    ]);
    assert.equal(responses.find((item) => item.id === 1).result.tools.length, TOOLS.length);
    assert.equal(responses.find((item) => item.id === 2).result.structuredContent.ok, true);
    assert.equal(responses.find((item) => item.id === 3).result.structuredContent.keyframeCount, 3);
    const edited = responses.find((item) => item.id === 4).result;
    assert.equal(edited.isError, false);
    assert.equal(edited.structuredContent.durationSec, 2);
    assert.equal(JSON.parse(fs.readFileSync(editedPath, 'utf8')).animations.idle.bones.head.rotate[2].time, 2);
    const merged = responses.find((item) => item.id === 5).result;
    assert.equal(merged.isError, false);
    assert.equal(merged.structuredContent.remappedBones[0].to, 'weapon');
    assert.equal(JSON.parse(fs.readFileSync(mergedPath, 'utf8')).animations.attack.bones.weapon.rotate[0].time, 0.5);
    assert.equal(JSON.parse(fs.readFileSync(heroPath, 'utf8')).animations.idle.bones.head.rotate[2].time, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
