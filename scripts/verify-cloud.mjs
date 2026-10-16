// Explicit live verification. Creates a labelled private acceptance mission and
// saves credentials only beneath ignored local directories; never run from CI.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { runWorker } from '../worker.mjs';
import { executeLocal } from '../worker-executors.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const configPath = path.join(root, 'data/cloud-deployment.private.json');
const cloud = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const server = cloud.productionUrl || 'https://scitag-yinkesi1.vercel.app';
const directory = path.join(root, '.scitag-workers');
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
const result = { server, startedAt: new Date().toISOString(), checks: [], agents: {} };
const check = (label, condition) => { assert.ok(condition, label); result.checks.push(label); console.log('[ok] ' + label); };

async function api(route, token = cloud.adminToken, body) {
  const response = await fetch(server + route, { method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000), redirect: 'error' });
  return { status: response.status, ...await response.json() };
}
function writePrivate(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
}
async function prepareAgent(executor, name) {
  const configFile = path.join(directory, `worker.${executor}.json`);
  let local = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, 'utf8')) : null;
  if (local?.server !== server || (await api('/api/state', local.token)).status !== 200) {
    const registration = await api('/api/register', cloud.adminToken, { kind: 'agent', name, owner: cloud.adminName, domains: [] });
    assert.equal(registration.status, 200, `${executor} registration`);
    const workspace = path.join(directory, 'workspace', executor);
    fs.mkdirSync(workspace, { recursive: true });
    local = { server, token: registration.token, executor, workspace, sandbox: 'read-only',
      stateDirectory: path.join(directory, 'state', executor) };
    writePrivate(configFile, local);
  }
  delete local.timeoutMs; // Saved research workers retain the normal 30-minute default.
  writePrivate(configFile, local);
  fs.writeFileSync(path.join(local.workspace, 'sample.txt'), `SCITAG-CLOUD-VERIFIED-${executor.toUpperCase()}`);
  result.agents[executor] = { name, configFile };
  return local;
}

check('cloud config is ready', (await api('/api/config', null)).ready === true);
check('cloud health is ready', (await api('/api/health', null)).ok === true);
check('anonymous state is rejected', (await api('/api/state', null)).status === 401);
check('anonymous registration is rejected', (await api('/api/register', null, { name: 'unauthorized-test' })).status === 403);
check('administrator login works', (await api('/api/register', null, { name: cloud.adminName, token: cloud.adminToken })).status === 200);

const codex = await prepareAgent('codex', 'codex-cli');
const claude = await prepareAgent('claude', 'claude-code');
const deepseek = await prepareAgent('deepseek', 'deepseek-harness');
const groupResponse = await api('/api/channels', cloud.adminToken, { name: '云端部署验收', isPublic: false,
  members: ['codex-cli', 'claude-code', 'deepseek-harness'] });
assert.equal(groupResponse.status, 200);
const group = groupResponse.channel;
const missionResponse = await api('/api/missions', cloud.adminToken, { channel: group.id,
  title: '云端部署验收 ' + new Date().toISOString(), brief: '验证公网 API、任务独占领取、本地执行、成果去重、主人驳回及批准。' });
assert.equal(missionResponse.status, 200);
const mission = missionResponse.mission;
result.missionId = mission.id; result.channelId = group.id;
async function task(assignee, title, brief = '读取 sample.txt，回传其中的文字，不要修改文件。') {
  const response = await api(`/api/missions/${mission.id}/tasks`, cloud.adminToken, { assignee, title, brief });
  assert.equal(response.status, 200); return response.task;
}
const first = await task('codex-cli', '任务领取、重复回传与驳回重做验收');
const claims = await Promise.all([
  api('/api/worker/jobs/claim', codex.token, { workerId: 'acceptance-computer-a' }),
  api('/api/worker/jobs/claim', codex.token, { workerId: 'acceptance-computer-b' }),
]);
check('only one concurrent worker receives the job', claims.filter(item => item.job).length === 1);
const job = claims.find(item => item.job).job;
check('other Agent cannot submit the job', (await api(`/api/worker/jobs/${job.id}/complete`, deepseek.token,
  { leaseToken: job.leaseToken, text: 'forbidden' })).status === 404);
