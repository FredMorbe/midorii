import type { Vela, VelaTheme } from '../../../src';
import { applyThemeTokens, ensureUIHost } from '../../../src/ui';
import { VelaWorkspace, type ChartCell } from '../../../src/workspace';
import { barIndexAt } from '../../../shared/engine/replaySession.js';
import type { ReplayBar } from '../../../shared/engine/replaySession.js';
import { BRAND } from '../about/brand';
import { LocalArchiveProvider } from '../providers/LocalArchiveProvider';
import { ReplayController, type ReplayGrid } from './ReplayController';
import { ReplayProvider } from './ReplayProvider';
import { mountAccountStrip } from './accountStrip';
import { mountQuickPanel } from './quickPanel';
import { mountTradeDock } from './tradeDock';
import { mountTradeSidebar } from './tradeSidebar';
import type { TradeSidebar } from './tradeSidebar';
import { setActiveReplay, type LeaveHandler } from './replayActions';
import { mountTransport } from './replayTransport';
import { wireReplayRules, type ReplayRules } from './replayRules';
import { loadReplayTrading, openBracketDefaults, saveReplayTrading, type ReplayTradingSettings } from './replayTradingSettings';
import { historyStats } from '../trading/accountStats';
import { REPLAY_INDICATOR_TYPE, registerReplayIndicator } from './replayIndicator';
import { wireOrderEntry } from './replayOrders';
import { wirePendingMenu } from './chartPending';
import { wireTradePreview } from './chartPreview';
import { wirePositionLevels } from './replayLevels';
import { wirePositionStyle } from '../trading/positionStyleSettings';
import { wireOverlaySettings } from './overlaySettings';
import { shareChartDoc } from '../shell/sharedChartDoc';
import { loadReplayWindow } from './replayWindow';
import { wireRadialMenu } from '../settings/radialMenuPrefs';
import { bareSymbol, mountMirrors } from './replayMirrors';
import { TickFeed } from './tickFeed';
import type { TapePrint } from './timeAndSales';
import { SPOT_ACCOUNT, accountOptions, type ReplayAccountSettings } from './instrument';

/**
 * The timeframe a fresh replay opens on.
 *
 * The setup dialog deliberately does not ask: a timeframe is not a property of
 * the session, it is how you happen to be looking at it right now, and it can
 * be changed at any point from the chart's own picker without disturbing the
 * account (see {@link ReplayController.retime}). Vela's canonical spelling —
 * a bare number is minutes, so this is one hour.
 */
const DEFAULT_TIMEFRAME = '60';

/** Where a session plays a recording, it opens on minutes: ticks are practised at the ladder,
 *  and an hourly candle growing for an hour is not what anybody watching a tape is reading. */
const TICK_TIMEFRAME = '1';

export interface ReplaySetup {
    symbol: string;
    /** The replay "clock" at session start — nothing at or after this is revealed yet. */
    startTime: number;
    balance?: number;
    /** The recording to play on ticks — a contract name, `NQU6` — or none. */
    ticks?: string | null;
    /** What the session is called in the session list. */
    name?: string;
    /**
     * How the account is kept — costs, what a point is worth, the size grid, hedging. Absent
     * means a spot account, which is what every session was before these were asked.
     */
    account?: ReplayAccountSettings;
}

/** What a mounted replay hands back. (Not the engine's ReplaySession — that's the account.) */
export interface MountedReplay {
    ws: VelaWorkspace;
    provider: ReplayProvider;
    controller: ReplayController;
    /**
     * Take the session down: stop playback, release the chart, the panels and every listener
     * they put on the page. Safe to call once; the handle is of no use afterwards.
     */
    dispose(): void;
}

/**
 * How many charts a replay window shows, the trading one included.
 *
 * Each chart beside it costs a refresh on every step the session takes, and the session is
 * played at up to thirty candles a second. Four is what that keeps comfortable.
 */
export const MAX_REPLAY_CHARTS = 4;

/** The slot that trades. A layout always has it, and it never moves to another id. */
const PRIMARY_ID = 'c1';

