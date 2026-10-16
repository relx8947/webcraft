// World persistence (docs/SPEC.md §9.6): IndexedDB database `webcraft` with the object stores
//   worlds  keyPath 'id'                      world meta objects
//   chunks  out-of-line key [worldId, cx, cz] { f: 1, n: 65536, d: Uint8Array (rleEncode) }
//           out-of-line key [worldId, '#name'] small per-world records (saveWorldData), e.g. the list of
//           chunks generated once ('populated'). They live in the chunk store so deleteWorld's key range
//           removes them too and no database upgrade is needed; getChunkKeys skips them.
// If IndexedDB is unavailable (or cannot be opened: private mode, blocked, disabled) Storage falls back
// to an in-memory store and prints a single console warning — nothing is persisted then, but every API
// keeps working.
//
// rleEncode / rleDecode are pure (Node-tested). Format: a sequence of tokens, each starting with a
// LEB128 varint t:
//   t even -> literal run: (t >> 1) + 1 raw bytes follow
//   t odd  -> repeat run:  (t >> 1) + 3 copies of the single byte that follows
// Runs shorter than 3 are folded into literals; the output is at most ~n/64 + 5 bytes longer than the input.
// A typical surface chunk (64 KiB) encodes to ~4-12 KiB; an all-air chunk to 4 bytes.

import { CHUNK_VOLUME } from '../config.js';

const DB_NAME = 'webcraft';
const DB_VERSION = 1;
const WORLDS = 'worlds';
const CHUNKS = 'chunks';
const CHUNK_FORMAT = 1;

// ---------------------------------------------------------------------------------------------
// RLE
// ---------------------------------------------------------------------------------------------

/**
 * Compress a byte array (see the header for the format).
 * @param {Uint8Array} src
 * @returns {Uint8Array} exact-size encoded copy
 */
export function rleEncode(src) {
  if (!(src instanceof Uint8Array)) throw new TypeError('rleEncode expects a Uint8Array');
  const n = src.length;
  let out = new Uint8Array(Math.max(32, (n >> 2) + 16));
  let o = 0;

  const ensure = (extra) => {
    if (o + extra <= out.length) return;
    let cap = out.length * 2;
    while (cap < o + extra) cap *= 2;
    const g = new Uint8Array(cap);
    g.set(out.subarray(0, o));
    out = g;
  };
  const varint = (v) => {
    while (v >= 0x80) {
      out[o++] = (v & 0x7f) | 0x80;
      v = Math.floor(v / 128);
    }
    out[o++] = v;
  };
  const literal = (from, to) => {
    const len = to - from;
    ensure(len + 6);
    varint((len - 1) * 2);
    out.set(src.subarray(from, to), o);
    o += len;
  };

  let i = 0;
  let litStart = 0;
  while (i < n) {
    const v = src[i];
    let j = i + 1;
    while (j < n && src[j] === v) j++;
    const run = j - i;
    if (run >= 3) {
      if (litStart < i) literal(litStart, i);
      ensure(7);
      varint((run - 3) * 2 + 1);
      out[o++] = v;
      litStart = j;
    }
    i = j;
  }
  if (litStart < n) literal(litStart, n);
  return out.slice(0, o);
}

/** Read the token header at src[i]; returns [t, nextIndex]. Throws on truncated / oversized varints. */
function readVarint(src, i) {
  let t = 0;
  let scale = 1;
  for (let k = 0; k < 5; k++) {
    if (i >= src.length) throw new RangeError('rleDecode: truncated input');
    const b = src[i++];
    t += (b & 0x7f) * scale;
    if ((b & 0x80) === 0) return [t, i];
    scale *= 128;
  }
  throw new RangeError('rleDecode: corrupt varint');
}

/** Decoded length of an RLE stream (validates the token structure). */
function decodedLength(src) {
  let i = 0;
  let total = 0;
  while (i < src.length) {
    const r = readVarint(src, i);
    const t = r[0];
    i = r[1];
    if (t % 2 === 0) {
      const len = t / 2 + 1;
      if (i + len > src.length) throw new RangeError('rleDecode: truncated literal');
      i += len;
      total += len;
    } else {
      if (i >= src.length) throw new RangeError('rleDecode: truncated run');
      i++;
      total += (t - 1) / 2 + 3;
    }
  }
  return total;
}

