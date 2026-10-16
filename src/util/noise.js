// Seeded hashing, PRNG and gradient noise (Simplex 2D/3D + fractal helpers).
// Pure module: no DOM, no allocations in the noise functions (used by world generation in workers).

// ---------------------------------------------------------------------------
// Hashing / PRNG
// ---------------------------------------------------------------------------

/** murmur3 32-bit finalizer: good avalanche for integer inputs. */
function fmix32(h) {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Stable 32-bit hash of a string (FNV-1a over UTF-16 code units + murmur3 finalizer).
 * @param {string} str
 * @returns {number} uint32
 */
export function hashString(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return fmix32(h);
}

/**
 * Mulberry32 PRNG. Small, fast and statistically decent; returns floats in [0,1).
 * @param {number} seed uint32 (any number is coerced)
 * @returns {() => number}
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Fast integer hash of a seed and an integer position (per-block randomness).
 * Every input bit affects every output bit; different argument orders give different values.
 * @returns {number} uint32
 */
export function hash3i(seed, x, y, z) {
  let h = (seed ^ 0x9e3779b9) | 0;
  h = Math.imul(h ^ (x | 0), 0xcc9e2d51);
  h = (h << 15) | (h >>> 17);
  h = Math.imul(h ^ (y | 0), 0x1b873593);
  h = (h << 13) | (h >>> 19);
  h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  h = Math.imul(h ^ (z | 0), 0x85ebca6b);
  h = (h << 15) | (h >>> 17);
  h = Math.imul(h, 0xc2b2ae35);
  return fmix32(h);
}

/** hash3i mapped to a float in [0,1). */
export function hash3f(seed, x, y, z) {
  return hash3i(seed, x, y, z) / 4294967296;
}

// ---------------------------------------------------------------------------
// Simplex noise (Stefan Gustavson's formulation)
// ---------------------------------------------------------------------------

const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;
const F3 = 1 / 3;
const G3 = 1 / 6;

// 2D: 12 unit gradients spaced 30 degrees apart (more isotropic than cube-edge gradients).
const GRAD2 = new Float64Array(24);
for (let i = 0; i < 12; i++) {
  const a = (i / 12) * Math.PI * 2 + Math.PI / 12;
  GRAD2[i * 2] = Math.cos(a);
  GRAD2[i * 2 + 1] = Math.sin(a);
}
// 3D: the 12 cube-edge midpoints.
const GRAD3 = new Float64Array([
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0,
  1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
  0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1,
]);

// Output scale factors: chosen so the extreme values come close to ±1 (measured, see tests/noise.test.js).
const SCALE2 = 99.204334582718;
const SCALE3 = 32.69588638818;

/**
 * Seeded Simplex noise. Values are in [-1, 1] (continuous, zero-mean, gradient noise).
 */
export class SimplexNoise {
  /** @param {number} seed uint32 */
  constructor(seed = 0) {
    const rng = mulberry32(seed);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = p[i];
      p[i] = p[j];
      p[j] = t;
    }
    this.perm = new Uint8Array(512);
    this.permMod12 = new Uint8Array(512);
    for (let i = 0; i < 512; i++) {
      this.perm[i] = p[i & 255];
      this.permMod12[i] = this.perm[i] % 12;
    }
  }

  /** @returns {number} in [-1, 1] */
  noise2D(xin, yin) {
    const perm = this.perm;
    const pm = this.permMod12;
    const s = (xin + yin) * F2;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const t = (i + j) * G2;
    const x0 = xin - (i - t);
    const y0 = yin - (j - t);
    let i1 = 0;
    let j1 = 1;
    if (x0 > y0) {
      i1 = 1;
      j1 = 0;
    }
    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2;
    const y2 = y0 - 1 + 2 * G2;
    const ii = i & 255;
    const jj = j & 255;
    let n = 0;
    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 > 0) {
      const g = pm[ii + perm[jj]] << 1;
      t0 *= t0;
      n += t0 * t0 * (GRAD2[g] * x0 + GRAD2[g + 1] * y0);
    }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 > 0) {
      const g = pm[ii + i1 + perm[jj + j1]] << 1;
      t1 *= t1;
      n += t1 * t1 * (GRAD2[g] * x1 + GRAD2[g + 1] * y1);
    }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 > 0) {
      const g = pm[ii + 1 + perm[jj + 1]] << 1;
      t2 *= t2;
      n += t2 * t2 * (GRAD2[g] * x2 + GRAD2[g + 1] * y2);
    }
    const v = SCALE2 * n;
    return v > 1 ? 1 : v < -1 ? -1 : v;
  }

  /** @returns {number} in [-1, 1] */
  noise3D(xin, yin, zin) {
    const perm = this.perm;
    const pm = this.permMod12;
    const s = (xin + yin + zin) * F3;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const k = Math.floor(zin + s);
    const t = (i + j + k) * G3;
    const x0 = xin - (i - t);
    const y0 = yin - (j - t);
    const z0 = zin - (k - t);
    let i1, j1, k1, i2, j2, k2;
    if (x0 >= y0) {
      if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
      else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
      else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
    } else if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
    else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
    else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
    const x1 = x0 - i1 + G3;
    const y1 = y0 - j1 + G3;
    const z1 = z0 - k1 + G3;
    const x2 = x0 - i2 + 2 * G3;
    const y2 = y0 - j2 + 2 * G3;
    const z2 = z0 - k2 + 2 * G3;
    const x3 = x0 - 1 + 3 * G3;
    const y3 = y0 - 1 + 3 * G3;
    const z3 = z0 - 1 + 3 * G3;
    const ii = i & 255;
    const jj = j & 255;
    const kk = k & 255;
    let n = 0;
    let t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
    if (t0 > 0) {
      const g = pm[ii + perm[jj + perm[kk]]] * 3;
      t0 *= t0;
      n += t0 * t0 * (GRAD3[g] * x0 + GRAD3[g + 1] * y0 + GRAD3[g + 2] * z0);
    }
    let t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
    if (t1 > 0) {
      const g = pm[ii + i1 + perm[jj + j1 + perm[kk + k1]]] * 3;
      t1 *= t1;
      n += t1 * t1 * (GRAD3[g] * x1 + GRAD3[g + 1] * y1 + GRAD3[g + 2] * z1);
    }
    let t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
    if (t2 > 0) {
      const g = pm[ii + i2 + perm[jj + j2 + perm[kk + k2]]] * 3;
      t2 *= t2;
      n += t2 * t2 * (GRAD3[g] * x2 + GRAD3[g + 1] * y2 + GRAD3[g + 2] * z2);
    }
    let t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
    if (t3 > 0) {
      const g = pm[ii + 1 + perm[jj + 1 + perm[kk + 1]]] * 3;
      t3 *= t3;
      n += t3 * t3 * (GRAD3[g] * x3 + GRAD3[g + 1] * y3 + GRAD3[g + 2] * z3);
    }
    const v = SCALE3 * n;
    return v > 1 ? 1 : v < -1 ? -1 : v;
  }
}

