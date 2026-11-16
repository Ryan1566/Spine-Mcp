// 面片（mesh）结构明细：顶点、三角面、UV、每顶点骨骼权重。纯 JSON 解析，不调用 CLI、不碰 GUI、不写文件。
//
// 3.8 的 skins 是数组 [{name, attachments}]，旧格式是对象，统一走 skinEntries 适配。
// 加权 mesh 的 vertices 编码见 weight-ops.mjs：3.8.75 把骨骼下标直接写成 skeleton.bones 下标。
import { parseWeightedMesh } from './weight-ops.mjs';

const round4 = (n) => Math.round(n * 10000) / 10000;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export const DETAILS = ['summary', 'faces', 'weights'];

export function skinEntries(skeleton) {
  if (Array.isArray(skeleton?.skins)) {
    return skeleton.skins.map((skin, index) => [skin?.name ?? `(index ${index})`, skin?.attachments ?? skin]);
  }
  return Object.entries(skeleton?.skins ?? {});
}

export function* eachAttachment(skeleton) {
  for (const [skinName, attachments] of skinEntries(skeleton)) {
    if (!isObject(attachments)) continue;
    for (const [slotName, items] of Object.entries(attachments)) {
      if (!isObject(items)) continue;
      for (const [attachmentName, attachment] of Object.entries(items)) {
        if (!isObject(attachment)) continue;
        yield { skinName, slotName, attachmentName, attachment };
      }
    }
  }
}

function boneNameAt(skeleton, index) {
  return skeleton?.bones?.[index]?.name ?? null;
}

// 把一个 mesh 附件解成「顶点数组 + 三角面数组」，并把拓扑问题记进 issues
function readMesh(skeleton, ctx, att) {
  const { skinName, slotName, attachmentName } = ctx;
  const label = `${skinName}/${slotName}/${attachmentName}`;
  const issues = [];
  const add = (severity, code, message) => issues.push({ severity, code, message, skinName, slotName, attachmentName });

  const uvs = Array.isArray(att.uvs) ? att.uvs : [];
  if (uvs.length % 2 !== 0) add('error', 'mesh.uvs', `${label} 的 uvs 长度 ${uvs.length} 不是偶数`);
  const vertexCount = Math.floor(uvs.length / 2);
  if (vertexCount < 3) add('error', 'mesh.vertexCount', `${label} 只有 ${vertexCount} 个顶点，构不成面片`);

  const triangles = Array.isArray(att.triangles) ? att.triangles : [];
  if (triangles.length % 3 !== 0) add('error', 'mesh.triangles', `${label} 的 triangles 长度 ${triangles.length} 不是 3 的倍数`);
  const triangleCount = Math.floor(triangles.length / 3);
  const badIndices = triangles.filter((i) => !Number.isInteger(i) || i < 0 || i >= vertexCount);
  if (badIndices.length) add('error', 'mesh.triangles', `${label} 有 ${badIndices.length} 个越界三角形下标（顶点数 ${vertexCount}）`);

  let weighted = null;
  let parseError = null;
  try {
    weighted = parseWeightedMesh(att);
  } catch (err) {
    parseError = err.message;
    add('error', 'mesh.weights', `${label} 权重编码异常：${err.message}`);
  }

  const vertices = [];
  if (weighted) {
    for (let i = 0; i < vertexCount; i += 1) {
      const influences = (weighted.vertices[i] ?? []).map((f) => ({
        boneIndex: f.boneIndex,
        bone: boneNameAt(skeleton, f.boneIndex),
        weight: round4(f.weight),
        localX: round4(f.x),
        localY: round4(f.y),
      }));
      const sum = influences.reduce((s, f) => s + f.weight, 0);
      if (influences.length && Math.abs(sum - 1) > 0.001) {
        add('warning', 'mesh.weightSum', `${label} 顶点 ${i} 的权重和为 ${round4(sum)}，不等于 1`);
      }
      const outOfRange = influences.filter((f) => f.bone == null);
      if (outOfRange.length) add('error', 'mesh.boneIndex', `${label} 顶点 ${i} 引用了不存在的骨骼下标 ${outOfRange.map((f) => f.boneIndex).join(',')}`);
      vertices.push({
        index: i,
        uv: [round4(uvs[i * 2] ?? 0), round4(uvs[i * 2 + 1] ?? 0)],
        influences,
      });
    }
  } else {
    const values = Array.isArray(att.vertices) ? att.vertices : [];
    for (let i = 0; i < vertexCount; i += 1) {
      vertices.push({
        index: i,
        uv: [round4(uvs[i * 2] ?? 0), round4(uvs[i * 2 + 1] ?? 0)],
        xy: [round4(values[i * 2] ?? 0), round4(values[i * 2 + 1] ?? 0)],
        influences: [],
      });
    }
  }

  // 按骨骼汇总：受影响顶点数与权重和
  const boneTally = new Map();
  for (const vertex of vertices) {
    for (const f of vertex.influences) {
      const key = f.bone ?? `#${f.boneIndex}`;
      const row = boneTally.get(key) ?? { bone: key, boneIndex: f.boneIndex, vertexCount: 0, weightSum: 0 };
      if (f.weight > 0) row.vertexCount += 1;
      row.weightSum = round4(row.weightSum + f.weight);
      boneTally.set(key, row);
    }
  }
  const bones = [...boneTally.values()].sort((a, b) => b.weightSum - a.weightSum);

  const u = uvs.filter((_, i) => i % 2 === 0);
  const v = uvs.filter((_, i) => i % 2 === 1);

  return {
    row: {
      skin: skinName,
      slot: slotName,
      name: attachmentName,
      path: att.path ?? null,
      vertexCount,
      triangleCount,
      weighted: weighted != null,
      hullLength: Array.isArray(att.hull) ? att.hull.length : null,
      uvRange: u.length && v.length
        ? { u: [round4(Math.min(...u)), round4(Math.max(...u))], v: [round4(Math.min(...v)), round4(Math.max(...v))] }
        : null,
      bones,
      boneCount: bones.length,
    },
    vertices,
    triangles,
    issues,
    parseError,
  };
}

