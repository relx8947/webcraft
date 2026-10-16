// Region assembly + exact light computation for one mesh job (docs/SPEC.md §6).
// Pure module: runs in workers, on the main thread and under Node (no DOM access).
//
// A *region* is the 3x3-chunk neighbourhood of the chunk being meshed, copied into one
// 48x48x256 byte array: regionIndex(x, y, z) = (y*48 + (z+16))*48 + (x+16) for x,z in [-16, 32)
// (centre chunk = [0, 16)). X is the fastest axis, then Z, then Y, exactly like a chunk, so every
// 16-byte chunk row maps onto a 16-byte region row and the copy can be done 4 bytes at a time.
//
// Light is recomputed from scratch for the whole region on every job. That is exact for the centre
// chunk plus a one-block border (all the mesher ever reads): light loses at least one level per
// step, so nothing further than 15 blocks away can influence those cells, and the centre chunk is
// 16 blocks from every region edge.
//
// Packed light byte: (sky << 4) | block.
//
// Algorithm (classic max-over-paths definition, SPEC §6):
//  * sky, direct pass: per column top-down, level 15, `level -= LIGHT_FILTER` per non-opaque cell,
//    stop at the first opaque cell or level 0;
//  * sky, spread: only cells that can actually brighten a horizontal neighbour are seeded (the
//    candidates are found per column from the direct-pass "fully lit from here up" heights), then
//    propagated with `new = level - 1 - LIGHT_FILTER[neighbour]`;
//  * block light: every emitter is a source (opaque emitters keep 0 themselves but light their
//    neighbours), same propagation rule.
//  * Farmland (and any future non-opaque block that must block light) is light-blocking like an opaque
//    cell (Minecraft BlockFarmland has light opacity 255, so caves under fields stay dark), but its
//    stored light is the per-channel maximum of its 6 neighbours afterwards (Minecraft
//    useNeighborBrightness), so it renders lit and is a neutral smooth-lighting sample for the mesher.
// Propagation uses 16 level buckets (a monotone priority queue on preallocated Int32Arrays): all
// cells of level L are expanded before any cell of level L-1, and because the cost of entering a
// cell depends only on that cell, every cell is assigned its final value the first time it is
// improved — no cell is ever expanded twice (a plain FIFO BFS from mixed-level seeds can re-expand
// large areas). Cells that end at level 1 are never queued (they cannot light anything).

import { REGION_VOLUME, CHUNK_VOLUME } from '../config.js';
import { IS_OPAQUE, LIGHT_EMISSION, LIGHT_FILTER, RENDER_TYPE, RENDER } from './registry.js';

/** 1 = light cannot enter the cell: opaque blocks and farmland (non-opaque, Minecraft opacity 255). */
const BLOCKS_LIGHT = new Uint8Array(256);
/** Per-id flags for the emitter scan: 1 = light emitter, 2 = takes its neighbours' brightness. */
const SPECIAL = new Uint8Array(256);
for (let id = 0; id < 256; id++) {
  const nb = IS_OPAQUE[id] === 0 && RENDER_TYPE[id] === RENDER.FARMLAND;
  BLOCKS_LIGHT[id] = IS_OPAQUE[id] === 1 || nb ? 1 : 0;
  SPECIAL[id] = (LIGHT_EMISSION[id] > 0 ? 1 : 0) | (nb ? 2 : 0);
}

const RS = 48;                 // region extent along X and Z
const LAYER = RS * RS;         // cells per Y layer (2304)
const HEIGHT = 256;

// Packed queue entries: x | z << 6 | y << 12 (region-local coordinates, x,z in [0,48), y in [0,256)).
const EX = 1;
const EZ = 64;
const EY = 4096;

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

/** Uint32 view over a byte array when it is 4-byte aligned (fast row copies / emptiness scans). */
function u32View(a) {
  if ((a.byteOffset & 3) !== 0 || (a.length & 3) !== 0) return null;
  return new Uint32Array(a.buffer, a.byteOffset, a.length >> 2);
}

/**
 * Highest y (0..255) containing a non-air block anywhere in the region, or -1 if it is all air.
 * @param {Uint8Array} region 48x48x256 region (buildRegion layout)
 * @returns {number}
 */
export function regionMaxY(region) {
  const w = u32View(region);
  if (w) {
    for (let k = w.length - 1; k >= 0; k--) {
      if (w[k] !== 0) return ((k << 2) / LAYER) | 0;
    }
    return -1;
  }
  for (let i = region.length - 1; i >= 0; i--) {
    if (region[i] !== 0) return (i / LAYER) | 0;
  }
  return -1;
}

/**
 * Highest y containing a non-air block inside the CENTRE chunk of the region, or -1.
 * @param {Uint8Array} region
 * @returns {number}
 */
