# pfb Claude Code Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Claude Code plugin `pfb` whose `/pfb:feedback` skill picks up Prototype Feedback exports from the Downloads folder, works through them in the current repo, records per-comment status, and serves that status back to the extension on `127.0.0.1`.

**Spec:** `C:\Users\sebas\prototype-feedback-extension\docs\superpowers\specs\2026-11-08-claude-code-integration-design.md` §6, §7, §9.1. Decisions 29–34 in memory `project_prototype_feedback_claude_integration`.

**Non-goals:**
- No extension changes (0.7.0 is a separate plan). The plugin must work with today's 0.6.0 ZIPs.
- No npm dependencies, no bundler, no MCP SDK: plain Node ≥ 18 built-ins only.
- No write endpoints on the HTTP listener (reads only, spec §7).
- No marketplace publication / making the repo public.

**Architecture:** Plain-Node ES modules under `server/`. Pure modules (`paths`, `zip`, `normalize`, `responses`) are unit-tested with `node:test`; `inbox` and `status` do file I/O against a directory passed in (tests use a temp dir). `server/mcp.js` is a minimal newline-delimited JSON-RPC 2.0 stdio MCP server exposing `inbox_list`, `batch_open`, `status_set`; on start it also tries to open the read-only HTTP listener (`server/listener.js`) on `127.0.0.1:41837` and quietly skips if another session already holds the port — all sessions share one status file, so whichever process serves returns the same data. The `/pfb:feedback` skill drives the workflow and calls the MCP tools.

**Tech Stack:** Node ≥ 18 (`node:test`, `node:http`, `node:zlib`, `node:fs`), Claude Code plugin format (`.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `.mcp.json`, `skills/feedback/SKILL.md`).

**Assumptions / Preconditions:**
- Repo `C:\Users\sebas\prototype-feedback-claude-plugin`, branch `main`, already has `.gitignore` (`node_modules/`, `.superpowers/`, `*.log`) and `README.md`; remote `origin` = private `leslurb/prototype-feedback-claude-plugin`; `.git/hooks/post-commit` auto-pushes every commit.
- Execute in a worktree on branch `feature/pfb-plugin` (the hook pushes that branch too; that is fine — the repo is private).
- `node --version` ≥ 18 (laptop has v24). Run tests with `node --test` from the repo root.
- Folder layout on disk (all under the Downloads folder, overridable by env `PFB_DOWNLOADS`):
  - `prototype-feedback/inbox/*.zip` — 0.7.0 sends
  - `prototype-feedback_*.zip` in the Downloads root — 0.6.0 "Export for LLM"
  - `prototype-feedback/batches/<id>/` — unpacked batches
  - `prototype-feedback/archive/` — ZIPs after unpacking
  - `prototype-feedback/status.json` — shared status file
- 0.6.0 ZIPs are STORED (no compression), `feedback.json` at root, schema `prototype-feedback/v5`, `comments[].intent` ∈ bug|question|polish|behavior-change, `comments[].severity` ∈ low|med|high, `screenshot_path` / `viewport_screenshot_path` relative to the ZIP root.
- 0.6.0's importer only knows v1 statuses (`shipped, deferred, wontfix, needs_input, answered, in_progress, pending`) and maps unknown ones to `pending`. Ruling recorded here: for v5 (0.6.0) batches the plugin writes `responses.json` with v1 status names; v6 batches get v2.

**Rollback:** Code-only, new repo. `git checkout main && git branch -D feature/pfb-plugin` (and delete the remote branch the hook pushed: `git push origin --delete feature/pfb-plugin`). Data the plugin wrote lives under `Downloads/prototype-feedback/`; deleting `batches/`, `archive/` and `status.json` resets it (ZIPs in `archive/` can be moved back to `inbox/` first).

---

### Task 1: Plugin skeleton and manifests

**Files:**
- Create: `.gitattributes`, `package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `.mcp.json`, `test/manifest.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// test/manifest.test.mjs
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/`
Expected: FAIL — `ENOENT ... .claude-plugin/plugin.json`.

- [ ] **Step 3: Write minimal implementation**

`.gitattributes`:
```
* text=auto eol=lf
```

`package.json`:
```json
{
  "name": "pfb-claude-plugin",
  "private": true,
  "type": "module",
  "engines": { "node": ">=18" },
  "scripts": { "test": "node --test test/" }
}
```

`.claude-plugin/plugin.json`:
```json
{
  "name": "pfb",
  "version": "0.1.0",
  "description": "Work through Prototype Feedback exports in Claude Code with /pfb:feedback, and report status back to the extension.",
  "author": { "name": "leslurb" },
  "repository": "https://github.com/leslurb/prototype-feedback-claude-plugin",
  "license": "MIT",
  "keywords": ["feedback", "prototype", "review"]
}
```

`.claude-plugin/marketplace.json`:
```json
{
  "name": "prototype-feedback",
  "owner": { "name": "leslurb" },
  "plugins": [
    { "name": "pfb", "source": "./", "description": "Prototype Feedback → Claude Code (/pfb:feedback)" }
  ]
}
```

`.mcp.json`:
```json
{
  "mcpServers": {
    "pfb": { "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/server/mcp.js"] }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/`
Expected: `# pass 3`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add .gitattributes package.json .claude-plugin .mcp.json test/manifest.test.mjs && git commit -m "feat: plugin skeleton (pfb manifest, marketplace, mcp config)"
```

---

### Task 2: Paths

**Files:**
- Create: `server/paths.js`, `test/paths.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// test/paths.test.mjs
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/paths.test.mjs`
Expected: FAIL — `Cannot find module '.../server/paths.js'`.

- [ ] **Step 3: Write minimal implementation**

```js
// server/paths.js
import os from 'node:os';
import path from 'node:path';

/** The user's Downloads folder; PFB_DOWNLOADS overrides it (custom Chrome download dir, tests). */
export function downloadsDir(env = process.env) {
  if (env.PFB_DOWNLOADS) return path.resolve(env.PFB_DOWNLOADS);
  return path.join(os.homedir(), 'Downloads');
}

export function layout(downloads = downloadsDir()) {
  const d = path.resolve(downloads);
  const root = path.join(d, 'prototype-feedback');
  return {
    downloads: d,
    root,
    inbox: path.join(root, 'inbox'),
    batches: path.join(root, 'batches'),
    archive: path.join(root, 'archive'),
    statusFile: path.join(root, 'status.json'),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/`
Expected: `# fail 0` (6 tests pass).

- [ ] **Step 5: Commit**

```bash
git add server/paths.js test/paths.test.mjs && git commit -m "feat: Downloads-based folder layout with PFB_DOWNLOADS override"
```

---

### Task 3: ZIP reader

**Files:**
- Create: `server/zip.js`, `test/zip.test.mjs`, `test/helpers/makezip.mjs`

- [ ] **Step 1: Write the failing test**

```js
// test/helpers/makezip.mjs  (helper, not a test file: node --test only runs *.test.mjs)
import zlib from 'node:zlib';

// Minimal ZIP writer for tests: method 0 (stored) or 8 (deflate).
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (const b of buf) { c = (crc ^ b) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
  return (crc ^ 0xffffffff) >>> 0;
}
export function makeZip(files, method = 0) {
  const locals = [], centrals = []; let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text); const data = method === 8 ? zlib.deflateRawSync(raw) : raw;
    const nameBuf = Buffer.from(name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc32(raw), 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nameBuf.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc32(raw), 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, nameBuf, data); centrals.push(ch, nameBuf); offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals); const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(Object.keys(files).length, 8); eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}
```

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/zip.test.mjs`
Expected: FAIL — `Cannot find module '.../server/zip.js'`.

- [ ] **Step 3: Write minimal implementation**

```js
// server/zip.js
import zlib from 'node:zlib';

/** Read a ZIP buffer into [{name, data}]. Supports stored (0) and deflate (8); rejects unsafe paths. */
export function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt zip central directory');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen).replace(/\\/g, '/');
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    if (name.startsWith('/') || /^[a-zA-Z]:/.test(name) || name.split('/').includes('..')) {
      throw new Error(`unsafe path in zip: ${name}`);
    }
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + csize);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`unsupported zip method ${method} for ${name}`);
    out.push({ name, data });
  }
  return out;
}
```

(0.6.0's `lib/zip.js` writes backslash separators on Windows — the `replace(/\\/g, '/')` normalises them.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/`
Expected: `# fail 0` (9 tests).

