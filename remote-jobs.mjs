import crypto from 'node:crypto';

export const LEASE_MS = 90_000;
const active = task => task && ['dispatched', 'working'].includes(task.status);
const fail = (status, error) => ({ status, error });

/** Durable queue. All methods are synchronous; the caller commits before replying. */
export function makeRemoteJobs(deps) {
  function enqueue(input) {
    const jobs = deps.jobs();
    const existing = jobs.find(j => j.key === input.key);
    if (existing) return existing;
    const job = { ...input, id: 'r_' + crypto.randomBytes(12).toString('hex'),
      status: 'queued', createdAt: Date.now() };
    jobs.push(job);
    const done = jobs.filter(j => ['done', 'failed', 'cancelled'].includes(j.status));
    for (const old of done.slice(0, Math.max(0, done.length - 400))) jobs.splice(jobs.indexOf(old), 1);
    deps.save();
    return job;
  }
  function eligible(job) {
    if (!deps.canRun(job)) return false;
    if (job.kind !== 'task') return true;
    const task = deps.task(job.taskId);
    return active(task) && task.assignee === job.agentName && task.attempts === job.attempt;
  }
  function claim(agentName, workerId, now = Date.now()) {
    if (typeof workerId !== 'string' || !/^[\w.-]{1,100}$/.test(workerId)) return fail(400, 'workerId 格式无效');
    const jobs = deps.jobs();
    for (const job of jobs) {
      if (job.agentName === agentName && ['queued', 'working'].includes(job.status) && !eligible(job)) {
        job.status = 'cancelled'; deps.save();
      }
    }
    const busy = jobs.find(j => j.agentName === agentName && j.status === 'working' && j.expiresAt > now);
    // Even the same worker must use heartbeat, never restart execution on a repeated claim.
    if (busy) return { status: 200, job: null, busy: true };
    const job = jobs.find(j => j.agentName === agentName &&
      (j.status === 'queued' || (j.status === 'working' && j.expiresAt <= now)) && eligible(j));
    if (!job) return { status: 200, job: null };
    Object.assign(job, { status: 'working', workerId, leaseToken: crypto.randomBytes(24).toString('hex'),
      expiresAt: now + LEASE_MS });
    if (job.kind === 'task') deps.start(job.taskId);
    deps.claimed?.(job);
    deps.save();
    return { status: 200, job: { ...deps.payload(job), id: job.id, kind: job.kind,
      taskId: job.taskId || null, attempt: job.attempt || null,
      leaseToken: job.leaseToken, expiresAt: job.expiresAt, leaseMs: LEASE_MS } };
  }
  function check(agentName, id, token, now, completed = false) {
    const job = deps.jobs().find(j => j.id === id);
    if (!job || job.agentName !== agentName) return fail(404, '作业不存在');
    if (!token || job.leaseToken !== token) return fail(409, '租约已失效');
    if (completed && ['done', 'failed'].includes(job.status)) return { job, duplicate: true };
    if (job.status !== 'working' || job.expiresAt <= now || !eligible(job)) return fail(409, '租约已过期或任务轮次已改变');
    return { job };
  }
  function heartbeat(agentName, id, token, now = Date.now()) {
    const result = check(agentName, id, token, now);
    if (result.error) return result;
    result.job.expiresAt = now + LEASE_MS;
    deps.save();
    return { status: 200, expiresAt: result.job.expiresAt };
  }
  function complete(agentName, id, body, now = Date.now()) {
    const result = check(agentName, id, body.leaseToken, now, true);
    if (result.error) return result;
    if (result.duplicate) return { status: 200, ok: true, duplicate: true };
    if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 20000) return fail(400, '成果须为 1–20000 字符的文本');
    const job = result.job;
    const failed = body.failed === true;
    deps.finish(job, body.text, failed);
    Object.assign(job, { status: failed ? 'failed' : 'done', finishedAt: now });
    deps.save();
    return { status: 200, ok: true };
  }
  function hasLease(taskId) {
    return deps.jobs().some(j => j.taskId === taskId && j.leaseToken && eligible(j));
  }
  function stats() {
    const counts = { queued: 0, working: 0, done: 0, failed: 0 };
    for (const job of deps.jobs()) if (Object.hasOwn(counts, job.status)) counts[job.status]++;
    return counts;
  }
  return { enqueue, claim, heartbeat, complete, hasLease, stats };
}
