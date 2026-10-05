#!/usr/bin/env node
// OpenAI-compatible local fake: exercise the tool protocol with real analysis.
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { getAdapter } from './adapters.mjs';

const job = {
  kind: 'task', agentName: 'research-agent', channelName: 'lab',
  domains: ['bone-scaffold'], text: '分析目标 compliance ≤ 1e-9 的可行设计。',
};
const toolCall = (args, name = 'analyze_scaffold') => ({
  role: 'assistant', content: null,
  tool_calls: [{ id: 'call1', type: 'function', function: { name, arguments: JSON.stringify(args) } }],
});

async function withModel(reply, run) {
  const requests = [];
  const errors = [];
  const server = http.createServer(async (req, res) => {
    try {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      requests.push({ url: req.url, body: JSON.parse(raw) });
      const message = reply(requests.length, requests.at(-1).body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message }] }));
    } catch (e) {
      errors.push(e);
      res.writeHead(500).end(JSON.stringify({ error: String(e) }));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await run({ baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'local-fake', timeoutMs: 15000 }, requests);
    assert.deepEqual(errors, []);
    assert.ok(requests.every((r) => r.url === '/v1/chat/completions'));
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

test('LLM tool round trip runs real inverse analysis and keeps reproducible evidence', async () => {
  await withModel((n) => n === 1
    ? toolCall({ command: 'inverse', target: 1e-9 })
    : { role: 'assistant', content: '# 真分析\n100/100 行满足约束。' }, async (options, requests) => {
    const result = await getAdapter('llm').exec(job, options);
    assert.equal(result.ok, true);
    assert.match(result.text, /100\/100/);
    assert.equal(requests.length, 2);
    const tool = requests[0].body.tools.find((t) => t.function.name === 'analyze_scaffold');
    assert.ok(tool, 'mounted domain exposes the controlled analysis tool');
    assert.deepEqual(tool.function.parameters.properties.command.enum, ['stats', 'fit', 'inverse']);
    assert.equal(tool.function.parameters.properties.target.type, 'number');
    const messages = requests[1].body.messages;
    assert.ok(messages.some((m) => m.role === 'assistant' && m.tool_calls?.[0]?.id === 'call1'));
    const response = messages.find((m) => m.role === 'tool');
    assert.equal(response.tool_call_id, 'call1');
    const run = JSON.parse(response.content);
    assert.equal(run.ok, true);
    assert.match(run.provenance.output, /可行\s*100\/100/);
    assert.match(run.provenance.dataSha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(result.provenance, run.provenance);
    assert.equal(result.analysisRuns.length, 1);
    assert.deepEqual(result.analysisRuns[0].provenance, run.provenance);
  });
});

for (const [label, args, task, name] of [
  ['unknown command', { command: 'stats; echo injected' }, job, 'analyze_scaffold'],
  ['unknown tool', { command: 'stats' }, job, 'run_shell'],
  ['unmounted domain', { command: 'stats' }, { ...job, domains: [] }, 'analyze_scaffold'],
]) {
  test(`reject ${label} with a tool error and no fabricated provenance`, async () => {
    await withModel((n) => n === 1 ? toolCall(args, name)
      : { role: 'assistant', content: '工具拒绝请求，没有产生分析结果。' }, async (options, requests) => {
      const result = await getAdapter('llm').exec(task, options);
      assert.equal(requests.length, 2);
      const response = requests[1].body.messages.find((m) => m.role === 'tool');
      assert.equal(response.tool_call_id, 'call1');
      const run = JSON.parse(response.content);
      assert.equal(run.ok, false);
      assert.ok(!run.provenance);
      assert.ok(!result.provenance);
      assert.equal(result.analysisRuns?.length || 0, 0);
      if (label === 'unmounted domain') assert.ok(!requests[0].body.tools?.length);
    });
  });
}

test('endless tool requests stop after four model requests without a successful report', async () => {
  await withModel(() => toolCall({ command: 'inverse', target: -1 }), async (options, requests) => {
    const result = await getAdapter('llm').exec(job, options);
    assert.equal(result.ok, false);
    assert.equal(requests.length, 4);
    assert.ok(!result.provenance);
    assert.equal(result.analysisRuns?.length || 0, 0);
    assert.ok(result.text, 'failure explains why the loop stopped');
  });
});

test('enableTools=false preserves ordinary compatible-provider text completion', async () => {
  await withModel(() => ({ role: 'assistant', content: '普通回答' }), async (options, requests) => {
    const result = await getAdapter('llm').exec(job, { ...options, enableTools: false });
    assert.equal(result.ok, true);
    assert.equal(result.text, '普通回答');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].body.tools, undefined);
    assert.equal(requests[0].body.tool_choice, undefined);
    assert.ok(!result.provenance);
  });
});
