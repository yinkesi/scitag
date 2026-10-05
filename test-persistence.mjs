import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from './persistence.mjs';

const sample = (seq = 1) => ({ seq, agents: {}, channels: {}, messages: [], events: [], missions: {}, tasks: {}, jobs: [] });
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scitag-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'db.json');
  return { file, store: createStore(file, { delayMs: 30, onError() {} }) };
}
test('only an absent database may initialize a new workspace', (t) => {
  const { file, store } = fixture(t);
  assert.equal(store.load(), null);
  fs.writeFileSync(file, '{broken');
  assert.throws(() => store.load(), /数据库/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});
test('restores a valid backup while preserving the damaged database', (t) => {
  const { file, store } = fixture(t);
  fs.writeFileSync(file, '{broken');
  fs.writeFileSync(file + '.bak', JSON.stringify(sample(42)));
  assert.equal(store.load().seq, 42);
  assert.equal(JSON.parse(fs.readFileSync(file)).seq, 42);
  const damaged = fs.readdirSync(path.dirname(file)).find(f => f.startsWith('db.json.corrupt-'));
  assert.ok(damaged);
  assert.equal(fs.readFileSync(path.join(path.dirname(file), damaged), 'utf8'), '{broken');
});
test('saving keeps the last valid snapshot as an atomic backup', (t) => {
  const { file, store } = fixture(t);
  store.save(sample(1)); store.flush();
  store.save(sample(2)); store.flush();
  assert.equal(JSON.parse(fs.readFileSync(file)).seq, 2);
  assert.equal(JSON.parse(fs.readFileSync(file + '.bak')).seq, 1);
});
test('continuous changes cannot indefinitely postpone saving', async (t) => {
  const { file, store } = fixture(t);
  store.save(sample(1));
  const ticker = setInterval(() => store.save(sample(2)), 5);
  try {
    await new Promise(r => setTimeout(r, 100));
    assert.ok(fs.existsSync(file));
    assert.equal(JSON.parse(fs.readFileSync(file)).seq, 2);
  } finally { clearInterval(ticker); store.flush(); }
});
