import type { IndicatorHandle } from '../../../src';
import type { ChartCell, VelaWorkspace } from '../../../src/workspace';
import { timeframeToMs } from '../../../src/data/timeframe';
import { TRADE_INDICATOR_TYPE, registerTradeIndicator } from '../replay/replayIndicator';
import { leftArmedMarket } from './accountMarkets';

/**
 * Which charts an account is traded on.
 *
 * An account is a mode of the app, not a property of one chart. Which charts it is traded on is
 * decided by the caller's `instrumentOf`: it names the instrument a chart stands for, or null for
 * a chart that is only a chart. A venue account has ONE instrument, so only the charts showing
 * its market answer; a paper account has as many as it has been given, so every chart that can
 * be traded answers, each with the instrument it shows. A chart that moves to another market
 * simply changes its answer — the account is not told to follow.
 *
 * This module keeps that set of charts, and answers the three questions the trading UI has:
 *
 *  - which charts draw the account's positions and take its gestures ({@link AccountCharts.each}),
 *  - which ONE chart per instrument feeds it prices ({@link AccountCharts.onFeed}),
 *  - which ONE chart carries the single card and quick panel ({@link AccountCharts.onAnchor}).
 *
 * The feed is the chart with the finest timeframe, the first slot on a tie. It does not depend on
 * which chart the account was armed on, so the same layout always trades the same way; when it
 * changes hands the account loses only the bar it was standing in.
 */

/** What an account draws through: the two writes a native indicator takes. */
export type VisualsSink = Pick<IndicatorHandle, 'setInput' | 'setInputs'>;
type InputValue = Parameters<IndicatorHandle['setInput']>[1];

/**
 * One sink in front of every chart's position indicator.
 *
 * The controllers push their state to a single indicator; with several charts they push to this
 * and it fans the write out. It remembers the latest value of every input, so a chart that joins
 * later is painted from what the account looks like now rather than from the next tick.
 */
export class VisualsFanOut implements VisualsSink {
    private readonly last = new Map<string, InputValue>();
    private readonly members = new Set<VisualsSink>();

    setInput(key: string, value: InputValue): void {
        this.last.set(key, value);
        for (const member of this.members) member.setInput(key, value);
    }

    setInputs(values: Record<string, InputValue>): void {
        for (const [key, value] of Object.entries(values)) this.last.set(key, value);
        for (const member of this.members) member.setInputs(values);
    }

    /** Paint `sink` from the remembered state and keep it painted. Returns the way out. */
    add(sink: VisualsSink): () => void {
        this.members.add(sink);
        if (this.last.size > 0) sink.setInputs(Object.fromEntries(this.last));
        return () => { this.members.delete(sink); };
    }
}

/** The instrument a chart stands for, or null when it is only a chart. */
export type InstrumentOf = (cell: ChartCell) => string | null;

/**
 * The answer of an account with ONE market: its instrument is whichever chart shows it.
 *
 * Compared as the provider resolves the two rather than as strings — the same contract can be
 * written with and without its prefix, and a timeframe change keeps the instrument.
 */
export function singleMarket(symbol: () => string): InstrumentOf {
    return (cell) => {
        const account = symbol();
        const shown = cell.chart.market.symbol;
        if (!account || !shown) return null;
        if (account === shown) return 'account';
        const data = cell.chart.data;
        const a = data.resolve(account);
        const b = data.resolve(shown);
        return a != null && b != null && !leftArmedMarket(a, b) ? 'account' : null;
    };
}

