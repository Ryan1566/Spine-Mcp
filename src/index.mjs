// stdio 传输：stdin 每行一条 JSON-RPC 消息，stdout 只输出合法 MCP 消息，日志一律走 stderr。
import readline from 'node:readline';
import { handle, SERVER_INFO } from './server.mjs';

const log = (...parts) => {
  process.stderr.write(`[${SERVER_INFO.name}] ${parts.join(' ')}\n`);
};

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

let chain = Promise.resolve();
const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
  terminal: false,
});

rl.on('line', (line) => {
  if (!line.trim()) return;
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
log('ready, pid=', process.pid, 'node=', process.version);
