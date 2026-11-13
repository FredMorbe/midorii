import {
    activeList, addSection, addSymbol, createList, deleteList, emptyState, moveItem, normalizeState,
    removeItem, renameList, selectList, type Watchlist, type WatchlistState,
} from './watchlistModel';

/**
 * The watchlists this machine keeps, and the one place they are changed.
 *
 * localStorage, like the other app-level preferences (see `settings/prefs.ts`): a list of
 * names is nothing to round-trip through the main process for. A read that fails is
 * reported and answered with an empty list; a write that fails is reported too, and the
 * change still stands for this session.
 */

const STORAGE_KEY = 'midorii-watchlists';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

export class WatchlistStore {
    private current: WatchlistState;
    private readonly listeners = new Set<() => void>();

    constructor(private readonly storage: StorageLike = localStorage) {
        this.current = this.read();
    }

    get state(): WatchlistState {
        return this.current;
    }

    get active(): Watchlist {
        return activeList(this.current);
    }

    onChange(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    add(symbol: string, listId: string = this.current.activeId): void {
        this.apply(addSymbol(this.current, listId, symbol));
    }

    addSection(title: string): void {
        this.apply(addSection(this.current, this.current.activeId, title));
    }

    remove(index: number): void {
        this.apply(removeItem(this.current, this.current.activeId, index));
    }

    move(from: number, to: number): void {
        this.apply(moveItem(this.current, this.current.activeId, from, to));
    }

    create(name: string): void {
        this.apply(createList(this.current, name));
    }

    rename(name: string): void {
        this.apply(renameList(this.current, this.current.activeId, name));
    }

    deleteActive(): void {
        this.apply(deleteList(this.current, this.current.activeId));
    }

    select(listId: string): void {
        this.apply(selectList(this.current, listId));
    }

    private apply(next: WatchlistState): void {
        if (next === this.current) return;
        this.current = next;
        this.write();
        for (const listener of this.listeners) listener();
    }

    private read(): WatchlistState {
        try {
            const raw = this.storage.getItem(STORAGE_KEY);
            return raw == null ? emptyState() : normalizeState(JSON.parse(raw));
        } catch (err) {
            console.error('[midorii] could not read the watchlists', err);
            return emptyState();
        }
    }

    private write(): void {
        try {
            this.storage.setItem(STORAGE_KEY, JSON.stringify(this.current));
        } catch (err) {
            console.error('[midorii] could not persist the watchlists', err);
        }
    }
}
