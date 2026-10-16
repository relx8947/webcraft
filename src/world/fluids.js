// Minecraft fluid dynamics for water and lava (docs/SPEC-wave2.md §5.1). Pure logic (no DOM): works with
// any world object providing
//   getBlock(x, y, z) -> id      setBlock(x, y, z, id) -> bool   (setBlock must run block updates, i.e.
//                                  notify the neighbours of the changed cell — see blockupdates.js)
// so it is unit-tested under Node with a plain voxel map (tests/fluids.test.js).
//
// Levels (registry LIQUID_LEVEL): 0 = source, 1..7 = flowing (distance from the feeding source in steps of
// 1 for water / 2 for lava), 8 = falling (a cell fed from above; rendered full height).
//
// Rules — a port of Minecraft 1.12 BlockDynamicLiquid.updateTick / BlockLiquid.checkForMixing with the
// 1.13+ lava/water interaction:
//  * Scheduled ticks: a liquid cell is (re)scheduled when it is placed or any of its 6 neighbours changes
//    (BlockUpdater calls neighborChanged), `delay` = 5 ticks for water, 30 for lava. A cell that already has
//    a pending tick keeps it (Minecraft de-duplicates scheduled ticks per position).
//  * A non-source cell takes the minimum level of its horizontal same-liquid neighbours (falling counts as 0)
//    plus the step (water 1, lava 2); >= 8 or no neighbour = dry -> air. Same liquid above -> falling (8).
//    Water with >= 2 horizontal source neighbours over a solid block or a water source becomes a source
//    (infinite water). Receding lava waits 4x longer with probability 3/4 (Minecraft).
//  * Spreading: if the cell below accepts liquid, flow down (as falling); otherwise sources, and flowing /
//    falling cells standing on a block that stops liquids, spread sideways with level + step (falling -> 1)
//    toward the nearest drop found within 4 blocks (lava 2) — all directions when there is none.
//  * Liquids flow into air and into non-solid blocks (plants, torches, crops) which are washed away
//    with their drops (lava burns them with a fizz instead); solid blocks and sugar cane stop them.
//  * Lava with water above or beside it solidifies: source -> obsidian, flowing/falling -> cobblestone;
//    lava flowing down into water turns that water into stone. Each plays the 'fizz' effect.
//  * Water never flows into lava and lava never flows sideways into water (1.13+).
// Scheduled ticks live in a ring of 256 tick buckets (+ a carry list for overdue entries) and a per-chunk
// Map(local index -> due tick) for de-duplication; dropChunk() forgets the ticks of an unloaded chunk (they
// are found again by scanChunk() when it is loaded from storage). tick() processes due updates under a count
// and a time budget; whatever is left runs first in the next tick. Updates whose neighbourhood is not
// loaded (isAreaLoaded hook) are deferred by 20 ticks.

import {
  BLOCK, BLOCKS, IS_SOLID, RENDER_TYPE, RENDER, LIQUID_KIND, LIQUID_LEVEL, liquidBlock, getDrops,
} from './registry.js';
import { chunkKeyNum } from './chunk.js';

/** Liquid kinds (registry LIQUID_KIND). */
export const KIND_WATER = 1;
export const KIND_LAVA = 2;
/** Ticks between updates, level step per block and the drop search distance, by kind. */
export const TICK_DELAY = Object.freeze([0, 5, 30]);
export const LEVEL_STEP = Object.freeze([0, 1, 2]);
export const SLOPE_DISTANCE = Object.freeze([0, 4, 2]);

const FALLING = 8;
const DEFER_TICKS = 20;          // retry delay when the neighbourhood of a cell is not loaded
const BUCKETS = 256;             // tick ring size (delays are clamped to 1..255)
const NO_PATH = 1000;

const AIR = 0;
const STONE = BLOCK.STONE;
const COBBLESTONE = BLOCK.COBBLESTONE;
const OBSIDIAN = BLOCK.OBSIDIAN;
const BEDROCK = BLOCK.BEDROCK;   // stands in for "below the world" (a floor that stops liquids)

