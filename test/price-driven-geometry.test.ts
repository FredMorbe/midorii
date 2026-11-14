import { describe, expect, it } from 'vitest';
import type { OHLCV } from '../src/core/model/ohlcv';
import { boxSizeOf, figureColumn, kagiLines } from '../src/renderers/native/priceDrivenGeometry';

const line = (i: number, open: number, close: number): OHLCV => ({ time: i, open, close, high: Math.max(open, close), low: Math.min(open, close) });

describe('kagiLines', () => {
    it('keeps the first line thin and a line that stays inside the last swing as it was', () => {
        const lines = kagiLines([line(0, 100, 110), line(1, 110, 104), line(2, 104, 108)]);
        expect(lines[0]).toEqual({ thickAtStart: false, switchAt: null, thickAtEnd: false });
        expect(lines[1]).toEqual({ thickAtStart: false, switchAt: null, thickAtEnd: false }); // 104 is above the last waist (100)
        expect(lines[2]).toEqual({ thickAtStart: false, switchAt: null, thickAtEnd: false }); // 108 is below the last shoulder (110)
    });

    it('turns thick at the price a rise passes the last shoulder, and stays thick', () => {
        const lines = kagiLines([line(0, 100, 110), line(1, 110, 104), line(2, 104, 115), line(3, 115, 109)]);
        expect(lines[2]).toEqual({ thickAtStart: false, switchAt: 110, thickAtEnd: true });
        expect(lines[3]).toEqual({ thickAtStart: true, switchAt: null, thickAtEnd: true }); // 109 has not broken the last waist
    });

    it('turns thin at the price a fall passes the last waist', () => {
        const lines = kagiLines([line(0, 100, 110), line(1, 110, 104), line(2, 104, 115), line(3, 115, 98)]);
        expect(lines[3]).toEqual({ thickAtStart: true, switchAt: 104, thickAtEnd: false });
    });

    it('puts the switch at the shoulder when a line starts below it and rises through it', () => {
        const lines = kagiLines([line(0, 100, 110), line(1, 110, 90), line(2, 90, 120)]);
        expect(lines[2]?.thickAtEnd).toBe(true);
        expect(lines[2]?.switchAt).toBe(110);
    });

    it('answers nothing for no lines', () => {
        expect(kagiLines([])).toEqual([]);
    });
});

describe('figureColumn', () => {
    it('lists the middle of each box from the lowest up, and tells X from O by the direction', () => {
        expect(figureColumn({ time: 0, open: 100, high: 104, low: 100, close: 104 }, 1)).toEqual({ up: true, boxes: [100.5, 101.5, 102.5, 103.5] });
        expect(figureColumn({ time: 0, open: 104, high: 104, low: 102, close: 102 }, 1)).toEqual({ up: false, boxes: [102.5, 103.5] });
    });
    it('rounds to the nearest whole box and never draws fewer than one', () => {
        expect(figureColumn({ time: 0, open: 100, high: 102.9, low: 100, close: 102.9 }, 1).boxes).toHaveLength(3);
        expect(figureColumn({ time: 0, open: 100, high: 100.1, low: 100, close: 100.1 }, 1).boxes).toHaveLength(1);
        expect(figureColumn({ time: 0, open: 100, high: 100, low: 100, close: 100 }, 0).boxes).toHaveLength(1);
    });
});

describe('boxSizeOf', () => {
    const bars = [line(0, 100, 104), line(1, 104, 102)];
    it('uses the size the chart type reported', () => {
        expect(boxSizeOf({ size: 2.5 }, bars)).toBe(2.5);
    });
    it('falls back to the smallest column height, and to 1 with nothing to go on', () => {
        expect(boxSizeOf(undefined, bars)).toBe(2);
        expect(boxSizeOf({ size: 0 }, bars)).toBe(2);
        expect(boxSizeOf({ size: 'big' }, bars)).toBe(2);
        expect(boxSizeOf(undefined, [])).toBe(1);
    });
});
