// A bot's account has to outlive the bot's runner. The rules under test: a paper bot picks
// its account back up where it left off, an account is never thrown away without being filed
// as a run first, and a live bot writes every closed trade to the journal — the only record
// anywhere that it moved real money.
// See app/renderer/bot/BotRunner.ts and BotEngine.ts.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BotRunner } from '../app/renderer/bot/BotRunner';
import { BotEngine } from '../app/renderer/bot/BotEngine';
import { STRATEGIES } from '../app/renderer/strategies';
import type { StrategySpec } from '../app/renderer/strategies/types';
import type { DataProvider } from '../src/plugin';
import type { OHLCV } from '../src/core/model/ohlcv';
import type { BacktestContext } from '../shared/engine/backtest';
import { newBot, type BotConfig } from '../app/renderer/bot/botTypes';
import { resetAccountDays, saveAccountRisk } from '../app/renderer/bot/accountRisk';
import type { MidoriBotAccount, MidoriBotAccountSnapshot } from '../app/renderer/midori';

const MINUTE = 60_000;

function bar(time: number, close: number): OHLCV {
    return { time, open: close, high: close + 0.5, low: close - 0.5, close, volume: 100 };
}

function seedBars(count: number): OHLCV[] {
    return Array.from({ length: count }, (_, i) => bar(i * MINUTE, 100 + i * 0.1));
}

function fakeProvider(bars: OHLCV[]) {
    const offset = bars.length && bars[bars.length - 1]!.time < Date.UTC(2000, 0, 1)
        ? Date.now() - bars[bars.length - 1]!.time : 0;
    const atCurrentTime = (b: OHLCV): OHLCV => ({ ...b, time: b.time + offset });
    let push: ((bar: OHLCV) => void) | null = null;
    let unsubscribed = false;
    const provider: DataProvider = {
        getBars: () => Promise.resolve(bars.map(atCurrentTime)),
        subscribe: (_t, _tf, onBar) => {
            push = onBar;
            unsubscribed = false;
            return () => { push = null; unsubscribed = true; };
        },
    };
    return {
        provider,
        feed: (b: OHLCV) => push?.(atCurrentTime(b)),
        get subscribed() { return push != null; },
        get unsubscribed() { return unsubscribed; },
    };
}

function installStrategy(onBar: (ctx: BacktestContext) => void): void {
    STRATEGIES['test-strategy'] = {
        id: 'test-strategy',
        name: 'Test strategy',
        description: 'Only exists inside a test.',
        params: [],
        build: () => ({ params: {}, onBar: onBar as (ctx: unknown) => void }),
    } as unknown as StrategySpec;
}

function testBot(over: Partial<BotConfig> = {}): BotConfig {
    return { ...newBot('test-strategy', 'fake:TEST'), id: 'bot_test', timeframe: '1', balance: 10_000, ...over };
}

/** Replace part of the bridge, for the tests that need it to fail or to be slow. */
function stub(path: string, value: unknown): void {
    const parts = path.split('.');
    const last = parts.pop()!;
    let node = (globalThis as unknown as { window: { midori: Record<string, unknown> } }).window.midori;
    for (const part of parts) node = node[part] as Record<string, unknown>;
    node[last] = value;
}

/** The disk, as far as these tests are concerned. */
let accounts: Map<string, MidoriBotAccount>;
let storedBots: unknown[];
let filedRuns: Array<Record<string, unknown>>;
let journal: Array<Record<string, unknown>>;

beforeEach(() => {
    accounts = new Map();
    storedBots = [];
    filedRuns = [];
    journal = [];
    (globalThis as { window?: unknown }).window = {
        midori: {
            bots: {
                load: () => Promise.resolve(storedBots),
                save: (bots: unknown[]) => { storedBots = bots; return Promise.resolve({ savedAt: Date.now() }); },
        account: {
                    load: (id: string) => Promise.resolve(accounts.get(id) ?? null),
                    save: (id: string, account: MidoriBotAccountSnapshot) => {
                        accounts.set(id, { ...account, savedAt: Date.now() });
                        return Promise.resolve({ savedAt: Date.now() });
                    },
                    clear: (id: string) => { accounts.delete(id); return Promise.resolve(true); },
                    sweep: (keep: string[]) => {
                        let removed = 0;
                        for (const id of [...accounts.keys()]) {
                            if (!keep.includes(id)) { accounts.delete(id); removed += 1; }
                        }
                        return Promise.resolve({ removed });
                    },
                },
            },
            backtest: {
                save: (run: Record<string, unknown>) => {
                    filedRuns.push(run);
                    return Promise.resolve({ id: `run_${filedRuns.length}` });
                },
            },
            live: {
                append: (trade: Record<string, unknown>) => {
                    journal.push(trade);
                    return Promise.resolve({ added: true });
                },
            },
            capital: {
                preferences: () => Promise.resolve({ hedgingMode: true }),
                environment: () => Promise.resolve({ configured: true, env: 'demo', live: false }),
                account: () => Promise.resolve({ accountId: 'test-account', currency: 'USD', balance: { balance: 10_000, profitLoss: 0, available: 10_000 } }),
                positions: () => Promise.resolve([]),
                workingOrders: () => Promise.resolve([]),
                marketInfo: () => Promise.resolve({ instrument: { lotSize: 1, currency: 'USD' }, snapshot: { marketStatus: 'TRADEABLE', bid: 1.09, offer: 1.091 } }),
                openPosition: () => Promise.resolve({ accepted: true, dealId: 'position-1' }),
                amendPosition: () => Promise.resolve({ accepted: true, dealId: 'position-1' }),
                closePosition: () => Promise.resolve({ accepted: true, dealId: 'position-1' }),
                createOrder: () => Promise.resolve({ accepted: true, dealId: 'order-1' }),
                amendOrder: () => Promise.resolve({ accepted: true, dealId: 'order-1' }),
                cancelOrder: () => Promise.resolve({ accepted: true, dealId: 'order-1' }),
            },
        },
    };
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(Date.UTC(2026, 8, 9, 14, 0)));
});

afterEach(() => {
    vi.useRealTimers();
    delete STRATEGIES['test-strategy'];
    delete (globalThis as { window?: unknown }).window;
});

/** Run a bot far enough to book one closed round trip, then stop it. */
async function tradeAndStop(bot: BotConfig): Promise<BotRunner> {
    installStrategy((ctx) => {
        if (ctx.index === 9) ctx.buy({ size: 0.01 });
        if (ctx.index === 12 && !ctx.isFlat) ctx.close('test');
    });
    const firstBarAt = Date.now() - 10 * MINUTE;
    const feed = fakeProvider(Array.from({ length: 10 }, (_, i) => bar(firstBarAt + i * MINUTE, 100 + i * 0.1)));
    const runner = new BotRunner({ bot, providers: { fake: () => feed.provider } });
    await runner.start();
    for (let i = 10; i <= 14; i += 1) feed.feed(bar(firstBarAt + i * MINUTE, 100 + i));
    runner.stop();
    return runner;
}

