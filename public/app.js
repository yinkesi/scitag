/* app.js —— SciTag Console 前端逻辑
   渲染概念「实验记录台」：日志沟槽消息流 / 文档卡 / 乘组清单 / 仪器条 / 任务流水线。
   行为契约与旧版一致（API、SSE、审批、@/# 补全），仅表现层重构。 */
'use strict';

const S = {
  token: localStorage.getItem('scitag_token') || '',
  name: localStorage.getItem('scitag_name') || '',
  me: null, agents: [], channels: [], missions: [], domains: [], backends: [],
  cur: null, msgs: {}, seq: 0,
  es: null,
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad2 = (n) => String(n).padStart(2, '0');

function toast(msg, err = false) {
  const t = $('toast');
  t.textContent = msg; t.className = err ? 'err' : '';
  setTimeout(() => { t.className = 'hidden'; }, 2600);
}

async function api(path, opts = {}) {
  const r = await fetch(path, {
    method: opts.method || 'GET',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + S.token },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) { logout(); throw new Error('登录失效'); }
  if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
  return j;
}

/* ---------------- 登录闸门 ---------------- */

for (const li of document.querySelectorAll('#gateQuick li')) {
  li.onclick = () => doLogin(li.dataset.login, li.dataset.token);
}
$('btnLogin').onclick = () => doLogin($('loginName').value.trim(), $('loginToken').value.trim());
async function doLogin(name, token) {
  if (!name || !token) return toast('名字与 token 都要填', true);
  try {
    const r = await fetch('/api/register', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, token }),
    });
    const j = await r.json();
    if (!r.ok) return toast(j.error || '登录失败', true);
    S.token = j.token; S.name = j.me.name;
    localStorage.setItem('scitag_token', S.token);
    localStorage.setItem('scitag_name', S.name);
    boot();
  } catch (e) { toast(e.message, true); }
}
function logout() { localStorage.removeItem('scitag_token'); localStorage.removeItem('scitag_name'); location.reload(); }

/* ---------------- 启动 ---------------- */

async function boot() {
  $('gate').classList.add('hidden');
  $('app').classList.remove('hidden');
  await refreshState();
  const first = S.channels.find((c) => c.type === 'group') || S.channels[0];
  if (first) await openChannel(first.id);
  connectSSE();
  renderPanel();
  renderStats();
  setInterval(async () => {           // 仪器条：作业数低频轮询（SSE 覆盖 seq/在线）
    try {
      const h = await fetch('/api/health').then((r) => r.json());
      renderStats(h.jobs);
    } catch {}
  }, 5000);
}

async function refreshState() {
  const j = await api('/api/state');
  S.me = j.me; S.agents = j.agents; S.channels = j.channels;
  S.missions = j.missions; S.domains = j.domains; S.backends = j.backends;
  S.seq = Math.max(S.seq, j.seq || 0);
  renderSidebar();
  renderStats();
}

function agentOf(name) { return S.agents.find((a) => a.name === name); }
function taskById(id) { for (const m of S.missions) { const t = m.tasks.find((x) => x.id === id); if (t) return t; } return null; }

/* ---------------- 内联预览（学 Claude Code：点开文件链接原地展开内容） ---------------- */

const fullTaskCache = {}; // taskId -> 完整任务（含全文报告）
async function fetchFullTask(id) {
  if (fullTaskCache[id]) return fullTaskCache[id];
  const j = await api('/api/tasks/' + encodeURIComponent(id));
  fullTaskCache[id] = j.task;
  return j.task;
}

function previewHtml(t) {
  return `<div class="pv-meta">${esc(t.badge)} · ${esc(t.assignee)} → ${esc(t.owner)} · R${t.attempts}</div>` +
    `<div class="pv-sec">任务书</div><div class="digest">${md(t.brief)}</div>` +
    `<div class="pv-sec">成果全文</div><div class="digest pv-report">${md(t.report || '（尚无成果）')}</div>` +
    (t.review ? `<div class="pv-sec">最近审阅</div><div class="digest">${esc(t.review.decision)}：${md(t.review.comment || '')}</div>` : '');
}

async function fillPreview(pv, taskId) {
  pv.textContent = '加载中…';
  try { pv.innerHTML = previewHtml(await fetchFullTask(taskId)); }
  catch (e) { pv.textContent = '加载失败：' + e.message; }
}

/** 文档卡：标题变成可点开的链接，点击原地展开全文预览 */
function makeExpandable(box, taskId) {
  const title = box.querySelector('.doc-title');
  if (!title) return;
  title.classList.add('link');
  title.title = '点击展开 / 收起全文';
  const ch = document.createElement('span');
  ch.className = 'chev';
  ch.textContent = '▸';
  title.insertAdjacentElement('afterend', ch);
  const toggle = () => {
    let pv = box.querySelector('.doc-preview');
    if (pv) { pv.remove(); ch.classList.remove('open'); return; }
    ch.classList.add('open');
    pv = document.createElement('div');
    pv.className = 'doc-preview';
    box.appendChild(pv);
    fillPreview(pv, taskId);
  };
  title.onclick = toggle;
  ch.onclick = toggle;
}

