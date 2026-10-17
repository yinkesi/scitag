import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { runWorker } from './worker.mjs';
import { executeLocal } from './worker-executors.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const types = { '/': 'text/html; charset=utf-8', '/index.html': 'text/html; charset=utf-8',
  '/app.js': 'text/javascript; charset=utf-8', '/workspace.js': 'text/javascript; charset=utf-8', '/entry.js': 'text/javascript; charset=utf-8',
  '/style.css': 'text/css; charset=utf-8', '/brand.svg': 'image/svg+xml', '/worker-client.zip': 'application/zip' };
const browserHeaders = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" };

export function connectionURL(server, pathname) {
  const base = new URL(server);
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))) throw new Error('入口必须使用 HTTPS');
  if (base.username || base.password || base.search || base.hash) throw new Error('入口地址无效');
  if (!pathname.startsWith('/') || pathname.startsWith('//')) throw new Error('路径无效');
  return base.origin + base.pathname.replace(/\/$/, '') + pathname;
}

export async function startGateway(server, { fetcher = fetch, assetDirectory = path.join(root, 'ui') } = {}) {
  connectionURL(server, '/');
  const localAssets = assetDirectory && fs.existsSync(assetDirectory) ? path.resolve(assetDirectory) : null;
  const gateway = http.createServer(async (req, res) => {
    const origin = `http://127.0.0.1:${gateway.address().port}`;
    const fail = (status, error) => { if (res.destroyed || res.writableEnded) return; res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error })); };
    if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site') return fail(403, '仅允许本机协作网页访问');
    if (!['GET', 'POST'].includes(req.method)) return fail(405, '不支持的操作');
    let url;
    try { url = new URL(req.url, origin); } catch { return fail(400, '请求地址无效'); }
    if (url.origin !== origin || (!url.pathname.startsWith('/api/') && !Object.hasOwn(types, url.pathname))) return fail(404, '入口不存在');
    try {
      if (req.method === 'GET' && localAssets && Object.hasOwn(types, url.pathname) && url.pathname !== '/worker-client.zip') {
        const file = path.join(localAssets, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
        let body;
        try { body = await fs.promises.readFile(file); }
        catch { return fail(503, '接入包界面文件缺失，请重新解压完整接入包后启动'); }
        res.writeHead(200, { ...browserHeaders, 'content-type': types[url.pathname] });
        return res.end(body);
      }
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 256000) return fail(413, '请求内容过长');
        chunks.push(chunk);
      }
      const headers = {};
      for (const name of ['authorization', 'content-type', 'accept']) if (req.headers[name]) headers[name] = req.headers[name];
      const response = await fetcher(connectionURL(server, url.pathname + url.search), {
        method: req.method, headers, redirect: 'error', signal: AbortSignal.timeout(30000),
        body: req.method === 'POST' ? Buffer.concat(chunks) : undefined,
      });
      const contentType = types[url.pathname] || response.headers.get('content-type') || 'application/json';
      // Supabase deliberately marks Edge HTML as a non-executable download.
      // This loopback web origin owns its own policy; all resources and API
      // calls stay on this origin, with no third-party scripts or frames.
      const outputHeaders = { ...browserHeaders, 'content-type': contentType };
      let body = Buffer.from(await response.arrayBuffer());
      if (url.pathname === '/api/config' && response.ok) {
        body = Buffer.from(JSON.stringify({ ...JSON.parse(body.toString()), workerServer: server }));
      }
      res.writeHead(response.status, outputHeaders); res.end(body);
    } catch { fail(502, '当前网络无法连接协作服务。运行接入包的网络检查；如需代理，请由电脑主人设置已有的 HTTPS_PROXY。'); }
  });
  await new Promise((resolve, reject) => { gateway.once('error', reject); gateway.listen(0, '127.0.0.1', resolve); });
  return { server: gateway, url: `http://127.0.0.1:${gateway.address().port}` };
}