describe('a bot keeps its account', () => {
    it('writes it to disk as it trades', async () => {
        const runner = await tradeAndStop(testBot());
        expect(runner.paperController!.broker.trades.length).toBeGreaterThan(0);
        // Flushed on the way out: the runner is about to be the last place it exists.
        await runner.settle();
        expect(accounts.has('bot_test')).toBe(true);
    });

    it('picks it back up on the next start, trades and all', async () => {
        const first = await tradeAndStop(testBot());
        const traded = first.paperController!.broker.trades.length;
        const worth = first.equity();
        await first.settle();
        first.dispose();

        // A second runner over the same bot — what an app restart is.
        installStrategy(() => undefined);
        const feed = fakeProvider(seedBars(10));
        const second = new BotRunner({ bot: testBot(), providers: { fake: () => feed.provider } });
        await second.start();

        expect(second.paperController!.broker.trades.length).toBe(traded);
        expect(second.equity()).toBeCloseTo(worth, 6);
        expect(second.log.list().some((e) => e.text.includes('Picked its account back up'))).toBe(true);
        second.stop();
    });

    it('starts fresh when there is nothing stored', async () => {
        installStrategy(() => undefined);
        const feed = fakeProvider(seedBars(10));
        const runner = new BotRunner({ bot: testBot(), providers: { fake: () => feed.provider } });
        await runner.start();

        expect(runner.paperController!.broker.trades).toHaveLength(0);
        expect(runner.paperController!.broker.initialBalance).toBe(10_000);
        runner.stop();
    });

    it('refuses to start on a stored account still holding another market', async () => {
        // Its positions belong to the market that made them. Moving them across would mark
        // one instrument's position against another's prices.
        installStrategy((ctx) => { if (ctx.index === 9) ctx.buy({ size: 0.01 }); });
        const feed = fakeProvider(seedBars(10));
        const first = new BotRunner({ bot: testBot(), providers: { fake: () => feed.provider } });
        await first.start();
        feed.feed(bar(10 * MINUTE, 101));
        feed.feed(bar(11 * MINUTE, 102));
        expect(first.openPositions()).toBe(1);
        first.stop();
        /* Waited on, because the next runner READS this account off disk. This is the whole
         * job of `settle` — see BotRunner. */
        await first.settle();
        first.dispose();

        const moved = new BotRunner({
            bot: testBot({ symbol: 'fake:OTHER' }),
            providers: { fake: () => fakeProvider(seedBars(10)).provider },
        });
        await expect(moved.start()).rejects.toThrow(/still holding a position on fake:TEST/);
    });
});

describe('a bot keeps its unattended guards', () => {
    it('keeps today\'s entry count across a stop and restart', async () => {
        const bot = testBot({ guards: { maxTradesPerDay: 1, staleFeedSeconds: 0 } });
        const first = await tradeAndStop(bot);
        await first.settle();
        first.dispose();

        expect(accounts.get(bot.id)?.guards?.tradesToday).toBe(1);

        installStrategy(() => undefined);
        const feed = fakeProvider(seedBars(10));
        const second = new BotRunner({ bot, providers: { fake: () => feed.provider } });
        await second.start();

        expect(second.todaysTrades).toBe(1);
        expect(second.refusal()).toMatch(/trades for today/i);
        second.stop();
        await second.settle();
    });

    it('resets the daily count after UTC midnight but keeps a cooldown that crosses it', async () => {
        installStrategy(() => undefined);
        const bot = testBot({ guards: { cooldownMinutes: 120, staleFeedSeconds: 0 } });
        const first = new BotRunner({
            bot,
            providers: { fake: () => fakeProvider(seedBars(10)).provider },
        });
        await first.start();
        first.stop();
        await first.settle();
        first.dispose();

        const now = Date.now();
        const stored = accounts.get(bot.id)!;
        accounts.set(bot.id, {
            ...stored,
            guards: {
                dayKey: '2026-09-08',
                dayOpenEquity: 11_000,
                tradesToday: 7,
                lastLossAt: now - 30 * MINUTE,
            },
        });

        const second = new BotRunner({
            bot,
            providers: { fake: () => fakeProvider(seedBars(10)).provider },
        });
        await second.start();
        expect(second.todaysTrades).toBe(0);
        expect(second.refusal()).toMatch(/cooling off after a loss/i);
        second.stop();
        await second.settle();

        expect(accounts.get(bot.id)?.guards).toMatchObject({
            dayKey: '2026-09-09',
            tradesToday: 0,
            lastLossAt: now - 30 * MINUTE,
        });
    });

    it('counts a resting entry when it fills, not when it is merely placed', async () => {
        installStrategy((ctx) => {
            if (ctx.index === 9) ctx.order({ side: 'buy', type: 'limit', size: 1, limitPrice: 95 });
        });
        const bot = testBot({ guards: { maxTradesPerDay: 1, maxOpenPositions: 2, staleFeedSeconds: 0 } });
        const firstBarAt = Date.now() - 10 * MINUTE;
        const feed = fakeProvider(Array.from({ length: 10 }, (_, i) => (
            bar(firstBarAt + i * MINUTE, 100 + i * 0.1)
        )));
        const runner = new BotRunner({ bot, providers: { fake: () => feed.provider } });
        await runner.start();

        feed.feed(bar(firstBarAt + 10 * MINUTE, 101));
        expect(runner.restingOrders()).toBe(1);
        expect(runner.todaysTrades).toBe(0);

        feed.feed({
            time: firstBarAt + 11 * MINUTE,
            open: 101,
            high: 102,
            low: 94,
            close: 96,
            volume: 100,
        });
        expect(runner.todaysTrades).toBe(1);
        expect(runner.refusal()).toMatch(/trades for today/i);
        runner.stop();
        await runner.settle();
    });

    it('refuses to start when its durable state cannot be read', async () => {
        installStrategy(() => undefined);
        const feed = fakeProvider(seedBars(10));
        stub('bots.account.load', () => Promise.reject(new Error('runtime JSON is corrupt')));
        const runner = new BotRunner({ bot: testBot(), providers: { fake: () => feed.provider } });

        await expect(runner.start()).rejects.toThrow(/runtime JSON is corrupt/);
        expect(runner.status).toBe('failed');
        expect(runner.barCount).toBe(0);
    });
});

