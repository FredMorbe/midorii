import type { OHLCV } from '../../../src/core/model/ohlcv';
import { sma, ema, rsi, atr, highest, lowest } from '../../../src/core/native-indicators/classics/math';
import type { BacktestContext, RunnableStrategy } from '../../../shared/engine/backtest';
import { RISK_PARAMS, leverageCap, positionSize } from '../../../shared/strategies/risk.js';
import { RULE_FIELDS, validateRuleStrategy, type RuleStrategy, type RuleGroup, type RuleOperand } from '../../../shared/strategies/rules.js';
import type { StrategyParams, StrategySpec, StrategySizing } from './types';

function operand(ctx: BacktestContext<StrategyParams>, value: RuleOperand, back = 0): number | null {
    return typeof value === 'number' ? value : ctx.value(value.series, value.offset + back);
}

function matches(ctx: BacktestContext<StrategyParams>, groups: readonly RuleGroup[]): boolean {
    return groups.some((group) => group.all.every((condition) => {
        const left = operand(ctx, condition.left);
        const right = operand(ctx, condition.right);
        if (left == null || right == null || !Number.isFinite(left) || !Number.isFinite(right)) return false;
        switch (condition.op) {
            case 'gt': return left > right;
            case 'gte': return left >= right;
            case 'lt': return left < right;
            case 'lte': return left <= right;
            case 'eq': return left === right;
            default: {
                const previousLeft = operand(ctx, condition.left, 1);
                const previousRight = operand(ctx, condition.right, 1);
                if (previousLeft == null || previousRight == null
                    || !Number.isFinite(previousLeft) || !Number.isFinite(previousRight)) return false;
                return condition.op === 'crossesAbove'
                    ? previousLeft <= previousRight && left > right
                    : previousLeft >= previousRight && left < right;
            }
        }
    }));
}

function explain(groups: readonly RuleGroup[]): string {
    const value = (v: RuleOperand): string => typeof v === 'number' ? String(v) : `${v.series}[${v.offset}]`;
    return groups.map((g) => g.all.map((c) => `${value(c.left)} ${c.op} ${value(c.right)}`).join(' AND ')).join(' OR ');
}

/** A data descriptor interpreted against the same closed-bar context as built-in strategies. */
export function ruleStrategySpec(input: unknown): StrategySpec {
    const rule = validateRuleStrategy(input);
    return {
        id: rule.id, name: rule.name, description: rule.description, timeframe: rule.timeframe,
        researchOnly: true,
        rules: {
            conditions: [
                ...rule.indicators.map((i) => `${i.id}: ${i.type}(${i.source}, ${i.period}).`),
                ...(rule.long.length ? [`Long: ${explain(rule.long)}.`] : []),
                ...(rule.short.length ? [`Short: ${explain(rule.short)}.`] : []),
                ...(rule.exitLong.length ? [`Exit long: ${explain(rule.exitLong)}.`] : []),
                ...(rule.exitShort.length ? [`Exit short: ${explain(rule.exitShort)}.`] : []),
                'Read completed bars only. One position at a time. Conflicting entry signals are skipped.',
            ],
            entry: 'Market order on the next bar. Research only; unavailable to trading bots.',
            stop: `Distance from the actual fill, measured in ${rule.stop.type}; controlled by Stop distance.`,
            target: 'Stop distance multiplied by Reward / risk. Exit rules and Maximum bars held may close earlier on the next bar.',
            size: 'Risk-based size, with the configured leverage cap and the instrument point value.',
        },
        params: [...RISK_PARAMS,
            { key: 'stopValue', label: `Stop distance (${rule.stop.type})`, type: 'number', default: rule.stop.value,
                min: 0.000001, max: rule.stop.type === 'percent' ? 99.999999 : 1_000_000, step: 0.1 },
            { key: 'maxHoldBars', label: 'Maximum bars held', type: 'number', default: rule.maxHoldBars, min: 1, max: 100_000, step: 1 },
        ],
        detectionKeys: [],
        build: (params, bars, _cache, sizing) => buildRule(rule, params, bars, sizing ?? { pointValue: 1 }),
    };
}

function buildRule(rule: RuleStrategy, params: StrategyParams, bars: readonly OHLCV[], sizing: StrategySizing): RunnableStrategy<StrategyParams> {
    if (!Number.isInteger(params.maxHoldBars)) throw new Error('Maximum bars held must be a whole number.');
    const raw: Record<string, number[]> = Object.fromEntries(
        RULE_FIELDS.map((field) => [field, bars.map((bar) => bar[field] ?? NaN)]),
    );
    for (const indicator of rule.indicators) {
        const source = raw[indicator.source]!;
        raw[indicator.id] = indicator.type === 'atr' ? atr(bars, indicator.period)
            : { sma, ema, rsi, highest, lowest }[indicator.type](source, indicator.period);
    }
    if (rule.stop.type === 'atr') raw.__stopAtr = atr(bars, rule.stop.atrPeriod);
    const series = Object.fromEntries(Object.entries(raw).map(([key, values]) => (
        [key, values.map((value) => Number.isFinite(value) ? value : null)]
    )));
    // Optional/unused volume must not hold every other series in warm-up forever.
    delete series.volume;
    if ([...rule.long, ...rule.short, ...rule.exitLong, ...rule.exitShort].some((g) => g.all.some((c) => (
        [c.left, c.right].some((v) => typeof v !== 'number' && v.series === 'volume')
    )))) series.volume = raw.volume!.map((v) => Number.isFinite(v) ? v : null);

    return {
        params, series,
        onBar(ctx) {
            if (!ctx.isFlat) {
                const entered = ctx.state.entered as number | undefined;
                if (entered === undefined) ctx.state.entered = ctx.index;
                const long = ctx.position!.size > 0;
                if (ctx.index - (entered ?? ctx.index) + 1 >= Number(params.maxHoldBars)
                    || matches(ctx, long ? rule.exitLong : rule.exitShort)) ctx.close('rule-exit');
                return;
            }
            ctx.state.entered = undefined;
            if (ctx.pendingOrders.length > 0) return;
            const long = matches(ctx, rule.long);
            const short = matches(ctx, rule.short);
            if (long === short) return;
            const price = ctx.bar.close;
            const distance = Number(params.stopValue) * (rule.stop.type === 'percent' ? price / 100
                : rule.stop.type === 'atr' ? (ctx.value('__stopAtr') ?? NaN) : 1);
            if (!(distance > 0) || !Number.isFinite(distance) || !(price > distance)) return;
            const size = positionSize(ctx.equity, price, long ? price - distance : price + distance,
                params.riskMode as 'percent' | 'fixed', Number(params.riskValue), leverageCap(params));
            if (size == null) return;
            const units = size / sizing.pointValue;
            // The broker owns rounding. Submit only when at least one permitted quantity fits the risk.
            if (sizing.sizeStep != null) {
                const required = Math.max(1, Math.ceil((sizing.minSize ?? 0) / sizing.sizeStep - 1e-9));
                if (units / sizing.sizeStep + 1e-9 < required) return;
            } else if (!(units > 0) || units < (sizing.minSize ?? 0)) return;
            ctx.order({ side: long ? 'buy' : 'sell', type: 'market', size: units,
                bracket: { stopDistance: distance, targetDistance: distance * Number(params.rrr) }, tag: rule.id });
        },
    };
}
