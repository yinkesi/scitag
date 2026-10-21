/**
 * analysis-spec.mjs —— 域包「可执行分析」声明（纯函数，无 I/O）
 *
 * 背景：过去 research.mjs 把分析域、脚本路径、命令白名单写死为 bone-scaffold +
 * stats/fit/inverse；adapters.mjs 的 analyze_scaffold 工具同样写死。新增第二个
 * 域包（如 vascular-stent）就必须改平台代码，违背「换领域零改码」。
 *
 * 现在由域包 domain.json 声明：
 *
 *   "analysis": {
 *     "script": "scripts/analyze.py",
 *     "data": ["data/BONE_SCAFFOLD.xlsx"],
 *     "tool": { "name": "analyze_scaffold", "description": "…" },
 *     "commands": [
 *       { "name": "stats", "label": "数据统计", "args": ["stats"] },
 *       { "name": "inverse", "label": "逆设计", "args": ["inverse", "--target", "{target}"],
 *         "params": { "target": { "type": "number", "required": true, "positive": true,
 *                                 "label": "compliance 目标上限", "default": 8e-11 } } }
 *     ]
 *   }
 *
 * 本模块只负责：解析/校验清单、把参数拼成 argv、生成 OpenAI 工具 schema。
 * 执行（快照、spawn、provenance）仍在 research.mjs；HTTP/UI 只读摘要。
 *
 * 安全边界：域包只能声明**相对路径**（脚本/数据），不允许绝对路径或 `..`；
 * 命令与参数名有白名单字符集；参数值逐项类型校验，模型输出永远不能变成 shell。
 */
import path from 'node:path';

const DOMAIN_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const COMMAND_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const PARAM_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const TOOL_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const MAX_COMMANDS = 16;
const MAX_PARAMS = 12;
const MAX_ARGS = 24;
const PARAM_TYPES = new Set(['number', 'string', 'boolean']);

/** 域包目录名/域名的安全校验（防止 ../、绝对路径、NUL）。 */
export function safeDomainName(name) {
  return typeof name === 'string' && DOMAIN_NAME_RE.test(name) && !name.includes('..');
}

/** 域包内相对路径安全校验（脚本、数据文件）。 */
export function safeRelativePath(value, { mustEndWith = null } = {}) {
  if (typeof value !== 'string' || !value || value.length > 200) return false;
  if (value.includes('\0') || value.includes('\\')) return false;
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false;
  const normalized = path.posix.normalize(value);
  if (normalized.startsWith('../') || normalized === '..' || normalized.startsWith('/')) return false;
  if (normalized !== value) return false; // 只接受已规范化的写法，杜绝 ../a 之类
  if (mustEndWith && !normalized.endsWith(mustEndWith)) return false;
  return true;
}

function str(value, max = 240) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function normalizeParam(name, raw) {
  if (!PARAM_NAME_RE.test(name)) throw new Error(`分析参数名无效：${name}`);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`分析参数 ${name} 定义无效`);
  const type = str(raw.type, 16);
  if (!PARAM_TYPES.has(type)) throw new Error(`分析参数 ${name} 的 type 必须是 number/string/boolean`);
  const def = {
    type,
    label: str(raw.label, 60) || name,
    description: str(raw.description, 200),
    required: raw.required === true,
    flag: str(raw.flag, 40),
    default: raw.default === undefined ? undefined : raw.default,
    min: Number.isFinite(raw.min) ? raw.min : undefined,
    max: Number.isFinite(raw.max) ? raw.max : undefined,
    positive: raw.positive === true,
    enum: Array.isArray(raw.enum) ? raw.enum.filter((x) => typeof x === 'string').slice(0, 24) : undefined,
  };
  if (def.flag && !/^--?[A-Za-z][A-Za-z0-9-]{0,38}$/.test(def.flag)) throw new Error(`分析参数 ${name} 的 flag 无效`);
  if (def.enum && def.enum.length && type !== 'string') throw new Error(`分析参数 ${name} 的 enum 只适用于 string`);
  if (type !== 'number') {
    if (def.min !== undefined || def.max !== undefined || def.positive) {
      throw new Error(`分析参数 ${name}：min/max/positive 只适用于 number`);
    }
  }
  return def;
}

