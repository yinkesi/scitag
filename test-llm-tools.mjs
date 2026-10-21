#!/usr/bin/env node
// OpenAI-compatible local fake: exercise the tool protocol with real analysis.
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { getAdapter } from './adapters.mjs';
import { parseCaseParams } from './adapters.mjs';

const caseJob = {
  kind: 'chat', agentName: 'stent-agent', channelName: 'lab', from: '王研',
  domains: ['vascular-stent'], context: { kb: [], skills: [] }, history: [],
  text: '病例：缺损 4.0 mm，目标血管 3.0 mm，病变长度 10 mm，血压 100 mmHg，术式意向：断流栓塞。',
};

test('parseCaseParams extracts only explicit case numbers', () => {
  assert.deepEqual(parseCaseParams(caseJob.text), {
    lesion_mm: 4.0, vessel_mm: 3.0, length_mm: 10, pressure_mmhg: 100,
  });
  assert.deepEqual(parseCaseParams('没有数值的文本'), {});
  assert.equal(parseCaseParams('缺损 4 mm').lesion_mm, 4);
});

test('forceToolCommand pre-executes the real tool once and feeds its JSON to the model', async () => {
  await withModel(() => ({ role: 'assistant', content: '基于工具：需密封力 335.1 mN。' }), async (options, requests) => {
    const result = await getAdapter('llm').exec(caseJob, { ...options, enableTools: true, forceToolCommand: 'concept' });
    assert.equal(result.ok, true);
    assert.equal(requests.length, 1, 'preflight replaces the model-initiated tool round');
    assert.equal(requests[0].body.tools, undefined);
    const prompt = requests[0].body.messages.map((m) => String(m.content || '')).join('\n');
    assert.match(prompt, /\[工具真实输出\]/);
    assert.match(prompt, /required_sealing_force_mn/);
    assert.equal(result.analysisRuns.length, 1);
    assert.equal(result.analysisRuns[0].provenance.command, 'concept');
    assert.equal(result.analysisRuns[0].provenance.domain, 'vascular-stent');
    assert.match(result.text, /335\.1/);
  });
});

test('preflight is skipped when the case text has no lesion size', async () => {
  const noCase = { ...caseJob, text: '请介绍一下你们的域包有哪些能力。' };
  await withModel(() => ({ role: 'assistant', content: '普通回答' }), async (options, requests) => {
    const result = await getAdapter('llm').exec(noCase, { ...options, enableTools: true, forceToolCommand: 'concept' });
    assert.equal(result.ok, true);
    assert.equal(requests.length, 1);
    assert.ok(requests[0].body.tools?.length, 'falls back to normal tool-calling prompt');
    assert.equal(result.analysisRuns?.length || 0, 0);
  });
});

test('after a tool round the follow-up uses a lean context (no KB/skills bloat)', async () => {
  const rich = { ...caseJob, context: { kb: [{ name: 'k', snippet: 'x'.repeat(500) }], skills: [{ name: 's', body: 'y'.repeat(2000) }] } };
  await withModel((n) => n === 1
    ? toolCall({ command: 'concept', lesion_mm: 4 }, 'run_stent_tool')
    : { role: 'assistant', content: '结论' }, async (options, requests) => {
    const result = await getAdapter('llm').exec(rich, options);
    assert.equal(result.ok, true);
    assert.equal(requests.length, 2);
    const followUp = requests[1].body.messages;
    assert.ok(followUp.length <= 5, 'system + case + tool_call + tool result');
    assert.ok(!followUp.some((m) => String(m.content || '').includes('【硬性流程】')));
    assert.ok(followUp.some((m) => m.role === 'tool'));
    assert.equal(result.analysisRuns.length, 1);
  });
});

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
