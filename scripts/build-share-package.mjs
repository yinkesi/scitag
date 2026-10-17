// Explicit operator command: creates recipient-owned Agent accounts and a
// private desktop delivery. Never run in CI or publish the generated ZIP.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import '../worker.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cloud = JSON.parse(fs.readFileSync(path.join(root, 'data/cloud-deployment.private.json'), 'utf8'));
const recipient = JSON.parse(fs.readFileSync(path.join(root, 'data/share-recipient.private.json'), 'utf8'));
const server = cloud.supabaseUrl.replace(/\/$/, '') + '/functions/v1/scitag-relay';
async function api(route, token, body) {
  const response = await fetch(server + route, { method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: body ? JSON.stringify(body) : undefined });
  if (!response.ok) throw new Error(`共享包准备失败：HTTP ${response.status}`);
  return response.json();
}
const login = await api('/api/register', recipient.token, { name: recipient.name, token: recipient.token });
assert.equal(login.me.isAdmin, false);
const registryFile = path.join(root, 'data/share-agents.private.json');
const registry = fs.existsSync(registryFile) ? JSON.parse(fs.readFileSync(registryFile, 'utf8')) : {};
const agents = registry[recipient.name] ||= {};
for (const executor of ['codex', 'claude', 'deepseek']) {
  if (!agents[executor]) {
    const roster = (await api('/api/agents', recipient.token)).agents;
    const baseName = `${recipient.name}-${executor}`;
    let name = baseName, suffix = 2;
    while (roster.some(agent => agent.name === name)) name = baseName + '-' + suffix++;
    const registration = await api('/api/register', recipient.token, { name, kind: 'agent', owner: recipient.name, domains: [], adapter: { kind: 'none' } });
    assert.equal(registration.me.owner, recipient.name);
    agents[executor] = { name, token: registration.token };
    fs.writeFileSync(registryFile, JSON.stringify(registry, null, 2), { mode: 0o600 });
  }
  const state = await api('/api/state', agents[executor].token);
  assert.equal(state.me.owner, recipient.name);
}
const destination = path.join(os.homedir(), 'Desktop', `SciTag-${recipient.name}-接入包-修复版`);
fs.mkdirSync(destination, { recursive: true });
const files = {};
for (const name of ['worker.mjs', 'worker-executors.mjs', 'connect.mjs']) files[name] = fs.readFileSync(path.join(root, name));
files['使用说明.md'] = fs.readFileSync(path.join(root, 'docs/WORKER-QUICKSTART.md'));
files['connection.json'] = JSON.stringify({ server, directServer: cloud.productionUrl }, null, 2);
for (const executor of ['codex', 'claude', 'deepseek']) {
  files[`worker.${executor}.json`] = JSON.stringify({ server, token: agents[executor].token, executor, workspace: './workspace', sandbox: 'read-only', trustLocalPermissions: false }, null, 2);
}
const launchers = { '启动接入.cmd': '', '打开协作网页.cmd': '--web', '检查连接.cmd': '--check',
  '启动Codex.cmd': '--executor codex', '启动Claude.cmd': '--executor claude', '启动DeepSeek.cmd': '--executor deepseek' };
for (const [name, args] of Object.entries(launchers)) {
  files[name] = `@echo off\r\ncd /d "%~dp0"\r\nwhere node >nul 2>nul\r\nif errorlevel 1 (\r\n  echo Please install Node.js first: https://nodejs.org/\r\n  pause\r\n  exit /b 1\r\n)\r\nnode connect.mjs ${args}\r\npause\r\n`;
}
files['登录凭据.txt'] = `SciTag 个人登录凭据\r\n账号（名字）：${recipient.name}\r\n访问凭据：${recipient.token}\r\n\r\n首选：双击“打开协作网页.cmd”，在浏览器打开终端显示的本机网址。\r\n备用原网址：${cloud.productionUrl}\r\n\r\n本包只交给该账号对应的一位协作者。凭据是明文，不要公开、发群或提交 Git。\r\n`;
files['先看这里.txt'] = `SciTag 协作接入包 · 修复版\r\n\r\n已包含你的账号、三个独立 Agent 配置和启动器，不需要先上网页下载 JSON。\r\n\r\n1. 将 ZIP 的所有文件解压到一个目录；这个目录中能直接看到“启动接入.cmd”。\r\n2. 安装 Node.js 18 或更新版本；依赖 HTTP/HTTPS 代理的电脑需要 24.14+。\r\n3. 双击“打开协作网页.cmd”，复制窗口显示的 http://127.0.0.1:端口 到浏览器。\r\n   使用“登录凭据.txt”的账号和凭据登录。这个入口经 Supabase 转到同一个平台，不要求浏览器直接访问 vercel.app。\r\n4. 需要本机 Agent 做任务时，另开“启动Codex.cmd”“启动Claude.cmd”或“启动DeepSeek.cmd”。\r\n   本机必须已安装对应 CLI、完成登录，并有自己的模型额度。\r\n   默认在接入包的 workspace 子目录做任务；启动时也可输入你自己的现有任务文件夹。\r\n5. 保持两个终端窗口和电脑联网；Ctrl+C 停止。不要在受限 Agent 沙箱内启动，用 Windows 普通终端或双击启动器。\r\n\r\n连不上时：双击“检查连接.cmd”，它会分别检查备用入口和原网址，并检查本机能否启动子进程。\r\n备用域名仍需该电脑的网络实际允许访问；若两条路都不通，需要电脑主人配置已有的合规代理或使用可访问的网络。\r\n\r\n权限：Codex 默认只读沙箱；Claude 默认仅 Read/Glob/Grep 且禁用 MCP/技能/钩子，但不等同操作系统隔离；\r\nDeepSeek 沿用本机 profile 的权限，首次启动需由电脑主人明确确认。请勿对不信任的服务器开放主力工作目录或高权限工具。\r\n文件不会自动同步，目前回传文字报告。Claude 接入预设已支持，模型实跑仍未验收通过。\r\n\r\n本包只给一位协作者；多人使用需要分别建立账号和配置。不要发群或提交 Git。\r\n`;
for (const [name, value] of Object.entries(files)) {
  for (const key of ['adminToken', 'databaseSecret', 'supabasePublishableKey']) {
    if (cloud[key]) assert.ok(!value.toString().includes(cloud[key]), 'Excluded platform credential');
  }
  fs.writeFileSync(path.join(destination, name), value, { mode: 0o600 });
}
assert.deepEqual(fs.readdirSync(destination).sort(), Object.keys(files).sort());
const zip = spawnSync('python', ['-c', 'import pathlib,sys,zipfile; p=pathlib.Path(sys.argv[1]); z=zipfile.ZipFile(str(p)+".zip","w",compression=zipfile.ZIP_DEFLATED); [z.write(f,f.name) for f in sorted(p.iterdir()) if f.is_file()]; z.close()', destination], { windowsHide: true, encoding: 'utf8' });
if (zip.status !== 0) throw new Error('压缩失败：' + zip.stderr);
console.log(JSON.stringify({ archive: destination + '.zip', account: recipient.name, agents: Object.values(agents).map(item => item.name), files: Object.keys(files).length, server, loginVerified: true }));
