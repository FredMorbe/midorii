import { timeframeToMs } from '../../../src/data/timeframe';
import type { DataProvider } from '../../../src/plugin';
import type { OHLCV } from '../../../src/core/model/ohlcv';
import type { RunnableStrategy } from '../../../shared/engine/backtest';
import type { OrderSpec } from '../../../shared/engine/broker.js';
import { STRATEGIES, buildStrategy } from '../strategies';
import { riskManagement } from '../../../shared/strategies/risk.js';
import { guardRefusal, guardsOf, insideWindow, resolveGuards, type GuardState, type LiveGuards } from '../strategies/liveGuards';
import type { StrategyParams } from '../strategies/types';
import { CapitalController } from '../trading/CapitalController';
import { PaperController } from '../trading/PaperController';
import { DEFAULT_PAPER_SETTINGS, type PaperSettings } from '../trading/paperSettings';
import { recordTrade } from '../trading/liveJournal';
import type {
    MidoriBotAccount,
    MidoriBotAccountSnapshot,
    MidoriBotCapitalOwnership,
    MidoriBotGuardRuntime,
    MidoriBotStrategyRuntime,
} from '../midori';
import { botAccountWriter, loadBotAccount } from './botAccountStore';
import { accountDayOpen, accountRiskRefusal, capitalAccountKey, loadAccountRisk } from './accountRisk';
import { liveAccount, paperAccount, type BotAccount, type LiveBotAccount } from './botAccount';
import { botContext } from './botContext';
import { BotLog } from './botLog';
import { paperInstrument } from './paperInstrument';
import {
    HISTORY_BARS,
    MAX_HISTORY_BARS,
    guardParamsOf,
    paramsOf,
    providerOf,
    startRefusal,
    tickerOf,
    type BotConfig,
} from './botTypes';

/**
 * One trading bot, running.
 *
 * What a bot IS, mechanically: a feed, an account, and a strategy that is handed each
 * closed bar in turn. Everything below is one of those three, plus the guards that sit
 * between the strategy and the account.
 *
 * Why the strategy is rebuilt on every bar
 * ---------------------------------------
 * A strategy in this app does its detection ONCE, in `build(params, bars)`, and the
 * backtest loop then walks the result. That is the right shape for history — the bars are
 * all there before anything runs — and it is not a shape a live feed has. So every time a
 * bar closes, the bar is appended and the strategy is built again over the whole history.
 * The new bar is then the only one that can have confirmed anything new, and the context
 * hands the strategy exactly that bar's events.
 *
 * This is deliberately the expensive-but-correct option. The alternative — an incremental
 * detector that updates in place — would be a second implementation of every detector in
 * the chart core, free to disagree with the one the backtest used, on the one axis where
 * disagreement is invisible until it costs money. A rebuild over the bot's window once every
 * five minutes is nothing; a detector that drifts is everything.
 *
 * Why the history is a window, and when it moves
 * ----------------------------------------------
 * The rebuild is cheap over the bot's window and stops being cheap if the history is allowed
 * to grow: measured on this machine the heaviest strategy takes 15ms over 3,000 bars, 25ms
 * over 5,000 and 142ms over 20,000 — and a bot on one-minute bars collects 1,440 a day. So
 * the history is trimmed back to {@link HISTORY_BARS}.
 *
 * The difficulty is that trimming the front moves every bar INDEX, and strategies store
 * indices in `ctx.state`: the Relative Volume ORB keeps the bar it means to be flat by, Silver
 * Bullet the bar its order expires on. Shifting the history under one of those would make it
 * go flat on the wrong bar, or never — silently.
 *
 * The way out is not to renumber anything. It is to trim only when the strategy is provably
 * holding nothing that a renumbering could invalidate: no position, no resting order, and an
 * inert `ctx.state`. Every strategy in this app clears its state the moment its setup is done
 * — daily for the two session strategies — so that condition comes round several times a day
 * and the window costs nothing to keep. A strategy that never let go would be caught by
 * {@link MAX_HISTORY_BARS}, where the history is cut anyway and the state dropped with it,
 * loudly. See {@link trim}.
 *
 * The alternative considered and rejected was renumbering the events against an offset. It
 * would have meant finding every bar index inside every detector's own event objects —
 * `sessionEndIndex`, `expiryIndex`, `gapStartIndex`, a dozen more — by their names, and a
 * detector that ever named one differently would have broken without a symptom.
 *
 * The bot brings its own account, and keeps it
 * --------------------------------------------
 * A paper bot builds its own engine rather than sharing the chart's paper account, and a
 * live bot its own view of the venue. Two reasons, and the second is the real one: a shared
 * account would mix hand-placed trades with automated ones in a ledger where neither could
 * be told from the other afterwards, and a bot's guards — its daily limits, its trade count
 * — would be counting somebody else's trades.
 *
 * That account is written to disk as it moves and picked back up when the bot starts again,
 * the same way the chart's is. A bot is meant to run for weeks, and one whose weeks vanished
 * every time the app closed would be a bot nobody could judge — the trades ARE the evidence,
 * and there would be nothing else anywhere to say what it had done.
 */

/** How often the guards are re-checked between bars. Bar closes are the only moment a
 *  strategy acts, but a window ending or a feed going quiet is not on a bar boundary. */
const WATCH_MS = 5_000;

/** How far back from the newest closed bar the stored strategy state pins the history. The
 *  first is the bar the indices are lined up on; the rest prove the line-up is the same
 *  series and not one with a bar more or less in it. */
const ANCHOR_OFFSETS = [0, 1, 5, 50, 500];

/** How long a failed gap repair waits before the next update may try again. */
const GAP_RETRY_MS = 5_000;

/** How long an end-of-window flatten that has not left the bot flat waits before it is sent again. */
const FLATTEN_RETRY_MS = 30_000;

/** How long a quiet feed is left alone before it is reopened, and where the doubling stops. */
const FEED_RESTART_MS = 60_000;
const FEED_RESTART_MAX_MS = 15 * 60_000;

export type BotStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'failed';

export interface BotAccountSummary {
    balance: number | null;
    dailyLossRoom: number | null;
    realised: number | null;
    unrealised: number | null;
    currency: string | null;
    live: boolean;
}

export interface BotRunnerOptions {
    /** A person explicitly armed this live start. Never restored from disk. */
    allowLive?: boolean;
    revision?: number;
    bot: BotConfig;
    /** Every market source the app can reach — the bot builds its own instance from these,
     *  never the chart's, so it watches its market whatever is on screen. */
    providers: Record<string, () => DataProvider>;
    /** Told whenever anything about the bot changed, so a screen can repaint. */
    onChange?: () => void;
    /**
     * What every running bot on a venue account holds between them, this one included.
     *
     * Only the engine can answer it. Without one, a runner counts itself alone.
     */
    accountExposure?: (account: string) => number;
}

export class BotRunner {
    readonly log = new BotLog();
    private config: BotConfig;
    private readonly providers: Record<string, () => DataProvider>;
    /** Read from the venue immediately before a Capital.com account is built. */
    private isLive = false;
    private readonly allowLive: boolean;
    private readonly armedRevision: number | undefined;
    private readonly accountExposure: ((account: string) => number) | null;

    private state: BotStatus = 'stopped';
    /** Why it stopped, when it stopped by itself. */
    private failure: string | null = null;

    private paper: PaperController | null = null;
    private capital: CapitalController | null = null;
    private account: BotAccount | null = null;

    /** Closed bars, oldest first. Grows; see the header on why it is never trimmed. */
    private bars: OHLCV[] = [];
    /** The bar still forming, as the feed last reported it. */
    private forming: OHLCV | null = null;
    private unsubscribe: (() => void) | null = null;
    private watchdog: ReturnType<typeof setInterval> | null = null;
    /**
     * Which lifetime is current.
     *
     * Starting crosses two asynchronous boundaries before the feed is opened. A stop can
     * happen at either one. The number makes the old continuation recognise that it no
     * longer owns this runner, clean up anything it managed to build, and leave without
     * subscribing after the stop that cancelled it.
     */
    private lifetime = 0;

