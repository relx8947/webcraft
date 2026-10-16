// Particle system (SPEC §9.5): fixed-capacity structure-of-arrays pool, Minecraft-like block break /
// hit / splash / bubble / smoke / explosion particles, crude voxel collision, no allocations per frame.
//
// Output (getRenderData): Float32Array, stride 12 per particle:
//   x, y, z, size, layer, u0, v0, uvSize, r, g, b, light
//   x, y, z   world position (the quad is centred on it, Minecraft style)
//   size      quad edge length in blocks
//   layer     texture array layer, or PROCEDURAL_LAYER (255) for untextured pixel-art particles
//   textured: u0, v0 = top-left of the sampled sub-rect in texels (0..16), uvSize = its edge in texels;
//             r, g, b = colour multiplier (block tint x Minecraft's 0.6 terrain-particle shade);
//             fragments with texture alpha < 0.5 are discarded.
//   procedural (layer 255): u0 = style (STYLE.*), v0 = animation phase 0..1 (age / lifetime),
//             uvSize = per-particle random 0..1 (pattern seed); r, g, b = colour.
//   light     packed light (sky << 4 | block), 255 = full bright.
//
// Physics per particle (Minecraft Particle.tick): v.y -= g; move with crude collision (axis by axis,
// a particle never enters a cell that has a collision box); v *= drag; on the ground v.xz *= 0.7.
import {
  BLOCKS, FACE_LAYERS, TEXTURES, RENDER_LAYER, LAYER, TINT_TYPE, TINT, RENDER_TYPE, RENDER,
  getCollisionBox, getSelectionBox, getItem, isBlockItem, blockId as blockIdByName, BLOCK, IS_LIQUID,
  LIQUID_KIND, LIQUID_LEVEL, liquidHeight, WALL_FACE,
} from '../world/registry.js';
import { DEFAULT_TINTS } from '../config.js';

export const PARTICLE_STRIDE = 12;
export const DEFAULT_PARTICLE_CAPACITY = 4096;
/** `layer` value of untextured, procedurally drawn particles. */
export const PROCEDURAL_LAYER = 255;
/** Procedural particle styles (u0 when layer === PROCEDURAL_LAYER). */
export const STYLE = Object.freeze({
  SMOKE: 0, EXPLOSION: 1, DROPLET: 2, BUBBLE: 3, FLAME: 4, LAVA: 5, DRIP: 6, SPECK: 7, CRIT: 8,
});
/** Packed light value meaning "full bright" (explosions). */
export const FULL_BRIGHT = 255;

const TICKS = 20;
const TERRAIN_SHADE = 0.6;          // Minecraft TerrainParticle rCol = gCol = bCol = 0.6
const LIGHT_REFRESH = 0.25;         // s between light samples of a moving particle
const MAX_EMITTERS = 32;

// Particle kinds (internal behaviour switch).
const K_TERRAIN = 0;
const K_SMOKE = 1;
const K_EXPLOSION = 2;
const K_DROPLET = 3;
const K_BUBBLE = 4;
const K_FLAME = 5;
const K_LAVA = 6;
const K_DRIP_HANG = 7;
const K_DRIP_FALL = 8;
const K_SPECK = 9;
const K_SPLAT = 10;
const K_CRIT = 11;
const QUEUE_CAP = 64;               // deferred spawns per step (smoke trails, drip splats)

// Ambient display ticks (Minecraft ClientLevel.animateTick): random blocks around the player per tick.
const AMBIENT_ITERATIONS = 667;
const DRIP_HANG_TIME = 40 / TICKS;
const WATER_DRIP_RGB = [0.2, 0.3, 1.0];
const LAVA_DRIP_RGB = [1.0, 0.2857, 0.0833];

// Precomputed per block: particle texture layer and colour multiplier (SPEC §5.3 tint rule).
const PARTICLE_LAYER = new Int16Array(256).fill(-1);
const PARTICLE_RGB = new Float32Array(256 * 3);
const tintMaskLayers = new Set();
for (const t of TEXTURES) if (t.alphaMode === 'tintmask') tintMaskLayers.add(t.layer);
{
  const tintRGB = [null, DEFAULT_TINTS.grass, DEFAULT_TINTS.foliage, DEFAULT_TINTS.birch, DEFAULT_TINTS.spruce];
  for (const b of BLOCKS) {
    const id = b.id;
    if (id === 0 || RENDER_TYPE[id] === RENDER.NONE) continue;
    // Variants with a placement rule (sideways logs, rotated furnaces) use their base block's faces,
    // so particles show bark / the furnace front like Minecraft's "particle" texture.
    let src = id;
    if (b.item) {
      const base = BLOCKS[blockIdByName(b.item)];
      if (base && base.placement) src = base.id;
    }
    const rt = RENDER_TYPE[src];
    let face = rt === RENDER.CUBE || rt === RENDER.CACTUS || rt === RENDER.LIQUID ? 4 : 0;   // a side face
    let layer = FACE_LAYERS[src * 6 + face];
    // Tint-mask textures (grass) would need the per-texel mask: use the bottom face (dirt) instead,
    // which is exactly Minecraft's grass block particle texture.
    if (tintMaskLayers.has(layer)) {
      face = 3;
      layer = FACE_LAYERS[src * 6 + face];
    }
    PARTICLE_LAYER[id] = layer;
    // §5.3: OPAQUE-layer blocks use rgb·mix(tint, 1, a) = untinted for their opaque textures;
    // cutout / translucent blocks are fully tinted.
    const tint = RENDER_LAYER[id] !== LAYER.OPAQUE && TINT_TYPE[id] !== TINT.NONE ? tintRGB[TINT_TYPE[id]] : null;
    PARTICLE_RGB[id * 3] = (tint ? tint[0] / 255 : 1) * TERRAIN_SHADE;
    PARTICLE_RGB[id * 3 + 1] = (tint ? tint[1] / 255 : 1) * TERRAIN_SHADE;
    PARTICLE_RGB[id * 3 + 2] = (tint ? tint[2] / 255 : 1) * TERRAIN_SHADE;
  }
}

/** Surface height (blocks above the cell bottom) of liquid `id` at (x, y, z): 1 under the same liquid. */
function surfaceIn(world, x, y, z, id) {
  const above = y < 255 ? world.getBlock(x, y + 1, z) : 0;
  return LIQUID_KIND[above] === LIQUID_KIND[id] ? 1 : liquidHeight(id);
}