// ---------------------------------------------------------------------------
// Fractal helpers
// ---------------------------------------------------------------------------

// Per-octave offsets decorrelate the octaves (otherwise all octaves vanish together at the origin).
const OCT_OX = [0, 37.17, -71.43, 113.91, -157.33, 201.77, -245.19, 289.61, -333.07, 377.53];
const OCT_OY = [0, -53.29, 91.67, -129.13, 167.59, -205.03, 243.47, -281.89, 319.31, -357.73];
const OCT_OZ = [0, 61.41, -99.85, 137.27, -175.69, 213.11, -251.53, 289.97, -327.39, 365.81];

/**
 * Fractal Brownian motion of 2D simplex noise, normalised by the total amplitude to stay in [-1, 1].
 * @param {SimplexNoise} noise
 * @returns {number} ~[-1, 1] (typical magnitude ~0.3 for many octaves)
 */
export function fbm2D(noise, x, y, octaves, persistence = 0.5, lacunarity = 2) {
  let sum = 0;
  let amp = 1;
  let freq = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise.noise2D(x * freq + OCT_OX[o % 10], y * freq + OCT_OY[o % 10]);
    norm += amp;
    amp *= persistence;
    freq *= lacunarity;
  }
  return sum / norm;
}

/** 3D fBm (see fbm2D). */
export function fbm3D(noise, x, y, z, octaves, persistence = 0.5, lacunarity = 2) {
  let sum = 0;
  let amp = 1;
  let freq = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise.noise3D(x * freq + OCT_OX[o % 10], y * freq + OCT_OY[o % 10], z * freq + OCT_OZ[o % 10]);
    norm += amp;
    amp *= persistence;
    freq *= lacunarity;
  }
  return sum / norm;
}

/**
 * Ridged multifractal 2D noise in [0, 1]: sharp crests where the base noise crosses zero
 * (mountain ridges). Each octave is weighted by the previous one so crests stay crisp.
 */
export function ridged2D(noise, x, y, octaves, persistence = 0.5, lacunarity = 2) {
  let sum = 0;
  let amp = 1;
  let freq = 1;
  let norm = 0;
  let weight = 1;
  for (let o = 0; o < octaves; o++) {
    let n = 1 - Math.abs(noise.noise2D(x * freq + OCT_OX[o % 10], y * freq + OCT_OY[o % 10]));
    n *= n;
    n *= weight;
    weight = n * 1.5;
    if (weight > 1) weight = 1;
    sum += n * amp;
    norm += amp;
    amp *= persistence;
    freq *= lacunarity;
  }
  return sum / norm;
}
