import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startListener, PUBLISHED_ORIGIN } from '../server/listener.js';
import { setStatus } from '../server/status.js';

const statusFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pfb-ls-')), 'status.json');

test('serves /status and /health to the extension origin only', async () => {
  const f = statusFile();
  setStatus(f, { batchId: 'b1', version: 6, commentId: 'c1', status: 'fixed' });
  const srv = await startListener({ port: 0, statusFile: f });
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const ok = await fetch(`${base}/status`, { headers: { Origin: PUBLISHED_ORIGIN } });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('access-control-allow-origin'), PUBLISHED_ORIGIN);
    const doc = await ok.json();
    assert.deepEqual(doc.responses.map((r) => [r.batch_id, r.comment_id, r.status]), [['b1', 'c1', 'fixed']]);
    assert.equal((await fetch(`${base}/health`, { headers: { Origin: PUBLISHED_ORIGIN } })).status, 200);
    assert.equal((await fetch(`${base}/status`, { headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await fetch(`${base}/status`, { method: 'POST', headers: { Origin: PUBLISHED_ORIGIN } })).status, 405);
  } finally { srv.close(); }
});

test('extra origins come from PFB_EXTRA_ORIGINS', async () => {
  const srv = await startListener({ port: 0, statusFile: statusFile(), extraOrigins: 'chrome-extension://dev1' });
  try {
    const r = await fetch(`http://127.0.0.1:${srv.address().port}/health`, { headers: { Origin: 'chrome-extension://dev1' } });
    assert.equal(r.status, 200);
  } finally { srv.close(); }
});

test('a port already in use resolves to null instead of throwing', async () => {
  const first = await startListener({ port: 0, statusFile: statusFile() });
  try {
    const second = await startListener({ port: first.address().port, statusFile: statusFile() });
    assert.equal(second, null);
  } finally { first.close(); }
});

test('a malformed request path gets 400 instead of hanging', async () => {
  const http = await import('node:http');
  const srv = await startListener({ port: 0, statusFile: statusFile() });
  try {
    const status = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: srv.address().port, path: '//', headers: { Origin: PUBLISHED_ORIGIN }, timeout: 2000 }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on('timeout', () => { req.destroy(); reject(new Error('request hung')); });
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 400);
  } finally { srv.close(); }
});

test('OPTIONS preflight answers 204 with private-network and GET headers', async () => {
  const srv = await startListener({ port: 0, statusFile: statusFile() });
  try {
    const res = await fetch(`http://127.0.0.1:${srv.address().port}/status`, { method: 'OPTIONS', headers: { Origin: PUBLISHED_ORIGIN } });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-private-network'), 'true');
    assert.match(res.headers.get('access-control-allow-methods'), /GET/);
  } finally { srv.close(); }
});

const rawGet = async (port, headers) => {
  const http = await import('node:http');
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/status', headers, timeout: 2000 }, (res) => { res.resume(); resolve(res); });
    req.on('timeout', () => { req.destroy(); reject(new Error('request hung')); });
    req.on('error', reject);
    req.end();
  });
};

