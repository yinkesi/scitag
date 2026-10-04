/**
 * engine.mjs —— 任务执行队列（SciTag 执行层）
 *
 * 派生自 teammates（D:\code\teammates）server.mjs 的队列机制，改动：
 *   - 抽成独立模块（server 只注入依赖，队列逻辑可独立测试）
 *   - job 分两态：task（工作流任务，产出进 owner 私聊审批）与 chat（群内讨论回复）
 *   - job 上下文由 server 回调 buildContext 注入域包外挂（技能全文 + KB 检索）
 *
 * 纪律（承自 teammates）：
 *   - per-agent FIFO、单并发：一个 agent 同时只干一件活，后到的排队
 *   - 崩溃自愈：重启时 working 一律降级 queued 重新入队（server.loadDb 调 heal）
 *   - 完结 job 落盘封顶裁剪，防止 db.json 无限膨胀
 */
'use strict';
import { getAdapter, parseDirectives } from './adapters.mjs';

const MAX_CHAIN = 3;          // chat 转交连锁上限（超限不再转，防两个 agent 打乒乓）
const JOB_KEEP_DONE = 400;     // 完结 job 保留条数

export function makeEngine(deps) {
  // deps: {
  //   getAgent(name), persist(), save(),
  //   buildContext(agentName, text, skillTags) -> {skills:[{name,body}], kb:[{name,snippet}]},
  //   history(channelId, agentName, n) -> [string],
  //   onTaskReport(taskId, text),        // 任务产出（server 走 transition + 私聊审批卡）
  //   onTaskFail(taskId, reason),
  //   onChatReply(job, cleanText),       // 群聊回复（server 发消息）
  //   onHandoff(job, targetName, text),  // chat 转交（递归入队或忽略）
  //   jobs,                              // db.jobs 数组引用（队列本体落盘）
  // }
  const busy = new Set(); // agentName -> 正在执行（内存态，重启即清）

  function enqueue({ kind, agentName, taskId = null, channel, text, from, skillTags = [], depth = 0 }) {
    const job = {
      id: 'j_' + Math.random().toString(36).slice(2, 9),
      kind, agentName, taskId, channel, text: String(text || '').slice(0, 6000),
      from, skillTags, depth,
      status: 'queued', createdAt: Date.now(),
    };
    deps.jobs.push(job);
    deps.save();
    pump();
    return job;
  }

  function pump() {
    for (const job of deps.jobs) {
      if (job.status !== 'queued') continue;
      if (busy.has(job.agentName)) continue; // 单并发：该 agent 手上有活
      start(job);
    }
  }

  async function start(job) {
    const agent = deps.getAgent(job.agentName);
    const adapter = getAdapter(agent?.adapter?.kind);
    if (!agent || !adapter) {
      job.status = 'failed';
      job.error = agent ? `后端 ${agent?.adapter?.kind} 未注册` : 'agent 不存在';
      deps.save();
      if (job.kind === 'task') deps.onTaskFail(job.taskId, job.error);
      return;
    }
    job.status = 'working';
    job.startedAt = Date.now();
    job.context = deps.buildContext(job.agentName, job.text, job.skillTags);
    busy.add(job.agentName);
    deps.save();

    const res = await adapter.exec(toExecJob(job, agent), agent.adapter.options || {});

    job.status = res.ok ? 'done' : 'failed';
    job.finishedAt = Date.now();
    job.error = res.ok ? undefined : String(res.text || '').slice(0, 300);
    delete job.context; // 注入上下文（技能全文+KB）只活在执行期，完结即弃——防 db.json 无限膨胀
    busy.delete(job.agentName);
    prune();
    deps.save();

    if (job.kind === 'task') {
      if (res.ok) deps.onTaskReport(job.taskId, res.text);
      else deps.onTaskFail(job.taskId, String(res.text || '执行失败'));
    } else if (res.ok) {
      const { cleanText, directives } = parseDirectives(res.text);
      if (cleanText) deps.onChatReply(job, cleanText);
      for (const d of directives) {
        if (d.type !== 'handoff') continue;
        if (job.depth + 1 >= MAX_CHAIN) { // 连锁熔断：转人工提示由 server 在 onHandReply 落消息
          deps.onHandoff(job, null, d.detail);
          continue;
        }
        deps.onHandoff(job, d.title, d.detail);
      }
    }
    pump(); // 让同 agent 的下一个排队 job 立即接上
  }

  function toExecJob(job, agent) {
    return {
      kind: job.kind, agentName: agent.name, persona: agent.persona,
      ownerName: agent.owner || null,
      channelName: job.channelName || job.channel,
      from: job.from, text: job.text,
      taskId: job.taskId,
      taskTitle: job.taskTitle || null,
      context: job.context,
      history: deps.history(job.channel, agent.name, 10),
    };
  }

  function prune() {
    const done = deps.jobs.filter((j) => j.status === 'done' || j.status === 'failed');
    for (const j of done.slice(0, Math.max(0, done.length - JOB_KEEP_DONE))) {
      const i = deps.jobs.indexOf(j);
      if (i !== -1) deps.jobs.splice(i, 1);
    }
  }

  /** 崩溃自愈：重启时把 working 降级 queued（内存 busy 已清空） */
  function heal() {
    let n = 0;
    for (const j of deps.jobs) {
      if (j.status === 'working') { j.status = 'queued'; n++; }
    }
    if (n) deps.save();
    pump();
    return n;
  }

  function stats() {
    const by = { queued: 0, working: 0, done: 0, failed: 0 };
    for (const j of deps.jobs) by[j.status] = (by[j.status] || 0) + 1;
    return by;
  }

  return { enqueue, pump, heal, stats };
}
