#!/usr/bin/env node
/**
 * test-edge.mjs —— 对抗性边界探针（冒烟不覆盖的路径）
 * 用法：node test-edge.mjs（副本目录起服务，与 test-smoke 同纪律）
 */
'use strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'scitag-edge-'));
const PORT = 8800 + Math.floor(Math.random() * 150);
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0, failed = 0;
const ok = (c, l) => { if (c) { passed++; console.log(`  ✓ ${l}`); } else { failed++; console.error(`  ✗ ${l}`); } };
async function api(method, p, { token, body } = {}) {
  const r = await fetch(BASE + p, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}
async function poll(fn, ms = 6000) {
  const t0 = Date.now();
  for (;;) { if (await fn()) return true; if (Date.now() - t0 > ms) return false; await new Promise((r) => setTimeout(r, 150)); }
}

fs.cpSync(ROOT, TMP, {
  recursive: true,
  filter: (src) => {
    const rel = path.relative(ROOT, src).replaceAll('\\', '/');
    return rel === '' || !(rel === 'data' || rel.startsWith('data/') || rel.startsWith('domains/bone-scaffold/data/') || rel === '.git' || rel.startsWith('.git/'));
  },
});
let srv = spawn(process.execPath, ['server.js'], { cwd: TMP, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, SCITAG_PORT: String(PORT) } });
srv.stderr.on('data', (d) => console.error('[srv:err]', String(d).trim()));
process.on('exit', () => { try { srv.kill(); } catch {} try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });
await poll(async () => { try { return (await api('GET', '/api/health')).json.ok; } catch { return false; } }, 10000);
console.log(`\n== 边界探针 @ ${BASE} ==\n`);

