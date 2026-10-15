import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeLocal } from './worker-executors.mjs';
import { runWorker } from './worker.mjs';
import http from 'node:http';

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
