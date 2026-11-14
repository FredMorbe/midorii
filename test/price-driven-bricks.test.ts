import { describe, expect, it } from 'vitest';
import type { OHLCV } from '../src/core/model/ohlcv';
import { brickTransform, pathOf, type Brick, type BrickMachine } from '../src/core/price-styles/bricks/driver';
import { KagiMachine, LineBreakMachine, PointFigureMachine, RangeMachine, RenkoMachine } from '../src/core/price-styles/bricks/machines';
import { averageTrueRange, readSizeSettings, resolveSize } from '../src/core/price-styles/bricks/sizing';
import { kagiFactory, lineBreakFactory, pointFigureFactory, rangeBarsFactory, renkoFactory } from '../src/chart-types/priceDriven';

const MIN = 60_000;
const T0 = 1_700_000_000_000;

const bar = (i: number, open: number, high: number, low: number, close: number, volume?: number): OHLCV => ({
    time: T0 + i * MIN, open, high, low, close, ...(volume != null ? { volume } : {}),
});

function run(machine: BrickMachine, prices: number[]): Brick[] {
    const out: Brick[] = [];
    for (const p of prices) machine.feed(p, out);
    return out;
}

describe('pathOf', () => {
    it('runs an up bar through its low first and a down bar through its high first', () => {
        expect(pathOf(bar(0, 10, 14, 8, 12))).toEqual([10, 8, 14, 12]);
        expect(pathOf(bar(0, 10, 14, 8, 9))).toEqual([10, 14, 8, 9]);
    });
    it('drops a price that repeats the one before it, and anything that is not a number', () => {
        expect(pathOf(bar(0, 10, 10, 10, 10))).toEqual([10]);
        expect(pathOf(bar(0, 10, 12, 10, 12))).toEqual([10, 12]);
        expect(pathOf(bar(0, Number.NaN, 12, 8, 11))).toEqual([12, 8, 11]); // no usable open: read as a down bar
    });
});

describe('range machine', () => {
    it('makes bars that span exactly the size, joined end to end', () => {
        const bricks = run(new RangeMachine(2), [100, 101, 102.5, 101, 100.2, 98.4, 97, 99, 101.5]);
        expect(bricks.length).toBeGreaterThan(2);
        for (const b of bricks) expect(b.high - b.low).toBeCloseTo(2, 9);
        for (let i = 1; i < bricks.length; i++) expect(bricks[i]!.open).toBeCloseTo(bricks[i - 1]!.close, 9);
    });
    it('closes an up bar at its high and a down bar at its low', () => {
        const [up] = run(new RangeMachine(2), [100, 103]);
        expect(up).toEqual({ open: 100, high: 102, low: 100, close: 102 });
        const [down] = run(new RangeMachine(2), [100, 97]);
        expect(down).toEqual({ open: 100, high: 100, low: 98, close: 98 });
    });
    it('makes several bars out of a gap', () => {
        const bricks = run(new RangeMachine(1), [100, 104.5]);
        expect(bricks.map((b) => b.close)).toEqual([101, 102, 103, 104]);
    });
    it('makes nothing while price stays inside the size', () => {
        expect(run(new RangeMachine(5), [100, 102, 99, 103, 101])).toEqual([]);
    });
    it('can be copied without sharing state', () => {
        const a = new RangeMachine(2);
        run(a, [100, 101]);
        const b = a.clone();
        const out: Brick[] = [];
        b.feed(105, out);
        expect(out.length).toBeGreaterThan(0);
        const again: Brick[] = [];
        a.feed(101.5, again);
        expect(again).toEqual([]);
    });
});

