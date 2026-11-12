# Backtester audit — 2026-10-08

Audited version: Midorii 0.7.1, current working tree, including the uncommitted changes present when the audit started. This report supplements the older audit. No product code was changed, and no commit was made.

The main conclusion is that several results can be materially wrong even though the regular test suite passes. Correct the sizing contract, chronological fill handling, history-prefix behavior, trailing initialization, and run metadata before relying on comparisons between backtests and bots.

## Scope and executed checks

Reviewed the backtest loop, broker, summary arithmetic, shared risk sizing, all 13 registered strategies, their detector and aggregation seams, parameter expansion and ranking, sweep runner and worker protocol, backtest form and trade review, run and sweep stores, and the relevant data-loading paths. Also checked the composition root, architecture rules, build configuration, existing tests, and the earlier audit's claims.

| Check | Result |
| --- | --- |
| `npm run typecheck` | Passed |
| `npm run lint` | Passed |
| `npm run test` | 255 files and 3,232 tests passed |
| `npm run build` | Passed, including library declarations |
| App Vite production build | Passed; large application bundle warning |
| Additional strategy audit probes | 9 tests passed, including full-history/prefix comparisons and actual strategy executions |
| Additional direct engine probes | Executed; the failure cases described below were reproduced |
| Browser runtime | Actual backtest view, real historical candles, actual clicks, resolved background and nonempty layout verified |

The first test run failed before executing tests because the sandbox's temporary cache could not rename files. Setting the temporary directory to an isolated repository-local directory resolved that environmental problem. The full suite then passed.

The public Binance request failed in this execution environment. Runtime checks used the existing local Binance archive for 2026-08-01 through 2026-08-14. Each strategy ran on its preferred timeframe. RSI-Dip and TBR9 also ran over 210,515 real NQ five-minute bars from the local archive. They produced 24 and 302 closed trades respectively with costs disabled, so their checks did not rely on empty signal arrays.

The browser used the real `mountBacktestView` with an isolated bridge serving those historical bars and recording save requests. It did not write to the user's run library. The Electron IPC round trip, live venue execution, and packaged Electron window were not exercised. The run stores were tested directly against isolated files.

The additional probes intentionally assert the current faulty behavior to document reproducible evidence. They are not fixes or permanent regression tests. Prefix checks were targeted samples, not an exhaustive proof across every parameter combination and every historical bar.

## High-priority findings

### F01 — Contract multipliers scale P&L but do not scale backtest order sizes

**Priority: P1. Reproduced through a registered strategy.**

Sources: `shared/strategies/risk.js:203`, `shared/engine/backtest.js:205`, `app/renderer/strategies/openingRange.ts:322`, `app/renderer/bot/botContext.ts:204`.

Strategies compute size in price units. The backtest forwards that size unchanged to a broker that multiplies P&L and notional by `pointValue`. The current bot context divides outgoing size by `pointValue` and normalizes the sizes exposed to strategies. The backtest context does neither.

Reproduction: starting equity 10,000, intended risk 1%, stop distance 0.20, point value 20. ORB sends approximately 500 units and loses 2,000 at the stop. The intended loss is 100, corresponding to approximately 25 physical contracts before any size-grid adjustment. The leverage ceiling has the same missing conversion. Stopless strategies also calculate their size from equity divided by price without accounting for the multiplier.

Recommendation: define one sizing-unit contract for both contexts and apply instrument conversion at the same seam. Given the current bot implementation, normalize outgoing and reported sizes in the backtest context consistently. Cover risk sizing, leverage sizing, reversals, pending orders, and grid rejection with parity tests.

### F02 — Session and higher-timeframe signals are not stable as history grows

**Priority: P1. Reproduced on synthetic and real historical data.**

Sources: `src/core/analysis/openingRange.ts:224`, `src/core/analysis/intradayWindows.ts:230`, `src/core/analysis/aggregate.ts:56`, `src/core/analysis/aggregate.ts:89`, `src/core/analysis/rsiDip.ts:88`, `src/core/analysis/morningBook.ts:93`.

Four concrete discrepancies were found:

