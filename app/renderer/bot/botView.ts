import { Menu, applyThemeTokens, ensureUIHost, injectStyles, overlayScrollbarCss } from '../../../src/ui';
import { resolveTheme } from '../../../src/core/theme';
import type { ThemeName, VelaTheme } from '../../../src';
import type { DataProvider } from '../../../src/plugin';
import { VelaWorkspace } from '../../../src/workspace';
import { BRAND } from '../about/brand';
import { formatMoney, formatSignedMoney } from '../format';
import { mountAccountStrip, type AccountStrip } from '../replay/accountStrip';
import type { AccountFigures } from '../replay/accountFigures';
import { mountTradeDock, type TradeDock } from '../replay/tradeDock';
import { TRADE_INDICATOR_TYPE, registerTradeIndicator } from '../replay/replayIndicator';
import { button, ensureFigureStyles } from '../runs/runViews';
import { shareChartDoc } from '../shell/sharedChartDoc';
import { wireRadialMenu } from '../settings/radialMenuPrefs';
import { STRATEGIES } from '../strategies';
import { BotEngine } from './BotEngine';
import { setBotChart } from './botChart';
import type { BotRunner } from './BotRunner';
import { mountBotForm, setupProblem, type BotForm, type SetupProblem, type SetupSection } from './botForm';
import { botId, newBot, type BotConfig } from './botTypes';
import { botTape } from './botTape';
import { attachLayoutMenu, createLayoutStore, mountFleetGutter, mountPanelBoard, type LayoutStore } from '../shell/panelBoard';
import { BOT_BOARD, type PanelId } from './botBoard';
import { ruleRows } from './botRules';
import { createAssetPicker } from './assetPicker';
import { askToArm } from '../trading/capitalArmDialog';
import { resolveStrategyParams } from '../strategies';
import { savedStrategyTimeframe } from '../strategies/settingsTransfer';

/**
 * The Trading Bot tab: the chart's own trading screen, run by a strategy instead of by a
 * hand.
 *
 * Everything on it already exists somewhere else, on purpose. The chart is a Vela
 * workspace, the account card and the position dock are the replay's, the position lines
 * are the same native indicator the paper account draws through. That is what makes this a
 * screen somebody can trust: a bot's position looks exactly like a hand-placed one, on the
 * same chart, drawn by the same code, because it IS one.
 *
 * What is not copied from the Chart tab is the ways IN. There is no ticket, no quick panel,
 * no right-click-to-order, and the dock's own buttons stay — a person can always close what
 * a bot opened, and never through this screen open something a strategy did not ask for.
 * The asymmetry is the point: a bot screen where a slip of the hand places a trade is a bot
 * screen that lies about who traded.
 *
 * One chart, whichever bot is selected
 * ------------------------------------
 * Rather than a workspace per bot. A bot does not need a chart to run — it has its own feed
 * and its own account and neither of them is on screen — so a chart per bot would be four
 * live subscriptions kept open to draw three charts nobody is looking at. The one chart
 * follows the selection.
 */

