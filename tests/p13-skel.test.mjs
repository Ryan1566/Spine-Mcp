import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSkelBuffer, parseSkelFile, compareSkelToSkeleton, ATTACHMENT_TYPES, TRANSFORM_MODES, BLEND_MODES } from '../src/skel-parse.mjs';
import { binarySkeletonName, normalizeBinarySkeleton, compareExportSkeletons } from '../src/verify-export.mjs';
import { TOOLS } from '../src/tools.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

// ---- 精简 .skel 编码器：只覆盖测试需要的字段，用来构造「已知答案」的二进制 ----
class Writer {
  constructor() {
    this.parts = [];
  }

  bytes(buf) { this.parts.push(Buffer.from(buf)); return this; }

  byte(v) { return this.bytes([v & 0xff]); }

  boolean(v) { return this.byte(v ? 1 : 0); }

  float(v) { const b = Buffer.alloc(4); b.writeFloatBE(v); return this.bytes(b); }

  int32(v) { const b = Buffer.alloc(4); b.writeInt32BE(v); return this.bytes(b); }

  short(v) { const b = Buffer.alloc(2); b.writeInt16BE(v); return this.bytes(b); }

  int(v, optimizePositive = true) {
    let value = (optimizePositive ? v : ((v << 1) ^ (v >> 31))) >>> 0;
    do {
      let b = value & 0x7f;
      value >>>= 7;
      if (value) b |= 0x80;
      this.byte(b);
    } while (value);
    return this;
  }

  string(s) {
    if (s == null) return this.int(0);
    const buf = Buffer.from(s, 'utf8');
    this.int(buf.length + 1);
    return this.bytes(buf);
  }

  toBuffer() { return Buffer.concat(this.parts); }
}

// strings[0]='region-x'  strings[1]='hit'
function buildRegionSkel({ mesh = false } = {}) {
  const w = new Writer();
  // header
  w.string('test-hash');
  w.string('3.8.75');
  w.float(0).float(0).float(320).float(240);
  w.boolean(true); // nonessential
  w.float(30);
  w.string(null); // imagesPath
  w.string('./audio/'); // audioPath
  // 字符串表
  w.int(2);
  w.string('region-x');
  w.string('hit');
  // bones：root / head
  w.int(2);
  w.string('root'); w.float(0).float(0).float(0).float(1).float(1).float(0).float(0).float(10); w.int(0); w.boolean(false); w.int32(0);
  w.string('head'); w.int(0); w.float(0).float(0).float(0).float(1).float(1).float(0).float(0).float(5); w.int(1); w.boolean(true); w.int32(0);
  // slots：body
  w.int(1);
  w.string('body'); w.int(1); w.int32(-1); w.int32(-1); w.int(1); w.int(0); // attachmentName -> strings[0]
  // ik / transform / path
  w.int(0); w.int(0); w.int(0);
  // 默认皮肤：1 个插槽 1 个附件
  w.int(1);
  w.int(0); // slotIndex
  w.int(1); // 附件数
  w.int(1); w.int(1); w.byte(0); w.int(0); // firstName、name、type=region、path=null
  w.float(0).float(0).float(0).float(1).float(1).float(64).float(32).int32(-1);
  // 额外皮肤
  w.int(0);
  // events
  w.int(1);
  w.int(2); // name -> strings[1] = 'hit'
  w.int(-3, false); // intValue
  w.float(1.5);
  w.string('tag');
  w.string(null); // audioPath
  // animations
  w.int(1);
  w.string('idle');
  w.int(1); // 插槽时间线组
  w.int(0); // slotIndex
  w.int(1); // 该插槽 1 条时间线
  w.byte(0); // attachment
  w.int(2); // 2 帧
  w.float(0); w.int(1);
  w.float(1); w.int(0);
  w.int(1); // 骨骼时间线组
  w.int(1); // boneIndex
  w.int(1);
  w.byte(0); // rotate
  w.int(2);
  w.float(0).float(0).byte(2).float(0.1).float(0).float(0.9).float(1); // time,angle,贝塞尔曲线
  w.float(1.5).float(45); // 末帧不读曲线
  w.int(0); // ik
  w.int(0); // transform
  w.int(0); // path
  w.int(0); // deform
  w.int(0); // drawOrder
  w.int(1); // 事件时间线
  w.float(0.5); w.int(0); w.int(0, false); w.float(2.5); w.boolean(false);
  return w.toBuffer();
}

