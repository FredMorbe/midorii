import { describe, it, expect, vi, afterAll } from 'vitest';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mergeBars } from '../app/electron/data/store/barStore.js';
import { searchBars, searchConfig, STEP } from './search-fixture.mjs';

const { handlers, saveDialog } = vi.hoisted(() => ({ handlers: new Map(), saveDialog: vi.fn() }));
vi.mock('electron', () => ({ ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, dialog: { showSaveDialog: saveDialog } }));
import { registerSearchIpc } from '../app/electron/search/ipc.js';
let root;
afterAll(async () => {
  if (!root) return;
  const lock = await readFile(path.join(root, 'search-jobs', 'service.lock'), 'utf8').then(JSON.parse).catch(() => null);
  if (lock) { try { process.kill(lock.pid); } catch {} }
  await new Promise((resolve) => setTimeout(resolve, 300));
  await rm(root, { recursive: true, force: true });
});
const invoke = (name, input) => handlers.get(name)(null, input);
async function until(read, check) {
  const started = Date.now();
  for (;;) {
    const value = await read(); if (check(value)) return value;
    if (Date.now() - started > 15_000) throw new Error(JSON.stringify(value));
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
describe('search job IPC bridge', () => {
  it('starts a detached worker, reviews saved candidates, and prevents opening other final periods', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'midorii-search-ipc-'));
    const data = path.join(root, 'market-data'); await mkdir(data);
    const bars = searchBars(); await mergeBars(data, 'LOCAL', bars, { baseMs: STEP, timeframe: '5m' });
    registerSearchIpc({ getPath: () => root });
    const job = await invoke('search:prepare', { config: searchConfig(), symbols: ['LOCAL'], timeframes: ['5m'], from: bars[0].time, to: bars.at(-1).time + STEP, intrabar: true });
    await expect(invoke('search:review', { id: job.id, index: 0, period: 'holdout' })).rejects.toThrow();
    await invoke('search:command', { id: job.id, action: 'start' });
    const finished = await until(() => invoke('search:list'), (jobs) => jobs[0].state.status === 'completed');
    expect(finished[0].state.done).toBe(3);
    const page = await invoke('search:results', { id: job.id, datasetIndex: 0, metric: 'netPnl', minTrades: 1 });
    const candidate = page.rows[0];
    const review = await invoke('search:review', { id: job.id, index: candidate.index, period: 'validation' });
    expect(review.result.stats.netPnl).toBe(candidate.validation.netPnl);
    expect(review.result.stats.tradeCount).toBe(candidate.validation.tradeCount);
    const csv = path.join(root, 'export.csv'); saveDialog.mockResolvedValue({ canceled: false, filePath: csv });
    const exported = await invoke('search:export', { id: job.id, format: 'csv' }); expect(exported.bytes).toBeGreaterThan(0);
    expect(await readFile(csv, 'utf8')).toContain('validation_netPnl');
    await invoke('search:command', { id: job.id, action: 'final', index: candidate.index });
    await until(() => invoke('search:list'), (jobs) => jobs[0].final?.status === 'completed');
    const final = await invoke('search:review', { id: job.id, index: candidate.index, period: 'holdout' });
    expect(final.result.trades.length).toBeGreaterThan(0);
    await expect(invoke('search:review', { id: job.id, index: (candidate.index + 1) % 3, period: 'holdout' })).rejects.toThrow('reserved');
    await expect(invoke('search:command', { id: job.id, action: 'start' })).rejects.toThrow('reserved');
  }, 25_000);
});
