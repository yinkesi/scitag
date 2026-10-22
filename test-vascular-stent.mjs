#!/usr/bin/env node
// vascular-stent 域包的平台接线：analysis 后端 + llm 工具注册/调用（不需要真实模型）。
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { getAdapter } from './adapters.mjs';

const job = {
  kind: 'task', agentName: '支架分析员', ownerName: '支架组PI', channelName: 'lab',
  domains: ['vascular-stent'], taskId: 't_stent', taskTitle: '支架材料与验证',
  text: '比较 PLLA/PLGA/WE43 并给出 V0 验证方案。',
};
const toolCall = (args, name = 'run_stent_tool') => ({
  role: 'assistant', content: null,
  tool_calls: [{ id: 'call_stent', type: 'function', function: { name, arguments: JSON.stringify(args) } }],
});

async function withModel(reply, run) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push(JSON.parse(raw));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: reply(requests.length) }] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await run({ baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'local-fake', timeoutMs: 15000 }, requests);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

test('analysis adapter runs the domain-declared stent tool with provenance', async () => {
  const result = await getAdapter('analysis').exec(job, {
    domain: 'vascular-stent', command: 'materials', params: { family: 'polymer' },
  });
  assert.equal(result.ok, true);
  assert.match(result.text, /PLLA/);
  assert.equal(result.analysisRuns.length, 1);
  assert.equal(result.provenance.domain, 'vascular-stent');
  assert.equal(result.provenance.command, 'materials');
  assert.match(result.provenance.dataSha256, /^[a-f0-9]{64}$/);
  assert.equal(Object.keys(result.provenance.dataSha256s).length, 2);
  assert.ok(result.provenance.args.includes('--family') && result.provenance.args.includes('polymer'));
});

test('analysis adapter runs the concept screen for a patient case', async () => {
  const result = await getAdapter('analysis').exec(job, {
    domain: 'vascular-stent', command: 'concept',
    params: { lesion_mm: 4, vessel_mm: 3, location: '肝动脉右支' },
  });
  assert.equal(result.ok, true);
  assert.match(result.text, /封堵/);
  assert.equal(result.provenance.command, 'concept');
  assert.ok(result.provenance.args.includes('--lesion-mm') && result.provenance.args.includes('4'));
  assert.equal(result.provenance.params.lesion_mm, 4);
  assert.equal(result.analysisRuns.length, 1);
});

test('analysis adapter runs the FDO material screen with per-polymer physical indicators', async () => {
  const result = await getAdapter('analysis').exec(job, {
    domain: 'vascular-stent', command: 'fdo',
    params: { release_days: 7, horizon_days: 90, orifice_mm: 0.71 },
  });
  assert.equal(result.ok, true);
  assert.match(result.text, /polyanhydride|PLGA/);
  assert.match(result.text, /t_crit|质量损失|孔径漂移/);
  assert.equal(result.provenance.command, 'fdo');
  assert.equal(result.provenance.params.orifice_mm, 0.71);
  assert.equal(result.analysisRuns.length, 1);
});

test('analysis adapter rejects a domain the agent has not mounted', async () => {
  const result = await getAdapter('analysis').exec({ ...job, domains: ['bone-scaffold'] }, {
    domain: 'vascular-stent', command: 'flow', params: { q: 100 },
  });
  assert.equal(result.ok, false);
  assert.match(result.text, /未挂载分析域/);
});

test('llm backend exposes one tool per mounted analysis domain and runs it', async () => {
  await withModel((n) => n === 1
    ? toolCall({ command: 'ring', E: 44.2, t: 120 })
    : { role: 'assistant', content: '# 完成\n薄环 k_line 已按真实工具计算。' }, async (options, requests) => {
    const result = await getAdapter('llm').exec(job, options);
    assert.equal(result.ok, true);
    const tools = requests[0].tools;
    assert.ok(Array.isArray(tools) && tools.length === 1, 'one mounted domain → one tool');
    const tool = tools[0].function;
    assert.equal(tool.name, 'run_stent_tool');
    assert.deepEqual(tool.parameters.properties.command.enum, ['materials', 'ring', 'flow', 'concept', 'fdo', 'verify', 'all']);
    assert.equal(tool.parameters.properties.E.type, 'number');
    assert.equal(tool.parameters.properties.family.enum.join(','), 'Mg,Zn,Fe,polymer');
    const response = requests[1].messages.find((m) => m.role === 'tool');
    assert.equal(response.tool_call_id, 'call_stent');
    const run = JSON.parse(response.content);
    assert.equal(run.ok, true);
    assert.equal(run.provenance.domain, 'vascular-stent');
    assert.equal(run.provenance.scriptSha256.length, 64);
    assert.equal(result.analysisRuns.length, 1);
  });
});

test('llm backend keeps bone-scaffold tooling for agents mounted on it', async () => {
  await withModel((n) => n === 1
    ? toolCall({ command: 'stats' }, 'analyze_scaffold')
    : { role: 'assistant', content: '统计完成' }, async (options, requests) => {
    const result = await getAdapter('llm').exec({ ...job, domains: ['bone-scaffold'] }, options);
    assert.equal(result.ok, true);
    const tool = requests[0].tools[0].function;
    assert.equal(tool.name, 'analyze_scaffold');
    assert.deepEqual(tool.parameters.properties.command.enum, ['stats', 'fit', 'inverse']);
    const run = JSON.parse(requests[1].messages.find((m) => m.role === 'tool').content);
    assert.match(run.provenance.dataSha256, /^[a-f0-9]{64}$/);
  });
});

test('llm backend rejects tools that are not mounted and stays honest on failure', async () => {
  await withModel((n) => n === 1
    ? toolCall({ command: 'ring', E: 44.2, t: 120 }, 'analyze_scaffold')
    : { role: 'assistant', content: '工具不可用，未产生数值。' }, async (options, requests) => {
    const result = await getAdapter('llm').exec(job, options);
    assert.equal(result.ok, true);
    const run = JSON.parse(requests[1].messages.find((m) => m.role === 'tool').content);
    assert.equal(run.ok, false);
    assert.match(run.text, /工具未授权或不存在/);
    assert.equal(result.analysisRuns.length, 0);
  });
});

test('llm backend sends no tools when enableTools=false', async () => {
  await withModel(() => ({ role: 'assistant', content: '普通回答' }), async (options, requests) => {
    const result = await getAdapter('llm').exec(job, { ...options, enableTools: false });
    assert.equal(result.ok, true);
    assert.equal(requests[0].tools, undefined);
  });
});