/**
 * Decompress an rleEncode stream.
 * @param {Uint8Array} src
 * @param {number} [length] expected decoded length; the stream must decode to exactly this many bytes
 *   (throws RangeError otherwise). If omitted it is computed from the stream.
 * @returns {Uint8Array}
 */
export function rleDecode(src, length) {
  if (!(src instanceof Uint8Array)) throw new TypeError('rleDecode expects a Uint8Array');
  if (length === undefined) length = decodedLength(src);
  if (!Number.isInteger(length) || length < 0) throw new RangeError('rleDecode: bad length');
  const out = new Uint8Array(length);
  const n = src.length;
  let i = 0;
  let o = 0;
  while (i < n) {
    const r = readVarint(src, i);
    const t = r[0];
    i = r[1];
    if (t % 2 === 0) {
      const len = t / 2 + 1;
      if (i + len > n) throw new RangeError('rleDecode: truncated literal');
      if (o + len > length) throw new RangeError('rleDecode: data longer than expected');
      out.set(src.subarray(i, i + len), o);
      i += len;
      o += len;
    } else {
      const len = (t - 1) / 2 + 3;
      if (i >= n) throw new RangeError('rleDecode: truncated run');
      if (o + len > length) throw new RangeError('rleDecode: data longer than expected');
      out.fill(src[i++], o, o + len);
      o += len;
    }
  }
  if (o !== length) throw new RangeError(`rleDecode: decoded ${o} bytes, expected ${length}`);
  return out;
}

/** Encode chunk blocks into the stored record. */
export function encodeChunkRecord(blocks) {
  if (!(blocks instanceof Uint8Array) || blocks.length !== CHUNK_VOLUME) {
    throw new TypeError(`chunk blocks must be a Uint8Array(${CHUNK_VOLUME})`);
  }
  return { f: CHUNK_FORMAT, n: CHUNK_VOLUME, d: rleEncode(blocks) };
}

/** Decode a stored chunk record (throws on corrupt data). */
export function decodeChunkRecord(rec) {
  if (rec instanceof Uint8Array && rec.length === CHUNK_VOLUME) return rec.slice();
  if (!rec || typeof rec !== 'object' || rec.f !== CHUNK_FORMAT || !(rec.d instanceof Uint8Array)) {
    throw new RangeError('unknown chunk record format');
  }
  if (rec.n !== CHUNK_VOLUME) throw new RangeError(`bad chunk length ${rec.n}`);
  return rleDecode(rec.d, CHUNK_VOLUME);
}

/** A reasonably unique id for a new world (the integrator may use any string). */
export function newWorldId() {
  const rnd = Math.floor(Math.random() * 0x7fffffff).toString(36);
  return 'w' + Date.now().toString(36) + rnd;
}

// ---------------------------------------------------------------------------------------------
// Backends
// ---------------------------------------------------------------------------------------------

const cloneValue = (v) => (typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v)));

/** Non-persistent backend (fallback, tests, worlds without persistence). */
class MemoryBackend {
  constructor() {
    this.kind = 'memory';
    this.persistent = false;
    this.worlds = new Map();     // id -> meta (cloned)
    this.chunks = new Map();     // worldId -> Map('cx,cz' -> record)
    this.data = new Map();       // worldId -> Map(name -> value (cloned))
  }

  async getData(worldId, name) {
    const v = this.data.get(worldId)?.get(name);
    return v === undefined ? null : cloneValue(v);
  }

  async putData(worldId, name, value) {
    let m = this.data.get(worldId);
    if (!m) this.data.set(worldId, (m = new Map()));
    m.set(name, cloneValue(value));
  }

  async getAllWorlds() {
    return [...this.worlds.values()].map(cloneValue);
  }

  async putWorld(meta) {
    this.worlds.set(meta.id, cloneValue(meta));
  }

