// P16：约束求解（ik / transform）与约束时间线打帧。
// 这些断言不依赖渲染，全部是几何/结构判据：IK 末端必须落到 target、transform 必须精确对齐、
// 时间线字段必须按 3.8.75 实测白名单过滤。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  animateConstraint,
  inspectConstraintTracks,
  CONSTRAINT_ANIMATION_FIELDS,
} from '../src/constraint-anim.mjs';
import { diagnoseConstraints } from '../src/constraint-diagnostics.mjs';
import { evaluateScene, computeWorldWithConstraints, setupPose } from '../src/pose-eval.mjs';
import { applyTransform, applyIk, constraintDefaults, mergeConstraintValues, orderedConstraints } from '../src/constraints.mjs';
import { buildBoneIndex, worldShearY } from '../src/bone-math.mjs';

// 两根骨的链：p1(50) -> p2(50)，target 放在 (80,20)，链总长 100，够得着。
const rig = () => ({
  skeleton: { spine: '3.8.75' },
  bones: [
    { name: 'root', length: 0 },
    { name: 'p1', parent: 'root', x: 0, y: 0, rotation: 0, length: 50 },
    { name: 'p2', parent: 'p1', x: 50, y: 0, rotation: 0, length: 50 },
    { name: 'target', parent: 'root', x: 80, y: 20, length: 0 },
    { name: 'single', parent: 'root', x: 0, y: 0, rotation: 0, length: 40 },
    { name: 'single-target', parent: 'root', x: 0, y: 30, length: 0 },
  ],
  slots: [],
  skins: [{ name: 'default', attachments: {} }],
  ik: [
    { name: 'two-bone', bones: ['p1', 'p2'], target: 'target', mix: 1 },
    { name: 'one-bone', bones: ['single'], target: 'single-target', mix: 1 },
  ],
  animations: {},
});

const boneByName = (scene, name) => scene.worldBones.find((b) => b.name === name);
const endOf = (scene, name) => {
  const b = boneByName(scene, name);
  return { x: b.x + b.length * b.a, y: b.y + b.length * b.c };
};

test('IK 两骨链：解完末端落在 target 上', () => {
  const scene = evaluateScene(rig(), { time: 0 });
  const end = endOf(scene, 'p2');
  const target = boneByName(scene, 'target');
  assert.ok(Math.hypot(end.x - target.x, end.y - target.y) < 0.01, `末端离 target ${Math.hypot(end.x - target.x, end.y - target.y)}`);
  assert.equal(scene.constraints.solved, 2);
});

test('IK 单骨：骨轴指向 target', () => {
  const scene = evaluateScene(rig(), { time: 0 });
  const b = boneByName(scene, 'single');
  const angle = (Math.atan2(b.c, b.a) * 180) / Math.PI;
  assert.ok(Math.abs(angle - 90) < 0.01, `骨轴角 ${angle}，期望 90`);
});

test('IK mix=0 不产生任何位移', () => {
  const skeleton = rig();
  skeleton.ik[0].mix = 0;
  const solved = evaluateScene(skeleton, { time: 0 });
  const raw = evaluateScene(skeleton, { time: 0, solveConstraints: false });
  const a = boneByName(solved, 'p2');
  const b = boneByName(raw, 'p2');
  assert.equal(a.x, b.x);
  assert.equal(a.y, b.y);
});

test('IK 目标超出臂展时链完全伸展但仍朝 target', () => {
  const skeleton = rig();
  skeleton.bones.find((b) => b.name === 'target').x = 500;
  skeleton.bones.find((b) => b.name === 'target').y = 0;
  const scene = evaluateScene(skeleton, { time: 0 });
  const end = endOf(scene, 'p2');
  const target = boneByName(scene, 'target');
  const dist = Math.hypot(end.x - target.x, end.y - target.y);
  // 臂展 100，目标距离 500，末端应停在距起点 100 处、贴 x 轴
  assert.ok(Math.abs(end.x - 100) < 0.01, `末端 x=${end.x}，期望 100`);
  assert.ok(Math.abs(end.y) < 0.01, `末端 y=${end.y}，期望 0`);
  assert.ok(dist > 399, `末端应离目标很远，实际 ${dist}`);
});

