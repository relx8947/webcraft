// Procedural 16x16 pixel-art textures for WebCraft (docs/SPEC.md §5.2, §5.3, §9.4).
//
// Every entry of the registry's TEXTURES table has a painter in this file. Painters are fully
// deterministic: each one draws with a PRNG seeded from a hash of the texture name, so the output
// never changes between runs or machines. The art follows the classic Minecraft Java look
// (1.8 – 1.14 era): small palettes (4–7 shades per material), crisp pixel clusters instead of
// smooth per-pixel noise, light coming from the top-left, and seamless tiling for every natural
// block texture (all noise used here is periodic over the 16-px tile).
//
// Pure functions (generateTextures, getLayerAlphaModes, buildMipChain, generateMiscTextures,
// paintTexture, renderIconPixels) run in Node, workers and the main thread; only IconFactory
// needs a DOM canvas.

import {
  TEXTURES, TEXTURE_LAYER_COUNT, BLOCKS, ITEMS, FACE_LAYERS, RENDER_TYPE, RENDER_LAYER, TINT_TYPE,
  RENDER, LAYER, TINT, WOOL_COLORS, SPAWN_EGG_MOBS, itemForBlock,
} from '../world/registry.js';
import { DEFAULT_TINTS, FACE } from '../config.js';

const S = 16;                 // texture edge in texels
const AREA = S * S;
const LAYER_BYTES = AREA * 4;
const TEXTURE_BY_NAME = new Map(TEXTURES.map((t) => [t.name, t]));

// =================================================================================================
// Deterministic randomness
// =================================================================================================

/** FNV-1a with a murmur-style finaliser: well-mixed uint32 from a string. */
function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Small, fast, good-quality 32-bit PRNG. Returns floats in [0, 1). */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** PRNG for one texture, seeded from its name (painters are independent and reproducible). */
function rngFor(name) {
  return mulberry32(hashString('webcraft:' + name));
}
const randInt = (rng, n) => Math.floor(rng() * n);
const randRange = (rng, a, b) => a + (b - a) * rng();

// =================================================================================================
// Colour helpers (colours are [r, g, b] or [r, g, b, a] arrays of 0..255)
// =================================================================================================

const rgb = (hex) => [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
const pal = (...hexes) => hexes.map(rgb);
const c255 = (v) => (v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v));
const scale = (c, f) => [c255(c[0] * f), c255(c[1] * f), c255(c[2] * f)];
const mix = (a, b, t) => [
  c255(a[0] + (b[0] - a[0]) * t), c255(a[1] + (b[1] - a[1]) * t), c255(a[2] + (b[2] - a[2]) * t),
];
const gray = (v) => [v, v, v];
const luma = (r, g, b) => c255(0.299 * r + 0.587 * g + 0.114 * b);
const WHITE = [255, 255, 255];
const BLACK = [0, 0, 0];
const clampInt = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Palette object for sprites: { key: hex | [hex, alpha] } -> { key: [r, g, b, a] }. */
function keys(obj) {
  const out = {};
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    out[k] = Array.isArray(v) ? [...rgb(v[0]), v[1]] : [...rgb(v), 255];
  }
  return out;
}

// =================================================================================================
// Tex: a 16x16 RGBA view (usually a subarray of the big texture-array buffer). Coordinates wrap,
// which makes drawing tileable patterns trivial.
// =================================================================================================

class Tex {
  constructor(data = new Uint8Array(LAYER_BYTES)) {
    this.data = data;
  }
  set(x, y, c, a) {
    const d = this.data;
    const i = (((y & 15) << 4) | (x & 15)) << 2;
    d[i] = c[0];
    d[i + 1] = c[1];
    d[i + 2] = c[2];
    d[i + 3] = a ?? (c.length > 3 ? c[3] : 255);
  }
  setI(i, c, a) {
    this.set(i & 15, i >> 4, c, a);
  }
  get(x, y) {
    const d = this.data;
    const i = (((y & 15) << 4) | (x & 15)) << 2;
    return [d[i], d[i + 1], d[i + 2], d[i + 3]];
  }
  /** Multiply the colour of one texel (keeps alpha). */
  shade(x, y, f) {
    const c = this.get(x, y);
    this.set(x, y, scale(c, f), c[3]);
  }
  /** Blend one texel toward colour c by t (keeps alpha). */
  blend(x, y, c, t) {
    const o = this.get(x, y);
    this.set(x, y, mix(o, c, t), o[3]);
  }
  clear() {
    this.data.fill(0);
  }
  /** Paint palette[levels[i]] into every texel. */
  levels(lv, palette) {
    for (let i = 0; i < AREA; i++) this.setI(i, palette[lv[i]]);
  }
}

// =================================================================================================
// Periodic noise, rank quantisation, cellular patterns
// =================================================================================================

/**
 * Periodic 2D value noise: a cx × cy lattice stretched over `period` pixels in both directions,
 * smoothstep-interpolated, with a random phase. Returns a sampler (x, y) -> [0, 1] that tiles
 * with period `period` on both axes (non-integer coordinates allowed).
 */
function noise2(rng, cx, cy = cx, period = S) {
  const lat = new Float32Array(cx * cy);
  for (let i = 0; i < lat.length; i++) lat[i] = rng();
  const ox = rng() * period;
  const oy = rng() * period;
  return (x, y) => {
    const fx = ((x + ox) * cx) / period;
    const fy = ((y + oy) * cy) / period;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    let tx = fx - x0;
    let ty = fy - y0;
    tx = tx * tx * (3 - 2 * tx);
    ty = ty * ty * (3 - 2 * ty);
    const xa = ((x0 % cx) + cx) % cx;
    const xb = (xa + 1) % cx;
    const ya = (((y0 % cy) + cy) % cy) * cx;
    const yb = ((((y0 + 1) % cy) + cy) % cy) * cx;
    const a = lat[ya + xa] + (lat[ya + xb] - lat[ya + xa]) * tx;
    const b = lat[yb + xa] + (lat[yb + xb] - lat[yb + xa]) * tx;
    return a + (b - a) * ty;
  };
}

/** Periodic 3D value noise: periodic over 16 px in x/y and over `tPeriod` in t (animation loops). */
function noise3(rng, cx, cy, ct, tPeriod) {
  const lat = new Float32Array(cx * cy * ct);
  for (let i = 0; i < lat.length; i++) lat[i] = rng();
  const ox = rng() * S;
  const oy = rng() * S;
  const ot = rng() * tPeriod;
  const at = (x, y, t) => lat[(t * cy + y) * cx + x];
  const smooth = (v) => v * v * (3 - 2 * v);
  return (x, y, t) => {
    const fx = ((x + ox) * cx) / S;
    const fy = ((y + oy) * cy) / S;
    const ft = ((t + ot) * ct) / tPeriod;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const t0 = Math.floor(ft);
    const tx = smooth(fx - x0);
    const ty = smooth(fy - y0);
    const tt = smooth(ft - t0);
    const xa = ((x0 % cx) + cx) % cx;
    const xb = (xa + 1) % cx;
    const ya = ((y0 % cy) + cy) % cy;
    const yb = (ya + 1) % cy;
    const ta = ((t0 % ct) + ct) % ct;
    const tb = (ta + 1) % ct;
    const l = (tq) => {
      const a = at(xa, ya, tq) + (at(xb, ya, tq) - at(xa, ya, tq)) * tx;
      const b = at(xa, yb, tq) + (at(xb, yb, tq) - at(xa, yb, tq)) * tx;
      return a + (b - a) * ty;
    };
    const p = l(ta);
    return p + (l(tb) - p) * tt;
  };
}

/** Weighted sum of periodic noise octaves [cx, cy, weight] plus white noise -> Float32Array(256). */
function field(rng, octaves, white = 0) {
  const f = new Float32Array(AREA);
  for (const [cx, cy, w] of octaves) {
    const n = noise2(rng, cx, cy);
    for (let i = 0; i < AREA; i++) f[i] += n(i & 15, i >> 4) * w;
  }
  if (white) for (let i = 0; i < AREA; i++) f[i] += rng() * white;
  return f;
}

/**
 * Rank-based quantisation: the lowest fractions[0] share of the values become level 0, the next
 * fractions[1] share level 1, and so on. Gives every texture of a family an identical histogram,
 * which is what keeps palettes "limited" and clusters crisp.
 */
function quantize(f, fractions) {
  const n = f.length;
  const order = new Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  order.sort((a, b) => f[a] - f[b] || a - b);
  let total = 0;
  for (const q of fractions) total += q;
  const out = new Uint8Array(n);
  let level = 0;
  let edge = (fractions[0] / total) * n;
  for (let r = 0; r < n; r++) {
    while (r >= edge - 1e-6 && level < fractions.length - 1) {
      level++;
      edge += (fractions[level] / total) * n;
    }
    out[order[r]] = level;
  }
  return out;
}

/** Noise -> quantised palette in one call. Returns the level map. */
function material(t, rng, palette, fractions, octaves, white) {
  const q = quantize(field(rng, octaves, white), fractions);
  t.levels(q, palette);
  return q;
}

/** n × n jittered grid of points over the tile (optional size weight in [2]). */
function jitterPoints(rng, n, jitter = 0.8) {
  const pts = [];
  const cell = S / n;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      pts.push([(i + 0.5 + (rng() - 0.5) * jitter) * cell, (j + 0.5 + (rng() - 0.5) * jitter) * cell, 1]);
    }
  }
  return pts;
}

/**
 * Toroidal (tileable) weighted Voronoi diagram over the 16x16 tile.
 * Returns per-texel nearest cell id, and `gap` = d2 - d1 (≈ distance to the cell border).
 */
function voronoi(pts) {
  const id = new Uint8Array(AREA);
  const gap = new Float32Array(AREA);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let d1 = Infinity;
      let d2 = Infinity;
      let i1 = 0;
      for (let k = 0; k < pts.length; k++) {
        let dx = Math.abs(x + 0.5 - pts[k][0]) % S;
        let dy = Math.abs(y + 0.5 - pts[k][1]) % S;
        if (dx > S / 2) dx = S - dx;
        if (dy > S / 2) dy = S - dy;
        const d = Math.sqrt(dx * dx + dy * dy) * pts[k][2];
        if (d < d1) {
          d2 = d1;
          d1 = d;
          i1 = k;
        } else if (d < d2) {
          d2 = d;
        }
      }
      const i = y * S + x;
      id[i] = i1;
      gap[i] = d2 - d1;
    }
  }
  return { id, gap };
}

const wrapI = (x, y) => ((y & 15) << 4) | (x & 15);

/** True where a Voronoi cell meets a different cell to the right or below: crisp 1-px seams. */
function cellBorder(v, x, y) {
  const id = v.id[wrapI(x, y)];
  return id !== v.id[wrapI(x + 1, y)] || id !== v.id[wrapI(x, y + 1)];
}

/** Directional light term for a height field h (lit from the top-left): > 0 on top-left slopes. */
function slopeLight(h, x, y) {
  return h[wrapI(x + 1, y + 1)] - h[wrapI(x - 1, y - 1)];
}

// =================================================================================================
// Sprites (hand-authored string grids). '.' = transparent.
// =================================================================================================

/** Draw a 16-row × 16-column string map with palette keys -> colours. Throws on malformed maps. */
function sprite(t, rows, palette) {
  if (rows.length !== S) throw new Error(`sprite must have 16 rows (got ${rows.length})`);
  for (let y = 0; y < rows.length; y++) {
    const row = rows[y];
    if (row.length !== S) throw new Error(`sprite row ${y} must have 16 columns: "${row}"`);
    for (let x = 0; x < S; x++) {
      const ch = row[x];
      if (ch === '.') continue;
      const c = palette[ch];
      if (c === undefined) throw new Error(`sprite palette has no key '${ch}'`);
      t.set(x, y, c);
    }
  }
}

/** Partial overlay map (any row count, rows of 16 chars), drawn at row offset oy. */
function overlay(t, rows, palette, oy = 0) {
  for (let y = 0; y < rows.length; y++) {
    const row = rows[y];
    if (row.length !== S) throw new Error(`overlay row ${y} must have 16 columns: "${row}"`);
    for (let x = 0; x < S; x++) {
      const ch = row[x];
      if (ch === '.') continue;
      const c = palette[ch];
      if (c === undefined) throw new Error(`overlay palette has no key '${ch}'`);
      t.set(x, y + oy, c);
    }
  }
}

/**
 * Item sprite with an automatic 1-px outline (Minecraft item style). `outlines` is a list of
 * [keysString, hex]: an empty texel 4-adjacent to the body takes the outline colour of the first
 * group (in list order) that contains one of its neighbours' keys. No wrapping at the edges.
 */
function itemSprite(t, rows, palette, outlines) {
  t.clear();
  sprite(t, rows, palette);
  const key = (x, y) => (x < 0 || y < 0 || x >= S || y >= S ? '.' : rows[y][x]);
  const groups = outlines.map(([ks, hex]) => [ks, [...rgb(hex), 255]]);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      if (rows[y][x] !== '.') continue;
      const n = [key(x, y - 1), key(x - 1, y), key(x + 1, y), key(x, y + 1)];
      if (n.every((k) => k === '.')) continue;
      for (const [ks, c] of groups) {
        if (n.some((k) => k !== '.' && ks.includes(k))) {
          t.set(x, y, c);
          break;
        }
      }
    }
  }
}

// =================================================================================================
// Painter registry
// =================================================================================================

const PAINTERS = new Map();

/** Register a painter: fn(tex, rng, frame, frameCount). */
function def(name, fn) {
  if (PAINTERS.has(name)) throw new Error(`duplicate texture painter '${name}'`);
  PAINTERS.set(name, fn);
}

/** Paint another texture's design (with that texture's own seed) as the base of this one. */
function paintBase(t, name, frame = 0, frames = 1) {
  const fn = PAINTERS.get(name);
  if (!fn) throw new Error(`no painter for base texture '${name}'`);
  fn(t, rngFor(name), frame, frames);
}

// =================================================================================================
// Terrain: dirt, grass, snow, sand, gravel, clay
// =================================================================================================

const DIRT = pal(0x593d29, 0x6c4a32, 0x7f593c, 0x8f6544, 0xa07450);
def('dirt', (t, rng) => {
  material(t, rng, DIRT, [0.08, 0.2, 0.44, 0.2, 0.08], [[4, 4, 0.45], [8, 8, 0.4]], 0.4);
  // A few pale pebbles, as in Minecraft's dirt.
  for (let k = 0; k < 4; k++) {
    const x = randInt(rng, S);
    const y = randInt(rng, S);
    t.set(x, y, rgb(0x9b8470));
    t.set(x, y + 1, rgb(0x5f4330));
  }
});

// Grayscale grass (tinted by the biome colour through the tint mask, alpha 0).
const GRASS_GRAYS = [0x76, 0x89, 0x9a, 0xaa, 0xba, 0xcc].map(gray);
const GRASS_FRACTIONS = [0.06, 0.15, 0.27, 0.27, 0.17, 0.08];
function grassLevels(rng) {
  return quantize(field(rng, [[8, 8, 0.5], [4, 4, 0.22]], 0.62), GRASS_FRACTIONS);
}

def('grass_block_top', (t, rng) => {
  const q = grassLevels(rng);
  for (let i = 0; i < AREA; i++) t.setI(i, GRASS_GRAYS[q[i]], 0);
});

/**
 * Per-column fringe depth for grass/snow overhangs, periodic along x so the side tiles
 * horizontally: mostly lo..hi rows with a few one-pixel "drips" reaching further down.
 */
function fringeDepths(rng, lo, hi, drips) {
  const n = noise2(rng, 5, 1);
  const d = new Array(S);
  for (let x = 0; x < S; x++) {
    let v = lo + Math.floor(n(x, 0) * (hi - lo + 1) * 0.999);
    if (rng() < 0.3) v += rng() < 0.5 ? -1 : 1;
    d[x] = clampInt(v, lo, hi);
  }
  for (let k = 0, guard = 0; k < drips && guard < 50; guard++) {
    const x = randInt(rng, S);
    if (d[x] > hi || d[(x + 1) & 15] > hi || d[(x + 15) & 15] > hi) continue;
    d[x] = hi + 1 + (rng() < 0.35 ? 1 : 0);
    k++;
  }
  return d;
}

def('grass_block_side', (t, rng) => {
  paintBase(t, 'dirt'); // identical dirt to the dirt block (alpha 255 = untinted)
  const depth = fringeDepths(rng, 3, 4, 3);
  const q = grassLevels(rng);
  for (let x = 0; x < S; x++) {
    for (let y = 0; y < depth[x]; y++) {
      let l = q[y * S + x];
      if (y === depth[x] - 1) l = Math.max(0, l - 2); // the overhang's lower lip is in shadow
      else if (y === 0) l = Math.min(GRASS_GRAYS.length - 1, l + 1);
      t.set(x, y, GRASS_GRAYS[l], 0); // alpha 0 = fully tinted
    }
  }
});

const SNOW = pal(0xc3d1d6, 0xd7e3e6, 0xe8f3f3, 0xf6ffff);
def('snow', (t, rng) => {
  material(t, rng, SNOW, [0.06, 0.17, 0.47, 0.3], [[8, 8, 0.45], [4, 4, 0.2]], 0.45);
});

def('grass_block_snow', (t, rng) => {
  paintBase(t, 'dirt');
  const depth = fringeDepths(rng, 3, 4, 3);
  const q = quantize(field(rng, [[8, 8, 0.5]], 0.5), [0.08, 0.22, 0.4, 0.3]);
  for (let x = 0; x < S; x++) {
    for (let y = 0; y < depth[x]; y++) {
      let l = q[y * S + x];
      if (y === depth[x] - 1) l = Math.min(l, 1); // bluish shadow under the snow lip
      t.set(x, y, SNOW[l]);
    }
  }
});

const SAND = pal(0xc2b185, 0xcfbf93, 0xdbcfa3, 0xe3d8b0, 0xece3c0);
def('sand', (t, rng) => {
  material(t, rng, SAND, [0.07, 0.19, 0.46, 0.2, 0.08], [[8, 8, 0.3], [16, 16, 0.15]], 0.75);
});

const SANDSTONE = pal(0xb3a06b, 0xc3b07c, 0xd0be8a, 0xd9c999, 0xe1d3a6, 0xe9dcb3);
def('sandstone_top', (t, rng) => {
  const q = quantize(field(rng, [[4, 4, 0.6], [8, 8, 0.25]], 0.28), [0.06, 0.2, 0.5, 0.18, 0.06]);
  for (let i = 0; i < AREA; i++) t.setI(i, SANDSTONE[q[i] + 1]);
});

def('sandstone_bottom', (t, rng) => {
  material(t, rng, SANDSTONE, [0.05, 0.12, 0.22, 0.3, 0.22, 0.09], [[8, 8, 0.45], [4, 4, 0.2]], 0.55);
});