/** Tells two provider names made in the same millisecond apart. */
let providerSerial = 0;

/**
 * A name for a replay provider.
 *
 * Underscore, not hyphen: Vela parses a symbol's `provider:` prefix as `[A-Za-z0-9_.]+` — a
 * hyphen makes the prefix unparseable and the provider is then never found (the chart just
 * stays empty, with no error anywhere). A fresh name per provider also keeps the shared
 * closed-bar cache from serving one provider's candles to the next — which is exactly what
 * going back to an earlier candle relies on.
 */
function providerNameFor(): string {
    providerSerial += 1;
    return `replay_${Date.now().toString(36)}${providerSerial.toString(36)}`;
}

/** What a controller is handed from the chart it drives. */
interface ControllerWiring {
    rechart: (timeframe: string, clock: number) => Promise<ReplayProvider>;
    notify: (message: string, kind: 'info' | 'error') => void;
}

/** What a controller is built from, once the chart it drives exists. */
type MakeController = (
    provider: ReplayProvider,
    bars: ReplayBar[],
    startIndex: number,
    wiring: ControllerWiring,
) => ReplayController;

/** What a session is mounted from, new or resumed. */
interface MountConfig {
    symbol: string;
    timeframe: string;
    clock: number;
    bars: ReplayBar[];
    grid?: ReplayGrid | null;
}

/**
 * Everything a mounted replay shares, whether it is new or resumed.
 *
 * A mount that fails half way is taken down again before the error goes on: otherwise the
 * chart and the panels it had already built stay on the page, and the next attempt builds a
 * second copy beside them.
 */
async function mount(
    container: HTMLElement,
    cfg: MountConfig,
    makeController: MakeController,
    theme: VelaTheme,
    onLeave: LeaveHandler,
): Promise<MountedReplay> {
    const cleanup: Array<() => void> = [];
    const dispose = (): void => {
        // Newest first: a panel is released before the chart it sits beside.
        while (cleanup.length > 0) {
            try {
                cleanup.pop()!();
            } catch (err: unknown) {
                console.error('[midorii] a part of the replay could not be released', err);
            }
        }
    };
    try {
        return await build(container, cfg, makeController, theme, onLeave, cleanup, dispose);
    } catch (err) {
        dispose();
        throw err;
    }
}

