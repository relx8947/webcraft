import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRegion, computeLight, extractChunkLight, regionMaxY, centerMaxY } from '../src/world/lighting.js';
import { BLOCK, IS_OPAQUE, LIGHT_EMISSION, LIGHT_FILTER } from '../src/world/registry.js';
import { REGION_VOLUME, CHUNK_VOLUME, regionIndex, blockIndex } from '../src/config.js';

// ---- helpers -------------------------------------------------------------------------------
const emptyChunks = () => Array.from({ length: 9 }, () => new Uint8Array(CHUNK_VOLUME));

/** Set a block in region coordinates (x, z in [-16, 32)). */
function put(chunks, x, y, z, id) {
  const n = ((z >> 4) + 1) * 3 + ((x >> 4) + 1);
  chunks[n][blockIndex(x & 15, y, z & 15)] = id;
}
function fill(chunks, x0, y0, z0, x1, y1, z1, id) {
  for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) put(chunks, x, y, z, id);
}
const ALL = [-16, 31];
function floor(chunks, yTop, id = BLOCK.STONE) {
  fill(chunks, ALL[0], 0, ALL[0], ALL[1], yTop, ALL[1], id);
}
function light(chunks) {
  const region = buildRegion(chunks);
  return { region, light: computeLight(region) };
}
const sky = (l, x, y, z) => l[regionIndex(x, y, z)] >> 4;
const blk = (l, x, y, z) => l[regionIndex(x, y, z)] & 15;

/**
 * Brute-force reference: classic max-over-paths fixpoint by repeated relaxation (Bellman-Ford
 * sweeps), straight from the SPEC §6 rules. Only y <= yLimit is relaxed; above it the caller
 * guarantees open air with no reachable block light.
 */
function referenceLight(region, yLimit) {
  const sk = new Int8Array(REGION_VOLUME);
  const bl = new Int8Array(REGION_VOLUME);
  for (let c = 0; c < 2304; c++) {
    let level = 15;
    for (let y = 255; y >= 0; y--) {
      const i = y * 2304 + c;
      const id = region[i];
      if (IS_OPAQUE[id]) break;
      level -= LIGHT_FILTER[id];
      if (level <= 0) break;
      sk[i] = level;
    }
  }
  for (let i = 0; i < REGION_VOLUME; i++) {
    const id = region[i];
    if (LIGHT_EMISSION[id] && !IS_OPAQUE[id]) bl[i] = LIGHT_EMISSION[id];
  }
  const N = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  let changed = true;
  while (changed) {
    changed = false;
    for (let y = 0; y <= yLimit; y++) {
      for (let z = 0; z < 48; z++) {
        for (let x = 0; x < 48; x++) {
          const i = (y * 48 + z) * 48 + x;
          const id = region[i];
          if (IS_OPAQUE[id]) continue;
          const f = LIGHT_FILTER[id];
          let s = sk[i], b = bl[i];
          for (const [dx, dy, dz] of N) {
            const nx = x + dx, ny = y + dy, nz = z + dz;
            if (nx < 0 || nx >= 48 || nz < 0 || nz >= 48 || ny < 0 || ny > 255) continue;
            const j = (ny * 48 + nz) * 48 + nx;
            const nid = region[j];
            const ls = IS_OPAQUE[nid] ? 0 : sk[j];
            const lb = IS_OPAQUE[nid] ? LIGHT_EMISSION[nid] : bl[j];   // opaque emitters still light neighbours
            if (ls - 1 - f > s) s = ls - 1 - f;
            if (lb - 1 - f > b) b = lb - 1 - f;
          }
          if (s !== sk[i] || b !== bl[i]) { sk[i] = s; bl[i] = b; changed = true; }
        }
      }
    }
  }
  const out = new Uint8Array(REGION_VOLUME);
  for (let i = 0; i < REGION_VOLUME; i++) out[i] = (sk[i] << 4) | bl[i];
  return out;
}

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- region ----------------------------------------------------------------------------------
test('buildRegion copies all 9 chunks to the documented layout', () => {
  const chunks = emptyChunks();
  for (let n = 0; n < 9; n++) {
    const c = chunks[n];
    c[blockIndex(0, 0, 0)] = 1 + n;
    c[blockIndex(15, 255, 15)] = 20 + n;
    c[blockIndex(3, 77, 9)] = 40 + n;
  }
  const region = buildRegion(chunks);
  assert.equal(region.length, REGION_VOLUME);
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const n = (dz + 1) * 3 + (dx + 1);
      assert.equal(region[regionIndex(dx * 16, 0, dz * 16)], 1 + n);
      assert.equal(region[regionIndex(dx * 16 + 15, 255, dz * 16 + 15)], 20 + n);
      assert.equal(region[regionIndex(dx * 16 + 3, 77, dz * 16 + 9)], 40 + n);
    }
  }
  let nonZero = 0;
  for (let i = 0; i < REGION_VOLUME; i++) if (region[i]) nonZero++;
  assert.equal(nonZero, 27);
});

