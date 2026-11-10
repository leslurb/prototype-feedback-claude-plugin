// test/page-shot.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome, shotHtml, pageShot } from '../server/page-shot.js';
import { layout } from '../server/paths.js';
import { callTool } from '../server/tools.js';
import { makeZip } from './helpers/makezip.mjs';

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test('findChrome takes CHROME_PATH first, then the platform paths in order, else throws', () => {
  const has = (...ok) => (p) => ok.includes(p);
  assert.equal(findChrome({ CHROME_PATH: '/x/chrome' }, 'linux', has('/x/chrome', '/usr/bin/google-chrome')), '/x/chrome');
  const winEnv = { ProgramFiles: 'C:\\PF', 'ProgramFiles(x86)': 'C:\\PF86', LOCALAPPDATA: 'C:\\LA' };
  const pf86 = path.win32.join('C:\\PF86', 'Google', 'Chrome', 'Application', 'chrome.exe');
  const la = path.win32.join('C:\\LA', 'Google', 'Chrome', 'Application', 'chrome.exe');
  const edge = path.win32.join('C:\\PF86', 'Microsoft', 'Edge', 'Application', 'msedge.exe');
  assert.equal(findChrome(winEnv, 'win32', has(la, pf86)), pf86, 'Program Files (x86) before LOCALAPPDATA');
  assert.equal(findChrome(winEnv, 'win32', has(edge)), edge, 'Edge as the last resort');
  assert.equal(findChrome({}, 'darwin', has('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')), '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  assert.equal(findChrome({ PATH: '/a:/usr/bin' }, 'linux', has('/usr/bin/chromium')), '/usr/bin/chromium', 'linux searches PATH');
  assert.throws(() => findChrome({ PATH: '/a' }, 'linux', () => false), /page_shot needs Chrome or Edge; set CHROME_PATH/);
  assert.throws(() => findChrome({ CHROME_PATH: '/missing' }, 'win32', () => false), /CHROME_PATH/);
});

test('shotHtml inserts one script before </body> that clicks, waits, scrolls and outlines; the rest is unchanged', () => {
  const html = '<html><body><p>a</p></body></html>';
  const clicks = ['#tab-b', '[data-x="</script>"]'];
  const out = shotHtml(html, { clicks, target: '#price' });
  const i = out.indexOf('<script data-pfb-shot>');
  assert.ok(i > 0, 'script inserted');
  assert.equal(out.slice(0, i) + out.slice(out.indexOf('</script>', i) + '</script>'.length), html, 'original HTML otherwise unchanged');
  assert.ok(out.indexOf('</script>', i) < out.lastIndexOf('</body>'), 'before </body>');
  const script = out.slice(i, out.indexOf('</script>', i));
  assert.ok(script.includes(JSON.stringify(clicks).replace(/</g, '\\u003c')), 'JSON-encoded selectors, < escaped');
  assert.ok(!script.slice(1).includes('</'), 'nothing can close the script early');
  assert.ok(script.includes(JSON.stringify('#price')));
  for (const s of ['.click()', '300', 'scrollIntoView', "block: 'center'", '3px solid #f97316']) assert.ok(script.includes(s), s);
  const noBody = shotHtml('<p>x</p>', { clicks: [], target: null });
  assert.ok(noBody.startsWith('<p>x</p><script data-pfb-shot>'), 'appended when there is no </body>');
  assert.ok(noBody.includes('null'), 'no target');
});

function folder() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pfb-ps-'));
  fs.writeFileSync(path.join(dir, 'proto.html'), '<html><body><p>x</p></body></html>');
  return dir;
}

test('pageShot runs headless Chrome on a copy next to the file, then deletes the copy', async () => {
  const dir = folder();
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pfb-pso-')), 'after', 'c1.png');
  const calls = [];
  let copySeen;
  const run = async (cmd, args) => {
    calls.push({ cmd, args });
    const url = args[args.length - 1];
    copySeen = fileURLToPath(url);
    assert.ok(fs.readFileSync(copySeen, 'utf8').includes('"#tab-b"'), 'copy holds the click script');
    fs.writeFileSync(args.find((a) => a.startsWith('--screenshot=')).slice('--screenshot='.length), PNG_SIG);
  };
  const r = await pageShot({ file: path.join(dir, 'proto.html'), clicks: ['#tab-b'], target: '#p', out, chrome: '/c/chrome', run });
  assert.equal(r, out);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, '/c/chrome');
  for (const a of ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--window-size=1280,900', '--virtual-time-budget=4000', `--screenshot=${out}`]) {
    assert.ok(calls[0].args.includes(a), a);
  }
  assert.ok(calls[0].args.some((a) => a.startsWith('--user-data-dir=')), 'a throwaway profile, never the user profile');
  assert.equal(path.dirname(copySeen), dir, 'copy in the same folder so relative assets load');
  assert.match(path.basename(copySeen), /^\.pfb-shot-[\w-]+\.html$/);
  assert.equal(fs.existsSync(copySeen), false, 'copy deleted');
  assert.deepEqual(fs.readdirSync(dir), ['proto.html']);
  assert.deepEqual(fs.readFileSync(out), PNG_SIG);
});

