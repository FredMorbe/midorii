// The ONE chart document the app's three charts wear (app/renderer/shell/sharedChartDoc.ts):
// what travels between them (the look, the drawings, a person's indicators) and what must
// not (each mode's market, and the app's own controller-driven indicators). DOM-free — the
// workspaces are stand-ins; the live plumbing is exercised in the app itself.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { decodeState, encodeState, type WorkspaceState } from '../src/workspace';
import type { VelaWorkspace } from '../src/workspace';

const CHART = { symbol: 'binance:BTCUSDT', timeframe: '60' };
const BOT = { symbol: 'binance:ETHUSDT', timeframe: '5' };

/** A document as a workspace would hand it to its storage adapter. */
function doc(cell: Partial<WorkspaceState['charts'][number]>): WorkspaceState {
    return { version: 1, layout: '1', charts: [{ id: 'c1', ...cell }] };
}

/** A stand-in workspace: what the pusher reads off a chart, and what it applies to one. */
function fakeWorkspace(market: { symbol: string; timeframe: string }, natives: string[] = []) {
    const applied: WorkspaceState[] = [];
    const ws = {
        chart: { market, presentNativeIndicators: () => natives },
        applyState: (state: unknown) => applied.push(state as WorkspaceState),
    } as unknown as VelaWorkspace;
    return { ws, applied };
}

function memoryStorage(): Storage {
    const map = new Map<string, string>();
    return {
        getItem: (k: string) => map.get(k) ?? null,
        setItem: (k: string, v: string) => void map.set(k, String(v)),
        removeItem: (k: string) => void map.delete(k),
        clear: () => map.clear(),
        key: () => null,
        length: 0,
    } as unknown as Storage;
}

/** A fresh module (its members list and convergence guard are module state) over a fresh store. */
async function load() {
    vi.resetModules();
    Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true, writable: true });
    return import('../app/renderer/shell/sharedChartDoc');
}

beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true, writable: true });
});

