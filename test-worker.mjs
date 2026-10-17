import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeLocal, executorCommand } from './worker-executors.mjs';
import { runWorker, configureWorkerNetwork } from './worker.mjs';
import http from 'node:http';
import net from 'node:net';

test('first stale completion is archived immediately, including --once', async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'scitag-stale-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const job = { id: 'r_' + 'b'.repeat(24), prompt: 'work', leaseToken: 'lease', leaseMs: 90000 };
  const logs = [];
  const server = http.createServer(async (req, res) => {
    for await (const data of req) {}
    res.setHeader('content-type', 'application/json');
    if (req.url.endsWith('/claim')) res.end(JSON.stringify({ job }));
    else { res.statusCode = 409; res.end('{"error":"stale lease"}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const config = { server: `http://127.0.0.1:${server.address().port}`, token: 'token', executor: 'command', workspace, stateDirectory: path.join(workspace, 'state') };
  await runWorker(config, { once: true, log: line => logs.push(line), execute: async () => ({ text: 'saved result', failed: false }) });
  assert.equal(fs.existsSync(path.join(config.stateDirectory, 'pending.json')), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(config.stateDirectory, job.id + '.stale.json'))).result.text, 'saved result');
  assert.ok(logs.some(line => line.includes('旧租约')));
  assert.ok(!logs.some(line => line.includes('暂时无法通信')));
});

test('invalid lease durations cannot execute local tools', async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'scitag-lease-format-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  let leaseMs, executions = 0;
  const server = http.createServer(async (req, res) => {
    for await (const data of req) {}
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ job: { id: 'r_' + 'c'.repeat(24), prompt: 'work', leaseToken: 'lease', leaseMs } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  for (leaseMs of [undefined, null, '90000', -1, 0, 20000, 90000.5, 1e12]) {
    await assert.rejects(runWorker({ server: `http://127.0.0.1:${server.address().port}`, token: 't', workspace, executor: 'command', stateDirectory: path.join(workspace, 'state') },
      { once: true, log() {}, execute: async () => { executions++; return { text: 'bad' }; } }), /租约|作业格式/);
  }
  assert.equal(executions, 0);
});

test('DeepSeek requires explicit acknowledgement of local profile permissions', () => {
  assert.throws(() => executorCommand({ executor: 'deepseek' }, 'answer.md'), /trustLocalPermissions/);
});

test('invalid local executor configuration is rejected before claiming any task', async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'scitag-preflight-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  let claims = 0;
  const server = http.createServer((req, res) => { claims++; res.end('{"job":null}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  await assert.rejects(runWorker({ server: `http://127.0.0.1:${server.address().port}`, token: 't', executor: 'not-installed', workspace,
    stateDirectory: path.join(workspace, 'state') }, { once: true, log() {} }), /executor/);
  assert.equal(claims, 0);
});

test('worker keeps the configured relay prefix on all job requests', async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'scitag-prefix-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const paths = [];
  const job = { id: 'r_' + 'd'.repeat(24), prompt: 'work', leaseToken: 'lease', leaseMs: 90000 };
  const server = http.createServer(async (req, res) => {
    for await (const data of req) {}
    paths.push(req.url); res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url.endsWith('/claim') ? { job } : { ok: true }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  await runWorker({ server: `http://127.0.0.1:${server.address().port}/functions/v1/scitag-relay`, token: 't', executor: 'command', workspace,
    stateDirectory: path.join(workspace, 'state') }, { once: true, log() {}, execute: async () => ({ text: 'ok', failed: false }) });
  assert.deepEqual(paths, ['/functions/v1/scitag-relay/api/worker/jobs/claim', `/functions/v1/scitag-relay/api/worker/jobs/${job.id}/complete`]);
});

test('worker uses a configured proxy and bypasses it for loopback', { skip: typeof http.setGlobalProxyFromEnv !== 'function' }, async t => {
  let proxied = 0;
  const proxy = http.createServer((req, res) => { proxied++; res.end('proxied'); });
  const direct = http.createServer((req, res) => res.end(req.headers.host.includes('scitag-proxy-test') ? 'proxied' : 'direct'));
  const sockets = new Set();
  proxy.on('connect', (req, socket, head) => {
    proxied++;
    const upstream = net.connect(direct.address().port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      socket.pipe(upstream); upstream.pipe(socket);
    });
    for (const stream of [socket, upstream]) { sockets.add(stream); stream.on('error', () => {}); stream.on('close', () => sockets.delete(stream)); }
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  await new Promise(resolve => direct.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const socket of sockets) socket.destroy(); proxy.closeAllConnections(); proxy.close(); direct.closeAllConnections(); direct.close(); });
  const restore = configureWorkerNetwork({ HTTP_PROXY: `http://127.0.0.1:${proxy.address().port}` });
  try {
    assert.equal(await (await fetch('http://scitag-proxy-test.invalid', { signal: AbortSignal.timeout(3000) })).text(), 'proxied');
    assert.equal(await (await fetch(`http://127.0.0.1:${direct.address().port}`, { signal: AbortSignal.timeout(3000) })).text(), 'direct');
    assert.equal(proxied, 1);
  } finally { restore?.(); }
});

test('executor sends prompt through stdin, uses configured workspace and respects exit code', async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'scitag-exec-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const command = [process.execPath, '-e', 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>console.log(process.cwd()+"|"+s))'];
  const result = await executeLocal({ executor: 'command', command, workspace }, { id: 'test', prompt: 'hello $(unsafe) `x`' }, workspace);
  assert.equal(result.failed, false);
  assert.equal(result.text.trim(), workspace + '|hello $(unsafe) `x`');
  const bad = await executeLocal({ executor: 'command', workspace, command: [process.execPath, '-e', 'console.log("partial");process.exit(7)'] }, { id: 'bad', prompt: 'x' }, workspace);
  assert.equal(bad.failed, true);
  assert.match(bad.text, /7/);
});

test('executor can be cancelled without reporting partial output as success', async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'scitag-cancel-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const controller = new AbortController();
  const running = executeLocal({ executor: 'command', workspace, command: [process.execPath, '-e', 'console.log("partial");setTimeout(()=>{},30000)'] },
    { id: 'cancel', prompt: 'x' }, workspace, controller.signal);
  setTimeout(() => controller.abort(), 150);
  assert.equal((await running).failed, true);
});

test('restart resends persisted result after response loss without executing the Agent twice', async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'scitag-resend-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  let claimed = false, submissions = 0, executions = 0;
  const server = http.createServer(async (req, res) => {
    for await (const data of req) {} // Drain request body.
    if (req.url.endsWith('/claim')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ job: claimed ? null : { id: 'r_' + 'a'.repeat(24), prompt: 'work', leaseToken: 'lease', leaseMs: 90000 } }));
      claimed = true;
    } else if (submissions++ === 0) req.socket.destroy();
    else { res.setHeader('content-type', 'application/json'); res.end('{"ok":true,"duplicate":true}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const config = { server: `http://127.0.0.1:${server.address().port}`, token: 'agent-token', executor: 'command', workspace, stateDirectory: path.join(workspace, 'state') };
  const options = { once: true, log() {}, execute: async () => { executions++; return { text: 'saved-report', failed: false }; } };
  await assert.rejects(runWorker({ ...config }, options));
  assert.equal(fs.existsSync(path.join(config.stateDirectory, 'pending.json')), true);
  await runWorker({ ...config }, options);
  assert.equal(executions, 1);
  assert.equal(submissions, 2);
  assert.equal(fs.existsSync(path.join(config.stateDirectory, 'pending.json')), false);
});
