// Snapshots taken for the journal while a replay is played: kept with the session, filed with the
// run, and reported when one cannot be attached.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { aggregate, STRIDE } from '../app/electron/data/store/barStore.js';
import { barIndexAt } from '../shared/engine/replaySession.js';
import { MAX_SHOTS } from '../shared/journal.js';
import { ReplayController } from '../app/renderer/replay/ReplayController';
import type { ReplayProvider } from '../app/renderer/replay/ReplayProvider';
import { loadReplayWindow } from '../app/renderer/replay/replayWindow';
import { dataUrlBytes, readableError } from '../app/renderer/journal/images';

const MINUTE = 60_000;
const HOUR = 3_600_000;
const START = Date.UTC(2024, 0, 1);
const DAYS = 2;

function minuteData(): Float64Array {
    const count = DAYS * 24 * 60;
    const data = new Float64Array(count * STRIDE);
    for (let i = 0; i < count; i++) {
        const base = i * STRIDE;
        const price = 100 + Math.sin(i / 30) * 5;
        data[base] = START + i * MINUTE;
        data[base + 1] = price;
        data[base + 2] = price + 0.4;
        data[base + 3] = price - 0.4;
        data[base + 4] = price + 0.1;
        data[base + 5] = 10;
        data[base + 6] = 6;
    }
    return data;
}
const DATA = minuteData();
const LAST = START + (DAYS * 24 * 60 - 1) * MINUTE;

/** What the main process was asked to do, and what to make it refuse. */
const calls = {
    saved: [] as Array<Record<string, unknown>>,
    sessions: [] as Array<Record<string, unknown>>,
    shots: [] as Array<{ id: string; data: Uint8Array; label?: string; takenAt?: number }>,
    deleted: [] as string[],
    refuseShot: null as null | ((n: number) => boolean),
};

const midori = {
    data: {
        meta: () => Promise.resolve({ symbol: 'TEST', first: START, last: LAST }),
        bars: ({ timeframe, from, to, dropIncomplete = true }: {
            timeframe: string; from: number; to: number; dropIncomplete?: boolean;
        }) => Promise.resolve(aggregate(DATA, from, to, timeframe, dropIncomplete)),
    },
    replay: {
        save: (request: Record<string, unknown>) => { calls.saved.push(request); return Promise.resolve({ id: 'rtest0001' }); },
        saveSession: (request: Record<string, unknown>) => { calls.sessions.push(request); return Promise.resolve({ id: 'stest0001' }); },
        deleteSession: (id: string) => { calls.deleted.push(id); return Promise.resolve(true); },
    },
    runs: {
        addShot: (id: string, shot: { data: Uint8Array; label?: string; takenAt?: number }) => {
            calls.shots.push({ id, ...shot });
            if (calls.refuseShot?.(calls.shots.length)) return Promise.reject(new Error('The journal keeps PNG and JPEG images; this is neither.'));
            return Promise.resolve({ id: `h${calls.shots.length}` });
        },
    },
};

class FakeProvider {
    timeframe = '5';
    cutoff = 0;
    constructor(timeframe: string, clock: number) { this.retime(timeframe, clock); }
    retime(timeframe: string, clock: number): void { this.timeframe = timeframe; this.cutoff = clock; }
    revealNext(): void {}
}

let previousWindow: unknown;
beforeAll(() => {
    previousWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = { midori };
});
afterAll(() => { (globalThis as { window?: unknown }).window = previousWindow; });
beforeEach(() => {
    calls.saved = [];
    calls.sessions = [];
    calls.shots = [];
    calls.deleted = [];
    calls.refuseShot = null;
});

const T0 = START + 6 * HOUR;
/** A one-pixel PNG, as the chart's screenshot hands it over. */
const PNG_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

async function session(restore?: ConstructorParameters<typeof ReplayController>[0]['shots']) {
    const { bars } = await loadReplayWindow('TEST', '5', T0);
    return new ReplayController({
        provider: new FakeProvider('5', T0) as unknown as ReplayProvider,
        symbol: 'TEST',
        timeframe: '5',
        bars,
        startIndex: barIndexAt(bars, T0 - 1),
        balance: 10_000,
        shots: restore,
        rechart: (tf, at) => Promise.resolve(new FakeProvider(tf, at) as unknown as ReplayProvider),
    });
}

/** A session with one closed trade, so it can be filed. */
async function traded() {
    const c = await session();
    c.skip(1);
    c.buy({ size: 1 });
    c.skip(2);
    c.close();
    return c;
}

