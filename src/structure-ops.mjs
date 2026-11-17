// P6：插槽、皮肤的受控 JSON 操作；约束的只读检查（inspectConstraints）与受控写入（modifyConstraints）。
// 不调用 CLI、不修改源对象，返回值统一为 { json, summary }。
const NAME_RE = /^[A-Za-z0-9_.-]{1,128}$/;
const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);
const SLOT_FIELDS = ['bone', 'attachment', 'color', 'dark', 'blend'];
const NUMERIC_OR_STRING = new Set(['color', 'dark', 'blend']);

function assertName(value, label) {
  if (typeof value !== 'string' || !NAME_RE.test(value)) throw new Error(`${label} 必须是 1-128 位字母/数字/下划线/点/连字符`);
}
function slotList(skeleton) {
  if (!Array.isArray(skeleton?.slots)) throw new Error('源 JSON 缺少 slots 数组');
  return skeleton.slots;
}
function boneNames(skeleton) {
  return new Set((skeleton?.bones ?? []).map((bone) => bone?.name));
}
function skinEntries(skeleton) {
  if (Array.isArray(skeleton?.skins)) return skeleton.skins.map((skin, index) => [skin?.name ?? `(index ${index})`, skin?.attachments ?? skin]);
  return Object.entries(skeleton?.skins ?? {});
}
function getSkin(skeleton, name) {
  if (Array.isArray(skeleton?.skins)) return skeleton.skins.find((skin) => skin?.name === name);
  return skeleton?.skins?.[name];
}
function skinAttachments(skin) {
  return skin?.attachments ?? skin;
}
function setSkin(skeleton, name, attachments) {
  if (Array.isArray(skeleton?.skins)) {
    const skin = skeleton.skins.find((item) => item?.name === name);
    if (skin?.attachments) skin.attachments = attachments;
    else if (skin) {
      for (const key of Object.keys(skin)) if (key !== 'name') delete skin[key];
      Object.assign(skin, attachments);
    }
  } else {
    skeleton.skins[name] = attachments;
  }
}
function addSkin(skeleton, name, attachments) {
  skeleton.skins ??= Array.isArray(skeleton?.skins) ? [] : {};
  if (Array.isArray(skeleton.skins)) skeleton.skins.push({ name, attachments });
  else skeleton.skins[name] = attachments;
}
function removeSkin(skeleton, name) {
  if (Array.isArray(skeleton.skins)) skeleton.skins = skeleton.skins.filter((skin) => skin?.name !== name);
  else delete skeleton.skins[name];
}

function slotReferences(skeleton, name) {
  const attachments = [];
  for (const [skin, slots] of skinEntries(skeleton)) {
    if (slots?.[name]) attachments.push(skin);
  }
  const animationTracks = [];
  const deformTracks = [];
  const drawOrderTracks = [];
  for (const [animationName, animation] of Object.entries(skeleton.animations ?? {})) {
    if (animation.slots?.[name]) animationTracks.push(animationName);
    if (Object.values(animation.deform ?? {}).some((slots) => slots?.[name])) deformTracks.push(animationName);
    if ((animation.drawOrder ?? animation.draworder ?? []).some((key) => (key.offsets ?? []).some((offset) => offset?.slot === name))) drawOrderTracks.push(animationName);
  }
  return { attachments, animationTracks, deformTracks, drawOrderTracks };
}

function pickSlotFields(entry) {
  const result = {};
  for (const field of SLOT_FIELDS) {
    if (entry?.[field] === undefined) continue;
    const value = entry[field];
    if (NUMERIC_OR_STRING.has(field) && typeof value !== 'string') throw new Error(`${field} 必须是字符串`);
    if (field === 'attachment' && value !== null && typeof value !== 'string') throw new Error('attachment 必须是字符串或 null');
    result[field] = value;
  }
  return result;
}