/** Sandstone side: smooth top band, a dark seam, stratified body, a seam and a rough bottom band. */
def('sandstone', (t, rng) => {
  const layerTone = noise2(rng, 1, 6);
  const strata = noise2(rng, 2, 16);
  const rough = field(rng, [[8, 8, 0.45]], 0.55);
  const roughQ = quantize(rough, [0.08, 0.16, 0.3, 0.3, 0.16]);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let l;
      if (y <= 2) l = 3 + (rng() < 0.18 ? (rng() < 0.5 ? -1 : 1) : 0);
      else if (y === 3 || y === 12) l = rng() < 0.85 ? 1 : 2;
      else if (y >= 13) l = roughQ[y * S + x];
      else {
        const v = 0.55 * layerTone(0, y) + 0.35 * strata(x, y) + 0.2 * rng();
        l = v < 0.33 ? 2 : v < 0.62 ? 3 : 4;
      }
      t.set(x, y, SANDSTONE[clampInt(l, 0, 5)]);
    }
  }
});

const CLAY = pal(0x8e939e, 0x989ea9, 0xa1a7b3, 0xaab0bc, 0xb5bbc7);
def('clay', (t, rng) => {
  material(t, rng, CLAY, [0.08, 0.22, 0.42, 0.2, 0.08], [[4, 4, 0.5], [8, 8, 0.32]], 0.3);
});

const GRAVEL = pal(0x575251, 0x6a6463, 0x7e7876, 0x918a88, 0xa49d9a, 0xb8b1ad);
const GRAVEL_TINTS = [[1, 1, 1], [1.06, 1, 0.94], [0.96, 0.98, 1.02], [1.08, 1.02, 0.95]];
def('gravel', (t, rng) => {
  const pts = jitterPoints(rng, 5, 0.95);
  for (const p of pts) p[2] = randRange(rng, 0.85, 1.15);
  const v = voronoi(pts);
  const tone = pts.map(() => 2 + randInt(rng, 3));            // pebble brightness level 2..4
  const tint = pts.map(() => GRAVEL_TINTS[randInt(rng, GRAVEL_TINTS.length)]);
  const h = new Float32Array(AREA);
  for (let i = 0; i < AREA; i++) h[i] = Math.min(v.gap[i], 2.5);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = y * S + x;
      if (cellBorder(v, x, y)) {
        t.set(x, y, GRAVEL[rng() < 0.7 ? 0 : 1]);
        continue;
      }
      const l = clampInt(Math.round(tone[v.id[i]] + slopeLight(h, x, y) * 0.7 + (rng() - 0.5) * 0.7), 1, 5);
      const c = GRAVEL[l];
      const k = tint[v.id[i]];
      t.set(x, y, [c255(c[0] * k[0]), c255(c[1] * k[1]), c255(c[2] * k[2])]);
    }
  }
});

// =================================================================================================
// Stone family
// =================================================================================================

const STONE = pal(0x666666, 0x727272, 0x7e7e7e, 0x8a8a8a, 0x989898);
def('stone', (t, rng) => {
  material(t, rng, STONE, [0.07, 0.19, 0.48, 0.2, 0.06], [[4, 8, 0.55], [8, 8, 0.3]], 0.3);
});

def('granite', (t, rng) => {
  material(t, rng, pal(0x7a5141, 0x8b5f4d, 0x986a57, 0xa67764, 0xbb8d79, 0xcfa18e),
    [0.06, 0.16, 0.34, 0.24, 0.14, 0.06], [[8, 8, 0.5], [4, 4, 0.15]], 0.65);
});

def('diorite', (t, rng) => {
  material(t, rng, pal(0x7b7b7b, 0x9a9a9a, 0xb4b4b4, 0xc6c6c6, 0xd6d6d6, 0xe8e8e8),
    [0.06, 0.1, 0.18, 0.3, 0.24, 0.12], [[8, 8, 0.6], [4, 4, 0.15]], 0.5);
});

def('andesite', (t, rng) => {
  material(t, rng, pal(0x6a6a6a, 0x777777, 0x838383, 0x8d8d8d, 0x999999, 0xa8a8a8),
    [0.08, 0.16, 0.3, 0.26, 0.14, 0.06], [[8, 8, 0.45], [4, 4, 0.2]], 0.55);
});

def('bedrock', (t, rng) => {
  material(t, rng, pal(0x252525, 0x3c3c3c, 0x555555, 0x6f6f6f, 0x8f8f8f),
    [0.12, 0.22, 0.28, 0.25, 0.13], [[4, 4, 0.5], [8, 8, 0.45]], 0.3);
});

def('obsidian', (t, rng) => {
  // Diagonal shard streaks: noise sampled in rotated (x+y, x-y) coordinates stays periodic.
  const a = noise2(rng, 8, 2);
  const b = noise2(rng, 8, 8);
  const f = new Float32Array(AREA);
  for (let i = 0; i < AREA; i++) {
    const x = i & 15;
    const y = i >> 4;
    f[i] = 0.5 * a((x + y) & 15, (x - y) & 15) + 0.3 * b(x, y) + 0.3 * rng();
  }
  t.levels(quantize(f, [0.2, 0.3, 0.26, 0.15, 0.07, 0.02]),
    pal(0x0c0a13, 0x15111e, 0x1e1829, 0x2a203b, 0x3e2d59, 0x5b4383));
});

/**
 * Toroidal Voronoi cobblestones: 1-px dark mortar seams between rounded stones; every stone is
 * domed (lit top-left, shadowed bottom-right) with its own brightness.
 */
function cobblestone(t, rng) {
  const pts = jitterPoints(rng, 3, 0.8);
  for (let k = 0; k < 2; k++) pts.push([rng() * S, rng() * S, 1]);
  for (const p of pts) p[2] = randRange(rng, 0.9, 1.12);
  const v = voronoi(pts);
  const tone = pts.map(() => randRange(rng, -0.6, 0.6));
  const n = noise2(rng, 8, 8);
  const P = pal(0x4c4c4c, 0x5e5e5e, 0x6f6f6f, 0x7f7f7f, 0x8f8f8f, 0xa0a0a0, 0xb3b3b3);
  const h = new Float32Array(AREA);
  for (let i = 0; i < AREA; i++) h[i] = Math.min(v.gap[i], 3);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      if (cellBorder(v, x, y)) {
        t.set(x, y, P[n(x, y) > 0.7 ? 1 : 0]);
        continue;
      }
      const i = y * S + x;
      const val = 3.9 + tone[v.id[i]] + slopeLight(h, x, y) * 0.8 + (n(x, y) - 0.5) * 0.9 + (rng() - 0.5) * 0.6;
      t.set(x, y, P[clampInt(Math.round(val), 2, 6)]);
    }
  }
}
def('cobblestone', cobblestone);

const MOSS = pal(0x3a5426, 0x48652e, 0x577838, 0x678a42, 0x7a9d4e);
/**
 * Grow moss over the current texture: a noise mask that prefers dark texels (gaps/mortar) and,
 * optionally, the lower part of the tile. `amount` = covered fraction.
 */
function moss(t, rng, amount, lowBias = 0) {
  const f = field(rng, [[4, 4, 0.6], [8, 8, 0.35]], 0.3);
  for (let i = 0; i < AREA; i++) {
    const [r, g, b] = t.get(i & 15, i >> 4);
    f[i] += (1 - luma(r, g, b) / 160) * 0.55 + ((i >> 4) / 15) * lowBias;
  }
  const mask = quantize(f, [1 - amount, amount]);
  const tone = quantize(field(rng, [[8, 8, 0.6]], 0.6), [0.12, 0.25, 0.3, 0.22, 0.11]);
  for (let i = 0; i < AREA; i++) {
    if (!mask[i]) continue;
    const [r, g, b] = t.get(i & 15, i >> 4);
    const dark = luma(r, g, b) < 80 ? -1 : 0; // moss in gaps stays darker
    t.setI(i, MOSS[clampInt(tone[i] + dark, 0, 4)]);
  }
}

def('mossy_cobblestone', (t, rng) => {
  paintBase(t, 'cobblestone');
  moss(t, rng, 0.36);
});

def('bricks', (t, rng) => {
  const MORTAR = pal(0x857c76, 0x968d86, 0xa59d96);
  const BRICK = pal(0x6b392d, 0x7f4537, 0x925143, 0xa15c4c, 0xb06a58);
  const n = noise2(rng, 8, 8);
  const tone = Array.from({ length: 8 }, () => randRange(rng, -0.6, 0.6));
  for (let y = 0; y < S; y++) {
    const row = y >> 2;
    const yi = y & 3;
    const off = row & 1 ? 4 : 0;
    for (let x = 0; x < S; x++) {
      const xb = (x + off) & 15;
      const xi = xb & 7;
      if (yi === 3 || xi === 7) {
        const m = n(x, y) + (rng() - 0.5) * 0.4;
        t.set(x, y, MORTAR[m < 0.35 ? 0 : m < 0.7 ? 1 : 2]);
        continue;
      }
      let v = 2 + tone[row * 2 + (xb >> 3)] + (n(x, y) - 0.5) * 1.4 + (rng() - 0.5) * 0.9;
      if (yi === 0) v += 0.55;
      if (yi === 2) v -= 0.45;
      if (xi === 0) v += 0.3;
      if (xi === 6) v -= 0.3;
      t.set(x, y, BRICK[clampInt(Math.round(v), 0, 4)]);
    }
  }
});

/**
 * Stone bricks: two courses of 16×8 bricks in running bond (joints at x = 15 and x = 7),
 * dark mortar lines, bevelled edges (light top/left, shadowed bottom/right).
 */
function stoneBricks(t, rng) {
  const P = pal(0x4f4f4f, 0x5f5f5f, 0x6f6f6f, 0x797979, 0x838383, 0x8f8f8f, 0x9d9d9d);
  const n = field(rng, [[4, 8, 0.6], [8, 8, 0.3]], 0.35);
  const q = quantize(n, [0.12, 0.3, 0.38, 0.2]);
  const tone = [randRange(rng, -0.3, 0.3), randRange(rng, -0.3, 0.3), randRange(rng, -0.3, 0.3)];
  for (let y = 0; y < S; y++) {
    const course = y >> 3;
    const yi = y & 7;
    const joint = course === 0 ? 15 : 7;
    for (let x = 0; x < S; x++) {
      const i = y * S + x;
      if (yi === 7 || x === joint) {
        t.set(x, y, P[rng() < 0.8 ? 0 : 1]);
        continue;
      }
      const xi = (x - joint - 1 + 16) & 15; // 0 = first column right of the joint
      const brick = course === 0 ? 0 : xi < 8 ? 1 : 2;
      let v = 3 + q[i] - 1.5 + tone[brick];
      if (yi === 0) v += 2.2;
      else if (yi === 6) v -= 1.6;
      if (xi === 0) v += 1.4;
      else if (xi === 14) v -= 1.3;
      t.set(x, y, P[clampInt(Math.round(v), 1, 6)]);
    }
  }
}
def('stone_bricks', stoneBricks);

def('mossy_stone_bricks', (t, rng) => {
  paintBase(t, 'stone_bricks');
  moss(t, rng, 0.32, 0.25);
});

def('cracked_stone_bricks', (t, rng) => {
  paintBase(t, 'stone_bricks');
  const DARK = rgb(0x333333);
  const EDGE = rgb(0x555555);
  const LIP = rgb(0xa2a2a2);
  const crack = new Uint8Array(AREA);
  // Cracks start on mortar seams and run into the bricks, forking once in a while.
  const starts = [[3, 7, -1.2], [11, 7, 1.9], [7, 12, -2.2], [15, 3, 2.6], [10, 15, -1.6]];
  for (const [sx, sy, a0] of starts) {
    let x = sx + 0.5;
    let y = sy + 0.5;
    let dir = a0 + (rng() - 0.5) * 0.6;
    const len = 4 + randInt(rng, 4);
    for (let s = 0; s < len; s++) {
      crack[wrapI(Math.floor(x), Math.floor(y))] = 1;
      dir += (rng() - 0.5) * 1.1;
      x += Math.cos(dir);
      y += Math.sin(dir);
    }
  }
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      if (crack[wrapI(x, y)]) t.set(x, y, DARK);
      else if (crack[wrapI(x - 1, y)] || crack[wrapI(x, y - 1)]) t.set(x, y, EDGE);
      else if (crack[wrapI(x + 1, y + 1)]) t.set(x, y, LIP);
    }
  }
});

// =================================================================================================
// Ores: the stone texture plus clusters with highlight / main / shadow pixels
// =================================================================================================

// Ore clusters: h = highlight (top-left), m = main colour, d = shadow (bottom-right).
const ORE_BLOBS = [
  ['.hm.', 'hmmd', 'mmdd', '.dd.'],
  ['hm.', 'mmd', '.dd'],
  ['.hmm', 'hmmd', '.dd.'],
  ['.h.', 'hmm', 'mmd', '.d.'],
  ['hmm.', '.mmd', '..d.'],
  ['.hm', 'hmd', 'md.'],
  ['hm.', 'mmm', '.md'],
];

function ore(t, rng, colors, count) {
  paintBase(t, 'stone');
  const c = { h: rgb(colors.h), m: rgb(colors.m), d: rgb(colors.d) };
  const cells = [];
  for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) cells.push([i, j]);
  for (let i = cells.length - 1; i > 0; i--) {
    const j = randInt(rng, i + 1);
    [cells[i], cells[j]] = [cells[j], cells[i]];
  }
  const shadow = new Uint8Array(AREA);
  const oreMask = new Uint8Array(AREA);
  for (let k = 0; k < count; k++) {
    const [ci, cj] = cells[k % cells.length];
    const blob = ORE_BLOBS[randInt(rng, ORE_BLOBS.length)];
    const ox = Math.floor(ci * 5.33 + rng() * 3);
    const oy = Math.floor(cj * 5.33 + rng() * 3);
    for (let y = 0; y < blob.length; y++) {
      for (let x = 0; x < blob[y].length; x++) {
        const ch = blob[y][x];
        if (ch === '.') continue;
        t.set(ox + x, oy + y, c[ch]);
        oreMask[wrapI(ox + x, oy + y)] = 1;
        shadow[wrapI(ox + x + 1, oy + y + 1)] = 1;
      }
    }
  }
  // Stone right below/right of an ore cluster darkens slightly: the clusters read as embedded.
  for (let i = 0; i < AREA; i++) if (shadow[i] && !oreMask[i]) t.shade(i & 15, i >> 4, 0.82);
}

def('coal_ore', (t, rng) => ore(t, rng, { h: 0x4a4a4a, m: 0x2b2b2b, d: 0x151515 }, 7));
def('iron_ore', (t, rng) => ore(t, rng, { h: 0xecd2b8, m: 0xd5a98a, d: 0x9c765c }, 6));
def('gold_ore', (t, rng) => ore(t, rng, { h: 0xfffcb4, m: 0xfbe349, d: 0xc8961c }, 6));
def('diamond_ore', (t, rng) => ore(t, rng, { h: 0xd8ffff, m: 0x5ce8ef, d: 0x1a9aa3 }, 6));
def('redstone_ore', (t, rng) => ore(t, rng, { h: 0xff7a6e, m: 0xde0b0b, d: 0x8a0000 }, 7));
def('lapis_ore', (t, rng) => ore(t, rng, { h: 0x6c95f2, m: 0x2856c4, d: 0x163687 }, 6));

// =================================================================================================
// Wood: logs (bark + rings) and planks
// =================================================================================================

/** Vertical bark: per-column tone + tall streaks + a few dark crevices with lit ridges. */
function bark(t, rng, P, crevices) {
  const col = noise2(rng, 8, 1);
  const streak = noise2(rng, 16, 3);
  const f = new Float32Array(AREA);
  for (let i = 0; i < AREA; i++) {
    const x = i & 15;
    const y = i >> 4;
    f[i] = 0.5 * col(x, 0) + 0.38 * streak(x, y) + 0.22 * rng();
  }
  t.levels(quantize(f, [0.12, 0.22, 0.32, 0.22, 0.12]), P);
  for (let k = 0; k < crevices; k++) {
    const x = randInt(rng, S);
    const y0 = randInt(rng, S);
    const len = 3 + randInt(rng, 6);
    for (let j = 0; j < len; j++) {
      t.set(x, y0 + j, P[0]);
      if (rng() < 0.55) t.set(x - 1, y0 + j, P[3]);
    }
  }
}

/**
 * Log end: 1-px bark ring, dark cambium ring, thin concentric growth rings on light wood, darker
 * pith. wood = [cambium, ring, base, light, pith].
 */
function logTop(t, rng, barkP, wood) {
  const n = noise2(rng, 4, 4);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = Math.abs(x - 7.5);
      const dy = Math.abs(y - 7.5);
      const cheb = Math.max(dx, dy);
      if (cheb >= 7) {
        t.set(x, y, barkP[1 + randInt(rng, 3)]);
        continue;
      }
      if (cheb >= 6) {
        t.set(x, y, rng() < 0.85 ? wood[0] : wood[1]);
        continue;
      }
      // Squircle distance so rings follow the square block outline, wobbled by noise.
      const r = Math.cbrt(dx * dx * dx + dy * dy * dy) + (n(x, y) - 0.5) * 0.7;
      const phase = r % 2.3;
      let c = phase < 0.8 ? wood[1] : phase > 1.7 ? wood[3] : wood[2];
      if (r < 1.25) c = wood[4];
      else if (rng() < 0.06) c = wood[1];
      t.set(x, y, c);
    }
  }
}

const OAK_BARK = pal(0x45351f, 0x5a4529, 0x6b5332, 0x7d6240, 0x917351);
const OAK_WOOD = pal(0x6e5230, 0x8f6f43, 0xa98754, 0xb8975f, 0x86663a);
def('oak_log', (t, rng) => bark(t, rng, OAK_BARK, 4));
def('oak_log_top', (t, rng) => logTop(t, rng, OAK_BARK, OAK_WOOD));

const SPRUCE_BARK = pal(0x24180b, 0x321f0e, 0x3f2913, 0x4d341a, 0x5d4223);
const SPRUCE_WOOD = pal(0x45311b, 0x5a4127, 0x6c4f30, 0x7a5a37, 0x543c22);
def('spruce_log', (t, rng) => bark(t, rng, SPRUCE_BARK, 5));
def('spruce_log_top', (t, rng) => logTop(t, rng, SPRUCE_BARK, SPRUCE_WOOD));

const BIRCH_BARK = pal(0x9f9d93, 0xc3c1b6, 0xd5d3ca, 0xe3e2db, 0xf0efea);
def('birch_log', (t, rng) => {
  const col = noise2(rng, 8, 1);
  const streak = noise2(rng, 16, 4);
  const f = new Float32Array(AREA);
  for (let i = 0; i < AREA; i++) f[i] = 0.45 * col(i & 15, 0) + 0.35 * streak(i & 15, i >> 4) + 0.3 * rng();
  t.levels(quantize(f, [0.06, 0.2, 0.36, 0.26, 0.12]), BIRCH_BARK);
  // Black lenticel dashes, the unmistakable birch look.
  const MARK = rgb(0x2a2924);
  const MARK2 = rgb(0x4f4d45);
  const used = new Uint8Array(AREA);
  for (let k = 0, guard = 0; k < 8 && guard < 200; guard++) {
    const w = 2 + randInt(rng, 4);
    const h = rng() < 0.3 ? 2 : 1;
    const x0 = randInt(rng, S);
    const y0 = randInt(rng, S);
    let free = true;
    for (let y = y0 - 1; y <= y0 + h && free; y++) {
      for (let x = x0 - 1; x <= x0 + w; x++) if (used[wrapI(x, y)]) free = false;
    }
    if (!free) continue;
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        const edge = x === x0 || x === x0 + w - 1;
        t.set(x, y, edge && rng() < 0.6 ? MARK2 : MARK);
        used[wrapI(x, y)] = 1;
      }
    }
    k++;
  }
});
def('birch_log_top', (t, rng) => logTop(t, rng, BIRCH_BARK, pal(0x9e8b58, 0xb4a06a, 0xc8b47c, 0xd5c28a, 0xa8935e)));

