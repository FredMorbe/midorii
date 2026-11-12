import { Select, TextField, iconEl, injectStyles } from '../../../src/ui';
import { RISK_PARAM_KEYS, STRATEGIES, resolveStrategyParams, strategyCatalog } from '../strategies';
import { LIVE_GUARD_PARAMS, resolveGuards } from '../strategies/liveGuards';
import { fieldGrid, fieldRow, paramField } from '../strategies/paramFields';
import type { StrategyParams } from '../strategies/types';
import { NumberInput } from '../../../src/ui';
import { button, sectionLabel } from '../runs/runViews';
import { VENUE_OPTIONS, type BotConfig, type BotVenue } from './botTypes';
import { savedStrategyTimeframe } from '../strategies/settingsTransfer';

/**
 * What a bot is set to, as a form.
 *
 * Four sections, in the order somebody actually decides them: what it trades, which
 * strategy and how that strategy is set, and — last, because it is the part a backtest
 * never had to answer — what it is allowed to do while nobody is watching.
 *
 * The strategy's own settings are the strategy's, copied
 * -----------------------------------------------------
 * A new bot starts from whatever the Strategies tab has that strategy set to, and then owns
 * its copy. That is deliberate in both directions: starting from the tuned settings is what
 * makes a bot one press away from a backtest that worked, and owning the copy is what stops
 * a change made on the Strategies tab from silently retuning a bot that is holding a
 * position. The form says so.
 */

const STYLE_ID = 'midorii-bot-form';
const CSS = `
.midorii-botform-heading { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin: 0 0 20px; }
.midorii-botform-eyebrow { color: var(--vela-accent-bright, #67b7ff); font-size: 10px; font-weight: 700; letter-spacing: .13em; }
.midorii-botform-heading h2 { margin: 3px 0 2px; color: var(--vela-fg-bright); font-size: 22px; font-weight: 650; letter-spacing: -.025em; }
.midorii-botform-heading p { margin: 0; color: var(--vela-fg-muted); font-size: 12px; }
.midorii-botform-save-state { flex: none; margin-top: 4px; padding: 5px 9px; border: 1px solid var(--vela-border); border-radius: 99px; color: var(--vela-fg-muted); font-size: 11px; }
.midorii-botform-save-state[data-dirty='1'] { border-color: var(--vela-warning, #d9822b); color: var(--vela-warning, #d9822b); }
.midorii-botform-tabs { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; margin-bottom: 18px; }
.midorii-botform-tab { all: unset; box-sizing: border-box; display: flex; flex-direction: column; padding: 9px 13px; border: 1px solid var(--vela-border); border-radius: var(--vela-radius-sm); cursor: pointer; background: var(--vela-surface); }
.midorii-botform-tab:hover { background: var(--vela-hover); }
.midorii-botform-tab[data-active='1'] { border-color: var(--vela-accent-bright, #67b7ff); box-shadow: inset 0 0 0 1px var(--vela-accent-bright, #67b7ff); }
.midorii-botform-tab strong { color: var(--vela-fg-bright); font-size: 13px; font-weight: 650; }
.midorii-botform-tab small { color: var(--vela-fg-muted); font-size: 11px; }
.midorii-botform-tab:focus-visible { outline: 2px solid var(--vela-accent-bright, #67b7ff); outline-offset: 2px; }
.midorii-botform-card {
    padding: 16px 18px; margin-bottom: 12px;
    background: var(--vela-surface);
    border: 1px solid var(--vela-border-faint);
    border-radius: var(--vela-radius-sm);
}
.midorii-botform-sub { margin: 0 0 12px; color: var(--vela-fg-muted); font-size: 12.5px; line-height: 1.55; }
.midorii-botform-actions { position: sticky; bottom: 0; z-index: 2; display: flex; flex-wrap: wrap; align-items: center; gap: 9px; margin: 18px -18px -32px; padding: 11px 18px; border-top: 1px solid var(--vela-border); background: var(--vela-bg); }
.midorii-botform-status { color: var(--vela-fg-muted); font-size: 12px; }
.midorii-botform-status[data-error='1'] { color: var(--vela-danger); }
.midorii-botform-warn {
    margin: 0 0 12px; padding: 8px 10px;
    border-left: 2px solid var(--vela-warning, #d9822b);
    background: var(--vela-surface-overlay);
    color: var(--vela-fg); font-size: 12.5px; line-height: 1.55;
}
@media (max-width: 700px) {
    .midorii-botform-heading { flex-direction: column; gap: 7px; }
    .midorii-botform-tabs { grid-template-columns: 1fr; }
    .midorii-botform-actions { margin-inline: -12px; padding-inline: 12px; }
}
`;

