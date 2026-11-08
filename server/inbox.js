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
    if (!path.resolve(dest).startsWith(path.resolve(tmp) + path.sep)) throw new Error(`unsafe path in ${path.basename(hit.file)}: ${e.name}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, e.data);
  }
  fs.renameSync(tmp, dir);
  fs.mkdirSync(L.archive, { recursive: true });
  fs.renameSync(hit.file, path.join(L.archive, path.basename(hit.file)));
  return { id, dir, ...norm };
}
