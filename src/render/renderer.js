// WebGL2 world renderer (SPEC §9.3): section meshes in the §7 packed vertex format, Minecraft-style sky,
// fog, clouds, selection outline, crack overlay and the hooks into the injected EntityRenderer.
//
// Frame order:
//   sky gradient + sunrise glow -> sun & moon -> stars        (sun/moon cores write a far depth that hides stars)
//   opaque (front-to-back) -> cutout (front-to-back)          (back-face culling, depth write)
//   crack overlay (multiply blend on the breaking block's own geometry: opaque + cutout layers)
//   selection outline (screen-space quads, stencil = no double blending)
//   EntityRenderer.renderEntities + renderParticles
//   translucent (sections back-to-front; inside a section the quads are sorted back to front by centre and
//     drawn double-sided in one pass, back-facing quads nudged behind coplanar front faces),
//     then the crack overlay for translucent blocks (ice)
//   clouds (depth pre-pass, then one blended layer)
//   EntityRenderer.renderHand (clears depth itself)
//   underwater / lava screen tint
//
// Everything is camera-relative: section draws pass `sectionOrigin - floor(camera)` (exact integers) as the
// only per-draw uniform; the camera's fractional part lives in the per-frame uniform block.

import {
  mat4Create, mat4Perspective, mat4ViewRotation, mat4Multiply, mat4Invert, clamp,
} from '../util/math.js';
import { computeDaylight } from '../config.js';
import { TEXTURES, TEXTURE_INDEX } from '../world/registry.js';
import { createAllPrograms, FRAME_UBO_BINDING, FRAME_UBO_FLOATS, FRAME_UBO_LAYOUT } from './shaders.js';

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const NEAR = 0.05;
const FAR = 2048;
const MAX_VISIBLE = 65535;          // sort keys keep the list index in 16 bits
const SWAY_MARGIN = 0.1;            // blocks: vertex animation may move geometry slightly out of its bounds
const PIXEL_BUDGET = 3840 * 2160;   // backing-store cap (very high DPR screens are scaled down)

const CLOUD_Y = 192;                // bottom of the cloud layer
const CLOUD_THICKNESS = 4;
const CLOUD_CELL = 12;              // blocks per cloud bitmap cell
const CLOUD_SPEED = 0.6;            // blocks per second toward +X
const CLOUD_ALPHA = 0.8;
const CLOUD_SHADE = Object.freeze({ top: 1.0, bottom: 0.7, x: 0.9, z: 0.8 });

const SUN_SIZE = 30;                // quad half-extent at distance 100 (Minecraft values)
const MOON_SIZE = 20;
const STAR_COUNT = 1500;

const OUTLINE_GROW = 0.002;         // selection box expansion (blocks)

/** Horizontal distance (blocks) out to which clouds are drawn; they fade out over the second half. */
export function cloudRange(renderDistance) {
  return clamp(renderDistance * 16 * 2.5, 256, 640);
}

/** Underwater / lava look. Colours are scaled by the sky brightness for water. */
const WATER_FOG = Object.freeze([0.06, 0.2, 0.48]);
const WATER_FOG_RANGE = Object.freeze([1.0, 18.0]);
const WATER_TINT = Object.freeze([0.72, 0.86, 1.0]);
const LAVA_FOG = Object.freeze([0.6, 0.12, 0.0]);
const LAVA_FOG_RANGE = Object.freeze([0.0, 2.5]);
const LAVA_TINT = Object.freeze([1.0, 0.62, 0.36]);
// typed copies for allocation-free uniform uploads
const WATER_TINT4 = new Float32Array([...WATER_TINT, 1]);
const LAVA_TINT4 = new Float32Array([...LAVA_TINT, 1]);
const OUTLINE_COLOR = new Float32Array([0, 0, 0, 0.4]);

const LAYER_COUNT = 3;   // opaque, cutout, translucent
const TRANSLUCENT = 2;

// Translucent sorting (review RENDER-1): every translucent layer keeps its own element buffer whose quad
// order is re-sorted back to front (by quad centre) when the camera has moved far enough relative to the
// section's distance: SORT_MIN_MOVE blocks nearby, distance / 16 farther away. Nearest sections first, at
// most SORT_QUAD_BUDGET quads per frame.
const SORT_MIN_MOVE = 0.25;
const SORT_DIST_FACTOR = 1 / 16;
const SORT_QUAD_BUDGET = 24576;
const SORT_IDX_SCALE = 65536;       // key = (quantised distance² · 2 + back-facing) · SCALE + quad index
const SORT_MAX_D2 = 1e5;

// ===================================================================================================
// Pure helpers (exported for unit tests and for reuse)
// ===================================================================================================

/** Unique numeric key for a section (cx, cz in ±2^19, sy 0..15). */
export function sectionKey(cx, sy, cz) {
  return ((cx + 524288) * 1048576 + (cz + 524288)) * 16 + sy;
}

/**
 * Scan packed §7 vertices and grow the local bounds `b` = [minX, minY, minZ, maxX, maxY, maxZ]
 * (block units relative to the section origin). Returns b.
 */
export function accumulateMeshBounds(u32, b) {
  let x0 = b[0], y0 = b[1], z0 = b[2], x1 = b[3], y1 = b[4], z1 = b[5];
  for (let i = 0, n = u32.length - 2; i < n; i += 3) {
    const w = u32[i];
    const x = w & 511, y = (w >>> 9) & 511, z = (w >>> 18) & 511;
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
    if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  b[0] = x0; b[1] = y0; b[2] = z0; b[3] = x1; b[4] = y1; b[5] = z1;
  return b;
}

/**
 * Stable LSD radix sort of `keys[0..n)` by their high 16 bits (two 8-bit passes). `tmp` must be at least n
 * long, `counts` a Uint32Array(256). No allocations.
 */
export function radixSortHigh16(keys, n, tmp, counts) {
  for (let pass = 0; pass < 2; pass++) {
    const shift = 16 + pass * 8;
    const src = pass === 0 ? keys : tmp;
    const dst = pass === 0 ? tmp : keys;
    counts.fill(0);
    for (let i = 0; i < n; i++) counts[(src[i] >>> shift) & 255]++;
    let sum = 0;
    for (let i = 0; i < 256; i++) { const c = counts[i]; counts[i] = sum; sum += c; }
    for (let i = 0; i < n; i++) { const k = src[i]; dst[counts[(k >>> shift) & 255]++] = k; }
  }
  return keys;
}

/** Index buffer for `quads` quads drawn as (0,1,2)(0,2,3). */
export function buildQuadIndices(quads) {
  return fillQuadIndices(new Uint32Array(quads * 6), quads);
}

/** Write the identity quad indices (two triangles per quad, emission order) into `idx`. Returns idx. */
export function fillQuadIndices(idx, quads) {
  for (let q = 0, i = 0, v = 0; q < quads; q++, i += 6, v += 4) {
    idx[i] = v; idx[i + 1] = v + 1; idx[i + 2] = v + 2;
    idx[i + 3] = v; idx[i + 4] = v + 2; idx[i + 5] = v + 3;
  }
  return idx;
}

/** Per-layer alpha modes (frames expanded) from the registry texture table. */
export function registryAlphaModes(layerCount) {
  const modes = new Array(layerCount).fill('opaque');
  for (const t of TEXTURES) {
    for (let f = 0; f < t.frames; f++) if (t.layer + f < layerCount) modes[t.layer + f] = t.alphaMode;
  }
  return modes;
}

/**
 * Fallback mip chain (used when textures.js's buildMipChain is not injected). Every level is a box filter of
 * level 0: colour averaged with alpha weighting, tint-mask alpha averaged, cutout alpha re-thresholded so that
 * the covered fraction matches level 0 (foliage does not thin out with distance).
 * Returns [level0 (= data), level1, ...] down to 1x1.
 */
export function buildMipChainFallback(data, size, layers, alphaModes) {
  const levels = [data];
  const texels0 = size * size;
  const alphaTmp = new Float32Array(texels0);
  const hist = new Uint32Array(256);
  for (let s = size >> 1, k = 2; s >= 1; s >>= 1, k <<= 1) {
    const out = new Uint8Array(s * s * 4 * layers);
    for (let l = 0; l < layers; l++) {
      const mode = alphaModes[l] ?? 'opaque';
      const src = l * texels0 * 4;
      const dst = l * s * s * 4;
      let coverage0 = 0;
      if (mode === 'cutout') {
        for (let i = 0; i < texels0; i++) if (data[src + i * 4 + 3] >= 128) coverage0++;
        coverage0 /= texels0;
      }
      for (let y = 0; y < s; y++) {
        for (let x = 0; x < s; x++) {
          let r = 0, g = 0, b = 0, a = 0, wr = 0, wg = 0, wb = 0, wsum = 0;
          for (let yy = 0; yy < k; yy++) {
            for (let xx = 0; xx < k; xx++) {
              const p = src + ((y * k + yy) * size + (x * k + xx)) * 4;
              const al = data[p + 3];
              r += data[p]; g += data[p + 1]; b += data[p + 2]; a += al;
              wr += data[p] * al; wg += data[p + 1] * al; wb += data[p + 2] * al; wsum += al;
            }
          }
          const n = k * k;
          const o = dst + (y * s + x) * 4;
          const weighted = (mode === 'cutout' || mode === 'translucent') && wsum > 0;
          out[o] = Math.round(weighted ? wr / wsum : r / n);
          out[o + 1] = Math.round(weighted ? wg / wsum : g / n);
          out[o + 2] = Math.round(weighted ? wb / wsum : b / n);
          out[o + 3] = mode === 'opaque' ? 255 : Math.round(a / n);
          alphaTmp[y * s + x] = a / n;
        }
      }
      if (mode === 'cutout') {
        // choose the threshold that keeps the covered fraction closest to level 0 (ties: keep more coverage,
        // so thin features such as grass blades never vanish)
        hist.fill(0);
        const count = s * s;
        for (let i = 0; i < count; i++) hist[Math.min(255, Math.round(alphaTmp[i]))]++;
        let best = 128, bestErr = Infinity, above = 0;
        for (let t = 255; t >= 1; t--) {
          above += hist[t];
          const err = Math.abs(above / count - coverage0);
          if (err <= bestErr + 1e-9) { bestErr = Math.min(err, bestErr); best = t; }
        }
        for (let i = 0; i < count; i++) out[dst + i * 4 + 3] = alphaTmp[i] >= best && alphaTmp[i] > 0 ? 255 : 0;
      }
    }
    levels.push(out);
  }
  return levels;
}

/**
 * Give fully transparent texels of cutout/translucent layers the colour of their visible neighbours (in place).
 * Invisible with nearest sampling, but it prevents dark fringes whenever linear filtering blends across
 * coverage edges.
 */
export function dilateTransparentTexels(level, size, layers, alphaModes) {
  const n = size * size;
  const filled = new Uint8Array(n);
  const next = new Uint8Array(n);
  for (let l = 0; l < layers; l++) {
    const mode = alphaModes[l];
    if (mode !== 'cutout' && mode !== 'translucent') continue;
    const base = l * n * 4;
    let remaining = 0, any = false;
    for (let i = 0; i < n; i++) {
      filled[i] = level[base + i * 4 + 3] > 0 ? 1 : 0;
      if (filled[i]) any = true; else remaining++;
    }
    if (!any || remaining === 0) continue;
    for (let iter = 0; iter < size * 2 && remaining > 0; iter++) {
      next.set(filled);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const i = y * size + x;
          if (filled[i]) continue;
          let r = 0, g = 0, b = 0, c = 0;
          for (let dy = -1; dy <= 1; dy++) {
            const yy = y + dy;
            if (yy < 0 || yy >= size) continue;
            for (let dx = -1; dx <= 1; dx++) {
              const xx = x + dx;
              if (xx < 0 || xx >= size || (dx === 0 && dy === 0)) continue;
              const j = yy * size + xx;
              if (!filled[j]) continue;
              const p = base + j * 4;
              r += level[p]; g += level[p + 1]; b += level[p + 2]; c++;
            }
          }
          if (c > 0) {
            const p = base + i * 4;
            level[p] = Math.round(r / c); level[p + 1] = Math.round(g / c); level[p + 2] = Math.round(b / c);
            next[i] = 1;
            remaining--;
          }
        }
      }
      filled.set(next);
    }
  }
  return level;
}