export function modifySlots(skeleton, options = {}) {
  const { mode = 'list', slots = [], rename, order, dropAttachments = false, dropAnimationTracks = false } = options;
  if (mode === 'list') {
    return {
      slots: slotList(skeleton).map((slot, index) => ({ index, ...structuredClone(slot) })),
    };
  }
  if (!Array.isArray(slots)) throw new Error('slots 必须是数组');
  const json = structuredClone(skeleton);
  const list = slotList(json);
  const names = new Set(list.map((slot) => slot?.name));
  const summary = { mode, added: [], removed: [], renamed: [], updated: [], warnings: [] };

  if (mode === 'add') {
    for (const entry of slots) {
      assertName(entry?.name, 'slots[].name');
      if (names.has(entry.name)) throw new Error(`插槽已存在: ${entry.name}`);
      if (!boneNames(json).has(entry.bone)) throw new Error(`插槽 ${entry.name} 的骨骼不存在: ${entry.bone}`);
      const slot = { name: entry.name, ...pickSlotFields(entry) };
      list.push(slot);
      names.add(entry.name);
      summary.added.push({ name: entry.name, bone: entry.bone });
    }
  } else if (mode === 'remove') {
    for (const entry of slots) {
      const name = typeof entry === 'string' ? entry : entry?.name;
      if (!names.has(name)) throw new Error(`插槽不存在: ${name}`);
      const refs = slotReferences(json, name);
      if (refs.attachments.length && !dropAttachments) throw new Error(`插槽 ${name} 仍有皮肤附件，已拒绝删除；如确认一并删除请传 dropAttachments:true`);
      if ((refs.animationTracks.length || refs.deformTracks.length || refs.drawOrderTracks.length) && !dropAnimationTracks) {
        throw new Error(`插槽 ${name} 仍有动画引用，已拒绝删除；如确认清理请传 dropAnimationTracks:true`);
      }
      for (const [skinName, skinSlots] of skinEntries(json)) {
        if (skinSlots?.[name]) delete skinSlots[name];
        setSkin(json, skinName, skinSlots);
      }
      for (const animation of Object.values(json.animations ?? {})) {
        delete animation.slots?.[name];
        for (const skinSlots of Object.values(animation.deform ?? {})) delete skinSlots?.[name];
        for (const key of animation.drawOrder ?? animation.draworder ?? []) {
          key.offsets = (key.offsets ?? []).filter((offset) => offset?.slot !== name);
        }
      }
      const index = list.findIndex((slot) => slot?.name === name);
      list.splice(index, 1);
      names.delete(name);
      summary.removed.push({ name, index, dropped: refs });
    }
  } else if (mode === 'rename') {
    const from = rename?.from;
    const to = rename?.to;
    if (!names.has(from)) throw new Error(`插槽不存在: ${from}`);
    assertName(to, 'rename.to');
    if (names.has(to)) throw new Error(`目标插槽名已存在: ${to}`);
    list.find((slot) => slot?.name === from).name = to;
    for (const [skinName, skinSlots] of skinEntries(json)) {
      if (skinSlots?.[from]) {
        skinSlots[to] = skinSlots[from];
        delete skinSlots[from];
        setSkin(json, skinName, skinSlots);
      }
    }
    for (const animation of Object.values(json.animations ?? {})) {
      if (animation.slots?.[from]) {
        animation.slots[to] = animation.slots[from];
        delete animation.slots[from];
      }
      for (const skinSlots of Object.values(animation.deform ?? {})) {
        if (skinSlots?.[from]) {
          skinSlots[to] = skinSlots[from];
          delete skinSlots[from];
        }
      }
      for (const key of animation.drawOrder ?? animation.draworder ?? []) {
        for (const offset of key.offsets ?? []) if (offset?.slot === from) offset.slot = to;
      }
    }
    summary.renamed.push({ from, to });
  } else if (mode === 'set') {
    for (const entry of slots) {
      if (!names.has(entry?.name)) throw new Error(`插槽不存在: ${entry?.name}`);
      const changes = pickSlotFields(entry);
      if (changes.bone && !boneNames(json).has(changes.bone)) throw new Error(`插槽 ${entry.name} 的骨骼不存在: ${changes.bone}`);
      if (!Object.keys(changes).length) {
        summary.warnings.push(`插槽 ${entry.name} 没有可修改字段`);
        continue;
      }
      Object.assign(list.find((slot) => slot?.name === entry.name), changes);
      summary.updated.push({ name: entry.name, fields: Object.keys(changes) });
    }
  } else if (mode === 'reorder') {
    if (!Array.isArray(order) || order.length !== list.length || new Set(order).size !== order.length || order.some((name) => !names.has(name))) {
      throw new Error('reorder 的 order 必须包含全部现有插槽名且不得重复或遗漏');
    }
    const byName = new Map(list.map((slot) => [slot.name, slot]));
    json.slots = order.map((name) => byName.get(name));
    summary.order = [...order];
  } else {
    throw new Error(`未知 mode: ${mode}（可用 list / add / remove / rename / set / reorder）`);
  }
  return { json, summary };
}