async function build(
    container: HTMLElement,
    cfg: MountConfig,
    makeController: MakeController,
    theme: VelaTheme,
    onLeave: LeaveHandler,
    cleanup: Array<() => void>,
    dispose: () => void,
): Promise<MountedReplay> {
    const archive = new LocalArchiveProvider();
    let providerName = providerNameFor();
    const provider = new ReplayProvider(archive, providerName, cfg.timeframe, cfg.clock);

    /* A session is a chart, the ticket beside it and the book under it — two axes, so two
     * boxes: a column for the dock, and a row inside it for the panel. Elements of our own
     * rather than a restyled `container`, which main.ts shows and hides with `hidden` — an
     * inline `display` on it would override that and leave the replay on screen for good. */
    const stack = container.ownerDocument.createElement('div');
    stack.style.cssText = 'position:absolute;inset:0;display:flex;flex-direction:column';
    const main = container.ownerDocument.createElement('div');
    main.style.cssText = 'flex:1 1 auto;min-height:0;display:flex';
    const chartHost = container.ownerDocument.createElement('div');
    // `min-width:0` is what lets the chart give way when the panel opens: without it a flex
    // item refuses to shrink past its content and the panel is pushed off the edge instead.
    chartHost.style.cssText = 'flex:1 1 auto;min-width:0;position:relative';
    main.appendChild(chartHost);
    stack.appendChild(main);
    container.appendChild(stack);
    cleanup.push(() => stack.remove());

    /* The app's ONE chart document, worn here too — a session opens looking like the chart
     * it was started from rather than on the factory defaults. `remembers: false`: the market
     * is the one that was SET UP, never the one a previous session was left on. */
    const doc = shareChartDoc('replay', { symbol: `${providerName}:${cfg.symbol}`, timeframe: cfg.timeframe }, { remembers: false, grid: 'session' });

    const ws = new VelaWorkspace(chartHost, {
        layout: '1',
        live: true,
        theme,
        symbol: `${providerName}:${cfg.symbol}`,
        timeframe: cfg.timeframe,
        brand: BRAND,
        providers: { [providerName]: () => provider },
        persist: doc.key,
        storage: doc.storage,
    });
    doc.attach(ws);
    cleanup.push(() => ws.destroy());
    cleanup.push(wireRadialMenu(ws));
    /* The session trades on ONE chart of the window, whichever has the focus. Read through here
     * every time: the chart behind it is the one slot 1 holds, and it is never the active one
     * by default once there are several. */
    const primaryCell = (): ChartCell => {
        const cell = ws.cell(PRIMARY_ID);
        if (!cell) throw new Error('The replay window has lost the chart it trades on.');
        return cell;
    };
    const primary = (): Vela => primaryCell().chart;
    await primary().ready();

    /**
     * Put the chart back on an earlier instant.
     *
     * A fresh provider under a fresh name rather than the running one wound back: the chart
     * already holds every candle after that instant, and the shared cache would hand them
     * straight back on the reload. Drawings survive — a market switch leaves them alone. The
     * provider it replaces is let go only once the chart is on the new one; where the switch
     * fails, the chart is put back where it was before the error goes on.
     */
    const rechart = async (timeframe: string, clock: number): Promise<ReplayProvider> => {
        const previous = { name: providerName, timeframe: primary().market.timeframe ?? timeframe };
        const name = providerNameFor();
        const next = new ReplayProvider(archive, name, timeframe, clock);
        primary().data.registerProvider(name, next);
        try {
            await primary().setMarket({ symbol: `${name}:${cfg.symbol}`, timeframe });
        } catch (err) {
            primary().data.unregisterProvider(name);
            await primary().setMarket({ symbol: `${previous.name}:${cfg.symbol}`, timeframe: previous.timeframe })
                .catch((restoreErr: unknown) => console.error('[midorii] could not put the replay chart back', restoreErr));
            throw err;
        }
        primary().data.unregisterProvider(previous.name);
        providerName = name;
        return next;
    };

    const notify = (message: string, kind: 'info' | 'error'): void => ws.toast(message, kind === 'error' ? 'error' : 'info');
    const controller = makeController(provider, cfg.bars, barIndexAt(cfg.bars, cfg.clock - 1), { rechart, notify });
    cleanup.push(() => controller.destroy());

    /* The other charts of the window watch the session's clock — markets and timeframes of their
     * own, nothing of the account. See replayMirrors.ts. */
    const mirrors = mountMirrors({
        ws,
        primaryId: PRIMARY_ID,
        archive,
        loadWindow: loadReplayWindow,
        clock: () => controller.session.clock,
        nameFor: providerNameFor,
        fallback: () => ({ symbol: cfg.symbol, timeframe: controller.timeframe }),
        notify,
    });
    cleanup.push(() => mirrors.dispose());
    controller.onClock = (clock) => mirrors.advance(clock);
    controller.onRewind = (clock) => { void mirrors.rewind(clock); };
    controller.grid = () => mirrors.grid();
    if (cfg.grid && cfg.grid.layout !== '1') {
        mirrors.expect(cfg.grid);
        ws.setLayout(cfg.grid.layout);
    }
    keepToFewCharts(ws, notify);

    // Added straight on the chart, not through the widget context: the replay's
    // visuals are recomputed state, so they must stay out of the undo timeline
    // and out of the persisted indicator ledger.
    registerReplayIndicator();
    const indicator = primary().addNativeIndicator(REPLAY_INDICATOR_TYPE);
    controller.attachIndicator(indicator);
    // How those visuals look, and the Trading tab in the chart settings that says so.
    cleanup.push(wirePositionStyle({ workspace: ws, indicator }).dispose);
    // Which cards this replay's chart puts on its plot. Its own workspace, so its own tab.
    cleanup.push(wireOverlaySettings(ws).dispose);

    /* The limits a funded account carries, and how this person likes to trade — both outlive the
     * session, and both are read by every way into the market below. */
    const rules = wireReplayRules({ controller, ws, onChange: () => controller.refreshVisuals() });
    let trading = loadReplayTrading();
    const habits = {
        get: (): ReplayTradingSettings => trading,
        set: (next: ReplayTradingSettings): void => {
            trading = next;
            saveReplayTrading(next);
        },
    };

    // The ticket beside the plot: the way in that does not go through a drawing.
    const ticket = showTicket(ws, main, controller, theme, primary, rules, habits);
    const sidebar = ticket.sidebar;
    cleanup.push(ticket.dispose);
    // The ticket drawn where it would trade, before it is sent — see chartPreview.ts.
    cleanup.push(wireTradePreview({
        chart: primary(),
        indicator,
        sidebar,
        notify: (message, kind) => ws.toast(message, kind === 'error' ? 'error' : 'info'),
    }));

    // Vela's own position tool is the other way in — drawn like any other drawing, traded only
    // when its right-click menu says so, and sized by the panel's risk settings either way.
    cleanup.push(wireOrderEntry({
        chart: primary(),
        controller,
        host: ws.root,
        risk: () => sidebar.risk(),
        beforeOrder: (spec) => rules.guardOrder(spec),
        notify: (message, kind) => ws.toast(message, kind === 'error' ? 'error' : 'info'),
    }));

    // The open position's own levels: draggable stop and target, and a close button on the entry.
    cleanup.push(wirePositionLevels({
        chart: primary(),
        controller,
        notify: (message, kind) => ws.toast(message, kind === 'error' ? 'error' : 'info'),
    }));

    // Transport controls into Vela's own topbar.
    setActiveReplay({
        controller,
        ws,
        primary,
        leave: onLeave,
        editBrackets: () => {
            void openBracketDefaults(ws.root, habits.get().brackets)
                .then((next) => {
                    if (!next) return;
                    habits.set({ ...habits.get(), brackets: next });
                    sidebar.refresh();
                    ws.toast(next.on
                        ? 'A fresh ticket now starts with a stop and a target.'
                        : 'A fresh ticket now starts without a stop and a target.');
                })
                .catch((err: unknown) => console.error('[midorii] the stop and target dialog failed', err));
        },
    });
    cleanup.push(() => setActiveReplay(null));

    // The transport under the chart, above the dock showAccount adds next.
    cleanup.push(mountTransport({ stack, after: main, ws, controller, theme, primary }).dispose);

    cleanup.push(showAccount(ws, primaryCell().host, stack, controller, sidebar, rules));

    followChartTimeframe(ws, primary, controller, cfg.symbol, notify, () => {
        void primary().setMarket({ symbol: `${providerName}:${cfg.symbol}`, timeframe: controller.timeframe });
    });

    return { ws, provider, controller, dispose };
}