/**
 * Planks: four boards (3 px + 1 px dark seam), one vertical joint per board at staggered
 * positions, horizontal grain streaks, slightly lit board tops.
 */
function planks(t, rng, P) {
  const grain = noise2(rng, 4, 16);
  const starts = [randInt(rng, 3), 4 + randInt(rng, 3), 8 + randInt(rng, 3), 12 + randInt(rng, 3)];
  for (let i = starts.length - 1; i > 0; i--) {
    const j = randInt(rng, i + 1);
    [starts[i], starts[j]] = [starts[j], starts[i]];
  }
  for (let b = 0; b < 4; b++) {
    const jx = starts[b];
    const tone = randRange(rng, -0.3, 0.3);
    for (let r = 0; r < 4; r++) {
      const y = b * 4 + r;
      for (let x = 0; x < S; x++) {
        if (r === 3 || x === jx) {
          t.set(x, y, P[0]);
          continue;
        }
        let v = 2.1 + tone + (grain(x, y) - 0.5) * 3.2 + (rng() - 0.5) * 0.6;
        if (r === 0) v += 0.35;
        if (r === 2) v -= 0.2;
        if (x === ((jx + 1) & 15)) v += 0.6;
        if (x === ((jx + 15) & 15)) v -= 0.5;
        t.set(x, y, P[clampInt(Math.round(v), 1, 4)]);
      }
    }
  }
}

const OAK_PLANKS = pal(0x6a5230, 0x86683d, 0x9c7b4a, 0xae8b56, 0xbe9a63);
const BIRCH_PLANKS = pal(0x97875a, 0xb6a471, 0xc6b47e, 0xd4c38c, 0xdfcf99);
const SPRUCE_PLANKS = pal(0x45311c, 0x5c4226, 0x6b4f30, 0x795a38, 0x876641);
def('oak_planks', (t, rng) => planks(t, rng, OAK_PLANKS));
def('birch_planks', (t, rng) => planks(t, rng, BIRCH_PLANKS));
def('spruce_planks', (t, rng) => planks(t, rng, SPRUCE_PLANKS));

// =================================================================================================
// Foliage (grayscale, tinted), glass, ice
// =================================================================================================

/**
 * Leaves: grayscale (biome-tinted at render time), binary alpha with a `holes` fraction of gaps.
 * Clumps are toroidal Voronoi cells lit from the top-left; holes open mostly between clumps and
 * the texels just below/right of a hole fall in shadow.
 */
function leaves(t, rng, grays, holes, cells) {
  const pts = jitterPoints(rng, cells, 0.9);
  const v = voronoi(pts);
  const tone = pts.map(() => randRange(rng, -0.7, 0.7));
  const h = new Float32Array(AREA);
  for (let i = 0; i < AREA; i++) h[i] = Math.min(v.gap[i], 2.5);
  const hf = new Float32Array(AREA);
  for (let i = 0; i < AREA; i++) hf[i] = (2.5 - h[i]) * 0.4 + rng() * 0.8;
  const hole = quantize(hf, [1 - holes, holes]);
  const top = grays.length - 1;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = y * S + x;
      if (hole[i]) {
        t.set(x, y, BLACK, 0);
        continue;
      }
      let l = top / 2 + tone[v.id[i]] + slopeLight(h, x, y) * 0.9 + (rng() - 0.5) * 1.3;
      if (hole[wrapI(x, y - 1)] || hole[wrapI(x - 1, y)]) l -= 0.8; // under a gap: shadow
      t.set(x, y, grays[clampInt(Math.round(l), 0, top)]);
    }
  }
}

def('oak_leaves', (t, rng) => leaves(t, rng, [0x52, 0x68, 0x7e, 0x93, 0xa8, 0xbd, 0xd0].map(gray), 0.3, 4));
def('birch_leaves', (t, rng) => leaves(t, rng, [0x5a, 0x70, 0x86, 0x9b, 0xb0, 0xc4, 0xd6].map(gray), 0.28, 5));
def('spruce_leaves', (t, rng) => leaves(t, rng, [0x4c, 0x62, 0x78, 0x8e, 0xa3, 0xb8, 0xca].map(gray), 0.26, 6));

def('glass', (t) => {
  t.clear();
  const EDGE_LIGHT = [218, 236, 240];
  const EDGE_DARK = [176, 200, 208];
  const CORNER = [150, 175, 184];
  const SHINE = [246, 252, 252];
  for (let i = 0; i < S; i++) {
    t.set(i, 0, EDGE_LIGHT);
    t.set(0, i, EDGE_LIGHT);
    t.set(i, 15, EDGE_DARK);
    t.set(15, i, EDGE_DARK);
  }
  for (const [x, y] of [[0, 0], [15, 0], [0, 15], [15, 15]]) t.set(x, y, CORNER);
  // Diagonal shine streaks (top-left large, one small near the bottom-right).
  for (const [x, y] of [[2, 5], [3, 4], [4, 3], [5, 2], [3, 6], [4, 5], [5, 4], [6, 3], [10, 12], [11, 11], [12, 10]]) {
    t.set(x, y, SHINE);
  }
});

def('ice', (t, rng) => {
  const P = [[0x7aa5ee, 160], [0x87b0f2, 164], [0x96bcf7, 168], [0xa9cafb, 176], [0xc6ddff, 188]]
    .map(([h, a]) => [...rgb(h), a]);
  const f = field(rng, [[4, 4, 0.55], [8, 8, 0.3]], 0.25);
  const q = quantize(f, [0.14, 0.28, 0.3, 0.18, 0.1]);
  for (let i = 0; i < AREA; i++) t.setI(i, P[q[i]]);
  // Bright scratches / cracks.
  const CRACK = [...rgb(0xe4f0ff), 205];
  const CRACK2 = [...rgb(0xd0e3ff), 192];
  for (let k = 0; k < 4; k++) {
    let x = randInt(rng, S);
    let y = randInt(rng, S);
    const dx = rng() < 0.5 ? 1 : -1;
    const len = 3 + randInt(rng, 5);
    for (let s = 0; s < len; s++) {
      t.set(x, y, s === 0 || s === len - 1 ? CRACK2 : CRACK);
      x += dx;
      if (rng() < 0.7) y -= 1;
    }
  }
});

// =================================================================================================
// Liquids (16 frames each, seamless in space and looping in time)
// =================================================================================================

/**
 * Still water: four soft blue tones drifting in small circles (zero net motion over the loop),
 * plus light ripple lines = a moving contour band of a second field. Alpha ≈ 176–190.
 */
def('water_still', (t, rng, frame, frames) => {
  const a = noise2(rng, 4, 4);
  const b = noise2(rng, 8, 4);
  const c = noise3(rng, 4, 4, 4, frames);
  const g1 = noise2(rng, 4, 4);
  const g2 = noise3(rng, 8, 8, 4, frames);
  const th = (2 * Math.PI * frame) / frames;
  const f = new Float32Array(AREA);
  const g = new Float32Array(AREA);
  for (let i = 0; i < AREA; i++) {
    const x = i & 15;
    const y = i >> 4;
    f[i] = 0.45 * a(x + 2.5 * Math.cos(th), y + 2.5 * Math.sin(th))
      + 0.3 * b(x - 2 * Math.sin(th), y + 2 * Math.cos(th))
      + 0.35 * c(x, y, frame);
    g[i] = 0.65 * g1(x + 3 * Math.cos(th), y - 3 * Math.sin(th)) + 0.35 * g2(x, y, frame);
  }
  const q = quantize(f, [0.15, 0.35, 0.35, 0.15]);
  const ripple = quantize(g, [0.7, 0.14, 0.16]); // level 1 = a thin band around the crests
  const P = [[0x2b4fae, 176], [0x3258bb, 178], [0x3961c6, 180], [0x4169cf, 183]].map(([h, al]) => [...rgb(h), al]);
  const HL = [...rgb(0x5f8ee2), 188];
  for (let i = 0; i < AREA; i++) t.setI(i, ripple[i] === 1 ? HL : P[q[i]]);
});

/** Still lava: orange/yellow blobs churning in place (looping), opaque. */
def('lava_still', (t, rng, frame, frames) => {
  const a = noise2(rng, 4, 4);
  const b = noise2(rng, 8, 8);
  const c = noise3(rng, 8, 8, 4, frames);
  const d = noise3(rng, 4, 4, 2, frames);
  const th = (2 * Math.PI * frame) / frames;
  const f = new Float32Array(AREA);
  for (let i = 0; i < AREA; i++) {
    const x = i & 15;
    const y = i >> 4;
    f[i] = 0.35 * a(x + 2 * Math.cos(th), y + 2 * Math.sin(th))
      + 0.3 * b(x - 1.5 * Math.sin(th), y + 1.5 * Math.cos(th))
      + 0.3 * c(x, y, frame)
      + 0.25 * d(x, y, frame);
  }
  const q = quantize(f, [0.05, 0.11, 0.2, 0.25, 0.2, 0.13, 0.06]);
  const P = pal(0x9c2f08, 0xc04a0e, 0xd65e16, 0xe5791f, 0xf09a2c, 0xf8c044, 0xffe27a);
  for (let i = 0; i < AREA; i++) t.setI(i, P[q[i]]);
});

// =================================================================================================
// Plants (cutout sprites standing on the bottom edge)
// =================================================================================================

const STEM = { s: 0x3d7a22, S: 0x4f8f2b, g: 0x4a8a28, G: 0x67a836, d: 0x346a1b };

/**
 * Grass tuft: hand-placed 1-px blades rising from the bottom edge, alternating darker (behind)
 * and lighter (front) tones so neighbouring blades stay readable. Grayscale (biome-tinted).
 */
def('short_grass', (t) => {
  t.clear();
  // [base x, height, lean (-1/0/1), rows above the base where the blade steps sideways, light?]
  const BLADES = [
    [0, 5, 0, [], false], [2, 8, -1, [5], true], [3, 11, -1, [8], false], [5, 7, 0, [], true],
    [6, 12, -1, [9], false], [8, 13, 0, [], true], [9, 10, 1, [6], false], [11, 8, 0, [], true],
    [12, 11, 1, [7], false], [14, 7, 1, [4], true],
  ];
  for (const [x0, h, dir, steps, light] of BLADES) {
    let x = x0;
    for (let j = 0; j < h; j++) {
      if (steps.includes(j)) x += dir;
      const u = j / (h - 1);
      const v = light ? 0x8c + u * 0x48 : 0x70 + u * 0x40;
      t.set(x, 15 - j, gray(c255(j < 2 ? v - 0x10 : v)));
    }
  }
  for (const [x, y] of [[4, 15], [4, 14], [10, 15], [13, 15], [13, 14], [1, 15], [7, 15]]) t.set(x, y, gray(0x66));
});

/** Fern: five fronds fanning out from the base, with alternating leaflets (grayscale, tinted). */
def('fern', (t) => {
  t.clear();
  const FRONDS = [
    [[7, 15], [7, 14], [7, 13], [7, 12], [7, 11], [7, 10], [7, 9], [7, 8], [7, 7], [7, 6], [7, 5], [7, 4], [7, 3], [7, 2]],
    [[6, 14], [5, 13], [4, 12], [4, 11], [3, 10], [3, 9], [2, 8], [2, 7], [2, 6], [1, 5]],
    [[8, 14], [9, 13], [10, 12], [11, 11], [11, 10], [12, 9], [12, 8], [13, 7], [13, 6], [14, 5]],
    [[6, 15], [5, 15], [4, 14], [3, 14], [2, 13], [1, 13], [0, 12]],
    [[8, 15], [9, 15], [10, 14], [11, 14], [12, 13], [13, 13], [14, 12], [15, 12]],
  ];
  for (const fr of FRONDS) {
    const n = fr.length;
    for (let k = 0; k < n; k++) {
      const [x, y] = fr[k];
      const u = k / (n - 1);
      t.set(x, y, gray(c255(0x76 + u * 0x3a)));
      if (k < 2) continue;
      const [px, py] = fr[k - 1];
      const dx = x - px;
      const dy = y - py;
      for (const side of k % 2 === 0 ? [1, -1] : [k % 4 === 1 ? 1 : -1]) {
        const lx = x - dy * side;
        const ly = y + dx * side;
        if (lx < 0 || lx >= S || ly < 0 || ly >= S) continue;
        t.set(lx, ly, gray(c255(0x96 + u * 0x38 + (side > 0 ? 0x0c : 0))));
        // Lower leaflets are two pixels long, slanting toward the frond tip.
        if (u < 0.55 && k % 2 === 0) {
          const ex = lx - dy * side + dx;
          const ey = ly + dx * side + dy;
          if (ex >= 0 && ex < S && ey >= 0 && ey < S) t.set(ex, ey, gray(c255(0xa4 + u * 0x30)));
        }
      }
    }
  }
});

def('dandelion', (t) => {
  t.clear();
  sprite(t, [
    '................',
    '................',
    '................',
    '................',
    '................',
    '.......yy.......',
    '......yYYy......',
    '.....yYWYYy.....',
    '.....YYYYYa.....',
    '......aYYa......',
    '.......s........',
    '.......s...g....',
    '..g....s..gG....',
    '...Gg..sgGg.....',
    '....gGgsGg......',
    '......gss.......',
  ], keys({ y: 0xe0b31c, Y: 0xfbe33a, W: 0xfff7a0, a: 0xc8901a, ...STEM }));
});

def('poppy', (t) => {
  t.clear();
  sprite(t, [
    '................',
    '................',
    '................',
    '................',
    '.....rR..Rr.....',
    '....rRRRRRRr....',
    '....RRWRRRRR....',
    '....rRRkkRRr....',
    '.....rRRRRr.....',
    '......rrrr......',
    '.......s........',
    '.......s........',
    '...gg..s..gg....',
    '....gGgs.gG.....',
    '.....gGsGg......',
    '.......s........',
  ], keys({ R: 0xd8221e, r: 0x9c1412, W: 0xf2564a, k: 0x2b1d0e, ...STEM }));
});

def('cornflower', (t) => {
  t.clear();
  sprite(t, [
    '................',
    '................',
    '................',
    '................',
    '.....b.b.b......',
    '....bBbBbBb.....',
    '...bBLBBBLBb....',
    '....BBBkBBB.....',
    '...bBLBBBLBb....',
    '....bBbBbBb.....',
    '.....b.s.b......',
    '.......s........',
    '...g...s...g....',
    '....gG.s.Gg.....',
    '.....gGsGg......',
    '.......s........',
  ], keys({ B: 0x4a6ee0, b: 0x2f45a8, L: 0x93b0ff, k: 0x1f2a6b, ...STEM }));
});

def('oxeye_daisy', (t) => {
  t.clear();
  sprite(t, [
    '................',
    '................',
    '................',
    '................',
    '.....w.W.w......',
    '......WWW.......',
    '....wWWyWWw.....',
    '....WWyYyWW.....',
    '....wWWyWWw.....',
    '......WWW.......',
    '.....w.s.w......',
    '.......s........',
    '..gg...s........',
    '...gGg.s..gg....',
    '.....gGsgGg.....',
    '.......s........',
  ], keys({ W: 0xf4f4ee, w: 0xc9cfc9, y: 0xe2b51f, Y: 0xf7d74a, ...STEM }));
});

def('dead_bush', (t) => {
  t.clear();
  sprite(t, [
    '................',
    '................',
    '..d.........d...',
    '...d..B....d....',
    '....d..B..d...b.',
    '.B..d..B.d...b..',
    '..B..d.Bd...b...',
    '...B.dbB...b....',
    '....BdbB..b.....',
    '......bBbb......',
    '...bb..BB.......',
    '.....bbB........',
    '.......B........',
    '.......B........',
    '.......b........',
    '.......b........',
  ], keys({ B: 0x946231, b: 0x6b4520, d: 0x7c5428 }));
});

def('sugar_cane', (t) => {
  t.clear();
  const stalks = [{ x: 2, nodes: [3, 10] }, { x: 8, nodes: [1, 7, 13] }, { x: 13, nodes: [4, 11] }];
  for (const s of stalks) {
    for (let y = 0; y < S; y++) {
      const node = s.nodes.includes(y);
      t.set(s.x, y, gray(node ? 0xf0 : 0xd2));
      t.set(s.x + 1, y, gray(node ? 0xcc : 0xa6));
    }
  }
  const LEAF = gray(0xb4);
  const LEAF2 = gray(0x96);
  for (const [x, y, c] of [
    [1, 9, LEAF], [0, 8, LEAF2], [4, 3, LEAF], [5, 2, LEAF2],
    [7, 6, LEAF], [6, 5, LEAF2], [10, 12, LEAF], [11, 11, LEAF2],
    [12, 3, LEAF], [11, 2, LEAF2], [15, 10, LEAF],
  ]) t.set(x, y, c);
});

def('brown_mushroom', (t) => {
  t.clear();
  sprite(t, [
    '................',
    '................',
    '................',
    '................',
    '................',
    '................',
    '................',
    '................',
    '................',
    '................',
    '......CLLC......',
    '.....CLCCCC.....',
    '.....dCCCCd.....',
    '......dssd......',
    '.......sS.......',
    '.......sS.......',
  ], keys({ C: 0x9a6e4f, L: 0xbe9070, d: 0x6e4a32, s: 0xd9cfb8, S: 0xb9ae96 }));
});

def('red_mushroom', (t) => {
  t.clear();
  sprite(t, [
    '................',
    '................',
    '................',
    '................',
    '................',
    '................',
    '................',
    '................',
    '................',
    '......RRRR......',
    '.....RWRRWR.....',
    '....RRRRRRRR....',
    '....rRWRRRWr....',
    '......rssr......',
    '.......sS.......',
    '.......sS.......',
  ], keys({ R: 0xd02a2a, r: 0x8f1717, W: 0xf2ece6, s: 0xd9cfb8, S: 0xb9ae96 }));
});

const SAPLING_MAP = [
  '................',
  '......gGg.......',
  '....gGGLGg......',
  '...gGLGGGGg.....',
  '...dGGGdGGgd....',
  '..gGGdGGGLGg....',
  '..dGLGGGdGGGd...',
  '...dGGdGGGdd....',
  '....ddGtGdd.....',
  '......dtd.......',
  '.......t........',
  '......gt........',
  '.....g.t..g.....',
  '.......t.g......',
  '.......t........',
  '.......t........',
];
def('oak_sapling', (t) => {
  t.clear();
  sprite(t, SAPLING_MAP, keys({ d: 0x2f6b16, g: 0x3f8a1f, G: 0x56a52b, L: 0x7cc246, t: 0x6b4a24 }));
});
def('birch_sapling', (t) => {
  t.clear();
  sprite(t, SAPLING_MAP, keys({ d: 0x5b7d33, g: 0x76a043, G: 0x8fba55, L: 0xb5d77e, t: 0xcfcabb }));
});
def('spruce_sapling', (t) => {
  t.clear();
  sprite(t, [
    '................',
    '.......G........',
    '......gGg.......',
    '.....gGLGg......',
    '......dgd.......',
    '.....gGGGg......',
    '....gGLGGLg.....',
    '...ddgGtGgdd....',
    '....gGGGGGg.....',
    '...gGLGGGGLg....',
    '..dgGGGtGGGgd...',
    '....ddgtgdd.....',
    '.......t........',
    '.......t........',
    '.......t........',
    '.......t........',
  ], keys({ d: 0x1f3d1f, g: 0x2e5a2c, G: 0x3f7339, L: 0x5a9150, t: 0x5a3d1e }));
});

