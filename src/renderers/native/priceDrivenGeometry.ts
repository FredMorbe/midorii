import type { OHLCV } from '../../core/model/ohlcv';

/**
 * The geometry of the Kagi and Point and Figure layers, kept apart from the canvas so it can be
 * tested on plain numbers. The chart hands the layers the view the chart type made: one bar per
 * Kagi line or per Point and Figure column, in the order they were drawn.
 */

/** How one Kagi line is drawn: thick or thin up to a price, and thick or thin beyond it. */
export interface KagiLine {
    /** Thick (a "yang" line) at the start of the line. */
    thickAtStart: boolean;
    /** The price the line changes thickness at, or null when it keeps one thickness throughout. */
    switchAt: number | null;
    /** Thick at the end of the line, after any switch. */
    thickAtEnd: boolean;
}

/**
 * Whether each Kagi line is thick or thin. A line turns thick when it rises above the top of the
 * last rise and thin when it falls below the bottom of the last fall, at that very price, and
 * keeps that thickness until the opposite break. The first line is thin: nothing has been broken.
 * Every line starts where the one before it turned, so the line before it starts at the level
 * to compare with: the top of the last rise, or the bottom of the last fall.
 */
export function kagiLines(bars: readonly OHLCV[]): KagiLine[] {
    const out: KagiLine[] = [];
    let thick = false;
    for (let i = 0; i < bars.length; i++) {
        const bar = bars[i]!;
        const up = bar.close > bar.open;
        const reference = i > 0 ? bars[i - 1]!.open : null;
        const start = thick;
        let switchAt: number | null = null;
        if (reference != null) {
            if (up && bar.close > reference) {
                switchAt = Math.max(reference, bar.open);
                thick = true;
            } else if (!up && bar.close < reference) {
                switchAt = Math.min(reference, bar.open);
                thick = false;
            }
        }
        out.push({ thickAtStart: start, switchAt: switchAt != null && switchAt !== bar.close ? switchAt : null, thickAtEnd: thick });
    }
    return out;
}

/** One Point and Figure column: the prices of its boxes, from the first to the last it was drawn in. */
export interface FigureColumn {
    /** An X column (price rising) or an O column (falling). */
    up: boolean;
    /** The middle price of each box, lowest first. */
    boxes: number[];
}

/**
 * The boxes of a column bar. A bar spans whole boxes from its low to its high, so the count is
 * its height over the box size, and a column that does not divide into the box size is rounded
 * to the boxes it nearly is, never fewer than one.
 */
export function figureColumn(bar: OHLCV, size: number): FigureColumn {
    const count = size > 0 ? Math.max(1, Math.round((bar.high - bar.low) / size)) : 1;
    const boxes: number[] = [];
    for (let i = 0; i < count; i++) boxes.push(bar.low + (i + 0.5) * size);
    return { up: bar.close >= bar.open, boxes };
}

/** The box size to draw with: the one the chart type reported, else the smallest column height seen. */
export function boxSizeOf(data: unknown, bars: readonly OHLCV[]): number {
    const reported = (data as { size?: unknown } | undefined)?.size;
    if (typeof reported === 'number' && reported > 0 && Number.isFinite(reported)) return reported;
    let smallest = Number.POSITIVE_INFINITY;
    for (const bar of bars) {
        const height = bar.high - bar.low;
        if (height > 0 && height < smallest) smallest = height;
    }
    return Number.isFinite(smallest) ? smallest : 1;
}
