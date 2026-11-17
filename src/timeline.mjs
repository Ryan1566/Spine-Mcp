// 帧规格 -> Spine 3.8 JSON 时间轴。
// Spine 的时间轴单位是「秒」，不是帧；第 N 帧（1-based）的时间是 (N-1)/fps。

export const DEFAULT_FPS = 12;
const PRECISION = 1e6;

export function round6(n) {
  return Math.round(n * PRECISION) / PRECISION;
}

function assertPositiveInt(value, label) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} 必须是正整数，收到 ${JSON.stringify(value)}`);
  }
}

function assertFrameRange(frame, frames, label) {
  assertPositiveInt(frame, label);
  if (frame > frames) {
    throw new Error(`${label}=${frame} 超出总帧数 ${frames}`);
  }
}

function asNumber(value, fallback, label) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} 必须是有限数字，收到 ${JSON.stringify(value)}`);
  }
  return value;
}

export function frameToTime(frame, fps = DEFAULT_FPS) {
  assertPositiveInt(frame, 'frame');
  assertPositiveInt(fps, 'fps');
  return round6((frame - 1) / fps);
}

export function durationSeconds(frames, fps = DEFAULT_FPS) {
  assertPositiveInt(frames, 'frames');
  assertPositiveInt(fps, 'fps');
  return round6(frames / fps);
}

// 给策划看的帧/秒对照表：把上一轮定的「8 帧普攻、F3 命中」直接换算成 Spine 秒数。
export function frameTable(frames, fps = DEFAULT_FPS, eventFrames = []) {
  assertPositiveInt(frames, 'frames');
  assertPositiveInt(fps, 'fps');
  const byFrame = new Map();
  for (const ev of eventFrames ?? []) {
    assertFrameRange(ev?.frame, frames, 'eventFrames.frame');
    const list = byFrame.get(ev.frame) ?? [];
    list.push(String(ev.name ?? 'event'));
    byFrame.set(ev.frame, list);
  }
  const rows = Array.from({ length: frames }, (_, i) => {
    const frame = i + 1;
    return {
      frame,
      timeSec: frameToTime(frame, fps),
      events: byFrame.get(frame) ?? [],
    };
  });
  return {
    fps,
    frames,
    durationSec: durationSeconds(frames, fps),
    note: 'Spine 时间轴用秒；第 N 帧 = (N-1)/fps。事件帧请挂换算后的 timeSec。',
    rows,
  };
}

function buildTimeline(keys, frames, fps, kind, bone) {
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new Error(`骨骼 ${bone} 的 ${kind} 关键帧不能为空`);
  }
  const sorted = [...keys].sort((a, b) => a.frame - b.frame);
  let previous = 0;
  return sorted.map((key) => {
    assertFrameRange(key?.frame, frames, `${bone}.${kind}.frame`);
    if (key.frame <= previous) {
      throw new Error(`骨骼 ${bone} 的 ${kind} 关键帧必须递增且不可重复，帧号 ${key.frame}`);
    }
    previous = key.frame;
    const entry = { time: frameToTime(key.frame, fps) };
    if (kind === 'rotate') {
      entry.angle = asNumber(key.angle, 0, `${bone}.rotate.angle`);
    } else if (kind === 'translate') {
      entry.x = asNumber(key.x, 0, `${bone}.translate.x`);
      entry.y = asNumber(key.y, 0, `${bone}.translate.y`);
    } else if (kind === 'scale') {
      entry.x = asNumber(key.x, 1, `${bone}.scale.x`);
      entry.y = asNumber(key.y, 1, `${bone}.scale.y`);
    } else if (kind === 'shear') {
      entry.x = asNumber(key.x, 0, `${bone}.shear.x`);
      entry.y = asNumber(key.y, 0, `${bone}.shear.y`);
    }
    if (key.curve !== undefined) applyCurve(entry, key.curve, `${bone}.${kind}.curve`);
    return entry;
  });
}

