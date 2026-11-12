// A bot, running. The rules under test: a bar is only handed to the strategy once it has
// CLOSED, the strategy's own state survives being rebuilt on every bar, the guards gate
// entries without ever stopping a strategy managing what it already holds, and stopping a
// bot never closes anything.
// See app/renderer/bot/BotRunner.ts.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BotRunner } from '../app/renderer/bot/BotRunner';
import { STRATEGIES } from '../app/renderer/strategies';
import type { StrategySpec } from '../app/renderer/strategies/types';
import type { DataProvider } from '../src/plugin';
import type { OHLCV } from '../src/core/model/ohlcv';
import type { BacktestContext } from '../shared/engine/backtest';
import { HISTORY_BARS, MAX_HISTORY_BARS, newBot, startRefusal, type BotConfig } from '../app/renderer/bot/botTypes';
import { RISK_PARAMS } from '../shared/strategies/risk.js';

const MINUTE = 60_000;

function bar(time: number, close: number): OHLCV {
    return { time, open: close, high: close + 0.5, low: close - 0.5, close, volume: 100 };
}

/** Enough seed bars for the runner to start on. Prices walk up so nothing is ambiguous. */
function seedBars(count: number): OHLCV[] {
    return Array.from({ length: count }, (_, i) => bar(i * MINUTE, 100 + i * 0.1));
}

/** A provider whose live feed the test drives by hand. */
function fakeProvider(bars: OHLCV[]) {
    const offset = bars.length && bars[bars.length - 1]!.time < Date.UTC(2000, 0, 1)
        ? Date.now() - bars[bars.length - 1]!.time : 0;
    const atCurrentTime = (b: OHLCV): OHLCV => ({ ...b, time: b.time + offset });
    let push: ((bar: OHLCV) => void) | null = null;
    let unsubscribed = false;
    const provider: DataProvider = {
        getBars: () => Promise.resolve(bars.map(atCurrentTime)),
        subscribe: (_ticker, _tf, onBar) => {
            push = onBar;
            return () => { unsubscribed = true; push = null; };
        },
    };
    return {
        provider,
        feed: (b: OHLCV) => push?.(atCurrentTime(b)),
        get subscribed() { return push != null; },
        get unsubscribed() { return unsubscribed; },
    };
}

/**
 * A strategy whose behaviour the test dictates, put into the registry for the run.
 *
 * A real strategy would work here too and one of them is exercised elsewhere; what this
 * file is about is the RUNNER — whether a bar reaches `onBar` once, at the right moment,
 * with the state it left behind last time.
 */
function installStrategy(id: string, onBar: (ctx: BacktestContext) => void): void {
    const spec: StrategySpec = {
        id,
        name: 'Test strategy',
        description: 'Only exists inside a test.',
        params: [],
        build: () => ({ params: {}, onBar: onBar as StrategySpec['build'] extends never ? never : (ctx: unknown) => void }),
    };
    STRATEGIES[id] = spec;
}

/**
 * Like {@link installStrategy}, but carrying the risk schema every real strategy has.
 *
 * Without it `breakEvenAtR` is not a setting this strategy owns, so the bot would never
 * see one — and a test about managed exits would be proving nothing about managed exits.
 */
function installManaged(id: string, onBar: (ctx: BacktestContext) => void): void {
    const spec: StrategySpec = {
        id,
        name: 'Test strategy',
        description: 'Only exists inside a test.',
        params: [...RISK_PARAMS] as StrategySpec['params'],
        build: () => ({ params: {}, onBar: onBar as (ctx: unknown) => void }),
    };
    STRATEGIES[id] = spec;
}

function testBot(over: Partial<BotConfig> = {}): BotConfig {
    return { ...newBot('test-strategy', 'fake:TEST'), timeframe: '1', balance: 10_000, ...over };
}

/** A runner on the fake provider, with the guards wide open unless the test says otherwise. */
function makeRunner(provider: DataProvider, bot: BotConfig): BotRunner {
    return new BotRunner({ bot, providers: { fake: () => provider } });
}

let calls: Array<{ index: number; close: number; state: Record<string, unknown> }>;

beforeEach(() => {
    calls = [];
    /* The runner reads and writes its account through the bridge now, so a bare stub is no
     * longer enough — a missing channel would fail every start rather than the thing under
     * test. Nothing here persists: what these tests are about is the runner, not the disk
     * (see bot-account-persistence.test.ts for that). */
    (globalThis as { window?: unknown }).window = {
        midori: {
            bots: {
                account: {
                    load: () => Promise.resolve(null),
                    save: () => Promise.resolve({ savedAt: Date.now() }),
                    clear: () => Promise.resolve(true),
                    sweep: () => Promise.resolve({ removed: 0 }),
                },
            },
        },
    };
    // A Wednesday at 14:00 UTC — inside the default Mon–Fri, whole-day window.
    vi.setSystemTime(new Date(Date.UTC(2026, 8, 9, 14, 0)));
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(Date.UTC(2026, 8, 9, 14, 0)));
});

afterEach(() => {
    vi.useRealTimers();
    delete STRATEGIES['test-strategy'];
    delete (globalThis as { window?: unknown }).window;
});