test('a request with no Origin is served when it did not come from a web page', async () => {
  // 2026-11-08 mocked loop: Chrome sends no Origin (Sec-Fetch-Site: none) when the extension holds a
  // host permission for 127.0.0.1, so the listener answered 403 and status never came back.
  const srv = await startListener({ port: 0, statusFile: statusFile() });
  const port = srv.address().port;
  try {
    const ext = await rawGet(port, { 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Mode': 'cors' });
    assert.equal(ext.statusCode, 200);
    assert.equal(ext.headers['access-control-allow-origin'], undefined, 'no CORS grant without an Origin');
    assert.equal((await rawGet(port, {})).statusCode, 200, 'local tools (curl) send neither header');
    for (const site of ['same-origin', 'same-site', 'cross-site']) {
      assert.equal((await rawGet(port, { 'Sec-Fetch-Site': site })).statusCode, 403, `page request (${site}) without Origin`);
    }
  } finally { srv.close(); }
});

test('a Host other than 127.0.0.1 or localhost is refused (DNS rebinding)', async () => {
  const srv = await startListener({ port: 0, statusFile: statusFile() });
  const port = srv.address().port;
  try {
    assert.equal((await rawGet(port, { Host: `evil.example:${port}`, Origin: PUBLISHED_ORIGIN })).statusCode, 403);
    assert.equal((await rawGet(port, { Host: `evil.example:${port}` })).statusCode, 403);
    assert.equal((await rawGet(port, { Host: `localhost:${port}`, Origin: PUBLISHED_ORIGIN })).statusCode, 200);
    assert.equal((await rawGet(port, { Host: `127.0.0.1:${port}`, Origin: PUBLISHED_ORIGIN })).statusCode, 200);
  } finally { srv.close(); }
});

test('an unknown extension gets a readable 403, a web page does not', async () => {
  // 2026-11-09 E2E: the 403 carried no CORS header, so the extension saw "Failed to fetch" and its
  // "refused this extension (HTTP 403)" message (with the help link for PFB_EXTRA_ORIGINS) never showed.
  const srv = await startListener({ port: 0, statusFile: statusFile() });
  const port = srv.address().port;
  try {
    const ext = await rawGet(port, { Origin: 'chrome-extension://unknowndevbuild' });
    assert.equal(ext.statusCode, 403);
    assert.equal(ext.headers['access-control-allow-origin'], 'chrome-extension://unknowndevbuild', 'extension can read the 403');
    const page = await rawGet(port, { Origin: 'https://evil.example' });
    assert.equal(page.statusCode, 403);
    assert.equal(page.headers['access-control-allow-origin'], undefined, 'a web page cannot even read the refusal');
  } finally { srv.close(); }
});

function shotFixture() {
  const batches = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pfb-shot-')), 'batches');
  fs.mkdirSync(path.join(batches, 'b1', 'after'), { recursive: true });
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  fs.writeFileSync(path.join(batches, 'b1', 'after', 'c1.png'), png);
  fs.writeFileSync(path.join(batches, 'secret.png'), png);
  return { batches, png };
}
const rawPath = async (port, p, headers) => {
  const http = await import('node:http');
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, headers, timeout: 2000 }, (res) => {
      const chunks = []; res.on('data', (d) => chunks.push(d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('request hung')); });
    req.on('error', reject);
    req.end();
  });
};

test('GET /shot/<batch>/<comment> serves the after-shot PNG to the extension', async () => {
  const { batches, png } = shotFixture();
  const srv = await startListener({ port: 0, statusFile: statusFile(), batchesDir: batches });
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const ok = await fetch(`${base}/shot/b1/c1`, { headers: { Origin: PUBLISHED_ORIGIN } });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('content-type'), 'image/png');
    assert.equal(ok.headers.get('access-control-allow-origin'), PUBLISHED_ORIGIN);
    assert.deepEqual(Buffer.from(await ok.arrayBuffer()), png);
    assert.equal((await fetch(`${base}/shot/b1/c1`, { headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await fetch(`${base}/shot/b1/c9`, { headers: { Origin: PUBLISHED_ORIGIN } })).status, 404, 'missing file');
    assert.equal((await fetch(`${base}/shot/b9/c1`, { headers: { Origin: PUBLISHED_ORIGIN } })).status, 404, 'missing batch');
  } finally { srv.close(); }
});

test('/shot ids with .. or extra segments never reach the file system', async () => {
  const { batches } = shotFixture();
  const srv = await startListener({ port: 0, statusFile: statusFile(), batchesDir: batches });
  const port = srv.address().port;
  try {
    for (const p of ['/shot/../secret', '/shot/b1/..%2F..%2Fsecret', '/shot/%2E%2E/secret', '/shot/b1/after/c1', '/shot/.x/c1', '/shot/b1/c1.png']) {
      const r = await rawPath(port, p, { Origin: PUBLISHED_ORIGIN });
      assert.equal(r.status, 404, p);
    }
  } finally { srv.close(); }
});

test('/shot without a batches folder answers 404', async () => {
  const srv = await startListener({ port: 0, statusFile: statusFile() });
  try {
    assert.equal((await fetch(`http://127.0.0.1:${srv.address().port}/shot/b1/c1`, { headers: { Origin: PUBLISHED_ORIGIN } })).status, 404);
  } finally { srv.close(); }
});
