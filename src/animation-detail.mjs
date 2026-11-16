// P5：动画时间轴明细与基础编辑。纯 JSON 操作，不调用 CLI、不修改源对象。
import { round6, validateAnimation } from './timeline.mjs';

const NAME_RE = /^[A-Za-z0-9_.-]{1,128}$/;
const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);
const hasTime = (value) => isObject(value) && (value.time === undefined || (typeof value.time === 'number' && Number.isFinite(value.time)));
const keyTime = (key) => key.time ?? 0;

function assertAnimationName(name, label = 'animationName') {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw new Error(`${label} 必须是 1-128 位字母/数字/下划线/点/连字符`);
  }
}

function assertFinite(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} 必须是有限数字`);
}

function* timelineEntries(animation) {
  // events / drawOrder 是动画直属数组；draworder 兼容旧导出拼写。
  for (const [type, keys] of Object.entries(animation ?? {})) {
    if (!Array.isArray(keys) || !keys.every(hasTime)) continue;
    yield { category: 'animation', target: null, type, keys, assign: (value) => { animation[type] = value; } };
  }
  // bones / slots / ik / transform / paths：target -> timeline -> keys。
  for (const category of ['bones', 'slots', 'ik', 'transform', 'paths']) {
    for (const [target, timelines] of Object.entries(animation?.[category] ?? {})) {
      for (const [type, keys] of Object.entries(timelines ?? {})) {
        if (!Array.isArray(keys) || !keys.every(hasTime)) continue;
        yield { category, target, type, keys, assign: (value) => { animation[category][target][type] = value; } };
      }
    }
  }
  // deform：skin -> slot -> attachment -> keys。
  for (const [skin, slots] of Object.entries(animation?.deform ?? {})) {
    for (const [slot, attachments] of Object.entries(slots ?? {})) {
      for (const [attachment, keys] of Object.entries(attachments ?? {})) {
        if (!Array.isArray(keys) || !keys.every(hasTime)) continue;
        yield {
          category: 'deform', target: `${skin}/${slot}/${attachment}`, type: 'deform', keys,
          assign: (value) => { animation.deform[skin][slot][attachment] = value; },
        };
      }
    }
  }
}

function curveKind(key) {
  if (key.curve === undefined) return 'linear';
  if (key.curve === 'stepped') return 'stepped';
  if (Array.isArray(key.curve)) return 'bezier';
  return typeof key.curve;
}

// 给体检 / 编辑复用的时间轴清单；不暴露内部 assign 闭包。
export function collectAnimationTimelines(animation) {
  return [...timelineEntries(animation)].map(({ category, target, type, keys }) => ({ category, target, type, keys }));
}

export function inspectAnimation(skeleton, animationName, { includeKeyframes = true, maxKeyframes = 1000 } = {}) {
  const animation = skeleton?.animations?.[animationName];
  if (!isObject(animation)) throw new Error(`动画不存在: ${animationName}`);
  if (!Number.isInteger(maxKeyframes) || maxKeyframes < 1) throw new Error('maxKeyframes 必须是正整数');
  const timelines = [];
  let totalKeyframes = 0;
  let includedKeyframes = 0;
  let duration = 0;
  const curveTypes = new Set();

  for (const entry of timelineEntries(animation)) {
    const count = entry.keys.length;
    totalKeyframes += count;
    const remaining = Math.max(0, maxKeyframes - includedKeyframes);
    const keys = includeKeyframes ? entry.keys.slice(0, remaining) : [];
    includedKeyframes += keys.length;
    for (const key of entry.keys) curveTypes.add(curveKind(key));
    if (count > 0) duration = Math.max(duration, ...entry.keys.map(keyTime));
    timelines.push({
      category: entry.category,
      target: entry.target,
      type: entry.type,
      path: [entry.category, entry.target, entry.type].filter(Boolean).join('.'),
      keyframeCount: count,
      startTimeSec: count ? round6(keyTime(entry.keys[0])) : null,
      endTimeSec: count ? round6(keyTime(entry.keys[count - 1])) : null,
      keyframes: keys.map((key) => structuredClone(key)),
      keyframesTruncated: includeKeyframes && keys.length < count,
    });
  }

  return {
    animationName,
    durationSec: round6(duration),
    timelineCount: timelines.length,
    keyframeCount: totalKeyframes,
    returnedKeyframeCount: includedKeyframes,
    truncated: includeKeyframes && includedKeyframes < totalKeyframes,
    curveTypes: [...curveTypes].sort(),
    counts: {
      bones: Object.keys(animation.bones ?? {}).length,
      slots: Object.keys(animation.slots ?? {}).length,
      ik: Object.keys(animation.ik ?? {}).length,
      transform: Object.keys(animation.transform ?? {}).length,
      paths: Object.keys(animation.paths ?? {}).length,
      deformSkins: Object.keys(animation.deform ?? {}).length,
      events: (animation.events ?? []).length,
      drawOrder: (animation.drawOrder ?? animation.draworder ?? []).length,
    },
    timelines,
    note: 'time 的单位是秒；includeKeyframes:false 可只取摘要，maxKeyframes 控制返回体量。',
  };
}

function transformKeys(animation, mode, options) {
  let changed = 0;
  let removed = 0;
  const epsilon = 1e-9;
  for (const entry of timelineEntries(animation)) {
    let keys = entry.keys.map((key) => ({ ...structuredClone(key), time: round6(keyTime(key) * options.scale + options.offset) }));
    if (mode === 'crop') {
      const before = keys.length;
      keys = keys.filter((key) => key.time >= options.start - epsilon && key.time <= options.end + epsilon);
      removed += before - keys.length;
    }
    for (let index = 1; index < keys.length; index += 1) {
      if (keys[index].time <= keys[index - 1].time) {
        throw new Error(`时间变换后 ${entry.category}/${entry.target ?? ''}/${entry.type} 出现重复或倒序关键帧，请调整 scale / offset / crop`);
      }
    }
    if (keys.some((key) => key.time < 0)) throw new Error('时间变换后不能出现负 time；请增大 offset 或调整 crop 区间');
    entry.assign(keys);
    changed += keys.length;
  }
  return { changedKeyframes: changed, removedKeyframes: removed };
}

export function editAnimation(skeleton, options = {}) {
  const { mode, animationName } = options;
  assertAnimationName(animationName);
  const source = skeleton?.animations?.[animationName];
  if (!isObject(source)) throw new Error(`动画不存在: ${animationName}`);
  if (!['duplicate', 'rename', 'remove', 'shift', 'scale', 'crop'].includes(mode)) {
    throw new Error(`未知 mode: ${mode}（可用 duplicate / rename / remove / shift / scale / crop）`);
  }

  const json = structuredClone(skeleton);
  const animation = json.animations[animationName];
  const summary = { mode, animationName, warnings: [] };

  if (mode === 'remove') {
    delete json.animations[animationName];
    summary.removed = animationName;
    return { json, summary };
  }

  if (mode === 'duplicate' || mode === 'rename') {
    const newName = options.newName;
    assertAnimationName(newName, 'newName');
    if (json.animations[newName]) throw new Error(`目标动画已存在: ${newName}`);
    json.animations[newName] = mode === 'duplicate' ? structuredClone(animation) : animation;
    if (mode === 'rename') delete json.animations[animationName];
    summary.newName = newName;
    return { json, summary };
  }

  const scale = mode === 'scale' ? options.scale : 1;
  const offset = mode === 'shift' ? options.offset : 0;
  assertFinite(scale, 'scale');
  assertFinite(offset, 'offset');
  if (mode === 'scale' && scale <= 0) throw new Error('scale 模式要求 scale > 0；不支持直接反转时间轴');
  let crop = null;
  if (mode === 'crop') {
    assertFinite(options.start, 'start');
    assertFinite(options.end, 'end');
    if (options.start < 0 || options.end <= options.start) throw new Error('crop 需要 0 <= start < end');
    crop = { start: options.start, end: options.end };
  }
  const changes = transformKeys(animation, mode, { scale, offset, ...crop });
  Object.assign(summary, changes, {
    scale,
    offset: round6(offset),
    crop: crop ? { startSec: crop.start, endSec: crop.end } : null,
    durationSec: inspectAnimation(json, animationName, { includeKeyframes: false }).durationSec,
  });
  if (mode === 'crop') summary.warnings.push('crop 只保留区间内现有关键帧，不自动在边界补插值帧；如需边界姿态请先在编辑器中打关键帧。');
  const validation = validateAnimation(json, animationName);
  if (!validation.valid) throw new Error(`编辑后时间轴校验失败: ${validation.errors.join('；')}`);
  return { json, summary };
}