- **ORB:** the detector requires a bar after the range before emitting an event stamped on the range's last bar. At decision index 34, full-history detection contains the setup but a prefix ending at 34 does not. The registered strategy makes one trade in the full backtest and zero when rebuilt at each closed-bar prefix. It also uses the future-derived `sessionEndIndex` to schedule its exit.
- **Intraday Momentum:** the detector requires a future traded-window bar before it emits the event stamped on the preceding bar. At decision index 379, full history contains the event and the current prefix does not. Real Binance history shows the same discrepancy. The event also exposes the future `tradeReturn`, although the current strategy does not use that return to select direction.
- **RSI-Dip:** `sessionBars` treats the current session's last available bar as its daily close. Three tested NQ prefixes produce a dip signal half an hour before the full-history signal. Full detection has no dip event at those earlier indices. A running strategy can arm a next-session entry from a daily signal that has not actually closed.
- **Morning Book:** the final higher-timeframe bucket is included while incomplete. Real-history prefixes produce oscillator crossings at indices 194, 210, and 394; full history places those crossings one five-minute bar later. The sampled early crossings were not entry signals, so an extra entry was not demonstrated. Crossing timing can also affect exits.

The existing look-ahead test samples five broad prefixes and compares event identity rather than all execution-relevant payload fields. Its 45-day series does not activate the default 200-session RSI signal. It therefore misses these cases despite passing.

Recommendation: emit actionable events as soon as their actual inputs are complete; derive session exits from the clock/calendar rather than future array endpoints. Exclude incomplete daily and higher-timeframe input bars. Compare both directions of prefix invariance at actual decision bars and inside incomplete aggregates. Test the resulting order stream through both contexts, including false early signals that later disappear.

### F03 — Pessimistic ranking overrides events known to occur at the open

**Priority: P1. Reproduced.**

Source: `shared/engine/broker.js:936`.

The coarse fill path ranks all triggered orders by adversity, including orders already executable at the opening price. Pessimism should resolve unknown intrabar order, not reverse a known opening event.

Two reproductions with costs disabled:

| Existing long entry | Pending exits | Next bar O/H/L/C | Actual | Chronological result |
| --- | --- | --- | --- | --- |
| 100 | Stop 90, target 110 | 120 / 125 / 80 / 100 | Stop at 90, P&L −10 | Target executes at open 120, P&L +20 |
| 100 | Stop 90, market session close | 105 / 110 / 85 / 100 | Stop at 90, P&L −10 | Market close at open 105, P&L +5 |

Recommendation: resolve market orders and levels already marketable at the open first. Apply conservative ranking only to genuinely unordered later touches. Add cases with both placement orders and with/without sub-bars.

### F04 — Partial fine-bar coverage silently removes reachable fills

**Priority: P1. Reproduced.**

Sources: `shared/engine/backtest.js:299`, `shared/engine/broker.js:884`, `shared/engine/backtest.js:284`.

Any nonempty sub-bar bucket replaces the entire parent bar. Coverage is not checked. With a parent bar O/H/L/C of 100 / 120 / 80 / 100 and a lone supplied fine bar of 100 / 105 / 100 / 100, an entry with stop 90 and target 110 remains open. The parent bar reaches both levels, but neither is examined. The run is still labeled `intrabar`.

Recommendation: validate fine-bar interval and coverage against the instrument's expected trading schedule. Reject inconsistent inputs or use an explicitly reported conservative fallback. Persist actual fine/coarse/mixed coverage, rather than inferring the run label from the mere presence of `baseBars`.

### F05 — Mutable form state can corrupt displayed and saved run identity

**Priority: P1. Reproduced with actual browser clicks.**

Sources: `app/renderer/backtest/backtestView.ts:816`, `:880`, `:923`, `:1010`, `:1978`, `:2018`.

Market, timeframe, strategy, and numeric inputs remain editable while loading or sweeping. Async execution later reads the mutable form again. Results also render their identity and settings from the current form instead of a captured run configuration.

