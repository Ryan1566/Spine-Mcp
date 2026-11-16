// .skel 二进制结构级解析与校验（零依赖）。
// 读取顺序依据 Spine 3.8 的 SkeletonBinary：
//   header → 字符串表 → bones → slots → ik → transform → path
//   → 默认皮肤 → 其它皮肤 → events → animations
// 校验的核心锚点是「逐字段消费到文件末尾」：consumedBytes 必须等于文件长度，
// 否则说明结构在某个字段处读分叉了。只读，不修改任何文件。
import fs from 'node:fs/promises';
import { assertSafePath } from './spine-cli.mjs';

export const ATTACHMENT_TYPES = ['region', 'boundingbox', 'mesh', 'linkedmesh', 'path', 'point', 'clipping'];
export const BLEND_MODES = ['normal', 'additive', 'multiply', 'screen'];
export const TRANSFORM_MODES = ['normal', 'onlyTranslation', 'noRotationOrReflection', 'noScale', 'noScaleOrReflection'];
export const POSITION_MODES = ['fixed', 'percent'];
export const SPACING_MODES = ['length', 'fixed', 'percent', 'proportional'];
export const ROTATE_MODES = ['tangent', 'chain', 'chainScale'];
export const SLOT_TIMELINE_TYPES = ['attachment', 'color', 'twoColor'];
export const BONE_TIMELINE_TYPES = ['rotate', 'translate', 'scale', 'shear'];
export const PATH_TIMELINE_TYPES = ['position', 'spacing', 'mix'];

const CURVE_BEZIER = 2;
const MAX_ISSUES = 200;

class SkelFormatError extends Error {
  constructor(message, offset) {
    super(message);
    this.name = 'SkelFormatError';
    this.offset = offset;
  }
}

const enumAt = (table, index) => table[index] ?? `unknown(${index})`;
const round4 = (v) => Math.round(v * 10000) / 10000;

class Reader {
  constructor(buffer) {
    this.buf = buffer;
    this.o = 0;
    this.strings = [];
    this.issues = [];
  }

  need(n) {
    if (this.o + n > this.buf.length) {
      throw new SkelFormatError(`读取越界：还需要 ${n} 字节，但只剩 ${this.buf.length - this.o} 字节`, this.o);
    }
  }

  byte() { this.need(1); return this.buf[this.o++]; }

  signedByte() { const v = this.byte(); return v > 127 ? v - 256 : v; }

  boolean() { return this.byte() !== 0; }

  float() { this.need(4); const v = this.buf.readFloatBE(this.o); this.o += 4; return v; }

  int32() { this.need(4); const v = this.buf.readInt32BE(this.o); this.o += 4; return v; }

  short() { this.need(2); const v = this.buf.readInt16BE(this.o); this.o += 2; return v; }

  // 7 位变长整数；optimizePositive=false 时按 ZigZag 解码（官方 readInt(false)）
  int(optimizePositive = true) {
    let result = 0;
    let shift = 0;
    let b;
    do {
      b = this.byte();
      result |= (b & 0x7f) << shift;
      shift += 7;
      if (shift > 35) throw new SkelFormatError('变长整数过长（超过 5 字节）', this.o);
    } while (b & 0x80);
    result >>>= 0;
    return optimizePositive ? result : ((result >>> 1) ^ -(result & 1));
  }

  // 官方 readString：先读字节数（含自身长度位），0 → null，1 → ""
  string() {
    const byteCount = this.int(true);
    if (byteCount === 0) return null;
    if (byteCount === 1) return '';
    this.need(byteCount - 1);
    const value = this.buf.toString('utf8', this.o, this.o + byteCount - 1);
    this.o += byteCount - 1;
    return value;
  }

  stringRef() {
    const index = this.int(true);
    if (index === 0) return null;
    const value = this.strings[index - 1];
    if (value === undefined) {
      this.issue('error', 'bad-string-ref', `字符串引用越界：index=${index}，字符串表只有 ${this.strings.length} 项`);
      return null;
    }
    return value;
  }

