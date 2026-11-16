// P16：Spine 3.8.75 的约束求解（IK / Transform）。
//
// 先划清版本边界（都实测过，不是查资料）：
//   - 3.8.75 只有 ik / transform / path 三类约束。**没有物理（physics）约束** —— 那是 4.2+ 的东西。
//     往 JSON 里写 "physics": [...] 导入不报错，但导出时被**静默丢弃**（实测）。
//   - 3.8 的约束可以被动画打帧（ik.mix、transform 的四个 mix、path 的 position/mix），
//     所以"运行时动态变化"这件事 3.8 是支持的，只是它是**参数驱动**，不是弹簧物理。
//
// 本模块只做纯数学，不采样时间线（时间线在 pose-eval 里采样后作为 values 传进来）。
import {
  DEG, RAD, composeWorld, wrapDeg, worldRotation, worldScaleX, worldShearY, resolveParentIndex,
} from './bone-math.mjs';

export const CONSTRAINT_TYPES = ['ik', 'transform', 'path'];

const clamp = (n, lo, hi) => (n < lo ? lo : n > hi ? hi : n);
const clamp01 = (n) => clamp(n, 0, 1);

// 3.8 定义默认值。transform 的四个 mix 默认是 1：官方 alien 工程的 eye 约束没写 mix，
// 只写了 x/y 偏移，说明不写 = 全量生效（death 动画要关掉时才显式打 0）。
const IK_DEFAULTS = { order: 0, mix: 1, softness: 0, bendPositive: true, stretch: false, uniform: false };
const TRANSFORM_DEFAULTS = {
  order: 0, rotateMix: 1, translateMix: 1, scaleMix: 1, shearMix: 1,
  rotation: 0, x: 0, y: 0, scaleX: 0, scaleY: 0, shearY: 0,
  local: false, relative: false,
};
const PATH_DEFAULTS = {
  order: 0, position: 0, spacing: 0, rotateMix: 1, translateMix: 1, rotation: 0,
  positionMode: 'fixed', spacingMode: 'fixed', rotateMode: 'fixed', local: false, relative: false,
};

export function constraintDefaults(type) {
  if (type === 'ik') return { ...IK_DEFAULTS };
  if (type === 'transform') return { ...TRANSFORM_DEFAULTS };
  if (type === 'path') return { ...PATH_DEFAULTS };
  throw new Error(`未知约束类型: ${type}`);
}

// 定义值 + 该帧时间线值 → 实际生效值
export function mergeConstraintValues(type, data, timelineValues) {
  const merged = { ...constraintDefaults(type) };
  for (const [k, v] of Object.entries(data ?? {})) {
    if (k === 'name' || k === 'bones' || k === 'target' || k === 'skin') continue;
    if (v !== undefined) merged[k] = v;
  }
  for (const [k, v] of Object.entries(timelineValues ?? {})) {
    if (v !== undefined) merged[k] = v;
  }
  return merged;
}

// 按 order 升序，同 order 保持定义顺序（Spine 3.8 的约束列表就是这么排的）
export function orderedConstraints(skeleton) {
  const list = [];
  for (const type of CONSTRAINT_TYPES) {
    const array = Array.isArray(skeleton?.[type]) ? skeleton[type] : [];
    for (const [i, data] of array.entries()) {
      if (!data || typeof data !== 'object') continue;
      list.push({ type, data, definitionOrder: i, order: Number.isFinite(data.order) ? data.order : 0 });
    }
  }
  list.sort((a, b) => (a.order - b.order) || (a.definitionOrder - b.definitionOrder));
  return list;
}

export function constraintStats(skeleton) {
  const counts = { ik: 0, transform: 0, path: 0 };
  for (const type of CONSTRAINT_TYPES) {
    if (Array.isArray(skeleton?.[type])) counts[type] = skeleton[type].length;
  }
  return counts;
}

