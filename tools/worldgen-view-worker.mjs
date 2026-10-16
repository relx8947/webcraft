// Worker for the 3D preview of tools/worldgen-map.html (mode=view): generates the chunks around the
// camera itself and raymarches a band of image rows (DDA voxel traversal, sun shadows, AO, water).
import { WorldGenerator } from '../src/world/worldgen.js';
import { BLOCK, BLOCKS, RENDER_TYPE, RENDER, IS_LIQUID } from '../src/world/registry.js';

let gen = null;
let area = null; // { cx0, cz0, n, chunks: Uint8Array[], grass: Uint32Array[], foliage: Uint32Array[] }

const AIR = BLOCK.AIR;
const WATER = BLOCK.WATER;
const COLORS = new Float32Array(256 * 3);
function setc(name, r, g, b) {
  const id = BLOCK[name.toUpperCase()];
  COLORS[id * 3] = r / 255; COLORS[id * 3 + 1] = g / 255; COLORS[id * 3 + 2] = b / 255;
}
for (let i = 0; i < 256; i++) { COLORS[i * 3] = 1; COLORS[i * 3 + 1] = 0; COLORS[i * 3 + 2] = 1; }
setc('stone', 125, 125, 125); setc('dirt', 134, 96, 67); setc('grass_block', 255, 255, 255); setc('sand', 219, 207, 163);
setc('gravel', 131, 124, 122); setc('sandstone', 216, 203, 155); setc('snowy_grass_block', 238, 245, 250);
setc('snow_block', 245, 251, 255); setc('ice', 160, 190, 250); setc('water', 40, 80, 200); setc('lava', 255, 110, 20);
setc('clay', 160, 166, 179); setc('bedrock', 70, 70, 70); setc('oak_log', 109, 85, 50); setc('oak_log_x', 109, 85, 50);
setc('oak_log_z', 109, 85, 50); setc('birch_log', 216, 215, 210); setc('spruce_log', 70, 52, 32);
setc('oak_leaves', 255, 255, 255); setc('birch_leaves', 128, 167, 85); setc('spruce_leaves', 97, 153, 97);
setc('cactus', 85, 127, 43); setc('dead_bush', 148, 108, 60); setc('sugar_cane', 255, 255, 255);
setc('short_grass', 255, 255, 255); setc('fern', 255, 255, 255); setc('dandelion', 250, 230, 40);
setc('poppy', 220, 30, 30); setc('cornflower', 80, 120, 235); setc('oxeye_daisy', 245, 245, 235);
setc('brown_mushroom', 150, 110, 80); setc('red_mushroom', 215, 40, 40); setc('pumpkin', 225, 135, 30);
setc('granite', 154, 106, 89); setc('diorite', 188, 188, 190); setc('andesite', 136, 136, 138);
setc('coal_ore', 90, 90, 90); setc('iron_ore', 170, 150, 135); setc('gold_ore', 200, 180, 90);
setc('diamond_ore', 120, 200, 200); setc('redstone_ore', 170, 90, 90); setc('lapis_ore', 90, 100, 170);
const TINT = new Uint8Array(256); // 1 grass, 2 foliage, 3 grass-side (grass block sides: top tinted only)
TINT[BLOCK.GRASS_BLOCK] = 1; TINT[BLOCK.SHORT_GRASS] = 1; TINT[BLOCK.FERN] = 1; TINT[BLOCK.SUGAR_CANE] = 1;
TINT[BLOCK.OAK_LEAVES] = 2;
const LEAVES = new Uint8Array(256);
LEAVES[BLOCK.OAK_LEAVES] = LEAVES[BLOCK.BIRCH_LEAVES] = LEAVES[BLOCK.SPRUCE_LEAVES] = 1;
const CROSS = new Uint8Array(256);
for (const b of BLOCKS) if (RENDER_TYPE[b.id] === RENDER.CROSS) CROSS[b.id] = 1;
const OPAQUE_FOR_AO = new Uint8Array(256);
for (const b of BLOCKS) OPAQUE_FOR_AO[b.id] = b.opaque ? 1 : 0;