- [ ] **Step 5: Commit**

```bash
git add server/zip.js test/zip.test.mjs test/helpers/makezip.mjs && git commit -m "feat: dependency-free zip reader (stored + deflate, path-escape guard)"
```

---

### Task 4: Normalise v5/v6 exports

**Files:**
- Create: `server/normalize.js`, `test/normalize.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// test/normalize.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeExport } from '../server/normalize.js';

const v5 = {
  schema: 'prototype-feedback/v5', exported_at: '2026-11-06T21:02:00Z', reviewer: 'R',
  repo_hints: { 'https://a.dev': { repo: 'https://github.com/x/a' } },
  comments: [
    { id: 'c1', intent: 'bug', severity: 'high', comment: 'fix it', page_url: 'https://a.dev/p' },
    { id: 'c2', intent: 'polish', severity: 'med', comment: 'tighter', page_url: 'https://a.dev/p' },
    { id: 'c3', intent: 'behavior-change', comment: 'x', page_url: 'https://a.dev/q' },
    { id: 'c4', intent: 'question', comment: 'why?', page_url: 'https://a.dev/q' },
    { id: 'c5', comment: 'no intent', page_url: 'https://a.dev/q' },
  ],
};

test('v5 intents map to verbs and high severity to urgent', () => {
  const n = normalizeExport(v5);
  assert.equal(n.version, 5);
  assert.deepEqual(n.comments.map((c) => [c.id, c.verb, c.urgent]),
    [['c1', 'fix', true], ['c2', 'change', false], ['c3', 'change', false], ['c4', 'ask', false], ['c5', 'fix', false]]);
  assert.deepEqual(n.repoUrls, ['https://github.com/x/a']);
});

test('v6 verb and urgent pass through, export_id kept', () => {
  const n = normalizeExport({ schema: 'prototype-feedback/v6', export_id: 'e1', comments: [
    { id: 'c1', verb: 'idea', urgent: true, comment: 'maybe', page_url: 'https://a.dev/' }] });
  assert.equal(n.version, 6);
  assert.equal(n.exportId, 'e1');
  assert.deepEqual([n.comments[0].verb, n.comments[0].urgent], ['idea', true]);
});

test('rejects unknown schemas', () => {
  assert.throws(() => normalizeExport({ schema: 'something-else', comments: [] }), /not a prototype-feedback export/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/normalize.test.mjs`
Expected: FAIL — `Cannot find module '.../server/normalize.js'`.

- [ ] **Step 3: Write minimal implementation**

```js
// server/normalize.js
const INTENT_TO_VERB = { bug: 'fix', polish: 'change', 'behavior-change': 'change', question: 'ask' };
const VERBS = new Set(['fix', 'change', 'ask', 'idea']);

/** Normalise a prototype-feedback/v5 or v6 export to one shape the skill and status code use. */
export function normalizeExport(json) {
  const m = /^prototype-feedback\/v(\d+)$/.exec(json?.schema || '');
  if (!m || !Array.isArray(json.comments)) throw new Error(`not a prototype-feedback export (schema ${json?.schema})`);
  const version = Number(m[1]);
  const comments = json.comments.map((c) => ({
    ...c,
    verb: VERBS.has(c.verb) ? c.verb : (INTENT_TO_VERB[c.intent] || 'fix'),
    urgent: typeof c.urgent === 'boolean' ? c.urgent : c.severity === 'high',
  }));
  const repoUrls = [...new Set(Object.values(json.repo_hints || {}).map((h) => h && h.repo).filter(Boolean))];
  return { version, exportId: json.export_id || null, exportedAt: json.exported_at || null,
           reviewer: json.reviewer || null, repoUrls, comments, raw: json };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/`
