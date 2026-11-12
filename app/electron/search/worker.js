import { parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { decodeBars } from './store.js';

const engine = await import(pathToFileURL(path.join(workerData.dir, 'engine.mjs')).href);
let held = null;
let heldIndex = -1;
parentPort.on('message', async ({ index, datasetIndex, combination, finalParams }) => {
  try {
    if (datasetIndex !== heldIndex) {
      const data = workerData.job.datasets[datasetIndex];
      held = engine.createSearchExperiment(workerData.job.config, await decodeBars(path.join(workerData.dir, data.barsFile)),
        data.baseFile ? await decodeBars(path.join(workerData.dir, data.baseFile)) : null, data.stepMs);
      heldIndex = datasetIndex;
    }
    const result = finalParams ? held.run(finalParams, 'holdout') : held.evaluate(combination);
    parentPort.postMessage({ index, datasetIndex, result });
  } catch (err) { parentPort.postMessage({ index, error: err.message }); }
});