/** 任务板行：点击行原地展开（全局暴露给模板 onclick） */
window.toggleTaskPreview = async (rowEl, id) => {
  let pv = rowEl.nextElementSibling;
  if (pv && pv.classList.contains('task-preview')) { pv.remove(); return; }
  pv = document.createElement('div');
  pv.className = 'task-preview';
  rowEl.after(pv);
  fillPreview(pv, id);
};

/* ---------------- 仪器条 ---------------- */

function renderStats(jobs) {
  const online = S.agents.filter((a) => a.online).length;
  const j = jobs || S._jobs || { queued: 0, working: 0 };
  S._jobs = jobs || S._jobs;
  const parts = [
    `在线 <b class="live">${online}</b>/${S.agents.length}`,
    `SEQ <b>${S.seq}</b>`,
    `作业 <b>${j.working || 0}</b>`,
    `课题 <b>${S.missions.filter((m) => m.status === 'open').length}</b>`,
  ];
  $('liveStats').innerHTML = parts.map((p) => `<span class="stat">${p}</span>`).join('<span class="sep">·</span>');
}

/* ---------------- 侧栏：索引 + 乘组清单 ---------------- */

function renderSidebar() {
  const ul = $('channelList');
  ul.innerHTML = '';
  S.channels.forEach((c, i) => {
    const li = document.createElement('li');
    if (c.id === S.cur) li.classList.add('on');
    li.innerHTML =
      `<span class="ch-name">${esc(c.name)}</span>` +
      (c.type === 'group' ? `<span class="n-members">${c.members.length} 人</span>` : `<span class="n-members">私聊</span>`);
    li.onclick = () => openChannel(c.id);
    ul.appendChild(li);
  });

  const rl = $('rosterList');
  rl.innerHTML = '';
  for (const a of S.agents) {
    const li = document.createElement('li');
    li.title = a.persona || '';
    const role = a.kind === 'human'
      ? (a.name === '教授' ? 'PI' : '研究者')
      : `${a.owner || '?'} 的 agent`;
    li.innerHTML =
      `<span class="avatar" style="background:hsl(${a.hue},20%,42%)">${esc(a.name[0])}</span>` +
      `<span class="m-name">${esc(a.name)}</span>` +
      `<span class="m-role"><span class="dot${a.online ? ' on' : ''}"></span> ${esc(role)}</span>` +
      `<span class="m-tags">` +
      (a.kind === 'agent' ? '<span class="badge dom">agent</span>' : '') +
      ((a.domains || []).map((d) => `<span class="badge dom">${esc(d)}</span>`).join('')) +
      `</span>`;
    li.onclick = () => openDm(a.name);
    rl.appendChild(li);
  }

  const role = S.me ? (S.me.kind === 'human' ? (S.me.name === '教授' ? 'PI · 课题领导' : '研究者') : 'agent') : '';
  $('meCard').innerHTML = S.me
    ? `<span class="avatar" style="background:hsl(${S.me.hue},20%,42%)">${esc(S.me.name[0])}</span><span><div class="me-name">${esc(S.me.name)}</div><div class="me-role">${esc(role)}</div></span>`
    : '';

  $('domainsInfo').innerHTML = S.domains.length
    ? S.domains.map((d) => `${esc(d.name)} · ${d.skills.length}技能 / ${d.kbCount}条`).join('<br>')
    : 'domains/ 下暂无域包';
}

async function openDm(name) {
  if (name === S.me.name) return;
  const j = await api('/api/channels', { method: 'POST', body: { type: 'dm', dmWith: name } }).catch(() => null);
  if (j) { await refreshState(); openChannel(j.channel.id); }
}

/* ---------------- 频道与消息 ---------------- */

async function openChannel(id) {
  S.cur = id;
  const c = S.channels.find((x) => x.id === id);
  $('chatTitle').textContent = c ? (c.type === 'dm' ? '与 ' + c.name : c.name) : '—';
  $('chatSub').textContent = c?.topic || (c?.type === 'dm' ? '成果汇报与审阅（仅你们可见）' : '');
  $('chatMeta').innerHTML = c
    ? (c.type === 'dm'
        ? `私聊`
        : `${c.members.length} 名成员${c.owner ? ' · 群主 ' + esc(c.owner) : ''}`)
    : '';
  renderSidebar();
  const j = await api('/api/messages?channel=' + encodeURIComponent(id) + '&limit=100');
  S.msgs[id] = j.messages;
  renderMsgs();
}

function nearBottom(el) { return el.scrollHeight - el.scrollTop - el.clientHeight < 80; }

function renderMsgs() {
  const list = $('msgList');
  const stick = nearBottom(list);
  list.innerHTML = '';
  for (const m of S.msgs[S.cur] || []) list.appendChild(renderMsg(m));
  if (stick) list.scrollTop = list.scrollHeight;
}

