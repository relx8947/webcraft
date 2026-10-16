// Mob AI helpers (docs/SPEC-wave2.md §3.2): an allocation-free A* path finder on the block grid (Minecraft
// WalkNodeEvaluator rules, simplified), line of sight, light / brightness at a position and random walk
// targets (Minecraft DefaultRandomPos with PathfinderMob.getWalkTargetValue). Pure logic (runs in Node);
// the world is only accessed through getBlock / getLight / isChunkMeshed.
import { getCollisionBox, LIQUID_KIND, IS_OPAQUE, BLOCK, BLOCKS } from '../world/registry.js';
import { skyLightLevelAt } from '../config.js';

// Blocks a mob never paths through or onto (Minecraft BlockPathTypes DAMAGE_OTHER / DANGER_*): cactus.
const DANGER = new Uint8Array(256);
for (const b of BLOCKS) if (b && b.damage > 0 && !b.liquid) DANGER[b.id] = 1;

/** True if the cell can be occupied by a body (no collision box, not lava, not a damaging block). */
export function passable(world, x, y, z) {
  if (y < 0) return false;
  if (y > 255) return true;
  const id = world.getBlock(x, y, z);
  return getCollisionBox(id) === null && LIQUID_KIND[id] !== 2 && DANGER[id] === 0;
}

/** True if the cell's collision box can carry a mob (a solid top surface, not a damaging block). */
function solidGround(world, x, y, z) {
  if (y < 0 || y > 255) return false;
  const id = world.getBlock(x, y, z);
  const box = getCollisionBox(id);
  return box !== null && box[4] >= 0.5 && DANGER[id] === 0;
}

function isWaterCell(world, x, y, z) {
  return y >= 0 && y <= 255 && LIQUID_KIND[world.getBlock(x, y, z)] === 1;
}

function chunkReady(world, x, z) {
  if (typeof world.isChunkMeshed === 'function') return world.isChunkMeshed(x >> 4, z >> 4);
  return typeof world.isChunkGenerated !== 'function' || world.isChunkGenerated(x >> 4, z >> 4);
}

/**
 * True if a mob `cells` blocks tall can stand with its feet in cell (x, y, z): the body fits and there is
 * ground below (or the cell is water: swimming).
 */
export function standable(world, x, y, z, cells) {
  for (let k = 0; k < cells; k++) if (!passable(world, x, y + k, z)) return false;
  return solidGround(world, x, y - 1, z) || isWaterCell(world, x, y, z);
}

/**
 * Voxel line of sight between two points (Minecraft hasLineOfSight with ClipContext.Block.COLLIDER: blocks with
 * a collision box stop it; plants, torches and liquids do not). Allocation-free DDA, at most 96 cells.
 */
export function lineOfSight(world, ax, ay, az, bx, by, bz) {
  let dx = bx - ax, dy = by - ay, dz = bz - az;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (len < 1e-6) return true;
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
  for (let guard = 0; guard < 96; guard++) {
    if (y >= 0 && y <= 255) {
      const box = getCollisionBox(world.getBlock(x, y, z));
      if (box !== null) {
        // partial boxes (slabs, chests, cactus): only block when the segment passes through the box height
        if (box[4] >= 0.99 && box[1] <= 0.01) return false;
        const t0 = Math.min(tmx, tmy, tmz);
        const yAt = ay + dy * Math.min(len, t0);
        if (yAt >= y + box[1] && yAt <= y + box[4]) return false;
      }
    }
    if (x === ex && y === ey && z === ez) return true;
    if (tmx < tmy && tmx < tmz) {
      if (tmx > len) return true;
      x += stepX; tmx += tdx;
    } else if (tmy < tmz) {
      if (tmy > len) return true;
      y += stepY; tmy += tdy;
    } else {
      if (tmz > len) return true;
      z += stepZ; tmz += tdz;
    }
  }
  return true;
}

/**
 * Minecraft "raw brightness" at a cell: max(sky light - sky darkening, block light) for the time of day
 * (0..15); unknown light (chunk not meshed) counts as daylight sky.
 */
export function rawBrightness(world, timeOfDay, x, y, z) {
  if (typeof world.getLight !== 'function') return 15;
  const l = world.getLight(x, y, z);
  const packed = Number.isFinite(l) ? l & 255 : 0xf0;
  const sky = (packed >> 4) - (15 - skyLightLevelAt(timeOfDay));
  const blk = packed & 15;
  return Math.max(0, sky > blk ? sky : blk);
}