export function centerMaxY(region) {
  const w = u32View(region);
  for (let y = HEIGHT - 1; y >= 0; y--) {
    for (let z = 0; z < 16; z++) {
      const row = (y * RS + z + 16) * RS + 16;
      if (w) {
        const k = row >> 2;
        if ((w[k] | w[k + 1] | w[k + 2] | w[k + 3]) !== 0) return y;
      } else {
        for (let x = 0; x < 16; x++) if (region[row + x] !== 0) return y;
      }
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------------------------
// Region
// ---------------------------------------------------------------------------------------------

/**
 * Copy a 3x3 chunk neighbourhood into one region array.
 * @param {(Uint8Array|null|undefined)[]} chunks 9 chunk block arrays (Uint8Array(65536), chunk layout
 *   blockIndex = (y << 8) | (z << 4) | x), index (dz+1)*3 + (dx+1); centre = 4. Missing entries
 *   (null/undefined) are treated as all air.
 * @param {Uint8Array} [out] optional Uint8Array(REGION_VOLUME) to reuse
 * @returns {Uint8Array} the region (48*48*256 bytes)
 */
export function buildRegion(chunks, out) {
  if (!out) out = new Uint8Array(REGION_VOLUME);
  else if (out.length !== REGION_VOLUME) throw new RangeError(`region buffer must have ${REGION_VOLUME} bytes`);
  const dst32 = u32View(out);
  for (let n = 0; n < 9; n++) {
    const chunk = chunks ? chunks[n] : null;
    const ox = (n % 3) * 16;              // region-array x of the chunk's local x = 0
    const oz = ((n / 3) | 0) * 16;
    if (chunk && chunk.length !== CHUNK_VOLUME) {
      throw new RangeError(`chunk ${n} must have ${CHUNK_VOLUME} bytes (got ${chunk.length})`);
    }
    const src32 = chunk ? u32View(chunk) : null;
    if (dst32 && (src32 || !chunk)) {
      // 16-byte rows copied as 4 words. Region rows are 4-byte aligned (48 and 16 are multiples of 4).
      for (let y = 0; y < HEIGHT; y++) {
        let d = ((y * RS + oz) * RS + ox) >> 2;
        if (src32) {
          let s = y << 6;                 // ((y << 8) >> 2)
          for (let z = 0; z < 16; z++, s += 4, d += RS >> 2) {
            dst32[d] = src32[s];
            dst32[d + 1] = src32[s + 1];
            dst32[d + 2] = src32[s + 2];
            dst32[d + 3] = src32[s + 3];
          }
        } else {
          for (let z = 0; z < 16; z++, d += RS >> 2) {
            dst32[d] = 0; dst32[d + 1] = 0; dst32[d + 2] = 0; dst32[d + 3] = 0;
          }
        }
      }
    } else {
      for (let y = 0; y < HEIGHT; y++) {
        for (let z = 0; z < 16; z++) {
          const d = (y * RS + oz + z) * RS + ox;
          if (!chunk) {
            out.fill(0, d, d + 16);
          } else {
            const s = (y << 8) | (z << 4);
            for (let x = 0; x < 16; x++) out[d + x] = chunk[s + x];
          }
        }
      }
    }
  }
  return out;
}

/**
 * Copy the centre chunk's light out of a region light array into chunk layout.
 * @param {Uint8Array} regionLight result of computeLight()
 * @param {Uint8Array} [out] optional Uint8Array(65536)
 * @returns {Uint8Array} packed (sky << 4 | block) light, index (y << 8) | (z << 4) | x
 */
export function extractChunkLight(regionLight, out) {
  if (!out) out = new Uint8Array(CHUNK_VOLUME);
  else if (out.length !== CHUNK_VOLUME) throw new RangeError(`chunk light buffer must have ${CHUNK_VOLUME} bytes`);
  const s32 = u32View(regionLight);
  const d32 = u32View(out);
  for (let y = 0; y < HEIGHT; y++) {
    for (let z = 0; z < 16; z++) {
      const s = (y * RS + z + 16) * RS + 16;
      const d = (y << 8) | (z << 4);
      if (s32 && d32) {
        const a = s >> 2, b = d >> 2;
        d32[b] = s32[a]; d32[b + 1] = s32[a + 1]; d32[b + 2] = s32[a + 2]; d32[b + 3] = s32[a + 3];
      } else {
        for (let x = 0; x < 16; x++) out[d + x] = regionLight[s + x];
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Light
// ---------------------------------------------------------------------------------------------

// Grow-only bucket queues, shared between jobs (a worker runs one job at a time).
const buckets = [];
const bucketLen = new Int32Array(16);
for (let l = 0; l < 16; l++) buckets.push(new Int32Array(l >= 2 ? 4096 : 0));

// Per-column direct-pass results.
const colFloor = new Int16Array(LAYER);   // lowest directly sky-lit y of the column (maxY+1 if none)
const colTop15 = new Int16Array(LAYER);   // every cell at y >= colTop15 has sky 15 after the direct pass

// Cells of light-blocking non-opaque blocks (farmland) found by the emitter scan (grow-only).
let nbCells = new Int32Array(1024);
let nbCount = 0;

let L = null;   // light array being computed
let R = null;   // region being lit

function push(level, e) {
  let q = buckets[level];
  const n = bucketLen[level];
  if (n === q.length) {
    const g = new Int32Array(q.length * 2);
    g.set(q);
    buckets[level] = q = g;
  }
  q[n] = e;
  bucketLen[level] = n + 1;
}

/** Try to raise the sky light of cell j (packed coords ej) to `lim - filter(j)`. */
function relaxSky(j, ej, lim) {
  const id = R[j];
  if (BLOCKS_LIGHT[id] === 1) return;
  const v = lim - LIGHT_FILTER[id];
  const cur = L[j];
  if (v > (cur >> 4)) {
    L[j] = (cur & 15) | (v << 4);
    if (v >= 2) push(v, ej);
  }
}

/** Try to raise the block light of cell j (packed coords ej) to `lim - filter(j)`. */
function relaxBlock(j, ej, lim) {
  const id = R[j];
  if (BLOCKS_LIGHT[id] === 1) return;
  const v = lim - LIGHT_FILTER[id];
  const cur = L[j];
  if (v > (cur & 15)) {
    L[j] = (cur & 0xf0) | v;
    if (v >= 2) push(v, ej);
  }
}

/** True if a cell of level `lim + 1` can brighten its non-opaque neighbour j (sky channel). */
function skyImproves(j, lim) {
  const id = R[j];
  return BLOCKS_LIGHT[id] === 0 && (L[j] >> 4) < lim - LIGHT_FILTER[id];
}

/** Drain the buckets from level 15 down to 2 (sky: shift 4, block: shift 0). */
function propagate(sky) {
  for (let level = 15; level >= 2; level--) {
    const n = bucketLen[level];
    if (n === 0) continue;
    // Expanding level L only pushes into buckets < L, so this bucket is stable while we drain it.
    const q = buckets[level];
    const lim = level - 1;
    for (let k = 0; k < n; k++) {
      const e = q[k];
      const x = e & 63;
      const z = (e >> 6) & 63;
      const y = e >>> 12;
      const i = (y * RS + z) * RS + x;
      if (sky) {
        if ((L[i] >> 4) !== level) continue;   // stale entry (cell was improved after being queued)
        if (x > 0) relaxSky(i - 1, e - EX, lim);
        if (x < RS - 1) relaxSky(i + 1, e + EX, lim);
        if (z > 0) relaxSky(i - RS, e - EZ, lim);
        if (z < RS - 1) relaxSky(i + RS, e + EZ, lim);
        if (y > 0) relaxSky(i - LAYER, e - EY, lim);
        if (y < HEIGHT - 1) relaxSky(i + LAYER, e + EY, lim);
      } else {
        if ((L[i] & 15) !== level) continue;
        if (x > 0) relaxBlock(i - 1, e - EX, lim);
        if (x < RS - 1) relaxBlock(i + 1, e + EX, lim);
        if (z > 0) relaxBlock(i - RS, e - EZ, lim);
        if (z < RS - 1) relaxBlock(i + RS, e + EZ, lim);
        if (y > 0) relaxBlock(i - LAYER, e - EY, lim);
        if (y < HEIGHT - 1) relaxBlock(i + LAYER, e + EY, lim);
      }
    }
    bucketLen[level] = 0;
  }
}

/**
 * Compute sky + block light for a whole region from scratch.
 * @param {Uint8Array} region result of buildRegion()
 * @param {Uint8Array} [out] optional Uint8Array(REGION_VOLUME) to reuse
 * @returns {Uint8Array} packed light (sky << 4 | block), region layout
 */
export function computeLight(region, out) {
  if (!out) out = new Uint8Array(REGION_VOLUME);
  else if (out.length !== REGION_VOLUME) throw new RangeError(`light buffer must have ${REGION_VOLUME} bytes`);
  if (region.length !== REGION_VOLUME) throw new RangeError(`region must have ${REGION_VOLUME} bytes`);

  const maxY = regionMaxY(region);
  const litEnd = (maxY + 1) * LAYER;
  out.fill(0, 0, litEnd);
  out.fill(0xf0, litEnd);              // everything above the highest block: open sky, no block light (yet)
  if (maxY < 0) return out;

  R = region;
  L = out;
  try {
    // ---- sky light: direct pass -------------------------------------------------------------
    for (let c = 0; c < LAYER; c++) {
      let level = 15;
      let top = -1;
      let y = maxY;
      let i = maxY * LAYER + c;
      for (; y >= 0; y--, i -= LAYER) {
        const id = region[i];
        if (BLOCKS_LIGHT[id] === 1) break;
        const f = LIGHT_FILTER[id];
        if (f !== 0) {
          if (top < 0) top = y + 1;
          level -= f;
          if (level <= 0) break;
        }
        out[i] = level << 4;
      }
      colFloor[c] = y + 1;
      colTop15[c] = top < 0 ? y + 1 : top;
    }

    // ---- sky light: seeds ---------------------------------------------------------------------
    // Within a column the direct pass already satisfies the propagation rule vertically, so only
    // horizontal improvements are possible, and only below the highest colTop15 of the 4 neighbours
    // (above it every neighbour is already 15).
    for (let z = 0; z < RS; z++) {
      for (let x = 0; x < RS; x++) {
        const c = z * RS + x;
        let hi = 0;
        if (x > 0 && colTop15[c - 1] > hi) hi = colTop15[c - 1];
        if (x < RS - 1 && colTop15[c + 1] > hi) hi = colTop15[c + 1];
        if (z > 0 && colTop15[c - RS] > hi) hi = colTop15[c - RS];
        if (z < RS - 1 && colTop15[c + RS] > hi) hi = colTop15[c + RS];
        const yEnd = hi - 1 < maxY ? hi - 1 : maxY;
        for (let y = colFloor[c]; y <= yEnd; y++) {
          const i = y * LAYER + c;
          const level = out[i] >> 4;
          if (level < 2) continue;
          const lim = level - 1;
          if ((x > 0 && skyImproves(i - 1, lim)) ||
              (x < RS - 1 && skyImproves(i + 1, lim)) ||
              (z > 0 && skyImproves(i - RS, lim)) ||
              (z < RS - 1 && skyImproves(i + RS, lim))) {
            push(level, x | (z << 6) | (y << 12));
          }
        }
      }
    }
    propagate(true);

    // ---- block light --------------------------------------------------------------------------
    nbCount = 0;
    for (let i = 0; i < litEnd; i++) {
      const id = region[i];
      const sp = SPECIAL[id];
      if (sp === 0) continue;
      if ((sp & 2) !== 0) {
        if (nbCount === nbCells.length) {
          const g = new Int32Array(nbCells.length * 2);
          g.set(nbCells);
          nbCells = g;
        }
        nbCells[nbCount++] = i;
      }
      const em = LIGHT_EMISSION[id];
      if (em === 0) continue;
      const x = i % RS;
      const z = ((i / RS) | 0) % RS;
      const y = (i / LAYER) | 0;
      const e = x | (z << 6) | (y << 12);
      if (BLOCKS_LIGHT[id] === 1) {
        // Opaque emitters (glowstone, jack o'lantern) stay dark themselves but light their neighbours.
        const lim = em - 1;
        if (lim < 1) continue;
        if (x > 0) relaxBlock(i - 1, e - EX, lim);
        if (x < RS - 1) relaxBlock(i + 1, e + EX, lim);
        if (z > 0) relaxBlock(i - RS, e - EZ, lim);
        if (z < RS - 1) relaxBlock(i + RS, e + EZ, lim);
        if (y > 0) relaxBlock(i - LAYER, e - EY, lim);
        if (y < HEIGHT - 1) relaxBlock(i + LAYER, e + EY, lim);
      } else if (em > (out[i] & 15)) {
        out[i] = (out[i] & 0xf0) | em;
        if (em >= 2) push(em, e);
      }
    }
    propagate(false);

    // ---- light-blocking non-opaque cells take their neighbours' brightness ----------------------
    for (let k = 0; k < nbCount; k++) {
      const i = nbCells[k];
      const x = i % RS;
      const z = ((i / RS) | 0) % RS;
      const y = (i / LAYER) | 0;
      let s = 0, b = 0;
      for (let d = 0; d < 6; d++) {
        let j;
        if (d === 0) { if (x === 0) continue; j = i - 1; }
        else if (d === 1) { if (x === RS - 1) continue; j = i + 1; }
        else if (d === 2) { if (z === 0) continue; j = i - RS; }
        else if (d === 3) { if (z === RS - 1) continue; j = i + RS; }
        else if (d === 4) { if (y === 0) continue; j = i - LAYER; }
        else { if (y === HEIGHT - 1) continue; j = i + LAYER; }
        const l = out[j];
        if ((l >> 4) > s) s = l >> 4;
        if ((l & 15) > b) b = l & 15;
      }
      out[i] = (s << 4) | b;
    }
  } finally {
    for (let l = 0; l < 16; l++) bucketLen[l] = 0;
    R = null;
    L = null;
  }
  return out;
}