describe('renko machine', () => {
    it('anchors on a multiple of the size and adds a brick per full size moved', () => {
        const bricks = run(new RenkoMachine(2), [100.4, 101.9, 102.1, 104.2, 106.5]);
        expect(bricks).toEqual([
            { open: 100, high: 102, low: 100, close: 102 },
            { open: 102, high: 104, low: 102, close: 104 },
            { open: 104, high: 106, low: 104, close: 106 },
        ]);
    });
    it('needs a full brick beyond the start of the last one to reverse', () => {
        const m = new RenkoMachine(2);
        const up = run(m, [100, 102.5]); // one up brick 100 → 102
        expect(up).toHaveLength(1);
        expect(run(m, [101.5])).toEqual([]); // back inside the last brick
        expect(run(m, [99.5])).toEqual([]); // below its start, but not a full brick
        expect(run(m, [98])).toEqual([{ open: 100, high: 100, low: 98, close: 98 }]);
    });
    it('makes none for noise smaller than a brick', () => {
        expect(run(new RenkoMachine(5), [100, 101, 99.5, 102, 98, 101])).toEqual([]);
    });
    it('makes several bricks from one move and keeps them touching', () => {
        const bricks = run(new RenkoMachine(1), [100, 103.2]);
        expect(bricks.map((b) => [b.open, b.close])).toEqual([[100, 101], [101, 102], [102, 103]]);
    });
    it('gives the same brick edges for the same prices whatever the path to them', () => {
        const a = run(new RenkoMachine(2), [100, 106]);
        const b = run(new RenkoMachine(2), [100, 103, 101, 106]);
        expect(b.map((x) => x.close)).toEqual(a.map((x) => x.close));
    });
});

describe('line break machine', () => {
    it('adds a line when a close goes beyond the last one, in its own direction', () => {
        const bricks = run(new LineBreakMachine(3), [100, 102, 104, 103, 107]);
        expect(bricks.map((b) => [b.open, b.close])).toEqual([[100, 102], [102, 104], [104, 107]]);
    });
    it('reverses only when a close breaks the extreme of the last lines', () => {
        const m = new LineBreakMachine(3);
        run(m, [100, 102, 104, 106]); // three up lines, lowest point 100
        expect(run(m, [101])).toEqual([]); // below the last line but not below the lowest of three
        const reversal = run(m, [99]);
        expect(reversal).toEqual([{ open: 104, high: 104, low: 99, close: 99 }]);
    });
    it('makes nothing for an unchanged close', () => {
        expect(run(new LineBreakMachine(3), [100, 100, 100])).toEqual([]);
    });
    it('can be copied without sharing state', () => {
        const a = new LineBreakMachine(3);
        run(a, [100, 102]);
        const b = a.clone();
        run(b, [105, 108]);
        expect(run(a, [103]).map((x) => x.close)).toEqual([103]);
    });
});

describe('kagi machine', () => {
    it('turns only when price comes back by the reversal from its extreme', () => {
        const m = new KagiMachine(3);
        const out: Brick[] = [];
        for (const p of [100, 105, 103, 101]) m.feed(p, out);
        expect(out).toEqual([{ open: 100, high: 105, low: 100, close: 105 }]);
        expect(m.pending()).toEqual({ open: 105, high: 105, low: 101, close: 101 });
    });
    it('keeps extending the line while price keeps going its way, and shows it as the pending line', () => {
        const m = new KagiMachine(3);
        const out: Brick[] = [];
        for (const p of [100, 104, 108, 112]) m.feed(p, out);
        expect(out).toEqual([]);
        expect(m.pending()).toEqual({ open: 100, high: 112, low: 100, close: 112 });
    });
    it('draws nothing for a swing smaller than the reversal, before and after the first line', () => {
        const m = new KagiMachine(5);
        const out: Brick[] = [];
        for (const p of [100, 103, 98, 102, 99]) m.feed(p, out);
        expect(out).toEqual([]);
        expect(m.pending()).toBeNull();
        for (const p of [106, 103, 105]) m.feed(p, out);
        expect(out).toEqual([]);
    });
    it('starts the next line where the last one turned', () => {
        const m = new KagiMachine(2);
        const out: Brick[] = [];
        for (const p of [100, 105, 102.5, 99, 104]) m.feed(p, out);
        expect(out.map((b) => [b.open, b.close])).toEqual([[100, 105], [105, 99]]);
        expect(m.pending()).toEqual({ open: 99, high: 104, low: 99, close: 104 });
    });
    it('can be copied without sharing state', () => {
        const a = new KagiMachine(2);
        const out: Brick[] = [];
        for (const p of [100, 105]) a.feed(p, out);
        const b = a.clone();
        b.feed(101, []);
        expect(a.pending()).toEqual({ open: 100, high: 105, low: 100, close: 105 });
        expect(b.pending()).toEqual({ open: 105, high: 105, low: 101, close: 101 });
    });
});