/** Torch: 2-px stick in columns 7–8, rows 8–15, flame head in rows 6–7 (mesher sub-rect, SPEC §7). */
def('torch', (t) => {
  t.clear();
  sprite(t, [
    '................',
    '................',
    '................',
    '................',
    '................',
    '................',
    '.......YW.......',
    '.......OY.......',
    '.......bB.......',
    '.......lm.......',
    '.......lm.......',
    '.......lm.......',
    '.......lm.......',
    '.......lm.......',
    '.......lm.......',
    '.......lm.......',
  ], keys({ W: 0xfffcd0, Y: 0xffd84a, O: 0xff9a1a, b: 0x4a3418, B: 0x5e4220, l: 0x8a6a3a, m: 0x5f4625 }));
});

// =================================================================================================
// Crafted / special blocks
// =================================================================================================

const TABLE = { frame: rgb(0x4a361d), rim: rgb(0xb9965f), rimDark: rgb(0x7d5f37), line: rgb(0x6f5230) };

def('crafting_table_top', (t, rng) => {
  planks(t, rng, pal(0x7d5f37, 0x987848, 0xa98654, 0xb8955f, 0xc4a26a));
  for (let i = 0; i < S; i++) {
    t.set(i, 0, TABLE.frame);
    t.set(i, 15, TABLE.frame);
    t.set(0, i, TABLE.frame);
    t.set(15, i, TABLE.frame);
  }
  for (let i = 1; i < 15; i++) {
    t.set(i, 1, TABLE.rim);
    t.set(1, i, TABLE.rim);
    t.set(i, 14, TABLE.rimDark);
    t.set(14, i, TABLE.rimDark);
  }
  // 3x3 crafting grid
  for (let i = 2; i < 14; i++) {
    for (const g of [5, 10]) {
      t.set(g, i, TABLE.line);
      t.set(i, g, TABLE.line);
    }
  }
  for (const g of [5, 10]) {
    for (let i = 2; i < 14; i++) {
      if (i !== 5 && i !== 10) {
        t.blend(g + 1, i, TABLE.rim, 0.45);
        t.blend(i, g + 1, TABLE.rim, 0.45);
      }
    }
  }
});

/** Shared crafting-table side frame: table-top edge band, corner legs, dark back panel. */
function craftingSide(t, rng) {
  planks(t, rng, pal(0x3f2e19, 0x5a4227, 0x654a2c, 0x6f5232, 0x7a5a37));
  const n = noise2(rng, 8, 2);
  for (let x = 0; x < S; x++) {
    t.set(x, 0, TABLE.frame);
    for (let y = 1; y <= 2; y++) {
      const v = n(x, y);
      t.set(x, y, v > 0.62 ? rgb(0xc4a26a) : v > 0.3 ? TABLE.rim : rgb(0xa98654));
    }
    t.set(x, 3, rgb(0x33251a));
    t.set(x, 15, rgb(0x33251a));
  }
  for (let y = 4; y < 15; y++) {
    t.set(0, y, rgb(0x9c7a49));
    t.set(1, y, rgb(0x86683d));
    t.set(2, y, rgb(0x4a361d));
    t.set(13, y, rgb(0x4a361d));
    t.set(14, y, rgb(0x9c7a49));
    t.set(15, y, rgb(0x86683d));
  }
}

def('crafting_table_side', (t, rng) => {
  craftingSide(t, rng);
  // Hand saw hanging on the wall: D-shaped wooden handle (right), tapered toothed steel blade.
  overlay(t, [
    '...........hhh..',
    '..LLLLLLLLhH.Hh.',
    '..LMMMMMMMhH.Hh.',
    '...MMMMMMMhhhh..',
    '....tMtMtMt.....',
    '.....t.t.t......',
  ], keys({ h: 0x5e4220, H: 0x8f6a35, L: 0xe0e0e0, M: 0xb4b4b4, t: 0x6e6e6e }), 6);
});

def('crafting_table_front', (t, rng) => {
  craftingSide(t, rng);
  // Hammer (left) and pincers (right).
  overlay(t, [
    '..LLLLL....M..M.',
    '..MMMMM....M..M.',
    '....h......LM.M.',
    '....h.......LL..',
    '....h.......hh..',
    '....h......h..h.',
    '....h......h..h.',
    '....H......H..H.',
    '................',
  ], keys({ h: 0x6b4a24, H: 0x4a3418, L: 0xd0d0d0, M: 0x8a8a8a }), 5);
});

const FURNACE = pal(0x3d3d3d, 0x565656, 0x6c6c6c, 0x7d7d7d, 0x8c8c8c, 0x9e9e9e, 0xb2b2b2);
/** Smooth-stone body shared by the furnace faces. */
function furnaceStone(t, rng) {
  const q = quantize(field(rng, [[4, 4, 0.5], [8, 8, 0.3]], 0.35), [0.1, 0.3, 0.4, 0.2]);
  for (let i = 0; i < AREA; i++) t.setI(i, FURNACE[2 + q[i]]);
}

def('furnace_top', (t, rng) => {
  furnaceStone(t, rng);
  for (let i = 0; i < S; i++) {
    t.set(i, 0, FURNACE[1]);
    t.set(0, i, FURNACE[1]);
    t.set(i, 15, FURNACE[0]);
    t.set(15, i, FURNACE[0]);
  }
  for (let i = 1; i < 15; i++) {
    t.set(i, 1, FURNACE[6]);
    t.set(1, i, FURNACE[6]);
    t.set(i, 14, FURNACE[2]);
    t.set(14, i, FURNACE[2]);
  }
});

function furnaceSideBase(t, rng) {
  furnaceStone(t, rng);
  for (let x = 0; x < S; x++) {
    t.set(x, 0, FURNACE[1]);
    t.set(x, 1, FURNACE[6]);
    t.set(x, 2, FURNACE[5]);
    t.set(x, 14, FURNACE[2]);
    t.set(x, 15, FURNACE[0]);
  }
}

def('furnace_side', (t, rng) => furnaceSideBase(t, rng));

def('furnace_front', (t, rng) => {
  furnaceSideBase(t, rng);
  overlay(t, [
    '...oooooooooo...',
    '...okkkkkkkkL...',
    '...oLLLLLLLLL...',
    '................',
    '..oooooooooooo..',
    '..okkkkkkkkkkL..',
    '..okkkkkkkkkkL..',
    '..okgkgkgkgkkL..',
    '..okgkgkgkgkkL..',
    '..okkkkkkkkkkL..',
    '..LLLLLLLLLLLL..',
  ], keys({ o: 0x2e2e2e, k: 0x141414, g: 0x3c3c3c, L: 0xa6a6a6 }), 3);
});

def('bookshelf', (t, rng) => {
  paintBase(t, 'oak_planks');
  const BOOKS = pal(0x8e2a24, 0x2e4a8c, 0x3c7a34, 0x7a4a24, 0x6e3a7e, 0xa88a3c, 0x5c6a7a, 0x9a5a1e, 0x2c6a6a);
  const GAP = rgb(0x2a1d10);
  const SHELF_DARK = rgb(0x5a4527);
  for (const top of [1, 9]) {
    for (let y = top; y < top + 6; y++) for (let x = 0; x < S; x++) t.set(x, y, GAP);
    let x = 0;
    while (x < S) {
      const w = rng() < 0.65 ? 2 : rng() < 0.6 ? 1 : 3;
      if (rng() < 0.08) {
        x += 1;
        continue;
      }
      const h = 4 + randInt(rng, 3);
      const c = BOOKS[randInt(rng, BOOKS.length)];
      const band = rng() < 0.6 ? top + 6 - h + 1 + randInt(rng, 2) : -1;
      for (let bx = x; bx < Math.min(S, x + w); bx++) {
        for (let y = top + 6 - h; y < top + 6; y++) {
          let col = c;
          if (bx === x && w > 1) col = mix(c, WHITE, 0.18);
          else if (bx === x + w - 1 && w > 1) col = scale(c, 0.78);
          if (y === band) col = mix(col, rgb(0xd8c58a), 0.6);
          t.set(bx, y, col);
        }
      }
      x += w;
    }
    t.set(0, top + 5, SHELF_DARK);
  }
  // Shelf boards: top edge, middle shelf, bottom.
  for (let x = 0; x < S; x++) {
    t.blend(x, 0, WHITE, 0.08);
    t.set(x, 7, scale(t.get(x, 7), 1.05));
    t.set(x, 8, SHELF_DARK);
    t.set(x, 15, SHELF_DARK);
  }
});

const TNT_RED = pal(0x8f1d0e, 0xb22b12, 0xcc3a18, 0xdb4a22, 0xe86a3e);
def('tnt_side', (t, rng) => {
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const p = x & 3;
      let l = p === 0 ? 0 : p === 1 ? 4 : p === 2 ? 3 : 2;
      if (y === 0 || y === 15) l = Math.max(0, l - 1);
      if (rng() < 0.12) l = clampInt(l + (rng() < 0.5 ? -1 : 1), 1, 4);
      t.set(x, y, TNT_RED[l]);
    }
  }
  // Label band with the letters "TNT".
  const BAND = rgb(0xe6e6e6);
  const BAND_EDGE = rgb(0xbdbdbd);
  for (let x = 0; x < S; x++) {
    t.set(x, 4, BAND_EDGE);
    for (let y = 5; y <= 10; y++) t.set(x, y, BAND);
    t.set(x, 11, BAND_EDGE);
  }
  overlay(t, [
    '..###.#..#.###..',
    '...#..##.#..#...',
    '...#..#.##..#...',
    '...#..#..#..#...',
    '...#..#..#..#...',
  ], keys({ '#': 0x1d1d1d }), 5);
});

function tntEnd(t, rng, fuse) {
  // Ends of four dynamite sticks (2x2): paper rim, end cap lit from the top-left, dark core.
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const lx = (x & 7) - 3.5;
      const ly = (y & 7) - 3.5;
      const d = Math.hypot(lx, ly);
      let l = d > 3.7 ? 0 : d > 2.8 ? 1 : lx + ly < -1.5 ? 4 : 3;
      if (d < 1.1) l = 2;
      if (l >= 3 && rng() < 0.12) l -= 1;
      t.set(x, y, TNT_RED[l]);
    }
  }
  if (fuse) {
    overlay(t, [
      '........F.......',
      '.......Ff.......',
      '.......fk.......',
    ], keys({ k: 0x2b2b2b, f: 0x6a6a6a, F: 0xa8a8a8 }), 6);
  }
}
def('tnt_top', (t, rng) => tntEnd(t, rng, true));
def('tnt_bottom', (t, rng) => tntEnd(t, rng, false));

def('glowstone', (t, rng) => {
  const pts = jitterPoints(rng, 4, 0.95);
  for (const p of pts) p[2] = randRange(rng, 0.8, 1.2);
  const v = voronoi(pts);
  const P = pal(0x6e4f26, 0x946c33, 0xc4924a, 0xe5b35e, 0xf8d17f, 0xfff0b8);
  const tone = pts.map(() => 2 + randInt(rng, 3));
  const h = new Float32Array(AREA);
  for (let i = 0; i < AREA; i++) h[i] = Math.min(v.gap[i], 2.5);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = y * S + x;
      if (v.gap[i] < 0.75) {
        t.set(x, y, P[rng() < 0.6 ? 0 : 1]);
        continue;
      }
      const l = tone[v.id[i]] + Math.round(slopeLight(h, x, y) * 0.6 + (rng() - 0.5) * 0.8);
      t.set(x, y, P[clampInt(l, 1, 5)]);
    }
  }
});

const PUMPKIN = pal(0x8a4f08, 0xb3680e, 0xcd8016, 0xdf9524, 0xedac3a, 0xf6c25e);
def('pumpkin_side', (t, rng) => {
  // Vertical ribs: groove at the start of each rib, lit just right of it, rounded toward the next.
  const widths = [4, 3, 4, 5];
  const ribAt = new Array(S);
  let x0 = randInt(rng, 3);
  for (let r = 0; r < widths.length; r++) {
    for (let k = 0; k < widths[r]; k++) ribAt[(x0 + k) & 15] = [k, widths[r]];
    x0 += widths[r];
  }
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const [k, w] = ribAt[x];
      let l = k === 0 ? 1 : k === 1 ? 4 : k === w - 1 ? 2 : 3;
      if (y === 0 || y === 15) l -= 1;
      if (rng() < 0.12) l += rng() < 0.5 ? -1 : 1;
      t.set(x, y, PUMPKIN[clampInt(l, 0, 5)]);
    }
  }
});

def('pumpkin_top', (t, rng) => {
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = x - 7.5;
      const dy = y - 7.5;
      const ang = Math.atan2(dy, dx);
      const rib = Math.abs(Math.sin(ang * 4));
      const r = Math.max(Math.abs(dx), Math.abs(dy));
      let l = rib < 0.22 ? 1 : rib < 0.6 ? 3 : 4;
      if (r > 6.6) l -= 1;
      if (rng() < 0.1) l += rng() < 0.5 ? -1 : 1;
      t.set(x, y, PUMPKIN[clampInt(l, 0, 5)]);
    }
  }
  overlay(t, [
    '......dSd.......',
    '.....dSsSd......',
    '......dsd.......',
  ], keys({ S: 0x6e7a2a, s: 0x55621e, d: 0x6a4410 }), 6);
});

def('jack_o_lantern', (t) => {
  paintBase(t, 'pumpkin_side');
  const FACE = [
    '................',
    '................',
    '................',
    '................',
    '....#......#....',
    '...###....###...',
    '..#####..#####..',
    '................',
    '.......##.......',
    '................',
    '..##.######.##..',
    '...##########...',
    '....###..###....',
    '................',
    '................',
    '................',
  ];
  const carved = (x, y) => y >= 0 && y < S && x >= 0 && x < S && FACE[y][x] === '#';
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      if (!carved(x, y)) continue;
      // Candle glow: bright yellow, hottest where the carving is widest.
      const core = carved(x - 1, y) && carved(x + 1, y) && carved(x, y - 1);
      t.set(x, y, rgb(core ? 0xfff4b0 : 0xffdc56));
    }
  }
  // The pumpkin rind right around the carving is darker (cut wall in shadow): face reads clearly.
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      if (carved(x, y)) continue;
      if (carved(x, y - 1) || carved(x + 1, y) || carved(x - 1, y)) t.shade(x, y, 0.72);
    }
  }
});

const CACTUS = pal(0x0d5517, 0x157022, 0x1d862c, 0x34a142, 0x5cbd5c);
const SPINE = rgb(0xd9d7a2);
def('cactus_side', (t) => {
  t.clear();
  // Columns 1..14 opaque (the mesher insets the side faces by 1 px); columns 0/15 only carry spines.
  const cols = [-1, 0, 2, 3, 2, 0, 2, 3, 3, 2, 0, 2, 3, 2, 0, -1];
  for (let y = 0; y < S; y++) {
    for (let x = 1; x < 15; x++) t.set(x, y, CACTUS[cols[x] + (y % 4 === 0 && cols[x] === 2 ? 1 : 0)]);
  }
  for (const [x, y] of [[5, 2], [10, 6], [5, 10], [10, 14], [1, 4], [14, 9], [1, 13], [14, 1]]) t.set(x, y, SPINE);
  for (const [x, y] of [[0, 4], [15, 9], [0, 13], [15, 1]]) t.set(x, y, SPINE);
});

function cactusEnd(t, P) {
  t.clear();
  for (let y = 1; y < 15; y++) {
    for (let x = 1; x < 15; x++) {
      const r = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5));
      const e = Math.hypot(x - 7.5, y - 7.5);
      let l = r > 5.9 ? 0 : r > 4.9 ? 2 : e > 3.6 ? 3 : e > 2.2 ? 1 : 2;
      if (e < 1) l = 4;
      t.set(x, y, P[l]);
    }
  }
}
def('cactus_top', (t) => cactusEnd(t, CACTUS));
def('cactus_bottom', (t) => cactusEnd(t, pal(0x3d6b2a, 0x56873a, 0x6e9e4a, 0x86b25c, 0xa7c97a)));

// =================================================================================================
// Wool (16 dye colours) and storage blocks
// =================================================================================================

const WOOL_RGB = {
  white: 0xe9ecec, orange: 0xf07613, magenta: 0xbd44b3, light_blue: 0x3aafd9,
  yellow: 0xf8c627, lime: 0x70b919, pink: 0xed8dac, gray: 0x3e4447,
  light_gray: 0x8e8e86, cyan: 0x158991, purple: 0x792aac, blue: 0x35399d,
  brown: 0x724728, green: 0x546d1b, red: 0xa12722, black: 0x141519,
};

let woolWeaveCache = null;
/** One shared soft "woven" level map (like Minecraft, every wool colour uses the same weave). */
function woolWeave() {
  if (woolWeaveCache) return woolWeaveCache;
  const rng = rngFor('wool_weave');
  const a = noise2(rng, 8, 4);
  const b = noise2(rng, 4, 8);
  const f = new Float32Array(AREA);
  for (let i = 0; i < AREA; i++) {
    const x = i & 15;
    const y = i >> 4;
    const stitch = ((x + 2 * y) & 3) === 0 ? 0.22 : 0;
    f[i] = 0.4 * a(x, y) + 0.25 * b(x, y) + 0.25 * rng() - stitch;
  }
  woolWeaveCache = quantize(f, [0.08, 0.2, 0.42, 0.2, 0.1]);
  return woolWeaveCache;
}

for (const [color] of WOOL_COLORS) {
  def(`${color}_wool`, (t) => {
    const base = rgb(WOOL_RGB[color]);
    const dark = color === 'black' ? 0.22 : 0.11;
    t.levels(woolWeave(), [
      mix(base, BLACK, dark * 1.6), mix(base, BLACK, dark * 0.75), base,
      mix(base, WHITE, 0.06), mix(base, WHITE, 0.12),
    ]);
  });
}

/** Metal storage block: bevelled plate with brushed streaks. P = 6 shades dark..highlight. */
function metalBlock(t, rng, P) {
  const streak = noise2(rng, 2, 16);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const v = streak(x, y) + (rng() - 0.5) * 0.25;
      t.set(x, y, P[v > 0.72 ? 4 : v < 0.3 ? 2 : 3]);
    }
  }
  for (let i = 0; i < S; i++) {
    t.set(i, 0, P[5]);
    t.set(0, i, P[5]);
    t.set(i, 15, P[0]);
    t.set(15, i, P[0]);
  }
  for (let i = 1; i < 15; i++) {
    t.set(i, 1, P[4]);
    t.set(1, i, P[4]);
    t.set(i, 14, P[1]);
    t.set(14, i, P[1]);
  }
  t.set(15, 0, P[2]);
  t.set(0, 15, P[2]);
}

