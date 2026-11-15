import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveGuiExe, detectGuiLock, requestGuiReload } from '../src/gui-link.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const existingFile = path.join(here, '..', 'fixtures', 'hero.json');
const serverPath = path.join(here, '..', 'src', 'index.mjs');

// 假的 spawn：只发 'spawn' 事件，绝不真的启动 Spine GUI。
function fakeSpawn() {
  const child = new EventEmitter();
  child.pid = 4321;
  child.unref = () => {};
  process.nextTick(() => child.emit('spawn'));
  return child;
}

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
        resolve(out.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)));
      } catch (err) {
        reject(new Error(`${err.message}\nstdout=${out}\nstderr=${errOut}`));
      }
    });
    child.stdin.write(`${messages.map((m) => JSON.stringify(m)).join('\n')}\n`);
    child.stdin.end();
  });
}

test('resolveGuiExe：从 SPINE_EXE 同目录推导 Spine.exe', () => {
  const dir = path.join('D:', 'Spine', 'bin');
  const cli = path.join(dir, 'Spine.com');
  assert.equal(resolveGuiExe({ SPINE_EXE: cli }), path.join(dir, 'Spine.exe'));
});

test('resolveGuiExe：显式 SPINE_GUI_EXE 优先，缺配置时抛错', () => {
  assert.equal(resolveGuiExe({ SPINE_EXE: 'D:/a/Spine.com', SPINE_GUI_EXE: 'D:/b/Spine.exe' }), 'D:/b/Spine.exe');
  assert.throws(() => resolveGuiExe({}), /未配置 SPINE_EXE/);
});

test('dryRun 只返回计划，不启动任何进程', async () => {
  const forbid = () => { throw new Error('dryRun 不应调用 spawn'); };
  const result = await requestGuiReload({
    projectPath: existingFile,
    dryRun: true,
    env: {},
    spawnImpl: forbid,
  });
  assert.equal(result.launched, false);
  assert.equal(result.pid, null);
  assert.equal(result.strategy, 'editor-open');
  assert.deepEqual(result.args, [existingFile]);
  assert.equal(result.guiExe, null);
  assert.match(result.warning, /未配置 SPINE_EXE/);
});

test('真实执行返回启动结果（spawn 被注入，不碰 GUI）', async () => {
  const result = await requestGuiReload({
    projectPath: existingFile,
    env: { SPINE_GUI_EXE: process.execPath },
    spawnImpl: fakeSpawn,
  });
  assert.equal(result.launched, true);
  assert.equal(result.pid, 4321);
  assert.deepEqual(result.args, [existingFile]);
});

test('工程路径不存在时拒绝执行', async () => {
  await assert.rejects(
    () => requestGuiReload({ projectPath: path.join(here, 'nope.spine'), dryRun: true, env: {}, spawnImpl: fakeSpawn }),
    /projectPath 不存在/,
  );
});

test('stdio 集成：spine_reload_gui 已注册且 dryRun 不启动 GUI', async () => {
  const responses = await runServer([
    { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'spine_reload_gui', arguments: { projectPath: existingFile, dryRun: true } } },
  ]);
  const tools = responses.find((r) => r.id === 1).result.tools;
  assert.ok(tools.some((t) => t.name === 'spine_reload_gui'));
  const call = responses.find((r) => r.id === 2).result;
  assert.equal(call.isError, false);
  assert.equal(call.structuredContent.launched, false);
  assert.equal(call.structuredContent.strategy, 'editor-open');
  assert.equal(typeof call.structuredContent.guiRunning, 'boolean');
  assert.equal(typeof call.structuredContent.wouldBlock, 'boolean');
});

test('detectGuiLock：无用户目录或锁文件不存在时不判定为运行中', () => {
  assert.equal(detectGuiLock({}).guiRunning, false);
  assert.equal(detectGuiLock({ USERPROFILE: path.join(here, 'no-such-home') }).guiRunning, false);
});

test('已有 GUI 实例时默认阻止启动，不产生无效进程', async () => {
  const forbid = () => { throw new Error('GUI 运行时不应调用 spawn'); };
  const running = { guiRunning: true, lockPath: 'C:/fake/Spine/.lock', reason: 'test' };
  const result = await requestGuiReload({
    projectPath: existingFile,
    env: { SPINE_GUI_EXE: process.execPath },
    spawnImpl: forbid,
    lockProbe: () => running,
  });
  assert.equal(result.blocked, true);
  assert.equal(result.wouldBlock, true);
  assert.equal(result.launched, false);
  assert.match(result.hint, /单实例锁/);
});

test('allowWhenRunning=true 时仍会尝试启动', async () => {
  const result = await requestGuiReload({
    projectPath: existingFile,
    allowWhenRunning: true,
    env: { SPINE_GUI_EXE: process.execPath },
    spawnImpl: fakeSpawn,
    lockProbe: () => ({ guiRunning: true, lockPath: 'C:/fake/Spine/.lock', reason: 'test' }),
  });
  assert.equal(result.blocked, false);
  assert.equal(result.launched, true);
});
