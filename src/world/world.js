// World manager (docs/SPEC.md §8, §9.6): streams the infinite world around the player.
//
// Streaming (all distances from the player's exact XZ position, see chunk.js classifyChunk):
//   mesh set   chunks intersecting the circle of radius 16*rd blocks (all the renderer can show
//              before its fog ends at 0.95*16*rd)
//   gen set    the 3x3 neighbourhoods of mesh chunks (meshing needs all 8 neighbours) ~ radius rd+1
//   keep set   one more ring; loaded chunks outside it are unloaded (~ beyond rd+2), modified ones are
//              saved first.
// Missing chunks of the gen set are read from Storage when a saved copy exists, otherwise generated in
// the worker pool. Every job carries a priority (lower = sooner): edits (tier 0) < light/remesh updates
// of visible chunks (tier 1) < everything else by centre distance (tier 2, nearest first). Queued jobs are
// reprioritized as the player moves and cancelled when their chunk is unloaded. Mesh jobs are throttled
// (their 3x3 block copies are taken at submission), generation jobs are tiny and queued all at once.
//
// Meshing: each chunk keeps a 16-bit dirty mask (sections to remesh). A mesh job takes the mask and a
// copy of the 3x3 block neighbourhood (only the layers up to each chunk's highest block), stamped with
// the global edit sequence number `seq`. Results apply per section only if no newer result for that
// section has been applied (sectionSeq), so out-of-order results never regress the display; edits made
// while a job is running set dirty bits again and are re-queued — nothing is ever lost. Results are
// uploaded to the renderer under a per-frame time budget (~4 ms), nearest first; sections whose mesh
// hash did not change are skipped. Edits (setBlock) mark, per SPEC §9.6, every chunk intersecting
// [x-15, x+15] x [z-15, z+15] dirty for sections 0..(y+15)>>4 (light), and the chunks containing the
// 3x3x3 cube around the edit as urgent: those are meshed with top priority as one group whose results are
// uploaded together in the same frame (no one-frame holes at chunk borders).
//
// Gameplay: getBlock / setBlock (block updates via blockupdates.js: support, gravity, liquids), liquid
// flow (fluids.js, scheduled ticks run by tick()), light from the newest mesh job of each chunk,
// heightmaps, random ticks (grass, saplings via WorldGenerator.growTree on a main-thread generator, sugar
// cane / cactus growth, plants that lost their support, wheat growth, farmland hydration, ice melting),
// onChunkGenerated callbacks (first generation of a chunk only — remembered across sessions in storage),
// saving in batches.

import { CHUNK_VOLUME, skyLightLevelAt } from '../config.js';
import {
  BLOCKS, BLOCK, IS_OPAQUE, IS_LIQUID, NEEDS_SUPPORT, RENDER_TYPE, RENDER, LIQUID_KIND, canStay, isWater,
} from './registry.js';
import {
  Chunk, ChunkState, chunkKeyNum, classifyChunk, chunkCenterDistance, editDirtyRange, SET_MESH, SET_GEN,
} from './chunk.js';
import { BlockUpdater } from './blockupdates.js';
import { FluidSimulator } from './fluids.js';
import { Storage } from './storage.js';
import { WorldGenerator } from './worldgen.js';

const { NEW, LOADING, GENERATING, READY, UNLOADED } = ChunkState;

/** Base priority per job tier: 0 = edit (urgent), 1 = remesh of a visible chunk, 2 = load/first mesh. */
const TIER_BASE = [-2e6, -1e6, 0];
const MAX_ATTEMPTS = 3;
const SAVE_BATCH = 16;
const RANDOM_TICK_SPEED = 3;           // Minecraft's randomTickSpeed: blocks per section per tick
const NEIGHBOURS = [-1, -1, 0, -1, 1, -1, -1, 0, 1, 0, -1, 1, 0, 1, 1, 1];

const AIR = BLOCK.AIR;
const DIRT = BLOCK.DIRT;
const GRASS = BLOCK.GRASS_BLOCK;
const SNOWY_GRASS = BLOCK.SNOWY_GRASS_BLOCK;
const WATER = BLOCK.WATER;
const ICE = BLOCK.ICE;
const FARMLAND = BLOCK.FARMLAND;
const FARMLAND_MOIST = BLOCK.FARMLAND_MOIST;
const WHEAT_0 = BLOCK.WHEAT_0;
const WHEAT_7 = BLOCK.WHEAT_7;

// Leaves and logs (all variants) for leaf decay.
const IS_LEAVES = new Uint8Array(256);
const IS_LOG = new Uint8Array(256);
for (const b of BLOCKS) {
  if (b.renderType === 'cube' && b.name.endsWith('_leaves')) IS_LEAVES[b.id] = 1;
  if (/_log(_x|_z)?$/.test(b.name)) IS_LOG[b.id] = 1;
}

// Random tick behaviours by block id.
const T_GRASS = 1, T_SAPLING = 2, T_STACK = 3, T_ICE = 4, T_CROP = 5, T_FARMLAND = 6, T_PLANT = 7, T_LEAVES = 8;
const RANDOM_TICK = new Uint8Array(256);
// Plants re-check their support on random ticks (Minecraft BlockBush.updateTick -> checkAndDropBlock).
for (const b of BLOCKS) {
  if (NEEDS_SUPPORT[b.id] === 1 && RENDER_TYPE[b.id] === RENDER.CROSS) RANDOM_TICK[b.id] = T_PLANT;
}
RANDOM_TICK[GRASS] = T_GRASS;
RANDOM_TICK[SNOWY_GRASS] = T_GRASS;
RANDOM_TICK[BLOCK.OAK_SAPLING] = T_SAPLING;
RANDOM_TICK[BLOCK.BIRCH_SAPLING] = T_SAPLING;
RANDOM_TICK[BLOCK.SPRUCE_SAPLING] = T_SAPLING;
RANDOM_TICK[BLOCK.SUGAR_CANE] = T_STACK;
RANDOM_TICK[BLOCK.CACTUS] = T_STACK;
RANDOM_TICK[ICE] = T_ICE;
for (let id = WHEAT_0; id <= WHEAT_7; id++) RANDOM_TICK[id] = T_CROP;
RANDOM_TICK[FARMLAND] = T_FARMLAND;
RANDOM_TICK[FARMLAND_MOIST] = T_FARMLAND;
for (let id = 0; id < 256; id++) if (IS_LEAVES[id] === 1) RANDOM_TICK[id] = T_LEAVES;

const isWheat = (id) => id >= WHEAT_0 && id <= WHEAT_7;

const VALID_ID = new Uint8Array(256);
for (const b of BLOCKS) VALID_ID[b.id] = 1;

/** Name of the per-world record (storage.saveWorldData) listing chunks that were generated once. */
const POPULATED_RECORD = 'populated';
/** Per-world record of leaves waiting for a decay check (Int32Array of x, y, z triples). */
const DECAY_RECORD = 'leafDecay';
/** Per-world record of player-placed (persistent) leaves (Int32Array of x, y, z triples). */
const PLACED_LEAVES_RECORD = 'placedLeaves';
/** Leaves decay when no log is reachable within 6 steps through leaves (Minecraft 1.14+ distance 7). */
const LEAF_RANGE = 6;
const LEAF_BOX = 2 * LEAF_RANGE + 1;
/** Leaves within this Chebyshev radius of a removed log become decay candidates (Minecraft 1.12: 4). */
const LOG_NOTIFY_RADIUS = 4;
/** Chunks written per background unload save (encoding is synchronous; keeps frames short). */
const UNLOAD_BATCH = 16;
/** Upper bound of remembered leaf-decay candidates (oldest dropped first). */
const MAX_DECAY_CANDIDATES = 100000;
/** Generation events kept while no onChunkGenerated listener is registered (delivered to the first one). */
const MAX_QUEUED_GENERATED = 4096;

let nextOwner = 1;
let nextUid = 1;
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Int32Array [x, y, z, ...] of a Set of 'x,y,z' keys. */
function tripleArray(set) {
  const rec = new Int32Array(set.size * 3);
  let i = 0;
  for (const key of set) {
    const a = key.indexOf(','), b = key.indexOf(',', a + 1);
    rec[i++] = Number(key.slice(0, a));
    rec[i++] = Number(key.slice(a + 1, b));
    rec[i++] = Number(key.slice(b + 1));
  }
  return rec;
}

function clampRenderDistance(n) {
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? Math.min(32, Math.max(2, v)) : 8;
}

