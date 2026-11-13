import { Select, TextField, iconEl, injectStyles } from '../../../src/ui';
import { RISK_PARAM_KEYS, STRATEGIES, describeParams, formatClock, resolveStrategyParams, strategyCatalog } from '../strategies';
import { LIVE_GUARD_PARAMS, guardsOf, resolveGuards } from '../strategies/liveGuards';
import { fieldGrid, fieldRow, paramField } from '../strategies/paramFields';
import type { StrategyParams } from '../strategies/types';
import { NumberInput } from '../../../src/ui';
import { button, sectionLabel, settingsGrid } from '../runs/runViews';
import { formatMoney } from '../format';
import { VENUE_OPTIONS, startRefusal, type BotConfig, type BotVenue } from './botTypes';
import { daysText, ruleRows } from './botRules';
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
.midorii-botform-setup {
    display: grid; grid-template-columns: minmax(0, 1fr) 300px; column-gap: 28px; align-items: start;
}
.midorii-botform-nav {
    grid-column: 1 / -1; position: sticky; top: 0; z-index: 4;
    display: flex; flex-wrap: wrap; align-items: center; gap: 4px;
    margin-bottom: 18px; padding: 9px 0;
    background: var(--vela-bg); border-bottom: 1px solid var(--vela-border);
}
.midorii-botform-nav button {
    all: unset; box-sizing: border-box; display: inline-flex; align-items: center; gap: 8px;
    padding: 4px 12px 4px 5px; border-radius: 99px;
    color: var(--vela-fg-muted); font-size: 12px; font-weight: 600; cursor: pointer;
}
.midorii-botform-nav button:hover { background: var(--vela-hover); color: var(--vela-fg-bright); }
.midorii-botform-nav button:focus-visible { outline: 2px solid var(--vela-accent-bright, #67b7ff); outline-offset: 1px; }
.midorii-botform-nav-gap { flex: 1; }
.midorii-botform-nav-hint { color: var(--vela-warning, #d9822b); font-size: 12px; font-weight: 600; }
.midorii-botform-nav-hint[data-ok='1'] { color: var(--vela-up, #089981); }
.midorii-botform-lock {
    grid-column: 1 / -1; margin: 0 0 18px; padding: 10px 14px;
    border: 1px solid var(--vela-warning, #d9822b); border-radius: var(--vela-radius-sm);
    background: var(--vela-surface-overlay); color: var(--vela-fg); font-size: 12.5px; line-height: 1.55;
}
.midorii-botform-steps { min-width: 0; }
.midorii-botform-step {
    position: relative; display: grid; grid-template-columns: 28px minmax(0, 1fr); column-gap: 14px;
    padding: 4px 0 24px; scroll-margin-top: 58px;
}
.midorii-botform-step::before {
    content: ''; position: absolute; left: 13.5px; top: 32px; bottom: 4px; width: 1px; background: var(--vela-border);
}
.midorii-botform-step:last-child { padding-bottom: 8px; }
.midorii-botform-step:last-child::before { display: none; }
.midorii-botform-n {
    z-index: 1; display: grid; place-items: center; flex: none;
    width: 28px; height: 28px; border-radius: 50%;
    border: 1px solid var(--vela-border-strong); background: var(--vela-bg);
    color: var(--vela-fg-muted); font-size: 12px; font-weight: 700;
}
.midorii-botform-nav .midorii-botform-n { width: 22px; height: 22px; font-size: 11px; }
[data-ok='1'] > .midorii-botform-n { border-color: var(--vela-up, #089981); color: var(--vela-up, #089981); }
[data-ok='0'] > .midorii-botform-n { border-color: var(--vela-warning, #d9822b); color: var(--vela-warning, #d9822b); }
.midorii-botform-step-head h3 { margin: 3px 0 0; color: var(--vela-fg-bright); font-size: 15px; font-weight: 650; letter-spacing: -.01em; }
.midorii-botform-step-head p { margin: 2px 0 12px; color: var(--vela-fg-muted); font-size: 12.5px; line-height: 1.5; }
.midorii-botform-step-body { grid-column: 2; min-width: 0; }
.midorii-botform-sub { margin: 0 0 12px; color: var(--vela-fg-muted); font-size: 12.5px; line-height: 1.55; }
.midorii-botform-opts { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 14px; }
.midorii-botform-opt {
    all: unset; box-sizing: border-box; display: flex; flex-direction: column; gap: 2px;
    padding: 10px 13px; border: 1px solid var(--vela-border-strong); border-radius: var(--vela-radius-sm);
    background: var(--vela-surface); cursor: pointer;
}
.midorii-botform-opt:hover { background: var(--vela-hover); }
.midorii-botform-opt:focus-visible { outline: 2px solid var(--vela-accent-bright, #67b7ff); outline-offset: 2px; }
.midorii-botform-opt[aria-pressed='true'] { border-color: var(--vela-accent-bright, #67b7ff); box-shadow: inset 0 0 0 1px var(--vela-accent-bright, #67b7ff); }
.midorii-botform-opt[data-live][aria-pressed='true'] { border-color: var(--vela-danger); box-shadow: inset 0 0 0 1px var(--vela-danger); }
.midorii-botform-opt[disabled] { opacity: .6; cursor: default; }
.midorii-botform-opt strong { display: flex; align-items: center; gap: 8px; color: var(--vela-fg-bright); font-size: 13px; font-weight: 650; }
.midorii-botform-opt small { color: var(--vela-fg-muted); font-size: 11.5px; line-height: 1.45; }
.midorii-botform-pill {
    padding: 1px 7px; border: 1px solid var(--vela-danger); border-radius: 99px;
    color: var(--vela-danger); font-size: 10px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase;
}
.midorii-botform-more { margin-top: 14px; border-top: 1px solid var(--vela-border-faint); padding-top: 10px; }
.midorii-botform-more > summary { cursor: pointer; color: var(--vela-fg); font-size: 12.5px; font-weight: 600; }
.midorii-botform-more > summary small { margin-left: 8px; color: var(--vela-fg-muted); font-weight: 400; }
.midorii-botform-more[open] > summary { margin-bottom: 12px; }
.midorii-botform-aside {
    position: sticky; top: 58px; overflow: hidden;
    border: 1px solid var(--vela-border); border-radius: var(--vela-radius-sm); background: var(--vela-surface);
}
.midorii-botform-aside h3 { margin: 0 0 8px; color: var(--vela-accent-bright, #67b7ff); font-size: 10px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
.midorii-botform-words { padding: 15px 17px 6px; }
.midorii-botform-words p { margin: 0 0 10px; color: var(--vela-fg); font-size: 12.5px; line-height: 1.6; }
.midorii-botform-words b { color: var(--vela-fg-bright); font-weight: 600; }
.midorii-botform-ready { list-style: none; margin: 0; padding: 11px 17px; border-top: 1px solid var(--vela-border); background: var(--vela-bg); }
.midorii-botform-ready li { padding: 3px 0 3px 20px; position: relative; color: var(--vela-fg-muted); font-size: 12px; }
.midorii-botform-ready li::before { content: '✓'; position: absolute; left: 2px; color: var(--vela-up, #089981); }
.midorii-botform-ready li[data-ok='0'] { color: var(--vela-warning, #d9822b); font-weight: 600; }
.midorii-botform-ready li[data-ok='0']::before { content: '!'; color: var(--vela-warning, #d9822b); }
.midorii-botform-ready li[data-total] { margin-top: 6px; color: var(--vela-fg-bright); font-weight: 600; }
.midorii-botform-ready li[data-total][data-ok='1'] { color: var(--vela-up, #089981); }
.midorii-botform-actions { position: sticky; bottom: 0; z-index: 2; display: flex; flex-wrap: wrap; align-items: center; gap: 9px; margin: 18px -18px -32px; padding: 11px 18px; border-top: 1px solid var(--vela-border); background: var(--vela-bg); }
.midorii-botform-status { color: var(--vela-fg-muted); font-size: 12px; }
.midorii-botform-status[data-error='1'] { color: var(--vela-danger); }
.midorii-botform-warn {
    margin: 0 0 12px; padding: 8px 10px;
    border-left: 2px solid var(--vela-warning, #d9822b);
    background: var(--vela-surface-overlay);
    color: var(--vela-fg); font-size: 12.5px; line-height: 1.55;
}
@media (max-width: 960px) {
    .midorii-botform-setup { grid-template-columns: minmax(0, 1fr); }
    .midorii-botform-aside { position: static; margin-bottom: 18px; }
}
@media (max-width: 700px) {
    .midorii-botform-heading { flex-direction: column; gap: 7px; }
    .midorii-botform-opts { grid-template-columns: 1fr; }
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

/** The four steps of the setup, in the order somebody decides them. */
export type SetupSection = 'market' | 'account' | 'strategy' | 'safety';

export interface SetupProblem {
    /** The step that holds the thing to fix. */
    section: SetupSection;
    /** Why the bot cannot start, in the words the start itself would refuse with. */
    text: string;
}

/**
 * What stands between this configuration and a start, and which step to fix it in.
 *
 * The refusal text is the engine's own (`startRefusal`) rather than a second list of rules
 * kept in step with it; this only decides which step the text belongs to.
 */
export function setupProblem(config: BotConfig): SetupProblem | null {
    const text = startRefusal(config);
    if (text === null) return null;
    if (!config.symbol.trim() || (config.venue === 'capital' && !config.symbol.startsWith('capital:'))) {
        return { section: 'market', text };
    }
    if (!/^(?:[1-9]\d*|D|1D|W|1W|M|1M)$/.test(config.timeframe)) return { section: 'market', text };
    if (!Number.isFinite(config.balance) || config.balance <= 0) return { section: 'account', text };
    try {
        resolveGuards(config.guards);
    } catch {
        return { section: 'safety', text };
    }
    return { section: 'strategy', text };
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
    /** Called after every edit, so the screen around the form can say whether the bot is
     *  ready to start without waiting for the dirty flag to flip. */
    onDraftChange?: () => void;
}

export interface BotForm {
    readonly el: HTMLElement;
    readonly dirty: boolean;
    /** What keeps the edited configuration from starting, or null when nothing does. */
    readonly problem: SetupProblem | null;
    /** Scroll a step to the top of the form. */
    jumpTo(section: SetupSection): void;
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
    let navNode: HTMLElement | null = null;
    let asideNode: HTMLElement | null = null;
    let dirty = false;
    /** Whether the fine-tuning fold is open; kept here because every structural change repaints. */
    let fineTuneOpen = false;

    function timeframeLabel(): string {
        return TIMEFRAME_OPTIONS.find((option) => option.value === draft.timeframe)?.label ?? draft.timeframe;
    }

    function draftSummary(): string {
        return `${draft.symbol || 'Choose an asset'} · ${timeframeLabel()} · ${draft.venue === 'paper' ? 'Paper account' : 'Capital.com'}`;
    }

    /** The draft as a bot, which is what the engine would be asked to start. */
    function draftConfig(): BotConfig {
        return {
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
    }

    function currentProblem(): SetupProblem | null {
        return setupProblem(draftConfig());
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
        paintGuide();
        opts.onDraftChange?.();
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

    function note(text: string, className = 'midorii-botform-sub'): HTMLElement {
        const el = doc.createElement('p');
        el.className = className;
        el.textContent = text;
        return el;
    }

    /* ── the steps ───────────────────────────────────────────────────────── */

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

    function marketBody(): HTMLElement {
        const el = doc.createElement('div');
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
        el.appendChild(grid);

        if (draft.venue === 'paper' && draft.symbol.startsWith('projectx:')) {
            el.appendChild(note(
                'Futures trade in whole contracts. If your risk or max leverage cannot cover '
                + 'one contract, the bot refuses the entry and records why in Bot activity.',
            ));
        }
        return el;
    }

    /** One of the two places orders can go, as a card that says what choosing it means. */
    function venueCard(value: BotVenue, title: string, detail: string): HTMLButtonElement {
        const card = doc.createElement('button');
        card.type = 'button';
        card.className = 'midorii-botform-opt';
        card.setAttribute('aria-pressed', String(draft.venue === value));
        card.disabled = readOnly || saving;
        if (value === 'capital') card.dataset.live = '';
        const head = doc.createElement('strong');
        head.textContent = title;
        if (value === 'capital') {
            const pill = doc.createElement('span');
            pill.className = 'midorii-botform-pill';
            pill.textContent = 'Real money';
            head.appendChild(pill);
        }
        const small = doc.createElement('small');
        small.textContent = detail;
        card.append(head, small);
        card.onclick = () => {
            if (draft.venue === value) return;
            draft.venue = value;
            markChanged();
            paint();
        };
        return card;
    }

    function accountBody(): HTMLElement {
        const el = doc.createElement('div');
        const cards = doc.createElement('div');
        cards.className = 'midorii-botform-opts';
        const labels = new Map(VENUE_OPTIONS.map((v) => [v.value, v.label]));
        cards.append(
            venueCard(
                'paper',
                labels.get('paper') ?? 'Paper account',
                'This app’s own engine at real prices — nothing reaches a venue.',
            ),
            venueCard(
                'capital',
                capitalConfigured ? labels.get('capital') ?? 'Capital.com' : `${labels.get('capital') ?? 'Capital.com'} (no credentials)`,
                'Sends real orders to whichever account the stored credentials point at.',
            ),
        );
        el.appendChild(cards);

        if (draft.venue === 'paper') {
            const grid = fieldGrid(doc);
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
            el.appendChild(grid);
        } else {
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

    function strategyBody(): HTMLElement {
        const el = doc.createElement('div');
        const catalog = strategyCatalog().filter((spec) => !spec.researchOnly);
        const spec = STRATEGIES[draft.strategy];

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

        if (!spec) {
            el.appendChild(note(`This build has no strategy called “${draft.strategy}”.`, 'midorii-botform-warn'));
            return el;
        }
        el.appendChild(note(spec.description));

        const basicRisk = new Set(['riskMode', 'riskValue', 'rrr']);
        const riskParams = spec.params.filter((p) => RISK_PARAM_KEYS.includes(p.key));
        const own = spec.params.filter((p) => !RISK_PARAM_KEYS.includes(p.key));

        const basic = riskParams.filter((p) => basicRisk.has(p.key));
        if (basic.length > 0) {
            el.appendChild(sectionLabel('Risk per trade'));
            const riskGrid = fieldGrid(doc);
            for (const param of basic) riskGrid.appendChild(readOnlyGuard(paramField(doc, param, draft.params, markChanged)));
            el.appendChild(riskGrid);
        }

        const sizing = riskParams.filter((p) => !basicRisk.has(p.key));
        if (sizing.length + own.length > 0) {
            const more = doc.createElement('details');
            more.className = 'midorii-botform-more';
            more.open = fineTuneOpen;
            more.addEventListener('toggle', () => { fineTuneOpen = more.open; });
            const summary = doc.createElement('summary');
            summary.textContent = 'Fine-tune the strategy';
            const count = doc.createElement('small');
            count.textContent = `${sizing.length + own.length} settings · a copy of the Strategies tab’s`;
            summary.appendChild(count);
            more.appendChild(summary);

            if (sizing.length > 0) {
                more.appendChild(sectionLabel('Sizing and position management'));
                const sizingGrid = fieldGrid(doc);
                for (const param of sizing) sizingGrid.appendChild(readOnlyGuard(paramField(doc, param, draft.params, markChanged)));
                more.appendChild(sizingGrid);
            }
            if (own.length > 0) {
                more.appendChild(sectionLabel('What counts as a setup'));
                const ownGrid = fieldGrid(doc);
                for (const param of own) ownGrid.appendChild(readOnlyGuard(paramField(doc, param, draft.params, markChanged)));
                more.appendChild(ownGrid);
            }
            more.appendChild(note('These settings belong to this bot. Changes on the Strategies tab do not retune it.'));
            el.appendChild(more);
        }
        return el;
    }

    function safetyBody(): HTMLElement {
        const el = doc.createElement('div');
        const groups: ReadonlyArray<readonly [string, number, number | undefined]> = [
            ['When it may trade', 0, 4],
            ['How much it may do', 4, 10],
            ['What it refuses to trade through', 10, undefined],
        ];
        for (const [title, from, to] of groups) {
            el.appendChild(sectionLabel(title));
            const grid = fieldGrid(doc);
            for (const param of LIVE_GUARD_PARAMS.slice(from, to)) {
                grid.appendChild(readOnlyGuard(paramField(doc, param, draft.guards, markChanged)));
            }
            el.appendChild(grid);
        }
        return el;
    }

    /** Disable every control inside a row while the form is saving. A running bot never gets
     *  this far — its steps are read-only sheets — but the shared field factory builds its
     *  controls from a schema that knows nothing about a bot's state. */
    function readOnlyGuard(row: HTMLElement): HTMLElement {
        if (!readOnly && !saving) return row;
        for (const el of row.querySelectorAll('input, button, select, textarea')) {
            (el as HTMLInputElement).disabled = true;
        }
        row.style.opacity = '0.6';
        return row;
    }

    /**
     * What a step holds, as a sheet rather than as controls. A running bot's settings are what
     * its open positions were sized under, so the screen shows them without offering to change
     * them — a disabled field says "not now", a sheet says "this is what it is".
     */
    function sheetOf(section: SetupSection): HTMLElement {
        const rows = settingsGrid;
        if (section === 'market') {
            return rows([
                { label: 'Name', value: draft.name },
                { label: 'Asset', value: draft.symbol || '—' },
                { label: 'Bars', value: timeframeLabel() },
            ]);
        }
        if (section === 'account') {
            return rows([
                { label: 'Account', value: draft.venue === 'paper' ? 'Paper account' : 'Capital.com · real money' },
                ...(draft.venue === 'paper' ? [{ label: 'Starting cash', value: formatMoney(draft.balance) }] : []),
            ]);
        }
        if (section === 'strategy') {
            return rows([
                { label: 'Strategy', value: STRATEGIES[draft.strategy]?.name ?? draft.strategy },
                ...describeParams(draft.strategy, draft.params).map(({ label, value }) => ({ label, value })),
            ]);
        }
        return rows(ruleRows(draft.guards).map(({ label, value }) => ({ label, value })));
    }

    interface Step {
        id: SetupSection;
        short: string;
        title: string;
        intro: string;
        body: () => HTMLElement;
    }

    const steps: readonly Step[] = [
        {
            id: 'market',
            short: 'Market',
            title: 'What it trades',
            intro: 'A bot is bound to one asset: it watches that asset whatever the Chart tab happens '
                + 'to be showing, which is the whole point of it running unattended.',
            body: marketBody,
        },
        {
            id: 'account',
            short: 'Account',
            title: 'Where its orders go',
            intro: 'Every bot has an account of its own — never shared with the Chart tab.',
            body: accountBody,
        },
        {
            id: 'strategy',
            short: 'Strategy',
            title: 'Strategy and risk',
            intro: 'Which strategy it runs, and what one losing trade may cost.',
            body: strategyBody,
        },
        {
            id: 'safety',
            short: 'Safety',
            title: 'Safety rules',
            intro: 'What the bot may do while nobody is watching. None of these can open a trade; every '
                + 'one of them can refuse one. A strategy that is already holding a position is never '
                + 'blocked from managing it — a guard that could strand a live position would cost '
                + 'more than it saves.',
            body: safetyBody,
        },
    ];

    /* ── the guide: the step bar and the summary ─────────────────────────── */

    function para(...parts: Array<string | { b: string }>): HTMLElement {
        const p = doc.createElement('p');
        for (const part of parts) {
            if (typeof part === 'string') p.append(part);
            else {
                const b = doc.createElement('b');
                b.textContent = part.b;
                p.append(b);
            }
        }
        return p;
    }

    /** The configuration in sentences, so somebody who has filled in forty fields can read back
     *  what they asked for. Only states what the draft says. */
    function plainWords(): HTMLElement[] {
        const strategy = STRATEGIES[draft.strategy]?.name ?? draft.strategy;
        const account = draft.venue === 'paper'
            ? [' on a ', { b: 'paper account' }, ` starting at ${formatMoney(draft.balance)}`]
            : [' on your ', { b: 'real Capital.com account' }];
        const out: HTMLElement[] = [
            para(
                { b: draft.name }, ' trades ', { b: draft.symbol || '— no asset yet —' },
                ` on ${timeframeLabel().toLowerCase().replace(/s$/, '').replace(' ', '-')} bars with `, { b: strategy }, ...account, '.',
            ),
        ];

        const riskValue = draft.params.riskValue;
        if (typeof riskValue === 'number') {
            const cash = draft.params.riskMode === 'fixed';
            const rrr = draft.params.rrr;
            out.push(para(
                'Each trade risks ', { b: cash ? `${riskValue} in cash` : `${riskValue}% of equity` },
                ...(typeof rrr === 'number' ? [' for a target of ', { b: `${rrr}× the risk` }] : []), '.',
            ));
        }

        const g = guardsOf(draft.guards);
        const wholeDay = g.sessionStart === g.sessionEnd;
        const stops = [
            g.maxTradesPerDay > 0 && `after ${g.maxTradesPerDay} trades`,
            g.dailyLossLimit > 0 && `at −${g.dailyLossLimit}% on the day`,
            g.dailyProfitTarget > 0 && `at +${g.dailyProfitTarget}% on the day`,
        ].filter((s): s is string => Boolean(s));
        const window = wholeDay
            ? 'around the clock'
            : `between ${formatClock(g.sessionStart)} and ${formatClock(g.sessionEnd)} UTC`;
        out.push(para(
            `It may open trades ${daysText(g.tradingDays)}, ${window}`,
            g.flattenAtEnd && !wholeDay ? ', and closes everything when the window ends' : '',
            '. ',
            stops.length > 0 ? `It stops opening ${stops.join(' or ')}.` : 'It has no daily limits.',
        ));
        return out;
    }

    function readyItems(problem: SetupProblem | null): Array<{ text: string; ok: boolean }> {
        const g = guardsOf(draft.guards);
        const mismatch = draft.venue === 'capital' && draft.symbol.trim() !== '' && !draft.symbol.startsWith('capital:');
        return [
            { text: 'Asset chosen', ok: draft.symbol.trim() !== '' },
            { text: 'Asset matches the account', ok: !mismatch },
            { text: 'Strategy settings are valid', ok: problem?.section !== 'strategy' },
            { text: 'Safety rules are valid', ok: problem?.section !== 'safety' },
            /* Not reasons to refuse a start, so they never turn the verdict below — but a bot
             * with no trading day opens nothing, and a feed that may go silent unnoticed is the
             * expensive mistake; both are worth saying before the bot runs. */
            { text: g.tradingDays.length > 0 ? 'At least one trading day' : 'No trading day is on — it will never open a trade', ok: g.tradingDays.length > 0 },
            { text: g.staleFeedSeconds > 0 ? 'Stale-feed protection on' : 'Stale-feed protection is off', ok: g.staleFeedSeconds > 0 },
        ];
    }

    function paintGuide(): void {
        const problem = currentProblem();
        for (const step of root.querySelectorAll<HTMLElement>('[data-step]')) {
            step.dataset.ok = problem?.section === step.dataset.step ? '0' : '1';
        }
        if (navNode) {
            navNode.replaceChildren();
            steps.forEach((step, i) => {
                const b = doc.createElement('button');
                b.type = 'button';
                b.dataset.ok = problem?.section === step.id ? '0' : '1';
                const n = doc.createElement('span');
                n.className = 'midorii-botform-n';
                n.textContent = String(i + 1);
                b.append(n, step.short);
                b.onclick = () => jumpTo(step.id);
                navNode!.appendChild(b);
            });
            const gap = doc.createElement('span');
            gap.className = 'midorii-botform-nav-gap';
            const hint = doc.createElement('span');
            hint.className = 'midorii-botform-nav-hint';
            hint.dataset.ok = problem ? '0' : '1';
            hint.textContent = problem ? problem.text : readOnly ? 'Running with these settings' : 'Ready to start';
            navNode.append(gap, hint);
        }
        if (asideNode) {
            asideNode.replaceChildren();
            const words = doc.createElement('div');
            words.className = 'midorii-botform-words';
            const h = doc.createElement('h3');
            h.textContent = 'In plain words';
            words.append(h, ...plainWords());
            const list = doc.createElement('ul');
            list.className = 'midorii-botform-ready';
            for (const item of readyItems(problem)) {
                const li = doc.createElement('li');
                li.dataset.ok = item.ok ? '1' : '0';
                li.textContent = item.text;
                list.appendChild(li);
            }
            const total = doc.createElement('li');
            total.dataset.total = '';
            total.dataset.ok = problem ? '0' : '1';
            total.textContent = problem ? `Not ready: ${problem.text}` : readOnly ? 'Running with these settings' : 'Ready to start';
            list.appendChild(total);
            asideNode.append(words, list);
        }
    }

    function jumpTo(section: SetupSection): void {
        const step = root.querySelector<HTMLElement>(`[data-step='${section}']`);
        step?.scrollIntoView({ block: 'start' });
    }

    /* ── saving ──────────────────────────────────────────────────────────── */

    async function save(): Promise<boolean> {
        if (saving || readOnly) return false;
        const revision = formRevision;
        saving = true;
        status = null;
        paint();
        try {
            const next = draftConfig();
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

        const setup = doc.createElement('div');
        setup.className = 'midorii-botform-setup';

        const nav = doc.createElement('nav');
        nav.className = 'midorii-botform-nav';
        nav.setAttribute('aria-label', 'Setup steps');
        navNode = nav;
        setup.appendChild(nav);

        if (readOnly) {
            const lock = doc.createElement('p');
            lock.className = 'midorii-botform-lock';
            lock.textContent = 'Read-only while the bot runs. Its open positions were sized under these '
                + 'settings, so they cannot be changed until it is stopped.';
            setup.appendChild(lock);
        }

        const list = doc.createElement('div');
        list.className = 'midorii-botform-steps';
        steps.forEach((step, i) => {
            const el = doc.createElement('section');
            el.className = 'midorii-botform-step';
            el.dataset.step = step.id;
            const n = doc.createElement('span');
            n.className = 'midorii-botform-n';
            n.textContent = String(i + 1);
            const head = doc.createElement('div');
            head.className = 'midorii-botform-step-head';
            const h = doc.createElement('h3');
            h.textContent = step.title;
            head.append(h, note(step.intro, ''));
            const body = doc.createElement('div');
            body.className = 'midorii-botform-step-body';
            body.appendChild(readOnly ? sheetOf(step.id) : step.body());
            el.append(n, head, body);
            list.appendChild(el);
        });
        setup.appendChild(list);

        const aside = doc.createElement('aside');
        aside.className = 'midorii-botform-aside';
        aside.setAttribute('aria-label', 'Summary');
        asideNode = aside;
        setup.appendChild(aside);
        root.appendChild(setup);
        paintGuide();

        /* A running bot has nothing to save, discard or delete: the actions would be a row of
         * disabled buttons, and the lock note above already says why. */
        if (readOnly) {
            statusNode = null;
            saveNode = null;
            return;
        }

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
        get problem() { return currentProblem(); },
        jumpTo,
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
