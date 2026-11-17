import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  atlasFromReport,
  animationDuration,
  boneEnd,
  computeWorldBones,
  easedPercent,
  evaluateScene,
  listAnimations,
  poseAtTime,
  regionQuad,
  sampleTimeline,
  setupPose,
} from '../src/pose-eval.mjs';
import { sceneBoxes, sceneToHtml, sceneToSvg } from '../src/wireframe.mjs';
import { readPng, foregroundMask, pixelAt } from '../src/png-read.mjs';
import { alignCheck, makeProjector } from '../src/align-check.mjs';
import { TOOLS } from '../src/tools.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const hero = JSON.parse(fs.readFileSync(path.join(here, '..', 'fixtures', 'hero.json'), 'utf8'));

// ---------- 极简 PNG 编码器（只为测 readPng / alignCheck，不引入依赖） ----------
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();
const crc32 = (buf) => {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
};
function makePng(width, height, paint) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = paint(x, y);
      const i = y * (stride + 1) + 1 + x * 4;
      raw[i] = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
      raw[i + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// 10x10 世界单位的四边形，绑在 root 上（root 无平移无旋转，世界坐标＝局部坐标）
const quadMesh = { type: 'mesh', uvs: [0, 0, 1, 0, 1, 1, 0, 1], triangles: [0, 1, 2, 0, 2, 3], vertices: [0, 0, 10, 0, 10, 10, 0, 10] };

function skeletonOf({ bones = [{ name: 'root' }], slots = [], skins = null, animations = {} } = {}) {
  return { skeleton: { spine: '3.8.75' }, bones, slots, skins: skins ?? { default: {} }, animations };
}

// ---------- 时间线采样 ----------
test('sampleTimeline：线性插值、端点与越界静止', () => {
  const keys = [{ time: 0, angle: -2 }, { time: 0.5, angle: 2 }, { time: 1, angle: -2 }];
  const read = (k) => [k.angle];
  assert.deepEqual(sampleTimeline(keys, 0, read), [-2]);
  assert.equal(sampleTimeline(keys, 0.25, read)[0], 0);
  assert.equal(sampleTimeline(keys, 0.5, read)[0], 2);
  assert.equal(sampleTimeline(keys, 0.75, read)[0], 0);
  assert.deepEqual(sampleTimeline(keys, 1, read), [-2]);
  // 超出末尾按最后一帧静止延续
  assert.deepEqual(sampleTimeline(keys, 9, read), [-2]);
  // 早于首帧取首帧
  assert.deepEqual(sampleTimeline([{ time: 1, angle: 7 }], 0, read), [7]);
});

test('sampleTimeline：curve="stepped" 取左端点，不插值', () => {
  const keys = [{ time: 0, angle: 0, curve: 'stepped' }, { time: 1, angle: 10 }];
  assert.equal(sampleTimeline(keys, 0.5, (k) => [k.angle])[0], 0);
  assert.equal(sampleTimeline(keys, 0.99, (k) => [k.angle])[0], 0);
  assert.equal(sampleTimeline(keys, 1, (k) => [k.angle])[0], 10);
});

test('easedPercent：3.8 的贝塞尔控制点在 curve + c2/c3/c4 上，不在数组里', () => {
  // 端点必须恒等
  assert.equal(easedPercent({ curve: 0.25 }, 0), 0);
  assert.equal(easedPercent({ curve: 0.25 }, 1), 1);
  // 非对称控制点：前段被拉快，中点缓动值应明显大于 0.5
  const eased = easedPercent({ curve: 0.1, c2: 0.9, c3: 1, c4: 1 }, 0.5);
  assert.ok(eased > 0.6, `曲线中点应被推后，实得 ${eased}`);
  // 对称控制点 (0,0)-(1,1) 时中点应接近 0.5
  const symmetric = easedPercent({ curve: 0, c2: 0, c3: 1, c4: 1 }, 0.5);
  assert.ok(Math.abs(symmetric - 0.5) < 0.02, `对称曲线中点应接近 0.5，实得 ${symmetric}`);
  // 缺省 c2/c3/c4 取 0/1/1
  assert.equal(easedPercent({ curve: 0.5 }, 0.5), easedPercent({ curve: 0.5, c2: 0, c3: 1, c4: 1 }, 0.5));
});

test('easedPercent：兼容四点数组写法，linear 原样返回', () => {
  assert.equal(easedPercent({ curve: [0.42, 0, 0.58, 1] }, 0.5), easedPercent({ curve: 0.42, c2: 0, c3: 0.58, c4: 1 }, 0.5));
  assert.equal(easedPercent({}, 0.37), 0.37);
  assert.equal(easedPercent({}, 2), 1);
  assert.equal(easedPercent({}, -1), 0);
});

// ---------- 姿态与世界变换 ----------
test('poseAtTime：时间线值相对 setup 相加，不是绝对值', () => {
  const skeleton = skeletonOf({
    bones: [{ name: 'root', rotation: 30 }, { name: 'arm', parent: 'root' }],
    animations: { swing: { bones: { root: { rotate: [{ time: 0, angle: -2 }, { time: 1, angle: 2 }] } } } },
  });
  const anim = skeleton.animations.swing;
  assert.equal(poseAtTime(skeleton, anim, 0).pose[0].rotation, 28, 'setup 30 + (-2) = 28');
  assert.equal(poseAtTime(skeleton, anim, 1).pose[0].rotation, 32, 'setup 30 + 2 = 32');
  // 无动画时原样返回 setup
  assert.equal(setupPose(skeleton.bones)[0].rotation, 30);
});

test('poseAtTime：scale 相乘、shear / translate 相加', () => {
  const skeleton = skeletonOf({
    bones: [{ name: 'root', scaleX: 2, scaleY: 3, shearX: 5, shearY: 7, x: 10, y: 20 }],
    animations: {
      a: {
        bones: {
          root: {
            scale: [{ time: 0, x: 1.5, y: 0.5 }],
            shear: [{ time: 0, x: 2, y: -1 }],
            translate: [{ time: 0, x: 4, y: -6 }],
          },
        },
      },
    },
  });
  const local = poseAtTime(skeleton, skeleton.animations.a, 0).pose[0];
  assert.equal(local.scaleX, 3);
  assert.equal(local.scaleY, 1.5);
  assert.equal(local.shearX, 7);
  assert.equal(local.shearY, 6);
  assert.equal(local.x, 14);
  assert.equal(local.y, 14);
});

test('computeWorldBones：parent 是骨骼名字符串（回归：早期按数组下标取导致全变根骨骼）', () => {
  const skeleton = skeletonOf({
    bones: [
      { name: 'root' },
      { name: 'mid', parent: 'root', x: 10, y: 0 },
      { name: 'tip', parent: 'mid', x: 10, y: 0 },
    ],
  });
  const { world, problems } = computeWorldBones(skeleton, setupPose(skeleton.bones));
  assert.deepEqual(problems, []);
  assert.equal(world[1].x, 10);
  assert.equal(world[2].x, 20, '孙骨骼必须累乘两级父级平移');
  assert.equal(world[2].parentName, 'mid');
});

test('computeWorldBones：rotation=90 时子级沿世界 +y 方向平移', () => {
  const skeleton = skeletonOf({
    bones: [
      { name: 'root', rotation: 90 },
      { name: 'child', parent: 'root', x: 5, y: 0 },
    ],
  });
  const { world } = computeWorldBones(skeleton, setupPose(skeleton.bones));
  assert.equal(round(world[1].x), 0);
  assert.equal(round(world[1].y), 5);
});

test('computeWorldBones：父级名字不存在时记问题而不是静默错位', () => {
  const skeleton = skeletonOf({ bones: [{ name: 'root' }, { name: 'orphan', parent: 'nope', x: 3 }] });
  const { problems } = computeWorldBones(skeleton, setupPose(skeleton.bones));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /父级 "nope" 不存在/);
});