function highlight(text, mentions = [], skills = []) {
  let h = esc(text);
  for (const n of new Set([...mentions, ...(S.agents.map((a) => a.name))])) {
    h = h.split('@' + n).join(`<span class="mention">@${esc(n)}</span>`);
  }
  for (const s of skills) h = h.split('#' + s).join(`<span class="skilltag">#${esc(s)}</span>`);
  return h;
}

function renderMsg(m) {
  const div = document.createElement('div');
  const d = new Date(m.ts);
  const time = pad2(d.getHours()) + ':' + pad2(d.getMinutes());

  if (m.kind === 'system') {
    div.className = 'msg sys';
    div.innerHTML = `<div class="body"><div class="bubble">${esc(m.text)}</div></div>`;
    return div;
  }
  if (m.kind === 'card') {
    div.className = 'msg';
    div.innerHTML = `<div class="body"></div>`;
    div.querySelector('.body').appendChild(renderDoc(m));
    return div;
  }
  div.className = 'msg' + (m.from === S.me.name ? ' mine' : '');
  div.innerHTML =
    `<div class="body">` +
    `<div class="meta"><b>${esc(m.from)}</b><span class="time">${time}</span></div>` +
    `<div class="bubble">${highlight(m.text, m.mentions, m.skills)}</div></div>`;
  return div;
}

/* ---------------- 文档卡（工作流事件） ---------------- */