describe('reading an inline image', () => {
    it('gives the bytes back, and refuses anything else', () => {
        const bytes = dataUrlBytes(PNG_URL);
        expect(Array.from(bytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
        expect(() => dataUrlBytes('data:text/html;base64,PGI+')).toThrow(/PNG or JPEG/);
        expect(() => dataUrlBytes('https://example.com/a.png')).toThrow(/PNG or JPEG/);
        expect(() => dataUrlBytes('data:image/png;base64,***')).toThrow();
    });
});

describe('reading a refusal that crossed the bridge', () => {
    it('keeps the reason and drops the wrapping', () => {
        const wrapped = new Error("Error invoking remote method 'runs:addShot': Error: The journal keeps PNG and JPEG images; this is neither.");
        expect(readableError(wrapped)).toBe('The journal keeps PNG and JPEG images; this is neither.');
        expect(readableError(new Error('plain'))).toBe('plain');
        expect(readableError('text')).toBe('text');
    });
});

describe('snapshots on a session', () => {
    it('are kept at the clock they were taken at', async () => {
        const c = await session();
        c.skip(2);
        c.addShot(PNG_URL, 'the entry');
        expect(c.shotCount).toBe(1);
        let heard = 0;
        c.onChange(() => { heard += 1; });
        c.addShot(PNG_URL);
        expect(heard).toBe(1);
        await c.saveSession('mine');
        const sent = calls.sessions[0]!.shots as Array<{ takenAt: number; label: string }>;
        expect(sent).toHaveLength(2);
        expect(sent[0]).toMatchObject({ takenAt: T0 + 2 * 5 * MINUTE, label: 'the entry' });
    });

    it('come back with a session that is picked up again', async () => {
        const c = await session([{ png: PNG_URL, takenAt: 5, label: 'from before' }]);
        expect(c.shotCount).toBe(1);
        c.addShot(PNG_URL);
        await c.saveSession();
        expect((calls.sessions[0]!.shots as unknown[]).length).toBe(2);
    });

    it('stop at what a run can hold, and refuse what is not an image', async () => {
        const c = await session();
        for (let i = 0; i < MAX_SHOTS; i++) c.addShot(PNG_URL);
        expect(() => c.addShot(PNG_URL)).toThrow(/up to 12/);
        const d = await session();
        expect(() => d.addShot('data:image/jpeg;base64,AAAA')).toThrow(/no image/);
        expect(() => d.addShot('')).toThrow();
        expect(d.shotCount).toBe(0);
    });
});

describe('filing a session as a run', () => {
    it('sends the note and the tags with it, and the snapshots after', async () => {
        const c = await traded();
        c.addShot(PNG_URL, 'one');
        c.addShot(PNG_URL, 'two');
        const filed = await c.saveAsRun({ note: 'Chased the break.', tags: ['fomo', 'asia'] });

        expect(filed).toEqual({ id: 'rtest0001', failed: [] });
        expect(calls.saved[0]).toMatchObject({ symbol: 'TEST', note: 'Chased the break.', tags: ['fomo', 'asia'] });
        expect(calls.shots.map((s) => [s.id, s.label])).toEqual([['rtest0001', 'one'], ['rtest0001', 'two']]);
        expect(Array.from(calls.shots[0]!.data.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    });

    it('files with nothing written at all', async () => {
        const c = await traded();
        const filed = await c.saveAsRun();
        expect(filed.failed).toEqual([]);
        expect(calls.saved[0]).toMatchObject({ note: '', tags: [] });
        expect(calls.shots).toHaveLength(0);
    });

    it('reports a snapshot the store refused and still files the rest', async () => {
        const c = await traded();
        c.addShot(PNG_URL, 'a');
        c.addShot(PNG_URL, 'b');
        c.addShot(PNG_URL, 'c');
        calls.refuseShot = (n) => n === 2;
        const filed = await c.saveAsRun();
        expect(filed.id).toBe('rtest0001'); // the run exists either way
        expect(filed.failed).toHaveLength(1);
        expect(filed.failed[0]).toMatch(/PNG and JPEG/);
        expect(calls.shots).toHaveLength(3);
    });

    it('takes the parked copy off the list once it is filed', async () => {
        const c = await session();
        c.skip(1);
        c.buy({ size: 1 });
        c.skip(1);
        c.close();
        await c.saveSession('parked');
        await c.saveAsRun();
        expect(calls.deleted).toEqual(['stest0001']);
    });
});
