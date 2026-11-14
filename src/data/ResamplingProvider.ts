import type { DataProvider } from '../core/ports/DataProvider';
import type { BarRange } from '../core/ports/MarketDataFeed';
import type { OHLCV } from '../core/model/ohlcv';
import type { Unsubscribe } from '../core/util/types';
import { aggregateBars, planResample } from './resample';

export interface ResamplingOptions {
    /** The most candles one request for a built timeframe may ask the provider for. Default 20 000. */
    maxBaseBars?: number;
}

const DEFAULT_MAX_BASE_BARS = 20_000;

/**
 * Serve any timeframe whole multiples of one the provider declares, so a chart can be on 7
 * minutes or 3 hours whatever the venue offers.
 *
 * What the provider declares in `info().supportedTimeframes` is passed through untouched. For
 * anything else the wrapper asks for the longest declared timeframe that divides it and builds
 * the candles, aligned to the epoch. A provider that declares nothing is taken at its word and
 * passed through whole, as is everything else the provider does.
 *
 * Live, the forming candle is built from the base stream, seeded with the base candles the
 * current bucket already has. A provider without a stream stays without one; the feed polls
 * `getBars` for it as it did before.
 *
 * Built candles are never written back anywhere: the base candles stay the source of truth.
 */
export function withResampling(provider: DataProvider, options: ResamplingOptions = {}): DataProvider {
    const maxBase = options.maxBaseBars ?? DEFAULT_MAX_BASE_BARS;
    const planFor = (timeframe: string) => planResample(timeframe, provider.info?.()?.supportedTimeframes);

    const getBars = async (ticker: string, timeframe: string, range: BarRange): Promise<OHLCV[]> => {
        const plan = planFor(timeframe);
        if (!plan) return provider.getBars(ticker, timeframe, range);
        if (plan.ratio === 1) return provider.getBars(ticker, plan.base, range);

        const sub: BarRange = { ...range };
        // Start on a bucket boundary, so the first built candle is whole rather than a partial one.
        if (range.from != null) sub.from = Math.floor(range.from / plan.bucketMs) * plan.bucketMs;
        // One bucket more than asked for: the oldest is usually partial and is dropped below.
        if (range.limit != null) sub.limit = Math.min(range.limit * plan.ratio + plan.ratio, maxBase);
        const built = aggregateBars(await provider.getBars(ticker, plan.base, sub), plan.bucketMs);
        return range.limit != null && built.length > range.limit ? built.slice(-range.limit) : built;
    };

    const overrides: Partial<DataProvider> = { getBars };

    if (provider.getBarsProgressive) {
        overrides.getBarsProgressive = async (ticker, timeframe, range, onBatch, opts) => {
            const plan = planFor(timeframe);
            if (!plan || plan.ratio === 1) {
                return provider.getBarsProgressive!(ticker, plan ? plan.base : timeframe, range, onBatch, opts);
            }
            const bars = await getBars(ticker, timeframe, range);
            onBatch(bars);
            return bars;
        };
    }

    if (provider.subscribe) {
        overrides.subscribe = (ticker, timeframe, onBar): Unsubscribe => {
            const plan = planFor(timeframe);
            if (!plan || plan.ratio === 1) return provider.subscribe!(ticker, plan ? plan.base : timeframe, onBar);
            return subscribeBuilt(provider, ticker, plan.base, plan.bucketMs, onBar);
        };
    }

    return new Proxy(provider, {
        get(target, prop) {
            if (Object.prototype.hasOwnProperty.call(overrides, prop)) return overrides[prop as keyof DataProvider];
            const value = Reflect.get(target, prop, target) as unknown;
            return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        },
    });
}

/** The forming candle of a built timeframe, from the base stream and the base candles its bucket already has. */
function subscribeBuilt(
    provider: DataProvider,
    ticker: string,
    base: string,
    bucketMs: number,
    onBar: (bar: OHLCV) => void,
): Unsubscribe {
    let closed = false;
    let seeded = false;
    let bucket = -1;
    const parts = new Map<number, OHLCV>();
    const waiting: OHLCV[] = [];

    const take = (bar: OHLCV): void => {
        const start = Math.floor(bar.time / bucketMs) * bucketMs;
        if (start < bucket) return; // a late candle from a bucket that is already over
        if (start > bucket) {
            bucket = start;
            parts.clear();
        }
        parts.set(bar.time, bar);
    };
    const emit = (): void => {
        if (closed || parts.size === 0) return;
        const built = aggregateBars([...parts.values()], bucketMs)[0];
        if (built) onBar(built);
    };

    const stop = provider.subscribe!(ticker, base, (bar) => {
        if (closed) return;
        if (!seeded) {
            waiting.push(bar);
            return;
        }
        take(bar);
        emit();
    });

    const now = Date.now();
    provider.getBars(ticker, base, { from: Math.floor(now / bucketMs) * bucketMs, to: now })
        .catch((err: unknown) => {
            // The stream alone still builds the candle, only from its first update on.
            console.warn(`[vela] could not seed the forming ${base} candles of ${ticker}`, err);
            return [] as OHLCV[];
        })
        .then((history) => {
            if (closed) return;
            for (const bar of history) take(bar);
            for (const bar of waiting) take(bar);
            waiting.length = 0;
            seeded = true;
            emit();
        });

    return () => {
        closed = true;
        stop();
    };
}
