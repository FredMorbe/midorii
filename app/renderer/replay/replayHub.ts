import type { VelaTheme } from '../../../src';
import { timeframeLabel } from '../../../src/widget/timeframe';
import { injectStyles, NumberInput, overlayScrollbarCss, Select, TextField, ensureUIHost } from '../../../src/ui';
import type { MidoriDatasetMeta, MidoriSessionSummary } from '../midori';
import { formatDay, formatMoney, formatPercent, formatWhen } from '../format';
import { button } from '../runs/runViews';
import { screenHead } from '../shell/screenHead';
import { accountOptions, suggestAccount, SPOT_ACCOUNT, type ReplayAccountSettings } from './instrument';
import { instrumentForm } from './instrumentForm';
import type { ReplaySetup } from './replayBootstrap';

/** What the person chose on the hub: a session to begin, or one to carry on. */
export type SetupChoice =
    | { kind: 'new'; setup: ReplaySetup }
    | { kind: 'resume'; sessionId: string };

export interface ReplayHub {
    el: HTMLElement;
    /** Read what is on disk again — sessions put down, markets downloaded since it was last on screen. */
    refresh(): Promise<void>;
    /** Repaint in a new palette. */
    setTheme(theme: VelaTheme): void;
    /** A session is being opened: nothing on the screen may start a second one. */
    setBusy(busy: boolean): void;
    /** Say why a session did not open. */
    showError(message: string): void;
    /** Say what became of the session just left — it is gone from the screen, so a toast would be too. */
    notice(message: string, kind: 'info' | 'success'): void;
}

const STYLE_ID = 'midorii-replay-hub';
const CSS = `
.midorii-replay-hub {
    position: absolute; inset: 0; display: flex; flex-direction: column;
    background: var(--vela-bg); color: var(--vela-fg);
    font: 13px/1.5 var(--vela-font, sans-serif);
}
.midorii-replay-hub[hidden] { display: none !important; }
.midorii-replay-hub-body { flex: 1 1 auto; min-height: 0; overflow: auto; }
${overlayScrollbarCss('.midorii-replay-hub-body')}
.midorii-replay-hub-grid {
    max-width: 1100px; margin: 0 auto; padding: 18px 18px 32px;
    display: grid; grid-template-columns: minmax(360px, 500px) minmax(0, 1fr); gap: 20px; align-items: start;
}
@media (max-width: 820px) { .midorii-replay-hub-grid { grid-template-columns: minmax(0, 1fr); } }
.midorii-replay-card {
    padding: 14px 16px; background: var(--vela-surface);
    border: 1px solid var(--vela-border-faint); border-radius: var(--vela-radius-sm);
}
.midorii-replay-card h2 { margin: 0 0 2px; font-size: 15px; color: var(--vela-fg-bright); }
.midorii-replay-card > p { margin: 0 0 14px; color: var(--vela-fg-muted); font-size: 12px; }
.midorii-replay-field { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 12px; }
.midorii-replay-field > span { white-space: nowrap; color: var(--vela-fg); }
.midorii-replay-field > .midorii-replay-control { display: flex; align-items: center; gap: 6px; min-width: 0; flex: 0 1 auto; }
.midorii-replay-field .vela-text[data-fill] { width: 260px; max-width: 100%; }
.midorii-replay-field .midorii-replay-input { padding: 0 8px; }
.midorii-replay-field input[type='date'] { width: 148px; }
.midorii-replay-field input[type='time'] { width: 112px; }
.midorii-replay-note { margin: -6px 0 12px; color: var(--vela-fg-muted); font-size: 12px; text-align: right; }
.midorii-replay-input {
    background: var(--vela-surface-overlay); color: var(--vela-fg); border: 1px solid var(--vela-border-soft);
    border-radius: var(--vela-control-radius); padding: 0 10px; height: var(--vela-control-h);
    font: inherit; outline: none; min-width: 0;
}
.midorii-replay-input:focus-visible { border-color: var(--vela-accent-bright, #2962ff); }
.midorii-replay-card details { margin: 4px 0 12px; border-top: 1px solid var(--vela-border-soft); padding-top: 10px; }
.midorii-replay-card summary { cursor: pointer; color: var(--vela-fg-muted); font-size: 12px; margin-bottom: 10px; }
.midorii-replay-card summary:hover { color: var(--vela-fg-bright); }
.midorii-replay-error { min-height: 1.2em; margin: 4px 0 8px; color: var(--vela-danger); }
.midorii-replay-start { display: flex; justify-content: flex-end; }
.midorii-replay-empty { padding: 18px 0 6px; color: var(--vela-fg-muted); }
.midorii-replay-session {
    display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px; padding: 10px 0;
    border-top: 1px solid var(--vela-border-soft);
}
.midorii-replay-session:first-of-type { border-top: 0; }
.midorii-replay-session-main { flex: 1 1 220px; min-width: 0; }
.midorii-replay-session-name {
    display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    color: var(--vela-fg-bright); font-weight: 600;
}
.midorii-replay-session-line {
    display: block; color: var(--vela-fg-muted); font-size: 12px;
}
.midorii-replay-session-line .pos { color: var(--vela-success, #26a69a); }
.midorii-replay-session-line .neg { color: var(--vela-danger); }
.midorii-replay-session-actions { flex: none; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
.midorii-replay-session-actions .vela-dialog-btn { padding: 0 10px; }
.midorii-replay-notice {
    max-width: 1100px; margin: 14px auto 0; padding: 8px 12px; box-sizing: border-box;
    border: 1px solid var(--vela-border-soft); border-radius: var(--vela-radius-sm);
    background: var(--vela-surface); color: var(--vela-fg);
    display: flex; align-items: center; gap: 12px;
}
.midorii-replay-notice[hidden] { display: none !important; }
.midorii-replay-notice[data-kind='success'] { border-color: var(--vela-success, #26a69a); }
.midorii-replay-notice span { flex: 1 1 auto; }
.midorii-replay-hub[data-busy='1'] button { pointer-events: none; opacity: .6; }
`;

