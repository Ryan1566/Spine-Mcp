// P15：把 pose-eval 求出的场景画成 SVG / 自包含 HTML。纯字符串拼接，不写文件、不依赖浏览器。
//
// 约定：世界坐标 Y 向上，屏幕 Y 向下，所以画的时候统一取 -y。
// 三套包围盒要分清，否则叠图必然错位：
//   content —— 只含面片顶点 + region 可见四角，用于把线框等比贴合到渲染图前景；
//   frame   —— content 再并上骨骼（骨骼常常伸出轮廓），用于单独看图时的 viewBox；
//   bounds  —— frame 再加留白，就是最终 viewBox。

const round2 = (n) => Math.round(n * 100) / 100;
const escapeXml = (value) => String(value).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));

export const WIREFRAME_STYLE = {
  background: '#141414',
  bone: '#ff9f43',
  joint: '#ffe8cc',
  jointRing: '#ff9f43',
  region: '#4dd4f7',
  regionFill: 'rgba(139,233,253,0.16)',
  regionFrame: '#3b6b7a',
  vertex: '#ffe066',
  label: '#ffd8a8',
  faces: { saturation: 70, lightness: 60, alpha: 0.16, strokeSaturation: 85, strokeLightness: 72, strokeAlpha: 0.85 },
};

