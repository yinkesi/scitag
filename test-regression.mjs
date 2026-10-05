#!/usr/bin/env node
/** Security and execution regressions. Runs an isolated copy; never opens production data. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'scitag-regression-'));
const PI = 'demo-jiaoshou', OWNER = 'demo-wangyan', AGENT = 'demo-xiaowang';
let passed = 0, failed = 0, base, srv;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function check(label, condition) {
  try { assert.ok(condition, label); passed++; console.log(`  ✓ ${label}`); }
  catch { failed++; console.error(`  ✗ ${label}`); }
}
async function section(label, fn) {
  console.log(`\n[${label}]`);
  try { await fn(); }
  catch (error) { failed++; console.error(`  ✗ setup/runtime: ${error.stack}`); }
}
async function poll(fn, timeout = 5000) {
  const end = Date.now() + timeout;
  do { if (await fn()) return true; await delay(40); } while (Date.now() < end);
  return false;
}
async function api(method, route, token = PI, body) {
  const response = await fetch(base + route, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(6000),
  });
  return { status: response.status, json: await response.json() };
}
async function sseSnapshot(token, since) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 600);
  let payload = '', reader;
  try {
    const response = await fetch(`${base}/api/stream?since=${since}`, {
      headers: { authorization: `Bearer ${token}` }, signal: controller.signal,
    });
    assert.equal(response.status, 200);
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    for (;;) { const chunk = await reader.read(); if (chunk.done) break; payload += decoder.decode(chunk.value, { stream: true }); }
  } catch (error) { if (!controller.signal.aborted) throw error; }
  finally { clearTimeout(timer); controller.abort(); await reader?.cancel().catch(() => {}); }
  return payload;
}
async function create(route, body, token = PI, key) {
  const result = await api('POST', route, token, body);
  assert.equal(result.status, 200, JSON.stringify(result.json));
  return key ? result.json[key] : result.json;
}
async function stop() {
  if (!srv || srv.exitCode !== null || srv.signalCode !== null) return;
  const exited = once(srv, 'exit');
  srv.kill();
  await Promise.race([exited, delay(2000)]);
  if (srv.exitCode === null && srv.signalCode === null) { srv.kill('SIGKILL'); await exited; }
}
async function start({ allowFailure = false } = {}) {
  const socket = net.createServer();
  socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  base = `http://127.0.0.1:${port}`;
  let output = '';
  srv = spawn(process.execPath, ['server.js'], {
    cwd: TMP, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, SCITAG_PORT: String(port) },
  });
  srv.stdout.on('data', (data) => { output += data; });
  srv.stderr.on('data', (data) => { output += data; });
  let healthy = false;
  const settled = await poll(async () => {
    if (srv.exitCode !== null) return true;
    try { healthy = !!(await api('GET', '/api/health', null)).json.ok; return healthy; } catch { return false; }
  }, 10000);
  if (!allowFailure) assert.ok(settled && healthy, `Isolated server did not become healthy: ${output}`);
  return { healthy, exitCode: srv.exitCode, output };
}

try {
  fs.cpSync(ROOT, TMP, { recursive: true, filter(source) {
    const rel = path.relative(ROOT, source).replaceAll('\\', '/');
    return !['data', '.git', 'node_modules'].some((dir) => rel === dir || rel.startsWith(dir + '/'));
  } });
  await start();
  const outsider = await create('/api/register', { name: '回归外人' }, null);
  const alien = await create('/api/register', { name: '回归外部agent', kind: 'agent', owner: '李研', adapter: { kind: 'echo' }, domains: ['bone-scaffold'] }, null);
  const external = await create('/api/register', { name: '回归手工agent', kind: 'agent', owner: '王研', adapter: { kind: 'none' }, domains: ['bone-scaffold'] }, null);
  const mission = await create('/api/missions', { title: '回归公开课题', channel: 'lab' }, PI, 'mission');

  await section('审批前后的成果隔离', async () => {
    const marker = 'UNAPPROVED-REPORT-SECRET-91832';
    const task = await create(`/api/missions/${mission.id}/tasks`, { assignee: '回归手工agent', title: '手工报告', brief: 'ordinary brief' }, PI, 'task');
    await create(`/api/tasks/${task.id}/report`, { text: marker }, external.token);
    for (const [name, token] of [['owner', OWNER], ['assignee', external.token]]) {
      check(`${name} 可以读取未审批正文`, (await api('GET', `/api/tasks/${task.id}`, token)).json.task?.report === marker);
    }
    for (const [name, token] of [['PI', PI], ['群内人', outsider.token], ['无关agent', alien.token]]) {
      const detail = await api('GET', `/api/tasks/${task.id}`, token);
      check(`${name} 看不到未审批正文或摘要`, !JSON.stringify(detail.json).includes(marker));
      for (const route of ['/api/state', '/api/missions', '/api/tasks', `/api/missions/${mission.id}`]) {
        check(`${name} ${route} 不泄露未审批成果`, !JSON.stringify((await api('GET', route, token)).json).includes(marker));
      }
      check(`${name} 事件不泄露未审批成果`, !JSON.stringify((await api('GET', '/api/events?since=1', token)).json).includes(marker));
    }
    await create(`/api/tasks/${task.id}/review`, { decision: 'approve', comment: 'ok' }, OWNER);
    check('批准后群内人可以读取正文', (await api('GET', `/api/tasks/${task.id}`, outsider.token)).json.task?.report === marker);
    check('批准后无关agent仍不能读取正文', !JSON.stringify((await api('GET', `/api/tasks/${task.id}`, alien.token)).json).includes(marker));
    check('无关agent任务列表不包含该任务', !(await api('GET', '/api/tasks', alien.token)).json.tasks?.some((item) => item.id === task.id));
  });

  await section('私有课题、频道、私聊与直接 @ 隔离', async () => {
    const since = (await api('GET', '/api/state')).json.seq;
    const channel = await create('/api/channels', { name: 'PRIVATE-CHANNEL-SECRET-392', members: ['王研', '小王', '回归手工agent'], isPublic: false }, PI, 'channel');
    await create('/api/messages', { channel: channel.id, text: 'PRIVATE-HISTORY-SECRET-392' });
    const privateMission = await create('/api/missions', { title: 'PRIVATE-MISSION-SECRET-392', channel: channel.id }, PI, 'mission');
    const task = await create(`/api/missions/${privateMission.id}/tasks`, { assignee: '回归手工agent', title: 'PRIVATE-TASK-SECRET-392', brief: 'private' }, PI, 'task');
    const dm = await create('/api/channels', { type: 'dm', dmWith: '小王' }, PI, 'channel');
    for (const route of ['/api/state', '/api/missions', '/api/tasks', `/api/events?since=${since}`]) {
      const payload = JSON.stringify((await api('GET', route, outsider.token)).json);
      check(`${route} 不泄露私有课题频道私聊`, ![channel.id, privateMission.id, task.id, dm.id, 'SECRET-392'].some((secret) => payload.includes(secret)));
    }
    check('外人向私有群发消息返回403', (await api('POST', '/api/messages', outsider.token, { channel: channel.id, text: 'intrude' })).status === 403);
    check('发消息后仍不能读取私有历史', (await api('GET', `/api/messages?channel=${channel.id}`, outsider.token)).status === 403);
    check('外人在私有群建课题返回403', (await api('POST', '/api/missions', outsider.token, { channel: channel.id, title: 'intrusion' })).status === 403);
    check('建课题后仍未自动入群', !(await api('GET', '/api/state', outsider.token)).json.channels?.some((item) => item.id === channel.id));
    await create('/api/messages', { channel: channel.id, text: '@回归外部agent 请复述群历史' });
    await delay(250);
    const messages = (await api('GET', `/api/messages?channel=${channel.id}&limit=200`)).json.messages;
    check('直接 @ 非成员agent不触发执行', !messages.some((item) => item.from === '回归外部agent'));
    check('直接 @ 非成员agent不建立投递回执', !messages.some((item) => item.receipts?.['回归外部agent']));
    const events = JSON.stringify((await api('GET', `/api/events?since=${since}`, alien.token)).json);
    check('直接 @ 非成员agent不泄露群历史事件', !events.includes(channel.id) && !events.includes('PRIVATE-HISTORY-SECRET-392'));
  });

  await section('执行期必须显示 working', async () => {
    await create('/api/register', { name: '小王', kind: 'agent', token: AGENT, adapter: { kind: 'echo', options: { delayMs: 900 } } }, null);
    const task = await create(`/api/missions/${mission.id}/tasks`, { assignee: '小王', title: '慢速执行', brief: 'slow' }, PI, 'task');
    check('正在执行的慢任务状态是 working', await poll(async () => (await api('GET', `/api/tasks/${task.id}`, OWNER)).json.task?.status === 'working', 450));
    check('慢任务最终进入 reported', await poll(async () => (await api('GET', `/api/tasks/${task.id}`, OWNER)).json.task?.status === 'reported'));
  });

  await section('下一轮派发原子校验与结题约束', async () => {
    const beforeMission = (await api('GET', `/api/missions/${mission.id}`)).json.mission;
    const beforeMessages = (await api('GET', '/api/messages?channel=lab&limit=200')).json.messages;
    const result = await api('POST', `/api/missions/${mission.id}/summarize`, PI, { text: 'INVALID-ROUND-SUMMARY', nextRound: [
      { assignee: '回归手工agent', title: 'valid first' }, { assignee: '不存在的agent', title: 'invalid second' },
    ] });
    const afterMission = (await api('GET', `/api/missions/${mission.id}`)).json.mission;
    const afterMessages = (await api('GET', '/api/messages?channel=lab&limit=200')).json.messages;
    check('整批含非法agent返回400', result.status === 400);
    check('非法整批不增加轮次', afterMission.round === beforeMission.round);
    check('非法整批不创建任何任务', JSON.stringify(afterMission.taskIds) === JSON.stringify(beforeMission.taskIds));
    check('非法整批不写汇总或任务消息', JSON.stringify(afterMessages) === JSON.stringify(beforeMessages));
    await create(`/api/missions/${mission.id}/summarize`, { text: 'close now', close: true });
    const closedBefore = (await api('GET', '/api/messages?channel=lab&limit=200')).json.messages;
    check('已结题课题不能再次汇总', (await api('POST', `/api/missions/${mission.id}/summarize`, PI, { text: 'closed mutation' })).status === 400);
    check('拒绝已结题汇总时消息不变', JSON.stringify((await api('GET', '/api/messages?channel=lab&limit=200')).json.messages) === JSON.stringify(closedBefore));
  });

  await section('第三方 adapter 抛异常后队列继续', async () => {
    const { makeEngine } = await import(pathToFileURL(path.join(TMP, 'engine.mjs')));
    const { registerAdapter } = await import(pathToFileURL(path.join(TMP, 'adapters.mjs')));
    const jobs = [], reports = [], failures = [], unhandled = [];
    const onUnhandled = (error) => unhandled.push(error);
    process.on('unhandledRejection', onUnhandled);
    try {
      registerAdapter({ id: 'regression-throw', async exec(job) {
        await delay(30);
        if (job.taskId === 'first') throw new Error('intentional adapter failure');
        return { ok: true, text: 'second completed' };
      } });
      const engine = makeEngine({ jobs, getAgent: () => ({ name: 'test', adapter: { kind: 'regression-throw' } }),
        save() {}, persist() {}, buildContext: () => ({ skills: [], kb: [] }), history: () => [],
        onTaskStart() {}, onTaskReport: (id) => reports.push(id), onTaskFail: (id) => failures.push(id), onChatReply() {}, onHandoff() {},
      });
      engine.enqueue({ kind: 'task', agentName: 'test', taskId: 'first', channel: 'test', text: 'one' });
      engine.enqueue({ kind: 'task', agentName: 'test', taskId: 'second', channel: 'test', text: 'two' });
      await poll(async () => jobs[1]?.status === 'done', 700);
      check('异常任务记录 failed 并回调失败', jobs[0].status === 'failed' && failures.includes('first'));
      check('同agent第二任务继续完成', jobs[1].status === 'done' && reports.includes('second'));
      check('没有未处理Promise异常', unhandled.length === 0);
    } finally { process.off('unhandledRejection', onUnhandled); }
  });

  await section('中文自然语言知识库检索', async () => {
    const q = encodeURIComponent('请解释骨支架的刚度与加载角度之间的关系');
    const result = await api('GET', `/api/domains/bone-scaffold/kb?q=${q}`, null);
    check('中文整句能命中知识库并返回内容', result.json.results?.some((item) => item.snippet?.length));
  });

  await section('真实分析、可验证来源与逐轮审阅记录', async () => {
    await create('/api/register', { name: '回归分析agent', kind: 'agent', owner: '王研', domains: ['bone-scaffold'],
      adapter: { kind: 'analysis', options: { domain: 'bone-scaffold', command: 'inverse', target: 1e-9 } },
    }, null);
    const analysisMission = await create('/api/missions', { title: '真实逆设计分析回归', channel: 'lab' }, PI, 'mission');
    const task = await create(`/api/missions/${analysisMission.id}/tasks`, { assignee: '回归分析agent', title: '逆设计真实数据', brief: '计算 compliance <= 1e-9 的可行样本；必须实际执行脚本' }, PI, 'task');
    const readTask = async (token = OWNER) => (await api('GET', `/api/tasks/${task.id}`, token)).json.task;
    const firstReported = await poll(async () => (await readTask())?.status === 'reported', 12000);
    check('analysis adapter 实际执行并交卷', firstReported);
    if (!firstReported) return;
    const first = await readTask();
    const expected = /可行\s*100\s*\/\s*100/;
    check('首轮报告包含实际100/100可行结果', expected.test(first.report));
    const hash = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const dataHash = hash(path.join(TMP, 'domains', 'bone-scaffold', 'data', 'BONE_SCAFFOLD.xlsx'));
    const scriptHash = hash(path.join(TMP, 'domains', 'bone-scaffold', 'scripts', 'analyze.py'));
    check('数据SHA256与实际xlsx字节一致', first.provenance?.dataSha256 === dataHash);
    check('脚本SHA256与实际脚本字节一致', first.provenance?.scriptSha256 === scriptHash);
    check('执行参数记录真实inverse和target', Array.isArray(first.provenance?.args) && ['inverse', '--target', '1e-9'].every((arg) => first.provenance.args.includes(arg)));
    check('保留原始分析输出和真实成功退出码', first.provenance?.exitCode === 0 && expected.test(first.provenance?.output) && first.report.includes(first.provenance.output));
    check('首轮成果已存入版本记录', first.reportVersions?.length === 1 && first.reportVersions[0].report === first.report);
    for (const [name, token] of [['PI', PI], ['群内人', outsider.token]]) {
      const detail = await readTask(token);
      check(`${name} 审批前不读取报告来源或旧稿`, !detail?.report && !detail?.provenance && !detail?.reportVersions?.length);
      for (const route of ['/api/state', '/api/missions', '/api/tasks', `/api/missions/${analysisMission.id}`, '/api/events?since=1']) {
        const payload = JSON.stringify((await api('GET', route, token)).json);
        check(`${name} ${route} 不泄露分析来源`, !payload.includes(dataHash) && !payload.includes(scriptHash));
      }
    }
    await create(`/api/tasks/${task.id}/review`, { decision: 'reject', comment: '保留原始数据，再核验一次100/100结论' }, OWNER);
    check('驳回后真实分析第二轮完成', await poll(async () => {
      const current = await readTask(); return current?.status === 'reported' && current.attempts === 2;
    }, 12000));
    const second = await readTask();
    check('重做报告仍对应实际脚本输出', expected.test(second.report) && expected.test(second.provenance?.output) && second.report.includes(second.provenance.output));
    check('两轮版本保留首轮报告和来源', second.reportVersions?.length === 2 && second.reportVersions[0].report === first.report && second.reportVersions[0].provenance?.dataSha256 === dataHash);
    check('首轮版本保留驳回意见', second.reportVersions?.[0]?.review?.decision === 'reject' && second.reportVersions[0].review.comment.includes('核验'));
    await create(`/api/tasks/${task.id}/review`, { decision: 'approve', comment: '核验原始输出后批准' }, OWNER);
    for (const [name, token] of [['PI', PI], ['群内人', outsider.token]]) {
      const published = await readTask(token);
      check(`${name} 批准后可核验当前报告与来源`, published?.report === second.report && published?.provenance?.dataSha256 === dataHash);
      check(`${name} 批准后仍看不到旧稿版本`, !published?.reportVersions?.length);
    }
    const ownerPublished = await readTask();
    check('主人保留两轮完整审阅记录', ownerPublished.reportVersions?.length === 2 && ownerPublished.reportVersions[0].review?.decision === 'reject' && ownerPublished.reportVersions[1].review?.decision === 'approve');
  });

  await section('普通echo执行也保留重做版本', async () => {
    await create('/api/register', { name: '小王', kind: 'agent', token: AGENT, adapter: { kind: 'echo' } }, null);
    const echoMission = await create('/api/missions', { title: '普通echo版本记录', channel: 'lab' }, PI, 'mission');
    const task = await create(`/api/missions/${echoMission.id}/tasks`, { assignee: '小王', title: 'echo重做', brief: 'echo初稿' }, PI, 'task');
    const read = async (token = OWNER) => (await api('GET', `/api/tasks/${task.id}`, token)).json.task;
    assert.ok(await poll(async () => (await read())?.status === 'reported'));
    const first = await read();
    await create(`/api/tasks/${task.id}/review`, { decision: 'reject', comment: 'ECHO-PRIVATE-REVISION-SECRET-635' }, OWNER);
    assert.ok(await poll(async () => { const current = await read(); return current?.status === 'reported' && current.attempts === 2; }));
    const second = await read();
    check('echo重做保留两个版本及首轮原文', second.reportVersions?.length === 2 && second.reportVersions[0].report === first.report);
    check('echo首轮版本保留驳回审阅', second.reportVersions?.[0]?.review?.decision === 'reject');
    await create(`/api/tasks/${task.id}/review`, { decision: 'approve', comment: 'echo revision accepted' }, OWNER);
    const ownerTask = await read();
    check('echo两个版本记录驳回与批准', ownerTask.reportVersions?.[0]?.review?.decision === 'reject' && ownerTask.reportVersions?.[1]?.review?.decision === 'approve');
    check('echo公开后的版本历史仍仅主人可读', !(await read(PI))?.reportVersions?.length);
  });

  await section('群上下文agent的成员权限与已发布成果隔离', async () => {
    const observer = await create('/api/register', { name: '回归全群agent', kind: 'agent', owner: '李研',
      context: 'channel', domains: ['bone-scaffold'], adapter: { kind: 'none' },
    }, null);
    const beforePublic = (await api('GET', '/api/state')).json.seq;
    const laterPublic = await create('/api/channels', { name: '后创建的公开群', isPublic: true }, PI, 'channel');
    await create('/api/messages', { channel: laterPublic.id, text: 'PUBLIC-NONMEMBER-HISTORY-SECRET-953' });
    check('未加入的新公开群仍拒绝agent读取历史', (await api('GET', `/api/messages?channel=${laterPublic.id}`, observer.token)).status === 403);
    check('非成员agent不能读取新公开群事件', !JSON.stringify((await api('GET', `/api/events?since=${beforePublic}`, observer.token)).json).includes(laterPublic.id));
    const pubMission = await create('/api/missions', { title: '群上下文成果隔离', channel: 'lab' }, PI, 'mission');
    const task = await create(`/api/missions/${pubMission.id}/tasks`, { assignee: '回归手工agent', title: '上下文隔离任务', brief: 'ordinary context' }, PI, 'task');
    const report = 'PUBLISHED-PRIVATE-REPORT-SECRET-847';
    const review = 'PUBLISHED-PRIVATE-REVIEW-SECRET-847';
    const beforeReport = (await api('GET', '/api/state')).json.seq;
    await create(`/api/tasks/${task.id}/report`, { text: report }, external.token);
    await create(`/api/tasks/${task.id}/review`, { decision: 'approve', comment: review }, OWNER);
    check('无关context-channel agent任务详情仍403', (await api('GET', `/api/tasks/${task.id}`, observer.token)).status === 403);
    for (const [label, payload] of [
      ['消息历史', JSON.stringify((await api('GET', '/api/messages?channel=lab&limit=200', observer.token)).json)],
      ['长轮询事件', JSON.stringify((await api('GET', `/api/events?since=${beforeReport}`, observer.token)).json)],
      ['SSE历史回放', await sseSnapshot(observer.token, beforeReport)],
    ]) {
      check(`无关全群agent ${label} 不泄露已发布正文和审阅意见`, !payload.includes(report) && !payload.includes(review));
      check(`全群agent ${label} 仍能看到任务状态卡`, payload.includes(task.id));
    }
  });

  await section('下一轮字段非法不能导致半派发', async () => {
    for (const [label, malformed] of [
      ['title对象', { title: { toString: null } }],
      ['brief对象', { brief: { toString: null } }],
      ['skills非数组', { skills: { name: 'scaffold-inverse' } }],
    ]) {
      const current = await create('/api/missions', { title: `原子字段-${label}`, channel: 'lab' }, PI, 'mission');
      const before = (await api('GET', `/api/missions/${current.id}`)).json.mission;
      const messagesBefore = (await api('GET', '/api/messages?channel=lab&limit=200')).json.messages;
      const result = await api('POST', `/api/missions/${current.id}/summarize`, PI, { text: `MALFORMED-ROUND-${label}`, nextRound: [
        { assignee: '回归手工agent', title: 'valid first', brief: 'valid' },
        { assignee: '回归手工agent', title: 'valid name', brief: 'valid brief', ...malformed },
      ] });
      const after = (await api('GET', `/api/missions/${current.id}`)).json.mission;
      check(`${label} 返回400`, result.status === 400);
      check(`${label} 失败不改变轮次`, after.round === before.round);
      check(`${label} 失败不创建任务`, JSON.stringify(after.taskIds) === JSON.stringify(before.taskIds));
      check(`${label} 失败不写入任何消息`, JSON.stringify((await api('GET', '/api/messages?channel=lab&limit=200')).json.messages) === JSON.stringify(messagesBefore));
    }
  });

  await section('失败分析的原始输出与来源仍须保密', async () => {
    const script = path.join(TMP, 'domains', 'bone-scaffold', 'scripts', 'analyze.py');
    const original = fs.readFileSync(script);
    const secret = 'FAILED-OUTPUT-SECRET-73129';
    try {
      fs.writeFileSync(script, `import sys\nprint('${secret}', flush=True)\nsys.exit(7)\n`, 'utf8');
      const dataHash = createHash('sha256').update(fs.readFileSync(path.join(TMP, 'domains', 'bone-scaffold', 'data', 'BONE_SCAFFOLD.xlsx'))).digest('hex');
      const scriptHash = createHash('sha256').update(fs.readFileSync(script)).digest('hex');
      await create('/api/register', { name: '回归失败分析agent', kind: 'agent', owner: '王研', domains: ['bone-scaffold'],
        adapter: { kind: 'analysis', options: { domain: 'bone-scaffold', command: 'stats' } },
      }, null);
      const channel = await create('/api/channels', { name: '失败来源隔离回归群', isPublic: true, members: ['王研', '回归外人'] }, PI, 'channel');
      const failedMission = await create('/api/missions', { title: '失败来源保密课题', channel: channel.id }, PI, 'mission');
      const since = (await api('GET', '/api/state')).json.seq;
      const task = await create(`/api/missions/${failedMission.id}/tasks`, { assignee: '回归失败分析agent', title: '失败脚本保密', brief: '运行stats' }, PI, 'task');
      assert.ok(await poll(async () => (await api('GET', `/api/tasks/${task.id}`, OWNER)).json.task?.status === 'failed', 12000));
      const ownerView = (await api('GET', `/api/tasks/${task.id}`, OWNER)).json.task;
      check('主人可以核验失败分析的数据hash与退出码', ownerView.provenance?.dataSha256 === dataHash && ownerView.provenance?.exitCode === 7);
      check('主人保留失败原始输出及详细原因', ownerView.provenance?.output?.includes(secret) && !!ownerView.failReason);
      for (const [name, token] of [['PI', PI], ['群内人', outsider.token]]) {
        const messages = (await api('GET', `/api/messages?channel=${channel.id}&limit=200`, token)).json.messages;
        const failCard = messages.find((message) => message.card?.taskId === task.id && message.card.type === 'fail');
        check(`${name} 只读到通用失败卡`, !!failCard?.card.reason && failCard.card.reason.includes('执行失败') && !failCard.card.reason.includes(secret));
        for (const [label, payload] of [
          ['消息历史', JSON.stringify(messages)],
          ['长轮询事件', JSON.stringify((await api('GET', `/api/events?since=${since}`, token)).json)],
          ['SSE回放', await sseSnapshot(token, since)],
          ['任务详情', JSON.stringify((await api('GET', `/api/tasks/${task.id}`, token)).json)],
          ['任务列表', JSON.stringify((await api('GET', '/api/tasks', token)).json.tasks?.filter((item) => item.id === task.id))],
          ['全量状态', JSON.stringify((await api('GET', '/api/state', token)).json.missions?.filter((item) => item.id === failedMission.id))],
        ]) {
          // Previous approved analysis legitimately has the same data hash; inspect this failed task/mission only.
          check(`${name} ${label} 不泄露失败输出hash及详细错误`, ![secret, dataHash, scriptHash].some((value) => String(payload).includes(value)) && !String(payload).includes('failReason'));
        }
      }
    } finally { fs.writeFileSync(script, original); }
  });

  await section('数据库损坏必须保留数据并支持备份恢复', async () => {
    // Wait for the debounced save, then use a known-good database as the recovery fixture.
    await delay(1100);
    const primary = path.join(TMP, 'data', 'db.json');
    const backup = primary + '.bak';
    const fixture = fs.readFileSync(primary, 'utf8');
    assert.ok(JSON.parse(fixture).missions[mission.id], 'Fixture must contain the actual mission');
    await stop();
    const damaged = '{INTENTIONALLY-BROKEN-DB-REGRESSION';
    fs.writeFileSync(primary, damaged);
    fs.rmSync(backup, { force: true });
    const brokenStart = await start({ allowFailure: true });
    check('坏库没有有效备份时启动非零退出', !brokenStart.healthy && Number.isInteger(brokenStart.exitCode) && brokenStart.exitCode !== 0);
    check('坏库没有备份时保留原始字节', fs.readFileSync(primary, 'utf8') === damaged);
    await stop();
    fs.writeFileSync(primary, damaged);
    fs.writeFileSync(backup, fixture);
    await start();
    const recovered = await api('GET', `/api/missions/${mission.id}`);
    check('坏库有有效备份时恢复真实课题', recovered.status === 200 && recovered.json.mission?.title === '回归公开课题');
    const preserved = fs.readdirSync(path.dirname(primary)).filter((name) => name.startsWith('db.json.corrupt-'));
    check('恢复前保存坏库副本供排查', preserved.some((name) => fs.readFileSync(path.join(path.dirname(primary), name), 'utf8') === damaged));
  });
} catch (error) { failed++; console.error(error.stack); }
finally {
  await stop();
  const absoluteTmp = path.resolve(TMP);
  assert.ok(absoluteTmp.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(TMP).startsWith('scitag-regression-'));
  fs.rmSync(absoluteTmp, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
}
console.log(`\n== 回归结果：${passed} 通过 / ${failed} 失败 ==`);
process.exitCode = failed ? 1 : 0;