  async getWorld(id) {
    const m = this.worlds.get(id);
    return m ? cloneValue(m) : null;
  }

  async deleteWorld(id) {
    this.worlds.delete(id);
    this.chunks.delete(id);
    this.data.delete(id);
  }

  async getChunkKeys(worldId) {
    const m = this.chunks.get(worldId);
    return m ? [...m.keys()] : [];
  }

  async getChunk(worldId, cx, cz) {
    return this.chunks.get(worldId)?.get(cx + ',' + cz) ?? null;
  }

  async putChunks(worldId, records) {
    let m = this.chunks.get(worldId);
    if (!m) this.chunks.set(worldId, (m = new Map()));
    for (const r of records) m.set(r.cx + ',' + r.cz, r.rec);
  }

  putSnapshot(worldId, meta, records, data) {
    // Copy synchronously (callers may keep mutating), commit in one step.
    const m2 = meta ? cloneValue(meta) : null;
    const d2 = data.map((d) => ({ name: d.name, value: cloneValue(d.value) }));
    if (m2) this.worlds.set(m2.id, m2);
    let m = this.chunks.get(worldId);
    if (!m) this.chunks.set(worldId, (m = new Map()));
    for (const r of records) m.set(r.cx + ',' + r.cz, r.rec);
    let dm = this.data.get(worldId);
    if (!dm) this.data.set(worldId, (dm = new Map()));
    for (const d of d2) dm.set(d.name, d.value);
    return Promise.resolve();
  }

  close() {}
}

/**
 * Resolves when the transaction commits; rejects when it aborts (a failed request aborts the whole
 * transaction by default, so request errors end up here too, e.g. QuotaExceededError).
 */
function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

/** Ask the browser to commit a transaction right after its last request (no-op where unsupported). */
function commitTx(tx) {
  if (typeof tx.commit !== 'function') return;
  try {
    tx.commit();
  } catch { /* already committing / finished */ }
}

function openDatabase(idb, name) {
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = idb.open(name, DB_VERSION);
    } catch (err) {
      reject(err);
      return;
    }
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('IndexedDB open timed out (blocked by another tab?)'));
    }, 8000);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(WORLDS)) db.createObjectStore(WORLDS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(CHUNKS)) db.createObjectStore(CHUNKS);
    };
    req.onsuccess = () => {
      if (settled) {
        req.result.close();
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(req.result);
    };
    req.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(req.error ?? new Error('IndexedDB open failed'));
    };
    req.onblocked = () => { /* wait: the other connection is asked to close (versionchange) */ };
  });
}

const chunkRange = (worldId) => IDBKeyRange.bound([worldId], [worldId, []]);

/** IndexedDB backend. Chunk reads issued in the same task are coalesced into one transaction. */
class IDBBackend {
  constructor(db, idb, name) {
    this.kind = 'indexeddb';
    this.persistent = true;
    this.idb = idb;
    this.name = name;
    this._db = null;
    this._dbPromise = null;
    this._readQueue = [];
    this._readScheduled = false;
    this._attach(db);
  }

  _attach(db) {
    this._db = db;
    // Let other tabs upgrade / delete the database; we reopen lazily on the next operation.
    db.onversionchange = () => {
      db.close();
      if (this._db === db) this._db = null;
    };
    db.onclose = () => {
      if (this._db === db) this._db = null;
    };
  }

  async _getDB() {
    if (this._db) return this._db;
    if (!this._dbPromise) {
      this._dbPromise = openDatabase(this.idb, this.name).then((db) => {
        this._attach(db);
        this._dbPromise = null;
        return db;
      }, (err) => {
        this._dbPromise = null;
        throw err;
      });
    }
    return this._dbPromise;
  }

  async _tx(stores, mode) {
    const db = await this._getDB();
    try {
      return db.transaction(stores, mode);
    } catch (err) {
      // InvalidStateError: the connection closed underneath us — reopen once.
      if (this._db === db) this._db = null;
      const db2 = await this._getDB();
      return db2.transaction(stores, mode);
    }
  }