const STYLE_ID = 'midorii-bot';
const CSS = `
.midorii-bot {
    position: absolute; inset: 0;
    display: flex; flex-direction: column;
    background: var(--vela-bg);
    color: var(--vela-fg);
    font: 13px/1.5 var(--vela-font, sans-serif);
}
.midorii-bot-bar {
    flex: none;
    display: flex; align-items: center; gap: 10px;
    height: 34px; padding: 0 14px;
    border-bottom: 1px solid var(--vela-border);
    font-size: 12px; color: var(--vela-fg-muted);
}
.midorii-bot-bar-spacer { flex: 1 1 auto; }
.midorii-bot-main { flex: 1 1 auto; min-height: 0; display: flex; }

.midorii-bot-list {
    flex: none; width: 272px; padding: 8px;
    overflow: auto;
}
.midorii-bot-group {
    margin: 10px 8px 4px; font-size: 10px; font-weight: 700; letter-spacing: .12em;
    text-transform: uppercase; color: var(--vela-fg-faint);
}
.midorii-bot-group:first-child { margin-top: 4px; }
@media (max-width: 860px) {
    .midorii-bot-main { flex-direction: column; }
    .midorii-bot-list { width: auto !important; max-height: 38%; border-bottom: 1px solid var(--vela-border); }
}
${overlayScrollbarCss('.midorii-bot-list')}
.midorii-bot-item {
    all: unset;
    display: block; box-sizing: border-box; width: 100%;
    padding: 8px 10px; margin-bottom: 3px;
    border-radius: var(--vela-radius-sm);
    cursor: pointer;
}
.midorii-bot-item:hover { background: var(--vela-hover); }
.midorii-bot-item[data-active='1'] { background: var(--vela-active); }
/* The row an open right-click menu is about — a ring rather than a wash, so it still reads
   as itself while the pointer has moved off it and onto the menu. */
.midorii-bot-item[data-menu='1'] { box-shadow: inset 0 0 0 1px var(--vela-border-strong); }
.midorii-bot-item-head { display: flex; align-items: center; gap: 6px; }
.midorii-bot-item b { flex: 1 1 auto; font-size: 13px; font-weight: 600; color: var(--vela-fg-bright);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.midorii-bot-item span { display: block; margin-top: 2px; font-size: 11.5px; color: var(--vela-fg-muted);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.midorii-bot-dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--vela-fg-faint); }
.midorii-bot-dot[data-state='running'] { background: var(--vela-up, #089981); }
.midorii-bot-dot[data-state='starting'] { background: var(--vela-warning, #d9822b); }
.midorii-bot-dot[data-state='stopping'] { background: var(--vela-warning, #d9822b); }
.midorii-bot-dot[data-state='failed'] { background: var(--vela-danger, #f23645); }

.midorii-bot-body { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; }
.midorii-bot-head {
    flex: none;
    display: flex; align-items: center; gap: 10px;
    padding: 8px 14px;
    border-bottom: 1px solid var(--vela-border);
}
.midorii-bot-title { display: flex; flex-direction: column; min-width: 0; flex: 1 1 auto; }
.midorii-bot-title b { font-size: 14px; font-weight: 600; color: var(--vela-fg-bright);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.midorii-bot-title span { font-size: 11.5px; color: var(--vela-fg-muted); }
.midorii-bot-title span[data-error='1'] { color: var(--vela-danger); }

.midorii-bot-tabs { display: inline-flex; flex: none; gap: 2px; }
.midorii-bot-tab {
    all: unset;
    padding: 4px 12px; border-radius: var(--vela-radius-sm);
    font-size: 12px; font-weight: 600; color: var(--vela-fg-muted); cursor: pointer;
}
.midorii-bot-tab:hover { background: var(--vela-hover); color: var(--vela-fg-bright); }
.midorii-bot-tab[data-active='1'] { background: var(--vela-active); color: var(--vela-fg-bright); }

.midorii-bot-pane { flex: 1 1 auto; min-height: 0; position: relative; }
.midorii-bot-pane[hidden] { display: none; }
.midorii-bot-settings { position: absolute; inset: 0; overflow: auto; }
${overlayScrollbarCss('.midorii-bot-settings')}
.midorii-bot-settings-inner { max-width: 1080px; margin: 0 auto; padding: 16px 18px 32px; }

/* The live pane: the movable panels. See shell/panelBoard.ts. */
.midorii-bot-live { position: absolute; inset: 0; display: flex; }
.midorii-bot-account-rail {
    flex: none; display: flex; flex-direction: column; align-items: flex-start; gap: 8px;
    padding: 2px 14px 14px;
}
.midorii-bot-account-copy { min-width: 0; }
.midorii-bot-account-label {
    display: block; color: var(--vela-accent-bright, #2962ff);
    font-size: 10px; font-weight: 700; letter-spacing: .11em; text-transform: uppercase;
}
.midorii-bot-account-copy strong {
    display: block; margin-top: 1px; color: var(--vela-fg-bright);
    font-size: 14px; font-weight: 650;
}
.midorii-bot-account-copy p {
    margin: 1px 0 0; color: var(--vela-fg-muted); font-size: 11.5px;
}
.midorii-bot-account-link {
    flex: none; border: 1px solid var(--vela-border-strong);
    border-radius: var(--vela-radius-sm); padding: 7px 11px;
    background: var(--vela-surface-overlay); color: var(--vela-fg-bright);
    font: 600 11.5px var(--vela-font, sans-serif); cursor: pointer;
}
.midorii-bot-account-link:hover { background: var(--vela-hover); }
.midorii-bot-account-link:focus-visible,
.midorii-bot-tab[data-attention='1']::after {
    content: ''; display: inline-block; width: 6px; height: 6px; margin: 0 0 2px 6px; border-radius: 50%;
    background: var(--vela-warning, #d9822b);
}
.midorii-bot-tab:focus-visible { outline: 2px solid var(--vela-accent-bright, #2962ff); outline-offset: 2px; }
.midorii-bot-chart { flex: 1 1 auto; min-height: 0; position: relative; border-top: 1px solid var(--vela-border-faint); }
.midorii-bot-tape {
    flex: 1 1 auto; min-height: 0;
    background: var(--vela-surface);
    display: flex; flex-direction: column; overflow: hidden;
}
${overlayScrollbarCss('.midorii-bot-tape')}

/* The trade dock is the replay's, built for a full-width strip under a chart that has a seam
   to drag and a fold button. In a panel the panel is the size and the seam, so both go. */
.midorii-board-panel[data-panel='position'] { max-height: 50%; }
.midorii-board-panel[data-panel='position'] .midorii-board-panel-body { overflow: hidden; }
.midorii-board-panel[data-panel='position'] .midorii-dock { flex: 1 1 auto; min-height: 0; border-top: 0; }
.midorii-board-panel[data-panel='position'] .midorii-dock-resizer,
.midorii-board-panel[data-panel='position'] .midorii-dock-fold { display: none; }
.midorii-board-panel[data-panel='position'] .midorii-dock-body { height: auto !important; flex: 1 1 auto; min-height: 0; overflow: auto; }
.midorii-board-panel[data-panel='position'] .midorii-dock-head { flex-wrap: wrap; height: auto; min-height: 34px; padding-block: 4px; }
.midorii-bot-position { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }

.midorii-bot-status { padding: 2px 14px 14px; }
.midorii-bot-status .midorii-bot-figs { flex-wrap: wrap; row-gap: 10px; }
.midorii-bot-status-note { margin: 0; color: var(--vela-fg-muted); font-size: 12px; line-height: 1.55; }

.midorii-bot-rules { padding: 0 14px 14px; }
.midorii-bot-rules-now { margin: 0 0 10px; font-size: 12.5px; line-height: 1.5; color: var(--vela-fg-muted); }
.midorii-bot-rules-now[data-blocked='1'] {
    padding: 7px 9px; border-left: 2px solid var(--vela-warning, #d9822b);
    background: var(--vela-surface-overlay); color: var(--vela-fg);
}
.midorii-bot-rule { display: flex; justify-content: space-between; gap: 12px; padding: 4px 0; font-size: 12px;
    border-bottom: 1px solid var(--vela-border-faint); }
.midorii-bot-rule span { color: var(--vela-fg-muted); }
.midorii-bot-rule b { font-weight: 600; color: var(--vela-fg-bright); text-align: right; font-variant-numeric: tabular-nums; }
.midorii-bot-rule[data-on='0'] b { color: var(--vela-fg-faint); font-weight: 500; }

.midorii-bot-empty { padding: 28px 20px; color: var(--vela-fg-muted); line-height: 1.65; max-width: 620px; }
.midorii-bot-empty h2 { margin: 0 0 8px; font-size: 15px; color: var(--vela-fg-bright); }
.midorii-bot-empty p { margin: 0 0 10px; }

.midorii-bot-figs { display: inline-flex; align-items: center; gap: 14px; flex: none; font-size: 12px; }
.midorii-bot-figs[hidden] { display: none !important; }
.midorii-bot-fig { display: inline-flex; flex-direction: column; line-height: 1.3; }
.midorii-bot-fig small { font-size: 9.5px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--vela-fg-faint); }
.midorii-bot-fig b { font-weight: 600; color: var(--vela-fg-bright); font-variant-numeric: tabular-nums; }
.midorii-bot-fig b.up { color: var(--vela-up, #089981); }
.midorii-bot-fig b.down { color: var(--vela-down, #f23645); }
`;

