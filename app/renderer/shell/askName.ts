import { Dialog, buildFieldControl } from '../../../src/ui';

/** A one-line text question. Resolves with the trimmed answer, or null when dismissed or empty. */
export function askName(host: HTMLElement, title: string, initial: string, maxLength = 40): Promise<string | null> {
    return new Promise((resolve) => {
        let answer = initial;
        let settled = false;
        const settle = (value: string | null): void => {
            if (settled) return;
            settled = true;
            // Deferred a turn: this runs from inside the dialog's own button.
            setTimeout(() => dialog.destroy(), 0);
            resolve(value);
        };

        const field = buildFieldControl({
            kind: 'text',
            value: initial,
            fill: true,
            placeholder: 'Name…',
            onChange: (v) => { answer = v; },
        });
        const input = field.el.querySelector('input');
        if (input) {
            input.maxLength = maxLength;
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { answer = input.value; settle(answer.trim() || null); }
            });
        }
        const body = document.createElement('div');
        body.style.cssText = 'padding:16px 20px;';
        body.appendChild(field.el);

        const dialog = new Dialog({
            host,
            title,
            contained: true,
            align: 'center',
            draggable: true,
            flush: true,
            className: 'vela-dialog--form',
            closeOnBackdrop: true,
            footer: (foot) => {
                const cancel = document.createElement('button');
                cancel.type = 'button';
                cancel.className = 'vela-dialog-btn';
                cancel.textContent = 'Cancel';
                cancel.addEventListener('click', () => settle(null));
                const ok = document.createElement('button');
                ok.type = 'button';
                ok.className = 'vela-dialog-btn vela-dialog-btn-primary';
                ok.textContent = 'Ok';
                ok.addEventListener('click', () => settle((input?.value ?? answer).trim() || null));
                foot.append(cancel, ok);
            },
            onOpenChange: (open) => { if (!open) settle(null); },
        });
        dialog.body.appendChild(body);
        dialog.show();
        /* A turn later: the dialog moves focus to itself as it opens, which would otherwise
         * land after this and leave the field unfocused. */
        setTimeout(() => { input?.focus(); input?.select(); }, 50);
    });
}
