// server/brief.js
// Read the developer brief `.pfb/brief.md` (handoff v2 §1.1): Markdown with YAML front matter.
// The front matter uses a small YAML subset: `key: scalar`, quoted strings, true/false, null/~,
// empty values, and string lists (`[a, b]` or `- item` lines). Anything else is an error, never a guess.
import fs from 'node:fs';
import path from 'node:path';

export const BRANCH_POLICIES = ['per_round', 'per_session', 'current_branch'];
const KEY_RE = /^([A-Za-z_][\w-]*):(?:\s+(.*))?$/;

/** Strip a ` # comment` that is outside quotes. */
function stripComment(s) {
  let q = null;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (q) { if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") q = ch;
    else if (ch === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i).trimEnd();
  }
  return s.trimEnd();
}

function scalar(raw, line) {
  const s = raw.trim();
  if (s === '' || s === '~' || s === 'null') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s.startsWith('"')) {
    if (s.length < 2 || !s.endsWith('"')) throw new Error(`line ${line}: unclosed "`);
    try { return JSON.parse(s); } catch { throw new Error(`line ${line}: bad double-quoted string`); }
  }
  if (s.startsWith("'")) {
    if (s.length < 2 || !s.endsWith("'") || s.slice(1, -1).replace(/''/g, '').includes("'")) throw new Error(`line ${line}: unclosed '`);
    return s.slice(1, -1).replace(/''/g, "'");
  }
  return s;
}

