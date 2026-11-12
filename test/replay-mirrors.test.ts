// The other charts of a replay window (app/renderer/replay/replayMirrors.ts): each watches a market
// on the session's clock and shows nothing the clock has not passed. DOM-free — the workspace and
// its charts are stand-ins; the real chart is exercised in the app.
import { describe, it, expect } from 'vitest';
import type { DataProvider, OHLCV } from '../src';
import type { VelaWorkspace } from '../src/workspace';
import { bareSymbol, mountMirrors } from '../app/renderer/replay/replayMirrors';
import type { ReplayWindow } from '../app/renderer/replay/replayWindow';
import { timeframeToMs } from '../src';

const HOUR = 3_600_000;
const T0 = 1_700_000_000_000 - (1_700_000_000_000 % HOUR);

type Listener = (payload?: unknown) => void;

function emitter() {
    const listeners = new Map<string, Set<Listener>>();
    return {
        on(event: string, cb: Listener): () => void {
            const set = listeners.get(event) ?? new Set();
            set.add(cb);
            listeners.set(event, set);
            return () => { set.delete(cb); };
        },
        emit(event: string, payload?: unknown): void {
            for (const cb of [...(listeners.get(event) ?? [])]) cb(payload);
        },
    };
}

/** `count` bars of `timeframe`, starting at `from`. */
function barsOf(timeframe: string, from: number, count: number): OHLCV[] {
    const step = timeframeToMs(timeframe);
    return Array.from({ length: count }, (_, i) => ({
        time: from + i * step, open: 100 + i, high: 101 + i, low: 99 + i, close: 100.5 + i, volume: 1,
    }));
}

const archive: DataProvider = {
    info: () => ({ name: 'local', displayName: 'Local', requiresApiKey: false, capabilities: { enumerate: true, stream: false, symbolInfo: false } }),
    getBars: async (_ticker, timeframe, range) => barsOf(timeframe, T0, 400).filter((b) => b.time < (range.to ?? Infinity)),
};

function fakeCell(id: string, symbol: string, timeframe: string) {
    const events = emitter();
    const registered = new Map<string, unknown>();
    const unregistered: string[] = [];
    const chart = {
        market: { symbol, timeframe } as { symbol?: string; timeframe?: string },
        on: events.on,
        data: {
            registerProvider: (name: string, provider: unknown) => { registered.set(name, provider); },
            unregisterProvider: (name: string) => { unregistered.push(name); registered.delete(name); },
        },
        setMarket: async (next: { symbol?: string; timeframe?: string }) => {
            const prev = { ...chart.market };
            chart.market = { symbol: next.symbol ?? prev.symbol, timeframe: next.timeframe ?? prev.timeframe };
            events.emit('market:changed', { symbol: chart.market.symbol, timeframe: chart.market.timeframe, prev });
        },
    };
    return { cell: { id, chart, host: {} }, registered, unregistered, pick: (symbol: string, timeframe: string) => chart.setMarket({ symbol, timeframe }) };
}

function fakeWorkspace(cells: Array<ReturnType<typeof fakeCell>>, layoutId = '1') {
    const events = emitter();
    const state = { cells: [...cells], layout: layoutId };
    const ws = {
        cells: () => state.cells.map((c) => c.cell),
        cell: (id: string) => state.cells.find((c) => c.cell.id === id)?.cell,
        get layout() { return { id: state.layout }; },
        on: events.on,
    } as unknown as VelaWorkspace;
    return {
        ws,
        add(cell: ReturnType<typeof fakeCell>): void {
            state.cells.push(cell);
            events.emit('cell:created', { id: cell.cell.id });
        },
        remove(id: string): void {
            state.cells = state.cells.filter((c) => c.cell.id !== id);
            events.emit('cell:destroyed', { id });
        },
        setLayout(id: string): void { state.layout = id; },
    };
}

function setup(over: { clock?: number; loadWindow?: (s: string, tf: string, c: number) => Promise<ReplayWindow> } = {}) {
    const clock = { now: over.clock ?? T0 + 10 * HOUR + HOUR / 2 };
    const notes: string[] = [];
    const loaded: string[] = [];
    let serial = 0;
    const primary = fakeCell('c1', 'replay_p:NQ', '60');
    const harness = fakeWorkspace([primary]);
    const mirrors = mountMirrors({
        ws: harness.ws,
        primaryId: 'c1',
        archive,
        loadWindow: over.loadWindow ?? (async (symbol, timeframe, at) => {
            loaded.push(`${symbol}@${timeframe}@${at}`);
            return { bars: barsOf(timeframe, T0, 400), forming: null, stepMs: timeframeToMs(timeframe) };
        }),
        clock: () => clock.now,
        nameFor: () => `replay_m${++serial}`,
        fallback: () => ({ symbol: 'NQ', timeframe: '60' }),
        notify: (message) => { notes.push(message); },
    });
    return { clock, notes, loaded, primary, harness, mirrors };
}

