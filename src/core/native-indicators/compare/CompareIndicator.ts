import type { InputSchema, InputValue } from '../../model/inputs';
import type { SeriesPoint, SeriesSpec } from '../../model/series';
import { stableSeriesId } from '../../model/identity';
import { COMPARE_LINE } from '../../palette';
import type { DataProvider } from '../../ports/DataProvider';
import type { VisibleRange } from '../../ports/IChartRenderer';
import type { NativeIndicator, NativeIndicatorContext, NativeIndicatorDescriptor } from '../NativeIndicator';
import { alignCloses, anchorIndex, rebased, spreadValues, type SpreadMode } from './compareMath';

/**
 * Two indicators that put a second market next to the chart's own.
 *
 * COMPARE lays the second market over the price candles, rebased onto the chart's price scale
 * from the left edge of what is on screen, so two markets that move alike lie on top of each
 * other and the one that moves more runs away. SPREAD gets a pane of its own and plots the
 * chart's market against the second one, as a ratio or a difference.
 *
 * The second market is read through the data layer the chart already has, on the chart's own
 * timeframe, so a market any registered provider serves can be compared with one from another
 * venue. Bars are lined up by open time; where the second market has none, the line has a gap.
 */

type Kind = 'compare' | 'spread';

const DEFAULT_COLOR = COMPARE_LINE;
/** Coalesce ticks and pans into one redraw per this many ms. */
const REDRAW_MS = 80;

const symbolInput = (): InputSchema => ({ key: 'symbol', title: 'Symbol', type: 'symbol', defval: '' });
const colorInput = (): InputSchema => ({ key: 'color', title: 'Color', type: 'color', defval: DEFAULT_COLOR });
const widthInput = (): InputSchema => ({ key: 'width', title: 'Line width', type: 'int', defval: 2, min: 1, max: 6, step: 1 });
const modeInput = (): InputSchema => ({ key: 'mode', title: 'Show', type: 'string', defval: 'Ratio', options: ['Ratio', 'Difference'] });

const tickerOf = (symbol: string): string => {
    const at = symbol.indexOf(':');
    return at >= 0 ? symbol.slice(at + 1) : symbol;
};

class OtherSymbolIndicator implements NativeIndicator {
    private ctx!: NativeIndicatorContext;
    private inputs: Record<string, InputValue> = {};
    private readonly other = new Map<number, number>();
    private target: { provider: DataProvider; ticker: string } | null = null;
    /** The oldest time the second market has been asked for. */
    private fetchedFrom = Number.POSITIVE_INFINITY;
    private fetching = false;
    /** Bumped on every reload and on stop, so an answer to a stale request is dropped. */
    private token = 0;
    private unsubscribe: (() => void) | null = null;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private viewFrom: number | null = null;
    private stopped = false;

    constructor(private readonly kind: Kind) {}

    start(ctx: NativeIndicatorContext, inputs: Record<string, InputValue>): void {
        this.ctx = ctx;
        this.inputs = inputs;
        this.stopped = false;
        this.reload();
    }

    onBars(): void {
        this.extendBack();
        this.schedule();
    }

    onViewport(range: VisibleRange): void {
        if (this.kind !== 'compare') return;
        this.viewFrom = range.from;
        this.schedule();
    }

    setInputs(inputs: Record<string, InputValue>): void {
        // Inputs set before the chart has started the indicator are the ones `start` is then given.
        if (!this.ctx) {
            this.inputs = inputs;
            return;
        }
        const sameMarket = String(inputs.symbol ?? '') === String(this.inputs.symbol ?? '');
        this.inputs = inputs;
        if (sameMarket) this.render();
        else this.reload();
    }

    suspend(): void {
        this.stopFeed();
    }

    resume(): void {
        this.reload();
    }

    stop(): void {
        this.stopped = true;
        this.token++;
        this.stopFeed();
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
    }

    private symbol(): string {
        return String(this.inputs.symbol ?? '').trim();
    }

    private stopFeed(): void {
        this.unsubscribe?.();
        this.unsubscribe = null;
    }

    private reload(): void {
        this.stopFeed();
        this.other.clear();
        this.fetchedFrom = Number.POSITIVE_INFINITY;
        this.fetching = false;
        const token = ++this.token;
        this.target = null;

        const symbol = this.symbol();
        if (!symbol) {
            this.render();
            this.ctx.setStatus('idle');
            return;
        }
        const resolved = this.ctx.data.resolve(symbol);
        const provider = resolved ? this.ctx.data.providerInstance(resolved.provider) : undefined;
        if (!resolved || !provider) {
            console.warn(`[vela] ${this.kind}: nothing serves "${symbol}"`);
            this.render();
            this.ctx.setStatus('idle');
            return;
        }
        this.target = { provider, ticker: resolved.ticker };
        this.ctx.setStatus('loading');
        const from = this.ctx.bars()[0]?.time ?? Date.now();
        void this.fetch(token, from, undefined).then(() => {
            if (token !== this.token) return;
            this.render();
            this.startFeed();
            this.ctx.setStatus(this.unsubscribe ? 'live' : 'idle');
        });
    }

