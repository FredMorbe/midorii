import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { availableParallelism } from 'node:os';
import { mkdir } from 'node:fs/promises';
import { ipcMain, dialog } from 'electron';
import { prepareJob, listJobs, loadJob, jobDir, json, optionalJson, command, resultPage, exportResults, findResult, decodeBars, verifySnapshot } from './store.js';

const enginePath = fileURLToPath(new URL('../../search-dist/engine.mjs', import.meta.url));
const servicePath = fileURLToPath(new URL('./service.js', import.meta.url));
let launching = null;
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

async function ensureService(root) {
  const lock = await optionalJson(path.join(root, 'service.lock'));
  if (lock && alive(lock.pid)) return;
  if (launching) return launching;
  launching = (async () => {
    await mkdir(root, { recursive: true });
    const env = { ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ATTACH_CONSOLE: '1' };
    for (const key of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'PATH', 'Path', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LOCALAPPDATA']) {
      if (process.env[key]) env[key] = process.env[key];
    }
    const child = spawn(process.execPath, [servicePath, root], { detached: true, windowsHide: true, stdio: 'ignore', env });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
    for (let i = 0; i < 50; i++) {
      const current = await optionalJson(path.join(root, 'service.lock')).catch(() => null);
      if (current && alive(current.pid)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('The search worker did not start. Build its engine with npm run build:search and try again.');
  })();
  try { await launching; } finally { launching = null; }
}

export function registerSearchIpc(app) {
  const root = path.join(app.getPath('userData'), 'search-jobs');
  const dataDir = path.join(app.getPath('userData'), 'market-data');
  ipcMain.handle('search:limits', () => ({ workers: Math.min(8, Math.max(1, Math.floor(availableParallelism() / 2))) }));
  ipcMain.handle('search:prepare', (_event, request) => prepareJob(root, dataDir, request, enginePath));
  ipcMain.handle('search:list', async () => {
    const jobs = await listJobs(root);
    const lock = await optionalJson(path.join(root, 'service.lock'));
    for (const job of jobs) {
      const request = await optionalJson(path.join(jobDir(root, job.id), 'request.json'));
      if (request?.action === 'start') job.state.status = 'queued';
      else if (request?.action === 'pause') job.state.status = 'pausing';
      else if (['running', 'pausing'].includes(job.state.status) && (!lock || !alive(lock.pid))) {
        job.state.status = 'paused';
        job.state.error = 'The search worker stopped. Resume to continue from saved results.';
      }
      if (job.final && ['queued', 'running'].includes(job.final.status) && (!lock || !alive(lock.pid))) {
        job.final.status = 'failed'; job.final.error = 'The final test worker stopped. Retry the same candidate.';
      }
    }
    return jobs;
  });
  ipcMain.handle('search:command', async (_event, { id, action, index }) => {
    const job = await loadJob(root, id);
    if (action === 'start' && job.final) throw new Error('This job has already reserved its final test');
    await command(root, id, action, index);
    await ensureService(root);
    return true;
  });
  ipcMain.handle('search:results', (_event, { id, datasetIndex, metric, minTrades }) => resultPage(root, id, datasetIndex, metric, minTrades));
  ipcMain.handle('search:export', async (_event, { id, format }) => {
    const job = await loadJob(root, id);
    if (!['csv', 'jsonl'].includes(format)) throw new Error('Choose CSV or JSONL');
    const selected = await dialog.showSaveDialog({ title: 'Export search results', defaultPath: `${job.config.name.replace(/[^\w-]/g, '_')}.${format}`, filters: [{ name: format.toUpperCase(), extensions: [format] }] });
    if (selected.canceled || !selected.filePath) return null;
    return exportResults(root, id, selected.filePath, format);
  });
  ipcMain.handle('search:review', async (_event, { id, index, period = 'validation' }) => {
    const job = await loadJob(root, id);
    const row = await findResult(root, id, index);
    if (!['train', 'validation', 'holdout'].includes(period)) throw new Error('Unknown test period');
    if (period === 'holdout' && (job.final?.status !== 'completed' || job.final.index !== index)) throw new Error('The final period is reserved for the job’s selected final candidate');
    const dir = jobDir(root, id);
    await verifySnapshot(dir, job);
    const data = job.datasets[row.datasetIndex];
    const bars = await decodeBars(path.join(dir, data.barsFile));
    const base = data.baseFile ? await decodeBars(path.join(dir, data.baseFile)) : null;
    const engine = await import(pathToFileURL(path.join(dir, 'engine.mjs')).href);
    const experiment = engine.createSearchExperiment(job.config, bars, base, data.stepMs);
    const result = period === 'holdout' ? await json(path.join(dir, 'final-run.json')) : experiment.run(row.params, period);
    return { result, bars: bars.filter((b) => b.time < data.periods[period].to), params: row.params, config: job.config, data, period };
  });
}
