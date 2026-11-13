// The replay transport the bar and the keys drive: a step back, going to a date, and hearing
// about every change. The account is compared against a session that never did the undone
// things, as in replay-jump.test.ts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { aggregate, STRIDE } from '../app/electron/data/store/barStore.js';
import { barIndexAt } from '../shared/engine/replaySession.js';
import { ReplayController } from '../app/renderer/replay/ReplayController';
import type { ReplayProvider } from '../app/renderer/replay/ReplayProvider';
import { loadReplayWindow } from '../app/renderer/replay/replayWindow';

const MINUTE = 60_000;
const HOUR = 3_600_000;
const START = Date.UTC(2024, 0, 1);
const DAYS = 2;

function minuteData(): Float64Array {
    const count = DAYS * 24 * 60;
    const data = new Float64Array(count * STRIDE);
    for (let i = 0; i < count; i++) {
        const base = i * STRIDE;
        const price = 100 + Math.sin(i / 30) * 5;
        data[base] = START + i * MINUTE;
        data[base + 1] = price;
        data[base + 2] = price + 0.4;
        data[base + 3] = price - 0.4;
        data[base + 4] = price + 0.1;
        data[base + 5] = 10;
        data[base + 6] = 6;
    }
    return data;
}

const DATA = minuteData();
const LAST = START + (DAYS * 24 * 60 - 1) * MINUTE;

const midori = {
    data: {
        meta: () => Promise.resolve({ symbol: 'TEST', first: START, last: LAST }),
        bars: ({ timeframe, from, to, dropIncomplete = true }: {
            timeframe: string; from: number; to: number; dropIncomplete?: boolean;
        }) => Promise.resolve(aggregate(DATA, from, to, timeframe, dropIncomplete)),
    },
};

class FakeProvider {
    timeframe = '5';
    cutoff = 0;
    constructor(timeframe: string, clock: number) { this.retime(timeframe, clock); }
    retime(timeframe: string, clock: number): void { this.timeframe = timeframe; this.cutoff = clock; }
    revealNext(): void {}
}

let previousWindow: unknown;
beforeAll(() => {
    previousWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = { midori };
});
afterAll(() => {
    (globalThis as { window?: unknown }).window = previousWindow;
});

async function session(timeframe: string, clock: number) {
    const { bars } = await loadReplayWindow('TEST', timeframe, clock);
    return new ReplayController({
        provider: new FakeProvider(timeframe, clock) as unknown as ReplayProvider,
        symbol: 'TEST',
        timeframe,
        bars,
        startIndex: barIndexAt(bars, clock - 1),
        balance: 10_000,
        rechart: (tf, at) => Promise.resolve(new FakeProvider(tf, at) as unknown as ReplayProvider),
    });
}

const T0 = START + 6 * HOUR;
const FIVE = 5 * MINUTE;

describe('one candle back', () => {
    it('lands on the close of the candle before, and undoes what was done on the last one', async () => {
        const c = await session('5', T0);
        c.skip(3);
        c.buy({ size: 1 });
        c.skip(2);
        expect(c.session.broker.positions).toHaveLength(1);

        await c.stepBack();
        expect(c.session.clock).toBe(T0 + 4 * FIVE);
        expect(c.session.broker.positions).toHaveLength(1); // opened earlier than the candle it went back over

        await c.stepBack();
        await c.stepBack();
        expect(c.session.clock).toBe(T0 + 2 * FIVE);
        expect(c.session.broker.positions).toHaveLength(0); // the order was placed after this candle
        expect(c.session.broker.trades).toHaveLength(0);
    });

    it('is the same account as one that never went on', async () => {
        const a = await session('5', T0);
        a.skip(4);
        await a.stepBack();
        const b = await session('5', T0);
        b.skip(3);
        expect(a.session.clock).toBe(b.session.clock);
        expect(a.session.bar.close).toBe(b.session.bar.close);
        expect(a.session.broker.equity).toBe(b.session.broker.equity);
    });
});

describe('going to a date', () => {
    it('plays on up to the last candle that has closed by then', async () => {
        const c = await session('5', T0);
        const landed = await c.goTo(T0 + 22 * MINUTE);
        expect(landed).toBe(T0 + 20 * MINUTE);
        expect(c.session.clock).toBe(T0 + 20 * MINUTE);
    });

    it('stays where it is when the date is the clock', async () => {
        const c = await session('5', T0);
        expect(await c.goTo(T0)).toBe(T0);
    });

    it('goes back, undoing what was done since', async () => {
        const c = await session('5', T0);
        c.skip(6);
        c.buy({ size: 1 });
        c.skip(4);
        const landed = await c.goTo(T0 + 3 * FIVE + 2 * MINUTE);
        expect(landed).toBe(T0 + 3 * FIVE);
        expect(c.session.broker.positions).toHaveLength(0);
    });

    it('stops short at the end of the loaded candles and says where', async () => {
        const c = await session('5', T0);
        const landed = await c.goTo(START + 10 * 24 * HOUR);
        expect(landed).toBeLessThan(START + 10 * 24 * HOUR);
        expect(c.atEnd).toBe(true);
    });

    it('refuses what is not a time', async () => {
        const c = await session('5', T0);
        await expect(c.goTo(Number.NaN)).rejects.toThrow(/date/i);
    });

    it('refuses a date before the session began rather than landing somewhere else', async () => {
        const c = await session('5', T0);
        c.skip(2);
        await expect(c.goTo(START + HOUR)).rejects.toThrow();
        expect(c.session.clock).toBe(T0 + 2 * FIVE);
    });
});

describe('hearing about the session', () => {
    it('reports a step, a start and stop, and a new speed — and nothing once let go', async () => {
        const c = await session('5', T0);
        let heard = 0;
        const stop = c.onChange(() => { heard += 1; });

        c.skip(1);
        expect(heard).toBeGreaterThan(0);

        heard = 0;
        c.play();
        c.pause();
        expect(heard).toBe(2);

        heard = 0;
        c.setSpeed(10);
        expect(heard).toBe(1);

        stop();
        heard = 0;
        c.skip(1);
        expect(heard).toBe(0);
    });

    it('is silent once the session is left', async () => {
        const c = await session('5', T0);
        let heard = 0;
        c.onChange(() => { heard += 1; });
        c.destroy();
        c.skip(1);
        expect(heard).toBe(0);
    });

    it('survives a listener that throws', async () => {
        const c = await session('5', T0);
        const original = console.error;
        console.error = () => {};
        try {
            let heard = 0;
            c.onChange(() => { throw new Error('boom'); });
            c.onChange(() => { heard += 1; });
            c.skip(1);
            expect(heard).toBeGreaterThan(0);
        } finally {
            console.error = original;
        }
    });
});
