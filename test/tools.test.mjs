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

test('a reviewer reopen newer than Claude\'s status drops the old status and keeps the batch in progress', () => {
  const L = fixture({ a: v6('A', ['k1']) });
  callTool(L, 'batch_open', { id: 'A' });
  callTool(L, 'status_set', { batch_id: 'A', comment_id: 'k1', status: 'fixed' });
  const acted = readStatus(L.statusFile).batches.A.comments.k1.acted_at;
  const later = new Date(Date.parse(acted) + 60000).toISOString();
  const reopened = v6('B', ['k1'], later);
  reopened.comments[0].status = { state: 'reopened', at: later, source: 'reviewer' };
  reopened.comments[0].history = [{ at: later, kind: 'reopen', note: 'still broken' }];
  fs.writeFileSync(path.join(L.inbox, 'b.zip'), makeZip({ 'feedback.json': JSON.stringify(reopened) }));
  assert.equal(callTool(L, 'batch_open', { id: 'B' }).status.k1, undefined);
  assert.equal(listBatches(L).find((b) => b.id === 'B').state, 'in_progress');
});

test('history newer than Claude\'s status alone also drops it', () => {
  const L = fixture({ a: v6('A', ['k1']) });
  callTool(L, 'batch_open', { id: 'A' });
  callTool(L, 'status_set', { batch_id: 'A', comment_id: 'k1', status: 'fixed' });
  const acted = readStatus(L.statusFile).batches.A.comments.k1.acted_at;
  const later = new Date(Date.parse(acted) + 60000).toISOString();
  const j = v6('B', ['k1'], later);
  j.comments[0].history = [{ at: later, kind: 'reply', note: 'also x' }];
  fs.writeFileSync(path.join(L.inbox, 'b.zip'), makeZip({ 'feedback.json': JSON.stringify(j) }));
  assert.equal(callTool(L, 'batch_open', { id: 'B' }).status.k1, undefined);
});

test('a re-sent comment without newer status or history keeps the old entry', () => {
  const L = fixture({ a: v6('A', ['k1']) });
  callTool(L, 'batch_open', { id: 'A' });
  callTool(L, 'status_set', { batch_id: 'A', comment_id: 'k1', status: 'fixed' });
  const acted = readStatus(L.statusFile).batches.A.comments.k1.acted_at;
  const earlier = new Date(Date.parse(acted) - 60000).toISOString();
  const j = v6('B', ['k1']);
  j.comments[0].status = { state: 'with_claude', at: earlier, source: 'claude_code' };
  j.comments[0].history = [{ at: earlier, kind: 'reply', note: 'old' }];
  fs.writeFileSync(path.join(L.inbox, 'b.zip'), makeZip({ 'feedback.json': JSON.stringify(j) }));
  assert.equal(callTool(L, 'batch_open', { id: 'B' }).status.k1.status, 'fixed');
  assert.equal(listBatches(L).find((b) => b.id === 'B').state, 'done');
});

function resent(L, later, patch) {
  const j = v6('B', ['k1'], later);
  Object.assign(j.comments[0], patch);
  fs.writeFileSync(path.join(L.inbox, 'b.zip'), makeZip({ 'feedback.json': JSON.stringify(j) }));
}
function fixedFixture() {
  const L = fixture({ a: v6('A', ['k1']) });
  callTool(L, 'batch_open', { id: 'A' });
  callTool(L, 'status_set', { batch_id: 'A', comment_id: 'k1', status: 'fixed' });
  const later = new Date(Date.parse(readStatus(L.statusFile).batches.A.comments.k1.acted_at) + 60000).toISOString();
  return { L, later };
}

test('a reviewer Confirm after Claude fixed keeps the fixed entry and the batch can be done', () => {
  const { L, later } = fixedFixture();
  resent(L, later, { status: { state: 'confirmed', at: later, source: 'reviewer' }, history: [{ at: later, kind: 'confirm', note: 'ok' }] });
  assert.equal(callTool(L, 'batch_open', { id: 'B' }).status.k1.status, 'fixed');
  assert.equal(listBatches(L).find((b) => b.id === 'B').state, 'done');
});

test('an edit history entry newer than acted_at drops the entry', () => {
  const { L, later } = fixedFixture();
  resent(L, later, { history: [{ at: later, kind: 'edit', note: 'Comment edited' }] });
  assert.equal(callTool(L, 'batch_open', { id: 'B' }).status.k1, undefined);
  assert.equal(listBatches(L).find((b) => b.id === 'B').state, 'in_progress');
});

test('status_set stores verification_url and notes and writes them to responses.json', () => {
  const L = fixture({ s: v6('e1', ['c1']) });
  const { dir } = callTool(L, 'batch_open', { id: 'e1' });
  const { entry } = callTool(L, 'status_set', { batch_id: 'e1', comment_id: 'c1', status: 'fixed', commit_sha: 'abc',
    verification_url: 'https://app-git-feedback-a.vercel.app/p', notes: 'Kept the old token; the design system has no new one.' });
  assert.equal(entry.verification_url, 'https://app-git-feedback-a.vercel.app/p');
  assert.equal(entry.notes, 'Kept the old token; the design system has no new one.');
  const r = JSON.parse(fs.readFileSync(path.join(dir, 'responses.json'), 'utf8')).responses[0];
  assert.equal(r.verification_url, 'https://app-git-feedback-a.vercel.app/p');
  assert.equal(r.notes, 'Kept the old token; the design system has no new one.');
});

test('status_set rejects notes over 500 chars and a non-http verification_url without writing', () => {
  const L = fixture({ s: v6('e1', ['c1']) });
  callTool(L, 'batch_open', { id: 'e1' });
  assert.throws(() => callTool(L, 'status_set', { batch_id: 'e1', comment_id: 'c1', status: 'fixed', notes: 'x'.repeat(501) }), /notes/);
  assert.throws(() => callTool(L, 'status_set', { batch_id: 'e1', comment_id: 'c1', status: 'fixed', verification_url: 'javascript:alert(1)' }), /verification_url/);
  assert.deepEqual(readStatus(L.statusFile), { version: 1, batches: {} });
  callTool(L, 'status_set', { batch_id: 'e1', comment_id: 'c1', status: 'fixed', notes: 'x'.repeat(500) });
});
