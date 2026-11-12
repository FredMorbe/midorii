import type { Broker, Position, ProtectionLevels } from '../../../shared/engine/broker.js';
import type { LiveResult } from '../../../shared/engine/liveSession.js';
import { summarize, type RunStats } from '../../../shared/engine/summary.js';
import { accountFigures, type AccountFigures } from '../replay/accountFigures';
import { tradeHistory, type ClosedTrade, type HistoryRow, type TradeBook } from '../replay/tradeBook';
import { PaperController } from './PaperController';
import type { PaperSettings } from './paperSettings';
import type { ControlledPosition } from './TradingController';

/**
 * One paper account that trades as many markets as it has been given.
 *
 * The engine's Broker is one account in one instrument: its positions carry no symbol and its
 * point value, size grid and last price are single. Rather than teach it otherwise — a backtest,
 * a replay and every bot stand on it — the account here is a set of {@link PaperController}
 * legs, one per market, with the money shared between them:
 *
 *   cash   = what the account started with + what every leg has settled since
 *   equity = the same, plus what every leg holds open
 *
 * Each leg is a whole controller on its own market — it takes its own feed, fills against its own
 * prices and draws its own levels — and is told what the WHOLE account is worth when a size is
 * chosen, so a trade is risked against the account and not against the books of one market.
 *
 * Order and position ids come from counters the engine keeps for the whole process, so an id
 * names one thing across every leg; that is what lets the dock close "position 12" without
 * asking which market it is in.
 */

/** What an account stores beyond the one leg the record already carries. */
export interface PaperAccountExtra {
    version: 1;
    /** Every leg but the first, which travels as the record's own `symbol` and `session`. */
    legs: Array<{ symbol: string; session: unknown }>;
    ledger: LedgerSnapshot;
}

/** What is written down: the first leg as before, so an older record reads the same, plus the rest. */
export interface PaperAccountSnapshot {
    symbol: string;
    session: unknown;
    extra: PaperAccountExtra;
}

export interface PaperAccountRestore {
    symbol: string;
    session: unknown;
    extra?: PaperAccountExtra | null;
}

export interface PaperAccountOptions {
    settings: PaperSettings;
    /** The market the account opens on — the first leg. Ignored when restoring. */
    symbol?: string;
    restore?: PaperAccountRestore;
    /** One name for a market however it is written — `provider:TICKER` where it resolves. */
    canonical?: (symbol: string) => string;
    /** Told whenever the account changed in a way that is worth writing down. */
    onPersist?: () => void;
    /** Told whenever any leg moved. */
    onAccountChange?: () => void;
    /** Play the fill sound. Off for an account nobody is watching. */
    chime?: boolean;
}

/** How often the curve takes a point while nothing settles. */
const SAMPLE_MS = 15 * 60_000;
const MAX_POINTS = 20_000;

interface LedgerSnapshot {
    createdAt: number;
    peakEquity: number;
    maxDrawdown: number;
    maxDrawdownPct: number;
    sampleMs: number;
    equityCurve: CurvePoint[];
}

interface CurvePoint {
    time: number;
    equity: number;
    balance: number;
    drawdown: number;
}

/**
 * The account over time, across every leg — what a leg's own session keeps for its own market.
 *
 * The peak and the worst drawdown are measured on every change, because a drawdown between two
 * sampled points still happened; the curve is sampled and thinned, and keeps every settlement.
 */
class Ledger {
    createdAt = Date.now();
    peakEquity: number;
    maxDrawdown = 0;
    maxDrawdownPct = 0;
    sampleMs = SAMPLE_MS;
    equityCurve: CurvePoint[] = [];

    constructor(equity: number) {
        this.peakEquity = equity;
    }