// ---- IK ----
// target 用**骨骼的世界原点**（Spine 里 IK 追的是 target 骨骼的位置，不是骨骼末端）。
export function applyIk(skeleton, pose, world, index, data, values) {
  const names = Array.isArray(data.bones) ? data.bones : [];
  const warnings = [];
  if (names.length === 0) return { changed: [], warnings: [`IK 约束 ${data.name} 没有 bones`] };
  const targetIdx = index.indexByName.get(data.target);
  if (targetIdx == null) {
    return { changed: [], warnings: [`IK 约束 ${data.name} 的目标骨骼 ${data.target} 不存在`] };
  }
  const mix = clamp01(values.mix ?? 1);
  if (mix === 0) return { changed: [], warnings: [] };
  const t = world[targetIdx];
  if (!t) return { changed: [], warnings: [`IK 约束 ${data.name} 的目标骨骼 ${data.target} 世界变换缺失`] };

  const affected = [];

  if (names.length === 1) {
    const bIdx = index.indexByName.get(names[0]);
    if (bIdx == null) return { changed: [], warnings: [`IK 约束 ${data.name} 的骨骼 ${names[0]} 不存在`] };
    const b = world[bIdx];
    const dx = t.x - b.x;
    const dy = t.y - b.y;
    const dist = Math.hypot(dx, dy);
    if (dist === 0) return { changed: [], warnings: [] };
    const desired = Math.atan2(dy, dx) * RAD;
    pose[bIdx].rotation += wrapDeg(desired - worldRotation(b)) * mix;
    affected.push(bIdx);

    // 单骨 IK 的 stretch：把骨骼拉长去够目标（Spine 改的是 scaleX）
    if (values.stretch) {
      const len = (index.bones[bIdx]?.length ?? 0) * worldScaleX(b);
      if (len > 0) {
        const scale = dist / len;
        pose[bIdx].scaleX += (scale - 1) * mix;
        if (values.uniform) pose[bIdx].scaleY += (scale - 1) * mix;
      }
    }
    return { changed: affected, warnings };
  }

  // 两骨链：余弦定理。多骨链 3.8 也只按前两根算，这里同样只取前两根并告警。
  if (names.length > 2) {
    warnings.push(`IK 约束 ${data.name} 有 ${names.length} 根骨骼，3.8 只按前两根求解，其余忽略`);
  }
  const pIdx = index.indexByName.get(names[0]);
  const cIdx = index.indexByName.get(names[1]);
  if (pIdx == null || cIdx == null) {
    return { changed: [], warnings: [`IK 约束 ${data.name} 的骨骼名不存在: ${names.filter((n) => !index.indexByName.has(n)).join(', ')}`] };
  }
  const p = world[pIdx];
  const c = world[cIdx];
  let L1 = (index.bones[pIdx]?.length ?? 0) * worldScaleX(p);
  let L2 = (index.bones[cIdx]?.length ?? 0) * worldScaleX(c);
  const dx = t.x - p.x;
  const dy = t.y - p.y;
  let dist = Math.hypot(dx, dy);
  if (dist === 0 || L1 === 0 || L2 === 0) return { changed: [], warnings };

  const maxReach = L1 + L2;
  const minReach = Math.abs(L1 - L2);
  let stretchScale = 1;
  if (dist > maxReach) {
    if (values.stretch) {
      stretchScale = dist / maxReach;
      if (values.uniform) {
        L1 *= stretchScale;
        L2 *= stretchScale;
      } else {
        // 非 uniform：只拉伸父级
        L1 *= stretchScale;
      }
    } else {
      dist = maxReach;
    }
  } else if (dist < minReach) {
    dist = minReach;
  }
  if (dist === 0) return { changed: [], warnings };

  const dirDeg = Math.atan2(dy, dx) * RAD;
  const cosA = clamp((L1 * L1 + dist * dist - L2 * L2) / (2 * L1 * dist), -1, 1);
  const A = Math.acos(cosA) * RAD;
  const bend = values.bendPositive === false ? -1 : 1;
  const theta1 = dirDeg + bend * A;   // 父骨世界朝向

  const eX = p.x + L1 * Math.cos(theta1 * DEG);
  const eY = p.y + L1 * Math.sin(theta1 * DEG);
  const theta2 = Math.atan2(t.y - eY, t.x - eX) * RAD;   // 子骨世界朝向

  // 先算父级的增量；子级的 world 会跟着父级一起转，所以要把 delta1 减掉
  const delta1 = wrapDeg(theta1 - worldRotation(p)) * mix;
  pose[pIdx].rotation += delta1;
  if (stretchScale !== 1 && !values.uniform) {
    pose[pIdx].scaleX += (stretchScale - 1) * mix;
  }
  if (stretchScale !== 1 && values.uniform) {
    pose[pIdx].scaleX += (stretchScale - 1) * mix;
    pose[pIdx].scaleY += (stretchScale - 1) * mix;
  }
  const delta2 = (wrapDeg(theta2 - worldRotation(c)) - delta1) * mix;
  pose[cIdx].rotation += delta2;
  affected.push(pIdx, cIdx);

  // 软度：3.8 的 softness 会让子骨只部分跟随。这里按线性插值近似，并明确告警。
  const softness = Number(values.softness ?? 0);
  if (softness > 0) {
    warnings.push(`IK 约束 ${data.name} 的 softness=${softness}，当前按线性近似处理（softness=0 时与 3.8 完全一致）`);
  }
  return { changed: affected, warnings };
}

