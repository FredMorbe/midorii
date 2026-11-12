# Control Midorii through MCP

The local MCP connector lets an agent create research strategies, configure built-in
strategies, run historical backtests, and read results from Midorii's library. Midorii
must be running. The connector uses the same strategy builders, backtest engine,
historical archive, and result store as the desktop app.

Agents must never execute trades on real accounts. The connector has no tools for
broker credentials, account arming, orders, or bot starts. It rejects unknown commands
and fields. Custom rule strategies are research only and cannot start trading bots.

## Set up Codex

From the Midorii checkout, run:

```sh
npm install
npm run mcp:setup
npm run app
```

Open a new Codex session in this project to load the tools. `mcp:setup` adds the
`midorii` server to the project's local `.codex/config.toml`. It preserves other
settings and leaves global configuration unchanged. Run `codex mcp get midorii`
from the project to inspect the registration.

Other local MCP clients can launch `node` with the absolute path to
`app/mcp/server.mjs` as its argument. The server uses stdio. Launch the script directly;
`npm run mcp` adds npm output to stdout, which some MCP clients cannot parse.

The desktop app writes its local connection information to `.midorii/mcp.json` in a
development checkout. A packaged app writes `mcp.json` in its user-data directory;
pass that path using `--connection <path>`. Connection files contain a temporary
authentication token. They are local, ignored by Git, and denied by the development
web server. The app listens only on `127.0.0.1`, rejects browser origins, and removes
its connection file when it closes.

## Research workflow

1. Call `midorii_status` and `midorii_list_datasets`. Check the actual dates and base
   interval of the saved market you want to test. Import or download missing history
   through Midorii first; the connector does not fetch from a broker or exchange.
2. Call `midorii_list_strategies` or `midorii_get_strategy`. Read the parameter schema
   before supplying settings. `midorii_save_strategy_settings` saves research defaults
   and a bar interval; existing bots retain their own copied settings.
3. Create a custom rule strategy with `midorii_create_strategy`, or replace an existing
   custom definition with `midorii_update_strategy`. Built-in definitions cannot be
   replaced. Custom strategies appear in **Strategies** and **Backtest**.
4. Call `midorii_start_backtest`. Supply a saved symbol, a canonical bar interval
   (`"5"` means five minutes), and UTC timestamps in milliseconds. The range is
   limited to fixed intervals: minutes, `D`, or `W`; calendar months are unsupported.
   Dates use `[from, to)`. Review balance, costs, point value, size step, and minimum size.
   Omitted cost fields use the app engine's defaults. A run starts from saved strategy
   defaults with your supplied parameters applied on top.
5. Poll `midorii_get_backtest` with the returned job id until its status is `completed`
   or `failed`. One MCP backtest runs at a time, in a separate worker, with a ten-minute
   limit and at most 500,000 strategy bars. Closing Midorii stops an unfinished run.
6. Call `midorii_get_run` with the completed run id. It returns the tested settings,
   cost assumptions, statistics, coverage information, saved custom definition, and
   a page of trades. `midorii_list_runs` lists results. Pages accept `offset` and
   `limit`, with at most 500 rows.
7. Use `midorii_open_view` with `strategies`, `backtest`, or `analysis` to show the
   corresponding screen in Midorii. Select a saved result in **Analysis** to inspect it.

Completed MCP runs are filed even when they take no trades. Job ids expire when the
app closes; saved run ids remain available after a restart. Updating a strategy does
not change a completed run's definition. Coverage reports a truncated start or end;
it does not establish that every expected market session is present in the archive.

## Run parameter sweeps

Call `midorii_start_sweep` with the same execution settings as a single backtest,
plus numeric `ranges`. For example, on `amdfvg`, vary the FVG threshold and target:

```json
{
  "fvgAtr": { "from": 0.05, "to": 0.25, "step": 0.05 },
  "rrr": { "from": 1, "to": 3, "step": 0.5 }
}
```