    /** The account on its way to disk — trailing, so a burst of ticks is one write. */
    private persistenceError: string | null = null;
    private strategyError: string | null = null;
    private reseeding = false;
    /** A gap in the feed is being repaired. Bar closes wait until the history is whole. */
    private recovering = false;
    /** The newest update that arrived during a repair, played once it has finished. */
    private heldBar: OHLCV | null = null;
    /** The earliest moment a failed repair may be tried again. */
    private gapRetryAt = 0;
    /** Why the strategy could not be built on the newest bar, until a later bar builds again. */
    private buildError: string | null = null;
    /** The window has ended with "flat at the end" set, and the bot is not flat yet. */
    private flattenDue = false;
    /** The daily loss limit was reached with "flat at the limit" set, and the bot is not flat yet. */
    private lossFlattenDue = false;
    private flattenRetryAt = 0;
    /** When the current subscription was opened, for a feed that never speaks at all. */
    private feedOpenedAt = 0;
    private feedRestartAt = 0;
    private feedRestartDelay = FEED_RESTART_MS;
    private readonly writer = botAccountWriter((error) => {
        this.persistenceError = `The bot account could not be saved: ${error instanceof Error ? error.message : String(error)}`;
        this.log.note('error', this.persistenceError + '. New entries are blocked until its account can be saved again.');
        this.changed();
    }, () => {
        if (!this.persistenceError) return;
        this.persistenceError = null;
        this.log.note('info', 'The bot account is being saved again. New entries are no longer blocked by it.');
        this.changed();
    });
    /** The strategy's own store, kept here so it survives every rebuild. */
    private strategyState: Record<string, unknown> = {};
    /** The strategy state read from disk, until {@link seed} has tried to line it up. */
    private storedStrategy: MidoriBotStrategyRuntime | null = null;
    /** Whether this start carried over everything the strategy remembered. */
    private memoryKept = false;
    /** The live account's own order ids, stored with the state that refers to them. */
    private live: LiveBotAccount | null = null;
    /**
     * Whether `strategy.init` has run for this start.
     *
     * The backtest calls it once, before the loop's first bar, so a strategy can seed
     * `ctx.state` before `onBar` ever reads it. The bot rebuilds `strategy` fresh on every
     * bar — detection has to see the growing history — so there is no single instance to
     * call it on the way the backtest does; this flag is what makes "once" mean the same
     * thing here as it does there; see {@link closeBar}.
     */
    private initialized = false;
    /**
     * The bot's settings, resolved.
     *
     * Read again in {@link start}, and defaulted here rather than resolved: constructing a
     * runner must not be able to throw. A bot whose strategy this build no longer has is
     * exactly the bot somebody needs to be able to select, look at and edit — and one whose
     * constructor threw could not even be listed, let alone fixed. {@link start} is where
     * that is refused, in words, before anything is subscribed to.
     */
    private guards: LiveGuards;
    private params: StrategyParams;

    /** What the guards count. See {@link resetDay}. */
    private dayKey = '';
    private dayOpenEquity = 0;
    private tradesToday = 0;
    private lastLossAt: number | null = null;
    /** Guard state read before the account is marked at the latest price. Applied in seed. */
    private restoredGuards: MidoriBotGuardRuntime | null = null;
    /** Venue ids this bot alone may manage. Null for a paper bot. */
    private capitalOwnership: MidoriBotCapitalOwnership | null = null;
    /** Runtime writes start only after account and guard restoration have completed. */
    private runtimeReady = false;
    /** A resting order can fill during startup, before the restored daily count is applied. */
    private pendingLiveEntries = 0;
    private lastTickAt: number | null = null;
    /** How many trades the account had booked at the last check, so a newly closed one can
     *  be spotted without the engine having to tell anybody. */
    private seenTrades = 0;
    /** Filled paper entry orders already included in today's count. Kept across day edges so
     * historical fills cannot be counted again after midnight. */
    private seenPaperEntries = new Set<number>();
    /** Positions whose managed break-even or trail has already been logged, as `be:<id>` and
     *  `trail:<id>` — each is a one-time event, and the account does not say when it happens. */
    private seenManaged = new Set<string>();
    /** Whether the window was open at the last watch — a close is an edge, not a state. */
    private wasInsideWindow = true;

    onChange: (() => void) | null;

    constructor(opts: BotRunnerOptions) {
        this.allowLive = opts.allowLive === true;
        this.armedRevision = opts.revision;
        this.accountExposure = opts.accountExposure ?? null;
        this.config = opts.bot;
        this.providers = opts.providers;
        this.onChange = opts.onChange ?? null;
        this.guards = guardsOf(safeGuardParams(opts.bot));
        this.params = safeParams(opts.bot);
        this.log.onChange = () => this.onChange?.();
    }

    get bot(): BotConfig {
        return this.config;
    }

    get status(): BotStatus {
        return this.state;
    }

    /** Why it is not running, when that is a failure rather than a choice. */
    get error(): string | null {
        return this.failure;
    }

    /** The paper account behind this bot, or null on a live one — for a screen that reads
     *  the engine's own figures (the account card, the trade dock, the history). */
    get paperController(): PaperController | null {
        return this.paper;
    }

    /** The venue client behind this bot, or null on a paper one. */
    get capitalController(): CapitalController | null {
        return this.capital;
    }

    /** What the bot is worth right now, or 0 before it has an account. */
    equity(): number {
        return this.account?.equity() ?? 0;
    }

    /** The figures the app title bar can state from this bot's own account and guards. */
    accountSummary(): BotAccountSummary {
        const paper = this.paper;
        let balance: number | null = null;
        let realised: number | null = null;
        let unrealised: number | null = null;
        let currency: string | null = null;

        if (paper) {
            const figures = paper.account();
            balance = figures.cash;
            realised = figures.cash - figures.initialBalance;
            unrealised = figures.open ?? 0;
        } else if (this.capital) {
            const open = this.capital.book().positions.reduce((sum, position) => sum + position.unrealized, 0);
            balance = this.capital.equity() - open;
            unrealised = open;
            currency = this.capital.accountCurrency();
        }

        const limit = this.guards.dailyLossLimit;
        const dailyLossRoom = limit > 0 && this.dayOpenEquity > 0 && this.account
            ? this.dayOpenEquity * (limit / 100) + (this.account.equity() - this.dayOpenEquity)
            : null;

        return {
            balance,
            dailyLossRoom,
            realised,
            unrealised,
            currency,
            live: this.isLive,
        };
    }

    /** The last price it has seen. */
    price(): number {
        return this.account?.price() ?? 0;
    }

    /** What it holds. */
    openPositions(): number {
        return this.account?.positions().length ?? 0;
    }

    /** What it has waiting on the book. */
    restingOrders(): number {
        return this.account?.pending().length ?? 0;
    }

    /** Entries made in the current UTC day. */
    get todaysTrades(): number {
        return this.tradesToday;
    }

    /** Why the bot would refuse to open something right now, or null. What the screen shows
     *  as its live reason for sitting still — read on every repaint, never cached. */
    refusal(): string | null {
        if (this.state !== 'running' || !this.account) return null;
        if (this.persistenceError || this.strategyError || this.buildError) {
            return this.persistenceError ?? this.strategyError ?? this.buildError;
        }
        const interval = timeframeToMs(this.config.timeframe);
        const grace = Math.max(5_000, this.guards.staleFeedSeconds * 1_000);
        if (this.forming && this.forming.time + interval + grace < Date.now()) {
            return 'The latest candle is too old. New entries wait for current market data.';
        }
        return guardRefusal(this.guards, this.guardState()) ?? this.accountRefusal();
    }

    /** The venue account this bot trades on, as its shared limits are keyed, or null on paper. */
    get accountKey(): string | null {
        return this.capital ? capitalAccountKey(this.isLive) : null;
    }

    /**
     * What this bot holds or may be about to hold, for the account's shared position limit.
     *
     * The larger of what the venue shows and what the bot is known to own, because an
     * accepted deal is owned a read before it is visible. An instruction still in flight, or
     * one whose outcome is unknown, counts as one more: two bots deciding on the same bar
     * would otherwise both see room for the same last position.
     */
    exposure(): number {
        const visible = this.openPositions() + this.restingOrders();
        const owned = this.capitalOwnership
            ? this.capitalOwnership.positionDealIds.length + this.capitalOwnership.workingOrderDealIds.length
            : 0;
        const unsettled = this.capital?.busy || this.capitalOwnership?.uncertain ? 1 : 0;
        return Math.max(visible, owned) + unsettled;
    }

    /** Why the venue account's shared limits turn an entry away, or null. See accountRisk.ts. */
    private accountRefusal(): string | null {
        const account = this.accountKey;
        if (!account || !this.capital) return null;
        let risk;
        try {
            risk = loadAccountRisk(account);
        } catch {
            return 'The account’s limits for bots could not be read. New entries wait.';
        }
        if (!(risk.maxBotPositions > 0) && !(risk.dailyLossPct > 0)) return null;
        const equity = this.capital.equity();
        return accountRiskRefusal(risk, {
            openPositions: this.accountExposure?.(account) ?? this.exposure(),
            equity,
            dayOpenEquity: risk.dailyLossPct > 0 ? accountDayOpen(account, equity) : 0,
        });
    }

    /** Whether the clock currently allows trading. */
    inWindow(): boolean {
        return insideWindow(this.guards, Date.now());
    }

    /** How many bars of history the strategy is running on. */
    get barCount(): number {
        return this.bars.length;
    }

    /** When the feed last spoke, or null. */
    get lastTick(): number | null {
        return this.lastTickAt;
    }

    /* ── the life of a bot ───────────────────────────────────────────────── */