function md(text) {
  // 轻量 Markdown：先 esc 再转内联标记（内容永远先转义，无注入面）
  let h = esc(String(text ?? ''));
  h = h.replace(/^#{1,3} (.+)$/gm, '<span class="md-h">$1</span>');
  h = h.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  h = h.replace(/`([^`]+)`/g, '<code>$1</code>');
  h = h.replace(/^[-·] (.+)$/gm, '<span class="md-li">$1</span>');
  return h;
}

function renderDoc(m) {
  const c = m.card || {};
  const box = document.createElement('div');
  box.className = 'doc t-' + (c.type || 'task');
  const t = c.taskId ? taskById(c.taskId) : null;
  const live = t ? t.status : null;
  const chip = (st, txt) => `<span class="status-chip st-${st}">${esc(txt)}</span>`;
  const head = (kind, title, st, stTxt) =>
    `<div class="doc-head"><span class="k">${kind}</span><span class="doc-title">${esc(title)}</span>${chip(st, stTxt)}</div>`;

  if (c.type === 'mission') {
    box.innerHTML = head('课题', c.title, 'dispatched', '开放') +
      `<div class="doc-meta">领导 ${esc(c.leader)}</div>` +
      (c.brief ? `<div class="digest">${md(c.brief)}</div><div style="height:10px"></div>` : '');
  } else if (c.type === 'task' || c.type === 'redispatch') {
    box.innerHTML =
      head(c.type === 'redispatch' ? '重做' : '任务', c.title, t ? t.status : 'dispatched', t ? t.badge : '已派发') +
      `<div class="doc-meta">${esc(c.missionTitle || '')} · 执行 ${esc(c.assignee)} → 审阅 ${esc(c.owner)} · R${c.attempts}</div>` +
      (c.brief ? `<div class="digest">${md(c.brief)}</div>` : '') +
      (c.comment ? `<div class="digest note">审阅意见：${md(c.comment)}</div>` : '') +
      `<div style="height:10px"></div>`;
  } else if (c.type === 'review') {
    box.innerHTML =
      head('待审', c.title, t ? t.status : 'reported', t ? t.badge : '待审阅') +
      `<div class="doc-meta">${esc(c.missionTitle)} · ${esc(c.agentName)} R${c.attempts} 产出 → ${esc(taskById(c.taskId)?.owner || '主人')}</div>` +
      `<div class="digest">${md(c.digest)}</div>`;
    const acts = document.createElement('div');
    acts.className = 'doc-actions';
    const full = document.createElement('button'); full.className = 'btn ghost'; full.textContent = '查看全文';
    full.onclick = () => showReport(c.taskId);
    acts.appendChild(full);
    if (live === 'reported') {
      const ok = document.createElement('button'); ok.className = 'btn ok'; ok.textContent = '批准 · 回群';
      ok.onclick = () => review(c.taskId, 'approve', '');
      const no = document.createElement('button'); no.className = 'btn bad'; no.textContent = '驳回 · 重做';
      no.onclick = () => {
        const comment = prompt('驳回意见（agent 将带着意见重做）：');
        if (comment !== null) review(c.taskId, 'reject', comment);
      };
      acts.append(ok, no);
    }
    box.appendChild(acts);
  } else if (c.type === 'publish') {
    box.innerHTML =
      head('回群', c.title, 'published', '已回群') +
      `<div class="doc-meta">${esc(c.agentName)} 产出 · ${esc(c.ownerName)} 已批准</div>` +
      `<div class="digest">${md(c.digest)}</div>` +
      (c.reviewComment ? `<div class="doc-meta" style="padding-top:6px">审阅意见：${esc(c.reviewComment)}</div>` : '');
    const acts = document.createElement('div');
    acts.className = 'doc-actions';
    const full = document.createElement('button'); full.className = 'btn ghost'; full.textContent = '查看全文';
    full.onclick = () => showReport(c.taskId);
    acts.appendChild(full); box.appendChild(acts);
  } else if (c.type === 'fail') {
    box.innerHTML = head('失败', c.title, 'failed', '转人工') +
      `<div class="doc-meta">${esc(c.agentName)} · ${esc(c.reason || '')}</div><div style="height:10px"></div>`;
  } else {
    box.innerHTML = head('卡片', c.type || '', 'dispatched', '—');
  }
  if (c.taskId) makeExpandable(box, c.taskId);
  return box;
}

async function review(taskId, decision, comment) {
  try {
    await api(`/api/tasks/${encodeURIComponent(taskId)}/review`, { method: 'POST', body: { decision, comment } });
    toast(decision === 'approve' ? '已批准，成果已回群' : '已驳回，agent 将重做');
    await refreshState(); renderMsgs(); renderPanel();
  } catch (e) { toast(e.message, true); }
}

async function showReport(taskId) {
  try {
    const j = await api('/api/tasks/' + encodeURIComponent(taskId));
    const t = j.task;
    openModal(`
      <h2>${esc(t.title)}</h2>
      <p class="hint">${esc(t.badge)} · ${esc(t.assignee)} → ${esc(t.owner)} · R${t.attempts} · ID <span class="mono">${esc(t.id)}</span></p>
      <label>任务书</label><div class="digest">${md(t.brief)}</div>
      <label>成果全文</label><div class="digest" style="max-height:44vh">${md(t.report || (t.status === 'reported' ? '成果待主人审阅，批准后开放。' : '（尚无成果）'))}</div>
      ${t.failReason ? `<label>失败详情</label><div class="digest">${md(t.failReason)}</div>` : ''}
      ${t.provenance ? `<details class="evidence"><summary>核验计算记录</summary>
        <p>执行时间：${esc(new Date(t.provenance.at).toLocaleString())}</p>
        <p>执行结果：${t.provenance.exitCode === 0 ? '成功' : '失败'}（退出码 ${esc(t.provenance.exitCode ?? '未启动')}）</p>
        <p>分析步骤：${esc(t.provenance.args?.join(' '))}</p>
        <p>数据校验值（SHA256）：<code>${esc(t.provenance.dataSha256)}</code></p>
        <p>脚本校验值（SHA256）：<code>${esc(t.provenance.scriptSha256)}</code></p>
        <label>原始计算输出</label><div class="digest">${md(t.provenance.output)}</div></details>` : ''}
      ${t.analysisRuns?.length ? `<details class="evidence"><summary>全部分析记录（${t.analysisRuns.length} 次）</summary>${t.analysisRuns.map((run, index) =>
        `<label>第 ${index + 1} 次 · ${esc(run.provenance?.command || '')} · ${run.ok ? '成功' : '失败'}</label><div class="digest">${md(run.text)}</div>`).join('')}</details>` : ''}
      ${t.reportVersions?.length ? `<details class="evidence"><summary>历史版本与审阅（${t.reportVersions.length} 轮）</summary>${t.reportVersions.map(v =>
        `<label>第 ${v.attempt} 轮 · ${esc(new Date(v.at).toLocaleString())}</label><div class="digest">${md(v.report)}</div><p>${v.review ? `${v.review.decision === 'approve' ? '批准' : '驳回'}：${esc(v.review.comment || '无意见')}` : '待审阅'}</p>`).join('')}</details>` : ''}
      ${t.review ? `<label>最近审阅</label><div class="digest">${esc(t.review.decision)}：${md(t.review.comment || '')}</div>` : ''}
      <div class="foot"><button class="btn" onclick="closeModal()">关闭</button></div>`);
  } catch (e) { toast(e.message, true); }
}

/* ---------------- 任务板 ---------------- */

let panelTab = 'missions';
document.querySelectorAll('.tabs button').forEach((b) => {
  b.onclick = () => {
    panelTab = b.dataset.tab;
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('on', x === b));
    renderPanel();
  };
});
$('btnPanel').onclick = () => $('panel').classList.remove('hidden');
$('btnClosePanel').onclick = () => $('panel').classList.add('hidden');

function renderPipeline() {
  const by = { dispatched: 0, working: 0, reported: 0, published: 0, failed: 0 };
  for (const m of S.missions) {
    for (const [k, v] of Object.entries(m.progress.by)) {
      if (k === 'working' || k === 'rejected') by.working += v;
      else if (by[k] !== undefined) by[k] += v;
    }
  }
  const stages = [
    ['派发', by.dispatched], ['执行', by.working], ['待审', by.reported], ['回群', by.published], ['失败', by.failed],
  ];
  const total = stages.reduce((s, [, v]) => s + v, 0);
  $('pipeline').innerHTML = total
    ? stages.map(([l, v]) => `<span class="${(l === '待审' || l === '执行') && v > 0 ? 'hot' : ''}">${l} <b>${v}</b></span>`).join('<span class="sep">·</span>')
    : '暂无进行中的任务';
}

function renderPanel() {
  renderPipeline();
  const body = $('panelBody');
  if (panelTab === 'missions') {
    body.innerHTML = '';
    if (!S.missions.length) { body.innerHTML = '<div class="empty">[ 暂无课题 — 顶栏「新课题」开始 ]</div>'; return; }
    for (const m of S.missions) body.appendChild(missionCard(m));
  } else if (panelTab === 'reviews') {
    const pend = [];
    for (const m of S.missions) for (const t of m.tasks) if (t.status === 'reported' && t.owner === S.me.name) pend.push({ m, t });
    body.innerHTML = pend.length ? '' : '<div class="empty">[ 没有等你审的成果 ]</div>';
    for (const { m, t } of pend) {
      const c = document.createElement('div');
      c.className = 'mission-card';
      c.innerHTML = `<div class="mc-head"><span class="k v-warn">待审</span><span class="m-title">${esc(t.title)}</span></div>` +
        `<div class="mc-body"><div class="m-meta">${esc(m.title)} · ${esc(t.assignee)} R${t.attempts} 产出</div>` +
        `<div class="digest">${md(t.reportDigest || '')}</div></div>`;
      const acts = document.createElement('div');
      acts.className = 'mc-actions';
      const ok = document.createElement('button'); ok.className = 'btn ok'; ok.textContent = '批准 · 回群';
      ok.onclick = () => review(t.id, 'approve', '');
      const no = document.createElement('button'); no.className = 'btn bad'; no.textContent = '驳回 · 重做';
      no.onclick = () => { const cc = prompt('驳回意见：'); if (cc !== null) review(t.id, 'reject', cc); };
      acts.append(ok, no); c.appendChild(acts); body.appendChild(c);
    }
  } else {
    body.innerHTML = '';
    for (const d of S.domains) {
      const c = document.createElement('div');
      c.className = 'mission-card';
      c.innerHTML = `<div class="mc-head"><span class="k v-acc">域包</span><span class="m-title">${esc(d.name)} <span class="badge">v${esc(d.version)}</span></span></div>` +
        `<div class="mc-body"><div class="m-meta" style="color:var(--ink2)">${esc(d.description)}</div>` +
        d.skills.map((s) => `<div class="task-row" style="cursor:default"><span class="badge dom">#${esc(s.name)}</span><span class="t-title">${esc(s.description)}</span></div>`).join('') +
        `</div>`;
      const srch = document.createElement('div');
      srch.className = 'mc-actions';
      srch.innerHTML = `<input placeholder="检索知识库（${d.kbCount} 条）" style="flex:1"><button class="btn">搜</button>`;
      const inp = srch.querySelector('input');
      const run = async () => {
        try {
          const j = await api(`/api/domains/${encodeURIComponent(d.name)}/kb?q=` + encodeURIComponent(inp.value));
          openModal(`<h2>域包 ${esc(d.name)} · 知识库检索</h2><p class="hint">命中 ${j.results.length} 条</p>` +
            j.results.map((r) => `<label style="cursor:pointer" onclick="showKb('${esc(d.name)}','${esc(r.name)}')">${esc(r.name)} · score ${r.score}</label><div class="digest">${esc(r.snippet)}</div>`).join('') +
            `<div class="foot"><button class="btn" onclick="closeModal()">关闭</button></div>`);
        } catch (e) { toast(e.message, true); }
      };
      srch.querySelector('button').onclick = run;
      inp.onkeydown = (e) => { if (e.key === 'Enter') run(); };
      c.appendChild(srch);
      body.appendChild(c);
    }
    if (!S.domains.length) body.innerHTML = '<div class="empty">[ domains/ 下没有域包 ]</div>';
  }
}