/**
 * 解析 domain.json 的 analysis 声明。返回 null 表示该域包不提供可执行分析。
 * 任何非法声明都抛错（服务端启动/扫描时能尽早暴露），而不是静默降级。
 */
export function parseAnalysisSpec(domainJson) {
  const raw = domainJson?.analysis;
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('analysis 必须是对象');

  const script = str(raw.script, 200);
  if (!safeRelativePath(script, { mustEndWith: '.py' })) throw new Error(`analysis.script 必须是 .py 的相对路径：${script || '(空)'}`);
  const data = Array.isArray(raw.data) ? raw.data : [];
  if (data.length > 20) throw new Error('analysis.data 最多 20 个文件');
  const dataFiles = data.map((file, index) => {
    const value = str(file, 200);
    if (!safeRelativePath(value)) throw new Error(`analysis.data[${index}] 路径无效：${value || '(空)'}`);
    return value;
  });

  let tool = null;
  if (raw.tool !== undefined && raw.tool !== null) {
    const name = str(raw.tool?.name, 64);
    if (!TOOL_NAME_RE.test(name)) throw new Error(`analysis.tool.name 无效：${name || '(空)'}`);
    tool = { name, description: str(raw.tool?.description, 400) || `${name} 分析工具` };
  }

  const commands = new Map();
  const list = Array.isArray(raw.commands) ? raw.commands : [];
  if (!list.length) throw new Error('analysis.commands 不能为空');
  if (list.length > MAX_COMMANDS) throw new Error(`analysis.commands 最多 ${MAX_COMMANDS} 个`);
  for (const item of list) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('analysis.commands 条目必须是对象');
    const name = str(item.name, 32).trim();
    if (!COMMAND_NAME_RE.test(name)) throw new Error(`分析命令名无效：${name || '(空)'}`);
    if (commands.has(name)) throw new Error(`分析命令重复：${name}`);
    const argsRaw = Array.isArray(item.args) ? item.args : [];
    if (argsRaw.length > MAX_ARGS) throw new Error(`命令 ${name} 的参数模板过长`);
    const args = argsRaw.map((arg) => {
      const value = str(arg, 200);
      if (!value) throw new Error(`命令 ${name} 的 args 含空字符串`);
      if (/#|;|\||&|`|\$\(|>|</.test(value)) throw new Error(`命令 ${name} 的 args 含可疑字符：${value}`);
      return value;
    });
    const paramsRaw = item.params && typeof item.params === 'object' && !Array.isArray(item.params) ? item.params : {};
    const names = Object.keys(paramsRaw);
    if (names.length > MAX_PARAMS) throw new Error(`命令 ${name} 的参数过多`);
    const params = new Map();
    for (const paramName of names) params.set(paramName, normalizeParam(paramName, paramsRaw[paramName]));
    // 模板里出现的占位符必须是已声明参数；未出现在模板里的参数必须声明 flag（追加式参数）。
    const used = new Set();
    for (const arg of args) {
      for (const match of arg.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)) {
        if (!params.has(match[1])) throw new Error(`命令 ${name} 的模板引用了未声明参数：${match[1]}`);
        used.add(match[1]);
      }
    }
    for (const [paramName, def] of params) {
      if (!used.has(paramName) && !def.flag) throw new Error(`命令 ${name} 的参数 ${paramName} 既未出现在模板里也没有 flag`);
    }
    commands.set(name, {
      name,
      label: str(item.label, 60) || name,
      description: str(item.description, 240),
      args,
      params,
    });
  }
  return { script, data: dataFiles, tool, commands };
}

