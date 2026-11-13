import { Menu, injectStyles } from '../../../src/ui';
import {
    DEFAULT_FLEET_WIDTH,
    MAX_COLUMNS,
    MAX_FLEET_WIDTH,
    MIN_COLUMN_WIDTH,
    MIN_FLEET_WIDTH,
    MIN_PANEL_HEIGHT,
    clamp,
    flexOf,
    isDefaultLayout,
    movePanel,
    parseLayout,
    settleSlot,
    splitPair,
    type BoardLayout,
    type BoardSpec,
    type Drop,
} from './boardLayout';

/**
 * A screen's panels, which a person can move and resize.
 *
 * The panels are built once and only ever MOVED between columns afterwards. What sits inside
 * them — the chart, the position list, the activity tape — owns a canvas, a feed or a scroll
 * position, and a layout change that rebuilt them would throw each of those away. So a change
 * of arrangement re-parents the same elements, and a change of size only rewrites a style.
 */

const STYLE_ID = 'midorii-board';
const CSS = `
.midorii-board-board { flex: 1 1 auto; min-width: 0; min-height: 0; display: flex; }
.midorii-board-col { min-width: 0; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
.midorii-board-panel { min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
.midorii-board-panel[data-dragging] { opacity: .3; }
.midorii-board-panel-head {
    flex: none; display: flex; align-items: center; gap: 8px;
    min-height: 34px; padding: 0 12px 0 8px;
    cursor: grab; user-select: none; touch-action: none;
}
.midorii-board-panel-head h3 {
    margin: 0; font-size: 10px; font-weight: 700; letter-spacing: .12em;
    text-transform: uppercase; color: var(--vela-fg-muted); white-space: nowrap;
}
.midorii-board-grip { flex: none; width: 14px; height: 16px; color: var(--vela-fg-faint); opacity: .5; }
.midorii-board-panel-head:hover .midorii-board-grip { opacity: 1; color: var(--vela-fg-muted); }
.midorii-board-panel-body { flex: 1 1 auto; min-height: 0; position: relative; display: flex; flex-direction: column; overflow: auto; }

.midorii-board-gx, .midorii-board-gy, .midorii-board-gf {
    flex: none; position: relative; z-index: 3; touch-action: none;
    background: var(--vela-border);
}
.midorii-board-gx, .midorii-board-gf { width: 1px; cursor: col-resize; }
.midorii-board-gy { height: 1px; cursor: row-resize; }
.midorii-board-gx::before, .midorii-board-gf::before { content: ''; position: absolute; top: 0; bottom: 0; left: -4px; right: -4px; }
.midorii-board-gy::before { content: ''; position: absolute; left: 0; right: 0; top: -4px; bottom: -4px; }
.midorii-board-gx:hover, .midorii-board-gy:hover, .midorii-board-gf:hover,
.midorii-board-gx[data-on], .midorii-board-gy[data-on], .midorii-board-gf[data-on] {
    background: var(--vela-accent-ink); box-shadow: 0 0 0 1px var(--vela-accent-ink);
}
.midorii-board-adjusting { user-select: none; }
.midorii-board-moving, .midorii-board-moving * { cursor: grabbing !important; user-select: none; }
.midorii-board-ghost {
    position: fixed; left: 0; top: 0; z-index: 6000; pointer-events: none;
    padding: 7px 11px; border: 1px solid var(--vela-accent-line); border-radius: var(--vela-radius-md);
    background: var(--vela-surface-card); box-shadow: var(--vela-shadow);
    font-size: 10px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase;
    color: var(--vela-fg-bright);
}
.midorii-board-drop {
    position: fixed; z-index: 5999; pointer-events: none; border-radius: 2px;
    background: var(--vela-accent-ink); box-shadow: 0 0 0 3px var(--vela-accent-soft);
}
.midorii-board-drop[hidden] { display: none; }

@media (max-width: 860px) {
    .midorii-board-board { flex-direction: column; overflow: auto; }
    .midorii-board-col { flex: none !important; overflow: visible; }
    .midorii-board-panel { flex: none !important; border-bottom: 1px solid var(--vela-border); }
    .midorii-board-panel-body[data-tall] { height: var(--board-stacked-height); flex: none; }
    .midorii-board-gx, .midorii-board-gy, .midorii-board-gf { display: none; }
    .midorii-board-panel-head { cursor: default; }
    .midorii-board-grip { display: none; }
    .midorii-board-layout-btn { display: none; }
}
`;

