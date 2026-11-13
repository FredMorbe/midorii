import { Dialog, injectStyles } from '../../../src/ui';
import { rankEntries, type PaletteEntry } from './paletteModel';

export interface PaletteCommand extends PaletteEntry {
    run: () => void;
    /** A digit that, with Ctrl (Cmd on macOS), runs this command from anywhere. */
    digit?: string;
}

export interface CommandPalette {
    open(): void;
    dispose(): void;
}

const STYLE_ID = 'midorii-palette';
const MAX_ROWS = 60;
const CSS = `
.midorii-palette { display: flex; flex-direction: column; width: min(560px, 92vw); }
.midorii-palette-input {
    box-sizing: border-box; width: 100%; padding: 14px 18px; border: 0; outline: 0;
    border-bottom: 1px solid var(--vela-border-faint); background: transparent;
    color: var(--vela-fg-bright); font: inherit; font-size: 15px;
}
.midorii-palette-list { max-height: min(52vh, 420px); overflow-y: auto; padding: 6px; }
.midorii-palette-group {
    padding: 8px 12px 4px; font-size: 10.5px; letter-spacing: 0.08em; text-transform: uppercase;
    color: var(--vela-fg-muted);
}
.midorii-palette-row {
    display: flex; align-items: baseline; gap: 10px; padding: 8px 12px; border-radius: var(--vela-control-radius);
    color: var(--vela-fg); cursor: pointer; font-size: 13px;
}
.midorii-palette-row[data-active] { background: var(--vela-accent-soft, var(--vela-hover)); color: var(--vela-fg-bright); }
.midorii-palette-dialog .vela-dialog-header { display: none; }
.midorii-palette-hint { color: var(--vela-fg-muted); font-size: 11.5px; }
.midorii-palette-key { margin-left: auto; color: var(--vela-fg-muted); font-family: var(--vela-font-mono); font-size: 11px; }
.midorii-palette-empty { padding: 18px 12px; color: var(--vela-fg-muted); font-size: 13px; }
`;

const isMac = (): boolean => /mac/i.test(navigator.platform);
const chordLabel = (digit: string): string => (isMac() ? `⌘${digit}` : `Ctrl+${digit}`);

/**
 * The app's command palette: Ctrl+K (Cmd+K) opens a filter over everything the app can do, and
 * Ctrl+digit runs the commands that carry a digit. `commands` is read each time the palette
 * opens, so what it lists follows the app's state: the current tab, the watchlist.
 */
export function mountCommandPalette(opts: { host: HTMLElement; commands: () => PaletteCommand[] }): CommandPalette {
    let dialog: Dialog | null = null;

    const open = (): void => {
        if (dialog) return;
        const doc = opts.host.ownerDocument;
        injectStyles(STYLE_ID, CSS, doc);
        const commands = opts.commands();
        let shown: PaletteCommand[] = [];
        let active = 0;

        const root = doc.createElement('div');
        root.className = 'midorii-palette';
        const input = doc.createElement('input');
        input.className = 'midorii-palette-input';
        input.placeholder = 'Type a command or a market…';
        input.setAttribute('role', 'combobox');
        input.setAttribute('aria-expanded', 'true');
        input.setAttribute('aria-label', 'Command palette');
        const list = doc.createElement('div');
        list.className = 'midorii-palette-list';
        list.setAttribute('role', 'listbox');
        root.append(input, list);

        const close = (): void => {
            const d = dialog;
            dialog = null;
            if (d) setTimeout(() => d.destroy(), 0);
        };
        const run = (command: PaletteCommand | undefined): void => {
            if (!command) return;
            close();
            // After the palette is gone: a command that opens a dialog must not lose its focus to this one.
            setTimeout(() => command.run(), 0);
        };

        const render = (): void => {
            shown = rankEntries(commands, input.value).slice(0, MAX_ROWS);
            active = Math.min(active, Math.max(0, shown.length - 1));
            list.replaceChildren();
            if (shown.length === 0) {
                const empty = doc.createElement('div');
                empty.className = 'midorii-palette-empty';
                empty.textContent = 'Nothing matches.';
                list.appendChild(empty);
                return;
            }
            let group = '';
            shown.forEach((command, index) => {
                if (!input.value.trim() && command.group !== group) {
                    group = command.group;
                    const head = doc.createElement('div');
                    head.className = 'midorii-palette-group';
                    head.textContent = group;
                    list.appendChild(head);
                }
                const row = doc.createElement('div');
                row.className = 'midorii-palette-row';
                row.setAttribute('role', 'option');
                if (index === active) row.dataset.active = '1';
                const title = doc.createElement('span');
                title.textContent = command.title;
                row.appendChild(title);
                if (command.hint) {
                    const hint = doc.createElement('span');
                    hint.className = 'midorii-palette-hint';
                    hint.textContent = command.hint;
                    row.appendChild(hint);
                }
                if (command.digit) {
                    const key = doc.createElement('span');
                    key.className = 'midorii-palette-key';
                    key.textContent = chordLabel(command.digit);
                    row.appendChild(key);
                }
                row.addEventListener('mousemove', () => {
                    if (active === index) return;
                    list.querySelector('[data-active]')?.removeAttribute('data-active');
                    active = index;
                    row.dataset.active = '1';
                });
                row.addEventListener('click', () => run(command));
                list.appendChild(row);
            });
        };
        const move = (by: number): void => {
            if (shown.length === 0) return;
            active = (active + by + shown.length) % shown.length;
            render();
            list.querySelector('[data-active]')?.scrollIntoView({ block: 'nearest' });
        };

        input.addEventListener('input', () => { active = 0; render(); });
        input.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
            else if (e.key === 'Enter') { e.preventDefault(); run(shown[active]); }
        });

        dialog = new Dialog({
            host: opts.host,
            align: 'top',
            flush: true,
            dimBackdrop: true,
            closeOnBackdrop: true,
            className: 'midorii-palette-dialog',
            onOpenChange: (isOpen) => { if (!isOpen) close(); },
        });
        dialog.body.appendChild(root);
        dialog.show();
        render();
        setTimeout(() => input.focus(), 50);
    };

    const onKey = (e: KeyboardEvent): void => {
        if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
        if (e.key.toLowerCase() === 'k') {
            e.preventDefault();
            if (!dialog) open();
            return;
        }
        if (dialog || !/^[0-9]$/.test(e.key)) return;
        const command = opts.commands().find((c) => c.digit === e.key);
        if (!command) return;
        e.preventDefault();
        command.run();
    };
    window.addEventListener('keydown', onKey, true);

    return {
        open,
        dispose: () => {
            window.removeEventListener('keydown', onKey, true);
            dialog?.destroy();
            dialog = null;
        },
    };
}
