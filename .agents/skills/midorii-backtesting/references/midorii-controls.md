# Midorii research controls

This skill is scoped to the Midorii repository. Treat the app's current tool and
parameter schemas as authoritative; the examples below are not recommended settings.

## MCP sweep workflow

1. Inspect datasets and the chosen strategy with `midorii_list_datasets` and
   `midorii_get_strategy`. Obtain required user inputs before execution.
2. Call `midorii_start_sweep` with the shared execution settings and `ranges`.
   Fixed settings go in `params`, not `base`. Dates are UTC epoch milliseconds
   with an exclusive `to`; a canonical timeframe of `"5"` means five minutes.
3. Poll `midorii_get_sweep` using the returned job `id`. Progress includes
   `done`, `total`, elapsed time, and an estimate when available. Start only one
   MCP research job at a time, including single backtests.
4. When completed, use `job.sweep.id` with `midorii_get_sweep_result` to read the
   saved result. The job id and the saved sweep id are different. Page through
   `results` with `offset` and `limit`; rows are in combination order, not ranking
   order. `best` and `worst` hold the ranked candidates and their validation figures.
5. `midorii_list_sweeps` reads the durable library. `midorii_cancel_sweep` stops
   unfinished computation; it discards partial results. If computation already
   finished, its final save can complete. Closing Midorii also stops unfinished MCP
   jobs. Saved sweeps remain under **Analysis → Sweeps** after restarting.

Numeric ranges use `{ "from": ..., "to": ..., "step": ... }`, with a positive
step and ascending endpoints. The upper bound is inclusive when the step lands on
it. At most eight axes and 5,000 combinations are accepted. Whole-number fields
need whole-number endpoints and steps. Numeric, schema-bound values only; use fixed
`params` for choices and toggles.

`trainFraction` defaults to 0.7. Set it to zero only for an explicitly exploratory
run with no validation claim. Other supported fractions range from 0.1 to 0.9.
The native engine checks only the displayed best/worst candidates out of sample;
`showCount` defaults to five per end, up to twenty. Other training rows have no
out-of-sample evidence. `minTrades` is a training filter. `metric` accepts
`expectancy`, `netPnl`, `profitFactor`, or `returnPct`. `timeoutMs` defaults to
600,000 and cannot exceed 3,600,000. Check costs and instrument sizing explicitly.

## FVG examples

| Strategy id | Attribute | Unit | Example range |
| --- | --- | --- | --- |
| `silverbullet` | `minGapSize` | Fixed by `minGapSizeUnit`: `points` or `percent` | `{"from":0.5,"to":2,"step":0.5}` |
| `amdfvg` | `fvgAtr` | ATR multiple | `{"from":0.05,"to":0.25,"step":0.05}` |
| Either, when its schema permits it | `rrr` | Target distance / stop distance | `{"from":1,"to":3,"step":0.5}` |

For example, the two `amdfvg` ranges above produce 25 combinations. Keep
`riskMode`/`riskValue` fixed to the user's input and supply the selected asset,
dates, balance, costs, and contract sizing separately. Do not copy example
values over explicit user choices. Read current schemas before using these keys.

In **Backtest → Sweep**, numeric attributes have a **Vary** control with `from`,
`to`, and `step`. Signal attributes can be under the advanced signal section.
In **Search jobs**, numeric ranges or allowed lists become axes; grid/random
searches keep all saved attempts and use training/validation/final partitions.
Read `docs/user/offline-search.md` from the repo root for that workflow and
`docs/user/mcp.md` for connection and execution details. Use an available
computer-use skill for UI control and verify actual visible results.

## Daily entry limits are not interchangeable

`app/renderer/strategies/liveGuards.ts` defines `maxTradesPerDay` for trading bots;
it is not part of the historical sweep/backtest execution options. The MCP schema
rejects an invented top-level `maxTradesPerDay`. Sweeping a guard name does not
enable it. Never start a bot to work around this limitation.

Some strategies enforce narrower limits themselves: `vwapreversion` has
`maxEntries` per session; `openingrange` places one order per session. Inspect
their day/session definitions and actual entry timing before equating either to
the user's daily cap. A single open position, one order per signal window, or
low historical trade frequency does not establish a calendar-day entry limit.

If a requested strategy cannot enforce the user's cap in historical execution,
report that blocker instead of running an unconstrained profitability search.
Do not post-filter trades or change the engine/strategy without the corresponding
development request. A cap violation cannot be repaired by hiding the extra trades.
