import { Worker } from 'node:worker_threads';
import { open, unlink, mkdir, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { atomicJson, json, optionalJson, listJobs, jobDir, repairTail, records, verifySnapshot, findResult, renameWithRetry } from './store.js';

const root = path.resolve(process.argv[2]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const lockFile = path.join(root, 'service.lock');
await mkdir(root, { recursive: true });
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
let lock;
try { lock = await open(lockFile, 'wx'); } catch (err) {
  if (err.code !== 'EEXIST') throw err;
  const old = await optionalJson(lockFile).catch(() => null);
  const age = Date.now() - (old?.createdAt ?? (await stat(lockFile)).mtimeMs);
  if (old ? alive(old.pid) : age < 5000) process.exit(0);
  await unlink(lockFile);
  try { lock = await open(lockFile, 'wx'); } catch { process.exit(0); }
}
await lock.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
await lock.close();

async function saveState(dir, state) {
  state.updatedAt = Date.now();
  await atomicJson(path.join(dir, 'state.json'), state);
}
async function consume(dir) {
  const claimed = path.join(dir, `request-${randomUUID()}.processing`);
  try { await renameWithRetry(path.join(dir, 'request.json'), claimed); }
  catch (err) { if (err.code === 'ENOENT') return null; throw err; }
  try { return await json(claimed); }
  finally { await unlink(claimed); }
}

async function finalTest(job, request) {
  const dir = jobDir(root, job.id);
  const sealed = await optionalJson(path.join(dir, 'final.json'));
  if (job.final && job.final.index !== request.index) throw new Error('This job already reserves its final test for another candidate');
  if (sealed && sealed.index !== request.index) throw new Error('This job already reserves its final test for another candidate');
  if (sealed?.result) return;
  const row = await findResult(root, job.id, request.index);
  await verifySnapshot(dir, job);
  await atomicJson(path.join(dir, 'final.json'), { index: row.index, datasetIndex: row.datasetIndex, params: row.params, status: 'running' });
  const worker = new Worker(new URL('./worker.js', import.meta.url), { workerData: { dir, job } });
  try {
    const result = await new Promise((resolve, reject) => {
      worker.once('message', (message) => message.error ? reject(new Error(message.error)) : resolve(message.result));
      worker.once('error', reject);
      worker.once('exit', (code) => reject(new Error(`Final test worker exited (${code})`)));
      worker.postMessage({ index: row.index, datasetIndex: row.datasetIndex, finalParams: row.params });
    });
    await atomicJson(path.join(dir, 'final-run.json'), result);
    await atomicJson(path.join(dir, 'final.json'), { index: row.index, datasetIndex: row.datasetIndex, params: row.params, status: 'completed', result: {
      stats: result.stats, barCount: result.barCount, warmupBars: result.warmupBars, resolution: result.resolution,
    } });
  } catch (err) {
    await atomicJson(path.join(dir, 'final.json'), { index: row.index, datasetIndex: row.datasetIndex, params: row.params, status: 'failed', error: err.message });
    throw err;
  } finally { await worker.terminate(); }
}

async function applyRequest(job, request) {
  const dir = jobDir(root, job.id);
  try {
    if (request.action === 'start') {
      if (job.final) throw new Error('A job with a reserved final test cannot resume searching');
      if (job.state.done >= job.total || job.state.elapsedMs >= job.config.budgetMs) throw new Error('This job has used its search budget');
      job.state.status = 'queued'; job.state.error = null; delete job.state.reason;
    } else if (request.action === 'pause') {
      if (job.state.status === 'completed') throw new Error('This search has already finished');
      job.state.status = 'paused';
    } else if (request.action === 'finish') job.state.status = 'completed';
    else if (request.action === 'final') {
      if (job.state.status !== 'completed') throw new Error('Finish the search before opening the final test');
      await finalTest(job, request);
      job.state.error = null;
    } else throw new Error('Unknown search request');
  } catch (err) { job.state.error = err.message; }
  await saveState(dir, job.state);
}

async function runJob(job) {
  const dir = jobDir(root, job.id);
  const state = { ...job.state, status: 'running', error: null };
  const workers = [];
  let output;
  const startedAt = Date.now();
  const previousElapsed = state.elapsedMs;
  let pause = false;
  let finish = false;
  let failure = null;
  let next = 0;
  let pending = 0;
  const ready = new Map();
  let lastSave = 0;
  let lastQueueCheck = 0;
  try {
    await verifySnapshot(dir, job);
    const file = path.join(dir, 'results.jsonl');
    await repairTail(file);
    for await (const row of records(file)) next = row.index + 1;
    state.done = next;
    await saveState(dir, state);
    output = await open(file, 'a');
    let assigned = next;
    const assign = (worker) => {
      if (pause || finish || failure || assigned >= job.total) return;
      if (previousElapsed + Date.now() - startedAt >= job.config.budgetMs) { finish = true; return; }
      const index = assigned++;
      pending++;
      worker.postMessage({ index, datasetIndex: Math.floor(index / job.combinations), combination: index % job.combinations });
    };
    const count = Math.min(job.config.workers, job.total - next);
    for (let i = 0; i < count; i++) {
      const worker = new Worker(new URL('./worker.js', import.meta.url), { workerData: { dir, job } });
      worker.on('message', (message) => {
        pending--;
        if (message.error) failure = new Error(message.error);
        else ready.set(message.index, message);
      });
      worker.on('error', (err) => { failure = err; });
      worker.on('exit', (code) => { if (code !== 0 && !pause && !finish) failure = new Error(`Search worker exited (${code})`); });
      workers.push({ worker, busy: false });
    }
    for (const slot of workers) { assign(slot.worker); slot.busy = true; }
    while ((next < job.total || pending > 0) && !failure) {
      const request = await consume(dir);
      if (request?.action === 'pause') pause = true;
      if (request?.action === 'finish') { finish = true; pause = false; }
      if (Date.now() - lastQueueCheck >= 500) {
        for (const other of await listJobs(root)) {
          if (other.id === job.id) continue;
          const pendingRequest = await optionalJson(path.join(jobDir(root, other.id), 'request.json'));
          if (!pendingRequest || pendingRequest.action === 'final') continue;
          const claimed = await consume(jobDir(root, other.id));
          if (claimed) await applyRequest(other, claimed);
        }
        lastQueueCheck = Date.now();
      }
      while (ready.has(next)) {
        const message = ready.get(next);
        ready.delete(next);
        await output.writeFile(JSON.stringify({ index: next, datasetIndex: message.datasetIndex, ...message.result }) + '\n');
        await output.sync();
        next++;
        state.done = next;
      }
      state.elapsedMs = previousElapsed + Date.now() - startedAt;
      if (state.elapsedMs >= job.config.budgetMs) finish = true;
      if (Date.now() - lastSave >= 1000 || pause || finish) {
        state.status = pause ? 'pausing' : 'running';
        await saveState(dir, state);
        lastSave = Date.now();
      }
      // Only dispatch after the current wave has been durably written in order.
      if (pending === 0 && ready.size === 0) {
        if (pause || finish || next >= job.total) break;
        for (const { worker } of workers) assign(worker);
      }
      await sleep(50);
    }
    if (failure) throw failure;
    state.status = pause ? 'paused' : 'completed';
    state.elapsedMs = previousElapsed + Date.now() - startedAt;
    state.reason = pause ? 'Paused by you' : next >= job.total ? 'Search space or attempt limit reached' : 'Runtime budget reached or search finished by you';
  } catch (err) { state.status = 'failed'; state.error = err.message; }
  finally {
    for (const { worker } of workers) await worker.terminate();
    if (output) await output.close();
    await saveState(dir, state);
  }
}

try {
  for (const job of await listJobs(root)) {
    if (['running', 'pausing'].includes(job.state.status)) {
      job.state.status = 'paused';
      job.state.error = 'The previous worker stopped. Resume to continue from saved results.';
      await saveState(jobDir(root, job.id), job.state);
    }
    if (job.final?.status === 'running') {
      await atomicJson(path.join(jobDir(root, job.id), 'final.json'), { ...job.final, status: 'failed', error: 'The previous final test worker stopped. Retry the same candidate.' });
    }
  }
  let idleSince = Date.now();
  for (;;) {
    let activity = false;
    for (const job of (await listJobs(root)).reverse()) {
      const dir = jobDir(root, job.id);
      const request = await consume(dir);
      if (request) {
        activity = true;
        await applyRequest(job, request);
      }
    }
    const queued = (await listJobs(root)).filter((job) => job.state.status === 'queued').sort((a, b) => a.createdAt - b.createdAt);
    if (queued.length) { activity = true; await runJob(queued[0]); }
    if (activity) idleSince = Date.now();
    if (Date.now() - idleSince > 5000) break;
    await sleep(250);
  }
} catch (err) {
  await atomicJson(path.join(root, 'service-error.json'), { error: err.message, at: Date.now() });
} finally {
  const current = await optionalJson(lockFile);
  if (current?.pid === process.pid) await unlink(lockFile);
}
