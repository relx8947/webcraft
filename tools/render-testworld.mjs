// Test-only world for tools/render-test.html: a 64x64 hilly area (periodic, so it tiles seamlessly), light
// (sky + block BFS), a compact SPEC §7 mesher (cubes with AO + smooth light, cross plants, torches, liquids),
// placeholder textures (used only while src/render/textures.js is unavailable) and a mock EntityRenderer that
// exercises the §9.5 ctx contract. Nothing here is used by the game.

import {
  BLOCK, IS_OPAQUE, RENDER_TYPE, RENDER_LAYER, LIGHT_EMISSION, LIGHT_FILTER, CULL_SAME, TINT_TYPE,
  FACE_LAYERS, FACE_ROTATION, RENDER, TINT, TEXTURES, TEXTURE_LAYER_COUNT, IS_LIQUID,
} from '../src/world/registry.js';
import { DEFAULT_TINTS } from '../src/config.js';

export const SIZE = 64;     // world period along X and Z (4x4 chunks)
export const HEIGHT = 128;  // only the lower half of the world is used by the test map
const TAU = Math.PI * 2;

function hash2(x, z, s = 0) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(z | 0, 668265263) ^ Math.imul(s | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const wrapD = (a, b) => {
  const d = Math.abs(a - b) % SIZE;
  return Math.min(d, SIZE - d);
};

// ---------------------------------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------------------------------

export class TestWorld {
  constructor() {
    this.blocks = new Uint8Array(SIZE * SIZE * HEIGHT);
    this.sky = new Uint8Array(SIZE * SIZE * HEIGHT);
    this.blk = new Uint8Array(SIZE * SIZE * HEIGHT);
    this.heights = new Int32Array(SIZE * SIZE);
    this.features = {};
  }

  idx(x, y, z) {
    return (y * SIZE + (z & 63)) * SIZE + (x & 63);
  }

  get(x, y, z) {
    if (y < 0) return BLOCK.BEDROCK;
    if (y >= HEIGHT) return 0;
    return this.blocks[this.idx(x, y, z)];
  }

  set(x, y, z, id) {
    if (y < 0 || y >= HEIGHT) return;
    this.blocks[this.idx(x, y, z)] = id;
  }

  skyAt(x, y, z) {
    if (y >= HEIGHT) return 15;
    if (y < 0) return 0;
    return this.sky[this.idx(x, y, z)];
  }

  blkAt(x, y, z) {
    if (y < 0 || y >= HEIGHT) return 0;
    return this.blk[this.idx(x, y, z)];
  }

  heightAt(x, z) {
    return this.heights[(z & 63) * SIZE + (x & 63)];
  }

  generate() {
    const B = BLOCK;
    for (let z = 0; z < SIZE; z++) {
      for (let x = 0; x < SIZE; x++) {
        let h = 65
          + 3.0 * Math.sin(TAU * x / 64 + 0.3) * Math.cos(TAU * 2 * z / 64 + 1.1)
          + 2.0 * Math.sin(TAU * 3 * (x + z) / 64 + 0.7)
          + 1.2 * Math.sin(TAU * 2 * (2 * x - z) / 64);
        const dhx = wrapD(x, 46), dhz = wrapD(z, 44);
        h += 15 * Math.exp(-(dhx * dhx + dhz * dhz) / 110);
        const dlx = wrapD(x, 15), dlz = wrapD(z, 17);
        h -= 9 * Math.exp(-(dlx * dlx + dlz * dlz) / 95);
        h = Math.round(h);
        this.heights[z * SIZE + x] = h;
        const beach = h <= 63;
        for (let y = 0; y <= h; y++) {
          let id;
          if (y === 0) id = B.BEDROCK;
          else if (y < h - 3) id = B.STONE;
          else if (y < h) id = beach ? B.SAND : B.DIRT;
          else id = beach ? B.SAND : B.GRASS_BLOCK;
          this.set(x, y, z, id);
        }
        for (let y = h + 1; y <= 62; y++) this.set(x, y, z, B.WATER);
      }
    }
    // ice floe on the lake
    for (let dz = -1; dz <= 1; dz++) for (let dx = -2; dx <= 1; dx++) {
      if (this.get(15 + dx, 62, 15 + dz) === B.WATER) this.set(15 + dx, 62, 15 + dz, B.ICE);
    }
    // ores sprinkled into stone (visible in the cave)
    for (let i = 0; i < 900; i++) {
      const x = Math.floor(hash2(i, 1, 7) * SIZE), z = Math.floor(hash2(i, 2, 7) * SIZE);
      const y = 2 + Math.floor(hash2(i, 3, 7) * 70);
      if (this.get(x, y, z) !== B.STONE) continue;
      const r = hash2(i, 4, 7);
      this.set(x, y, z, r < 0.5 ? B.COAL_ORE : r < 0.75 ? B.IRON_ORE : r < 0.85 ? B.GOLD_ORE : r < 0.93 ? B.REDSTONE_ORE : B.DIAMOND_ORE);
    }
    this._carveCave();
    this._trees();
    this._plants();
    this._structures();
    return this;
  }

  _carveCave() {
    const B = BLOCK;
    // tunnel from the west slope of the hill toward a chamber under the summit
    const floor = 66;
    for (let x = 30; x <= 47; x++) {
      for (let z = 43; z <= 45; z++) {
        for (let y = floor; y <= floor + 2; y++) {
          if (y < this.heightAt(x, z) - 0 || x < 34) this.set(x, y, z, 0);
        }
      }
    }
    // chamber
    for (let x = 41; x <= 52; x++) for (let z = 38; z <= 50; z++) for (let y = floor - 1; y <= floor + 5; y++) {
      const dx = (x - 46.5) / 6, dz = (z - 44) / 6.5, dy = (y - (floor + 1.5)) / 3.5;
      if (dx * dx + dz * dz + dy * dy < 1 && y < this.heightAt(x, z) - 1) this.set(x, y, z, 0);
    }
    // plants/grass above the tunnel mouth must not float: grass cleanup happens in _plants
    // lava pool and torches
    this.set(48, floor - 1, 46, B.LAVA); this.set(49, floor - 1, 46, B.LAVA);
    this.set(48, floor - 1, 47, B.LAVA); this.set(49, floor - 1, 47, B.LAVA);
    this.set(48, floor - 2, 46, B.STONE); this.set(49, floor - 2, 46, B.STONE);
    this.set(48, floor - 2, 47, B.STONE); this.set(49, floor - 2, 47, B.STONE);
    const torches = [[37, floor, 43], [42, floor, 45], [45, floor, 41], [44, floor - 1 + 1, 48]];
    for (const [x, y, z] of torches) {
      if (this.get(x, y, z) === 0 && IS_OPAQUE[this.get(x, y - 1, z)]) this.set(x, y, z, B.TORCH);
    }
    this.set(46, floor + 5, 44, B.GLOWSTONE);
    this.features.cave = { floor, entrance: [31, floor, 44], chamber: [46.5, floor + 1, 44] };
  }

  _tree(x, z, kind) {
    const B = BLOCK;
    const h = this.heightAt(x, z);
    if (this.get(x, h, z) !== B.GRASS_BLOCK) return;
    const log = kind === 'birch' ? B.BIRCH_LOG : kind === 'spruce' ? B.SPRUCE_LOG : B.OAK_LOG;
    const leaves = kind === 'birch' ? B.BIRCH_LEAVES : kind === 'spruce' ? B.SPRUCE_LEAVES : B.OAK_LEAVES;
    const trunk = kind === 'spruce' ? 7 : kind === 'birch' ? 6 : 5;
    this.set(x, h, z, B.DIRT);
    const top = h + trunk;
    const put = (lx, ly, lz) => { if (this.get(lx, ly, lz) === 0) this.set(lx, ly, lz, leaves); };
    if (kind === 'spruce') {
      const layers = [[top + 1, 0], [top, 1], [top - 1, 1], [top - 2, 2], [top - 3, 1], [top - 4, 2], [top - 5, 1]];
      for (const [y, r] of layers) {
        for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
          if (r > 0 && Math.abs(dx) === r && Math.abs(dz) === r) continue;
          put(x + dx, y, z + dz);
        }
      }
    } else {
      for (let y = top - 2; y <= top + 1; y++) {
        const r = y <= top - 1 ? 2 : 1;
        for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
          const corner = Math.abs(dx) === r && Math.abs(dz) === r;
          if (corner && (y === top + 1 || hash2(x * 7 + dx, z * 13 + dz, y) < 0.5)) continue;
          put(x + dx, y, z + dz);
        }
      }
    }
    for (let y = h + 1; y <= top; y++) this.set(x, y, z, log);
  }

  _trees() {
    this._tree(31, 12, 'oak');
    this._tree(8, 44, 'oak');
    this._tree(40, 24, 'birch');
    this._tree(55, 9, 'spruce');
    this._tree(24, 52, 'oak');
    this._tree(58, 30, 'birch');
    this._tree(4, 28, 'spruce');
    this._tree(28, 31, 'oak');
  }

  _plants() {
    const B = BLOCK;
    const flowers = [B.DANDELION, B.POPPY, B.CORNFLOWER, B.OXEYE_DAISY];
    for (let z = 0; z < SIZE; z++) {
      for (let x = 0; x < SIZE; x++) {
        // the real top (trees / cave changed the column)
        let y = HEIGHT - 1;
        while (y > 0 && this.get(x, y, z) === 0) y--;
        const top = this.get(x, y, z);
        if (top !== B.GRASS_BLOCK || this.get(x, y + 1, z) !== 0) continue;
        const r = hash2(x, z, 99);
        if (r < 0.26) this.set(x, y + 1, z, B.SHORT_GRASS);
        else if (r < 0.30) this.set(x, y + 1, z, flowers[Math.floor(hash2(x, z, 5) * 4)]);
        else if (r < 0.32) this.set(x, y + 1, z, B.FERN);
      }
    }
  }

  _structures() {
    const B = BLOCK;
    // a small glass aquarium (water against glass + a tall-grass sprite in front)
    const ax = 34, az = 30;
    let base = 0;
    for (let dz = 0; dz < 4; dz++) for (let dx = 0; dx < 4; dx++) base = Math.max(base, this.heightAt(ax + dx, az + dz));
    for (let dz = 0; dz < 4; dz++) for (let dx = 0; dx < 4; dx++) {
      for (let y = this.heightAt(ax + dx, az + dz) + 1; y <= base; y++) this.set(ax + dx, y, az + dz, B.COBBLESTONE);
      for (let y = base + 1; y <= base + 3; y++) {
        const edge = dx === 0 || dz === 0 || dx === 3 || dz === 3;
        this.set(ax + dx, y, az + dz, edge ? B.GLASS : B.WATER);
      }
    }
    // a little brick + plank hut wall and a pumpkin for colour variety
    const hx = 22, hz = 36;
    const hb = this.heightAt(hx, hz);
    for (let dx = 0; dx < 5; dx++) for (let y = 1; y <= 3; y++) {
      const id = y === 3 ? B.OAK_PLANKS : (dx === 2 && y < 3 ? 0 : B.BRICKS);
      this.set(hx + dx, hb + y, hz, id);
    }
    this.set(hx + 6, this.heightAt(hx + 6, hz) + 1, hz, B.PUMPKIN);
    this.set(hx + 7, this.heightAt(hx + 7, hz) + 1, hz + 1, B.CRAFTING_TABLE);
    this.features.aquarium = [ax, base, az];
    // floating test platform (y = 88): a row of block types for selection / crack / translucency checks
    const py = 88;
    for (let x = 1; x <= 17; x++) for (let z = 2; z <= 7; z++) this.set(x, py, z, B.STONE_BRICKS);
    const row = [[2, B.GRASS_BLOCK], [4, B.OAK_LEAVES], [6, B.GLASS], [8, B.TORCH], [10, B.DANDELION], [12, B.SHORT_GRASS],
      [14, B.ICE], [16, B.OAK_LOG_X]];
    for (const [x, id] of row) this.set(x, py + 1, 4, id);
    // water pool in the platform with an ice block and a glass wall next to it
    for (let x = 4; x <= 7; x++) this.set(x, py, 6, B.WATER);
    this.set(8, py + 1, 6, B.GLASS);
    this.set(3, py + 1, 6, B.WATER);
    this.features.platform = [9, py, 4];
  }

  // -------------------------------------------------------------------------------------------------
  // Light (SPEC §6 rules, periodic in X/Z)
  // -------------------------------------------------------------------------------------------------
  computeLight() {
    this._light(true);
    this._light(false);
    return this;
  }

  _light(skyPass) {
    const arr = skyPass ? this.sky : this.blk;
    arr.fill(0);
    const buckets = Array.from({ length: 16 }, () => []);
    const blocks = this.blocks;
    if (skyPass) {
      for (let z = 0; z < SIZE; z++) for (let x = 0; x < SIZE; x++) {
        let level = 15;
        for (let y = HEIGHT - 1; y >= 0; y--) {
          const i = this.idx(x, y, z);
          const id = blocks[i];
          if (IS_OPAQUE[id]) break;
          level -= LIGHT_FILTER[id];
          if (level <= 0) break;
          arr[i] = level;
          buckets[level].push(i);
        }
      }
    } else {
      for (let i = 0; i < blocks.length; i++) {
        const e = LIGHT_EMISSION[blocks[i]];
        if (!e) continue;
        if (!IS_OPAQUE[blocks[i]]) {
          if (e > arr[i]) { arr[i] = e; buckets[e].push(i); }
        } else {
          // opaque emitter: light its neighbours
          const x = i % SIZE, z = Math.floor(i / SIZE) % SIZE, y = Math.floor(i / (SIZE * SIZE));
          for (const [dx, dy, dz] of NEIGHBOURS) {
            const ny = y + dy;
            if (ny < 0 || ny >= HEIGHT) continue;
            const j = this.idx(x + dx, ny, z + dz);
            const id = blocks[j];
            if (IS_OPAQUE[id]) continue;
            const v = e - 1 - LIGHT_FILTER[id];
            if (v > arr[j]) { arr[j] = v; buckets[v].push(j); }
          }
        }
      }
    }
    for (let level = 15; level >= 1; level--) {
      const list = buckets[level];
      for (let k = 0; k < list.length; k++) {
        const i = list[k];
        if (arr[i] !== level) continue;
        const x = i % SIZE, z = Math.floor(i / SIZE) % SIZE, y = Math.floor(i / (SIZE * SIZE));
        for (const [dx, dy, dz] of NEIGHBOURS) {
          const ny = y + dy;
          if (ny < 0 || ny >= HEIGHT) continue;
          const j = this.idx(x + dx, ny, z + dz);
          const id = blocks[j];
          if (IS_OPAQUE[id]) continue;
          const v = level - 1 - LIGHT_FILTER[id];
          if (v > arr[j]) { arr[j] = v; if (v > 0) buckets[v].push(j); }
        }
      }
    }
  }

  // -------------------------------------------------------------------------------------------------
  // Mesher (SPEC §7)
  // -------------------------------------------------------------------------------------------------

  /** Mesh section (cx, sy, cz) with cx, cz in 0..3. Returns { opaque, cutout, translucent } Uint32Array|null. */
  meshSection(cx, sy, cz, smooth = true) {
    const out = [[], [], []];
    const x0 = cx * 16, y0 = sy * 16, z0 = cz * 16;
    for (let y = y0; y < y0 + 16; y++) {
      for (let z = z0; z < z0 + 16; z++) {
        for (let x = x0; x < x0 + 16; x++) {
          const id = this.get(x, y, z);
          if (!id) continue;
          const rt = RENDER_TYPE[id];
          const layer = RENDER_LAYER[id];
          const lx = x - x0, ly = y - y0, lz = z - z0;
          if (rt === RENDER.CUBE || rt === RENDER.CACTUS) this._cube(out[layer], id, x, y, z, lx, ly, lz, smooth);
          else if (rt === RENDER.CROSS) this._cross(out[layer], id, x, y, z, lx, ly, lz);
          else if (rt === RENDER.TORCH) this._torch(out[layer], id, x, y, z, lx, ly, lz);
          else if (rt === RENDER.LIQUID) this._liquid(out[layer], id, x, y, z, lx, ly, lz);
        }
      }
    }
    return {
      opaque: out[0].length ? Uint32Array.from(out[0]) : null,
      cutout: out[1].length ? Uint32Array.from(out[1]) : null,
      translucent: out[2].length ? Uint32Array.from(out[2]) : null,
    };
  }

  _tint(id, x, z) {
    const t = TINT_TYPE[id];
    let c;
    if (t === TINT.GRASS) c = tintAt(DEFAULT_TINTS.grass, x, z);
    else if (t === TINT.FOLIAGE) c = tintAt(DEFAULT_TINTS.foliage, x, z);
    else if (t === TINT.BIRCH) c = [128, 167, 85];
    else if (t === TINT.SPRUCE) c = [97, 153, 97];
    else return 0xffffff;
    return (c[0] | (c[1] << 8) | (c[2] << 16)) >>> 0;
  }

  _cube(out, id, x, y, z, lx, ly, lz, smooth) {
    const tint = this._tint(id, x, z);
    const inset = RENDER_TYPE[id] === RENDER.CACTUS ? 1 : 0;
    for (let f = 0; f < 6; f++) {
      const [nx, ny, nz] = NORMALS[f];
      const nid = this.get(x + nx, y + ny, z + nz);
      if (inset === 0 || f >= 2 && f <= 3) {
        if (IS_OPAQUE[nid]) continue;
        if (CULL_SAME[id] && nid === id) continue;
      }
      const layer = FACE_LAYERS[id * 6 + f];
      const rot = FACE_ROTATION[id * 6 + f];
      const anim = (TINT_TYPE[id] === TINT.FOLIAGE || TINT_TYPE[id] === TINT.BIRCH || TINT_TYPE[id] === TINT.SPRUCE) ? 2 : 0;
      const corners = FACE_CORNERS[f];
      const v = [];
      const aoS = [], lS = [];
      for (let c = 0; c < 4; c++) {
        const [cxp, cyp, czp] = corners[c];
        let ao = 3, sky4, blk4;
        if (smooth) {
          const r = this._vertexLight(x, y, z, f, cxp, cyp, czp);
          ao = r[0]; sky4 = r[1]; blk4 = r[2];
        } else {
          sky4 = this.skyAt(x + nx, y + ny, z + nz) * 4;
          blk4 = this.blkAt(x + nx, y + ny, z + nz) * 4;
        }
        // positions in 1/16 with the cactus side inset
        let px = cxp * 16, py = cyp * 16, pz = czp * 16;
        if (inset) {
          if (f === 0) px -= 1; else if (f === 1) px += 1; else if (f === 4) pz -= 1; else if (f === 5) pz += 1;
        }
        let [u, vv] = UVS[c];
        if (rot) [u, vv] = [16 - vv, u];
        v.push([lx * 16 + px, ly * 16 + py, lz * 16 + pz, ao, f, layer, u, vv, sky4, blk4, anim, tint]);
        aoS.push(ao); lS.push(sky4 + blk4);
      }
      const flip = aoS[0] + aoS[2] < aoS[1] + aoS[3] || (aoS[0] + aoS[2] === aoS[1] + aoS[3] && lS[0] + lS[2] < lS[1] + lS[3]);
      const order = flip ? [1, 2, 3, 0] : [0, 1, 2, 3];
      for (const k of order) pushVertex(out, ...v[k]);
    }
  }

  _vertexLight(x, y, z, f, cxp, cyp, czp) {
    const [nx, ny, nz] = NORMALS[f];
    const axis = f >> 1;                       // 0 x, 1 y, 2 z
    const t1 = axis === 0 ? 1 : 0;             // tangent axes
    const t2 = axis === 2 ? 1 : 2;
    const cc = [cxp, cyp, czp];
    const s1 = cc[t1] ? 1 : -1, s2 = cc[t2] ? 1 : -1;
    const fx = x + nx, fy = y + ny, fz = z + nz;
    const off = (a, s) => [a === 0 ? s : 0, a === 1 ? s : 0, a === 2 ? s : 0];
    const o1 = off(t1, s1), o2 = off(t2, s2);
    const p1 = [fx + o1[0], fy + o1[1], fz + o1[2]];
    const p2 = [fx + o2[0], fy + o2[1], fz + o2[2]];
    const p3 = [fx + o1[0] + o2[0], fy + o1[1] + o2[1], fz + o1[2] + o2[2]];
    const op1 = IS_OPAQUE[this.get(...p1)], op2 = IS_OPAQUE[this.get(...p2)], op3 = IS_OPAQUE[this.get(...p3)];
    const ao = op1 && op2 ? 0 : 3 - (op1 + op2 + op3);
    let ss = this.skyAt(fx, fy, fz), bs = this.blkAt(fx, fy, fz), n = 1;
    if (!op1) { ss += this.skyAt(...p1); bs += this.blkAt(...p1); n++; }
    if (!op2) { ss += this.skyAt(...p2); bs += this.blkAt(...p2); n++; }
    if (!op3 && !(op1 && op2)) { ss += this.skyAt(...p3); bs += this.blkAt(...p3); n++; }
    return [ao, Math.round(ss * 4 / n), Math.round(bs * 4 / n)];
  }

  _cross(out, id, x, y, z, lx, ly, lz) {
    const tint = this._tint(id, x, z);
    const layer = FACE_LAYERS[id * 6 + 2];
    const sky4 = this.skyAt(x, y, z) * 4, blk4 = this.blkAt(x, y, z) * 4;
    const sway = id === BLOCK.SUGAR_CANE ? 0 : 1;
    const bx = lx * 16, by = ly * 16, bz = lz * 16;
    const planes = [[2, 2, 14, 14], [2, 14, 14, 2]];
    for (const [ax, az, cx2, cz2] of planes) {
      const BL = [bx + ax, by, bz + az], BR = [bx + cx2, by, bz + cz2];
      const TR = [bx + cx2, by + 16, bz + cz2], TL = [bx + ax, by + 16, bz + az];
      const quadA = [[BL, 0, 16, 0], [BR, 16, 16, 0], [TR, 16, 0, sway], [TL, 0, 0, sway]];
      const quadB = [[BR, 16, 16, 0], [BL, 0, 16, 0], [TL, 0, 0, sway], [TR, 16, 0, sway]];
      for (const q of [quadA, quadB]) {
        for (const [p, u, v, anim] of q) pushVertex(out, p[0], p[1], p[2], 3, 6, layer, u, v, sky4, blk4, anim, tint);
      }
    }
  }

  _torch(out, id, x, y, z, lx, ly, lz) {
    const layer = FACE_LAYERS[id * 6 + 0];
    const sky4 = this.skyAt(x, y, z) * 4, blk4 = this.blkAt(x, y, z) * 4;
    const bx = lx * 16, by = ly * 16, bz = lz * 16;
    const x0 = bx + 7, x1 = bx + 9, z0 = bz + 7, z1 = bz + 9, y0 = by, y1 = by + 10;
    const side = (f, a, b, c, d) => {
      const uv = [[7, 16], [9, 16], [9, 6], [7, 6]];
      [a, b, c, d].forEach((p, i) => pushVertex(out, p[0], p[1], p[2], 3, f, layer, uv[i][0], uv[i][1], sky4, blk4, 0, 0xffffff));
    };
    side(0, [x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]);
    side(1, [x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]);
    side(4, [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]);
    side(5, [x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]);
    const top = [[x0, y1, z1, 7, 8], [x1, y1, z1, 9, 8], [x1, y1, z0, 9, 6], [x0, y1, z0, 7, 6]];
    for (const [px, py, pz, u, v] of top) pushVertex(out, px, py, pz, 3, 2, layer, u, v, sky4, blk4, 0, 0xffffff);
  }

  _liquid(out, id, x, y, z, lx, ly, lz) {
    const layer = FACE_LAYERS[id * 6 + 2];
    const above = this.get(x, y + 1, z);
    const h = above === id ? 16 : 14;
    const bx = lx * 16, by = ly * 16, bz = lz * 16;
    for (let f = 0; f < 6; f++) {
      const [nx, ny, nz] = NORMALS[f];
      const nid = this.get(x + nx, y + ny, z + nz);
      if (nid === id || IS_OPAQUE[nid]) continue;
      if (f === 2 && IS_LIQUID[nid] && nid === id) continue;
      const sky4 = (id === BLOCK.LAVA ? 15 : this.skyAt(x + nx, y + ny, z + nz)) * 4;
      const blk4 = Math.max(this.blkAt(x + nx, y + ny, z + nz), this.blkAt(x, y, z)) * 4;
      const corners = FACE_CORNERS[f];
      for (let c = 0; c < 4; c++) {
        const [cxp, cyp, czp] = corners[c];
        let [u, v] = UVS[c];
        if (f !== 2 && f !== 3 && v === 0) v = 16 - h;
        pushVertex(out, bx + cxp * 16, by + cyp * h, bz + czp * 16, 3, f, layer, u, v, sky4, blk4, 3, 0xffffff);
      }
    }
  }
}

