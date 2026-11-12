import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { build } from 'esbuild';
import { mkdtemp, mkdir, readFile, appendFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { mergeBars, readBars } from '../app/electron/data/store/barStore.js';
import { prepareJob, loadJob, jobDir, command, records, repairTail, verifySnapshot, exportResults, decodeBars, resultPage, atomicJson } from '../app/electron/search/store.js';
import { searchBars, searchConfig, STEP } from './search-fixture.mjs';

let fixtureRoot, engine;
const children = new Set();
beforeAll(async () => {
  fixtureRoot = await mkdtemp(path.join(tmpdir(), 'midorii-search-'));
  engine = path.join(fixtureRoot, 'engine.mjs');
  await build({ entryPoints: ['app/renderer/backtest/searchEngine.ts'], outfile: engine, bundle: true, platform: 'node', format: 'esm', target: 'node22' });
});
afterAll(async () => {
  for (const child of children) child.kill();
  await new Promise((resolve) => setTimeout(resolve, 200));
  await rm(fixtureRoot, { recursive: true, force: true });
});

async function fixture(overrides = {}) {
  const root = await mkdtemp(path.join(fixtureRoot, 'job-'));
  const dataDir = path.join(root, 'markets'); const jobs = path.join(root, 'jobs');
  await mkdir(dataDir);
  const bars = searchBars();
  await mergeBars(dataDir, 'LOCAL', bars, { baseMs: STEP, timeframe: '5m' });
  const request = { config: searchConfig(overrides), symbols: ['LOCAL'], timeframes: ['5m'], from: bars[0].time, to: bars.at(-1).time + STEP, intrabar: true };
  const job = await prepareJob(jobs, dataDir, request, engine);
  return { root, jobs, dataDir, bars, job, dir: jobDir(jobs, job.id), request };
}
function start(root) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../app/electron/search/service.js', import.meta.url)), root], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  children.add(child); child.once('exit', () => children.delete(child));
  let errors = ''; child.stderr.on('data', (bytes) => { errors += bytes; });
  return { child, errors: () => errors };
}
async function until(read, test, timeout = 60_000) {
  const start = Date.now();
  for (;;) {
    const value = await read();
    if (test(value)) return value;
    if (Date.now() - start > timeout) throw new Error(`Timed out: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
async function saved(file) { const result = []; for await (const row of records(file)) result.push(row); return result; }

describe('saved offline search jobs', () => {
  it('snapshots local bars and strategy code, retaining the original data after the library changes', async () => {
    const f = await fixture();
    const before = await decodeBars(path.join(f.dir, f.job.datasets[0].barsFile));
    await mergeBars(f.dataDir, 'LOCAL', f.bars.map((bar) => ({ ...bar, close: 999 })));
    expect((await readBars(f.dataDir, 'LOCAL', '5m', f.request.from, f.request.to))[0].close).toBe(999);
    const after = await decodeBars(path.join(f.dir, f.job.datasets[0].barsFile));
    expect(after).toEqual(before);
    expect(f.job.datasets[0].gaps).toBe(39);
    expect(f.job.datasets[0].periods.train.to).toBe(f.job.datasets[0].periods.validation.from);
    await verifySnapshot(f.dir, f.job);
    await appendFile(path.join(f.dir, f.job.datasets[0].barsFile), 'changed');
    await expect(verifySnapshot(f.dir, f.job)).rejects.toThrow('changed');
    await appendFile(path.join(f.dir, 'engine.mjs'), '// changed engine');
    await expect(verifySnapshot(f.dir, f.job)).rejects.toThrow('strategy engine');
  });
  it('refuses missing history and incompatible bar intervals without fetching anything', async () => {
    const f = await fixture();
    await expect(prepareJob(f.jobs, f.dataDir, { ...f.request, from: f.request.from - STEP }, engine)).rejects.toThrow('saved history');
    await expect(prepareJob(f.jobs, f.dataDir, { ...f.request, timeframes: ['1m'] }, engine)).rejects.toThrow('cannot be built');
    await expect(prepareJob(f.jobs, f.dataDir, { ...f.request, symbols: ['MISSING'] }, engine)).rejects.toThrow('No saved data');
  });
  it('repairs only an unfinished append and refuses corrupt complete records', async () => {
    const f = await fixture(); const file = path.join(f.dir, 'results.jsonl');
    await writeFile(file, '{"index":0,"params":{"rrr":1}}\n{"index":1');
    await repairTail(file);
    expect(await saved(file)).toEqual([{ index: 0, params: { rrr: 1 } }]);
    await appendFile(file, '{"index":2}\n');
    await expect(saved(file)).rejects.toThrow('out of sequence');
  });
  it('reserves exactly one final candidate when two requests arrive together', async () => {
    const f = await fixture();
    await atomicJson(path.join(f.dir, 'state.json'), { ...f.job.state, status: 'completed', done: 2 });
    await writeFile(path.join(f.dir, 'results.jsonl'), [0, 1].map((index) => JSON.stringify({ index, datasetIndex: 0, params: { ...f.job.config.base, rrr: index + 1 } })).join('\n') + '\n');
    const outcomes = await Promise.allSettled([command(f.jobs, f.job.id, 'final', 0), command(f.jobs, f.job.id, 'final', 1)]);
    expect(outcomes.filter((value) => value.status === 'fulfilled')).toHaveLength(1);
    const selected = (await loadJob(f.jobs, f.job.id)).final.index;
    expect(JSON.parse(await readFile(path.join(f.dir, 'request.json'), 'utf8')).index).toBe(selected);
    await expect(command(f.jobs, f.job.id, 'final', 1 - selected)).rejects.toThrow('another candidate');
  });
  it('keeps settings and results for every selected market and interval pair', async () => {
    const f = await fixture();
    await mergeBars(f.dataDir, 'SECOND', f.bars, { baseMs: STEP, timeframe: '5m' });
    const job = await prepareJob(f.jobs, f.dataDir, { ...f.request, symbols: ['LOCAL', 'SECOND'], timeframes: ['5m', '15m'] }, engine);
    expect(job.total).toBe(12);
    expect(job.datasets.filter((data) => data.baseFile)).toHaveLength(2);
    await command(f.jobs, job.id, 'start'); const service = start(f.jobs);
    const finished = await until(() => loadJob(f.jobs, job.id), (value) => ['completed', 'failed'].includes(value.state.status));
    expect(finished.state.error, service.errors()).toBeNull();
    const rows = await saved(path.join(jobDir(f.jobs, job.id), 'results.jsonl'));
    for (let datasetIndex = 0; datasetIndex < 4; datasetIndex++) {
      expect(rows.filter((row) => row.datasetIndex === datasetIndex).map((row) => row.params.rrr)).toEqual([1, 2, 3]);
    }
    expect(rows.filter((row) => job.datasets[row.datasetIndex].baseFile).every((row) => row.resolution === 'intrabar')).toBe(true);
    service.child.kill();
  }, 120_000);
  it('executes the shared engine in real workers and exports every result with its settings', async () => {
    const f = await fixture();
    await command(f.jobs, f.job.id, 'start'); const service = start(f.jobs);
    const finished = await until(() => loadJob(f.jobs, f.job.id), (j) => ['completed', 'failed'].includes(j.state.status));
    expect(finished.state.error, service.errors()).toBeNull();
    expect(finished.state.done).toBe(3);
    const rows = await saved(path.join(f.dir, 'results.jsonl'));
    expect(rows.map((r) => r.params.rrr)).toEqual([1, 2, 3]);
    expect(rows.every((r) => r.stats.tradeCount > 0 && r.validation.tradeCount > 0)).toBe(true);
    expect(rows.every((r) => r.params.breakEvenAtR !== undefined)).toBe(true);
    const page = await resultPage(f.jobs, f.job.id, 0, 'netPnl', 1);
    expect(page.rows).toHaveLength(3);
    const jsonl = path.join(f.root, 'export.jsonl'); const csv = path.join(f.root, 'export.csv');
    await exportResults(f.jobs, f.job.id, jsonl, 'jsonl'); await exportResults(f.jobs, f.job.id, csv, 'csv');
    const exported = (await readFile(jsonl, 'utf8')).trim().split('\n').map(JSON.parse);
    expect(exported).toHaveLength(3); expect(exported[0].engineHash).toBe(f.job.engineHash);
    expect(exported[0].periods).toEqual(f.job.datasets[0].periods);
    expect((await readFile(csv, 'utf8')).trim().split('\n')).toHaveLength(4);
    await command(f.jobs, f.job.id, 'final', 0);
    const final = await until(() => loadJob(f.jobs, f.job.id), (j) => j.final?.status === 'completed');
    expect(final.final.result.stats.tradeCount).toBeGreaterThan(0);
    await expect(command(f.jobs, f.job.id, 'final', 1)).rejects.toThrow('another candidate');
    expect((await loadJob(f.jobs, f.job.id)).final.index).toBe(0);
    service.child.kill();
  }, 120_000);
  it('pauses, survives a process restart, and resumes without repeating durable attempts', async () => {
    const f = await fixture({ axes: { rrr: { from: 1, to: 20, step: 0.01 } }, maxAttempts: 500 });
    await command(f.jobs, f.job.id, 'start'); const first = start(f.jobs);
    await until(() => saved(path.join(f.dir, 'results.jsonl')), (rows) => rows.length >= 6);
    await command(f.jobs, f.job.id, 'pause');
    const paused = await until(async () => {
      const job = await loadJob(f.jobs, f.job.id);
      if (first.child.exitCode !== null) throw new Error(`Service exited ${first.child.exitCode}: ${first.errors()} ${await readFile(path.join(f.jobs, 'service-error.json'), 'utf8').catch(() => '')}`);
      return job;
    }, (j) => j.state.status === 'paused');
    expect(paused.state.done).toBeGreaterThanOrEqual(6); expect(paused.state.done).toBeLessThan(500);
    const before = await saved(path.join(f.dir, 'results.jsonl'));
    // Graceful service exit releases its process lock; a second process resumes the job.
    await new Promise((resolve) => first.child.once('exit', resolve));
    await appendFile(path.join(f.dir, 'results.jsonl'), '{"index":unfinished');
    await command(f.jobs, f.job.id, 'start'); const second = start(f.jobs);
    const done = await until(async () => {
      const job = await loadJob(f.jobs, f.job.id);
      if (second.child.exitCode !== null) throw new Error(`Service exited ${second.child.exitCode}: ${second.errors()} ${await readFile(path.join(f.jobs, 'service-error.json'), 'utf8').catch(() => '')}`);
      return job;
    }, (j) => ['completed', 'failed'].includes(j.state.status));
    expect(done.state.error, second.errors()).toBeNull(); expect(done.state.done).toBe(500);
    const after = await saved(path.join(f.dir, 'results.jsonl'));
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.map((r) => r.index)).toEqual(Array.from({ length: 500 }, (_, i) => i));
    second.child.kill();
  }, 120_000);
  it('recovers after an abrupt process exit and lets you pause another queued job', async () => {
    const f = await fixture({ axes: { rrr: { from: 1, to: 20, step: 0.01 } }, maxAttempts: 200 });
    const secondJob = await prepareJob(f.jobs, f.dataDir, { ...f.request, config: searchConfig({ name: 'Queued job' }) }, engine);
    await command(f.jobs, f.job.id, 'start'); const first = start(f.jobs);
    await until(() => saved(path.join(f.dir, 'results.jsonl')), (rows) => rows.length >= 4);
    const exited = new Promise((resolve) => first.child.once('exit', resolve)); first.child.kill(); await exited;
    const retained = await saved(path.join(f.dir, 'results.jsonl'));
    await command(f.jobs, f.job.id, 'start'); const resumed = start(f.jobs);
    await until(() => loadJob(f.jobs, f.job.id), (j) => j.state.status === 'running');
    await command(f.jobs, secondJob.id, 'start');
    await until(() => loadJob(f.jobs, secondJob.id), (j) => j.state.status === 'queued');
    await command(f.jobs, secondJob.id, 'pause');
    await until(() => loadJob(f.jobs, secondJob.id), (j) => j.state.status === 'paused');
    await until(() => loadJob(f.jobs, f.job.id), (j) => j.state.status === 'completed');
    const after = await saved(path.join(f.dir, 'results.jsonl'));
    expect(after).toHaveLength(200); expect(after.slice(0, retained.length)).toEqual(retained);
    expect(await saved(path.join(jobDir(f.jobs, secondJob.id), 'results.jsonl'))).toEqual([]);
    await command(f.jobs, secondJob.id, 'start');
    const complete = await until(() => loadJob(f.jobs, secondJob.id), (j) => j.state.status === 'completed');
    expect(complete.state.done).toBe(3);
    resumed.child.kill();
  }, 120_000);
  it('exports more than the old sweep retention limit and does not overwrite job files', async () => {
    const f = await fixture();
    const stats = { tradeCount: 10, netPnl: 12, returnPct: 0.1, winRate: 0.5, maxDrawdownPct: 0.1, profitFactor: 2, expectancy: 1.2, feesPaid: 3 };
    const rows = Array.from({ length: 6001 }, (_, index) => ({ index, datasetIndex: 0, params: { ...f.job.config.base, rrr: 1 }, stats, validation: stats }));
    await writeFile(path.join(f.dir, 'results.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
    const exportFile = path.join(f.root, 'all.jsonl');
    await exportResults(f.jobs, f.job.id, exportFile, 'jsonl');
    expect((await readFile(exportFile, 'utf8')).trim().split('\n')).toHaveLength(6001);
    await expect(exportResults(f.jobs, f.job.id, path.join(f.dir, 'results.jsonl'), 'jsonl')).rejects.toThrow('outside');
    expect(await saved(path.join(f.dir, 'results.jsonl'))).toHaveLength(6001);
  });
});