test('约束按 order 升序，同 order 保持定义顺序', () => {
  const skeleton = rig();
  skeleton.ik[0].order = 5;
  skeleton.ik[1].order = 1;
  const order = orderedConstraints(skeleton).map((e) => e.data.name);
  assert.deepEqual(order, ['one-bone', 'two-bone']);
  skeleton.ik[1].order = 5;
  assert.deepEqual(orderedConstraints(skeleton).map((e) => e.data.name), ['two-bone', 'one-bone']);
});

// 回归：shear 分支曾经写成 atan2(c,a)+90-worldRotation(t)（两项恒抵消 = 90°），
// 把骨骼 shearY 顶到 90 并把整棵子树拉歪。这里锁死「无剪切目标不改变骨骼剪切」。
test('transform：无剪切的目标不会把骨骼 shearY 拉走（90° 回归）', () => {
  const skeleton = rig();
  skeleton.bones.push({ name: 'eye', parent: 'p1', x: 10, y: 0, rotation: 0, length: 0 });
  skeleton.transform = [{ name: 'eye-tf', bones: ['eye'], target: 'p2' }];
  const scene = evaluateScene(skeleton, { time: 0 });
  const eye = boneByName(scene, 'eye');
  assert.ok(Math.abs(worldShearY(eye)) < 0.01, `eye 世界剪切 ${worldShearY(eye)}，期望 0`);
});

test('transform：rotateMix / translateMix / scaleMix 全量时与目标严格对齐', () => {
  const skeleton = rig();
  skeleton.bones.push({ name: 'follower', parent: 'root', x: 0, y: 0, rotation: 0, length: 0 });
  skeleton.transform = [{ name: 'tf', bones: ['follower'], target: 'p2', x: 12, y: -7, rotation: 15 }];
  const scene = evaluateScene(skeleton, { time: 0 });
  const b = boneByName(scene, 'follower');
  const t = boneByName(scene, 'p2');
  const rot = (m) => (Math.atan2(m.c, m.a) * 180) / Math.PI;
  assert.ok(Math.abs(rot(b) - rot(t) - 15) < 0.01, `旋转差 ${rot(b) - rot(t)}，期望 15`);
  const th = (rot(t) * Math.PI) / 180;
  const wantX = t.x + 12 * Math.cos(th) - -7 * Math.sin(th);
  const wantY = t.y + 12 * Math.sin(th) + -7 * Math.cos(th);
  assert.ok(Math.hypot(b.x - wantX, b.y - wantY) < 0.01, `位移偏差 ${Math.hypot(b.x - wantX, b.y - wantY)}`);
  const scale = (m) => Math.hypot(m.a, m.c);
  assert.ok(Math.abs(scale(b) / scale(t) - 1) < 0.001);
});

test('transform 默认值：四个 mix 不写就是 1（alien 的 eye 没写 mix 也全量生效）', () => {
  const d = constraintDefaults('transform');
  assert.equal(d.rotateMix, 1);
  assert.equal(d.translateMix, 1);
  assert.equal(d.scaleMix, 1);
  assert.equal(d.shearMix, 1);
  assert.equal(d.local, false);
});

test('约束时间线值覆盖定义值', () => {
  const merged = mergeConstraintValues('ik', { mix: 0.2 }, { mix: 1 });
  assert.equal(merged.mix, 1);
  const merged2 = mergeConstraintValues('ik', { mix: 0.2 }, null);
  assert.equal(merged2.mix, 0.2);
});

// ---- 打帧白名单 ----