describe('a live bot owns only its confirmed venue ids', () => {
    it('will not initialize ownership over pre-existing exposure on the same market', async () => {
        installStrategy(() => undefined);
        stub('capital.positions', () => Promise.resolve([{ market: { epic: 'EURUSD' } }]));
        const runner = new BotRunner({
            bot: testBot({ venue: 'capital', symbol: 'capital:EURUSD' }),
            providers: { capital: () => fakeProvider(seedBars(10)).provider },
        });

        await expect(runner.start()).rejects.toThrow(/cannot safely assign pre-existing exposure/i);
        expect(runner.status).toBe('failed');
    });

    it('persists an empty, verified ownership book before it begins trading', async () => {
        installStrategy(() => undefined);
        const bot = testBot({ venue: 'capital', symbol: 'capital:EURUSD' });
        const runner = new BotRunner({
            bot,
            providers: { capital: () => fakeProvider(seedBars(10)).provider },
        });

        await runner.start();
        runner.stop();
        await runner.settle();

        expect(accounts.get(bot.id)).toMatchObject({
            symbol: 'capital:EURUSD',
            capital: {
                initialized: true,
                positionDealIds: [],
                workingOrderDealIds: [],
                uncertain: false,
            },
        });
        expect('session' in accounts.get(bot.id)!).toBe(false);
    });

    it('counts and persists a newly confirmed live entry', async () => {
        installStrategy((ctx) => {
            if (ctx.index === 9) ctx.buy({ size: 1000, stopLoss: 1.08 });
        });
        const bot = testBot({
            venue: 'capital',
            symbol: 'capital:EURUSD',
            guards: { maxTradesPerDay: 1, staleFeedSeconds: 0 },
        });
        const firstBarAt = Date.now() - 10 * MINUTE;
        const feed = fakeProvider(Array.from(
            { length: 10 },
            (_, i) => bar(firstBarAt + i * MINUTE, 1.09 + i * 0.0001),
        ));
        const runner = new BotRunner({ bot, providers: { capital: () => feed.provider } });

        await runner.start();
        feed.feed(bar(firstBarAt + 10 * MINUTE, 1.092));
        await vi.advanceTimersByTimeAsync(0);

        expect(runner.todaysTrades).toBe(1);
        expect(runner.refusal()).toMatch(/trades for today/i);
        runner.stop();
        await runner.settle();
        expect(accounts.get(bot.id)).toMatchObject({
            guards: { tradesToday: 1 },
            capital: { positionDealIds: ['position-1'] },
        });
    });

    it('waits for an in-flight venue create before its stopped state is settled', async () => {
        installStrategy((ctx) => {
            if (ctx.index === 9) ctx.buy({ size: 1000, stopLoss: 1.08 });
        });
        let answer!: (confirmation: Record<string, unknown>) => void;
        const sent = vi.fn(() => new Promise((resolve) => { answer = resolve; }));
        stub('capital.openPosition', sent);
        const bot = testBot({ venue: 'capital', symbol: 'capital:EURUSD' });
        const firstBarAt = Date.now() - 10 * MINUTE;
        const feed = fakeProvider(Array.from(
            { length: 10 },
            (_, i) => bar(firstBarAt + i * MINUTE, 1.09 + i * 0.0001),
        ));
        const runner = new BotRunner({ bot, providers: { capital: () => feed.provider } });
        await runner.start();

        feed.feed(bar(firstBarAt + 10 * MINUTE, 1.092));
        await vi.waitFor(() => expect(sent).toHaveBeenCalledTimes(1));
        runner.stop();
        let settled = false;
        const stopping = runner.settle().then(() => { settled = true; });
        await vi.advanceTimersByTimeAsync(0);
        expect(settled).toBe(false);

        answer({ accepted: true, dealId: 'position-late' });
        await stopping;
        expect(accounts.get(bot.id)?.capital).toMatchObject({
            positionDealIds: ['position-late'],
            uncertain: false,
        });
    });

    it('reads the current Capital.com environment when it starts', async () => {
        installStrategy(() => undefined);
        stub('capital.environment', () => Promise.resolve({ configured: true, env: 'live', live: true }));
        const runner = new BotRunner({
            allowLive: true,
            bot: testBot({ venue: 'capital', symbol: 'capital:EURUSD' }),
            providers: { capital: () => fakeProvider(seedBars(10)).provider },
        });

        await runner.start();
        expect(runner.log.list().some((entry) => entry.text.includes('live money'))).toBe(true);
        runner.stop();
        await runner.settle();
    });

    it('refuses an unarmed live start before constructing an account or subscribing', async () => {
        installStrategy(() => undefined);
        stub('capital.environment', () => Promise.resolve({ configured: true, env: 'live', live: true }));
        const read = vi.fn();
        stub('capital.positions', read);
        const feed = fakeProvider(seedBars(10));
        const runner = new BotRunner({ bot: testBot({ venue: 'capital', symbol: 'capital:EURUSD' }), providers: { capital: () => feed.provider } });
        await expect(runner.start()).rejects.toThrow(/confirm.*live.money/i);
        expect(read).not.toHaveBeenCalled();
        expect(feed.subscribed).toBe(false);
    });

    it('does not start when the Capital.com account cannot be read safely', async () => {
        installStrategy(() => undefined);
        const feed = fakeProvider(seedBars(10));
        stub('capital.account', () => Promise.reject(new Error('account endpoint offline')));
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const runner = new BotRunner({
            bot: testBot({ venue: 'capital', symbol: 'capital:EURUSD' }),
            providers: { capital: () => feed.provider },
        });

        await expect(runner.start()).rejects.toThrow(/could not be read/i);
        expect(runner.status).toBe('failed');
        expect(feed.subscribed).toBe(false);
        warn.mockRestore();
    });
});