    /**
     * Start it: build the account, seed the history, open the feed.
     *
     * Everything that can be refused is refused before anything is subscribed to or any
     * account exists, so a misconfigured bot fails on the press that started it rather
     * than three seconds later in a log nobody is reading.
     */
    async start(): Promise<void> {
        if (this.state === 'running' || this.state === 'starting') return;

        const refused = startRefusal(this.config);
        if (refused) {
            this.fail(refused);
            throw new Error(refused);
        }

        this.state = 'starting';
        this.failure = null;
        const lifetime = ++this.lifetime;
        this.runtimeReady = false;
        this.pendingLiveEntries = 0;
        this.initialized = false;
        this.strategyError = null;
        this.recovering = false;
        this.heldBar = null;
        this.gapRetryAt = 0;
        this.buildError = null;
        this.flattenDue = false;
        this.lossFlattenDue = false;
        this.flattenRetryAt = 0;
        this.feedRestartAt = 0;
        this.feedRestartDelay = FEED_RESTART_MS;
        this.restoredGuards = null;
        this.storedStrategy = null;
        this.memoryKept = false;
        this.live = null;
        this.capitalOwnership = null;
        this.paper = null;
        this.capital = null;
        this.account = null;
        this.changed();

        try {
            this.params = paramsOf(this.config);
            this.guards = guardsOf(guardParamsOf(this.config));

            const provider = this.provider();
            if (!provider.subscribe) {
                throw new Error(
                    `${providerOf(this.config.symbol) ?? 'That provider'} has no live feed — a bot needs one. `
                    + 'The local archive can be backtested and replayed, but not traded.',
                );
            }

            const supported = provider.info?.().supportedTimeframes;
            if (supported?.length && !supported.includes(this.config.timeframe)) {
                throw new Error(`The data provider does not support the ${this.config.timeframe} bar interval.`);
            }
            await this.buildAccount();
            if (!this.isCurrentStart(lifetime)) {
                this.teardown();
                return;
            }
            await this.seed(provider, lifetime);
            if (!this.isCurrentStart(lifetime)) {
                this.teardown();
                return;
            }

            this.openFeed(provider);
            this.watchdog = setInterval(() => this.watch(), WATCH_MS);

            this.state = 'running';
            const interval = /^\d+$/.test(this.config.timeframe) ? `${this.config.timeframe}m` : this.config.timeframe;
            this.log.note(
                'info',
                `Started on ${this.config.symbol} ${interval}, ${this.bars.length} bars of history, `
                + `${this.config.venue === 'capital' ? (this.isLive ? 'live money' : 'Capital.com demo') : 'paper'}.`,
            );
            const held = this.openPositions();
            const waiting = this.restingOrders();
            if ((held > 0 || waiting > 0) && !this.memoryKept) {
                /* The strategy's own store could not be carried over, and it is where a
                 * planned time exit or an order's expiry lives. */
                this.log.note(
                    'error',
                    `Picked up ${held} ${held === 1 ? 'position' : 'positions'} and ${waiting} resting `
                    + `${waiting === 1 ? 'order' : 'orders'} from before this start. What the strategy remembered about `
                    + 'them, such as a planned time exit or an order’s expiry, did not survive the restart. Their stops '
                    + 'and targets still apply; anything else has to be managed by hand.',
                );
            }
        } catch (err) {
            this.teardown();
            /* A stop owns the outcome now. A late rejection from the history or account
             * request it cancelled must not turn the stopped runner into a failure, or show
             * an error for an operation the person deliberately ended. */
            if (!this.isCurrentStart(lifetime)) return;
            const message = err instanceof Error ? err.message : String(err);
            this.fail(message);
            throw err;
        }
        this.changed();
    }

    /**
     * Stop it. Nothing is closed.
     *
     * A stopped bot is a bot that has stopped DECIDING, not one that has liquidated: a
     * position it left behind is still protected by the stop and target that went out with
     * it, and closing everything because somebody pressed stop would be the app making a
     * trading decision nobody asked it to make. The log says so, so it cannot be a surprise.
     */
    stop(): void {
        /* Invalidate a start before looking at the state. Its outstanding account/history
         * request may finish after this synchronous method returns. */
        this.lifetime += 1;
        if (this.state === 'stopped') return;
        const holding = this.openPositions();
        const waiting = this.restingOrders();
        this.teardown();
        /* The account is written on a delay, so the newest of it is still in flight. It is
         * already complete — nothing about stopping changes what the account did. Not awaited
         * here (stopping is a synchronous act, and the window closing calls this too); a
         * caller that is about to read the account back awaits {@link settle} instead. */
        this.persistRuntime();
        void this.writer.flush().catch(() => undefined);
        this.state = 'stopped';
        if (holding > 0 || waiting > 0) {
            this.log.note(
                'info',
                `Stopped, still holding ${holding} ${holding === 1 ? 'position' : 'positions'} and `
                + `${waiting} resting ${waiting === 1 ? 'order' : 'orders'} — nothing was closed. `
                + 'Close them from the chart if that is not what you want.',
            );
        } else {
            this.log.note('info', 'Stopped.');
        }
        this.changed();
    }

    /** Close everything and cancel everything, now. What the screen's own button does, and
     *  what the end-of-window guard does when it is set to. */
    flatten(reason: string): void {
        if (!this.account) return;
        try {
            this.account.flatten();
            this.log.note('info', `Flat: ${reason}`);
        } catch (err) {
            this.log.note('error', `Could not go flat: ${err instanceof Error ? err.message : String(err)}`);
        }
        this.changed();
    }

    /* ── the feed ────────────────────────────────────────────────────────── */

    /**
     * One update from the market.
     *
     * Two jobs, and only the first happens on every tick: the account is marked (which on a
     * paper account is what makes orders fill at all), and if this update opened a NEW bar,
     * the one before it has closed and the strategy gets to see it.
     *
     * The closed bar handed to the strategy is the last state the feed reported for it, not
     * this update — this update belongs to the new bar. Reading them the other way round is
     * how a strategy ends up acting on a bar that had not finished.
     */
    private onFeed(bar: OHLCV): void {
        if (this.state !== 'running' || this.reseeding || (this.forming && bar.time < this.forming.time)) return;
        if (!validBar(bar)) {
            this.log.note('error', 'The feed supplied invalid OHLC data; the update was ignored.');
            return;
        }
        this.lastTickAt = Date.now();
        this.feedRestartAt = 0;
        this.feedRestartDelay = FEED_RESTART_MS;

        // The account first: a fill that this tick causes must have happened before the
        // strategy is asked what to do next, exactly as it has in a backtest.
        try {
            if (this.paper) {
                this.paper.onBar(bar);
                this.notePaperEntries();
                this.noteManagedStops();
            }
            else this.capital?.mark(bar.close);
        } catch (err) {
            this.log.note('error', `The account refused the update: ${err instanceof Error ? err.message : String(err)}`);
        }

        if (this.recovering) this.heldBar = bar;
        else this.advance(bar);

        this.changed();
    }

    /** Move the forming bar on, closing the one before it when this update opened a new one. */
    private advance(bar: OHLCV, repaired = false): void {
        const previous = this.forming;
        if (!repaired && previous && bar.time - previous.time > timeframeToMs(this.config.timeframe)) {
            if (Date.now() >= this.gapRetryAt) void this.recoverGap(previous, bar);
            return;
        }
        if (previous && bar.time > previous.time) {
            this.forming = bar;
            this.closeBar(previous);
        } else if (!previous || bar.time >= previous.time) {
            // The same bar, grown — or the first one there has ever been.
            this.forming = bar;
        }
    }

