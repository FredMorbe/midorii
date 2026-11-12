import type { ChartCell, VelaWorkspace } from '../../../src/workspace';

/**
 * Run `setup` on every cell of a workspace — the ones already there, and each one a later
 * layout change creates.
 *
 * A chart's wiring (event listeners, the app's own indicators, a card in its plot) belongs
 * to the cell, not to whichever chart happened to be active when the wiring was installed:
 * the layout can add cells after that, replace the one that was there, or pool it. `setup`
 * may return a disposer; it runs when the cell leaves the layout, and for every remaining
 * cell when the returned function is called.
 */
export function forEachCell(ws: VelaWorkspace, setup: (cell: ChartCell) => (() => void) | void): () => void {
    const live = new Map<string, () => void>();
    const attach = (id: string): void => {
        const cell = ws.cell(id);
        if (!cell || live.has(id)) return;
        live.set(id, setup(cell) ?? (() => undefined));
    };
    const release = (id: string): void => {
        const dispose = live.get(id);
        live.delete(id);
        dispose?.();
    };
    for (const cell of ws.cells()) attach(cell.id);
    const offCreated = ws.on('cell:created', ({ id }) => attach(id));
    const offDestroyed = ws.on('cell:destroyed', ({ id }) => release(id));
    return () => {
        offCreated();
        offDestroyed();
        for (const id of [...live.keys()]) release(id);
    };
}
