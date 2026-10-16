// Chunk data holder + pure helpers used by the world manager (docs/SPEC.md §8, §9.6).
// Pure module (no DOM): the helpers are unit-tested under Node (tests/world.test.js).
//
// Contents
//   chunkKeyNum / keyCX / keyCZ     numeric chunk keys (fast Map keys, no string allocation)
//   computeHeightmap                highest non-air block per column
//   sectionMaskUpTo / editDirtyRange   which sections/chunks an edit can affect (SPEC §9.6)
//   rectDistance / chunkCenterDistance / classifyChunk   streaming geometry (load / mesh / keep sets)
//   circularOrder                   chunk offsets sorted nearest-first (loading order)
//   Chunk                           per-chunk state used by World

import { CHUNK_VOLUME } from '../config.js';

// ---------------------------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------------------------

const KEY_OFFSET = 0x2000000;   // 2^25: chunk coordinates in (-2^25, 2^25) (±536 million blocks)
const KEY_SCALE = 0x4000000;    // 2^26: key = (cx + off) * 2^26 + (cz + off) < 2^52 (exact double)

/**
 * Numeric chunk key (exact integer, usable as a Map key without allocating strings).
 * @param {number} cx @param {number} cz
 * @returns {number}
 */
export function chunkKeyNum(cx, cz) {
  return (cx + KEY_OFFSET) * KEY_SCALE + (cz + KEY_OFFSET);
}

/** Chunk x of a numeric key. */
export function keyCX(key) {
  return Math.floor(key / KEY_SCALE) - KEY_OFFSET;
}

/** Chunk z of a numeric key. */
export function keyCZ(key) {
  return (key % KEY_SCALE) - KEY_OFFSET;
}

// ---------------------------------------------------------------------------------------------
// Heightmap
// ---------------------------------------------------------------------------------------------

/**
 * Highest non-air block of every column (index z*16+x), -1 for empty columns.
 * Scans top-down and skips all-air rows four bytes at a time.
 * @param {Uint8Array} blocks chunk blocks (65536, index (y<<8)|(z<<4)|x)
 * @param {Int16Array} [out] Int16Array(256) to fill
 * @returns {number} the chunk's highest non-air y (-1 if the chunk is empty)
 */
export function computeHeightmap(blocks, out) {
  out.fill(-1);
  const w = (blocks.byteOffset & 3) === 0 && blocks.length === CHUNK_VOLUME
    ? new Uint32Array(blocks.buffer, blocks.byteOffset, CHUNK_VOLUME >> 2) : null;
  let remaining = 256;
  let maxY = -1;
  for (let y = 255; y >= 0 && remaining > 0; y--) {
    for (let z = 0; z < 16; z++) {
      const row = (y << 8) | (z << 4);
      if (w !== null) {
        const k = row >> 2;
        if ((w[k] | w[k + 1] | w[k + 2] | w[k + 3]) === 0) continue;
      }
      for (let x = 0; x < 16; x++) {
        const c = (z << 4) | x;
        if (out[c] < 0 && blocks[row | x] !== 0) {
          out[c] = y;
          remaining--;
          if (y > maxY) maxY = y;
        }
      }
    }
  }
  return maxY;
}

// ---------------------------------------------------------------------------------------------
// Edits: which sections / chunks must be remeshed (SPEC §9.6)
// ---------------------------------------------------------------------------------------------

/** Bit mask of sections 0..sy (inclusive); sy is clamped to [-1, 15]. */
export function sectionMaskUpTo(sy) {
  if (sy < 0) return 0;
  if (sy >= 15) return 0xffff;
  return (1 << (sy + 1)) - 1;
}

/**
 * Region affected by changing the block at (x, y, z):
 *   * light: every chunk whose XZ range intersects [x-15, x+15] x [z-15, z+15], sections 0 up to
 *     (y+15) >> 4 (sky light can change all the way down the column, light spreads <= 14 blocks, +1 for
 *     smooth-lighting samples);
 *   * geometry / AO: chunks containing any block of the 3x3x3 cube around the edit (faces, AO, liquid
 *     surfaces and plant joints of those blocks can change) — remeshed with top priority.
 * @returns {{ cx0: number, cx1: number, cz0: number, cz1: number, mask: number,
 *   gx0: number, gx1: number, gz0: number, gz1: number }}
 */
