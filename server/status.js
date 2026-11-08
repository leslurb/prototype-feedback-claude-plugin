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