export function modifySkins(skeleton, options = {}) {
  const { mode = 'list', skins = [], rename, attachments = [], dropDeformTracks = false } = options;
  const existing = skinEntries(skeleton);
  if (mode === 'list') {
    return {
      skins: existing.map(([name, slots]) => ({
        name,
        slotCount: Object.keys(slots ?? {}).length,
        attachmentCount: Object.values(slots ?? {}).reduce((sum, items) => sum + Object.keys(items ?? {}).length, 0),
        slots: Object.fromEntries(Object.entries(slots ?? {}).map(([slot, items]) => [slot, Object.keys(items ?? {})])),
      })),
    };
  }
  const json = structuredClone(skeleton);
  const summary = { mode, added: [], removed: [], renamed: [], assigned: [], warnings: [] };

  if (mode === 'add') {
    if (!Array.isArray(skins)) throw new Error('skins 必须是数组');
    for (const entry of skins) {
      const name = typeof entry === 'string' ? entry : entry?.name;
      assertName(name, 'skins[].name');
      if (getSkin(json, name)) throw new Error(`皮肤已存在: ${name}`);
      const contents = typeof entry === 'object' && entry?.attachments ? structuredClone(entry.attachments) : {};
      addSkin(json, name, contents);
      summary.added.push(name);
    }
  } else if (mode === 'remove') {
    if (!Array.isArray(skins)) throw new Error('skins 必须是数组');
    for (const entry of skins) {
      const name = typeof entry === 'string' ? entry : entry?.name;
      if (!getSkin(json, name)) throw new Error(`皮肤不存在: ${name}`);
      const deformAnimations = Object.entries(json.animations ?? {}).filter(([, animation]) => animation.deform?.[name]).map(([animationName]) => animationName);
      if (deformAnimations.length && !dropDeformTracks) throw new Error(`皮肤 ${name} 仍有 deform 动画引用: ${deformAnimations.join(', ')}；如确认清理请传 dropDeformTracks:true`);
      for (const animationName of deformAnimations) delete json.animations[animationName].deform[name];
      removeSkin(json, name);
      summary.removed.push({ name, droppedDeformTracks: deformAnimations });
    }
  } else if (mode === 'rename') {
    const from = rename?.from;
    const to = rename?.to;
    if (!getSkin(json, from)) throw new Error(`皮肤不存在: ${from}`);
    assertName(to, 'rename.to');
    if (getSkin(json, to)) throw new Error(`目标皮肤名已存在: ${to}`);
    if (Array.isArray(json.skins)) {
      getSkin(json, from).name = to;
    } else {
      json.skins[to] = json.skins[from];
      delete json.skins[from];
    }
    for (const animation of Object.values(json.animations ?? {})) {
      if (animation.deform?.[from]) {
        animation.deform[to] = animation.deform[from];
        delete animation.deform[from];
      }
    }
    summary.renamed.push({ from, to });
  } else if (mode === 'assign') {
    if (!Array.isArray(attachments)) throw new Error('attachments 必须是数组');
    const slotNames = new Set(slotList(json).map((slot) => slot?.name));
    for (const entry of attachments) {
      const { skin, slot, name, attachment } = entry ?? {};
      if (!getSkin(json, skin)) throw new Error(`皮肤不存在: ${skin}`);
      if (!slotNames.has(slot)) throw new Error(`插槽不存在: ${slot}`);
      assertName(name, 'attachments[].name');
      const contents = skinAttachments(getSkin(json, skin));
      contents[slot] ??= {};
      if (attachment === null) {
        delete contents[slot][name];
        summary.assigned.push({ skin, slot, name, action: 'remove' });
      } else {
        if (!isObject(attachment)) throw new Error('attachments[].attachment 必须是附件对象或 null（删除）');
        contents[slot][name] = structuredClone(attachment);
        summary.assigned.push({ skin, slot, name, action: 'set' });
      }
      setSkin(json, skin, contents);
    }
  } else {
    throw new Error(`未知 mode: ${mode}（可用 list / add / remove / rename / assign）`);
  }
  return { json, summary };
}