test('buildRegion: missing chunks are air, reused buffers are fully overwritten, unaligned input works', () => {
  const chunks = emptyChunks();
  fill(chunks, -16, 0, -16, 31, 3, 31, BLOCK.STONE);
  const out = buildRegion(chunks);
  const sparse = [null, undefined, null, null, chunks[4], null, null, null, null];
  buildRegion(sparse, out);
  assert.equal(out[regionIndex(-16, 0, -16)], 0);
  assert.equal(out[regionIndex(31, 3, 31)], 0);
  assert.equal(out[regionIndex(0, 0, 0)], BLOCK.STONE);
  assert.equal(out[regionIndex(15, 3, 15)], BLOCK.STONE);
  // An unaligned view (byteOffset 1) must give the same result as the aligned fast path.
  const backing = new Uint8Array(CHUNK_VOLUME + 1);
  const unaligned = backing.subarray(1);
  unaligned.set(chunks[4]);
  const r2 = buildRegion([null, null, null, null, unaligned, null, null, null, null]);
  assert.deepEqual(r2, out);
  assert.throws(() => buildRegion(chunks, new Uint8Array(10)), RangeError);
});

test('regionMaxY / centerMaxY', () => {
  const chunks = emptyChunks();
  assert.equal(regionMaxY(buildRegion(chunks)), -1);
  put(chunks, -16, 90, 31, BLOCK.STONE);
  put(chunks, 5, 70, 5, BLOCK.STONE);
  const region = buildRegion(chunks);
  assert.equal(regionMaxY(region), 90);
  assert.equal(centerMaxY(region), 70);
});

test('extractChunkLight returns the centre chunk in chunk layout', () => {
  const l = new Uint8Array(REGION_VOLUME);
  for (let y = 0; y < 256; y += 17) for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) l[regionIndex(x, y, z)] = (x * 7 + z * 3 + y) & 255;
  l[regionIndex(-1, 0, 0)] = 99;   // outside the centre: must not leak
  const c = extractChunkLight(l);
  assert.equal(c.length, CHUNK_VOLUME);
  for (let y = 0; y < 256; y += 17) for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) assert.equal(c[blockIndex(x, y, z)], (x * 7 + z * 3 + y) & 255);
  assert.equal(c[blockIndex(0, 1, 0)], 0);
});

// ---- canonical light setups ---------------------------------------------------------------
test('open sky: 15 above the ground, 0 in opaque blocks, no block light', () => {
  const chunks = emptyChunks();
  floor(chunks, 9);
  const { light: l } = light(chunks);
  for (const [x, z] of [[0, 0], [15, 15], [-16, -16], [31, 31], [7, 20]]) {
    for (let y = 10; y < 256; y += 7) assert.equal(l[regionIndex(x, y, z)], 0xf0, `(${x},${y},${z})`);
    assert.equal(l[regionIndex(x, 9, z)], 0);
    assert.equal(l[regionIndex(x, 0, z)], 0);
  }
});

test('all-air region is fully sky lit', () => {
  const l = computeLight(buildRegion(emptyChunks()));
  for (let i = 0; i < REGION_VOLUME; i += 997) assert.equal(l[i], 0xf0);
});

test('sealed cave with a torch: 14 at the torch, -1 per step (Manhattan), no sky light', () => {
  const chunks = emptyChunks();
  floor(chunks, 60);
  fill(chunks, 0, 20, 0, 14, 34, 14, BLOCK.AIR);   // 15^3 room centred on (7, 27, 7)
  put(chunks, 7, 27, 7, BLOCK.TORCH);
  const { light: l } = light(chunks);
  for (let y = 20; y <= 34; y++) {
    for (let z = 0; z <= 14; z++) {
      for (let x = 0; x <= 14; x++) {
        const d = Math.abs(x - 7) + Math.abs(y - 27) + Math.abs(z - 7);
        assert.equal(blk(l, x, y, z), Math.max(0, 14 - d), `(${x},${y},${z})`);
        assert.equal(sky(l, x, y, z), 0);
      }
    }
  }
  assert.equal(blk(l, 8, 27, 7), 13);   // adjacent
  assert.equal(l[regionIndex(15, 27, 7)], 0);   // the wall itself stays dark
});

