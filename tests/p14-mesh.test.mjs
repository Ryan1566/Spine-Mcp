import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectMesh, skinEntries, eachAttachment, DETAILS } from '../src/mesh-inspect.mjs';
import { previewOutputBase, renderPreview } from '../src/render-preview.mjs';
import { TOOLS } from '../src/tools.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const existingFile = path.join(here, '..', 'fixtures', 'hero.json');

// 4 顶点四边形，每顶点绑同一根骨骼（boneIndex=1），权重和为 1
const quadWeighted = {
  type: 'mesh',
  uvs: [0, 0, 1, 0, 1, 1, 0, 1],
  triangles: [0, 1, 2, 0, 2, 3],
  vertices: [1, 1, 0, 0, 1, 1, 1, 0, 0, 1, 1, 1, 0, 0, 1, 1, 1, 0, 0, 1],
};
// 未加权：vertices 长度 = 顶点数 * 2
const quadPlain = {
  type: 'mesh',
  uvs: [0, 0, 1, 0, 1, 1, 0, 1],
  triangles: [0, 1, 2, 0, 2, 3],
  vertices: [0, 0, 10, 0, 10, 10, 0, 10],
};
const region = { width: 64, height: 32, x: 1, y: 2 };

function skeletonWith(attachments) {
  return {
    bones: [{ name: 'root' }, { name: 'body' }, { name: 'head' }],
    slots: [{ name: 'slot_a', bone: 'body' }],
    skins: [{ name: 'default', attachments }],
  };
}

test('inspectMesh：统计顶点 / 三角面 / 加权状态与骨骼汇总', () => {
  const sk = skeletonWith({ slot_a: { quad: quadWeighted, flat: quadPlain, icon: region } });
  const r = inspectMesh(sk);
  assert.equal(r.ok, true, JSON.stringify(r.issues));
  assert.equal(r.counts.meshes, 2);
  assert.equal(r.counts.regions, 1);
  assert.equal(r.counts.vertices, 8);
  assert.equal(r.counts.triangles, 4);
  assert.equal(r.counts.weightedMeshes, 1);

  const quad = r.meshes.find((m) => m.name === 'quad');
  assert.equal(quad.vertexCount, 4);
  assert.equal(quad.triangleCount, 2);
  assert.equal(quad.weighted, true);
  assert.deepEqual(quad.bones.map((b) => b.bone), ['body']);
  assert.equal(quad.bones[0].vertexCount, 4);
  assert.equal(quad.bones[0].weightSum, 4);
  assert.deepEqual(quad.uvRange, { u: [0, 1], v: [0, 1] });

  const flat = r.meshes.find((m) => m.name === 'flat');
  assert.equal(flat.weighted, false);
  assert.deepEqual(flat.bones, []);
});

test('inspectMesh：detail=faces 给三角面索引，detail=weights 给逐顶点权重', () => {
  const sk = skeletonWith({ slot_a: { quad: quadWeighted } });
  const faces = inspectMesh(sk, { detail: 'faces' });
  assert.deepEqual(faces.meshes[0].faces, [[0, 1, 2], [0, 2, 3]]);
  assert.equal(faces.meshes[0].vertices, undefined);

  const weights = inspectMesh(sk, { detail: 'weights' });
  assert.equal(weights.meshes[0].vertices.length, 4);
  assert.deepEqual(weights.meshes[0].vertices[0].influences, [{ bone: 'body', weight: 1 }]);
  assert.deepEqual(weights.meshes[0].vertices[0].uv, [0, 0]);
});

test('inspectMesh：mesh 过滤支持附件名与 slot/附件名', () => {
  const sk = skeletonWith({ slot_a: { quad: quadWeighted, flat: quadPlain } });
  assert.equal(inspectMesh(sk, { mesh: 'quad' }).selectedMeshes, 1);
  assert.equal(inspectMesh(sk, { mesh: 'slot_a/flat' }).selectedMeshes, 1);
  assert.throws(() => inspectMesh(sk, { mesh: 'nope' }), /找不到名为 nope 的 mesh/);
});

test('inspectMesh：按骨骼反查影响的面片与顶点', () => {
  const sk = skeletonWith({ slot_a: { quad: quadWeighted, flat: quadPlain } });
  const r = inspectMesh(sk, { bone: 'body' });
  assert.equal(r.bone.bone, 'body');
  assert.equal(r.bone.meshes, 1);
  assert.equal(r.bone.vertexCount, 4);
  assert.equal(r.bone.weightSum, 4);
  assert.deepEqual(r.bone.detail[0].vertices.map((v) => v.index), [0, 1, 2, 3]);
  assert.equal(r.bone.detail[0].ofTotal, 4);
  assert.throws(() => inspectMesh(sk, { bone: 'head' }), /没有面片受骨骼 head 影响/);
});

