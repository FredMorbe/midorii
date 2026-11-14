import type { DataProvider } from '../../../src/plugin';
import type { AlertListStore } from './AlertListStore';
import { moveReached, movePercent, type PercentAlert } from './percentAlertModel';
import { symbolProvider, symbolTicker } from './alertTypes';

/** The feed's own granularity for every watch, whatever the chart shows: fine enough to catch a move promptly. */
const WATCH_TIMEFRAME = '1';

type ProviderFactories = Record<string, () => DataProvider>;

/**
 * Watches the live feed of every market with an enabled percent alert: one subscription each,
 * shared by the alerts on it. The first price seen becomes an alert's reference; each later
 * price is measured against it. A repeating alert that fires moves its reference to the price
 * it fired at, so the next move is measured from there. A `once` alert disables itself and
 * forgets its reference, so switching it on again starts from the price of that moment.
 */
export class PercentAlertEngine {
    private readonly unsubscribes = new Map<string, () => void>();
    private unsubStore: (() => void) | null = null;
    private readonly reported = new Set<string>();

    constructor(
        private readonly store: AlertListStore<PercentAlert>,
        private readonly providers: ProviderFactories,
        private readonly onTrigger: (alert: PercentAlert, price: number, move: number) => void,
        private readonly onError: (alert: PercentAlert, err: unknown) => void,
        private readonly now: () => number = () => Date.now(),
    ) {}

    start(): void {
        this.unsubStore = this.store.onChange(() => this.resync());
        this.resync();
    }

    stop(): void {
        this.unsubStore?.();
        this.unsubStore = null;
        for (const off of this.unsubscribes.values()) off();
        this.unsubscribes.clear();
    }

    /** How many markets are being watched right now. */
    get openCount(): number {
        return this.unsubscribes.size;
    }

    private resync(): void {
        const needed = new Set(this.store.list().filter((a) => a.enabled).map((a) => a.symbol));
        for (const [symbol, off] of this.unsubscribes) {
            if (needed.has(symbol)) continue;
            off();
            this.unsubscribes.delete(symbol);
        }
        for (const symbol of needed) if (!this.unsubscribes.has(symbol)) this.open(symbol);
    }

    private servedBy(symbol: string): PercentAlert[] {
        return this.store.list().filter((a) => a.enabled && a.symbol === symbol);
    }

    private fail(symbol: string, err: unknown): void {
        for (const alert of this.servedBy(symbol)) {
            if (this.reported.has(alert.id)) continue;
            this.reported.add(alert.id);
            this.onError(alert, err);
        }
    }

    private open(symbol: string): void {
        const providerId = symbolProvider(symbol);
        const factory = providerId ? this.providers[providerId] : undefined;
        if (!factory) {
            this.fail(symbol, new Error(`No data source named "${providerId ?? symbol}"`));
            return;
        }
        let provider: DataProvider;
        try {
            provider = factory();
        } catch (err) {
            this.fail(symbol, err);
            return;
        }
        if (!provider.subscribe) {
            this.fail(symbol, new Error(`${providerId} has no live feed to watch`));
            return;
        }
        this.unsubscribes.set(symbol, provider.subscribe(symbolTicker(symbol), WATCH_TIMEFRAME, (bar) => this.check(symbol, bar.close)));
    }

    private check(symbol: string, price: number): void {
        if (!Number.isFinite(price)) return;
        for (const alert of this.servedBy(symbol)) {
            if (alert.reference == null) {
                this.store.update(alert.id, { reference: price });
                continue;
            }
            if (!moveReached(alert, price)) continue;
            const move = movePercent(alert.reference, price);
            this.store.update(alert.id, alert.once
                ? { enabled: false, reference: null, lastTriggeredAt: this.now() }
                : { reference: price, lastTriggeredAt: this.now() });
            this.onTrigger(alert, price, move);
        }
    }
}