/** DimensionType.getBrightness for the overworld: level / 15 mapped by f / (4 - 3f) (0..1; 12 -> 0.5). */
export function brightnessOf(level) {
  const f = Math.min(15, Math.max(0, level)) / 15;
  return f / (4 - 3 * f);
}

// ===================================================================================================
// A* path finder
// ===================================================================================================

const DIRS_X = Int8Array.of(1, -1, 0, 0, 1, 1, -1, -1);
const DIRS_Z = Int8Array.of(0, 0, 1, -1, 1, -1, 1, -1);
const SQRT2 = Math.SQRT2;

/**
 * A* on the block grid for a mob `cells` blocks tall (Minecraft WalkNodeEvaluator, simplified): walk to the 8
 * neighbours at the same level (diagonals only without cutting corners), step up one block (a jump, needs
 * head room), drop down up to `maxDrop` blocks (any depth into water), swim through water (extra cost), never
 * through lava / cactus or into chunks that are not meshed. One shared instance; every call is bounded by
 * `maxNodes` expansions and allocation-free; when the goal is not reached the path leads to the node closest
 * to it (Minecraft's partial paths).
 */
export class PathFinder {
  constructor(capacity = 1024) {
    this.cap = capacity;
    this.nx = new Int32Array(capacity);
    this.ny = new Int32Array(capacity);
    this.nz = new Int32Array(capacity);
    this.g = new Float32Array(capacity);
    this.f = new Float32Array(capacity);
    this.parent = new Int32Array(capacity);
    this.closed = new Uint8Array(capacity);
    this.heap = new Int32Array(capacity);
    this.heapSize = 0;
    this.count = 0;
    this.tableSize = 1;
    while (this.tableSize < capacity * 2) this.tableSize <<= 1;
    this.table = new Int32Array(this.tableSize);
    this.stamp = new Int32Array(this.tableSize);
    this.epoch = 1;
    /** Nodes expanded by the last find() (statistics / budget accounting). */
    this.expanded = 0;
    /** True if the last find() reached the goal cell. */
    this.reached = false;
  }

