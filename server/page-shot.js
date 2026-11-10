// server/page-shot.js
// Screenshot a local HTML file in headless Chrome (or Edge), so Claude can check its own fix.
// Zero dependencies: Chrome's --screenshot flag. The page is a temporary copy next to the original
// (relative assets still load) with a small script that restores the comment's in-page view
// (clicks the tab controls in order) and outlines the target element.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const TIMEOUT_MS = 30000;

/** The first Chrome or Edge executable that exists. Throws when there is none. */
export function findChrome(env = process.env, platform = process.platform, exists = fs.existsSync) {
  const cands = [];
  if (env.CHROME_PATH) cands.push(env.CHROME_PATH);
  if (platform === 'win32') {
    const j = path.win32.join;
    const pf = env.ProgramFiles, pf86 = env['ProgramFiles(x86)'], la = env.LOCALAPPDATA;
    if (pf) cands.push(j(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    if (pf86) cands.push(j(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    if (la) cands.push(j(la, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    if (pf86) cands.push(j(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    if (pf) cands.push(j(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  } else if (platform === 'darwin') {
    cands.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
  } else {
    const dirs = String(env.PATH || '').split(':').filter(Boolean);
    for (const n of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) for (const d of dirs) cands.push(path.posix.join(d, n));
  }
  const hit = cands.find((c) => { try { return exists(c); } catch { return false; } });
  if (!hit) throw new Error('page_shot needs Chrome or Edge; set CHROME_PATH');
  return hit;
}

/** JSON for inside a <script>: `<` escaped so no `</script>` in a selector can close it. */
const scriptJson = (v) => JSON.stringify(v).replace(/</g, '\\u003c');

/** The original HTML with one script before the last </body> (or appended): after load, click each selector
 *  in order with 300 ms between, then scroll the target to the centre and outline it. */
export function shotHtml(originalHtml, { clicks = [], target = null } = {}) {
  const script = '<script data-pfb-shot>(() => {'
    + ` const clicks = ${scriptJson(clicks || [])}; const target = ${scriptJson(target || null)};`
    + ' const wait = (ms) => new Promise((r) => setTimeout(r, ms));'
    + ' const run = async () => {'
    + ' for (const s of clicks) { try { const el = document.querySelector(s); if (el) el.click(); } catch (_) { /* bad selector */ } await wait(300); }'
    + ' if (target) { try { const el = document.querySelector(target);'
    + " if (el) { el.scrollIntoView({ block: 'center' }); el.style.outline = '3px solid #f97316'; el.style.outlineOffset = '2px'; } } catch (_) { /* bad selector */ } }"
    + ' };'
    + " if (document.readyState === 'complete') run(); else addEventListener('load', run);"
    + ' })();</script>';
  const html = String(originalHtml);
  const i = html.toLowerCase().lastIndexOf('</body>');
  return i < 0 ? html + script : html.slice(0, i) + script + html.slice(i);
}

function defaultRun(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: TIMEOUT_MS, windowsHide: true }, (err, _out, stderr) => {
      if (err) reject(new Error(`${path.basename(cmd)} failed: ${err.killed ? `timed out after ${TIMEOUT_MS / 1000} s` : err.message}${stderr ? `\n${String(stderr).slice(0, 500)}` : ''}`));
      else resolve();
    });
  });
}

/** Screenshot `file` (1280x900) into `out` after restoring the view. Returns `out`.
 *  Throws when Chrome fails or writes no screenshot. The copy and the throwaway profile are always removed. */
export async function pageShot({ file, clicks = [], target = null, out, chrome = findChrome(), run = defaultRun }) {
  const src = path.resolve(file);
  let html;
  try { html = fs.readFileSync(src, 'utf8'); } catch (e) { throw new Error(`cannot read ${src}: ${e.message}`); }
  const copy = path.join(path.dirname(src), `.pfb-shot-${crypto.randomBytes(6).toString('hex')}.html`);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pfb-chrome-'));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.rmSync(out, { force: true });
  try {
    fs.writeFileSync(copy, shotHtml(html, { clicks, target }));
    await run(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--window-size=1280,900',
      '--virtual-time-budget=4000', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
      `--screenshot=${out}`, pathToFileURL(copy).href]);
  } finally {
    try { fs.rmSync(copy, { force: true }); } catch { /* best effort */ }
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* Chrome may still hold a file */ }
  }
  let size = 0;
  try { size = fs.statSync(out).size; } catch { /* not written */ }
  if (!size) throw new Error(`Chrome wrote no screenshot to ${out}`);
  return out;
}