describe('a live bot writes every closed trade to the journal', () => {
    /** One finished trade, as CapitalController reports one. */
    function closed(over: Record<string, unknown> = {}): Record<string, unknown> {
        return {
            id: 'deal-1',
            symbol: 'EURUSD',
            side: 'long',
            size: 1000,
            entryPrice: 1.09,
            exitPrice: 1.095,
            openedAt: Date.now() - 60_000,
            closedAt: Date.now(),
            netPnl: 5,
            fees: 0.4,
            estimated: false,
            live: false,
            exitTag: null,
            currency: 'USD',
            ...over,
        };
    }

    /** Start a live bot far enough to have a controller, and hand back the hook the venue
     *  client would call. Nothing is subscribed to: the venue is never reached in a test. */
    async function liveRunner(): Promise<BotRunner> {
        installStrategy(() => undefined);
        const feed = fakeProvider(seedBars(10));
        const runner = new BotRunner({
            bot: testBot({ venue: 'capital', symbol: 'capital:EURUSD' }),
            providers: { capital: () => feed.provider },
        });
        await runner.start();
        return runner;
    }

    it('records it, because nothing else anywhere does', async () => {
        // The venue serves at most a day of history per request and loses it with the
        // account. A bot trading unwatched is exactly the case where nobody is there to
        // notice a trade went unrecorded.
        const runner = await liveRunner();
        runner.capitalController!.onTradeClosed!(closed() as never);
        await vi.advanceTimersByTimeAsync(0);

        expect(journal).toHaveLength(1);
        expect(journal[0]!.id).toBe('deal-1');
        expect(runner.log.list().some((e) => e.text.includes('journalled'))).toBe(true);
        runner.stop();
    });

    it('says so loudly when the journal could not be written', async () => {
        const runner = await liveRunner();
        stub('live.append', () => Promise.reject(new Error('disk full')));

        runner.capitalController!.onTradeClosed!(closed() as never);
        await vi.advanceTimersByTimeAsync(0);

        const said = runner.log.list().find((e) => e.kind === 'error');
        expect(said?.text).toMatch(/only record this happened/);
        runner.stop();
    });

    it('arms the cooldown guard on a losing trade', async () => {
        // A live account keeps no trade ledger this app can read, so the closure hook is the
        // only place a loss can be noticed at all.
        const runner = await liveRunner();
        runner.capitalController!.onTradeClosed!(closed({ netPnl: -12 }) as never);
        await vi.advanceTimersByTimeAsync(0);

        expect(journal).toHaveLength(1);
        runner.stop();
        await runner.settle();
        expect(accounts.get('bot_test')?.guards?.lastLossAt).toBe(Date.now());
    });
});

describe('an account is filed before it is thrown away', () => {
    function engine(): BotEngine {
        return new BotEngine({ providers: { fake: () => fakeProvider(seedBars(10)).provider } });
    }

    it('files a deleted bot\'s account as a run', async () => {
        const bot = testBot();
        const runner = await tradeAndStop(bot);
        await runner.settle();
        runner.dispose();

        const e = engine();
        storedBots = [bot];
        await e.load();
        await e.remove(bot.id);

        expect(filedRuns).toHaveLength(1);
        expect(filedRuns[0]!.strategy).toBe('test-strategy');
        // The note is what stops a bot's run being read as a backtest of the same strategy.
        expect(String(filedRuns[0]!.note)).toMatch(/Trading bot/);
        // Only then is the account gone.
        expect(accounts.has(bot.id)).toBe(false);
        expect(e.list()).toHaveLength(0);
    });

    it('keeps the bot when filing fails, rather than deleting the evidence', async () => {
        const bot = testBot();
        const runner = await tradeAndStop(bot);
        await runner.settle();
        runner.dispose();

        stub('backtest.save', () => Promise.reject(new Error('disk full')));

        const e = engine();
        storedBots = [bot];
        await e.load();
        await expect(e.remove(bot.id)).rejects.toThrow(/NOT deleted/);

        expect(e.list()).toHaveLength(1);
        expect(accounts.has(bot.id)).toBe(true);
    });

    it('deletes a bot that never traded without filing anything', async () => {
        const bot = testBot();
        const e = engine();
        storedBots = [bot];
        await e.load();
        await e.remove(bot.id);

        expect(filedRuns).toHaveLength(0);
        expect(e.list()).toHaveLength(0);
    });

    it('files the account on a reset and starts over', async () => {
        const bot = testBot();
        const runner = await tradeAndStop(bot);
        await runner.settle();
        runner.dispose();

        const e = engine();
        storedBots = [bot];
        await e.load();
        const filed = await e.resetAccount(bot.id);

        expect(filed).toBe('run_1');
        expect(accounts.has(bot.id)).toBe(false);
        // The bot itself is untouched — only its account started over.
        expect(e.list()).toHaveLength(1);
    });

    it('does not let a write still in flight resurrect a reset account', async () => {
        /* The bug this test exists for: the account is written on a delay, and stopping a bot
         * only STARTS that write. A reset that deleted the account while the write was still
         * going put it straight back — a reset that silently did nothing. Only a real app
         * run found it, because the fake disk answered instantly.
         *
         * Here the save is made slow on purpose, which is what a real one is. */
        const bot = testBot();
        const runner = await tradeAndStop(bot);
        await runner.settle();
        runner.dispose();

        const gate: { release: (() => void) | null } = { release: null };
        const realSave = (globalThis as unknown as {
            window: { midori: { bots: { account: { save: (id: string, a: unknown) => Promise<unknown> } } } };
        }).window.midori.bots.account.save;
        stub('bots.account', {
            ...(globalThis as unknown as {
                window: { midori: { bots: { account: Record<string, unknown> } } };
            }).window.midori.bots.account,
            save: (id: string, account: unknown) => new Promise((resolve) => {
                gate.release = () => resolve(realSave(id, account));
            }),
        } as never);

        const e = engine();
        storedBots = [bot];
        await e.load();

        const reset = e.resetAccount(bot.id);
        // The slow write lands in the middle of the reset, exactly as it did in the app.
        gate.release?.();
        await reset;

        expect(accounts.has(bot.id)).toBe(false);
    });

    it('leaves nothing behind when the account it filed is deleted', async () => {
        /* The second half of the same bug. `resetAccount` builds a runner purely to READ the
         * stored account and file it — and that runner used to write the account back as it
         * was thrown away, landing after the delete. Only the app found it: in a test the
         * fake disk answered fast enough that the delete happened to win. */
        const bot = testBot();
        const runner = await tradeAndStop(bot);
        await runner.settle();
        runner.dispose();

        const e = engine();
        storedBots = [bot];
        await e.load();
        await e.resetAccount(bot.id);
        // Anything the helper started would land in the next few ticks.
        await vi.advanceTimersByTimeAsync(2000);

        expect(accounts.has(bot.id)).toBe(false);
    });

    it('sweeps accounts whose bot is gone', async () => {
        accounts.set('bot_ghost', { symbol: 'fake:TEST', session: {}, savedAt: 0 });
        const e = engine();
        storedBots = [testBot()];
        await e.load();
        await vi.advanceTimersByTimeAsync(0);

        expect(accounts.has('bot_ghost')).toBe(false);
    });
});