/** `YYYY-MM-DD` in UTC — the date input's own format, and the clock is UTC. */
const isoDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** How far past a dataset's start a fresh session opens, so it has history behind it. */
const LEAD = 500 * HOUR;

/**
 * Where a fresh session starts: a few hundred bars past the dataset's start — except on a
 * dataset shorter than that, which a recording of a day or two always is, where it starts a
 * quarter of an hour in because five hundred hours past its start is past its end.
 */
function startFor(d: { first?: number | null; last?: number | null }): { date: string; time: string } {
    const first = d.first ?? Date.now();
    if (d.last != null && d.last - first < LEAD) {
        const at = new Date(first + 15 * 60_000).toISOString();
        return { date: at.slice(0, 10), time: at.slice(11, 16) };
    }
    return { date: isoDate(first + LEAD), time: '00:00' };
}

/**
 * A start picked at random from the part of a dataset a session can sensibly open in: not so
 * early there is no history behind it, not so late there is nothing left to play. Rounded to
 * the quarter hour, which is as fine as anyone chooses a start by hand.
 */
export function randomStart(d: { first?: number | null; last?: number | null }, random = Math.random): { date: string; time: string } {
    if (d.first == null || d.last == null || d.last <= d.first) return startFor(d);
    const span = d.last - d.first;
    const lo = d.first + Math.min(LEAD, span * 0.1);
    const hi = d.last - Math.min(DAY, span * 0.1);
    const at = new Date(Math.round((lo + random() * (hi - lo)) / 900_000) * 900_000).toISOString();
    return { date: at.slice(0, 10), time: at.slice(11, 16) };
}

function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
    const el = document.createElement('label');
    el.className = 'midorii-replay-field';
    const text = document.createElement('span');
    text.textContent = label;
    if (hint) text.title = hint;
    const wrap = document.createElement('div');
    wrap.className = 'midorii-replay-control';
    wrap.appendChild(control);
    el.append(text, wrap);
    return el;
}

/** One line on what the account is set to, for the closed "Account" section. */
function accountSummary(a: ReplayAccountSettings): string {
    return [
        a.costsOn ? 'costs on' : 'no costs',
        `${a.pointValue} per point`,
        a.hedging ? 'hedging' : 'netting',
    ].join(' · ');
}

function card(title: string, sub: string): HTMLElement {
    const el = document.createElement('section');
    el.className = 'midorii-replay-card';
    const h = document.createElement('h2');
    h.textContent = title;
    const p = document.createElement('p');
    p.textContent = sub;
    el.append(h, p);
    return el;
}

/**
 * The Replay tab when no session is open: start one, or carry on with one put down earlier.
 *
 * A screen of its own rather than a dialog, because it has to hold more than a dialog should —
 * the sessions on disk and what to do with each (resume, rename, duplicate, delete), and the
 * setup of a new one. It deliberately does not ask for a timeframe: that is how a session is
 * looked at, not a property of it, and the chart's own picker changes it at any point.
 *
 * Everything it knows comes from disk when `refresh` runs, and the half-filled setup survives a
 * refresh — coming back to the tab must not wipe a form somebody was in the middle of.
 */
