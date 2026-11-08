// test/skill.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TOOLS } from '../server/tools.js';

const skill = readFileSync(new URL('../skills/feedback/SKILL.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const section = (n) => {
  const m = new RegExp(`^## ${n}\\. [\\s\\S]*?(?=^## \\d+\\. |(?![\\s\\S]))`, 'm').exec(skill);
  assert.ok(m, `SKILL.md must have a section ## ${n}.`);
  return m[0];
};
const at = (needle, where = skill) => { const i = where.indexOf(needle); assert.ok(i >= 0, `SKILL.md must mention ${needle}`); return i; };

test('skill frontmatter names it feedback with a description', () => {
  const fm = /^---\n([\s\S]*?)\n---/.exec(skill)?.[1] || '';
  assert.match(fm, /^name: feedback$/m);
  assert.match(fm, /^description: .{40,}$/m);
});

test('skill covers human recipients, branch lookup, cross-batch status and nullable screenshots', () => {
  for (const s of ['recipient_resolved', "recipient === 'human'", 'history', 'git branch -a --contains', 'from_batch', 'when present']) at(s);
});

test('skill uses every MCP tool and the agreed workflow rules', () => {
  for (const s of ['feedback/', 'git status --porcelain', 'one commit per comment', 'needs_input', 'proposed', 'Import status']) at(s);
  for (const t of TOOLS) at(`\`${t.name}\``);
});

test('skill states the verbatim precedence line and that it outranks the embedded guide', () => {
  at("If you are running the pfb plugin's /pfb:feedback skill, its steps win over this guide. Otherwise follow this guide.");
  at('_llm_guide');
  assert.match(skill, /outrank/);
});

test('skill sections follow the contract order', () => {
  const heads = [...skill.matchAll(/^## (\d+)\. (.*)$/gm)].map((m) => [Number(m[1]), m[2]]);
  assert.deepEqual(heads.map(([n]) => n), [0, 1, 2, 3, 4, 5, 6]);
  assert.match(heads[0][1], /Preconditions/);
  assert.match(heads[2][1], /Preview/);
  assert.match(heads[3][1], /plan/i);
  assert.match(heads[4][1], /Branch/);
  assert.match(heads[6][1], /Report/);
});

test('step 0 reads or offers to create .pfb/brief.md one question at a time with repo defaults', () => {
  const s0 = section(0);
  for (const s of ['.pfb/brief.md', 'one question at a time', 'package.json', 'base_branch', 'branch_policy', 'test_cmd', 'preview_url_pattern', 'do_not_touch', 'Do not commit it']) at(s, s0);
  assert.ok(at('git status --porcelain', s0) < at('.pfb/brief.md', s0), 'clean-tree check comes before the brief');
});

test('step 2 previews with batch_preview, honours done and asks about big batches', () => {
  const s2 = section(2);
  for (const s of ['`batch_preview`', 'does not unpack or archive', 'round_note', 'done: true', 'confirmed, fixed, answered or proposed', 'more than 30', '1 MB']) at(s, s2);
  assert.equal(s2.includes('`batch_open`'), false, 'preview must not archive');
});

test('the ask-when-missing gate comes before planning and the OK comes before any change', () => {
  const s3 = section(3);
  const gate = at('Ask-when-missing gate', s3);
  for (const s of ['prior_commits', 'branch_policy', 'test_cmd', 'technical or architectural decision', 'repo_dir', 'brief_error']) at(s, s3);
  assert.ok(gate < at('Group comments by page', s3), 'gate before the plan');
  assert.ok(at('Wait for the developer\'s OK', s3) > gate);
  at('Do not edit, create or commit any file before the developer approves the plan');
  assert.ok(at('## 3.') < at('## 5.'));
});

test('step 3 states the field pointers for do_it, reopen, reply and edit, and comment_get per comment', () => {
  const s3 = section(3);
  for (const s of ['`comment_get`', 'response.proposal', 'response.commit_sha', 'response.files_changed', 'response.question_back', 'previous_comment', 'screenshot_error']) at(s, s3);
});

test('step 4 classifies prior commits exactly as the contract says', () => {
  const s4 = section(4);
  const a = at('git cat-file -e <sha>', s4), b = at('git merge-base --is-ancestor <sha> HEAD', s4), c = at('git branch -a --contains <sha>', s4);
  assert.ok(a < b && b < c, 'missing → merged → unmerged order');
  for (const s of ['per_round', 'per_session', 'current_branch', 'base_branch', 'ask the developer']) at(s, s4);
});

test('step 5 runs tests before each commit and reports verification_url and notes', () => {
  const s5 = section(5);
  const t = at('test_cmd', s5);
  assert.ok(t < at('one commit per comment', s5), 'tests before the commit');
  for (const s of ['build_cmd', 'verification_url', 'preview_url_pattern', '`notes`', 'in_progress', 'do_not_touch', 'git add -- <files>']) at(s, s5);
  for (const s of ['product, copy or visual preference', 'screenshot_path` is null and the text is empty', 'Ask the developer']) at(s, s5);
});

test('step 6 picks the return path from reviewer_is_developer and export_kind', () => {
  const s6 = section(6);
  for (const s of ['round_note.reviewer_is_developer', 'export_kind', '<dir>/responses.json', 'More → **Import status**', 'update on their own', 'open_pr']) at(s, s6);
  at('Do not merge', s6);
});
