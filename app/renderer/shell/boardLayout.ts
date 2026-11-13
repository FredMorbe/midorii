/**
 * Where each panel of a screen sits, and how big it is.
 *
 * Pure data and arithmetic, no DOM: the drag handlers in panelBoard.ts measure what is on
 * screen and hand the numbers here, so every rule about what a layout may look like can be
 * tested without a browser. A screen describes itself with a {@link BoardSpec} — which panels
 * it has and how each starts out — and the rest is the same for all of them.
 *
 * Sizes mean three different things
 * ---------------------------------
 * A slot with a `weight` shares whatever height its column has left over, in proportion to the
 * other weights. A slot with `px` is exactly that tall. A slot with neither is as tall as its
 * content. A panel starts out in whichever of those suits what it holds — a chart wants the
 * room, a status line wants none — and a drag pins the two panels either side of the line that
 * was dragged to the heights they were dragged to.
 */

export interface PanelSlot<Id extends string = string> {
    id: Id;
    /** Share of the column's free height. */
    weight?: number;
    /** A fixed height, set by dragging. */
    px?: number;
}

export interface LayoutColumn<Id extends string = string> {
    /** Share of the width the columns divide between them. */
    weight: number;
    panels: Array<PanelSlot<Id>>;
}

export interface BoardLayout<Id extends string = string> {
    /** Width of the list beside the board, in pixels. Ignored by a screen that has none. */
    fleet: number;
    columns: Array<LayoutColumn<Id>>;
}

/** What a screen tells the board about itself. */
export interface BoardSpec<Id extends string = string> {
    /** Where the arrangement is remembered. */
    storageKey: string;
    /** Every panel the screen has. A stored layout must name each exactly once. */
    ids: readonly Id[];
    /** How a panel is sized before anybody has dragged it. No entry means content height. */
    weights: Partial<Record<Id, number>>;
    /** The arrangement a screen starts with. */
    initial: () => BoardLayout<Id>;
}

export const MAX_COLUMNS = 4;
export const MIN_COLUMN_WIDTH = 220;
export const MIN_PANEL_HEIGHT = 72;
export const MIN_FLEET_WIDTH = 208;
export const MAX_FLEET_WIDTH = 460;
export const DEFAULT_FLEET_WIDTH = 272;

/** A slot in the size its panel starts with. */
export function slotFor<Id extends string>(spec: BoardSpec<Id>, id: Id): PanelSlot<Id> {
    const weight = spec.weights[id];
    return weight ? { id, weight } : { id };
}

export function isDefaultLayout<Id extends string>(spec: BoardSpec<Id>, layout: BoardLayout<Id>): boolean {
    return JSON.stringify(layout) === JSON.stringify(spec.initial());
}

export function clamp(value: number, low: number, high: number): number {
    return Math.max(low, Math.min(high, value));
}

const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;

/**
 * A stored layout, or null when it cannot be trusted.
 *
 * Null rather than a repaired layout: a stored layout that is missing a panel or names one
 * that no longer exists is from a different version of the screen, and the honest answer to
 * that is the default, not a guess at what it was meant to say.
 */
export function parseLayout<Id extends string>(spec: BoardSpec<Id>, raw: unknown): BoardLayout<Id> | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const { fleet, columns } = raw as { fleet?: unknown; columns?: unknown };
    if (!positive(fleet) || !Array.isArray(columns)) return null;
    if (columns.length === 0 || columns.length > MAX_COLUMNS) return null;

    const seen = new Set<string>();
    const parsed: Array<LayoutColumn<Id>> = [];
    for (const column of columns) {
        if (typeof column !== 'object' || column === null) return null;
        const { weight, panels } = column as { weight?: unknown; panels?: unknown };
        if (!positive(weight) || !Array.isArray(panels) || panels.length === 0) return null;
        const slots: Array<PanelSlot<Id>> = [];
        for (const entry of panels) {
            if (typeof entry !== 'object' || entry === null) return null;
            const { id, weight: w, px } = entry as { id?: unknown; weight?: unknown; px?: unknown };
            if (typeof id !== 'string' || !spec.ids.includes(id as Id) || seen.has(id)) return null;
            if (w !== undefined && !positive(w)) return null;
            if (px !== undefined && !positive(px)) return null;
            seen.add(id);
            const next: PanelSlot<Id> = { id: id as Id };
            if (px !== undefined) next.px = px as number;
            else if (w !== undefined) next.weight = w as number;
            slots.push(next);
        }
        parsed.push({ weight: weight as number, panels: slots });
    }
    if (seen.size !== spec.ids.length) return null;
    return { fleet: clamp(fleet, MIN_FLEET_WIDTH, MAX_FLEET_WIDTH), columns: parsed };
}

