import { injectStyles } from '../../../src/ui';
import { formatMoney, formatPrice, formatSignedMoney, formatSize } from '../format';
import type { HistoryRow } from '../replay/tradeBook';
import type { BotRunner } from './BotRunner';
import type { BotLogEntry } from './botLog';
import type { BotConfig } from './botTypes';

/**
 * What the bot has been doing, under its chart.
 *
 * The one thing a screen for an unattended strategy has to get right. A bot that has taken
 * no trades all week is either working perfectly on a market that offered nothing, or has
 * been turning every setup away since Tuesday for a reason nobody can now reconstruct.
 * Nothing else on the screen tells those apart — the chart looks the same, the account
 * looks the same, and "no positions" is what both of them look like.
 *
 * So refusals are on the tape beside the orders, and they read as sentences rather than as
 * codes. A line that has repeated says how many times instead of appearing that many times
 * (see BotLog), which is what keeps a night of "outside the trading window" from burying
 * the trade taken that afternoon.
 */

const STYLE_ID = 'midorii-bot-tape';
const CSS = `
.midorii-tape-heading {
    flex: none; display: flex; align-items: center; gap: 14px; padding: 0 14px; overflow: hidden;
    min-height: 39px;
    border-bottom: 1px solid var(--vela-border);
    color: var(--vela-fg-muted); font: 11px/1.4 var(--vela-font, sans-serif);
}
.midorii-tape-tabs { display: flex; align-self: stretch; gap: 14px; }
.midorii-tape-tab {
    border: 0; border-bottom: 2px solid transparent; padding: 0 2px; white-space: nowrap;
    background: transparent; color: var(--vela-fg-muted);
    font: 600 11.5px var(--vela-font, sans-serif); cursor: pointer;
}
.midorii-tape-tab:hover { color: var(--vela-fg-bright); }
.midorii-tape-tab[aria-selected='true'] {
    border-bottom-color: var(--vela-accent-bright, #2962ff);
    color: var(--vela-fg-bright);
}
.midorii-tape-tab:focus-visible { outline: 2px solid var(--vela-accent-bright, #2962ff); outline-offset: -3px; }
.midorii-tape-hint { margin-left: auto; text-align: right; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.midorii-tape { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 4px 0;
    font: 12px/1.5 var(--vela-font, sans-serif); container-type: inline-size; }
.midorii-tape-trade {
    display: grid; grid-template-columns: 145px 105px minmax(150px, 1fr) 115px;
    gap: 14px; align-items: center; padding: 7px 16px;
    border-bottom: 1px solid var(--vela-border);
    font-variant-numeric: tabular-nums;
}
.midorii-tape-trade:hover { background: var(--vela-hover); }
.midorii-tape-trade-time { color: var(--vela-fg-muted); font-size: 11px; }
.midorii-tape-trade-side { color: var(--vela-fg-bright); font-weight: 650; }
.midorii-tape-trade-side[data-side='long'] { color: var(--vela-up, #089981); }
.midorii-tape-trade-side[data-side='short'] { color: var(--vela-down, #f23645); }
.midorii-tape-trade-prices { min-width: 0; color: var(--vela-fg); overflow-wrap: anywhere; }
.midorii-tape-trade-prices small,
.midorii-tape-trade-result small { display: block; color: var(--vela-fg-muted); font-size: 10.5px; }
.midorii-tape-trade-result { text-align: right; color: var(--vela-fg-bright); font-weight: 650; }
.midorii-tape-trade-result[data-sign='up'] { color: var(--vela-up, #089981); }
.midorii-tape-trade-result[data-sign='down'] { color: var(--vela-down, #f23645); }
.midorii-tape-row {
    display: grid; grid-template-columns: 62px 12px 1fr auto;
    gap: 8px; align-items: baseline;
    padding: 2px 14px;
}
.midorii-tape-row:hover { background: var(--vela-hover); }
.midorii-tape-time { color: var(--vela-fg-faint); font-variant-numeric: tabular-nums; font-size: 11px; }
.midorii-tape-mark { font-weight: 700; color: var(--vela-fg-faint); }
.midorii-tape-row[data-kind='order'] .midorii-tape-mark { color: var(--vela-accent-bright, #2962ff); }
.midorii-tape-row[data-kind='refused'] .midorii-tape-mark { color: var(--vela-warning, #d9822b); }
.midorii-tape-row[data-kind='error'] .midorii-tape-mark { color: var(--vela-danger, #f23645); }
.midorii-tape-text { color: var(--vela-fg); min-width: 0; overflow-wrap: anywhere; }
.midorii-tape-row[data-kind='refused'] .midorii-tape-text { color: var(--vela-fg-muted); }
.midorii-tape-row[data-kind='error'] .midorii-tape-text { color: var(--vela-danger); }
.midorii-tape-count {
    padding: 0 6px; border-radius: 999px;
    background: var(--vela-surface-overlay); color: var(--vela-fg-muted);
    font-size: 10.5px; font-variant-numeric: tabular-nums;
}
.midorii-tape-empty { padding: 18px 16px; color: var(--vela-fg-muted); }
.midorii-tape-empty strong { display: block; color: var(--vela-fg-bright); font-size: 13px; }
.midorii-tape-empty p { margin: 3px 0 0; max-width: 700px; }
@media (max-width: 700px) {
    .midorii-tape-hint { display: none; }
}
/* The tape is a panel a person can make as narrow as they like, so its rows answer to the
   panel's width and not the window's. */
@container (max-width: 560px) {
    .midorii-tape-trade { grid-template-columns: 1fr auto; gap: 2px 10px; }
    .midorii-tape-trade-prices { grid-column: 1; }
    .midorii-tape-trade-result { grid-column: 2; grid-row: 1 / span 2; }
}
`;