function progressLine(p) {
  const names = { dispatched: '已派发', working: '执行中', reported: '待审', approved: '已批', rejected: '已驳', published: '已回群', failed: '失败' };
  const parts = Object.entries(p.by || {}).filter(([k, v]) => v > 0 && k !== 'approved').map(([k, v]) => names[k] + ' ' + v);
  return parts.length ? parts.join(' · ') : '—';
}

function missionCard(m) {
  const c = document.createElement('div');
  c.className = 'mission-card';
  const isLeader = m.leader === S.me.name;
  c.innerHTML = `<div class="mc-head"><span class="k ${m.status === 'closed' ? 'v-mut' : 'v-ink'}">${m.status === 'closed' ? '结题' : '课题'}</span><span class="m-title">${esc(m.title)}</span><span class="badge">R${m.round}</span></div>` +
    `<div class="mc-body">` +
    `<div class="m-meta">领导 ${esc(m.leader)} · ${m.progress.done}/${m.progress.total} 完成</div>` +
    `<div class="pbar"><div style="width:${m.progress.pct}%;${m.progress.pct >= 100 ? 'background:var(--ok)' : ''}"></div></div>` +
    `<div class="m-meta" style="margin-top:2px">${progressLine(m.progress)}</div>` +
    m.tasks.map((t) => `<div class="task-row" title="点击展开 / 收起全文" onclick="toggleTaskPreview(this,'${esc(t.id)}')"><span class="status-chip st-${esc(t.status)}">${esc(t.badge)}</span><span class="t-title link">${esc(t.title)}</span><span class="badge owner">${esc(t.assignee)}</span></div>`).join('') +
    `</div>`;
  if (isLeader && m.status === 'open') {
    const acts = document.createElement('div');
    acts.className = 'mc-actions';
    const b1 = document.createElement('button'); b1.className = 'btn primary'; b1.textContent = '派活';
    b1.onclick = () => dispatchModal(m);
    const b2 = document.createElement('button'); b2.className = 'btn'; b2.textContent = '汇总';
    b2.onclick = () => summarizeModal(m);
    acts.append(b1, b2); c.appendChild(acts);
  }
  return c;
}

