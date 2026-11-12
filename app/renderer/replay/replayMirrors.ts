import { timeframeToMs } from '../../../src';
import type { DataProvider } from '../../../src';
import type { ChartCell, VelaWorkspace } from '../../../src/workspace';
import { forEachCell } from '../shell/eachCell';
import { ReplayProvider } from './ReplayProvider';
import type { ReplayGrid } from './ReplayController';
import type { ReplayWindow } from './replayWindow';

/**
 * The other charts of a replay window: markets and timeframes watched on the session's clock.
 *
 * A replay has ONE clock, owned by the session on the market it trades. Every other chart is a
 * mirror of it: it shows a market from the local archive, and shows nothing the clock has not
 * passed. They are for looking — they carry none of the trading, and the account never hears of
 * what they show.
 *
 * What a mirror reveals
 * ---------------------
 * Candles that have CLOSED. A candle appears when the clock reaches its end, and the one the
 * clock is standing inside is not drawn at all: showing it as far as it has got would take a
 * request per step per chart, for a figure that is only ever read after it is final. It also
 * means there is nothing to leak — the provider behind each mirror is cut off at the start of
 * that candle, and moves forward one closed candle at a time.
 *
 * Each mirror has a provider of its own, under a name of its own. A shared one would be one
 * chart's candles handed to another timeframe's chart, which would take a five-minute bar for
 * an hourly one.
 */

export interface MirrorsOptions {
    ws: VelaWorkspace;
    /** The slot that trades. It is never a mirror. */
    primaryId: string;
    archive: DataProvider;
    /** Bars around a clock — the same loader the session uses for its own window. */
    loadWindow: (symbol: string, timeframe: string, clock: number) => Promise<ReplayWindow>;
    /** Where the session's clock stands. */
    clock: () => number;
    /** A fresh provider name — see `providerNameFor`. */
    nameFor: () => string;
    /** What a mirror falls back to when what was asked for cannot be shown: the session's market. */
    fallback: () => { symbol: string; timeframe: string };
    notify: (message: string, kind: 'info' | 'error') => void;
}

export interface Mirrors {
    /** Reveal what the clock has passed. Cheap — called on every repaint of the session. */
    advance(clock: number): void;
    /** The clock went back: every mirror starts over at it. */
    rewind(clock: number): Promise<void>;
    /** What the charts besides the first show, for a session that is put down. */
    grid(): ReplayGrid;
    /** Bring a parked session's charts back. Call once, before the layout is applied. */
    expect(grid: ReplayGrid): void;
    dispose(): void;
}

interface Mirror {
    cell: ChartCell;
    symbol: string;
    timeframe: string;
    /** The provider the chart is on, or null while it is still on whatever it opened with. */
    name: string | null;
    provider: ReplayProvider | null;
    bars: ReplayWindow['bars'];
    /** Index of the first candle that has not closed yet. */
    next: number;
    /** Which `show` is the live one; a slower one that lands late is dropped. */
    generation: number;
    /** What the chart is on because WE put it there — told apart from a market somebody picked. */
    expecting: string | null;
    /** The loaded candles ran out and a longer window is being fetched, or there is no more. */
    extending: boolean;
    exhausted: boolean;
}

/** The market of a prefixed symbol — `replay_x:NQ` is `NQ`. */
export function bareSymbol(symbol: string): string {
    const at = symbol.indexOf(':');
    return at >= 0 ? symbol.slice(at + 1) : symbol;
}

