import { describe, expect, it } from 'vitest';
import { randomStart } from '../app/renderer/replay/replayHub';

const DAY = 86_400_000;
const at = (r: { date: string; time: string }): number => Date.parse(`${r.date}T${r.time}:00Z`);

describe('random replay start', () => {
    const d = { first: Date.UTC(2023, 0, 1), last: Date.UTC(2024, 0, 1) };

    it('stays inside the data, with history behind it and bars left ahead', () => {
        for (const r of [0, 0.25, 0.5, 0.999999, 1]) {
            const t = at(randomStart(d, () => r));
            expect(t).toBeGreaterThan(d.first + 400 * 3_600_000);
            expect(t).toBeLessThanOrEqual(d.last - DAY + 900_000);
        }
    });

    it('lands on the quarter hour', () => {
        const t = at(randomStart(d, () => 0.3711));
        expect(t % 900_000).toBe(0);
    });

    it('differs between draws', () => {
        expect(randomStart(d, () => 0.1)).not.toEqual(randomStart(d, () => 0.9));
    });

    it('stays inside a recording of a few hours', () => {
        const rec = { first: Date.UTC(2026, 5, 1, 13, 30), last: Date.UTC(2026, 5, 1, 17, 30) };
        for (const r of [0, 0.5, 1]) {
            const t = at(randomStart(rec, () => r));
            expect(t).toBeGreaterThan(rec.first);
            expect(t).toBeLessThan(rec.last);
        }
    });

    it('falls back to the default start where the range is unknown', () => {
        expect(randomStart({ first: Date.UTC(2023, 0, 1), last: null })).toEqual({ date: '2023-01-21', time: '00:00' });
    });
});
