// Pool of world workers (docs/SPEC.md §8, §9.6). Main thread only.
//
// * Jobs wait in a binary min-heap ordered by (priority, submission order); lower priority = sooner.
// * Each worker gets at most `maxInFlight` (default 2) jobs at a time: one running plus one already
//   queued in its message port, so a worker never idles waiting for the main thread, while everything
//   else stays in the heap where priorities can still change (reprioritize) or jobs can be dropped
//   (cancel) — e.g. when the player moves.
// * submit() resolves with the worker's reply message ({ type: 'generated' | 'meshed', ... }) and
//   rejects with an Error for { type: 'error' } replies, with an AbortError (`err.cancelled === true`)
//   when the job is cancelled while queued, and with an Error when the pool is terminated or the
//   worker crashes. Callers must handle rejections.
// * A worker that fails (uncaught error / module load failure) has its in-flight jobs rejected and is
//   restarted (up to 3 times per slot, the last init message is replayed). If every worker is dead the
//   queued jobs are rejected as well.

import { clamp } from '../util/math.js';

const MAX_RESTARTS = 3;

/** Default worker count: hardwareConcurrency - 2, clamped to [2, 8]. */
export function defaultWorkerCount() {
  const hc = typeof navigator !== 'undefined' && navigator.hardwareConcurrency > 0 ? navigator.hardwareConcurrency : 4;
  return clamp(hc - 2, 2, 8);
}

/** Error used to reject cancelled jobs. */
export class JobCancelledError extends Error {
  constructor(message = 'job cancelled') {
    super(message);
    this.name = 'AbortError';
    this.cancelled = true;
  }
}

function less(a, b) {
  return a.priority < b.priority || (a.priority === b.priority && a.seq < b.seq);
}

export class WorkerPool {
  /**
   * @param {number} [count] number of workers (default clamp(hardwareConcurrency - 2, 2, 8))
   * @param {{ maxInFlight?: number, createWorker?: (index: number) => Worker }} [options]
   *   createWorker lets tests inject worker-like objects (postMessage, terminate, onmessage, onerror).
   */
  constructor(count = defaultWorkerCount(), options = {}) {
    this.size = Math.max(1, Math.floor(count) || 1);
    this.maxInFlight = Math.max(1, options.maxInFlight ?? 2);
    this._createWorker = options.createWorker ?? ((i) => new Worker(new URL('./worker.js', import.meta.url), {
      type: 'module', name: `webcraft-world-${i}`,
    }));
    this._heap = [];
    this._seq = 0;
    this._nextId = 1;
    this._running = new Map();     // jobId -> entry (dispatched, awaiting reply)
    this._slots = [];
    this._initMsg = null;
    this._terminated = false;
    this.counters = { submitted: 0, completed: 0, failed: 0, cancelled: 0, restarts: 0 };
    for (let i = 0; i < this.size; i++) {
      const slot = { index: i, worker: null, inFlight: 0, restarts: 0, dead: false };
      this._spawn(slot);
      this._slots.push(slot);
    }
  }

  /** Jobs not finished yet (queued + running). */
  get pending() {
    return this._heap.length + this._running.size;
  }

  /** Jobs waiting in the heap (not dispatched). */
  get queued() {
    return this._heap.length;
  }

  /** Jobs dispatched to workers and not answered yet. */
  get inFlight() {
    return this._running.size;
  }

  /** Workers currently alive. */
  get liveWorkers() {
    return this._slots.filter((s) => !s.dead).length;
  }

  /** Broadcast { type: 'init', seed, worldType } to every worker (and to restarted ones later). */
  init(seed, worldType = 'default') {
    this._initMsg = { type: 'init', seed: seed >>> 0, worldType };
    for (const s of this._slots) {
      if (s.dead || !s.worker) continue;
      try {
        s.worker.postMessage(this._initMsg);
      } catch (err) {
        console.error('[workerpool] init failed:', err);
      }
    }
  }