/** Run an engine call and put its refusal in front of the person who asked for it. The
 *  engine's message is the message; there is nothing better to say than what it already said. */
function guarded(ws: VelaWorkspace, run: () => void): void {
    try {
        run();
    } catch (err: unknown) {
        ws.toast(err instanceof Error ? err.message : String(err), 'error');
    }
}

/**
 * Put the ticket beside the plot.
 *
 * Its own kit host: it is a sibling of the chart rather than a child, so the theme variables
 * the workspace writes on its own root do not reach it. They are re-applied when the chart's
 * theme changes, which is a thing the settings dialog can do mid-session.
 */
function showTicket(
    ws: VelaWorkspace,
    main: HTMLElement,
    controller: ReplayController,
    theme: VelaTheme,
    primary: () => Vela,
    rules: ReplayRules,
    habits: { get(): ReplayTradingSettings; set(next: ReplayTradingSettings): void },
): { sidebar: TradeSidebar; dispose: () => void } {
    const feed = controller.ticks;

    /* What the recording is of — above all its price increment, which the ladder is drawn on.
     * Written beside the recording when the gateway had listed the contract; where it had not,
     * worked out from the prints themselves as they play, which is the increment the market
     * actually moved in and never a guess. */
    let tickSize: number | null = null;
    let inferredTick: number | null = null;
    if (feed) {
        void window.midori.ticks.meta(feed.source)
            .then((meta) => {
                if (meta?.tickSize && meta.tickSize > 0) {
                    tickSize = meta.tickSize;
                    sidebar.refresh();
                }
            })
            .catch((err: unknown) => console.error('[midorii] could not read what the recording is of', err));
    }

    const sidebar = mountTradeSidebar(main, {
        account: () => ({
            equity: controller.session.broker.equity,
            price: controller.session.bar.close,
            // What a point is worth and the grid a size lands on — the ticket sizes against both.
            pointValue: controller.pointValue(),
            ...controller.dealingRules(),
            /* The recorded bid and ask, while the quote is fresh — what a market order here is
             * filled at, and what the ticket's two sides show. */
            ...(controller.session.broker.quote ?? {}),
        }),
        counts: () => {
            const book = controller.book();
            return { positions: book.positions.length, orders: book.orders.length };
        },
        actions: {
            order: (spec) => guarded(ws, () => { rules.guardOrder(spec); controller.order(spec); }),
            flatten: () => guarded(ws, () => controller.flatten()),
            cancelAll: () => guarded(ws, () => controller.cancelAll()),
        },
        // What this session has already done, in the panel's own History tab.
        history: rules.history,
        /* Read fresh, like the settings they come from: the dialog changes them while the panel is
         * on screen, and a ticket bracketed by last week's numbers is worse than one bracketed by none. */
        brackets: () => habits.get().brackets,
        quickSizes: () => habits.get().quickSizes,
        onQuickSizes: (next) => habits.set({ ...habits.get(), quickSizes: next }),
        sizing: () => habits.get().sizing,
        onSizing: (next) => habits.set({ ...habits.get(), sizing: next }),
        ...(feed
            ? {
                tick: () => tickSize ?? inferredTick,
                ladder: {
                    quote: () => controller.session.broker.quote,
                    positions: () => controller.session.broker.positions.map((p) => ({
                        size: p.size, entryPrice: p.entryPrice, stopLoss: p.stopLoss ?? null, takeProfit: p.takeProfit ?? null,
                    })),
                    orders: () => controller.book().orders
                        .filter((o) => o.price != null)
                        .map((o) => ({ id: o.id, side: o.side, price: o.price!, size: o.size })),
                    cancelOrder: (id: number) => guarded(ws, () => controller.cancelOrder(id)),
                },
                /* Prints only flow while the recording is being played, so the tape is offered
                 * only then — an empty tape on candles would promise prints that never come. */
                tape: () => controller.mode === 'ticks',
            }
            : {}),
    });

    if (feed) {
        /* The ladder folds volume as a running figure (see priceLadder.ts), so it is handed one:
         * every print adds its own size at its own price, and a new candle never reads as a
         * drop that has to be guessed at. */
        let traded = 0;
        let lastPrint: number | null = null;
        controller.onPrints = (prints) => {
            const tape: TapePrint[] = [];
            for (const [time, , price, size, side] of prints) {
                tape.push({ time, price, size, side: side === 1 ? 'sell' : 'buy' });
                traded += size;
                sidebar.markVolume(price, traded);
                if (lastPrint !== null && price !== lastPrint) {
                    const step = Math.round(Math.abs(price - lastPrint) * 1e9) / 1e9;
                    if (step > 0 && (inferredTick === null || step < inferredTick)) inferredTick = step;
                }
                lastPrint = price;
            }
            sidebar.pushPrints(tape);
        };
        /* Going back leaves a tape and a volume profile of a market that has not happened yet. */
        controller.onJump = () => {
            traded = 0;
            lastPrint = null;
            sidebar.resetMarket();
        };
    }

    ensureUIHost(sidebar.el, theme);
    primary().on('theme:changed', (theme) => applyThemeTokens(sidebar.el, theme));
    // A level right-clicked on the plot, onto the ticket as a resting order — not sent.
    const offPending = wirePendingMenu({
        chart: primary(),
        sidebar,
        price: () => controller.price(),
        tick: () => tickSize ?? inferredTick,
    });
    return {
        sidebar,
        dispose: () => {
            offPending();
            sidebar.dispose();
            sidebar.el.remove();
        },
    };
}

