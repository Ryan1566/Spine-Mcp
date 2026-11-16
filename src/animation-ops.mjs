// P3：纯 JSON 层的动画操作，不调用 Spine CLI、不改 GUI、不写源文件。
// 所有写操作都返回新的对象（structuredClone），由工具层决定写到哪个副本文件。
import { buildCombatAnimation } from './timeline.mjs';

// 键顺序无关的稳定序列化，避免同一份动画因为属性顺序被误判为「有差异」。
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((acc, key) => {
      acc[key] = stable(value[key]);
      return acc;
    }, {});
  }
  return value;
}
const stableStringify = (value) => JSON.stringify(stable(value));

function animationStats(anim) {
  let keyframes = 0;
  for (const timelines of Object.values(anim?.bones ?? {})) {
    for (const keys of Object.values(timelines ?? {})) {
      if (Array.isArray(keys)) keyframes += keys.length;
    }
  }
  for (const slots of Object.values(anim?.slots ?? {})) {
    for (const keys of Object.values(slots ?? {})) {
      if (Array.isArray(keys)) keyframes += keys.length;
    }
  }
  return { keyframes, events: (anim?.events ?? []).length };
}

export function diffAnimations(base, other) {
  const a = base?.animations ?? {};
  const b = other?.animations ?? {};
  const added = [];
  const removed = [];
  const changed = [];
  const unchanged = [];

  for (const name of Object.keys(b)) {
    const stats = animationStats(b[name]);
    if (!(name in a)) added.push({ name, ...stats });
    else if (stableStringify(a[name]) === stableStringify(b[name])) unchanged.push({ name, ...stats });
    else changed.push({ name, before: animationStats(a[name]), after: stats });
  }
  for (const name of Object.keys(a)) {
    if (!(name in b)) removed.push({ name, ...animationStats(a[name]) });
  }

  const baseEvents = Object.keys(base?.events ?? {});
  const otherEvents = Object.keys(other?.events ?? {});
  return {
    identical: added.length === 0 && removed.length === 0 && changed.length === 0,
    counts: { base: Object.keys(a).length, other: Object.keys(b).length },
    added,
    removed,
    changed,
    unchanged,
    events: {
      added: otherEvents.filter((e) => !baseEvents.includes(e)),
      removed: baseEvents.filter((e) => !otherEvents.includes(e)),
    },
  };
}

function shiftTimes(value, offset, inKeyArray = false) {
  if (Array.isArray(value)) {
    for (const item of value) shiftTimes(item, offset, true);
  } else if (value && typeof value === 'object') {
    if (typeof value.time === 'number' || (inKeyArray && value.time === undefined)) {
      value.time = Math.round(((value.time ?? 0) + offset) * 1e6) / 1e6;
      if (value.time < 0) throw new Error(`timeOffset=${offset} 会产生负 time`);
    }
    for (const item of Object.values(value)) shiftTimes(item, offset);
  }
}

function prepareMergedAnimation(base, sourceAnimation, { boneMap = {}, timeOffset = 0, skipMissingBones = false }) {
  if (!boneMap || typeof boneMap !== 'object' || Array.isArray(boneMap)) throw new Error('boneMap 必须是 { donor骨骼名: base骨骼名 } 对象');
  if (typeof timeOffset !== 'number' || !Number.isFinite(timeOffset)) throw new Error('timeOffset 必须是有限数字');
  const animation = structuredClone(sourceAnimation);
  const baseBones = new Set((base?.bones ?? []).map((bone) => bone?.name));
  const missingBones = [];
  const droppedBoneTracks = [];
  const remappedBones = [];
  const bones = {};
  for (const [donorName, timelines] of Object.entries(animation.bones ?? {})) {
    const targetName = boneMap[donorName] ?? donorName;
    if (!baseBones.has(targetName)) {
      missingBones.push(donorName);
      if (skipMissingBones) {
        droppedBoneTracks.push(donorName);
        continue;
      }
      throw new Error(`合并动画引用了 base 不存在的骨骼: ${donorName}${targetName !== donorName ? ` -> ${targetName}` : ''}；可用 boneMap 映射或 skipMissingBones:true 跳过`);
    }
    if (bones[targetName]) throw new Error(`boneMap 把多个 donor 骨骼映射到同一个 base 骨骼: ${targetName}`);
    bones[targetName] = timelines;
    if (targetName !== donorName) remappedBones.push({ from: donorName, to: targetName });
  }
  if (Object.keys(bones).length) animation.bones = bones;
  else delete animation.bones;
  if (timeOffset !== 0) shiftTimes(animation, timeOffset);
  return { animation, remappedBones, missingBones, droppedBoneTracks };
}

