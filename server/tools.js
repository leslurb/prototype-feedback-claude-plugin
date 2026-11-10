// server/tools.js
import fs from 'node:fs';
import path from 'node:path';
import { listBatches, openBatch, previewBatch } from './inbox.js';
import { readStatus, setStatus, responsesDoc, latestByComment, writeAtomic, reviewerActedAfter, embeddedDone, ALLOWED } from './status.js';
import { readBrief, addBriefHosts, addBriefPageFile, pageFileFor } from './brief.js';
import { pageShot, findChrome } from './page-shot.js';
import { repoMatch, pageHosts, pageUrls, originUrl, makeCommitCheck } from './repo-match.js';

const REPO_DIR = { type: 'string', description: 'Folder of the repo to match against (and whose .pfb/brief.md to read). Default: the server working directory.' };

export const TOOLS = [
  { name: 'inbox_list', description: 'List Prototype Feedback batches: waiting (inbox + 0.6.0 exports in Downloads), in progress and done, newest first. Each readable batch has repo_match {match, by: remote|prior_commit|page_hosts|page_files|null} for the repo in repo_dir.',
    inputSchema: { type: 'object', properties: { repo_dir: REPO_DIR } } },
  { name: 'batch_preview', description: 'Read a batch without unpacking or archiving it. Returns the compact index: round_note, repo, session, prior_commits, export_kind, page_hosts, repo_match, counts and one line per comment (id, verb, urgent, page_url, text cut to 200 chars, history_kinds, state, done).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, repo_dir: REPO_DIR }, required: ['id'] } },
  { name: 'repo_remember', description: 'After the developer confirms that a batch belongs to this repo, add its page hosts to page_hosts in .pfb/brief.md so later batches from those pages match without asking. Needs an existing brief.',
    inputSchema: { type: 'object', properties: { batch_id: { type: 'string' }, repo_dir: REPO_DIR }, required: ['batch_id'] } },
  { name: 'page_file_remember', description: 'Remember which local file (relative to repo_dir) is published at a page URL: adds "<page url without query/hash> -> <file>" to page_files in .pfb/brief.md. One file per page. The file must exist inside repo_dir. Needs an existing brief.',
    inputSchema: { type: 'object', properties: { page_url: { type: 'string' }, file: { type: 'string', description: 'Path relative to repo_dir.' }, repo_dir: REPO_DIR }, required: ['page_url', 'file'] } },
  { name: 'batch_open', description: 'Unpack a batch (archives its ZIP). Returns the compact index plus dir, brief (parsed .pfb/brief.md of the repo, or null), brief_error and the cross-batch status map. Use comment_get for a full comment.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' },
      repo_dir: { type: 'string', description: 'Folder of the repo whose .pfb/brief.md to read. Default: the server working directory.' } }, required: ['id'] } },
  { name: 'comment_get', description: 'Return one full comment of a batch (screenshot and attachment paths are relative to dir; dir is null before batch_open) and its plugin status entry or null.',
    inputSchema: { type: 'object', properties: { batch_id: { type: 'string' }, comment_id: { type: 'string' } }, required: ['batch_id', 'comment_id'] } },
  { name: 'page_shot', description: 'Screenshot the local HTML file of the page of a comment in headless Chrome after a fix: restores the in-page view of the comment (view.clicks), outlines its element, writes <batch dir>/after/<comment_id>.png. Read the PNG to check the fix. The file comes from file (relative to repo_dir) or page_files in the brief. The batch must be open.',
    inputSchema: { type: 'object', properties: { batch_id: { type: 'string' }, comment_id: { type: 'string' },
      file: { type: 'string', description: 'Local HTML file relative to repo_dir. Default: the page_files entry for the page_url of the comment.' }, repo_dir: REPO_DIR },
    required: ['batch_id', 'comment_id'] } },
  { name: 'status_set', description: 'Record one comment\'s result and rewrite that batch\'s responses.json.',
    inputSchema: { type: 'object', required: ['batch_id', 'comment_id', 'status'], properties: {
      batch_id: { type: 'string' }, comment_id: { type: 'string' }, status: { type: 'string', enum: ALLOWED },
      summary: { type: 'string' }, answer: { type: 'string' }, question_back: { type: 'string' }, commit_sha: { type: 'string' },
      files_changed: { type: 'array', items: { type: 'string' } },
      verification_url: { type: 'string', description: 'Preview URL of the fixed build (from the brief preview_url_pattern).' },
      notes: { type: 'string', maxLength: 500, description: 'Rationale for the developer and reviewer (at most 500 chars).' },
      proposal: { type: 'object', properties: { approach: { type: 'string' }, effort: { type: 'string', enum: ['S', 'M', 'L'] }, risk: { type: 'string' } } } } } },
];

const PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const ID_RE = /^[A-Za-z0-9][\w.-]*$/;
function checkId(id) { if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error(`invalid batch id ${id}`); }