    record(time: number, equity: number, balance: number): void {
        if (equity > this.peakEquity) this.peakEquity = equity;
        const drawdown = this.peakEquity - equity;
        if (drawdown > this.maxDrawdown) {
            this.maxDrawdown = drawdown;
            this.maxDrawdownPct = this.peakEquity > 0 ? drawdown / this.peakEquity : 0;
        }
        const point = { time, equity, balance, drawdown };
        const curve = this.equityCurve;
        const last = curve[curve.length - 1];
        if (!last) {
            curve.push(point);
            return;
        }
        // A curve that goes back in time is not a curve.
        if (time < last.time) return;
        if (balance !== last.balance || time - last.time >= this.sampleMs) {
            curve.push(point);
            this.thin();
            return;
        }
        // Only a mark is replaced; a settlement stays where it was recorded.
        const before = curve[curve.length - 2];
        if (!before || before.balance === last.balance) curve[curve.length - 1] = point;
    }

    /** Halve the sampled points once the curve gets long. Every settlement survives. */
    private thin(): void {
        const curve = this.equityCurve;
        if (curve.length <= MAX_POINTS) return;
        const kept = [curve[0]!];
        let skip = false;
        for (let i = 1; i < curve.length - 1; i += 1) {
            if (curve[i]!.balance !== curve[i - 1]!.balance) {
                kept.push(curve[i]!);
                continue;
            }
            skip = !skip;
            if (!skip) kept.push(curve[i]!);
        }
        kept.push(curve[curve.length - 1]!);
        if (kept.length === curve.length) return;
        this.equityCurve = kept;
        this.sampleMs *= 2;
    }

    snapshot(): LedgerSnapshot {
        return {
            createdAt: this.createdAt,
            peakEquity: this.peakEquity,
            maxDrawdown: this.maxDrawdown,
            maxDrawdownPct: this.maxDrawdownPct,
            sampleMs: this.sampleMs,
            equityCurve: this.equityCurve,
        };
    }

    static restore(data: Partial<LedgerSnapshot>, equity: number): Ledger {
        const ledger = new Ledger(equity);
        if (Number.isFinite(data.createdAt)) ledger.createdAt = data.createdAt!;
        if (Number.isFinite(data.peakEquity)) ledger.peakEquity = data.peakEquity!;
        if (Number.isFinite(data.maxDrawdown)) ledger.maxDrawdown = data.maxDrawdown!;
        if (Number.isFinite(data.maxDrawdownPct)) ledger.maxDrawdownPct = data.maxDrawdownPct!;
        if (Number.isFinite(data.sampleMs) && data.sampleMs! > 0) ledger.sampleMs = data.sampleMs!;
        if (Array.isArray(data.equityCurve)) ledger.equityCurve = data.equityCurve;
        return ledger;
    }
}

export class PaperAccount {
    private readonly byKey = new Map<string, PaperController>();
    private readonly settings: PaperSettings;
    private readonly canonical: (symbol: string) => string;
    private readonly chimes: boolean;
    private readonly ledger: Ledger;
    readonly initialBalance: number;
    private statsCache: RunStats | null = null;
    private statsAt = -1;
    private historyCache: readonly HistoryRow[] | null = null;
    private historyAt = -1;

    onAccountChange: (() => void) | null;
    onPersist: (() => void) | null;

    constructor(opts: PaperAccountOptions) {
        this.settings = opts.settings;
        this.canonical = opts.canonical ?? ((symbol) => symbol);
        this.chimes = opts.chime === true;
        this.onAccountChange = opts.onAccountChange ?? null;
        this.onPersist = opts.onPersist ?? null;

        const restore = opts.restore;
        if (restore) {
            const primary = this.addLeg(restore.symbol, restore.session);
            this.initialBalance = primary.broker.initialBalance;
            for (const extra of restore.extra?.legs ?? []) this.addLeg(extra.symbol, extra.session);
            const equity = this.equity();
            /* An account written before there was a ledger had one leg, and that leg's session
             * kept exactly what the ledger would have — so it is where the ledger begins. */
            this.ledger = restore.extra?.ledger
                ? Ledger.restore(restore.extra.ledger, equity)
                : Ledger.restore({
                    createdAt: primary.session.createdAt,
                    peakEquity: primary.session.peakEquity,
                    maxDrawdown: primary.session.maxDrawdown,
                    maxDrawdownPct: primary.session.maxDrawdownPct,
                    sampleMs: primary.session.sampleMs,
                    equityCurve: primary.session.equityCurve,
                }, equity);
        } else {
            this.initialBalance = opts.settings.balance;
            this.ledger = new Ledger(this.initialBalance);
            if (opts.symbol) this.legFor(opts.symbol);
        }
    }

