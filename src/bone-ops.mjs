// P4：在导出的 3.8.75 skeleton JSON 副本上修改骨骼结构与 setup pose。
// 纯 JSON 层：不调用 CLI、不碰 GUI、不写源文件；所有返回都是 structuredClone 的新对象。
//
// 重要约束：mesh 的骨骼影响用的是「bones 数组下标」（编码在 vertices 里），
// 因此删除/重排骨骼会让权重错位。本模块对含加权 mesh 的工程拒绝删除骨骼。

const NAME_RE = /^[A-Za-z0-9_.-]{1,128}$/;
// 允许读写的 setup pose 字段，避免把任意字段写进骨骼。
const TRANSFORM_FIELDS = ['x', 'y', 'rotation', 'scaleX', 'scaleY', 'shearX', 'shearY', 'length', 'color', 'transform', 'icon', 'skin', 'required'];
const NUMERIC_FIELDS = new Set(['x', 'y', 'rotation', 'scaleX', 'scaleY', 'shearX', 'shearY', 'length']);

function assertName(value, label) {
  if (typeof value !== 'string' || !NAME_RE.test(value)) {
    throw new Error(`${label} 必须是 1-128 位字母/数字/下划线/点/连字符，收到 ${JSON.stringify(value)}`);
  }
  return value;
}

function boneList(skeleton) {
  if (!Array.isArray(skeleton?.bones)) throw new Error('源 JSON 缺少 bones 数组');
  return skeleton.bones;
}

function byName(skeleton, name) {
  return boneList(skeleton).find((b) => b?.name === name);
}

export function listBones(skeleton) {
  return boneList(skeleton).map((bone, index) => {
    const row = { index, name: bone?.name ?? null, parent: bone?.parent ?? null };
    for (const field of TRANSFORM_FIELDS) {
      if (bone?.[field] !== undefined) row[field] = bone[field];
    }
    return row;
  });
}

// 加权 mesh：type==='mesh' 且 uvs 存在；vertices 长度 != 顶点数*2 即为带权重的编码数组。
function hasWeightedMesh(skeleton) {
  const skins = Array.isArray(skeleton?.skins) ? skeleton.skins : Object.values(skeleton?.skins ?? {});
  for (const skin of skins) {
    const attachments = skin?.attachments ?? skin;
    for (const items of Object.values(attachments ?? {})) {
      if (!items || typeof items !== 'object') continue;
      for (const att of Object.values(items)) {
        if (att?.type !== 'mesh' || !Array.isArray(att?.uvs) || !Array.isArray(att?.vertices)) continue;
        const count = att.uvs.length / 2;
        if (att.vertices.length !== count * 2) return true;
      }
    }
  }
  return false;
}

function findReferences(skeleton, name) {
  const children = boneList(skeleton).filter((b) => b?.parent === name).map((b) => b.name);
  const slots = (skeleton.slots ?? []).filter((s) => s?.bone === name).map((s) => s.name);
  const animations = Object.entries(skeleton.animations ?? {})
    .filter(([, anim]) => anim?.bones?.[name] !== undefined)
    .map(([animName]) => animName);
  const ikConstraints = (skeleton.ik ?? []).filter((c) => c?.target === name || (c?.bones ?? []).includes(name)).map((c) => c.name ?? '(unnamed)');
  return { children, slots, animations, ikConstraints };
}

function describeRefs(refs) {
  return [
    `子骨骼: ${refs.children.join(', ') || '无'}`,
    `插槽: ${refs.slots.join(', ') || '无'}`,
    `动画时间轴: ${refs.animations.join(', ') || '无'}`,
    `IK 约束: ${refs.ikConstraints.join(', ') || '无'}`,
  ].join('；');
}

function pickTransform(entry) {
  const out = {};
  for (const field of TRANSFORM_FIELDS) {
    const value = entry?.[field];
    if (value === undefined) continue;
    if (NUMERIC_FIELDS.has(field) && (typeof value !== 'number' || !Number.isFinite(value))) {
      throw new Error(`${field} 必须是有限数字，收到 ${JSON.stringify(value)}`);
    }
    out[field] = value;
  }
  return out;
}