describe('starting', () => {
    it('does not open a feed after it is stopped while history is still loading', async () => {
        installStrategy('test-strategy', () => undefined);
        let releaseHistory: (bars: OHLCV[]) => void = () => undefined;
        let subscriptions = 0;
        const provider: DataProvider = {
            getBars: () => new Promise((resolve) => { releaseHistory = resolve; }),
            subscribe: () => {
                subscriptions += 1;
                return () => undefined;
            },
        };
        const runner = makeRunner(provider, testBot());

        const starting = runner.start();
        await vi.waitFor(() => expect(runner.status).toBe('starting'));
        runner.stop();
        releaseHistory(seedBars(10));
        await starting;

        expect(runner.status).toBe('stopped');
        expect(subscriptions).toBe(0);
    });

    it('asks for its latest bars as a count, not as a window of time', async () => {
        installStrategy('test-strategy', () => undefined);
        const asked: Array<{ from?: number; to?: number; limit?: number }> = [];
        const provider: DataProvider = {
            getBars: (_ticker, _tf, range) => {
                asked.push(range);
                return Promise.resolve(seedBars(10));
            },
            subscribe: () => () => undefined,
        };
        const runner = makeRunner(provider, testBot());

        await runner.start();

        // Capital.com refuses an explicit ten-day window of 5-minute bars outright
        // (error.invalid.max.daterange), and a window of time is bars × timeframe of CALENDAR
        // time, which a market that shuts overnight never fills. "The latest N" is what the
        // bot means, and it is the one request every venue answers.
        expect(asked).toHaveLength(1);
        expect(asked[0]!.from).toBeUndefined();
        expect(asked[0]!.limit).toBe(HISTORY_BARS);
        expect(asked[0]!.to).toBe(Date.now());
        runner.stop();
    });

    it('seeds the history without the bar that is still forming', async () => {
        installStrategy('test-strategy', () => undefined);
        const bars = seedBars(10);
        const feed = fakeProvider(bars);
        const runner = makeRunner(feed.provider, testBot());

        await runner.start();

        expect(runner.status).toBe('running');
        // Ten bars served, nine of them closed: the newest is the forming candle, and a
        // strategy handed a bar that is still moving is a strategy reading the future.
        expect(runner.barCount).toBe(9);
        expect(feed.subscribed).toBe(true);
        runner.stop();
    });

    it('refuses a market with no live feed rather than sitting there inert', async () => {
        installStrategy('test-strategy', () => undefined);
        const provider: DataProvider = { getBars: () => Promise.resolve(seedBars(10)) };
        const runner = makeRunner(provider, testBot());

        await expect(runner.start()).rejects.toThrow(/no live feed/);
        expect(runner.status).toBe('failed');
    });

    it('refuses a strategy this build does not have', async () => {
        const feed = fakeProvider(seedBars(10));
        const runner = makeRunner(feed.provider, testBot({ strategy: 'not-a-strategy' }));

        await expect(runner.start()).rejects.toThrow(/no strategy called/);
        expect(feed.subscribed).toBe(false);
    });

    it('refuses a live bot pointed at a market the venue does not serve', async () => {
        installStrategy('test-strategy', () => undefined);
        const feed = fakeProvider(seedBars(10));
        const runner = makeRunner(feed.provider, testBot({ venue: 'capital', symbol: 'binance:BTCUSDT' }));

        await expect(runner.start()).rejects.toThrow(/Capital\.com asset/);
    });

    it('refuses a live bot that asks for break-even or a trail, rather than ignoring it', async () => {
        installManaged('test-strategy', () => undefined);
        const feed = fakeProvider(seedBars(10));
        const live = { venue: 'capital' as const, symbol: 'capital:TEST' };

        // Only the paper account applies them. A live bot that quietly traded without the
        // protection its settings promise is the one failure that cannot be noticed in time.
        for (const params of [{ breakEvenAtR: 1 }, { trailAtR: 1, trailR: 0.5 }]) {
            const runner = makeRunner(feed.provider, testBot({ ...live, params }));
            await expect(runner.start()).rejects.toThrow(/paper account/);
            expect(runner.status).toBe('failed');
        }
        expect(feed.subscribed).toBe(false);

        // Control: the same live bot with nothing to manage is not turned away for it.
        expect(startRefusal(testBot({ ...live, params: {} }))).toBeNull();
    });

    it('refuses a market that serves nothing', async () => {
        installStrategy('test-strategy', () => undefined);
        const feed = fakeProvider([]);
        const runner = makeRunner(feed.provider, testBot());

        await expect(runner.start()).rejects.toThrow(/served no bars/);
    });
});

describe('the feed', () => {
    it('ignores old candles before marking or filling the account', async () => {
        installStrategy('test-strategy', (ctx) => {
            if (ctx.index === 9) ctx.buy({ size: 1, stopLoss: 95 });
        });
        const feed = fakeProvider(seedBars(10));
        const runner = makeRunner(feed.provider, testBot());
        await runner.start();
        feed.feed(bar(10 * MINUTE, 102));
        feed.feed(bar(11 * MINUTE, 103));
        expect(runner.openPositions()).toBe(1);
        const price = runner.price();
        feed.feed(bar(8 * MINUTE, 90));
        expect(runner.price()).toBe(price);
        expect(runner.openPositions()).toBe(1);
        runner.stop();
    });

    it('reserves a position slot for an unfilled entry', async () => {
        installStrategy('test-strategy', (ctx) => {
            ctx.order({ side: 'buy', type: 'limit', size: 1, limitPrice: 90 });
        });
        const feed = fakeProvider(seedBars(10));
        const runner = makeRunner(feed.provider, testBot());
        await runner.start();
        feed.feed(bar(10 * MINUTE, 102));
        feed.feed(bar(11 * MINUTE, 103));
        expect(runner.restingOrders()).toBe(1);
        runner.stop();
    });

    it('calls the strategy once, when a bar has closed', async () => {
        installStrategy('test-strategy', (ctx) => {
            calls.push({ index: ctx.index, close: ctx.bar.close, state: ctx.state });
        });
        const feed = fakeProvider(seedBars(10));
        const runner = makeRunner(feed.provider, testBot());
        await runner.start();

        // The bar that was forming at seed time, updated twice: still forming, so nothing.
        feed.feed(bar(9 * MINUTE, 101.0));
        feed.feed(bar(9 * MINUTE, 101.4));
        expect(calls).toHaveLength(0);

        // A new bar opens — the one before it has closed, at the last price it was seen at.
        feed.feed(bar(10 * MINUTE, 102));
        expect(calls).toHaveLength(1);
        expect(calls[0]!.close).toBe(101.4);
        expect(calls[0]!.index).toBe(9);
        expect(runner.barCount).toBe(10);

        runner.stop();
    });

    it('does not run a bar twice when the feed re-sends one', async () => {
        installStrategy('test-strategy', (ctx) => {
            calls.push({ index: ctx.index, close: ctx.bar.close, state: ctx.state });
        });
        const feed = fakeProvider(seedBars(10));
        const runner = makeRunner(feed.provider, testBot());
        await runner.start();

        feed.feed(bar(10 * MINUTE, 102));
        expect(calls).toHaveLength(1);

        // A reconnect replays the last bar. A strategy that places one order per session
        // would place two if this got through.
        feed.feed(bar(9 * MINUTE, 101.4));
        feed.feed(bar(10 * MINUTE, 102.1));
        expect(calls).toHaveLength(1);

        runner.stop();
    });

    it('keeps the strategy\'s own state across the rebuild every bar costs', async () => {
        installStrategy('test-strategy', (ctx) => {
            const seen = (ctx.state.seen as number | undefined) ?? 0;
            ctx.state.seen = seen + 1;
            calls.push({ index: ctx.index, close: ctx.bar.close, state: ctx.state });
        });
        const feed = fakeProvider(seedBars(10));
        const runner = makeRunner(feed.provider, testBot());
        await runner.start();

        feed.feed(bar(10 * MINUTE, 102));
        feed.feed(bar(11 * MINUTE, 103));
        feed.feed(bar(12 * MINUTE, 104));

        expect(calls).toHaveLength(3);
        expect(calls[2]!.state.seen).toBe(3);
        runner.stop();
    });

    it('gives the strategy an index that keeps growing, so a stored one still means its bar', async () => {
        installStrategy('test-strategy', (ctx) => {
            calls.push({ index: ctx.index, close: ctx.bar.close, state: ctx.state });
        });
        const feed = fakeProvider(seedBars(10));
        const runner = makeRunner(feed.provider, testBot());
        await runner.start();

        feed.feed(bar(10 * MINUTE, 102));
        feed.feed(bar(11 * MINUTE, 103));

        expect(calls.map((c) => c.index)).toEqual([9, 10]);
        runner.stop();
    });
});

