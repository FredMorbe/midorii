import { SymbolPicker } from '../../../src/widget';
import type { DataProvider } from '../../../src/plugin';
import { loadAssetPool, type AssetPool } from './assetPool';

/**
 * The asset dropdown's list: the chart's own symbol search, opened on the bot screen.
 *
 * A search and not a plain list, because a venue offers thousands of assets. It is built here
 * on the bot screen's own element rather than borrowed from a chart's workspace: that chart
 * sits in a pane which is hidden whenever the settings are showing, and a dialog opened inside
 * a hidden element is a dialog nobody can see.
 *
 * The answer is `provider:TICKER`, picked from a list rather than typed — which is the point.
 * A mistyped ticker is only found out when the venue refuses it, at the moment the bot starts.
 */
export interface AssetPicker {
    /** Open the list. Resolves with the chosen asset, or null when it was dismissed or there
     *  was nothing to choose from. */
    choose(): Promise<string | null>;
}

export interface AssetPickerOptions {
    /** Where the dialog lives — an element that is on screen and carries the theme. */
    host: HTMLElement;
    providers: Record<string, () => DataProvider>;
    notify: (message: string, kind: 'info' | 'error') => void;
}

export function createAssetPicker(opts: AssetPickerOptions): AssetPicker {
    let pool: AssetPool | null = null;
    let picker: SymbolPicker | null = null;

    return {
        async choose(): Promise<string | null> {
            /* Asked again while the last answer was incomplete: credentials saved since, or a
             * venue that was only briefly unreachable, should not stay missing until restart. */
            if (!pool || pool.symbols.length === 0 || pool.failures.length > 0) {
                pool = await loadAssetPool(opts.providers);
            }
            const current = pool;

            if (current.failures.length > 0) {
                opts.notify(
                    `Some assets are not listed — ${current.failures.map((f) => `${f.provider}: ${f.message}`).join('; ')}`,
                    'error',
                );
            }
            if (current.symbols.length === 0) return null;

            if (!picker) {
                picker = new SymbolPicker({
                    host: opts.host,
                    title: 'Choose an asset',
                    eyebrow: 'Asset',
                    // Never reached: `choose` hands the answer back instead of calling this.
                    onSelect: () => undefined,
                });
            }
            picker.setSource(() => current.symbols);
            picker.setProviders(() => current.providers);
            return picker.choose({ providers: current.providers.map((p) => p.name) });
        },
    };
}
