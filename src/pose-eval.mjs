// P15：骨架姿态求解 —— setup pose 或动画任意时刻 → 世界变换 → 面片顶点世界坐标。
//
// 纯 JSON 计算：不调用 CLI、不碰 GUI、不写文件。用途有两块：
//   1) 生成线框叠加图，肉眼验证 diff_animations / merge_animations / edit_animation 改得对不对；
//   2) 给 spine_align_check 提供可与渲染 PNG 对齐的几何量。
//
// 3.8 实测要点（数值语义已用真实渲染图交叉验证，见 tests/p15-pose.test.mjs）：
//   - 时间线存的是**相对 setup pose** 的量：rotate / translate / shear 相加，scale 相乘。
//     例：bone_arm_r_01 setup=180°，首帧 rotate.angle=-10.06 → 169.94°（手臂垂下），
//     若误按绝对值取 -10.06°，手臂会翻到另一侧。
//   - 关键帧曲线的四个贝塞尔控制点**不放在数组里**：curve 是 cx1，
//     另三个控制点在同级字段 c2 / c3 / c4（默认 0 / 1 / 1）。
//     这条与 SkeletonBinary 里的 4 个 float 是两套编码，别互相套用。
//   - curve 为字符串（"stepped"）表示该帧阶梯插值；attachment 时间线是离散切换，不走曲线。
//   - 世界变换：rotationY = rotation + 90 + shearY，
//     la = cos(rot+shearX)*scaleX，lb = cos(rotationY)*scaleY，
//     lc = sin(rot+shearX)*scaleX，ld = sin(rotationY)*scaleY。
//   - 加权 mesh 的 boneIndex 是**全局 bones[] 下标**（见 weight-ops.mjs）。
import { parseWeightedMesh } from './weight-ops.mjs';
import { skinEntries } from './mesh-inspect.mjs';

const DEG = Math.PI / 180;
const round4 = (n) => Math.round(n * 10000) / 10000;
const round6 = (n) => Math.round(n * 1000000) / 1000000;

// 3.8 骨骼 inherit 模式；只完整实现 normal，其余给告警后按 normal 算。
export const BONE_TRANSFORM_MODES = ['normal', 'onlyTranslation', 'noRotationOrReflection', 'noScale', 'noScaleOrReflection'];

// 三次贝塞尔：给定 x 求 y。控制点 (x1,y1)(x2,y2)，端点固定 (0,0)(1,1)。
function bezierEase(x1, y1, x2, y2, p) {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  const bx = (u) => {
    const v = 1 - u;
    return 3 * v * v * u * x1 + 3 * v * u * u * x2 + u * u * u;
  };
  const by = (u) => {
    const v = 1 - u;
    return 3 * v * v * u * y1 + 3 * v * u * u * y2 + u * u * u;
  };
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 30; i += 1) {
    const mid = (lo + hi) / 2;
    if (bx(mid) < p) lo = mid;
    else hi = mid;
  }
  return by((lo + hi) / 2);
}

// 取关键帧的缓动系数：阶梯 → 0；有贝塞尔控制点 → 解曲线；否则线性。
export function easedPercent(key, percent) {
  const p = Math.min(1, Math.max(0, percent));
  if (!key || typeof key !== 'object') return p;
  const curve = key.curve;
  if (curve === 'stepped') return 0;
  if (typeof curve === 'number' && Number.isFinite(curve)) {
    const c2 = Number.isFinite(key.c2) ? key.c2 : 0;
    const c3 = Number.isFinite(key.c3) ? key.c3 : 1;
    const c4 = Number.isFinite(key.c4) ? key.c4 : 1;
    return bezierEase(curve, c2, c3, c4, p);
  }
  // 兼容把四点写成数组的导出（4.x 风格），3.8 不会出现
  if (Array.isArray(curve) && curve.length >= 4) {
    return bezierEase(curve[0], curve[1], curve[2], curve[3], p);
  }
  return p;
}

