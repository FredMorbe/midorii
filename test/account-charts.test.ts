// Which charts an account is traded on (app/renderer/trading/accountCharts.ts): the charts
// showing its market get wiring and an indicator of their own, one of them feeds it prices,
// one carries its card — and a chart that moves elsewhere simply stops being any of them.
// DOM-free: the workspace and its charts are stand-ins.
import { describe, it, expect } from 'vitest';
import type { VelaWorkspace } from '../src/workspace';
import { VisualsFanOut, singleMarket, trackAccountCharts } from '../app/renderer/trading/accountCharts';

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

function fakeCell(id: string, symbol: string, timeframe: string) {
    const events = emitter();
    const indicators: Array<{ removed: boolean; inputs: Record<string, unknown> }> = [];
    const chart = {
        market: { symbol, timeframe },
        data: { resolve: (s: string) => ({ provider: 'venue', ticker: s.replace(/^venue:/, '') }) },
        on: events.on,
        addNativeIndicator: () => {
            const record = { removed: false, inputs: {} as Record<string, unknown> };
            indicators.push(record);
            return {
                setInput: (key: string, value: unknown) => { record.inputs[key] = value; },
                setInputs: (values: Record<string, unknown>) => { Object.assign(record.inputs, values); },
                remove: () => { record.removed = true; },
            };
        },
    };
    return {
        cell: { id, chart, host: {} },
        indicators,
        moveTo(next: string, tf = chart.market.timeframe): void {
            const prev = { ...chart.market };
            chart.market = { symbol: next, timeframe: tf };
            events.emit('market:changed', { symbol: next, prev });
        },
    };
}

function fakeWorkspace(cells: Array<ReturnType<typeof fakeCell>>, active: string) {
    const events = emitter();
    const state = { cells: [...cells], active };
    const ws = {
        cells: () => state.cells.map((c) => c.cell),
        cell: (id: string) => state.cells.find((c) => c.cell.id === id)?.cell,
        get active() { return state.cells.find((c) => c.cell.id === state.active)!.cell; },
        on: events.on,
    } as unknown as VelaWorkspace;
    return {
        ws,
        events,
        setActive(id: string): void {
            state.active = id;
            events.emit('cell:active', { id });
        },
        add(cell: ReturnType<typeof fakeCell>): void {
            state.cells.push(cell);
            events.emit('cell:created', { id: cell.cell.id });
        },
        remove(id: string): void {
            state.cells = state.cells.filter((c) => c.cell.id !== id);
            events.emit('cell:destroyed', { id });
        },
    };
}

const tick = (): Promise<void> => Promise.resolve();

describe('VisualsFanOut', () => {
    it('writes to every member and replays what it remembers to one that joins later', () => {
        const fan = new VisualsFanOut();
        const a: Record<string, unknown> = {};
        const b: Record<string, unknown> = {};
        const sink = (into: Record<string, unknown>) => ({
            setInput: (k: string, v: unknown) => { into[k] = v; },
            setInputs: (v: Record<string, unknown>) => { Object.assign(into, v); },
        });
        fan.add(sink(a));
        fan.setInput('state', '{"one":1}');
        fan.add(sink(b));
        expect(b).toEqual({ state: '{"one":1}' });
        fan.setInputs({ state: '{"two":2}', style: 's' });
        expect(a).toEqual({ state: '{"two":2}', style: 's' });
        expect(b).toEqual(a);
    });

    it('stops writing to a member that left', () => {
        const fan = new VisualsFanOut();
        const into: Record<string, unknown> = {};
        const off = fan.add({ setInput: (k, v) => { into[k] = v; }, setInputs: () => undefined });
        off();
        fan.setInput('state', 'x');
        expect(into).toEqual({});
    });
});

