import { describe, it, expect } from 'vitest';
import {
    activeList, addSection, addSymbol, changeOf, createList, decimalsOf, deleteList, emptyState, hasSymbol,
    moveItem, normalizeState, removeItem, renameList, selectList,
} from '../app/renderer/watchlist/watchlistModel';

const rows = (s: ReturnType<typeof emptyState>): string[] => (
    activeList(s).items.map((i) => (i.kind === 'symbol' ? i.symbol : `# ${i.title}`))
);

describe('watchlist model', () => {
    it('starts with one empty list that is active', () => {
        const s = emptyState();
        expect(s.lists).toHaveLength(1);
        expect(s.activeId).toBe(s.lists[0]!.id);
        expect(rows(s)).toEqual([]);
    });

    it('adds a market once per list', () => {
        let s = emptyState();
        const id = s.activeId;
        s = addSymbol(s, id, ' binance:BTCUSDT ');
        s = addSymbol(s, id, 'binance:BTCUSDT');
        s = addSymbol(s, id, 'binance:ETHUSDT');
        expect(rows(s)).toEqual(['binance:BTCUSDT', 'binance:ETHUSDT']);
        expect(hasSymbol(s, id, 'binance:BTCUSDT')).toBe(true);
        expect(hasSymbol(s, id, 'binance:SOLUSDT')).toBe(false);
    });

    it('refuses an empty symbol and an unknown list', () => {
        const s = emptyState();
        expect(() => addSymbol(s, s.activeId, '  ')).toThrow(/empty/);
        expect(() => addSymbol(s, 'nope', 'binance:BTCUSDT')).toThrow(/unknown list/);
    });

    it('keeps sections and symbols in one order and moves rows', () => {
        let s = emptyState();
        const id = s.activeId;
        s = addSymbol(s, id, 'a:A');
        s = addSection(s, id, 'Crypto');
        s = addSymbol(s, id, 'b:B');
        expect(rows(s)).toEqual(['a:A', '# Crypto', 'b:B']);
        s = moveItem(s, id, 2, 0);
        expect(rows(s)).toEqual(['b:B', 'a:A', '# Crypto']);
        // Out of range or a no-op leaves the order alone.
        expect(rows(moveItem(s, id, 0, 9))).toEqual(rows(s));
        expect(rows(moveItem(s, id, 1, 1))).toEqual(rows(s));
        s = removeItem(s, id, 0);
        expect(rows(s)).toEqual(['a:A', '# Crypto']);
    });

    it('creates, renames, selects and deletes lists, never the last one', () => {
        let s = emptyState();
        const first = s.activeId;
        s = createList(s, 'Futures');
        expect(s.lists).toHaveLength(2);
        expect(activeList(s).name).toBe('Futures');
        s = renameList(s, s.activeId, '  Index futures  ');
        expect(activeList(s).name).toBe('Index futures');
        s = renameList(s, s.activeId, '   '); // a blank name keeps the old one
        expect(activeList(s).name).toBe('Index futures');
        s = selectList(s, first);
        expect(s.activeId).toBe(first);
        s = deleteList(s, first); // deleting the active list moves the selection
        expect(s.lists).toHaveLength(1);
        expect(s.activeId).toBe(s.lists[0]!.id);
        expect(() => deleteList(s, s.activeId)).toThrow(/last list/);
    });

    it('normalizes whatever was stored', () => {
        expect(normalizeState(null).lists).toHaveLength(1);
        expect(normalizeState('garbage').lists).toHaveLength(1);
        const s = normalizeState({
            activeId: 'missing',
            lists: [
                { id: 'a', name: 'One', items: [
                    { kind: 'symbol', symbol: 'x:X' }, { kind: 'symbol', symbol: 'x:X' },
                    { kind: 'symbol', symbol: '' }, { kind: 'weird' }, null, { kind: 'section', title: 'S' },
                ] },
                { id: 'a', name: 'Duplicate id', items: [] },
                { id: 'b', name: 42, items: 'nope' },
            ],
        });
        expect(s.lists.map((l) => l.id)).toEqual(['a', 'b']);
        expect(s.activeId).toBe('a');
        expect(rows({ ...s, activeId: 'a' })).toEqual(['x:X', '# S']);
        expect(s.lists[1]!.name).toBe('Watchlist');
        expect(s.lists[1]!.items).toEqual([]);
    });

    it('states a change only when both sides are known', () => {
        expect(changeOf(110, 100)).toBeCloseTo(0.1);
        expect(changeOf(90, 100)).toBeCloseTo(-0.1);
        expect(changeOf(null, 100)).toBeNull();
        expect(changeOf(100, null)).toBeNull();
        expect(changeOf(100, 0)).toBeNull();
    });
});

describe('decimalsOf', () => {
    it('counts the decimals a price is written with', () => {
        expect(decimalsOf(1964.35)).toBe(2);
        expect(decimalsOf(1964)).toBe(0);
        expect(decimalsOf(0.06473)).toBe(5);
    });
    it('clears floating-point dust and caps at eight decimals', () => {
        expect(decimalsOf(0.1 + 0.2)).toBe(1);
        expect(decimalsOf(1.123456789123)).toBe(8);
        expect(decimalsOf(Number.NaN)).toBe(0);
    });
});