// 在关键帧序列上采样。read(key) 把一帧读成数字数组，便于 rotate(1 个)/translate(2 个) 共用。
export function sampleTimeline(keys, time, read) {
  if (!Array.isArray(keys) || keys.length === 0) return null;
  const t0 = keys[0].time ?? 0;
  if (time <= t0) return read(keys[0]);
  const last = keys[keys.length - 1];
  const tLast = last.time ?? 0;
  if (time >= tLast) return read(last);
  let i = 0;
  while (i + 1 < keys.length && (keys[i + 1].time ?? 0) <= time) i += 1;
  const a = keys[i];
  const b = keys[i + 1];
  const ta = a.time ?? 0;
  const tb = b.time ?? 0;
  const span = tb - ta;
  const percent = span <= 0 ? 1 : (time - ta) / span;
  const e = easedPercent(a, percent);
  const va = read(a);
  const vb = read(b);
  return va.map((v, k) => v + ((vb[k] ?? v) - v) * e);
}

export function findAnimation(skeleton, animationName) {
  const animations = skeleton?.animations ?? {};
  if (animationName == null || animationName === '') return null;
  const anim = animations[animationName];
  if (!anim) {
    const names = Object.keys(animations);
    throw new Error(`动画不存在: ${animationName}；可用动画: ${names.length ? names.join(', ') : '(无)'}`);
  }
  return anim;
}

// 动画时长：所有时间线里最后一个 time 的最大值。
export function animationDuration(animation) {
  if (!animation) return 0;
  let max = 0;
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) {
        if (item && typeof item.time === 'number') max = Math.max(max, item.time);
        else walk(item);
      }
      return;
    }
    for (const value of Object.values(node)) walk(value);
  };
  walk(animation);
  return round6(max);
}

// setup pose：局部变换的基准值
export function setupPose(bones) {
  return (bones ?? []).map((b) => ({
    rotation: b.rotation ?? 0,
    x: b.x ?? 0,
    y: b.y ?? 0,
    scaleX: b.scaleX ?? 1,
    scaleY: b.scaleY ?? 1,
    shearX: b.shearX ?? 0,
    shearY: b.shearY ?? 0,
    inherit: b.transform ?? 'normal',
  }));
}

// 在 setup pose 上叠加动画时间线，得到该时刻的局部变换
export function poseAtTime(skeleton, animation, time) {
  const bones = skeleton?.bones ?? [];
  const pose = setupPose(bones);
  const indexByName = new Map(bones.map((b, i) => [b.name, i]));
  const warnings = [];
  const animated = { rotate: 0, translate: 0, scale: 0, shear: 0 };

  for (const [boneName, timelines] of Object.entries(animation?.bones ?? {})) {
    const index = indexByName.get(boneName);
    if (index == null) {
      warnings.push(`动画引用了不存在的骨骼 ${boneName}，已跳过`);
      continue;
    }
    const local = pose[index];
    if (Array.isArray(timelines.rotate)) {
      const v = sampleTimeline(timelines.rotate, time, (k) => [k.angle ?? 0]);
      if (v) {
        local.rotation += v[0];
        animated.rotate += 1;
      }
    }
    if (Array.isArray(timelines.translate)) {
      const v = sampleTimeline(timelines.translate, time, (k) => [k.x ?? 0, k.y ?? 0]);
      if (v) {
        local.x += v[0];
        local.y += v[1];
        animated.translate += 1;
      }
    }
    if (Array.isArray(timelines.scale)) {
      const v = sampleTimeline(timelines.scale, time, (k) => [k.x ?? 1, k.y ?? 1]);
      if (v) {
        local.scaleX *= v[0];
        local.scaleY *= v[1];
        animated.scale += 1;
      }
    }
    if (Array.isArray(timelines.shear)) {
      const v = sampleTimeline(timelines.shear, time, (k) => [k.x ?? 0, k.y ?? 0]);
      if (v) {
        local.shearX += v[0];
        local.shearY += v[1];
        animated.shear += 1;
      }
    }
  }
  return { pose, warnings, animated };
}

