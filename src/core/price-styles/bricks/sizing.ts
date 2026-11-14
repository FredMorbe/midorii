import type { OHLCV } from '../../model/ohlcv';

/**
 * The size of a brick or a box: a price distance chosen either as a fixed number or as a
 * multiple of the market's recent average true range, which makes one setting do for a market
 * quoted in thousands and one quoted in fractions.
 */

export interface SizeSettings {
    sizeMode: 'atr' | 'fixed';
    atrLength: number;
    atrFactor: number;
    size: number;
}

const num = (value: unknown, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);

/** The size settings read from a type's values, whatever is missing or out of range falling back to `defaults`. */
export function readSizeSettings(values: Record<string, unknown>, defaults: { atrFactor: number }): SizeSettings {
    const mode = String(values.sizeMode ?? 'ATR').toLowerCase() === 'fixed' ? 'fixed' : 'atr';
    return {
        sizeMode: mode,
        atrLength: Math.max(1, Math.round(num(values.atrLength, 14))),
        atrFactor: Math.max(0.01, num(values.atrFactor, defaults.atrFactor)),
        size: Math.max(0, num(values.size, 0)),
    };
}

/** Wilder's average true range of `bars` over `length`, or the average bar range when there are too few bars for it. */
export function averageTrueRange(bars: readonly OHLCV[], length: number): number {
    if (bars.length === 0) return 0;
    const ranges: number[] = [];
    for (let i = 0; i < bars.length; i++) {
        const bar = bars[i]!;
        const previous = i > 0 ? bars[i - 1]!.close : bar.close;
        ranges.push(Math.max(bar.high - bar.low, Math.abs(bar.high - previous), Math.abs(bar.low - previous)));
    }
    if (ranges.length <= length) return ranges.reduce((a, b) => a + b, 0) / ranges.length;
    let atr = ranges.slice(0, length).reduce((a, b) => a + b, 0) / length;
    for (let i = length; i < ranges.length; i++) atr = (atr * (length - 1) + ranges[i]!) / length;
    return atr;
}

/**
 * The size to build the chart with. A fixed size is used as given; otherwise the average true
 * range at the end of `bars` times the factor. When neither gives a usable number, a tenth of a
 * percent of the last price, so a chart is never left empty by a setting nobody has chosen yet.
 */
export function resolveSize(settings: SizeSettings, bars: readonly OHLCV[]): number {
    if (settings.sizeMode === 'fixed' && settings.size > 0) return settings.size;
    const atr = averageTrueRange(bars, settings.atrLength) * settings.atrFactor;
    if (atr > 0 && Number.isFinite(atr)) return atr;
    const last = bars[bars.length - 1]?.close;
    return last != null && last > 0 ? last * 0.001 : 1;
}
