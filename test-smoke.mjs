#!/usr/bin/env node
/**
 * test-smoke.mjs —— SciTag 冒烟测试
 *
 * 纪律（承自 agent-tag）：在临时副本目录起服务跑，不碰生产 data/；
 * 断言失败立刻非零退出。六组覆盖见 docs/ENGINEERING.md 第 9 节：
 *   L1 交流层 / L2 资源层 / L3 执行层 / L4 工作流全环 / 权限 / 持久化
 *
 * 运行：node test-smoke.mjs
 */
'use strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'scitag-smoke-'));
const PORT = 8200 + Math.floor(Math.random() * 600);
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}`); }
}

async function api(method, p, { token, body } = {}) {
  const r = await fetch(BASE + p, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, json: j };
}

async function poll(fn, label, timeoutMs = 8000) {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return true;
    if (Date.now() - t0 > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 200));
  }
}

function startServer() {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: TMP, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, SCITAG_PORT: String(PORT) },
  });
  child.stdout.on('data', (d) => process.env.SCITAG_VERBOSE && console.log('[srv]', String(d).trim()));
  child.stderr.on('data', (d) => console.error('[srv:err]', String(d).trim()));
  return child;
}

async function waitHealth() {
  return poll(async () => {
    try { const r = await api('GET', '/api/health'); return r.json.ok === true; } catch { return false; }
  }, 'health', 10000);
}

/* ---------- 准备副本 ---------- */
fs.cpSync(ROOT, TMP, {
  recursive: true,
  filter: (src) => {
    const rel = path.relative(ROOT, src).replaceAll('\\', '/');
    return rel === '' || !(rel === 'data' || rel.startsWith('data/') ||
      rel.startsWith('domains/bone-scaffold/data/') || rel === '.git' || rel.startsWith('.git/'));
  },
});

let srv = startServer();
const cleanup = () => { try { srv.kill(); } catch {} };
process.on('exit', () => {
  cleanup();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* Windows 句柄滞留：残留临时目录无害 */ }
});

await waitHealth();
console.log(`\n== SciTag 冒烟 @ ${BASE}（副本 ${TMP}）==\n`);

/* ---------- L1 交流层 ---------- */
console.log('[L1 交流层]');
{
  ok((await api('GET', '/api/health')).json.name === 'scitag', 'health 返回 scitag');

  const rZhang = await api('POST', '/api/register', { body: { name: '张研', persona: '测试研究者' } });
  ok(rZhang.status === 200 && rZhang.json.token, '注册人类研究者 张研');
  const zhang = rZhang.json.token;

  const rNoOwner = await api('POST', '/api/register', { body: { kind: 'agent', name: '野agent', domains: ['bone-scaffold'] } });
  ok(rNoOwner.status === 400, '无主 agent 注册被拒（闭环必须有审阅人）');

  const rAgent = await api('POST', '/api/register', {
    body: { kind: 'agent', name: '小张', owner: '张研', persona: '张研的测试 agent', domains: ['bone-scaffold'], adapter: { kind: 'echo' } },
  });
  ok(rAgent.status === 200 && rAgent.json.me.owner === '张研', 'agent 绑定主人+挂载域包注册');
  const xiaoZhang = rAgent.json.token;

  const rBadDomain = await api('POST', '/api/register', { body: { kind: 'agent', name: '小野', owner: '张研', domains: ['不存在域'] } });
  ok(rBadDomain.status === 200 && rBadDomain.json.me.domains.length === 0, '未知域包被过滤');

  // 群消息 @ 路由 + #技能语法
  const rMsg = await api('POST', '/api/messages', {
    token: zhang,
    body: { channel: 'lab', text: '@小张 用 #scaffold-model 给我看看线性拟合的口径' },
  });
  ok(rMsg.status === 200 && rMsg.json.message.mentions.includes('小张'), '@ 解析命中小张');
  ok((rMsg.json.message.skills || []).includes('scaffold-model'), '#技能 语法携带 scaffold-model');
  ok(rMsg.json.message.receipts?.小张 === 'queued', '回执 queued 落在 @ 目标上');

  // echo 后端应回帖（chat job）
  const replied = await poll(async () => {
    const r = await api('GET', '/api/messages?channel=lab&limit=20', { token: zhang });
    return r.json.messages.some((m) => m.from === '小张' && m.text.includes('scaffold-model'));
  }, 'echo chat 回帖含点名技能');
  ok(replied, 'echo 后端回复 @ 消息且注入了 #技能');

  // 上下文隔离：小张（mentions）拉不到无关群消息
  const rIsolation = await api('GET', '/api/messages?channel=lab&limit=50', { token: xiaoZhang });
  ok(rIsolation.json.messages.every((m) => m.kind === 'system' || m.from === '小张' ||
    (m.mentions || []).some((x) => x === '小张' || x === '@all')), 'agent 上下文隔离：只见 @ 自己的');
}

/* ---------- L2 资源层 ---------- */
console.log('[L2 资源层]');
{
  const rD = await api('GET', '/api/domains');
  ok(rD.status === 200, '域包清单公开可读');
  const bone = rD.json.domains.find((d) => d.name === 'bone-scaffold');
  ok(!!bone && bone.skills.length === 3 && bone.kbCount === 4, 'bone-scaffold：3 技能 / 4 KB 条目');

  const rSearch = await api('GET', '/api/domains/bone-scaffold/kb?q=compliance permeability');
  ok(rSearch.json.results.length > 0, 'KB 词频检索有命中');

  const rTitle = await api('GET', '/api/domains/bone-scaffold/kb?q=术语');
  ok(rTitle.json.results[0]?.name === '术语表', '标题命中加权：q=术语 → 术语表第一');

  const rSkill = await api('GET', '/api/domains/bone-scaffold/skills/scaffold-model');
  ok(rSkill.json.skill?.body?.includes('最小二乘'), '技能全文可读（scaffold-model）');

  const rKb = await api('GET', '/api/domains/bone-scaffold/kb/数据字典');
  ok(rKb.json.body?.includes('8.5e-8') || rKb.json.body?.includes('8.54e-08') || rKb.json.body?.includes('8.5'), 'KB 条目含 permeability 恒定注记');

  const r404 = await api('GET', '/api/domains/bone-scaffold/kb/../../server.js');
  ok(r404.status === 404 || r404.status === 400, 'KB 目录穿越被挡');
}

/* ---------- L3+L4 工作流全环（echo 执行器） ---------- */
console.log('[L4 工作流：派活→干活→私聊审阅→批准→回群]');
let missionId, taskA;
{
  const prof = 'demo-jiaoshou', wang = 'demo-wangyan', li = 'demo-liyan';
  const rMission = await api('POST', '/api/missions', {
    token: prof,
    body: { title: '骨支架 compliance 机理与建模', brief: '围绕导师三方向：先解释 compliance 随角度放大机理，再建函数模型。', channel: 'lab' },
  });
  ok(rMission.status === 200 && rMission.json.mission.status === 'open', '教授建课题');
  missionId = rMission.json.mission.id;

  // 权限：非领导不能派活
  const rWang = await api('POST', `/api/missions/${missionId}/tasks`, {
    token: wang, body: { assignee: '小王', title: '越权任务', brief: 'x' },
  });
  ok(rWang.status === 403, '非领导派活被拒（403）');

  // 派活（点名技能）→ echo 干活 → reported
  const rTask = await api('POST', `/api/missions/${missionId}/tasks`, {
    token: prof,
    body: { assignee: '小王', title: '解释 compliance 随加载角的放大机理', brief: '按研究任务口径 T2：分组统计 compliance 角度趋势并给机理归因。', skills: ['scaffold-explain'] },
  });
  ok(rTask.status === 200 && ['dispatched', 'working'].includes(rTask.json.task.status), '教授派活给小王（带技能）');
  taskA = rTask.json.task.id;

  const reported = await poll(async () => {
    const r = await api('GET', `/api/tasks/${taskA}`, { token: wang });
    return r.json.task?.status === 'reported';
  }, '等 echo 产出成果');
  ok(reported, 'echo 执行器产出成果 → reported');

  const rFull = await api('GET', `/api/tasks/${taskA}`, { token: wang });
  ok(rFull.json.task.report?.includes('scaffold-explain'), '成果里标注了外挂技能（上下文注入生效）');
  ok((rFull.json.task.report?.match(/参考知识库：(.*)/) || [])[1]?.trim() !== '无', '成果引用了 KB 检索结果');

  // 成果落在 owner 私聊（王研↔小王），别人看不见
  const rDm = await api('GET', '/api/messages?channel=' + encodeURIComponent('dm:小王~王研') + '&limit=20', { token: wang });
  const reviewCard = rDm.json.messages.find((m) => m.card?.type === 'review' && m.card.taskId === taskA);
  ok(!!reviewCard, '审批卡落在 小王↔王研 私聊');
  const rPeep = await api('GET', '/api/messages?channel=' + encodeURIComponent('dm:小王~王研') + '&limit=5', { token: li });
  ok(rPeep.status === 403, '无关者读他人私聊被拒（403）');

  // 权限：非主人不能审
  const rBadReview = await api('POST', `/api/tasks/${taskA}/review`, { token: li, body: { decision: 'approve' } });
  ok(rBadReview.status === 403, '非主人审批被拒（403）');

  // 主人批准 → 回群
  const rApprove = await api('POST', `/api/tasks/${taskA}/review`, { token: wang, body: { decision: 'approve', comment: '机理清楚，同意回群' } });
  ok(rApprove.status === 200 && rApprove.json.task.status === 'published', '王研批准 → published');
  const rLab = await api('GET', '/api/messages?channel=lab&limit=30', { token: prof });
  const pubMsg = rLab.json.messages.find((m) => m.card?.type === 'publish' && m.card.taskId === taskA);
  ok(!!pubMsg && pubMsg.mentions.includes('教授'), '成果卡回群并 @领导');
  ok(pubMsg?.card?.reviewComment === '机理清楚，同意回群', '回群卡带主人审阅意见');
}

console.log('[L4 工作流：驳回回炉与熔断]');
{
  const prof = 'demo-jiaoshou', li = 'demo-liyan';
  const rTask = await api('POST', `/api/missions/${missionId}/tasks`, {
    token: prof,
    body: { assignee: '小李', title: 'compliance 函数建模', brief: '按 T3 口径做基础函数分析。', skills: ['scaffold-model'] },
  });
  const tid = rTask.json.task.id;

  await poll(async () => (await api('GET', `/api/tasks/${tid}`, { token: li })).json.task?.status === 'reported', '等第一轮产出');
  const rReject = await api('POST', `/api/tasks/${tid}/review`, { token: li, body: { decision: 'reject', comment: 'R² 呢？补上拟合优度再交。' } });
  ok(rReject.status === 200 && rReject.json.task.attempts === 2, '驳回后 attempts=2 回炉');

  const again = await poll(async () => (await api('GET', `/api/tasks/${tid}`, { token: li })).json.task?.status === 'reported', '等第二轮产出');
  ok(again, '带意见重做后再次 reported');
  const rBrief = await api('GET', `/api/tasks/${tid}`, { token: li });
  ok(rBrief.json.task.brief.includes('R² 呢'), '任务书并入了主人审阅意见');
  const rApprove = await api('POST', `/api/tasks/${tid}/review`, { token: li, body: { decision: 'approve', comment: '可以' } });
  ok(rApprove.json.task.status === 'published', '第二轮批准 → published');

  // 熔断：两次驳回 → failed + 转人工卡
  const rT3 = await api('POST', `/api/missions/${missionId}/tasks`, {
    token: prof, body: { assignee: '小王', title: '逆设计演练', brief: 'target 8e-11。' },
  });
  const t3 = rT3.json.task.id;
  for (let i = 0; i < 2; i++) {
    await poll(async () => (await api('GET', `/api/tasks/${t3}`, { token: 'demo-wangyan' })).json.task?.status === 'reported', `第 ${i + 1} 轮产出`);
    await api('POST', `/api/tasks/${t3}/review`, { token: 'demo-wangyan', body: { decision: 'reject', comment: '不对，重来' } });
  }
  const rFail = await api('GET', `/api/tasks/${t3}`, { token: 'demo-wangyan' });
  ok(rFail.json.task.status === 'failed', '重试耗尽 → failed');
  const rLab2 = await api('GET', '/api/messages?channel=lab&limit=20', { token: prof });
  ok(rLab2.json.messages.some((m) => m.card?.type === 'fail' && m.card.taskId === t3), '失败转人工卡回群');
}

console.log('[L4 工作流：外部 runtime 接入（无执行器路径）]');
{
  const prof = 'demo-jiaoshou';
  const rZhao = await api('POST', '/api/register', { body: { name: '赵研', persona: '外部接入测试主人' } });
  const zhao = rZhao.json.token;
  const rAgent = await api('POST', '/api/register', {
    body: { kind: 'agent', name: '小外', owner: '赵研', domains: ['bone-scaffold'], adapter: { kind: 'none' } },
  });
  const wai = rAgent.json.token;
  const rTask = await api('POST', `/api/missions/${missionId}/tasks`, {
    token: prof, body: { assignee: '小外', title: '外部 agent 任务', brief: '外部 runtime 认领并交成果。' },
  });
  const tid = rTask.json.task.id;

  const rT = await api('GET', `/api/tasks/${tid}`, { token: prof });
  ok(rT.json.task.status === 'dispatched', '无执行器的任务停在 dispatched');

  // 长轮询能收到任务卡（外部投递路径）
  const rEv = await api('GET', '/api/events?wait=1&since=0', { token: wai });
  ok(rEv.json.events?.some((e) => e.type === 'message' && e.message?.card?.taskId === tid), '外部 runtime 长轮询收到任务卡');

  // 外部 agent 自己交成果（dispatched → reported 直接合法）
  const rRep = await api('POST', `/api/tasks/${tid}/report`, {
    token: wai, body: { text: '# 外部成果\n外部 runtime 直接提交的报告。' },
  });
  ok(rRep.status === 200 && rRep.json.task.status === 'reported', '外部 agent 提交成果 → reported');

  const rBad = await api('POST', `/api/tasks/${tid}/report`, { token: 'demo-xiaoli', body: { text: '冒充' } });
  ok(rBad.status === 403, '非 assignee 提交成果被拒（403）');

  const rAp = await api('POST', `/api/tasks/${tid}/review`, { token: zhao, body: { decision: 'approve', comment: '外部链路通了' } });
  ok(rAp.status === 200 && rAp.json.task.status === 'published', '外部路径的成果审阅后回群');

  const rZhang2 = await api('POST', '/api/register', { body: { name: '张研' } });
  ok(rZhang2.status === 409, '重复注册无 token 被拒（409）');
}

console.log('[汇总与结题]');
{
  const prof = 'demo-jiaoshou';
  const rBad = await api('POST', `/api/missions/${missionId}/summarize`, { token: 'demo-wangyan', body: { text: 'x' } });
  ok(rBad.status === 403, '非领导汇总被拒（403）');
  const rSum = await api('POST', `/api/missions/${missionId}/summarize`, {
    token: prof,
    body: { text: '本轮小结：机理归因与函数建模成果已回群；逆设计演练熔断转人工。', close: true },
  });
  ok(rSum.status === 200 && rSum.json.mission.status === 'closed', '领导汇总并结题');
  const rProg = await api('GET', `/api/missions/${missionId}`, { token: prof });
  ok(rProg.json.mission.progress.total === 4 && rProg.json.mission.progress.by.published === 3, '课题进度统计正确（4 任务 / 3 已回群）');
}

/* ---------- 持久化：重启 ---------- */
console.log('[持久化]');
{
  await new Promise((r) => setTimeout(r, 1200)); // 等 800ms 防抖写盘冲刷（Windows 硬终止不走 SIGTERM）
  srv.kill();
  await new Promise((r) => setTimeout(r, 600));
  srv = startServer();
  await waitHealth();
  const rState = await api('GET', '/api/state', { token: 'demo-jiaoshou' });
  const m = rState.json.missions.find((x) => x.id === missionId);
  ok(!!m && m.status === 'closed' && m.tasks.length === 4, '重启后课题/任务俱在');
  const pub = m.tasks.find((t) => t.id === taskA);
  ok(pub?.status === 'published' && pub.publishedSeq > 0, '已回群任务的 publishedSeq 落盘');
}

console.log(`\n== 结果：${passed} 通过 / ${failed} 失败 ==`);
process.exit(failed ? 1 : 0);
