import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const j = (p) => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), 'utf8'));

test('plugin manifest names the plugin pfb', () => {
  const m = j('.claude-plugin/plugin.json');
  assert.equal(m.name, 'pfb');
  assert.match(m.version, /^\d+\.\d+\.\d+$/);
});

test('marketplace lists the root plugin under the same name', () => {
  const mk = j('.claude-plugin/marketplace.json');
  assert.equal(mk.name, 'prototype-feedback');
  assert.deepEqual(mk.plugins.map((p) => [p.name, p.source]), [['pfb', './']]);
});

test('mcp config starts the bundled server from the plugin root', () => {
  const c = j('.mcp.json');
  assert.deepEqual(c.mcpServers.pfb, { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/server/mcp.js'] });
});
