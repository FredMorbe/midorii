import type { DataProvider } from '../../../src/plugin';
import { symbolProvider, symbolTicker } from '../alerts/alertTypes';

/**
 * One price per market, however many places want to show it.
 *
 * A watchlist row needs the last price and the close it is measured against. Each market is
 * opened once — one history request for the reference, one live subscription for the price —
 * and every listener on it shares that. The last listener leaving closes the subscription, so
 * a panel that is shut costs nothing: no stream is held open for rows nobody can see.
 *
 * Provider instances are made per market, the same way the alert engine makes them: some
 * venues hold a slot per subscription (Capital.com), and giving each market its own instance
 * keeps releasing one from touching another.
 */

export interface PriceSnapshot {
    /** The last price seen, from the stream or — until it speaks — the last daily close. */
    price: number | null;
    /** The previous daily close: what the change is measured against. */
    reference: number | null;
    /** The stream has delivered at least one price. False for a market with no stream. */
    live: boolean;
    /** Why there is nothing to show, or why the change is missing. Null when all is well. */
    error: string | null;
}

export type PriceListener = (snapshot: PriceSnapshot) => void;
type ProviderFactories = Record<string, () => DataProvider>;

/** Streamed at this granularity: fine enough to follow the price, cheap enough to hold open
 *  for a whole list. The same choice the alert engine makes. */
const STREAM_TIMEFRAME = '1';

/** History requests in flight at once. A fifty-row list opening must not fire fifty
 *  requests at a venue that rate-limits, so the rest wait their turn. */
const HISTORY_CONCURRENCY = 3;

interface Entry {
    snapshot: PriceSnapshot;
    listeners: Set<PriceListener>;
    stop: () => void;
    /** Set when the last listener left: a late history answer must not touch a dead entry. */
    closed: boolean;
}

function message(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

export class QuoteHub {
    private readonly entries = new Map<string, Entry>();
    private readonly waiting: Array<() => void> = [];
    private inFlight = 0;

    constructor(private readonly factories: ProviderFactories) {}

    /** Follow a market. The listener is called at once with what is known, then on every
     *  change. Returns what stops following it. */
    watch(symbol: string, listener: PriceListener): () => void {
        let entry = this.entries.get(symbol);
        if (!entry) {
            entry = this.open(symbol);
            this.entries.set(symbol, entry);
        }
        entry.listeners.add(listener);
        listener(entry.snapshot);

        const held = entry;
        return () => {
            held.listeners.delete(listener);
            if (held.listeners.size > 0) return;
            held.closed = true;
            held.stop();
            if (this.entries.get(symbol) === held) this.entries.delete(symbol);
        };
    }

    /** How many markets are open right now — what a test, or a curious console, asks. */
    get openCount(): number {
        return this.entries.size;
    }

    private open(symbol: string): Entry {
        const entry: Entry = {
            snapshot: { price: null, reference: null, live: false, error: null },
            listeners: new Set(),
            stop: () => undefined,
            closed: false,
        };
        const publish = (patch: Partial<PriceSnapshot>): void => {
            if (entry.closed) return;
            entry.snapshot = { ...entry.snapshot, ...patch };
            for (const listener of entry.listeners) listener(entry.snapshot);
        };

        const providerId = symbolProvider(symbol);
        const factory = providerId ? this.factories[providerId] : undefined;
        if (!factory) {
            // Published after the caller has its snapshot: `watch` hands over the current one
            // first and a synchronous publish here would run before the listener is added.
            entry.snapshot = { ...entry.snapshot, error: providerId ? `No data source named "${providerId}"` : 'The symbol names no data source' };
            return entry;
        }

        let provider: DataProvider;
        try {
            provider = factory();
        } catch (err) {
            entry.snapshot = { ...entry.snapshot, error: message(err) };
            return entry;
        }
        const ticker = symbolTicker(symbol);

        this.queueHistory(async () => {
            if (entry.closed) return;
            try {
                // Two daily bars: the one forming now and the close it is measured against.
                const bars = await provider.getBars(ticker, 'D', { limit: 2 });
                const last = bars[bars.length - 1];
                const previous = bars.length >= 2 ? bars[bars.length - 2] : undefined;
                publish({
                    price: entry.snapshot.price ?? last?.close ?? null,
                    reference: previous?.close ?? null,
                    error: last ? null : 'The data source returned no bars',
                });
            } catch (err) {
                console.warn(`[midorii] watchlist: no daily history for ${symbol} — ${message(err)}`);
                publish({ error: message(err) });
            }
        });

        if (typeof provider.subscribe === 'function') {
            try {
                entry.stop = provider.subscribe(ticker, STREAM_TIMEFRAME, (bar) => {
                    publish({ price: bar.close, live: true, error: null });
                });
            } catch (err) {
                console.warn(`[midorii] watchlist: could not stream ${symbol} — ${message(err)}`);
                entry.snapshot = { ...entry.snapshot, error: message(err) };
            }
        }
        return entry;
    }

    private queueHistory(job: () => Promise<void>): void {
        const run = (): void => {
            this.inFlight++;
            void job().finally(() => {
                this.inFlight--;
                this.waiting.shift()?.();
            });
        };
        if (this.inFlight < HISTORY_CONCURRENCY) run();
        else this.waiting.push(run);
    }
}
