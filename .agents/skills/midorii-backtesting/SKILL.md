---
name: midorii-backtesting
description: Search for and compare profitable Midorii strategies on historical data, including parameter sweeps and FVG-size ranges. Ask for missing risk per trade, asset, and maximum trades per day before running research. Use for backtesting and strategy optimization, never real-account execution.
---

# Midorii backtesting

Find reproducible strategy candidates that remain profitable after costs on data
that did not select their settings. A successful outcome can also be an honest
finding that no tested candidate qualifies. This skill does not authorize real
trades, live-account arming, or trading-bot starts through any interface.

## Collect the required inputs before running anything

Read the prompt and the human's established choices in this conversation first.
Require all three inputs before preparing a search job, running a sweep or backtest,
or allocating a research budget:

- **Risk per trade:** the amount and its unit, such as 0.5% of simulated equity or
  100 USD. Clarify whether a bare number means cash, percent, or position quantity.
  Obtain the simulated starting balance when percentage risk needs it. Fixed
  contract quantity is not the same as the app's fixed-cash risk setting.
- **Asset:** the exact market/dataset and contract where relevant. Do not silently
  substitute a micro contract, a recording, a different venue, or another asset
  whose name merely contains the requested symbol.
- **Maximum trades per day:** a positive whole-number entry cap, or an explicit
  request for no limit. Never infer unlimited trading from an omitted value.

Ask only for missing or ambiguous items, together in one concise question, in the
user's language. For example: "Which asset, how much risk per trade (cash or
percentage), and how many entries per day at most?" If two are already supplied,
ask only for the third. An unanswered question is not permission to guess. Read-only
connection, dataset, and parameter-schema inspection may proceed while waiting.
Creating or editing this skill is not itself a request to launch a strategy search.

## Verify the constraints and data

Call `midorii_status`, `midorii_list_datasets`, and `midorii_get_strategy` or
`midorii_list_strategies`. Use the schemas and stored coverage returned by the app.
For control details and range examples, read [Midorii controls](references/midorii-controls.md).

Before launching a run:

- Fix the user's asset, risk mode/value, and daily entry cap. Do not sweep these to
  inflate returns unless the user explicitly requests corresponding ranges. Keep
  leverage within the stated assumptions too.
- Establish the daily boundary; use UTC calendar days unless the user states a
  different boundary, and disclose that choice. Count actual entries, including
  positions still open at the end, rather than exits or closed round trips.
- Verify that the selected strategy's historical execution enforces the cap before
  entries. A bot guard is not automatically a backtest guard. A per-session cap is
  equivalent only if its session boundary and entry semantics fit the requested day.
  Inspect the strategy's actual schema/rules and, when needed, implementation.
  If the requested limit cannot be enforced, explain the missing capability and
  stop dependent runs. Do not invent a `maxTradesPerDay` parameter, assume a one-
  position rule limits daily entries, or remove trades from finished results.
- Check complete bars, requested coverage, data gaps, timeframe, point value, size
  step, minimum size, fees, spread, and slippage. Use documented instrument values
  or ask for missing material assumptions. Never read a real account to obtain
  research capital or credentials. Explain when minimum lot sizes prevent entries.

## Search parameter ranges

Use `midorii_start_sweep` for numeric ranges and the same app engine used by the
Backtest tab. Discover available tools; do not fabricate tool names. If the host
has not loaded the sweep tools, reconnect/reload the project MCP server. The app's
**Backtest → Sweep** and **Search jobs** are alternatives when UI control is available.

Use each parameter's real key, type, bounds, and unit. FVG size may be measured in
points, percent, or ATR depending on the strategy. Keep the unit fixed while comparing
thresholds. In Sweep mode, enable **Vary** for chosen attributes and enter `from`,
`to`, and `step`; fixed fields stay out of `ranges`. Use a small coarse search first,
then inspect a limited finer neighborhood. Avoid adding every attribute as an axis.

State the date split, ranking metric, minimum trade count, and finite search budget
before starting. Respect any budget in the prompt; if omitted, start with at most
100 combinations and 30 minutes of active research in total. Do not launch an endless
loop until something looks profitable. Ranges multiply: count the combinations first.
Stay below the connector's limits and poll the job rather than launching duplicates.

Keep an experiment record with asset, dates, strategy definition, complete fixed
settings, ranges, costs, sizing, daily-cap enforcement, job/result ids, and every
attempt's result or error. Do not overwrite the user's saved strategy defaults just
to test a candidate. Use named research results and preserve unsuccessful attempts.

## Validate before presenting a candidate

Reserve a chronological final period before inspecting outcomes. One useful layout
is 60% training, 20% validation, and 20% untouched final data. For a native sweep,
search only the first 80% and set `trainFraction` to 0.75; inspect the returned
bar-aligned split instead of assuming the arithmetic dates were retained exactly.
The sweep's later period is validation, not an independent final test once it has
helped choose or refine candidates.

Compare validation net P&L after costs, expectancy, profit factor, drawdown, trade
count, and concentration across periods. Inspect neighboring settings and reasonable
cost sensitivity on the development data. A high win rate, one lucky trade, an
isolated parameter spike, or training profit alone does not establish a good strategy.
Declare a sample-size threshold before ranking; label smaller samples inconclusive.

Freeze one candidate before running `midorii_start_backtest` on the reserved final
period. A standalone final backtest starts its own indicator warm-up; disclose it.
Do not extend its range into training and label the combined statistics a final
test. Use the app's **Search jobs** route when a frozen job with shared warm-up and
a reserved final period is needed. Do not tune on the final result and reuse the
same dates as if they were untouched. If the budget ends or none passes, say so.

## Report the evidence

Give the strongest candidates or state that none qualified. Include:

- Exact asset, timeframe, risk per trade, daily entry cap/boundary, and how it is enforced.
- Complete chosen settings and ranges tried, with saved run/sweep ids.
- Separate training, validation, and final dates and metrics; mark any missing check.
- Net P&L after costs, return, maximum drawdown, trade count, expectancy, and profit factor.
- Data, sizing, and cost assumptions; low sample size, open exposure, or other material limitations.

Call a candidate "profitable in the tested period" only when the recorded result
shows it. Do not promise future profitability, silently relax the user's limits,
or turn a research result into a real-account order or bot start.
