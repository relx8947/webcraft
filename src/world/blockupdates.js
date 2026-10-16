// Block updates after a block change (docs/SPEC.md §9.6, docs/SPEC-wave2.md §1 / §5). Pure logic: works
// with any object providing
//   getBlock(x, y, z) -> id      setBlock(x, y, z, id, { update: false }) -> bool
// so it is unit-tested under Node with a plain voxel map.
//
// A change at (x, y, z) queues checks of that cell and of its 6 neighbours (Minecraft notifies all of
// them; the SPEC requires at least the block above and the 4 horizontal ones). A check of a cell:
//  * Liquid: handed to the FluidSimulator (`fluids.neighborChanged`): lava touching water solidifies at
//    once, everything else gets a scheduled liquid update (fluids.js). Without a simulator liquids are
//    static (wave 1 behaviour, unit tests with plain maps).
//  * Support: a block with NEEDS_SUPPORT that registry canStay() rejects (floor support, the block behind a
//    wall torch, a cactus with a solid block beside it, sugar cane without water next to its ground...)
//    pops off (a cactus also with lava beside it or liquid above it, like Minecraft's CactusBlock):
//    it becomes air and drops its loot (getDrops without a tool) via onDropItem. Its neighbours
//    are checked next, so stacks cascade (sugar cane, cactus, a torch on falling sand, wheat on farmland
//    that turned into dirt).
//  * Gravity: a HAS_GRAVITY block (sand, gravel) whose block below is free (air, liquid or another
//    replaceable block like short grass) falls. With an `onFall` hook that accepts it (returns true —
//    e.g. the game spawns a falling-block entity, which places the block itself when it lands) the
//    block is just removed. Otherwise it falls *instantly* (SPEC wave 1): it moves down through every
//    cell without a collision box until the block below is solid. If the landing cell is replaceable
//    (air, water, short grass...) the block is placed there; otherwise (torch, flower, sapling, sugar
//    cane...) it breaks and drops itself as an item. Falling below y = 0 removes it.
//  * Farmland under a solid block turns into dirt (Minecraft BlockFarmland.neighborChanged).
// Every change made here notifies the neighbours of the changed cell the same way (liquids flow into the
// space a popped plant or a falling block left). Processing uses an explicit FIFO queue (no recursion), so
// arbitrarily long cascades are safe. Each process() call handles at most `budget` checks; leftovers are
// handled by the next call (World.tick).

import {
  BLOCK, NEEDS_SUPPORT, HAS_GRAVITY, IS_SOLID, IS_REPLACEABLE, LIQUID_KIND, RENDER_TYPE, RENDER,
  canStay, getDrops, itemForBlock,
} from './registry.js';

const AIR = 0;
const DIRT = BLOCK.DIRT;
const CACTUS = BLOCK.CACTUS;

/** Offsets of a cell and its 6 neighbours (self first, then above, the 4 horizontal ones, below). */
const CHECK_OFFSETS = Int8Array.of(0, 0, 0, 0, 1, 0, 1, 0, 0, -1, 0, 0, 0, 0, 1, 0, 0, -1, 0, -1, 0);

export class BlockUpdater {
  /**
   * @param {{ getBlock(x:number,y:number,z:number):number,
   *           setBlock(x:number,y:number,z:number,id:number,opts?:{update?:boolean}):boolean }} world
   * @param {{ onDropItem?: (itemId:number, count:number, x:number, y:number, z:number) => void,
   *           onFall?: (blockId:number, x:number, y:number, z:number) => boolean,
   *           onBlockPopped?: (blockId:number, x:number, y:number, z:number) => void,
   *           fluids?: { neighborChanged(x:number, y:number, z:number): void } | null,
   *           rng?: () => number, budget?: number }} [options]
   *   onDropItem receives the centre of the block the item comes from. onFall is called with the cell a
   *   gravity block leaves (already set to air); return true if it was taken over (falling entity).
   *   onBlockPopped is called (block cell coordinates) when a block breaks because it lost its support,
   *   right after it became air — break particles and sound like Minecraft's destroyBlock.
   *   fluids: the world's FluidSimulator (liquid cells next to changes get updates); settable later.
   */
  constructor(world, {
    onDropItem = null, onFall = null, onBlockPopped = null, fluids = null, rng = Math.random, budget = 1 << 20,
  } = {}) {
    this.world = world;
    this.onDropItem = onDropItem;
    this.onFall = onFall;
    this.onBlockPopped = onBlockPopped;
    this.fluids = fluids;
    this.rng = rng;
    this.budget = budget;
    this._get = (x, y, z) => world.getBlock(x, y, z);   // for canStay (created once)
    this._cap = 256;
    this._q = new Int32Array(this._cap * 3);   // ring buffer of (x, y, z)
    this._head = 0;
    this._size = 0;
    this._processing = false;
  }

  /** Number of queued checks. */
  get pending() {
    return this._size;
  }

  /** Drop every queued check. */
  clear() {
    this._head = 0;
    this._size = 0;
  }

  /**
   * A block changed at (x, y, z): check that cell and its 6 neighbours, then process the queue (unless
   * this is a nested call during processing — the outer loop picks the new entries up).
   */
  blockChanged(x, y, z) {
    this.changed(x, y, z);
    this.process();
  }

  /** Queue checks of (x, y, z) and its 6 neighbours (without processing). */
  changed(x, y, z) {
    const o = CHECK_OFFSETS;
    for (let k = 0; k < o.length; k += 3) this.enqueue(x + o[k], y + o[k + 1], z + o[k + 2]);
  }