describe('point and figure machine', () => {
    it('grows an X column a box at a time and shows it as the pending column', () => {
        const m = new PointFigureMachine(1, 3);
        const out: Brick[] = [];
        for (const p of [100.5, 103.2, 104.1]) m.feed(p, out);
        expect(out).toEqual([]);
        expect(m.pending()).toEqual({ open: 100, high: 105, low: 100, close: 105 });
    });
    it('turns to an O column only when price is the reversal count of boxes back, one box inside the old column', () => {
        const m = new PointFigureMachine(1, 3);
        const out: Brick[] = [];
        for (const p of [100.5, 103.2, 104.1, 102.5]) m.feed(p, out);
        expect(out).toEqual([]); // 102 is two boxes below the top: not enough
        m.feed(101.2, out);
        expect(out).toEqual([{ open: 100, high: 105, low: 100, close: 105 }]);
        expect(m.pending()).toEqual({ open: 104, high: 104, low: 101, close: 101 });
    });
    it('turns an O column back up the same way, one box above its last', () => {
        const m = new PointFigureMachine(1, 3);
        const out: Brick[] = [];
        for (const p of [110.5, 107.2, 106.1, 108.2]) m.feed(p, out);
        expect(out).toEqual([]);
        m.feed(109.4, out);
        expect(out).toEqual([{ open: 111, high: 111, low: 106, close: 106 }]);
        expect(m.pending()).toEqual({ open: 107, high: 110, low: 107, close: 110 });
    });
    it('draws nothing until price has left its first box', () => {
        const m = new PointFigureMachine(2, 3);
        const out: Brick[] = [];
        for (const p of [100.2, 100.9, 101.9, 100.1]) m.feed(p, out);
        expect(out).toEqual([]);
        expect(m.pending()).toBeNull();
    });
    it('puts a price on a box edge in the box above it', () => {
        const m = new PointFigureMachine(1, 3);
        m.feed(100, []);
        m.feed(102, []);
        expect(m.pending()).toEqual({ open: 100, high: 103, low: 100, close: 103 });
    });
    it('can be copied without sharing state', () => {
        const a = new PointFigureMachine(1, 3);
        const out: Brick[] = [];
        for (const p of [100.5, 103.2]) a.feed(p, out);
        const b = a.clone();
        b.feed(100.1, out);
        expect(out).toHaveLength(1);
        expect(a.pending()).toEqual({ open: 100, high: 104, low: 100, close: 104 });
    });
});

describe('range machine, forming bar', () => {
    it('shows the bar still forming as far as it has got', () => {
        const m = new RangeMachine(5);
        run(m, [100, 102, 99]);
        expect(m.pending()).toEqual({ open: 100, high: 102, low: 99, close: 99 });
        expect(new RangeMachine(5).pending()).toBeNull();
    });
});

