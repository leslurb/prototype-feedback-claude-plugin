import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { downloadsDir, layout } from '../server/paths.js';

test('PFB_DOWNLOADS overrides the Downloads folder', () => {
  assert.equal(downloadsDir({ PFB_DOWNLOADS: '/x/dl' }), path.resolve('/x/dl'));
});

test('default is <home>/Downloads', () => {
  assert.equal(downloadsDir({}), path.join(os.homedir(), 'Downloads'));
});

test('layout derives every folder from the Downloads folder', () => {
  const L = layout('/d');
  assert.deepEqual(L, {
    downloads: path.resolve('/d'),
    root: path.join(path.resolve('/d'), 'prototype-feedback'),
    inbox: path.join(path.resolve('/d'), 'prototype-feedback', 'inbox'),
    batches: path.join(path.resolve('/d'), 'prototype-feedback', 'batches'),
    archive: path.join(path.resolve('/d'), 'prototype-feedback', 'archive'),
    statusFile: path.join(path.resolve('/d'), 'prototype-feedback', 'status.json'),
  });
});