test('boneEnd：沿本地 +x 走 length', () => {
  const bone = { x: 1, y: 2, a: 0, b: -1, c: 1, d: 0, length: 5 };
  assert.deepEqual(boneEnd(bone), { x: 1, y: 7 });
});

// ---------- region 裁剪 ----------
test('regionQuad：按 atlas 的 size/orig/offset 还原可见区域，而不是整帧', () => {
  // 武器：附件 128×128，图集里只有 42×6，偏移 (59,61)
  const quad = regionQuad({ width: 128, height: 128 }, { size: [42, 6], orig: [128, 128], offset: [59, 61] });
  assert.equal(quad.trimmed, true);
  assert.equal(round(quad.x1), -5, '-64 + 59');
  assert.equal(round(quad.y1), -3, '-64 + 61');
  assert.equal(round(quad.x2 - quad.x1), 42);
  assert.equal(round(quad.y2 - quad.y1), 6);
});

test('regionQuad：没有 atlas 信息时退化为完整帧', () => {
  const quad = regionQuad({ width: 20, height: 10 }, null);
  assert.deepEqual(quad, { x1: -10, y1: -5, x2: 10, y2: 5, trimmed: false });
});

test('atlasFromReport：把 inspectAtlas 结果转成 regionQuad 需要的形状', () => {
  const map = atlasFromReport({
    pages: [{ regions: [{ name: 'sword', width: 42, height: 6, originalWidth: 128, originalHeight: 128, offsetX: 59, offsetY: 61, rotate: false }] }],
  });
  assert.deepEqual(map.get('sword'), { size: [42, 6], orig: [128, 128], offset: [59, 61], rotate: false });
});

