import { describe, it, expect } from 'vitest';
import { searchSpace, searchParams } from '../shared/analysis/searchPlan.js';
import { createSearchExperiment, validateSearch, searchPeriods, type SearchConfig } from '../app/renderer/backtest/searchEngine';
import { runSweep } from '../app/renderer/backtest/sweepRunner';
import { runBacktest } from '../shared/engine/backtest';
import { buildStrategy } from '../app/renderer/strategies';
import { sliceBars, summarizeBacktest } from '../app/renderer/backtest/experiment';

const STEP = 300_000;
const chain = [[100,101,99,100],[100,102,99.5,101],[101,110,100.5,109],[109,109.5,107,108],[108,108.5,106,107],[107,111,106.5,107.5],[107.5,108,105,105.5],[105.5,106,100,100.5],[100.5,104,99,99.5],[99.5,101,98,100.5],[100.5,104.5,100,103],[103,103.5,95,96],[96,96.5,89,90],[90,91,89.5,90.5]];
const bars = Array.from({ length: 40 }, (_, day) => chain.map(([open, high, low, close], i) => ({ time: Date.parse('2024-04-01T13:20:00Z') + day * 86_400_000 + i * STEP, open: open!, high: high!, low: low!, close: close!, volume: 1 }))).flat();
const config: SearchConfig = { name: 'Offline experiment', strategy: 'silverbullet', axes: { rrr: { from: 1, to: 3, step: 1 } }, base: { riskMode: 'percent', riskValue: 1, maxLeverage: 1 }, method: 'grid', seed: '42', maxAttempts: 100, budgetMs: 60_000, workers: 2, metric: 'expectancy', minTrades: 1, balance: 10_000, costs: { feeRate: 0, feePerUnit: 0, spreadPct: 0, slippagePct: 0 }, pointValue: 1, sizeStep: null, minSize: null };

describe('offline search calculations', () => {
    it('matches the existing sweep on the same training period and actually trades', async () => {
        const checked = validateSearch(config);
        const experiment = createSearchExperiment(checked, bars, null, STEP);
        const sweep = await runSweep({ strategy: config.strategy, ranges: { rrr: { from: 1, to: 3, step: 1 } }, base: config.base, bars, from: bars[0]!.time, to: bars[bars.length - 1]!.time + STEP, trainFraction: 0.6, costs: config.costs, stepMs: STEP, minTrades: 1 });
        for (let i = 0; i < 3; i++) {
            const row = experiment.evaluate(i);
            expect(row.stats.tradeCount).toBeGreaterThan(0);
            expect(row.stats).toEqual(sweep.results[i]!.stats);
            expect(row.params.rrr).toBe(i + 1);
        }
    });
    it('uses earlier history for validation warmup but counts only validation trades', () => {
        const experiment = createSearchExperiment(validateSearch(config), bars, null, STEP);
        const row = experiment.evaluate(0);
        const period = experiment.periods.validation;
        const history = sliceBars(bars, bars[0]!.time, period.to);
        const direct = runBacktest({ bars: history, strategy: buildStrategy(config.strategy, row.params, history), stepMs: STEP, tradeFrom: period.from, broker: { balance: config.balance, costs: config.costs } });
        expect(row.validation).toEqual(summarizeBacktest(direct));
        expect(row.validation.tradeCount).toBeGreaterThan(0);
        expect(direct.trades.every((trade) => (trade as { openedAt: number }).openedAt >= period.from)).toBe(true);
    });
    it('does not read the final period while searching', () => {
        const first = createSearchExperiment(validateSearch(config), bars, null, STEP);
        const changed = bars.map((bar) => bar.time >= first.periods.holdout.from ? { ...bar, open: 9999, high: 10000, low: 9000, close: 9500 } : bar);
        const second = createSearchExperiment(validateSearch(config), changed, null, STEP);
        const a = first.evaluate(0); const b = second.evaluate(0);
        expect(a.stats).toEqual(b.stats); expect(a.validation).toEqual(b.validation);
        expect(first.run(a.params, 'holdout').stats.tradeCount).toBeGreaterThan(0);
    });
    it('refuses unknown axes, invalid settings, and empty split periods before running', () => {
        expect(() => validateSearch({ ...config, axes: { typo: { values: [1] } } })).toThrow('Unknown setting');
        expect(() => validateSearch({ ...config, axes: { rrr: { values: [-1] } } })).toThrow();
        expect(() => validateSearch({ ...config, costs: { feeRate: -1 } })).toThrow();
        expect(() => searchPeriods(bars.slice(0, 4), STEP)).toThrow();
    });
});

describe('lazy search combinations', () => {
    it('creates the Cartesian product lazily, with categorical settings and exact decimal ranges', () => {
        const space = searchSpace({ rrr: { from: 1.2, to: 1.4, step: 0.1 }, enabled: { values: [false, true] } });
        expect(space.total).toBe(6);
        expect(Array.from({ length: 6 }, (_, i) => searchParams(space, { fixed: 'kept' }, i))).toEqual([
            { fixed: 'kept', rrr: 1.2, enabled: false }, { fixed: 'kept', rrr: 1.2, enabled: true },
            { fixed: 'kept', rrr: 1.3, enabled: false }, { fixed: 'kept', rrr: 1.3, enabled: true },
            { fixed: 'kept', rrr: 1.4, enabled: false }, { fixed: 'kept', rrr: 1.4, enabled: true },
        ]);
    });
    it('visits every random combination once and resumes with the same seed', () => {
        const space = searchSpace({ a: { from: 0, to: 14, step: 1 }, b: { values: ['x', 'y'] } });
        const all = Array.from({ length: space.total }, (_, i) => searchParams(space, {}, i, 'random', 'same'));
        expect(new Set(all.map((v) => JSON.stringify(v))).size).toBe(space.total);
        expect(searchParams(space, {}, 17, 'random', 'same')).toEqual(all[17]);
        expect(searchParams(space, {}, 0, 'random', 'different')).not.toEqual(all[0]);
    });
    it('handles trillions of combinations without allocating their product', () => {
        const space = searchSpace({ a: { from: 0, to: 99999, step: 1 }, b: { from: 0, to: 99999, step: 1 }, c: { values: [1, 2, 3] } });
        expect(space.total).toBe(30_000_000_000);
        expect(searchParams(space, {}, space.total - 1)).toEqual({ a: 99999, b: 99999, c: 3 });
    });
});
