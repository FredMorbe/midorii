// A ranged /prices fetch asks the venue for a window it can answer. Capital.com refuses a
// window that holds more candles than `max` allows (error.invalid.max.daterange: ten days of
// 5-minute bars was refused), so a long range is walked in windows of at most one page of
// candles rather than sent whole. See app/electron/data/capital.js.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// @ts-expect-error — capital.js is main-process JavaScript with no type declarations.
import { capitalPrices, configureCapital } from '../app/electron/data/capital.js';

const CREDS = { apiKey: 'k', identifier: 'me@example.com', password: 'p', env: 'demo' as const };
const MINUTE = 60_000;
const STEP = 5 * MINUTE;

const stamp = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, '');
const parse = (text: string): number => Date.parse(`${text}Z`);

interface Asked { from: number; to: number; max: number }

/** A venue holding one 5-minute candle per slot in [first, last], refusing windows over `max` candles. */
function venue(first: number, last: number) {
    const asked: Asked[] = [];
    const fetcher = vi.fn(async (url: unknown) => {
        const target = String(url);
        if (target.endsWith('/session')) {
            return {
                ok: true,
                json: async () => ({ currentAccountId: 'test-account' }),
                headers: new Headers({ cst: 'cst-token', 'x-security-token': 'sec-token' }),
            } as unknown as Response;
        }
        const q = new URL(target).searchParams;
        const request: Asked = { from: parse(q.get('from') ?? ''), to: parse(q.get('to') ?? ''), max: Number(q.get('max')) };
        asked.push(request);
        const slots: number[] = [];
        for (let t = Math.ceil(request.from / STEP) * STEP; t <= request.to; t += STEP) {
            if (t >= first && t <= last) slots.push(t);
        }
        if (slots.length > request.max) {
            return { ok: false, status: 400, headers: new Headers(), json: async () => ({ errorCode: 'error.invalid.max.daterange' }) } as unknown as Response;
        }
        const prices = slots.map((t) => ({
            snapshotTimeUTC: stamp(t),
            openPrice: { bid: 1 }, highPrice: { bid: 2 }, lowPrice: { bid: 0 }, closePrice: { bid: 1 },
            lastTradedVolume: 1,
        }));
        return { ok: true, status: 200, headers: new Headers(), json: async () => ({ prices }) } as unknown as Response;
    });
    return { asked, fetcher: fetcher as unknown as typeof fetch };
}

describe('capitalPrices over a long range', () => {
    const realFetch = globalThis.fetch;

    beforeEach(() => configureCapital(CREDS));
    afterEach(() => {
        globalThis.fetch = realFetch;
        configureCapital(null);
        vi.restoreAllMocks();
    });

    it('walks ten days of 5-minute bars in windows the venue accepts, and returns every bar once', async () => {
        const from = Date.UTC(2026, 8, 25, 20, 40, 46);
        const to = Date.UTC(2026, 9, 6, 6, 40, 46);
        const { asked, fetcher } = venue(from, to);
        globalThis.fetch = fetcher;

        const bars = await capitalPrices('BTCUSD', 'MINUTE_5', { from, to, limit: 3000 });

        expect(asked.length).toBeGreaterThan(1);
        for (const request of asked) expect((request.to - request.from) / STEP).toBeLessThan(1000);
        const times = bars.map((b: { time: number }) => b.time);
        expect(new Set(times).size).toBe(times.length);
        expect([...times].sort((a, b) => a - b)).toEqual(times);
        const expected = Math.floor(to / STEP) - Math.ceil(from / STEP) + 1;
        expect(times).toHaveLength(expected);
        expect(times[0]).toBe(Math.ceil(from / STEP) * STEP);
    });

    it('keeps a candle that sits exactly on a window edge', async () => {
        const from = Date.UTC(2026, 9, 1, 0, 0, 0);
        const to = from + 2500 * STEP;
        const { fetcher } = venue(from, to);
        globalThis.fetch = fetcher;

        const bars = await capitalPrices('BTCUSD', 'MINUTE_5', { from, to });

        expect(bars).toHaveLength(2501);
    });

    it('asks once when the range fits one page', async () => {
        const from = Date.UTC(2026, 9, 6, 0, 0, 0);
        const to = from + 100 * STEP;
        const { asked, fetcher } = venue(from, to);
        globalThis.fetch = fetcher;

        const bars = await capitalPrices('BTCUSD', 'MINUTE_5', { from, to });

        expect(asked).toHaveLength(1);
        expect(bars).toHaveLength(101);
    });

    it('stops at the end of the range when the market has nothing in the last windows', async () => {
        const from = Date.UTC(2026, 9, 1, 0, 0, 0);
        const { asked, fetcher } = venue(from, from + 10 * STEP);
        globalThis.fetch = fetcher;

        const bars = await capitalPrices('BTCUSD', 'MINUTE_5', { from, to: from + 3000 * STEP });

        expect(bars).toHaveLength(11);
        expect(asked.length).toBeLessThanOrEqual(4);
    });
});
