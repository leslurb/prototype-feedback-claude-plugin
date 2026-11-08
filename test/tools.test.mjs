import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { layout } from '../server/paths.js';
import { callTool } from '../server/tools.js';
import { listBatches } from '../server/inbox.js';
import { readStatus } from '../server/status.js';
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
