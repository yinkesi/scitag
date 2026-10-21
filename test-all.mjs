import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const checks = ['server.js', 'engine.mjs', 'adapters.mjs', 'analysis-spec.mjs', 'workflow.js', 'routing.js',
  'persistence.mjs', 'research.mjs', 'remote-jobs.mjs', 'cloud-store.mjs', 'worker.mjs',
  'worker-executors.mjs', 'connect.mjs', 'supabase/functions/_shared/relay.mjs', 'api/index.js', 'public/entry.js', 'public/workspace.js', 'public/app.js'].map(file => ['--check', file]);
const suites = [['test-smoke.mjs'], ['test-edge.mjs'],
  ['--test', 'test-persistence.mjs', 'test-research.mjs', 'test-llm-tools.mjs', 'test-vascular-stent.mjs',
    'test-remote-jobs.mjs', 'test-cloud-store.mjs', 'test-worker.mjs', 'test-connection.mjs', 'test-remote.mjs'], ['test-regression.mjs']];
for (const args of [...checks, ...suites]) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error || result.status !== 0) {
    if (result.error) console.error(result.error.message);
    process.exit(result.status || 1);
  }
}