describe('trading', () => {
    it('prices and records a ProjectX futures paper order in the bot account', async () => {
        const saved: Array<{ symbol: string; session?: { broker: { pointValue: number; sizeStep: number; fills: unknown[]; trades: unknown[] } } }> = [];
        const bridge = (globalThis as { window: { midori: { bots: { account: {
            load: (id: string) => Promise<unknown>;
            save: (id: string, data: unknown) => Promise<{ savedAt: number }>;
        } } } } }).window;
        bridge.midori.bots.account.save = (_id, data) => {
            saved.push(data as typeof saved[number]);
            return Promise.resolve({ savedAt: Date.now() });
        };
        installStrategy('test-strategy', (ctx) => {
            if (ctx.index === 9) ctx.order({ side: 'buy', type: 'market', size: 4.5 });
        });
        const feed = fakeProvider(seedBars(10));
        feed.provider.getSymbolInfo = () => Promise.resolve({
            ticker: 'MNQ',
            dealing: { contractId: 'contract-mnq', tickSize: 0.25, tickValue: 0.5, sizeStep: 1, minSize: 1 },
        });
        const runner = new BotRunner({ bot: testBot({ symbol: 'projectx:MNQ' }), providers: { projectx: () => feed.provider } });
        await runner.start();

        feed.feed(bar(10 * MINUTE, 102));
        expect(runner.paperController?.broker.pointValue).toBe(2);
        expect(runner.paperController?.broker.orders[0]?.size).toBe(2);
        feed.feed(bar(11 * MINUTE, 103));
        expect(runner.paperController?.broker.positions[0]?.size).toBe(2);
        expect(runner.todaysTrades).toBe(1);
        expect(runner.log.list().some((entry) => /Buy 2\.0000 filled/.test(entry.text))).toBe(true);
        feed.feed(bar(12 * MINUTE, 104));
        runner.flatten('test close');
        expect(runner.paperController?.broker.trades).toHaveLength(1);

        await runner.settle();
        const latest = saved[saved.length - 1];
        expect(latest?.symbol).toBe('projectx:MNQ');
        expect(latest?.session?.broker.pointValue).toBe(2);
        expect(latest?.session?.broker.sizeStep).toBe(1);
        expect(latest?.session?.broker.fills.length).toBeGreaterThan(0);
        expect(latest?.session?.broker.trades).toHaveLength(1);
        runner.stop();

        bridge.midori.bots.account.load = () => Promise.resolve(saved[saved.length - 1]);
        const restoredFeed = fakeProvider(seedBars(10));
        restoredFeed.provider.getSymbolInfo = feed.provider.getSymbolInfo;
        const restored = new BotRunner({
            bot: testBot({ symbol: 'projectx:MNQ' }),
            providers: { projectx: () => restoredFeed.provider },
        });
        await restored.start();
        expect(restored.paperController?.broker.pointValue).toBe(2);
        expect(restored.paperController?.broker.trades).toHaveLength(1);
        restored.stop();
    });

    it('refuses a ProjectX paper bot when contract value is unavailable', async () => {
        installStrategy('test-strategy', () => undefined);
        const feed = fakeProvider(seedBars(10));
        feed.provider.getSymbolInfo = () => Promise.resolve(undefined);
        const runner = new BotRunner({ bot: testBot({ symbol: 'projectx:MNQ' }), providers: { projectx: () => feed.provider } });

        await expect(runner.start()).rejects.toThrow(/contract value and size rules/);
        expect(feed.subscribed).toBe(false);
    });

    it('uses another broker’s size rules for a paper bot without sending a live order', async () => {
        installStrategy('test-strategy', (ctx) => {
            if (ctx.index === 9) ctx.order({ side: 'buy', type: 'market', size: 1.14 });
        });
        const feed = fakeProvider(seedBars(10));
        feed.provider.getSymbolInfo = () => Promise.resolve({
            ticker: 'US100',
            dealing: { sizeIncrement: 0.1, minSize: 0.2 },
        });
        const runner = new BotRunner({
            bot: testBot({ symbol: 'capital:US100', venue: 'paper' }),
            providers: { capital: () => feed.provider },
        });
        await runner.start();

        feed.feed(bar(10 * MINUTE, 102));
        expect(runner.paperController?.broker.orders[0]?.size).toBeCloseTo(1.1);
        expect(runner.capitalController).toBeNull();
        runner.stop();
    });

    it('refuses an entry too small for one futures contract', async () => {
        installStrategy('test-strategy', (ctx) => {
            if (ctx.index === 9) ctx.order({ side: 'buy', type: 'market', size: 1 });
        });
        const feed = fakeProvider(seedBars(10));
        feed.provider.getSymbolInfo = () => Promise.resolve({
            ticker: 'MNQ',
            dealing: { contractId: 'contract-mnq', tickSize: 0.25, tickValue: 0.5, sizeStep: 1, minSize: 1 },
        });
        const runner = new BotRunner({ bot: testBot({ symbol: 'projectx:MNQ' }), providers: { projectx: () => feed.provider } });
        await runner.start();

        feed.feed(bar(10 * MINUTE, 102));

        expect(runner.paperController?.broker.orders).toHaveLength(0);
        expect(runner.log.list().some((entry) => entry.kind === 'refused' && /minimum order size/.test(entry.text))).toBe(true);
        runner.stop();
    });

    it('sends the strategy\'s order to the bot\'s own paper account', async () => {
        installStrategy('test-strategy', (ctx) => {
            if (ctx.index === 9) ctx.order({ side: 'buy', type: 'stop', size: 1, stopPrice: 105 });
        });
        const feed = fakeProvider(seedBars(10));
        const runner = makeRunner(feed.provider, testBot());
        await runner.start();

        feed.feed(bar(10 * MINUTE, 102));

        expect(runner.restingOrders()).toBe(1);
        expect(runner.paperController?.broker.pending[0]?.stopPrice).toBe(105);
        // The bot's account, not the Chart tab's: it opens on the bot's own balance.
        expect(runner.paperController?.broker.initialBalance).toBe(10_000);
        runner.stop();
    });

    it('records what it placed on its own tape', async () => {
        installStrategy('test-strategy', (ctx) => {
            if (ctx.index === 9) ctx.order({ side: 'buy', type: 'stop', size: 1, stopPrice: 105 });
        });
        const feed = fakeProvider(seedBars(10));
        const runner = makeRunner(feed.provider, testBot());
        await runner.start();

        feed.feed(bar(10 * MINUTE, 102));

        expect(runner.log.list().some((e) => e.kind === 'order' && e.text.includes('105'))).toBe(true);
        runner.stop();
    });
});

