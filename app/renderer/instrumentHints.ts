import { DEFAULT_COSTS } from '../../shared/engine/broker.js';

/**
 * What the four instrument settings mean, said once.
 *
 * The Backtest tab and the Replay setup ask the same four questions of the same engine, and a
 * hint that drifted between them would tell one screen's user something the other's contradicts.
 */

export const COSTS_HINT = 'Commission, spread and slippage. The defaults are a crypto account’s '
    + `(${(DEFAULT_COSTS.feeRate * 100).toFixed(2)}% of notional per side, `
    + `${(DEFAULT_COSTS.spreadPct * 100).toFixed(2)}% spread, `
    + `${(DEFAULT_COSTS.slippagePct * 100).toFixed(2)}% slippage) and belong to no `
    + 'other instrument — on an index future that fee alone can be several times '
    + 'the trade’s entire risk. Off charges nothing: every stop fills exactly at the '
    + 'stop and every target exactly at the target, which is the ceiling of what the '
    + 'rules could ever make and not a result anybody could have had.';

export const POINT_VALUE_HINT = 'Money per point per unit. 1 is a spot assumption — a coin, a share, a CFD unit, '
    + 'where a point of price movement is a point of account money. A futures '
    + 'contract is not: one gold contract moving a point is $100, and left at 1 '
    + 'every figure this run reports — P&L, drawdown, fees, size — states that '
    + 'instrument a hundred times too small.';

export const SIZE_STEP_HINT = 'The smallest a position may move by — a futures contract, a share lot. Sizes are '
    + 'rounded down onto it before an order is ever placed, the same rounding a '
    + 'live venue enforces, so a strategy cannot trade a fraction nobody could '
    + 'actually hold. Empty for an instrument with no step, such as a coin.';

export const MIN_SIZE_HINT = 'The least a position may ever be. A size that rounds under it refuses rather '
    + 'than silently trading zero. Empty for no minimum.';
