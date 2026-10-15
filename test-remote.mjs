import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runWorker } from './worker.mjs';
import { makeCloudStore } from './cloud-store.mjs';

process.env.SCITAG_SERVERLESS = '1';
process.env.SCITAG_ADMIN_TOKEN = crypto.randomBytes(32).toString('hex');
const { handleCloud: first } = await import('./server.js?test-instance-a');
const { handleCloud: second } = await import('./server.js?test-instance-b');
let revision = 0, state = null, instance = 0;
const fetcher = async (url, options) => {
  const body = JSON.parse(options.body);
  if (url.endsWith('scitag_read')) return Response.json({ revision, state });
  if (revision !== body.p_revision) return Response.json(false);
  state = structuredClone(body.p_state); revision++;
  return Response.json(true);
};
const backend = makeCloudStore({ url: 'https://test.supabase.co', key: 'test-key', secret: 'test-secret', fetcher });
async function api(route, token, body, method = body ? 'POST' : 'GET') {
  const response = await (instance++ % 2 ? first : second)(new Request('https://scitag.test' + route, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }), backend);
  return { status: response.status, ...await response.json() };
}

test('two server instances and real local subprocess complete collaboration, review, retry and discussion', async t => {
  const admin = process.env.SCITAG_ADMIN_TOKEN;
  assert.equal((await api('/api/config')).production, true);
  const unconfigured = await first(new Request('https://scitag.test/api/config'));
  assert.equal((await unconfigured.json()).ready, false);
  const options = await first(new Request('https://scitag.test/api/worker/jobs/claim', { method: 'OPTIONS' }), backend);
  assert.equal(options.status, 204);
  assert.equal((await api('/api/agents')).status, 401);
  assert.equal((await api('/api/register', null, { name: 'intruder' })).status, 403);
  assert.equal((await api('/api/register', null, { name: '教授', token: 'demo-jiaoshou' })).status, 403);
  const owner = await api('/api/register', admin, { name: '研究者' });
  const a = await api('/api/register', owner.token, { kind: 'agent', name: 'agent-a', owner: '研究者', domains: ['bone-scaffold'] });
  const b = await api('/api/register', owner.token, { kind: 'agent', name: 'agent-b', owner: '研究者' });
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  assert.equal((await api('/api/register', a.token, { kind: 'agent', name: 'bad', owner: '研究者' })).status, 403);
  const created = await api('/api/missions', admin, { title: '异地协作验收', channel: 'lab', brief: '两个本地执行器接力' });
  assert.equal(created.status, 200);
  const mission = created.mission;
  const task = (await api(`/api/missions/${mission.id}/tasks`, admin, { assignee: 'agent-a', title: '读取本机文件', brief: '汇总 sample.txt', skills: ['scaffold-explain'] })).task;
  const claims = await Promise.all([api('/api/worker/jobs/claim', a.token, { workerId: 'computer-a' }), api('/api/worker/jobs/claim', a.token, { workerId: 'computer-b' })]);
  assert.equal(claims.filter(r => r.job).length, 1);
  const job = claims.find(r => r.job).job;
  assert.match(job.prompt, /scaffold-explain/);
  assert.equal((await api(`/api/worker/jobs/${job.id}/complete`, b.token, { leaseToken: job.leaseToken, text: 'intrusion' })).status, 404);
  assert.equal((await api(`/api/tasks/${task.id}/report`, a.token, { text: 'bypass' })).status, 409);
  const result = { leaseToken: job.leaseToken, text: '第一轮成果' };
  assert.equal((await api(`/api/worker/jobs/${job.id}/complete`, a.token, result)).status, 200);
  assert.equal((await api(`/api/worker/jobs/${job.id}/complete`, a.token, result)).duplicate, true);
  assert.equal((await api(`/api/tasks/${task.id}`, admin)).task.report, undefined);
  await api(`/api/tasks/${task.id}/review`, owner.token, { decision: 'reject', comment: '请读取本机样本，补充证据' });
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'scitag-e2e-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, 'sample.txt'), 'LOCAL-COMPUTER-EVIDENCE');
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const data of req) chunks.push(data);
    const response = await first(new Request('http://localhost' + req.url, { method: req.method, headers: req.headers,
      body: req.method === 'POST' ? Buffer.concat(chunks) : undefined }), backend);
    res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = `http://127.0.0.1:${server.address().port}`;
  await runWorker({ server: address, token: a.token, executor: 'command', workspace, stateDirectory: path.join(workspace, 'worker-a'),
    command: [process.execPath, '-e', 'let p="";process.stdin.on("data",d=>p+=d);process.stdin.on("end",()=>console.log(require("fs").readFileSync("sample.txt","utf8")+"|"+p.includes("补充证据")))'] }, { once: true, log() {} });
  const report = (await api(`/api/tasks/${task.id}`, owner.token)).task;
  assert.match(report.report, /LOCAL-COMPUTER-EVIDENCE\|true/);
  assert.equal(report.attempts, 2);
  await api(`/api/tasks/${task.id}/review`, owner.token, { decision: 'approve', comment: '确认本地证据' });
  assert.match((await api(`/api/tasks/${task.id}`, admin)).task.report, /LOCAL-COMPUTER-EVIDENCE/);
  await api('/api/messages', admin, { channel: 'lab', text: '@agent-b 请接着讨论' });
  await runWorker({ server: address, token: b.token, executor: 'command', workspace, stateDirectory: path.join(workspace, 'worker-b'),
    command: [process.execPath, '-e', 'process.stdin.resume();process.stdin.on("end",()=>console.log("另一电脑的Agent完成讨论"))'] }, { once: true, log() {} });
  const messages = (await api('/api/messages?channel=lab', admin)).messages;
  assert.equal(messages.filter(m => m.from === 'agent-b' && m.text.includes('完成讨论')).length, 1);
  assert.equal(state.tasks[task.id].status, 'published');
  const failedTask = (await api(`/api/missions/${mission.id}/tasks`, admin, { assignee: 'agent-b', title: '失败隔离' })).task;
  const failedJob = (await api('/api/worker/jobs/claim', b.token, { workerId: 'computer-b' })).job;
  const secret = 'PRIVATE-LOCAL-FAILURE-EVIDENCE';
  await api(`/api/worker/jobs/${failedJob.id}/complete`, b.token, { leaseToken: failedJob.leaseToken, failed: true, text: secret });
  assert.equal((await api(`/api/tasks/${failedTask.id}`, owner.token)).task.failReason, secret);
  assert.equal(JSON.stringify(await api('/api/messages?channel=lab', admin)).includes(secret), false);
});