describe('the guards', () => {
    it('turn an entry away and say which guard it was', async () => {
        installStrategy('test-strategy', (ctx) => {
            ctx.order({ side: 'buy', type: 'stop', size: 1, stopPrice: 105 });
        });
        const feed = fakeProvider(seedBars(10));
        // A window that is shut at 14:00 UTC.
        const runner = makeRunner(feed.provider, testBot({
            guards: { sessionStart: 9 * 60, sessionEnd: 10 * 60 },
        }));
        await runner.start();

        feed.feed(bar(10 * MINUTE, 102));

        expect(runner.restingOrders()).toBe(0);
        const refused = runner.log.list().find((e) => e.kind === 'refused');
        expect(refused?.text).toMatch(/trading window/);
        runner.stop();
    });

    it('never stop a strategy running — only its entries', async () => {
        // The rule this whole design turns on: a strategy holding a position has work to do
        // on every bar, and a guard that stopped `onBar` would strand exactly the position
        // the guards exist to protect.
        installStrategy('test-strategy', (ctx) => {
            calls.push({ index: ctx.index, close: ctx.bar.close, state: ctx.state });
        });
        const feed = fakeProvider(seedBars(10));
        const runner = makeRunner(feed.provider, testBot({
            guards: { sessionStart: 9 * 60, sessionEnd: 10 * 60 },
        }));
        await runner.start();

        feed.feed(bar(10 * MINUTE, 102));
        feed.feed(bar(11 * MINUTE, 103));

        expect(calls).toHaveLength(2);
        runner.stop();
    });

    it('report what would be refused right now, without anything having to ask for a trade', async () => {
        installStrategy('test-strategy', () => undefined);
        const feed = fakeProvider(seedBars(10));
        const runner = makeRunner(feed.provider, testBot({
            guards: { sessionStart: 9 * 60, sessionEnd: 10 * 60 },
        }));
        await runner.start();

        expect(runner.refusal()).toMatch(/trading window/);
        expect(runner.inWindow()).toBe(false);
        runner.stop();
    });

    it('are silent when nothing is wrong', async () => {
        installStrategy('test-strategy', () => undefined);
        const feed = fakeProvider(seedBars(10));
        const runner = makeRunner(feed.provider, testBot());
        await runner.start();
        feed.feed(bar(10 * MINUTE, 102));

        expect(runner.refusal()).toBeNull();
        runner.stop();
    });
});

describe('a strategy that fails', () => {
    it('is reported rather than silently doing nothing forever', async () => {
        installStrategy('test-strategy', () => { throw new Error('detector blew up'); });
        const feed = fakeProvider(seedBars(10));
        const runner = makeRunner(feed.provider, testBot());
        await runner.start();

        feed.feed(bar(10 * MINUTE, 102));

        expect(runner.log.list().some((e) => e.kind === 'error' && e.text.includes('detector blew up'))).toBe(true);
        // Still running: one bad bar is not a reason to stop watching the market.
        expect(runner.status).toBe('running');
        runner.stop();
    });
});

describe('strategy.init', () => {
    /** Installs a strategy with both hooks, the way the registry actually shapes one —
     *  `installStrategy` above only ever wires `onBar`. */
    function installWithInit(
        id: string,
        init: (ctx: BacktestContext) => void,
        onBar: (ctx: BacktestContext) => void = () => undefined,
    ): void {
        const spec: StrategySpec = {
            id,
            name: 'Test strategy',
            description: 'Only exists inside a test.',
            params: [],
            build: () => ({
                params: {}, init, onBar,
            } as unknown as ReturnType<StrategySpec['build']>),
        };
        STRATEGIES[id] = spec;
    }

    it('runs once, before the first onBar ever reads ctx.state', async () => {
        const seen: string[] = [];
        installWithInit(
            'test-strategy',
            (ctx) => { seen.push('init'); ctx.state.seeded = true; },
            (ctx) => { seen.push(`onBar:${String(ctx.state.seeded)}`); },
        );
        const feed = fakeProvider(seedBars(10));
        const runner = makeRunner(feed.provider, testBot());
        await runner.start();

        feed.feed(bar(10 * MINUTE, 102));
        feed.feed(bar(11 * MINUTE, 103));

        // init before the very first onBar, and never again on the second bar.
        expect(seen).toEqual(['init', 'onBar:true', 'onBar:true']);
        runner.stop();
    });

    it('reports a failing init once rather than retrying it every bar', async () => {
        let calls_ = 0;
        installWithInit('test-strategy', () => { calls_ += 1; throw new Error('init blew up'); });
        const feed = fakeProvider(seedBars(10));
        const runner = makeRunner(feed.provider, testBot());
        await runner.start();

        feed.feed(bar(10 * MINUTE, 102));
        feed.feed(bar(11 * MINUTE, 103));

        expect(calls_).toBe(1);
        expect(runner.log.list().some((e) => e.kind === 'error' && e.text.includes('init blew up'))).toBe(true);
        expect(runner.status).toBe('failed');
        runner.stop();
    });

    it('runs again after a stop and restart', async () => {
        let calls_ = 0;
        installWithInit('test-strategy', () => { calls_ += 1; });
        const feed = fakeProvider(seedBars(10));
        const runner = makeRunner(feed.provider, testBot());

        await runner.start();
        feed.feed(bar(10 * MINUTE, 102));
        expect(calls_).toBe(1);
        runner.stop();

        await runner.start();
        // Two intervals past the seeded bar: the runner first asks the market what lies between.
        feed.feed(bar(11 * MINUTE, 103));
        await vi.waitFor(() => expect(calls_).toBe(2));
        runner.stop();
    });
});

