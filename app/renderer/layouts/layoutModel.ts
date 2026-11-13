import { sanitizeState, type ChartState, type WorkspaceState } from '../../../src/workspace';
import type { PersistedNativeEntry } from '../../../src/state/document';

/** One named snapshot of the Chart tab: the grid, every chart's market, timeframe, indicators and drawings. */
export interface SavedLayout {
    id: string;
    name: string;
    savedAt: number;
    state: WorkspaceState;
}

export const NAME_MAX_LENGTH = 40;

/** What a layout leaves to the person's preferences, which a layout must not overwrite. */
const PREFERENCES = ['favorites', 'timeframeFavorites', 'indicatorFavorites', 'timezone'] as const;

export function normalizeLayouts(raw: unknown): SavedLayout[] {
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    const out: SavedLayout[] = [];
    for (const entry of raw as unknown[]) {
        if (entry == null || typeof entry !== 'object') continue;
        const e = entry as Record<string, unknown>;
        if (typeof e.id !== 'string' || !e.id || seen.has(e.id)) continue;
        if (typeof e.name !== 'string' || !e.name.trim()) continue;
        const state = sanitizeState(e.state);
        if (!state || state.charts.length === 0) continue;
        seen.add(e.id);
        out.push({
            id: e.id,
            name: e.name.trim().slice(0, NAME_MAX_LENGTH),
            savedAt: typeof e.savedAt === 'number' ? e.savedAt : 0,
            state,
        });
    }
    return out;
}

/** The layout carrying `name`, ignoring case and surrounding space. */
export function findByName(layouts: readonly SavedLayout[], name: string): SavedLayout | undefined {
    const wanted = name.trim().toLowerCase();
    return layouts.find((l) => l.name.toLowerCase() === wanted);
}

/**
 * Save `state` under `name`. A name already in use is replaced in place (it keeps its id and
 * its position); `replaced` says which happened so the caller can tell the person.
 */
export function saveLayout(
    layouts: readonly SavedLayout[],
    name: string,
    state: WorkspaceState,
    now: number,
    newId: () => string,
): { layouts: SavedLayout[]; saved: SavedLayout; replaced: boolean } {
    const trimmed = name.trim().slice(0, NAME_MAX_LENGTH);
    if (!trimmed) throw new Error('A layout needs a name.');
    if (state.charts.length === 0) throw new Error('There is no chart to save.');
    const existing = findByName(layouts, trimmed);
    if (existing) {
        const saved: SavedLayout = { ...existing, name: trimmed, savedAt: now, state };
        return { layouts: layouts.map((l) => (l.id === existing.id ? saved : l)), saved, replaced: true };
    }
    const saved: SavedLayout = { id: newId(), name: trimmed, savedAt: now, state };
    return { layouts: [...layouts, saved], saved, replaced: false };
}

export function deleteLayout(layouts: readonly SavedLayout[], id: string): SavedLayout[] {
    return layouts.filter((l) => l.id !== id);
}

/**
 * The state worth keeping: the app's own indicators out (their controllers put them back on
 * boot, and restored from here they would be a second copy), and the person's preferences out.
 */
export function forSaving(
    live: WorkspaceState,
    withoutApp: (state: WorkspaceState) => WorkspaceState,
): WorkspaceState {
    const state: WorkspaceState = { ...withoutApp(live) };
    for (const key of PREFERENCES) delete state[key];
    return state;
}

/**
 * The saved layout ready for `applyState` on the workspace as it is now: each slot keeps the app
 * indicators it carries right now (the workspace converges the ledger, so leaving them out
 * would take them off), and the preferences stay the live ones.
 */
export function forApplying(
    saved: WorkspaceState,
    live: WorkspaceState,
    appEntriesOf: (cell: ChartState | undefined) => PersistedNativeEntry[],
): WorkspaceState {
    const state: WorkspaceState = { ...saved };
    for (const key of PREFERENCES) {
        delete state[key];
        const value = live[key];
        if (value !== undefined) (state as unknown as Record<string, unknown>)[key] = value;
    }
    state.charts = saved.charts.map((cell, i) => {
        const keep = appEntriesOf(live.charts[i]);
        if (keep.length === 0) return cell;
        return { ...cell, indicators: { manifest: cell.indicators?.manifest ?? [], natives: [...(cell.indicators?.natives ?? []), ...keep] } };
    });
    return state;
}
