import type { WorkspaceState } from '../../../src/workspace';
import { deleteLayout, normalizeLayouts, saveLayout, type SavedLayout } from './layoutModel';

/**
 * The named layouts this machine keeps, and the one place they are changed.
 *
 * localStorage, like the watchlists. A read that fails is reported and answered with an empty
 * list. A write that fails THROWS and leaves the list as it was: a layout somebody just saved
 * and cannot reload tomorrow is worse than an error today.
 */
const STORAGE_KEY = 'midorii-layouts';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

export class LayoutStore {
    private current: SavedLayout[];
    private readonly listeners = new Set<() => void>();

    constructor(
        private readonly storage: StorageLike = localStorage,
        private readonly newId: () => string = () => crypto.randomUUID(),
        private readonly now: () => number = () => Date.now(),
    ) {
        this.current = this.read();
    }

    get layouts(): readonly SavedLayout[] {
        return this.current;
    }

    find(id: string): SavedLayout | undefined {
        return this.current.find((l) => l.id === id);
    }

    onChange(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /** Save `state` as `name`; a name already in use is replaced. */
    save(name: string, state: WorkspaceState): { saved: SavedLayout; replaced: boolean } {
        const out = saveLayout(this.current, name, state, this.now(), this.newId);
        this.commit(out.layouts);
        return { saved: out.saved, replaced: out.replaced };
    }

    remove(id: string): void {
        this.commit(deleteLayout(this.current, id));
    }

    private commit(next: SavedLayout[]): void {
        this.storage.setItem(STORAGE_KEY, JSON.stringify(next));
        this.current = next;
        for (const listener of this.listeners) listener();
    }

    private read(): SavedLayout[] {
        try {
            const raw = this.storage.getItem(STORAGE_KEY);
            return raw ? normalizeLayouts(JSON.parse(raw)) : [];
        } catch (err) {
            console.error('[midorii] could not read the saved layouts', err);
            return [];
        }
    }
}
