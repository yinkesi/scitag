/**
 * workflow.js —— 课题（Mission）/ 任务（Task）状态机纯函数
 *
 * SciTag 的科研协作环：派活 → 干活 → 私聊汇报 → 主人审批 → 回群 → 汇总。
 * 本模块只做「状态迁移是否合法 + 迁移后的新状态」，不碰 db、不发消息、不落盘；
 * server.js 是唯一调用方，副作用（消息投递/入队）全部在 server 层。
 *
 * 纯函数约定：所有 transition 返回 { ok, task, event, reason? }——
 *   ok=false 时 task 原样返回、event 为 null，reason 供 API 透出。
 *   返回的 task 是浅拷贝，调用方负责写回 db。
 */
'use strict';

export const TASK_STATES = [
  'dispatched', // 已派发，在 agent 队列（或等待外部 runtime 认领）
  'working',    // agent 执行中（engine 启动 adapter / 外部 runtime ack）
  'reported',   // 成果已提交，落在 owner 私聊里等审批
  'approved',   // 主人已批准（瞬态，平台随即自动 publish）
  'rejected',   // 主人驳回（瞬态，平台随即自动 redispatch 或 fail）
  'published',  // 成果已回群（终态，参与汇总）
  'failed',     // 重试耗尽 / 执行失败（终态，转人工）
];

export const MISSION_STATES = ['open', 'closed'];

export const REVIEW_DECISIONS = new Set(['approve', 'reject']);

/** 任务状态徽标（前端与群卡片共用同一口径；配色由前端 st-<status> 类决定） */
export const TASK_BADGE = {
  dispatched: '已派发',
  working: '执行中',
  reported: '待审阅',
  approved: '已批准',
  rejected: '已驳回',
  published: '已回群',
  failed: '失败 · 转人工',
};

const TRANSITIONS = {
  // engine 出队（有宿主执行器的 agent）或外部 runtime ack（POST /api/ack）
  start:    { from: ['dispatched'], to: 'working' },
  // agent 提交成果（engine 代交或外部 runtime POST /api/tasks/:id/report）
  report:   { from: ['dispatched', 'working'], to: 'reported' },
  // 主人审批：approve / reject 两个去向，见 review()
  review:   { from: ['reported'], to: null },
  // 平台自动：批准后成果回群
  publish:  { from: ['approved'], to: 'published' },
  // 平台自动：驳回后回炉（attempts+1，超限则 fail）
  redispatch: { from: ['rejected'], to: 'dispatched' },
  // engine 执行失败 / attempts 耗尽
  fail:     { from: ['dispatched', 'working', 'reported', 'rejected'], to: 'failed' },
};

function can(fromState, action) {
  const t = TRANSITIONS[action];
  return !!t && t.from.includes(fromState);
}

/** 派发新任务（server 构造字段，这里只校验形状） */
export function newTask({ id, missionId, assignee, owner, title, brief, maxAttempts = 2, createdAt = Date.now() }) {
  if (!id || !missionId || !assignee || !owner) throw new Error('task 缺少必要字段');
  return {
    id, missionId, assignee, owner,
    title: String(title || '未命名任务').slice(0, 120),
    brief: String(brief || '').slice(0, 4000),
    initialBrief: String(brief || '').slice(0, 4000),
    status: 'dispatched',
    report: null,          // agent 最近一次提交的成果全文（≤20k）
    review: null,          // { decision, comment, by, at } 最近一次审批
    attempts: 1,           // 第几次执行（含首次）
    maxAttempts,
    publishedSeq: null,    // 回群消息的 seq（published 后有值）
    history: [{ at: createdAt, from: 'dispatched', to: 'dispatched', note: 'created' }],
    createdAt, updatedAt: createdAt,
  };
}

/**
 * 状态迁移统一入口。
 * action ∈ start | report | review | publish | redispatch | fail
 * payload 按动作携带：report{text, by}；review{decision, comment, by}；redispatch{instruction}；fail{reason}
 */