test('inspectMesh：拓扑与权重问题进 issues 而不是抛异常', () => {
  const bad = {
    type: 'mesh',
    uvs: [0, 0, 1, 0, 1, 1],
    triangles: [0, 1, 9], // 9 越界
    vertices: [1, 1, 0, 0, 0.5, 1, 1, 0, 0, 0.5, 1, 1, 0, 0, 0.5], // 权重和 1.5
  };
  const sk = skeletonWith({ slot_a: { bad } });
  const r = inspectMesh(sk);
  assert.equal(r.ok, false);
  const codes = r.issues.map((i) => i.code);
  assert.ok(codes.includes('mesh.triangles'), codes.join(','));
  assert.ok(codes.includes('mesh.weightSum'), codes.join(','));
  assert.equal(r.errorCount, 1);
  assert.equal(r.warningCount, 3, '3 个顶点各报一条权重和异常');
});

test('inspectMesh：detail / limit 参数校验', () => {
  const sk = skeletonWith({ slot_a: { quad: quadWeighted } });
  assert.throws(() => inspectMesh(sk, { detail: 'everything' }), /detail 只支持/);
  assert.throws(() => inspectMesh(sk, { limit: 0 }), /limit 必须是正整数/);
  const limited = inspectMesh(sk, { limit: 1 });
  assert.equal(limited.meshes.length, 1);
});

test('skinEntries / eachAttachment：兼容数组式与字典式 skins', () => {
  const arrayForm = { skins: [{ name: 'default', attachments: { s: { a: region } } }] };
  assert.deepEqual(skinEntries(arrayForm).map(([n]) => n), ['default']);
  assert.equal([...eachAttachment(arrayForm)].length, 1);

  const objectForm = { skins: { default: { s: { a: region } } } };
  assert.deepEqual(skinEntries(objectForm).map(([n]) => n), ['default']);
  assert.equal([...eachAttachment(objectForm)].length, 1);
});

test('previewOutputBase：png+all 当目录，其余用工程基名', () => {
  const proj = 'D:/proj/raptor-pro.spine';
  assert.equal(previewOutputBase(proj, 'D:/out', 'png', 'all'), 'D:/out');
  assert.equal(previewOutputBase(proj, 'D:/out', 'png', 'single'), path.join('D:/out', 'raptor-pro'));
  assert.equal(previewOutputBase(proj, 'D:/out', 'mov', 'all'), path.join('D:/out', 'raptor-pro'));
});

test('renderPreview：dryRun 只返回计划，不建目录也不调 CLI', async () => {
  const outDir = path.join(os.tmpdir(), `spine-preview-dry-${Date.now()}`);
  const r = await renderPreview({ projectPath: existingFile, outputDir: outDir, dryRun: true });
  assert.equal(r.dryRun, true);
  assert.equal(r.success, false);
  assert.equal(r.exitCode, null);
  assert.equal(r.format, 'png');
  assert.equal(r.animationType, 'all');
  assert.equal(r.outputKind, 'directory');
  assert.equal(r.outputPath, outDir);
  assert.equal(r.count, 0);
  const fs = await import('node:fs');
  assert.equal(fs.existsSync(outDir), false, 'dryRun 不应创建输出目录');
});

test('renderPreview：参数校验先于任何写入', async () => {
  await assert.rejects(() => renderPreview({ projectPath: path.join(here, 'nope.spine'), outputDir: os.tmpdir(), dryRun: true }), /projectPath 不存在/);
  await assert.rejects(() => renderPreview({ projectPath: existingFile, outputDir: '', dryRun: true }), /outputDir 必须是非空字符串/);
  await assert.rejects(() => renderPreview({ projectPath: existingFile, outputDir: os.tmpdir(), format: 'json', dryRun: true }), /format 只支持/);
});

test('工具表：面片与预览工具已注册', () => {
  const mesh = TOOLS.find((t) => t.name === 'spine_inspect_mesh');
  assert.ok(mesh, '缺少 spine_inspect_mesh');
  assert.deepEqual(mesh.inputSchema.required, ['jsonPath']);
  assert.deepEqual(mesh.inputSchema.properties.detail.enum, DETAILS);

  const preview = TOOLS.find((t) => t.name === 'spine_render_preview');
  assert.ok(preview, '缺少 spine_render_preview');
  assert.deepEqual(preview.inputSchema.required, ['projectPath', 'outputDir']);
  assert.deepEqual(preview.inputSchema.properties.format.enum, ['png', 'mov', 'avi', 'gif']);
  assert.deepEqual(preview.inputSchema.properties.animationType.enum, ['all', 'single', 'current']);
});
