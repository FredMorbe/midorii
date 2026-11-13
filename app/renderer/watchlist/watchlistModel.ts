/**
 * The watchlists, as plain data and the edits that can be made to them.
 *
 * Everything here is pure: a state goes in, a new one comes out. Where the state lives
 * (localStorage, see `watchlistStore.ts`) and how it is drawn (`watchlistPanel.ts`) are
 * somebody else's concern, which is what lets the rules below be tested without either.
 */

/** A row: a market to follow, or a heading that groups the rows below it. */
export type WatchItem =
    | { kind: 'symbol'; symbol: string }
    | { kind: 'section'; title: string };

export interface Watchlist {
    id: string;
    name: string;
    items: WatchItem[];
}

export interface WatchlistState {
    lists: Watchlist[];
    /** The list on screen. Always one of `lists`. */
    activeId: string;
}

export const DEFAULT_LIST_NAME = 'Watchlist';
export const NAME_MAX_LENGTH = 40;

function newId(): string {
    return `list-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function emptyState(): WatchlistState {
    const id = newId();
    return { lists: [{ id, name: DEFAULT_LIST_NAME, items: [] }], activeId: id };
}

function cleanName(raw: unknown, fallback: string): string {
    const text = typeof raw === 'string' ? raw.trim().slice(0, NAME_MAX_LENGTH) : '';
    return text || fallback;
}

function cleanItems(raw: unknown): WatchItem[] {
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    const out: WatchItem[] = [];
    for (const entry of raw as Array<Record<string, unknown> | null>) {
        if (entry?.kind === 'symbol' && typeof entry.symbol === 'string' && entry.symbol.trim()) {
            const symbol = entry.symbol.trim();
            // A market appears once per list; a duplicate row would be two copies of one price.
            if (seen.has(symbol)) continue;
            seen.add(symbol);
            out.push({ kind: 'symbol', symbol });
        } else if (entry?.kind === 'section' && typeof entry.title === 'string') {
            out.push({ kind: 'section', title: cleanName(entry.title, 'Section') });
        }
    }
    return out;
}

/** Whatever was stored, made into a state the rest of the code may rely on: at least one
 *  list, unique ids, an active list that exists. Anything unreadable falls back to empty. */
export function normalizeState(raw: unknown): WatchlistState {
    const source = (raw ?? {}) as { lists?: unknown; activeId?: unknown };
    const lists: Watchlist[] = [];
    const ids = new Set<string>();
    if (Array.isArray(source.lists)) {
        for (const entry of source.lists as Array<Record<string, unknown> | null>) {
            if (!entry || typeof entry.id !== 'string' || !entry.id || ids.has(entry.id)) continue;
            ids.add(entry.id);
            lists.push({ id: entry.id, name: cleanName(entry.name, DEFAULT_LIST_NAME), items: cleanItems(entry.items) });
        }
    }
    if (lists.length === 0) return emptyState();
    const activeId = typeof source.activeId === 'string' && ids.has(source.activeId) ? source.activeId : lists[0]!.id;
    return { lists, activeId };
}

function withList(state: WatchlistState, listId: string, edit: (list: Watchlist) => Watchlist): WatchlistState {
    if (!state.lists.some((l) => l.id === listId)) throw new Error(`watchlist: unknown list ${listId}`);
    return { ...state, lists: state.lists.map((l) => (l.id === listId ? edit(l) : l)) };
}

/** Add a market to the end of a list. Already on it: the state is returned unchanged. */
export function addSymbol(state: WatchlistState, listId: string, symbol: string): WatchlistState {
    const clean = symbol.trim();
    if (!clean) throw new Error('watchlist: a symbol cannot be empty');
    if (hasSymbol(state, listId, clean)) return state;
    return withList(state, listId, (list) => ({ ...list, items: [...list.items, { kind: 'symbol', symbol: clean }] }));
}

export function hasSymbol(state: WatchlistState, listId: string, symbol: string): boolean {
    return state.lists.find((l) => l.id === listId)?.items.some((i) => i.kind === 'symbol' && i.symbol === symbol) ?? false;
}

export function addSection(state: WatchlistState, listId: string, title: string): WatchlistState {
    return withList(state, listId, (list) => ({
        ...list,
        items: [...list.items, { kind: 'section', title: cleanName(title, 'Section') }],
    }));
}

export function removeItem(state: WatchlistState, listId: string, index: number): WatchlistState {
    return withList(state, listId, (list) => ({ ...list, items: list.items.filter((_, i) => i !== index) }));
}

/** Move the row at `from` so it ends up at index `to` of the resulting list. */
export function moveItem(state: WatchlistState, listId: string, from: number, to: number): WatchlistState {
    return withList(state, listId, (list) => {
        if (from < 0 || from >= list.items.length || to < 0 || to >= list.items.length || from === to) return list;
        const items = list.items.slice();
        const [moved] = items.splice(from, 1);
        items.splice(to, 0, moved!);
        return { ...list, items };
    });
}

export function createList(state: WatchlistState, name: string): WatchlistState {
    const id = newId();
    return {
        lists: [...state.lists, { id, name: cleanName(name, DEFAULT_LIST_NAME), items: [] }],
        activeId: id,
    };
}

export function renameList(state: WatchlistState, listId: string, name: string): WatchlistState {
    return withList(state, listId, (list) => ({ ...list, name: cleanName(name, list.name) }));
}

/** Delete a list. The last one is refused: a panel with no list has nowhere to add to. */
export function deleteList(state: WatchlistState, listId: string): WatchlistState {
    if (state.lists.length <= 1) throw new Error('watchlist: the last list cannot be deleted');
    const lists = state.lists.filter((l) => l.id !== listId);
    if (lists.length === state.lists.length) throw new Error(`watchlist: unknown list ${listId}`);
    return { lists, activeId: state.activeId === listId ? lists[0]!.id : state.activeId };
}

export function selectList(state: WatchlistState, listId: string): WatchlistState {
    if (!state.lists.some((l) => l.id === listId)) throw new Error(`watchlist: unknown list ${listId}`);
    return { ...state, activeId: listId };
}

export function activeList(state: WatchlistState): Watchlist {
    return state.lists.find((l) => l.id === state.activeId) ?? state.lists[0]!;
}

/** What a price moved since the reference close, as a fraction — or null where either side
 *  is missing or the reference is zero (a percent of nothing is not zero, it is unknown). */
export function changeOf(price: number | null, reference: number | null): number | null {
    if (price == null || reference == null || !(reference > 0)) return null;
    return (price - reference) / reference;
}

/** How many decimals a number is written with (`1964.35` is 2), up to the eight a price carries. */
export function decimalsOf(value: number): number {
    if (!Number.isFinite(value)) return 0;
    const text = String(Number(value.toFixed(8)));
    const at = text.indexOf('.');
    return at < 0 ? 0 : text.length - at - 1;
}
