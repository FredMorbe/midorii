import { afterEach, describe, expect, it } from 'vitest';
import { validateRuleStrategy } from '../shared/strategies/rules.js';
import { buildStrategy, resolveStrategyParams, setRuleStrategies, strategyCatalog } from '../app/renderer/strategies';
import { runBacktest, type BacktestBar } from '../shared/engine/backtest';
import { startRefusal, newBot } from '../app/renderer/bot/botTypes';
import { runSweep } from '../app/renderer/backtest/sweepRunner';
import { createSearchExperiment, validateSearch } from '../app/renderer/backtest/searchEngine';

const definition = (overrides: Record<string, unknown> = {}) => validateRuleStrategy({
    id: 'custom_test', name: 'Test rule', description: 'Historical test rule', timeframe: '1',
    indicators: [{ id: 'average', type: 'sma', period: 2 }],
    long: [{ all: [{ left: { series: 'close' }, op: 'gt', right: { series: 'average' } }] }],
    stop: { type: 'points', value: 2 }, maxHoldBars: 2, ...overrides,
});
const bars = (prices: number[]): BacktestBar[] => prices.map((close, i) => ({
    time: Date.UTC(2026, 0, 1) + i * 60_000, open: close, high: close, low: close, close, volume: 10,
}));
const history = bars(Array.from({ length: 100 }, (_, i) => 100 + Math.sin(i / 2) * 8));
const free = { feeRate: 0, spreadPct: 0, slippagePct: 0, feePerUnit: 0 };
afterEach(() => setRuleStrategies([]));

function run(data: BacktestBar[], pointValue = 1) {
    const params = resolveStrategyParams('custom_test', { riskMode: 'fixed', riskValue: 100, capLeverage: false });
    return runBacktest({ bars: data, strategy: buildStrategy('custom_test', params, data, undefined, { pointValue }),
        broker: { costs: free, pointValue }, stepMs: 60_000 });
}

