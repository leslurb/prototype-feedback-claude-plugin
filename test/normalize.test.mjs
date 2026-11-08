import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeExport } from '../server/normalize.js';

const v5 = {
  schema: 'prototype-feedback/v5', exported_at: '2026-11-06T21:02:00Z', reviewer: 'R',
  repo_hints: { 'https://a.dev': { repo: 'https://github.com/x/a' } },
  comments: [
    { id: 'c1', intent: 'bug', severity: 'high', comment: 'fix it', page_url: 'https://a.dev/p' },
    { id: 'c2', intent: 'polish', severity: 'med', comment: 'tighter', page_url: 'https://a.dev/p' },
    { id: 'c3', intent: 'behavior-change', comment: 'x', page_url: 'https://a.dev/q' },
    { id: 'c4', intent: 'question', comment: 'why?', page_url: 'https://a.dev/q' },
    { id: 'c5', comment: 'no intent', page_url: 'https://a.dev/q' },
  ],
};

test('v5 intents map to verbs and high severity to urgent', () => {
  const n = normalizeExport(v5);
  assert.equal(n.version, 5);
  assert.deepEqual(n.comments.map((c) => [c.id, c.verb, c.urgent]),
    [['c1', 'fix', true], ['c2', 'change', false], ['c3', 'change', false], ['c4', 'ask', false], ['c5', 'fix', false]]);
  assert.deepEqual(n.repoUrls, ['https://github.com/x/a']);
});

test('v6 verb and urgent pass through, export_id kept', () => {
  const n = normalizeExport({ schema: 'prototype-feedback/v6', export_id: 'e1', comments: [
    { id: 'c1', verb: 'idea', urgent: true, comment: 'maybe', page_url: 'https://a.dev/' }] });
  assert.equal(n.version, 6);
  assert.equal(n.exportId, 'e1');
  assert.deepEqual([n.comments[0].verb, n.comments[0].urgent], ['idea', true]);
});

test('rejects unknown schemas', () => {
  assert.throws(() => normalizeExport({ schema: 'something-else', comments: [] }), /not a prototype-feedback export/);
});

test('export kind, full-export flag and the top-level repo', () => {
  const base = { schema: 'prototype-feedback/v6', comments: [] };
  const send = normalizeExport({ ...base, delta: true, export_kind: 'send_claude_code', repo: 'https://github.com/x/r',
    repo_hints: { 'https://a.dev': { repo: 'https://github.com/x/a' } } });
  assert.equal(send.exportKind, 'send_claude_code');
  assert.equal(send.fullExport, false);
  assert.deepEqual(send.repoUrls, ['https://github.com/x/r', 'https://github.com/x/a']);
  assert.equal(normalizeExport({ ...base, delta: false, export_kind: 'send_claude_code' }).fullExport, true);
  assert.equal(normalizeExport({ ...base, delta: true, export_kind: 'zip' }).fullExport, true);
  assert.equal(normalizeExport({ ...base, delta: true }).fullExport, false, '0.7.0 send without export_kind is a delta');
  assert.equal(normalizeExport({ ...base }).fullExport, true, 'no delta flag = full export');
  assert.equal(normalizeExport({ ...base }).exportKind, null);
});
