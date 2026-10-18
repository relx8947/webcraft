// Entities (SPEC §9.5): a generic entity list with Minecraft-faithful dropped items, plus falling
// blocks, primed TNT and explosions built on the same base class. Pure logic (runs under Node): the
// world is only accessed through getBlock / setBlock / getLight, the player through x/y/z, height,
// dead, mode, inventory, getAABB(), damage().
//
// Minecraft rules reproduced (per-tick constants converted to seconds, integrated in sub-steps of at
// most one tick so the behaviour does not depend on the frame rate):
//   * ItemEntity 0.25 x 0.25: gravity 0.04 b/tick² (16 b/s²), drag 0.98/tick, ground friction
//     slipperiness·0.98/tick (ice keeps items sliding), random pop (±0.1, 0.2, ±0.1 b/tick) when
//     spawned without a velocity, pushed toward the nearest free side when inside a solid block
//     (Entity.moveTowardsClosestSpace), floats when submerged deeper than 0.1 (no gravity, +0.0005
//     b/tick² up to 0.06 b/tick, horizontal drag 0.99 in water / 0.95 in lava), burns in lava,
//     splashes when it falls into water, merges with identical stacks whose boxes are within 0.5
//     blocks horizontally (combined count <= max stack; every 2 s, every 0.1 s after crossing a block
//     border), despawns after 300 s, dies below y = -64, light sampled every update.
//   * Pickup: player alive, pickup delay elapsed, item centre within 1.5 blocks of the player's axis
//     horizontally and within the player box grown by 0.5 vertically. inventory.add(stack) returns the
//     leftover: only what fit is taken (creative players also swallow items that do not fit, like
//     Minecraft). The taken part flies into the player over 3 ticks (the "magnet") with a "pop".
//   * FallingBlockEntity / PrimedTntEntity / explode(): FallingBlockEntity, PrimedTnt and Explosion
//     (16³ ray grid, blast resistance, 1/power drop chance, chain-primed TNT, exposure-scaled damage
//     and knockback for the player and entities).
//   * Arrow (SPEC-wave2 §3.2, Minecraft AbstractArrow): gravity 0.05 b/tick², drag 0.99 (water 0.6), a swept
//     point ray against block collision boxes and entity boxes grown by 0.3 every sub-step (no tunnelling),
//     damage ceil(speed · baseDamage) (+ random crit bonus), sticks into blocks (shake, 60 s), falls again
//     when its block disappears, survival player arrows can be picked up from the ground.
//   * Wave 2: liquids through the registry helpers (all flowing / falling levels), Minecraft's fluid push
//     (world.fluids.flowVector) on items, mobs and arrows; falling blocks land with canStay; entities with
//     `freezeUnmeshed` (mobs, arrows) are frozen while their chunk is not meshed; pushable entities (mobs,
//     the player) push each other apart (Entity.push); raycastEntities / countEntities / spawnArrow;
//     mobs persist through registerEntityType (mobs.js registers 'mob').
//
// Extension: subclass Entity (update / getRenderItem / hurt / getAABB), add it with manager.add().
import { PhysicsBody, boxesIntersect, rayBox } from './physics.js';
import { makeStack } from './inventory.js';
import {
  BLOCKS, BLOCK, ITEM, IS_SOLID, IS_LIQUID, IS_REPLACEABLE, RENDER_TYPE, RENDER, getCollisionBox, getDrops,
  getItem, maxStackSize, itemForBlock, canStay, LIQUID_KIND, liquidHeight,
} from '../world/registry.js';
import { PLAYER } from '../config.js';
import { MODEL_ID } from '../render/mobmodels.js';
import { playersOf } from './players.js';

const TICKS = 20;
const MAX_STEP = 1 / TICKS;               // physics sub-step (s)
const VOID_Y = -64;
/** Minecraft's water / lava current push per tick (Entity.updateFluidHeightAndDoFluidPushing). */
const WATER_PUSH = 0.014 * TICKS * TICKS;            // b/s² (5.6)
const LAVA_PUSH = 0.0023333333 * TICKS * TICKS;      // b/s² (0.93, overworld lava)

/**
 * Initial value of numeric fields that will hold fractional numbers (a "double zero"). V8 chooses a field's storage
 * from its first value: an integer 0 makes it a small-integer field that has to be rewritten on the first fractional
 * store (new hidden class, old one deprecated). When that happens while the renderer and the manager already look at
 * these objects, their property accesses go megamorphic and every read of a double field allocates — every frame.
 * Starting with -0 gives each object kind one stable hidden class.
 */
const DZ = -0;

// --- item entity (Minecraft ItemEntity) ---
export const ITEM_SIZE = 0.25;
export const ITEM_GRAVITY = 0.04 * TICKS * TICKS;   // 16 b/s²
export const ITEM_DESPAWN_TIME = 300;              // s (6000 ticks)
export const PICKUP_RADIUS = 1.5;                  // horizontal reach of the pickup (blocks)
export const PICKUP_VERTICAL = 0.5;                // player box grown by this much vertically
export const COLLECT_TIME = 3 / TICKS;             // pickup fly-in animation (ItemPickupParticle)
export const MERGE_RADIUS = 0.5;                   // box inflation (x/z) for stack merging
export const DEFAULT_PICKUP_DELAY = 0.5;
export const THROW_PICKUP_DELAY = 2;
const MERGE_INTERVAL = 40 / TICKS;
const MERGE_INTERVAL_MOVED = 2 / TICKS;
const FLOAT_DEPTH = ITEM_SIZE * 0.85 - 1 / 9;      // eye height - 0.111: submerged deeper -> floats
const BUOYANCY = 0.0005 * TICKS * TICKS;           // 0.2 b/s²
const BUOYANCY_MAX = 0.06 * TICKS;                 // only while rising slower than 1.2 b/s
const LAVA_BURN_TIME = 2 / TICKS;                  // health 5, lava hurts 4 per tick
const SLEEP_CHECK = 4 / TICKS;                     // resting items re-check their support every 4 ticks
const LN_AIR_DRAG = Math.log(0.98);

/** Upper bound of simultaneously existing item entities; the oldest are discarded beyond it. */
export const MAX_ITEM_ENTITIES = 6000;
/** Above this many items, new drops merge straight into the previous drop of the same item nearby. */
export const SOFT_ITEM_CAP = 2048;

// --- falling block / primed TNT ---
const BLOCK_ENTITY_SIZE = 0.98;
export const TNT_FUSE = 80 / TICKS;                // 4 s
export const TNT_POWER = 4;

// Ground friction by block id (Minecraft "friction"/slipperiness).
const SLIPPERINESS = new Float32Array(256).fill(0.6);
// Blocks that hurt entities touching them (cactus); items have 5 health -> destroyed after 5 hits.
const CONTACT_DAMAGE = new Uint8Array(256);
const CONTACT_KILL_TIME = 5 / TICKS;
// Blast resistance by block id (Minecraft values where they differ from the hardness).
const BLAST_RESISTANCE = new Float32Array(256);
for (const b of BLOCKS) {
  SLIPPERINESS[b.id] = b.slipperiness ?? 0.6;
  CONTACT_DAMAGE[b.id] = b.damage > 0 && !b.liquid ? 1 : 0;
  let r = b.hardness < 0 ? 3600000 : b.hardness;
  if (b.liquid) r = 100;
  else if (b.name === 'obsidian') r = 1200;
  else if (b.requiresTool && b.tool === 'pickaxe' && b.hardness >= 1.5 && !b.name.endsWith('_ore') &&
    b.name !== 'furnace' && !b.name.startsWith('furnace_') && b.name !== 'lapis_block') r = 6;
  else if (b.name === 'oak_planks' || b.name === 'birch_planks' || b.name === 'spruce_planks') r = 3;
  if (b.id === 0) r = 0;
  BLAST_RESISTANCE[b.id] = r;
}

let nextEntityId = 1;

/**
 * Small deterministic PRNG (mulberry32); used when no rng is supplied (tests pass their own). The state is
 * kept in a Uint32Array so V8 never boxes it (a closure variable above 2^30 would allocate per call).
 */
function mulberry32(seed) {
  const st = new Uint32Array(1);
  st[0] = seed >>> 0;
  return () => {
    const a = (st[0] + 0x6d2b79f5) | 0;
    st[0] = a;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) * 2.3283064365386963e-10;   // / 2^32
  };
}

function finite(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * False while the chunk under (x, z) is not loaded: entities there are frozen instead of falling
 * through the (air-reporting) unloaded terrain. Worlds without isChunkGenerated are always ready.
 */
function chunkReady(world, x, z) {
  return typeof world.isChunkGenerated !== 'function' || world.isChunkGenerated(Math.floor(x) >> 4, Math.floor(z) >> 4);
}

/**
 * Surface height (absolute y) of the liquid in cell (x, y, z) whose id is `id` (a liquid): the full cell when
 * the same liquid is above, else the Minecraft height of the level (source 8/9, flowing (8 - L)/9, falling 1).
 */
export function liquidSurface(world, x, y, z, id) {
  const above = y < 255 ? world.getBlock(x, y + 1, z) : 0;
  return y + (LIQUID_KIND[above] === LIQUID_KIND[id] ? 1 : liquidHeight(id));
}

const _flow = new Float64Array(3);
const _flowSum = new Float64Array(4);

/**
 * Minecraft fluid push for a body box: the flow vectors (world.fluids.flowVector) of the liquid cells of kind
 * `kind` overlapping the box are summed (scaled by depth when shallower than 0.4) and normalised. Writes the
 * direction into `out` ([x, y, z], zero when still) and returns true when there is a current.
 */
export function fluidFlow(world, b, kind, out) {
  out[0] = 0; out[1] = 0; out[2] = 0;
  const fluids = world.fluids;
  if (!fluids || typeof fluids.flowVector !== 'function') return false;
  const hw = b.width / 2 - 0.001;
  const x0 = Math.floor(b.x - hw), x1 = Math.floor(b.x + hw);
  const y0 = Math.floor(b.y + 0.001), y1 = Math.floor(b.y + b.height - 0.001);
  const z0 = Math.floor(b.z - hw), z1 = Math.floor(b.z + hw);
  const S = _flowSum;
  S[0] = 0; S[1] = 0; S[2] = 0; S[3] = 0;
  for (let y = y0; y <= y1; y++) {
    if (y < 0 || y > 255) continue;
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const id = world.getBlock(x, y, z);
        if (LIQUID_KIND[id] !== kind) continue;
        const depth = liquidSurface(world, x, y, z, id) - b.y;
        if (depth <= 0) continue;
        fluids.flowVector(x, y, z, _flow);
        const k = depth < 0.4 ? depth : 1;
        S[0] += _flow[0] * k; S[1] += _flow[1] * k; S[2] += _flow[2] * k; S[3]++;
      }
    }
  }
  if (S[3] === 0) return false;
  const len = Math.sqrt(S[0] * S[0] + S[1] * S[1] + S[2] * S[2]);
  if (!(len > 1e-9)) return false;
  out[0] = S[0] / len; out[1] = S[1] / len; out[2] = S[2] / len;
  return true;
}

/**
 * False while the chunk under (x, z) is not ready for simulation: meshed (light + neighbours known) when the
 * world reports meshing, else generated. Integer arguments.
 */
function chunkMeshed(world, bx, bz) {
  if (typeof world.isChunkMeshed === 'function') return world.isChunkMeshed(bx >> 4, bz >> 4);
  return typeof world.isChunkGenerated !== 'function' || world.isChunkGenerated(bx >> 4, bz >> 4);
}

/**
 * The shared shape of every 'model' EntityRenderItem (player avatar, mobs, arrows): one hidden class for all of
 * them (see DZ). Fields (SPEC-wave2 §3.4): model, modelId (render/mobmodels.js MODEL_ID), x y z, bodyYaw,
 * headYaw, headPitch, limbSwing, limbSwingAmount, attack, sneaking, age, hurt, death, light, itemId, shadowY,
 * shadow, shadowRadius, swell (creeper 0..1), onFire, sheared, aggressive (zombie arms up / skeleton and
 * player drawing a bow), eat (sheep eating ticks), flap (chicken wing angle), useTime (bow draw ticks), color
 * (fleece tint, -1 default), shake (arrow).
 */
export function createModelRenderItem(model) {
  const r = {
    kind: 'model', model, modelId: MODEL_ID[model] ?? -1, x: DZ, y: DZ, z: DZ, bodyYaw: DZ, headYaw: DZ,
    headPitch: DZ, limbSwing: DZ, limbSwingAmount: DZ, attack: DZ, sneaking: false, age: DZ, hurt: 0,
    death: DZ, light: 0xf0, itemId: 0, shadowY: NaN, shadow: DZ, shadowRadius: DZ, swell: DZ, onFire: 0,
    sheared: false, aggressive: false, eat: DZ, flap: DZ, useTime: DZ, color: -1, shake: DZ,
  };
  return r;
}