def('iron_block', (t, rng) => metalBlock(t, rng, pal(0x8a8a8a, 0xababab, 0xcbcbcb, 0xdadada, 0xe8e8e8, 0xfafafa)));

def('gold_block', (t, rng) => {
  metalBlock(t, rng, pal(0xa8720e, 0xd59a17, 0xf1c22c, 0xf8d43c, 0xfde873, 0xffffb8));
  for (const [x, y] of [[3, 4], [4, 3], [10, 9], [11, 8], [12, 7], [6, 11], [7, 10]]) t.set(x, y, rgb(0xfffde0));
});

def('diamond_block', (t, rng) => {
  metalBlock(t, rng, pal(0x1d8f86, 0x36b8ae, 0x62dbd3, 0x7ae6df, 0xa6f6ef, 0xe2fffc));
  // Facet lattice: diagonal light lines.
  for (let y = 2; y < 14; y++) {
    for (let x = 2; x < 14; x++) {
      if (((x + y) & 7) === 0) t.set(x, y, rgb(0xc4fbf6));
      else if (((x - y) & 7) === 4) t.set(x, y, rgb(0x4cccc3));
    }
  }
});

def('coal_block', (t, rng) => {
  material(t, rng, pal(0x0c0c0c, 0x141414, 0x1b1b1b, 0x232323, 0x2e2e2e, 0x404040),
    [0.12, 0.26, 0.3, 0.2, 0.09, 0.03], [[4, 4, 0.5], [8, 8, 0.35]], 0.3);
});

def('lapis_block', (t, rng) => {
  material(t, rng, pal(0x1a3478, 0x22418f, 0x2a4fa6, 0x3560bc, 0x4a76cf, 0x7598e0),
    [0.08, 0.2, 0.34, 0.22, 0.11, 0.05], [[8, 8, 0.5], [4, 4, 0.2]], 0.5);
  for (let i = 0; i < S; i++) {
    t.blend(i, 0, WHITE, 0.15);
    t.blend(0, i, WHITE, 0.15);
    t.blend(i, 15, BLACK, 0.25);
    t.blend(15, i, BLACK, 0.25);
  }
});

// =================================================================================================
// Wave 2 blocks: chest, lit furnace, farmland, wheat crops (docs/SPEC-wave2.md §7)
// =================================================================================================

/**
 * Chest: Minecraft's chest is a 14/16 box (inset 1/16 on every side, 14/16 tall); the mesher maps every
 * face texture in full onto it (uniform 14/16 scale), so the whole tile is one box face and its outer
 * ring is the box edge. Front / sides: the lid (rows 0..5: lit top edge, one board, lower edge), the
 * dark gap under the lid (row 6) and the base (rows 7..15: two boards, bottom edge). The front carries
 * a dark-iron latch at cols 7..8 / rows 4..7 — exactly the texels the mesher's 2x4x1 px lock box samples
 * (front u 7..9 v 4..8, top row 4, bottom row 7, sides column 7) — outlined on the wood.
 */
const CHEST = {
  o: rgb(0x2b1b0b),   // gap / deepest shadow
  f: rgb(0x4f3314),   // frame (box edges in shadow)
  F: rgb(0x6b451a),   // frame lit from the top-left
  w: pal(0x7a4e1f, 0x93602a, 0xa86f31, 0xbb7f3b, 0xcc9049), // board shades, dark -> highlight
};
const CHEST_LATCH = { L: 0xb9b9b9, M: 0x8c8c8c, D: 0x5e5e5e, K: 0x2e2e2e };

/** Horizontal boards filling [x0..x1] x [y0..y1]; `seams` = rows drawn as plank joints. */
function chestBoards(t, rng, x0, y0, x1, y1, seams) {
  // Grain = long horizontal streaks (slow along x, fast along y) plus a few darker grain dashes.
  const grain = noise2(rng, 2, 16);
  const W = CHEST.w;
  for (let y = y0; y <= y1; y++) {
    if (seams.includes(y)) {
      for (let x = x0; x <= x1; x++) t.set(x, y, W[0]);
      continue;
    }
    // A board is lit along its top row and falls off toward its lower edge.
    const top = y === y0 || seams.includes(y - 1);
    const bottom = y === y1 || seams.includes(y + 1);
    for (let x = x0; x <= x1; x++) {
      let v = 2.2 + (grain(x, y) - 0.5) * 2.2 + (rng() - 0.5) * 0.35;
      if (top) v += 1;
      if (bottom) v -= 0.9;
      t.set(x, y, W[clampInt(Math.round(v), 1, 4)]);
    }
    if (!top && !bottom && y1 - y0 >= 2) {
      const len = 2 + randInt(rng, 3);
      const sx = x0 + 1 + randInt(rng, Math.max(1, x1 - x0 - len));
      for (let x = sx; x < sx + len && x <= x1; x++) t.set(x, y, W[1]);
    }
  }
}

/** Chest side / front: lid + base boards inside the box edges, the gap under the lid; latch when `front`. */
function chestSide(t, rng, front) {
  for (let i = 0; i < AREA; i++) t.setI(i, CHEST.f);
  for (let x = 0; x < S; x++) {
    t.set(x, 0, x === 15 ? CHEST.f : CHEST.F);   // lid top edge, lit
    t.set(x, 6, CHEST.o);                         // gap under the lid
  }
  for (const [y0, y1] of [[1, 4], [7, 14]]) {
    for (let y = y0; y <= y1; y++) t.set(0, y, CHEST.F); // left edges lit, right edges (col 15) stay dark
  }
  chestBoards(t, rng, 1, 1, 14, 4, []);
  chestBoards(t, rng, 1, 7, 14, 14, [11]);
  // Bevelled corners where the edges meet.
  for (const [x, y] of [[0, 5], [15, 5], [0, 15], [15, 15]]) t.set(x, y, CHEST.o);
  if (!front) return;
  const P = keys(CHEST_LATCH);
  overlay(t, [
    '......KLMK......',
    '......KMDK......',
    '......KMDK......',
    '......KDKK......',
    '.......KK.......',
  ], P, 4);
  // Drop shadow of the lock on the wood (light comes from the top-left).
  for (const [x, y] of [[10, 5], [10, 7], [10, 8], [9, 9], [10, 9], [8, 9]]) t.shade(x, y, 0.72);
}

def('chest_front', (t, rng) => chestSide(t, rng, true));
def('chest_side', (t, rng) => chestSide(t, rng, false));

def('chest_top', (t, rng) => {
  for (let i = 0; i < AREA; i++) t.setI(i, CHEST.f);
  // Edge of the lid, lit from the top-left; three boards inside.
  for (let i = 0; i < S; i++) {
    t.set(i, 0, CHEST.F);
    t.set(0, i, CHEST.F);
  }
  t.set(15, 0, CHEST.f);
  t.set(0, 15, CHEST.f);
  chestBoards(t, rng, 1, 1, 14, 14, [5, 10]);
});

/**
 * Lit furnace: the furnace front (same stone, same seed) with fire in the lower opening and a warm
 * glow on the stone around it; the upper vent glows dimly.
 */
def('furnace_front_on', (t) => {
  paintBase(t, 'furnace_front');
  const FIRE = keys({
    r: 0x6e1804, R: 0xa82a08, o: 0xd04c10, O: 0xec7418, Y: 0xf9a92c, W: 0xffd75a, H: 0xfff4b8,
  });
  // Opening interior: cols 3..12, rows 8..12 (row 7 = frame, row 13 = the lit ledge). Three flame
  // tongues over a bed of white-hot embers; '.' keeps the dark interior.
  overlay(t, [
    '....R..r..R.....',
    '...rOr.R.rOr....',
    '...RYOrORoYOr...',
    '...OWYOYOYWYO...',
    '...YHWYWYWHWY...',
  ], FIRE, 8);
  // Embers glowing in the upper vent.
  overlay(t, ['....rRrrRrr.....'], FIRE, 4);
  // Fire light on the ledge below and the stone around the opening.
  const GLOW = rgb(0xff8a2a);
  for (let x = 2; x <= 13; x++) t.blend(x, 13, GLOW, 0.45);
  for (let y = 6; y <= 14; y++) {
    for (let x = 1; x <= 14; x++) {
      const inside = x >= 2 && x <= 13 && y >= 7 && y <= 13;
      if (!inside) t.blend(x, y, GLOW, 0.12);
    }
  }
});

/**
 * Farmland top: tilled soil in four straight furrows (period 4 rows) lit from the top-left: dark
 * groove, lit slope, crest, shaded slope. Crumbs, clods and small pebbles break the stripes up. Moist
 * farmland uses the same pattern with dark, wet colours. Tiles seamlessly.
 */
function farmland(t, rng, P) {
  // Crumbly soil grain (like dirt) with the furrow profile laid over it. The furrows run straight
  // (staggered steps read as bricks / planks); crumbs that fell into the grooves and clods on the
  // ridges keep them from looking ruled.
  const soil = quantize(field(rng, [[8, 8, 0.5], [16, 16, 0.3]], 0.55), [0.2, 0.6, 0.2]);
  const PROFILE = [0, 3, 2.4, 1.2]; // groove, lit slope, crest, shaded slope
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const r = y & 3;
      const g = soil[y * S + x];
      let l;
      if (r === 0) l = g === 2 && rng() < 0.7 ? 2 : g === 2 ? 1 : 0;     // groove, with fallen crumbs
      else l = PROFILE[r] + g - 1 + (rng() < 0.12 ? (rng() < 0.5 ? -1 : 1) : 0);
      t.set(x, y, P[clampInt(Math.round(l), 0, 4)]);
    }
  }
  // Clods / pebbles on the ridges (lit top-left, a shadow texel below-right).
  for (let k = 0; k < 6; k++) {
    const x = randInt(rng, S);
    const y = randInt(rng, 4) * 4 + 1 + randInt(rng, 2);
    t.set(x, y, P[k < 2 ? 5 : 4]);
    t.set(x + 1, y + 1, P[1]);
  }
}

def('farmland', (t, rng) => farmland(t, rng, pal(0x4a3120, 0x634330, 0x7a5539, 0x8e6545, 0xa27652, 0xb08a68)));
def('farmland_moist', (t, rng) => farmland(t, rng, pal(0x22150a, 0x2f1e11, 0x3c2817, 0x49321e, 0x563c25, 0x6a5038)));

/**
 * Wheat crop stages 0..7 (cutout, untinted). One fixed field of stalks grows with the stage: height
 * 2 + 2·stage px (the selection box grows by 2/16 per stage), leaves from stage 2, colour from fresh
 * green to golden yellow, ears from stage 5 (full ears with awns at stage 7). Rendered as the '#'
 * crop model (four planes), so every stalk stands on the bottom edge.
 */
// Five plants per tile (ears of neighbouring plants never overlap: bases 3 px apart), staggered
// heights so the ears read one by one. lean: column shift applied in the upper part of the stalk.
// leaves: [side, start (fraction of the stalk height), length factor].
const WHEAT_PLANTS = [
  { x: 2, h: 0.82, lean: 0, leaves: [[-1, 0.15, 0.8], [1, 0.42, 1]] },
  { x: 5, h: 1.0, lean: 0, leaves: [[1, 0.1, 1], [-1, 0.5, 0.8]] },
  { x: 8, h: 0.72, lean: 1, leaves: [[-1, 0.2, 1], [1, 0.55, 0.7]] },
  { x: 11, h: 0.92, lean: 0, leaves: [[1, 0.18, 0.9], [-1, 0.45, 1]] },
  { x: 14, h: 0.86, lean: -1, leaves: [[-1, 0.12, 1], [1, 0.5, 0.7]] },
];
// Stalk / leaf colours per stage: [dark, mid, light].
const WHEAT_COLORS = [
  [0x2c7517, 0x3f9425, 0x5cb637], [0x2c7517, 0x3f9425, 0x5cb637], [0x2b7016, 0x3e8f24, 0x58b034],
  [0x2b6c16, 0x418d25, 0x5daa35], [0x356f19, 0x518d27, 0x72ab38], [0x4f7420, 0x6f932c, 0x92b03f],
  [0x7a7a26, 0x9a9636, 0xb7b14c], [0x8f7022, 0xb08c35, 0xcaa84a],
];
// Ears from stage 5: k = dark husk / outline, m = grain, l = lit grain, a = awn; len in px.
const WHEAT_EARS = [
  null, null, null, null, null,
  { k: 0x5f7a1e, m: 0x8fae3a, l: 0xb2cc5c, a: 0xb2cc5c, len: 3 },
  { k: 0x86782a, m: 0xc1b046, l: 0xdcd26c, a: 0xd8cf74, len: 4 },
  { k: 0x8a6420, m: 0xd5aa40, l: 0xf0d273, a: 0xe9d595, len: 5 },
];

for (let stage = 0; stage < 8; stage++) {
  def(`wheat_stage_${stage}`, (t) => {
    t.clear();
    const [cd, cm, cl] = WHEAT_COLORS[stage].map(rgb);
    const earDef = WHEAT_EARS[stage];
    const full = 2 + 2 * stage; // px: stage 0 = 2 ... stage 7 = 16
    for (const plant of WHEAT_PLANTS) {
      const h = clampInt(Math.round(full * plant.h), stage === 0 ? 1 : 2, 16);
      // Stalk pixels from the ground up (the lean kicks in over the upper half of tall stalks).
      const stalk = [];
      for (let j = 0; j < h; j++) stalk.push([plant.x + (h >= 8 && j >= h * 0.55 ? plant.lean : 0), 15 - j]);
      stalk.forEach(([x, y], j) => t.set(x, y, j < h * 0.3 ? cd : j < h * 0.8 ? cm : cl));
      if (stage <= 1) {
        // Seedlings: the tip opens into a tiny V.
        const [x, y] = stalk[h - 1];
        if (h >= 2) t.set(x + (plant.x % 2 ? 1 : -1), y, cl);
        continue;
      }
      // Leaves: blades leaving the stalk at a steep angle and curving upward (at most 1 px out from
      // the stalk, so neighbouring plants never join up), lit toward the tip.
      for (const [side, f, lf] of plant.leaves) {
        const j0 = Math.min(h - 2, Math.round(h * f));
        const len = Math.max(1, Math.round(Math.min(4, 1 + stage * 0.5) * lf));
        let [x, y] = stalk[Math.max(0, j0)];
        x += side;
        for (let k = 1; k <= len; k++) {
          y -= 1;
          if (x < 0 || x >= S || y < 0) break;
          t.set(x, y, k === len ? cl : cm);
        }
      }
      if (!earDef) continue;
      // Ear: the top `len` stalk pixels hold grains; husk pixels left/right alternate (left lit,
      // right shaded), with a pale awn above.
      const E = { k: rgb(earDef.k), m: rgb(earDef.m), l: rgb(earDef.l), a: rgb(earDef.a) };
      const len = Math.min(earDef.len, h - 3);
      for (let k = 0; k < len; k++) {
        const [x, y] = stalk[h - 1 - k];
        t.set(x, y, k % 2 === 0 ? E.l : E.m);
        if (k === 0) continue;
        if (x - 1 >= 0) t.set(x - 1, y, k % 2 === 1 ? E.l : E.m);
        if (x + 1 < S) t.set(x + 1, y, k % 2 === 1 ? E.m : E.k);
      }
      // Husk tip / base pixels darken the ear outline so neighbouring ears stay separate.
      const [bx, by] = stalk[h - 1 - len];
      t.set(bx, by, E.k);
      if (stage >= 6) {
        const [tx, ty] = stalk[h - 1];
        if (ty > 0) t.set(tx, ty - 1, E.a);
        if (stage === 7 && ty > 1) t.set(tx + (plant.x % 2 ? -1 : 1), ty - 2, E.a);
      }
    }
  });
}

// =================================================================================================
// Block-breaking crack overlays
// =================================================================================================

let crackCache = null;
/**
 * Order in which texels crack (-1 = never): branching random walks growing outward from the
 * centre, advanced round-robin so every stage adds cracks evenly. Shared by all ten stages so
 * each stage contains the previous one.
 */
function crackOrder() {
  if (crackCache) return crackCache;
  const rng = rngFor('destroy_stage');
  const order = new Int16Array(AREA).fill(-1);
  let n = 0;
  const mark = (x, y) => {
    if (x < 0 || y < 0 || x > 15 || y > 15) return false;
    const i = y * S + x;
    if (order[i] < 0) order[i] = n++;
    return true;
  };
  const tips = [];
  const spawn = (x, y, a, life) => tips.push({ x, y, a, life });
  mark(7, 8);
  const a0 = rng() * Math.PI * 2;
  for (let k = 0; k < 4; k++) spawn(7.5, 8.5, a0 + (k * Math.PI) / 2 + (rng() - 0.5) * 0.7, 5 + randInt(rng, 5));
  let guard = 0;
  while (n < 150 && guard++ < 4000) {
    if (tips.length === 0) {
      // Re-seed from a random existing crack texel.
      const cracked = [];
      for (let i = 0; i < AREA; i++) if (order[i] >= 0) cracked.push(i);
      const i = cracked[randInt(rng, cracked.length)];
      spawn((i & 15) + 0.5, (i >> 4) + 0.5, rng() * Math.PI * 2, 3 + randInt(rng, 5));
    }
    for (let k = 0; k < tips.length; k++) {
      const tp = tips[k];
      tp.a += (rng() - 0.5) * 0.9;
      tp.x += Math.cos(tp.a);
      tp.y += Math.sin(tp.a);
      const ok = mark(Math.floor(tp.x), Math.floor(tp.y));
      tp.life--;
      if (!ok || tp.life <= 0) {
        if (ok && rng() < 0.7) {
          spawn(tp.x, tp.y, tp.a + 0.8, 3 + randInt(rng, 5));
          spawn(tp.x, tp.y, tp.a - 0.8, 3 + randInt(rng, 5));
        }
        tips.splice(k--, 1);
        continue;
      }
      if (rng() < 0.1) spawn(tp.x, tp.y, tp.a + (rng() < 0.5 ? -1 : 1) * (0.7 + rng() * 0.6), 2 + randInt(rng, 4));
    }
  }
  crackCache = order;
  return order;
}

const CRACK_COUNTS = [5, 12, 21, 32, 45, 60, 77, 96, 118, 145];
for (let stage = 0; stage < 10; stage++) {
  def(`destroy_stage_${stage}`, (t) => {
    const order = crackOrder();
    const limit = CRACK_COUNTS[stage];
    const cracked = (x, y) => x >= 0 && y >= 0 && x < S && y < S && order[y * S + x] >= 0 && order[y * S + x] < limit;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        if (cracked(x, y)) {
          // Older cracks are darker; transparent texels stay neutral grey (128) for multiply blending.
          const age = 1 - order[y * S + x] / limit;
          t.set(x, y, gray(c255(0x4c - age * 0x24)), 235);
        } else if (cracked(x - 1, y) || cracked(x + 1, y) || cracked(x, y - 1) || cracked(x, y + 1)) {
          t.set(x, y, gray(0x66), 120);
        } else {
          t.set(x, y, gray(128), 0);
        }
      }
    }
  });
}

// =================================================================================================
// Items (hand-authored 16x16 pixel maps; the 1-px outline is generated)
// =================================================================================================

const HANDLE = { l: 0x8f6a2c, m: 0x654b20 };
const HANDLE_OUTLINE = 0x2a1d09;

