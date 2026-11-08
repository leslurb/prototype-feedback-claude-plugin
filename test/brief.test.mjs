// test/brief.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseBrief, readBrief, BRANCH_POLICIES } from '../server/brief.js';

const SAMPLE = `---
repo: https://github.com/owner/name        # optional; else git remote
base_branch: main
branch_policy: per_round                   # per_round | per_session | current_branch
open_pr: false
test_cmd: npm test                         # empty = none, agent says so
build_cmd: npm run build
lint_cmd: ""
preview_url_pattern: ""                    # e.g. https://myapp-git-{branch}-acme.vercel.app
design_system: ""                          # path or URL
do_not_touch: []                           # globs
---
Goals and constraints in prose.
`;

test('parses the contract example front matter and body', () => {
  const { fields, body } = parseBrief(SAMPLE);
  assert.deepEqual(fields, {
    repo: 'https://github.com/owner/name', base_branch: 'main', branch_policy: 'per_round', open_pr: false,
    test_cmd: 'npm test', build_cmd: 'npm run build', lint_cmd: '', preview_url_pattern: '', design_system: '', do_not_touch: [],
  });
  assert.equal(body, 'Goals and constraints in prose.\n');
});

test('parses block and flow string lists, quotes, booleans, null and CRLF', () => {
  const text = ['---', 'do_not_touch:', '  - "vendor/**"', "  - 'dist/*'", '  - legacy/**  # old', 'open_pr: true',
    'globs: [a/*, "b, c", \'d\']', 'lint_cmd:', 'hash: "a # b"', "quote: 'it''s'", 'tilde: ~', '# a comment', '', '---', 'Body'].join('\r\n');
  const { fields, body } = parseBrief(text);
  assert.deepEqual(fields.do_not_touch, ['vendor/**', 'dist/*', 'legacy/**']);
  assert.equal(fields.open_pr, true);
  assert.deepEqual(fields.globs, ['a/*', 'b, c', 'd']);
  assert.equal(fields.lint_cmd, null);
  assert.equal(fields.hash, 'a # b');
  assert.equal(fields.quote, "it's");
  assert.equal(fields.tilde, null);
  assert.equal(body, 'Body');
});

test('a value with a # not preceded by space stays intact', () => {
  assert.equal(parseBrief('---\nrepo: https://x.dev/#frag\n---\n').fields.repo, 'https://x.dev/#frag');
});

test('a file without front matter has no fields and keeps the text as body', () => {
  assert.deepEqual(parseBrief('Just prose.\n'), { fields: {}, body: 'Just prose.\n' });
});

test('malformed front matter throws with the line number', () => {
  assert.throws(() => parseBrief('---\nbase_branch: main\n'), /no closing ---/);
  assert.throws(() => parseBrief('---\nnested:\n  key: v\n---\n'), /line 3/);
  assert.throws(() => parseBrief('---\nnot a pair\n---\n'), /line 2/);
  assert.throws(() => parseBrief('---\na: 1\na: 2\n---\n'), /duplicate key a/);
  assert.throws(() => parseBrief('---\na: "open\n---\n'), /line 2/);
  assert.throws(() => parseBrief('---\nbranch_policy: sometimes\n---\n'), /branch_policy/);
});

test('every documented branch_policy value is accepted', () => {
  assert.deepEqual(BRANCH_POLICIES, ['per_round', 'per_session', 'current_branch']);
  for (const p of BRANCH_POLICIES) assert.equal(parseBrief(`---\nbranch_policy: ${p}\n---\n`).fields.branch_policy, p);
});

function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pfb-br-'));
  fs.mkdirSync(path.join(root, '.git'));
  fs.mkdirSync(path.join(root, 'src', 'deep'), { recursive: true });
  return root;
}

test('readBrief finds .pfb/brief.md at the repo root from a subfolder', () => {
  const root = repo();
  fs.mkdirSync(path.join(root, '.pfb'));
  fs.writeFileSync(path.join(root, '.pfb', 'brief.md'), SAMPLE);
  const b = readBrief(path.join(root, 'src', 'deep'));
  assert.equal(b.path, path.join(root, '.pfb', 'brief.md'));
  assert.equal(b.test_cmd, 'npm test');
  assert.equal(b.body, 'Goals and constraints in prose.\n');
});

test('readBrief returns null when the repo has no brief and does not look above the repo root', () => {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'pfb-br-'));
  fs.mkdirSync(path.join(outer, '.pfb'));
  fs.writeFileSync(path.join(outer, '.pfb', 'brief.md'), SAMPLE);
  const root = path.join(outer, 'inner');
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  assert.equal(readBrief(root), null);
});

test('readBrief reports a malformed brief with its path', () => {
  const root = repo();
  fs.mkdirSync(path.join(root, '.pfb'));
  fs.writeFileSync(path.join(root, '.pfb', 'brief.md'), '---\nbad line\n---\n');
  assert.throws(() => readBrief(root), (e) => e.message.includes(path.join(root, '.pfb', 'brief.md')) && /line 2/.test(e.message));
});