export interface AccountCharts {
    /**
     * Run `setup` on every chart that stands for an instrument, with a position indicator of its
     * own on it that `visuals` draws into — one sink for the whole account, or one per
     * instrument. Charts come and go as the layout and their markets change; `setup`'s disposer
     * runs when one stops matching or moves to another instrument.
     */
    each(
        visuals: VisualsFanOut | ((instrument: string, cell: ChartCell) => VisualsFanOut),
        setup: (cell: ChartCell, indicator: IndicatorHandle, instrument: string) => (() => void) | void,
    ): () => void;
    /** Follow the chart that feeds each instrument its prices. */
    onFeed(use: (cell: ChartCell, instrument: string) => (() => void) | void): () => void;
    /** Follow the chart that carries the account's card. */
    onAnchor(use: (cell: ChartCell) => (() => void) | void): () => void;
    /** The charts that stand for an instrument, in slot order. */
    matching(): ChartCell[];
    /** The instruments some chart stands for right now. */
    instruments(): string[];
    /** The instrument a chart stands for, or null. */
    instrumentOf(cell: ChartCell): string | null;
    /** The chart feeding an instrument right now, or null when no chart shows it. */
    feed(instrument?: string): ChartCell | null;
    /** Look again now — for when the account's market has just changed. */
    refresh(): void;
    dispose(): void;
}

interface Placed {
    cell: ChartCell;
    instrument: string;
}