// Drips do not pass through glass (Minecraft BlockTags.IMPERMEABLE).
const IMPERMEABLE = new Uint8Array(256);
IMPERMEABLE[BLOCK.GLASS] = 1;
const IS_LIQUID_BLOCK = IS_LIQUID;

/** Particle texture layer of a block (side face, grass -> dirt), or -1 for invisible blocks. */
export function particleLayerFor(blockIdValue) {
  return PARTICLE_LAYER[blockIdValue & 255];
}

/**
 * Minecraft's particle lifetime 4 / (r·0.9 + 0.1) ticks (0.2..2 s, most die young) mapped linearly onto
 * the 0.4..1.5 s range, so the distribution keeps its shape (no mass extinction at a clamp).
 */
function terrainLifetime(r) {
  const mc = 4 / (r * 0.9 + 0.1) / TICKS;
  return 0.4 + (mc - 0.2) * (1.1 / 1.8);
}

/**
 * Fast deterministic PRNG (xorshift32) shared by one ParticleSystem. The state lives in a Uint32Array:
 * a closure variable above 2^30 would be boxed by V8 on every call (a heap allocation per random number).
 */
function makeRandom(seed) {
  const st = new Uint32Array(1);
  st[0] = (seed >>> 0) || 0x9e3779b9;
  return () => {
    let s = st[0];
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    st[0] = s;
    return st[0] * 2.3283064365386963e-10;   // / 2^32
  };
}

/**
 * Fixed-capacity particle pool. `game` provides world (getBlock / getLight) — read lazily, may be null.
 */
export class ParticleSystem {
  /**
   * @param {object} game
   * @param {{ capacity?: number, seed?: number }} [options]
   */
  constructor(game, options = {}) {
    this.game = game;
    /**
     * Ambient block particles around game.player during update() (torch flames and smoke, lava pops,
     * drips under liquids, underwater specks) — Minecraft's random display tick.
     */
    this.ambient = options.ambient ?? true;
    this._ambientAcc = -0;          // double zero: V8 keeps the field unboxed (fractional values follow)
    const cap = Math.max(16, options.capacity ?? DEFAULT_PARTICLE_CAPACITY) | 0;
    this.capacity = cap;
    this.random = makeRandom(options.seed ?? ((Math.random() * 4294967296) >>> 0));
    this._n = 0;
    this._evict = 0;
    // state (structure of arrays)
    this.px = new Float64Array(cap); this.py = new Float64Array(cap); this.pz = new Float64Array(cap);
    this.vx = new Float32Array(cap); this.vy = new Float32Array(cap); this.vz = new Float32Array(cap);
    this.age = new Float32Array(cap); this.life = new Float32Array(cap);
    this.size = new Float32Array(cap);
    this.gravity = new Float32Array(cap);      // b/s²
    this.drag = new Float32Array(cap);         // per-tick velocity factor
    this.kind = new Uint8Array(cap);
    this.ground = new Uint8Array(cap);
    this.layer = new Uint8Array(cap);
    this.u0 = new Float32Array(cap); this.v0 = new Float32Array(cap); this.uvSize = new Float32Array(cap);
    this.r = new Float32Array(cap); this.g = new Float32Array(cap); this.b = new Float32Array(cap);
    this.light = new Uint8Array(cap);
    this.lightTimer = new Float32Array(cap);
    this.cellX = new Int32Array(cap); this.cellY = new Int32Array(cap); this.cellZ = new Int32Array(cap);
    this.seed = new Float32Array(cap);
    this.data = new Float32Array(cap * PARTICLE_STRIDE);
    this._out = { count: 0, data: this.data };
    // explosion emitters (Minecraft HugeExplosionSeedParticle): x, y, z, ticks left, power, timer
    this._em = new Float64Array(MAX_EMITTERS * 6);
    this._emCount = 0;
    // spawns requested while stepping (applied after the loop so the pool never changes under it)
    this._pendingSpawns = new Float64Array(QUEUE_CAP * 4);
    this._queued = 0;
  }

  /** Number of live particles. */
  get count() {
    return this._n;
  }

  /** Remove every particle. */
  clear() {
    this._n = 0;
    this._emCount = 0;
    this._out.count = 0;
  }

  // ---------------------------------------------------------------------------------------------
  // Spawning
  // ---------------------------------------------------------------------------------------------

  /** Allocate a slot (evicts a live particle round-robin when the pool is full). */
  _alloc() {
    if (this._n < this.capacity) return this._n++;
    const i = this._evict;
    this._evict = (this._evict + 1) % this.capacity;
    return i;
  }

  _world() {
    const w = this.game?.world;
    return w && typeof w.getBlock === 'function' ? w : null;
  }

  _sampleLight(x, y, z) {
    const w = this.game?.world;
    if (!w || typeof w.getLight !== 'function') return 0xf0;
    const l = w.getLight(Math.floor(x), Math.floor(y), Math.floor(z));
    return Number.isFinite(l) ? l & 255 : 0xf0;
  }

  /**
   * Light for particles of a block that was just broken: its own cell still holds the light of the
   * opaque block (0) until the world relights it, so take the brightest of the 6 neighbours (sky and
   * block channels separately).
   */
  _lightAroundBlock(x, y, z) {
    const w = this.game?.world;
    if (!w || typeof w.getLight !== 'function') return 0xf0;
    let sky = 0, blk = 0;
    for (let f = 0; f < 7; f++) {
      const l = w.getLight(x + (f === 0 ? 1 : f === 1 ? -1 : 0), y + (f === 2 ? 1 : f === 3 ? -1 : 0),
        z + (f === 4 ? 1 : f === 5 ? -1 : 0));
      if (!Number.isFinite(l)) continue;
      if ((l >> 4 & 15) > sky) sky = l >> 4 & 15;
      if ((l & 15) > blk) blk = l & 15;
    }
    return (sky << 4) | blk;
  }

  /** Common initialisation; returns the slot index. */
  _spawn(kind, x, y, z, vx, vy, vz, life, size, gravity, drag) {
    const i = this._alloc();
    this.kind[i] = kind;
    this.px[i] = x; this.py[i] = y; this.pz[i] = z;
    this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
    this.age[i] = 0;
    this.life[i] = life;
    this.size[i] = size;
    this.gravity[i] = gravity;
    this.drag[i] = drag;
    this.ground[i] = 0;
    this.cellX[i] = Math.floor(x); this.cellY[i] = Math.floor(y); this.cellZ[i] = Math.floor(z);
    this.seed[i] = this.random();
    this.lightTimer[i] = LIGHT_REFRESH * this.random();
    return i;
  }

