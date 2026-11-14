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

/** Registers the "Alerts" side panel — a flat list of every price alert (any symbol),
 *  each row toggling/editing/deleting in place. Separate from the built-in topbar
 *  "Alerts" bell, which is an unrelated script-`alert()` log (see VelaWorkspace.ts). */
export function registerAlertsPanel(
    store: AlertStore,
    dialog: AlertDialog,
    indicators: { store: IndicatorAlertStore; dialog: IndicatorAlertDialog; canWatch: (symbol: string) => boolean },
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
            body.append(list, empty, head, indicatorList, indicatorEmpty);

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
            render();
            renderIndicators();
            const off = store.onChange(render);
            const offIndicators = indicators.store.onChange(renderIndicators);

            return { destroy: () => { off(); offIndicators(); } };
        },
    });
}