  async getAllWorlds() {
    const tx = await this._tx(WORLDS, 'readonly');
    const req = tx.objectStore(WORLDS).getAll();
    await txDone(tx);
    return req.result ?? [];
  }

  async putWorld(meta) {
    const tx = await this._tx(WORLDS, 'readwrite');
    tx.objectStore(WORLDS).put(meta);
    const done = txDone(tx);
    commitTx(tx);
    await done;
  }

  async getWorld(id) {
    const tx = await this._tx(WORLDS, 'readonly');
    const req = tx.objectStore(WORLDS).get(id);
    await txDone(tx);
    return req.result ?? null;
  }

  async deleteWorld(id) {
    const tx = await this._tx([WORLDS, CHUNKS], 'readwrite');
    tx.objectStore(WORLDS).delete(id);
    tx.objectStore(CHUNKS).delete(chunkRange(id));
    const done = txDone(tx);
    commitTx(tx);
    await done;
  }

  async getChunkKeys(worldId) {
    const tx = await this._tx(CHUNKS, 'readonly');
    const req = tx.objectStore(CHUNKS).getAllKeys(chunkRange(worldId));
    await txDone(tx);
    // Skip per-world data records ([worldId, '#name']).
    return (req.result ?? []).filter((k) => typeof k[1] === 'number').map((k) => k[1] + ',' + k[2]);
  }

  async getData(worldId, name) {
    const tx = await this._tx(CHUNKS, 'readonly');
    const req = tx.objectStore(CHUNKS).get([worldId, '#' + name]);
    await txDone(tx);
    return req.result ?? null;
  }

  async putData(worldId, name, value) {
    const tx = await this._tx(CHUNKS, 'readwrite');
    tx.objectStore(CHUNKS).put(value, [worldId, '#' + name]);
    const done = txDone(tx);
    commitTx(tx);
    await done;
  }

  getChunk(worldId, cx, cz) {
    return new Promise((resolve, reject) => {
      this._readQueue.push({ key: [worldId, cx, cz], resolve, reject });
      if (!this._readScheduled) {
        this._readScheduled = true;
        queueMicrotask(() => this._flushReads());
      }
    });
  }

  async _flushReads() {
    const queue = this._readQueue;
    this._readQueue = [];
    this._readScheduled = false;
    if (queue.length === 0) return;
    let tx;
    try {
      tx = await this._tx(CHUNKS, 'readonly');
    } catch (err) {
      for (const r of queue) r.reject(err);
      return;
    }
    const store = tx.objectStore(CHUNKS);
    const reqs = queue.map((r) => {
      try {
        return store.get(r.key);
      } catch (err) {
        return err;
      }
    });
    try {
      await txDone(tx);
    } catch (err) {
      for (const r of queue) r.reject(err);
      return;
    }
    queue.forEach((r, i) => {
      const q = reqs[i];
      if (q instanceof Error || (typeof DOMException !== 'undefined' && q instanceof DOMException)) r.reject(q);
      else r.resolve(q.result ?? null);
    });
  }

  async putChunks(worldId, records) {
    const tx = await this._tx(CHUNKS, 'readwrite');
    const store = tx.objectStore(CHUNKS);
    for (const r of records) store.put(r.rec, [worldId, r.cx, r.cz]);
    const done = txDone(tx);
    commitTx(tx);
    await done;
  }

  /**
   * Meta + chunk records + data records in ONE transaction. When the database connection is open the
   * transaction is created synchronously (inside the caller's task — required for pagehide /
   * visibilitychange saves, which must not wait for anything) and committed at once.
   */
  putSnapshot(worldId, meta, records, data) {
    const fill = (tx) => {
      if (meta) tx.objectStore(WORLDS).put(meta);
      const store = tx.objectStore(CHUNKS);
      for (const r of records) store.put(r.rec, [worldId, r.cx, r.cz]);
      for (const d of data) store.put(d.value, [worldId, '#' + d.name]);
      const done = txDone(tx);
      commitTx(tx);
      return done;
    };
    const stores = [WORLDS, CHUNKS];
    if (this._db) {
      let tx = null;
      try {
        tx = this._db.transaction(stores, 'readwrite', { durability: 'relaxed' });
      } catch {
        try {
          tx = this._db.transaction(stores, 'readwrite');
        } catch {
          tx = null;                      // connection closing: reopen below
        }
      }
      if (tx) return fill(tx);
    }
    return this._tx(stores, 'readwrite').then(fill);
  }

