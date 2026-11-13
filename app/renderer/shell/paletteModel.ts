/** One thing the command palette can do. `run` is attached by the caller; the model only ranks. */
export interface PaletteEntry {
    id: string;
    title: string;
    /** Shown dim after the title, e.g. the venue of a market. */
    hint?: string;
    /** Section shown while the query is empty. */
    group: string;
    /** Extra words that should find the entry without being shown. */
    keywords?: string;
    /** The chord that does the same, as displayed. */
    shortcut?: string;
}

/** Lower is better; null means the query does not match the text. */
function score(text: string, query: string): number | null {
    const t = text.toLowerCase();
    if (t === query) return 0;
    if (t.startsWith(query)) return 1;
    const at = t.indexOf(query);
    if (at >= 0) return t[at - 1] === ' ' ? 2 : 3;
    // Letters in order, anywhere: "wl" finds "Watchlist". Gaps cost, so a tight run wins.
    let from = 0;
    let gaps = 0;
    for (const ch of query) {
        const next = t.indexOf(ch, from);
        if (next < 0) return null;
        gaps += next - from;
        from = next + 1;
    }
    return 4 + Math.min(gaps, 50) / 100;
}

/**
 * The entries that match `query`, best first. An empty query keeps the given order, so the
 * caller decides what a fresh palette shows. Every whitespace-separated word has to match,
 * in the title, the hint or the keywords.
 */
export function rankEntries<T extends PaletteEntry>(entries: readonly T[], query: string): T[] {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return [...entries];
    const ranked: Array<{ entry: T; value: number; index: number }> = [];
    entries.forEach((entry, index) => {
        let total = 0;
        for (const word of words) {
            const hit = [
                score(entry.title, word),
                entry.hint ? score(entry.hint, word) : null,
                entry.keywords ? score(entry.keywords, word) : null,
            ].filter((s): s is number => s !== null);
            if (hit.length === 0) return;
            total += Math.min(...hit);
        }
        ranked.push({ entry, value: total, index });
    });
    ranked.sort((a, b) => a.value - b.value || a.index - b.index);
    return ranked.map((r) => r.entry);
}
