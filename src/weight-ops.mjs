// P4b：3.8.75 网格权重的数值层操作（纯 JSON，不调用 CLI、不碰 GUI、不写源文件）。
//
// 官方格式实测：mesh.vertices 在带权重时是
//   [boneCount, boneIndex, x, y, weight, (boneIndex, x, y, weight)*, ...]（每个顶点）
// 未加权时是纯 [x, y, ...]（长度 = uvs.length）。
// 官方示例 305 个 mesh 都没有 bones 局部映射字段，boneIndex 直接是 skeleton.bones 下标；
// 这里仍兼容 att.bones 非空的旧写法（此时 boneIndex 是 att.bones 的下标）。

const round6 = (n) => Math.round(n * 1e6) / 1e6;

function* eachMesh(skeleton) {
  const skins = Array.isArray(skeleton?.skins) ? skeleton.skins : Object.values(skeleton?.skins ?? {});
  for (const skin of skins) {
    const attachments = skin?.attachments ?? skin;
    if (!attachments || typeof attachments !== 'object') continue;
    for (const [slot, items] of Object.entries(attachments)) {
      if (!items || typeof items !== 'object') continue;
      for (const [name, att] of Object.entries(items)) {
        if (att && typeof att === 'object' && att?.type === 'mesh') yield { slot, name, att };
      }
    }
  }
}

function boneName(skeleton, index) {
  return skeleton?.bones?.[index]?.name ?? null;
}

// 返回 null 表示该 mesh 未加权（纯坐标），应跳过而不是当坏数据。
export function parseWeightedMesh(att) {
  if (!Array.isArray(att?.uvs) || !Array.isArray(att?.vertices)) return null;
  const vertexCount = att.uvs.length / 2;
  if (!Number.isInteger(vertexCount) || vertexCount < 1) return null;
  const values = att.vertices;
  if (values.length === vertexCount * 2) return null; // 未加权

  const boneMap = Array.isArray(att.bones) && att.bones.length > 0 ? att.bones : null;
  const vertices = [];
  let i = 0;
  while (i < values.length) {
    const count = values[i++];
    if (!Number.isInteger(count) || count < 1 || i + count * 4 > values.length) {
      throw new Error(`mesh.vertices 编码异常：顶点数=${vertices.length + 1} 处 boneCount=${count}`);
    }
    const influences = [];
    for (let k = 0; k < count; k += 1) {
      const raw = values[i++];
      const x = values[i++];
      const y = values[i++];
      const weight = values[i++];
      influences.push({
        rawBoneIndex: raw,
        boneIndex: boneMap ? boneMap[raw] : raw,
        x,
        y,
        weight,
      });
    }
    vertices.push(influences);
  }
  if (vertices.length !== vertexCount) {
    throw new Error(`mesh.vertices 解出 ${vertices.length} 个顶点，但 uvs 表示 ${vertexCount} 个`);
  }
  return { vertexCount, vertices, boneMap };
}

function encodeWeightedMesh(parsed) {
  const values = [];
  for (const influences of parsed.vertices) {
    values.push(influences.length);
    for (const inf of influences) {
      // 用原始下标写回，保留 att.bones 映射不改动；x/y/骨骼归属一律不动。
      values.push(inf.rawBoneIndex, inf.x, inf.y, round6(inf.weight));
    }
  }
  return values;
}

function normalizeVertex(influences) {
  const sum = influences.reduce((acc, inf) => acc + (Number(inf.weight) || 0), 0);
  if (!(sum > 0)) return false;
  let acc = 0;
  for (let k = 0; k < influences.length - 1; k += 1) {
    const weight = round6(influences[k].weight / sum);
    influences[k].weight = weight;
    acc += weight;
  }
  influences[influences.length - 1].weight = round6(1 - acc);
  return true;
}

