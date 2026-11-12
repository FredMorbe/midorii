import type { DataProvider } from '../../../src/plugin';
import type { PaperInstrument } from '../trading/PaperController';

const positive = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;

/** Resolve the contract rules before a bot can place a paper order. */
export async function paperInstrument(
    providerName: string,
    provider: DataProvider,
    ticker: string,
): Promise<PaperInstrument> {
    const info = await provider.getSymbolInfo?.(ticker);
    const dealing = info?.dealing as Record<string, unknown> | undefined;

    if (providerName === 'projectx') {
        const tickSize = positive(dealing?.tickSize);
        const tickValue = positive(dealing?.tickValue);
        const sizeStep = positive(dealing?.sizeStep);
        const minSize = positive(dealing?.minSize);
        if (!tickSize || !tickValue || !sizeStep || !minSize) {
            throw new Error(`ProjectX did not provide contract value and size rules for ${ticker}. The paper bot cannot price a trade safely.`);
        }
        return { pointValue: tickValue / tickSize, sizeStep, minSize };
    }

    return {
        pointValue: positive(dealing?.pointValue) ?? 1,
        sizeStep: positive(dealing?.sizeStep) ?? positive(dealing?.sizeIncrement),
        minSize: positive(dealing?.minSize),
    };
}
