// Block entities (docs/SPEC-wave2.md §6): per-cell data and logic that live beside a block id, like
// Minecraft's BlockEntity. Two kinds:
//   * furnace — AbstractFurnaceBlockEntity: slots [input, fuel, output]; Minecraft's serverTick on the
//     20 Hz tick: 200-tick (10 s) smelting from crafting.js SMELTING, fuel burn times from items.js `fuel`
//     (seconds), a new fuel item is only lit when the current input can be smelted, cooking progress
//     decays by 2 per tick while unlit, changing the input item resets the progress, the lava bucket
//     leaves its bucket behind, the output stacks up to 64; the block is swapped to the matching
//     lit_furnace* variant while burning and back (facing preserved); display ticks near the player
//     (flame + smoke at the front face, 10 % fire crackle — FurnaceBlock.animateTick with the odds of
//     ClientLevel.animateTick's random block sampling).
//   * chest — ChestBlockEntity: 27 slots.
// Contents are dropped (Containers.dropContents: stacks split into 10–30 items, random hop) whenever the
// block is replaced by anything that is not the same container (player, explosion, /setblock destroy …).
// Pure logic: no DOM, runs in Node (tests/blockentities.test.js).
//
// Integration (game.js) — see docs/notes/containers-wave2.md:
//   game.blockEntities = new BlockEntityManager(game); game.blockEntities.attach(world);
//   20 TPS loop:   game.blockEntities.tick(1 / 20)        (tick(dt) per frame works too: whole ticks)
//   onInteractBlock(x, y, z, blockId, ctx): if (game.blockEntities.useBlock(x, y, z, blockId, ctx)) return true;
//   save:          meta.blockEntities = game.blockEntities.serialize()
//   load:          game.blockEntities.deserialize(meta.blockEntities)
//   unload:        game.blockEntities.detach(); game.blockEntities.clear();
import { BLOCKS, ITEM, IS_OPAQUE, IS_SOLID, getItem, maxStackSize } from '../world/registry.js';
import { SMELTING, CRAFTING_REMAINDERS } from './crafting.js';
import { makeStack } from './inventory.js';

const TICKS = 20;
const TICK = 1 / TICKS;
/** At most this many 20 Hz ticks are simulated per tick() call (long stalls are dropped, not replayed). */
const MAX_TICKS_PER_CALL = 40;
/** Ticks between checks that chests still have their block (orphans drop their items). */
const VALIDATE_EVERY = 20;
/** Minecraft AbstractFurnaceBlockEntity: default cooking time (ticks) when nothing is being smelted. */
export const DEFAULT_COOK_TICKS = 200;
/** Minecraft AbstractContainerMenu.stillValid: the player must stay within 8 blocks of the block centre. */
export const CONTAINER_REACH = 8;
/** Slot counts. */
export const CHEST_SIZE = 27;
export const FURNACE_SIZE = 3;
export const FURNACE_INPUT = 0;
export const FURNACE_FUEL = 1;
export const FURNACE_OUTPUT = 2;

// ---------------------------------------------------------------------------------------------------
// Block tables
// ---------------------------------------------------------------------------------------------------

/** Container type per block id ('furnace' | 'chest' | null), from the block's `interact` field. */
const CONTAINER_TYPE = new Array(256).fill(null);
/** Furnace family: block id -> lit / unlit variant with the same facing (-1 = not a furnace). */
const LIT_ID = new Int16Array(256).fill(-1);
const UNLIT_ID = new Int16Array(256).fill(-1);
/** Front direction (unit x / z) of facing blocks, from the texture spec's `facing`. */
const FRONT_X = new Int8Array(256);
const FRONT_Z = new Int8Array(256);
const FACING_STEP = { south: [0, 1], north: [0, -1], east: [1, 0], west: [-1, 0] };