/** The last of a list — `.at` is newer than the library this project compiles against. */
const last = <T,>(list: readonly T[]): T | undefined => list[list.length - 1];

const settle = async (): Promise<void> => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); };

/** The bars a mirror's own provider would hand a chart that asked for everything. */
async function served(cell: ReturnType<typeof fakeCell>, name: string): Promise<OHLCV[]> {
    const provider = cell.registered.get(name) as DataProvider;
    return provider.getBars('NQ', '60', { from: 0, to: Number.MAX_SAFE_INTEGER });
}

describe('bareSymbol', () => {
    it('takes the provider off a symbol, and leaves a bare one alone', () => {
        expect(bareSymbol('replay_x:NQ')).toBe('NQ');
        expect(bareSymbol('NQ')).toBe('NQ');
    });
});

describe('the charts beside the one that trades', () => {
    it('puts a new chart on a provider of its own, cut off before the candle the clock is in', async () => {
        const { harness, notes } = setup();
        const aux = fakeCell('c2', 'replay_p:NQ', '60');
        harness.add(aux);
        await settle();

        expect(notes).toEqual([]);
        const [name] = [...aux.registered.keys()];
        expect(name).toMatch(/^replay_m/);
        expect(aux.cell.chart.market.symbol).toBe(`${name}:NQ`);
        // Clock is half way into the 10th candle: nine closed ones show, the tenth does not.
        const shown = await served(aux, name!);
        expect(last(shown)!.time).toBe(T0 + 9 * HOUR);
        expect(shown.some((b) => b.time >= T0 + 10 * HOUR)).toBe(false);
    });

    it('never mirrors the chart that trades', async () => {
        const { primary, mirrors } = setup();
        await settle();
        expect(primary.registered.size).toBe(0);
        expect(mirrors.grid().cells).toEqual([]);
    });

    it('reveals a candle only once the clock has passed its end', async () => {
        const { harness, mirrors, clock } = setup();
        const aux = fakeCell('c2', 'replay_p:NQ', '60');
        harness.add(aux);
        await settle();
        const name = [...aux.registered.keys()][0]!;
        const seen: number[] = [];
        (aux.registered.get(name) as DataProvider).subscribe!('NQ', '60', (bar) => seen.push(bar.time));

        clock.now = T0 + 10 * HOUR + 59 * 60_000;
        mirrors.advance(clock.now);
        expect(seen).toEqual([]);

        clock.now = T0 + 11 * HOUR;
        mirrors.advance(clock.now);
        expect(seen).toEqual([T0 + 10 * HOUR]);

        // Several candles at once, as a skip does — one at a time, in order, none past the clock.
        clock.now = T0 + 14 * HOUR + 1;
        mirrors.advance(clock.now);
        expect(seen).toEqual([10, 11, 12, 13].map((h) => T0 + h * HOUR));
        const provider = aux.registered.get(name) as DataProvider;
        const everything = await provider.getBars('NQ', '60', { from: 0, to: Number.MAX_SAFE_INTEGER });
        expect(last(everything)!.time).toBe(T0 + 13 * HOUR);
    });

    it('starts a chart over on a provider of its own when the clock goes back', async () => {
        const { harness, mirrors, clock } = setup();
        const aux = fakeCell('c2', 'replay_p:NQ', '60');
        harness.add(aux);
        await settle();
        clock.now = T0 + 20 * HOUR;
        mirrors.advance(clock.now);
        const before = [...aux.registered.keys()][0]!;

        clock.now = T0 + 5 * HOUR + 600_000;
        await mirrors.rewind(clock.now);
        await settle();

        const [after] = [...aux.registered.keys()];
        expect(after).not.toBe(before);
        expect(aux.unregistered).toContain(before);
        const shown = await served(aux, after!);
        expect(last(shown)!.time).toBe(T0 + 4 * HOUR);
    });

    it('follows a market or a timeframe somebody picks, and ignores its own moves', async () => {
        const { harness, loaded } = setup();
        const aux = fakeCell('c2', 'replay_p:NQ', '60');
        harness.add(aux);
        await settle();
        expect(loaded).toHaveLength(1); // its own setMarket did not start another load

        await aux.pick('replay_p:ES', '60');
        await settle();
        expect(last(loaded)).toMatch(/^ES@60@/);
        expect(aux.cell.chart.market.symbol).toMatch(/^replay_m\d+:ES$/);

        await aux.pick(aux.cell.chart.market.symbol!, '15');
        await settle();
        expect(last(loaded)).toMatch(/^ES@15@/);
    });

    it('says so and goes back to what it showed when a market cannot be loaded', async () => {
        let failFor: string | null = null;
        const { harness, notes } = setup({
            loadWindow: async (symbol, timeframe) => {
                if (symbol === failFor) throw new Error(`No local data for ${symbol}. Download it first.`);
                return { bars: barsOf(timeframe, T0, 400), forming: null, stepMs: timeframeToMs(timeframe) };
            },
        });
        const aux = fakeCell('c2', 'replay_p:NQ', '60');
        harness.add(aux);
        await settle();

        failFor = 'XYZ';
        await aux.pick('replay_p:XYZ', '60');
        await settle();

        expect(notes).toEqual(['No local data for XYZ. Download it first.']);
        expect(aux.cell.chart.market.symbol).toMatch(/^replay_m\d+:NQ$/);
    });

    it('falls back to the session\'s own market when a new chart has nothing to show yet', async () => {
        const { harness, notes } = setup({
            loadWindow: async (symbol, timeframe) => {
                if (symbol === 'GONE') throw new Error('No local data for GONE. Download it first.');
                return { bars: barsOf(timeframe, T0, 400), forming: null, stepMs: timeframeToMs(timeframe) };
            },
        });
        const aux = fakeCell('c2', 'replay_p:GONE', '60');
        harness.add(aux);
        await settle();
        expect(notes).toHaveLength(1);
        expect(aux.cell.chart.market.symbol).toMatch(/^replay_m\d+:NQ$/);
    });

    it('fetches further candles when the loaded ones run out', async () => {
        let windows = 0;
        const { harness, mirrors, clock } = setup({
            loadWindow: async (_symbol, timeframe) => {
                windows += 1;
                // The first window ends at the 12th candle; the second goes on from there.
                return { bars: barsOf(timeframe, T0, windows === 1 ? 12 : 40), forming: null, stepMs: timeframeToMs(timeframe) };
            },
        });
        const aux = fakeCell('c2', 'replay_p:NQ', '60');
        harness.add(aux);
        await settle();
        const name = [...aux.registered.keys()][0]!;
        const seen: number[] = [];
        (aux.registered.get(name) as DataProvider).subscribe!('NQ', '60', (bar) => seen.push(bar.time));

        clock.now = T0 + 12 * HOUR;
        mirrors.advance(clock.now);
        await settle();
        clock.now = T0 + 16 * HOUR;
        mirrors.advance(clock.now);
        expect(windows).toBe(2);
        expect(last(seen)).toBe(T0 + 15 * HOUR);
        expect(new Set(seen).size).toBe(seen.length); // each candle once
    });

    it('stops looking for more once the data is all there is', async () => {
        let windows = 0;
        const { harness, mirrors, clock } = setup({
            loadWindow: async (_symbol, timeframe) => {
                windows += 1;
                return { bars: barsOf(timeframe, T0, 12), forming: null, stepMs: timeframeToMs(timeframe) };
            },
        });
        harness.add(fakeCell('c2', 'replay_p:NQ', '60'));
        await settle();
        for (let i = 0; i < 4; i += 1) {
            clock.now = T0 + (13 + i) * HOUR;
            mirrors.advance(clock.now);
            await settle();
        }
        expect(windows).toBeLessThanOrEqual(2);
    });

    it('reports the layout and what each chart beside the first watches, and brings it back', async () => {
        const { harness, mirrors, primary } = setup();
        harness.setLayout('2h');
        const aux = fakeCell('c2', 'replay_p:NQ', '60');
        harness.add(aux);
        await settle();
        await aux.pick('replay_p:ES', '15');
        await settle();

        const grid = mirrors.grid();
        expect(grid).toEqual({ layout: '2h', cells: [{ id: 'c2', symbol: 'ES', timeframe: '15' }] });

        // A fresh window, as a resumed session opens one.
        const second = setup();
        second.mirrors.expect(grid);
        const back = fakeCell('c2', 'replay_q:NQ', '60');
        second.harness.add(back);
        await settle();
        expect(back.cell.chart.market.symbol).toMatch(/^replay_m\d+:ES$/);
        expect(back.cell.chart.market.timeframe).toBe('15');
        expect(primary.registered.size).toBe(0);
    });

    it('lets go of a chart that leaves the layout', async () => {
        const { harness, mirrors } = setup();
        const aux = fakeCell('c2', 'replay_p:NQ', '60');
        harness.add(aux);
        await settle();
        const name = [...aux.registered.keys()][0]!;
        harness.remove('c2');
        expect(aux.unregistered).toContain(name);
        expect(mirrors.grid().cells).toEqual([]);
    });
});
