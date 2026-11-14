import { buildFieldControl, fieldGrid, fieldRow, type Dialog } from '../../../src/ui';
import { openAlertForm } from './alertFormDialog';
import type { AlertListStore } from './AlertListStore';
import { formatDue, newTimeAlert, parseWhen, WHEN_HINT, type TimeAlert } from './timeAlertModel';

/**
 * The time alert's popup. It edits a draft and writes nothing until Ok. Editing an existing
 * alert shows when it is due; typing a new "when" moves it, leaving the field empty keeps it.
 */
export class TimeAlertDialog {
    private ui: Dialog | null = null;

    constructor(
        private readonly host: HTMLElement,
        private readonly store: AlertListStore<TimeAlert>,
        private readonly report: (err: unknown) => void,
        private readonly now: () => number = () => Date.now(),
    ) {}

    openNew(): void {
        this.show(newTimeAlert(this.now()), true);
    }

    openExisting(id: string): void {
        const alert = this.store.get(id);
        if (alert) this.show({ ...alert }, false);
    }

    private show(draft: TimeAlert, isNew: boolean): void {
        this.close();
        let when = '';
        const holder = document.createElement('div');
        holder.style.cssText = 'padding:16px 20px;';
        const grid = fieldGrid({ variant: 'inputs' });

        if (!isNew) {
            const due = document.createElement('span');
            due.textContent = formatDue(draft.at);
            due.style.cssText = 'color:var(--vela-fg-bright);font-size:12px;';
            grid.appendChild(fieldRow({ label: 'Due', control: due }));
        }
        grid.appendChild(fieldRow({
            label: isNew ? 'When' : 'Move to',
            control: buildFieldControl({
                kind: 'text', value: '', placeholder: isNew ? '15m' : 'leave empty to keep', fill: true,
                onChange: (v) => { when = v; },
            }).el,
            controlWidth: 240,
        }));
        const hint = document.createElement('div');
        hint.style.cssText = 'font-size:11px;color:var(--vela-fg-muted);padding:2px 0 8px;';
        hint.textContent = WHEN_HINT.replace(/^e\.g\. /, 'For example ');
        grid.appendChild(hint);

        grid.appendChild(fieldRow({
            label: 'Message',
            control: buildFieldControl({
                kind: 'textarea', value: draft.message, rows: 3, placeholder: 'Message (optional)…',
                onChange: (v) => { draft.message = v; },
            }).el,
            stacked: true,
        }));
        if (!isNew) grid.appendChild(fieldRow({ label: 'Enabled', bool: true, toggle: { checked: draft.enabled, onChange: (v) => { draft.enabled = v; } } }));
        holder.appendChild(grid);

        this.ui = openAlertForm({
            host: this.host,
            title: isNew ? 'New time alert' : 'Edit time alert',
            isNew,
            body: holder,
            onSave: () => {
                try {
                    if (isNew || when.trim() !== '') {
                        const parsed = parseWhen(when, this.now());
                        if ('error' in parsed) throw new Error(parsed.error);
                        draft.at = parsed.at;
                        draft.enabled = true;
                    }
                    if (isNew) this.store.add({ ...draft, createdAt: this.now() });
                    else this.store.update(draft.id, { ...draft });
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
