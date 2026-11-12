import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const blocked = vi.hoisted(() => ({ remaining: 0, code: 'EPERM' }));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original();
  return { ...fs, rename: async (...args) => {
    if (blocked.remaining > 0) { blocked.remaining--; throw Object.assign(new Error('Blocked rename'), { code: blocked.code }); }
    return fs.rename(...args);
  } };
});
import { atomicJson } from '../app/electron/search/store.js';

let root;
afterEach(async () => { blocked.remaining = 0; blocked.code = 'EPERM'; if (root) await rm(root, { recursive: true, force: true }); });

describe('search progress persistence', () => {
  it('retains the previous progress while a Windows rename is temporarily blocked', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'midorii-search-state-'));
    const file = path.join(root, 'state.json');
    await atomicJson(file, { done: 1 });
    blocked.remaining = 2;
    const saving = atomicJson(file, { done: 2 });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ done: 1 });
    await saving;
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ done: 2 });
    expect(await readdir(root)).toEqual(['state.json']);
  });
  it('reports a permanent failure and preserves the last saved progress', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'midorii-search-state-'));
    const file = path.join(root, 'state.json');
    await atomicJson(file, { done: 1 });
    blocked.remaining = 100;
    await expect(atomicJson(file, { done: 2 })).rejects.toThrow('Blocked rename');
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ done: 1 });
    expect(await readdir(root)).toEqual(['state.json']);
  });
});