/* ---------------- 模态 ---------------- */

function openModal(html) {
  $('modalBody').innerHTML = html;
  $('modal').classList.remove('hidden');
}
function closeModal() { $('modal').classList.add('hidden'); }
window.closeModal = closeModal;
window.showReport = showReport;
window.showKb = async (domain, name) => {
  try {
    const j = await api(`/api/domains/${encodeURIComponent(domain)}/kb/${encodeURIComponent(name)}`);
    openModal(`<h2>${esc(j.name)}</h2><div class="digest" style="max-height:58vh">${esc(j.body)}</div><div class="foot"><button class="btn" onclick="closeModal()">关闭</button></div>`);
  } catch (e) { toast(e.message, true); }
};

$('btnNewMission').onclick = () => {
  const groups = S.channels.filter((c) => c.type === 'group');
  openModal(`
    <h2>新建课题</h2>
    <p class="hint">课题建在群里；之后你是课题领导：派活、汇总、结题。</p>
    <label>课题名</label><input id="nmTitle" placeholder="如：骨支架 compliance 建模与逆设计">
    <label>课题说明</label><textarea id="nmBrief" placeholder="背景、目标、验收口径（可引用 #技能）"></textarea>
    <label>群</label><select id="nmChannel">${groups.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}</select>
    <div class="foot"><button class="btn" onclick="closeModal()">取消</button><button class="btn primary" id="nmGo">建立</button></div>`);
  $('nmGo').onclick = async () => {
    try {
      await api('/api/missions', { method: 'POST', body: { title: $('nmTitle').value, brief: $('nmBrief').value, channel: $('nmChannel').value } });
      closeModal(); toast('课题已建立'); await refreshState(); renderPanel();
    } catch (e) { toast(e.message, true); }
  };
};

function dispatchModal(m) {
  const cands = S.agents.filter((a) => a.kind === 'agent' && a.owner && a.domains?.length);
  if (!cands.length) return toast('没有可派活的 agent（需绑定主人且挂载域包）', true);
  openModal(`
    <h2>派活 · ${esc(m.title)}</h2>
    <p class="hint">任务进入 agent 执行队列，产出先私聊给它的主人审阅。</p>
    <label>执行 agent</label><select id="dpAgent">${cands.map((a) => `<option value="${esc(a.name)}">${esc(a.name)}（主人 ${esc(a.owner)}）</option>`).join('')}</select>
    <label>任务标题</label><input id="dpTitle" placeholder="如：解释 compliance 随加载角的放大机理">
    <label>任务书</label><textarea id="dpBrief" placeholder="要求、口径、验收标准；引用知识库请写「见研究任务口径 T2」等"></textarea>
    <label>点名外挂技能（不选则用 agent 默认）</label><div class="chip-select" id="dpSkills"></div>
    <div class="foot"><button class="btn" onclick="closeModal()">取消</button><button class="btn primary" id="dpGo">派发</button></div>`);
  const fill = () => {
    const a = agentOf($('dpAgent').value);
    const skills = S.domains.filter((d) => a?.domains?.includes(d.name)).flatMap((d) => d.skills);
    $('dpSkills').innerHTML = skills.map((s) => `<span class="chip" data-s="${esc(s.name)}">#${esc(s.name)}</span>`).join('') || '<span class="hint">该 agent 挂载的域包里没有技能</span>';
    $('dpSkills').querySelectorAll('.chip').forEach((ch) => ch.onclick = () => ch.classList.toggle('on'));
  };
  $('dpAgent').onchange = fill; fill();
  $('dpGo').onclick = async () => {
    const skills = [...$('dpSkills').querySelectorAll('.chip.on')].map((c) => c.dataset.s);
    try {
      await api(`/api/missions/${encodeURIComponent(m.id)}/tasks`, {
        method: 'POST',
        body: { assignee: $('dpAgent').value, title: $('dpTitle').value, brief: $('dpBrief').value, skills },
      });
      closeModal(); toast('任务已派发'); await refreshState(); renderPanel();
    } catch (e) { toast(e.message, true); }
  };
}