const command = [process.execPath, '-e', 'process.stdin.resume();process.stdin.on("end",()=>console.log(require("fs").readFileSync("sample.txt","utf8")))'];
fs.mkdirSync(codex.stateDirectory, { recursive: true });
const output = await executeLocal({ ...codex, executor: 'command', command }, job, codex.stateDirectory);
check('local child reads local evidence', !output.failed && output.text.includes('SCITAG-CLOUD-VERIFIED-CODEX'));
const completion = { leaseToken: job.leaseToken, ...output };
check('completion reaches cloud', (await api(`/api/worker/jobs/${job.id}/complete`, codex.token, completion)).ok === true);
check('repeated completion is idempotent', (await api(`/api/worker/jobs/${job.id}/complete`, codex.token, completion)).duplicate === true);
check('owner can reject', (await api(`/api/tasks/${first.id}/review`, cloud.adminToken,
  { decision: 'reject', comment: '部署验收：请再核验本地样本并重传。' })).status === 200);
await runWorker({ ...codex, executor: 'command', command }, { once: true });
const revised = (await api(`/api/tasks/${first.id}`)).task;
check('restarted worker completes the second round', revised.status === 'reported' && revised.attempts === 2);
check('owner approval publishes the report', (await api(`/api/tasks/${first.id}/review`, cloud.adminToken,
  { decision: 'approve', comment: '已核验云端任务与本地执行证据。' })).task?.status === 'published');

if (process.argv.includes('--models')) {
  for (const [name, local] of [['codex-cli', codex], ['deepseek-harness', deepseek]]) {
    const live = await task(name, '真实本地 Agent 读取文件并回传');
    await runWorker({ ...local, timeoutMs: 180000 }, { once: true });
    const report = (await api(`/api/tasks/${live.id}`)).task;
    check(`${local.executor} real Agent completes through cloud`, report.status === 'reported' &&
      report.report?.includes(`SCITAG-CLOUD-VERIFIED-${local.executor.toUpperCase()}`));
    await api(`/api/tasks/${live.id}/review`, cloud.adminToken, { decision: 'approve', comment: '已核验本地测试样本。' });
  }
}
check('acceptance mission can close', (await api(`/api/missions/${mission.id}/summarize`, cloud.adminToken,
  { text: '公网协作链路验收完成：任务领取、本机执行、回传去重、驳回重做、批准回群均通过。', close: true })).status === 200);
result.finishedAt = new Date().toISOString();
result.claudeStatus = '配置已生成，之前本机模型调用超时，未宣称通过真实模型验收';
writePrivate(path.join(root, 'data/cloud-verification.private.json'), result);
cloud.productionUrl = server;
writePrivate(configPath, cloud);
const login = `# SciTag 登录与接入\n\n网址：${server}\n\n账号：${cloud.adminName}\n\n访问凭据：${cloud.adminToken}\n\n请勿公开此文件或把凭据发到群里。\n\n本机接入配置：\n\n` +
  Object.entries(result.agents).map(([executor, info]) => `- ${executor}: ${info.configFile}\n  启动：node worker.mjs --config "${info.configFile}"`).join('\n') +
  '\n\n启动命令在 D:\\code\\scitag 目录执行。其他电脑请在网页创建独立 Agent 并下载自己的配置，不要复用管理员凭据。\n';
fs.writeFileSync(path.join(root, 'data/cloud-access.private.md'), login, { mode: 0o600 });
for (const [executor, info] of Object.entries(result.agents)) {
  fs.writeFileSync(path.join(directory, 'start-' + executor + '.bat'),
    '@echo off\r\n' + `title SciTag ${executor}\r\ncd /d "${root}"\r\n"${process.execPath}" "${path.join(root, 'worker.mjs')}" --config "${info.configFile}"\r\npause\r\n`);
}
console.log(JSON.stringify({ passed: result.checks.length, missionId: result.missionId, credentialsFile: 'data/cloud-access.private.md' }));