    /** Fetch the second market from `from` (to `to`, or now) into the map. A failure is reported and leaves a gap. */
    private async fetch(token: number, from: number, to: number | undefined): Promise<void> {
        const target = this.target;
        if (!target) return;
        this.fetching = true;
        try {
            const bars = await target.provider.getBars(target.ticker, this.ctx.timeframe, { from, ...(to != null ? { to } : {}), ...(this.ctx.session ? { session: this.ctx.session } : {}) });
            if (token !== this.token) return;
            for (const bar of bars) this.other.set(bar.time, bar.close);
            this.fetchedFrom = Math.min(this.fetchedFrom, from);
        } catch (err) {
            console.warn(`[vela] ${this.kind}: could not load ${this.symbol()}`, err);
            this.fetchedFrom = Math.min(this.fetchedFrom, from); // do not ask again for the same stretch
        } finally {
            if (token === this.token) this.fetching = false;
        }
    }

    /** The chart loaded older bars: bring the second market back as far. */
    private extendBack(): void {
        if (!this.target || this.fetching || !Number.isFinite(this.fetchedFrom)) return;
        const first = this.ctx.bars()[0]?.time;
        if (first == null || first >= this.fetchedFrom) return;
        const token = this.token;
        const until = this.fetchedFrom;
        void this.fetch(token, first, until).then(() => {
            if (token === this.token) this.schedule();
        });
    }

    private startFeed(): void {
        const target = this.target;
        if (!target || !this.ctx.live || !target.provider.subscribe || this.stopped) return;
        this.unsubscribe = target.provider.subscribe(target.ticker, this.ctx.timeframe, (bar) => {
            this.other.set(bar.time, bar.close);
            this.schedule();
        });
    }

    private schedule(): void {
        if (this.timer || this.stopped) return;
        this.timer = setTimeout(() => {
            this.timer = null;
            this.render();
        }, REDRAW_MS);
    }

    private render(): void {
        if (this.stopped) return;
        const symbol = this.symbol();
        if (!symbol) {
            this.ctx.emit({ series: [] });
            return;
        }
        const bars = this.ctx.bars();
        const aligned = alignCloses(bars, this.other);
        let values: number[];
        let title: string;
        if (this.kind === 'compare') {
            values = rebased(bars, aligned, anchorIndex(bars, aligned, this.viewFrom));
            title = tickerOf(symbol);
        } else {
            const mode: SpreadMode = String(this.inputs.mode ?? 'Ratio').toLowerCase() === 'difference' ? 'difference' : 'ratio';
            values = spreadValues(bars, aligned, mode);
            title = `${mode === 'ratio' ? 'Ratio' : 'Spread'} ${tickerOf(this.ctx.symbol)}/${tickerOf(symbol)}`;
        }
        const points: SeriesPoint[] = bars.map((bar, i) => ({ time: bar.time, value: Number.isFinite(values[i]!) ? values[i]! : null }));
        const color = typeof this.inputs.color === 'string' && this.inputs.color !== '' ? this.inputs.color : DEFAULT_COLOR;
        const width = typeof this.inputs.width === 'number' && this.inputs.width > 0 ? this.inputs.width : 2;
        const series: SeriesSpec = {
            id: stableSeriesId({ instanceId: this.kind, kind: 'line', title: 'line', ordinal: 0 }),
            title,
            paneId: '', // stamped by the orchestrator
            kind: 'line',
            points,
            style: { color, width, lineStyle: 'solid' },
        };
        this.ctx.emit({ series: [series] });
    }
}

export const compareDescriptor: NativeIndicatorDescriptor = {
    type: 'compare',
    title: 'Compare symbol',
    shortTitle: 'Compare',
    paneHint: 'price',
    overlay: true,
    reactsToViewport: true,
    vendor: 'vela',
    multiInstance: true,
    inputsSchema: () => [symbolInput(), colorInput(), widthInput()],
    defaultInputs: () => ({ symbol: '', color: DEFAULT_COLOR, width: 2 }),
    create: () => new OtherSymbolIndicator('compare'),
};

export const spreadDescriptor: NativeIndicatorDescriptor = {
    type: 'spread',
    title: 'Spread / ratio',
    shortTitle: 'Spread',
    paneHint: 'new',
    overlay: false,
    vendor: 'vela',
    multiInstance: true,
    inputsSchema: () => [symbolInput(), modeInput(), colorInput(), widthInput()],
    defaultInputs: () => ({ symbol: '', mode: 'Ratio', color: DEFAULT_COLOR, width: 2 }),
    create: () => new OtherSymbolIndicator('spread'),
};