// Spine 3.8 的贝塞尔控制点**不是数组**：curve 存 cx1，cy1/cx2/cy2 落在同级的 c2/c3/c4。
// 传数组（4.x 写法）会被 3.8 的 readCurve 当成 curve.asFloat() 直接炸：
//   IllegalStateException: Value cannot be converted to float: array
// 所以这里统一转成 3.8 原生编码，数组只作为入参便利语法。
export function applyCurve(entry, curve, label = 'curve') {
  if (curve === 'stepped' || curve === 'linear') {
    if (curve === 'stepped') entry.curve = 'stepped';
    return entry;
  }
  if (typeof curve === 'number' && Number.isFinite(curve)) {
    entry.curve = curve;
    return entry;
  }
  if (Array.isArray(curve)) {
    if (curve.length !== 4 || !curve.every((n) => typeof n === 'number' && Number.isFinite(n))) {
      throw new Error(`${label} 数组必须是 4 个有限数字 [cx1, cy1, cx2, cy2]，收到 ${JSON.stringify(curve)}`);
    }
    entry.curve = curve[0];
    entry.c2 = curve[1];
    entry.c3 = curve[2];
    entry.c4 = curve[3];
    return entry;
  }
  throw new Error(`${label} 只接受 "stepped" / 数字 cx1 / 4 元数组，收到 ${JSON.stringify(curve)}`);
}

// 在源 skeleton JSON 的「副本」上写动画，绝不修改源对象/源文件。
export function buildCombatAnimation(skeleton, spec = {}) {
  const {
    animationName,
    fps = DEFAULT_FPS,
    frames,
    boneControls = [],
    eventFrames = [],
    slotKeys = [],
    overwrite = false,
  } = spec;

  if (typeof animationName !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(animationName)) {
    throw new Error('animationName 必须是 1-128 位字母/数字/下划线/点/连字符');
  }
  assertPositiveInt(frames, 'frames');
  assertPositiveInt(fps, 'fps');
  if (!Array.isArray(skeleton?.bones)) {
    throw new Error('源 JSON 缺少 bones 数组，请先用 spine_export 导出 3.8 JSON');
  }

  const boneNames = new Set(skeleton.bones.map((b) => b?.name).filter(Boolean));
  const slotNames = new Set((skeleton.slots ?? []).map((s) => s?.name).filter(Boolean));
  const json = structuredClone(skeleton);
  json.animations ??= {};
  if (json.animations[animationName] && !overwrite) {
    throw new Error(`动画 ${animationName} 已存在；需要覆盖请显式传 overwrite=true`);
  }

  const warnings = [];
  const animation = {};

  if (!Array.isArray(boneControls)) throw new Error('boneControls 必须是数组');
  if (boneControls.length === 0) warnings.push('未提供 boneControls，只生成事件帧动画');
  const bones = {};
  for (const ctrl of boneControls) {
    if (!ctrl?.bone || !boneNames.has(ctrl.bone)) {
      throw new Error(`骨骼不存在: ${JSON.stringify(ctrl?.bone)}；可用骨骼: ${[...boneNames].join(', ')}`);
    }
    const timelines = {};
    for (const kind of ['rotate', 'translate', 'scale', 'shear']) {
      if (ctrl[kind] !== undefined) {
        timelines[kind] = buildTimeline(ctrl[kind], frames, fps, kind, ctrl.bone);
      }
    }
    if (Object.keys(timelines).length === 0) {
      warnings.push(`骨骼 ${ctrl.bone} 没有任何 rotate/translate/scale/shear 关键帧，已跳过`);
      continue;
    }
    bones[ctrl.bone] = timelines;
  }
  if (Object.keys(bones).length > 0) animation.bones = bones;

  if (!Array.isArray(slotKeys)) throw new Error('slotKeys 必须是数组');
  const slots = {};
  for (const key of slotKeys) {
    assertFrameRange(key?.frame, frames, 'slotKeys.frame');
    if (!slotNames.has(key.slot)) {
      throw new Error(`插槽不存在: ${JSON.stringify(key.slot)}`);
    }
    slots[key.slot] ??= { attachment: [] };
    slots[key.slot].attachment.push({
      time: frameToTime(key.frame, fps),
      name: key.attachment ?? null,
    });
  }
  if (Object.keys(slots).length > 0) animation.slots = slots;

  json.events ??= {};
  const events = [];
  if (!Array.isArray(eventFrames)) throw new Error('eventFrames 必须是数组');
  for (const ev of eventFrames) {
    assertFrameRange(ev?.frame, frames, 'eventFrames.frame');
    if (typeof ev.name !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(ev.name)) {
      throw new Error('事件 name 必须是 1-128 位字母/数字/下划线/点/连字符');
    }
    if (!json.events[ev.name]) {
      json.events[ev.name] = {};
      warnings.push(`顶层 events 已补齐定义: ${ev.name}`);
    }
    const item = { time: frameToTime(ev.frame, fps), name: ev.name };
    if (ev.int !== undefined) item.int = asNumber(ev.int, 0, 'event.int');
    if (ev.float !== undefined) item.float = asNumber(ev.float, 0, 'event.float');
    if (ev.string !== undefined) item.string = String(ev.string);
    events.push(item);
  }
  if (events.length > 0) animation.events = events.sort((a, b) => a.time - b.time);

  json.animations[animationName] = animation;

  return {
    json,
    summary: {
      animationName,
      fps,
      frames,
      durationSec: durationSeconds(frames, fps),
      boneCount: Object.keys(bones).length,
      eventCount: events.length,
      eventTimes: events.map((e) => ({ name: e.name, timeSec: e.time })),
      warnings,
    },
  };
}

