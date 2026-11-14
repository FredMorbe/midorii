/**
 * What fired and when: one line per alert that went off, kept after the notification is gone.
 * A repeating alert adds a line each time; a `once` alert that disabled itself leaves its
 * line here as the only trace of why.
 */
export type HistoryKind = 'price' | 'indicator' | 'percent' | 'time';

export interface HistoryEntry {
    id: string;
    /** Epoch ms of the moment it fired. */
    at: number;
    kind: HistoryKind;
    /** Full symbol string (`binance:BTCUSDT`), or empty for an alert that is about no market. */
    symbol: string;
    /** The notification's title. */
    title: string;
    /** The notification's text. */
    body: string;
}

/** The newest entries kept; the list never grows past this. */
export const HISTORY_LIMIT = 100;

const KINDS: readonly HistoryKind[] = ['price', 'indicator', 'percent', 'time'];

export function newEntry(kind: HistoryKind, symbol: string, title: string, body: string, at: number): HistoryEntry {
    return { id: `fired-${at.toString(36)}-${Math.random().toString(36).slice(2, 8)}`, at, kind, symbol, title, body };
}

/** `entry` put first, the list cut to {@link HISTORY_LIMIT}. Does not change `list`. */
export function withEntry(list: readonly HistoryEntry[], entry: HistoryEntry): HistoryEntry[] {
    return [entry, ...list].slice(0, HISTORY_LIMIT);
}

/** Whatever was stored, reduced to the entries that are still well-formed, newest first. */
export function sanitizeHistory(raw: unknown): HistoryEntry[] {
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    const out: HistoryEntry[] = [];
    for (const item of raw as unknown[]) {
        if (item == null || typeof item !== 'object') continue;
        const e = item as Record<string, unknown>;
        if (typeof e.id !== 'string' || !e.id || seen.has(e.id)) continue;
        if (typeof e.at !== 'number' || !Number.isFinite(e.at)) continue;
        if (!KINDS.includes(e.kind as HistoryKind)) continue;
        if (typeof e.title !== 'string' || typeof e.body !== 'string') continue;
        seen.add(e.id);
        out.push({ id: e.id, at: e.at, kind: e.kind as HistoryKind, symbol: typeof e.symbol === 'string' ? e.symbol : '', title: e.title, body: e.body });
    }
    return out.sort((a, b) => b.at - a.at).slice(0, HISTORY_LIMIT);
}

/** How long ago, in the shortest honest words: `just now`, `5 min ago`, `3 h ago`, or the date. */
export function ago(now: number, at: number): string {
    const seconds = Math.max(0, Math.floor((now - at) / 1000));
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days} d ago`;
    return new Date(at).toISOString().slice(0, 10);
}
