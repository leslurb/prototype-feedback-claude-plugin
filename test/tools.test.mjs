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

const AT = '2026-11-08T10:00:00Z';
function richExport() {
  return { schema: 'prototype-feedback/v6', export_id: 'R1', exported_at: '2026-11-08T15:00:00Z', delta: false, export_kind: 'zip',
    repo: 'https://github.com/o/r', reviewer: 'Ann',
    session: { id: 's1', label: 'Pricing', round: 2, rounds: [{ n: 1, started_at: AT, build_key: 'b1' }], last_send: AT, previous_export_ids: ['R0'] },
    prior_commits: [{ comment_id: 'p1', commit_sha: 'abc123', files_changed: ['a.js'], state: 'fixed', acted_at: AT }],
    round_note: { what_changed: 'new header', preview_url: 'https://a.dev/', focus: 'header only', reviewer_is_developer: false, written_at: AT },
    console_log: [{ level: 'error', text: 'boom' }],
    comments: [
      { id: 'p1', verb: 'fix', urgent: true, comment: 'y'.repeat(300), page_url: 'https://a.dev/p', screenshot_path: 'screenshots/p1.png',
        status: { state: 'fixed', at: AT }, history: [{ kind: 'reopen', at: '2026-11-08T11:00:00Z', note: 'still off' }], previous_comment: null },
      { id: 'p2', verb: 'ask', comment: 'why?', page_url: 'https://a.dev/q', status: { state: 'confirmed', at: AT }, history: [{ kind: 'confirm', at: AT }] },
      { id: 'p3', verb: 'idea', comment: 'maybe', page_url: 'https://a.dev/q', screenshot_error: 'capture failed' },
    ] };
}

test('batch_preview returns the compact index without unpacking or archiving', () => {
  const L = fixture({ r: richExport() });
  const p = callTool(L, 'batch_preview', { id: 'R1' });
  assert.equal(p.id, 'R1');
  assert.equal(p.version, 6);
  assert.equal(p.export_kind, 'zip');
  assert.equal(p.full_export, true);
  assert.equal(p.repo, 'https://github.com/o/r');
  assert.equal(p.session.round, 2);
  assert.equal(p.prior_commits[0].commit_sha, 'abc123');
  assert.equal(p.round_note.reviewer_is_developer, false);
  assert.equal(p.counts.total, 3);
  assert.equal(p.counts.done, 1);
  assert.ok(p.bytes > 0);
  const [c1, c2, c3] = p.comments;
  assert.deepEqual(Object.keys(c1).sort(), ['done', 'history_kinds', 'id', 'page_url', 'state', 'text', 'urgent', 'verb']);
  assert.equal(c1.text.length, 200);
  assert.deepEqual(c1.history_kinds, ['reopen']);
  assert.deepEqual([c1.state, c1.done], ['fixed', false], 'reopen newer than the embedded status');
  assert.deepEqual([c2.state, c2.done], ['confirmed', true]);
  assert.deepEqual([c3.state, c3.done, c3.text], ['new', false, 'maybe']);
  assert.equal(p.dir, undefined);
  assert.ok(fs.existsSync(path.join(L.inbox, 'r.zip')), 'not archived');
  assert.ok(!fs.existsSync(path.join(L.batches, 'R1')), 'not unpacked');
});

test('batch_open returns the compact index plus dir, brief and status map', () => {
  const L = fixture({ r: richExport() });
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pfb-repo-'));
  fs.mkdirSync(path.join(repoDir, '.git'));
  fs.mkdirSync(path.join(repoDir, '.pfb'));
  fs.writeFileSync(path.join(repoDir, '.pfb', 'brief.md'), '---\ntest_cmd: npm test\nbranch_policy: per_round\n---\nGoals.\n');
  const o = callTool(L, 'batch_open', { id: 'R1', repo_dir: repoDir });
  assert.equal(o.dir, path.join(L.batches, 'R1'));
  assert.equal(o.brief.test_cmd, 'npm test');
  assert.equal(o.brief.branch_policy, 'per_round');
  assert.equal(o.brief_error, null);
  assert.deepEqual(o.status, {});
  assert.equal(o.round_note.focus, 'header only');
  assert.equal(o.comments.length, 3);
  assert.equal(o.comments[0].text.length, 200);
  assert.ok(!fs.existsSync(path.join(L.inbox, 'r.zip')), 'archived');
  callTool(L, 'status_set', { batch_id: 'R1', comment_id: 'p3', status: 'proposed', proposal: { approach: 'a', effort: 'S', risk: 'low' } });
  const again = callTool(L, 'batch_open', { id: 'R1', repo_dir: repoDir });
  assert.equal(again.status.p3.status, 'proposed');
  assert.deepEqual([again.comments[2].state, again.comments[2].done], ['proposed', true]);
});

