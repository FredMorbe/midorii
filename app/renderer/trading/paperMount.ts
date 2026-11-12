import { applyThemeTokens, ensureUIHost } from '../../../src/ui';
import { resolveTheme } from '../../../src/core/theme';
import type { ChartCell, VelaWorkspace } from '../../../src/workspace';
import { mountQuickPanel, type QuickPanel } from '../replay/quickPanel';
import { mountTradeDock } from '../replay/tradeDock';
import { mountTradeSidebar, type TradeSidebar } from '../replay/tradeSidebar';
import { makeOverlayCard, type OverlayCard } from '../replay/overlayCards';
import { forEachCell } from '../shell/eachCell';
import { VisualsFanOut, type AccountCharts } from './accountCharts';
import { wirePositionStyle } from './positionStyleSettings';
import { wireOrderEntry } from '../replay/replayOrders';
import { wirePendingMenu } from '../replay/chartPending';
import { wireTradePreview } from '../replay/chartPreview';
import { wirePositionLevels } from '../replay/replayLevels';
import type { PaperController } from './PaperController';
import type { PaperAccount } from './PaperAccount';
import { catchUpLabel, fetchGapBars } from './paperCatchUp';
import { bracketsOf, riskOf, type PaperSettings } from './paperSettings';
import { sessionState } from './riskLimits';
import { flattenAll, wireProp } from './propBand';
import { PAPER_ACCOUNT_KEY } from './accountRules';
import { installTradeHotkeys, loadHotkeys } from './hotkeys';
import { mountAccountBand, type AccountBand } from './accountBand';
import { tickSizeOf } from '../alerts/symbolTick';
import { formatMoney, formatPercent } from '../format';
import type { CapitalDealing } from '../providers/CapitalProvider';
import type { ProjectXDealing } from '../providers/ProjectXProvider';
import type { ThemeName, VelaTheme } from '../../../src';

/**
 * The trading half of the chart, put on and taken off again.
 *
 * Everything here already exists: the account band, the quick panel, the ticket and
 * the dock are the ones every traded chart gets, and so are the two ways in through the
 * chart itself — a block right-clicked into an order, and a stop dragged to a new level.
 * What is new is only that they can be taken away again, because the chart's normal state
 * is a chart. Nothing of this is mounted while the Trade menu says Just Watching, and
 * `unmount` leaves the chart exactly as it found it.
 *
 * Several markets
 * ---------------
 * The account trades every market a chart shows (see PaperAccount.ts). Each market is a leg with
 * its own indicator, its own feed and its own dealing rules; everything a chart does — its
 * levels, its clicks and drags, its preview — goes to the leg of the market THAT chart shows.
 * What there is one of — the ticket, the dock, the card — reads the whole account, and the ticket
 * and the quick panel are pointed at the market of the focused chart.
 *
 * The feed
 * --------
 * The chart is already subscribed to the market; the account listens to the same
 * `bar` event rather than opening a second subscription of its own, so the price a
 * fill happens at is the price on the screen at that moment, by construction. A market the
 * account holds something in but no chart shows is the one exception: its stops would otherwise
 * stand still while the market moved, so it opens a feed of its own for as long as it holds.
 *
 * What the market brings with it
 * ------------------------------
 * On a market whose provider states more than candles, the account takes that too: a futures
 * contract's point value and size grid, the two sides of a quote a market order then fills
 * at, and the prints the tape shows. The same feeds the venue accounts read, so paper trading
 * a contract is paper trading it at the contract's own terms.
 */

/** How far back a fresh leg looks for a price to stand on. Two bars of the finest
 *  timeframe there is — enough to find the last one even on a quiet market. */
const SEED_LOOKBACK_MS = 5 * 60_000;

export interface PaperMountOptions {
    workspace: VelaWorkspace;
    /** The column: the chart row on top, the dock beneath it. */
    stack: HTMLElement;
    /** The row: the chart, and the ticket beside it. */
    main: HTMLElement;
    account: PaperAccount;
    /** The charts the account is traded on — where its levels are drawn and its gestures taken. */
    charts: AccountCharts;
    /** Read fresh at every order — the settings dialog changes them mid-session. */
    settings: () => PaperSettings;
    /**
     * Put edited settings back where they came from.
     *
     * The ticket's quick sizes are settings a person edits from the ticket rather than from
     * the dialog — they are the sizes this account is traded in, and the place that question
     * comes up is while sizing a trade. They still belong in the one settings record, so
     * they go back through the one door that writes it.
     */
    onSettings: (next: PaperSettings) => void;
    /** The app's theme, for the one panel that sits OUTSIDE the chart's own root. */
    theme: ThemeName | VelaTheme;
}