/** The market this screen's chart opens on before a bot has been selected — selecting one
 *  switches it to whatever that bot trades. */
const BOT_MARKET = { symbol: 'binance:BTCUSDT', timeframe: '5' };

/** Which half of a bot's screen is showing. */
type Pane = 'live' | 'settings';

/**
 * What the account card reads while no bot is running.
 *
 * `open` and `risk` are null rather than zero, which is the same distinction the figures
 * themselves make: an account holding nothing is not breaking even on it, and it does not
 * have zero at stake — there is nothing to have an amount of.
 */
const EMPTY_ACCOUNT: AccountFigures = {
    equity: 0,
    cash: 0,
    initialBalance: 0,
    returnPct: 0,
    open: null,
    risk: null,
    unprotected: 0,
    netSize: 0,
    openPositions: 0,
};

export interface BotViewOptions {
    /** Every market source the app can reach — the bots build their own instances. */
    providers: Record<string, () => DataProvider>;
    /** The app-owned engine. It runs before and independently of this optional screen. */
    engine: BotEngine;
    /** The app's palette, read fresh: this view builds a chart of its own. */
    theme: () => ThemeName | VelaTheme;
    /** How something that happened without a click reaches a person. */
    notify: (message: string, kind: 'info' | 'error' | 'success') => void;
}

export interface BotViewHandle {
    readonly selectedBotId: string | null;
    /** Select the bot shown by the list, chart and app-level account strip. */
    selectBot(id: string): void;
    /** Re-read the stored bots and repaint. Called whenever the tab is opened. */
    refresh(): Promise<void>;
    /** Dress the view's own chart in the app's current palette. */
    setTheme(theme: VelaTheme): void;
}

