import { sanitizeHistory, withEntry, type HistoryEntry } from './alertHistoryModel';

/**
 * The record of fired alerts this machine keeps. localStorage, like the other lists.
 *
 * Unlike an alert, a history line is only a note: when it cannot be written the failure is
 * reported and the line stays in memory for this session. Losing a note is not worth
 * stopping the notification that caused it.
 */
const STORAGE_KEY = 'midorii-alert-history';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

export class AlertHistoryStore {
    private current: HistoryEntry[];
    private readonly listeners = new Set<() => void>();

    constructor(private readonly storage: StorageLike = localStorage) {
        this.current = this.read();
    }

    /** Newest first. */
    list(): HistoryEntry[] {
        return [...this.current];
    }

    add(entry: HistoryEntry): void {
        this.commit(withEntry(this.current, entry));
    }

    clear(): void {
        if (this.current.length > 0) this.commit([]);
    }

    onChange(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private commit(next: HistoryEntry[]): void {
        this.current = next;
        try {
            this.storage.setItem(STORAGE_KEY, JSON.stringify(next));
        } catch (err) {
            console.error('[midorii] could not persist the alert history', err);
        }
        for (const listener of this.listeners) listener();
    }

    private read(): HistoryEntry[] {
        try {
            const raw = this.storage.getItem(STORAGE_KEY);
            return raw ? sanitizeHistory(JSON.parse(raw)) : [];
        } catch (err) {
            console.error('[midorii] could not read the alert history', err);
            return [];
        }
    }
}
