/**
 * What every bot on one venue account answers to together.
 *
 * A bot's own guards are measured on that bot: its positions, its trades today. Several bots
 * on one Capital.com account share the account's money, and nothing in any one of them can
 * see what the others hold. These two limits are the part that has to be decided once for
 * the account rather than once per bot:
 *
 *   the most positions the account's running bots may hold between them, and
 *   how far the account may fall in one UTC day before none of them opens anything.
 *
 * Like the guards, neither can open a trade. Both can only refuse one, and both are off at
 * zero: a limit nobody chose would refuse orders for reasons nobody agreed to.
 *
 * What is counted
 * ---------------
 * The position limit counts what the RUNNING bots on the account hold or have waiting.
 * Positions opened by hand are not counted, and neither is what a stopped bot left behind:
 * a stopped bot has handed its position to a person, and counting a figure nobody is
 * updating would refuse entries on the strength of a trade that may have closed since.
 *
 * The daily loss is measured on the account's equity, so everything on the account moves
 * it — a hand-placed trade as much as a bot's. That is deliberate: the money that is gone
 * is gone whoever lost it.
 *
 * Kept per account, in the spelling the trade menu and accountRules.ts already use
 * (`capital:live`, `capital:demo`), so the demo account's numbers can never be read as the
 * live one's.
 */

const STORAGE_KEY = 'midorii-bot-account-risk';
const DAY_STORAGE_KEY = 'midorii-bot-account-day';

export interface AccountRisk {
    /** Most positions and resting entries the account's running bots may hold together. Zero is off. */
    maxBotPositions: number;
    /** How far the account may fall below its UTC day's opening equity, in percent. Zero is off. */
    dailyLossPct: number;
}

export const NO_ACCOUNT_RISK: AccountRisk = { maxBotPositions: 0, dailyLossPct: 0 };

/** The key a Capital.com account's limits are kept under. */
export function capitalAccountKey(live: boolean): string {
    return live ? 'capital:live' : 'capital:demo';
}

/** Fill in whatever a stored record is missing, and refuse whatever it cannot mean. */
export function normalizeAccountRisk(raw: unknown): AccountRisk {
    const source = (raw ?? {}) as Partial<Record<keyof AccountRisk, unknown>>;
    const number = (value: unknown, max: number): number => {
        const n = typeof value === 'number' ? value : Number(value);
        return Number.isFinite(n) && n >= 0 && n <= max ? n : 0;
    };
    return {
        maxBotPositions: Math.floor(number(source.maxBotPositions, 1000)),
        dailyLossPct: number(source.dailyLossPct, 100),
    };
}

/** No storage at all is a test or a headless run, not a failed read. */
function storage(): Storage | null {
    return typeof localStorage === 'undefined' ? null : localStorage;
}

function readRecord(key: string): Record<string, unknown> {
    const raw = storage()?.getItem(key);
    if (raw == null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('the stored record is not an object');
    }
    return parsed as Record<string, unknown>;
}

/**
 * This account's limits.
 *
 * Throws where the stored record cannot be read. A limit that silently read as "off" would
 * be the one failure a limit must not have, so the caller refuses entries instead.
 */
export function loadAccountRisk(account: string): AccountRisk {
    return normalizeAccountRisk(readRecord(STORAGE_KEY)[account]);
}

export function saveAccountRisk(account: string, risk: AccountRisk): void {
    const store = storage();
    if (!store) return;
    let all: Record<string, unknown>;
    try {
        all = readRecord(STORAGE_KEY);
    } catch {
        // An unreadable record is replaced by the one being saved, which is the way out of it.
        all = {};
    }
    store.setItem(STORAGE_KEY, JSON.stringify({ ...all, [account]: normalizeAccountRisk(risk) }));
}

/** The day's opening equity per account, for this sitting where storage cannot hold it. */
const days = new Map<string, { dayKey: string; equity: number }>();

/**
 * What the account was worth at the first reading of this UTC day, or 0 before there is one.
 *
 * One figure for the account rather than one per bot: two bots started an hour apart would
 * otherwise measure the same day's loss from two different openings. Stored, so a restart
 * in the middle of a losing day does not start the day again from where it had fallen to.
 * An equity of zero is an account that has not been read yet, and is never taken as one.
 */
export function accountDayOpen(account: string, equity: number, now = Date.now()): number {
    const dayKey = new Date(now).toISOString().slice(0, 10);
    let known = days.get(account);
    if (!known) {
        try {
            const stored = readRecord(DAY_STORAGE_KEY)[account] as { dayKey?: unknown; equity?: unknown } | undefined;
            if (stored && typeof stored.dayKey === 'string' && typeof stored.equity === 'number' && stored.equity > 0) {
                known = { dayKey: stored.dayKey, equity: stored.equity };
                days.set(account, known);
            }
        } catch (err) {
            console.error('[midorii] could not read the account’s day opening for bots', err);
        }
    }
    if (known?.dayKey === dayKey) return known.equity;
    if (!Number.isFinite(equity) || !(equity > 0)) return 0;

    days.set(account, { dayKey, equity });
    try {
        const store = storage();
        if (store) {
            let all: Record<string, unknown> = {};
            try { all = readRecord(DAY_STORAGE_KEY); } catch { /* replaced below */ }
            store.setItem(DAY_STORAGE_KEY, JSON.stringify({ ...all, [account]: { dayKey, equity } }));
        }
    } catch (err) {
        console.error('[midorii] could not store the account’s day opening for bots', err);
    }
    return equity;
}

/** Forget every remembered day opening. For tests, which share this module between cases. */
export function resetAccountDays(): void {
    days.clear();
}

/** Where the account stands, as far as its bot limits are concerned. */
export interface AccountRiskState {
    /** Positions and resting entries held by the account's running bots together. */
    openPositions: number;
    /** What the account is worth right now. */
    equity: number;
    /** What it was worth at the first reading of this UTC day, or 0 where that is unknown. */
    dayOpenEquity: number;
}

/** Why no bot on this account may open anything right now, or null when one may. */
export function accountRiskRefusal(risk: AccountRisk, state: AccountRiskState): string | null {
    if (risk.dailyLossPct > 0) {
        if (!(state.dayOpenEquity > 0)) {
            return 'The account’s opening equity for today is unknown, so its daily loss limit for bots cannot be measured. New entries wait.';
        }
        const movePct = ((state.equity - state.dayOpenEquity) / state.dayOpenEquity) * 100;
        if (movePct <= -risk.dailyLossPct) {
            return `The account is down ${Math.abs(movePct).toFixed(2)}% on the day, at or past its ${risk.dailyLossPct}% limit for bots.`;
        }
    }
    if (risk.maxBotPositions > 0 && state.openPositions >= risk.maxBotPositions) {
        return `The bots on this account already hold ${state.openPositions} of the ${risk.maxBotPositions} `
            + `${risk.maxBotPositions === 1 ? 'position' : 'positions'} the account allows them.`;
    }
    return null;
}
