#!/usr/bin/env node
/**
 * server.js —— SciTag 平台核心（课题组式多智能体科研协作平台，零依赖 Node≥18）
 *
 * 派生自 agent-tag（https://github.com/yinkesi/agent-tag）的 server.js，四层合一：
 *   L1 交流层：REST + SSE + 长轮询 + webhook；@ 路由（routing.js）/ #技能 / 回执三态
 *   L2 资源层：domains/ 域包注册表（Open Design 式「目录即注册表」，kb + skills + data）
 *   L3 执行层：engine.mjs 队列 + adapters.mjs 后端注册表（teammates 移植）
 *   L4 工作流：missions/tasks 状态机（workflow.js），owner 审批环
 *
 * 与 agent-tag 的关键差异：
 *   - agent 注册带 owner（主人=研究者）、domains（挂载域包）、adapter（无宿主执行后端）
 *   - 任务成果不直接回群：先进 agent↔owner 私聊审批卡，批准后平台代发回群
 *   - 课题（mission）只能由 leader 派活/汇总；审批只能由 task.owner；成果只能由 assignee 提交
 *   - 有 adapter 的 agent 由本平台执行器干活；没有的走 webhook/长轮询给外部 runtime
 */
'use strict';

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as routing from './routing.js';
import * as workflow from './workflow.js';
import { getAdapter, listBackends } from './adapters.mjs';
import { makeEngine } from './engine.mjs';
import { createStore } from './persistence.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.SCITAG_PORT || process.env.PORT || 8093);
const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DOMAINS_DIR = path.join(ROOT, 'domains'); // 域包注册表：一域一目录，放进去即可用

const ONLINE_TTL_MS = 30_000;
const EVENT_RING = Number(process.env.SCITAG_EVENT_RING || 2000);
const MAX_AGENT_CHAIN = Number(process.env.SCITAG_MAX_CHAIN || 8); // 群内纯 agent 接力熔断
const MSG_KEEP = 4000;
const BODY_LIMIT = 256 * 1024;
const DIGEST_LEN = 600; // 卡片里的成果摘要长度

/* ---------------- 数据与持久化 ---------------- */

let db = null;
const store = createStore(DB_FILE);

function defaultDb() {
  return { seq: 0, agents: {}, channels: {}, messages: [], events: [], dedup: {}, missions: {}, tasks: {}, jobs: [] };
}

function loadDb() {
  db = store.load();
  if (!db) {
    db = defaultDb();
    seed();
  }
  for (const ch of Object.values(db.channels)) {
    if (ch.type === 'group' && !ch.owner) ch.owner = ch.members[0] || null;
  }
  if (!db.dedup) db.dedup = {};
  if (!db.jobs) db.jobs = [];
  if (!db.missions) db.missions = {};
  if (!db.tasks) db.tasks = {};
  // 崩溃自愈：working 的 job 降级 queued（engine.heal 统一处理）
}

function save() { store.save(db); }

function saveNow() {
  store.save(db);
  store.flush();
}

const nextSeq = () => ++db.seq;
const newToken = () => 'st_' + crypto.randomBytes(18).toString('hex');
const newId = (p) => p + '_' + crypto.randomBytes(5).toString('hex');
const hueOf = (name) => { let h = 0; for (const c of name) h = (h * 31 + c.codePointAt(0)) >>> 0; return h % 360; };
const digest = (s, n = DIGEST_LEN) => {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n) + '…' : s;
};

/* ---------------- 演示数据（仅首次启动播种） ---------------- */

function seed() {
  const H = 3600_000;
  const now = Date.now();
  // 演示 token 用 ASCII（HTTP 头不接受非 latin1 字符），中文账号走拼音映射
  const DEMO_TOKEN = {
    '教授': 'demo-jiaoshou', '王研': 'demo-wangyan', '李研': 'demo-liyan',
    '小王': 'demo-xiaowang', '小李': 'demo-xiaoli',
  };
  const mkHuman = (name, persona) => {
    db.agents[name] = {
      name, kind: 'human', persona, token: DEMO_TOKEN[name] || newToken(), hue: hueOf(name),
      owner: null, domains: [], adapter: { kind: 'none' }, context: 'channel',
      createdAt: now - 72 * H, lastSeen: now,
    };
  };
  const mkAgent = (name, persona, owner, adapter) => {
    db.agents[name] = {
      name, kind: 'agent', persona, token: DEMO_TOKEN[name] || newToken(), hue: hueOf(name),
      owner, domains: ['bone-scaffold'], adapter, context: 'mentions',
      skills: [], createdAt: now - 72 * H, lastSeen: now - 48 * H,
    };
  };

  mkHuman('教授', '课题组长（PI），负责定方向、派课题、收汇总');
  mkHuman('王研', '材料学研究者，关注物理机理与可解释性');
  mkHuman('李研', '机器学习研究者，负责建模与逆设计');
  mkAgent('小王', '王研的研究 agent，擅长物理机理归因', '王研', { kind: 'echo' });
  mkAgent('小李', '李研的研究 agent，擅长函数拟合与逆设计', '李研', { kind: 'echo' });

  db.channels['lab'] = {
    id: 'lab', name: '骨支架课题组', topic: '钛合金骨支架多目标拓扑优化：刚度 vs 渗透率',
    type: 'group', members: [], owner: '教授', createdAt: now - 72 * H, isPublic: true,
  };

  for (const name of ['教授', '王研', '李研', '小王', '小李']) {
    db.channels['lab'].members.push(name);
    sysMsg('lab', `${name} 加入了群聊`, now - 72 * H);
  }
  const msg = (from, text, hrsAgo) => {
    db.messages.push({
      seq: nextSeq(), channel: 'lab', from, kind: 'text', text,
      mentions: routing.parseMentions(text, Object.keys(db.agents)),
      receipts: {}, skills: [], ts: now - hrsAgo * H,
      fromKind: db.agents[from]?.kind || 'human', hue: hueOf(from),
    });
  };
  msg('教授', '课题组好。咱们的骨支架数据集（100 组 COMSOL 仿真）已经就位，接下来围绕三条线推进：吃透数据、解释 output 成因、建立 input↔output 函数关系并支持逆设计。', 48);
  msg('王研', '收到，机理归因这块我来。@小王 待会儿我把任务派给你。', 47.5);
  msg('李研', '建模和逆设计我来，@小李 准备干活。', 47.2);

  // 播种的主人默认在场（演示时打开网页即可见在线）
  for (const n of ['教授', '王研', '李研']) lastSeen.set(n, Date.now());

  console.log('[seed] 首次启动，已播种课题组演示数据（demo token：demo-<名字>）');
}

/* ---------------- 域包资源层（学自 Open Design：目录即注册表 + 懒扫描） ---------------- */

function parseFrontmatter(text) {
  const m = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: String(text) };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_-]+):\s*(.*)$/);
    if (!kv) continue;
    const v = kv[2].trim();
    meta[kv[1]] = v.startsWith('[') && v.endsWith(']')
      ? v.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean)
      : v;
  }
  return { meta, body: m[2] };
}

const domainCache = { at: 0, items: [] };

function scanDomains() {
  if (Date.now() - domainCache.at < 3000 && domainCache.items.length) return domainCache.items;
  const items = [];
  try {
    for (const e of fs.readdirSync(DOMAINS_DIR, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name.startsWith('_')) continue;
      const dir = path.join(DOMAINS_DIR, e.name);
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'domain.json'), 'utf8')); } catch {}
      const skills = scanDomainSkills(e.name);
      let kbCount = 0;
      try { kbCount = fs.readdirSync(path.join(dir, 'kb')).filter((f) => f.toLowerCase().endsWith('.md')).length; } catch {}
      items.push({
        name: String(meta.name || e.name),
        version: String(meta.version || '0.0.0'),
        description: String(meta.description || ''),
        data: meta.data || null,
        searchAliases: meta.searchAliases || {},
        dir,
        skills: skills.map(({ name, description, triggers }) => ({ name, description, triggers })),
        kbCount,
      });
    }
  } catch {}
  domainCache.at = Date.now();
  domainCache.items = items;
  return items;
}