Expected: `# fail 0` (12 tests).

- [ ] **Step 5: Commit**

```bash
git add server/normalize.js test/normalize.test.mjs && git commit -m "feat: normalise v5/v6 exports to verbs + urgent"
```

---

### Task 5: Status store and response documents

**Files:**
- Create: `server/status.js`, `test/status.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// test/status.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readStatus, setStatus, responsesDoc, ALLOWED } from '../server/status.js';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pfb-st-')), 'status.json');

test('missing file reads as empty', () => {
  assert.deepEqual(readStatus(tmp()), { version: 1, batches: {} });
});

test('setStatus writes atomically and merges', () => {
  const f = tmp();
  setStatus(f, { batchId: 'b1', version: 5, commentId: 'c1', status: 'fixed', summary: 's', commit_sha: 'abc' }, () => '2026-11-08T16:02:00Z');
  setStatus(f, { batchId: 'b1', version: 5, commentId: 'c2', status: 'needs_input', question_back: 'which?' }, () => '2026-11-08T16:03:00Z');
  const s = readStatus(f);
  assert.deepEqual(Object.keys(s.batches.b1.comments), ['c1', 'c2']);
  assert.equal(s.batches.b1.comments.c1.acted_at, '2026-11-08T16:02:00Z');
  assert.ok(!fs.readdirSync(path.dirname(f)).some((n) => n.endsWith('.tmp')));
});

test('rejects unknown statuses', () => {
  assert.throws(() => setStatus(tmp(), { batchId: 'b', version: 6, commentId: 'c', status: 'shipped' }), /status must be one of/);
  assert.deepEqual(ALLOWED, ['fixed', 'answered', 'proposed', 'needs_input', 'skipped', 'in_progress']);
});

test('v5 batches get v1 status names, v6 keep v2', () => {
  const f = tmp();
  setStatus(f, { batchId: 'old', version: 5, commentId: 'a', status: 'fixed' }, () => 't');
  setStatus(f, { batchId: 'old', version: 5, commentId: 'b', status: 'skipped', summary: 'out of scope' }, () => 't');
  setStatus(f, { batchId: 'old', version: 5, commentId: 'c', status: 'proposed', proposal: { approach: 'x', effort: 'M', risk: 'low' } }, () => 't');
  setStatus(f, { batchId: 'new', version: 6, commentId: 'd', status: 'fixed' }, () => 't');
  const s = readStatus(f);
  const v1 = responsesDoc(s, 'old', () => 'now');
  assert.equal(v1.schema, 'prototype-feedback-response/v1');
  assert.deepEqual(v1.responses.map((r) => [r.comment_id, r.status]), [['a', 'shipped'], ['b', 'wontfix'], ['c', 'deferred']]);
  assert.match(v1.responses[2].summary, /Proposal: x/);
  const v2 = responsesDoc(s, 'new', () => 'now');
  assert.equal(v2.schema, 'prototype-feedback-response/v2');
  assert.deepEqual(v2.responses.map((r) => r.status), ['fixed']);
});

test('all-batches document (for the listener) is v2 with batch ids', () => {
  const f = tmp();
  setStatus(f, { batchId: 'b1', version: 6, commentId: 'c1', status: 'answered', answer: 'yes' }, () => 't');
  const all = responsesDoc(readStatus(f), null, () => 'now');
  assert.equal(all.schema, 'prototype-feedback-response/v2');
  assert.deepEqual(all.responses, [{ comment_id: 'c1', batch_id: 'b1', status: 'answered', answer: 'yes', acted_at: 't' }]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/status.test.mjs`
Expected: FAIL — `Cannot find module '.../server/status.js'`.

- [ ] **Step 3: Write minimal implementation**

```js
// server/status.js
import fs from 'node:fs';
import path from 'node:path';

export const ALLOWED = ['fixed', 'answered', 'proposed', 'needs_input', 'skipped', 'in_progress'];
// 0.6.0's importer knows only v1 names and maps unknown ones to pending (spec §6).
const V1_NAME = { fixed: 'shipped', skipped: 'wontfix', proposed: 'deferred',
                  answered: 'answered', needs_input: 'needs_input', in_progress: 'in_progress' };
const FIELDS = ['summary', 'answer', 'question_back', 'commit_sha', 'proposal', 'files_changed'];

export function readStatus(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return { version: 1, batches: {} }; throw e; }
}

function writeAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

/** Record one comment's status. version = the batch's export schema major (5 or 6). */
export function setStatus(file, { batchId, version, commentId, status, ...rest }, now = () => new Date().toISOString()) {
  if (!ALLOWED.includes(status)) throw new Error(`status must be one of ${ALLOWED.join(', ')}`);
  if (!batchId || !commentId) throw new Error('batchId and commentId are required');
  const s = readStatus(file);
  const b = (s.batches[batchId] ||= { version, comments: {} });
  const entry = { status, acted_at: now() };
  for (const k of FIELDS) if (rest[k] !== undefined && rest[k] !== null) entry[k] = rest[k];
  b.comments[commentId] = entry;
  writeAtomic(file, s);
  return entry;
}

function toResponse(commentId, e, v1) {
  const r = { comment_id: commentId, status: v1 ? V1_NAME[e.status] : e.status };
  for (const k of FIELDS) if (e[k] !== undefined) r[k] = e[k];
  if (v1 && e.status === 'proposed' && e.proposal) {
    const p = e.proposal;
    r.summary = `Proposal: ${p.approach} (effort ${p.effort}, risk ${p.risk})`;
  }
  r.acted_at = e.acted_at;
  return r;
}

/** One batch's responses.json (v1 for v5 batches, v2 for v6), or all batches as v2 when batchId is null. */
export function responsesDoc(state, batchId, now = () => new Date().toISOString()) {
  if (batchId) {
    const b = state.batches[batchId] || { version: 6, comments: {} };
    const v1 = b.version < 6;
    return { schema: `prototype-feedback-response/${v1 ? 'v1' : 'v2'}`, batch_id: batchId, responded_at: now(),
             responses: Object.entries(b.comments).map(([cid, e]) => toResponse(cid, e, v1)) };
  }
  const responses = [];
  for (const [bid, b] of Object.entries(state.batches)) {
    for (const [cid, e] of Object.entries(b.comments)) {
      const r = toResponse(cid, e, false);
      responses.push({ comment_id: r.comment_id, batch_id: bid, ...Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'comment_id')) });
    }
  }
  return { schema: 'prototype-feedback-response/v2', responded_at: now(), responses };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/`