test('overhang: sky light spreads sideways under a roof, -1 per block', () => {
  const chunks = emptyChunks();
  floor(chunks, 10);
  fill(chunks, -16, 14, -16, 7, 14, 31, BLOCK.STONE);   // roof over x < 8 (whole z range)
  const { light: l } = light(chunks);
  for (let x = -16; x <= 7; x++) {
    for (const y of [11, 12, 13]) {
      assert.equal(sky(l, x, y, 5), Math.max(0, 15 - (8 - x)), `x=${x} y=${y}`);
    }
  }
  assert.equal(sky(l, 8, 11, 5), 15);
  assert.equal(sky(l, 0, 15, 5), 15);   // on top of the roof
});

test('water: -1 per water block downward, -2 per step horizontally', () => {
  const chunks = emptyChunks();
  floor(chunks, 40);
  fill(chunks, -16, 41, -16, 31, 62, 31, BLOCK.WATER);
  fill(chunks, -16, 63, -16, 7, 63, 31, BLOCK.STONE);   // roof over the water for x < 8
  const { light: l } = light(chunks);
  for (let y = 62; y >= 41; y--) assert.equal(sky(l, 20, y, 3), Math.max(0, 14 - (62 - y)), `open column y=${y}`);
  for (let k = 1; k <= 7; k++) assert.equal(sky(l, 8 - k, 62, 3), Math.max(0, 14 - 2 * k), `under roof k=${k}`);
  assert.equal(sky(l, 7, 61, 3), 11);   // from (8,61)=13 sideways
  assert.equal(sky(l, 20, 63, 3), 15);
});

test('leaves filter light by 1 per block and are lit from the side', () => {
  const chunks = emptyChunks();
  floor(chunks, 9);
  fill(chunks, 0, 20, 0, 6, 22, 6, BLOCK.OAK_LEAVES);   // 7x7x3 canopy
  put(chunks, 20, 30, 20, BLOCK.OAK_LEAVES);           // single floating leaf
  const { light: l } = light(chunks);
  assert.equal(sky(l, 3, 22, 3), 14);   // top layer
  assert.equal(sky(l, 3, 21, 3), 13);
  assert.equal(sky(l, 3, 20, 3), 12);   // bottom layer, centre: direct beats sideways (15-1-... )
  assert.equal(sky(l, 0, 20, 3), 13);   // bottom layer edge: lit from the open side (15 - 1 - 1)
  assert.equal(sky(l, 3, 15, 3), 12);   // shade under the canopy (direct 12, side 15-4 = 11)
  assert.equal(sky(l, 0, 15, 3), 14);   // under the edge: from the open neighbour column
  assert.equal(sky(l, 20, 29, 20), 14); // directly under a single leaf
  assert.equal(sky(l, 20, 30, 20), 14);
});

test('light crosses chunk borders through the region', () => {
  const chunks = emptyChunks();
  floor(chunks, 60);
  fill(chunks, -8, 30, 2, 8, 32, 4, BLOCK.AIR);        // tunnel crossing x = 0
  put(chunks, -3, 31, 3, BLOCK.TORCH);                  // torch in the west neighbour chunk
  fill(chunks, 12, 30, 2, 20, 32, 4, BLOCK.AIR);        // second tunnel crossing x = 16
  put(chunks, 19, 31, 3, BLOCK.LAVA);                   // lava in the east neighbour chunk
  const { light: l } = light(chunks);
  assert.equal(blk(l, -3, 31, 3), 14);
  assert.equal(blk(l, 0, 31, 3), 11);
  assert.equal(blk(l, 5, 31, 3), 6);
  assert.equal(blk(l, 15, 31, 3), 11);    // 4 steps from the lava (15 - 4)
  const c = extractChunkLight(l);
  assert.equal(c[blockIndex(0, 31, 3)] & 15, 11);
  assert.equal(c[blockIndex(15, 31, 3)] & 15, 11);
});

test('sky light crosses chunk borders (overhang owned by the neighbour chunk)', () => {
  const chunks = emptyChunks();
  floor(chunks, 10);
  fill(chunks, -16, 14, -16, 31, 14, 31, BLOCK.STONE);   // roof everywhere ...
  fill(chunks, -6, 14, 4, -6, 14, 4, BLOCK.AIR);         // ... with a skylight in the west neighbour
  const { light: l } = light(chunks);
  assert.equal(sky(l, -6, 13, 4), 15);
  assert.equal(sky(l, -6, 11, 4), 15);
  assert.equal(sky(l, 0, 11, 4), 9);
  assert.equal(sky(l, 3, 12, 6), 4);
});

