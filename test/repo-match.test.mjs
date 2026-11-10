import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { normRemote, pageHosts, pageUrls, repoMatch } from '../server/repo-match.js';
import { addBriefHosts, readBrief } from '../server/brief.js';
import { layout } from '../server/paths.js';
import { callTool } from '../server/tools.js';
import { makeZip } from './helpers/makezip.mjs';

const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
function gitRepo(remote = 'https://github.com/example/demo-site') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pfb-rm-'));
  git(d, 'init', '-q', '-b', 'main');
  git(d, 'config', 'user.email', 't@example.com'); git(d, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(d, 'index.html'), '<h1>x</h1>');
  git(d, 'add', 'index.html'); git(d, 'commit', '-q', '-m', 'init');
  if (remote) git(d, 'remote', 'add', 'origin', remote);
  return d;
}
const BRIEF = '---\nbase_branch: main\ntest_cmd: npm test\npage_hosts:\n  - old.example\n---\nGoals here.\n';

test('normRemote treats https, ssh and .git forms of one repo as equal', () => {
  const want = 'github.com/example/demo-site';
  for (const u of ['https://github.com/example/demo-site', 'https://github.com/Example/demo-site.git/',
                   'git@github.com:example/demo-site.git', 'ssh://git@github.com/example/demo-site']) assert.equal(normRemote(u), want, u);
  assert.equal(normRemote(''), null);
  assert.equal(normRemote('not a url'), null);
});

test('pageHosts keeps the port and drops bad URLs', () => {
  assert.deepEqual(pageHosts([{ page_url: 'http://127.0.0.1:8000/' }, { page_url: 'http://127.0.0.1:8000/a' },
                              { page_url: 'https://App.dev/x' }, { page_url: 'nope' }, {}]), ['127.0.0.1:8000', 'app.dev']);
});

test('repoMatch: remote, then prior commit, then remembered page hosts; else no match', () => {
  const base = { remote: 'git@github.com:example/demo-site.git' };
  assert.deepEqual(repoMatch({ ...base, repoUrls: ['https://github.com/example/demo-site'] }).by, 'remote');
  assert.deepEqual(repoMatch({ ...base, priorShas: ['abc1234'], hasCommit: (s) => s === 'abc1234' }).by, 'prior_commit');
  assert.equal(repoMatch({ ...base, hosts: ['127.0.0.1:8000'], briefHosts: ['127.0.0.1:8000'] }).by, 'page_hosts');
  // Every host must be known: one unknown page keeps the question.
  assert.equal(repoMatch({ ...base, hosts: ['127.0.0.1:8000', 'other.dev'], briefHosts: ['127.0.0.1:8000'] }).match, false);
  assert.equal(repoMatch({ ...base, hosts: [], briefHosts: [] }).match, false);
  assert.equal(repoMatch({ ...base, repoUrls: ['https://github.com/someone/else'] }).match, false);
});

test('addBriefHosts merges into page_hosts, keeps the rest of the brief, and is idempotent', () => {
  const d = gitRepo();
  fs.mkdirSync(path.join(d, '.pfb'));
  fs.writeFileSync(path.join(d, '.pfb', 'brief.md'), BRIEF);
  const r = addBriefHosts(d, ['127.0.0.1:8000']);
  assert.deepEqual(r.added, ['127.0.0.1:8000']);
  const b = readBrief(d);
  assert.deepEqual(b.page_hosts, ['127.0.0.1:8000', 'old.example']);
  assert.equal(b.test_cmd, 'npm test');
  assert.equal(b.body.trim(), 'Goals here.');
  const before = fs.readFileSync(path.join(d, '.pfb', 'brief.md'), 'utf8');
  assert.deepEqual(addBriefHosts(d, ['127.0.0.1:8000']).added, []);
  assert.equal(fs.readFileSync(path.join(d, '.pfb', 'brief.md'), 'utf8'), before, 'no rewrite when nothing is new');
});

test('addBriefHosts keeps CRLF line endings', () => {
  const d = gitRepo();
  fs.mkdirSync(path.join(d, '.pfb'));
  fs.writeFileSync(path.join(d, '.pfb', 'brief.md'), BRIEF.replace(/\n/g, '\r\n'));
  addBriefHosts(d, ['a.dev']);
  const text = fs.readFileSync(path.join(d, '.pfb', 'brief.md'), 'utf8');
  assert.equal(text.split('\n').length - 1, text.split('\r\n').length - 1, 'every newline is CRLF');
  assert.deepEqual(readBrief(d).page_hosts, ['a.dev', 'old.example']);
});

test('addBriefHosts refuses when there is no brief', () => {
  assert.throws(() => addBriefHosts(gitRepo(), ['a.dev']), /no \.pfb\/brief\.md/);
});

test('a repo-less batch asks once: repo_remember makes the next batch from those pages match', () => {
  // Reproduces the 2026-11-08 headless run: every batch without a repo URL needed a fresh confirmation.
  const d = gitRepo();
  fs.mkdirSync(path.join(d, '.pfb'));
  fs.writeFileSync(path.join(d, '.pfb', 'brief.md'), '---\nbase_branch: main\n---\n');
  const L = layout(fs.mkdtempSync(path.join(os.tmpdir(), 'pfb-rmt-')));
  fs.mkdirSync(L.inbox, { recursive: true });
  const exp = (id) => ({ schema: 'prototype-feedback/v6', export_id: id, exported_at: '2026-11-08T15:00:00Z',
    comments: [{ id: 'c1', verb: 'fix', comment: 'x', page_url: 'http://127.0.0.1:8000/' }] });
  fs.writeFileSync(path.join(L.inbox, 'a.zip'), makeZip({ 'feedback.json': JSON.stringify(exp('e1')) }));
  assert.deepEqual(callTool(L, 'batch_preview', { id: 'e1', repo_dir: d }).repo_match.match, false);
  assert.deepEqual(callTool(L, 'repo_remember', { batch_id: 'e1', repo_dir: d }).added, ['127.0.0.1:8000']);
  fs.writeFileSync(path.join(L.inbox, 'b.zip'), makeZip({ 'feedback.json': JSON.stringify(exp('e2')) }));
  const listed = callTool(L, 'inbox_list', { repo_dir: d }).batches.find((b) => b.id === 'e2');
  assert.deepEqual(listed.repo_match, { match: true, by: 'page_hosts', remote: 'github.com/example/demo-site' });
  const prev = callTool(L, 'batch_preview', { id: 'e2', repo_dir: d });
  assert.deepEqual(prev.page_hosts, ['127.0.0.1:8000']);
  assert.equal(prev.repo_match.by, 'page_hosts');
});

