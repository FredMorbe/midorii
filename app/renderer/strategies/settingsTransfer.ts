import { resolveStrategyParams } from './index';
import type { StrategyParams } from './types';

export interface StrategySettingsSnapshot {
    strategy: string;
    params: StrategyParams;
    timeframe: string;
}

/** Keep the tested configuration independent of later form edits. */
export function strategySettingsSnapshot(
    strategy: string,
    params: Readonly<Record<string, unknown>>,
    timeframe: string,
): StrategySettingsSnapshot {
    if (savedStrategyTimeframe({ __timeframe: timeframe }) == null) {
        throw new Error('The strategy settings need a valid bar interval.');
    }
    return { strategy, params: resolveStrategyParams(strategy, params), timeframe };
}

/** The bar interval is configuration metadata, never a strategy parameter. */
export function storedStrategySettings(snapshot: StrategySettingsSnapshot): Record<string, unknown> {
    return { ...resolveStrategyParams(snapshot.strategy, snapshot.params), __timeframe: snapshot.timeframe };
}

export function savedStrategyTimeframe(settings: Readonly<Record<string, unknown>>): string | null {
    return typeof settings.__timeframe === 'string' && /^(?:[1-9]\d*|D|1D|W|1W|M|1M)$/.test(settings.__timeframe)
        ? settings.__timeframe : null;
}