export interface PaperMount {
    /** The latest room before the configured maximum-loss floor, or null with no floor. */
    mllRoom(): number | null;
    /** Fetch and play whatever each market missed, and put it on a price. Safe to call
     *  again — it re-reads where each stands every time. */
    resync(): Promise<void>;
    /** Take the trading UI off the chart. The account itself is untouched. */
    unmount(): void;
}

/** Run an engine call and put its refusal in front of the person who asked for it. The
 *  engine's message is the message; there is nothing better to say than what it said. */
function guarded(ws: VelaWorkspace, run: () => void): void {
    try {
        run();
    } catch (err: unknown) {
        ws.toast(err instanceof Error ? err.message : String(err), 'error');
    }
}

/** Everything that belongs to one market of the account. */
interface LegWire {
    leg: PaperController;
    visuals: VisualsFanOut;
    /** What the market brings with it — see the note at the top of this file. */
    market: { tick: number | null; tape: boolean };
    releaseMarket: (() => void) | null;
    /** Bumped on every wiring, so an answer that arrives after the market moved is dropped. */
    wiring: number;
    /** The feed this leg opened itself, while a chart does not show its market. */
    hold: (() => void) | null;
}

/**
 * Put the trading UI on the live charts and wire it to `account`.
 *
 * Mirrors what `replayBootstrap.mount` does for a replay, minus the transport and the
 * provider — the same panels, the same wirings, the same guard around every call into
 * the engine.
 */