const blockIdsByName = new Map();
for (const b of BLOCKS) if (b) blockIdsByName.set(b.name, b.id);
for (const b of BLOCKS) {
  if (!b) continue;
  if (b.interact === 'furnace' || b.interact === 'chest') CONTAINER_TYPE[b.id] = b.interact;
  const facing = b.tex && typeof b.tex === 'object' ? b.tex.facing : null;
  if (facing && FACING_STEP[facing]) {
    FRONT_X[b.id] = FACING_STEP[facing][0];
    FRONT_Z[b.id] = FACING_STEP[facing][1];
  }
  if (b.interact === 'furnace' && !b.name.startsWith('lit_')) {
    const lit = blockIdsByName.get('lit_' + b.name);
    if (lit !== undefined) {
      LIT_ID[b.id] = lit;
      LIT_ID[lit] = lit;
      UNLIT_ID[lit] = b.id;
      UNLIT_ID[b.id] = b.id;
    }
  }
}

/** 'furnace' | 'chest' | null for a block id. */
export function containerType(blockId) {
  return CONTAINER_TYPE[blockId & 255] ?? null;
}

/** The lit furnace variant with the same facing (or the id itself if it is already lit; -1 otherwise). */
export function litFurnaceOf(blockId) {
  return LIT_ID[blockId & 255];
}

/** The unlit furnace variant with the same facing (-1 if not a furnace). */
export function unlitFurnaceOf(blockId) {
  return UNLIT_ID[blockId & 255];
}

// ---------------------------------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------------------------------

/** Burn time of a fuel item in ticks (items.js `fuel` is in seconds; 0 = not a fuel). */
export function fuelTicks(itemId) {
  const f = getItem(itemId)?.fuel ?? 0;
  return f > 0 ? Math.round(f * TICKS) : 0;
}

/** Minecraft AbstractFurnaceBlockEntity.isFuel. */
export function isFuel(itemId) {
  return fuelTicks(itemId) > 0;
}

/** True if the furnace can smelt `itemId`. */
export function isSmeltable(itemId) {
  return SMELTING.has(itemId);
}

/** Cooking time (ticks) for the stack in the input slot (Minecraft getTotalCookTime: 200 without a recipe). */
export function cookTicksFor(stack) {
  const r = stack ? SMELTING.get(stack.id) : null;
  return r ? Math.max(1, Math.round(r.time * TICKS)) : DEFAULT_COOK_TICKS;
}

function remainderOf(itemId) {
  const name = CRAFTING_REMAINDERS[getItem(itemId)?.name];
  if (!name) return 0;
  const id = ITEM[name.toUpperCase()];
  return id ?? 0;
}

/** A clean { id, count, damage } copy of a valid stack (count clamped to the max stack size), else null. */
export function cleanStack(s) {
  if (!s || typeof s !== 'object') return null;
  const id = s.id;
  if (!Number.isInteger(id) || !getItem(id)) return null;
  const count = Math.min(Math.floor(Number(s.count)), maxStackSize(id));
  if (!(count > 0)) return null;
  const damage = Number.isInteger(s.damage) && s.damage > 0 ? s.damage : 0;
  return { id, count, damage };
}

function sameItem(a, b) {
  return !!a && !!b && a.id === b.id && (a.damage ?? 0) === (b.damage ?? 0);
}

function encodeStack(s) {
  return s ? [s.id, s.count, s.damage ?? 0] : null;
}

function decodeStack(v) {
  if (!Array.isArray(v)) return null;
  return cleanStack({ id: v[0], count: v[1], damage: v[2] ?? 0 });
}

const finiteInt = (v) => Number.isInteger(v);

/** Position key (only used outside hot paths: lookups on clicks / container block changes). */
function keyOf(x, y, z) {
  return `${x},${y},${z}`;
}

// ---------------------------------------------------------------------------------------------------
// Block entities
// ---------------------------------------------------------------------------------------------------

/**
 * Base container block entity: a fixed number of slots holding { id, count, damage } stacks (or null).
 * The slot rules (mayPlace / slotMax / quick-move routing) are used by the container screens
 * (src/ui/slots.js ContainerModel, `{ kind: 'container', index }` slot refs).
 */