export function mountReplayHub(
    container: HTMLElement,
    theme: VelaTheme,
    onChoose: (choice: SetupChoice) => void,
): ReplayHub {
    injectStyles(STYLE_ID, CSS, container.ownerDocument);
    const el = document.createElement('div');
    el.className = 'midorii-replay-hub';
    ensureUIHost(el, theme);

    const head = screenHead(document, {
        title: 'Replay',
        sub: 'Play a past market one candle at a time and trade it on a practice account.',
    });
    const body = document.createElement('div');
    body.className = 'midorii-replay-hub-body';
    const noticeEl = document.createElement('div');
    noticeEl.className = 'midorii-replay-notice';
    noticeEl.setAttribute('role', 'status');
    noticeEl.hidden = true;
    const noticeText = document.createElement('span');
    const noticeClose = button('Dismiss');
    noticeClose.onclick = () => { noticeEl.hidden = true; };
    noticeEl.append(noticeText, noticeClose);
    const grid = document.createElement('div');
    grid.className = 'midorii-replay-hub-grid';
    const newCard = card('New session', 'Pick a market and where to begin.');
    const listCard = card('Your sessions', 'Sessions you put down, ready to pick up again.');
    grid.append(newCard, listCard);
    body.append(noticeEl, grid);
    el.append(head.el, body);
    container.appendChild(el);

    const formHost = document.createElement('div');
    newCard.appendChild(formHost);
    const listHost = document.createElement('div');
    listCard.appendChild(listHost);

    let formKey = '';
    let busy = false;
    let errorEl: HTMLElement | null = null;

    const showError = (message: string): void => {
        if (errorEl) errorEl.textContent = message;
    };

    // ── the new-session form ─────────────────────────────────────────────

    function buildForm(datasets: MidoriDatasetMeta[], recordings: Array<{ name: string; days: string[] }>): void {
        formHost.replaceChildren();
        if (datasets.length === 0) {
            const none = document.createElement('div');
            none.className = 'midorii-replay-empty';
            none.textContent = 'No market data is downloaded yet. Download a market from the Chart tab first — then it can be replayed here.';
            formHost.appendChild(none);
            errorEl = null;
            return;
        }

        const recordedFor = (dataset: string): string | null => {
            if (!dataset.endsWith('.REC')) return null;
            const name = dataset.slice(0, -'.REC'.length);
            return recordings.some((r) => r.name === name) ? name : null;
        };

        let symbol = datasets[0]!.symbol;
        let balance = 10_000;
        let ticks: string | null = recordedFor(symbol);

        const name = new TextField({ value: '' });
        name.input.placeholder = 'Optional';
        name.input.maxLength = 120;

        const initial = startFor(datasets[0]!);
        const dateInput = document.createElement('input');
        dateInput.type = 'date';
        dateInput.className = 'midorii-replay-input';
        dateInput.value = initial.date;
        const timeInput = document.createElement('input');
        timeInput.type = 'time';
        timeInput.className = 'midorii-replay-input';
        timeInput.value = initial.time;

        const range = document.createElement('div');
        range.className = 'midorii-replay-note';
        const describeRange = (d: MidoriDatasetMeta | undefined): void => {
            if (d?.first != null) {
                dateInput.min = isoDate(d.first);
                if (d.last != null) dateInput.max = isoDate(d.last);
            }
            range.textContent = d?.first != null
                ? `${d.symbol} has data from ${formatWhen(d.first)}${d.last != null ? ` to ${formatWhen(d.last)}` : ''} UTC.`
                : '';
        };
        describeRange(datasets[0]);

        const random = button('Random');
        random.title = 'Start somewhere in the data you have, without knowing where.';
        random.onclick = () => {
            const at = randomStart(datasets.find((d) => d.symbol === symbol) ?? {});
            dateInput.value = at.date;
            timeInput.value = at.time;
        };

        const startBox = document.createElement('div');
        startBox.className = 'midorii-replay-control';
        startBox.append(dateInput, timeInput, random);

        const ticksSelect = new Select({
            options: [
                { value: '', label: 'None — candles only' },
                ...recordings.map((r) => ({
                    value: r.name,
                    label: `${r.name} — ${r.days.length} recorded ${r.days.length === 1 ? 'day' : 'days'}`,
                })),
            ],
            value: ticks ?? '',
            onChange: (v) => { ticks = v || null; suggest(); },
        });

        const symbolSelect = new Select({
            options: datasets.map((d) => ({ value: d.symbol, label: d.symbol })),
            value: symbol,
            onChange: (v) => {
                symbol = v;
                // A recording's own candles come with its ticks, unless somebody has already chosen.
                const own = recordedFor(v);
                if (own && ticks === null) {
                    ticks = own;
                    ticksSelect.setValue(own);
                    suggest();
                }
                const d = datasets.find((x) => x.symbol === v);
                const start = startFor(d ?? {});
                dateInput.value = start.date;
                timeInput.value = start.time;
                describeRange(d);
            },
        });

        const balanceInput = new NumberInput({ value: balance, min: 1, step: 1000, onChange: (v) => { balance = v; } });

        /* How the account is kept. It starts from what the chosen recording says about its
         * contract and follows the market and the recording until somebody edits it — after
         * that it is theirs, and picking another market does not overwrite it. */
        let touched = false;
        let applying = false;
        const summary = document.createElement('summary');
        const account = instrumentForm(field, SPOT_ACCOUNT, () => {
            if (!applying) touched = true;
            summary.textContent = `Account — ${accountSummary(account.read())}`;
        });
        summary.textContent = `Account — ${accountSummary(account.read())}`;
        const details = document.createElement('details');
        details.append(summary, ...account.rows);

        const error = document.createElement('div');
        error.className = 'midorii-replay-error';
        errorEl = error;

        let suggesting: Promise<void> = Promise.resolve();
        let suggestion = 0;
        const suggest = (): void => {
            if (touched) return;
            const mine = ++suggestion;
            const recording = ticks;
            suggesting = (async () => {
                try {
                    const contract = recording ? await window.midori.ticks.meta(recording) : null;
                    if (mine !== suggestion || touched) return;
                    applying = true;
                    try { account.set(suggestAccount(contract)); } finally { applying = false; }
                    error.textContent = '';
                } catch (err: unknown) {
                    if (mine !== suggestion) return;
                    console.error('[midorii] could not read the contract a recording is of', err);
                    error.textContent = `Could not read the contract of ${recording}: `
                        + `${err instanceof Error ? err.message : String(err)} Set the point value yourself.`;
                }
            })();
        };

        const start = button('Start session', 'primary');
        start.onclick = async () => {
            if (busy) return;
            // A contract still being read would otherwise be started on its defaults.
            await suggesting;
            const startTime = Date.parse(`${dateInput.value}T${timeInput.value || '00:00'}:00Z`);
            if (!Number.isFinite(startTime)) {
                error.textContent = 'Pick a start date.';
                return;
            }
            const chosen = datasets.find((x) => x.symbol === symbol);
            if (chosen?.first != null && startTime <= chosen.first) {
                error.textContent = `${symbol} begins at ${formatWhen(chosen.first)} UTC — start after that.`;
                return;
            }
            if (chosen?.last != null && startTime >= chosen.last) {
                error.textContent = `${symbol} ends at ${formatWhen(chosen.last)} UTC — start before that.`;
                return;
            }
            const settings = account.read();
            try {
                accountOptions(settings); // refuses a value the engine would refuse, here, by name
            } catch (err: unknown) {
                error.textContent = err instanceof Error ? err.message : String(err);
                return;
            }
            error.textContent = '';
            const given = name.input.value.trim();
            onChoose({
                kind: 'new',
                setup: {
                    symbol,
                    startTime,
                    balance,
                    ticks,
                    account: settings,
                    // An unnamed session is still told apart in the list: by what it plays and where it began.
                    name: given || `${symbol} from ${isoDate(startTime)}`,
                },
            });
        };
        const startRow = document.createElement('div');
        startRow.className = 'midorii-replay-start';
        startRow.appendChild(start);

        formHost.append(
            field('Name', name.el),
            field('Market', symbolSelect.el),
            field('Play recorded ticks', ticksSelect.el),
            field('Start (UTC)', startBox),
            range,
            field('Starting balance', balanceInput.el),
            details,
            error,
            startRow,
        );
        suggest();
    }

    // ── the session list ─────────────────────────────────────────────────

    function sessionRow(s: MidoriSessionSummary): HTMLElement {
        const row = document.createElement('div');
        row.className = 'midorii-replay-session';

        const main = document.createElement('div');
        main.className = 'midorii-replay-session-main';
        const title = document.createElement('span');
        title.className = 'midorii-replay-session-name';
        title.textContent = s.name || 'Untitled';
        title.title = s.name || 'Untitled';
        const line = document.createElement('span');
        line.className = 'midorii-replay-session-line';
        const bits = [`${s.symbol} · ${timeframeLabel(s.timeframe)}`, `at ${formatWhen(s.clock)}`];
        bits.push(s.trades === 0 ? 'no trades yet' : `${s.trades} ${s.trades === 1 ? 'trade' : 'trades'}`);
        if (s.openPositions > 0) bits.push(`${s.openPositions} open`);
        line.append(bits.join(' · '));
        if (s.equity != null && s.initialBalance) {
            const change = s.equity / s.initialBalance - 1;
            const tone = document.createElement('span');
            tone.className = change > 0 ? 'pos' : change < 0 ? 'neg' : '';
            tone.textContent = ` · ${formatMoney(s.equity)} (${formatPercent(change, 2, true)})`;
            line.append(tone);
        }
        line.title = `Put down ${formatDay(s.savedAt)}`;
        main.append(title, line);

        const actions = document.createElement('div');
        actions.className = 'midorii-replay-session-actions';
        const resume = button('Resume', 'primary');
        resume.onclick = () => { if (!busy) onChoose({ kind: 'resume', sessionId: s.id }); };

        const rename = button('Rename');
        rename.onclick = () => {
            const input = document.createElement('input');
            input.className = 'midorii-replay-input';
            input.value = s.name;
            input.maxLength = 120;
            input.style.width = '100%';
            main.replaceChildren(input);
            input.focus();
            input.select();
            let done = false;
            const finish = (save: boolean): void => {
                if (done) return;
                done = true;
                if (!save || input.value.trim() === s.name) { void refreshSessions(); return; }
                window.midori.replay.renameSession(s.id, input.value)
                    .catch((err: unknown) => showError(`Could not rename: ${err instanceof Error ? err.message : String(err)}`))
                    .finally(() => void refreshSessions());
            };
            input.onkeydown = (e) => {
                if (e.key === 'Enter') finish(true);
                else if (e.key === 'Escape') finish(false);
            };
            input.onblur = () => finish(true);
        };

        const copy = button('Duplicate');
        copy.title = 'Store a copy, to play the same position out another way.';
        copy.onclick = () => {
            window.midori.replay.duplicateSession(s.id)
                .catch((err: unknown) => showError(`Could not duplicate: ${err instanceof Error ? err.message : String(err)}`))
                .finally(() => void refreshSessions());
        };

        const remove = button('Delete', 'danger');
        let armedAt = 0;
        remove.onclick = () => {
            // Two presses: a session holds an afternoon's trades and there is no getting it back.
            if (Date.now() - armedAt > 4000) {
                armedAt = Date.now();
                remove.textContent = 'Really?';
                setTimeout(() => { if (remove.isConnected && Date.now() - armedAt >= 4000) remove.textContent = 'Delete'; }, 4100);
                return;
            }
            window.midori.replay.deleteSession(s.id)
                .catch((err: unknown) => showError(`Could not delete: ${err instanceof Error ? err.message : String(err)}`))
                .finally(() => void refreshSessions());
        };

        actions.append(resume, rename, copy, remove);
        row.append(main, actions);
        return row;
    }

    async function refreshSessions(): Promise<void> {
        const sessions = await window.midori.replay.sessions();
        listHost.replaceChildren();
        if (sessions.length === 0) {
            const none = document.createElement('div');
            none.className = 'midorii-replay-empty';
            none.textContent = 'Nothing put down yet. Press “Pause session for later” while playing and it appears here.';
            listHost.appendChild(none);
            return;
        }
        for (const s of sessions) listHost.appendChild(sessionRow(s));
    }

    // ── public ───────────────────────────────────────────────────────────

    return {
        el,
        async refresh() {
            const [datasets, recorder] = await Promise.all([
                window.midori.data.datasets(),
                /* Best effort: a replay on candles needs nothing from the recorder, and one that
                 * cannot be asked must not stop a session being started. */
                window.midori.recorder.status().catch((err: unknown) => {
                    console.error('[midorii] could not read what has been recorded', err);
                    return { enabled: false, recordings: [] };
                }),
            ]);
            // Rebuilt only when the markets changed: otherwise a form in progress stays as it is.
            const key = JSON.stringify([datasets.map((d) => [d.symbol, d.first, d.last]), recorder.recordings.map((r) => [r.name, r.days.length])]);
            if (key !== formKey) {
                formKey = key;
                buildForm(datasets, recorder.recordings);
            }
            await refreshSessions();
        },
        setTheme(next) {
            ensureUIHost(el, next);
        },
        setBusy(next) {
            busy = next;
            if (next) el.dataset.busy = '1';
            else delete el.dataset.busy;
        },
        showError,
        notice(message, kind) {
            noticeText.textContent = message;
            noticeEl.dataset.kind = kind;
            noticeEl.hidden = false;
        },
    };
}