describe('the history window', () => {
    /** Start a runner already seeded to the brim, then feed it `extra` more closed bars. */
    async function runTo(extra: number, onBar: (ctx: BacktestContext) => void): Promise<BotRunner> {
        installStrategy('test-strategy', onBar);
        // One more than the window, so the seed (which drops the forming bar) lands exactly on it.
        const feed = fakeProvider(seedBars(HISTORY_BARS + 1));
        const runner = makeRunner(feed.provider, testBot());
        await runner.start();
        for (let i = 0; i < extra; i += 1) {
            feed.feed(bar((HISTORY_BARS + i) * MINUTE, 100 + i));
        }
        return runner;
    }

    it('trims back to the window once the strategy is holding nothing', async () => {
        const runner = await runTo(5, () => undefined);
        // Five bars past the window, and back at it: the rebuild cost stops growing here.
        expect(runner.barCount).toBe(HISTORY_BARS);
        runner.stop();
    });

    it('lets the history grow while the strategy is holding a bar index', async () => {
        // The shape every strategy in this app uses: one object in `state`, cleared when the
        // setup is done. While it is set, renumbering the bars under it would move the index
        // it is waiting for.
        const runner = await runTo(5, (ctx) => { ctx.state.session = { flatIndex: ctx.index + 500 }; });
        expect(runner.barCount).toBeGreaterThan(HISTORY_BARS);
        runner.stop();
    });

    it('trims as soon as the strategy lets go', async () => {
        let hold = true;
        installStrategy('test-strategy', (ctx) => { ctx.state.session = hold ? { flatIndex: 1 } : undefined; });
        const feed = fakeProvider(seedBars(HISTORY_BARS + 1));
        const runner = makeRunner(feed.provider, testBot());
        await runner.start();

        for (let i = 0; i < 5; i += 1) feed.feed(bar((HISTORY_BARS + i) * MINUTE, 100));
        expect(runner.barCount).toBeGreaterThan(HISTORY_BARS);

        hold = false;
        feed.feed(bar((HISTORY_BARS + 5) * MINUTE, 100));
        expect(runner.barCount).toBe(HISTORY_BARS);
        runner.stop();
    });

    it('lets the history grow while a position is open', async () => {
        const runner = await runTo(5, (ctx) => {
            if (ctx.index === HISTORY_BARS) ctx.buy({ size: 0.01 });
        });
        expect(runner.openPositions()).toBe(1);
        expect(runner.barCount).toBeGreaterThan(HISTORY_BARS);
        runner.stop();
    });

    it('lets the history grow while an order is resting', async () => {
        const runner = await runTo(5, (ctx) => {
            if (ctx.index === HISTORY_BARS) ctx.order({ side: 'buy', type: 'stop', size: 0.01, stopPrice: 1e9 });
        });
        expect(runner.restingOrders()).toBe(1);
        expect(runner.barCount).toBeGreaterThan(HISTORY_BARS);
        runner.stop();
    });

    it('cuts anyway at the hard limit, and says what it cost', async () => {
        // A strategy that never lets go. Without the backstop this one gets slower every day
        // until a bar close stalls the window.
        const runner = await runTo(MAX_HISTORY_BARS - HISTORY_BARS + 1, (ctx) => {
            ctx.state.session = { flatIndex: ctx.index + 10 };
        });
        expect(runner.barCount).toBe(HISTORY_BARS);
        const said = runner.log.list().find((e) => e.kind === 'error');
        expect(said?.text).toMatch(/state dropped with it/);
        runner.stop();
    }, 20_000);
});

describe('stopping', () => {
    it('closes the feed', async () => {
        installStrategy('test-strategy', () => undefined);
        const feed = fakeProvider(seedBars(10));
        const runner = makeRunner(feed.provider, testBot());
        await runner.start();

        runner.stop();

        expect(runner.status).toBe('stopped');
        expect(feed.unsubscribed).toBe(true);
    });

    it('does not close what the bot is holding, and says so', async () => {
        installStrategy('test-strategy', (ctx) => {
            if (ctx.index === 9) ctx.order({ side: 'buy', type: 'stop', size: 1, stopPrice: 105 });
        });
        const feed = fakeProvider(seedBars(10));
        const runner = makeRunner(feed.provider, testBot());
        await runner.start();
        feed.feed(bar(10 * MINUTE, 102));
        expect(runner.restingOrders()).toBe(1);

        runner.stop();

        // Stopping a bot stops it DECIDING. Liquidating on a button press would be the app
        // making a trading decision nobody asked it to make.
        expect(runner.paperController?.broker.pending).toHaveLength(1);
        expect(runner.log.last()?.text).toMatch(/nothing was closed/);
    });

    it('refuses an edit while it is running', async () => {
        installStrategy('test-strategy', () => undefined);
        const feed = fakeProvider(seedBars(10));
        const bot = testBot();
        const runner = makeRunner(feed.provider, bot);
        await runner.start();

        expect(() => runner.update({ ...bot, name: 'Renamed' })).toThrow(/Stop the bot/);
        runner.stop();
        expect(() => runner.update({ ...bot, name: 'Renamed' })).not.toThrow();
    });
});

describe('managed exits', () => {
    const entered = async (params: Record<string, unknown>) => {
        // One long on the first closed bar, two points of risk and a target far out of reach.
        installManaged('test-strategy', (ctx) => {
            if (ctx.index === 9) ctx.order({ side: 'buy', type: 'market', size: 1, bracket: { stopDistance: 2, targetDistance: 20 } });
        });
        const feed = fakeProvider(seedBars(10));
        const runner = makeRunner(feed.provider, testBot({ params }));
        await runner.start();
        feed.feed(bar(10 * MINUTE, 102));
        const broker = runner.paperController!.broker;
        expect(broker.positions).toHaveLength(1);
        return { feed, runner, broker };
    };

    /** The bar that is forming, updated: `high`/`low` are what it has reached so far. */
    const update = (high: number, low: number, close: number): OHLCV => (
        { time: 10 * MINUTE, open: 102, high, low, close, volume: 100 }
    );

    it('hands the strategy\'s break-even and trail to the bot\'s own account', async () => {
        const { runner, broker } = await entered({ breakEvenAtR: 1, trailAtR: 2, trailR: 0.5 });

        expect(broker.management).toEqual({ breakEvenAtR: 1, trailAtR: 2, trailR: 0.5 });
        runner.stop();
    });

    it('moves the stop to break-even once the trade is 1R in front', async () => {
        const { feed, runner, broker } = await entered({ breakEvenAtR: 1 });
        const { entryPrice, riskPerUnit, stopLoss } = broker.positions[0]!;

        feed.feed(update(entryPrice + riskPerUnit! * 1.2, 101.9, entryPrice + riskPerUnit! * 1.1));

        const position = broker.positions[0]!;
        expect(position.breakEvenDone).toBe(true);
        expect(position.stopLoss!).toBeGreaterThan(stopLoss!);
        // Break-even is where the trade comes out flat — the entry, not somewhere behind it.
        expect(position.stopLoss!).toBeGreaterThanOrEqual(entryPrice);
        runner.stop();
    });

    it('closes a trade that falls back at about flat, not at the original stop', async () => {
        const { feed, runner, broker } = await entered({ breakEvenAtR: 1 });
        const { entryPrice, riskPerUnit } = broker.positions[0]!;
        const top = entryPrice + riskPerUnit! * 1.2;

        feed.feed(update(top, 101.9, top - 0.2));
        // Back through the entry, but nowhere near the original stop two points below it.
        feed.feed(update(top, entryPrice - 1, entryPrice - 0.8));

        const trades = broker.trades as Array<{ netPnl: number }>;
        expect(trades).toHaveLength(1);
        // A full loss on this trade would be 2. This is what is left of it after costs.
        expect(Math.abs(trades[0]!.netPnl)).toBeLessThan(0.5);
        runner.stop();
    });

    it('leaves the stop where it was when break-even is off', async () => {
        // The control for the three above: the same trade, the same prices, no rule.
        const { feed, runner, broker } = await entered({ breakEvenAtR: 0 });
        const { entryPrice, riskPerUnit, stopLoss } = broker.positions[0]!;
        const top = entryPrice + riskPerUnit! * 1.2;

        expect(broker.management).toBeNull();
        feed.feed(update(top, 101.9, top - 0.2));
        feed.feed(update(top, entryPrice - 1, entryPrice - 0.8));

        expect(broker.positions).toHaveLength(1);
        expect(broker.positions[0]!.stopLoss).toBe(stopLoss);
        expect(broker.trades).toHaveLength(0);
        runner.stop();
    });

    it('says so in the log when it moves a stop', async () => {
        const { feed, runner, broker } = await entered({ breakEvenAtR: 1 });
        const { entryPrice, riskPerUnit } = broker.positions[0]!;

        feed.feed(update(entryPrice + riskPerUnit! * 1.2, 101.9, entryPrice + riskPerUnit! * 1.1));

        expect(runner.log.list().some((e) => e.kind === 'info' && /break-even/i.test(e.text))).toBe(true);
        runner.stop();
    });
});

