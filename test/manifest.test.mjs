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

test('marketplace has a description', () => {
  assert.equal(j('.claude-plugin/marketplace.json').description, 'Prototype Feedback tools for Claude Code');
});

test('the MCP server reports the plugin.json version, and the skill intro lists every tool', async () => {
  // fleet #10: Claude Code caches plugins by version, so every user-visible change bumps
  // plugin.json; the MCP serverInfo must not drift from it.
  const { readFileSync } = await import('node:fs');
  const m = JSON.parse(readFileSync(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8'));
  const mcp = readFileSync(new URL('../server/mcp.js', import.meta.url), 'utf8');
  assert.ok(mcp.includes(`version: '${m.version}'`) || /version: PLUGIN_VERSION/.test(mcp), 'mcp.js serverInfo version matches plugin.json');
  const { TOOLS } = await import('../server/tools.js');
  const intro = readFileSync(new URL('../skills/feedback/SKILL.md', import.meta.url), 'utf8').split('\n').find((l) => l.startsWith('Work through feedback'));
  for (const t of TOOLS) assert.ok(intro.includes(`\`${t.name}\``), `SKILL intro lists ${t.name}`);
});
