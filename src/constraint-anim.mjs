// P16：给约束时间线打帧（3.8.75）。
//
// 字段白名单是**实测**出来的，不是照抄文档：把候选字段写进 JSON → `-r` 导入 .spine → 导出 JSON，
// 看哪些字段活下来。结论（2026-11-17 实测）：
//   ik 时间线       animations.<a>.ik.<name>          数组，字段只有 mix / bendPositive（softness 被丢）
//   transform 时间线 animations.<a>.transform.<name>  数组，字段只有四个 Mix（rotation/x/y 偏移被丢）
//   path 时间线      animations.<a>.path.<name>        **对象**，分两个通道：
//                     position -> position（spacing 被丢）
//                     mix      -> rotateMix / translateMix
// 另外 3.8 的键名是单数 path，不是 paths。
import { applyCurve } from './timeline.mjs';

const NAME_RE = /^[A-Za-z0-9_.\- ]{1,128}$/;
const MAX_KEYS = 2000;

// 约束时间线里能出现的字段；default 仅用于文档与「省略即默认」的说明，不写进 JSON。
export const CONSTRAINT_ANIMATION_FIELDS = {
  ik: {
    channels: null,
    fields: { mix: 'number', bendPositive: 'boolean' },
    defaults: { mix: 1, bendPositive: true },
  },
  transform: {
    channels: null,
    fields: { rotateMix: 'number', translateMix: 'number', scaleMix: 'number', shearMix: 'number' },
    defaults: { rotateMix: 1, translateMix: 1, scaleMix: 1, shearMix: 1 },
  },
  path: {
    channels: {
      position: { fields: { position: 'number' }, defaults: { position: 0 } },
      mix: { fields: { rotateMix: 'number', translateMix: 'number' }, defaults: { rotateMix: 1, translateMix: 1 } },
    },
    defaultChannel: 'position',
  },
};

const CHANNEL_LABEL = { ik: '(无通道)', transform: '(无通道)', path: 'position / mix' };

function fieldsOf(type, channel) {
  const spec = CONSTRAINT_ANIMATION_FIELDS[type];
  if (!spec) throw new Error(`未知约束类型: ${type}（可用 ${Object.keys(CONSTRAINT_ANIMATION_FIELDS).join(' / ')}）`);
  if (!spec.channels) return spec.fields;
  const ch = channel ?? spec.defaultChannel;
  const sub = spec.channels[ch];
  if (!sub) {
    throw new Error(`${type} 约束的时间线分通道，channel 只能是 ${Object.keys(spec.channels).join(' / ')}，收到: ${ch}`);
  }
  return sub.fields;
}

function resolveChannel(type, channel) {
  const spec = CONSTRAINT_ANIMATION_FIELDS[type];
  if (!spec.channels) return null;
  const ch = channel ?? spec.defaultChannel;
  fieldsOf(type, ch);
  return ch;
}

// 实测：transform 约束时间线写 curve:"stepped" 会让 3.8.75 在 -r 导入时抛
//   java.lang.ArrayIndexOutOfBoundsException: 19
// 整个工程都导不进去（ik / path 的 stepped 都正常）。所以这里直接拒绝，而不是写出坏文件。
const STEPPED_UNSUPPORTED = new Set(['transform']);

function normalizeKey(raw, fields, label, index, type) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${label} 第 ${index + 1} 个关键帧必须是对象`);
  const time = raw.time;
  if (typeof time !== 'number' || !Number.isFinite(time) || time < 0) {
    throw new Error(`${label} 第 ${index + 1} 个关键帧的 time 必须是非负有限秒数`);
  }
  const entry = { time: Math.round(time * 10000) / 10000 };
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'time' || key === 'curve') continue;
    const kind = fields[key];
    if (!kind) {
      throw new Error(`${label} 第 ${index + 1} 个关键帧的字段 ${key} 在 3.8.75 的该时间线上不存在（可用 ${Object.keys(fields).join(' / ')}）`);
    }
    if (kind === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} 第 ${index + 1} 个关键帧的 ${key} 必须是有限数字`);
      entry[key] = value;
    } else if (kind === 'boolean') {
      if (typeof value !== 'boolean') throw new Error(`${label} 第 ${index + 1} 个关键帧的 ${key} 必须是布尔值`);
      entry[key] = value;
    }
  }
  if (raw.curve !== undefined) {
    if (raw.curve === 'stepped' && STEPPED_UNSUPPORTED.has(type)) {
      throw new Error(`${label} 第 ${index + 1} 个关键帧：3.8.75 的 ${type} 约束时间线不支持 curve:"stepped"（导入会抛 ArrayIndexOutOfBoundsException: 19，整份骨架都进不去）。改用数字 cx1 或 4 元贝塞尔数组`)
    }
    applyCurve(entry, raw.curve, `${label}[${index + 1}].curve`);
  }
  return entry;
}

function sortAndCheck(keys, label) {
  const sorted = [...keys].sort((a, b) => a.time - b.time);
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i].time === sorted[i - 1].time) {
      throw new Error(`${label} 的关键帧 time 不能重复：${sorted[i].time}s`);
    }
  }
  return sorted;
}