describe('sizing', () => {
    const bars = Array.from({ length: 30 }, (_, i) => bar(i, 100, 103, 97, 100)); // a steady range of 6

    it('averages the true range, and falls back to the plain average when there are too few bars', () => {
        expect(averageTrueRange(bars, 14)).toBeCloseTo(6, 9);
        expect(averageTrueRange(bars.slice(0, 5), 14)).toBeCloseTo(6, 9);
        expect(averageTrueRange([], 14)).toBe(0);
    });
    it('counts a gap into the true range', () => {
        const gapped = [bar(0, 100, 101, 99, 100), bar(1, 110, 111, 109, 110)];
        expect(averageTrueRange(gapped, 14)).toBeCloseTo((2 + 11) / 2, 9);
    });
    it('uses a fixed size as given, and the ATR multiple otherwise', () => {
        expect(resolveSize(readSizeSettings({ sizeMode: 'Fixed', size: 2.5 }, { atrFactor: 1 }), bars)).toBe(2.5);
        expect(resolveSize(readSizeSettings({ sizeMode: 'ATR', atrFactor: 0.5 }, { atrFactor: 1 }), bars)).toBeCloseTo(3, 9);
        expect(resolveSize(readSizeSettings({}, { atrFactor: 2 }), bars)).toBeCloseTo(12, 9);
    });
    it('falls back to a tenth of a percent of the price when a fixed size was never chosen, and to 1 with no bars', () => {
        expect(resolveSize(readSizeSettings({ sizeMode: 'Fixed', size: 0 }, { atrFactor: 1 }), [bar(0, 100, 100, 100, 100)])).toBeCloseTo(0.1, 9);
        expect(resolveSize(readSizeSettings({ sizeMode: 'Fixed' }, { atrFactor: 1 }), [])).toBe(1);
    });
    it('keeps what it reads in range', () => {
        expect(readSizeSettings({ atrLength: -3, atrFactor: 0, size: -4 }, { atrFactor: 1 })).toMatchObject({ atrLength: 1, atrFactor: 0.01, size: 0 });
    });
});

/** A reproducible random walk of raw bars, each with a real open, high, low and close. */
function walk(n: number, seed = 7): OHLCV[] {
    let s = seed;
    const rand = (): number => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
    const out: OHLCV[] = [];
    let price = 100;
    for (let i = 0; i < n; i++) {
        const open = price;
        const close = open + (rand() - 0.5) * 4;
        const high = Math.max(open, close) + rand() * 1.5;
        const low = Math.min(open, close) - rand() * 1.5;
        out.push(bar(i, open, high, low, close, 10 + Math.floor(rand() * 5)));
        price = close;
    }
    return out;
}

