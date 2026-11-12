import type { BacktestBar, BacktestResult } from '../../../shared/engine/backtest';
import type { SweepStats } from '../../../shared/analysis/sweep';

/** Only the figures worth keeping for every combination — there can be thousands. */
export function summarizeBacktest(result: BacktestResult): SweepStats {
    const s = result.stats;
    return {
        tradeCount: s.tradeCount,
        netPnl: s.netPnl,
        returnPct: s.returnPct,
        winRate: s.winRate,
        maxDrawdownPct: s.maxDrawdownPct,
        profitFactor: s.profitFactor,
        expectancy: s.expectancy,
        feesPaid: s.feesPaid,
    };
}

/**
 * The bars inside a half-open range.
 *
 * Half-open on purpose: the training stretch ends where the test stretch begins, and a bar
 * counted in both would let a combination be chosen partly on a bar it is then checked
 * against.
 */
export function sliceBars(bars: readonly BacktestBar[], from: number, to: number): BacktestBar[] {
    const out: BacktestBar[] = [];
    for (const bar of bars) {
        if (bar.time < from) continue;
        if (bar.time >= to) break;
        out.push(bar);
    }
    return out;
}

/**
 * Moves a split's boundary onto the start of an actual bar.
 *
 * `splitRange` cuts by a fraction of the clock, which almost never lands on a bar's own
 * start — bars have gaps (a session close, a halt), so the arithmetic cut can fall inside
 * one. Slicing there is fine for the bar itself, which simply goes whole to whichever side
 * it belongs on; it is NOT fine for what is underneath it. `makeSubBarLookup` in the engine
 * hands a bar every one of its own minutes, keyed by that bar's own start — so a cut inside
 * the bar would still give the WHOLE bar, minutes included, to one side, while `sliceBars`
 * on the base-bar array (keyed by minute, not by parent bar) would divide those same
 * minutes between train and test by raw timestamp. A fill that happened in the half of the
 * bar assigned to the other side would then be invisible to intrabar resolution, silently,
 * on every sweep that does not happen to land its split exactly on a bar.
 *
 * Rounding forward — to the next bar at or after the arithmetic cut — keeps the split
 * half-open exactly like `sliceBars` already reads it: the bar found becomes the first bar
 * of test, never a bar shared between the two.
 */
export function alignSplitToBars(
    split: { train: { from: number; to: number }; test: { from: number; to: number } },
    bars: readonly BacktestBar[],
): { train: { from: number; to: number }; test: { from: number; to: number } } {
    const cut = bars.find((b) => b.time >= split.train.to)?.time ?? bars[bars.length - 1]!.time;
    return { train: { from: split.train.from, to: cut }, test: { from: cut, to: split.test.to } };
}

