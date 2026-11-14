import type { Brick, BrickMachine } from './driver';

/**
 * The state machines of the price-driven chart types that make ordinary bars. Each is fed
 * prices in order and pushes the bars it finishes. They hold only a handful of numbers, so
 * copying one, which the driver does for every tick of a forming bar, costs nothing.
 */

/** Rounding slack for comparing prices that went through a few additions. */
const EPS = 1e-9;

/**
 * RANGE BARS: every bar spans exactly `size` from its high to its low, however long that takes.
 * A bar ends the moment price has travelled `size` from its far edge; the next opens at the
 * price the last one closed at, so the bars join up.
 */
export class RangeMachine implements BrickMachine {
    private started = false;
    private open = 0;
    private high = 0;
    private low = 0;
    private last = 0;

    constructor(private readonly size: number) {}

    /** The bar still forming, as far as it has got. */
    pending(): Brick | null {
        return this.started ? { open: this.open, high: this.high, low: this.low, close: this.last } : null;
    }

    feed(price: number, out: Brick[]): void {
        this.last = price;
        if (!this.started) {
            this.started = true;
            this.open = this.high = this.low = price;
            return;
        }
        this.high = Math.max(this.high, price);
        this.low = Math.min(this.low, price);
        // A gap can finish several bars at once, each starting where the last ended.
        while (this.high - this.low >= this.size - this.size * EPS) {
            const up = price >= this.high;
            const high = up ? this.low + this.size : this.high;
            const low = up ? this.low : this.high - this.size;
            const close = up ? high : low;
            out.push({ open: this.open, high, low, close });
            this.open = this.high = this.low = close;
            this.high = Math.max(this.high, price);
            this.low = Math.min(this.low, price);
        }
    }

    clone(): RangeMachine {
        const copy = new RangeMachine(this.size);
        Object.assign(copy, this);
        return copy;
    }
}

/**
 * RENKO: a brick of height `size` is added when price has moved a full brick past the last one's
 * far edge, and none while it has not. Bricks continue a trend one after the other, and a
 * reversal needs the price to come back a full brick beyond the start of the last, so noise
 * smaller than that draws nothing. The grid is anchored on a multiple of `size` near the first
 * price, so the same price always meets the same brick edge.
 */
export class RenkoMachine implements BrickMachine {
    private started = false;
    /** The top and bottom of the last brick (both the anchor before there is one). */
    private top = 0;
    private bottom = 0;

    constructor(private readonly size: number) {}

    feed(price: number, out: Brick[]): void {
        if (!this.started) {
            this.started = true;
            this.top = this.bottom = Math.round(price / this.size) * this.size;
            return;
        }
        for (;;) {
            if (price >= this.top + this.size - this.size * EPS) {
                const open = this.top;
                this.top += this.size;
                this.bottom = open;
                out.push({ open, high: this.top, low: open, close: this.top });
            } else if (price <= this.bottom - this.size + this.size * EPS) {
                const open = this.bottom;
                this.bottom -= this.size;
                this.top = open;
                out.push({ open, high: open, low: this.bottom, close: this.bottom });
            } else return;
        }
    }

    clone(): RenkoMachine {
        const copy = new RenkoMachine(this.size);
        Object.assign(copy, this);
        return copy;
    }
}

interface Line {
    open: number;
    close: number;
}

/**
 * LINE BREAK: a line is added only when a close goes beyond the last line, upward past its top
 * or downward past its bottom, and a reversal needs the close to break the extreme of the last
 * `count` lines. Time never makes a line, and a quiet market makes none. Fed closes only.
 */
export class LineBreakMachine implements BrickMachine {
    private previous: number | null = null;
    private lines: Line[] = [];

    constructor(private readonly count: number) {}

    feed(price: number, out: Brick[]): void {
        const last = this.lines[this.lines.length - 1];
        if (!last) {
            if (this.previous == null) {
                this.previous = price;
                return;
            }
            if (price === this.previous) return;
            this.push({ open: this.previous, close: price }, out);
            return;
        }
        const up = last.close > last.open;
        const recent = this.lines.slice(-this.count);
        if (up) {
            if (price > last.close) this.push({ open: last.close, close: price }, out);
            else if (price < Math.min(...recent.map((l) => Math.min(l.open, l.close)))) this.push({ open: last.open, close: price }, out);
        } else if (price < last.close) {
            this.push({ open: last.close, close: price }, out);
        } else if (price > Math.max(...recent.map((l) => Math.max(l.open, l.close)))) {
            this.push({ open: last.open, close: price }, out);
        }
    }