    /* --- the legs --------------------------------------------------------- */

    /** The leg trading `symbol`, started empty the first time it is asked for. */
    legFor(symbol: string): PaperController {
        return this.find(symbol) ?? this.addLeg(symbol, null);
    }

    /** The one name a market goes by here, however a chart writes it. */
    keyOf(symbol: string): string {
        return this.canonical(symbol);
    }

    /** The leg trading `symbol`, or null when the account has never been there. */
    find(symbol: string): PaperController | null {
        return this.byKey.get(this.canonical(symbol)) ?? null;
    }

    legs(): PaperController[] {
        return [...this.byKey.values()];
    }

    private addLeg(symbol: string, restore: unknown): PaperController {
        const leg = new PaperController({
            symbol,
            // Every leg starts from the account's own balance, so what it settles is a difference.
            settings: { ...this.settings, balance: this.initialBalance ?? this.settings.balance },
            ...(restore != null ? { restore } : {}),
            chime: this.chimes,
            accountEquity: () => this.equity(),
            onPersist: () => this.onPersist?.(),
        });
        leg.onAccountChange = () => this.changed();
        this.byKey.set(this.canonical(symbol), leg);
        return leg;
    }

    /** A leg that has done nothing: no fill, nothing open, nothing waiting. */
    private static empty(leg: PaperController): boolean {
        const broker = leg.broker;
        return broker.fills.length === 0 && broker.positions.length === 0 && broker.pending.length === 0;
    }

    /** The legs that have something to say — what a book labels its rows by. */
    private busy(): PaperController[] {
        return this.legs().filter((leg) => !PaperAccount.empty(leg));
    }

    /** The leg that holds a position, or null. */
    ownerOfPosition(positionId: number): PaperController | null {
        return this.legs().find((leg) => leg.broker.positionById(positionId) != null) ?? null;
    }

    /** The leg that has an order working, or null. */
    ownerOfOrder(orderId: number): PaperController | null {
        return this.legs().find((leg) => leg.broker.pending.some((o) => o.id === orderId)) ?? null;
    }

    private requirePosition(positionId: number): PaperController {
        const leg = this.ownerOfPosition(positionId);
        if (!leg) throw new Error('There is no such position open');
        return leg;
    }

    /* --- the money -------------------------------------------------------- */

    /** Realised only: what the account started with plus what every leg has settled. */
    cash(): number {
        let cash = this.initialBalance;
        for (const leg of this.byKey.values()) cash += leg.broker.balance - leg.broker.initialBalance;
        return cash;
    }

    private unrealized(): number {
        let open = 0;
        for (const leg of this.byKey.values()) open += leg.broker.unrealizedPnl;
        return open;
    }

    /** What the account is worth: its cash and what every leg holds open, at the last prices. */
    equity(): number {
        return this.cash() + this.unrealized();
    }

    /** The slice of a Broker an account readout reads, across every leg. */
    private source(): Parameters<typeof accountFigures>[0] {
        const legs = this.legs();
        return {
            balance: this.cash(),
            equity: this.equity(),
            unrealizedPnl: this.unrealized(),
            netSize: legs.reduce((sum, leg) => sum + leg.broker.netSize, 0),
            initialBalance: this.initialBalance,
            positions: legs.flatMap((leg) => leg.broker.positions),
            exitResult: (position, price) => {
                const leg = legs.find((l) => l.broker.positions.includes(position as Position));
                if (!leg) throw new Error('exitResult: there is no such position');
                return leg.broker.exitResult(position as Position, price);
            },
        };
    }

    /** What the account is worth right now — for a readout, never for a decision. */
    account(): AccountFigures {
        return accountFigures(this.source());
    }

    /* --- what is open ----------------------------------------------------- */

