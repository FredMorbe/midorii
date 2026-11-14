import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AlertListStore } from '../app/renderer/alerts/AlertListStore';
import { PercentAlertEngine } from '../app/renderer/alerts/PercentAlertEngine';
import { TimeAlertEngine } from '../app/renderer/alerts/TimeAlertEngine';
import {
    describePercent, moveReached, movePercent, newPercentAlert, sanitizePercentAlerts, type PercentAlert,
} from '../app/renderer/alerts/percentAlertModel';
import {
    MAX_AHEAD_MS, newTimeAlert, parseWhen, sanitizeTimeAlerts, untilText, type TimeAlert,
} from '../app/renderer/alerts/timeAlertModel';
import type { DataProvider } from '../src/plugin';
import type { OHLCV } from '../src/core/model/ohlcv';

function memoryStorage() {
    const data = new Map<string, string>();
    return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
}

const percentStore = () => new AlertListStore<PercentAlert>('p', sanitizePercentAlerts, memoryStorage());
const timeStore = () => new AlertListStore<TimeAlert>('t', sanitizeTimeAlerts, memoryStorage());
const percentAlert = (patch: Partial<PercentAlert> = {}): PercentAlert => ({ ...newPercentAlert('binance:BTCUSDT'), ...patch });

describe('percent alert model', () => {
    it('measures a signed move from the reference', () => {
        expect(movePercent(100, 102)).toBeCloseTo(2);
        expect(movePercent(100, 97)).toBeCloseTo(-3);
    });
    it('reaches a move exactly at the share, in the direction it names', () => {
        const up = percentAlert({ reference: 100, percent: 2, direction: 'up' });
        expect(moveReached(up, 102)).toBe(true);
        expect(moveReached(up, 101.99)).toBe(false);
        expect(moveReached(up, 90)).toBe(false);
        const down = percentAlert({ reference: 100, percent: 2, direction: 'down' });
        expect(moveReached(down, 98)).toBe(true);
        expect(moveReached(down, 110)).toBe(false);
        const either = percentAlert({ reference: 100, percent: 2, direction: 'either' });
        expect(moveReached(either, 98)).toBe(true);
        expect(moveReached(either, 102)).toBe(true);
        expect(moveReached(either, 100.5)).toBe(false);
    });
    it('never reaches a move without a reference or with a broken price', () => {
        expect(moveReached(percentAlert({ reference: null }), 1000)).toBe(false);
        expect(moveReached(percentAlert({ reference: 100 }), Number.NaN)).toBe(false);
    });
    it('describes itself with or without a reference', () => {
        expect(describePercent(percentAlert({ percent: 2, direction: 'up', reference: 67200.01 }))).toBe('Rises 2% from 67200.01');
        expect(describePercent(percentAlert({ percent: 1.5, direction: 'either', reference: null }))).toBe('Moves 1.5% either way from the next price');
        expect(describePercent(percentAlert({ percent: 3, direction: 'down', reference: 50 }))).toBe('Falls 3% from 50');
    });
    it('drops damaged stored alerts and repairs nothing', () => {
        const good = percentAlert({ id: 'a', reference: 5 });
        const out = sanitizePercentAlerts([good, good, { ...good, id: 'b', percent: 0 }, { ...good, id: 'c', direction: 'sideways' }, { ...good, id: 'd', reference: -1 }, null]);
        expect(out.map((a) => a.id)).toEqual(['a', 'd']);
        expect(out[1]!.reference).toBeNull();
    });
});

