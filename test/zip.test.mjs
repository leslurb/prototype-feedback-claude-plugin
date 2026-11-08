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

// Locate the first central-directory header (signature PK\x01\x02) in a buffer.
function centralOffset(buf) {
  return buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
}

test('rejects a central-directory csize that runs past the buffer', () => {
  const z = Buffer.from(makeZip({ 'a.txt': 'hello' }, 0));
  z.writeUInt32LE(5000, centralOffset(z) + 20);
  assert.throws(() => readZip(z), /truncated/);
});

test('rejects a truncated archive without a raw RangeError', () => {
  const z = makeZip({ 'a.txt': 'hello', 'b.txt': 'world' }, 0);
  const cut = z.subarray(0, z.length - 40);
  assert.throws(() => readZip(cut), (err) => {
    assert.ok(!(err instanceof RangeError), `got RangeError: ${err.message}`);
    assert.match(err.message, /not a zip|corrupt/);
    return true;
  });
});

test('rejects a central directory cut short while the EOCD survives', () => {
  const z = makeZip({ 'a.txt': 'hello' }, 0);
  const cd = centralOffset(z);
  const eocd = z.length - 22;
  const cut = Buffer.concat([z.subarray(0, cd + 10), z.subarray(eocd)]);
  assert.throws(() => readZip(cut), /corrupt zip central directory/);
});

test('rejects backslash-separated parent traversal', () => {
  assert.throws(() => readZip(makeZip({ 'a\\..\\b.txt': 'x' })), /unsafe path/);
});

test('rejects a drive-letter relative path', () => {
  assert.throws(() => readZip(makeZip({ 'C:x.txt': 'x' })), /unsafe path/);
});

test('rejects ZIP64 archives (csize sentinel 0xFFFFFFFF)', () => {
  const z = Buffer.from(makeZip({ 'a.txt': 'hello' }, 0));
  z.writeUInt32LE(0xffffffff, centralOffset(z) + 20);
  assert.throws(() => readZip(z), /zip64/);
});
