// test/inbox.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { layout } from '../server/paths.js';
import { listBatches, openBatch } from '../server/inbox.js';
import { setStatus } from '../server/status.js';
import { makeZip } from './helpers/makezip.mjs';

function fixture() {
  const L = layout(fs.mkdtempSync(path.join(os.tmpdir(), 'pfb-dl-')));
  fs.mkdirSync(L.inbox, { recursive: true });
  const v6 = { schema: 'prototype-feedback/v6', export_id: 'e1', exported_at: '2026-11-08T15:00:00Z',
    repo_hints: { 'https://a.dev': { repo: 'https://github.com/x/a' } },
    comments: [{ id: 'c1', verb: 'fix', comment: 'fix it', page_url: 'https://a.dev/p', screenshot_path: 'screenshots/c1.png' }] };
  fs.writeFileSync(path.join(L.inbox, 'send-1.zip'), makeZip({ 'feedback.json': JSON.stringify(v6), 'screenshots/c1.png': 'PNG' }));
  const v5 = { schema: 'prototype-feedback/v5', exported_at: '2026-11-06T21:02:00Z',
    comments: [{ id: 'k1', intent: 'question', comment: 'why?', page_url: 'https://b.dev/' }] };
  fs.writeFileSync(path.join(L.downloads, 'prototype-feedback_R_2026-11-06.zip'), makeZip({ 'feedback.json': JSON.stringify(v5) }));
  fs.writeFileSync(path.join(L.downloads, 'unrelated.zip'), makeZip({ 'a.txt': 'x' }));
  return L;
}

test('lists inbox sends and 0.6.0 exports from Downloads, newest first', () => {
  const L = fixture();
  const list = listBatches(L);
  assert.deepEqual(list.map((b) => [b.id, b.state, b.source, b.version, b.counts]), [
    ['e1', 'waiting', 'inbox', 6, { total: 1, fix: 1, change: 0, ask: 0, idea: 0, urgent: 0 }],
    ['prototype-feedback_R_2026-11-06', 'waiting', 'export', 5, { total: 1, fix: 0, change: 0, ask: 1, idea: 0, urgent: 0 }],
  ]);
  assert.deepEqual(list[0].repoUrls, ['https://github.com/x/a']);
});

test('openBatch unpacks, archives the zip, and the batch becomes in progress', () => {
  const L = fixture();
  const b = openBatch(L, 'e1');
  assert.equal(b.dir, path.join(L.batches, 'e1'));
  assert.equal(fs.readFileSync(path.join(b.dir, 'screenshots', 'c1.png'), 'utf8'), 'PNG');
  assert.ok(fs.existsSync(path.join(L.archive, 'send-1.zip')));
  assert.ok(!fs.existsSync(path.join(L.inbox, 'send-1.zip')));
  assert.equal(b.comments[0].verb, 'fix');
  assert.equal(listBatches(L).find((x) => x.id === 'e1').state, 'in_progress');
});

test('a batch is done once every comment has a final status', () => {
  const L = fixture();
  openBatch(L, 'e1');
  setStatus(L.statusFile, { batchId: 'e1', version: 6, commentId: 'c1', status: 'fixed' });
  assert.equal(listBatches(L).find((x) => x.id === 'e1').state, 'done');
});

test('opening an already unpacked batch returns it without touching archive', () => {
  const L = fixture();
  openBatch(L, 'e1');
  const again = openBatch(L, 'e1');
  assert.equal(again.comments.length, 1);
});

test('unknown id throws a clear error', () => {
  assert.throws(() => openBatch(fixture(), 'nope'), /no batch with id nope/);
});