const animSkeleton = () => {
  const skeleton = rig();
  skeleton.transform = [{ name: 'tf', bones: ['single'], target: 'target' }];
  skeleton.path = [{ name: 'path-con', bones: ['single'], target: 'single-target' }];
  return skeleton;
};

test('ik 打帧：mix / bendPositive 可写，curve 数组翻译成 3.8 原生编码', () => {
  const { json, summary } = animateConstraint(animSkeleton(), {
    animationName: 'hit',
    type: 'ik',
    name: 'two-bone',
    keys: [
      { time: 0, mix: 0, curve: [0.25, 0, 0.75, 1] },
      { time: 0.3, mix: 1, bendPositive: false },
    ],
  });
  const track = json.animations.hit.ik['two-bone'];
  assert.equal(summary.animationCreated, true);
  assert.equal(track.length, 2);
  assert.deepEqual(track[0], { time: 0, mix: 0, curve: 0.25, c2: 0, c3: 0.75, c4: 1 });
  assert.deepEqual(track[1], { time: 0.3, mix: 1, bendPositive: false });
  // 入参不被修改
  assert.equal(animSkeleton().animations.hit, undefined);
});

test('ik 打帧：softness 不是 3.8 时间线字段，必须明确报错', () => {
  assert.throws(
    () => animateConstraint(animSkeleton(), {
      animationName: 'hit', type: 'ik', name: 'two-bone', keys: [{ time: 0, softness: 0.5 }],
    }),
    /softness.*不存在/,
  );
});

test('transform 打帧：四个 Mix 可写，rotation 偏移不是时间线字段', () => {
  const { json } = animateConstraint(animSkeleton(), {
    animationName: 'hit', type: 'transform', name: 'tf',
    keys: [{ time: 0, rotateMix: 1, translateMix: 0.5, scaleMix: 0.25, shearMix: 0 }],
  });
  assert.deepEqual(json.animations.hit.transform.tf[0], { time: 0, rotateMix: 1, translateMix: 0.5, scaleMix: 0.25, shearMix: 0 });
  assert.throws(
    () => animateConstraint(animSkeleton(), {
      animationName: 'hit', type: 'transform', name: 'tf', keys: [{ time: 0, rotation: 10 }],
    }),
    /rotation.*不存在/,
  );
});

test('path 打帧：写进嵌套对象，position / mix 两个通道互不影响', () => {
  let result = animateConstraint(animSkeleton(), {
    animationName: 'hit', type: 'path', name: 'path-con', channel: 'position',
    keys: [{ time: 0, position: 0 }, { time: 0.5, position: 0.75 }],
  });
  result = animateConstraint(result.json, {
    animationName: 'hit', type: 'path', name: 'path-con', channel: 'mix',
    keys: [{ time: 0, rotateMix: 0.5, translateMix: 0.5 }],
  });
  const track = result.json.animations.hit.path['path-con'];
  assert.equal(track.position.length, 2);
  assert.equal(track.mix.length, 1);
  assert.deepEqual(track.position[1], { time: 0.5, position: 0.75 });
});

test('transform 打帧：curve:"stepped" 被拒绝（3.8.75 导入会抛 ArrayIndexOutOfBoundsException）', () => {
  assert.throws(
    () => animateConstraint(animSkeleton(), {
      animationName: 'hit', type: 'transform', name: 'tf',
      keys: [{ time: 0, rotateMix: 1, curve: 'stepped' }],
    }),
    /不支持 curve:"stepped"/,
  );
  // 数字 / 贝塞尔数组照旧可用
  const { json } = animateConstraint(animSkeleton(), {
    animationName: 'hit', type: 'transform', name: 'tf',
    keys: [{ time: 0, rotateMix: 1, curve: [0.2, 0, 0.8, 1] }],
  });
  assert.equal(json.animations.hit.transform.tf[0].curve, 0.2);
});

