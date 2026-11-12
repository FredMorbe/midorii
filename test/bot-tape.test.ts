import { describe, expect, it } from 'vitest';
import { paperTradeCells } from '../app/renderer/bot/botTape';
import type { HistoryRow } from '../app/renderer/replay/tradeBook';

const MNQ_TRADE: HistoryRow = {
    side: 'long',
    size: 1,
    entryPrice: 31463.4362,
    exitPrice: 31449.815,
    openedAt: 1_791_340_380_000,
    closedAt: 1_791_340_440_000,
    netPnl: -153.07,
    fees: 125.83,
    r: null,
    exitTag: 'paper-probe-exit',
};

describe('bot trade history rows', () => {
    it('shows the account’s settled size, prices, net result and fees', () => {
        expect(paperTradeCells(MNQ_TRADE)).toEqual({
            side: 'LONG',
            size: '1',
            prices: '31463.4362 → 31449.815',
            net: '−153.07',
            fees: '125.83',
            exit: 'paper-probe-exit',
        });
    });

    it('shows a short trade without inventing an exit reason', () => {
        expect(paperTradeCells({ ...MNQ_TRADE, side: 'short', netPnl: 24.5, exitTag: null })).toMatchObject({
            side: 'SHORT',
            net: '+24.50',
            exit: '',
        });
    });
});