    private push(line: Line, out: Brick[]): void {
        this.lines.push(line);
        if (this.lines.length > this.count) this.lines.shift();
        out.push({ open: line.open, high: Math.max(line.open, line.close), low: Math.min(line.open, line.close), close: line.close });
    }

    clone(): LineBreakMachine {
        const copy = new LineBreakMachine(this.count);
        copy.previous = this.previous;
        copy.lines = this.lines.map((l) => ({ ...l }));
        return copy;
    }
}

/**
 * KAGI: one line that keeps going the way price goes and turns only when price comes back by
 * `reversal` from its extreme. Time never makes a line, and a swing smaller than the reversal
 * draws nothing. Each finished unit is one vertical line from where it started (the turning
 * point of the last one) to where it ended; the line still being drawn is the pending unit.
 * Thick and thin, which tell a break above the last high from a break below the last low, are
 * left to whoever draws the lines, from the order they come in.
 */
export class KagiMachine implements BrickMachine {
    private started = false;
    private direction: 0 | 1 | -1 = 0;
    private anchor = 0;
    private extreme = 0;

    constructor(private readonly reversal: number) {}

    pending(): Brick | null {
        if (this.direction === 0) return null;
        return line(this.anchor, this.extreme);
    }

    feed(price: number, out: Brick[]): void {
        if (!this.started) {
            this.started = true;
            this.anchor = this.extreme = price;
            return;
        }
        if (this.direction === 0) {
            if (Math.abs(price - this.anchor) < this.reversal - this.reversal * EPS) return;
            this.direction = price > this.anchor ? 1 : -1;
            this.extreme = price;
            return;
        }
        const d = this.direction;
        if ((price - this.extreme) * d > 0) {
            this.extreme = price;
        } else if ((this.extreme - price) * d >= this.reversal - this.reversal * EPS) {
            out.push(line(this.anchor, this.extreme));
            this.anchor = this.extreme;
            this.extreme = price;
            this.direction = d === 1 ? -1 : 1;
        }
    }

    clone(): KagiMachine {
        const copy = new KagiMachine(this.reversal);
        Object.assign(copy, this);
        return copy;
    }
}

const line = (open: number, close: number): Brick => ({ open, high: Math.max(open, close), low: Math.min(open, close), close });

/**
 * POINT AND FIGURE: columns of boxes of height `size`, X while price rises and O while it falls.
 * A column grows by a box each time price enters a new box in its direction, and a new column
 * opens in the other direction only when price has come back `reversal` boxes from the column's
 * end, one box inside the old column. Time never makes a column. Each unit is a column from its
 * first box to its last: an up column runs from its low to its high, a down column from its
 * high to its low, so a unit that closes above its open is an X column and below it an O column.
 * The column still growing is the pending unit.
 */
export class PointFigureMachine implements BrickMachine {
    private started = false;
    private direction: 0 | 1 | -1 = 0;
    /** The box the first price fell in, and the lowest and highest box of the current column. */
    private anchor = 0;
    private bottom = 0;
    private top = 0;

    constructor(private readonly size: number, private readonly reversal: number) {}

    private box(price: number): number {
        return Math.floor(price / this.size + EPS);
    }

    pending(): Brick | null {
        return this.direction === 0 ? null : this.column();
    }

    private column(): Brick {
        const low = this.bottom * this.size;
        const high = (this.top + 1) * this.size;
        return this.direction === 1
            ? { open: low, high, low, close: high }
            : { open: high, high, low, close: low };
    }

    feed(price: number, out: Brick[]): void {
        const box = this.box(price);
        if (!this.started) {
            this.started = true;
            this.anchor = this.bottom = this.top = box;
            return;
        }
        if (this.direction === 0) {
            if (box > this.anchor) {
                this.direction = 1;
                this.bottom = this.anchor;
                this.top = box;
            } else if (box < this.anchor) {
                this.direction = -1;
                this.top = this.anchor;
                this.bottom = box;
            }
            return;
        }
        if (this.direction === 1) {
            if (box > this.top) this.top = box;
            else if (box <= this.top - this.reversal) {
                out.push(this.column());
                this.direction = -1;
                this.top = this.top - 1;
                this.bottom = box;
            }
        } else if (box < this.bottom) {
            this.bottom = box;
        } else if (box >= this.bottom + this.reversal) {
            out.push(this.column());
            this.direction = 1;
            this.bottom = this.bottom + 1;
            this.top = box;
        }
    }

    clone(): PointFigureMachine {
        const copy = new PointFigureMachine(this.size, this.reversal);
        Object.assign(copy, this);
        return copy;
    }
}