/**
 * Put the account on the chart, and keep it there.
 *
 * The strip anchors to the CELL rather than to the workspace root: the renderer publishes the
 * plot's own insets there for host overlays to use, and it is already a positioning context.
 * It is the cell of the chart the session trades on, whichever chart of the window has the focus.
 */
function showAccount(
    ws: VelaWorkspace,
    cell: HTMLElement,
    stack: HTMLElement,
    controller: ReplayController,
    sidebar: TradeSidebar,
    rules: ReplayRules,
): () => void {
    const strip = cell
        ? mountAccountStrip(cell, {
            broker: 'Replay',
            brokerHint: 'A session played back bar by bar against this app\'s own engine — '
                + 'separate from the paper account, and from any venue.',
        })
        : null;

    // Buy/Sell on the chart itself, directly under the card — market orders, nothing else.
    const quick = cell
        ? mountQuickPanel(cell, {
            price: () => controller.session.bar.close,
            pointValue: () => controller.pointValue(),
            order: (spec) => guarded(ws, () => { rules.guardOrder(spec); controller.order(spec); }),
            anchor: strip?.el ?? null,
        })
        : null;

    /* Every action goes through here so a refusal from the engine — break-even on a trade that
     * has not moved, a stop on a position that just closed — reaches the person who asked for
     * it. */
    const guard = (run: () => void) => (): void => guarded(ws, run);

    const dock = mountTradeDock(stack, {
        closePosition: (id) => guard(() => controller.closeOne(id))(),
        closePart: (size, id) => guard(() => controller.closePart(size, id))(),
        reverse: (id) => guard(() => { rules.guardReverse(id); controller.reverse(id); })(),
        breakEven: (id) => guard(() => controller.breakEven(id))(),
        protect: (levels, id) => guard(() => controller.protect(levels, id))(),
        setTrailing: (distance, id) => guard(() => controller.setTrailing(distance, {}, id))(),
        cancelOrder: (id) => guard(() => controller.cancelOrder(id))(),
        cancelAll: () => guard(() => controller.cancelAll())(),
        flatten: () => guard(() => controller.flatten())(),
    }, { limits: { columns: rules.prop.columns, action: rules.prop.action } });

    const paint = (): void => {
        // Read once per repaint: the figures, the refusal and the enforcement all want the same answer.
        rules.prop.read();
        strip?.update(controller.account());
        dock.render(controller.book(), { stats: historyStats(rules.history(), controller.broker.balance) });
        // The ticket sizes against equity and the last price, so it moves with every bar too.
        sidebar.refresh();
        quick?.refresh();
        // After everything has repainted, so what is about to be closed was on screen first.
        rules.prop.enforce();
    };
    controller.onAccountChange = paint;
    paint();

    return () => {
        controller.onAccountChange = null;
        quick?.destroy();
        strip?.destroy();
        strip?.el.remove();
        dock.el.remove();
    };
}

