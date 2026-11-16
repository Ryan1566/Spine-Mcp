// P15：线框 ↔ 渲染图的对齐校验。不靠肉眼，出可比较的数字。
//
// 做法：把线框的内容包围盒（面片顶点 + region 可见四角）等比映射到渲染图的前景包围盒，
// 然后统计三件事：
//   1) 骨骼沿线采样点落在前景像素内的比例（随机基准 = 前景像素占全图的比例）；
//   2) 每个面片重心是否落在前景内；
//   3) 三角面覆盖掩膜与前景掩膜的 IoU —— 这个指标能区分「姿态算对了」和「只是碰巧落在轮廓里」。
import { foregroundMask } from './png-read.mjs';
import { sceneBoxes } from './wireframe.mjs';

const round4 = (n) => Math.round(n * 10000) / 10000;
const round3 = (n) => Math.round(n * 1000) / 1000;

// 世界坐标 → 像素。content 是场景内容盒（世界单位），fgBox 是渲染图前景盒（像素）。
export function makeProjector(content, fgBox) {
  const sx = content.width ? fgBox.width / content.width : 1;
  const sy = content.height ? fgBox.height / content.height : 1;
  const topY = content.minY + content.height; // 世界坐标里最上面那条线
  return {
    sx,
    sy,
    x: (wx) => fgBox.minX + (wx - content.minX) * sx,
    y: (wy) => fgBox.minY + (topY - wy) * sy,
    point: (p) => ({ x: fgBox.minX + (p.x - content.minX) * sx, y: fgBox.minY + (topY - p.y) * sy }),
  };
}

function rasterizeTriangles(scene, project, width, height) {
  const mask = new Uint8Array(width * height);
  let filled = 0;
  for (const mesh of scene.meshes ?? []) {
    const triangles = mesh.triangles ?? [];
    for (let t = 0; t + 2 < triangles.length; t += 3) {
      const a = mesh.points[triangles[t]];
      const b = mesh.points[triangles[t + 1]];
      const c = mesh.points[triangles[t + 2]];
      if (!a || !b || !c) continue;
      const pa = project.point(a);
      const pb = project.point(b);
      const pc = project.point(c);
      const minX = Math.max(0, Math.floor(Math.min(pa.x, pb.x, pc.x)));
      const maxX = Math.min(width - 1, Math.ceil(Math.max(pa.x, pb.x, pc.x)));
      const minY = Math.max(0, Math.floor(Math.min(pa.y, pb.y, pc.y)));
      const maxY = Math.min(height - 1, Math.ceil(Math.max(pa.y, pb.y, pc.y)));
      const denom = (pb.y - pc.y) * (pa.x - pc.x) + (pc.x - pb.x) * (pa.y - pc.y);
      if (Math.abs(denom) < 1e-9) continue;
      for (let y = minY; y <= maxY; y += 1) {
        for (let x = minX; x <= maxX; x += 1) {
          // 用像素中心采样：前景盒宽 16 覆盖像素 2..17，连续坐标是 [2,18)，中心在 2.5..17.5
          const sx = x + 0.5;
          const sy = y + 0.5;
          const w1 = ((pb.y - pc.y) * (sx - pc.x) + (pc.x - pb.x) * (sy - pc.y)) / denom;
          const w2 = ((pc.y - pa.y) * (sx - pc.x) + (pa.x - pc.x) * (sy - pc.y)) / denom;
          const w3 = 1 - w1 - w2;
          if (w1 < -0.001 || w2 < -0.001 || w3 < -0.001) continue;
          const index = y * width + x;
          if (!mask[index]) {
            mask[index] = 1;
            filled += 1;
          }
        }
      }
    }
  }
  return { mask, filled };
}

function iou(a, b) {
  let intersection = 0;
  let union = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (x && y) intersection += 1;
    if (x || y) union += 1;
  }
  return union ? round4(intersection / union) : null;
}