  /**
   * Queue a job. The pool assigns `job.jobId`. `transfer` is used when the job is dispatched.
   * @param {object} job structured-cloneable message ({ type: 'generate' | 'mesh', ... })
   * @param {number} [priority] lower = sooner
   * @param {Transferable[]} [transfer]
   * @returns {Promise<object>} the worker's reply
   */
  submit(job, priority = 0, transfer = []) {
    return new Promise((resolve, reject) => {
      if (this._terminated) {
        reject(new Error('WorkerPool terminated'));
        return;
      }
      if (this._slots.every((s) => s.dead)) {
        reject(new Error('WorkerPool: no live workers'));
        return;
      }
      const entry = {
        id: this._nextId++, job, priority: Number.isFinite(priority) ? priority : 0, seq: this._seq++,
        transfer: transfer || [], resolve, reject, slot: null,
      };
      job.jobId = entry.id;
      this.counters.submitted++;
      this._push(entry);
      this._pump();
    });
  }

  /**
   * Drop queued (not yet dispatched) jobs for which predicate(job, priority) is true. Their promises
   * reject with JobCancelledError. @returns {number} jobs cancelled
   */
  cancel(predicate) {
    const heap = this._heap;
    const dropped = [];
    let w = 0;
    for (let i = 0; i < heap.length; i++) {
      const e = heap[i];
      let drop = false;
      try {
        drop = !!predicate(e.job, e.priority);
      } catch (err) {
        console.error('[workerpool] cancel predicate threw:', err);
      }
      if (drop) dropped.push(e);
      else heap[w++] = e;
    }
    if (dropped.length === 0) return 0;
    heap.length = w;
    this._heapify();
    this.counters.cancelled += dropped.length;
    for (const e of dropped) e.reject(new JobCancelledError());
    return dropped.length;
  }

  /**
   * Recompute priorities of queued jobs: fn(job, oldPriority) -> new priority (non-numbers keep the
   * old value).
   */
  reprioritize(fn) {
    const heap = this._heap;
    for (let i = 0; i < heap.length; i++) {
      const e = heap[i];
      let p;
      try {
        p = fn(e.job, e.priority);
      } catch (err) {
        console.error('[workerpool] reprioritize callback threw:', err);
        continue;
      }
      if (typeof p === 'number' && Number.isFinite(p)) e.priority = p;
    }
    this._heapify();
  }

  /** Stop every worker; queued and running jobs reject. The pool cannot be used afterwards. */
  terminate() {
    if (this._terminated) return;
    this._terminated = true;
    const err = () => new Error('WorkerPool terminated');
    const heap = this._heap;
    this._heap = [];
    for (const e of heap) e.reject(err());
    const running = [...this._running.values()];
    this._running.clear();
    for (const e of running) e.reject(err());
    for (const s of this._slots) {
      s.dead = true;
      s.inFlight = 0;
      try {
        s.worker?.terminate();
      } catch { /* ignore */ }
      s.worker = null;
    }
  }

  /** Debug counters + queue state. */
  getStats() {
    return { workers: this.liveWorkers, queued: this._heap.length, running: this._running.size, ...this.counters };
  }

  // -------------------------------------------------------------------------------------------------
  // Workers
  // -------------------------------------------------------------------------------------------------

  _spawn(slot) {
    let worker;
    try {
      worker = this._createWorker(slot.index);
    } catch (err) {
      console.error('[workerpool] could not create worker:', err);
      slot.dead = true;
      slot.worker = null;
      return;
    }
    slot.worker = worker;
    slot.inFlight = 0;
    worker.onmessage = (e) => this._onMessage(slot, worker, e.data);
    worker.onerror = (e) => this._onWorkerError(slot, worker, e);
    worker.onmessageerror = () => console.error(`[workerpool] worker ${slot.index}: message could not be deserialized`);
    if (this._initMsg) {
      try {
        worker.postMessage(this._initMsg);
      } catch (err) {
        console.error('[workerpool] init failed:', err);
      }
    }
  }

