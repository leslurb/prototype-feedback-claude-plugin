// server/tools.js
import fs from 'node:fs';
import path from 'node:path';
import { listBatches, openBatch, previewBatch } from './inbox.js';
import { readStatus, setStatus, responsesDoc, latestByComment, writeAtomic, reviewerActedAfter, embeddedDone, ALLOWED } from './status.js';
import { readBrief, addBriefHosts } from './brief.js';
import { repoMatch, pageHosts, originUrl, makeCommitCheck } from './repo-match.js';

const REPO_DIR = { type: 'string', description: 'Folder of the repo to match against (and whose .pfb/brief.md to read). Default: the server working directory.' };

export const TOOLS = [
  { name: 'inbox_list', description: 'List Prototype Feedback batches: waiting (inbox + 0.6.0 exports in Downloads), in progress and done, newest first. Each readable batch has repo_match {match, by: remote|prior_commit|page_hosts|null} for the repo in repo_dir.',
    inputSchema: { type: 'object', properties: { repo_dir: REPO_DIR } } },
  { name: 'batch_preview', description: 'Read a batch without unpacking or archiving it. Returns the compact index: round_note, repo, session, prior_commits, export_kind, page_hosts, repo_match, counts and one line per comment (id, verb, urgent, page_url, text cut to 200 chars, history_kinds, state, done).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, repo_dir: REPO_DIR }, required: ['id'] } },
  { name: 'repo_remember', description: 'After the developer confirms that a batch belongs to this repo, add its page hosts to page_hosts in .pfb/brief.md so later batches from those pages match without asking. Needs an existing brief.',
    inputSchema: { type: 'object', properties: { batch_id: { type: 'string' }, repo_dir: REPO_DIR }, required: ['batch_id'] } },
  { name: 'batch_open', description: 'Unpack a batch (archives its ZIP). Returns the compact index plus dir, brief (parsed .pfb/brief.md of the repo, or null), brief_error and the cross-batch status map. Use comment_get for a full comment.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' },
      repo_dir: { type: 'string', description: 'Folder of the repo whose .pfb/brief.md to read. Default: the server working directory.' } }, required: ['id'] } },
  { name: 'comment_get', description: 'Return one full comment of a batch (screenshot and attachment paths are relative to dir; dir is null before batch_open) and its plugin status entry or null.',
    inputSchema: { type: 'object', properties: { batch_id: { type: 'string' }, comment_id: { type: 'string' } }, required: ['batch_id', 'comment_id'] } },
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
  try { const b = readBrief(dir); if (b && Array.isArray(b.page_hosts)) briefHosts = b.page_hosts; } catch { /* brief_error is reported by batch_open */ }
  const hasCommit = makeCommitCheck(dir);
  return ({ repoUrls, priorShas, hosts }) => repoMatch({ remote, repoUrls, priorShas, hosts, briefHosts, hasCommit });
}

function briefFor(dir) {
  try { return { brief: readBrief(dir), brief_error: null }; }
  catch (e) { return { brief: null, brief_error: e.message }; }
}

export function callTool(L, name, args = {}) {
  if (name === 'inbox_list') {
    const match = matcherFor(args.repo_dir || process.cwd());
    const batches = listBatches(L).map((b) => (b.state === 'error' ? b
      : { ...b, repo_match: match({ repoUrls: b.repoUrls || [], priorShas: b.priorShas || [], hosts: b.pageHosts || [] }) }));
    return { root: L.root, batches };
  }
  if (name === 'batch_preview') {
    checkId(args.id);
    const b = previewBatch(L, args.id);
    const idx = compactIndex(b, statusMap(L, b.comments));
    const hosts = pageHosts(b.comments);
    const repo_match = matcherFor(args.repo_dir || process.cwd())({
      repoUrls: b.repoUrls || [], priorShas: idx.prior_commits.map((p) => p && p.commit_sha).filter(Boolean), hosts });
    return { ...idx, page_hosts: hosts, repo_match };
  }
  if (name === 'repo_remember') {
    checkId(args.batch_id);
    const b = previewBatch(L, args.batch_id);
    const hosts = pageHosts(b.comments);
    if (!hosts.length) throw new Error(`batch ${args.batch_id} has no page URLs to remember`);
    return addBriefHosts(args.repo_dir || process.cwd(), hosts);
  }
  if (name === 'batch_open') {
    checkId(args.id);
    const b = openBatch(L, args.id);
    const status = statusMap(L, b.comments);
    return { ...compactIndex(b, status), dir: b.dir, ...briefFor(args.repo_dir || process.cwd()), status };
  }
  if (name === 'comment_get') {
    checkId(args.batch_id);
    const b = previewBatch(L, args.batch_id);
    const c = PROTO_KEYS.has(args.comment_id) ? undefined : b.comments.find((x) => x.id === args.comment_id);
    if (!c) throw new Error(`unknown comment ${args.comment_id} in batch ${args.batch_id}`);
    return { batch_id: b.id, dir: b.dir, comment: c, status: statusMap(L, [c])[c.id] || null };
  }
  if (name === 'status_set') {
    checkId(args.batch_id);
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
