import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AlertEngine } from '../app/renderer/alerts/AlertEngine';
import { AlertListStore } from '../app/renderer/alerts/AlertListStore';
import { AlertStore } from '../app/renderer/alerts/AlertStore';
import { coolingDown, DEFAULT_COOLDOWN_MS, readCooldown } from '../app/renderer/alerts/alertCooldown';
import { newAlert } from '../app/renderer/alerts/alertTypes';
import { IndicatorAlertEngine } from '../app/renderer/alerts/IndicatorAlertEngine';
import { IndicatorAlertStore } from '../app/renderer/alerts/IndicatorAlertStore';
import { newIndicatorAlert, specOf } from '../app/renderer/alerts/indicatorAlertModel';
import { sanitizeIndicatorAlerts } from '../app/renderer/alerts/indicatorAlertStorage';
import { PercentAlertEngine } from '../app/renderer/alerts/PercentAlertEngine';
import { newPercentAlert, sanitizePercentAlerts, type PercentAlert } from '../app/renderer/alerts/percentAlertModel';
import type { DataProvider } from '../src/plugin';
import type { OHLCV } from '../src/core/model/ohlcv';

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 10, 14, 10, 0, 0)); });
afterEach(() => { vi.useRealTimers(); });

const bar = (i: number, close: number): OHLCV => ({ time: i * 60_000, open: close, high: close + 1, low: close - 1, close, volume: 10 });

function liveFeed(history: OHLCV[] = []) {
    let listener: ((b: OHLCV) => void) | null = null;
    const provider = {
        getBars: async () => history,
        subscribe: (_t: string, _tf: string, cb: (b: OHLCV) => void) => { listener = cb; return () => { listener = null; }; },
    } as unknown as DataProvider;
    return { provider, push: (b: OHLCV) => listener?.(b), pushClose: (close: number) => listener?.(bar(Date.now(), close)) };
}

describe('coolingDown', () => {
    const base = { once: false, cooldownMs: 60_000, lastTriggeredAt: 1_000 };
    it('pauses a repeating alert until the pause has passed', () => {
        expect(coolingDown(base, 30_000)).toBe(true);
        expect(coolingDown(base, 61_000)).toBe(false);
    });
    it('never pauses an alert that has not fired, has no pause, or fires once', () => {
        expect(coolingDown({ ...base, lastTriggeredAt: null }, 2_000)).toBe(false);
        expect(coolingDown({ ...base, cooldownMs: 0 }, 2_000)).toBe(false);
        expect(coolingDown({ once: false, lastTriggeredAt: 1_000 }, 2_000)).toBe(false);
        expect(coolingDown({ ...base, once: true }, 2_000)).toBe(false);
    });
    it('reads a stored pause only when it is a number of at least zero', () => {
        expect(readCooldown(5000)).toBe(5000);
        expect(readCooldown(0)).toBe(0);
        for (const bad of [-1, Number.NaN, '60', null, undefined]) expect(readCooldown(bad)).toBeUndefined();
    });
    it('starts new alerts with the default pause and reads old ones without any', () => {
        expect(newAlert('binance:BTCUSDT', 1).cooldownMs).toBe(DEFAULT_COOLDOWN_MS);
        expect(newPercentAlert('binance:BTCUSDT').cooldownMs).toBe(DEFAULT_COOLDOWN_MS);
        expect(newIndicatorAlert('binance:BTCUSDT', '60', specOf('rsi')!).cooldownMs).toBe(DEFAULT_COOLDOWN_MS);
        const old = { ...newPercentAlert('binance:BTCUSDT') } as Partial<PercentAlert>;
        delete old.cooldownMs;
        expect(sanitizePercentAlerts([old])[0]!.cooldownMs).toBeUndefined();
        expect(sanitizePercentAlerts([{ ...old, cooldownMs: 300_000 }])[0]!.cooldownMs).toBe(300_000);
    });
});