// ---------- 附件时间线 ----------
test('evaluateScene：attachment 时间线切换附件、清空 slot、首帧之前用 setup 附件', () => {
  const skeleton = skeletonOf({
    bones: [{ name: 'root' }],
    slots: [{ name: 'eye', bone: 'root', attachment: 'eye_open' }],
    skins: {
      default: {
        eye: {
          eye_open: { width: 10, height: 10 },
          eye_closed: { width: 10, height: 2 },
          sword: { width: 4, height: 4 },
        },
      },
    },
    animations: {
      blink: { slots: { eye: { attachment: [{ time: 0.5, name: 'eye_closed' }, { time: 0.9, name: null }] } } },
    },
  });
  const namesAt = (t) => evaluateScene(skeleton, { animation: 'blink', time: t }).regions.map((r) => r.name);
  assert.deepEqual(namesAt(0), ['eye_open'], '首帧之前/首帧用 setup 附件');
  assert.deepEqual(namesAt(0.5), ['eye_closed']);
  assert.deepEqual(namesAt(0.95), [], 'name=null 表示该 slot 清空');
});

test('evaluateScene：不修改传入的 skeleton JSON', () => {
  const skeleton = skeletonOf({
    bones: [{ name: 'root' }],
    slots: [{ name: 'eye', bone: 'root', attachment: 'a' }],
    skins: { default: { eye: { a: { width: 4, height: 4 }, b: { width: 8, height: 8 } } } },
    animations: { swap: { slots: { eye: { attachment: [{ time: 0, name: 'b' }] } } } },
  });
  const before = JSON.stringify(skeleton);
  evaluateScene(skeleton, { animation: 'swap', time: 0 });
  assert.equal(JSON.stringify(skeleton), before);
});

