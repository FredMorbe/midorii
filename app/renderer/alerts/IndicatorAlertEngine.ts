import type { DataProvider } from '../../../src/plugin';
import type { OHLCV } from '../../../src/core/model/ohlcv';
import type { IndicatorAlertStore } from './IndicatorAlertStore';
import { coolingDown } from './alertCooldown';
import { crossed, reading, sideOf, type IndicatorAlert, type Reading } from './indicatorAlertModel';
import { symbolProvider, symbolTicker } from './alertTypes';

/** Bars kept per watched market: enough for an indicator to be warm and settled on its newest bar. */
const HISTORY_BARS = 500;
/** A feed can tick many times a second; the indicators are recomputed at most this often. */
const EVALUATE_EVERY_MS = 500;

type ProviderFactories = Record<string, () => DataProvider>;

interface Group {
    symbol: string;
    timeframe: string;
    bars: OHLCV[];
    loaded: boolean;
    /** Live bars that arrived while the history was still loading. */
    pending: OHLCV[];
    unsubscribe: () => void;
    /** The side of its comparison each alert was last seen on, with what that was computed from. */
    last: Map<string, { signature: string; side: number | null }>;
    timer: ReturnType<typeof setTimeout> | null;
    lastRun: number;
    closed: boolean;
}

const signatureOf = (a: IndicatorAlert): string => JSON.stringify([a.indicator, a.inputs, a.plot, a.against]);

/** Put a bar from the feed into the series: the forming bar replaces the last, a newer one is appended, an older one is dropped. */
export function applyBar(bars: OHLCV[], bar: OHLCV): void {
    const last = bars[bars.length - 1];
    if (!last || bar.time > last.time) bars.push(bar);
    else if (bar.time === last.time) bars[bars.length - 1] = bar;
}

/**
 * Watches every market and timeframe with an enabled indicator alert: one subscription each,
 * shared by the alerts on it, open whatever the chart shows. The history comes from `getBars`,
 * the newest bar from the live stream, and each alert is checked against the indicator's value
 * on that newest bar. A crossing is a change of side between two checks, so a fresh watch never
 * fires on its first reading: there is nothing yet to have crossed from.
 */
export class IndicatorAlertEngine {
    private readonly groups = new Map<string, Group>();
    private unsubStore: (() => void) | null = null;
    private readonly reported = new Set<string>();

    constructor(
        private readonly store: IndicatorAlertStore,
        private readonly providers: ProviderFactories,
        private readonly onTrigger: (alert: IndicatorAlert, reading: Reading) => void,
        private readonly onError: (alert: IndicatorAlert, err: unknown) => void,
        private readonly now: () => number = () => Date.now(),
    ) {}

    start(): void {
        this.unsubStore = this.store.onChange(() => this.resync());
        this.resync();
    }

    stop(): void {
        this.unsubStore?.();
        this.unsubStore = null;
        for (const group of [...this.groups.values()]) this.close(group);
        this.groups.clear();
    }

    /** How many markets are being watched right now. */
    get openCount(): number {
        return this.groups.size;
    }

    private resync(): void {
        const needed = new Map<string, { symbol: string; timeframe: string }>();
        for (const a of this.store.list()) {
            if (a.enabled) needed.set(`${a.symbol}|${a.timeframe}`, { symbol: a.symbol, timeframe: a.timeframe });
        }
        for (const [key, group] of this.groups) {
            if (needed.has(key)) continue;
            this.close(group);
            this.groups.delete(key);
        }
        for (const [key, want] of needed) {
            if (!this.groups.has(key)) this.open(key, want.symbol, want.timeframe);
        }
        // An edit (or a disable) changes which alerts a running group serves.
        for (const group of this.groups.values()) if (group.loaded) this.evaluate(group);
    }

    private fail(alert: IndicatorAlert, err: unknown): void {
        if (this.reported.has(alert.id)) return;
        this.reported.add(alert.id);
        this.onError(alert, err);
    }

    private open(key: string, symbol: string, timeframe: string): void {
        const group: Group = {
            symbol, timeframe, bars: [], loaded: false, pending: [], unsubscribe: () => undefined,
            last: new Map(), timer: null, lastRun: 0, closed: false,
        };
        this.groups.set(key, group);
        const servedBy = this.store.list().filter((a) => a.enabled && a.symbol === symbol && a.timeframe === timeframe);

        const providerId = symbolProvider(symbol);
        const factory = providerId ? this.providers[providerId] : undefined;
        if (!factory) {
            for (const a of servedBy) this.fail(a, new Error(`No data source named "${providerId ?? symbol}"`));
            return;
        }
        let provider: DataProvider;
        try {
            provider = factory();
        } catch (err) {
            for (const a of servedBy) this.fail(a, err);
            return;
        }
        if (!provider.subscribe) {
            for (const a of servedBy) this.fail(a, new Error(`${providerId} has no live feed to watch`));
            return;
        }
        const ticker = symbolTicker(symbol);
        group.unsubscribe = provider.subscribe(ticker, timeframe, (bar) => {
            if (group.closed) return;
            if (!group.loaded) { group.pending.push(bar); return; }
            applyBar(group.bars, bar);
            this.schedule(group);
        });
        provider.getBars(ticker, timeframe, { limit: HISTORY_BARS }).then((history) => {
            if (group.closed) return;
            group.bars = [...history];
            for (const bar of group.pending) applyBar(group.bars, bar);
            group.pending = [];
            group.loaded = true;
            this.evaluate(group);
        }).catch((err: unknown) => {
            for (const a of this.store.list()) {
                if (a.enabled && a.symbol === symbol && a.timeframe === timeframe) this.fail(a, err);
            }
        });
    }

    private close(group: Group): void {
        group.closed = true;
        if (group.timer) clearTimeout(group.timer);
        group.timer = null;
        group.unsubscribe();
    }

    private schedule(group: Group): void {
        if (group.timer) return;
        const wait = Math.max(0, group.lastRun + EVALUATE_EVERY_MS - this.now());
        group.timer = setTimeout(() => {
            group.timer = null;
            if (!group.closed) this.evaluate(group);
        }, wait);
    }

    private evaluate(group: Group): void {
        group.lastRun = this.now();
        const alerts = this.store.list().filter((a) => a.enabled && a.symbol === group.symbol && a.timeframe === group.timeframe);
        const seen = new Set<string>();
        for (const alert of alerts) {
            seen.add(alert.id);
            let r: Reading;
            try {
                r = reading(alert, group.bars);
            } catch (err) {
                this.fail(alert, err);
                continue;
            }
            const side = sideOf(r);
            const signature = signatureOf(alert);
            const before = group.last.get(alert.id);
            // An edited alert starts over: its old side was measured against something else.
            const prev = before && before.signature === signature ? before.side : null;
            group.last.set(alert.id, { signature, side });
            if (crossed(prev, side, alert.condition) && !coolingDown(alert, this.now())) {
                this.store.update(alert.id, { enabled: !alert.once, lastTriggeredAt: this.now() });
                this.onTrigger(alert, r);
            }
        }
        for (const id of group.last.keys()) if (!seen.has(id)) group.last.delete(id);
    }
}
