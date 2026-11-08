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

const ID_RE = /^[A-Za-z0-9][\w.-]*$/;
function checkId(id) { if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error(`invalid batch id ${id}`); }

export function callTool(L, name, args = {}) {
  if (name === 'inbox_list') return { root: L.root, batches: listBatches(L) };
  if (name === 'batch_open') {
    checkId(args.id);
    const b = openBatch(L, args.id);
    return { id: b.id, dir: b.dir, version: b.version, exportedAt: b.exportedAt, reviewer: b.reviewer, repoUrls: b.repoUrls,
             version_hints: b.raw.version_hints || null, comments: b.comments, status: readStatus(L.statusFile).batches[b.id]?.comments || {} };
  }
  if (name === 'status_set') {
    checkId(args.batch_id);
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