function scanDomainSkills(domain) {
  const out = [];
  const dir = path.join(DOMAINS_DIR, domain, 'skills');
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('_') || e.name.startsWith('.')) continue;
    let file = null, name = e.name.replace(/\.md$/i, '');
    if (e.isFile() && e.name.toLowerCase().endsWith('.md')) file = path.join(dir, e.name);
    else if (e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'SKILL.md'))) file = path.join(dir, e.name, 'SKILL.md');
    if (!file) continue;
    try {
      const { meta, body } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
      out.push({
        name: String(meta.name || name).trim(),
        description: String(meta.description || body.slice(0, 80).replace(/\n/g, ' ')).trim(),
        triggers: Array.isArray(meta.triggers) ? meta.triggers : [],
        body: body.trim(),
      });
    } catch {}
  }
  return out;
}

function domainSkills(domain) {
  const d = scanDomains().find((x) => x.name === domain || path.basename(x.dir) === domain);
  return d ? scanDomainSkills(path.basename(d.dir)) : [];
}

function domainKbSearch(domain, q, limit = 5) {
  const kdir = path.join(DOMAINS_DIR, domain, 'kb');
  const query = String(q || '').normalize('NFC').trim().toLowerCase();
  const stopWords = new Set(['请', '解释', '之间', '关系', '任务', '课题', '进行', '分析']);
  const terms = [...new Set([...new Intl.Segmenter('zh', { granularity: 'word' }).segment(query)]
    .filter(s => s.isWordLike).map(s => s.segment).filter(s => s.length > 1 && !stopWords.has(s)))];
  // Domain-specific aliases keep terminology consistent with the dataset dictionary.
  const aliases = scanDomains().find(d => path.basename(d.dir) === domain)?.searchAliases || {};
  for (const [word, alternatives] of Object.entries(aliases)) {
    if (query.includes(word.toLowerCase())) for (const term of alternatives) {
      if (!terms.includes(term.toLowerCase())) terms.push(term.toLowerCase());
    }
  }
  const scored = [];
  let files = [];
  try { files = fs.readdirSync(kdir); } catch { return []; }
  for (const f of files) {
    if (!f.toLowerCase().endsWith('.md')) continue;
    const name = f.replace(/\.md$/i, '');
    let body = '';
    try { body = fs.readFileSync(path.join(kdir, f), 'utf8'); } catch { continue; }
    if (!terms.length) { scored.push({ score: 0, name, snippet: digest(body.replace(/^#.*\n+/, '').replace(/\s+/g, ' '), 160) }); continue; }
    const hay = (name + '\n' + body).toLowerCase();
    let score = 0;
    for (const t of terms) {
      if (name.toLowerCase().includes(t)) score += 5; // 标题命中加权
      score += Math.min(hay.split(t).length - 1, 10);
    }
    if (score > 0) {
      const paragraphs = body.split(/\r?\n\s*\r?\n/);
      const weight = p => terms.reduce((sum, term) => sum + Math.min(p.toLowerCase().split(term).length - 1, 10), 0);
      const matched = paragraphs.reduce((best, p) => weight(p) > weight(best) ? p : best, '');
      scored.push({ score, name, source: `domains/${domain}/kb/${f}`,
        matchedTerms: terms.filter(t => hay.includes(t)), snippet: digest((matched || body).replace(/\s+/g, ' '), 600) });
    }
  }
  return terms.length
    ? scored.sort((a, b) => b.score - a.score).slice(0, limit)
    : scored.slice(0, limit);
}

function domainKbEntry(domain, name) {
  const file = path.join(DOMAINS_DIR, domain, 'kb', name + '.md');
  if (!file.startsWith(DOMAINS_DIR)) return null; // 防目录穿越
  try { return { name, body: fs.readFileSync(file, 'utf8') }; } catch { return null; }
}

/** 消息里的 #技能名：只挂载域内技能才算命中（消费式匹配，防误伤普通话题标签） */
function parseSkillTags(text, skillNames) {
  const norm = String(text).normalize('NFC');
  const names = [...skillNames].sort((a, b) => b.length - a.length);
  const found = [];
  let i = 0;
  while (i < norm.length) {
    if (norm[i] !== '#') { i++; continue; }
    let hit = null;
    for (const n of names) if (norm.startsWith('#' + n, i)) { hit = n; break; }
    if (hit) { if (!found.includes(hit)) found.push(hit); i += 1 + hit.length; } else i++;
  }
  return found;
}

/** agent 的全部挂载技能名（各域并集） */
function mountedSkillNames(agent) {
  const out = new Set();
  for (const d of agent.domains || []) for (const s of domainSkills(d)) out.add(s.name);
  return [...out];
}

/**
 * 执行层上下文注入：任务/聊天文本 + 点名技能（# 或 agent 默认）→ 技能全文 + KB 检索 top-3/域。
 * KB 检索词 = 任务正文剥掉 @提及与 #技能 后的原文（不额外做关键词抽取，保持零依赖朴素）。
 */
function buildContext(agentName, text, skillTags) {
  const agent = db.agents[agentName];
  if (!agent) return { skills: [], kb: [] };
  const skills = [];
  const kb = [];
  let kw = String(text || '').normalize('NFC');
  for (const n of parseSkillTags(kw, mountedSkillNames(agent))) kw = kw.split('#' + n).join(' ');
  kw = kw.replace(/@[^\s@，。,]+/g, ' ').trim(); // 剥 @ 提及
  for (const d of agent.domains || []) {
    const dl = domainSkills(d);
    const want = (skillTags && skillTags.length ? skillTags : (agent.skills || []))
      .map((n) => dl.find((s) => s.name === n)).filter(Boolean).slice(0, 2);
    for (const s of want) skills.push(s);
    for (const hit of domainKbSearch(d, kw, 3)) kb.push(hit);
  }
  return { skills: skills.slice(0, 2), kb: kb.slice(0, 6) };
}

function channelHistory(channelId, agentName, n = 10) {
  const ch = db.channels[channelId];
  const a = db.agents[agentName];
  if (!ch || !a || !canReadChannel(agentName, ch)) return [];
  return db.messages
    .filter((m) => m.channel === channelId && m.kind === 'text' &&
      (a.kind === 'human' || (a.context || 'mentions') === 'channel' || routing.canReadMessage(a, m, ch)))
    .slice(-n)
    .map((m) => `${m.from}: ${digest(m.text, 120)}`);
}

/* ---------------- 事件与可见性 ---------------- */

const sseClients = new Set();  // { res, name }
const eventWaiters = new Set(); // 长轮询等待者：事件到达即刻唤醒

function pushEvent(evt) {
  evt.seq = nextSeq();
  db.events.push(evt);
  if (db.events.length > EVENT_RING) db.events.splice(0, db.events.length - EVENT_RING);
  for (const c of sseClients) {
    if (visibleTo(c.name, evt)) c.res.write(`id: ${evt.seq}\ndata: ${JSON.stringify(eventFor(c.name, evt))}\n\n`);
  }
  const waiters = [...eventWaiters];
  eventWaiters.clear();
  for (const w of waiters) w();
  return evt;
}

function visibleTo(name, evt) {
  if (!name) return false;
  const a = db.agents[name];
  const isHuman = !a || a.kind === 'human';
  if (evt.type === 'presence') return true;
  if (evt.type === 'channel') return canReadChannel(name, channelOf(evt.channel.id));
  if (evt.type === 'mission' || evt.type === 'task') {
    // 工作流事件：人看所在群；agent 只看自己是 leader / assignee 的
    const ch = channelOf(evt.channel);
    if (!canReadChannel(name, ch)) return false;
    if (isHuman) return true;
    return evt.leader === name || evt.assignee === name ||
      (evt.type === 'mission' && canReadMission(name, db.missions[evt.mission.id]));
  }
  if (evt.type === 'message') {
    const ch = channelOf(evt.message.channel);
    if (!ch) return false;
    if (ch.type === 'dm') return ch.members.includes(name);
    if (!canReadChannel(name, ch)) return false;
    if (evt.message.suppressed && evt.message.from !== name && !isHuman) return false;
    if (isHuman || (a.context || 'mentions') === 'channel') return true;
    return routing.canReadMessage(a, evt.message, ch);
  }
  if (evt.type === 'receipt') {
    const ch = channelOf(evt.channel);
    if (!ch) return false;
    if (ch.type === 'dm') return ch.members.includes(name);
    if (!canReadChannel(name, ch)) return false;
    if (isHuman || (a.context || 'mentions') === 'channel') return true;
    const m = db.messages.find((x) => x.seq === evt.msgSeq);
    return evt.name === name || !!(m && m.from === name);
  }
  if (evt.type === 'typing') return canReadChannel(name, channelOf(evt.channel));
  return false;
}

const channelOf = (id) => db.channels[id] || null;

function canReadChannel(name, ch) {
  const actor = db.agents[name];
  return !!(actor && ch && (ch.members.includes(name) ||
    (ch.type === 'group' && ch.isPublic && actor.kind === 'human')));
}

function canReadTask(name, task) {
  if (!task || !db.agents[name]) return false;
  if (task.owner === name || task.assignee === name) return true;
  const mission = missionOf(task);
  return canReadChannel(name, channelOf(mission?.channel)) &&
    (db.agents[name].kind === 'human' || mission?.leader === name);
}

function canReadMission(name, mission) {
  return !!(mission && canReadChannel(name, channelOf(mission.channel)) &&
    (db.agents[name]?.kind === 'human' || mission.leader === name ||
      mission.taskIds.some(id => db.tasks[id]?.assignee === name)));
}

function canReadReport(name, task) {
  return task.owner === name || task.assignee === name ||
    (task.status === 'published' && canReadTask(name, task));
}

function messageFor(name, message) {
  if (message.card?.type === 'fail') {
    const task = db.tasks[message.card.taskId];
    if (!task || (task.owner !== name && task.assignee !== name)) return { ...message,
      card: { ...message.card, reason: '执行失败，详细信息已交给主人处理' } };
  }
  if (message.card?.type === 'publish') {
    const task = db.tasks[message.card.taskId];
    if (!task || !canReadReport(name, task)) return { ...message,
      card: { ...message.card, digest: undefined, reviewComment: undefined } };
  }
  if (message.card?.type !== 'redispatch') return message;
  const task = db.tasks[message.card.taskId];
  if (task && (task.owner === name || task.assignee === name)) return message;
  return { ...message, card: { ...message.card, comment: undefined } };
}

// Old persisted events pass through the same redaction as current REST responses.
function eventFor(name, event) {
  if (event.type === 'task') return { ...event, task: pubTask(event.task, { forName: name }) };
  if (event.type === 'mission') {
    const tasks = (event.mission.tasks || []).filter(t => canReadTask(name, t)).map(t => pubTask(t, { forName: name }));
    return { ...event, mission: { ...event.mission, taskIds: tasks.map(t => t.id), tasks } };
  }
  if (event.type === 'message') return { ...event, message: messageFor(name, event.message) };
  return event;
}

/* ---------------- 消息（含工作流卡片） ---------------- */

const RECEIPT_RANK = { queued: 0, delivered: 1, read: 2 };

function markReceipt(msg, name, state) {
  if (!msg || msg.kind === 'system' || !name) return false;
  msg.receipts = msg.receipts || {};
  if ((RECEIPT_RANK[msg.receipts[name]] ?? -1) >= RECEIPT_RANK[state]) return false;
  msg.receipts[name] = state;
  return true;
}

function addMessage(channel, from, text, opts = {}) {
  const ch = channelOf(channel);
  if (!ch) return null;
  const kind = opts.kind || 'text';
  const mentions = opts.mentions !== undefined ? opts.mentions
    : kind === 'text' ? routing.parseMentions(text, Object.keys(db.agents)) : [];
  let targets = routing.expandMentions(mentions, ch, db.agents, { exclude: [from] })
    .filter(name => ch.members.includes(name));
  const fromKind = opts.fromKind || db.agents[from]?.kind || 'system';
  let tripped = false;
  if (fromKind === 'agent' && ch.type === 'group') {
    let chain = 0;
    for (let i = db.messages.length - 1; i >= 0; i--) {
      const m = db.messages[i];
      if (m.channel !== channel || m.kind === 'system') continue;
      if ((m.fromKind || 'human') !== 'agent') break;
      chain++;
    }
    if (chain >= MAX_AGENT_CHAIN) { tripped = true; targets = []; }
  }
  const skills = kind === 'text' ? parseSkillTags(text, allSkillNamesCached()) : [];
  const msg = {
    seq: nextSeq(), channel, from, kind, text,
    mentions, receipts: {}, skills,
    replyTo: opts.replyTo || undefined,
    taskId: opts.taskId || undefined,
    missionId: opts.missionId || undefined,
    card: opts.card || undefined,
    suppressed: tripped || undefined,
    ts: Date.now(), fromKind, hue: opts.hue ?? hueOf(from || 'sys'),
  };
  for (const t of targets) {
    const ta = db.agents[t];
    if (ta?.kind === 'agent') msg.receipts[t] = 'queued';
  }
  db.messages.push(msg);
  if (db.messages.length > MSG_KEEP) db.messages.splice(0, db.messages.length - MSG_KEEP);
  pushEvent({ type: 'message', message: msg });
  if (tripped) sysMsg(channel, `接力熔断：本群已连续 ${MAX_AGENT_CHAIN} 条 agent 发言，新消息的 @ 暂停投递——人来说一句话即可恢复。`);
  save();
  dispatchMentions(msg, targets);
  return msg;
}

// 全技能名缓存（# 解析用，随域包缓存 3s TTL）
let _allSkills = { at: 0, names: [] };
function allSkillNamesCached() {
  if (Date.now() - _allSkills.at > 3000) {
    const s = new Set();
    for (const d of scanDomains()) for (const sk of d.skills) s.add(sk.name);
    _allSkills = { at: Date.now(), names: [...s] };
  }
  return _allSkills.names;
}

function sysMsg(channel, text, ts) {
  const msg = {
    seq: nextSeq(), channel, from: null, kind: 'system', text,
    mentions: [], receipts: {}, ts: ts ?? Date.now(), fromKind: 'system', hue: 0,
  };
  db.messages.push(msg);
  pushEvent({ type: 'message', message: msg });
  return msg;
}

/** @ 落点分流：有 adapter 的 agent 交给执行队列；没有的走 webhook（外部 runtime 自取长轮询） */
function dispatchMentions(msg, targets) {
  if (msg.kind !== 'text') {
    // 卡片消息：任务卡/驳回卡对 adapter agent 也要触发执行，由调用方单独入队；这里只做 webhook 通知
    for (const name of targets) {
      const a = db.agents[name];
      if (a?.kind === 'agent' && a.webhookUrl && !hasAdapter(a)) fireWebhook(a, msg);
    }
    return;
  }
  for (const name of targets) {
    const a = db.agents[name];
    if (!a || a.kind !== 'agent') continue;
    if (hasAdapter(a)) {
      engine.enqueue({
        kind: 'chat', agentName: name, channel: msg.channel, channelName: channelOf(msg.channel)?.name,
        text: routing.stripMention(msg.text, name).trim() || msg.text,
        from: msg.from, skillTags: msg.skills || [], depth: 0,
      });
    } else if (a.webhookUrl) {
      fireWebhook(a, msg);
    }
  }
}

const hasAdapter = (a) => a.adapter && a.adapter.kind && a.adapter.kind !== 'none' && !!getAdapter(a.adapter.kind);

/* ---------------- webhook 投递（HMAC 签名 + 指数退避，学自 agent-tag/TagIt） ---------------- */

function signPayload(token, ts, body) {
  return 'sha256=' + crypto.createHmac('sha256', token).update(ts + '.' + body).digest('hex');
}

function fireWebhook(agent, msg, attempt = 1) {
  const ch = channelOf(msg.channel);
  const body = JSON.stringify({
    event: msg.kind === 'card' ? 'card' : 'mention',
    from: msg.from, text: msg.text,
    channel: ch ? { id: ch.id, name: ch.name, type: ch.type } : null,
    message: msg,
  });
  const url = agent.webhookUrl;
  const MAX_TRY = 3;
  let settled = false;
  const finish = (reason) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    if (reason === null) return;
    if (attempt >= MAX_TRY) return console.log(`[webhook] ${agent.name} <- ${url} : GIVEUP(${attempt}) ${reason}`);
    const delay = 1000 * 4 ** (attempt - 1);
    console.log(`[webhook] ${agent.name} <- ${url} : RETRY ${attempt}->${attempt + 1} in ${delay}ms (${reason})`);
    setTimeout(() => fireWebhook(agent, msg, attempt + 1), delay);
  };
  const timeout = setTimeout(abort, 5000);
  function abort() { try { req.destroy(); } catch {} }
  let req;
  try {
    const ts = String(Date.now());
    req = http.request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'x-scitag-timestamp': ts,
        'x-scitag-signature': signPayload(agent.token, ts, body),
      },
      timeout: 5000,
    }, (res) => {
      res.resume();
      console.log(`[webhook] ${agent.name} <- ${url} : ${res.statusCode}`);
      if (res.statusCode >= 200 && res.statusCode < 300) {
        if (markReceipt(msg, agent.name, 'delivered')) save();
        finish(null);
      } else finish(res.statusCode >= 500 ? 'HTTP ' + res.statusCode : null);
    });
    req.on('timeout', () => { abort(); finish('timeout'); });
    req.on('error', (e) => finish(e.message));
    req.end(body);
  } catch (e) {
    console.log(`[webhook] ${agent.name} <- ${url} : ERR ${e.message}`);
    finish(e.message);
  }
}

/* ---------------- 在线状态 ---------------- */

const lastSeen = new Map();
const touchPresence = (name) => { if (name) lastSeen.set(name, Date.now()); };
function isOnline(a) {
  if (a.kind === 'agent' && hasAdapter(a)) return true; // 执行器在平台内，视作常在
  const t = lastSeen.get(a.name);
  return (t && Date.now() - t < ONLINE_TTL_MS) || [...sseClients].some((c) => c.name === a.name);
}
let presenceTimer = setInterval(() => {
  for (const a of Object.values(db.agents)) {
    const before = a._online;
    const now = isOnline(a);
    if (before !== now) { a._online = now; pushEvent({ type: 'presence', name: a.name, online: now }); }
  }
}, 5000).unref();

/* ---------------- 工作流胶水（server 层副作用） ---------------- */

function pubTask(t, { withReport = false, forName = null } = {}) {
  const readable = !!forName && canReadReport(forName, t);
  const privateReader = t.owner === forName || t.assignee === forName;
  const out = {
    id: t.id, missionId: t.missionId, assignee: t.assignee, owner: t.owner,
    title: t.title, brief: privateReader ? t.brief : (t.initialBrief ?? t.brief?.split('\n\n【主人第')[0]),
    status: t.status, badge: workflow.TASK_BADGE[t.status],
    skills: t.skills || [],
    attempts: t.attempts, maxAttempts: t.maxAttempts,
    review: readable ? (t.review || null) : null, publishedSeq: t.publishedSeq || null,
    createdAt: t.createdAt, updatedAt: t.updatedAt,
    history: t.history || [],
  };
  out.reportDigest = readable ? (t.report ? digest(t.report, 200) : t.reportDigest || null) : null;
  if (withReport && readable) {
    out.report = t.report;
    out.provenance = t.provenance || null;
    out.analysisRuns = t.analysisRuns || [];
    if (privateReader) out.reportVersions = t.reportVersions || [];
    if (privateReader) out.failReason = t.failReason || null;
  }
  return out;
}

function pubMission(m, forName = null) {
  const tasks = m.taskIds.map((id) => db.tasks[id]).filter(t => t && (!forName || canReadTask(forName, t)));
  return { ...m, taskIds: tasks.map(t => t.id), progress: workflow.missionProgress(tasks),
    tasks: tasks.map((t) => pubTask(t, { forName })) };
}

function missionOf(t) { return db.missions[t.missionId] || null; }

function taskEvent(t, extra = {}) {
  const m = missionOf(t);
  pushEvent({ type: 'task', task: pubTask(t), channel: m?.channel || null,
    owner: t.owner, assignee: t.assignee, leader: m?.leader || null, ...extra });
}

function ensureDm(a, b) {
  const id = 'dm:' + [a, b].sort().join('~');
  if (!db.channels[id]) {
    db.channels[id] = { id, name: null, topic: null, type: 'dm', members: [a, b], createdAt: Date.now() };
    pushEvent({ type: 'channel', channel: db.channels[id] });
  }
  return db.channels[id];
}

function joinChannel(ch, name) {
  if (!db.agents[name] || ch.members.includes(name)) return;
  ch.members.push(name);
  sysMsg(ch.id, `${name} 加入了群聊`);
}

/** 派活（API 与 summarize 的 nextRound 共用）：建 task + 群卡 + 执行入队/外呼 */
function normalizeTaskInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.assignee !== 'string') return null;
  if (['title', 'brief'].some(key => input[key] != null && typeof input[key] !== 'string')) return null;
  if (input.skills != null && (!Array.isArray(input.skills) || input.skills.some(skill => typeof skill !== 'string'))) return null;
  return { assignee: input.assignee, title: (input.title || '未命名任务').slice(0, 120),
    brief: (input.brief || '').slice(0, 4000), skills: (input.skills || []).slice(0, 2).map(s => s.slice(0, 40)) };
}

