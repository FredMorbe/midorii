import { runBacktest, type BacktestBar } from '../../../shared/engine/backtest';
import { DEFAULT_COSTS, type Costs } from '../../../shared/engine/broker';
import { searchSpace, searchParams, type SearchAxis } from '../../../shared/analysis/searchPlan.js';
import { RANK_METRICS } from '../../../shared/analysis/sweep.js';
import type { RankMetricId } from '../../../shared/analysis/sweep';
import { buildStrategy, resolveStrategyParams, strategyCatalog, type DetectionCache } from '../strategies';
import { alignSplitToBars, sliceBars, summarizeBacktest } from './experiment';
import { setRuleStrategies } from '../strategies';
import type { RuleStrategy } from '../../../shared/strategies/rules.js';

export interface SearchConfig {
    definitions?: RuleStrategy[];
    name: string;
    strategy: string;
    axes: Record<string, SearchAxis>;
    base: Record<string, unknown>;
    method: 'grid' | 'random';
    seed: string;
    maxAttempts: number;
    budgetMs: number;
    workers: number;
    metric: RankMetricId;
    minTrades: number;
    balance: number;
    costs: Costs;
    pointValue: number;
    sizeStep: number | null;
    minSize: number | null;
}

export function validateSearch(input: SearchConfig): SearchConfig {
    setRuleStrategies(input.definitions ?? []);
    const spec = strategyCatalog().find((s) => s.id === input.strategy);
    if (!spec) throw new Error('Unknown strategy');
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 120) throw new Error('Give the job a name (up to 120 characters)');
    if (input.method !== 'grid' && input.method !== 'random') throw new Error('Choose grid or random search');
    if (typeof input.seed !== 'string' || input.seed.length > 120) throw new Error('Invalid random seed');
    if (!RANK_METRICS[input.metric]) throw new Error('Unknown ranking metric');
    for (const [key, max] of [['maxAttempts', 10_000_000], ['workers', 8], ['minTrades', 1_000_000]] as const) {
        const n = input[key];
        if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`${key}: choose a whole number between 1 and ${max}`);
    }
    if (!Number.isFinite(input.budgetMs) || input.budgetMs < 1000 || input.budgetMs > 90 * 86_400_000) throw new Error('Choose a runtime between one second and 90 days');
    if (!Number.isFinite(input.balance) || input.balance <= 0 || !Number.isFinite(input.pointValue) || input.pointValue <= 0) throw new Error('Balance and point value must be positive');
    for (const key of ['sizeStep', 'minSize'] as const) {
        if (input[key] !== null && (!Number.isFinite(input[key]) || input[key]! <= 0)) throw new Error(`${key} must be positive or empty`);
    }
    const base = resolveStrategyParams(input.strategy, input.base);
    const space = searchSpace(input.axes);
    for (const [key, values] of space.entries) {
        if (!spec.params.some((p) => p.key === key)) throw new Error(`Unknown setting: ${key}`);
        const normalized = values.map((value) => resolveStrategyParams(input.strategy, { ...base, [key]: value })[key]);
        if (new Set(normalized.map((value) => JSON.stringify(value))).size !== values.length) throw new Error(`${key}: choices resolve to repeated settings`);
    }
    const costs = { ...DEFAULT_COSTS, ...input.costs };
    for (const [key, value] of Object.entries(costs)) {
        if (!Number.isFinite(value) || value < 0) throw new Error(`${key}: costs must be non-negative numbers`);
    }
    return { ...input, name: input.name.trim(), base, costs };
}

export function searchPeriods(bars: readonly BacktestBar[], stepMs: number) {
    if (bars.length < 10) throw new Error('At least ten complete bars are needed for three test periods');
    const from = bars[0]!.time;
    const to = bars[bars.length - 1]!.time + stepMs;
    const trainSplit = alignSplitToBars({ train: { from, to: from + (to - from) * 0.6 }, test: { from: 0, to } }, bars);
    const checkSplit = alignSplitToBars({ train: { from, to: from + (to - from) * 0.8 }, test: { from: 0, to } }, bars);
    const periods = {
        train: { from, to: trainSplit.train.to },
        validation: { from: trainSplit.train.to, to: checkSplit.train.to },
        holdout: { from: checkSplit.train.to, to },
    };
    for (const range of Object.values(periods)) {
        if (sliceBars(bars, range.from, range.to).length < 2) throw new Error('Each test period needs at least two bars; choose a longer range');
    }
    return periods;
}

/** Detection caches are bounded independently of how many attempts the job runs. */
class BoundedCache extends Map<string, unknown> {
    override set(key: string, value: unknown): this {
        if (!this.has(key) && this.size >= 16) this.delete(this.keys().next().value!);
        return super.set(key, value);
    }
}

export function createSearchExperiment(config: SearchConfig, bars: BacktestBar[], baseBars: BacktestBar[] | null, stepMs: number) {
    setRuleStrategies(config.definitions ?? []);
    const periods = searchPeriods(bars, stepMs);
    const space = searchSpace(config.axes);
    const broker = { balance: config.balance, costs: config.costs, pointValue: config.pointValue, sizeStep: config.sizeStep, minSize: config.minSize };
    const prepared = new Map<string, { bars: BacktestBar[]; base: BacktestBar[] | null; cache: DetectionCache }>();
    function run(params: Record<string, unknown>, period: keyof typeof periods) {
        const range = periods[period];
        let held = prepared.get(period);
        if (!held) {
            held = { bars: sliceBars(bars, bars[0]!.time, range.to), base: baseBars ? sliceBars(baseBars, bars[0]!.time, range.to) : null, cache: new BoundedCache() };
            prepared.set(period, held);
        }
        const resolved = resolveStrategyParams(config.strategy, params);
        return runBacktest({ bars: held.bars, baseBars: held.base, strategy: buildStrategy(config.strategy, resolved, held.bars, held.cache,
            { pointValue: config.pointValue, sizeStep: config.sizeStep, minSize: config.minSize }), broker, stepMs, tradeFrom: range.from });
    }
    return {
        periods,
        evaluate(index: number) {
            const params = resolveStrategyParams(config.strategy, searchParams(space, config.base, index, config.method, config.seed));
            const train = run(params, 'train');
            const validation = run(params, 'validation');
            return { params, stats: summarizeBacktest(train), validation: summarizeBacktest(validation), resolution: train.resolution, elapsedMs: train.elapsedMs + validation.elapsedMs };
        },
        run,
    };
}

export { strategyCatalog };