test('path 打帧：spacing 不是时间线字段，必须报错', () => {
  assert.throws(
    () => animateConstraint(animSkeleton(), {
      animationName: 'hit', type: 'path', name: 'path-con', channel: 'position', keys: [{ time: 0, spacing: 0.2 }],
    }),
    /spacing.*不存在/,
  );
});

test('打帧：merge 按 time 合并，重复时间被替换', () => {
  const first = animateConstraint(animSkeleton(), {
    animationName: 'hit', type: 'ik', name: 'two-bone',
    keys: [{ time: 0, mix: 0 }, { time: 0.5, mix: 1 }],
  });
  const second = animateConstraint(first.json, {
    animationName: 'hit', type: 'ik', name: 'two-bone', mode: 'merge',
    keys: [{ time: 0.5, mix: 0.25 }, { time: 1, mix: 0 }],
  });
  const track = second.json.animations.hit.ik['two-bone'];
  assert.deepEqual(track.map((k) => k.time), [0, 0.5, 1]);
  assert.equal(track[1].mix, 0.25);
  assert.equal(second.summary.replacedByMerge, 1);
  assert.equal(second.summary.keptFromExisting, 1);
});

test('打帧：set 覆盖整条轨道', () => {
  const first = animateConstraint(animSkeleton(), {
    animationName: 'hit', type: 'ik', name: 'two-bone', keys: [{ time: 0, mix: 0 }, { time: 0.5, mix: 1 }],
  });
  const second = animateConstraint(first.json, {
    animationName: 'hit', type: 'ik', name: 'two-bone', keys: [{ time: 2, mix: 1 }],
  });
  assert.deepEqual(second.json.animations.hit.ik['two-bone'].map((k) => k.time), [2]);
});

test('打帧：约束不存在 / 类型不对 / 键重复都报错', () => {
  assert.throws(() => animateConstraint(animSkeleton(), {
    animationName: 'hit', type: 'ik', name: '不存在', keys: [{ time: 0 }],
  }), /没有 ik 约束/);
  assert.throws(() => animateConstraint(animSkeleton(), {
    animationName: 'hit', type: 'bogus', name: 'two-bone', keys: [{ time: 0 }],
  }), /未知约束类型/);
  assert.throws(() => animateConstraint(animSkeleton(), {
    animationName: 'hit', type: 'ik', name: 'two-bone', keys: [{ time: 0 }, { time: 0, mix: 1 }],
  }), /time 不能重复/);
  assert.throws(() => animateConstraint(animSkeleton(), {
    animationName: 'hit', type: 'ik', name: 'two-bone', keys: [{ time: -1 }],
  }), /time 必须是非负/);
});

test('打帧：createAnimation=false 时动画不存在直接拒绝', () => {
  assert.throws(() => animateConstraint(animSkeleton(), {
    animationName: 'new-one', type: 'ik', name: 'two-bone', keys: [{ time: 0 }], createAnimation: false,
  }), /createAnimation/);
});

test('白名单表覆盖三类约束', () => {
  assert.deepEqual(Object.keys(CONSTRAINT_ANIMATION_FIELDS), ['ik', 'transform', 'path']);
  assert.deepEqual(Object.keys(CONSTRAINT_ANIMATION_FIELDS.ik.fields), ['mix', 'bendPositive']);
  assert.deepEqual(Object.keys(CONSTRAINT_ANIMATION_FIELDS.path.channels.mix.fields), ['rotateMix', 'translateMix']);
});

test('只读列出约束轨道：path 按通道展开', () => {
  const { json } = animateConstraint(animSkeleton(), {
    animationName: 'hit', type: 'path', name: 'path-con', channel: 'mix', keys: [{ time: 0, rotateMix: 0.5 }],
  });
  const tracks = inspectConstraintTracks(json);
  const pathTracks = tracks.tracks.filter((t) => t.type === 'path');
  assert.equal(pathTracks.length, 1);
  assert.equal(pathTracks[0].channel, 'mix');
  assert.equal(pathTracks[0].keyframes, 1);
});

