import { registerSidePanel, type SidePanelHandle, type WidgetContext } from '../../../src/plugin';
import type { Vela } from '../../../src';
import { Dialog, Menu, buildFieldControl, injectStyles, iconEl, type MenuItemDescriptor } from '../../../src/ui';
import { formatPercent, formatPrice } from '../format';
import { symbolProvider, symbolTicker } from '../alerts/alertTypes';
import type { PriceSnapshot, QuoteHub } from './quoteHub';
import { changeOf, NAME_MAX_LENGTH, type WatchItem } from './watchlistModel';
import type { WatchlistStore } from './watchlistStore';

/**
 * The Watchlist side panel: the markets you follow, with their last price and how far they
 * moved since the previous daily close. Click a row to put that market on the chart.
 *
 * What it costs while it is not looking
 * -------------------------------------
 * Nothing. Prices are subscribed only while the panel is on screen, and every one is let go
 * when it closes (see `QuoteHub`). Between those, a tick only marks its row dirty: the page
 * is touched once per frame, however fast the feeds are, and only for the rows that moved.
 */

const STYLE_ID = 'midorii-watchlist';
const CSS = `
.midorii-wl { display: flex; flex-direction: column; height: 100%; outline: none; }
/* Sized to its rows, not stretched: an empty list must leave the hint at the top. */
.midorii-wl-list { flex: 0 1 auto; min-height: 0; overflow-y: auto; }
.midorii-wl-row, .midorii-wl-section {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto 18px;
    align-items: center;
    column-gap: 10px;
    padding: 7px 8px 7px 14px;
    border-bottom: 1px solid var(--vela-border-faint);
    cursor: pointer;
    user-select: none;
}
.midorii-wl-row:hover, .midorii-wl-section:hover { background: var(--vela-hover); }
.midorii-wl-row[data-active='1'] { background: var(--vela-active); }
.midorii-wl-row[data-over='1'], .midorii-wl-section[data-over='1'] { box-shadow: inset 0 2px 0 var(--vela-accent-bright); }
.midorii-wl-sym { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.midorii-wl-ticker { font-size: 12.5px; font-weight: 600; color: var(--vela-fg-bright); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.midorii-wl-venue { font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--vela-fg-muted); }
.midorii-wl-price, .midorii-wl-chg {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-variant-numeric: tabular-nums;
    font-size: 12px;
    text-align: right;
    color: var(--vela-fg);
}
.midorii-wl-chg { min-width: 58px; }
.midorii-wl-chg[data-tone='up'] { color: var(--vela-up); }
.midorii-wl-chg[data-tone='down'] { color: var(--vela-down); }
.midorii-wl-chg[data-error='1'] { color: var(--vela-danger); }
/* A market that has not spoken, or whose stream went quiet, is dimmed as one statement. */
.midorii-wl-row[data-live='0'] .midorii-wl-price { color: var(--vela-fg-muted); }
.midorii-wl-section {
    grid-template-columns: minmax(0, 1fr) 18px;
    padding-top: 10px;
    background: var(--vela-chrome);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--vela-fg-muted);
}
.midorii-wl-rm {
    all: unset;
    width: 18px;
    height: 18px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--vela-radius-sm);
    color: var(--vela-fg-muted);
    cursor: pointer;
    visibility: hidden;
}
.midorii-wl-row:hover .midorii-wl-rm, .midorii-wl-section:hover .midorii-wl-rm { visibility: visible; }
.midorii-wl-rm:hover { background: var(--vela-hover); color: var(--vela-fg-bright); }
.midorii-wl-empty, .midorii-wl-note { padding: 16px; font-size: 12px; color: var(--vela-fg-muted); text-align: center; }
.midorii-wl-empty[hidden], .midorii-wl-note[hidden], .midorii-wl-list[hidden] { display: none !important; }
.midorii-wl-head-btn {
    all: unset;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 24px;
    padding: 0 8px;
    border-radius: var(--vela-radius-sm);
    font-size: 12px;
    color: var(--vela-fg);
    cursor: pointer;
    max-width: 150px;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
}
.midorii-wl-head-btn:hover { background: var(--vela-hover); color: var(--vela-fg-bright); }
.midorii-wl-add { padding: 0 6px; }
`;

export interface WatchlistPanelOptions {
    store: WatchlistStore;
    hub: QuoteHub;
    /** Ask for one market, without switching any chart. Null when dismissed. */
    pickSymbol: () => Promise<string | null>;
    /**
     * Whether the chart behind this panel may be switched from it. A replay's or a bot's chart
     * is tied to a session, so a click there must not swap its market — and streaming prices
     * for a list nobody can use would be work for nothing.
     */
    enabledFor: (ctx: WidgetContext) => boolean;
}