// 读回生成结果做静态校验，不依赖 Spine 编辑器。
export function validateAnimation(skeleton, animationName) {
  const errors = [];
  const warnings = [];
  const anim = skeleton?.animations?.[animationName];
  if (!anim) {
    return { valid: false, errors: [`动画不存在: ${animationName}`], warnings, stats: null };
  }
  const boneNames = new Set((skeleton.bones ?? []).map((b) => b?.name).filter(Boolean));
  let keyframeCount = 0;
  let maxTime = 0;

  for (const [bone, timelines] of Object.entries(anim.bones ?? {})) {
    if (!boneNames.has(bone)) errors.push(`动画引用了不存在的骨骼: ${bone}`);
    for (const [kind, keys] of Object.entries(timelines ?? {})) {
      if (!Array.isArray(keys)) {
        errors.push(`${bone}.${kind} 不是数组`);
        continue;
      }
      let previous = -1;
      for (const key of keys) {
        keyframeCount += 1;
        // Spine JSON 会省略默认值，首帧 time=0 常写成 {}。
        const time = key?.time ?? 0;
        if (typeof time !== 'number' || !Number.isFinite(time) || time < 0) {
          errors.push(`${bone}.${kind} 存在非法 time`);
          continue;
        }
        if (time <= previous) errors.push(`${bone}.${kind} 的 time 未严格递增`);
        previous = time;
        maxTime = Math.max(maxTime, time);
      }
    }
  }
  // 3.8 导出的 animation.events 是 { eventName: [keys] } 对象；
  // 内存构造的动画可能是 [{ name, time }] 数组。两种都要校验。
  const rawEvents = anim.events ?? [];
  const eventEntries = Array.isArray(rawEvents)
    ? rawEvents
    : Object.entries(rawEvents).flatMap(([name, keys]) => {
        const list = Array.isArray(keys) ? keys : [keys];
        return list.map((key) => ({ ...(key ?? {}), name: key?.name ?? name }));
      });
  for (const ev of eventEntries) {
    const time = ev?.time ?? 0;
    if (typeof time !== 'number' || !Number.isFinite(time) || time < 0) errors.push(`事件 ${ev?.name} 的 time 非法`);
    if (!skeleton.events?.[ev?.name]) errors.push(`顶层 events 缺少定义: ${ev?.name}`);
    maxTime = Math.max(maxTime, time);
  }
  if (!anim.bones && !anim.slots && !anim.events) warnings.push('动画没有任何时间轴或事件');
  if (maxTime > 120) warnings.push(`动画末尾时间 ${maxTime}s 偏长，请确认帧数与 fps`);

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    stats: {
      boneCount: Object.keys(anim.bones ?? {}).length,
      slotCount: Object.keys(anim.slots ?? {}).length,
      eventCount: eventEntries.length,
      keyframeCount,
      maxTimeSec: round6(maxTime),
    },
  };
}