export function inspectWeights(skeleton) {
  const meshes = [];
  const issues = [];
  const usage = new Map();
  let weightedMeshCount = 0;
  let totalVertices = 0;

  for (const { slot, name, att } of eachMesh(skeleton)) {
    let parsed;
    try {
      parsed = parseWeightedMesh(att);
    } catch (err) {
      issues.push({ slot, attachment: name, reason: err.message });
      continue;
    }
    if (!parsed) {
      meshes.push({ slot, attachment: name, vertexCount: att.uvs.length / 2, weighted: false });
      continue;
    }
    weightedMeshCount += 1;
    totalVertices += parsed.vertexCount;
    let offSumVertices = 0;
    let invalidBoneRefs = 0;
    let influences = 0;
    for (const vertex of parsed.vertices) {
      const sum = vertex.reduce((acc, inf) => acc + (Number(inf.weight) || 0), 0);
      if (Math.abs(sum - 1) > 1e-4) offSumVertices += 1;
      for (const inf of vertex) {
        influences += 1;
        if (!Number.isInteger(inf.boneIndex) || inf.boneIndex < 0 || !skeleton?.bones?.[inf.boneIndex]) {
          invalidBoneRefs += 1;
          continue;
        }
        const row = usage.get(inf.boneIndex) ?? { index: inf.boneIndex, name: boneName(skeleton, inf.boneIndex), totalWeight: 0, influences: 0 };
        row.totalWeight = round6(row.totalWeight + (Number(inf.weight) || 0));
        row.influences += 1;
        usage.set(inf.boneIndex, row);
      }
    }
    if (offSumVertices) issues.push({ slot, attachment: name, reason: `${offSumVertices} 个顶点权重和不为 1` });
    if (invalidBoneRefs) issues.push({ slot, attachment: name, reason: `${invalidBoneRefs} 处骨骼下标无效` });
    meshes.push({
      slot,
      attachment: name,
      vertexCount: parsed.vertexCount,
      weighted: true,
      influences,
      offSumVertices,
      invalidBoneRefs,
    });
  }

  return {
    meshCount: meshes.length,
    weightedMeshCount,
    totalVertices,
    issueCount: issues.length,
    issues,
    meshes,
    boneUsage: [...usage.values()].sort((a, b) => a.index - b.index),
  };
}

function resolveBoneIndex(skeleton, bone) {
  if (Number.isInteger(bone) && bone >= 0) {
    if (!skeleton?.bones?.[bone]) throw new Error(`骨骼下标不存在: ${bone}`);
    return bone;
  }
  if (typeof bone === 'string' && bone) {
    const index = (skeleton?.bones ?? []).findIndex((b) => b?.name === bone);
    if (index < 0) throw new Error(`骨骼名不存在: ${bone}`);
    return index;
  }
  throw new Error('scale 模式需要 bone（骨骼名字符串或全局下标整数）');
}

export function editWeights(skeleton, { mode = 'inspect', bone, factor } = {}) {
  if (mode === 'inspect') return { report: inspectWeights(skeleton) };
  if (mode !== 'normalize' && mode !== 'scale') {
    throw new Error(`未知 mode: ${mode}（可用 inspect / normalize / scale）`);
  }
  let targetIndex = null;
  if (mode === 'scale') {
    targetIndex = resolveBoneIndex(skeleton, bone);
    if (typeof factor !== 'number' || !Number.isFinite(factor) || factor <= 0) {
      throw new Error('factor 必须是大于 0 的有限数字');
    }
  }

  const json = structuredClone(skeleton);
  const warnings = [];
  let changedMeshes = 0;
  let changedVertices = 0;
  let scaledInfluences = 0;

  for (const { slot, name, att } of eachMesh(json)) {
    let parsed;
    try {
      parsed = parseWeightedMesh(att);
    } catch (err) {
      warnings.push(`${slot}/${name}: ${err.message}，已跳过`);
      continue;
    }
    if (!parsed) continue;
    let meshChanged = false;
    for (const influences of parsed.vertices) {
      let hit = false;
      if (mode === 'scale') {
        for (const inf of influences) {
          if (inf.boneIndex === targetIndex) {
            inf.weight = inf.weight * factor;
            scaledInfluences += 1;
            hit = true;
          }
        }
        if (!hit) continue;
      }
      if (!normalizeVertex(influences)) {
        warnings.push(`${slot}/${name}: 存在权重和 <= 0 的顶点，已跳过`);
        continue;
      }
      changedVertices += 1;
      meshChanged = true;
    }
    if (meshChanged) {
      att.vertices = encodeWeightedMesh(parsed);
      changedMeshes += 1;
    }
  }

  return {
    json,
    summary: {
      mode,
      targetBone: targetIndex === null ? null : { index: targetIndex, name: boneName(json, targetIndex) },
      factor: mode === 'scale' ? factor : null,
      changedMeshes,
      changedVertices,
      scaledInfluences,
      warnings,
    },
  };
}