/** True if the cell's collision shape is not a full cube (entities can be pushed into it). */
function cellIsOpen(world, x, y, z) {
  const box = getCollisionBox(world.getBlock(x, y, z));
  return !box || box[0] > 0 || box[1] > 0 || box[2] > 0 || box[3] < 1 || box[4] < 1 || box[5] < 1;
}

/**
 * Shadow under an entity (Minecraft EntityRenderDispatcher.renderShadow): the top of the full block in
 * the cell under the feet or the one below that receives it; alpha = (strength - height / 2) · 0.5.
 * Writes { y, alpha } into `out` (alpha 0 = no shadow).
 */
function computeShadow(world, x, y, z, strength, out) {
  out.alpha = 0;
  out.y = NaN;
  if (!world || !(strength > 0)) return out;
  const bx = Math.floor(x), bz = Math.floor(z);
  let cy = Math.floor(y - 1e-3);
  for (let d = 0; d < 2; d++, cy--) {
    if (cy < 0 || cy > 255) return out;
    const box = getCollisionBox(world.getBlock(bx, cy, bz));
    if (!box) continue;
    if (box[0] > 0 || box[2] > 0 || box[3] < 1 || box[4] < 1 || box[5] < 1) return out;   // full blocks only
    const top = cy + 1;
    const a = (strength - (y - top) / 2) * 0.5;
    if (a > 0) {
      out.alpha = Math.min(1, a);
      out.y = top;
    }
    return out;
  }
  return out;
}

/** Diamond tool matching the block's tool type (explosions harvest like the right tool), else 0. */
function harvestToolFor(blockIdValue) {
  const b = BLOCKS[blockIdValue];
  if (!b || !b.requiresTool || !b.tool) return 0;
  return ITEM[`DIAMOND_${b.tool.toUpperCase()}`] ?? 0;
}

// ===================================================================================================
// Entity base class
// ===================================================================================================

/**
 * Base class of everything that lives in the EntityManager. Position = centre of the AABB bottom
 * (SPEC §4), kept in a PhysicsBody. Subclasses override update(), getRenderItem() and optionally
 * hurt() / onRemoved(). Set `blocksBuilding` for entities that block placing a block into their
 * space (mobs, primed TNT, falling blocks — not items, like Minecraft).
 */
export class Entity {
  /**
   * @param {number} width  AABB width (x/z)
   * @param {number} height AABB height
   */
  constructor(width, height) {
    this.id = nextEntityId++;
    /** @type {string} entity type key ('item', 'falling_block', 'tnt', ...) */
    this.type = 'entity';
    this.body = new PhysicsBody(width, height);
    /** Seconds since spawn. */
    this.age = DZ;
    this.removed = false;
    /** Packed light (sky << 4 | block) at the entity, refreshed every update. */
    this.light = 0xf0;
    this.blocksBuilding = false;
    /** Frozen (not updated) while the chunk under it is not meshed (mobs, arrows). */
    this.freezeUnmeshed = false;
    /** True while the manager skips the entity (its chunk is not ready). */
    this.frozen = false;
    /** Pushes / is pushed by other pushable entities (mobs). */
    this.pushable = false;
    /** Can be hit by raycastEntities without a filter (mobs). */
    this.pickable = false;
    /** Minecraft entity shadow: radius (0 = none) and strength. */
    this.shadowRadius = DZ;
    this.shadowStrength = DZ;   // double field (see DZ), then the real default
    this.shadowStrength = 1;
    /** Current shadow { y: top of the receiving block, alpha }, refreshed by updateShadow(). */
    this.shadow = { y: NaN, alpha: DZ };
    /** Set by EntityManager.add(). */
    this.manager = null;
  }

  get x() { return this.body.x; }
  set x(v) { this.body.x = v; }
  get y() { return this.body.y; }
  set y(v) { this.body.y = v; }
  get z() { return this.body.z; }
  set z(v) { this.body.z = v; }
  get vx() { return this.body.vx; }
  set vx(v) { this.body.vx = v; }
  get vy() { return this.body.vy; }
  set vy(v) { this.body.vy = v; }
  get vz() { return this.body.vz; }
  set vz(v) { this.body.vz = v; }
  get width() { return this.body.width; }
  get height() { return this.body.height; }
  get onGround() { return this.body.onGround; }

  setPosition(x, y, z) {
    this.body.setPosition(x, y, z);
    return this;
  }

  /** AABB {minX..maxZ} (written into `out`). */
  getAABB(out = {}) {
    return this.body.getAABB(out);
  }

  /** Per-frame update. `game` is the game facade (world, player, audio, particles). */
  update(dt, game) { // eslint-disable-line no-unused-vars
    this.age += dt;
  }

  /** Reused EntityRenderItem (SPEC §9.5) or null when nothing should be drawn. */
  getRenderItem() {
    return null;
  }

  /**
   * Damage from explosions etc. Returns true if the entity reacted. Base entities ignore it.
   * @param {number} amount half-hearts
   * @param {string} cause
   */
  hurt(amount, cause) { // eslint-disable-line no-unused-vars
    return false;
  }

  /** Add velocity (knockback). */
  push(vx, vy, vz) {
    this.body.vx += vx;
    this.body.vy += vy;
    this.body.vz += vz;
  }

  /** Mark for removal (the manager drops it at the end of its update). */
  remove() {
    if (this.removed) return;
    this.removed = true;
    this.onRemoved();
  }

  onRemoved() {}

  /** Sample the packed light at the entity (SPEC: floor(x), floor(y + 0.1), floor(z)). */
  updateLight(world) {
    if (world && typeof world.getLight === 'function') {
      const l = world.getLight(Math.floor(this.body.x), Math.floor(this.body.y + 0.1), Math.floor(this.body.z));
      this.light = finite(l) ? l & 255 : 0xf0;
    }
  }

  /** Recompute the shadow under the entity (see computeShadow). */
  updateShadow(world) {
    if (this.shadowRadius > 0) computeShadow(world, this.body.x, this.body.y, this.body.z, this.shadowStrength, this.shadow);
  }

  /** Copy the shadow into a render item (shadowY, shadow alpha, shadowRadius). */
  _renderShadow(r) {
    r.shadowY = this.shadow.y;
    r.shadow = this.shadow.alpha;
    r.shadowRadius = this.shadowRadius;
  }

  /** Plain-object snapshot for persistence (null = not persisted). */
  serialize() {
    return null;
  }
}

// ===================================================================================================
// ItemEntity
// ===================================================================================================

/** A dropped item stack (Minecraft ItemEntity). */
export class ItemEntity extends Entity {
  /**
   * @param {{id:number,count:number,damage?:number}} stack (copied)
   * @param {number} [seed] 0..1 bob/spin phase (random when omitted)
   */
  constructor(stack, seed = Math.random()) {
    super(ITEM_SIZE, ITEM_SIZE);
    this.type = 'item';
    this.kind = 'item';
    this.isItem = true;
    this.stack = { id: stack.id, count: stack.count, damage: stack.damage ?? 0 };
    // Fields that hold fractional numbers start as double fields (DZ, then the real value): see DZ.
    /** Seconds until players may pick it up. */
    this.pickupDelay = DZ;
    this.pickupDelay = DEFAULT_PICKUP_DELAY;
    this.seed = DZ;
    this.seed = seed;
    /** Pickup animation: target player (or null), elapsed time, start position. */
    this.collector = null;
    this.collectTime = DZ;
    this._cx = DZ; this._cy = DZ; this._cz = DZ;
    this._mergeTimer = DZ;
    this._mergeTimer = (this.id % 20) / TICKS;     // stagger merge checks
    this._mergeCell = 0;                           // small integer (see _mergeItems)
    this._sleep = DZ;
    this._lavaTime = DZ;
    this._contactTime = DZ;
    this._water = DZ;    // fluid depths above the feet
    this._lava = DZ;
    this._wasInWater = false;
    this._noPhysics = false;
    this._shadowValid = false;
    this.shadowRadius = 0.15;
    this.shadowStrength = 0.75;
    this._render = {
      kind: 'item', x: DZ, y: DZ, z: DZ, itemId: 0, count: 0, age: DZ, seed: DZ, light: 0xf0,
      shadowY: NaN, shadow: DZ, shadowRadius: 0.15,
    };
    this._render.seed = seed;
  }

  get itemId() { return this.stack.id; }
  get count() { return this.stack.count; }

  /** True while the pickup fly-in animation runs (no physics, cannot be picked up or merged). */
  get collecting() { return this.collector !== null; }

  getRenderItem() {
    const r = this._render;
    r.x = this.body.x; r.y = this.body.y; r.z = this.body.z;
    r.itemId = this.stack.id;
    r.count = this.stack.count;
    r.age = this.age;
    r.seed = this.seed;
    r.light = this.light;
    if (this.collector) r.shadow = 0;
    else this._renderShadow(r);
    return r;
  }

  hurt(amount) {
    // Minecraft: items have 5 health; explosions near them destroy them.
    if (amount >= 5 && !this.collecting) {
      this.remove();
      return true;
    }
    return false;
  }

  push(vx, vy, vz) {
    super.push(vx, vy, vz);
    this._sleep = 0;
  }

  /** Start the pickup fly-in toward `player`. */
  startCollect(player) {
    this.collector = player;
    this.collectTime = 0;
    this._cx = this.body.x; this._cy = this.body.y; this._cz = this.body.z;
    this.body.vx = this.body.vy = this.body.vz = 0;
  }

  update(dt, game) {
    this.age += dt;
    if (this.pickupDelay > 0) this.pickupDelay = Math.max(0, this.pickupDelay - dt);
    const b = this.body;
    if (this.collector) {
      // ItemPickupParticle: lerp toward the collector's (feet + eyes) / 2 with an ease-in (t²).
      this.collectTime += dt;
      const p = this.collector;
      const t = Math.min(1, this.collectTime / COLLECT_TIME);
      const f = t * t;
      const eye = finite(p.eyeHeight) ? p.eyeHeight : PLAYER.EYE_HEIGHT;
      const tx = finite(p.x) ? p.x : this._cx, ty = finite(p.y) ? p.y + eye / 2 : this._cy, tz = finite(p.z) ? p.z : this._cz;
      b.x = this._cx + (tx - this._cx) * f;
      b.y = this._cy + (ty - this._cy) * f;
      b.z = this._cz + (tz - this._cz) * f;
      if (t >= 1) this.remove();
      return;
    }
    if (this.age >= ITEM_DESPAWN_TIME) {
      this.remove();
      return;
    }
    const world = game?.world;
    if (world && this._chunkReady(world)) {
      // Resting items only re-check their support every few ticks (Minecraft moves on-ground items
      // without horizontal motion every 4th tick); an unchanged neighbourhood keeps them asleep cheaply.
      if (this._sleep > 0) {
        this._sleep -= dt;
        if (this._sleep <= 0) {
          if (this._stillResting(world)) {
            this._sleep = SLEEP_CHECK;
          } else {
            this._step(world, Math.min(dt, MAX_STEP), game);
            this._shadowValid = false;
          }
        }
      } else {
        let left = dt;
        while (left > 1e-9 && !this.removed) {
          const h = left > MAX_STEP ? MAX_STEP : left;
          left -= h;
          this._step(world, h, game);
          if (this._sleep > 0) break;
        }
        this._shadowValid = false;
      }
      if (this.removed) return;
      if (!this._shadowValid) {
        this.updateShadow(world);
        this._shadowValid = true;
      }
    }
    if (b.y < VOID_Y) {
      this.remove();
      return;
    }
    this.updateLight(world);
  }

  /** False while the item's chunk is not loaded (integer arguments only: no number boxing). */
  _chunkReady(world) {
    return typeof world.isChunkGenerated !== 'function' ||
      world.isChunkGenerated(Math.floor(this.body.x) >> 4, Math.floor(this.body.z) >> 4);
  }