    /**
     * The feed skipped at least one bar interval: ask the market what happened in between.
     *
     * Two different things look like this from the feed's side. A market that was shut
     * skipped nothing — the bar the bot was standing in is its last one, and it closes as
     * any bar does, in the state the history says it ended in rather than the last update
     * the feed happened to deliver. A feed that dropped out skipped bars the detectors
     * need: those are appended in order and the strategy is run over each, so whatever it
     * holds is managed and its own state stays in step, but none of them may open
     * anything — a setup confirmed by a bar that closed during the outage is not one the
     * market is still offering.
     *
     * Until the history is whole no bar closes at all, which is what keeps a strategy from
     * deciding on a series with a hole in it.
     */
    private async recoverGap(previous: OHLCV, bar: OHLCV): Promise<void> {
        const lifetime = this.lifetime;
        const current = (): boolean => lifetime === this.lifetime && this.state === 'running';
        this.recovering = true;
        this.heldBar = bar;
        this.gapRetryAt = Date.now() + GAP_RETRY_MS;
        /* Once the history has answered, it is the authority on what lies between the bar
         * the bot stood in and this update. A market that skips quiet intervals leaves a
         * distance there for good, and asking again would never close it. */
        let repaired = false;
        try {
            const newest = this.bars[this.bars.length - 1];
            const span = (bar.time - (newest?.time ?? previous.time)) / timeframeToMs(this.config.timeframe);
            const history = await this.provider().getBars(tickerOf(this.config.symbol), this.config.timeframe, {
                to: Date.now(),
                limit: Math.min(HISTORY_BARS, Math.ceil(span) + 2),
            });
            if (!current()) return;
            if (!orderedBars(history)) throw new Error('The market history contains invalid or unordered candles.');

            const last = history[history.length - 1];
            if (!last || history[0]!.time > previous.time) {
                /* The history does not reach back to where the bot stands, so the hole
                 * cannot be closed. The strategy keeps running for what it holds. */
                this.strategyError = 'A feed gap could not be repaired from the market history. New entries are blocked until restart.';
                this.log.note('error', this.strategyError);
                this.forming = this.heldBar;
                this.heldBar = null;
                return;
            }

            const closed = history.slice(0, -1).filter((row) => !newest || row.time > newest.time);
            const missed = closed.some((row) => row.time > previous.time);
            if (last.time >= previous.time) this.forming = last;
            for (const row of closed) {
                this.closeBar(row, missed);
                if (!current()) return;
            }
            repaired = true;
            if (missed) {
                this.log.note('info', `Feed gap repaired — ${closed.length} bars loaded. Nothing was opened on them.`);
            }
        } catch (err) {
            if (!current()) return;
            this.log.note(
                'error',
                `A gap in the feed could not be repaired yet: ${err instanceof Error ? err.message : String(err)}. `
                + 'No decision is made until the missing bars are loaded.',
            );
        } finally {
            /* A stop followed by a start owns these fields again; only this lifetime clears them. */
            if (lifetime === this.lifetime) {
                this.recovering = false;
                const held = this.heldBar;
                this.heldBar = null;
                if (held && this.state === 'running' && (!this.forming || held.time >= this.forming.time)) this.advance(held, repaired);
                this.changed();
            }
        }
    }

    /**
     * A bar has closed: append it, rebuild, and let the strategy act.
     *
     * The strategy runs whatever the guards say. That is not an oversight — it is the one
     * decision in this file that had to be got right. A strategy holding a position has
     * work to do on every bar: the Relative Volume ORB cancels its own order and closes at
     * the session's end, and a guard that stopped `onBar` running would strand exactly the
     * position the guards exist to protect. So the guards gate ENTRIES, inside the context,
     * and nothing else — see botContext's `canOpen`.
     */
    private closeBar(bar: OHLCV, duringGap = false): void {
        /* A feed that re-sends a bar the bot already has is not a new close. Without this,
         * a reconnect that replays the last bar would run the strategy on it twice — and a
         * strategy that places one order per session would place two. */
        const newest = this.bars[this.bars.length - 1];
        if (newest && bar.time <= newest.time) return;

        this.bars.push(bar);
        this.rollDay(Date.now());

        let strategy: RunnableStrategy<StrategyParams>;
        try {
            strategy = buildStrategy(this.config.strategy, this.params, this.bars);
        } catch (err) {
            /* A build that throws is a strategy that cannot run on this market at all — the
             * ORB refuses bars with no volume, for instance. Loud and repeated-collapsed,
             * rather than a bot that silently does nothing forever. */
            this.buildError = `The strategy could not be built: ${err instanceof Error ? err.message : String(err)}`;
            const holding = this.openPositions() > 0 || this.restingOrders() > 0;
            this.log.note(
                'error',
                this.buildError + (holding ? '. What the bot holds is not managed by the strategy until it can be built again.' : ''),
            );
            /* The window is kept in shape either way: a build that keeps failing must not
             * also let the history grow without limit. */
            this.trim();
            this.changed();
            return;
        }
        this.buildError = null;

        const ctx = botContext({
            bars: this.bars,
            index: this.bars.length - 1,
            strategy,
            account: this.account!,
            state: this.strategyState,
            pointValue: this.paper?.pointValue() ?? this.capital?.pointValue() ?? 1,
            sizeOnGrid: this.paper ? (size) => this.paper!.sizeOnGrid(size) : undefined,
            /* The guards, asked at the moment the strategy actually wants something rather
             * than on every bar. That is also why the log stays readable: a bot outside its
             * window says so once, when a setup was turned away, instead of once a minute
             * all night. What the bot would refuse RIGHT NOW is a live question the screen
             * asks through `refusal()`. */
            canOpen: (spec) => (duringGap ? 'This candle closed during a feed gap; nothing is opened on it.' : this.refusal())
                ?? (this.capital && this.capital.pointValue() == null
                    ? 'The instrument’s value in account currency is unknown; risk cannot be sized safely.' : null)
                ?? (this.capital && !hasProtectiveStop(spec)
                    ? 'Capital.com bot entries require a protective stop attached to the order.' : null),
            onRefused: (spec, reason) => this.log.note(
                'refused',
                `${spec.side === 'buy' ? 'Buy' : 'Sell'} setup not sent — ${reason}`,
            ),
            onOrder: (spec, id) => {
                const where = spec.type === 'limit' ? spec.limitPrice : spec.type === 'stop' ? spec.stopPrice : null;
                this.log.note(
                    'order',
                    `${spec.side === 'buy' ? 'Buy' : 'Sell'} ${spec.size.toFixed(4)} `
                    + `${spec.type ?? 'market'}${where != null ? ` at ${where}` : ''} (#${id})`,
                );
            },
        });

        if (!this.initialized) {
            /* Once per start, against the first bar the strategy is actually run on — the
             * same moment the backtest calls it, before onBar has ever seen this ctx.state.
             * Marked done whether or not it throws: a strategy whose init keeps failing must
             * not be retried every bar under a name that promises "once". */
            this.initialized = true;
            try {
                strategy.init?.(ctx);
            } catch (err) {
                this.strategyError = `The strategy's init failed: ${err instanceof Error ? err.message : String(err)}`;
                this.teardown();
                this.fail(this.strategyError);
                return;
            }
        }

        try {
            strategy.onBar(ctx);
        } catch (err) {
            /* The strategy threw mid-bar. Its own state is now whatever it managed to set,
             * which is why this is reported rather than swallowed — a bot that keeps running
             * on a strategy that is failing every bar is worse than one that says so. */
            this.strategyError = `The strategy failed on this bar: ${err instanceof Error ? err.message : String(err)}`;
            this.log.note('error', this.strategyError + '. New entries are blocked until restart.');
        }

        /* Market entries fill inside the strategy call. Resting entries fill in onFeed before
         * this method starts. Both paths meet here without counting an unfilled order. */
        this.notePaperEntries();

        this.noteClosedTrades();
        this.trim();
        // What the strategy now remembers, and the bar it was written on.
        this.persistRuntime();
        this.changed();
    }

    /**
     * Shrink the history back to its window, if it is safe to renumber the bars.
     *
     * Safe means the strategy is holding nothing that carries a bar index: no position, no
     * resting order, and nothing left in its own state. Run after the strategy has had this
     * bar, so a setup opened on it is seen and the window waits.
     *
     * Past {@link MAX_HISTORY_BARS} the history is cut regardless and the strategy's state
     * goes with it. That is a real loss — a strategy mid-setup forgets it — and it is
     * reported as an error rather than done quietly, because the alternative is a bot that
     * gets slower every day until it stalls the window on every bar.
     */
    private trim(): void {
        if (this.bars.length <= HISTORY_BARS) return;

        const holding = this.openPositions() > 0 || this.restingOrders() > 0 || !this.stateIsInert();
        if (holding && this.bars.length < MAX_HISTORY_BARS) return;

        this.bars = this.bars.slice(-HISTORY_BARS);
        /* Cleared either way. Where nothing was held it holds only spent keys; where something
         * was, every index in it now points at the wrong bar, and an index that is wrong is
         * worse than one that is absent — the strategy checks for absence and starts again. */
        this.strategyState = {};
        if (holding) {
            this.strategyError = 'History was trimmed during an active setup. New entries are blocked until restart.';
            this.log.note(
                'error',
                `The history reached ${MAX_HISTORY_BARS} bars while the strategy was still mid-setup. `
                + `It was cut back to ${HISTORY_BARS} and the strategy's own state dropped with it — `
                + 'new entries are blocked until restart. Anything already open is untouched.',
            );
        }
    }

    /**
     * Whether the strategy is holding nothing in its own store.
     *
     * Every strategy in this app keeps one object there and sets it to `undefined` when its
     * setup is done, so "inert" is: no key holds anything. Read rather than declared, because
     * `ctx.state` is the strategy's and this class has no business knowing its shape.
     */
    private stateIsInert(): boolean {
        for (const value of Object.values(this.strategyState)) {
            if (value != null) return false;
        }
        return true;
    }