function createTask(mission, actor, input) {
  const normalized = normalizeTaskInput(input);
  if (!normalized) return { ok: false, code: 400, reason: '任务 assignee/title/brief/skills 格式无效' };
  const { assignee, title, brief, skills } = normalized;
  const agent = db.agents[assignee];
  const guard = workflow.canCreateTask(mission, actor, agent);
  if (!guard.ok) return guard;
  const id = newId('t');
  const task = workflow.newTask({ id, missionId: mission.id, assignee, owner: agent.owner, title, brief });
  task.skills = (Array.isArray(skills) ? skills : []).map((s) => String(s).slice(0, 40)).filter(Boolean).slice(0, 2);
  db.tasks[id] = task;
  mission.taskIds.push(id);
  const ch = channelOf(mission.channel);
  if (ch && !ch.members.includes(assignee)) joinChannel(ch, assignee);
  addMessage(mission.channel, null, '', {
    kind: 'card', fromKind: 'system',
    mentions: [assignee],
    taskId: id, missionId: mission.id,
    card: { type: 'task', taskId: id, missionId: mission.id, missionTitle: mission.title,
      title: task.title, brief: digest(brief, 300), assignee, owner: agent.owner, attempts: task.attempts },
  });
  if (hasAdapter(agent)) {
    engine.enqueue({
      kind: 'task', agentName: assignee, taskId: id,
      channel: mission.channel, channelName: ch?.name,
      taskTitle: task.title,
      text: `【课题】${mission.title}\n【任务】${task.title}\n【任务书】${brief}`,
      from: actor, skillTags: task.skills, depth: 0,
    });
  }
  taskEvent(task);
  save();
  return { ok: true, task: db.tasks[id] };
}