  /**
   * Cheap re-check of a sleeping item: the cells it occupies are still empty and a collision box top is
   * still exactly under its feet. False means "run a physics step".
   */
  _stillResting(world) {
    const b = this.body;
    const hw = b.width / 2;
    const x0 = Math.floor(b.x - hw), x1 = Math.floor(b.x + hw);
    const z0 = Math.floor(b.z - hw), z1 = Math.floor(b.z + hw);
    const cy = Math.floor(b.y + 1e-4);
    if (Math.floor(b.y + b.height - 1e-4) !== cy) return false;
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) if (world.getBlock(x, cy, z) !== 0) return false;
    const sy = Math.floor(b.y - 1e-4);
    if (sy < 0) return false;
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const box = getCollisionBox(world.getBlock(x, sy, z));
        if (box && Math.abs(sy + box[4] - b.y) < 1e-6) return true;
      }
    }
    return false;
  }

  /** True if the item's box (shrunk by 1e-4) overlaps a collision box (reads the body: no boxed args). */
  _insideSolid(world) {
    const b = this.body;
    const hw = b.width / 2 - 1e-4;
    const minX = b.x - hw, maxX = b.x + hw, minZ = b.z - hw, maxZ = b.z + hw;
    const minY = b.y + 1e-4, maxY = b.y + b.height - 1e-4;
    const y0 = Math.max(0, Math.floor(minY)), y1 = Math.min(255, Math.floor(maxY));
    const x0 = Math.floor(minX), x1 = Math.floor(maxX), z0 = Math.floor(minZ), z1 = Math.floor(maxZ);
    for (let y = y0; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          const box = getCollisionBox(world.getBlock(x, y, z));
          if (box && x + box[3] > minX && x + box[0] < maxX && y + box[4] > minY && y + box[1] < maxY &&
              z + box[5] > minZ && z + box[2] < maxZ) return true;
        }
      }
    }
    return false;
  }

  /**
   * Depth of water / lava above the item's feet (0 = not in it) -> _water, _lava. Any water / lava level
   * (sources, flowing, falling) with its Minecraft surface height.
   */
  _updateFluids(world) {
    const b = this.body;
    const x = Math.floor(b.x), z = Math.floor(b.z);
    const y0 = Math.floor(b.y), y1 = Math.floor(b.y + b.height);
    let water = 0, lava = 0;
    for (let y = y0; y <= y1; y++) {
      const id = world.getBlock(x, y, z);
      const kind = LIQUID_KIND[id];
      if (kind === 0) continue;
      const top = liquidSurface(world, x, y, z, id) - b.y;
      if (kind === 1) { if (top > water) water = top; } else if (top > lava) lava = top;
    }
    this._water = water;
    this._lava = water > 0 ? 0 : lava;
  }

  _step(world, h, game) {
    const b = this.body;
    const k = h * TICKS;   // ticks in this sub-step

    // ---- fluids ----
    this._updateFluids(world);
    const water = this._water, lava = this._lava;
    if (water > 0 && !this._wasInWater && this.age > MAX_STEP) this._splash(game, b, world);
    this._wasInWater = water > 0;
    if (lava > 0) {
      this._lavaTime += h;
      if (this._lavaTime >= LAVA_BURN_TIME) {
        game?.particles?.spawnSmoke?.(b.x, b.y + 0.2, b.z, 6);
        this.remove();
        return;
      }
    } else {
      this._lavaTime = 0;
    }

    // ---- current (flowing liquids carry items along) ----
    if ((water > 0 || lava > 0) && fluidFlow(world, b, water > 0 ? 1 : 2, _flow)) {
      const push = (water > 0 ? WATER_PUSH : LAVA_PUSH) * h;
      b.vx += _flow[0] * push; b.vy += _flow[1] * push; b.vz += _flow[2] * push;
    }

    // ---- accelerations ----
    if (water > FLOAT_DEPTH || lava > FLOAT_DEPTH) {
      const hd = Math.pow(water > FLOAT_DEPTH ? 0.99 : 0.95, k);
      b.vx *= hd;
      b.vz *= hd;
      if (b.vy < BUOYANCY_MAX) b.vy += BUOYANCY * h;
    } else {
      b.vy -= ITEM_GRAVITY * h;
    }

    // ---- inside a solid block: drift toward the closest free side without collision ----
    this._noPhysics = this._insideSolid(world);
    if (this._noPhysics) {
      this._pushOut(world, game);
      b.x += b.vx * h; b.y += b.vy * h; b.z += b.vz * h;
      b.onGround = false;
    } else {
      b.move(world, b.vx * h, b.vy * h, b.vz * h);
    }

    // ---- cactus: Entity.checkInsideBlocks -> CactusBlock.entityInside hurts 1 per tick ----
    if (this._touchesDamagingBlock(world)) {
      this._contactTime += h;
      if (this._contactTime >= CONTACT_KILL_TIME) {
        this.remove();
        return;
      }
    } else {
      this._contactTime = 0;
    }

    // ---- drag / friction ----
    const air = Math.exp(LN_AIR_DRAG * k);
    let horiz = air;
    if (b.onGround) {
      const below = world.getBlock(Math.floor(b.x), Math.floor(b.y - 0.5000001), Math.floor(b.z));
      horiz = Math.pow(SLIPPERINESS[below] * 0.98, k);
    }
    b.vx *= horiz;
    b.vz *= horiz;
    b.vy *= air;
    if (b.onGround && b.vy < 0) b.vy *= -0.5;

    // ---- rest detection ----
    if (b.onGround && water <= 0 && lava <= 0 && !this._noPhysics && this._contactTime === 0 &&
        b.vx * b.vx + b.vz * b.vz < 1e-6 && Math.abs(b.vy) < 1e-3) {
      b.vx = 0; b.vz = 0; b.vy = 0;
      this._sleep = SLEEP_CHECK;
    } else {
      this._sleep = 0;
    }
  }

  /** True if the item's box (shrunk by 1e-7) overlaps the cell of a contact-damage block (cactus). */
  _touchesDamagingBlock(world) {
    const b = this.body;
    const hw = b.width / 2 - 1e-7;
    const x0 = Math.floor(b.x - hw), x1 = Math.floor(b.x + hw);
    const y0 = Math.floor(b.y + 1e-7), y1 = Math.floor(b.y + b.height - 1e-7);
    const z0 = Math.floor(b.z - hw), z1 = Math.floor(b.z + hw);
    for (let y = y0; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) if (CONTACT_DAMAGE[world.getBlock(x, y, z)]) return true;
      }
    }
    return false;
  }

  /** Entity.moveTowardsClosestSpace: choose N/S/W/E/Up, whichever free side is closest. */
  _pushOut(world, game) {
    const b = this.body;
    const cy = b.y + b.height / 2;
    const bx = Math.floor(b.x), by = Math.floor(cy), bz = Math.floor(b.z);
    const fx = b.x - bx, fy = cy - by, fz = b.z - bz;
    let best = 4, bestDist = Infinity;   // default: up
    // 0 north (-z), 1 south (+z), 2 west (-x), 3 east (+x), 4 up
    if (cellIsOpen(world, bx, by, bz - 1) && fz < bestDist) { bestDist = fz; best = 0; }
    if (cellIsOpen(world, bx, by, bz + 1) && 1 - fz < bestDist) { bestDist = 1 - fz; best = 1; }
    if (cellIsOpen(world, bx - 1, by, bz) && fx < bestDist) { bestDist = fx; best = 2; }
    if (cellIsOpen(world, bx + 1, by, bz) && 1 - fx < bestDist) { bestDist = 1 - fx; best = 3; }
    if (cellIsOpen(world, bx, by + 1, bz) && 1 - fy < bestDist) { bestDist = 1 - fy; best = 4; }
    const rnd = this.manager?.rng ?? game?.entities?.rng ?? Math.random;
    const speed = (rnd() * 0.2 + 0.1) * TICKS;
    b.vx *= 0.75; b.vy *= 0.75; b.vz *= 0.75;
    if (best === 0) b.vz = -speed;
    else if (best === 1) b.vz = speed;
    else if (best === 2) b.vx = -speed;
    else if (best === 3) b.vx = speed;
    else b.vy = speed;
  }

  _splash(game, b, world) {
    // Entity.doWaterSplashEffect (items use the 0.9 factor).
    const v = Math.sqrt(b.vx * b.vx * 0.2 + b.vy * b.vy + b.vz * b.vz * 0.2) / TICKS;
    const volume = Math.min(1, v * 0.9);
    if (volume < 0.1) return;
    const sx = Math.floor(b.x), sz = Math.floor(b.z);
    let sy = Math.floor(b.y);
    const wid = world.getBlock(sx, sy, sz);
    sy = LIQUID_KIND[wid] ? liquidSurface(world, sx, sy, sz, wid) : sy + 8 / 9;
    game?.particles?.spawnSplash?.(b.x, sy, b.z, b.width);
    game?.audio?.play?.('splash', { x: b.x, y: sy, z: b.z, volume: volume * 0.5 });
  }

  serialize() {
    if (this.collecting || this.removed) return null;
    const b = this.body;
    return {
      type: 'item', x: b.x, y: b.y, z: b.z, vx: b.vx, vy: b.vy, vz: b.vz,
      id: this.stack.id, count: this.stack.count, damage: this.stack.damage,
      age: this.age, pickupDelay: this.pickupDelay,
    };
  }
}

// ===================================================================================================
// FallingBlockEntity (sand / gravel / any block that should fall as an entity)
// ===================================================================================================

/** A block falling as an entity (Minecraft FallingBlockEntity). Lands in its cell or drops as an item. */
export class FallingBlockEntity extends Entity {
  /** @param {number} blockId */
  constructor(blockId) {
    super(BLOCK_ENTITY_SIZE, BLOCK_ENTITY_SIZE);
    this.type = 'falling_block';
    this.blockId = blockId;
    this.blocksBuilding = true;
    this.shadowRadius = 0.5;
    // same hidden class as PrimedTntEntity's render item (double fields, see DZ)
    this._render = {
      kind: 'block', blockId, x: DZ, y: DZ, z: DZ, scale: DZ, light: 0xf0, flash: DZ,
      shadowY: NaN, shadow: DZ, shadowRadius: 0.5,
    };
    this._render.scale = 1;
  }

  getRenderItem() {
    const r = this._render;
    r.blockId = this.blockId;
    r.x = this.body.x; r.y = this.body.y; r.z = this.body.z;
    r.light = this.light;
    this._renderShadow(r);
    return r;
  }

  update(dt, game) {
    this.age += dt;
    const world = game?.world;
    const b = this.body;
    if (!world || this.blockId === 0) {
      if (this.blockId === 0) this.remove();
      return;
    }
    if (!chunkReady(world, b.x, b.z)) return;
    let left = Math.min(dt, 0.25);
    while (left > 1e-9 && !this.removed) {
      const h = left > MAX_STEP ? MAX_STEP : left;
      left -= h;
      const k = h * TICKS;
      b.vy -= ITEM_GRAVITY * h;
      b.move(world, b.vx * h, b.vy * h, b.vz * h);
      const drag = Math.exp(LN_AIR_DRAG * k);
      b.vx *= drag; b.vy *= drag; b.vz *= drag;
      if (b.onGround) this._land(world, game);
      else if (b.y < VOID_Y || this.age > 30) this.remove();
    }
    if (!this.removed) {
      this.updateLight(world);
      this.updateShadow(world);
    }
  }

  _land(world, game) {
    const b = this.body;
    const x = Math.floor(b.x), y = Math.floor(b.y + 0.01), z = Math.floor(b.z);
    this.remove();
    const here = world.getBlock(x, y, z);
    const supported = canStay(this.blockId, (gx, gy, gz) => world.getBlock(gx, gy, gz), x, y, z);
    if (IS_REPLACEABLE[here] && supported && y >= 0 && y <= 255 && world.setBlock(x, y, z, this.blockId)) {
      const sound = BLOCKS[this.blockId]?.sound;
      if (sound) game?.audio?.playBlock?.('place', sound, x + 0.5, y + 0.5, z + 0.5);
      return;
    }
    // Could not be placed (lands on a torch, flower...): drop as an item.
    const itemId = itemForBlock(this.blockId);
    const mgr = this.manager ?? game?.entities;
    if (itemId) mgr?.spawnItem?.(makeStack(itemId, 1), b.x, b.y + 0.25, b.z);
  }

  serialize() {
    if (this.removed) return null;
    const b = this.body;
    return { type: 'falling_block', blockId: this.blockId, x: b.x, y: b.y, z: b.z, vx: b.vx, vy: b.vy, vz: b.vz };
  }
}

// ===================================================================================================
// PrimedTntEntity
// ===================================================================================================