export class World {
  /**
   * @param {object} options
   * @param {number} options.seed uint32 world seed
   * @param {'default'|'flat'} [options.worldType]
   * @param {string} [options.worldId] storage id of the world
   * @param {Storage|null} [options.storage] null = no persistence (edits of unloaded chunks are kept in memory)
   * @param {import('./workerpool.js').WorkerPool} options.pool
   * @param {object|null} [options.renderer] needs setSectionMesh(cx, sy, cz, o, c, t) / removeChunk(cx, cz)
   * @param {number} [options.renderDistance] chunks (2..32)
   * @param {boolean} [options.smoothLighting]
   * @param {(itemId:number, count:number, x:number, y:number, z:number) => void} [options.onDropItem]
   *   items from popped / broken blocks; (x, y, z) = centre of the block
   * @param {(blockId:number, x:number, y:number, z:number) => boolean} [options.onFallingBlock]
   *   optional: a gravity block left cell (x, y, z) (already air); return true after spawning a falling
   *   block entity (e.g. entities.spawnFallingBlock(id, x + 0.5, y, z + 0.5)). Without it, or when it
   *   returns false, blocks fall instantly (SPEC wave 1). Also settable later: world.onFallingBlock = fn.
   * @param {(name:string, x:number, y:number, z:number) => void} [options.onEffect]
   *   optional: world sound / particle effects at a point (block centre). Currently 'fizz' — lava meeting
   *   water (obsidian / cobblestone / stone) or lava burning a plant: Minecraft plays the extinguish sound
   *   (volume 0.5, high pitch) and 8 large smoke particles. Also settable later: world.onEffect = fn.
   * @param {(blockId:number, x:number, y:number, z:number) => void} [options.onBlockPopped]
   *   optional: a block broke because it lost its support (torch whose wall was mined, flowers on a removed
   *   block, sugar cane without water...); (x, y, z) = the block cell, already air. Minecraft plays the
   *   break particles and sound (destroyBlock). Also settable later: world.onBlockPopped = fn.
   * @param {number} [options.uploadBudgetMs] GPU upload time per frame (default 4)
   * @param {number} [options.tickRadius] random-tick radius in chunks (default 8, capped by rd)
   * @param {number} [options.maxMeshJobs] mesh jobs (tiers 1-2) outstanding at once
   * @param {WorldGenerator} [options.generator] main-thread generator (default: created lazily)
   * @param {number} [options.fluidBudgetMs] time budget of liquid updates per tick (default 2 ms)
   */
  constructor({
    seed = 0, worldType = 'default', worldId = 'world', storage = null, pool, renderer = null,
    renderDistance = 8, smoothLighting = true, onDropItem = null, onFallingBlock = null, onEffect = null,
    onBlockPopped = null, uploadBudgetMs = 4, tickRadius = 8, maxMeshJobs, generator = null, fluidBudgetMs = 2,
  } = {}) {
    if (!pool || typeof pool.submit !== 'function') throw new TypeError('World needs a WorkerPool (options.pool)');
    this.seed = seed >>> 0;
    this.worldType = worldType === 'flat' ? 'flat' : 'default';
    this.worldId = String(worldId);
    /** True when chunks are written to a persistent Storage. */
    this.persistent = !!storage && storage.persistent !== false;
    this.storage = storage ?? Storage.memory();
    this.pool = pool;
    this.renderer = renderer;
    this.renderDistance = clampRenderDistance(renderDistance);
    this.smoothLighting = smoothLighting !== false;
    this.onDropItem = onDropItem;
    this.onFallingBlock = onFallingBlock;
    this.onEffect = onEffect;
    this.onBlockPopped = onBlockPopped;
    this.uploadBudgetMs = uploadBudgetMs;
    this.tickRadius = tickRadius;
    this.maxMeshJobs = maxMeshJobs ?? Math.max(4, (pool.size || 2) * 3);

    this._owner = nextOwner++;
    this._generator = generator;
    /** @type {Map<number, Chunk>} */
    this._chunks = new Map();
    this._lastChunk = null;

    // player / streaming state
    this._px = 0; this._py = 0; this._pz = 0;
    this._hasPos = false;
    this._setsX = NaN; this._setsZ = NaN;
    this._needSets = true;
    this._newChunks = [];
    this._storageLoads = 0;
    this.maxStorageLoads = 24;
    this._savedKeys = new Set();            // null = unknown index (always try storage first)

    // meshing state
    this._editSeq = 0;
    this._meshEpoch = 0;
    this._urgent = new Set();
    this._meshScan = true;
    this._meshOutstanding = 0;
    this._candidates = [];
    this._uploadList = [];
    this._buffers = [];
    this._range = {};

    // persistence
    this._unloadSaves = new Map();          // 'cx,cz' -> { cx, cz, blocks } of unloaded modified chunks
    this._unloadWrite = null;
    this._unloadRetryAt = 0;
    this._unloadWarned = false;
    this._saveChain = Promise.resolve();
    this._destroyPromise = null;

    this._listeners = [];
    this._generatedListeners = [];
    this._generatedQueue = [];              // [cx, cz, ...] events waiting for the first listener
    /** @type {Set<string>} ids ('cx,cz') of chunks generated at least once (persisted, see save()) */
    this._populated = new Set();
    this._populatedVersion = 0;             // bumped on every change; *Saved = version last written
    this._populatedSaved = 0;
    /** @type {Set<string>} 'x,y,z' of leaves that may decay (a log nearby was removed; persisted) */
    this._decayCandidates = new Set();
    /** @type {Set<number>} chunk keys holding decay candidates (allocation-free random-tick pre-filter) */
    this._decayChunks = new Set();
    this._decayVersion = 0;
    this._decaySaved = 0;
    /** @type {Set<string>} 'x,y,z' of leaves placed by the player / commands: they never decay (persisted) */
    this._placedLeaves = new Set();
    this._placedVersion = 0;
    this._placedSaved = 0;
    this._naturalPlacement = false;         // true while a sapling grows (its leaves are natural)
    this._frozen = false;                   // final save of destroy() in progress: edits are refused
    this._bfsStamp = new Uint32Array(LEAF_BOX ** 3);
    this._bfsQueue = new Int32Array(LEAF_BOX ** 3);
    this._bfsDist = new Uint8Array(LEAF_BOX ** 3);
    this._bfsCounter = 0;
    this._initPromise = null;
    this._initDone = false;
    this._closing = false;
    this._destroyed = false;
    this._skyDarken = 0;
    this._loggedErrors = new Set();

    this.counters = {
      generated: 0, generateMs: 0, loadedFromStorage: 0, meshJobs: 0, meshMs: 0,
      uploads: 0, uploadsSkipped: 0, uploadBytes: 0, ticks: 0,
    };

    const dropItem = (itemId, count, x, y, z) => {
      if (typeof this.onDropItem === 'function') this.onDropItem(itemId, count, x, y, z);
    };
    /**
     * Liquid flow (docs/SPEC-wave2.md §5.1). Entities use `world.fluids.flowVector(x, y, z, out)` (or the
     * SPEC form `flowVector(world, x, y, z, out)`) for the current push.
     * @type {FluidSimulator}
     */
    this.fluids = new FluidSimulator(this, {
      onDropItem: dropItem,
      onEffect: (name, x, y, z) => this._effect(name, x, y, z),
      isAreaLoaded: (x, z, r) => this._areaLoaded(x, z, r),
      budgetMs: fluidBudgetMs,
    });
    this.updater = new BlockUpdater(this, {
      onDropItem: dropItem,
      onFall: (blockId, x, y, z) => typeof this.onFallingBlock === 'function' &&
        this.onFallingBlock(blockId, x, y, z) === true,
      onBlockPopped: (blockId, x, y, z) => {
        if (typeof this.onBlockPopped === 'function') this.onBlockPopped(blockId, x, y, z);
      },
      fluids: this.fluids,
    });
    this._getBlock = (x, y, z) => this.getBlock(x, y, z);   // for registry canStay (created once)
    this._treeAccess = {
      getBlock: (x, y, z) => this.getBlock(x, y, z),
      setBlock: (x, y, z, id) => this.setBlock(x, y, z, id),
    };

    // comparators / callbacks created once (no per-frame closures)
    this._byDist = (a, b) => a.dist - b.dist;
    this._byMeshPriority = (a, b) => ((a.meshedOnce ? 1 : 2) - (b.meshedOnce ? 1 : 2)) || (a.dist - b.dist);
    this._byUploadPriority = (a, b) => ((b.uploadUrgent ? 1 : 0) - (a.uploadUrgent ? 1 : 0)) || (a.dist - b.dist);
    this._obsoleteJob = (job) => job.owner === this._owner && !this._jobWanted(job);
    this._reprioritizeJob = (job, old) => {
      if (job.owner !== this._owner) return old;
      const c = this._chunks.get(chunkKeyNum(job.cx, job.cz));
      const d = c !== undefined ? c.dist : chunkCenterDistance(this._px, this._pz, job.cx, job.cz);
      return TIER_BASE[job.tier ?? 2] + d;
    };
  }

  // ===============================================================================================
  // Lifecycle
  // ===============================================================================================

