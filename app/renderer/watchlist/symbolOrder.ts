import type { SymbolDescriptor } from '../../../src/core/ports/DataProvider';

/** The spelling a market is compared by: the listing venue, lower case, then the upper-case ticker. */
export function marketKey(symbol: string): string {
    const at = symbol.indexOf(':');
    return at < 0 ? symbol.toUpperCase() : `${symbol.slice(0, at).toLowerCase()}:${symbol.slice(at + 1).toUpperCase()}`;
}

const keyOf = (s: SymbolDescriptor): string => marketKey(`${s.prefix ?? s.provider ?? ''}:${s.ticker}`);

/** Newest first, no duplicates, capped. Returns the same array when nothing changes. */
export function pushRecent(recents: readonly string[], symbol: string, max: number): string[] {
    const key = marketKey(symbol);
    if (recents[0] === symbol && recents.length <= max) return recents as string[];
    return [symbol, ...recents.filter((r) => marketKey(r) !== key)].slice(0, max);
}

const FAVORITE_MARK = '★ ';
const RECENT_MARK = '↺ ';

/**
 * The symbol picker's order: markets on a watchlist first, then the ones last opened, then the
 * rest as given. A market that is not in the pool stays out (it may belong to a provider that
 * has not loaded), and the two groups wear a mark in their description so the order explains
 * itself. Rows are copied, never changed.
 */
export function orderPool(
    pool: readonly SymbolDescriptor[],
    favorites: readonly string[],
    recents: readonly string[],
): SymbolDescriptor[] {
    const rank = new Map<string, number>();
    favorites.forEach((s, i) => { if (!rank.has(marketKey(s))) rank.set(marketKey(s), i); });
    const recentRank = new Map<string, number>();
    recents.forEach((s, i) => { if (!recentRank.has(marketKey(s))) recentRank.set(marketKey(s), i); });

    const fav: Array<{ row: SymbolDescriptor; at: number }> = [];
    const rec: Array<{ row: SymbolDescriptor; at: number }> = [];
    const rest: SymbolDescriptor[] = [];
    for (const s of pool) {
        const key = keyOf(s);
        const f = rank.get(key);
        const r = recentRank.get(key);
        if (f !== undefined) fav.push({ row: { ...s, description: FAVORITE_MARK + (s.description ?? 'Watchlist') }, at: f });
        else if (r !== undefined) rec.push({ row: { ...s, description: RECENT_MARK + (s.description ?? 'Recent') }, at: r });
        else rest.push(s);
    }
    fav.sort((a, b) => a.at - b.at);
    rec.sort((a, b) => a.at - b.at);
    return [...fav.map((x) => x.row), ...rec.map((x) => x.row), ...rest];
}
