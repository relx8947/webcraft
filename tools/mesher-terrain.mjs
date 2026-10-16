// Synthetic, deterministic terrain used by tools/mesher-bench.mjs and tools/mesher-preview.html.
// It is NOT the game's world generator (src/world/worldgen.js) — just realistic enough content to
// exercise and time the lighting + meshing code: noise hills and mountains, beaches, an ocean, a
// desert with cacti, snowy peaks with ice, spaghetti + cheese caves with lava below y = 11 and
// torches, ores, oak/birch/spruce trees crossing chunk borders, grass, flowers and sugar cane.
// Pure ES module (runs in Node and in the browser).

import { BLOCK } from '../src/world/registry.js';

const SEA = 62;

function hash3(seed, x, y, z) {
  let h = (seed ^ Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(z, 0x1b873593)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}
const rand3 = (seed, x, y, z) => hash3(seed, x, y, z) / 4294967296;

/** Gradient noise (Perlin style), 2D + 3D, seeded. */
class Noise {
  constructor(seed) {
    this.perm = new Uint8Array(512);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    let s = seed >>> 0;
    for (let i = 255; i > 0; i--) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      const j = s % (i + 1);
      const t = p[i]; p[i] = p[j]; p[j] = t;
    }
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
  }
  static fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }
  static grad2(h, x, y) {
    switch (h & 7) {
      case 0: return x + y; case 1: return x - y; case 2: return -x + y; case 3: return -x - y;
      case 4: return x; case 5: return -x; case 6: return y; default: return -y;
    }
  }
  static grad3(h, x, y, z) {
    const u = (h & 15) < 8 ? x : y;
    const v = (h & 15) < 4 ? y : ((h & 15) === 12 || (h & 15) === 14) ? x : z;
    return ((h & 1) ? -u : u) + ((h & 2) ? -v : v);
  }
  noise2(x, y) {
    const P = this.perm;
    const X = Math.floor(x), Y = Math.floor(y);
    x -= X; y -= Y;
    const xi = X & 255, yi = Y & 255;
    const u = Noise.fade(x), v = Noise.fade(y);
    const a = P[xi] + yi, b = P[xi + 1] + yi;
    const l1 = Noise.grad2(P[a], x, y) + u * (Noise.grad2(P[b], x - 1, y) - Noise.grad2(P[a], x, y));
    const l2 = Noise.grad2(P[a + 1], x, y - 1) + u * (Noise.grad2(P[b + 1], x - 1, y - 1) - Noise.grad2(P[a + 1], x, y - 1));
    return (l1 + v * (l2 - l1)) * 0.7;
  }
  noise3(x, y, z) {
    const P = this.perm;
    const X = Math.floor(x), Y = Math.floor(y), Z = Math.floor(z);
    x -= X; y -= Y; z -= Z;
    const xi = X & 255, yi = Y & 255, zi = Z & 255;
    const u = Noise.fade(x), v = Noise.fade(y), w = Noise.fade(z);
    const A = P[xi] + yi, AA = P[A] + zi, AB = P[A + 1] + zi;
    const B = P[xi + 1] + yi, BA = P[B] + zi, BB = P[B + 1] + zi;
    const g = Noise.grad3;
    const lerp = (t, a, b) => a + t * (b - a);
    return lerp(w,
      lerp(v, lerp(u, g(P[AA], x, y, z), g(P[BA], x - 1, y, z)), lerp(u, g(P[AB], x, y - 1, z), g(P[BB], x - 1, y - 1, z))),
      lerp(v, lerp(u, g(P[AA + 1], x, y, z - 1), g(P[BA + 1], x - 1, y, z - 1)),
        lerp(u, g(P[AB + 1], x, y - 1, z - 1), g(P[BB + 1], x - 1, y - 1, z - 1))));
  }
  fbm2(x, y, oct) {
    let s = 0, a = 1, f = 1, n = 0;
    for (let i = 0; i < oct; i++) { s += a * this.noise2(x * f, y * f); n += a; a *= 0.5; f *= 2; }
    return s / n;
  }
}