  /**
   * Broadcast the world seed to the workers and read the index of saved chunks. update() does nothing
   * until this has finished (it starts it automatically if needed).
   */
  init() {
    if (this._initPromise) return this._initPromise;
    this._initPromise = (async () => {
      this.pool.init(this.seed, this.worldType);
      try {
        this._savedKeys = await this.storage.getChunkKeys(this.worldId);
      } catch (err) {
        console.warn('[world] could not read the saved chunk index; probing storage per chunk:', err);
        this._savedKeys = null;
      }
      if (typeof this.storage.loadWorldData === 'function') {
        try {
          const rec = await this.storage.loadWorldData(this.worldId, POPULATED_RECORD);
          if (rec instanceof Int32Array) {
            for (let i = 0; i + 1 < rec.length; i += 2) this._populated.add(rec[i] + ',' + rec[i + 1]);
          }
          const dec = await this.storage.loadWorldData(this.worldId, DECAY_RECORD);
          if (dec instanceof Int32Array) {
            for (let i = 0; i + 2 < dec.length; i += 3) {
              this._decayCandidates.add(dec[i] + ',' + dec[i + 1] + ',' + dec[i + 2]);
              this._decayChunks.add(chunkKeyNum(dec[i] >> 4, dec[i + 2] >> 4));
            }
          }
          const pl = await this.storage.loadWorldData(this.worldId, PLACED_LEAVES_RECORD);
          if (pl instanceof Int32Array) {
            for (let i = 0; i + 2 < pl.length; i += 3) {
              this._placedLeaves.add(pl[i] + ',' + pl[i + 1] + ',' + pl[i + 2]);
            }
          }
        } catch (err) {
          console.warn('[world] could not read the world data records:', err);
        }
      }
      this._initDone = true;
    })();
    return this._initPromise;
  }

  /**
   * Per frame: stream chunks around the player, schedule generation / meshing, apply results and
   * upload meshes within the time budget.
   */
  update(px, py, pz, dt = 0) {
    if (this._closing) return;
    if (Number.isFinite(px) && Number.isFinite(pz)) {
      this._px = px;
      this._py = Number.isFinite(py) ? py : this._py;
      this._pz = pz;
      this._hasPos = true;
    }
    if (!this._initDone) {
      if (!this._initPromise) this.init().catch((err) => console.error('[world] init failed:', err));
      return;
    }
    if (!this._hasPos) return;
    if (this._needSets || Math.abs(this._px - this._setsX) + Math.abs(this._pz - this._setsZ) > 2) this._updateSets();
    if (this._newChunks.length > 0) this._startLoads();
    this._scheduleMeshes();
    if (this._uploadList.length > 0) this._uploadMeshes();
    if (this._unloadSaves.size > 0 && this._unloadWrite === null) this._flushUnloadSaves(false);
  }

  /** Save every modified chunk (in batches of 16 per transaction). Concurrent calls are serialized. */
  save() {
    const run = () => this._saveAll();
    const p = this._saveChain.then(run, run);
    this._saveChain = p.catch(() => {});
    return p;
  }

  /**
   * Close the world: save (unless `save: false`), then cancel its jobs, remove its meshes and release its
   * memory. While the final save runs, edits are refused (setBlock returns false, tick() does nothing) so
   * the save captures the final state, but the world stays visible. If saving fails the promise rejects
   * and the world is back to normal — still loaded, rendered and editable (review CODE-1): the caller can
   * keep playing, retry, or call destroy({ save: false }) to quit without saving.
   * @param {{ save?: boolean }} [options]
   * @returns {Promise<void>}
   */
  destroy({ save = true } = {}) {
    if (this._destroyPromise) return this._destroyPromise;
    this._frozen = true;
    const p = save ? this.save() : Promise.resolve();
    this._destroyPromise = p.then(() => this._close(), (err) => {
      this._frozen = false;
      this._destroyPromise = null;
      throw err;
    });
    return this._destroyPromise;
  }

  /** Release everything (after the final save). */
  _close() {
    this._closing = true;
    this.pool.cancel((job) => job.owner === this._owner);
    if (this.renderer) {
      for (const c of this._chunks.values()) {
        if (c.uploadedMask !== 0) this.renderer.removeChunk(c.cx, c.cz);
        c.uploadedMask = 0;
      }
    }
    this._uploadList.length = 0;
    this._urgent.clear();
    this._destroyed = true;
    for (const c of this._chunks.values()) {
      c.state = UNLOADED;
      c.blocks = null;
      c.light = null;
    }
    this._chunks.clear();
    this._lastChunk = null;
    this._buffers.length = 0;
    this._listeners.length = 0;
    this._generatedListeners.length = 0;
    this._generatedQueue.length = 0;
    this._newChunks.length = 0;
    this._unloadSaves.clear();
    this.updater.clear();
    this.fluids.clear();
  }

  // ===============================================================================================
  // Block access
  // ===============================================================================================

  /** Block id at integer world coordinates (AIR for unloaded chunks or y outside 0..255). */
  getBlock(x, y, z) {
    if (y < 0 || y > 255) return AIR;
    const cx = x >> 4, cz = z >> 4;
    let c = this._lastChunk;
    if (c === null || c.cx !== cx || c.cz !== cz) {
      c = this._chunks.get(chunkKeyNum(cx, cz));
      if (c === undefined || c.blocks === null) return AIR;
      this._lastChunk = c;
    }
    return c.blocks[(y << 8) | ((z & 15) << 4) | (x & 15)];
  }

  /**
   * Change a block. Updates heightmap / light dirtiness / save state, notifies onBlockChanged listeners
   * and (unless update === false) runs block updates (support popping, falling sand).
   * @returns {boolean} false if the chunk is not loaded, y is out of range or id is not a block
   */
  setBlock(x, y, z, id, opts) {
    if (y < 0 || y > 255 || this._closing || this._frozen) return false;
    if (VALID_ID[id] !== 1 || (id | 0) !== id) return false;
    const c = this._chunkAt(x >> 4, z >> 4);
    if (c === null) return false;
    const lx = x & 15, lz = z & 15;
    const idx = (y << 8) | (lz << 4) | lx;
    const old = c.blocks[idx];
    if (old === id) return true;
    c.blocks[idx] = id;
    c.updateHeight(lx, y, lz, id);
    c.modified = true;
    c.editCount++;
    this._editSeq++;
    this._markDirty(x, y, z);
    if (IS_LOG[old] === 1 && IS_LOG[id] === 0) this._markLeaves(x, y, z, LOG_NOTIFY_RADIUS);
    if (IS_LEAVES[id] === 1) {
      if (!this._naturalPlacement) {
        this._placedLeaves.add(x + ',' + y + ',' + z);
        this._placedVersion++;
      }
    } else if (IS_LEAVES[old] === 1 && this._placedLeaves.size > 0) {
      if (this._placedLeaves.delete(x + ',' + y + ',' + z)) this._placedVersion++;
    }
    if (this._listeners.length > 0) this._emitChange(x, y, z, old, id);
    if (!opts || opts.update !== false) {
      const u = this.updater;
      if (LIQUID_KIND[old] !== LIQUID_KIND[id] && y < 255) {
        // Water appeared / vanished next to the ground block of a sugar cane: re-check the cane now
        // (the cane is diagonal to the changed cell, so the 6-neighbour checks miss it).
        u.enqueue(x + 1, y + 1, z);
        u.enqueue(x - 1, y + 1, z);
        u.enqueue(x, y + 1, z + 1);
        u.enqueue(x, y + 1, z - 1);
      }
      u.blockChanged(x, y, z);
    }
    return true;
  }

  /** Packed light (sky << 4 | block) from the chunk's newest mesh job; 0xF0 when unknown / outside. */
  getLight(x, y, z) {
    if (y < 0 || y > 255) return 0xf0;
    const c = this._chunkAt(x >> 4, z >> 4);
    if (c === null) return 0xf0;
    const L = c.light;
    if (L === null) return 0xf0;
    const i = (y << 8) | ((z & 15) << 4) | (x & 15);
    return i < L.length ? L[i] : 0xf0;     // stored light is trimmed above the open sky
  }

  /** y of the highest non-air block of the column, -1 if empty or not loaded. */
  getTopY(x, z) {
    const c = this._chunkAt(x >> 4, z >> 4);
    if (c === null) return -1;
    return c.heightmap[((z & 15) << 4) | (x & 15)];
  }

  isChunkGenerated(cx, cz) {
    const c = this._chunks.get(chunkKeyNum(cx, cz));
    return c !== undefined && c.state === READY;
  }

  /** True once every section of the chunk has been meshed and uploaded at least once. */
  isChunkMeshed(cx, cz) {
    const c = this._chunks.get(chunkKeyNum(cx, cz));
    return c !== undefined && c.meshedOnce;
  }

