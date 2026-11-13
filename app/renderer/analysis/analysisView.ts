import { injectStyles, overlayScrollbarCss } from '../../../src/ui';
import type { VelaTheme } from '../../../src';
import { formatDuration } from '../../../src/core/drawings';
import type {
    MidoriEquityPoint, MidoriRunShot, MidoriRunStats, MidoriRunSummary, MidoriSweep, MidoriSweepSummary, MidoriTrade,
} from '../midori';
import { formatDay, formatMoney, formatPercent, formatPrice, formatR, formatSignedMoney, formatSize, formatWhen } from '../format';
import {
    button, ensureFigureStyles, equityCurveSvg, runsTable, sectionLabel, settingsGrid, statGrid, tile,
    tileGrid, tradesTable,
} from '../runs/runViews';
import { ensureSweepStyles, overfitNote, sweepTable, sweepsTable } from '../backtest/sweepViews';
import { STRATEGIES, describeParams } from '../strategies';
import { refreshResearchStrategies } from '../strategies/researchLibrary';
import { loadPaperAccount } from '../trading/paperStore';
import { loadJournal, summarizeJournal } from '../trading/liveJournal';
import type { LiveTradeRecord } from '../trading/CapitalController';
import { PaperAccount, type PaperAccountExtra } from '../trading/PaperAccount';
import { loadPaperSettings } from '../trading/paperSettings';
import { tradeBreakdown } from './analysisFigures';
import { ANALYSIS_BOARD, type AnalysisPanelId } from './analysisBoard';
import { screenHead } from '../shell/screenHead';
import { attachLayoutMenu, createLayoutStore, mountPanelBoard, type PanelBoard } from '../shell/panelBoard';
import { mountRunJournal, type JournalPatch } from './runJournal';
import { mountRunReview, type RunReview } from './runReview';

/**
 * The Analysis tab: every account this app has traded, and what each one did.
 *
 * Two shelves rather than one, because they answer different questions. ACCOUNTS is the paper
 * account — the one still running, and the ones filed away when it was started over — read to
 * ask "how am I doing". SESSIONS is everything that was played or computed to an end, a
 * backtest and a hand-played replay side by side, read to ask "did this way of trading work".
 * Both land on the same shelf on disk and report the same figures; splitting them here is a
 * statement about how they are read, not about how they are stored.
 *
 * Read-only throughout, and read-only about the numbers in particular: a run's stats were
 * computed when it finished and are shown as they were stored. What this screen adds is the
 * breakdown — sides, streaks, holding time — which the summary does not answer at all.
 */

const STYLE_ID = 'midorii-analysis';
const CSS = `
.midorii-analysis {
    position: absolute; inset: 0;
    display: flex; flex-direction: column;
    background: var(--vela-bg);
    color: var(--vela-fg);
    font: 13px/1.5 var(--vela-font, sans-serif);
}
.midorii-analysis-body { flex: 1 1 auto; min-height: 0; overflow: auto; }
${overlayScrollbarCss('.midorii-analysis-body')}
.midorii-analysis-inner { max-width: 1100px; margin: 0 auto; padding: 16px 18px 32px; }

/* One account or session in full: a toolbar, then movable panels that fill the screen. */
.midorii-analysis-body[data-board='1'] { overflow: hidden; display: flex; flex-direction: column; }
.midorii-analysis-tags { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 12px; }
.midorii-analysis-tags .vela-dialog-btn[aria-pressed='true'] { background: var(--vela-active); color: var(--vela-fg-bright); }
.midorii-analysis-stage { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
.midorii-analysis-stage[hidden], .midorii-analysis-inner[hidden] { display: none; }
.midorii-analysis-detail-bar {
    flex: none; display: flex; align-items: center; gap: 12px; padding: 10px 18px;
    border-bottom: 1px solid var(--vela-border);
}
.midorii-analysis-detail-title { flex: 1 1 auto; min-width: 0; }
.midorii-analysis-detail-title .midorii-analysis-head { margin-bottom: 0; }
.midorii-analysis-detail-title .midorii-analysis-sub { margin: 2px 0 0; }
.midorii-analysis-pad { padding: 2px 14px 14px; display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; }
.midorii-analysis-pad .midorii-figures-grid { grid-template-columns: repeat(auto-fit, minmax(112px, 1fr)); }
.midorii-analysis-pad .midorii-figures-grid:last-child { margin-bottom: 0; }
.midorii-analysis-fill > .midorii-figures-curve { flex: 1 1 auto; height: auto !important; min-height: 72px; margin-bottom: 0; }

.midorii-analysis-card {
    padding: 12px 14px; margin-bottom: 20px;
    background: var(--vela-surface);
    border: 1px solid var(--vela-border-faint);
    border-radius: var(--vela-radius-sm);
}
.midorii-analysis-card[data-pick] { cursor: pointer; }
.midorii-analysis-card[data-pick]:hover { border-color: var(--vela-border-strong); }
.midorii-analysis-card .midorii-figures-grid:last-child,
.midorii-analysis-card .midorii-figures-curve:last-child { margin-bottom: 0; }

.midorii-analysis-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 2px; }
.midorii-analysis-head h2 { margin: 0; font-size: 15px; color: var(--vela-fg-bright); }
.midorii-analysis-sub { margin: 0 0 12px; color: var(--vela-fg-muted); font-size: 12px; }

.midorii-analysis-badge {
    padding: 1px 7px; border-radius: 999px;
    font-size: 10px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;
    background: var(--vela-surface-overlay); color: var(--vela-fg-muted);
}
.midorii-analysis-badge[data-live='1'] { background: var(--vela-up); color: var(--vela-fg-on-fill); }

.midorii-analysis-empty {
    padding: 20px 4px 24px; color: var(--vela-fg-muted); line-height: 1.6; font-size: 12.5px;
}
.midorii-analysis-error { color: var(--vela-danger); }
.midorii-analysis-note { margin-bottom: 14px; }
.midorii-analysis-section { margin-top: 22px; }
`;

