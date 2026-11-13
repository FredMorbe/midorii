import { describe, expect, it } from 'vitest';
import type { WorkspaceState } from '../src/workspace';
import { LayoutStore } from '../app/renderer/layouts/layoutStore';

const doc: WorkspaceState = { version: 1, layout: '1', charts: [{ id: 'c1', symbol: 'binance:BTCUSDT', timeframe: '1h' }] };
const memory = (initial?: string): { storage: Pick<Storage, 'getItem' | 'setItem'>; data: Map<string, string> } => {
    const data = new Map<string, string>();
    if (initial) data.set('midorii-layouts', initial);
    return { data, storage: { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); } } };
};
let n = 0;
const make = (m = memory()): LayoutStore => new LayoutStore(m.storage, () => `id${++n}`, () => 10);

describe('LayoutStore', () => {
    it('saves, persists and reloads a layout', () => {
        const m = memory();
        const store = make(m);
        const { saved, replaced } = store.save('Majors', doc);
        expect(replaced).toBe(false);
        expect(make(m).layouts.map((l) => l.name)).toEqual(['Majors']);
        expect(make(m).find(saved.id)?.state.charts[0]?.symbol).toBe('binance:BTCUSDT');
    });

    it('removes a layout and tells its listeners', () => {
        const store = make();
        const { saved } = store.save('A', doc);
        let calls = 0;
        store.onChange(() => { calls++; });
        store.remove(saved.id);
        expect(store.layouts).toHaveLength(0);
        expect(calls).toBe(1);
    });

    it('answers a damaged stored value with an empty list', () => {
        const errors: unknown[] = [];
        const original = console.error;
        console.error = (...a: unknown[]) => { errors.push(a); };
        try {
            expect(make(memory('{not json')).layouts).toEqual([]);
        } finally {
            console.error = original;
        }
        expect(errors).toHaveLength(1);
    });

    it('throws on a failed write and keeps the list as it was', () => {
        const store = new LayoutStore({ getItem: () => null, setItem: () => { throw new Error('quota'); } }, () => 'x', () => 1);
        expect(() => store.save('A', doc)).toThrow('quota');
        expect(store.layouts).toHaveLength(0);
    });
});