  _onMessage(slot, worker, msg) {
    if (slot.worker !== worker) return;          // reply from a worker that was replaced
    if (!msg || typeof msg !== 'object') return;
    const entry = msg.jobId != null ? this._running.get(msg.jobId) : undefined;
    if (!entry) {
      if (msg.type === 'error') console.error(`[workerpool] worker ${slot.index} error:`, msg.message);
      return;
    }
    this._running.delete(msg.jobId);
    if (entry.slot === slot) slot.inFlight--;
    entry.slot = null;
    if (msg.type === 'error') {
      this.counters.failed++;
      entry.reject(new Error(msg.message || 'worker job failed'));
    } else {
      this.counters.completed++;
      entry.resolve(msg);
    }
    this._pump();
  }

  _onWorkerError(slot, worker, event) {
    if (slot.worker !== worker) return;
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    const text = event?.message || event?.error?.message || 'worker failed (script error)';
    console.error(`[workerpool] worker ${slot.index} crashed: ${text}`);
    // Fail the jobs it was running.
    const lost = [];
    for (const [id, e] of this._running) {
      if (e.slot === slot) {
        this._running.delete(id);
        lost.push(e);
      }
    }
    slot.inFlight = 0;
    try {
      worker.terminate();
    } catch { /* ignore */ }
    slot.worker = null;
    for (const e of lost) {
      this.counters.failed++;
      e.reject(new Error(`worker crashed: ${text}`));
    }
    if (!this._terminated && slot.restarts < MAX_RESTARTS) {
      slot.restarts++;
      this.counters.restarts++;
      this._spawn(slot);
    } else {
      slot.dead = true;
    }
    if (this._slots.every((s) => s.dead)) {
      const heap = this._heap;
      this._heap = [];
      for (const e of heap) e.reject(new Error('WorkerPool: no live workers'));
      return;
    }
    this._pump();
  }

  /** Dispatch queued jobs to the least-loaded workers while there is capacity. */
  _pump() {
    if (this._terminated) return;
    while (this._heap.length > 0) {
      let best = null;
      for (let i = 0; i < this._slots.length; i++) {
        const s = this._slots[i];
        if (s.dead || !s.worker || s.inFlight >= this.maxInFlight) continue;
        if (best === null || s.inFlight < best.inFlight) best = s;
      }
      if (best === null) return;
      const entry = this._pop();
      entry.slot = best;
      best.inFlight++;
      this._running.set(entry.id, entry);
      try {
        best.worker.postMessage(entry.job, entry.transfer);
      } catch (err) {
        // e.g. DataCloneError (detached buffer): fail this job, keep going.
        this._running.delete(entry.id);
        best.inFlight--;
        entry.slot = null;
        this.counters.failed++;
        entry.reject(err);
      }
    }
  }

  // -------------------------------------------------------------------------------------------------
  // Binary heap
  // -------------------------------------------------------------------------------------------------

  _push(e) {
    const h = this._heap;
    h.push(e);
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(h[i], h[p])) break;
      const t = h[i]; h[i] = h[p]; h[p] = t;
      i = p;
    }
  }

  _pop() {
    const h = this._heap;
    const top = h[0];
    const last = h.pop();
    if (h.length > 0) {
      h[0] = last;
      this._siftDown(0);
    }
    return top;
  }

  _siftDown(i) {
    const h = this._heap;
    const n = h.length;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < n && less(h[l], h[m])) m = l;
      if (r < n && less(h[r], h[m])) m = r;
      if (m === i) return;
      const t = h[i]; h[i] = h[m]; h[m] = t;
      i = m;
    }
  }

  _heapify() {
    for (let i = (this._heap.length >> 1) - 1; i >= 0; i--) this._siftDown(i);
  }
}
