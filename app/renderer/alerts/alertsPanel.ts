import { registerSidePanel, type SidePanelHandle } from '../../../src/plugin';
import { buildFieldControl } from '../../../src/ui';
import type { AlertDialog } from './AlertDialog';
import type { AlertStore } from './AlertStore';
import type { PriceAlert } from './alertTypes';
import { formatPrice } from '../format';
import type { IndicatorAlertDialog } from './IndicatorAlertDialog';
import type { IndicatorAlertStore } from './IndicatorAlertStore';
import { describeAlert, type IndicatorAlert } from './indicatorAlertModel';
import { symbolTicker } from './alertTypes';
import type { AlertHistoryStore } from './AlertHistoryStore';
import { ago, type HistoryEntry } from './alertHistoryModel';
import type { AlertListStore } from './AlertListStore';
import type { PercentAlertDialog } from './PercentAlertDialog';
import type { TimeAlertDialog } from './TimeAlertDialog';
import { describePercent, type PercentAlert } from './percentAlertModel';
import { formatDue, untilText, type TimeAlert } from './timeAlertModel';

const CONDITION_LABEL: Record<PriceAlert['condition'], string> = {
    crossing: 'Crossing',
    above: 'Crossing up',
    below: 'Crossing down',
};

function row(alert: PriceAlert, store: AlertStore, dialog: AlertDialog): HTMLElement {
    const el = document.createElement('div');
    el.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--vela-border);cursor:pointer;';

    const sw = buildFieldControl({
        kind: 'switch',
        checked: alert.enabled,
        onChange: (v) => store.update(alert.id, { enabled: v }),
    });
    sw.el.addEventListener('click', (e) => e.stopPropagation());

    const info = document.createElement('div');
    info.style.cssText = 'flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;';
    const main = document.createElement('div');
    main.style.cssText = 'font-size:12px;color:var(--vela-fg-bright);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
    main.textContent = `${alert.symbol} @ ${formatPrice(alert.price)}`;
    const sub = document.createElement('div');
    sub.style.cssText = 'font-size:11px;color:var(--vela-fg-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
    sub.textContent = alert.label ? `${CONDITION_LABEL[alert.condition]} · ${alert.label}` : CONDITION_LABEL[alert.condition];
    info.append(main, sub);

    const del = document.createElement('button');
    del.type = 'button';
    del.textContent = '✕';
    del.title = 'Delete alert';
    del.style.cssText = 'border:none;background:none;color:var(--vela-fg-muted);cursor:pointer;font-size:12px;padding:2px 4px;';
    del.addEventListener('click', (e) => {
        e.stopPropagation();
        store.remove(alert.id);
    });

    el.append(sw.el, info, del);
    el.addEventListener('click', () => dialog.open(alert.id));
    return el;
}

function indicatorRow(alert: IndicatorAlert, store: IndicatorAlertStore, dialog: IndicatorAlertDialog): HTMLElement {
    const el = document.createElement('div');
    el.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--vela-border);cursor:pointer;';

    const sw = buildFieldControl({
        kind: 'switch',
        checked: alert.enabled,
        onChange: (v) => store.update(alert.id, { enabled: v }),
    });
    sw.el.addEventListener('click', (e) => e.stopPropagation());

    const info = document.createElement('div');
    info.style.cssText = 'flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;';
    const main = document.createElement('div');
    main.style.cssText = 'font-size:12px;color:var(--vela-fg-bright);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
    main.textContent = `${symbolTicker(alert.symbol)} \u00b7 ${alert.timeframe}`;
    const sub = document.createElement('div');
    sub.style.cssText = 'font-size:11px;color:var(--vela-fg-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
    sub.textContent = describeAlert(alert);
    sub.title = describeAlert(alert);
    info.append(main, sub);

    const del = document.createElement('button');
    del.type = 'button';
    del.textContent = '\u2715';
    del.title = 'Delete alert';
    del.style.cssText = 'border:none;background:none;color:var(--vela-fg-muted);cursor:pointer;font-size:12px;padding:2px 4px;';
    del.addEventListener('click', (e) => {
        e.stopPropagation();
        store.remove(alert.id);
    });

    el.append(sw.el, info, del);
    el.addEventListener('click', () => dialog.openExisting(alert.id));
    return el;
}

