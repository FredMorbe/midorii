import { formatClock } from '../strategies';
import { guardsOf, resolveGuards } from '../strategies/liveGuards';

/**
 * A bot's safety rules, as lines a person can read at a glance.
 *
 * Every rule is listed, the ones that are switched off included and marked as such: a screen
 * that only showed the rules in force would make "no daily loss limit" look the same as "the
 * panel forgot to show it". Nothing here decides anything — the decisions are guardRefusal's;
 * this only says what it has been told.
 */

export interface RuleRow {
    label: string;
    /** What the rule is set to, or why it is not in force. */
    value: string;
    on: boolean;
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function daysText(days: readonly number[]): string {
    const week = [1, 2, 3, 4, 5, 6, 0].filter((d) => days.includes(d));
    if (week.length === 7) return 'Every day';
    if (week.join() === '1,2,3,4,5') return 'Mon–Fri';
    if (week.length === 0) return 'No days';
    return week.map((d) => DAY_NAMES[d]).join(' ');
}

export function ruleRows(raw: Readonly<Record<string, unknown>>): RuleRow[] {
    /* Stored guards are resolved against the current schema, and a value the schema cannot
     * mean falls back to the defaults — the rule the settings form follows too. */
    let guards;
    try {
        guards = guardsOf(resolveGuards(raw));
    } catch {
        guards = guardsOf(resolveGuards({}));
    }
    const limit = (value: number, text: string): Pick<RuleRow, 'value' | 'on'> => (
        value > 0 ? { value: text, on: true } : { value: 'Off', on: false }
    );
    const wholeDay = guards.sessionStart === guards.sessionEnd;
    return [
        { label: 'Trading days', value: daysText(guards.tradingDays), on: true },
        {
            label: 'Trading hours (UTC)',
            value: wholeDay ? 'All day' : `${formatClock(guards.sessionStart)}–${formatClock(guards.sessionEnd)}`,
            on: !wholeDay,
        },
        { label: 'Close at the end of the window', value: guards.flattenAtEnd ? 'Yes' : 'No', on: guards.flattenAtEnd },
        { label: 'Max trades per day', ...limit(guards.maxTradesPerDay, String(guards.maxTradesPerDay)) },
        { label: 'Max open positions', value: String(guards.maxOpenPositions), on: true },
        { label: 'Daily loss limit', ...limit(guards.dailyLossLimit, `${guards.dailyLossLimit}%`) },
        {
            label: 'Close everything at the loss limit',
            value: guards.flattenAtDailyLoss ? 'Yes' : 'No',
            on: guards.flattenAtDailyLoss && guards.dailyLossLimit > 0,
        },
        { label: 'Daily profit target', ...limit(guards.dailyProfitTarget, `${guards.dailyProfitTarget}%`) },
        { label: 'Pause after a loss', ...limit(guards.cooldownMinutes, `${guards.cooldownMinutes} min`) },
        { label: 'Max spread', ...limit(guards.maxSpreadPct, `${guards.maxSpreadPct}%`) },
        { label: 'Stale feed after', ...limit(guards.staleFeedSeconds, `${guards.staleFeedSeconds} s`) },
    ];
}