export class BlockEntity {
  /**
   * @param {'furnace'|'chest'} type
   * @param {number} x @param {number} y @param {number} z  block position
   * @param {number} size slot count
   */
  constructor(type, x, y, z, size) {
    this.type = type;
    this.x = x;
    this.y = y;
    this.z = z;
    /** Slot stacks ({ id, count, damage } or null). Mutate through set() so `version` changes. */
    this.slots = new Array(size).fill(null);
    /** Incremented on every slot change (screens re-render when it changes). */
    this.version = 0;
    /** True once the entity was removed (its block is gone); open screens close themselves. */
    this.removed = false;
    /** @type {BlockEntityManager|null} */
    this.manager = null;
  }

  get size() {
    return this.slots.length;
  }

  /** Stack in slot i (null when empty). */
  get(i) {
    return this.slots[i] ?? null;
  }

  /** Replace slot i (the stack object is stored as given when valid; null / empty clears the slot). */
  set(i, stack) {
    if (i < 0 || i >= this.slots.length) return;
    this.slots[i] = stack && stack.count > 0 ? stack : null;
    this.changed();
  }

  /** Mark a change (call after mutating a stored stack in place). */
  changed() {
    this.version++;
    if (this.manager) this.manager.dirty = true;
  }

  /** Whether `stack` may be put into slot i by the player (Slot.mayPlace). */
  mayPlace(i, stack) {
    return i >= 0 && i < this.slots.length && !!stack;
  }

  /** Max count of `stack` in slot i (Slot.getMaxStackSize). */
  slotMax(i, stack) {
    return maxStackSize(stack.id);
  }

  /**
   * Shift-click from container slot i into the player inventory: 'reverse' = hotbar right-to-left then
   * the main inventory bottom-up (Minecraft moveItemStackTo(..., true)), 'forward' = main inventory
   * top-down then the hotbar.
   */
  quickMoveOut() {
    return 'reverse';
  }

  /**
   * Shift-click from the player inventory: container slot indices to try in order, or null when the item
   * does not go into this container (the screen then moves it between the hotbar and the main inventory).
   */
  quickMoveIn() {
    return slotRange(this.slots.length);
  }

  isEmpty() {
    for (const s of this.slots) if (s) return false;
    return true;
  }

  /** Remove every stack; returns copies of the non-empty ones. */
  takeAll() {
    const out = [];
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      if (s) out.push({ id: s.id, count: s.count, damage: s.damage ?? 0 });
      this.slots[i] = null;
    }
    if (out.length) this.changed();
    return out;
  }

  /** Nothing worth saving (empty and idle). */
  isIdle() {
    return this.isEmpty();
  }

  /** Plain JSON object (positions, slots as [id, count, damage] or null). */
  serialize() {
    return { type: this.type, x: this.x, y: this.y, z: this.z, items: this.slots.map(encodeStack) };
  }

  _loadItems(items) {
    if (!Array.isArray(items)) return;
    for (let i = 0; i < this.slots.length && i < items.length; i++) this.slots[i] = decodeStack(items[i]);
  }
}

/** Frozen [0, 1, …, n − 1] (cached per n). */
const SLOT_RANGES = new Map();
function slotRange(n) {
  let r = SLOT_RANGES.get(n);
  if (!r) SLOT_RANGES.set(n, (r = Object.freeze(Array.from({ length: n }, (_, i) => i))));
  return r;
}

/** Chest (ChestBlockEntity): 27 slots, any item anywhere. */
export class ChestBlockEntity extends BlockEntity {
  constructor(x, y, z) {
    super('chest', x, y, z, CHEST_SIZE);
  }
}

/**
 * Furnace (AbstractFurnaceBlockEntity). Fields in ticks (20 per second), exactly Minecraft's:
 * `burnTicks` (litTime, fire left), `burnTotalTicks` (litDuration of the current fuel item),
 * `cookTicks` (cookingProgress), `cookTotalTicks` (cookingTotalTime). The SPEC names `burnTime`,
 * `burnTotal`, `cookTime` (and `cookTotal`) are getters in seconds.
 */
export class FurnaceBlockEntity extends BlockEntity {
  constructor(x, y, z) {
    super('furnace', x, y, z, FURNACE_SIZE);
    this.burnTicks = 0;
    this.burnTotalTicks = 0;
    this.cookTicks = 0;
    this.cookTotalTicks = DEFAULT_COOK_TICKS;
  }

