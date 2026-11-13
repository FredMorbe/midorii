import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataProvider } from '../src/plugin';
import type { OHLCV } from '../src/core/model/ohlcv';
import { applyBar, IndicatorAlertEngine } from '../app/renderer/alerts/IndicatorAlertEngine';
import { IndicatorAlertStore } from '../app/renderer/alerts/IndicatorAlertStore';
import { newIndicatorAlert, specOf, type IndicatorAlert } from '../app/renderer/alerts/indicatorAlertModel';

const bar = (i: number, close: number): OHLCV => ({ time: i * 60_000, open: close, high: close + 1, low: close - 1, close, volume: 10 });
const falling = (n: number): OHLCV[] => Array.from({ length: n }, (_, i) => bar(i, 200 - i));

const memoryStore = (): IndicatorAlertStore => {
    const data = new Map<string, string>();
    return new IndicatorAlertStore({ getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); } });
};

interface Fake {
    provider: DataProvider;
    push: (b: OHLCV) => void;
    subscriptions: () => number;
    resolveHistory: () => void;
}

/** A provider whose history resolves when the test says so and whose live bars the test pushes. */
function fakeProvider(history: OHLCV[], opts: { stream?: boolean } = {}): Fake {
    let listener: ((b: OHLCV) => void) | null = null;
    let open = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    const provider = {
        getBars: async () => { await gate; return history; },
        ...(opts.stream === false ? {} : {
            subscribe: (_t: string, _tf: string, cb: (b: OHLCV) => void) => {
                listener = cb; open++;
                return () => { open--; listener = null; };
            },
        }),
    } as unknown as DataProvider;
    return { provider, push: (b) => listener?.(b), subscriptions: () => open, resolveHistory: release };
}

const rsiAlert = (patch: Partial<IndicatorAlert> = {}): IndicatorAlert => ({
    ...newIndicatorAlert('fake:BTC', '1', specOf('rsi')!),
    inputs: { length: 3 },
    against: { kind: 'level', value: 70 },
    ...patch,
});

const flush = async (): Promise<void> => { await vi.advanceTimersByTimeAsync(0); };

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('applyBar', () => {
    it('replaces the forming bar, appends a newer one and drops an older one', () => {
        const bars = [bar(0, 1), bar(1, 2)];
        applyBar(bars, bar(1, 5));
        expect(bars.map((b) => b.close)).toEqual([1, 5]);
        applyBar(bars, bar(2, 6));
        expect(bars).toHaveLength(3);
        applyBar(bars, bar(0, 9));
        expect(bars).toHaveLength(3);
    });
});

describe('IndicatorAlertEngine', () => {
    it('fires when the indicator crosses its level, never on the first reading, and disables a one-shot', async () => {
        const fake = fakeProvider(falling(30));
        const store = memoryStore();
        store.add(rsiAlert());
        const fired: number[] = [];
        const engine = new IndicatorAlertEngine(store, { fake: () => fake.provider }, (_a, r) => { fired.push(r.value ?? NaN); }, () => undefined);
        engine.start();
        fake.resolveHistory();
        await flush();
        expect(fired).toHaveLength(0);

        // A run of rising bars drives a short RSI from the floor up through 70.
        for (let i = 30; i < 36; i++) {
            fake.push(bar(i, 200 - 30 + (i - 29) * 12));
            await vi.advanceTimersByTimeAsync(600);
        }
        expect(fired).toHaveLength(1);
        expect(fired[0]).toBeGreaterThanOrEqual(70);
        expect(store.list()[0]?.enabled).toBe(false);
        expect(store.list()[0]?.lastTriggeredAt).not.toBeNull();
        engine.stop();
    });

    it('shares one subscription between alerts on a market and closes it with the last one', async () => {
        const fake = fakeProvider(falling(30));
        const store = memoryStore();
        const a = store.add(rsiAlert());
        const b = store.add(rsiAlert({ id: 'second', condition: 'crosses-below' }));
        const engine = new IndicatorAlertEngine(store, { fake: () => fake.provider }, () => undefined, () => undefined);
        engine.start();
        expect(fake.subscriptions()).toBe(1);
        expect(engine.openCount).toBe(1);
        store.update(a.id, { enabled: false });
        expect(fake.subscriptions()).toBe(1);
        store.remove(b.id);
        expect(fake.subscriptions()).toBe(0);
        expect(engine.openCount).toBe(0);
        engine.stop();
    });

    it('keeps the live bars that arrive while the history loads', async () => {
        const fake = fakeProvider(falling(30));
        const store = memoryStore();
        store.add(rsiAlert());
        const fired: number[] = [];
        const engine = new IndicatorAlertEngine(store, { fake: () => fake.provider }, (_a, r) => { fired.push(r.value ?? NaN); }, () => undefined);
        engine.start();
        fake.push(bar(30, 180));
        fake.resolveHistory();
        await flush();
        // Only the first reading has happened: it sets the side and fires nothing.
        expect(fired).toHaveLength(0);
        engine.stop();
    });

    it('reports a provider without a live feed once, and watches nothing', () => {
        const fake = fakeProvider(falling(30), { stream: false });
        const store = memoryStore();
        store.add(rsiAlert());
        const errors: string[] = [];
        const engine = new IndicatorAlertEngine(store, { fake: () => fake.provider }, () => undefined, (_a, err) => { errors.push(String(err)); });
        engine.start();
        store.update(store.list()[0]!.id, { message: 'edited' });
        expect(errors).toHaveLength(1);
        expect(errors[0]).toMatch(/no live feed/);
        engine.stop();
    });

    it('reports an unknown data source', () => {
        const store = memoryStore();
        store.add(rsiAlert({ symbol: 'nowhere:BTC' }));
        const errors: string[] = [];
        const engine = new IndicatorAlertEngine(store, {}, () => undefined, (_a, err) => { errors.push(String(err)); });
        engine.start();
        expect(errors[0]).toMatch(/No data source named "nowhere"/);
        engine.stop();
    });
});