export async function diagnose(connection, log = console.log) {
  let ok = false;
  for (const [label, server] of [['备用入口', connection.server], ['原网址', connection.directServer]]) {
    if (!server) continue;
    try {
      const response = await fetch(connectionURL(server, '/api/config'), { redirect: 'error', signal: AbortSignal.timeout(10000) });
      const config = await response.json();
      const ready = response.ok && config.ready === true;
      log(`${label}：${ready ? '可连接' : '服务尚未就绪或返回异常'}（HTTP ${response.status}）`);
      if (server === connection.server) ok = ready;
    } catch (error) {
      log(`${label}：无法连接（${error.cause?.code || error.name}）。这表示当前网络路径不通，不能据此判断平台停机。`);
    }
  }
  const directory = fs.mkdtempSync(path.join(root, '.preflight-'));
  let localOk = false;
  try {
    const result = await executeLocal({ executor: 'command', workspace: directory, command: [process.execPath, '-e', 'process.stdin.resume();process.stdin.on("end",()=>console.log("ok"))'], timeoutMs: 5000 }, { id: 'check', prompt: '' }, directory);
    localOk = !result.failed;
    log(result.failed ? result.text : '本机子进程与管道：可用');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  return ok && localOk;
}

async function main() {
  const args = process.argv.slice(2);
  const connection = JSON.parse(fs.readFileSync(path.join(root, 'connection.json'), 'utf8'));
  let selection = args.includes('--web') ? '1' : args.includes('--check') ? '5' : null;
  const executorIndex = args.indexOf('--executor');
  if (executorIndex >= 0) selection = ({ codex: '2', claude: '3', deepseek: '4' })[args[executorIndex + 1]];
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try {
    if (!selection) selection = (await input.question('SciTag 接入\n1 打开协作网页\n2 启动 Codex\n3 启动 Claude Code\n4 启动 DeepSeek\n5 网络与本机检查\n请选择：')).trim();
    if (selection === '5') { if (!await diagnose(connection)) process.exitCode = 1; return; }
    if (selection === '1') {
      const gateway = await startGateway(connection.server, { assetDirectory: fs.existsSync(path.join(root, 'ui')) ? path.join(root, 'ui') : path.join(root, 'public') });
      console.log(`请在浏览器打开：${gateway.url}\n使用“登录凭据.txt”登录。保留此窗口；Ctrl+C 关闭。`);
      process.once('SIGINT', () => { gateway.server.closeAllConnections(); gateway.server.close(); });
      return;
    }
    const executor = ({ '2': 'codex', '3': 'claude', '4': 'deepseek' })[selection];
    if (!executor) throw new Error('请选择 1 至 5');
    const file = path.join(root, `worker.${executor}.json`);
    if (!fs.existsSync(file)) throw new Error(`尚未找到 worker.${executor}.json。请在网页注册自己的 Agent，下载配置并放到接入程序同一目录。个人接入包应已包含此配置。`);
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    config.server = connection.server;
    const proposed = path.resolve(root, config.workspace || 'workspace');
    const answer = process.stdin.isTTY ? (await input.question(`任务文件夹（回车使用 ${proposed}）：`)).trim() : '';
    config.workspace = answer ? path.resolve(answer) : proposed;
    if (!answer && config.workspace === path.join(root, 'workspace')) fs.mkdirSync(config.workspace, { recursive: true });
    if (!fs.statSync(config.workspace).isDirectory()) throw new Error('任务文件夹不存在');
    if (executor === 'deepseek' && config.trustLocalPermissions !== true) {
      console.log('DeepSeek 使用你本机 profile 的工具权限。它并非统一的只读沙箱；服务器任务可使用这些权限。请使用专用工作目录，并在本机配置隔离与审批。');
      if (!process.stdin.isTTY || (await input.question('确认信任邀请方和本机 profile 后输入“我信任”：')).trim() !== '我信任') throw new Error('尚未确认本机权限，未领取任务');
      config.trustLocalPermissions = true;
    }
    fs.writeFileSync(file, JSON.stringify(config, null, 2), { mode: 0o600 });
    input.close();
    const stop = new AbortController();
    const interrupt = () => stop.abort(); process.once('SIGINT', interrupt);
    try { await runWorker(config, { signal: stop.signal, once: args.includes('--once') }); }
    finally { process.removeListener('SIGINT', interrupt); }
  } finally { input.close(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
