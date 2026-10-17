import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { executeLocal, executorCommand } from './worker-executors.mjs';
import http from 'node:http';

/** Honor the computer owner's existing proxy configuration without changing it.
 * https://nodejs.org/api/http.html#httpsetglobalproxyfromenvproxyenv
 * Older Node releases keep their direct-network behavior; proxied clients need
 * Node 24.14+ for this built-in, dependency-free support.
 */
export function configureWorkerNetwork(env = process.env) {
  if (env.NODE_USE_ENV_PROXY === '0' || typeof http.setGlobalProxyFromEnv !== 'function') return null;
  const httpProxy = env.http_proxy || env.HTTP_PROXY;
  const httpsProxy = env.https_proxy || env.HTTPS_PROXY;
  if (!httpProxy && !httpsProxy) return null;
  return http.setGlobalProxyFromEnv({ HTTP_PROXY: httpProxy, HTTPS_PROXY: httpsProxy,
    NO_PROXY: [env.no_proxy || env.NO_PROXY || '', 'localhost', '127.0.0.1', '::1'].filter(Boolean).join(',') });
}
configureWorkerNetwork();

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function writeJson(file, value) {
  fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
}

export async function runWorker(config, { once = false, signal, execute = executeLocal, log = console.log } = {}) {
  const server = new URL(config.server);
  if (server.protocol !== 'https:' && !(server.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(server.hostname))) throw new Error('远程服务器必须使用 HTTPS');
  if (server.username || server.password || server.search || server.hash) throw new Error('server 只能包含服务地址');
  if (typeof config.token !== 'string' || !config.token.trim()) throw new Error('缺少 Agent 凭据');
  config.workspace = fs.realpathSync(config.workspace);
  if (!fs.statSync(config.workspace).isDirectory()) throw new Error('workspace 必须是目录');
  const identity = crypto.createHash('sha256').update(server.origin + config.token).digest('hex').slice(0, 20);
  const directory = path.resolve(config.stateDirectory || path.join(os.homedir(), '.scitag', 'workers', identity));
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = path.join(directory, 'worker.lock');
  if (fs.existsSync(lock)) {
    const pid = Number(fs.readFileSync(lock, 'utf8'));
    let running = false;
    try { process.kill(pid, 0); running = true; } catch (error) { if (error.code !== 'ESRCH') running = true; }
    if (running) throw new Error('这个 Agent 的本地接入程序已经运行');
    fs.unlinkSync(lock);
  }
  fs.writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
  const pendingFile = path.join(directory, 'pending.json');
  const workerId = config.workerId || os.hostname().replace(/[^\w.-]/g, '_').slice(0, 50) + '-' + identity;
  const invalidResponse = message => Object.assign(new Error(message), { status: 502 });
  async function api(endpoint, body) {
    const response = await fetch(server.origin + server.pathname.replace(/\/$/, '') + endpoint, { method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + config.token },
      body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
    let data;
    try { data = await response.json(); }
    catch {
      if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
      throw invalidResponse('服务器响应不是有效 JSON，未确认操作成功');
    }
    if (!response.ok) throw Object.assign(new Error(typeof data?.error === 'string' ? data.error : `HTTP ${response.status}`), { status: response.status });
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw invalidResponse('服务器响应格式无效，未确认操作成功');
    return data;
  }
  async function submit(pending) {
    try {
      const acknowledgement = await api(`/api/worker/jobs/${pending.job.id}/complete`, { leaseToken: pending.job.leaseToken, ...pending.result });
      if (acknowledgement.ok !== true) throw invalidResponse('服务器未确认成果接收，结果保留在本机');
    } catch (error) {
      if (![404, 409].includes(error.status)) throw error;
      writeJson(path.join(directory, pending.job.id + '.stale.json'), pending);
      fs.unlinkSync(pendingFile);
      log('[worker] 旧租约已失效，结果保留在本机');
      return;
    }
    writeJson(path.join(directory, pending.job.id + '.json'), pending);
    fs.unlinkSync(pendingFile);
    log(`[worker] 已回传 ${pending.job.id}`);
  }
  try {
    log(`[worker] 正在连接 ${server.origin}，执行器 ${config.executor}`);
    let ready = execute !== executeLocal, connected = false;
    while (!signal?.aborted) {
      try {
        if (fs.existsSync(pendingFile)) {
          const pending = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
          if (!pending.result) {
            pending.result = { failed: true, text: '本地程序在执行过程中中断，未自动重复执行。请主人检查本地成果后重新派发。' };
            writeJson(pendingFile, pending);
          }
          await submit(pending);
          if (once) break;
        }
        if (signal?.aborted) break;
        // Upload completed journal entries before requiring an installed CLI.
        // New tasks still require a local subprocess check before claiming.
        if (!ready) {
          try {
            executorCommand(config, path.join(directory, 'preflight.answer.md'));
            const probe = await executeLocal({ workspace: config.workspace, executor: 'command',
              command: [process.execPath, '-e', 'process.stdin.resume();process.stdin.on("end",()=>console.log("SCITAG-PREFLIGHT"))'], timeoutMs: 5000 },
            { id: 'preflight', prompt: '' }, directory, signal);
            if (probe.failed) throw new Error('本机启动检查失败，尚未领取远程任务。' + probe.text);
            ready = true;
          } catch (error) { throw Object.assign(error, { localSetup: true }); }
        }
        const claim = await api('/api/worker/jobs/claim', { workerId });
        if (!Object.hasOwn(claim, 'job')) throw invalidResponse('服务器响应缺少作业字段');
        const { job } = claim;
        if (!connected) { log('[worker] 平台连接已确认'); connected = true; }
        if (job === null) { if (once) break; await sleep(config.pollMs || 5000); continue; }
        if (!job || typeof job !== 'object' || !/^r_[a-f0-9]{24}$/.test(job.id) || typeof job.prompt !== 'string' || job.prompt.length > 256000 ||
          typeof job.leaseToken !== 'string' || !job.leaseToken || !Number.isSafeInteger(job.leaseMs) || job.leaseMs < 60000 || job.leaseMs > 600000) {
          throw Object.assign(new Error('服务器作业格式或租约时长无效，未执行本机工具'), { status: 400 });
        }
        const pending = { job, result: null };
        writeJson(pendingFile, pending);
        log(`[worker] 开始 ${job.kind} ${job.id}`);
        const controller = new AbortController();
        const stop = () => controller.abort();
        signal?.addEventListener('abort', stop, { once: true });
        if (signal?.aborted) stop();
        let leaseOk = Date.now(), renewing = false, finished = false;
        let deadline = setTimeout(stop, job.leaseMs - 25000);
        const heartbeat = setInterval(async () => {
          if (renewing) return;
          renewing = true;
          try {
            const acknowledgement = await api(`/api/worker/jobs/${job.id}/heartbeat`, { leaseToken: job.leaseToken });
            // The heartbeat contract returns expiresAt, whereas completion
            // returns ok. Do not compare host clocks to the server timestamp.
            if (!Number.isSafeInteger(acknowledgement.expiresAt) || acknowledgement.expiresAt <= 0) throw invalidResponse('服务器未确认续租');
            if (controller.signal.aborted || finished) return;
            leaseOk = Date.now();
            clearTimeout(deadline);
            deadline = setTimeout(stop, job.leaseMs - 25000);
          } catch (error) {
            if ([401, 403, 404, 409].includes(error.status) || Date.now() - leaseOk > job.leaseMs - 25000) controller.abort();
          } finally { renewing = false; }
        }, 15000);
        try {
          const cachedFile = path.join(directory, job.id + '.stale.json');
          const cached = fs.existsSync(cachedFile) ? JSON.parse(fs.readFileSync(cachedFile, 'utf8')) : null;
          pending.result = cached?.result || await execute(config, job, directory, controller.signal);
          writeJson(pendingFile, pending);
          await submit(pending);
        } finally { finished = true; clearInterval(heartbeat); clearTimeout(deadline); signal?.removeEventListener('abort', stop); }
        if (once) break;
      } catch (error) {
        if (error.localSetup || [400, 401, 403].includes(error.status)) throw error;
        log('[worker] 暂时无法通信，保留本地状态后重试：' + error.message);
        if (once) throw error;
        await sleep(5000);
      }
    }
  } finally { fs.unlinkSync(lock); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf('--config');
  if (index < 0 || !process.argv[index + 1]) {
    console.log('用法：node worker.mjs --config <本地配置.json> [--once]');
    process.exitCode = 1;
  } else {
    const stop = new AbortController();
    process.on('SIGINT', () => stop.abort()); process.on('SIGTERM', () => stop.abort());
    try { await runWorker(JSON.parse(fs.readFileSync(process.argv[index + 1], 'utf8')), { once: process.argv.includes('--once'), signal: stop.signal }); }
    catch (error) { console.error('[worker]', error.message); process.exitCode = 1; }
  }
}