describe('custom research strategies', () => {
    it('registers real metadata and executes against the existing engine', () => {
        setRuleStrategies([definition()]);
        expect(strategyCatalog().find((s) => s.id === 'custom_test')).toMatchObject({ researchOnly: true, name: 'Test rule' });
        const result = run(history);
        expect(result.stats.tradeCount).toBeGreaterThan(5);
        expect(result.warmupBars).toBe(1);
        expect(result.fills[0]).toMatchObject({ time: history[2]!.time, price: history[2]!.open });
    });

    it('uses a cross event once and fills at the next open', () => {
        setRuleStrategies([definition({ indicators: [], maxHoldBars: 100,
            long: [{ all: [{ left: { series: 'close' }, op: 'crossesAbove', right: 100 }] }] })]);
        const data = bars([99, 101, 105, 105, 105]);
        const result = run(data);
        expect(result.fills[0]).toMatchObject({ time: data[2]!.time, price: 105 });
        expect(result.orders.filter((o) => o.tag === 'custom_test' && o.type === 'market')).toHaveLength(1);
    });

    it('anchors protective distances to the actual fill after a gap', () => {
        setRuleStrategies([definition({ indicators: [], long: [{ all: [{ left: { series: 'close' }, op: 'gt', right: 0 }] }] })]);
        const result = run(bars([100, 110]));
        expect(result.openPosition).toMatchObject({ entryPrice: 110, stopLoss: 108 });
    });

    it('preserves risk across instrument point values', () => {
        setRuleStrategies([definition({ indicators: [], long: [{ all: [{ left: { series: 'close' }, op: 'gt', right: 0 }] }] })]);
        const data = bars([100, 100, 98]);
        const unit = run(data, 1);
        const contract = run(data, 10);
        expect(contract.stats.netPnl).toBeCloseTo(unit.stats.netPnl);
        expect(contract.stats.netPnl).toBeCloseTo(-100);
    });

    it('skips positions smaller than an instrument can hold without rounding risk up', () => {
        setRuleStrategies([definition()]);
        const params = resolveStrategyParams('custom_test', { riskMode: 'fixed', riskValue: 1 });
        const sizing = { pointValue: 20, sizeStep: 1, minSize: 1 };
        const result = runBacktest({ bars: history,
            strategy: buildStrategy('custom_test', params, history, undefined, sizing), broker: { costs: free, ...sizing } });
        expect(result.fills).toHaveLength(0);
    });

    it('uses only historical offsets and retains the same signals when future prices change', () => {
        setRuleStrategies([definition()]);
        const prefix = history.slice(0, 40);
        const before = run(prefix).fills;
        const after = run([...prefix, ...history.slice(40).map((bar) => ({ ...bar, open: 10_000, high: 10_000, low: 10_000, close: 10_000 }))]).fills;
        const comparable = (fills: unknown[]) => fills.map((fill) => {
            const { orderId, ...rest } = fill as Record<string, unknown>;
            return rest;
        });
        expect(comparable(after.filter((fill) => (fill as { time: number }).time <= prefix[prefix.length - 1]!.time))).toEqual(comparable(before));
        expect(() => definition({ long: [{ all: [{ left: { series: 'close', offset: -1 }, op: 'gt', right: 1 }] }] })).toThrow();
    });

    it('does not trade when long and short signals conflict', () => {
        const rule = definition();
        setRuleStrategies([definition({ short: rule.long })]);
        expect(run(history).fills).toHaveLength(0);
    });

    it('keeps a run’s captured definition when the registry changes while data loads', () => {
        const original = definition();
        setRuleStrategies([original]);
        const params = resolveStrategyParams(original.id);
        const changed = definition({ long: [], short: original.long });
        setRuleStrategies([changed]);
        const frozen = buildStrategy(original.id, params, history, undefined, { pointValue: 1, definition: original });
        const result = runBacktest({ bars: history, strategy: frozen, broker: { costs: free } });
        expect(result.fills[0]).toMatchObject({ side: 'buy' });
        expect(() => buildStrategy('silverbullet', params, history, undefined, { pointValue: 1, definition: original })).toThrow('different strategy');
    });

    it('supports short entries and rule exits', () => {
        setRuleStrategies([definition({ indicators: [], long: [], maxHoldBars: 100,
            short: [{ all: [{ left: { series: 'close' }, op: 'gt', right: 100 }] }],
            exitShort: [{ all: [{ left: { series: 'close' }, op: 'lt', right: 100 }] }],
            stop: { type: 'points', value: 50 } })]);
        const result = run(bars([105, 104, 99, 98]));
        expect(result.stats.tradeCount).toBe(1);
        expect(result.trades[0]).toMatchObject({ side: 'short', exitPrice: 98 });
    });

    it('rejects unknown series, duplicate ids, arbitrary source, and reserved built-in ids', () => {
        expect(() => definition({ indicators: [{ id: 'close', type: 'ema', period: 2 }] })).toThrow('reserved');
        expect(() => definition({ indicators: [] })).toThrow('Unknown series');
        expect(() => definition({ source: 'process.exit()' })).toThrow();
        expect(() => definition({ id: 'silverbullet' })).toThrow();
        expect(() => definition({ stop: { type: 'percent', value: 100 } })).toThrow();
    });

    it('never makes a rule strategy eligible for paper or real-account bots', () => {
        setRuleStrategies([definition()]);
        const bot = newBot('custom_test', 'capital:EURUSD');
        for (const venue of ['paper', 'capital'] as const) {
            expect(startRefusal({ ...bot, venue })).toContain('historical backtests only');
        }
        setRuleStrategies([]);
        expect(startRefusal(bot)).toContain('historical backtests only');
    });

    it('runs parameter sweeps and snapshot-based searches with custom rules', async () => {
        const rule = definition();
        setRuleStrategies([rule]);
        const sweep = await runSweep({ strategy: rule.id, bars: history,
            from: history[0]!.time, to: history[history.length - 1]!.time + 60_000,
            ranges: { rrr: { from: 1, to: 2, step: 1 } }, minTrades: 1, costs: free, trainFraction: 0 });
        expect(sweep.results.length).toBeGreaterThan(0);
        const config = validateSearch({ definitions: [rule], name: 'Rules', strategy: rule.id, axes: { rrr: { from: 1, to: 2, step: 1 } }, base: {},
            method: 'grid', seed: 'test', maxAttempts: 2, budgetMs: 1000, workers: 1, metric: 'netPnl', minTrades: 1,
            balance: 10_000, pointValue: 1, sizeStep: null, minSize: null, costs: free });
        setRuleStrategies([]);
        const experiment = createSearchExperiment(config, history, null, 60_000);
        expect(experiment.evaluate(0).stats.tradeCount).toBeGreaterThan(0);
    });
});