describe('the engine lifecycle', () => {
    it('loads a stored stopped paper account for display without opening a feed', async () => {
        const bot = testBot();
        const stored = await tradeAndStop(bot);
        await stored.settle();
        stored.dispose();
        storedBots = [bot];
        let subscriptions = 0;
        const engine = new BotEngine({
            providers: {
                fake: () => ({
                    getBars: () => Promise.resolve(seedBars(10)),
                    subscribe: () => { subscriptions += 1; return () => undefined; },
                }),
            },
        });

        await engine.load();

        expect(engine.runner(bot.id)).toBeNull();
        expect(engine.displayRunner(bot.id)?.paperController?.broker.trades).toHaveLength(1);
        expect(engine.displayRunner(bot.id)?.log.last()?.text).toMatch(/account restored/i);
        expect(subscriptions).toBe(0);
    });

    it('keeps a stopped account and activity as a read-only display without keeping its feed alive', async () => {
        installStrategy(() => undefined);
        const feed = fakeProvider(seedBars(10));
        const bot = testBot();
        storedBots = [bot];
        const engine = new BotEngine({ providers: { fake: () => feed.provider } });
        await engine.load();
        await engine.start(bot.id);
        const active = engine.runner(bot.id);

        expect(active).not.toBeNull();
        expect(feed.subscribed).toBe(true);
        await engine.stop(bot.id);

        const readout = engine.displayRunner(bot.id);
        expect(engine.runner(bot.id)).toBeNull();
        expect(readout).toBe(active);
        expect(readout?.paperController).not.toBeNull();
        expect(readout?.log.last()?.text).toBe('Stopped.');
        expect(feed.unsubscribed).toBe(true);

        await engine.start(bot.id);
        expect(engine.displayRunner(bot.id)).toBe(engine.runner(bot.id));
        expect(engine.displayRunner(bot.id)).not.toBe(readout);
        await engine.stop(bot.id);
    });

    it('coalesces concurrent loads into one read and one bot list', async () => {
        let releaseLoad: (bots: unknown[]) => void = () => undefined;
        let loadCalls = 0;
        stub('bots.load', () => {
            loadCalls += 1;
            return new Promise((resolve) => { releaseLoad = resolve; });
        });
        const engine = new BotEngine({ providers: {} });

        const firstLoad = engine.load();
        const secondLoad = engine.load();
        expect(loadCalls).toBe(1);
        releaseLoad([testBot()]);
        await Promise.all([firstLoad, secondLoad]);

        expect(engine.ready).toBe(true);
        expect(engine.list()).toHaveLength(1);
    });

    it('coalesces duplicate starts and cannot be re-enabled by a start that was stopped', async () => {
        installStrategy(() => undefined);
        let releaseHistory: (bars: OHLCV[]) => void = () => undefined;
        let subscriptions = 0;
        const provider: DataProvider = {
            getBars: () => new Promise((resolve) => { releaseHistory = resolve; }),
            subscribe: () => {
                subscriptions += 1;
                return () => undefined;
            },
        };
        const bot = testBot();
        storedBots = [bot];
        const engine = new BotEngine({ providers: { fake: () => provider } });
        await engine.load();

        const firstStart = engine.start(bot.id);
        const secondStart = engine.start(bot.id);
        await vi.waitFor(() => expect(engine.status(bot.id)).toBe('starting'));
        await engine.stop(bot.id);
        releaseHistory(seedBars(10));
        await Promise.all([firstStart, secondStart]);

        expect(engine.runner(bot.id)).toBeNull();
        expect(engine.find(bot.id)?.enabled).toBe(false);
        expect(subscriptions).toBe(0);
    });

    it('can start a fresh runner while the cancelled history request is still pending', async () => {
        installStrategy(() => undefined);
        let releaseOldHistory: (bars: OHLCV[]) => void = () => undefined;
        let providerBuilds = 0;
        let oldSubscriptions = 0;
        let freshSubscriptions = 0;
        const stalled: DataProvider = {
            getBars: () => new Promise((resolve) => { releaseOldHistory = resolve; }),
            subscribe: () => {
                oldSubscriptions += 1;
                return () => undefined;
            },
        };
        const fresh: DataProvider = {
            getBars: () => Promise.resolve(seedBars(10)),
            subscribe: () => {
                freshSubscriptions += 1;
                return () => undefined;
            },
        };
        const bot = testBot();
        storedBots = [bot];
        const engine = new BotEngine({
            providers: { fake: () => (providerBuilds++ === 0 ? stalled : fresh) },
        });
        await engine.load();

        const cancelledStart = engine.start(bot.id);
        await vi.waitFor(() => expect(engine.status(bot.id)).toBe('starting'));
        await engine.stop(bot.id);
        await engine.start(bot.id);

        expect(engine.status(bot.id)).toBe('running');
        expect(freshSubscriptions).toBe(1);
        releaseOldHistory(seedBars(10));
        await cancelledStart;

        expect(engine.status(bot.id)).toBe('running');
        expect(engine.find(bot.id)?.enabled).toBe(true);
        expect(oldSubscriptions).toBe(0);
        await engine.stop(bot.id);
    });

    it('waits for the final account write during shutdown and preserves resume intent', async () => {
        installStrategy(() => undefined);
        const feed = fakeProvider(seedBars(10));
        const bot = testBot();
        storedBots = [bot];
        const engine = new BotEngine({ providers: { fake: () => feed.provider } });
        await engine.load();
        await engine.start(bot.id);

        let releaseSave: () => void = () => undefined;
        let saveStarted = false;
        let saveCalls = 0;
        stub('bots.account', {
            ...(globalThis as unknown as {
                window: { midori: { bots: { account: Record<string, unknown> } } };
            }).window.midori.bots.account,
            save: () => {
                saveCalls += 1;
                if (saveCalls > 1) return Promise.resolve({ savedAt: Date.now() });
                return new Promise((resolve) => {
                    saveStarted = true;
                    releaseSave = () => resolve({ savedAt: Date.now() });
                });
            },
        } as never);

        let finished = false;
        const shutdown = engine.shutdown().then(() => { finished = true; });
        await vi.waitFor(() => expect(saveStarted).toBe(true));
        expect(finished).toBe(false);
        expect(engine.find(bot.id)?.enabled).toBe(true);

        releaseSave();
        await shutdown;

        expect(finished).toBe(true);
        expect(engine.runner(bot.id)).toBeNull();
        expect(engine.find(bot.id)?.enabled).toBe(true);
    });
});


it('refuses an unprotected Capital bot entry without sending it', async () => {
    installStrategy((ctx) => { ctx.buy({ size: 1 }); });
    const sent = vi.fn();
    stub('capital.openPosition', sent);
    const feed = fakeProvider(seedBars(10));
    const runner = new BotRunner({ bot: testBot({ venue: 'capital', symbol: 'capital:EURUSD' }), providers: { capital: () => feed.provider } });
    await runner.start();
    feed.feed(bar(10 * MINUTE, 102));
    await runner.settle();
    expect(sent).not.toHaveBeenCalled();
    expect(runner.log.list().some(entry => /protective stop/i.test(entry.text))).toBe(true);
    runner.stop();
    await runner.settle();
});


