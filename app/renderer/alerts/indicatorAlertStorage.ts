import { readCooldown } from './alertCooldown';
import type { InputValue } from '../../../src/core/model/inputs';
import type { IndicatorAgainst, IndicatorAlert, IndicatorCondition } from './indicatorAlertModel';

const CONDITIONS: readonly IndicatorCondition[] = ['crosses', 'crosses-above', 'crosses-below'];

function againstOf(raw: unknown): IndicatorAgainst | null {
    if (raw == null || typeof raw !== 'object') return null;
    const a = raw as Record<string, unknown>;
    if (a.kind === 'price') return { kind: 'price' };
    if (a.kind === 'level' && typeof a.value === 'number' && Number.isFinite(a.value)) return { kind: 'level', value: a.value };
    return null;
}

/** Whatever was stored, reduced to the alerts that are still well-formed. A damaged entry is dropped, not repaired. */
export function sanitizeIndicatorAlerts(raw: unknown): IndicatorAlert[] {
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    const out: IndicatorAlert[] = [];
    for (const entry of raw as unknown[]) {
        if (entry == null || typeof entry !== 'object') continue;
        const e = entry as Record<string, unknown>;
        const against = againstOf(e.against);
        if (typeof e.id !== 'string' || !e.id || seen.has(e.id)) continue;
        if (typeof e.symbol !== 'string' || !e.symbol || typeof e.timeframe !== 'string' || !e.timeframe) continue;
        if (typeof e.indicator !== 'string' || typeof e.plot !== 'string' || !against) continue;
        if (!CONDITIONS.includes(e.condition as IndicatorCondition)) continue;
        const inputs: Record<string, InputValue> = {};
        if (e.inputs != null && typeof e.inputs === 'object') {
            for (const [k, v] of Object.entries(e.inputs as Record<string, unknown>)) {
                if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') inputs[k] = v;
            }
        }
        seen.add(e.id);
        out.push({
            id: e.id,
            symbol: e.symbol,
            timeframe: e.timeframe,
            indicator: e.indicator,
            inputs,
            plot: e.plot,
            condition: e.condition as IndicatorCondition,
            against,
            message: typeof e.message === 'string' ? e.message : '',
            once: e.once !== false,
            cooldownMs: readCooldown(e.cooldownMs),
            enabled: e.enabled !== false,
            createdAt: typeof e.createdAt === 'number' ? e.createdAt : 0,
            lastTriggeredAt: typeof e.lastTriggeredAt === 'number' ? e.lastTriggeredAt : null,
        });
    }
    return out;
}