describe('parseWhen', () => {
    const now = new Date(2026, 10, 14, 10, 0, 0).getTime();
    it('reads a span from now', () => {
        expect(parseWhen('15m', now)).toEqual({ at: now + 15 * 60_000 });
        expect(parseWhen('2h', now)).toEqual({ at: now + 2 * 3_600_000 });
        expect(parseWhen('1h30m', now)).toEqual({ at: now + 90 * 60_000 });
        expect(parseWhen(' 2D ', now)).toEqual({ at: now + 2 * 86_400_000 });
        expect(parseWhen('1 h 5 m', now)).toEqual({ at: now + 65 * 60_000 });
    });
    it('reads a clock time as the next time it shows', () => {
        expect(parseWhen('14:30', now)).toEqual({ at: new Date(2026, 10, 14, 14, 30).getTime() });
        expect(parseWhen('9:05', now)).toEqual({ at: new Date(2026, 10, 15, 9, 5).getTime() });
        expect(parseWhen('10:00', now)).toEqual({ at: new Date(2026, 10, 15, 10, 0).getTime() });
    });
    it('says what is wrong instead of guessing', () => {
        for (const bad of ['', '   ', 'soon', '25:00', '12:60', '0m', '15', '-5m', 'm15']) {
            expect(parseWhen(bad, now), bad).toHaveProperty('error');
        }
        expect(parseWhen(`${Math.ceil(MAX_AHEAD_MS / 86_400_000) + 1}d`, now)).toHaveProperty('error');
    });
});

describe('untilText', () => {
    it('rounds up to the next unit and says due once passed', () => {
        expect(untilText(0, 30_000)).toBe('in 1 min');
        expect(untilText(0, 14 * 60_000)).toBe('in 14 min');
        expect(untilText(0, 3 * 3_600_000)).toBe('in 3 h');
        expect(untilText(0, 3 * 86_400_000)).toBe('in 3 d');
        expect(untilText(10_000, 5_000)).toBe('due');
    });
});

describe('AlertListStore', () => {
    it('keeps what it was given across instances and leaves the list alone when a write fails', () => {
        const storage = memoryStorage();
        const first = new AlertListStore<PercentAlert>('k', sanitizePercentAlerts, storage);
        first.add(percentAlert({ id: 'a' }));
        expect(new AlertListStore<PercentAlert>('k', sanitizePercentAlerts, storage).list().map((a) => a.id)).toEqual(['a']);
        const broken = new AlertListStore<PercentAlert>('k', sanitizePercentAlerts, { getItem: () => null, setItem: () => { throw new Error('full'); } });
        expect(() => broken.add(percentAlert({ id: 'b' }))).toThrow('full');
        expect(broken.list()).toEqual([]);
    });
});

function fakeFeed(): DataProvider & { push(close: number): void; subscribed: boolean } {
    let onBar: ((bar: OHLCV) => void) | null = null;
    const feed = {
        subscribed: false,
        getBars: async () => [] as OHLCV[],
        subscribe: (_t: string, _tf: string, cb: (bar: OHLCV) => void) => {
            onBar = cb;
            feed.subscribed = true;
            return () => { onBar = null; feed.subscribed = false; };
        },
        push(close: number) { onBar?.({ time: Date.now(), open: close, high: close, low: close, close, volume: 0 }); },
    };
    return feed as unknown as DataProvider & { push(close: number): void; subscribed: boolean };
}

describe('PercentAlertEngine', () => {
    let store: ReturnType<typeof percentStore>;
    let feed: ReturnType<typeof fakeFeed>;
    let fired: Array<{ id: string; price: number; move: number }>;
    let errors: string[];
    let engine: PercentAlertEngine;

    beforeEach(() => {
        store = percentStore();
        feed = fakeFeed();
        fired = [];
        errors = [];
        engine = new PercentAlertEngine(store, { binance: () => feed }, (a, price, move) => fired.push({ id: a.id, price, move }), (_a, err) => errors.push(String(err)));
    });

    it('takes the first price as its reference and does not fire on it', () => {
        const a = store.add(percentAlert({ percent: 2 }));
        engine.start();
        feed.push(100);
        expect(fired).toEqual([]);
        expect(store.get(a.id)?.reference).toBe(100);
    });

    it('fires once the move is reached, then disables itself and forgets the reference', () => {
        const a = store.add(percentAlert({ percent: 2, once: true }));
        engine.start();
        feed.push(100);
        feed.push(101);
        expect(fired).toEqual([]);
        feed.push(102.5);
        expect(fired).toHaveLength(1);
        expect(fired[0]!.move).toBeCloseTo(2.5);
        expect(store.get(a.id)).toMatchObject({ enabled: false, reference: null });
        expect(feed.subscribed).toBe(false);
    });

    it('lets a repeating alert measure its next move from where it fired', () => {
        const a = store.add(percentAlert({ percent: 2, once: false, direction: 'either' }));
        engine.start();
        feed.push(100);
        feed.push(102);
        expect(fired).toHaveLength(1);
        expect(store.get(a.id)?.reference).toBe(102);
        feed.push(104); // 1.96% from 102: not yet
        expect(fired).toHaveLength(1);
        feed.push(99.9); // -2.06% from 102
        expect(fired).toHaveLength(2);
        expect(store.get(a.id)?.enabled).toBe(true);
    });

    it('ignores a move against the direction it was asked for', () => {
        store.add(percentAlert({ percent: 2, direction: 'up' }));
        engine.start();
        feed.push(100);
        feed.push(90);
        expect(fired).toEqual([]);
    });

    it('stops watching a market once nothing on it is enabled', () => {
        const a = store.add(percentAlert());
        engine.start();
        expect(feed.subscribed).toBe(true);
        store.update(a.id, { enabled: false });
        expect(feed.subscribed).toBe(false);
        expect(engine.openCount).toBe(0);
    });

    it('reports a market it cannot watch, once', () => {
        store.add(percentAlert({ symbol: 'nowhere:XYZ' }));
        engine.start();
        store.update(store.list()[0]!.id, { message: 'edited' });
        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain('nowhere');
    });
});

