import type { DataProvider, ProviderInfo, SymbolDescriptor } from '../../../src/plugin';

/**
 * The assets a bot can be pointed at.
 *
 * A bot needs a live feed, so only a provider that streams counts — the local archive can be
 * backtested and never traded — and one that cannot list its markets cannot be picked from.
 *
 * Every asset carries the provider it came from. That is what makes the value picked read
 * `capital:BTCUSD`: a bare ticker could mean the same name on another venue, and the bot
 * resolves its feed from the part before the colon.
 */
export interface AssetPool {
    symbols: SymbolDescriptor[];
    providers: ProviderInfo[];
    /** Providers that should have listed assets and did not, and why. Reported, not hidden —
     *  a provider missing from the list reads as "that venue has nothing", which is untrue
     *  when its credentials are what is missing. */
    failures: Array<{ provider: string; message: string }>;
}

/** Ask every provider that can be traded for its assets. One failing never hides the rest. */
export async function loadAssetPool(factories: Record<string, () => DataProvider>): Promise<AssetPool> {
    const pool: AssetPool = { symbols: [], providers: [], failures: [] };

    const asked = Object.entries(factories).flatMap(([name, make]) => {
        try {
            const provider = make();
            if (typeof provider.subscribe !== 'function' || typeof provider.listSymbols !== 'function') return [];
            return [{ name, provider, listed: Promise.resolve().then(() => provider.listSymbols!()) }];
        } catch (error) {
            pool.failures.push({ provider: name, message: error instanceof Error ? error.message : String(error) });
            return [];
        }
    });
    const answers = await Promise.allSettled(asked.map((entry) => entry.listed));

    asked.forEach(({ name, provider }, i) => {
        const answer = answers[i]!;
        if (answer.status === 'rejected') {
            const reason = answer.reason;
            pool.failures.push({ provider: name, message: reason instanceof Error ? reason.message : String(reason) });
            return;
        }
        if (answer.value.length === 0) {
            pool.failures.push({ provider: name, message: `${name} listed no assets.` });
            return;
        }
        for (const symbol of answer.value) pool.symbols.push({ ...symbol, provider: name });
        pool.providers.push({
            ...(provider.info?.() ?? { capabilities: { enumerate: true, stream: true, symbolInfo: false } }),
            // The registration key, whatever the provider calls itself: it is what the
            // symbol's `provider:` prefix is resolved against.
            name,
        });
    });
    return pool;
}