export function inspectConstraints(skeleton) {
  const bones = boneNames(skeleton);
  const issues = [];
  const constraints = [];
  for (const [type, key, animationKey] of [['ik', 'ik', 'ik'], ['transform', 'transform', 'transform'], ['path', 'path', 'path']]) {
    for (const [index, constraint] of (skeleton?.[key] ?? []).entries()) {
      const refs = [...(constraint.bones ?? []), constraint.target].filter(Boolean);
      const missingBones = refs.filter((name) => !bones.has(name));
      if (missingBones.length) issues.push({ type, name: constraint.name, missingBones });
      const animations = Object.entries(skeleton.animations ?? {})
        .filter(([, animation]) => animation?.[animationKey]?.[constraint.name])
        .map(([name, animation]) => ({
          name,
          keyframes: countConstraintKeys(animation[animationKey][constraint.name]),
        }));
      constraints.push({ type, index, name: constraint.name, definition: structuredClone(constraint), missingBones, animations });
    }
  }
  return { counts: Object.fromEntries(['ik', 'transform', 'path'].map((type) => [type, constraints.filter((item) => item.type === type).length])), issueCount: issues.length, issues, constraints };
}

// 3.8.75 的约束字段白名单，取自官方 examples 里 export/*.json 的字段全集。
// ik：name/bones/target/order/bendPositive/mix
// transform：name/bones/target/order/skin/x/y/rotation/scaleX/scaleY/shearX/shearY/四种 Mix
// path：name/bones/target/order/positionMode/spacingMode/rotateMode/rotation/position/spacing/rotateMix/translateMix
const CONSTRAINT_SPECS = {
  ik: {
    arrayKey: 'ik',
    animationKey: 'ik',
    fields: {
      order: 'order',
      bones: 'bones',
      target: 'bone',
      skin: 'string',
      mix: 'number',
      softness: 'number',
      bendPositive: 'boolean',
      stretch: 'boolean',
      uniform: 'boolean',
    },
  },
  transform: {
    arrayKey: 'transform',
    animationKey: 'transform',
    fields: {
      order: 'order',
      bones: 'bones',
      target: 'bone',
      skin: 'string',
      x: 'number',
      y: 'number',
      rotation: 'number',
      scaleX: 'number',
      scaleY: 'number',
      shearX: 'number',
      shearY: 'number',
      rotateMix: 'number',
      translateMix: 'number',
      scaleMix: 'number',
      shearMix: 'number',
      local: 'boolean',
      relative: 'boolean',
    },
  },
  path: {
    arrayKey: 'path',
    // 3.8 的路径约束时间线挂在 animations.<anim>.path.<name>，值是**对象**（position / mix 两组），不是数组。
    animationKey: 'path',
    fields: {
      order: 'order',
      bones: 'bones',
      target: 'bone',
      skin: 'string',
      positionMode: 'positionMode',
      spacingMode: 'spacingMode',
      rotateMode: 'rotateMode',
      rotation: 'number',
      position: 'number',
      spacing: 'number',
      rotateMix: 'number',
      translateMix: 'number',
      local: 'boolean',
      relative: 'boolean',
    },
  },
};

const CONSTRAINT_ENUMS = {
  // 官方样本里出现过 spacingMode=percent、rotateMode=chain/chainScale；其余为 3.8 运行时接受的取值。
  positionMode: ['fixed', 'percent'],
  spacingMode: ['length', 'fixed', 'percent', 'proportional'],
  rotateMode: ['tangent', 'chain', 'chainScale'],
};

function constraintSpec(type) {
  const spec = CONSTRAINT_SPECS[type];
  if (!spec) throw new Error(`未知约束类型: ${type}（可用 ${Object.keys(CONSTRAINT_SPECS).join(' / ')}）`);
  return spec;
}

function constraintList(skeleton, type) {
  const { arrayKey } = constraintSpec(type);
  skeleton[arrayKey] ??= [];
  if (!Array.isArray(skeleton[arrayKey])) throw new Error(`源 JSON 的 ${arrayKey} 不是数组`);
  return skeleton[arrayKey];
}

