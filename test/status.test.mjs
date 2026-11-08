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
  assert.deepEqual(all.responses, [{ comment_id: 'c1', batch_id: 'b1', status: 'answered', answer: 'yes', acted_at: 't' }]);
});
