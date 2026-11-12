import { z } from 'zod/v4';

export const RULE_FIELDS = ['open', 'high', 'low', 'close', 'volume'];
const name = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/);
const operand = z.union([
  z.number().finite(),
  z.object({ series: name, offset: z.number().int().min(0).max(5000).default(0) }).strict(),
]);
const condition = z.object({
  left: operand,
  op: z.enum(['gt', 'gte', 'lt', 'lte', 'eq', 'crossesAbove', 'crossesBelow']),
  right: operand,
}).strict();
const groups = z.array(z.object({ all: z.array(condition).min(1).max(16) }).strict()).max(8);

/** Alternatives are ORed; the conditions inside each alternative are ANDed. */
export const ruleStrategySchema = z.object({
  id: z.string().regex(/^custom_[a-z0-9][a-z0-9_]{0,47}$/),
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(2000),
  timeframe: z.string().regex(/^(?:[1-9]\d{0,5}|D|W)$/).default('5'),
  indicators: z.array(z.object({
    id: name,
    type: z.enum(['sma', 'ema', 'rsi', 'atr', 'highest', 'lowest']),
    source: z.enum(RULE_FIELDS).default('close'),
    period: z.number().int().min(2).max(5000),
  }).strict()).max(24).default([]),
  long: groups.default([]),
  short: groups.default([]),
  exitLong: groups.default([]),
  exitShort: groups.default([]),
  stop: z.object({
    type: z.enum(['percent', 'points', 'atr']),
    value: z.number().positive().max(1_000_000),
    atrPeriod: z.number().int().min(2).max(5000).default(14),
  }).strict(),
  maxHoldBars: z.number().int().min(1).max(100_000).default(100),
}).strict().superRefine((rule, ctx) => {
  if (rule.long.length + rule.short.length === 0) {
    ctx.addIssue({ code: 'custom', message: 'Define at least one long or short entry.' });
  }
  const known = new Set(RULE_FIELDS);
  for (const indicator of rule.indicators) {
    if (known.has(indicator.id)) ctx.addIssue({ code: 'custom', message: `Duplicate or reserved series: ${indicator.id}` });
    known.add(indicator.id);
  }
  for (const side of ['long', 'short', 'exitLong', 'exitShort']) {
    for (const group of rule[side]) for (const test of group.all) {
      for (const value of [test.left, test.right]) {
        if (typeof value !== 'number' && !known.has(value.series)) {
          ctx.addIssue({ code: 'custom', message: `Unknown series: ${value.series}` });
        }
      }
    }
  }
  if (rule.stop.type === 'percent' && rule.stop.value >= 100) {
    ctx.addIssue({ code: 'custom', message: 'A percentage stop must be less than 100.' });
  }
});

export function validateRuleStrategy(input) {
  return ruleStrategySchema.parse(input);
}
