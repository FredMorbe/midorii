/**
 * A time alert: a reminder for a moment, tied to no market. It fires once; to be reminded
 * again, set it again.
 */
export interface TimeAlert {
    id: string;
    /** Epoch ms of the moment it is due. */
    at: number;
    message: string;
    enabled: boolean;
    createdAt: number;
    lastTriggeredAt: number | null;
}

/** Furthest ahead a reminder can be set: a year. */
export const MAX_AHEAD_MS = 365 * 86_400_000;

const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };

export type When = { at: number } | { error: string };

export const WHEN_HINT = 'e.g. 15m, 2h, 1h30m, 2d, or a clock time such as 14:30';

/**
 * What the person typed for "when", read against `now`: a span from now (`15m`, `2h`,
 * `1h30m`, `2d`) or the next time the clock shows `HH:MM` (today if it is still ahead,
 * tomorrow otherwise).
 */
export function parseWhen(input: string, now: number): When {
    const text = input.trim().toLowerCase().replace(/\s+/g, '');
    if (!text) return { error: `Say when, ${WHEN_HINT}.` };

    const clock = /^(\d{1,2}):(\d{2})$/.exec(text);
    if (clock) {
        const hours = Number(clock[1]);
        const minutes = Number(clock[2]);
        if (hours > 23 || minutes > 59) return { error: `"${input.trim()}" is not a time of day.` };
        const at = new Date(now);
        at.setHours(hours, minutes, 0, 0);
        if (at.getTime() <= now) at.setDate(at.getDate() + 1);
        return { at: at.getTime() };
    }

    if (!/^(\d+[mhd])+$/.test(text)) return { error: `"${input.trim()}" is not a time, ${WHEN_HINT}.` };
    let span = 0;
    for (const [, amount, unit] of text.matchAll(/(\d+)([mhd])/g)) span += Number(amount) * UNIT_MS[unit!]!;
    if (span <= 0) return { error: 'The time has to be ahead of now.' };
    if (span > MAX_AHEAD_MS) return { error: 'A reminder can be set at most a year ahead.' };
    return { at: now + span };
}

/** The moment, in the reader's own clock, without seconds: `14.11.2026, 14:30`. */
export function formatDue(at: number): string {
    return new Date(at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
}

/** `in 15 min`, `in 3 h`, or `due` once the moment has passed. */
export function untilText(now: number, at: number): string {
    const minutes = Math.ceil((at - now) / 60_000);
    if (minutes <= 0) return 'due';
    if (minutes < 60) return `in ${minutes} min`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `in ${hours} h`;
    return `in ${Math.round(hours / 24)} d`;
}

export function newTimeAlert(at: number): TimeAlert {
    return {
        id: `talert-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        at,
        message: '',
        enabled: true,
        createdAt: Date.now(),
        lastTriggeredAt: null,
    };
}

/** Whatever was stored, reduced to the alerts that are still well-formed. A damaged entry is dropped, not repaired. */
export function sanitizeTimeAlerts(raw: unknown): TimeAlert[] {
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    const out: TimeAlert[] = [];
    for (const entry of raw as unknown[]) {
        if (entry == null || typeof entry !== 'object') continue;
        const e = entry as Record<string, unknown>;
        if (typeof e.id !== 'string' || !e.id || seen.has(e.id)) continue;
        if (typeof e.at !== 'number' || !Number.isFinite(e.at)) continue;
        seen.add(e.id);
        out.push({
            id: e.id,
            at: e.at,
            message: typeof e.message === 'string' ? e.message : '',
            enabled: e.enabled !== false,
            createdAt: typeof e.createdAt === 'number' ? e.createdAt : 0,
            lastTriggeredAt: typeof e.lastTriggeredAt === 'number' ? e.lastTriggeredAt : null,
        });
    }
    return out;
}
