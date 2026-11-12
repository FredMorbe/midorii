# Offline strategy search in Midorii

Use **Backtest → Search jobs** to run long parameter searches on saved market history.
The local worker continues when you close Midorii. Your computer must stay powered on
and awake. No exchange connection or API key is required.

## Prepare a job

1. Import historical data into the local library, or use data already stored there.
2. Open **Backtest → Search jobs**. Choose a job name and a strategy. The form starts
   from the settings in the current backtest.
3. Select saved markets, bar intervals, and a UTC date range. The end date is exclusive.
   Hold Ctrl on Windows or Cmd on macOS to select multiple markets or intervals.
   The dates must fit every selected dataset. Bar intervals must be whole multiples
   of each dataset's saved interval.
4. Mark the settings to vary. Enter numeric ranges and steps, select allowed choices,
   or provide allowed lists. Every other setting stays fixed.
5. Choose grid or random search, an attempt limit per market and interval, a total
   runtime budget, and the number of parallel workers. Random search uses a saved seed
   and does not repeat combinations. Start with 100 combinations for a short preview.
6. Keep fees and slippage enabled unless you deliberately want a cost-free comparison.
   Review **Execution costs and instrument sizing**: fees, spread, slippage, point value,
   size step, and minimum size apply to all
   selected markets. Use separate jobs when instruments have different contract values.
7. Click **Prepare job**. Review the frozen data, estimated result storage, gaps between
   bars, and the three test periods. Session breaks can produce expected gaps. A dataset
   with insufficient history or an incompatible interval is refused without downloading
   replacement data.
8. Click **Start**. Jobs run in order, one job at a time. Each job can use several workers.

Preparing copies the bars and the strategy engine. Updating the local library or the
application does not change an existing job's calculations. The worker verifies its
saved snapshots before a run. It never fetches live or historical data from a venue.

## Pause and resume

**Pause** lets the current attempts finish and saves their results. **Resume** continues
from the saved attempts. A process crash can require the unfinished attempts to run
again; complete records are retained. After a computer restart, open Midorii and choose
**Resume**. Midorii does not install a system service or start jobs at computer login.

The runtime budget counts active time, including worker preparation, and excludes time
spent paused or queued. The worker finishes when the search space, attempt limit, or
runtime budget is exhausted. Current attempts can finish after the runtime deadline.
**Finish search** ends the job early and makes its final test available.

## Inspect results

Select a job and a market/interval pair. Click **Refresh candidates** to read its saved
results. The table shows the top 50 by the job's training metric, subject to its minimum
training trade count. Markets are ranked separately. All attempts, including those
below the trade filter, remain available in exports.

Select a row to see its complete settings. **Open validation backtest** opens the
candidate's trades and equity curve from the saved job snapshots. Use the backtest's
**Use settings for strategy** action to keep the candidate. Existing bots retain their
own settings until you explicitly update them.

- **Export CSV** writes metadata, individual parameter columns, and separate training
  and validation statistic columns.
- **Export JSONL** writes one complete JSON object per attempt, including settings,
  data and engine fingerprints, execution costs, instrument sizing, and test periods.

Exports include every saved attempt at the moment the export starts. They do not apply
the table's trade filter or the earlier sweep's result retention limit.

## Reserve the final test

The first 60% of each dataset is used for search and ranking. The next 20% checks
candidates. The last 20% is reserved. Boundaries align to complete bars. Earlier history
warms up indicators in later periods but contributes no trades to their accounts.

After the job finishes, select one candidate and expand **Reserve this candidate for
the final test**. **Run final test for this candidate** reserves that period for this
candidate permanently within the job. A failed final test can retry the same candidate.
It cannot test a different candidate or reopen the job for searching. **Open final
backtest** opens the saved final trades and equity curve.

A reserved period stops being an independent final check once you use its result to
choose new settings. Reusing the same dates in another job does not create new evidence;
reserve untouched history for a fresh final check.

## Developer setup

Run `npm run app` to start Midorii. It builds the independent strategy bundle before
opening the app. `npm run build` also builds that bundle. After changing strategy code
while developing, run `npm run build:search` before preparing new jobs; existing jobs
retain their own bundles.

Search jobs live in the application's local `search-jobs` folder. Each job keeps its
configuration in `job.json`, its progress in `state.json`, and append-only results in
`results.jsonl`. Its data and engine snapshots stay beside these files. Do not edit these
files while a worker is running. Exports must be saved outside this storage folder.
