import { describe, expect, it, vi } from 'vitest';

// The form module draws with the UI kit and the run views; the question under test is pure.
vi.mock('../src/ui', async (original) => ({
    ...await original<typeof import('../src/ui')>(),
    injectStyles: () => {},
}));
vi.mock('../app/renderer/runs/runViews', () => ({ button: () => ({}), sectionLabel: () => ({}), settingsGrid: () => ({}) }));

import { setupProblem } from '../app/renderer/bot/botForm';
import { newBot } from '../app/renderer/bot/botTypes';
import { strategyCatalog } from '../app/renderer/strategies';

const strategy = strategyCatalog().find((s) => !s.researchOnly)!.id;

describe('what keeps a bot from starting', () => {
    it('finds nothing wrong with a bot that has an asset', () => {
        expect(setupProblem(newBot(strategy, 'binance:BTCUSDT'))).toBeNull();
    });

    it('sends a bot with no asset to the market step, in the engine’s own words', () => {
        const problem = setupProblem(newBot(strategy, '  '));
        expect(problem?.section).toBe('market');
        expect(problem?.text).toContain('no asset');
    });

    it('sends a Capital.com bot on another venue’s asset to the market step', () => {
        const bot = { ...newBot(strategy, 'binance:BTCUSDT'), venue: 'capital' as const };
        expect(setupProblem(bot)?.section).toBe('market');
        expect(setupProblem({ ...bot, symbol: 'capital:EURUSD' })).toBeNull();
    });

    it('sends an unusable opening balance to the account step', () => {
        expect(setupProblem({ ...newBot(strategy, 'binance:BTCUSDT'), balance: 0 })?.section).toBe('account');
    });

    it('sends safety rules the schema cannot mean to the safety step', () => {
        const bot = { ...newBot(strategy, 'binance:BTCUSDT'), guards: { tradingDays: 'monday' } };
        expect(setupProblem(bot)?.section).toBe('safety');
    });

    it('sends everything else, such as an unknown strategy, to the strategy step', () => {
        expect(setupProblem(newBot('no_such_strategy', 'binance:BTCUSDT'))?.section).toBe('strategy');
    });
});