/** Below this width the panels stack and nothing can be dragged — see the stylesheet. */
const STACKED_QUERY = '(max-width: 860px)';

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** `structure` means panels moved and the board must be rebuilt; `size` means only widths and
 *  heights changed, which the drag has already applied. */
export type LayoutChange = 'structure' | 'size';

export interface LayoutStore<Id extends string = string> {
    readonly spec: BoardSpec<Id>;
    get(): BoardLayout<Id>;
    set(next: BoardLayout<Id>, change: LayoutChange): void;
    reset(): void;
    /** Returns the function that stops listening, for a board that is thrown away. */
    subscribe(listener: (layout: BoardLayout<Id>, change: LayoutChange) => void): () => void;
}

/**
 * The layout, remembered for next time.
 *
 * A stored layout that cannot be read or does not describe every panel is replaced by the
 * default without a word: what it would say is "your arrangement is gone", which no one can do
 * anything about, and the screen is fully usable on the default.
 */
export function createLayoutStore<Id extends string>(spec: BoardSpec<Id>, storage: StorageLike | null): LayoutStore<Id> {
    let layout = spec.initial();
    if (storage) {
        try {
            const raw = storage.getItem(spec.storageKey);
            layout = (raw ? parseLayout(spec, JSON.parse(raw)) : null) ?? layout;
        } catch {
            layout = spec.initial();
        }
    }
    const listeners: Array<(layout: BoardLayout<Id>, change: LayoutChange) => void> = [];

    function persist(): void {
        if (!storage) return;
        try {
            if (isDefaultLayout(spec, layout)) storage.removeItem(spec.storageKey);
            else storage.setItem(spec.storageKey, JSON.stringify(layout));
        } catch (err) {
            // The layout still holds for this visit; it is only not remembered after it.
            console.warn(`[midorii] could not store the layout ${spec.storageKey}`, err);
        }
    }
    return {
        spec,
        get: () => layout,
        set(next, change) {
            layout = next;
            persist();
            for (const listener of listeners) listener(layout, change);
        },
        reset() {
            layout = spec.initial();
            persist();
            for (const listener of listeners) listener(layout, 'structure');
        },
        subscribe(listener) {
            listeners.push(listener);
            return () => {
                const at = listeners.indexOf(listener);
                if (at >= 0) listeners.splice(at, 1);
            };
        },
    };
}

export interface PanelParts {
    title: string;
    body: HTMLElement;
    /** On a narrow window the panels stack and a panel would shrink to its content. A panel
     *  that is no use at that size — a chart — asks for a height of its own instead. */
    stackedHeight?: number;
}

export interface PanelBoard {
    el: HTMLElement;
    /** Stop following the store. Call it when the board is thrown away. */
    dispose(): void;
}

const GRIP = '<svg viewBox="0 0 16 16" width="14" height="16" aria-hidden="true">'
    + [4, 8, 12].map((y) => `<circle cx="6" cy="${y}" r="1" fill="currentColor"/><circle cx="10" cy="${y}" r="1" fill="currentColor"/>`).join('')
    + '</svg>';

