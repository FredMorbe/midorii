import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataProvider } from '../src/core/ports/DataProvider';
import type { BarRange } from '../src/core/ports/MarketDataFeed';
import type { OHLCV } from '../src/core/model/ohlcv';
import { aggregateBars, fixedTimeframeMs, planResample } from '../src/data/resample';
import { withResampling } from '../src/data/ResamplingProvider';

const MIN = 60_000;
const bar = (t: number, o: number, h: number, l: number, c: number, v?: number): OHLCV => ({ time: t, open: o, high: h, low: l, close: c, ...(v != null ? { volume: v } : {}) });

describe('fixedTimeframeMs', () => {
    it('reads the spellings a timeframe comes in', () => {
        expect(fixedTimeframeMs('1')).toBe(MIN);
        expect(fixedTimeframeMs('60')).toBe(60 * MIN);
        expect(fixedTimeframeMs('D')).toBe(1440 * MIN);
        expect(fixedTimeframeMs('W')).toBe(7 * 1440 * MIN);
        expect(fixedTimeframeMs('30S')).toBe(30_000);
        expect(fixedTimeframeMs('4h')).toBe(240 * MIN);
        expect(fixedTimeframeMs('2d')).toBe(2880 * MIN);
    });
    it('has no length for the calendar month or for nonsense', () => {
        for (const bad of ['M', '', 'abc', '0', '-5', '1.5']) expect(fixedTimeframeMs(bad), bad).toBeNull();
    });
});

describe('planResample', () => {
    const supported = ['1', '5', '15', '60', '240', 'D', 'W'];
    it('answers null for a timeframe the provider declares', () => {
        expect(planResample('15', supported)).toBeNull();
        expect(planResample('D', supported)).toBeNull();
    });
    it('answers null when the provider declares nothing', () => {
        expect(planResample('7', undefined)).toBeNull();
        expect(planResample('7', [])).toBeNull();
    });
    it('builds from the longest declared timeframe that divides the target', () => {
        expect(planResample('7', supported)).toEqual({ base: '1', bucketMs: 7 * MIN, ratio: 7 });
        expect(planResample('30', supported)).toEqual({ base: '15', bucketMs: 30 * MIN, ratio: 2 });
        expect(planResample('180', supported)).toEqual({ base: '60', bucketMs: 180 * MIN, ratio: 3 });
        expect(planResample('480', supported)).toEqual({ base: '240', bucketMs: 480 * MIN, ratio: 2 });
        expect(planResample('2880', supported)).toEqual({ base: 'D', bucketMs: 2880 * MIN, ratio: 2 });
    });
    it('uses the provider spelling for a timeframe it declares under another name', () => {
        expect(planResample('1440', supported)).toEqual({ base: 'D', bucketMs: 1440 * MIN, ratio: 1 });
        expect(planResample('1h', supported)).toEqual({ base: '60', bucketMs: 60 * MIN, ratio: 1 });
    });
    it('never builds from the week, and gives up on a target nothing divides', () => {
        expect(planResample('20160', ['W'])).toBeNull();
        expect(planResample('7', ['5', '15'])).toBeNull();
        expect(planResample('M', supported)).toBeNull();
    });
});

describe('aggregateBars', () => {
    it('combines candles into epoch-aligned buckets', () => {
        const out = aggregateBars([
            bar(0, 10, 12, 9, 11, 1), bar(MIN, 11, 15, 10, 14, 2), bar(2 * MIN, 14, 14, 8, 9, 3),
            bar(3 * MIN, 9, 10, 7, 8, 4), bar(4 * MIN, 8, 9, 6, 7, 5),
        ], 3 * MIN);
        expect(out).toEqual([
            { time: 0, open: 10, high: 15, low: 8, close: 9, volume: 6 },
            { time: 3 * MIN, open: 9, high: 10, low: 6, close: 7, volume: 9 },
        ]);
    });
    it('sorts its input, skips empty buckets and leaves volume out when none had any', () => {
        const out = aggregateBars([bar(10 * MIN, 5, 6, 4, 5), bar(0, 1, 2, 0, 1)], 5 * MIN);
        expect(out.map((b) => b.time)).toEqual([0, 10 * MIN]);
        expect(out[0]).not.toHaveProperty('volume');
    });
    it('does not change the candles it was given', () => {
        const input = [bar(0, 1, 2, 0, 1, 1), bar(MIN, 1, 5, 0, 2, 1)];
        const copy = structuredClone(input);
        aggregateBars(input, 5 * MIN);
        expect(input).toEqual(copy);
    });
});