/** 1 = stops liquids (Minecraft Material.blocksMovement, plus sugar cane like Minecraft's REEDS exception). */
export const BLOCKS_FLUID = new Uint8Array(256);
/** 1 = full solid face: turns the flow of a falling liquid downward (Minecraft causesDownwardCurrent). */
const SOLID_FACE = new Uint8Array(256);
for (const b of BLOCKS) {
  BLOCKS_FLUID[b.id] = IS_SOLID[b.id] === 1 || b.id === BLOCK.SUGAR_CANE ? 1 : 0;
  SOLID_FACE[b.id] = IS_SOLID[b.id] === 1 && RENDER_TYPE[b.id] === RENDER.CUBE && b.id !== BLOCK.ICE ? 1 : 0;
}

// Horizontal directions in Minecraft's order: north, east, south, west.
const DX = Int8Array.of(0, 1, 0, -1);
const DZ = Int8Array.of(-1, 0, 1, 0);
const OPP = Uint8Array.of(2, 3, 0, 1);

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** True if a liquid can flow into a cell holding `id` (air or a washable non-solid block). */
export function canFlowInto(id) {
  return LIQUID_KIND[id] === 0 && BLOCKS_FLUID[id] === 0;
}

/** Minecraft's rendered depth: 0 for sources and falling liquid, 1..7 for flowing, -1 for other blocks. */
function renderedDepth(id, kind) {
  if (LIQUID_KIND[id] !== kind) return -1;
  const l = LIQUID_LEVEL[id];
  return l >= FALLING ? 0 : l;
}

/**
 * Minecraft's flow direction of the liquid at (x, y, z) (BlockLiquid.getFlow): a normalized vector pointing
 * where the liquid flows — toward neighbours with a lower surface and strongly toward drops; falling liquid
 * next to a solid face also pushes down. Zero vector for non-liquid cells and still water.
 * @param {{getBlock(x:number,y:number,z:number):number}} world
 * @param {number} x @param {number} y @param {number} z block coordinates (fractions are floored)
 * @param {number[]|Float32Array|Float64Array} [out]
 * @returns {number[]|Float32Array|Float64Array} out = [vx, vy, vz]
 */
export function flowVector(world, x, y, z, out = [0, 0, 0]) {
  out[0] = 0; out[1] = 0; out[2] = 0;
  x = Math.floor(x); y = Math.floor(y); z = Math.floor(z);
  if (y < 0 || y > 255) return out;
  const id = world.getBlock(x, y, z);
  const kind = LIQUID_KIND[id];
  if (kind === 0) return out;
  const own = renderedDepth(id, kind);
  let vx = 0, vz = 0;
  for (let d = 0; d < 4; d++) {
    const nx = x + DX[d], nz = z + DZ[d];
    const n = world.getBlock(nx, y, nz);
    const j = renderedDepth(n, kind);
    if (j >= 0) {
      const l = j - own;
      vx += DX[d] * l;
      vz += DZ[d] * l;
    } else if (IS_SOLID[n] === 0 && y > 0) {
      // A drop next to us: flow strongly toward the liquid below the neighbour.
      const jb = renderedDepth(world.getBlock(nx, y - 1, nz), kind);
      if (jb >= 0) {
        const k = jb - (own - 8);
        vx += DX[d] * k;
        vz += DZ[d] * k;
      }
    }
  }
  let vy = 0;
  if (LIQUID_LEVEL[id] >= FALLING) {
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d], nz = z + DZ[d];
      const n = world.getBlock(nx, y, nz);
      const up = y < 255 ? world.getBlock(nx, y + 1, nz) : AIR;
      if ((LIQUID_KIND[n] !== kind && SOLID_FACE[n] === 1) || (LIQUID_KIND[up] !== kind && SOLID_FACE[up] === 1)) {
        const len = Math.hypot(vx, vz);
        if (len > 0) { vx /= len; vz /= len; }
        vy = -6;
        break;
      }
    }
  }
  const len = Math.hypot(vx, vy, vz);
  if (len > 1e-9) {
    out[0] = vx / len;
    out[1] = vy / len;
    out[2] = vz / len;
  }
  return out;
}

/** Growable list of scheduled ticks (x, y, z, due). */
class TickList {
  constructor(cap = 16) {
    this.x = new Int32Array(cap);
    this.y = new Int32Array(cap);
    this.z = new Int32Array(cap);
    this.due = new Int32Array(cap);
    this.n = 0;
  }

  push(x, y, z, due) {
    if (this.n === this.x.length) this._grow();
    const n = this.n++;
    this.x[n] = x; this.y[n] = y; this.z[n] = z; this.due[n] = due;
  }