/** The board the panels live on. Dragging is wired once, on the board itself. */
export function mountPanelBoard<Id extends string>(
    doc: Document,
    store: LayoutStore<Id>,
    parts: Record<Id, PanelParts>,
): PanelBoard {
    injectStyles(STYLE_ID, CSS, doc);
    const view = doc.defaultView;
    const stacked = (): boolean => view?.matchMedia?.(STACKED_QUERY).matches ?? false;

    const board = doc.createElement('div');
    board.className = 'midorii-board-board';

    const panelEls = new Map<Id, HTMLElement>();
    for (const [id, part] of Object.entries(parts) as Array<[Id, PanelParts]>) {
        const section = doc.createElement('section');
        section.className = 'midorii-board-panel';
        section.dataset.panel = id;
        section.setAttribute('aria-label', part.title);
        const head = doc.createElement('header');
        head.className = 'midorii-board-panel-head';
        head.title = 'Drag to move this panel';
        const grip = doc.createElement('span');
        grip.className = 'midorii-board-grip';
        grip.innerHTML = GRIP;
        const title = doc.createElement('h3');
        title.textContent = part.title;
        head.append(grip, title);
        const body = doc.createElement('div');
        body.className = 'midorii-board-panel-body';
        if (part.stackedHeight) {
            body.dataset.tall = '';
            body.style.setProperty('--board-stacked-height', `${part.stackedHeight}px`);
        }
        body.appendChild(part.body);
        section.append(head, body);
        panelEls.set(id, section);
    }

    function gutter(kind: 'gx' | 'gy', column: number, panel = 0): HTMLElement {
        const el = doc.createElement('div');
        el.className = `midorii-board-${kind}`;
        el.dataset.column = String(column);
        el.dataset.panel = String(panel);
        el.setAttribute('role', 'separator');
        el.setAttribute('aria-orientation', kind === 'gx' ? 'vertical' : 'horizontal');
        el.title = kind === 'gx'
            ? 'Drag to resize · double-click to even out'
            : 'Drag to resize · double-click to reset';
        return el;
    }

    function build(layout: BoardLayout<Id>): void {
        const children: HTMLElement[] = [];
        layout.columns.forEach((column, ci) => {
            if (ci > 0) children.push(gutter('gx', ci - 1));
            const col = doc.createElement('div');
            col.className = 'midorii-board-col';
            col.style.flex = `${column.weight} 1 0`;
            column.panels.forEach((slot, pi) => {
                if (pi > 0) col.appendChild(gutter('gy', ci, pi - 1));
                const el = panelEls.get(slot.id)!;
                el.style.flex = flexOf(slot);
                col.appendChild(el);
            });
            children.push(col);
        });
        board.replaceChildren(...children);
    }
    build(store.get());
    const stopFollowing = store.subscribe((layout, change) => { if (change === 'structure') build(layout); });

    const columnEls = (): HTMLElement[] => [...board.querySelectorAll<HTMLElement>(':scope > .midorii-board-col')];

    /* ── resizing ────────────────────────────────────────────────────── */

    function dragGutter(e: PointerEvent, g: HTMLElement): void {
        e.preventDefault();
        const layout = structuredClone(store.get());
        const startX = e.clientX;
        const startY = e.clientY;
        /* A press that never moved the line stores nothing: the weights above were turned into
         * pixels only to measure against, and writing that down would count as a custom layout. */
        let moved = false;
        let apply: (dx: number, dy: number) => void;

        if (g.classList.contains('midorii-board-gx')) {
            const i = Number(g.dataset.column);
            const els = columnEls();
            const widths = els.map((el) => Math.round(el.getBoundingClientRect().width));
            // Weights become the widths on screen, so a drag of N pixels moves the line N pixels.
            layout.columns.forEach((c, k) => { c.weight = widths[k]!; });
            apply = (dx) => {
                const [a, b] = splitPair(widths[i]!, widths[i + 1]!, dx, MIN_COLUMN_WIDTH);
                moved ||= a !== widths[i];
                layout.columns[i]!.weight = a;
                layout.columns[i + 1]!.weight = b;
                els.forEach((el, k) => { el.style.flex = `${layout.columns[k]!.weight} 1 0`; });
            };
        } else {
            const ci = Number(g.dataset.column);
            const i = Number(g.dataset.panel);
            const column = layout.columns[ci]!;
            const els = [...(g.parentElement as HTMLElement).querySelectorAll<HTMLElement>(':scope > .midorii-board-panel')];
            const heights = els.map((el) => Math.round(el.getBoundingClientRect().height));
            column.panels.forEach((p, k) => { if (p.weight) p.weight = heights[k]!; });
            const set = (k: number, value: number): void => {
                const slot = column.panels[k]!;
                if (slot.weight) slot.weight = value;
                else slot.px = value;
            };
            apply = (_dx, dy) => {
                const [a, b] = splitPair(heights[i]!, heights[i + 1]!, dy, MIN_PANEL_HEIGHT);
                moved ||= a !== heights[i];
                set(i, a);
                set(i + 1, b);
                els.forEach((el, k) => { el.style.flex = flexOf(column.panels[k]!); });
            };
        }
        track(g, (ev) => apply(ev.clientX - startX, ev.clientY - startY), () => { if (moved) store.set(layout, 'size'); });
    }

    function resetGutter(g: HTMLElement): void {
        const layout = structuredClone(store.get());
        if (g.classList.contains('midorii-board-gx')) {
            const a = layout.columns[Number(g.dataset.column)]!;
            const b = layout.columns[Number(g.dataset.column) + 1]!;
            const half = (a.weight + b.weight) / 2;
            a.weight = half;
            b.weight = half;
        } else {
            const column = layout.columns[Number(g.dataset.column)]!;
            const i = Number(g.dataset.panel);
            for (const k of [i, i + 1]) settleSlot(store.spec, column.panels[k]!, column);
        }
        store.set(layout, 'structure');
    }

    /** Run a drag: the pointer is followed on the window, so it survives leaving the line and
     *  crossing the chart canvas. */
    function track(handle: HTMLElement, move: (e: PointerEvent) => void, done: () => void): void {
        handle.dataset.on = '1';
        board.classList.add('midorii-board-adjusting');
        const win = doc.defaultView!;
        const end = (): void => {
            win.removeEventListener('pointermove', move);
            win.removeEventListener('pointerup', end);
            win.removeEventListener('pointercancel', end);
            delete handle.dataset.on;
            board.classList.remove('midorii-board-adjusting');
            done();
        };
        win.addEventListener('pointermove', move);
        win.addEventListener('pointerup', end);
        win.addEventListener('pointercancel', end);
    }

    /* ── rearranging ─────────────────────────────────────────────────── */

    interface Target { drop: Drop; mark: { left: number; top: number; width: number; height: number } }

    function findDrop(x: number, y: number): Target | null {
        const grid = board.getBoundingClientRect();
        if (x < grid.left || x > grid.right || y < grid.top || y > grid.bottom) return null;
        const cols = columnEls();
        for (const [i, el] of cols.entries()) {
            const r = el.getBoundingClientRect();
            if (x < r.left || x > r.right + 1) continue;
            // The outer strip of a column means "a column of its own here"; the middle, "into this one".
            if (cols.length < MAX_COLUMNS) {
                if (x < r.left + 30) return { drop: { kind: 'column', index: i }, mark: { left: r.left - 1, top: r.top, width: 3, height: r.height } };
                if (x > r.right - 30) return { drop: { kind: 'column', index: i + 1 }, mark: { left: r.right - 2, top: r.top, width: 3, height: r.height } };
            }
            const rects = [...el.querySelectorAll<HTMLElement>(':scope > .midorii-board-panel')].map((p) => p.getBoundingClientRect());
            const index = rects.filter((p) => y > p.top + p.height / 2).length;
            const edge = index < rects.length ? rects[index]!.top : rects[rects.length - 1]!.bottom;
            return {
                drop: { kind: 'panel', column: i, index },
                mark: { left: r.left, top: clamp(edge - 1, r.top, r.bottom - 3), width: r.width, height: 3 },
            };
        }
        return null;
    }

    function dragPanel(e: PointerEvent, head: HTMLElement): void {
        const section = head.parentElement as HTMLElement;
        const id = section.dataset.panel as Id;
        const startX = e.clientX;
        const startY = e.clientY;
        let ghost: HTMLElement | null = null;
        let mark: HTMLElement | null = null;
        let target: Target | null = null;

        const move = (ev: PointerEvent): void => {
            if (!ghost) {
                if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 6) return;
                ghost = doc.createElement('div');
                ghost.className = 'midorii-board-ghost';
                ghost.textContent = parts[id].title;
                mark = doc.createElement('div');
                mark.className = 'midorii-board-drop';
                doc.body.append(mark, ghost);
                doc.body.classList.add('midorii-board-moving');
                section.dataset.dragging = '1';
            }
            ghost.style.transform = `translate(${ev.clientX + 14}px, ${ev.clientY + 14}px)`;
            target = findDrop(ev.clientX, ev.clientY);
            mark!.hidden = !target;
            if (target) {
                const m = target.mark;
                Object.assign(mark!.style, { left: `${m.left}px`, top: `${m.top}px`, width: `${m.width}px`, height: `${m.height}px` });
            }
        };
        const win = doc.defaultView!;
        const end = (ev: PointerEvent): void => {
            win.removeEventListener('pointermove', move);
            win.removeEventListener('pointerup', end);
            win.removeEventListener('pointercancel', end);
            if (!ghost) return;
            ghost.remove();
            mark!.remove();
            doc.body.classList.remove('midorii-board-moving');
            delete section.dataset.dragging;
            // A cancelled drag (Escape, a lost pointer) puts nothing anywhere.
            if (target && ev.type === 'pointerup') {
                const next = movePanel(store.spec, store.get(), id, target.drop);
                if (next !== store.get()) store.set(next, 'structure');
            }
        };
        win.addEventListener('pointermove', move);
        win.addEventListener('pointerup', end);
        win.addEventListener('pointercancel', end);
    }

    board.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || stacked()) return;
        const target = e.target as HTMLElement;
        const g = target.closest<HTMLElement>('.midorii-board-gx, .midorii-board-gy');
        if (g) { dragGutter(e, g); return; }
        const head = target.closest<HTMLElement>('.midorii-board-panel-head');
        if (head && !target.closest('button, a, input, select')) dragPanel(e, head);
    });
    board.addEventListener('dblclick', (e) => {
        if (stacked()) return;
        const g = (e.target as HTMLElement).closest<HTMLElement>('.midorii-board-gx, .midorii-board-gy');
        if (g) resetGutter(g);
    });

    return { el: board, dispose: stopFollowing };
}

