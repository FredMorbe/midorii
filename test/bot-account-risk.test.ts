// The limits every bot on one venue account answers to together. The rules under test: one
// account's numbers are never read as another's, an unreadable record refuses rather than
// reading as "off", the day's opening equity is one figure per account that survives a
// restart, and neither limit can do anything but refuse an entry.
// See app/renderer/bot/accountRisk.ts.
import { describe, it, expect, beforeEach } from 'vitest';
import {
    NO_ACCOUNT_RISK,
    accountDayOpen,
    accountRiskRefusal,
    capitalAccountKey,
    loadAccountRisk,
    normalizeAccountRisk,
    resetAccountDays,
    saveAccountRisk,
} from '../app/renderer/bot/accountRisk';

/** This module reaches for localStorage, which vitest's node environment has none of. */
function stubStorage(): Map<string, string> {
    const cells = new Map<string, string>();
    (globalThis as unknown as { localStorage: unknown }).localStorage = {
        getItem: (k: string) => cells.get(k) ?? null,
        setItem: (k: string, v: string) => void cells.set(k, v),
        removeItem: (k: string) => void cells.delete(k),
    };
    return cells;
}

let cells: Map<string, string>;
beforeEach(() => {
    cells = stubStorage();
    resetAccountDays();
});

describe('the limits as they are stored', () => {
    it('are off until somebody sets them', () => {
        expect(loadAccountRisk('capital:demo')).toEqual(NO_ACCOUNT_RISK);
    });

    it('are kept per account', () => {
        saveAccountRisk(capitalAccountKey(false), { maxBotPositions: 3, dailyLossPct: 2 });
        saveAccountRisk(capitalAccountKey(true), { maxBotPositions: 1, dailyLossPct: 0.5 });
        expect(loadAccountRisk('capital:demo')).toEqual({ maxBotPositions: 3, dailyLossPct: 2 });
        expect(loadAccountRisk('capital:live')).toEqual({ maxBotPositions: 1, dailyLossPct: 0.5 });
    });

    it('read a value they cannot mean as off, never as a limit nobody chose', () => {
        expect(normalizeAccountRisk({ maxBotPositions: -2, dailyLossPct: 'lots' })).toEqual(NO_ACCOUNT_RISK);
        expect(normalizeAccountRisk({ maxBotPositions: 2.9, dailyLossPct: 150 })).toEqual({ maxBotPositions: 2, dailyLossPct: 0 });
    });

    it('throw on a record that cannot be read, so a limit never silently reads as off', () => {
        cells.set('midorii-bot-account-risk', '{not json');
        expect(() => loadAccountRisk('capital:live')).toThrow();
        // Saving is the way out of it.
        saveAccountRisk('capital:live', { maxBotPositions: 2, dailyLossPct: 0 });
        expect(loadAccountRisk('capital:live').maxBotPositions).toBe(2);
    });
});

describe('the day the daily loss is measured over', () => {
    const noon = Date.UTC(2026, 8, 9, 12, 0);

    it('opens at the first reading of the UTC day and stays there', () => {
        expect(accountDayOpen('capital:demo', 10_000, noon)).toBe(10_000);
        expect(accountDayOpen('capital:demo', 9_500, noon + 3_600_000)).toBe(10_000);
    });

    it('opens again on the next UTC day', () => {
        accountDayOpen('capital:demo', 10_000, noon);
        expect(accountDayOpen('capital:demo', 9_500, noon + 24 * 3_600_000)).toBe(9_500);
    });

    it('never takes an account that has not been read yet as its opening', () => {
        expect(accountDayOpen('capital:demo', 0, noon)).toBe(0);
        expect(accountDayOpen('capital:demo', 10_000, noon)).toBe(10_000);
    });

    it('survives a restart in the middle of the day', () => {
        accountDayOpen('capital:demo', 10_000, noon);
        resetAccountDays();
        expect(accountDayOpen('capital:demo', 9_000, noon + 60_000)).toBe(10_000);
    });

    it('is one figure per account', () => {
        accountDayOpen('capital:demo', 10_000, noon);
        expect(accountDayOpen('capital:live', 2_000, noon)).toBe(2_000);
    });
});

describe('what the account limits refuse', () => {
    const state = { openPositions: 0, equity: 10_000, dayOpenEquity: 10_000 };

    it('nothing while both are off', () => {
        expect(accountRiskRefusal(NO_ACCOUNT_RISK, { openPositions: 40, equity: 1, dayOpenEquity: 10_000 })).toBeNull();
    });

    it('an entry once the bots hold what the account allows them', () => {
        const risk = { maxBotPositions: 2, dailyLossPct: 0 };
        expect(accountRiskRefusal(risk, { ...state, openPositions: 1 })).toBeNull();
        expect(accountRiskRefusal(risk, { ...state, openPositions: 2 })).toMatch(/already hold 2 of the 2 positions/);
    });

    it('an entry once the account is down its limit on the day', () => {
        const risk = { maxBotPositions: 0, dailyLossPct: 2 };
        expect(accountRiskRefusal(risk, { ...state, equity: 9_801 })).toBeNull();
        expect(accountRiskRefusal(risk, { ...state, equity: 9_800 })).toMatch(/down 2\.00% on the day/);
    });

    it('an entry while the day opening is unknown, rather than measuring against nothing', () => {
        const risk = { maxBotPositions: 0, dailyLossPct: 2 };
        expect(accountRiskRefusal(risk, { ...state, dayOpenEquity: 0 })).toMatch(/opening equity for today is unknown/);
    });
});
