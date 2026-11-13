import { NO_COSTS } from '../../../shared/engine/broker.js';
import type { Costs, PositionMode } from '../../../shared/engine/broker.js';

/**
 * How a replay account is kept: what it is charged, what a point is worth and the grid a size
 * has to sit on.
 *
 * These are the questions the Backtest tab already asks. A replay that skipped them traded every
 * market as though it were a coin — a gold contract moving a point booked as one dollar — and
 * charged a crypto fee on everything, so a session on an index future reported figures nobody
 * could have earned or lost.
 */
export interface ReplayAccountSettings {
    /** Whether fees, spread and slippage are charged at all. */
    costsOn: boolean;
    /** Money per point per unit. */
    pointValue: number;
    /** The smallest a size may move by, or null for no step. */
    sizeStep: number | null;
    /** The least a position may ever be, or null for no minimum. */
    minSize: number | null;
    /** Whether a second order the other way opens its own position, or reduces the first. */
    hedging: boolean;
}

/** A spot account: what a coin or a share is, and what the engine assumed before these existed. */
export const SPOT_ACCOUNT: ReplayAccountSettings = {
    costsOn: true, pointValue: 1, sizeStep: null, minSize: null, hedging: true,
};

/** What a recording says about the contract it is of, where the gateway had listed it. */
export interface ContractFacts {
    tickSize: number | null;
    tickValue: number | null;
}

const positive = (value: number | null | undefined): number | null => (
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
);

/**
 * Where a fresh setup starts for a dataset.
 *
 * A futures contract is recognised only by what its recording states — tick size and value, the
 * two figures a position's worth is built from — and never by its name. There it is a whole
 * contract at a time, and the crypto cost defaults are plainly wrong, so costs start off. Every
 * other market starts as a spot account with costs on, the Backtest tab's own default: a result
 * that was never charged anything is not a result. Whatever is suggested is shown in the form
 * and can be changed there; nothing is applied out of sight.
 */
export function suggestAccount(contract: ContractFacts | null | undefined): ReplayAccountSettings {
    const tickSize = positive(contract?.tickSize);
    const tickValue = positive(contract?.tickValue);
    if (tickSize == null || tickValue == null) return { ...SPOT_ACCOUNT };
    return { costsOn: false, pointValue: tickValue / tickSize, sizeStep: 1, minSize: 1, hedging: true };
}

/** What the controller is built with, from what the setup asked for. */
export function accountOptions(account: ReplayAccountSettings): {
    costs: Costs | undefined;
    pointValue: number;
    sizeStep: number | null;
    minSize: number | null;
    mode: PositionMode;
} {
    if (!(account.pointValue > 0) || !Number.isFinite(account.pointValue)) {
        throw new Error(`The point value must be above zero, got ${account.pointValue}.`);
    }
    for (const [name, value] of [['size step', account.sizeStep], ['minimum size', account.minSize]] as const) {
        if (value != null && !(value > 0 && Number.isFinite(value))) {
            throw new Error(`The ${name} must be above zero or empty, got ${value}.`);
        }
    }
    return {
        // `undefined` lets the engine's own defaults stand; off is the explicit all-zero set.
        costs: account.costsOn ? undefined : NO_COSTS,
        pointValue: account.pointValue,
        sizeStep: account.sizeStep,
        minSize: account.minSize,
        mode: account.hedging ? 'hedging' : 'netting',
    };
}