// 在 skeleton 的**副本**上写约束时间线，不修改入参。
export function animateConstraint(skeleton, spec = {}) {
  const {
    animationName,
    type,
    name,
    channel,
    keys,
    mode = 'set',
    createAnimation = true,
  } = spec;

  if (typeof animationName !== 'string' || !NAME_RE.test(animationName)) {
    throw new Error('animationName 必须是 1-128 位字母/数字/下划线/点/连字符/空格');
  }
  const specType = CONSTRAINT_ANIMATION_FIELDS[type];
  if (!specType) throw new Error(`未知约束类型: ${type}（可用 ${Object.keys(CONSTRAINT_ANIMATION_FIELDS).join(' / ')}）`);
  if (typeof name !== 'string' || !name) throw new Error('name（约束名）必填');

  const defs = Array.isArray(skeleton?.[type]) ? skeleton[type] : [];
  const definition = defs.find((item) => item?.name === name);
  if (!definition) {
    throw new Error(`工程里没有 ${type} 约束 ${name}；现有: ${defs.map((d) => d?.name).filter(Boolean).join(', ') || '(无)'}`);
  }
  if (!Array.isArray(keys) || keys.length === 0) throw new Error('keys 必须是非空数组');
  if (keys.length > MAX_KEYS) throw new Error(`keys 最多 ${MAX_KEYS} 个，收到 ${keys.length}`);

  const resolvedChannel = resolveChannel(type, channel);
  const fields = fieldsOf(type, resolvedChannel);
  const label = `${type}.${name}${resolvedChannel ? `[${resolvedChannel}]` : ''}`;
  const incoming = keys.map((key, index) => normalizeKey(key, fields, label, index, type));

  const json = structuredClone(skeleton);
  json.animations ??= {};
  const createdAnimation = !json.animations[animationName];
  if (createdAnimation) {
    if (!createAnimation) throw new Error(`动画 ${animationName} 不存在（createAnimation:false）`);
    json.animations[animationName] = {};
  }
  const animation = json.animations[animationName];
  if (animation === null || typeof animation !== 'object' || Array.isArray(animation)) {
    throw new Error(`动画 ${animationName} 不是对象，无法写时间线`);
  }
  if (type === 'path') animation.path ??= {};
  if (animation[type] === undefined) animation[type] = {};
  if (animation[type] === null || typeof animation[type] !== 'object' || Array.isArray(animation[type])) {
    throw new Error(`动画 ${animationName} 的 ${type} 不是对象`);
  }

  const existingTrack = animation[type][name];
  const existingKeys = Array.isArray(existingTrack)
    ? existingTrack
    : (resolvedChannel && Array.isArray(existingTrack?.[resolvedChannel]) ? existingTrack[resolvedChannel] : []);

  if (mode !== 'set' && mode !== 'merge') throw new Error(`mode 只支持 set / merge，收到: ${mode}`);

  let merged = incoming;
  let replaced = 0;
  let kept = 0;
  if (mode === 'merge' && existingKeys.length) {
    const byTime = new Map();
    for (const key of existingKeys) byTime.set(Math.round((key.time ?? 0) * 10000) / 10000, key);
    for (const key of incoming) {
      if (byTime.has(key.time)) replaced += 1;
      byTime.set(key.time, key);
    }
    merged = [...byTime.values()];
    kept = existingKeys.filter((key) => !incoming.some((k) => k.time === Math.round((key.time ?? 0) * 10000) / 10000)).length;
  } else if (mode === 'merge') {
    kept = 0;
  }
  const finalKeys = sortAndCheck(merged, label);

  if (resolvedChannel) {
    animation.path[name] ??= {};
    animation.path[name][resolvedChannel] = finalKeys;
  } else {
    animation[type][name] = finalKeys;
  }

  return {
    json,
    summary: {
      animationName,
      animationCreated: createdAnimation,
      type,
      name,
      channel: resolvedChannel,
      mode,
      written: incoming.length,
      replacedByMerge: replaced,
      keptFromExisting: kept,
      keyframes: finalKeys.length,
      duration: Math.max(...finalKeys.map((key) => key.time)),
      fields: Object.keys(fields),
      note: '省略的字段在 3.8 里按默认值处理（mixes=1、position=0、bendPositive=true），因此不会被写进 JSON。',
    },
  };
}

// 只读：列出某条约束（或整工程）已有的约束时间线，供打帧前后核对。
export function inspectConstraintTracks(skeleton, { type, name, animationName } = {}) {
  const types = type ? [type] : Object.keys(CONSTRAINT_ANIMATION_FIELDS);
  const tracks = [];
  for (const t of types) {
    for (const definition of (skeleton?.[t] ?? [])) {
      if (name && definition?.name !== name) continue;
      for (const [animName, animation] of Object.entries(skeleton?.animations ?? {})) {
        if (animationName && animName !== animationName) continue;
        const track = animation?.[t]?.[definition.name];
        if (!track) continue;
        if (Array.isArray(track)) {
          tracks.push({ type: t, name: definition.name, animation: animName, channel: null, keyframes: track.length, keys: track });
        } else if (track && typeof track === 'object') {
          for (const [ch, keys] of Object.entries(track)) {
            if (!Array.isArray(keys)) continue;
            tracks.push({ type: t, name: definition.name, animation: animName, channel: ch, keyframes: keys.length, keys });
          }
        }
      }
    }
  }
  return {
    counts: Object.fromEntries(types.map((t) => [t, tracks.filter((item) => item.type === t).length])),
    channels: CHANNEL_LABEL,
    tracks,
  };
}
