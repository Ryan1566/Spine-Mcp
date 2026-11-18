const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);

export function* eventTimelines(animation) {
  const events = animation?.events;
  if (events == null) return;
  if (!isObject(events)) {
    yield { target: null, keys: events, assign: (keys) => { animation.events = keys; } };
    return;
  }
  for (const [target, value] of Object.entries(events)) {
    const grouped = Array.isArray(value);
    const keys = grouped ? value : [value];
    yield { target, keys, assign: (next) => {
      if (!grouped && next.length === 0) delete events[target];
      else events[target] = grouped ? next : next[0];
    } };
  }
}

export function* animationEvents(animation) {
  for (const { target, keys } of eventTimelines(animation)) {
    if (!Array.isArray(keys)) continue;
    for (const key of keys) {
      if (isObject(key)) yield { ...key, name: key.name ?? target };
    }
  }
}

export function* animationTimelines(animation) {
  for (const { target, keys, assign } of eventTimelines(animation)) {
    yield { category: 'animation', target, type: 'events', keys, assign };
  }
  for (const type of ['drawOrder', 'draworder']) {
    if (animation?.[type] === undefined) continue;
    yield { category: 'animation', target: null, type, keys: animation[type], assign: (keys) => { animation[type] = keys; } };
  }
  for (const category of ['bones', 'slots', 'ik', 'transform', 'path']) {
    for (const [target, timelines] of Object.entries(animation?.[category] ?? {})) {
      // 3.8 的 IK / Transform 直接存关键帧，Path 则分 position / mix 等通道。
      if (Array.isArray(timelines)) {
        yield { category, target, type: 'default', keys: timelines, assign: (keys) => { animation[category][target] = keys; } };
        continue;
      }
      for (const [type, keys] of Object.entries(timelines ?? {})) {
        yield { category, target, type, keys, assign: (next) => { animation[category][target][type] = next; } };
      }
    }
  }
  for (const [skin, slots] of Object.entries(animation?.deform ?? {})) {
    for (const [slot, attachments] of Object.entries(slots ?? {})) {
      for (const [attachment, keys] of Object.entries(attachments ?? {})) {
        yield {
          category: 'deform', target: `${skin}/${slot}/${attachment}`, type: 'deform', keys,
          assign: (next) => { animation.deform[skin][slot][attachment] = next; },
        };
      }
    }
  }
}

export const isEventTimeline = ({ category, type }) => category === 'animation' && type === 'events';
export const timelinePath = ({ category, target, type }) => [category, target, type].filter(Boolean).join('.');
export const isTimelineKey = (key) => isObject(key) && (key.time === undefined || Number.isFinite(key.time));
