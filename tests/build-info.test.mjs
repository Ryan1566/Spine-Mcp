import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  LIVE_WINDOW_MS,
  STATE_DIR,
  currentRuntime,
  listRuntimeStates,
  recordRuntime,
  sourceFingerprint,
} from '../src/build-info.mjs';

test('源码指纹覆盖 src 下所有 .mjs，且多次计算稳定', () => {
  const a = sourceFingerprint();
  const b = sourceFingerprint();
  assert.match(a.hash, /^[0-9a-f]{12}$/);
  assert.equal(a.hash, b.hash);
  assert.equal(a.fileCount, Object.keys(a.files).length);
  assert.ok(a.files['index.mjs'], 'index.mjs 必须进指纹');
  assert.ok(a.files['server.mjs'], 'server.mjs 必须进指纹');
  assert.ok(a.newest.file, '应能报出最新改动的文件');
});

test('currentRuntime 在同一进程内只算一次', () => {
  const first = currentRuntime();
  const second = currentRuntime();
  assert.equal(first, second, '应返回同一个缓存对象');
  assert.equal(first.pid, process.pid);
  assert.match(first.sourceHash, /^[0-9a-f]{12}$/);
});

test('recordRuntime 落盘后能被 listRuntimeStates 读到，心跳过期后算已退出', () => {
  const state = recordRuntime({ toolCount: 9, toolNames: ['spine_doctor'] });
  const file = path.join(STATE_DIR, `server-${process.pid}.json`);
  try {
    assert.ok(fs.existsSync(file), '应写出 server-<pid>.json');
    const mine = listRuntimeStates().find((item) => item.pid === process.pid);
    assert.ok(mine, '当前进程的指纹应出现在列表里');
    assert.equal(mine.alive, true);
    assert.equal(mine.sourceHash, state.sourceHash);
    assert.equal(mine.toolCount, 9);
    assert.deepEqual(mine.toolNames, ['spine_doctor']);

    // 心跳过期（mtime 推到很久以前）= 进程已经退出，不得再被当成活实例
    const past = new Date(Date.now() - LIVE_WINDOW_MS * 4);
    fs.utimesSync(file, past, past);
    const expired = listRuntimeStates().find((item) => item.pid === process.pid);
    assert.equal(expired.alive, false);
  } finally {
    fs.rmSync(file, { force: true });
  }
});