describe('a repeating price alert with a pause', () => {
    const setup = (cooldownMs: number) => {
        (globalThis as unknown as { window: unknown }).window = { midori: { alerts: { load: async () => [], save: async () => ({ savedAt: 0 }) } } };
        const store = new AlertStore();
        store.add({ ...newAlert('fake:BTC', 100), once: false, cooldownMs });
        const feed = liveFeed();
        const fired: number[] = [];
        const engine = new AlertEngine(store, { fake: () => feed.provider }, (_a, price) => fired.push(price));
        engine.start();
        return { feed, fired, engine };
    };

    it('tells the first crossing and not the ones within the pause', () => {
        const { feed, fired, engine } = setup(60_000);
        feed.pushClose(99);
        feed.pushClose(101); // up: fires
        feed.pushClose(99);  // down, 0 s later: paused
        feed.pushClose(101); // up again: paused
        expect(fired).toEqual([101]);
        engine.stop();
    });

    it('tells a crossing again once the pause is over', () => {
        const { feed, fired, engine } = setup(60_000);
        feed.pushClose(99);
        feed.pushClose(101);
        vi.advanceTimersByTime(61_000);
        feed.pushClose(99);
        expect(fired).toEqual([101, 99]);
        engine.stop();
    });

    it('fires every crossing when there is no pause', () => {
        const { feed, fired, engine } = setup(0);
        for (const close of [99, 101, 99, 101]) feed.pushClose(close);
        expect(fired).toEqual([101, 99, 101]);
        engine.stop();
    });
});

describe('a repeating percent alert with a pause', () => {
    const setup = (cooldownMs: number) => {
        const data = new Map<string, string>();
        const store = new AlertListStore<PercentAlert>('p', sanitizePercentAlerts, { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) });
        store.add({ ...newPercentAlert('fake:BTC'), percent: 1, once: false, direction: 'either', cooldownMs });
        const feed = liveFeed();
        const fired: number[] = [];
        const engine = new PercentAlertEngine(store, { fake: () => feed.provider }, (_a, price) => fired.push(price), () => undefined);
        engine.start();
        return { feed, fired, engine };
    };

    it('waits out the pause, then fires if the move is still there', () => {
        const { feed, fired, engine } = setup(60_000);
        feed.pushClose(100);
        feed.pushClose(101); // +1%: fires, reference moves to 101
        feed.pushClose(103); // +1.98% from 101, within the pause
        expect(fired).toEqual([101]);
        vi.advanceTimersByTime(61_000);
        feed.pushClose(103);
        expect(fired).toEqual([101, 103]);
        engine.stop();
    });

    it('fires straight away without a pause', () => {
        const { feed, fired, engine } = setup(0);
        feed.pushClose(100);
        feed.pushClose(101);
        feed.pushClose(103);
        expect(fired).toEqual([101, 103]);
        engine.stop();
    });
});

describe('a repeating indicator alert with a pause', () => {
    const run = async (cooldownMs: number) => {
        const data = new Map<string, string>();
        const store = new IndicatorAlertStore({ getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) });
        store.add({
            ...newIndicatorAlert('fake:BTC', '1', specOf('rsi')!),
            inputs: { length: 3 }, against: { kind: 'level', value: 70 }, condition: 'crosses', once: false, cooldownMs,
        });
        const history = Array.from({ length: 30 }, (_, i) => bar(i, 200 - i));
        const feed = liveFeed(history);
        let fired = 0;
        const engine = new IndicatorAlertEngine(store, { fake: () => feed.provider }, () => { fired++; }, () => undefined);
        engine.start();
        await vi.advanceTimersByTimeAsync(0);
        // A run of rising bars takes a short RSI up through 70, a run of falling ones back down through it.
        let close = 170;
        for (let i = 30; i < 38; i++) { close += 12; feed.push(bar(i, close)); await vi.advanceTimersByTimeAsync(600); }
        for (let i = 38; i < 48; i++) { close -= 25; feed.push(bar(i, close)); await vi.advanceTimersByTimeAsync(600); }
        engine.stop();
        return fired;
    };

    it('fires the crossing back down too when there is no pause', async () => {
        expect(await run(0)).toBeGreaterThanOrEqual(2);
    });

    it('tells only the first crossing while the pause lasts', async () => {
        expect(await run(60_000)).toBe(1);
    });
});

describe('stored indicator alerts', () => {
    it('keep their pause and drop a damaged one', () => {
        const base = { ...newIndicatorAlert('binance:BTCUSDT', '60', specOf('rsi')!) };
        expect(sanitizeIndicatorAlerts([{ ...base, cooldownMs: 900_000 }])[0]!.cooldownMs).toBe(900_000);
        expect(sanitizeIndicatorAlerts([{ ...base, cooldownMs: 'soon' }])[0]!.cooldownMs).toBeUndefined();
    });
});