/** The character in front of each line — what KIND of thing happened, at a glance. */
const MARKS: Record<BotLogEntry['kind'], string> = {
    info: '·',
    order: '›',
    refused: '⊘',
    error: '!',
};

export interface BotTape {
    /** Draw the saved paper trades or the current session's activity. */
    render(runner: BotRunner | null, bot: BotConfig): void;
    /** Open the selected bot's primary record from the account rail. */
    showPrimary(): void;
}

export function botTape(host: HTMLElement): BotTape {
    const doc = host.ownerDocument;
    injectStyles(STYLE_ID, CSS, doc);

    const heading = doc.createElement('div');
    heading.className = 'midorii-tape-heading';
    const tabs = doc.createElement('div');
    tabs.className = 'midorii-tape-tabs';
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', 'Bot records');
    const tradesTab = doc.createElement('button');
    tradesTab.className = 'midorii-tape-tab';
    tradesTab.setAttribute('role', 'tab');
    const activityTab = doc.createElement('button');
    activityTab.className = 'midorii-tape-tab';
    activityTab.setAttribute('role', 'tab');
    tabs.append(tradesTab, activityTab);
    const hint = doc.createElement('span');
    hint.className = 'midorii-tape-hint';
    heading.append(tabs, hint);
    const root = doc.createElement('div');
    root.className = 'midorii-tape';
    root.setAttribute('role', 'tabpanel');
    host.append(heading, root);

    let selected: 'trades' | 'activity' = 'trades';
    let selectedBot = '';
    let currentRunner: BotRunner | null = null;
    let currentBot: BotConfig | null = null;
    let drawn = '';

    function select(next: 'trades' | 'activity'): void {
        selected = next;
        drawn = '';
        if (currentBot) render(currentRunner, currentBot);
        (next === 'trades' ? tradesTab : activityTab).focus();
    }
    tradesTab.onclick = () => select('trades');
    activityTab.onclick = () => select('activity');

    function render(runner: BotRunner | null, bot: BotConfig): void {
        if (selectedBot !== bot.id) {
            selectedBot = bot.id;
            selected = bot.venue === 'paper' ? 'trades' : 'activity';
            drawn = '';
        }
        currentRunner = runner;
        currentBot = bot;
        const paper = runner?.paperController;
        const history = paper?.history() ?? [];
        const entries = runner?.log.list() ?? [];
        const head = entries[0];
        tradesTab.hidden = bot.venue !== 'paper';
        if (bot.venue !== 'paper') selected = 'activity';
        tradesTab.textContent = `Trade history (${history.length})`;
        activityTab.textContent = `Activity (${entries.length})`;
        tradesTab.setAttribute('aria-selected', String(selected === 'trades'));
        activityTab.setAttribute('aria-selected', String(selected === 'activity'));
        root.setAttribute('aria-label', selected === 'trades' ? 'Bot paper trade history' : 'Bot activity');
        hint.textContent = selected === 'trades'
            ? 'Saved in this bot’s paper account · newest first'
            : 'Orders, fills and refusals · current app session';

        const key = selected === 'trades'
            ? `${bot.id}:trades:${history.length}`
            : `${bot.id}:activity:${entries.length}:${head?.at ?? ''}:${head?.count ?? ''}`;
        if (key === drawn) return;
        drawn = key;
        root.scrollTop = 0;

        if (selected === 'trades') {
            if (history.length === 0) {
                root.replaceChildren(empty(doc, 'No bot trades yet',
                    'A drawn chart study is not an execution. Once this bot opens and closes a paper position, its trade appears here and remains after a restart.'));
                return;
            }
            const rows = doc.createDocumentFragment();
            for (const trade of history.slice(0, 100)) rows.appendChild(tradeRow(doc, trade));
            if (history.length > 100) rows.appendChild(empty(doc, 'Showing the latest 100 trades', `${history.length} trades remain in this bot’s account.`));
            root.replaceChildren(rows);
            return;
        }

        if (entries.length === 0) {
            root.replaceChildren(empty(doc, 'No activity in this app session',
                'Start the bot to see its orders, fills and refusals here. Closed paper trades remain in Trade history.'));
            return;
        }
        const rows = doc.createDocumentFragment();
        for (const entry of entries) rows.appendChild(row(doc, entry));
        root.replaceChildren(rows);
    }

    return {
        render,
        showPrimary(): void { select(currentBot?.venue === 'paper' ? 'trades' : 'activity'); },
    };
}