def('stick', (t) => {
  itemSprite(t, [
    '................',
    '................',
    '.............lm.',
    '............lm..',
    '...........lm...',
    '..........lm....',
    '.........lm.....',
    '........lm......',
    '.......lm.......',
    '......lm........',
    '.....lm.........',
    '....lm..........',
    '...lm...........',
    '..lm............',
    '................',
    '................',
  ], keys(HANDLE), [['lm', HANDLE_OUTLINE]]);
});

const TOOL_SHAPES = {
  sword: [
    '................',
    '.............WL.',
    '............WLD.',
    '...........WLD..',
    '..........WLD...',
    '.........WLD....',
    '........WLD.....',
    '...M...WLD......',
    '...MM.WLD.......',
    '....MMLD........',
    '.....MM.........',
    '....lmMM........',
    '...lm..M........',
    '..lm............',
    '.PM.............',
    '................',
  ],
  shovel: [
    '................',
    '...........WWL..',
    '..........WLLLM.',
    '..........LLLMD.',
    '..........LLMDD.',
    '..........lMDD..',
    '.........lm.....',
    '........lm......',
    '.......lm.......',
    '......lm........',
    '.....lm.........',
    '....lm..........',
    '...lm...........',
    '..lm............',
    '................',
    '................',
  ],
  pickaxe: [
    '................',
    '....LWWWWLLL....',
    '...LMMMMMMMMM...',
    '..MD........ML..',
    '...........lmLD.',
    '..........lm.LD.',
    '.........lm..LD.',
    '........lm...LD.',
    '.......lm....LD.',
    '......lm.....LD.',
    '.....lm......LD.',
    '....lm.......MD.',
    '...lm.......DD..',
    '..lm........D...',
    '................',
    '................',
  ],
  axe: [
    '................',
    '.....WL.........',
    '....WLLM....lm..',
    '....WLLMMD.lm...',
    '....WLMMMDlm....',
    '....LLMMDlm.....',
    '.....LMDlm......',
    '......Dlm.......',
    '......lm........',
    '.....lm.........',
    '....lm..........',
    '...lm...........',
    '..lm............',
    '.lm.............',
    '................',
    '................',
  ],
  // Hoe (wave 2): a flat head on top of the handle, its blade end hooking down on the left.
  hoe: [
    '................',
    '......LWWWWWL...',
    '.....LMMMMMMMMD.',
    '.....MD.....lmD.',
    '.....D.....lm...',
    '..........lm....',
    '.........lm.....',
    '........lm......',
    '.......lm.......',
    '......lm........',
    '.....lm.........',
    '....lm..........',
    '...lm...........',
    '..lm............',
    '................',
    '................',
  ],
};

const TOOL_HEADS = {
  wooden: { O: 0x3b2a10, D: 0x6b5028, M: 0x8f6c3a, L: 0xb08a50, W: 0xc9a46a },
  stone: { O: 0x2a2a2a, D: 0x585858, M: 0x7b7b7b, L: 0x989898, W: 0xb6b6b6 },
  iron: { O: 0x353535, D: 0x9a9a9a, M: 0xc2c2c2, L: 0xdedede, W: 0xffffff },
  golden: { O: 0x6b4a0a, D: 0xc98f17, M: 0xeac234, L: 0xfbe773, W: 0xffffc8 },
  diamond: { O: 0x0f4a40, D: 0x1fa58c, M: 0x3fd9c0, L: 0x8ff5e2, W: 0xdcfffa },
};

for (const mat of Object.keys(TOOL_HEADS)) {
  const h = TOOL_HEADS[mat];
  for (const kind of Object.keys(TOOL_SHAPES)) {
    def(`${mat}_${kind}`, (t) => {
      itemSprite(t, TOOL_SHAPES[kind], keys({ W: h.W, L: h.L, M: h.M, D: h.D, P: h.D, ...HANDLE }),
        [['WLMDP', h.O], ['lm', HANDLE_OUTLINE]]);
    });
  }
}

const LUMP = [
  '................',
  '................',
  '................',
  '......MLL.......',
  '....MMLWLM......',
  '...MLWLLMMD.....',
  '...LWLMMMMDD....',
  '..MLLMMMDMMDD...',
  '..MLMMMDDMDDD...',
  '..MMMMDDMDDDD...',
  '...MMMDDDDDD....',
  '...DMDDDDDD.....',
  '.....DDDDD......',
  '................',
  '................',
  '................',
];
def('coal', (t) => itemSprite(t, LUMP, keys({ W: 0x5f5f5f, L: 0x434343, M: 0x2c2c2c, D: 0x1c1c1c }), [['WLMD', 0x0a0a0a]]));
def('charcoal', (t) => itemSprite(t, LUMP, keys({ W: 0x6e5c4a, L: 0x4f4134, M: 0x382d23, D: 0x261e17 }), [['WLMD', 0x110d09]]));

// Diagonal bar seen from above: lit top face (W = far edge highlight), front face, left end face.
const INGOT = [
  '................',
  '................',
  '................',
  '................',
  '.........WWWW...',
  '.......WWLLLLW..',
  '.....WWLLLLLMM..',
  '...WWLLLLLMMMD..',
  '.WWLLLLLMMMDD...',
  '.EELLLMMMDD.....',
  '.EEEEMMDD.......',
  '..EEEDD.........',
  '................',
  '................',
  '................',
  '................',
];
def('iron_ingot', (t) => itemSprite(t, INGOT, keys({ W: 0xffffff, L: 0xdedede, E: 0xc4c4c4, M: 0xacacac, D: 0x828282 }), [['WLEMD', 0x3c3c3c]]));
def('gold_ingot', (t) => itemSprite(t, INGOT, keys({ W: 0xffffc8, L: 0xfbe24a, E: 0xf2cc38, M: 0xe2aa26, D: 0xb07812 }), [['WLEMD', 0x5a3a06]]));

def('diamond', (t) => {
  itemSprite(t, [
    '................',
    '................',
    '................',
    '.....LWWWLL.....',
    '....LWWLLLMM....',
    '...LWLLLLLMMM...',
    '..LLLLLLLMMMMD..',
    '..DLLLLLMMMMDD..',
    '...DLLLMMMMDD...',
    '....DLLMMMDD....',
    '.....DLMMDD.....',
    '......DMDD......',
    '.......DD.......',
    '................',
    '................',
    '................',
  ], keys({ W: 0xe8fffb, L: 0x9ff5e6, M: 0x4adfcb, D: 0x22a596 }), [['WLMD', 0x0d4a43]]);
});

def('redstone', (t) => {
  itemSprite(t, [
    '................',
    '................',
    '................',
    '................',
    '........R.......',
    '......RRHR..R...',
    '....R.RRRRRRR...',
    '...RRHRRRdRRHR..',
    '..RRRRRRRRRRRR..',
    '..RHRRdRRRHRRR..',
    '...RRRRRRRRRRd..',
    '....dRRdRRRRd...',
    '......dddd......',
    '................',
    '................',
    '................',
  ], keys({ R: 0xd40c0c, H: 0xff6a5a, d: 0x8e0000 }), [['RHd', 0x4a0000]]);
});

def('lapis_lazuli', (t) => {
  itemSprite(t, [
    '................',
    '................',
    '................',
    '......LLLL......',
    '.....LMMSML.....',
    '....LMSMMMMD....',
    '...LMMMMSMMMD...',
    '..LMSMMMMMMMD...',
    '..MMMMMSMMMDD...',
    '..DMMMMMMSDD....',
    '...DMSMMMDD.....',
    '....DDMMDD......',
    '......DD........',
    '................',
    '................',
    '................',
  ], keys({ L: 0x5a85e0, M: 0x2c56c2, S: 0xb7cbf7, D: 0x1c3a8e }), [['LMSD', 0x0d1f55]]);
});

def('flint', (t) => {
  itemSprite(t, [
    '................',
    '................',
    '.........L......',
    '........LWM.....',
    '.......LWMM.....',
    '......LWMMMD....',
    '.....LLMMMMD....',
    '.....LMMMMMDD...',
    '....LLMMMMDDD...',
    '....LMMMMDDDD...',
    '....LMMMDDDDD...',
    '.....MMMDDDD....',
    '......MDDDD.....',
    '................',
    '................',
    '................',
  ], keys({ W: 0x9a9a9a, L: 0x6e6e6e, M: 0x4a4a4a, D: 0x2e2e2e }), [['WLMD', 0x141414]]);
});

def('flint_and_steel', (t) => {
  itemSprite(t, [
    '................',
    '................',
    '....SSSS........',
    '...SHMMSS.......',
    '..SH....MS......',
    '..SM.....S......',
    '..SM.....S......',
    '...SM...SS......',
    '....SSSSSffF....',
    '.......fFFFff...',
    '......fFFfffff..',
    '......ffFfffff..',
    '.......ffffff...',
    '........ffff....',
    '................',
    '................',
  ], keys({ S: 0x8c8c8c, H: 0xd0d0d0, M: 0x6a6a6a, f: 0x3c3c3c, F: 0x6a6a6a }), [['SHM', 0x2e2e2e], ['fF', 0x141414]]);
});

def('apple', (t) => {
  itemSprite(t, [
    '................',
    '................',
    '........s.......',
    '........s.gG....',
    '.......s.gGg....',
    '....RRRsRRR.....',
    '...RWWRRRRRR....',
    '..RWWRRRRRRRd...',
    '..RWRRRRRRRRd...',
    '..RRRRRRRRRRd...',
    '..RRRRRRRRRdd...',
    '...RRRRRRRRd....',
    '...dRRRRRRdd....',
    '....ddRdddd.....',
    '................',
    '................',
  ], keys({ R: 0xd8261f, W: 0xff8a7a, d: 0x9a1410, s: 0x5a3a1a, g: 0x3f8f2a, G: 0x62b33c }),
  [['RWd', 0x4f0a08], ['s', 0x2a1a0a], ['gG', 0x1f4a14]]);
});

const CHOP = [
  '................',
  '................',
  '................',
  '......FFFF......',
  '....FFPPPPFF....',
  '...FPPLLPPPPF...',
  '..FPPLLPPPpPPF..',
  '..FPLPPPPpPPPF..',
  '.FPPPPPppPPPPF..',
  '.FPPPPpPPPPPF...',
  '.FPPpPPPPPPF....',
  '..FPPPPPPPF.....',
  '...FFPPPFF......',
  '.....FFF........',
  '................',
  '................',
];
const STEAK = [
  '................',
  '................',
  '................',
  '................',
  '.....PPPPP......',
  '...PPLLPPPPF....',
  '..PPLLPPPPPPF...',
  '..PLPPpPPPPPF...',
  '.PPPPPPPPpPPFF..',
  '.PPPpPPPPPPPF...',
  '.PPPPPPPPPPF....',
  '..PPPPPPPFF.....',
  '...FPPPFF.......',
  '....FFF.........',
  '................',
  '................',
];
def('porkchop', (t) => itemSprite(t, CHOP, keys({ F: 0xf6d3cf, P: 0xec8f94, L: 0xf6b2b4, p: 0xc96a72 }), [['FPLp', 0x7a3a3e]]));
def('cooked_porkchop', (t) => itemSprite(t, CHOP, keys({ F: 0xe0bf8a, P: 0xb07a46, L: 0xc99258, p: 0x8a5a2e }), [['FPLp', 0x4a2e12]]));
def('beef', (t) => itemSprite(t, STEAK, keys({ F: 0xf2e6dc, P: 0xc8332c, L: 0xe05a4e, p: 0x92201c }), [['FPLp', 0x4f0e0b]]));
def('cooked_beef', (t) => itemSprite(t, STEAK, keys({ F: 0xb08a5a, P: 0x7a4a24, L: 0x96603a, p: 0x5a3418 }), [['FPLp', 0x2e1a0a]]));

def('rotten_flesh', (t) => {
  itemSprite(t, [
    '................',
    '................',
    '................',
    '........gg......',
    '......ggGRgg....',
    '....gGRRrRGgg...',
    '...gRRrRRRGGg...',
    '..gGRRRrRRRRg...',
    '..gRRrRRRrRGg...',
    '...gRRRRRRRg....',
    '....gGRRrRGg....',
    '.....ggGGggg....',
    '.......gg.......',
    '................',
    '................',
    '................',
  ], keys({ g: 0x5f6e2a, G: 0x7e8a3a, R: 0xa0503a, r: 0x6e2e20 }), [['gGRr', 0x2e2a12]]);
});

def('bread', (t) => {
  itemSprite(t, [
    '................',
    '................',
    '................',
    '................',
    '................',
    '..........LLL...',
    '........LLLWLL..',
    '......LLdLLdLLM.',
    '....LLdLLdLLdLM.',
    '..LLdLLdLLdLLMM.',
    '.LdLLdLLdLLLMMD.',
    '.MLLLLLLLLMMMDD.',
    '.DMMMMMMMMMMDD..',
    '..DDDDDDDDDD....',
    '................',
    '................',
  ], keys({ L: 0xd9a24a, W: 0xf0c878, d: 0xa8722a, M: 0xb5802f, D: 0x7c501a }), [['LWdMD', 0x3e2408]]);
});

def('gunpowder', (t) => {
  itemSprite(t, [
    '................',
    '................',
    '................',
    '................',
    '................',
    '.......G........',
    '.....G.GG.G.....',
    '....GGGgGLGG....',
    '...GgGGGGgGGG...',
    '..GGLGgGGGGgGG..',
    '..GgGGGGGgGLGG..',
    '...GGGgGGGGGG...',
    '....ddGGGGdd....',
    '......dddd......',
    '................',
    '................',
  ], keys({ G: 0x6e6e6e, g: 0x4a4a4a, L: 0x9a9a9a, d: 0x505050 }), [['GgLd', 0x262626]]);
});

def('leather', (t) => {
  itemSprite(t, [
    '................',
    '................',
    '................',
    '...LL......LL...',
    '...LMMMMMMMML...',
    '....MMLMMMMM....',
    '....MLMMMMDM....',
    '...MMMMMMMMMM...',
    '...MMMMMDMMMM...',
    '....MMMMMMMM....',
    '....MMMDMMMD....',
    '...MMMMMMMMMM...',
    '...DD......DD...',
    '................',
    '................',
    '................',
  ], keys({ L: 0xb0703c, M: 0x8f5428, D: 0x6a3a18 }), [['LMD', 0x3a1e0a]]);
});

def('feather', (t) => {
  itemSprite(t, [
    '................',
    '................',
    '............WW..',
    '..........WWsL..',
    '.........WWsLL..',
    '.......WWWsLL...',
    '......WWWsLL....',
    '.....WWWsLL.....',
    '....WWWsLL......',
    '....WWsLL.......',
    '....WsL.........',
    '....q...........',
    '...q............',
    '..q.............',
    '................',
    '................',
  ], keys({ W: 0xf4f4f4, L: 0xcfcfd6, s: 0xa8a8b0, q: 0x8a8a90 }), [['WLsq', 0x5a5a62]]);
});

def('string', (t) => {
  // A loose white thread with a soft grey shadow (no hard outline, like a real thread).
  itemSprite(t, [
    '................',
    '................',
    '...........www..',
    '..........w...ws',
    '..........ws..ws',
    '...........wwws.',
    '..........ws....',
    '.........ws.....',
    '........ws......',
    '......wws.......',
    '.....ws.........',
    '....ws..........',
    '...ws...........',
    '..ws............',
    '................',
    '................',
  ], keys({ w: 0xf2f2f2, s: 0x8c8c8c }), []);
});

def('bone', (t) => {
  itemSprite(t, [
    '................',
    '.............W..',
    '...........WWWM.',
    '............WMM.',
    '...........WM...',
    '..........WM....',
    '.........WM.....',
    '........WM......',
    '.......WM.......',
    '......WM........',
    '.....WM.........',
    '....WM..........',
    '.WWWM...........',
    '.WMM............',
    '..M.............',
    '................',
  ], keys({ W: 0xf2efe2, M: 0xcfc9b4 }), [['WM', 0x6e6a5a]]);
});

const BUCKET = [
  '................',
  '................',
  '................',
  '....LLLLLLLL....',
  '...LkkkkkkkkL...',
  '..LkkkkkkkkkkM..',
  '..LWLLLLLLLLMM..',
  '...LWMMMMMMMD...',
  '...LWMMMMMMMD...',
  '...LWMMMMMMMD...',
  '....LWMMMMMD....',
  '....LWMMMMMD....',
  '....LMMMMMMD....',
  '.....DDDDDD.....',
  '................',
  '................',
];
const BUCKET_METAL = { L: 0xc8c8c8, W: 0xe8e8e8, M: 0x9e9e9e, D: 0x6e6e6e };
def('bucket', (t) => itemSprite(t, BUCKET, keys({ ...BUCKET_METAL, k: 0x3a3a3a }), [['LWMDk', 0x2a2a2a]]));
def('water_bucket', (t) => {
  itemSprite(t, BUCKET, keys({ ...BUCKET_METAL, k: 0x2f5fd0 }), [['LWMDk', 0x2a2a2a]]);
  for (const [x, y] of [[5, 4], [6, 4], [9, 5], [10, 5], [4, 5]]) t.set(x, y, rgb(0x5a86e8));
});
def('lava_bucket', (t) => {
  itemSprite(t, BUCKET, keys({ ...BUCKET_METAL, k: 0xe0661c }), [['LWMDk', 0x2a2a2a]]);
  for (const [x, y] of [[5, 4], [6, 4], [9, 5], [10, 5], [4, 5], [11, 4]]) t.set(x, y, rgb(0xfbb43a));
});

// =================================================================================================
// Wave 2 items (docs/SPEC-wave2.md §7). Hoes are the fifth TOOL_SHAPES entry above.
// =================================================================================================

/** Empty 16×16 grid of sprite keys ('.' = transparent) for sprites built programmatically. */
function keyGrid() {
  return Array.from({ length: S }, () => new Array(S).fill('.'));
}
const gridRows = (g) => g.map((r) => r.join(''));
/** Set key k at integer texel (x, y) of grid g (ignored outside the tile). */
function put(g, x, y, k) {
  if (x >= 0 && y >= 0 && x < S && y < S) g[y][x] = k;
}

def('wheat_seeds', (t) => {
  // A loose heap of small seeds (lit top-left), the auto-outline separates them.
  const g = keyGrid();
  const SEEDS = [[5, 2, 1], [10, 4, -1], [3, 7, -1], [8, 8, 1], [12, 10, 1], [5, 11, -1]];
  for (const [x, y, dir] of SEEDS) {
    // A grain tilted along dir: lit end, body, shaded end.
    const x0 = dir > 0 ? x : x + 1;
    put(g, x0, y, 'L');
    put(g, x0, y + 1, 'M');
    put(g, x0 + dir, y + 1, 'M');
    put(g, x0 + dir, y + 2, 'D');
  }
  itemSprite(t, gridRows(g), keys({ L: 0xb5cf6a, M: 0x80a83c, D: 0x557826 }), [['LMD', 0x253a10]]);
});

