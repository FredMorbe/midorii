import { describe, expect, it } from 'vitest';
import type { ChartState, WorkspaceState } from '../src/workspace';
import { deleteLayout, findByName, forApplying, forSaving, normalizeLayouts, saveLayout } from '../app/renderer/layouts/layoutModel';

const chart = (id: string, symbol: string, natives: string[] = []): ChartState => ({
    id, symbol, timeframe: '1h', indicators: { manifest: [], natives },
});
const doc = (charts: ChartState[], extra: Partial<WorkspaceState> = {}): WorkspaceState => ({ version: 1, layout: '1', charts, ...extra });
let n = 0;
const newId = (): string => `id${++n}`;

describe('saveLayout', () => {
    it('adds a layout under a trimmed name', () => {
        const out = saveLayout([], '  Majors  ', doc([chart('c1', 'binance:BTCUSDT')]), 5, newId);
        expect(out.replaced).toBe(false);
        expect(out.layouts).toHaveLength(1);
        expect(out.saved.name).toBe('Majors');
        expect(out.saved.savedAt).toBe(5);
    });

    it('replaces a layout of the same name in place, keeping its id', () => {
        const first = saveLayout([], 'Majors', doc([chart('c1', 'binance:BTCUSDT')]), 1, newId);
        const other = saveLayout(first.layouts, 'Other', doc([chart('c1', 'binance:ETHUSDT')]), 2, newId);
        const again = saveLayout(other.layouts, 'majors', doc([chart('c1', 'binance:SOLUSDT')]), 3, newId);
        expect(again.replaced).toBe(true);
        expect(again.layouts.map((l) => l.name)).toEqual(['majors', 'Other']);
        expect(again.saved.id).toBe(first.saved.id);
        expect(again.saved.state.charts[0]?.symbol).toBe('binance:SOLUSDT');
    });

    it('refuses an empty name or a document without a chart', () => {
        expect(() => saveLayout([], '   ', doc([chart('c1', 'a:B')]), 0, newId)).toThrow(/name/);
        expect(() => saveLayout([], 'X', doc([]), 0, newId)).toThrow(/chart/);
    });

    it('caps the name length', () => {
        const out = saveLayout([], 'x'.repeat(100), doc([chart('c1', 'a:B')]), 0, newId);
        expect(out.saved.name).toHaveLength(40);
    });
});

describe('deleteLayout / findByName', () => {
    it('removes only the named id', () => {
        const a = saveLayout([], 'A', doc([chart('c1', 'a:B')]), 0, newId);
        const b = saveLayout(a.layouts, 'B', doc([chart('c1', 'a:B')]), 0, newId);
        expect(deleteLayout(b.layouts, a.saved.id).map((l) => l.name)).toEqual(['B']);
        expect(findByName(b.layouts, ' b ')?.name).toBe('B');
    });
});

describe('normalizeLayouts', () => {
    it('keeps valid entries and drops malformed or duplicate ones', () => {
        const good = { id: 'a', name: 'Good', savedAt: 1, state: doc([chart('c1', 'a:B')]) };
        const out = normalizeLayouts([good, { ...good }, { id: 'b', name: ' ', state: good.state }, { id: 'c', name: 'No state' }, 7, null]);
        expect(out.map((l) => l.id)).toEqual(['a']);
    });
    it('returns an empty list for anything but an array', () => {
        expect(normalizeLayouts({})).toEqual([]);
        expect(normalizeLayouts(undefined)).toEqual([]);
    });
});

describe('forSaving', () => {
    it('drops the preferences and the app indicators', () => {
        const live = doc([chart('c1', 'a:B', ['rsi', 'alerts'])], { favorites: ['trendline'], timezone: 'UTC', timeframeFavorites: ['1h'] });
        const stripApp = (s: WorkspaceState): WorkspaceState => ({
            ...s, charts: s.charts.map((c) => ({ ...c, indicators: { manifest: [], natives: (c.indicators?.natives ?? []).filter((x) => x !== 'alerts') } })),
        });
        const out = forSaving(live, stripApp);
        expect(out.favorites).toBeUndefined();
        expect(out.timezone).toBeUndefined();
        expect(out.timeframeFavorites).toBeUndefined();
        expect(out.charts[0]?.indicators?.natives).toEqual(['rsi']);
    });
});

describe('forApplying', () => {
    const appOf = (cell: ChartState | undefined): string[] => (cell?.indicators?.natives ?? []).filter((x) => x === 'alerts') as string[];

    it('keeps the app indicators each live slot carries and the live preferences', () => {
        const saved = doc([chart('c1', 'a:B', ['rsi']), chart('c2', 'a:C')], { layout: '2h' });
        const live = doc([chart('c1', 'a:X', ['alerts'])], { timezone: 'UTC', favorites: ['line'] });
        const out = forApplying(saved, live, appOf);
        expect(out.layout).toBe('2h');
        expect(out.charts[0]?.indicators?.natives).toEqual(['rsi', 'alerts']);
        expect(out.charts[1]?.indicators?.natives).toEqual([]);
        expect(out.timezone).toBe('UTC');
        expect(out.favorites).toEqual(['line']);
    });

    it('does not carry a preference the live state does not have', () => {
        const saved = doc([chart('c1', 'a:B')], { timezone: 'Berlin' });
        expect(forApplying(saved, doc([chart('c1', 'a:B')]), appOf).timezone).toBeUndefined();
    });

    it('does not change its inputs', () => {
        const saved = doc([chart('c1', 'a:B', ['rsi'])]);
        const live = doc([chart('c1', 'a:X', ['alerts'])]);
        forApplying(saved, live, appOf);
        expect(saved.charts[0]?.indicators?.natives).toEqual(['rsi']);
    });
});