// 世界变换：按 bones[] 顺序累乘父级（父级必须排在子级之前，Spine 保证了这点）
export function computeWorldBones(skeleton, pose) {
  const bones = skeleton?.bones ?? [];
  const indexByName = new Map(bones.map((b, i) => [b.name, i]));
  const world = new Array(bones.length);
  const problems = [];
  const visiting = new Set();

  const resolve = (i) => {
    if (world[i]) return world[i];
    const data = bones[i];
    if (visiting.has(i)) {
      problems.push(`骨骼 ${data.name} 的父级链成环`);
      return null;
    }
    visiting.add(i);
    const local = pose?.[i] ?? setupPose([data])[0];
    const rotationY = local.rotation + 90 + local.shearY;
    const la = Math.cos((local.rotation + local.shearX) * DEG) * local.scaleX;
    const lb = Math.cos(rotationY * DEG) * local.scaleY;
    const lc = Math.sin((local.rotation + local.shearX) * DEG) * local.scaleX;
    const ld = Math.sin(rotationY * DEG) * local.scaleY;

    let parent = null;
    if (data.parent != null) {
      // 3.8 JSON 里 parent 是骨骼名字符串，不是下标
      const pi = typeof data.parent === 'number' ? data.parent : indexByName.get(data.parent);
      if (pi == null || pi < 0 || pi >= bones.length) {
        problems.push(`骨骼 ${data.name} 的父级 ${JSON.stringify(data.parent)} 不存在`);
      } else if (pi === i) {
        problems.push(`骨骼 ${data.name} 的父级指向自己`);
      } else {
        parent = resolve(pi);
      }
    }

    if (local.inherit !== 'normal') {
      problems.push(`骨骼 ${data.name} 的 inherit=${local.inherit}，当前按 normal 计算（可能偏移）`);
    }

    const m = parent
      ? {
        a: parent.a * la + parent.b * lc,
        b: parent.a * lb + parent.b * ld,
        c: parent.c * la + parent.d * lc,
        d: parent.c * lb + parent.d * ld,
        x: parent.x + local.x * parent.a + local.y * parent.b,
        y: parent.y + local.x * parent.c + local.y * parent.d,
      }
      : { a: la, b: lb, c: lc, d: ld, x: local.x, y: local.y };

    const out = {
      name: data.name,
      index: i,
      parent: parent ? parent.index : null,
      parentName: parent ? parent.name : null,
      length: data.length ?? 0,
      a: round6(m.a),
      b: round6(m.b),
      c: round6(m.c),
      d: round6(m.d),
      x: round6(m.x),
      y: round6(m.y),
      local: {
        rotation: round4(local.rotation),
        x: round4(local.x),
        y: round4(local.y),
        scaleX: round4(local.scaleX),
        scaleY: round4(local.scaleY),
        shearX: round4(local.shearX),
        shearY: round4(local.shearY),
      },
    };
    visiting.delete(i);
    world[i] = out;
    return out;
  };

  for (let i = 0; i < bones.length; i += 1) resolve(i);
  return { world, problems };
}

// 骨骼末端世界坐标（沿本地 +x 走 length）
export function boneEnd(bone) {
  return { x: bone.x + bone.length * bone.a, y: bone.y + bone.length * bone.c };
}