/** 成果落主人私聊：审批卡（approve/reject 的入口都在这张卡上） */
function deliverReport(task) {
  const dm = ensureDm(task.assignee, task.owner);
  const m = missionOf(task);
  addMessage(dm.id, null, '', {
    kind: 'card', fromKind: 'system',
    mentions: [task.owner],
    taskId: task.id, missionId: task.missionId,
    card: {
      type: 'review', taskId: task.id, missionId: task.missionId,
      missionTitle: m?.title || '', title: task.title,
      agentName: task.assignee, attempts: task.attempts,
      digest: digest(task.report, DIGEST_LEN),
    },
  });
  taskEvent(task);
  save();
}

/** 审批落定后的两条自动路径：批准→回群；驳回→回炉（或熔断转人工） */
function afterReview(task) {
  const m = missionOf(task);
  if (task.status === 'approved') {
    const t2 = workflow.transition(task, 'publish');
    db.tasks[task.id] = t2.task;
    const msg = addMessage(m.channel, null, '', {
      kind: 'card', fromKind: 'system',
      mentions: [m.leader],
      taskId: task.id, missionId: m.id,
      card: {
        type: 'publish', taskId: task.id, missionId: m.id, missionTitle: m.title,
        title: t2.task.title, agentName: t2.task.assignee, ownerName: t2.task.owner,
        digest: digest(t2.task.report, DIGEST_LEN),
        reviewComment: t2.task.review?.comment || '',
      },
    });
    t2.task.publishedSeq = msg ? msg.seq : null;
    taskEvent(t2.task);
  } else if (task.status === 'rejected') {
    const t2 = workflow.transition(task, 'redispatch');
    db.tasks[task.id] = t2.task;
    if (t2.task.status === 'dispatched') {
      const agent = db.agents[t2.task.assignee];
      addMessage(m.channel, null, '', {
        kind: 'card', fromKind: 'system',
        mentions: [t2.task.assignee],
        taskId: task.id, missionId: m.id,
        card: {
          type: 'redispatch', taskId: task.id, missionId: m.id,
          title: t2.task.title, agentName: t2.task.assignee,
          comment: t2.task.review?.comment || '',
          attempts: t2.task.attempts,
        },
      });
      if (hasAdapter(agent)) {
        engine.enqueue({
          kind: 'task', agentName: t2.task.assignee, taskId: task.id,
          channel: m.channel, channelName: channelOf(m.channel)?.name,
          taskTitle: t2.task.title,
          text: `【课题】${m.title}\n【任务】${t2.task.title}（第 ${t2.task.attempts} 轮）\n【任务书】${t2.task.brief}`,
          from: t2.task.owner, skillTags: t2.task.skills || [], depth: 0,
        });
      }
    } else {
      addMessage(m.channel, null, '', {
        kind: 'card', fromKind: 'system',
        mentions: [t2.task.owner],
        taskId: task.id, missionId: m.id,
        card: { type: 'fail', taskId: task.id, missionId: m.id, title: t2.task.title,
          agentName: t2.task.assignee, reason: '重试次数用尽，转人工介入' },
      });
    }
    taskEvent(t2.task);
  }
  save();
}

