import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const DOMAINS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'domains');
const COMMANDS = new Set(['stats', 'fit', 'inverse']);

/** Execute only the bundled analysis script; model output is never a shell command. */
export async function runAnalysis({ domain, command, target } = {}, {
  domainsDir = DOMAINS, python = process.env.SCITAG_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
  signal,
} = {}) {
  if (domain !== 'bone-scaffold' || !COMMANDS.has(command)) throw new Error('不支持的分析域或命令');
  if (command === 'inverse' && (typeof target !== 'number' || !Number.isFinite(target) || target <= 0)) {
    throw new Error('逆设计 target 必须是有限正数');
  }
  const domainDir = path.join(domainsDir, domain);
  const script = path.join(domainDir, 'scripts', 'analyze.py');
  const data = path.join(domainDir, 'data', 'BONE_SCAFFOLD.xlsx');
  const hash = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
  const [scriptBytes, dataBytes] = await Promise.all([fs.readFile(script), fs.readFile(data)]);
  // Run immutable snapshots, so the hashes always describe exactly what Python read.
  const snapshot = await fs.mkdtemp(path.join(os.tmpdir(), 'scitag-analysis-'));
  const snapshotScript = path.join(snapshot, 'scripts', 'analyze.py');
  const args = [snapshotScript, command, ...(command === 'inverse' ? ['--target', String(target)] : [])];
  const provenance = {
    domain, command, args: ['scripts/analyze.py', ...args.slice(1)], at: new Date().toISOString(),
    dataSha256: hash(dataBytes), scriptSha256: hash(scriptBytes),
  };
  try {
    await fs.mkdir(path.join(snapshot, 'scripts'));
    await fs.mkdir(path.join(snapshot, 'data'));
    await fs.writeFile(snapshotScript, scriptBytes);
    await fs.writeFile(path.join(snapshot, 'data', 'BONE_SCAFFOLD.xlsx'), dataBytes);
    const result = await new Promise(resolve => {
      const child = spawn(python, args, { cwd: snapshot, shell: false, signal,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let stdout = '', stderr = '', bytes = 0, reason = '';
      const collect = targetStream => chunk => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 256 * 1024) { reason = '分析输出超过上限'; child.kill(); return; }
        if (targetStream === 'stdout') stdout += chunk; else stderr += chunk;
      };
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', collect('stdout')); child.stderr.on('data', collect('stderr'));
      const timer = setTimeout(() => { reason = '分析超时（60秒）'; child.kill(); }, 60_000);
      child.on('error', error => { reason = signal?.aborted ? '分析已取消' : `无法启动 Python：${error.message}`; });
      child.on('close', code => {
        clearTimeout(timer);
        resolve({ ok: code === 0 && !reason, exitCode: code, stdout, stderr, reason });
      });
    });
    Object.assign(provenance, { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr,
      output: [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n') });
    const text = [
      `# ${command} 分析报告`,
      `数据 SHA256：${provenance.dataSha256}`,
      `脚本 SHA256：${provenance.scriptSha256}`,
      `执行参数：${provenance.args.join(' ')}`,
      `执行时间（UTC）：${provenance.at}`,
      '', result.reason, provenance.output,
    ].filter(value => value !== undefined && value !== '').join('\n');
    return { ok: result.ok, text, provenance };
  } finally {
    if (path.dirname(snapshot) !== path.resolve(os.tmpdir()) || !path.basename(snapshot).startsWith('scitag-analysis-')) {
      throw new Error('分析临时目录边界无效');
    }
    await fs.rm(snapshot, { recursive: true, force: true });
  }
}
