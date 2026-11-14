// The PANEL DOCK — the one owner of the shell's side-panel column. It holds the shell's own
// panels (object tree, data window) and every contributed one (`registerSidePanel`) as equal
// entries, enforces the single-open rule among the panels that keep it, projects the toggle
// buttons into the chrome, and carries the dock's persistable state (which panels are open, the
// widths the user dragged).
//
// Both shells drive the same dock, so the exclusivity rule and the button wiring exist ONCE.
// The chrome is reached through {@link PanelChrome} (the topbar implements it structurally) —
// the dock never imports the topbar, and a different chrome can host the same buttons.
import type { Vela } from '../Vela';
import type { PanelsState } from '../state/document';
import { DEFAULT_PANEL_ORDER, sidePanels, type SidePanelButton, type SidePanelHandle, type WidgetContext } from './contributions';
import { SidePanel } from './side-panel';

/** What the dock needs from whatever chrome shows its toggles. */
export interface PanelChrome {
    /** Replace the panel toggle group (dock order). `onClick` receives the panel id. */
    setPanelButtons(buttons: readonly SidePanelButton[], onClick: (id: string) => void): void;
    /** Reflect one panel's open state on its button. */
    setPanelActive(id: string, open: boolean): void;
}

export interface PanelDockDeps {
    chrome: PanelChrome;
    /** Live widget context, handed to contributed panels' `mount`. */
    context(): WidgetContext;
    /** The dock's persistable state changed (open panel, or a width). */
    changed?(): void;
}

/** A panel the SHELL owns and destroys — the dock only docks it. */
export interface BuiltInPanel {
    id: string;
    title: string;
    icon: string;
    order: number;
    panel: SidePanel;
    /** Default true; see `SidePanelDescriptor.exclusive`. */
    exclusive?: boolean;
    /** Rebind hook, called by {@link PanelDock.onChart}. */
    onChart?(chart: Vela): void;
}

interface Entry {
    id: string;
    title: string;
    icon: string;
    order: number;
    panel: SidePanel;
    /** Whether it takes part in the single-open rule. */
    exclusive: boolean;
    onChart?: (chart: Vela) => void;
    /** Contributed entries are created (and destroyed) by the dock; built-ins by the shell. */
    contributed: boolean;
    handle?: SidePanelHandle;
}

export class PanelDock {
    private readonly entries: Entry[] = [];
    /** Widths the USER settled, by panel id — the only ones worth persisting. */
    private readonly widths = new Map<string, number>();
    /** Floating panels the USER pinned as columns, by id — remembered for late registrations too. */
    private pinned = new Set<string>();
    /** Restored `open` ids naming panels that have not registered yet: honored when they dock. */
    private readonly pendingOpen = new Set<string>();
    private chart: Vela | null = null;

    constructor(
        private readonly host: HTMLElement,
        private readonly deps: PanelDockDeps,
    ) {}

    /** Dock a panel the shell owns (created and destroyed by it). */
    addBuiltIn(entry: BuiltInPanel): void {
        this.add({ ...entry, exclusive: entry.exclusive !== false, contributed: false });
    }

    /**
     * (Re)build the CONTRIBUTED panels from the registry — call once after the built-ins, and
     * again on `refreshActions()` so a late registration appears. Contributed panels that are
     * gone from the registry are dropped; the ones still there are rebuilt, so a replaced
     * descriptor takes effect.
     */
    refresh(): void {
        // A rebuild must not close the column under the user: a contributed panel that is open
        // (and still registered) is reopened once its replacement is docked.
        const openBefore = this.openIds;
        for (const entry of [...this.entries]) if (entry.contributed) this.drop(entry);
        for (const desc of sidePanels()) {
            const panel = new SidePanel(this.host, desc.title, `vela-panel-${desc.id}`, {
                width: desc.width,
                resizable: desc.resizable,
                minWidth: desc.minWidth,
                maxWidth: desc.maxWidth,
                overlay: desc.overlay,
            });
            const entry: Entry = {
                id: desc.id,
                title: desc.title,
                icon: desc.icon,
                order: desc.order ?? DEFAULT_PANEL_ORDER,
                panel,
                exclusive: desc.exclusive !== false,
                contributed: true,
            };
            // A contribution that throws on mount must not take the shell down with it: the
            // panel stays docked but empty, and the reason is on the console.
            try {
                entry.handle = desc.mount(this.deps.context(), panel.content, { slot: panel.headerSlot, setTitle: (t) => panel.setTitle(t) }) ?? undefined;
                if (this.chart) entry.handle?.onChart?.(this.chart);
            } catch (err) {
                console.warn(`[vela] side panel "${desc.id}" failed to mount`, err);
            }
            this.add(entry);
        }
        for (const id of openBefore) if (!this.openIds.includes(id)) this.toggle(id, true);
        this.publish();
    }

    /** Bind (or rebind) every docked panel to a chart instance. */
    onChart(chart: Vela): void {
        this.chart = chart;
        for (const entry of this.entries) {
            if (entry.onChart) entry.onChart(chart);
            entry.handle?.onChart?.(chart);
        }
    }