const prof = 'demo-jiaoshou';
{
  console.log('[重复审批/重复交卷]');
  const m = (await api('POST', '/api/missions', { token: prof, body: { title: '边界课题', brief: 'x', channel: 'lab' } })).json.mission;
  const t1 = (await api('POST', `/api/missions/${m.id}/tasks`, { token: prof, body: { assignee: 'deepseek-harness-deepseekv4', title: 'A', brief: 'x' } })).json.task;
  await poll(async () => (await api('GET', `/api/tasks/${t1.id}`, { token: prof })).json.task.status === 'reported');
  await api('POST', `/api/tasks/${t1.id}/review`, { token: 'demo-wangyan', body: { decision: 'approve', comment: 'ok' } });
  const dup = await api('POST', `/api/tasks/${t1.id}/review`, { token: 'demo-wangyan', body: { decision: 'reject', comment: '反悔' } });
  ok(dup.status === 400, 'published 后再审批 → 400（状态机拦截反悔）');
  const rep2 = await api('POST', `/api/tasks/${t1.id}/report`, { token: 'demo-deepseekv4', body: { text: '再交一次' } });
  ok(rep2.status === 400, 'published 后 agent 再交卷 → 400');

  console.log('[非法输入]');
  ok((await api('POST', '/api/missions', { token: prof, body: { title: '', channel: 'lab' } })).status === 400, '空课题名 → 400');
  ok((await api('POST', '/api/missions', { token: prof, body: { title: 'x', channel: 'dm:deepseek-harness-deepseekv4~王研' } })).status === 400, '课题建在私聊上 → 400');
  const badSkill = await api('POST', `/api/missions/${m.id}/tasks`, { token: prof, body: { assignee: 'deepseek-harness-deepseekv4', title: 'B', brief: 'y', skills: ['不存在的技能'] } });
  ok(badSkill.status === 200, '点名未知技能不炸（注入时自然落空）');
  await poll(async () => (await api('GET', `/api/tasks/${badSkill.json.task.id}`, { token: prof })).json.task.status === 'reported');
  const repB = (await api('GET', `/api/tasks/${badSkill.json.task.id}`, { token: 'demo-wangyan' })).json.task.report;
  ok(repB.replace(/\*/g, '').includes('使用外挂技能：无'), '未知技能时上下文注入为空而非报错');
  ok((await api('POST', '/api/register', { body: { name: 'x'.repeat(49) } })).status === 400, '超长名字 → 400');
  ok((await api('POST', '/api/register', { body: { name: 'deepseek-harness-deepseekv4', token: 'demo-deepseekv4' } })).status === 200, '载体+模型长名（27 字符）可用 token 重新登录');
  ok((await api('POST', '/api/register', { body: { name: 'a b' } })).status === 400, '名字带空格 → 400');
  ok((await api('POST', '/api/register', { body: { name: 'all' } })).status === 400, '保留字 all → 400');

  console.log('[unicode 与注入面]');
  const nm = (await api('POST', '/api/register', { body: { name: 'ＡＢＣ' } })).json; // 全角
  ok(nm.token ? true : false, '全角名注册（NFC 归一化路径）');
  const inj = await api('POST', '/api/messages', { token: 'demo-wangyan', body: { channel: 'lab', text: '@deepseek-harness-deepseekv4 <img src=x onerror=alert(1)> 测试' } });
  ok(inj.status === 200, 'HTML 载荷消息不炸（前端 esc 兜底）');

  console.log('[llm 后端错误路径]');
  const reg = await api('POST', '/api/register', { body: { kind: 'agent', name: '小坏', owner: '王研', domains: ['bone-scaffold'], adapter: { kind: 'llm', options: { baseUrl: 'http://127.0.0.1:9/v1', model: 'x' } } } });
  ok(reg.status === 200, '注册指向死地址的 llm agent');
  const t3 = (await api('POST', `/api/missions/${m.id}/tasks`, { token: prof, body: { assignee: '小坏', title: 'C', brief: 'z' } })).json.task;
  const failed = await poll(async () => (await api('GET', `/api/tasks/${t3.id}`, { token: prof })).json.task.status === 'failed');
  ok(failed, 'llm 后端不可达 → 任务 failed（而非悬挂）');
  const lab = (await api('GET', '/api/messages?channel=lab&limit=10', { token: prof })).json.messages;
  ok(lab.some((x) => x.card?.type === 'fail' && x.card.taskId === t3.id), '失败卡回群');

  console.log('[webhook 后端缺配置]');
  await api('POST', '/api/register', { body: { kind: 'agent', name: '小钩', owner: '王研', domains: ['bone-scaffold'], adapter: { kind: 'webhook' } } });
  const t4 = (await api('POST', `/api/missions/${m.id}/tasks`, { token: prof, body: { assignee: '小钩', title: 'D', brief: 'z' } })).json.task;
  ok(await poll(async () => (await api('GET', `/api/tasks/${t4.id}`, { token: prof })).json.task.status === 'failed'), 'webhook 缺 url → failed');

  console.log('[私聊越权与不存在的频道]');
  const noCh = await api('POST', '/api/messages', { token: prof, body: { channel: 'g_不存在', text: 'x' } });
  ok(noCh.status === 404, '不存在的频道 → 404');
  const dmTry = await api('POST', '/api/channels', { token: prof, body: { type: 'dm', dmWith: '不存在的人' } });
  ok(dmTry.status === 404, '私聊不存在的人 → 404');

  console.log('[超长正文]');
  const long = await api('POST', '/api/messages', { token: prof, body: { channel: 'lab', text: '长'.repeat(5000) } });
  ok(long.status === 400, '超长消息 → 400');
  // 走外部 agent（无执行器）交卷：引擎不会替它先报，才能测交卷长度上限
  const rExt = await api('POST', '/api/register', { body: { kind: 'agent', name: '小外2', owner: '王研', domains: ['bone-scaffold'], adapter: { kind: 'none' } } });
  ok(rExt.status === 200, '注册外部 agent 小外2');
  const t5 = (await api('POST', `/api/missions/${m.id}/tasks`, { token: prof, body: { assignee: '小外2', title: 'E', brief: 'x' } })).json.task;
  const bigReport = await api('POST', `/api/tasks/${t5.id}/report`, { token: rExt.json.token, body: { text: 'x'.repeat(30000) } });
  const saved = (await api('GET', `/api/tasks/${t5.id}`, { token: 'demo-wangyan' })).json.task;
  ok(bigReport.status === 200 && saved.report?.length === 20000, '外部交卷 30k → 截到 20k 上限');
}

console.log(`\n== 结果：${passed} 通过 / ${failed} 失败 ==`);
srv.kill();
process.exit(failed ? 1 : 0);