describe('the shared chart document', () => {
    it('dresses a chart built later in the look a chart edited earlier was left in', async () => {
        const { shareChartDoc } = await load();
        const chart = shareChartDoc('chart', CHART);
        chart.storage.set('chart', encodeState(doc({ ...CHART, rendererConfig: { layout: { background: '#101314' } } })));

        const bot = shareChartDoc('bot', BOT);
        const booted = decodeState((bot.storage.get('bot') as string) ?? '');
        expect(booted!.charts[0]!.rendererConfig).toEqual({ layout: { background: '#101314' } });
    });

    it('leaves each mode on its own market', async () => {
        const { shareChartDoc } = await load();
        const chart = shareChartDoc('chart', CHART);
        chart.storage.set('chart', encodeState(doc({ symbol: 'binance:SOLUSDT', timeframe: '240' })));

        // A mode that has never been opened boots on its own seed, not on the Chart tab's market.
        const bot = shareChartDoc('bot', BOT);
        const booted = decodeState((bot.storage.get('bot') as string) ?? '');
        expect(booted!.charts[0]!.symbol).toBe(BOT.symbol);
        expect(booted!.charts[0]!.timeframe).toBe(BOT.timeframe);

        // …and the Chart tab comes back on the one it was left on.
        expect(decodeState((chart.storage.get('chart') as string) ?? '')!.charts[0]!.symbol).toBe('binance:SOLUSDT');
    });

    it('pushes an edit onto the charts that are already open, market and app indicators intact', async () => {
        const { shareChartDoc } = await load();
        const chart = shareChartDoc('chart', CHART);
        const bot = shareChartDoc('bot', BOT);
        const open = fakeWorkspace(BOT, ['trade-position']);
        bot.attach(open.ws);

        chart.storage.set('chart', encodeState(doc({
            ...CHART,
            rendererConfig: { grid: { vert: false } },
            indicators: { manifest: ['EMA 20'], natives: ['volume', { type: 'price-alerts', visible: false }] },
        })));

        expect(open.applied).toHaveLength(1);
        const cell = open.applied[0]!.charts[0]!;
        expect(cell.rendererConfig).toEqual({ grid: { vert: false } });
        expect(cell.symbol).toBe(BOT.symbol); // its own market, not the origin's
        expect(cell.timeframe).toBe(BOT.timeframe);
        expect(cell.indicators!.manifest).toEqual(['EMA 20']);
        // The origin's alert indicator stayed behind; the bot's position lines survived the
        // converging ledger, which would otherwise take off anything the document omits.
        expect(cell.indicators!.natives).toEqual(['volume', 'trade-position']);
    });

    it('does not echo a pushed document back at the charts it came from', async () => {
        const { shareChartDoc } = await load();
        const chart = shareChartDoc('chart', CHART);
        const bot = shareChartDoc('bot', BOT);
        const origin = fakeWorkspace(CHART);
        const open = fakeWorkspace(BOT);
        chart.attach(origin.ws);
        bot.attach(open.ws);

        const edited = doc({ ...CHART, rendererConfig: { grid: { vert: false } } });
        chart.storage.set('chart', encodeState(edited));
        expect(open.applied).toHaveLength(1);

        // The push makes the receiver's workspace persist in turn — the same document, so
        // nothing more may move. Without the guard the two would push at each other forever.
        bot.storage.set('bot', encodeState(open.applied[0]!));
        expect(origin.applied).toHaveLength(0);
        expect(open.applied).toHaveLength(1);
    });

    it('does not send a following chart’s own correction back out', async () => {
        const { shareChartDoc } = await load();
        const chart = shareChartDoc('chart', CHART);
        const bot = shareChartDoc('bot', BOT);
        const origin = fakeWorkspace(CHART);
        const open = fakeWorkspace(BOT);
        chart.attach(origin.ws);
        bot.attach(open.ws);

        chart.storage.set('chart', encodeState(doc({ ...CHART, rendererConfig: { grid: { vert: false } } })));

        /* A chart is entitled to answer with something slightly different — a renderer that
         * fills its config in, a market still switching. That answer is the follower's, not
         * an edit, and sending it back would have the two correcting each other for good. */
        bot.storage.set('bot', encodeState(doc({ ...BOT, rendererConfig: { grid: { vert: false, horz: true } } })));
        expect(origin.applied).toHaveLength(0);

        // The NEXT write from that chart is a real edit again, and travels.
        bot.storage.set('bot', encodeState(doc({ ...BOT, rendererConfig: { grid: { vert: true } } })));
        expect(origin.applied).toHaveLength(1);
        expect(origin.applied[0]!.charts[0]!.rendererConfig).toEqual({ grid: { vert: true } });
    });

    it('keeps a replay on the market it was set up on, however it was left', async () => {
        const { shareChartDoc } = await load();
        const setup = { symbol: 'replay_x:BTCUSDT', timeframe: '15' };
        const first = shareChartDoc('replay', setup, { remembers: false });
        first.storage.set('replay', encodeState(doc({ symbol: 'replay_x:BTCUSDT', timeframe: '240' })));

        const next = shareChartDoc('replay', { symbol: 'replay_y:ETHUSDT', timeframe: '5' }, { remembers: false });
        const booted = decodeState((next.storage.get('replay') as string) ?? '');
        expect(booted!.charts[0]!.symbol).toBe('replay_y:ETHUSDT');
        expect(booted!.charts[0]!.timeframe).toBe('5');
    });

    it('boots on the workspace options while nothing has been shared yet', async () => {
        const { shareChartDoc } = await load();
        expect(shareChartDoc('chart', CHART).storage.get('chart')).toBeNull();
    });

    it('carries the documents written before the charts shared one', async () => {
        const { shareChartDoc } = await load();
        localStorage.setItem('midorii-workspace', encodeState(doc({
            symbol: 'binance:SOLUSDT',
            timeframe: '240',
            rendererConfig: { layout: { background: '#0b0d0e' } },
        })));
        localStorage.setItem('midorii-bot-workspace', encodeState(doc({ symbol: 'bybit:XRPUSDT', timeframe: '15' })));

        const chart = shareChartDoc('chart', CHART);
        const booted = decodeState((chart.storage.get('chart') as string) ?? '');
        // The look the Chart tab was dressed in, and the market it was left on.
        expect(booted!.charts[0]!.rendererConfig).toEqual({ layout: { background: '#0b0d0e' } });
        expect(booted!.charts[0]!.symbol).toBe('binance:SOLUSDT');
        expect(booted!.charts[0]!.timeframe).toBe('240');

        // The bot's own market came over too, though its look is now the shared one.
        const bot = decodeState((shareChartDoc('bot', BOT).storage.get('bot') as string) ?? '');
        expect(bot!.charts[0]!.symbol).toBe('bybit:XRPUSDT');
        expect(bot!.charts[0]!.rendererConfig).toEqual({ layout: { background: '#0b0d0e' } });
    });
});