export function alignCheck({ scene, png, samples = 25, tolerance = 10, hitRadius = 1 } = {}) {
  if (!scene) throw new Error('alignCheck 需要 scene');
  if (!png) throw new Error('alignCheck 需要 png');

  const fg = foregroundMask(png, { tolerance });
  if (!fg.count) {
    return {
      ok: false,
      reason: '渲染图里没找到前景像素（整张图都是背景色），无法对齐；请确认导出时背景色与角色不同',
      foreground: { count: 0, ratio: null },
    };
  }

  const { content, frame } = sceneBoxes(scene);
  if (!content.width || !content.height) {
    return { ok: false, reason: '线框内容包围盒为空（没有面片也没有 region）', foreground: { count: fg.count } };
  }

  const project = makeProjector(content, fg.box);
  const at = (x, y) => {
    const px = Math.round(x);
    const py = Math.round(y);
    if (px < 0 || py < 0 || px >= png.width || py >= png.height) return 0;
    return fg.mask[py * png.width + px];
  };
  const hit = (x, y) => {
    for (let dy = -hitRadius; dy <= hitRadius; dy += 1) {
      for (let dx = -hitRadius; dx <= hitRadius; dx += 1) {
        if (at(x + dx, y + dy)) return true;
      }
    }
    return false;
  };

  const bones = [];
  for (const bone of scene.worldBones ?? []) {
    if (!bone.length) continue;
    const ex = bone.x + bone.length * bone.a;
    const ey = bone.y + bone.length * bone.c;
    let hits = 0;
    for (let i = 0; i <= samples; i += 1) {
      const t = i / samples;
      const p = project.point({ x: bone.x + (ex - bone.x) * t, y: bone.y + (ey - bone.y) * t });
      if (hit(p.x, p.y)) hits += 1;
    }
    bones.push({ bone: bone.name, coverage: round3(hits / (samples + 1)) });
  }
  const boneAverage = bones.length ? round4(bones.reduce((s, b) => s + b.coverage, 0) / bones.length) : null;

  let centroidHits = 0;
  const meshCentroids = [];
  for (const mesh of scene.meshes ?? []) {
    if (!mesh.points.length) continue;
    const cx = mesh.points.reduce((s, p) => s + p.x, 0) / mesh.points.length;
    const cy = mesh.points.reduce((s, p) => s + p.y, 0) / mesh.points.length;
    const p = project.point({ x: cx, y: cy });
    const ok = Boolean(at(p.x, p.y));
    if (ok) centroidHits += 1;
    meshCentroids.push({ slot: mesh.slot, name: mesh.name, ok });
  }

  const raster = rasterizeTriangles(scene, project, png.width, png.height);
  const maskIou = iou(raster.mask, fg.mask);

  const fgRatio = round4(fg.count / (png.width * png.height));
  const worst = bones.slice().sort((a, b) => a.coverage - b.coverage);

  const overlay = {
    left: round3((fg.box.minX / png.width) * 100),
    top: round3((fg.box.minY / png.height) * 100),
    width: round3((fg.box.width / png.width) * 100),
    height: round3((fg.box.height / png.height) * 100),
  };

  return {
    ok: true,
    foreground: {
      mode: fg.mode,
      count: fg.count,
      ratio: fgRatio,
      box: fg.box,
      image: { width: png.width, height: png.height },
    },
    content: { minX: round4(content.minX), minY: round4(content.minY), width: round4(content.width), height: round4(content.height) },
    frame: { minX: round4(frame.minX), minY: round4(frame.minY), width: round4(frame.width), height: round4(frame.height) },
    scale: { pxPerUnitX: round4(project.sx), pxPerUnitY: round4(project.sy) },
    ratio: { content: round4(content.width / content.height), foreground: round4(fg.ratio) },
    boneAverage,
    boneHitCount: bones.filter((b) => b.coverage > 0).length,
    boneTotal: bones.length,
    worstBones: worst.slice(0, 5),
    bones,
    centroid: { hits: centroidHits, total: meshCentroids.length, detail: meshCentroids },
    maskIou,
    trianglePixels: raster.filled,
    baseline: fgRatio,
    overlay,
    verdict: verdictOf({ boneAverage, maskIou, centroid: { hits: centroidHits, total: meshCentroids.length } }),
  };
}

function verdictOf({ boneAverage, maskIou, centroid }) {
  // 工程里没有带 length 的骨骼时 boneAverage 为 null，不能因此把结论降级
  const bonesOk = boneAverage == null || boneAverage >= 0.9;
  if (maskIou != null && maskIou >= 0.6 && bonesOk) return '贴合良好';
  if (maskIou != null && maskIou >= 0.4) return '大致贴合，姿态或裁剪有偏差';
  if (bonesOk && centroid.total && centroid.hits === centroid.total) return '骨骼都在轮廓内，但面片覆盖不一致，优先怀疑 deform 或约束未参与计算';
  return '对不上，检查渲染图与 skeleton 是否同一工程 / 同一动画时刻';
}
