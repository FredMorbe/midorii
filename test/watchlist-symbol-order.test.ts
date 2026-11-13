import { describe, expect, it } from 'vitest';
import type { SymbolDescriptor } from '../src/core/ports/DataProvider';
import { marketKey, orderPool, pushRecent } from '../app/renderer/watchlist/symbolOrder';

const d = (ticker: string, provider: string, extra: Partial<SymbolDescriptor> = {}): SymbolDescriptor => ({ ticker, provider, ...extra });
const tickers = (list: SymbolDescriptor[]): string[] => list.map((s) => s.ticker);

describe('marketKey', () => {
    it('ignores the case of the venue and the ticker', () => {
        expect(marketKey('Binance:ethusdt')).toBe('binance:ETHUSDT');
        expect(marketKey('AAPL')).toBe('AAPL');
    });
});

describe('pushRecent', () => {
    it('puts the newest first and drops the older copy', () => {
        expect(pushRecent(['a:X', 'a:Y'], 'a:Y', 5)).toEqual(['a:Y', 'a:X']);
    });
    it('caps the list', () => {
        expect(pushRecent(['a:1', 'a:2', 'a:3'], 'a:4', 3)).toEqual(['a:4', 'a:1', 'a:2']);
    });
    it('returns the same array when the newest is already first', () => {
        const list = ['a:X', 'a:Y'];
        expect(pushRecent(list, 'a:X', 5)).toBe(list);
    });
});

describe('orderPool', () => {
    const pool = [d('AAA', 'binance'), d('BBB', 'binance'), d('CCC', 'binance'), d('DDD', 'capital', { prefix: 'NASDAQ' })];

    it('puts favorites first, in watchlist order, then recents, then the rest', () => {
        const out = orderPool(pool, ['binance:CCC', 'binance:AAA'], ['nasdaq:DDD', 'binance:AAA']);
        expect(tickers(out)).toEqual(['CCC', 'AAA', 'DDD', 'BBB']);
    });

    it('matches the listing prefix before the provider id', () => {
        expect(tickers(orderPool(pool, ['NASDAQ:DDD'], []))).toEqual(['DDD', 'AAA', 'BBB', 'CCC']);
        expect(tickers(orderPool(pool, ['capital:DDD'], []))).toEqual(['AAA', 'BBB', 'CCC', 'DDD']);
    });

    it('ignores a market the pool does not have', () => {
        expect(tickers(orderPool(pool, ['binance:ZZZ'], []))).toEqual(tickers(pool));
    });

    it('marks the two groups without touching the input', () => {
        const out = orderPool(pool, ['binance:AAA'], ['binance:BBB']);
        expect(out[0]?.description).toMatch(/^★/);
        expect(out[1]?.description).toMatch(/^↺/);
        expect(out[2]?.description).toBeUndefined();
        expect(pool[0]?.description).toBeUndefined();
    });

    it('keeps an existing description after the mark', () => {
        const out = orderPool([d('AAA', 'binance', { description: 'Alpha' })], ['binance:AAA'], []);
        expect(out[0]?.description).toBe('★ Alpha');
    });
});