describe('a paper bot', () => {
    /** Every call into a venue's bridge, recorded and refused. Recorded rather than only
     *  thrown: the runner catches what an account throws, and a test that relied on an
     *  exception surfacing would pass on the very failure it exists to catch. */
    function sealedVenues() {
        const touched: string[] = [];
        const venue = (name: string) => new Proxy({}, {
            get: (_target, prop) => (): Promise<never> => {
                touched.push(`${name}.${String(prop)}`);
                return Promise.reject(new Error(`${name}.${String(prop)} must not be reached from here`));
            },
        });
        const midori = (globalThis as { window?: { midori: Record<string, unknown> } }).window!.midori;
        for (const name of ['capital', 'projectx', 'bybit', 'binanceSpot']) midori[name] = venue(name);
        return touched;
    }

    it('trades, closes and stops without ever reaching a venue', async () => {
        const touched = sealedVenues();
        installStrategy('test-strategy', (ctx) => {
            if (ctx.index === 9) ctx.order({ side: 'buy', type: 'market', size: 1, bracket: { stopDistance: 2, targetDistance: 20 } });
        });
        const feed = fakeProvider(seedBars(10));
        const runner = makeRunner(feed.provider, testBot({ venue: 'paper' }));
        await runner.start();

        feed.feed(bar(10 * MINUTE, 102));
        expect(runner.openPositions()).toBe(1);
        runner.flatten('test');
        expect(runner.openPositions()).toBe(0);
        runner.stop();
        await runner.settle();

        expect(touched).toEqual([]);
        expect(runner.paperController).not.toBeNull();
        expect(runner.capitalController).toBeNull();
    });

    it('is only proven sealed if the detector can see a venue being reached', async () => {
        // The control for the test above: a Capital.com bot reaches the bridge straight away.
        const touched = sealedVenues();
        installStrategy('test-strategy', () => undefined);
        const feed = fakeProvider(seedBars(10));
        // Served under its own provider name, or the start fails on that before it gets as
        // far as an account — and the detector would be shown nothing to detect.
        const runner = new BotRunner({
            bot: testBot({ venue: 'capital', symbol: 'capital:TEST' }),
            providers: { capital: () => feed.provider },
        });

        await expect(runner.start()).rejects.toThrow();

        expect(touched).toContain('capital.environment');
    });
});


describe('feed integrity', () => {
    it('refuses invalid OHLC updates before marking an account or running a strategy', async () => {
        const decide = vi.fn();
        installStrategy('test-strategy', decide);
        const feed = fakeProvider(seedBars(10));
        const runner = makeRunner(feed.provider, testBot());
        await runner.start();
        const price = runner.price();
        feed.feed({ ...bar(10 * MINUTE, 100), close: NaN });
        expect(runner.price()).toBe(price);
        expect(runner.lastTick).toBeNull();
        feed.feed({ ...bar(10 * MINUTE, 100), high: 80 });
        expect(decide).not.toHaveBeenCalled();
        runner.stop();
    });

    it('refuses a bar interval the provider does not support before building an account', async () => {
        installStrategy('test-strategy', () => undefined);
        const feed = fakeProvider(seedBars(10));
        feed.provider.info = () => ({ name: 'Test', capabilities: { enumerate: false, stream: true, symbolInfo: false }, supportedTimeframes: ['5'] });
        const runner = makeRunner(feed.provider, testBot());
        await expect(runner.start()).rejects.toThrow(/does not support/);
        expect(feed.subscribed).toBe(false);
    });
});


describe('replayed feed timestamps', () => {
    it('blocks entries on old candles even when they have just arrived', async () => {
        installStrategy('test-strategy', (ctx) => { ctx.buy({ size: 1 }); });
        const feed = fakeProvider(seedBars(10));
        const runner = makeRunner(feed.provider, testBot());
        await runner.start();
        vi.setSystemTime(Date.now() + 10 * MINUTE);
        feed.feed(bar(10 * MINUTE, 102));
        expect(runner.lastTick).toBe(Date.now());
        expect(runner.openPositions()).toBe(0);
        expect(runner.refusal()).toMatch(/candle.*old/i);
        runner.stop();
    });
});