Browser reproduction: start a BTCUSDT 15m run and switch the market while data is loading. Both candle requests still name BTCUSDT; the completed save request names the other market. A separate reproduction changes the market after completion: the same three BTCUSDT trades and −201.55 result are immediately relabeled under the new market. No new run is performed.

Recommendation: capture an immutable run request before the first await and use it for loading, strategy construction, worker requests, persistence, result captions, settings, and trade review. Disable or clearly separate edits during execution. After completion, render from the captured result identity or clear an invalidated result.

### F06 — Automatic trailing can inherit a price from before entry

**Priority: P1. Reproduced.**

Sources: `shared/engine/broker.js:810`, `:898`, `:1539`.

`setTrailing` seeds its extreme from `lastPrice`. During bar processing that is still the previous parent bar's close. A newly opened position can therefore inherit favorable ground reached before it existed, including a price above the current bar's high.

Reproduction: previous close 130; a buy limit fills at 100 with stop 95. The fill bar reaches high 106, low 99, close 105. With trailing activation 1R and distance 1R, the broker places the stop at 125. The observed high supports only 101. The next bar opens at 108 with low 106, and the erroneous stop exits the trade at 108 even though the valid trailing level was never touched.

Recommendation: initialize automatic trailing from prices observed since the position opened, with consistent per-step marking. Test gap entries and limit entries, including multiple fine bars inside one parent bar.

## Other reproduced defects

| ID / priority | Source | Evidence and impact | Recommended correction |
| --- | --- | --- | --- |
| F07 / P2 | `shared/engine/broker.js:1390` | A reversal charges the entire reversing fill's fee to the old trade and gives the new position zero entry fees. With one-unit commission per side, buy 1 at 100, sell 2 at 102, buy 1 at 100 yields trade nets **−1 and +1** instead of **0 and 0**. Total account P&L is correct; win/loss counts and per-trade statistics are not. Partial reductions similarly front-load all accumulated entry fees. | Allocate entry and exit fees proportionally between the closed and retained/opened quantities. |
| F08 / P2 | `shared/engine/broker.js:1216` | `_openSizeFor` does not require the reducing side to oppose the position. A buy marked `reduceOnly` changes an existing long from size 1 to size 2. This violates the broker contract; the shipped strategies did not demonstrate this malformed call. | Validate direction before execution; cancel/refuse same-side reductions and never charge a fill fee for an order that cannot reduce. |
| F09 / P2 | `shared/engine/broker.js:1038` | Spread is added after a limit triggers. A buy limit 100 with 2% spread fills at **101**. The simulation violates the submitted limit price. | Define the quote convention and use bid/ask-aware trigger prices or a cost model that respects limit bounds. |
| F10 / P2 | `shared/engine/broker.js:951` | A fine OHLC bar does not reveal its internal path, but this branch bypasses adverse ranking. The same minute touching stop 90 and target 110 produces **+10 or −10** solely from exit placement order. Without sub-bars both produce −10. Default attached brackets happen to place the stop first; custom order placement exposes the defect. | Preserve conservative handling inside the finest available OHLC bar after known opening events are resolved. |
| F11 / P2 | `shared/analysis/sweep.js:48` and `:80` | `expandRange(0.25, 0.65, 0.1)` returns **0.3, 0.4, 0.5, 0.6, 0.7**. `1e-7` through `3e-7` in `1e-7` steps returns **0, 0, 0**. Sweeps alter requested values, exceed their endpoint, or repeat the same combination. | Preserve the precision of the start and step, handle exponent notation before the decimal-point check, and verify final bounds. |
| F12 / P2 | `app/electron/data/store/runStore.js:56` and `:204` | Concurrent saves share `index.json.tmp` and race through read/modify/write. Six concurrent save requests produced six files but five rejected saves in one run; another run produced one rejected save. A repeated run against an existing store also left most new runs out of the index. Sweep store uses the same pattern; its race was identified by inspection rather than separately reproduced. | Serialize per-store mutations, use unique temporary filenames, and protect the complete file/index transaction. Unique temp names alone do not fix lost index updates. |
| F13 / P2 | `src/core/analysis/openingRange.ts:207` | Starting history at 09:32 New York emits an opening range built from **three bars** while configured as five minutes. The implementation does not enforce the documented complete-range condition. | Check the opening timestamp, final boundary, and missing bars before emitting a range. |
| F14 / P2 | `app/electron/data/store/barStore.js:355` | `dropIncomplete` checks the trailing bucket, but every interior bucket flushes unconditionally. Minutes 0, 1, and 5 produce a supposedly completed 5m candle from only the first two minutes. If data is gapped, that candle can be treated as representative of a full interval. | Track coverage per bucket and distinguish actual session closure from missing data. Report gaps rather than silently relabeling partial intervals. |
| F15 / P3 | `shared/engine/backtest.js:222` and `:249` | After a three-bar run, `onFinish` receives index **3**, `bar` is undefined, and reading `time` throws. `init` receives index 0 even if trading starts at a later warm-up boundary; an order from it fills at that later boundary's open. None of the shipped strategies currently uses these hooks. | Specify initialization semantics and bind completion to the last valid bar. Test empty-after-warm-up runs and orders placed by hooks. |
| F16 / P3 | `app/renderer/backtest/sweepRunner.ts:306` | Cancellation is checked in the training loop but not during winner verification. A stop requested by the last training progress callback still returns a completed sweep with OOS entries. Browser cancellation during a long OOS calculation was not separately timed. | Yield/check cancellation between OOS evaluations and report that phase in progress. |