// region 附件的可见四边形：复刻 RegionAttachment.updateOffset()。
// region 的 width/height 是**未裁剪帧**尺寸，atlas 的 size/offset 才是可见部分，
// 直接按 width×height 画会把包围盒撑大（武器 128×128 实际只露出 42×6）。
export function regionQuad(attachment, meta) {
  const scaleX = attachment.scaleX ?? 1;
  const scaleY = attachment.scaleY ?? 1;
  const width = attachment.width ?? meta?.orig?.[0] ?? 0;
  const height = attachment.height ?? meta?.orig?.[1] ?? 0;
  if (!meta) return { x1: -width / 2, y1: -height / 2, x2: width / 2, y2: height / 2, trimmed: false };
  const origW = meta.orig?.[0] || width;
  const origH = meta.orig?.[1] || height;
  const sizeW = meta.size?.[0] ?? origW;
  const sizeH = meta.size?.[1] ?? origH;
  const regionScaleX = (width / origW) * scaleX;
  const regionScaleY = (height / origH) * scaleY;
  const x1 = (-width / 2) * scaleX + (meta.offset?.[0] ?? 0) * regionScaleX;
  const y1 = (-height / 2) * scaleY + (meta.offset?.[1] ?? 0) * regionScaleY;
  return {
    x1,
    y1,
    x2: x1 + sizeW * regionScaleX,
    y2: y1 + sizeH * regionScaleY,
    trimmed: sizeW !== origW || sizeH !== origH,
  };
}

function atlasEntry(atlas, key) {
  if (!atlas) return null;
  if (atlas instanceof Map) return atlas.get(key) ?? null;
  return atlas[key] ?? null;
}

// 把 asset-audit 的 inspectAtlas() 结果转成 regionQuad 需要的索引（复用已测过的解析器）
export function atlasFromReport(report) {
  const map = new Map();
  for (const page of report?.pages ?? []) {
    for (const region of page.regions ?? []) {
      map.set(region.name, {
        size: [region.width, region.height],
        orig: [region.originalWidth, region.originalHeight],
        offset: [region.offsetX, region.offsetY],
        rotate: region.rotate,
      });
    }
  }
  return map;
}

// slot 在当前时刻挂的附件名（attachment 时间线是离散切换）
function resolveSlotAttachment(slot, animation, time) {
  const keys = animation?.slots?.[slot.name]?.attachment;
  const setupName = slot.attachment ?? null;
  if (!Array.isArray(keys) || keys.length === 0) return { name: setupName, switched: false };
  const first = keys[0];
  if (time < (first.time ?? 0)) return { name: setupName, switched: false };
  let chosen = first;
  for (const key of keys) if ((key.time ?? 0) <= time) chosen = key;
  return { name: chosen.name ?? null, switched: true };
}