/** Split a flow list body `a, "b, c", 'd'` on commas outside quotes. */
function flowList(inner, line) {
  if (inner.trim() === '') return [];
  const parts = []; let cur = ''; let q = null;
  for (const ch of inner) {
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === ',') { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (q) throw new Error(`line ${line}: unclosed ${q}`);
  parts.push(cur);
  return parts.map((p) => {
    const v = scalar(p, line);
    if (typeof v !== 'string') throw new Error(`line ${line}: list items must be strings`);
    return v;
  });
}

function parseFrontMatter(lines, firstLine) {
  const fields = {};
  let listKey = null;
  lines.forEach((text, i) => {
    const line = firstLine + i;
    if (text.trim() === '' || text.trim().startsWith('#')) return;
    const item = /^\s+-\s+(.*)$/.exec(text) || /^\s+-$/.exec(text);
    if (item && listKey) {
      const v = scalar(stripComment(item[1] || ''), line);
      if (typeof v !== 'string') throw new Error(`line ${line}: list items must be strings`);
      if (!Array.isArray(fields[listKey])) fields[listKey] = [];
      fields[listKey].push(v);
      return;
    }
    const m = KEY_RE.exec(text);
    if (!m) throw new Error(`line ${line}: expected "key: value" (only a flat YAML subset is supported)`);
    const key = m[1];
    if (Object.prototype.hasOwnProperty.call(fields, key)) throw new Error(`line ${line}: duplicate key ${key}`);
    const rest = stripComment(m[2] || '');
    listKey = rest === '' ? key : null;
    fields[key] = rest.startsWith('[')
      ? (rest.endsWith(']') ? flowList(rest.slice(1, -1), line) : (() => { throw new Error(`line ${line}: unclosed [`); })())
      : scalar(rest, line);
  });
  return fields;
}

/** Parse brief text into { fields, body }. Throws on malformed front matter. */
export function parseBrief(text) {
  const lines = String(text).split(/\r?\n/);
  if (lines[0] !== '---') return { fields: {}, body: String(text) };
  const end = lines.indexOf('---', 1);
  if (end < 0) throw new Error('front matter has no closing ---');
  const fields = parseFrontMatter(lines.slice(1, end), 2);
  if (fields.branch_policy != null && !BRANCH_POLICIES.includes(fields.branch_policy)) {
    throw new Error(`branch_policy must be one of ${BRANCH_POLICIES.join(', ')} (got ${fields.branch_policy})`);
  }
  const body = String(text).split(/\r?\n/).slice(end + 1).join('\n');
  return { fields, body };
}

/** The repo root above startDir (the first folder that holds `.git`), or null. */
export function repoRoot(startDir) {
  let d = path.resolve(startDir);
  for (;;) {
    if (fs.existsSync(path.join(d, '.git'))) return d;
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
}

/** Parsed `.pfb/brief.md` of the repo that holds startDir: { path, ...fields, body }, or null when there is none.
 *  Outside a git repo (plain-folder mode) the brief is `<startDir>/.pfb/brief.md`.
 *  A malformed brief throws (with its path); it is never treated as missing. */
export function readBrief(startDir = process.cwd()) {
  const root = repoRoot(startDir) || path.resolve(startDir);
  const file = path.join(root, '.pfb', 'brief.md');
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return null; throw new Error(`${file}: ${e.message}`); }
  try {
    const { fields, body } = parseBrief(text);
    return { path: file, ...fields, body };
  } catch (e) { throw new Error(`${file}: ${e.message}`); }
}

/** Rewrite one list key of the brief's front matter, as one flow list, just before the closing `---`;
 *  the rest of the file is kept byte for byte. */
function writeBriefList(brief, key, list) {
  const text = fs.readFileSync(brief.path, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const flow = `${key}: [${list.map((v) => JSON.stringify(v)).join(', ')}]`;
  const keyRe = new RegExp(`^${key}:`);
  const end = lines.indexOf('---', 1);
  let out;
  if (lines[0] !== '---' || end < 0) {
    out = ['---', flow, '---', ...lines];
  } else {
    const keep = [];
    let inList = false;
    for (let i = 1; i < end; i += 1) {
      const l = lines[i];
      if (keyRe.test(l)) { inList = true; continue; }
      if (inList && /^\s+-/.test(l)) continue;
      inList = false;
      keep.push(l);
    }
    out = ['---', ...keep, flow, ...lines.slice(end)];
  }
  const tmp = `${brief.path}.tmp`;
  fs.writeFileSync(tmp, out.join(eol));
  fs.renameSync(tmp, brief.path);
}

/** Add hosts to the brief's `page_hosts` (handoff: remember a confirmed repo match).
 *  Rewrites only that key, as one flow list, just before the closing `---`; the rest of the file is kept byte for byte.
 *  Throws when there is no brief (the developer creates it first) or it is malformed. Returns { path, page_hosts, added }. */
export function addBriefHosts(startDir, hosts) {
  const brief = readBrief(startDir);
  if (!brief) throw new Error('no .pfb/brief.md in this repo; create the brief first');
  const old = Array.isArray(brief.page_hosts) ? brief.page_hosts : [];
  const merged = [...new Set([...old, ...hosts.map((h) => String(h).toLowerCase())])].sort();
  const added = merged.filter((h) => !old.includes(h));
  if (!added.length) return { path: brief.path, page_hosts: merged, added };
  writeBriefList(brief, 'page_hosts', merged);
  return { path: brief.path, page_hosts: merged, added };
}

/** A page URL without query and hash (the key of `page_files`), or null when it is not a URL. */
export function pageKey(url) {
  try {
    const u = new URL(String(url));
    u.search = ''; u.hash = '';
    return u.href;
  } catch { return null; }
}

/** `page_files` entries `"<url> -> <file>"` as [url, file] pairs; malformed entries are skipped. */
function pageFilePairs(brief) {
  const list = brief && Array.isArray(brief.page_files) ? brief.page_files : [];
  return list.map((e) => {
    const i = String(e).indexOf(' -> ');
    return i > 0 ? [pageKey(e.slice(0, i).trim()), e.slice(i + 4).trim()] : null;
  }).filter((p) => p && p[0] && p[1]);
}

/** The local file (relative to the repo dir) that the brief maps to this page URL, or null. */
export function pageFileFor(brief, pageUrl) {
  const key = pageKey(pageUrl);
  if (!key) return null;
  const hit = pageFilePairs(brief).find(([u]) => u === key);
  return hit ? hit[1] : null;
}

/** Remember that `file` (relative to the brief's folder) is the local source of the published page `pageUrl`.
 *  One file per page: a new file replaces the old mapping. The file must exist inside the folder.
 *  Throws when there is no brief or it is malformed. Returns { path, page_files, added }. */
export function addBriefPageFile(startDir, pageUrl, file) {
  const brief = readBrief(startDir);
  if (!brief) throw new Error('no .pfb/brief.md in this folder; create the brief first');
  const key = pageKey(pageUrl);
  if (!key || !/^https?:$/.test(new URL(key).protocol)) throw new Error(`page_url must be an http(s) URL (got ${pageUrl})`);
  const root = path.dirname(path.dirname(brief.path));
  const abs = path.resolve(root, String(file || ''));
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`${file} is outside ${root}`);
  let st;
  try { st = fs.statSync(abs); } catch { throw new Error(`${abs} does not exist`); }
  if (!st.isFile()) throw new Error(`${abs} is not a file`);
  const entry = `${key} -> ${rel.split(path.sep).join('/')}`;
  const old = Array.isArray(brief.page_files) ? brief.page_files : [];
  if (old.includes(entry)) return { path: brief.path, page_files: old, added: [] };
  const merged = [...old.filter((e) => { const i = String(e).indexOf(' -> '); return !(i > 0 && pageKey(e.slice(0, i).trim()) === key); }), entry];
  writeBriefList(brief, 'page_files', merged);
  return { path: brief.path, page_files: merged, added: [entry] };
}
