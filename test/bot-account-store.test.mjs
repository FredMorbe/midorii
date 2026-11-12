// The bot runtime is a safety boundary: a missing file means a new bot, while a corrupt
// file may contain daily limits or venue ids that cannot safely be guessed. These tests
// exercise the real JSON store and its one supported migration.
// See app/electron/data/store/botAccountStore.js.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadBotAccount, saveBotAccount, sweepBotAccounts } from '../app/electron/data/store/botAccountStore.js';

const guards = {
    dayKey: '2026-09-10',
    dayOpenEquity: 9_950,
    tradesToday: 2,
    lastLossAt: 1_789_000_000_000,
};

const capital = {
    initialized: true,
    positionDealIds: ['position-1'],
    workingOrderDealIds: ['order-1'],
    uncertain: false,
};

describe('a bot runtime on disk', () => {
    let dir;
    beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'midorii-bot-runtime-')); });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

    it('returns null only when no runtime exists', async () => {
        expect(await loadBotAccount(dir, 'bot_missing')).toBeNull();
    });

    it('reads the previous paper-account format', async () => {
        await writeFile(path.join(dir, 'bot_legacy.json'), JSON.stringify({
            version: 1,
            symbol: 'fake:TEST',
            session: { broker: { trades: [] } },
            savedAt: 123,
        }));

        expect(await loadBotAccount(dir, 'bot_legacy')).toEqual({
            symbol: 'fake:TEST',
            session: { broker: { trades: [] } },
            savedAt: 123,
        });
    });

    it('round-trips a paper account with its daily guards', async () => {
        await saveBotAccount(dir, 'bot_paper', {
            symbol: 'fake:TEST',
            session: { broker: { trades: [] } },
            guards,
        });

        const stored = await loadBotAccount(dir, 'bot_paper');
        expect(stored).toMatchObject({
            symbol: 'fake:TEST',
            session: { broker: { trades: [] } },
            guards,
        });
        expect(stored.savedAt).toEqual(expect.any(Number));
    });

    it('round-trips live ownership without inventing a paper account', async () => {
        await saveBotAccount(dir, 'bot_live', {
            symbol: 'capital:EURUSD',
            guards,
            capital,
        });

        const stored = await loadBotAccount(dir, 'bot_live');
        expect(stored).toMatchObject({ symbol: 'capital:EURUSD', guards, capital });
        expect('session' in stored).toBe(false);
    });

    it('rejects malformed JSON instead of starting from empty state', async () => {
        await writeFile(path.join(dir, 'bot_broken.json'), '{"version":2,');
        await expect(loadBotAccount(dir, 'bot_broken')).rejects.toThrow(/unreadable/i);
    });

    it('rejects a future format instead of guessing at its safety fields', async () => {
        await writeFile(path.join(dir, 'bot_future.json'), JSON.stringify({
            version: 99,
            symbol: 'capital:EURUSD',
            guards,
            capital,
        }));
        await expect(loadBotAccount(dir, 'bot_future')).rejects.toThrow(/not supported/i);
    });
});


describe('safe orphan cleanup', () => {
    let dir;
    beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'midorii-bot-sweep-')); });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

    it('preserves live exposure, uncertain outcomes, unreadable records, and case-folded active ids', async () => {
        await saveBotAccount(dir, 'bot_position', { symbol: 'capital:EURUSD', capital });
        await saveBotAccount(dir, 'bot_uncertain', { symbol: 'capital:EURUSD', capital: { ...capital,
            positionDealIds: [], workingOrderDealIds: [], uncertain: true } });
        await writeFile(path.join(dir, 'bot_corrupt.json'), '{');
        await saveBotAccount(dir, 'bot_active', { symbol: 'fake:TEST', guards });
        await saveBotAccount(dir, 'bot_empty', { symbol: 'fake:TEST', guards });
        expect(await sweepBotAccounts(dir, ['BOT_ACTIVE'])).toEqual({ removed: 1 });
        expect(await loadBotAccount(dir, 'bot_position')).not.toBeNull();
        expect(await loadBotAccount(dir, 'bot_uncertain')).not.toBeNull();
        await expect(loadBotAccount(dir, 'bot_corrupt')).rejects.toThrow(/unreadable/i);
        expect(await loadBotAccount(dir, 'bot_active')).not.toBeNull();
        expect(await loadBotAccount(dir, 'bot_empty')).toBeNull();
    });
});

describe('a strategy state on disk', () => {
    let dir;
    beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'midorii-bot-strategy-')); });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

    const strategy = {
        key: '["orb","fake:TEST","1",{}]',
        state: { session: { orderId: 4, flatIndex: 3120 } },
        anchors: [[3100, 1_789_000_000_000], [3099, 1_788_999_940_000]],
        orderIds: [[4, 'deal-1']],
    };

    it('round-trips with the rest of the runtime', async () => {
        await saveBotAccount(dir, 'bot_a', { symbol: 'fake:TEST', guards, strategy });
        expect((await loadBotAccount(dir, 'bot_a')).strategy).toEqual(strategy);
    });

    it('refuses to write one it could not read back', async () => {
        await expect(saveBotAccount(dir, 'bot_a', { symbol: 'fake:TEST', guards, strategy: { ...strategy, anchors: [] } }))
            .rejects.toThrow(/strategy state is invalid/);
    });

    it('drops an unreadable one on the way in rather than refusing the whole runtime', async () => {
        await writeFile(path.join(dir, 'bot_a.json'), JSON.stringify({
            version: 2,
            symbol: 'fake:TEST',
            guards,
            strategy: { key: 'x', state: [], anchors: [[1, 2]] },
            savedAt: 1,
        }));
        const loaded = await loadBotAccount(dir, 'bot_a');
        expect(loaded.guards).toEqual(guards);
        expect('strategy' in loaded).toBe(false);
    });
});
