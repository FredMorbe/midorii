import { injectStyles } from '../../../src/ui';

/**
 * The strip along the top of a screen: what it is, which part of it is open, and what can be
 * done about it from anywhere on it.
 *
 * One look for every screen that has one, so moving between tabs does not also mean learning a
 * new header each time. The screen fills the three slots; this only draws them.
 */

const STYLE_ID = 'midorii-screen-head';
const CSS = `
.midorii-screen-head {
    flex: none; display: flex; align-items: center; gap: 12px;
    min-height: 52px; padding: 8px 18px;
    border-bottom: 1px solid var(--vela-border);
}
.midorii-screen-title { flex: 1 1 auto; min-width: 0; }
.midorii-screen-title b {
    display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    color: var(--vela-fg-bright); font-size: 15px; font-weight: 650; letter-spacing: -.01em;
}
.midorii-screen-title span {
    display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    color: var(--vela-fg-muted); font-size: 12px;
}
.midorii-screen-tabs { display: inline-flex; gap: 2px; flex: none; }
.midorii-screen-tab {
    all: unset; box-sizing: border-box; padding: 5px 12px; border-radius: var(--vela-radius-sm);
    color: var(--vela-fg-muted); font-size: 12px; font-weight: 600; cursor: pointer; white-space: nowrap;
}
.midorii-screen-tab:hover { background: var(--vela-hover); color: var(--vela-fg-bright); }
.midorii-screen-tab[data-active='1'] { background: var(--vela-active); color: var(--vela-fg-bright); }
.midorii-screen-tab:disabled { opacity: .5; cursor: default; }
.midorii-screen-tab:focus-visible { outline: 2px solid var(--vela-accent-bright, #2962ff); outline-offset: 2px; }
.midorii-screen-actions { display: inline-flex; align-items: center; gap: 8px; flex: none; }
@media (max-width: 700px) {
    .midorii-screen-head { flex-wrap: wrap; padding-inline: 12px; }
    .midorii-screen-title { flex-basis: 100%; }
}
`;

export interface ScreenHead {
    el: HTMLElement;
    /** Replace the line under the title. */
    setSub(text: string): void;
    /** Mark which tab is on screen; null marks none. */
    setActive(tab: string | null): void;
    /** Switch every tab off or on, for a screen that is busy and cannot change view. */
    setTabsDisabled(disabled: boolean): void;
    /** Where the screen puts its buttons. */
    actions: HTMLElement;
}

/** Build the head. `tabs` may be empty for a screen that has one view. */
export function screenHead(
    doc: Document,
    opts: {
        title: string;
        sub?: string;
        tabs?: ReadonlyArray<{ id: string; label: string }>;
        onTab?: (id: string) => void;
    },
): ScreenHead {
    injectStyles(STYLE_ID, CSS, doc);
    const el = doc.createElement('div');
    el.className = 'midorii-screen-head';

    const heading = doc.createElement('div');
    heading.className = 'midorii-screen-title';
    const title = doc.createElement('b');
    title.textContent = opts.title;
    const sub = doc.createElement('span');
    sub.textContent = opts.sub ?? '';
    sub.hidden = !opts.sub;
    heading.append(title, sub);
    el.appendChild(heading);

    const buttons = new Map<string, HTMLButtonElement>();
    if (opts.tabs && opts.tabs.length > 0) {
        const tabs = doc.createElement('div');
        tabs.className = 'midorii-screen-tabs';
        for (const tab of opts.tabs) {
            const b = doc.createElement('button');
            b.type = 'button';
            b.className = 'midorii-screen-tab';
            b.textContent = tab.label;
            b.onclick = () => opts.onTab?.(tab.id);
            buttons.set(tab.id, b);
            tabs.appendChild(b);
        }
        el.appendChild(tabs);
    }

    const actions = doc.createElement('div');
    actions.className = 'midorii-screen-actions';
    el.appendChild(actions);

    return {
        el,
        actions,
        setSub(text) {
            sub.textContent = text;
            sub.hidden = text === '';
        },
        setTabsDisabled(disabled) {
            for (const b of buttons.values()) b.disabled = disabled;
        },
        setActive(tab) {
            for (const [id, b] of buttons) {
                if (id === tab) b.dataset.active = '1';
                else delete b.dataset.active;
            }
        },
    };
}
