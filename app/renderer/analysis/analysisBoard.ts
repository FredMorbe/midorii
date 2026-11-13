import { DEFAULT_FLEET_WIDTH, slotFor, type BoardLayout, type BoardSpec } from '../shell/boardLayout';

/** The panels of one account or session read in full. */
export type AnalysisPanelId = 'summary' | 'equity' | 'review' | 'breakdown' | 'journal' | 'settings' | 'trades';

function initial(): BoardLayout<AnalysisPanelId> {
    const slot = (id: AnalysisPanelId) => slotFor(ANALYSIS_BOARD, id);
    return {
        fleet: DEFAULT_FLEET_WIDTH,
        columns: [
            // The trades are the long list, so they take the room the figures above them leave.
            { weight: 3, panels: (['summary', 'equity', 'review', 'trades'] as const).map(slot) },
            { weight: 1.25, panels: (['breakdown', 'journal', 'settings'] as const).map(slot) },
        ],
    };
}

export const ANALYSIS_BOARD: BoardSpec<AnalysisPanelId> = {
    storageKey: 'midorii-analysis-layout',
    ids: ['summary', 'equity', 'review', 'breakdown', 'journal', 'settings', 'trades'],
    weights: { equity: 1, review: 2.5, journal: 3, trades: 2, settings: 1 },
    initial,
};