test('a batch whose prior commit exists in this repo matches by prior_commit', () => {
  const d = gitRepo(null);
  const sha = git(d, 'rev-parse', 'HEAD');
  const L = layout(fs.mkdtempSync(path.join(os.tmpdir(), 'pfb-rmp-')));
  fs.mkdirSync(L.inbox, { recursive: true });
  const json = { schema: 'prototype-feedback/v6', export_id: 'e3', exported_at: '2026-11-08T15:00:00Z',
    prior_commits: [{ comment_id: 'c1', commit_sha: sha }],
    comments: [{ id: 'c1', verb: 'fix', comment: 'x', page_url: 'https://elsewhere.dev/' }] };
  fs.writeFileSync(path.join(L.inbox, 'c.zip'), makeZip({ 'feedback.json': JSON.stringify(json) }));
  assert.deepEqual(callTool(L, 'inbox_list', { repo_dir: d }).batches[0].repo_match, { match: true, by: 'prior_commit', remote: null });
  json.prior_commits[0].commit_sha = '0'.repeat(40);
  fs.writeFileSync(path.join(L.inbox, 'c.zip'), makeZip({ 'feedback.json': JSON.stringify(json) }));
  assert.equal(callTool(L, 'inbox_list', { repo_dir: d }).batches[0].repo_match.match, false);
});

test('pageUrls drops query, hash and bad URLs', () => {
  assert.deepEqual(pageUrls([{ page_url: 'https://h.test/1234?x=1#t' }, { page_url: 'https://h.test/1234' }, { page_url: 'nope' }, {}]), ['https://h.test/1234']);
});

test('repoMatch: a page URL listed in page_files matches when remote and prior commits do not', () => {
  const pf = ['https://h.test/1234 -> proto.html'];
  assert.deepEqual(repoMatch({ remote: null, urls: ['https://h.test/1234'], briefPageFiles: pf }), { match: true, by: 'page_files', remote: null });
  assert.equal(repoMatch({ remote: null, urls: ['https://h.test/other'], briefPageFiles: pf }).match, false);
  assert.equal(repoMatch({ remote: null, urls: [], briefPageFiles: pf }).match, false);
  assert.equal(repoMatch({ remote: 'https://github.com/a/b', repoUrls: ['https://github.com/a/b'], urls: ['https://h.test/1234'], briefPageFiles: pf }).by, 'remote', 'remote still wins');
});

test('a plain folder (no git) with page_files matches a batch from that page in inbox_list and batch_preview', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pfb-rmf-'));
  fs.mkdirSync(path.join(d, '.pfb'));
  fs.writeFileSync(path.join(d, '.pfb', 'brief.md'), '---\npage_files: ["https://h.test/1234 -> proto.html"]\n---\n');
  const L = layout(fs.mkdtempSync(path.join(os.tmpdir(), 'pfb-rmft-')));
  fs.mkdirSync(L.inbox, { recursive: true });
  const json = { schema: 'prototype-feedback/v6', export_id: 'pf1', exported_at: '2026-11-09T15:00:00Z',
    comments: [{ id: 'c1', verb: 'fix', comment: 'x', page_url: 'https://h.test/1234?tab=2' }] };
  fs.writeFileSync(path.join(L.inbox, 'p.zip'), makeZip({ 'feedback.json': JSON.stringify(json) }));
  assert.deepEqual(callTool(L, 'inbox_list', { repo_dir: d }).batches[0].repo_match, { match: true, by: 'page_files', remote: null });
  assert.equal(callTool(L, 'batch_preview', { id: 'pf1', repo_dir: d }).repo_match.by, 'page_files');
});

test('page_file_remember writes page_files, needs a brief, and refuses a file outside the folder', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pfb-pfr-'));
  fs.writeFileSync(path.join(d, 'proto.html'), '<h1>x</h1>');
  const L = layout(fs.mkdtempSync(path.join(os.tmpdir(), 'pfb-pfrt-')));
  assert.throws(() => callTool(L, 'page_file_remember', { page_url: 'https://h.test/1234', file: 'proto.html', repo_dir: d }), /create the brief first/);
  fs.mkdirSync(path.join(d, '.pfb'));
  fs.writeFileSync(path.join(d, '.pfb', 'brief.md'), '---\nbase_branch: main\n---\n');
  const r = callTool(L, 'page_file_remember', { page_url: 'https://h.test/1234#x', file: 'proto.html', repo_dir: d });
  assert.deepEqual(r, { path: path.join(d, '.pfb', 'brief.md'), page_files: ['https://h.test/1234 -> proto.html'], added: ['https://h.test/1234 -> proto.html'] });
  assert.throws(() => callTool(L, 'page_file_remember', { page_url: 'https://h.test/1', file: '../x.html', repo_dir: d }), /outside/);
});