function empty(doc: Document, title: string, detail: string): HTMLElement {
    const el = doc.createElement('div');
    el.className = 'midorii-tape-empty';
    const strong = doc.createElement('strong');
    strong.textContent = title;
    const p = doc.createElement('p');
    p.textContent = detail;
    el.append(strong, p);
    return el;
}

/** The same settled trade fields the account history provides, formatted for this compact row. */
export function paperTradeCells(trade: HistoryRow): {
    side: string; size: string; prices: string; net: string; fees: string; exit: string;
} {
    return {
        side: trade.side === 'long' ? 'LONG' : 'SHORT',
        size: formatSize(trade.size),
        prices: `${formatPrice(trade.entryPrice)} → ${formatPrice(trade.exitPrice)}`,
        net: formatSignedMoney(trade.netPnl),
        fees: formatMoney(trade.fees),
        exit: trade.exitTag ?? '',
    };
}

function tradeRow(doc: Document, trade: HistoryRow): HTMLElement {
    const cells = paperTradeCells(trade);
    const el = doc.createElement('div');
    el.className = 'midorii-tape-trade';
    const time = doc.createElement('time');
    time.className = 'midorii-tape-trade-time';
    time.dateTime = new Date(trade.closedAt).toISOString();
    time.textContent = new Date(trade.closedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    const side = doc.createElement('span');
    side.className = 'midorii-tape-trade-side';
    side.dataset.side = trade.side;
    side.textContent = `${cells.side} · ${cells.size}`;
    const prices = doc.createElement('span');
    prices.className = 'midorii-tape-trade-prices';
    prices.textContent = cells.prices;
    if (cells.exit) {
        const detail = doc.createElement('small');
        detail.textContent = `Exit: ${cells.exit}`;
        prices.appendChild(detail);
    }
    const result = doc.createElement('span');
    result.className = 'midorii-tape-trade-result';
    result.dataset.sign = trade.netPnl > 0 ? 'up' : trade.netPnl < 0 ? 'down' : 'flat';
    result.textContent = cells.net;
    const fees = doc.createElement('small');
    fees.textContent = `Fees ${cells.fees}`;
    result.appendChild(fees);
    el.append(time, side, prices, result);
    return el;
}

function row(doc: Document, entry: BotLogEntry): HTMLElement {
    const el = doc.createElement('div');
    el.className = 'midorii-tape-row';
    el.dataset.kind = entry.kind;

    const time = doc.createElement('span');
    time.className = 'midorii-tape-time';
    time.textContent = new Date(entry.at).toLocaleTimeString(undefined, { hour12: false });

    const mark = doc.createElement('span');
    mark.className = 'midorii-tape-mark';
    mark.textContent = MARKS[entry.kind];

    const text = doc.createElement('span');
    text.className = 'midorii-tape-text';
    text.textContent = entry.text;

    el.append(time, mark, text);

    if (entry.count > 1) {
        const count = doc.createElement('span');
        count.className = 'midorii-tape-count';
        count.textContent = `×${entry.count}`;
        count.title = 'This line has repeated. The time is the most recent one.';
        el.appendChild(count);
    }
    return el;
}