function tintAt(base, x, z) {
  // gentle biome-like variation
  const k = 0.06 * Math.sin(TAU * x / 64) * Math.cos(TAU * z / 64);
  return [Math.round(base[0] * (1 - k)), Math.round(base[1] * (1 + k * 0.4)), Math.round(base[2] * (1 - k))];
}

const NEIGHBOURS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const NORMALS = NEIGHBOURS;
// Face corners BL, BR, TR, TL (counter-clockwise seen from outside), UVs (0,16) (16,16) (16,0) (0,0)
const FACE_CORNERS = [
  [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]],   // +X
  [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]],   // -X
  [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]],   // +Y
  [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]],   // -Y
  [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]],   // +Z
  [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]],   // -Z
];
const UVS = [[0, 16], [16, 16], [16, 0], [0, 0]];

/** Append one packed §7 vertex. Positions in 1/16 block relative to the section origin. */
export function pushVertex(out, px, py, pz, ao, face, layer, u, v, sky4, blk4, anim, tint) {
  out.push(
    ((px + 16) | ((py + 16) << 9) | ((pz + 16) << 18) | (ao << 27) | (face << 29)) >>> 0,
    (layer | (u << 8) | (v << 13) | (sky4 << 18) | (blk4 << 24) | (anim << 30)) >>> 0,
    tint >>> 0,
  );
}

