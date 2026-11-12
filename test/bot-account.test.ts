// The bridge that makes a paper engine and a real venue look the same to a running strategy.
// The rules under test: a live order gets an id the bot issued and resolves to the venue's
// own only once the venue has one, an id that resolves to nothing answers honestly rather
// than cancelling something else, and neither adapter ever invents a figure.
// See app/renderer/bot/botAccount.ts.
import { describe, it, expect, vi } from 'vitest';
import { liveAccount, paperAccount } from '../app/renderer/bot/botAccount';
import type { CapitalController } from '../app/renderer/trading/CapitalController';
import type { PaperController } from '../app/renderer/trading/PaperController';
import type { OrderSpec } from '../shared/engine/broker.js';

function fakeCapital() {
    const book: Array<{ id: number; dealId: string; side: 'buy' | 'sell'; price: number; size: number; kind: 'limit' | 'stop' }> = [];
    const owned = new Set<string>();
    const sent: OrderSpec[] = [];
    const cancelled: string[] = [];
    const closed: number[] = [];
    const callbacks: Array<(confirmation: { accepted: boolean; dealId: string | null }) => void> = [];
    const controller = {
        equity: () => 5_000, price: () => 1.09, quote: () => ({ bid: 1.0899, ask: 1.0901 }),
        positions: () => [{ id: 1, size: 1000, entryPrice: 1.088 }],
        orders: () => book,
        order: (spec: OrderSpec, callback: typeof callbacks[number]) => { sent.push(spec); callbacks.push(callback); },
        hasWorkingDeal: (dealId: string) => owned.has(dealId) || book.some((row) => row.dealId === dealId),
        cancelWorkingDeal: (dealId: string) => { cancelled.push(dealId); },
        closeOne: (id: number) => { closed.push(id); },
    };
    return { controller: controller as unknown as CapitalController, sent, cancelled, closed, book, owned,
        confirm: (index: number, dealId: string | null) => {
            if (dealId) owned.add(dealId);
            callbacks[index]!({ accepted: dealId != null, dealId });
        },
    };
}