export function editDirtyRange(x, y, z, out = {}) {
  out.cx0 = (x - 15) >> 4;
  out.cx1 = (x + 15) >> 4;
  out.cz0 = (z - 15) >> 4;
  out.cz1 = (z + 15) >> 4;
  out.mask = sectionMaskUpTo((y + 15) >> 4);
  out.gx0 = (x - 1) >> 4;
  out.gx1 = (x + 1) >> 4;
  out.gz0 = (z - 1) >> 4;
  out.gz1 = (z + 1) >> 4;
  return out;
}

// ---------------------------------------------------------------------------------------------
// Streaming geometry
// ---------------------------------------------------------------------------------------------

/**
 * Euclidean distance from point (px, pz) to the axis-aligned rectangle [x0, x1] x [z0, z1].
 */
export function rectDistance(px, pz, x0, z0, x1, z1) {
  const dx = px < x0 ? x0 - px : px > x1 ? px - x1 : 0;
  const dz = pz < z0 ? z0 - pz : pz > z1 ? pz - z1 : 0;
  return Math.sqrt(dx * dx + dz * dz);
}

/** Distance (in chunks) from the player position (blocks) to the centre of chunk (cx, cz). */
export function chunkCenterDistance(px, pz, cx, cz) {
  const dx = cx + 0.5 - px / 16;
  const dz = cz + 0.5 - pz / 16;
  return Math.sqrt(dx * dx + dz * dz);
}

/** Membership flags returned by classifyChunk. */
export const SET_MESH = 1;   // inside render distance: must be meshed
export const SET_GEN = 2;    // neighbour of a mesh chunk (or a mesh chunk): must be generated
export const SET_KEEP = 4;   // within one more chunk ring: stays loaded if already loaded (hysteresis)

/**
 * Classify a chunk relative to the player for render distance `rd` (chunks).
 *   mesh: the chunk intersects the circle of radius 16*rd blocks around the player (everything the
 *         renderer can show before its fog ends at 0.95*16*rd);
 *   gen:  some chunk of its 3x3 neighbourhood is a mesh chunk (meshing needs all 8 neighbours);
 *   keep: some chunk within Chebyshev distance 2 is a mesh chunk (unloaded otherwise ~ "beyond rd+2").
 * @returns {number} bit set of SET_MESH | SET_GEN | SET_KEEP (0 = unload)
 */
export function classifyChunk(px, pz, cx, cz, rd) {
  const R = rd * 16;
  const x0 = cx * 16;
  const z0 = cz * 16;
  if (rectDistance(px, pz, x0 - 32, z0 - 32, x0 + 48, z0 + 48) >= R) return 0;
  let flags = SET_KEEP;
  if (rectDistance(px, pz, x0 - 16, z0 - 16, x0 + 32, z0 + 32) < R) {
    flags |= SET_GEN;
    if (rectDistance(px, pz, x0, z0, x0 + 16, z0 + 16) < R) flags |= SET_MESH;
  }
  return flags;
}

/**
 * Chunk offsets (dx, dz) with dx² + dz² <= radius², sorted nearest first (ties: angle), as a flat
 * Int32Array [dx0, dz0, dx1, dz1, ...]. Used for "circular loading order" style iteration.
 * @param {number} radius in chunks
 * @returns {Int32Array}
 */
