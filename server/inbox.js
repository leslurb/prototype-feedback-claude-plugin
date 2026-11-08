// server/inbox.js
import fs from 'node:fs';
import path from 'node:path';
import { readZip } from './zip.js';
import { normalizeExport } from './normalize.js';
import { readStatus, reviewerActedAfter, embeddedDone } from './status.js';

const FINAL = new Set(['fixed', 'answered', 'proposed', 'needs_input', 'skipped']);
const EXPORT_RE = /^prototype-feedback_.*\.zip$/;

function readExportFromZip(file) {
  const entries = readZip(fs.readFileSync(file));
  const fj = entries.find((e) => e.name === 'feedback.json');
  if (!fj) throw new Error(`${path.basename(file)} has no feedback.json`);
  return { entries, bytes: fj.data.length, norm: normalizeExport(JSON.parse(fj.data.toString('utf8'))) };
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

const idFor = (norm, file) => norm.exportId || path.basename(file, '.zip').replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
const validId = (id) => typeof id === 'string' && /^[A-Za-z0-9][\w.-]*$/.test(id) && !id.endsWith('.unpacking');

function archiveZip(L, file) {
  fs.mkdirSync(L.archive, { recursive: true });
  const base = path.basename(file, '.zip');
  let target = path.join(L.archive, `${base}.zip`);
  for (let n = 1; fs.existsSync(target); n += 1) target = path.join(L.archive, `${base}-${n}.zip`);
  fs.renameSync(file, target);
}

function findZip(L, id) {
  return zipCandidates(L).find(({ file }) => {
    try { return idFor(readExportFromZip(file).norm, file) === id; } catch { return false; }
  });
}

/** Waiting ZIPs plus unpacked batches, newest first. Unreadable entries are listed with an error, never hidden. */
export function listBatches(L) {
  const status = readStatus(L.statusFile);
  // A comment is final if ANY batch holds a final status for its id (0.6.0 re-exports reuse comment ids).
  // An entry older than the comment's own status.at / latest history[].at in the batch being judged does not count (the reviewer acted after Claude).
  const finalEntries = new Map();
  for (const b of Object.values(status.batches)) {
    for (const [cid, e] of Object.entries(b.comments)) {
      if (FINAL.has(e.status)) { if (!finalEntries.has(cid)) finalEntries.set(cid, []); finalEntries.get(cid).push(e); }
    }
  }
  const unpacked = new Set();
  const list = [];
  if (fs.existsSync(L.batches)) {
    for (const id of fs.readdirSync(L.batches)) {
      if (id.endsWith('.unpacking')) continue;
      const fj = path.join(L.batches, id, 'feedback.json');
      if (!fs.existsSync(fj)) continue;
      unpacked.add(id);
      try {
        const norm = normalizeExport(JSON.parse(fs.readFileSync(fj, 'utf8')));
        const done = norm.comments.every((c) => (finalEntries.get(c.id) || []).some((e) => !reviewerActedAfter(c, e))
          || (norm.fullExport && embeddedDone(c)));
        list.push({ id, state: done ? 'done' : 'in_progress', source: 'unpacked', version: norm.version,
                    exportedAt: norm.exportedAt, repoUrls: norm.repoUrls, counts: counts(norm.comments) });
      } catch (e) {
        list.push({ id, state: 'error', source: 'unpacked', error: e.message });
      }
    }
  }
  const waiting = [];
  for (const { file, source } of zipCandidates(L)) {
    try {
      const { norm } = readExportFromZip(file);
      const id = idFor(norm, file);
      if (!validId(id)) throw new Error(`invalid batch id ${id}`);
      waiting.push({ id, state: 'waiting', source, version: norm.version, exportedAt: norm.exportedAt,
                     repoUrls: norm.repoUrls, counts: counts(norm.comments), file });
    } catch (e) {
      list.push({ id: path.basename(file, '.zip'), state: 'error', source, error: e.message, file });
    }
  }
  const byNewest = (a, b) => String(b.exportedAt || '').localeCompare(String(a.exportedAt || ''));
  const taken = new Set();
  for (const w of waiting.sort(byNewest)) {
    if (unpacked.has(w.id)) continue;
    if (taken.has(w.id)) {
      list.push({ id: path.basename(w.file, '.zip'), state: 'error', source: w.source, error: `duplicate batch id ${w.id}`, file: w.file });
      continue;
    }
    taken.add(w.id);
    list.push(w);
  }
  return list.sort(byNewest);
}

/** Unpack a waiting batch into batches/<id>/ and move its ZIP to archive/; return the normalised export. */
export function openBatch(L, id) {
  if (!validId(id)) throw new Error(`invalid batch id ${id}`);
  const dir = path.join(L.batches, id);
  if (fs.existsSync(path.join(dir, 'feedback.json'))) {
    let norm;
    try { norm = normalizeExport(JSON.parse(fs.readFileSync(path.join(dir, 'feedback.json'), 'utf8'))); }
    catch (e) { throw new Error(`batch ${id} is unreadable: ${e.message}`); }
    const leftover = findZip(L, id); // crash between unpack and archive
    if (leftover) archiveZip(L, leftover.file);
    return { id, dir, bytes: fs.statSync(path.join(dir, 'feedback.json')).size, ...norm };
  }
  const hit = findZip(L, id);
  if (!hit) throw new Error(`no batch with id ${id}`);
  const { entries, bytes, norm } = readExportFromZip(hit.file);
  const tmp = `${dir}.unpacking`;
  fs.rmSync(tmp, { recursive: true, force: true });
  try {
    for (const e of entries) {
      const dest = path.join(tmp, ...e.name.split('/'));
      if (!path.resolve(dest).startsWith(path.resolve(tmp) + path.sep)) throw new Error(`unsafe path in ${path.basename(hit.file)}: ${e.name}`);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, e.data);
    }
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  fs.renameSync(tmp, dir);
  archiveZip(L, hit.file);
  return { id, dir, bytes, ...norm };
}

/** Read a batch without side effects: the unpacked copy if there is one (dir set), else the waiting ZIP (dir null). */
export function previewBatch(L, id) {
  if (!validId(id)) throw new Error(`invalid batch id ${id}`);
  const dir = path.join(L.batches, id);
  const fj = path.join(dir, 'feedback.json');
  if (fs.existsSync(fj)) {
    try { return { id, dir, bytes: fs.statSync(fj).size, ...normalizeExport(JSON.parse(fs.readFileSync(fj, 'utf8'))) }; }
    catch (e) { throw new Error(`batch ${id} is unreadable: ${e.message}`); }
  }
  const hit = findZip(L, id);
  if (!hit) throw new Error(`no batch with id ${id}`);
  const { bytes, norm } = readExportFromZip(hit.file);
  return { id, dir: null, bytes, ...norm };
}