  /** Seconds of fire left. */
  get burnTime() {
    return this.burnTicks / TICKS;
  }

  /** Seconds the current fuel item burns in total. */
  get burnTotal() {
    return this.burnTotalTicks / TICKS;
  }

  /** Seconds the current item has been cooking. */
  get cookTime() {
    return this.cookTicks / TICKS;
  }

  /** Seconds one item takes (10). */
  get cookTotal() {
    return this.cookTotalTicks / TICKS;
  }

  /** True while the fire burns (the block is the lit variant). */
  get lit() {
    return this.burnTicks > 0;
  }

  /** Fire left 0..1 (AbstractFurnaceMenu.getLitProgress; a missing total counts as 200 ticks). */
  get litProgress() {
    const total = this.burnTotalTicks > 0 ? this.burnTotalTicks : DEFAULT_COOK_TICKS;
    return Math.max(0, Math.min(1, this.burnTicks / total));
  }

  /** Cooking progress 0..1 of the current item (AbstractFurnaceMenu.getBurnProgress). */
  get cookProgress() {
    const total = this.cookTotalTicks;
    return total > 0 && this.cookTicks > 0 ? Math.max(0, Math.min(1, this.cookTicks / total)) : 0;
  }

  /**
   * Player edits (AbstractFurnaceBlockEntity.setItem): putting a different item into the input slot (or
   * emptying it) restarts the cooking progress; adding more of the same item keeps it.
   */
  set(i, stack) {
    if (i === FURNACE_INPUT) {
      const s = stack && stack.count > 0 ? stack : null;
      if (!s || !sameItem(s, this.slots[FURNACE_INPUT])) {
        this.cookTotalTicks = cookTicksFor(s);
        this.cookTicks = 0;
      }
    }
    super.set(i, stack);
  }

  /** Input: anything; fuel: fuels and empty buckets (FurnaceFuelSlot); output: take only. */
  mayPlace(i, stack) {
    if (!stack) return false;
    if (i === FURNACE_INPUT) return true;
    if (i === FURNACE_FUEL) return isFuel(stack.id) || stack.id === ITEM.BUCKET;
    return false;
  }

  /** Buckets stack to 1 in the fuel slot (FurnaceFuelSlot.getMaxStackSize). */
  slotMax(i, stack) {
    if (i === FURNACE_FUEL && stack.id === ITEM.BUCKET) return 1;
    return maxStackSize(stack.id);
  }

  /** AbstractFurnaceMenu.quickMoveStack: the result goes hotbar-first (reverse), input / fuel main-first. */
  quickMoveOut(i) {
    return i === FURNACE_OUTPUT ? 'reverse' : 'forward';
  }

  /** Smeltable items -> input, else fuels -> fuel slot, else null (hotbar <-> main inventory). */
  quickMoveIn(stack) {
    if (!stack) return null;
    if (isSmeltable(stack.id)) return INPUT_ONLY;
    if (isFuel(stack.id)) return FUEL_ONLY;
    return null;
  }

  isIdle() {
    return this.isEmpty() && this.burnTicks <= 0 && this.cookTicks <= 0;
  }

  /** Minecraft canBurn: an input with a recipe whose result fits into the output slot. */
  canSmelt() {
    const input = this.slots[FURNACE_INPUT];
    if (!input) return false;
    const recipe = SMELTING.get(input.id);
    if (!recipe) return false;
    const out = this.slots[FURNACE_OUTPUT];
    if (!out) return true;
    const result = recipe.output;
    if (out.id !== result.id || (out.damage ?? 0) !== (result.damage ?? 0)) return false;
    return out.count + result.count <= maxStackSize(out.id);
  }

