import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseWeightedMesh, inspectWeights, editWeights } from '../src/weight-ops.mjs';
import { TOOLS } from '../src/tools.mjs';

const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.mjs');

function weightedSkeleton() {
  return {
    skeleton: { spine: '3.8.75' },
    bones: [
      { name: 'root' }, { name: 'body' }, { name: 'head' }, { name: 'weapon' },
      { name: 'extra1' }, { name: 'extra2' }, { name: 'extra3' },
    ],
    slots: [],
    skins: [{
      name: 'default',
      attachments: {
        weapon_slot: {
          sword: {
            type: 'mesh',
            uvs: [0, 0, 1, 0, 1, 1], // 3 个顶点
            // 顶点0: bone3 0.7 + bone1 0.2（和=0.9）；顶点1: bone1 1.0；顶点2: bone2 0.5 + bone3 0.5
            vertices: [2, 3, 1, 2, 0.7, 1, 3, 4, 0.2, 1, 1, 5, 6, 1, 2, 2, 7, 8, 0.5, 3, 9, 10, 0.5],
            triangles: [0, 1, 2],
          },
        },
      },
    }],
    animations: {},
  };
}

const meshAtt = (skeleton) => skeleton.skins[0].attachments.weapon_slot.sword;
const vertexSum = (parsed, i) => parsed.vertices[i].reduce((s, inf) => s + inf.weight, 0);

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'spine-weights-'));
}

function runServer(messages) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serverPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, SPINE_EXE: '' },
    });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', () => {
      try {
        resolve(out.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)));
      } catch (err) {
        reject(new Error(`${err.message}\nstdout=${out}`));
      }
    });
    child.stdin.write(`${messages.map((m) => JSON.stringify(m)).join('\n')}\n`);
    child.stdin.end();
  });
}

test('parseWeightedMesh：解析 3.8 编码，未加权返回 null', () => {
  const parsed = parseWeightedMesh(meshAtt(weightedSkeleton()));
  assert.equal(parsed.vertexCount, 3);
  assert.equal(parsed.vertices.length, 3);
  assert.equal(parsed.vertices[0].length, 2);
  assert.equal(parsed.vertices[0][0].boneIndex, 3);
  assert.equal(parsed.vertices[0][0].x, 1);
  assert.equal(parsed.vertices[0][0].weight, 0.7);
  const plain = { type: 'mesh', uvs: [0, 0, 1, 0], vertices: [1, 2, 3, 4] };
  assert.equal(parseWeightedMesh(plain), null);
  assert.throws(() => parseWeightedMesh({ type: 'mesh', uvs: [0, 0], vertices: [9, 1, 2, 3] }), /编码异常|解出/);
});

test('parseWeightedMesh：兼容 att.bones 局部映射', () => {
  const att = meshAtt(weightedSkeleton());
  att.bones = [3, 1, 2];
  att.vertices = [2, 0, 1, 2, 0.7, 1, 3, 4, 0.2, 1, 1, 5, 6, 1, 2, 2, 7, 8, 0.5, 0, 9, 10, 0.5];
  const parsed = parseWeightedMesh(att);
  assert.equal(parsed.vertices[0][0].boneIndex, 3);
  assert.equal(parsed.vertices[0][0].rawBoneIndex, 0);
  assert.equal(parsed.vertices[2][1].boneIndex, 3);
});

test('inspectWeights：权重和异常、骨骼使用汇总', () => {
  const report = inspectWeights(weightedSkeleton());
  assert.equal(report.meshCount, 1);
  assert.equal(report.weightedMeshCount, 1);
  assert.equal(report.totalVertices, 3);
  assert.equal(report.meshes[0].offSumVertices, 1);
  assert.ok(report.issueCount >= 1);
  assert.ok(report.boneUsage.some((b) => b.index === 3 && b.name === 'weapon'));
});

