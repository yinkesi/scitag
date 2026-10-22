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
import { runAnalysis, loadAnalysisSpec } from './research.mjs';
import { toolSchema } from './analysis-spec.mjs';

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

/** 从自由文本里抽 FDO 材料筛选参数（缺省用设计扫描值）。 */
export function parseFdoParams(text) {
  const num = (re, fallback) => {
    const m = String(text || '').match(re);
    return m ? Number(m[1]) : fallback;
  };
  return {
    release_days: num(/(?:释放|release)[^\d]{0,10}(\d+(?:\.\d+)?)\s*(?:天|d|day)/i, 7),
    horizon_days: num(/(?:服役|horizon|service)[^\d]{0,12}(\d+(?:\.\d+)?)\s*(?:天|d|day)/i, 90),
    orifice_mm: num(/(?:孔口|orifice)[^\d]{0,10}(\d+(?:\.\d+)?)\s*mm/i, 0.71),
  };
}

const DIRECTIVE_RE = /\[\[\s*(handoff|task)\s*[:：]\s*([^\[\]]+?)\s*\]\]/gi;

/** 从自由文本里抽病例参数（预执行工具用；只认明确的数值表述）。 */
export function parseCaseParams(text) {
  const num = (re) => {
    const m = String(text || '').match(re);
    return m ? Number(m[1]) : undefined;
  };
  const params = {};
  const lesion = num(/(?:缺损|病变)[^\d]{0,12}(\d+(?:\.\d+)?)\s*mm/i);
  const vessel = num(/(?:目标血管|血管直径)[^\d]{0,12}(\d+(?:\.\d+)?)\s*mm/i);
  const length = num(/(?:病变长度|长度)[^\d]{0,12}(\d+(?:\.\d+)?)\s*mm/i);
  const pressure = num(/(\d+(?:\.\d+)?)\s*mmHg/i);
  if (lesion !== undefined) params.lesion_mm = lesion;
  if (vessel !== undefined) params.vessel_mm = vessel;
  if (length !== undefined) params.length_mm = length;
  if (pressure !== undefined) params.pressure_mmhg = pressure;
  const loc = String(text || '').match(/(?:肿瘤位置|位置|部位)[「:：]?\s*([^，。；\n]{2,30})/);
  if (loc) params.location = loc[1].trim();
  return params;
}

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
    const domain = String(options.domain || 'bone-scaffold');
    if (!job.domains?.includes(domain)) return { ok: false, text: `agent 未挂载分析域 ${domain}` };
    const params = { ...(options.params && typeof options.params === 'object' && !Array.isArray(options.params) ? options.params : {}) };
    if (options.target !== undefined && params.target === undefined) params.target = options.target;
    const result = await runAnalysis({ domain, command: options.command, params });
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
    const timer = setTimeout(() => ctrl.abort(), options.timeoutMs || 240_000);
    const analysisRuns = [];
    const evidence = () => ({ analysisRuns, provenance: analysisRuns.at(-1)?.provenance || null });
    // 挂载了哪些域包，就按域包的 analysis 声明注册哪些工具（不再写死 bone-scaffold）。
    const mounted = [];
    if (options.enableTools !== false) {
      for (const domain of job.domains || []) {
        let loaded = null;
        try { loaded = await loadAnalysisSpec(domain); } catch (error) {
          console.error(`[llm:analysis-spec] ${domain}:`, error.message);
        }
        if (!loaded?.spec?.tool) continue;
        const schema = toolSchema(loaded.spec);
        if (!schema || mounted.some((item) => item.schema.name === schema.name)) continue;
        mounted.push({ domain, spec: loaded.spec, schema });
      }
    }
    let tools = mounted.length
      ? mounted.map((item) => ({ type: 'function', function: item.schema }))
      : undefined;
    // 预执行工具：避免模型「假装调用」，也避免第二轮长上下文把 8GB 显卡打爆。
    // 支持多个命令（例如 concept + fdo）：一次把真实 JSON 都喂给模型。
    const forcedCommands = options.forceToolCommands
      || (options.forceToolCommand ? [options.forceToolCommand] : []);
    const preflights = [];
    if (forcedCommands.length && mounted.length && job.kind === 'chat') {
      for (const cmd of forcedCommands) {
        const tool = mounted.find((item) => item.spec.commands.has(cmd));
        if (!tool) continue;
        let params;
        if (cmd === 'concept') {
          params = parseCaseParams(String(job.text || ''));
          if (params.lesion_mm === undefined) continue;
        } else if (cmd === 'fdo') {
          params = parseFdoParams(String(job.text || ''));
        } else {
          params = {};
        }
        try {
          const run = await runAnalysis({ domain: tool.domain, command: cmd, params }, { signal: ctrl.signal });
          preflights.push(run);
          analysisRuns.push(run);
        } catch (error) {
          preflights.push({ ok: false, text: String(error?.message || error) });
        }
      }
    }
    const preflight = preflights.length
      ? (preflights.length === 1 ? preflights[0] : { ok: preflights.every((p) => p.ok), results: preflights })
      : null;
    if (preflight) tools = undefined;
    const preflightText = preflights.map((r, i) => `[工具${i + 1} 真实输出]\n${JSON.stringify(r).slice(0, 2500)}`).join('\n\n');
    const messages = preflight ? [
      { role: 'system', content: '你是严谨的科研协作 agent。下面是分析工具的真实运行结果，必须只依据它们作答并引用其中具体数字；不得编造，工具失败时如实说明。' },
      { role: 'user', content: `病例：${String(job.text || '').slice(0, 800)}\n\n${preflightText}\n\n请用不超过 6 条要点回答：A/B 概念结论；密封力（静压载荷用 mN，所需密封力用 N）；材料短名单；材料物理指标表（聚合物 / t_crit 天 / 90 天质量损失 / 90 天孔径漂移 / 释放指数 n / 判定）；数据缺口。单位必须写清：径向力用 N，力裕度无量纲，载荷用 mN。不要复述工具 JSON 原文。` },
    ] : [
      { role: 'system', content: '你是一个严谨的科研协作 agent，成果供人类研究者审阅。涉及数值计算时须调用可用的分析工具，以其真实输出为依据。工具失败要明确说明，禁止编造计算结果。' },
      { role: 'user', content: buildPrompt(job) },
      ...(tools ? [{ role: 'user', content: '【硬性流程】本任务包含数值/病例参数。你必须通过 tool_calls 调用分析工具（如 run_stent_tool，command=concept 或对应命令，参数按 schema 填）取得真实计算结果，再给出结论；结论中必须引用工具返回的具体数字（如静压载荷 xxx mN、所需密封力 xxx mN、材料短名单）。禁止在正文里写伪命令或伪造工具输出；工具失败时如实说明失败与数据缺口。' }] : []),
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
          max_tokens: options.maxTokens ?? 700,
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
            const tool = mounted.find((item) => item.schema.name === call.function?.name);
            if (!tool) throw new Error('工具未授权或不存在');
            const input = JSON.parse(call.function.arguments);
            if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('工具参数形状无效');
            const { command, ...params } = input;
            result = await runAnalysis({ domain: tool.domain, command, params }, { signal: ctrl.signal });
            analysisRuns.push(result);
          } catch (error) { result = { ok: false, text: String(error?.message || error) }; }
          const toolText = JSON.stringify(result);
          messages.push({ role: 'tool', tool_call_id: call.id, content: toolText.length > 4000 ? toolText.slice(0, 4000) : toolText });
        }
        // 工具结果已拿到：第二轮改用精简上下文（只留原始提问 + 工具结果），避免长 KB/技能把 8GB 显卡打爆。
        if (round === 0) {
          const system = messages[0];
          const assistant = messages.find((m) => m.role === 'assistant' && m.tool_calls);
          const toolMsgs = messages.filter((m) => m.role === 'tool');
          const lean = [system, { role: 'user', content: String(job.text || '').slice(0, 2000) }, assistant, ...toolMsgs];
          messages.splice(0, messages.length, ...lean);
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
    const timer = setTimeout(() => ctrl.abort(), options.timeoutMs || 240_000);
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


