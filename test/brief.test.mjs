// test/brief.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseBrief, readBrief, BRANCH_POLICIES, addBriefPageFile, pageFileFor } from '../server/brief.js';

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

test('readBrief reads .pfb/brief.md in a folder without git (plain-folder mode)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pfb-nogit-'));
  fs.mkdirSync(path.join(dir, '.pfb'));
  fs.writeFileSync(path.join(dir, '.pfb', 'brief.md'), SAMPLE);
  const b = readBrief(dir);
  assert.ok(b, 'a brief in a folder without .git is found');
  assert.equal(b.path, path.join(dir, '.pfb', 'brief.md'));
  assert.equal(b.test_cmd, 'npm test');
  assert.equal(readBrief(fs.mkdtempSync(path.join(os.tmpdir(), 'pfb-nogit-'))), null, 'no brief -> null');
});

test('parseBrief keeps page_files as a list of "url -> file" strings', () => {
  const { fields } = parseBrief('---\npage_files: ["https://h.test/1234 -> proto.html", "https://h.test/a -> sub/a.html"]\n---\n');
  assert.deepEqual(fields.page_files, ['https://h.test/1234 -> proto.html', 'https://h.test/a -> sub/a.html']);
  assert.deepEqual(parseBrief('---\npage_files:\n  - https://h.test/1234 -> proto.html\n---\n').fields.page_files, ['https://h.test/1234 -> proto.html']);
});

function plainFolder(brief = '---\nbase_branch: main\n---\nGoals.\n') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pfb-pf-'));
  fs.mkdirSync(path.join(dir, '.pfb'));
  fs.writeFileSync(path.join(dir, '.pfb', 'brief.md'), brief);
  fs.writeFileSync(path.join(dir, 'proto.html'), '<h1>x</h1>');
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'sub', 'a.html'), '<h1>a</h1>');
  return dir;
}

test('addBriefPageFile adds "url -> file" once and keeps the rest of the brief', () => {
  const dir = plainFolder();
  const r = addBriefPageFile(dir, 'https://h.test/1234', 'proto.html');
  assert.equal(r.path, path.join(dir, '.pfb', 'brief.md'));
  assert.deepEqual(r.added, ['https://h.test/1234 -> proto.html']);
  assert.deepEqual(readBrief(dir).page_files, ['https://h.test/1234 -> proto.html']);
  assert.equal(readBrief(dir).base_branch, 'main');
  assert.equal(readBrief(dir).body.trim(), 'Goals.');
  const before = fs.readFileSync(r.path, 'utf8');
  assert.deepEqual(addBriefPageFile(dir, 'https://h.test/1234?x=1#t', 'proto.html').added, [], 'idempotent; query and hash are dropped');
  assert.equal(fs.readFileSync(r.path, 'utf8'), before, 'no rewrite when nothing is new');
  addBriefPageFile(dir, 'https://h.test/a', path.join('sub', 'a.html'));
  assert.deepEqual(readBrief(dir).page_files, ['https://h.test/1234 -> proto.html', 'https://h.test/a -> sub/a.html'], 'relative paths use /');
});

test('addBriefPageFile maps one page to one file: a new file replaces the old mapping', () => {
  const dir = plainFolder();
  addBriefPageFile(dir, 'https://h.test/1234', 'proto.html');
  const r = addBriefPageFile(dir, 'https://h.test/1234', 'sub/a.html');
  assert.deepEqual(r.page_files, ['https://h.test/1234 -> sub/a.html']);
});

test('addBriefPageFile rejects a file outside the folder, a missing file, a bad URL and a missing brief', () => {
  const dir = plainFolder();
  fs.writeFileSync(path.join(path.dirname(dir), 'outside.html'), 'x');
  assert.throws(() => addBriefPageFile(dir, 'https://h.test/1', '../outside.html'), /outside/);
  assert.throws(() => addBriefPageFile(dir, 'https://h.test/1', path.join(path.dirname(dir), 'outside.html')), /outside/);
  assert.throws(() => addBriefPageFile(dir, 'https://h.test/1', 'nope.html'), /does not exist/);
  assert.throws(() => addBriefPageFile(dir, 'https://h.test/1', 'sub'), /not a file/);
  assert.throws(() => addBriefPageFile(dir, 'not a url', 'proto.html'), /page_url/);
  assert.equal(readBrief(dir).page_files, undefined, 'nothing written on a refusal');
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'pfb-pf-'));
  fs.writeFileSync(path.join(empty, 'proto.html'), 'x');
  assert.throws(() => addBriefPageFile(empty, 'https://h.test/1', 'proto.html'), /no \.pfb\/brief\.md/);
});

test('pageFileFor ignores query and hash and returns null for an unknown page', () => {
  const brief = { page_files: ['https://h.test/1234 -> proto.html', 'https://h.test/a -> sub/a.html'] };
  assert.equal(pageFileFor(brief, 'https://h.test/1234?x=1#t'), 'proto.html');
  assert.equal(pageFileFor(brief, 'https://h.test/a'), 'sub/a.html');
  assert.equal(pageFileFor(brief, 'https://h.test/other'), null);
  assert.equal(pageFileFor(brief, 'nope'), null);
  assert.equal(pageFileFor(null, 'https://h.test/1234'), null);
  assert.equal(pageFileFor({}, 'https://h.test/1234'), null);
});