  _grow() {
    const cap = this.x.length * 2;
    for (const k of ['x', 'y', 'z', 'due']) {
      const a = new Int32Array(cap);
      a.set(this[k]);
      this[k] = a;
    }
  }
}

/**
 * Scheduled liquid updates for one world (see the header for the rules).
 */
export class FluidSimulator {
  /**
   * @param {{ getBlock(x:number,y:number,z:number):number,
   *           setBlock(x:number,y:number,z:number,id:number):boolean }} world
   * @param {object} [options]
   * @param {(itemId:number, count:number, x:number, y:number, z:number) => void} [options.onDropItem]
   *   items of blocks washed away by water (block centre)
   * @param {(name:string, x:number, y:number, z:number) => void} [options.onEffect] 'fizz' at the block
   *   centre when lava meets water or burns a plant (sound + smoke)
   * @param {(x:number, z:number, r:number) => boolean} [options.isAreaLoaded] true if every chunk within
   *   r blocks of the column is loaded; updates elsewhere are deferred (default: always loaded)
   * @param {() => number} [options.rng]
   * @param {number} [options.maxUpdatesPerTick] count budget per tick (default 4096)
   * @param {number} [options.budgetMs] time budget per tick (default 2 ms)
   */
  constructor(world, {
    onDropItem = null, onEffect = null, isAreaLoaded = null, rng = Math.random,
    maxUpdatesPerTick = 4096, budgetMs = 2,
  } = {}) {
    this.world = world;
    this.onDropItem = onDropItem;
    this.onEffect = onEffect;
    this.isAreaLoaded = isAreaLoaded;
    this.rng = rng;
    this.maxUpdatesPerTick = maxUpdatesPerTick;
    this.budgetMs = budgetMs;
    /** Ticks processed so far (scheduled ticks are due at now + delay). */
    this.now = 0;
    this._maps = new Map();                    // chunk key -> Map(local index -> due tick)
    this._pending = 0;
    this._buckets = new Array(BUCKETS).fill(null);
    this._carry = new TickList();               // overdue entries, oldest first
    this._carryNext = new TickList();
    this.counters = { updates: 0, deferred: 0, scheduled: 0, overBudget: 0 };
  }

  /** Number of scheduled (pending) liquid updates. */
  get pending() {
    return this._pending;
  }

  /**
   * Schedule an update of the cell (no-op if one is already pending there, like Minecraft).
   * @returns {boolean} true if a new tick was scheduled
   */
  schedule(x, y, z, delay) {
    if (y < 0 || y > 255) return false;
    let d = delay | 0;
    if (d < 1) d = 1;
    else if (d > BUCKETS - 1) d = BUCKETS - 1;
    const key = chunkKeyNum(x >> 4, z >> 4);
    const idx = (y << 8) | ((z & 15) << 4) | (x & 15);
    let m = this._maps.get(key);
    if (m === undefined) {
      m = new Map();
      this._maps.set(key, m);
    } else if (m.has(idx)) {
      return false;
    }
    const due = this.now + d;
    m.set(idx, due);
    this._pending++;
    this.counters.scheduled++;
    const b = due & (BUCKETS - 1);
    let list = this._buckets[b];
    if (list === null) list = this._buckets[b] = new TickList();
    list.push(x, y, z, due);
    return true;
  }

  /** True if an update of the cell is pending. */
  isScheduled(x, y, z) {
    const m = this._maps.get(chunkKeyNum(x >> 4, z >> 4));
    return m !== undefined && m.has((y << 8) | ((z & 15) << 4) | (x & 15));
  }

  /**
   * The cell (x, y, z) was placed or one of its neighbours changed (called by BlockUpdater for every
   * liquid cell next to a change, and for a changed cell that is now liquid). Lava next to water
   * solidifies immediately (Minecraft checkForMixing); everything else gets a scheduled update.
   */
  neighborChanged(x, y, z) {
    const id = this.world.getBlock(x, y, z);
    const kind = LIQUID_KIND[id];
    if (kind === 0) return;
    if (kind === KIND_LAVA && this._mixLava(x, y, z, id)) return;
    this.schedule(x, y, z, TICK_DELAY[kind]);
  }

