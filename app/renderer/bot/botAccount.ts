import type { Order, OrderSpec, Position } from '../../../shared/engine/broker.js';
import type { CapitalController } from '../trading/CapitalController';
import type { PaperController } from '../trading/PaperController';

/**
 * The account, as far as a running strategy needs one.
 *
 * A strategy asks the same five questions of a paper engine and of a real venue — what is
 * this worth, what is open, what is waiting, put this on, take that off — and gets them
 * answered by two things that are not remotely alike. A paper account IS the engine and
 * answers instantly and exactly; a live account is a client of a venue that has already
 * decided, answers a second late, and can refuse after saying yes.
 *
 * This is where that difference is absorbed, once, so {@link botContext} never has to know
 * which of the two it is driving. Nothing here smooths the difference away — see the
 * comments on {@link BotAccount.order} and the live adapter's own — it only puts both
 * behind one shape.
 *
 * What is deliberately NOT here
 * -----------------------------
 * The feed. A paper account has to be played bars to fill anything, and a live one fills
 * whether anybody is watching; the runner does each of those itself, because they are not
 * two implementations of one idea, they are two different jobs (see BotRunner.ts).
 */

/** A position, in the fields a strategy can read off one. */
export type BotPosition = Pick<Position, 'id' | 'size' | 'entryPrice'> & Partial<Position>;

/** A resting order, in the fields a strategy can read off one. */
export type BotOrder = Pick<Order, 'id' | 'side' | 'size'> & Partial<Order>;

export interface BotAccount {
    /** What the account is worth, marked at the last price. */
    equity(): number;
    /** Settled cash. On a live account this is the venue's own single figure — it does not
     *  separate the two, and inventing the split would be a number nobody stated. */
    balance(): number;
    /** The last price the account has been marked at, or 0 before there is one. */
    price(): number;
    /** The two sides of the book, where the venue quotes them. Null where it quotes one. */
    quote(): { bid: number; ask: number } | null;
    positions(): readonly BotPosition[];
    /** What is on the book and has not filled. */
    pending(): readonly BotOrder[];

    /**
     * Place an order, and answer with the id the strategy will address it by.
     *
     * On paper the id IS the engine's, and everything the strategy does with it lands on
     * the same order. On a live account nothing has an id yet — the venue has not taken
     * delivery, let alone confirmed — so the id is the bot's own and is matched to the
     * venue's order when one appears. See the live adapter's {@link cancel}.
     *
     * Throws where the account refuses outright. A live venue's later refusal cannot come
     * back this way and reaches the bot's log instead.
     */
    order(spec: OrderSpec): { id: number };
    /** Take a resting order off the book. Answers whether there was one to take off. */
    cancel(id: number): boolean;
    /** Take every resting order off. Answers how many. */
    cancelAll(tag?: string | null): number;
    /** Close what is open, at market. */
    close(tag?: string): void;
    /** Close everything and cancel everything — what a guard does at the end of a window. */
    flatten(): void;
}

/** The bot's own paper engine, behind the shared shape. */
export function paperAccount(controller: PaperController): BotAccount {
    return {
        equity: () => controller.equity(),
        balance: () => controller.broker.balance,
        price: () => controller.price(),
        // A paper account is marked from the chart's candles, which are one price.
        quote: () => null,
        positions: () => controller.broker.positions,
        pending: () => controller.broker.pending,
        order: (spec) => controller.order(spec),
        cancel: (id) => controller.cancelOrder(id),
        cancelAll: (tag) => {
            const before = controller.broker.pending.length;
            controller.cancelAll(tag ?? undefined);
            return before - controller.broker.pending.length;
        },
        close: (tag) => controller.close(tag),
        flatten: () => {
            controller.cancelAll();
            controller.flatten();
        },
    };
}

/** A live account, plus the binding between the bot's order ids and the venue's. */
export interface LiveBotAccount extends BotAccount {
    /** Every order id that is bound to a venue deal id, for a strategy state stored with it. */
    orderIds(): Array<[number, string]>;
}

/**
 * A strategy keeps its own order ids; only a dealing confirmation binds them to venue ids.
 *
 * `restored` is that binding from before a restart. A strategy state that survived the
 * restart names orders by the ids it was given then, so a working order found on the book
 * under one of those deal ids keeps its id instead of being issued a new one. `onBound` is
 * told when a new binding exists, so it can be stored before the next bar closes.
 */
