// A refused /prices request says why. The venue answers a bad request with an error code in
// the body; a message that only said "HTTP 400" left a bot that could not start with nothing
// to act on, and the one place that could name the cause (the request itself) was thrown away.
// See app/electron/data/capital.js.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// @ts-expect-error — capital.js is main-process JavaScript with no type declarations.
import { capitalPrices, configureCapital } from '../app/electron/data/capital.js';

const CREDS = { apiKey: 'k', identifier: 'me@example.com', password: 'p', env: 'demo' as const };

/** A session that opens, and a /prices that answers with `prices` — recording every URL. */
function venue(prices: (url: string) => { ok: boolean; status: number; body: unknown | 'unreadable' }) {
    const urls: string[] = [];
    const fetcher = vi.fn(async (url: unknown) => {
        const target = String(url);
        urls.push(target);
        if (target.endsWith('/session')) {
            return {
                ok: true,
                json: async () => ({ currentAccountId: 'test-account' }),
                headers: new Headers({ cst: 'cst-token', 'x-security-token': 'sec-token' }),
            } as unknown as Response;
        }
        const answer = prices(target);
        return {
            ok: answer.ok,
            status: answer.status,
            headers: new Headers(),
            json: async () => {
                if (answer.body === 'unreadable') throw new Error('not json');
                return answer.body;
            },
        } as unknown as Response;
    });
    return { urls, fetcher: fetcher as unknown as typeof fetch };
}

describe('capitalPrices when the venue refuses', () => {
    const realFetch = globalThis.fetch;

    beforeEach(() => configureCapital(CREDS));
    afterEach(() => {
        globalThis.fetch = realFetch;
        configureCapital(null);
        vi.restoreAllMocks();
    });

    it('names the venue\'s reason and the window that was asked for', async () => {
        const { fetcher } = venue(() => ({ ok: false, status: 400, body: { errorCode: 'error.invalid.daterange' } }));
        globalThis.fetch = fetcher;

        const from = Date.UTC(2026, 9, 1, 0, 0);
        const to = Date.UTC(2026, 9, 6, 6, 30);
        const failure = capitalPrices('BTCUSD', 'MINUTE_5', { from, to, limit: 3000 });

        await expect(failure).rejects.toThrow(/HTTP 400/);
        await expect(failure).rejects.toThrow(/error\.invalid\.daterange/);
        // What was asked for — the part a person can compare against what the venue allows.
        await expect(failure).rejects.toThrow(/BTCUSD/);
        await expect(failure).rejects.toThrow(/resolution=MINUTE_5/);
        await expect(failure).rejects.toThrow(/from=2026-10-01T00%3A00%3A00/);
    });

    it('still reports the status when the venue gives no reason', async () => {
        const { fetcher } = venue(() => ({ ok: false, status: 400, body: 'unreadable' }));
        globalThis.fetch = fetcher;

        await expect(capitalPrices('BTCUSD', 'MINUTE_5', { limit: 10 })).rejects.toThrow(/HTTP 400/);
    });

    it('is untouched on success: rows come back as bars', async () => {
        const { fetcher } = venue(() => ({
            ok: true,
            status: 200,
            body: {
                prices: [{
                    snapshotTimeUTC: '2026-10-06T06:00:00',
                    openPrice: { bid: 1, ask: 2 }, highPrice: { bid: 3, ask: 4 },
                    lowPrice: { bid: 0.5, ask: 1 }, closePrice: { bid: 2, ask: 3 },
                    lastTradedVolume: 7,
                }],
            },
        }));
        globalThis.fetch = fetcher;

        const bars = await capitalPrices('BTCUSD', 'MINUTE_5', { limit: 10 });

        expect(bars).toEqual([{ time: Date.UTC(2026, 9, 6, 6, 0), open: 1, high: 3, low: 0.5, close: 2, volume: 7 }]);
    });
});