  floatArray(count) {
    const out = new Array(count);
    for (let i = 0; i < count; i++) out[i] = this.float();
    return out;
  }

  shortArray() {
    const count = this.int(true);
    const out = new Array(count);
    for (let i = 0; i < count; i++) out[i] = this.short();
    return out;
  }

  // 顶点：bool weighted；未加权 2 个 float/顶点，加权每顶点 boneCount 组 (bone, wx, wy, w)
  vertices(vertexCount) {
    const weighted = this.boolean();
    if (!weighted) {
      for (let i = 0; i < vertexCount * 2; i++) this.float();
      return { weighted: false, vertexCount, boneEntries: 0 };
    }
    let boneEntries = 0;
    for (let i = 0; i < vertexCount; i++) {
      const boneCount = this.int(true);
      if (boneCount > 64) throw new SkelFormatError(`顶点 ${i} 的骨骼权重数异常：${boneCount}`, this.o);
      boneEntries += boneCount;
      for (let ii = 0; ii < boneCount; ii++) {
        this.int(true);
        this.float();
        this.float();
        this.float();
      }
    }
    return { weighted: true, vertexCount, boneEntries };
  }

  // 贝塞尔曲线：类型字节，仅 BEZIER(2) 追加 4 个 float
  curve() {
    if (this.byte() === CURVE_BEZIER) {
      this.float();
      this.float();
      this.float();
      this.float();
    }
  }

  issue(level, code, message, extra = {}) {
    if (this.issues.length >= MAX_ISSUES) return;
    this.issues.push({ level, code, message, offset: this.o, ...extra });
  }
}

function readAttachment(r, info) {
  // readSkin 先读一次名字，readAttachment 内部再读一次；后者为 0 时回退到前者
  const slotName = r.stringRef();
  let name = r.stringRef();
  if (name == null) name = slotName;
  const type = r.byte();
  const meta = { name, type: enumAt(ATTACHMENT_TYPES, type), path: null };

  switch (type) {
    case 0: { // region
      meta.path = r.stringRef() ?? name;
      r.float(); r.float(); r.float(); r.float(); r.float(); r.float(); r.float(); // rotation,x,y,scaleX,scaleY,width,height
      r.int32(); // color
      break;
    }
    case 1: { // boundingbox
      const vertexCount = r.int(true);
      const v = r.vertices(vertexCount);
      info.vertexCount += v.vertexCount;
      info.weightedVertices += v.weighted ? v.vertexCount : 0;
      if (info.nonessential) r.int32();
      break;
    }
    case 2: { // mesh
      meta.path = r.stringRef() ?? name;
      r.int32(); // color
      const vertexCount = r.int(true);
      r.floatArray(vertexCount * 2); // uvs
      r.shortArray(); // triangles
      const v = r.vertices(vertexCount);
      info.vertexCount += v.vertexCount;
      info.weightedVertices += v.weighted ? v.vertexCount : 0;
      r.int(true); // hullLength
      if (info.nonessential) { r.shortArray(); r.float(); r.float(); }
      break;
    }
    case 3: { // linkedmesh
      meta.path = r.stringRef() ?? name;
      r.int32(); // color
      r.stringRef(); // skin
      r.stringRef(); // parent
      r.boolean(); // inheritDeform
      if (info.nonessential) { r.float(); r.float(); }
      break;
    }
    case 4: { // path
      r.boolean(); // closed
      r.boolean(); // constantSpeed
      const vertexCount = r.int(true);
      const v = r.vertices(vertexCount);
      info.vertexCount += v.vertexCount;
      for (let i = 0; i < Math.floor(vertexCount / 3); i++) r.float(); // lengths
      if (info.nonessential) r.int32();
      break;
    }
    case 5: { // point
      r.float(); r.float(); r.float(); // rotation,x,y
      if (info.nonessential) r.int32();
      break;
    }
    case 6: { // clipping
      r.int(true); // end slot
      const vertexCount = r.int(true);
      const v = r.vertices(vertexCount);
      info.vertexCount += v.vertexCount;
      if (info.nonessential) r.int32();
      break;
    }
    default:
      throw new SkelFormatError(`未知附件类型 ${type}`, r.o);
  }
  return meta;
}