/** A row for the alert kinds after the first two: a switch, two lines of text, a delete button; a click edits. */
function listRow<T extends { id: string; enabled: boolean; createdAt: number }>(
    alert: T,
    store: AlertListStore<T>,
    lines: { main: string; sub: string },
    onEnable: (alert: T, enabled: boolean) => Partial<Omit<T, 'id'>>,
    edit: (id: string) => void,
): HTMLElement {
    const el = document.createElement('div');
    el.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--vela-border);cursor:pointer;';
    const sw = buildFieldControl({
        kind: 'switch',
        checked: alert.enabled,
        onChange: (v) => store.update(alert.id, onEnable(alert, v)),
    });
    sw.el.addEventListener('click', (e) => e.stopPropagation());
    const info = document.createElement('div');
    info.style.cssText = 'flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;';
    const main = document.createElement('div');
    main.style.cssText = 'font-size:12px;color:var(--vela-fg-bright);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
    main.textContent = lines.main;
    const sub = document.createElement('div');
    sub.style.cssText = 'font-size:11px;color:var(--vela-fg-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
    sub.textContent = lines.sub;
    sub.title = lines.sub;
    info.append(main, sub);
    const del = document.createElement('button');
    del.type = 'button';
    del.textContent = '\u2715';
    del.title = 'Delete alert';
    del.style.cssText = 'border:none;background:none;color:var(--vela-fg-muted);cursor:pointer;font-size:12px;padding:2px 4px;';
    del.addEventListener('click', (e) => {
        e.stopPropagation();
        store.remove(alert.id);
    });
    el.append(sw.el, info, del);
    el.addEventListener('click', () => edit(alert.id));
    return el;
}

function historyRow(entry: HistoryEntry, now: number): HTMLElement {
    const el = document.createElement('div');
    el.style.cssText = 'display:flex;flex-direction:column;gap:2px;padding:6px 12px;border-bottom:1px solid var(--vela-border);';
    const main = document.createElement('div');
    main.style.cssText = 'display:flex;justify-content:space-between;gap:8px;font-size:12px;color:var(--vela-fg-bright);';
    const title = document.createElement('span');
    title.style.cssText = 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
    title.textContent = entry.title;
    const when = document.createElement('span');
    when.style.cssText = 'flex:none;font-size:11px;color:var(--vela-fg-muted);';
    when.textContent = ago(now, entry.at);
    when.title = new Date(entry.at).toLocaleString();
    main.append(title, when);
    const body = document.createElement('div');
    body.style.cssText = 'font-size:11px;color:var(--vela-fg-muted);overflow-wrap:anywhere;';
    body.textContent = entry.body;
    el.append(main, body);
    return el;
}

/** Registers the "Alerts" side panel — a flat list of every price alert (any symbol),
 *  each row toggling/editing/deleting in place. Separate from the built-in topbar
 *  "Alerts" bell, which is an unrelated script-`alert()` log (see VelaWorkspace.ts). */
