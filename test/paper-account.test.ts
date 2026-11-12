// One paper account over several markets (app/renderer/trading/PaperAccount.ts): the money is
// shared, each market keeps its own books, an id names one thing across all of them, and what is
// written down reads back — including a record from before there was more than one market.
import { describe, it, expect } from 'vitest';
import { PaperAccount, type PaperAccountSnapshot } from '../app/renderer/trading/PaperAccount';
import { DEFAULT_PAPER_SETTINGS, type PaperSettings } from '../app/renderer/trading/paperSettings';
import { PaperController } from '../app/renderer/trading/PaperController';

const settings: PaperSettings = {
    ...DEFAULT_PAPER_SETTINGS,
    balance: 10_000,
    feeRate: 0,
    spreadPct: 0,
    slippagePct: 0,
    hedging: true,
};

const BTC = 'binance:BTCUSDT';
const ETH = 'binance:ETHUSDT';

let t = 1_000_000;
/** A bar at one price — the feed's update, reduced to what the account reads. */
function bar(close: number) {
    t += 60_000;
    return { time: t, open: close, high: close, low: close, close };
}

/** Put a market on a price, and buy `size` of it. */
function open(account: PaperAccount, symbol: string, price: number, size: number) {
    const leg = account.legFor(symbol);
    leg.onBar(bar(price));
    leg.order({ side: 'buy', size });
    return leg;
}

describe('a paper account over several markets', () => {
    it('shares one balance: what one market settles is cash for the others', () => {
        const account = new PaperAccount({ settings, symbol: BTC });
        const btc = open(account, BTC, 100, 1);
        const eth = account.legFor(ETH);
        eth.onBar(bar(50));

        btc.onBar(bar(110));
        const id = btc.broker.position!.id;
        account.closeOne(id);

        expect(btc.broker.positions).toHaveLength(0);
        expect(account.cash()).toBeCloseTo(10_010, 6);
        // The second market's own books never moved, but it is trading on the account's money.
        expect(eth.broker.balance).toBe(10_000);
        expect(eth.equity()).toBeCloseTo(10_010, 6);
    });

    it('adds up what is open across markets into one equity', () => {
        const account = new PaperAccount({ settings, symbol: BTC });
        const btc = open(account, BTC, 100, 1);
        const eth = open(account, ETH, 50, 2);

        btc.onBar(bar(103));
        eth.onBar(bar(48));

        // +3 on one unit, −2 on two units.
        expect(account.equity()).toBeCloseTo(10_000 + 3 - 4, 6);
        expect(account.account().open).toBeCloseTo(-1, 6);
        expect(account.openCount).toBe(2);
    });

    it('gives every position and order an id that names one thing across all markets', () => {
        const account = new PaperAccount({ settings, symbol: BTC });
        const btc = open(account, BTC, 100, 1);
        const eth = open(account, ETH, 50, 1);

        const btcId = btc.broker.position!.id;
        const ethId = eth.broker.position!.id;
        expect(btcId).not.toBe(ethId);
        expect(account.ownerOfPosition(ethId)).toBe(eth);

        account.closeOne(ethId);
        expect(eth.broker.positions).toHaveLength(0);
        expect(btc.broker.positions).toHaveLength(1);
    });

    it('routes a stop to the market whose position it belongs to', () => {
        const account = new PaperAccount({ settings, symbol: BTC });
        open(account, BTC, 100, 1);
        const eth = open(account, ETH, 50, 1);

        account.protect({ stopLoss: 45 }, eth.broker.position!.id);
        expect(eth.broker.position!.stopLoss).toBe(45);
        // …and it fires on that market's own prices, whatever the other market is doing.
        eth.onBar({ time: t + 60_000, open: 50, high: 50, low: 44, close: 46 });
        expect(eth.broker.positions).toHaveLength(0);
        expect(account.legFor(BTC).broker.positions).toHaveLength(1);
    });

    it('refuses an id that is not open, in words', () => {
        const account = new PaperAccount({ settings, symbol: BTC });
        expect(() => account.closeOne(999_999)).toThrow(/no such position/i);
    });

    it('closes everything in every market on flatten', () => {
        const account = new PaperAccount({ settings, symbol: BTC });
        open(account, BTC, 100, 1);
        open(account, ETH, 50, 1);
        account.flatten();
        expect(account.openCount).toBe(0);
    });

    it('labels each row with its market once more than one has done anything', () => {
        const account = new PaperAccount({ settings, symbol: BTC });
        open(account, BTC, 100, 1);
        expect(account.book().multi).toBe(false);
        expect(account.book().positions[0]!.symbol).toBeUndefined();

        open(account, ETH, 50, 1);
        const book = account.book();
        expect(book.multi).toBe(true);
        expect(book.positions.map((p) => p.symbol).sort()).toEqual([BTC, ETH]);
    });

    it('does not count a market that was only looked at', () => {
        const account = new PaperAccount({ settings, symbol: BTC });
        open(account, BTC, 100, 1);
        account.legFor(ETH).onBar(bar(50));
        expect(account.book().multi).toBe(false);
    });

    it('merges closed trades of every market, newest first, each saying where it was made', () => {
        const account = new PaperAccount({ settings, symbol: BTC });
        const btc = open(account, BTC, 100, 1);
        btc.onBar(bar(101));
        account.closeOne(btc.broker.position!.id);
        const eth = open(account, ETH, 50, 1);
        eth.onBar(bar(51));
        account.closeOne(eth.broker.position!.id);

        const history = account.history();
        expect(history).toHaveLength(2);
        expect(history[0]!.symbol).toBe(ETH);
        expect(history[1]!.symbol).toBe(BTC);
        expect(account.tradeCount).toBe(2);
        expect(account.stats().tradeCount).toBe(2);
        expect(account.stats().netPnl).toBeCloseTo(2, 6);
    });

    it('sizes a trade against the whole account, not one market\'s books', () => {
        const account = new PaperAccount({ settings, symbol: BTC });
        const btc = open(account, BTC, 100, 1);
        btc.onBar(bar(150));
        account.closeOne(btc.broker.position!.id);
        const eth = account.legFor(ETH);
        expect(eth.equity()).toBeCloseTo(10_050, 6);
        expect(eth.broker.equity).toBe(10_000);
    });

    it('records the account\'s own curve and drawdown across markets', () => {
        const account = new PaperAccount({ settings, symbol: BTC });
        const btc = open(account, BTC, 100, 1);
        btc.onBar(bar(90));
        btc.onBar(bar(100));
        expect(account.stats().maxDrawdown).toBeCloseTo(10, 6);
        expect(account.result().equityCurve.length).toBeGreaterThan(0);
    });

    it('names itself by its market, or by how many it has traded', () => {
        const account = new PaperAccount({ settings, symbol: BTC });
        expect(account.title).toBe(BTC);
        open(account, BTC, 100, 1);
        open(account, ETH, 50, 1);
        expect(account.title).toBe('2 markets');
    });
});

