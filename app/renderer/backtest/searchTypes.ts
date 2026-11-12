import type { SearchConfig } from './searchEngine';
import type { MidoriBar, MidoriSweepStats } from '../midori';
import type { BacktestResult } from '../../../shared/engine/backtest';

export interface SearchDataset {
    symbol: string;
    timeframe: string;
    stepMs: number;
    count: number;
    gaps: number;
    bytes: number;
    hash: string;
    periods: Record<'train' | 'validation' | 'holdout', { from: number; to: number }>;
}
export interface SearchResult {
    index: number;
    datasetIndex: number;
    params: Record<string, unknown>;
    stats: MidoriSweepStats;
    validation: MidoriSweepStats;
    resolution: 'intrabar' | 'pessimistic';
    elapsedMs: number;
}
export interface SearchJob {
    id: string;
    createdAt: number;
    config: SearchConfig;
    datasets: SearchDataset[];
    combinations: number;
    total: number;
    engineHash: string;
    estimatedResultBytes: number;
    state: {
        status: 'ready' | 'queued' | 'running' | 'pausing' | 'paused' | 'completed' | 'failed';
        done: number;
        elapsedMs: number;
        updatedAt: number;
        error: string | null;
        reason?: string;
    };
    final: null | { index: number; datasetIndex: number; params: Record<string, unknown>; status: 'queued' | 'running' | 'completed' | 'failed'; result?: Pick<BacktestResult, 'stats' | 'barCount' | 'warmupBars' | 'resolution'>; error?: string };
}
export interface SearchRequest {
    config: SearchConfig;
    symbols: string[];
    timeframes: string[];
    from: number;
    to: number;
    intrabar: boolean;
}
export interface SearchReview {
    result: BacktestResult;
    bars: MidoriBar[];
    params: Record<string, unknown>;
    config: SearchConfig;
    data: SearchDataset;
    period: 'train' | 'validation' | 'holdout';
}