/** The line between a list and the rest of a screen. It resizes the list; nothing is rebuilt. */
export function mountFleetGutter<Id extends string>(doc: Document, store: LayoutStore<Id>, list: HTMLElement): HTMLElement {
    injectStyles(STYLE_ID, CSS, doc);
    const gutter = doc.createElement('div');
    gutter.className = 'midorii-board-gf';
    gutter.setAttribute('role', 'separator');
    gutter.setAttribute('aria-orientation', 'vertical');
    gutter.title = 'Drag to resize · double-click to reset';

    const apply = (layout: BoardLayout<Id>): void => { list.style.width = `${layout.fleet}px`; };
    apply(store.get());
    store.subscribe(apply);

    gutter.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || doc.defaultView?.matchMedia?.(STACKED_QUERY).matches) return;
        e.preventDefault();
        const layout = structuredClone(store.get());
        const startX = e.clientX;
        const startWidth = layout.fleet;
        gutter.dataset.on = '1';
        const win = doc.defaultView!;
        const move = (ev: PointerEvent): void => {
            layout.fleet = Math.round(clamp(startWidth + ev.clientX - startX, MIN_FLEET_WIDTH, MAX_FLEET_WIDTH));
            apply(layout);
        };
        const end = (): void => {
            win.removeEventListener('pointermove', move);
            win.removeEventListener('pointerup', end);
            win.removeEventListener('pointercancel', end);
            delete gutter.dataset.on;
            if (layout.fleet !== startWidth) store.set(layout, 'size');
        };
        win.addEventListener('pointermove', move);
        win.addEventListener('pointerup', end);
        win.addEventListener('pointercancel', end);
    });
    gutter.addEventListener('dblclick', () => {
        const layout = structuredClone(store.get());
        layout.fleet = DEFAULT_FLEET_WIDTH;
        store.set(layout, 'size');
    });
    return gutter;
}

/**
 * Give a button the layout menu: how to arrange the screen, and the way back to the default.
 *
 * The menu is built on the first press, not before: most visits never open it.
 */
export function attachLayoutMenu<Id extends string>(
    trigger: HTMLButtonElement,
    root: HTMLElement,
    store: LayoutStore<Id>,
): void {
    const doc = trigger.ownerDocument;
    trigger.classList.add('midorii-board-layout-btn');
    trigger.title = 'Drag a panel by its title to move it. Drag the lines between panels to resize them. '
        + 'Double-click a line to reset it.';
    let menu: Menu | null = null;
    trigger.addEventListener('click', () => {
        menu ??= new Menu({
            host: (root.closest('.vela-ui') as HTMLElement | null) ?? doc.body,
            items: [],
            placement: 'bottom-end',
            onSelect: (id) => { if (id === 'reset') store.reset(); },
        });
        menu.setItems([{ id: 'reset', label: 'Reset layout', disabled: isDefaultLayout(store.spec, store.get()) }]);
        const rect = trigger.getBoundingClientRect();
        menu.openAt(rect.right, rect.bottom + 4);
    });
}
