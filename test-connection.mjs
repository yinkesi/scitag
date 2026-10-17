import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRelay } from './supabase/functions/_shared/relay.mjs';
import { startGateway } from './connect.mjs';
import http from 'node:http';
import { spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('relay preserves authentication, path and errors without exposing a general URL proxy', async () => {
  let calls = 0;
  const relay = createRelay({ fetcher: async (url, init) => {
    calls++;
    assert.equal(url, 'https://scitag-yinkesi1.vercel.app/api/state?x=1');
    assert.equal(init.headers.get('authorization'), 'Bearer recipient-token');
    assert.equal(init.headers.get('cookie'), null);
    assert.equal(init.redirect, 'error');
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  } });
  const result = await relay(new Request('https://example.com/functions/v1/scitag-relay/api/state?x=1', { headers: { authorization: 'Bearer recipient-token', cookie: 'secret' } }));
  assert.equal(result.status, 401);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  for (const path of ['/https://evil.example', '/data/private.json', '/api/%2Fexternal']) {
    assert.equal((await relay(new Request('https://example.com/scitag-relay' + path))).status, 404);
  }
  assert.equal(calls, 1);
});

test('relay caps request bodies before forwarding and fails closed on network errors', async () => {
  let called = false;
  const relay = createRelay({ fetcher: async () => { called = true; throw new Error('private upstream error'); } });
  const huge = await relay(new Request('https://example.com/scitag-relay/api/register', { method: 'POST', body: 'a'.repeat(256001) }));
  assert.equal(huge.status, 413);
  assert.equal(called, false);
  const unavailable = await relay(new Request('https://example.com/scitag-relay/api/health'));
  assert.equal(unavailable.status, 502);
  assert.ok(!(await unavailable.text()).includes('private upstream error'));
});

test('local gateway preserves relay prefixes, rewrites downloaded config and rejects cross-site access', async t => {
  const base = 'https://example.com/functions/v1/scitag-relay';
  let calls = 0;
  const gateway = await startGateway(base, { fetcher: async (url, options) => {
    calls++;
    assert.equal(options.redirect, 'error');
    assert.equal(url, base + '/api/config');
    return Response.json({ ready: true, production: true }, { headers: { 'content-security-policy': "default-src 'none'; sandbox" } });
  } });
  t.after(() => { gateway.server.closeAllConnections(); gateway.server.close(); });
  const response = await fetch(gateway.url + '/api/config');
  assert.match(response.headers.get('content-security-policy'), /connect-src 'self'/);
  assert.ok(!response.headers.get('content-security-policy').includes('; sandbox'));
  const config = await response.json();
  assert.equal(config.workerServer, base);
  assert.equal(config.ready, true);
  assert.equal((await fetch(gateway.url + '/api/config', { headers: { origin: 'https://attacker.example' } })).status, 403);
  assert.equal((await fetch(gateway.url + '/api/config', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await fetch(gateway.url + '/data/private.json')).status, 404);
  const status = await new Promise((resolve, reject) => {
    http.get(gateway.url + '/api/config', { headers: { host: 'attacker.example' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
  });
  assert.equal(status, 403);
  assert.equal(calls, 1);
});

test('a malformed request target returns 400 without crashing the local gateway', () => {
  const script = `import {startGateway} from './connect.mjs'; import http from 'node:http';
    const gateway=await startGateway('https://example.com');
    http.get({hostname:'127.0.0.1',port:gateway.server.address().port,path:'http://['}, response=>{
      console.log(response.statusCode);response.resume();response.on('end',()=>{gateway.server.closeAllConnections();gateway.server.close();});
    }).on('error',()=>{process.exitCode=2;gateway.server.close();});`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), '400');
});

test('standalone connection check returns a failing exit status when the service is not ready', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scitag-diagnostic-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const name of ['connect.mjs', 'worker.mjs', 'worker-executors.mjs']) fs.copyFileSync(new URL(name, import.meta.url), path.join(directory, name));
  const server = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end('{"ready":false}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  fs.writeFileSync(path.join(directory, 'connection.json'), JSON.stringify({ server: `http://127.0.0.1:${server.address().port}` }));
  await assert.rejects(promisify(execFile)(process.execPath, [path.join(directory, 'connect.mjs'), '--check'], { timeout: 10000, windowsHide: true }), error => error.code === 1 && error.stdout.includes('尚未就绪'));
});

test('oversized local requests are rejected before reaching the remote gateway', async t => {
  let calls = 0;
  const gateway = await startGateway('https://example.com', { fetcher: async () => { calls++; return Response.json({}); } });
  t.after(() => { gateway.server.closeAllConnections(); gateway.server.close(); });
  const response = await fetch(gateway.url + '/api/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(256001) });
  assert.equal(response.status, 413);
  assert.equal(calls, 0);
});