/** Small deterministic PRNG (mulberry32). */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Star field: Float32Array of `count` stars, 6 floats each: direction xyz (unit, celestial frame), size (px at
 * 1080p), twinkle phase, twinkle angular speed (multiple of 2*pi/256 so the wrapped clock never jumps).
 */
export function generateStars(count = STAR_COUNT, seed = 10842) {
  const rnd = prng(seed);
  const out = new Float32Array(count * 6);
  let n = 0;
  while (n < count) {
    const x = rnd() * 2 - 1, y = rnd() * 2 - 1, z = rnd() * 2 - 1;
    const len2 = x * x + y * y + z * z;
    if (len2 < 0.01 || len2 > 1) continue;
    const inv = 1 / Math.sqrt(len2);
    const o = n * 6;
    out[o] = x * inv; out[o + 1] = y * inv; out[o + 2] = z * inv;
    const r = rnd();
    out[o + 3] = 1.6 + r * r * 2.2;
    out[o + 4] = rnd() * TAU;
    out[o + 5] = (40 + Math.floor(rnd() * 160)) * (TAU / 256);
    n++;
  }
  return out;
}

/**
 * Minecraft sky state for a time of day (SPEC §4 time convention). Values follow Minecraft Java's
 * sky/fog/sunrise/star/cloud colour formulas (plains sky colour). `out` is reused.
 * `voidScale` is Minecraft's clear-colour scale: the sky / fog darken while cameraY · voidScale < 1,
 * i.e. below y = 32 with the default 1/32, below y = 1 in flat worlds (scale 1).
 */
export function computeSkyState(timeOfDay, renderDistance = 8, cameraY = 64, out = {}, voidScale = 1 / 32) {
  const ang = timeOfDay * TAU;
  const sunX = Math.cos(ang), sunY = Math.sin(ang);
  const bright = clamp(sunY * 2 + 0.5, 0, 1);
  const zen = out.zenith ?? (out.zenith = [0, 0, 0]);
  const hor = out.horizon ?? (out.horizon = [0, 0, 0]);
  const sun = out.sunrise ?? (out.sunrise = [0, 0, 0, 0]);
  const dir = out.sunDir ?? (out.sunDir = [0, 0, 0]);
  // upper sky: plains sky colour #79A7FF scaled by brightness
  zen[0] = 0.4733 * bright; zen[1] = 0.656 * bright; zen[2] = 1.0 * bright;
  // fog / horizon colour, then blended toward the sky colour depending on the render distance
  const fb = bright * 0.94 + 0.06, fbb = bright * 0.91 + 0.09;
  hor[0] = 0.753 * fb; hor[1] = 0.847 * fb; hor[2] = 1.0 * fbb;
  const rdf = 1 - Math.pow(0.25 + 0.75 * clamp(renderDistance, 2, 32) / 32, 0.25);
  for (let i = 0; i < 3; i++) hor[i] += (zen[i] - hor[i]) * rdf;
  // sunrise / sunset colour
  if (sunY >= -0.4 && sunY <= 0.4) {
    const f3 = (sunY / 0.4) * 0.5 + 0.5;
    let a = 1 - (1 - Math.sin(f3 * Math.PI)) * 0.99;
    a *= a;
    sun[0] = f3 * 0.3 + 0.7; sun[1] = f3 * f3 * 0.7 + 0.2; sun[2] = 0.2; sun[3] = a;
  } else {
    sun[0] = sun[1] = sun[2] = sun[3] = 0;
  }
  // deep underground the sky / fog darkens (Minecraft's void fog below y = 32; flat worlds: below y = 1)
  const voidK = cameraY * (voidScale > 0 ? voidScale : 1 / 32);
  if (voidK < 1) {
    let k = clamp(voidK, 0, 1);
    k *= k;
    for (let i = 0; i < 3; i++) { zen[i] *= k; hor[i] *= k; sun[i] *= k; }
  }
  const sf = clamp(1 - (sunY * 2 + 0.25), 0, 1);
  out.starBrightness = sf * sf * 0.5;
  out.cloudBrightness = bright * 0.9 + 0.1;
  out.skyBrightness = bright;
  out.sunSide = sunX >= 0 ? 1 : -1;
  out.sunAngle = ang;
  dir[0] = sunX; dir[1] = sunY; dir[2] = 0;
  return out;
}

/**
 * Sky-light tint for the canonical lightColor() (which multiplies it by `daylight`): Minecraft's
 * lightmap sky colour, lerp((d, d, 1), (1, 1, 1), 0.35) scaled by (0.95·d + 0.05) / d with d = daylight
 * (Minecraft's sky darkening, 0.2..1): white by day, blue moonlight at night.
 */
export function computeSkyTint(daylight, out = [1, 1, 1]) {
  const d = clamp(daylight, 0.2, 1);
  const k = (0.95 * d + 0.05) / d;
  const rg = d + (1 - d) * 0.35;
  out[0] = rg * k; out[1] = rg * k; out[2] = k;
  return out;
}

/**
 * Build the Minecraft "fancy" cloud mesh around cloud cell (centerX, centerZ): one 12x4x12 box per filled
 * bitmap cell, faces between neighbouring cells removed, runs of cells merged along X. Writes 4 floats per
 * vertex (x, y, z relative to (centerX*12, 0, centerZ*12), shade) into `out`, 4 vertices per quad.
 * Returns the number of quads, or -1 if `out` is too small.
 */
export function buildCloudMesh(bitmap, width, height, centerX, centerZ, radius, out) {
  const r2 = (radius + 0.5) * (radius + 0.5);
  const filled = (dx, dz) => {
    if (dx * dx + dz * dz > r2) return false;
    const i = (((centerX + dx) % width) + width) % width;
    const j = (((centerZ + dz) % height) + height) % height;
    return bitmap[j * width + i] !== 0;
  };
  let q = 0;
  const cap = out.length >> 4;
  const C = CLOUD_CELL, H = CLOUD_THICKNESS;
  const quad = (ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, shade) => {
    if (q >= cap) return false;
    const o = q * 16;
    out[o] = ax; out[o + 1] = ay; out[o + 2] = az; out[o + 3] = shade;
    out[o + 4] = bx; out[o + 5] = by; out[o + 6] = bz; out[o + 7] = shade;
    out[o + 8] = cx; out[o + 9] = cy; out[o + 10] = cz; out[o + 11] = shade;
    out[o + 12] = dx; out[o + 13] = dy; out[o + 14] = dz; out[o + 15] = shade;
    q++;
    return true;
  };
  for (let dz = -radius; dz <= radius; dz++) {
    const z0 = dz * C, z1 = z0 + C;
    // runs along X: top/bottom faces and the north/south sides
    let runStart = null, runN = null, runS = null;
    for (let dx = -radius; dx <= radius + 1; dx++) {
      const f = dx <= radius && filled(dx, dz);
      // top + bottom
      if (f && runStart === null) runStart = dx;
      if (!f && runStart !== null) {
        const x0 = runStart * C, x1 = dx * C;
        if (!quad(x0, H, z1, x1, H, z1, x1, H, z0, x0, H, z0, CLOUD_SHADE.top)) return -1;
        if (!quad(x0, 0, z0, x1, 0, z0, x1, 0, z1, x0, 0, z1, CLOUD_SHADE.bottom)) return -1;
        runStart = null;
      }
      // -Z side (north) where the northern neighbour is empty
      const fn = f && !filled(dx, dz - 1);
      if (fn && runN === null) runN = dx;
      if (!fn && runN !== null) {
        if (!quad(dx * C, 0, z0, runN * C, 0, z0, runN * C, H, z0, dx * C, H, z0, CLOUD_SHADE.z)) return -1;
        runN = null;
      }
      // +Z side (south)
      const fs = f && !filled(dx, dz + 1);
      if (fs && runS === null) runS = dx;
      if (!fs && runS !== null) {
        if (!quad(runS * C, 0, z1, dx * C, 0, z1, dx * C, H, z1, runS * C, H, z1, CLOUD_SHADE.z)) return -1;
        runS = null;
      }
      // east / west sides at the ends of filled cells
      if (f) {
        const x0 = dx * C, x1 = x0 + C;
        if (!filled(dx + 1, dz) && !quad(x1, 0, z1, x1, 0, z0, x1, H, z0, x1, H, z1, CLOUD_SHADE.x)) return -1;
        if (!filled(dx - 1, dz) && !quad(x0, 0, z0, x0, 0, z1, x0, H, z1, x0, H, z0, CLOUD_SHADE.x)) return -1;
      }
    }
  }
  return q;
}

