import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { readStatus, responsesDoc } from './status.js';

export const PUBLISHED_ORIGIN = 'chrome-extension://lkpciiloidfgdhlgaefcbggajlfljmbp';
export const DEFAULT_PORT = 41837;

const SHOT_RE = /^\/shot\/([A-Za-z0-9][\w.-]*)\/([A-Za-z0-9][\w.-]*)$/;

/** Read-only status listener on 127.0.0.1. Resolves to the server, or null if the port is taken
 *  (another Claude session already serves the same shared status file).
 *  GET /shot/<batch>/<comment> serves <batchesDir>/<batch>/after/<comment>.png (page_shot's after-shot). */
export function startListener({ port = DEFAULT_PORT, statusFile, batchesDir = null, extraOrigins = process.env.PFB_EXTRA_ORIGINS, log = () => {} }) {
  const allowed = new Set([PUBLISHED_ORIGIN, ...String(extraOrigins || '').split(',').map((s) => s.trim()).filter(Boolean)]);
  const srv = http.createServer((req, res) => {
    // Only 127.0.0.1 / localhost by name: a DNS-rebinding page arrives with its own host name.
    const port = srv.address().port;
    if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(String(req.headers.host || '').toLowerCase())) {
      res.writeHead(403); res.end('forbidden'); return;
    }
    const origin = req.headers.origin;
    if (origin ? !allowed.has(origin) : !['none', undefined].includes(req.headers['sec-fetch-site'])) {
      // No Origin is fine only when no web page sent the request: an extension holding a host permission
      // (Chrome then omits Origin and sends Sec-Fetch-Site: none) or a local tool. Pages always send one of them.
      // An unknown extension (a dev build) may read the refusal, so it can say "refused (HTTP 403)"
      // instead of "not running". The body carries no data; web pages still get no CORS grant.
      const ext = origin && /^chrome-extension:\/\/[a-z0-9]+$/i.test(origin) ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};
      res.writeHead(403, ext); res.end('forbidden'); return;
    }
    const cors = origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin', 'Access-Control-Allow-Private-Network': 'true' } : {};
    if (req.method === 'OPTIONS') { res.writeHead(204, { ...cors, 'Access-Control-Allow-Methods': 'GET' }); res.end(); return; }
    if (req.method !== 'GET') { res.writeHead(405, cors); res.end(); return; }
    let body;
    try {
      let url;
      try { url = new URL(req.url, 'http://127.0.0.1'); }
      catch { res.writeHead(400, cors); res.end(); return; }
      const shot = SHOT_RE.exec(url.pathname);
      if (shot) {
        // The ids cannot hold a path separator or start with a dot, so the file stays inside batchesDir.
        let png = null;
        if (batchesDir) {
          try { png = fs.readFileSync(path.join(batchesDir, shot[1], 'after', `${shot[2]}.png`)); }
          catch (e) { if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e; }
        }
        if (!png) { res.writeHead(404, cors); res.end(); return; }
        // page_shot's box of the target in the PNG (x,y,w,h), so the extension can crop to it.
        let box = null;
        try {
          const b = JSON.parse(fs.readFileSync(path.join(batchesDir, shot[1], 'after', `${shot[2]}.json`), 'utf8'));
          if ([b.x, b.y, b.w, b.h].every((n) => Number.isInteger(n) && n >= 0)) box = `${b.x},${b.y},${b.w},${b.h}`;
        } catch { /* no box: the card shows the whole page */ }
        res.writeHead(200, { ...cors, 'Content-Type': 'image/png', 'Cache-Control': 'no-store',
          ...(box ? { 'X-PFB-Box': box } : {}), ...(origin ? { 'Access-Control-Expose-Headers': 'X-PFB-Box' } : {}) });
        res.end(png);
        return;
      }
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
