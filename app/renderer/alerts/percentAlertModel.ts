import { DEFAULT_COOLDOWN_MS, readCooldown } from './alertCooldown';

/**
 * A percent alert: the price moved by a given share from a reference price. Unlike a level
 * the reference is where the price WAS when the alert started watching, so it needs no
 * level to be named — "tell me when it has moved 2%".
 *
 * The reference is the first price seen once the alert is watching. A repeating alert
 * measures its next move from where it fired, so it reads "every 2%" rather than firing
 * on every tick after the first one.
 */
export type PercentDirection = 'either' | 'up' | 'down';

export interface PercentAlert {
    id: string;
    /** Full symbol string, e.g. `binance:BTCUSDT`. */
    symbol: string;
    /** A positive share, e.g. `2` for 2%. */
    percent: number;
    direction: PercentDirection;
    /** The price the move is measured from; null until the first price is seen. */
    reference: number | null;
    message: string;
    once: boolean;
    /** Pause after firing while the alert repeats (see alertCooldown.ts). Absent on alerts made before it existed. */
    cooldownMs?: number;
    enabled: boolean;
    createdAt: number;
    lastTriggeredAt: number | null;
}

export const DIRECTION_OPTIONS: ReadonlyArray<{ value: PercentDirection; label: string }> = [
    { value: 'either', label: 'Up or down' },
    { value: 'up', label: 'Up' },
    { value: 'down', label: 'Down' },
];

const DIRECTIONS: readonly PercentDirection[] = ['either', 'up', 'down'];

/** The signed move of `price` from `reference`, in percent. */
export function movePercent(reference: number, price: number): number {
    return ((price - reference) / reference) * 100;
}

/** Whether `price` is far enough from the alert's reference, in the direction it names. False while there is no reference. */
export function moveReached(alert: PercentAlert, price: number): boolean {
    if (alert.reference == null || !(alert.reference > 0) || !Number.isFinite(price)) return false;
    const move = movePercent(alert.reference, price);
    if (alert.direction === 'up') return move >= alert.percent;
    if (alert.direction === 'down') return move <= -alert.percent;
    return Math.abs(move) >= alert.percent;
}

/** One line saying what the alert watches, e.g. `Rises 2% from 67200.01`. */
export function describePercent(alert: PercentAlert): string {
    const verb = alert.direction === 'up' ? 'Rises' : alert.direction === 'down' ? 'Falls' : 'Moves';
    const way = alert.direction === 'either' ? ' either way' : '';
    const from = alert.reference == null ? 'the next price' : String(alert.reference);
    return `${verb} ${alert.percent}%${way} from ${from}`;
}

export function newPercentAlert(symbol: string): PercentAlert {
    return {
        id: `palert-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        symbol,
        percent: 2,
        direction: 'either',
        reference: null,
        message: '',
        once: true,
        cooldownMs: DEFAULT_COOLDOWN_MS,
        enabled: true,
        createdAt: Date.now(),
        lastTriggeredAt: null,
    };
}

/** Whatever was stored, reduced to the alerts that are still well-formed. A damaged entry is dropped, not repaired. */
export function sanitizePercentAlerts(raw: unknown): PercentAlert[] {
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    const out: PercentAlert[] = [];
    for (const entry of raw as unknown[]) {
        if (entry == null || typeof entry !== 'object') continue;
        const e = entry as Record<string, unknown>;
        if (typeof e.id !== 'string' || !e.id || seen.has(e.id)) continue;
        if (typeof e.symbol !== 'string' || !e.symbol) continue;
        if (typeof e.percent !== 'number' || !(e.percent > 0) || !Number.isFinite(e.percent)) continue;
        if (!DIRECTIONS.includes(e.direction as PercentDirection)) continue;
        seen.add(e.id);
        out.push({
            id: e.id,
            symbol: e.symbol,
            percent: e.percent,
            direction: e.direction as PercentDirection,
            reference: typeof e.reference === 'number' && e.reference > 0 && Number.isFinite(e.reference) ? e.reference : null,
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
