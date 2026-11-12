# Trading bot audit — 2026-10-09

This audit reviews and hardens the current Midorii trading bot implementation. It also adds
the Backtest-to-bot settings workflow. No real broker orders were submitted, changed,
cancelled, or closed. Broker responses in the automated checks are simulated. The Electron
application was not launched with its stored credentials.

The repository already contained uncommitted trading and backtest changes. Those changes
remain in place. Validation covers the resulting worktree, including those earlier changes.

## Scope and result

Reviewed the bot lifecycle, strategy context, pending order identities, paper execution,
Capital.com execution and confirmations, account ownership, persistence, daily guards,
market-data updates, shutdown, credentials boundary, and Backtest/strategy/bot forms.
The review covers the renderer bot and trading modules, Electron Capital.com client,
preload/IPC boundary, runtime stores, strategy settings store, and application window.

The application supports these bot execution paths:

| Execution account | Current support | Important condition |
| --- | --- | --- |
| Local paper account | Supported; simulated execution and restart persistence tested | Uses the selected provider's live feed and local fill model |
| Capital.com demo | Implemented; broker contracts tested with mocks | Requires current account data, hedging, identified ownership, and a protective stop |
| Capital.com live | Implemented; authorization and failure paths tested with mocks | Each start requires explicit live confirmation; never automatically resumes |
| Other broker trading accounts | Not implemented in the bot engine | A market-data provider or chart trading adapter does not imply bot execution support |

This is a code and simulated-runtime audit, not proof of live venue execution or profitability.
The real Capital.com demo/live integration remains unverified against an actual account.

## Findings and changes

P1 denotes a potential wrong-account trade, unintended exposure, lost ownership evidence,
or bypass of a trading limit. P2 denotes a functional or reliability defect.

**P1 status:** All P1 findings listed in this report are fixed in the current worktree.
Targeted tests cover the additional failure cases found during the follow-up review.
Real venue acceptance remains outside this status; no broker trades were executed.

**P2 status:** All P2 findings listed in this report are fixed in the current worktree.
The follow-up review reproduced and corrected incomplete history reloads and delayed form
responses, then reran the settings workflow and all four repository checks.