/**
 * Create a terrain source.
 * @param {number} seed
 * @returns {{ generateChunk(cx:number, cz:number): Uint8Array, getTints(cx:number, cz:number): {grass: Uint32Array, foliage: Uint32Array},
 *   heightAt(x:number, z:number): number, SEA: number }}
 */
export function createTerrain(seed = 12345) {
  const nH = new Noise(seed);
  const nM = new Noise(seed + 1);
  const nB = new Noise(seed + 2);
  const nC1 = new Noise(seed + 3);
  const nC2 = new Noise(seed + 4);
  const nC3 = new Noise(seed + 5);
  const nT = new Noise(seed + 6);

  // Biome value: < -0.25 desert, > 0.3 cold; temperature drives tints too.
  const temperature = (x, z) => nB.fbm2(x / 260, z / 260, 2) * 1.6;
  const nH2 = new Noise(seed + 7);
  const heightAt = (x, z) => {
    const continent = nH.fbm2(x / 520, z / 520, 3) * 2.4;                // < 0: ocean
    const hills = nH2.fbm2(x / 90, z / 90, 4) * 2.2;
    const ridge = Math.max(0, nM.fbm2(x / 230, z / 230, 4) * 2.6 - 0.3); // mountain ranges
    let h = 64 + continent * 22 + hills * 7 + ridge * ridge * 240;
    if (continent < -0.1) h -= (-0.1 - continent) * 18;
    return Math.max(4, Math.min(200, Math.floor(h)));
  };
  const caveAt = (x, y, z, surface) => {
    if (y < 3 || y > surface - 3) return false;
    const a = nC1.noise3(x / 38, y / 22, z / 38);
    const b = nC2.noise3(x / 38, y / 22, z / 38);
    if (a * a + b * b < 0.011) return true;                             // spaghetti tunnels
    return y < 54 && nC3.noise3(x / 30, y / 18, z / 30) > 0.33;          // cheese caverns
  };

  const treeKind = (x, z) => {
    const t = temperature(x, z);
    if (t > 0.3) return 'spruce';
    return nT.noise2(x / 60, z / 60) > 0.15 ? 'birch' : 'oak';
  };
  // Tree anchors: at most one per 5x5 cell, deterministic per cell so neighbour chunks agree.
  function treesNear(cx, cz) {
    const out = [];
    const x0 = cx * 16 - 6, x1 = cx * 16 + 22, z0 = cz * 16 - 6, z1 = cz * 16 + 22;
    for (let gx = Math.floor(x0 / 5); gx <= Math.floor(x1 / 5); gx++) {
      for (let gz = Math.floor(z0 / 5); gz <= Math.floor(z1 / 5); gz++) {
        const r = rand3(seed + 77, gx, 0, gz);
        const density = 0.25 + 0.5 * Math.max(0, nT.noise2(gx / 9, gz / 9));
        if (r > density) continue;
        const x = gx * 5 + (hash3(seed, gx, 1, gz) % 5);
        const z = gz * 5 + (hash3(seed, gx, 2, gz) % 5);
        const h = heightAt(x, z);
        if (h <= SEA || temperature(x, z) < -0.25 || h > 120) continue;
        out.push({ x, z, y: h + 1, kind: treeKind(x, z), r: hash3(seed, x, 3, z) });
      }
    }
    return out;
  }

  function generateChunk(cx, cz) {
    const c = new Uint8Array(65536);
    const ox = cx * 16, oz = cz * 16;
    const set = (x, y, z, id) => { if (y >= 0 && y < 256) c[(y << 8) | (z << 4) | x] = id; };
    const get = (x, y, z) => c[(y << 8) | (z << 4) | x];
    const heights = new Int32Array(256);
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        const wx = ox + x, wz = oz + z;
        const h = heightAt(wx, wz);
        heights[z * 16 + x] = h;
        const t = temperature(wx, wz);
        const desert = t < -0.25;
        const cold = t > 0.3;
        const beach = h <= SEA + 1 && h >= SEA - 3;
        for (let y = 0; y <= Math.max(h, SEA); y++) {
          let id;
          if (y === 0 || (y < 4 && rand3(seed, wx, y, wz) < 0.5)) id = BLOCK.BEDROCK;
          else if (y > h) id = y === SEA && cold ? BLOCK.ICE : BLOCK.WATER;
          else if (y === h) {
            if (desert || beach) id = BLOCK.SAND;
            else if (h > 120) id = BLOCK.SNOW_BLOCK;
            else if (h > 95) id = BLOCK.STONE;
            else if (h < SEA) id = h < SEA - 6 ? BLOCK.GRAVEL : BLOCK.DIRT;
            else id = cold ? BLOCK.SNOWY_GRASS_BLOCK : BLOCK.GRASS_BLOCK;
          } else if (y > h - 4) id = desert ? (y > h - 3 ? BLOCK.SAND : BLOCK.SANDSTONE) : beach ? BLOCK.SAND : h > 95 ? BLOCK.STONE : BLOCK.DIRT;
          else {
            const r = rand3(seed + 9, wx, y, wz);
            if (r < 0.012 && y < 128) id = BLOCK.COAL_ORE;
            else if (r < 0.018 && y < 64) id = BLOCK.IRON_ORE;
            else if (r < 0.0195 && y < 16) id = BLOCK.DIAMOND_ORE;
            else if (r < 0.03) id = BLOCK.ANDESITE;
            else id = BLOCK.STONE;
          }
          set(x, y, z, id);
        }
        // Caves (not under water / beaches so the sea never drains).
        if (h > SEA + 2) {
          for (let y = 3; y < h - 2; y++) {
            if (caveAt(wx, y, wz, h)) set(x, y, z, y < 11 ? BLOCK.LAVA : BLOCK.AIR);
          }
        }
      }
    }
    // Cave torches on floors, plants on the surface.
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        const wx = ox + x, wz = oz + z;
        const h = heights[z * 16 + x];
        for (let y = 12; y < h - 3; y++) {
          if (get(x, y, z) === BLOCK.AIR && get(x, y - 1, z) === BLOCK.STONE && rand3(seed + 5, wx, y, wz) < 0.012) set(x, y, z, BLOCK.TORCH);
        }
        if (h + 1 > 255) continue;
        const top = get(x, h, z);
        const r = rand3(seed + 11, wx, h, wz);
        if (top === BLOCK.GRASS_BLOCK) {
          if (r < 0.22) set(x, h + 1, z, BLOCK.SHORT_GRASS);
          else if (r < 0.25) set(x, h + 1, z, BLOCK.FERN);
          else if (r < 0.265) set(x, h + 1, z, [BLOCK.DANDELION, BLOCK.POPPY, BLOCK.CORNFLOWER, BLOCK.OXEYE_DAISY][hash3(seed, wx, 7, wz) & 3]);
          else if (r < 0.275 && h === SEA + 1) {
            for (let k = 1; k <= 1 + (hash3(seed, wx, 8, wz) % 3); k++) set(x, h + k, z, BLOCK.SUGAR_CANE);
          }
        } else if (top === BLOCK.SAND && h > SEA + 1) {
          if (r < 0.008 && x > 0 && x < 15 && z > 0 && z < 15) {
            for (let k = 1; k <= 1 + (hash3(seed, wx, 9, wz) % 3); k++) set(x, h + k, z, BLOCK.CACTUS);
          } else if (r < 0.015) set(x, h + 1, z, BLOCK.DEAD_BUSH);
        }
      }
    }
    // Trees (from this and neighbouring chunks).
    for (const t of treesNear(cx, cz)) {
      const height = t.kind === 'spruce' ? 6 + (t.r % 3) : t.kind === 'birch' ? 5 + (t.r % 2) : 4 + (t.r % 2);
      const log = t.kind === 'spruce' ? BLOCK.SPRUCE_LOG : t.kind === 'birch' ? BLOCK.BIRCH_LOG : BLOCK.OAK_LOG;
      const leaves = t.kind === 'spruce' ? BLOCK.SPRUCE_LEAVES : t.kind === 'birch' ? BLOCK.BIRCH_LEAVES : BLOCK.OAK_LEAVES;
      const lx = t.x - ox, lz = t.z - oz;
      const place = (dx, y, dz, id, onlyAir) => {
        const x = lx + dx, z = lz + dz;
        if (x < 0 || x > 15 || z < 0 || z > 15 || y < 0 || y > 255) return;
        const cur = get(x, y, z);
        if (onlyAir && cur !== BLOCK.AIR && cur !== BLOCK.SHORT_GRASS && cur !== BLOCK.FERN) return;
        set(x, y, z, id);
      };
      const topY = t.y + height - 1;
      if (t.kind === 'spruce') {
        let radius = 0;
        for (let y = topY + 1; y >= t.y + 2; y--) {
          const rr = radius;
          for (let dx = -rr; dx <= rr; dx++) {
            for (let dz = -rr; dz <= rr; dz++) {
              if (Math.abs(dx) + Math.abs(dz) > rr + (rr > 1 ? 1 : 0)) continue;
              place(dx, y, dz, leaves, true);
            }
          }
          radius = radius >= 2 ? (y % 2 ? 1 : 2) : radius + 1;
        }
      } else {
        for (let y = topY - 2; y <= topY + 1; y++) {
          const rr = y >= topY ? 1 : 2;
          for (let dx = -rr; dx <= rr; dx++) {
            for (let dz = -rr; dz <= rr; dz++) {
              const corner = Math.abs(dx) === rr && Math.abs(dz) === rr;
              if (corner && (y === topY + 1 || hash3(seed, t.x + dx, y, t.z + dz) & 1)) continue;
              place(dx, y, dz, leaves, true);
            }
          }
        }
      }
      for (let y = t.y; y <= topY; y++) place(0, y, 0, log, false);
      place(0, t.y - 1, 0, BLOCK.DIRT, false);
    }
    return c;
  }

  function getTints(cx, cz) {
    const grass = new Uint32Array(256);
    const foliage = new Uint32Array(256);
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        const t = Math.max(-1, Math.min(1, temperature(cx * 16 + x, cz * 16 + z)));
        // warm/dry -> olive, temperate -> vivid green, cold -> blue-green
        const k = (t + 1) / 2;
        const g = [Math.round(191 - 70 * k), Math.round(183 - 2 * k), Math.round(85 + 40 * k)];
        const f = [Math.round(174 - 80 * k), Math.round(164 + 4 * k), Math.round(42 + 60 * k)];
        grass[z * 16 + x] = g[0] | (g[1] << 8) | (g[2] << 16);
        foliage[z * 16 + x] = f[0] | (f[1] << 8) | (f[2] << 16);
      }
    }
    return { grass, foliage };
  }

  return { generateChunk, getTints, heightAt, SEA };
}

/**
 * The 9 chunks of the 3x3 neighbourhood of (cx, cz) in region order ((dz+1)*3 + (dx+1)).
 * @param {{generateChunk(cx:number, cz:number): Uint8Array}} terrain
 */
export function neighbourhood(terrain, cx, cz, cache = null) {
  const out = [];
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const key = `${cx + dx},${cz + dz}`;
      let c = cache ? cache.get(key) : null;
      if (!c) {
        c = terrain.generateChunk(cx + dx, cz + dz);
        if (cache) cache.set(key, c);
      }
      out.push(c);
    }
  }
  return out;
}
