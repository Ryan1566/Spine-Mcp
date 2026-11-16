// P16：约束求解诊断。回答「这条约束到底有没有生效、解得对不对」，
// 不依赖渲染，判据全部是几何量：IK 链末端到 target 的距离、mix 是否为 0、order 是否冲突。
import { evaluateScene, findAnimation, animationDuration } from './pose-eval.mjs';
import { constraintStats } from './constraints.mjs';

const round3 = (n) => Math.round(n * 1000) / 1000;

// 约束时间线能否打 mix 之类的字段（3.8 实测：ik 只有 mix/bendPositive；transform 只有四个 Mix；path 分通道）
const TIMELINE_FIELDS = {
  ik: ['mix', 'bendPositive'],
  transform: ['rotateMix', 'translateMix', 'scaleMix', 'shearMix'],
  path: ['position', 'rotateMix', 'translateMix'],
};

function chainReach(skeleton, world, index, names) {
  let total = 0;
  for (const name of names) {
    const i = index.indexByName.get(name);
    if (i == null) continue;
    const m = world[i];
    const scale = m ? Math.hypot(m.a, m.c) : 1;
    total += (skeleton.bones[i]?.length ?? 0) * scale;
  }
  return total;
}

function chainEndPoint(skeleton, world, index, names) {
  const last = names[names.length - 1];
  const i = index.indexByName.get(last);
  if (i == null) return null;
  const m = world[i];
  const length = skeleton.bones[i]?.length ?? 0;
  return { x: m.x + length * m.a, y: m.y + length * m.c };
}

// 采样时间点：给了动画就沿时间线均分，否则只取 setup
export function sampleTimes(skeleton, animationName, time, times) {
  if (Array.isArray(times) && times.length) {
    for (const t of times) {
      if (typeof t !== 'number' || !Number.isFinite(t) || t < 0) throw new Error('times 里必须是非负有限秒数');
    }
    return [...times].sort((a, b) => a - b);
  }
  if (time !== undefined && time !== null) {
    if (typeof time !== 'number' || !Number.isFinite(time) || time < 0) throw new Error('time 必须是非负有限秒数');
    return [time];
  }
  const animation = findAnimation(skeleton, animationName);
  if (!animation) return [0];
  const duration = animationDuration(animation);
  if (!(duration > 0)) return [0];
  const steps = 8;
  return Array.from({ length: steps + 1 }, (_, i) => round3((duration * i) / steps));
}

