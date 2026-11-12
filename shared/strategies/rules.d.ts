import type { ZodType } from 'zod/v4';

export type RuleField = 'open' | 'high' | 'low' | 'close' | 'volume';
export type RuleOperand = number | { series: string; offset: number };
export interface RuleCondition {
    left: RuleOperand;
    op: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'crossesAbove' | 'crossesBelow';
    right: RuleOperand;
}
export interface RuleGroup { all: RuleCondition[] }
export interface RuleStrategy {
    id: string;
    name: string;
    description: string;
    timeframe: string;
    indicators: { id: string; type: 'sma' | 'ema' | 'rsi' | 'atr' | 'highest' | 'lowest'; source: RuleField; period: number }[];
    long: RuleGroup[];
    short: RuleGroup[];
    exitLong: RuleGroup[];
    exitShort: RuleGroup[];
    stop: { type: 'percent' | 'points' | 'atr'; value: number; atrPeriod: number };
    maxHoldBars: number;
}
export declare const RULE_FIELDS: RuleField[];
export declare const ruleStrategySchema: ZodType<RuleStrategy>;
export declare function validateRuleStrategy(input: unknown): RuleStrategy;
