import { Vela, timeframeToMs, type IndicatorHandle, type VelaTheme } from '../../../src';
import { injectStyles } from '../../../src/ui';
import type { MidoriBar, MidoriTrade } from '../midori';
import { formatPrice, formatSignedMoney, formatSize, formatWhen } from '../format';
import { button } from '../runs/runViews';
import {
    BACKTEST_TRADE_REVIEW_TYPE, TRADE_INPUT, adjacentTradeIndex, registerBacktestTradeReview, tradeReviewRange,
} from '../backtest/tradeReview';

/**
 * One trade of a stored run, on the candles it was taken on.
 *
 * The same picture the Backtest tab draws for a fresh result — entry, exit, stop, target and
 * what it came to — for any run on the shelf, a hand-traded replay included. What is read from
 * disk is the candles around the trade; the trade itself is stored with the run, so the chart
 * never has to guess where it opened.
 *
 * Only a window of candles is loaded, around the trade selected, and the chart is built again
 * for the next one. A run can span a year of one-minute bars, and loading every bar to look at
 * one trade is the cost of a feature nobody opened.
 */

const STYLE_ID = 'midorii-run-review';
const CSS = `
.midorii-run-review { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; gap: 8px; }
.midorii-run-review-bar { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.midorii-run-review-copy { min-width: 0; }
.midorii-run-review-copy b { display: block; color: var(--vela-fg-bright); font-weight: 600; }
.midorii-run-review-copy span { display: block; color: var(--vela-fg-muted); font-size: 12px; }
.midorii-run-review-net { font-weight: 650; font-variant-numeric: tabular-nums; }
.midorii-run-review-net[data-sign='positive'] { color: var(--vela-up); }
.midorii-run-review-net[data-sign='negative'] { color: var(--vela-down); }
.midorii-run-review-nav { display: inline-flex; gap: 8px; align-items: center; }
.midorii-run-review-chart { position: relative; flex: 1 1 auto; min-height: 150px; border: 1px solid var(--vela-border-faint); border-radius: var(--vela-radius-sm); overflow: hidden; }
.midorii-run-review-chart[data-empty] { display: flex; align-items: center; justify-content: center; padding: 16px; color: var(--vela-fg-muted); text-align: center; }
`;

/** Candles of context before a trade's entry and after its exit, loaded beyond what is framed. */
const CONTEXT_BEFORE = 120;
const CONTEXT_AFTER = 40;

export interface RunReview {
    el: HTMLElement;
    /** Show trade `index`. Out of range is clamped. */
    select(index: number): void;
    setTheme(theme: VelaTheme): void;
    /** Take the chart down. The element stays as it is for whoever removes it. */
    dispose(): void;
}