/**
 * Let the chart's own timeframe picker drive the session.
 *
 * `market:changed` lands after the reload has finished, so by the time this runs
 * the chart is already showing the new resolution — correctly, because the
 * provider reveals by instant rather than by bar count. What is left is to move
 * the account onto the same bars, which is what `retime` does.
 *
 * A timeframe the archive cannot serve leaves the session untouched and puts the
 * chart back where it was, rather than letting the two drift apart in silence.
 */
function followChartTimeframe(
    ws: VelaWorkspace,
    primary: () => Vela,
    controller: ReplayController,
    symbol: string,
    notify: (message: string, kind: 'info' | 'error') => void,
    putBack: () => void,
): void {
    primary().on('market:changed', ({ symbol: shown, timeframe }) => {
        /* The session is bound to the market it was set up on: its account, its journal and its
         * recording are all of it. Another market is for the charts beside this one. */
        if (shown && bareSymbol(shown) !== symbol) {
            notify(`This session trades ${symbol} — look at another market on one of the other charts.`, 'error');
            putBack();
            return;
        }
        if (timeframe === controller.timeframe) return;
        void controller.retime(timeframe).catch((err: unknown) => {
            ws.toast(err instanceof Error ? err.message : String(err), 'error');
            void primary().setMarket({ timeframe: controller.timeframe });
        });
    });
}