describe('brickTransform', () => {
    const spec = { make: () => new RenkoMachine(1) };

    it('spaces several bricks from one bar a millisecond apart and shares its volume', () => {
        const view = brickTransform(spec).full([bar(0, 100, 104.5, 100, 104.2, 12), bar(1, 104.2, 104.3, 104.1, 104.2, 1)]);
        const fromFirst = view.filter((b) => b.time < T0 + MIN);
        expect(fromFirst.map((b) => b.time)).toEqual([T0, T0 + 1, T0 + 2, T0 + 3].slice(0, fromFirst.length));
        expect(fromFirst.length).toBeGreaterThanOrEqual(3);
        for (const b of fromFirst) expect(b.volume).toBeCloseTo(12 / fromFirst.length, 9);
    });

    it('keeps the view strictly ascending in time even when a bar makes more bricks than a minute has milliseconds to spare', () => {
        const view = brickTransform({ make: () => new RenkoMachine(0.001) }).full([bar(0, 100, 105, 100, 105), bar(1, 105, 105.01, 105, 105)]);
        for (let i = 1; i < view.length; i++) expect(view[i]!.time).toBeGreaterThan(view[i - 1]!.time);
    });

    it('treats the last raw bar as forming: its bricks are in the view but not yet in the machine', () => {
        const t = brickTransform(spec);
        const raw = [bar(0, 100, 100.4, 99.8, 100.2), bar(1, 100.2, 103.4, 100, 103.2)];
        const withForming = t.full(raw);
        expect(withForming.length).toBeGreaterThan(0);
        // the same forming bar revised to a smaller move takes bricks back
        const revised = t.update([raw[0]!, bar(1, 100.2, 101.4, 100, 101.2)], withForming);
        expect(revised.from + revised.bars.length).toBeLessThan(withForming.length + 1);
        expect(revised.from).toBeLessThan(withForming.length);
    });

    it('says nothing changed for a tick that finishes no brick', () => {
        const t = brickTransform(spec);
        const raw = [bar(0, 100, 100.2, 99.9, 100.1)];
        const view = t.full(raw);
        const delta = t.update([bar(0, 100, 100.3, 99.9, 100.2)], view);
        expect(delta).toEqual({ from: view.length, bars: [] });
    });

    it("puts the machine's pending unit last in the view, after the finished ones, and not into the machine", () => {
        const t = brickTransform({ make: () => new KagiMachine(2) });
        const raw = [bar(0, 100, 106, 100, 105), bar(1, 105, 105, 102.5, 103)];
        const view = t.full(raw);
        expect(view.map((b) => [b.open, b.close])).toEqual([[100, 106], [106, 102.5]]);
        expect(t.update(raw, view)).toEqual({ from: view.length, bars: [] });
    });

    it.each([
        ['renko', () => renkoFactory({ sizeMode: 'Fixed', size: 1.5 })],
        ['range bars', () => rangeBarsFactory({ sizeMode: 'Fixed', size: 2 })],
        ['line break', () => lineBreakFactory({ lines: 3 })],
        ['kagi', () => kagiFactory({ sizeMode: 'Fixed', size: 2 })],
        ['point and figure', () => pointFigureFactory({ sizeMode: 'Fixed', size: 1, reversal: 3 })],
    ])('%s: live updates always add up to what deriving the whole series gives', (_name, make) => {
        const all = walk(120);
        const live = make();
        // start with a history, then play the rest one raw bar at a time, revising each forming bar on the way
        const start = 40;
        let raw = all.slice(0, start);
        let view = live.full(raw);
        for (let i = start; i < all.length; i++) {
            const final = all[i]!;
            const steps = [
                { ...final, high: Math.max(final.open, (final.open + final.close) / 2), low: Math.min(final.open, (final.open + final.close) / 2), close: (final.open + final.close) / 2 },
                final,
            ];
            for (const step of steps) {
                raw = i === raw.length ? [...raw, step] : [...raw.slice(0, -1), step];
                const delta = live.update(raw, view);
                expect(delta.from).toBeLessThanOrEqual(view.length);
                view = [...view.slice(0, delta.from), ...delta.bars];
                expect(view).toEqual(make().full(raw));
            }
        }
        for (let i = 1; i < view.length; i++) expect(view[i]!.time).toBeGreaterThan(view[i - 1]!.time);
    });

    it('starts over when the raw series is replaced by a shorter one', () => {
        const t = renkoFactory({ sizeMode: 'Fixed', size: 1 });
        const long = walk(80);
        const view = t.full(long);
        const short = walk(10, 99);
        const delta = t.update(short, view);
        expect([...view.slice(0, delta.from), ...delta.bars]).toEqual(renkoFactory({ sizeMode: 'Fixed', size: 1 }).full(short));
    });
});

describe('the chart type factories', () => {
    const raw = walk(200);

    it('size by ATR until a fixed size is chosen', () => {
        const byAtr = renkoFactory({ sizeMode: 'ATR', atrFactor: 1 }).full(raw);
        const fixed = renkoFactory({ sizeMode: 'Fixed', size: 0.2 }).full(raw);
        expect(fixed.length).toBeGreaterThan(byAtr.length);
        expect(byAtr.length).toBeGreaterThan(0);
        expect(Math.abs(byAtr[0]!.close - byAtr[0]!.open)).toBeCloseTo(resolveSize(readSizeSettings({}, { atrFactor: 1 }), raw), 9);
    });

    it('keep the size they were derived with while ticks arrive, and take a new one on the next full derivation', () => {
        const t = renkoFactory({ sizeMode: 'ATR', atrFactor: 1 });
        const first = t.full(raw.slice(0, 100));
        const grown = [...raw.slice(0, 100), raw[100]!];
        const delta = t.update(grown, first);
        const size = Math.abs(first[0]!.close - first[0]!.open);
        for (const b of delta.bars) expect(Math.abs(b.close - b.open)).toBeCloseTo(size, 9);
    });

    it('make line break lines from closes alone and clamp the line count', () => {
        const three = lineBreakFactory({ lines: 3 }).full(raw);
        const huge = lineBreakFactory({ lines: 999 }).full(raw);
        const nonsense = lineBreakFactory({ lines: 'many' }).full(raw);
        expect(three.length).toBeGreaterThan(0);
        expect(huge.length).toBeGreaterThan(0);
        expect(nonsense).toEqual(three);
    });
});