  /** Queue a check of the cell (x, y, z). */
  enqueue(x, y, z) {
    if (y < 0 || y > 255) return;
    if (this._size === this._cap) this._grow();
    const i = ((this._head + this._size) % this._cap) * 3;
    this._q[i] = x;
    this._q[i + 1] = y;
    this._q[i + 2] = z;
    this._size++;
  }

  /**
   * Process queued checks (FIFO).
   * @param {number} [limit] maximum number of checks in this call
   * @returns {number} checks performed
   */
  process(limit = this.budget) {
    if (this._processing) return 0;
    this._processing = true;
    let n = 0;
    try {
      while (this._size > 0 && n < limit) {
        const i = this._head * 3;
        const x = this._q[i], y = this._q[i + 1], z = this._q[i + 2];
        this._head = (this._head + 1) % this._cap;
        this._size--;
        n++;
        this._check(x, y, z);
      }
    } finally {
      this._processing = false;
    }
    return n;
  }

  /**
   * Break the block at (x, y, z) like a plant losing its support: air + its drops (no tool), then the
   * neighbours are checked (random ticks use this for sugar cane without water, crops on dry ground...).
   * @param {{effects?: boolean}} [opts] effects: false skips onBlockPopped (leaf decay has no particles)
   * @returns {boolean} false if the cell could not be changed
   */
  pop(x, y, z, { effects = true } = {}) {
    const w = this.world;
    const id = w.getBlock(x, y, z);
    if (id === AIR || !w.setBlock(x, y, z, AIR, { update: false })) return false;
    if (effects) this._popped(id, x, y, z);
    for (const d of getDrops(id, 0, this.rng)) this._drop(d.id, d.count, x, y, z);
    this.changed(x, y, z);
    this.process();
    return true;
  }

  _grow() {
    const cap = this._cap * 2;
    const q = new Int32Array(cap * 3);
    for (let k = 0; k < this._size; k++) {
      const s = ((this._head + k) % this._cap) * 3;
      q[k * 3] = this._q[s];
      q[k * 3 + 1] = this._q[s + 1];
      q[k * 3 + 2] = this._q[s + 2];
    }
    this._q = q;
    this._cap = cap;
    this._head = 0;
  }

  _check(x, y, z) {
    const w = this.world;
    const id = w.getBlock(x, y, z);
    if (id === AIR) return;
    if (LIQUID_KIND[id] !== 0) {
      if (this.fluids !== null) this.fluids.neighborChanged(x, y, z);
      return;
    }
    if (NEEDS_SUPPORT[id] === 1 &&
      (!canStay(id, this._get, x, y, z) || (id === CACTUS && this._cactusDrowned(x, y, z)))) {
      if (!w.setBlock(x, y, z, AIR, { update: false })) return;
      this._popped(id, x, y, z);
      for (const d of getDrops(id, 0, this.rng)) this._drop(d.id, d.count, x, y, z);
      this.changed(x, y, z);
      return;
    }
    if (HAS_GRAVITY[id] === 1) {
      const below = y > 0 ? w.getBlock(x, y - 1, z) : AIR;
      if (IS_REPLACEABLE[below] === 1) this._fall(x, y, z, id);
      return;
    }
    if (RENDER_TYPE[id] === RENDER.FARMLAND && y < 255 && IS_SOLID[w.getBlock(x, y + 1, z)] === 1) {
      if (w.setBlock(x, y, z, DIRT, { update: false })) this.changed(x, y, z);
    }
  }

  /** Minecraft CactusBlock.canSurvive extras: lava beside it or any liquid above breaks a cactus. */
  _cactusDrowned(x, y, z) {
    const w = this.world;
    if (y < 255 && LIQUID_KIND[w.getBlock(x, y + 1, z)] !== 0) return true;
    return LIQUID_KIND[w.getBlock(x + 1, y, z)] === 2 || LIQUID_KIND[w.getBlock(x - 1, y, z)] === 2 ||
      LIQUID_KIND[w.getBlock(x, y, z + 1)] === 2 || LIQUID_KIND[w.getBlock(x, y, z - 1)] === 2;
  }

  _fall(x, y, z, id) {
    const w = this.world;
    if (!w.setBlock(x, y, z, AIR, { update: false })) return;
    this.changed(x, y, z);
    if (typeof this.onFall === 'function') {
      let taken = false;
      try {
        taken = this.onFall(id, x, y, z) === true;
      } catch (err) {
        console.error('[blockupdates] onFall failed:', err);
      }
      if (taken) return;
    }
    // Fall through every cell without a collision box; stop above the first solid block.
    let ly = y - 1;
    while (ly >= 0 && IS_SOLID[w.getBlock(x, ly, z)] === 0) ly--;
    if (ly < 0) return;                       // fell out of the world
    const land = ly + 1;
    const cur = w.getBlock(x, land, z);
    if (IS_REPLACEABLE[cur] === 1) {
      if (w.setBlock(x, land, z, id, { update: false })) this.changed(x, land, z);
    } else {
      // Landed inside a non-solid, non-replaceable block (torch, flower...): break into an item.
      this._drop(itemForBlock(id), 1, x, land, z);
    }
  }

  _popped(id, x, y, z) {
    if (typeof this.onBlockPopped !== 'function') return;
    try {
      this.onBlockPopped(id, x, y, z);
    } catch (err) {
      console.error('[blockupdates] onBlockPopped failed:', err);
    }
  }

  _drop(itemId, count, x, y, z) {
    if (!itemId || count <= 0 || typeof this.onDropItem !== 'function') return;
    try {
      this.onDropItem(itemId, count, x + 0.5, y + 0.5, z + 0.5);
    } catch (err) {
      console.error('[blockupdates] onDropItem failed:', err);
    }
  }
}