  /**
   * One 20 Hz tick of AbstractFurnaceBlockEntity.serverTick (without the block-state swap, which the
   * manager does). Returns true when the slots changed (fuel used, item smelted).
   */
  tick() {
    let slotsChanged = false;
    if (this.burnTicks > 0) this.burnTicks--;
    const fuel = this.slots[FURNACE_FUEL];
    const hasInput = !!this.slots[FURNACE_INPUT];
    if (this.burnTicks > 0 || (fuel && hasInput)) {
      const smeltable = this.canSmelt();
      if (this.burnTicks <= 0 && smeltable) {
        const burn = fuel ? fuelTicks(fuel.id) : 0;
        this.burnTicks = burn;
        this.burnTotalTicks = burn;
        if (burn > 0) {
          // consume one fuel item; a lava bucket leaves its empty bucket behind
          if (fuel.count > 1) {
            this.slots[FURNACE_FUEL] = { id: fuel.id, count: fuel.count - 1, damage: fuel.damage ?? 0 };
          } else {
            const rem = remainderOf(fuel.id);
            this.slots[FURNACE_FUEL] = rem ? makeStack(rem, 1) : null;
          }
          slotsChanged = true;
        }
      }
      if (this.burnTicks > 0 && smeltable) {
        this.cookTicks++;
        if (this.cookTicks >= this.cookTotalTicks) {
          this.cookTicks = 0;
          this._smeltOne();
          this.cookTotalTicks = cookTicksFor(this.slots[FURNACE_INPUT]);
          slotsChanged = true;
        }
      } else {
        this.cookTicks = 0;
      }
    } else if (this.burnTicks <= 0 && this.cookTicks > 0) {
      this.cookTicks = Math.max(0, Math.min(this.cookTotalTicks, this.cookTicks - 2));
    }
    if (slotsChanged) this.changed();
    return slotsChanged;
  }

  /** AbstractFurnaceBlockEntity.burn: one input item becomes the result in the output slot. */
  _smeltOne() {
    const input = this.slots[FURNACE_INPUT];
    const recipe = SMELTING.get(input.id);
    const result = recipe.output;
    const out = this.slots[FURNACE_OUTPUT];
    this.slots[FURNACE_OUTPUT] = out
      ? { id: out.id, count: out.count + result.count, damage: out.damage ?? 0 }
      : { id: result.id, count: result.count, damage: result.damage ?? 0 };
    this.slots[FURNACE_INPUT] = input.count > 1 ? { id: input.id, count: input.count - 1, damage: input.damage ?? 0 } : null;
  }

  serialize() {
    const o = super.serialize();
    o.burn = this.burnTicks;
    o.burnTotal = this.burnTotalTicks;
    o.cook = this.cookTicks;
    o.cookTotal = this.cookTotalTicks;
    return o;
  }
}
const INPUT_ONLY = Object.freeze([FURNACE_INPUT]);
const FUEL_ONLY = Object.freeze([FURNACE_FUEL]);

/** Create an empty block entity of `type` at (x, y, z) or null for unknown types. */
export function createBlockEntity(type, x, y, z) {
  if (type === 'furnace') return new FurnaceBlockEntity(x, y, z);
  if (type === 'chest') return new ChestBlockEntity(x, y, z);
  return null;
}

/** Restore one serialized block entity (null when invalid). */
export function blockEntityFromJSON(o) {
  if (!o || typeof o !== 'object') return null;
  const { x, y, z } = o;
  if (!finiteInt(x) || !finiteInt(y) || !finiteInt(z) || y < 0 || y > 255) return null;
  const be = createBlockEntity(o.type, x, y, z);
  if (!be) return null;
  be._loadItems(o.items);
  if (be instanceof FurnaceBlockEntity) {
    const int = (v, lo, hi, d) => (Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : d);
    be.burnTotalTicks = int(o.burnTotal, 0, 1e7, 0);
    be.burnTicks = int(o.burn, 0, Math.max(be.burnTotalTicks, 0), 0);
    be.cookTotalTicks = int(o.cookTotal, 1, 1e5, cookTicksFor(be.slots[FURNACE_INPUT]));
    be.cookTicks = int(o.cook, 0, be.cookTotalTicks, 0);
  }
  return be;
}

// ---------------------------------------------------------------------------------------------------
// Display ticks (client-side effects)
// ---------------------------------------------------------------------------------------------------

