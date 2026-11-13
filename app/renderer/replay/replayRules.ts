import type { VelaWorkspace } from '../../../src/workspace';
import { flattenAll, wireProp, type PropWiring } from '../trading/propBand';
import type { ReplayController } from './ReplayController';
import { tradeHistory, type ClosedTrade, type HistoryRow } from './tradeBook';

/** The key a replay's rules are kept under — one rule set for every session, whichever it is. */
export const REPLAY_ACCOUNT_KEY = 'replay';

export interface ReplayRules {
    prop: PropWiring;
    /** Closed round trips, newest first — cached against the trade count, and against the account being replaced by a jump. */
    history(): readonly HistoryRow[];
    /** Throws where this order would break a limit. Every way into the market passes through it. */
    guardOrder(spec: { side: 'buy' | 'sell'; size: number }): void;
    /** A reverse ends one trade and opens another, so a session that may not open trades may not do it. */
    guardReverse(positionId: number): void;
}

/**
 * The limits a funded account carries, applied to a replay: a floor, a daily limit, a goal,
 * and the checks that refuse an order or close everything when one is past.
 *
 * Judged on the replay's own clock and its own starting balance. "Today" is the market's day
 * the session is standing on, not the wall clock's — a session played over a week of 2024 has
 * a week of days — and the floor is measured from what the session was started with, not from
 * the figure last typed into the dialog. The trailing mark is not stored (see propGuard): a
 * session is made again every time, and its history is whole.
 */
export function wireReplayRules(opts: {
    controller: ReplayController;
    ws: VelaWorkspace;
    /** Repaint — the limits changed under whatever shows them. */
    onChange: () => void;
}): ReplayRules {
    const { controller, ws } = opts;

    let seenBroker: unknown = null;
    let seenTrades = -1;
    let rows: readonly HistoryRow[] = [];
    const history = (): readonly HistoryRow[] => {
        const { broker } = controller;
        if (broker !== seenBroker || broker.trades.length !== seenTrades) {
            rows = tradeHistory(broker.trades as ClosedTrade[]);
            seenBroker = broker;
            seenTrades = broker.trades.length;
        }
        return rows;
    };

    const prop = wireProp({
        account: REPLAY_ACCOUNT_KEY,
        name: 'This replay',
        host: ws.root,
        equity: () => controller.equity(),
        openPnl: () => controller.account().open ?? 0,
        history,
        flatten: () => flattenAll({
            positions: () => controller.positions(),
            closeOne: (id) => controller.closeOne(id),
            cancelAll: () => controller.cancelAll(),
        }),
        notify: (message, kind) => ws.toast(message, kind),
        onChange: opts.onChange,
        now: () => controller.session.clock,
        ephemeralMark: true,
        simulated: true,
        startBalance: () => controller.broker.initialBalance,
    });

    return {
        prop,
        history,
        guardOrder: (spec) => prop.guard({ net: controller.broker.netSize, side: spec.side, size: spec.size }),
        guardReverse: (positionId) => {
            const held = controller.broker.positionById(positionId)?.size ?? 0;
            prop.guard({ net: 0, side: held > 0 ? 'sell' : 'buy', size: Math.abs(held) });
        },
    };
}
