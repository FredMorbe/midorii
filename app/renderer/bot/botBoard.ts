import { DEFAULT_FLEET_WIDTH, slotFor, type BoardLayout, type BoardSpec } from '../shell/boardLayout';

/** The panels of a bot's live screen. */
export type PanelId = 'status' | 'account' | 'chart' | 'activity' | 'position' | 'rules';

export const PANEL_IDS: readonly PanelId[] = ['status', 'account', 'chart', 'activity', 'position', 'rules'];

function initial(): BoardLayout<PanelId> {
    const slot = (id: PanelId) => slotFor(BOT_BOARD, id);
    return {
        fleet: DEFAULT_FLEET_WIDTH,
        columns: [
            // The position list is a wide table, so it sits under the chart, which is wide too.
            { weight: 3, panels: (['status', 'chart', 'position', 'activity'] as const).map(slot) },
            { weight: 1.15, panels: (['account', 'rules'] as const).map(slot) },
        ],
    };
}

export const BOT_BOARD: BoardSpec<PanelId> = {
    storageKey: 'midorii-bot-layout',
    ids: PANEL_IDS,
    // A chart wants the room, a status line wants none.
    weights: { chart: 3, activity: 2, rules: 1 },
    initial,
};
