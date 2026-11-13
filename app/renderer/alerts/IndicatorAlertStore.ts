import { sanitizeIndicatorAlerts } from './indicatorAlertStorage';
import type { IndicatorAlert } from './indicatorAlertModel';

/**
 * The indicator alerts this machine keeps, and the one place they are changed.
 *
 * localStorage, like the watchlists and layouts. A read that fails is reported and answered
 * with an empty list. A write that fails throws and leaves the list as it was: an alert that
 * looks saved and is gone after a restart would watch for nothing.
 */
const STORAGE_KEY = 'midorii-indicator-alerts';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

export class IndicatorAlertStore {
    private current: IndicatorAlert[];
    private readonly listeners = new Set<() => void>();

    constructor(private readonly storage: StorageLike = localStorage) {
        this.current = this.read();
    }

    /** Newest first. */
    list(): IndicatorAlert[] {
        return [...this.current].sort((a, b) => b.createdAt - a.createdAt);
    }

    get(id: string): IndicatorAlert | undefined {
        return this.current.find((a) => a.id === id);
    }

    add(alert: IndicatorAlert): IndicatorAlert {
        this.commit([...this.current, alert]);
        return alert;
    }

    update(id: string, patch: Partial<Omit<IndicatorAlert, 'id'>>): IndicatorAlert | null {
        const existing = this.get(id);
        if (!existing) return null;
        const next = { ...existing, ...patch };
        this.commit(this.current.map((a) => (a.id === id ? next : a)));
        return next;
    }

    remove(id: string): boolean {
        if (!this.get(id)) return false;
        this.commit(this.current.filter((a) => a.id !== id));
        return true;
    }

    onChange(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private commit(next: IndicatorAlert[]): void {
        this.storage.setItem(STORAGE_KEY, JSON.stringify(next));
        this.current = next;
        for (const listener of this.listeners) listener();
    }

    private read(): IndicatorAlert[] {
        try {
            const raw = this.storage.getItem(STORAGE_KEY);
            return raw ? sanitizeIndicatorAlerts(JSON.parse(raw)) : [];
        } catch (err) {
            console.error('[midorii] could not read the indicator alerts', err);
            return [];
        }
    }
}