export function mergeAnimations(base, donor, { animationNames, overwrite = false, boneMap = {}, timeOffset = 0, skipMissingBones = false } = {}) {
  const json = structuredClone(base);
  json.animations ??= {};
  json.events ??= {};
  const source = donor?.animations ?? {};
  const names = Array.isArray(animationNames) && animationNames.length > 0 ? animationNames : Object.keys(source);
  const merged = [];
  const skipped = [];
  const warnings = [];
  const remappedBones = [];
  const droppedBoneTracks = [];

  for (const name of names) {
    if (!(name in source)) {
      warnings.push(`donor 里没有动画 ${name}，已跳过`);
      continue;
    }
    if (json.animations[name] && !overwrite) {
      skipped.push(name);
      continue;
    }
    const prepared = prepareMergedAnimation(base, source[name], { boneMap, timeOffset, skipMissingBones });
    json.animations[name] = prepared.animation;
    remappedBones.push(...prepared.remappedBones.map((item) => ({ animation: name, ...item })));
    droppedBoneTracks.push(...prepared.droppedBoneTracks.map((bone) => ({ animation: name, bone })));
    merged.push(name);
  }

  // 合并进来的动画若引用了 base 没有的事件定义，从 donor 补齐（没有就补空定义）。
  const eventsAdded = [];
  const used = new Set();
  for (const name of merged) {
    for (const ev of json.animations[name].events ?? []) used.add(ev.name);
  }
  for (const eventName of used) {
    if (!json.events[eventName]) {
      json.events[eventName] = structuredClone(donor?.events?.[eventName] ?? {});
      eventsAdded.push(eventName);
    }
  }

  return {
    json,
    summary: { merged, skipped, eventsAdded, warnings, remappedBones, droppedBoneTracks, timeOffset, totalAnimations: Object.keys(json.animations).length },
  };
}

export function listEvents(skeleton) {
  const usedBy = new Map();
  for (const [animationName, anim] of Object.entries(skeleton?.animations ?? {})) {
    for (const ev of anim?.events ?? []) {
      const list = usedBy.get(ev.name) ?? [];
      list.push(animationName);
      usedBy.set(ev.name, list);
    }
  }
  return Object.entries(skeleton?.events ?? {}).map(([name, definition]) => ({
    name,
    definition,
    usedBy: [...new Set(usedBy.get(name) ?? [])],
  }));
}

export function manageEvents(skeleton, { mode = 'list', events = [], rename, definitions = {} } = {}) {
  if (mode === 'list') return { events: listEvents(skeleton) };
  if (!Array.isArray(events)) throw new Error('events 必须是数组');

  const json = structuredClone(skeleton);
  json.events ??= {};
  const summary = { mode, added: [], removed: [], renamed: [], warnings: [] };

  if (mode === 'add') {
    for (const entry of events) {
      const name = typeof entry === 'string' ? entry : entry?.name;
      if (typeof name !== 'string' || !name) throw new Error('事件名必须是非空字符串');
      if (json.events[name]) {
        summary.warnings.push(`事件 ${name} 已存在，跳过`);
        continue;
      }
      let definition = definitions[name];
      if (typeof entry === 'object' && entry !== null) {
        const { name: _ignored, ...rest } = entry;
        if (Object.keys(rest).length > 0) definition = rest;
      }
      json.events[name] = structuredClone(definition ?? {});
      summary.added.push(name);
    }
  } else if (mode === 'remove') {
    for (const entry of events) {
      const name = typeof entry === 'string' ? entry : entry?.name;
      if (!json.events[name]) {
        summary.warnings.push(`事件 ${name} 不存在，跳过`);
        continue;
      }
      delete json.events[name];
      summary.removed.push(name);
      for (const [animationName, anim] of Object.entries(json.animations ?? {})) {
        if ((anim.events ?? []).some((ev) => ev.name === name)) {
          summary.warnings.push(`动画 ${animationName} 仍引用已删除的事件 ${name}`);
        }
      }
    }
  } else if (mode === 'rename') {
    const { from, to } = rename ?? {};
    if (!from || !to) throw new Error('rename 需要 { from, to }');
    if (!json.events[from]) throw new Error(`事件 ${from} 不存在`);
    if (json.events[to]) throw new Error(`事件 ${to} 已存在`);
    json.events[to] = json.events[from];
    delete json.events[from];
    for (const anim of Object.values(json.animations ?? {})) {
      for (const ev of anim.events ?? []) {
        if (ev.name === from) ev.name = to;
      }
    }
    summary.renamed.push({ from, to });
  } else {
    throw new Error(`未知 mode: ${mode}（可用 list / add / remove / rename）`);
  }

  return { json, summary };
}

// 多 skeleton 批量生成：每个源 JSON 独立生成一条同名动画，单个失败不影响其它。
export function buildBatch(items = [], spec = {}) {
  if (!Array.isArray(items)) throw new Error('items 必须是数组');
  const results = [];
  const failures = [];
  for (const item of items) {
    try {
      const controls = spec.boneControlsBySkeleton?.[item.name] ?? spec.boneControls ?? [];
      const boneNames = new Set((item.skeleton?.bones ?? []).map((b) => b?.name).filter(Boolean));
      const boneControls = spec.skipMissingBones === true
        ? controls.filter((c) => boneNames.has(c?.bone))
        : controls;
      const { json, summary } = buildCombatAnimation(item.skeleton, {
        ...spec,
        boneControls,
      });
      results.push({ name: item.name, json, summary });
    } catch (err) {
      failures.push({ name: item?.name, error: err?.message ?? String(err) });
    }
  }
  return { results, failures };
}