describe('history reload integrity', () => {
    it('preserves the running history and mark when a reload returns only one candle', async () => {
        installStrategy('test-strategy', () => undefined);
        const feed = fakeProvider(seedBars(10));
        const runner = makeRunner(feed.provider, testBot());
        await runner.start();
        const count = runner.barCount;
        const price = runner.price();
        feed.provider.getBars = () => Promise.resolve([bar(Date.now(), 999)]);
        expect(await runner.reseed()).toBe(false);
        expect(runner.barCount).toBe(count);
        expect(runner.price()).toBe(price);
        feed.feed(bar(10 * MINUTE, 101));
        expect(runner.barCount).toBe(count + 1);
        runner.stop();
    });

    it('ignores a reload rejection delivered after Stop', async () => {
        installStrategy('test-strategy', () => undefined);
        const feed = fakeProvider(seedBars(10));
        const runner = makeRunner(feed.provider, testBot());
        await runner.start();
        let rejectHistory!: (error: Error) => void;
        feed.provider.getBars = () => new Promise((_resolve, reject) => { rejectHistory = reject; });
        const reloading = runner.reseed();
        runner.stop();
        const count = runner.barCount;
        rejectHistory(new Error('late history failure'));
        expect(await reloading).toBe(false);
        expect(runner.barCount).toBe(count);
        expect(runner.log.list().some(entry => entry.text.includes('late history failure'))).toBe(false);
    });

    it('refuses a reload with an active detector before asking for history', async () => {
        installStrategy('test-strategy', ctx => { ctx.state.setup = { index: ctx.index }; });
        const feed = fakeProvider(seedBars(10));
        const runner = makeRunner(feed.provider, testBot());
        await runner.start();
        feed.feed(bar(10 * MINUTE, 101));
        const load = vi.fn();
        feed.provider.getBars = load;
        expect(await runner.reseed()).toBe(false);
        expect(load).not.toHaveBeenCalled();
        runner.stop();
    });

    it('pauses decisions during reload and applies only a current lifetime', async () => {
        const decide = vi.fn();
        installStrategy('test-strategy', decide);
        const feed = fakeProvider(seedBars(10));
        const runner = makeRunner(feed.provider, testBot());
        await runner.start();
        let releaseHistory!: (bars: OHLCV[]) => void;
        feed.provider.getBars = () => new Promise(resolve => { releaseHistory = resolve; });
        const reloading = runner.reseed();
        feed.feed(bar(10 * MINUTE, 101));
        expect(decide).not.toHaveBeenCalled();
        runner.stop();
        const count = runner.barCount;
        const price = runner.price();
        releaseHistory(seedBars(25));
        expect(await reloading).toBe(false);
        expect(runner.barCount).toBe(count);
        expect(runner.price()).toBe(price);
    });
});

describe('a gap in the feed', () => {
    /** Real timestamps, so the provider's history and the fed bars share one clock. */
    function stretch(firstBarAt: number, count: number, close = 100): OHLCV[] {
        return Array.from({ length: count }, (_, i) => bar(firstBarAt + i * MINUTE, close));
    }

    /** A running bot whose strategy buys whenever it is flat and `armed` is set. */
    async function running() {
        const seen: number[] = [];
        const control = { armed: false };
        installStrategy('test-strategy', (ctx) => {
            seen.push(ctx.time);
            if (control.armed && ctx.isFlat) ctx.buy({ size: 1 });
        });
        const firstBarAt = Date.now() - 10 * MINUTE;
        const feed = fakeProvider(stretch(firstBarAt, 10));
        const runner = makeRunner(feed.provider, testBot());
        await runner.start();
        // One update of the bar forming now: bar 9 closes, bar 10 forms.
        feed.feed(bar(firstBarAt + 10 * MINUTE, 100));
        return { runner, feed, seen, control, firstBarAt };
    }

    it('loads the bars it missed and opens nothing on them', async () => {
        const { runner, feed, seen, control, firstBarAt } = await running();
        control.armed = true;
        vi.setSystemTime(Date.now() + 30 * MINUTE);
        const asked = vi.fn((_ticker: string, _tf: string, _range: { limit?: number }) => (
            Promise.resolve(stretch(firstBarAt, 41, 110))
        ));
        feed.provider.getBars = asked as DataProvider['getBars'];

        feed.feed(bar(firstBarAt + 40 * MINUTE, 110));
        await vi.waitFor(() => expect(runner.barCount).toBe(40));

        // Every missed bar reached the strategy, in order, and none of them opened a trade.
        expect(seen.slice(1)).toEqual(Array.from({ length: 30 }, (_, i) => firstBarAt + (10 + i) * MINUTE));
        expect(runner.openPositions()).toBe(0);
        expect(runner.log.list().some((entry) => entry.kind === 'refused' && /feed gap/i.test(entry.text))).toBe(true);
        // Only the missing stretch is asked for, not the whole window again.
        expect(asked.mock.calls[0]![2].limit).toBeLessThan(100);

        // The next bar closes on time, and the bot trades again.
        vi.setSystemTime(Date.now() + MINUTE);
        feed.feed(bar(firstBarAt + 41 * MINUTE, 110));
        expect(runner.openPositions()).toBe(1);
        runner.stop();
    });

    it('treats a market that was simply shut as an ordinary close, on the bar as it ended', async () => {
        const { runner, feed, seen, control, firstBarAt } = await running();
        control.armed = true;
        vi.setSystemTime(Date.now() + 30 * MINUTE);
        // Nothing traded in between: the history holds no bar the bot has not seen, and it
        // states where the last one really ended.
        feed.provider.getBars = () => Promise.resolve([
            ...stretch(firstBarAt, 10),
            bar(firstBarAt + 10 * MINUTE, 105),
            bar(firstBarAt + 40 * MINUTE, 110),
        ]);

        feed.feed(bar(firstBarAt + 40 * MINUTE, 110));
        await vi.waitFor(() => expect(runner.barCount).toBe(11));

        expect(seen[seen.length - 1]).toBe(firstBarAt + 10 * MINUTE);
        expect(runner.openPositions()).toBe(1);
        runner.stop();
    });

    it('decides nothing while the missing bars cannot be loaded, then recovers', async () => {
        const { runner, feed, seen, control, firstBarAt } = await running();
        control.armed = true;
        vi.setSystemTime(Date.now() + 30 * MINUTE);
        feed.provider.getBars = () => Promise.reject(new Error('history offline'));

        feed.feed(bar(firstBarAt + 40 * MINUTE, 110));
        await vi.waitFor(() => expect(runner.log.last()?.text).toMatch(/history offline/));
        expect(seen).toHaveLength(1);
        expect(runner.openPositions()).toBe(0);
        expect(runner.barCount).toBe(10);

        feed.provider.getBars = () => Promise.resolve(stretch(firstBarAt, 41, 110));
        await vi.advanceTimersByTimeAsync(6_000);
        feed.feed(bar(firstBarAt + 40 * MINUTE, 110));
        await vi.waitFor(() => expect(runner.barCount).toBe(40));
        expect(runner.openPositions()).toBe(0);
        runner.stop();
    });

    it('blocks new entries when the history no longer reaches back to what it has', async () => {
        const { runner, feed, seen, control, firstBarAt } = await running();
        control.armed = true;
        vi.setSystemTime(Date.now() + 30 * MINUTE);
        feed.provider.getBars = () => Promise.resolve(stretch(firstBarAt + 35 * MINUTE, 6, 110));

        feed.feed(bar(firstBarAt + 40 * MINUTE, 110));
        await vi.waitFor(() => expect(runner.refusal()).toMatch(/gap/i));
        expect(seen).toHaveLength(1);
        expect(runner.openPositions()).toBe(0);
        runner.stop();
    });
});