/** Mount the Trading Bot tab into `host`. */
export function mountBotView(host: HTMLElement, opts: BotViewOptions): BotViewHandle {
    const doc = host.ownerDocument;
    injectStyles(STYLE_ID, CSS, doc);
    ensureFigureStyles(doc);
    registerTradeIndicator();

    let capitalConfigured = false;
    async function refreshCapitalEnvironment(): Promise<void> {
        try {
            capitalConfigured = (await window.midori.capital.environment()).configured;
        } catch (err) {
            console.error('[midorii] could not read the Capital.com environment', err);
        }
    }
    void refreshCapitalEnvironment().then(() => paint());

    const engine = opts.engine;
    engine.subscribe(() => schedulePaint());

    /* What each venue serves, asked of the providers themselves rather than restated here.
     * One throwaway instance per source: their constructors only set fields — nothing is
     * fetched until a bar is asked for — and the answer does not change while the app runs. */
    const venueTimeframes: Record<string, readonly string[]> = {};
    for (const [name, make] of Object.entries(opts.providers)) {
        const supported = make().info?.()?.supportedTimeframes;
        if (supported && supported.length > 0) venueTimeframes[name.toLowerCase()] = supported;
    }

    let selected = '';
    let pane: Pane = 'live';
    let form: BotForm | null = null;
    /** Which bot the form is currently pointed at, so it is only rebuilt on a real change. */
    let formFor = '';
    let formBot: BotConfig | null = null;
    let formReadOnly = false;
    let formAccountTrades = 0;
    let formCapitalConfigured = false;
    /** The setup step to scroll to once the form is on screen — set by "Finish setup". */
    let pendingSection: SetupSection | null = null;

    /** What keeps this bot from starting. The form's draft when it is the one being edited,
     *  because that is what Start would save and run. */
    function problemOf(bot: BotConfig): SetupProblem | null {
        return formFor === bot.id && form ? form.problem : setupProblem(bot);
    }

    function maySwitchBot(nextId?: string): boolean {
        if (formFor === selected && form?.dirty && nextId !== selected) {
            pane = 'settings';
            opts.notify('Save or discard this bot’s changes before switching bots.', 'error');
            paint();
            return false;
        }
        return true;
    }

    /* ── the frame ───────────────────────────────────────────────────────── */

    const root = doc.createElement('div');
    root.className = 'midorii-bot midorii-figures';

    const bar = doc.createElement('div');
    bar.className = 'midorii-bot-bar';
    const barLabel = doc.createElement('span');
    const barSpacer = doc.createElement('span');
    barSpacer.className = 'midorii-bot-bar-spacer';
    const addButton = button('New bot', 'primary');
    addButton.onclick = () => void createBot();
    bar.append(barLabel, barSpacer, addButton);

    const main = doc.createElement('div');
    main.className = 'midorii-bot-main';

    const list = doc.createElement('div');
    list.className = 'midorii-bot-list';

    const body = doc.createElement('div');
    body.className = 'midorii-bot-body';

    const head = doc.createElement('div');
    head.className = 'midorii-bot-head';

    const livePane = doc.createElement('div');
    livePane.className = 'midorii-bot-pane';
    const liveStack = doc.createElement('div');
    liveStack.className = 'midorii-bot-live';
    const statusHost = doc.createElement('div');
    statusHost.className = 'midorii-bot-status';
    const rulesHost = doc.createElement('div');
    rulesHost.className = 'midorii-bot-rules';
    const positionHost = doc.createElement('div');
    positionHost.className = 'midorii-bot-position';
    const accountRail = doc.createElement('div');
    accountRail.className = 'midorii-bot-account-rail';
    const accountCopy = doc.createElement('div');
    accountCopy.className = 'midorii-bot-account-copy';
    const accountLabel = doc.createElement('span');
    accountLabel.className = 'midorii-bot-account-label';
    const accountTitle = doc.createElement('strong');
    const accountHint = doc.createElement('p');
    accountCopy.append(accountLabel, accountTitle, accountHint);
    const accountLink = doc.createElement('button');
    accountLink.className = 'midorii-bot-account-link';
    accountRail.append(accountCopy, accountLink);
    const chartHost = doc.createElement('div');
    chartHost.className = 'midorii-bot-chart';
    const tapeHost = doc.createElement('div');
    tapeHost.className = 'midorii-bot-tape';

    /* Where the panels sit is remembered per machine, not per bot: it is how this person likes
     * the screen, and it should not change under them when they pick another bot. Storage can
     * be unavailable (a locked-down profile); the store copes with that. */
    let storage: Storage | null = null;
    try { storage = doc.defaultView?.localStorage ?? null; } catch { storage = null; }
    const layoutStore: LayoutStore<PanelId> = createLayoutStore(BOT_BOARD, storage);
    const board = mountPanelBoard(doc, layoutStore, {
        status: { title: 'Status', body: statusHost },
        account: { title: 'Account', body: accountRail },
        chart: { title: 'Chart', body: chartHost, stackedHeight: 320 },
        activity: { title: 'Activity', body: tapeHost },
        position: { title: 'Open position', body: positionHost },
        rules: { title: 'Safety rules', body: rulesHost },
    });
    liveStack.appendChild(board.el);
    livePane.appendChild(liveStack);

    const settingsPane = doc.createElement('div');
    settingsPane.className = 'midorii-bot-pane';
    const settingsScroll = doc.createElement('div');
    settingsScroll.className = 'midorii-bot-settings';
    const settingsInner = doc.createElement('div');
    settingsInner.className = 'midorii-bot-settings-inner';
    settingsScroll.appendChild(settingsInner);
    settingsPane.appendChild(settingsScroll);

    body.append(head, livePane, settingsPane);
    main.append(list, mountFleetGutter(doc, layoutStore, list), body);
    root.append(bar, main);
    host.appendChild(root);

    // Built on this screen's own element — see assetPicker.ts on why not a chart's workspace.
    const assets = createAssetPicker({ host: root, providers: opts.providers, notify: opts.notify });

    const tape = botTape(tapeHost);
    accountLink.onclick = () => tape.showPrimary();

    /* ── the chart ───────────────────────────────────────────────────────── */

    /**
     * The chart, built on the first bot that is looked at rather than at startup.
     *
     * A workspace is a live subscription and a canvas; building one for a tab nobody has
     * opened would be a feed running for a chart that has never been painted. Kept
     * afterwards — coming back to a bot should be instant.
     */
    let ws: VelaWorkspace | null = null;
    let strip: AccountStrip | null = null;
    let dock: TradeDock | null = null;
    /** The indicator drawing the selected bot's positions, and whose it is. */
    let indicator: ReturnType<VelaWorkspace['chart']['addNativeIndicator']> | null = null;
    let indicatorFor = '';
    /** The market the chart is on, so it is only switched when it actually differs. */
    let chartMarket = '';

    function ensureChart(): VelaWorkspace {
        if (ws) return ws;
        /* The app's ONE chart document — dressed here is dressed on the Chart tab and in a
         * replay too. Only the market stays this screen's own, which is the bot's, not a
         * person's: selecting a bot below switches it. See shell/sharedChartDoc.ts. */
        const doc = shareChartDoc('bot', BOT_MARKET);
        ws = new VelaWorkspace(chartHost, {
            layout: false,
            live: true,
            theme: opts.theme(),
            symbol: BOT_MARKET.symbol,
            timeframe: BOT_MARKET.timeframe,
            brand: BRAND,
            providers: opts.providers,
            persist: doc.key,
            storage: doc.storage,
        });
        doc.attach(ws);
        wireRadialMenu(ws);

        /* Claimed before anything else, so the app's own topbar actions know not to project
         * onto it — the Trade menu most of all, which on a bot's chart would wire a second
         * account to one that is already being traded. See botChart.ts. */
        setBotChart(ws.chart);
        ws.refreshActions();

        const cell = ws.root.querySelector<HTMLElement>('.vela-cell');
        if (cell) {
            strip = mountAccountStrip(cell, {
                broker: 'Bot',
                brokerHint: 'The account this bot trades — its own, never the Chart tab’s.',
            });
        }

        dock = mountTradeDock(positionHost, {
            /* A person can always close what a bot opened. Nothing here can OPEN anything —
             * see the file header on why this screen has no ticket. */
            closePosition: (id) => act((c) => c.closeOne(id)),
            closePart: (size, id) => act((c) => c.closePart?.(size, id)),
            reverse: (id) => act((c) => c.reverse?.(id)),
            breakEven: (id) => act((c) => c.breakEven?.(id)),
            protect: (levels, id) => act((c) => c.protect(levels, id)),
            setTrailing: (distance, id) => act((c) => c.setTrailing?.(distance, {}, id)),
            cancelOrder: (id) => act((c) => c.cancelOrder?.(id)),
            cancelAll: () => act((c) => c.cancelAll?.()),
            flatten: () => {
                const runner = engine.runner(selected);
                runner?.flatten('closed by hand from the bot screen');
            },
        }, {
            // No way in from this screen, so no instructions for one. See the file header.
            howToTrade: 'The bot opens its own trades — these buttons can only close them.',
        });

        ensureUIHost(chartHost, resolveTheme(opts.theme()));
        return ws;
    }

    /**
     * Run one of the dock's actions against whichever controller the selected bot has.
     *
     * The two controllers do not implement the same set — a live account has no partial
     * close or trailing stop in this app — so those are called optionally and a controller
     * that does not offer one simply does nothing. The dock is the same dock the Chart tab
     * uses, and giving it a second, cut-down shape for live bots would be a second thing to
     * keep in step with the first.
     */
    function act(run: (controller: PartialController) => unknown): void {
        const runner = engine.runner(selected);
        const controller = (runner?.paperController ?? runner?.capitalController) as PartialController | undefined;
        if (!controller) {
            opts.notify('That bot is not running — there is nothing open to act on.', 'error');
            return;
        }
        try {
            run(controller);
        } catch (err) {
            opts.notify(err instanceof Error ? err.message : String(err), 'error');
        }
    }

    /** The union of what the two controllers offer, with the differences optional. */
    type PartialController = {
        closeOne(id: number): void;
        protect(levels: { stopLoss?: number | null; takeProfit?: number | null }, id: number): void;
        closePart?(size: number, id: number | null): void;
        reverse?(id: number | null): void;
        breakEven?(id: number | null): boolean;
        setTrailing?(distance: number, options: Record<string, never>, id: number | null): void;
        cancelOrder?(id: number): boolean | void;
        cancelAll?(): void;
    };

    /**
     * Put the chart on the selected bot's market and its positions on the chart.
     *
     * The indicator is torn down and rebuilt on a change of bot rather than reused, because
     * it is fed by whichever controller owns it — a reused one would keep being pushed the
     * previous bot's positions until the new one's first update.
     */
    function syncChart(bot: BotConfig | undefined): void {
        if (!bot) return;
        const chart = ensureChart().chart;

        const market = `${bot.symbol}|${bot.timeframe}`;
        if (market !== chartMarket && bot.symbol) {
            chartMarket = market;
            void chart.setMarket({ symbol: bot.symbol, timeframe: bot.timeframe }).catch((err: unknown) => (
                opts.notify(`The bot’s asset could not be charted: ${err instanceof Error ? err.message : String(err)}`, 'error')
            ));
        }

        const runner = engine.displayRunner(bot.id);
        const key = runner ? `${bot.id}:${runner.status}` : '';
        if (key === indicatorFor) return;

        indicator?.remove();
        indicator = null;
        indicatorFor = key;
        if (!runner) return;

        indicator = chart.addNativeIndicator(TRADE_INDICATOR_TYPE);
        const controller = runner.paperController ?? runner.capitalController;
        controller?.attachIndicator(indicator);
    }

    /* ── the list and the head ───────────────────────────────────────────── */

    const listItems = new Map<string, {
        item: HTMLButtonElement;
        dot: HTMLElement;
        name: HTMLElement;
        what: HTMLElement;
    }>();

    /* Headings only while something is running: with nothing running, "Not running" over the
     * whole list would be a label for the obvious. */
    const runningHead = doc.createElement('div');
    runningHead.className = 'midorii-bot-group';
    runningHead.textContent = 'Running';
    const idleHead = doc.createElement('div');
    idleHead.className = 'midorii-bot-group';
    idleHead.textContent = 'Not running';

    function paintList(): void {
        const all = engine.list();
        for (const [id, row] of listItems) {
            if (all.some(bot => bot.id === id)) continue;
            row.item.remove();
            listItems.delete(id);
        }
        const isRunning = (id: string): boolean => {
            const state = engine.status(id);
            return state === 'running' || state === 'starting' || state === 'stopping';
        };
        const active = all.filter((bot) => isRunning(bot.id));
        const idle = all.filter((bot) => !isRunning(bot.id));
        const grouped = active.length > 0;
        const bots = [...active, ...idle];
        const sequence: HTMLElement[] = [];
        if (grouped) sequence.push(runningHead);
        for (const [index, bot] of bots.entries()) {
            if (grouped && index === active.length && idle.length > 0) sequence.push(idleHead);
            const status = engine.status(bot.id);
            let entry = listItems.get(bot.id);
            if (!entry) {
                const item = doc.createElement('button');
                item.className = 'midorii-bot-item';

                const row = doc.createElement('div');
                row.className = 'midorii-bot-item-head';
                const dot = doc.createElement('span');
                dot.className = 'midorii-bot-dot';
                const name = doc.createElement('b');
                row.append(dot, name);

                const what = doc.createElement('span');
                item.append(row, what);
                item.onclick = () => {
                    if (!maySwitchBot(bot.id)) return;
                    selected = bot.id;
                    paint();
                };
                item.oncontextmenu = (e) => {
                    e.preventDefault();
                    const current = engine.find(bot.id);
                    if (current) openListMenu(current, item, e.clientX, e.clientY);
                };
                entry = { item, dot, name, what };
                listItems.set(bot.id, entry);
            }
            const { item, dot, name, what } = entry;
            if (bot.id === selected) item.dataset.active = '1';
            else delete item.dataset.active;
            dot.dataset.state = status;
            name.textContent = bot.name;
            const spec = STRATEGIES[bot.strategy];
            what.textContent = `${spec?.name ?? bot.strategy} · ${bot.symbol || 'no asset'} · `
                + `${bot.venue === 'capital' ? 'live' : 'paper'}`;
            sequence.push(item);
        }
        if (!grouped) runningHead.remove();
        if (!grouped || idle.length === 0) idleHead.remove();
        // Moving a pressed control also interrupts a native click, so only what is out of place moves.
        for (const [position, node] of sequence.entries()) {
            if (list.children[position] !== node) list.insertBefore(node, list.children[position] ?? null);
        }
    }

    function figure(caption: string, text: string, tone?: 'up' | 'down'): HTMLElement {
        const el = doc.createElement('span');
        el.className = 'midorii-bot-fig';
        const small = doc.createElement('small');
        small.textContent = caption;
        const value = doc.createElement('b');
        value.textContent = text;
        if (tone) value.classList.add(tone);
        el.append(small, value);
        return el;
    }

    const title = doc.createElement('div');
    title.className = 'midorii-bot-title';
    const headName = doc.createElement('b');
    const sub = doc.createElement('span');
    title.append(headName, sub);
    const figs = doc.createElement('span');
    figs.className = 'midorii-bot-figs';
    const statusNote = doc.createElement('p');
    statusNote.className = 'midorii-bot-status-note';
    statusHost.append(figs, statusNote);
    const tabs = doc.createElement('span');
    tabs.className = 'midorii-bot-tabs';
    const paneButtons = new Map<Pane, HTMLButtonElement>();
    for (const [id, label] of [['live', 'Live'], ['settings', 'Settings']] as const) {
        const b = doc.createElement('button');
        b.className = 'midorii-bot-tab';
        b.textContent = label;
        b.onclick = () => { pane = id; paint(); };
        paneButtons.set(id, b);
        tabs.appendChild(b);
    }
    const toggle = button('Start', 'primary');
    toggle.onclick = () => {
        const bot = engine.find(selected);
        if (!bot) return;
        const stopped = engine.status(bot.id) === 'stopped' || engine.status(bot.id) === 'failed';
        const problem = stopped ? problemOf(bot) : null;
        if (problem) {
            // Nothing to start yet: take the person to the step that is missing something.
            pendingSection = problem.section;
            pane = 'settings';
            paint();
            return;
        }
        void toggleBot(bot);
    };

    const layoutButton = button('Layout');
    attachLayoutMenu(layoutButton, root, layoutStore);

    function paintHead(bot: BotConfig | undefined): void {
        if (!bot) {
            head.replaceChildren();
            return;
        }
        // Feed updates must preserve the controls between pointer down and pointer up.
        if (title.parentElement !== head) head.append(title, tabs, layoutButton, toggle);
        layoutButton.hidden = pane !== 'live';
        const runner = engine.displayRunner(bot.id);
        const status = engine.status(bot.id);
        headName.textContent = bot.name;
        delete sub.dataset.error;
        delete sub.dataset.dirty;
        if (status === 'failed' && runner?.error) {
            sub.textContent = runner.error;
            sub.dataset.error = '1';
        } else if (status === 'running') {
            const refusal = runner?.refusal();
            sub.textContent = refusal
                ? `Running · not trading: ${refusal}`
                : `Running · watching for a setup · ${runner?.barCount ?? 0} bars`;
        } else if (status === 'starting') {
            sub.textContent = 'Starting…';
        } else if (status === 'stopping') {
            sub.textContent = 'Stopping · saving the latest account state…';
        } else if (runner?.paperController || runner?.capitalController) {
            sub.textContent = 'Stopped · last account and activity retained for review';
        } else {
            sub.textContent = `Stopped · ${STRATEGIES[bot.strategy]?.name ?? bot.strategy} on ${bot.symbol || 'no asset'}`;
        }
        if (formFor === bot.id && form?.dirty) {
            sub.textContent = 'Unsaved settings · Save & Start uses the selected asset';
            sub.dataset.dirty = '1';
        }
        figs.replaceChildren();
        const hasAccount = Boolean(runner && (runner.paperController || runner.capitalController));
        figs.hidden = !hasAccount;
        statusNote.hidden = hasAccount;
        statusNote.textContent = 'Start the bot to see its account figures here.';
        if (runner && (runner.paperController || runner.capitalController)) {
            const equity = runner.equity();
            const move = equity - bot.balance;
            figs.append(
                figure('Equity', formatMoney(equity)),
                ...(bot.venue === 'paper'
                    ? [figure('Since start', formatSignedMoney(move), move === 0 ? undefined : move > 0 ? 'up' : 'down')]
                    : []),
                figure('Open', String(runner.openPositions())),
                figure('Resting', String(runner.restingOrders())),
                figure('Today', String(runner.todaysTrades)),
            );
        }
        for (const [id, b] of paneButtons) {
            if (pane === id) b.dataset.active = '1';
            else delete b.dataset.active;
        }
        const stopped = status === 'stopped' || status === 'failed';
        const problem = stopped ? problemOf(bot) : null;
        toggle.textContent = !stopped
            ? 'Stop'
            : problem ? 'Finish setup' : (formFor === bot.id && form?.dirty ? 'Save & Start' : 'Start');
        const settingsTab = paneButtons.get('settings');
        if (settingsTab) {
            if (problem || (formFor === bot.id && form?.dirty)) settingsTab.dataset.attention = '1';
            else delete settingsTab.dataset.attention;
        }
        toggle.classList.toggle('vela-dialog-btn-primary', stopped);
        toggle.classList.toggle('vela-dialog-btn-danger', !stopped);
        toggle.disabled = status === 'stopping';
    }

    /* ── the list's right-click menu ─────────────────────────────────────── */

    /**
     * Delete / Edit / Duplicate on a bot in the list.
     *
     * The three things somebody does to a bot they are not currently watching, without
     * having to select it first and walk to the Settings tab for two of them. Nothing here
     * can START a bot — the same asymmetry the rest of this screen keeps: the ways in stay
     * deliberate, the ways to tidy up do not have to be.
     *
     * The menu does NOT change the selection. Right-clicking a bot to delete it should not
     * first put its market on the chart; the row it is about carries a ring instead.
     */
    let listMenu: Menu | null = null;
    /** The bot the open menu is about, and the row wearing the ring for it. */
    let menuFor = '';
    let menuRow: HTMLElement | null = null;

    function ensureListMenu(): Menu {
        if (listMenu) return listMenu;
        listMenu = new Menu({
            host: (root.closest('.vela-ui') as HTMLElement | null) ?? doc.body,
            items: [],
            placement: 'bottom-start',
            // Pointer-anchored action menu — the same shape the chart's own right-click menu uses.
            checkmarks: true,
            onOpenChange: (open) => {
                if (open) return;
                if (menuRow) delete menuRow.dataset.menu;
                menuRow = null;
            },
            onSelect: (id) => {
                /* Read back rather than closed over: a repaint between the right-click and the
                 * press is ordinary here, and the object the list drew may no longer be the
                 * stored one. A bot deleted in the meantime simply has nothing to act on. */
                const bot = engine.find(menuFor);
                if (!bot) return;
                if (id === 'edit') {
                    if (!maySwitchBot(bot.id)) return;
                    selected = bot.id;
                    pane = 'settings';
                    paint();
                } else if (id === 'duplicate') {
                    void duplicateBot(bot);
                } else if (id === 'delete') {
                    void deleteBot(bot);
                }
            },
        });
        return listMenu;
    }

    function openListMenu(bot: BotConfig, row: HTMLElement, x: number, y: number): void {
        menuFor = bot.id;
        if (menuRow) delete menuRow.dataset.menu;
        menuRow = row;
        row.dataset.menu = '1';

        const menu = ensureListMenu();
        menu.setItems([
            { id: 'edit', label: 'Edit', icon: 'gear' },
            { id: 'duplicate', label: 'Duplicate', icon: 'clone' },
            /* Last and set apart: the only one of the three that destroys something. What it
             * destroys is the account, not the record — see BotEngine.remove, which files a
             * run before it goes. */
            { id: 'delete', label: 'Delete', icon: 'trash', separatorBefore: true },
        ]);
        menu.openAt(x, y);
    }

    /* ── acting ──────────────────────────────────────────────────────────── */

    async function createBot(): Promise<void> {
        if (!maySwitchBot()) return;
        const first = Object.keys(STRATEGIES)[0];
        if (!first) {
            opts.notify('This build has no strategies to run.', 'error');
            return;
        }
        /* A new bot needs an explicit asset choice. The bot chart may still show the previous
         * bot's market, which must never become this bot's trading instruction by accident. */
        const bot = newBot(first, '');
        try {
            const settings = (await window.midori.strategies.load())[first] ?? {};
            bot.params = resolveStrategyParams(first, settings);
            bot.timeframe = savedStrategyTimeframe(settings) ?? bot.timeframe;
            await engine.add(bot);
            selected = bot.id;
            pane = 'settings';
            paint();
        } catch (err) {
            opts.notify(err instanceof Error ? err.message : String(err), 'error');
        }
    }

    /**
     * Make a second bot from an existing one's settings.
     *
     * The copy is a bot, not a clone. It gets a key of its own, it starts stopped whatever
     * the original was doing, and it brings none of the original's account or history with
     * it — those belong to the bot that traded them, and a duplicate showing trades it never
     * made would be a lie the first time anybody read its equity.
     *
     * It opens on Settings, because the reason to duplicate a bot is almost always to change
     * one thing about it.
     */
    async function duplicateBot(bot: BotConfig): Promise<void> {
        if (!maySwitchBot()) return;
        const copy: BotConfig = {
            ...bot,
            id: botId(),
            name: copyName(bot.name),
            // Copied one level down: the form writes whole objects back, but a shared
            // reference here would make editing the copy edit the original's settings too.
            params: { ...bot.params },
            guards: { ...bot.guards },
            enabled: false,
            createdAt: Date.now(),
        };
        try {
            await engine.add(copy);
            selected = copy.id;
            pane = 'settings';
            paint();
        } catch (err) {
            opts.notify(err instanceof Error ? err.message : String(err), 'error');
        }
    }

    /** A name for the copy that is not the original's: “X copy”, then “X copy 2”. Names are
     *  never keys — this is so the list can be read, not so it stays unique. */
    function copyName(name: string): string {
        const taken = new Set(engine.list().map((b) => b.name));
        const base = `${name} copy`;
        let candidate = base;
        for (let n = 2; taken.has(candidate); n += 1) candidate = `${base} ${n}`;
        return candidate;
    }

    async function toggleBot(bot: BotConfig): Promise<void> {
        const status = engine.status(bot.id);
        try {
            if (status === 'stopped' || status === 'failed') {
                if (formFor === bot.id && form?.dirty && !await form.save()) {
                    pane = 'settings';
                    paint();
                    return;
                }
                const current = engine.find(bot.id);
                if (!current) return;
                let allowLive = false;
                let revision: number | undefined;
                if (current.venue === 'capital') {
                    const environment = await window.midori.capital.environment();
                    revision = environment.revision;
                    if (environment.live) {
                        const account = await window.midori.capital.account();
                        allowLive = await askToArm(root, {
                            live: true, botName: current.name, epic: current.symbol,
                            accountName: account?.accountName, currency: account?.currency,
                            balance: account?.balance.balance,
                        });
                        if (!allowLive) return;
                    }
                }
                await engine.start(bot.id, { allowLive, revision });
                pane = 'live';
            } else {
                await engine.stop(bot.id);
            }
        } catch (err) {
            opts.notify(err instanceof Error ? err.message : String(err), 'error');
        }
        paint();
    }

    async function saveBot(next: BotConfig): Promise<void> {
        await engine.update(next);
        paint();
    }

    async function deleteBot(bot: BotConfig): Promise<void> {
        try {
            await engine.remove(bot.id);
            if (selected === bot.id) selected = engine.list()[0]?.id ?? '';
            paint();
        } catch (err) {
            opts.notify(err instanceof Error ? err.message : String(err), 'error');
        }
    }

    async function resetAccount(bot: BotConfig): Promise<void> {
        try {
            const filed = await engine.resetAccount(bot.id);
            opts.notify(
                filed
                    ? `“${bot.name}” was filed as a run (${filed}) and starts again on ${bot.balance}.`
                    : `“${bot.name}” had traded nothing, so its account simply starts again.`,
                'success',
            );
            paint();
        } catch (err) {
            opts.notify(err instanceof Error ? err.message : String(err), 'error');
        }
    }

    /* ── drawing ─────────────────────────────────────────────────────────── */

    function paintEmpty(): void {
        livePane.hidden = true;
        settingsPane.hidden = false;
        settingsInner.replaceChildren();
        const empty = doc.createElement('div');
        empty.className = 'midorii-bot-empty';
        const h = doc.createElement('h2');
        h.textContent = engine.ready ? 'No bots yet' : 'Reading the bots…';
        const p1 = doc.createElement('p');
        p1.textContent = 'A bot runs one of the strategies from the Strategies tab against a live '
            + 'feed, on its own account, and keeps running while you look at something else. It '
            + 'uses the same rules a backtest does — what changes is only that nobody has to be '
            + 'watching.';
        const p2 = doc.createElement('p');
        p2.textContent = 'Before it may trade unattended it is given conditions a backtest never '
            + 'needed: which hours, how many trades a day, what it does about a losing day, and '
            + 'what it refuses to trade through. None of them can open a trade — every one can '
            + 'refuse one.';
        empty.append(h, p1, p2);
        settingsInner.appendChild(empty);
    }

    function paint(): void {
        const bots = engine.list();
        if (bots.length > 0 && !bots.some((b) => b.id === selected)) selected = bots[0]!.id;

        barLabel.textContent = bots.length === 0
            ? 'Trading Bot'
            : `Trading Bot · ${bots.length} ${bots.length === 1 ? 'bot' : 'bots'}`
              + (engine.runningCount > 0 ? ` · ${engine.runningCount} running` : '');

        paintList();

        const bot = bots.find((b) => b.id === selected);
        if (!bot) {
            head.replaceChildren();
            paintEmpty();
            return;
        }

        paintHead(bot);
        const status = engine.status(bot.id);
        const running = status === 'running' || status === 'starting' || status === 'stopping';

        livePane.hidden = pane !== 'live';
        settingsPane.hidden = pane !== 'settings';

        if (pane === 'live') {
            /* Only while the tab is actually on screen. The bots are started at launch, with
             * this view built and this root still hidden — and a chart built inside a hidden
             * container measures itself at zero by zero. Everything anchored to the plot then
             * lands in its top-left corner and stays there, because nothing re-measures a
             * chart that was never wrong about its own size, it was wrong about being
             * visible. The tab switch calls refresh(), which paints again with a real box. */
            if (!host.hidden) {
                syncChart(bot);
                paintLive(bot, engine.displayRunner(bot.id), status !== 'running');
            }
        } else {
            const accountTrades = engine.displayRunner(bot.id)?.paperController?.broker.trades.length ?? 0;
            if (formFor !== bot.id || !form) {
                formFor = bot.id;
                formBot = bot;
                formReadOnly = running;
                formAccountTrades = accountTrades;
                formCapitalConfigured = capitalConfigured;
                settingsInner.replaceChildren();
                form = mountBotForm(doc, {
                    bot,
                    readOnly: running,
                    capitalConfigured,
                    accountTrades,
                    venueTimeframes,
                    pickAsset: () => assets.choose(),
                    onSave: saveBot,
                    onDirtyChange: () => schedulePaint(),
                    onDraftChange: () => schedulePaint(),
                    onDelete: () => {
                        const current = engine.find(bot.id);
                        if (current) void deleteBot(current);
                    },
                    onResetAccount: () => {
                        const current = engine.find(bot.id);
                        if (current) void resetAccount(current);
                    },
                });
                settingsInner.appendChild(form.el);
            } else if (
                formBot !== bot
                || formReadOnly !== running
                || formAccountTrades !== accountTrades
                || formCapitalConfigured !== capitalConfigured
            ) {
                formBot = bot;
                formReadOnly = running;
                formAccountTrades = accountTrades;
                formCapitalConfigured = capitalConfigured;
                form.reset(bot, running, accountTrades, capitalConfigured);
            }
            if (pendingSection) {
                form.jumpTo(pendingSection);
                pendingSection = null;
            }
        }
    }

    /** The safety rules panel: what the bot is set to, and whether any of it is in the way now. */
    let rulesDrawn = '';
    function paintRules(bot: BotConfig, runner: BotRunner | null): void {
        const running = engine.status(bot.id) === 'running';
        const refusal = running ? runner?.refusal() ?? null : null;
        const sentence = refusal
            ? `Not trading right now: ${refusal}`
            : running
                ? 'No rule is blocking a trade right now.'
                : 'These apply while the bot runs. Change them under Settings → Safety rules.';
        const rows = ruleRows(bot.guards);
        // The panel is repainted with every tick; rebuilding identical rows would only cost frames.
        const key = JSON.stringify([bot.id, sentence, rows]);
        if (key === rulesDrawn) return;
        rulesDrawn = key;

        const now = doc.createElement('p');
        now.className = 'midorii-bot-rules-now';
        if (refusal) now.dataset.blocked = '1';
        now.textContent = sentence;
        const lines = rows.map((r) => {
            const row = doc.createElement('div');
            row.className = 'midorii-bot-rule';
            row.dataset.on = r.on ? '1' : '0';
            const label = doc.createElement('span');
            label.textContent = r.label;
            const value = doc.createElement('b');
            value.textContent = r.value;
            row.append(label, value);
            return row;
        });
        rulesHost.replaceChildren(now, ...lines);
    }

    /** The live half: the account card, the dock and the tape, including the retained readout
     *  after a runner has stopped. */
    function paintLive(bot: BotConfig, runner: BotRunner | null, readOnly = false): void {
        const paper = runner?.paperController;
        const tradeCount = paper?.history().length ?? 0;
        accountLabel.textContent = bot.venue === 'paper' ? 'PAPER · BOT ACCOUNT' : 'CAPITAL.COM · BOT ACCOUNT';
        accountTitle.textContent = bot.symbol || 'Choose an asset in Settings';
        accountHint.textContent = bot.venue === 'paper'
            ? 'This is the selected bot’s account. Chart studies can draw setups; only the trades below confirm an execution. The Chart tab has a separate account.'
            : 'This bot’s orders appear in Activity below. The Chart tab has a separate account.';
        accountLink.textContent = bot.venue === 'paper'
            ? `View bot trades · ${tradeCount}` : 'View bot activity';
        tape.render(runner, bot);
        paintRules(bot, runner);
        if (!runner) {
            /* The card is left alone rather than hidden. It owns its own visibility — a
             * person can put it away with its corner button and the Settings tab can switch
             * it off — and reaching past that from here both fought those and skipped the
             * reflow that keeps it inside the plot. An empty account reads as empty. */
            strip?.update(EMPTY_ACCOUNT);
            dock?.render({ positions: [], orders: [] });
            return;
        }
        if (paper) {
            strip?.update(paper.account());
            dock?.render(paper.book(), { stats: paper.stats() });
        } else if (runner.capitalController) {
            strip?.update(EMPTY_ACCOUNT);
            dock?.render(runner.capitalController.book());
        } else {
            strip?.update(EMPTY_ACCOUNT);
            dock?.render({ positions: [], orders: [] });
        }
        if (dock) {
            if (readOnly) dock.el.dataset.readonly = '1';
            else delete dock.el.dataset.readonly;
            for (const control of dock.el.querySelectorAll<HTMLButtonElement | HTMLInputElement>(
                '.midorii-dock-btn, .midorii-dock-price',
            )) {
                if (readOnly) control.disabled = true;
            }
        }
    }

    /** Repaints are driven by a running bot's every tick, which is far more often than a
     *  screen needs redrawing. One per frame is plenty and keeps the chart smooth. */
    let painting = false;
    function schedulePaint(): void {
        if (painting) return;
        painting = true;
        requestAnimationFrame(() => {
            painting = false;
            if (!host.hidden) paint();
        });
    }

    paint();

    return {
        get selectedBotId(): string | null {
            return selected || null;
        },
        selectBot(id: string): void {
            if (!engine.find(id)) return;
            if (!maySwitchBot(id)) return;
            selected = id;
            pane = 'live';
            paint();
        },
        async refresh(): Promise<void> {
            await refreshCapitalEnvironment();
            if (!engine.ready) {
                try {
                    await engine.load();
                } catch (err) {
                    opts.notify(
                        `The stored bots could not be read: ${err instanceof Error ? err.message : String(err)}`,
                        'error',
                    );
                }
            }
            paint();
        },
        setTheme(theme: VelaTheme): void {
            ws?.setTheme(theme);
            applyThemeTokens(chartHost, theme);
        },
    };
}