/** P(rand(n) - rand(n) == d) — one axis of ClientLevel.animateTick's random block offset. */
function tri(d, n) {
  const a = n - Math.abs(d);
  return a > 0 ? a / (n * n) : 0;
}

/**
 * Chance per tick that Minecraft's ClientLevel.animateTick (667 samples within ±16 and 667 within ±32 of
 * the player's block) picks the block at offset (dx, dy, dz) — i.e. how often a lit furnace shows its
 * flames / plays its crackle. ≈ 0.18 at the player, ≈ 0.11 at 5 blocks, 0 beyond 31.
 */
export function displayTickChance(dx, dy, dz) {
  return 667 * (tri(dx, 16) * tri(dy, 16) * tri(dz, 16) + tri(dx, 32) * tri(dy, 32) * tri(dz, 32));
}

/** Minecraft's random.triangle(mode, deviation). */
function triangle(rnd, mode, deviation) {
  return mode + deviation * (rnd() - rnd());
}

// ---------------------------------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------------------------------

/**
 * Every block entity of the loaded world (SPEC-wave2 §6), indexed by block position. Block entities of
 * unloaded chunks stay in memory (they are few) but do not tick, like Minecraft.
 */
export class BlockEntityManager {
  /**
   * @param {object} game  world, player, ui, audio, particles, entities / spawnItem (read lazily)
   * @param {{ rng?: () => number }} [options]
   */
  constructor(game, options = {}) {
    this.game = game;
    this.rng = options.rng ?? Math.random;
    /** @type {Map<string, BlockEntity>} */
    this._map = new Map();
    /** Furnaces in creation order (the only kind that ticks). */
    this._furnaces = [];
    this._acc = 0;
    /** Ticks simulated so far. */
    this.ticks = 0;
    /** Set on every change since the flag was last cleared (the integrator may use it to save). */
    this.dirty = false;
    this._unsub = null;
    this._world = null;
  }

  /** Number of block entities. */
  get count() {
    return this._map.size;
  }

  /** Iterable of all block entities. */
  get list() {
    return this._map.values();
  }

  /** The block entity at (x, y, z) or null. */
  get(x, y, z) {
    return this._map.get(keyOf(x, y, z)) ?? null;
  }

  /**
   * The block entity at (x, y, z), created when missing ('furnace' | 'chest'). An entity of another type
   * at that position is removed first (its contents drop). Returns null for an unknown type or position.
   */
  getOrCreate(x, y, z, type) {
    if (!finiteInt(x) || !finiteInt(y) || !finiteInt(z) || y < 0 || y > 255) return null;
    const cur = this.get(x, y, z);
    if (cur) {
      if (cur.type === type) return cur;
      this._removeEntity(cur, true);
    }
    const be = createBlockEntity(type, x, y, z);
    if (!be) return null;
    this._add(be);
    this.dirty = true;
    return be;
  }

  _add(be) {
    const k = keyOf(be.x, be.y, be.z);
    const old = this._map.get(k);
    if (old && old !== be) this._removeEntity(old, false);
    be.manager = this;
    be.removed = false;
    this._map.set(k, be);
    // (a removed furnace is only dropped from the list at the next tick: never list it twice)
    if (be.type === 'furnace' && !this._furnaces.includes(be)) this._furnaces.push(be);
    return be;
  }

  /**
   * Remove the block entity at (x, y, z) WITHOUT dropping anything. Returns copies of its stacks (for the
   * caller to drop or discard); [] when there is none.
   */
  remove(x, y, z) {
    const be = this.get(x, y, z);
    if (!be) return [];
    const stacks = be.takeAll();
    this._removeEntity(be, false);
    return stacks;
  }

  _removeEntity(be, drop) {
    const k = keyOf(be.x, be.y, be.z);
    if (this._map.get(k) === be) this._map.delete(k);
    if (drop) this.dropContents(be);
    be.removed = true;
    be.manager = null;
    this.dirty = true;
    // _furnaces is compacted lazily (tick / clear)
  }

