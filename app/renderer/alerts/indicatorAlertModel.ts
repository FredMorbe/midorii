import { DEFAULT_COOLDOWN_MS } from './alertCooldown';
import { classicSpecs, type ClassicIndicatorSpec } from '../../../src/core/native-indicators/classics';
import type { InputSchema, InputValue } from '../../../src/core/model/inputs';
import type { OHLCV } from '../../../src/core/model/ohlcv';

/**
 * An indicator alert: a classic indicator, computed on a symbol and timeframe of its own,
 * whose plot is watched against a fixed level (RSI over 70) or against the price (price over
 * its moving average). Unlike a price alert it needs bars, so the engine keeps its own.
 */
export type IndicatorCondition = 'crosses' | 'crosses-above' | 'crosses-below';

export type IndicatorAgainst = { kind: 'level'; value: number } | { kind: 'price' };

export interface IndicatorAlert {
    id: string;
    symbol: string;
    /** In the data layer's spelling, e.g. `'60'` or `'D'`. */
    timeframe: string;
    /** A classic indicator's type, e.g. `'rsi'`. */
    indicator: string;
    /** Only the inputs that differ from the indicator's defaults. */
    inputs: Record<string, InputValue>;
    /** Which of the indicator's plots is watched. */
    plot: string;
    condition: IndicatorCondition;
    against: IndicatorAgainst;
    message: string;
    once: boolean;
    /** Pause after firing while the alert repeats (see alertCooldown.ts). Absent on alerts made before it existed. */
    cooldownMs?: number;
    enabled: boolean;
    createdAt: number;
    lastTriggeredAt: number | null;
}

export const specOf = (type: string): ClassicIndicatorSpec | undefined => classicSpecs.find((s) => s.type === type);

/** The inputs worth offering in a dialog: numbers and fixed choices. Colors and the like are looks. */
export function editableInputs(spec: ClassicIndicatorSpec): InputSchema[] {
    return spec.inputs.filter((i) => i.type === 'int' || i.type === 'float' || (i.type === 'string' && i.options && i.options.length > 0));
}

export function withDefaults(spec: ClassicIndicatorSpec, overrides: Record<string, InputValue>): Record<string, InputValue> {
    const out: Record<string, InputValue> = {};
    for (const input of spec.inputs) out[input.key] = input.defval;
    return { ...out, ...overrides };
}

/** A wandering series with volume: enough shape for an indicator to produce all its plots. */
function sampleBars(count = 400): OHLCV[] {
    const bars: OHLCV[] = [];
    let price = 100;
    for (let i = 0; i < count; i++) {
        const open = price;
        price = Math.max(1, price + Math.sin(i / 7) * 2 + Math.cos(i / 3));
        bars.push({ time: i * 60_000, open, high: Math.max(open, price) + 1, low: Math.min(open, price) - 1, close: price, volume: 1000 + (i % 13) * 50 });
    }
    return bars;
}

const plotCache = new Map<string, Array<{ key: string; title: string }>>();

/** The plots an indicator draws, by key and title. Empty when it cannot be computed. */
export function plotsOf(spec: ClassicIndicatorSpec): Array<{ key: string; title: string }> {
    const known = plotCache.get(spec.type);
    if (known) return known;
    let plots: Array<{ key: string; title: string }> = [];
    try {
        plots = spec.compute(sampleBars(), withDefaults(spec, {})).plots.map((p) => ({ key: p.key, title: p.title }));
    } catch (err) {
        console.error(`[midorii] could not list the plots of ${spec.type}`, err);
    }
    plotCache.set(spec.type, plots);
    return plots;
}

/** Every classic indicator an alert can watch: those with at least one plot. */
export function alertableSpecs(): ClassicIndicatorSpec[] {
    return classicSpecs.filter((s) => plotsOf(s).length > 0);
}

export interface Reading {
    /** The watched plot on the newest bar, null while the indicator has no value there yet. */
    value: number | null;
    /** What it is compared to: the level, or the newest close. */
    against: number | null;
}

/** Compute the alert's indicator over `bars` and read it on the newest bar. Throws on an unknown indicator or plot. */
export function reading(alert: IndicatorAlert, bars: readonly OHLCV[]): Reading {
    const spec = specOf(alert.indicator);
    if (!spec) throw new Error(`Unknown indicator "${alert.indicator}"`);
    const last = bars[bars.length - 1];
    if (!last) return { value: null, against: null };
    const output = spec.compute(bars, withDefaults(spec, alert.inputs));
    const plot = output.plots.find((p) => p.key === alert.plot);
    if (!plot) throw new Error(`${spec.shortTitle ?? spec.title} has no plot "${alert.plot}"`);
    const raw = plot.values[bars.length - 1];
    const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
    return { value, against: alert.against.kind === 'level' ? alert.against.value : last.close };
}

/** The side of the comparison a reading is on: positive above, negative below, null while either number is missing. */
export function sideOf(r: Reading): number | null {
    return r.value == null || r.against == null ? null : r.value - r.against;
}

/** Whether going from side `prev` to side `cur` is the crossing the condition names. */
export function crossed(prev: number | null, cur: number | null, condition: IndicatorCondition): boolean {
    if (prev == null || cur == null) return false;
    const up = prev < 0 && cur >= 0;
    const down = prev > 0 && cur <= 0;
    return condition === 'crosses' ? up || down : condition === 'crosses-above' ? up : down;
}

const CONDITION_TEXT: Record<IndicatorCondition, string> = {
    crosses: 'crosses',
    'crosses-above': 'crosses above',
    'crosses-below': 'crosses below',
};

export const CONDITION_OPTIONS: ReadonlyArray<{ value: IndicatorCondition; label: string }> = [
    { value: 'crosses-above', label: 'Crosses above' },
    { value: 'crosses-below', label: 'Crosses below' },
    { value: 'crosses', label: 'Crosses' },
];

/** One line saying what the alert watches, e.g. `RSI (14) crosses above 70`. */
export function describeAlert(alert: IndicatorAlert): string {
    const spec = specOf(alert.indicator);
    if (!spec) return alert.indicator;
    const values = withDefaults(spec, alert.inputs);
    const shown = editableInputs(spec).filter((i) => i.type !== 'string' && i.key !== 'offset').map((i) => String(values[i.key]));
    const name = `${spec.shortTitle ?? spec.title}${shown.length > 0 ? ` (${shown.join(', ')})` : ''}`;
    const plots = plotsOf(spec);
    const title = plots.length > 1 ? plots.find((p) => p.key === alert.plot)?.title : undefined;
    const target = alert.against.kind === 'level' ? String(alert.against.value) : 'the price';
    return `${name}${title ? ` ${title}` : ''} ${CONDITION_TEXT[alert.condition]} ${target}`;
}

export function newIndicatorAlert(symbol: string, timeframe: string, spec: ClassicIndicatorSpec): IndicatorAlert {
    const plot = plotsOf(spec)[0]?.key;
    if (!plot) throw new Error(`${spec.title} has no plot to watch`);
    return {
        id: `ialert-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        symbol,
        timeframe,
        indicator: spec.type,
        inputs: {},
        plot,
        condition: 'crosses-above',
        against: spec.overlay ? { kind: 'price' } : { kind: 'level', value: 70 },
        message: '',
        once: true,
        cooldownMs: DEFAULT_COOLDOWN_MS,
        enabled: true,
        createdAt: Date.now(),
        lastTriggeredAt: null,
    };
}
