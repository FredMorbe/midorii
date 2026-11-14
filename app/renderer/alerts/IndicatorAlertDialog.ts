import { Dialog, fieldGrid, fieldRow, buildFieldControl, type SelectOption } from '../../../src/ui';
import type { IndicatorAlertStore } from './IndicatorAlertStore';
import { pauseRow } from './alertCooldownRow';
import {
    alertableSpecs, CONDITION_OPTIONS, editableInputs, newIndicatorAlert, plotsOf, specOf, withDefaults,
    type IndicatorAlert, type IndicatorCondition,
} from './indicatorAlertModel';

const TIMEFRAMES: readonly SelectOption[] = [
    { value: '1', label: '1 minute' },
    { value: '5', label: '5 minutes' },
    { value: '15', label: '15 minutes' },
    { value: '30', label: '30 minutes' },
    { value: '60', label: '1 hour' },
    { value: '240', label: '4 hours' },
    { value: 'D', label: '1 day' },
];

function btn(label: string, primary: boolean, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.className = primary ? 'vela-dialog-btn vela-dialog-btn-primary' : 'vela-dialog-btn';
    b.addEventListener('click', onClick);
    return b;
}

/**
 * The indicator alert's popup. It edits a draft and writes nothing until Ok, so closing it any
 * other way leaves the store as it was: a half-made alert never starts watching a market.
 */
export class IndicatorAlertDialog {
    private ui: Dialog | null = null;

    constructor(
        private readonly host: HTMLElement,
        private readonly store: IndicatorAlertStore,
        private readonly report: (err: unknown) => void,
    ) {}

    /** A new alert on `symbol` and `timeframe`, starting from the RSI. */
    openNew(symbol: string, timeframe: string): void {
        const spec = specOf('rsi') ?? alertableSpecs()[0];
        if (!spec) {
            this.report(new Error('No indicator is available for alerts.'));
            return;
        }
        this.show(newIndicatorAlert(symbol, timeframe, spec), true);
    }

    openExisting(id: string): void {
        const alert = this.store.get(id);
        if (alert) this.show({ ...alert, inputs: { ...alert.inputs } }, false);
    }