test('emissive opaque blocks stay dark but light their neighbours', () => {
  const chunks = emptyChunks();
  floor(chunks, 60);
  fill(chunks, 0, 20, 0, 12, 30, 12, BLOCK.AIR);
  put(chunks, 6, 25, 6, BLOCK.GLOWSTONE);
  put(chunks, 2, 21, 2, BLOCK.JACK_O_LANTERN);
  const { light: l } = light(chunks);
  assert.equal(l[regionIndex(6, 25, 6)], 0);
  assert.equal(blk(l, 7, 25, 6), 14);
  assert.equal(blk(l, 6, 26, 6), 14);
  assert.equal(blk(l, 6, 25, 9), 12);
  assert.equal(l[regionIndex(2, 21, 2)], 0);
  assert.equal(blk(l, 2, 20, 2), 14);
});

test('lava is a non-opaque source of 15; brown mushrooms give 1', () => {
  const chunks = emptyChunks();
  floor(chunks, 60);
  fill(chunks, 0, 20, 0, 12, 30, 12, BLOCK.AIR);
  put(chunks, 6, 20, 6, BLOCK.LAVA);
  put(chunks, 0, 30, 12, BLOCK.BROWN_MUSHROOM);
  const { light: l } = light(chunks);
  assert.equal(blk(l, 6, 20, 6), 15);
  assert.equal(blk(l, 6, 21, 6), 14);
  assert.equal(blk(l, 0, 30, 12), 1);
});

test('block light rises above the highest block', () => {
  const chunks = emptyChunks();
  floor(chunks, 9);
  fill(chunks, 4, 10, 4, 4, 119, 4, BLOCK.STONE);
  put(chunks, 4, 120, 4, BLOCK.TORCH);                 // highest block of the region
  const { light: l } = light(chunks);
  assert.equal(l[regionIndex(4, 120, 4)], 0xf0 | 14);
  assert.equal(blk(l, 4, 121, 4), 13);
  assert.equal(blk(l, 4, 133, 4), 1);
  assert.equal(blk(l, 4, 134, 4), 0);
  assert.equal(sky(l, 4, 200, 4), 15);
});

test('computeLight reuses its output buffer without stale data', () => {
  const a = emptyChunks();
  floor(a, 60);
  fill(a, 0, 20, 0, 12, 30, 12, BLOCK.AIR);
  put(a, 6, 25, 6, BLOCK.TORCH);
  const b = emptyChunks();
  floor(b, 5);
  const out = computeLight(buildRegion(a));
  computeLight(buildRegion(b), out);
  assert.deepEqual(out, computeLight(buildRegion(b)));
});

test('exact versus a brute-force max-over-paths reference on random regions', () => {
  const palettes = [
    // [probability, id] cumulative tables; content only below y = 24
    { stone: 0.42 }, { stone: 0.2 }, { stone: 0.6 },
  ];
  let seed = 1;
  for (const pal of palettes) {
    for (let rep = 0; rep < 2; rep++) {
      const rnd = mulberry32(seed++ * 7919);
      const chunks = emptyChunks();
      for (let y = 0; y < 24; y++) {
        for (let z = -16; z < 32; z++) {
          for (let x = -16; x < 32; x++) {
            const r = rnd();
            let id = BLOCK.AIR;
            if (r < pal.stone) id = BLOCK.STONE;
            else if (r < pal.stone + 0.25) id = BLOCK.AIR;
            else {
              const s = rnd();
              id = s < 0.3 ? BLOCK.WATER : s < 0.5 ? BLOCK.OAK_LEAVES : s < 0.6 ? BLOCK.GLASS : s < 0.7 ? BLOCK.ICE
                : s < 0.76 ? BLOCK.TORCH : s < 0.8 ? BLOCK.GLOWSTONE : s < 0.83 ? BLOCK.LAVA : s < 0.86 ? BLOCK.SHORT_GRASS : BLOCK.AIR;
            }
            put(chunks, x, y, z, id);
          }
        }
      }
      // A few stone roofs to force long sideways sky paths.
      for (let k = 0; k < 6; k++) {
        const x0 = -16 + Math.floor(rnd() * 40), z0 = -16 + Math.floor(rnd() * 40), y0 = 12 + Math.floor(rnd() * 11);
        fill(chunks, x0, y0, z0, Math.min(31, x0 + 12), y0, Math.min(31, z0 + 12), BLOCK.STONE);
      }
      const region = buildRegion(chunks);
      const got = computeLight(region);
      const want = referenceLight(region, 40);
      let mismatches = 0, first = null;
      for (let i = 0; i < REGION_VOLUME; i++) {
        if (got[i] !== want[i]) {
          mismatches++;
          if (!first) {
            const x = (i % 48) - 16, z = (((i / 48) | 0) % 48) - 16, y = (i / 2304) | 0;
            first = `(${x},${y},${z}) got ${got[i].toString(16)} want ${want[i].toString(16)}`;
          }
        }
      }
      assert.equal(mismatches, 0, `palette ${JSON.stringify(pal)} rep ${rep}: ${mismatches} mismatches, first ${first}`);
    }
  }
});
