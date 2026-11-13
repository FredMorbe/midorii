import { describe, expect, it } from 'vitest';
import type { OHLCV } from '../src/core/model/ohlcv';
import {
    alertableSpecs, crossed, describeAlert, editableInputs, newIndicatorAlert, plotsOf, reading, sideOf, specOf,
    type IndicatorAlert,
} from '../app/renderer/alerts/indicatorAlertModel';

const bars = (closes: number[]): OHLCV[] => closes.map((c, i) => ({ time: i * 60_000, open: c, high: c + 1, low: c - 1, close: c, volume: 100 }));
const rsiSpec = specOf('rsi')!;
const base = (patch: Partial<IndicatorAlert> = {}): IndicatorAlert => ({ ...newIndicatorAlert('binance:BTCUSDT', '60', rsiSpec), ...patch });

describe('the catalog', () => {
    it('knows the RSI and its plot', () => {
        expect(rsiSpec).toBeDefined();
        expect(plotsOf(rsiSpec).map((p) => p.key)).toEqual(['rsi']);
    });
    it('offers only numbers and choices as editable inputs', () => {
        const keys = editableInputs(rsiSpec).map((i) => i.key);
        expect(keys).toContain('length');
        expect(keys).toContain('source');
        expect(keys).not.toContain('color');
    });
    it('lists many indicators, each with a plot', () => {
        const list = alertableSpecs();
        expect(list.length).toBeGreaterThan(10);
        expect(list.every((s) => plotsOf(s).length > 0)).toBe(true);
    });
});

describe('crossed', () => {
    it('detects the three conditions between two sides', () => {
        expect(crossed(-1, 1, 'crosses-above')).toBe(true);
        expect(crossed(-1, 1, 'crosses-below')).toBe(false);
        expect(crossed(1, -1, 'crosses-below')).toBe(true);
        expect(crossed(1, -1, 'crosses')).toBe(true);
        expect(crossed(-1, 1, 'crosses')).toBe(true);
    });
    it('counts landing exactly on the level as crossing it, once', () => {
        expect(crossed(-1, 0, 'crosses-above')).toBe(true);
        expect(crossed(0, 1, 'crosses-above')).toBe(false);
    });
    it('never fires while a side is unknown', () => {
        expect(crossed(null, 1, 'crosses')).toBe(false);
        expect(crossed(-1, null, 'crosses')).toBe(false);
    });
});

describe('reading', () => {
    it('reads the RSI on the newest bar against a level', () => {
        const rising = bars(Array.from({ length: 40 }, (_, i) => 100 + i));
        const r = reading(base({ against: { kind: 'level', value: 70 } }), rising);
        expect(r.value).toBeGreaterThan(90);
        expect(r.against).toBe(70);
        expect(sideOf(r)).toBeGreaterThan(0);
    });
    it('compares a moving average with the newest close for a price alert', () => {
        const sma = specOf('sma')!;
        const alert = { ...newIndicatorAlert('binance:BTCUSDT', '60', sma), inputs: { length: 3 } };
        const series = bars([10, 10, 10, 10, 20]);
        const r = reading(alert, series);
        expect(alert.against).toEqual({ kind: 'price' });
        expect(r.against).toBe(20);
        expect(r.value).toBeCloseTo(40 / 3, 6);
        // The average is below the price: the side is value minus price.
        expect(sideOf(r)).toBeCloseTo(40 / 3 - 20, 6);
    });
    it('has no value while the indicator is still warming up', () => {
        expect(reading(base(), bars([1, 2, 3])).value).toBeNull();
        expect(reading(base(), [])).toEqual({ value: null, against: null });
    });
    it('throws on an unknown indicator or plot', () => {
        expect(() => reading(base({ indicator: 'nope' }), bars([1, 2]))).toThrow(/Unknown indicator/);
        expect(() => reading(base({ plot: 'nope' }), bars([1, 2]))).toThrow(/no plot/);
    });
});

describe('describeAlert', () => {
    it('says what is watched', () => {
        expect(describeAlert(base({ against: { kind: 'level', value: 70 } }))).toBe('RSI (14) crosses above 70');
        const sma = specOf('sma')!;
        expect(describeAlert({ ...newIndicatorAlert('binance:BTCUSDT', '60', sma), inputs: { length: 50 }, condition: 'crosses-below' })).toBe('SMA (50) crosses below the price');
    });
});
