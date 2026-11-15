import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, '..', 'src', 'index.mjs');
const fixturePath = path.join(here, '..', 'fixtures', 'hero.json');

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
    child.on('close', (code) => {
      let responses;
      try {
        responses = out.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
      } catch (err) {
        reject(new Error(`stdout 出现非 MCP 消息：${err.message}\nstdout=${out}\nstderr=${errOut}`));
        return;
      }
      resolve({ responses, stderr: errOut, code });
    });
    child.stdin.write(`${messages.map((m) => JSON.stringify(m)).join('\n')}\n`);
    child.stdin.end();
  });
}

const byId = (responses, id) => responses.find((r) => r.id === id);

test('stdio 双时代协议握手与工具调用', async () => {
  const { responses, stderr, code } = await runServer([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'spine_frames_to_seconds', arguments: { fps: 12, frames: 8, eventFrames: [{ frame: 3, name: 'hit' }] } } },
    { jsonrpc: '2.0', id: 4, method: 'server/discover', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } } },
    { jsonrpc: '2.0', id: 5, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } } },
    { jsonrpc: '2.0', id: 6, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '1900-01-01' } } },
    { jsonrpc: '2.0', id: 7, method: 'no/such/method', params: {} },
    { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'spine_export', arguments: { inputPath: fixturePath, outputDir: 'C:/out' } } },
  ]);

  assert.equal(code, 0, `服务端应正常退出，stderr=${stderr}`);
  assert.equal(responses.length, 8, '通知不应产生响应，其余 8 个请求各 1 条');

  const init = byId(responses, 1).result;
  assert.equal(init.protocolVersion, '2025-06-18');
  assert.deepEqual(init.capabilities.tools, {});
  assert.equal(init.serverInfo.name, 'spine-mcp-local');

  const tools = byId(responses, 2).result.tools;
  assert.equal(tools.length, 8);
  assert.ok(tools.some((t) => t.name === 'spine_build_combat_animation'));
  assert.ok(tools.every((t) => t.inputSchema && t.inputSchema.type === 'object'));

  const call = byId(responses, 3).result;
  assert.equal(call.isError, false);
  assert.equal(call.content[0].type, 'text');
  assert.equal(call.structuredContent.rows[2].timeSec, 0.166667);
  assert.deepEqual(call.structuredContent.rows[2].events, ['hit']);

  const discover = byId(responses, 4).result;
  assert.equal(discover.resultType, 'complete');
  assert.deepEqual(discover.supportedVersions, ['2026-07-28']);
  assert.deepEqual(discover.capabilities.tools, {});

  assert.equal(byId(responses, 5).result.tools.length, 8);
  assert.equal(byId(responses, 6).error.code, -32022);
  assert.deepEqual(byId(responses, 6).error.data.supported, ['2026-07-28']);
  assert.equal(byId(responses, 7).error.code, -32601);

  const badExport = byId(responses, 8).result;
  assert.equal(badExport.isError, true);
  assert.match(badExport.structuredContent.error, /exportSettingsPath|非空字符串/);
});