  _setTerrain(i, blockIdValue) {
    const rnd = this.random;
    this.layer[i] = PARTICLE_LAYER[blockIdValue];
    this.u0[i] = rnd() * 12;    // random 4x4 texel window (TerrainParticle uo/vo)
    this.v0[i] = rnd() * 12;
    this.uvSize[i] = 4;
    this.r[i] = PARTICLE_RGB[blockIdValue * 3];
    this.g[i] = PARTICLE_RGB[blockIdValue * 3 + 1];
    this.b[i] = PARTICLE_RGB[blockIdValue * 3 + 2];
  }

  /**
   * One Minecraft TerrainParticle: velocity = (xa, ya, za) + random ±0.4, normalised to a random
   * speed (0.15..0.45)·0.4 b/tick, + 0.1 b/tick up; size 0.1..0.2; gravity 1.
   */
  _terrain(x, y, z, xa, ya, za, blockIdValue, power, scale, light) {
    const rnd = this.random;
    let dx = xa + (rnd() * 2 - 1) * 0.4;
    let dy = ya + (rnd() * 2 - 1) * 0.4;
    let dz = za + (rnd() * 2 - 1) * 0.4;
    const speed = (rnd() + rnd() + 1) * 0.15;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    dx = dx / len * speed * 0.4;
    dy = dy / len * speed * 0.4 + 0.1;
    dz = dz / len * speed * 0.4;
    if (power !== 1) {
      dx *= power;
      dy = (dy - 0.1) * power + 0.1;
      dz *= power;
    }
    const life = terrainLifetime(rnd());
    const size = 0.2 * (rnd() * 0.5 + 0.5) * scale;   // edge = 2·quadSize = 0.1..0.2 blocks
    const i = this._spawn(K_TERRAIN, x, y, z, dx * TICKS, dy * TICKS, dz * TICKS, life, size, 16, 0.98);
    this._setTerrain(i, blockIdValue);
    this.light[i] = light;
    return i;
  }

  /**
   * Block broken: Minecraft ParticleEngine.destroy — a grid of up to 4x4x4 particles over the block's
   * shape (selection box), each moving away from the block centre.
   */
  spawnBlockBreak(x, y, z, blockIdValue) {
    const id = blockIdValue | 0;
    if (id <= 0 || id > 255 || PARTICLE_LAYER[id] < 0) return;
    const box = getSelectionBox(id);
    const w = Math.min(1, box[3] - box[0]), h = Math.min(1, box[4] - box[1]), d = Math.min(1, box[5] - box[2]);
    const nx = Math.max(2, Math.ceil(w / 0.25)), ny = Math.max(2, Math.ceil(h / 0.25)), nz = Math.max(2, Math.ceil(d / 0.25));
    const light = this._lightAroundBlock(Math.floor(x), Math.floor(y), Math.floor(z));
    for (let a = 0; a < nx; a++) {
      for (let b = 0; b < ny; b++) {
        for (let c = 0; c < nz; c++) {
          const fx = (a + 0.5) / nx, fy = (b + 0.5) / ny, fz = (c + 0.5) / nz;
          this._terrain(x + box[0] + fx * w, y + box[1] + fy * h, z + box[2] + fz * d,
            fx - 0.5, fy - 0.5, fz - 0.5, id, 1, 1, light);
        }
      }
    }
  }

  /**
   * Block being mined: Minecraft ParticleEngine.crack — particles just outside the hit face
   * (power 0.2, scale 0.6). Two per call (interaction calls this every 2 ticks).
   */
  spawnBlockHit(x, y, z, face, blockIdValue, count = 2) {
    const id = blockIdValue | 0;
    if (id <= 0 || id > 255 || PARTICLE_LAYER[id] < 0) return;
    const box = getSelectionBox(id);
    const rnd = this.random;
    for (let n = 0; n < count; n++) {
      let px = x + rnd() * (box[3] - box[0] - 0.2) + 0.1 + box[0];
      let py = y + rnd() * (box[4] - box[1] - 0.2) + 0.1 + box[1];
      let pz = z + rnd() * (box[5] - box[2] - 0.2) + 0.1 + box[2];
      switch (face) {
        case 0: px = x + box[3] + 0.1; break;
        case 1: px = x + box[0] - 0.1; break;
        case 2: py = y + box[4] + 0.1; break;
        case 3: py = y + box[1] - 0.1; break;
        case 4: pz = z + box[5] + 0.1; break;
        case 5: pz = z + box[2] - 0.1; break;
        default: break;
      }
      this._terrain(px, py, pz, 0, 0, 0, id, 0.2, 0.6, this._sampleLight(px, py, pz));
    }
  }

  /**
   * Item pieces (tool breaking, eating): Minecraft BreakingItemParticle with the item's sprite.
   */
  spawnItemBreak(itemId, x, y, z, count = 5) {
    const it = getItem(itemId);
    if (!it) return;
    const rnd = this.random;
    let layer, cr = 1, cg = 1, cb = 1;
    if (isBlockItem(itemId)) {
      layer = PARTICLE_LAYER[itemId];
      cr = PARTICLE_RGB[itemId * 3] / TERRAIN_SHADE;
      cg = PARTICLE_RGB[itemId * 3 + 1] / TERRAIN_SHADE;
      cb = PARTICLE_RGB[itemId * 3 + 2] / TERRAIN_SHADE;
    } else {
      layer = it.layer;
    }
    if (!(layer >= 0)) return;
    for (let n = 0; n < count; n++) {
      const vx = (rnd() - 0.5) * 0.1 * TICKS, vy = (rnd() * 0.1 + 0.1) * TICKS, vz = (rnd() - 0.5) * 0.1 * TICKS;
      const life = terrainLifetime(rnd());
      const i = this._spawn(K_TERRAIN, x + (rnd() - 0.5) * 0.3, y + (rnd() - 0.5) * 0.3, z + (rnd() - 0.5) * 0.3,
        vx, vy, vz, life, 0.2 * (rnd() * 0.5 + 0.5), 16, 0.98);
      this.layer[i] = layer;
      this.u0[i] = rnd() * 12;
      this.v0[i] = rnd() * 12;
      this.uvSize[i] = 4;
      this.r[i] = cr; this.g[i] = cg; this.b[i] = cb;
      this.light[i] = this._sampleLight(x, y, z);
    }
  }

