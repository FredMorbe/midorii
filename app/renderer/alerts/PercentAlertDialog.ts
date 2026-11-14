import { buildFieldControl, fieldGrid, fieldRow, type Dialog } from '../../../src/ui';
import { openAlertForm } from './alertFormDialog';
import type { AlertListStore } from './AlertListStore';
import { DIRECTION_OPTIONS, newPercentAlert, type PercentAlert, type PercentDirection } from './percentAlertModel';

/**
 * The percent alert's popup. It edits a draft and writes nothing until Ok, so closing it any
 * other way leaves the store as it was.
 */
export class PercentAlertDialog {
    private ui: Dialog | null = null;

    constructor(
        private readonly host: HTMLElement,
        private readonly store: AlertListStore<PercentAlert>,
        private readonly report: (err: unknown) => void,
    ) {}

    openNew(symbol: string): void {
        this.show(newPercentAlert(symbol), true);
    }

    openExisting(id: string): void {
        const alert = this.store.get(id);
        if (alert) this.show({ ...alert }, false);
    }

    private show(draft: PercentAlert, isNew: boolean): void {
        this.close();
        const before = isNew ? null : this.store.get(draft.id) ?? null;
        const holder = document.createElement('div');
        holder.style.cssText = 'padding:16px 20px;';
        const grid = fieldGrid({ variant: 'inputs' });

        const market = document.createElement('span');
        market.textContent = draft.symbol;
        market.style.cssText = 'color:var(--vela-fg-bright);font-size:12px;';
        grid.appendChild(fieldRow({ label: 'Market', control: market }));

        grid.appendChild(fieldRow({
            label: 'Move (%)',
            control: buildFieldControl({
                kind: 'number', value: draft.percent, min: 0.01, commit: 'blur', fill: true,
                onChange: (n) => { draft.percent = n; },
            }).el,
            controlWidth: 160,
        }));
        grid.appendChild(fieldRow({
            label: 'Direction',
            control: buildFieldControl({
                kind: 'select', options: DIRECTION_OPTIONS, value: draft.direction, fill: true,
                onChange: (v) => { draft.direction = v as PercentDirection; },
            }).el,
            controlWidth: 240,
        }));

        const note = document.createElement('div');
        note.style.cssText = 'font-size:11px;color:var(--vela-fg-muted);padding:2px 0 8px;';
        note.textContent = isNew || draft.reference == null
            ? 'Measured from the first price seen once the alert is on.'
            : `Measured from ${draft.reference}.`;
        grid.appendChild(note);

        grid.appendChild(fieldRow({
            label: 'Message',
            control: buildFieldControl({
                kind: 'textarea', value: draft.message, rows: 3, placeholder: 'Message (optional)…',
                onChange: (v) => { draft.message = v; },
            }).el,
            stacked: true,
        }));
        grid.appendChild(fieldRow({ label: 'Once', bool: true, toggle: { checked: draft.once, onChange: (v) => { draft.once = v; } } }));
        grid.appendChild(fieldRow({ label: 'Enabled', bool: true, toggle: { checked: draft.enabled, onChange: (v) => { draft.enabled = v; } } }));
        holder.appendChild(grid);

        this.ui = openAlertForm({
            host: this.host,
            title: isNew ? 'New percent alert' : 'Edit percent alert',
            isNew,
            body: holder,
            onSave: () => {
                try {
                    if (!(draft.percent > 0)) throw new Error('The move has to be more than 0%.');
                    // Switching an alert on starts its measuring afresh: the old reference may be hours stale.
                    const restarted = before != null && !before.enabled && draft.enabled;
                    const next = { ...draft, reference: restarted ? null : draft.reference };
                    if (isNew) this.store.add({ ...next, createdAt: Date.now() });
                    else this.store.update(draft.id, next);
                    this.close();
                } catch (err) {
                    this.report(err);
                }
            },
            onDelete: () => {
                try {
                    this.store.remove(draft.id);
                    this.close();
                } catch (err) {
                    this.report(err);
                }
            },
            onClosed: () => this.close(),
        });
    }

    close(): void {
        const ui = this.ui;
        this.ui = null;
        ui?.destroy();
    }
}
