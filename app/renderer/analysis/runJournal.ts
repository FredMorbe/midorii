import { injectStyles } from '../../../src/ui';
import { MAX_SHOTS, MAX_TAGS, normalizeTags } from '../../../shared/journal.js';
import type { MidoriRunShot } from '../midori';
import { formatWhen } from '../format';
import { button } from '../runs/runViews';
import { fileBytes, imageObjectUrl, readableError } from '../journal/images';
import { MAX_NOTE } from '../journal/journalEntryDialog';

/**
 * A run's journal: what was thought about it, what to find it by, and what the chart looked like.
 *
 * Written in place — a note is kept when the box is left, a tag when it is typed, an image when it
 * is picked or pasted — because a journal that needs a Save button is one that is written less
 * often. Each change goes to the store on its own and the panel says what the store answered, so
 * what is on screen is what is on disk, not what was typed.
 */

const STYLE_ID = 'midorii-run-journal';
const CSS = `
.midorii-journal { display: flex; flex-direction: column; gap: 14px; padding: 2px 14px 14px; min-width: 0; outline: none; }
.midorii-journal h3 { margin: 0 0 6px; font-size: 11px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--vela-fg-muted); }
.midorii-journal-note {
    width: 100%; box-sizing: border-box; min-height: 96px; resize: vertical; padding: 8px 10px;
    background: var(--vela-surface-overlay); color: var(--vela-fg); border: 1px solid var(--vela-border-soft);
    border-radius: var(--vela-control-radius); font: inherit; line-height: 1.5; outline: none;
}
.midorii-journal-note:focus-visible, .midorii-journal-tag-input:focus-visible { border-color: var(--vela-accent-bright, #2962ff); }
.midorii-journal-tags { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.midorii-journal-tag {
    display: inline-flex; align-items: center; gap: 4px; padding: 2px 4px 2px 9px; border-radius: 999px;
    background: var(--vela-active); color: var(--vela-fg-bright); font-size: 12px;
}
.midorii-journal-tag button { all: unset; cursor: pointer; padding: 0 5px; color: var(--vela-fg-muted); border-radius: 999px; }
.midorii-journal-tag button:hover { color: var(--vela-danger); }
.midorii-journal-tag button:focus-visible { outline: 2px solid var(--vela-accent-bright, #2962ff); }
.midorii-journal-tag-input {
    min-width: 130px; padding: 3px 8px; background: var(--vela-surface-overlay); color: var(--vela-fg);
    border: 1px solid var(--vela-border-soft); border-radius: 999px; font: inherit; font-size: 12px; outline: none;
}
.midorii-journal-shots { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; }
.midorii-journal-shot {
    all: unset; box-sizing: border-box; display: block; cursor: pointer; border: 1px solid var(--vela-border-faint);
    border-radius: var(--vela-radius-sm); overflow: hidden; background: var(--vela-surface-overlay);
}
.midorii-journal-shot:hover { border-color: var(--vela-border-strong); }
.midorii-journal-shot:focus-visible { outline: 2px solid var(--vela-accent-bright, #2962ff); }
.midorii-journal-shot img { display: block; width: 100%; aspect-ratio: 16 / 10; object-fit: cover; }
.midorii-journal-shot span { display: block; padding: 3px 6px; font-size: 11px; color: var(--vela-fg-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.midorii-journal-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.midorii-journal-hint { color: var(--vela-fg-muted); font-size: 12px; }
.midorii-journal-status { min-height: 1.3em; font-size: 12px; color: var(--vela-fg-muted); }
.midorii-journal-status[data-error] { color: var(--vela-danger); }
.midorii-journal[data-drop] { box-shadow: inset 0 0 0 2px var(--vela-accent-bright, #2962ff); }
.midorii-journal-view {
    position: fixed; inset: 0; z-index: 1000; display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 10px; padding: 24px; background: rgba(0, 0, 0, .78);
}
.midorii-journal-view img { max-width: 100%; max-height: calc(100% - 60px); object-fit: contain; border-radius: var(--vela-radius-sm); }
.midorii-journal-view-bar { display: flex; align-items: center; gap: 10px; color: #fff; font-size: 13px; }
`;

/** What the panel hands up when a change has been stored, so a list that shows it can follow. */
export interface JournalPatch {
    note?: string;
    tags?: string[];
    shots?: number;
}

export interface RunJournal {
    el: HTMLElement;
    dispose(): void;
}