  /**
   * Splash at a water surface point: Minecraft doWaterSplashEffect — droplets flying up and bubbles
   * just below the surface, spread over `width` (entity width, default: the player's 0.6).
   */
  spawnSplash(x, y, z, width = 0.6) {
    const rnd = this.random;
    const n = Math.floor(1 + width * 20);
    const light = this._sampleLight(x, y + 0.5, z);
    for (let k = 0; k < n; k++) {
      // WaterDropParticle / SplashParticle: up 0.1..0.3 b/tick, gravity 0.06 b/tick².
      const px = x + (rnd() * 2 - 1) * width, pz = z + (rnd() * 2 - 1) * width;
      const life = Math.min(1.5, 8 / (rnd() * 0.8 + 0.2) / TICKS);
      const i = this._spawn(K_DROPLET, px, y + 0.02, pz,
        (rnd() * 2 - 1) * 0.06 * TICKS, (rnd() * 0.2 + 0.1) * TICKS, (rnd() * 2 - 1) * 0.06 * TICKS,
        life, 0.06 + rnd() * 0.05, 0.06 * TICKS * TICKS, 0.98);
      this._procedural(i, STYLE.DROPLET, 0.62 + rnd() * 0.1, 0.78 + rnd() * 0.08, 1.0, light);
    }
    for (let k = 0; k < n; k++) this.spawnBubble(x + (rnd() * 2 - 1) * width, y - 0.1 - rnd() * 0.3, z + (rnd() * 2 - 1) * width, light);
  }

  /** One rising underwater bubble (Minecraft BubbleParticle); pops when it leaves the water. */
  spawnBubble(x, y, z, light) {
    const rnd = this.random;
    const life = Math.min(1.5, 8 / (rnd() * 0.8 + 0.2) / TICKS);
    const i = this._spawn(K_BUBBLE, x, y, z,
      (rnd() * 2 - 1) * 0.02 * TICKS, (rnd() * 0.05 + 0.02) * TICKS, (rnd() * 2 - 1) * 0.02 * TICKS,
      life, 0.06 + rnd() * 0.08, -0.002 * TICKS * TICKS, 0.85);
    this._procedural(i, STYLE.BUBBLE, 0.85, 0.93, 1.0, light ?? this._sampleLight(x, y, z));
    return i;
  }

  /**
   * Smoke puffs (Minecraft SmokeParticle): dark grey, rise slowly and shrink.
   * @param {number} [count]
   */
  spawnSmoke(x, y, z, count = 8) {
    const rnd = this.random;
    const n = Math.max(1, Math.min(256, count | 0));
    const light = this._sampleLight(x, y, z);
    for (let k = 0; k < n; k++) {
      const life = Math.min(1.6, Math.max(0.3, 8 / (rnd() * 0.8 + 0.2) / TICKS));
      const i = this._spawn(K_SMOKE, x + (rnd() - 0.5) * 0.4, y + (rnd() - 0.5) * 0.3, z + (rnd() - 0.5) * 0.4,
        (rnd() - 0.5) * 0.04 * TICKS, (rnd() * 0.03 + 0.02) * TICKS, (rnd() - 0.5) * 0.04 * TICKS,
        life, 0.2 + rnd() * 0.15, -0.004 * TICKS * TICKS, 0.96);
      const v = rnd() * 0.3;
      this._procedural(i, STYLE.SMOKE, 0.2 + v, 0.2 + v, 0.2 + v, light);
    }
  }

  /**
   * Explosion: Minecraft's explosion emitter (8 ticks, 6 big puffs per tick within ±4 blocks scaled by
   * the power) plus a burst of smoke ("poof") particles. `power` defaults to TNT's 4.
   */
  spawnExplosion(x, y, z, power = 4) {
    const p = Number.isFinite(power) && power > 0 ? power : 4;
    if (this._emCount < MAX_EMITTERS) {
      const o = this._emCount++ * 6;
      this._em[o] = x; this._em[o + 1] = y; this._em[o + 2] = z;
      this._em[o + 3] = 8; this._em[o + 4] = p; this._em[o + 5] = 0;
    }
    this._explosionPuff(x, y, z, p);
    // "poof" (ExplodeParticle): white-grey puffs thrown outward, slowing down quickly and rising.
    const rnd = this.random;
    const n = Math.round(10 + p * 4);
    const light = this._sampleLight(x, y, z);
    for (let k = 0; k < n; k++) {
      let dx = rnd() * 2 - 1, dy = rnd() * 2 - 1, dz = rnd() * 2 - 1;
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      dx /= len; dy /= len; dz /= len;
      const dist = rnd() * p * 0.6;
      const sp = (2 + rnd() * 6) * (1 - dist / (p * 0.9));
      const life = 0.8 + rnd() * 1.4;
      const i = this._spawn(K_SMOKE, x + dx * dist, y + dy * dist * 0.6, z + dz * dist,
        dx * sp, dy * sp * 0.6 + 0.5, dz * sp, life, 0.25 + rnd() * rnd() * 0.9, -0.004 * TICKS * TICKS, 0.9);
      const v = 0.7 + rnd() * 0.3;
      this._procedural(i, STYLE.SMOKE, v, v, v, light);
    }
  }

  _explosionPuff(x, y, z, power) {
    const rnd = this.random;
    // HugeExplosionParticle: lifetime 6..9 ticks, size 2·(1 - r·0.5), grey 0.4..1, full bright.
    const life = (6 + Math.floor(rnd() * 4)) / TICKS;
    const i = this._spawn(K_EXPLOSION, x, y, z, 0, 0, 0, life, 2 * (1 - rnd() * 0.5) * Math.min(1.5, power / 4 + 0.25), 0, 1);
    const c = rnd() * 0.6 + 0.4;
    this._procedural(i, STYLE.EXPLOSION, c, c, c, FULL_BRIGHT);
  }