Expected: `# fail 0` (17 tests).

- [ ] **Step 5: Commit**

```bash
git add server/status.js test/status.test.mjs && git commit -m "feat: shared status file with atomic writes; v1/v2 responses documents"
```

---

### Task 6: Inbox listing and batch unpacking

**Files:**
- Create: `server/inbox.js`, `test/inbox.test.mjs`
- Test helper reuse: `makeZip` from `test/helpers/makezip.mjs` (Task 3)

- [ ] **Step 1: Write the failing test**

```js
// test/inbox.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { layout } from '../server/paths.js';
import { listBatches, openBatch } from '../server/inbox.js';
import { setStatus } from '../server/status.js';
import { makeZip } from './helpers/makezip.mjs';

function fixture() {
  const L = layout(fs.mkdtempSync(path.join(os.tmpdir(), 'pfb-dl-')));
  fs.mkdirSync(L.inbox, { recursive: true });
  const v6 = { schema: 'prototype-feedback/v6', export_id: 'e1', exported_at: '2026-11-08T15:00:00Z',
    repo_hints: { 'https://a.dev': { repo: 'https://github.com/x/a' } },
    comments: [{ id: 'c1', verb: 'fix', comment: 'fix it', page_url: 'https://a.dev/p', screenshot_path: 'screenshots/c1.png' }] };
  fs.writeFileSync(path.join(L.inbox, 'send-1.zip'), makeZip({ 'feedback.json': JSON.stringify(v6), 'screenshots/c1.png': 'PNG' }));
  const v5 = { schema: 'prototype-feedback/v5', exported_at: '2026-11-06T21:02:00Z',
    comments: [{ id: 'k1', intent: 'question', comment: 'why?', page_url: 'https://b.dev/' }] };
  fs.writeFileSync(path.join(L.downloads, 'prototype-feedback_R_2026-11-06.zip'), makeZip({ 'feedback.json': JSON.stringify(v5) }));
  fs.writeFileSync(path.join(L.downloads, 'unrelated.zip'), makeZip({ 'a.txt': 'x' }));
  return L;
}

test('lists inbox sends and 0.6.0 exports from Downloads, newest first', () => {
  const L = fixture();
  const list = listBatches(L);
  assert.deepEqual(list.map((b) => [b.id, b.state, b.source, b.version, b.counts]), [
    ['e1', 'waiting', 'inbox', 6, { total: 1, fix: 1, change: 0, ask: 0, idea: 0, urgent: 0 }],
    ['prototype-feedback_R_2026-11-06', 'waiting', 'export', 5, { total: 1, fix: 0, change: 0, ask: 1, idea: 0, urgent: 0 }],
  ]);
  assert.deepEqual(list[0].repoUrls, ['https://github.com/x/a']);
});

test('openBatch unpacks, archives the zip, and the batch becomes in progress', () => {
  const L = fixture();
  const b = openBatch(L, 'e1');
  assert.equal(b.dir, path.join(L.batches, 'e1'));
  assert.equal(fs.readFileSync(path.join(b.dir, 'screenshots', 'c1.png'), 'utf8'), 'PNG');
  assert.ok(fs.existsSync(path.join(L.archive, 'send-1.zip')));
  assert.ok(!fs.existsSync(path.join(L.inbox, 'send-1.zip')));
  assert.equal(b.comments[0].verb, 'fix');
  assert.equal(listBatches(L).find((x) => x.id === 'e1').state, 'in_progress');
});

test('a batch is done once every comment has a final status', () => {
  const L = fixture();
  openBatch(L, 'e1');
  setStatus(L.statusFile, { batchId: 'e1', version: 6, commentId: 'c1', status: 'fixed' });
  assert.equal(listBatches(L).find((x) => x.id === 'e1').state, 'done');
});

test('opening an already unpacked batch returns it without touching archive', () => {
  const L = fixture();
  openBatch(L, 'e1');
  const again = openBatch(L, 'e1');
  assert.equal(again.comments.length, 1);
});

test('unknown id throws a clear error', () => {
  assert.throws(() => openBatch(fixture(), 'nope'), /no batch with id nope/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/inbox.test.mjs`
Expected: FAIL — `Cannot find module '.../server/inbox.js'`.

- [ ] **Step 3: Write minimal implementation**