export function diagnoseConstraints(skeleton, options = {}) {
  const {
    animationName = null, time, times, skeletonLabel = 'skeleton', solve = true, tolerance = 1,
  } = options;

  const counts = constraintStats(skeleton);
  const samples = sampleTimes(skeleton, animationName, time, times);

  const checks = [];
  const add = (level, code, message, extra = {}) => checks.push({ level, code, message, ...extra });

  const total = counts.ik + counts.transform + counts.path;
  if (total === 0) {
    return {
      skeleton: skeletonLabel,
      animation: animationName,
      counts,
      sampledTimes: samples,
      constraints: [],
      checks: [{ level: 'info', code: 'no-constraints', message: '工程里没有任何约束（ik / transform / path）' }],
      verdict: '没有约束需要求解',
    };
  }

  // 每条约束跨采样点的聚合
  const perConstraint = new Map();
  const key = (type, name) => `${type}::${name}`;
  for (const type of ['ik', 'transform', 'path']) {
    for (const data of (skeleton[type] ?? [])) {
      perConstraint.set(key(type, data.name), {
        type,
        name: data.name,
        order: Number.isFinite(data.order) ? data.order : 0,
        bones: data.bones ?? [],
        target: data.target ?? null,
        solvedTimes: 0,
        movedBoneMax: 0,
        valuesSeen: [],
        worstDistance: 0,
        worstAxisOffset: 0,
        behindTarget: 0,
        reach: 0,
        outOfReachTimes: 0,
        fullMixTimes: 0,
        warnings: new Set(),
      });
    }
  }

  let anySolved = 0;
  for (const t of samples) {
    const scene = evaluateScene(skeleton, { animation: animationName, time: t, solveConstraints: solve });
    const index = scene.worldBones.reduce((acc, bone, i) => {
      acc.indexByName.set(bone.name, i);
      return acc;
    }, { indexByName: new Map() });

    for (const entry of scene.constraints.entries ?? []) {
      const rec = perConstraint.get(key(entry.type, entry.name));
      if (!rec) continue;
      if (entry.changedBones.length) rec.solvedTimes += 1;
      rec.movedBoneMax = Math.max(rec.movedBoneMax, entry.movedBones ?? 0);
      for (const w of entry.warnings ?? []) rec.warnings.add(w);
      if (entry.values && entry.values !== 'static' && !rec.valuesSeen.includes(JSON.stringify(entry.values))) {
        rec.valuesSeen.push(JSON.stringify(entry.values));
      }
      if (entry.type === 'ik' && solve) {
        // 只有 mix 全量时才要求「末端必须落在 target 上」：mix=0.5 时本来就该只走一半，
        // 拿全量标准去判会产生假错误。
        const timelineMix = entry.values && entry.values !== 'static' ? entry.values.mix : undefined;
        const definitionMix = skeleton.ik?.find((c) => c.name === entry.name)?.mix;
        const effectiveMix = typeof timelineMix === 'number' ? timelineMix : (typeof definitionMix === 'number' ? definitionMix : 1);
        if (effectiveMix < 0.999) continue; // 部分 mix 时末端本来就到不了 target，跳过闭合判定
        rec.fullMixTimes += 1;
        const targetIdx = index.indexByName.get(rec.target);
        if (targetIdx == null) continue;
        const target = scene.worldBones[targetIdx];
        const startIdx = index.indexByName.get(rec.bones[0]);
        const start = startIdx == null ? null : scene.worldBones[startIdx];
        if (!target || !start) continue;
        const need = Math.hypot(target.x - start.x, target.y - start.y);
        rec.reach = chainReach(skeleton, scene.worldBones, index, rec.bones);

        if (rec.bones.length === 1) {
          // 单骨 IK 只把**骨轴**转向 target，不要求末端落到 target 上（骨比距离长就会伸过头）。
          // 所以这里判的是「target 是否落在骨轴所在直线上、且在正方向」。
          const axisLength = Math.hypot(start.a, start.c);
          if (axisLength < 1e-9) continue;
          const ux = start.a / axisLength;
          const uy = start.c / axisLength;
          const vx = target.x - start.x;
          const vy = target.y - start.y;
          const along = vx * ux + vy * uy;
          const perp = Math.abs(vx * uy - vy * ux);
          if (along < 0) rec.behindTarget += 1;
          if (perp > rec.worstAxisOffset) rec.worstAxisOffset = perp;
          if (need > rec.reach * 0.999) rec.outOfReachTimes += 1;
          continue;
        }

        const endBone = rec.bones[rec.bones.length - 1];
        if (!endBone) continue;
        const end = chainEndPoint(skeleton, scene.worldBones, index, rec.bones);
        if (!end) continue;
        const dist = Math.hypot(end.x - target.x, end.y - target.y);
        if (need > rec.reach * 0.999) {
          rec.outOfReachTimes += 1;
        } else if (dist > rec.worstDistance) {
          rec.worstDistance = dist;
        }
      }
    }
    anySolved += scene.constraints.solved ?? 0;
  }

  // ---- 逐条判定 ----
  const constraints = [];
  for (const rec of perConstraint.values()) {
    const entry = {
      type: rec.type,
      name: rec.name,
      order: rec.order,
      bones: rec.bones,
      boneCount: rec.bones.length,
      target: rec.target,
      solvedTimes: rec.solvedTimes,
      sampledTimes: samples.length,
      movedBoneMax: rec.movedBoneMax,
      animatedFields: rec.valuesSeen.length ? [...new Set(rec.valuesSeen.flatMap((v) => Object.keys(JSON.parse(v))))] : [],
      timelineCanAnimate: TIMELINE_FIELDS[rec.type] ?? [],
    };
    if (rec.type === 'ik') {
      entry.reach = round3(rec.reach);
      if (rec.bones.length === 1) {
        entry.worstAxisOffset = round3(rec.worstAxisOffset);
        entry.behindTargetTimes = rec.behindTarget;
      } else {
        entry.worstEndToTarget = round3(rec.worstDistance);
      }
      entry.outOfReachTimes = rec.outOfReachTimes;
      entry.fullMixTimes = rec.fullMixTimes;
    }
    if (rec.warnings.size) entry.warnings = [...rec.warnings];
    constraints.push(entry);

    if (!solve) continue;
    if (rec.solvedTimes === 0) {
      add('warning', `${rec.type}.no-effect`, `${rec.type} 约束 ${rec.name} 在 ${samples.length} 个采样点上都没有产生位移（mix 可能为 0，或 order 让它在别的约束之后被覆盖）`, { constraint: rec.name, type: rec.type });
    }
    if (rec.type === 'ik') {
      if (rec.bones.length === 1) {
        // 单骨：判「target 是否落在骨轴上」
        if (rec.fullMixTimes > 0 && (rec.worstAxisOffset > tolerance || rec.behindTarget > 0) && rec.outOfReachTimes < samples.length) {
          add('error', 'ik.axis-off', `ik 约束 ${rec.name} 只有一根骨骼，骨轴偏离 target ${round3(rec.worstAxisOffset)} 单位${rec.behindTarget ? `，且有 ${rec.behindTarget} 个采样点 target 落在骨骼背后` : ''}（容差 ${tolerance}）`, { constraint: rec.name, axisOffset: round3(rec.worstAxisOffset) });
        }
      } else if (rec.fullMixTimes > 0 && rec.worstDistance > tolerance && rec.outOfReachTimes < samples.length) {
        add('error', 'ik.not-reached', `ik 约束 ${rec.name} 的链末端离 target 最远 ${round3(rec.worstDistance)} 单位（容差 ${tolerance}），目标在臂展内却解不到位`, { constraint: rec.name, distance: round3(rec.worstDistance) });
      }
      if (rec.bones.length === 1 && (rec.valuesSeen.some((v) => v.includes('bendPositive')) || skeleton.ik?.find((c) => c.name === rec.name)?.bendPositive !== undefined)) {
        add('info', 'ik.single-bone-bendPositive', `ik 约束 ${rec.name} 只有一根骨骼，bendPositive 在 3.8 里对单骨链无效（会被丢弃）`, { constraint: rec.name });
      }
      if (rec.fullMixTimes === 0 && rec.valuesSeen.length) {
        add('info', 'ik.mix-never-full', `ik 约束 ${rec.name} 的 mix 在所有采样点上都没到 1，链末端不会完全贴合 target（这是预期行为，不是求解错误）`, { constraint: rec.name });
      }
      if (rec.outOfReachTimes === samples.length) {
        add('warning', 'ik.out-of-reach', `ik 约束 ${rec.name} 的 target 在所有采样点上都超出臂展 ${round3(rec.reach)}，链会一直处于完全伸展`, { constraint: rec.name });
      }
    }
    if (rec.type === 'path') {
      add('warning', 'path.unsolved', `path 约束 ${rec.name} 未参与求解：当前采样引擎不构建 path 附件几何，挂在路径上的骨骼位置会与编辑器有偏差`, { constraint: rec.name });
    }
  }

  // order 冲突：同 order 且骨骼链有交集
  const byOrder = new Map();
  for (const rec of perConstraint.values()) {
    if (!rec.solvedTimes) continue;
    const list = byOrder.get(rec.order) ?? [];
    list.push(rec);
    byOrder.set(rec.order, list);
  }
  for (const [order, list] of byOrder) {
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const shared = list[i].bones.filter((b) => list[j].bones.includes(b));
        if (shared.length) {
          add('warning', 'constraint.order-collision', `order=${order} 上 ${list[i].name} 与 ${list[j].name} 影响同一批骨骼（${shared.join(', ')}），求解结果依赖定义顺序`, { order, constraints: [list[i].name, list[j].name], bones: shared });
        }
      }
    }
  }

  if (solve && anySolved === 0) {
    add('warning', 'constraint.all-idle', '所有约束在所有采样点上都没有位移，检查 mix 与 target');
  }

  const errors = checks.filter((c) => c.level === 'error').length;
  const warnings = checks.filter((c) => c.level === 'warning').length;
  return {
    skeleton: skeletonLabel,
    animation: animationName,
    sampledTimes: samples,
    counts,
    solved: solve,
    constraints,
    checks,
    verdict: errors ? `${errors} 个错误 ${warnings} 个告警` : (warnings ? `通过，${warnings} 个告警` : '全部约束求解正常'),
  };
}
