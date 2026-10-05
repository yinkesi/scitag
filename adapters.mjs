/**
 * adapters.mjs —— agent 执行后端注册表（SciTag 执行层）
 *
 * 派生自 teammates（D:\code\teammates）的 adapters.mjs，改动：
 *   - job 形状对齐 SciTag：{ kind: 'task'|'chat', agentName, persona, channelName, from,
 *     text, taskId?, taskTitle?, context: { skills[], kb[] }, history[] }
 *   - 移除 zcode 后端（本机特定），新增 llm 后端（任意 OpenAI 兼容接口，demo 用）
 *   - 保留 [[handoff]] / [[task]] 指令解析（deliberation 阶段群内转交用）
 *
 * 一个「后端」回答一个问题：agent 被派活之后，由谁、怎么产出成果。
 * server.mjs 只认本文件暴露的注册表，新增后端不需要改服务端任何代码：
 *
 *   registerAdapter({
 *     id: 'claude',                    // 唯一 id，agent.adapter.kind 用它
 *     label: 'Claude CLI',             // UI 里展示的名字
 *     available() { return true; },    // 可选：本机是否可用
 *     async exec(job, options) {       // options = agent.adapter.options
 *       return { ok: true, text: '成果正文' };
 *     },
 *   });
 *
 * 约定：exec 收到标准化 job，不把用户输入拼进 shell；spawn 用 argv 数组、绝不经过 shell。
 */
'use strict';
import { spawn } from 'node:child_process';
import { runAnalysis } from './research.mjs';

export const DEFAULT_TIMEOUT_MS = 300_000; // 单任务执行上限（真 harness 级的活给足时间）
export const MAX_OUTPUT = 12_000;          // 成果正文截断（report 上限 20k，留群消息摘要余地）

export function truncate(s, n) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n) + `…（已截断，共 ${s.length} 字符）` : s;
}

/** spawn argv 数组、不经 shell；超时 + 输出截断。返回 {ok, text}。 */
export function runCommand(argv, { timeoutMs = DEFAULT_TIMEOUT_MS, maxOutput = MAX_OUTPUT } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    } catch (err) {
      resolve({ ok: false, text: `无法启动 ${argv[0]}：${String(err).slice(0, 200)}` });
      return;
    }
    let out = '';
    let done = false;
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    const timer = setTimeout(() => {
      if (!done) {
        try { child.kill('SIGKILL'); } catch {}
        finish({ ok: false, text: `执行超时（${Math.round(timeoutMs / 1000)}s），已终止` });
      }
    }, timeoutMs);
    const collect = (chunk) => { if (out.length < maxOutput + 1000) out += chunk.toString('utf8'); };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.on('error', (err) => finish({ ok: false, text: `无法启动 ${argv[0]}（未安装或不在 PATH）：${String(err.message).slice(0, 160)}` }));
    child.on('close', (code) => {
      const text = truncate(out.replace(/\x1b\[[0-9;]*m/g, '').trim(), maxOutput);
      if (text) finish({ ok: true, text });
      else finish({ ok: false, text: `退出码 ${code}，没有任何输出` });
    });
  });
}

/**
 * 组装发给后端的提示词。context 是 engine 注入的域包外挂（技能全文 + KB 检索）。
 * 任务（kind=task）与群聊（kind=chat）两态：前者要正式成果，后者是讨论发言。
 */
export function buildPrompt(job) {
  const ctx = job.context || {};
  const skills = (ctx.skills || []).map((s) =>
    `【外挂技能：${s.name}】\n${s.body}`).join('\n\n');
  const kb = (ctx.kb || []).map((k) =>
    `【知识库·${k.name}】${k.snippet || ''}`).join('\n');
  const hist = job.history?.length
    ? `\n[最近的群聊记录]\n${job.history.slice(-10).join('\n')}`
    : '';
  if (job.kind === 'task') {
    return [
      `你是科研协作群「${job.channelName}」里的研究 agent「${job.agentName}」（主人：${job.ownerName || '未知'}）。`,
      job.persona ? `你的人设：${job.persona}` : '',
      `领导派给你的任务${job.taskTitle ? `（${job.taskTitle}）` : ''}：`,
      '"""',
      job.text,
      '"""',
      skills ? `\n[平台为你在本任务外挂的技能，按其中的步骤与格式干活]\n${skills}` : '',
      kb ? `\n[平台知识库检索结果（节选），更全文可调 GET /api/domains/:d/kb/:name]\n${kb}` : '',
      hist,
      ``,
      `要求：`,
      `1. 产出完整研究成果（markdown）：结论先行、数据留痕（用了哪些行/哪些假设）、给出下一步建议。`,
      `2. 你的成果会先私聊发给你的主人（${job.ownerName || '研究者'}）人工审阅，批准后才回群——请对事实准确性负责，不确定处显式标注「不确定」。`,
      `3. 需要把活转给群里别的 agent 时，单独写一行：[[handoff: agent名 | 要交代的细节]]`,
    ].filter(Boolean).join('\n');
  }
  return [
    `你是科研协作群「${job.channelName}」里的研究 agent「${job.agentName}」。`,
    job.persona ? `你的人设：${job.persona}` : '',
    `「${job.from}」在群里对你说：`,
    '"""',
    job.text,
    '"""',
    skills ? `\n[平台为你在本轮对话外挂的技能]\n${skills}` : '',
    kb ? `\n[平台知识库检索结果（节选）]\n${kb}` : '',
    hist,
    ``,
    `要求：直接输出回群的发言正文（纯文本、简洁、观点明确）。这是群内讨论，不是正式成果。`,
  ].filter(Boolean).join('\n');
}

