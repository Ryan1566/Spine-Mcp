import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { modifyConstraints } from '../src/structure-ops.mjs';
import { TOOLS } from '../src/tools.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const heroPath = path.join(here, '..', 'fixtures', 'hero.json');
const serverPath = path.join(here, '..', 'src', 'index.mjs');
const hero = () => JSON.parse(fs.readFileSync(heroPath, 'utf8'));

function runServer(messages) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serverPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, SPINE_EXE: '' },
    });
    let out = '';
    let errOut = '';
    child.stdout.on('data', (chunk) => { out += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { errOut += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', () => {
      try {
        resolve(out.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line)));
      } catch (error) {
        reject(new Error(`${error.message}\nstdout=${out}\nstderr=${errOut}`));
      }
    });
    child.stdin.write(`${messages.map((message) => JSON.stringify(message)).join('\n')}\n`);
    child.stdin.end();
  });
}

// hero fixture 带 root/body/head/weapon 四根骨骼、idle 动画，正好用来挂三类约束。
function skeletonWithConstraints() {
  const skeleton = hero();
  skeleton.ik = [{ name: 'head_ik', bones: ['head'], target: 'weapon', mix: 0.5, bendPositive: true }];
  skeleton.transform = [{ name: 'body_tf', bones: ['body'], target: 'root', x: 1, y: 2, rotateMix: 1, scaleMix: 1 }];
  skeleton.path = [{ name: 'weapon_path', bones: ['weapon'], target: 'weapon', spacingMode: 'percent', spacing: 0.1 }];
  skeleton.animations.idle.ik = { head_ik: [{ mix: 0.2 }, { time: 0.5, mix: 1 }] };
  skeleton.animations.idle.transform = { body_tf: [{ time: 0, rotateMix: 0 }] };
  return skeleton;
}

test('modifyConstraints：list 返回三类约束与动画引用', () => {
  const report = modifyConstraints(skeletonWithConstraints(), { mode: 'list' });
  assert.deepEqual(report.counts, { ik: 1, transform: 1, path: 1 });
  const ik = report.constraints.find((item) => item.type === 'ik');
  assert.equal(ik.definition.name, 'head_ik');
  assert.deepEqual(ik.animations, [{ animation: 'idle', keyframes: 2 }]);
  const onlyPaths = modifyConstraints(skeletonWithConstraints(), { mode: 'list', type: 'path' });
  assert.deepEqual(onlyPaths.counts, { ik: 0, transform: 0, path: 1 });
  assert.throws(() => modifyConstraints(skeletonWithConstraints(), { mode: 'list', type: 'bogus' }), /未知约束类型/);
});

test('modifyConstraints：add 校验骨骼、枚举与未知字段', () => {
  const source = skeletonWithConstraints();
  const added = modifyConstraints(source, {
    mode: 'add',
    type: 'ik',
    constraint: { name: 'weapon_ik', bones: ['weapon'], target: 'root', mix: 0.75 },
  });
  assert.deepEqual(added.summary.added, [{ name: 'weapon_ik', bones: ['weapon'], target: 'root' }]);
  assert.equal(added.json.ik.length, 2);
  assert.equal(source.ik.length, 1, '不能改到源对象');

  assert.throws(() => modifyConstraints(source, { mode: 'add', type: 'ik', constraint: { name: 'head_ik', bones: ['head'], target: 'root' } }), /已存在/);
  assert.throws(() => modifyConstraints(source, { mode: 'add', type: 'ik', constraint: { name: 'x', bones: ['ghost'], target: 'root' } }), /骨骼不存在/);
  assert.throws(() => modifyConstraints(source, { mode: 'add', type: 'ik', constraint: { name: 'x', bones: [], target: 'root' } }), /非空骨骼名数组/);
  assert.throws(() => modifyConstraints(source, { mode: 'add', type: 'ik', constraint: { name: 'x', bones: ['head'] } }), /必须提供 bones 与 target/);
  assert.throws(() => modifyConstraints(source, { mode: 'add', type: 'path', constraint: { name: 'p', bones: ['weapon'], target: 'weapon', spacingMode: 'bogus' } }), /spacingMode 只支持/);
  assert.throws(() => modifyConstraints(source, { mode: 'add', type: 'transform', constraint: { name: 't', bones: ['body'], target: 'root', mix: 1 } }), /不支持字段 mix/);
  assert.throws(() => modifyConstraints(source, { mode: 'add', type: 'ik', constraint: { name: 'x', bones: ['head'], target: 'root', order: -1 } }), /非负整数/);
});

test('modifyConstraints：remove 受动画引用保护，可显式清理轨道', () => {
  const source = skeletonWithConstraints();
  assert.throws(() => modifyConstraints(source, { mode: 'remove', type: 'ik', name: 'head_ik' }), /仍有动画引用/);
  const dropped = modifyConstraints(source, { mode: 'remove', type: 'ik', name: 'head_ik', dropAnimationTracks: true });
  assert.equal(dropped.json.ik.length, 0);
  assert.equal(dropped.json.animations.idle.ik.head_ik, undefined);
  assert.deepEqual(dropped.summary.droppedAnimationTracks, [{ animation: 'idle', keyframes: 2 }]);
  // 没有动画引用的约束可以直接删
  const clean = modifyConstraints(source, { mode: 'remove', type: 'path', name: 'weapon_path' });
  assert.equal(clean.json.path.length, 0);
  assert.throws(() => modifyConstraints(source, { mode: 'remove', type: 'path', name: 'nope' }), /约束不存在/);
});

