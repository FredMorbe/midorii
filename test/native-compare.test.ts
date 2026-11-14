import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OHLCV } from '../src/core/model/ohlcv';
import type { DataProvider } from '../src/core/ports/DataProvider';
import type { NativeIndicatorContext, NativeIndicatorOutput } from '../src/core/native-indicators/NativeIndicator';
import { alignCloses, anchorIndex, rebased, spreadValues } from '../src/core/native-indicators/compare/compareMath';
import { compareDescriptor, spreadDescriptor } from '../src/core/native-indicators/compare/CompareIndicator';
import { COMPARE_LINE } from '../src/core/palette';

const H = 3_600_000;
const bar = (i: number, close: number): OHLCV => ({ time: i * H, open: close, high: close, low: close, close });
const closes = (cs: number[], from = 0): OHLCV[] => cs.map((c, i) => bar(from + i, c));

describe('compare math', () => {
    const main = closes([100, 102, 104, 106]);

    it('lines the second market up by open time, with a gap where it has no bar', () => {
        const other = new Map([[0, 10], [2 * H, 12], [3 * H, Number.NaN]]);
        expect(alignCloses(main, other)).toEqual([10, null, 12, null]);
    });

    it('finds the first bar both markets have, from a point in time or from the start', () => {
        const aligned = [null, 5, 6, 7];
        expect(anchorIndex(main, aligned, null)).toBe(1);
        expect(anchorIndex(main, aligned, 2 * H)).toBe(2);
        expect(anchorIndex(main, aligned, 99 * H)).toBe(1); // past every bar: fall back to the first one
        expect(anchorIndex(main, [null, null, null, null], null)).toBe(-1);
    });

    it('does not anchor on a price that cannot be divided by', () => {
        expect(anchorIndex(main, [0, 5, 6, 7], null)).toBe(1);
    });

    it('rebases the second market so markets that move alike lie on top of each other', () => {
        const aligned = [10, 10.2, 10.4, 10.6]; // the same percentage moves as the chart's own bars
        const out = rebased(main, aligned, 0);
        out.forEach((v, i) => expect(v).toBeCloseTo(main[i]!.close, 9));
    });

    it('runs the second market away from the chart when it moves more', () => {
        const aligned = [10, 11, 12, 13]; // +30% against the chart's +6%
        const out = rebased(main, aligned, 0);
        expect(out[0]).toBeCloseTo(100);
        expect(out[3]).toBeCloseTo(130);
    });

    it('leaves a gap before the data and wherever the second market has none', () => {
        const out = rebased(main, [null, 10, null, 12], 1);
        expect(Number.isNaN(out[0]!)).toBe(true);
        expect(out[1]).toBeCloseTo(102);
        expect(Number.isNaN(out[2]!)).toBe(true);
        expect(rebased(main, [null, null, null, null], -1).every(Number.isNaN)).toBe(true);
    });

    it('gives a ratio or a difference, and nothing where a price is missing or the divisor is zero', () => {
        const aligned = [50, null, 0, 53];
        expect(spreadValues(main, aligned, 'ratio').map((v) => (Number.isNaN(v) ? null : v))).toEqual([2, null, null, 106 / 53]);
        expect(spreadValues(main, aligned, 'difference').map((v) => (Number.isNaN(v) ? null : v))).toEqual([50, null, 104, 53]);
    });
});

interface Harness {
    ctx: NativeIndicatorContext;
    emitted: NativeIndicatorOutput[];
    status: string[];
    provider: DataProvider & { calls: Array<{ ticker: string; range: unknown }>; push(b: OHLCV): void; unsubscribed(): boolean };
    setBars(b: OHLCV[]): void;
    lastPoints(): Array<number | null>;
}

function harness(mainBars: OHLCV[], otherBars: OHLCV[], opts: { resolves?: boolean; failFetch?: boolean } = {}): Harness {
    let bars = mainBars;
    let listener: ((b: OHLCV) => void) | null = null;
    let unsub = false;
    const calls: Array<{ ticker: string; range: unknown }> = [];
    const provider = {
        calls,
        getBars: async (ticker: string, _tf: string, range: { from?: number; to?: number }) => {
            calls.push({ ticker, range });
            if (opts.failFetch) throw new Error('offline');
            return otherBars.filter((b) => (range.from == null || b.time >= range.from) && (range.to == null || b.time <= range.to));
        },
        subscribe: (_t: string, _tf: string, cb: (b: OHLCV) => void) => { listener = cb; unsub = false; return () => { listener = null; unsub = true; }; },
        push: (b: OHLCV) => listener?.(b),
        unsubscribed: () => unsub,
    } as unknown as Harness['provider'];
    const emitted: NativeIndicatorOutput[] = [];
    const status: string[] = [];
    const ctx = {
        symbol: 'binance:BTCUSDT',
        timeframe: '60',
        live: true,
        bars: () => bars,
        data: {
            resolve: (s: string) => (opts.resolves === false ? null : { provider: 'fake', ticker: s.replace(/^.*:/, '') }),
            providerInstance: () => provider,
        },
        emit: (o: NativeIndicatorOutput) => { emitted.push(o); },
        pushData: () => undefined,
        setStatus: (s: string) => { status.push(s); },
    } as unknown as NativeIndicatorContext;
    return {
        ctx, emitted, status, provider,
        setBars: (b) => { bars = b; },
        lastPoints: () => (emitted[emitted.length - 1]?.series?.[0] as { points: Array<{ value: number | null }> } | undefined)?.points.map((p) => p.value) ?? [],
    };
}