it('refuses a start waiting for Stop when a reset acquires the account meanwhile', async () => {
    installStrategy(() => undefined);
    const feed = fakeProvider(seedBars(10));
    const bot = testBot();
    storedBots = [bot];
    const e = new BotEngine({ providers: { fake: () => feed.provider } });
    await e.load();
    await e.start(bot.id);
    let releaseStop!: () => void;
    stub('bots.save', () => new Promise(resolve => { releaseStop = () => resolve({ savedAt: Date.now() }); }));
    const stopping = e.stop(bot.id);
    await vi.waitFor(() => expect(releaseStop).toBeTypeOf('function'));
    const starting = e.start(bot.id);
    const rejectedStart = expect(starting).rejects.toThrow(/account change/i);
    let releaseReset!: () => void;
    let resetRead = true;
    stub('bots.account.load', () => {
        if (!resetRead) return Promise.resolve(accounts.get(bot.id) ?? null);
        resetRead = false;
        return new Promise(resolve => { releaseReset = () => resolve(null); });
    });
    const resetting = e.resetAccount(bot.id);
    releaseStop();
    await stopping;
    await rejectedStart;
    releaseReset();
    await resetting;
    expect(e.runner(bot.id)).toBeNull();
});

it('sends the next setup after the venue refused one while its market was closed', async () => {
    let attempts = 0;
    installStrategy((ctx) => {
        if (!ctx.isFlat) return;
        attempts += 1;
        ctx.buy({ size: 1000, stopLoss: 1.08 });
    });
    const sent = vi.fn(() => Promise.resolve({ accepted: true, dealId: 'position-1' }));
    stub('capital.openPosition', sent);
    let marketStatus = 'CLOSED';
    stub('capital.marketInfo', () => Promise.resolve({
        instrument: { lotSize: 1, currency: 'USD' },
        snapshot: { marketStatus, bid: 1.09, offer: 1.091 },
    }));
    const firstBarAt = Date.now() - 10 * MINUTE;
    const feed = fakeProvider(Array.from({ length: 10 }, (_, i) => bar(firstBarAt + i * MINUTE, 1.09)));
    const runner = new BotRunner({
        bot: testBot({ venue: 'capital', symbol: 'capital:EURUSD' }),
        providers: { capital: () => feed.provider },
    });
    await runner.start();

    feed.feed(bar(firstBarAt + 10 * MINUTE, 1.09));
    expect(attempts).toBe(1);
    expect(sent).not.toHaveBeenCalled();
    expect(runner.log.list().some((entry) => /not sent.*market is closed/i.test(entry.text))).toBe(true);

    marketStatus = 'TRADEABLE';
    vi.setSystemTime(Date.now() + MINUTE);
    // One account read on the new clock, so the venue's open market is what the bot knows.
    await vi.advanceTimersByTimeAsync(4_000);
    feed.feed(bar(firstBarAt + 11 * MINUTE, 1.09));

    await vi.waitFor(() => expect(sent).toHaveBeenCalledTimes(1));
    expect(attempts).toBe(2);
    runner.stop();
    await runner.settle();
});