export function liveAccount(
    controller: CapitalController,
    restored: ReadonlyArray<[number, string]> = [],
    onBound?: () => void,
): LiveBotAccount {
    const asked = new Map<number, { spec: OrderSpec; dealId: string | null; cancelRequested: boolean }>();
    const kept = new Map(restored.map(([id, dealId]) => [dealId, id]));
    let nextId = restored.reduce((next, [id]) => Math.max(next, id + 1), 1);

    const pending = (): BotOrder[] => {
        for (const [id, order] of asked) {
            if (order.dealId != null && !controller.hasWorkingDeal(order.dealId)) asked.delete(id);
        }
        const rows: BotOrder[] = controller.orders().map((row) => {
            let pair = [...asked].find(([, order]) => order.dealId === row.dealId);
            if (!pair) {
                const id = kept.get(row.dealId) ?? nextId++;
                const spec: OrderSpec = { side: row.side, size: row.size, type: row.kind,
                    ...(row.kind === 'limit' ? { limitPrice: row.price } : { stopPrice: row.price }) };
                const order = { spec, dealId: row.dealId, cancelRequested: false };
                asked.set(id, order);
                pair = [id, order];
            }
            return { ...pair[1].spec, id: pair[0], size: row.size,
                type: row.kind, limitPrice: row.kind === 'limit' ? row.price : null,
                stopPrice: row.kind === 'stop' ? row.price : null };
        });
        for (const [id, order] of asked) {
            if (!rows.some(row => row.id === id)) rows.push({ ...order.spec, id });
        }
        return rows;
    };

    const requestCancel = (order: { dealId: string | null; cancelRequested: boolean }): void => {
        order.cancelRequested = true;
        try {
            controller.cancelWorkingDeal(order.dealId!, () => { order.cancelRequested = false; });
        } catch (error) {
            order.cancelRequested = false;
            throw error;
        }
    };

    const cancel = (id: number): boolean => {
        // An order from before a restart is only known once the book has been read.
        if (!asked.has(id)) pending();
        const order = asked.get(id);
        if (!order || order.cancelRequested) return false;
        if (order.dealId != null && !controller.hasWorkingDeal(order.dealId)) {
            asked.delete(id);
            return false;
        }
        if (order.dealId == null) {
            order.cancelRequested = true;
            return true;
        }
        requestCancel(order);
        return true;
    };

    return {
        equity: () => controller.equity(),
        balance: () => controller.equity(),
        price: () => controller.price(),
        quote: () => controller.quote(),
        positions: () => controller.positions(),
        pending,
        orderIds: () => {
            pending();
            const bound: Array<[number, string]> = [];
            for (const [id, order] of asked) if (order.dealId != null) bound.push([id, order.dealId]);
            return bound;
        },
        order: (requested) => {
            const spec = requested.reduceOnly ? requested : withLevels(requested, controller.quote());
            const id = nextId++;
            const resting = spec.type === 'limit' || spec.type === 'stop';
            if (resting) asked.set(id, { spec: { ...spec }, dealId: null, cancelRequested: false });
            try {
                controller.order(spec, (confirmation) => {
                    const order = asked.get(id);
                    if (!order) return;
                    if (!confirmation.accepted) { asked.delete(id); return; }
                    if (!confirmation.dealId) return;
                    order.dealId = confirmation.dealId;
                    onBound?.();
                    if (order.cancelRequested) requestCancel(order);
                });
            } catch (error) {
                asked.delete(id);
                throw error;
            }
            return { id };
        },
        cancel,
        cancelAll: (tag) => {
            const ids = pending().filter((order) => tag == null || order.tag === tag).map((order) => order.id);
            return ids.reduce((count, id) => count + (cancel(id) ? 1 : 0), 0);
        },
        close: () => {
            for (const position of controller.positions()) controller.closeOne(position.id);
        },
        flatten: () => {
            pending();
            /* Every cancel and every close is attempted. One that cannot be sent must not
             * leave the rest of the book standing; the first failure is reported after. */
            const failures: unknown[] = [];
            const attempt = (run: () => void): void => {
                try { run(); } catch (error) { failures.push(error); }
            };
            for (const id of [...asked.keys()]) attempt(() => cancel(id));
            for (const position of controller.positions()) attempt(() => controller.closeOne(position.id));
            if (failures.length > 0) throw failures[0];
        },
    };
}

/**
 * State a bracket's distances as levels, which is the only form this venue is sent.
 *
 * A strategy may measure its stop from the fill. The venue attaches protection to the
 * opening request, before there is a fill, so the distance is measured from the price the
 * order is expected to trade at: its own level for a resting order, the side of the quote
 * it will cross for a market one. Slippage between that price and the fill moves the risk
 * by the same amount, which a stop attached afterwards would not avoid either.
 */
function withLevels(spec: OrderSpec, quote: { bid: number; ask: number } | null): OrderSpec {
    const bracket = spec.bracket;
    if (!bracket || (bracket.stopDistance == null && bracket.targetDistance == null)) return spec;
    const reference = spec.type === 'limit' ? spec.limitPrice
        : spec.type === 'stop' ? spec.stopPrice
        : spec.side === 'buy' ? quote?.ask : quote?.bid;
    if (reference == null || !Number.isFinite(reference) || !(reference > 0)) {
        throw new Error('There is no current price to measure the stop distance from.');
    }
    const direction = spec.side === 'buy' ? 1 : -1;
    const { stopDistance, targetDistance, ...levels } = bracket;
    return {
        ...spec,
        bracket: {
            ...levels,
            ...(stopDistance != null ? { stopLoss: reference - direction * stopDistance } : {}),
            ...(targetDistance != null ? { takeProfit: reference + direction * targetDistance } : {}),
        },
    };
}