function button(className: string, label: string, title: string, onClick: (e: MouseEvent) => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = className;
    b.title = title;
    b.setAttribute('aria-label', title);
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
}

function removeButton(title: string, onClick: () => void): HTMLButtonElement {
    const b = button('midorii-wl-rm', '', title, (e) => { e.stopPropagation(); onClick(); });
    b.appendChild(iconEl('close'));
    return b;
}

/** A one-line text question. Resolves with the trimmed answer, or null when dismissed or empty. */
function askName(host: HTMLElement, title: string, initial: string): Promise<string | null> {
    return new Promise((resolve) => {
        let answer = initial;
        let settled = false;
        const settle = (value: string | null): void => {
            if (settled) return;
            settled = true;
            // Deferred a turn: this runs from inside the dialog's own button.
            setTimeout(() => dialog.destroy(), 0);
            resolve(value);
        };

        const field = buildFieldControl({
            kind: 'text',
            value: initial,
            fill: true,
            placeholder: 'Name…',
            onChange: (v) => { answer = v; },
        });
        const input = field.el.querySelector('input');
        if (input) {
            input.maxLength = NAME_MAX_LENGTH;
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { answer = input.value; settle(answer.trim() || null); }
            });
        }
        const body = document.createElement('div');
        body.style.cssText = 'padding:16px 20px;';
        body.appendChild(field.el);

        const dialog = new Dialog({
            host,
            title,
            contained: true,
            align: 'center',
            draggable: true,
            flush: true,
            className: 'vela-dialog--form',
            closeOnBackdrop: true,
            footer: (foot) => {
                const cancel = document.createElement('button');
                cancel.type = 'button';
                cancel.className = 'vela-dialog-btn';
                cancel.textContent = 'Cancel';
                cancel.addEventListener('click', () => settle(null));
                const ok = document.createElement('button');
                ok.type = 'button';
                ok.className = 'vela-dialog-btn vela-dialog-btn-primary';
                ok.textContent = 'Ok';
                ok.addEventListener('click', () => settle((input?.value ?? answer).trim() || null));
                foot.append(cancel, ok);
            },
            onOpenChange: (open) => { if (!open) settle(null); },
        });
        dialog.body.appendChild(body);
        dialog.show();
        /* A turn later: the dialog moves focus to itself as it opens, which would otherwise
         * land after this and leave the field unfocused. */
        setTimeout(() => { input?.focus(); input?.select(); }, 50);
    });
}

interface RowView {
    row: HTMLElement;
    price: HTMLElement;
    chg: HTMLElement;
}