```js
// server/inbox.js
import fs from 'node:fs';
import path from 'node:path';
import { readZip } from './zip.js';
import { normalizeExport } from './normalize.js';
import { readStatus } from './status.js';

const FINAL = new Set(['fixed', 'answered', 'proposed', 'needs_input', 'skipped']);
const EXPORT_RE = /^prototype-feedback_.*\.zip$/;

function readExportFromZip(file) {
  const entries = readZip(fs.readFileSync(file));
  const fj = entries.find((e) => e.name === 'feedback.json');
  if (!fj) throw new Error(`${path.basename(file)} has no feedback.json`);
  return { entries, norm: normalizeExport(JSON.parse(fj.data.toString('utf8'))) };
}

function counts(comments) {
  const c = { total: comments.length, fix: 0, change: 0, ask: 0, idea: 0, urgent: 0 };
  for (const x of comments) { c[x.verb] += 1; if (x.urgent) c.urgent += 1; }
  return c;
}

function zipCandidates(L) {
  const out = [];
  if (fs.existsSync(L.inbox)) for (const n of fs.readdirSync(L.inbox)) if (n.endsWith('.zip')) out.push({ file: path.join(L.inbox, n), source: 'inbox' });
  if (fs.existsSync(L.downloads)) for (const n of fs.readdirSync(L.downloads)) if (EXPORT_RE.test(n)) out.push({ file: path.join(L.downloads, n), source: 'export' });
  return out;
}

const idFor = (norm, file) => norm.exportId || path.basename(file, '.zip');

/** Waiting ZIPs plus unpacked batches, newest first. Unreadable ZIPs are listed with an error, never hidden. */
export function listBatches(L) {
  const status = readStatus(L.statusFile);
  const seen = new Set();
  const list = [];
  if (fs.existsSync(L.batches)) {
    for (const id of fs.readdirSync(L.batches)) {
      const fj = path.join(L.batches, id, 'feedback.json');
      if (!fs.existsSync(fj)) continue;
      const norm = normalizeExport(JSON.parse(fs.readFileSync(fj, 'utf8')));
      const st = status.batches[id]?.comments || {};
      const done = norm.comments.every((c) => FINAL.has(st[c.id]?.status));
      list.push({ id, state: done ? 'done' : 'in_progress', source: 'unpacked', version: norm.version,
                  exportedAt: norm.exportedAt, repoUrls: norm.repoUrls, counts: counts(norm.comments) });
      seen.add(id);
    }
  }
  for (const { file, source } of zipCandidates(L)) {
    try {
      const { norm } = readExportFromZip(file);
      const id = idFor(norm, file);
      if (seen.has(id)) continue;
      list.push({ id, state: 'waiting', source, version: norm.version, exportedAt: norm.exportedAt,
                  repoUrls: norm.repoUrls, counts: counts(norm.comments), file });
    } catch (e) {
      if (source === 'inbox') list.push({ id: path.basename(file, '.zip'), state: 'error', source, error: e.message, file });
    }
  }
  return list.sort((a, b) => String(b.exportedAt || '').localeCompare(String(a.exportedAt || '')));
}

/** Unpack a waiting batch into batches/<id>/ and move its ZIP to archive/; return the normalised export. */
export function openBatch(L, id) {
  const dir = path.join(L.batches, id);
  if (fs.existsSync(path.join(dir, 'feedback.json'))) {
    const norm = normalizeExport(JSON.parse(fs.readFileSync(path.join(dir, 'feedback.json'), 'utf8')));
    return { id, dir, ...norm };
  }
  const hit = zipCandidates(L).find(({ file }) => {
    try { return idFor(readExportFromZip(file).norm, file) === id; } catch { return false; }
  });
  if (!hit) throw new Error(`no batch with id ${id}`);
  const { entries, norm } = readExportFromZip(hit.file);
  const tmp = `${dir}.unpacking`;
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const e of entries) {
    const dest = path.join(tmp, ...e.name.split('/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, e.data);
  }
  fs.renameSync(tmp, dir);
  fs.mkdirSync(L.archive, { recursive: true });
  fs.renameSync(hit.file, path.join(L.archive, path.basename(hit.file)));
  return { id, dir, ...norm };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/`
Expected: `# fail 0` (22 tests).

- [ ] **Step 5: Commit**

```bash
git add server/inbox.js test/inbox.test.mjs && git commit -m "feat: list inbox + 0.6.0 exports, unpack batches and archive their zips"
```

---

### Task 7: Read-only status listener

**Files:**
- Create: `server/listener.js`, `test/listener.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// test/listener.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startListener, PUBLISHED_ORIGIN } from '../server/listener.js';
import { setStatus } from '../server/status.js';

const statusFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pfb-ls-')), 'status.json');

test('serves /status and /health to the extension origin only', async () => {
  const f = statusFile();
  setStatus(f, { batchId: 'b1', version: 6, commentId: 'c1', status: 'fixed' });
  const srv = await startListener({ port: 0, statusFile: f });
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const ok = await fetch(`${base}/status`, { headers: { Origin: PUBLISHED_ORIGIN } });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('access-control-allow-origin'), PUBLISHED_ORIGIN);
    const doc = await ok.json();
    assert.deepEqual(doc.responses.map((r) => [r.batch_id, r.comment_id, r.status]), [['b1', 'c1', 'fixed']]);
    assert.equal((await fetch(`${base}/health`, { headers: { Origin: PUBLISHED_ORIGIN } })).status, 200);
    assert.equal((await fetch(`${base}/status`, { headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await fetch(`${base}/status`)).status, 403);
    assert.equal((await fetch(`${base}/status`, { method: 'POST', headers: { Origin: PUBLISHED_ORIGIN } })).status, 405);
  } finally { srv.close(); }
});

test('extra origins come from PFB_EXTRA_ORIGINS', async () => {
  const srv = await startListener({ port: 0, statusFile: statusFile(), extraOrigins: 'chrome-extension://dev1' });
  try {
    const r = await fetch(`http://127.0.0.1:${srv.address().port}/health`, { headers: { Origin: 'chrome-extension://dev1' } });
    assert.equal(r.status, 200);
  } finally { srv.close(); }
});

