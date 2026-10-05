import fs from 'node:fs';
import path from 'node:path';

function readSnapshot(file) {
  const db = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!db || !Number.isFinite(db.seq) || !db.agents || !db.channels ||
      !Array.isArray(db.messages) || !Array.isArray(db.events)) throw new Error('数据库结构无效');
  return db;
}

/** One writer, bounded batching, and a last-known-good backup. */
export function createStore(file, { delayMs = 800, onError = console.error } = {}) {
  let timer = null, pending = null;
  function load() {
    try { return readSnapshot(file); }
    catch (error) {
      const missing = error.code === 'ENOENT';
      if (missing && !fs.existsSync(file + '.bak')) return null;
      let backup;
      try { backup = readSnapshot(file + '.bak'); }
      catch { throw new Error(`数据库无法加载：${file}；没有有效备份，请保留原文件并手动恢复。`, { cause: error }); }
      if (!missing) fs.copyFileSync(file, file + '.corrupt-' + Date.now());
      fs.writeFileSync(file + '.tmp', JSON.stringify(backup));
      fs.renameSync(file + '.tmp', file);
      onError(`[restore] 已从 ${file}.bak 恢复${missing ? '' : '，损坏文件已另存'}。`);
      return backup;
    }
  }
  function flush() {
    clearTimeout(timer); timer = null;
    if (!pending) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify(pending));
    if (fs.existsSync(file)) {
      readSnapshot(file); // Never rotate a damaged snapshot into the good backup.
      fs.copyFileSync(file, file + '.bak.tmp');
      fs.renameSync(file + '.bak.tmp', file + '.bak');
    }
    fs.renameSync(file + '.tmp', file);
    pending = null;
  }
  function save(db) {
    pending = db;
    if (!timer) timer = setTimeout(() => {
      try { flush(); } catch (error) { onError('[save] ' + error.message); }
    }, delayMs);
  }
  return { load, save, flush };
}