## Reporting and model decisions

These items affect interpretation or trust but should not be presented as newly introduced code regressions.

- **Profit-factor ranking:** an all-winning run has `profitFactor = null`, and `rankResults` sorts null last. A 20-trade all-winning result therefore ranks behind a finite profit factor of 2. This is an explicit current ranking policy, but it conflates an undefined metric with a known no-loss result. Represent those states separately and document a minimum-trade or regularization policy.
- **Instrument costs cannot be calibrated in the form:** the engine supports `feePerUnit`, but the view offers only crypto defaults or all costs off. It also omits price tick size, conservative limit-fill selection, and financing/funding. Add instrument profiles with editable commission and execution assumptions.
- **Drawdown is sampled at strategy-bar closes:** a position can lose 500 inside a bar, recover by the close, and report maximum drawdown 0. Decide whether the metric means close-to-close drawdown or intrabar account stress and label it accordingly. Existing values are not intrabar worst-case loss.
- **There is no margin/liquidation model:** leverage limits sizing but does not liquidate an existing position. Financing, funding, borrow constraints, holidays, half days, and session-aware larger-bar boundaries are also absent or incomplete. Leveraged futures/CFD/perpetual results remain simplified simulations even after the coding defects are corrected.
- **Single-run warm-up is inside the selected interval:** the UI loads no prior history and supplies no `tradeFrom`. For a 200-session detector, much of the requested interval cannot trade. The engine's OOS warm-up support does not solve that UI behavior. Load explicit detector prehistory and show the effective trading start.
- **Open-position and closed-trade metrics describe different things:** final equity and return include unrealized P&L, while expectancy and profit factor use closed trades. A run with only an open position is not filed by the single-run UI. Show the open exposure and valuation policy explicitly, and decide whether that run deserves persistence.
- **Stored execution assumptions are incomplete:** the engine result records costs and size rules but not `limitFillMode`, position mode, or resolved management. The current UI cannot select the alternate limit mode, but direct engine callers can create results that cannot later be distinguished reliably. Store every effective assumption plus app/strategy version and data identity.
- **OOS counts include warm-up:** a 50-bar probe reports train 30 and test 50, although only 20 bars belong to the test interval. Existing tests explicitly accept this convention. Separate warm-up input count from actual OOS trading-bar count.
- **Stored curves preserve balance changes, not complete equity paths:** condensation removes unrealized peaks and troughs. This is consistent with the UI's intentional balance sparkline, but it cannot support a reconstructed equity/drawdown graph. Keep that distinction explicit. Preserve extrema when adding equity analysis.

## Optimization opportunities

Correctness work should precede speed work. Optimize at the existing engine, detection-cache, and worker seams rather than duplicating strategy logic.