  /**
   * Drop every stack of `be` at its block like Minecraft's Containers.dropContents: a random point inside
   * the cell, stacks split into parts of 10–30 items, each with a small random hop. Empties the entity.
   */
  dropContents(be) {
    const stacks = be.takeAll();
    if (!stacks.length) return;
    const rnd = this.rng;
    const game = this.game;
    for (const s of stacks) {
      const px = be.x + 0.125 + rnd() * 0.75;
      const py = be.y + rnd() * 0.75;
      const pz = be.z + 0.125 + rnd() * 0.75;
      let left = s.count;
      while (left > 0) {
        const n = Math.min(left, 10 + Math.floor(rnd() * 21));
        left -= n;
        const vx = triangle(rnd, 0, 0.11485) * TICKS;
        const vy = triangle(rnd, 0.2, 0.11485) * TICKS;
        const vz = triangle(rnd, 0, 0.11485) * TICKS;
        const stack = { id: s.id, count: n, damage: s.damage ?? 0 };
        if (typeof game?.spawnItem === 'function') game.spawnItem(stack, px, py, pz, vx, vy, vz, 0);
        else game?.entities?.spawnItem?.(stack, px, py, pz, vx, vy, vz, 0);
      }
    }
  }

  /**
   * World block change hook (World.onBlockChanged): a container block that is replaced by anything other
   * than the same kind of container drops its contents; a newly placed container gets its (empty)
   * entity right away (Minecraft creates block entities on placement). Swapping a furnace to its lit
   * variant (same kind) keeps the entity. Cheap for every other block change (two table lookups).
   */
  onBlockChanged(x, y, z, oldId, newId) {
    const oldType = CONTAINER_TYPE[oldId & 255];
    const newType = CONTAINER_TYPE[newId & 255];
    if (oldType === null && newType === null) return;
    if (oldType === newType) return;
    if (oldType !== null) {
      const be = this.get(x, y, z);
      if (be) this._removeEntity(be, true);
    }
    if (newType !== null) this.getOrCreate(x, y, z, newType);
  }

  /** Subscribe to `world.onBlockChanged` (returns this; detach() unsubscribes). */
  attach(world) {
    this.detach();
    if (world && typeof world.onBlockChanged === 'function') {
      this._world = world;
      this._unsub = world.onBlockChanged((x, y, z, o, n) => this.onBlockChanged(x, y, z, o, n));
    }
    return this;
  }

  detach() {
    if (typeof this._unsub === 'function') this._unsub();
    this._unsub = null;
    this._world = null;
  }

  /**
   * Right click on a block (game.onInteractBlock): for a chest or furnace, open its screen and return
   * true (the click is consumed). A chest with a solid opaque block on top does not open (Minecraft
   * ChestBlock.isChestBlockedAt) but still consumes the click. Returns false for other blocks.
   */
  useBlock(x, y, z, blockId) {
    const type = CONTAINER_TYPE[blockId & 255];
    if (!type) return false;
    const game = this.game;
    const world = game?.world;
    if (type === 'chest' && world) {
      const above = world.getBlock(x, y + 1, z);
      if (IS_SOLID[above] && IS_OPAQUE[above]) return true;
    }
    const be = this.getOrCreate(x, y, z, type);
    if (!be) return false;
    const ui = game?.ui;
    if (type === 'furnace') ui?.openFurnace?.(be);
    else ui?.openChest?.(be);
    return true;
  }

  /**
   * Advance by `dt` seconds (default one tick): whole 20 Hz ticks are simulated (at most 40 per call).
   * Furnaces in unloaded chunks are frozen; a furnace whose block is gone (edited while the entity was not
   * notified) is removed and its contents dropped.
   */
  tick(dt = TICK) {
    if (!(dt > 0)) return;
    this._acc += Math.min(dt, 2);
    let n = 0;
    while (this._acc >= TICK - 1e-9) {
      if (n >= MAX_TICKS_PER_CALL) {
        this._acc = 0;
        break;
      }
      this._acc -= TICK;
      n++;
      this._tickOnce();
    }
  }

