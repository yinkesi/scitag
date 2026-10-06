/* Desktop shell interactions. Workflow data and authorization stay in app.js/server.js. */
let modalReturnFocus = null;
let sending = false;
let resourceRenderVersion = 0;
const resourceCache = new Map();

function icon(name) { return `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`; }
function makeKeyboardClickable(element) {
  element.tabIndex = 0; element.setAttribute('role', 'button');
  element.onkeydown = event => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); element.click(); }
  };
}
function setSidebarMode(mode) {
  S.sidebarMode = mode;
  for (const button of document.querySelectorAll('.seg-btn')) {
    const selected = button.dataset.seg === mode;
    button.classList.toggle('on', selected); button.setAttribute('aria-pressed', String(selected));
  }
  $('groupSection').classList.toggle('hidden', mode !== 'talk');
  $('chatSection').classList.toggle('hidden', mode !== 'talk');
  $('crewSection').classList.toggle('hidden', mode !== 'crew');
}
function setPanelOpen(open) {
  $('panel').classList.toggle('hidden', !open);
  $('workspace').classList.toggle('panel-open', open);
  $('btnTogglePanel').classList.toggle('on', open);
  $('btnTogglePanel').setAttribute('aria-expanded', String(open));
  $('btnTogglePanel').setAttribute('aria-label', open ? '收起工作面板' : '展开工作面板');
}
function openProjectPanel(tab = 'missions') {
  setPanelOpen(true); $('projectPanel').classList.remove('hidden');
  document.querySelector(`.tabs button[data-tab="${tab}"]`)?.click();
  $('projectPanel').scrollIntoView({ block: 'nearest' });
}
function updateNavigation() {
  $('btnBack').disabled = S.navigationIndex <= 0;
  $('btnForward').disabled = S.navigationIndex >= S.navigation.length - 1;
}
async function navigateConversation(direction) {
  const index = S.navigationIndex + direction;
  if (index < 0 || index >= S.navigation.length) return;
  S.navigationIndex = index;
  try { await openChannel(S.navigation[index], { fromHistory: true }); }
  catch (error) { toast(error.message, true); }
}
function renderProjectTree() {
  const list = $('projectList'); list.replaceChildren();
  for (const mission of S.missions.filter(m => m.channel === S.cur).slice(0, 8)) {
    const li = document.createElement('li'); const button = document.createElement('button');
    button.innerHTML = `<span class="tree-dot"></span><span class="tree-title">${esc(mission.title)}</span>`;
    button.title = mission.title; button.onclick = () => { openProjectPanel(); showMission(mission.id); };
    li.appendChild(button); list.appendChild(li);
  }
}
function showMission(id) {
  const mission = S.missions.find(m => m.id === id);
  if (!mission) return;
  openModal('<h2>' + esc(mission.title) + '</h2><p class="hint">' + esc(mission.brief || '课题详情与任务') + '</p>');
  $('modalBody').appendChild(missionCard(mission));
  const close = document.createElement('button'); close.className = 'btn'; close.textContent = '关闭';
  close.onclick = closeModal; $('modalBody').appendChild(close); close.focus();
}
function resourceRow(title, suffix, action) {
  const button = document.createElement('button'); button.className = 'resource-row'; button.title = title;
  button.innerHTML = `<span class="file-icon">${icon('file')}</span><span class="resource-name">${esc(title)} <span>· ${esc(suffix)}</span></span>`;
  button.onclick = action; return button;
}
async function renderResources() {
  const version = ++resourceRenderVersion;
  const list = $('resourceList');
  const channel = S.channels.find(c => c.id === S.cur);
  $('contextSummary').textContent = channel?.topic || (channel?.type === 'dm' ? '私聊成果仅向参与者开放。' : '在课题组中协作，成果经审阅后发布。');
  if (!resourceCache.size) list.innerHTML = '<p class="empty">正在加载研究资料…</p>';
  try {
    const domains = await Promise.all(S.domains.map(async domain => {
      if (!resourceCache.has(domain.name)) {
        resourceCache.set(domain.name, api('/api/domains/' + encodeURIComponent(domain.name) + '/kb?limit=100').catch(error => { resourceCache.delete(domain.name); throw error; }));
      }
      return { domain, kb: (await resourceCache.get(domain.name)).results };
    }));
    if (version !== resourceRenderVersion) return;
    list.replaceChildren();
    for (const { domain, kb } of domains) {
      for (const file of kb) list.appendChild(resourceRow(file.name, 'MD', () => window.showKb(domain.name, file.name)));
      for (const skill of domain.skills) list.appendChild(resourceRow(skill.name, 'SKILL', async () => {
        try {
          const result = await api(`/api/domains/${encodeURIComponent(domain.name)}/skills/${encodeURIComponent(skill.name)}`);
          openModal(`<h2>${esc(skill.name)}</h2><div class="digest" style="max-height:60vh">${esc(result.skill.body)}</div><div class="foot"><button class="btn" onclick="closeModal()">关闭</button></div>`);
        } catch (error) { toast(error.message, true); }
      }));
    }
    for (const mission of S.missions.filter(m => m.channel === S.cur)) {
      for (const task of mission.tasks.filter(t => t.status === 'published' || (t.owner === S.me.name && t.status === 'reported'))) {
        list.appendChild(resourceRow(task.title, 'REPORT', () => showReport(task.id)));
      }
    }
    if (!list.children.length) list.innerHTML = '<p class="empty">暂无研究资料</p>';
  } catch (error) {
    if (version === resourceRenderVersion) {
      list.innerHTML = '<p class="empty">资料加载失败</p>';
      const retry = document.createElement('button'); retry.className = 'context-link'; retry.textContent = '重新加载'; retry.onclick = renderResources; list.appendChild(retry);
    }
  }
}
function updateSendButton() { $('btnSend').disabled = sending || !input.value.trim() || !S.cur; }
function toggleSection(button) {
  const open = button.getAttribute('aria-expanded') !== 'true';
  button.setAttribute('aria-expanded', String(open)); $(button.getAttribute('aria-controls')).classList.toggle('hidden', !open);
}
function initializeShellUI() {
  const smallScreen = () => matchMedia('(max-width: 760px)').matches;
  const closeSidebar = () => { $('workspace').classList.remove('sidebar-open'); $('sidebarBackdrop').classList.add('hidden'); };
  $('btnSidebar').onclick = () => {
    if (smallScreen()) closeSidebar(); else { $('workspace').classList.add('sidebar-collapsed'); $('btnOpenSidebar').classList.remove('hidden'); }
  };
  $('btnOpenSidebar').onclick = () => {
    if (smallScreen()) { $('workspace').classList.add('sidebar-open'); $('sidebarBackdrop').classList.remove('hidden'); }
    else { $('workspace').classList.remove('sidebar-collapsed'); $('btnOpenSidebar').classList.add('hidden'); }
  };
  $('sidebarBackdrop').onclick = closeSidebar;
  for (const id of ['btnSidebarView', 'btnChatFilters', 'btnViewMembers']) $(id).onclick = () => setSidebarMode('crew');
  $('btnSearchChats').onclick = () => { $('chatSearch').classList.toggle('hidden'); if (!$('chatSearch').classList.contains('hidden')) $('chatSearch').focus(); };
  $('chatSearch').oninput = renderSidebar;
  $('btnBack').onclick = () => navigateConversation(-1); $('btnForward').onclick = () => navigateConversation(1);
  $('btnTogglePanel').onclick = () => setPanelOpen($('btnTogglePanel').getAttribute('aria-expanded') !== 'true');
  $('btnArtifacts').onclick = () => openProjectPanel('reviews');
  $('btnWorkingFolder').onclick = openDomainsTab;
  $('btnReviewQueue').onclick = () => openProjectPanel('reviews');
  document.querySelectorAll('.section-toggle').forEach(button => button.onclick = () => toggleSection(button));
  $('btnContext').onclick = () => { setPanelOpen(true); if ($('contextToggle').getAttribute('aria-expanded') !== 'true') toggleSection($('contextToggle')); };
  $('chatTitle').onclick = () => {
    const channel = S.channels.find(c => c.id === S.cur);
    if (!channel) return;
    openModal(`<h2>${esc(channel.name)}</h2><p class="hint">${channel.type === 'dm' ? '私聊' : '课题组'} · ${channel.members.length} 名成员</p><div class="digest">${esc(channel.topic || '研究者与智能体的协作空间')}</div><label>成员</label><div class="digest">${channel.members.map(esc).join(' · ')}</div><div class="foot"><button class="btn" onclick="closeModal()">关闭</button></div>`);
  };
  $('tbMode').onclick = () => openModal('<h2>Auto · 研究协作</h2><p class="hint">消息中的 @成员 会交给对应智能体执行。</p><div class="digest">选择 #技能 引用研究方法与知识库。\n正式任务从 Projects 派发；产出先交给主人审阅，批准后回到课题组。</div><div class="foot"><button class="btn" onclick="closeModal()">明白了</button></div>');
  $('meCard').onclick = () => {
    openModal(`<h2>${esc(S.me.name)} · SciTag</h2><p class="hint">科研工作台</p><div class="digest">${esc(S.me.persona || '与研究者和智能体一起推进课题。')}</div><div class="foot"><button class="btn" id="logoutAccount">退出登录</button><button class="btn" onclick="closeModal()">关闭</button></div>`);
    $('logoutAccount').onclick = logout;
  };
  $('modal').addEventListener('click', event => { if (event.target === $('modal')) closeModal(); });
  document.addEventListener('keydown', event => {
    if ($('modal').classList.contains('hidden')) return;
    if (event.key === 'Escape') { closeModal(); return; }
    if (event.key !== 'Tab') return;
    const focusable = [...$('modalBody').querySelectorAll('button, input, textarea, select, summary, [tabindex="0"]')].filter(e => !e.disabled && e.getClientRects().length);
    const first = focusable[0], last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  });
  if (matchMedia('(max-width: 1100px)').matches) setPanelOpen(false);
}