export function inspectMesh(skeleton, options = {}) {
  const { mesh: meshFilter, bone: boneFilter, detail = 'summary', limit = 50 } = options;
  if (!DETAILS.includes(detail)) throw new Error(`detail 只支持 ${DETAILS.join('/')}，收到 ${detail}`);
  if (!Number.isInteger(limit) || limit < 1) throw new Error('limit 必须是正整数');

  const issues = [];
  const meshes = [];
  const regions = [];
  let regionCount = 0;
  const skinNames = skinEntries(skeleton).map(([name]) => name);

  for (const ctx of eachAttachment(skeleton)) {
    const type = ctx.attachment.type ?? 'region';
    if (type === 'region') {
      regionCount += 1;
      regions.push({ skin: ctx.skinName, slot: ctx.slotName, name: ctx.attachmentName, width: ctx.attachment.width ?? null, height: ctx.attachment.height ?? null });
      continue;
    }
    if (type !== 'mesh') continue;
    const parsed = readMesh(skeleton, ctx, ctx.attachment);
    issues.push(...parsed.issues);
    meshes.push({ ...parsed.row, vertices: parsed.vertices, triangles: parsed.triangles });
  }

  const matches = (row) => {
    if (meshFilter == null) return true;
    if (row.name === meshFilter) return true;
    return `${row.slot}/${row.name}` === meshFilter;
  };
  const selected = meshes.filter(matches);
  if (meshFilter != null && selected.length === 0) {
    throw new Error(`工程里找不到名为 ${meshFilter} 的 mesh；现有 mesh：${meshes.slice(0, 12).map((m) => `${m.slot}/${m.name}`).join(', ')}${meshes.length > 12 ? ' …' : ''}`);
  }

  // 按骨骼反查：这根骨骼影响了哪些面片、多少顶点、权重占比多少
  let boneReport = null;
  if (boneFilter != null) {
    const hits = [];
    let totalVertices = 0;
    let totalWeight = 0;
    for (const m of selected) {
      const affected = [];
      for (const vertex of m.vertices) {
        const f = vertex.influences.find((i) => i.bone === boneFilter);
        if (f && f.weight > 0) affected.push({ index: vertex.index, weight: f.weight, uv: vertex.uv });
      }
      if (!affected.length) continue;
      const weightSum = round4(affected.reduce((s, a) => s + a.weight, 0));
      hits.push({ slot: m.slot, name: m.name, vertexCount: affected.length, ofTotal: m.vertexCount, weightSum, vertices: affected });
      totalVertices += affected.length;
      totalWeight = round4(totalWeight + weightSum);
    }
    if (hits.length === 0) {
      throw new Error(`没有面片受骨骼 ${boneFilter} 影响；请确认骨骼名（可用 spine_audit_project 或 spine_modify_bones 的 list 查看）`);
    }
    boneReport = { bone: boneFilter, meshes: hits.length, vertexCount: totalVertices, weightSum: totalWeight, detail: hits };
  }

  const totals = {
    meshes: meshes.length,
    regions: regionCount,
    vertices: meshes.reduce((s, m) => s + m.vertexCount, 0),
    triangles: meshes.reduce((s, m) => s + m.triangleCount, 0),
    weightedMeshes: meshes.filter((m) => m.weighted).length,
    hullMeshes: meshes.filter((m) => (m.hullLength ?? 0) > 0).length,
    bonesUsed: new Set(meshes.flatMap((m) => m.bones.map((b) => b.bone))).size,
  };

  const outputMeshes = selected.slice(0, limit).map((m) => {
    const row = { ...m };
    delete row.vertices;
    delete row.triangles;
    if (detail === 'faces') {
      row.faces = chunkTriangles(m.triangles, limit);
    }
    if (detail === 'weights') {
      row.vertices = m.vertices.slice(0, limit).map((vtx) => ({
        index: vtx.index,
        uv: vtx.uv,
        influences: vtx.influences.map((f) => ({ bone: f.bone, weight: f.weight })),
      }));
    }
    return row;
  });

  const result = {
    counts: totals,
    skins: skinNames,
    meshes: outputMeshes,
    truncated: selected.length > outputMeshes.length,
    selectedMeshes: selected.length,
    regionSamples: regions.slice(0, 10),
    issues,
    errorCount: issues.filter((i) => i.severity === 'error').length,
    warningCount: issues.filter((i) => i.severity === 'warning').length,
    ok: issues.filter((i) => i.severity === 'error').length === 0,
  };
  if (boneReport) result.bone = boneReport;
  if (detail === 'summary') {
    result.nextStep = '要看具体三角面或逐顶点权重，用 detail:"faces" / "weights" 再调一次；要做视觉核对，用 spine_render_preview 导出 png。';
  }
  return result;
}

function chunkTriangles(triangles, limit) {
  const faces = [];
  const count = Math.min(Math.floor(triangles.length / 3), limit);
  for (let i = 0; i < count; i += 1) faces.push([triangles[i * 3], triangles[i * 3 + 1], triangles[i * 3 + 2]]);
  return faces;
}

