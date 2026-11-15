import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildCombatAnimation,
  durationSeconds,
  frameTable,
  frameToTime,
  validateAnimation,
} from '../src/timeline.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(here, '..', 'fixtures', 'hero.json');
const loadFixture = () => JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

test('帧号换算成 Spine 秒数', () => {
  assert.equal(frameToTime(1, 12), 0);
  assert.equal(frameToTime(3, 12), 0.166667);
  assert.equal(frameToTime(8, 12), 0.583333);
  assert.equal(durationSeconds(8, 12), 0.666667);
  assert.equal(frameToTime(3, 24), 0.083333);
});

test('8 帧普攻帧表：F3 命中落在 0.166667s', () => {
  const table = frameTable(8, 12, [{ frame: 3, name: 'hit' }, { frame: 6, name: 'recover' }]);
  assert.equal(table.rows.length, 8);
  assert.equal(table.durationSec, 0.666667);
  assert.equal(table.rows[2].timeSec, 0.166667);
  assert.deepEqual(table.rows[2].events, ['hit']);
  assert.deepEqual(table.rows[5].events, ['recover']);
  assert.deepEqual(table.rows[7].events, []);
});

test('在副本上生成普攻动画，源文件对象不被修改', () => {
  const source = loadFixture();
  const { json, summary } = buildCombatAnimation(source, {
    animationName: 'attack_01',
    fps: 12,
    frames: 8,
    boneControls: [
      {
        bone: 'weapon',
        rotate: [
          { frame: 1, angle: -10 },
          { frame: 3, angle: 35 },
          { frame: 5, angle: 12 },
          { frame: 8, angle: 0 },
        ],
        translate: [
          { frame: 1, x: 0, y: 0 },
          { frame: 3, x: 6, y: 2 },
        ],
      },
      {
        bone: 'head',
        rotate: [{ frame: 1, angle: 0 }, { frame: 4, angle: -4 }, { frame: 8, angle: 0 }],
      },
    ],
    eventFrames: [{ frame: 3, name: 'hit', int: 1 }, { frame: 6, name: 'recover' }],
    slotKeys: [{ slot: 'eye', frame: 4, attachment: 'eye_closed' }],
  });

  assert.equal(source.animations.attack_01, undefined, '源对象不得被修改');
  assert.equal(source.events.recover, undefined, '源事件表不得被修改');
  assert.equal(summary.durationSec, 0.666667);
  assert.equal(summary.boneCount, 2);
  assert.equal(summary.eventCount, 2);

  const anim = json.animations.attack_01;
  assert.equal(anim.bones.weapon.rotate[1].time, 0.166667);
  assert.equal(anim.bones.weapon.rotate[1].angle, 35);
  assert.equal(anim.bones.weapon.translate[1].time, 0.166667);
  assert.deepEqual(anim.events[0], { time: 0.166667, name: 'hit', int: 1 });
  assert.equal(anim.slots.eye.attachment[0].time, 0.25);
  assert.ok(json.events.recover, '新事件名应补进顶层 events');
  assert.ok(summary.warnings.some((w) => w.includes('recover')));
  assert.equal(validateAnimation(json, 'attack_01').valid, true);
});

test('参数错误会被拒绝，而不是静默产出坏时间轴', () => {
  const base = { animationName: 'bad', fps: 12, frames: 8 };
  assert.throws(
    () => buildCombatAnimation(loadFixture(), { ...base, eventFrames: [{ frame: 9, name: 'hit' }] }),
    /超出总帧数/,
  );
  assert.throws(
    () => buildCombatAnimation(loadFixture(), { ...base, boneControls: [{ bone: 'not_exist', rotate: [{ frame: 1, angle: 0 }] }] }),
    /骨骼不存在/,
  );
  assert.throws(
    () => buildCombatAnimation(loadFixture(), { ...base, boneControls: [{ bone: 'weapon', rotate: [{ frame: 3, angle: 1 }, { frame: 3, angle: 2 }] }] }),
    /必须递增且不可重复/,
  );
  assert.throws(
    () => buildCombatAnimation(loadFixture(), { ...base, animationName: 'idle' }),
    /动画 idle 已存在/,
  );
  assert.throws(() => frameToTime(0, 12), /必须是正整数/);
});

test('校验器能发现缺失的事件定义与倒序时间', () => {
  const broken = loadFixture();
  broken.animations.broken = {
    bones: { weapon: { rotate: [{ time: 0.5, angle: 1 }, { time: 0.1, angle: 2 }] } },
    events: [{ time: 0.2, name: 'undefined_event' }],
  };
  const report = validateAnimation(broken, 'broken');
  assert.equal(report.valid, false);
  assert.ok(report.errors.some((e) => e.includes('严格递增')));
  assert.ok(report.errors.some((e) => e.includes('缺少定义')));
});