export function mountRunJournal(
    doc: Document,
    run: { id: string; note: string; tags: string[]; shots: MidoriRunShot[] },
    onChange: (patch: JournalPatch) => void,
): RunJournal {
    injectStyles(STYLE_ID, CSS, doc);

    let note = run.note;
    let tags = [...run.tags];
    let shots = [...run.shots];
    const urls = new Map<string, string>();
    let overlay: HTMLElement | null = null;
    let disposed = false;

    const el = doc.createElement('div');
    el.className = 'midorii-journal';
    el.tabIndex = 0;

    const status = doc.createElement('div');
    status.className = 'midorii-journal-status';
    status.setAttribute('role', 'status');
    const say = (text: string, error = false): void => {
        status.textContent = text;
        if (error) status.dataset.error = '1';
        else delete status.dataset.error;
    };
    const failure = (what: string) => (err: unknown): void => {
        console.error(`[midorii] ${what}`, err);
        say(`${what}: ${readableError(err)}`, true);
    };

    // ── the note ─────────────────────────────────────────────────────────

    const noteBox = doc.createElement('textarea');
    noteBox.className = 'midorii-journal-note';
    noteBox.maxLength = MAX_NOTE;
    noteBox.placeholder = 'What did you see, and what would you do differently?';
    noteBox.value = note;
    noteBox.onblur = () => {
        const next = noteBox.value.trim();
        if (next === note) return;
        void window.midori.runs.annotate(run.id, next)
            .then((stored) => {
                note = stored;
                onChange({ note: stored });
                say('Note saved.');
            })
            .catch(failure('The note could not be saved'));
    };
    const noteSection = doc.createElement('section');
    const noteHead = doc.createElement('h3');
    noteHead.textContent = 'Note';
    noteSection.append(noteHead, noteBox);

    // ── the tags ─────────────────────────────────────────────────────────

    const tagList = doc.createElement('div');
    tagList.className = 'midorii-journal-tags';
    const tagInput = doc.createElement('input');
    tagInput.className = 'midorii-journal-tag-input';
    tagInput.placeholder = 'Add a tag';
    tagInput.setAttribute('aria-label', 'Add a tag');

    const storeTags = (next: string[]): void => {
        void window.midori.runs.setTags(run.id, next)
            .then((stored) => {
                tags = stored;
                paintTags();
                onChange({ tags: stored });
                say('');
            })
            .catch(failure('The tags could not be saved'));
    };

    function paintTags(): void {
        const chips = tags.map((tag) => {
            const chip = doc.createElement('span');
            chip.className = 'midorii-journal-tag';
            chip.append(tag);
            const remove = doc.createElement('button');
            remove.type = 'button';
            remove.textContent = '×';
            remove.title = `Remove “${tag}”`;
            remove.setAttribute('aria-label', `Remove tag ${tag}`);
            remove.onclick = () => storeTags(tags.filter((t) => t !== tag));
            chip.appendChild(remove);
            return chip;
        });
        tagList.replaceChildren(...chips, tagInput);
        tagInput.hidden = tags.length >= MAX_TAGS;
    }
    const addTag = (): void => {
        const typed = tagInput.value;
        if (typed.trim() === '') return;
        tagInput.value = '';
        storeTags(normalizeTags([...tags, ...typed.split(',')]));
    };
    tagInput.onkeydown = (e) => {
        if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            addTag();
        } else if (e.key === 'Backspace' && tagInput.value === '' && tags.length > 0) {
            storeTags(tags.slice(0, -1));
        }
    };
    tagInput.onblur = addTag;
    const tagSection = doc.createElement('section');
    const tagHead = doc.createElement('h3');
    tagHead.textContent = 'Tags';
    tagSection.append(tagHead, tagList);
    paintTags();

    // ── the images ───────────────────────────────────────────────────────

    const grid = doc.createElement('div');
    grid.className = 'midorii-journal-shots';
    const picker = doc.createElement('input');
    picker.type = 'file';
    picker.accept = 'image/png,image/jpeg';
    picker.multiple = true;
    picker.hidden = true;
    const add = button('Add image…');
    add.onclick = () => picker.click();
    const hint = doc.createElement('span');
    hint.className = 'midorii-journal-hint';
    hint.textContent = 'PNG or JPEG — pick a file, drop one here, or paste with this panel focused.';

    const urlOf = async (shot: MidoriRunShot): Promise<string> => {
        const known = urls.get(shot.id);
        if (known) return known;
        const url = imageObjectUrl(await window.midori.runs.shot(run.id, shot.id));
        if (disposed) {
            URL.revokeObjectURL(url);
            throw new Error('closed');
        }
        urls.set(shot.id, url);
        return url;
    };

    function closeView(): void {
        overlay?.remove();
        overlay = null;
    }

    function openView(shot: MidoriRunShot): void {
        closeView();
        const view = doc.createElement('div');
        view.className = 'midorii-journal-view';
        view.setAttribute('role', 'dialog');
        view.setAttribute('aria-label', 'Journal image');
        const img = doc.createElement('img');
        img.alt = shot.label || 'Journal image';
        void urlOf(shot).then((url) => { img.src = url; }).catch(failure('The image could not be read'));
        const bar = doc.createElement('div');
        bar.className = 'midorii-journal-view-bar';
        const caption = doc.createElement('span');
        caption.textContent = `${shot.label || 'Image'} · ${formatWhen(shot.takenAt)} UTC`;
        const remove = button('Remove', 'danger');
        remove.onclick = () => {
            if (remove.dataset.armed !== '1') {
                remove.dataset.armed = '1';
                remove.textContent = 'Remove — click again';
                return;
            }
            void window.midori.runs.removeShot(run.id, shot.id)
                .then(() => {
                    shots = shots.filter((s) => s.id !== shot.id);
                    const url = urls.get(shot.id);
                    if (url) URL.revokeObjectURL(url);
                    urls.delete(shot.id);
                    closeView();
                    paintShots();
                    onChange({ shots: shots.length });
                })
                .catch(failure('The image could not be removed'));
        };
        const close = button('Close', 'primary');
        close.onclick = closeView;
        bar.append(caption, remove, close);
        view.append(img, bar);
        view.onclick = (e) => { if (e.target === view) closeView(); };
        view.onkeydown = (e) => { if (e.key === 'Escape') closeView(); };
        view.tabIndex = -1;
        doc.body.appendChild(view);
        overlay = view;
        view.focus();
    }

    function paintShots(): void {
        grid.replaceChildren(...shots.map((shot) => {
            const tile = doc.createElement('button');
            tile.type = 'button';
            tile.className = 'midorii-journal-shot';
            tile.setAttribute('aria-label', `Open image: ${shot.label || formatWhen(shot.takenAt)}`);
            const img = doc.createElement('img');
            img.alt = '';
            void urlOf(shot).then((url) => { img.src = url; }).catch((err: unknown) => {
                if (!disposed) failure('An image could not be read')(err);
            });
            const caption = doc.createElement('span');
            caption.textContent = shot.label || formatWhen(shot.takenAt);
            tile.append(img, caption);
            tile.onclick = () => openView(shot);
            return tile;
        }));
        add.disabled = shots.length >= MAX_SHOTS;
        add.title = add.disabled ? `A run keeps up to ${MAX_SHOTS} images.` : '';
    }

    async function attach(files: readonly Blob[]): Promise<void> {
        for (const file of files) {
            try {
                const shot = await window.midori.runs.addShot(run.id, { data: await fileBytes(file), takenAt: Date.now() });
                if (disposed) return;
                shots = [...shots, shot];
                paintShots();
                onChange({ shots: shots.length });
                say('Image added.');
            } catch (err: unknown) {
                if (!disposed) failure('The image could not be added')(err);
                return; // the next would hit the same wall — the first refusal is the useful one
            }
        }
    }

    picker.onchange = () => {
        const files = [...(picker.files ?? [])];
        picker.value = '';
        void attach(files);
    };
    const isImage = (f: Blob): boolean => f.type === 'image/png' || f.type === 'image/jpeg';
    el.ondragover = (e) => {
        if (![...(e.dataTransfer?.items ?? [])].some((i) => i.kind === 'file')) return;
        e.preventDefault();
        el.dataset.drop = '1';
    };
    el.ondragleave = () => { delete el.dataset.drop; };
    el.ondrop = (e) => {
        delete el.dataset.drop;
        const files = [...(e.dataTransfer?.files ?? [])];
        if (files.length === 0) return;
        e.preventDefault();
        const images = files.filter(isImage);
        if (images.length < files.length) say('Only PNG and JPEG images can be added.', true);
        if (images.length > 0) void attach(images);
    };
    /* On the document, not the panel: a paste lands on whatever has the focus, and the point is
     * that nobody has to aim. Only a clipboard that carries an image is taken — text pasted into
     * the note box is left exactly as it is. */
    const onPaste = (e: ClipboardEvent): void => {
        if (!el.isConnected || !el.contains(doc.activeElement)) return;
        const images = [...(e.clipboardData?.files ?? [])].filter(isImage);
        if (images.length === 0) return;
        e.preventDefault();
        void attach(images);
    };
    doc.addEventListener('paste', onPaste);

    const shotSection = doc.createElement('section');
    const shotHead = doc.createElement('h3');
    shotHead.textContent = `Images`;
    const shotRow = doc.createElement('div');
    shotRow.className = 'midorii-journal-row';
    shotRow.append(add, hint, picker);
    shotSection.append(shotHead, shotRow, grid);
    paintShots();

    el.append(noteSection, tagSection, shotSection, status);

    return {
        el,
        dispose() {
            disposed = true;
            doc.removeEventListener('paste', onPaste);
            closeView();
            for (const url of urls.values()) URL.revokeObjectURL(url);
            urls.clear();
        },
    };
}