export function circularOrder(radius) {
  const r = Math.max(0, Math.floor(radius));
  const list = [];
  for (let dz = -r; dz <= r; dz++) {
    for (let dx = -r; dx <= r; dx++) {
      const d2 = dx * dx + dz * dz;
      if (d2 <= radius * radius) list.push([dx, dz, d2, Math.atan2(dz, dx)]);
    }
  }
  list.sort((a, b) => a[2] - b[2] || a[3] - b[3]);
  const out = new Int32Array(list.length * 2);
  list.forEach((e, i) => { out[i * 2] = e[0]; out[i * 2 + 1] = e[1]; });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Chunk
// ---------------------------------------------------------------------------------------------

/** Chunk lifecycle states. */
export const ChunkState = Object.freeze({
  NEW: 0,          // wanted, nothing requested yet
  LOADING: 1,      // reading from storage
  GENERATING: 2,   // generation job queued / running
  READY: 3,        // blocks available
  UNLOADED: 4,     // removed from the world (stale references see this)
});

/**
 * State of one 16x256x16 chunk. Owned and mutated by World; the fields are documented here.
 */
export class Chunk {
  constructor(cx, cz) {
    this.cx = cx;
    this.cz = cz;
    this.key = chunkKeyNum(cx, cz);
    this.id = cx + ',' + cz;                  // storage key
    this.uid = 0;                             // unique per Chunk object (set by World; tags jobs)
    this.state = ChunkState.NEW;
    /** @type {Uint8Array|null} block ids, index (y<<8)|(z<<4)|x */
    this.blocks = null;
    /** @type {Uint8Array|null} packed light (sky<<4|block) of the newest mesh job, chunk layout */
    this.light = null;
    this.lightSeq = -1;
    this.heightmap = new Int16Array(256).fill(-1);
    this.maxY = -1;                           // highest non-air block (-1 = empty)

    // persistence
    this.modified = false;                    // changed since loaded / last saved
    this.editCount = 0;                       // increments on every block change
    this.fromStorage = false;

    // streaming
    this.flags = 0;                           // SET_* membership (classifyChunk)
    this.dist = 0;                            // centre distance to the player in chunks
    this.readyNeighbours = 0;                 // READY chunks among the 8 neighbours
    this.loadAttempts = 0;
    this.genAttempts = 0;

    // meshing
    this.dirtyMask = 0xffff;                  // sections needing a (re)mesh, not yet submitted
    this.urgent = false;                      // geometry changed near an edit: remesh with top priority
    this.meshSubmitted = false;               // at least one mesh job submitted
    this.meshJobs = 0;                        // mesh jobs queued or running
    this.meshAttempts = 0;                    // consecutive failed mesh jobs
    this.sectionSeq = new Float64Array(16).fill(-1);   // edit seq of the newest applied/pending section mesh
    this.sectionHash = new Float64Array(16);  // hash of the mesh the renderer holds (0 = empty)
    this.hashKnown = 0xffff;                  // bit sy: sectionHash[sy] matches the renderer's state
    this.uploadedMask = 0;                    // sections uploaded at least once since load
    this.meshedOnce = false;                  // every section uploaded at least once (isChunkMeshed)
    /** @type {Array<object|null>} section results waiting for upload */
    this.pending = new Array(16).fill(null);
    this.pendingMask = 0;
    this.inUploadList = false;
    this.uploadUrgent = false;
  }

  /** Install block data (generated / loaded) and compute the heightmap. */
  setBlocks(blocks) {
    this.blocks = blocks;
    this.maxY = computeHeightmap(blocks, this.heightmap);
  }

  /** Recompute maxY from the heightmap (after the top block was removed). */
  refreshMaxY() {
    const hm = this.heightmap;
    let m = -1;
    for (let i = 0; i < 256; i++) if (hm[i] > m) m = hm[i];
    this.maxY = m;
  }

  /**
   * Update the heightmap after the block at local (lx, y, lz) changed to `id`.
   * Call after writing the block.
   */
  updateHeight(lx, y, lz, id) {
    const c = (lz << 4) | lx;
    const hm = this.heightmap;
    if (id !== 0) {
      if (y > hm[c]) {
        hm[c] = y;
        if (y > this.maxY) this.maxY = y;
      }
    } else if (y === hm[c]) {
      const b = this.blocks;
      let yy = y - 1;
      while (yy >= 0 && b[(yy << 8) | c] === 0) yy--;
      hm[c] = yy;
      if (y === this.maxY) this.refreshMaxY();
    }
  }
}
