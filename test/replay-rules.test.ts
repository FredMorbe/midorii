// A funded account's limits, applied to a replay: judged on the replay's own clock and balance,
// refusing what would add to a breach, closing everything where the rules say so.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { aggregate, STRIDE } from '../app/electron/data/store/barStore.js';
import { barIndexAt } from '../shared/engine/replaySession.js';
import { ReplayController } from '../app/renderer/replay/ReplayController';
import type { ReplayProvider } from '../app/renderer/replay/ReplayProvider';
import { loadReplayWindow } from '../app/renderer/replay/replayWindow';
import { REPLAY_ACCOUNT_KEY, wireReplayRules } from '../app/renderer/replay/replayRules';
import { saveAccountRules } from '../app/renderer/trading/accountRules';
import { NO_LIMITS, type RiskLimits } from '../app/renderer/trading/riskLimits';

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
let previousStorage: unknown;
beforeAll(() => {
    previousWindow = (globalThis as { window?: unknown }).window;
    previousStorage = (globalThis as { localStorage?: unknown }).localStorage;
    (globalThis as { window?: unknown }).window = { midori };
});
afterAll(() => {
    (globalThis as { window?: unknown }).window = previousWindow;
    (globalThis as { localStorage?: unknown }).localStorage = previousStorage;
});
beforeEach(() => {
    const cells = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = {
        getItem: (k: string) => cells.get(k) ?? null,
        setItem: (k: string, v: string) => void cells.set(k, v),
        removeItem: (k: string) => void cells.delete(k),
    };
});

const T0 = START + 6 * HOUR;

async function session(balance = 10_000) {
    const { bars } = await loadReplayWindow('TEST', '5', T0);
    const controller = new ReplayController({
        provider: new FakeProvider('5', T0) as unknown as ReplayProvider,
        symbol: 'TEST',
        timeframe: '5',
        bars,
        startIndex: barIndexAt(bars, T0 - 1),
        balance,
        rechart: (tf, at) => Promise.resolve(new FakeProvider(tf, at) as unknown as ReplayProvider),
    });
    const toasts: Array<{ message: string; kind: string }> = [];
    const ws = { root: {}, toast: (message: string, kind = 'info') => { toasts.push({ message, kind }); } };
    const rules = wireReplayRules({ controller, ws: ws as never, onChange: () => {} });
    return { controller, rules, toasts };
}

const limits = (over: Partial<RiskLimits>): RiskLimits => ({ ...NO_LIMITS, ...over });
const set = (over: Partial<RiskLimits>): void => saveAccountRules(REPLAY_ACCOUNT_KEY, { limits: limits(over), highWater: 0 });

describe('limits on a replay', () => {
    it('refuses nothing while no limit is set', async () => {
        const { rules } = await session();
        expect(() => rules.guardOrder({ side: 'buy', size: 1_000 })).not.toThrow();
    });

    it('refuses an order that would add past the largest size, and lets what closes through', async () => {
        set({ maxSize: 2 });
        const { controller, rules } = await session();
        rules.guardOrder({ side: 'buy', size: 2 });
        expect(() => rules.guardOrder({ side: 'buy', size: 3 })).toThrow(/2/);
        controller.buy({ size: 2 });
        // Selling reduces what is held — never refused.
        expect(() => rules.guardOrder({ side: 'sell', size: 2 })).not.toThrow();
        // Adding to it is.
        expect(() => rules.guardOrder({ side: 'buy', size: 1 })).toThrow();
    });

    it('holds a reverse to the same rule: it opens a trade the other way', async () => {
        set({ maxSize: 1 });
        const { controller, rules } = await session();
        controller.buy({ size: 2 }); // bypasses the guard on purpose — a position already on
        const held = controller.broker.positions[0]!;
        expect(() => rules.guardReverse(held.id)).toThrow();
    });

    it('measures the floor from the balance the session was started with', async () => {
        set({ startBalance: 150_000, maxLoss: 500, mllMode: 'static' });
        const { rules } = await session(10_000);
        expect(rules.prop.read().room).toBe(500);
    });

    it('keeps the trade list in step with the account, and forgets it when the account is replaced', async () => {
        const { controller, rules } = await session();
        expect(rules.history()).toHaveLength(0);
        controller.skip(2);
        controller.buy({ size: 1 });
        controller.skip(3);
        controller.close();
        const first = rules.history();
        expect(first).toHaveLength(1);
        expect(rules.history()).toBe(first); // cached while nothing closed
        // Going back to before the trade replaces the account: the list must not be the old one.
        await controller.goTo(T0 + 5 * 60_000);
        expect(rules.history()).toHaveLength(0);
    });

    it('closes everything once, where the rules say to, when a limit is past', async () => {
        set({ dailyLoss: 100, onBreach: 'flatten' });
        const { controller, rules, toasts } = await session();
        controller.buy({ size: 50 });
        let breached: string | null = null;
        for (let i = 0; i < 250 && !breached; i++) {
            controller.skip(1);
            breached = rules.prop.read().breached;
        }
        expect(breached).toBe('dll');
        rules.prop.enforce();
        rules.prop.enforce();
        expect(controller.broker.positions).toHaveLength(0);
        const said = toasts.filter((t) => t.kind === 'error' && /closing everything/.test(t.message));
        expect(said).toHaveLength(1);
        // There is no venue behind a replay to go and check.
        expect(said[0]!.message).not.toMatch(/venue/i);
    });
});