/** Which shelf is on screen. */
type AnalysisPane = 'accounts' | 'sessions' | 'sweeps';

/** An account in the shape this screen reads, whoever traded it and wherever it came from. */
interface Subject {
    /** `SYMBOL · timeframe`, or just the symbol for a running account that has no run label. */
    title: string;
    /** What traded it. */
    label: string;
    /** The line under the title: range, bars, starting balance, when it was stored. */
    sub: string;
    stats: MidoriRunStats;
    equityCurve: readonly MidoriEquityPoint[];
    initialBalance: number;
    trades: readonly MidoriTrade[];
    /** Set for a stored run, so it can be deleted and annotated. Absent for the live account. */
    runId?: string;
    note?: string;
    /** What a stored run is filed under, and the images in its journal. */
    tags?: string[];
    shots?: MidoriRunShot[];
    /** The market a stored run was traded on — what its trades are drawn against. */
    market?: { symbol: string; timeframe: string };
    /** Set on the paper account that is still open. */
    running?: boolean;
    /**
     * The settings the run was made with, and the strategy that names them.
     *
     * The reason a backtest is worth storing at all: a return of 14% is not actionable
     * without what produced it. A hand-traded session has none — the risk on each trade was
     * decided at the moment it was taken — and shows the section not at all rather than an
     * empty one.
     */
    params?: Record<string, unknown>;
    strategyId?: string;
}

export interface AnalysisViewOptions {
    /** The chart palette, for the trade chart a stored run draws its trades on. */
    theme: () => VelaTheme;
    /** The paper account the chart is trading right now, or null. Read fresh on every
     *  refresh: switching Trade off between two visits changes the answer. */
    liveAccount: () => PaperAccount | null;
}

export interface AnalysisViewHandle {
    /** Re-read the shelves and repaint. Called whenever the tab is opened. */
    refresh(): Promise<void>;
    /** Repaint the trade chart, if one is open, in a new palette. */
    setTheme(theme: VelaTheme): void;
}

/** The breakdown the run's own stats block does not answer. */
function breakdownGrid(subject: Subject): HTMLElement {
    const b = tradeBreakdown(subject.trades);
    const side = (s: { count: number; winRate: number | null }): string => (
        s.count === 0 ? '—' : `${s.count} · ${formatPercent(s.winRate, 0)}`
    );
    return tileGrid([
        tile('Long', side(b.long), b.long.netPnl),
        tile('Short', side(b.short), b.short.netPnl),
        tile('Best trade', b.best == null ? '—' : formatSignedMoney(b.best), b.best ?? 0),
        tile('Worst trade', b.worst == null ? '—' : formatSignedMoney(b.worst), b.worst ?? 0),
        tile('Avg win', subject.stats.avgWin == null ? '—' : formatMoney(subject.stats.avgWin)),
        tile('Avg loss', subject.stats.avgLoss == null ? '—' : formatMoney(subject.stats.avgLoss)),
        tile('Avg hold', b.avgHoldMs == null ? '—' : formatDuration(b.avgHoldMs)),
        tile('Streaks', `${b.maxWinStreak}W / ${b.maxLossStreak}L`),
        tile('Avg R', formatR(b.avgR), b.avgR ?? 0),
        tile('Trades in R', b.rTrades === 0 ? '—' : `${b.rTrades} / ${subject.stats.tradeCount}`),
        tile('Fees paid', formatMoney(subject.stats.feesPaid)),
        tile('Bars', subject.stats.barCount.toLocaleString()),
    ]);
}