describe('writing a multi-market account down', () => {
    const roundTrip = (snapshot: PaperAccountSnapshot): PaperAccountSnapshot => JSON.parse(JSON.stringify(snapshot));

    it('reads back the same: markets, positions, cash and the curve', () => {
        const account = new PaperAccount({ settings, symbol: BTC });
        const btc = open(account, BTC, 100, 1);
        btc.onBar(bar(105));
        account.closeOne(btc.broker.position!.id);
        const eth = open(account, ETH, 50, 2);
        eth.onBar(bar(52));

        const stored = roundTrip(account.snapshot());
        const back = new PaperAccount({ settings, restore: stored });

        expect(back.legs().map((l) => l.symbol)).toEqual([BTC, ETH]);
        expect(back.openCount).toBe(1);
        expect(back.cash()).toBeCloseTo(account.cash(), 6);
        expect(back.equity()).toBeCloseTo(account.equity(), 6);
        expect(back.tradeCount).toBe(1);
        expect(back.result().equityCurve.length).toBe(account.result().equityCurve.length);
        expect(back.openedAt).toBe(account.openedAt);
    });

    it('keeps the first market where an older reader looks for it', () => {
        const account = new PaperAccount({ settings, symbol: BTC });
        open(account, BTC, 100, 1);
        const stored = account.snapshot();
        expect(stored.symbol).toBe(BTC);
        expect((stored.session as { broker: unknown }).broker).toBeTruthy();
    });

    it('does not write a market that never did anything, but always writes the first', () => {
        const account = new PaperAccount({ settings, symbol: BTC });
        account.legFor(ETH).onBar(bar(50));
        const stored = account.snapshot();
        expect(stored.symbol).toBe(BTC);
        expect(stored.extra.legs).toHaveLength(0);
    });

    it('reads a record from before there was more than one market', () => {
        // What a one-market account wrote: a controller's own snapshot, and nothing else.
        const old = new PaperController({ symbol: BTC, settings });
        old.onBar(bar(100));
        old.order({ side: 'buy', size: 1 });
        old.onBar(bar(104));
        old.closeOne(old.broker.positions[0]!.id);
        const record = old.snapshot();

        const account = new PaperAccount({ settings, restore: { symbol: record.symbol, session: record.session } });

        expect(account.legs()).toHaveLength(1);
        expect(account.cash()).toBeCloseTo(10_004, 6);
        expect(account.tradeCount).toBe(1);
        expect(account.openedAt).toBe(old.openedAt);
        // Its curve is where the account's curve begins.
        expect(account.result().equityCurve.length).toBeGreaterThan(0);
        // And a market it has never been on starts from the same money.
        expect(account.legFor(ETH).equity()).toBeCloseTo(10_004, 6);
    });
});
