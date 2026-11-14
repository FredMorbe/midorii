import { describe, expect, it, vi } from 'vitest';
import { AlertHistoryStore } from '../app/renderer/alerts/AlertHistoryStore';
import { ago, HISTORY_LIMIT, newEntry, sanitizeHistory, withEntry } from '../app/renderer/alerts/alertHistoryModel';

const entry = (at: number, body = 'b') => newEntry('price', 'binance:BTCUSDT', 'Price alert', body, at);

function fakeStorage(initial?: string) {
    const data = new Map<string, string>();
    if (initial !== undefined) data.set('midorii-alert-history', initial);
    return {
        data,
        getItem: (k: string) => data.get(k) ?? null,
        setItem: (k: string, v: string) => void data.set(k, v),
    };
}

describe('withEntry', () => {
    it('puts the newest first without changing the list it was given', () => {
        const old = [entry(1)];
        const next = withEntry(old, entry(2));
        expect(next.map((e) => e.at)).toEqual([2, 1]);
        expect(old).toHaveLength(1);
    });
    it('keeps only the newest HISTORY_LIMIT entries', () => {
        let list = [] as ReturnType<typeof withEntry>;
        for (let i = 0; i < HISTORY_LIMIT + 5; i++) list = withEntry(list, entry(i));
        expect(list).toHaveLength(HISTORY_LIMIT);
        expect(list[0]!.at).toBe(HISTORY_LIMIT + 4);
        expect(list[list.length - 1]!.at).toBe(5);
    });
});

describe('sanitizeHistory', () => {
    it('drops malformed and duplicate entries and sorts newest first', () => {
        const a = entry(10);
        const b = entry(20);
        const out = sanitizeHistory([a, b, a, { id: 'x' }, null, 'str', { ...b, id: 'y', kind: 'nope' }, { ...b, id: 'z', at: Number.NaN }]);
        expect(out.map((e) => e.id)).toEqual([b.id, a.id]);
    });
    it('answers an empty list for anything that is not a list', () => {
        expect(sanitizeHistory(null)).toEqual([]);
        expect(sanitizeHistory({})).toEqual([]);
    });
    it('reads a missing symbol as empty', () => {
        const { symbol: _symbol, ...rest } = entry(5);
        expect(sanitizeHistory([rest])[0]!.symbol).toBe('');
    });
});

describe('ago', () => {
    const now = Date.UTC(2026, 10, 14, 12, 0, 0);
    it('speaks in the shortest honest unit', () => {
        expect(ago(now, now - 20_000)).toBe('just now');
        expect(ago(now, now - 5 * 60_000)).toBe('5 min ago');
        expect(ago(now, now - 3 * 3_600_000)).toBe('3 h ago');
        expect(ago(now, now - 2 * 86_400_000)).toBe('2 d ago');
    });
    it('falls back to the date after a week, and never goes negative', () => {
        expect(ago(now, now - 10 * 86_400_000)).toBe('2026-11-04');
        expect(ago(now, now + 60_000)).toBe('just now');
    });
});

describe('AlertHistoryStore', () => {
    it('remembers entries across instances', () => {
        const storage = fakeStorage();
        const first = new AlertHistoryStore(storage);
        first.add(entry(1, 'one'));
        first.add(entry(2, 'two'));
        const second = new AlertHistoryStore(storage);
        expect(second.list().map((e) => e.body)).toEqual(['two', 'one']);
    });
    it('tells listeners about adds and clears, and a clear of nothing is silent', () => {
        const store = new AlertHistoryStore(fakeStorage());
        const seen = vi.fn();
        store.onChange(seen);
        store.clear();
        expect(seen).not.toHaveBeenCalled();
        store.add(entry(1));
        store.clear();
        expect(seen).toHaveBeenCalledTimes(2);
        expect(store.list()).toEqual([]);
    });
    it('reads damaged storage as empty and says so', () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        expect(new AlertHistoryStore(fakeStorage('{not json')).list()).toEqual([]);
        expect(error).toHaveBeenCalled();
        error.mockRestore();
    });
    it('keeps the entry for this session when a write fails, and reports it', () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const store = new AlertHistoryStore({ getItem: () => null, setItem: () => { throw new Error('full'); } });
        store.add(entry(1, 'kept'));
        expect(store.list().map((e) => e.body)).toEqual(['kept']);
        expect(error).toHaveBeenCalled();
        error.mockRestore();
    });
});
