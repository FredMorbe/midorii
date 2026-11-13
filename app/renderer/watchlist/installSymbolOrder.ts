import { registerSymbolRanking } from '../../../src/plugin';
import type { VelaWorkspace } from '../../../src/workspace';
import { forEachCell } from '../shell/eachCell';
import { orderPool, pushRecent } from './symbolOrder';
import type { WatchlistStore } from './watchlistStore';

const STORAGE_KEY = 'midorii-recent-markets';
const MAX_RECENT = 12;

function readRecents(): string[] {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        const parsed: unknown = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string').slice(0, MAX_RECENT) : [];
    } catch (err) {
        console.error('[midorii] could not read the recent markets', err);
        return [];
    }
}

function writeRecents(recents: readonly string[]): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(recents));
    } catch (err) {
        console.error('[midorii] could not save the recent markets', err);
    }
}

/**
 * Shapes the symbol search's opening screen: the markets on any watchlist first, then the
 * ones the chart showed last. The picker caches its ranking, so each change registers a fresh
 * hook, which it takes as a reason to rank again.
 */
export function installSymbolOrder(workspace: VelaWorkspace, watchlists: WatchlistStore): void {
    let recents = readRecents();

    const favorites = (): string[] => watchlists.state.lists.flatMap((list) => (
        list.items.flatMap((item) => (item.kind === 'symbol' ? [item.symbol] : []))
    ));
    const register = (): void => {
        registerSymbolRanking((pool) => orderPool(pool, favorites(), recents));
    };

    forEachCell(workspace, (cell) => cell.chart.on('market:changed', () => {
        const symbol = cell.chart.market.symbol;
        if (!symbol) return; // a chart between markets has nothing to remember
        const next = pushRecent(recents, symbol, MAX_RECENT);
        if (next === recents) return;
        recents = next;
        writeRecents(recents);
        register();
    }));
    watchlists.onChange(register);
    register();
}
