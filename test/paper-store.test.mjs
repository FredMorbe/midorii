// The paper account file: what the first leg carries as it always did, and the other markets of
// the account riding beside it. Plain JS, like the other store tests: it touches node:fs.
// See app/electron/data/store/paperStore.js.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { clearAccount, loadAccount, saveAccount } from '../app/electron/data/store/paperStore.js';

describe('the paper account on disk', () => {
    let dir;
    beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'midorii-paper-')); });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

    it('reads as nothing before anything has been written', async () => {
        expect(await loadAccount(dir)).toBeNull();
    });

    it('keeps the other markets of the account beside the first', async () => {
        const extra = { version: 1, legs: [{ symbol: 'binance:ETHUSDT', session: { broker: {} } }], ledger: { createdAt: 5 } };
        await saveAccount(dir, { symbol: 'binance:BTCUSDT', session: { broker: {} }, extra });
        const back = await loadAccount(dir);
        expect(back.symbol).toBe('binance:BTCUSDT');
        expect(back.extra).toEqual(extra);
    });

    it('writes a one-market account exactly as before', async () => {
        await saveAccount(dir, { symbol: 'binance:BTCUSDT', session: { broker: {} } });
        const back = await loadAccount(dir);
        expect(back.symbol).toBe('binance:BTCUSDT');
        expect('extra' in back).toBe(false);
    });

    it('throws the account away on clear', async () => {
        await saveAccount(dir, { symbol: 'a', session: { broker: {} } });
        await clearAccount(dir);
        expect(await loadAccount(dir)).toBeNull();
    });
});