    /**
     * Between bars: the things that are not on a bar boundary.
     *
     * A trading window ends at a wall-clock minute, a feed goes quiet without sending
     * anything (which is the point), and a paper position's stop fills on a tick. None of
     * those wait for the next bar to close, and on an hourly chart the next bar close is an
     * hour away.
     */
    private watch(): void {
        if (this.state !== 'running') return;
        this.rollDay(Date.now());
        this.noteClosedTrades();
        /* Read here as well as at an entry, so the account's day opening is taken when the
         * day opens rather than whenever a strategy first wants something. */
        this.accountRefusal();

        const inside = insideWindow(this.guards, Date.now());
        /* Armed on the EDGE and held until the bot is flat. A close the venue did not take
         * the first time is the case this setting exists for, and an edge that fired once
         * would leave that position open all night. The account is the bot's own, so
         * nothing in it was put there by hand. */
        if (inside) this.flattenDue = false;
        else if (this.wasInsideWindow && this.guards.flattenAtEnd) this.flattenDue = true;
        this.wasInsideWindow = inside;
        if (this.flattenDue && this.flattenUntilFlat('the trading window has ended')) this.flattenDue = false;

        if (this.guards.flattenAtDailyLoss && this.guards.dailyLossLimit > 0 && this.dayOpenEquity > 0 && this.account) {
            const movePct = ((this.account.equity() - this.dayOpenEquity) / this.dayOpenEquity) * 100;
            if (movePct <= -this.guards.dailyLossLimit) this.lossFlattenDue = true;
        }
        if (this.lossFlattenDue && this.flattenUntilFlat('the daily loss limit was reached')) this.lossFlattenDue = false;

        if (this.guards.staleFeedSeconds > 0) {
            const age = (Date.now() - (this.lastTickAt ?? this.feedOpenedAt)) / 1000;
            if (age > this.guards.staleFeedSeconds) {
                if (this.lastTickAt != null) this.log.note('refused', `The feed has been quiet for ${Math.round(age)}s.`);
                if (Date.now() >= this.feedRestartAt) this.reopenFeed();
            }
        }
        this.changed();
    }

    /** Go flat because a guard says so, again if the last attempt did not get there.
     *  Answers whether the bot is flat. */
    private flattenUntilFlat(reason: string): boolean {
        if (this.openPositions() === 0 && this.restingOrders() === 0) return true;
        if (Date.now() < this.flattenRetryAt) return false;
        /* An instruction already on its way is waited for rather than doubled, and a venue
         * that is shut would refuse every attempt until it opens. */
        if (this.capital && (this.capital.busy || !this.capital.tradeable())) return false;
        this.flattenRetryAt = Date.now() + FLATTEN_RETRY_MS;
        this.flatten(reason);
        return false;
    }

    private openFeed(provider: DataProvider): void {
        this.unsubscribe = provider.subscribe!(
            tickerOf(this.config.symbol),
            this.config.timeframe,
            (bar) => this.onFeed(bar),
        );
        this.feedOpenedAt = Date.now();
    }

    /**
     * Open the subscription again after the feed has gone quiet.
     *
     * A quiet feed is a market that is shut or a subscription that died, and nothing seen
     * from here tells the two apart. Only the second is cured by this, so the attempts
     * back off: a weekend costs a handful of them, and a dead stream is back within a
     * minute. Whatever was missed in between is loaded by {@link recoverGap}.
     */
    private reopenFeed(): void {
        this.feedRestartAt = Date.now() + this.feedRestartDelay;
        this.feedRestartDelay = Math.min(this.feedRestartDelay * 2, FEED_RESTART_MAX_MS);
        try {
            const provider = this.provider();
            if (!provider.subscribe) return;
            this.unsubscribe?.();
            this.unsubscribe = null;
            this.openFeed(provider);
            this.log.note('info', 'The feed was quiet and has been reopened.');
        } catch (err) {
            this.log.note('error', `The feed could not be reopened: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    /* ── bookkeeping ─────────────────────────────────────────────────────── */

    /** Where the bot stands, as the guards read it. */
    private guardState(): GuardState {
        const account = this.account;
        return {
            now: Date.now(),
            equity: account?.equity() ?? 0,
            dayOpenEquity: this.dayOpenEquity,
            openPositions: (account?.positions().length ?? 0) + (account?.pending().filter((o) => !o.reduceOnly).length ?? 0),
            tradesToday: this.tradesToday + (account?.pending().filter((o) => !o.reduceOnly).length ?? 0),
            lastLossAt: this.lastLossAt,
            lastTickAt: this.lastTickAt,
            spread: account?.quote() ?? null,
        };
    }

    /**
     * Start a new day's counting when the clock crosses UTC midnight.
     *
     * Keyed off the date rather than a timer, so it is correct whether the bot has been
     * running for a week or was started thirty seconds ago, and whether the clock reached
     * here through a bar's timestamp or through the watchdog.
     */
    private rollDay(at: number): void {
        const key = new Date(at).toISOString().slice(0, 10);
        if (key === this.dayKey) return;
        const first = this.dayKey === '';
        this.dayKey = key;
        this.tradesToday = 0;
        this.dayOpenEquity = this.account?.equity() ?? 0;
        if (!first) this.log.note('info', `A new UTC day — the daily counts start again from ${this.dayOpenEquity.toFixed(2)}.`);
        this.persistRuntimeNow();
    }

    /** Apply durable counters once the restored account has its current mark. */
    private restoreRuntimeDay(at: number): void {
        const restored = this.restoredGuards;
        this.restoredGuards = null;
        this.lastLossAt = restored?.lastLossAt ?? null;

        const key = new Date(at).toISOString().slice(0, 10);
        if (restored?.dayKey === key) {
            this.dayKey = key;
            this.dayOpenEquity = restored.dayOpenEquity;
            this.tradesToday = restored.tradesToday;
        } else {
            /* Retain the old key long enough for rollDay to report a real midnight edge. A
             * cooldown can span that edge, so lastLossAt deliberately does not reset. */
            this.dayKey = restored?.dayKey ?? '';
            this.rollDay(at);
        }

        if (this.pendingLiveEntries > 0) {
            this.tradesToday += this.pendingLiveEntries;
            this.pendingLiveEntries = 0;
        }
    }

    /**
     * Notice trades the account has closed since the last look.
     *
     * Only the paper engine keeps a trade ledger this can be read off. A live account's
     * closures reach the same last-loss timestamp through CapitalController's journal hook.
     */
    private noteClosedTrades(): void {
        const broker = this.paper?.broker;
        if (!broker) return;
        const trades = broker.trades as Array<{ netPnl?: number }>;
        let changed = false;
        for (let i = this.seenTrades; i < trades.length; i += 1) {
            const pnl = trades[i]?.netPnl ?? 0;
            this.log.note('info', `Trade closed: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}`);
            if (pnl < 0) {
                this.lastLossAt = Date.now();
                changed = true;
            }
        }
        this.seenTrades = trades.length;
        if (changed) this.persistRuntimeNow();
    }

    /** Count each filled paper entry order once, including pending fills and scale-ins. */
    private notePaperEntries(): void {
        const broker = this.paper?.broker;
        if (!broker) return;
        let opened = 0;
        for (const order of broker.orders) {
            if (order.status !== 'filled' || order.reduceOnly || this.seenPaperEntries.has(order.id)) continue;
            this.seenPaperEntries.add(order.id);
            opened += 1;
            this.log.note(
                'info',
                `${order.side === 'buy' ? 'Buy' : 'Sell'} ${order.size.toFixed(4)} filled`
                + `${order.fillPrice != null ? ` at ${order.fillPrice}` : ''} (#${order.id}).`,
            );
        }
        if (opened === 0) return;
        this.tradesToday += opened;
        this.persistRuntimeNow();
    }

    /** Say so when the account moves a stop by itself — nobody pressed anything, so the log is
     *  the only place the move can be read afterwards. */
    private noteManagedStops(): void {
        const broker = this.paper?.broker;
        if (!broker) return;
        for (const position of broker.positions) {
            if (position.breakEvenDone && !this.seenManaged.has(`be:${position.id}`)) {
                this.seenManaged.add(`be:${position.id}`);
                this.log.note('info', `Break-even: stop moved to ${position.stopLoss ?? 'n/a'} (#${position.id})`);
            }
            if (position.trailing && !this.seenManaged.has(`trail:${position.id}`)) {
                this.seenManaged.add(`trail:${position.id}`);
                this.log.note('info', `Trailing stop armed (#${position.id})`);
            }
        }
    }

    /* ── setup and teardown ──────────────────────────────────────────────── */

    private provider(): DataProvider {
        const id = providerOf(this.config.symbol);
        const factory = id ? this.providers[id] : undefined;
        if (!factory) {
            throw new Error(`No provider called "${id ?? ''}" — the market has to be written as provider:SYMBOL.`);
        }
        return factory();
    }

