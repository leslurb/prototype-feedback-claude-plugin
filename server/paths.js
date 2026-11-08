import os from 'node:os';
import path from 'node:path';

/** The user's Downloads folder; PFB_DOWNLOADS overrides it (custom Chrome download dir, tests). */
export function downloadsDir(env = process.env) {
  if (env.PFB_DOWNLOADS) return path.resolve(env.PFB_DOWNLOADS);
  return path.join(os.homedir(), 'Downloads');
}

export function layout(downloads = downloadsDir()) {
  const d = path.resolve(downloads);
  const root = path.join(d, 'prototype-feedback');
  return {
    downloads: d,
    root,
    inbox: path.join(root, 'inbox'),
    batches: path.join(root, 'batches'),
    archive: path.join(root, 'archive'),
    statusFile: path.join(root, 'status.json'),
  };
}