// ---------- 场景 ----------
test('evaluateScene：setup 与动画时刻给出不同姿态，权重顶点用世界骨骼加权', () => {
  const skeleton = skeletonOf({
    bones: [{ name: 'root' }, { name: 'b1', parent: 'root' }],
    slots: [{ name: 'q', bone: 'root', attachment: 'quad' }],
    skins: {
      default: {
        q: {
          quad: {
            type: 'mesh',
            uvs: [0, 0, 1, 0, 1, 1, 0, 1],
            triangles: [0, 1, 2, 0, 2, 3],
            // 顶点 0、1 全绑 b1（下标 1），局部 (0,0)/(10,0)；顶点 2、3 绑 root
            vertices: [1, 1, 0, 0, 1, 1, 1, 10, 0, 1, 1, 0, 0, 0, 1, 1, 1, 10, 0, 1],
          },
        },
      },
    },
    animations: { move: { bones: { b1: { translate: [{ time: 0, x: 0, y: 0 }, { time: 1, x: 0, y: 20 }] } } } },
  });
  const at0 = evaluateScene(skeleton, { animation: 'move', time: 0 });
  const at1 = evaluateScene(skeleton, { animation: 'move', time: 1 });
  assert.equal(at0.meshes[0].weighted, true);
  assert.equal(at0.meshes[0].points[1].y, 0);
  assert.equal(at1.meshes[0].points[1].y, 20, 'b1 上移 20，顶点 1 跟着上移');
  assert.equal(at1.meshes[0].points[2].y, 0, '绑 root 的顶点不动');
  assert.equal(evaluateScene(skeleton).pose, 'setup');
});

test('evaluateScene：参数与动画名校验', () => {
  assert.throws(() => evaluateScene({}), /缺少 bones/);
  assert.throws(() => evaluateScene(hero, { time: -1 }), /time 必须是非负/);
  assert.throws(() => evaluateScene(hero, { animation: 'nope' }), /动画不存在: nope/);
});

test('animationDuration / listAnimations：取所有时间线最大 time', () => {
  assert.equal(animationDuration(hero.animations.idle), 1);
  const list = listAnimations(hero);
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'idle');
  assert.equal(list[0].duration, 1);
  assert.equal(animationDuration(null), 0);
});