  /**
   * Advance one game tick: run the updates that are due (overdue ones first) within the budget.
   * @returns {number} updates performed
   */
  tick() {
    this.now++;
    if (this._pending === 0) {
      // Only stale entries can be left: drop them cheaply.
      this._carry.n = 0;
      const list = this._buckets[this.now & (BUCKETS - 1)];
      if (list !== null) list.n = 0;
      return 0;
    }
    const t0 = now();
    let done = 0;
    let stopped = false;
    const next = this._carryNext;
    next.n = 0;
    const carry = this._carry;
    for (let k = 0; k < carry.n; k++) {
      if (!stopped && this._overBudget(done, t0)) stopped = true;
      if (stopped) next.push(carry.x[k], carry.y[k], carry.z[k], carry.due[k]);
      else if (this._run(carry.x[k], carry.y[k], carry.z[k], carry.due[k])) done++;
    }
    const list = this._buckets[this.now & (BUCKETS - 1)];
    if (list !== null) {
      for (let k = 0; k < list.n; k++) {
        if (!stopped && this._overBudget(done, t0)) stopped = true;
        if (stopped) next.push(list.x[k], list.y[k], list.z[k], list.due[k]);
        else if (this._run(list.x[k], list.y[k], list.z[k], list.due[k])) done++;
      }
      list.n = 0;
    }
    if (stopped) this.counters.overBudget++;
    carry.n = 0;
    this._carry = next;
    this._carryNext = carry;
    return done;
  }

  /** Forget the scheduled updates of a chunk (it was unloaded). */
  dropChunk(cx, cz) {
    const key = chunkKeyNum(cx, cz);
    const m = this._maps.get(key);
    if (m === undefined) return;
    this._pending -= m.size;
    this._maps.delete(key);
  }

  /** Drop every scheduled update. */
  clear() {
    this._maps.clear();
    this._pending = 0;
    for (const l of this._buckets) if (l !== null) l.n = 0;
    this._carry.n = 0;
    this._carryNext.n = 0;
  }

  /**
   * A chunk was loaded from storage: schedule its unsettled liquids (Minecraft keeps pending ticks in the
   * save; we find them again). Flowing / falling cells always get an update; sources only if a neighbour
   * below or beside them could take liquid (neighbours in chunks that are not loaded are skipped:
   * terrain there is static until disturbed), lava also when water touches it.
   * @param {number} cx @param {number} cz
   * @param {Uint8Array} blocks the chunk's blocks (index (y << 8) | (z << 4) | x)
   * @param {number} [maxY] highest non-air y of the chunk
   * @returns {number} cells scheduled
   */
  scanChunk(cx, cz, blocks, maxY = 255) {
    const x0 = cx << 4, z0 = cz << 4;
    const top = Math.min(255, maxY);
    let n = 0;
    for (let y = 0; y <= top; y++) {
      const row = y << 8;
      for (let i = 0; i < 256; i++) {
        const id = blocks[row | i];
        const kind = LIQUID_KIND[id];
        if (kind === 0) continue;
        const lx = i & 15, lz = i >> 4;
        if (LIQUID_LEVEL[id] !== 0 || this._sourceUnsettled(blocks, x0, z0, lx, y, lz, kind)) {
          if (this.schedule(x0 + lx, y, z0 + lz, TICK_DELAY[kind])) n++;
        }
      }
    }
    return n;
  }

  /**
   * flowVector for this world. Accepts both (x, y, z, out) and (world, x, y, z, out) so callers can use
   * `world.fluids.flowVector(x, y, z, out)` or the SPEC form `flowVector(world, x, y, z, out)`.
   */
  flowVector(a, b, c, d, e) {
    if (a !== null && typeof a === 'object' && typeof a.getBlock === 'function') return flowVector(a, b, c, d, e);
    return flowVector(this.world, a, b, c, d);
  }

  /** { pending, updates, deferred, scheduled, overBudget } */
  stats() {
    return { pending: this._pending, ...this.counters };
  }

  // ---------------------------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------------------------

  _overBudget(done, t0) {
    if (done >= this.maxUpdatesPerTick) return true;
    return (done & 15) === 15 && now() - t0 > this.budgetMs;
  }