// 主入口：求解某一时刻的完整场景
export function evaluateScene(skeleton, options = {}) {
  const {
    animation: animationName = null,
    time = 0,
    skin: skinName = null,
    atlas = null,
    includeRegions = true,
  } = options;
  if (!skeleton || !Array.isArray(skeleton.bones)) throw new Error('skeleton JSON 缺少 bones 数组');
  if (typeof time !== 'number' || !Number.isFinite(time) || time < 0) throw new Error('time 必须是非负有限秒数');

  const animation = findAnimation(skeleton, animationName);
  const duration = animationDuration(animation);
  const warnings = [];

  const { pose, warnings: poseWarnings, animated } = animation
    ? poseAtTime(skeleton, animation, time)
    : { pose: setupPose(skeleton.bones), warnings: [], animated: null };
  warnings.push(...poseWarnings);

  if (animation && duration > 0 && time > duration) {
    warnings.push(`time=${time}s 超出动画时长 ${duration}s，已按最后一帧静止延续`);
  }

  const { world, problems } = computeWorldBones(skeleton, pose);
  warnings.push(...problems);

  const boneIndexByName = new Map(skeleton.bones.map((b, i) => [b.name, i]));
  const slots = skeleton.slots ?? [];
  const slotByName = new Map(slots.map((s) => [s.name, s]));

  // 皮肤选择：默认 default；3.8 的 skins 是数组
  const allSkins = skinEntries(skeleton);
  const wanted = skinName ?? 'default';
  const chosenSkins = allSkins.filter(([name]) => name === wanted);
  const usedSkins = chosenSkins.length ? chosenSkins : allSkins.filter(([name]) => name === 'default');
  if (skinName && chosenSkins.length === 0) {
    warnings.push(`找不到皮肤 ${skinName}；现有皮肤: ${allSkins.map(([n]) => n).join(', ') || '(无)'}`);
  }
  if (usedSkins.length === 0) warnings.push('工程里没有可用皮肤，面片与附件都取不到');

  // 当前附件：先按 attachment 时间线定每个 slot 挂什么，再取皮肤里的附件数据
  const slotAttachment = new Map();
  for (const slot of slots) slotAttachment.set(slot.name, resolveSlotAttachment(slot, animation, time));

  const meshes = [];
  const regions = [];
  const unresolved = [];
  let vertexCount = 0;
  let triangleCount = 0;

  for (const [skinLabel, attachments] of usedSkins) {
    if (!attachments || typeof attachments !== 'object') continue;
    for (const [slotLabel, items] of Object.entries(attachments)) {
      if (!items || typeof items !== 'object') continue;
      const slot = slotByName.get(slotLabel);
      if (!slot) {
        unresolved.push(`皮肤 ${skinLabel} 的插槽 ${slotLabel} 不在 slots 里`);
        continue;
      }
      const current = slotAttachment.get(slotLabel);
      // 不能就地 delete 源 JSON；用名字白名单控制这一帧实际挂哪个附件。
      // 关键：一个 slot 里常放多个备选附件（睁眼/闭眼），只有被选中的那个能画出来。
      if (current && current.switched && (current.name == null || current.name === '')) {
        continue; // 动画把该 slot 清空了
      }
      const target = current && current.name != null && current.name !== ''
        ? current.name
        : (slot.attachment ?? null);
      let names;
      if (target == null || target === '') {
        // slot 没声明默认附件，也没有时间线：只能把该 slot 的附件都画出来
        names = Object.keys(items);
      } else if (Object.prototype.hasOwnProperty.call(items, target)) {
        names = [target];
      } else {
        unresolved.push(`插槽 ${slotLabel} 当前挂的是 ${target}，但皮肤 ${skinLabel} 里没有这个附件`);
        continue;
      }

      const boneIndex = boneIndexByName.get(slot.bone);
      if (boneIndex == null) {
        unresolved.push(`插槽 ${slotLabel} 引用的骨骼 ${slot.bone} 不存在`);
        continue;
      }
      const bone = world[boneIndex];

      for (const name of names) {
        const att = items[name];
        if (!att || typeof att !== 'object') continue;
        const type = att.type ?? 'region';

        if (type === 'region') {
          if (!includeRegions) continue;
          const rad = (att.rotation ?? 0) * DEG;
          const cos = Math.cos(rad);
          const sin = Math.sin(rad);
          const toWorld = (lx, ly) => {
            const rx = lx * cos - ly * sin + (att.x ?? 0);
            const ry = lx * sin + ly * cos + (att.y ?? 0);
            return { x: round4(bone.x + rx * bone.a + ry * bone.b), y: round4(bone.y + rx * bone.c + ry * bone.d) };
          };
          const meta = atlasEntry(atlas, att.path ?? name);
          const q = regionQuad(att, meta);
          const halfW = ((att.width ?? 0) * (att.scaleX ?? 1)) / 2;
          const halfH = ((att.height ?? 0) * (att.scaleY ?? 1)) / 2;
          regions.push({
            skin: skinLabel,
            slot: slotLabel,
            name,
            bone: slot.bone,
            corners: [toWorld(q.x1, q.y1), toWorld(q.x2, q.y1), toWorld(q.x2, q.y2), toWorld(q.x1, q.y2)],
            frame: [toWorld(-halfW, -halfH), toWorld(halfW, -halfH), toWorld(halfW, halfH), toWorld(-halfW, halfH)],
            width: att.width ?? null,
            height: att.height ?? null,
            trimmed: q.trimmed,
            atlasSize: meta?.size ?? null,
            atlasOrig: meta?.orig ?? null,
          });
          continue;
        }

        if (type === 'mesh') {
          const uvs = Array.isArray(att.uvs) ? att.uvs : [];
          const count = Math.floor(uvs.length / 2);
          const weighted = parseWeightedMesh(att);
          const points = [];
          if (weighted) {
            for (let v = 0; v < count; v += 1) {
              let wx = 0;
              let wy = 0;
              for (const f of weighted.vertices[v] ?? []) {
                const m = world[f.boneIndex];
                if (!m) {
                  unresolved.push(`面片 ${slotLabel}/${name} 顶点 ${v} 引用了不存在的骨骼下标 ${f.boneIndex}`);
                  continue;
                }
                wx += f.weight * (m.x + f.x * m.a + f.y * m.b);
                wy += f.weight * (m.y + f.x * m.c + f.y * m.d);
              }
              points.push({ x: round4(wx), y: round4(wy) });
            }
          } else {
            const raw = Array.isArray(att.vertices) ? att.vertices : [];
            for (let v = 0; v < count; v += 1) {
              const lx = raw[v * 2] ?? 0;
              const ly = raw[v * 2 + 1] ?? 0;
              points.push({
                x: round4(bone.x + lx * bone.a + ly * bone.b),
                y: round4(bone.y + lx * bone.c + ly * bone.d),
              });
            }
          }
          const triangles = Array.isArray(att.triangles) ? att.triangles : [];
          vertexCount += count;
          triangleCount += Math.floor(triangles.length / 3);
          meshes.push({ skin: skinLabel, slot: slotLabel, name, bone: slot.bone, weighted: weighted != null, points, triangles });
          continue;
        }

        // path / boundingbox / point / clipping 等不参与线框
      }
    }
  }

  const allPoints = [];
  for (const m of meshes) allPoints.push(...m.points);
  for (const r of regions) allPoints.push(...r.corners);
  const bounds = allPoints.length
    ? {
      minX: round4(Math.min(...allPoints.map((p) => p.x))),
      minY: round4(Math.min(...allPoints.map((p) => p.y))),
      maxX: round4(Math.max(...allPoints.map((p) => p.x))),
      maxY: round4(Math.max(...allPoints.map((p) => p.y))),
    }
    : { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  bounds.width = round4(bounds.maxX - bounds.minX);
  bounds.height = round4(bounds.maxY - bounds.minY);

  if (unresolved.length) warnings.push(...[...new Set(unresolved)].slice(0, 20));

  const deformTimelines = animation?.deform ? Object.keys(animation.deform).length : 0;
  const drawOrderTimelines = Array.isArray(animation?.drawOrder) ? animation.drawOrder.length : 0;
  if (deformTimelines) warnings.push(`动画含 ${deformTimelines} 组 deform 时间线，当前**未参与**顶点位移计算（线框会与渲染有偏差）`);
  if (drawOrderTimelines) warnings.push(`动画含 drawOrder 时间线（只影响绘制顺序，不影响几何）`);

  return {
    pose: animation ? 'animation' : 'setup',
    animation: animationName ?? null,
    time: round6(time),
    duration: animation ? duration : null,
    skin: usedSkins.length === 1 ? usedSkins[0][0] : usedSkins.map(([n]) => n),
    applied: animation ? animated : null,
    worldBones: world,
    meshes,
    regions,
    bounds,
    stats: {
      bones: world.length,
      animatedBones: Object.keys(animation?.bones ?? {}).length,
      meshes: meshes.length,
      regions: regions.length,
      vertices: vertexCount,
      triangles: triangleCount,
      weightedMeshes: meshes.filter((m) => m.weighted).length,
      skinnedSlots: slots.length,
    },
    warnings: [...new Set(warnings)],
  };
}

// 便捷：列出动画名与时长，供工具层回报
export function listAnimations(skeleton) {
  return Object.entries(skeleton?.animations ?? {}).map(([name, anim]) => ({
    name,
    duration: animationDuration(anim),
    bones: Object.keys(anim?.bones ?? {}).length,
    slots: Object.keys(anim?.slots ?? {}).length,
    deformSkins: Object.keys(anim?.deform ?? {}).length,
    events: Array.isArray(anim?.events) ? anim.events.length : 0,
  }));
}