describe('running unattended', () => {
    it('lets the history trim under the VWAP reversion strategy while it holds nothing', async () => {
        const start = Date.now() - HISTORY_BARS * MINUTE;
        const at = (i: number): OHLCV => bar(start + i * MINUTE, 100 + Math.sin(i / 30));
        const feed = fakeProvider(Array.from({ length: HISTORY_BARS + 1 }, (_, i) => at(i)));
        const runner = makeRunner(feed.provider, testBot({ strategy: 'vwapreversion' }));
        await runner.start();
        for (let i = 1; i <= 6; i += 1) {
            vi.setSystemTime(start + (HISTORY_BARS + i) * MINUTE);
            feed.feed(at(HISTORY_BARS + i));
        }
        expect(runner.openPositions()).toBe(0);
        expect(runner.restingOrders()).toBe(0);
        expect(runner.barCount).toBe(HISTORY_BARS);
        runner.stop();
    });

    it('says so while the strategy cannot be built, and stops saying it once it can', async () => {
        let broken = true;
        STRATEGIES['test-strategy'] = {
            id: 'test-strategy',
            name: 'Test strategy',
            description: 'Only exists inside a test.',
            params: [],
            build: () => {
                if (broken) throw new Error('no volume');
                return { params: {}, onBar: () => undefined };
            },
        } as unknown as StrategySpec;
        const feed = fakeProvider(seedBars(10));
        const runner = makeRunner(feed.provider, testBot());
        await runner.start();

        feed.feed(bar(10 * MINUTE, 101));
        expect(runner.refusal()).toMatch(/could not be built: no volume/);

        broken = false;
        vi.setSystemTime(Date.now() + MINUTE);
        feed.feed(bar(11 * MINUTE, 101));
        expect(runner.refusal()).toBeNull();
        runner.stop();
    });

    it('reopens a feed that has gone quiet', async () => {
        installStrategy('test-strategy', () => undefined);
        const feed = fakeProvider(seedBars(10));
        const subscribe = feed.provider.subscribe!;
        let subscriptions = 0;
        feed.provider.subscribe = (...args) => {
            subscriptions += 1;
            return subscribe(...args);
        };
        const runner = makeRunner(feed.provider, testBot());
        await runner.start();
        feed.feed(bar(10 * MINUTE, 101));
        expect(subscriptions).toBe(1);

        // Past the default 120 seconds of silence.
        await vi.advanceTimersByTimeAsync(130_000);

        expect(subscriptions).toBe(2);
        expect(runner.log.list().some((entry) => /feed was quiet and has been reopened/.test(entry.text))).toBe(true);
        // The reopened feed is the one the runner listens to.
        vi.setSystemTime(Date.now() + MINUTE);
        feed.feed(bar(11 * MINUTE, 102));
        expect(runner.lastTick).toBe(Date.now());
        runner.stop();
    });

    it('names a non-minute bar interval as it is, without a minutes suffix', async () => {
        installStrategy('test-strategy', () => undefined);
        const runner = makeRunner(fakeProvider(seedBars(10)).provider, testBot({ timeframe: 'D' }));
        await runner.start();
        expect(runner.log.list().some((entry) => /Started on fake:TEST D,/.test(entry.text))).toBe(true);
        runner.stop();
    });
});

describe('the daily loss limit', () => {
    /** A paper bot long 10 at 100 on a 10,000 account, then marked at `price`. */
    async function longThenMarkedAt(price: number, guards: Record<string, unknown>) {
        installStrategy('test-strategy', (ctx) => { if (ctx.isFlat && ctx.index === 9) ctx.buy({ size: 10 }); });
        const firstBarAt = Date.now() - 10 * MINUTE;
        const at = (i: number, close: number): OHLCV => bar(firstBarAt + i * MINUTE, close);
        const feed = fakeProvider(Array.from({ length: 10 }, (_, i) => at(i, 100)));
        const runner = makeRunner(feed.provider, testBot({ guards }));
        await runner.start();
        feed.feed(at(10, 100));
        expect(runner.openPositions()).toBe(1);
        // Down 150 on 10,000: past a 1% limit.
        feed.feed(at(10, price));
        await vi.advanceTimersByTimeAsync(6_000);
        return runner;
    }

    it('closes what is open when it is set to', async () => {
        const runner = await longThenMarkedAt(85, { dailyLossLimit: 1, flattenAtDailyLoss: true });
        expect(runner.openPositions()).toBe(0);
        expect(runner.log.list().some((entry) => /Flat: the daily loss limit was reached/.test(entry.text))).toBe(true);
        runner.stop();
    });

    it('only stops new trades when it is not', async () => {
        const runner = await longThenMarkedAt(85, { dailyLossLimit: 1, maxOpenPositions: 2 });
        expect(runner.openPositions()).toBe(1);
        expect(runner.refusal()).toMatch(/on the day/);
        runner.stop();
    });

    it('leaves a position alone while the loss is inside the limit', async () => {
        const runner = await longThenMarkedAt(99.5, { dailyLossLimit: 1, flattenAtDailyLoss: true });
        expect(runner.openPositions()).toBe(1);
        runner.stop();
    });
});

describe('an account that could not be saved', () => {
    it('blocks new entries only until a later write lands', async () => {
        installStrategy('test-strategy', () => undefined);
        let failing = false;
        const bridge = (globalThis as unknown as { window: { midori: { bots: { account: { save: () => Promise<unknown> } } } } }).window;
        bridge.midori.bots.account.save = () => (failing ? Promise.reject(new Error('disk full')) : Promise.resolve({ savedAt: 1 }));
        const feed = fakeProvider(seedBars(10));
        const runner = makeRunner(feed.provider, testBot());
        await runner.start();

        failing = true;
        feed.feed(bar(10 * MINUTE, 101));
        await vi.advanceTimersByTimeAsync(1_500);
        expect(runner.refusal()).toMatch(/could not be saved/);

        failing = false;
        vi.setSystemTime(Date.now() + MINUTE);
        feed.feed(bar(11 * MINUTE, 102));
        await vi.advanceTimersByTimeAsync(1_500);
        expect(runner.refusal()).toBeNull();
        runner.stop();
    });
});
