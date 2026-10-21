#!/usr/bin/env node
// Real research execution and reproducibility checks; no network or LLM needed.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, copyFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { runAnalysis } from './research.mjs';

const domainsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'domains');
const domain = 'bone-scaffold';
const sha256 = async (file) => createHash('sha256').update(await readFile(file)).digest('hex');
const dataFile = path.join(domainsDir, domain, 'data', 'BONE_SCAFFOLD.xlsx');
const scriptFile = path.join(domainsDir, domain, 'scripts', 'analyze.py');

for (const [command, target, expected] of [
  ['stats', undefined, /行数\s*100/],
  ['fit', undefined, /R²=.*RMSE=/s],
  ['inverse', 1e-9, /可行\s*100\s*\/\s*100/],
  ['inverse', 1e-30, /数据域内无解/],
]) {
  test(`${command}${target ? ` target=${target}` : ''}: real script output and verifiable provenance`, async () => {
    const before = Date.now();
    const result = await runAnalysis({ domain, command, ...(target ? { target } : {}) });
    assert.equal(result.ok, true);
    assert.match(result.text, expected);
    const p = result.provenance;
    assert.equal(p.domain, domain);
    assert.equal(p.command, command);
    assert.equal(p.exitCode, 0);
    assert.equal(p.dataSha256, await sha256(dataFile));
    assert.equal(p.dataSha256s[`data/BONE_SCAFFOLD.xlsx`], await sha256(dataFile));
    assert.equal(p.scriptSha256, await sha256(scriptFile));
    assert.ok(Array.isArray(p.args) && p.args.includes(command));
    if (target) assert.ok(p.args.includes('--target') && p.args.includes(String(target)));
    assert.ok(Date.parse(p.at) >= before && Date.parse(p.at) <= Date.now());
    assert.match(p.output, expected);
    assert.ok(result.text.includes(p.output), 'report preserves original script output');
  });
}

/* ---------- 第二个域包：vascular-stent（声明驱动，不再写死 bone-scaffold） ---------- */
const stent = 'vascular-stent';
const stentDir = path.join(domainsDir, stent);
const stentData = ['data/MatWeb材料汇总_2026-10-18.csv', 'data/MatWeb属性明细_2026-10-18.csv'];
for (const [command, params, expected] of [
  ['materials', { family: 'polymer' }, /PLLA/],
  ['ring', { E: 44.2, t: 120 }, /1885866/],
  ['flow', { q: 100 }, /483\.3/],
  ['concept', { lesion_mm: 4, vessel_mm: 3 }, /封堵/],
  ['verify', {}, /自检/],
  ['all', {}, /self_check_passed/],
]) {
  test(`${stent}/${command}: manifest-declared tool executes with real data hashes`, async () => {
    const result = await runAnalysis({ domain: stent, command, params });
    assert.equal(result.ok, true);
    assert.match(result.text, expected);
    const p = result.provenance;
    assert.equal(p.domain, stent);
    assert.equal(p.command, command);
    assert.equal(p.exitCode, 0);
    assert.equal(p.scriptSha256, await sha256(path.join(stentDir, 'scripts', 'stent_tool.py')));
    for (const rel of stentData) {
      assert.equal(p.dataSha256s[rel], await sha256(path.join(stentDir, rel)), `hash ${rel}`);
      assert.ok(result.text.includes(p.dataSha256s[rel]), 'report lists every data hash');
    }
    assert.equal(p.dataSha256, p.dataSha256s[stentData[0]], 'legacy single-hash field stays the first data file');
    assert.ok(Array.isArray(p.args) && p.args.includes(command));
    for (const value of Object.values(params)) assert.ok(p.args.includes(String(value)), `argv carries ${value}`);
    for (const [name, value] of Object.entries(params)) assert.equal(p.params[name], value);
  });
}

for (const input of [
  { domain: '../bone-scaffold', command: 'stats' },
  { domain: 'unknown-domain', command: 'stats' },
  { domain, command: 'stats; echo injected' },
  { domain, command: 'unknown-command' },
  ...[undefined, 0, -1, NaN, Infinity, '1e-9; echo injected'].map((target) => ({ domain, command: 'inverse', target })),
  { domain: stent, command: 'stats' },
  { domain: stent, command: 'materials', params: { family: 'wood' } },
  { domain: stent, command: 'ring', params: { E: 44.2 } },
  { domain: stent, command: 'ring', params: { E: -1, t: 120 } },
  { domain: stent, command: 'ring', params: { E: 44.2, t: 120, extra: 1 } },
  { domain: stent, command: 'flow', params: { q: '100; echo injected' } },
]) {
  test(`reject invalid analysis input ${JSON.stringify(input)}`, async () => {
    await assert.rejects(() => runAnalysis(input));
  });
}

test('failed research script records nonzero exit and its original output', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'scitag-research-'));
  try {
    const fixtureDomain = path.join(temp, domain);
    await mkdir(path.join(fixtureDomain, 'scripts'), { recursive: true });
    await mkdir(path.join(fixtureDomain, 'data'), { recursive: true });
    await copyFile(dataFile, path.join(fixtureDomain, 'data', 'BONE_SCAFFOLD.xlsx'));
    await writeFile(path.join(fixtureDomain, 'domain.json'), JSON.stringify({
      name: domain,
      analysis: {
        script: 'scripts/analyze.py',
        data: ['data/BONE_SCAFFOLD.xlsx'],
        commands: [
          { name: 'stats', args: ['stats'] },
          { name: 'inverse', args: ['inverse', '--target', '{target}'], params: { target: { type: 'number', required: true, positive: true } } },
        ],
      },
    }));
    const fixtureScript = path.join(fixtureDomain, 'scripts', 'analyze.py');
    await writeFile(fixtureScript, 'import sys\nprint("research-fixture-started", flush=True)\nprint("fixture-data-invalid", file=sys.stderr, flush=True)\nsys.exit(7)\n');
    const result = await runAnalysis({ domain, command: 'stats' }, { domainsDir: temp });
    assert.equal(result.ok, false);
    assert.equal(result.provenance.exitCode, 7);
    assert.equal(result.provenance.scriptSha256, await sha256(fixtureScript));
    assert.equal(result.provenance.dataSha256, await sha256(dataFile));
    assert.match(result.provenance.output, /research-fixture-started/);
    assert.match(result.provenance.output, /fixture-data-invalid/);
    assert.match(result.text, /fixture-data-invalid/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