    /**
     * Establish the one safe ownership boundary for a Capital.com bot.
     *
     * An existing initialized record is already authoritative, including when the account
     * also contains manual positions on this market. A new or uncertain record can only be
     * initialized against an empty market book: no field returned by the venue can prove
     * which pre-existing exposure came from this bot.
     */
    private async prepareCapitalOwnership(stored: MidoriBotAccount | null, accountId: string, environment: 'demo' | 'live'): Promise<MidoriBotCapitalOwnership> {
        const previous = stored?.capital;
        const hasExposure = Boolean(
            previous?.uncertain
            || previous?.positionDealIds.length
            || previous?.workingOrderDealIds.length,
        );
        if (stored && stored.symbol !== this.config.symbol && hasExposure) {
            throw new Error(
                `This bot still owns or may own Capital.com exposure on ${stored.symbol}. `
                + 'Clear that exposure before changing its market.',
            );
        }

        const reusable = stored?.symbol === this.config.symbol ? previous : undefined;
        if (hasExposure && (previous?.accountId !== accountId || previous?.environment !== environment)) {
            throw new Error('This bot has exposure from another or unidentified Capital.com account. Resolve it on the original account before resetting or switching accounts.');
        }
        if (reusable?.initialized && !reusable.uncertain) return { ...cloneOwnership(reusable), accountId, environment };

        const epic = tickerOf(this.config.symbol).toUpperCase();
        const [positions, orders] = await Promise.all([
            window.midori.capital.positions(),
            window.midori.capital.workingOrders(),
        ]);
        const positionCount = positions.filter((row) => row.market.epic.toUpperCase() === epic).length;
        const orderCount = orders.filter((row) => row.workingOrderData.epic.toUpperCase() === epic).length;
        if (positionCount > 0 || orderCount > 0) {
            throw new Error(
                `Capital.com already has ${positionCount} open ${positionCount === 1 ? 'position' : 'positions'} `
                + `and ${orderCount} working ${orderCount === 1 ? 'order' : 'orders'} on ${epic}. `
                + 'This bot cannot safely assign pre-existing exposure to itself. Clear that market at the venue, then start it again.',
            );
        }
        return {
            accountId,
            environment,
            initialized: true,
            positionDealIds: [],
            workingOrderDealIds: [],
            uncertain: false,
        };
    }

    /** Accept a controller ownership update and count newly proven live entries once. */
    private acceptCapitalOwnership(ownership: MidoriBotCapitalOwnership): void {
        const previous = new Set(this.capitalOwnership?.positionDealIds ?? []);
        const opened = ownership.positionDealIds.filter((dealId) => !previous.has(dealId)).length;
        this.capitalOwnership = cloneOwnership(ownership);
        if (opened > 0) {
            if (this.runtimeReady) this.tradesToday += opened;
            else this.pendingLiveEntries += opened;
        }
        this.persistRuntimeNow();
    }

    /** Build the account this bot trades through. Its own, never the chart's. */
    private async buildAccount(): Promise<void> {
        /* Every venue needs the durable guards. A read error is allowed to reject this start:
         * guessing fresh state could bypass a daily loss limit or forget a live deal. */
        const stored = await loadBotAccount(this.config.id);
        this.restoredGuards = stored?.guards ?? null;
        this.storedStrategy = stored?.strategy ?? null;

        if (this.config.venue === 'capital') {
            if (stored?.session != null) {
                throw new Error(
                    'This bot still has a paper account on disk. File or reset that account before switching it to Capital.com.',
                );
            }
            const environment = await window.midori.capital.environment();
            if (!environment.configured) {
                throw new Error('Capital.com is not connected — add the account under Settings → Broker connection.');
            }
            this.isLive = environment.live;
            if (environment.live && !this.allowLive) {
                throw new Error('Explicitly confirm this bot’s live-money start before it can trade.');
            }
            if (this.armedRevision != null && environment.revision !== this.armedRevision) {
                throw new Error('The Capital.com connection changed after confirmation. Start the bot again.');
            }
            const venueAccount = await window.midori.capital.account().catch(() => null);
            if (!venueAccount?.accountId) {
                throw new Error('The Capital.com account could not be read or identified safely.');
            }
            this.capitalOwnership = await this.prepareCapitalOwnership(stored, venueAccount.accountId, environment.live ? 'live' : 'demo');
            this.capital = new CapitalController({
                revision: environment.revision,
                beforeEntry: async () => {
                    if (this.state !== 'running') throw new Error('The bot stopped before its entry was sent.');
                    this.persistRuntime();
                    await this.writer.flush();
                    if (this.state !== 'running') throw new Error('The bot stopped before its entry was sent.');
                },
                epic: tickerOf(this.config.symbol),
                live: this.isLive,
                silent: true,
                ownership: this.capitalOwnership,
                onOwnershipChange: (ownership) => this.acceptCapitalOwnership(ownership),
                notify: (message, kind) => this.log.note(kind === 'error' ? 'error' : 'info', message),
                onChange: () => this.changed(),
                /* Every trade this bot closes goes into the same journal the Chart tab writes
                 * to. Not a nicety: the venue serves at most a day of history per request and
                 * loses it with the account, so this journal is the only record anywhere that
                 * a bot moved real money — and a bot trading unwatched is exactly the case
                * where nobody is there to notice it went unrecorded. */
                onTradeClosed: (trade) => {
                    if (trade.netPnl < 0) {
                        this.lastLossAt = Date.now();
                        this.persistRuntimeNow();
                    }
                    void recordTrade(trade)
                        .then((added) => {
                            if (!added) return;
                            this.log.note(
                                'info',
                                `Trade closed and journalled: ${trade.netPnl >= 0 ? '+' : ''}${trade.netPnl.toFixed(2)}`
                                + `${trade.currency ? ` ${trade.currency}` : ''}${trade.estimated ? ' (estimated)' : ''}`,
                            );
                        })
                        .catch((err: unknown) => this.log.note(
                            'error',
                            'A closed trade could NOT be written to the journal, and that journal is the only '
                            + `record this happened — write it down by hand: ${err instanceof Error ? err.message : String(err)}`,
                        ));
                },
            });
            const accountReady = await this.capital.start();
            if (!accountReady) {
                throw new Error(
                    'The Capital.com account could not be read. The bot was not started because '
                    + 'it cannot size or own a trade safely without current positions, orders, and funds.',
                );
            }
            this.live = liveAccount(
                this.capital,
                this.storedStrategy?.key === this.strategyKey() ? this.storedStrategy.orderIds : undefined,
                () => this.persistRuntimeNow(),
            );
            this.account = this.live;
            return;
        }

        /* A bot's paper account is built from the app's paper-trading defaults for its costs
         * and its position mode, with the bot's own starting balance. Not the chart's stored
         * account: this one is the bot's, it starts when the bot starts, and mixing the two
         * would put hand-placed trades in the same ledger as automated ones. */
        const settings: PaperSettings = {
            ...DEFAULT_PAPER_SETTINGS,
            balance: this.config.balance,
            maxLeverage: Number(this.params.maxLeverage ?? DEFAULT_PAPER_SETTINGS.maxLeverage),
        };
        const instrument = await paperInstrument(
            providerOf(this.config.symbol) ?? '',
            this.provider(),
            tickerOf(this.config.symbol),
        );
        /* Whatever this bot was left holding. A failed read stops the start rather than
         * opening a fresh account over weeks of trades that may still be on disk — the one
         * mistake here that cannot be undone. */
        if (stored && stored.session == null) {
            throw new Error(
                'This bot has live runtime state but no paper account. Reset it before switching the venue to paper.',
            );
        }
        this.paper = new PaperController({
            symbol: stored?.symbol ?? this.config.symbol,
            settings,
            restore: stored?.session,
            onPersist: () => this.persistRuntime(),
        });
        this.paper.setInstrument(instrument);
        this.paper.onAccountChange = () => this.changed();
        /* The backtest hands `strategy.management` to its broker. A bot builds the strategy
         * afresh on every bar and never reads it, so the account is told once, here — on every
         * start, because a restored account carries the rules it was last stopped with. */
        this.paper.broker.setManagement(riskManagement(this.params));
        this.account = paperAccount(this.paper);

        if (stored) {
            const trades = this.paper.broker.trades.length;
            this.log.note(
                'info',
                `Picked its account back up — ${trades} ${trades === 1 ? 'trade' : 'trades'} on record, `
                + `worth ${this.paper.equity().toFixed(2)}.`,
            );
        }

        /* A stored account left on another market is not moved onto this one behind anybody's
         * back: its positions belong to the market that made them. Refused loudly instead —
         * a bot marking Bitcoin positions against Ethereum's prices is the worst thing this
         * class could do quietly. */
        if (this.paper.symbol !== this.config.symbol && !this.paper.follow(this.config.symbol)) {
            throw new Error(
                `This bot's stored account is still holding a position on ${this.paper.symbol}. `
                + 'Close it from the chart, or point the bot back at that market.',
            );
        }
    }