const DIRECTIVE_RE = /\[\[\s*(handoff|task)\s*[:：]\s*([^\[\]]+?)\s*\]\]/gi;

/** 从回复里剥出指令，返回 {cleanText, directives:[{type,title,detail}]}。 */
export function parseDirectives(text) {
  const directives = [];
  const clean = String(text ?? '').replace(DIRECTIVE_RE, (_m, type, body) => {
    const [rawTitle, ...rest] = String(body).split(/\||｜/);
    directives.push({ type: type.toLowerCase(), title: (rawTitle || '').trim(), detail: rest.join('|').trim() });
    return '';
  });
  return { cleanText: clean.replace(/\n{3,}/g, '\n\n').trim(), directives };
}

/* ------------------------------------------------------------------ */
/* 注册表                                                              */
/* ------------------------------------------------------------------ */

const ADAPTERS = new Map();

export function registerAdapter(adapter) {
  if (!adapter?.id || typeof adapter.exec !== 'function') throw new Error('adapter 需要 { id, exec }');
  ADAPTERS.set(adapter.id, adapter);
}

export function getAdapter(id) { return ADAPTERS.get(id) || null; }

/** 给 UI 的后端下拉框：[{id,label,available}] */
export function listBackends() {
  return [...ADAPTERS.values()].map((a) => ({
    id: a.id, label: a.label || a.id,
    available: a.available ? !!a.available() : true,
  }));
}

/* ------------------------------------------------------------------ */
/* 内置后端 1：echo（演示 / 测试 / 冒烟——离线也能跑通完整工作流）        */
/* ------------------------------------------------------------------ */

registerAdapter({
  id: 'echo',
  label: 'Echo（离线演示后端）',
  async exec(job, options = {}) {
    if (options.delayMs) await new Promise((r) => setTimeout(r, Math.min(+options.delayMs || 0, 20_000)));
    const ctx = job.context || {};
    const skillNames = (ctx.skills || []).map((s) => s.name).join('、') || '无';
    const kbNames = (ctx.kb || []).map((k) => k.name).join('、') || '无';
    if (job.kind === 'task') {
      return {
        ok: true,
        text: [
          `# 成果报告（echo 演示后端产出）`,
          ``,
          `**任务**：${job.taskTitle || job.text.slice(0, 40)}`,
          `**使用外挂技能**：${skillNames}`,
          `**参考知识库**：${kbNames}`,
          ``,
          `## 结论`,
          `（演示模式）我已按「${skillNames}」的流程梳理任务并检索了知识库，`,
          `正文要点：${job.text.slice(0, 120)}…`,
          ``,
          `## 数据留痕`,
          `- 本报告由 echo 后端生成，用于链路演示；接上 llm/真 harness 后端即产出真实分析。`,
          `- 主人批注区：请审阅后 approve（回群）或 reject（我带意见重做）。`,
        ].join('\n'),
      };
    }
    const tpl = options.template || '（echo）收到「{from}」的话：{text}；本轮外挂技能：{skills}';
    const text = tpl
      .replaceAll('{text}', () => job.text)
      .replaceAll('{from}', () => job.from)
      .replaceAll('{channel}', () => job.channelName)
      .replaceAll('{name}', () => job.agentName)
      .replaceAll('{skills}', () => skillNames);
    return { ok: true, text: truncate(text, MAX_OUTPUT) };
  },
});

/* ------------------------------------------------------------------ */
/* 内置后端 2：llm（任意 OpenAI 兼容 /chat/completions）                */
/* ------------------------------------------------------------------ */

registerAdapter({
  id: 'analysis',
  label: '科研分析（真实数据计算）',
  async exec(job, options = {}) {
    const domain = options.domain || 'bone-scaffold';
    if (!job.domains?.includes(domain)) return { ok: false, text: `agent 未挂载分析域 ${domain}` };
    const result = await runAnalysis({ domain, command: options.command || 'stats', target: options.target });
    return { ...result, analysisRuns: [result] };
  },
});