function readAttachments(r, slotCount, info) {
  let attachments = 0;
  const keys = new Set();
  for (let i = 0; i < slotCount; i++) {
    const slotIndex = r.int(true);
    const count = r.int(true);
    for (let ii = 0; ii < count; ii++) {
      const meta = readAttachment(r, info);
      attachments++;
      if (meta.name != null) keys.add(`${slotIndex}:${meta.name}`);
    }
  }
  return { slots: slotCount, attachments, keys };
}

function readBoneRefs(r) {
  const count = r.int(true);
  const refs = new Array(count);
  for (let i = 0; i < count; i++) refs[i] = r.int(true);
  return refs;
}

export function parseSkelBuffer(buffer) {
  const r = new Reader(buffer);
  const result = {
    bytes: buffer.length,
    consumedBytes: 0,
    trailingBytes: 0,
    header: null,
    stringCount: 0,
    counts: { bones: 0, slots: 0, ik: 0, transform: 0, path: 0, skins: 0, attachments: 0, events: 0, animations: 0 },
    bones: [],
    slots: [],
    constraints: { ik: [], transform: [], path: [] },
    skins: [],
    events: [],
    animations: [],
    issues: r.issues,
    errorCount: 0,
    warningCount: 0,
    ok: false,
  };

  try {
    const hash = r.string();
    const version = r.string();
    const header = { hash, version, x: r.float(), y: r.float(), width: r.float(), height: r.float(), nonessential: r.boolean() };
    if (header.nonessential) {
      header.fps = round4(r.float());
      header.images = r.string();
      header.audio = r.string();
    }
    result.header = header;

    // 字符串表
    const stringCount = r.int(true);
    result.stringCount = stringCount;
    for (let i = 0; i < stringCount; i++) r.strings.push(r.string());

    // bones
    const boneCount = r.int(true);
    result.counts.bones = boneCount;
    for (let i = 0; i < boneCount; i++) {
      const name = r.string();
      const parent = i === 0 ? null : r.int(true);
      r.float(); r.float(); r.float(); r.float(); r.float(); r.float(); r.float(); r.float();
      const transformMode = r.int(true);
      const skinRequired = r.boolean();
      if (header.nonessential) r.int32();
      result.bones.push({ name, parent, transformMode: enumAt(TRANSFORM_MODES, transformMode), skinRequired });
    }

    // slots
    const slotCount = r.int(true);
    result.counts.slots = slotCount;
    for (let i = 0; i < slotCount; i++) {
      const name = r.string();
      const bone = r.int(true);
      r.int32(); // color
      const darkColor = r.int32();
      const attachment = r.stringRef();
      const blendMode = r.int(true);
      result.slots.push({ name, bone, attachment, blendMode: enumAt(BLEND_MODES, blendMode), hasDarkColor: darkColor !== -1 });
    }

    // ik
    const ikCount = r.int(true);
    result.counts.ik = ikCount;
    for (let i = 0; i < ikCount; i++) {
      const name = r.string();
      const order = r.int(true);
      const skinRequired = r.boolean();
      const bones = readBoneRefs(r);
      const target = r.int(true);
      const mix = round4(r.float());
      r.float(); // softness
      const bendDirection = r.signedByte();
      const compress = r.boolean();
      const stretch = r.boolean();
      const uniform = r.boolean();
      result.constraints.ik.push({ name, order, skinRequired, bones, target, mix, bendDirection, compress, stretch, uniform });
    }

    // transform
    const transformCount = r.int(true);
    result.counts.transform = transformCount;
    for (let i = 0; i < transformCount; i++) {
      const name = r.string();
      const order = r.int(true);
      const skinRequired = r.boolean();
      const bones = readBoneRefs(r);
      const target = r.int(true);
      r.boolean(); // local
      r.boolean(); // relative
      for (let k = 0; k < 6; k++) r.float(); // offset*
      for (let k = 0; k < 4; k++) r.float(); // rotate/translate/scale/shear mix
      result.constraints.transform.push({ name, order, skinRequired, bones, target });
    }

    // path
    const pathCount = r.int(true);
    result.counts.path = pathCount;
    for (let i = 0; i < pathCount; i++) {
      const name = r.string();
      const order = r.int(true);
      const skinRequired = r.boolean();
      const bones = readBoneRefs(r);
      const targetSlot = r.int(true);
      const positionMode = r.int(true);
      const spacingMode = r.int(true);
      const rotateMode = r.int(true);
      for (let k = 0; k < 5; k++) r.float();
      result.constraints.path.push({
        name,
        order,
        skinRequired,
        bones,
        targetSlot,
        positionMode: enumAt(POSITION_MODES, positionMode),
        spacingMode: enumAt(SPACING_MODES, spacingMode),
        rotateMode: enumAt(ROTATE_MODES, rotateMode),
      });
    }

    // skins
    const info = { nonessential: header.nonessential, vertexCount: 0, weightedVertices: 0 };
    const skinKeys = [];
    const defaultSlotCount = r.int(true);
    if (defaultSlotCount > 0) {
      const read = readAttachments(r, defaultSlotCount, info);
      skinKeys.push(read.keys);
      result.skins.push({ name: 'default', slots: read.slots, attachments: read.attachments });
    } else {
      skinKeys.push(new Set());
    }
    const extraSkinCount = r.int(true);
    for (let i = 0; i < extraSkinCount; i++) {
      const name = r.stringRef();
      const bones = readBoneRefs(r);
      const ik = readBoneRefs(r);
      const transform = readBoneRefs(r);
      const path = readBoneRefs(r);
      const slots = r.int(true);
      const read = readAttachments(r, slots, info);
      skinKeys.push(read.keys);
      result.skins.push({ name, bones: bones.length, ik: ik.length, transform: transform.length, path: path.length, slots: read.slots, attachments: read.attachments });
      for (const index of bones) if (index >= boneCount) r.issue('error', 'skin-bone-index', `皮肤 ${name} 引用越界骨骼 ${index}`);
      for (const index of ik) if (index >= ikCount) r.issue('error', 'skin-ik-index', `皮肤 ${name} 引用越界 IK 约束 ${index}`);
      for (const index of transform) if (index >= transformCount) r.issue('error', 'skin-transform-index', `皮肤 ${name} 引用越界 Transform 约束 ${index}`);
      for (const index of path) if (index >= pathCount) r.issue('error', 'skin-path-index', `皮肤 ${name} 引用越界 Path 约束 ${index}`);
    }

    // events
    const eventCount = r.int(true);
    result.counts.events = eventCount;
    result.counts.skins = result.skins.length;
    result.counts.attachments = result.skins.reduce((sum, skin) => sum + skin.attachments, 0);
    result.counts.vertices = info.vertexCount;
    result.counts.weightedVertices = info.weightedVertices;
    for (let i = 0; i < eventCount; i++) {
      const name = r.stringRef();
      const intValue = r.int(false);
      const floatValue = round4(r.float());
      const stringValue = r.string();
      const audio = r.string();
      if (audio != null) { r.float(); r.float(); }
      result.events.push({ name, intValue, floatValue, stringValue, audio });
    }

    // animations
    const animationCount = r.int(true);
    result.counts.animations = animationCount;
    for (let i = 0; i < animationCount; i++) {
      const name = r.string();
      const anim = {
        name,
        duration: 0,
        timelines: 0,
        slot: 0,
        bone: 0,
        ik: 0,
        transform: 0,
        path: 0,
        deform: 0,
        drawOrder: 0,
        event: 0,
      };
      const readTime = () => {
        const t = r.float();
        if (t > anim.duration) anim.duration = t;
        return t;
      };
      const bad = (code, message) => r.issue('error', code, `动画 ${name}：${message}`);

      // 插槽时间线
      for (let a = 0, na = r.int(true); a < na; a++) {
        const slotIndex = r.int(true);
        if (slotIndex >= slotCount) bad('anim-slot-index', `插槽时间线引用越界插槽 ${slotIndex}`);
        for (let b = 0, nb = r.int(true); b < nb; b++) {
          const type = r.byte();
          const frameCount = r.int(true);
          anim.slot++;
          anim.timelines++;
          if (type === 0) {
            for (let f = 0; f < frameCount; f++) { readTime(); r.stringRef(); }
          } else if (type === 1) {
            for (let f = 0; f < frameCount; f++) { readTime(); r.int32(); if (f < frameCount - 1) r.curve(); }
          } else if (type === 2) {
            for (let f = 0; f < frameCount; f++) { readTime(); r.int32(); r.int32(); if (f < frameCount - 1) r.curve(); }
          } else {
            throw new SkelFormatError(`未知插槽时间线类型 ${type}`, r.o);
          }
        }
      }

      // 骨骼时间线
      for (let a = 0, na = r.int(true); a < na; a++) {
        const boneIndex = r.int(true);
        if (boneIndex >= boneCount) bad('anim-bone-index', `骨骼时间线引用越界骨骼 ${boneIndex}`);
        for (let b = 0, nb = r.int(true); b < nb; b++) {
          const type = r.byte();
          if (type > 3) throw new SkelFormatError(`未知骨骼时间线类型 ${type}`, r.o);
          const frameCount = r.int(true);
          const values = type === 0 ? 1 : 2; // rotate 只带 angle；translate/scale/shear 带 x,y
          anim.bone++;
          anim.timelines++;
          for (let f = 0; f < frameCount; f++) {
            readTime();
            for (let k = 0; k < values; k++) r.float();
            if (f < frameCount - 1) r.curve();
          }
        }
      }

      // IK 约束时间线
      for (let a = 0, na = r.int(true); a < na; a++) {
        const index = r.int(true);
        if (index >= ikCount) bad('anim-ik-index', `IK 时间线引用越界约束 ${index}`);
        const frameCount = r.int(true);
        anim.ik++;
        anim.timelines++;
        for (let f = 0; f < frameCount; f++) {
          readTime(); r.float(); r.float(); r.byte(); r.boolean(); r.boolean();
          if (f < frameCount - 1) r.curve();
        }
      }

      // Transform 约束时间线
      for (let a = 0, na = r.int(true); a < na; a++) {
        const index = r.int(true);
        if (index >= transformCount) bad('anim-transform-index', `Transform 时间线引用越界约束 ${index}`);
        const frameCount = r.int(true);
        anim.transform++;
        anim.timelines++;
        for (let f = 0; f < frameCount; f++) {
          readTime();
          for (let k = 0; k < 4; k++) r.float(); // rotate/translate/scale/shear mix
          if (f < frameCount - 1) r.curve();
        }
      }

      // Path 约束时间线
      for (let a = 0, na = r.int(true); a < na; a++) {
        const index = r.int(true);
        if (index >= pathCount) bad('anim-path-index', `Path 时间线引用越界约束 ${index}`);
        for (let b = 0, nb = r.int(true); b < nb; b++) {
          const type = r.byte();
          if (type > 2) throw new SkelFormatError(`未知 Path 时间线类型 ${type}`, r.o);
          const frameCount = r.int(true);
          const values = type === 2 ? 2 : 1; // mix 带 rotate/translate；position/spacing 只带 1 个值
          anim.path++;
          anim.timelines++;
          for (let f = 0; f < frameCount; f++) {
            readTime();
            for (let k = 0; k < values; k++) r.float();
            if (f < frameCount - 1) r.curve();
          }
        }
      }

      // Deform 时间线
      for (let a = 0, na = r.int(true); a < na; a++) {
        const skinIndex = r.int(true);
        if (skinIndex >= result.skins.length) bad('anim-skin-index', `Deform 时间线引用越界皮肤 ${skinIndex}`);
        for (let b = 0, nb = r.int(true); b < nb; b++) {
          const slotIndex = r.int(true);
          if (slotIndex >= slotCount) bad('anim-slot-index', `Deform 时间线引用越界插槽 ${slotIndex}`);
          for (let c = 0, nc = r.int(true); c < nc; c++) {
            const attachmentName = r.stringRef();
            if (skinIndex < skinKeys.length && attachmentName != null && !skinKeys[skinIndex].has(`${slotIndex}:${attachmentName}`)) {
              r.issue('warning', 'anim-deform-attachment', `动画 ${name}：Deform 时间线引用的附件 ${attachmentName}（插槽 ${slotIndex}）不在皮肤 ${result.skins[skinIndex]?.name ?? skinIndex} 里`);
            }
            const frameCount = r.int(true);
            anim.deform++;
            anim.timelines++;
            for (let f = 0; f < frameCount; f++) {
              readTime();
              const end = r.int(true);
              if (end !== 0) {
                r.int(true); // start
                for (let k = 0; k < end; k++) r.float();
              }
              if (f < frameCount - 1) r.curve();
            }
          }
        }
      }

      // DrawOrder 时间线
      const drawOrderCount = r.int(true);
      if (drawOrderCount > 0) {
        anim.drawOrder++;
        anim.timelines++;
        for (let f = 0; f < drawOrderCount; f++) {
          readTime();
          const offsetCount = r.int(true);
          for (let k = 0; k < offsetCount; k++) {
            const slotIndex = r.int(true);
            if (slotIndex >= slotCount) bad('anim-slot-index', `DrawOrder 引用越界插槽 ${slotIndex}`);
            r.int(true);
          }
        }
      }

      // 事件时间线
      const eventFrameCount = r.int(true);
      if (eventFrameCount > 0) {
        anim.event++;
        anim.timelines++;
        for (let f = 0; f < eventFrameCount; f++) {
          readTime();
          const eventIndex = r.int(true);
          if (eventIndex >= eventCount) bad('anim-event-index', `事件时间线引用越界事件 ${eventIndex}`);
          r.int(false); // intValue
          r.float(); // floatValue
          if (r.boolean()) r.string(); // stringValue
          if (result.events[eventIndex]?.audio != null) { r.float(); r.float(); }
        }
      }

      anim.duration = round4(anim.duration);
      result.animations.push(anim);
    }

    // 引用完整性（骨架段）
    result.bones.forEach((bone, i) => {
      if (bone.parent != null && bone.parent >= i) {
        r.issue('error', 'bone-parent', `骨骼 ${bone.name} 的父级索引 ${bone.parent} 不指向更早的骨骼`);
      }
    });
    for (const slot of result.slots) {
      if (slot.bone >= boneCount) r.issue('error', 'slot-bone', `插槽 ${slot.name} 引用越界骨骼 ${slot.bone}`);
    }
    for (const c of result.constraints.ik) {
      if (c.target >= boneCount) r.issue('error', 'ik-target', `IK 约束 ${c.name} 引用越界目标骨骼 ${c.target}`);
      for (const index of c.bones) if (index >= boneCount) r.issue('error', 'ik-bone', `IK 约束 ${c.name} 引用越界骨骼 ${index}`);
    }
    for (const c of result.constraints.transform) {
      if (c.target >= boneCount) r.issue('error', 'transform-target', `Transform 约束 ${c.name} 引用越界目标骨骼 ${c.target}`);
      for (const index of c.bones) if (index >= boneCount) r.issue('error', 'transform-bone', `Transform 约束 ${c.name} 引用越界骨骼 ${index}`);
    }
    for (const c of result.constraints.path) {
      if (c.targetSlot >= slotCount) r.issue('error', 'path-target', `Path 约束 ${c.name} 引用越界目标插槽 ${c.targetSlot}`);
      for (const index of c.bones) if (index >= boneCount) r.issue('error', 'path-bone', `Path 约束 ${c.name} 引用越界骨骼 ${index}`);
    }

    // 回填可读名字，便于人读报告
    for (const bone of result.bones) bone.parentName = bone.parent == null ? null : (result.bones[bone.parent]?.name ?? null);
    for (const slot of result.slots) slot.boneName = result.bones[slot.bone]?.name ?? null;
    for (const c of result.constraints.ik) c.targetName = result.bones[c.target]?.name ?? null;
    for (const c of result.constraints.transform) c.targetName = result.bones[c.target]?.name ?? null;
    for (const c of result.constraints.path) c.targetName = result.slots[c.targetSlot]?.name ?? null;

    // 版本提示
    if (version && version !== '3.8.75') {
      r.issue('warning', 'version', `文件内版本为 ${version}，当前工具链为 3.8.75`);
    }
  } catch (error) {
    r.issue('error', error instanceof SkelFormatError ? 'parse' : 'parse-unexpected', error.message);
  }

  result.consumedBytes = r.o;
  result.trailingBytes = buffer.length - r.o;
  const hardParseFailed = result.issues.some((i) => i.code === 'parse' || i.code === 'parse-unexpected');
  if (result.trailingBytes > 0 && result.consumedBytes > 0 && !hardParseFailed && !result.issues.some((i) => i.code === 'trailing-bytes')) {
    r.issue('error', 'trailing-bytes', `解析在 ${r.o} 字节处结束，文件还有 ${result.trailingBytes} 字节未读取（结构可能在该处读分叉）`);
  }
  result.errorCount = result.issues.filter((i) => i.level === 'error').length;
  result.warningCount = result.issues.filter((i) => i.level === 'warning').length;
  result.ok = result.errorCount === 0;
  return result;
}

