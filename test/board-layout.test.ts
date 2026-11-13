import { describe, expect, it, vi } from 'vitest';
import {
    MAX_COLUMNS,
    flexOf,
    isDefaultLayout,
    movePanel,
    parseLayout,
    splitPair,
    type BoardLayout,
} from '../app/renderer/shell/boardLayout';
import { BOT_BOARD, PANEL_IDS, type PanelId } from '../app/renderer/bot/botBoard';
import { ANALYSIS_BOARD } from '../app/renderer/analysis/analysisBoard';

// The store lives next to the DOM code; it is pure enough to test here, but importing it pulls
// in the UI kit, which this file does not need to load for the model's own tests.
vi.mock('../src/ui', () => ({ injectStyles: () => {} }));
import { createLayoutStore } from '../app/renderer/shell/panelBoard';

const defaultLayout = (): BoardLayout<PanelId> => BOT_BOARD.initial();
const LAYOUT_STORAGE_KEY = BOT_BOARD.storageKey;
const move = (layout: BoardLayout<PanelId>, id: PanelId, drop: Parameters<typeof movePanel>[3]) => movePanel(BOT_BOARD, layout, id, drop);

const idsOf = (layout: BoardLayout): string[][] => layout.columns.map((c) => c.panels.map((p) => p.id));

describe('board layout model', () => {
    it('starts with every panel exactly once', () => {
        const ids = defaultLayout().columns.flatMap((c) => c.panels.map((p) => p.id)).sort();
        expect(ids).toEqual([...PANEL_IDS].sort());
    });

    it('moves a panel into another column at the dropped position', () => {
        const next = move(defaultLayout(), 'activity', { kind: 'panel', column: 1, index: 1 });
        expect(idsOf(next)).toEqual([['status', 'chart', 'position'], ['account', 'activity', 'rules']]);
    });

    it('treats an index in the panel’s own column as the layout before the move', () => {
        // Dropping the chart below the activity panel: index 4 is "after the last panel".
        const next = move(defaultLayout(), 'chart', { kind: 'panel', column: 0, index: 4 });
        expect(idsOf(next)[0]).toEqual(['status', 'position', 'activity', 'chart']);
    });

    it('makes a column of its own at a column edge and removes a column a move empties', () => {
        const next = move(defaultLayout(), 'rules', { kind: 'column', index: 0 });
        expect(idsOf(next)).toEqual([['rules'], ['status', 'chart', 'position', 'activity'], ['account']]);

        let layout = defaultLayout();
        layout = move(layout, 'account', { kind: 'panel', column: 0, index: 0 });
        layout = move(layout, 'rules', { kind: 'panel', column: 0, index: 0 });
        expect(layout.columns).toHaveLength(1);
    });

    it('refuses a column beyond the limit and leaves the layout as it was', () => {
        let layout = defaultLayout();
        layout = move(layout, 'status', { kind: 'column', index: 0 });
        layout = move(layout, 'rules', { kind: 'column', index: 0 });
        expect(layout.columns).toHaveLength(MAX_COLUMNS);
        expect(move(layout, 'chart', { kind: 'column', index: 0 })).toBe(layout);
    });

    it('does not mutate the layout it was given', () => {
        const before = defaultLayout();
        move(before, 'activity', { kind: 'panel', column: 1, index: 0 });
        expect(isDefaultLayout(BOT_BOARD, before)).toBe(true);
    });

    it('gives a moved panel the average of its new neighbours’ weights, not its absolute default', () => {
        const layout = defaultLayout();
        layout.columns[0]!.panels = [{ id: 'status' }, { id: 'chart', weight: 600 }, { id: 'activity', weight: 200 }];
        layout.columns[1]!.panels = [{ id: 'account' }, { id: 'position' }, { id: 'rules', weight: 400 }];
        const next = move(layout, 'activity', { kind: 'panel', column: 1, index: 3 });
        expect(next.columns[1]!.panels.find((p) => p.id === 'activity')!.weight).toBe(400);
    });

    it('splits a pair around the moved line and never below the minimum', () => {
        expect(splitPair(300, 300, 40, 100)).toEqual([340, 260]);
        expect(splitPair(300, 300, 500, 100)).toEqual([500, 100]);
        expect(splitPair(300, 300, -500, 100)).toEqual([100, 500]);
        // A neighbour that already is below the minimum is not made smaller.
        expect(splitPair(60, 300, -20, 100)).toEqual([60, 300]);
    });

    it('turns a slot into the flex value that sizes it', () => {
        expect(flexOf({ id: 'chart', weight: 3 })).toBe('3 1 0');
        expect(flexOf({ id: 'status', px: 90 })).toBe('0 0 90px');
        expect(flexOf({ id: 'status' })).toBe('0 0 auto');
    });
});

describe('stored board layout', () => {
    it('accepts what it wrote and rejects anything that does not describe every panel', () => {
        const layout = defaultLayout();
        expect(parseLayout(BOT_BOARD, JSON.parse(JSON.stringify(layout)))).toEqual(layout);

        const missing = defaultLayout();
        missing.columns[1]!.panels.pop();
        expect(parseLayout(BOT_BOARD, missing)).toBeNull();

        const twice = defaultLayout();
        twice.columns[1]!.panels.push({ id: 'chart' });
        expect(parseLayout(BOT_BOARD, twice)).toBeNull();

        expect(parseLayout(BOT_BOARD, { fleet: 272, columns: [] })).toBeNull();
        expect(parseLayout(BOT_BOARD, { fleet: -1, columns: defaultLayout().columns })).toBeNull();
        expect(parseLayout(BOT_BOARD, 'nonsense')).toBeNull();
    });

    it('falls back to the default for unreadable storage and forgets a default layout', () => {
        const data = new Map<string, string>([[LAYOUT_STORAGE_KEY, '{not json']]);
        const storage = {
            getItem: (k: string) => data.get(k) ?? null,
            setItem: (k: string, v: string) => { data.set(k, v); },
            removeItem: (k: string) => { data.delete(k); },
        };
        const store = createLayoutStore(BOT_BOARD, storage);
        expect(isDefaultLayout(BOT_BOARD, store.get())).toBe(true);

        store.set(move(store.get(), 'activity', { kind: 'panel', column: 1, index: 0 }), 'structure');
        expect(data.has(LAYOUT_STORAGE_KEY)).toBe(true);
        expect(idsOf(createLayoutStore(BOT_BOARD, storage).get())[1]).toContain('activity');

        store.reset();
        expect(data.has(LAYOUT_STORAGE_KEY)).toBe(false);
    });
});

describe('the analysis board', () => {
    it('starts with every panel exactly once and accepts what it wrote', () => {
        const layout = ANALYSIS_BOARD.initial();
        const ids = layout.columns.flatMap((c) => c.panels.map((p) => p.id)).sort();
        expect(ids).toEqual([...ANALYSIS_BOARD.ids].sort());
        expect(parseLayout(ANALYSIS_BOARD, JSON.parse(JSON.stringify(layout)))).toEqual(layout);
        // A layout saved by another screen names panels this one does not have.
        expect(parseLayout(ANALYSIS_BOARD, BOT_BOARD.initial())).toBeNull();
    });

    it('keeps its layout apart from the bot screen’s', () => {
        expect(ANALYSIS_BOARD.storageKey).not.toBe(BOT_BOARD.storageKey);
    });
});