  /** Run a scheduled entry unless it is stale. @returns {boolean} true if an update ran */
  _run(x, y, z, due) {
    const key = chunkKeyNum(x >> 4, z >> 4);
    const m = this._maps.get(key);
    if (m === undefined) return false;
    const idx = (y << 8) | ((z & 15) << 4) | (x & 15);
    if (m.get(idx) !== due) return false;
    m.delete(idx);
    this._pending--;
    if (m.size === 0) this._maps.delete(key);
    this._update(x, y, z);
    return true;
  }

  _sourceUnsettled(blocks, x0, z0, lx, y, lz, kind) {
    const w = this.world;
    if (y > 0 && canFlowInto(blocks[((y - 1) << 8) | (lz << 4) | lx])) return true;
    if (kind === KIND_LAVA && y < 255 && LIQUID_KIND[blocks[((y + 1) << 8) | (lz << 4) | lx]] === KIND_WATER) {
      return true;
    }
    for (let d = 0; d < 4; d++) {
      const nx = lx + DX[d], nz = lz + DZ[d];
      let n;
      if (nx >= 0 && nx < 16 && nz >= 0 && nz < 16) {
        n = blocks[(y << 8) | (nz << 4) | nx];
      } else {
        const wx = x0 + nx, wz = z0 + nz;
        if (this.isAreaLoaded !== null && !this.isAreaLoaded(wx, wz, 0)) continue;
        n = w.getBlock(wx, y, wz);
      }
      if (canFlowInto(n)) return true;
      if (kind === KIND_LAVA && LIQUID_KIND[n] === KIND_WATER) return true;
    }
    return false;
  }

  _effect(name, x, y, z) {
    if (typeof this.onEffect !== 'function') return;
    try {
      this.onEffect(name, x + 0.5, y + 0.5, z + 0.5);
    } catch (err) {
      console.error('[fluids] onEffect failed:', err);
    }
  }

  _dropBlock(id, x, y, z) {
    if (typeof this.onDropItem !== 'function') return;
    try {
      for (const d of getDrops(id, 0, this.rng)) this.onDropItem(d.id, d.count, x + 0.5, y + 0.5, z + 0.5);
    } catch (err) {
      console.error('[fluids] onDropItem failed:', err);
    }
  }

  /** Lava touching water (above or beside) solidifies. @returns {boolean} true if it did */
  _mixLava(x, y, z, id) {
    const w = this.world;
    let water = y < 255 && LIQUID_KIND[w.getBlock(x, y + 1, z)] === KIND_WATER;
    for (let d = 0; d < 4 && !water; d++) water = LIQUID_KIND[w.getBlock(x + DX[d], y, z + DZ[d])] === KIND_WATER;
    if (!water) return false;
    if (!w.setBlock(x, y, z, LIQUID_LEVEL[id] === 0 ? OBSIDIAN : COBBLESTONE)) return false;
    this._effect('fizz', x, y, z);
    return true;
  }

  /** Put liquid of `kind` at `level` into (x, y, z) if it can take it, washing plants away. */
  _flowInto(x, y, z, kind, level) {
    const w = this.world;
    const id = w.getBlock(x, y, z);
    if (!canFlowInto(id)) return false;
    if (!w.setBlock(x, y, z, liquidBlock(kind, level))) return false;
    if (id !== AIR) {
      if (kind === KIND_LAVA) this._effect('fizz', x, y, z);
      else this._dropBlock(id, x, y, z);
    }
    return true;
  }

