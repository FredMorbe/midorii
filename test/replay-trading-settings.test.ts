import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
    DEFAULT_REPLAY_TRADING, loadReplayTrading, normalizeReplayTrading, saveReplayTrading,
} from '../app/renderer/replay/replayTradingSettings';

const previous = (globalThis as { localStorage?: unknown }).localStorage;
afterAll(() => { (globalThis as { localStorage?: unknown }).localStorage = previous; });
beforeEach(() => {
    const cells = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = {
        getItem: (k: string) => cells.get(k) ?? null,
        setItem: (k: string, v: string) => void cells.set(k, v),
    };
});

describe('how a replay is traded, as remembered', () => {
    it('is the defaults where nothing was stored', () => {
        expect(loadReplayTrading()).toEqual(DEFAULT_REPLAY_TRADING);
    });

    it('comes back as it was saved', () => {
        const next = { sizing: 'risk' as const, quickSizes: [2, 4], brackets: { on: true, unit: 'cash' as const, stop: 12.5, target: 30 } };
        saveReplayTrading(next);
        expect(loadReplayTrading()).toEqual(next);
    });

    it('puts back whatever it cannot read, field by field', () => {
        const out = normalizeReplayTrading({
            sizing: 'sideways',
            quickSizes: ['x', -3, 0],
            brackets: { on: 'yes', unit: 'furlongs', stop: 0, target: -5 },
        });
        expect(out.sizing).toBe('fixed');
        expect(out.quickSizes).toEqual(DEFAULT_REPLAY_TRADING.quickSizes);
        // A stop at the entry would close the trade the moment it opened.
        expect(out.brackets).toEqual({ on: false, unit: 'ticks', stop: 40, target: 80 });
    });

    it('cleans a stored size list the way the ticket does', () => {
        expect(normalizeReplayTrading({ quickSizes: [5, 1, 5, '3'] }).quickSizes).toEqual([1, 3, 5]);
    });

    it('survives garbage in storage', () => {
        (globalThis as { localStorage?: unknown }).localStorage = { getItem: () => '{ broken', setItem: () => {} };
        const original = console.error;
        console.error = () => {};
        try {
            expect(loadReplayTrading()).toEqual(DEFAULT_REPLAY_TRADING);
        } finally {
            console.error = original;
        }
    });
});
