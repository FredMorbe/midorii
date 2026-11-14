// The cards in a chart's top-right corner slide under the chart's own header when the two
// would overlap. The geometry cannot come from a real layout under node, so the elements are
// stand-ins that answer the few questions `clearStatusLine` asks. See replay/overlayCards.ts.
import { describe, expect, it } from 'vitest';
import { clearStatusLine } from '../app/renderer/replay/overlayCards';

interface Box { left: number; top: number; right: number; bottom: number }

const rect = (b: Box): DOMRect => ({ ...b, x: b.left, y: b.top, width: b.right - b.left, height: b.bottom - b.top, toJSON: () => b }) as DOMRect;

function el(b: Box, extra: Partial<{ text: string; children: unknown[]; styleLeft: string; leaves: unknown[] }> = {}) {
    return {
        getBoundingClientRect: () => rect(b),
        children: extra.children ?? [],
        textContent: extra.text ?? '',
        style: { left: extra.styleLeft ?? '' },
        querySelectorAll: () => extra.leaves ?? [],
    };
}

function fakeCell(parts: { line?: ReturnType<typeof el>; legends?: Array<ReturnType<typeof el>>; cards?: Array<ReturnType<typeof el>> }) {
    const props = new Map<string, string>();
    return {
        props,
        style: { setProperty: (k: string, v: string) => void props.set(k, v) },
        querySelector: (sel: string) => (sel.includes('vela-statusline') ? parts.line ?? null : null),
        querySelectorAll: (sel: string) => (sel.includes('midorii-card') ? parts.cards ?? [] : parts.legends ?? []),
    } as unknown as HTMLElement & { props: Map<string, string> };
}

const drop = (cell: { props: Map<string, string> }): string | undefined => cell.props.get('--midorii-card-drop');

describe('clearStatusLine', () => {
    const line = el({ left: 3, top: 8, right: 464, bottom: 40 });

    it('leaves the cards alone when there is no header to avoid', () => {
        const cell = fakeCell({ cards: [el({ left: 10, top: 10, right: 400, bottom: 120 })] });
        expect(clearStatusLine(cell)).toEqual([]);
        expect(drop(cell as never)).toBe('0px');
    });

    it('leaves a card that sits beside the header where it is', () => {
        const cell = fakeCell({ line, cards: [el({ left: 520, top: 10, right: 900, bottom: 120 })] });
        clearStatusLine(cell);
        expect(drop(cell as never)).toBe('0px');
    });

    it('drops a card that covers the header to six pixels under it', () => {
        const cell = fakeCell({ line, cards: [el({ left: 10, top: 10, right: 475, bottom: 122 })] });
        clearStatusLine(cell);
        expect(drop(cell as never)).toBe('36px'); // 40 + 6 - 10
    });

    it('takes the lowest of the cards that meet the header', () => {
        const cell = fakeCell({ line, cards: [el({ left: 10, top: 10, right: 475, bottom: 122 }), el({ left: 100, top: 4, right: 300, bottom: 60 })] });
        clearStatusLine(cell);
        expect(drop(cell as never)).toBe('42px'); // 40 + 6 - 4
    });

    it('clears the legend under the header by its text, not by the box it spans', () => {
        const text = el({ left: 76, top: 37, right: 190, bottom: 53 }, { text: 'Volume' });
        const legend = el({ left: 0, top: 30, right: 700, bottom: 400 }, { leaves: [text] });
        const cell = fakeCell({ line, legends: [legend], cards: [el({ left: 10, top: 10, right: 475, bottom: 122 })] });
        const depends = clearStatusLine(cell);
        expect(drop(cell as never)).toBe('49px'); // 53 + 6 - 10
        expect(depends).toHaveLength(2);
    });

    it('ignores a card that has been dragged, and a legend with no text', () => {
        const empty = el({ left: 0, top: 30, right: 700, bottom: 400 }, { leaves: [el({ left: 0, top: 0, right: 0, bottom: 0 }, { text: '' })] });
        const cell = fakeCell({ line, legends: [empty], cards: [el({ left: 10, top: 10, right: 475, bottom: 122 }, { styleLeft: '12px' })] });
        clearStatusLine(cell);
        expect(drop(cell as never)).toBe('0px');
    });
});
