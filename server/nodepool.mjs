// WorkerPool (src/world/workerpool.js) on Node worker_threads: each slot is a worker_threads Worker wrapped
// to look like a browser Worker (postMessage / terminate / onmessage / onerror), running worldworker.mjs.
import { Worker } from 'node:worker_threads';
import os from 'node:os';
import { WorkerPool } from '../src/world/workerpool.js';

const WORKER_URL = new URL('./worldworker.mjs', import.meta.url);

function createWorker(index) {
  const w = new Worker(WORKER_URL, { name: `webcraft-world-${index}` });
  const shim = {
    onmessage: null,
    onerror: null,
    postMessage: (msg, transfer) => w.postMessage(msg, transfer),
    terminate: () => { w.terminate(); },
  };
  w.on('message', (data) => shim.onmessage?.({ data }));
  w.on('error', (err) => shim.onerror?.({ message: err?.message ?? String(err), error: err, preventDefault() {} }));
  w.on('exit', (code) => {
    if (code !== 0) shim.onerror?.({ message: `world worker exited with code ${code}`, preventDefault() {} });
  });
  w.unref();
  return shim;
}

/** A WorkerPool of `count` worker threads (default: CPU count - 1, at least 1, at most 4). */
export function createNodePool(count = Math.min(4, Math.max(1, os.cpus().length - 1))) {
  return new WorkerPool(count, { createWorker });
}
