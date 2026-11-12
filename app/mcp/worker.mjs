import { parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { readBars, baseIntervalMs, timeframeMs, bucketEnd, parseTimeframe } from '../electron/data/store/barStore.js';

try {
  const { request, dataDir, definitions, enginePath, mode = 'backtest' } = workerData;
  const engine = await import(pathToFileURL(enginePath).href);
  engine.setRuleStrategies(definitions);
  const baseMs = await baseIntervalMs(dataDir, request.symbol);
  const stepMs = timeframeMs(request.timeframe);
  const end = Math.min(request.to, Date.now());
  const bars = (await readBars(dataDir, request.symbol, request.timeframe, request.from, end, true))
    .filter((bar) => bar.time >= request.from && bucketEnd(bar.time, parseTimeframe(request.timeframe)) <= end);
  if (bars.length < 2) throw new Error('At least two completed bars are needed in the requested range.');
  if (bars.length > 500_000) throw new Error('Choose a shorter range or a larger interval (maximum 500,000 strategy bars).');
  const baseBars = request.intrabar && stepMs > baseMs
    ? (await readBars(dataDir, request.symbol, String(baseMs / 60_000), bars[0].time, end, true))
      .filter((bar) => bar.time + baseMs <= end) : null;
  let lastProgress = 0;
  const result = mode === 'sweep'
    ? await engine.executeSweep({ ...request, bars, baseBars, stepMs, from: bars[0].time,
      to: bucketEnd(bars.at(-1).time, parseTimeframe(request.timeframe)),
      onProgress: (progress) => {
        if (progress.done === progress.total || Date.now() - lastProgress >= 100) {
          parentPort.postMessage({ progress }); lastProgress = Date.now();
        }
      } })
    : engine.executeBacktest({ ...request, bars, baseBars, stepMs });
  parentPort.postMessage({ result, from: bars[0].time, to: bars.at(-1).time,
    coverage: { requestedFrom: request.from, requestedTo: request.to, first: bars[0].time, last: bars.at(-1).time,
      missingStart: bars[0].time > request.from, missingEnd: bucketEnd(bars.at(-1).time, parseTimeframe(request.timeframe)) < end } });
} catch (error) {
  parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) });
}