/** The timeframes a bot may run on. A bot on a one-minute chart rebuilds its detectors
 *  sixty times an hour, which is fine; anything finer is a tick strategy this app has no
 *  data shape for, so it is simply not offered. */
const TIMEFRAME_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
    { value: '1', label: '1 minute' },
    { value: '2', label: '2 minutes' },
    { value: '3', label: '3 minutes' },
    { value: '5', label: '5 minutes' },
    { value: '15', label: '15 minutes' },
    { value: '30', label: '30 minutes' },
    { value: '60', label: '1 hour' },
    { value: '240', label: '4 hours' },
    { value: '480', label: '8 hours' },
    { value: '1D', label: '1 day' },
];

/** This form's own older wording for the daily bar, still carried by saved bots. The
 *  venues declare the canonical `D`, so the two have to be spoken to in one spelling. */
const canonicalTf = (value: string): string => (value === '1D' ? 'D' : value);

/** The provider segment of a market string (`capital:EURUSD` → `capital`), or null when
 *  it carries none — the same grammar the chart's symbol resolution reads. */
function venueOf(symbol: string): string | null {
    const colon = symbol.indexOf(':');
    return colon > 0 ? symbol.slice(0, colon).trim().toLowerCase() : null;
}

export interface BotFormOptions {
    /** The bot as it stands. Never mutated — the form works on its own copy. */
    bot: BotConfig;
    /** Whether the fields may be edited at all. A running bot's cannot. */
    readOnly: boolean;
    /** Whether a Capital.com account is configured on this machine, so the venue picker can
     *  say why it is not offering one. */
    capitalConfigured: boolean;
    /** Save the edited bot. Rejects with what went wrong. */
    onSave: (bot: BotConfig) => Promise<void>;
    /** Throw it away. */
    onDelete: () => void;
    /**
     * File this bot's account as a run and start it over on its opening balance.
     *
     * Separate from deleting the bot, and separate from editing it: an account that has been
     * trading for weeks is the only evidence of what the bot did, so starting over has to
     * mean filing it, not binning it. Refused while the bot is running.
     */
    onResetAccount: () => void;
    /** How many trades the stored account has, so the reset can say what it is filing. */
    accountTrades: number;
    /**
     * What a VENUE serves, by the name a market string prefixes itself with — the
     * providers' own `supportedTimeframes`, so the form narrows its timeframe field to
     * bars the typed market can actually be fed. A venue absent from the map is taken
     * to serve everything: the form is not the place to invent a restriction.
     */
    venueTimeframes: Readonly<Record<string, readonly string[]>>;
    /** Open the asset list. Resolves with the chosen `provider:ticker`, or null when it was
     *  dismissed. Rejects with what went wrong. */
    pickAsset: () => Promise<string | null>;
    onDirtyChange?: (dirty: boolean) => void;
}

export interface BotForm {
    readonly el: HTMLElement;
    readonly dirty: boolean;
    save(): Promise<boolean>;
    /** Repaint from the bot handed in, discarding unsaved edits. */
    reset(bot: BotConfig, readOnly: boolean, accountTrades: number, capitalConfigured: boolean): void;
}

