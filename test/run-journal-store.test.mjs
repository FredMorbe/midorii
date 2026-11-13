import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    addRunShot, annotateRun, deleteRun, listRuns, loadRun, loadRunShot, removeRunShot, saveRun, setRunTags,
} from '../app/electron/data/store/runStore.js';
import { MAX_SHOTS, MAX_TAGS, MAX_TAG_LENGTH, normalizeTags, sniffImage } from '../shared/journal.js';

let dir;
beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'midorii-journal-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1]);

const run = () => saveRun(dir, {
    strategy: 'replay', strategyName: 'Manual replay', symbol: 'TEST', timeframe: '5', from: 1, to: 2,
    initialBalance: 10_000, params: {}, trades: [], equityCurve: [],
    stats: { netPnl: 0, returnPct: 0, winRate: null, tradeCount: 0, maxDrawdownPct: 0, profitFactor: null, expectancy: null, feesPaid: 0 },
});

describe('what a tag is', () => {
    it('is trimmed, without a leading hash, once per spelling, and cut to length', () => {
        expect(normalizeTags('  #FOMO ,  revenge  trade, fomo , ,#')).toEqual(['FOMO', 'revenge trade']);
        expect(normalizeTags(['a', 'A', 3, null, 'b'])).toEqual(['a', 'b']);
        expect(normalizeTags('x'.repeat(100))[0]).toHaveLength(MAX_TAG_LENGTH);
    });

    it('stops at the limit and reads nothing else as a list', () => {
        const many = Array.from({ length: 30 }, (_, i) => `t${i}`);
        expect(normalizeTags(many)).toHaveLength(MAX_TAGS);
        expect(normalizeTags(42)).toEqual([]);
        expect(normalizeTags(undefined)).toEqual([]);
    });
});

describe('what an image is', () => {
    it('is judged by its bytes', () => {
        expect(sniffImage(PNG)).toBe('png');
        expect(sniffImage(JPEG)).toBe('jpeg');
        expect(sniffImage(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
        expect(sniffImage(Uint8Array.from([1, 2, 3]))).toBeNull();
    });
});

describe('the journal on a stored run', () => {
    it('keeps tags in the run and in the list', async () => {
        const { id } = await run();
        expect(await setRunTags(dir, id, 'breakout, #news')).toEqual(['breakout', 'news']);
        expect((await loadRun(dir, id)).tags).toEqual(['breakout', 'news']);
        expect((await listRuns(dir)).find((r) => r.id === id).tags).toEqual(['breakout', 'news']);
    });

    it('lists a run with no tags and no images as having none', async () => {
        const { id } = await run();
        const row = (await listRuns(dir)).find((r) => r.id === id);
        expect(row.tags).toEqual([]);
        expect(row.shots).toBe(0);
    });

    it('stores an image as a file beside the run and hands the same bytes back', async () => {
        const { id } = await run();
        const shot = await addRunShot(dir, id, { data: PNG, label: 'the entry', takenAt: 1234 });
        expect(shot).toMatchObject({ type: 'png', bytes: PNG.length, label: 'the entry', takenAt: 1234 });
        expect((await readdir(path.join(dir, `${id}.shots`)))).toHaveLength(1);

        const back = await loadRunShot(dir, id, shot.id);
        expect(back.type).toBe('png');
        expect(new Uint8Array(back.data)).toEqual(PNG);
        expect((await listRuns(dir)).find((r) => r.id === id).shots).toBe(1);
        // The run's own file stays small: the bytes are not in it.
        expect((await stat(path.join(dir, `${id}.json`))).size).toBeLessThan(2000);
    });

    it('refuses what is not an image, what is too big, and what is one too many', async () => {
        const { id } = await run();
        await expect(addRunShot(dir, id, { data: new TextEncoder().encode('not an image at all') })).rejects.toThrow(/PNG and JPEG/);
        await expect(addRunShot(dir, id, { data: 'a string' })).rejects.toThrow(/bytes/);
        const big = new Uint8Array(5 * 1024 * 1024);
        big.set(PNG);
        await expect(addRunShot(dir, id, { data: big })).rejects.toThrow(/MB/);
        for (let i = 0; i < MAX_SHOTS; i++) await addRunShot(dir, id, { data: i % 2 ? PNG : JPEG });
        await expect(addRunShot(dir, id, { data: PNG })).rejects.toThrow(/up to 12/);
    });

    it('takes an image off, file and record, and reads a missing one as an error', async () => {
        const { id } = await run();
        const a = await addRunShot(dir, id, { data: PNG });
        const b = await addRunShot(dir, id, { data: JPEG });
        expect(await removeRunShot(dir, id, a.id)).toBe(true);
        expect(await removeRunShot(dir, id, a.id)).toBe(false);
        await expect(loadRunShot(dir, id, a.id)).rejects.toThrow(/No such image/);
        expect((await loadRun(dir, id)).shots.map((s) => s.id)).toEqual([b.id]);
        expect(await readdir(path.join(dir, `${id}.shots`))).toHaveLength(1);
    });

    it('takes its images with it when the run is deleted', async () => {
        const { id } = await run();
        await addRunShot(dir, id, { data: PNG });
        await deleteRun(dir, id);
        expect(await readdir(dir)).not.toContain(`${id}.shots`);
        expect((await listRuns(dir)).some((r) => r.id === id)).toBe(false);
    });

    it('survives rebuilding the list from the files', async () => {
        const { id } = await run();
        await setRunTags(dir, id, 'kept');
        await addRunShot(dir, id, { data: PNG });
        await annotateRun(dir, id, 'a note');
        await rm(path.join(dir, 'index.json'));
        const row = (await listRuns(dir)).find((r) => r.id === id);
        expect(row).toMatchObject({ tags: ['kept'], shots: 1, note: 'a note' });
    });

    it('refuses an id that could name another file', async () => {
        await expect(setRunTags(dir, '../x', 'a')).rejects.toThrow(/Invalid run id/);
        await expect(loadRunShot(dir, '../x', 'abcdef')).rejects.toThrow(/Invalid run id/);
    });
});
