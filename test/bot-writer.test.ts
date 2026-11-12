import { afterEach, describe, expect, it, vi } from 'vitest';
import { botAccountWriter } from '../app/renderer/bot/botAccountStore';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('durable bot writes', () => {
    it('rejects a flush when the account could not be saved, then permits a retry', async () => {
        vi.useFakeTimers();
        const save = vi.fn().mockRejectedValueOnce(new Error('disk full')).mockResolvedValue({ savedAt: 1 });
        vi.stubGlobal('window', { midori: { bots: { account: { save } } } });
        const writer = botAccountWriter();
        writer.schedule('bot_1', { symbol: 'fake:TEST', session: {} });
        await expect(writer.flush()).rejects.toThrow('disk full');
        writer.schedule('bot_1', { symbol: 'fake:TEST', session: { restored: true } });
        await expect(writer.flush()).resolves.toBeUndefined();
        expect(save).toHaveBeenCalledTimes(2);
    });
});

describe('a write that lands', () => {
    it('is reported, so a block left by an earlier failure can be lifted', async () => {
        let failing = true;
        (globalThis as { window?: unknown }).window = {
            midori: { bots: { account: { save: () => (failing ? Promise.reject(new Error('disk full')) : Promise.resolve({ savedAt: 1 })) } } },
        };
        const failed = vi.fn();
        const saved = vi.fn();
        const writer = botAccountWriter(failed, saved);
        const snapshot = { symbol: 'fake:TEST', guards: { dayKey: '2026-09-09', dayOpenEquity: 1, tradesToday: 0, lastLossAt: null } };

        writer.schedule('bot_a', snapshot);
        await expect(writer.flush()).rejects.toThrow(/disk full/);
        expect(failed).toHaveBeenCalledTimes(1);
        expect(saved).not.toHaveBeenCalled();

        failing = false;
        writer.schedule('bot_a', snapshot);
        await writer.flush();
        expect(saved).toHaveBeenCalledTimes(1);
        delete (globalThis as { window?: unknown }).window;
    });
});
