import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function launcher(name) {
  if (process.platform !== 'win32') return [name];
  const root = path.join(process.env.APPDATA || '', 'npm', 'node_modules');
  const locations = {
    codex: ['@openai', 'codex', 'bin', 'codex.js'],
    claude: ['@anthropic-ai', 'claude-code', 'bin', 'claude.exe'],
    dsh: ['@deepseek-ai', 'dsh', 'lib', 'bin.js'],
  };
  const entry = path.join(root, ...locations[name]);
  if (fs.existsSync(entry)) return entry.endsWith('.js') ? [process.execPath, entry] : [entry];
  // Native installers can expose .exe directly; .cmd wrappers are never run via a shell.
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const exe = path.join(dir, name + '.exe');
    if (fs.existsSync(exe)) return [exe];
  }
  throw new Error(`${name} 未安装；请安装 CLI 或在本地配置 command 数组指定入口`);
}

export function executorCommand(config, output) {
  if (config.command) {
    if (!Array.isArray(config.command) || !config.command.length || config.command.some(v => typeof v !== 'string')) throw new Error('command 必须是非空字符串数组');
    return config.command;
  }
  if (config.executor === 'codex') {
    const sandbox = config.sandbox || 'read-only';
    if (!['read-only', 'workspace-write'].includes(sandbox)) throw new Error('Codex sandbox 仅支持 read-only 或 workspace-write');
    return [...launcher('codex'), 'exec', '--sandbox', sandbox, '-c', 'approval_policy="never"',
      '--skip-git-repo-check', '--cd', config.workspace, '--output-last-message', output,
      ...(config.model ? ['--model', config.model] : []), '-'];
  }
  if (config.executor === 'claude') {
    const readOnly = !config.sandbox || config.sandbox === 'read-only';
    if (!readOnly && config.sandbox !== 'workspace-write') throw new Error('Claude sandbox 仅支持 read-only 或 workspace-write');
    if (!readOnly && config.trustLocalPermissions !== true) throw new Error('Claude 写入模式需电脑主人设置 trustLocalPermissions: true，确认信任服务器派发的任务');
    return [...launcher('claude'), '-p', '--output-format', 'text', '--disable-slash-commands',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--settings', '{"disableAllHooks":true}',
      ...(readOnly ? ['--tools', 'Read,Glob,Grep'] : []), ...(config.model ? ['--model', config.model] : [])];
  }
  if (config.executor === 'deepseek') {
    // The headless CLI has no portable sandbox flag. Do not silently promise
    // that config.sandbox constrains a user-supplied DSH plugin composition.
    if (config.trustLocalPermissions !== true) throw new Error('DeepSeek 沿用本机 profile 权限；请在本机隔离环境配置权限，并设置 trustLocalPermissions: true 后启动');
    return [...launcher('dsh'), '--profile', config.profile || 'headless', '-'];
  }
  throw new Error('executor 必须是 codex、claude、deepseek 或配置本地 command');
}

function terminate(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.on('error', () => { try { child.kill(); } catch {} });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
  }
}

export async function executeLocal(config, job, stateDirectory, signal) {
  const output = path.join(stateDirectory, job.id + '.answer.md');
  if (fs.existsSync(output)) fs.unlinkSync(output);
  const argv = executorCommand(config, output);
  const stdoutFile = path.join(stateDirectory, job.id + '.stdout.log');
  const stderrFile = path.join(stateDirectory, job.id + '.stderr.log');
  fs.writeFileSync(stdoutFile, '', { mode: 0o600 });
  fs.writeFileSync(stderrFile, '', { mode: 0o600 });
  const logBytes = { stdout: 0, stderr: 0 };
  const persistOutput = (name, file, data) => {
    const bytes = Buffer.from(data);
    const remaining = Math.max(0, 1024 * 1024 - logBytes[name]);
    if (remaining) fs.appendFileSync(file, bytes.subarray(0, remaining));
    logBytes[name] += bytes.length;
  };
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(SCITAG_|SUPABASE_|VERCEL_)/.test(key)) delete env[key];
  return new Promise(resolve => {
    let stdout = '', stderr = '', cancelled = !!signal?.aborted, settled = false;
    const child = spawn(argv[0], argv.slice(1), { cwd: config.workspace, env, shell: false,
      windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    const finish = result => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); resolve(result);
    };
    const abort = () => { cancelled = true; terminate(child); };
    const timer = setTimeout(abort, config.timeoutMs || 30 * 60_000);
    signal?.addEventListener('abort', abort, { once: true });
    if (cancelled) abort();
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', data => { stdout = (stdout + data).slice(-24000); persistOutput('stdout', stdoutFile, data); });
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-4000); persistOutput('stderr', stderrFile, data); });
    child.stdin.on('error', () => {});
    child.stdin.end(job.prompt);
    child.on('error', error => finish({ failed: true, text: ['EPERM', 'EACCES'].includes(error.code)
      ? '当前运行环境禁止启动子进程或管道。请在系统普通终端运行接入程序，或由电脑主人检查应用权限；无需关闭全局安全设置。'
      : '无法启动本地 Agent：' + error.message }));
    child.on('close', code => {
      if (cancelled) return finish({ failed: true, text: '本地执行被中止（超时、退出或租约丢失），请主人核验已有副作用。' });
      if (code !== 0) return finish({ failed: true, text: `Agent 退出码 ${code}。\n${stderr || stdout}`.slice(0, 20000) });
      const answer = config.executor === 'codex' && !config.command
        ? (fs.existsSync(output) ? fs.readFileSync(output, 'utf8') : '') : stdout;
      if (!answer.trim()) return finish({ failed: true, text: 'Agent 没有返回成果正文' });
      finish({ failed: false, text: answer.length > 20000 ? answer.slice(0, 19950) + '\n（成果超过平台上限，已截断；完整输出保存在本机。）' : answer });
    });
  });
}
