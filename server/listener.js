import http from 'node:http';
import { readStatus, responsesDoc } from './status.js';

export const PUBLISHED_ORIGIN = 'chrome-extension://lkpciiloidfgdhlgaefcbggajlfljmbp';
export const DEFAULT_PORT = 41837;

/** Read-only status listener on 127.0.0.1. Resolves to the server, or null if the port is taken
 *  (another Claude session already serves the same shared status file). */
export function startListener({ port = DEFAULT_PORT, statusFile, extraOrigins = process.env.PFB_EXTRA_ORIGINS, log = () => {} }) {
  const allowed = new Set([PUBLISHED_ORIGIN, ...String(extraOrigins || '').split(',').map((s) => s.trim()).filter(Boolean)]);
  const srv = http.createServer((req, res) => {
    const origin = req.headers.origin;
    if (!origin || !allowed.has(origin)) { res.writeHead(403); res.end('forbidden'); return; }
    const cors = { 'Access-Control-Allow-Origin': origin, Vary: 'Origin', 'Access-Control-Allow-Private-Network': 'true' };
    if (req.method === 'OPTIONS') { res.writeHead(204, { ...cors, 'Access-Control-Allow-Methods': 'GET' }); res.end(); return; }
    if (req.method !== 'GET') { res.writeHead(405, cors); res.end(); return; }
    const url = new URL(req.url, 'http://127.0.0.1');
    let body;
    try {
      if (url.pathname === '/health') body = { ok: true, pid: process.pid };
      else if (url.pathname === '/status') body = responsesDoc(readStatus(statusFile), null);
      else { res.writeHead(404, cors); res.end(); return; }
    } catch (e) {
      log(`pfb listener: ${e.message}`);
      res.writeHead(500, cors); res.end(JSON.stringify({ error: e.message })); return;
    }
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  return new Promise((resolve, reject) => {
    srv.once('error', (e) => (e.code === 'EADDRINUSE' ? resolve(null) : reject(e)));
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}