// ---------------------------------------------------------------------------------------------------
// Placeholder textures (only when src/render/textures.js is unavailable)
// ---------------------------------------------------------------------------------------------------

const COLORS = {
  stone: [125, 125, 125], dirt: [134, 96, 67], cobblestone: [120, 120, 120], sand: [219, 207, 163],
  gravel: [131, 127, 126], bedrock: [85, 85, 85], snow: [240, 251, 251], clay: [160, 166, 179],
  oak_planks: [162, 130, 78], birch_planks: [196, 179, 123], spruce_planks: [114, 84, 48],
  oak_log: [109, 85, 50], birch_log: [216, 215, 210], spruce_log: [58, 37, 16],
  oak_log_top: [151, 122, 73], birch_log_top: [193, 179, 135], spruce_log_top: [108, 80, 46],
  obsidian: [20, 18, 30], glowstone: [250, 210, 120], bricks: [150, 74, 58], stone_bricks: [122, 121, 122],
  sandstone: [216, 203, 155], sandstone_top: [220, 207, 160], sandstone_bottom: [212, 199, 150],
  ice: [145, 183, 253], iron_block: [220, 220, 220], gold_block: [246, 208, 61], diamond_block: [98, 237, 228],
  coal_block: [20, 20, 20], lapis_block: [30, 67, 140], pumpkin_side: [227, 141, 26], pumpkin_top: [200, 120, 20],
  granite: [149, 103, 85], diorite: [188, 188, 188], andesite: [136, 136, 137], mossy_cobblestone: [110, 125, 100],
  tnt_side: [200, 60, 40], tnt_top: [180, 60, 40], tnt_bottom: [180, 60, 40], crafting_table_top: [150, 110, 60],
  crafting_table_side: [140, 100, 60], crafting_table_front: [140, 100, 60], furnace_side: [110, 110, 110],
  furnace_top: [120, 120, 120], furnace_front: [100, 100, 100], bookshelf: [130, 100, 60], jack_o_lantern: [227, 141, 26],
  cactus_side: [85, 125, 45], cactus_top: [95, 135, 55], cactus_bottom: [95, 135, 55], grass_block_snow: [134, 96, 67],
  mossy_stone_bricks: [110, 122, 100], cracked_stone_bricks: [118, 117, 118],
};
const WOOL = {
  white: [233, 236, 236], orange: [240, 118, 19], magenta: [189, 68, 179], light_blue: [58, 175, 217],
  yellow: [248, 197, 39], lime: [112, 185, 25], pink: [237, 141, 172], gray: [62, 68, 71], light_gray: [142, 142, 134],
  cyan: [21, 137, 145], purple: [121, 42, 172], blue: [53, 57, 157], brown: [114, 71, 40], green: [84, 109, 27],
  red: [160, 39, 34], black: [20, 21, 25],
};
const ORES = { coal_ore: [30, 30, 30], iron_ore: [216, 175, 147], gold_ore: [252, 238, 75], diamond_ore: [93, 236, 245],
  redstone_ore: [255, 0, 0], lapis_ore: [30, 70, 180] };
