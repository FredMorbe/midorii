import { expandRange } from './sweep.js';

/** A bounded set of axes, with a lazy Cartesian product. */
export function searchSpace(axes) {
  const entries = Object.entries(axes ?? {}).map(([key, axis]) => {
    let values;
    if (Array.isArray(axis.values)) {
      values = axis.values;
      if (values.length > 1000) throw new Error(`${key}: too many choices`);
    } else {
      if (!Number.isFinite(axis.step) || axis.step <= 0
          || !Number.isFinite(axis.from) || !Number.isFinite(axis.to)
          || axis.to < axis.from || (axis.to - axis.from) / axis.step > 100_000) {
        throw new Error(`${key}: use a valid range of at most 100,001 values`);
      }
      values = expandRange(axis);
    }
    if (!values.length || new Set(values.map((v) => JSON.stringify(v))).size !== values.length) {
      throw new Error(`${key}: choices must be non-empty and unique`);
    }
    return [key, values];
  });
  if (!entries.length) throw new Error('Choose at least one setting to vary');
  const total = entries.reduce((n, [, values]) => n * values.length, 1);
  if (!Number.isSafeInteger(total)) throw new Error('The search space is too large; narrow its ranges');
  return { entries, total };
}

/** A cycle-walked Feistel permutation samples without a growing set of visited indices. */
export function permutation(total, seed, index) {
  let h = 2166136261;
  for (const c of String(seed)) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  const bits = Math.max(2, Math.ceil(Math.log2(total) / 2) * 2);
  const half = BigInt(bits / 2);
  const mask = (1n << half) - 1n;
  let at = BigInt(index);
  do {
    let left = at >> half;
    let right = at & mask;
    for (let round = 0; round < 6; round++) {
      let mixed = Math.imul(Number(right) ^ h ^ Math.imul(round + 1, 0x9e3779b9), 0x85ebca6b) >>> 0;
      mixed = Math.imul(mixed ^ (mixed >>> 16), 0xc2b2ae35) >>> 0;
      [left, right] = [right, left ^ (BigInt(mixed ^ (mixed >>> 16) >>> 0) & mask)];
    }
    at = (left << half) | right;
  } while (at >= BigInt(total));
  return Number(at);
}

export function searchParams(space, base, index, method = 'grid', seed = '1') {
  if (!Number.isSafeInteger(index) || index < 0 || index >= space.total) throw new Error('Invalid search index');
  let at = index;
  if (method === 'random') {
    at = permutation(space.total, seed, index);
  }
  const params = { ...base };
  for (let i = space.entries.length - 1; i >= 0; i--) {
    const [key, values] = space.entries[i];
    params[key] = values[at % values.length];
    at = Math.floor(at / values.length);
  }
  return params;
}