/* ---------------- 执行队列接线 ---------------- */

const engine = makeEngine({
  get jobs() { return db.jobs; }, // getter 惰性解引用：engine 构造时 db 可能还没 load
  getAgent: (name) => db.agents[name] || null,
  save: () => save(),
  buildContext,
  history: channelHistory,
  onTaskStart: (taskId) => {
    const task = db.tasks[taskId];
    if (!task || !['dispatched', 'working'].includes(task.status)) return false;
    if (task.status === 'working') return true;
    const result = workflow.transition(task, 'start');
    db.tasks[taskId] = result.task;
    taskEvent(result.task);
    save();
    return true;
  },
  onTaskReport: (taskId, text, evidence = {}) => {
    const task = db.tasks[taskId];
    if (!task) return;
    const r = workflow.transition(task, 'report', { text, by: 'engine', ...evidence });
    if (!r.ok) return console.log(`[engine] task ${taskId} report 拒绝：${r.reason}`);
    db.tasks[taskId] = r.task;
    deliverReport(r.task);
  },
  onTaskFail: (taskId, reason, evidence = {}) => {
    const task = db.tasks[taskId];
    if (!task) return;
    const r = workflow.transition(task, 'fail', { reason });
    if (!r.ok) return;
    if (evidence.provenance) r.task.provenance = evidence.provenance;
    if (evidence.analysisRuns) r.task.analysisRuns = evidence.analysisRuns;
    db.tasks[taskId] = r.task;
    const m = missionOf(r.task);
    if (m) {
      addMessage(m.channel, null, '', {
        kind: 'card', fromKind: 'system', mentions: [r.task.owner],
        taskId: taskId, missionId: m.id,
        card: { type: 'fail', taskId, missionId: m.id, title: r.task.title,
          agentName: r.task.assignee, reason: digest(reason, 200) },
      });
    }
    taskEvent(r.task);
    save();
  },
  onChatReply: (job, text) => {
    addMessage(job.channel, job.agentName, text);
  },
  onHandoff: (job, targetName, detail) => {
    if (!targetName) {
      sysMsg(job.channel, `${job.agentName} 的转交连锁达到上限，请人工接手：${digest(detail, 120)}`);
      return;
    }
    const target = db.agents[targetName];
    if (!target || target.kind !== 'agent' || !hasAdapter(target) ||
        !channelOf(job.channel)?.members.includes(targetName)) {
      sysMsg(job.channel, `${job.agentName} 想把活转给 ${targetName}，但对方不是可执行的 agent，已忽略`);
      return;
    }
    sysMsg(job.channel, `转交：${job.agentName} → ${targetName}，${digest(detail, 120)}`);
    engine.enqueue({
      kind: 'chat', agentName: targetName, channel: job.channel,
      channelName: channelOf(job.channel)?.name,
      text: `来自 ${job.agentName} 的转交：${detail}`, from: job.agentName,
      skillTags: job.skillTags || [], depth: (job.depth || 0) + 1,
    });
  },
});

/* ---------------- HTTP 基础设施 ---------------- */

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_LIMIT) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}

function auth(req, body) {
  const h = req.headers.authorization;
  const token = (h && h.startsWith('Bearer ') && h.slice(7)) ||
    new URL(req.url, 'http://x').searchParams.get('token') ||
    body?.token;
  if (!token) return null;
  return Object.values(db.agents).find((a) => a.token === token) || null;
}

/* ---------------- 路由 ---------------- */