/** Lit TNT (Minecraft PrimedTnt): hops, flashes, swells and explodes when the fuse runs out. */
export class PrimedTntEntity extends Entity {
  /** @param {number} fuse seconds */
  constructor(fuse = TNT_FUSE) {
    super(BLOCK_ENTITY_SIZE, BLOCK_ENTITY_SIZE);
    this.type = 'tnt';
    this.fuse = DZ;                                // double field (see DZ)
    this.fuse = fuse;
    this.power = TNT_POWER;
    this.blocksBuilding = true;
    this.shadowRadius = 0.5;
    this._render = {
      kind: 'block', blockId: BLOCK.TNT, x: DZ, y: DZ, z: DZ, scale: DZ, light: 0xf0, flash: DZ,
      shadowY: NaN, shadow: DZ, shadowRadius: 0.5,
    };
    this._render.scale = 1;
  }

  getRenderItem() {
    const r = this._render;
    r.x = this.body.x; r.y = this.body.y; r.z = this.body.z;
    r.light = this.light;
    this._renderShadow(r);
    // TntRenderer: swell during the last 10 ticks, white flash every other 5 ticks.
    const ticks = this.fuse * TICKS;
    let s = 1;
    if (ticks + 1 < 10) {
      let f = 1 - (ticks + 1) / 10;
      f = Math.min(1, Math.max(0, f));
      f *= f; f *= f;
      s = 1 + f * 0.3;
    }
    r.scale = s;
    // OverlayTexture "white" (u = 15): mix(white, colour, 0.25) -> 75 % white
    r.flash = Math.floor(ticks / 5) % 2 === 0 ? 0.75 : 0;
    return r;
  }

  update(dt, game) {
    this.age += dt;
    const world = game?.world;
    const b = this.body;
    if (world && chunkReady(world, b.x, b.z)) {
      let left = Math.min(dt, 0.25);
      while (left > 1e-9) {
        const h = left > MAX_STEP ? MAX_STEP : left;
        left -= h;
        const k = h * TICKS;
        b.vy -= ITEM_GRAVITY * h;
        b.move(world, b.vx * h, b.vy * h, b.vz * h);
        const drag = Math.exp(LN_AIR_DRAG * k);
        b.vx *= drag; b.vy *= drag; b.vz *= drag;
        if (b.onGround) {
          const f = Math.pow(0.7, k);
          b.vx *= f; b.vz *= f;
          if (b.vy < 0) b.vy *= -0.5;
        }
      }
      if (b.y < VOID_Y) {
        this.remove();
        return;
      }
      this.updateLight(world);
      this.updateShadow(world);
    }
    this.fuse -= dt;
    if (this.fuse <= 0) {
      this.remove();
      const mgr = this.manager ?? game?.entities;
      mgr?.explode?.(b.x, b.y + b.height / 16, b.z, this.power, { source: this });
    }
  }

  serialize() {
    if (this.removed) return null;
    const b = this.body;
    return { type: 'tnt', fuse: this.fuse, x: b.x, y: b.y, z: b.z, vx: b.vx, vy: b.vy, vz: b.vz };
  }
}

// ===================================================================================================
// Arrow (Minecraft AbstractArrow)
// ===================================================================================================

export const ARROW_GRAVITY = 0.05 * TICKS * TICKS;     // 20 b/s²
const LN_ARROW_DRAG = Math.log(0.99);
const LN_ARROW_WATER_DRAG = Math.log(0.6);
/** Seconds an arrow stays stuck in a block (1200 ticks). */
export const ARROW_GROUND_LIFE = 60;
/** Seconds after the shot during which the shooter cannot be hit by its own arrow. */
export const ARROW_SHOOTER_GRACE = 0.25;
const ARROW_SHAKE_TICKS = 7;
const ARROW_HIT_INFLATE = 0.3;                         // entity boxes grow by this much (ProjectileUtil)
const ARROW_MAX_FLIGHT = 120;                          // s: safety removal of arrows that never land

const _ray = { t: 0, face: 0 };
const _cell = new Int32Array(3);
const _seg = new Float64Array(4);                      // block hit: distance, face (DDA result)
const _arrowBox = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };

/**
 * First block collision box on the segment from (ox, oy, oz) along the unit direction (dx, dy, dz) within
 * `maxDist` (Minecraft ClipContext.Block.COLLIDER: plants, torches and liquids are passed). On a hit the cell
 * goes to _cell and the distance / face to _seg[0] / _seg[1]; returns true. Allocation-free voxel DDA.
 */
function segmentBlockHit(world, ox, oy, oz, dx, dy, dz, maxDist) {
  let x = Math.floor(ox), y = Math.floor(oy), z = Math.floor(oz);
  const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
  const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;
  const tdx = stepX ? Math.abs(1 / dx) : Infinity;
  const tdy = stepY ? Math.abs(1 / dy) : Infinity;
  const tdz = stepZ ? Math.abs(1 / dz) : Infinity;
  let tmx = stepX > 0 ? (x + 1 - ox) / dx : stepX < 0 ? (x - ox) / dx : Infinity;
  let tmy = stepY > 0 ? (y + 1 - oy) / dy : stepY < 0 ? (y - oy) / dy : Infinity;
  let tmz = stepZ > 0 ? (z + 1 - oz) / dz : stepZ < 0 ? (z - oz) / dz : Infinity;
  let t = 0;
  for (let guard = 0; guard < 64 && t <= maxDist; guard++) {
    if (y >= 0 && y < 256) {
      const box = getCollisionBox(world.getBlock(x, y, z));
      if (box && rayBox(ox, oy, oz, dx, dy, dz, x + box[0], y + box[1], z + box[2], x + box[3], y + box[4], z + box[5], _ray) &&
          _ray.t <= maxDist) {
        _cell[0] = x; _cell[1] = y; _cell[2] = z;
        _seg[0] = _ray.t; _seg[1] = _ray.face;
        return true;
      }
    }
    if (tmx < tmy) {
      if (tmx < tmz) { x += stepX; t = tmx; tmx += tdx; } else { z += stepZ; t = tmz; tmz += tdz; }
    } else if (tmy < tmz) {
      y += stepY; t = tmy; tmy += tdy;
    } else {
      z += stepZ; t = tmz; tmz += tdz;
    }
  }
  return false;
}

/**
 * Minecraft difficulty scaling of damage dealt to the player by mobs (Player.hurt with a source that scales
 * with difficulty): peaceful 0, easy min(a/2 + 1, a), normal a, hard a·1.5.
 */
export function scaleMobDamage(game, amount) {
  const d = game?.settings?.difficulty;
  if (d === 'peaceful') return 0;
  if (d === 'easy') return Math.min(amount / 2 + 1, amount);
  if (d === 'hard') return amount * 1.5;
  return amount;
}

/**
 * An arrow (Minecraft AbstractArrow): shot by the player's bow or a skeleton. Velocity in blocks/s; `yaw` /
 * `pitch` follow Minecraft's arrow rotation (yaw = atan2(vx, vz), pitch = atan2(vy, horizontal)).
 */
export class Arrow extends Entity {
  /**
   * @param {{ shooter?: object|null, damage?: number, critical?: boolean, pickup?: boolean }} [opts]
   *   damage = base damage (2 like Minecraft; hit damage = ceil(speed in b/tick · damage)); pickup = can be
   *   picked up from the ground (survival player shots)
   */
  constructor({ shooter = null, damage = 2, critical = false, pickup = false } = {}) {
    super(0.5, 0.5);
    this.type = 'arrow';
    this.isProjectile = true;
    this.freezeUnmeshed = true;
    this.shooter = shooter;
    this.shooterIsPlayer = !!shooter && shooter.type !== 'mob' && typeof shooter.inventory === 'object';
    this.baseDamage = DZ;
    this.baseDamage = finite(damage) && damage > 0 ? damage : 2;
    this.critical = !!critical;
    this.pickup = !!pickup;
    this.inGround = false;
    this.groundTime = DZ;
    /** Ticks of the impact shake left. */
    this.shake = DZ;
    this.yaw = DZ;
    this.pitch = DZ;
    this.stuckX = 0; this.stuckY = 0; this.stuckZ = 0; this.stuckId = 0;
    this._wasInWater = false;
    this._render = createModelRenderItem('arrow');
  }

  /** Set the velocity (b/s) and the matching rotation. */
  setVelocity(vx, vy, vz) {
    const b = this.body;
    b.vx = vx; b.vy = vy; b.vz = vz;
    this._orient();
    return this;
  }

  _orient() {
    const b = this.body;
    const hz = Math.sqrt(b.vx * b.vx + b.vz * b.vz);
    if (hz > 1e-9 || Math.abs(b.vy) > 1e-9) {
      this.yaw = Math.atan2(b.vx, b.vz);
      this.pitch = Math.atan2(b.vy, hz);
    }
  }

  getRenderItem() {
    const r = this._render;
    r.x = this.body.x; r.y = this.body.y; r.z = this.body.z;
    r.bodyYaw = this.yaw;
    r.headYaw = this.yaw;
    r.headPitch = this.pitch;
    r.shake = this.shake;
    r.light = this.light;
    r.age = this.age;
    r.shadow = 0;
    return r;
  }

  update(dt, game) {
    this.age += dt;
    const world = game?.world;
    if (!world) return;
    const b = this.body;
    if (this.shake > 0) this.shake = Math.max(0, this.shake - dt * TICKS);
    if (this.inGround) {
      if (world.getBlock(this.stuckX, this.stuckY, this.stuckZ) === this.stuckId) {
        this.groundTime += dt;
        if (this.groundTime >= ARROW_GROUND_LIFE) this.remove();
        return;
      }
      // the block it was stuck in is gone: fall (AbstractArrow.startFalling)
      const rnd = this.manager?.rng ?? Math.random;
      this.inGround = false;
      this.groundTime = 0;
      b.vx = (rnd() - 0.5) * 0.4; b.vy = 0; b.vz = (rnd() - 0.5) * 0.4;
    }
    let left = dt > 0.25 ? 0.25 : dt;
    while (left > 1e-9 && !this.removed && !this.inGround) {
      const h = left > MAX_STEP ? MAX_STEP : left;
      left -= h;
      this._step(world, h, game);
    }
    if (this.removed) return;
    if (b.y < VOID_Y || (!this.inGround && this.age > ARROW_MAX_FLIGHT)) {
      this.remove();
      return;
    }
    this.updateLight(world);
  }

  _step(world, h, game) {
    const b = this.body;
    const sx = b.vx * h, sy = b.vy * h, sz = b.vz * h;
    const len = Math.sqrt(sx * sx + sy * sy + sz * sz);
    if (len > 1e-9) {
      const dx = sx / len, dy = sy / len, dz = sz / len;
      // blocks first (the entity search is limited to the part of the segment before the block)
      const blockHit = segmentBlockHit(world, b.x, b.y, b.z, dx, dy, dz, len);
      const reach = blockHit ? _seg[0] : len;
      const blockT = _seg[0];
      const cx = _cell[0], cy = _cell[1], cz = _cell[2];
      const target = this._findTarget(game, dx, dy, dz, reach);
      if (target) {
        this._hitEntity(target, game);
        return;
      }
      if (blockHit) {
        this._stick(world, game, dx, dy, dz, blockT, cx, cy, cz);
        return;
      }
      b.x += sx; b.y += sy; b.z += sz;
      if (this.critical && game?.particles?.spawnCritTrail) game.particles.spawnCritTrail(b.x, b.y, b.z, -b.vx, -b.vy, -b.vz);
    }
    // water slows arrows down (and they leave bubbles)
    const id = world.getBlock(Math.floor(b.x), Math.floor(b.y), Math.floor(b.z));
    const inWater = LIQUID_KIND[id] === 1;
    if (inWater && !this._wasInWater) game?.audio?.play?.('splash', { x: b.x, y: b.y, z: b.z, volume: 0.3 });
    if (inWater && game?.particles?.spawnBubble && (this.manager?.rng ?? Math.random)() < h * TICKS) {
      game.particles.spawnBubble(b.x, b.y, b.z);
    }
    this._wasInWater = inWater;
    const k = h * TICKS;
    const drag = Math.exp((inWater ? LN_ARROW_WATER_DRAG : LN_ARROW_DRAG) * k);
    b.vx *= drag; b.vy *= drag; b.vz *= drag;
    b.vy -= ARROW_GRAVITY * h;
    this._orient();
  }