function assertConstraintField(field, kind, value, json) {
  const label = `constraint.${field}`;
  if (kind === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} 必须是有限数字`);
    return value;
  }
  if (kind === 'order') {
    if (!Number.isInteger(value) || value < 0) throw new Error(`${label} 必须是非负整数`);
    return value;
  }
  if (kind === 'boolean') {
    if (typeof value !== 'boolean') throw new Error(`${label} 必须是布尔值`);
    return value;
  }
  if (kind === 'string') {
    if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} 必须是非空字符串`);
    return value;
  }
  if (kind === 'bone') {
    if (typeof value !== 'string' || !boneNames(json).has(value)) throw new Error(`${label} 指向的骨骼不存在: ${value}`);
    return value;
  }
  if (kind === 'bones') {
    if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} 必须是非空骨骼名数组`);
    const names = boneNames(json);
    for (const bone of value) {
      if (typeof bone !== 'string' || !names.has(bone)) throw new Error(`${label} 里的骨骼不存在: ${bone}`);
    }
    if (new Set(value).size !== value.length) throw new Error(`${label} 不能包含重复骨骼`);
    return [...value];
  }
  if (kind in CONSTRAINT_ENUMS) {
    if (!CONSTRAINT_ENUMS[kind].includes(value)) {
      throw new Error(`${label} 只支持 ${CONSTRAINT_ENUMS[kind].join(' / ')}，收到: ${value}`);
    }
    return value;
  }
  throw new Error(`内部错误：未知字段类型 ${kind}`);
}

function pickConstraintFields(type, input, json) {
  const { fields } = constraintSpec(type);
  const result = {};
  for (const [field, value] of Object.entries(input ?? {})) {
    if (field === 'name') continue;
    const kind = fields[field];
    if (!kind) throw new Error(`约束类型 ${type} 不支持字段 ${field}（可用 ${['name', ...Object.keys(fields)].join(' / ')}）`);
    if (value === undefined) continue;
    result[field] = assertConstraintField(field, kind, value, json);
  }
  return result;
}

// path 约束的 target 骨骼上通常挂着 type=path 的附件；找不到只提示，不阻断（附件也可能来自运行时）。
function pathTargetHint(json, target) {
  const slots = new Set((json.slots ?? []).filter((slot) => slot?.bone === target).map((slot) => slot.name));
  if (slots.size === 0) return `目标骨骼 ${target} 上没有插槽，path 约束通常需要骨骼上挂一个 path 附件`;
  for (const [, skinSlots] of skinEntries(json)) {
    for (const slotName of slots) {
      for (const attachment of Object.values(skinSlots?.[slotName] ?? {})) {
        if (attachment?.type === 'path') return null;
      }
    }
  }
  return `目标骨骼 ${target} 的插槽上没找到 type=path 的附件，请确认路径附件放在该骨骼的插槽上`;
}

// 约束时间线的关键帧总数：ik / transform 是数组；path 是 { position: [...], mix: [...] } 嵌套对象。
function countConstraintKeys(track) {
  if (Array.isArray(track)) return track.length;
  if (track && typeof track === 'object') {
    return Object.values(track).reduce((sum, keys) => sum + (Array.isArray(keys) ? keys.length : 0), 0);
  }
  return 0;
}

// 3.8.75 的导入器要求约束 order 从 0 开始、跨类型连续；它实际按「数组位置」重建序号，
// 所以手写 order:1..n 会直接抛 "Missing constraint order: 0"（整份骨架进不去）。
// 这里统一按 ik → transform → path 的数组顺序重排成 0..n-1，order 0 按 3.8 导出习惯省略。
const CONSTRAINT_ORDER_TYPES = ['ik', 'transform', 'path'];

export function normalizeConstraintOrders(json) {
  const changed = [];
  let next = 0;
  for (const type of CONSTRAINT_ORDER_TYPES) {
    const { arrayKey } = constraintSpec(type);
    // 不要为工程里本来没有的约束类型凭空建空数组
    if (!Array.isArray(json?.[arrayKey])) continue;
    for (const entry of json[arrayKey]) {
      if (!entry || typeof entry !== 'object') continue;
      const want = next;
      next += 1;
      const had = entry.order;
      if (want === 0) {
        if ('order' in entry) {
          delete entry.order;
          changed.push({ name: entry.name, type, from: had, to: 0 });
        }
      } else if (had !== want) {
        entry.order = want;
        changed.push({ name: entry.name, type, from: had, to: want });
      }
    }
  }
  return changed;
}

function constraintAnimationRefs(json, type, name) {
  const { animationKey } = constraintSpec(type);
  const hits = [];
  for (const [animationName, animation] of Object.entries(json.animations ?? {})) {
    const track = animation?.[animationKey]?.[name];
    if (!track) continue;
    // ik / transform 的时间线是数组；path 是 { position: [...], mix: [...] } 的嵌套对象
    if (Array.isArray(track)) {
      hits.push({ animation: animationName, keyframes: track.length });
    } else {
      const channels = Object.keys(track).filter((k) => Array.isArray(track[k]));
      hits.push({ animation: animationName, channels, keyframes: countConstraintKeys(track) });
    }
  }
  return hits;
}

export function modifyConstraints(skeleton, options = {}) {
  const { mode = 'list', type, name, newName, constraint, dropAnimationTracks = false } = options;

  if (mode === 'list') {
    const types = type ? [type] : Object.keys(CONSTRAINT_SPECS);
    const constraints = [];
    for (const item of types) {
      const spec = constraintSpec(item);
      for (const [index, entry] of (skeleton?.[spec.arrayKey] ?? []).entries()) {
        constraints.push({
          type: item,
          index,
          definition: structuredClone(entry),
          animations: constraintAnimationRefs(skeleton, item, entry?.name),
        });
      }
    }
    return { constraints, counts: Object.fromEntries(Object.keys(CONSTRAINT_SPECS).map((key) => [key, constraints.filter((item) => item.type === key).length])) };
  }

  if (!type) throw new Error('写操作必须指定 type（ik / transform / path）');
  const spec = constraintSpec(type);
  const json = structuredClone(skeleton);
  const list = constraintList(json, type);
  const names = new Set(list.map((entry) => entry?.name));
  const summary = { mode, type, added: [], removed: [], renamed: [], updated: [], droppedAnimationTracks: [], warnings: [] };

  if (mode === 'add') {
    assertName(constraint?.name, 'constraint.name');
    if (names.has(constraint.name)) throw new Error(`${type} 约束已存在: ${constraint.name}`);
    if (constraint.bones === undefined || constraint.target === undefined) {
      throw new Error('新增约束必须提供 bones 与 target');
    }
    const entry = { name: constraint.name, ...pickConstraintFields(type, constraint, json) };
    list.push(entry);
    summary.added.push({ name: entry.name, bones: entry.bones, target: entry.target });
    if (type === 'path') {
      const hint = pathTargetHint(json, entry.target);
      if (hint) summary.warnings.push(hint);
    }
  } else if (mode === 'remove') {
    if (!names.has(name)) throw new Error(`${type} 约束不存在: ${name}`);
    const refs = constraintAnimationRefs(json, type, name);
    if (refs.length && !dropAnimationTracks) {
      throw new Error(`约束 ${name} 仍有动画引用: ${refs.map((item) => `${item.animation}(${item.keyframes} 帧)`).join(', ')}；如确认清理请传 dropAnimationTracks:true`);
    }
    for (const ref of refs) delete json.animations?.[ref.animation]?.[spec.animationKey]?.[name];
    const index = list.findIndex((entry) => entry?.name === name);
    list.splice(index, 1);
    names.delete(name);
    summary.removed.push({ name, index });
    summary.droppedAnimationTracks.push(...refs);
  } else if (mode === 'rename') {
    if (!names.has(name)) throw new Error(`${type} 约束不存在: ${name}`);
    assertName(newName, 'newName');
    if (names.has(newName)) throw new Error(`${type} 约束名已存在: ${newName}`);
    list.find((entry) => entry?.name === name).name = newName;
    // 动画轨道以约束名为键，改名必须同步，否则轨道会变成孤儿并被运行时忽略。
    for (const animation of Object.values(json.animations ?? {})) {
      const tracks = animation?.[spec.animationKey];
      if (tracks?.[name]) {
        tracks[newName] = tracks[name];
        delete tracks[name];
      }
    }
    summary.renamed.push({ from: name, to: newName });
  } else if (mode === 'set') {
    if (!names.has(name)) throw new Error(`${type} 约束不存在: ${name}`);
    const changes = pickConstraintFields(type, constraint, json);
    if (!Object.keys(changes).length) {
      summary.warnings.push(`约束 ${name} 没有可修改字段`);
    } else {
      Object.assign(list.find((entry) => entry?.name === name), changes);
      summary.updated.push({ name, fields: Object.keys(changes) });
      if (type === 'path' && changes.target !== undefined) {
        const hint = pathTargetHint(json, changes.target);
        if (hint) summary.warnings.push(hint);
      }
    }
  } else {
    throw new Error(`未知 mode: ${mode}（可用 list / add / remove / rename / set）`);
  }

  // 写操作后统一重排 order：3.8 导入要求 0 起连续，否则整份骨架导不进去。
  const reordered = normalizeConstraintOrders(json);
  if (reordered.length) {
    summary.reordered = reordered;
    summary.warnings.push(
      `已把约束 order 重排为 0 起连续（${reordered.map((item) => `${item.name}:${item.from ?? 0}→${item.to}`).join(', ')}）；3.8 导入要求 order 从 0 开始且跨类型连续，手写的 1..n 会抛 Missing constraint order: 0`,
    );
  }

  return { json, summary };
}