describe('a live account', () => {
    it('states a distance bracket as levels, measured from the price the order will trade at', () => {
        const venue = fakeCapital();
        const account = liveAccount(venue.controller);
        account.order({ side: 'buy', size: 500, bracket: { stopDistance: 0.01, targetDistance: 0.02 } });
        account.order({ side: 'sell', type: 'stop', size: 500, stopPrice: 1.08, bracket: { stopDistance: 0.01 } });

        // A market buy crosses the ask; a resting order trades at its own level.
        expect(venue.sent[0]!.bracket!.stopLoss).toBeCloseTo(1.0801, 10);
        expect(venue.sent[0]!.bracket!.takeProfit).toBeCloseTo(1.1101, 10);
        expect(venue.sent[0]!.bracket).not.toHaveProperty('stopDistance');
        expect(venue.sent[0]!.bracket).not.toHaveProperty('targetDistance');
        expect(venue.sent[1]!.bracket!.stopLoss).toBeCloseTo(1.09, 10);
    });
    it('attempts every close when going flat, even if one cannot be sent', () => {
        const venue = fakeCapital();
        const positions = [{ id: 1, size: 1000, entryPrice: 1.088 }, { id: 2, size: 1000, entryPrice: 1.089 }];
        const closed: number[] = [];
        Object.assign(venue.controller, {
            positions: () => positions,
            closeOne: (id: number) => {
                if (id === 1) throw new Error('That position is no longer open.');
                closed.push(id);
            },
        });
        const account = liveAccount(venue.controller);
        expect(() => account.flatten()).toThrow(/no longer open/);
        expect(closed).toEqual([2]);
    });
    it('keeps the id a working order had before a restart', () => {
        const venue = fakeCapital();
        venue.book.push({ id: 3, dealId: 'deal-old', side: 'buy', price: 1.1, size: 500, kind: 'stop' });
        const account = liveAccount(venue.controller, [[7, 'deal-old']]);

        // Cancelled by the id a restored strategy state still holds, before anything listed it.
        expect(account.cancel(7)).toBe(true);
        expect(venue.cancelled).toEqual(['deal-old']);
        expect(account.orderIds()).toEqual([[7, 'deal-old']]);
        // A new order never reuses it.
        expect(account.order({ side: 'buy', type: 'limit', size: 500, limitPrice: 1.05 }).id).toBe(8);
    });
    it('says so when an order id becomes bound to a venue deal id', () => {
        const venue = fakeCapital();
        const bound = vi.fn();
        const account = liveAccount(venue.controller, [], bound);
        const order = account.order({ side: 'buy', type: 'limit', size: 500, limitPrice: 1.1 });
        expect(bound).not.toHaveBeenCalled();
        venue.confirm(0, 'deal-new');
        expect(bound).toHaveBeenCalledTimes(1);
        expect(account.orderIds()).toEqual([[order.id, 'deal-new']]);
    });
    it('reports the venue figures', () => {
        const account = liveAccount(fakeCapital().controller);
        expect(account.equity()).toBe(5_000);
        expect(account.balance()).toBe(5_000);
        expect(account.quote()).toEqual({ bid: 1.0899, ask: 1.0901 });
    });
    it('reserves an unconfirmed entry and preserves its strategy id on the confirmed book', () => {
        const venue = fakeCapital();
        const account = liveAccount(venue.controller);
        const order = account.order({ side: 'buy', type: 'limit', size: 500, limitPrice: 1.1, tag: 'setup' });
        expect(account.pending()[0]?.id).toBe(order.id);
        venue.confirm(0, 'confirmed-order');
        venue.book.push({ id: 42, dealId: 'confirmed-order', side: 'buy', price: 1.1, size: 500, kind: 'limit' });
        expect(account.pending()[0]).toMatchObject({ id: order.id, tag: 'setup', type: 'limit' });
        expect(account.cancel(order.id)).toBe(true);
        expect(venue.cancelled).toEqual(['confirmed-order']);
    });
    it('cancels by the exact confirmed identity even if another order has the same price', () => {
        const venue = fakeCapital();
        const account = liveAccount(venue.controller);
        const order = account.order({ side: 'buy', type: 'stop', size: 500, stopPrice: 1.1 });
        venue.book.push({ id: 99, dealId: 'other-order', side: 'buy', price: 1.1, size: 500, kind: 'stop' });
        venue.confirm(0, 'own-order');
        expect(account.cancel(order.id)).toBe(true);
        expect(venue.cancelled).toEqual(['own-order']);
    });
    it('remembers a cancellation requested before the create is confirmed', () => {
        const venue = fakeCapital();
        const account = liveAccount(venue.controller);
        const order = account.order({ side: 'buy', type: 'limit', size: 500, limitPrice: 1.1 });
        expect(account.cancel(order.id)).toBe(true);
        expect(venue.cancelled).toEqual([]);
        venue.confirm(0, 'late-order');
        expect(venue.cancelled).toEqual(['late-order']);
        expect(account.cancel(order.id)).toBe(false);
    });
    it('drops a rejected entry without cancelling a different order', () => {
        const venue = fakeCapital();
        const account = liveAccount(venue.controller);
        const order = account.order({ side: 'buy', type: 'limit', size: 500, limitPrice: 1.1 });
        venue.confirm(0, null);
        expect(account.pending()).toEqual([]);
        expect(account.cancel(order.id)).toBe(false);
        expect(venue.cancelled).toEqual([]);
    });
    it('does not cancel an order that has already filled', () => {
        const venue = fakeCapital();
        const account = liveAccount(venue.controller);
        const order = account.order({ side: 'buy', type: 'limit', size: 500, limitPrice: 1.1 });
        venue.confirm(0, 'filled-order');
        venue.owned.delete('filled-order');
        expect(account.cancel(order.id)).toBe(false);
    });
    it('assigns stable local ids to restored owned orders', () => {
        const venue = fakeCapital();
        venue.book.push({ id: 7, dealId: 'restored-order', side: 'buy', price: 1.1, size: 500, kind: 'limit' });
        const account = liveAccount(venue.controller);
        const id = account.pending()[0]!.id;
        expect(account.pending()[0]!.id).toBe(id);
        expect(account.cancel(id)).toBe(true);
        expect(venue.cancelled).toEqual(['restored-order']);
    });
    it('cancels only the requested tag, including a create that is still in flight', () => {
        const venue = fakeCapital();
        const account = liveAccount(venue.controller);
        account.order({ side: 'buy', type: 'limit', size: 500, limitPrice: 1.1, tag: 'first' });
        account.order({ side: 'sell', type: 'limit', size: 500, limitPrice: 1.2, tag: 'second' });
        expect(account.cancelAll('first')).toBe(1);
        venue.confirm(0, 'first-order');
        venue.confirm(1, 'second-order');
        expect(venue.cancelled).toEqual(['first-order']);
    });
    it('has no resting id for a market order', () => {
        const venue = fakeCapital();
        const account = liveAccount(venue.controller);
        const order = account.order({ side: 'buy', size: 500 });
        expect(account.cancel(order.id)).toBe(false);
    });
    it('closes owned positions and remembers in-flight cancellations on flatten', () => {
        const venue = fakeCapital();
        const account = liveAccount(venue.controller);
        account.order({ side: 'buy', type: 'limit', size: 500, limitPrice: 1.1 });
        account.flatten();
        venue.confirm(0, 'late-order');
        expect(venue.cancelled).toEqual(['late-order']);
        expect(venue.closed).toEqual([1]);
    });
});

