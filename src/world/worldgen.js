// Procedural world generation (Minecraft 1.18-inspired). Pure module: runs in workers, the main
// thread and Node. See docs/SPEC.md §9.1 and docs/notes/worldgen.md.
//
// Pipeline per chunk (everything is a pure function of the world seed and world coordinates, so a
// chunk is identical regardless of which other chunks were generated before):
//   1. Climate + terrain-shape parameters on a world-aligned 4-block grid covering the chunk plus an
//      8-block margin (continentalness, erosion, peaks/valleys, temperature, humidity, rivers, lakes).
//   2. A 3D density field d = (height - y) + jag * noise3D sampled every 4x8x4 blocks (world aligned)
//      and trilinearly interpolated; per-column 2D details (rivers, lakes, dunes, jagged peaks, small
//      bumps) are added after interpolation.
//   3. Column heights / water / biome / surface profile for the chunk AND a 6-block margin, so that
//      features of neighbouring chunks (trees, cactus rules) can be derived exactly and clipped.
//   4. Fill stone/water, surface rules + ice, noise caves (cheese + spaghetti, 4x4x4 grid), ravines
//      (canyon carvers replayed from origin chunks up to 9 chunks away), lava, bedrock, ore veins (from
//      the 3x3 neighbouring chunks, clipped), trees (world-aligned 4x4 cells, derived from the extended
//      column data and clipped), plants.

import { SEA_LEVEL } from '../config.js';
import { BLOCK, IS_LIQUID, IS_REPLACEABLE } from './registry.js';
import { SimplexNoise, hashString, mulberry32, hash3i, fbm2D, fbm3D, ridged2D } from '../util/noise.js';

// ---------------------------------------------------------------------------
// Block ids
// ---------------------------------------------------------------------------
const AIR = BLOCK.AIR;
const STONE = BLOCK.STONE;
const GRASS = BLOCK.GRASS_BLOCK;
const DIRT = BLOCK.DIRT;
const BEDROCK = BLOCK.BEDROCK;
const SAND = BLOCK.SAND;
const GRAVEL = BLOCK.GRAVEL;
const WATER = BLOCK.WATER;
const LAVA = BLOCK.LAVA;
const SNOWY_GRASS = BLOCK.SNOWY_GRASS_BLOCK;
const SNOW = BLOCK.SNOW_BLOCK;
const ICE = BLOCK.ICE;
const SANDSTONE = BLOCK.SANDSTONE;
const CLAY = BLOCK.CLAY;
const OAK_LOG = BLOCK.OAK_LOG;
const OAK_LOG_X = BLOCK.OAK_LOG_X;
const OAK_LOG_Z = BLOCK.OAK_LOG_Z;
const OAK_LEAVES = BLOCK.OAK_LEAVES;
const BIRCH_LOG = BLOCK.BIRCH_LOG;
const BIRCH_LEAVES = BLOCK.BIRCH_LEAVES;
const SPRUCE_LOG = BLOCK.SPRUCE_LOG;
const SPRUCE_LEAVES = BLOCK.SPRUCE_LEAVES;
const CACTUS = BLOCK.CACTUS;
const DEAD_BUSH = BLOCK.DEAD_BUSH;
const SUGAR_CANE = BLOCK.SUGAR_CANE;
const SHORT_GRASS = BLOCK.SHORT_GRASS;
const FERN = BLOCK.FERN;
const DANDELION = BLOCK.DANDELION;
const POPPY = BLOCK.POPPY;
const CORNFLOWER = BLOCK.CORNFLOWER;
const OXEYE_DAISY = BLOCK.OXEYE_DAISY;
const BROWN_MUSHROOM = BLOCK.BROWN_MUSHROOM;
const RED_MUSHROOM = BLOCK.RED_MUSHROOM;
const PUMPKIN = BLOCK.PUMPKIN;
const GRANITE = BLOCK.GRANITE;
const DIORITE = BLOCK.DIORITE;
const ANDESITE = BLOCK.ANDESITE;
const COAL_ORE = BLOCK.COAL_ORE;
const IRON_ORE = BLOCK.IRON_ORE;
const GOLD_ORE = BLOCK.GOLD_ORE;
const DIAMOND_ORE = BLOCK.DIAMOND_ORE;
const REDSTONE_ORE = BLOCK.REDSTONE_ORE;
const LAPIS_ORE = BLOCK.LAPIS_ORE;
const OAK_SAPLING = BLOCK.OAK_SAPLING;
const BIRCH_SAPLING = BLOCK.BIRCH_SAPLING;
const SPRUCE_SAPLING = BLOCK.SPRUCE_SAPLING;

const IS_LEAVES = new Uint8Array(256);
IS_LEAVES[OAK_LEAVES] = IS_LEAVES[BIRCH_LEAVES] = IS_LEAVES[SPRUCE_LEAVES] = 1;
const IS_LOG = new Uint8Array(256);
for (const id of [OAK_LOG, OAK_LOG_X, OAK_LOG_Z, BIRCH_LOG, BLOCK.BIRCH_LOG_X, BLOCK.BIRCH_LOG_Z,
  SPRUCE_LOG, BLOCK.SPRUCE_LOG_X, BLOCK.SPRUCE_LOG_Z]) IS_LOG[id] = 1;
// Stone types that ore veins may replace (Minecraft's "base_stone_overworld").
const ORE_HOST = new Uint8Array(256);
ORE_HOST[STONE] = ORE_HOST[GRANITE] = ORE_HOST[DIORITE] = ORE_HOST[ANDESITE] = 1;
// Natural terrain blocks that caves may carve.
const CARVABLE = new Uint8Array(256);
for (const id of [STONE, GRASS, DIRT, SAND, GRAVEL, SNOWY_GRASS, SNOW, SANDSTONE, CLAY, GRANITE, DIORITE, ANDESITE]) {
  CARVABLE[id] = 1;
}
// Ground a tree may grow on.
const TREE_SOIL = new Uint8Array(256);
TREE_SOIL[GRASS] = TREE_SOIL[DIRT] = TREE_SOIL[SNOWY_GRASS] = 1;

// ---------------------------------------------------------------------------
// Biomes
// ---------------------------------------------------------------------------
/** Pack 0xRRGGBB into the mesher's r | g << 8 | b << 16 layout. */
function packRGB(hex) {
  return ((hex >> 16) & 255) | (((hex >> 8) & 255) << 8) | ((hex & 255) << 16);
}

const TINT_COLORS = {
  plains: [0x91bd59, 0x77ab2f],
  forest: [0x79c05a, 0x59ae30],
  birch: [0x88bb67, 0x6ba941],
  taiga: [0x86b783, 0x68a464],
  snowy: [0x80b497, 0x60a17b],
  desert: [0xbfb755, 0xaea42a],
  mountains: [0x8ab689, 0x6da36b],
};

function biome(id, name, displayName, tint, mapColor, extra = {}) {
  const [g, f] = TINT_COLORS[tint];
  return Object.freeze({
    id, name, displayName,
    grassColor: packRGB(g), foliageColor: packRGB(f), mapColor,
    temperature: 0.5, precipitation: 'rain', ...extra,
  });
}

/**
 * Biome table. `getBiome(x, z)` returns one of these objects. Colours: `grassColor`/`foliageColor` are
 * packed r | g<<8 | b<<16 (nominal biome colours; per-column tints from getTints() blend smoothly).
 */
export const BIOMES = Object.freeze([
  biome(0, 'ocean', '海洋', 'plains', 0x3f76e4, { temperature: 0.5, water: true }),
  biome(1, 'deep_ocean', '深海', 'plains', 0x2c4fa8, { temperature: 0.5, water: true }),
  biome(2, 'frozen_ocean', '冻洋', 'snowy', 0x8fa9e0, { temperature: 0.0, precipitation: 'snow', water: true }),
  biome(3, 'beach', '沙滩', 'plains', 0xfade55, { temperature: 0.8 }),
  biome(4, 'snowy_beach', '积雪沙滩', 'snowy', 0xfaf0c0, { temperature: 0.05, precipitation: 'snow' }),
  biome(5, 'stony_shore', '石岸', 'mountains', 0xa2a284, { temperature: 0.2 }),
  biome(6, 'river', '河流', 'plains', 0x4a7fe8, { temperature: 0.5, water: true }),
  biome(7, 'frozen_river', '冻河', 'snowy', 0xa0a0ff, { temperature: 0.0, precipitation: 'snow', water: true }),
  biome(8, 'plains', '平原', 'plains', 0x8db360, { temperature: 0.8 }),
  biome(9, 'forest', '森林', 'forest', 0x056621, { temperature: 0.7 }),
  biome(10, 'birch_forest', '桦木森林', 'birch', 0x307444, { temperature: 0.6 }),
  biome(11, 'taiga', '针叶林', 'taiga', 0x0b6659, { temperature: 0.25 }),
  biome(12, 'snowy_plains', '雪原', 'snowy', 0xe8f4f4, { temperature: 0.0, precipitation: 'snow' }),
  biome(13, 'snowy_taiga', '积雪针叶林', 'snowy', 0x31554a, { temperature: -0.5, precipitation: 'snow' }),
  biome(14, 'desert', '沙漠', 'desert', 0xfa9418, { temperature: 2.0, precipitation: 'none' }),
  biome(15, 'mountains', '山地', 'mountains', 0x7b8f74, { temperature: 0.2 }),
  biome(16, 'snowy_peaks', '雪峰', 'snowy', 0xdce8f0, { temperature: -0.7, precipitation: 'snow' }),
  biome(17, 'flower_forest', '繁花森林', 'forest', 0x2d8e49, { temperature: 0.7 }),
]);
const B = Object.freeze({
  OCEAN: 0, DEEP_OCEAN: 1, FROZEN_OCEAN: 2, BEACH: 3, SNOWY_BEACH: 4, STONY_SHORE: 5, RIVER: 6,
  FROZEN_RIVER: 7, PLAINS: 8, FOREST: 9, BIRCH_FOREST: 10, TAIGA: 11, SNOWY_PLAINS: 12, SNOWY_TAIGA: 13,
  DESERT: 14, MOUNTAINS: 15, SNOWY_PEAKS: 16, FLOWER_FOREST: 17,
});
export const BIOME_ID = B;

// Soft climate classes (weights from temperature/humidity) used for land biomes, tints and tree mix.
// Order: snowy plains, snowy taiga, taiga, plains, forest, birch forest, desert, flower forest.
const K_SNOWY = 0, K_SNOWY_TAIGA = 1, K_TAIGA = 2, K_PLAINS = 3, K_FOREST = 4, K_BIRCH = 5, K_DESERT = 6,
  K_FLOWER = 7, NK = 8;
const K_BIOME = [B.SNOWY_PLAINS, B.SNOWY_TAIGA, B.TAIGA, B.PLAINS, B.FOREST, B.BIRCH_FOREST, B.DESERT, B.FLOWER_FOREST];
const K_TINT = ['snowy', 'snowy', 'taiga', 'plains', 'forest', 'birch', 'desert', 'forest'];
const K_GRASS_RGB = new Float64Array(NK * 3);
const K_FOLIAGE_RGB = new Float64Array(NK * 3);
for (let k = 0; k < NK; k++) {
  const [g, f] = TINT_COLORS[K_TINT[k]];
  K_GRASS_RGB[k * 3] = (g >> 16) & 255; K_GRASS_RGB[k * 3 + 1] = (g >> 8) & 255; K_GRASS_RGB[k * 3 + 2] = g & 255;
  K_FOLIAGE_RGB[k * 3] = (f >> 16) & 255; K_FOLIAGE_RGB[k * 3 + 1] = (f >> 8) & 255; K_FOLIAGE_RGB[k * 3 + 2] = f & 255;
}
// Trees per 4x4 cell (probability) for each climate class.
const K_TREE_P = [0.03, 0.42, 0.5, 0.018, 0.62, 0.6, 0, 0.32];