    /** The account, guards, and live ownership as they stand, on their way to disk. */
    private persistRuntime(): void {
        if (!this.runtimeReady) return;
        const paper = this.paper?.snapshot();
        const snapshot: MidoriBotAccountSnapshot = {
            symbol: paper?.symbol ?? this.config.symbol,
            ...(paper ? { session: paper.session } : {}),
            guards: {
                dayKey: this.dayKey,
                dayOpenEquity: this.dayOpenEquity,
                tradesToday: this.tradesToday,
                lastLossAt: this.lastLossAt,
            },
            ...(this.capitalOwnership ? { capital: cloneOwnership(this.capitalOwnership) } : {}),
            ...this.strategyRuntime(),
        };
        this.writer.schedule(this.config.id, snapshot);
    }

    /** What ties a stored strategy state to the bot that wrote it. A changed strategy,
     *  market, interval or setting makes it somebody else's state. */
    private strategyKey(): string {
        return JSON.stringify([this.config.strategy, this.config.symbol, this.config.timeframe, this.params]);
    }

    /**
     * The strategy's own store, with the bars that give its indices a meaning.
     *
     * Copied through JSON on the way out: the store is the strategy's and is still being
     * written to, and whatever cannot be written as JSON could not be read back either. A
     * store that cannot be copied is left out, which costs the next restart its memory and
     * never the account its write.
     */
    private strategyRuntime(): { strategy?: MidoriBotStrategyRuntime } {
        const newest = this.bars.length - 1;
        if (newest < 0) return {};
        let state: Record<string, unknown>;
        try {
            state = JSON.parse(JSON.stringify(this.strategyState)) as Record<string, unknown>;
        } catch {
            return {};
        }
        const anchors: Array<[number, number]> = [];
        for (const offset of ANCHOR_OFFSETS) {
            const index = newest - offset;
            if (index >= 0) anchors.push([index, this.bars[index]!.time]);
        }
        const orderIds = this.live?.orderIds() ?? [];
        return {
            strategy: {
                key: this.strategyKey(),
                state,
                anchors,
                ...(orderIds.length > 0 ? { orderIds } : {}),
            },
        };
    }

    /**
     * Give the strategy back what it remembered before the restart, if the history allows.
     *
     * The state holds bar indices, and nothing here knows where in it they are. So the
     * state is never renumbered: the newly loaded history is cut so that the bar the state
     * was written on sits at the index it had then, and every index in the state means the
     * bar it always meant. Where the history cannot be lined up — the bar is no longer
     * served, too few older bars come back, or the series differs — the state is dropped
     * and the bot says so, because an index pointing at the wrong bar is worse than none.
     */
    private async restoreStrategy(provider: DataProvider, lifetime: number): Promise<void> {
        const stored = this.storedStrategy;
        this.storedStrategy = null;
        if (!stored) return;
        if (stored.key !== this.strategyKey()) {
            this.log.note('info', 'The strategy, market or settings changed since the last run, so what the strategy remembered was not carried over.');
            return;
        }
        if (Object.values(stored.state).every((value) => value == null)) {
            // Nothing was remembered, so nothing can have been lost.
            this.memoryKept = true;
            return;
        }

        const [anchorIndex, anchorTime] = stored.anchors[0]!;
        const position = (): number => {
            for (let i = this.bars.length - 1; i >= 0; i -= 1) {
                if (this.bars[i]!.time === anchorTime) return i;
                if (this.bars[i]!.time < anchorTime) break;
            }
            return -1;
        };
        let at = position();
        if (at >= 0 && at < anchorIndex) {
            // The state was written deeper into a history than was loaded: ask for the rest.
            const wanted = this.bars.length + 1 + (anchorIndex - at);
            if (wanted <= MAX_HISTORY_BARS + HISTORY_BARS) {
                const bars = await provider.getBars(tickerOf(this.config.symbol), this.config.timeframe, {
                    to: Date.now(),
                    limit: wanted,
                });
                if (lifetime !== this.lifetime) return;
                if (bars.length >= 2 && orderedBars(bars)) {
                    this.bars = bars.slice(0, -1);
                    this.forming = bars[bars.length - 1] ?? null;
                    at = position();
                }
            }
        }
        const aligned = at >= anchorIndex ? this.bars.slice(at - anchorIndex) : null;
        if (!aligned || !stored.anchors.every(([index, time]) => aligned[index]?.time === time)) {
            this.log.note(
                'error',
                'What the strategy remembered before the restart could not be lined up with the market history and was dropped.',
            );
            return;
        }
        this.bars = aligned;
        this.strategyState = stored.state;
        // The store is already seeded; `init` must not write over it.
        this.initialized = true;
        this.memoryKept = true;
        this.log.note('info', 'The strategy picked up what it remembered before the restart.');
    }

    /** Safety counters and ownership changes go to disk without the ordinary tick delay. */
    private persistRuntimeNow(): void {
        if (!this.runtimeReady) return;
        this.persistRuntime();
        void this.writer.flush().catch(() => undefined);
    }

    /**
     * Write the account down and wait for it to land.
     *
     * What anything that is about to READ the account back from disk has to call first —
     * filing it as a run, starting it over, deleting the bot. Without it a write still in
     * flight arrives after the delete and puts the account back, which is a reset that
     * quietly did nothing.
     */
    async settle(): Promise<void> {
        await this.capital?.settle();
        this.persistRuntime();
        await this.writer.flush();
    }

    /**
     * Load the history the strategy's detectors need, and stand the account on the last
     * price without letting anything fill on it.
     *
     * The newest bar is dropped: a provider serves the forming candle as its last row, and
     * a strategy handed a bar that is still moving is a strategy reading the future. It
     * becomes the bot's `forming` bar instead, and is played to the strategy when the feed
     * opens the next one.
     */
    private async seed(provider: DataProvider, lifetime = this.lifetime): Promise<void> {
        /* A count, not a window of time. A window is bars × timeframe of CALENDAR time, which a
         * market that shuts overnight never fills, and a venue may refuse one outright —
         * Capital.com answers ten days of 5-minute bars with error.invalid.max.daterange.
         * "The latest N bars" is what the bot means and what every provider can serve. */
        const bars = await provider.getBars(tickerOf(this.config.symbol), this.config.timeframe, {
            to: Date.now(),
            limit: HISTORY_BARS,
        });
        if (lifetime !== this.lifetime) return;
        if (!orderedBars(bars)) {
            throw new Error('The market history contains invalid or unordered candles.');
        }
        if (bars.length === 0) {
            throw new Error('The market served no bars — nothing to run a strategy on.');
        }

        if (bars.length === 1) {
            throw new Error('The market served one bar, which is not history — try a shorter timeframe.');
        }
        this.bars = bars.slice(0, -1);
        this.forming = bars[bars.length - 1] ?? null;
        this.strategyState = {};
        if (!this.runtimeReady) {
            await this.restoreStrategy(provider, lifetime);
            if (lifetime !== this.lifetime) return;
        }

        /* A new account is MARKED at the last price, never played the history: an account
         * that did not exist when those bars happened has no business being filled by them.
         * One picked back up is walked over the bars it missed instead, the way the chart's
         * paper account is, so a stop the market went through while the bot was stopped has
         * filled rather than greeting its owner still open. */
        if (this.forming && this.paper) {
            if (!this.runtimeReady && this.paper.session.barTime != null) this.catchUpPaper(this.forming);
            else this.paper.session.mark(this.forming);
        } else if (this.forming) this.capital?.mark(this.forming.close);

        this.seenTrades = this.paper?.broker.trades.length ?? 0;
        this.seenPaperEntries = new Set(
            this.paper?.broker.orders
                .filter((order) => order.status === 'filled' && !order.reduceOnly)
                .map((order) => order.id) ?? [],
        );
        /* Whatever a restored account already did stays unannounced — it was said the first time. */
        this.seenManaged = new Set(
            this.paper?.broker.positions.flatMap((p) => [
                ...(p.breakEvenDone ? [`be:${p.id}`] : []),
                ...(p.trailing ? [`trail:${p.id}`] : []),
            ]) ?? [],
        );
        if (!this.runtimeReady) {
            this.restoreRuntimeDay(Date.now());
            /* A bot started outside its window with something still open missed the edge
             * while it was stopped. */
            this.flattenDue = this.guards.flattenAtEnd && !insideWindow(this.guards, Date.now());
            this.runtimeReady = true;
            this.persistRuntime();
            await this.writer.flush();
        } else {
            /* A manual reseed keeps today's counters. It may still be the first call after
             * midnight, so let the ordinary date edge reset them where needed. */
            this.rollDay(Date.now());
        }
        this.wasInsideWindow = insideWindow(this.guards, Date.now());
        this.lastTickAt = null;
    }

