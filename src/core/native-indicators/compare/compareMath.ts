import type { OHLCV } from '../../model/ohlcv';

/**
 * The pure side of the compare and spread indicators: lining a second market's closes up with
 * the chart's own bars, and the three ways of putting the two together. No chart, no fetching,
 * so every case here is testable on plain arrays.
 */

export type SpreadMode = 'ratio' | 'difference';

/** The second market's close at each of the chart's bars, by open time; null where it has no bar. */
export function alignCloses(main: readonly OHLCV[], other: ReadonlyMap<number, number>): Array<number | null> {
    return main.map((bar) => {
        const value = other.get(bar.time);
        return value != null && Number.isFinite(value) ? value : null;
    });
}

/**
 * The bar the second market is measured from: the first one at or after `fromTime` where both
 * markets have a price, or the first such bar at all when `fromTime` is null or past every bar.
 * -1 when the markets never have a price on the same bar.
 */
export function anchorIndex(main: readonly OHLCV[], aligned: ReadonlyArray<number | null>, fromTime: number | null): number {
    let first = -1;
    for (let i = 0; i < main.length; i++) {
        if (aligned[i] == null || !(main[i]!.close > 0) || !(aligned[i]! > 0)) continue;
        if (first < 0) first = i;
        if (fromTime == null || main[i]!.time >= fromTime) return i;
    }
    return first;
}

/**
 * The second market rebased onto the chart's own price scale: it starts where the chart's market
 * is at the anchor and moves by the same share the second market does. Two markets that move
 * alike lie on top of each other; the one that moves more runs away from the other. NaN before
 * the anchor's data and wherever the second market has no bar.
 */
export function rebased(main: readonly OHLCV[], aligned: ReadonlyArray<number | null>, anchor: number): number[] {
    const out = new Array<number>(main.length).fill(Number.NaN);
    if (anchor < 0) return out;
    const scale = main[anchor]!.close / aligned[anchor]!;
    for (let i = 0; i < main.length; i++) {
        const value = aligned[i];
        if (value != null) out[i] = value * scale;
    }
    return out;
}

/** The chart's close against the second market's: their ratio, or the plain difference. NaN where either is missing. */
export function spreadValues(main: readonly OHLCV[], aligned: ReadonlyArray<number | null>, mode: SpreadMode): number[] {
    return main.map((bar, i) => {
        const other = aligned[i];
        if (other == null || !Number.isFinite(bar.close)) return Number.NaN;
        if (mode === 'ratio') return other === 0 ? Number.NaN : bar.close / other;
        return bar.close - other;
    });
}