// ---------------------------------------------------------------------------
// Small math helpers
// ---------------------------------------------------------------------------
function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
function smoothstep(e0, e1, v) {
  const t = clamp01((v - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}
function lerp(a, b, t) {
  return a + (b - a) * t;
}
/** Logistic step of width w centred at c (0 below, 1 above). */
function sig(v, c, w) {
  return 1 / (1 + Math.exp((c - v) / w));
}

/** Bilinear interpolation of field f between four grid columns of a struct-of-arrays grid. */
function bilerp(g, f, stride, i00, i10, i01, i11, fx, fz) {
  const o = f * stride;
  const a = g[i00 + o];
  const b = g[i10 + o];
  const c = g[i01 + o];
  const d = g[i11 + o];
  const ab = a + (b - a) * fx;
  const cd = c + (d - c) * fx;
  return ab + (cd - ab) * fz;
}

/** Monotone piecewise-cubic (Fritsch-Carlson) spline through (xs, ys); clamped at the ends. */
function makeSpline(xs, ys) {
  const n = xs.length;
  const m = new Float64Array(n);
  const d = new Float64Array(n - 1);
  for (let i = 0; i < n - 1; i++) d[i] = (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }
  const X = Float64Array.from(xs);
  const Y = Float64Array.from(ys);
  return function spline(x) {
    if (x <= X[0]) return Y[0];
    if (x >= X[n - 1]) return Y[n - 1];
    let i = 0;
    while (x > X[i + 1]) i++;
    const h = X[i + 1] - X[i];
    const t = (x - X[i]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * Y[i] + (t3 - 2 * t2 + t) * h * m[i] +
      (-2 * t3 + 3 * t2) * Y[i + 1] + (t3 - t2) * h * m[i + 1];
  };
}

// Continentalness -> base terrain height (deep ocean .. coast .. inland).
const CONT_HEIGHT = makeSpline(
  [-2.4, -1.5, -1.05, -0.75, -0.5, -0.36, -0.27, -0.2, -0.14, -0.06, 0.05, 0.4, 0.9, 1.6, 2.6],
  [27, 31, 36, 42, 49, 55, 59, 61.5, 62.7, 63.8, 65.2, 68.5, 72, 77, 84],
);

// ---------------------------------------------------------------------------
// Working-area layout (per generated chunk)
// ---------------------------------------------------------------------------
const EXT = 6;                       // margin (blocks) of per-column data around the chunk
const NE = 16 + 2 * EXT;             // 28 columns per axis in the extended area
const NE2 = NE * NE;
const GS = 4;                        // horizontal grid spacing of climate / density samples
const GOFF = 8;                      // grid covers local [-8, 24]
const NG = (16 + 2 * GOFF) / GS + 1; // 9 grid columns per axis
const NG2 = NG * NG;
const GY = 8;                        // vertical spacing of terrain density samples
const NLY = 256 / GY + 1;            // 33 density levels (y = 0, 8, ..., 256)
const CY = 4;                        // vertical spacing of the cave grid
const NCG = 5;                       // cave grid columns per axis (in-chunk only)
const NCY = 256 / CY + 1;            // 65 cave levels
const NCV = 6;                       // cave noise values per grid point
const TREE_CELL = 4;                 // trees: at most one per 4x4 world-aligned cell
const TREE_REACH = 5;                // max horizontal extent of a tree from its trunk
const DESERT_CELL = 4;               // cacti / dead bushes: one candidate per 4x4 cell (offset 1..2)
const RAVINE_CHANCE = 1 / 70;        // ravine origins per chunk
const RAVINE_RANGE = 9;              // chunks searched for ravine origins (max ravine reach ~120 blocks)

// Grid fields (struct of arrays)
const G_C = 0, G_E = 1, G_T = 2, G_HM = 3, G_R = 4, G_L = 5, G_ENT = 6, G_H = 7, G_J = 8, G_M = 9, NGF = 10;
// Extended-column float fields
const C_T = 0, C_HM = 1, C_C = 2, C_E = 3, C_M = 4, C_RIV = 5, C_H2 = 6, C_DELTA = 7, C_ENT = 8, C_SN = 9,
  C_FREEZE = 10, C_LAKE = 11, C_RABS = 12, NCF = 13;

const RIVER_W = 0.05;                // half-width of river channels in river-noise units

const NO_WATER = 999;

// ---------------------------------------------------------------------------
// Tree builders (shared by world generation and sapling growth)
// ---------------------------------------------------------------------------
const TREE_OAK = 0, TREE_OAK_LARGE = 1, TREE_BIRCH = 2, TREE_BIRCH_TALL = 3, TREE_SPRUCE = 4, TREE_PINE = 5;
const clusterTmp = new Int32Array(3 * 4); // side-cluster centres of a fancy oak (max 4)

/** Growable list of block placements (absolute coordinates). */
class PlacementList {
  constructor(cap = 512) {
    this.x = new Int32Array(cap);
    this.y = new Int32Array(cap);
    this.z = new Int32Array(cap);
    this.id = new Uint8Array(cap);
    this.n = 0;
  }
  reset() {
    this.n = 0;
  }
  push(x, y, z, id) {
    if (this.n === this.x.length) this._grow();
    const i = this.n++;
    this.x[i] = x;
    this.y[i] = y;
    this.z[i] = z;
    this.id[i] = id;
  }
  _grow() {
    const cap = this.x.length * 2;
    for (const k of ['x', 'y', 'z']) {
      const a = new Int32Array(cap);
      a.set(this[k]);
      this[k] = a;
    }
    const ids = new Uint8Array(cap);
    ids.set(this.id);
    this.id = ids;
  }
}

/** Classic Minecraft oak/birch crown: layers of radius 2,2,1,1 with random corners. */
function crownRound(out, rng, x, top, z, leaves) {
  for (let yy = top - 3; yy <= top; yy++) {
    const dy = yy - top;
    const r = dy <= -2 ? 2 : 1;
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (Math.abs(dx) === r && Math.abs(dz) === r) {
          // corners: never on the top layer, 50% elsewhere (smaller on the upper ring)
          if (dy === 0 || rng() < 0.5) continue;
        }
        out.push(x + dx, yy, z + dz, leaves);
      }
    }
  }
}

/**
 * Fancy-oak leaf cluster (Minecraft style): 5 layers with radii 2,3,3,3,2 and the cross-section rule
 * (|dx|+0.5)^2 + (|dz|+0.5)^2 <= r^2, i.e. a plus, three 5x5-minus-corners layers and a plus.
 * (cx, cy, cz) = centre of the bottom layer.
 */
function leafCluster(out, cx, cy, cz, leaves) {
  for (let i = 0; i < 5; i++) {
    const r = i === 0 || i === 4 ? 2 : 3;
    const r2 = r * r;
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        const ax = Math.abs(dx) + 0.5;
        const az = Math.abs(dz) + 0.5;
        if (ax * ax + az * az > r2) continue;
        out.push(cx + dx, cy + i, cz + dz, leaves);
      }
    }
  }
}

/** Straight branch of logs from (x0,y0,z0) to (x1,y1,z1), oriented along its dominant axis. */
function branch(out, x0, y0, z0, x1, y1, z1) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dz = z1 - z0;
  const n = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz));
  const ax = Math.abs(dx);
  const az = Math.abs(dz);
  const id = Math.abs(dy) >= Math.max(ax, az) ? OAK_LOG : ax >= az ? OAK_LOG_X : OAK_LOG_Z;
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    out.push(Math.round(x0 + dx * t), Math.round(y0 + dy * t), Math.round(z0 + dz * t), id);
  }
}

/**
 * Build a tree into `out` (logs first, then leaves). (x, y, z) = lowest trunk block.
 * Returns the trunk height (number of vertical log blocks above y).
 */
function buildTree(out, kind, rng, x, y, z) {
  switch (kind) {
    case TREE_OAK:
    case TREE_BIRCH:
    case TREE_BIRCH_TALL: {
      const log = kind === TREE_OAK ? OAK_LOG : BIRCH_LOG;
      const leaves = kind === TREE_OAK ? OAK_LEAVES : BIRCH_LEAVES;
      let h = kind === TREE_OAK ? 4 + Math.floor(rng() * 3) : 5 + Math.floor(rng() * 3);
      if (kind === TREE_BIRCH_TALL) h += 3 + Math.floor(rng() * 4);
      for (let i = 0; i < h; i++) out.push(x, y + i, z, log);
      crownRound(out, rng, x, y + h, z, leaves);
      return h;
    }
    case TREE_OAK_LARGE: {
      // Fancy oak: tall trunk, a crown cluster on top and 2-4 side clusters on short branches.
      const h = 7 + Math.floor(rng() * 4);
      for (let i = 0; i < h; i++) out.push(x, y + i, z, OAK_LOG);
      const n = 2 + Math.floor(rng() * 3);
      const a0 = rng() * Math.PI * 2;
      for (let b = 0; b < n; b++) {
        const a = a0 + (b / n) * Math.PI * 2 + (rng() - 0.5) * 1.2;
        const d = 2 + rng() * 1.4;
        const cx = x + Math.round(Math.cos(a) * d);
        const cz = z + Math.round(Math.sin(a) * d);
        const cy = y + Math.floor(h * (0.42 + rng() * 0.3));
        branch(out, x, cy - 2, z, cx, cy, cz);
        clusterTmp[b * 3] = cx;
        clusterTmp[b * 3 + 1] = cy;
        clusterTmp[b * 3 + 2] = cz;
      }
      leafCluster(out, x, y + h - 2, z, OAK_LEAVES);
      for (let b = 0; b < n; b++) leafCluster(out, clusterTmp[b * 3], clusterTmp[b * 3 + 1], clusterTmp[b * 3 + 2], OAK_LEAVES);
      return h;
    }
    case TREE_SPRUCE: {
      // Minecraft "taiga2" spruce: layered cone whose radius grows downwards and restarts.
      const total = 6 + Math.floor(rng() * 4);
      const bare = 1 + Math.floor(rng() * 2);
      const leafH = total - bare;
      const maxR = 2 + Math.floor(rng() * 2);
      const trunk = total - Math.floor(rng() * 3);
      for (let i = 0; i < trunk; i++) out.push(x, y + i, z, SPRUCE_LOG);
      let r = Math.floor(rng() * 2);
      let lim = 1;
      let next = 0;
      for (let l = 0; l <= leafH; l++) {
        const yy = y + total - l;
        for (let dx = -r; dx <= r; dx++) {
          for (let dz = -r; dz <= r; dz++) {
            if (r > 0 && Math.abs(dx) === r && Math.abs(dz) === r) continue;
            out.push(x + dx, yy, z + dz, SPRUCE_LEAVES);
          }
        }
        if (r >= lim) {
          r = next;
          next = 1;
          lim = Math.min(lim + 1, maxR);
        } else {
          r++;
        }
      }
      return trunk;
    }
    case TREE_PINE: {
      // Minecraft "taiga1" pine: tall bare trunk with a narrow cone of leaves at the top.
      const total = 7 + Math.floor(rng() * 5);
      const bottom = total - Math.floor(rng() * 2) - 3;
      const q = rng();
      const maxR = q < 0.3 ? 1 : q < 0.85 ? 2 : 3;
      for (let i = 0; i < total - 1; i++) out.push(x, y + i, z, SPRUCE_LOG);
      let r = 0;
      for (let yy = y + total; yy >= y + bottom; yy--) {
        for (let dx = -r; dx <= r; dx++) {
          for (let dz = -r; dz <= r; dz++) {
            if (r > 0 && Math.abs(dx) === r && Math.abs(dz) === r) continue;
            out.push(x + dx, yy, z + dz, SPRUCE_LEAVES);
          }
        }
        if (r >= 1 && yy === y + bottom + 1) r--;
        else if (r < maxR) r++;
      }
      return total - 1;
    }
    default:
      throw new Error(`unknown tree kind ${kind}`);
  }
}

/** Can a log of a growing tree replace this block? */
function logCanReplace(id) {
  return id === AIR || IS_LEAVES[id] === 1 || (IS_REPLACEABLE[id] === 1 && IS_LIQUID[id] === 0) ||
    id === OAK_SAPLING || id === BIRCH_SAPLING || id === SPRUCE_SAPLING;
}
/** Can leaves be placed into this block? */
function leavesCanReplace(id) {
  return id === AIR || (IS_REPLACEABLE[id] === 1 && IS_LIQUID[id] === 0);
}

const TREE_KIND_BY_NAME = {
  oak: TREE_OAK, large_oak: TREE_OAK_LARGE, birch: TREE_BIRCH, tall_birch: TREE_BIRCH_TALL,
  spruce: TREE_SPRUCE, pine: TREE_PINE,
};