    /** What is open across every leg, for the gestures and the close-everything button. */
    positions(): readonly ControlledPosition[] {
        return this.legs().flatMap((leg) => leg.positions());
    }

    /** The first position held, in the order the legs were opened — what a bare break-even means. */
    get position(): Position | null {
        for (const leg of this.byKey.values()) {
            const held = leg.broker.position;
            if (held) return held;
        }
        return null;
    }

    /** Why moving `position`'s stop to break-even is refused, or null. */
    breakEvenRefusal(position: Position): string | null {
        const leg = this.ownerOfPosition(position.id);
        return leg ? leg.broker.breakEvenRefusal(position) : 'Nothing is open.';
    }

    get openCount(): number {
        return this.legs().reduce((sum, leg) => sum + leg.broker.positions.length, 0);
    }

    get isIdle(): boolean {
        return this.legs().every((leg) => leg.session.isIdle);
    }

    /** What is open and what is waiting, every row saying which market it is in once more than one is. */
    book(): TradeBook {
        const multi = this.busy().length > 1;
        const positions: TradeBook['positions'] = [];
        const orders: TradeBook['orders'] = [];
        for (const leg of this.legs()) {
            const book = leg.book();
            for (const row of book.positions) positions.push(multi ? { ...row, symbol: leg.symbol } : row);
            for (const row of book.orders) orders.push(multi ? { ...row, symbol: leg.symbol } : row);
        }
        return { positions, orders, multi };
    }

    /* --- what it has done ------------------------------------------------- */

    get tradeCount(): number {
        return this.legs().reduce((sum, leg) => sum + leg.broker.trades.length, 0);
    }

    get openedAt(): number {
        return this.ledger.createdAt;
    }

    /** What to call the account where one name is wanted — its market, or how many it has. */
    get title(): string {
        const busy = this.busy();
        if (busy.length > 1) return `${busy.length} markets`;
        return (busy[0] ?? this.legs()[0])?.symbol ?? 'Paper account';
    }

    /** Every closed trade of every leg, oldest first, each saying which market it was in. */
    private trades(): ClosedTrade[] {
        return this.legs()
            .flatMap((leg) => (leg.broker.trades as ClosedTrade[]).map((t) => ({ ...t, symbol: leg.symbol })))
            .sort((a, b) => a.closedAt - b.closedAt);
    }

    /** Closed round trips, newest first — cached against the trade count, as a leg's own is. */
    history(): readonly HistoryRow[] {
        const total = this.tradeCount;
        if (!this.historyCache || this.historyAt !== total) {
            this.historyCache = tradeHistory(this.trades());
            this.historyAt = total;
        }
        return this.historyCache;
    }

    /** Fills only grow, so the walk over them is cached against their count. */
    private fillCount(): number {
        return this.legs().reduce((sum, leg) => sum + leg.broker.fills.length, 0);
    }

    private barsPlayed(): number {
        return this.legs().reduce((sum, leg) => sum + leg.session.barsPlayed, 0);
    }

    /** The figures every stored run reports, over the whole account. */
    stats(): RunStats {
        const fills = this.fillCount();
        if (!this.statsCache || this.statsAt !== fills) {
            this.statsCache = this.summary();
            this.statsAt = fills;
        }
        const equity = this.equity();
        const netPnl = equity - this.initialBalance;
        return {
            ...this.statsCache,
            finalEquity: equity,
            netPnl,
            returnPct: this.initialBalance > 0 ? netPnl / this.initialBalance : 0,
            maxDrawdown: this.ledger.maxDrawdown,
            maxDrawdownPct: this.ledger.maxDrawdownPct,
        };
    }

    private summary(): RunStats {
        const legs = this.legs();
        /* `summarize` reads four things off a broker. The account has no Broker; it is told what
         * one would say. */
        const stand = {
            trades: this.trades(),
            fills: legs.flatMap((leg) => leg.broker.fills),
            equity: this.equity(),
            initialBalance: this.initialBalance,
        } as unknown as Broker;
        return summarize({
            broker: stand,
            equityCurve: this.ledger.equityCurve,
            maxDrawdown: this.ledger.maxDrawdown,
            maxDrawdownPct: this.ledger.maxDrawdownPct,
            barCount: this.barsPlayed(),
        });
    }