test('batch_open reports a missing brief as null and a malformed one as brief_error', () => {
  const L = fixture({ r: richExport() });
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pfb-repo-'));
  fs.mkdirSync(path.join(repoDir, '.git'));
  const o = callTool(L, 'batch_open', { id: 'R1', repo_dir: repoDir });
  assert.equal(o.brief, null);
  assert.equal(o.brief_error, null);
  fs.mkdirSync(path.join(repoDir, '.pfb'));
  fs.writeFileSync(path.join(repoDir, '.pfb', 'brief.md'), '---\nnot yaml\n---\n');
  const bad = callTool(L, 'batch_open', { id: 'R1', repo_dir: repoDir });
  assert.equal(bad.brief, null);
  assert.match(bad.brief_error, /brief\.md: line 2/);
});

test('comment_get returns one full comment, before and after batch_open', () => {
  const L = fixture({ r: richExport() });
  const before = callTool(L, 'comment_get', { batch_id: 'R1', comment_id: 'p3' });
  assert.equal(before.dir, null);
  assert.equal(before.comment.screenshot_error, 'capture failed');
  assert.ok(fs.existsSync(path.join(L.inbox, 'r.zip')), 'comment_get does not archive');
  const { dir } = callTool(L, 'batch_open', { id: 'R1', repo_dir: fs.mkdtempSync(path.join(os.tmpdir(), 'pfb-norepo-')) });
  const after = callTool(L, 'comment_get', { batch_id: 'R1', comment_id: 'p1' });
  assert.equal(after.dir, dir);
  assert.equal(after.comment.comment.length, 300);
  assert.equal(after.comment.screenshot_path, 'screenshots/p1.png');
  assert.equal(after.comment.verb, 'fix');
  assert.equal(after.status, null);
  assert.throws(() => callTool(L, 'comment_get', { batch_id: 'R1', comment_id: 'zz' }), /unknown comment zz in batch R1/);
  assert.throws(() => callTool(L, 'comment_get', { batch_id: 'R1', comment_id: '__proto__' }), /unknown comment/);
  assert.throws(() => callTool(L, 'comment_get', { batch_id: '../x', comment_id: 'p1' }), /invalid batch id/);
});

test('a unique id prefix of 6+ chars resolves to the full batch id; ambiguous or short ones do not', () => {
  // 2026-11-08 headless run: `/pfb:feedback bf66a6f0` failed with "no batch with id bf66a6f0".
  const L = fixture({ a: v6('bf66a6f0-13f9-4a20-ac53-128d892afe01', ['c1']), b: v6('bf66a6ff-0000-4000-8000-000000000000', ['c1']), c: v6('1ccdd245-8a41', ['c1']) });
  assert.equal(callTool(L, 'batch_preview', { id: 'bf66a6f0' }).id, 'bf66a6f0-13f9-4a20-ac53-128d892afe01');
  assert.throws(() => callTool(L, 'batch_preview', { id: 'bf66a6' }), /ambiguous: .*bf66a6f0.*bf66a6ff|ambiguous: .*bf66a6ff.*bf66a6f0/);
  assert.throws(() => callTool(L, 'batch_preview', { id: '1ccdd' }), /no batch with id 1ccdd/);
  const opened = callTool(L, 'batch_open', { id: '1ccdd245' });
  assert.equal(opened.id, '1ccdd245-8a41');
  assert.equal(callTool(L, 'comment_get', { batch_id: '1ccdd245', comment_id: 'c1' }).batch_id, '1ccdd245-8a41');
  assert.equal(callTool(L, 'status_set', { batch_id: '1ccdd245', comment_id: 'c1', status: 'fixed' }).entry.status, 'fixed');
});