test('modifyConstraints：rename 同步动画轨道键名', () => {
  const renamed = modifyConstraints(skeletonWithConstraints(), { mode: 'rename', type: 'ik', name: 'head_ik', newName: 'head_look' });
  assert.equal(renamed.json.ik[0].name, 'head_look');
  assert.deepEqual(Object.keys(renamed.json.animations.idle.ik), ['head_look']);
  assert.equal(renamed.json.animations.idle.ik.head_look.length, 2);
  // 约束名按类型分命名空间：body_tf 属于 transform，ik 里可以重名；真正冲突的是同类同名。
  const source = skeletonWithConstraints();
  source.ik.push({ name: 'weapon_ik', bones: ['weapon'], target: 'root' });
  assert.throws(() => modifyConstraints(source, { mode: 'rename', type: 'ik', name: 'head_ik', newName: 'weapon_ik' }), /已存在/);
  assert.throws(() => modifyConstraints(skeletonWithConstraints(), { mode: 'rename', type: 'ik', name: 'head_ik', newName: '带 空格' }), /1-128 位/);
});

test('modifyConstraints：set 白名单字段、path 目标提示与空变更', () => {
  const source = skeletonWithConstraints();
  const updated = modifyConstraints(source, {
    mode: 'set',
    type: 'ik',
    name: 'head_ik',
    constraint: { mix: 0.25, bendPositive: false, order: 3 },
  });
  const ik = updated.json.ik.find((entry) => entry.name === 'head_ik');
  assert.equal(ik.mix, 0.25);
  assert.equal(ik.bendPositive, false);
  // 3.8 导入要求 order 从 0 开始、跨类型连续（否则抛 Missing constraint order: 0），
  // 所以写操作后按数组位置重排：head_ik 落到 0（省略），body_tf=1，weapon_path=2。
  assert.equal(ik.order, undefined);
  assert.equal(updated.json.transform[0].order, 1);
  assert.equal(updated.json.path[0].order, 2);
  assert.ok(updated.summary.reordered.some((item) => item.name === 'head_ik' && item.to === 0));
  assert.ok(updated.summary.warnings.some((text) => /Missing constraint order/.test(text)));
  assert.deepEqual(updated.summary.updated, [{ name: 'head_ik', fields: ['mix', 'bendPositive', 'order'] }]);

  const pathSet = modifyConstraints(source, {
    mode: 'set',
    type: 'path',
    name: 'weapon_path',
    constraint: { target: 'weapon', spacingMode: 'length', rotateMode: 'chain', spacing: 0.25 },
  });
  const pathEntry = pathSet.json.path[0];
  assert.equal(pathEntry.spacingMode, 'length');
  assert.equal(pathEntry.rotateMode, 'chain');
  // weapon 骨骼上的插槽没有 type=path 附件，应给出提示而不是报错
  assert.ok(pathSet.summary.warnings.some((item) => /type=path/.test(item)));

  const empty = modifyConstraints(source, { mode: 'set', type: 'ik', name: 'head_ik', constraint: {} });
  assert.ok(empty.summary.warnings.some((item) => /没有可修改字段/.test(item)));
  assert.throws(() => modifyConstraints(source, { mode: 'set', type: 'ik', name: 'head_ik', constraint: { scaleMix: 1 } }), /不支持字段 scaleMix/);
  assert.throws(() => modifyConstraints(source, { mode: 'set', type: 'ik', name: 'head_ik', constraint: { target: 'ghost' } }), /骨骼不存在/);
});

test('stdio 集成：写操作必须给 outputJsonPath，dryRun 不落盘', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-p10-'));
  const sourcePath = path.join(dir, 'source.json');
  const outputPath = path.join(dir, 'out.json');
  const dryOutputPath = path.join(dir, 'dry.json');
  fs.writeFileSync(sourcePath, `${JSON.stringify(skeletonWithConstraints(), null, 2)}\n`);
  try {
    const responses = await runServer([
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'spine_edit_constraints', arguments: { sourceJsonPath: sourcePath, mode: 'list' } } },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'spine_edit_constraints', arguments: { sourceJsonPath: sourcePath, mode: 'set', type: 'ik', name: 'head_ik', constraint: { mix: 0.1 } } } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'spine_edit_constraints', arguments: { sourceJsonPath: sourcePath, outputJsonPath: dryOutputPath, mode: 'rename', type: 'ik', name: 'head_ik', newName: 'head_look', dryRun: true } } },
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'spine_edit_constraints', arguments: { sourceJsonPath: sourcePath, outputJsonPath: outputPath, mode: 'rename', type: 'ik', name: 'head_ik', newName: 'head_look' } } },
    ]);
    assert.equal(responses.find((item) => item.id === 1).result.tools.length, TOOLS.length);
    assert.ok(TOOLS.some((tool) => tool.name === 'spine_edit_constraints'));

    const listed = responses.find((item) => item.id === 2).result.structuredContent;
    assert.deepEqual(listed.counts, { ik: 1, transform: 1, path: 1 });

    const rejected = responses.find((item) => item.id === 3);
    assert.match(JSON.stringify(rejected), /必须提供 outputJsonPath/);

    const dry = responses.find((item) => item.id === 4).result.structuredContent;
    assert.equal(dry.dryRun, true);
    assert.equal(dry.wouldWrite, true);
    assert.deepEqual(dry.renamed, [{ from: 'head_ik', to: 'head_look' }]);
    assert.equal(fs.existsSync(dryOutputPath), false);

    const written = responses.find((item) => item.id === 5).result.structuredContent;
    assert.equal(written.writtenTo, outputPath);
    assert.deepEqual(written.constraintNames, ['head_look']);
    const json = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    assert.equal(json.ik[0].name, 'head_look');
    assert.deepEqual(Object.keys(json.animations.idle.ik), ['head_look']);
    // 源文件必须保持原样
    assert.equal(JSON.parse(fs.readFileSync(sourcePath, 'utf8')).ik[0].name, 'head_ik');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