function summarizeModal(m) {
  openModal(`
    <h2>汇总 · ${esc(m.title)}</h2>
    <p class="hint">以领导身份收拢本轮已回群的成果；可选结题。</p>
    <label>汇总正文</label><textarea id="smText" style="min-height:120px" placeholder="本轮结论 / 分歧 / 下一轮计划"></textarea>
    <label style="display:flex;gap:8px;align-items:center;margin-top:14px;text-transform:none;letter-spacing:0;font-size:12px;color:var(--ink2)"><input type="checkbox" id="smClose" style="width:auto"> 结题（关闭课题）</label>
    <div class="foot"><button class="btn" onclick="closeModal()">取消</button><button class="btn primary" id="smGo">发布汇总</button></div>`);
  $('smGo').onclick = async () => {
    try {
      await api(`/api/missions/${encodeURIComponent(m.id)}/summarize`, {
        method: 'POST', body: { text: $('smText').value, close: $('smClose').checked },
      });
      closeModal(); toast('汇总已发布'); await refreshState(); renderPanel();
    } catch (e) { toast(e.message, true); }
  };
}

$('btnAddAgent').onclick = () => {
  const humans = S.agents.filter((a) => a.kind === 'human');
  const backends = [{ id: 'none', label: '仅占位（外部 runtime 接入）' },
    ...S.backends.map((b) => ({ id: b.id, label: b.label + (b.available ? '' : '（不可用）') }))];
  openModal(`
    <h2>接入新 agent</h2>
    <p class="hint">agent 必须绑定一位主人（研究者），并挂载域包获得外挂知识库与技能。</p>
    <div class="form-row"><input id="agName" placeholder="agent 名字"><select id="agOwner"><option value="">主人（研究者）</option>${humans.map((h) => `<option>${esc(h.name)}</option>`).join('')}</select></div>
    <label>人设</label><input id="agPersona" placeholder="擅长什么、口吻如何">
    <label>挂载域包</label><div class="chip-select" id="agDomains">${S.domains.map((d) => `<span class="chip" data-d="${esc(d.name)}">${esc(d.name)}</span>`).join('')}</div>
    <label>执行后端</label><select id="agAdapter">${backends.map((b) => `<option value="${esc(b.id)}">${esc(b.label)}</option>`).join('')}</select>
    <div id="agAnalysisFields" class="hidden">
      <label for="agCommand">分析步骤</label><select id="agCommand"><option value="stats">数据统计</option><option value="fit">函数拟合</option><option value="inverse">逆设计</option></select>
      <div id="agTargetRow" class="hidden"><label for="agTarget">compliance 目标上限</label><input id="agTarget" type="number" step="any" min="0" value="8e-11"></div>
      <p class="hint">对挂载的骨支架数据实际计算，报告先交给主人审阅。</p>
    </div>
    <div id="agLlmFields" class="hidden">
      <label for="agBaseUrl">模型接口地址</label><input id="agBaseUrl" type="url" placeholder="https://你的服务地址/v1">
      <label for="agModel">模型名称</label><input id="agModel" placeholder="服务支持的模型名称">
      <label for="agApiKey">访问密钥（可选）</label><input id="agApiKey" type="password" autocomplete="new-password">
      <label><input id="agTools" type="checkbox" checked> 允许模型调用骨支架分析工具</label>
    </div>
    <div id="agWebhookFields" class="hidden"><label for="agWebhookUrl">Agent 接入地址</label><input id="agWebhookUrl" type="url" placeholder="https://你的 agent 服务地址"></div>
    <div class="foot"><button class="btn" onclick="closeModal()">取消</button><button class="btn primary" id="agGo">注册</button></div>`);
  $('agDomains').querySelectorAll('.chip').forEach((ch) => ch.onclick = () => ch.classList.toggle('on'));
  $('agDomains').querySelectorAll('.chip')[0]?.classList.add('on');
  $('agAdapter').onchange = () => {
    for (const [id, kind] of [['agAnalysisFields', 'analysis'], ['agLlmFields', 'llm'], ['agWebhookFields', 'webhook']]) {
      $(id).classList.toggle('hidden', $('agAdapter').value !== kind);
    }
  };
  $('agCommand').onchange = () => $('agTargetRow').classList.toggle('hidden', $('agCommand').value !== 'inverse');
  $('agGo').onclick = async () => {
    const domains = [...$('agDomains').querySelectorAll('.chip.on')].map((c) => c.dataset.d);
    try {
      const kind = $('agAdapter').value;
      let options = {};
      if (kind === 'analysis') {
        if (!domains.includes('bone-scaffold')) throw new Error('科研分析需要挂载 bone-scaffold 域包');
        options = { domain: 'bone-scaffold', command: $('agCommand').value };
        if (options.command === 'inverse') {
          options.target = Number($('agTarget').value);
          if (!Number.isFinite(options.target) || options.target <= 0) throw new Error('目标上限须为正数');
        }
      } else if (kind === 'llm') {
        options = { baseUrl: $('agBaseUrl').value.trim(), model: $('agModel').value.trim(), apiKey: $('agApiKey').value.trim(), enableTools: $('agTools').checked };
        if (!options.baseUrl || !options.model) throw new Error('请填写模型接口地址和名称');
      } else if (kind === 'webhook') {
        options = { url: $('agWebhookUrl').value.trim() };
        if (!options.url) throw new Error('请填写 Agent 接入地址');
      }
      const r = await fetch('/api/register', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'agent', name: $('agName').value, owner: $('agOwner').value, persona: $('agPersona').value, domains, adapter: { kind, options } }),
      });
      const j = await r.json();
      if (!r.ok) return toast(j.error, true);
      closeModal();
      openModal(`<h2>已注册</h2><p class="hint">agent 的 token（交给它的 runtime / webhook 用）：</p><div class="digest mono">${esc(j.token)}</div><div class="foot"><button class="btn" onclick="closeModal()">收好</button></div>`);
      await refreshState();
    } catch (e) { toast(e.message, true); }
  };
};