describe('a paper account', () => {
    it('passes the engine’s own ids straight through', () => {
        const order = vi.fn(() => ({ id: 17 }));
        const controller = {
            equity: () => 10_000,
            price: () => 100,
            broker: { balance: 9_000, positions: [], pending: [] },
            order,
            cancelOrder: vi.fn(() => true),
            cancelAll: vi.fn(),
            flatten: vi.fn(),
            close: vi.fn(),
        } as unknown as PaperController;

        const account = paperAccount(controller);
        expect(account.order({ side: 'buy', size: 1 }).id).toBe(17);
        expect(account.balance()).toBe(9_000);
        // A paper account is marked from the chart's candles, which are one price.
        expect(account.quote()).toBeNull();
    });

    it('reports how many orders a cancel-all actually took off', () => {
        const pending = [{ id: 1 }, { id: 2 }];
        const controller = {
            equity: () => 10_000,
            price: () => 100,
            broker: { balance: 9_000, positions: [], get pending() { return pending; } },
            cancelAll: () => { pending.length = 0; },
        } as unknown as PaperController;

        expect(paperAccount(controller).cancelAll()).toBe(2);
    });
});


it('keeps a confirmed entry reserved before the next book snapshot', () => {
    const venue = fakeCapital();
    const account = liveAccount(venue.controller);
    const order = account.order({ side: 'buy', type: 'limit', size: 500, limitPrice: 1.1 });
    venue.confirm(0, 'confirmed-not-visible');
    expect(account.pending()).toMatchObject([{ id: order.id, size: 500 }]);
});

it('allows a deliberate cancellation retry after a failed cancellation has settled', () => {
    const venue = fakeCapital();
    let finished: (() => void) | undefined;
    venue.controller.cancelWorkingDeal = (_id: string, complete?: () => void) => { finished = complete; };
    const account = liveAccount(venue.controller);
    const order = account.order({ side: 'buy', type: 'limit', size: 500, limitPrice: 1.1 });
    venue.confirm(0, 'order-to-cancel');
    expect(account.cancel(order.id)).toBe(true);
    expect(account.cancel(order.id)).toBe(false);
    expect(finished).toBeTypeOf('function');
    finished?.();
    expect(account.cancel(order.id)).toBe(true);
});