// ---------- SVG ----------
test('sceneToSvg：骨骼/关节/三角面/region 都画出来，关掉就不出现', () => {
  const scene = evaluateScene(hero, { animation: 'idle', time: 0.25 });
  // hero 的纹理只有 region 没有 mesh，补一个带 mesh 的场景测三角面
  const withMesh = skeletonOf({
    bones: [{ name: 'root', length: 10 }],
    slots: [{ name: 'q', bone: 'root', attachment: 'quad' }],
    skins: { default: { q: { quad: quadMesh } } },
  });
  const meshScene = evaluateScene(withMesh);
  const svg = sceneToSvg(meshScene);
  assert.match(svg.svg, /^<svg xmlns=/);
  assert.match(svg.body, /<line /, '骨骼线');
  assert.match(svg.body, /<circle /, '关节');
  assert.match(svg.body, /<polygon /, '三角面');
  const noBones = sceneToSvg(meshScene, { showBones: false });
  assert.doesNotMatch(noBones.body, /<line /);
  const noFaces = sceneToSvg(meshScene, { showFaces: false });
  assert.doesNotMatch(noFaces.body, /hsla\(/);
  // region 场景
  const regionSvg = sceneToSvg(scene);
  assert.match(regionSvg.body, /<polygon /);
  assert.ok(scene.regions.length > 0);
});

test('sceneBoxes：content 不含骨骼，frame 含骨骼，frame ⊇ content', () => {
  const skeleton = skeletonOf({
    bones: [{ name: 'root', length: 100 }],
    slots: [{ name: 'q', bone: 'root', attachment: 'quad' }],
    skins: { default: { q: { quad: quadMesh } } },
  });
  const scene = evaluateScene(skeleton);
  const { content, frame } = sceneBoxes(scene);
  assert.equal(content.width, 10);
  assert.ok(frame.width >= content.width);
  assert.equal(frame.maxX, 100, '骨骼末端伸出面片之外，必须算进 frame');
});

test('sceneToHtml：自包含页面包含 SVG 与骨骼表', () => {
  const scene = evaluateScene(hero, { animation: 'idle', time: 0 });
  const html = sceneToHtml(scene, { title: '测试页' });
  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(html, /<title>测试页<\/title>/);
  assert.match(html, /<svg /);
  assert.match(html, /head<\/td>/);
});

// ---------- PNG ----------
test('readPng：解码 RGBA、取像素、算前景包围盒（按与角落颜色差）', () => {
  const png = makePng(20, 20, (x, y) => (x >= 2 && x <= 17 && y >= 2 && y <= 17 ? [255, 255, 255, 255] : [10, 10, 10, 255]));
  const decoded = readPng(png);
  assert.equal(decoded.width, 20);
  assert.equal(decoded.channels, 4);
  assert.deepEqual(pixelAt(decoded, 5, 5), { r: 255, g: 255, b: 255, a: 255 });
  assert.deepEqual(pixelAt(decoded, 0, 0), { r: 10, g: 10, b: 10, a: 255 });
  const fg = foregroundMask(decoded);
  assert.equal(fg.mode, 'color', '全不透明时按颜色差判定');
  assert.deepEqual(fg.box, { minX: 2, minY: 2, maxX: 17, maxY: 17, width: 16, height: 16 });
  assert.equal(fg.count, 256);
});

test('readPng：透明背景按 alpha 判定；非 PNG 报错', () => {
  const png = makePng(8, 8, (x, y) => (x < 4 ? [255, 0, 0, 255] : [0, 0, 0, 0]));
  const decoded = readPng(png);
  const fg = foregroundMask(decoded);
  assert.equal(fg.mode, 'alpha');
  assert.equal(fg.box.width, 4);
  assert.throws(() => readPng(Buffer.from('not a png at all')), /签名不符/);
});

// ---------- 对齐校验 ----------
test('makeProjector：内容盒等比贴合前景盒，Y 轴翻转正确', () => {
  const project = makeProjector({ minX: 0, minY: 0, width: 10, height: 10 }, { minX: 0, minY: 0, width: 20, height: 20 });
  assert.deepEqual(project.point({ x: 0, y: 10 }), { x: 0, y: 0 }, '世界最上方 → 像素最上方');
  assert.deepEqual(project.point({ x: 10, y: 0 }), { x: 20, y: 20 });
});

test('alignCheck：面片正好铺满前景时应判定贴合良好、IoU 接近 1', () => {
  const skeleton = skeletonOf({
    bones: [{ name: 'root' }],
    slots: [{ name: 'q', bone: 'root', attachment: 'quad' }],
    skins: { default: { q: { quad: quadMesh } } },
  });
  const png = readPng(makePng(20, 20, (x, y) => (x >= 2 && x <= 17 && y >= 2 && y <= 17 ? [255, 255, 255, 255] : [10, 10, 10, 255])));
  const scene = evaluateScene(skeleton);
  const result = alignCheck({ scene, png });
  assert.equal(result.ok, true);
  assert.ok(result.maskIou > 0.95, `IoU 应接近 1，实得 ${result.maskIou}`);
  assert.equal(result.centroid.hits, 1);
  assert.equal(result.verdict, '贴合良好');
  assert.deepEqual(result.foreground.box, { minX: 2, minY: 2, maxX: 17, maxY: 17, width: 16, height: 16 });
});

test('alignCheck：画面全空时明确报错而不是给 0 分', () => {
  const png = readPng(makePng(10, 10, () => [0, 0, 0, 255]));
  const scene = evaluateScene(hero);
  const result = alignCheck({ scene, png });
  assert.equal(result.ok, false);
  assert.match(result.reason, /没找到前景像素/);
});

// ---------- 工具注册 ----------
test('工具表：两个 P15 工具已注册且必填项正确', () => {
  const wire = TOOLS.find((t) => t.name === 'spine_get_wireframe');
  const align = TOOLS.find((t) => t.name === 'spine_align_check');
  assert.ok(wire, 'spine_get_wireframe 必须存在');
  assert.ok(align, 'spine_align_check 必须存在');
  assert.deepEqual(wire.inputSchema.required, ['jsonPath']);
  assert.deepEqual(align.inputSchema.required, ['jsonPath', 'renderPng']);
  assert.deepEqual(wire.inputSchema.properties.format.enum, ['summary', 'svg', 'html']);
  assert.equal(TOOLS.length, 41);
});

function round(n) {
  return Math.round(n * 1e6) / 1e6;
}
