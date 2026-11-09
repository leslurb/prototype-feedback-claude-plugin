// server/repo-match.js
// Decide whether a batch belongs to the repo the session runs in, without asking the developer
// every time. Three signals, strongest first:
//   remote       — the export's repo / repo hints match this repo's `origin` remote
//   prior_commit — a commit Claude made for this session (prior_commits) exists in this repo
//   page_hosts   — every page host of the batch is listed in the brief's `page_hosts`
//                  (written by repo_remember after the developer confirmed a match once)
import { execFileSync } from 'node:child_process';

/** `host/owner/repo` in lower case for https, ssh and scp-style git URLs; null when unparseable. */
export function normRemote(url) {
  if (typeof url !== 'string' || !url.trim()) return null;
  const s = url.trim().replace(/\/+$/, '').replace(/\.git$/i, '');
  const scp = /^[\w.-]+@([\w.-]+):(.+)$/.exec(s);
  if (scp) return `${scp[1]}/${scp[2]}`.toLowerCase();
  try {
    const u = new URL(s);
    const p = u.pathname.replace(/^\/+/, '');
    return p ? `${u.hostname}/${p}`.toLowerCase() : null;
  } catch { return null; }
}

/** Sorted unique `host[:port]` of the comments' page URLs. */
export function pageHosts(comments) {
  const set = new Set();
  for (const c of comments || []) {
    try { if (c && c.page_url) set.add(new URL(c.page_url).host.toLowerCase()); } catch { /* not a URL */ }
  }
  return [...set].sort();
}

function git(dir, args) {
  try { return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim(); }
  catch { return null; }
}

export function originUrl(dir) { return git(dir, ['remote', 'get-url', 'origin']); }

/** Memoized per call site: one `git` run per sha per listing. */
export function makeCommitCheck(dir) {
  const memo = new Map();
  return (sha) => {
    if (typeof sha !== 'string' || !/^[0-9a-f]{7,40}$/i.test(sha)) return false;
    if (!memo.has(sha)) memo.set(sha, git(dir, ['cat-file', '-e', `${sha}^{commit}`]) !== null);
    return memo.get(sha);
  };
}

/** { match, by: 'remote'|'prior_commit'|'page_hosts'|null, remote } for one batch. */
export function repoMatch({ remote, repoUrls = [], priorShas = [], hosts = [], briefHosts = [], hasCommit = () => false }) {
  const r = normRemote(remote);
  if (r && repoUrls.some((u) => normRemote(u) === r)) return { match: true, by: 'remote', remote: r };
  if (priorShas.some((s) => hasCommit(s))) return { match: true, by: 'prior_commit', remote: r };
  const known = new Set((briefHosts || []).map((h) => String(h).toLowerCase()));
  if (hosts.length && hosts.every((h) => known.has(h))) return { match: true, by: 'page_hosts', remote: r };
  return { match: false, by: null, remote: r };
}