  /**
   * Closest entity hit along the unit direction within `reach` (boxes grown by 0.3): pickable living entities
   * and the player; the shooter only after ARROW_SHOOTER_GRACE. Returns the entity (or the player) or null.
   */
  _findTarget(game, dx, dy, dz, reach) {
    const b = this.body;
    const ox = b.x, oy = b.y, oz = b.z;
    let best = null, bestT = reach;
    const graceOver = this.age >= ARROW_SHOOTER_GRACE;
    const mgr = this.manager ?? game?.entities;
    const list = mgr?.list;
    const box = _arrowBox;
    const g = ARROW_HIT_INFLATE;
    if (list) {
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        if (e === this || e.removed || !e.pickable || e.dead || e.frozen) continue;
        if (e === this.shooter && !graceOver) continue;
        e.getAABB(box);
        if (rayBox(ox, oy, oz, dx, dy, dz, box.minX - g, box.minY - g, box.minZ - g, box.maxX + g, box.maxY + g, box.maxZ + g, _ray) &&
            _ray.t <= bestT) {
          bestT = _ray.t;
          best = e;
        }
      }
    }
    const players = playersOf(game);
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      if (!p || p.dead || (p === this.shooter && !graceOver) || !finite(p.x)) continue;
      const w = (finite(p.width) ? p.width : PLAYER.WIDTH) / 2, ph = finite(p.height) ? p.height : PLAYER.HEIGHT;
      if (rayBox(ox, oy, oz, dx, dy, dz, p.x - w - g, p.y - g, p.z - w - g, p.x + w + g, p.y + ph + g, p.z + w + g, _ray) &&
          _ray.t <= bestT) {
        bestT = _ray.t;
        best = p;
      }
    }
    return best;
  }

  /** Minecraft onHitEntity: damage = ceil(speed · base) (+ crit bonus); bounce back when it did not hurt. */
  _hitEntity(target, game) {
    const b = this.body;
    const rnd = this.manager?.rng ?? Math.random;
    const speed = Math.sqrt(b.vx * b.vx + b.vy * b.vy + b.vz * b.vz) / TICKS;
    let dmg = Math.ceil(Math.min(1e6, Math.max(0, speed * this.baseDamage)));
    if (this.critical) dmg += Math.floor(rnd() * (Math.floor(dmg / 2) + 2));
    let hurt = false;
    if (target === game?.player || target.isPlayer === true) {
      const scaled = this.shooter && this.shooter.type === 'mob' ? scaleMobDamage(game, dmg) : dmg;
      hurt = scaled > 0 && typeof target.damage === 'function' ? target.damage(scaled, 'arrow', undefined, this) !== false : false;
    } else if (typeof target.hurt === 'function') {
      hurt = target.hurt(dmg, 'arrow', this) !== false;
    }
    const pitch = 1.2 / (rnd() * 0.2 + 0.9);
    if (hurt) {
      game?.audio?.play?.('arrow_hit', { x: b.x, y: b.y, z: b.z, pitch });
      // the shooter's "successful hit" ding (the ART agent's arrow_hit_player)
      if (this.shooterIsPlayer && target !== this.shooter) game?.audio?.play?.('arrow_hit_player', { volume: 0.3, pitch: 0.5 });
      this.remove();
      return;
    }
    // Minecraft: deflected (invulnerable target) -> bounce back slowly and turn around
    b.vx *= -0.1; b.vy *= -0.1; b.vz *= -0.1;
    this.yaw += Math.PI;
    if (b.vx * b.vx + b.vy * b.vy + b.vz * b.vz < 1e-7 * TICKS * TICKS) this.remove();
  }

  /** Stick into the block hit at distance t along (dx, dy, dz): 0.05 back from the hit point, shake, sound. */
  _stick(world, game, dx, dy, dz, t, cx, cy, cz) {
    const b = this.body;
    const back = Math.max(0, t - 0.05);
    b.x += dx * back; b.y += dy * back; b.z += dz * back;
    this.inGround = true;
    this.groundTime = 0;
    this.shake = ARROW_SHAKE_TICKS;
    this.critical = false;
    this.stuckX = cx; this.stuckY = cy; this.stuckZ = cz;
    this.stuckId = world.getBlock(cx, cy, cz);
    b.vx = 0; b.vy = 0; b.vz = 0;
    const rnd = this.manager?.rng ?? Math.random;
    game?.audio?.play?.('arrow_hit', { x: b.x, y: b.y, z: b.z, pitch: 1.2 / (rnd() * 0.2 + 0.9) });
  }

  serialize() {
    if (this.removed) return null;
    const b = this.body;
    return {
      type: 'arrow', x: b.x, y: b.y, z: b.z, vx: b.vx, vy: b.vy, vz: b.vz, damage: this.baseDamage,
      critical: this.critical, pickup: this.pickup, inGround: this.inGround, groundTime: this.groundTime,
      stuck: [this.stuckX, this.stuckY, this.stuckZ, this.stuckId], yaw: this.yaw, pitch: this.pitch, age: this.age,
    };
  }
}

/**
 * Persistence of entity types defined outside this module (mobs.js registers 'mob'): fromJSON(manager, record)
 * -> Entity (not added yet) or null. Records of types not registered (yet) are kept and saved again, and
 * restored as soon as their type registers.
 */
const ENTITY_TYPES = new Map();
let entityTypesVersion = 0;

let mobModuleRequested = false;
/** Load mobs.js once (it registers the 'mob' type); entities.js never imports it statically (no cycle). */
function loadMobModule() {
  if (mobModuleRequested || ENTITY_TYPES.has('mob')) return;
  mobModuleRequested = true;
  import('./mobs.js').catch((err) => console.warn('[entities] mobs.js could not be loaded:', err?.message ?? err));
}

/** Register the deserializer of an entity type (see ENTITY_TYPES). */
export function registerEntityType(type, fromJSON) {
  if (typeof type !== 'string' || typeof fromJSON !== 'function') return;
  ENTITY_TYPES.set(type, fromJSON);
  entityTypesVersion++;
}

// ===================================================================================================
// PlayerAvatar: the local player as a 'model' render item (third-person views, F5)
// ===================================================================================================

const DEG = Math.PI / 180;
function wrapAngle(a) {
  a = (a + Math.PI) % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a - Math.PI;
}

/**
 * Animation state of the player's third-person model (Minecraft LivingEntity / WalkAnimationState):
 * limb swing from the horizontal distance walked, body yaw that follows the walking direction (backwards
 * walking keeps facing forward) and lags behind the head (max 75°, pulled along beyond 50°), idle arm sway.
 * Yaw / pitch use the SPEC §4 convention (radians, yaw 0 = north, + = turning left).
 */
export class PlayerAvatar {
  constructor() {
    // fractional fields start as double fields (see DZ)
    this.bodyYaw = NaN;
    this.limbSwing = DZ;
    this.limbSwingAmount = DZ;
    this.age = DZ;
    this.light = 0xf0;
    this.shadow = { y: NaN, alpha: DZ };
    this._lx = NaN;
    this._lz = NaN;
    this._render = createModelRenderItem('player');
    this._render.shadowRadius = 0.5;
  }

  /** Reset the motion history (teleports, respawn). */
  reset() {
    this._lx = NaN;
    this.bodyYaw = NaN;
    this.limbSwing = 0;
    this.limbSwingAmount = 0;
  }

  /**
   * Advance the animation by dt seconds. `player` needs x, y, z, yaw; `attacking` = the arm swings
   * (the body then turns to the head like Minecraft).
   */
  update(dt, player, world, attacking = false) {
    if (!player || !(dt > 0) || !finite(player.x) || !finite(player.z)) return;
    this.age += dt;
    const k = dt * TICKS;
    if (!finite(this._lx) || !finite(this.bodyYaw)) {
      this._lx = player.x; this._lz = player.z;
      this.bodyYaw = finite(player.yaw) ? player.yaw : 0;
    }
    const dx = player.x - this._lx, dz = player.z - this._lz;
    this._lx = player.x; this._lz = player.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist > 4 * k) {   // teleported: no animation burst
      this.limbSwingAmount = 0;
    } else {
      // WalkAnimationState.update: speed target = min(1, distance per tick · 4), eased 0.4 per tick
      const target = player.dead ? 0 : Math.min(1, (dist / k) * 4);
      this.limbSwingAmount += (target - this.limbSwingAmount) * (1 - Math.pow(0.6, k));
      this.limbSwing += this.limbSwingAmount * k;
    }
    // LivingEntity.tick body yaw target + tickHeadTurn
    const head = finite(player.yaw) ? player.yaw : 0;
    let targetBody = this.bodyYaw;
    if (dist * dist > 0.0025 * k * k && !player.dead) {
      const moveYaw = Math.atan2(-dx, -dz);
      const off = Math.abs(wrapAngle(head - moveYaw));
      targetBody = off > 95 * DEG ? moveYaw + Math.PI : moveYaw;
    }
    if (attacking) targetBody = head;
    this.bodyYaw += wrapAngle(targetBody - this.bodyYaw) * (1 - Math.pow(0.7, k));
    let rel = wrapAngle(head - this.bodyYaw);
    if (rel < -75 * DEG) rel = -75 * DEG;
    if (rel > 75 * DEG) rel = 75 * DEG;
    this.bodyYaw = head - rel;
    if (Math.abs(rel) > 50 * DEG) this.bodyYaw += rel * (1 - Math.pow(0.8, k));
    this.bodyYaw = wrapAngle(this.bodyYaw);
    if (world) {
      const eye = finite(player.eyeHeight) ? player.eyeHeight : PLAYER.EYE_HEIGHT;
      if (typeof world.getLight === 'function') {
        const l = world.getLight(Math.floor(player.x), Math.floor(player.y + eye), Math.floor(player.z));
        this.light = finite(l) ? l & 255 : 0xf0;
      }
      computeShadow(world, player.x, player.y, player.z, 1, this.shadow);
    }
  }

  /**
   * The player's 'model' EntityRenderItem (reused object). `hand` = interaction.getHandState() (held item
   * + swing progress), optional.
   */
  getRenderItem(player, hand = null) {
    const r = this._render;
    r.x = player.x; r.y = player.y; r.z = player.z;
    r.bodyYaw = finite(this.bodyYaw) ? this.bodyYaw : (player.yaw ?? 0);
    r.headYaw = player.yaw ?? 0;
    r.headPitch = player.pitch ?? 0;
    r.limbSwing = this.limbSwing;
    r.limbSwingAmount = this.limbSwingAmount;
    r.attack = hand && finite(hand.swing) ? hand.swing : 0;
    r.sneaking = !!player.sneaking && !player.flying;
    r.age = this.age;
    r.hurt = player.hurtTime > 0 || player.dead ? 1 : 0;
    r.death = player.dead && finite(player.deathTime) ? player.deathTime : 0;
    r.light = this.light;
    r.itemId = hand ? hand.itemId | 0 : (player.getSelectedStack?.()?.id ?? 0);
    r.shadowY = this.shadow.y;
    r.shadow = player.dead ? 0 : this.shadow.alpha;
    r.shadowRadius = 0.5;
    // drawing a bow: ArmPose.BOW_AND_ARROW + the pulling frames (player.usingItem / useTime, SURVIVAL)
    const drawing = player.usingItem === 'bow' || (!!hand && hand.useAction === 'bow');
    r.aggressive = drawing;
    const ut = finite(player.useTime) ? player.useTime : (hand && finite(hand.useTime) ? hand.useTime : 0);
    r.useTime = drawing ? Math.max(0.05, ut) * TICKS : 0;
    r.onFire = !player.dead && player.fireTime > 0 && !player.inWater ? 1 : 0;
    return r;
  }
}

// ===================================================================================================
// EntityManager
// ===================================================================================================

const HASH_SIZE = 4096;           // spatial hash buckets (power of two)
const HASH_MASK = HASH_SIZE - 1;
const hashCell = (x, z) => (Math.imul(x, 73856093) ^ Math.imul(z, 19349663)) & HASH_MASK;

/**
 * Owns every entity of the loaded world (SPEC §9.5). `game` provides world, player, audio, particles.
 */