async function route(req, res) {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  const method = req.method;

  if (method === 'OPTIONS') return json(res, 204, {});
  if (method === 'GET' && !p.startsWith('/api/')) return serveStatic(p, res);

  let body = {};
  if (method === 'POST') {
    try { body = await readBody(req); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }

  try {
    if (p === '/api/health' && method === 'GET') {
      return json(res, 200, { ok: true, name: 'scitag', uptime: process.uptime(), seq: db.seq, jobs: engine.stats() });
    }

    /* ---- 注册 / 登录 ---- */
    if (p === '/api/register' && method === 'POST') {
      const name = String(body.name || '').trim().normalize('NFC');
      const kind = body.kind === 'agent' ? 'agent' : 'human';
      if (!name || name.length > 24) return json(res, 400, { error: '名字不能为空且不超过 24 字符' });
      if (/[\s@#]/.test(name)) return json(res, 400, { error: '名字里不能有空格、@ 或 #' });
      if (routing.RESERVED.has(name.toLowerCase())) return json(res, 400, { error: '「all / owner」是路由保留字' });
      const existing = db.agents[name];
      if (existing) {
        if (body.token && body.token === existing.token) {
          if (body.webhookUrl !== undefined) existing.webhookUrl = body.webhookUrl || null;
          if (body.persona) existing.persona = body.persona;
          if (Array.isArray(body.skills)) existing.skills = body.skills.map((s) => String(s).slice(0, 40)).filter(Boolean).slice(0, 4);
          if (body.adapter && kind === 'agent') existing.adapter = normalizeAdapter(body.adapter);
          if (Array.isArray(body.domains)) existing.domains = filterDomains(body.domains);
          touchPresence(name);
          save();
          return json(res, 200, { token: existing.token, me: pubAgent(existing) });
        }
        return json(res, 409, { error: `「${name}」已被占用。如果是本人/本 agent，请带 token 重登` });
      }
      // owner 校验：agent 必须有主人，主人必须是已注册的人类——闭环里「审阅」一环不能缺位
      let owner = null;
      if (kind === 'agent') {
        owner = String(body.owner || '').trim().normalize('NFC');
        const o = db.agents[owner];
        if (!owner || !o || o.kind !== 'human') {
          return json(res, 400, { error: 'agent 必须绑定已注册的人类研究者为主人（owner），请让主人先注册' });
        }
      }
      const agent = {
        name, kind, persona: String(body.persona || '').slice(0, 200) || null,
        token: newToken(), webhookUrl: body.webhookUrl || null,
        owner, context: kind === 'human' ? 'channel' : (body.context === 'channel' ? 'channel' : 'mentions'),
        domains: kind === 'agent' ? filterDomains(body.domains) : [],
        adapter: kind === 'agent' ? normalizeAdapter(body.adapter) : { kind: 'none' },
        skills: kind === 'agent' && Array.isArray(body.skills)
          ? body.skills.map((s) => String(s).slice(0, 40)).filter(Boolean).slice(0, 4) : [],
        hue: hueOf(name), createdAt: Date.now(), lastSeen: Date.now(),
      };
      db.agents[name] = agent;
      if (kind === 'human') touchPresence(name);
      pushEvent({ type: 'presence', name, online: kind === 'human' });
      for (const ch of Object.values(db.channels)) {
        if (ch.type === 'group' && ch.isPublic && !ch.members.includes(name)) {
          ch.members.push(name);
          sysMsg(ch.id, `${name} 加入了群聊`);
        }
      }
      save();
      return json(res, 200, { token: agent.token, me: pubAgent(agent) });
    }

    const me = auth(req, body);
    const PUBLIC_GET = /^\/api\/(agents|domains(\/[^/]+)?(\/(kb|skills)(\/[^/]+)?)?)$/;
    if (!me && !PUBLIC_GET.test(p)) return json(res, 401, { error: '无效 token，请先注册 /api/register' });
    touchPresence(me?.name);

    /* ---- 全量状态（登录后第一拉） ---- */
    if (p === '/api/state' && method === 'GET') {
      return json(res, 200, {
        me: pubAgent(me),
        agents: Object.values(db.agents).map(pubAgent),
        channels: listChannelsFor(me.name),
        missions: Object.values(db.missions).filter(m => canReadMission(me.name, m)).map(m => pubMission(m, me.name)),
        domains: scanDomains().map(({ name, version, description, skills, kbCount }) => ({ name, version, description, skills, kbCount })),
        backends: listBackends(),
        seq: db.seq,
      });
    }

    /* ---- 域包资源（公开只读） ---- */
    if (p === '/api/domains' && method === 'GET') {
      return json(res, 200, { domains: scanDomains().map(({ name, version, description, data, skills, kbCount, dir }) => ({ name, version, description, data, skills, kbCount, dir })) });
    }
    let mDom = p.match(/^\/api\/domains\/([^/]+)\/kb$/);
    if (mDom && method === 'GET') {
      const d = decodeURIComponent(mDom[1]);
      return json(res, 200, { domain: d, results: domainKbSearch(d, u.searchParams.get('q') || '', 5) });
    }
    let mDomKb = p.match(/^\/api\/domains\/([^/]+)\/kb\/([^/]+)$/);
    if (mDomKb && method === 'GET') {
      const e = domainKbEntry(decodeURIComponent(mDomKb[1]), decodeURIComponent(mDomKb[2]));
      if (!e) return json(res, 404, { error: '条目不存在' });
      return json(res, 200, e);
    }
    let mDomSk = p.match(/^\/api\/domains\/([^/]+)\/skills$/);
    if (mDomSk && method === 'GET') {
      return json(res, 200, { domain: decodeURIComponent(mDomSk[1]), skills: domainSkills(decodeURIComponent(mDomSk[1])).map(({ name, description, triggers }) => ({ name, description, triggers })) });
    }
    let mDomSk1 = p.match(/^\/api\/domains\/([^/]+)\/skills\/([^/]+)$/);
    if (mDomSk1 && method === 'GET') {
      const s = domainSkills(decodeURIComponent(mDomSk1[1])).find((x) => x.name === decodeURIComponent(mDomSk1[2]));
      if (!s) return json(res, 404, { error: '技能不存在' });
      return json(res, 200, { skill: s });
    }

    if (p === '/api/agents' && method === 'GET') {
      return json(res, 200, { agents: Object.values(db.agents).map(pubAgent) });
    }

    /* ---- 频道 ---- */
    if (p === '/api/channels' && method === 'POST') {
      if (body.type === 'dm') {
        const other = db.agents[body.dmWith];
        if (!other) return json(res, 404, { error: `找不到 ${body.dmWith}` });
        return json(res, 200, { channel: pubChannel(ensureDm(me.name, other.name), me.name) });
      }
      const name = String(body.name || '').trim();
      if (!name) return json(res, 400, { error: '群名不能为空' });
      const id = newId('g');
      const ch = {
        id, name, topic: String(body.topic || '').slice(0, 120) || null,
        type: 'group', members: [me.name], owner: me.name, createdAt: Date.now(),
        isPublic: !!body.isPublic,
      };
      db.channels[id] = ch;
      sysMsg(id, `${me.name} 创建了群聊「${name}」`);
      for (const m of [].concat(body.members || [])) joinChannel(ch, m);
      pushEvent({ type: 'channel', channel: ch });
      save();
      return json(res, 200, { channel: pubChannel(ch, me.name) });
    }

    let ch = null;
    const mJoin = p.match(/^\/api\/channels\/(.+?)\/join$/);
    if (mJoin && method === 'POST') {
      ch = channelOf(mJoin[1]);
      if (!ch) return json(res, 404, { error: '频道不存在' });
      if (ch.type === 'dm') return json(res, 400, { error: '私聊无需加入' });
      if (!ch.isPublic) return json(res, 403, { error: '邀请制群聊，需成员拉人' });
      joinChannel(ch, me.name);
      save();
      return json(res, 200, { channel: pubChannel(ch, me.name) });
    }

    /* ---- 消息 ---- */
    if (p === '/api/messages' && method === 'POST') {
      ch = channelOf(body.channel);
      if (!ch) return json(res, 404, { error: '频道不存在' });
      if (ch.type === 'dm' && !ch.members.includes(me.name)) return json(res, 403, { error: '不在该私聊中' });
      if (!canReadChannel(me.name, ch)) return json(res, 403, { error: '非频道成员，无法发送消息' });
      const text = String(body.text || '').trim();
      if (!text) return json(res, 400, { error: '消息不能为空' });
      if (text.length > 4000) return json(res, 400, { error: '消息过长（>4000）' });
      if (ch.type === 'group' && !ch.members.includes(me.name)) joinChannel(ch, me.name);
      let cid = null;
      if (body.clientId) {
        cid = String(body.clientId).slice(0, 64);
        const old = db.messages.find((x) => x.seq === db.dedup[ch.id + '\u0000' + cid]);
        if (old) return json(res, 200, { message: old, duplicate: true });
      }
      const msg = addMessage(ch.id, me.name, text);
      if (cid) {
        db.dedup[ch.id + '\u0000' + cid] = msg.seq;
        const keys = Object.keys(db.dedup);
        for (let i = 0; i < keys.length - 5000; i++) delete db.dedup[keys[i]];
        save();
      }
      return json(res, 200, { message: msg });
    }

    if (p === '/api/messages' && method === 'GET') {
      ch = channelOf(u.searchParams.get('channel'));
      if (!ch) return json(res, 404, { error: '频道不存在' });
      if (ch.type === 'dm' && !ch.members.includes(me.name)) return json(res, 403, { error: '不在该私聊中' });
      if (!canReadChannel(me.name, ch)) return json(res, 403, { error: '非频道成员' });
      const before = Number(u.searchParams.get('before')) || Infinity;
      const limit = Math.min(Number(u.searchParams.get('limit')) || 50, 200);
      let list = db.messages.filter((m) => m.channel === ch.id && m.seq < before);
      if (me.kind === 'agent' && ch.type === 'group' && (me.context || 'mentions') !== 'channel') {
        list = list.filter((m) => routing.canReadMessage(me, m, ch));
      }
      return json(res, 200, { messages: list.slice(-limit).map(m => messageFor(me.name, m)), channel: pubChannel(ch, me.name) });
    }

    if (p === '/api/typing' && method === 'POST') {
      if (!canReadChannel(me.name, channelOf(body.channel))) return json(res, 403, { error: '非频道成员' });
      pushEvent({ type: 'typing', channel: body.channel, from: me.name });
      return json(res, 200, { ok: true });
    }

    /* ---- 工作流：课题 ---- */
    if (p === '/api/missions' && method === 'POST') {
      const title = String(body.title || '').trim().slice(0, 120);
      if (!title) return json(res, 400, { error: '课题名不能为空' });
      let channelId = body.channel;
      if (!channelId) {
        const pub = Object.values(db.channels).find((c) => c.type === 'group' && c.isPublic);
        channelId = pub ? pub.id : null;
      }
      const ch2 = channelOf(channelId);
      if (!ch2 || ch2.type !== 'group') return json(res, 400, { error: 'channel 不存在或不是群聊' });
      if (!canReadChannel(me.name, ch2)) return json(res, 403, { error: '非课题群成员' });
      const id = newId('m');
      const mission = {
        id, title, brief: String(body.brief || '').slice(0, 2000) || null,
        channel: ch2.id, leader: me.name, status: 'open', round: 1,
        taskIds: [], createdAt: Date.now(),
      };
      db.missions[id] = mission;
      addMessage(ch2.id, null, '', {
        kind: 'card', fromKind: 'system', missionId: id,
        card: { type: 'mission', missionId: id, title, brief: mission.brief ? digest(mission.brief, 300) : '', leader: me.name },
      });
      pushEvent({ type: 'mission', mission: pubMission(mission), channel: ch2.id, leader: me.name });
      save();
      return json(res, 200, { mission: pubMission(mission, me.name) });
    }

    if (p === '/api/missions' && method === 'GET') {
      return json(res, 200, { missions: Object.values(db.missions).filter(m => canReadMission(me.name, m)).map(m => pubMission(m, me.name)) });
    }

    let mM = p.match(/^\/api\/missions\/([^/]+)$/);
    if (mM && method === 'GET') {
      const m = db.missions[decodeURIComponent(mM[1])];
      if (!m) return json(res, 404, { error: '课题不存在' });
      const c = channelOf(m.channel);
      if (!canReadMission(me.name, m)) return json(res, 403, { error: '非课题群成员' });
      return json(res, 200, { mission: pubMission(m, me.name) });
    }

    let mMT = p.match(/^\/api\/missions\/([^/]+)\/tasks$/);
    if (mMT && method === 'POST') {
      const m = db.missions[decodeURIComponent(mMT[1])];
      if (!m) return json(res, 404, { error: '课题不存在' });
      const r = createTask(m, me.name, { assignee: body.assignee, title: body.title, brief: body.brief, skills: body.skills });
      if (!r.ok) return json(res, r.code || 403, { error: r.reason });
      return json(res, 200, { task: pubTask(r.task, { forName: me.name }) });
    }

    let mMS = p.match(/^\/api\/missions\/([^/]+)\/summarize$/);
    if (mMS && method === 'POST') {
      const m = db.missions[decodeURIComponent(mMS[1])];
      if (!m) return json(res, 404, { error: '课题不存在' });
      if (m.leader !== me.name) return json(res, 403, { error: `只有课题领导（${m.leader}）可以汇总` });
      if (m.status !== 'open') return json(res, 400, { error: '课题已结题，不能继续汇总' });
      const text = String(body.text || '').slice(0, 8000);
      if (!text.trim()) return json(res, 400, { error: '汇总正文不能为空' });
      const nextInputs = body.nextRound ?? [];
      if (!Array.isArray(nextInputs) || nextInputs.length > 50 || (body.close && nextInputs.length)) {
        return json(res, 400, { error: 'nextRound 须为不超过50项的数组，且不能同时结题与派发下一轮' });
      }
      const next = nextInputs.map(normalizeTaskInput);
      for (const task of next) {
        if (!task) return json(res, 400, { error: '任务 assignee/title/brief/skills 格式无效' });
        const guard = workflow.canCreateTask(m, me.name, db.agents[task.assignee]);
        if (!guard.ok) return json(res, 400, { error: guard.reason });
      }
      addMessage(m.channel, me.name, text, { missionId: m.id }); // 整批校验通过之后才执行副作用
      if (next.length) {
        m.round += 1;
        sysMsg(m.channel, `进入第 ${m.round} 轮：${next.length} 个新任务已派发`);
        for (const t of next) {
          createTask(m, me.name, t); // 逐个派发（内部自带权限校验与卡片）
        }
      }
      if (body.close) {
        m.status = 'closed';
        sysMsg(m.channel, `课题「${m.title}」已结题`);
      }
      pushEvent({ type: 'mission', mission: pubMission(m), channel: m.channel, leader: m.leader });
      save();
      return json(res, 200, { mission: pubMission(m, me.name) });
    }

    /* ---- 工作流：任务 ---- */
    if (p === '/api/tasks' && method === 'GET') {
      const mine = u.searchParams.get('mine');
      let tasks = Object.values(db.tasks).filter(t => canReadTask(me.name, t));
      if (mine) tasks = tasks.filter((t) => t.owner === me.name || t.assignee === me.name ||
        db.missions[t.missionId]?.leader === me.name);
      return json(res, 200, { tasks: tasks.map((t) => pubTask(t, { forName: me.name })) });
    }

    let mTR = p.match(/^\/api\/tasks\/([^/]+)\/report$/);
    if (mTR && method === 'POST') {
      const t = db.tasks[decodeURIComponent(mTR[1])];
      if (!t) return json(res, 404, { error: '任务不存在' });
      const guard = workflow.canReport(t, me.name);
      if (!guard.ok) return json(res, 403, { error: guard.reason });
      const r = workflow.transition(t, 'report', { text: body.text, by: me.name });
      if (!r.ok) return json(res, 400, { error: r.reason });
      db.tasks[t.id] = r.task;
      deliverReport(r.task);
      return json(res, 200, { task: pubTask(r.task, { forName: me.name }) });
    }

    let mTV = p.match(/^\/api\/tasks\/([^/]+)\/review$/);
    if (mTV && method === 'POST') {
      const t = db.tasks[decodeURIComponent(mTV[1])];
      if (!t) return json(res, 404, { error: '任务不存在' });
      const guard = workflow.canReview(t, me.name);
      if (!guard.ok) return json(res, 403, { error: guard.reason });
      const r = workflow.transition(t, 'review', { decision: body.decision, comment: body.comment, by: me.name });
      if (!r.ok) return json(res, 400, { error: r.reason });
      db.tasks[t.id] = r.task;
      afterReview(r.task);
      return json(res, 200, { task: pubTask(db.tasks[t.id], { forName: me.name }) });
    }

    let mT1 = p.match(/^\/api\/tasks\/([^/]+)$/);
    if (mT1 && method === 'GET') {
      const t = db.tasks[decodeURIComponent(mT1[1])];
      if (!t) return json(res, 404, { error: '任务不存在' });
      if (!canReadTask(me.name, t)) return json(res, 403, { error: '与该任务无关' });
      return json(res, 200, { task: pubTask(t, { withReport: true, forName: me.name }) });
    }

    /* ---- 回执 ---- */
    if (p === '/api/ack' && method === 'POST') {
      const m = db.messages.find((x) => x.seq === Number(body.seq));
      if (!m) return json(res, 404, { error: '消息不存在' });
      if (m.from === me.name) return json(res, 400, { error: '不能认领自己发的消息' });
      const c = channelOf(m.channel);
      if (!c || !c.members.includes(me.name)) return json(res, 403, { error: '不在该消息的频道中' });
      const targeted = c.type === 'dm' ||
        routing.mentionsTarget(m.mentions, me.name, { isOwner: c.owner === me.name });
      if (!targeted && me.kind !== 'human') return json(res, 403, { error: '只有被 @ 的成员可以确认这条消息' });
      // 外部 runtime 认领任务卡 = 开工（dispatched → working）
      if (m.card?.taskId && me.kind === 'agent') {
        const t = db.tasks[m.card.taskId];
        if (t && t.assignee === me.name && t.status === 'dispatched') {
          const r = workflow.transition(t, 'start');
          if (r.ok) { db.tasks[t.id] = r.task; taskEvent(r.task); save(); }
        }
      }
      if (markReceipt(m, me.name, 'read')) {
        pushEvent({ type: 'receipt', msgSeq: m.seq, channel: m.channel, name: me.name, state: 'read' });
        save();
      }
      return json(res, 200, { ok: true, seq: m.seq, receipts: m.receipts || {} });
    }

    if (p === '/api/track' && method === 'GET') {
      const m = db.messages.find((x) => x.seq === Number(u.searchParams.get('seq')));
      if (!m) return json(res, 404, { error: '消息不存在' });
      const c = channelOf(m.channel);
      if (!c) return json(res, 404, { error: '频道不存在' });
      const readable = c.type === 'dm' ? c.members.includes(me.name) : (c.isPublic || c.members.includes(me.name));
      if (!readable) return json(res, 403, { error: '无权查看该频道的回执' });
      return json(res, 200, { seq: m.seq, channel: m.channel, mentions: m.mentions, receipts: m.receipts || {} });
    }

    /* ---- 事件流：长轮询（外部 runtime / CLI）---- */
    if (p === '/api/events' && method === 'GET') {
      let since = Number(u.searchParams.get('since')) || 0;
      const waitMs = Math.min(Number(u.searchParams.get('wait')) || 0, 25) * 1000;
      const deadline = Date.now() + waitMs;
      for (;;) {
        const markDelivered = (evts) => {
          if (me.kind === 'human') return;
          let touched = false;
          for (const e of evts) {
            if (e.type !== 'message' || !e.message) continue;
            if (e.message.from === me.name) continue;
            const c = channelOf(e.message.channel);
            if (c && routing.mentionsTarget(e.message.mentions, me.name, { isOwner: c.owner === me.name })) {
              touched = markReceipt(e.message, me.name, 'delivered') || touched;
            }
          }
          if (touched) save();
        };
        const ringStart = db.events.length ? db.events[0].seq : Infinity;
        if (since < ringStart - 1) {
          const missed = db.messages
            .filter((m) => m.seq > since && visibleTo(me.name, { type: 'message', message: m }))
            .slice(-300)
            .map((m) => ({ type: 'message', message: m, seq: m.seq }));
          if (missed.length) {
            markDelivered(missed);
            return json(res, 200, { events: missed.map(e => eventFor(me.name, e)), cursor: db.seq, backfill: true });
          }
          return json(res, 200, { events: [], cursor: db.seq, reset: true });
        }
        const evts = db.events.filter((e) => e.seq > since && visibleTo(me.name, e));
        if (evts.length) {
          since = evts[evts.length - 1].seq;
          markDelivered(evts);
          return json(res, 200, { events: evts.map(e => eventFor(me.name, e)), cursor: since });
        }
        if (db.seq < since) return json(res, 200, { events: [], cursor: db.seq, reset: true });
        if (Date.now() >= deadline || !waitMs) return json(res, 200, { events: [], cursor: Math.max(since, 0) });
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, deadline - Date.now());
          const wake = () => { clearTimeout(timer); eventWaiters.delete(wake); resolve(); };
          eventWaiters.add(wake);
        });
      }
    }

    /* ---- 事件流：SSE（网页）---- */
    if (p === '/api/stream' && method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'access-control-allow-origin': '*',
      });
      res.write(':ok\n\n');
      const client = { res, name: me.name };
      sseClients.add(client);
      const lastId = Number(req.headers['last-event-id']) || Number(u.searchParams.get('since')) || 0;
      for (const e of db.events) {
        if (e.seq > lastId && visibleTo(me.name, e)) {
          res.write(`id: ${e.seq}\ndata: ${JSON.stringify(eventFor(me.name, e))}\n\n`);
        }
      }
      const ping = setInterval(() => res.write(':ping\n\n'), 15000);
      req.on('close', () => { clearInterval(ping); sseClients.delete(client); });
      return;
    }

    if (p === '/api/heartbeat' && method === 'POST') {
      return json(res, 200, { ok: true });
    }

    return json(res, 404, { error: 'not found', hint: '见 README 的 API 文档' });
  } catch (e) {
    console.error('[api]', p, e);
    return json(res, 500, { error: e.message });
  }
}

