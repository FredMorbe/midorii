import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { listDatasets, readBars, bucketEnd, parseTimeframe } from '../electron/data/store/barStore.js';
import { loadStrategySettings, saveStrategySettings } from '../electron/data/store/strategyStore.js';
import { listRuns, loadRun, saveRun } from '../electron/data/store/runStore.js';
import { listSweeps, loadSweep, saveSweep } from '../electron/data/store/sweepStore.js';
import { loadRules, saveRule } from './store.mjs';
import { toolInput } from './tools.mjs';

const defaultEngine = fileURLToPath(new URL('../search-dist/automation.mjs', import.meta.url));

export function createResearchService({ userData, enginePath = defaultEngine, notify = () => {} }) {
  const dataDir = path.join(userData, 'market-data');
  const strategiesDir = path.join(userData, 'strategies');
  const runsDir = path.join(userData, 'backtests');
  const sweepsDir = path.join(userData, 'sweeps');
  const jobs = new Map();
  let active = null;
  let closed = false;

  async function catalog() {
    const [engine, definitions, settings] = await Promise.all([
      import(pathToFileURL(enginePath).href), loadRules(strategiesDir), loadStrategySettings(strategiesDir),
    ]);
    engine.setRuleStrategies(definitions);
    return { engine, definitions, entries: engine.strategyCatalog().map((spec) => ({ ...spec, settings: settings[spec.id] ?? {} })) };
  }

  async function call(name, raw) {
    if (closed) throw new Error('The Midorii research service has stopped.');
    const input = toolInput(name, raw);
    switch (name) {
      case 'midorii_status': return { app: 'Midorii', connected: true, scope: 'historical-research', liveTrading: false,
        customStrategies: 'backtest-only', activeBacktest: active?.kind === 'backtest' ? active.id : null,
        activeSweep: active?.kind === 'sweep' ? active.id : null };
      case 'midorii_open_view': notify({ view: input.view }); return { view: input.view };
      case 'midorii_list_datasets': return { datasets: await listDatasets(dataDir) };
      case 'midorii_get_bars': {
        if (input.to <= input.from) throw new Error('The end must be after the start.');
        const end = Math.min(input.to, Date.now());
        const bars = (await readBars(dataDir, input.symbol, input.timeframe, input.from, end, true))
          .filter((bar) => bar.time >= input.from && bucketEnd(bar.time, parseTimeframe(input.timeframe)) <= end);
        return { total: bars.length, offset: input.offset, bars: bars.slice(input.offset, input.offset + input.limit) };
      }
      case 'midorii_list_strategies': return { strategies: (await catalog()).entries };
      case 'midorii_get_strategy': {
        const { entries, definitions } = await catalog();
        const strategy = entries.find((entry) => entry.id === input.id);
        if (!strategy) throw new Error('Unknown strategy');
        return { ...strategy, definition: definitions.find((entry) => entry.id === input.id) ?? null };
      }
      case 'midorii_create_strategy':
      case 'midorii_update_strategy': {
        const definition = await saveRule(strategiesDir, input.definition, name === 'midorii_update_strategy');
        notify();
        return { definition, researchOnly: true };
      }
      case 'midorii_save_strategy_settings': {
        const { engine, entries } = await catalog();
        const spec = entries.find((entry) => entry.id === input.id);
        if (!spec) throw new Error('Unknown strategy');
        strictParams(spec, input.params);
        const params = engine.resolveStrategyParams(input.id, input.params);
        await saveStrategySettings(strategiesDir, input.id, { ...params, __timeframe: input.timeframe });
        notify();
        return { id: input.id, params, timeframe: input.timeframe };
      }
      case 'midorii_start_backtest':
      case 'midorii_start_sweep': {
        const sweep = name === 'midorii_start_sweep';
        const kind = sweep ? 'sweep' : 'backtest';
        if (input.to <= input.from) throw new Error('The end must be after the start.');
        if (active) throw new Error(`A research job is already running: ${active.id}`);
        // Reserve before awaiting storage so two concurrent callers cannot launch two workers.
        const job = { id: `b${randomUUID().replaceAll('-', '')}`, kind, status: 'running', createdAt: Date.now(),
          ...(sweep ? { sweep: null, progress: null } : { run: null }), error: null };
        active = job;
        try {
          const { engine, entries, definitions } = await catalog();
          if (closed) throw new Error('The research service stopped.');
          const spec = entries.find((entry) => entry.id === input.strategy);
          if (!spec) throw new Error('Unknown strategy');
          strictParams(spec, input.params);
          const defaults = Object.fromEntries(Object.entries(spec.settings).filter(([key]) => !key.startsWith('__')));
          const params = engine.resolveStrategyParams(input.strategy, { ...defaults, ...input.params });
          const definition = definitions.find((entry) => entry.id === input.strategy) ?? null;
          const request = { ...input, params };
          if (sweep) engine.validateSweep(input.strategy, params, input.ranges);
          const worker = new Worker(new URL('./worker.mjs', import.meta.url), {
            workerData: { request, dataDir, definitions, enginePath, mode: kind }, env: {},
          });
          job.worker = worker;
          jobs.set(job.id, job);
          while (jobs.size > 100) jobs.delete(jobs.keys().next().value);
          let finished = false;
          let received = false;
          const finish = (error, status) => {
            if (finished) return;
            finished = true;
            clearTimeout(timeout);
            if (error) { job.status = 'failed'; job.error = error; }
            else if (status) job.status = status;
            if (active === job) active = null;
            delete job.worker;
            void worker.terminate();
          };
          const timeout = setTimeout(() => finish('Research job exceeded its runtime limit.'), input.timeoutMs ?? 600_000);
          job.cancel = () => { if (!received) finish(null, 'cancelled'); };
          worker.on('message', async (message) => {
            if (finished) return;
            if (message.progress) { job.progress = message.progress; return; }
            received = true;
            clearTimeout(timeout);
            if (message.error) { finish(message.error); return; }
            try {
              const stored = { ...message.result, strategy: spec.id, strategyName: spec.name,
                symbol: input.symbol, timeframe: input.timeframe, from: message.from, to: message.to,
                note: input.note, research: true, definition, coverage: message.coverage };
              if (sweep) job.sweep = await saveSweep(sweepsDir, stored);
              else job.run = await saveRun(runsDir, stored);
              job.status = 'completed';
              job.coverage = message.coverage;
              notify();
              finish();
            } catch (error) { finish(error.message); }
          });
          worker.once('error', (error) => finish(error.message));
          worker.once('exit', (code) => { if (!finished && !received) finish(`Backtest worker exited (${code}).`); });
          return publicJob(job);
        } catch (error) { if (active === job) active = null; throw error; }
      }
      case 'midorii_get_backtest':
      case 'midorii_get_sweep':
      case 'midorii_cancel_sweep': {
        const job = jobs.get(input.id);
        const kind = name === 'midorii_get_backtest' ? 'backtest' : 'sweep';
        if (!job || job.kind !== kind) throw new Error('Unknown research job. Jobs expire when Midorii closes; completed results remain in the library.');
        if (name === 'midorii_cancel_sweep' && job.status === 'running') job.cancel();
        return publicJob(job);
      }
      case 'midorii_list_sweeps': {
        const sweeps = await listSweeps(sweepsDir);
        return { total: sweeps.length, offset: input.offset, sweeps: sweeps.slice(input.offset, input.offset + input.limit) };
      }
      case 'midorii_get_sweep_result': {
        const { results, ...metadata } = await loadSweep(sweepsDir, input.id);
        return { ...metadata, totalResults: results.length, offset: input.offset,
          results: results.slice(input.offset, input.offset + input.limit) };
      }
      case 'midorii_list_runs': {
        const runs = (await listRuns(runsDir)).filter((run) => !['manual', 'replay', 'paper', 'live'].includes(run.strategy));
        return { total: runs.length, offset: input.offset, runs: runs.slice(input.offset, input.offset + input.limit) };
      }
      case 'midorii_get_run': {
        const run = await loadRun(runsDir, input.id);
        if (['manual', 'replay', 'paper', 'live'].includes(run.strategy)) throw new Error('Only historical strategy backtests are available.');
        const { trades, equityCurve, orders, fills, ...metadata } = run;
        return { ...metadata, totalTrades: trades.length, offset: input.offset, trades: trades.slice(input.offset, input.offset + input.limit) };
      }
      default: throw new Error('Unavailable research operation');
    }
  }

  return { call, async close() {
    closed = true;
    if (active?.worker) {
      const job = active;
      job.status = 'failed'; job.error = 'Midorii closed before the backtest completed.';
      await job.worker.terminate();
    }
  } };
}

function strictParams(spec, params) {
  const keys = new Set(spec.params.map((field) => field.key));
  for (const key of Object.keys(params)) if (!keys.has(key)) throw new Error(`Unknown strategy setting: ${key}`);
}

function publicJob({ worker, cancel, ...job }) { return { ...job }; }