export class EntityManager {
  /**
   * @param {object} game  game facade (world, player, audio, particles; read lazily)
   * @param {{ rng?: () => number }} [options]
   */
  constructor(game, options = {}) {
    this.game = game;
    /** Live entities in spawn order (removed ones are dropped at the end of update()). */
    this.list = [];
    /** Random source for physics decisions (pop velocities, explosion rays...). */
    this.rng = options.rng ?? mulberry32((Math.random() * 4294967296) >>> 0);
    this._itemCount = 0;
    this._evictFrom = 0;
    this._stormAnchors = new Map();   // coalescing targets of drop storms (cleared every update)
    // spatial hash of item entities (rebuilt every update, no allocations)
    this._head = new Int32Array(HASH_SIZE).fill(-1);
    this._next = new Int32Array(1024);
    this._hashed = [];             // entity per hash slot
    this._hashCount = 0;
    this._box = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };
    this._box2 = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };
    this._tmp = [];
    /** Third-person model of the local player (appended to the render list while game.perspective > 0). */
    this.avatar = new PlayerAvatar();
    this._handSwing = DZ;
    this._renderList = [];
    // wave 2: pushing, picking, persistence of registered types
    this._pushers = [];                    // pushable entities of this frame (count in _pusherCount)
    this._pusherCount = 0;
    this._rayHit = { entity: null, distance: DZ };
    this._pbox = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };
    /** Saved records of entity types that are not registered yet (kept, saved again, restored later). */
    this._unrestored = [];
    this._typesVersion = entityTypesVersion;
  }

  /** Alias of `list` (iterable of entities; interaction.js reads entities.entities). */
  get entities() {
    return this.list;
  }

  /** Number of live entities. */
  get count() {
    let n = 0;
    for (let i = 0; i < this.list.length; i++) if (!this.list[i].removed) n++;
    return n;
  }

  /** Add any Entity subclass. Returns it. */
  add(entity) {
    entity.manager = this;
    if (entity.type === 'item') {
      if (this._itemCount >= MAX_ITEM_ENTITIES) this._evictOldestItem();
      this._itemCount++;
    }
    this.list.push(entity);
    return entity;
  }

  _evictOldestItem() {
    // The cursor survives until the next compaction, so a spawn storm at the cap stays linear.
    for (let i = this._evictFrom; i < this.list.length; i++) {
      const e = this.list[i];
      if (e.type === 'item' && !e.removed && !e.collecting) {
        e.remove();
        this._itemCount--;
        this._evictFrom = i + 1;
        return;
      }
    }
  }

  /**
   * Spawn a dropped item (SPEC §9.5). Position = feet (centre of the box bottom). Without a velocity
   * the item pops like Minecraft's ItemEntity constructor: (±0.1, 0.2, ±0.1) blocks/tick.
   * @returns {ItemEntity|null}
   */
  spawnItem(stack, x, y, z, vx, vy, vz, pickupDelay = DEFAULT_PICKUP_DELAY) {
    if (!stack || !(stack.count > 0) || !getItem(stack.id)) return null;
    if (!finite(x) || !finite(y) || !finite(z)) return null;
    // Drop storms (/fill ... destroy, huge explosions): beyond the soft cap, drops of the same item in
    // the same 4x4x4 cell coalesce into one stack during this frame (nothing is lost, the count stays low).
    let stormKey = -1;
    const max = maxStackSize(stack.id);
    if (this._itemCount >= SOFT_ITEM_CAP && max > 1) {
      stormKey = ((stack.id * 1024 + (Math.floor(x / 4) & 1023)) * 128 + (Math.floor(y / 4) & 127)) * 1024 + (Math.floor(z / 4) & 1023);
      const a = this._stormAnchors.get(stormKey);
      if (a && !a.removed && !a.collecting && a.stack.damage === (stack.damage ?? 0) && a.stack.count + stack.count <= max) {
        a.stack.count += stack.count;
        return a;
      }
    }
    const rnd = this.rng;
    const e = new ItemEntity(stack, rnd());
    e.setPosition(x, y, z);
    if (finite(vx) && finite(vy) && finite(vz)) {
      e.body.vx = vx; e.body.vy = vy; e.body.vz = vz;
    } else {
      e.body.vx = (rnd() * 0.2 - 0.1) * TICKS;
      e.body.vy = 0.2 * TICKS;
      e.body.vz = (rnd() * 0.2 - 0.1) * TICKS;
    }
    e.pickupDelay = finite(pickupDelay) ? Math.max(0, pickupDelay) : DEFAULT_PICKUP_DELAY;
    e.updateLight(this.game?.world);
    e.updateShadow(this.game?.world);
    if (stormKey >= 0) this._stormAnchors.set(stormKey, e);
    return this.add(e);
  }

  /**
   * Minecraft Block.popResource: a drop from the block whose centre is (x, y, z), with a random
   * offset of ±0.25 and a small hop. Splits stacks larger than the max stack size.
   */
  popItem(itemId, count, x, y, z, pickupDelay = DEFAULT_PICKUP_DELAY) {
    const max = maxStackSize(itemId);
    let left = count | 0;
    let last = null;
    const rnd = this.rng;
    while (left > 0) {
      const n = Math.min(max, left);
      left -= n;
      last = this.spawnItem(makeStack(itemId, n),
        x + (rnd() - 0.5) * 0.5, y + (rnd() - 0.5) * 0.5 - ITEM_SIZE / 2, z + (rnd() - 0.5) * 0.5,
        undefined, undefined, undefined, pickupDelay) ?? last;
    }
    return last;
  }

  /**
   * Minecraft Player.drop: throw `stack` from the player's eyes along the look direction
   * (2 s pickup delay). Returns the ItemEntity or null.
   */
  dropFromPlayer(stack, player = this.game?.player) {
    if (!player) return null;
    const rnd = this.rng;
    const yaw = player.yaw ?? 0, pitch = player.pitch ?? 0;
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const a = rnd() * Math.PI * 2, f = 0.02 * rnd();
    const vx = (-Math.sin(yaw) * cp * 0.3 + Math.cos(a) * f) * TICKS;
    const vy = (sp * 0.3 + 0.1 + (rnd() - rnd()) * 0.1) * TICKS;
    const vz = (-Math.cos(yaw) * cp * 0.3 + Math.sin(a) * f) * TICKS;
    const eye = finite(player.eyeHeight) ? player.eyeHeight : PLAYER.EYE_HEIGHT;
    return this.spawnItem(stack, player.x, player.y + eye - 0.3, player.z, vx, vy, vz, THROW_PICKUP_DELAY);
  }

  /**
   * Spawn a falling block entity at the centre-bottom (x, y, z) (e.g. x + 0.5, y, z + 0.5 of the cell
   * it left). The caller removes the block from the world first.
   */
  spawnFallingBlock(blockId, x, y, z) {
    if (!BLOCKS[blockId] || blockId === 0) return null;
    const e = new FallingBlockEntity(blockId);
    e.setPosition(x, y, z);
    e.updateLight(this.game?.world);
    e.updateShadow(this.game?.world);
    return this.add(e);
  }

  /**
   * Spawn lit TNT at the centre-bottom (x, y, z) with Minecraft's random hop (the caller removes the
   * TNT block). `fuse` in seconds (default 4 s). `sound: false` skips the fuse hiss (chain reactions).
   */
  spawnPrimedTnt(x, y, z, fuse = TNT_FUSE, { sound = true } = {}) {
    if (!finite(x) || !finite(y) || !finite(z)) return null;
    const e = new PrimedTntEntity(finite(fuse) ? fuse : TNT_FUSE);
    const a = this.rng() * Math.PI * 2;
    e.setPosition(x, y, z);
    e.body.vx = -Math.sin(a) * 0.02 * TICKS;
    e.body.vy = 0.2 * TICKS;
    e.body.vz = -Math.cos(a) * 0.02 * TICKS;
    e.updateLight(this.game?.world);
    e.updateShadow(this.game?.world);
    if (sound) this.game?.audio?.play?.('fuse', { x, y: y + 0.5, z, volume: 1, pitch: 1 });
    return this.add(e);
  }

  /** Per-frame update: physics, pickup, merging, despawn (SPEC §9.5). */
  update(dt) {
    if (!(dt > 0)) return;
    // Clamp without arithmetic: in the common case the caller's number is passed on unchanged to every
    // entity.update() call (a freshly computed value would be boxed again for each call).
    if (dt > 0.25) dt = 0.25;
    const game = this.game;
    const list = this.list;
    const world = game?.world;
    if (this._unrestored.length > 0 && this._typesVersion !== entityTypesVersion) this._retryUnrestored();
    const n = list.length;
    for (let i = 0; i < n; i++) {
      const e = list[i];
      if (e.removed) continue;
      try {
        if (e.freezeUnmeshed && world && !chunkMeshed(world, Math.floor(e.body.x), Math.floor(e.body.z))) {
          // the terrain under it is not there yet (or unloaded): keep it where it is
          e.frozen = true;
          if (typeof e.updateFrozen === 'function') e.updateFrozen(dt, game);
          continue;
        }
        e.frozen = false;
        e.update(dt, game);
      } catch (err) {
        console.error('[entities] update failed, removing entity', e.type, err);
        e.remove();
      }
    }
    const players = playersOf(game);
    this._pushEntities(dt, players);
    this._buildHash();
    this._mergeItems(dt);
    for (let i = 0; i < players.length; i++) {
      this._pickup(players[i]);
      this._pickupArrows(players[i]);
    }
    this._compact();
    if (game?.player) this.avatar.update(dt, game.player, game.world, this._handSwing > 0);
  }

  // ---------------------------------------------------------------------------------------------
  // Spatial hash (items only)
  // ---------------------------------------------------------------------------------------------

  _buildHash() {
    this._head.fill(-1);
    const list = this.list;
    let n = 0;
    const hashed = this._hashed;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e.removed || e.type !== 'item' || e.collecting) continue;
      if (n >= this._next.length) {
        const grown = new Int32Array(this._next.length * 2);
        grown.set(this._next);
        this._next = grown;
      }
      const h = hashCell(Math.floor(e.body.x), Math.floor(e.body.z));
      this._next[n] = this._head[h];
      this._head[h] = n;
      hashed[n] = e;
      n++;
    }
    for (let i = n; i < this._hashCount; i++) hashed[i] = null;
    this._hashCount = n;
  }

  // ---------------------------------------------------------------------------------------------
  // Merging (ItemEntity.mergeWithNeighbours)
  // ---------------------------------------------------------------------------------------------

  _mergeItems(dt) {
    const hashed = this._hashed;
    for (let i = 0; i < this._hashCount; i++) {
      const e = hashed[i];
      if (!e || e.removed || e.collecting) continue;
      // block-cell key for change detection only (30 bits: always a small integer, collisions are harmless)
      const cell = ((Math.floor(e.body.x) * 31 + Math.floor(e.body.y)) * 31 + Math.floor(e.body.z)) & 0x3fffffff;
      const moved = cell !== e._mergeCell;
      e._mergeCell = cell;
      e._mergeTimer -= dt;
      if (moved && e._mergeTimer > MERGE_INTERVAL_MOVED) e._mergeTimer = MERGE_INTERVAL_MOVED;
      if (e._mergeTimer > 0) continue;
      e._mergeTimer = MERGE_INTERVAL;
      this._tryMerge(e);
    }
  }

  _tryMerge(e) {
    const s = e.stack;
    const max = maxStackSize(s.id);
    if (s.count >= max || e.age >= ITEM_DESPAWN_TIME) return;
    const box = e.getAABB(this._box);
    box.minX -= MERGE_RADIUS; box.maxX += MERGE_RADIUS;
    box.minZ -= MERGE_RADIUS; box.maxZ += MERGE_RADIUS;
    const ob = this._box2;
    const cx = Math.floor(e.body.x), cz = Math.floor(e.body.z);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        for (let j = this._head[hashCell(cx + dx, cz + dz)]; j >= 0; j = this._next[j]) {
          const o = this._hashed[j];
          if (!o || o === e || o.removed || o.collecting) continue;
          const t = o.stack;
          if (t.id !== s.id || (t.damage ?? 0) !== (s.damage ?? 0) || t.count + s.count > max) continue;
          if (!boxesIntersect(box, o.getAABB(ob))) continue;
          // The larger stack absorbs the smaller one (ItemEntity.tryToMerge).
          const keep = t.count > s.count ? o : e;
          const gone = keep === e ? o : e;
          keep.stack.count += gone.stack.count;
          keep.pickupDelay = Math.max(keep.pickupDelay, gone.pickupDelay);
          keep.age = Math.min(keep.age, gone.age);
          gone.stack.count = 0;
          gone.remove();
          this._itemCount--;
          if (gone === e) return;
          if (keep.stack.count >= max) return;
        }
      }
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Pickup (ItemEntity.playerTouch)
  // ---------------------------------------------------------------------------------------------

  _pickup(player) {
    if (!player || player.dead || !player.inventory || typeof player.inventory.add !== 'function') return;
    const px = player.x, py = player.y, pz = player.z;
    if (!finite(px) || !finite(py) || !finite(pz)) return;
    const height = finite(player.height) ? player.height : PLAYER.HEIGHT;
    const r2 = PICKUP_RADIUS * PICKUP_RADIUS;
    const yMin = py - PICKUP_VERTICAL, yMax = py + height + PICKUP_VERTICAL;
    const creative = player.mode === 'creative';
    const hashed = this._hashed;
    let popped = false;
    for (let i = 0; i < this._hashCount; i++) {
      const e = hashed[i];
      if (!e || e.removed || e.collecting || e.pickupDelay > 0) continue;
      const b = e.body;
      const dx = b.x - px, dz = b.z - pz;
      if (dx * dx + dz * dz > r2 || b.y + b.height < yMin || b.y > yMax) continue;
      const s = e.stack;
      const before = s.count;
      let left = player.inventory.add(s);
      if (!finite(left)) left = before;
      left = Math.max(0, Math.min(before, left | 0));
      if (left === before && creative) left = 0;    // Minecraft: creative swallows what does not fit
      const taken = before - left;
      if (taken <= 0) continue;
      if (left === 0) {
        e.startCollect(player);
      } else {
        // Partial pickup: the rest stays; a ghost copy of the taken part flies to the player.
        s.count = left;
        const ghost = new ItemEntity({ id: s.id, count: taken, damage: s.damage }, e.seed);
        ghost.setPosition(b.x, b.y, b.z);
        ghost.age = e.age;
        ghost.light = e.light;
        ghost.startCollect(player);
        this.add(ghost);
      }
      if (!popped) {
        popped = true;
        const rnd = this.rng;
        const pitch = Math.min(2, Math.max(0.5, ((rnd() - rnd()) * 0.7 + 1) * 2));
        this.game?.audio?.play?.('pop', { x: b.x, y: b.y, z: b.z, volume: 0.2, pitch });
      }
    }
  }

  _compact() {
    const list = this.list;
    let w = 0;
    let items = 0;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e.removed) continue;
      if (e.type === 'item') items++;
      list[w++] = e;
    }
    list.length = w;
    this._itemCount = items;
    this._evictFrom = 0;
    if (this._stormAnchors.size > 0) this._stormAnchors.clear();
  }

  // ---------------------------------------------------------------------------------------------
  // Wave 2: arrows, picking, counting, pushing
  // ---------------------------------------------------------------------------------------------

  /**
   * Spawn an arrow (SPEC-wave2 §3.4) at (x, y, z) with velocity (vx, vy, vz) in blocks/s.
   * @param {{ shooter?: object|null, damage?: number, critical?: boolean, pickup?: boolean }} [opts]
   * @returns {Arrow|null}
   */
  spawnArrow(x, y, z, vx, vy, vz, { shooter = null, damage = 2, critical = false, pickup = false } = {}) {
    if (!finite(x) || !finite(y) || !finite(z)) return null;
    const a = new Arrow({ shooter, damage, critical, pickup });
    a.setPosition(x, y, z);
    a.setVelocity(finite(vx) ? vx : 0, finite(vy) ? vy : 0, finite(vz) ? vz : 0);
    a.updateLight(this.game?.world);
    return this.add(a);
  }

  /**
   * Closest entity whose box (grown by its `pickRadius`, default 0) the ray from (ox, oy, oz) along (dx, dy, dz)
   * enters within maxDist. Default candidates: `pickable` entities that are not dead; `filter(e)` replaces that
   * test, `exclude` is skipped. Returns a reused { entity, distance } or null.
   */
  raycastEntities(ox, oy, oz, dx, dy, dz, maxDist, opts) {
    const exclude = opts?.exclude ?? null;
    const filter = typeof opts?.filter === 'function' ? opts.filter : null;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (!(len > 0) || !(maxDist > 0) || !finite(ox) || !finite(oy) || !finite(oz)) return null;
    const ux = dx / len, uy = dy / len, uz = dz / len;
    const list = this.list;
    const box = this._box2;
    let best = null, bestT = maxDist;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e.removed || e === exclude) continue;
      if (filter ? !filter(e) : (!e.pickable || e.dead)) continue;
      e.getAABB(box);
      const g = finite(e.pickRadius) ? e.pickRadius : 0;
      if (rayBox(ox, oy, oz, ux, uy, uz, box.minX - g, box.minY - g, box.minZ - g, box.maxX + g, box.maxY + g, box.maxZ + g, _ray) &&
          _ray.t <= bestT) {
        bestT = _ray.t;
        best = e;
      }
    }
    if (!best) return null;
    this._rayHit.entity = best;
    this._rayHit.distance = bestT;
    return this._rayHit;
  }

  /**
   * Number of live entities matching `predicate` — a function(e), an entity type ('mob', 'item', 'arrow'), a
   * mob type ('zombie'…) or null for all — within `radius` blocks (horizontal) of (x, z) when given.
   */
  countEntities(predicate, x, z, radius) {
    const list = this.list;
    const fn = typeof predicate === 'function' ? predicate : null;
    const name = typeof predicate === 'string' ? predicate : null;
    const r2 = finite(radius) && finite(x) && finite(z) ? radius * radius : -1;
    let n = 0;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e.removed) continue;
      if (fn ? !fn(e) : name !== null && e.type !== name && e.mobType !== name) continue;
      if (r2 >= 0) {
        const ddx = e.body.x - x, ddz = e.body.z - z;
        if (ddx * ddx + ddz * ddz > r2) continue;
      }
      n++;
    }
    return n;
  }

  /**
   * Entity.push between overlapping pushable entities (mobs) and between them and the player: each pair is
   * pushed apart by 0.05 b/tick · min(1, 1/√d) per tick along the larger horizontal axis distance d.
   */
  _pushEntities(dt, players) {
    const list = this.list;
    const P = this._pushers;
    let n = 0;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e.removed || !e.pushable || e.frozen || e.dead) continue;
      P[n++] = e;
    }
    for (let i = n; i < this._pusherCount; i++) P[i] = null;
    this._pusherCount = n;
    if (n === 0) return;
    const k = 0.05 * TICKS * dt * TICKS;     // b/s added per frame for a unit push
    for (let i = 0; i < n; i++) {
      const a = P[i].body;
      const ahw = a.width / 2;
      for (let j = i + 1; j < n; j++) {
        const b = P[j].body;
        const bhw = b.width / 2;
        const dx = b.x - a.x, dz = b.z - a.z;
        if (Math.abs(dx) >= ahw + bhw || Math.abs(dz) >= ahw + bhw) continue;
        if (b.y >= a.y + a.height || a.y >= b.y + b.height) continue;
        this._pushPair(a, b, dx, dz, k);
      }
    }
    // A single player may be passed instead of the list (older callers / tests).
    if (players && !Array.isArray(players)) players = [players];
    const np = players ? players.length : 0;
    for (let q = 0; q < np; q++) {
      const player = players[q];
      if (!player || player.dead || (player.flying && player.mode === 'creative') || !finite(player.x)) continue;
      const pw = (finite(player.width) ? player.width : PLAYER.WIDTH) / 2;
      const ph = finite(player.height) ? player.height : PLAYER.HEIGHT;
      for (let i = 0; i < n; i++) {
        const a = P[i].body;
        const ahw = a.width / 2;
        const dx = player.x - a.x, dz = player.z - a.z;
        if (Math.abs(dx) >= ahw + pw || Math.abs(dz) >= ahw + pw) continue;
        if (player.y >= a.y + a.height || a.y >= player.y + ph) continue;
        let d = Math.max(Math.abs(dx), Math.abs(dz));
        if (d < 0.01) continue;
        d = Math.sqrt(d);
        const f = Math.min(1, 1 / d) * k / d;
        a.vx -= dx * f; a.vz -= dz * f;
        if (player.mode !== 'creative') { player.vx += dx * f; player.vz += dz * f; }
      }
    }
  }

  _pushPair(a, b, dx, dz, k) {
    let d = Math.max(Math.abs(dx), Math.abs(dz));
    if (d < 0.01) {
      // exactly on top of each other: a tiny random nudge (Minecraft's spawn-in-place case)
      const rnd = this.rng;
      dx = rnd() - 0.5; dz = rnd() - 0.5;
      d = 0.1;
    }
    d = Math.sqrt(d);
    const f = Math.min(1, 1 / d) * k / d;
    a.vx -= dx * f; a.vz -= dz * f;
    b.vx += dx * f; b.vz += dz * f;
  }

  /**
   * Player touching arrows lying in the ground (AbstractArrow.playerTouch, player box grown by (1, 0.5, 1)):
   * survival-shot arrows go into the inventory (fly-in animation + pop), creative shots just vanish for a
   * creative player; skeleton arrows stay.
   */
  _pickupArrows(player) {
    if (!player || player.dead || !finite(player.x)) return;
    const list = this.list;
    const pw = (finite(player.width) ? player.width : PLAYER.WIDTH) / 2 + 1;
    const ph = finite(player.height) ? player.height : PLAYER.HEIGHT;
    const creative = player.mode === 'creative';
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (a.removed || a.type !== 'arrow' || !a.inGround || a.shake > 0) continue;
      const b = a.body;
      if (Math.abs(b.x - player.x) > pw + 0.25 || Math.abs(b.z - player.z) > pw + 0.25) continue;
      if (b.y + 0.5 < player.y - 0.5 || b.y > player.y + ph + 0.5) continue;
      if (a.pickup) {
        const inv = player.inventory;
        let left = inv && typeof inv.add === 'function' ? inv.add(makeStack(ITEM.ARROW, 1)) : 1;
        if (!finite(left)) left = 1;
        if (left > 0 && !creative) continue;      // no room
        const ghost = new ItemEntity({ id: ITEM.ARROW, count: 1 }, 0.5);
        ghost.setPosition(b.x, b.y, b.z);
        ghost.light = a.light;
        ghost.startCollect(player);
        this.add(ghost);
        const rnd = this.rng;
        this.game?.audio?.play?.('pop', { x: b.x, y: b.y, z: b.z, volume: 0.2, pitch: Math.min(2, Math.max(0.5, ((rnd() - rnd()) * 0.7 + 1) * 2)) });
        a.remove();
      } else if (creative && a.shooterIsPlayer) {
        a.remove();
      }
    }
  }

  /** Restore saved records whose type has been registered since they were loaded. */
  _retryUnrestored() {
    this._typesVersion = entityTypesVersion;
    const pending = this._unrestored;
    this._unrestored = [];
    this.deserialize(pending);
  }

  // ---------------------------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------------------------

  /**
   * EntityRenderItems of every visible entity (SPEC §9.5). While the camera is in a third-person view
   * (`game.perspective > 0`, F5) the local player's 'model' item is included too.
   *  - `getRenderList(out)` appends to `out` (SPEC form).
   *  - `getRenderList()` refills and returns a manager-owned array without shrinking it to 0 first, which
   *    is allocation-free (`arr.length = 0` + push makes V8 regrow the backing store every frame).
   */
  getRenderList(out) {
    const own = out === undefined;
    const dst = own ? this._renderList : out;
    let n = own ? 0 : dst.length;
    const list = this.list;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e.removed || e.frozen) continue;     // frozen = its chunk is not meshed (nothing to see there)
      const r = e.getRenderItem();
      if (r) dst[n++] = r;
    }
    const game = this.game;
    const player = game?.player;
    if (player && game.perspective > 0) {
      const hand = typeof game.interaction?.getHandState === 'function' ? game.interaction.getHandState() : null;
      this._handSwing = hand && finite(hand.swing) ? hand.swing : 0;
      dst[n++] = this.avatar.getRenderItem(player, hand);
    } else {
      this._handSwing = 0;
    }
    if (dst.length !== n) dst.length = n;
    return dst;
  }

  /**
   * True if an entity that blocks building (mobs, TNT, falling blocks — not items) intersects `box`
   * ({minX..maxZ}). Used by block placement.
   */
  anyEntityInBox(box) {
    const list = this.list;
    const eb = this._box2;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e.removed || !e.blocksBuilding) continue;
      if (boxesIntersect(e.getAABB(eb), box)) return true;
    }
    return false;
  }

  /**
   * Entities whose AABB intersects `box`, appended to `out`. `filter(e)` (optional) selects.
   */
  getEntitiesInBox(box, out = [], filter = null) {
    const list = this.list;
    const eb = this._box2;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e.removed) continue;
      if (filter && !filter(e)) continue;
      if (boxesIntersect(e.getAABB(eb), box)) out.push(e);
    }
    return out;
  }

  /** Remove every entity. */
  clear() {
    for (const e of this.list) {
      if (!e.removed) {
        e.removed = true;
        e.onRemoved();
      }
    }
    this.list.length = 0;
    this._itemCount = 0;
    this._evictFrom = 0;
    this._stormAnchors.clear();
    this._hashed.fill(null);
    this._hashCount = 0;
    this._pushers.fill(null);
    this._pusherCount = 0;
    this._unrestored.length = 0;
    this._rayHit.entity = null;
  }

  /**
   * Snapshot of persistent entities (items, falling blocks, TNT, arrows, mobs and any registered type) plus
   * records of types that are not registered yet (kept as they were loaded).
   */
  serialize() {
    const out = [];
    for (const e of this.list) {
      let s = null;
      try {
        s = e.removed ? null : e.serialize();
      } catch (err) {
        console.error('[entities] serialize failed', e.type, err);
      }
      if (s) out.push(s);
    }
    for (const s of this._unrestored) out.push(s);
    return out;
  }

  /** Restore entities from serialize() output (appends). */
  deserialize(arr) {
    if (!Array.isArray(arr)) return;
    for (const s of arr) {
      if (!s || !finite(s.x) || !finite(s.y) || !finite(s.z)) continue;
      let e = null;
      if (s.type === 'item') {
        e = this.spawnItem({ id: s.id, count: s.count, damage: s.damage ?? 0 }, s.x, s.y, s.z,
          s.vx ?? 0, s.vy ?? 0, s.vz ?? 0, s.pickupDelay ?? 0);
        if (e && finite(s.age)) e.age = s.age;
      } else if (s.type === 'falling_block') {
        e = this.spawnFallingBlock(s.blockId, s.x, s.y, s.z);
      } else if (s.type === 'tnt') {
        e = this.add(new PrimedTntEntity(finite(s.fuse) ? s.fuse : TNT_FUSE)).setPosition(s.x, s.y, s.z);
      } else if (s.type === 'arrow') {
        e = this._restoreArrow(s);
        continue;
      } else if (ENTITY_TYPES.has(s.type)) {
        try {
          const made = ENTITY_TYPES.get(s.type)(this, s);
          if (made && !made.removed) this.add(made);
        } catch (err) {
          console.error('[entities] restoring a saved entity failed', s.type, err);
        }
        continue;
      } else if (typeof s.type === 'string' && s.type !== 'item' && s.type !== 'falling_block') {
        // e.g. a mob saved while mobs.js is not loaded yet: keep it, load mobs.js (it registers 'mob'), retry
        if (this._unrestored.length < 4096) this._unrestored.push(s);
        if (s.type === 'mob') loadMobModule();
        continue;
      }
      if (e && s.type !== 'item') {
        e.body.vx = s.vx ?? 0; e.body.vy = s.vy ?? 0; e.body.vz = s.vz ?? 0;
      }
    }
  }

  _restoreArrow(s) {
    const a = new Arrow({ damage: s.damage, critical: !!s.critical, pickup: !!s.pickup });
    a.setPosition(s.x, s.y, s.z);
    a.setVelocity(finite(s.vx) ? s.vx : 0, finite(s.vy) ? s.vy : 0, finite(s.vz) ? s.vz : 0);
    if (finite(s.yaw)) a.yaw = s.yaw;
    if (finite(s.pitch)) a.pitch = s.pitch;
    if (finite(s.age)) a.age = s.age;
    if (s.inGround && Array.isArray(s.stuck) && s.stuck.length === 4 && s.stuck.every(finite)) {
      a.inGround = true;
      a.groundTime = finite(s.groundTime) ? s.groundTime : 0;
      [a.stuckX, a.stuckY, a.stuckZ, a.stuckId] = s.stuck;
      a.body.vx = 0; a.body.vy = 0; a.body.vz = 0;
    }
    a.updateLight(this.game?.world);
    return this.add(a);
  }

  // ---------------------------------------------------------------------------------------------
  // Explosions (Minecraft Explosion)
  // ---------------------------------------------------------------------------------------------

  /**
   * Explode at (x, y, z) with Minecraft's algorithm: 16³ surface rays losing (resistance + 0.3) · 0.3
   * per 0.3-block step, blocks reached with positive intensity are destroyed (drops with chance
   * 1/power, TNT gets primed with a 0.5–1.5 s fuse), entities and the player within 2·power take
   * exposure-scaled damage and knockback; items close to the centre are destroyed.
   * @param {{ breakBlocks?: boolean, source?: Entity|null, dropChance?: number }} [opts]
   * @returns {number} number of destroyed blocks
   */
  explode(x, y, z, power = TNT_POWER, { breakBlocks = true, source = null, dropChance, attacker = null } = {}) {
    // the entity responsible (a creeper explodes itself: its own source) -> death message, damage scaling
    const causer = attacker ?? (source && source.type === 'mob' ? source : null);
    const game = this.game;
    const world = game?.world;
    const rnd = this.rng;
    game?.audio?.play?.('explode', { x, y, z, volume: 4, pitch: (1 + (rnd() - rnd()) * 0.2) * 0.7 });
    game?.particles?.spawnExplosion?.(x, y, z, power);
    if (!world) return 0;

    // ---- blocks ----
    const destroyed = new Map();    // key -> [bx, by, bz, id]
    if (breakBlocks) {
      for (let j = 0; j < 16; j++) {
        for (let k = 0; k < 16; k++) {
          for (let l = 0; l < 16; l++) {
            if (j !== 0 && j !== 15 && k !== 0 && k !== 15 && l !== 0 && l !== 15) continue;
            let dx = j / 15 * 2 - 1, dy = k / 15 * 2 - 1, dz = l / 15 * 2 - 1;
            const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
            dx /= len; dy /= len; dz /= len;
            let f = power * (0.7 + rnd() * 0.6);
            let px = x, py = y, pz = z;
            for (; f > 0; f -= 0.22500001) {
              const bx = Math.floor(px), by = Math.floor(py), bz = Math.floor(pz);
              if (by < 0 || by > 255) break;
              const id = world.getBlock(bx, by, bz);
              if (id !== 0) {
                f -= (BLAST_RESISTANCE[id] + 0.3) * 0.3;
                if (f > 0) {
                  const key = ((bx & 0xfffff) * 1048576 + (bz & 0xfffff)) * 256 + by;
                  if (!destroyed.has(key)) destroyed.set(key, [bx, by, bz, id]);
                }
              }
              px += dx * 0.3; py += dy * 0.3; pz += dz * 0.3;
            }
          }
        }
      }
    }

    // ---- entities + player (before the blocks disappear, like Minecraft) ----
    const reach = power * 2;
    const box = this._box;
    box.minX = x - reach - 1; box.maxX = x + reach + 1;
    box.minY = y - reach - 1; box.maxY = y + reach + 1;
    box.minZ = z - reach - 1; box.maxZ = z + reach + 1;
    this._tmp.length = 0;
    const hits = this.getEntitiesInBox(box, this._tmp, (e) => e !== source);
    for (const e of hits) {
      const b = e.body;
      const dist = Math.hypot(b.x - x, b.y - y, b.z - z) / reach;
      if (dist > 1) continue;
      const ey = e.type === 'tnt' ? b.y : b.y + b.height * 0.85;
      let kx = b.x - x, ky = ey - y, kz = b.z - z;
      const kl = Math.hypot(kx, ky, kz);
      if (kl === 0) continue;
      kx /= kl; ky /= kl; kz /= kl;
      const impact = (1 - dist) * this._exposure(world, x, y, z, e.getAABB(this._box2));
      const damage = Math.floor((impact * impact + impact) / 2 * 7 * reach + 1);
      e.hurt(damage, 'explosion', causer);
      e.push(kx * impact * TICKS, ky * impact * TICKS, kz * impact * TICKS);
    }
    this._tmp.length = 0;
    const players = playersOf(game);
    for (let q = 0; q < players.length; q++) {
      const player = players[q];
      if (!player || player.dead || !finite(player.x)) continue;
      const dist = Math.hypot(player.x - x, player.y - y, player.z - z) / reach;
      if (dist <= 1) {
        const eye = finite(player.eyeHeight) ? player.eyeHeight : PLAYER.EYE_HEIGHT;
        let kx = player.x - x, ky = player.y + eye - y, kz = player.z - z;
        const kl = Math.hypot(kx, ky, kz);
        if (kl > 0) {
          kx /= kl; ky /= kl; kz /= kl;
          const pb = typeof player.getAABB === 'function' ? player.getAABB() : null;
          const exposure = pb ? this._exposure(world, x, y, z, pb) : 1;
          const impact = (1 - dist) * exposure;
          // DamageTypes.EXPLOSION scales with the difficulty (peaceful: none, easy: halved + 1, hard: x1.5)
          const damage = scaleMobDamage(game, Math.floor((impact * impact + impact) / 2 * 7 * reach + 1));
          if (typeof player.damage === 'function' && damage > 0) player.damage(damage, 'explosion', undefined, causer);
          if (!(player.mode === 'creative' && player.flying)) {
            player.vx += kx * impact * TICKS;
            player.vy += ky * impact * TICKS;
            player.vz += kz * impact * TICKS;
          }
        }
      }
    }

    // ---- destroy blocks ----
    const chance = finite(dropChance) ? dropChance : 1 / power;
    for (const [bx, by, bz, id] of destroyed.values()) {
      if (world.getBlock(bx, by, bz) !== id) continue;
      if (id === BLOCK.TNT) {
        // TntBlock.wasExploded: primed with a short random fuse (nextInt(fuse / 4) + fuse / 8 ticks).
        if (world.setBlock(bx, by, bz, 0)) {
          this.spawnPrimedTnt(bx + 0.5, by, bz + 0.5, (Math.floor(rnd() * 20) + 10) / TICKS, { sound: false });
        }
        continue;
      }
      if (!world.setBlock(bx, by, bz, 0)) continue;
      if (rnd() < chance) {
        // Explosions harvest like the right tool (stone -> cobblestone, ores -> their drops).
        for (const d of getDrops(id, harvestToolFor(id), rnd)) this.popItem(d.id, d.count, bx + 0.5, by + 0.5, bz + 0.5);
      }
    }
    return destroyed.size;
  }

  /** Fraction of sample points of `box` with a clear line to (x, y, z) (Explosion.getSeenPercent). */
  _exposure(world, x, y, z, box) {
    const sx = 1 / ((box.maxX - box.minX) * 2 + 1);
    const sy = 1 / ((box.maxY - box.minY) * 2 + 1);
    const sz = 1 / ((box.maxZ - box.minZ) * 2 + 1);
    const ox = (1 - Math.floor(1 / sx) * sx) / 2;
    const oz = (1 - Math.floor(1 / sz) * sz) / 2;
    if (!(sx >= 0 && sy >= 0 && sz >= 0)) return 0;
    let seen = 0, total = 0;
    for (let a = 0; a <= 1; a += sx) {
      for (let b = 0; b <= 1; b += sy) {
        for (let c = 0; c <= 1; c += sz) {
          const px = box.minX + (box.maxX - box.minX) * a + ox;
          const py = box.minY + (box.maxY - box.minY) * b;
          const pz = box.minZ + (box.maxZ - box.minZ) * c + oz;
          if (!segmentBlocked(world, px, py, pz, x, y, z)) seen++;
          total++;
        }
      }
    }
    return total > 0 ? seen / total : 0;
  }
}