| Priority | Finding | Result and evidence |
| --- | --- | --- |
| P1 | A bot could start on real money without its own mandatory confirmation | The bot always asks for live confirmation. An unarmed runner refuses before reading positions or opening a feed. Bot persistence tests cover the refusal. |
| P1 | Queued work and delayed login could cross a demo/live credential switch | Mutations carry the armed connection revision through IPC, request queues, retries, and confirmations. An obsolete revision refuses before sending. Connection safety tests cover both a queued stale request and a delayed old login. |
| P1 | Account selection guessed from the preferred account rather than the active session | Account reads identify the session's actual financial account. A re-login that selects another account invalidates the armed revision. Mocked session tests reproduce both cases. |
| P1 | Ownership identifiers were not bound to a financial account and environment | Durable ownership includes both. A bot refuses to reuse unresolved exposure from another or unidentified account. Reads verify the bound account before updating the book. |
| P1 | Netting mode can make a new bot order alter someone else's exposure | Bots require the venue's reported hedging mode. Preferences are read only. Missing or disabled hedging refuses safe startup; controller tests cover it. |
| P1 | A reduce-only request could create another position | Full market reductions call the close endpoint. Partial or resting reductions are explicitly refused. Regression tests check that no opening request occurs. |
| P1 | Local pending order IDs differed from confirmed venue IDs; cancellation used price heuristics | Pending entries retain their local ID and bind to the exact confirmed deal ID. Cancellation before confirmation records intent. Tests cover equal-price unrelated orders, rejection, restored orders, tags, and already filled orders. |
| P1 | A new entry could leave before uncertain ownership was safely written | Entry dispatch awaits durable persistence and checks that the bot still runs before and after that wait. Stop waits for already delivered work and persists confirmed IDs. Disk failure blocks further entries. |
| P1 | Disk write errors were swallowed; corrupted bot definitions looked like an empty list | Flush now rejects failures. Corrupt lists abort loading, and unreadable definitions disable orphan cleanup. Duplicate IDs, including Windows filename case collisions, are refused. Writer and definition-store tests reproduce the old behavior. |
| P1 | Pending entries did not reserve position or daily-trade slots | Both guards include pending non-reduce entries. A controller also blocks new entries while a sent instruction or accepted exposure is still being reconciled. |
| P1 | A fresh receipt timestamp could make an old replayed candle look safe to trade | Entry checks also inspect the candle timestamp and interval. A regression test advances the clock, delivers an old candle, and proves that no entry occurs. Invalid OHLC data and older corrections do not advance the account or freshness state. |
| P1 | Risk sizing omitted the instrument's value in account currency and could round upward | Bot contexts use the account's point value; unknown conversion blocks entries. Bot venue sizing rounds down. Tests verify sizing and the supported minimum/grid behavior. |
| P1 | Shorthand buy/sell protection could be dropped | Stop and target values are normalized into the submitted bracket before entry guards and execution. A context regression test proves both sides retain their protection. |
| P1 | Unprotected Capital bot entries and unknown spreads could pass local guards | Bot entries need a valid stop attached to the opening request. An enabled spread filter requires a finite, ordered quote. Targeted tests prove that unprotected entries and unknown/invalid spreads are refused. |
| P1 | Strategy initialization or execution could fail while new entries continued | Failed initialization ends the runner. An execution failure blocks new entries until restart while exit management remains available. Trimming active detector state also blocks new entries. |
| P1 | Delete/reset could discard unresolved live ownership or race a new start | Exposure and uncertainty prevent destructive ownership removal. Account changes exclude concurrent starts/edits; startup rechecks the exclusion after awaiting Stop or an old runner. A regression test holds Stop and Reset concurrently and proves that startup refuses. |
| P1 | The broker-capable application window could navigate to another document | External navigation, redirects, popups, and webviews are blocked. Unit tests cover development and packaged document boundaries. The existing sandbox, context isolation, and disabled Node integration remain enabled. |
| P1 | An unresolved dealing verdict could be treated as a definitive rejection | Only explicit ACCEPTED or REJECTED verdicts resolve a delivered instruction. Malformed and pending responses throw, preserving uncertainty and blocking replacement entries. Confirmation parser and controller failure tests cover this boundary. |
| P1 | Separate position/order reads could lose a working order's ownership during its fill | Missing source IDs remain owned until a linked position or a confirmed cancellation resolves them. New entries stay blocked during the gap. A test makes the order disappear one read before its position appears. |
| P1 | Malformed exposure snapshots could look like an empty or safe account | The main client rejects absent/non-array books. The controller validates identities, directions, sizes, levels, quotes, and duplicate IDs before applying an exposure snapshot. Malformed reads retain ownership and mark the account stale. |
| P1 | Orphan cleanup could delete unresolved broker evidence or an active Windows filename | Cleanup preserves exposed, uncertain, and unreadable records and compares active IDs without case sensitivity. A real store regression checks each preservation case and still removes an empty orphan. |
| P1 | Financing-distorted unrealized profit could understate automated risk | Bots use a finite positive stated lot value only in matching account currency. Profit-derived estimates remain chart estimates and never size bot entries. Tests check both distorted same-currency profit and unknown conversion. |
| P1 | A failed cancellation could permanently suppress later attempts | The local cancellation flag clears when the attempt settles, including rejection or an unknown outcome. An explicit later cancellation can retry the same confirmed ID; no automatic retry is introduced. Confirmed entries also remain reserved before appearing in the book. |
| P2 | Concurrent strategy saves could overwrite each other | Strategy writes serialize the complete read/modify/write operation. Regression tests cover concurrent saves, a reset queued between saves, and recovery after a failed write without changing committed settings. |
| P2 | REST requests had no finite timeout and concurrent bots could exceed the shared request budget | Requests have a 15-second transport deadline and all REST starts share a 120 ms pacing gate. Tests verify pacing, abort stalled login/create requests at the transport deadline, and prove that a later read can recover. An unknown create outcome is not automatically resent. |
| P2 | Unsupported intervals and a history reload could mutate a stopped runner or lose an active setup | Startup validates declared provider intervals and history integrity. Reloads refuse active detector state, pause feed processing, and verify their lifetime before applying history. Late errors after Stop are ignored. Targeted tests drive each condition. |
| P2 | An incomplete history reload could overwrite a running bot's existing history | A reload validates that it has at least two valid candles before replacing history or its forming candle. A regression reproduces the single-candle response, preserves the count and mark, and then delivers another feed update successfully. |
| P2 | Delayed settings, save, or asset-picker responses could change a different bot's form | Form resets invalidate outstanding operations. Old responses and errors cannot replace the next bot's values or identity, clear its dirty state, or unlock a newer operation. Real browser probes reproduce and verify the delayed-response cases. Editing, reset, and deletion are disabled during load/save. |
| P2 | A failed strategy selection could retain the previous strategy's parameters | Selecting a strategy first installs its own defaults. If saved settings cannot load, the error remains visible and the new strategy keeps those defaults. The browser verifies both the error and actual field value. |
| P2 | Backtest settings had no direct route into a bot | The session and result expose **Use settings for strategy**. Parameters and interval are copied; result settings use a run snapshot. The real browser check exercises the transfer, strategy selection, bot save, and reload. |

## Using the new settings workflow

