/** Hand-written types for journal.js — what a run's journal may hold. */
export const MAX_TAGS: number;
export const MAX_TAG_LENGTH: number;
export const MAX_SHOTS: number;
export const MAX_SHOT_BYTES: number;
export const MAX_SHOT_LABEL: number;
/** A clean list of tags from a comma-separated line or a list. */
export function normalizeTags(raw: unknown): string[];
/** `png`, `jpeg`, or null — judged by the bytes. */
export function sniffImage(bytes: Uint8Array | null | undefined): 'png' | 'jpeg' | null;