export function mountRunReview(
    doc: Document,
    opts: {
        symbol: string;
        timeframe: string;
        trades: readonly MidoriTrade[];
        theme: () => VelaTheme;
        /** Told which trade is on show, so a list beside it can follow. */
        onSelect?: (index: number) => void;
    },
): RunReview {
    injectStyles(STYLE_ID, CSS, doc);
    const { trades } = opts;
    const step = timeframeToMs(opts.timeframe);

    const el = doc.createElement('section');
    el.className = 'midorii-run-review';
    const bar = doc.createElement('div');
    bar.className = 'midorii-run-review-bar';
    const copy = doc.createElement('div');
    copy.className = 'midorii-run-review-copy';
    const title = doc.createElement('b');
    const detail = doc.createElement('span');
    copy.append(title, detail);
    const net = doc.createElement('span');
    net.className = 'midorii-run-review-net';
    const nav = doc.createElement('div');
    nav.className = 'midorii-run-review-nav';
    const previous = button('Previous trade');
    const next = button('Next trade', 'primary');
    nav.append(net, previous, next);
    bar.append(copy, nav);
    const host = doc.createElement('div');
    host.className = 'midorii-run-review-chart';
    host.setAttribute('role', 'img');
    el.append(bar, host);

    let chart: Vela | null = null;
    let indicator: IndicatorHandle | null = null;
    let generation = 0;
    let selected = 0;
    let started = false;

    let observer: ResizeObserver | null = null;
    let disposed = false;

    const closeChart = (): void => {
        generation += 1;
        indicator = null;
        chart?.destroy();
        chart = null;
    };

    const say = (text: string): void => {
        closeChart();
        host.replaceChildren();
        host.dataset.empty = '1';
        host.textContent = text;
    };

    async function show(index: number): Promise<void> {
        const mine = ++generation;
        const trade = trades[index]!;
        const range = tradeReviewRange(trade, step);
        let bars: MidoriBar[];
        try {
            bars = await window.midori.data.bars({
                symbol: opts.symbol,
                timeframe: opts.timeframe,
                from: range.from - CONTEXT_BEFORE * step,
                to: range.to + CONTEXT_AFTER * step,
                dropIncomplete: false,
            });
        } catch (err: unknown) {
            if (mine === generation) say(`The candles could not be read: ${err instanceof Error ? err.message : String(err)}`);
            return;
        }
        if (mine !== generation) return;
        if (bars.length === 0) {
            say(`No ${opts.symbol} candles are stored around this trade, so there is nothing to draw it on. `
                + 'Download that market in the Chart tab to review its trades here.');
            return;
        }

        chart?.destroy();
        chart = null;
        indicator = null;
        host.replaceChildren();
        delete host.dataset.empty;
        registerBacktestTradeReview();
        const created = new Vela(host, {
            symbol: opts.symbol,
            timeframe: opts.timeframe,
            data: bars,
            visibleRange: range,
            live: false,
            theme: opts.theme(),
            height: '100%',
            drawings: false,
            volume: false,
            currentPriceLine: false,
            animations: false,
        });
        chart = created;
        try {
            await created.ready();
            if (mine !== generation) {
                created.destroy();
                if (chart === created) chart = null;
                return;
            }
            indicator = created.addNativeIndicator(BACKTEST_TRADE_REVIEW_TYPE, {
                inputs: { [TRADE_INPUT]: JSON.stringify(trade) },
            });
        } catch (err: unknown) {
            created.destroy();
            if (chart === created) chart = null;
            if (mine === generation) say(`Could not open the trade chart: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    function select(requested: number): void {
        if (trades.length === 0) return;
        selected = Math.max(0, Math.min(trades.length - 1, requested));
        const trade = trades[selected]!;
        const side = trade.side === 'long' ? 'Long' : 'Short';
        title.textContent = `Trade ${selected + 1} of ${trades.length} · ${side} ${formatSize(trade.size)} · `
            + `${formatPrice(trade.entryPrice)} → ${formatPrice(trade.exitPrice)}`;
        detail.textContent = `${formatWhen(trade.openedAt)} → ${formatWhen(trade.closedAt)} UTC`;
        net.textContent = formatSignedMoney(trade.netPnl);
        if (trade.netPnl > 0) net.dataset.sign = 'positive';
        else if (trade.netPnl < 0) net.dataset.sign = 'negative';
        else delete net.dataset.sign;
        previous.disabled = selected === 0;
        next.disabled = selected === trades.length - 1;
        host.setAttribute('aria-label', `${side} trade ${selected + 1} of ${trades.length}, net ${formatSignedMoney(trade.netPnl)}`);
        opts.onSelect?.(selected);
        // Once the panel has a size: a chart built into a box that has none is built at zero.
        if (started) void show(selected);
    }

    previous.onclick = () => select(adjacentTradeIndex(selected, trades.length, -1));
    next.onclick = () => select(adjacentTradeIndex(selected, trades.length, 1));

    if (trades.length === 0) {
        host.dataset.empty = '1';
        host.textContent = 'This run took no trades, so there is nothing to review.';
        previous.disabled = true;
        next.disabled = true;
    } else {
        select(0);
        observer = new ResizeObserver(() => {
            if (disposed || started || host.clientWidth === 0 || host.clientHeight === 0) return;
            started = true;
            observer?.disconnect();
            void show(selected);
        });
        observer.observe(host);
    }

    return {
        el,
        select,
        setTheme: (theme) => chart?.setTheme(theme),
        dispose() {
            disposed = true;
            observer?.disconnect();
            closeChart();
        },
    };
}
