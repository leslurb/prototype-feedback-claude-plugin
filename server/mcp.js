// server/mcp.js
// Minimal MCP server over stdio: newline-delimited JSON-RPC 2.0. No dependencies.
import readline from 'node:readline';
import { readFileSync } from 'node:fs';
import { layout, downloadsDir } from './paths.js';
import { TOOLS, callTool } from './tools.js';
import { startListener, DEFAULT_PORT } from './listener.js';

// One version source: .claude-plugin/plugin.json (bumped on every user-visible change).
const PLUGIN_VERSION = JSON.parse(readFileSync(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8')).version;
const L = layout(downloadsDir());
const log = (m) => process.stderr.write(`${m}\n`);
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

const port = process.env.PFB_PORT !== undefined ? Number(process.env.PFB_PORT) : DEFAULT_PORT;
startListener({ port, statusFile: L.statusFile, log })
  .then((srv) => log(srv ? `pfb: status listener on 127.0.0.1:${srv.address().port}` : `pfb: port ${port} in use; another session serves status`))
  .catch((e) => log(`pfb: status listener failed: ${e.message}`));

function handle(msg) {
  const { id, method, params = {} } = msg;
  if (id === undefined) return; // notification
  if (typeof id !== 'string' && typeof id !== 'number') return send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } });
  try {
    if (method === 'initialize') {
      return send({ jsonrpc: '2.0', id, result: {
        protocolVersion: params.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'pfb', version: PLUGIN_VERSION } } });
    }
    if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
    if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    if (method === 'tools/call') {
      try {
        const out = callTool(L, params.name, params.arguments || {});
        return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] } });
      } catch (e) {
        return send({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: e.message }] } });
      }
    }
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
  } catch (e) {
    send({ jsonrpc: '2.0', id, error: { code: -32603, message: e.message } });
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } });
  try { handle(msg); } catch (e) { log(`pfb: handler error: ${e.message}`); }
});
process.on('uncaughtException', (e) => log(`pfb: uncaught: ${e.message}`));
process.stdout.on('error', () => process.exit(0));
rl.on('close', () => process.exit(0));