/** The flex value that gives a slot its size. */
export function flexOf(slot: PanelSlot): string {
    if (slot.px) return `0 0 ${slot.px}px`;
    if (slot.weight) return `${slot.weight} 1 0`;
    return '0 0 auto';
}

/**
 * Give a slot the size its panel starts with, in the unit the column's other weights are in.
 *
 * A weight is only meaningful next to the others in its column — after a drag they are pixel
 * heights — so a panel dropped in among them takes the average rather than its absolute default,
 * which would be a sliver or a giant depending on what the column had been dragged to.
 */
export function settleSlot<Id extends string>(spec: BoardSpec<Id>, target: PanelSlot<Id>, column: LayoutColumn<Id>): void {
    delete target.px;
    delete target.weight;
    const base = spec.weights[target.id];
    if (!base) return;
    const others = column.panels.filter((p) => p !== target && p.weight).map((p) => p.weight as number);
    target.weight = others.length > 0 ? others.reduce((sum, v) => sum + v, 0) / others.length : base;
}

/** Where a dragged panel lands: among the panels of a column, or in a column of its own. */
export type Drop =
    | { kind: 'panel'; column: number; index: number }
    | { kind: 'column'; index: number };

function copy<Id extends string>(layout: BoardLayout<Id>): BoardLayout<Id> {
    return {
        fleet: layout.fleet,
        columns: layout.columns.map((c) => ({ weight: c.weight, panels: c.panels.map((p) => ({ ...p })) })),
    };
}

/**
 * The layout after `id` is dropped at `drop`. Indices in `drop` refer to the layout BEFORE the
 * move, which is the one the pointer was looking at. A column the move empties is removed, and
 * a drop that would make a fifth column is refused by returning the layout unchanged.
 */
export function movePanel<Id extends string>(
    spec: BoardSpec<Id>,
    layout: BoardLayout<Id>,
    id: Id,
    drop: Drop,
): BoardLayout<Id> {
    const next = copy(layout);
    const from = next.columns.find((c) => c.panels.some((p) => p.id === id));
    if (!from) return layout;
    if (drop.kind === 'column' && next.columns.length >= MAX_COLUMNS) return layout;

    const at = from.panels.findIndex((p) => p.id === id);
    const [moved] = from.panels.splice(at, 1) as [PanelSlot<Id>];

    if (drop.kind === 'panel') {
        const to = next.columns[drop.column];
        if (!to) return layout;
        const index = to === from && at < drop.index ? drop.index - 1 : drop.index;
        to.panels.splice(clamp(index, 0, to.panels.length), 0, moved);
        settleSlot(spec, moved, to);
    } else {
        const average = next.columns.reduce((sum, c) => sum + c.weight, 0) / next.columns.length;
        const column: LayoutColumn<Id> = { weight: average, panels: [moved] };
        settleSlot(spec, moved, column);
        next.columns.splice(clamp(drop.index, 0, next.columns.length), 0, column);
    }
    next.columns = next.columns.filter((c) => c.panels.length > 0);
    return next;
}

/**
 * Two neighbours' sizes after the line between them moves by `delta`. Their sum is kept, and
 * neither is left smaller than `min` — unless it already was, in which case it is not made smaller.
 */
export function splitPair(a: number, b: number, delta: number, min: number): [number, number] {
    const low = Math.min(0, min - a);
    const high = Math.max(0, b - min);
    const d = Math.round(clamp(delta, low, high));
    return [a + d, b - d];
}
