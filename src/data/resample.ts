import type { OHLCV } from '../core/model/ohlcv';

const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/**
 * The exact length of a timeframe of fixed duration, in ms. Null for the calendar month, whose
 * length is not fixed, and for anything that does not parse. A bare number is minutes, `D` and
 * `W` are a day and a week, and `30S`, `15m`, `4h`, `1d` and `1w` are read as written.
 */
export function fixedTimeframeMs(timeframe: string): number | null {
    const tf = timeframe.trim();
    if (tf === 'D') return UNIT_MS.d!;
    if (tf === 'W') return UNIT_MS.w!;
    if (tf === 'M') return null;
    const m = /^(\d+)\s*([smhdw])?$/i.exec(tf);
    if (!m) return null;
    const n = parseInt(m[1]!, 10);
    return n > 0 ? n * UNIT_MS[(m[2] ?? 'm').toLowerCase()]! : null;
}

/** How a timeframe a provider does not serve is built from one it does. */
export interface ResamplePlan {
    /** The provider's own timeframe to fetch, spelled the way it declares it. */
    base: string;
    /** The length of the timeframe asked for, in ms. */
    bucketMs: number;
    /** How many base candles make one: 1 means the provider serves it natively under another spelling. */
    ratio: number;
}

/**
 * Work out how to serve `target` from the timeframes a provider declares, or null when it can
 * be asked for as it is (or when it cannot be built at all).
 *
 * A timeframe the provider declares under another spelling (`1440` for `D`) is answered with
 * that spelling and a ratio of 1. Otherwise the target is built from the LONGEST declared
 * timeframe that divides it exactly, which needs the fewest candles. The week is never a base:
 * its candles start on the venue's own weekday, not on a multiple of its length.
 */
export function planResample(target: string, supported: readonly string[] | undefined): ResamplePlan | null {
    if (!supported || supported.length === 0 || supported.includes(target)) return null;
    const want = fixedTimeframeMs(target);
    if (want == null) return null;

    let best: { tf: string; ms: number } | null = null;
    for (const tf of supported) {
        const ms = fixedTimeframeMs(tf);
        if (ms == null) continue;
        if (ms === want) return { base: tf, bucketMs: want, ratio: 1 };
        if (tf === 'W' || ms > want || want % ms !== 0) continue;
        if (!best || ms > best.ms) best = { tf, ms };
    }
    return best ? { base: best.tf, bucketMs: want, ratio: want / best.ms } : null;
}

/**
 * Combine candles into buckets of `bucketMs` aligned to the epoch: the first open, the highest
 * high, the lowest low, the last close and the summed volume. Input in any order; output
 * ascending, one bar per bucket that has at least one candle.
 */
export function aggregateBars(bars: readonly OHLCV[], bucketMs: number): OHLCV[] {
    const sorted = [...bars].sort((a, b) => a.time - b.time);
    const out: OHLCV[] = [];
    let current: OHLCV | null = null;
    for (const bar of sorted) {
        const start = Math.floor(bar.time / bucketMs) * bucketMs;
        if (current && current.time === start) {
            current.high = Math.max(current.high, bar.high);
            current.low = Math.min(current.low, bar.low);
            current.close = bar.close;
            if (bar.volume != null) current.volume = (current.volume ?? 0) + bar.volume;
        } else {
            current = { time: start, open: bar.open, high: bar.high, low: bar.low, close: bar.close, ...(bar.volume != null ? { volume: bar.volume } : {}) };
            out.push(current);
        }
    }
    return out;
}