// ---------------------------------------------------------------------------
// Ore / blob configuration (Minecraft-like; counts are veins per chunk)
// ---------------------------------------------------------------------------
const ORES = [
  { block: DIRT, count: 9, size: 33, min: 0, max: 160, dist: 'uniform' },
  { block: GRAVEL, count: 7, size: 33, min: 0, max: 200, dist: 'uniform' },
  { block: GRANITE, count: 7, size: 33, min: 0, max: 80, dist: 'uniform' },
  { block: DIORITE, count: 7, size: 33, min: 0, max: 80, dist: 'uniform' },
  { block: ANDESITE, count: 7, size: 33, min: 0, max: 80, dist: 'uniform' },
  { block: COAL_ORE, count: 20, size: 17, min: 0, max: 128, dist: 'uniform' },
  { block: COAL_ORE, count: 8, size: 17, min: 128, max: 220, dist: 'uniform' },
  { block: IRON_ORE, count: 20, size: 9, min: 0, max: 64, dist: 'uniform' },
  { block: GOLD_ORE, count: 2, size: 9, min: 0, max: 32, dist: 'uniform' },
  { block: REDSTONE_ORE, count: 8, size: 8, min: 0, max: 16, dist: 'uniform' },
  { block: DIAMOND_ORE, count: 1, size: 8, min: 0, max: 16, dist: 'uniform' },
  { block: LAPIS_ORE, count: 1, size: 7, min: 0, max: 32, dist: 'triangle' },
];
// Max horizontal distance a vein reaches from its start position.
const ORE_REACH = 8;

// ---------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------
/**
 * Parse a user-entered seed. Integer strings map to that number mod 2^32 (exactly, via BigInt, so
 * Minecraft-style 64-bit seeds work); any other text is hashed. The caller handles empty input.
 * @param {string} text
 * @returns {number} uint32
 */
export function parseSeed(text) {
  const t = String(text).trim();
  if (/^[+-]?\d+$/.test(t)) return Number(BigInt.asUintN(32, BigInt(t)));
  return hashString(t);
}

// ---------------------------------------------------------------------------
// The generator
// ---------------------------------------------------------------------------
export class WorldGenerator {
  /**
   * @param {number|string} seed uint32 (strings are passed through parseSeed)
   * @param {'default'|'flat'} worldType
   */
  constructor(seed, worldType = 'default') {
    this.seed = typeof seed === 'string' ? parseSeed(seed) : seed >>> 0;
    this.worldType = worldType === 'flat' ? 'flat' : 'default';
    const n = (name) => new SimplexNoise(this._sub(name));
    this.nCont = n('continentalness');
    this.nWarpX = n('warp-x');
    this.nWarpZ = n('warp-z');
    this.nEro = n('erosion');
    this.nWeird = n('weirdness');
    this.nTemp = n('temperature');
    this.nHum = n('humidity');
    this.nRiver = n('river');
    this.nRiverWarp = n('river-warp');
    this.nLake = n('lake');
    this.nHill = n('hills');
    this.nRidge = n('ridges');
    this.nEnt = n('cave-entrances');
    this.nDetail = n('detail');
    this.nDune = n('dunes');
    this.nJag = n('jagged');
    this.nSurf = n('surface');
    this.nPatch = n('patches');
    this.nFlower = n('flowers');
    this.nFlowerForest = n('flower-forest');
    this.nT3 = n('terrain-3d');
    this.nCheese = n('cheese');
    this.nSpagA = n('spaghetti-a');
    this.nSpagB = n('spaghetti-b');
    this.nSpagR = n('spaghetti-r');
    this.nSpag2A = n('spaghetti2-a');
    this.nSpag2B = n('spaghetti2-b');
    this.nFloor = n('ocean-floor');
    this.nFloorMat = n('floor-material');
    this.nIce = n('ice');

    this.sTree = this._sub('trees');
    this.sDesert = this._sub('desert-plants');
    this.sPlant = this._sub('plants');
    this.sOre = this._sub('ores');
    this.sBedrock = this._sub('bedrock');
    this.sPumpkin = this._sub('pumpkins');
    this.sRavine = this._sub('ravines');

    // Scratch buffers (reused between chunks: no per-chunk allocations except the result array).
    this.grid = new Float64Array(NGF * NG2);
    this.gridDens = new Float64Array(NG2 * NLY);
    this.colF = new Float64Array(NCF * NE2);
    this.colS = new Int16Array(NE2);          // top solid y (-1 = none)
    this.colWater = new Int16Array(NE2);      // lowest water y, NO_WATER if none
    this.colBiome = new Uint8Array(NE2);
    this.colTop = new Uint8Array(NE2);        // surface block of the top run
    this.colSlope = new Uint8Array(NE2);
    this.colCeil = new Int16Array(NE2);       // highest y caves/ravines may carve (water protection)
    this.ravineMask = new Uint8Array(NE2);    // 1 = a ravine removed this column's ground block
    this.ravineWidth = new Float64Array(256);
    this.levels = new Float64Array(NLY);
    this.caveGrid = new Float64Array(NCG * NCG * NCY * NCV);
    this.caveLv = new Float64Array(NCY * NCV);
    this.weights = new Float64Array(NK);
    this.treeTmp = new PlacementList(512);
    this._spawn = null;
    this._tintCache = new Map();
    this._colOne = new Float64Array(NCF);
  }

  _sub(name) {
    return hash3i(this.seed, hashString(name), 0x5eed, 0x77);
  }

  // -------------------------------------------------------------------------
  // Climate & terrain parameters at a grid column
  // -------------------------------------------------------------------------

  /** Writes the NGF grid fields for world column (x, z) into out[o + f * stride]. */
  _gridColumn(x, z, out, o, stride) {
    // Continentalness: domain-warped low-frequency fBm (continents of ~1-3k blocks).
    const wx = x + 140 * fbm2D(this.nWarpX, x / 1100, z / 1100, 2);
    const wz = z + 140 * fbm2D(this.nWarpZ, x / 1100, z / 1100, 2);
    let c = fbm2D(this.nCont, wx / 2600, wz / 2600, 6) / 0.32;
    // Gentle land bias around the origin so new worlds usually start on a continent.
    c += 0.55 * Math.exp(-(x * x + z * z) / (1400 * 1400));
    const e = fbm2D(this.nEro, x / 1300, z / 1300, 5) / 0.32;
    const w = fbm2D(this.nWeird, x / 800, z / 800, 4) / 0.33;
    const t = fbm2D(this.nTemp, x / 1900, z / 1900, 4) / 0.33;
    const hm = fbm2D(this.nHum, x / 1500, z / 1500, 4) / 0.33;
    const rwx = x + 60 * this.nRiverWarp.noise2D(x / 300, z / 300);
    const rwz = z + 60 * this.nRiverWarp.noise2D(z / 300 + 31.7, x / 300 - 17.3);
    const r = fbm2D(this.nRiver, rwx / 1100, rwz / 1100, 3) / 0.36;
    const lake = fbm2D(this.nLake, x / 260, z / 260, 2) / 0.4;
    const ent = fbm2D(this.nEnt, x / 160, z / 160, 2) / 0.4;

    // ---- terrain height (continuous blend of climate-driven shapes) ----
    const base = CONT_HEIGHT(c);
    const inland = smoothstep(-0.3, 0.25, c);
    const flat = smoothstep(-0.7, 0.9, e);                  // 0 rugged .. 1 flat
    const pv = 1 - Math.abs(3 * Math.abs(w * 0.45) - 2);     // peaks & valleys, [-1, 1]
    const hills = fbm2D(this.nHill, x / 280, z / 280, 4);
    const mtn = smoothstep(-0.05, 0.45, c) * smoothstep(-0.35, -1.1, e);
    const hilly = smoothstep(-0.14, 0.3, c);                // hills fade out towards the coast
    const ridge = ridged2D(this.nRidge, x / 520, z / 520, 5);
    let h = base;
    h += hilly * hills * lerp(30, 5, flat);
    h += hilly * (pv < -1 ? -1 : pv) * lerp(16, 2.5, flat) * (1 - 0.6 * mtn);
    h += mtn * (24 + 118 * ridge * ridge) * smoothstep(-0.2, 0.6, pv + 0.6 * ridge);
    if (h > 175) h = 175 + (h - 175) * 0.45;                // soften the highest peaks
    // Inland terrain stays above the sea (soft floor); lakes and rivers are carved explicitly.
    const FLOOR = 63.2;
    const sp = (h - FLOOR) / 2.2;
    const floored = FLOOR + (sp > 20 ? h - FLOOR : 2.2 * Math.log1p(Math.exp(sp)));
    h += (floored - h) * inland;
    // gentle undulation of the sea floor
    h += (1 - inland) * 4.5 * fbm2D(this.nFloor, x / 150, z / 150, 3);
    // River valleys suppress 3D roughness (keeps river banks clean).
    const rv = 1 - smoothstep(0.06, 0.2, Math.abs(r));
    const jag = (1.5 + mtn * 22 + inland * (1 - flat) * 5) * (1 - 0.85 * rv);

    out[o + G_C * stride] = c;
    out[o + G_E * stride] = e;
    out[o + G_T * stride] = t;
    out[o + G_HM * stride] = hm;
    out[o + G_R * stride] = r;
    out[o + G_L * stride] = lake;
    out[o + G_ENT * stride] = ent;
    out[o + G_H * stride] = h;
    out[o + G_J * stride] = jag;
    out[o + G_M * stride] = mtn;
  }

  /** 3D terrain density at a grid point (world coords) given its column's height and jag amplitude. */
  _gridDensity(x, y, z, h, jag) {
    const dy = h - y;
    if (dy > jag + 12 || dy < -jag - 12) return dy;
    return dy + jag * fbm3D(this.nT3, x / 96, y / 64, z / 96, 3);
  }

  /**
   * Per-column fields from 4 grid corners (bilinear) plus per-column detail noise.
   * g: struct-of-arrays grid with field stride `gstride`; i00..i11: corner indices; fx/fz in [0,1).
   * Writes NCF fields to out[o + field * ostride]. Every caller uses this same arithmetic, so a column
   * gets bit-identical values whichever chunk (or getBiome / getTints) computes it.
   */
  _column(x, z, g, gstride, i00, i10, i01, i11, fx, fz, out, o, ostride) {
    const c = bilerp(g, G_C, gstride, i00, i10, i01, i11, fx, fz);
    const e = bilerp(g, G_E, gstride, i00, i10, i01, i11, fx, fz);
    const t = bilerp(g, G_T, gstride, i00, i10, i01, i11, fx, fz);
    const hm = bilerp(g, G_HM, gstride, i00, i10, i01, i11, fx, fz);
    const r = bilerp(g, G_R, gstride, i00, i10, i01, i11, fx, fz);
    const lake = bilerp(g, G_L, gstride, i00, i10, i01, i11, fx, fz);
    const ent = bilerp(g, G_ENT, gstride, i00, i10, i01, i11, fx, fz);
    const h = bilerp(g, G_H, gstride, i00, i10, i01, i11, fx, fz);
    const m = bilerp(g, G_M, gstride, i00, i10, i01, i11, fx, fz);

    const inland = smoothstep(-0.3, 0.25, c);
    const flat = smoothstep(-0.7, 0.9, e);
    // Desert-ness (smooth) for dunes.
    const desert = sig(t, 0.55, 0.08) * sig(-hm, 0.05, 0.08) * inland;

    let delta = 0;
    // small bumps (land only; sea floors get their undulation on the grid)
    delta += fbm2D(this.nDetail, x / 40, z / 40, 3) * (1.2 + 2.3 * (1 - flat)) * (0.1 + 0.9 * inland);
    // dunes: elongated, asymmetric ridges
    if (desert > 0.02) {
      // long, smooth dune ridges (sharpened crest, gentle troughs), slowly meandering
      const warp = 26 * this.nDune.noise2D(x / 170, z / 170);
      const dn = 1 - Math.abs(this.nDune.noise2D((x + warp) / 58, (z - warp) / 130 + 50));
      const amp = 2.2 + 2.6 * (0.5 + 0.5 * this.nDune.noise2D(x / 300 + 20, z / 300));
      delta += desert * (dn * dn * amp * 1.4 - amp * 0.45);
    }
    // jagged peaks
    if (m > 0.01 && h > 110) {
      const jr = ridged2D(this.nJag, x / 42, z / 42, 3);
      delta += m * smoothstep(110, 165, h) * (jr - 0.3) * 26;
    }
    let h2 = h + delta;

    // Rivers: |r| small = channel. The valley floor rises with the mountain factor so rivers end in
    // dry mountain valleys instead of canyons.
    const ar = Math.abs(r);
    const RW = RIVER_W;
    const river = 1 - smoothstep(RW * 0.6, RW * 1.4, ar); // 1 = channel centre
    if (ar < RW * 5.5) {
      const floorLift = m * 70;
      let target;
      if (ar < RW) {
        const q = ar / RW;
        target = 55.5 + 7 * q * q + floorLift;
      } else {
        target = lerp(62.5 + floorLift, h2, smoothstep(RW, RW * 5.5, ar));
      }
      if (target < h2) {
        const strength = smoothstep(-0.55, -0.25, c);   // rivers vanish in the open ocean
        delta += (target - h2) * strength;
        h2 = h + delta;
      }
    }
    // Lakes: shallow basins in low, flat land.
    let lakeF = 0;
    if (lake > 1.5 && m < 0.6) {
      lakeF = smoothstep(1.5, 2.3, lake) * (1 - m) * smoothstep(-0.25, 0.1, c) * (1 - smoothstep(67, 76, h2));
      if (lakeF > 0) {
        const target = lerp(h2, 54, lakeF);
        if (target < h2) {
          delta += target - h2;
          h2 = h + delta;
        }
      }
    }

    out[o + C_T * ostride] = t;
    out[o + C_HM * ostride] = hm;
    out[o + C_C * ostride] = c;
    out[o + C_E * ostride] = e;
    out[o + C_M * ostride] = m;
    out[o + C_RIV * ostride] = river;
    out[o + C_H2 * ostride] = h2;
    out[o + C_DELTA * ostride] = delta;
    out[o + C_ENT * ostride] = ent;
    out[o + C_SN * ostride] = this.nSurf.noise2D(x / 18, z / 18);
    // Freezing: cold climates freeze water surfaces (> 0.5 = frozen biome).
    out[o + C_FREEZE * ostride] = sig(-t, 0.98, 0.04);
    out[o + C_LAKE * ostride] = lakeF;
    out[o + C_RABS * ostride] = ar;
  }