describe('what survives a stop', () => {
    /** A paper bot that bought once and was stopped holding it. */
    async function stoppedHolding(stopLoss?: number) {
        installStrategy((ctx) => {
            if (ctx.index === 9) ctx.buy({ size: 0.01, ...(stopLoss != null ? { stopLoss } : {}) });
        });
        const bot = testBot();
        const firstBarAt = Date.now() - 10 * MINUTE;
        const history = Array.from({ length: 10 }, (_, i) => bar(firstBarAt + i * MINUTE, 100));
        const feed = fakeProvider(history);
        const runner = new BotRunner({ bot, providers: { fake: () => feed.provider } });
        await runner.start();
        feed.feed(bar(firstBarAt + 10 * MINUTE, 100));
        expect(runner.openPositions()).toBe(1);
        runner.stop();
        await runner.settle();
        installStrategy(() => undefined);
        return { bot, firstBarAt, history, feed };
    }

    it('fills a stop the market went through while the bot was stopped', async () => {
        const { bot, firstBarAt, history } = await stoppedHolding(95);
        vi.setSystemTime(Date.now() + 5 * MINUTE);
        const later = fakeProvider([
            ...history,
            bar(firstBarAt + 10 * MINUTE, 100),
            bar(firstBarAt + 11 * MINUTE, 90),
            bar(firstBarAt + 12 * MINUTE, 100),
            bar(firstBarAt + 13 * MINUTE, 100),
            bar(firstBarAt + 14 * MINUTE, 100),
            bar(firstBarAt + 15 * MINUTE, 100),
        ]);
        const runner = new BotRunner({ bot, providers: { fake: () => later.provider } });
        await runner.start();

        // The market is back at 100, but it traded through 95 on the way.
        expect(runner.openPositions()).toBe(0);
        expect(runner.paperController!.broker.trades).toHaveLength(1);
        expect(runner.log.list().some((entry) => /Replayed 4 bars/.test(entry.text))).toBe(true);
        runner.stop();
    });

    it('says nothing about a restart when the strategy had nothing to remember', async () => {
        const { bot, feed } = await stoppedHolding();
        const runner = new BotRunner({ bot, providers: { fake: () => feed.provider } });
        await runner.start();
        expect(runner.openPositions()).toBe(1);
        expect(said(runner, /did not survive the restart/)).toBe(false);
        runner.stop();
    });

    function said(runner: BotRunner, what: RegExp): boolean {
        return runner.log.list().some((entry) => what.test(entry.text));
    }

    /**
     * A paper bot stopped while its strategy is holding a bar index.
     *
     * The strategy buys on bar 9 and means to be flat by bar 13, the shape the session
     * strategies have. `seen` records the index every bar was handed over under.
     */
    async function stoppedRemembering() {
        const seen: Array<{ index: number; time: number }> = [];
        installStrategy((ctx) => {
            seen.push({ index: ctx.index, time: ctx.time });
            const trade = ctx.state.trade as { flatIndex: number } | undefined;
            if (trade) {
                if (ctx.index < trade.flatIndex) return;
                if (!ctx.isFlat) ctx.close('time');
                ctx.state.trade = undefined;
                return;
            }
            if (ctx.index === 9) {
                ctx.buy({ size: 0.01 });
                ctx.state.trade = { flatIndex: 13 };
            }
        });
        const bot = testBot();
        const firstBarAt = Date.now() - 10 * MINUTE;
        const at = (i: number): OHLCV => bar(firstBarAt + i * MINUTE, 100);
        const stretch = (from: number, to: number): OHLCV[] => (
            Array.from({ length: to - from + 1 }, (_, i) => at(from + i))
        );
        const feed = fakeProvider(stretch(0, 9));
        const runner = new BotRunner({ bot, providers: { fake: () => feed.provider } });
        await runner.start();
        feed.feed(at(10));
        expect(runner.openPositions()).toBe(1);
        runner.stop();
        await runner.settle();
        // Three minutes pass with the bot stopped.
        vi.setSystemTime(Date.now() + 3 * MINUTE);
        return { bot, at, stretch, seen };
    }

    it('gives the strategy back what it remembered, on the bar indices it was written under', async () => {
        const { bot, at, stretch, seen } = await stoppedRemembering();
        expect(accounts.get(bot.id)?.strategy?.state).toEqual({ trade: { flatIndex: 13 } });

        const feed = fakeProvider(stretch(0, 13));
        const runner = new BotRunner({ bot, providers: { fake: () => feed.provider } });
        await runner.start();
        expect(said(runner, /picked up what it remembered/)).toBe(true);
        expect(said(runner, /did not survive the restart/)).toBe(false);
        expect(runner.openPositions()).toBe(1);

        // Bar 13 closes: the exit the strategy planned before the restart.
        feed.feed(at(14));
        expect(seen[seen.length - 1]).toEqual({ index: 13, time: at(13).time });
        expect(runner.openPositions()).toBe(0);
        runner.stop();
    });

    it('keeps the indices when the market now serves a longer history', async () => {
        const { bot, at, stretch, seen } = await stoppedRemembering();
        const feed = fakeProvider(stretch(-5, 13));
        const runner = new BotRunner({ bot, providers: { fake: () => feed.provider } });
        await runner.start();
        expect(said(runner, /picked up what it remembered/)).toBe(true);

        feed.feed(at(14));
        expect(seen[seen.length - 1]).toEqual({ index: 13, time: at(13).time });
        expect(runner.openPositions()).toBe(0);
        runner.stop();
    });

    it('drops what cannot be lined up with the history, and says what that costs', async () => {
        const { bot, at, stretch } = await stoppedRemembering();
        // The market no longer serves the first four bars, so bar 9 cannot sit at index 9.
        const feed = fakeProvider(stretch(4, 13));
        const runner = new BotRunner({ bot, providers: { fake: () => feed.provider } });
        await runner.start();
        expect(said(runner, /could not be lined up/)).toBe(true);
        expect(said(runner, /did not survive the restart/)).toBe(true);

        feed.feed(at(14));
        // No index from the old history was acted on.
        expect(runner.openPositions()).toBe(1);
        runner.stop();
    });

    it('does not carry the memory over to a bot whose settings changed', async () => {
        const { bot, stretch } = await stoppedRemembering();
        accounts.get(bot.id)!.strategy!.key = 'written under other settings';
        const feed = fakeProvider(stretch(0, 13));
        const runner = new BotRunner({ bot, providers: { fake: () => feed.provider } });
        await runner.start();
        expect(said(runner, /was not carried over/)).toBe(true);
        expect(said(runner, /did not survive the restart/)).toBe(true);
        runner.stop();
    });

    it('goes flat when it is started after its window ended with something still open', async () => {
        const { bot, feed } = await stoppedHolding();
        // 14:00 UTC now; this window ended at 13:00.
        const closed = { ...bot, guards: { sessionStart: 600, sessionEnd: 780, flattenAtEnd: true } };
        const runner = new BotRunner({ bot: closed, providers: { fake: () => feed.provider } });
        await runner.start();
        expect(runner.openPositions()).toBe(1);

        await vi.advanceTimersByTimeAsync(6_000);

        expect(runner.openPositions()).toBe(0);
        runner.stop();
    });
});

describe('a Capital.com bot, unattended', () => {
    function capitalFeed() {
        const firstBarAt = Date.now() - 10 * MINUTE;
        const feed = fakeProvider(Array.from({ length: 10 }, (_, i) => bar(firstBarAt + i * MINUTE, 1.09)));
        return { feed, firstBarAt };
    }

    it('keeps trying to go flat after the venue turned the first close away', async () => {
        installStrategy(() => undefined);
        const bot = testBot({
            venue: 'capital',
            symbol: 'capital:EURUSD',
            // 14:00 UTC now; the window ends at 14:01.
            guards: { sessionStart: 600, sessionEnd: 841, flattenAtEnd: true, staleFeedSeconds: 0 },
        });
        accounts.set(bot.id, {
            symbol: 'capital:EURUSD',
            savedAt: 1,
            capital: {
                accountId: 'test-account',
                environment: 'demo',
                initialized: true,
                positionDealIds: ['position-1'],
                workingOrderDealIds: [],
                uncertain: false,
            },
        } as MidoriBotAccount);
        let open = true;
        stub('capital.positions', () => Promise.resolve(open ? [{
            position: { dealId: 'position-1', direction: 'BUY', size: 1000, level: 1.09, createdDateUTC: '2026-09-09T13:00:00', upl: 0, currency: 'USD' },
            market: { epic: 'EURUSD', bid: 1.09, offer: 1.091 },
        }] : []));
        const close = vi.fn()
            .mockResolvedValueOnce({ accepted: false, reason: 'UNKNOWN' })
            .mockImplementation(() => {
                open = false;
                return Promise.resolve({ accepted: true, dealId: 'position-1', level: 1.09 });
            });
        stub('capital.closePosition', close);
        const { feed } = capitalFeed();
        const runner = new BotRunner({ bot, providers: { capital: () => feed.provider } });
        await runner.start();
        expect(runner.openPositions()).toBe(1);

        await vi.advanceTimersByTimeAsync(70_000);
        expect(close).toHaveBeenCalledTimes(1);
        expect(runner.openPositions()).toBe(1);

        await vi.advanceTimersByTimeAsync(35_000);
        expect(close).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(4_000);
        expect(runner.openPositions()).toBe(0);
        runner.stop();
        await runner.settle();
    });

    it('records no unknown outcome for an entry that never left the app', async () => {
        installStrategy((ctx) => {
            if (ctx.index === 9) ctx.buy({ size: 1000, stopLoss: 1.08 });
        });
        let revision = 1;
        stub('capital.environment', () => Promise.resolve({ configured: true, env: 'demo', live: false, revision }));
        const sent = vi.fn(() => Promise.resolve({ accepted: true, dealId: 'position-1' }));
        stub('capital.openPosition', sent);
        const bot = testBot({ venue: 'capital', symbol: 'capital:EURUSD' });
        const { feed, firstBarAt } = capitalFeed();
        const runner = new BotRunner({ bot, providers: { capital: () => feed.provider } });
        await runner.start();

        // The connection changes between the start and the first entry.
        revision = 2;
        feed.feed(bar(firstBarAt + 10 * MINUTE, 1.09));
        await runner.settle();
        runner.stop();
        await runner.settle();

        expect(sent).not.toHaveBeenCalled();
        expect(accounts.get(bot.id)?.capital).toMatchObject({ uncertain: false, positionDealIds: [] });
    });

    it('sends an entry whose stop is a distance, with the stop as a level', async () => {
        installStrategy((ctx) => {
            if (ctx.index === 9) ctx.order({ side: 'buy', type: 'market', size: 1000, bracket: { stopDistance: 0.01 } });
        });
        const sent = vi.fn((_payload: { stopLevel?: number }) => Promise.resolve({ accepted: true, dealId: 'position-1' }));
        stub('capital.openPosition', sent);
        const { feed, firstBarAt } = capitalFeed();
        const runner = new BotRunner({
            bot: testBot({ venue: 'capital', symbol: 'capital:EURUSD' }),
            providers: { capital: () => feed.provider },
        });
        await runner.start();

        feed.feed(bar(firstBarAt + 10 * MINUTE, 1.09));
        await vi.waitFor(() => expect(sent).toHaveBeenCalledTimes(1));

        // The ask is 1.091.
        expect(sent.mock.calls[0]![0].stopLevel).toBeCloseTo(1.081, 10);
        runner.stop();
        await runner.settle();
    });
});