export function registerAlertsPanel(
    store: AlertStore,
    dialog: AlertDialog,
    indicators: { store: IndicatorAlertStore; dialog: IndicatorAlertDialog; canWatch: (symbol: string) => boolean },
    history: AlertHistoryStore,
    more: {
        percent: { store: AlertListStore<PercentAlert>; dialog: PercentAlertDialog };
        time: { store: AlertListStore<TimeAlert>; dialog: TimeAlertDialog };
    },
): () => void {
    return registerSidePanel({
        id: 'midorii.alerts-panel',
        title: 'Alerts',
        // Deliberately not 'bell' — the topbar already has a bell for the unrelated
        // script-alerts log, and two identical glyphs side by side is how this panel goes
        // unnoticed. 'bands' (stacked horizontal lines) reads as "price levels" instead.
        icon: 'bands',
        order: 50,
        width: 260,
        exclusive: false,
        mount(ctx, body): SidePanelHandle {
            const list = document.createElement('div');
            list.style.cssText = 'display:flex;flex-direction:column;overflow-y:auto;';
            const empty = document.createElement('div');
            empty.style.cssText = 'padding:16px;font-size:12px;color:var(--vela-fg-muted);text-align:center;';
            empty.textContent = 'No alerts yet \u2014 right-click the chart to add one.';

            const head = document.createElement('div');
            head.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:10px 12px 6px;font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:var(--vela-fg-muted);';
            head.textContent = 'Indicator alerts';
            const add = document.createElement('button');
            add.type = 'button';
            add.textContent = '+';
            add.title = 'New indicator alert on this chart';
            add.style.cssText = 'border:none;background:none;color:var(--vela-fg);cursor:pointer;font-size:16px;line-height:1;padding:0 4px;';
            add.addEventListener('click', () => {
                if (!indicators.canWatch(ctx.symbol)) {
                    ctx.toast('This market has no live feed to watch.', 'error');
                    return;
                }
                indicators.dialog.openNew(ctx.symbol, ctx.timeframe);
            });
            head.appendChild(add);
            const indicatorList = document.createElement('div');
            indicatorList.style.cssText = 'display:flex;flex-direction:column;';
            const indicatorEmpty = document.createElement('div');
            indicatorEmpty.style.cssText = 'padding:6px 12px 14px;font-size:12px;color:var(--vela-fg-muted);';
            indicatorEmpty.textContent = 'Press + to alert on an indicator, such as the RSI crossing 70.';

            const section = (title: string, addTitle: string, onAdd: () => void, emptyText: string) => {
                const sectionHead = document.createElement('div');
                sectionHead.style.cssText = head.style.cssText;
                sectionHead.textContent = title;
                const plus = document.createElement('button');
                plus.type = 'button';
                plus.textContent = '+';
                plus.title = addTitle;
                plus.style.cssText = add.style.cssText;
                plus.addEventListener('click', onAdd);
                sectionHead.appendChild(plus);
                const rows = document.createElement('div');
                rows.style.cssText = 'display:flex;flex-direction:column;';
                const none = document.createElement('div');
                none.style.cssText = indicatorEmpty.style.cssText;
                none.textContent = emptyText;
                return { sectionHead, rows, none };
            };
            const percent = section('Percent alerts', 'New percent alert on this chart', () => {
                if (!indicators.canWatch(ctx.symbol)) {
                    ctx.toast('This market has no live feed to watch.', 'error');
                    return;
                }
                more.percent.dialog.openNew(ctx.symbol);
            }, 'Press + to be told when a price has moved by a share, such as 2%.');
            const time = section('Time alerts', 'New time alert', () => more.time.dialog.openNew(),
                'Press + for a reminder at a moment, such as in 15 minutes.');

            const historyHead = document.createElement('div');
            historyHead.style.cssText = head.style.cssText;
            historyHead.textContent = 'History';
            const clear = document.createElement('button');
            clear.type = 'button';
            clear.textContent = 'Clear';
            clear.title = 'Forget the alerts that fired';
            clear.style.cssText = 'border:none;background:none;color:var(--vela-fg-muted);cursor:pointer;font-size:11px;text-transform:none;letter-spacing:0;padding:0 4px;';
            clear.addEventListener('click', () => history.clear());
            historyHead.appendChild(clear);
            const historyList = document.createElement('div');
            historyList.style.cssText = 'display:flex;flex-direction:column;';
            const historyEmpty = document.createElement('div');
            historyEmpty.style.cssText = 'padding:6px 12px 14px;font-size:12px;color:var(--vela-fg-muted);';
            historyEmpty.textContent = 'Alerts that fire are listed here.';
            body.append(list, empty, head, indicatorList, indicatorEmpty,
                percent.sectionHead, percent.rows, percent.none, time.sectionHead, time.rows, time.none,
                historyHead, historyList, historyEmpty);

            const render = (): void => {
                const alerts = store.list();
                list.replaceChildren(...alerts.map((a) => row(a, store, dialog)));
                empty.hidden = alerts.length > 0;
            };
            const renderIndicators = (): void => {
                const alerts = indicators.store.list();
                indicatorList.replaceChildren(...alerts.map((a) => indicatorRow(a, indicators.store, indicators.dialog)));
                indicatorEmpty.hidden = alerts.length > 0;
            };
            const renderPercent = (): void => {
                const alerts = more.percent.store.list();
                percent.rows.replaceChildren(...alerts.map((a) => listRow(
                    a, more.percent.store,
                    { main: symbolTicker(a.symbol), sub: describePercent(a) },
                    // Switching an alert on measures from the price of that moment, not from one hours old.
                    (_alert, enabled) => (enabled ? { enabled, reference: null } : { enabled }),
                    (id) => more.percent.dialog.openExisting(id),
                )));
                percent.none.hidden = alerts.length > 0;
            };
            const timeSub = (a: TimeAlert, now: number): string => {
                if (a.enabled) return `${formatDue(a.at)} \u00b7 ${untilText(now, a.at)}`;
                return a.lastTriggeredAt != null ? `Fired ${formatDue(a.lastTriggeredAt)}` : `Off \u00b7 was ${formatDue(a.at)}`;
            };
            const renderTime = (): void => {
                const now = Date.now();
                const alerts = more.time.store.list();
                time.rows.replaceChildren(...alerts.map((a) => listRow(
                    a, more.time.store,
                    { main: a.message || 'Reminder', sub: timeSub(a, now) },
                    (_alert, enabled) => ({ enabled }),
                    (id) => more.time.dialog.openExisting(id),
                )));
                time.none.hidden = alerts.length > 0;
            };
            const renderHistory = (): void => {
                const entries = history.list();
                const now = Date.now();
                historyList.replaceChildren(...entries.map((e) => historyRow(e, now)));
                historyEmpty.hidden = entries.length > 0;
                clear.hidden = entries.length === 0;
            };
            render();
            renderIndicators();
            renderHistory();
            renderPercent();
            renderTime();
            const off = store.onChange(render);
            const offPercent = more.percent.store.onChange(renderPercent);
            const offTime = more.time.store.onChange(renderTime);
            const offIndicators = indicators.store.onChange(renderIndicators);
            const offHistory = history.onChange(renderHistory);
            // "5 min ago" goes stale while the panel stays open.
            const refreshAges = setInterval(() => { renderHistory(); renderTime(); }, 60_000);

            return { destroy: () => { off(); offIndicators(); offPercent(); offTime(); offHistory(); clearInterval(refreshAges); } };
        },
    });
}