  /** One scheduled update of the cell (Minecraft BlockDynamicLiquid.updateTick). */
  _update(x, y, z) {
    const w = this.world;
    const id = w.getBlock(x, y, z);
    const kind = LIQUID_KIND[id];
    if (kind === 0) return;
    if (this.isAreaLoaded !== null && !this.isAreaLoaded(x, z, SLOPE_DISTANCE[kind] + 1)) {
      this.counters.deferred++;
      this.schedule(x, y, z, DEFER_TICKS);
      return;
    }
    this.counters.updates++;
    if (kind === KIND_LAVA && this._mixLava(x, y, z, id)) return;
    const step = LEVEL_STEP[kind];
    let level = LIQUID_LEVEL[id];

    // ---- new level of a non-source cell ----
    if (level !== 0) {
      let min = -1;
      let sources = 0;
      for (let d = 0; d < 4; d++) {
        const n = w.getBlock(x + DX[d], y, z + DZ[d]);
        if (LIQUID_KIND[n] !== kind) continue;
        let l = LIQUID_LEVEL[n];
        if (l === 0) sources++;
        else if (l >= FALLING) l = 0;
        if (min < 0 || l < min) min = l;
      }
      let nl = min < 0 ? -1 : min + step;
      if (nl >= FALLING) nl = -1;
      if (y < 255 && LIQUID_KIND[w.getBlock(x, y + 1, z)] === kind) nl = FALLING;
      if (sources >= 2 && kind === KIND_WATER) {
        const below = y > 0 ? w.getBlock(x, y - 1, z) : BEDROCK;
        if (IS_SOLID[below] === 1 || (LIQUID_KIND[below] === KIND_WATER && LIQUID_LEVEL[below] === 0)) nl = 0;
      }
      if (nl !== level) {
        if (nl < 0) {
          w.setBlock(x, y, z, AIR);
          return;
        }
        let delay = TICK_DELAY[kind];
        // Receding lava (level number growing) waits 4x longer with probability 3/4 (Minecraft).
        if (kind === KIND_LAVA && level < FALLING && nl < FALLING && nl > level && this.rng() < 0.75) delay *= 4;
        // Schedule before writing: the block update of our own cell must not replace this delay.
        this.schedule(x, y, z, delay);
        const nid = liquidBlock(kind, nl);
        if (!w.setBlock(x, y, z, nid) || w.getBlock(x, y, z) !== nid) return;   // replaced by a reaction
        level = nl;
      }
    }

    // ---- spreading ----
    const below = y > 0 ? w.getBlock(x, y - 1, z) : BEDROCK;
    if (y > 0 && kind === KIND_LAVA && LIQUID_KIND[below] === KIND_WATER) {
      // Lava flowing down into water turns it into stone.
      if (w.setBlock(x, y - 1, z, STONE)) this._effect('fizz', x, y - 1, z);
      return;
    }
    if (y > 0 && canFlowInto(below)) {
      this._flowInto(x, y - 1, z, kind, FALLING);
      return;
    }
    // Flowing / falling liquid only spreads sideways when standing on something that stops liquids.
    if (level !== 0 && BLOCKS_FLUID[below] === 0) return;
    const nl = level >= FALLING ? 1 : level + step;
    if (nl >= FALLING) return;
    const dirs = this._flowDirections(x, y, z, kind);
    for (let d = 0; d < 4; d++) {
      if ((dirs & (1 << d)) !== 0) this._flowInto(x + DX[d], y, z + DZ[d], kind, nl);
    }
  }

  /** Directions (bit mask, Minecraft order N E S W) toward the nearest drop (getPossibleFlowDirections). */
  _flowDirections(x, y, z, kind) {
    const w = this.world;
    let best = NO_PATH;
    let mask = 0;
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d], nz = z + DZ[d];
      const n = w.getBlock(nx, y, nz);
      if (BLOCKS_FLUID[n] === 1 || (LIQUID_KIND[n] === kind && LIQUID_LEVEL[n] === 0)) continue;
      const nb = y > 0 ? w.getBlock(nx, y - 1, nz) : BEDROCK;
      const j = BLOCKS_FLUID[nb] === 1 ? this._slopeDistance(nx, y, nz, 1, OPP[d], kind) : 0;
      if (j < best) {
        mask = 0;
        best = j;
      }
      if (j === best) mask |= 1 << d;
    }
    return mask;
  }

  /** Distance to the nearest drop from (x, y, z), not going back toward `from` (getSlopeDistance). */
  _slopeDistance(x, y, z, dist, from, kind) {
    const w = this.world;
    let best = NO_PATH;
    for (let d = 0; d < 4; d++) {
      if (d === from) continue;
      const nx = x + DX[d], nz = z + DZ[d];
      const n = w.getBlock(nx, y, nz);
      if (BLOCKS_FLUID[n] === 1 || (LIQUID_KIND[n] === kind && LIQUID_LEVEL[n] === 0)) continue;
      const nb = y > 0 ? w.getBlock(nx, y - 1, nz) : BEDROCK;
      if (BLOCKS_FLUID[nb] === 0) return dist;
      if (dist < SLOPE_DISTANCE[kind]) {
        const j = this._slopeDistance(nx, y, nz, dist + 1, OPP[d], kind);
        if (j < best) best = j;
      }
    }
    return best;
  }
}
