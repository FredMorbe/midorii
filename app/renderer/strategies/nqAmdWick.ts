import { detectRangeFakeouts, type RangeFakeoutSetup } from '../../../src/core/analysis/rangeFakeout';
import { RISK_PARAMS, leverageCap, positionSize, type RiskMode } from '../../../shared/strategies/risk.js';
import { cached, detectionCacheKey } from './detection';
import type { StrategyParam, StrategySpec } from './types';

const DETECTION_KEYS = ['minBars', 'compression', 'maxFakeoutBars'] as const;
const RISK_DEFAULTS: Record<string, string | number | boolean> = {
    riskMode: 'fixed', riskValue: 2000, capLeverage: true, maxLeverage: 20, rrr: 1.5,
};

function preset(timeframe: '1' | '3', compression: number): StrategySpec {
    return {
        id: `nq_amd_wick_${timeframe}m`,
        name: `NQ AMD Wick ${timeframe}m`,
        description: 'NQ research preset: a wick sweeps a confirmed range, then a close through its frozen midpoint confirms the opposite entry. Tested with $200,000 starting capital; the historical win-rate target remains unmet.',
        timeframe,
        backtestDefaults: { symbol: 'NQ', balance: 200_000, pointValue: 20, sizeStep: 1, minSize: 1 },
        researchOnly: true,
        rules: {
            conditions: [
                'A compressed range has at least two separate touches of each edge.',
                'The first wick strictly beyond one edge freezes the range. A candle sweeping both edges is skipped.',
                'The sweep candle or a later candle within the confirmation window closes strictly through the midpoint in the opposite direction. No fair value gap is required.',
                'Range and confirmation bars must be contiguous. One position or pending order at a time; no daily maximum or forced entries.',
            ],
            entry: 'Opposite market order after the confirmation close, filling no earlier than the next bar open.',
            stop: 'Fixed points from the actual fill. Defaults: 100 NQ points, one whole contract and $2,000 planned risk before costs.',
            target: 'Stop distance multiplied by reward/risk, 1.5R by default. Close on the next open after the maximum holding period.',
            size: 'Whole NQ contracts at $20 per point. Skip the entry if the minimum size or leverage ceiling prevents the exact planned cash risk.',
        },
        params: [
            ...RISK_PARAMS.map((param): StrategyParam => ({ ...param, default: RISK_DEFAULTS[param.key] ?? param.default })),
            { key: 'minBars', label: 'Range min bars', type: 'number', default: 5, min: 5, max: 100, step: 1 },
            { key: 'compression', label: 'Range compression', type: 'number', default: compression, min: 0.1, max: 3, step: 0.05 },
            { key: 'maxFakeoutBars', label: 'Fakeout window', type: 'number', default: 12, min: 1, max: 100, step: 1 },
            { key: 'stopValue', label: 'Stop distance (NQ points)', type: 'number', default: 100, min: 0.25, max: 1000, step: 0.25 },
            { key: 'maxHoldBars', label: 'Maximum holding bars', type: 'number', default: 600, min: 1, max: 1000, step: 1 },
        ],
        detectionKeys: DETECTION_KEYS,
        build(params, bars, cache, sizing = { pointValue: 20, sizeStep: 1, minSize: 1 }) {
            if (sizing.pointValue !== 20) throw new Error('NQ AMD presets require the NQ point value of $20.');
            const step = sizing.sizeStep ?? 1;
            const minimum = sizing.minSize ?? 1;
            if (!Number.isInteger(step) || step < 1 || !Number.isInteger(minimum) || minimum < 1) {
                throw new Error('NQ AMD presets require whole-contract minimum and size step.');
            }
            for (const key of ['minBars', 'maxFakeoutBars', 'maxHoldBars']) {
                if (!Number.isInteger(params[key])) throw new Error(`${key} must be a whole number.`);
            }
            const distance = Number(params.stopValue);
            if (Math.abs(distance / 0.25 - Math.round(distance / 0.25)) > 1e-6) {
                throw new Error('NQ stop distance must use 0.25-point increments.');
            }
            const setups = cached(cache, detectionCacheKey(`nq-amd-wick-${timeframe}`, params, DETECTION_KEYS), () => (
                detectRangeFakeouts(bars, {
                    range: { minBars: Number(params.minBars), compression: Number(params.compression), minTouches: 2, breakMode: 'wick' },
                    requireGap: false,
                    maxFakeoutBars: Number(params.maxFakeoutBars),
                })
            ));
            return {
                params, events: { setups },
                onBar(ctx) {
                    if (!ctx.isFlat) {
                        if (ctx.state.entered === undefined) ctx.state.entered = ctx.index;
                        if (ctx.index - Number(ctx.state.entered) >= Number(params.maxHoldBars)) ctx.close('amd-max-hold');
                        return;
                    }
                    ctx.state.entered = undefined;
                    if (ctx.pendingOrders.length > 0) return;
                    const setup = ctx.events<RangeFakeoutSetup>('setups')[0];
                    if (!setup) return;
                    const raw = positionSize(ctx.equity, ctx.bar.close, ctx.bar.close - distance,
                        params.riskMode as RiskMode, Number(params.riskValue), leverageCap(params));
                    if (raw === null) return;
                    const units = Math.floor((raw / sizing.pointValue + step * 1e-9) / step) * step;
                    const desired = params.riskMode === 'fixed' ? Number(params.riskValue) : ctx.equity * Number(params.riskValue) / 100;
                    if (units < minimum || Math.abs(units * sizing.pointValue * distance - desired) > 1e-6) return;
                    ctx.order({ side: setup.direction === 'bull' ? 'buy' : 'sell', type: 'market', size: units,
                        bracket: { stopDistance: distance, targetDistance: distance * Number(params.rrr) },
                        tag: `amd-wick:${setup.time}` });
                },
            };
        },
    };
}

export const NQ_AMD_WICK_1M = preset('1', 0.8);
export const NQ_AMD_WICK_3M = preset('3', 0.6);