/** True if a solid block's collision box lies on the segment a -> b (voxel DDA). */
function segmentBlocked(world, ax, ay, az, bx, by, bz) {
  let dx = bx - ax, dy = by - ay, dz = bz - az;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (len < 1e-9) return false;
  dx /= len; dy /= len; dz /= len;
  let x = Math.floor(ax), y = Math.floor(ay), z = Math.floor(az);
  const ex = Math.floor(bx), ey = Math.floor(by), ez = Math.floor(bz);
  const stepX = dx > 0 ? 1 : -1, stepY = dy > 0 ? 1 : -1, stepZ = dz > 0 ? 1 : -1;
  const tdx = dx !== 0 ? Math.abs(1 / dx) : Infinity;
  const tdy = dy !== 0 ? Math.abs(1 / dy) : Infinity;
  const tdz = dz !== 0 ? Math.abs(1 / dz) : Infinity;
  let tmx = dx > 0 ? (x + 1 - ax) / dx : dx < 0 ? (x - ax) / dx : Infinity;
  let tmy = dy > 0 ? (y + 1 - ay) / dy : dy < 0 ? (y - ay) / dy : Infinity;
  let tmz = dz > 0 ? (z + 1 - az) / dz : dz < 0 ? (z - az) / dz : Infinity;
  for (let guard = 0; guard < 256; guard++) {
    const id = y >= 0 && y < 256 ? world.getBlock(x, y, z) : 0;
    if (id !== 0 && IS_SOLID[id] && !IS_LIQUID[id] && RENDER_TYPE[id] !== RENDER.NONE) return true;
    if (x === ex && y === ey && z === ez) return false;
    if (tmx < tmy && tmx < tmz) {
      if (tmx > len) return false;
      x += stepX; tmx += tdx;
    } else if (tmy < tmz) {
      if (tmy > len) return false;
      y += stepY; tmy += tdy;
    } else {
      if (tmz > len) return false;
      z += stepZ; tmz += tdz;
    }
  }
  return false;
}
