import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readStatus, setStatus, responsesDoc, ALLOWED } from '../server/status.js';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pfb-st-')), 'status.json');

test('missing file reads as empty', () => {
  assert.deepEqual(readStatus(tmp()), { version: 1, batches: {} });
});

test('setStatus writes atomically and merges', () => {
  const f = tmp();
  setStatus(f, { batchId: 'b1', version: 5, commentId: 'c1', status: 'fixed', summary: 's', commit_sha: 'abc' }, () => '2026-11-08T16:02:00Z');
  setStatus(f, { batchId: 'b1', version: 5, commentId: 'c2', status: 'needs_input', question_back: 'which?' }, () => '2026-11-08T16:03:00Z');
  const s = readStatus(f);
  assert.deepEqual(Object.keys(s.batches.b1.comments), ['c1', 'c2']);
  assert.equal(s.batches.b1.comments.c1.acted_at, '2026-11-08T16:02:00Z');
  assert.ok(!fs.readdirSync(path.dirname(f)).some((n) => n.endsWith('.tmp')));
});

test('rejects unknown statuses', () => {
  assert.throws(() => setStatus(tmp(), { batchId: 'b', version: 6, commentId: 'c', status: 'shipped' }), /status must be one of/);
  assert.deepEqual(ALLOWED, ['fixed', 'answered', 'proposed', 'needs_input', 'skipped', 'in_progress']);
});

test('v5 batches get v1 status names, v6 keep v2', () => {
  const f = tmp();
  setStatus(f, { batchId: 'old', version: 5, commentId: 'a', status: 'fixed' }, () => 't');
  setStatus(f, { batchId: 'old', version: 5, commentId: 'b', status: 'skipped', summary: 'out of scope' }, () => 't');
  setStatus(f, { batchId: 'old', version: 5, commentId: 'c', status: 'proposed', proposal: { approach: 'x', effort: 'M', risk: 'low' } }, () => 't');
  setStatus(f, { batchId: 'new', version: 6, commentId: 'd', status: 'fixed' }, () => 't');
  const s = readStatus(f);
  const v1 = responsesDoc(s, 'old', () => 'now');
  assert.equal(v1.schema, 'prototype-feedback-response/v1');
  assert.deepEqual(v1.responses.map((r) => [r.comment_id, r.status]), [['a', 'shipped'], ['b', 'wontfix'], ['c', 'deferred']]);
  assert.match(v1.responses[2].summary, /Proposal: x/);
  const v2 = responsesDoc(s, 'new', () => 'now');
  assert.equal(v2.schema, 'prototype-feedback-response/v2');
  assert.deepEqual(v2.responses.map((r) => r.status), ['fixed']);
});

test('all-batches document (for the listener) is v2 with batch ids', () => {
  const f = tmp();
  setStatus(f, { batchId: 'b1', version: 6, commentId: 'c1', status: 'answered', answer: 'yes' }, () => 't');
  const all = responsesDoc(readStatus(f), null, () => 'now');
  assert.equal(all.schema, 'prototype-feedback-response/v2');
  assert.deepEqual(all.responses, [{ comment_id: 'c1', batch_id: 'b1', export_id: null, status: 'answered', answer: 'yes', acted_at: 't' }]);
});

test('setStatus throws when a fresh lock is held past the wait', () => {
  const f = tmp();
  fs.writeFileSync(`${f}.lock`, 'other-session');
  assert.throws(() => setStatus(f, { batchId: 'b', version: 6, commentId: 'c', status: 'fixed' }, () => 't', { waitMs: 100 }), /locked/);
  assert.ok(fs.existsSync(`${f}.lock`), 'a lock we did not take must not be removed');
  assert.equal(fs.existsSync(f), false, 'no write happens without the lock');
});

test('setStatus breaks a lock older than 10 s and writes', () => {
  const f = tmp();
  const lock = `${f}.lock`;
  fs.writeFileSync(lock, 'crashed-session');
  const past = new Date(Date.now() - 20000);
  fs.utimesSync(lock, past, past);
  setStatus(f, { batchId: 'b', version: 6, commentId: 'c', status: 'fixed' }, () => 't', { waitMs: 100 });
  assert.equal(readStatus(f).batches.b.comments.c.status, 'fixed');
  assert.equal(fs.existsSync(lock), false);
});

test('setStatus leaves no lock file behind after a successful write', () => {
  const f = tmp();
  setStatus(f, { batchId: 'b', version: 6, commentId: 'c', status: 'fixed' }, () => 't');
  assert.equal(fs.existsSync(`${f}.lock`), false);
});

