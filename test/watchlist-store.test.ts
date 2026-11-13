import { describe, it, expect, vi } from 'vitest';
import { WatchlistStore } from '../app/renderer/watchlist/watchlistStore';

function memory(initial?: string) {
    const data = new Map<string, string>();
    if (initial != null) data.set('midorii-watchlists', initial);
    return {
        data,
        getItem: (k: string) => data.get(k) ?? null,
        setItem: (k: string, v: string) => { data.set(k, v); },
    };
}

describe('WatchlistStore', () => {
    it('persists every change and restores it in a new store', () => {
        const storage = memory();
        const a = new WatchlistStore(storage);
        a.add('binance:BTCUSDT');
        a.addSection('Majors');
        a.create('Futures');
        a.add('projectx:NQ');

        const b = new WatchlistStore(storage);
        expect(b.state.lists.map((l) => l.name)).toEqual(['Watchlist', 'Futures']);
        expect(b.active.name).toBe('Futures');
        expect(b.active.items).toEqual([{ kind: 'symbol', symbol: 'projectx:NQ' }]);
    });

    it('tells listeners once per real change, and not for a duplicate add', () => {
        const store = new WatchlistStore(memory());
        const seen = vi.fn();
        store.onChange(seen);
        store.add('a:A');
        store.add('a:A');
        expect(seen).toHaveBeenCalledTimes(1);
    });

    it('answers unreadable storage with an empty list, loudly', () => {
        const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const store = new WatchlistStore(memory('{not json'));
        expect(store.state.lists).toHaveLength(1);
        expect(store.active.items).toEqual([]);
        expect(err).toHaveBeenCalled();
        err.mockRestore();
    });

    it('keeps the change for this session when a write fails', () => {
        const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const storage = { getItem: () => null, setItem: () => { throw new Error('quota'); } };
        const store = new WatchlistStore(storage);
        store.add('a:A');
        expect(store.active.items).toHaveLength(1);
        expect(err).toHaveBeenCalled();
        err.mockRestore();
    });

    it('moves and removes rows in the active list', () => {
        const store = new WatchlistStore(memory());
        store.add('a:A'); store.add('b:B'); store.add('c:C');
        store.move(2, 0);
        expect(store.active.items.map((i) => (i.kind === 'symbol' ? i.symbol : ''))).toEqual(['c:C', 'a:A', 'b:B']);
        store.remove(1);
        expect(store.active.items.map((i) => (i.kind === 'symbol' ? i.symbol : ''))).toEqual(['c:C', 'b:B']);
    });
});