export function registerWatchlistPanel(opts: WatchlistPanelOptions): () => void {
    const { store, hub } = opts;

    return registerSidePanel({
        id: 'midorii.watchlist',
        title: 'Watchlist',
        icon: 'star',
        order: 49,
        width: 300,
        resizable: true,
        minWidth: 240,
        maxWidth: 520,
        mount(ctx, body, header): SidePanelHandle {
            injectStyles(STYLE_ID, CSS, body.ownerDocument);

            const wrap = document.createElement('div');
            wrap.className = 'midorii-wl';
            wrap.tabIndex = 0;
            const list = document.createElement('div');
            list.className = 'midorii-wl-list';
            const empty = document.createElement('div');
            empty.className = 'midorii-wl-empty';
            empty.textContent = 'No markets yet. Press + to add one, or right-click a chart.';
            const note = document.createElement('div');
            note.className = 'midorii-wl-note';
            note.hidden = true;
            note.textContent = 'The watchlist switches the chart on the Chart tab. A replay or a bot keeps its own market.';
            wrap.append(list, empty, note);
            body.appendChild(wrap);

            // ── header: which list, and add ───────────────────────────────────
            const listButton = button('midorii-wl-head-btn', '', 'Switch, rename or create lists', () => openListMenu());
            const addButton = button('midorii-wl-head-btn midorii-wl-add', '', 'Add a market', () => void addFromPicker());
            addButton.appendChild(iconEl('plus'));
            header.slot.append(listButton, addButton);
            header.slot.style.cssText = 'display:flex;align-items:center;gap:2px;margin-left:auto;';

            // ── state ───────────────────────────────────────────────────────
            let visible = false;
            let blocked = false;
            let current = '';
            const views = new Map<string, RowView>();
            const snapshots = new Map<string, PriceSnapshot>();
            const subscriptions = new Map<string, () => void>();
            const dirty = new Set<string>();
            let frame = 0;
            let dragFrom = -1;
            let offMarket: (() => void) | null = null;

            const report = (err: unknown): void => ctx.toast(err instanceof Error ? err.message : String(err), 'error');

            // ── painting ────────────────────────────────────────────────────
            const paintRow = (symbol: string): void => {
                const view = views.get(symbol);
                if (!view) return;
                const snap = snapshots.get(symbol);
                view.price.textContent = snap?.price != null ? formatPrice(snap.price) : '—';
                const change = snap ? changeOf(snap.price, snap.reference) : null;
                view.chg.textContent = formatPercent(change, 2, true);
                if (change == null) delete view.chg.dataset.tone;
                else view.chg.dataset.tone = change > 0 ? 'up' : change < 0 ? 'down' : 'flat';
                // An error is shown where the number would be: a quiet dash would read as "no change".
                if (snap?.error && snap.price == null) {
                    view.chg.textContent = '!';
                    view.chg.dataset.error = '1';
                    view.row.title = snap.error;
                } else {
                    delete view.chg.dataset.error;
                    view.row.title = snap?.error ?? '';
                }
                view.row.dataset.live = snap?.live ? '1' : '0';
            };
            const schedule = (symbol: string): void => {
                dirty.add(symbol);
                if (frame) return;
                frame = requestAnimationFrame(() => {
                    frame = 0;
                    for (const s of dirty) paintRow(s);
                    dirty.clear();
                });
            };
            const markActive = (): void => {
                for (const [symbol, view] of views) {
                    if (symbol === current) view.row.dataset.active = '1';
                    else delete view.row.dataset.active;
                }
            };

            // ── subscriptions follow what is visible ────────────────────────
            const wanted = (): Set<string> => new Set(
                visible && !blocked
                    ? store.active.items.filter((i): i is Extract<WatchItem, { kind: 'symbol' }> => i.kind === 'symbol').map((i) => i.symbol)
                    : [],
            );
            const syncSubscriptions = (): void => {
                const want = wanted();
                for (const [symbol, off] of subscriptions) {
                    if (want.has(symbol)) continue;
                    off();
                    subscriptions.delete(symbol);
                    snapshots.delete(symbol);
                }
                for (const symbol of want) {
                    if (subscriptions.has(symbol)) continue;
                    subscriptions.set(symbol, hub.watch(symbol, (snap) => {
                        snapshots.set(symbol, snap);
                        schedule(symbol);
                    }));
                }
            };

            // ── rows ────────────────────────────────────────────────────────
            const dropTarget = (el: HTMLElement, index: number): void => {
                el.draggable = true;
                el.addEventListener('dragstart', (e) => {
                    dragFrom = index;
                    e.dataTransfer?.setData('text/plain', String(index));
                    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
                });
                el.addEventListener('dragover', (e) => {
                    if (dragFrom < 0) return;
                    e.preventDefault();
                    el.dataset.over = '1';
                });
                el.addEventListener('dragleave', () => delete el.dataset.over);
                el.addEventListener('drop', (e) => {
                    e.preventDefault();
                    delete el.dataset.over;
                    const from = dragFrom;
                    dragFrom = -1;
                    if (from >= 0) store.move(from, index);
                });
                el.addEventListener('dragend', () => { dragFrom = -1; });
            };

            const build = (): void => {
                const active = store.active;
                listButton.textContent = active.name;
                listButton.appendChild(iconEl('chevron-down'));
                views.clear();
                const nodes: HTMLElement[] = [];
                active.items.forEach((item, index) => {
                    if (item.kind === 'section') {
                        const el = document.createElement('div');
                        el.className = 'midorii-wl-section';
                        const title = document.createElement('span');
                        title.textContent = item.title;
                        el.append(title, removeButton('Remove section', () => store.remove(index)));
                        dropTarget(el, index);
                        nodes.push(el);
                        return;
                    }
                    const el = document.createElement('div');
                    el.className = 'midorii-wl-row';
                    el.dataset.live = '0';
                    const sym = document.createElement('span');
                    sym.className = 'midorii-wl-sym';
                    const ticker = document.createElement('span');
                    ticker.className = 'midorii-wl-ticker';
                    ticker.textContent = symbolTicker(item.symbol);
                    const venue = document.createElement('span');
                    venue.className = 'midorii-wl-venue';
                    venue.textContent = symbolProvider(item.symbol) ?? '';
                    sym.append(ticker, venue);
                    const price = document.createElement('span');
                    price.className = 'midorii-wl-price';
                    const chg = document.createElement('span');
                    chg.className = 'midorii-wl-chg';
                    el.append(sym, price, chg, removeButton('Remove from list', () => store.remove(index)));
                    el.addEventListener('click', () => select(item.symbol));
                    dropTarget(el, index);
                    views.set(item.symbol, { row: el, price, chg });
                    nodes.push(el);
                });
                list.replaceChildren(...nodes);
                empty.hidden = blocked || nodes.length > 0;
                list.hidden = blocked;
                note.hidden = !blocked;
                for (const symbol of views.keys()) paintRow(symbol);
                markActive();
                syncSubscriptions();
            };

            // ── actions ─────────────────────────────────────────────────────
            function select(symbol: string): void {
                try {
                    ctx.setSymbol(symbol);
                } catch (err) {
                    report(err);
                }
            }

            async function addFromPicker(): Promise<void> {
                try {
                    const symbol = await opts.pickSymbol();
                    if (symbol) store.add(symbol);
                } catch (err) {
                    report(err);
                }
            }

            function openListMenu(): void {
                const items: MenuItemDescriptor[] = [
                    ...store.state.lists.map((l) => ({ id: `list:${l.id}`, label: l.name, checked: l.id === store.state.activeId })),
                    { id: 'new', label: 'New list…', icon: 'plus', separatorBefore: true },
                    { id: 'section', label: 'Add section…' },
                    { id: 'rename', label: 'Rename list…' },
                    { id: 'delete', label: 'Delete list', icon: 'trash', disabled: store.state.lists.length <= 1 },
                ];
                const menu = new Menu({
                    host: ctx.host,
                    items,
                    placement: 'bottom-start',
                    checkmarks: true,
                    onOpenChange: (open) => { if (!open) setTimeout(() => menu.destroy(), 0); },
                    onSelect: (id) => {
                        if (id.startsWith('list:')) store.select(id.slice(5));
                        else if (id === 'new') void askName(ctx.host, 'New list', '').then((n) => { if (n) store.create(n); });
                        else if (id === 'section') void askName(ctx.host, 'New section', '').then((n) => { if (n) store.addSection(n); });
                        else if (id === 'rename') void askName(ctx.host, 'Rename list', store.active.name).then((n) => { if (n) store.rename(n); });
                        else if (id === 'delete') {
                            try { store.deleteActive(); } catch (err) { report(err); }
                        }
                    },
                });
                const rect = listButton.getBoundingClientRect();
                menu.openAt(rect.left, rect.bottom + 4);
            }

            // ↑/↓ walk the list and switch the chart as they go — the quickest way to look
            // through a list of markets.
            wrap.addEventListener('keydown', (e) => {
                if (blocked || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
                const symbols = store.active.items.filter((i): i is Extract<WatchItem, { kind: 'symbol' }> => i.kind === 'symbol');
                if (symbols.length === 0) return;
                e.preventDefault();
                const at = symbols.findIndex((s) => s.symbol === current);
                const next = e.key === 'ArrowDown' ? Math.min(symbols.length - 1, at + 1) : Math.max(0, at < 0 ? 0 : at - 1);
                select(symbols[next]!.symbol);
            });

            // ── visibility: the dock hides a closed panel with display:none ──
            const observer = new ResizeObserver((entries) => {
                const box = entries[entries.length - 1]!.contentRect;
                const nowVisible = box.width > 0 && box.height > 0;
                if (nowVisible === visible) return;
                visible = nowVisible;
                if (visible) {
                    // Asked on opening rather than at mount: the chart behind the context may
                    // not exist yet while the dock is being built.
                    blocked = !opts.enabledFor(ctx);
                    build();
                } else {
                    syncSubscriptions();
                }
            });
            observer.observe(wrap);

            const offStore = store.onChange(build);
            build();

            return {
                onChart(chart: Vela): void {
                    offMarket?.();
                    current = chart.market.symbol ?? '';
                    markActive();
                    offMarket = chart.on('market:changed', ({ symbol }) => {
                        current = symbol ?? '';
                        markActive();
                    });
                },
                destroy(): void {
                    observer.disconnect();
                    offStore();
                    offMarket?.();
                    if (frame) cancelAnimationFrame(frame);
                    visible = false;
                    syncSubscriptions();
                },
            };
        },
    });
}