test('setStatus survives a concurrent reader of status.json (Windows EPERM on rename)', async () => {
  const { spawn } = await import('node:child_process');
  const f = tmp();
  setStatus(f, { batchId: 'b', version: 6, commentId: 'c0', status: 'fixed' });
  const reader = spawn(process.execPath, ['-e',
    `const fs=require('fs');const end=Date.now()+1500;while(Date.now()<end){try{fs.readFileSync(process.argv[1],'utf8')}catch{}}`, f], { stdio: 'ignore' });
  const exited = new Promise((r) => reader.on('exit', r));
  await new Promise((r) => setTimeout(r, 100));
  for (let i = 1; i <= 200; i += 1) setStatus(f, { batchId: 'b', version: 6, commentId: `c${i}`, status: 'fixed' });
  await exited;
  assert.equal(Object.keys(readStatus(f).batches.b.comments).length, 201);
});

test('setStatus ignores a lock file that vanished (taken over as stale) on release', () => {
  const f = tmp();
  const entry = setStatus(f, { batchId: 'b', version: 6, commentId: 'c', status: 'fixed' },
    () => { fs.unlinkSync(`${f}.lock`); return 't'; });
  assert.equal(entry.status, 'fixed');
  assert.equal(readStatus(f).batches.b.comments.c.status, 'fixed');
});

test('responses documents carry export_id (null when the batch has none)', () => {
  const f = tmp();
  setStatus(f, { batchId: 'new', version: 6, exportId: 'e1', commentId: 'a', status: 'fixed' }, () => 't');
  setStatus(f, { batchId: 'old', version: 5, exportId: null, commentId: 'b', status: 'fixed' }, () => 't');
  const s = readStatus(f);
  assert.equal(responsesDoc(s, 'new', () => 'n').export_id, 'e1');
  assert.equal(responsesDoc(s, 'old', () => 'n').export_id, null);
  assert.deepEqual(responsesDoc(s, null, () => 'n').responses.map((r) => [r.batch_id, r.export_id]), [['new', 'e1'], ['old', null]]);
});

test('embeddedDone honours a final embedded state unless a reopen-type history entry is newer', async () => {
  const { embeddedDone } = await import('../server/status.js');
  const at = '2026-11-08T10:00:00Z', later = '2026-11-08T11:00:00Z', earlier = '2026-11-08T09:00:00Z';
  for (const state of ['confirmed', 'fixed', 'answered', 'proposed']) assert.equal(embeddedDone({ status: { state, at } }), true, state);
  for (const state of ['needs_input', 'with_claude', 'reopened', 'not_sent']) assert.equal(embeddedDone({ status: { state, at } }), false, state);
  assert.equal(embeddedDone({}), false);
  for (const kind of ['reopen', 'reply', 'do_it', 'edit']) {
    assert.equal(embeddedDone({ status: { state: 'fixed', at }, history: [{ kind, at: later }] }), false, kind);
    assert.equal(embeddedDone({ status: { state: 'fixed', at }, history: [{ kind, at: earlier }] }), true, kind);
  }
  assert.equal(embeddedDone({ status: { state: 'fixed', at }, history: [{ kind: 'confirm', at: later }] }), true);
});

test('after_shot is stored, reaches responses.json and the listener doc, and must name after/<id>.png', () => {
  const f = tmp();
  setStatus(f, { batchId: 'b1', version: 6, commentId: 'c1', status: 'fixed', after_shot: 'after/c1.png' }, () => '2026-11-09T16:00:00Z');
  const s = readStatus(f);
  assert.equal(s.batches.b1.comments.c1.after_shot, 'after/c1.png');
  assert.equal(responsesDoc(s, 'b1').responses[0].after_shot, 'after/c1.png');
  assert.equal(responsesDoc(s, null).responses[0].after_shot, 'after/c1.png');
  for (const bad of ['../x.png', 'after/../c1.png', '/abs/c1.png', 'after/c1.jpg', 'c1.png', 5]) {
    assert.throws(() => setStatus(f, { batchId: 'b1', version: 6, commentId: 'c2', status: 'fixed', after_shot: bad }), /after_shot/, String(bad));
  }
  assert.equal(readStatus(f).batches.b1.comments.c2, undefined, 'nothing written on a refusal');
});

test('the status_set schema pattern for after_shot equals the server check', async () => {
  const { TOOLS } = await import('../server/tools.js');
  const { AFTER_SHOT_RE } = await import('../server/status.js');
  const pattern = TOOLS.find((t) => t.name === 'status_set').inputSchema.properties.after_shot.pattern;
  assert.equal(pattern, AFTER_SHOT_RE.source.split('\\/').join('/'));
  const re = new RegExp(pattern);
  assert.ok(re.test('after/c_1.png'));
  assert.ok(!re.test('after/c1xpng'), 'the dot before png is literal');
  assert.ok(!re.test('after/c1.pngx'));
});