    private show(draft: IndicatorAlert, isNew: boolean): void {
        this.close();
        const holder = document.createElement('div');
        holder.style.cssText = 'padding:16px 20px;';

        const render = (): void => {
            const spec = specOf(draft.indicator);
            const grid = fieldGrid({ variant: 'inputs' });

            const market = document.createElement('span');
            market.textContent = draft.symbol;
            market.style.cssText = 'color:var(--vela-fg-bright);font-size:12px;';
            grid.appendChild(fieldRow({ label: 'Market', control: market }));

            const timeframes = TIMEFRAMES.some((t) => t.value === draft.timeframe)
                ? TIMEFRAMES
                : [...TIMEFRAMES, { value: draft.timeframe, label: draft.timeframe }];
            grid.appendChild(fieldRow({
                label: 'Timeframe',
                control: buildFieldControl({
                    kind: 'select', options: timeframes, value: draft.timeframe, fill: true,
                    onChange: (v) => { draft.timeframe = v; },
                }).el,
                controlWidth: 240,
            }));

            grid.appendChild(fieldRow({
                label: 'Indicator',
                control: buildFieldControl({
                    kind: 'select',
                    options: alertableSpecs().map((s) => ({ value: s.type, label: s.title })),
                    value: draft.indicator,
                    fill: true,
                    onChange: (v) => {
                        const next = specOf(v);
                        if (!next) return;
                        const fresh = newIndicatorAlert(draft.symbol, draft.timeframe, next);
                        draft.indicator = v;
                        draft.inputs = {};
                        draft.plot = fresh.plot;
                        draft.against = fresh.against;
                        render();
                    },
                }).el,
                controlWidth: 240,
            }));

            if (spec) {
                const values = withDefaults(spec, draft.inputs);
                for (const input of editableInputs(spec)) {
                    if (input.type === 'string') {
                        grid.appendChild(fieldRow({
                            label: input.title,
                            control: buildFieldControl({
                                kind: 'select',
                                options: (input.options ?? []).map((o) => ({ value: o, label: o })),
                                value: String(values[input.key]),
                                fill: true,
                                onChange: (v) => { draft.inputs = { ...draft.inputs, [input.key]: v }; },
                            }).el,
                            controlWidth: 240,
                        }));
                    } else {
                        grid.appendChild(fieldRow({
                            label: input.title,
                            control: buildFieldControl({
                                kind: 'number',
                                value: Number(values[input.key]),
                                min: input.min,
                                max: input.max,
                                step: input.step,
                                integer: input.type === 'int',
                                commit: 'blur',
                                fill: true,
                                onChange: (n) => { draft.inputs = { ...draft.inputs, [input.key]: n }; },
                            }).el,
                            controlWidth: 160,
                        }));
                    }
                }
                const plots = plotsOf(spec);
                if (plots.length > 1) {
                    grid.appendChild(fieldRow({
                        label: 'Plot',
                        control: buildFieldControl({
                            kind: 'select',
                            options: plots.map((p) => ({ value: p.key, label: p.title })),
                            value: draft.plot,
                            fill: true,
                            onChange: (v) => { draft.plot = v; },
                        }).el,
                        controlWidth: 240,
                    }));
                }
            }

            grid.appendChild(fieldRow({
                label: 'Condition',
                control: buildFieldControl({
                    kind: 'select',
                    options: CONDITION_OPTIONS,
                    value: draft.condition,
                    fill: true,
                    onChange: (v) => { draft.condition = v as IndicatorCondition; },
                }).el,
                controlWidth: 240,
            }));

            grid.appendChild(fieldRow({
                label: 'Compared to',
                control: buildFieldControl({
                    kind: 'select',
                    options: [{ value: 'level', label: 'A level' }, { value: 'price', label: 'The price' }],
                    value: draft.against.kind,
                    fill: true,
                    onChange: (v) => {
                        draft.against = v === 'price' ? { kind: 'price' } : { kind: 'level', value: draft.against.kind === 'level' ? draft.against.value : 70 };
                        render();
                    },
                }).el,
                controlWidth: 240,
            }));
            if (draft.against.kind === 'level') {
                grid.appendChild(fieldRow({
                    label: 'Level',
                    control: buildFieldControl({
                        kind: 'number',
                        value: draft.against.value,
                        commit: 'blur',
                        fill: true,
                        onChange: (n) => { draft.against = { kind: 'level', value: n }; },
                    }).el,
                    controlWidth: 160,
                }));
            }

            grid.appendChild(fieldRow({
                label: 'Message',
                control: buildFieldControl({
                    kind: 'textarea',
                    value: draft.message,
                    rows: 3,
                    placeholder: 'Message (optional)…',
                    onChange: (v) => { draft.message = v; },
                }).el,
                stacked: true,
            }));
            const pause = pauseRow(draft.cooldownMs, draft.once, (ms) => { draft.cooldownMs = ms; });
            grid.appendChild(fieldRow({ label: 'Once', bool: true, toggle: { checked: draft.once, onChange: (v) => { draft.once = v; pause.setOnce(v); } } }));
            grid.appendChild(pause.row);
            grid.appendChild(fieldRow({ label: 'Enabled', bool: true, toggle: { checked: draft.enabled, onChange: (v) => { draft.enabled = v; } } }));
            holder.replaceChildren(grid);
        };
        render();

        const save = (): void => {
            try {
                if (isNew) this.store.add({ ...draft, createdAt: Date.now() });
                else this.store.update(draft.id, { ...draft });
                this.close();
            } catch (err) {
                this.report(err);
            }
        };

        const ui = new Dialog({
            host: this.host,
            title: isNew ? 'New indicator alert' : 'Edit indicator alert',
            eyebrow: 'Alerts',
            contained: true,
            align: 'center',
            draggable: true,
            flush: true,
            className: 'vela-dialog--form',
            closeOnBackdrop: true,
            footer: (foot) => {
                if (!isNew) {
                    foot.append(btn('Delete', false, () => {
                        try {
                            this.store.remove(draft.id);
                            this.close();
                        } catch (err) {
                            this.report(err);
                        }
                    }));
                }
                foot.append(btn('Cancel', false, () => this.close()), btn(isNew ? 'Create' : 'Ok', true, save));
            },
            onOpenChange: (open) => { if (!open) this.close(); },
        });
        ui.body.appendChild(holder);
        this.ui = ui;
        ui.show();
    }

    close(): void {
        const ui = this.ui;
        this.ui = null;
        ui?.destroy();
    }
}