test('pageShot throws when Chrome wrote no screenshot or failed, and still deletes the copy', async () => {
  const dir = folder();
  const out = path.join(dir, 'out', 'c1.png');
  await assert.rejects(pageShot({ file: path.join(dir, 'proto.html'), clicks: [], target: null, out, chrome: 'x', run: async () => {} }), /no screenshot/);
  await assert.rejects(pageShot({ file: path.join(dir, 'proto.html'), clicks: [], target: null, out, chrome: 'x', run: async () => { throw new Error('spawn x ENOENT'); } }), /ENOENT/);
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.startsWith('.pfb-shot-')), []);
  await assert.rejects(pageShot({ file: path.join(dir, 'missing.html'), clicks: [], target: null, out, chrome: 'x', run: async () => {} }), /missing\.html/);
});

let chrome = null;
try { chrome = findChrome(); } catch { /* no Chrome on this machine */ }
test('pageShot with real headless Chrome screenshots the second tab of a 2-tab page', { skip: chrome ? false : 'no Chrome or Edge found (set CHROME_PATH)', timeout: 60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pfb-psr-'));
  fs.writeFileSync(path.join(dir, 'tabs.html'), `<!doctype html><html><body>
<button id="ta" onclick="show('a')">A</button><button id="tb" onclick="show('b')">B</button>
<section id="a">Tab A</section><section id="b" hidden><p id="target">Tab B</p></section>
<script>function show(t){document.getElementById('a').hidden=t!=='a';document.getElementById('b').hidden=t!=='b';}</script>
</body></html>`);
  const out = path.join(dir, 'after', 'c1.png');
  await pageShot({ file: path.join(dir, 'tabs.html'), clicks: ['#tb'], target: '#target', out, chrome });
  const png = fs.readFileSync(out);
  assert.deepEqual(png.subarray(0, 8), PNG_SIG);
  assert.ok(png.length > 1000);
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.startsWith('.pfb-shot-')), [], 'copy deleted');
});

function openBatchFixture(comment) {
  const L = layout(fs.mkdtempSync(path.join(os.tmpdir(), 'pfb-pst-')));
  fs.mkdirSync(L.inbox, { recursive: true });
  const json = { schema: 'prototype-feedback/v6', export_id: 'S1', exported_at: '2026-11-09T15:00:00Z', comments: [comment] };
  fs.writeFileSync(path.join(L.inbox, 's.zip'), makeZip({ 'feedback.json': JSON.stringify(json) }));
  return L;
}
const fakeRun = (seen) => async (cmd, args) => {
  seen.push({ args, html: fs.readFileSync(fileURLToPath(args[args.length - 1]), 'utf8') });
  fs.writeFileSync(args.find((a) => a.startsWith('--screenshot=')).slice('--screenshot='.length), PNG_SIG);
};

test('page_shot tool: file from page_files, clicks from view, target from selector or anchor, out in <batch>/after/', async () => {
  const repo = folder();
  fs.mkdirSync(path.join(repo, '.pfb'));
  fs.writeFileSync(path.join(repo, '.pfb', 'brief.md'), '---\npage_files: ["https://h.test/1234 -> proto.html"]\n---\n');
  const L = openBatchFixture({ id: 'c1', verb: 'fix', comment: 'x', page_url: 'https://h.test/1234?t=2',
    view: { label: 'Pricing', clicks: ['#tab-pricing'] }, selector: null, anchor: { selector: '#plans', dx: 4, dy: 8 } });
  const seen = [];
  await assert.rejects(callTool(L, 'page_shot', { batch_id: 'S1', comment_id: 'c1', repo_dir: repo }, { chrome: 'x', run: fakeRun(seen) }), /not open; call batch_open first/);
  callTool(L, 'batch_open', { id: 'S1', repo_dir: repo });
  const r = await callTool(L, 'page_shot', { batch_id: 'S1', comment_id: 'c1', repo_dir: repo }, { chrome: 'x', run: fakeRun(seen) });
  assert.deepEqual(r, { after_shot: 'after/c1.png', path: path.join(L.batches, 'S1', 'after', 'c1.png') });
  assert.deepEqual(fs.readFileSync(r.path), PNG_SIG);
  assert.ok(seen[0].html.includes('["#tab-pricing"]'), 'clicks from comment.view');
  assert.ok(seen[0].html.includes('"#plans"'), 'target from comment.anchor when there is no selector');
  await assert.rejects(callTool(L, 'page_shot', { batch_id: 'S1', comment_id: 'nope', repo_dir: repo }, { chrome: 'x', run: fakeRun(seen) }), /unknown comment nope/);
});

test('page_shot tool: an explicit file wins; no file and no page_files entry asks for page_file_remember', async () => {
  const repo = folder();
  const L = openBatchFixture({ id: 'c1', verb: 'fix', comment: 'x', page_url: 'https://h.test/9', selector: '#p' });
  callTool(L, 'batch_open', { id: 'S1', repo_dir: repo });
  const seen = [];
  await assert.rejects(callTool(L, 'page_shot', { batch_id: 'S1', comment_id: 'c1', repo_dir: repo }, { chrome: 'x', run: fakeRun(seen) }),
    /Tell me which local file shows https:\/\/h\.test\/9 \(page_file_remember\)/);
  await assert.rejects(callTool(L, 'page_shot', { batch_id: 'S1', comment_id: 'c1', repo_dir: repo, file: '../x.html' }, { chrome: 'x', run: fakeRun(seen) }), /outside/);
  const r = await callTool(L, 'page_shot', { batch_id: 'S1', comment_id: 'c1', repo_dir: repo, file: 'proto.html' }, { chrome: 'x', run: fakeRun(seen) });
  assert.equal(r.after_shot, 'after/c1.png');
  assert.equal(seen.length, 1);
  assert.ok(seen[0].html.includes('const clicks = []') && seen[0].html.includes('"#p"'), 'no view -> no clicks; target from selector');
});