function hash(x, y, z) {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(z, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function loadArea(cx0, cz0, n) {
  const chunks = new Array(n * n);
  const grass = new Array(n * n);
  const foliage = new Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      chunks[j * n + i] = gen.generateChunk(cx0 + i, cz0 + j);
      const t = gen.getTints(cx0 + i, cz0 + j);
      grass[j * n + i] = t.grass;
      foliage[j * n + i] = t.foliage;
    }
  }
  area = { cx0, cz0, n, chunks, grass, foliage };
}

// Tree gallery: flat grass area with trees grown through WorldGenerator.growTree (sapling path).
function loadGallery(cx0, cz0, n, kinds) {
  const chunks = new Array(n * n);
  const grass = new Array(n * n);
  const foliage = new Array(n * n);
  for (let k = 0; k < n * n; k++) {
    const b = new Uint8Array(65536);
    for (let i = 0; i < 256; i++) {
      b[i] = BLOCK.BEDROCK;
      for (let y = 1; y < 63; y++) b[(y << 8) | i] = BLOCK.DIRT;
      b[(63 << 8) | i] = BLOCK.GRASS_BLOCK;
    }
    chunks[k] = b;
    grass[k] = new Uint32Array(256).fill(0x59bd91);
    foliage[k] = new Uint32Array(256).fill(0x2fab77);
  }
  area = { cx0, cz0, n, chunks, grass, foliage };
  const access = {
    getBlock: (x, y, z) => { const id = getBlock(x, y, z); return id === 255 ? BLOCK.STONE : id; },
    setBlock: (x, y, z, id) => {
      const i = (x >> 4) - area.cx0, j = (z >> 4) - area.cz0;
      if (i < 0 || j < 0 || i >= n || j >= n || y < 0 || y > 255) return;
      area.chunks[j * n + i][(y << 8) | ((z & 15) << 4) | (x & 15)] = id;
    },
  };
  const results = [];
  let seed = 1;
  kinds.forEach((kind, row) => {
    for (let c = 0; c < 4; c++) {
      const x = cx0 * 16 + 6 + row * 12, z = cz0 * 16 + 8 + c * 11;
      let rs = (seed++ * 2654435761) >>> 0;
      const rng = () => { rs = (rs + 0x6d2b79f5) | 0; let t = Math.imul(rs ^ (rs >>> 15), 1 | rs); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
      results.push(gen.growTree(access, x, 64, z, kind, rng));
    }
  });
  return results;
}

function getBlock(x, y, z) {
  if (y < 0 || y > 255) return AIR;
  const i = (x >> 4) - area.cx0;
  const j = (z >> 4) - area.cz0;
  if (i < 0 || j < 0 || i >= area.n || j >= area.n) return AIR; // outside the loaded area = air
  return area.chunks[j * area.n + i][(y << 8) | ((z & 15) << 4) | (x & 15)];
}
function tintAt(x, z, kind) {
  const i = (x >> 4) - area.cx0;
  const j = (z >> 4) - area.cz0;
  const arr = kind === 1 ? area.grass[j * area.n + i] : area.foliage[j * area.n + i];
  const p = arr[((z & 15) << 4) | (x & 15)];
  return p;
}

// sky colour for a direction
function sky(dy, out) {
  const t = Math.max(0, Math.min(1, dy * 1.6 + 0.15));
  out[0] = 0.72 * (1 - t) + 0.36 * t;
  out[1] = 0.83 * (1 - t) + 0.55 * t;
  out[2] = 0.98 * (1 - t) + 0.93 * t;
}

const SUN = (() => { const v = [0.45, 0.72, 0.35]; const l = Math.hypot(...v); return v.map((c) => c / l); })();

// Trace a ray; returns hit info in `hit` (id, t, face normal axis/sign, cell, point) or false.
// Leaves use a texel cutout pattern; cross plants intersect their two diagonal planes.
function trace(ox, oy, oz, dx, dy, dz, maxT, hit, skipWater, shadow) {
  let x = Math.floor(ox), y = Math.floor(oy), z = Math.floor(oz);
  const sx = dx > 0 ? 1 : -1, sy = dy > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1;
  const tdx = Math.abs(1 / dx), tdy = Math.abs(1 / dy), tdz = Math.abs(1 / dz);
  let tmx = dx > 0 ? (x + 1 - ox) * tdx : (ox - x) * tdx;
  let tmy = dy > 0 ? (y + 1 - oy) * tdy : (oy - y) * tdy;
  let tmz = dz > 0 ? (z + 1 - oz) * tdz : (oz - z) * tdz;
  let t = 0;
  let axis = -1;
  hit.waterT = -1;
  for (let it = 0; it < 2000 && t < maxT; it++) {
    const id = getBlock(x, y, z);
    if (id === 255) return false;
    const tExit = Math.min(tmx, tmy, tmz);
    if (id !== AIR) {
      if (id === WATER) {
        if (hit.waterT < 0) { hit.waterT = t; hit.waterAxis = axis; }
      } else if (CROSS[id]) {
        if (!shadow || hash(x, y, z) < 0.3) {
          // diagonal planes x - z = 0 and x + z = 1 (cell local)
          for (let p = 0; p < 2; p++) {
            const lx = ox - x, lz = oz - z;
            const den = p === 0 ? dx - dz : dx + dz;
            if (Math.abs(den) < 1e-9) continue;
            const tp = p === 0 ? -(lx - lz) / den : (1 - lx - lz) / den;
            if (tp < t - 1e-6 || tp > tExit + 1e-6) continue;
            const px = lx + dx * tp, py = oy + dy * tp - y, pz = lz + dz * tp;
            if (px < 0.12 || px > 0.88 || py < 0 || py > 0.9) continue;
            // blade/petal cutout pattern
            const u = Math.floor(px * 16), v = Math.floor(py * 16);
            const keep = id === BLOCK.SUGAR_CANE ? (u % 4 !== 0) : hash(u + p * 31, v, id) < 0.85 - py * 0.55;
            if (!keep) continue;
            hit.id = id; hit.t = tp; hit.x = x; hit.y = y; hit.z = z; hit.axis = 1; hit.sign = 1; hit.cross = true;
            hit.u = px; hit.v = py;
            return true;
          }
        }
      } else if (LEAVES[id]) {
        // cutout: entry face texel decides
        const px = ox + dx * t, py = oy + dy * t, pz = oz + dz * t;
        const u = Math.floor((axis === 0 ? pz : px) * 16), v = Math.floor((axis === 1 ? pz : py) * 16);
        if (hash(u, v, x * 7 + y * 13 + z * 3) > 0.22 || axis < 0) {
          hit.id = id; hit.t = t; hit.x = x; hit.y = y; hit.z = z; hit.axis = axis; hit.sign = axis === 0 ? -sx : axis === 1 ? -sy : -sz; hit.cross = false;
          return true;
        }
      } else if (!(IS_LIQUID[id]) || id === BLOCK.LAVA) {
        hit.id = id; hit.t = t; hit.x = x; hit.y = y; hit.z = z; hit.axis = axis;
        hit.sign = axis === 0 ? -sx : axis === 1 ? -sy : -sz; hit.cross = false;
        return true;
      }
    }
    if (tmx < tmy && tmx < tmz) { x += sx; t = tmx; tmx += tdx; axis = 0; }
    else if (tmy < tmz) { y += sy; t = tmy; tmy += tdy; axis = 1; }
    else { z += sz; t = tmz; tmz += tdz; axis = 2; }
    if (y < 0 || y > 255) return false;
  }
  return false;
}

function aoAt(hit, px, py, pz) {
  if (hit.cross || hit.axis < 0) return 1;
  const nx = hit.axis === 0 ? hit.sign : 0, ny = hit.axis === 1 ? hit.sign : 0, nz = hit.axis === 2 ? hit.sign : 0;
  const cx = hit.x + nx, cy = hit.y + ny, cz = hit.z + nz;
  // tangent axes
  const ta = hit.axis === 0 ? [0, 1, 0] : [1, 0, 0];
  const tb = hit.axis === 2 ? [0, 1, 0] : [0, 0, 1];
  const fu = hit.axis === 0 ? py - hit.y : px - hit.x;
  const fv = hit.axis === 2 ? py - hit.y : pz - hit.z;
  let occ = 0;
  const sample = (a, b, w) => {
    const id = getBlock(cx + ta[0] * a + tb[0] * b, cy + ta[1] * a + tb[1] * b, cz + ta[2] * a + tb[2] * b);
    if (id !== 255 && OPAQUE_FOR_AO[id]) occ += w;
  };
  sample(-1, 0, 1 - fu); sample(1, 0, fu); sample(0, -1, 1 - fv); sample(0, 1, fv);
  sample(-1, -1, (1 - fu) * (1 - fv)); sample(1, -1, fu * (1 - fv)); sample(-1, 1, (1 - fu) * fv); sample(1, 1, fu * fv);
  return 1 - Math.min(0.55, occ * 0.22);
}

function render(cam, W, H, row0, row1) {
  const out = new Uint8ClampedArray(W * (row1 - row0) * 4);
  const hit = {}, sh = {};
  const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw), cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
  const f = [-sy * cp, sp, -cy * cp];
  const r = [cy, 0, -sy];
  const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
  const th = Math.tan((cam.fov * Math.PI / 180) / 2);
  const aspect = W / H;
  const skyc = [0, 0, 0];
  for (let py = row0; py < row1; py++) {
    for (let px = 0; px < W; px++) {
      const ndx = ((px + 0.5) / W * 2 - 1) * th * aspect;
      const ndy = (1 - (py + 0.5) / H * 2) * th;
      let dx = f[0] + r[0] * ndx + u[0] * ndy, dy = f[1] + r[1] * ndx + u[1] * ndy, dz = f[2] + r[2] * ndx + u[2] * ndy;
      const dl = Math.hypot(dx, dy, dz); dx /= dl; dy /= dl; dz /= dl;
      sky(dy, skyc);
      let cr = skyc[0], cg = skyc[1], cb = skyc[2];
      const maxT = cam.far;
      const ok = trace(cam.x, cam.y, cam.z, dx, dy, dz, maxT, hit, false, false);
      const waterT = hit.waterT;
      if (ok) {
        const id = hit.id;
        let br = COLORS[id * 3], bg = COLORS[id * 3 + 1], bb = COLORS[id * 3 + 2];
        const hx = cam.x + dx * hit.t, hy = cam.y + dy * hit.t, hz = cam.z + dz * hit.t;
        let tk = TINT[id];
        if (id === BLOCK.GRASS_BLOCK && !(hit.axis === 1 && hit.sign > 0)) {
          // grass side: green fringe at the top, dirt below
          const vy = hy - hit.y;
          if (hit.axis === 1) { tk = 0; br = 134 / 255; bg = 96 / 255; bb = 67 / 255; }
          else if (vy < 0.8 - hash(Math.floor((hit.axis === 0 ? hz : hx) * 16), hit.y, 9) * 0.25) { tk = 0; br = 134 / 255; bg = 96 / 255; bb = 67 / 255; }
        }
        if (id === BLOCK.SNOWY_GRASS_BLOCK && hit.axis !== 1) {
          const vy = hy - hit.y;
          if (vy < 0.78) { br = 134 / 255; bg = 96 / 255; bb = 67 / 255; }
        }
        if (tk) {
          const p = tintAt(hit.x, hit.z, tk);
          br *= (p & 255) / 255; bg *= ((p >> 8) & 255) / 255; bb *= ((p >> 16) & 255) / 255;
        }
        // texel noise (pixel-art feel)
        const tu = Math.floor((hit.axis === 0 ? hz : hx) * 16), tv = Math.floor((hit.axis === 1 ? hz : hy) * 16);
        const n = 0.86 + 0.24 * hash(tu, tv, id * 7 + (hit.axis + 1) * 101);
        br *= n; bg *= n; bb *= n;
        // lighting
        let nx = 0, ny = 1, nz = 0;
        if (!hit.cross && hit.axis >= 0) { nx = hit.axis === 0 ? hit.sign : 0; ny = hit.axis === 1 ? hit.sign : 0; nz = hit.axis === 2 ? hit.sign : 0; }
        const faceShade = hit.cross ? 0.9 : hit.axis === 1 ? (hit.sign > 0 ? 1.0 : 0.5) : hit.axis === 0 ? 0.62 : 0.8;
        let diff = hit.cross ? 0.75 : Math.max(0, nx * SUN[0] + ny * SUN[1] + nz * SUN[2]);
        if (diff > 0) {
          const ox = hx + nx * 0.002 + SUN[0] * 0.01, oy = hy + ny * 0.002 + SUN[1] * 0.01, oz = hz + nz * 0.002 + SUN[2] * 0.01;
          if (trace(ox, oy, oz, SUN[0], SUN[1], SUN[2], 140, sh, true, true)) diff = 0;
        }
        const ao = aoAt(hit, hx, hy, hz);
        let light = (0.5 * faceShade + 0.62 * diff) * ao;
        if (id === BLOCK.LAVA) light = 1.3;
        cr = br * light * 1.05; cg = bg * light; cb = bb * light * 0.97;
        // underground darkness: cells without sky access are dim
        // fog
        const fd = Math.min(1, Math.max(0, (hit.t - cam.far * 0.45) / (cam.far * 0.55)));
        const fogk = fd * fd;
        sky(Math.max(0.02, dy), skyc);
        cr = cr * (1 - fogk) + skyc[0] * fogk; cg = cg * (1 - fogk) + skyc[1] * fogk; cb = cb * (1 - fogk) + skyc[2] * fogk;
      }
      if (waterT >= 0 && (!ok || hit.t > waterT)) {
        const wd = (ok ? hit.t : waterT + 40) - waterT;
        const a = 1 - Math.exp(-wd * 0.16);
        const wc = [0.12, 0.27, 0.62];
        cr = cr * (1 - a) + wc[0] * a; cg = cg * (1 - a) + wc[1] * a; cb = cb * (1 - a) + wc[2] * a;
        // surface reflection (Fresnel-ish) when entering from above
        if (hit.waterAxis === 1 && dy < 0) {
          const fr = 0.08 + 0.6 * Math.pow(1 - Math.abs(dy), 5);
          sky(-dy, skyc);
          cr = cr * (1 - fr) + skyc[0] * fr; cg = cg * (1 - fr) + skyc[1] * fr; cb = cb * (1 - fr) + skyc[2] * fr;
        }
        const fd = Math.min(1, Math.max(0, (waterT - cam.far * 0.45) / (cam.far * 0.55)));
        const fogk = fd * fd;
        sky(0.02, skyc);
        cr = cr * (1 - fogk) + skyc[0] * fogk; cg = cg * (1 - fogk) + skyc[1] * fogk; cb = cb * (1 - fogk) + skyc[2] * fogk;
      }
      const k = ((py - row0) * W + px) * 4;
      out[k] = Math.pow(Math.min(1, cr), 0.92) * 255;
      out[k + 1] = Math.pow(Math.min(1, cg), 0.92) * 255;
      out[k + 2] = Math.pow(Math.min(1, cb), 0.92) * 255;
      out[k + 3] = 255;
    }
  }
  return out;
}

self.onmessage = (ev) => {
  const m = ev.data;
  try {
    if (m.type === 'init') {
      gen = new WorldGenerator(m.seed, m.worldType || 'default');
      self.postMessage({ type: 'ready' });
    } else if (m.type === 'view') {
      const c = m.cam;
      const n = m.radius * 2 + 1;
      const cx0 = Math.floor(c.x / 16) - m.radius;
      const cz0 = Math.floor(c.z / 16) - m.radius;
      if (m.gallery) {
        if (!area || !area.gallery) { loadGallery(0, 0, n, m.gallery); area.gallery = true; }
      } else if (!area || area.cx0 !== cx0 || area.cz0 !== cz0 || area.n !== n) loadArea(cx0, cz0, n);
      const px = render(c, m.width, m.height, m.row0, m.row1);
      self.postMessage({ type: 'view', id: m.id, out: { row0: m.row0, row1: m.row1, px } }, [px.buffer]);
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err && err.stack || err) });
  }
};
