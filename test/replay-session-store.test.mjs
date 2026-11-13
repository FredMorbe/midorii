import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    deleteSession, duplicateSession, listSessions, loadSession, renameSession, saveSession,
} from '../app/electron/data/store/sessionStore.js';

let dir;
beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'midorii-sessions-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const base = { name: 'NQ open', symbol: 'NQZ6.REC', timeframe: '1', startTime: 1, clock: 5, stats: { trades: 2, equity: 10_100, initialBalance: 10_000 }, session: { version: 1 } };

describe('stored replay sessions can be renamed and copied', () => {
    it('renames in the file and in the list, and keeps its place in the list', async () => {
        const older = await saveSession(dir, { ...base, name: 'older' });
        await new Promise((r) => setTimeout(r, 5));
        const newer = await saveSession(dir, { ...base, name: 'newer' });
        const before = (await listSessions(dir)).find((s) => s.id === older.id);

        await renameSession(dir, older.id, '  Morning drill  ');

        expect((await loadSession(dir, older.id)).name).toBe('Morning drill');
        const list = await listSessions(dir);
        expect(list.map((s) => s.id)).toEqual([newer.id, older.id]);
        expect(list.find((s) => s.id === older.id)).toMatchObject({ name: 'Morning drill', savedAt: before.savedAt });
    });

    it('cuts an over-long name rather than storing it', async () => {
        const { id } = await saveSession(dir, base);
        await renameSession(dir, id, 'x'.repeat(500));
        expect((await loadSession(dir, id)).name).toHaveLength(120);
    });

    it('refuses to rename what is not stored', async () => {
        await expect(renameSession(dir, 'sdoesnotexist1', 'x')).rejects.toThrow();
        await expect(renameSession(dir, '../escape', 'x')).rejects.toThrow(/Invalid session id/);
    });

    it('copies under a new id and leaves the original alone', async () => {
        const { id } = await saveSession(dir, base);
        const copy = await duplicateSession(dir, id);

        expect(copy.id).not.toBe(id);
        expect(await loadSession(dir, id)).toMatchObject({ name: 'NQ open', clock: 5 });
        expect(await loadSession(dir, copy.id)).toMatchObject({ name: 'NQ open (copy)', clock: 5, session: { version: 1 } });
        expect(await listSessions(dir)).toHaveLength(2);

        await deleteSession(dir, copy.id);
        expect((await listSessions(dir)).map((s) => s.id)).toEqual([id]);
    });

    it('names the copy of an unnamed session too', async () => {
        const { id } = await saveSession(dir, { ...base, name: '' });
        const copy = await duplicateSession(dir, id);
        expect((await loadSession(dir, copy.id)).name).toBe('Untitled (copy)');
    });
});