/** The full batch id for an exact id or a unique prefix of at least 6 characters (as shown in short tables). */
function resolveId(L, id) {
  checkId(id);
  const ids = [...new Set(listBatches(L).filter((b) => b.state !== 'error').map((b) => b.id))];
  if (ids.includes(id)) return id;
  const hits = id.length >= 6 ? ids.filter((x) => x.startsWith(id)) : [];
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) throw new Error(`batch id ${id} is ambiguous: ${hits.join(', ')}`);
  return id; // unknown: the caller reports "no batch with id"
}

const FINAL = new Set(['fixed', 'answered', 'proposed', 'needs_input', 'skipped']);
const TEXT_MAX = 200;

/** Plugin status entries that still apply to b's comments (any batch; dropped when the reviewer acted after Claude). */
function statusMap(L, comments) {
  const latest = latestByComment(readStatus(L.statusFile));
  const status = {};
  for (const c of comments) if (latest[c.id] && !reviewerActedAfter(c, latest[c.id])) status[c.id] = latest[c.id];
  return status;
}

/** Handoff v2 §3 compact index. state = plugin status, else embedded status.state, else 'new'.
 *  done = a final plugin status, or (full exports only) an embedded final state with no newer reopen-type history. */
function compactIndex(b, status) {
  const counts = { total: 0, fix: 0, change: 0, ask: 0, idea: 0, urgent: 0, done: 0 };
  const comments = b.comments.map((c) => {
    const e = status[c.id];
    const done = (e ? FINAL.has(e.status) : false) || (b.fullExport && embeddedDone(c));
    const text = typeof c.comment === 'string' ? c.comment.slice(0, TEXT_MAX) : '';
    counts.total += 1; counts[c.verb] += 1; if (c.urgent) counts.urgent += 1; if (done) counts.done += 1;
    return { id: c.id, verb: c.verb, urgent: c.urgent, page_url: c.page_url || null, text,
             history_kinds: Array.isArray(c.history) ? c.history.map((h) => h && h.kind).filter(Boolean) : [],
             state: e ? e.status : (c.status && c.status.state) || 'new', done };
  });
  const r = b.raw;
  return { id: b.id, version: b.version, export_kind: b.exportKind, full_export: b.fullExport, delta: r.delta ?? null,
           exportedAt: b.exportedAt, reviewer: b.reviewer, repo: r.repo ?? null, repoUrls: b.repoUrls,
           session: r.session ?? null, round_note: r.round_note ?? null, prior_commits: Array.isArray(r.prior_commits) ? r.prior_commits : [],
           version_hints: r.version_hints || null, bytes: b.bytes, counts, comments };
}

/** A matcher for one repo folder: the remote, the brief hosts and a memoized commit check are read once. */
function matcherFor(dir) {
  const remote = originUrl(dir);
  let briefHosts = [];
  let briefPageFiles = [];
  try {
    const b = readBrief(dir);
    if (b && Array.isArray(b.page_hosts)) briefHosts = b.page_hosts;
    if (b && Array.isArray(b.page_files)) briefPageFiles = b.page_files;
  } catch { /* brief_error is reported by batch_open */ }
  const hasCommit = makeCommitCheck(dir);
  return ({ repoUrls, priorShas, hosts, urls }) => repoMatch({ remote, repoUrls, priorShas, hosts, briefHosts, urls, briefPageFiles, hasCommit });
}

function briefFor(dir) {
  try { return { brief: readBrief(dir), brief_error: null }; }
  catch (e) { return { brief: null, brief_error: e.message }; }
}

/** page_shot: resolves to { after_shot, path }. deps = { chrome, run } for tests. */
async function pageShotTool(L, args, deps) {
  const dir = path.join(L.batches, args.batch_id);
  const fj = path.join(dir, 'feedback.json');
  if (!fs.existsSync(fj)) throw new Error(`batch ${args.batch_id} is not open; call batch_open first`);
  const feedback = JSON.parse(fs.readFileSync(fj, 'utf8'));
  const cid = args.comment_id;
  const c = PROTO_KEYS.has(cid) || !Array.isArray(feedback.comments) ? undefined : feedback.comments.find((x) => x && x.id === cid);
  if (!c) throw new Error(`unknown comment ${cid} in batch ${args.batch_id}`);
  if (!ID_RE.test(cid)) throw new Error(`comment id ${cid} cannot name a screenshot file`);
  const repoDir = path.resolve(args.repo_dir || process.cwd());
  let base = repoDir;
  let rel = args.file;
  if (!rel) {
    const brief = readBrief(repoDir);
    rel = pageFileFor(brief, c.page_url);
    if (brief) base = path.dirname(path.dirname(brief.path));
  }
  if (!rel) throw new Error(`Tell me which local file shows ${c.page_url} (page_file_remember)`);
  const file = path.resolve(base, rel);
  const inside = path.relative(base, file);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) throw new Error(`${rel} is outside ${base}`);
  const clicks = c.view && Array.isArray(c.view.clicks) ? c.view.clicks.filter((x) => typeof x === 'string') : [];
  const target = (typeof c.selector === 'string' && c.selector) || (c.anchor && typeof c.anchor.selector === 'string' && c.anchor.selector) || null;
  const out = path.join(dir, 'after', `${cid}.png`);
  await pageShot({ file, clicks, target, out, chrome: deps.chrome || findChrome(), run: deps.run });
  return { after_shot: `after/${cid}.png`, path: out };
}