/** Build the form into a fresh element. */
export function mountBotForm(doc: Document, opts: BotFormOptions): BotForm {
    injectStyles(STYLE_ID, CSS, doc);

    const root = doc.createElement('div');

    let bot = opts.bot;
    let readOnly = opts.readOnly;
    /** The edits, live. Reset whenever the form is pointed at a different bot. */
    let draft = draftOf(bot);
    let status: { text: string; error?: boolean } | null = null;
    let saving = false;
    let formRevision = 0;
    let accountTrades = opts.accountTrades;
    let capitalConfigured = opts.capitalConfigured;
    let statusNode: HTMLElement | null = null;
    let titleNode: HTMLElement | null = null;
    let summaryNode: HTMLElement | null = null;
    let badgeNode: HTMLElement | null = null;
    let saveNode: HTMLButtonElement | null = null;
    let dirty = false;
    let page: 'basic' | 'advanced' = 'basic';

    function draftSummary(): string {
        const timeframe = TIMEFRAME_OPTIONS.find((option) => option.value === draft.timeframe)?.label ?? draft.timeframe;
        return `${draft.symbol || 'Choose an asset'} · ${timeframe} · ${draft.venue === 'paper' ? 'Paper account' : 'Capital.com'}`;
    }

    /** A scalar edit changes the draft, not the form's structure. Keep the controls mounted so
     *  the focused field and its selection survive each keystroke. */
    function markChanged(): void {
        const next = JSON.stringify(draft) !== JSON.stringify(draftOf(bot));
        if (next !== dirty) {
            dirty = next;
            opts.onDirtyChange?.(dirty);
        }
        if (titleNode) titleNode.textContent = draft.name;
        if (summaryNode) summaryNode.textContent = draftSummary();
        if (badgeNode) {
            badgeNode.dataset.dirty = dirty ? '1' : '0';
            badgeNode.textContent = dirty ? 'Unsaved changes' : 'Saved configuration';
        }
        if (saveNode) saveNode.disabled = readOnly || saving || !dirty;
        status = null;
        if (!statusNode) return;
        statusNode.textContent = '';
        delete statusNode.dataset.error;
    }

    function draftOf(source: BotConfig): {
        name: string;
        strategy: string;
        symbol: string;
        timeframe: string;
        venue: BotVenue;
        balance: number;
        params: StrategyParams;
        guards: StrategyParams;
    } {
        return {
            name: source.name,
            strategy: source.strategy,
            symbol: source.symbol,
            timeframe: source.timeframe,
            venue: source.venue,
            balance: source.balance,
            params: safeParams(source.strategy, source.params),
            guards: safeGuards(source.guards),
        };
    }

    /** Stored settings resolved against the current schema, falling back to the defaults
     *  where they no longer fit — the same rule the Strategies tab follows, and the reason
     *  a renamed parameter is a default rather than an unreadable bot. */
    function safeParams(strategy: string, raw: Record<string, unknown>): StrategyParams {
        try {
            return resolveStrategyParams(strategy, raw);
        } catch {
            return STRATEGIES[strategy] ? resolveStrategyParams(strategy, {}) : {};
        }
    }

    function safeGuards(raw: Record<string, unknown>): StrategyParams {
        try {
            return resolveGuards(raw);
        } catch {
            return resolveGuards({});
        }
    }

    function card(title?: string): HTMLElement {
        const el = doc.createElement('div');
        el.className = 'midorii-botform-card';
        if (title) el.appendChild(sectionLabel(title));
        return el;
    }

    function note(text: string, className = 'midorii-botform-sub'): HTMLElement {
        const el = doc.createElement('p');
        el.className = className;
        el.textContent = text;
        return el;
    }

    /* ── the sections ────────────────────────────────────────────────────── */

    /**
     * The asset, as a dropdown that opens the symbol search.
     *
     * Drawn as the kit's own select so it sits with the fields around it, but it cannot BE one:
     * a venue lists thousands of assets and a flat list of them is not a thing anybody can use.
     * Picking, rather than typing, is also what removes the mistyped ticker that the venue
     * refuses only when the bot starts. The choice repaints the form — the asset decides which
     * timeframes the field below may offer — and it does so on a pick, never under the pointer
     * of a button that is about to be pressed.
     */
    function assetDropdown(): HTMLElement {
        const wrap = doc.createElement('div');
        wrap.className = 'vela-select';
        wrap.dataset.size = 'md';
        wrap.dataset.fill = '';

        const button = doc.createElement('button');
        button.type = 'button';
        button.className = 'vela-select-trigger';
        button.disabled = readOnly || saving;
        const label = doc.createElement('span');
        label.className = 'vela-select-label';
        label.textContent = draft.symbol || 'Choose an asset…';
        const chevron = doc.createElement('span');
        chevron.className = 'vela-select-chevron';
        chevron.appendChild(iconEl('chevron-down', doc));
        button.append(label, chevron);
        wrap.appendChild(button);

        button.addEventListener('click', () => {
            if (readOnly || saving) return;
            const revision = formRevision;
            button.disabled = true;
            opts.pickAsset().then(
                (picked) => {
                    if (revision !== formRevision || readOnly || saving) return;
                    if (picked && picked !== draft.symbol) {
                        draft.symbol = picked;
                        markChanged();
                        paint();
                    } else {
                        button.disabled = readOnly;
                    }
                },
                (err: unknown) => {
                    if (revision !== formRevision) return;
                    status = { text: err instanceof Error ? err.message : String(err), error: true };
                    paint();
                },
            );
        });
        return wrap;
    }

    function marketCard(): HTMLElement {
        const el = card();
        el.appendChild(note(
            'What this bot trades, and where its orders go. A bot is bound to one asset: it '
            + 'watches that asset whatever the Chart tab happens to be showing, which is the '
            + 'whole point of it running unattended.',
        ));

        const grid = fieldGrid(doc);

        const name = new TextField({
            value: draft.name,
            fill: true,
            disabled: readOnly || saving,
            onChange: (v) => { draft.name = v.trim() || 'Bot'; markChanged(); },
        });
        grid.appendChild(fieldRow(doc, 'Name', name.el, 'What you call it. Never used as a key.'));

        grid.appendChild(fieldRow(
            doc,
            'Asset',
            assetDropdown(),
            'Picked from what each provider offers, written provider:ticker — capital:EURUSD, '
            + 'binance:BTCUSDT. Only providers with a live feed are listed; the local archive can '
            + 'be backtested but not traded.',
        ));

        const timeframe = new Select({
            options: timeframeOptions(),
            value: draft.timeframe,
            disabled: readOnly || saving,
            onChange: (v) => { draft.timeframe = v; markChanged(); },
        });
        grid.appendChild(fieldRow(
            doc,
            'Bars',
            timeframe.el,
            'The bars the strategy is fed. It sees each one when it closes and never while it '
            + 'is still forming — the same rule the backtest runs under.',
        ));

        const venue = new Select({
            options: VENUE_OPTIONS.map((v) => ({
                value: v.value,
                label: v.value === 'capital' && !capitalConfigured ? `${v.label} (no credentials)` : v.label,
            })),
            value: draft.venue,
            disabled: readOnly || saving,
            onChange: (v) => {
                draft.venue = v === 'capital' ? 'capital' : 'paper';
                markChanged();
                paint();
            },
        });
        grid.appendChild(fieldRow(
            doc,
            'Account',
            venue.el,
            'Paper is this app’s own engine at real prices — nothing reaches a venue. '
            + 'Capital.com sends real orders to whichever account the stored credentials point at.',
        ));

        if (draft.venue === 'paper') {
            const balance = new NumberInput({
                value: draft.balance,
                min: 1,
                max: 1e9,
                step: 1000,
                fill: false,
                disabled: readOnly || saving,
                onChange: (v) => { draft.balance = v; markChanged(); },
            });
            grid.appendChild(fieldRow(
                doc,
                'Starting cash',
                balance.el,
                'What this bot’s own paper account opens with. Its own — a bot does not share '
                + 'the Chart tab’s paper account, so hand-placed trades and automated ones are '
                + 'never mixed in one ledger.',
            ));
        }

        el.appendChild(grid);

        if (draft.venue === 'paper' && draft.symbol.startsWith('projectx:')) {
            el.appendChild(note(
                'Futures trade in whole contracts. If your risk or max leverage cannot cover '
                + 'one contract, the bot refuses the entry and records why in Bot activity.',
            ));
        }

        if (draft.venue === 'capital') {
            el.appendChild(note(
                capitalConfigured
                    ? 'This bot sends real orders. It is never resumed by itself when the app '
                      + 'starts — a real account is armed by a person, every time.'
                    : 'There are no Capital.com credentials on this machine, so this bot cannot '
                      + 'start. Add them under Settings.',
                'midorii-botform-warn',
            ));
        }
        return el;
    }

    function strategyCard(advanced: boolean): HTMLElement {
        const el = card(advanced ? 'Strategy details' : 'Strategy and risk');
        const catalog = strategyCatalog().filter((spec) => !spec.researchOnly);
        const spec = STRATEGIES[draft.strategy];

        if (!advanced) {
            const grid = fieldGrid(doc);
            const picker = new Select({
                options: catalog.map((s) => ({ value: s.id, label: s.name })),
                value: draft.strategy,
                disabled: readOnly || saving,
                onChange: (v) => {
                    draft.strategy = v;
                    draft.params = safeParams(v, {});
                    markChanged();
                    void loadStrategySettings(v);
                },
            });
            grid.appendChild(fieldRow(doc, 'Strategy', picker.el));
            el.appendChild(grid);
            const load = button('Load saved strategy settings');
            load.disabled = readOnly || saving;
            load.onclick = () => { void loadStrategySettings(draft.strategy); };
            el.appendChild(load);
        }

        if (!spec) {
            el.appendChild(note(`This build has no strategy called “${draft.strategy}”.`, 'midorii-botform-warn'));
            return el;
        }

        if (!advanced) el.appendChild(note(spec.description));

        const basicRisk = new Set(['riskMode', 'riskValue', 'rrr']);
        const risk = spec.params.filter((p) => RISK_PARAM_KEYS.includes(p.key) && basicRisk.has(p.key) !== advanced);
        const own = spec.params.filter((p) => !RISK_PARAM_KEYS.includes(p.key));

        if (risk.length > 0) {
            el.appendChild(sectionLabel(advanced ? 'Sizing and position management' : 'Risk per trade'));
            const riskGrid = fieldGrid(doc);
            for (const param of risk) riskGrid.appendChild(readOnlyGuard(paramField(doc, param, draft.params, markChanged)));
            el.appendChild(riskGrid);
        }

        if (advanced && own.length > 0) {
            el.appendChild(sectionLabel('What counts as a setup'));
            const ownGrid = fieldGrid(doc);
            for (const param of own) ownGrid.appendChild(readOnlyGuard(paramField(doc, param, draft.params, markChanged)));
            el.appendChild(ownGrid);
        }

        if (advanced) el.appendChild(note('These settings belong to this bot. Changes on the Strategies tab do not retune it.'));
        return el;
    }

    function guardsCard(): HTMLElement {
        const el = card();
        el.appendChild(note(
            'What the bot may do while nobody is watching. None of these can open a trade; every '
            + 'one of them can refuse one. A strategy that is already holding a position is never '
            + 'blocked from managing it — a guard that could strand a live position would cost '
            + 'more than it saves.',
        ));

        el.appendChild(sectionLabel('When it may trade'));
        const whenGrid = fieldGrid(doc);
        for (const param of LIVE_GUARD_PARAMS.slice(0, 4)) {
            whenGrid.appendChild(readOnlyGuard(paramField(doc, param, draft.guards, markChanged)));
        }
        el.appendChild(whenGrid);

        el.appendChild(sectionLabel('How much it may do'));
        const muchGrid = fieldGrid(doc);
        for (const param of LIVE_GUARD_PARAMS.slice(4, 10)) {
            muchGrid.appendChild(readOnlyGuard(paramField(doc, param, draft.guards, markChanged)));
        }
        el.appendChild(muchGrid);

        el.appendChild(sectionLabel('What it refuses to trade through'));
        const condGrid = fieldGrid(doc);
        for (const param of LIVE_GUARD_PARAMS.slice(10)) {
            condGrid.appendChild(readOnlyGuard(paramField(doc, param, draft.guards, markChanged)));
        }
        el.appendChild(condGrid);
        return el;
    }

    /** Disable every control inside a row when the bot is running. Done here rather than by
     *  passing `disabled` into each control, because the shared field factory builds them
     *  from a schema that knows nothing about a bot's state. */
    function readOnlyGuard(row: HTMLElement): HTMLElement {
        if (!readOnly && !saving) return row;
        for (const el of row.querySelectorAll('input, button, select, textarea')) {
            (el as HTMLInputElement).disabled = true;
        }
        row.style.opacity = '0.6';
        return row;
    }

    /* ── saving ──────────────────────────────────────────────────────────── */

    async function save(): Promise<boolean> {
        if (saving || readOnly) return false;
        const revision = formRevision;
        saving = true;
        status = null;
        paint();
        try {
            const next: BotConfig = {
                ...bot,
                name: draft.name,
                strategy: draft.strategy,
                symbol: draft.symbol,
                timeframe: draft.timeframe,
                venue: draft.venue,
                balance: draft.balance,
                params: { ...draft.params },
                guards: { ...draft.guards },
            };
            await opts.onSave(next);
            if (revision !== formRevision) return true;
            bot = next;
            dirty = false;
            opts.onDirtyChange?.(false);
            status = { text: 'Saved.' };
            return true;
        } catch (err) {
            if (revision === formRevision) {
                status = { text: err instanceof Error ? err.message : String(err), error: true };
            }
            return false;
        } finally {
            if (revision === formRevision) {
                saving = false;
                paint();
            }
        }
    }

    /** Fetch a fresh copy so an already open bot form can load a newly saved backtest. */
    async function loadStrategySettings(strategy: string): Promise<void> {
        if (saving || readOnly) return;
        const revision = formRevision;
        saving = true;
        paint();
        try {
            const stored = await window.midori.strategies.load();
            if (revision !== formRevision || readOnly || draft.strategy !== strategy) return;
            const settings = stored[strategy] ?? {};
            draft.params = resolveStrategyParams(strategy, settings);
            draft.timeframe = savedStrategyTimeframe(settings) ?? draft.timeframe;
            markChanged();
            status = { text: 'Loaded a copy of the saved strategy settings and bar interval. Save this bot to apply them.' };
        } catch (error) {
            if (revision !== formRevision) return;
            status = { text: `Could not load strategy settings: ${error instanceof Error ? error.message : String(error)}`, error: true };
        } finally {
            if (revision === formRevision) {
                saving = false;
                paint();
            }
        }
    }

    /**
     * The timeframe options for the market currently typed into the form — the venue's
     * own declaration, not this list in full (Capital.com has no 8-hour bar to give).
     *
     * What the bot is SET to always stays in the list. A market can be retyped under a
     * saved bot, and a field that quietly renamed its own value would be lying about
     * what the bot runs on; the venue refusing the bars is the honest place to find out.
     */
    function timeframeOptions(): Array<{ value: string; label: string }> {
        const venue = venueOf(draft.symbol);
        const supported = venue === null ? undefined : opts.venueTimeframes[venue];
        if (!supported || supported.length === 0) return [...TIMEFRAME_OPTIONS];
        const offered = new Set(supported);
        const kept = TIMEFRAME_OPTIONS.filter((o) => offered.has(canonicalTf(o.value)));
        if (kept.length === 0) return [...TIMEFRAME_OPTIONS];
        const current = TIMEFRAME_OPTIONS.find((o) => o.value === draft.timeframe);
        return current && !kept.includes(current) ? [...kept, current] : [...kept];
    }

    /* ── drawing ─────────────────────────────────────────────────────────── */

    function paint(): void {
        root.replaceChildren();

        const heading = doc.createElement('div');
        heading.className = 'midorii-botform-heading';
        const intro = doc.createElement('div');
        const eyebrow = doc.createElement('span');
        eyebrow.className = 'midorii-botform-eyebrow';
        eyebrow.textContent = 'BOT CONFIGURATION';
        const title = doc.createElement('h2');
        title.textContent = draft.name;
        titleNode = title;
        const summary = doc.createElement('p');
        summary.textContent = draftSummary();
        summaryNode = summary;
        intro.append(eyebrow, title, summary);
        const badge = doc.createElement('span');
        badge.className = 'midorii-botform-save-state';
        badge.dataset.dirty = dirty ? '1' : '0';
        badge.textContent = dirty ? 'Unsaved changes' : 'Saved configuration';
        badgeNode = badge;
        heading.append(intro, badge);
        root.appendChild(heading);

        const tabs = doc.createElement('div');
        tabs.className = 'midorii-botform-tabs';
        for (const [id, label, detail] of [
            ['basic', 'Basic', 'Market, account and risk'],
            ['advanced', 'Advanced', 'Strategy and safety rules'],
        ] as const) {
            const tab = doc.createElement('button');
            tab.type = 'button';
            tab.className = 'midorii-botform-tab';
            tab.dataset.active = page === id ? '1' : '0';
            tab.setAttribute('aria-pressed', String(page === id));
            const name = doc.createElement('strong');
            name.textContent = label;
            const sub = doc.createElement('small');
            sub.textContent = detail;
            tab.append(name, sub);
            tab.onclick = () => { page = id; paint(); };
            tabs.appendChild(tab);
        }
        root.appendChild(tabs);

        if (readOnly) {
            root.appendChild(note(
                'This bot is running. Its settings are what its open positions were sized under, '
                + 'so they cannot be changed until it is stopped.',
                'midorii-botform-warn',
            ));
        }

        if (page === 'basic') root.append(marketCard(), strategyCard(false));
        else root.append(strategyCard(true), guardsCard());

        const actions = doc.createElement('div');
        actions.className = 'midorii-botform-actions';

        const saveButton = button(saving ? 'Saving…' : 'Save', 'primary');
        saveButton.disabled = readOnly || saving || !dirty;
        saveButton.onclick = () => void save();
        saveNode = saveButton;

        const revert = button('Discard changes');
        revert.disabled = readOnly || saving;
        revert.onclick = () => {
            draft = draftOf(bot);
            dirty = false;
            opts.onDirtyChange?.(false);
            status = null;
            paint();
        };

        const reset = button('Start account over');
        reset.disabled = readOnly || saving;
        reset.title = accountTrades > 0
            ? `Files this bot's ${accountTrades} ${accountTrades === 1 ? 'trade' : 'trades'} as a run, `
              + 'then starts it again on its opening balance.'
            : 'This bot has traded nothing yet, so there is nothing to file.';
        reset.onclick = () => opts.onResetAccount();

        const remove = button('Delete bot', 'danger');
        remove.disabled = readOnly || saving;
        remove.title = 'Deletes the bot. Its account is filed as a run first — nothing it traded is lost.';
        remove.onclick = () => opts.onDelete();

        statusNode = doc.createElement('span');
        statusNode.className = 'midorii-botform-status';
        if (status) {
            statusNode.textContent = status.text;
            if (status.error) statusNode.dataset.error = '1';
        }

        actions.append(saveButton, revert, reset, remove, statusNode);
        root.appendChild(actions);
    }

    paint();

    return {
        el: root,
        get dirty() { return dirty; },
        save,
        reset(next, nextReadOnly, nextAccountTrades, nextCapitalConfigured): void {
            formRevision += 1;
            saving = false;
            bot = next;
            readOnly = nextReadOnly;
            accountTrades = nextAccountTrades;
            capitalConfigured = nextCapitalConfigured;
            draft = draftOf(next);
            dirty = false;
            opts.onDirtyChange?.(false);
            status = null;
            paint();
        },
    };
}
