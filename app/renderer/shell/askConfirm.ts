import { Dialog } from '../../../src/ui';

/** A yes/no question. Resolves true only on the confirm button; Escape, the backdrop and Cancel all resolve false. */
export function askConfirm(host: HTMLElement, title: string, message: string, confirmLabel: string): Promise<boolean> {
    return new Promise((resolve) => {
        let settled = false;
        const settle = (value: boolean): void => {
            if (settled) return;
            settled = true;
            setTimeout(() => dialog.destroy(), 0);
            resolve(value);
        };
        const body = document.createElement('div');
        body.style.cssText = 'padding:16px 20px;font-size:13px;line-height:1.5;color:var(--vela-fg);';
        body.textContent = message;
        const dialog = new Dialog({
            host,
            title,
            contained: true,
            align: 'center',
            flush: true,
            className: 'vela-dialog--form',
            closeOnBackdrop: true,
            footer: (foot) => {
                const cancel = document.createElement('button');
                cancel.type = 'button';
                cancel.className = 'vela-dialog-btn';
                cancel.textContent = 'Cancel';
                cancel.addEventListener('click', () => settle(false));
                const ok = document.createElement('button');
                ok.type = 'button';
                ok.className = 'vela-dialog-btn vela-dialog-btn-primary';
                ok.textContent = confirmLabel;
                ok.addEventListener('click', () => settle(true));
                foot.append(cancel, ok);
            },
            onOpenChange: (open) => { if (!open) settle(false); },
        });
        dialog.body.appendChild(body);
        dialog.show();
    });
}