test('parseSkelBuffer：完整解析到文件末尾并回传结构', () => {
  const buf = buildRegionSkel();
  const r = parseSkelBuffer(buf);
  assert.equal(r.ok, true, JSON.stringify(r.issues));
  assert.equal(r.trailingBytes, 0);
  assert.equal(r.consumedBytes, buf.length);
  assert.equal(r.header.version, '3.8.75');
  assert.equal(r.header.fps, 30);
  assert.equal(r.header.audio, './audio/');
  assert.equal(r.header.images, null);
  assert.equal(r.stringCount, 2);

  assert.equal(r.counts.bones, 2);
  assert.deepEqual(r.bones.map((b) => b.name), ['root', 'head']);
  assert.equal(r.bones[0].parent, null);
  assert.equal(r.bones[1].parent, 0);
  assert.equal(r.bones[1].parentName, 'root');
  assert.equal(r.bones[1].skinRequired, true);
  assert.equal(r.bones[1].transformMode, TRANSFORM_MODES[1]);

  assert.equal(r.counts.slots, 1);
  assert.equal(r.slots[0].name, 'body');
  assert.equal(r.slots[0].boneName, 'head');
  assert.equal(r.slots[0].attachment, 'region-x');
  assert.equal(r.slots[0].blendMode, BLEND_MODES[0]);
  assert.equal(r.slots[0].hasDarkColor, false);

  assert.equal(r.counts.skins, 1);
  assert.equal(r.skins[0].name, 'default');
  assert.equal(r.counts.attachments, 1);

  assert.equal(r.counts.events, 1);
  assert.equal(r.events[0].name, 'hit');
  assert.equal(r.events[0].intValue, -3);
  assert.equal(r.events[0].floatValue, 1.5);
  assert.equal(r.events[0].stringValue, 'tag');

  assert.equal(r.counts.animations, 1);
  const anim = r.animations[0];
  assert.equal(anim.name, 'idle');
  assert.equal(anim.duration, 1.5);
  assert.equal(anim.slot, 1);
  assert.equal(anim.bone, 1);
  assert.equal(anim.event, 1);
  assert.equal(anim.timelines, 3);
  assert.equal(r.errorCount, 0);
  assert.equal(r.warningCount, 0);
});

test('parseSkelBuffer：附件类型常量与枚举对齐官方 AttachmentType 顺序', () => {
  assert.deepEqual(ATTACHMENT_TYPES, ['region', 'boundingbox', 'mesh', 'linkedmesh', 'path', 'point', 'clipping']);
  assert.deepEqual(TRANSFORM_MODES, ['normal', 'onlyTranslation', 'noRotationOrReflection', 'noScale', 'noScaleOrReflection']);
});

test('parseSkelBuffer：越界引用被记为 error 而不是抛异常', () => {
  const w = new Writer();
  w.string('h').string('3.8.75');
  w.float(0).float(0).float(1).float(1);
  w.boolean(false); // 非必要字段关闭，头部更短
  w.int(0); // 字符串表空
  w.int(1); // 1 根骨骼
  w.string('root'); w.float(0).float(0).float(0).float(1).float(1).float(0).float(0).float(1); w.int(0); w.boolean(false);
  w.int(1); // 1 个插槽
  w.string('slot'); w.int(9); w.int32(0).int32(-1).int(0).int(0); // bone 指到不存在的 9
  w.int(0).int(0).int(0); // ik/tf/path
  w.int(0); // 默认皮肤无附件
  w.int(0); // 额外皮肤
  w.int(0); // events
  w.int(0); // animations
  const r = parseSkelBuffer(w.toBuffer());
  assert.equal(r.ok, false);
  assert.equal(r.trailingBytes, 0, '结构本身应当读完');
  assert.ok(r.issues.some((i) => i.code === 'slot-bone'), JSON.stringify(r.issues));
  assert.equal(r.counts.bones, 1);
});

test('parseSkelBuffer：截断 / 尾部多字节 / 空文件都给出明确错误', () => {
  const buf = buildRegionSkel();
  const cut = parseSkelBuffer(buf.subarray(0, Math.floor(buf.length / 2)));
  assert.equal(cut.ok, false);
  assert.equal(cut.issues.some((i) => i.code === 'parse'), true);

  const extra = parseSkelBuffer(Buffer.concat([buf, Buffer.alloc(4)]));
  assert.equal(extra.ok, false);
  assert.equal(extra.trailingBytes, 4);
  assert.equal(extra.issues.some((i) => i.code === 'trailing-bytes'), true);

  const empty = parseSkelBuffer(Buffer.alloc(0));
  assert.equal(empty.ok, false);
  assert.equal(empty.bytes, 0);
});

