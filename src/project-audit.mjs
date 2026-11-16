// P5：skeleton JSON 只读体检。只分析传入对象，不调用 CLI、不访问源图片、不写文件。
import { inspectWeights } from './weight-ops.mjs';
import { validateAnimation } from './timeline.mjs';
import { collectAnimationTimelines } from './animation-detail.mjs';

const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);
const round6 = (value) => Math.round(value * 1e6) / 1e6;

function duplicateNames(items = []) {
  const seen = new Set();
  const duplicates = new Set();
  for (const item of items) {
    const name = item?.name;
    if (typeof name !== 'string' || !name) continue;
    if (seen.has(name)) duplicates.add(name);
    seen.add(name);
  }
  return [...duplicates];
}

function skinEntries(skeleton) {
  if (Array.isArray(skeleton?.skins)) {
    return skeleton.skins.map((skin, index) => [skin?.name ?? `(index ${index})`, skin?.attachments ?? skin]);
  }
  return Object.entries(skeleton?.skins ?? {});
}

function* attachmentEntries(skeleton) {
  for (const [skinName, attachments] of skinEntries(skeleton)) {
    if (!isObject(attachments)) continue;
    for (const [slotName, items] of Object.entries(attachments)) {
      if (!isObject(items)) continue;
      for (const [attachmentName, attachment] of Object.entries(items)) {
        yield { skinName, slotName, attachmentName, attachment };
      }
    }
  }
}

function auditAnimationReferences(skeleton, animationName, animation, add) {
  const bones = new Set((skeleton.bones ?? []).map((bone) => bone?.name));
  const slots = new Set((skeleton.slots ?? []).map((slot) => slot?.name));
  const ik = new Set((skeleton.ik ?? []).map((item) => item?.name));
  const transform = new Set((skeleton.transform ?? []).map((item) => item?.name));
  const paths = new Set((skeleton.path ?? []).map((item) => item?.name));

  for (const [category, names, label] of [
    ['bones', bones, '骨骼'], ['slots', slots, '插槽'], ['ik', ik, 'IK 约束'],
    ['transform', transform, 'Transform 约束'], ['paths', paths, 'Path 约束'],
  ]) {
    for (const target of Object.keys(animation?.[category] ?? {})) {
      if (!names.has(target)) add('error', 'animation.reference', `动画 ${animationName} 引用了不存在的${label}: ${target}`, { animationName, category, target });
    }
  }

  for (const [skinName, slotsInSkin] of Object.entries(animation?.deform ?? {})) {
    const skin = skinEntries(skeleton).find(([name]) => name === skinName)?.[1];
    if (!skin) {
      add('error', 'animation.deform', `动画 ${animationName} 的 deform 引用了不存在的皮肤: ${skinName}`, { animationName, skinName });
      continue;
    }
    for (const [slotName, attachments] of Object.entries(slotsInSkin ?? {})) {
      if (!slots.has(slotName)) add('error', 'animation.deform', `动画 ${animationName} 的 deform 引用了不存在的插槽: ${slotName}`, { animationName, skinName, slotName });
      for (const attachmentName of Object.keys(attachments ?? {})) {
        if (!isObject(skin?.[slotName]?.[attachmentName])) {
          add('error', 'animation.deform', `动画 ${animationName} 的 deform 引用了不存在的附件: ${skinName}/${slotName}/${attachmentName}`, { animationName, skinName, slotName, attachmentName });
        }
      }
    }
  }

  for (const key of animation?.drawOrder ?? animation?.draworder ?? []) {
    for (const offset of key?.offsets ?? []) {
      if (!slots.has(offset?.slot)) add('error', 'animation.drawOrder', `动画 ${animationName} 的 drawOrder 引用了不存在的插槽: ${offset?.slot}`, { animationName, slotName: offset?.slot });
    }
  }
}