  close() {
    if (this._db) this._db.close();
    this._db = null;
  }
}

// ---------------------------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------------------------

let fallbackWarned = false;

function warnFallback(reason) {
  if (fallbackWarned) return;
  fallbackWarned = true;
  console.warn(`[storage] IndexedDB unavailable (${reason?.message ?? reason}); worlds will not be saved in this session.`);
}

function checkMeta(meta) {
  if (!meta || typeof meta !== 'object' || typeof meta.id !== 'string' || meta.id === '') {
    throw new TypeError('world meta needs a non-empty string id');
  }
}

/**
 * World + chunk persistence (SPEC §9.6). Create with `await Storage.open()`.
 */
export class Storage {
  /** @param {MemoryBackend|IDBBackend} backend */
  constructor(backend = new MemoryBackend()) {
    this._b = backend;
  }

  /**
   * Open the IndexedDB database (never rejects: falls back to memory with one console warning).
   * @param {{ name?: string, indexedDB?: IDBFactory|null }} [options] `indexedDB: null` forces memory
   * @returns {Promise<Storage>}
   */
  static async open(options = {}) {
    const name = options.name ?? DB_NAME;
    let idb = null;
    try {
      // Reading the factory itself throws SecurityError in some contexts (Firefox with site data blocked).
      idb = options.indexedDB !== undefined ? options.indexedDB : (globalThis.indexedDB ?? null);
    } catch (err) {
      warnFallback(err);
      return new Storage(new MemoryBackend());
    }
    if (!idb) {
      if (options.indexedDB !== null) warnFallback('not supported');
      return new Storage(new MemoryBackend());
    }
    try {
      const db = await openDatabase(idb, name);
      return new Storage(new IDBBackend(db, idb, name));
    } catch (err) {
      warnFallback(err);
      return new Storage(new MemoryBackend());
    }
  }

  /** A non-persistent store (worlds without saving, tests). */
  static memory() {
    return new Storage(new MemoryBackend());
  }

  /** True when data survives a page reload (IndexedDB). */
  get persistent() {
    return this._b.persistent;
  }

  /** 'indexeddb' | 'memory' */
  get backend() {
    return this._b.kind;
  }

  /** All world metas, most recently played first. */
  async listWorlds() {
    const list = await this._b.getAllWorlds();
    return list
      .filter((m) => m && typeof m.id === 'string')
      .sort((a, b) => (Number(b.lastPlayed) || 0) - (Number(a.lastPlayed) || 0));
  }

  /** Create or update a world meta (`meta.id` string). The object is stored as a structured clone. */
  async saveWorldMeta(meta) {
    checkMeta(meta);
    await this._b.putWorld(meta);
  }

  /** @returns {Promise<object|null>} */
  async loadWorldMeta(id) {
    return (await this._b.getWorld(id)) ?? null;
  }

  /** Delete a world meta and every chunk of that world (one transaction). */
  async deleteWorld(id) {
    await this._b.deleteWorld(id);
  }

  /** @returns {Promise<Set<string>>} 'cx,cz' keys of all saved chunks of the world */
  async getChunkKeys(worldId) {
    return new Set(await this._b.getChunkKeys(worldId));
  }

  /**
   * @returns {Promise<Uint8Array|null>} the chunk's blocks (fresh array) or null if not saved.
   *   Rejects on storage errors and on corrupt data (RangeError).
   */
  async loadChunk(worldId, cx, cz) {
    const rec = await this._b.getChunk(worldId, cx, cz);
    return rec == null ? null : decodeChunkRecord(rec);
  }