export function transition(task, action, payload = {}) {
  if (!task) return { ok: false, task, event: null, reason: '任务不存在' };
  if (action === 'review') {
    if (task.status !== 'reported') {
      return { ok: false, task, event: null, reason: `任务当前是 ${task.status}，只有待审（reported）状态可以审批` };
    }
    if (!REVIEW_DECISIONS.has(payload.decision)) {
      return { ok: false, task, event: null, reason: 'decision 必须是 approve 或 reject' };
    }
    const next = { ...task, status: payload.decision === 'approve' ? 'approved' : 'rejected',
      review: { decision: payload.decision, comment: String(payload.comment || '').slice(0, 2000), by: payload.by || null, at: Date.now() },
      updatedAt: Date.now() };
    const versions = task.reportVersions?.length ? task.reportVersions :
      [{ attempt: task.attempts, report: task.report, provenance: task.provenance || null, at: task.updatedAt }];
    next.reportVersions = versions.map((version, index) => index === versions.length - 1
      ? { ...version, review: next.review } : version);
    pushHistory(next, task.status, next.status, `review:${payload.decision}`);
    return { ok: true, task: next, event: 'review' };
  }
  if (action === 'report') {
    if (!can(task.status, 'report')) {
      return { ok: false, task, event: null, reason: `任务当前是 ${task.status}，不能提交成果` };
    }
    const text = String(payload.text || '').slice(0, 20000);
    if (!text.trim()) return { ok: false, task, event: null, reason: '成果正文不能为空' };
    const at = Date.now();
    const provenance = payload.provenance || null;
    const analysisRuns = payload.analysisRuns || (provenance ? [{ ok: true, text, provenance }] : []);
    const next = { ...task, status: 'reported', report: text, provenance, analysisRuns, updatedAt: at,
      reportVersions: [...(task.reportVersions || []), { attempt: task.attempts, report: text, provenance,
        analysisRuns, review: null, at }] };
    pushHistory(next, task.status, 'reported', `report by ${payload.by || '?'}`);
    return { ok: true, task: next, event: 'report' };
  }
  if (action === 'redispatch') {
    if (task.status !== 'rejected') {
      return { ok: false, task, event: null, reason: `任务当前是 ${task.status}，只有被驳回的任务可以回炉` };
    }
    if (task.attempts >= task.maxAttempts) {
      const next = { ...task, status: 'failed', updatedAt: Date.now() };
      pushHistory(next, task.status, 'failed', `attempts ${task.attempts}/${task.maxAttempts} 用尽`);
      return { ok: true, task: next, event: 'fail' };
    }
    const next = { ...task, status: 'dispatched', attempts: task.attempts + 1,
      report: null, provenance: null, analysisRuns: [],
      // 驳回意见并进任务书，agent 重做时带着主人的话
      brief: task.brief + `\n\n【主人第 ${task.attempts} 轮审阅意见】${task.review?.comment || '（未填）'}`,
      updatedAt: Date.now() };
    pushHistory(next, task.status, 'dispatched', `redispatch #${next.attempts}`);
    return { ok: true, task: next, event: 'redispatch' };
  }
  if (!can(task.status, action)) {
    return { ok: false, task, event: null, reason: `任务当前是 ${task.status}，不允许 ${action}` };
  }
  const to = TRANSITIONS[action].to;
  const next = { ...task, status: to, updatedAt: Date.now() };
  if (action === 'fail') next.failReason = String(payload.reason || '').slice(0, 500);
  pushHistory(next, task.status, to, action);
  return { ok: true, task: next, event: action };
}

function pushHistory(task, from, to, note) {
  task.history = [...(task.history || []), { at: Date.now(), from, to, note }].slice(-20); // 封顶防爆库
}

/**
 * 权限裁判（三个「只能」）：
 *   只能派活给「有主人且挂了域包」的 agent —— 没主人的 agent 干了活没人审，闭环破
 *   只有 task.owner 能审批
 *   只有 task.assignee 能提交成果
 */
export function canCreateTask(mission, actor, assigneeAgent) {
  if (!mission || mission.status !== 'open') return { ok: false, reason: '课题不存在或已结题' };
  if (mission.leader !== actor) return { ok: false, reason: `只有课题领导（${mission.leader}）可以派活` };
  if (!assigneeAgent || assigneeAgent.kind !== 'agent') return { ok: false, reason: '被派活的必须是 agent' };
  if (!assigneeAgent.owner) return { ok: false, reason: `agent「${assigneeAgent.name}」没有绑定主人（owner），成果将无人审阅` };
  return { ok: true };
}

export function canReview(task, actor) {
  return task.owner === actor
    ? { ok: true }
    : { ok: false, reason: `只有任务主人（${task.owner}）可以审批` };
}

export function canReport(task, actor) {
  return task.assignee === actor
    ? { ok: true }
    : { ok: false, reason: `只有被派活的 agent（${task.assignee}）可以提交成果` };
}

/** 课题进度总览（任务板用） */
export function missionProgress(tasks) {
  const by = {};
  for (const s of TASK_STATES) by[s] = 0;
  for (const t of tasks) by[t.status] = (by[t.status] || 0) + 1;
  const total = tasks.length;
  const done = by.published + by.failed;
  return { total, done, by, pct: total ? Math.round((done / total) * 100) : 0 };
}