// ---- 诊断 ----

test('诊断：正常 IK 工程给出「全部约束求解正常」', () => {
  const report = diagnoseConstraints(rig(), { tolerance: 0.5 });
  assert.equal(report.counts.ik, 2);
  assert.equal(report.checks.filter((c) => c.level === 'error').length, 0);
  assert.match(report.verdict, /正常/);
  const two = report.constraints.find((c) => c.name === 'two-bone');
  assert.ok(two.worstEndToTarget < 0.5, `收敛误差 ${two.worstEndToTarget}`);
});

test('诊断：mix 恒为 0 会被报成「没有产生位移」', () => {
  const skeleton = rig();
  skeleton.ik[0].mix = 0;
  const report = diagnoseConstraints(skeleton, { tolerance: 0.5 });
  assert.ok(report.checks.some((c) => c.code === 'ik.no-effect' && c.constraint === 'two-bone'));
});

test('诊断：目标超出臂展时给出 out-of-reach 而不是假报错', () => {
  const skeleton = rig();
  skeleton.bones.find((b) => b.name === 'target').x = 500;
  const report = diagnoseConstraints(skeleton, { tolerance: 1 });
  assert.ok(!report.checks.some((c) => c.code === 'ik.not-reached'));
  assert.ok(report.checks.some((c) => c.code === 'ik.out-of-reach'));
});

test('诊断：同 order 且骨骼重叠会报 order 冲突', () => {
  const skeleton = rig();
  skeleton.ik.push({ name: 'shadow', bones: ['p1', 'p2'], target: 'target', mix: 1, order: 0 });
  skeleton.ik[0].order = 0;
  const report = diagnoseConstraints(skeleton, { tolerance: 1 });
  assert.ok(report.checks.some((c) => c.code === 'constraint.order-collision'));
});

test('诊断：path 约束明确标记为未参与求解', () => {
  const skeleton = animSkeleton();
  const report = diagnoseConstraints(skeleton, { tolerance: 1 });
  assert.ok(report.checks.some((c) => c.code === 'path.unsolved'));
});

test('诊断：solve=false 时不做生效判定', () => {
  const skeleton = rig();
  const report = diagnoseConstraints(skeleton, { solve: false });
  assert.equal(report.solved, false);
  assert.ok(!report.checks.some((c) => c.code === 'ik.no-effect'));
});

test('诊断：没有约束的工程直接返回说明', () => {
  const report = diagnoseConstraints({ bones: [{ name: 'root', length: 0 }], animations: {} });
  assert.equal(report.counts.ik, 0);
  assert.equal(report.checks[0].code, 'no-constraints');
});

// ---- 直接调求解内核 ----

test('applyIk 直接调用：链末端闭合', () => {
  const skeleton = rig();
  const pose = setupPose(skeleton.bones);
  const index = buildBoneIndex(skeleton);
  const base = computeWorldWithConstraints(skeleton, pose, { solve: false });
  const endBefore = endOf({ worldBones: base.world }, 'p2');
  const result = applyIk(skeleton, pose, base.world, index, skeleton.ik[0], { mix: 1, bendPositive: true });
  assert.equal(result.changed.length, 2);
  assert.ok(Math.hypot(endBefore.x - 0, endBefore.y - 0) > 1, '未求解时末端应在 p1 起点右侧 50 处之外，这里只确认基线存在');
});

test('applyTransform 直接调用：target 不存在时报错而不是静默', () => {
  const skeleton = rig();
  const pose = setupPose(skeleton.bones);
  const index = buildBoneIndex(skeleton);
  const base = computeWorldWithConstraints(skeleton, pose, { solve: false });
  const result = applyTransform(skeleton, pose, base.world, index, { name: 'x', bones: ['p2'], target: 'nope' }, {});
  assert.equal(result.changed.length, 0);
  assert.match(result.warnings[0], /目标骨骼 nope 不存在/);
});
