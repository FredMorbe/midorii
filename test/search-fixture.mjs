export const STEP = 300_000;
const chain = [[100,101,99,100],[100,102,99.5,101],[101,110,100.5,109],[109,109.5,107,108],[108,108.5,106,107],[107,111,106.5,107.5],[107.5,108,105,105.5],[105.5,106,100,100.5],[100.5,104,99,99.5],[99.5,101,98,100.5],[100.5,104.5,100,103],[103,103.5,95,96],[96,96.5,89,90],[90,91,89.5,90.5]];
export function searchBars(days = 40) {
  return Array.from({ length: days }, (_, day) => chain.map(([open, high, low, close], i) => ({ time: Date.parse('2024-04-01T13:20:00Z') + day * 86_400_000 + i * STEP, open, high, low, close, volume: 1 }))).flat();
}
export function searchConfig(overrides = {}) {
  return { name: 'Offline experiment', strategy: 'silverbullet', axes: { rrr: { from: 1, to: 3, step: 1 } }, base: { riskMode: 'percent', riskValue: 1, maxLeverage: 1 }, method: 'grid', seed: '42', maxAttempts: 100, budgetMs: 60_000, workers: 2, metric: 'expectancy', minTrades: 1, balance: 10_000, costs: { feeRate: 0, feePerUnit: 0, spreadPct: 0, slippagePct: 0 }, pointValue: 1, sizeStep: null, minSize: null, ...overrides };
}
