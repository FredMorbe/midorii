// A bot's runtime write must survive the target file being held open for a moment, which is
// what a scanner or an indexer does on Windows, and must still fail on a disk that cannot be
// written. See app/electron/data/store/botAccountStore.js.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const failing = vi.hoisted(() => ({ left: 0, code: 'EPERM' }));

vi.mock('node:fs/promises', async (importOriginal) => {
    const real = await importOriginal();
    const rename = async (...args) => {
        if (failing.left > 0) {
            failing.left -= 1;
            throw Object.assign(new Error('the file is held open'), { code: failing.code });
        }
        return real.rename(...args);
    };
    return { ...real, rename, default: { ...real, rename } };
});

const { mkdtemp, rm } = await import('node:fs/promises');
const { tmpdir } = await import('node:os');
const path = (await import('node:path')).default;
const { loadBotAccount, saveBotAccount } = await import('../app/electron/data/store/botAccountStore.js');

const snapshot = {
    symbol: 'fake:TEST',
    guards: { dayKey: '2026-09-10', dayOpenEquity: 10_000, tradesToday: 1, lastLossAt: null },
};

describe('writing a bot runtime', () => {
    let dir;
    beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'midorii-bot-retry-')); });
    afterEach(async () => {
        failing.left = 0;
        await rm(dir, { recursive: true, force: true });
    });

    it('waits out a target that is briefly held open', async () => {
        failing.left = 2;
        failing.code = 'EPERM';
        await saveBotAccount(dir, 'bot_a', snapshot);
        expect(failing.left).toBe(0);
        expect(await loadBotAccount(dir, 'bot_a')).toMatchObject({ guards: { tradesToday: 1 } });
    });

    it('gives up on a target that stays held', async () => {
        failing.left = 50;
        failing.code = 'EBUSY';
        await expect(saveBotAccount(dir, 'bot_a', snapshot)).rejects.toThrow(/held open/);
    });

    it('does not retry a failure that waiting cannot cure', async () => {
        failing.left = 1;
        failing.code = 'ENOSPC';
        await expect(saveBotAccount(dir, 'bot_a', snapshot)).rejects.toThrow(/held open/);
        expect(failing.left).toBe(0);
    });
});