    /** Play the seeded bars a restored paper account has not stood in yet, then the forming one. */
    private catchUpPaper(forming: OHLCV): void {
        const paper = this.paper!;
        const stood = paper.session.barTime as number;
        const fills = paper.broker.fills.length;
        const played = paper.catchUp(this.bars);
        paper.onBar(forming);
        if (played === 0) return;
        const filled = paper.broker.fills.length - fills;
        const first = this.bars[0];
        const partial = first != null && first.time - stood > timeframeToMs(this.config.timeframe);
        this.log.note(
            'info',
            `Replayed ${played} ${played === 1 ? 'bar' : 'bars'} the account missed while the bot was stopped: `
            + `${filled} ${filled === 1 ? 'fill' : 'fills'}.`
            + (partial ? ' The loaded history starts later than the account was last marked, so the stretch before it was not replayed.' : ''),
        );
    }

    /**
     * Throw away the history and load it again, keeping the account.
     *
     * The one place the bar indices are allowed to move, and it is guarded on the one
     * condition that makes that safe: the strategy must be holding nothing. `ctx.state` is
     * cleared with the history, because every index in it is about to mean a different bar
     * — and a strategy with nothing open has nothing that a forgotten state can strand.
     *
     * Not called on a schedule — {@link trim} is what keeps the window in shape. This is for
     * fetching the market's own bars again: a feed that dropped a stretch while the app was
     * asleep leaves a hole nothing else fills.
     */
    async reseed(): Promise<boolean> {
        if (this.state !== 'running' || this.reseeding || this.recovering) return false;
        if (this.openPositions() > 0 || this.restingOrders() > 0 || !this.stateIsInert()) {
            this.log.note('info', 'History not reloaded — the bot is holding something, and its indices would move under it.');
            return false;
        }
        const lifetime = this.lifetime;
        this.reseeding = true;
        try {
            await this.seed(this.provider(), lifetime);
            if (lifetime !== this.lifetime || this.state !== 'running') return false;
            this.initialized = false;
            this.persistRuntime();
            this.log.note('info', `History reloaded — ${this.bars.length} bars.`);
        } catch (err) {
            if (lifetime !== this.lifetime || this.state !== 'running') return false;
            this.log.note('error', `Could not reload the history: ${err instanceof Error ? err.message : String(err)}`);
            return false;
        } finally {
            this.reseeding = false;
        }
        this.changed();
        return true;
    }

    /** Close the feed and put the account down. Nothing is traded. */
    private teardown(): void {
        this.unsubscribe?.();
        this.unsubscribe = null;
        if (this.watchdog != null) {
            clearInterval(this.watchdog);
            this.watchdog = null;
        }
        this.capital?.stop();
        if (this.paper) this.paper.onAccountChange = null;
    }

    private fail(message: string): void {
        this.state = 'failed';
        this.failure = message;
        this.log.note('error', message);
        this.changed();
    }

    private changed(): void {
        this.onChange?.();
    }

    /** Take an edited definition. Refused while running — the settings a bot started with
     *  are the settings it is holding a position under, and swapping them mid-trade would
     *  leave a stop sized by one set of rules being managed by another. */
    update(next: BotConfig): void {
        if (this.state === 'running' || this.state === 'starting') {
            throw new Error('Stop the bot before changing it — a running bot is holding positions under the settings it started with.');
        }
        this.config = next;
        this.guards = guardsOf(safeGuardParams(next));
        this.params = safeParams(next);
        this.changed();
    }

    /**
     * Read this bot's stored account into memory, without starting anything.
     *
     * For filing a STOPPED bot's account: no feed is opened, no order can be sent, and the
     * strategy is never built. The only thing that happens is that the account on disk
     * becomes readable through {@link archive}. A bot with no stored account loads nothing
     * and archives nothing, which is the correct answer for one that never traded.
     */
    async loadStoredAccount(): Promise<void> {
        const stored = await loadBotAccount(this.config.id);
        if (!stored) return;
        if (stored.session == null) {
            if (this.config.venue === 'paper') {
                throw new Error('This bot has runtime state but no paper account to file.');
            }
            return;
        }
        this.paper = new PaperController({
            symbol: stored.symbol,
            settings: { ...DEFAULT_PAPER_SETTINGS, balance: this.config.balance },
            restore: stored.session,
        });
        this.account = paperAccount(this.paper);
    }

    /**
     * The account as a finished run, ready for the library.
     *
     * The same shelf a backtest of this strategy lands on, which is the entire point: a
     * strategy tested over history and the same strategy run live are the two rows anybody
     * would want side by side, and there is nowhere else they can be. Filed through the
     * backtest channel rather than the hand-traded one because that is what a bot's run IS —
     * a strategy, with the settings it actually ran under, which the hand-traded channel has
     * no way to record.
     *
     * Answers the run's id, or null when there was nothing to file. A live bot files nothing:
     * its trades are the venue's and are already in the journal, which is a record of money
     * moved rather than of a strategy's performance, and totalling one as the other would
     * produce a result nobody could act on.
     */
    async archive(): Promise<string | null> {
        const paper = this.paper;
        if (!paper || paper.broker.trades.length === 0) return null;

        const spec = STRATEGIES[this.config.strategy];
        const opened = new Date(paper.openedAt).toISOString().slice(0, 10);
        const { id } = await window.midori.backtest.save({
            ...paper.result(this.config.timeframe),
            strategy: this.config.strategy,
            strategyName: spec?.name ?? this.config.strategy,
            /* What it actually ran under, resolved — the same rule a backtest follows, and
             * what makes the two rows comparable at all. */
            params: this.params,
            symbol: paper.symbol,
            timeframe: this.config.timeframe,
            /* Said in the note rather than in a field of its own: the run library is read by
             * people, and a bot's run must never be mistaken for a backtest of the same
             * strategy — one had idealised fills over history, the other met a live feed. */
            note: `Trading bot “${this.config.name}”, live on ${paper.symbol} ${this.config.timeframe} `
                + `from ${opened}. Paper account, real prices.`,
        });
        return id;
    }

    /**
     * Release every active resource. The account and log remain readable afterwards.
     *
     * Deliberately writes NOTHING. Everything that had to be written down was written by
     * {@link stop} or by {@link settle}, both of which run before this on every path that
     * has an account worth keeping. A write started here would be a write with nobody left
     * to wait for it — and it caused a real bug: `resetAccount` builds a runner purely to
     * READ the stored account, and a disposing write from that one landed after the delete
     * and put the account straight back, so the reset silently did nothing. The engine may
     * retain the disposed object as a read-only screen model, but never starts or acts through
     * it again.
     */
    dispose(): void {
        this.lifetime += 1;
        this.teardown();
        this.writer.cancel();
        this.state = 'stopped';
        this.log.onChange = null;
        this.onChange = null;
    }

    /** Whether an asynchronous start still owns the right to open the feed. */
    private isCurrentStart(lifetime: number): boolean {
        return this.lifetime === lifetime && this.state === 'starting';
    }
}

/**
 * A bot's settings, or the strategy's own defaults where they cannot be read.
 *
 * Only for holding a runner that is not running. What actually reaches a trade is resolved
 * in {@link BotRunner.start}, where a refusal is a refusal rather than a fallback — a bot
 * that quietly traded the defaults because its stored settings no longer fit would be a bot
 * doing something nobody configured.
 */
function safeParams(bot: BotConfig): StrategyParams {
    try {
        return paramsOf(bot);
    } catch {
        return {};
    }
}

function safeGuardParams(bot: BotConfig): StrategyParams {
    try {
        return guardParamsOf(bot);
    } catch {
        return resolveGuards({});
    }
}

function cloneOwnership(ownership: MidoriBotCapitalOwnership): MidoriBotCapitalOwnership {
    return {
        ...(ownership.accountId ? { accountId: ownership.accountId } : {}),
        ...(ownership.environment ? { environment: ownership.environment } : {}),
        initialized: ownership.initialized,
        positionDealIds: [...ownership.positionDealIds],
        workingOrderDealIds: [...ownership.workingOrderDealIds],
        uncertain: ownership.uncertain,
    };
}

/** Whether an entry carries its stop, as a level or as a distance from the fill. */
function hasProtectiveStop(spec: OrderSpec): boolean {
    const bracket = spec.bracket;
    if (!bracket) return false;
    const positive = (value: number | null | undefined): boolean => (
        typeof value === 'number' && Number.isFinite(value) && value > 0
    );
    return positive(bracket.stopLoss) || positive(bracket.stopDistance);
}

function orderedBars(bars: readonly OHLCV[]): boolean {
    return bars.every((bar, index) => validBar(bar) && (index === 0 || bar.time > bars[index - 1]!.time));
}

function validBar(bar: OHLCV): boolean {
    return [bar.time, bar.open, bar.high, bar.low, bar.close].every(Number.isFinite)
        && bar.time >= 0 && bar.low > 0 && bar.high >= Math.max(bar.open, bar.close)
        && bar.low <= Math.min(bar.open, bar.close)
        && (bar.volume == null || Number.isFinite(bar.volume) && bar.volume >= 0);
}