const FLOWERS = { dandelion: [255, 236, 79], poppy: [237, 48, 44], cornflower: [70, 110, 230], oxeye_daisy: [245, 245, 235] };

function paintTexture(name, frame, px) {
  const set = (x, y, r, g, b, a = 255) => {
    const o = (y * 16 + x) * 4;
    px[o] = clamp8(r); px[o + 1] = clamp8(g); px[o + 2] = clamp8(b); px[o + 3] = a;
  };
  const seed = [...name].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, 7);
  const n = (x, y, s = 0) => hash2(x + s * 17, y, seed);
  const base = (c, amp) => {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const k = (n(x, y) - 0.5) * amp;
      set(x, y, c[0] + k, c[1] + k, c[2] + k);
    }
  };
  if (name === 'grass_block_top') {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const v = 150 + n(x, y) * 60; set(x, y, v, v, v, 0); }
    return;
  }
  if (name === 'grass_block_side' || name === 'grass_block_snow') {
    base(COLORS.dirt, 34);
    for (let x = 0; x < 16; x++) {
      const depth = 3 + Math.floor(n(x, 99) * 3);
      for (let y = 0; y < depth; y++) {
        if (name === 'grass_block_snow') set(x, y, 240, 250, 250);
        else { const v = 150 + n(x, y, 3) * 60; set(x, y, v, v, v, 0); }
      }
    }
    return;
  }
  if (name.endsWith('_leaves')) {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const hole = n(x, y, 5) < 0.22;
      const v = 95 + n(x, y) * 90;
      set(x, y, v, v, v, hole ? 0 : 255);
    }
    return;
  }
  if (name === 'glass') {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const edge = x === 0 || y === 0 || x === 15 || y === 15;
      const streak = (x - y === 3 && x > 4 && x < 9) || (x - y === 5 && x > 8 && x < 12);
      if (edge) set(x, y, 220, 238, 240, 255); else if (streak) set(x, y, 245, 252, 255, 255); else set(x, y, 0, 0, 0, 0);
    }
    return;
  }
  if (name === 'water_still') {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const w = Math.sin((x + frame) * 0.8) + Math.sin((y * 0.7 - frame * 0.5)) + n(x, (y + frame) & 15) * 0.8;
      const v = 0.85 + w * 0.06;
      set(x, y, 52 * v, 92 * v, 205 * v, 178);
    }
    return;
  }
  if (name === 'lava_still') {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const w = Math.sin((x + frame * 0.5) * 0.9) * Math.cos((y - frame * 0.25) * 0.7) + n((x + frame) & 15, y) * 0.6;
      set(x, y, 215 + w * 35, 95 + w * 60, 20 + w * 20);
    }
    return;
  }
  if (name === 'ice') {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const streak = (x + y * 2) % 11 === 0;
      const c = COLORS.ice;
      set(x, y, c[0] + (streak ? 50 : 0), c[1] + (streak ? 40 : 0), c[2], streak ? 200 : 150);
    }
    return;
  }
  if (name.startsWith('destroy_stage_')) {
    const stage = Number(name.slice(14));
    px.fill(0);
    const rnd = (i) => hash2(i, stage, 4242);
    const cracks = 2 + stage * 2;
    for (let c = 0; c < cracks; c++) {
      let x = 8 + Math.round((rnd(c * 3) - 0.5) * 6), y = 8 + Math.round((rnd(c * 3 + 1) - 0.5) * 6);
      const len = 3 + stage;
      for (let s = 0; s < len; s++) {
        if (x < 0 || y < 0 || x > 15 || y > 15) break;
        set(x, y, 45, 45, 45, 210);
        const d = rnd(c * 31 + s);
        if (d < 0.35) x++; else if (d < 0.6) y++; else if (d < 0.8) x--; else y--;
      }
    }
    return;
  }
  if (name === 'torch') {
    px.fill(0);
    for (let y = 8; y < 16; y++) for (let x = 7; x < 9; x++) set(x, y, 110 + (x - 7) * 20, 82, 48);
    set(7, 6, 255, 240, 140); set(8, 6, 255, 220, 90); set(7, 7, 255, 170, 40); set(8, 7, 255, 200, 70);
    return;
  }
  if (FLOWERS[name]) {
    px.fill(0);
    for (let y = 8; y < 16; y++) set(8, y, 60, 140, 40);
    set(7, 11, 60, 150, 40); set(9, 12, 60, 150, 40);
    const c = FLOWERS[name];
    for (let y = 4; y < 8; y++) for (let x = 6; x < 11; x++) {
      if ((x === 6 || x === 10) && (y === 4 || y === 7)) continue;
      set(x, y, c[0], c[1], c[2]);
    }
    set(8, 5, 250, 210, 60); set(8, 6, 250, 210, 60);
    return;
  }
  if (name === 'short_grass' || name === 'fern' || name === 'sugar_cane' || name === 'dead_bush' || name.endsWith('_sapling')) {
    px.fill(0);
    const blades = name === 'sugar_cane' ? [4, 8, 12] : [2, 4, 5, 7, 8, 10, 11, 13];
    for (const bx of blades) {
      const top = name === 'sugar_cane' ? 0 : 3 + Math.floor(n(bx, 1) * 8);
      let x = bx;
      for (let y = 15; y >= top; y--) {
        const v = 120 + n(x, y) * 80;
        if (name === 'dead_bush') set(x, y, 120, 80, 40);
        else if (name.endsWith('_sapling')) set(x, y, 70, 120 + n(x, y) * 40, 40);
        else set(x, y, v, v, v);
        if (name !== 'sugar_cane' && y < 10 && n(x, y, 2) < 0.3) x += bx < 8 ? -1 : 1;
        if (x < 0 || x > 15) break;
      }
    }
    return;
  }
  if (name.endsWith('_mushroom')) {
    px.fill(0);
    for (let y = 10; y < 16; y++) set(8, y, 220, 210, 190);
    const c = name.startsWith('red') ? [200, 30, 30] : [150, 110, 80];
    for (let y = 7; y < 10; y++) for (let x = 5; x < 12; x++) set(x, y, c[0], c[1], c[2]);
    return;
  }
  if (name.endsWith('_wool')) { base(WOOL[name.slice(0, -5)] ?? [200, 200, 200], 14); return; }
  if (ORES[name]) {
    base(COLORS.stone, 30);
    const c = ORES[name];
    for (let i = 0; i < 6; i++) {
      const x = 2 + Math.floor(n(i, 1, 9) * 12), y = 2 + Math.floor(n(i, 2, 9) * 12);
      set(x, y, c[0], c[1], c[2]); set(x + 1, y, c[0] * 0.8, c[1] * 0.8, c[2] * 0.8); set(x, y + 1, c[0] * 0.9, c[1] * 0.9, c[2] * 0.9);
    }
    return;
  }
  const c = COLORS[name];
  if (c) {
    base(c, name === 'stone' ? 26 : 30);
    if (name.endsWith('_planks')) for (let y = 3; y < 16; y += 4) for (let x = 0; x < 16; x++) set(x, y, c[0] * 0.7, c[1] * 0.7, c[2] * 0.7);
    if (name.endsWith('_log') && name !== 'birch_log') for (let x = 1; x < 16; x += 3) for (let y = 0; y < 16; y++) set(x, y, c[0] * 0.75, c[1] * 0.75, c[2] * 0.75);
    if (name === 'birch_log') for (let i = 0; i < 9; i++) { const x = Math.floor(n(i, 0, 3) * 14), y = Math.floor(n(i, 1, 3) * 16); set(x, y, 40, 40, 40); set(x + 1, y, 50, 50, 50); }
    if (name.endsWith('_log_top')) for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const r = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5));
      if (r > 6.5) set(x, y, c[0] * 0.6, c[1] * 0.6, c[2] * 0.6); else if (Math.round(r) % 2 === 0) set(x, y, c[0] * 0.85, c[1] * 0.85, c[2] * 0.85);
    }
    if (name === 'bricks' || name.includes('stone_bricks')) for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const mortar = y % 4 === 3 || (x + (Math.floor(y / 4) % 2) * 4) % 8 === 7;
      if (mortar) set(x, y, name === 'bricks' ? 180 : 90, name === 'bricks' ? 170 : 90, name === 'bricks' ? 160 : 90);
    }
    if (name === 'cobblestone' || name === 'mossy_cobblestone') for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      if (n(Math.floor(x / 4), Math.floor(y / 4), 11) < 0.3 && (x % 4 === 0 || y % 4 === 0)) set(x, y, 80, 80, 80);
    }
    if (name.startsWith('cactus')) for (let y = 0; y < 16; y++) { set(0, y, 0, 0, 0, 0); set(15, y, 0, 0, 0, 0); }
    return;
  }
  // items and anything else: a simple diagonal sprite on a transparent background
  px.fill(0);
  for (let i = 2; i < 14; i++) { set(i, 15 - i, 140, 110, 70); set(i + 1, 15 - i, 110, 85, 50); }
}

