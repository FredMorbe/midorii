import { Dialog, NumberInput, Select, Switch, injectStyles } from '../../../src/ui';
import { SETTINGS_CSS, SETTINGS_STYLE_ID, button, note, row, section } from '../trading/settingsChrome';
import { normalizeQuickSizes, type BracketSettings, type TicketSizing } from './orderTicket';

/**
 * How a replay is traded, as it is remembered from one session to the next.
 *
 * These are habits and not facts of an account: how big the ticket opens, which sizes sit one
 * press away, whether a fresh ticket arrives with a stop and a target already on it. A new
 * session starts from them rather than from the factory, so using the panel once is enough.
 * What an account IS — its costs, its point value, its size grid — is asked when the session is
 * started (see instrument.ts) and is not here.
 */
export interface ReplayTradingSettings {
    sizing: TicketSizing;
    quickSizes: number[];
    brackets: BracketSettings;
}

export const DEFAULT_REPLAY_TRADING: ReplayTradingSettings = {
    sizing: 'fixed',
    quickSizes: [1, 3, 5, 10, 15],
    brackets: { on: false, unit: 'ticks', stop: 40, target: 80 },
};

const STORAGE_KEY = 'midorii-replay-trading';

/**
 * Whatever was stored, with anything unreadable put back to its default.
 *
 * Storage is data from outside the program — an older version's record, a hand-edited one. A
 * zero-length bracket or a unit this version has never heard of would reach the ticket, where a
 * stop at the entry is a trade that is closed the moment it opens.
 */
export function normalizeReplayTrading(raw: unknown): ReplayTradingSettings {
    const source = (raw ?? {}) as Record<string, unknown>;
    const stored = (source.brackets ?? {}) as Record<string, unknown>;
    const distance = (value: unknown, fallback: number): number => {
        const n = typeof value === 'number' ? value : Number(value);
        return Number.isFinite(n) && n > 0 && n <= 1e9 ? n : fallback;
    };
    const sizes = Array.isArray(source.quickSizes) ? normalizeQuickSizes(source.quickSizes) : null;
    const d = DEFAULT_REPLAY_TRADING;
    return {
        sizing: source.sizing === 'risk' ? 'risk' : 'fixed',
        quickSizes: sizes ?? [...d.quickSizes],
        brackets: {
            on: stored.on === true,
            unit: stored.unit === 'cash' ? 'cash' : 'ticks',
            stop: distance(stored.stop, d.brackets.stop),
            target: distance(stored.target, d.brackets.target),
        },
    };
}

export function loadReplayTrading(): ReplayTradingSettings {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return normalizeReplayTrading(raw == null ? null : JSON.parse(raw));
    } catch (err) {
        console.error('[midorii] could not read how a replay is traded', err);
        return normalizeReplayTrading(null);
    }
}

export function saveReplayTrading(settings: ReplayTradingSettings): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch (err) {
        console.error('[midorii] could not persist how a replay is traded', err);
    }
}

const UNITS: ReadonlyArray<{ value: BracketSettings['unit']; label: string }> = [
    { value: 'ticks', label: 'ticks of the market' },
    { value: 'cash', label: 'price units' },
];

/**
 * Open the stop and target a fresh ticket starts with. Resolves with the new values, or null
 * where the dialog was dismissed — never rejects.
 */
export function openBracketDefaults(host: HTMLElement, current: BracketSettings): Promise<BracketSettings | null> {
    const doc = host.ownerDocument;
    injectStyles(SETTINGS_STYLE_ID, SETTINGS_CSS, doc);

    return new Promise<BracketSettings | null>((resolve) => {
        const draft: BracketSettings = { ...current };
        let settled = false;
        const finish = (result: BracketSettings | null): void => {
            if (settled) return;
            settled = true;
            dialog.hide();
            resolve(result);
        };

        const on = new Switch({ checked: draft.on, onChange: (v) => { draft.on = v; } });
        const unit = new Select({
            options: UNITS.map((u) => ({ value: u.value, label: u.label })),
            value: draft.unit,
            onChange: (v) => { draft.unit = v === 'cash' ? 'cash' : 'ticks'; },
        });
        const stop = new NumberInput({ value: draft.stop, min: 0.0001, step: 1, onChange: (v) => { draft.stop = v; } });
        const target = new NumberInput({ value: draft.target, min: 0.0001, step: 1, onChange: (v) => { draft.target = v; } });
        const error = doc.createElement('p');
        error.className = 'midorii-paper-note';
        error.style.color = 'var(--vela-danger)';

        const save = button('Save', doc, true);
        save.onclick = () => {
            if (!(draft.stop > 0) || !(draft.target > 0)) {
                error.textContent = 'The stop and the target each need a distance above zero.';
                return;
            }
            finish({ ...draft });
        };

        const dialog = new Dialog({
            title: 'Stop and target',
            eyebrow: 'Replay',
            host,
            draggable: true,
            align: 'center',
            closeOnInteractOutside: false,
            onOpenChange: (open) => { if (!open) finish(null); },
            content: (body) => {
                body.append(
                    section('A fresh ticket', doc),
                    note(
                        'Where a new ticket’s stop and target start, measured from the price it would trade at. '
                        + 'The levels can still be changed on the ticket and dragged on the chart. A distance in '
                        + 'ticks needs the market’s own increment, which a recorded contract has and a market '
                        + 'played on candles alone does not — there, no levels are placed, so choose price '
                        + 'units instead.',
                        doc,
                    ),
                    row('Start with a stop and a target', on.el, doc),
                    row('Distances are in', unit.el, doc),
                    row('Stop', stop.el, doc),
                    row('Target', target.el, doc),
                    error,
                );
            },
            footer: (el) => {
                const cancel = button('Cancel', doc);
                cancel.onclick = () => finish(null);
                el.append(cancel, save);
            },
        });
        dialog.show();
    });
}

