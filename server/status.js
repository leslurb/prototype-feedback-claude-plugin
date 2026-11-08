import fs from 'node:fs';
import path from 'node:path';

export const ALLOWED = ['fixed', 'answered', 'proposed', 'needs_input', 'skipped', 'in_progress'];
// 0.6.0's importer knows only v1 names and maps unknown ones to pending (spec §6).
const V1_NAME = { fixed: 'shipped', skipped: 'wontfix', proposed: 'deferred',
                  answered: 'answered', needs_input: 'needs_input', in_progress: 'in_progress' };
const FIELDS = ['summary', 'answer', 'question_back', 'commit_sha', 'proposal', 'files_changed', 'verification_url', 'notes'];
export const NOTES_MAX = 500;

export function readStatus(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return { version: 1, batches: {} }; throw e; }
}

const RENAME_RETRY = new Set(['EPERM', 'EACCES', 'EBUSY']);

function renameRetry(tmp, file) {
  for (let n = 1; ; n += 1) {
    try { return fs.renameSync(tmp, file); }
    catch (e) {
      if (!RENAME_RETRY.has(e.code) || n >= 10) throw e;
      sleepMs(10 + Math.floor(Math.random() * 40)); // a reader holds the target open on Windows
    }
  }
}

export function writeAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    renameRetry(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* tmp may not exist */ }
    throw e;
  }
}

const LOCK_STALE_MS = 10000;
const LOCK_RETRY_MS = 25;
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Take `${file}.lock` (exclusive create). Returns the fd. Throws if still held after waitMs. */
function acquireLock(file, waitMs) {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const deadline = Date.now() + waitMs;
  for (;;) {
    try { return fs.openSync(lock, 'wx'); }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
    try {
      if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) {
        try { fs.unlinkSync(lock); } catch (e) { if (e.code !== 'ENOENT') throw e; }
        continue;
      }
    } catch (e) { if (e.code !== 'ENOENT') throw e; continue; }
    if (Date.now() >= deadline) throw new Error('status file is locked by another session');
    sleepMs(LOCK_RETRY_MS);
  }
}

/** Record one comment's status. version = the batch's export schema major (5 or 6).
 *  The whole read-modify-write runs under `${file}.lock` so concurrent sessions cannot drop each other's entries. */
export function setStatus(file, { batchId, version, exportId = null, commentId, status, ...rest }, now = () => new Date().toISOString(), { waitMs = 2000, onWrite } = {}) {
  if (!ALLOWED.includes(status)) throw new Error(`status must be one of ${ALLOWED.join(', ')}`);
  if (!batchId || !commentId) throw new Error('batchId and commentId are required');
  if (rest.notes != null && (typeof rest.notes !== 'string' || rest.notes.length > NOTES_MAX)) throw new Error(`notes must be a string of at most ${NOTES_MAX} chars`);
  if (rest.verification_url != null && !/^https?:\/\/\S+$/i.test(String(rest.verification_url))) throw new Error('verification_url must be an http(s) URL');
  const fd = acquireLock(file, waitMs);
  try {
    const s = readStatus(file);
    const b = (s.batches[batchId] ||= { version, export_id: exportId, comments: {} });
    const entry = { status, acted_at: now() };
    for (const k of FIELDS) if (rest[k] !== undefined && rest[k] !== null) entry[k] = rest[k];
    b.comments[commentId] = entry;
    writeAtomic(file, s);
    if (onWrite) onWrite(s); // still under the lock
    return entry;
  } finally {
    fs.closeSync(fd);
    try { fs.unlinkSync(`${file}.lock`); } catch (e) { if (e.code !== 'ENOENT') throw e; } // taken over as stale
  }
}

/** Per comment id, the entry with the latest acted_at across ALL batches (a re-export reuses comment ids), tagged with from_batch. */
export function latestByComment(state) {
  const out = Object.create(null);
  for (const [bid, b] of Object.entries(state.batches)) {
    for (const [cid, e] of Object.entries(b.comments)) {
      if (!out[cid] || String(e.acted_at) >= String(out[cid].acted_at)) out[cid] = { ...e, from_batch: bid };
    }
  }
  return out;
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
    return { schema: `prototype-feedback-response/${v1 ? 'v1' : 'v2'}`, batch_id: batchId, export_id: b.export_id ?? null, responded_at: now(),
             responses: Object.entries(b.comments).map(([cid, e]) => toResponse(cid, e, v1)) };
  }
  const responses = [];
  for (const [bid, b] of Object.entries(state.batches)) {
    for (const [cid, e] of Object.entries(b.comments)) {
      const r = toResponse(cid, e, false);
      responses.push({ comment_id: r.comment_id, batch_id: bid, export_id: b.export_id ?? null, ...Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'comment_id')) });
    }
  }
  return { schema: 'prototype-feedback-response/v2', responded_at: now(), responses };
}

function ms(t) { const n = Date.parse(t); return Number.isNaN(n) ? null : n; }

const REOPEN_KINDS = new Set(['reopen', 'reply', 'do_it', 'edit']);
const REOPEN_STATES = new Set(['not_sent', 'reopened']);

/** True when the reviewer reopened work after Claude acted: status.at (state not_sent/reopened) or a history[].at
 *  (kind reopen/reply/do_it/edit) is newer than entry.acted_at. Confirm (history 'confirm', state 'confirmed') and with_claude do not count. */
export function reviewerActedAfter(comment, entry) {
  const acted = ms(entry && entry.acted_at);
  if (acted === null) return false;
  const st = comment && comment.status;
  const times = [st && REOPEN_STATES.has(st.state) ? st.at : null,
    ...((comment && Array.isArray(comment.history)) ? comment.history.map((h) => (h && REOPEN_KINDS.has(h.kind) ? h.at : null)) : [])]
    .map(ms).filter((n) => n !== null);
  return times.some((t) => t > acted);
}
