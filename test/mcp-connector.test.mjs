import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { request as httpRequest } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createResearchService } from '../app/mcp/service.mjs';
import { startResearchBridge } from '../app/mcp/bridge.mjs';
import { researchClient } from '../app/mcp/client.mjs';
import { TOOLS, toolInput } from '../app/mcp/tools.mjs';
import { loadRules, saveRule } from '../app/mcp/store.mjs';
import { mergeBars } from '../app/electron/data/store/barStore.js';

const cleanup = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const rule = (overrides = {}) => ({ id: 'custom_mcp', name: 'MCP test', description: 'A historical research test', timeframe: '1',
  long: [{ all: [{ left: { series: 'close' }, op: 'gt', right: { series: 'open' } }] }],
  stop: { type: 'points', value: 2 }, maxHoldBars: 2, ...overrides });

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'midorii-mcp-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const service = createResearchService({ userData: root });
  cleanup.push(() => service.close());
  const bars = Array.from({ length: 100 }, (_, i) => ({ time: Date.UTC(2026, 0, 1) + i * 60_000,
    open: 100 + Math.sin(i / 2) * 8, high: 101 + Math.sin(i / 2) * 8,
    low: 99 + Math.sin(i / 2) * 8, close: 100.5 + Math.sin(i / 2) * 8, volume: 10 }));
  await mergeBars(path.join(root, 'market-data'), 'TEST', bars);
  const connectionFile = path.join(root, 'connection.json');
  const bridge = await startResearchBridge({ service, connectionFile });
  cleanup.push(() => bridge.close());
  return { root, service, bars, connectionFile, connection: JSON.parse(await readFile(connectionFile, 'utf8')), call: researchClient(connectionFile) };
}

async function waitJob(call, id, tool = 'midorii_get_backtest') {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const job = await call(tool, { id });
    if (job.status !== 'running') return job;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error('Backtest did not finish');
}