interface Fake extends DataProvider {
    calls: Array<{ timeframe: string; range: BarRange }>;
    push(timeframe: string, b: OHLCV): void;
}

function fakeProvider(supported: string[] | undefined, source: OHLCV[], opts: { stream?: boolean } = {}): Fake {
    const calls: Fake['calls'] = [];
    let listener: ((b: OHLCV) => void) | null = null;
    const provider = {
        calls,
        info: () => ({ name: 'fake', supportedTimeframes: supported, capabilities: { enumerate: false, stream: opts.stream !== false, symbolInfo: false } }),
        getBars: async (_t: string, timeframe: string, range: BarRange) => {
            calls.push({ timeframe, range });
            return source.filter((b) => (range.from == null || b.time >= range.from) && (range.to == null || b.time <= range.to)).slice(range.limit != null ? -range.limit : undefined);
        },
        ...(opts.stream === false ? {} : { subscribe: (_t: string, _tf: string, cb: (b: OHLCV) => void) => { listener = cb; return () => { listener = null; }; } }),
        listSymbols: async () => [],
        push: (_tf: string, b: OHLCV) => listener?.(b),
    };
    return provider as unknown as Fake;
}

describe('withResampling', () => {
    const minutes = Array.from({ length: 60 }, (_, i) => bar(i * MIN, i, i + 1, i - 1, i + 0.5, 1));

    it('passes a declared timeframe straight through', async () => {
        const fake = fakeProvider(['1', '5'], minutes);
        const out = await withResampling(fake).getBars('X', '5', { limit: 3 });
        expect(fake.calls).toEqual([{ timeframe: '5', range: { limit: 3 } }]);
        expect(out).toHaveLength(3);
    });

    it('builds a timeframe the provider lacks, asking for the longest base that divides it', async () => {
        const fake = fakeProvider(['1', '5'], minutes);
        const out = await withResampling(fake).getBars('X', '10', { from: 0, to: 59 * MIN });
        expect(fake.calls[0]!.timeframe).toBe('5');
        expect(out.map((b) => b.time)).toEqual([0, 10, 20, 30, 40, 50].map((m) => m * MIN));
        expect(out[0]).toMatchObject({ open: 0, close: 9.5, volume: 10 });
    });

    it('starts the base request on a bucket boundary and asks for a bucket more than the limit', async () => {
        const fake = fakeProvider(['1'], minutes);
        await withResampling(fake).getBars('X', '7', { from: 20 * MIN, limit: 4 });
        expect(fake.calls[0]!.range.from).toBe(14 * MIN); // 20 min floored to a 7 min boundary
        expect(fake.calls[0]!.range.limit).toBe(4 * 7 + 7);
    });

    it('returns at most the limit, dropping the oldest, partial candle', async () => {
        const fake = fakeProvider(['1'], minutes);
        const out = await withResampling(fake).getBars('X', '10', { limit: 3 });
        expect(out).toHaveLength(3);
        expect(out[out.length - 1]!.time).toBe(50 * MIN);
    });

    it('caps what one request asks the provider for', async () => {
        const fake = fakeProvider(['1'], minutes);
        await withResampling(fake, { maxBaseBars: 100 }).getBars('X', '60', { limit: 1000 });
        expect(fake.calls[0]!.range.limit).toBe(100);
    });

    it('answers a declared timeframe under another spelling with the provider own', async () => {
        const fake = fakeProvider(['1', 'D'], minutes);
        await withResampling(fake).getBars('X', '1440', { limit: 2 });
        expect(fake.calls[0]!.timeframe).toBe('D');
    });

    it('leaves a provider that declares nothing alone, and forwards everything else', async () => {
        const fake = fakeProvider(undefined, minutes);
        const wrapped = withResampling(fake);
        await wrapped.getBars('X', '7', { limit: 2 });
        expect(fake.calls[0]!.timeframe).toBe('7');
        await expect(wrapped.listSymbols!()).resolves.toEqual([]);
        expect(wrapped.info!().name).toBe('fake');
    });

    it('has no stream when the provider has none', () => {
        const wrapped = withResampling(fakeProvider(['1'], minutes, { stream: false }));
        expect(wrapped.subscribe).toBeUndefined();
        expect('subscribe' in wrapped).toBe(false);
    });
});