/**
 * Fallback misc textures (sun, moon, cloud bitmap) when textures.js's generateMiscTextures() is not supplied.
 */
export function generateFallbackMisc(seed = 1337) {
  const rnd = prng(seed);
  const img = (w, h) => ({ width: w, height: h, data: new Uint8Array(w * h * 4) });
  const sun = img(32, 32);
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 32; x++) {
      const o = (y * 32 + x) * 4;
      const dx = Math.abs(x - 15.5), dy = Math.abs(y - 15.5);
      const m = Math.max(dx, dy);
      if (m < 8) {
        const edge = m > 6.5;
        sun.data[o] = 255; sun.data[o + 1] = edge ? 236 : 252; sun.data[o + 2] = edge ? 140 : 196; sun.data[o + 3] = 255;
      } else {
        const g = Math.max(0, 1 - (m - 8) / 8);
        sun.data[o] = 255; sun.data[o + 1] = 230; sun.data[o + 2] = 140; sun.data[o + 3] = Math.round(g * g * 110);
      }
    }
  }
  const moon = img(32, 32);
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 32; x++) {
      const o = (y * 32 + x) * 4;
      const dx = Math.abs(x - 15.5), dy = Math.abs(y - 15.5);
      if (Math.max(dx, dy) < 8) {
        const crater = ((x * 7 + y * 13) % 11 === 0) || (x > 17 && x < 20 && y > 11 && y < 15) || (x > 10 && x < 13 && y > 17 && y < 20);
        const v = crater ? 150 : 205 + Math.floor(rnd() * 20);
        moon.data[o] = v; moon.data[o + 1] = v; moon.data[o + 2] = v + 12; moon.data[o + 3] = 255;
      }
    }
  }
  // clouds: thresholded smoothed value noise, 256x256 cells
  const W = 256;
  const grid = new Float32Array(32 * 32);
  for (let i = 0; i < grid.length; i++) grid[i] = rnd();
  const cell = (i, j) => grid[((j & 31) * 32) + (i & 31)];
  const data = new Uint8Array(W * W);
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      let v = 0, amp = 1, tot = 0;
      for (let oct = 0; oct < 3; oct++) {
        const s = 8 >> oct;
        const fx = x / s, fy = y / s;
        const ix = Math.floor(fx), iy = Math.floor(fy);
        const tx = fx - ix, ty = fy - iy;
        const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
        const a = cell(ix + oct * 7, iy), b = cell(ix + 1 + oct * 7, iy);
        const c = cell(ix + oct * 7, iy + 1), d = cell(ix + 1 + oct * 7, iy + 1);
        v += ((a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy) * amp;
        tot += amp;
        amp *= 0.5;
      }
      data[y * W + x] = v / tot > 0.58 ? 255 : 0;
    }
  }
  return { sun, moon, clouds: { width: W, height: W, data } };
}

// ===================================================================================================
// Renderer
// ===================================================================================================

class SectionMesh {
  constructor(cx, sy, cz, key) {
    this.cx = cx;
    this.sy = sy;
    this.cz = cz;
    this.key = key;
    // { vao, vbo, quads, bytes }; translucent layers also { ebo, eboBytes, centers, faces, keys, order,
    // sortX, sortY, sortZ } (own element buffer in back-to-front quad order, see _sortTranslucent)
    this.layers = [null, null, null];
    this.bounds = new Float32Array(6);  // local block units (min xyz, max xyz)
    this.listIndex = -1;
  }
}

const OUTLINE_EDGES = [
  // bottom
  [0, 0, 0, 1, 0, 0], [1, 0, 0, 1, 0, 1], [1, 0, 1, 0, 0, 1], [0, 0, 1, 0, 0, 0],
  // top
  [0, 1, 0, 1, 1, 0], [1, 1, 0, 1, 1, 1], [1, 1, 1, 0, 1, 1], [0, 1, 1, 0, 1, 0],
  // verticals
  [0, 0, 0, 0, 1, 0], [1, 0, 0, 1, 1, 0], [1, 0, 1, 1, 1, 1], [0, 0, 1, 0, 1, 1],
];

/**
 * The world renderer. See SPEC §9.3 for the public contract.
 *
 * Options: { textures, misc, EntityRendererClass, buildMipChain, alphaModes, filtering, anisotropy }
 *   textures      generateTextures() result { size, layers, data } (optionally with precomputed `mips`)
 *   misc          generateMiscTextures() result (sun, moon, clouds); a built-in fallback is used if absent
 *   EntityRendererClass  injected class from entityrenderer.js (entity/particle/hand passes skipped if absent)
 *   buildMipChain textures.js's buildMipChain (recommended); an equivalent internal generator is the fallback
 *   alphaModes    per-layer alpha modes (default: derived from the registry, same as getLayerAlphaModes())
 *   filtering     'smooth' (default: crisp texels with anti-aliased edges, trilinear + anisotropic) or
 *                 'classic' (nearest texels, NEAREST_MIPMAP_LINEAR)
 *   anisotropy    max anisotropy (default 8; 1 disables)
 */
export class Renderer {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.options = options;
    this.filtering = options.filtering === 'classic' ? 'classic' : 'smooth';
    this.maxAnisotropy = options.anisotropy ?? 8;
    /** Called after a lost WebGL context was restored. game.js should remesh the world (world.remeshAll()). */
    this.onContextRestored = null;

    const attrs = {
      antialias: false, alpha: false, depth: true, stencil: true,
      powerPreference: 'high-performance', premultipliedAlpha: false, preserveDrawingBuffer: false,
    };
    const gl = canvas.getContext('webgl2', attrs);
    if (!gl) throw new Error('无法创建 WebGL2 上下文（WebGL2 is not available）');
    this.gl = gl;
    this.entityRenderer = null;
    this.textureArray = null;
    this.contextLost = false;

    // section storage
    this.sections = new Map();     // key -> SectionMesh
    this.sectionList = [];         // dense list for allocation-free iteration
    this.vertexBytes = 0;

    // per-frame scratch (reused, never reallocated in steady state)
    this.proj = mat4Create();
    this.viewRot = mat4Create();
    this.viewProj = mat4Create();
    this.invViewProj = mat4Create();
    this._planes = new Float64Array(24);
    this._frameData = new Float32Array(FRAME_UBO_FLOATS);
    this._sky = computeSkyState(0.25, 8, 64, {});
    this._skyTint = [1, 1, 1, 0.5];      // rgb sky-light tint + brightness option (GLSL_LIGHT)
    this._fogColor = [0, 0, 0];
    this._flatFog = [0, 0, 0];
    this._visible = [];
    this._ordered = [];
    this._keys = new Uint32Array(1024);
    this._keysTmp = new Uint32Array(1024);
    this._counts = new Uint32Array(256);
    this._visibleCount = 0;
    this._hookErrors = new Set();
    this._stats = { drawCalls: 0, triangles: 0, visibleSections: 0 };
    this._statsOut = { sections: 0, visibleSections: 0, drawCalls: 0, triangles: 0, gpuMemoryBytes: 0 };
    this._camI = [0, 0, 0];
    // per-frame scalars shared with the pass helpers (fields instead of arguments: no boxed doubles)
    this._camX = 0.5; this._camY = 0.5; this._camZ = 0.5; this._time = 0.5; this._fov = 70.5; this._cullDist = 0.5;
    // scratch for uniform uploads: WebGL calls taking fractional numbers would box every double argument,
    // the *fv variants with preallocated typed arrays do not allocate
    this._f1 = new Float32Array(1);
    this._f3a = new Float32Array(3);
    this._f3b = new Float32Array(3);
    this._f4 = new Float32Array(4);
    this.width = Math.max(1, canvas.width | 0);
    this.height = Math.max(1, canvas.height | 0);
    this.pixelRatio = 1;

    // entity renderer context (SPEC §9.5), one object reused every frame
    this.ctx = {
      gl, proj: this.proj, viewRot: this.viewRot, viewProj: this.viewProj,
      cameraPos: [0, 0, 0], camRight: [1, 0, 0], camUp: [0, 1, 0], fogColor: [0, 0, 0],
      fogStart: 0, fogEnd: 1, daylight: 1, skyTint: this._skyTint, time: 0, aspect: 1, texture: null,
    };

    // misc textures (CPU side; kept for context restoration)
    this._misc = this._resolveMisc(options.misc);
    this._stars = generateStars();
    this._cloud = { cellX: NaN, cellZ: NaN, radius: -1, quads: 0, data: new Float32Array(16 * 4096) };

    this._initGL();