describe('TimeAlertEngine', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(2026, 10, 14, 10, 0, 0));
    });
    afterEach(() => vi.useRealTimers());

    const at = (offsetMs: number, patch: Partial<TimeAlert> = {}): TimeAlert => ({ ...newTimeAlert(Date.now() + offsetMs), ...patch });

    it('fires at the moment, once, and disables the alert', () => {
        const store = timeStore();
        const a = store.add(at(5 * 60_000));
        const fired: number[] = [];
        const engine = new TimeAlertEngine(store, (alert, late) => { fired.push(late); expect(alert.id).toBe(a.id); });
        engine.start();
        vi.advanceTimersByTime(4 * 60_000);
        expect(fired).toEqual([]);
        vi.advanceTimersByTime(60_000 + 100);
        expect(fired).toHaveLength(1);
        expect(store.get(a.id)).toMatchObject({ enabled: false });
        vi.advanceTimersByTime(10 * 60_000);
        expect(fired).toHaveLength(1);
        engine.stop();
    });

    it('fires an alert that came due while the app was closed, and says how late', () => {
        const store = timeStore();
        store.add(at(-3 * 3_600_000));
        const late: number[] = [];
        const engine = new TimeAlertEngine(store, (_a, ms) => late.push(ms));
        engine.start();
        expect(late).toEqual([3 * 3_600_000]);
        engine.stop();
    });

    it('fires each of several due alerts exactly once', () => {
        const store = timeStore();
        store.add(at(-1000));
        store.add(at(-2000));
        store.add(at(-3000));
        let count = 0;
        const engine = new TimeAlertEngine(store, () => { count++; });
        engine.start();
        expect(count).toBe(3);
        engine.stop();
    });

    it('never fires a disabled alert, and picks up one added later', () => {
        const store = timeStore();
        store.add(at(-1000, { enabled: false }));
        let count = 0;
        const engine = new TimeAlertEngine(store, () => { count++; });
        engine.start();
        expect(count).toBe(0);
        store.add(at(2 * 60_000));
        vi.advanceTimersByTime(2 * 60_000 + 100);
        expect(count).toBe(1);
        engine.stop();
    });

    it('still fires on time when the wait was longer than one look', () => {
        const store = timeStore();
        store.add(at(10 * 60_000));
        let count = 0;
        const engine = new TimeAlertEngine(store, () => { count++; });
        engine.start();
        vi.advanceTimersByTime(9 * 60_000);
        expect(count).toBe(0);
        vi.advanceTimersByTime(60_000 + 100);
        expect(count).toBe(1);
        engine.stop();
    });

    it('stops looking once stopped', () => {
        const store = timeStore();
        store.add(at(60_000));
        let count = 0;
        const engine = new TimeAlertEngine(store, () => { count++; });
        engine.start();
        engine.stop();
        vi.advanceTimersByTime(5 * 60_000);
        expect(count).toBe(0);
    });
});