Place this object in `ranges`, and keep fixed settings in `params`. These axes
produce 25 combinations. Read the strategy schema first: FVG units differ between
strategies. Numeric fields with whole-number steps need whole-number ranges.
The connector accepts up to eight axes and 5,000 combinations, retaining every
combination in the saved result. Invalid keys and out-of-bounds values are refused
before a worker starts. A sweep and a single MCP backtest share one worker slot.

Poll `midorii_get_sweep` with the returned job id. Its `progress` reports completed
combinations. When finished, use `job.sweep.id` with `midorii_get_sweep_result` to
read ranges, resolved fixed settings, costs, the date split, ranked candidates, and
paged training results. `midorii_list_sweeps` lists the same saved library shown in
**Analysis → Sweeps**. A saved custom definition stays attached to the sweep.

`trainFraction` defaults to 0.7; zero disables the later-period check. The best and
worst candidates receive out-of-sample statistics; other training rows do not.
`metric`, `minTrades`, and `showCount` control ranking. Validation used to select
or refine parameters is not an untouched final test. Keep separate dates for that
check before choosing a candidate. The default runtime limit is ten minutes;
`timeoutMs` can extend it to one hour. `midorii_cancel_sweep` stops unfinished
computation and discards partial results. A final save can complete if computation
has already finished. Closing the app stops unfinished MCP sweeps too.

The project skill [midorii-backtesting](../../.agents/skills/midorii-backtesting/SKILL.md)
guides bounded strategy searches and asks
for missing risk per trade, asset, and maximum daily entries before running them.
It uses only historically enforceable daily caps: bot guards are not automatically
applied to backtests or sweeps. Agents must not substitute an unrestricted run.

## Define a custom strategy

This example buys a fast average crossing above a slow average and sells the reverse
cross. It is a connection example, not an optimized strategy.

```json
{
  "id": "custom_ema_crossover",
  "name": "EMA Crossover Research",
  "description": "Historical EMA cross example with an ATR stop.",
  "timeframe": "5",
  "indicators": [
    { "id": "fast", "type": "ema", "source": "close", "period": 20 },
    { "id": "slow", "type": "ema", "source": "close", "period": 50 }
  ],
  "long": [
    { "all": [{ "left": { "series": "fast" }, "op": "crossesAbove", "right": { "series": "slow" } }] }
  ],
  "short": [
    { "all": [{ "left": { "series": "fast" }, "op": "crossesBelow", "right": { "series": "slow" } }] }
  ],
  "stop": { "type": "atr", "value": 2, "atrPeriod": 14 },
  "maxHoldBars": 100
}
```

Wrap this object in `{"definition": ...}` when calling create or update.

Supported indicators are `sma`, `ema`, `rsi`, `atr`, `highest`, and `lowest`. Sources
are `open`, `high`, `low`, `close`, and `volume`. Periods range from 2 to 5,000 bars.
Indicator ids must be unique and cannot replace a source name. At most 24 indicators
can be defined. Definitions are bounded data descriptors; they contain no executable
JavaScript, imports, or file paths.

Conditions compare a number or a series reference using `gt`, `gte`, `lt`, `lte`, `eq`,
`crossesAbove`, or `crossesBelow`. A reference can include a nonnegative `offset`:
`{"series":"high","offset":1}` reads the previous completed bar. A missing offset
means the current completed bar. Conditions within `all` must all hold; separate
groups are alternatives. `exitLong` and `exitShort` use the same structure.

Stops use `percent`, `points`, or an `atr` multiple. The strategy's settings expose
`stopValue`, `maxHoldBars`, and the shared risk, leverage, reward-to-risk, break-even,
and trailing controls. Entry orders fill on the next bar; protective distances are
anchored to that fill. Exit rules and the hold limit submit a close for the next bar.
Only one position is held at a time, and conflicting long and short entry signals
are skipped. Positions still open at the end remain open in the result.

The same custom definitions also work in parameter sweeps and offline search jobs.
Each search job keeps its own definition snapshot. A backtest reports what happened
on the supplied history under its execution assumptions; it does not establish
future profitability.
