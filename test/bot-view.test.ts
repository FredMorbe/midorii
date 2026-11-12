import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../app/renderer/about/brand', () => ({ BRAND: {} }));
vi.mock('../app/renderer/shell/sharedChartDoc', () => ({ shareChartDoc: vi.fn() }));

vi.mock('../src/ui', async (original) => ({
    ...await original<typeof import('../src/ui')>(),
    injectStyles: () => {}, ensureUIHost: () => {}, applyThemeTokens: () => {},
    overlayScrollbarCss: () => '', Menu: class {},
}));
vi.mock('../app/renderer/runs/runViews', () => ({
    ensureFigureStyles: () => {},
    button: (label: string) => {
        const el = document.createElement('button');
        el.textContent = label;
        return el;
    },
}));
vi.mock('../app/renderer/replay/replayIndicator', () => ({ TRADE_INDICATOR_TYPE: 'test-trades', registerTradeIndicator: () => {} }));
vi.mock('../app/renderer/bot/botTape', () => ({ botTape: () => ({ render() {}, showPrimary() {} }) }));
vi.mock('../app/renderer/bot/assetPicker', () => ({ createAssetPicker: () => ({}) }));

import { mountBotView } from '../app/renderer/bot/botView';
import { newBot } from '../app/renderer/bot/botTypes';
import type { BotEngine } from '../app/renderer/bot/BotEngine';

function element(doc: any, tag: string): any {
    const el: any = {
        ownerDocument: doc, tagName: tag, children: [], dataset: {}, hidden: false,
        textContent: '', className: '', disabled: false, parentElement: null,
        classList: { add() {}, remove() {}, toggle() {} },
        append(...items: any[]) {
            for (const item of items) {
                item.remove();
                item.parentElement = this;
                this.children.push(item);
            }
        },
        appendChild(item: any) { this.append(item); return item; },
        insertBefore(item: any, next: any) {
            item.remove();
            const index = next ? this.children.indexOf(next) : this.children.length;
            item.parentElement = this;
            this.children.splice(index, 0, item);
            return item;
        },
        replaceChildren(...items: any[]) {
            for (const child of [...this.children]) child.remove();
            this.append(...items);
        },
        remove() {
            if (this.parentElement) {
                const siblings = this.parentElement.children;
                siblings.splice(siblings.indexOf(this), 1);
                this.parentElement = null;
            }
        },
        setAttribute() {}, addEventListener() {},
    };
    return el;
}

function setup() {
    const doc: any = { createElement: (tag: string) => element(doc, tag) };
    const host = doc.createElement('div');
    // The list and header paint even before the chart's tab is visible.
    host.hidden = true;
    vi.stubGlobal('document', doc);
    vi.stubGlobal('window', { midori: { capital: { environment: () => new Promise(() => {}) } } });
    vi.stubGlobal('requestAnimationFrame', vi.fn());
    const bots = [newBot('silverbullet', 'binance:BTCUSDT'), newBot('rangefakeout', 'binance:ETHUSDT')];
    let status = 'running';
    const stop = vi.fn(async () => { status = 'stopped'; });
    const engine = {
        ready: true, runningCount: 2, list: () => bots,
        find: (id: string) => bots.find(b => b.id === id),
        status: () => status, displayRunner: () => null,
        subscribe: () => () => {}, stop,
    } as unknown as BotEngine;
    const view = mountBotView(host, { engine, providers: {}, theme: () => 'dark', notify: vi.fn() });
    const find = (className: string): any[] => {
        const result: any[] = [];
        function walk(el: any) {
            if (el.className === className) result.push(el);
            el.children.forEach(walk);
        }
        walk(host);
        return result;
    };
    return { bots, view, stop, find };
}

afterEach(() => vi.unstubAllGlobals());

describe('bot view controls during feed updates', () => {
    it('keeps the bot selector and Stop button attached across repeated refreshes', async () => {
        const { find, view, bots, stop } = setup();
        const row = find('midorii-bot-item')[1];
        const head = find('midorii-bot-head')[0];
        const toggle = head.children.at(-1);
        // Resolve the environment read without making the hidden chart active.
        (window as any).midori.capital.environment = async () => ({ configured: false });
        for (let i = 0; i < 3; i++) await view.refresh();
        expect(find('midorii-bot-item')[1] === row).toBe(true);
        expect(head.children.at(-1) === toggle).toBe(true);
        expect(row.parentElement).not.toBeNull();
        expect(toggle.parentElement).toBe(head);
        row.onclick();
        expect(view.selectedBotId).toBe(bots[1]!.id);
        find('midorii-bot-head')[0].children.at(-1).onclick();
        await Promise.resolve();
        expect(stop).toHaveBeenCalledWith(bots[1]!.id);
        await view.refresh();
        expect(head.children.at(-1) === toggle).toBe(true);
        expect(toggle.textContent).toBe('Start');
        expect(find('midorii-bot-dot')[1].dataset.state).toBe('stopped');
    });
});
