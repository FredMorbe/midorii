import { registerWidgetAction, type DataProvider, type WidgetContext } from '../../../src/plugin';
import type { VelaWorkspace } from '../../../src/workspace';
import { QuoteHub } from './quoteHub';
import { hasSymbol } from './watchlistModel';
import { registerWatchlistPanel } from './watchlistPanel';
import { WatchlistStore } from './watchlistStore';

/**
 * Wires the watchlist: its side panel, and the chart's right-click entry that adds or
 * removes the market on screen. Call once, after the workspace is built — see
 * `app/renderer/main.ts`, alongside `installAlerts`.
 *
 * `enabledFor` says which charts the list may drive. A replay's and a bot's charts are tied
 * to a session; both would be switched out from under it by a click.
 */
export function installWatchlist(
    workspace: VelaWorkspace,
    providers: Record<string, () => DataProvider>,
    enabledFor: (ctx: WidgetContext) => boolean,
): { store: WatchlistStore; hub: QuoteHub } {
    const store = new WatchlistStore();
    const hub = new QuoteHub(providers);

    registerWatchlistPanel({
        store,
        hub,
        pickSymbol: () => workspace.pickSymbol(),
        enabledFor,
    });

    /* Gated on the context's own `activeCellId` first, like the other topbar `when`s: a shell
     * evaluates them while it builds, before it has a cell, and `ctx.symbol` would throw. */
    const onList = (ctx: WidgetContext & { readonly activeCellId?: string }): boolean | null => {
        if (ctx.activeCellId === '' || !enabledFor(ctx)) return null;
        return hasSymbol(store.state, store.state.activeId, ctx.symbol);
    };

    registerWidgetAction({
        id: 'midorii.watchlist-add',
        target: 'context:body',
        label: 'Add to Watchlist',
        icon: 'star',
        when: (ctx) => onList(ctx) === false,
        run: (ctx) => {
            store.add(ctx.symbol);
            ctx.toast(`${ctx.symbol} added to ${store.active.name}`, 'success');
        },
    });

    registerWidgetAction({
        id: 'midorii.watchlist-remove',
        target: 'context:body',
        label: 'Remove from Watchlist',
        icon: 'star',
        when: (ctx) => onList(ctx) === true,
        run: (ctx) => {
            const index = store.active.items.findIndex((i) => i.kind === 'symbol' && i.symbol === ctx.symbol);
            if (index < 0) return;
            store.remove(index);
            ctx.toast(`${ctx.symbol} removed from ${store.active.name}`, 'info');
        },
    });

    workspace.refreshActions();
    return { store, hub };
}
