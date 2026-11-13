import { describe, expect, it } from 'vitest';
import { rankEntries, type PaletteEntry } from '../app/renderer/shell/paletteModel';

const e = (title: string, extra: Partial<PaletteEntry> = {}): PaletteEntry => ({ id: title, title, group: 'Go to', ...extra });
const titles = (list: PaletteEntry[]): string[] => list.map((x) => x.title);

describe('rankEntries', () => {
    const all = [e('Chart'), e('Replay'), e('Backtest'), e('Trading Bot'), e('Watchlist'), e('Settings')];

    it('keeps the given order for an empty query', () => {
        expect(titles(rankEntries(all, ''))).toEqual(titles(all));
        expect(titles(rankEntries(all, '   '))).toEqual(titles(all));
    });

    it('ranks an exact title above a prefix above a substring', () => {
        const list = [e('Bot settings'), e('Settings'), e('My settings page')];
        expect(titles(rankEntries(list, 'settings'))).toEqual(['Settings', 'Bot settings', 'My settings page']);
    });

    it('finds letters in order and drops what does not match', () => {
        expect(titles(rankEntries(all, 'wl'))).toEqual(['Watchlist']);
        expect(rankEntries(all, 'zzz')).toEqual([]);
    });

    it('requires every word, across title, hint and keywords', () => {
        const list = [e('BTCUSDT', { hint: 'binance' }), e('BTCUSD', { hint: 'capital', keywords: 'bitcoin' })];
        expect(titles(rankEntries(list, 'btc binance'))).toEqual(['BTCUSDT']);
        expect(titles(rankEntries(list, 'bitcoin'))).toEqual(['BTCUSD']);
    });

    it('ranks a word start above a mid-word hit', () => {
        const list = [e('Backtest'), e('Strategy test')];
        expect(titles(rankEntries(list, 'test'))).toEqual(['Strategy test', 'Backtest']);
    });

    it('does not change the input', () => {
        const copy = [...all];
        rankEntries(all, 'e');
        expect(all).toEqual(copy);
    });
});
