// P6：插槽、皮肤的受控 JSON 操作与约束只读检查。不调用 CLI、不修改源对象。
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
  for (const [type, key, animationKey] of [['ik', 'ik', 'ik'], ['transform', 'transform', 'transform'], ['path', 'path', 'paths']]) {
    for (const [index, constraint] of (skeleton?.[key] ?? []).entries()) {
      const refs = [...(constraint.bones ?? []), constraint.target].filter(Boolean);
      const missingBones = refs.filter((name) => !bones.has(name));
      if (missingBones.length) issues.push({ type, name: constraint.name, missingBones });
      const animations = Object.entries(skeleton.animations ?? {})
        .filter(([, animation]) => animation?.[animationKey]?.[constraint.name])
        .map(([name, animation]) => ({ name, keyframes: animation[animationKey][constraint.name].length ?? 0 }));
      constraints.push({ type, index, name: constraint.name, definition: structuredClone(constraint), missingBones, animations });
    }
  }
  return { counts: Object.fromEntries(['ik', 'transform', 'path'].map((type) => [type, constraints.filter((item) => item.type === type).length])), issueCount: issues.length, issues, constraints };
}