    this._onLost = (e) => {
      e.preventDefault();
      this.contextLost = true;
      // every GL object is gone: forget them (the world re-uploads after restoration)
      this.sections.clear();
      this.sectionList.length = 0;
      this.vertexBytes = 0;
      this.entityRenderer = null;
    };
    this._onRestored = () => {
      try {
        this._initGL();
      } catch (err) {
        console.error('[renderer] could not rebuild GL resources after a context loss:', err);
        return;
      }
      this.contextLost = false;
      if (typeof this.onContextRestored === 'function') this.onContextRestored();
    };
    if (typeof canvas.addEventListener === 'function') {
      canvas.addEventListener('webglcontextlost', this._onLost, false);
      canvas.addEventListener('webglcontextrestored', this._onRestored, false);
    }
  }

  // -------------------------------------------------------------------------------------------------
  // Initialisation
  // -------------------------------------------------------------------------------------------------

  _resolveMisc(misc) {
    const ok = (t) => !!t && t.width > 0 && t.height > 0 && !!t.data && t.data.length >= t.width * t.height * 4;
    const okClouds = (t) => !!t && t.width > 0 && t.height > 0 && !!t.data && t.data.length >= t.width * t.height;
    let fb = null;
    const fallback = () => fb ?? (fb = generateFallbackMisc());
    if (misc && !(ok(misc.sun) && ok(misc.moon) && okClouds(misc.clouds))) {
      console.warn('[renderer] misc textures incomplete, using built-in fallbacks where needed');
    }
    return {
      sun: ok(misc?.sun) ? misc.sun : fallback().sun,
      moon: ok(misc?.moon) ? misc.moon : fallback().moon,
      clouds: okClouds(misc?.clouds) ? misc.clouds : fallback().clouds,
    };
  }

  _initGL() {
    const gl = this.gl;
    this.extAniso = gl.getExtension('EXT_texture_filter_anisotropic');
    this.programs = createAllPrograms(gl);
    this.ctx.gl = gl;

    this.frameUBO = gl.createBuffer();
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.frameUBO);
    gl.bufferData(gl.UNIFORM_BUFFER, this._frameData.byteLength, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.UNIFORM_BUFFER, null);

    // shared quad index buffer
    this.indexBuffer = gl.createBuffer();
    this.indexQuads = 0;
    this.indexBytes = 0;
    this._ensureIndexCapacity(16384);

    this._createTextureArray();
    this._createMiscGL();

    this.emptyVAO = gl.createVertexArray();
    this.stencilBits = gl.getParameter(gl.STENCIL_BITS) | 0;
    this.maxViewport = gl.getParameter(gl.MAX_VIEWPORT_DIMS) || [4096, 4096];

    if (this.options.EntityRendererClass) {
      try {
        this.entityRenderer = new this.options.EntityRendererClass(gl, this.textureArray);
      } catch (err) {
        console.error('[renderer] EntityRenderer construction failed:', err);
        this.entityRenderer = null;
      }
    }
    this._cloud.cellX = NaN;   // force a cloud mesh rebuild
  }

  _createTextureArray() {
    const gl = this.gl;
    const tex = this.options.textures;
    if (!tex || !tex.data) throw new Error('[renderer] options.textures (generateTextures()) is required');
    const size = tex.size ?? 16;
    const layers = tex.layers ?? Math.floor(tex.data.length / (size * size * 4));
    const modes = this.options.alphaModes ?? registryAlphaModes(layers);
    let mips = Array.isArray(tex.mips) ? tex.mips : null;
    if (!mips && typeof this.options.buildMipChain === 'function') {
      try {
        mips = this.options.buildMipChain(tex.data, size, layers, modes);
      } catch (err) {
        console.warn('[renderer] buildMipChain failed, using the internal mip generator:', err);
        mips = null;
      }
    }
    if (!Array.isArray(mips) || mips.length === 0) mips = buildMipChainFallback(tex.data, size, layers, modes);
    let levels = 0;
    while (levels < mips.length && (size >> levels) >= 1) {
      const s = size >> levels;
      if (!mips[levels] || mips[levels].length < s * s * 4 * layers) break;
      levels++;
    }
    if (levels === 0) throw new Error('[renderer] texture data too small');

    const texture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, levels, gl.RGBA8, size, size, layers);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    let bytes = 0;
    for (let l = 0; l < levels; l++) {
      const s = size >> l;
      const copy = new Uint8Array(mips[l].subarray(0, s * s * 4 * layers));
      dilateTransparentTexels(copy, s, layers, modes);
      gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, l, 0, 0, 0, s, s, layers, gl.RGBA, gl.UNSIGNED_BYTE, copy);
      bytes += copy.byteLength;
    }
    // texture object defaults (used by the entity renderer): SPEC filtering, no anisotropy
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_BASE_LEVEL, 0);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAX_LEVEL, levels - 1);
    this.textureArray = texture;
    this.textureLayers = layers;
    this.textureBytes = bytes;
    this.ctx.texture = texture;

    // terrain sampler object (overrides the texture state only while terrain is drawn)
    const smp = gl.createSampler();
    const smooth = this.filtering === 'smooth';
    gl.samplerParameteri(smp, gl.TEXTURE_MAG_FILTER, smooth ? gl.LINEAR : gl.NEAREST);
    gl.samplerParameteri(smp, gl.TEXTURE_MIN_FILTER, smooth ? gl.LINEAR_MIPMAP_LINEAR : gl.NEAREST_MIPMAP_LINEAR);
    gl.samplerParameteri(smp, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.samplerParameteri(smp, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.samplerParameterf(smp, gl.TEXTURE_MAX_LOD, levels - 1);
    if (this.extAniso && this.maxAnisotropy > 1) {
      const max = gl.getParameter(this.extAniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT) || 1;
      gl.samplerParameterf(smp, this.extAniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(max, this.maxAnisotropy));
    }
    this.terrainSampler = smp;

    this.crackLayers = new Int32Array(10);
    for (let i = 0; i < 10; i++) this.crackLayers[i] = TEXTURE_INDEX.get('destroy_stage_' + i) ?? 0;
  }

  _upload2D(img) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, img.width, img.height, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      img.data instanceof Uint8Array ? img.data : new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  _createMiscGL() {
    const gl = this.gl;
    this.sunTexture = this._upload2D(this._misc.sun);
    this.moonTexture = this._upload2D(this._misc.moon);
    this.miscBytes = (this._misc.sun.width * this._misc.sun.height + this._misc.moon.width * this._misc.moon.height) * 4;

    // stars
    this.starVAO = gl.createVertexArray();
    this.starVBO = gl.createBuffer();
    gl.bindVertexArray(this.starVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.starVBO);
    gl.bufferData(gl.ARRAY_BUFFER, this._stars, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 24, 16);
    gl.bindVertexArray(null);

    // sun / moon quad
    this.quadVAO = gl.createVertexArray();
    this.quadVBO = gl.createBuffer();
    gl.bindVertexArray(this.quadVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVBO);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    gl.bindVertexArray(null);

    // selection outline: 12 edges x 4 vertices: A(3) B(3) param(2)
    const ov = new Float32Array(12 * 4 * 8);
    let o = 0;
    for (const e of OUTLINE_EDGES) {
      for (const [end, side] of [[0, -1], [1, -1], [1, 1], [0, 1]]) {
        ov.set(e, o);
        ov[o + 6] = end; ov[o + 7] = side;
        o += 8;
      }
    }
    this.outlineVAO = gl.createVertexArray();
    this.outlineVBO = gl.createBuffer();
    gl.bindVertexArray(this.outlineVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.outlineVBO);
    gl.bufferData(gl.ARRAY_BUFFER, ov, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 32, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 32, 12);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 32, 24);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    gl.bindVertexArray(null);

    // clouds
    this.cloudVAO = gl.createVertexArray();
    this.cloudVBO = gl.createBuffer();
    this.cloudBytes = 0;
    gl.bindVertexArray(this.cloudVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cloudVBO);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 16, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  _ensureIndexCapacity(quads) {
    if (quads <= this.indexQuads) return;
    let cap = Math.max(1024, this.indexQuads);
    while (cap < quads) cap *= 2;
    const gl = this.gl;
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    const data = buildQuadIndices(cap);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, data, gl.STATIC_DRAW);
    this.indexQuads = cap;
    this.indexBytes = data.byteLength;
  }

  // -------------------------------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------------------------------

  /** Resize the drawing buffer to css size × devicePixelRatio (capped to the GPU limits / pixel budget). */
  resize(cssWidth, cssHeight, devicePixelRatio = 1) {
    const dpr = devicePixelRatio > 0 ? devicePixelRatio : 1;
    let w = Math.max(1, Math.round(cssWidth * dpr));
    let h = Math.max(1, Math.round(cssHeight * dpr));
    if (w * h > PIXEL_BUDGET) {
      const k = Math.sqrt(PIXEL_BUDGET / (w * h));
      w = Math.max(1, Math.floor(w * k));
      h = Math.max(1, Math.floor(h * k));
    }
    const mv = this.maxViewport;
    if (mv) { w = Math.min(w, mv[0]); h = Math.min(h, mv[1]); }
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
    this.width = w;
    this.height = h;
    this.pixelRatio = cssWidth > 0 ? w / cssWidth : dpr;
  }

  /**
   * Convenience: match the drawing buffer to the canvas' CSS size and the window's devicePixelRatio.
   * Returns true when the size changed. Cheap enough to call every frame.
   */
  resizeToDisplaySize() {
    const c = this.canvas;
    const cssW = c.clientWidth || c.width, cssH = c.clientHeight || c.height;
    const dpr = typeof window !== 'undefined' && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
    const w = this.width, h = this.height;
    this.resize(cssW, cssH, dpr);
    return w !== this.width || h !== this.height;
  }

  /**
   * Upload (or replace) the meshes of one section. Each argument is a §7 Uint32Array or null; all null (or
   * empty) deletes the section.
   */
  setSectionMesh(cx, sy, cz, opaque, cutout, translucent) {
    const key = sectionKey(cx, sy, cz);
    let s = this.sections.get(key);
    const hasO = opaque && opaque.length >= 12, hasC = cutout && cutout.length >= 12;
    const hasT = translucent && translucent.length >= 12;
    if (!hasO && !hasC && !hasT) {
      if (s) this._deleteSection(s);
      return;
    }
    if (this.contextLost) return;
    if (!s) {
      s = new SectionMesh(cx, sy, cz, key);
      s.listIndex = this.sectionList.length;
      this.sectionList.push(s);
      this.sections.set(key, s);
    }
    this._uploadLayer(s, 0, hasO ? opaque : null);
    this._uploadLayer(s, 1, hasC ? cutout : null);
    this._uploadLayer(s, 2, hasT ? translucent : null);
    const b = s.bounds;
    b[0] = b[1] = b[2] = 511; b[3] = b[4] = b[5] = 0;
    if (hasO) accumulateMeshBounds(opaque, b);
    if (hasC) accumulateMeshBounds(cutout, b);
    if (hasT) accumulateMeshBounds(translucent, b);
    for (let i = 0; i < 3; i++) b[i] = (b[i] - 16) / 16 - SWAY_MARGIN;
    for (let i = 3; i < 6; i++) b[i] = (b[i] - 16) / 16 + SWAY_MARGIN;
  }

  /** Delete all 16 section meshes of a chunk. */
  removeChunk(cx, cz) {
    for (let sy = 0; sy < 16; sy++) {
      const s = this.sections.get(sectionKey(cx, sy, cz));
      if (s) this._deleteSection(s);
    }
  }

  /** Delete every section mesh. */
  clearAll() {
    for (let i = this.sectionList.length - 1; i >= 0; i--) this._freeSectionGL(this.sectionList[i]);
    this.sections.clear();
    this.sectionList.length = 0;
    this.vertexBytes = 0;
  }

  hasSection(cx, sy, cz) {
    return this.sections.has(sectionKey(cx, sy, cz));
  }

  /** Stats for the debug screen (object reused between calls). */
  getStats() {
    const o = this._statsOut;
    o.sections = this.sectionList.length;
    o.visibleSections = this._stats.visibleSections;
    o.drawCalls = this._stats.drawCalls;
    o.triangles = this._stats.triangles;
    o.gpuMemoryBytes = this.vertexBytes + this.indexBytes + (this.textureBytes ?? 0) + (this.miscBytes ?? 0) +
      (this.cloudBytes ?? 0) + this._stars.byteLength;
    return o;
  }

  /** Free every GL resource and detach listeners. The renderer is unusable afterwards. */
  dispose() {
    const gl = this.gl;
    this.clearAll();
    if (typeof this.canvas.removeEventListener === 'function') {
      this.canvas.removeEventListener('webglcontextlost', this._onLost, false);
      this.canvas.removeEventListener('webglcontextrestored', this._onRestored, false);
    }
    if (this.contextLost) return;
    if (this.entityRenderer && typeof this.entityRenderer.dispose === 'function') {
      try { this.entityRenderer.dispose(); } catch { /* ignore */ }
    }
    for (const p of Object.values(this.programs)) gl.deleteProgram(p.program);
    for (const b of [this.frameUBO, this.indexBuffer, this.starVBO, this.quadVBO, this.outlineVBO, this.cloudVBO]) {
      gl.deleteBuffer(b);
    }
    for (const v of [this.emptyVAO, this.starVAO, this.quadVAO, this.outlineVAO, this.cloudVAO]) gl.deleteVertexArray(v);
    for (const t of [this.textureArray, this.sunTexture, this.moonTexture]) gl.deleteTexture(t);
    gl.deleteSampler(this.terrainSampler);
  }

  // -------------------------------------------------------------------------------------------------
  // Section resources
  // -------------------------------------------------------------------------------------------------

  _uploadLayer(s, i, data) {
    const gl = this.gl;
    let L = s.layers[i];
    if (!data) {
      if (L) {
        gl.deleteBuffer(L.vbo);
        if (L.ebo) gl.deleteBuffer(L.ebo);
        gl.deleteVertexArray(L.vao);
        this.vertexBytes -= L.bytes + (L.eboBytes ?? 0);
        s.layers[i] = null;
      }
      return;
    }
    const quads = Math.floor(data.length / 12);
    const view = quads * 12 === data.length ? data : data.subarray(0, quads * 12);
    this._ensureIndexCapacity(quads);
    if (!L) {
      L = { vao: gl.createVertexArray(), vbo: gl.createBuffer(), quads: 0, bytes: 0 };
      if (i === TRANSLUCENT) {
        Object.assign(L, {
          ebo: gl.createBuffer(), eboBytes: 0, centers: null, faces: null, keys: null, order: null,
          sortX: NaN, sortY: NaN, sortZ: NaN,
        });
      }
      gl.bindVertexArray(L.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, L.vbo);
      gl.bufferData(gl.ARRAY_BUFFER, view, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribIPointer(0, 3, gl.UNSIGNED_INT, 12, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, i === TRANSLUCENT ? L.ebo : this.indexBuffer);
      gl.bindVertexArray(null);
      s.layers[i] = L;
    } else {
      gl.bindBuffer(gl.ARRAY_BUFFER, L.vbo);
      gl.bufferData(gl.ARRAY_BUFFER, view, gl.STATIC_DRAW);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    this.vertexBytes += view.byteLength - L.bytes;
    L.bytes = view.byteLength;
    L.quads = quads;
    if (i === TRANSLUCENT) this._prepareSortable(L, view, quads);
  }

  /**
   * Translucent layer upload: remember each quad's centre (section-local blocks) and face, and give the
   * layer's own element buffer the emission order until the first sort (_sortTranslucent).
   */
  _prepareSortable(L, view, quads) {
    const gl = this.gl;
    const centers = L.centers && L.centers.length === quads * 3 ? L.centers : (L.centers = new Float32Array(quads * 3));
    const faces = L.faces && L.faces.length === quads ? L.faces : (L.faces = new Uint8Array(quads));
    for (let q = 0, o = 0, c = 0; q < quads; q++, o += 12, c += 3) {
      let sx = 0, sy = 0, sz = 0;
      for (let k = 0; k < 12; k += 3) {
        const w0 = view[o + k];
        sx += w0 & 511;
        sy += (w0 >>> 9) & 511;
        sz += (w0 >>> 18) & 511;
      }
      // §7: position = value / 16 - 1 (blocks); the average of the 4 corners
      centers[c] = sx / 64 - 1;
      centers[c + 1] = sy / 64 - 1;
      centers[c + 2] = sz / 64 - 1;
      faces[q] = Math.min(6, view[o] >>> 29);
    }
    if (!L.order || L.order.length !== quads * 6) L.order = new Uint32Array(quads * 6);
    fillQuadIndices(L.order, quads);
    L.keys = null;
    L.sortX = NaN; L.sortY = NaN; L.sortZ = NaN;
    gl.bindVertexArray(L.vao);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, L.ebo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, L.order, gl.DYNAMIC_DRAW);
    gl.bindVertexArray(null);
    this.vertexBytes += L.order.byteLength - L.eboBytes;
    L.eboBytes = L.order.byteLength;
  }

  /**
   * Re-sort the translucent quads of visible sections back to front where the camera moved enough since
   * their last sort (nearest sections first, bounded by SORT_QUAD_BUDGET quads per frame). Two facing
   * passes can never order a near back face against a far front face in the same section (ice seen from
   * under water vanished, water behind ice disappeared from one side); one sorted, double-sided pass can.
   */
  _sortTranslucent(n) {
    const ord = this._ordered;
    const camX = this._camX, camY = this._camY, camZ = this._camZ;
    let budget = SORT_QUAD_BUDGET;
    for (let i = 0; i < n && budget > 0; i++) {
      const s = ord[i];
      const L = s.layers[TRANSLUCENT];
      if (!L || L.quads < 2) continue;
      const ox = s.cx * 16, oy = s.sy * 16, oz = s.cz * 16;
      const dx = camX - ox - 8, dy = camY - oy - 8, dz = camZ - oz - 8;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const thr = Math.max(SORT_MIN_MOVE, d * SORT_DIST_FACTOR);
      const mx = camX - L.sortX, my = camY - L.sortY, mz = camZ - L.sortZ;
      if (mx * mx + my * my + mz * mz <= thr * thr) continue;   // NaN (never sorted) falls through
      this._sortLayer(L, camX - ox, camY - oy, camZ - oz);
      L.sortX = camX; L.sortY = camY; L.sortZ = camZ;
      budget -= L.quads;
    }
  }

  /** Back-to-front order of one translucent layer for a camera at section-local (cx, cy, cz). */
  _sortLayer(L, cx, cy, cz) {
    const quads = L.quads;
    const keys = L.keys && L.keys.length === quads ? L.keys : (L.keys = new Float64Array(quads));
    const c = L.centers, f = L.faces;
    for (let q = 0, j = 0; q < quads; q++, j += 3) {
      const dx = c[j] - cx, dy = c[j + 1] - cy, dz = c[j + 2] - cz;
      let d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > SORT_MAX_D2) d2 = SORT_MAX_D2;
      // camera behind the quad (dot(normal, centre - camera) > 0): at equal distance it is drawn first,
      // so a coplanar front face (pushed apart in depth by the vertex shader) always blends over it
      const face = f[q];
      const nd = face === 0 ? dx : face === 1 ? -dx : face === 2 ? dy : face === 3 ? -dy : face === 4 ? dz : face === 5 ? -dz : 0;
      keys[q] = (Math.floor(d2 * 256) * 2 + (nd > 0 ? 1 : 0)) * SORT_IDX_SCALE + q;
    }
    keys.sort();
    const order = L.order;
    for (let k = quads - 1, i = 0; k >= 0; k--, i += 6) {
      const v = (keys[k] % SORT_IDX_SCALE) * 4;
      order[i] = v; order[i + 1] = v + 1; order[i + 2] = v + 2;
      order[i + 3] = v; order[i + 4] = v + 2; order[i + 5] = v + 3;
    }
    const gl = this.gl;
    gl.bindVertexArray(L.vao);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, L.ebo);
    gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, 0, order);
    gl.bindVertexArray(null);
  }

  _freeSectionGL(s) {
    const gl = this.gl;
    for (let i = 0; i < LAYER_COUNT; i++) {
      const L = s.layers[i];
      if (!L) continue;
      if (!this.contextLost) {
        gl.deleteBuffer(L.vbo);
        if (L.ebo) gl.deleteBuffer(L.ebo);
        gl.deleteVertexArray(L.vao);
      }
      this.vertexBytes -= L.bytes + (L.eboBytes ?? 0);
      s.layers[i] = null;
    }
  }

  _deleteSection(s) {
    this._freeSectionGL(s);
    this.sections.delete(s.key);
    const list = this.sectionList;
    const last = list.pop();
    if (last !== s) {
      list[s.listIndex] = last;
      last.listIndex = s.listIndex;
    }
    s.listIndex = -1;
  }

  // -------------------------------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------------------------------

  /** Render one frame. See SPEC §9.3 FrameState. */
  render(frame) {
    const st = this._stats;
    st.drawCalls = 0; st.triangles = 0; st.visibleSections = 0;
    if (this.contextLost || !frame || !frame.camera) return;
    const gl = this.gl;
    if (gl.isContextLost()) return;
    const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
    if (W <= 0 || H <= 0) return;

    const cam = frame.camera;
    const tod = Number.isFinite(frame.timeOfDay) ? frame.timeOfDay - Math.floor(frame.timeOfDay) : 0.25;
    const daylight = Number.isFinite(frame.daylight) ? frame.daylight : computeDaylight(tod);
    const time = Number.isFinite(frame.time) ? frame.time : performance.now() / 1000;
    const rd = frame.renderDistance > 0 ? frame.renderDistance : 8;
    const inLava = !!frame.inLava;
    const underwater = !inLava && !!frame.underwater;
    const camX = cam.x, camY = cam.y, camZ = cam.z;

    // ---- matrices (rotation-only view, camera-relative world) ----
    const aspect = W / H;
    mat4Perspective(this.proj, (cam.fov > 1 ? cam.fov : 70) * DEG, aspect, NEAR, FAR);
    mat4ViewRotation(this.viewRot, cam.yaw || 0, cam.pitch || 0, cam.roll || 0);
    mat4Multiply(this.viewProj, this.proj, this.viewRot);
    mat4Invert(this.invViewProj, this.viewProj);
    this._extractPlanes(this.viewProj);

    // ---- environment ----
    const sky = computeSkyState(tod, rd, camY, this._sky, frame.voidFogScale > 0 ? frame.voidFogScale : 1 / 32);
    computeSkyTint(daylight, this._skyTint);
    this._skyTint[3] = Number.isFinite(frame.brightness) ? clamp(frame.brightness, 0, 1) : 0.5;
    let fogStart = 0.6 * rd * 16, fogEnd = 0.95 * rd * 16, fogMode = 0;
    const flat = this._flatFog;
    if (inLava) {
      fogStart = LAVA_FOG_RANGE[0]; fogEnd = LAVA_FOG_RANGE[1]; fogMode = 2;
      flat[0] = LAVA_FOG[0]; flat[1] = LAVA_FOG[1]; flat[2] = LAVA_FOG[2];
    } else if (underwater) {
      fogStart = WATER_FOG_RANGE[0]; fogEnd = WATER_FOG_RANGE[1]; fogMode = 1;
      const k = 0.18 + 0.82 * clamp((daylight - 0.2) / 0.8, 0, 1);
      flat[0] = WATER_FOG[0] * k; flat[1] = WATER_FOG[1] * k; flat[2] = WATER_FOG[2] * k;
    }
    this._lookFogColor(cam, fogMode, this._fogColor);

    this._camX = camX; this._camY = camY; this._camZ = camZ; this._time = time;
    this._fov = cam.fov > 1 ? cam.fov : 70;
    this._cullDist = fogEnd + 1;
    const camIX = Math.floor(camX), camIY = Math.floor(camY), camIZ = Math.floor(camZ);
    this._camI[0] = camIX; this._camI[1] = camIY; this._camI[2] = camIZ;
    const timeWrapped = time - Math.floor(time / 256) * 256;
    const liquidFrame = ((Math.floor(time * 8) % 16) + 16) % 16;

    // ---- per-frame uniform block ----
    const u = this._frameData, LY = FRAME_UBO_LAYOUT;
    u.set(this.viewProj, LY.viewProj);
    u.set(this.invViewProj, LY.invViewProj);
    u[LY.camFrac] = camX - camIX; u[LY.camFrac + 1] = camY - camIY; u[LY.camFrac + 2] = camZ - camIZ;
    u[LY.camFrac + 3] = timeWrapped;
    u[LY.camWrap] = ((camIX % 256) + 256) % 256; u[LY.camWrap + 1] = ((camIY % 256) + 256) % 256;
    u[LY.camWrap + 2] = ((camIZ % 256) + 256) % 256; u[LY.camWrap + 3] = liquidFrame;
    u[LY.fog] = fogStart; u[LY.fog + 1] = fogEnd; u[LY.fog + 2] = 1 / Math.max(1e-3, fogEnd - fogStart);
    u[LY.fog + 3] = fogMode;
    u[LY.light] = daylight; u[LY.light + 1] = sky.starBrightness; u[LY.light + 2] = sky.cloudBrightness;
    u[LY.light + 3] = sky.sunAngle;
    u[LY.skyTint] = this._skyTint[0]; u[LY.skyTint + 1] = this._skyTint[1]; u[LY.skyTint + 2] = this._skyTint[2];
    u[LY.skyTint + 3] = this._skyTint[3];
    u[LY.skyZenith] = sky.zenith[0]; u[LY.skyZenith + 1] = sky.zenith[1]; u[LY.skyZenith + 2] = sky.zenith[2];
    u[LY.skyZenith + 3] = sky.sunSide;
    u[LY.skyHorizon] = sky.horizon[0]; u[LY.skyHorizon + 1] = sky.horizon[1]; u[LY.skyHorizon + 2] = sky.horizon[2];
    u[LY.skyHorizon + 3] = 8.0;
    u[LY.sunrise] = sky.sunrise[0]; u[LY.sunrise + 1] = sky.sunrise[1]; u[LY.sunrise + 2] = sky.sunrise[2];
    u[LY.sunrise + 3] = sky.sunrise[3];
    u[LY.fogFlat] = flat[0]; u[LY.fogFlat + 1] = flat[1]; u[LY.fogFlat + 2] = flat[2];
    u[LY.fogFlat + 3] = fogMode !== 0 ? 1 : 0;
    u[LY.sunDir] = sky.sunDir[0]; u[LY.sunDir + 1] = sky.sunDir[1]; u[LY.sunDir + 2] = sky.sunDir[2];
    u[LY.viewport] = W; u[LY.viewport + 1] = H; u[LY.viewport + 2] = 1 / W; u[LY.viewport + 3] = 1 / H;
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.frameUBO);
    gl.bufferSubData(gl.UNIFORM_BUFFER, 0, u);
    gl.bindBuffer(gl.UNIFORM_BUFFER, null);
    gl.bindBufferBase(gl.UNIFORM_BUFFER, FRAME_UBO_BINDING, this.frameUBO);

    // ---- entity context ----
    const ctx = this.ctx;
    ctx.gl = gl;
    ctx.cameraPos[0] = camX; ctx.cameraPos[1] = camY; ctx.cameraPos[2] = camZ;
    const vr = this.viewRot;
    ctx.camRight[0] = vr[0]; ctx.camRight[1] = vr[4]; ctx.camRight[2] = vr[8];
    ctx.camUp[0] = vr[1]; ctx.camUp[1] = vr[5]; ctx.camUp[2] = vr[9];
    ctx.fogColor[0] = this._fogColor[0]; ctx.fogColor[1] = this._fogColor[1]; ctx.fogColor[2] = this._fogColor[2];
    ctx.fogStart = fogStart; ctx.fogEnd = fogEnd;
    ctx.daylight = daylight; ctx.time = time; ctx.aspect = aspect; ctx.texture = this.textureArray;

    // ---- visibility + sorting ----
    const n = this._collectVisible();
    st.visibleSections = n;

    // ---- base state ----
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, W, H);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.colorMask(true, true, true, true);
    gl.depthMask(true);
    gl.stencilMask(0xff);
    gl.clearDepth(1);
    gl.clearStencil(0);
    gl.clear(gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);   // colour: the sky pass covers every pixel
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.frontFace(gl.CCW);

    // ---- sky ----
    this._drawSky(fogMode !== 0, sky, H);

    // ---- terrain: opaque + cutout ----
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.textureArray);
    gl.bindSampler(0, this.terrainSampler);
    const smooth = this.filtering === 'smooth' ? 1 : 0;
    this._drawTerrainLayer(this.programs.terrainOpaque, 0, n, smooth);
    this._drawTerrainLayer(this.programs.terrainCutout, 1, n, smooth);

    // ---- crack overlay (opaque + cutout geometry) + selection outline ----
    if (frame.breaking) this._drawCrack(frame.breaking, smooth, W, H, false);
    gl.bindSampler(0, null);
    if (frame.selection) this._drawOutline(frame.selection, W);

    // ---- entities + particles ----
    const er = this.entityRenderer;
    if (er) {
      if (frame.entities && frame.entities.length > 0 && typeof er.renderEntities === 'function') {
        this._prepareExternal(W, H);
        try { er.renderEntities(ctx, frame.entities); } catch (err) { this._hookError('renderEntities', err); }
      }
      if (frame.particles && frame.particles.count > 0 && typeof er.renderParticles === 'function') {
        this._prepareExternal(W, H);
        try { er.renderParticles(ctx, frame.particles); } catch (err) { this._hookError('renderParticles', err); }
      }
      this._restoreAfterExternal(W, H);
    }

    // ---- translucent ----
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.textureArray);
    gl.bindSampler(0, this.terrainSampler);
    this._drawTranslucent(n, smooth);
    if (frame.breaking) this._drawCrack(frame.breaking, smooth, W, H, true);   // cracks on ice / glass-like blocks
    gl.bindSampler(0, null);

    // ---- clouds ----
    if (frame.clouds !== false && fogMode === 0) this._drawClouds(rd);

    // ---- first-person hand ----
    if (er && frame.hand && typeof er.renderHand === 'function') {
      this._prepareExternal(W, H);
      try { er.renderHand(ctx, frame.hand); } catch (err) { this._hookError('renderHand', err); }
    }

    // ---- underwater / lava screen tint ----
    if (fogMode !== 0) {
      const p = this.programs.overlay;
      gl.useProgram(p.program);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE);
      gl.disable(gl.STENCIL_TEST);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.DST_COLOR, gl.ZERO);
      gl.uniform4fv(p.uniforms.uColor, fogMode === 2 ? LAVA_TINT4 : WATER_TINT4);
      gl.bindVertexArray(this.emptyVAO);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      st.drawCalls++; st.triangles++;
    }

    // leave a tidy state for whoever draws next
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.SCISSOR_TEST);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.colorMask(true, true, true, true);
  }

  // -------------------------------------------------------------------------------------------------
  // Frame helpers
  // -------------------------------------------------------------------------------------------------

  /** Fog colour for the entity renderer: the sky colour on the horizon in the look direction (MC style). */
  _lookFogColor(cam, fogMode, out) {
    if (fogMode !== 0) {
      out[0] = this._flatFog[0]; out[1] = this._flatFog[1]; out[2] = this._flatFog[2];
      return out;
    }
    const sky = this._sky;
    const fx = -Math.sin(cam.yaw || 0);
    const facing = Math.max(fx * sky.sunSide, 0);
    const toSun = facing * sky.sunrise[3];
    // sunrise glow fan at the horizon (same model as the shader, elevation 0)
    const glow = sky.sunrise[3] * facing * Math.sqrt(facing);
    for (let i = 0; i < 3; i++) {
      const h = sky.horizon[i] + (sky.sunrise[i] - sky.horizon[i]) * toSun;
      out[i] = h + (sky.sunrise[i] - h) * glow;
    }
    return out;
  }

  _extractPlanes(m) {
    const p = this._planes;
    // left, right, bottom, top, near, far  (a*x + b*y + c*z + d >= 0 inside)
    p[0] = m[3] + m[0]; p[1] = m[7] + m[4]; p[2] = m[11] + m[8]; p[3] = m[15] + m[12];
    p[4] = m[3] - m[0]; p[5] = m[7] - m[4]; p[6] = m[11] - m[8]; p[7] = m[15] - m[12];
    p[8] = m[3] + m[1]; p[9] = m[7] + m[5]; p[10] = m[11] + m[9]; p[11] = m[15] + m[13];
    p[12] = m[3] - m[1]; p[13] = m[7] - m[5]; p[14] = m[11] - m[9]; p[15] = m[15] - m[13];
    p[16] = m[3] + m[2]; p[17] = m[7] + m[6]; p[18] = m[11] + m[10]; p[19] = m[15] + m[14];
    p[20] = m[3] - m[2]; p[21] = m[7] - m[6]; p[22] = m[11] - m[10]; p[23] = m[15] - m[14];
  }

  /**
   * Fill this._ordered with visible sections sorted front-to-back. Returns the count.
   * Distance + frustum tests are inlined (no calls with double arguments in the hot loop = no boxing).
   */
  _collectVisible() {
    const camX = this._camX, camY = this._camY, camZ = this._camZ, maxDist = this._cullDist;
    const list = this.sectionList;
    const total = list.length;
    if (this._keys.length < total) {
      let cap = this._keys.length;
      while (cap < total) cap *= 2;
      this._keys = new Uint32Array(cap);
      this._keysTmp = new Uint32Array(cap);
    }
    const keys = this._keys, vis = this._visible, p = this._planes;
    const maxD2 = maxDist * maxDist;
    let n = 0;
    for (let i = 0; i < total && n < MAX_VISIBLE; i++) {
      const s = list[i];
      const b = s.bounds;
      const ox = s.cx * 16 - camX, oy = s.sy * 16 - camY, oz = s.cz * 16 - camZ;
      const x0 = ox + b[0], y0 = oy + b[1], z0 = oz + b[2];
      const x1 = ox + b[3], y1 = oy + b[4], z1 = oz + b[5];
      const dx = x0 > 0 ? x0 : (x1 < 0 ? -x1 : 0);
      const dy = y0 > 0 ? y0 : (y1 < 0 ? -y1 : 0);
      const dz = z0 > 0 ? z0 : (z1 < 0 ? -z1 : 0);
      if (dx * dx + dy * dy + dz * dz > maxD2) continue;
      // conservative AABB vs frustum: test the box corner furthest along each plane normal
      let inside = true;
      for (let k = 0; k < 24; k += 4) {
        const a = p[k], bb = p[k + 1], c = p[k + 2];
        if (a * (a >= 0 ? x1 : x0) + bb * (bb >= 0 ? y1 : y0) + c * (c >= 0 ? z1 : z0) + p[k + 3] < 0) {
          inside = false;
          break;
        }
      }
      if (!inside) continue;
      const mx = ox + 8, my = oy + 8, mz = oz + 8;
      const q = Math.min(65535, Math.floor(Math.sqrt(mx * mx + my * my + mz * mz) * 4));
      keys[n] = ((q << 16) | n) >>> 0;
      vis[n] = s;
      n++;
    }
    radixSortHigh16(keys, n, this._keysTmp, this._counts);
    const ord = this._ordered;
    for (let i = 0; i < n; i++) ord[i] = vis[keys[i] & 0xffff];
    // drop stale references so deleted sections can be collected
    for (let i = n; i < this._visibleCount; i++) { vis[i] = null; ord[i] = null; }
    this._visibleCount = n;
    return n;
  }

  _drawTerrainLayer(prog, layer, n, smooth) {
    const gl = this.gl;
    const st = this._stats;
    const ord = this._ordered;
    const cix = this._camI[0], ciy = this._camI[1], ciz = this._camI[2];
    let used = false;
    let loc = null;
    for (let i = 0; i < n; i++) {
      const s = ord[i];
      const L = s.layers[layer];
      if (!L) continue;
      if (!used) {
        gl.useProgram(prog.program);
        gl.uniform1i(prog.uniforms.uTex, 0);
        gl.uniform1f(prog.uniforms.uSmoothTexels, smooth);
        loc = prog.uniforms.uSectionOffset;
        used = true;
      }
      gl.uniform3f(loc, s.cx * 16 - cix, s.sy * 16 - ciy, s.cz * 16 - ciz);
      gl.bindVertexArray(L.vao);
      gl.drawElements(gl.TRIANGLES, L.quads * 6, gl.UNSIGNED_INT, 0);
      st.drawCalls++;
      st.triangles += L.quads * 2;
    }
  }

  _drawTranslucent(n, smooth) {
    const gl = this.gl;
    const st = this._stats;
    const ord = this._ordered;
    const prog = this.programs.terrainTranslucent;
    const cix = this._camI[0], ciy = this._camI[1], ciz = this._camI[2];
    this._sortTranslucent(n);
    let used = false;
    let loc = null;
    for (let i = n - 1; i >= 0; i--) {
      const s = ord[i];
      const L = s.layers[TRANSLUCENT];
      if (!L) continue;
      if (!used) {
        gl.useProgram(prog.program);
        gl.uniform1i(prog.uniforms.uTex, 0);
        gl.uniform1f(prog.uniforms.uSmoothTexels, smooth);
        loc = prog.uniforms.uSectionOffset;
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LEQUAL);
        gl.depthMask(true);          // clouds (drawn next) rely on the depth of water / ice
        gl.enable(gl.BLEND);
        gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.disable(gl.CULL_FACE);    // both sides of every quad, in the section's back-to-front order
        gl.disable(gl.POLYGON_OFFSET_FILL);
        used = true;
      }
      gl.uniform3f(loc, s.cx * 16 - cix, s.sy * 16 - ciy, s.cz * 16 - ciz);
      gl.bindVertexArray(L.vao);
      gl.drawElements(gl.TRIANGLES, L.quads * 6, gl.UNSIGNED_INT, 0);
      st.drawCalls++;
      st.triangles += L.quads * 2;
    }
    if (used) {
      gl.disable(gl.BLEND);
      gl.enable(gl.CULL_FACE);
      gl.cullFace(gl.BACK);
    }
  }

  _drawSky(flatFog, sky, H) {
    const gl = this.gl;
    const fovDeg = this._fov;
    const st = this._stats;
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    const p = this.programs.sky;
    gl.useProgram(p.program);
    gl.bindVertexArray(this.emptyVAO);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    st.drawCalls++; st.triangles++;
    if (flatFog) {
      gl.depthMask(true);
      return;
    }
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    // sun and moon (additive); their opaque cores write a far depth so that stars stay behind them
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.ALWAYS);
    gl.depthMask(true);
    const cp = this.programs.celestial;
    gl.useProgram(cp.program);
    gl.bindVertexArray(this.quadVAO);
    gl.activeTexture(gl.TEXTURE1);
    gl.uniform1i(cp.uniforms.uImage, 1);
    gl.uniform1f(cp.uniforms.uBrightness, 1.0);
    const sx = sky.sunDir[0], sy = sky.sunDir[1];
    // quad basis: right = +Z, up = perpendicular in the sun's plane of motion
    for (let k = 0; k < 2; k++) {
      const sgn = k === 0 ? 1 : -1;
      const size = k === 0 ? SUN_SIZE : MOON_SIZE;
      gl.bindTexture(gl.TEXTURE_2D, k === 0 ? this.sunTexture : this.moonTexture);
      const c = this._f3a, up = this._f3b;
      c[0] = sx * 100 * sgn; c[1] = sy * 100 * sgn; c[2] = 0;
      up[0] = -sy * size * sgn; up[1] = sx * size * sgn; up[2] = 0;
      gl.uniform3fv(cp.uniforms.uCenter, c);
      gl.uniform3f(cp.uniforms.uRight, 0, 0, size);
      gl.uniform3fv(cp.uniforms.uUp, up);
      gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_INT, 0);
      st.drawCalls++; st.triangles += 2;
    }
    gl.activeTexture(gl.TEXTURE0);
    // stars (additive, depth-tested against the sun/moon cores)
    if (sky.starBrightness > 0.001) {
      const sp = this.programs.stars;
      gl.useProgram(sp.program);
      gl.depthFunc(gl.LEQUAL);
      gl.depthMask(false);
      // pixel size: stars are ~0.15-0.25 deg; keep them at least ~1 px (scaled with resolution and FOV)
      const scale = (H / 1080) * (70 / fovDeg);
      this._f1[0] = Math.max(0.75, scale);
      gl.uniform1fv(sp.uniforms.uPointScale, this._f1);
      gl.bindVertexArray(this.starVAO);
      gl.drawArrays(gl.POINTS, 0, this._stars.length / 6);
      st.drawCalls++;
    }
    gl.disable(gl.BLEND);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
  }

  /**
   * Crack overlay on the breaking block's own geometry. Called twice: before the translucent pass for the opaque
   * and cutout layers (so water in front still blends over the cracks) and after it for the translucent layer.
   */
  _drawCrack(breaking, smooth, W, H, translucent) {
    if (!(breaking.stage >= 0)) return;   // -1 / undefined / NaN = not breaking
    const stage = Math.min(9, Math.floor(breaking.stage));
    const bx = Math.floor(breaking.x), by = Math.floor(breaking.y), bz = Math.floor(breaking.z);
    const s = this.sections.get(sectionKey(bx >> 4, by >> 4, bz >> 4));
    if (!s) return;
    const first = translucent ? 2 : 0, last = translucent ? 2 : 1;
    let any = false;
    for (let layer = first; layer <= last; layer++) if (s.layers[layer]) any = true;
    if (!any) return;
    const gl = this.gl;
    const st = this._stats;
    const cix = this._camI[0], ciy = this._camI[1], ciz = this._camI[2];
    const p = this.programs.crack;
    gl.useProgram(p.program);
    gl.uniform1i(p.uniforms.uTex, 0);
    gl.uniform1f(p.uniforms.uSmoothTexels, smooth);
    gl.uniform3f(p.uniforms.uCrackCell, bx - cix, by - ciy, bz - ciz);
    gl.uniform1f(p.uniforms.uCrackLayer, this.crackLayers[stage]);
    gl.uniform3f(p.uniforms.uSectionOffset, s.cx * 16 - cix, s.sy * 16 - ciy, s.cz * 16 - ciz);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(false);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.DST_COLOR, gl.SRC_COLOR);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(-1, -2);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    // only rasterise the block's screen rectangle
    const sc = this._blockScissor(bx, by, bz, W, H);
    if (sc) {
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(sc[0], sc[1], sc[2], sc[3]);
    }
    for (let layer = first; layer <= last; layer++) {
      const L = s.layers[layer];
      if (!L) continue;
      gl.bindVertexArray(L.vao);
      gl.drawElements(gl.TRIANGLES, L.quads * 6, gl.UNSIGNED_INT, 0);
      st.drawCalls++;
      st.triangles += L.quads * 2;
    }
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.disable(gl.BLEND);
    gl.depthMask(true);
  }

  /** Screen rectangle [x, y, w, h] of the unit block at integer (bx, by, bz), or null (use the full screen). */
  _blockScissor(bx, by, bz, W, H) {
    const m = this.viewProj;
    const x = bx - this._camX, y = by - this._camY, z = bz - this._camZ;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < 8; i++) {
      const px = x + (i & 1 ? 1.25 : -0.25), py = y + (i & 2 ? 1.25 : -0.25), pz = z + (i & 4 ? 1.25 : -0.25);
      const cw = m[3] * px + m[7] * py + m[11] * pz + m[15];
      if (cw <= NEAR) return null;
      const cx = (m[0] * px + m[4] * py + m[8] * pz + m[12]) / cw;
      const cy = (m[1] * px + m[5] * py + m[9] * pz + m[13]) / cw;
      if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
      if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
    }
    const r = this._scissor ?? (this._scissor = new Int32Array(4));
    const x0 = Math.max(0, Math.floor((minX * 0.5 + 0.5) * W) - 2);
    const y0 = Math.max(0, Math.floor((minY * 0.5 + 0.5) * H) - 2);
    const x1 = Math.min(W, Math.ceil((maxX * 0.5 + 0.5) * W) + 2);
    const y1 = Math.min(H, Math.ceil((maxY * 0.5 + 0.5) * H) + 2);
    if (x1 <= x0 || y1 <= y0) { r[0] = 0; r[1] = 0; r[2] = 0; r[3] = 0; return r; }
    r[0] = x0; r[1] = y0; r[2] = x1 - x0; r[3] = y1 - y0;
    return r;
  }

  _drawOutline(sel, W) {
    const gl = this.gl;
    const camX = this._camX, camY = this._camY, camZ = this._camZ;
    const box = sel.box && sel.box.length >= 6 ? sel.box : null;
    const g = OUTLINE_GROW;
    const x0 = sel.x + (box ? box[0] : 0) - g - camX, y0 = sel.y + (box ? box[1] : 0) - g - camY;
    const z0 = sel.z + (box ? box[2] : 0) - g - camZ;
    const x1 = sel.x + (box ? box[3] : 1) + g - camX, y1 = sel.y + (box ? box[4] : 1) + g - camY;
    const z1 = sel.z + (box ? box[5] : 1) + g - camZ;
    const p = this.programs.outline;
    gl.useProgram(p.program);
    const bmin = this._f3a, bmax = this._f3b;
    bmin[0] = x0; bmin[1] = y0; bmin[2] = z0;
    bmax[0] = x1; bmax[1] = y1; bmax[2] = z1;
    gl.uniform3fv(p.uniforms.uBoxMin, bmin);
    gl.uniform3fv(p.uniforms.uBoxMax, bmax);
    this._f1[0] = Math.max(2.5, (W / 1920) * 2.5);
    gl.uniform1fv(p.uniforms.uLineWidth, this._f1);
    gl.uniform4fv(p.uniforms.uColor, OUTLINE_COLOR);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
    if (this.stencilBits > 0) {
      gl.enable(gl.STENCIL_TEST);
      gl.stencilFunc(gl.EQUAL, 0, 0xff);
      gl.stencilOp(gl.KEEP, gl.KEEP, gl.INCR);
    }
    gl.bindVertexArray(this.outlineVAO);
    gl.drawElements(gl.TRIANGLES, 12 * 6, gl.UNSIGNED_INT, 0);
    this._stats.drawCalls++;
    this._stats.triangles += 24;
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.BLEND);
    gl.enable(gl.CULL_FACE);
  }

  _drawClouds(rd) {
    const gl = this.gl;
    const camX = this._camX, camY = this._camY, camZ = this._camZ, time = this._time;
    const st = this._stats;
    const cl = this._cloud;
    const bmp = this._misc.clouds;
    const range = cloudRange(rd);
    const radius = Math.ceil(range / CLOUD_CELL) + 1;
    const period = bmp.width * CLOUD_CELL;
    const drift = (time * CLOUD_SPEED) % period;
    const cellX = Math.floor((camX - drift) / CLOUD_CELL);
    const cellZ = Math.floor(camZ / CLOUD_CELL);
    if (cellX !== cl.cellX || cellZ !== cl.cellZ || radius !== cl.radius) {
      let quads = buildCloudMesh(bmp.data, bmp.width, bmp.height, cellX, cellZ, radius, cl.data);
      while (quads < 0) {
        cl.data = new Float32Array(cl.data.length * 2);
        quads = buildCloudMesh(bmp.data, bmp.width, bmp.height, cellX, cellZ, radius, cl.data);
      }
      cl.cellX = cellX; cl.cellZ = cellZ; cl.radius = radius; cl.quads = quads;
      if (quads > 0) {
        this._ensureIndexCapacity(quads);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.cloudVBO);
        gl.bufferData(gl.ARRAY_BUFFER, cl.data, gl.DYNAMIC_DRAW, 0, quads * 16);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
      }
      this.cloudBytes = quads * 64;
    }
    if (cl.quads === 0) return;
    const p = this.programs.clouds;
    gl.useProgram(p.program);
    const off = this._f3a, fog = this._f4;
    off[0] = cellX * CLOUD_CELL + drift - camX; off[1] = CLOUD_Y - camY; off[2] = cellZ * CLOUD_CELL - camZ;
    fog[0] = range * 0.5; fog[1] = 1 / (range * 0.5); fog[2] = CLOUD_ALPHA; fog[3] = 0;
    gl.uniform3fv(p.uniforms.uCloudOffset, off);
    gl.uniform4fv(p.uniforms.uCloudFog, fog);
    gl.bindVertexArray(this.cloudVAO);
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    // pass 1: depth only, so that only the nearest cloud surface is blended
    gl.colorMask(false, false, false, false);
    gl.depthMask(true);
    gl.depthFunc(gl.LEQUAL);
    gl.drawElements(gl.TRIANGLES, cl.quads * 6, gl.UNSIGNED_INT, 0);
    // pass 2: colour where the depth matches
    gl.colorMask(true, true, true, true);
    gl.depthMask(false);
    gl.depthFunc(gl.EQUAL);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
    gl.drawElements(gl.TRIANGLES, cl.quads * 6, gl.UNSIGNED_INT, 0);
    st.drawCalls += 2;
    st.triangles += cl.quads * 4;
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.enable(gl.CULL_FACE);
  }

  /** GL state handed to EntityRenderer hooks (they may change it; every pass here sets what it needs). */
  _prepareExternal(W, H) {
    const gl = this.gl;
    gl.bindVertexArray(null);
    gl.viewport(0, 0, W, H);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.disable(gl.BLEND);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    gl.colorMask(true, true, true, true);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.frontFace(gl.CCW);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindSampler(0, null);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.textureArray);
  }

  /** Re-establish the state this renderer relies on after an external hook ran. */
  _restoreAfterExternal(W, H) {
    const gl = this.gl;
    gl.bindVertexArray(null);
    gl.viewport(0, 0, W, H);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.colorMask(true, true, true, true);
    gl.frontFace(gl.CCW);
    gl.bindBufferBase(gl.UNIFORM_BUFFER, FRAME_UBO_BINDING, this.frameUBO);
  }

  /** Report an EntityRenderer hook failure once per hook; the frame continues without that hook's output. */
  _hookError(name, err) {
    if (this._hookErrors.has(name)) return;
    this._hookErrors.add(name);
    console.error(`[renderer] EntityRenderer.${name} threw:`, err);
  }
}
