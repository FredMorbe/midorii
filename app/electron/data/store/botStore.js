/* Trading bots on disk — one file, rewritten in place.
 *
 * A bot is configuration, not a result: which strategy, on which market, with what settings
 * and what it is allowed to do unattended. So it lives beside the strategy settings rather
 * than on the run shelf — what a bot has DONE is a paper account or a live journal entry,
 * and those already have their own homes.
 *
 * A flat list read and written whole, like alertStore: a person has a handful of bots, the
 * whole set is smaller than one bar of market data, and a per-bot CRUD surface would be
 * three more handlers for no benefit. Written through a temporary file for the same reason
 * everything else here is — a crash mid-write must cost nothing more than the newest edit.
 *
 * What is stored and what is not
 * ------------------------------
 * The definition only. Durable runtime data lives in botAccountStore: the paper account,
 * daily guard counters, and the confirmed venue ids a live bot may manage. Market history
 * and strategy detector state are rebuilt from the provider when the bot starts again.
 *
 * Values are stored as they arrive and validated where the schema is, in the renderer —
 * the same rule strategyStore follows, and for the same reason: a build that renames a
 * parameter must not be met with a file it refuses to read.
 */
import { readFile, open, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';

const BOTS_FILE = 'bots.json';

/** The shape this version writes. A record from the future is not guessed at. */
const VERSION = 1;

/** A cap on the list, so a bad caller cannot write a megabyte of bots. Far above what
 *  anybody runs — a machine cannot hold a hundred live subscriptions open anyway. */
const MAX_BOTS = 100;

function botsFile(dir) {
  return path.join(dir, BOTS_FILE);
}

async function writeAtomic(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  // On the device before the rename, so a power cut cannot leave an empty list behind.
  const handle = await open(tmp, 'w');
  try {
    await handle.writeFile(JSON.stringify(data, null, 2), 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, file);
}

/**
 * The stored bots, or an empty list where there are none.
 *
 * Only a missing file means an empty list. Corruption must stop loading because an empty
 * list permits orphan-account cleanup and would erase the evidence of previous trading.
 */
export async function loadBots(dir) {
  let raw;
  try {
    raw = await readFile(botsFile(dir), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw new Error('The stored bots could not be read.', { cause: err });
  }

  try {
    const record = JSON.parse(raw);
    if (record?.version !== VERSION || !Array.isArray(record.bots)) {
      throw new Error('The stored bots are not a record this version can read.');
    }
    const ids = record.bots.map((bot) => typeof bot?.id === 'string' ? bot.id.toLowerCase() : null);
    if (new Set(ids).size !== ids.length) throw new Error('The stored bots contain duplicate ids.');
    return record.bots;
  } catch (err) {
    throw new Error('The stored bots could not be parsed safely.', { cause: err });
  }
}

/** Store the whole list, replacing what was there. */
export async function saveBots(dir, bots) {
  if (!Array.isArray(bots)) throw new Error('saveBots: expected a list of bots');
  if (bots.length > MAX_BOTS) {
    throw new Error(`saveBots: ${bots.length} bots is more than this app will keep (${MAX_BOTS})`);
  }
  for (const bot of bots) {
    if (!bot || typeof bot !== 'object') throw new Error('saveBots: a bot must be an object');
    if (typeof bot.id !== 'string' || !bot.id.trim()) throw new Error('saveBots: every bot needs an id');
    if (typeof bot.strategy !== 'string' || !bot.strategy.trim()) {
      throw new Error(`saveBots: bot ${bot.id} names no strategy`);
    }
  }
  if (new Set(bots.map((bot) => bot.id.toLowerCase())).size !== bots.length) {
    throw new Error('saveBots: duplicate bot ids are not allowed');
  }

  const record = { version: VERSION, bots, savedAt: Date.now() };
  await writeAtomic(botsFile(dir), record);
  return { savedAt: record.savedAt };
}