/** 给 UI / API 的只读摘要（不含本地绝对路径）。 */
export function summarizeAnalysis(spec) {
  if (!spec) return null;
  return {
    tool: spec.tool ? { ...spec.tool } : null,
    data: [...spec.data],
    commands: [...spec.commands.values()].map((command) => ({
      name: command.name,
      label: command.label,
      description: command.description,
      params: [...command.params.entries()].map(([name, def]) => ({
        name, type: def.type, label: def.label, description: def.description,
        required: def.required, enum: def.enum, default: def.default,
        positive: def.positive, min: def.min, max: def.max,
      })),
    })),
  };
}

function validateValue(commandName, name, def, value) {
  if (def.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`参数 ${name} 必须是有限数值`);
    if (def.positive && value <= 0) throw new Error(`参数 ${name} 必须是正数`);
    if (def.min !== undefined && value < def.min) throw new Error(`参数 ${name} 不能小于 ${def.min}`);
    if (def.max !== undefined && value > def.max) throw new Error(`参数 ${name} 不能大于 ${def.max}`);
    return value;
  }
  if (def.type === 'boolean') {
    if (typeof value !== 'boolean') throw new Error(`参数 ${name} 必须是布尔值`);
    return value;
  }
  if (typeof value !== 'string') throw new Error(`参数 ${name} 必须是字符串`);
  if (value.length > 200) throw new Error(`参数 ${name} 过长`);
  if (def.enum && def.enum.length && !def.enum.includes(value)) {
    throw new Error(`参数 ${name} 只能是：${def.enum.join(' / ')}`);
  }
  return value;
}

/**
 * 把命令名 + 参数对象拼成传给脚本的 argv（不含脚本路径）。
 * 未知参数直接拒绝；模板占位符替换后，剩余带 flag 的参数追加到末尾。
 */
export function buildArgv(spec, commandName, params = {}) {
  const command = spec?.commands?.get?.(commandName);
  if (!command) throw new Error('不支持的分析域或命令');
  if (params === undefined || params === null) params = {};
  if (typeof params !== 'object' || Array.isArray(params)) throw new Error('分析参数必须是对象');
  const given = new Map();
  for (const [name, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    const def = command.params.get(name);
    if (!def) throw new Error(`不支持的分析参数：${name}`);
    given.set(name, validateValue(commandName, name, def, value));
  }
  for (const [name, def] of command.params) {
    if (def.required && !given.has(name)) throw new Error(`缺少必填参数：${name}`);
  }
  const used = new Set();
  const argv = command.args.map((arg) => arg.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (_match, name) => {
    used.add(name);
    return String(given.get(name));
  }));
  for (const [name, value] of given) {
    if (used.has(name)) continue;
    const def = command.params.get(name);
    if (!def.flag) continue;
    if (def.type === 'boolean') { if (value) argv.push(def.flag); continue; }
    argv.push(def.flag, String(value));
  }
  return { argv, params: Object.fromEntries(given) };
}

const JSON_TYPE = { number: 'number', string: 'string', boolean: 'boolean' };

/** OpenAI function-calling schema（命令枚举 + 所有命令参数的并集）。 */
export function toolSchema(spec) {
  if (!spec?.tool) return null;
  const properties = {
    command: {
      type: 'string',
      enum: [...spec.commands.keys()],
      description: [...spec.commands.values()]
        .map((command) => `${command.name}${command.description ? `：${command.description}` : ''}`)
        .join('；'),
    },
  };
  for (const command of spec.commands.values()) {
    for (const [name, def] of command.params) {
      if (properties[name]) continue; // 同名参数取首见定义；调用时会按具体命令再校验
      const property = { type: JSON_TYPE[def.type], description: def.description || def.label };
      if (def.enum && def.enum.length) property.enum = def.enum;
      if (def.type === 'number' && def.positive) property.exclusiveMinimum = 0;
      properties[name] = property;
    }
  }
  return {
    name: spec.tool.name,
    description: spec.tool.description,
    parameters: { type: 'object', properties, required: ['command'], additionalProperties: false },
  };
}
