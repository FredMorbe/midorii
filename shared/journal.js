/* What a run's journal may hold, and the rules that keep it tidy.
 *
 * Shared because both ends need the same answer: the screen cleans what somebody typed so it
 * can show what will be stored, and the store cleans again because it never trusts what
 * crossed the bridge. Two copies of "what is a tag" would drift, and the drift would show up
 * as a tag that was shown one way and filed another.
 */

/** Tags on one run. More than this is a list nobody reads. */
export const MAX_TAGS = 12;
/** Characters in one tag — a word or two, not a sentence. */
export const MAX_TAG_LENGTH = 32;
/** Images on one run. */
export const MAX_SHOTS = 12;
/** Bytes in one image. A full-screen chart is a few hundred kilobytes; this is generous. */
export const MAX_SHOT_BYTES = 4 * 1024 * 1024;
/** Characters in a caption. */
export const MAX_SHOT_LABEL = 120;

/**
 * A clean list of tags from whatever was typed — a comma-separated line or a list.
 *
 * Trimmed, whitespace collapsed, a leading `#` dropped (people write them that way), cut to
 * {@link MAX_TAG_LENGTH}, de-duplicated without regard to case (the first spelling wins), and
 * capped at {@link MAX_TAGS}. Anything that is not text is dropped rather than turned into one.
 */
export function normalizeTags(raw) {
  const parts = typeof raw === 'string' ? raw.split(',') : Array.isArray(raw) ? raw : [];
  const seen = new Set();
  const out = [];
  for (const part of parts) {
    if (typeof part !== 'string') continue;
    const tag = part.replace(/\s+/g, ' ').trim().replace(/^#+\s*/, '').slice(0, MAX_TAG_LENGTH).trim();
    if (tag === '') continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/**
 * What kind of image these bytes are, judged by the bytes and not by anything they were
 * called: `png`, `jpeg`, or null for everything else. The store keeps only what this accepts,
 * so a file that is not an image can never be written into the journal under an image's name.
 */
export function sniffImage(bytes) {
  if (!bytes || bytes.length < 12) return null;
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (png.every((b, i) => bytes[i] === b)) return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  return null;
}