/** Every tool returns its result synchronously except page_shot, which returns a promise. */
export function callTool(L, name, args = {}, deps = {}) {
  if (name === 'page_shot') {
    try { args = { ...args, batch_id: resolveId(L, args.batch_id) }; } catch (e) { return Promise.reject(e); }
    return pageShotTool(L, args, deps);
  }
  if (name === 'inbox_list') {
    const match = matcherFor(args.repo_dir || process.cwd());
    const batches = listBatches(L).map((b) => (b.state === 'error' ? b
      : { ...b, repo_match: match({ repoUrls: b.repoUrls || [], priorShas: b.priorShas || [], hosts: b.pageHosts || [], urls: b.pageUrls || [] }) }));
    return { root: L.root, batches };
  }
  if (name === 'batch_preview') {
    args = { ...args, id: resolveId(L, args.id) };
    const b = previewBatch(L, args.id);
    const idx = compactIndex(b, statusMap(L, b.comments));
    const hosts = pageHosts(b.comments);
    const repo_match = matcherFor(args.repo_dir || process.cwd())({
      repoUrls: b.repoUrls || [], priorShas: idx.prior_commits.map((p) => p && p.commit_sha).filter(Boolean), hosts, urls: pageUrls(b.comments) });
    return { ...idx, page_hosts: hosts, repo_match };
  }
  if (name === 'repo_remember') {
    args = { ...args, batch_id: resolveId(L, args.batch_id) };
    const b = previewBatch(L, args.batch_id);
    const hosts = pageHosts(b.comments);
    if (!hosts.length) throw new Error(`batch ${args.batch_id} has no page URLs to remember`);
    return addBriefHosts(args.repo_dir || process.cwd(), hosts);
  }
  if (name === 'page_file_remember') {
    if (typeof args.page_url !== 'string' || typeof args.file !== 'string') throw new Error('page_file_remember needs page_url and file');
    try { return addBriefPageFile(args.repo_dir || process.cwd(), args.page_url, args.file); }
    catch (e) {
      if (/no \.pfb\/brief\.md/.test(e.message)) throw new Error(`${e.message}: write .pfb/brief.md (step 0 of /pfb:feedback), then call page_file_remember again`);
      throw e;
    }
  }
  if (name === 'batch_open') {
    args = { ...args, id: resolveId(L, args.id) };
    const b = openBatch(L, args.id);
    const status = statusMap(L, b.comments);
    return { ...compactIndex(b, status), dir: b.dir, ...briefFor(args.repo_dir || process.cwd()), status };
  }
  if (name === 'comment_get') {
    args = { ...args, batch_id: resolveId(L, args.batch_id) };
    const b = previewBatch(L, args.batch_id);
    const c = PROTO_KEYS.has(args.comment_id) ? undefined : b.comments.find((x) => x.id === args.comment_id);
    if (!c) throw new Error(`unknown comment ${args.comment_id} in batch ${args.batch_id}`);
    return { batch_id: b.id, dir: b.dir, comment: c, status: statusMap(L, [c])[c.id] || null };
  }
  if (name === 'status_set') {
    args = { ...args, batch_id: resolveId(L, args.batch_id) };
    const dir = path.join(L.batches, args.batch_id);
    const fj = path.join(dir, 'feedback.json');
    if (!fs.existsSync(fj)) throw new Error(`batch ${args.batch_id} is not open; call batch_open first`);
    const feedback = JSON.parse(fs.readFileSync(fj, 'utf8'));
    const version = Number(/v(\d+)$/.exec(feedback.schema)?.[1] || 6);
    const { batch_id, comment_id, status, ...rest } = args;
    const known = !PROTO_KEYS.has(comment_id) && Array.isArray(feedback.comments) && feedback.comments.some((c) => c.id === comment_id);
    if (!known) throw new Error(`unknown comment ${comment_id} in batch ${batch_id}`);
    const entry = setStatus(L.statusFile, { batchId: batch_id, version, commentId: comment_id, exportId: feedback.export_id || null, status, ...rest }, undefined, {
      onWrite: (state) => writeAtomic(path.join(dir, 'responses.json'), responsesDoc(state, batch_id)), // under the status lock
    });
    return { ok: true, entry };
  }
  throw new Error(`unknown tool ${name}`);
}