describe('the Chart tab’s grid', () => {
    const GRID: WorkspaceState = {
        version: 1,
        layout: '2h',
        activeCellId: 'eth',
        sync: { viewport: true },
        trackSizes: { '2h': { cols: [1, 2] } },
        charts: [
            { id: 'btc', symbol: 'binance:BTCUSDT', timeframe: '60', rendererConfig: { grid: { vert: true } }, indicators: { manifest: ['EMA 20'], natives: ['volume', 'price-alerts'] } },
            { id: 'eth', symbol: 'binance:ETHUSDT', timeframe: '15', rendererConfig: { grid: { vert: false } }, indicators: { manifest: ['RSI'], natives: ['volume', 'market-quote'] } },
        ],
    };

    /** A stand-in grid workspace: the document it would write now, and what it was told to apply. */
    function fakeGrid(state: WorkspaceState) {
        const applied: WorkspaceState[] = [];
        const ws = {
            getState: () => state,
            applyState: (next: unknown) => applied.push(next as WorkspaceState),
        } as unknown as VelaWorkspace;
        return { ws, applied };
    }

    it('keeps the whole grid for the Chart tab and shares only the first slot, as one chart', async () => {
        const { shareChartDoc } = await load();
        const chart = shareChartDoc('chart', CHART, { grid: true });
        chart.storage.set('chart', encodeState(GRID));

        const grid = decodeState(localStorage.getItem('midorii-chart-grid') ?? '')!;
        expect(grid.layout).toBe('2h');
        expect(grid.charts.map((c) => c.id)).toEqual(['btc', 'eth']);
        // The app's own indicators are the controllers' to add, on every slot.
        expect(grid.charts[0]!.indicators!.natives).toEqual(['volume']);
        expect(grid.charts[1]!.indicators!.natives).toEqual(['volume']);

        const shared = decodeState(localStorage.getItem('midorii-chart-doc') ?? '')!;
        expect(shared.layout).toBe('1');
        expect(shared.sync).toBeUndefined();
        expect(shared.trackSizes).toBeUndefined();
        expect(shared.activeCellId).toBeUndefined();
        expect(shared.charts).toHaveLength(1);
        expect(shared.charts[0]!.id).toBe('c1');
        expect(shared.charts[0]!.rendererConfig).toEqual({ grid: { vert: true } });
        expect(shared.charts[0]!.symbol).toBeUndefined();
    });

    it('does not tell the other modes about an edit to a later slot', async () => {
        const { shareChartDoc } = await load();
        const chart = shareChartDoc('chart', CHART, { grid: true });
        const bot = shareChartDoc('bot', BOT);
        const open = fakeWorkspace(BOT);
        bot.attach(open.ws);
        chart.storage.set('chart', encodeState(GRID));
        expect(open.applied).toHaveLength(1);

        const second = { ...GRID, charts: [GRID.charts[0]!, { ...GRID.charts[1]!, rendererConfig: { grid: { vert: true } } }] };
        chart.storage.set('chart', encodeState(second));
        expect(open.applied).toHaveLength(1);
    });

    it('lays an edit from another mode onto the first slot only, leaving the grid as it is', async () => {
        const { shareChartDoc } = await load();
        const chart = shareChartDoc('chart', CHART, { grid: true });
        const bot = shareChartDoc('bot', BOT);
        const open = fakeGrid(GRID);
        chart.attach(open.ws);

        bot.storage.set('bot', encodeState(doc({ ...BOT, rendererConfig: { grid: { vert: 'bot' } } })));

        expect(open.applied).toHaveLength(1);
        const next = open.applied[0]!;
        expect(next.layout).toBe('2h');
        expect(next.activeCellId).toBe('eth');
        expect(next.sync).toEqual({ viewport: true });
        expect(next.trackSizes).toEqual(GRID.trackSizes);
        expect(next.charts.map((c) => c.id)).toEqual(['btc', 'eth']);
        // Slot one: the shared look, under its own identity and market, app indicators intact.
        expect(next.charts[0]!.rendererConfig).toEqual({ grid: { vert: 'bot' } });
        expect(next.charts[0]!.symbol).toBe('binance:BTCUSDT');
        expect(next.charts[0]!.timeframe).toBe('60');
        expect(next.charts[0]!.indicators!.natives).toContain('price-alerts');
        // Slot two is untouched.
        expect(next.charts[1]).toEqual(GRID.charts[1]);
    });

    it('boots on its own grid, wearing whatever look the other modes left on the shared document', async () => {
        const { shareChartDoc } = await load();
        const first = shareChartDoc('chart', CHART, { grid: true });
        first.storage.set('chart', encodeState(GRID));
        const bot = shareChartDoc('bot', BOT);
        bot.storage.set('bot', encodeState(doc({ ...BOT, rendererConfig: { layout: { background: '#202428' } } })));

        const booted = decodeState((shareChartDoc('chart', CHART, { grid: true }).storage.get('chart') as string) ?? '')!;
        expect(booted.layout).toBe('2h');
        expect(booted.charts.map((c) => c.id)).toEqual(['btc', 'eth']);
        expect(booted.charts[0]!.rendererConfig).toEqual({ layout: { background: '#202428' } });
        expect(booted.charts[0]!.symbol).toBe('binance:BTCUSDT');
        expect(booted.charts[1]!.symbol).toBe('binance:ETHUSDT');
        expect(booted.charts[1]!.rendererConfig).toEqual({ grid: { vert: false } });
    });

    it('still boots a single chart from the shared document when no grid was ever saved', async () => {
        const { shareChartDoc } = await load();
        localStorage.setItem('midorii-chart-doc', encodeState(doc({ rendererConfig: { grid: { vert: false } } })));
        const booted = decodeState((shareChartDoc('chart', CHART, { grid: true }).storage.get('chart') as string) ?? '')!;
        expect(booted.layout).toBe('1');
        expect(booted.charts[0]!.symbol).toBe(CHART.symbol);
        expect(booted.charts[0]!.rendererConfig).toEqual({ grid: { vert: false } });
    });
});