    /** Open/close one panel by id — a bare call flips it. Unknown ids are ignored. */
    toggle(id: string, open?: boolean): void {
        this.entries.find((e) => e.id === id)?.panel.toggle(open);
    }

    /** The first open panel's id, or null when the column is closed. */
    get openId(): string | null {
        return this.entries.find((e) => e.panel.open)?.id ?? null;
    }

    /** Every open panel's id, in dock order. */
    get openIds(): string[] {
        return this.entries.filter((e) => e.panel.open).map((e) => e.id);
    }

    /** The docked panels in dock order — what a non-topbar chrome (the mobile
     *  three-dots drawer) lists so every panel stays reachable there too. */
    list(): ReadonlyArray<SidePanelButton> {
        return this.entries.map((e) => ({ id: e.id, title: e.title, icon: e.icon }));
    }

    /** The dock's persistable state, or null when there is nothing worth saving. */
    getState(): PanelsState | null {
        const out: PanelsState = {};
        const [open, ...also] = this.openIds;
        if (open) out.open = open;
        if (also.length > 0) out.alsoOpen = also;
        if (this.widths.size > 0) out.widths = Object.fromEntries(this.widths);
        if (this.pinned.size > 0) out.pinned = [...this.pinned];
        return out.open || out.widths || out.pinned ? out : null;
    }

    /**
     * Restore a persisted dock state. Widths apply to any panel present, and are remembered for
     * panels that register later; `open` and `alsoOpen` open those panels, and their absence closes the column —
     * a document that predates the dock has no `panels` field at all, so the shell never calls
     * this and the default (everything closed) stands. An `open` naming a panel that has not
     * registered yet is held until it docks (a plugin loaded after the restore), unless the user
     * opens something in the meantime. `pinned` is the whole list of floating panels the user
     * docked — its absence means none is, so every floatable panel floats again.
     */
    applyState(state: PanelsState | undefined): void {
        if (!state) return;
        if (state.widths) {
            for (const [id, px] of Object.entries(state.widths)) {
                this.widths.set(id, px);
                this.entries.find((e) => e.id === id)?.panel.setWidth(px);
            }
        }
        this.pinned = new Set(state.pinned ?? []);
        for (const entry of this.entries) entry.panel.setOverlay(!this.pinned.has(entry.id));
        const wanted = new Set([...(state.open ? [state.open] : []), ...(state.alsoOpen ?? [])]);
        for (const entry of this.entries) if (!wanted.has(entry.id)) entry.panel.toggle(false);
        for (const entry of this.entries) if (wanted.has(entry.id)) entry.panel.toggle(true);
        this.pendingOpen.clear();
        for (const id of wanted) if (!this.entries.some((e) => e.id === id)) this.pendingOpen.add(id);
    }

    /** Drop the contributed panels (the shell destroys its own). */
    destroy(): void {
        for (const entry of [...this.entries]) if (entry.contributed) this.drop(entry);
        this.entries.length = 0;
    }

    private add(entry: Entry): void {
        this.entries.push(entry);
        this.entries.sort((a, b) => a.order - b.order);
        const stored = this.widths.get(entry.id);
        if (stored !== undefined) entry.panel.setWidth(stored);
        if (this.pinned.has(entry.id)) entry.panel.setOverlay(false);
        entry.panel.onOpenChange = (open) => {
            if (open) {
                if (entry.exclusive) {
                    for (const other of this.entries) if (other !== entry && other.exclusive) other.panel.toggle(false);
                    this.pendingOpen.clear(); // the user chose a column; a stale restore must not steal it
                } else {
                    this.pendingOpen.delete(entry.id);
                }
            }
            this.deps.chrome.setPanelActive(entry.id, open);
            if (open) entry.handle?.onOpen?.();
            this.deps.changed?.();
        };
        entry.panel.onWidthChange = (px) => {
            this.widths.set(entry.id, px);
            this.deps.changed?.();
        };
        entry.panel.onPlacementChange = (overlay) => {
            if (overlay) this.pinned.delete(entry.id);
            else this.pinned.add(entry.id);
            this.deps.changed?.();
        };
        if (this.pendingOpen.has(entry.id)) entry.panel.toggle(true);
        if (!entry.contributed) this.publish();
    }

    private drop(entry: Entry): void {
        const i = this.entries.indexOf(entry);
        if (i >= 0) this.entries.splice(i, 1);
        try {
            entry.handle?.destroy?.();
        } catch (err) {
            console.warn(`[vela] side panel "${entry.id}" failed to release`, err);
        }
        entry.panel.destroy();
    }

    /** Push the current toggle group to the chrome, pressed states included. */
    private publish(): void {
        const buttons: SidePanelButton[] = this.entries.map((e) => ({ id: e.id, title: e.title, icon: e.icon }));
        this.deps.chrome.setPanelButtons(buttons, (id) => this.toggle(id));
        for (const entry of this.entries) this.deps.chrome.setPanelActive(entry.id, entry.panel.open);
    }
}