export function modifyBones(skeleton, options = {}) {
  const {
    mode = 'list',
    bones = [],
    rename,
    reparent,
    reparentChildren = false,
    dropAnimationTracks = false,
  } = options;

  if (mode === 'list') return { bones: listBones(skeleton) };
  if (!Array.isArray(bones)) throw new Error('bones 必须是数组');

  const json = structuredClone(skeleton);
  const summary = { mode, added: [], removed: [], renamed: [], reparented: [], updated: [], warnings: [] };
  const list = boneList(json);
  const names = new Set(list.map((b) => b?.name).filter(Boolean));

  if (mode === 'add') {
    for (const entry of bones) {
      const name = assertName(entry?.name, 'bones[].name');
      if (names.has(name)) throw new Error(`骨骼 ${name} 已存在`);
      const parent = entry.parent ?? list[0]?.name ?? null;
      if (parent && !names.has(parent)) throw new Error(`父骨骼不存在: ${parent}`);
      const bone = { name };
      if (parent) bone.parent = parent;
      Object.assign(bone, pickTransform(entry));
      list.push(bone); // 追加到末尾，不打乱已有骨骼下标
      names.add(name);
      summary.added.push({ name, parent });
    }
  } else if (mode === 'remove') {
    if (hasWeightedMesh(json) && bones.length > 0) {
      throw new Error('该工程含加权 mesh：骨骼权重按数组下标编码，删除骨骼会让权重错位，已拒绝。请改用 rename / set，或先在 Spine 编辑器里处理蒙皮。');
    }
    for (const entry of bones) {
      const name = typeof entry === 'string' ? entry : entry?.name;
      if (!names.has(name)) throw new Error(`骨骼不存在: ${name}`);
      const refs = findReferences(json, name);
      const blocked = [];
      if (refs.slots.length) blocked.push('插槽');
      if (refs.ikConstraints.length) blocked.push('IK 约束');
      if (refs.children.length && !reparentChildren) blocked.push('子骨骼');
      if (refs.animations.length && !dropAnimationTracks) blocked.push('动画时间轴');
      if (blocked.length) {
        throw new Error(`骨骼 ${name} 仍被引用（${blocked.join('、')}），已拒绝删除。${describeRefs(refs)}`);
      }
      const target = list.find((b) => b?.name === name);
      const parent = target?.parent ?? null;
      if (refs.children.length) {
        for (const child of list) {
          if (child?.parent === name) child.parent = parent ?? undefined;
          if (child?.parent === undefined) delete child.parent;
        }
      }
      if (refs.animations.length) {
        for (const [animName, anim] of Object.entries(json.animations ?? {})) {
          if (anim?.bones) delete anim.bones[name];
        }
      }
      const index = list.findIndex((b) => b?.name === name);
      list.splice(index, 1);
      names.delete(name);
      summary.removed.push({ name, index, reparentedChildren: refs.children, droppedTracks: refs.animations });
    }
  } else if (mode === 'rename') {
    const from = rename?.from;
    const to = rename?.to;
    if (!names.has(from)) throw new Error(`骨骼不存在: ${from}`);
    assertName(to, 'rename.to');
    if (names.has(to)) throw new Error(`目标骨骼名已存在: ${to}`);
    for (const bone of list) {
      if (bone?.name === from) bone.name = to;
      if (bone?.parent === from) bone.parent = to;
    }
    for (const slot of json.slots ?? []) {
      if (slot?.bone === from) slot.bone = to;
    }
    for (const anim of Object.values(json.animations ?? {})) {
      if (anim?.bones?.[from]) {
        anim.bones[to] = anim.bones[from];
        delete anim.bones[from];
      }
    }
    for (const constraint of json.ik ?? []) {
      if (constraint?.target === from) constraint.target = to;
      if (Array.isArray(constraint?.bones)) constraint.bones = constraint.bones.map((b) => (b === from ? to : b));
    }
    summary.renamed.push({ from, to });
  } else if (mode === 'reparent') {
    const name = reparent?.name;
    const parent = reparent?.parent;
    if (!names.has(name)) throw new Error(`骨骼不存在: ${name}`);
    if (parent && !names.has(parent)) throw new Error(`父骨骼不存在: ${parent}`);
    if (name === parent) throw new Error('骨骼不能成为自己的父级');
    // 沿 parent 链向上走，若遇到 name 说明会形成环。
    let cursor = parent;
    const seen = new Set();
    while (cursor && !seen.has(cursor)) {
      if (cursor === name) throw new Error(`reparent 会形成循环: ${name} -> ${parent}`);
      seen.add(cursor);
      cursor = byName(json, cursor)?.parent ?? null;
    }
    const bone = list.find((b) => b?.name === name);
    const previous = bone.parent ?? null;
    if (parent) bone.parent = parent;
    else delete bone.parent;
    summary.reparented.push({ name, from: previous, to: parent ?? null });
  } else if (mode === 'set') {
    for (const entry of bones) {
      const name = entry?.name;
      if (!names.has(name)) throw new Error(`骨骼不存在: ${name}`);
      const changes = pickTransform(entry);
      if (Object.keys(changes).length === 0) {
        summary.warnings.push(`骨骼 ${name} 没有可修改的 setup pose 字段，已跳过`);
        continue;
      }
      const bone = list.find((b) => b?.name === name);
      Object.assign(bone, changes);
      summary.updated.push({ name, fields: Object.keys(changes) });
    }
  } else {
    throw new Error(`未知 mode: ${mode}（可用 list / add / remove / rename / reparent / set）`);
  }

  return { json, summary };
}