/* ---------------- 输入区（@ / # 补全） ---------------- */

const input = $('input');
input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  const upTo = input.value.slice(0, input.selectionStart);
  const m1 = upTo.match(/@([^\s@]{0,20})$/);
  const m2 = upTo.match(/#([^\s#]{0,30})$/);
  if (m1) showPopup(m1[1], S.agents.map((a) => ({ v: a.name, hint: a.kind === 'human' ? 'human' : 'agent·' + (a.owner || '') })), '@');
  else if (m2) {
    const skills = S.domains.flatMap((d) => d.skills.map((s) => ({ v: s.name, hint: d.name })));
    showPopup(m2[1], skills, '#');
  } else hidePopup();
});

function showPopup(q, items, sig) {
  const hits = items.filter((i) => i.v.toLowerCase().includes(q.toLowerCase())).slice(0, 8);
  if (!hits.length) return hidePopup();
  const p = $('popup');
  p.innerHTML = hits.map((h, i) => `<div class="item${i === 0 ? ' sel' : ''}" data-v="${esc(h.v)}"><span>${sig}${esc(h.v)}</span><small>${esc(h.hint || '')}</small></div>`).join('');
  p.classList.remove('hidden');
  p.querySelectorAll('.item').forEach((it) => {
    it.onclick = () => {
      const upTo = input.value.slice(0, input.selectionStart);
      input.value = input.value.slice(0, upTo.length - (sig + q).length) + sig + it.dataset.v + ' ' + input.value.slice(input.selectionStart);
      input.focus(); hidePopup();
    };
  });
}
function hidePopup() { $('popup').classList.add('hidden'); }

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});
$('btnSend').onclick = send;

async function send() {
  const text = input.value.trim();
  if (!text || !S.cur) return;
  input.value = ''; input.style.height = 'auto'; hidePopup();
  try {
    const j = await api('/api/messages', { method: 'POST', body: { channel: S.cur, text } });
    (S.msgs[S.cur] = S.msgs[S.cur] || []).push(j.message);
    S.seq = Math.max(S.seq, j.message.seq);
    renderMsgs(); renderStats();
  } catch (e) { toast(e.message, true); }
}

/* ---------------- SSE 实时流 ---------------- */

function connectSSE() {
  if (S.es) S.es.close();
  S.es = new EventSource('/api/stream?token=' + encodeURIComponent(S.token));
  S.es.onmessage = (ev) => {
    let e; try { e = JSON.parse(ev.data); } catch { return; }
    if (e.seq) S.seq = Math.max(S.seq, e.seq);
    if (e.type === 'message' && e.message) {
      const m = e.message;
      if (m.channel === S.cur) {
        const list = (S.msgs[S.cur] = S.msgs[S.cur] || []);
        if (!list.find((x) => x.seq === m.seq)) { list.push(m); renderMsgs(); }
      } else if (m.kind === 'card' || (m.mentions || []).includes(S.me.name)) {
        refreshState().catch(() => {});
      }
    } else if (e.type === 'channel') {
      refreshState().catch(() => {});
    } else if (e.type === 'mission' || e.type === 'task') {
      refreshState().then(() => { renderPanel(); renderMsgs(); }).catch(() => {});
    } else if (e.type === 'presence') {
      const a = agentOf(e.name);
      if (a) { a.online = e.online; renderSidebar(); }
    }
    renderStats();
  };
}

/* ---------------- 自动登录 ---------------- */

if (S.token && S.name) boot().catch(() => { localStorage.removeItem('scitag_token'); location.reload(); });
else $('gate').classList.remove('hidden');