export function mountPaperTrading(opts: PaperMountOptions): PaperMount {
    const { workspace: ws, account, charts } = opts;
    const off: Array<() => void> = [];
    const wires = new Map<PaperController, LegWire>();
    /** The chart the card and the ticket are pointed at — the focused one that can be traded. */
    let anchorCell: ChartCell | null = null;
    let ticketLeg: PaperController | null = null;
    let disposed = false;

    /* How the positions look is one setting for every market, so it is pushed through a sink of
     * its own that each leg's visuals join as they appear. */
    const styleSink = new VisualsFanOut();
    const styling = wirePositionStyle({ workspace: ws, indicator: styleSink });
    off.push(styling.dispose);

    /** The leg trading `symbol`, with everything it needs wired the first time it is seen. */
    function legOf(symbol: string): PaperController {
        const leg = account.legFor(symbol);
        wireLeg(leg);
        return leg;
    }

    function wireLeg(leg: PaperController): LegWire {
        const known = wires.get(leg);
        if (known) return known;
        const wire: LegWire = {
            leg,
            visuals: new VisualsFanOut(),
            market: { tick: tickSizeOf(leg.symbol) ?? null, tape: false },
            releaseMarket: null,
            wiring: 0,
            hold: null,
        };
        wires.set(leg, wire);
        leg.attachIndicator(wire.visuals);
        styleSink.add(wire.visuals);
        void wireMarket(wire);
        void resync(leg);
        return wire;
    }

    /** The market of the focused chart, or null when no chart that can be traded has the focus. */
    const current = (): PaperController | null => {
        const symbol = anchorCell?.chart.market.symbol;
        return symbol ? legOf(symbol) : null;
    };

    const need = (): PaperController => {
        const leg = current();
        if (!leg) throw new Error('Focus a chart on a market to trade it.');
        return leg;
    };

    const tickOf = (leg: PaperController): number | null => wires.get(leg)?.market.tick ?? tickSizeOf(leg.symbol) ?? null;

    // ── the ticket beside the plot ───────────────────────────────────────

    /* The paper account's own limits — the same rule set a funded account carries, under its
     * own key. Worth having here rather than only on a venue: a floor practised on paper is a
     * floor somebody has already met once before it costs them an account. See propBand.ts. */
    const prop = wireProp({
        account: PAPER_ACCOUNT_KEY,
        name: 'Paper account',
        host: ws.root,
        equity: () => account.account().equity,
        /* The engine has watched every tick since the account opened, so it states the open
         * result itself — this is the one account here that never has to be asked twice. */
        openPnl: () => account.account().open ?? 0,
        history: () => account.history(),
        flatten: () => flattenAll(account),
        notify: (message, kind) => ws.toast(message, kind),
        onChange: () => paint(),
    });

    /**
     * The limits, applied at the one place every way in passes through.
     *
     * Each gesture that can place an order calls this rather than carrying its own copy of
     * the rule. It refuses by throwing, so the reason reaches the person the same way every
     * other refusal does — and it only ever refuses an order that would ADD to what is on, in
     * the market the order is for.
     */
    const guardLimits = (leg: PaperController, spec: { side: 'buy' | 'sell'; size: number }): void => {
        prop.guard({ net: leg.broker.netSize, side: spec.side, size: spec.size });
    };

    /* A reverse leaves the size where it was, so the guard above would wave it through — but it
     * ends one trade and opens another, and a session that may not open trades may not do that. */
    const guardReverse = (id: number): void => {
        const held = account.ownerOfPosition(id)?.broker.positionById(id)?.size ?? 0;
        prop.guard({ net: 0, side: held > 0 ? 'sell' : 'buy', size: Math.abs(held) });
    };

    const sidebar = mountTradeSidebar(opts.main, {
        account: () => {
            const leg = current();
            return {
                equity: account.equity(),
                price: leg?.price() ?? 0,
                // What a point is worth and the grid a size lands on, where the market states them.
                pointValue: leg?.pointValue() ?? 1,
                ...(leg?.dealingRules() ?? {}),
                ...(leg?.quote() ?? {}),
            };
        },
        counts: () => {
            const book = account.book();
            return { positions: book.positions.length, orders: book.orders.length };
        },
        actions: {
            order: (spec) => guarded(ws, () => { const leg = need(); guardLimits(leg, spec); leg.order(spec); }),
            flatten: () => guarded(ws, () => account.flatten()),
            cancelAll: () => guarded(ws, () => account.cancelAll()),
        },
        risk: riskOf(opts.settings()),
        // What this account has already done, in the panel's own History tab.
        history: () => account.history(),
        /* All three read the settings fresh rather than a copy taken at wiring time: they are
         * changed from the dialog while the panel is on screen, and a ticket bracketed by
         * last week's numbers is worse than one bracketed by none. */
        brackets: () => bracketsOf(opts.settings()),
        // The contract's own increment where the market states one; else warm from the
        // chart's metadata — see alerts/symbolTick.ts.
        tick: () => {
            const leg = current();
            return leg ? tickOf(leg) : null;
        },
        /* The ladder, off the same engine the ticket reads, so the two cannot disagree about
         * what is open. It shows the market the ticket is pointed at. */
        ladder: {
            quote: () => current()?.quote() ?? null,
            positions: () => (current()?.broker.positions ?? []).map((p) => ({
                size: p.size, entryPrice: p.entryPrice, stopLoss: p.stopLoss, takeProfit: p.takeProfit,
            })),
            orders: () => (current()?.book().orders ?? [])
                .filter((o) => o.price != null)
                .map((o) => ({ id: o.id, side: o.side, price: o.price!, size: o.size })),
            cancelOrder: (id) => guarded(ws, () => account.cancelOrder(id)),
        },
        // Only on a market whose feed carries prints — asked again as the account moves.
        tape: () => {
            const leg = current();
            return leg != null && (wires.get(leg)?.market.tape ?? false);
        },
        quickSizes: () => opts.settings().quickSizes,
        onQuickSizes: (next) => opts.onSettings({ ...opts.settings(), quickSizes: next }),
        sizing: () => opts.settings().sizingMode,
        onSizing: (next) => opts.onSettings({ ...opts.settings(), sizingMode: next }),
    });
    /* Its own kit host: the ticket is a sibling of the chart rather than a child, so the
     * theme variables the workspace writes on its own root do not reach it. */
    ensureUIHost(sidebar.el, resolveTheme(opts.theme));
    off.push(forEachCell(ws, (cell) => cell.chart.on('theme:changed', (theme) => applyThemeTokens(sidebar.el, theme))));

    // ── the two ways in through the chart itself ─────────────────────────
    /**
     * The ticket, as one chart sees it: the preview is of the trade being set up, which is in
     * ONE market, so a chart of any other market is shown none — a stop drawn at a price of a
     * different instrument is a lie about both.
     */
    const ticketFor = (leg: PaperController): TradeSidebar => ({
        ...sidebar,
        onPreview: (listener) => sidebar.onPreview((preview) => listener(current() === leg ? preview : null)),
        dragLevel: (level, price) => sidebar.dragLevel(level, price),
        dismissPreview: () => sidebar.dismissPreview(),
    });

    /* On every chart that shows a market: any of them takes an order, and draws the levels of
     * the leg for that market. */
    off.push(charts.each(
        (_key, cell) => wireLeg(account.legFor(cell.chart.market.symbol ?? '')).visuals,
        (cell, indicator) => {
            const chart = cell.chart;
            const leg = legOf(chart.market.symbol ?? '');
            const wiresOf = [
                wireOrderEntry({
                    chart,
                    controller: leg,
                    host: ws.root,
                    // The dialog's risk settings, not the ticket's own copy: one account, one answer
                    // to "how much may this lose", whichever hand places the trade.
                    risk: () => riskOf(opts.settings()),
                    beforeOrder: (spec) => guardLimits(leg, spec),
                    notify: (message, kind) => ws.toast(message, kind === 'error' ? 'error' : 'info'),
                }),
                // A level right-clicked on the plot, onto the ticket as a resting order — not sent.
                wirePendingMenu({
                    chart,
                    sidebar,
                    price: () => leg.price(),
                    tick: () => tickOf(leg),
                }),
                // The ticket drawn where it would trade, before it is sent — see chartPreview.ts.
                wireTradePreview({
                    chart,
                    indicator,
                    sidebar: ticketFor(leg),
                    notify: (message, kind) => ws.toast(message, kind === 'error' ? 'error' : 'info'),
                }),
                wirePositionLevels({
                    chart,
                    controller: leg,
                    notify: (message, kind) => ws.toast(message, kind === 'error' ? 'error' : 'info'),
                }),
            ];
            return () => { for (const dispose of wiresOf) dispose(); };
        },
    ));

    const guard = (run: () => void) => (): void => guarded(ws, run);

    /* The keys — the same ones every traded chart here answers to. Break-even is the engine's
     * own, applied to whichever position is open. */
    off.push(installTradeHotkeys({
        root: ws.root,
        bindings: loadHotkeys,
        actions: {
            buy: () => sidebar.submit('buy'),
            sell: () => sidebar.submit('sell'),
            flatten: () => guard(() => account.flatten())(),
            cancelAll: () => guard(() => account.cancelAll())(),
            breakEven: () => guard(() => { account.breakEven(); })(),
        },
    }));

    // ── the account, on the chart and under it ───────────────────────────
    const figures = () => account.account();
    const tone = (value: number | null): 'up' | 'down' | null => (value == null || value === 0 ? null : value > 0 ? 'up' : 'down');
    let band: AccountBand | null = null;
    let quick: QuickPanel | null = null;
    /* The card and the quick panel sit on ONE chart — the anchor — and follow the focus between
     * the charts that can be traded. Several copies would show the same account twice. */
    const mountCard = (cell: HTMLElement): (() => void) => {
        const mounted = mountAccountBand({
            cell,
            // The words the Trade menu uses for this broker, so the band and the menu agree.
            badge: 'Paper',
            badgeTitle: 'Real prices, an account of this app\'s own. Nothing here reaches a venue.',
            live: false,
            storageKey: 'midorii-band-paper',
            columns: [
                {
                    id: 'equity',
                    label: 'Equity',
                    title: 'The balance plus what is open, marked to the last price.',
                    value: () => formatMoney(figures().equity),
                },
                {
                    id: 'open',
                    label: 'Open P/L',
                    title: 'What is open is worth right now, before the costs of getting out.',
                    value: () => {
                        const open = figures().open;
                        return open == null ? '—' : formatMoney(open);
                    },
                    tone: () => tone(figures().open),
                },
                {
                    id: 'risk',
                    label: 'At risk',
                    title: 'What every stop would come to if all of them filled. A position without a stop '
                        + 'is counted beside it, not as zero.',
                    value: () => {
                        const { risk, unprotected } = figures();
                        const text = risk == null ? '—' : formatMoney(risk);
                        return unprotected > 0 ? `${text} · ${unprotected} without stop` : text;
                    },
                },
                {
                    id: 'session',
                    label: 'Session',
                    title: 'What this session has realised — the same day the session limits are measured over.',
                    value: () => formatMoney(sessionState(account.history()).realised),
                    tone: () => tone(sessionState(account.history()).realised),
                    optional: true,
                },
                {
                    id: 'cash',
                    label: 'Cash',
                    title: 'Realised only: what would still be there if everything open closed at nothing.',
                    value: () => formatMoney(figures().cash),
                    optional: true,
                },
                {
                    id: 'return',
                    label: 'Return',
                    title: 'Equity against the balance the account started with.',
                    value: () => formatPercent(figures().returnPct, 2, true),
                    tone: () => tone(figures().returnPct),
                    optional: true,
                },
                ...prop.columns,
            ],
            actions: [
                prop.action,
                {
                    id: 'break-even',
                    label: 'Break-even',
                    refusal: () => {
                        const position = account.position;
                        return position ? account.breakEvenRefusal(position) : 'Nothing is open.';
                    },
                    title: () => 'Move the stop to where the trade comes out flat after costs.',
                    run: () => guarded(ws, () => { account.breakEven(); }),
                },
                {
                    id: 'flatten',
                    label: 'Close all',
                    tone: 'danger' as const,
                    arm: { label: 'Close all — press again' },
                    refusal: () => (account.openCount === 0 ? 'Nothing is open.' : null),
                    title: () => {
                        const open = account.openCount;
                        return `Close ${open} open ${open === 1 ? 'position' : 'positions'} at market, now.`;
                    },
                    run: () => guarded(ws, () => account.flatten()),
                },
            ],
            staleNote: () => null,
        });
        band = mounted;
        /* Draggable, closable and switchable off, in the seat the account card has always had. */
        const overlay: OverlayCard = makeOverlayCard(cell, mounted.el, {
            id: 'account',
            onVisibility: () => quick?.reflow(),
        });
        const panel = mountQuickPanel(cell, {
            price: () => current()?.price() ?? 0,
            order: (spec) => guarded(ws, () => { const leg = need(); guardLimits(leg, spec); leg.order(spec); }),
            tick: () => {
                const leg = current();
                return leg ? tickOf(leg) : null;
            },
            pointValue: () => current()?.pointValue() ?? 1,
            anchor: () => (mounted.el.hidden ? null : mounted.el),
        });
        quick = panel;
        return () => {
            overlay.destroy();
            panel.destroy();
            mounted.destroy();
            if (band === mounted) band = null;
            if (quick === panel) quick = null;
        };
    };

    const dock = mountTradeDock(opts.stack, {
        closePosition: (id) => guard(() => account.closeOne(id))(),
        closePart: (size, id) => guard(() => account.closePart(size, id))(),
        reverse: (id) => guard(() => { guardReverse(id); account.reverse(id); })(),
        breakEven: (id) => guard(() => { account.breakEven(id); })(),
        protect: (levels, id) => guard(() => account.protect(levels, id))(),
        setTrailing: (distance, id) => guard(() => account.setTrailing(distance, id))(),
        cancelOrder: (id) => guard(() => { account.cancelOrder(id); })(),
        cancelAll: () => guard(() => account.cancelAll())(),
        flatten: () => guard(() => account.flatten())(),
    });

    function paint(): void {
        if (disposed) return;
        /* One reading, before the figures that show it — see the note in propBand.ts. */
        prop.read();
        band?.refresh();
        /* The account's own line goes in with the book: what is open is only half of what a
         * person needs to see, and the other half — what this account has actually done —
         * has nowhere else to be read while it is still running. */
        dock.render(account.book(), { stats: account.stats() });
        // The ticket sizes against equity and the last price, so it moves with every tick.
        sidebar.refresh();
        quick?.refresh();
        syncHolds();
        /* Last, so whatever is about to be closed was on the screen first. Does nothing unless
         * this account is set to close out on a breach. */
        prop.enforce();
    }
    account.onAccountChange = paint;
    paint();
    off.push(charts.onAnchor((anchor) => {
        anchorCell = anchor;
        const leg = current();
        // The ladder and the tape belong to one market; a new market starts them over.
        if (leg !== ticketLeg) {
            ticketLeg = leg;
            sidebar.resetMarket();
        }
        const release = mountCard(anchor.host);
        paint();
        return () => {
            release();
            anchorCell = null;
        };
    }));

    // ── what the market brings with it ───────────────────────────────────

    /**
     * Take on the dealing rules, the quote and the prints of one market of the account.
     *
     * Each is best effort: a feed that will not open leaves the account trading the way it
     * does on a coin pair — last price, simulated spread, no tape. What is NOT best effort is
     * the point value: an account holding something refuses a new one, and says so.
     */
    async function wireMarket(wire: LegWire): Promise<void> {
        const { leg } = wire;
        const token = ++wire.wiring;
        wire.releaseMarket?.();
        wire.releaseMarket = null;
        wire.market = { tick: tickSizeOf(leg.symbol) ?? null, tape: false };
        if (current() === leg) sidebar.resetMarket();

        const resolved = ws.chart.data.resolve(leg.symbol);
        const info = await ws.chart.data.symbolInfo(leg.symbol).catch(() => undefined);
        if (token !== wire.wiring || disposed) return;
        const dealing = (info as { dealing?: unknown } | undefined)?.dealing;
        const release: Array<() => void> = [];
        wire.releaseMarket = () => { for (const dispose of release.splice(0)) dispose(); };

        try {
            if (resolved?.provider === 'projectx' && (dealing as ProjectXDealing | undefined)?.contractId) {
                const contract = dealing as ProjectXDealing;
                leg.setInstrument({
                    pointValue: contract.tickValue / contract.tickSize,
                    sizeStep: contract.sizeStep,
                    minSize: contract.minSize,
                });
                wire.market = { tick: contract.tickSize, tape: true };
                release.push(subscribeProjectX(wire, contract.contractId, token));
            } else if (resolved?.provider === 'capital') {
                /* No point value: a CFD unit's result is in the instrument's own currency, and a
                 * paper account has no currency of its own to convert it into — one is what it
                 * has always been measured in here. The size grid is the venue's own. */
                const rules = dealing as CapitalDealing | undefined;
                leg.setInstrument({ sizeStep: rules?.sizeIncrement, minSize: rules?.minSize });
                const provider = ws.chart.data.providerInstance('capital') as
                    { subscribeQuotes?: (t: string, cb: (q: { bid: number; ask: number }) => void) => () => void } | undefined;
                if (typeof provider?.subscribeQuotes === 'function') {
                    release.push(provider.subscribeQuotes(resolved.ticker, (q) => leg.markQuote(q.bid, q.ask)));
                }
            } else {
                leg.setInstrument(null);
            }
        } catch (err: unknown) {
            ws.toast(err instanceof Error ? err.message : String(err), 'error');
        }
        paint();
    }

    /** The contract's quote and prints, from the same gateway hub the ProjectX account reads. */
    function subscribeProjectX(wire: LegWire, contractId: string, token: number): () => void {
        const { leg } = wire;
        const api = window.midori.projectx;
        let quoteId: string | null = null;
        let printId: string | null = null;
        let released = false;
        const offQuote = api.onQuote((payload) => {
            if (payload.subscriptionId === quoteId) leg.markQuote(payload.quote.bid, payload.quote.ask);
        });
        const offPrints = api.onPrints((payload) => {
            if (payload.subscriptionId !== printId || current() !== leg) return;
            sidebar.pushPrints(payload.prints.map((print) => ({
                time: Date.parse(print.timestamp),
                price: print.price,
                size: print.volume,
                // Measured rather than documented: `type` is the side that crossed the spread.
                side: print.type === 1 ? 'sell' as const : 'buy' as const,
            })));
        });
        api.subscribeQuotes({ contractId })
            .then((id) => { if (released || token !== wire.wiring) void api.unsubscribeQuotes(id); else quoteId = id; })
            .catch((err: unknown) => console.warn('[midorii] ProjectX quotes are not available for the paper account', err));
        api.subscribePrints({ contractId })
            .then((id) => { if (released || token !== wire.wiring) void api.unsubscribePrints(id); else printId = id; })
            .catch((err: unknown) => console.warn('[midorii] ProjectX prints are not available for the paper account', err));
        return () => {
            released = true;
            offQuote();
            offPrints();
            if (quoteId) void api.unsubscribeQuotes(quoteId);
            if (printId) void api.unsubscribePrints(printId);
        };
    }

    // ── the feed ─────────────────────────────────────────────────────────
    /* One chart feeds each market — see accountCharts.ts. A feed brings its own bar clock: the
     * bars of an hourly chart open on the hour, and the account may be standing on a minute bar
     * from a catch-up or on a bar of whatever chart fed it last. An update for an earlier bar is
     * taken for a correction and dropped, so the account starts the bar over rather than going
     * quiet until the new clock catches up with the old. */
    off.push(charts.onFeed((cell) => {
        const leg = legOf(cell.chart.market.symbol ?? '');
        stopHold(wires.get(leg));
        leg.rebase();
        return cell.chart.on('bar', (bar) => {
            leg.onBar(bar);
            // The ladder's session volume, folded from the same stream the chart is drawn from.
            if (current() === leg) sidebar.markVolume(bar.close, bar.volume ?? 0);
        });
    }));

    /**
     * Give a market that holds something a feed of its own while no chart shows it.
     *
     * Without one its stops and targets would stand still while the market moved — a paper
     * account that cannot lose money it should have lost. The feed is the provider's own, the
     * same one a bot trades on, at the finest bar it offers.
     */
    function syncHolds(): void {
        const shown = new Set(charts.instruments());
        for (const leg of account.legs()) {
            const wire = wireLeg(leg);
            const needed = !leg.session.isIdle && !shown.has(account.keyOf(leg.symbol));
            if (needed && !wire.hold) wire.hold = startHold(leg);
            else if (!needed) stopHold(wire);
        }
    }

    function startHold(leg: PaperController): () => void {
        const resolved = ws.chart.data.resolve(leg.symbol);
        const provider = resolved ? ws.chart.data.providerInstance(resolved.provider) : undefined;
        if (!resolved || !provider?.subscribe) {
            ws.toast(
                `${leg.symbol} has no live feed, and no chart shows it — its stops will not move until one does.`,
                'error',
            );
            return () => undefined;
        }
        const supported = provider.info?.().supportedTimeframes;
        const timeframe = !supported?.length || supported.includes('1') ? '1' : supported[0]!;
        // A new feed has its own bar clock; the next update marks rather than plays.
        leg.rebase();
        return provider.subscribe(resolved.ticker, timeframe, (bar) => leg.onBar(bar));
    }

    function stopHold(wire: LegWire | undefined): void {
        wire?.hold?.();
        if (wire) wire.hold = null;
    }

    /** Where a market should be caught up from — the bar it stood in, or just
     *  enough of the recent past to find a price for a fresh one. */
    async function resync(leg: PaperController): Promise<void> {
        const from = leg.session.barTime ?? Date.now() - SEED_LOOKBACK_MS;
        const before = leg.broker.trades.length;
        try {
            const { bars, timeframe } = await fetchGapBars(ws.chart, leg.symbol, from);
            if (bars.length === 0 || disposed) return;
            const played = leg.catchUp(bars);
            // It now stands on the last bar of the gap, which is on the gap's own clock.
            leg.rebase();
            const closed = leg.broker.trades.length - before;
            /* Only worth saying when something actually happened while nobody was
             * looking. A fresh account catching up on the last two minutes has nothing
             * to report and should not open with a notice. */
            if (closed > 0) {
                ws.toast(
                    `Paper account caught up over ${played} ${catchUpLabel(timeframe)} bars on ${leg.symbol} — `
                    + `${closed} ${closed === 1 ? 'position' : 'positions'} closed while the app was away.`,
                    'info',
                );
            }
        } catch (err: unknown) {
            // An account that cannot be caught up still trades from here on; what it must
            // not do is pretend the gap did not happen.
            ws.toast(
                `Paper account could not be caught up on ${leg.symbol}: ${err instanceof Error ? err.message : String(err)}`,
                'error',
            );
        }
    }

    /* A chart changing its timeframe only costs its market the bar the account was standing in —
     * and only when it is the chart that feeds it. A chart changing its SYMBOL needs nothing
     * here: it simply answers for another market now. */
    off.push(forEachCell(ws, (cell) => cell.chart.on('market:changed', ({ symbol, prev }) => {
        if (symbol !== prev.symbol) return;
        const key = charts.instrumentOf(cell);
        if (key != null && charts.feed(key) === cell) account.find(symbol)?.rebase();
    })));

    for (const leg of account.legs()) wireLeg(leg);

    return {
        mllRoom: () => prop.last().room,
        resync: async () => { await Promise.all(account.legs().map((leg) => resync(leg))); },
        unmount(): void {
            disposed = true;
            for (const wire of wires.values()) {
                wire.wiring += 1;
                wire.releaseMarket?.();
                wire.releaseMarket = null;
                stopHold(wire);
            }
            for (const dispose of off.splice(0)) dispose();
            account.onAccountChange = null;
            sidebar.dispose();
            sidebar.el.remove();
            dock.el.remove();
        },
    };
}