  _key(x, y, z) {
    let h = Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791);
    h ^= h >>> 13;
    return h & (this.tableSize - 1);
  }

  /** Node index of a cell, creating it (g = Infinity) if new; -1 when the node store is full. */
  _node(x, y, z) {
    const mask = this.tableSize - 1;
    let h = this._key(x, y, z);
    for (let probe = 0; probe < this.tableSize; probe++) {
      if (this.stamp[h] !== this.epoch) {
        if (this.count >= this.cap) return -1;
        const n = this.count++;
        this.stamp[h] = this.epoch;
        this.table[h] = n;
        this.nx[n] = x; this.ny[n] = y; this.nz[n] = z;
        this.g[n] = Infinity;
        this.f[n] = Infinity;
        this.parent[n] = -1;
        this.closed[n] = 0;
        return n;
      }
      const n = this.table[h];
      if (this.nx[n] === x && this.ny[n] === y && this.nz[n] === z) return n;
      h = (h + 1) & mask;
    }
    return -1;
  }

  _push(n) {
    const heap = this.heap, f = this.f;
    let i = this.heapSize++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (f[heap[p]] <= f[n]) break;
      heap[i] = heap[p];
      i = p;
    }
    heap[i] = n;
  }

  _pop() {
    const heap = this.heap, f = this.f;
    const top = heap[0];
    const last = heap[--this.heapSize];
    let i = 0;
    const size = this.heapSize;
    while (true) {
      let c = i * 2 + 1;
      if (c >= size) break;
      if (c + 1 < size && f[heap[c + 1]] < f[heap[c]]) c++;
      if (f[heap[c]] >= f[last]) break;
      heap[i] = heap[c];
      i = c;
    }
    if (size > 0) heap[i] = last;
    return top;
  }

  /**
   * Path from the feet cell (sx, sy, sz) toward (tx, ty, tz). Waypoints (x, y, z triples, start excluded) are
   * written into `out` (Int32Array); returns the waypoint count (0 = no move possible / already there).
   * opts: cells (body height in blocks, default 2), maxNodes (expansion budget, default 400), maxDrop (3),
   * range (max horizontal distance of nodes from the start, default 32), avoidWater (extra cost, default 3).
   */
  find(world, sx, sy, sz, tx, ty, tz, out, cells = 2, maxNodes = 400, maxDrop = 3, range = 32, waterCost = 3) {
    this.epoch++;
    if (this.epoch > 0x7ffffff0) { this.epoch = 1; this.stamp.fill(0); }
    this.count = 0;
    this.heapSize = 0;
    this.expanded = 0;
    this.reached = false;
    const start = this._node(sx, sy, sz);
    if (start < 0) return 0;
    this.g[start] = 0;
    this.f[start] = this._h(sx, sy, sz, tx, ty, tz);
    this._push(start);
    let best = start, bestH = this.f[start];
    const budget = Math.min(maxNodes, this.cap);
    while (this.heapSize > 0 && this.expanded < budget) {
      const n = this._pop();
      if (this.closed[n]) continue;
      this.closed[n] = 1;
      this.expanded++;
      const x = this.nx[n], y = this.ny[n], z = this.nz[n];
      const hn = this._h(x, y, z, tx, ty, tz);
      if (hn < bestH) { bestH = hn; best = n; }
      if (x === tx && z === tz && Math.abs(y - ty) <= 1) {
        best = n;
        this.reached = true;
        break;
      }
      const inWater = isWaterCell(world, x, y, z);
      for (let d = 0; d < 8; d++) {
        const ddx = DIRS_X[d], ddz = DIRS_Z[d];
        const x2 = x + ddx, z2 = z + ddz;
        if (Math.abs(x2 - sx) > range || Math.abs(z2 - sz) > range) continue;
        if (!chunkReady(world, x2, z2)) continue;
        const diag = d >= 4;
        if (diag) {
          // no corner cutting: both orthogonal neighbours must be free for the whole body
          let ok = true;
          for (let k = 0; k < cells && ok; k++) {
            if (!passable(world, x2, y + k, z) || !passable(world, x, y + k, z2)) ok = false;
          }
          if (!ok) continue;
        }
        const step = diag ? SQRT2 : 1;
        // same level
        if (standable(world, x2, y, z2, cells)) {
          this._relax(n, x2, y, z2, step + (isWaterCell(world, x2, y, z2) ? waterCost : 0), tx, ty, tz);
          continue;
        }
        // one block up (a jump): needs head room above the current cell
        if (!diag && standable(world, x2, y + 1, z2, cells) && passable(world, x, y + cells, z)) {
          this._relax(n, x2, y + 1, z2, step + 1, tx, ty, tz);
          continue;
        }
        // walk off an edge: the body must fit in the neighbour column, then fall to the ground below
        let fits = true;
        for (let k = 0; k < cells && fits; k++) if (!passable(world, x2, y + k, z2)) fits = false;
        if (!fits) continue;
        for (let drop = 1; y - drop >= 1; drop++) {
          const yy = y - drop;
          if (!passable(world, x2, yy, z2)) break;
          if (isWaterCell(world, x2, yy, z2)) {
            this._relax(n, x2, yy, z2, step + drop * 0.5 + waterCost, tx, ty, tz);
            break;
          }
          if (solidGround(world, x2, yy - 1, z2)) {
            if (drop <= maxDrop) this._relax(n, x2, yy, z2, step + drop * 0.5, tx, ty, tz);
            break;
          }
          if (drop > maxDrop + 1 && !inWater) break;
        }
      }
      // swimming straight up toward the surface
      if (inWater && passable(world, x, y + cells, z)) this._relax(n, x, y + 1, z, 1 + waterCost * 0.5, tx, ty, tz);
    }
    // reconstruct start -> best; when it does not fit into `out`, keep the beginning of the path
    let total = 0;
    for (let q = best; q >= 0 && q !== start; q = this.parent[q]) total++;
    const len = Math.min(total, Math.floor(out.length / 3));
    let k = best;
    for (let skip = total - len; skip > 0; skip--) k = this.parent[k];
    for (let i = len - 1; i >= 0; i--) {
      out[i * 3] = this.nx[k]; out[i * 3 + 1] = this.ny[k]; out[i * 3 + 2] = this.nz[k];
      k = this.parent[k];
    }
    return len;
  }

  _h(x, y, z, tx, ty, tz) {
    const dx = Math.abs(x - tx), dz = Math.abs(z - tz);
    return Math.max(dx, dz) + (SQRT2 - 1) * Math.min(dx, dz) + Math.abs(y - ty);
  }

  _relax(from, x, y, z, cost, tx, ty, tz) {
    const n = this._node(x, y, z);
    if (n < 0 || this.closed[n]) return;
    const g = this.g[from] + cost;
    if (g >= this.g[n]) return;
    this.g[n] = g;
    this.f[n] = g + this._h(x, y, z, tx, ty, tz);
    this.parent[n] = from;
    if (this.heapSize < this.cap) this._push(n);
  }
}

