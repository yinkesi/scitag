/**
 * research.mjs —— 域包分析执行（快照 + spawn + provenance）
 *
 * v2（2026-10-20）：分析域不再写死。域包在 domain.json 的 `analysis` 块里声明
 * 脚本、数据文件、工具名与命令；本模块按声明校验参数、生成 argv、把脚本与数据
 * 复制成不可变快照后执行 Python，并记录 SHA256/参数/退出码/原始输出。
 *
 * 纪律（继承 v1）：
 *   - 模型输出永远不是 shell 命令：只认 domain.json 声明的命令与参数，argv 数组、不经 shell。
 *   - 快照执行：provenance 里的 hash 必须精确描述 Python 实际读到的字节。
 *   - 输出上限 256 KiB、超时 60 s、失败也保留原始输出，不因模型声称成功而隐藏。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { parseAnalysisSpec, buildArgv, safeDomainName } from './analysis-spec.mjs';

const DOMAINS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'domains');

const hash = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

function isInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * 读取域包分析声明。
 * - 域名非法 / 域包不存在 / 未声明 analysis → 返回 null（调用方报"不支持的分析域或命令"）
 * - 声明本身非法 → 抛错（配置错误必须显式暴露，不静默降级）
 */
export async function loadAnalysisSpec(domain, { domainsDir = DOMAINS } = {}) {
  if (!safeDomainName(domain)) return null;
  const domainDir = path.resolve(domainsDir, domain);
  if (!isInside(domainsDir, domainDir)) return null;
  let raw;
  try { raw = await fs.readFile(path.join(domainDir, 'domain.json'), 'utf8'); } catch { return null; }
  let meta;
  try { meta = JSON.parse(raw); } catch { throw new Error(`域包 ${domain} 的 domain.json 不是有效 JSON`); }
  let spec;
  try { spec = parseAnalysisSpec(meta); } catch (error) {
    throw new Error(`域包 ${domain} 的 analysis 声明无效：${error.message}`);
  }
  return spec ? { spec, domainDir } : null;
}

/** 给 adapters/UI 的便捷封装：只返回声明，不带目录。 */
export async function analysisSpecOf(domain, options = {}) {
  const loaded = await loadAnalysisSpec(domain, options);
  return loaded ? loaded.spec : null;
}

/**
 * 执行域包分析脚本。
 * input: { domain, command, target?, params? } —— target 为旧接口兼容，等价于 params.target。
 */
export async function runAnalysis(input = {}, {
  domainsDir = DOMAINS,
  python = process.env.SCITAG_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
  signal,
} = {}) {
  const domain = input?.domain;
  const command = input?.command;
  const params = { ...(input?.params && typeof input.params === 'object' && !Array.isArray(input.params) ? input.params : {}) };
  if (input?.target !== undefined && params.target === undefined) params.target = input.target;

  const loaded = await loadAnalysisSpec(domain, { domainsDir });
  if (!loaded) throw new Error('不支持的分析域或命令');
  const { spec, domainDir } = loaded;
  if (!spec.commands.has(command)) throw new Error('不支持的分析域或命令');
  const { argv: commandArgs, params: usedParams } = buildArgv(spec, command, params);

  const scriptPath = path.resolve(domainDir, spec.script);
  if (!isInside(domainDir, scriptPath)) throw new Error('分析脚本路径越界');
  const dataPaths = spec.data.map((file) => {
    const resolved = path.resolve(domainDir, file);
    if (!isInside(domainDir, resolved)) throw new Error('分析数据路径越界');
    return { rel: file, abs: resolved };
  });
  const [scriptBytes, ...dataBytes] = await Promise.all([
    fs.readFile(scriptPath),
    ...dataPaths.map((item) => fs.readFile(item.abs)),
  ]);
  const dataEntries = dataPaths.map((item, index) => ({ path: item.rel, sha256: hash(dataBytes[index]) }));

  // Run immutable snapshots, so the hashes always describe exactly what Python read.
  const snapshot = await fs.mkdtemp(path.join(os.tmpdir(), 'scitag-analysis-'));
  const snapshotScript = path.join(snapshot, spec.script);
  const provenance = {
    domain, command, params: usedParams,
    args: [spec.script, ...commandArgs],
    at: new Date().toISOString(),
    // 兼容旧字段：单数据文件时等于该文件 hash；多数据时为首个文件 hash，完整映射见 dataSha256s。
    dataSha256: dataEntries[0]?.sha256 ?? null,
    dataSha256s: Object.fromEntries(dataEntries.map((entry) => [entry.path, entry.sha256])),
    scriptSha256: hash(scriptBytes),
  };
  try {
    await fs.mkdir(path.dirname(snapshotScript), { recursive: true });
    await fs.writeFile(snapshotScript, scriptBytes);
    await Promise.all(dataPaths.map(async (item, index) => {
      const target = path.join(snapshot, item.rel);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, dataBytes[index]);
    }));
    const result = await new Promise((resolve) => {
      const child = spawn(python, [snapshotScript, ...commandArgs], {
        cwd: snapshot, shell: false, signal,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
        stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      });
      let stdout = '', stderr = '', bytes = 0, reason = '';
      const collect = (stream) => (chunk) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 256 * 1024) { reason = '分析输出超过上限'; child.kill(); return; }
        if (stream === 'stdout') stdout += chunk; else stderr += chunk;
      };
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', collect('stdout')); child.stderr.on('data', collect('stderr'));
      const timer = setTimeout(() => { reason = '分析超时（60秒）'; child.kill(); }, 60_000);
      child.on('error', (error) => { reason = signal?.aborted ? '分析已取消' : `无法启动 Python：${error.message}`; });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ ok: code === 0 && !reason, exitCode: code, stdout, stderr, reason });
      });
    });
    Object.assign(provenance, {
      exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr,
      output: [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n'),
    });
    const dataLines = dataEntries.map((entry) =>
      `数据 SHA256（${entry.path}）：${entry.sha256}`);
    const text = [
      `# ${command} 分析报告`,
      ...dataLines,
      `脚本 SHA256：${provenance.scriptSha256}`,
      `执行参数：${provenance.args.join(' ')}`,
      `执行时间（UTC）：${provenance.at}`,
      '', result.reason, provenance.output,
    ].filter((value) => value !== undefined && value !== '').join('\n');
    return { ok: result.ok, text, provenance };
  } finally {
    if (path.dirname(snapshot) !== path.resolve(os.tmpdir()) || !path.basename(snapshot).startsWith('scitag-analysis-')) {
      throw new Error('分析临时目录边界无效');
    }
    await fs.rm(snapshot, { recursive: true, force: true });
  }
}
