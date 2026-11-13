import { describe, it, expect, vi } from 'vitest';
import { QuoteHub, type PriceSnapshot } from '../app/renderer/watchlist/quoteHub';
import type { DataProvider } from '../src/plugin';
import type { OHLCV } from '../src/core/model/ohlcv';

const bar = (close: number): OHLCV => ({ time: 0, open: close, high: close, low: close, close, volume: 0 });

/** A provider whose history answer and live bars the test controls by hand. */
function fakeProvider(history: () => Promise<OHLCV[]>) {
    let onBar: ((b: OHLCV) => void) | null = null;
    const provider = {
        subscriptions: 0,
        open: 0,
        historyCalls: 0,
        getBars: async () => { provider.historyCalls++; return history(); },
        subscribe: (_t: string, _tf: string, cb: (b: OHLCV) => void) => {
            provider.subscriptions++;
            provider.open++;
            onBar = cb;
            return () => { provider.open--; onBar = null; };
        },
        push: (close: number) => onBar?.(bar(close)),
    };
    return provider;
}

const last = <T,>(list: readonly T[]): T | undefined => list[list.length - 1];
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('QuoteHub', () => {
    it('opens a market once for many listeners and closes it with the last one', async () => {
        const p = fakeProvider(async () => [bar(100), bar(110)]);
        const hub = new QuoteHub({ binance: () => p as unknown as DataProvider });
        const a: PriceSnapshot[] = [];
        const b: PriceSnapshot[] = [];
        const offA = hub.watch('binance:BTCUSDT', (s) => a.push(s));
        const offB = hub.watch('binance:BTCUSDT', (s) => b.push(s));
        expect(p.subscriptions).toBe(1);
        expect(p.historyCalls).toBe(1);
        expect(hub.openCount).toBe(1);

        await flush();
        // The previous close is the reference; until the stream speaks, the last close is the price.
        expect(last(a)).toMatchObject({ price: 110, reference: 100, live: false, error: null });

        p.push(125);
        expect(last(a)).toMatchObject({ price: 125, reference: 100, live: true });
        expect(last(b)).toMatchObject({ price: 125, live: true });

        offA();
        expect(p.open).toBe(1); // still held for the second listener
        offB();
        expect(p.open).toBe(0);
        expect(hub.openCount).toBe(0);
    });

    it('hands a late listener the current snapshot at once', async () => {
        const p = fakeProvider(async () => [bar(100), bar(110)]);
        const hub = new QuoteHub({ x: () => p as unknown as DataProvider });
        hub.watch('x:A', () => undefined);
        await flush();
        p.push(120);
        const seen: PriceSnapshot[] = [];
        hub.watch('x:A', (s) => seen.push(s));
        expect(seen).toHaveLength(1);
        expect(seen[0]).toMatchObject({ price: 120, reference: 100 });
    });

    it('does not let a stream tick be overwritten by a slower history answer', async () => {
        let release: (bars: OHLCV[]) => void = () => undefined;
        const p = fakeProvider(() => new Promise<OHLCV[]>((resolve) => { release = resolve; }));
        const hub = new QuoteHub({ x: () => p as unknown as DataProvider });
        const seen: PriceSnapshot[] = [];
        hub.watch('x:A', (s) => seen.push(s));
        p.push(130);
        release([bar(100), bar(110)]);
        await flush();
        expect(last(seen)).toMatchObject({ price: 130, reference: 100 });
    });

    it('names an unknown data source instead of showing nothing', () => {
        const hub = new QuoteHub({});
        const seen: PriceSnapshot[] = [];
        hub.watch('ghost:A', (s) => seen.push(s));
        hub.watch('bare', (s) => seen.push(s));
        expect(seen[0]!.error).toMatch(/ghost/);
        expect(seen[1]!.error).toMatch(/no data source/i);
        expect(seen.every((s) => s.price == null)).toBe(true);
    });

    it('reports a failed history request and keeps streaming', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const p = fakeProvider(async () => { throw new Error('rate limited'); });
        const hub = new QuoteHub({ x: () => p as unknown as DataProvider });
        const seen: PriceSnapshot[] = [];
        hub.watch('x:A', (s) => seen.push(s));
        await flush();
        expect(last(seen)).toMatchObject({ price: null, error: 'rate limited' });
        p.push(50);
        expect(last(seen)).toMatchObject({ price: 50, live: true, error: null });
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });

    it('works for a market with no stream, from its history alone', async () => {
        const p = { getBars: async () => [bar(10), bar(12)] };
        const hub = new QuoteHub({ local: () => p as unknown as DataProvider });
        const seen: PriceSnapshot[] = [];
        hub.watch('local:NQ', (s) => seen.push(s));
        await flush();
        expect(last(seen)).toMatchObject({ price: 12, reference: 10, live: false });
    });

    it('limits how many history requests run at once', async () => {
        let running = 0;
        let peak = 0;
        const releases: Array<() => void> = [];
        const p = {
            getBars: () => new Promise<OHLCV[]>((resolve) => {
                running++;
                peak = Math.max(peak, running);
                releases.push(() => { running--; resolve([bar(1), bar(2)]); });
            }),
        };
        const hub = new QuoteHub({ x: () => p as unknown as DataProvider });
        for (let i = 0; i < 8; i++) hub.watch(`x:S${i}`, () => undefined);
        expect(peak).toBe(3);
        // Drain: each release lets the next waiting one start.
        while (releases.length) { releases.shift()!(); await flush(); }
        expect(peak).toBe(3);
    });
});