export function auditProject(skeleton) {
  if (!isObject(skeleton)) throw new Error('源 JSON 顶层必须是 skeleton 对象');
  const issues = [];
  const add = (severity, code, message, location = {}) => issues.push({ severity, code, message, ...location });
  const bones = Array.isArray(skeleton.bones) ? skeleton.bones : [];
  const slots = Array.isArray(skeleton.slots) ? skeleton.slots : [];
  if (!Array.isArray(skeleton.bones)) add('error', 'structure.bones', '缺少 bones 数组');
  if (!Array.isArray(skeleton.slots)) add('warning', 'structure.slots', '缺少 slots 数组');
  if (bones.length === 0) add('error', 'structure.emptyBones', '工程没有任何骨骼');

  for (const [index, bone] of bones.entries()) {
    if (typeof bone?.name !== 'string' || !bone.name) add('error', 'bone.name', `bones[${index}] 缺少有效名称`, { index });
  }
  for (const name of duplicateNames(bones)) add('error', 'bone.duplicate', `骨骼重名: ${name}`, { name });
  const boneNames = new Set(bones.map((bone) => bone?.name));
  const boneByName = new Map(bones.map((bone) => [bone?.name, bone]));
  for (const bone of bones) {
    if (bone?.parent && !boneNames.has(bone.parent)) add('error', 'bone.parent', `骨骼 ${bone.name} 的父骨骼不存在: ${bone.parent}`, { name: bone.name, parent: bone.parent });
    const seen = new Set();
    let cursor = bone;
    while (cursor?.parent) {
      if (seen.has(cursor.name)) {
        add('error', 'bone.cycle', `骨骼 ${bone.name} 的父级链存在循环`, { name: bone.name });
        break;
      }
      seen.add(cursor.name);
      cursor = boneByName.get(cursor.parent);
      if (!cursor) break;
    }
  }

  for (const [index, slot] of slots.entries()) {
    if (typeof slot?.name !== 'string' || !slot.name) add('error', 'slot.name', `slots[${index}] 缺少有效名称`, { index });
    if (slot?.bone && !boneNames.has(slot.bone)) add('error', 'slot.bone', `插槽 ${slot.name} 引用了不存在的骨骼: ${slot.bone}`, { name: slot.name, bone: slot.bone });
  }
  for (const name of duplicateNames(slots)) add('error', 'slot.duplicate', `插槽重名: ${name}`, { name });

  const slotNames = new Set(slots.map((slot) => slot?.name));
  const attachmentNames = new Map();
  let attachmentCount = 0;
  let meshCount = 0;
  for (const { skinName, slotName, attachmentName, attachment } of attachmentEntries(skeleton)) {
    attachmentCount += 1;
    if (!slotNames.has(slotName)) add('error', 'attachment.slot', `皮肤 ${skinName} 的附件挂在不存在的插槽: ${slotName}`, { skinName, slotName, attachmentName });
    const key = `${skinName}/${slotName}`;
    const names = attachmentNames.get(key) ?? new Set();
    names.add(attachmentName);
    attachmentNames.set(key, names);
    if (!isObject(attachment)) {
      add('error', 'attachment.value', `附件不是对象: ${skinName}/${slotName}/${attachmentName}`, { skinName, slotName, attachmentName });
      continue;
    }
    if (attachment.type === 'mesh' || attachment.type === 'linkedmesh') meshCount += 1;
    if (attachment.type === 'mesh') {
      const uvCount = Array.isArray(attachment.uvs) ? attachment.uvs.length / 2 : null;
      if (!Number.isInteger(uvCount) || uvCount < 3) add('error', 'mesh.uvs', `mesh ${skinName}/${slotName}/${attachmentName} 的 uvs 无效或顶点少于 3`, { skinName, slotName, attachmentName });
      if (!Array.isArray(attachment.triangles) || attachment.triangles.length % 3 !== 0) {
        add('error', 'mesh.triangles', `mesh ${skinName}/${slotName}/${attachmentName} 的 triangles 不是完整三角形索引`, { skinName, slotName, attachmentName });
      } else if (Number.isInteger(uvCount)) {
        const invalid = attachment.triangles.filter((index) => !Number.isInteger(index) || index < 0 || index >= uvCount);
        if (invalid.length) add('error', 'mesh.triangles', `mesh ${skinName}/${slotName}/${attachmentName} 有 ${invalid.length} 个越界三角形下标`, { skinName, slotName, attachmentName });
      }
    }
  }

  for (const slot of slots) {
    if (slot?.attachment == null) continue;
    const available = [...attachmentNames.entries()]
      .filter(([key]) => key.endsWith(`/${slot.name}`))
      .some(([, names]) => names.has(slot.attachment));
    if (!available) add('warning', 'slot.setupAttachment', `插槽 ${slot.name} 的 setup attachment 未在任何皮肤中找到: ${slot.attachment}`, { name: slot.name, attachment: slot.attachment });
  }

  let weightReport = null;
  try {
    weightReport = inspectWeights(skeleton);
    for (const mesh of weightReport.meshes ?? []) {
      if (mesh.offSumVertices > 0) add('warning', 'weight.sum', `mesh ${mesh.slot}/${mesh.attachment} 有 ${mesh.offSumVertices} 个顶点权重和不为 1`, mesh);
      if (mesh.invalidBoneRefs > 0) add('error', 'weight.bone', `mesh ${mesh.slot}/${mesh.attachment} 有 ${mesh.invalidBoneRefs} 处无效骨骼下标`, mesh);
    }
    for (const issue of weightReport.issues ?? []) {
      if (issue.reason.includes('编码异常') || issue.reason.includes('解出')) add('error', 'weight.encoding', `mesh ${issue.slot}/${issue.attachment}: ${issue.reason}`, issue);
    }
  } catch (error) {
    add('error', 'weight.inspect', `权重检查失败: ${error.message}`);
  }

  const animationReports = [];
  for (const [name, animation] of Object.entries(skeleton.animations ?? {})) {
    const report = validateAnimation(skeleton, name);
    for (const message of report.errors) add('error', 'animation.timeline', message, { animationName: name });
    for (const message of report.warnings) add('warning', 'animation.timeline', message, { animationName: name });
    // 骨骼时间轴已由 validateAnimation 检查；这里补 slots / ik / transform / paths / deform / events / drawOrder 等所有类型。
    for (const timeline of collectAnimationTimelines(animation)) {
      if (timeline.category === 'bones') continue;
      const label = [timeline.category, timeline.target, timeline.type].filter(Boolean).join('.');
      let previous = -1;
      for (const [index, key] of timeline.keys.entries()) {
        const time = key?.time ?? 0;
        if (typeof time !== 'number' || !Number.isFinite(time) || time < 0) {
          if (timeline.category !== 'animation' || timeline.type !== 'events') {
            add('error', 'animation.timeline', `动画 ${name} 的 ${label} 第 ${index + 1} 个关键帧 time 非法`, { animationName: name, timeline: label });
          }
          continue;
        }
        if (time <= previous) add('error', 'animation.timeline', `动画 ${name} 的 ${label} 关键帧 time 未严格递增`, { animationName: name, timeline: label });
        previous = time;
      }
    }
    auditAnimationReferences(skeleton, name, animation, add);
    animationReports.push({ name, valid: report.valid && !issues.some((issue) => issue.animationName === name && issue.severity === 'error'), ...report.stats });
  }

  const counts = {
    bones: bones.length,
    slots: slots.length,
    skins: skinEntries(skeleton).length,
    attachments: attachmentCount,
    meshes: meshCount,
    animations: Object.keys(skeleton.animations ?? {}).length,
    events: Object.keys(skeleton.events ?? {}).length,
  };
  const errors = issues.filter((issue) => issue.severity === 'error').length;
  const warnings = issues.filter((issue) => issue.severity === 'warning').length;
  return {
    spineVersion: skeleton.skeleton?.spine ?? null,
    ok: errors === 0,
    counts,
    issueCount: issues.length,
    errors,
    warnings,
    issues,
    animations: animationReports,
    weights: weightReport ? {
      meshCount: weightReport.meshCount,
      weightedMeshCount: weightReport.weightedMeshCount,
      totalVertices: weightReport.totalVertices,
    } : null,
    note: '这是 skeleton JSON 静态体检，不等同于 Spine 编辑器导入或运行时渲染验证。',
  };
}