describe('trackAccountCharts', () => {
    it('wires every chart on the account\'s market, each with an indicator of its own', () => {
        const one = fakeCell('c1', 'venue:NQ', '60');
        const two = fakeCell('c2', 'venue:ES', '60');
        const three = fakeCell('c3', 'venue:NQ', '5');
        const { ws } = fakeWorkspace([one, two, three], 'c1');
        const charts = trackAccountCharts(ws, singleMarket(() => 'venue:NQ'));
        const wired: string[] = [];
        charts.each(new VisualsFanOut(), (cell) => { wired.push(cell.id); });
        expect(wired).toEqual(['c1', 'c3']);
        expect(one.indicators).toHaveLength(1);
        expect(two.indicators).toHaveLength(0);
        expect(three.indicators).toHaveLength(1);
    });

    it('takes the wiring and the indicator off a chart that moves to another market, and back', async () => {
        const one = fakeCell('c1', 'venue:NQ', '60');
        const two = fakeCell('c2', 'venue:NQ', '60');
        const { ws } = fakeWorkspace([one, two], 'c1');
        const charts = trackAccountCharts(ws, singleMarket(() => 'venue:NQ'));
        let released = 0;
        charts.each(new VisualsFanOut(), () => () => { released += 1; });
        two.moveTo('venue:ES');
        await tick();
        expect(released).toBe(1);
        expect(two.indicators[0]!.removed).toBe(true);
        expect(one.indicators[0]!.removed).toBe(false);
        two.moveTo('venue:NQ');
        await tick();
        expect(two.indicators).toHaveLength(2);
        expect(two.indicators[1]!.removed).toBe(false);
    });

    it('paints a chart that joins from the account as it stands', async () => {
        const one = fakeCell('c1', 'venue:NQ', '60');
        const two = fakeCell('c2', 'venue:ES', '60');
        const { ws } = fakeWorkspace([one, two], 'c1');
        const charts = trackAccountCharts(ws, singleMarket(() => 'venue:NQ'));
        const visuals = new VisualsFanOut();
        charts.each(visuals, () => undefined);
        visuals.setInput('state', '{"open":true}');
        two.moveTo('venue:NQ');
        await tick();
        expect(two.indicators[0]!.inputs).toEqual({ state: '{"open":true}' });
    });

    it('feeds from the finest timeframe, the first slot on a tie, and hands over when it leaves', async () => {
        const slow = fakeCell('c1', 'venue:NQ', '60');
        const fast = fakeCell('c2', 'venue:NQ', '1');
        const alsoFast = fakeCell('c3', 'venue:NQ', '1');
        const { ws } = fakeWorkspace([slow, fast, alsoFast], 'c1');
        const charts = trackAccountCharts(ws, singleMarket(() => 'venue:NQ'));
        const fed: string[] = [];
        charts.onFeed((cell) => {
            fed.push(cell.id);
            return () => { fed.push('-' + cell.id); };
        });
        expect(fed).toEqual(['c2']);
        fast.moveTo('venue:ES');
        await tick();
        expect(fed).toEqual(['c2', '-c2', 'c3']);
        alsoFast.moveTo('venue:ES');
        await tick();
        expect(fed).toEqual(['c2', '-c2', 'c3', '-c3', 'c1']);
        expect(charts.feed()?.id).toBe('c1');
    });

    it('lets go of the feed when no chart shows the market', async () => {
        const only = fakeCell('c1', 'venue:NQ', '60');
        const { ws } = fakeWorkspace([only], 'c1');
        const charts = trackAccountCharts(ws, singleMarket(() => 'venue:NQ'));
        const fed: string[] = [];
        charts.onFeed((cell) => {
            fed.push(cell.id);
            return () => { fed.push('-' + cell.id); };
        });
        only.moveTo('venue:ES');
        await tick();
        expect(fed).toEqual(['c1', '-c1']);
        expect(charts.feed()).toBeNull();
    });

    it('anchors the card to the active chart on the market, and keeps it when focus goes elsewhere', async () => {
        const one = fakeCell('c1', 'venue:NQ', '60');
        const two = fakeCell('c2', 'venue:NQ', '60');
        const other = fakeCell('c3', 'venue:ES', '60');
        const harness = fakeWorkspace([one, two, other], 'c1');
        const charts = trackAccountCharts(harness.ws, singleMarket(() => 'venue:NQ'));
        const anchored: string[] = [];
        charts.onAnchor((cell) => {
            anchored.push(cell.id);
            return () => { anchored.push('-' + cell.id); };
        });
        expect(anchored).toEqual(['c1']);
        harness.setActive('c2');
        await tick();
        expect(anchored).toEqual(['c1', '-c1', 'c2']);
        harness.setActive('c3');
        await tick();
        expect(anchored).toEqual(['c1', '-c1', 'c2']);
    });

    it('follows charts that come and go with the layout', async () => {
        const one = fakeCell('c1', 'venue:NQ', '60');
        const harness = fakeWorkspace([one], 'c1');
        const charts = trackAccountCharts(harness.ws, singleMarket(() => 'venue:NQ'));
        const wired: string[] = [];
        charts.each(new VisualsFanOut(), (cell) => {
            wired.push(cell.id);
            return () => { wired.push('-' + cell.id); };
        });
        const two = fakeCell('c2', 'venue:NQ', '60');
        harness.add(two);
        await tick();
        expect(wired).toEqual(['c1', 'c2']);
        harness.remove('c2');
        await tick();
        expect(wired).toEqual(['c1', 'c2', '-c2']);
    });

    it('tears everything down on dispose', () => {
        const one = fakeCell('c1', 'venue:NQ', '60');
        const { ws } = fakeWorkspace([one], 'c1');
        const charts = trackAccountCharts(ws, singleMarket(() => 'venue:NQ'));
        const log: string[] = [];
        charts.each(new VisualsFanOut(), () => () => { log.push('each'); });
        charts.onFeed(() => () => { log.push('feed'); });
        charts.onAnchor(() => () => { log.push('anchor'); });
        charts.dispose();
        expect(log.sort()).toEqual(['anchor', 'each', 'feed']);
        expect(one.indicators[0]!.removed).toBe(true);
    });

    it('matches nothing while the account has no market', () => {
        const one = fakeCell('c1', 'venue:NQ', '60');
        const { ws } = fakeWorkspace([one], 'c1');
        const charts = trackAccountCharts(ws, singleMarket(() => ''));
        expect(charts.matching()).toEqual([]);
        expect(charts.feed()).toBeNull();
    });
});