  /**
   * Critical hit (Minecraft's crit tracking emitter): 3 ticks × up to 16 sparkles at random points of the
   * entity box (feet centre (x, y, z), width w, height h) flying outward and slowing down quickly.
   */
  spawnCrit(x, y, z, w = 0.6, h = 1.8) {
    const rnd = this.random;
    const light = this._sampleLight(x, y + h * 0.5, z);
    for (let tick = 0; tick < 3; tick++) {
      for (let n = 0; n < 16; n++) {
        const d0 = rnd() * 2 - 1, d1 = rnd() * 2 - 1, d2 = rnd() * 2 - 1;
        if (d0 * d0 + d1 * d1 + d2 * d2 > 1) continue;
        this._crit(x + w * d0 / 4, y + h * (0.5 + d1 / 4), z + w * d2 / 4, d0, d1 + 0.2, d2, light, tick / TICKS);
      }
    }
  }

  /**
   * One crit sparkle (CritParticle): velocity (xd, yd, zd)·0.4 + jitter b/tick, friction 0.7, gravity 0.5,
   * 6 / (r·0.8 + 0.6) ticks, warm white. `delay` (s) ages it in advance (emitter ticks).
   */
  _crit(x, y, z, xd, yd, zd, light, delay = 0) {
    const rnd = this.random;
    const vx = (xd * 0.4 + (rnd() * 2 - 1) * 0.04) * TICKS;
    const vy = (yd * 0.4 + (rnd() * 2 - 1) * 0.04) * TICKS;
    const vz = (zd * 0.4 + (rnd() * 2 - 1) * 0.04) * TICKS;
    const life = Math.max(1, Math.floor(6 / (rnd() * 0.8 + 0.6))) / TICKS + delay;
    const i = this._spawn(K_CRIT, x, y, z, vx, vy, vz, life, (0.1 + rnd() * 0.1) * 0.75 * 2, 0.5 * 0.04 * TICKS * TICKS, 0.7);
    this.age[i] = -delay;
    const f = rnd() * 0.3 + 0.6;
    this._procedural(i, STYLE.CRIT, f * 1.05, f * 0.95, f * 0.78, light);
    return i;
  }

  /** The crit trail of a fully drawn arrow (4 sparkles along its last step, AbstractArrow.tick). */
  spawnCritTrail(x, y, z, vx, vy, vz) {
    const light = this._sampleLight(x, y, z);
    const k = 1 / TICKS / 4;
    for (let n = 0; n < 4; n++) {
      this._crit(x + vx * k * n, y + vy * k * n, z + vz * k * n, -vx / TICKS, -vy / TICKS + 0.2, -vz / TICKS, light);
    }
  }

  /**
   * A dying mob's "poof" (LivingEntity.makePoofParticles): 20 white-grey ExplodeParticle puffs at random points
   * of the entity box (feet centre (x, y, z), width w, height h), slowly rising.
   */
  spawnPoof(x, y, z, w = 0.6, h = 1.8) {
    const rnd = this.random;
    const light = this._sampleLight(x, y + h * 0.5, z);
    for (let n = 0; n < 20; n++) {
      const g = () => (rnd() + rnd() + rnd() - 1.5) * 0.02 * 1.4;
      const px = x + (2 * rnd() - 1) * w, py = y + rnd() * h, pz = z + (2 * rnd() - 1) * w;
      const life = Math.min(2, (16 / (rnd() * 0.8 + 0.2) + 2) / TICKS);
      const size = 0.1 * (rnd() * rnd() * 6 + 1) * 2;
      const i = this._spawn(K_SMOKE, px, py, pz, (g() + (rnd() * 2 - 1) * 0.05) * TICKS, (g() + (rnd() * 2 - 1) * 0.05) * TICKS,
        (g() + (rnd() * 2 - 1) * 0.05) * TICKS, life, size, -0.1 * 0.04 * TICKS * TICKS, 0.9);
      const v = rnd() * 0.3 + 0.7;
      this._procedural(i, STYLE.SMOKE, v, v, v, light);
    }
  }

  /**
   * Torch flame + smoke wisp at (x, y, z) (TorchBlock.animateTick at the block's x+0.5, y+0.7, z+0.5).
   */
  spawnTorchFlame(x, y, z) {
    const rnd = this.random;
    // SmokeParticle: dark (rCol = r·0.3), rises (gravity -0.1 -> +0.004 b/tick²), friction 0.96
    const life = Math.min(1.6, Math.max(0.4, 8 / (rnd() * 0.8 + 0.2) / TICKS));
    const light = this._sampleLight(x, y, z);
    const s = this._spawn(K_SMOKE, x, y, z, (rnd() - 0.5) * 0.02 * TICKS, (rnd() * 0.01) * TICKS, (rnd() - 0.5) * 0.02 * TICKS,
      life, 0.12 + rnd() * 0.08, -0.004 * TICKS * TICKS, 0.96);
    const v = 0.05 + rnd() * 0.25;
    this._procedural(s, STYLE.SMOKE, v, v, v, light);
    // FlameParticle: nearly still (velocity · 0.01), ±0.025 jitter, 12..44 ticks, full bright
    const fl = (8 / (rnd() * 0.8 + 0.2) + 4) / TICKS;
    const f = this._spawn(K_FLAME, x + (rnd() - rnd()) * 0.05, y + (rnd() - rnd()) * 0.05, z + (rnd() - rnd()) * 0.05,
      (rnd() - 0.5) * 0.004 * TICKS, rnd() * 0.004 * TICKS, (rnd() - 0.5) * 0.004 * TICKS, fl,
      0.1 + rnd() * 0.06, 0, 0.96);
    this._procedural(f, STYLE.FLAME, 1, 1, 1, FULL_BRIGHT);
  }

  /** Lava pop (LavaParticle): a glowing blob tossed up from a lava surface, trailing smoke. */
  spawnLavaPop(x, y, z) {
    const rnd = this.random;
    const life = Math.min(2.5, 16 / (rnd() * 0.8 + 0.2) / TICKS);
    const i = this._spawn(K_LAVA, x, y, z, (rnd() - 0.5) * 0.08 * TICKS, (rnd() * 0.4 + 0.05) * TICKS * 0.8,
      (rnd() - 0.5) * 0.08 * TICKS, life, 0.2 * (rnd() * 2 + 0.2) * 0.5 + 0.06, 0.75 * 0.04 * TICKS * TICKS, 0.999);
    this._procedural(i, STYLE.LAVA, 1, 1, 1, FULL_BRIGHT);
    return i;
  }

