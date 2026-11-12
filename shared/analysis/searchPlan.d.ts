export type SearchAxis = { from: number; to: number; step: number } | { values: unknown[] };
export interface SearchSpace { entries: Array<[string, unknown[]]>; total: number }
export function searchSpace(axes: Record<string, SearchAxis>): SearchSpace;
export function permutation(total: number, seed: string, index: number): number;
export function searchParams(space: SearchSpace, base: Record<string, unknown>, index: number, method?: 'grid' | 'random', seed?: string): Record<string, unknown>;