  _tickOnce() {
    this.ticks++;
    const world = this.game?.world;
    if (!world) return;
    if (this.ticks % VALIDATE_EVERY === 0) this._validateContainers(world);
    const furnaces = this._furnaces;
    let removed = 0;
    for (let i = 0; i < furnaces.length; i++) {
      const f = furnaces[i];
      if (f.removed) {
        removed++;
        continue;
      }
      if (typeof world.isChunkGenerated === 'function' && !world.isChunkGenerated(f.x >> 4, f.z >> 4)) continue;
      const id = world.getBlock(f.x, f.y, f.z);
      if (CONTAINER_TYPE[id] !== 'furnace') {
        // The block was replaced without a notification: never lose the items.
        this._removeEntity(f, true);
        removed++;
        continue;
      }
      if (f.tick()) this.dirty = true;
      const want = f.burnTicks > 0 ? LIT_ID[id] : UNLIT_ID[id];
      if (want >= 0 && want !== id) world.setBlock(f.x, f.y, f.z, want);
      if (f.burnTicks > 0) this._displayTick(f, want >= 0 ? want : id);
    }
    if (removed > 0) this._furnaces = furnaces.filter((f) => !f.removed);
  }

  /**
   * Once a second: non-ticking containers (chests) whose chunk is loaded but whose block is no longer
   * the same kind of container (changed while the manager was not notified) are removed and their
   * contents dropped, so items never stay locked in an invisible container.
   */
  _validateContainers(world) {
    let orphans = null;
    for (const be of this._map.values()) {
      if (be.type === 'furnace' || be.removed) continue;   // furnaces validate themselves every tick
      if (typeof world.isChunkGenerated === 'function' && !world.isChunkGenerated(be.x >> 4, be.z >> 4)) continue;
      if (CONTAINER_TYPE[world.getBlock(be.x, be.y, be.z)] !== be.type) (orphans ??= []).push(be);
    }
    if (orphans) for (const be of orphans) this._removeEntity(be, true);
  }

  /** FurnaceBlock.animateTick for a lit furnace, with the odds of ClientLevel's random sampling. */
  _displayTick(f, blockId) {
    const game = this.game;
    const p = game?.player;
    const particles = game?.particles;
    if (!p || p.dead || !Number.isFinite(p.x)) return;
    const dx = f.x - Math.floor(p.x);
    const dy = f.y - Math.floor(p.y);
    const dz = f.z - Math.floor(p.z);
    if (dx > 31 || dx < -31 || dy > 31 || dy < -31 || dz > 31 || dz < -31) return;
    const rnd = this.rng;
    if (rnd() >= displayTickChance(dx, dy, dz)) return;
    const cx = f.x + 0.5, cz = f.z + 0.5;
    if (rnd() < 0.1) game.audio?.play?.('fire_crackle', { x: cx, y: f.y, z: cz });
    const fx = FRONT_X[blockId], fz = FRONT_Z[blockId];
    const side = rnd() * 0.6 - 0.3;
    const ox = fx !== 0 ? fx * 0.52 : side;
    const oz = fz !== 0 ? fz * 0.52 : side;
    const oy = rnd() * 6 / 16;
    particles?.spawnTorchFlame?.(cx + ox, f.y + oy, cz + oz);
  }

  /** Remove every block entity (world unload); nothing is dropped. */
  clear() {
    for (const be of this._map.values()) {
      be.removed = true;
      be.manager = null;
    }
    this._map.clear();
    this._furnaces.length = 0;
    this._acc = 0;
  }

  /** JSON-friendly array of every non-idle block entity (empty idle containers are recreated on use). */
  serialize() {
    const out = [];
    for (const be of this._map.values()) {
      if (!be.removed && !be.isIdle()) out.push(be.serialize());
    }
    return out;
  }

  /** Restore serialize() output (adds to / replaces entities at the same positions). Invalid entries are skipped. */
  deserialize(arr) {
    if (!Array.isArray(arr)) return 0;
    let n = 0;
    for (const o of arr) {
      let be = null;
      try {
        be = blockEntityFromJSON(o);
      } catch {
        be = null;
      }
      if (!be) continue;
      this._add(be);
      n++;
    }
    return n;
  }
}
