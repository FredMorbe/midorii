// The assets a bot may be pointed at. A bot needs a live feed, so only providers that stream
// and can list their markets are offered; each asset carries the provider it came from, which
// is what makes the picked value read `capital:BTCUSD` and not a bare ticker that could mean
// another venue; and a provider that cannot be read is reported instead of vanishing from the
// list. See app/renderer/bot/assetPool.ts.
import { describe, it, expect } from 'vitest';
import { loadAssetPool } from '../app/renderer/bot/assetPool';
import type { DataProvider, SymbolDescriptor } from '../src/plugin';

/** A provider that streams and lists `symbols`. Pieces can be taken away per test. */
function provider(symbols: SymbolDescriptor[] | Error, over: Partial<DataProvider> = {}): () => DataProvider {
    return () => ({
        getBars: () => Promise.resolve([]),
        subscribe: () => () => undefined,
        listSymbols: () => (symbols instanceof Error ? Promise.reject(symbols) : Promise.resolve(symbols)),
        ...over,
    });
}

const BTC: SymbolDescriptor = { ticker: 'BTCUSD', description: 'Bitcoin / US Dollar', type: 'crypto' };
const ETH: SymbolDescriptor = { ticker: 'ETHUSDT', description: 'Ethereum / TetherUS', type: 'crypto' };

describe('the assets a bot can trade', () => {
    it('offers only providers that both stream and list their markets', async () => {
        const pool = await loadAssetPool({
            capital: provider([BTC]),
            // The local archive can be backtested, never traded: it has no live feed.
            local: provider([ETH], { subscribe: undefined }),
            // A feed with nothing to browse cannot be picked from.
            unlisted: provider([ETH], { listSymbols: undefined }),
        });

        expect(pool.providers.map((p) => p.name)).toEqual(['capital']);
        expect(pool.symbols.map((s) => s.ticker)).toEqual(['BTCUSD']);
    });

    it('stamps every asset with the provider it came from', async () => {
        const pool = await loadAssetPool({ capital: provider([BTC]), binance: provider([ETH]) });

        expect(pool.symbols).toEqual([
            { ...BTC, provider: 'capital' },
            { ...ETH, provider: 'binance' },
        ]);
    });

    it('names a provider by the key it is registered under, not by what it calls itself', async () => {
        const pool = await loadAssetPool({
            capital: provider([BTC], {
                info: () => ({ name: 'something-else', displayName: 'Capital.com', capabilities: { enumerate: true, stream: true, symbolInfo: true } }),
            }),
        });

        expect(pool.providers).toHaveLength(1);
        expect(pool.providers[0]).toMatchObject({ name: 'capital', displayName: 'Capital.com' });
    });

    it('reports a provider that fails and still offers the others', async () => {
        const pool = await loadAssetPool({
            capital: provider(new Error('Capital.com is not connected')),
            binance: provider([ETH]),
        });

        expect(pool.symbols.map((s) => s.ticker)).toEqual(['ETHUSDT']);
        expect(pool.failures).toEqual([{ provider: 'capital', message: 'Capital.com is not connected' }]);
    });

    it('keeps other brokers available when one throws before returning a list', async () => {
        const pool = await loadAssetPool({
            capital: provider([BTC], { listSymbols: () => { throw new Error('Capital.com is not connected'); } }),
            binance: provider([ETH]),
        });

        expect(pool.symbols.map((s) => s.ticker)).toEqual(['ETHUSDT']);
        expect(pool.failures).toEqual([{ provider: 'capital', message: 'Capital.com is not connected' }]);
    });

    it('keeps other brokers available when one cannot be initialized', async () => {
        const pool = await loadAssetPool({
            projectx: () => { throw new Error('ProjectX is not connected'); },
            binance: provider([ETH]),
        });

        expect(pool.symbols.map((s) => s.ticker)).toEqual(['ETHUSDT']);
        expect(pool.failures).toEqual([{ provider: 'projectx', message: 'ProjectX is not connected' }]);
    });

    it('reports a provider that answered with nothing rather than leaving it out silently', async () => {
        const pool = await loadAssetPool({ capital: provider([]), binance: provider([ETH]) });

        expect(pool.providers.map((p) => p.name)).toEqual(['binance']);
        expect(pool.failures).toHaveLength(1);
        expect(pool.failures[0]).toMatchObject({ provider: 'capital' });
        expect(pool.failures[0]!.message).toMatch(/no assets/i);
    });

    it('is empty and says nothing when there is nobody to ask', async () => {
        const pool = await loadAssetPool({});

        expect(pool).toEqual({ symbols: [], providers: [], failures: [] });
    });
});
