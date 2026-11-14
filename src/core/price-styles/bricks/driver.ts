import type { OHLCV } from '../../model/ohlcv';
import type { SeriesTransform, ViewDelta } from '../SeriesTransform';

/**
 * The shared engine behind the price-driven chart types (Renko, range bars, line break, Kagi,
 * Point and Figure): charts whose bars are made by price moving, not by time passing.
 *
 * Each type is a small state machine that is fed prices one after another and says which bars
 * it has finished. This driver feeds it the raw bars, spaces the finished bars out in time, and
 * keeps the one thing that makes live use correct: the raw bar that is still forming is run
 * through a COPY of the machine, so whatever it produces can change with the next tick without
 * the machine ever having seen a price it must take back.
 */

/** One finished bar of a price-driven chart. */
export interface Brick {
    open: number;
    high: number;
    low: number;
    close: number;
}

export interface BrickMachine {
    /** Take the next price of the path and push every bar it finishes into `out`. */
    feed(price: number, out: Brick[]): void;
    /** An independent copy: feeding it leaves this machine as it was. */
    clone(): BrickMachine;
    /**
     * The unit that is still being drawn, for the types whose newest unit is the one that matters
     * (a Kagi line, a Point and Figure column): it goes in the view after the finished ones, and
     * changes as prices arrive. Absent for the types that show only what is finished.
     */
    pending?(): Brick | null;
}

export interface BrickMachineSpec {
    make(): BrickMachine;
    /** Feed only each raw bar's close instead of the path its open, high and low imply. */
    closesOnly?: boolean;
}

/**
 * The prices a raw bar passed through, in order. Only the four numbers are known, not the order
 * they happened in, so an up bar is taken to have dipped to its low before rising to its high
 * and a down bar the other way round: the usual reading, and the one that keeps a bar's own
 * range from being counted twice.
 */
export function pathOf(bar: OHLCV): number[] {
    const path = bar.close >= bar.open
        ? [bar.open, bar.low, bar.high, bar.close]
        : [bar.open, bar.high, bar.low, bar.close];
    return path.filter((price, i) => Number.isFinite(price) && (i === 0 || price !== path[i - 1]));
}

const sameBar = (a: OHLCV | undefined, b: OHLCV | undefined): boolean =>
    a !== undefined && b !== undefined
    && a.time === b.time && a.open === b.open && a.high === b.high && a.low === b.low && a.close === b.close && a.volume === b.volume;

/**
 * Turn the bricks one raw bar finished into view bars. They take the raw bar's own time, and a
 * millisecond more for each one after the first, never at or before the bar before them, so the
 * view stays strictly ascending in time however many bricks a single bar makes. The bar's volume
 * is shared out evenly among them. Returns the time of the last one.
 */
function place(bricks: readonly Brick[], bar: OHLCV, previousTime: number, out: OHLCV[]): number {
    let time = previousTime;
    const share = bar.volume != null && bricks.length > 0 ? bar.volume / bricks.length : undefined;
    bricks.forEach((brick, k) => {
        time = Math.max(bar.time + k, time + 1);
        out.push({ time, ...brick, ...(share != null ? { volume: share } : {}) });
    });
    return time;
}

export function brickTransform(spec: BrickMachineSpec): SeriesTransform {
    let machine = spec.make();
    /** How many raw bars the machine has been fed: every one but the forming last. */
    let consumed = 0;
    let settled: OHLCV[] = [];
    let settledTime = Number.NEGATIVE_INFINITY;

    const bricksOf = (m: BrickMachine, bar: OHLCV): Brick[] => {
        const out: Brick[] = [];
        for (const price of spec.closesOnly ? [bar.close] : pathOf(bar)) if (Number.isFinite(price)) m.feed(price, out);
        return out;
    };

    const reset = (): void => {
        machine = spec.make();
        consumed = 0;
        settled = [];
        settledTime = Number.NEGATIVE_INFINITY;
    };

    /** Feed the machine every raw bar that is no longer forming. */
    const settle = (raw: readonly OHLCV[]): void => {
        while (consumed < raw.length - 1) {
            const bar = raw[consumed]!;
            settledTime = place(bricksOf(machine, bar), bar, settledTime, settled);
            consumed++;
        }
    };

    /** What the forming raw bar makes if it ends as it stands now, from a copy of the machine. */
    const tentative = (raw: readonly OHLCV[]): OHLCV[] => {
        const out: OHLCV[] = [];
        const forming = raw[raw.length - 1];
        if (forming) {
            const copy = machine.clone();
            const bricks = bricksOf(copy, forming);
            const open = copy.pending?.();
            if (open) bricks.push(open);
            place(bricks, forming, settledTime, out);
        }
        return out;
    };

    return {
        full(raw) {
            reset();
            settle(raw);
            return settled.concat(tentative(raw));
        },

        update(raw, view): ViewDelta {
            if (raw.length - 1 < consumed) {
                // The raw series got shorter than what was consumed: it was replaced, not extended.
                reset();
            }
            const settledBefore = settled.length;
            settle(raw);
            const tail = tentative(raw);
            const total = settled.length + tail.length;
            const at = (i: number): OHLCV | undefined => (i < settled.length ? settled[i] : tail[i - settled.length]);

            // What the view held below what was settled before this update has not changed.
            let first = Math.min(settledBefore, view.length);
            while (first < total && first < view.length && sameBar(at(first), view[first])) first++;
            if (first === total && first === view.length) return { from: view.length, bars: [] };

            const bars: OHLCV[] = [];
            for (let i = first; i < total; i++) bars.push(at(i)!);
            return { from: first, bars };
        },
    };
}
