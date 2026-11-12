import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadBots, saveBots } from '../app/electron/data/store/botStore.js';
let dir;
beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'midorii-bot-definitions-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
describe('bot definitions protect runtime accounts', () => {
    it('does not report a corrupt list as an empty list to the orphan sweeper', async () => {
        await writeFile(path.join(dir, 'bots.json'), '{ broken');
        await expect(loadBots(dir)).rejects.toThrow(/read|parse|invalid/i);
    });
    it('refuses duplicate bot ids before storing a list', async () => {
        await expect(saveBots(dir, [{ id: 'bot_1', strategy: 'silverbullet' }, { id: 'bot_1', strategy: 'silverbullet' }])).rejects.toThrow(/duplicate/i);
    });
});


it('refuses case-colliding ids that share a runtime filename on Windows', async () => {
    await expect(saveBots(dir, [{ id: 'Bot_1', strategy: 'silverbullet' }, { id: 'bot_1', strategy: 'silverbullet' }])).rejects.toThrow(/duplicate/i);
});