describe('limits shared by every bot on a Capital.com account', () => {
    function stubStorage(): void {
        const cells = new Map<string, string>();
        (globalThis as unknown as { localStorage: unknown }).localStorage = {
            getItem: (k: string) => cells.get(k) ?? null,
            setItem: (k: string, v: string) => void cells.set(k, v),
            removeItem: (k: string) => void cells.delete(k),
        };
    }
    beforeEach(() => {
        stubStorage();
        resetAccountDays();
    });
    afterEach(() => {
        delete (globalThis as { localStorage?: unknown }).localStorage;
    });

    const ownership = (positionDealIds: string[]) => ({
        symbol: 'capital:EURUSD',
        savedAt: 1,
        capital: {
            accountId: 'test-account',
            environment: 'demo',
            initialized: true,
            positionDealIds,
            workingOrderDealIds: [],
            uncertain: false,
        },
    } as MidoriBotAccount);

    /** Two running bots on the demo account: the first holds a position, the second wants one. */
    async function holderAndBuyer() {
        installStrategy((ctx) => {
            if (ctx.isFlat) ctx.buy({ size: 1000, stopLoss: 1.08 });
        });
        const holder = testBot({ id: 'bot_holder', venue: 'capital', symbol: 'capital:EURUSD', guards: { staleFeedSeconds: 0 } });
        const buyer = testBot({ id: 'bot_buyer', venue: 'capital', symbol: 'capital:EURUSD', guards: { staleFeedSeconds: 0 } });
        storedBots = [holder, buyer];
        accounts.set(holder.id, ownership(['position-1']));
        accounts.set(buyer.id, ownership([]));
        stub('capital.positions', () => Promise.resolve([{
            position: { dealId: 'position-1', direction: 'BUY', size: 1000, level: 1.09, createdDateUTC: '2026-09-09T13:00:00', upl: 0, currency: 'USD' },
            market: { epic: 'EURUSD', bid: 1.09, offer: 1.091 },
        }]));
        const sent = vi.fn(() => Promise.resolve({ accepted: true, dealId: 'position-2' }));
        stub('capital.openPosition', sent);
        const firstBarAt = Date.now() - 10 * MINUTE;
        const feed = fakeProvider(Array.from({ length: 10 }, (_, i) => bar(firstBarAt + i * MINUTE, 1.09)));
        const engine = new BotEngine({ providers: { capital: () => feed.provider } });
        await engine.load();
        // The fake feed speaks to whoever subscribed last, so the buyer starts second.
        await engine.start(holder.id);
        await engine.start(buyer.id);
        const close = (): void => feed.feed(bar(firstBarAt + 10 * MINUTE, 1.09));
        return { engine, holder, buyer, sent, close };
    }

    it('turn a bot away when the others already hold what the account allows', async () => {
        saveAccountRisk('capital:demo', { maxBotPositions: 1, dailyLossPct: 0 });
        const { engine, buyer, sent, close } = await holderAndBuyer();

        close();
        await vi.advanceTimersByTimeAsync(100);

        expect(sent).not.toHaveBeenCalled();
        expect(engine.runner(buyer.id)!.refusal()).toMatch(/already hold 1 of the 1 position /);
        await engine.shutdown();
    });

    it('let it trade while there is room', async () => {
        saveAccountRisk('capital:demo', { maxBotPositions: 2, dailyLossPct: 0 });
        const { engine, sent, close } = await holderAndBuyer();

        close();
        await vi.waitFor(() => expect(sent).toHaveBeenCalledTimes(1));
        await engine.shutdown();
    });

    it('stop every bot on the account once it is down its limit on the day', async () => {
        saveAccountRisk('capital:demo', { maxBotPositions: 0, dailyLossPct: 1 });
        const { engine, buyer, sent, close } = await holderAndBuyer();
        expect(engine.runner(buyer.id)!.refusal()).toBeNull();

        // The account loses 2% somewhere, by whatever hand.
        stub('capital.account', () => Promise.resolve({
            accountId: 'test-account', currency: 'USD', balance: { balance: 9_800, profitLoss: 0, available: 9_800 },
        }));
        await vi.advanceTimersByTimeAsync(4_000);
        close();
        await vi.advanceTimersByTimeAsync(100);

        expect(sent).not.toHaveBeenCalled();
        expect(engine.runner(buyer.id)!.refusal()).toMatch(/account is down 2\.00% on the day/);
        await engine.shutdown();
    });

    it('refuse rather than trade when the stored limits cannot be read', async () => {
        localStorage.setItem('midorii-bot-account-risk', '{not json');
        const { engine, buyer, sent, close } = await holderAndBuyer();

        close();
        await vi.advanceTimersByTimeAsync(100);

        expect(sent).not.toHaveBeenCalled();
        expect(engine.runner(buyer.id)!.refusal()).toMatch(/limits for bots could not be read/);
        await engine.shutdown();
    });
});