describe('trackAccountCharts over several instruments', () => {
    const byShownSymbol = (cell: { chart: { market: { symbol?: string } } }): string | null => (
        cell.chart.market.symbol?.startsWith('chartonly:') ? null : cell.chart.market.symbol ?? null
    );

    it('answers for every chart that can be traded, each with the instrument it shows', () => {
        const nq = fakeCell('c1', 'venue:NQ', '60');
        const es = fakeCell('c2', 'venue:ES', '60');
        const only = fakeCell('c3', 'chartonly:X', '60');
        const { ws } = fakeWorkspace([nq, es, only], 'c1');
        const charts = trackAccountCharts(ws, byShownSymbol);
        expect(charts.instruments().sort()).toEqual(['venue:ES', 'venue:NQ']);
        expect(charts.matching().map((c) => c.id)).toEqual(['c1', 'c2']);
        expect(charts.instrumentOf(only.cell as never)).toBeNull();
    });

    it('draws each chart into the sink of its own instrument', () => {
        const nq = fakeCell('c1', 'venue:NQ', '60');
        const es = fakeCell('c2', 'venue:ES', '60');
        const { ws } = fakeWorkspace([nq, es], 'c1');
        const charts = trackAccountCharts(ws, byShownSymbol);
        const sinks = new Map<string, VisualsFanOut>();
        charts.each((instrument) => {
            const sink = new VisualsFanOut();
            sinks.set(instrument, sink);
            return sink;
        }, () => undefined);
        sinks.get('venue:NQ')!.setInput('state', 'nq');
        sinks.get('venue:ES')!.setInput('state', 'es');
        expect(nq.indicators[0]!.inputs).toEqual({ state: 'nq' });
        expect(es.indicators[0]!.inputs).toEqual({ state: 'es' });
    });

    it('feeds each instrument from its own finest chart', () => {
        const nqSlow = fakeCell('c1', 'venue:NQ', '60');
        const es = fakeCell('c2', 'venue:ES', '15');
        const nqFast = fakeCell('c3', 'venue:NQ', '1');
        const { ws } = fakeWorkspace([nqSlow, es, nqFast], 'c1');
        const charts = trackAccountCharts(ws, byShownSymbol);
        const fed: string[] = [];
        charts.onFeed((cell, instrument) => {
            fed.push(instrument + '<-' + cell.id);
            return () => { fed.push('-' + instrument); };
        });
        expect(fed.sort()).toEqual(['venue:ES<-c2', 'venue:NQ<-c3']);
        expect(charts.feed('venue:NQ')?.id).toBe('c3');
        expect(charts.feed('venue:ES')?.id).toBe('c2');
    });

    it('moves a chart to the wiring of another instrument when its market changes', async () => {
        const one = fakeCell('c1', 'venue:NQ', '60');
        const { ws } = fakeWorkspace([one], 'c1');
        const charts = trackAccountCharts(ws, byShownSymbol);
        const log: string[] = [];
        charts.each(new VisualsFanOut(), (cell, _indicator, instrument) => {
            log.push(instrument);
            return () => { log.push('-' + instrument); };
        });
        one.moveTo('venue:ES');
        await tick();
        expect(log).toEqual(['venue:NQ', '-venue:NQ', 'venue:ES']);
    });

    it('lets go of the feed of an instrument when its last chart leaves, and keeps the others', async () => {
        const nq = fakeCell('c1', 'venue:NQ', '60');
        const es = fakeCell('c2', 'venue:ES', '60');
        const { ws } = fakeWorkspace([nq, es], 'c1');
        const charts = trackAccountCharts(ws, byShownSymbol);
        const fed: string[] = [];
        charts.onFeed((_cell, instrument) => {
            fed.push(instrument);
            return () => { fed.push('-' + instrument); };
        });
        es.moveTo('venue:NQ');
        await tick();
        expect(fed).toEqual(['venue:NQ', 'venue:ES', '-venue:ES']);
        expect(charts.feed('venue:ES')).toBeNull();
    });
});