  /** Soft land-climate class weights (sum 1) from temperature / humidity. */
  _climateWeights(t, hm, x, z, w) {
    const cold = sig(-t, 0.95, 0.06);          // snowy
    const cool = sig(-t, 0.42, 0.06) - cold;   // taiga band
    const hot = sig(t, 0.62, 0.06);            // hot band
    const temperate = 1 - cold - cool - hot;
    const wet = sig(hm, 0.1, 0.07);
    const veryWet = sig(hm, 0.62, 0.07);
    const dry = sig(-hm, 0.3, 0.07);
    const mid = 1 - wet - dry < 0 ? 0 : 1 - wet - dry;
    w[K_SNOWY] = cold * (1 - wet);
    w[K_SNOWY_TAIGA] = cold * wet;
    w[K_TAIGA] = cool;
    // temperate: plains (dry) / forest (mid) / birch (very wet) / flower forest (patches in forest)
    const ff = sig(this.nFlowerForest.noise2D(x / 700, z / 700), 0.55, 0.05);
    w[K_PLAINS] = temperate * (dry + mid * 0.35) + hot * sig(hm, -0.05, 0.08) * (1 - wet);
    const forest = temperate * (mid * 0.65 + (wet - veryWet));
    w[K_FLOWER] = forest * ff;
    w[K_FOREST] = forest * (1 - ff) + hot * wet;
    w[K_BIRCH] = temperate * veryWet;
    w[K_DESERT] = hot * sig(-hm, -0.05, 0.08) * (1 - wet);
    let sum = 0;
    for (let k = 0; k < NK; k++) sum += w[k];
    for (let k = 0; k < NK; k++) w[k] /= sum;
  }

  /** Discrete biome id for a column (2D data only, so getBiome() can reproduce it anywhere). */
  _classify(cf, o, os, x, z) {
    const c = cf[o + C_C * os];
    const h2 = cf[o + C_H2 * os];
    const m = cf[o + C_M * os];
    const river = cf[o + C_RIV * os];
    const t = cf[o + C_T * os];
    const frozen = cf[o + C_FREEZE * os] > 0.5;
    if (h2 < SEA_LEVEL - 0.5) {
      if (river > 0.5 && c > -0.55) return frozen ? B.FROZEN_RIVER : B.RIVER;
      if (cf[o + C_LAKE * os] > 0.05 && c > -0.3) {
        // inland lakes take the surrounding land biome's name (water filled by the generator)
      } else {
        if (frozen) return B.FROZEN_OCEAN;
        return c < -1.05 ? B.DEEP_OCEAN : B.OCEAN;
      }
    }
    if (m > 0.45 && h2 > 105) {
      return h2 > this._snowLine(t, cf[o + C_SN * os]) - 4 ? B.SNOWY_PEAKS : B.MOUNTAINS;
    }
    if (c < -0.08 && h2 < 65.6 && river < 0.5 && cf[o + C_LAKE * os] < 0.05) {
      if (m > 0.25) return B.STONY_SHORE;
      return t < -0.95 ? B.SNOWY_BEACH : B.BEACH;
    }
    const w = this.weights;
    this._climateWeights(t, cf[o + C_HM * os], x, z, w);
    let best = 0;
    for (let k = 1; k < NK; k++) if (w[k] > w[best]) best = k;
    if (m > 0.55 && h2 > 92) return B.MOUNTAINS;
    return K_BIOME[best];
  }

  _snowLine(t, sn) {
    return 158 - 34 * smoothstep(0.2, -1.2, t) + sn * 6;
  }

  // -------------------------------------------------------------------------
  // Working area: grid, density, extended columns
  // -------------------------------------------------------------------------