export function trackAccountCharts(ws: VelaWorkspace, instrumentOf: InstrumentOf): AccountCharts {
    const eachSubs: Array<{
        visuals: VisualsFanOut | ((instrument: string, cell: ChartCell) => VisualsFanOut);
        setup: (cell: ChartCell, indicator: IndicatorHandle, instrument: string) => (() => void) | void;
        live: Map<string, { instrument: string; release: () => void }>;
    }> = [];
    const feedSubs: Array<{
        use: (cell: ChartCell, instrument: string) => (() => void) | void;
        live: Map<string, { cellId: string; release: (() => void) | null }>;
    }> = [];
    const anchorSubs: Array<{
        use: (cell: ChartCell) => (() => void) | void;
        id: string | null;
        release: (() => void) | null;
    }> = [];
    let anchorId: string | null = null;
    let queued = false;
    let disposed = false;

    const placed = (): Placed[] => {
        const out: Placed[] = [];
        for (const cell of ws.cells()) {
            const instrument = instrumentOf(cell);
            if (instrument != null) out.push({ cell, instrument });
        }
        return out;
    };

    const feedOf = (cells: ChartCell[]): ChartCell | null => {
        let best: ChartCell | null = null;
        let bestMs = Infinity;
        for (const cell of cells) {
            const ms = timeframeToMs(cell.chart.market.timeframe ?? '60');
            if (ms < bestMs) {
                best = cell;
                bestMs = ms;
            }
        }
        return best;
    };

    /** The feed chart of each instrument shown. */
    const feeds = (all: Placed[]): Map<string, ChartCell> => {
        const groups = new Map<string, ChartCell[]>();
        for (const { cell, instrument } of all) {
            const list = groups.get(instrument) ?? [];
            list.push(cell);
            groups.set(instrument, list);
        }
        const out = new Map<string, ChartCell>();
        for (const [instrument, cells] of groups) {
            const feed = feedOf(cells);
            if (feed) out.set(instrument, feed);
        }
        return out;
    };

    function evaluate(): void {
        if (disposed) return;
        const all = placed();
        const byId = new Map(all.map((p) => [p.cell.id, p]));

        for (const sub of eachSubs) {
            for (const [id, live] of [...sub.live]) {
                if (byId.get(id)?.instrument === live.instrument) continue;
                sub.live.delete(id);
                live.release();
            }
            for (const { cell, instrument } of all) {
                if (sub.live.has(cell.id)) continue;
                registerTradeIndicator();
                const indicator = cell.chart.addNativeIndicator(TRADE_INDICATOR_TYPE);
                const sink = typeof sub.visuals === 'function' ? sub.visuals(instrument, cell) : sub.visuals;
                const detach = sink.add(indicator);
                const user = sub.setup(cell, indicator, instrument);
                sub.live.set(cell.id, {
                    instrument,
                    release: () => {
                        user?.();
                        detach();
                        indicator.remove();
                    },
                });
            }
        }

        const fed = feeds(all);
        for (const sub of feedSubs) {
            for (const [instrument, live] of [...sub.live]) {
                if (fed.get(instrument)?.id === live.cellId) continue;
                sub.live.delete(instrument);
                live.release?.();
            }
            for (const [instrument, cell] of fed) {
                if (sub.live.has(instrument)) continue;
                sub.live.set(instrument, { cellId: cell.id, release: sub.use(cell, instrument) ?? null });
            }
        }

        /* The active chart when it stands for an instrument; else the one that carried the card
         * last; else the first. The card stays put while focus is on a chart that cannot use it. */
        let active: string | null = null;
        try { active = ws.active.id; } catch { /* the workspace is gone */ }
        if (active && byId.has(active)) anchorId = active;
        else if (!anchorId || !byId.has(anchorId)) anchorId = all[0]?.cell.id ?? null;
        const anchor = anchorId ? byId.get(anchorId)?.cell ?? null : null;
        for (const sub of anchorSubs) {
            if ((anchor?.id ?? null) === sub.id) continue;
            sub.release?.();
            sub.release = null;
            sub.id = anchor?.id ?? null;
            if (anchor) sub.release = sub.use(anchor) ?? null;
        }
    }

    /* A market change arrives as an event on one chart, and the account may be about to follow
     * it in a listener that runs after this one. Looking a tick later sees the settled answer
     * instead of tearing a chart's wiring down and putting it straight back. */
    const later = (): void => {
        if (queued || disposed) return;
        queued = true;
        queueMicrotask(() => {
            queued = false;
            evaluate();
        });
    };

    const offCells = (() => {
        const live = new Map<string, () => void>();
        const attach = (id: string): void => {
            const cell = ws.cell(id);
            if (!cell || live.has(id)) return;
            live.set(id, cell.chart.on('market:changed', later));
        };
        for (const cell of ws.cells()) attach(cell.id);
        const offs = [
            ws.on('cell:created', ({ id }) => { attach(id); later(); }),
            ws.on('cell:destroyed', ({ id }) => { live.get(id)?.(); live.delete(id); later(); }),
            ws.on('cell:active', later),
            ws.on('layout:changed', later),
        ];
        return () => {
            for (const off of offs) off();
            for (const off of live.values()) off();
            live.clear();
        };
    })();

    return {
        each(visuals, setup) {
            const sub = { visuals, setup, live: new Map<string, { instrument: string; release: () => void }>() };
            eachSubs.push(sub);
            evaluate();
            return () => {
                eachSubs.splice(eachSubs.indexOf(sub), 1);
                for (const live of sub.live.values()) live.release();
                sub.live.clear();
            };
        },
        onFeed(use) {
            const sub = { use, live: new Map<string, { cellId: string; release: (() => void) | null }>() };
            feedSubs.push(sub);
            evaluate();
            return () => {
                feedSubs.splice(feedSubs.indexOf(sub), 1);
                for (const live of sub.live.values()) live.release?.();
                sub.live.clear();
            };
        },
        onAnchor(use) {
            const sub = { use, id: null as string | null, release: null as (() => void) | null };
            anchorSubs.push(sub);
            evaluate();
            return () => {
                anchorSubs.splice(anchorSubs.indexOf(sub), 1);
                sub.release?.();
            };
        },
        matching: () => placed().map((p) => p.cell),
        instruments: () => [...new Set(placed().map((p) => p.instrument))],
        instrumentOf,
        feed(instrument) {
            const all = placed();
            if (instrument == null) return feedOf(all.map((p) => p.cell));
            return feeds(all).get(instrument) ?? null;
        },
        refresh: evaluate,
        dispose() {
            disposed = true;
            offCells();
            for (const sub of eachSubs) for (const live of sub.live.values()) live.release();
            for (const sub of feedSubs) for (const live of sub.live.values()) live.release?.();
            for (const sub of anchorSubs) sub.release?.();
            eachSubs.length = 0;
            feedSubs.length = 0;
            anchorSubs.length = 0;
        },
    };
}