  /**
   * Save chunks in one transaction. The block arrays are read (compressed) synchronously during this
   * call, so callers may keep mutating them afterwards.
   * @param {string} worldId
   * @param {Array<{cx: number, cz: number, blocks: Uint8Array}>} chunks
   */
  saveChunks(worldId, chunks) {
    let records;
    try {
      records = chunks.map((c) => ({ cx: c.cx, cz: c.cz, rec: encodeChunkRecord(c.blocks) }));
    } catch (err) {
      return Promise.reject(err);
    }
    if (records.length === 0) return Promise.resolve();
    return this._b.putChunks(worldId, records);
  }

  /**
   * Store a small per-world record (structured-cloneable value, e.g. an Int32Array) under `name`.
   * Deleted together with the world.
   * @param {string} worldId @param {string} name @param {*} value
   */
  async saveWorldData(worldId, name, value) {
    if (typeof name !== 'string' || name === '') throw new TypeError('world data needs a non-empty name');
    await this._b.putData(worldId, name, value);
  }

  /** @returns {Promise<*>} the value stored by saveWorldData, or null */
  async loadWorldData(worldId, name) {
    return (await this._b.getData(worldId, name)) ?? null;
  }

  /**
   * Atomic save: world meta (may be null), chunks and per-world data records in ONE transaction, all
   * or nothing (a failed chunk write can never leave a newer meta behind). Chunks are compressed and the
   * IndexedDB transaction is created synchronously during this call (when the database is open), so it
   * is safe to call from pagehide / visibilitychange handlers: the browser commits it even if the page
   * dies right after. World.saveSnapshot(meta) builds the records and does the bookkeeping.
   * @param {string} worldId
   * @param {object|null} meta world meta (needs a string id) or null
   * @param {Array<{cx:number, cz:number, blocks?:Uint8Array, rec?:object}>} chunks raw blocks, or records
   *   already encoded with encodeChunkRecord
   * @param {Array<{name:string, value:*}>} [data] saveWorldData-style records
   * @returns {Promise<void>} resolves when committed
   */
  saveSnapshot(worldId, meta, chunks = [], data = []) {
    let records;
    try {
      if (meta) checkMeta(meta);
      records = chunks.map((c) => ({ cx: c.cx, cz: c.cz, rec: c.rec ?? encodeChunkRecord(c.blocks) }));
      for (const d of data) {
        if (typeof d.name !== 'string' || d.name === '') throw new TypeError('world data needs a non-empty name');
      }
      return this._b.putSnapshot(worldId, meta, records, data);
    } catch (err) {
      return Promise.reject(err);
    }
  }

  /** Alias of saveSnapshot (the name used by docs/notes/review-wave1.json WORLD-1). */
  saveAllSync(worldId, meta, chunks = [], data = []) {
    return this.saveSnapshot(worldId, meta, chunks, data);
  }

  /**
   * Exclusive per-world lock across tabs (Web Locks, review WORLD-7). Resolves to { release(), supported }
   * when this tab may open the world, or null when another tab holds it. Where Web Locks are unavailable
   * (insecure contexts, Node) it resolves to { release() {}, supported: false }. The browser releases the
   * lock by itself when the page goes away.
   * @param {string} worldId
   * @returns {Promise<{release: () => void, supported: boolean}|null>}
   */
  acquireWorldLock(worldId) {
    const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
    if (!locks || typeof locks.request !== 'function') return Promise.resolve({ release() {}, supported: false });
    return new Promise((resolve, reject) => {
      locks.request(`webcraft-world-${worldId}`, { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve(null);
          return null;
        }
        return new Promise((release) => resolve({ release: () => release(), supported: true }));
      }).catch(reject);
    });
  }

  /**
   * Ask the browser to keep this origin's data under storage pressure (best effort, review WORLD-6).
   * @returns {Promise<boolean>} true if the storage is (now) persistent
   */
  async requestPersistence() {
    try {
      const sm = typeof navigator !== 'undefined' ? navigator.storage : undefined;
      if (!sm || typeof sm.persist !== 'function') return false;
      if (typeof sm.persisted === 'function' && await sm.persisted()) return true;
      return await sm.persist();
    } catch {
      return false;
    }
  }

  /** Close the database connection (the instance reopens it if used again). */
  close() {
    this._b.close();
  }
}