test('a port already in use resolves to null instead of throwing', async () => {
  const first = await startListener({ port: 0, statusFile: statusFile() });
  try {
    const second = await startListener({ port: first.address().port, statusFile: statusFile() });
    assert.equal(second, null);
  } finally { first.close(); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/listener.test.mjs`
Expected: FAIL — `Cannot find module '.../server/listener.js'`.

- [ ] **Step 3: Write minimal implementation**

```js
// server/listener.js
import http from 'node:http';
import { readStatus, responsesDoc } from './status.js';

export const PUBLISHED_ORIGIN = 'chrome-extension://lkpciiloidfgdhlgaefcbggajlfljmbp';
export const DEFAULT_PORT = 41837;

/** Read-only status listener on 127.0.0.1. Resolves to the server, or null if the port is taken
 *  (another Claude session already serves the same shared status file). */
export function startListener({ port = DEFAULT_PORT, statusFile, extraOrigins = process.env.PFB_EXTRA_ORIGINS, log = () => {} }) {
  const allowed = new Set([PUBLISHED_ORIGIN, ...String(extraOrigins || '').split(',').map((s) => s.trim()).filter(Boolean)]);
  const srv = http.createServer((req, res) => {
    const origin = req.headers.origin;
    if (!origin || !allowed.has(origin)) { res.writeHead(403); res.end('forbidden'); return; }
    const cors = { 'Access-Control-Allow-Origin': origin, Vary: 'Origin', 'Access-Control-Allow-Private-Network': 'true' };
    if (req.method === 'OPTIONS') { res.writeHead(204, { ...cors, 'Access-Control-Allow-Methods': 'GET' }); res.end(); return; }
    if (req.method !== 'GET') { res.writeHead(405, cors); res.end(); return; }
    const url = new URL(req.url, 'http://127.0.0.1');
    let body;
    try {
      if (url.pathname === '/health') body = { ok: true, pid: process.pid };
      else if (url.pathname === '/status') body = responsesDoc(readStatus(statusFile), null);
      else { res.writeHead(404, cors); res.end(); return; }
    } catch (e) {
      log(`pfb listener: ${e.message}`);
      res.writeHead(500, cors); res.end(JSON.stringify({ error: e.message })); return;
    }
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  return new Promise((resolve, reject) => {
    srv.once('error', (e) => (e.code === 'EADDRINUSE' ? resolve(null) : reject(e)));
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/`
Expected: `# fail 0` (25 tests).

- [ ] **Step 5: Commit**

```bash
git add server/listener.js test/listener.test.mjs && git commit -m "feat: read-only status listener on 127.0.0.1 with extension Origin allowlist"
```

---

### Task 8: MCP stdio server

**Files:**
- Create: `server/mcp.js`, `server/tools.js`, `test/mcp.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// test/mcp.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeZip } from './helpers/makezip.mjs';

const SERVER = fileURLToPath(new URL('../server/mcp.js', import.meta.url));

function rpc(child) {
  let buf = ''; const waiting = new Map(); let next = 1;
  child.stdout.on('data', (d) => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      waiting.get(msg.id)?.(msg); waiting.delete(msg.id);
    }
  });
  return (method, params) => new Promise((resolve) => {
    const id = next++; waiting.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

test('initialize, list tools, open a batch and set status over stdio', async () => {
  const dl = fs.mkdtempSync(path.join(os.tmpdir(), 'pfb-mcp-'));
  fs.mkdirSync(path.join(dl, 'prototype-feedback', 'inbox'), { recursive: true });
  fs.writeFileSync(path.join(dl, 'prototype-feedback', 'inbox', 's.zip'), makeZip({ 'feedback.json': JSON.stringify({
    schema: 'prototype-feedback/v6', export_id: 'e1', comments: [{ id: 'c1', verb: 'fix', comment: 'x', page_url: 'https://a.dev/' }] }) }));
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, PFB_DOWNLOADS: dl, PFB_PORT: '0' } });
  const call = rpc(child);
  try {
    const init = await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    assert.equal(init.result.serverInfo.name, 'pfb');
    assert.equal(init.result.protocolVersion, '2025-06-18');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const tools = await call('tools/list', {});
    assert.deepEqual(tools.result.tools.map((t) => t.name).sort(), ['batch_open', 'inbox_list', 'status_set']);
    const list = JSON.parse((await call('tools/call', { name: 'inbox_list', arguments: {} })).result.content[0].text);
    assert.equal(list.batches[0].id, 'e1');
    const opened = JSON.parse((await call('tools/call', { name: 'batch_open', arguments: { id: 'e1' } })).result.content[0].text);
    assert.equal(opened.comments[0].id, 'c1');
    assert.ok(fs.existsSync(path.join(opened.dir, 'feedback.json')));
    const set = await call('tools/call', { name: 'status_set', arguments: { batch_id: 'e1', comment_id: 'c1', status: 'fixed', commit_sha: 'abc', summary: 'done' } });
    assert.ok(!set.result.isError);
    const rj = JSON.parse(fs.readFileSync(path.join(opened.dir, 'responses.json'), 'utf8'));
    assert.deepEqual(rj.responses.map((r) => [r.comment_id, r.status]), [['c1', 'fixed']]);
    const bad = await call('tools/call', { name: 'status_set', arguments: { batch_id: 'e1', comment_id: 'c1', status: 'nope' } });
    assert.equal(bad.result.isError, true);
    const unknown = await call('nope/method', {});
    assert.equal(unknown.error.code, -32601);
  } finally { child.kill(); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/mcp.test.mjs`
Expected: FAIL — the child exits (`Cannot find module .../server/mcp.js`) and the first `call` never resolves; node:test reports the test as failed/cancelled.

- [ ] **Step 3: Write minimal implementation**

```js
// server/tools.js
import fs from 'node:fs';
import path from 'node:path';
import { listBatches, openBatch } from './inbox.js';
import { readStatus, setStatus, responsesDoc, ALLOWED } from './status.js';

export const TOOLS = [
  { name: 'inbox_list', description: 'List Prototype Feedback batches: waiting (inbox + 0.6.0 exports in Downloads), in progress and done, newest first.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'batch_open', description: 'Unpack a batch (archives its ZIP) and return its folder plus normalised comments (verb, urgent, screenshot paths relative to dir).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'status_set', description: 'Record one comment\'s result and rewrite that batch\'s responses.json.',
    inputSchema: { type: 'object', required: ['batch_id', 'comment_id', 'status'], properties: {
      batch_id: { type: 'string' }, comment_id: { type: 'string' }, status: { type: 'string', enum: ALLOWED },
      summary: { type: 'string' }, answer: { type: 'string' }, question_back: { type: 'string' }, commit_sha: { type: 'string' },
      files_changed: { type: 'array', items: { type: 'string' } },
      proposal: { type: 'object', properties: { approach: { type: 'string' }, effort: { type: 'string', enum: ['S', 'M', 'L'] }, risk: { type: 'string' } } } } } },
];

export function callTool(L, name, args = {}) {
  if (name === 'inbox_list') return { root: L.root, batches: listBatches(L) };
  if (name === 'batch_open') {
    const b = openBatch(L, args.id);
    return { id: b.id, dir: b.dir, version: b.version, exportedAt: b.exportedAt, reviewer: b.reviewer, repoUrls: b.repoUrls,
             version_hints: b.raw.version_hints || null, comments: b.comments, status: readStatus(L.statusFile).batches[b.id]?.comments || {} };
  }
  if (name === 'status_set') {
    const dir = path.join(L.batches, args.batch_id);
    const fj = path.join(dir, 'feedback.json');
    if (!fs.existsSync(fj)) throw new Error(`batch ${args.batch_id} is not open; call batch_open first`);
    const version = Number(/v(\d+)$/.exec(JSON.parse(fs.readFileSync(fj, 'utf8')).schema)?.[1] || 6);
    const { batch_id, comment_id, status, ...rest } = args;
    const entry = setStatus(L.statusFile, { batchId: batch_id, version, commentId: comment_id, status, ...rest });
    fs.writeFileSync(path.join(dir, 'responses.json'), JSON.stringify(responsesDoc(readStatus(L.statusFile), batch_id), null, 2));
    return { ok: true, entry };
  }
  throw new Error(`unknown tool ${name}`);
}
```

```js
// server/mcp.js
// Minimal MCP server over stdio: newline-delimited JSON-RPC 2.0. No dependencies.
import readline from 'node:readline';
import { layout, downloadsDir } from './paths.js';
import { TOOLS, callTool } from './tools.js';
import { startListener, DEFAULT_PORT } from './listener.js';

const L = layout(downloadsDir());
const log = (m) => process.stderr.write(`${m}\n`);
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

const port = process.env.PFB_PORT !== undefined ? Number(process.env.PFB_PORT) : DEFAULT_PORT;
startListener({ port, statusFile: L.statusFile, log })
  .then((srv) => log(srv ? `pfb: status listener on 127.0.0.1:${srv.address().port}` : `pfb: port ${port} in use; another session serves status`))
  .catch((e) => log(`pfb: status listener failed: ${e.message}`));

function handle(msg) {
  const { id, method, params = {} } = msg;
  if (id === undefined) return; // notification
  try {
    if (method === 'initialize') {
      return send({ jsonrpc: '2.0', id, result: {
        protocolVersion: params.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'pfb', version: '0.1.0' } } });
    }
    if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
    if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    if (method === 'tools/call') {
      try {
        const out = callTool(L, params.name, params.arguments || {});
        return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] } });
      } catch (e) {
        return send({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: e.message }] } });
      }
    }
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
  } catch (e) {
    send({ jsonrpc: '2.0', id, error: { code: -32603, message: e.message } });
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); }
  handle(msg);
});
rl.on('close', () => process.exit(0));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/`
Expected: `# fail 0` (26 tests).

- [ ] **Step 5: Commit**

```bash
git add server/mcp.js server/tools.js test/mcp.test.mjs && git commit -m "feat: dependency-free MCP stdio server with inbox_list, batch_open, status_set"
```

---

### Task 9: The `/pfb:feedback` skill and README

**Files:**
- Create: `skills/feedback/SKILL.md`
- Modify: `README.md`
- Test: `test/skill.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
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

test('skill uses every MCP tool and the agreed workflow rules', () => {
  for (const s of ['inbox_list', 'batch_open', 'status_set', 'feedback/', 'git status --porcelain',
                   'one commit per comment', 'needs_input', 'proposed', 'Import status']) {
    assert.ok(skill.includes(s), `SKILL.md must mention ${s}`);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/skill.test.mjs`
Expected: FAIL — `ENOENT ... skills/feedback/SKILL.md`.

- [ ] **Step 3: Write minimal implementation**

`skills/feedback/SKILL.md` (LF line endings):

````markdown
---
name: feedback
description: Work through Prototype Feedback batches (pinned review comments with screenshots) in this repo. Use when the user types /pfb:feedback or asks to work on prototype feedback, review comments from the extension, or the feedback inbox.
---

# /pfb:feedback

Work through feedback that reviewers pinned on a prototype with the Prototype Feedback Chrome extension. Tools come from the `pfb` MCP server: `inbox_list`, `batch_open`, `status_set`. If those tools are missing, tell the user the plugin's MCP server did not start and that it needs `node` on PATH (`node --version`), then stop.

## 1. Pick a batch
1. Call `inbox_list`. Show the batches as a short table: id, state (waiting / in_progress / done / error), exported date in ET, comment counts by verb (fix, change, ask, idea) and urgent count.
2. Put batches whose `repoUrls` match this repo's git remote (`git remote get-url origin`, compare host + owner/repo, ignore `.git` and protocol) first. Mark them "this repo".
3. If there are no waiting or in-progress batches, say so, and say where exports are read from (`<Downloads>/prototype-feedback/inbox/` and `prototype-feedback_*.zip` in Downloads). Stop.
4. Ask the user which batch to work on. Default to the newest matching one.

## 2. Open it
1. Call `batch_open` with the id. It unpacks the batch to `<dir>` and archives the ZIP.
2. Skip comments that already have a final status in the returned `status` map (fixed, answered, proposed, needs_input, skipped).
3. If `version_hints` pins a commit and it is in this repo's history, run `git rev-list --count <commit>..HEAD` and say how many commits the code moved since the reviewed version. Flag comments whose page maps to files changed since then (`git diff --name-only <commit>..HEAD`).

## 3. Plan, then wait
1. Group comments by page, urgent first. For each, one line: verb, the reviewer's text (or "(no text — infer from screenshot)"), and what you intend to do.
2. Read each comment's `screenshot_path` and `viewport_screenshot_path` (relative to `<dir>`) with the Read tool before planning it. Use `selector` and `element_snapshot` to find the element in the code.
3. Show the plan and wait for the user's OK. Do not edit anything before that.

## 4. Branch
1. Run `git status --porcelain`. If it prints anything, stop and ask the user to commit or stash first.
2. Create and check out a branch `feedback/<site>-<YYYY-MM-DD>` from HEAD (`<site>` = the first comment's page host without `www.`, dots → dashes; date in ET). If it exists, add `-2`, `-3`, …

## 5. Work each comment
Per verb:
- **fix** — something is wrong; decide how to make it right. A thin or empty comment is fine: infer from the screenshot, DOM snapshot and console log. Make the change, then make **one commit per comment** (message: `feedback: <short summary>`), then `status_set` with `status: "fixed"`, `commit_sha`, `summary` (≤120 chars), `files_changed`.
- **change** — it works but should be different as described. Same as fix.
- **ask** — answer the question from the code; no code changes. `status_set` with `status: "answered"` and `answer`.
- **idea** — no code. Write a short proposal and `status_set` with `status: "proposed"` and `proposal: {approach, effort: "S"|"M"|"L", risk}`.
- If you cannot tell what the reviewer wants, or it needs a product decision, do not guess: `status_set` with `status: "needs_input"` and one-sentence `question_back`.
- If it is out of scope or impossible, `status_set` with `status: "skipped"` and the reason in `summary`.

Call `status_set` right after each comment, not at the end, so status reaches the extension while you work.

## 6. Finish
1. Summarise: per comment, its status and one line. List the branch name and commits.
2. Tell the user how the reviewer sees the result:
   - Extension 0.7.0+ with Claude Code open: the pins update on their own.
   - Extension 0.6.0: open the extension popup → **Import status** (Import resolutions) and pick `<dir>/responses.json`.
3. Do not merge the branch; merging is the user's call.
````

Replace `README.md` with:

````markdown
# pfb — Prototype Feedback for Claude Code

Work through feedback pinned with the [Prototype Feedback](https://chromewebstore.google.com/detail/prototype-feedback/lkpciiloidfgdhlgaefcbggajlfljmbp) Chrome extension, inside Claude Code.

## Install

Needs Claude Code and Node.js 18+ (`node --version`).

```bash
claude plugin marketplace add leslurb/prototype-feedback-claude-plugin
claude plugin install pfb@prototype-feedback
```

## Use

1. In the extension, press **Send to Claude Code** (0.7.0+) or **Export for LLM** (0.6.0).
2. In Claude Code, inside the prototype's repo, type `/pfb:feedback`.

Claude lists waiting batches, shows a plan, and after your OK fixes each comment on a new `feedback/<site>-<date>` branch, one commit per comment.

## Where files go

Everything lives in your Downloads folder (override with `PFB_DOWNLOADS`):

| Path | What |
|---|---|
| `prototype-feedback/inbox/` | sends from extension 0.7.0+ |
| `prototype-feedback_*.zip` | 0.6.0 exports, picked up too |
| `prototype-feedback/batches/<id>/` | unpacked batches + `responses.json` |
| `prototype-feedback/archive/` | ZIPs after unpacking |
| `prototype-feedback/status.json` | per-comment status |

While a Claude Code session is open, the plugin serves status read-only on `127.0.0.1:41837` to the extension only (Origin check). Nothing leaves your machine.
````

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/`
Expected: `# fail 0` (28 tests).

- [ ] **Step 5: Commit**

```bash
git add skills/feedback/SKILL.md README.md test/skill.test.mjs && git commit -m "feat: /pfb:feedback skill and README"
```

---

### Task 10: End-to-end verification in a real Claude Code session

**Files:** none (manual)

- [ ] **Step 1: Validate the plugin**

Run: `claude plugin validate .`
Expected: no errors. (If the subcommand reports the root-plugin layout as an error, record the exact message — the marketplace `source: "./"` is the thing to adjust.)

- [ ] **Step 2: Install from the local checkout**

```bash
claude plugin marketplace add "C:/Users/sebas/prototype-feedback-claude-plugin"
claude plugin install pfb@prototype-feedback --scope user
claude plugin list
```
Expected: `pfb` listed and enabled.

- [ ] **Step 3: Seed a real 0.6.0 export**

In Chrome with extension 0.6.0, pin one comment on any page and press **Export for LLM**. Expected: `Downloads/prototype-feedback_<reviewer>_<stamp>.zip` exists.

- [ ] **Step 4: Run the skill headlessly against a scratch repo**

```bash
D=$(mktemp -d) && cd "$D" && git init -q && echo hi > index.html && git add . && git commit -qm init
claude -p "/pfb:feedback — list the batches only, do not open any" --allowedTools "mcp__plugin_pfb_pfb__inbox_list"
```
Expected: output lists the export from Step 3 with state `waiting`. (If the MCP tool name differs, `claude mcp list` / `/mcp` shows the real one — record it.)

- [ ] **Step 5: Listener reachable from the extension origin, refused otherwise**

While an interactive `claude` session is open in that repo (so the MCP server runs):
```bash
curl -s -o /dev/null -w "%{http_code}\n" -H "Origin: chrome-extension://lkpciiloidfgdhlgaefcbggajlfljmbp" http://127.0.0.1:41837/health
curl -s -o /dev/null -w "%{http_code}\n" -H "Origin: https://evil.example" http://127.0.0.1:41837/health
```
Expected: `200`, then `403`.

- [ ] **Step 6: Full loop in the interactive session**

Type `/pfb:feedback`, pick the batch, approve the plan. Expected: a `feedback/...` branch with one commit, `Downloads/prototype-feedback/batches/<id>/responses.json` with schema `prototype-feedback-response/v1` and status `shipped`; importing that file in the 0.6.0 popup shows the green "shipped" chip on the comment.

- [ ] **Step 7: Clean up**

```bash
claude plugin uninstall pfb@prototype-feedback
```
Move the test ZIP back from `Downloads/prototype-feedback/archive/` if you want to keep it; delete `Downloads/prototype-feedback/batches/<id>` and the scratch repo.

- [ ] **Step 8: Full suite**

Run: `node --test test/`
Expected: `# fail 0` (28 tests).