registerAdapter({
  id: 'llm',
  label: 'LLM（OpenAI 兼容接口）',
  async exec(job, options = {}) {
    const baseUrl = String(options.baseUrl || '').replace(/\/$/, '');
    const model = String(options.model || '');
    if (!baseUrl || !model) return { ok: false, text: 'llm 后端缺少 baseUrl / model 配置' };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), options.timeoutMs || 120_000);
    const analysisRuns = [];
    const evidence = () => ({ analysisRuns, provenance: analysisRuns.at(-1)?.provenance || null });
    const enabled = options.enableTools !== false && job.domains?.includes('bone-scaffold');
    const tools = enabled ? [{ type: 'function', function: {
      name: 'analyze_scaffold', description: '实际计算骨支架数据的统计、拟合或 compliance ≤ target 逆设计。',
      parameters: { type: 'object', properties: {
        command: { type: 'string', enum: ['stats', 'fit', 'inverse'] },
        target: { type: 'number', description: 'inverse 必填，有限正数' },
      }, required: ['command'], additionalProperties: false },
    } }] : undefined;
    const messages = [
      { role: 'system', content: '你是一个严谨的科研协作 agent，成果供人类研究者审阅。涉及数值计算时须调用可用的分析工具，以其真实输出为依据。工具失败要明确说明，禁止编造计算结果。' },
      { role: 'user', content: buildPrompt(job) },
    ];
    try {
      for (let round = 0; round < 4; round++) {
      const r = await fetch(baseUrl + '/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(options.apiKey ? { authorization: 'Bearer ' + options.apiKey } : {}),
        },
        body: JSON.stringify({
          model,
          messages, ...(tools ? { tools, parallel_tool_calls: false } : {}),
          temperature: options.temperature ?? 0.3,
        }),
        signal: ctrl.signal,
      });
      const j = await r.json().catch(() => null);
      const message = j?.choices?.[0]?.message;
      if (!r.ok) return { ok: false, text: `llm 返回 HTTP ${r.status}：${truncate(JSON.stringify(j).slice(0, 300), 300)}`, ...evidence() };
      if (message?.tool_calls?.length) {
        if (message.tool_calls.length > 4) return { ok: false, text: '本轮工具调用数量超过上限', ...evidence() };
        messages.push({ role: 'assistant', content: message.content || null, tool_calls: message.tool_calls });
        for (const call of message.tool_calls) {
          let result;
          try {
            if (!enabled || call.function?.name !== 'analyze_scaffold') throw new Error('工具未授权或不存在');
            const input = JSON.parse(call.function.arguments);
            if (!input || Array.isArray(input) || Object.keys(input).some(k => !['command', 'target'].includes(k))) {
              throw new Error('工具参数形状无效');
            }
            result = await runAnalysis({ domain: 'bone-scaffold', command: input.command, target: input.target }, { signal: ctrl.signal });
            analysisRuns.push(result);
          } catch (error) { result = { ok: false, text: String(error?.message || error) }; }
          messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
        }
        continue;
      }
      if (!message?.content) return { ok: false, text: 'llm 返回空内容', ...evidence() };
      return { ok: true, text: truncate(message.content, MAX_OUTPUT), ...evidence() };
      }
      return { ok: false, text: '分析工具对话达到上限（4次模型请求），请缩小任务范围', ...evidence() };
    } catch (e) {
      const msg = String(e?.message || e);
      return { ok: false, text: 'llm 调用失败：' + (ctrl.signal.aborted ? `请求超时/中断（${msg}）` : msg.slice(0, 200)), ...evidence() };
    } finally {
      clearTimeout(timer);
    }
  },
});

/* ------------------------------------------------------------------ */
/* 内置后端 3：webhook（第三方 agent / 远程 harness 的预留通道）         */
/* ------------------------------------------------------------------ */

registerAdapter({
  id: 'webhook',
  label: 'Webhook（HTTP 接入）',
  async exec(job, options = {}) {
    if (!options.url) return { ok: false, text: 'webhook 后端缺少 url 配置' };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), options.timeoutMs || 120_000);
    try {
      const r = await fetch(options.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(options.token ? { authorization: 'Bearer ' + options.token } : {}),
        },
        body: JSON.stringify({ job, prompt: buildPrompt(job) }),
        signal: ctrl.signal,
      });
      const raw = await r.text();
      let text = raw;
      try { const j = JSON.parse(raw); text = j.text ?? j.report ?? j.reply ?? raw; } catch {}
      if (!r.ok) return { ok: false, text: `webhook 返回 HTTP ${r.status}：${truncate(text, 300)}` };
      return { ok: true, text: truncate(text, MAX_OUTPUT) };
    } catch (e) {
      return { ok: false, text: 'webhook 调用失败：' + String(e?.message || e).slice(0, 200) };
    } finally {
      clearTimeout(timer);
    }
  },
});