  /**
   * Drip under a liquid-holding block (DripParticle): hangs 2 s at (x, y, z), then falls (gravity 0.06 b/tick²)
   * and splats on the ground. `lava` selects the colour (and full brightness).
   */
  spawnDrip(x, y, z, lava = false) {
    const rnd = this.random;
    const c = lava ? LAVA_DRIP_RGB : WATER_DRIP_RGB;
    const i = this._spawn(K_DRIP_HANG, x, y, z, 0, 0, 0, DRIP_HANG_TIME + 4, 0.1 + rnd() * 0.04, 0, 0.02);
    this._procedural(i, STYLE.DRIP, c[0], c[1], c[2], lava ? FULL_BRIGHT : this._sampleLight(x, y, z));
    return i;
  }

  /** Underwater speck (SuspendedParticle "underwater"): a tiny still dot that only lives in water. */
  spawnUnderwaterSpeck(x, y, z) {
    const rnd = this.random;
    const life = 16 / (rnd() * 0.8 + 0.2) / TICKS;
    const i = this._spawn(K_SPECK, x, y, z, 0, 0, 0, life, 0.05 + rnd() * 0.06, 0, 1);
    this._procedural(i, STYLE.SPECK, 0.4, 0.4, 0.7, this._sampleLight(x, y, z));
    return i;
  }

  /**
   * One Minecraft display tick around (x, y, z): 667 random blocks within ±16 and 667 within ±32
   * (triangular distribution, like ClientLevel.animateTick) get their ambient particles: torches (flame +
   * smoke), lava with air above (1/100: pop), liquids above a solid block over open space (1/10: drip),
   * still water (1/10: speck).
   */
  animateTick(x, y, z) {
    const world = this._world();
    if (!world) return;
    const rnd = this.random;
    const cx = Math.floor(x), cy = Math.floor(y), cz = Math.floor(z);
    for (let pass = 0; pass < 2; pass++) {
      const r = pass === 0 ? 16 : 32;
      for (let n = 0; n < AMBIENT_ITERATIONS; n++) {
        const by = cy + ((rnd() * r) | 0) - ((rnd() * r) | 0);
        if (by < 0 || by > 255) continue;
        const bx = cx + ((rnd() * r) | 0) - ((rnd() * r) | 0);
        const bz = cz + ((rnd() * r) | 0) - ((rnd() * r) | 0);
        const id = world.getBlock(bx, by, bz);
        if (id === 0) continue;
        if (id === BLOCK.TORCH) {
          this.spawnTorchFlame(bx + 0.5, by + 0.7, bz + 0.5);
        } else if (WALL_FACE[id] >= 0) {
          // WallTorchBlock.animateTick: 0.27 toward the wall, 0.22 higher than a floor torch's flame
          const f = WALL_FACE[id];
          const ox = f === 0 ? -0.27 : f === 1 ? 0.27 : 0, oz = f === 4 ? -0.27 : f === 5 ? 0.27 : 0;
          this.spawnTorchFlame(bx + 0.5 + ox, by + 0.92, bz + 0.5 + oz);
        } else if (LIQUID_KIND[id] !== 0) {
          this._ambientLiquid(world, id, bx, by, bz);
        }
      }
    }
  }

  _ambientLiquid(world, id, bx, by, bz) {
    const rnd = this.random;
    const lava = LIQUID_KIND[id] === 2;
    const audio = this.game?.audio;
    if (lava) {
      // LavaFluid.animateTick: with air above, 1/100 a pop (particle + liquid.lavapop), 1/200 the rumble
      if (by < 255 && world.getBlock(bx, by + 1, bz) === 0) {
        if (rnd() < 0.01) {
          const px = bx + rnd(), pz = bz + rnd();
          this.spawnLavaPop(px, by + 1, pz);
          audio?.play?.('lava_pop', { x: px, y: by + 1, z: pz, volume: 0.7 + rnd() * 0.3, pitch: 0.9 + rnd() * 0.15 });
        }
        if (rnd() < 0.005) {
          audio?.play?.('lava_ambient', { x: bx + 0.5, y: by + 0.5, z: bz + 0.5, volume: 0.7 + rnd() * 0.3, pitch: 0.9 + rnd() * 0.15 });
        }
      }
    } else {
      // WaterFluid.animateTick: flowing (not falling) water burbles 1/64; still water shows specks
      const level = LIQUID_LEVEL[id];
      if (level > 0 && level < 8) {
        if (rnd() < 1 / 64) {
          audio?.play?.('water_flow', { x: bx + 0.5, y: by + 0.5, z: bz + 0.5, volume: 0.75 + rnd() * 0.25, pitch: 0.5 + rnd() });
        }
      } else if (rnd() < 0.1 && LIQUID_KIND[world.getBlock(bx, by + 1, bz)] === 1) {
        this.spawnUnderwaterSpeck(bx + rnd(), by + rnd(), bz + rnd());
      }
    }
    // Level.trySpawnDripParticles: liquid on a full solid block with open space below -> drip under it
    if (rnd() < 0.1 && by >= 2) {
      const below = world.getBlock(bx, by - 1, bz);
      const box = getCollisionBox(below);
      if (box && box[1] === 0 && box[4] === 1 && !IMPERMEABLE[below] && !getCollisionBox(world.getBlock(bx, by - 2, bz)) &&
          !IS_LIQUID_BLOCK[world.getBlock(bx, by - 2, bz)]) {
        this.spawnDrip(bx + box[0] + rnd() * (box[3] - box[0]), by - 1 - 0.05, bz + box[2] + rnd() * (box[5] - box[2]), lava);
      }
    }
  }

  _procedural(i, style, r, g, b, light) {
    this.layer[i] = PROCEDURAL_LAYER;
    this.u0[i] = style;
    this.v0[i] = 0;
    this.uvSize[i] = this.seed[i];
    this.r[i] = r; this.g[i] = g; this.b[i] = b;
    this.light[i] = light;
  }

  // ---------------------------------------------------------------------------------------------
  // Update
  // ---------------------------------------------------------------------------------------------