/** The shared path finder (JavaScript is single-threaded; every call is independent). */
export const pathFinder = new PathFinder(1024);

// ===================================================================================================
// Random walk targets (DefaultRandomPos / LandRandomPos)
// ===================================================================================================

/**
 * Feet y of a standable cell in column (x, z) near y0 (searching down then up a few blocks), or -1.
 */
export function groundNear(world, x, y0, z, cells, down = 6, up = 3) {
  for (let dy = 0; dy <= down; dy++) {
    const y = y0 - dy;
    if (y < 1) break;
    if (standable(world, x, y, z, cells)) return y;
  }
  for (let dy = 1; dy <= up; dy++) {
    const y = y0 + dy;
    if (y > 254) break;
    if (standable(world, x, y, z, cells)) return y;
  }
  return -1;
}

const _pos = new Int32Array(3);

/**
 * Minecraft DefaultRandomPos.getPos: the best of 10 random standable cells within `h` blocks horizontally and
 * `v` vertically (score: animals prefer grass, monsters prefer darkness; water is avoided unless `allowWater`);
 * `away` (optional [x, z]) only accepts cells moving away from that point (panic / flee). Result in `out`
 * ([x, y, z] feet cell); returns false when nothing suitable was found.
 */
export function randomWalkTarget(world, rnd, x, y, z, h, v, cells, animal, timeOfDay, out = _pos, allowWater = false, away = null) {
  let best = -Infinity, found = false;
  for (let i = 0; i < 10; i++) {
    const tx = x + Math.floor(rnd() * (2 * h + 1)) - h;
    const tz = z + Math.floor(rnd() * (2 * h + 1)) - h;
    const ty0 = y + Math.floor(rnd() * (2 * v + 1)) - v;
    if (away) {
      const ax = x - away[0], az = z - away[1];
      if ((tx - x) * ax + (tz - z) * az < 0) continue;
    }
    if (!chunkReady(world, tx, tz)) continue;
    const ty = groundNear(world, tx, ty0, tz, cells);
    if (ty < 0) continue;
    const water = isWaterCell(world, tx, ty, tz);
    if (water && !allowWater) continue;
    let score;
    if (animal) {
      score = world.getBlock(tx, ty - 1, tz) === BLOCK.GRASS_BLOCK ? 10 : brightnessOf(rawBrightness(world, timeOfDay, tx, ty, tz)) - 0.5;
    } else {
      score = 0.5 - brightnessOf(rawBrightness(world, timeOfDay, tx, ty, tz));
    }
    score += rnd() * 0.01;
    if (score > best) {
      best = score;
      out[0] = tx; out[1] = ty; out[2] = tz;
      found = true;
    }
  }
  return found;
}

/**
 * A nearby cell without direct sky light within 10 blocks (Minecraft FleeSunGoal.getHidePos), for burning
 * undead. Result in `out`; false when none was found.
 */
export function shadePosition(world, rnd, x, y, z, cells, out = _pos) {
  for (let i = 0; i < 10; i++) {
    const tx = x + Math.floor(rnd() * 20) - 10;
    const tz = z + Math.floor(rnd() * 20) - 10;
    if (!chunkReady(world, tx, tz)) continue;
    const ty = groundNear(world, tx, y + Math.floor(rnd() * 6) - 3, tz, cells);
    if (ty < 0) continue;
    const l = typeof world.getLight === 'function' ? world.getLight(tx, ty + cells - 1, tz) : 0xf0;
    if (((l & 255) >> 4) < 15 && !IS_OPAQUE[world.getBlock(tx, ty, tz)]) {
      out[0] = tx; out[1] = ty; out[2] = tz;
      return true;
    }
  }
  return false;
}
