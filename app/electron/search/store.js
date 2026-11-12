import { mkdir, readFile, writeFile, rename, readdir, open, stat, copyFile, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { readDataset, readMeta, aggregate, timeframeMs, parseTimeframe } from '../data/store/barStore.js';

const SAFE_ID = /^j[0-9a-f-]{36}$/;
/** Windows readers and scanners can briefly prevent an otherwise valid rename. */
export async function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt++) {
    try { await rename(from, to); return; }
    catch (err) {
      if (attempt >= 20 || !['EPERM', 'EACCES', 'EBUSY'].includes(err.code)) throw err;
      await delay(50);
    }
  }
}
export function jobDir(root, id) {
  if (typeof id !== 'string' || !SAFE_ID.test(id)) throw new Error('Invalid search job id');
  return path.join(root, id);
}
export async function atomicJson(file, value) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  const handle = await open(tmp, 'wx');
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
  finally { await handle.close(); }
  try { await renameWithRetry(tmp, file); }
  catch (err) { await rm(tmp, { force: true }); throw err; }
}
export async function json(file) { return JSON.parse(await readFile(file, 'utf8')); }
export async function optionalJson(file) {
  try { return await json(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
export async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}
export function encodeBars(bars) {
  const packed = new Float64Array(bars.length * 7);
  bars.forEach((b, i) => packed.set([b.time, b.open, b.high, b.low, b.close, b.volume ?? 0, b.buyVolume ?? NaN], i * 7));
  return Buffer.from(packed.buffer);
}
export async function decodeBars(file) {
  const buffer = await readFile(file);
  if (buffer.length % 56) throw new Error('Corrupt search data snapshot');
  const data = new Float64Array(Uint8Array.from(buffer).buffer);
  const bars = [];
  for (let i = 0; i < data.length; i += 7) bars.push({ time: data[i], open: data[i + 1], high: data[i + 2], low: data[i + 3], close: data[i + 4], volume: data[i + 5], buyVolume: data[i + 6] });
  return bars;
}

export async function prepareJob(root, dataDir, request, enginePath) {
  const engine = await import(pathToFileURL(enginePath).href);
  const config = engine.validateSearch(request.config);
  const { symbols, timeframes, from, to, intrabar = true } = request;
  if (!Array.isArray(symbols) || !symbols.length || symbols.length > 10 || new Set(symbols).size !== symbols.length
      || symbols.some((s) => typeof s !== 'string' || !/^[\w.:-]{1,120}$/.test(s))) throw new Error('Choose one to ten distinct local markets');
  if (!Array.isArray(timeframes) || !timeframes.length || timeframes.length > 6 || new Set(timeframes).size !== timeframes.length) throw new Error('Choose one to six distinct intervals');
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) throw new Error('Choose a valid historical date range');
  const id = `j${randomUUID()}`;
  const dir = jobDir(root, id);
  const staging = `${dir}.preparing`;
  await mkdir(staging, { recursive: true });
  try {
  const datasets = [];
  for (const symbol of symbols) {
    const meta = await readMeta(dataDir, symbol);
    const raw = await readDataset(dataDir, symbol);
    if (!meta || !raw) throw new Error(`No saved data for ${symbol}`);
    const baseMs = meta.baseMs ?? 60_000;
    if (from < meta.first || to > meta.last + baseMs) throw new Error(`${symbol}: requested dates extend beyond its saved history`);
    for (const timeframe of timeframes) {
      if (parseTimeframe(timeframe).months) throw new Error('Search jobs require fixed bar intervals');
      const stepMs = timeframeMs(timeframe);
      if (stepMs < baseMs || stepMs % baseMs !== 0) throw new Error(`${symbol}: ${timeframe} cannot be built from its saved bars`);
      const bars = aggregate(raw, from, to, timeframe, true, baseMs);
      const periods = engine.searchPeriods(bars, stepMs);
      const prefix = `data-${datasets.length}`;
      const barsFile = `${prefix}.bin`;
      await writeFile(path.join(staging, barsFile), encodeBars(bars));
      let baseFile = null;
      if (intrabar && stepMs > baseMs) {
        baseFile = `${prefix}-base.bin`;
        const base = aggregate(raw, bars[0].time, bars.at(-1).time + stepMs, String(baseMs / 60_000), true, baseMs);
        await writeFile(path.join(staging, baseFile), encodeBars(base));
      }
      let gaps = 0;
      for (let i = 1; i < bars.length; i++) if (bars[i].time - bars[i - 1].time > stepMs) gaps++;
      datasets.push({ symbol, timeframe, stepMs, count: bars.length, gaps, periods, barsFile, baseFile,
        bytes: (await stat(path.join(staging, barsFile))).size + (baseFile ? (await stat(path.join(staging, baseFile))).size : 0),
        hash: await hashFile(path.join(staging, barsFile)), baseHash: baseFile ? await hashFile(path.join(staging, baseFile)) : null });
    }
  }
  await copyFile(enginePath, path.join(staging, 'engine.mjs'));
  const { searchSpace } = await import('../../../shared/analysis/searchPlan.js');
  const combinations = Math.min(searchSpace(config.axes).total, config.maxAttempts);
  const manifest = { id, createdAt: Date.now(), config, datasets, combinations, total: combinations * datasets.length,
    estimatedResultBytes: combinations * datasets.length * (700 + JSON.stringify(config.base).length),
    engineHash: await hashFile(path.join(staging, 'engine.mjs')) };
  await atomicJson(path.join(staging, 'job.json'), manifest);
  await atomicJson(path.join(staging, 'state.json'), { status: 'ready', done: 0, elapsedMs: 0, updatedAt: Date.now(), error: null });
  await writeFile(path.join(staging, 'results.jsonl'), '');
  await rename(staging, dir);
  return loadJob(root, id);
  } catch (err) {
    await rm(staging, { recursive: true, force: true });
    throw err;
  }
}

export async function loadJob(root, id) {
  const dir = jobDir(root, id);
  const manifest = await json(path.join(dir, 'job.json'));
  const state = await json(path.join(dir, 'state.json'));
  return { ...manifest, state, final: await optionalJson(path.join(dir, 'final.json')) ?? await optionalJson(path.join(dir, 'final-choice', 'choice.json')) };
}
export async function listJobs(root) {
  await mkdir(root, { recursive: true });
  const jobs = [];
  for (const name of await readdir(root)) {
    if (SAFE_ID.test(name)) jobs.push(await loadJob(root, name));
  }
  return jobs.sort((a, b) => b.createdAt - a.createdAt);
}

/** An interrupted append is discarded; every complete record remains authoritative. */
export async function repairTail(file) {
  const handle = await open(file, 'r+');
  try {
    const { size } = await handle.stat();
    if (!size) return;
    let end = size;
    const buffer = Buffer.alloc(4096);
    while (end > 0) {
      const start = Math.max(0, end - buffer.length);
      const { bytesRead } = await handle.read(buffer, 0, end - start, start);
      const newline = buffer.subarray(0, bytesRead).lastIndexOf(10);
      if (newline >= 0) { if (start + newline + 1 !== size) await handle.truncate(start + newline + 1); return; }
      end = start;
    }
    await handle.truncate(0);
  } finally { await handle.close(); }
}
export async function* records(file) {
  const handle = await open(file, 'r');
  let end = (await handle.stat()).size;
  const buffer = Buffer.alloc(4096);
  try {
    while (end > 0) {
      const start = Math.max(0, end - buffer.length);
      const { bytesRead } = await handle.read(buffer, 0, end - start, start);
      const newline = buffer.subarray(0, bytesRead).lastIndexOf(10);
      if (newline >= 0) { end = start + newline + 1; break; }
      end = start;
    }
  } finally { await handle.close(); }
  if (!end) return;
  const stream = createReadStream(file, { end: end - 1 });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let index = 0;
  try {
    for await (const line of lines) {
      if (!line) continue;
      const row = JSON.parse(line);
      if (row.index !== index++) throw new Error('Search results are out of sequence');
      yield row;
    }
  } finally { lines.close(); stream.destroy(); }
}
export async function verifySnapshot(dir, job) {
  if (await hashFile(path.join(dir, 'engine.mjs')) !== job.engineHash) throw new Error('The saved strategy engine has changed');
  for (const data of job.datasets) {
    if (await hashFile(path.join(dir, data.barsFile)) !== data.hash
        || (data.baseFile && await hashFile(path.join(dir, data.baseFile)) !== data.baseHash)) throw new Error(`The saved data snapshot for ${data.symbol} has changed`);
  }
}

export async function command(root, id, action, index = null) {
  if (!['start', 'pause', 'finish', 'final'].includes(action)) throw new Error('Unknown search action');
  if (action === 'final' && (!Number.isSafeInteger(index) || index < 0)) throw new Error('Choose a saved result');
  const dir = jobDir(root, id);
  if (action === 'final') {
    const job = await loadJob(root, id);
    if (job.state.status !== 'completed') throw new Error('Finish the search before opening the final test');
    const row = await findResult(root, id, index);
    const choiceDir = path.join(dir, 'final-choice');
    const choiceFile = path.join(choiceDir, 'choice.json');
    const tmp = `${choiceDir}.${randomUUID()}.tmp`;
    await mkdir(tmp);
    try {
      await atomicJson(path.join(tmp, 'choice.json'), { index, datasetIndex: row.datasetIndex, params: row.params, status: 'queued' });
      try { await rename(tmp, choiceDir); }
      catch (err) { if (!await optionalJson(choiceFile)) throw err; }
    } finally { await rm(tmp, { recursive: true, force: true }); }
    if ((await json(choiceFile)).index !== index) throw new Error('This job already reserves its final test for another candidate');
  }
  await atomicJson(path.join(dir, 'request.json'), { id: randomUUID(), action, index });
}

export async function resultPage(root, id, datasetIndex = 0, metric = 'expectancy', minTrades = 1) {
  const job = await loadJob(root, id);
  if (!Number.isInteger(datasetIndex) || !job.datasets[datasetIndex]) throw new Error('Unknown dataset');
  if (!['netPnl', 'expectancy', 'profitFactor', 'returnPct'].includes(metric)) throw new Error('Unknown metric');
  const top = [];
  let count = 0;
  const file = path.join(jobDir(root, id), 'results.jsonl');
  for await (const row of records(file)) {
    if (row.datasetIndex !== datasetIndex) continue;
    count++;
    if (row.stats.tradeCount < minTrades) continue;
    top.push(row);
    top.sort((a, b) => (b.stats[metric] ?? -Infinity) - (a.stats[metric] ?? -Infinity) || a.index - b.index);
    if (top.length > 50) top.pop();
  }
  return { count, rows: top };
}
export async function findResult(root, id, index) {
  if (!Number.isSafeInteger(index) || index < 0) throw new Error('Invalid result index');
  for await (const row of records(path.join(jobDir(root, id), 'results.jsonl'))) if (row.index === index) return row;
  throw new Error('No such saved result');
}

export async function exportResults(root, id, file, format) {
  if (!['csv', 'jsonl'].includes(format)) throw new Error('Choose CSV or JSONL');
  const job = await loadJob(root, id);
  const source = path.join(jobDir(root, id), 'results.jsonl');
  const relative = path.relative(path.resolve(root), path.resolve(file));
  if (!relative || (!relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))) throw new Error('Export outside the search job storage folder');
  const temp = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temp, 'w');
  const quote = (v) => `"${String(v ?? '').replaceAll('"', '""')}"`;
  const statsKeys = ['tradeCount', 'netPnl', 'returnPct', 'winRate', 'maxDrawdownPct', 'profitFactor', 'expectancy', 'feesPaid'];
  const paramsKeys = Object.keys(job.config.base);
  const metadata = ['job', 'index', 'strategy', 'symbol', 'timeframe', 'engineHash', 'dataHash', 'periods', 'costs', 'balance', 'pointValue', 'sizeStep', 'minSize', 'params'];
  let completed = false;
  try {
    if (format === 'csv') await handle.writeFile([...metadata, ...paramsKeys.map((key) => `param_${key}`), ...['train', 'validation'].flatMap((period) => statsKeys.map((key) => `${period}_${key}`))].map(quote).join(',') + '\r\n');
    for await (const row of records(source)) {
      const data = job.datasets[row.datasetIndex];
      const out = { job: id, strategy: job.config.strategy, symbol: data.symbol, timeframe: data.timeframe, engineHash: job.engineHash, dataHash: data.hash,
        periods: data.periods, costs: job.config.costs, balance: job.config.balance, pointValue: job.config.pointValue, sizeStep: job.config.sizeStep, minSize: job.config.minSize, ...row };
      const values = [id, row.index, out.strategy, out.symbol, out.timeframe, out.engineHash, out.dataHash, JSON.stringify(out.periods), JSON.stringify(out.costs), out.balance, out.pointValue, out.sizeStep, out.minSize, JSON.stringify(row.params),
        ...paramsKeys.map((key) => Array.isArray(row.params[key]) ? JSON.stringify(row.params[key]) : row.params[key]),
        ...statsKeys.map((key) => row.stats[key]), ...statsKeys.map((key) => row.validation[key])];
      await handle.writeFile(format === 'jsonl' ? JSON.stringify(out) + '\n' : values.map(quote).join(',') + '\r\n');
    }
    await handle.sync();
    completed = true;
  } finally { await handle.close(); if (!completed) await rm(temp, { force: true }); }
  await rename(temp, file);
  return { file, bytes: (await stat(file)).size };
}