const flush = async (): Promise<void> => { await vi.advanceTimersByTimeAsync(0); };

describe('the compare indicator', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('is a price overlay that follows the viewport, and the spread a pane of its own', () => {
        expect(compareDescriptor).toMatchObject({ type: 'compare', overlay: true, paneHint: 'price', reactsToViewport: true, multiInstance: true });
        expect(spreadDescriptor).toMatchObject({ type: 'spread', overlay: false, paneHint: 'new', multiInstance: true });
        expect(compareDescriptor.inputsSchema().map((i) => i.key)).toEqual(['symbol', 'color', 'width']);
        expect(spreadDescriptor.inputsSchema().map((i) => i.key)).toEqual(['symbol', 'mode', 'color', 'width']);
    });

    it('plots nothing, and says nothing is loading, while no symbol is chosen', () => {
        const h = harness(closes([100, 102]), []);
        const ind = compareDescriptor.create();
        ind.start(h.ctx, compareDescriptor.defaultInputs());
        expect(h.emitted[h.emitted.length - 1]).toEqual({ series: [] });
        expect(h.provider.calls).toHaveLength(0);
        expect(h.status[h.status.length - 1]).toBe('idle');
    });

    it('loads the second market from the first bar of the chart and plots it rebased', async () => {
        const h = harness(closes([100, 102, 104]), closes([10, 11, 12]));
        const ind = compareDescriptor.create();
        ind.start(h.ctx, { ...compareDescriptor.defaultInputs(), symbol: 'fake:ETHUSDT' });
        expect(h.status).toContain('loading');
        await flush();
        expect(h.provider.calls[0]).toEqual({ ticker: 'ETHUSDT', range: { from: 0 } });
        const points = h.lastPoints();
        expect(points[0]).toBeCloseTo(100);
        expect(points[2]).toBeCloseTo(120);
        expect(h.status[h.status.length - 1]).toBe('live');
        const series = h.emitted[h.emitted.length - 1]!.series![0]!;
        expect(series.title).toBe('ETHUSDT');
        expect(series).toMatchObject({ kind: 'line', style: { color: COMPARE_LINE, width: 2 } });
        ind.stop();
    });

    it('rebases from the left edge of what is on screen', async () => {
        const h = harness(closes([100, 100, 100, 100]), closes([10, 20, 20, 40]));
        const ind = compareDescriptor.create();
        ind.start(h.ctx, { ...compareDescriptor.defaultInputs(), symbol: 'fake:X' });
        await flush();
        expect(h.lastPoints()[3]).toBeCloseTo(400);
        ind.onViewport({ from: 2 * H, to: 3 * H });
        await vi.advanceTimersByTimeAsync(100);
        expect(h.lastPoints()[3]).toBeCloseTo(200); // 40 against 20 at the new left edge
        ind.stop();
    });

    it('follows the live second market and the live chart', async () => {
        const h = harness(closes([100, 102]), closes([10, 11]));
        const ind = compareDescriptor.create();
        ind.start(h.ctx, { ...compareDescriptor.defaultInputs(), symbol: 'fake:X' });
        await flush();
        h.provider.push(bar(1, 13));
        await vi.advanceTimersByTimeAsync(100);
        expect(h.lastPoints()[1]).toBeCloseTo(130);
        h.setBars(closes([100, 102, 104]));
        h.provider.push(bar(2, 14));
        ind.onBars();
        await vi.advanceTimersByTimeAsync(100);
        expect(h.lastPoints()).toHaveLength(3);
        expect(h.lastPoints()[2]).toBeCloseTo(140);
        ind.stop();
    });

    it('asks for the older stretch when the chart loads further back, once', async () => {
        const h = harness(closes([100, 102], 5), closes([1, 2, 3, 4, 5, 6, 7], 0));
        const ind = compareDescriptor.create();
        ind.start(h.ctx, { ...compareDescriptor.defaultInputs(), symbol: 'fake:X' });
        await flush();
        expect(h.provider.calls).toHaveLength(1);
        h.setBars(closes([90, 92, 94, 96, 98, 100, 102]));
        ind.onBars();
        await flush();
        expect(h.provider.calls).toHaveLength(2);
        expect(h.provider.calls[1]!.range).toEqual({ from: 0, to: 5 * H });
        ind.onBars();
        await flush();
        expect(h.provider.calls).toHaveLength(2);
        ind.stop();
    });

    it('takes inputs set before it has started, and uses the ones start is given', async () => {
        const h = harness(closes([100, 102]), closes([10, 11]));
        const ind = compareDescriptor.create();
        expect(() => ind.setInputs({ ...compareDescriptor.defaultInputs(), symbol: 'fake:X' })).not.toThrow();
        expect(h.provider.calls).toHaveLength(0);
        ind.start(h.ctx, { ...compareDescriptor.defaultInputs(), symbol: 'fake:Y' });
        await flush();
        expect(h.provider.calls[0]!.ticker).toBe('Y');
        ind.stop();
    });

    it('does not fetch again for a change that leaves the symbol alone, and does for a new one', async () => {
        const h = harness(closes([100, 102]), closes([10, 11]));
        const ind = compareDescriptor.create();
        ind.start(h.ctx, { ...compareDescriptor.defaultInputs(), symbol: 'fake:X' });
        await flush();
        ind.setInputs({ ...compareDescriptor.defaultInputs(), symbol: 'fake:X', color: '#00ff00' });
        expect((h.emitted[h.emitted.length - 1]!.series![0] as { style: { color: string } }).style.color).toBe('#00ff00');
        expect(h.provider.calls).toHaveLength(1);
        ind.setInputs({ ...compareDescriptor.defaultInputs(), symbol: 'fake:Y' });
        await flush();
        expect(h.provider.calls).toHaveLength(2);
        expect(h.provider.calls[1]!.ticker).toBe('Y');
        ind.stop();
    });

    it('reports a symbol nothing serves and plots nothing', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const h = harness(closes([100]), [], { resolves: false });
        const ind = compareDescriptor.create();
        ind.start(h.ctx, { ...compareDescriptor.defaultInputs(), symbol: 'nowhere:X' });
        await flush();
        expect(warn).toHaveBeenCalled();
        expect(h.provider.calls).toHaveLength(0);
        warn.mockRestore();
    });

    it('reports a failed load and keeps going with a gap', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const h = harness(closes([100, 102]), [], { failFetch: true });
        const ind = compareDescriptor.create();
        ind.start(h.ctx, { ...compareDescriptor.defaultInputs(), symbol: 'fake:X' });
        await flush();
        expect(warn).toHaveBeenCalled();
        expect(h.lastPoints()).toEqual([null, null]);
        ind.stop();
        warn.mockRestore();
    });

    it('stops listening and fetching once stopped, and drops an answer that comes after', async () => {
        const h = harness(closes([100, 102]), closes([10, 11]));
        const ind = compareDescriptor.create();
        ind.start(h.ctx, { ...compareDescriptor.defaultInputs(), symbol: 'fake:X' });
        ind.stop();
        await flush();
        expect(h.emitted.every((o) => (o.series?.length ?? 0) === 0)).toBe(true);
        const ind2 = compareDescriptor.create();
        ind2.start(h.ctx, { ...compareDescriptor.defaultInputs(), symbol: 'fake:X' });
        await flush();
        ind2.stop();
        expect(h.provider.unsubscribed()).toBe(true);
    });
});