function clamp8(v) {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

/** generateTextures()-compatible placeholder: { size: 16, layers, data }. */
export function placeholderTextures() {
  const layers = TEXTURE_LAYER_COUNT;
  const data = new Uint8Array(16 * 16 * 4 * layers);
  const px = new Uint8Array(16 * 16 * 4);
  for (const t of TEXTURES) {
    for (let f = 0; f < t.frames; f++) {
      px.fill(255);
      paintTexture(t.name, f, px);
      data.set(px, (t.layer + f) * 1024);
    }
  }
  return { size: 16, layers, data };
}

// ---------------------------------------------------------------------------------------------------
// Mock EntityRenderer (verifies the §9.5 ctx contract: camera-relative drawing, fog, light, hand pass)
// ---------------------------------------------------------------------------------------------------

const MOCK_VS = `#version 300 es
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
uniform mat4 uViewProj;
uniform vec3 uOffset;
uniform float uScale;
uniform float uSpin;
out vec3 vRel;
out vec3 vN;
out vec2 vUV;
void main() {
  float c = cos(uSpin), s = sin(uSpin);
  vec3 p = aPos - vec3(0.5, 0.0, 0.5);
  p = vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z) * uScale;
  vec3 n = vec3(c * aNormal.x + s * aNormal.z, aNormal.y, -s * aNormal.x + c * aNormal.z);
  vRel = p + uOffset;
  vN = n;
  vUV = abs(aNormal.y) > 0.5 ? aPos.xz : (abs(aNormal.x) > 0.5 ? vec2(aPos.z, 1.0 - aPos.y) : vec2(aPos.x, 1.0 - aPos.y));
  gl_Position = uViewProj * vec4(vRel, 1.0);
}`;
const MOCK_FS = `#version 300 es
precision highp float;
precision highp sampler2DArray;
uniform sampler2DArray uTex;
uniform float uLayer;
uniform vec3 uFogColor;
uniform vec2 uFog;
uniform vec2 uLight;
uniform float uDaylight;
uniform vec3 uSkyTint;
in vec3 vRel;
in vec3 vN;
in vec2 vUV;
out vec4 o;
float lightCurve(float l) { return l / (4.0 - 3.0 * l); }
vec3 lightColor(float sky, float blk, float daylight, vec3 skyTint) {
  vec3 s = vec3(lightCurve(sky) * daylight) * skyTint;
  vec3 b = vec3(lightCurve(blk)) * vec3(1.0, 0.92, 0.82);
  return max(max(s, b), vec3(0.035));
}
void main() {
  vec4 t = texture(uTex, vec3(vUV, uLayer));
  float shade = vN.y > 0.5 ? 1.0 : vN.y < -0.5 ? 0.5 : abs(vN.x) > 0.5 ? 0.6 : 0.8;
  vec3 col = t.rgb * shade * lightColor(uLight.x, uLight.y, uDaylight, uSkyTint);
  float f = clamp((length(vRel) - uFog.x) / max(uFog.y - uFog.x, 1e-3), 0.0, 1.0);
  o = vec4(mix(col, uFogColor, f), 1.0);
}`;

export class MockEntityRenderer {
  constructor(gl, textureArray) {
    this.gl = gl;
    this.texture = textureArray;
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, MOCK_VS));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, MOCK_FS));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    this.program = p;
    this.u = {};
    for (const n of ['uViewProj', 'uOffset', 'uScale', 'uSpin', 'uTex', 'uLayer', 'uFogColor', 'uFog', 'uLight', 'uDaylight', 'uSkyTint']) {
      this.u[n] = gl.getUniformLocation(p, n);
    }
    // unit cube with normals, CCW outside
    const v = [];
    const faces = [
      [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 0]], [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0], [-1, 0, 0]],
      [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0], [0, 1, 0]], [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1], [0, -1, 0]],
      [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1], [0, 0, 1]], [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, -1]],
    ];
    for (const [a, b, c, d, nn] of faces) for (const q of [a, b, c, a, c, d]) v.push(...q, ...nn);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(v), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    gl.bindVertexArray(null);
    this.handProj = new Float32Array(16);
    this.calls = { entities: 0, particles: 0, hand: 0 };
  }

  _begin(ctx, viewProj) {
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.uniformMatrix4fv(this.u.uViewProj, false, viewProj);
    gl.uniform1i(this.u.uTex, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, ctx.texture);
    gl.uniform3f(this.u.uFogColor, ctx.fogColor[0], ctx.fogColor[1], ctx.fogColor[2]);
    gl.uniform2f(this.u.uFog, ctx.fogStart, ctx.fogEnd);
    gl.uniform1f(this.u.uDaylight, ctx.daylight);
    gl.uniform3f(this.u.uSkyTint, ctx.skyTint[0], ctx.skyTint[1], ctx.skyTint[2]);
    gl.bindVertexArray(this.vao);
  }

  _cube(ctx, x, y, z, scale, spin, layer, light) {
    const gl = this.gl;
    gl.uniform3f(this.u.uOffset, x - ctx.cameraPos[0], y - ctx.cameraPos[1], z - ctx.cameraPos[2]);
    gl.uniform1f(this.u.uScale, scale);
    gl.uniform1f(this.u.uSpin, spin);
    gl.uniform1f(this.u.uLayer, layer);
    gl.uniform2f(this.u.uLight, ((light >> 4) & 15) / 15, (light & 15) / 15);
    gl.drawArrays(gl.TRIANGLES, 0, 36);
  }

  renderEntities(ctx, items) {
    this.calls.entities++;
    this._begin(ctx, ctx.viewProj);
    for (const it of items) {
      const id = it.kind === 'block' ? it.blockId : it.itemId;
      const layer = FACE_LAYERS[(id & 255) * 6 + 2];
      const bob = it.kind === 'item' ? Math.sin((it.age ?? 0) * 2 + (it.seed ?? 0) * 6) * 0.08 + 0.15 : 0;
      this._cube(ctx, it.x, it.y + bob, it.z, it.scale ?? 0.25, it.kind === 'item' ? (it.age ?? 0) + (it.seed ?? 0) * 6 : 0, layer, it.light ?? 0xf0);
    }
  }

  renderParticles(ctx, particles) {
    this.calls.particles++;
    this._begin(ctx, ctx.viewProj);
    const d = particles.data;
    for (let i = 0; i < particles.count; i++) {
      const o = i * 12;
      this._cube(ctx, d[o], d[o + 1], d[o + 2], d[o + 3], 0, d[o + 4], d[o + 11]);
    }
  }

  renderHand(ctx, hand) {
    this.calls.hand++;
    const gl = this.gl;
    gl.clear(gl.DEPTH_BUFFER_BIT);
    // own projection (fov 70) with an arbitrary "held block" placement in the lower right
    const f = 1 / Math.tan(35 * Math.PI / 180), near = 0.05, far = 10, nf = 1 / (near - far);
    const m = this.handProj;
    m.fill(0);
    m[0] = f / ctx.aspect; m[5] = f; m[10] = (far + near) * nf; m[11] = -1; m[14] = 2 * far * near * nf;
    this._begin({ ...ctx, cameraPos: [0, 0, 0], fogStart: 100, fogEnd: 200 }, m);
    const swing = Math.sin((hand.swing ?? 0) * Math.PI);
    const layer = FACE_LAYERS[(hand.itemId & 255) * 6 + 4];
    this._cube({ cameraPos: [0, 0, 0] }, 0.56 - swing * 0.2, -0.62 + (hand.bobY ?? 0) - swing * 0.1, -0.9, 0.4, 0.75, layer, hand.light ?? 0xf0);
  }
}
