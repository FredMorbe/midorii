import { afterEach, describe, expect, it } from 'vitest';
import { buildStrategy, resolveStrategyParams, setRuleStrategies, strategyCatalog } from '../app/renderer/strategies';
import { runBacktest } from '../shared/engine/backtest';
import type { OHLCV } from '../src/core/model/ohlcv';

const IDS = ['nq_amd_wick_1m', 'nq_amd_wick_3m'];
const MINUTE = 60_000;
const rows = [
    ...Array.from({ length: 16 }, (_, i) => [70 + i, 72 + i, 69 + i, 71 + i]),
    ...Array.from({ length: 10 }, (_, i) => i % 2 === 0 ? [99.6, 101, 99.4, 100.6] : [100.4, 100.6, 99, 99.4]),
    [100.5, 102, 99.3, 99.6],
    ...Array.from({ length: 5 }, () => [99.6, 100, 99.2, 99.4]),
];
const bars: OHLCV[] = rows.map(([open, high, low, close], i) => ({
    time: Date.parse('2024-01-02T14:00:00Z') + i * MINUTE,
    open: open! + 18_000, high: high! + 18_000, low: low! + 18_000, close: close! + 18_000, volume: 1,
}));
const instrument = { pointValue: 20, sizeStep: 1, minSize: 1 };
const broker = { ...instrument, balance: 200_000, costs: { feeRate: 0, spreadPct: 0, slippagePct: 0, feePerUnit: 0 } };

afterEach(() => setRuleStrategies([]));

describe('saved NQ AMD research presets', () => {
    it('keeps both presets when custom research definitions refresh', () => {
        setRuleStrategies([]);
        expect(IDS.map(id => strategyCatalog().find(spec => spec.id === id))).toEqual([
            expect.objectContaining({ id: IDS[0], timeframe: '1', researchOnly: true,
                backtestDefaults: { symbol: 'NQ', balance: 200_000, pointValue: 20, sizeStep: 1, minSize: 1 } }),
            expect.objectContaining({ id: IDS[1], timeframe: '3', researchOnly: true,
                backtestDefaults: { symbol: 'NQ', balance: 200_000, pointValue: 20, sizeStep: 1, minSize: 1 } }),
        ]);
    });

    it('preserves the two audited default configurations', () => {
        for (const [index, id] of IDS.entries()) {
            expect(resolveStrategyParams(id)).toMatchObject({
                riskMode: 'fixed', riskValue: 2000, capLeverage: true, maxLeverage: 20,
                rrr: 1.5, minBars: 5, compression: index === 0 ? 0.8 : 0.6,
                maxFakeoutBars: 12, stopValue: 100, maxHoldBars: 600, breakEvenAtR: 0, trailAtR: 0,
            });
        }
    });

    it.each(IDS)('%s fills after a wick-only midpoint confirmation with one NQ contract', id => {
        const strategy = buildStrategy(id, {}, bars, undefined, instrument);
        const result = runBacktest({ bars, strategy, broker });
        const entry = result.orders.find(order => order.tag?.startsWith('amd-wick:'));
        expect(entry).toMatchObject({ side: 'sell', size: 1, placedAt: bars[26]!.time, filledAt: bars[27]!.time });
        expect(result.openPosition).toMatchObject({ size: -1, riskPerUnit: 100, stopLoss: 18199.6, takeProfit: 17949.6 });
    });

    it('skips an entry when the ceiling cannot preserve the planned cash risk', () => {
        const strategy = buildStrategy(IDS[0]!, { maxLeverage: 1 }, bars, undefined, instrument);
        expect(runBacktest({ bars, strategy, broker }).orders).toHaveLength(0);
    });

    it('rejects a point value that would change the NQ sizing convention', () => {
        expect(() => buildStrategy(IDS[0]!, {}, bars, undefined, { pointValue: 2 })).toThrow(/20/);
    });
});