  /** Compute grid + density grid + extended column data for chunk (cx, cz). */
  _prepare(cx, cz) {
    const x0 = cx * 16;
    const z0 = cz * 16;
    const g = this.grid;
    // grid columns
    for (let j = 0; j < NG; j++) {
      for (let i = 0; i < NG; i++) {
        this._gridColumn(x0 - GOFF + i * GS, z0 - GOFF + j * GS, g, j * NG + i, NG2);
      }
    }
    // density grid
    const dens = this.gridDens;
    for (let j = 0; j < NG; j++) {
      for (let i = 0; i < NG; i++) {
        const gi = j * NG + i;
        const h = g[gi + G_H * NG2];
        const jag = g[gi + G_J * NG2];
        const wx = x0 - GOFF + i * GS;
        const wz = z0 - GOFF + j * GS;
        for (let l = 0; l < NLY; l++) dens[gi * NLY + l] = this._gridDensity(wx, l * GY, wz, h, jag);
      }
    }
    // extended columns
    const cf = this.colF;
    for (let lz = -EXT; lz < 16 + EXT; lz++) {
      for (let lx = -EXT; lx < 16 + EXT; lx++) {
        const e = (lz + EXT) * NE + (lx + EXT);
        const gxl = lx + GOFF;
        const gzl = lz + GOFF;
        const i = gxl >> 2;
        const j = gzl >> 2;
        const fx = (gxl & 3) / 4;
        const fz = (gzl & 3) / 4;
        const i00 = j * NG + i;
        this._column(x0 + lx, z0 + lz, g, NG2, i00, i00 + 1, i00 + NG, i00 + NG + 1, fx, fz, cf, e, NE2);
        this.colBiome[e] = this._classify(cf, e, NE2, x0 + lx, z0 + lz);
        // heights & water from the interpolated density. Outside every corner's noise band the density
        // is exactly (height - y), which bounds the scans.
        this._columnLevels(i00, fx, fz);
        const delta = cf[e + C_DELTA * NE2];
        const lv = this.levels;
        let hiBand = -1e9;
        let loBand = 1e9;
        for (let q = 0; q < 4; q++) {
          const gi = i00 + (q & 1) + (q >> 1) * NG;
          const hc = g[gi + G_H * NG2];
          const jc = g[gi + G_J * NG2] + 12;
          if (hc + jc > hiBand) hiBand = hc + jc;
          if (hc - jc < loBand) loBand = hc - jc;
        }
        const yHi = Math.min(255, Math.ceil(hiBand + Math.max(0, delta)) + GY);
        const yLo = Math.max(1, Math.floor(loBand + Math.min(0, delta)) - GY);
        let s = -1;
        for (let y = yHi; y >= 0; y--) {
          const l = y >> 3;
          const a = lv[l];
          const d = a + (lv[l + 1] - a) * ((y & 7) / 8) + delta;
          if (d > 0) {
            s = y;
            break;
          }
        }
        this.colS[e] = s;
        let wmin = NO_WATER;
        for (let y = yLo; y <= SEA_LEVEL; y++) {
          const l = y >> 3;
          const a = lv[l];
          const d = a + (lv[l + 1] - a) * ((y & 7) / 8) + delta;
          if (d <= 0) {
            wmin = y;
            break;
          }
        }
        this.colWater[e] = wmin;
      }
    }
    // slopes and top surface blocks
    for (let lz = -EXT + 1; lz < 16 + EXT - 1; lz++) {
      for (let lx = -EXT + 1; lx < 16 + EXT - 1; lx++) {
        const e = (lz + EXT) * NE + (lx + EXT);
        const s = this.colS[e];
        const sx = Math.max(Math.abs(this.colS[e + 1] - s), Math.abs(this.colS[e - 1] - s));
        const sz = Math.max(Math.abs(this.colS[e + NE] - s), Math.abs(this.colS[e - NE] - s));
        this.colSlope[e] = Math.min(255, Math.max(sx, sz));
        this.colTop[e] = this._surfaceBlock(e, s, s < SEA_LEVEL, 0, x0 + lx, z0 + lz);
        // Water protection: no carving within 3 blocks below any water in this column or its neighbours.
        let m = 255;
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            const w = this.colWater[e + dz * NE + dx];
            if (w !== NO_WATER && w - 4 < m) m = w - 4;
          }
        }
        this.colCeil[e] = m;
      }
    }
  }

  /** Bilinear density levels of the column at grid cell i00 with fractions fx, fz into this.levels. */
  _columnLevels(i00, fx, fz) {
    const dens = this.gridDens;
    const lv = this.levels;
    const a0 = i00 * NLY;
    const b0 = (i00 + 1) * NLY;
    const c0 = (i00 + NG) * NLY;
    const d0 = (i00 + NG + 1) * NLY;
    for (let l = 0; l < NLY; l++) {
      const a = dens[a0 + l];
      const b = dens[b0 + l];
      const c = dens[c0 + l];
      const d = dens[d0 + l];
      const ab = a + (b - a) * fx;
      const cd = c + (d - c) * fx;
      lv[l] = ab + (cd - ab) * fz;
    }
  }

  /**
   * Surface rule: block at `depth` below the top of a solid run whose top is at y = top.
   * underwater: the run is covered by water. Returns the block id (STONE when no special layer).
   */
  _surfaceBlock(e, top, underwater, depth, wx, wz) {
    const cf = this.colF;
    const biomeId = this.colBiome[e];
    const sn = cf[e + C_SN * NE2];
    const slope = this.colSlope[e];
    const soil = 3 + (sn > 0.35 ? 1 : 0) - (sn < -0.45 ? 1 : 0);
    if (underwater) {
      const depthW = SEA_LEVEL - top;
      if (depth >= soil) return (biomeId === B.DESERT || biomeId === B.BEACH) && depth < soil + 3 ? SANDSTONE : STONE;
      // floor material patches: smooth, fairly large blobs (no speckle)
      const p = fbm2D(this.nFloorMat, wx / 46, wz / 46, 2) / 0.55;
      if (biomeId === B.RIVER || biomeId === B.FROZEN_RIVER) {
        if (p > 0.55) return CLAY;
        if (p < -0.6) return GRAVEL;
        return p < -0.25 && depth > 0 ? DIRT : SAND;
      }
      if (cf[e + C_LAKE * NE2] > 0.05 && cf[e + C_C * NE2] > -0.3) {
        // inland lake floors: dirt with sand, clay and gravel patches
        if (p > 0.6 && depthW <= 5) return CLAY;
        if (p > 0.05) return SAND;
        if (p < -0.65) return GRAVEL;
        return DIRT;
      }
      if (depthW > 13) return p > 0.45 ? SAND : GRAVEL;
      if (depthW > 7) return p < -0.4 ? GRAVEL : SAND;
      if (p > 0.75 && biomeId !== B.DESERT) return CLAY;
      return SAND;
    }
    switch (biomeId) {
      case B.DESERT:
        if (depth < soil + 1) return SAND;
        if (depth < soil + 5) return SANDSTONE;
        return STONE;
      case B.BEACH:
      case B.SNOWY_BEACH:
        if (top > 66 && slope >= 3) break;
        if (biomeId === B.SNOWY_BEACH && depth === 0 && top > SEA_LEVEL) return SNOW;
        if (depth < soil) return sn < -0.6 && biomeId === B.BEACH ? GRAVEL : SAND;
        if (depth < soil + 2) return SANDSTONE;
        return STONE;
      case B.STONY_SHORE:
        return depth === 0 && sn > 0.5 ? GRAVEL : STONE;
      default:
        break;
    }
    if (depth >= soil) return STONE;
    // Mountain rules: stone on steep slopes; snow above the snow line.
    const t = cf[e + C_T * NE2];
    const snowLine = this._snowLine(t, sn);
    const m = cf[e + C_M * NE2];
    const steepLimit = m > 0.3 || top > 120 ? 3 : 6;
    if (top >= snowLine) {
      if (slope >= 4 + (top > snowLine + 20 ? 2 : 0)) return STONE;
      return depth < 2 ? SNOW : STONE;
    }
    if (slope >= steepLimit && top > 72) return STONE;
    if (top > snowLine - 14 && m > 0.2) return depth === 0 ? SNOWY_GRASS : DIRT;
    // Sand banks along rivers / lakes / coasts just above the water.
    if (top <= SEA_LEVEL + 1 && (biomeId === B.RIVER || cf[e + C_RIV * NE2] > 0.25)) return depth < soil ? SAND : STONE;
    const frozen = biomeId === B.SNOWY_PLAINS || biomeId === B.SNOWY_TAIGA || biomeId === B.SNOWY_BEACH ||
      biomeId === B.FROZEN_RIVER || biomeId === B.FROZEN_OCEAN || biomeId === B.SNOWY_PEAKS;
    if (depth === 0) return frozen ? SNOWY_GRASS : GRASS;
    return DIRT;
  }

  // -------------------------------------------------------------------------
  // Chunk generation
  // -------------------------------------------------------------------------

  /**
   * Generate a chunk. Deterministic; independent of generation order.
   * @returns {Uint8Array} 65536 block ids, index (y << 8) | (z << 4) | x
   */
  generateChunk(cx, cz) {
    const blocks = new Uint8Array(65536);
    if (this.worldType === 'flat') {
      for (let i = 0; i < 256; i++) {
        blocks[i] = BEDROCK;
        blocks[256 + i] = DIRT;
        blocks[512 + i] = DIRT;
        blocks[768 + i] = GRASS;
      }
      return blocks;
    }
    this._prepare(cx, cz);
    this._fillTerrain(cx, cz, blocks);
    this._carveCaves(cx, cz, blocks);
    this._carveRavines(cx, cz, blocks);
    this._fixHanging(blocks);
    this._placeBedrock(cx, cz, blocks);
    this._placeOres(cx, cz, blocks);
    this._placeTrees(cx, cz, blocks);
    this._placePlants(cx, cz, blocks);
    return blocks;
  }

  _fillTerrain(cx, cz, blocks) {
    const x0 = cx * 16;
    const z0 = cz * 16;
    const cf = this.colF;
    const lv = this.levels;
    for (let lz = 0; lz < 16; lz++) {
      for (let lx = 0; lx < 16; lx++) {
        const e = (lz + EXT) * NE + (lx + EXT);
        const gxl = lx + GOFF;
        const gzl = lz + GOFF;
        const i00 = (gzl >> 2) * NG + (gxl >> 2);
        this._columnLevels(i00, (gxl & 3) / 4, (gzl & 3) / 4);
        const delta = cf[e + C_DELTA * NE2];
        const s = this.colS[e];
        const base = (lz << 4) | lx;
        // raw fill: stone / water / air
        for (let y = 0; y <= s; y++) {
          const l = y >> 3;
          const a = lv[l];
          const d = a + (lv[l + 1] - a) * ((y & 7) / 8) + delta;
          blocks[(y << 8) | base] = d > 0 ? STONE : y <= SEA_LEVEL ? WATER : AIR;
        }
        for (let y = s + 1; y <= SEA_LEVEL; y++) blocks[(y << 8) | base] = WATER;
        // surface rules for every solid run (top-down)
        let depth = -1;
        let runTop = 0;
        let underwater = false;
        for (let y = s; y >= 0; y--) {
          const i = (y << 8) | base;
          if (blocks[i] !== STONE) {
            depth = -1;
            continue;
          }
          if (depth < 0) {
            runTop = y;
            underwater = y < 255 && blocks[i + 256] === WATER;
            depth = 0;
          }
          if (depth < 12) {
            const b = depth === 0 && runTop === s ? this.colTop[e] : this._surfaceBlock(e, runTop, underwater, depth, x0 + lx, z0 + lz);
            if (b !== STONE) blocks[i] = b;
            else if (depth > 0) depth = 99; // reached plain stone: rest of the run stays stone
          }
          depth++;
        }
        // frozen water surface: rivers / lakes freeze over, frozen oceans get ragged ice sheets
        if (s < SEA_LEVEL && this._frozenAt(e, x0 + lx, z0 + lz)) {
          const i = (SEA_LEVEL << 8) | base;
          if (blocks[i] === WATER) blocks[i] = ICE;
        }
      }
    }
  }

  /** Is the water surface of extended column e frozen? */
  _frozenAt(e, wx, wz) {
    const cf = this.colF;
    const fr = cf[e + C_FREEZE * NE2];
    if (fr <= 0.5) return false;
    const b = this.colBiome[e];
    if (b !== B.FROZEN_OCEAN) return true;
    // ocean ice: patchy sheets, denser where colder
    const t = cf[e + C_T * NE2];
    const cover = 0.92 * smoothstep(-0.96, -1.45, t);
    const n = 0.5 + 0.5 * fbm2D(this.nIce, wx / 34, wz / 34, 2) / 0.6;
    return n < cover;
  }

  _carveCaves(cx, cz, blocks) {
    const x0 = cx * 16;
    const z0 = cz * 16;
    // Highest terrain in the chunk bounds the cave grid.
    let maxS = 0;
    for (let lz = 0; lz < 16; lz++) {
      for (let lx = 0; lx < 16; lx++) {
        const s = this.colS[(lz + EXT) * NE + lx + EXT];
        if (s > maxS) maxS = s;
      }
    }
    const topLevel = Math.min(NCY - 1, ((maxS + 1) >> 2) + 1);
    // Cave noise on a 4x4x4 world-aligned grid. The raw noise fields are interpolated per block and
    // combined afterwards, so thin tunnels survive the coarse sampling.
    //   0 cheese: large caverns (mostly deep)
    //   1,2 a1/b1 + 3 r1: spaghetti tunnels = where both noises are ~0 (radius r1 varies along them)
    //   4,5 a2/b2: a second, smaller tunnel network
    const cg = this.caveGrid;
    for (let j = 0; j < NCG; j++) {
      for (let i = 0; i < NCG; i++) {
        const wx = x0 + i * 4;
        const wz = z0 + j * 4;
        const base = (j * NCG + i) * NCY * NCV;
        for (let l = 0; l <= topLevel; l++) {
          const wy = l * CY;
          const o = base + l * NCV;
          const ch = fbm3D(this.nCheese, wx / 84, wy / 52, wz / 84, 2);
          cg[o] = (ch - 0.52 + 0.17 * smoothstep(70, 20, wy)) * 2.2;
          cg[o + 1] = this.nSpagA.noise3D(wx / 80, wy / 58, wz / 80);
          cg[o + 2] = this.nSpagB.noise3D(wx / 80, wy / 58, wz / 80);
          cg[o + 3] = 0.105 + 0.05 * this.nSpagR.noise3D(wx / 160, wy / 120, wz / 160);
          cg[o + 4] = this.nSpag2A.noise3D(wx / 50, wy / 38, wz / 50);
          cg[o + 5] = this.nSpag2B.noise3D(wx / 50, wy / 38, wz / 50);
        }
      }
    }
    const R2SQ = 0.07 * 0.07;
    const cf = this.colF;
    const lv = this.caveLv;
    for (let lz = 0; lz < 16; lz++) {
      for (let lx = 0; lx < 16; lx++) {
        const e = (lz + EXT) * NE + (lx + EXT);
        const s = this.colS[e];
        const top = Math.min(s, this.colCeil[e]);
        if (top < 1) continue;
        // bilinear per level for this column
        const i = lx >> 2;
        const j = lz >> 2;
        const fx = (lx & 3) / 4;
        const fz = (lz & 3) / 4;
        const p00 = (j * NCG + i) * NCY * NCV;
        const p10 = (j * NCG + i + 1) * NCY * NCV;
        const p01 = ((j + 1) * NCG + i) * NCY * NCV;
        const p11 = ((j + 1) * NCG + i + 1) * NCY * NCV;
        const kmax = (Math.min(topLevel, (top >> 2) + 1) + 1) * NCV;
        for (let k = 0; k < kmax; k++) {
          const ab = cg[p00 + k] + (cg[p10 + k] - cg[p00 + k]) * fx;
          const cd = cg[p01 + k] + (cg[p11 + k] - cg[p01 + k]) * fx;
          lv[k] = ab + (cd - ab) * fz;
        }
        const entrance = smoothstep(0.55, 0.9, cf[e + C_ENT * NE2]); // 0 = sealed surface
        const base = (lz << 4) | lx;
        for (let y = 1; y <= top; y++) {
          const i2 = (y << 8) | base;
          if (CARVABLE[blocks[i2]] === 0) continue;
          const t = (y & 3) / 4;
          const k = (y >> 2) * NCV;
          const depth = s - y;
          let cheese = lv[k] + (lv[k + NCV] - lv[k]) * t;
          if (depth < 14) cheese -= (14 - depth) * 0.08;
          let carve = cheese > 0;
          if (!carve) {
            const a1 = lv[k + 1] + (lv[k + NCV + 1] - lv[k + 1]) * t;
            const b1 = lv[k + 2] + (lv[k + NCV + 2] - lv[k + 2]) * t;
            const r1 = lv[k + 3] + (lv[k + NCV + 3] - lv[k + 3]) * t;
            const a2 = lv[k + 4] + (lv[k + NCV + 4] - lv[k + 4]) * t;
            const b2 = lv[k + 5] + (lv[k + NCV + 5] - lv[k + 5]) * t;
            let spag = 1 - (a1 * a1 + b1 * b1) / (r1 * r1);
            const sp2 = 1 - (a2 * a2 + b2 * b2) / R2SQ;
            if (sp2 > spag) spag = sp2;
            // tunnels pinch off below the surface except in cave-entrance zones
            if (depth < 9) spag -= (9 - depth) * 0.17 * (1 - entrance);
            carve = spag > 0;
          }
          if (carve) blocks[i2] = y <= 10 ? LAVA : AIR;
        }
      }
    }
  }

  /**
   * Minecraft-style canyon carver. Ravines start in ~1/70 chunks and run up to ~112 blocks; every chunk
   * within reach replays the same path (seeded by the origin chunk) and carves its own part. Columns of
   * the extended area whose ground block is cut are flagged in ravineMask (trees must not use them).
   */
  _carveRavines(cx, cz, blocks) {
    const x0 = cx * 16;
    const z0 = cz * 16;
    const mask = this.ravineMask;
    mask.fill(0);
    const wf = this.ravineWidth;
    for (let dz = -RAVINE_RANGE; dz <= RAVINE_RANGE; dz++) {
      for (let dx = -RAVINE_RANGE; dx <= RAVINE_RANGE; dx++) {
        const ncx = cx + dx;
        const ncz = cz + dz;
        if (hash3i(this.sRavine, ncx, 0, ncz) / 4294967296 >= RAVINE_CHANCE) continue;
        const rng = mulberry32(hash3i(this.sRavine, ncx, 1, ncz));
        let x = ncx * 16 + rng() * 16;
        let z = ncz * 16 + rng() * 16;
        let y = 22 + rng() * 44;
        let yaw = rng() * Math.PI * 2;
        let pitch = (rng() - 0.5) / 4;
        const thick = (rng() * 2 + rng()) * 2;
        const len = Math.floor(112 * (0.75 + rng() * 0.25));
        const hFactor = 0.75 + rng() * 0.25;
        // quick reject: the whole ravine stays within len + 8 blocks of its start
        if (x + len + 8 < x0 - EXT || x - len - 8 > x0 + 15 + EXT || z + len + 8 < z0 - EXT || z - len - 8 > z0 + 15 + EXT) continue;
        let f = 1;
        for (let i = 0; i < 256; i++) {
          if (i === 0 || rng() < 1 / 3) f = 1 + rng() * rng();
          wf[i] = f * f;
        }
        let dyaw = 0;
        let dpitch = 0;
        for (let j = 0; j < len; j++) {
          const hr = (1.5 + Math.sin((j * Math.PI) / len) * thick) * hFactor;
          const vr = hr * 3;
          const cp = Math.cos(pitch);
          x += Math.cos(yaw) * cp;
          y += Math.sin(pitch);
          z += Math.sin(yaw) * cp;
          pitch *= 0.7;
          pitch += dpitch * 0.05;
          yaw += dyaw * 0.05;
          dpitch *= 0.8;
          dyaw *= 0.5;
          dpitch += (rng() - rng()) * rng() * 2;
          dyaw += (rng() - rng()) * rng() * 4;
          if (rng() < 0.25) continue;
          if (x + hr < x0 - EXT || x - hr > x0 + 15 + EXT || z + hr < z0 - EXT || z - hr > z0 + 15 + EXT) continue;
          const vext = vr * 2.45; // the /6 below stretches the ellipsoid vertically by sqrt(6)
          const bx0 = Math.max(x0 - EXT + 1, Math.floor(x - hr));
          const bx1 = Math.min(x0 + 15 + EXT - 1, Math.floor(x + hr));
          const bz0 = Math.max(z0 - EXT + 1, Math.floor(z - hr));
          const bz1 = Math.min(z0 + 15 + EXT - 1, Math.floor(z + hr));
          const by0 = Math.max(1, Math.floor(y - vext));
          const by1 = Math.min(250, Math.floor(y + vext));
          for (let bz = bz0; bz <= bz1; bz++) {
            const ndz = (bz + 0.5 - z) / hr;
            for (let bx = bx0; bx <= bx1; bx++) {
              const ndx = (bx + 0.5 - x) / hr;
              const h2 = ndx * ndx + ndz * ndz;
              if (h2 >= 1) continue;
              const lx = bx - x0;
              const lz = bz - z0;
              const e = (lz + EXT) * NE + (lx + EXT);
              const ceil = this.colCeil[e];
              // ground of this column cut? (also for margin columns: trees must not stand there)
              const gs = this.colS[e];
              if (gs >= by0 && gs <= by1 && gs <= ceil) {
                const ndy = (gs + 0.5 - y) / vr;
                if (h2 * wf[gs] + (ndy * ndy) / 6 < 1) mask[e] = 1;
              }
              if (blocks === null || lx < 0 || lx > 15 || lz < 0 || lz > 15) continue;
              const top = Math.min(by1, ceil);
              const base = (lz << 4) | lx;
              for (let by = by0; by <= top; by++) {
                const ndy = (by + 0.5 - y) / vr;
                if (h2 * wf[by] + (ndy * ndy) / 6 >= 1) continue;
                const i = (by << 8) | base;
                if (CARVABLE[blocks[i]] === 1) blocks[i] = by <= 10 ? LAVA : AIR;
              }
            }
          }
        }
      }
    }
  }

  /** Sand / gravel left hanging over carved air becomes sandstone / stone (no falling at load). */
  _fixHanging(blocks) {
    for (let c = 0; c < 256; c++) {
      for (let y = 1; y < 255; y++) {
        const i = (y << 8) | c;
        if (blocks[i] !== AIR) continue;
        const above = blocks[i + 256];
        if (above === SAND) blocks[i + 256] = SANDSTONE;
        else if (above === GRAVEL) blocks[i + 256] = STONE;
      }
    }
  }

  _placeBedrock(cx, cz, blocks) {
    const x0 = cx * 16;
    const z0 = cz * 16;
    for (let lz = 0; lz < 16; lz++) {
      for (let lx = 0; lx < 16; lx++) {
        const base = (lz << 4) | lx;
        blocks[base] = BEDROCK;
        for (let y = 1; y <= 4; y++) {
          const r = hash3i(this.sBedrock, x0 + lx, y, z0 + lz) / 4294967296;
          if (r < (5 - y) / 5) blocks[(y << 8) | base] = BEDROCK;
        }
      }
    }
  }

  _placeOres(cx, cz, blocks) {
    const x0 = cx * 16;
    const z0 = cz * 16;
    for (let oi = 0; oi < ORES.length; oi++) {
      const ore = ORES[oi];
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const ncx = cx + dx;
          const ncz = cz + dz;
          const crng = mulberry32(hash3i(this.sOre, ncx, oi, ncz));
          let count = Math.floor(ore.count);
          if (crng() < ore.count - count) count++;
          for (let v = 0; v < count; v++) {
            const vx = ncx * 16 + Math.floor(crng() * 16);
            const vz = ncz * 16 + Math.floor(crng() * 16);
            let vy;
            if (ore.dist === 'triangle') {
              vy = Math.floor(ore.min + (crng() + crng()) * 0.5 * (ore.max - ore.min));
            } else {
              vy = Math.floor(ore.min + crng() * (ore.max - ore.min));
            }
            const vseed = (crng() * 4294967296) >>> 0;
            if (vx + ORE_REACH < x0 || vx - ORE_REACH > x0 + 15 || vz + ORE_REACH < z0 || vz - ORE_REACH > z0 + 15) continue;
            this._vein(blocks, x0, z0, vx, vy, vz, ore.size, ore.block, vseed);
          }
        }
      }
    }
  }

  /** Minecraft's classic ore vein: spheres of varying radius along a short random line segment. */
  _vein(blocks, x0, z0, vx, vy, vz, size, id, vseed) {
    const rng = mulberry32(vseed);
    const ang = rng() * Math.PI;
    const sx = Math.sin(ang) * size / 8;
    const sz = Math.cos(ang) * size / 8;
    const ax = vx + 0.5 + sx;
    const bx = vx + 0.5 - sx;
    const az = vz + 0.5 + sz;
    const bz = vz + 0.5 - sz;
    const ay = vy + Math.floor(rng() * 3) - 1;
    const by = vy + Math.floor(rng() * 3) - 1;
    for (let i = 0; i < size; i++) {
      const f = i / size;
      const px = ax + (bx - ax) * f;
      const py = ay + (by - ay) * f;
      const pz = az + (bz - az) * f;
      const r = ((Math.sin(Math.PI * f) + 1) * rng() * size / 16 + 1) / 2;
      const minX = Math.max(x0, Math.floor(px - r));
      const maxX = Math.min(x0 + 15, Math.floor(px + r));
      const minY = Math.max(1, Math.floor(py - r));
      const maxY = Math.min(254, Math.floor(py + r));
      const minZ = Math.max(z0, Math.floor(pz - r));
      const maxZ = Math.min(z0 + 15, Math.floor(pz + r));
      const r2 = r * r;
      for (let y = minY; y <= maxY; y++) {
        const ddy = y + 0.5 - py;
        for (let z = minZ; z <= maxZ; z++) {
          const ddz = z + 0.5 - pz;
          for (let x = minX; x <= maxX; x++) {
            const ddx = x + 0.5 - px;
            if (ddx * ddx + ddy * ddy + ddz * ddz >= r2) continue;
            const idx = (y << 8) | ((z - z0) << 4) | (x - x0);
            if (ORE_HOST[blocks[idx]] === 1) blocks[idx] = id;
          }
        }
      }
    }
  }

  // ---- trees -----------------------------------------------------------------

  /**
   * Deterministic tree for a world cell, or null. Uses only extended-column data, so every chunk the
   * tree touches derives exactly the same tree. Returns { kind, x, y, z, seed } (reused object).
   */
  _treeForCell(gx, gz, x0, z0, out) {
    const h = hash3i(this.sTree, gx, 0, gz);
    const tx = gx * TREE_CELL + (h & 0xff) % 3;
    const tz = gz * TREE_CELL + ((h >>> 8) & 0xff) % 3;
    const lx = tx - x0;
    const lz = tz - z0;
    if (lx < -EXT + 1 || lx >= 16 + EXT - 1 || lz < -EXT + 1 || lz >= 16 + EXT - 1) return null;
    const e = (lz + EXT) * NE + (lx + EXT);
    const s = this.colS[e];
    if (s < SEA_LEVEL || s > 200) return null;
    if (TREE_SOIL[this.colTop[e]] === 0) return null;
    if (this.colWater[e] !== NO_WATER && this.colWater[e] > s) return null;
    if (this.colSlope[e] > 2) return null;
    const cf = this.colF;
    // ground must be intact (caves may open the surface only in entrance zones)
    if (smoothstep(0.55, 0.9, cf[e + C_ENT * NE2]) > 0 || this.ravineMask[e] === 1) return null;
    const biomeId = this.colBiome[e];
    const w = this.weights;
    this._climateWeights(cf[e + C_T * NE2], cf[e + C_HM * NE2], tx, tz, w);
    let p = 0;
    for (let k = 0; k < NK; k++) p += w[k] * K_TREE_P[k];
    const m = cf[e + C_M * NE2];
    if (biomeId === B.MOUNTAINS) p = 0.1;
    else if (biomeId === B.SNOWY_PEAKS || biomeId === B.BEACH || biomeId === B.SNOWY_BEACH ||
      biomeId === B.STONY_SHORE || biomeId === B.DESERT || biomeId === B.RIVER || biomeId === B.FROZEN_RIVER) p = 0;
    // thinning near the tree line and on river banks
    p *= 1 - smoothstep(118, 150, s);
    p *= 1 - cf[e + C_RIV * NE2];
    const r1 = ((h >>> 16) & 0xff) / 256 + (hash3i(this.sTree, gz, 3, gx) & 0xff) / 65536;
    if (r1 >= p) return null;
    // tree kind from the climate mix
    const r2 = ((h >>> 24) & 0xff) / 256;
    const rng = mulberry32(hash3i(this.sTree, gx, 1, gz));
    let kind;
    const coldW = w[K_SNOWY] + w[K_SNOWY_TAIGA] + w[K_TAIGA];
    const birchW = w[K_BIRCH];
    if (biomeId === B.MOUNTAINS || s > 105 || m > 0.5) {
      kind = r2 < 0.75 || coldW > 0.3 ? (rng() < 0.3 ? TREE_PINE : TREE_SPRUCE) : TREE_OAK;
    } else if (r2 < coldW) {
      kind = rng() < 0.33 ? TREE_PINE : TREE_SPRUCE;
    } else if (r2 < coldW + birchW) {
      kind = rng() < 0.25 ? TREE_BIRCH_TALL : TREE_BIRCH;
    } else {
      const birchy = w[K_FOREST] + w[K_FLOWER];
      const q = rng();
      if (q < 0.18 * birchy) kind = TREE_BIRCH;
      else if (q < 0.18 * birchy + (w[K_PLAINS] > 0.5 ? 0.35 : 0.1)) kind = TREE_OAK_LARGE;
      else kind = TREE_OAK;
    }
    out.kind = kind;
    out.x = tx;
    out.y = s + 1;
    out.z = tz;
    out.seed = hash3i(this.sTree, gx, 2, gz);
    return out;
  }

  _placeTrees(cx, cz, blocks) {
    const x0 = cx * 16;
    const z0 = cz * 16;
    const gx0 = Math.floor((x0 - TREE_REACH) / TREE_CELL);
    const gx1 = Math.floor((x0 + 15 + TREE_REACH) / TREE_CELL);
    const gz0 = Math.floor((z0 - TREE_REACH) / TREE_CELL);
    const gz1 = Math.floor((z0 + 15 + TREE_REACH) / TREE_CELL);
    const tree = { kind: 0, x: 0, y: 0, z: 0, seed: 0 };
    const list = this.treeTmp;
    // Global order: cells by (z, x). Logs replace leaves; leaves only fill air -> order-independent.
    for (let gz = gz0; gz <= gz1; gz++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        if (!this._treeForCell(gx, gz, x0, z0, tree)) continue;
        if (tree.x + TREE_REACH < x0 || tree.x - TREE_REACH > x0 + 15 ||
          tree.z + TREE_REACH < z0 || tree.z - TREE_REACH > z0 + 15) continue;
        list.reset();
        const h = buildTree(list, tree.kind, mulberry32(tree.seed), tree.x, tree.y, tree.z);
        if (tree.y + h + 3 > 255) continue;
        for (let k = 0; k < list.n; k++) {
          const lx = list.x[k] - x0;
          const lz = list.z[k] - z0;
          const y = list.y[k];
          if (lx < 0 || lx > 15 || lz < 0 || lz > 15 || y < 0 || y > 255) continue;
          const idx = (y << 8) | (lz << 4) | lx;
          const cur = blocks[idx];
          const id = list.id[k];
          if (IS_LOG[id]) {
            if (cur === AIR || IS_LEAVES[cur] || (IS_REPLACEABLE[cur] && !IS_LIQUID[cur])) blocks[idx] = id;
          } else if (cur === AIR) {
            blocks[idx] = id;
          }
        }
        // soil under the trunk becomes dirt (Minecraft behaviour)
        const tlx = tree.x - x0;
        const tlz = tree.z - z0;
        if (tlx >= 0 && tlx < 16 && tlz >= 0 && tlz < 16) {
          const gi = ((tree.y - 1) << 8) | (tlz << 4) | tlx;
          if (blocks[gi] === GRASS || blocks[gi] === SNOWY_GRASS) blocks[gi] = DIRT;
        }
      }
    }
  }

  // ---- plants ----------------------------------------------------------------

  _placePlants(cx, cz, blocks) {
    const x0 = cx * 16;
    const z0 = cz * 16;
    const cf = this.colF;
    // Desert cell grid: cacti / dead bushes at offsets 1..2 within 4x4 cells (never adjacent).
    for (let gz = cz * 4; gz < cz * 4 + 4; gz++) {
      for (let gx = cx * 4; gx < cx * 4 + 4; gx++) {
        const h = hash3i(this.sDesert, gx, 0, gz);
        const tx = gx * DESERT_CELL + 1 + (h & 1);
        const tz = gz * DESERT_CELL + 1 + ((h >>> 1) & 1);
        const lx = tx - x0;
        const lz = tz - z0;
        const e = (lz + EXT) * NE + (lx + EXT);
        if (this.colBiome[e] !== B.DESERT) continue;
        const r = ((h >>> 4) & 0xffff) / 65536;
        const s = this.colS[e];
        if (s < SEA_LEVEL + 1 || s > 250) continue;
        const gi = (s << 8) | (lz << 4) | lx;
        if (blocks[gi] !== SAND || blocks[gi + 256] !== AIR) continue;
        if (r < 0.09) {
          if (!this._cactusOk(e, s, lx, lz, blocks)) continue;
          const hr = (h >>> 20) & 7;
          const height = hr < 3 ? 1 : hr < 6 ? 2 : 3;
          for (let k = 1; k <= height; k++) blocks[gi + 256 * k] = CACTUS;
        } else if (r < 0.2) {
          blocks[gi + 256] = DEAD_BUSH;
        }
      }
    }

    // Column plants
    for (let lz = 0; lz < 16; lz++) {
      for (let lx = 0; lx < 16; lx++) {
        const e = (lz + EXT) * NE + (lx + EXT);
        const wx = x0 + lx;
        const wz = z0 + lz;
        const base = (lz << 4) | lx;
        // find the actual top (trees may cover the column)
        let y = this.colS[e];
        if (y < 1 || y > 252) continue;
        const gi = (y << 8) | base;
        const ground = blocks[gi];
        if (blocks[gi + 256] !== AIR) continue;
        const biomeId = this.colBiome[e];
        const rnd = hash3i(this.sPlant, wx, y, wz);
        const r = (rnd & 0xffff) / 65536;
        const r2 = (rnd >>> 16) / 65536;
        // sugar cane on shores
        if (y === SEA_LEVEL && (ground === GRASS || ground === SAND || ground === DIRT) && cf[e + C_FREEZE * NE2] < 0.5) {
          if (this._waterAdjacent(e, lx, lz, blocks) && r < 0.2 + 0.25 * this.nPatch.noise2D(wx / 10, wz / 10)) {
            const height = 1 + Math.floor(r2 * 3);
            for (let k = 1; k <= height; k++) blocks[gi + 256 * k] = SUGAR_CANE;
            continue;
          }
        }
        if (ground !== GRASS && ground !== SNOWY_GRASS) continue;
        const patch = 0.5 + 0.5 * this.nPatch.noise2D(wx / 14, wz / 14);
        let grassP = 0;
        let fernP = 0;
        let flowerP = 0;
        let mushroomP = 0;
        switch (biomeId) {
          case B.PLAINS: grassP = 0.12 + 0.45 * patch; flowerP = 0.012 + 0.05 * Math.max(0, patch - 0.6); break;
          case B.FOREST: grassP = 0.06 + 0.2 * patch; fernP = 0.01; flowerP = 0.01; mushroomP = 0.025; break;
          case B.FLOWER_FOREST: grassP = 0.05 + 0.12 * patch; flowerP = 0.12 + 0.12 * patch; mushroomP = 0.01; break;
          case B.BIRCH_FOREST: grassP = 0.08 + 0.25 * patch; flowerP = 0.015; mushroomP = 0.015; break;
          case B.TAIGA: grassP = 0.05 + 0.12 * patch; fernP = 0.06 + 0.18 * patch; mushroomP = 0.03; break;
          case B.SNOWY_TAIGA: fernP = 0.03 * patch; mushroomP = 0.01; break;
          case B.SNOWY_PLAINS: grassP = 0.008; break;
          case B.MOUNTAINS: grassP = 0.04 + 0.1 * patch; flowerP = 0.004; break;
          default: grassP = 0.04 + 0.1 * patch; break;
        }
        if (ground === SNOWY_GRASS) {
          grassP *= 0.2;
          flowerP = 0;
        }
        const pick = r;
        if (pick < grassP) {
          blocks[gi + 256] = SHORT_GRASS;
        } else if (pick < grassP + fernP) {
          blocks[gi + 256] = FERN;
        } else if (pick < grassP + fernP + flowerP) {
          blocks[gi + 256] = this._flowerAt(wx, wz, biomeId, r2);
        } else if (mushroomP > 0 && pick < grassP + fernP + flowerP + mushroomP && this._shaded(blocks, gi)) {
          blocks[gi + 256] = r2 < 0.6 ? BROWN_MUSHROOM : RED_MUSHROOM;
        }
      }
    }

    // Rare pumpkin patches (kept inside the chunk).
    const prng = mulberry32(hash3i(this.sPumpkin, cx, 0, cz));
    if (prng() < 1 / 40) {
      const pcx = 3 + Math.floor(prng() * 10);
      const pcz = 3 + Math.floor(prng() * 10);
      const n = 3 + Math.floor(prng() * 6);
      for (let k = 0; k < n * 2; k++) {
        const lx = pcx + Math.floor(prng() * 7) - 3;
        const lz = pcz + Math.floor(prng() * 7) - 3;
        const e = (lz + EXT) * NE + (lx + EXT);
        const bId = this.colBiome[e];
        if (bId !== B.PLAINS && bId !== B.FOREST && bId !== B.TAIGA && bId !== B.BIRCH_FOREST &&
          bId !== B.FLOWER_FOREST && bId !== B.MOUNTAINS) continue;
        const y = this.colS[e];
        if (y < SEA_LEVEL || y > 250) continue;
        const gi = (y << 8) | (lz << 4) | lx;
        const above = blocks[gi + 256];
        if (blocks[gi] === GRASS && (above === AIR || above === SHORT_GRASS || above === FERN)) blocks[gi + 256] = PUMPKIN;
      }
    }

    // Mushrooms on dark cave floors.
    for (let lz = 0; lz < 16; lz++) {
      for (let lx = 0; lx < 16; lx++) {
        const e = (lz + EXT) * NE + (lx + EXT);
        const s = this.colS[e];
        const base = (lz << 4) | lx;
        for (let y = 12; y < s - 8; y++) {
          const i = (y << 8) | base;
          if (blocks[i] !== AIR) continue;
          const below = blocks[i - 256];
          if (below !== STONE && below !== DIRT && below !== GRANITE && below !== ANDESITE && below !== DIORITE && below !== GRAVEL) continue;
          const r = hash3i(this.sPlant, x0 + lx, y, z0 + lz) / 4294967296;
          if (r >= 0.006) continue;
          // only in the dark: some solid block must cover the cell (not an open ravine floor)
          let roof = false;
          for (let k = y + 1; k <= s && !roof; k++) roof = blocks[(k << 8) | base] !== AIR;
          if (roof) blocks[i] = r < 0.0035 ? BROWN_MUSHROOM : RED_MUSHROOM;
        }
      }
    }
  }

  _flowerAt(wx, wz, biomeId, r) {
    // Flower patches of one dominant species (low-frequency noise), with some mixing.
    const n = this.nFlower.noise2D(wx / 48, wz / 48);
    const pick = r < 0.75 ? n : this.nFlower.noise2D(wz / 9, wx / 9);
    if (biomeId === B.FLOWER_FOREST) {
      if (pick < -0.35) return CORNFLOWER;
      if (pick < 0.0) return OXEYE_DAISY;
      if (pick < 0.35) return POPPY;
      return DANDELION;
    }
    if (pick < -0.5) return CORNFLOWER;
    if (pick < -0.2) return OXEYE_DAISY;
    if (pick < 0.3) return POPPY;
    return DANDELION;
  }

  /** True if a leaves block covers this ground block within 12 blocks (forest floor shade). */
  _shaded(blocks, gi) {
    for (let k = 2; k <= 14; k++) {
      const i = gi + 256 * k;
      if (i >= 65536) return false;
      if (IS_LEAVES[blocks[i]]) return true;
    }
    return false;
  }

  _waterAdjacent(e, lx, lz, blocks) {
    const y = SEA_LEVEL;
    const nb = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const [dx, dz] of nb) {
      const nx = lx + dx;
      const nz = lz + dz;
      if (nx >= 0 && nx < 16 && nz >= 0 && nz < 16) {
        if (blocks[(y << 8) | (nz << 4) | nx] === WATER) return true;
      } else {
        const ne = e + dz * NE + dx;
        if (this.colWater[ne] !== NO_WATER && this.colS[ne] < y && this.colF[ne + C_FREEZE * NE2] <= 0.5) return true;
      }
    }
    return false;
  }

  /**
   * Cactus rules: all 4 neighbours lower than the cactus base, only desert (so no trees, grass or
   * flowers) within the tree reach, and no water nearby (so no sugar cane can grow next to it).
   */
  _cactusOk(e, s, lx, lz, blocks) {
    for (let dz = -TREE_REACH; dz <= TREE_REACH; dz++) {
      for (let dx = -TREE_REACH; dx <= TREE_REACH; dx++) {
        const ne = e + dz * NE + dx;
        if (this.colBiome[ne] !== B.DESERT) return false;
        if (this.colWater[ne] !== NO_WATER) return false;
      }
    }
    const nb = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const [dx, dz] of nb) {
      const ne = e + dz * NE + dx;
      if (this.colS[ne] > s) return false;
      const nx = lx + dx;
      const nz = lz + dz;
      if (nx >= 0 && nx < 16 && nz >= 0 && nz < 16) {
        for (let k = 1; k <= 3; k++) {
          if (blocks[((s + k) << 8) | (nz << 4) | nx] !== AIR) return false;
        }
      }
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  /** Column data for a single world column into this._colOne (same arithmetic as _prepare). */
  _singleColumn(x, z) {
    const gx = Math.floor(x / GS) * GS;
    const gz = Math.floor(z / GS) * GS;
    const g = this._gridQuad || (this._gridQuad = new Float64Array(NGF * 4));
    this._gridColumn(gx, gz, g, 0, 4);
    this._gridColumn(gx + GS, gz, g, 1, 4);
    this._gridColumn(gx, gz + GS, g, 2, 4);
    this._gridColumn(gx + GS, gz + GS, g, 3, 4);
    const fx = (x - gx) / 4;
    const fz = (z - gz) / 4;
    this._column(x, z, g, 4, 0, 1, 2, 3, fx, fz, this._colOne, 0, 1);
    return this._colOne;
  }

  /**
   * Cheap 2D sample of a column (no 3D terrain): { biome, height, river, c, e, t, hm, m }.
   * Used by tools / map previews; `height` is the 2D surface estimate (exact except for 3D overhangs).
   */
  sampleColumn(x, z) {
    x = Math.floor(x);
    z = Math.floor(z);
    if (this.worldType === 'flat') return { biome: B.PLAINS, height: 3, river: 0, c: 0, e: 0, t: 0, hm: 0, m: 0 };
    const cf = this._singleColumn(x, z);
    return {
      biome: this._classify(cf, 0, 1, x, z), height: cf[C_H2], river: cf[C_RIV], c: cf[C_C], e: cf[C_E],
      t: cf[C_T], hm: cf[C_HM], m: cf[C_M],
    };
  }

  /**
   * Biome at a world column (for the debug screen etc.).
   * @returns {object} entry of BIOMES
   */
  getBiome(x, z) {
    if (this.worldType === 'flat') return BIOMES[B.PLAINS];
    x = Math.floor(x);
    z = Math.floor(z);
    const cf = this._singleColumn(x, z);
    return BIOMES[this._classify(cf, 0, 1, x, z)];
  }

  /**
   * Smooth grass / foliage tints per column, packed r | g<<8 | b<<16, index z*16+x.
   * @returns {{ grass: Uint32Array, foliage: Uint32Array }}
   */
  getTints(cx, cz) {
    const key = cx + ',' + cz;
    const cached = this._tintCache.get(key);
    if (cached) return { grass: cached.grass.slice(), foliage: cached.foliage.slice() };
    const grass = new Uint32Array(256);
    const foliage = new Uint32Array(256);
    if (this.worldType === 'flat') {
      grass.fill(packRGB(TINT_COLORS.plains[0]));
      foliage.fill(packRGB(TINT_COLORS.plains[1]));
    } else {
      const x0 = cx * 16;
      const z0 = cz * 16;
      const g = this._tintGrid || (this._tintGrid = new Float64Array(NGF * 25));
      for (let j = 0; j < 5; j++) {
        for (let i = 0; i < 5; i++) this._gridColumn(x0 + i * 4, z0 + j * 4, g, j * 5 + i, 25);
      }
      const col = this._colOne;
      const w = this.weights;
      for (let lz = 0; lz < 16; lz++) {
        for (let lx = 0; lx < 16; lx++) {
          const i00 = (lz >> 2) * 5 + (lx >> 2);
          this._column(x0 + lx, z0 + lz, g, 25, i00, i00 + 1, i00 + 5, i00 + 6, (lx & 3) / 4, (lz & 3) / 4, col, 0, 1);
          const t = col[C_T];
          this._climateWeights(t, col[C_HM], x0 + lx, z0 + lz, w);
          let gr = 0, gg = 0, gb = 0, fr = 0, fg = 0, fb = 0;
          for (let k = 0; k < NK; k++) {
            const wk = w[k];
            gr += wk * K_GRASS_RGB[k * 3]; gg += wk * K_GRASS_RGB[k * 3 + 1]; gb += wk * K_GRASS_RGB[k * 3 + 2];
            fr += wk * K_FOLIAGE_RGB[k * 3]; fg += wk * K_FOLIAGE_RGB[k * 3 + 1]; fb += wk * K_FOLIAGE_RGB[k * 3 + 2];
          }
          // Mountains: windswept-hills colours on high, rugged ground (snowy stays snowy).
          const h2 = col[C_H2];
          const wm = smoothstep(0.25, 0.6, col[C_M]) * smoothstep(80, 110, h2) * (1 - sig(-t, 0.95, 0.06));
          // Rivers / coasts lean towards the plains colour (Minecraft's river/beach/ocean tint).
          const nearRiver = 1 - smoothstep(RIVER_W * 0.5, RIVER_W * 6, col[C_RABS]);
          const wet = Math.max(nearRiver * 0.85, smoothstep(-0.05, -0.25, col[C_C])) * 0.55 * (1 - sig(-t, 0.95, 0.06));
          const mix = (v, target, k) => v + (target - v) * k;
          gr = mix(mix(gr, 0x8a, wm), 0x91, wet); gg = mix(mix(gg, 0xb6, wm), 0xbd, wet); gb = mix(mix(gb, 0x89, wm), 0x59, wet);
          fr = mix(mix(fr, 0x6d, wm), 0x77, wet); fg = mix(mix(fg, 0xa3, wm), 0xab, wet); fb = mix(mix(fb, 0x6b, wm), 0x2f, wet);
          const idx = lz * 16 + lx;
          grass[idx] = Math.round(gr) | (Math.round(gg) << 8) | (Math.round(gb) << 16);
          foliage[idx] = Math.round(fr) | (Math.round(fg) << 8) | (Math.round(fb) << 16);
        }
      }
    }
    if (this._tintCache.size >= 128) this._tintCache.delete(this._tintCache.keys().next().value);
    this._tintCache.set(key, { grass, foliage });
    return { grass: grass.slice(), foliage: foliage.slice() };
  }

  /**
   * Find a dry land column (grass / sand / snow) near the origin, avoiding oceans and mountains.
   * @returns {{ x: number, z: number, y: number }} y = first free block above the ground
   */
  findSpawn() {
    if (this._spawn) return { ...this._spawn };
    if (this.worldType === 'flat') {
      this._spawn = { x: 0, z: 0, y: 4 };
      return { ...this._spawn };
    }
    const good = new Set([B.PLAINS, B.FOREST, B.FLOWER_FOREST, B.BIRCH_FOREST, B.TAIGA, B.SNOWY_PLAINS,
      B.SNOWY_TAIGA, B.DESERT, B.BEACH]);
    const tryChunk = (cx, cz) => {
      const blocks = this.generateChunk(cx, cz);
      let best = null;
      let bestD = Infinity;
      for (let lz = 0; lz < 16; lz++) {
        for (let lx = 0; lx < 16; lx++) {
          let y = 255;
          while (y > 0 && blocks[(y << 8) | (lz << 4) | lx] === AIR) y--;
          let id = blocks[(y << 8) | (lz << 4) | lx];
          // allow short plants on top of the ground
          if (IS_REPLACEABLE[id] && !IS_LIQUID[id] && id !== AIR) {
            y--;
            id = blocks[(y << 8) | (lz << 4) | lx];
          }
          if (y < SEA_LEVEL + 1 || y > 120) continue;
          if (id !== GRASS && id !== SAND && id !== SNOWY_GRASS && id !== DIRT) continue;
          const d = (lx - 7.5) ** 2 + (lz - 7.5) ** 2;
          if (d < bestD) {
            bestD = d;
            best = { x: cx * 16 + lx, z: cz * 16 + lz, y: y + 1 };
          }
        }
      }
      return best;
    };
    // Spiral search over 16-block steps up to ~4k blocks.
    for (let r = 0; r <= 256; r++) {
      for (let k = -r; k <= r; k++) {
        const cand = r === 0 ? [[0, 0]] : [[k, -r], [k, r], [-r, k], [r, k]];
        for (const [i, j] of cand) {
          if (r > 0 && (Math.abs(i) !== r && Math.abs(j) !== r)) continue;
          const x = i * 16 + 8;
          const z = j * 16 + 8;
          const cf = this._singleColumn(x, z);
          const b = this._classify(cf, 0, 1, x, z);
          const h2 = cf[C_H2];
          if (!good.has(b) || h2 < SEA_LEVEL + 1.5 || h2 > 100 || cf[C_RIV] > 0.1) continue;
          const found = tryChunk(Math.floor(x / 16), Math.floor(z / 16));
          if (found) {
            this._spawn = found;
            return { ...found };
          }
        }
        if (r === 0) break;
      }
    }
    this._spawn = { x: 0, z: 0, y: 128 };
    return { ...this._spawn };
  }

  /**
   * Grow a tree from a sapling (or any point) using the same builders as world generation.
   * @param {{ getBlock(x,y,z): number, setBlock(x,y,z,id): any }} access
   * @param {number} x @param {number} y @param {number} z  lowest trunk block (the sapling cell)
   * @param {string|number} kind 'oak' | 'large_oak' | 'birch' | 'tall_birch' | 'spruce' | 'pine', or a
   *   sapling block id / name
   * @param {() => number} rng random source in [0,1)
   * @returns {boolean} true if the tree was placed
   */
  growTree(access, x, y, z, kind, rng = Math.random) {
    let k = this._resolveTreeKind(kind, rng);
    if (k < 0) return false;
    if (y < 1 || y > 240) return false;
    const below = access.getBlock(x, y - 1, z);
    if (TREE_SOIL[below] !== 1) return false;
    const list = this.treeTmp;
    list.reset();
    const h = buildTree(list, k, rng, x, y, z);
    if (y + h + 3 > 255) return false;
    // Space check (Minecraft-like): trunk cells must be free, and the 3x3 around the upper trunk too.
    for (let i = 0; i < list.n; i++) {
      if (!IS_LOG[list.id[i]]) continue;
      if (!logCanReplace(access.getBlock(list.x[i], list.y[i], list.z[i]))) return false;
    }
    for (let yy = y + 1; yy <= y + h; yy++) {
      const r = yy - y < 2 ? 0 : 1;
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          const id = access.getBlock(x + dx, yy, z + dz);
          if (!logCanReplace(id) && !IS_LOG[id]) return false;
        }
      }
    }
    for (let i = 0; i < list.n; i++) {
      const id = list.id[i];
      const cur = access.getBlock(list.x[i], list.y[i], list.z[i]);
      if (IS_LOG[id]) {
        if (logCanReplace(cur)) access.setBlock(list.x[i], list.y[i], list.z[i], id);
      } else if (leavesCanReplace(cur)) {
        access.setBlock(list.x[i], list.y[i], list.z[i], id);
      }
    }
    if (below === GRASS || below === SNOWY_GRASS) access.setBlock(x, y - 1, z, DIRT);
    return true;
  }

  _resolveTreeKind(kind, rng) {
    if (typeof kind === 'number') {
      if (kind === OAK_SAPLING) return rng() < 0.1 ? TREE_OAK_LARGE : TREE_OAK;
      if (kind === BIRCH_SAPLING) return TREE_BIRCH;
      if (kind === SPRUCE_SAPLING) return rng() < 0.3 ? TREE_PINE : TREE_SPRUCE;
      return -1;
    }
    const name = String(kind).replace(/_sapling$/, '');
    if (name === 'oak') return rng() < 0.1 ? TREE_OAK_LARGE : TREE_OAK;
    if (name === 'spruce') return rng() < 0.3 ? TREE_PINE : TREE_SPRUCE;
    return TREE_KIND_BY_NAME[name] ?? -1;
  }

  /** Debug/test helper: trees (kind, trunk position) that touch chunk (cx, cz). */
  _debugTreesFor(cx, cz) {
    if (this.worldType === 'flat') return [];
    this._prepare(cx, cz);
    this._carveRavines(cx, cz, null);
    const x0 = cx * 16;
    const z0 = cz * 16;
    const out = [];
    const tree = { kind: 0, x: 0, y: 0, z: 0, seed: 0 };
    const gx0 = Math.floor((x0 - TREE_REACH) / TREE_CELL);
    const gx1 = Math.floor((x0 + 15 + TREE_REACH) / TREE_CELL);
    const gz0 = Math.floor((z0 - TREE_REACH) / TREE_CELL);
    const gz1 = Math.floor((z0 + 15 + TREE_REACH) / TREE_CELL);
    for (let gz = gz0; gz <= gz1; gz++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        if (!this._treeForCell(gx, gz, x0, z0, tree)) continue;
        if (tree.x + TREE_REACH < x0 || tree.x - TREE_REACH > x0 + 15 ||
          tree.z + TREE_REACH < z0 || tree.z - TREE_REACH > z0 + 15) continue;
        out.push({ ...tree });
      }
    }
    return out;
  }
}

/** Exported for tests / tools: build a tree's placements without a world. */
export function debugBuildTree(kindName, seed, x = 0, y = 0, z = 0) {
  const list = new PlacementList(256);
  const kind = TREE_KIND_BY_NAME[kindName];
  const h = buildTree(list, kind, mulberry32(seed), x, y, z);
  const blocks = [];
  for (let i = 0; i < list.n; i++) blocks.push({ x: list.x[i], y: list.y[i], z: list.z[i], id: list.id[i] });
  return { height: h, blocks };
}