/**
 * Hold the window to {@link MAX_REPLAY_CHARTS}: a layout with more is put back, with a word.
 *
 * Deferred a tick — the layout is mid-change when this hears of it, and putting it back from
 * inside its own event would be a second change on top of one that has not finished.
 */
function keepToFewCharts(ws: VelaWorkspace, notify: (message: string, kind: 'info' | 'error') => void): void {
    let settled = ws.layout.id;
    ws.on('layout:changed', ({ layout }) => {
        if (ws.cells().length <= MAX_REPLAY_CHARTS) {
            settled = layout;
            return;
        }
        queueMicrotask(() => {
            notify(`A replay shows up to ${MAX_REPLAY_CHARTS} charts.`, 'error');
            ws.setLayout(settled);
        });
    });
}

/** Start a fresh replay at `startTime`, on the default timeframe. `theme` is the palette
 *  the app is currently wearing — a session is built in it rather than corrected into it. */
export async function startReplay(
    container: HTMLElement,
    cfg: ReplaySetup,
    theme: VelaTheme,
    onLeave: LeaveHandler,
): Promise<MountedReplay> {
    const timeframe = cfg.ticks ? TICK_TIMEFRAME : DEFAULT_TIMEFRAME;
    // Refused before anything is mounted: an account the engine would reject is not a session.
    const account = accountOptions(cfg.account ?? SPOT_ACCOUNT);
    const { bars } = await loadReplayWindow(cfg.symbol, timeframe, cfg.startTime);
    return mount(
        container,
        { symbol: cfg.symbol, timeframe, clock: cfg.startTime, bars },
        (provider, window_, startIndex, { rechart, notify }) => new ReplayController({
            provider, bars: window_, startIndex, balance: cfg.balance, name: cfg.name,
            ...account,
            symbol: cfg.symbol, timeframe, rechart,
            ticks: cfg.ticks ? new TickFeed(cfg.ticks) : null,
            onNotice: notify,
        }),
        theme,
        onLeave,
    );
}

/**
 * Pick up a parked session. The bars are fetched fresh around its stored clock —
 * they were never saved, and are the same bars today — and the account is
 * restored from the snapshot, which recomputes its playhead from that clock
 * rather than from an index into a window that no longer exists.
 *
 * It comes back on the timeframe it was put down on, including the bar it was
 * standing inside if the clock had stopped part-way through one.
 */
export async function resumeReplay(
    container: HTMLElement,
    sessionId: string,
    theme: VelaTheme,
    onLeave: LeaveHandler,
): Promise<MountedReplay> {
    const record = await window.midori.replay.loadSession(sessionId);
    if (!record) throw new Error(`No stored replay session ${sessionId}.`);

    const { bars, forming } = await loadReplayWindow(record.symbol, record.timeframe, record.clock);
    return mount(
        container,
        { symbol: record.symbol, timeframe: record.timeframe, clock: record.clock, bars, grid: record.grid ?? null },
        (provider, window_, startIndex, { rechart, notify }) => new ReplayController({
            provider, bars: window_, startIndex, forming,
            symbol: record.symbol, timeframe: record.timeframe,
            restoreFrom: record.session,
            restoredSessionId: record.id,
            name: record.name,
            shots: record.shots ?? [],
            // What lets a session picked up today still go back to a candle from yesterday.
            journal: record.journal ?? null,
            ticks: record.ticks ? new TickFeed(record.ticks) : null,
            rechart,
            onNotice: notify,
        }),
        theme,
        onLeave,
    );
}
