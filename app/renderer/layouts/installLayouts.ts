import { registerWidgetAction, type WidgetContext } from '../../../src/plugin';
import { Menu, type MenuItemDescriptor } from '../../../src/ui';
import type { VelaWorkspace } from '../../../src/workspace';
import { askConfirm } from '../shell/askConfirm';
import { askName } from '../shell/askName';
import { appEntries, withoutApp } from '../shell/sharedChartDoc';
import { forApplying, forSaving, NAME_MAX_LENGTH, type SavedLayout } from './layoutModel';
import { LayoutStore } from './layoutStore';

export interface Layouts {
    store: LayoutStore;
    /** Ask for a name, then save the chart tab as it is now under it. */
    saveAs(host: HTMLElement): Promise<void>;
    load(id: string): void;
}

/**
 * Wires the named layouts: a Layouts button in the chart's top bar listing what is saved,
 * with a trash button on each row. A layout is the whole Chart tab: the grid, every chart's
 * market and timeframe, its indicators and its drawings.
 */
export function installLayouts(
    workspace: VelaWorkspace,
    enabledFor: (ctx: WidgetContext) => boolean,
): Layouts {
    const store = new LayoutStore();

    const report = (err: unknown): void => workspace.toast(err instanceof Error ? err.message : String(err), 'error');

    const load = (id: string): void => {
        const layout = store.find(id);
        if (!layout) return;
        try {
            workspace.applyState(forApplying(layout.state, workspace.getState(), appEntries));
            workspace.toast(`Layout "${layout.name}" loaded`, 'success');
        } catch (err) {
            report(err);
        }
    };

    const saveAs = async (host: HTMLElement): Promise<void> => {
        const name = await askName(host, 'Save layout', '', NAME_MAX_LENGTH);
        if (!name) return;
        try {
            const { saved, replaced } = store.save(name, forSaving(workspace.getState(), withoutApp));
            workspace.toast(replaced ? `Layout "${saved.name}" updated` : `Layout "${saved.name}" saved`, 'success');
        } catch (err) {
            report(err);
        }
    };

    const remove = async (host: HTMLElement, layout: SavedLayout): Promise<void> => {
        const yes = await askConfirm(host, 'Delete layout', `Delete the layout "${layout.name}"? This cannot be undone.`, 'Delete');
        if (!yes) return;
        try {
            store.remove(layout.id);
            workspace.toast(`Layout "${layout.name}" deleted`, 'info');
        } catch (err) {
            report(err);
        }
    };

    const open = (ctx: WidgetContext): void => {
        const rows: MenuItemDescriptor[] = store.layouts.length > 0
            ? store.layouts.map((l) => ({
                id: `load:${l.id}`,
                label: l.name,
                trailing: { icon: 'trash', label: `Delete ${l.name}` },
            }))
            : [{ id: 'none', label: 'No saved layouts yet', disabled: true }];
        const menu = new Menu({
            host: ctx.host,
            items: [...rows, { id: 'save', label: 'Save current layout…', icon: 'plus', separatorBefore: true }],
            placement: 'bottom-end',
            onOpenChange: (isOpen) => { if (!isOpen) setTimeout(() => menu.destroy(), 0); },
            onSelect: (id) => {
                if (id === 'save') void saveAs(ctx.host);
                else if (id.startsWith('load:')) load(id.slice(5));
            },
            onTrailing: (id) => {
                const layout = store.find(id.slice(5));
                if (layout) void remove(ctx.host, layout);
            },
        });
        const rect = ctx.trigger?.getBoundingClientRect();
        if (rect) menu.openAt(rect.right, rect.bottom + 4);
        else menu.openAt(ctx.host.getBoundingClientRect().right - 8, 48);
    };

    registerWidgetAction({
        id: 'midorii.layouts',
        target: 'topbar',
        align: 'right',
        order: 23,
        iconOnly: true,
        label: 'Layouts',
        icon: 'midorii-layouts',
        when: (ctx) => enabledFor(ctx),
        run: open,
    });

    return { store, saveAs, load };
}
