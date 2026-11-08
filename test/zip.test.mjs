// test/zip.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readZip } from '../server/zip.js';
import { makeZip } from './helpers/makezip.mjs';

test('reads stored and deflated entries', () => {
  for (const m of [0, 8]) {
    const z = readZip(makeZip({ 'feedback.json': '{"a":1}', 'screenshots/c1.png': 'PNG' }, m));
    assert.deepEqual(z.map((e) => [e.name, e.data.toString()]),
      [['feedback.json', '{"a":1}'], ['screenshots/c1.png', 'PNG']]);
  }
});

test('rejects entries that escape the archive', () => {
  assert.throws(() => readZip(makeZip({ '../evil.txt': 'x' })), /unsafe path/);
  assert.throws(() => readZip(makeZip({ '/abs.txt': 'x' })), /unsafe path/);
});

test('rejects a file that is not a zip', () => {
  assert.throws(() => readZip(Buffer.from('hello')), /not a zip/);
});