test('parseSkelBuffer：加权 mesh 的顶点与骨骼权重被正确消费', () => {
  const w = new Writer();
  w.string('h').string('3.8.75');
  w.float(0).float(0).float(10).float(10);
  w.boolean(false);
  w.int(1);
  w.string('mesh-1');
  w.int(1);
  w.string('root'); w.float(0).float(0).float(0).float(1).float(1).float(0).float(0).float(1); w.int(0); w.boolean(false);
  w.int(1);
  w.string('slot'); w.int(0); w.int32(0).int32(-1).int(1).int(0);
  w.int(0).int(0).int(0);
  w.int(1);
  w.int(0);
  w.int(1);
  w.int(1).int(1).byte(2).int(0); // firstName、name、type=mesh、path=null
  w.int32(0); // color
  w.int(3); // vertexCount
  for (let i = 0; i < 6; i++) w.float(i * 0.1); // uvs
  w.int(3); w.short(0).short(1).short(2); // triangles
  w.boolean(true); // weighted
  for (let v = 0; v < 3; v++) { w.int(1); w.int(0); w.float(0.5); w.float(0.5); w.float(1); }
  w.int(0); // hullLength
  w.int(0); // 额外皮肤
  w.int(0); // events
  w.int(0); // animations
  const r = parseSkelBuffer(w.toBuffer());
  assert.equal(r.ok, true, JSON.stringify(r.issues));
  assert.equal(r.trailingBytes, 0);
  assert.equal(r.counts.vertices, 3);
  assert.equal(r.counts.weightedVertices, 3);
});

test('parseSkelFile：路径不存在时给出可读错误', async () => {
  await assert.rejects(() => parseSkelFile(path.join(here, 'nope.skel')), /skelPath 不存在/);
});

test('parseSkelFile：从磁盘读取并用 detail 输出完整结构', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-p13-'));
  const file = path.join(dir, 'hero.skel');
  try {
    fs.writeFileSync(file, buildRegionSkel());
    const r = await parseSkelFile(file);
    assert.equal(r.file, file);
    assert.equal(r.ok, true);
    assert.equal(r.bytes, fs.statSync(file).size);
    assert.equal(r.bones.length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('compareSkelToSkeleton：名字集合一致 / 缺失 / 多出', () => {
  const skel = parseSkelBuffer(buildRegionSkel());
  const same = compareSkelToSkeleton(skel, { bones: ['head', 'root'], slots: ['body'], animations: ['idle'] });
  assert.equal(same.ok, true);
  assert.deepEqual(same.fields, []);

  const missing = compareSkelToSkeleton(skel, { bones: ['root'], slots: ['body'], animations: ['idle'] });
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.fields, ['bones']);
  assert.equal(missing.details[0].onlyInSkel.includes('head'), true);

  const extra = compareSkelToSkeleton(skel, { bones: ['root', 'head', 'tail'], slots: ['body'], animations: ['idle', 'walk'] });
  assert.deepEqual(extra.fields.sort(), ['animations', 'bones']);
});

test('verify-export：二进制产物按文件名推导 skeleton 名并参与比对', () => {
  assert.equal(binarySkeletonName('C:/out/raptor-pro.skel'), 'raptor-pro');
  assert.equal(binarySkeletonName('hero.SKEL'), 'hero');

  const skel = parseSkelBuffer(buildRegionSkel());
  const normalized = normalizeBinarySkeleton(skel, 'D:/out/hero.skel');
  assert.equal(normalized.name, 'hero');
  assert.deepEqual(normalized.bones, ['root', 'head']);
  assert.deepEqual(normalized.slots, ['body']);
  assert.deepEqual(normalized.animations, ['idle']);

  const source = { skeletons: [{ name: 'hero', bones: ['root', 'head'], slots: ['body'], animations: ['idle'], ik: [] }] };
  const ok = compareExportSkeletons(source, [{ file: 'hero.skel', kind: 'binary', parsed: { skeletons: [normalized] } }]);
  assert.equal(ok.ok, true);
  assert.equal(ok.matched[0].kind, 'binary');

  // 源工程只有一个 skeleton 时，文件名对不上也认它
  const renamed = normalizeBinarySkeleton(skel, 'D:/out/whatever.skel');
  const sole = compareExportSkeletons({ skeletons: [source.skeletons[0]] }, [{ file: 'whatever.skel', kind: 'binary', parsed: { skeletons: [renamed] } }]);
  assert.equal(sole.ok, true);
  assert.equal(sole.matched[0].matchedBy, 'sole-skeleton');

  // 结构自检失败要拉低整体结论
  const broken = compareExportSkeletons(source, [{
    file: 'hero.skel',
    kind: 'binary',
    parsed: { skeletons: [normalized] },
    structural: { ok: false, errorCount: 1, trailingBytes: 12, issueSample: [{ code: 'trailing-bytes' }] },
  }]);
  assert.equal(broken.ok, false);
  assert.equal(broken.binaryProblems.length, 1);
});

test('工具表：spine_inspect_skel 已注册且是只读入参', () => {
  const tool = TOOLS.find((t) => t.name === 'spine_inspect_skel');
  assert.ok(tool, '缺少 spine_inspect_skel');
  assert.deepEqual(tool.inputSchema.required, ['skelPath']);
  assert.equal(tool.inputSchema.properties.skelPath.type, 'string');
  assert.equal(TOOLS.find((t) => t.name === 'spine_verify_export').inputSchema.properties.includeBinary.type, 'boolean');
});
