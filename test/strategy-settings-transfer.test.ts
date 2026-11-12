import { describe, expect, it } from 'vitest';
import { strategySettingsSnapshot, storedStrategySettings, savedStrategyTimeframe } from '../app/renderer/strategies/settingsTransfer';
import { resolveStrategyParams } from '../app/renderer/strategies';

describe('backtest settings for bots', () => {
    it('copies resolved parameters and the tested timeframe without sharing editable arrays', () => {
        const params = resolveStrategyParams('silverbullet', { rrr: 3, riskValue: 0.5 });
        const snapshot = strategySettingsSnapshot('silverbullet', params, '15');
        params.rrr = 8;
        const saved = storedStrategySettings(snapshot);
        expect(saved.rrr).toBe(3);
        expect(saved.riskValue).toBe(0.5);
        expect(savedStrategyTimeframe(saved)).toBe('15');
        expect(resolveStrategyParams('silverbullet', saved)).toEqual(snapshot.params);
    });

    it('rejects invalid settings before they can be stored for a bot', () => {
        expect(() => strategySettingsSnapshot('silverbullet', { rrr: -1 }, '5')).toThrow();
        expect(savedStrategyTimeframe({ __timeframe: '0' })).toBeNull();
    });
});
