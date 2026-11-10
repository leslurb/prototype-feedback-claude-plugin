// test/mcp.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeZip } from './helpers/makezip.mjs';

const SERVER = fileURLToPath(new URL('../server/mcp.js', import.meta.url));

function rpc(child) {
  let buf = ''; const waiting = new Map(); let next = 1;
  child.stdout.on('data', (d) => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      waiting.get(msg.id)?.(msg); waiting.delete(msg.id);
    }
  });
  return (method, params) => new Promise((resolve) => {
    const id = next++; waiting.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

test('initialize, list tools, open a batch and set status over stdio', async () => {
  const dl = fs.mkdtempSync(path.join(os.tmpdir(), 'pfb-mcp-'));
  fs.mkdirSync(path.join(dl, 'prototype-feedback', 'inbox'), { recursive: true });
  fs.writeFileSync(path.join(dl, 'prototype-feedback', 'inbox', 's.zip'), makeZip({ 'feedback.json': JSON.stringify({
    schema: 'prototype-feedback/v6', export_id: 'e1', comments: [{ id: 'c1', verb: 'fix', comment: 'x', page_url: 'https://a.dev/' }] }) }));
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, PFB_DOWNLOADS: dl, PFB_PORT: '0' } });
  const call = rpc(child);
  try {
    const init = await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    assert.equal(init.result.serverInfo.name, 'pfb');
    assert.equal(init.result.protocolVersion, '2025-06-18');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const tools = await call('tools/list', {});
    assert.deepEqual(tools.result.tools.map((t) => t.name).sort(), ['batch_open', 'batch_preview', 'comment_get', 'inbox_list', 'page_file_remember', 'page_shot', 'repo_remember', 'status_set']);
    const list = JSON.parse((await call('tools/call', { name: 'inbox_list', arguments: {} })).result.content[0].text);
    assert.equal(list.batches[0].id, 'e1');
    // page_shot answers through a promise: its error must still come back as a tool error.
    const shot = await call('tools/call', { name: 'page_shot', arguments: { batch_id: 'e1', comment_id: 'c1' } });
    assert.equal(shot.result.isError, true);
    assert.match(shot.result.content[0].text, /not open; call batch_open first/);
    const opened = JSON.parse((await call('tools/call', { name: 'batch_open', arguments: { id: 'e1' } })).result.content[0].text);
    assert.equal(opened.comments[0].id, 'c1');
    assert.ok(fs.existsSync(path.join(opened.dir, 'feedback.json')));
    const set = await call('tools/call', { name: 'status_set', arguments: { batch_id: 'e1', comment_id: 'c1', status: 'fixed', commit_sha: 'abc', summary: 'done' } });
    assert.ok(!set.result.isError);
    const rj = JSON.parse(fs.readFileSync(path.join(opened.dir, 'responses.json'), 'utf8'));
    assert.deepEqual(rj.responses.map((r) => [r.comment_id, r.status]), [['c1', 'fixed']]);
    const bad = await call('tools/call', { name: 'status_set', arguments: { batch_id: 'e1', comment_id: 'c1', status: 'nope' } });
    assert.equal(bad.result.isError, true);
    const unknown = await call('nope/method', {});
    assert.equal(unknown.error.code, -32601);
  } finally { child.kill(); }
});

test('survives malformed input and rejects bad batch ids', async () => {
  const dl = fs.mkdtempSync(path.join(os.tmpdir(), 'pfb-mcp-'));
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, PFB_DOWNLOADS: dl, PFB_PORT: '0' } });
  const lines = []; let buf = '';
  child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  const until = async (n) => { for (let k = 0; k < 200 && lines.length < n; k++) await new Promise((r) => setTimeout(r, 25)); };
  try {
    for (const l of ['null', '[]', '{"jsonrpc":"2.0","id":null,"method":"ping"}', '{oops',
      '{"jsonrpc":"2.0","id":0,"method":"ping"}', '{"jsonrpc":"2.0","id":"s1","method":"ping"}']) child.stdin.write(l + '\n');
    await until(6);
    assert.deepEqual(lines.slice(0, 3).map((m) => m.error.code), [-32600, -32600, -32600]);
    assert.equal(lines[3].error.code, -32700);
    assert.deepEqual(lines[4], { jsonrpc: '2.0', id: 0, result: {} });
    assert.deepEqual(lines[5], { jsonrpc: '2.0', id: 's1', result: {} });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'status_set', arguments: { batch_id: '../x', comment_id: 'c', status: 'fixed' } } }) + '\n');
    await until(7);
    assert.equal(lines[6].result.isError, true);
    assert.match(lines[6].result.content[0].text, /invalid batch id/);
  } finally { child.kill(); }
});
