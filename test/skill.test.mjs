// test/skill.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const skill = readFileSync(new URL('../skills/feedback/SKILL.md', import.meta.url), 'utf8');

test('skill frontmatter names it feedback with a description', () => {
  const fm = /^---\n([\s\S]*?)\n---/.exec(skill)?.[1] || '';
  assert.match(fm, /^name: feedback$/m);
  assert.match(fm, /^description: .{40,}$/m);
});

test('skill covers human recipients, branch lookup, cross-batch status and nullable screenshots', () => {
  for (const s of ['recipient_resolved', 'git branch --contains', 'from_batch', 'when present']) {
    assert.ok(skill.includes(s), `SKILL.md must mention ${s}`);
  }
});

test('skill uses every MCP tool and the agreed workflow rules', () => {
  for (const s of ['inbox_list', 'batch_open', 'status_set', 'feedback/', 'git status --porcelain',
                   'one commit per comment', 'needs_input', 'proposed', 'Import status']) {
    assert.ok(skill.includes(s), `SKILL.md must mention ${s}`);
  }
});