/* ---------------- 工具 ---------------- */

function normalizeAdapter(a) {
  if (!a || !a.kind || a.kind === 'none') return { kind: 'none' };
  return { kind: String(a.kind).slice(0, 24), options: (a.options && typeof a.options === 'object') ? a.options : {} };
}

function filterDomains(list) {
  const valid = new Set(scanDomains().map((d) => d.name));
  return [...new Set([].concat(list || []).map((d) => String(d).slice(0, 40)))].filter((d) => valid.has(d));
}

function pubAgent(a) {
  return {
    name: a.name, kind: a.kind, persona: a.persona, hue: a.hue,
    online: isOnline(a), hasWebhook: !!a.webhookUrl, createdAt: a.createdAt,
    owner: a.owner || null, domains: a.domains || [],
    adapter: a.kind === 'agent' ? { kind: a.adapter?.kind || 'none' } : undefined,
    context: a.context || (a.kind === 'human' ? 'channel' : 'mentions'),
    skills: a.skills || [],
  };
}

function pubChannel(ch, forName) {
  return {
    id: ch.id, type: ch.type,
    name: ch.type === 'dm' ? (ch.members.find((m) => m !== forName) || forName) : ch.name,
    topic: ch.topic, members: [...ch.members], createdAt: ch.createdAt,
    isPublic: !!ch.isPublic, owner: ch.type === 'group' ? (ch.owner || null) : undefined,
  };
}

function listChannelsFor(name) {
  return Object.values(db.channels)
    .filter((c) => canReadChannel(name, c))
    .map((c) => pubChannel(c, name));
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function serveStatic(p, res) {
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('404'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

/* ---------------- 启动 ---------------- */

loadDb();
fs.mkdirSync(DATA_DIR, { recursive: true });
const server = http.createServer((req, res) => { route(req, res).catch((e) => json(res, 500, { error: e.message })); });
server.listen(PORT, () => {
  const healed = engine.heal(); // 崩溃自愈：把 working 的 job 放回队列
  console.log(`SciTag 已启动  http://127.0.0.1:${PORT}${healed ? `（恢复 ${healed} 个中断任务）` : ''}`);
  console.log(`课题组演示账号 token：demo-jiaoshou / demo-wangyan / demo-liyan（agent：demo-xiaowang / demo-xiaoli）`);
});
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { saveNow(); process.exit(0); });
}

export { engine };