describe('withResampling live', () => {
    beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(Date.UTC(2026, 10, 14, 10, 12, 30))); });
    afterEach(() => { vi.useRealTimers(); });

    it('builds the forming candle from the base stream and the candles its bucket already has', async () => {
        const now = Date.now();
        const bucket = Math.floor(now / (5 * MIN)) * (5 * MIN); // 10:10
        const seeded = [bar(bucket, 100, 105, 99, 104, 10), bar(bucket + MIN, 104, 106, 103, 105, 20)];
        const fake = fakeProvider(['1'], seeded);
        const got: OHLCV[] = [];
        const stop = withResampling(fake).subscribe!('X', '5', (b) => got.push(b));
        fake.push('1', bar(bucket + 2 * MIN, 105, 108, 104, 107, 5)); // arrives while the seed is loading
        await vi.advanceTimersByTimeAsync(0);
        expect(got).toHaveLength(1);
        expect(got[0]).toEqual({ time: bucket, open: 100, high: 108, low: 99, close: 107, volume: 35 });

        fake.push('1', bar(bucket + 2 * MIN, 105, 109, 104, 108, 7)); // the same base candle again, updated
        expect(got[1]).toEqual({ time: bucket, open: 100, high: 109, low: 99, close: 108, volume: 37 });
        stop();
    });

    it('starts a new candle when the stream moves into the next bucket', async () => {
        const now = Date.now();
        const bucket = Math.floor(now / (5 * MIN)) * (5 * MIN);
        const fake = fakeProvider(['1'], [bar(bucket, 1, 2, 0, 1, 1)]);
        const got: OHLCV[] = [];
        withResampling(fake).subscribe!('X', '5', (b) => got.push(b));
        await vi.advanceTimersByTimeAsync(0);
        fake.push('1', bar(bucket + 5 * MIN, 50, 60, 40, 55, 3));
        expect(got[got.length - 1]).toEqual({ time: bucket + 5 * MIN, open: 50, high: 60, low: 40, close: 55, volume: 3 });
    });

    it('keeps building the open bucket when a late candle from an older one arrives', async () => {
        const bucket = Math.floor(Date.now() / (5 * MIN)) * (5 * MIN);
        const fake = fakeProvider(['1'], [bar(bucket, 1, 2, 0, 1)]);
        const got: OHLCV[] = [];
        withResampling(fake).subscribe!('X', '5', (b) => got.push(b));
        await vi.advanceTimersByTimeAsync(0);
        fake.push('1', bar(bucket + 6 * MIN, 9, 9, 9, 9));
        const count = got.length;
        fake.push('1', bar(bucket + MIN, 5, 5, 5, 5));
        expect(got).toHaveLength(count + 1); // emitted, but as the open bucket, not the old one
        expect(got[got.length - 1]!.time).toBe(bucket + 5 * MIN);
    });

    it('stops listening once unsubscribed', async () => {
        const bucket = Math.floor(Date.now() / (5 * MIN)) * (5 * MIN);
        const fake = fakeProvider(['1'], [bar(bucket, 1, 2, 0, 1)]);
        const got: OHLCV[] = [];
        const stop = withResampling(fake).subscribe!('X', '5', (b) => got.push(b));
        await vi.advanceTimersByTimeAsync(0);
        stop();
        const count = got.length;
        fake.push('1', bar(bucket + MIN, 5, 5, 5, 5));
        expect(got).toHaveLength(count);
    });

    it('still builds from the stream when the seed cannot be fetched', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const bucket = Math.floor(Date.now() / (5 * MIN)) * (5 * MIN);
        const fake = fakeProvider(['1'], []);
        fake.getBars = async () => { throw new Error('offline'); };
        const got: OHLCV[] = [];
        withResampling(fake).subscribe!('X', '5', (b) => got.push(b));
        fake.push('1', bar(bucket + MIN, 5, 6, 4, 5, 1));
        await vi.advanceTimersByTimeAsync(0);
        expect(got[0]).toMatchObject({ time: bucket, open: 5, close: 5 });
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });
});