export async function parseSkelFile(filePath) {
  assertSafePath(filePath, 'skelPath', { mustExist: true });
  const buffer = await fs.readFile(filePath);
  const parsed = parseSkelBuffer(buffer);
  return { file: filePath, ...parsed };
}

// 与源工程 / 导出 JSON 的结构指纹比对（只比顺序无关的名字集合与数量）
export function compareSkelToSkeleton(skel, skeleton) {
  const fields = [];
  const pairs = [
    ['bones', (skel.bones ?? []).map((b) => b.name), skeleton.bones ?? []],
    ['slots', (skel.slots ?? []).map((s) => s.name), skeleton.slots ?? []],
    ['animations', (skel.animations ?? []).map((a) => a.name), skeleton.animations ?? []],
    ['ik', (skel.constraints?.ik ?? []).map((c) => c.name), skeleton.ik ?? []],
  ];
  const details = [];
  for (const [key, mine, theirs] of pairs) {
    if (!theirs.length && !mine.length) continue;
    const a = [...mine].sort();
    const b = [...theirs].sort();
    if (a.length !== b.length) {
      fields.push(key);
      details.push({ field: key, skelCount: a.length, sourceCount: b.length, onlyInSkel: a.filter((v) => !b.includes(v)), onlyInSource: b.filter((v) => !a.includes(v)) });
      continue;
    }
    if (a.some((v, i) => v !== b[i])) {
      fields.push(key);
      details.push({ field: key, onlyInSkel: a.filter((v) => !b.includes(v)), onlyInSource: b.filter((v) => !a.includes(v)) });
    }
  }
  return { ok: fields.length === 0, fields, details };
}
