import { Dialog } from '../../../src/ui';

function btn(label: string, primary: boolean, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.className = primary ? 'vela-dialog-btn vela-dialog-btn-primary' : 'vela-dialog-btn';
    b.addEventListener('click', onClick);
    return b;
}

export interface AlertFormOptions {
    host: HTMLElement;
    title: string;
    isNew: boolean;
    body: HTMLElement;
    /** Ok or Create. Close the dialog itself when the draft was accepted; leave it open to let the person fix it. */
    onSave: () => void;
    onDelete: () => void;
    /** However the dialog went away. */
    onClosed: () => void;
}

/** The popup every alert kind after the first uses: a body, then Delete (when editing), Cancel and Ok. */
export function openAlertForm(opts: AlertFormOptions): Dialog {
    const ui = new Dialog({
        host: opts.host,
        title: opts.title,
        eyebrow: 'Alerts',
        contained: true,
        align: 'center',
        draggable: true,
        flush: true,
        className: 'vela-dialog--form',
        closeOnBackdrop: true,
        footer: (foot) => {
            if (!opts.isNew) foot.append(btn('Delete', false, opts.onDelete));
            foot.append(btn('Cancel', false, () => opts.onClosed()), btn(opts.isNew ? 'Create' : 'Ok', true, opts.onSave));
        },
        onOpenChange: (open) => { if (!open) opts.onClosed(); },
    });
    ui.body.appendChild(opts.body);
    ui.show();
    return ui;
}