  /**
   * True when the chunk containing (x, z) and every chunk within `radiusChunks` (square) of it that lies
   * inside the render distance are meshed.
   */
  isAreaReady(x, z, radiusChunks = 1) {
    const ccx = Math.floor(x) >> 4, ccz = Math.floor(z) >> 4;
    const center = this._chunks.get(chunkKeyNum(ccx, ccz));
    if (center === undefined || !center.meshedOnce) return false;
    const r = Math.max(0, Math.floor(radiusChunks));
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const c = this._chunks.get(chunkKeyNum(ccx + dx, ccz + dz));
        if (c !== undefined) {
          if (c.meshedOnce) continue;
          if ((c.flags & SET_MESH) !== 0) return false;
        } else if (!this._hasPos ||
          (classifyChunk(this._px, this._pz, ccx + dx, ccz + dz, this.renderDistance) & SET_MESH) !== 0) {
          return false;
        }
      }
    }
    return true;
  }

  /** Register fn(x, y, z, oldId, newId), called for every block change. Returns an unsubscribe function. */
  onBlockChanged(fn) {
    if (typeof fn !== 'function') return () => {};
    this._listeners.push(fn);
    return () => {
      const i = this._listeners.indexOf(fn);
      if (i >= 0) this._listeners.splice(i, 1);
    };
  }

  /**
   * Register fn(cx, cz), called once when a chunk has been generated for the first time in this world
   * (its blocks are available; neighbours may not be). Not called for chunks loaded from storage, nor when
   * an unmodified chunk is generated again after being unloaded (the set of generated chunks is saved
   * with the world). Events that happened before the first listener registered are delivered to it.
   * Returns an unsubscribe function.
   */
  onChunkGenerated(fn) {
    if (typeof fn !== 'function') return () => {};
    this._generatedListeners.push(fn);
    if (this._generatedQueue.length > 0) {
      const q = this._generatedQueue.splice(0);
      for (let i = 0; i < q.length; i += 2) this._callGenerated(fn, q[i], q[i + 1]);
    }
    return () => {
      const i = this._generatedListeners.indexOf(fn);
      if (i >= 0) this._generatedListeners.splice(i, 1);
    };
  }

  /** True if every chunk overlapping [x - r, x + r] x [z - r, z + r] (blocks) has its blocks loaded. */
  isAreaLoaded(x, z, r = 0) {
    return this._areaLoaded(Math.floor(x), Math.floor(z), Math.max(0, Math.floor(r)));
  }

  /** The Chunk object at (cx, cz) or null (debugging / tools). */
  getChunk(cx, cz) {
    return this._chunks.get(chunkKeyNum(cx, cz)) ?? null;
  }

  /** Main-thread WorldGenerator with this world's seed / type (created on first use). */
  get generator() {
    if (!this._generator) this._generator = new WorldGenerator(this.seed, this.worldType);
    return this._generator;
  }

  /** Biome at a world column (debug screen). */
  getBiome(x, z) {
    return this.generator.getBiome(x, z);
  }

  /** Spawn column for a new world: { x, y, z } (y = first free block). */
  findSpawn() {
    return this.generator.findSpawn();
  }

  // ===============================================================================================
  // Settings
  // ===============================================================================================

  setRenderDistance(n) {
    const rd = clampRenderDistance(n);
    if (rd === this.renderDistance) return;
    this.renderDistance = rd;
    this._needSets = true;
  }

  setSmoothLighting(on) {
    const v = !!on;
    if (v === this.smoothLighting) return;
    this.smoothLighting = v;
    this.remeshAll();
  }

  /**
   * Remesh and re-upload every loaded chunk (smooth lighting changed, WebGL context restored).
   * Results of older mesh jobs are discarded.
   */
  remeshAll() {
    this._meshEpoch++;
    this._editSeq++;
    for (const c of this._chunks.values()) {
      if (c.state !== READY) continue;
      c.dirtyMask = 0xffff;
      c.hashKnown = 0;
      c.sectionSeq.fill(-1);
      c.pending.fill(null);
      c.pendingMask = 0;
      c.uploadUrgent = false;
      c.meshAttempts = 0;
    }
    this._urgent.clear();
    this.pool.cancel((job) => job.owner === this._owner && job.type === 'mesh');
    this._meshScan = true;
  }

  // ===============================================================================================
  // Ticks
  // ===============================================================================================

  /**
   * One game tick (20 per second): scheduled liquid updates (budgeted), leftover block updates, then
   * random ticks — RANDOM_TICK_SPEED (3) random blocks per section of every loaded chunk within the tick
   * radius.
   * @param {() => number} [rng] random source in [0, 1)
   * @param {number} [timeOfDay] 0..1 (SPEC §4); scales sky light for growth rules. Omitted = full daylight.
   */
  tick(rng = Math.random, timeOfDay) {
    if (!this._initDone || this._closing || this._frozen) return;
    this.counters.ticks++;
    this.fluids.tick();
    if (this.updater.pending > 0) this.updater.process();
    this._skyDarken = Number.isFinite(timeOfDay) ? 15 - skyLightLevelAt(timeOfDay - Math.floor(timeOfDay)) : 0;
    const radius = Math.min(this.tickRadius, this.renderDistance) + 0.5;
    for (const c of this._chunks.values()) {
      if (c.state !== READY || c.light === null || c.dist > radius) continue;
      const top = c.maxY >> 4;
      const blocks = c.blocks;
      const bx = c.cx << 4, bz = c.cz << 4;
      for (let sy = 0; sy <= top; sy++) {
        for (let k = 0; k < RANDOM_TICK_SPEED; k++) {
          const r = (rng() * 4096) | 0;
          const lx = r & 15, ly = (r >> 4) & 15, lz = r >> 8;
          const y = (sy << 4) | ly;
          const id = blocks[(y << 8) | (lz << 4) | lx];
          const kind = RANDOM_TICK[id];
          if (kind !== 0) this._randomTick(kind, id, bx + lx, y, bz + lz, rng);
        }
      }
    }
  }

  // ===============================================================================================
  // Stats
  // ===============================================================================================

  /**
   * @returns {{ loaded: number, meshed: number, pendingGenerate: number, pendingMesh: number,
   *   modified: number, uploadQueue: number, jobs: number, idle: boolean, renderDistance: number,
   *   avgGenerateMs: number, avgMeshMs: number, uploads: number, uploadsSkipped: number, uploadMB: number }}
   */
  stats() {
    let loaded = 0, meshed = 0, pendingGenerate = 0, pendingMesh = 0, modified = 0;
    for (const c of this._chunks.values()) {
      if (c.state === READY) {
        loaded++;
        if (c.meshedOnce) meshed++;
        if (c.modified) modified++;
        if ((c.flags & SET_MESH) !== 0 && (c.meshJobs > 0 || c.pendingMask !== 0 ||
          (c.dirtyMask !== 0 && c.meshAttempts < MAX_ATTEMPTS))) pendingMesh++;
      } else {
        pendingGenerate++;
      }
    }
    const k = this.counters;
    const uploadQueue = this._uploadList.length;
    return {
      loaded, meshed, pendingGenerate, pendingMesh,
      modified: modified + this._unloadSaves.size,
      uploadQueue,
      jobs: this.pool.pending ?? 0,
      idle: pendingGenerate === 0 && pendingMesh === 0 && uploadQueue === 0,
      renderDistance: this.renderDistance,
      pendingFluids: this.fluids.pending,
      fluidUpdates: this.fluids.counters.updates,
      generated: k.generated,
      avgGenerateMs: k.generated ? k.generateMs / k.generated : 0,
      loadedFromStorage: k.loadedFromStorage,
      meshJobs: k.meshJobs,
      avgMeshMs: k.meshJobs ? k.meshMs / k.meshJobs : 0,
      uploads: k.uploads,
      uploadsSkipped: k.uploadsSkipped,
      uploadMB: k.uploadBytes / 1048576,
    };
  }

  // ===============================================================================================
  // Streaming
  // ===============================================================================================

  _chunkAt(cx, cz) {
    const last = this._lastChunk;
    if (last !== null && last.cx === cx && last.cz === cz) return last;
    const c = this._chunks.get(chunkKeyNum(cx, cz));
    if (c === undefined || c.blocks === null) return null;
    this._lastChunk = c;
    return c;
  }

  _jobWanted(job) {
    const c = this._chunks.get(chunkKeyNum(job.cx, job.cz));
    return c !== undefined && c.uid === job.uid;
  }

  /** Recompute set membership, unload chunks that left the keep set, add missing gen-set chunks. */
  _updateSets() {
    this._needSets = false;
    const px = this._px, pz = this._pz, rd = this.renderDistance;
    this._setsX = px;
    this._setsZ = pz;
    let removed = 0;
    for (const c of this._chunks.values()) {
      const f = classifyChunk(px, pz, c.cx, c.cz, rd);
      if (f === 0 || (c.state !== READY && (f & SET_GEN) === 0)) {
        this._unload(c);
        removed++;
        continue;
      }
      if ((f & SET_MESH) !== 0 && (c.flags & SET_MESH) === 0) this._meshScan = true;
      c.flags = f;
      c.dist = chunkCenterDistance(px, pz, c.cx, c.cz);
    }
    const pcx = Math.floor(px / 16), pcz = Math.floor(pz / 16);
    const ext = rd + 2;
    for (let dz = -ext; dz <= ext; dz++) {
      for (let dx = -ext; dx <= ext; dx++) {
        const cx = pcx + dx, cz = pcz + dz;
        const key = chunkKeyNum(cx, cz);
        if (this._chunks.has(key)) continue;
        const f = classifyChunk(px, pz, cx, cz, rd);
        if ((f & SET_GEN) === 0) continue;
        const c = new Chunk(cx, cz);
        c.uid = nextUid++;
        c.flags = f;
        c.dist = chunkCenterDistance(px, pz, cx, cz);
        this._chunks.set(key, c);
        this._newChunks.push(c);
      }
    }
    if (removed > 0) this.pool.cancel(this._obsoleteJob);
    this.pool.reprioritize(this._reprioritizeJob);
  }

  _unload(c) {
    if (c.state === READY) {
      for (let i = 0; i < 16; i += 2) {
        const o = this._chunks.get(chunkKeyNum(c.cx + NEIGHBOURS[i], c.cz + NEIGHBOURS[i + 1]));
        if (o !== undefined && o.state === READY) o.readyNeighbours--;
      }
      if (c.modified) this._unloadSaves.set(c.id, { id: c.id, cx: c.cx, cz: c.cz, blocks: c.blocks });
      if (c.uploadedMask !== 0 && this.renderer) this.renderer.removeChunk(c.cx, c.cz);
      // Pending liquid ticks die with the chunk; scanChunk() finds unsettled liquids again on reload.
      this.fluids.dropChunk(c.cx, c.cz);
    }
    c.state = UNLOADED;
    c.pending.fill(null);
    c.pendingMask = 0;
    c.light = null;
    c.uploadedMask = 0;
    this._chunks.delete(c.key);
    this._urgent.delete(c);
    if (this._lastChunk === c) this._lastChunk = null;
  }

  /** Start storage reads / generation jobs for NEW chunks, nearest first. */
  _startLoads() {
    const list = this._newChunks;
    if (list.length > 1) list.sort(this._byDist);
    let w = 0;
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (c.state !== NEW || this._chunks.get(c.key) !== c) continue;
      const pendingSave = this._unloadSaves.get(c.id);
      if (pendingSave !== undefined) {
        // Unloaded with unsaved edits and wanted again: reuse the data (still marked modified).
        this._unloadSaves.delete(c.id);
        this._applyBlocks(c, pendingSave.blocks, true);
        this._scanLiquids(c);
        continue;
      }
      if (this._savedKeys === null || this._savedKeys.has(c.id)) {
        if (this._storageLoads >= this.maxStorageLoads) {
          list[w++] = c;
          continue;
        }
        this._loadFromStorage(c);
      } else {
        this._submitGenerate(c);
      }
    }
    list.length = w;
  }

  _loadFromStorage(c) {
    c.state = LOADING;
    this._storageLoads++;
    this.storage.loadChunk(this.worldId, c.cx, c.cz).then((blocks) => {
      this._storageLoads--;
      if (this._closing || this._chunks.get(c.key) !== c) return;
      if (blocks instanceof Uint8Array && blocks.length === CHUNK_VOLUME) {
        c.fromStorage = true;
        this.counters.loadedFromStorage++;
        this._applyBlocks(c, blocks, false);
        this._scanLiquids(c);
      } else {
        if (this._savedKeys !== null) this._savedKeys.delete(c.id);
        this._submitGenerate(c);
      }
    }, (err) => {
      this._storageLoads--;
      if (this._closing || this._chunks.get(c.key) !== c) return;
      c.loadAttempts++;
      if (c.loadAttempts < MAX_ATTEMPTS && !(err instanceof RangeError)) {
        c.state = NEW;
        this._newChunks.push(c);
      } else {
        console.warn(`[world] chunk ${c.id} could not be loaded (${err?.message ?? err}); regenerating it`);
        this._submitGenerate(c);
      }
    });
  }

  _submitGenerate(c) {
    c.state = GENERATING;
    const job = { type: 'generate', cx: c.cx, cz: c.cz, owner: this._owner, uid: c.uid, tier: 2 };
    this.pool.submit(job, TIER_BASE[2] + c.dist, []).then(
      (res) => this._onGenerated(c, res),
      (err) => this._onGenerateFailed(c, err));
  }

  _onGenerated(c, res) {
    if (this._closing || this._chunks.get(c.key) !== c) return;
    const blocks = res && res.blocks;
    if (!(blocks instanceof Uint8Array) || blocks.length !== CHUNK_VOLUME) {
      this._onGenerateFailed(c, new Error('generate job returned no block data'));
      return;
    }
    this.counters.generated++;
    this.counters.generateMs += res.ms || 0;
    this._applyBlocks(c, blocks, false);
    this._chunkGenerated(c);
  }

  _onGenerateFailed(c, err) {
    if (this._closing || this._chunks.get(c.key) !== c) return;
    if (err && err.cancelled) {
      c.state = NEW;
      this._newChunks.push(c);
      return;
    }
    c.genAttempts++;
    this._logOnce('generate', `[world] generating chunk ${c.id} failed:`, err);
    if (c.genAttempts < MAX_ATTEMPTS) {
      c.state = NEW;
      this._newChunks.push(c);
      return;
    }
    // Last resort: generate on the main thread; an empty chunk if even that fails.
    let blocks;
    try {
      blocks = this.generator.generateChunk(c.cx, c.cz);
    } catch (e) {
      console.error(`[world] chunk ${c.id} cannot be generated, leaving it empty:`, e);
      blocks = new Uint8Array(CHUNK_VOLUME);
    }
    this._applyBlocks(c, blocks, false);
    this._chunkGenerated(c);
  }

  /** A chunk was generated: fire onChunkGenerated the first time this world ever generates it. */
  _chunkGenerated(c) {
    if (this._populated.has(c.id)) return;
    this._populated.add(c.id);
    this._populatedVersion++;
    const ls = this._generatedListeners;
    if (ls.length === 0) {
      if (this._generatedQueue.length < MAX_QUEUED_GENERATED * 2) this._generatedQueue.push(c.cx, c.cz);
      return;
    }
    for (let i = 0; i < ls.length; i++) this._callGenerated(ls[i], c.cx, c.cz);
  }

  _callGenerated(fn, cx, cz) {
    try {
      fn(cx, cz);
    } catch (err) {
      this._logOnce('generatedListener', '[world] onChunkGenerated listener failed:', err);
    }
  }

  /** A chunk came back from storage / the unload buffer: re-schedule its unsettled liquids. */
  _scanLiquids(c) {
    if (c.state !== READY || c.blocks === null) return;
    try {
      this.fluids.scanChunk(c.cx, c.cz, c.blocks, c.maxY);
    } catch (err) {
      this._logOnce('scan', '[world] scanning liquids failed:', err);
    }
  }

  /** Blocks became available: heightmap, READY, neighbour bookkeeping. */
  _applyBlocks(c, blocks, modified) {
    c.setBlocks(blocks);
    c.state = READY;
    c.dirtyMask = 0xffff;
    if (modified) {
      c.modified = true;
      c.editCount++;
    }
    let n = 0;
    for (let i = 0; i < 16; i += 2) {
      const o = this._chunks.get(chunkKeyNum(c.cx + NEIGHBOURS[i], c.cz + NEIGHBOURS[i + 1]));
      if (o !== undefined && o.state === READY) {
        n++;
        o.readyNeighbours++;
      }
    }
    c.readyNeighbours = n;
    this._meshScan = true;
  }

  // ===============================================================================================
  // Meshing
  // ===============================================================================================

  _meshable(c) {
    return c.state === READY && (c.flags & SET_MESH) !== 0 && c.readyNeighbours === 8;
  }

  _markDirty(x, y, z) {
    const r = editDirtyRange(x, y, z, this._range);
    for (let cz = r.cz0; cz <= r.cz1; cz++) {
      for (let cx = r.cx0; cx <= r.cx1; cx++) {
        const c = this._chunks.get(chunkKeyNum(cx, cz));
        if (c === undefined || c.state !== READY || !c.meshSubmitted) continue;
        c.dirtyMask |= r.mask;
        if (cx >= r.gx0 && cx <= r.gx1 && cz >= r.gz0 && cz <= r.gz1) this._urgent.add(c);
      }
    }
    this._meshScan = true;
  }

  _scheduleMeshes() {
    if (this._urgent.size > 0) {
      let group = null;
      for (const c of this._urgent) {
        if (c.dirtyMask === 0 || !this._meshable(c)) continue;   // handled by the normal scan later
        if (group === null) group = { pending: 0, results: [] };
        this._submitMesh(c, 0, group);
      }
      this._urgent.clear();
    }
    if (!this._meshScan) return;
    const free = this.maxMeshJobs - this._meshOutstanding;
    if (free <= 0) return;                                        // rescanned when a job completes
    this._meshScan = false;
    const cand = this._candidates;
    for (const c of this._chunks.values()) {
      if (c.dirtyMask !== 0 && c.meshAttempts < MAX_ATTEMPTS && this._meshable(c)) cand.push(c);
    }
    if (cand.length > free) cand.sort(this._byMeshPriority);
    const n = Math.min(free, cand.length);
    for (let i = 0; i < n; i++) this._submitMesh(cand[i], cand[i].meshedOnce ? 1 : 2, null);
    cand.length = 0;
  }

  _takeBuffer() {
    return this._buffers.length > 0 ? this._buffers.pop() : new ArrayBuffer(CHUNK_VOLUME);
  }

  _returnBuffers(list) {
    if (!list) return;
    const max = 9 * Math.min(this.maxMeshJobs, 12);    // keep at most ~7 MB of spare input buffers
    for (const b of list) {
      if (b instanceof ArrayBuffer && b.byteLength === CHUNK_VOLUME && this._buffers.length < max) this._buffers.push(b);
    }
  }

  _submitMesh(c, tier, group) {
    // Copy the 3x3 neighbourhood (only up to each chunk's highest block; the worker fills the rest with air).
    const chunks = new Array(9);
    for (let i = 0; i < 9; i++) {
      const n = i === 4 ? c : this._chunks.get(chunkKeyNum(c.cx + (i % 3) - 1, c.cz + ((i / 3) | 0) - 1));
      if (n === undefined || n.state !== READY) {
        // Bookkeeping drift should be impossible; recount instead of meshing with holes.
        this._recountNeighbours(c);
        return;
      }
      chunks[i] = n;
    }
    const transfer = new Array(9);
    for (let i = 0; i < 9; i++) {
      const n = chunks[i];
      const len = (n.maxY + 1) << 8;
      const buf = this._takeBuffer();
      const view = new Uint8Array(buf, 0, len);
      if (len > 0) view.set(len === CHUNK_VOLUME ? n.blocks : n.blocks.subarray(0, len));
      chunks[i] = view;
      transfer[i] = buf;
    }
    const mask = c.dirtyMask;
    c.dirtyMask = 0;
    c.meshSubmitted = true;
    c.meshJobs++;
    if (tier !== 0) this._meshOutstanding++;
    if (group !== null) group.pending++;
    const seq = this._editSeq;
    const epoch = this._meshEpoch;
    const job = {
      type: 'mesh', cx: c.cx, cz: c.cz, chunks, sectionMask: mask, smoothLighting: this.smoothLighting,
      returnBuffers: true, trimLight: true, owner: this._owner, uid: c.uid, tier,
    };
    this.pool.submit(job, TIER_BASE[tier] + c.dist, transfer).then(
      (res) => this._onMeshed(c, res, seq, epoch, tier, group),
      (err) => this._onMeshFailed(c, job, err, mask, tier, group));
  }

  _recountNeighbours(c) {
    let n = 0;
    for (let i = 0; i < 16; i += 2) {
      const o = this._chunks.get(chunkKeyNum(c.cx + NEIGHBOURS[i], c.cz + NEIGHBOURS[i + 1]));
      if (o !== undefined && o.state === READY) n++;
    }
    c.readyNeighbours = n;
  }

  _finishMeshJob(c, tier) {
    c.meshJobs--;
    if (tier !== 0) this._meshOutstanding--;
    this._meshScan = true;
  }

  _onMeshed(c, res, seq, epoch, tier, group) {
    this._returnBuffers(res.buffers);
    this._finishMeshJob(c, tier);
    this.counters.meshJobs++;
    this.counters.meshMs += res.ms || 0;
    if (this._closing) return;
    const alive = this._chunks.get(c.key) === c && epoch === this._meshEpoch;
    if (alive) c.meshAttempts = 0;
    if (group !== null) {
      if (alive) group.results.push({ c, res, seq, epoch });
      if (--group.pending === 0) this._releaseGroup(group);
      return;
    }
    if (alive) this._applyMeshResult(c, res, seq, false);
  }

  _onMeshFailed(c, job, err, mask, tier, group) {
    if (err && err.cancelled) {
      // Never dispatched: the copies are intact.
      const bufs = [];
      for (const v of job.chunks) if (v && v.buffer) bufs.push(v.buffer);
      this._returnBuffers(bufs);
    }
    this._finishMeshJob(c, tier);
    if (group !== null && --group.pending === 0) this._releaseGroup(group);
    if (this._closing || this._chunks.get(c.key) !== c) return;
    c.dirtyMask |= mask;                     // the request is never lost
    if (err && err.cancelled) return;
    c.meshAttempts++;
    this._logOnce('mesh', `[world] meshing chunk ${c.id} failed:`, err);
    if (c.meshAttempts >= MAX_ATTEMPTS) {
      // Give up until the next edit so a persistent failure cannot freeze the player forever.
      console.error(`[world] giving up meshing chunk ${c.id} after ${MAX_ATTEMPTS} attempts`);
      c.dirtyMask = 0;
      c.meshedOnce = true;
    }
  }

  /** Every job of an edit group finished: queue all its results together (uploaded in one frame). */
  _releaseGroup(group) {
    for (const r of group.results) {
      if (this._chunks.get(r.c.key) === r.c && r.epoch === this._meshEpoch) this._applyMeshResult(r.c, r.res, r.seq, true);
    }
    group.results.length = 0;
  }

  /** Store light and queue the sections for upload (unless a newer result for a section exists). */
  _applyMeshResult(c, res, seq, urgent) {
    const light = res.light;
    if (light instanceof Uint8Array && light.length <= CHUNK_VOLUME && (light.length & 255) === 0 && seq >= c.lightSeq) {
      c.light = light;
      c.lightSeq = seq;
    }
    const sections = res.sections;
    if (!Array.isArray(sections)) return;
    let added = false;
    for (let i = 0; i < sections.length; i++) {
      const s = sections[i];
      const sy = s.sy;
      if (!(sy >= 0 && sy < 16) || seq < c.sectionSeq[sy]) continue;
      c.sectionSeq[sy] = seq;
      c.pending[sy] = s;
      c.pendingMask |= 1 << sy;
      added = true;
    }
    if (!added) return;
    if (urgent) c.uploadUrgent = true;
    if (!c.inUploadList) {
      c.inUploadList = true;
      this._uploadList.push(c);
    }
  }

  /** Upload pending sections: urgent chunks first (no budget), then nearest first within the budget. */
  _uploadMeshes() {
    const list = this._uploadList;
    if (list.length > 1) list.sort(this._byUploadPriority);
    const t0 = now();
    let i = 0;
    for (; i < list.length; i++) {
      const c = list[i];
      if (c.state === READY && c.pendingMask !== 0) {
        if (!c.uploadUrgent && i > 0 && now() - t0 >= this.uploadBudgetMs) break;
        this._uploadChunk(c);
      }
      c.inUploadList = false;
      c.uploadUrgent = false;
    }
    if (i >= list.length) list.length = 0;
    else if (i > 0) {
      list.copyWithin(0, i);
      list.length -= i;
    }
  }

  _uploadChunk(c) {
    const r = this.renderer;
    const m = c.pendingMask;
    c.pendingMask = 0;
    for (let sy = 0; sy < 16; sy++) {
      const bit = 1 << sy;
      if ((m & bit) === 0) continue;
      const s = c.pending[sy];
      c.pending[sy] = null;
      if (s === null) continue;
      const h = typeof s.hash === 'number' ? s.hash : NaN;
      if ((c.hashKnown & bit) !== 0 && c.sectionHash[sy] === h) {
        this.counters.uploadsSkipped++;
      } else {
        if (r !== null) {
          try {
            r.setSectionMesh(c.cx, sy, c.cz, s.opaque, s.cutout, s.translucent);
          } catch (err) {
            this._logOnce('upload', '[world] renderer.setSectionMesh failed:', err);
          }
        }
        if (h === h) {
          c.sectionHash[sy] = h;
          c.hashKnown |= bit;
        } else {
          c.hashKnown &= ~bit;
        }
        this.counters.uploads++;
        this.counters.uploadBytes += (s.opaque ? s.opaque.byteLength : 0) + (s.cutout ? s.cutout.byteLength : 0) +
          (s.translucent ? s.translucent.byteLength : 0);
      }
      c.uploadedMask |= bit;
    }
    if (!c.meshedOnce && c.uploadedMask === 0xffff) c.meshedOnce = true;
  }

  // ===============================================================================================
  // Persistence
  // ===============================================================================================

  async _saveAll() {
    await this._flushUnloadSaves(true);
    const list = [];
    for (const c of this._chunks.values()) if (c.state === READY && c.modified) list.push(c);
    for (let i = 0; i < list.length; i += SAVE_BATCH) {
      const batch = list.slice(i, i + SAVE_BATCH).filter((c) => c.state === READY && c.modified);
      if (batch.length === 0) continue;
      const counts = batch.map((c) => c.editCount);
      await this.storage.saveChunks(this.worldId, batch.map((c) => ({ cx: c.cx, cz: c.cz, blocks: c.blocks })));
      for (let k = 0; k < batch.length; k++) {
        const c = batch[k];
        if (c.editCount === counts[k]) c.modified = false;
        if (this._savedKeys !== null) this._savedKeys.add(c.id);
      }
    }
    // Chunks unloaded while we were saving went to _unloadSaves.
    await this._flushUnloadSaves(true);
    await this._saveWorldData();
  }

  /**
   * Save everything in ONE storage transaction, started synchronously: every modified loaded chunk, the
   * chunks waiting in the unload buffer, the world's data records and — if given — the world meta, all or
   * nothing (review WORLD-1 / CODE-2). Because the IndexedDB transaction is created (and committed) during
   * this call, it is the right save for `pagehide` / `visibilitychange: hidden` handlers, which cannot
   * wait for anything; it also makes autosave and quit atomic (no newer meta next to older chunks). Safe
   * to call while a save() is running (later transactions win; IndexedDB orders them by creation).
   * @param {object|null} [meta] world meta to write in the same transaction (needs a string id)
   * @returns {Promise<{chunks: number}>} resolves once committed; rejects (data kept in memory) on failure
   */
  saveSnapshot(meta = null) {
    if (this._destroyed) return Promise.resolve({ chunks: 0 });
    const chunks = [];
    const counts = [];
    for (const c of this._chunks.values()) {
      if (c.state !== READY || !c.modified) continue;
      chunks.push(c);
      counts.push(c.editCount);
    }
    const unload = [...this._unloadSaves.values()];
    const records = [];
    for (const c of chunks) records.push({ cx: c.cx, cz: c.cz, blocks: c.blocks });
    for (const e of unload) records.push({ cx: e.cx, cz: e.cz, blocks: e.blocks });
    const data = this._worldDataRecords();
    let p;
    try {
      p = this.storage.saveSnapshot(this.worldId, meta, records, data.records);
    } catch (err) {
      p = Promise.reject(err);
    }
    return p.then(() => {
      for (let k = 0; k < chunks.length; k++) {
        const c = chunks[k];
        if (c.editCount === counts[k]) c.modified = false;
        if (this._savedKeys !== null) this._savedKeys.add(c.id);
      }
      for (const e of unload) {
        if (this._unloadSaves.get(e.id) === e) this._unloadSaves.delete(e.id);
        if (this._savedKeys !== null) this._savedKeys.add(e.id);
      }
      data.commit();
      return { chunks: records.length };
    });
  }

  /**
   * The per-world data records that changed since they were last written, and a commit() that marks
   * them clean (if nothing changed meanwhile).
   */
  _worldDataRecords() {
    const records = [];
    const pv = this._populatedVersion, dv = this._decayVersion, lv = this._placedVersion;
    if (this._populatedSaved !== pv) {
      const rec = new Int32Array(this._populated.size * 2);
      let i = 0;
      for (const id of this._populated) {
        const comma = id.indexOf(',');
        rec[i++] = Number(id.slice(0, comma));
        rec[i++] = Number(id.slice(comma + 1));
      }
      records.push({ name: POPULATED_RECORD, value: rec });
    }
    if (this._decaySaved !== dv) {
      this._pruneDecayCandidates();
      records.push({ name: DECAY_RECORD, value: tripleArray(this._decayCandidates) });
    }
    if (this._placedSaved !== lv) records.push({ name: PLACED_LEAVES_RECORD, value: tripleArray(this._placedLeaves) });
    return {
      records,
      commit: () => {
        this._populatedSaved = pv;
        this._decaySaved = dv;
        this._placedSaved = lv;
      },
    };
  }

  /** Write the changed per-world data records (generated chunks, leaf-decay candidates). */
  async _saveWorldData() {
    if (typeof this.storage.saveWorldData !== 'function') return;
    const data = this._worldDataRecords();
    for (const r of data.records) await this.storage.saveWorldData(this.worldId, r.name, r.value);
    data.commit();
  }

  /** Drop decay candidates that are no longer leaves (in loaded chunks) and cap the set. */
  _pruneDecayCandidates() {
    const set = this._decayCandidates;
    if (set.size === 0) this._decayChunks.clear();
    for (const key of set) {
      const a = key.indexOf(','), b = key.indexOf(',', a + 1);
      const x = Number(key.slice(0, a)), y = Number(key.slice(a + 1, b)), z = Number(key.slice(b + 1));
      const c = this._chunkAt(x >> 4, z >> 4);
      if (c !== null && IS_LEAVES[this.getBlock(x, y, z)] === 0) set.delete(key);
    }
    if (set.size > MAX_DECAY_CANDIDATES) {
      let drop = set.size - MAX_DECAY_CANDIDATES;
      for (const key of set) {
        if (drop-- <= 0) break;
        set.delete(key);
      }
    }
  }

  /**
   * Write the data of unloaded modified chunks. With wait = true the promise settles once everything
   * queued (including entries added meanwhile) is written, rejecting on errors. In the background
   * (wait = false, called by update()) at most UNLOAD_BATCH chunks are compressed and written per call,
   * so unloading many modified chunks (teleport, smaller render distance) never stalls a frame (review
   * WORLD-4); the next frame continues. Failures are retried after 5 s.
   */
  _flushUnloadSaves(wait) {
    if (this._unloadWrite !== null) {
      return wait ? this._unloadWrite.then(() => this._flushUnloadSaves(true), () => this._flushUnloadSaves(true))
        : this._unloadWrite;
    }
    if (this._unloadSaves.size === 0) return Promise.resolve();
    if (!wait && now() < this._unloadRetryAt) return Promise.resolve();
    const entries = [];
    for (const e of this._unloadSaves.values()) {
      entries.push(e);
      if (entries.length >= UNLOAD_BATCH) break;
    }
    const write = this.storage.saveChunks(this.worldId, entries).then(() => {
      for (const e of entries) {
        if (this._unloadSaves.get(e.id) === e) this._unloadSaves.delete(e.id);
        if (this._savedKeys !== null) this._savedKeys.add(e.id);
      }
    }, (err) => {
      this._unloadRetryAt = now() + 5000;
      if (!this._unloadWarned) {
        this._unloadWarned = true;
        console.warn('[world] saving unloaded chunks failed (kept in memory, will retry):', err);
      }
      throw err;
    });
    this._unloadWrite = write;
    const done = write.finally(() => { this._unloadWrite = null; });
    if (!wait) {
      done.catch(() => {});
      return done;
    }
    return done.then(() => (this._unloadSaves.size > 0 ? this._flushUnloadSaves(true) : undefined));
  }

  // ===============================================================================================
  // Random ticks
  // ===============================================================================================

  /** max(sky - darkening, block) at a cell; -1 if the light is unknown (chunk not meshed yet). */
  _effectiveLight(x, y, z) {
    if (y > 255) return 15 - this._skyDarken;
    if (y < 0) return 0;
    const c = this._chunkAt(x >> 4, z >> 4);
    if (c === null || c.light === null) return -1;
    const i = (y << 8) | ((z & 15) << 4) | (x & 15);
    const p = i < c.light.length ? c.light[i] : 0xf0;
    const s = (p >> 4) - this._skyDarken;
    const b = p & 15;
    return s > b ? s : b;
  }

  _randomTick(kind, id, x, y, z, rng) {
    switch (kind) {
      case T_GRASS: this._tickGrass(id, x, y, z, rng); break;
      case T_SAPLING: this._tickSapling(id, x, y, z, rng); break;
      case T_STACK: this._tickStackPlant(id, x, y, z, rng); break;
      case T_ICE: this._tickIce(x, y, z); break;
      case T_CROP: this._tickCrop(id, x, y, z, rng); break;
      case T_FARMLAND: this._tickFarmland(id, x, y, z, rng); break;
      case T_PLANT: this._checkStay(id, x, y, z); break;
      case T_LEAVES: this._tickLeaves(x, y, z); break;
      default: break;
    }
  }

  /**
   * Leaf decay (review WORLD-3). Without block states, leaves that may have lost their tree are kept as
   * decay *candidates*: every leaf within 4 blocks of a removed log (Minecraft 1.12 marks the same box),
   * and the neighbours of a decayed leaf. A candidate hit by a random tick decays when no log is reachable
   * within 6 steps through leaves (Minecraft 1.14+ distance 7), dropping its loot (saplings 5 %, apples
   * 0.5 %) without break effects, like Minecraft. Leaves placed by the player (or commands) are
   * remembered as persistent and never decay (Minecraft's persistent=true); naturally grown and generated
   * leaves do (every generated leaf is within 6 steps of its log).
   */
  _tickLeaves(x, y, z) {
    if (this._decayCandidates.size === 0 || !this._decayChunks.has(chunkKeyNum(x >> 4, z >> 4))) return;
    const key = x + ',' + y + ',' + z;
    if (!this._decayCandidates.has(key)) return;
    if (this._placedLeaves.has(key)) {
      this._decayCandidates.delete(key);
      this._decayVersion++;
      return;
    }
    if (!this._areaLoaded(x, z, LEAF_RANGE)) return;          // decide once the whole tree is loaded
    this._decayCandidates.delete(key);
    this._decayVersion++;
    if (this._leafConnected(x, y, z)) return;
    if (this.updater.pop(x, y, z, { effects: false })) this._markLeaves(x, y, z, 1);
  }

  /** Mark the leaves within Chebyshev radius r of (x, y, z) as decay candidates. */
  _markLeaves(x, y, z, r) {
    const y0 = Math.max(0, y - r), y1 = Math.min(255, y + r);
    for (let yy = y0; yy <= y1; yy++) {
      for (let zz = z - r; zz <= z + r; zz++) {
        for (let xx = x - r; xx <= x + r; xx++) {
          if (IS_LEAVES[this.getBlock(xx, yy, zz)] === 1) {
            this._decayCandidates.add(xx + ',' + yy + ',' + zz);
            this._decayChunks.add(chunkKeyNum(xx >> 4, zz >> 4));
            this._decayVersion++;
          }
        }
      }
    }
  }

  /** True if a log is reachable from the leaf at (x, y, z) within LEAF_RANGE steps through leaves. */
  _leafConnected(x, y, z) {
    const B = LEAF_BOX, R = LEAF_RANGE, BB = B * B;
    if (++this._bfsCounter === 0xffffffff) {
      this._bfsStamp.fill(0);
      this._bfsCounter = 1;
    }
    const stamp = this._bfsCounter;
    const S = this._bfsStamp, Q = this._bfsQueue, D = this._bfsDist;
    const start = (R * B + R) * B + R;
    S[start] = stamp;
    D[start] = 0;
    Q[0] = start;
    let head = 0, tail = 1;
    while (head < tail) {
      const c = Q[head++];
      const d = D[c];
      const ox = (c % B) - R, oz = (((c / B) | 0) % B) - R, oy = ((c / BB) | 0) - R;
      for (let k = 0; k < 6; k++) {
        const nx = ox + (k === 0 ? 1 : k === 1 ? -1 : 0);
        const ny = oy + (k === 2 ? 1 : k === 3 ? -1 : 0);
        const nz = oz + (k === 4 ? 1 : k === 5 ? -1 : 0);
        const wy = y + ny;
        if (wy < 0 || wy > 255) continue;
        const n = ((ny + R) * B + (nz + R)) * B + (nx + R);
        if (S[n] === stamp) continue;
        S[n] = stamp;
        const id = this.getBlock(x + nx, wy, z + nz);
        if (IS_LOG[id] === 1) return true;                    // reached in d + 1 <= LEAF_RANGE steps
        if (IS_LEAVES[id] === 1 && d + 1 < R) {
          D[n] = d + 1;
          Q[tail++] = n;
        }
      }
    }
    return false;
  }

  /** Pop a plant that can no longer stay (drops its loot). @returns {boolean} true if it popped */
  _checkStay(id, x, y, z) {
    if (canStay(id, this._getBlock, x, y, z)) return false;
    this.updater.pop(x, y, z);
    return true;
  }

  /**
   * Wheat (Minecraft BlockCrops): pops without farmland; with light >= 9 above, grows one stage with
   * probability 1 / (floor(25 / f) + 1), f = Minecraft getGrowthChance (moist farmland around helps,
   * rows of the same crop in both directions halve it).
   */
  _tickCrop(id, x, y, z, rng) {
    if (this._checkStay(id, x, y, z)) return;
    if (id >= WHEAT_7) return;
    if (this._effectiveLight(x, y + 1, z) < 9) return;
    const f = this._growthChance(x, y, z);
    if (Math.floor(rng() * (Math.floor(25 / f) + 1)) !== 0) return;
    this.setBlock(x, y, z, id + 1);
  }

  /** Minecraft BlockCrops.getGrowthChance for a crop at (x, y, z). */
  _growthChance(x, y, z) {
    let f = 1;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const b = this.getBlock(x + dx, y - 1, z + dz);
        let g = 0;
        if (b === FARMLAND) g = 1;
        else if (b === FARMLAND_MOIST) g = 3;
        if (dx !== 0 || dz !== 0) g /= 4;
        f += g;
      }
    }
    const rowX = isWheat(this.getBlock(x - 1, y, z)) || isWheat(this.getBlock(x + 1, y, z));
    const rowZ = isWheat(this.getBlock(x, y, z - 1)) || isWheat(this.getBlock(x, y, z + 1));
    if (rowX && rowZ) {
      f /= 2;
    } else if (isWheat(this.getBlock(x - 1, y, z - 1)) || isWheat(this.getBlock(x + 1, y, z - 1)) ||
      isWheat(this.getBlock(x + 1, y, z + 1)) || isWheat(this.getBlock(x - 1, y, z + 1))) {
      f /= 2;
    }
    return f;
  }

  /**
   * Farmland (Minecraft BlockFarmland): moist while water is within 4 blocks horizontally (same level or
   * one above); without water a moist field dries out (Minecraft counts moisture 7 -> 0 over 7 random
   * ticks: here a 1/7 chance per tick) and dry farmland without a crop turns back into dirt.
   */
  _tickFarmland(id, x, y, z, rng) {
    if (this._waterNear(x, y, z)) {
      if (id !== FARMLAND_MOIST) this.setBlock(x, y, z, FARMLAND_MOIST);
      return;
    }
    if (id === FARMLAND_MOIST) {
      if (rng() < 1 / 7) this.setBlock(x, y, z, FARMLAND);
      return;
    }
    if (!isWheat(y < 255 ? this.getBlock(x, y + 1, z) : AIR)) this.setBlock(x, y, z, DIRT);
  }

  /** Water (any level) in x±4, z±4, y..y+1 (Minecraft BlockFarmland.hasWater). */
  _waterNear(x, y, z) {
    for (let dy = 0; dy <= 1; dy++) {
      const yy = y + dy;
      if (yy > 255) break;
      for (let dz = -4; dz <= 4; dz++) {
        for (let dx = -4; dx <= 4; dx++) if (isWater(this.getBlock(x + dx, yy, z + dz))) return true;
      }
    }
    return false;
  }

  /**
   * Grass (Minecraft SpreadingSnowyDirtBlock): turns into dirt under an opaque block or liquid; with
   * light >= 9 above it tries 4 times to spread to dirt in x±1, y-3..+1, z±1 that has a free,
   * lit (>= 4) cell above. Snowy grass spreads as snowy grass.
   */
  _tickGrass(id, x, y, z, rng) {
    const above = y < 255 ? this.getBlock(x, y + 1, z) : AIR;
    if (IS_OPAQUE[above] === 1 || IS_LIQUID[above] === 1) {
      this.setBlock(x, y, z, DIRT);
      return;
    }
    if (this._effectiveLight(x, y + 1, z) < 9) return;
    for (let i = 0; i < 4; i++) {
      const tx = x + ((rng() * 3) | 0) - 1;
      const ty = y + ((rng() * 5) | 0) - 3;
      const tz = z + ((rng() * 3) | 0) - 1;
      if (ty < 0 || ty > 254 || this.getBlock(tx, ty, tz) !== DIRT) continue;
      const a = this.getBlock(tx, ty + 1, tz);
      if (IS_OPAQUE[a] === 1 || IS_LIQUID[a] === 1) continue;
      if (this._effectiveLight(tx, ty + 1, tz) < 4) continue;
      this.setBlock(tx, ty, tz, id);
    }
  }

  /**
   * Saplings (Minecraft SaplingBlock): with light >= 9 a 1/7 chance per random tick to advance a
   * two-stage growth; without block states this is a 1/14 chance to grow (same mean time).
   */
  _tickSapling(id, x, y, z, rng) {
    if (this._checkStay(id, x, y, z)) return;
    if (this._effectiveLight(x, y + 1, z) < 9) return;
    if (rng() >= 1 / 14) return;
    if (!this._areaLoaded(x, z, 8)) return;
    this._naturalPlacement = true;
    try {
      this.generator.growTree(this._treeAccess, x, y, z, id, rng);
    } catch (err) {
      this._logOnce('tree', '[world] growTree failed:', err);
    } finally {
      this._naturalPlacement = false;
    }
  }

  /**
   * Sugar cane / cactus: pop when they can no longer stay (sugar cane whose water is gone: water next to
   * the ground block is not a neighbour of the cane, so only random ticks notice — like Minecraft), else
   * grow one block (1/16 chance, Minecraft's age 0..15) up to 3 tall.
   */
  _tickStackPlant(id, x, y, z, rng) {
    if (this._checkStay(id, x, y, z)) return;
    if (y >= 255 || this.getBlock(x, y + 1, z) !== AIR) return;
    let h = 1;
    while (h < 3 && y - h >= 0 && this.getBlock(x, y - h, z) === id) h++;
    if (h >= 3) return;
    if (rng() >= 1 / 16) return;
    this.setBlock(x, y + 1, z, id);
  }

  /** Ice melts into water when the block light at it exceeds 11 - 1 (Minecraft IceBlock). */
  _tickIce(x, y, z) {
    if (this._effectiveLight(x, y, z) < 0) return;
    if ((this.getLight(x, y, z) & 15) > 10) this.setBlock(x, y, z, WATER);
  }

  /** True if every chunk overlapping [x-r, x+r] x [z-r, z+r] is loaded. */
  _areaLoaded(x, z, r) {
    for (let cz = (z - r) >> 4; cz <= (z + r) >> 4; cz++) {
      for (let cx = (x - r) >> 4; cx <= (x + r) >> 4; cx++) {
        const c = this._chunks.get(chunkKeyNum(cx, cz));
        if (c === undefined || c.state !== READY) return false;
      }
    }
    return true;
  }

  // ===============================================================================================
  // Misc
  // ===============================================================================================

  _effect(name, x, y, z) {
    if (typeof this.onEffect !== 'function') return;
    try {
      this.onEffect(name, x, y, z);
    } catch (err) {
      this._logOnce('effect', '[world] onEffect failed:', err);
    }
  }

  _emitChange(x, y, z, oldId, newId) {
    const ls = this._listeners;
    for (let i = 0; i < ls.length; i++) {
      try {
        ls[i](x, y, z, oldId, newId);
      } catch (err) {
        this._logOnce('listener', '[world] onBlockChanged listener failed:', err);
      }
    }
  }

  _logOnce(kind, text, err) {
    const key = kind + ':' + (err && err.message ? err.message : String(err));
    if (this._loggedErrors.has(key)) return;
    this._loggedErrors.add(key);
    console.error(text, err);
  }
}
