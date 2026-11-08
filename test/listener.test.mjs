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
    assert.equal((await fetch(`${base}/status`)).status, 403);
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