def('wheat', (t) => {
  // A sheaf along the diagonal: thin stalks (bottom-left), a twine tie, then the ears fanning out
  // toward the top-right with a grain pattern and pale awns at the tips.
  const g = keyGrid();
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const s = (x - y + 11) / 2;   // position along the sheaf: 0 = stalk ends, 11 = ear tips
      const d = x + y - 15;         // offset across it (0 / 1 = the centre stair)
      if (s < 0 || s > 11.5) continue;
      if (s < 4.5) {
        if (d === 0 || d === 1) g[y][x] = (x + y) % 2 ? 's' : 'S';
        else if ((d === -1 || d === 2) && s > 2.5) g[y][x] = 's';
      } else if (s < 6) {
        if (d >= -1 && d <= 2) g[y][x] = d <= 0 ? 'T' : 't';
      } else {
        const half = s > 10.5 ? 1 : 2;
        if (d < -half || d > half + 1) continue;
        // Grains: rows of three, separated by darker husk lines; the upper-left side is lit.
        const husk = (x + 2 * y) % 3 === 0;
        g[y][x] = husk ? 'k' : d <= 0 ? 'Y' : 'y';
      }
    }
  }
  for (const [x, y] of [[13, 0], [15, 2], [11, 0], [15, 4], [14, 1]]) put(g, x, y, 'a');
  itemSprite(t, gridRows(g), keys({
    S: 0xc9a54a, s: 0xa8842e, T: 0x8a5a26, t: 0x6e4519, Y: 0xf2d77c, y: 0xd8b04a, k: 0xa67c2a, a: 0xeedc9a,
  }), [['SsYyka', 0x4e3608], ['Tt', 0x3a2208]]);
});

// Lamb leg: meat with fat streaks (upper right), the bone sticking out to the lower left.
const MUTTON = [
  '................',
  '................',
  '.........FFFF...',
  '.......FFRRRRF..',
  '......FRRLLRRRF.',
  '.....FRLLRRFRRF.',
  '.....RLRRFFRRRF.',
  '.....RRFFRRRRdF.',
  '.....RRRRRRRddF.',
  '.....dRRRRRddF..',
  '.....BddddddF...',
  '....BWb.FFF.....',
  '...BWb..........',
  '.BBWb...........',
  '.BWbb...........',
  '..b.............',
];
def('mutton', (t) => itemSprite(t, MUTTON, keys({
  F: 0xf2c9c2, R: 0xc8343a, L: 0xe2626a, d: 0x8e1e26, B: 0xeee6d2, W: 0xffffff, b: 0xbdb39a,
}), [['FRLd', 0x5a1014], ['BWb', 0x5e584a]]));
def('cooked_mutton', (t) => itemSprite(t, MUTTON, keys({
  F: 0xd7a868, R: 0x8f522c, L: 0xb0703e, d: 0x5e3216, B: 0xe2d6bc, W: 0xf6efe0, b: 0xab9d80,
}), [['FRLd', 0x341a08], ['BWb', 0x4e4636]]));

// Roast bird seen from the side: plump body, two drumsticks pointing up-right with bone knobs.
const CHICKEN = [
  '................',
  '................',
  '...........WB...',
  '...........BB.W.',
  '..........dPdBB.',
  '.........dPPdPd.',
  '.....PPPPPLPPPd.',
  '...PPLLLPPPPPPd.',
  '..PLLPPPPPPPPPd.',
  '..PLPPPwwPPPPPd.',
  '..PPPPPPwwPPPdd.',
  '..dPPPPPPPPPPd..',
  '...ddPPPPPPddd..',
  '.....dddddd.....',
  '................',
  '................',
];
def('chicken', (t) => itemSprite(t, CHICKEN, keys({
  P: 0xf0c4b4, L: 0xfde4da, w: 0xd99c8e, d: 0xc98a7c, B: 0xf2ece0, W: 0xffffff,
}), [['PLwd', 0x7a4a40], ['BW', 0x6a6458]]));
def('cooked_chicken', (t) => itemSprite(t, CHICKEN, keys({
  P: 0xc9853e, L: 0xe7b062, w: 0x9a5c26, d: 0x8a4e1e, B: 0xeadcc0, W: 0xfff6e6,
}), [['PLwd', 0x3e2008], ['BW', 0x5a5040]]));

def('spider_eye', (t) => {
  // A glossy red-purple eye: dark pupil, bright highlight, bloodshot rim.
  itemSprite(t, [
    '................',
    '................',
    '................',
    '......rrrr......',
    '....rrRRRRrr....',
    '...rRRWHRRRRr...',
    '...rRHHRRRRRr...',
    '..rRRRRkkkRRRr..',
    '..rRRRkkKkkRRr..',
    '..rRRRkKKkkRdr..',
    '...rRRRkkkRdr...',
    '...rRvRRRRddr...',
    '....rrdddddr....',
    '......rrrr......',
    '................',
    '................',
  ], keys({ r: 0x7a1428, R: 0xb72a42, W: 0xffe0e6, H: 0xe8798a, k: 0x3a0a18, K: 0x16030a, d: 0x8a1a30, v: 0x96203a }),
  [['rRWHkKdv', 0x2e0610]]);
});

// Arrow item, hand-drawn along the anti-diagonal: flint head at the top-right (point at (13,2)),
// shaft x + y = 15, fletching + nock at the bottom-left.
const ARROW_MAP = [
  '................',
  '................',
  '...........hhH..',
  '............qh..',
  '...........aAq..',
  '..........aA....',
  '.........aA.....',
  '........aA......',
  '.......aA.......',
  '....F.aA........',
  '...FFaf.........',
  '..FFaff.........',
  '.FFaff..........',
  '..nff...........',
  '.n..............',
  '................',
];
const ARROW_KEYS = { a: 0x9a7744, A: 0x6e5230, n: 0x5a4024, F: 0xf2f2f2, f: 0xbdbdc4, h: 0xb0b0b0, H: 0xe6e6e6, q: 0x6a6a6a };
const ARROW_OUTLINES = [['hHq', 0x262626], ['Ff', 0x55555d]];
def('arrow', (t) => itemSprite(t, ARROW_MAP, keys(ARROW_KEYS), ARROW_OUTLINES));

/**
 * Bow (Minecraft orientation: the arc bulges toward the top-left, the string runs along the
 * anti-diagonal from the upper tip (top right) to the lower tip (bottom left); pulled, the string
 * forms a V toward the bottom-right and the nocked arrow points to the top-left). The first-person
 * BOW use-pose of ItemInHandRenderer turns exactly that texture direction into "forward".
 * pull 0 = resting bow, 1..3 = bow_pulling_0..2 (the arrow moves back with the string).
 */
function bowSprite(t, pull) {
  const g = keyGrid();
  const back = [0, 0.5, 1, 1.5][pull];             // the limb tips bend back when the bow is drawn
  const p0 = [13.5, 1.5 + back];                   // upper tip
  const p2 = [1.5 + back, 13.5];                   // lower tip
  const c = [2.6 + back * 0.4, 2.6 + back * 0.4];  // control point: the grip sits near (5, 5)
  const bez = (u) => [
    (1 - u) * (1 - u) * p0[0] + 2 * u * (1 - u) * c[0] + u * u * p2[0],
    (1 - u) * (1 - u) * p0[1] + 2 * u * (1 - u) * c[1] + u * u * p2[1],
  ];
  // String (the limbs are drawn over its ends).
  const pullPx = [0, 1.5, 2.5, 3.5][pull];
  const apex = [7.5 + pullPx, 7.5 + pullPx];
  for (const [a, b] of pull === 0 ? [[p0, p2]] : [[p0, apex], [apex, p2]]) {
    const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) * 2);
    for (let i = 0; i <= n; i++) {
      const u = i / n;
      put(g, Math.floor(a[0] + (b[0] - a[0]) * u), Math.floor(a[1] + (b[1] - a[1]) * u), 'w');
    }
  }
  // Arrow nocked at the string apex, pointing to the top-left: the item arrow mirrored (shaft x = y),
  // 7 texels long so the head ends up at the grip at full draw.
  if (pull > 0) {
    const nx = Math.floor(apex[0]);
    const tip = nx - 8;
    for (let k = 1; k <= 7; k++) {
      put(g, nx - k, nx - k, 'a');
      if (k < 6) put(g, nx - k - 1, nx - k, 'A');
    }
    for (const [dx, dy, k] of [[0, 0, 'H'], [1, 0, 'h'], [2, 0, 'h'], [0, 1, 'h'], [1, 1, 'q'], [0, 2, 'q']]) {
      put(g, tip + dx, tip + dy, k);
    }
    for (const [dx, dy, k] of [
      [0, -2, 'F'], [1, -1, 'F'], [-1, -3, 'F'], [0, -1, 'F'],
      [-3, -1, 'f'], [-2, 0, 'f'], [-2, -1, 'f'], [-1, 0, 'f'], [1, 1, 'n'], [0, 0, 'n'],
    ]) put(g, nx + dx, nx + dy, k);
  }
  // Limbs: lit back (outer) and shaded belly (inner) of the stave, 2 texels thick in the middle and
  // tapering to 1 texel at the tips; a dark leather grip in the middle.
  const N = 96;
  for (let i = 0; i <= N; i++) {
    const u = i / N;
    const [x, y] = bez(u);
    put(g, Math.floor(x), Math.floor(y), u > 0.42 && u < 0.58 ? 'G' : 'L');
  }
  for (let i = 0; i <= N; i++) {
    const u = i / N;
    if (u < 0.16 || u > 0.84) continue;
    const [x, y] = bez(u);
    const ix = Math.floor(x + 0.8);
    const iy = Math.floor(y + 0.8);
    const cur = g[iy]?.[ix];
    if (cur !== undefined && cur !== 'L' && cur !== 'G') put(g, ix, iy, u > 0.42 && u < 0.58 ? 'g' : 'M');
  }
  // Nocks: the tips are capped with a darker texel.
  put(g, Math.floor(p0[0]), Math.floor(p0[1]), 'M');
  put(g, Math.floor(p2[0]), Math.floor(p2[1]), 'M');
  itemSprite(t, gridRows(g), keys({ L: 0xa5783a, M: 0x6e4c1e, G: 0x4e3420, g: 0x35220f, w: 0xe2e2e2, ...ARROW_KEYS }),
    [['LMGg', 0x2a1a08], ...ARROW_OUTLINES]);
}
def('bow', (t) => bowSprite(t, 0));
for (let i = 0; i < 3; i++) def(`bow_pulling_${i}`, (t) => bowSprite(t, i + 1));

/**
 * Spawn eggs: one shared egg (lit top-left, 5 shades of the mob's primary colour) with one shared
 * set of spots in the secondary colour (Minecraft's base + overlay layers), dark outline.
 */
const EGG_WIDTHS = [0, 4, 6, 6, 8, 8, 10, 10, 10, 10, 10, 10, 10, 8, 6, 0]; // per row, centred
const EGG_SPOTS = [
  [8, 3], [9, 3], [5, 5], [6, 5], [5, 6], [9, 7], [10, 7], [9, 8], [10, 8],
  [4, 9], [7, 10], [8, 10], [7, 11], [8, 11], [11, 11], [5, 12], [10, 13],
];
const SPAWN_EGG_COLORS = {
  pig: [0xf0a5a2, 0xdb635f], cow: [0x443626, 0xa1a1a1], sheep: [0xe7e7e7, 0xffb5b5],
  chicken: [0xe2e2e2, 0xe0120e], zombie: [0x00afaf, 0x799c65], skeleton: [0xc1c1c1, 0x494949],
  creeper: [0x0da70b, 0x161616], spider: [0x342d27, 0xa80e0e],
};
function spawnEgg(t, primary, secondary) {
  const g = keyGrid();
  const spot = new Set(EGG_SPOTS.map(([x, y]) => y * S + x));
  const L = [-0.55, -0.62, 0.56];
  const ln = Math.hypot(L[0], L[1], L[2]);
  for (let y = 0; y < S; y++) {
    const w = EGG_WIDTHS[y];
    if (!w) continue;
    for (let x = 8 - w / 2; x < 8 + w / 2; x++) {
      // Normal of an egg-shaped dome: u across the row, v along the egg (centre slightly low).
      const u = (x + 0.5 - 8) / 5.2;
      const v = (y + 0.5 - 8.6) / 7.2;
      const nz = Math.sqrt(Math.max(0, 1 - u * u - v * v));
      const b = (u * L[0] + v * L[1] + nz * L[2]) / ln;
      const level = b > 0.9 ? 5 : b > 0.68 ? 4 : b > 0.3 ? 3 : b > -0.05 ? 2 : 1;
      g[y][x] = spot.has(y * S + x) ? 'abcde'[level - 1] : String(level);
    }
  }
  const p = rgb(primary);
  const s = rgb(secondary);
  const P = {
    1: scale(p, 0.6), 2: scale(p, 0.8), 3: p, 4: mix(p, WHITE, 0.22), 5: mix(p, WHITE, 0.55),
    a: scale(s, 0.66), b: scale(s, 0.84), c: s, d: mix(s, WHITE, 0.12), e: mix(s, WHITE, 0.3),
  };
  const pk = {};
  for (const k of Object.keys(P)) pk[k] = [...P[k], 255];
  const outline = scale(p, 0.32);
  t.clear();
  sprite(t, gridRows(g), pk);
  // Outline (no group logic needed: every empty texel touching the egg).
  const rows = gridRows(g);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      if (rows[y][x] !== '.') continue;
      const near = (xx, yy) => xx >= 0 && yy >= 0 && xx < S && yy < S && rows[yy][xx] !== '.';
      if (near(x - 1, y) || near(x + 1, y) || near(x, y - 1) || near(x, y + 1)) t.set(x, y, outline);
    }
  }
}
for (const [mob] of SPAWN_EGG_MOBS) {
  // Mobs added later without a colour entry still get a distinct (hash-derived) egg.
  const h = hashString(mob);
  const [primary, secondary] = SPAWN_EGG_COLORS[mob] ?? [h & 0xffffff, (h >>> 8) ^ 0x7f7f7f];
  def(`${mob}_spawn_egg`, (t) => spawnEgg(t, primary, secondary));
}

// =================================================================================================
// Alpha rules (SPEC §5.3) applied after painting
// =================================================================================================

/**
 * Fill RGB of transparent texels from their opaque neighbours (repeated dilation, no wrap), so no
 * filtering or mip level can ever pull dark "black fringe" colour from empty texels.
 */
function bleedTransparent(d) {
  let known = new Uint8Array(AREA);
  let any = false;
  for (let i = 0; i < AREA; i++) {
    if (d[i * 4 + 3] > 0) {
      known[i] = 1;
      any = true;
    }
  }
  if (!any) return;
  for (let pass = 0; pass < S; pass++) {
    const next = known.slice();
    let changed = false;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = y * S + x;
        if (known[i]) continue;
        let r = 0;
        let g = 0;
        let b = 0;
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= S || yy >= S) continue;
            const j = yy * S + xx;
            if (!known[j]) continue;
            r += d[j * 4];
            g += d[j * 4 + 1];
            b += d[j * 4 + 2];
            n++;
          }
        }
        if (n) {
          d[i * 4] = Math.round(r / n);
          d[i * 4 + 1] = Math.round(g / n);
          d[i * 4 + 2] = Math.round(b / n);
          next[i] = 1;
          changed = true;
        }
      }
    }
    known = next;
    if (!changed) break;
  }
}

/** Enforce the alpha contract of a layer: opaque 255, cutout binary, tintmask binary + grey. */
function finalizeLayer(d, alphaMode, tinted) {
  if (alphaMode === 'opaque') {
    for (let i = 3; i < LAYER_BYTES; i += 4) d[i] = 255;
    return;
  }
  if (alphaMode === 'tintmask') {
    for (let i = 0; i < LAYER_BYTES; i += 4) {
      if (d[i + 3] >= 128) {
        d[i + 3] = 255;
      } else {
        d[i + 3] = 0;
        const l = luma(d[i], d[i + 1], d[i + 2]);
        d[i] = d[i + 1] = d[i + 2] = l;
      }
    }
    return;
  }
  for (let i = 0; i < LAYER_BYTES; i += 4) {
    if (alphaMode === 'cutout') d[i + 3] = d[i + 3] >= 128 ? 255 : 0;
    if (tinted && d[i + 3] > 0) {
      const l = luma(d[i], d[i + 1], d[i + 2]);
      d[i] = d[i + 1] = d[i + 2] = l;
    }
  }
  if (alphaMode === 'cutout') bleedTransparent(d);
}

// =================================================================================================
// Public API
// =================================================================================================

/** True if a painter exists for this texture name. */
export function hasTexturePainter(name) {
  return PAINTERS.has(name);
}

/** Registry textures that have no painter yet (drawn with the missing-texture checker). Must stay empty. */
export const MISSING_TEXTURES = Object.freeze(TEXTURES.filter((t) => !PAINTERS.has(t.name)).map((t) => t.name));

const MISSING_A = [248, 0, 248];
const MISSING_B = [0, 0, 0];
/** Minecraft's missing-texture checker (magenta / black 8x8 quarters). */
function paintMissing(t) {
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) t.set(x, y, (x < 8) !== (y < 8) ? MISSING_A : MISSING_B);
}
let warnedMissing = false;
function painterFor(name) {
  const fn = PAINTERS.get(name);
  if (fn) return fn;
  if (!TEXTURE_BY_NAME.has(name)) throw new Error(`textures.js: no painter for texture '${name}'`);
  if (!warnedMissing && typeof console !== 'undefined') {
    warnedMissing = true;
    console.warn(`textures.js: ${MISSING_TEXTURES.length} texture(s) without a painter use the missing-texture checker: ${MISSING_TEXTURES.join(', ')}`);
  }
  return paintMissing;
}

/**
 * Paint one texture (one frame) into a fresh Uint8Array(1024) RGBA buffer, with the registry's
 * alpha rules applied when the name is a registered texture. Throws for unknown names.
 */
export function paintTexture(name, frame = 0) {
  const fn = painterFor(name);
  const entry = TEXTURE_BY_NAME.get(name);
  const out = new Uint8Array(LAYER_BYTES);
  fn(new Tex(out), rngFor(name), frame, entry ? entry.frames : 1);
  if (entry) finalizeLayer(out, entry.alphaMode, entry.tinted);
  return out;
}

/**
 * Generate every texture layer of the shared TEXTURE_2D_ARRAY in registry order (SPEC §5.2).
 * Pure and deterministic. Throws if any registry texture has no painter.
 * @returns {{ size: number, layers: number, data: Uint8Array }} RGBA8, layer-major, row 0 = top.
 */
export function generateTextures() {
  const data = new Uint8Array(TEXTURE_LAYER_COUNT * LAYER_BYTES);
  for (const entry of TEXTURES) {
    const fn = painterFor(entry.name);
    for (let f = 0; f < entry.frames; f++) {
      const layer = entry.layer + f;
      const view = data.subarray(layer * LAYER_BYTES, (layer + 1) * LAYER_BYTES);
      fn(new Tex(view), rngFor(entry.name), f, entry.frames);
      finalizeLayer(view, entry.alphaMode, entry.tinted);
    }
  }
  return { size: S, layers: TEXTURE_LAYER_COUNT, data };
}

/** Alpha mode of every layer ('opaque' | 'tintmask' | 'cutout' | 'translucent'), frames expanded. */
export function getLayerAlphaModes() {
  const out = new Array(TEXTURE_LAYER_COUNT);
  for (const entry of TEXTURES) {
    for (let f = 0; f < entry.frames; f++) out[entry.layer + f] = entry.alphaMode;
  }
  return out;
}

