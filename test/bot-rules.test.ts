import { describe, expect, it } from 'vitest';
import { ruleRows } from '../app/renderer/bot/botRules';

const row = (rows: ReturnType<typeof ruleRows>, label: string) => rows.find((r) => r.label === label)!;

describe('bot safety rule rows', () => {
    it('lists every rule, with the ones that are off marked as off', () => {
        const rows = ruleRows({});
        expect(rows).toHaveLength(11);
        expect(row(rows, 'Daily loss limit')).toMatchObject({ value: 'Off', on: false });
        expect(row(rows, 'Trading days')).toMatchObject({ value: 'Mon–Fri', on: true });
        expect(row(rows, 'Trading hours (UTC)')).toMatchObject({ value: 'All day', on: false });
        expect(row(rows, 'Stale feed after')).toMatchObject({ value: '120 s', on: true });
    });

    it('reads the stored values', () => {
        const rows = ruleRows({ sessionStart: 480, sessionEnd: 1020, dailyLossLimit: 2.5, tradingDays: ['1', '3'] });
        expect(row(rows, 'Trading hours (UTC)')).toMatchObject({ value: '08:00–17:00', on: true });
        expect(row(rows, 'Daily loss limit')).toMatchObject({ value: '2.5%', on: true });
        expect(row(rows, 'Trading days').value).toBe('Mon Wed');
    });

    it('does not claim the loss-limit close is in force without a limit', () => {
        expect(row(ruleRows({ flattenAtDailyLoss: true }), 'Close everything at the loss limit'))
            .toMatchObject({ value: 'Yes', on: false });
    });

    it('shows the defaults for stored values the schema cannot mean', () => {
        expect(row(ruleRows({ maxOpenPositions: 'many' }), 'Max open positions').value).toBe('1');
    });
});
