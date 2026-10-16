// Voxel physics shared by the player, mobs and item entities (pure: runs in Node for tests).
// `world` only needs getBlock(x, y, z) -> block id (integers; AIR for unloaded / out of range).
import { getCollisionBox, getSelectionBox, IS_LIQUID, LIQUID_KIND } from '../world/registry.js';

const EPS = 1e-7;

/**
 * Axis-aligned box body. Position (x, y, z) = center of the bottom face (feet), SPEC §4.
 * move() resolves collisions axis by axis (Y, then X, then Z) like Minecraft and zeroes the
 * velocity component of every axis that collided.
 */
export class PhysicsBody {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.x = 0; this.y = 0; this.z = 0;
    this.vx = 0; this.vy = 0; this.vz = 0;
    this.onGround = false;
    this.collidedX = false;
    this.collidedY = false;
    this.collidedZ = false;
    this.inWater = false;
    this.inLava = false;
    this._boxes = new Float64Array(6 * 256);
    this._boxCount = 0;
  }

  setPosition(x, y, z) {
    this.x = x; this.y = y; this.z = z;
  }

  getAABB(out = {}) {
    const hw = this.width / 2;
    out.minX = this.x - hw; out.minY = this.y; out.minZ = this.z - hw;
    out.maxX = this.x + hw; out.maxY = this.y + this.height; out.maxZ = this.z + hw;
    return out;
  }

  /** Move by (dx, dy, dz) blocks with collision. Updates onGround / collided* and velocity. */
  move(world, dx, dy, dz) {
    const hw = this.width / 2;
    let minX = this.x - hw, minY = this.y, minZ = this.z - hw;
    let maxX = this.x + hw, maxY = this.y + this.height, maxZ = this.z + hw;

    const n = this._collect(world,
      Math.min(minX, minX + dx), Math.min(minY, minY + dy), Math.min(minZ, minZ + dz),
      Math.max(maxX, maxX + dx), Math.max(maxY, maxY + dy), Math.max(maxZ, maxZ + dz));
    const b = this._boxes;

    // --- Y ---
    let ady = dy;
    if (dy !== 0) {
      for (let i = 0; i < n; i += 6) {
        if (b[i + 3] <= minX + EPS || b[i] >= maxX - EPS || b[i + 5] <= minZ + EPS || b[i + 2] >= maxZ - EPS) continue;
        if (ady > 0 && b[i + 1] >= maxY - EPS) ady = Math.min(ady, b[i + 1] - maxY);
        else if (ady < 0 && b[i + 4] <= minY + EPS) ady = Math.max(ady, b[i + 4] - minY);
      }
      minY += ady; maxY += ady;
    }

    // --- X ---
    let adx = dx;
    if (dx !== 0) {
      for (let i = 0; i < n; i += 6) {
        if (b[i + 4] <= minY + EPS || b[i + 1] >= maxY - EPS || b[i + 5] <= minZ + EPS || b[i + 2] >= maxZ - EPS) continue;
        if (adx > 0 && b[i] >= maxX - EPS) adx = Math.min(adx, b[i] - maxX);
        else if (adx < 0 && b[i + 3] <= minX + EPS) adx = Math.max(adx, b[i + 3] - minX);
      }
      minX += adx; maxX += adx;
    }

    // --- Z ---
    let adz = dz;
    if (dz !== 0) {
      for (let i = 0; i < n; i += 6) {
        if (b[i + 4] <= minY + EPS || b[i + 1] >= maxY - EPS || b[i + 3] <= minX + EPS || b[i] >= maxX - EPS) continue;
        if (adz > 0 && b[i + 2] >= maxZ - EPS) adz = Math.min(adz, b[i + 2] - maxZ);
        else if (adz < 0 && b[i + 5] <= minZ + EPS) adz = Math.max(adz, b[i + 5] - minZ);
      }
      minZ += adz; maxZ += adz;
    }

    this.collidedX = adx !== dx;
    this.collidedY = ady !== dy;
    this.collidedZ = adz !== dz;
    this.onGround = dy < 0 && this.collidedY;
    if (this.collidedX) this.vx = 0;
    if (this.collidedY) this.vy = 0;
    if (this.collidedZ) this.vz = 0;

    this.x = (minX + maxX) / 2;
    this.y = minY;
    this.z = (minZ + maxZ) / 2;
  }

  /** Sets inWater / inLava from the blocks overlapping the (slightly shrunk) body box. */
  updateFluidState(world) {
    const hw = this.width / 2 - 0.001;
    const x0 = Math.floor(this.x - hw), x1 = Math.floor(this.x + hw);
    const y0 = Math.floor(this.y + 0.001), y1 = Math.floor(this.y + this.height - 0.001);
    const z0 = Math.floor(this.z - hw), z1 = Math.floor(this.z + hw);
    let water = false, lava = false;
    for (let y = y0; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          const kind = LIQUID_KIND[world.getBlock(x, y, z)];
          if (kind === 1) water = true;
          else if (kind === 2) lava = true;
        }
      }
    }
    this.inWater = water;
    this.inLava = lava;
  }

  // Collect collision boxes of all blocks touching the given region into this._boxes.
  _collect(world, minX, minY, minZ, maxX, maxY, maxZ) {
    const x0 = Math.floor(minX), x1 = Math.floor(maxX);
    const y0 = Math.max(0, Math.floor(minY)), y1 = Math.min(255, Math.floor(maxY));
    const z0 = Math.floor(minZ), z1 = Math.floor(maxZ);
    let n = 0;
    for (let y = y0; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          const box = getCollisionBox(world.getBlock(x, y, z));
          if (!box) continue;
          if (n + 6 > this._boxes.length) {
            const grown = new Float64Array(this._boxes.length * 2);
            grown.set(this._boxes);
            this._boxes = grown;
          }
          const b = this._boxes;
          b[n] = x + box[0]; b[n + 1] = y + box[1]; b[n + 2] = z + box[2];
          b[n + 3] = x + box[3]; b[n + 4] = y + box[4]; b[n + 5] = z + box[5];
          n += 6;
        }
      }
    }
    // Nothing below y = 0: bodies fall into the void; owners kill/remove them below y = -64.
    return n;
  }
}

