import { runBacktest } from '../../../shared/engine/backtest';
import type { BacktestBar } from '../../../shared/engine/backtest';
import type { Costs } from '../../../shared/engine/broker';
import { buildStrategy, resolveStrategyParams, strategyCatalog, setRuleStrategies } from '../strategies';
import { runSweep, type SweepOptions } from '../backtest/sweepRunner';
import { expandSweep } from '../../../shared/analysis/sweep.js';
import type { SweepRanges } from '../../../shared/analysis/sweep';

export { strategyCatalog, resolveStrategyParams, setRuleStrategies };

export function validateSweep(strategy: string, params: Record<string, unknown>, ranges: SweepRanges): void {
    const spec = strategyCatalog().find((entry) => entry.id === strategy);
    if (!spec) throw new Error('Unknown strategy');
    for (const [key, range] of Object.entries(ranges)) {
        const field = spec.params.find((entry) => entry.key === key);
        if (field?.type !== 'number') throw new Error(`Sweep setting must be numeric: ${key}`);
        resolveStrategyParams(strategy, { ...params, [key]: range.from });
        resolveStrategyParams(strategy, { ...params, [key]: range.to });
        if (field.step === 1 && ![range.from, range.to, range.step].every(Number.isInteger)) {
            throw new Error(`${key} needs whole-number range endpoints and steps.`);
        }
    }
    const combinations = expandSweep(ranges, params, 5000);
    const unique = new Set<string>();
    for (const combination of combinations) {
        const resolved = resolveStrategyParams(strategy, combination);
        for (const field of spec.params) {
            if (field.type === 'number' && field.step === 1 && !Number.isInteger(resolved[field.key])) {
                throw new Error(`${field.key} must be a whole number.`);
            }
        }
        const signature = JSON.stringify(resolved);
        if (unique.has(signature)) throw new Error('The ranges resolve to duplicate settings; choose a larger step.');
        unique.add(signature);
    }
}

export function executeSweep(request: SweepOptions & { params: Record<string, unknown> }) {
    return runSweep({ ...request, base: request.params });
}

export function executeBacktest(request: {
    strategy: string; params: Record<string, unknown>; bars: BacktestBar[]; baseBars: BacktestBar[] | null;
    balance: number; costs?: Costs; pointValue: number; sizeStep: number | null; minSize: number | null; stepMs: number;
}) {
    const params = resolveStrategyParams(request.strategy, request.params);
    return { ...runBacktest({ bars: request.bars, baseBars: request.baseBars,
        strategy: buildStrategy(request.strategy, params, request.bars, undefined,
            { pointValue: request.pointValue, sizeStep: request.sizeStep, minSize: request.minSize }),
        broker: { balance: request.balance, costs: request.costs, pointValue: request.pointValue,
            sizeStep: request.sizeStep, minSize: request.minSize }, stepMs: request.stepMs }), params };
}