test('normalize：只改权重数值，不动坐标与骨骼归属', () => {
  const source = weightedSkeleton();
  const { json, summary } = editWeights(source, { mode: 'normalize' });
  const parsed = parseWeightedMesh(meshAtt(json));
  assert.equal(vertexSum(parsed, 0), 1);
  assert.equal(vertexSum(parsed, 1), 1);
  assert.equal(vertexSum(parsed, 2), 1);
  assert.equal(parsed.vertices[0][0].x, 1);
  assert.equal(parsed.vertices[0][0].boneIndex, 3);
  assert.equal(summary.changedVertices, 3);
  assert.equal(meshAtt(source).vertices[4], 0.7); // 源对象未改
});

test('scale：按骨骼名/下标缩放后逐顶点归一化', () => {
  const byName = editWeights(weightedSkeleton(), { mode: 'scale', bone: 'weapon', factor: 1.5 });
  assert.equal(byName.summary.targetBone.index, 3);
  assert.equal(byName.summary.scaledInfluences, 2);
  assert.equal(byName.summary.changedVertices, 2);
  const parsed = parseWeightedMesh(meshAtt(byName.json));
  assert.equal(vertexSum(parsed, 0), 1);
  assert.ok(Math.abs(parsed.vertices[0][0].weight - 0.84) < 1e-6); // 1.05 / 1.25
  assert.ok(Math.abs(parsed.vertices[2][1].weight - 0.6) < 1e-6); // 0.75 / 1.25
  assert.equal(editWeights(weightedSkeleton(), { mode: 'scale', bone: 3, factor: 0.5 }).summary.scaledInfluences, 2);
  assert.throws(() => editWeights(weightedSkeleton(), { mode: 'scale', bone: 'ghost', factor: 2 }), /骨骼名不存在/);
  assert.throws(() => editWeights(weightedSkeleton(), { mode: 'scale', bone: 3, factor: 0 }), /factor/);
  assert.throws(() => editWeights(weightedSkeleton(), { mode: 'unknown' }), /未知 mode/);
});

test('stdio 集成：inspect 只读，normalize/scale 写副本', async () => {
  const dir = tempDir();
  const source = path.join(dir, 'weighted.json');
  const normalized = path.join(dir, 'normalized.json');
  const scaled = path.join(dir, 'scaled.json');
  fs.writeFileSync(source, JSON.stringify(weightedSkeleton(), null, 2));
  try {
    const responses = await runServer([
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'spine_edit_weights', arguments: { sourceJsonPath: source, mode: 'inspect' } } },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'spine_edit_weights', arguments: { sourceJsonPath: source, mode: 'normalize', outputJsonPath: normalized } } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'spine_edit_weights', arguments: { sourceJsonPath: normalized, mode: 'scale', bone: 'weapon', factor: 1.2, outputJsonPath: scaled } } },
    ]);
    assert.equal(responses.find((r) => r.id === 1).result.tools.length, TOOLS.length);
    assert.ok(TOOLS.some((t) => t.name === 'spine_edit_weights'));
    const inspected = responses.find((r) => r.id === 2).result;
    assert.equal(inspected.isError, false);
    assert.equal(inspected.structuredContent.meshes[0].offSumVertices, 1);
    const norm = responses.find((r) => r.id === 3).result;
    assert.equal(norm.isError, false);
    assert.match(norm.structuredContent.nextStep, /Import Data/);
    assert.equal(parseWeightedMesh(meshAtt(JSON.parse(fs.readFileSync(normalized, 'utf8')))).vertices[0].reduce((s, x) => s + x.weight, 0), 1);
    const scale = responses.find((r) => r.id === 4).result;
    assert.equal(scale.isError, false);
    assert.equal(scale.structuredContent.scaledInfluences, 2);
    assert.equal(JSON.parse(fs.readFileSync(source, 'utf8')).skins[0].attachments.weapon_slot.sword.vertices[4], 0.7);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
