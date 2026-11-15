// stdio 传输：stdin 每行一条 JSON-RPC 消息，stdout 只输出合法 MCP 消息，日志一律走 stderr。
import fs from 'node:fs';
import readline from 'node:readline';
import { recordRuntime } from './build-info.mjs';
import { handle, SERVER_INFO } from './server.mjs';
import { TOOLS } from './tools.mjs';

const log = (...parts) => {
  process.stderr.write(`[${SERVER_INFO.name}] ${parts.join(' ')}\n`);
};

// 可选：MCP_DEBUG_LOG 指向一个文件时，把每条收发的原始报文追加进去。
// 默认不写任何文件，只用于排查宿主（如 DSH）连不上时看真实握手内容。
const debugLogPath = process.env.MCP_DEBUG_LOG;
const trace = debugLogPath
  ? (direction, text) => {
    try {
      fs.appendFileSync(debugLogPath, `${new Date().toISOString()} ${direction} ${text}\n`);
    } catch {
      /* 写调试日志失败不影响服务 */
    }
  }
  : () => {};

function send(message) {
  const line = JSON.stringify(message);
  trace('>>', line);
  process.stdout.write(`${line}\n`);
}

let chain = Promise.resolve();
const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
  terminal: false,
});

rl.on('line', (line) => {
  if (!line.trim()) return;
  trace('<<', line);
  chain = chain
    .then(async () => {
      let req;
      try {
        req = JSON.parse(line);
      } catch (err) {
        send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: `Parse error: ${err.message}` } });
        return;
      }
      const response = await handle(req);
      if (response) send(response);
    })
    .catch((err) => log('internal error:', err?.stack ?? String(err)));
});

rl.on('close', () => {
  chain.finally(() => setTimeout(() => process.exit(0), 30));
});

process.on('uncaughtException', (err) => log('uncaught:', err?.message ?? String(err)));
// 启动即落一份指纹，供 scripts/check-update.mjs 判断「磁盘已更新、进程还是旧的」。
const runtime = recordRuntime({
  toolCount: TOOLS.length,
  toolNames: TOOLS.map((tool) => tool.name),
});
log('ready, pid=', process.pid, 'node=', process.version, 'src=', runtime.sourceHash);