/**
 * Mount the Analysis tab into `host`.
 *
 * Nothing is fetched here: the shelves are read on {@link AnalysisViewHandle.refresh}, which
 * the tab switch calls. A run that finished while this tab was shut is exactly the one
 * somebody opens it to look at.
 */
export function mountAnalysisView(host: HTMLElement, opts: AnalysisViewOptions): AnalysisViewHandle {
    const doc = host.ownerDocument;
    injectStyles(STYLE_ID, CSS, doc);
    ensureFigureStyles(doc);
    ensureSweepStyles(doc);

    const root = doc.createElement('div');
    root.className = 'midorii-analysis midorii-figures';

    const head = screenHead(doc, {
        title: 'Analysis',
        sub: 'Every account this app has traded, and what each one did.',
        tabs: [{ id: 'accounts', label: 'Accounts' }, { id: 'sessions', label: 'Sessions' }, { id: 'sweeps', label: 'Sweeps' }],
        onTab: (id) => {
            pane = id as AnalysisPane;
            open = null;
            openSweep = null;
            paint();
        },
    });
    const reload = button('Refresh');
    reload.onclick = () => void refresh();
    head.actions.appendChild(reload);

    const body = doc.createElement('div');
    body.className = 'midorii-analysis-body';
    const inner = doc.createElement('div');
    inner.className = 'midorii-analysis-inner';
    const stage = doc.createElement('div');
    stage.className = 'midorii-analysis-stage';
    stage.hidden = true;
    body.append(inner, stage);

    root.append(head.el, body);
    host.appendChild(root);

    /* How the panels of an open account sit is remembered per machine, like the bot screen's.
     * Storage can be unavailable (a locked-down profile); the store copes with that. */
    let storage: Storage | null = null;
    try { storage = doc.defaultView?.localStorage ?? null; } catch { storage = null; }
    const layoutStore = createLayoutStore(ANALYSIS_BOARD, storage);
    let board: PanelBoard | null = null;
    /** What the open run's panels hold that outlives their elements: a chart, object URLs, a paste listener. */
    let panelParts: Array<{ dispose(): void }> = [];
    let review: RunReview | null = null;
    /** The tag the sessions shelf is narrowed to, or null for all of it. */
    let tagFilter: string | null = null;
    const disposePanelParts = (): void => {
        for (const part of panelParts) part.dispose();
        panelParts = [];
        review = null;
    };

    let pane: AnalysisPane = 'accounts';
    /** The account being looked at in full, or null while a shelf is on screen. */
    let open: Subject | null = null;
    /** The sweep being looked at in full. Never set at the same time as `open`: they are
     *  two different things to be looking at, and the back button has to mean one of them. */
    let openSweep: MidoriSweep | null = null;
    let accounts: MidoriRunSummary[] = [];
    let sessions: MidoriRunSummary[] = [];
    let sweeps: MidoriSweepSummary[] = [];
    let live: Subject | null = null;
    /** Midorii's own record of what has been traded on a real account — see liveJournal.ts. */
    let journal: LiveTradeRecord[] = [];

    /* ── reading ─────────────────────────────────────────────────────────── */

    /**
     * The paper account as it stands.
     *
     * The running controller when the chart is wired to one — that account is ahead of the
     * disk record by up to a second, and showing the older of two answers about the same
     * account is worse than the round trip. Otherwise the stored one, restored just far
     * enough to sum itself up: an account nobody is trading is still an account.
     */
    async function readLiveAccount(): Promise<Subject | null> {
        const running = opts.liveAccount();
        if (running) {
            return accountSubject(running.title, running.result(), running.stats(), true);
        }

        const stored = await loadPaperAccount();
        if (!stored) return null;
        /* Picked back up just far enough to sum itself up. The settings are only what a market
         * it has never been on would start from, which a read never asks for. */
        const account = new PaperAccount({
            settings: loadPaperSettings(),
            restore: { symbol: stored.symbol, session: stored.session, extra: (stored.extra ?? null) as PaperAccountExtra | null },
        });
        const result = account.result();
        return accountSubject(account.title, result, result.stats, false);
    }

    /** One paper account, live or picked back up, in the shape this screen reads. */
    function accountSubject(
        symbol: string,
        result: { trades: unknown[]; equityCurve: MidoriEquityPoint[]; initialBalance: number; from: number; to: number; barCount: number },
        stats: MidoriRunStats,
        running: boolean,
    ): Subject {
        return {
            title: symbol,
            label: 'Paper trading',
            sub: `opened ${formatDay(result.from)} · ${result.barCount.toLocaleString()} bars played · `
                + `started with ${formatMoney(result.initialBalance)} · last marked ${formatWhen(result.to)}`,
            stats,
            equityCurve: result.equityCurve,
            initialBalance: result.initialBalance,
            trades: result.trades as MidoriTrade[],
            running,
        };
    }

    async function refresh(): Promise<void> {
        try {
            await refreshResearchStrategies();
            const [runs, storedSweeps, account, trades] = await Promise.all([
                window.midori.runs.list(),
                window.midori.sweep.list(),
                readLiveAccount(),
                loadJournal(),
            ]);
            /* `strategy` is the fixed vocabulary the store files a run under (see
             * HAND_TRADED in app/electron/ipc.js), so the split is exact rather than a
             * guess at a display name. */
            accounts = runs.filter((r) => r.strategy === 'paper');
            sessions = runs.filter((r) => r.strategy !== 'paper');
            sweeps = storedSweeps;
            live = account;
            journal = trades;
            open = null;
            openSweep = null;
            paint();
        } catch (err: unknown) {
            console.error('[midorii] the analysis shelves could not be read', err);
            open = null;
            openSweep = null;
            paintError(err);
        }
    }

    /* ── painting ────────────────────────────────────────────────────────── */

    function paintError(err: unknown): void {
        // An error is shown on the page, so a board that happens to be open gives way to it.
        body.dataset.board = '0';
        stage.hidden = true;
        inner.hidden = false;
        inner.replaceChildren();
        const p = doc.createElement('p');
        p.className = 'midorii-analysis-empty midorii-analysis-error';
        p.textContent = `This could not be read: ${err instanceof Error ? err.message : String(err)}`;
        inner.appendChild(p);
    }

    function empty(text: string): HTMLElement {
        const p = doc.createElement('p');
        p.className = 'midorii-analysis-empty';
        p.textContent = text;
        return p;
    }

    function heading(title: string, label: string, badge?: { text: string; live: boolean }): HTMLElement {
        const head = doc.createElement('div');
        head.className = 'midorii-analysis-head';
        const h = doc.createElement('h2');
        h.textContent = title;
        const who = doc.createElement('span');
        who.className = 'muted';
        who.textContent = label;
        head.append(h, who);
        if (badge) {
            const chip = doc.createElement('span');
            chip.className = 'midorii-analysis-badge';
            if (badge.live) chip.dataset.live = '1';
            chip.textContent = badge.text;
            head.appendChild(chip);
        }
        return head;
    }

    function subLine(text: string): HTMLElement {
        const p = doc.createElement('p');
        p.className = 'midorii-analysis-sub';
        p.textContent = text;
        return p;
    }

    /** The running account, as a card that opens into its full analysis. */
    function accountCard(subject: Subject): HTMLElement {
        const card = doc.createElement('div');
        card.className = 'midorii-analysis-card';
        card.dataset.pick = 'live';
        card.onclick = () => {
            open = subject;
            paint();
        };
        card.append(
            heading(subject.title, subject.label, {
                text: subject.running ? 'Running' : 'Paused',
                live: subject.running === true,
            }),
            subLine(subject.sub),
            statGrid(subject.stats),
            equityCurveSvg(subject.equityCurve, subject.initialBalance, subject.stats.netPnl, 120),
        );
        return card;
    }

    /** A panel's content, padded the way every panel here is. `fill` lets a chart take the height. */
    function pad(content: Element, fill = false): HTMLElement {
        const el = doc.createElement('div');
        el.className = fill ? 'midorii-analysis-pad midorii-analysis-fill' : 'midorii-analysis-pad';
        el.appendChild(content);
        return el;
    }

    /** One account or session in full: what it is on top, its figures in panels below. */
    function detail(subject: Subject): void {
        board?.dispose();
        disposePanelParts();
        stage.replaceChildren();

        const back = button(pane === 'accounts' ? '← Accounts' : '← Sessions');
        back.onclick = () => {
            open = null;
            paint();
        };

        const title = doc.createElement('div');
        title.className = 'midorii-analysis-detail-title';
        title.append(
            heading(
                subject.title,
                subject.label,
                subject.running == null ? undefined : { text: subject.running ? 'Running' : 'Paused', live: subject.running },
            ),
            subLine(subject.sub),
        );
        const bar = doc.createElement('div');
        bar.className = 'midorii-analysis-detail-bar';
        const layoutButton = button('Layout');
        attachLayoutMenu(layoutButton, root, layoutStore);
        bar.append(back, title, layoutButton);

        if (subject.runId) {
            const remove = button('Delete', 'danger');
            remove.onclick = () => {
                if (remove.dataset.armed !== '1') {
                    remove.dataset.armed = '1';
                    remove.textContent = 'Delete — click again';
                    return;
                }
                removeRun(subject.runId!);
            };
            bar.appendChild(remove);
        }

        /* What produced it. A backtest without its settings is a number nobody can act on,
         * and a hand-traded session genuinely has none — the risk on each trade was decided
         * as it was taken — so the panel says that rather than sitting empty. */
        const described = subject.params && subject.strategyId
            ? describeParams(subject.strategyId, subject.params)
            : [];

        /* The journal and the trade chart belong to a stored run: the trades of a paper account that
         * is still open are not on any candles this screen can read back, and it has no filing to
         * annotate. Those two say so rather than sitting empty. */
        let journalBody: HTMLElement;
        let reviewBody: HTMLElement;
        let tradesBody: HTMLElement;
        if (subject.runId && subject.market) {
            const journal = mountRunJournal(
                doc,
                { id: subject.runId, note: subject.note ?? '', tags: subject.tags ?? [], shots: subject.shots ?? [] },
                (patch) => noteJournalChange(subject, patch),
            );
            panelParts.push(journal);
            journalBody = journal.el;

            const shown = mountRunReview(doc, {
                symbol: subject.market.symbol,
                timeframe: subject.market.timeframe,
                trades: subject.trades,
                theme: opts.theme,
                onSelect: (index) => {
                    for (const row of tradesBody?.querySelectorAll<HTMLTableRowElement>('tr[data-trade-index]') ?? []) {
                        if (Number(row.dataset.tradeIndex) === index) {
                            row.setAttribute('aria-current', 'true');
                            row.scrollIntoView({ block: 'nearest' });
                        } else {
                            row.removeAttribute('aria-current');
                        }
                    }
                },
            });
            panelParts.push(shown);
            review = shown;
            reviewBody = pad(shown.el, true);
            tradesBody = pad(tradesTable(subject.trades, { selectedIndex: 0, onSelect: (index) => shown.select(index) }));
        } else {
            journalBody = pad(empty('Only a filed run has a journal. End a replay session, or run a backtest, '
                + 'and what you note about it is kept with it.'));
            reviewBody = pad(empty('Trades are drawn on their candles for a filed run.'));
            tradesBody = pad(tradesTable(subject.trades));
        }

        board = mountPanelBoard<AnalysisPanelId>(doc, layoutStore, {
            review: { title: 'Trade chart', body: reviewBody },
            journal: { title: 'Journal', body: journalBody },
            summary: { title: 'Summary', body: pad(statGrid(subject.stats)) },
            equity: {
                title: 'Equity',
                body: pad(equityCurveSvg(subject.equityCurve, subject.initialBalance, subject.stats.netPnl, 160), true),
            },
            breakdown: { title: 'Breakdown', body: pad(breakdownGrid(subject)) },
            settings: {
                title: 'Settings',
                body: pad(described.length > 0
                    ? settingsGrid(described)
                    : empty('No strategy settings were stored with this one. A hand-traded account has none: '
                        + 'the risk on each trade was decided as it was taken.')),
            },
            trades: { title: `Trades (${subject.trades.length})`, body: tradesBody },
        });
        stage.append(bar, board.el);
    }

    /** Load a stored run and show it in full. */
    async function openRun(id: string): Promise<void> {
        try {
            const run = await window.midori.runs.load(id);
            open = {
                title: `${run.symbol} · ${run.timeframe}`,
                label: run.strategyName,
                sub: `${formatDay(run.from)} to ${formatDay(run.to)} · ${run.stats.barCount.toLocaleString()} bars · `
                    + `started with ${formatMoney(run.initialBalance)} · stored ${formatWhen(run.createdAt)}`,
                stats: run.stats,
                equityCurve: run.equityCurve,
                initialBalance: run.initialBalance,
                trades: run.trades,
                runId: run.id,
                note: run.note,
                tags: run.tags ?? [],
                shots: run.shots ?? [],
                market: { symbol: run.symbol, timeframe: run.timeframe },
                params: run.params,
                strategyId: run.strategy,
            };
            paint();
        } catch (err: unknown) {
            console.error('[midorii] the run could not be opened', err);
            paintError(err);
        }
    }

    /* ── removing ────────────────────────────────────────────────────────── */

    /**
     * Take a stored run or sweep off its shelf.
     *
     * The shelves are read to compare one way of trading against another, and a shelf that
     * only ever grows stops being readable — a failed sweep from three weeks ago is noise
     * beside the four that are being weighed. Both the list rows and the detail screens go
     * through here so there is one answer to what deleting does: it removes the file and
     * re-reads, which drops whatever was open back to the shelf it came from.
     */
    function removeRun(id: string): void {
        void window.midori.runs.delete(id)
            .then(() => refresh())
            .catch((err: unknown) => paintError(err));
    }

    function removeSweep(id: string): void {
        void window.midori.sweep.delete(id)
            .then(() => refresh())
            .catch((err: unknown) => paintError(err));
    }

    /**
     * What has been traded on a venue, from Midorii's own journal.
     *
     * Its own section rather than a card among the paper accounts, and the two are never
     * totalled together: one is money and the other is not. The real account and the demo one
     * are split for the same reason — they are two accounts, and a win rate that mixes them
     * answers a question nobody asked.
     *
     * Deliberately fewer figures than a paper account gets. There is no R here (a venue does
     * not record what a trade risked when it opened) and no equity curve read off an engine —
     * what there is, is a list of results and their running total.
     */
    function liveSection(trades: readonly LiveTradeRecord[], title: string): HTMLElement {
        const section = doc.createElement('div');
        section.className = 'midorii-analysis-section';
        section.append(sectionLabel(`${title} (${trades.length})`));

        const summary = summarizeJournal(trades);
        const winRate = summary.trades > 0 ? summary.wins / summary.trades : null;
        /* The unit belongs on the number. A CFD account holds one currency and its instruments
         * quote in others, so a bare total is only a figure until something says which money
         * it is — and where the entries turn out to be in more than one, the total is a sum of
         * different monies and the label has to say so rather than look tidy. */
        const money = summary.currencies.length === 1 ? ` ${summary.currencies[0]}` : '';
        section.append(tileGrid([
            tile('Trades', String(summary.trades)),
            tile('Win rate', winRate == null ? '—' : formatPercent(winRate)),
            tile(summary.mixed ? 'Net P&L (mixed)' : `Net P&L${money}`, formatMoney(summary.netPnl), summary.netPnl),
            /* Said out loud rather than buried: a total built partly from reconstructed exits
             * is not the same claim as one the venue confirmed line by line. */
            tile('Reconstructed', summary.estimated === 0 ? 'none' : `${summary.estimated} of ${summary.trades}`),
        ]));

        if (summary.mixed) {
            section.append(subLine(
                `These trades are booked in ${summary.currencies.join(', ')}. The total above adds them `
                + 'together as they stand — Midorii does not convert between currencies, so read it as a '
                + 'sum of different monies rather than one figure.',
            ));
        }

        /* The running total, oldest first — the journal keeps newest first because that is how
         * a list is read, and a curve is the other way round. */
        const ordered = [...trades].reverse();
        let running = 0;
        const points = ordered.map((t) => {
            running += t.netPnl;
            return { time: t.closedAt, equity: running, balance: running, drawdown: 0 };
        });
        if (points.length > 1) section.append(equityCurveSvg(points, 0, summary.netPnl, 120));

        section.append(liveTradesTable(trades));
        return section;
    }

    /** The journal as a table. Its own rather than `tradesTable`, which has an R column that
     *  a live trade can never fill. */
    function liveTradesTable(trades: readonly LiveTradeRecord[]): HTMLElement {
        const table = doc.createElement('table');
        table.className = 'midorii-figures-table';
        const head = doc.createElement('tr');
        for (const label of ['Closed', 'Market', 'Side', 'Size', 'Entry', 'Exit', 'Net', 'Ccy']) {
            const th = doc.createElement('th');
            th.textContent = label;
            head.appendChild(th);
        }
        table.appendChild(head);

        const body = doc.createElement('tbody');
        for (const t of trades) {
            const tr = doc.createElement('tr');
            const cells = [
                formatWhen(t.closedAt),
                t.symbol,
                t.side,
                formatSize(t.size),
                formatPrice(t.entryPrice),
                // The one place the reader can see which exits were reconstructed.
                t.estimated ? `${formatPrice(t.exitPrice)} ~` : formatPrice(t.exitPrice),
                formatMoney(t.netPnl),
                t.currency ?? '—',
            ];
            for (const value of cells) {
                const td = doc.createElement('td');
                td.textContent = value;
                tr.appendChild(td);
            }
            if (t.estimated) tr.title = 'The exit price and result were reconstructed by Midorii — the venue closed this position between two reads.';
            body.appendChild(tr);
        }
        table.appendChild(body);
        return table;
    }

    function paintAccounts(): void {
        const realTrades = journal.filter((t) => t.live);
        const demoTrades = journal.filter((t) => !t.live);
        if (realTrades.length > 0) inner.append(liveSection(realTrades, 'Live trading'));
        if (demoTrades.length > 0) inner.append(liveSection(demoTrades, 'Demo trading'));
        if (journal.length === 0) {
            inner.append(sectionLabel('Live trading (0)'));
            inner.append(empty(
                'Nothing traded on a venue yet. Switch Trade → Capital.com on in the chart’s topbar; every '
                + 'position that closes is written down here, whether you closed it or a stop did.',
            ));
        }

        inner.append(sectionLabel('Paper account'));
        if (live) inner.append(accountCard(live));
        else {
            inner.append(empty(
                'No paper account yet. Switch Trade → Paper trading on in the chart’s topbar and this is '
                + 'where the account reads back.',
            ));
        }

        const filed = doc.createElement('div');
        filed.className = 'midorii-analysis-section';
        filed.append(sectionLabel(`Filed accounts (${accounts.length})`));
        filed.append(accounts.length === 0
            ? empty('Starting a paper account over files the old one here, so weeks of trades stay comparable '
                + 'against the next weeks.')
            : runsTable(accounts, (id) => void openRun(id), { who: false }));
        inner.append(filed);
    }

    /** What a swept parameter is called, when the strategy that swept it is still here. */
    function sweptLabel(strategyId: string, key: string): string {
        return STRATEGIES[strategyId]?.params.find((p) => p.key === key)?.label ?? key;
    }

    /** One stored sweep in full: what it varied, what won, and what that was worth on bars
     *  it did not choose. */
    function sweepDetail(sweep: MidoriSweep): void {
        inner.replaceChildren();

        const back = button('← Sweeps');
        back.onclick = () => {
            openSweep = null;
            paint();
        };

        const actions = doc.createElement('div');
        actions.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:14px';
        actions.appendChild(back);

        const remove = button('Delete', 'danger');
        remove.onclick = () => {
            if (remove.dataset.armed !== '1') {
                remove.dataset.armed = '1';
                remove.textContent = 'Delete — click again';
                return;
            }
            removeSweep(sweep.id);
        };
        const right = doc.createElement('div');
        right.style.cssText = 'margin-left:auto';
        right.appendChild(remove);
        actions.appendChild(right);

        const ranges = Object.entries(sweep.ranges)
            .map(([key, range]) => `${sweptLabel(sweep.strategy, key)} ${range.from}–${range.to} by ${range.step}`)
            .join(' · ');

        inner.append(
            actions,
            heading(`${sweep.symbol} · ${sweep.timeframe}`, sweep.strategyName, sweep.cancelled
                ? { text: 'Stopped early', live: false }
                : undefined),
            subLine(`${formatDay(sweep.from)} to ${formatDay(sweep.to)} · `
                + `${sweep.combinationCount.toLocaleString()} combinations · `
                + `started with ${formatMoney(sweep.balance)} · stored ${formatWhen(sweep.createdAt)}`),
        );

        if (ranges) inner.append(subLine(ranges));

        if (sweep.note) {
            const note = doc.createElement('p');
            note.className = 'midorii-analysis-sub midorii-analysis-note';
            note.textContent = sweep.note;
            inner.appendChild(note);
        }

        inner.append(tileGrid([
            tile('Combinations', sweep.combinationCount.toLocaleString()),
            tile('Ranked', sweep.rankedCount.toLocaleString()),
            tile('Set aside', sweep.excludedCount.toLocaleString()),
            tile('Optimised on', sweep.split ? `${sweep.split.trainBars.toLocaleString()} bars` : 'everything'),
        ]));

        inner.append(overfitNote(sweep.split != null));
        inner.append(sweepTable({
            sweptKeys: Object.keys(sweep.ranges),
            labels: new Map(Object.keys(sweep.ranges).map((key) => [key, sweptLabel(sweep.strategy, key)])),
            metric: sweep.metric as never,
            best: sweep.best,
            worst: sweep.worst,
            overlapping: sweep.overlapping,
        }));

        const fixed = describeParams(sweep.strategy, sweep.base);
        if (fixed.length > 0) {
            inner.append(sectionLabel('Held fixed'), settingsGrid(fixed));
        }

        if (sweep.resultsTruncated) {
            const trimmed = doc.createElement('p');
            trimmed.className = 'midorii-analysis-empty';
            trimmed.textContent = 'This sweep was too large to store whole. Both ends of the ranking '
                + 'are kept; the middle was dropped.';
            inner.appendChild(trimmed);
        }
    }

    /** Load a stored sweep and show it in full. */
    async function openStoredSweep(id: string): Promise<void> {
        try {
            openSweep = await window.midori.sweep.load(id);
            paint();
        } catch (err: unknown) {
            console.error('[midorii] the sweep could not be opened', err);
            paintError(err);
        }
    }

    function paintSweeps(): void {
        inner.append(sectionLabel(`Parameter sweeps (${sweeps.length})`));
        inner.append(sweeps.length === 0
            ? empty('Nothing here yet. Switch the Backtest tab to Sweep, give a setting a range, and the '
                + 'ranking lands on this shelf — with the settings that produced it, which is the only '
                + 'thing that makes one worth keeping.')
            : sweepsTable(
                sweeps,
                (id) => void openStoredSweep(id),
                (sweep, key) => sweptLabel(sweep.strategy, key),
                removeSweep,
            ));
    }

    function paintSessions(): void {
        const filed = new Set(sessions.flatMap((r) => r.tags ?? []));
        if (tagFilter !== null && !filed.has(tagFilter)) tagFilter = null; // the last run with it was deleted
        const shown = tagFilter === null ? sessions : sessions.filter((r) => r.tags?.includes(tagFilter!));
        inner.append(sectionLabel(`Backtests and replays (${shown.length}${shown.length === sessions.length ? '' : ` of ${sessions.length}`})`));
        if (filed.size > 0) inner.append(tagBar([...filed].sort((a, b) => a.localeCompare(b))));
        inner.append(sessions.length === 0
            ? empty('Nothing here yet. Play a replay session to the end, or run a backtest, and it lands on '
                + 'this shelf.')
            : runsTable(shown, (id) => void openRun(id), { onDelete: removeRun }));
    }

    /** The tags in use, as a row of buttons that narrow the shelf to one. */
    function tagBar(all: readonly string[]): HTMLElement {
        const bar = doc.createElement('div');
        bar.className = 'midorii-analysis-tags';
        bar.setAttribute('role', 'group');
        bar.setAttribute('aria-label', 'Filter by tag');
        for (const tag of [null, ...all]) {
            const chip = button(tag ?? 'All');
            chip.setAttribute('aria-pressed', String(tagFilter === tag));
            chip.onclick = () => {
                tagFilter = tag;
                paint();
            };
            bar.appendChild(chip);
        }
        return bar;
    }

    /** What the journal changed on a run, kept in the lists so going back shows it without a re-read. */
    function noteJournalChange(subject: Subject, patch: JournalPatch): void {
        if (patch.note !== undefined) subject.note = patch.note;
        if (patch.tags !== undefined) subject.tags = patch.tags;
        for (const shelf of [sessions, accounts]) {
            const at = shelf.findIndex((r) => r.id === subject.runId);
            if (at < 0) continue;
            const row = shelf[at]!;
            shelf[at] = {
                ...row,
                ...(patch.note !== undefined ? { note: patch.note } : {}),
                ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
                ...(patch.shots !== undefined ? { shots: patch.shots } : {}),
            };
        }
    }

    function paint(): void {
        head.setActive(pane);

        /* A single account is a board of panels that fills the screen; everything else is a page
         * that scrolls. The two live side by side so a board is only built when one is opened. */
        const boarded = open !== null;
        body.dataset.board = boarded ? '1' : '0';
        stage.hidden = !boarded;
        inner.hidden = boarded;
        if (!boarded) {
            board?.dispose();
            board = null;
            disposePanelParts();
            stage.replaceChildren();
        }

        if (open) {
            detail(open);
            return;
        }
        if (openSweep) {
            sweepDetail(openSweep);
            return;
        }

        inner.replaceChildren();
        if (pane === 'accounts') paintAccounts();
        else if (pane === 'sweeps') paintSweeps();
        else paintSessions();
    }

    paint();
    return {
        refresh,
        setTheme: (theme) => review?.setTheme(theme),
    };
}