describe('the spread indicator', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('plots the ratio by default and names it after both markets', async () => {
        const h = harness(closes([100, 102]), closes([50, 51]));
        const ind = spreadDescriptor.create();
        ind.start(h.ctx, { ...spreadDescriptor.defaultInputs(), symbol: 'fake:ETHUSDT' });
        await flush();
        expect(h.lastPoints()).toEqual([2, 2]);
        expect(h.emitted[h.emitted.length - 1]!.series![0]!.title).toBe('Ratio BTCUSDT/ETHUSDT');
        ind.stop();
    });

    it('plots the difference when asked', async () => {
        const h = harness(closes([100, 102]), closes([30, 40]));
        const ind = spreadDescriptor.create();
        ind.start(h.ctx, { ...spreadDescriptor.defaultInputs(), symbol: 'fake:ETHUSDT', mode: 'Difference' });
        await flush();
        expect(h.lastPoints()).toEqual([70, 62]);
        expect(h.emitted[h.emitted.length - 1]!.series![0]!.title).toBe('Spread BTCUSDT/ETHUSDT');
        ind.stop();
    });

    it('ignores the viewport: its values do not depend on what is on screen', async () => {
        const h = harness(closes([100, 102]), closes([50, 51]));
        const ind = spreadDescriptor.create();
        ind.start(h.ctx, { ...spreadDescriptor.defaultInputs(), symbol: 'fake:X' });
        await flush();
        const count = h.emitted.length;
        ind.onViewport({ from: 0, to: H });
        await vi.advanceTimersByTimeAsync(200);
        expect(h.emitted).toHaveLength(count);
        ind.stop();
    });
});