  /**
   * Advance every particle by dt seconds (sub-stepped at <= 1 tick for long frames). With `ambient` on and
   * a game.player, also runs the 20 Hz display ticks (animateTick) around the player's eyes.
   */
  update(dt) {
    if (!(dt > 0)) return;
    dt = Math.min(dt, 0.25);
    this._updateEmitters(dt);
    const player = this.game?.player;
    if (this.ambient && player && !player.dead && Number.isFinite(player.x)) {
      this._ambientAcc += dt;
      let ticks = 0;
      while (this._ambientAcc >= 1 / TICKS && ticks < 2) {
        this._ambientAcc -= 1 / TICKS;
        ticks++;
        this.animateTick(player.x, player.y + (Number.isFinite(player.eyeHeight) ? player.eyeHeight : 1.62), player.z);
      }
      if (this._ambientAcc >= 1 / TICKS) this._ambientAcc = 0;
    }
    const world = this._world();
    let left = dt;
    while (left > 1e-9) {
      const h = left > 0.05 ? 0.05 : left;
      left -= h;
      this._step(h, world);
    }
  }

  _updateEmitters(dt) {
    const em = this._em;
    const rnd = this.random;
    for (let e = 0; e < this._emCount; e++) {
      const o = e * 6;
      em[o + 5] += dt;
      while (em[o + 5] >= 1 / TICKS && em[o + 3] > 0) {
        em[o + 5] -= 1 / TICKS;
        em[o + 3]--;
        const spread = 4 * Math.min(1.5, em[o + 4] / 4);
        for (let k = 0; k < 6; k++) {
          this._explosionPuff(em[o] + (rnd() - rnd()) * spread, em[o + 1] + (rnd() - rnd()) * spread,
            em[o + 2] + (rnd() - rnd()) * spread, em[o + 4]);
        }
      }
      if (em[o + 3] <= 0) {
        // remove (swap with the last emitter)
        const last = --this._emCount * 6;
        for (let k = 0; k < 6; k++) em[o + k] = em[last + k];
        e--;
      }
    }
  }

  _kill(i) {
    const j = --this._n;
    if (i !== j) this._copy(j, i);
  }

  _copy(from, to) {
    this.px[to] = this.px[from]; this.py[to] = this.py[from]; this.pz[to] = this.pz[from];
    this.vx[to] = this.vx[from]; this.vy[to] = this.vy[from]; this.vz[to] = this.vz[from];
    this.age[to] = this.age[from]; this.life[to] = this.life[from];
    this.size[to] = this.size[from];
    this.gravity[to] = this.gravity[from]; this.drag[to] = this.drag[from];
    this.kind[to] = this.kind[from]; this.ground[to] = this.ground[from];
    this.layer[to] = this.layer[from];
    this.u0[to] = this.u0[from]; this.v0[to] = this.v0[from]; this.uvSize[to] = this.uvSize[from];
    this.r[to] = this.r[from]; this.g[to] = this.g[from]; this.b[to] = this.b[from];
    this.light[to] = this.light[from]; this.lightTimer[to] = this.lightTimer[from];
    this.cellX[to] = this.cellX[from]; this.cellY[to] = this.cellY[from]; this.cellZ[to] = this.cellZ[from];
    this.seed[to] = this.seed[from];
  }

  _step(h, world) {
    const k = h * TICKS;
    this._queued = 0;
    for (let i = 0; i < this._n; i++) {
      const age = this.age[i] + h;
      if (age >= this.life[i]) {
        this._kill(i);
        i--;
        continue;
      }
      this.age[i] = age;
      let kind = this.kind[i];
      if (kind === K_EXPLOSION || kind === K_SPLAT) continue;   // explosion puffs and splats do not move
      if (kind === K_CRIT) {
        if (age < 0) continue;                                  // emitter tick not reached yet
        const d = Math.pow(0.7, k);
        this.vy[i] -= this.gravity[i] * h;
        this.px[i] += this.vx[i] * h; this.py[i] += this.vy[i] * h; this.pz[i] += this.vz[i] * h;
        this.vx[i] *= d; this.vy[i] *= d; this.vz[i] *= d;
        continue;
      }
      if (kind === K_DRIP_HANG && age >= DRIP_HANG_TIME) {
        // DripHangParticle -> FallAndLandParticle
        kind = K_DRIP_FALL;
        this.kind[i] = kind;
        this.gravity[i] = 0.06 * TICKS * TICKS;
        this.drag[i] = 0.98;
        this.life[i] = age + 4;
      } else if (kind === K_LAVA && this.random() < (1 - age / this.life[i]) * k * 0.5) {
        this._queue(0, this.px[i], this.py[i], this.pz[i]);   // smoke trail
      }
      let vx = this.vx[i], vy = this.vy[i] - this.gravity[i] * h, vz = this.vz[i];
      let x = this.px[i], y = this.py[i], z = this.pz[i];
      let cx = this.cellX[i], cy = this.cellY[i], cz = this.cellZ[i];
      let onGround = 0;
      if (world) {
        // --- Y ---
        const ny = y + vy * h;
        const ncy = Math.floor(ny);
        if (ncy !== cy) {
          if (ncy >= 0 && ncy <= 255 && getCollisionBox(world.getBlock(cx, ncy, cz))) {
            if (vy < 0) { y = ncy + 1 + 1e-3; onGround = 1; } else { y = ncy - 1e-3; }
            vy = 0;
          } else {
            y = ny; cy = ncy;
            if (!this._medium(i, kind, world, cx, cy, cz)) { this._kill(i); i--; continue; }
          }
        } else {
          y = ny;
        }
        // --- X ---
        const nx = x + vx * h;
        const ncx = Math.floor(nx);
        if (ncx !== cx) {
          if (cy >= 0 && cy <= 255 && getCollisionBox(world.getBlock(ncx, cy, cz))) {
            x = vx > 0 ? ncx - 1e-3 : ncx + 1 + 1e-3;
            vx = 0;
          } else {
            x = nx; cx = ncx;
            if (!this._medium(i, kind, world, cx, cy, cz)) { this._kill(i); i--; continue; }
          }
        } else {
          x = nx;
        }
        // --- Z ---
        const nz = z + vz * h;
        const ncz = Math.floor(nz);
        if (ncz !== cz) {
          if (cy >= 0 && cy <= 255 && getCollisionBox(world.getBlock(cx, cy, ncz))) {
            z = vz > 0 ? ncz - 1e-3 : ncz + 1 + 1e-3;
            vz = 0;
          } else {
            z = nz; cz = ncz;
            if (!this._medium(i, kind, world, cx, cy, cz)) { this._kill(i); i--; continue; }
          }
        } else {
          z = nz;
        }
        // splash droplets vanish once they fall back below the water surface
        if (kind === K_DROPLET && vy < 0 && this.age[i] > 0.1 && cy >= 0 && cy <= 255) {
          const wid = world.getBlock(cx, cy, cz);
          if (LIQUID_KIND[wid] === 1 && y - cy < surfaceIn(world, cx, cy, cz, wid)) { this._kill(i); i--; continue; }
        }
        // light follows the particle (a 0 sample is ignored: freshly broken cells report the light
        // of the opaque block that was there until the world relights them)
        this.lightTimer[i] -= h;
        if (this.lightTimer[i] <= 0 && this.light[i] !== FULL_BRIGHT) {
          this.lightTimer[i] = LIGHT_REFRESH;
          if (typeof world.getLight === 'function') {
            const l = world.getLight(cx, cy, cz);
            if (Number.isFinite(l) && (l & 255) !== 0) this.light[i] = l & 255;
          }
        }
      } else {
        x += vx * h; y += vy * h; z += vz * h;
      }
      const d = this.drag[i] === 1 ? 1 : Math.pow(this.drag[i], k);
      vx *= d; vy *= d; vz *= d;
      if (onGround) {
        if (kind === K_DROPLET && this.random() < 0.5 * k) { this._kill(i); i--; continue; }
        if (kind === K_DRIP_FALL) {
          // DripLandParticle: a little splat where the drop lands
          this._queue(this.r[i] > 0.5 ? 2 : 1, x, y + 0.01, z);
          this._kill(i); i--; continue;
        }
        const f = Math.pow(0.7, k);
        vx *= f; vz *= f;
      }
      this.ground[i] = onGround;
      this.px[i] = x; this.py[i] = y; this.pz[i] = z;
      this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
      this.cellX[i] = cx; this.cellY[i] = cy; this.cellZ[i] = cz;
    }
    this._flushQueue();
  }

