/**
 * A list of alerts this machine keeps in localStorage, and the one place it is changed:
 * the shape `IndicatorAlertStore` has, for the alert kinds that came after it.
 *
 * A read that fails is reported and answered with an empty list. A write that fails throws
 * and leaves the list as it was: an alert that looks saved and is gone after a restart
 * would watch for nothing.
 */
type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

export class AlertListStore<T extends { id: string; createdAt: number }> {
    private current: T[];
    private readonly listeners = new Set<() => void>();

    constructor(
        private readonly key: string,
        private readonly sanitize: (raw: unknown) => T[],
        private readonly storage: StorageLike = localStorage,
    ) {
        this.current = this.read();
    }

    /** Newest first. */
    list(): T[] {
        return [...this.current].sort((a, b) => b.createdAt - a.createdAt);
    }

    get(id: string): T | undefined {
        return this.current.find((a) => a.id === id);
    }

    add(alert: T): T {
        this.commit([...this.current, alert]);
        return alert;
    }

    update(id: string, patch: Partial<Omit<T, 'id'>>): T | null {
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

    private commit(next: T[]): void {
        this.storage.setItem(this.key, JSON.stringify(next));
        this.current = next;
        for (const listener of this.listeners) listener();
    }

    private read(): T[] {
        try {
            const raw = this.storage.getItem(this.key);
            return raw ? this.sanitize(JSON.parse(raw)) : [];
        } catch (err) {
            console.error(`[midorii] could not read ${this.key}`, err);
            return [];
        }
    }
}
