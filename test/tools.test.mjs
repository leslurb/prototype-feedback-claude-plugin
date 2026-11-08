import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { layout } from '../server/paths.js';
import { callTool } from '../server/tools.js';
import { listBatches } from '../server/inbox.js';
import { readStatus, setStatus } from '../server/status.js';
import { makeZip } from './helpers/makezip.mjs';

function fixture(exports) {
  const L = layout(fs.mkdtempSync(path.join(os.tmpdir(), 'pfb-tl-')));
  fs.mkdirSync(L.inbox, { recursive: true });
  Object.entries(exports).forEach(([name, json], i) => fs.writeFileSync(path.join(L.inbox, `${name}.zip`), makeZip({ 'feedback.json': JSON.stringify(json) })));
  return L;
}
const v6 = (id, ids, at = '2026-11-08T15:00:00Z') => ({ schema: 'prototype-feedback/v6', export_id: id, exported_at: at,
  comments: ids.map((c) => ({ id: c, verb: 'fix', comment: 'x', page_url: 'https://a.dev/' })) });
const v5 = (ids) => ({ schema: 'prototype-feedback/v5', exported_at: '2026-11-06T21:02:00Z',
  comments: ids.map((c) => ({ id: c, intent: 'bug', comment: 'x', page_url: 'https://a.dev/' })) });

test('status_set rejects a comment id that is not in the batch', () => {
  const L = fixture({ s: v6('e1', ['c1']) });
  callTool(L, 'batch_open', { id: 'e1' });
  assert.throws(() => callTool(L, 'status_set', { batch_id: 'e1', comment_id: 'c99', status: 'fixed' }), /unknown comment c99 in batch e1/);
  for (const bad of ['__proto__', 'constructor', 'prototype']) {
    assert.throws(() => callTool(L, 'status_set', { batch_id: 'e1', comment_id: bad, status: 'fixed' }), /unknown comment/);
  }
  assert.deepEqual(readStatus(L.statusFile), { version: 1, batches: {} });
});
test('status follows the comment across re-exports', () => {
  const L = fixture({ a: v5(['k1']) });
  callTool(L, 'batch_open', { id: 'a' });
  callTool(L, 'status_set', { batch_id: 'a', comment_id: 'k1', status: 'fixed', summary: 'done' });
  fs.writeFileSync(path.join(L.inbox, 'b.zip'), makeZip({ 'feedback.json': JSON.stringify(v6('B', ['k1', 'k2'])) }));
  const opened = callTool(L, 'batch_open', { id: 'B' });
  assert.equal(opened.status.k1.status, 'fixed');
  assert.equal(opened.status.k1.from_batch, 'a');
  assert.equal(opened.status.k2, undefined);
  assert.equal(listBatches(L).find((b) => b.id === 'B').state, 'in_progress');
  callTool(L, 'status_set', { batch_id: 'B', comment_id: 'k2', status: 'fixed' });
  assert.equal(listBatches(L).find((b) => b.id === 'B').state, 'done');
  assert.equal(readStatus(L.statusFile).batches.B.comments.k1, undefined, 'statuses are not copied between batches');
});

test('status_set writes responses.json atomically (no tmp files left)', () => {
  const L = fixture({ s: v6('e1', ['c1']) });
  const { dir } = callTool(L, 'batch_open', { id: 'e1' });
  callTool(L, 'status_set', { batch_id: 'e1', comment_id: 'c1', status: 'fixed' });
  const doc = JSON.parse(fs.readFileSync(path.join(dir, 'responses.json'), 'utf8'));
  assert.deepEqual(doc.responses.map((r) => [r.comment_id, r.status]), [['c1', 'fixed']]);
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), []);
  assert.deepEqual(fs.readdirSync(path.dirname(L.statusFile)).filter((n) => n.endsWith('.tmp') || n.endsWith('.lock')), []);
});

test('setStatus runs onWrite while the lock is still held', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pfb-ow-')), 'status.json');
  let lockedDuring;
  setStatus(f, { batchId: 'b', version: 6, commentId: 'c', status: 'fixed' }, undefined,
    { onWrite: (state) => { lockedDuring = fs.existsSync(`${f}.lock`) && state.batches.b.comments.c.status === 'fixed'; } });
  assert.equal(lockedDuring, true);
  assert.equal(fs.existsSync(`${f}.lock`), false);
});
