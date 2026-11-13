// How a replay account is kept: what a point is worth, the grid a size sits on, whether an
// opposite order opens a position of its own — and that taking the session down leaves nothing
// moving.
//
// The engine's own rules are proved in broker tests. What is proved here is the part a session
// depends on: the setup's answers reach the account, survive a snapshot, and a futures contract
// is no longer booked as though it were a coin.
import { beforeEach, describe, expect, it } from 'vitest';

import { NO_COSTS, resetOrderIds } from '../shared/engine/broker.js';
import { ReplaySession } from '../shared/engine/replaySession.js';
import type { ReplayBar } from '../shared/engine/replaySession.js';
import { ReplayController } from '../app/renderer/replay/ReplayController';
import type { ReplayProvider } from '../app/renderer/replay/ReplayProvider';
import { SPOT_ACCOUNT, accountOptions, suggestAccount } from '../app/renderer/replay/instrument';

const MINUTE = 60_000;
const START = Date.UTC(2026, 8, 11, 13, 0);

/** Thirty one-minute bars that close one point higher each time, from 100. */
function rising(): ReplayBar[] {
    return Array.from({ length: 30 }, (_, i) => ({
        time: START + i * MINUTE,
        open: 100 + i,
        high: 100.5 + i,
        low: 99.5 + i,
        close: 100 + i,
        volume: 10,
    }));
}

class FakeProvider {
    retime(): void {}
    revealNext(): void {}
    revealForming(): void {}
}

function controllerFor(options: Partial<ConstructorParameters<typeof ReplayController>[0]> = {}): ReplayController {
    return new ReplayController({
        provider: new FakeProvider() as unknown as ReplayProvider,
        symbol: 'TEST',
        timeframe: '1',
        bars: rising(),
        startIndex: 0,
        balance: 10_000,
        costs: NO_COSTS,
        ...options,
    });
}

beforeEach(() => resetOrderIds());

describe('what a point is worth', () => {
    it('books a futures contract at its own value — four points on one contract is eighty, not four', () => {
        const future = controllerFor({ pointValue: 20 });
        future.buy({ size: 1 });
        future.skip(4);
        expect(future.equity() - 10_000).toBeCloseTo(80, 9);

        resetOrderIds();
        const coin = controllerFor();
        coin.buy({ size: 1 });
        coin.skip(4);
        expect(coin.equity() - 10_000).toBeCloseTo(4, 9);
    });

    it('tells the chart gestures and the ticket the same number the account books with', () => {
        expect(controllerFor({ pointValue: 20 }).pointValue()).toBe(20);
        expect(controllerFor().pointValue()).toBe(1);
    });

    it('keeps it through a snapshot — a session put down and picked up is the same instrument', () => {
        const controller = controllerFor({ pointValue: 20, sizeStep: 1, minSize: 1, mode: 'netting' });
        const restored = ReplaySession.restore(controller.session.snapshot(), { bars: rising() });
        expect(restored.broker.pointValue).toBe(20);
        expect(restored.broker.sizeStep).toBe(1);
        expect(restored.broker.minSize).toBe(1);
        expect(restored.broker.mode).toBe('netting');
    });
});

describe('the size grid', () => {
    it('rounds a size down onto the step and never up, and answers 0 under the minimum', () => {
        const contracts = controllerFor({ sizeStep: 1, minSize: 1 });
        expect(contracts.sizeOnGrid(2.7)).toBe(2);
        expect(contracts.sizeOnGrid(0.4)).toBe(0);
        expect(contracts.dealingRules()).toEqual({ sizeStep: 1, minSize: 1 });

        const coin = controllerFor();
        expect(coin.sizeOnGrid(2.7)).toBe(2.7);
        expect(coin.dealingRules()).toEqual({});
    });

    it('refuses a fraction of a contract instead of trading it', () => {
        const contracts = controllerFor({ sizeStep: 1, minSize: 1 });
        expect(() => contracts.buy({ size: 0.5 })).toThrow();
        expect(contracts.broker.positions).toHaveLength(0);
    });
});

describe('hedging', () => {
    it('is on by default: a sell after a buy holds both', () => {
        const controller = controllerFor();
        controller.buy({ size: 1 });
        controller.sell({ size: 1 });
        expect(controller.broker.mode).toBe('hedging');
        expect(controller.broker.positions).toHaveLength(2);
    });

    it('off means netting: the sell closes the buy', () => {
        const controller = controllerFor({ mode: 'netting' });
        controller.buy({ size: 1 });
        controller.sell({ size: 1 });
        expect(controller.broker.positions).toHaveLength(0);
    });
});

describe('the setup', () => {
    it('suggests a futures account only from what the recording states — never from a name', () => {
        expect(suggestAccount({ tickSize: 0.25, tickValue: 5 })).toEqual({
            costsOn: false, pointValue: 20, sizeStep: 1, minSize: 1, hedging: true,
        });
        expect(suggestAccount(null)).toEqual(SPOT_ACCOUNT);
        expect(suggestAccount({ tickSize: null, tickValue: 5 })).toEqual(SPOT_ACCOUNT);
        expect(suggestAccount({ tickSize: 0.25, tickValue: 0 })).toEqual(SPOT_ACCOUNT);
    });

    it('turns the form into what the controller is built with', () => {
        expect(accountOptions(SPOT_ACCOUNT)).toEqual({
            costs: undefined, pointValue: 1, sizeStep: null, minSize: null, mode: 'hedging',
        });
        const off = accountOptions({ costsOn: false, pointValue: 20, sizeStep: 1, minSize: 1, hedging: false });
        expect(off).toEqual({ costs: NO_COSTS, pointValue: 20, sizeStep: 1, minSize: 1, mode: 'netting' });
    });

    it('refuses values the engine would refuse, by name', () => {
        expect(() => accountOptions({ ...SPOT_ACCOUNT, pointValue: 0 })).toThrow(/point value/);
        expect(() => accountOptions({ ...SPOT_ACCOUNT, sizeStep: -1 })).toThrow(/size step/);
        expect(() => accountOptions({ ...SPOT_ACCOUNT, minSize: 0 })).toThrow(/minimum size/);
        expect(() => accountOptions({ ...SPOT_ACCOUNT, pointValue: Number.NaN })).toThrow(/point value/);
    });
});

describe('taking a session down', () => {
    it('stops playback and stops painting', () => {
        const controller = controllerFor();
        let paints = 0;
        controller.onAccountChange = () => { paints += 1; };

        controller.play();
        expect(controller.playing).toBe(true);

        controller.destroy();
        expect(controller.playing).toBe(false);
        expect(controller.isDisposed).toBe(true);

        // A step that was already queued lands after the chart is gone: it must not paint.
        const before = paints;
        controller.step();
        expect(paints).toBe(before);
    });
});