  /** Defer a spawn until the end of the step (kind 0 smoke trail, 1 water splat, 2 lava splat). */
  _queue(what, x, y, z) {
    if (this._queued >= QUEUE_CAP) return;
    const o = this._queued++ * 4;
    const q = this._pendingSpawns;
    q[o] = what; q[o + 1] = x; q[o + 2] = y; q[o + 3] = z;
  }

  _flushQueue() {
    const q = this._pendingSpawns;
    const rnd = this.random;
    for (let n = 0; n < this._queued; n++) {
      const o = n * 4, what = q[o], x = q[o + 1], y = q[o + 2], z = q[o + 3];
      if (what === 0) {
        const life = Math.min(1.2, Math.max(0.3, 8 / (rnd() * 0.8 + 0.2) / TICKS));
        const i = this._spawn(K_SMOKE, x, y, z, 0, 0.5, 0, life, 0.1 + rnd() * 0.08, -0.004 * TICKS * TICKS, 0.96);
        const v = 0.1 + rnd() * 0.2;
        this._procedural(i, STYLE.SMOKE, v, v, v, this._sampleLight(x, y, z));
      } else {
        const c = what === 2 ? LAVA_DRIP_RGB : WATER_DRIP_RGB;
        const i = this._spawn(K_SPLAT, x, y, z, 0, 0, 0, 0.5 + rnd(), 0.12, 0, 1);
        this._procedural(i, STYLE.DROPLET, c[0], c[1], c[2], what === 2 ? FULL_BRIGHT : this._sampleLight(x, y, z));
      }
    }
    this._queued = 0;
  }

  /**
   * Medium rules when a particle enters a new cell: bubbles and underwater specks live only in water,
   * splash droplets die when falling back into it, falling drips die in any liquid.
   */
  _medium(i, kind, world, cx, cy, cz) {
    if (kind !== K_BUBBLE && kind !== K_DROPLET && kind !== K_SPECK && kind !== K_DRIP_FALL) return true;
    const id = cy >= 0 && cy <= 255 ? world.getBlock(cx, cy, cz) : 0;
    if (kind === K_DRIP_FALL) return IS_LIQUID_BLOCK[id] === 0;
    const inWater = LIQUID_KIND[id] === 1;
    if (kind === K_BUBBLE || kind === K_SPECK) return inWater;
    // droplets falling back into the water disappear (but they start right at the surface)
    return !(inWater && this.vy[i] < 0 && this.age[i] > 0.1);
  }

  // ---------------------------------------------------------------------------------------------
  // Output
  // ---------------------------------------------------------------------------------------------

  /** Render data for the EntityRenderer: { count, data } (stride 12, see the header). Reused object. */
  getRenderData() {
    const d = this.data;
    const n = this._n;
    for (let i = 0, o = 0; i < n; i++, o += PARTICLE_STRIDE) {
      d[o] = this.px[i]; d[o + 1] = this.py[i]; d[o + 2] = this.pz[i];
      const kind = this.kind[i];
      const t = Math.max(0, this.age[i]) / this.life[i];
      let size = this.size[i];
      if (kind === K_CRIT && this.age[i] < 0) size = 0;          // not emitted yet
      if (kind === K_SMOKE) size *= Math.min(1, t * 8 + 0.35);   // puffs swell quickly
      else if (kind === K_FLAME) size *= 1 - t * t * 0.5;        // FlameParticle.getQuadSize
      else if (kind === K_LAVA) size *= 1 - t * t;               // LavaParticle.getQuadSize
      d[o + 3] = size;
      d[o + 4] = this.layer[i];
      d[o + 5] = this.u0[i];
      d[o + 6] = this.layer[i] === PROCEDURAL_LAYER ? t : this.v0[i];
      d[o + 7] = this.uvSize[i];
      d[o + 8] = this.r[i]; d[o + 9] = this.g[i]; d[o + 10] = this.b[i];
      d[o + 11] = this.light[i];
    }
    this._out.count = n;
    this._out.data = d;
    return this._out;
  }
}

/** Colour multiplier of a block's particles [r, g, b] (tint x 0.6), for tests and tools. */
export function particleColorFor(blockIdValue, out = [0, 0, 0]) {
  const i = (blockIdValue & 255) * 3;
  out[0] = PARTICLE_RGB[i]; out[1] = PARTICLE_RGB[i + 1]; out[2] = PARTICLE_RGB[i + 2];
  return out;
}
