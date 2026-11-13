import { Dialog, TextArea, TextField, injectStyles } from '../../../src/ui';
import { MAX_TAGS, normalizeTags } from '../../../shared/journal.js';
import { SETTINGS_CSS, SETTINGS_STYLE_ID, button, note, row, section } from '../trading/settingsChrome';

/** What the person wrote about a session before filing it. */
export interface JournalEntry {
    note: string;
    tags: string[];
}

/** Characters in a run's note — the store cuts it here too. */
export const MAX_NOTE = 2000;

/**
 * The last question before a session becomes a run: what happened, and what to file it under.
 *
 * Both are optional and neither blocks the save — a session worth keeping is worth keeping
 * without a sentence about it — but this is the moment the thing is freshest, and a note written
 * later, in the library, is one that mostly does not get written. Resolves with the entry, or
 * null when the dialog was dismissed, in which case nothing is filed and the session carries on.
 */
export function askJournalEntry(
    host: HTMLElement,
    opts: { session: string; snapshots: number; initial?: JournalEntry },
): Promise<JournalEntry | null> {
    const doc = host.ownerDocument;
    injectStyles(SETTINGS_STYLE_ID, SETTINGS_CSS, doc);

    return new Promise<JournalEntry | null>((resolve) => {
        let settled = false;
        const finish = (entry: JournalEntry | null): void => {
            if (settled) return;
            settled = true;
            dialog.hide();
            resolve(entry);
        };

        const text = new TextArea({ rows: 5, placeholder: 'What did you see, and what would you do differently?' });
        text.input.maxLength = MAX_NOTE;
        text.input.value = opts.initial?.note ?? '';
        const tags = new TextField({ value: (opts.initial?.tags ?? []).join(', ') });
        tags.input.placeholder = 'breakout, news, revenge — separated by commas';

        const save = button('Save as run', doc, true);
        save.onclick = () => finish({ note: text.input.value.trim(), tags: normalizeTags(tags.input.value) });

        const dialog = new Dialog({
            title: 'Save this session as a run',
            eyebrow: opts.session,
            host,
            draggable: true,
            align: 'center',
            closeOnInteractOutside: false,
            onOpenChange: (open) => { if (!open) finish(null); },
            content: (body) => {
                body.append(
                    section('Journal', doc),
                    note(
                        'It is filed in the library with the trades, and can be read and changed there later. '
                        + (opts.snapshots > 0
                            ? `The ${opts.snapshots} ${opts.snapshots === 1 ? 'snapshot' : 'snapshots'} taken during the session go with it.`
                            : 'Take snapshots of the chart while you play, and they are filed with it.'),
                        doc,
                    ),
                    text.el,
                    row('Tags', tags.el, doc),
                    note(`Up to ${MAX_TAGS} tags — they are what the library can be filtered by.`, doc),
                );
            },
            footer: (el) => {
                const cancel = button('Keep playing', doc);
                cancel.onclick = () => finish(null);
                el.append(cancel, save);
            },
        });
        dialog.show();
        text.input.focus();
    });
}
