// server/tools.js
import fs from 'node:fs';
import path from 'node:path';
import { listBatches, openBatch } from './inbox.js';
import { readStatus, setStatus, responsesDoc, latestByComment, writeAtomic, reviewerActedAfter, ALLOWED } from './status.js';

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

const PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const ID_RE = /^[A-Za-z0-9][\w.-]*$/;
function checkId(id) { if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error(`invalid batch id ${id}`); }

export function callTool(L, name, args = {}) {
  if (name === 'inbox_list') return { root: L.root, batches: listBatches(L) };
  if (name === 'batch_open') {
    checkId(args.id);
    const b = openBatch(L, args.id);
    const latest = latestByComment(readStatus(L.statusFile));
    const status = {};
    for (const c of b.comments) if (latest[c.id] && !reviewerActedAfter(c, latest[c.id])) status[c.id] = latest[c.id];
    return { id: b.id, dir: b.dir, version: b.version, exportedAt: b.exportedAt, reviewer: b.reviewer, repoUrls: b.repoUrls,
             version_hints: b.raw.version_hints || null, comments: b.comments, status };
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