/** True if any solid block's collision box overlaps the given box. */
export function aabbIntersectsSolid(world, minX, minY, minZ, maxX, maxY, maxZ) {
  const x0 = Math.floor(minX), x1 = Math.floor(maxX - EPS);
  const y0 = Math.max(0, Math.floor(minY)), y1 = Math.min(255, Math.floor(maxY - EPS));
  const z0 = Math.floor(minZ), z1 = Math.floor(maxZ - EPS);
  for (let y = y0; y <= y1; y++) {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const box = getCollisionBox(world.getBlock(x, y, z));
        if (!box) continue;
        if (x + box[3] > minX + EPS && x + box[0] < maxX - EPS &&
            y + box[4] > minY + EPS && y + box[1] < maxY - EPS &&
            z + box[5] > minZ + EPS && z + box[2] < maxZ - EPS) return true;
      }
    }
  }
  return false;
}

/** Strict overlap test between two {minX..maxZ} boxes. */
export function boxesIntersect(a, b) {
  return a.maxX > b.minX + EPS && a.minX < b.maxX - EPS &&
    a.maxY > b.minY + EPS && a.minY < b.maxY - EPS &&
    a.maxZ > b.minZ + EPS && a.minZ < b.maxZ - EPS;
}

/**
 * Ray vs. box (slab method). Returns entry distance and entered face, or null.
 * Face = index of the box face the ray enters through (SPEC §4 face indices).
 */