function boxOf(points) {
  if (!points.length) return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

export function sceneBoxes(scene) {
  const meshPoints = [];
  for (const m of scene.meshes ?? []) meshPoints.push(...m.points);
  const regionPoints = [];
  for (const r of scene.regions ?? []) regionPoints.push(...r.corners);
  const bonePoints = [];
  for (const b of scene.worldBones ?? []) {
    bonePoints.push({ x: b.x, y: b.y });
    if (b.length) bonePoints.push({ x: b.x + b.length * b.a, y: b.y + b.length * b.c });
  }
  const content = boxOf([...meshPoints, ...regionPoints]);
  const frame = boxOf([...meshPoints, ...regionPoints, ...bonePoints]);
  return { content, frame, counts: { meshPoints: meshPoints.length, regionPoints: regionPoints.length, bonePoints: bonePoints.length } };
}

export function sceneToSvg(scene, options = {}) {
  const {
    showFaces = true,
    showBones = true,
    showPoints = false,
    showLabels = false,
    showRegions = true,
    background = true,
    padRatio = 0.03,
    strokeScale = 1,
    style = WIREFRAME_STYLE,
    idPrefix = '',
  } = options;

  const { content, frame } = sceneBoxes(scene);
  const pad = Math.max(frame.width, frame.height) * padRatio || 1;
  const minX = frame.minX - pad;
  const minY = -frame.maxY - pad;
  const width = frame.width + pad * 2 || 1;
  const height = frame.height + pad * 2 || 1;
  // 线宽按尺度走，保证大工程和小工程看起来一样细
  const unit = Math.max(frame.width, frame.height) || 1;
  const k = strokeScale;

  const parts = [];
  if (background) {
    parts.push(`<rect x="${round2(minX)}" y="${round2(minY)}" width="${round2(width)}" height="${round2(height)}" fill="${style.background}"/>`);
  }

  if (showFaces) {
    const { saturation, lightness, alpha, strokeSaturation, strokeLightness, strokeAlpha } = style.faces;
    let index = 0;
    for (const mesh of scene.meshes ?? []) {
      const triangles = mesh.triangles ?? [];
      for (let i = 0; i + 2 < triangles.length; i += 3) {
        const a = mesh.points[triangles[i]];
        const b = mesh.points[triangles[i + 1]];
        const c = mesh.points[triangles[i + 2]];
        if (!a || !b || !c) continue;
        const hue = (index * 37) % 360;
        index += 1;
        const points = `${round2(a.x)},${round2(-a.y)} ${round2(b.x)},${round2(-b.y)} ${round2(c.x)},${round2(-c.y)}`;
        parts.push(`<polygon points="${points}" fill="hsla(${hue},${saturation}%,${lightness}%,${alpha})" stroke="hsla(${hue},${strokeSaturation}%,${strokeLightness}%,${strokeAlpha})" stroke-width="${round2((unit / 420) * k)}"/>`);
      }
    }
  }

  if (showPoints) {
    for (const mesh of scene.meshes ?? []) {
      for (const p of mesh.points) {
        parts.push(`<circle cx="${round2(p.x)}" cy="${round2(-p.y)}" r="${round2((unit / 500) * k)}" fill="${style.vertex}"/>`);
      }
    }
  }

  if (showRegions) {
    for (const region of scene.regions ?? []) {
      if (region.trimmed && region.frame) {
        const framePoints = region.frame.map((p) => `${round2(p.x)},${round2(-p.y)}`).join(' ');
        parts.push(`<polygon points="${framePoints}" fill="none" stroke="${style.regionFrame}" stroke-width="${round2((unit / 900) * k)}" stroke-dasharray="${round2((unit / 160) * k)},${round2((unit / 160) * k)}"/>`);
      }
      const points = region.corners.map((p) => `${round2(p.x)},${round2(-p.y)}`).join(' ');
      parts.push(`<polygon points="${points}" fill="${style.regionFill}" stroke="${style.region}" stroke-width="${round2((unit / 400) * k)}"/>`);
      if (showLabels) {
        const cx = region.corners.reduce((s, p) => s + p.x, 0) / 4;
        const cy = region.corners.reduce((s, p) => s + p.y, 0) / 4;
        parts.push(`<text x="${round2(cx)}" y="${round2(-cy)}" font-size="${round2((unit / 58) * k)}" fill="${style.region}" font-family="monospace" text-anchor="middle">${escapeXml(region.name)}</text>`);
      }
    }
  }

  if (showBones) {
    for (const bone of scene.worldBones ?? []) {
      if (!bone.length) continue;
      const ex = bone.x + bone.length * bone.a;
      const ey = bone.y + bone.length * bone.c;
      parts.push(`<line x1="${round2(bone.x)}" y1="${round2(-bone.y)}" x2="${round2(ex)}" y2="${round2(-ey)}" stroke="${style.bone}" stroke-width="${round2((unit / 190) * k)}" stroke-linecap="round"/>`);
    }
    for (const bone of scene.worldBones ?? []) {
      parts.push(`<circle cx="${round2(bone.x)}" cy="${round2(-bone.y)}" r="${round2((unit / 260) * k)}" fill="${style.joint}" stroke="${style.jointRing}" stroke-width="${round2((unit / 900) * k)}"/>`);
    }
  }

  if (showLabels) {
    for (const bone of scene.worldBones ?? []) {
      parts.push(`<text x="${round2(bone.x + unit / 120)}" y="${round2(-bone.y - unit / 300)}" font-size="${round2((unit / 55) * k)}" fill="${style.label}" font-family="monospace">${escapeXml(bone.name)}</text>`);
    }
  }

  const body = parts.join('');
  const viewBox = `${round2(minX)} ${round2(minY)} ${round2(width)} ${round2(height)}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="100%" preserveAspectRatio="xMidYMid meet"${idPrefix ? ` id="${escapeXml(idPrefix)}"` : ''}>${body}</svg>`;

  return {
    svg,
    body,
    viewBox,
    viewBoxNumbers: { minX: round2(minX), minY: round2(minY), width: round2(width), height: round2(height) },
    content: {
      minX: round2(content.minX),
      minY: round2(content.minY),
      width: round2(content.width),
      height: round2(content.height),
    },
    frame: {
      minX: round2(frame.minX),
      minY: round2(frame.minY),
      width: round2(frame.width),
      height: round2(frame.height),
    },
    ratio: content.height ? round2(content.width / content.height) : null,
  };
}

// 自包含 HTML 对照页。render 可选：给了就把渲染图和叠加层一起画出来。
export function sceneToHtml(scene, options = {}) {
  const { title = '骨架线框', render = null, overlay = null, subtitle = null } = options;
  const plain = sceneToSvg(scene, { ...options, idPrefix: 'frame' });
  const bonesOnly = sceneToSvg(scene, { ...options, showFaces: false, showPoints: false, showLabels: false, idPrefix: 'bones' });
  const labelled = sceneToSvg(scene, { ...options, showFaces: false, showPoints: true, showLabels: true, background: true, idPrefix: 'labelled' });

  const boneRows = (scene.worldBones ?? []).map((b) => {
    const ex = b.length ? b.x + b.length * b.a : b.x;
    const ey = b.length ? b.y + b.length * b.c : b.y;
    return `<tr><td>${escapeXml(b.name)}</td><td>${b.parentName ? escapeXml(b.parentName) : '—'}</td><td>${round2(b.x)}, ${round2(-b.y)}</td><td>${round2(ex)}, ${round2(-ey)}</td><td>${round2(b.length)}</td><td>${round2(b.local.rotation)}</td></tr>`;
  }).join('');

  const meshRows = (scene.meshes ?? []).map((m) => `<tr><td>${escapeXml(m.slot)}</td><td>${escapeXml(m.name)}</td><td>${m.points.length}</td><td>${Math.floor((m.triangles ?? []).length / 3)}</td><td>${m.weighted ? '是' : '否'}</td></tr>`).join('');

  const overlayPanel = render && overlay
    ? `<div class="panel wide">
    <h2>叠加：线框贴在渲染图上<span>按前景包围盒等比贴合，无手调偏移</span></h2>
    <div class="canvas">
      <div class="ov">
        <img src="data:image/png;base64,${render.base64}" alt="render">
        <svg viewBox="${bonesOnly.viewBox}" preserveAspectRatio="none" style="left:${overlay.left}%;top:${overlay.top}%;width:${overlay.width}%;height:${overlay.height}%">${bonesOnly.body}</svg>
      </div>
    </div>
  </div>`
    : '';

  const note = (scene.warnings ?? []).length
    ? `<p class="note">告警：${scene.warnings.map((w) => escapeXml(w)).join('；')}</p>`
    : '';

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeXml(title)}</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:#0f0f10;color:#e6e6e6;font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
header{padding:18px 24px 10px;border-bottom:1px solid #26262a}
h1{margin:0 0 4px;font-size:17px;font-weight:600}
.sub{color:#8b8b93;font-size:12.5px}
.wrap{display:grid;grid-template-columns:1fr 1fr;gap:18px;padding:18px 24px}
.panel{background:#17171a;border:1px solid #26262a;border-radius:10px;overflow:hidden;display:flex;flex-direction:column}
.panel h2{margin:0;padding:9px 14px;font-size:13px;font-weight:600;color:#bfc3cb;background:#1d1d21;border-bottom:1px solid #26262a;display:flex;justify-content:space-between;gap:12px}
.panel h2 span{color:#7d838f;font-weight:400;font-size:12px;text-align:right}
.canvas{display:flex;align-items:center;justify-content:center;background:#0b0b0c;padding:10px;min-height:340px}
.canvas img,.canvas svg{max-width:100%;max-height:460px;display:block}
.ov{position:relative;display:inline-block;line-height:0;width:min(700px,100%)}
.ov img{display:block;width:100%;height:auto}
.ov svg{position:absolute;overflow:visible;pointer-events:none}
.canvas .ov img,.canvas .ov svg{max-height:none;max-width:none}
.wide{grid-column:1 / -1}
table{width:calc(100% - 48px);margin:8px 24px 22px;border-collapse:collapse;font-size:12.5px}
th,td{text-align:left;padding:6px 10px;border-bottom:1px solid #232327}
th{color:#8b8b93;font-weight:500;background:#17171a}
td:nth-child(3),td:nth-child(4),td:nth-child(5),td:nth-child(6){font-family:ui-monospace,Consolas,monospace;color:#a9b4c2}
.scroll{overflow:auto;max-height:420px}
.legend{display:flex;gap:18px;flex-wrap:wrap;padding:12px 24px;color:#a6abb5;font-size:12.5px}
.dot{display:inline-block;width:10px;height:3px;border-radius:2px;vertical-align:middle;margin-right:6px}
.note{margin:0 24px 16px;padding:10px 14px;background:#1a222c;border-left:3px solid #4dabf7;border-radius:0 6px 6px 0;color:#b7c6d6;font-size:12.5px}
</style></head><body>
<header>
  <h1>${escapeXml(title)}</h1>
  <div class="sub">${escapeXml(subtitle ?? `姿态 ${scene.pose}${scene.animation ? ` · ${scene.animation} @ ${scene.time}s` : ''} · ${scene.meshes.length} mesh / ${scene.regions.length} region / ${scene.worldBones.length} 骨骼`)}</div>
</header>
${note}
<div class="wrap">
  ${overlayPanel}
  <div class="panel">
    <h2>线框<span>骨骼 + 三角面 + region</span></h2>
    <div class="canvas">${plain.svg}</div>
  </div>
  <div class="panel">
    <h2>骨骼 + 顶点 + 名称<span>不含面片边</span></h2>
    <div class="canvas">${labelled.svg}</div>
  </div>
  <div class="panel wide">
    <h2>骨骼端点<span>世界坐标，Y 已翻转为屏幕向下为正</span></h2>
    <div class="scroll"><table><thead><tr><th>骨骼</th><th>父级</th><th>起点</th><th>末端</th><th>长度</th><th>局部旋转</th></tr></thead><tbody>${boneRows}</tbody></table></div>
  </div>
  <div class="panel wide">
    <h2>面片<span>顶点 / 三角面 / 是否蒙皮</span></h2>
    <div class="scroll"><table><thead><tr><th>插槽</th><th>附件</th><th>顶点</th><th>三角面</th><th>加权</th></tr></thead><tbody>${meshRows}</tbody></table></div>
  </div>
</div>
<div class="legend">
  <span><i class="dot" style="background:#ff9f43"></i>骨骼（起点→末端）</span>
  <span><i class="dot" style="background:#ffe8cc"></i>骨骼起点</span>
  <span><i class="dot" style="background:#4dd4f7"></i>region 可见区域（实线）/ 完整帧（淡虚线）</span>
  <span><i class="dot" style="background:#ffe066"></i>网格顶点</span>
  <span>彩色多边形 = 三角面，每片一色便于看拓扑</span>
</div>
</body></html>`;
}