describe('Midorii research MCP connector', () => {
  it('creates strategies over real stdio MCP, runs the real worker, and reads durable trades', async () => {
    const { connectionFile, bars, root } = await fixture();
    const transport = new StdioClientTransport({ command: process.execPath,
      args: [path.resolve('app/mcp/server.mjs'), '--connection', connectionFile], stderr: 'pipe' });
    const client = new Client({ name: 'midorii-test', version: '1' });
    await client.connect(transport);
    cleanup.push(() => client.close());
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual(Object.keys(TOOLS).sort());
    expect(listed.tools.some((tool) => /order|bot|credential|execute|eval/.test(tool.name))).toBe(false);
    const call = async (name, args = {}) => {
      const reply = await client.callTool({ name, arguments: args });
      if (reply.isError) throw new Error(reply.content[0].text);
      return JSON.parse(reply.content[0].text);
    };
    expect(await call('midorii_status')).toMatchObject({ liveTrading: false });
    expect((await call('midorii_list_datasets')).datasets[0].symbol).toBe('TEST');
    await call('midorii_create_strategy', { definition: rule() });
    const saved = await call('midorii_save_strategy_settings', { id: 'custom_mcp', params: { riskMode: 'fixed', riskValue: 20 }, timeframe: '1' });
    expect(saved.params.riskValue).toBe(20);
    const started = await call('midorii_start_backtest', { strategy: 'custom_mcp', symbol: 'TEST', timeframe: '1',
      from: bars[0].time, to: bars.at(-1).time + 60_000, costs: { feeRate: 0, feePerUnit: 0, spreadPct: 0, slippagePct: 0 } });
    const done = await waitJob(call, started.id);
    expect(done.status, done.error).toBe('completed');
    expect(done.run.stats.tradeCount).toBeGreaterThan(5);
    const result = await call('midorii_get_run', { id: done.run.id, limit: 2 });
    expect(result.trades).toHaveLength(2);
    expect(result.totalTrades).toBeGreaterThan(2);
    expect(result.definition.name).toBe('MCP test');
    expect(result.params.riskValue).toBe(20);
    await call('midorii_update_strategy', { definition: rule({ name: 'Updated' }) });
    expect((await call('midorii_get_run', { id: done.run.id })).definition.name).toBe('MCP test');
    expect((await call('midorii_get_strategy', { id: 'custom_mcp' })).definition.name).toBe('Updated');
    expect((await call('midorii_list_runs')).runs[0].id).toBe(done.run.id);
    expect((await loadRules(path.join(root, 'strategies')))[0].name).toBe('Updated');
    const refusal = await client.callTool({ name: 'midorii_start_backtest', arguments: { strategy: 'custom_mcp', symbol: 'TEST', timeframe: '1',
      from: bars[0].time, to: bars.at(-1).time, venue: 'live' } });
    expect(refusal.isError).toBe(true);
  }, 25_000);

  it('rejects unauthenticated callers, browser origins, forged hosts, and generic IPC access', async () => {
    const { connection, call } = await fixture();
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${connection.token}` };
    const body = JSON.stringify({ name: 'capital:open-position', arguments: {} });
    expect((await fetch(connection.url, { method: 'POST', body, headers: { 'Content-Type': 'application/json' } })).status).toBe(401);
    expect((await fetch(connection.url, { method: 'POST', body, headers: { ...headers, Origin: 'https://untrusted.example' } })).status).toBe(403);
    const forgedHost = await new Promise((resolve, reject) => {
      const request = httpRequest(connection.url, { method: 'POST', headers: { ...headers, Host: 'untrusted.example' } }, (response) => {
        response.resume(); resolve(response.statusCode);
      });
      request.on('error', reject); request.end(body);
    });
    expect(forgedHost).toBe(403);
    await expect(call('capital:open-position', {})).rejects.toThrow('Unknown research tool');
    for (const name of ['__proto__', 'constructor', 'midorii_live_order', 'bots:start', 'eval']) {
      expect(() => toolInput(name, {})).toThrow('Unknown research tool');
    }
    expect(() => toolInput('midorii_open_view', { view: 'bot' })).toThrow();
    expect(() => toolInput('midorii_create_strategy', { definition: { ...rule(), onBar: 'buy()' } })).toThrow();
    await expect(call('midorii_get_bars', { symbol: '../../credentials', timeframe: '1', from: 0, to: 1 })).rejects.toThrow();
    await expect(call('midorii_save_strategy_settings', { id: 'silverbullet', params: { unknown: 1 }, timeframe: '1' })).rejects.toThrow('Unknown strategy setting');
  });

  it('reports worker failures and releases its single run slot', async () => {
    const { call, bars } = await fixture();
    await call('midorii_create_strategy', { definition: rule() });
    const request = { strategy: 'custom_mcp', symbol: 'MISSING', timeframe: '1', from: bars[0].time, to: bars.at(-1).time + 60_000 };
    const job = await call('midorii_start_backtest', request);
    const done = await waitJob(call, job.id);
    expect(done).toMatchObject({ status: 'failed', run: null });
    expect(done.error).toContain('No local data');
    expect((await call('midorii_status', {})).activeBacktest).toBeNull();
    const second = await call('midorii_start_backtest', { ...request, symbol: 'TEST' });
    expect((await waitJob(call, second.id)).status).toBe('completed');
  });

  it('runs native sweeps over real stdio MCP, saves every combination, and preserves validation stats', async () => {
    const { connectionFile, bars } = await fixture();
    const client = new Client({ name: 'midorii-sweep-test', version: '1' });
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [path.resolve('app/mcp/server.mjs'), '--connection', connectionFile], stderr: 'pipe' }));
    cleanup.push(() => client.close());
    const call = async (name, args = {}) => {
      const reply = await client.callTool({ name, arguments: args });
      if (reply.isError) throw new Error(reply.content[0].text);
      return JSON.parse(reply.content[0].text);
    };
    await call('midorii_create_strategy', { definition: rule() });
    const job = await call('midorii_start_sweep', { strategy: 'custom_mcp', symbol: 'TEST', timeframe: '1',
      from: bars[0].time, to: bars.at(-1).time + 60_000,
      params: { riskValue: 0.5 }, ranges: { stopValue: { from: 1, to: 3, step: 1 }, rrr: { from: 1, to: 2, step: 1 } },
      trainFraction: 0.7, minTrades: 1, showCount: 2, costs: { feeRate: 0, feePerUnit: 0, spreadPct: 0, slippagePct: 0 } });
    const done = await waitJob(call, job.id, 'midorii_get_sweep');
    expect(done.status, done.error).toBe('completed');
    expect(done.progress).toMatchObject({ done: 6, total: 6 });
    expect(done.sweep.combinationCount).toBe(6);
    const page = await call('midorii_get_sweep_result', { id: done.sweep.id, limit: 2 });
    expect(page.totalResults).toBe(6);
    expect(page.results).toHaveLength(2);
    expect(page.base.riskValue).toBe(0.5);
    expect(page.definition.name).toBe('MCP test');
    expect(page.best[0].outOfSample.tradeCount).toBeGreaterThan(0);
    expect(page.split.train.to).toBe(page.split.test.from);
    const later = await call('midorii_get_sweep_result', { id: done.sweep.id, offset: 2, limit: 4 });
    const combinations = [...page.results, ...later.results];
    expect(new Set(combinations.map((entry) => JSON.stringify(entry.params))).size).toBe(6);
    expect(combinations.every((entry) => entry.params.riskValue === 0.5)).toBe(true);
    await call('midorii_update_strategy', { definition: rule({ name: 'New rules' }) });
    expect((await call('midorii_get_sweep_result', { id: done.sweep.id })).definition.name).toBe('MCP test');
    expect((await call('midorii_list_sweeps')).sweeps[0].id).toBe(done.sweep.id);
    expect((await call('midorii_cancel_sweep', { id: job.id })).status).toBe('completed');
    await expect(call('midorii_get_backtest', { id: job.id })).rejects.toThrow('Unknown research job');
  }, 25_000);

  it('validates sweep ranges and parameter bounds before reserving a worker', async () => {
    const { call, bars } = await fixture();
    await call('midorii_create_strategy', { definition: rule() });
    const request = { strategy: 'custom_mcp', symbol: 'TEST', timeframe: '1', from: bars[0].time, to: bars.at(-1).time + 60_000 };
    for (const ranges of [{}, { stopValue: { from: 2, to: 1, step: 1 } }, { stopValue: { from: 0, to: 1, step: 1e-300 } },
      { stopValue: { from: 0, to: 5000, step: 1 } }, { unknown: { from: 1, to: 2, step: 1 } },
      { riskMode: { from: 1, to: 2, step: 1 } }, { rrr: { from: -2, to: -1, step: 1 } },
      { maxHoldBars: { from: 1.5, to: 2.5, step: 1 } }]) {
      await expect(call('midorii_start_sweep', { ...request, ranges })).rejects.toThrow();
      expect((await call('midorii_status', {})).activeSweep).toBeNull();
    }
    expect(() => toolInput('midorii_start_sweep', { ...request, ranges: { rrr: { from: 1, to: 2, step: 1 } }, venue: 'live' })).toThrow();
    expect(() => toolInput('midorii_start_sweep', { ...request, ranges: { rrr: { from: 1, to: 2, step: 1 } }, maxTradesPerDay: 3 })).toThrow();
  });

  it('cancels only sweep workers and prevents simultaneous research jobs', async () => {
    const { call, bars } = await fixture();
    await call('midorii_create_strategy', { definition: rule() });
    const request = { strategy: 'custom_mcp', symbol: 'TEST', timeframe: '1', from: bars[0].time, to: bars.at(-1).time + 60_000 };
    const started = await Promise.allSettled([
      call('midorii_start_sweep', { ...request, ranges: { stopValue: { from: 1, to: 5000, step: 1 } } }),
      call('midorii_start_sweep', { ...request, ranges: { stopValue: { from: 1, to: 5000, step: 1 } } }),
    ]);
    expect(started.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const job = started.find((result) => result.status === 'fulfilled').value;
    await expect(call('midorii_start_backtest', request)).rejects.toThrow('already running');
    expect((await call('midorii_cancel_sweep', { id: job.id })).status).toBe('cancelled');
    expect((await call('midorii_get_sweep', { id: job.id })).status).toBe('cancelled');
    expect((await call('midorii_status', {})).activeSweep).toBeNull();
    expect((await call('midorii_list_sweeps', {})).sweeps).toHaveLength(0);
    const backtest = await call('midorii_start_backtest', request);
    await expect(call('midorii_cancel_sweep', { id: backtest.id })).rejects.toThrow('Unknown research job');
    expect((await waitJob(call, backtest.id)).status).toBe('completed');
  });

  it('serializes concurrent strategy creates without losing either entry', async () => {
    const { root } = await fixture();
    const dir = path.join(root, 'strategies');
    await Promise.all([saveRule(dir, rule()), saveRule(dir, rule({ id: 'custom_second' }))]);
    expect(await loadRules(dir)).toHaveLength(2);
    await expect(saveRule(dir, rule())).rejects.toThrow('already exists');
    await expect(saveRule(dir, rule({ id: 'custom_missing' }), true)).rejects.toThrow('No custom');
    await writeFile(path.join(dir, 'research-strategies.json'), '{broken');
    await expect(saveRule(dir, rule({ id: 'custom_other' }))).rejects.toThrow();
  });

  it('returns a useful disconnected error without requiring the app at MCP initialization', async () => {
    const { root } = await fixture();
    await expect(researchClient(path.join(root, 'missing.json'))('midorii_status', {})).rejects.toThrow('Start Midorii');
  });
});