1. Open Backtest and select the strategy. Set its parameters, risk, and bar interval.
2. Click **Use settings for strategy** in the session to save the current values.
   After a run, use the result's button to save the values actually used by that run.
3. Open a stopped bot's settings and select that strategy. Its saved values and interval
   load as a copy. For a bot that already selects it, click **Load saved strategy settings**.
4. Review the copy and click **Save**. Starting the bot still uses that bot's saved configuration.

There is one saved configuration per existing strategy. This action does not create a new
strategy implementation or a separate named preset. Existing bots do not change when a
strategy default is overwritten. Venue, market, starting balance, fill costs, point value,
and bot safety guards are not copied from a backtest. Set these for the bot's execution account.

## Operational limits and remaining validation

- **Real venue acceptance remains unverified.** Mocks prove routing and failure handling;
  they cannot prove entitlement, contract metadata, spread, slippage, margin, or rejection
  behavior on a specific Capital.com account. A dedicated demo-account acceptance run is
  still required before considering live operation. This audit performs no such trades.
- **The bot runs in the desktop renderer.** Sleep, network loss, process crashes, and app
  closure stop strategy decisions. Venue-native stops remain at the venue; time-based exits
  and local paper stop management require the app to run. This is not an always-on server.
- **Stop leaves exposure in place.** It stops new strategy decisions. Already delivered
  instructions may complete. Open positions and working orders remain; Stop is not Flatten.
- **Unknown order outcomes block entries.** A timeout may follow an accepted order. Inspect
  the original venue account before recovery. Do not erase ownership records or resend an
  ambiguous entry merely because the UI has no position yet.
- **Legacy ownership can require manual investigation.** Exposure records without an
  account/environment binding are refused. No automatic migration invents ownership.
- **Currency conversion must be known.** A same-currency instrument can use its stated lot
  value. Bots on a different account currency remain blocked without a proven
  conversion factor; unrealized profit is not used to infer that factor. There is no invented FX rate or automatic unprotected discovery trade.
- **Strategies need a venue-compatible stop.** Strategies that enter without an attached
  stop cannot open Capital bot trades. Capital bots refuse paper-only automatic break-even
  and trailing management. Full market reductions are supported; partial/resting reduce-only
  orders are not implemented. These cases must use paper execution or receive a dedicated
  strategy/venue implementation before live use.
- **Limits restrict entries, not realized maximum loss.** Gaps, slippage, fees, currency
  changes, and existing pending fills can exceed a configured risk or daily threshold.
  Several bots share the Capital account's equity and request budget; they do not implement
  a centralized account-wide portfolio risk allocator.
- **Detector state is rebuilt on restart.** Durable accounts, guard counters, and venue
  ownership survive. Every strategy's arbitrary in-progress detector state does not.
  Resume equivalence for all strategies and a multi-day soak run are not proven here.
- **Paper and backtest results are models.** Local fills and costs do not reproduce all
  venue mechanics. Copying strategy settings does not make their performance equivalent.
- **Window hardening is unit-tested.** Packaged Electron navigation and crash/sleep behavior
  were not exercised in a broker-connected desktop session. A broader renderer/IPC penetration
  test and dependency vulnerability assessment are outside the evidence produced here.

## Validation record

Targeted regressions cover ownership and persistence, delayed confirmations, cancellation
identity, reduce-only behavior, live authorization, financial-account fencing, request pacing,
data integrity and age, spread/protection guards, and settings transfer. The browser uses
the actual application components with synthetic local data and a fake preload bridge.
External requests are blocked. It verifies visible controls and dimensions, real clicks,
the tested result snapshot, saved bot values, and persistence after page reload.

Final checks on the completed implementation:

| Check | Result |
| --- | --- |
| npm run typecheck | Passed |
| npm run lint | Passed |
| npm run test | Passed: 260 files, 3,282 tests |
| npm run build | Passed: application and library bundles, including declarations |
| Main-process JavaScript syntax and git diff whitespace checks | Passed |
| Isolated Chrome workflow | Passed: transfer, result snapshot, bot selection/save, reload, and failed-save handling |
| Isolated Chrome delayed-response checks | Passed: controls lock during load/save; delayed settings/save/asset responses and errors cannot change the next bot; failed strategy load retains its own defaults |
| Public Binance market-data GET | Unavailable: DNS resolution failed for api.binance.com; no account credentials or order endpoints used |

Lint was rerun after the test suite because concurrent temporary-file cleanup interrupted
an earlier filesystem scan. No commit or live-trading release approval is implied by this audit.

## API reference checked

The [Capital.com Public API documentation](https://open-api.capital.com/) defines session
account identity, account preferences/hedging, asynchronous dealing confirmations,
working-order-to-position links, and the shared REST request limits. The implementation
uses those documented boundaries and refuses unknown states rather than assuming success.