/**
 * Mip chain for the texture array (SPEC §9.4): levels 0..log2(size) (16, 8, 4, 2, 1 px).
 * Level 0 is `data` itself. Each level is a box filter of level 0:
 *  - opaque:      plain RGB average, alpha 255
 *  - tintmask:    plain RGB average, alpha (tint mask) averaged
 *  - cutout:      alpha-weighted RGB (no dark fringes); alpha re-thresholded to 0/255 so the
 *                 covered fraction matches level 0 (foliage does not thin out with distance)
 *  - translucent: alpha-weighted RGB, alpha averaged
 * @returns {Uint8Array[]}
 */
export function buildMipChain(data, size, layers, alphaModes) {
  const levels = [data];
  const n0 = size * size;
  const coverage = new Float32Array(layers);
  for (let L = 0; L < layers; L++) {
    if (alphaModes[L] !== 'cutout') continue;
    let c = 0;
    for (let i = 0; i < n0; i++) if (data[(L * n0 + i) * 4 + 3] >= 128) c++;
    coverage[L] = c / n0;
  }
  for (let s = size >> 1; s >= 1; s >>= 1) {
    const f = size / s;
    const cnt = f * f;
    const n = s * s;
    const out = new Uint8Array(n * 4 * layers);
    const avgA = new Float32Array(n);
    const order = new Array(n);
    for (let L = 0; L < layers; L++) {
      const mode = alphaModes[L];
      const weighted = mode === 'cutout' || mode === 'translucent';
      const base = L * n0 * 4;
      const ob = L * n * 4;
      for (let y = 0; y < s; y++) {
        for (let x = 0; x < s; x++) {
          let r = 0;
          let g = 0;
          let b = 0;
          let a = 0;
          let wr = 0;
          let wg = 0;
          let wb = 0;
          for (let yy = 0; yy < f; yy++) {
            let i = base + ((y * f + yy) * size + x * f) * 4;
            for (let xx = 0; xx < f; xx++, i += 4) {
              const al = data[i + 3];
              r += data[i];
              g += data[i + 1];
              b += data[i + 2];
              a += al;
              wr += data[i] * al;
              wg += data[i + 1] * al;
              wb += data[i + 2] * al;
            }
          }
          const o = ob + (y * s + x) * 4;
          if (weighted && a > 0) {
            out[o] = Math.round(wr / a);
            out[o + 1] = Math.round(wg / a);
            out[o + 2] = Math.round(wb / a);
          } else {
            out[o] = Math.round(r / cnt);
            out[o + 1] = Math.round(g / cnt);
            out[o + 2] = Math.round(b / cnt);
          }
          out[o + 3] = mode === 'opaque' ? 255 : Math.round(a / cnt);
          avgA[y * s + x] = a / cnt;
        }
      }
      if (mode === 'cutout') {
        // Keep the k texels with the highest averaged alpha, k = level-0 coverage × texel count.
        let nonzero = 0;
        for (let i = 0; i < n; i++) {
          order[i] = i;
          if (avgA[i] > 0) nonzero++;
        }
        order.sort((p, q) => avgA[q] - avgA[p] || p - q);
        const k = Math.min(nonzero, Math.round(coverage[L] * n));
        for (let r = 0; r < n; r++) out[ob + order[r] * 4 + 3] = r < k ? 255 : 0;
      }
    }
    levels.push(out);
  }
  return levels;
}

// =================================================================================================
// Sky textures
// =================================================================================================

function makeSun() {
  const w = 32;
  const data = new Uint8Array(w * w * 4);
  for (let y = 0; y < w; y++) {
    for (let x = 0; x < w; x++) {
      const dx = Math.abs(x - 15.5);
      const dy = Math.abs(y - 15.5);
      const m = Math.max(dx, dy);
      const i = (y * w + x) * 4;
      let c;
      let a;
      if (m < 8) {
        // Core square: white-hot centre fading to warm yellow at the rim.
        c = m < 4 ? [255, 255, 236] : m < 6 ? [255, 250, 200] : m < 7 ? [255, 238, 150] : [255, 222, 110];
        a = 255;
      } else {
        // Soft square halo in a few crisp steps (pixel-art glow).
        const rr = m * 0.75 + Math.hypot(dx, dy) * 0.25;
        const k = Math.max(0, 1 - (rr - 7.5) / 8);
        a = Math.round(Math.floor(k * k * 6) / 6 * 150);
        c = a ? [255, 226, 130] : [0, 0, 0];
      }
      data[i] = c[0];
      data[i + 1] = c[1];
      data[i + 2] = c[2];
      data[i + 3] = a;
    }
  }
  return { width: w, height: w, data };
}

function makeMoon() {
  const w = 32;
  const data = new Uint8Array(w * w * 4);
  const rng = rngFor('moon');
  const BASE = [222, 226, 236];
  const EDGE = [196, 202, 216];
  const CRATER = [176, 182, 198];
  const CRATER_DARK = [154, 160, 178];
  const craters = [[11, 11, 2.2], [19, 13, 1.6], [14, 19, 2.6], [20, 20, 1.3], [10, 17, 1.1], [17, 9, 1.0]];
  for (let y = 0; y < w; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const m = Math.max(Math.abs(x - 15.5), Math.abs(y - 15.5));
      let c;
      let a = 255;
      if (m < 8) {
        c = m >= 7 ? EDGE : BASE;
        for (const [cx, cy, r] of craters) {
          const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
          if (d < r) c = d < r - 0.9 ? CRATER_DARK : CRATER;
        }
        if (rng() < 0.06) c = mix(c, CRATER, 0.6);
      } else {
        // No halo: on a black night sky any faint rim reads as a grey box around the moon.
        a = 0;
        c = [0, 0, 0];
      }
      data[i] = c[0];
      data[i + 1] = c[1];
      data[i + 2] = c[2];
      data[i + 3] = a;
    }
  }
  return { width: w, height: w, data };
}

function makeClouds() {
  const W = 256;
  const rng = rngFor('clouds');
  const f = new Float32Array(W * W);
  for (const [cells, w] of [[8, 0.5], [16, 1], [32, 0.45], [64, 0.16]]) {
    const n = noise2(rng, cells, cells, W);
    for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) f[y * W + x] += n(x, y) * w;
  }
  // Threshold at the 60th percentile -> ~40% coverage.
  const sorted = Float32Array.from(f).sort();
  const thr = sorted[Math.floor(W * W * 0.6)];
  let data = new Uint8Array(W * W);
  for (let i = 0; i < W * W; i++) data[i] = f[i] > thr ? 255 : 0;
  // 3x3 majority filter (wrapping), twice: smooth blocky outlines, no specks or pinholes.
  for (let pass = 0; pass < 2; pass++) {
    const next = new Uint8Array(W * W);
    for (let y = 0; y < W; y++) {
      for (let x = 0; x < W; x++) {
        let c = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) if (data[((y + dy) & 255) * W + ((x + dx) & 255)]) c++;
        }
        next[y * W + x] = c >= 5 ? 255 : 0;
      }
    }
    data = next;
  }
  return { width: W, height: W, data };
}

/**
 * Sky textures (SPEC §9.4): sun & moon 32×32 RGBA (straight alpha; fully transparent texels are
 * black so additive SRC_ALPHA/ONE or ONE/ONE blending also works) and a 256×256 tileable cloud
 * map (one byte per cell, 0 or 255, ~40% coverage; one cell = one cloud block column).
 */
export function generateMiscTextures() {
  return { sun: makeSun(), moon: makeMoon(), clouds: makeClouds() };
}

// =================================================================================================
// Inventory icons
// =================================================================================================

// Orthographic GUI view used by Minecraft for block items: 30° down, rotated 45°, seen from the
// south-east. Screen right = (1,0,-1)/√2; "toward camera" = (cos30/√2, sin30, cos30/√2).
const ISO_V = [Math.cos(Math.PI / 6) * Math.SQRT1_2, 0.5, Math.cos(Math.PI / 6) * Math.SQRT1_2];
const ISO_R = [Math.SQRT1_2, 0, -Math.SQRT1_2];
const ISO_U = [-0.5 * Math.SQRT1_2, Math.cos(Math.PI / 6), -0.5 * Math.SQRT1_2];
const ISO_SCALE = 0.625; // block edge in icon widths (Minecraft's GUI block scale)

/**
 * Visible faces of the box [x0, y0, z0, x1, y1, z1] (block units): top (shade 1.0), south on the
 * left (0.8), east on the right (0.6). Texture coordinates are planar like the world mesher's
 * partial faces (top u = x, v = z; south u = x, v = 1 − y; east u = 1 − z, v = 1 − y) unless a face
 * has `uv: [u0, v0, u1, v1]` (texels), which is stretched over the face like a model element.
 * `over` adds per-face fields: uv, layerFace (face index whose texture is sampled; default the face).
 */
function boxFaces(box, over = {}) {
  return [
    { axis: 1, pos: box[4], face: FACE.PY, shade: 1.0, box, ...over.top },
    { axis: 2, pos: box[5], face: FACE.PZ, shade: 0.8, box, ...over.south },
    { axis: 0, pos: box[3], face: FACE.PX, shade: 0.6, box, ...over.east },
  ];
}
const CUBE_FACES = boxFaces([0, 0, 0, 1, 1, 1]);
// Cactus: side faces 1/16 inside the block (full width and height) like the world mesh.
const CACTUS_FACES = [CUBE_FACES[0], { ...CUBE_FACES[1], pos: 15 / 16 }, { ...CUBE_FACES[2], pos: 15 / 16 }];
// Chest (same mapping as the mesher): every face texture in full on the 14/16 box, plus Minecraft's
// 2x4x1 px lock on the front (south) face sampling the front texture: face u 7..9 v 4..8, top row 4,
// side column 7.
const FULL_UV = [0, 0, 16, 16];
const CHEST_FACES = [
  ...boxFaces([1 / 16, 0, 1 / 16, 15 / 16, 14 / 16, 15 / 16], { top: { uv: FULL_UV }, south: { uv: FULL_UV }, east: { uv: FULL_UV } }),
  ...boxFaces([7 / 16, 7 / 16, 15 / 16, 9 / 16, 11 / 16, 1], {
    top: { layerFace: FACE.PZ, uv: [7, 4, 9, 5] },
    south: { layerFace: FACE.PZ, uv: [7, 4, 9, 8] },
    east: { layerFace: FACE.PZ, uv: [7, 4, 8, 8] },
  }),
];
// Farmland: full block with its top at 15/16 (the dirt sides show texel rows 1..15).
const FARMLAND_FACES = boxFaces([0, 0, 0, 1, 15 / 16, 1]);
const ICON_FACES = { [RENDER.CACTUS]: CACTUS_FACES, [RENDER.CHEST]: CHEST_FACES, [RENDER.FARMLAND]: FARMLAND_FACES };

function tintOf(blockId) {
  switch (TINT_TYPE[blockId]) {
    case TINT.GRASS: return DEFAULT_TINTS.grass;
    case TINT.FOLIAGE: return DEFAULT_TINTS.foliage;
    case TINT.BIRCH: return DEFAULT_TINTS.birch;
    case TINT.SPRUCE: return DEFAULT_TINTS.spruce;
    default: return null;
  }
}

/**
 * Read texel (u, v) of `layer` applying SPEC §5.3: block textures of OPAQUE-layer blocks use the
 * tint-mask rule rgb·mix(tint, 1, a) with alpha forced to 255; everything else rgb·tint, alpha kept.
 * Writes [r, g, b, a] (0..255 floats) into out.
 */
function sampleTexel(textures, layer, u, v, opaqueRule, tint, shade, out) {
  const N = textures.size;
  const i = (layer * N * N + v * N + u) * 4;
  const d = textures.data;
  let r = d[i];
  let g = d[i + 1];
  let b = d[i + 2];
  let a = d[i + 3];
  if (opaqueRule) {
    if (tint) {
      const k = a / 255;
      r *= tint[0] / 255 + (1 - tint[0] / 255) * k;
      g *= tint[1] / 255 + (1 - tint[1] / 255) * k;
      b *= tint[2] / 255 + (1 - tint[2] / 255) * k;
    }
    a = 255;
  } else if (tint) {
    r *= tint[0] / 255;
    g *= tint[1] / 255;
    b *= tint[2] / 255;
  }
  out[0] = r * shade;
  out[1] = g * shade;
  out[2] = b * shade;
  out[3] = a;
}

function drawFlat(textures, out, size, layer, opaqueRule, tint) {
  const N = textures.size;
  const px = [0, 0, 0, 0];
  for (let y = 0; y < size; y++) {
    const v = Math.min(N - 1, Math.floor((y * N) / size));
    for (let x = 0; x < size; x++) {
      const u = Math.min(N - 1, Math.floor((x * N) / size));
      sampleTexel(textures, layer, u, v, opaqueRule, tint, 1, px);
      const o = (y * size + x) * 4;
      out[o] = px[0];
      out[o + 1] = px[1];
      out[o + 2] = px[2];
      out[o + 3] = px[3];
    }
  }
}

function drawIsometric(textures, out, size, blockId, faces) {
  const N = textures.size;
  const opaqueRule = RENDER_LAYER[blockId] === LAYER.OPAQUE;
  const tint = tintOf(blockId);
  const k = size * ISO_SCALE;
  const half = size / 2;
  const hits = [];
  const px = [0, 0, 0, 0];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sa = (x + 0.5 - half) / k;
      const sb = (half - (y + 0.5)) / k;
      const q = [
        0.5 + sa * ISO_R[0] + sb * ISO_U[0],
        0.5 + sa * ISO_R[1] + sb * ISO_U[1],
        0.5 + sa * ISO_R[2] + sb * ISO_U[2],
      ];
      hits.length = 0;
      for (const fc of faces) {
        const tt = (fc.pos - q[fc.axis]) / ISO_V[fc.axis];
        const p0 = q[0] + tt * ISO_V[0];
        const p1 = q[1] + tt * ISO_V[1];
        const p2 = q[2] + tt * ISO_V[2];
        const [x0, y0, z0, x1, y1, z1] = fc.box;
        // (u, v): planar texture coordinates in [0, 1); (a, b): position across the face in [0, 1).
        let u;
        let v;
        let a;
        let b;
        if (fc.axis === 1) {
          if (p0 < x0 || p0 >= x1 || p2 < z0 || p2 >= z1) continue;
          u = p0;
          v = p2;
          a = (p0 - x0) / (x1 - x0);
          b = (p2 - z0) / (z1 - z0);
        } else if (fc.axis === 2) {
          if (p0 < x0 || p0 >= x1 || p1 < y0 || p1 >= y1) continue;
          u = p0;
          v = 1 - p1;
          a = (p0 - x0) / (x1 - x0);
          b = (y1 - p1) / (y1 - y0);
        } else {
          if (p1 < y0 || p1 >= y1 || p2 < z0 || p2 >= z1) continue;
          u = 1 - p2;
          v = 1 - p1;
          a = (z1 - p2) / (z1 - z0);
          b = (y1 - p1) / (y1 - y0);
        }
        if (fc.uv) {
          u = (fc.uv[0] + (fc.uv[2] - fc.uv[0]) * a) / 16;
          v = (fc.uv[1] + (fc.uv[3] - fc.uv[1]) * b) / 16;
        }
        hits.push({
          t: tt, fc,
          u: clampInt(Math.floor(u * N), 0, N - 1),
          v: clampInt(Math.floor(v * N), 0, N - 1),
        });
      }
      if (hits.length === 0) continue;
      hits.sort((h1, h2) => h2.t - h1.t); // nearest to the camera first
      // Front-to-back compositing (cutout texels are 0/255, translucent ones blend).
      let r = 0;
      let g = 0;
      let b = 0;
      let acc = 0;
      for (const h of hits) {
        const layer = FACE_LAYERS[blockId * 6 + (h.fc.layerFace ?? h.fc.face)];
        sampleTexel(textures, layer, h.u, h.v, opaqueRule, tint, h.fc.shade, px);
        const al = (px[3] / 255) * (1 - acc);
        r += px[0] * al;
        g += px[1] * al;
        b += px[2] * al;
        acc += al;
        if (acc > 0.996) break;
      }
      if (acc <= 0) continue;
      const o = (y * size + x) * 4;
      out[o] = r / acc;
      out[o + 1] = g / acc;
      out[o + 2] = b / acc;
      out[o + 3] = acc * 255;
    }
  }
}

/**
 * Render the RGBA pixels of an inventory icon (pure; usable without a DOM).
 * Cube-like blocks are drawn isometrically (chests as the 14/16 box with their lock, farmland 15/16
 * tall, cactus with inset sides), cross / torch / crop blocks and items as flat sprites.
 * Hidden variant block ids render as their base item (crops -> seeds, lit furnace -> furnace,
 * farmland -> dirt); air and unknown ids give a transparent icon.
 * @param {{size:number, data:Uint8Array}} textures result of generateTextures()
 * @param {number} itemId item id (block items use the block id)
 * @param {number} [size=48] icon edge in pixels
 * @returns {Uint8ClampedArray} size*size*4 RGBA (transparent background)
 */
export function renderIconPixels(textures, itemId, size = 48) {
  const out = new Uint8ClampedArray(size * size * 4);
  // Hidden variant blocks (sideways logs, rotated furnaces, snowy grass) show their item's icon.
  if (itemId > 0 && itemId < 256 && BLOCKS[itemId] && !ITEMS[itemId]) itemId = itemForBlock(itemId) || itemId;
  if (itemId > 0 && itemId < 256 && BLOCKS[itemId]) {
    const rt = RENDER_TYPE[itemId];
    if (rt === RENDER.NONE) return out;
    if (rt === RENDER.CROSS || rt === RENDER.TORCH || rt === RENDER.CROP) {
      const opaqueRule = RENDER_LAYER[itemId] === LAYER.OPAQUE;
      drawFlat(textures, out, size, FACE_LAYERS[itemId * 6], opaqueRule, tintOf(itemId));
    } else {
      drawIsometric(textures, out, size, itemId, ICON_FACES[rt] ?? CUBE_FACES);
    }
    return out;
  }
  const it = ITEMS[itemId];
  if (it && !it.isBlock && it.layer >= 0) drawFlat(textures, out, size, it.layer, false, null);
  return out;
}

/**
 * Browser-only icon cache: 48×48 crisp pixel-art PNG data URLs for inventory slots (SPEC §9.4).
 */
export class IconFactory {
  /** @param {{size:number, layers:number, data:Uint8Array}} textures result of generateTextures() */
  constructor(textures) {
    this.textures = textures;
    this.size = 48;
    this.cache = new Map();
    this.canvas = null;
    this.ctx = null;
  }

  /** @param {number} itemId @returns {string} data URL (cached per id) */
  getIcon(itemId) {
    const cached = this.cache.get(itemId);
    if (cached !== undefined) return cached;
    if (!this.canvas) {
      this.canvas = document.createElement('canvas');
      this.canvas.width = this.size;
      this.canvas.height = this.size;
      this.ctx = this.canvas.getContext('2d');
    }
    const px = renderIconPixels(this.textures, itemId, this.size);
    this.ctx.clearRect(0, 0, this.size, this.size);
    this.ctx.putImageData(new ImageData(px, this.size, this.size), 0, 0);
    const url = this.canvas.toDataURL('image/png');
    this.cache.set(itemId, url);
    return url;
  }
}