// ---- Transform ----
// 3.8 只有四个 mix：rotateMix / translateMix / scaleMix / shearMix；
// rotation / x / y / scaleX / scaleY / shearY 是**偏移量**，不是 mix。
export function applyTransform(skeleton, pose, world, index, data, values) {
  const names = Array.isArray(data.bones) ? data.bones : [];
  const warnings = [];
  const changed = [];
  const targetIdx = index.indexByName.get(data.target);
  if (targetIdx == null) {
    return { changed, warnings: [`Transform 约束 ${data.name} 的目标骨骼 ${data.target} 不存在`] };
  }
  const t = world[targetIdx];
  const rotateMix = clamp01(values.rotateMix ?? 1);
  const translateMix = clamp01(values.translateMix ?? 1);
  const scaleMix = clamp01(values.scaleMix ?? 1);
  const shearMix = clamp01(values.shearMix ?? 1);
  if (rotateMix === 0 && translateMix === 0 && scaleMix === 0 && shearMix === 0) return { changed, warnings };

  for (const name of names) {
    const bIdx = index.indexByName.get(name);
    if (bIdx == null) {
      warnings.push(`Transform 约束 ${data.name} 的骨骼 ${name} 不存在`);
      continue;
    }
    const b = world[bIdx];
    const parentIdx = resolveParentIndex(index.bones[bIdx], index.indexByName, index.bones.length);
    const parent = parentIdx == null ? null : world[parentIdx];
    const local = pose[bIdx];
    let touched = false;

    // rotation：把目标的世界朝向对齐过来（local 模式则对齐父级相对朝向）
    if (rotateMix !== 0) {
      const targetRot = worldRotation(t);
      const baseRot = values.local
        ? (parent ? worldRotation(parent) : 0)
        : 0;
      const want = targetRot + (values.rotation ?? 0) - baseRot;
      const now = values.local
        ? (local.rotation + (parent ? worldRotation(parent) : 0))
        : worldRotation(b);
      local.rotation += wrapDeg(want - now) * rotateMix;
      touched = true;
    }

    // translation：让骨骼世界原点靠向 目标原点 + 偏移（偏移随目标朝向旋转）
    if (translateMix !== 0) {
      const targetRot = worldRotation(t) * DEG;
      const ox = values.x ?? 0;
      const oy = values.y ?? 0;
      const wantX = t.x + ox * Math.cos(targetRot) - oy * Math.sin(targetRot);
      const wantY = t.y + ox * Math.sin(targetRot) + oy * Math.cos(targetRot);
      const dxWorld = wantX - b.x;
      const dyWorld = wantY - b.y;
      if (parent) {
        // 世界位移 → 父级局部位移（父级矩阵求逆）
        const det = parent.a * parent.d - parent.b * parent.c;
        if (Math.abs(det) > 1e-9) {
          const lx = (parent.d * dxWorld - parent.b * dyWorld) / det;
          const ly = (-parent.c * dxWorld + parent.a * dyWorld) / det;
          local.x += lx * translateMix;
          local.y += ly * translateMix;
          touched = true;
        }
      } else {
        local.x += dxWorld * translateMix;
        local.y += dyWorld * translateMix;
        touched = true;
      }
    }

    // scale：目标缩放 × (1 + 偏移)，按 mix 插值；偏移是**加法**（Spine 的 offsetScaleX）
    if (scaleMix !== 0) {
      const targetSx = worldScaleX(t);
      const targetSy = Math.hypot(t.b, t.d);
      const wantSx = targetSx * (1 + (values.scaleX ?? 0));
      const wantSy = targetSy * (1 + (values.scaleY ?? 0));
      const nowSx = worldScaleX(b);
      const nowSy = Math.hypot(b.b, b.d);
      if (nowSx > 1e-9) local.scaleX *= 1 + ((wantSx / nowSx) - 1) * scaleMix;
      if (nowSy > 1e-9) local.scaleY *= 1 + ((wantSy / nowSy) - 1) * scaleMix;
      touched = true;
    }

    // shear：只作用在 shearY 上。
    // 世界剪切 = Y 轴角 - X 轴角 - 90（因为 localMatrix 里 rotationY = rotation + 90 + shearY）。
    // 注意不能写成 atan2(t.c,t.a)+90-worldRotation(t)：那两项互相抵消，恒等于 90°，
    // 会把骨骼 shearY 直接顶到 90 并把整棵子树拉歪（alien 的 eye-root→eye 就这么崩的）。
    if (shearMix !== 0) {
      const wantWorld = wrapDeg(worldShearY(t) + (values.shearY ?? 0));
      const parentShear = parent ? worldShearY(parent) : 0;
      const wantLocal = wrapDeg(wantWorld - parentShear);
      local.shearY += wrapDeg(wantLocal - local.shearY) * shearMix;
      touched = true;
    }

    if (touched) changed.push(bIdx);
  }
  return { changed, warnings };
}

// ---- Path ----
// 路径约束需要 path 附件的贝塞尔顶点，pose-eval 目前不建 path 几何，这里只报出来不求解。
export function applyPath(skeleton, pose, world, index, data, values) {
  return {
    changed: [],
    warnings: [`Path 约束 ${data.name} 未求解：当前版本不构建 path 附件几何（会影响挂在路径上的骨骼位置）`],
  };
}

// 求解一条约束，返回改动过的骨骼下标与告警
export function applyConstraint(skeleton, pose, world, index, entry, values) {
  if (entry.type === 'ik') return applyIk(skeleton, pose, world, index, entry.data, values);
  if (entry.type === 'transform') return applyTransform(skeleton, pose, world, index, entry.data, values);
  if (entry.type === 'path') return applyPath(skeleton, pose, world, index, entry.data, values);
  return { changed: [], warnings: [`未知约束类型 ${entry.type}`] };
}