| Order | Change | Evidence / benefit | Constraint |
| --- | --- | --- | --- |
| 1 | Add a statistics-only backtest output mode for sweeps | Every sweep combination constructs full per-bar equity plus order/fill logs and then discards nearly all of them. A 500,000-bar no-trade probe allocated approximately **69 MiB** without fine bars and **119 MiB** with them. | Keep identical accounting and metrics; preserve detailed output for single-run review. |
| 2 | Store fine-bar lookup bounds instead of sliced arrays; share prepared lookup across combinations | The fine-bar benchmark took approximately **75 ms** versus **36 ms** without finer data, before any strategy detection or trades. The difference includes one array per parent bucket. | Benchmark realistic 5m/1m runs too; these timings are a one-process allocation probe, not a speedup guarantee. |
| 3 | Cache clock/session preparation across detector keys | On 210,515 NQ bars, RSI detection took approximately **1.2 s**, while its engine pass took **19 ms**. TBR detection took approximately **1.25 s**, with a **23 ms** engine pass. Repeated timezone and session preparation is a larger target than small broker arithmetic. | Key by bars, timeframe, zone, and session settings; never reuse prepared values against another history. |
| 4 | Group sweep combinations by detection key and bound the detection cache | The current cache retains every unique detection for the whole training run. A detector-heavy sweep can retain many large clock/series objects. | Preserve deterministic ranking and release a group only after all dependent combinations finish. |
| 5 | Count ranges arithmetically before expanding them | `countCombinations` and `detectionCount` call `expandRange`, so a malformed tiny step allocates a huge axis before `MAX_COMBINATIONS` rejects the sweep. The UI does this during edits. | Use bounded arithmetic with overflow handling and the corrected range semantics from F11. |
| 6 | Put single runs on a worker and update progress/status incrementally | `buildStrategy` and `runBacktest` are synchronous on the renderer thread. `nextFrame` only paints before the block. Progress also rebuilds the whole form via `paint()`. | Reuse worker infrastructure; preserve an immutable request and provide real cancellation points. |
| 7 | Avoid repeated OOS verification and binary-search sorted range slices | Overlapping best/worst selections can verify the same combination twice. `sliceBars` scans arrays linearly for every slice. | Memoize by resolved parameters within one test-history identity. |
| 8 | Measure and reuse detector preparation in the live path | The bot rebuilds strategies on growing history for every closed bar. The measured detection/engine difference makes this a plausible latency target. | Incremental detectors must pass full-history/prefix and order-stream parity tests first. |
| 9 | Split large UI modules and lazy-load expensive surfaces | App build produces an approximately **2.23 MB** main JavaScript chunk, about **646 kB** gzip, and emits a size warning. | Measure startup/interaction latency before deciding which modules to split. |

Further research capabilities worth adding after the execution model is reliable: cost sensitivity at realistic instrument fees, walk-forward evaluation, parameter-neighborhood stability, risk-normalized ranking, MAE/MFE and drawdown duration, trade exports, and comparison of predicted fills with recorded paper/live fills. These are separate capabilities, not evidence that current strategy settings are profitable.

## Recommended repair sequence

1. Fix the sizing-unit contract and freeze run requests/results. These changes should have small, focused parity tests.
2. Repair opening-event priority and trailing initialization. Gate these independently before changing ambiguous intrabar behavior.
3. Establish completed-input and prefix invariance for ORB, Momentum, RSI-Dip, and Morning Book. Use actual decision timestamps and incomplete aggregate prefixes.
4. Add data/fine-bar coverage checks, then correct fee allocation, limit bounds, and reduce-only validation.
5. Correct sweep range arithmetic and serialized persistence. Add simultaneous-save tests and precision-boundary tests.
6. Finish lifecycle, OOS cancellation, and execution metadata. Document the remaining model assumptions.
7. Add statistics-only execution, shared preparation, bounded caches, and worker/UI optimizations. Measure before and after on the same datasets and assert identical outputs.

The next implementation should replace each audit reproduction with a failing permanent regression test before fixing its cause. No fixes or commits are included in this audit.