export function mountMirrors(opts: MirrorsOptions): Mirrors {
    const { ws, primaryId, archive } = opts;
    const mirrors = new Map<string, Mirror>();
    const saved = new Map<string, { symbol: string; timeframe: string }>();
    let disposed = false;

    /**
     * Put a mirror's chart on `symbol` at `timeframe`, as the clock stands.
     *
     * A fresh provider under a fresh name, for the reason the session's own chart gets one when
     * it goes back: the chart holds candles after the clock, and the shared cache would hand
     * them straight back. Returns whether it landed. Where it did not the person is told, once,
     * and the chart is put back on what it showed before — or on the session's own market where
     * it showed nothing yet. `recovering` is that second attempt, which does not try a third.
     */
    async function show(m: Mirror, symbol: string, timeframe: string, recovering = false): Promise<boolean> {
        const generation = ++m.generation;
        const clock = opts.clock();
        let window_: ReplayWindow;
        try {
            window_ = await opts.loadWindow(symbol, timeframe, clock);
        } catch (err: unknown) {
            if (generation !== m.generation || disposed) return false;
            await failed(m, err, recovering);
            return false;
        }
        if (generation !== m.generation || disposed) return false;

        const stepMs = timeframeToMs(timeframe);
        let next = window_.bars.findIndex((bar) => bar.time + stepMs > clock);
        if (next === -1) next = window_.bars.length;
        // The candle the clock is inside stays hidden: the provider is cut off where it began.
        const cutoff = next < window_.bars.length ? Math.min(window_.bars[next]!.time, clock) : clock;

        const name = opts.nameFor();
        const provider = new ReplayProvider(archive, name, timeframe, cutoff, false);
        const data = m.cell.chart.data;
        data.registerProvider(name, provider);
        m.expecting = `${name}:${symbol}@${timeframe}`;
        try {
            await m.cell.chart.setMarket({ symbol: `${name}:${symbol}`, timeframe });
        } catch (err: unknown) {
            data.unregisterProvider(name);
            m.expecting = m.name ? `${m.name}:${m.symbol}@${m.timeframe}` : null;
            if (generation !== m.generation || disposed) return false;
            await failed(m, err, recovering);
            return false;
        }
        if (generation !== m.generation || disposed) {
            // Something newer is already on its way; this one never became the chart's.
            data.unregisterProvider(name);
            return false;
        }

        const previous = m.name;
        m.name = name;
        m.provider = provider;
        m.symbol = symbol;
        m.timeframe = timeframe;
        m.bars = window_.bars;
        m.next = next;
        m.extending = false;
        m.exhausted = false;
        if (previous) data.unregisterProvider(previous);
        return true;
    }

    /** A request that could not be met: say so, then put the chart back where it can be read. */
    async function failed(m: Mirror, err: unknown, recovering: boolean): Promise<void> {
        const message = err instanceof Error ? err.message : String(err);
        if (recovering) {
            console.error('[midorii] a replay chart could not be put back', err);
            return;
        }
        opts.notify(message, 'error');
        const back = m.provider ? { symbol: m.symbol, timeframe: m.timeframe } : opts.fallback();
        await show(m, back.symbol, back.timeframe, true);
    }

    /** Reveal every candle the clock has now passed, and fetch more when the loaded ones run out. */
    function advanceOne(m: Mirror, clock: number): void {
        const provider = m.provider;
        if (!provider) return;
        const stepMs = timeframeToMs(m.timeframe);
        try {
            while (m.next < m.bars.length && m.bars[m.next]!.time + stepMs <= clock) {
                provider.revealNext(m.bars[m.next]!);
                m.next += 1;
            }
        } catch (err: unknown) {
            opts.notify(err instanceof Error ? err.message : String(err), 'error');
            return;
        }
        if (m.next >= m.bars.length && !m.extending && !m.exhausted) void extend(m);
    }

    /** Load further candles behind the ones already held, from where the clock stands. */
    async function extend(m: Mirror): Promise<void> {
        m.extending = true;
        const generation = m.generation;
        try {
            const more = await opts.loadWindow(m.symbol, m.timeframe, opts.clock());
            if (generation !== m.generation || disposed) return;
            const last = m.bars[m.bars.length - 1]?.time ?? -Infinity;
            const fresh = more.bars.filter((bar) => bar.time > last);
            if (fresh.length === 0) m.exhausted = true;
            else m.bars = [...m.bars, ...fresh];
        } catch {
            // No more data to be had; what is on the chart is all there is.
            m.exhausted = true;
        } finally {
            if (generation === m.generation) m.extending = false;
        }
    }

    const offCells = forEachCell(ws, (cell) => {
        if (cell.id === primaryId) return undefined;
        const fromChart = cell.chart.market;
        const wanted = saved.get(cell.id);
        saved.delete(cell.id);
        const spec = wanted ?? {
            symbol: bareSymbol(fromChart.symbol ?? opts.fallback().symbol),
            timeframe: fromChart.timeframe ?? opts.fallback().timeframe,
        };
        const m: Mirror = {
            cell,
            symbol: spec.symbol,
            timeframe: spec.timeframe,
            name: null,
            provider: null,
            bars: [],
            next: 0,
            generation: 0,
            expecting: null,
            extending: false,
            exhausted: false,
        };
        mirrors.set(cell.id, m);
        void show(m, spec.symbol, spec.timeframe);

        /* A market or a timeframe somebody picked on this chart: the clock is the session's, so
         * the chart is put on the same instant under a provider of its own. */
        const off = cell.chart.on('market:changed', ({ symbol, timeframe }) => {
            if (!symbol || !timeframe || `${symbol}@${timeframe}` === m.expecting) return;
            void show(m, bareSymbol(symbol), timeframe);
        });
        return () => {
            off();
            m.generation += 1;
            mirrors.delete(cell.id);
            if (m.name) cell.chart.data.unregisterProvider(m.name);
        };
    });

    return {
        advance(clock) {
            for (const m of mirrors.values()) advanceOne(m, clock);
        },
        async rewind() {
            // Every mirror, including one still loading: what it was fetching is of a later clock.
            await Promise.all([...mirrors.values()].map((m) => show(m, m.symbol, m.timeframe, true)));
        },
        grid() {
            return {
                layout: ws.layout.id,
                cells: ws.cells()
                    .filter((cell) => cell.id !== primaryId)
                    .map((cell) => {
                        const m = mirrors.get(cell.id);
                        return { id: cell.id, symbol: m?.symbol ?? '', timeframe: m?.timeframe ?? '' };
                    })
                    .filter((cell) => cell.symbol && cell.timeframe),
            };
        },
        expect(grid) {
            for (const cell of grid.cells) saved.set(cell.id, { symbol: cell.symbol, timeframe: cell.timeframe });
        },
        dispose() {
            disposed = true;
            offCells();
            mirrors.clear();
        },
    };
}
