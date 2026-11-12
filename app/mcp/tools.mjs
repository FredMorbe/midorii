import { z } from 'zod/v4';
import { ruleStrategySchema } from '../../shared/strategies/rules.js';

const id = z.string().min(1).max(80).regex(/^[a-zA-Z0-9_-]+$/);
const symbol = z.string().min(1).max(100).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/);
const timeframe = z.string().regex(/^(?:[1-9]\d{0,5}|D|W)$/).describe('Fixed intervals: minutes as digits, or D or W. Calendar months are unsupported.');
const time = z.number().int().nonnegative().max(8_640_000_000_000_000).describe('UTC Unix timestamp in milliseconds.');
const params = z.record(z.string().max(64), z.union([z.number().finite(), z.boolean(), z.string().max(1000), z.array(z.string().max(100)).max(64)])).refine((v) => Object.keys(v).length <= 100, 'Too many settings');
const page = { offset: z.number().int().nonnegative().max(1_000_000).default(0), limit: z.number().int().min(1).max(500).default(100) };
const read = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const execution = {
  strategy: id, params: params.default({}), symbol, timeframe, from: time, to: time,
  balance: z.number().positive().max(1e12).default(10_000),
  costs: z.object({ feeRate: z.number().min(0).max(1).optional(), feePerUnit: z.number().min(0).max(1e6).optional(), spreadPct: z.number().min(0).max(1).optional(), slippagePct: z.number().min(0).max(1).optional() }).strict().optional(),
  pointValue: z.number().positive().max(1e9).default(1),
  sizeStep: z.number().positive().nullable().default(null), minSize: z.number().positive().nullable().default(null),
  intrabar: z.boolean().default(true), note: z.string().max(2000).default(''),
};
const ranges = z.record(z.string().min(1).max(64), z.object({
  from: z.number().finite(), to: z.number().finite(), step: z.number().positive(),
}).strict()).superRefine((axes, ctx) => {
  const entries = Object.values(axes);
  if (entries.length < 1 || entries.length > 8) ctx.addIssue({ code: 'custom', message: 'Choose between one and eight numeric ranges.' });
  let count = 1;
  for (const axis of entries) {
    const length = Math.floor((axis.to - axis.from) / axis.step + 1e-9) + 1;
    count *= length;
    if (axis.to < axis.from || !Number.isFinite(length) || length < 1 || length > 5000 || count > 5000) {
      ctx.addIssue({ code: 'custom', message: 'Ranges must ascend and contain at most 5,000 combinations in total.' });
      break;
    }
  }
});

/** The only operations reachable from an agent. There is no general IPC or code-execution tool. */
export const TOOLS = {
  midorii_status: { description: 'Check the running Midorii research connection and its enforced no-live-trading policy.', schema: z.object({}).strict(), annotations: read },
  midorii_open_view: { description: 'Show Midorii’s Strategies, Backtest, or Analysis screen. Trading screens and broker controls are unavailable.', schema: z.object({ view: z.enum(['strategies', 'backtest', 'analysis']) }).strict(), annotations: write },
  midorii_list_datasets: { description: 'List saved historical markets, coverage, and base bar intervals. No broker accounts or credentials.', schema: z.object({}).strict(), annotations: read },
  midorii_get_bars: { description: 'Read a page of completed historical bars from the local archive. Range is [from, to).', schema: z.object({ symbol, timeframe, from: time, to: time, ...page }).strict(), annotations: read },
  midorii_list_strategies: { description: 'List built-in and custom research strategies with parameter schemas, saved settings, and readable rules.', schema: z.object({}).strict(), annotations: read },
  midorii_get_strategy: { description: 'Read one strategy, its saved settings and its full custom rule definition, if present.', schema: z.object({ id }).strict(), annotations: read },
  midorii_create_strategy: { description: 'Create a persistent custom research strategy from validated rules, never executable source. Each group ANDs its conditions; groups are ORed. Offsets refer only to past bars. Custom strategies cannot run trading bots.', schema: z.object({ definition: ruleStrategySchema }).strict(), annotations: write },
  midorii_update_strategy: { description: 'Replace an existing custom research rule definition. Built-in strategies cannot be replaced. Completed runs retain the definition they tested.', schema: z.object({ definition: ruleStrategySchema }).strict(), annotations: write },
  midorii_save_strategy_settings: { description: 'Save a strategy’s validated research defaults and timeframe. Existing bots keep their own settings.', schema: z.object({ id, params, timeframe }).strict(), annotations: write },
  midorii_start_backtest: { description: 'Start an asynchronous backtest on saved historical data using Midorii’s real engine. Returns a job id; poll midorii_get_backtest until completed or failed. Completed results are filed in the app library, including zero-trade runs. No live execution is available.', schema: z.object(execution).strict(), annotations: write },
  midorii_get_backtest: { description: 'Read the status, error, and saved run summary of an asynchronous backtest.', schema: z.object({ id }).strict(), annotations: read },
  midorii_list_runs: { description: 'List saved backtest results in Midorii’s run library, newest first.', schema: z.object(page).strict(), annotations: read },
  midorii_get_run: { description: 'Read a saved backtest’s stats, tested settings, custom strategy snapshot, and a page of trades. Only historical backtests are exposed.', schema: z.object({ id, ...page }).strict(), annotations: read },
  midorii_start_sweep: { description: 'Run Midorii’s native historical parameter sweep over numeric from/to/step ranges, including FVG-size filters. Fixed params seed all combinations. At most 5,000 combinations; one research worker at a time. Winners and losers receive an out-of-sample check when trainFraction is nonzero. Poll midorii_get_sweep. Completed sweeps appear under Analysis → Sweeps. Does not start bots or enforce bot-only daily trade guards.', schema: z.object({
    ...execution, ranges,
    trainFraction: z.union([z.literal(0), z.number().min(0.1).max(0.9)]).default(0.7),
    metric: z.enum(['expectancy', 'netPnl', 'profitFactor', 'returnPct']).default('expectancy'),
    minTrades: z.number().int().min(1).max(1_000_000).default(10),
    showCount: z.number().int().min(1).max(20).default(5),
    timeoutMs: z.number().int().min(1000).max(3_600_000).default(600_000),
  }).strict(), annotations: write },
  midorii_get_sweep: { description: 'Read a sweep job’s status, progress, saved summary, or error. Job ids expire when Midorii closes; completed sweep ids persist.', schema: z.object({ id }).strict(), annotations: read },
  midorii_cancel_sweep: { description: 'Cancel an unfinished historical sweep and release its worker. Partial results are discarded. This cannot affect trading bots, orders, or accounts.', schema: z.object({ id }).strict(), annotations: write },
  midorii_list_sweeps: { description: 'List saved parameter sweep summaries from Midorii’s sweep library, newest first.', schema: z.object(page).strict(), annotations: read },
  midorii_get_sweep_result: { description: 'Read a completed sweep by its saved sweep id: ranges, resolved base settings, costs, split, best/worst candidates with out-of-sample stats, and a page of training results. Training rows are in combination order; only the displayed best/worst candidates have out-of-sample results. These checks are validation, not an untouched final test.', schema: z.object({ id, ...page }).strict(), annotations: read },
};

export function toolInput(name, input) {
  if (!Object.hasOwn(TOOLS, name)) throw new Error('Unknown research tool. Live trading and arbitrary commands are unavailable.');
  return TOOLS[name].schema.parse(input);
}