    /** The account as one finished run — what the analysis screen reads. */
    result(resolution: string | null = null): LiveResult {
        const legs = this.legs();
        const firsts = legs.map((leg) => leg.session.firstBarTime).filter((t): t is number => t != null);
        const times = legs.map((leg) => leg.broker.time).filter((t): t is number => t != null);
        const first = legs[0];
        return {
            trades: this.trades(),
            fills: legs.flatMap((leg) => leg.broker.fills),
            orders: legs.flatMap((leg) => leg.broker.orders),
            equityCurve: this.ledger.equityCurve,
            openPosition: this.position ? { ...this.position } : null,
            stats: this.stats(),
            warmupBars: 0,
            barCount: this.barsPlayed(),
            stepMs: null,
            costs: { ...(first?.broker.costs ?? { feeRate: 0, feePerUnit: 0, spreadPct: 0, slippagePct: 0 }) },
            initialBalance: this.initialBalance,
            resolution,
            elapsedMs: Date.now() - this.ledger.createdAt,
            from: firsts.length ? Math.min(...firsts) : this.ledger.createdAt,
            to: times.length ? Math.max(...times) : Date.now(),
        };
    }

    /* --- trading, by the id of what is acted on --------------------------- */

    closeOne(positionId: number): void {
        this.requirePosition(positionId).closeOne(positionId);
    }

    closePart(size: number, positionId: number): void {
        this.requirePosition(positionId).closePart(size, positionId);
    }

    reverse(positionId: number): void {
        this.requirePosition(positionId).reverse(positionId);
    }

    breakEven(positionId?: number | null): boolean {
        if (positionId == null) {
            const held = this.position;
            return held ? this.breakEven(held.id) : false;
        }
        return this.requirePosition(positionId).breakEven(positionId);
    }

    protect(levels: ProtectionLevels, positionId: number): void {
        this.requirePosition(positionId).protect(levels, positionId);
    }

    setTrailing(distance: number, positionId: number): void {
        this.requirePosition(positionId).setTrailing(distance, {}, positionId);
    }

    cancelOrder(orderId: number): boolean {
        const leg = this.ownerOfOrder(orderId);
        return leg ? leg.cancelOrder(orderId) : false;
    }

    /** Close everything in every market, and cancel everything waiting. */
    flatten(): void {
        const refused: string[] = [];
        for (const leg of this.legs()) {
            try {
                leg.flatten();
            } catch (err: unknown) {
                refused.push(err instanceof Error ? err.message : String(err));
            }
        }
        if (refused.length > 0) throw new Error(refused.join(' '));
    }

    cancelAll(): void {
        for (const leg of this.legs()) leg.cancelAll();
    }

    /* --- persistence ------------------------------------------------------ */

    /**
     * The account, ready to be written down.
     *
     * The first leg goes where a one-market account's only leg always went, so a record reads the
     * way it did; the others, and the account's own curve, ride along in `extra`. A leg that never
     * did anything is not written — a market looked at is not a market traded.
     */
    snapshot(): PaperAccountSnapshot {
        const legs = this.legs();
        const [primary, ...rest] = legs;
        if (!primary) throw new Error('A paper account has no market yet — nothing to write down.');
        const first = primary.snapshot();
        return {
            symbol: first.symbol,
            session: first.session,
            extra: {
                version: 1,
                legs: rest
                    .filter((leg) => !PaperAccount.empty(leg))
                    .map((leg) => leg.snapshot()),
                ledger: this.ledger.snapshot(),
            },
        };
    }

    /* --- internals -------------------------------------------------------- */

    private changed(): void {
        const times = this.legs().map((leg) => leg.broker.time).filter((t): t is number => t != null);
        this.ledger.record(times.length ? Math.max(...times) : Date.now(), this.equity(), this.cash());
        this.onAccountChange?.();
    }
}