export function rayBox(ox, oy, oz, dx, dy, dz, minX, minY, minZ, maxX, maxY, maxZ, out = {}) {
  let tmin = -Infinity, tmax = Infinity, face = -1;
  // X
  if (Math.abs(dx) < 1e-12) {
    if (ox < minX || ox > maxX) return null;
  } else {
    let t1 = (minX - ox) / dx, t2 = (maxX - ox) / dx, f = dx > 0 ? 1 : 0;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    if (t1 > tmin) { tmin = t1; face = f; }
    if (t2 < tmax) tmax = t2;
  }
  // Y
  if (Math.abs(dy) < 1e-12) {
    if (oy < minY || oy > maxY) return null;
  } else {
    let t1 = (minY - oy) / dy, t2 = (maxY - oy) / dy, f = dy > 0 ? 3 : 2;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    if (t1 > tmin) { tmin = t1; face = f; }
    if (t2 < tmax) tmax = t2;
  }
  // Z
  if (Math.abs(dz) < 1e-12) {
    if (oz < minZ || oz > maxZ) return null;
  } else {
    let t1 = (minZ - oz) / dz, t2 = (maxZ - oz) / dz, f = dz > 0 ? 5 : 4;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    if (t1 > tmin) { tmin = t1; face = f; }
    if (t2 < tmax) tmax = t2;
  }
  if (tmax < tmin || tmax < 0) return null;
  if (tmin < 0) {
    // Origin inside the box: report the face opposite to the dominant ray direction.
    const ax = Math.abs(dx), ay = Math.abs(dy), az = Math.abs(dz);
    if (ax >= ay && ax >= az) face = dx > 0 ? 1 : 0;
    else if (ay >= az) face = dy > 0 ? 3 : 2;
    else face = dz > 0 ? 5 : 4;
    tmin = 0;
  }
  out.t = tmin;
  out.face = face;
  return out;
}

const _hit = {};

/**
 * Voxel ray cast (Amanatides & Woo DDA) against block selection boxes.
 * Direction need not be normalized. Liquids are skipped unless includeLiquids.
 * Returns { x, y, z, face, blockId, distance, px, py, pz } or null.
 */
export function raycast(world, ox, oy, oz, dx, dy, dz, maxDist, { includeLiquids = false } = {}) {
  const len = Math.hypot(dx, dy, dz);
  if (len === 0) return null;
  dx /= len; dy /= len; dz /= len;

  let x = Math.floor(ox), y = Math.floor(oy), z = Math.floor(oz);
  const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
  const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;
  const tDeltaX = stepX ? Math.abs(1 / dx) : Infinity;
  const tDeltaY = stepY ? Math.abs(1 / dy) : Infinity;
  const tDeltaZ = stepZ ? Math.abs(1 / dz) : Infinity;
  let tMaxX = stepX > 0 ? (x + 1 - ox) / dx : stepX < 0 ? (x - ox) / dx : Infinity;
  let tMaxY = stepY > 0 ? (y + 1 - oy) / dy : stepY < 0 ? (y - oy) / dy : Infinity;
  let tMaxZ = stepZ > 0 ? (z + 1 - oz) / dz : stepZ < 0 ? (z - oz) / dz : Infinity;

  let t = 0;
  for (let guard = 0; guard < 1024 && t <= maxDist; guard++) {
    if (y >= 0 && y < 256) {
      const id = world.getBlock(x, y, z);
      if (id !== 0 && (includeLiquids || !IS_LIQUID[id])) {
        const box = getSelectionBox(id);
        const hit = rayBox(ox, oy, oz, dx, dy, dz,
          x + box[0], y + box[1], z + box[2], x + box[3], y + box[4], z + box[5], _hit);
        if (hit && hit.t <= maxDist) {
          return {
            x, y, z, face: hit.face, blockId: id, distance: hit.t,
            px: ox + dx * hit.t, py: oy + dy * hit.t, pz: oz + dz * hit.t,
          };
        }
      }
    }
    if (tMaxX < tMaxY) {
      if (tMaxX < tMaxZ) { x += stepX; t = tMaxX; tMaxX += tDeltaX; }
      else { z += stepZ; t = tMaxZ; tMaxZ += tDeltaZ; }
    } else if (tMaxY < tMaxZ) {
      y += stepY; t = tMaxY; tMaxY += tDeltaY;
    } else {
      z += stepZ; t = tMaxZ; tMaxZ += tDeltaZ;
    }
  }
  return null;
}
