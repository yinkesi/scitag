import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRemoteJobs, LEASE_MS } from './remote-jobs.mjs';

function fixture() {
  const jobs = [], tasks = { t: { id: 't', status: 'dispatched', assignee: 'agent', attempts: 1 } }, reports = [];
  const queue = makeRemoteJobs({ jobs: () => jobs, task: id => tasks[id], save() {},
    canRun: () => true, start: id => { tasks[id].status = 'working'; }, payload: () => ({ prompt: 'do it' }),
    finish: (job, text) => { reports.push(text); tasks[job.taskId].status = 'reported'; } });
  queue.enqueue({ key: 't:1', kind: 'task', taskId: 't', attempt: 1, agentName: 'agent' });
  return { queue, jobs, tasks, reports };
}

test('exclusive claim, durable rehydration, heartbeat and stale-result fencing', () => {
  const { queue, jobs } = fixture();
  const first = queue.claim('agent', 'computer-a', 100).job;
  assert.equal(queue.claim('agent', 'computer-b', 101).job, null);
  assert.equal(queue.claim('agent', 'computer-a', 101).job, null);
  assert.equal(queue.heartbeat('agent', first.id, first.leaseToken, 200).status, 200);
  assert.equal(queue.claim('agent', 'computer-b', LEASE_MS + 150).job, null);
  const next = queue.claim('agent', 'computer-b', LEASE_MS + 201).job;
  assert.notEqual(next.leaseToken, first.leaseToken);
  assert.equal(queue.complete('agent', first.id, { leaseToken: first.leaseToken, text: 'stale' }, LEASE_MS + 202).status, 409);
  assert.equal(jobs.length, 1);
});

test('completion is idempotent and another agent cannot submit', () => {
  const { queue, reports, tasks } = fixture();
  const job = queue.claim('agent', 'a', 100).job;
  const body = { leaseToken: job.leaseToken, text: 'report' };
  assert.equal(queue.complete('intruder', job.id, body, 101).status, 404);
  assert.equal(queue.complete('agent', job.id, body, 101).ok, true);
  assert.equal(queue.complete('agent', job.id, body, 102).duplicate, true);
  assert.deepEqual(reports, ['report']);
  tasks.t.status = 'dispatched'; tasks.t.attempts++;
  queue.enqueue({ key: 't:2', kind: 'task', taskId: 't', attempt: 2, agentName: 'agent' });
  assert.equal(queue.claim('agent', 'a', 103).job.attempt, 2);
});
