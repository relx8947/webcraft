// Visual test page script for the lighting + meshing pipeline (tools/mesher-preview.html).
// Builds a 5x5-chunk world (hand-made showcase or synthetic terrain), meshes the inner 3x3 chunks
// with the real worker pipeline (buildRegion -> computeLight -> meshChunk) and draws them with a
// minimal WebGL2 renderer implementing the SPEC §9.3 terrain shading (lightCurve/lightColor,
// FACE_SHADE, AO_CURVE, fog, alpha modes, liquid frames, plant/leaf sway).
// Textures: the real src/render/textures.js when available, otherwise a built-in procedural set.

import { buildRegion, computeLight } from '../src/world/lighting.js';
import { meshChunk } from '../src/world/mesher.js';
import { BLOCK, TEXTURES, TEXTURE_LAYER_COUNT } from '../src/world/registry.js';
import { REGION_VOLUME, FACE_SHADE, computeDaylight } from '../src/config.js';
import { mat4Create, mat4Perspective, mat4ViewRotation, mat4Multiply } from '../src/util/math.js';
import { createTerrain } from './mesher-terrain.mjs';

const params = new URLSearchParams(location.search);
const SCENE = params.get('scene') || 'showcase';
const VIEW = Number(params.get('view') || 0);
const TIME = params.has('t') ? Number(params.get('t')) : 0.18;
const SMOOTH = params.get('smooth') !== '0';
const DEBUG_TEX = params.get('tex') === 'debug';
const info = document.getElementById('info');

// -------------------------------------------------------------------------------------------
// World
// -------------------------------------------------------------------------------------------
const chunks = new Map();     // 'cx,cz' -> Uint8Array(65536)
const key = (cx, cz) => `${cx},${cz}`;
function chunkAt(cx, cz) {
  let c = chunks.get(key(cx, cz));
  if (!c) { c = new Uint8Array(65536); chunks.set(key(cx, cz), c); }
  return c;
}
function setBlock(x, y, z, id) {
  if (y < 0 || y > 255) return;
  chunkAt(x >> 4, z >> 4)[(y << 8) | ((z & 15) << 4) | (x & 15)] = id;
}
function getBlock(x, y, z) {
  const c = chunks.get(key(x >> 4, z >> 4));
  return c && y >= 0 && y < 256 ? c[(y << 8) | ((z & 15) << 4) | (x & 15)] : 0;
}
function fill(x0, y0, z0, x1, y1, z1, id) {
  for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) setBlock(x, y, z, id);
}

let tintSource = null;

function buildShowcase() {
  // Flat ground: bedrock, stone, dirt, grass top at y = 63, over a 5x5 chunk area.
  fill(-32, 0, -32, 47, 0, 47, BLOCK.BEDROCK);
  fill(-32, 1, -32, 47, 59, 47, BLOCK.STONE);
  fill(-32, 60, -32, 47, 62, 47, BLOCK.DIRT);
  fill(-32, 63, -32, 47, 63, 47, BLOCK.GRASS_BLOCK);
  const G = 64;   // first free layer

  // Row of cube blocks (orientation/rotation/tint test) along z = -6.
  const row = [BLOCK.STONE, BLOCK.COBBLESTONE, BLOCK.OAK_PLANKS, BLOCK.BRICKS, BLOCK.STONE_BRICKS, BLOCK.OAK_LOG,
    BLOCK.OAK_LOG_X, BLOCK.OAK_LOG_Z, BLOCK.BIRCH_LOG, BLOCK.SPRUCE_LOG_X, BLOCK.CRAFTING_TABLE, BLOCK.FURNACE,
    BLOCK.BOOKSHELF, BLOCK.TNT, BLOCK.PUMPKIN, BLOCK.JACK_O_LANTERN, BLOCK.GLOWSTONE, BLOCK.DIAMOND_ORE,
    BLOCK.GOLD_BLOCK, BLOCK.RED_WOOL, BLOCK.SNOW_BLOCK, BLOCK.SANDSTONE];
  row.forEach((id, i) => setBlock(-14 + i * 2, G, -6, id));
  // Two-high variant for logs to show grain continuity.
  setBlock(-4, G + 1, -6, BLOCK.OAK_LOG);
  setBlock(-2, G + 1, -6, BLOCK.OAK_LOG_X);
  setBlock(-1, G, -6, BLOCK.OAK_LOG_X);
  setBlock(0, G + 1, -6, BLOCK.OAK_LOG_Z);
  setBlock(0, G, -7, BLOCK.OAK_LOG_Z);

  // Aquarium: glass box with water (water against glass must stay visible).
  fill(2, G, 4, 7, G + 2, 8, BLOCK.GLASS);
  fill(3, G, 5, 6, G + 1, 7, BLOCK.WATER);
  fill(3, G + 2, 5, 6, G + 2, 7, BLOCK.AIR);

  // Pond dug into the grass + a waterfall column (full-height water next to a lowered surface).
  fill(-8, 61, 3, -3, 63, 8, BLOCK.WATER);
  fill(-8, 60, 3, -3, 60, 8, BLOCK.SAND);
  fill(-2, 63, 5, -2, G + 3, 5, BLOCK.WATER);
  setBlock(-2, 63, 6, BLOCK.WATER);
  fill(-9, 63, 2, -9, 63, 9, BLOCK.SAND);
  setBlock(-9, 64, 4, BLOCK.SUGAR_CANE); setBlock(-9, 65, 4, BLOCK.SUGAR_CANE); setBlock(-9, 66, 4, BLOCK.SUGAR_CANE);
  setBlock(-9, 64, 7, BLOCK.SUGAR_CANE); setBlock(-9, 65, 7, BLOCK.SUGAR_CANE);
  setBlock(-5, 63, 2, BLOCK.SAND);
  // Ice floating on the pond.
  setBlock(-6, 63, 7, BLOCK.ICE); setBlock(-7, 63, 7, BLOCK.ICE);

  // Lava pool.
  fill(10, 62, 4, 12, 63, 6, BLOCK.LAVA);
  fill(9, 63, 3, 13, 63, 3, BLOCK.COBBLESTONE);

  // Desert patch with cacti and a dead bush.
  fill(10, 63, 9, 15, 63, 14, BLOCK.SAND);
  setBlock(11, G, 10, BLOCK.CACTUS);
  setBlock(13, G, 11, BLOCK.CACTUS); setBlock(13, G + 1, 11, BLOCK.CACTUS);
  setBlock(11, G, 13, BLOCK.CACTUS); setBlock(11, G + 1, 13, BLOCK.CACTUS); setBlock(11, G + 2, 13, BLOCK.CACTUS);
  setBlock(14, G, 13, BLOCK.DEAD_BUSH);

  // Plants.
  const plants = [BLOCK.SHORT_GRASS, BLOCK.FERN, BLOCK.DANDELION, BLOCK.POPPY, BLOCK.CORNFLOWER, BLOCK.OXEYE_DAISY,
    BLOCK.OAK_SAPLING, BLOCK.BIRCH_SAPLING, BLOCK.SPRUCE_SAPLING, BLOCK.BROWN_MUSHROOM, BLOCK.RED_MUSHROOM];
  plants.forEach((id, i) => setBlock(-12 + i, G, 11, id));
  for (let i = 0; i < 40; i++) {
    const x = -14 + ((i * 7) % 12), z = 13 + ((i * 5) % 4);
    if (getBlock(x, G, z) === 0) setBlock(x, G, z, i % 5 === 0 ? BLOCK.POPPY : BLOCK.SHORT_GRASS);
  }

  // Trees.
  const tree = (x, z, log, leaves, h) => {
    for (let y = G; y < G + h; y++) setBlock(x, y, z, log);
    for (let y = G + h - 3; y <= G + h; y++) {
      const r = y >= G + h - 1 ? 1 : 2;
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (Math.abs(dx) === r && Math.abs(dz) === r && (y === G + h || (x + dx + z + dz + y) & 1)) continue;
          if (getBlock(x + dx, y, z + dz) === 0) setBlock(x + dx, y, z + dz, leaves);
        }
      }
    }
  };
  tree(2, 24, BLOCK.OAK_LOG, BLOCK.OAK_LEAVES, 5);
  tree(8, 27, BLOCK.BIRCH_LOG, BLOCK.BIRCH_LEAVES, 6);
  tree(14, 23, BLOCK.SPRUCE_LOG, BLOCK.SPRUCE_LEAVES, 7);
  tree(24, 20, BLOCK.OAK_LOG, BLOCK.OAK_LEAVES, 5);

  // Stone hut with a doorway and torches (block light + sideways sky light + AO).
  fill(18, G, -14, 26, G + 4, -6, BLOCK.STONE_BRICKS);
  fill(19, G, -13, 25, G + 3, -7, BLOCK.AIR);
  fill(22, G, -6, 22, G + 1, -6, BLOCK.AIR);           // door (south)
  fill(25, G + 1, -11, 25, G + 2, -9, BLOCK.AIR);      // window (east wall)
  fill(26, G + 1, -11, 26, G + 2, -9, BLOCK.AIR);
  setBlock(19, G, -13, BLOCK.TORCH);
  setBlock(24, G, -8, BLOCK.CRAFTING_TABLE);
  setBlock(24, G + 1, -8, BLOCK.TORCH);
  setBlock(20, G, -8, BLOCK.FURNACE);

  // Overhang + staircase (AO and smooth light gradients).
  fill(-15, G, 17, -8, G + 3, 17, BLOCK.COBBLESTONE);       // back wall
  fill(-15, G + 3, 18, -8, G + 3, 22, BLOCK.COBBLESTONE);   // roof, open to the south/east/west
  setBlock(-12, G, 18, BLOCK.TORCH);
  for (let i = 0; i < 5; i++) fill(-16 + i, G, 0, -16 + i, G + i, 2, BLOCK.STONE);

  // Torches on posts.
  for (const [x, z] of [[0, 0], [5, 0], [10, 0], [-5, 0]]) { setBlock(x, G, z, BLOCK.OAK_PLANKS); setBlock(x, G + 1, z, BLOCK.TORCH); }
  // A torch on glass (bottom face visible) and leaves clusters.
  setBlock(8, G, -2, BLOCK.GLASS); setBlock(8, G + 1, -2, BLOCK.TORCH);
  fill(12, G, -3, 14, G + 1, -2, BLOCK.OAK_LEAVES);
}

function buildTerrain(seed, cx0, cz0) {
  const t = createTerrain(seed);
  for (let dz = -2; dz <= 2; dz++) {
    for (let dx = -2; dx <= 2; dx++) chunks.set(key(dx, dz), t.generateChunk(cx0 + dx, cz0 + dz));
  }
  tintSource = (cx, cz) => t.getTints(cx0 + cx, cz0 + cz);
  return t;
}

// -------------------------------------------------------------------------------------------
// Fallback procedural textures (used when src/render/textures.js is missing or ?tex=debug)
// -------------------------------------------------------------------------------------------
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const WOOL = {
  white: [233, 236, 236], orange: [240, 118, 19], magenta: [189, 68, 179], light_blue: [58, 175, 217],
  yellow: [248, 197, 39], lime: [112, 185, 25], pink: [237, 141, 172], gray: [62, 68, 71], light_gray: [142, 142, 134],
  cyan: [21, 137, 145], purple: [121, 42, 172], blue: [53, 57, 157], brown: [114, 71, 40], green: [84, 109, 27],
  red: [160, 39, 34], black: [20, 21, 25],
};

function paintTexture(name, frame, out) {
  const r = rng(hashStr(name) + frame * 7919);
  const px = (x, y, c, a = 255) => {
    const i = (y * 16 + x) * 4;
    out[i] = Math.max(0, Math.min(255, c[0])); out[i + 1] = Math.max(0, Math.min(255, c[1]));
    out[i + 2] = Math.max(0, Math.min(255, c[2])); out[i + 3] = a;
  };
  const noisy = (base, amt, a = 255) => {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const n = (r() - 0.5) * amt;
      px(x, y, [base[0] + n, base[1] + n, base[2] + n], a);
    }
  };
  const clear = () => out.fill(0);
  const spots = (c, count) => {
    for (let k = 0; k < count; k++) {
      const x = 1 + Math.floor(r() * 13), y = 1 + Math.floor(r() * 13);
      px(x, y, c); px(x + 1, y, c); px(x, y + 1, c.map((v) => v * 0.8));
    }
  };
  const bark = (base, dark) => {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const stripe = (x * 5 + Math.floor(y / 5)) % 4 === 0 ? -28 : 0;
      const n = (r() - 0.5) * 16 + stripe;
      px(x, y, [base[0] + n, base[1] + n, base[2] + n]);
    }
    if (dark) for (let k = 0; k < 7; k++) { const x = Math.floor(r() * 14), y = Math.floor(r() * 16); px(x, y, dark); px(x + 1, y, dark); }
  };
  const rings = (wood, barkC) => {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const d = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5));
      if (d > 6.6) { px(x, y, barkC); continue; }
      const ring = Math.floor(d) % 2 ? 18 : 0;
      px(x, y, [wood[0] - ring, wood[1] - ring, wood[2] - ring]);
    }
  };
  const planks = (base) => {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const seam = y % 4 === 3 || (x === ((y >> 2) * 5 + 3) % 16) ? -40 : 0;
      const n = (r() - 0.5) * 12 + seam;
      px(x, y, [base[0] + n, base[1] + n, base[2] + n]);
    }
  };
  const bricks = (mortar, brick, h = 4) => {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const off = ((y / h) | 0) % 2 ? 4 : 0;
      const m = y % h === h - 1 || (x + off) % 8 === 7;
      const n = (r() - 0.5) * 14;
      px(x, y, m ? mortar : [brick[0] + n, brick[1] + n, brick[2] + n]);
    }
  };
  const sprite = (draw) => { clear(); draw(); };

  const m = /^(\w+?)_wool$/.exec(name);
  if (m && WOOL[m[1]]) { noisy(WOOL[m[1]], 18); return; }
  switch (name) {
    case 'stone': noisy([126, 126, 126], 22); break;
    case 'granite': noisy([150, 104, 86], 30); break;
    case 'diorite': noisy([190, 190, 192], 40); break;
    case 'andesite': noisy([134, 134, 136], 30); break;
    case 'cobblestone': case 'mossy_cobblestone':
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        const cell = ((x >> 2) * 3 + (y >> 2) * 5 + ((x + y) >> 3)) % 4;
        const edge = x % 4 === 0 || y % 4 === 0;
        const n = (r() - 0.5) * 20;
        let c = edge ? [70, 70, 70] : [110 + cell * 12 + n, 110 + cell * 12 + n, 110 + cell * 12 + n];
        if (name === 'mossy_cobblestone' && r() < 0.3) c = [80, 110, 60];
        px(x, y, c);
      }
      break;
    case 'bedrock': noisy([70, 70, 70], 70); break;
    case 'dirt': noisy([134, 96, 67], 26); spots([110, 78, 52], 6); break;
    case 'grass_block_top':
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const g = 150 + (r() - 0.5) * 50; px(x, y, [g, g, g], 0); }
      break;
    case 'grass_block_side':
      paintTexture('dirt', 0, out);
      for (let x = 0; x < 16; x++) {
        const h = 3 + Math.floor(r() * 3);
        for (let y = 0; y < h; y++) { const g = 145 + (r() - 0.5) * 40; px(x, y, [g, g, g], 0); }
      }
      break;
    case 'grass_block_snow':
      paintTexture('dirt', 0, out);
      for (let x = 0; x < 16; x++) { const h = 3 + Math.floor(r() * 3); for (let y = 0; y < h; y++) px(x, y, [240, 248, 250]); }
      break;
    case 'snow': noisy([240, 248, 250], 10); break;
    case 'sand': noisy([219, 207, 163], 18); break;
    case 'sandstone': case 'sandstone_top': case 'sandstone_bottom':
      noisy([216, 203, 155], 12);
      if (name === 'sandstone') for (let x = 0; x < 16; x++) { px(x, 3, [190, 176, 128]); px(x, 11, [190, 176, 128]); }
      break;
    case 'gravel': noisy([136, 126, 126], 50); break;
    case 'clay': noisy([160, 166, 179], 12); break;
    case 'oak_log': case 'oak_log_x': bark([109, 85, 50], [80, 60, 35]); break;
    case 'birch_log': bark([216, 215, 210], [40, 40, 40]); break;
    case 'spruce_log': bark([58, 37, 16], [40, 25, 10]); break;
    case 'oak_log_top': rings([176, 140, 90], [109, 85, 50]); break;
    case 'birch_log_top': rings([200, 180, 130], [216, 215, 210]); break;
    case 'spruce_log_top': rings([120, 90, 55], [58, 37, 16]); break;
    case 'oak_planks': planks([162, 130, 78]); break;
    case 'birch_planks': planks([196, 179, 123]); break;
    case 'spruce_planks': planks([114, 84, 48]); break;
    case 'oak_leaves': case 'birch_leaves': case 'spruce_leaves':
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        const hole = r() < 0.22;
        const g = 120 + (r() - 0.5) * 70;
        px(x, y, [g, g, g], hole ? 0 : 255);
      }
      break;
    case 'glass':
      clear();
      for (let i = 0; i < 16; i++) { px(i, 0, [220, 235, 240]); px(i, 15, [220, 235, 240]); px(0, i, [220, 235, 240]); px(15, i, [220, 235, 240]); }
      for (let i = 3; i < 7; i++) px(i, 9 - i, [240, 250, 255]);
      break;
    case 'ice':
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const n = (r() - 0.5) * 20; px(x, y, [150 + n, 185 + n, 250], 170); }
      break;
    case 'water_still':
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        const w = Math.sin((x + frame) * 0.8) + Math.sin((y * 0.7 + frame * 0.5)) * 0.8;
        px(x, y, [40 + w * 8, 78 + w * 10, 200 + w * 12], 180);
      }
      break;
    case 'lava_still':
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        const w = Math.sin((x + frame * 0.5) * 0.9) * Math.cos((y - frame * 0.3) * 0.7);
        px(x, y, [220 + w * 30, 90 + w * 60, 20 + w * 20]);
      }
      break;
    case 'coal_ore': paintTexture('stone', 0, out); spots([30, 30, 30], 6); break;
    case 'iron_ore': paintTexture('stone', 0, out); spots([216, 175, 147], 6); break;
    case 'gold_ore': paintTexture('stone', 0, out); spots([252, 238, 75], 6); break;
    case 'diamond_ore': paintTexture('stone', 0, out); spots([93, 236, 245], 6); break;
    case 'redstone_ore': paintTexture('stone', 0, out); spots([200, 10, 10], 6); break;
    case 'lapis_ore': paintTexture('stone', 0, out); spots([30, 60, 180], 6); break;
    case 'iron_block': noisy([220, 220, 220], 8); break;
    case 'gold_block': noisy([248, 210, 60], 12); break;
    case 'diamond_block': noisy([100, 230, 225], 12); break;
    case 'coal_block': noisy([22, 22, 22], 10); break;
    case 'lapis_block': noisy([31, 67, 140], 12); break;
    case 'obsidian': noisy([20, 16, 30], 14); break;
    case 'glowstone': for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const n = r(); px(x, y, n < 0.3 ? [140, 100, 50] : [250, 210 + n * 40, 120]); } break;
    case 'bricks': bricks([180, 170, 160], [150, 75, 60]); break;
    case 'stone_bricks': case 'mossy_stone_bricks': case 'cracked_stone_bricks': bricks([90, 90, 90], [122, 121, 122], 8); break;
    case 'bookshelf':
      planks([162, 130, 78]);
      for (let y = 2; y < 14; y++) for (let x = 1; x < 15; x++) if (y !== 7 && y !== 8) px(x, y, [[150, 40, 40], [40, 80, 150], [60, 130, 60], [180, 160, 60]][(x >> 1) % 4]);
      break;
    case 'crafting_table_top': planks([162, 130, 78]); for (let i = 1; i < 15; i++) { px(i, 7, [90, 60, 30]); px(7, i, [90, 60, 30]); } break;
    case 'crafting_table_side': case 'crafting_table_front':
      planks([140, 105, 60]);
      for (let x = 2; x < 14; x++) px(x, 2, [60, 40, 20]);
      if (name === 'crafting_table_front') for (let y = 6; y < 13; y++) { px(4, y, [120, 120, 120]); px(11, y, [100, 70, 40]); }
      break;
    case 'furnace_top': noisy([110, 110, 110], 12); break;
    case 'furnace_side': noisy([120, 120, 120], 16); break;
    case 'furnace_front':
      noisy([120, 120, 120], 16);
      for (let y = 8; y < 13; y++) for (let x = 4; x < 12; x++) px(x, y, [30, 30, 30]);
      break;
    case 'tnt_side': for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) px(x, y, y >= 5 && y <= 10 ? [230, 230, 230] : [200, 50, 30]); for (let x = 3; x < 13; x++) px(x, 7, [30, 30, 30]); break;
    case 'tnt_top': case 'tnt_bottom': noisy([200, 50, 30], 10); break;
    case 'pumpkin_top': noisy([200, 120, 20], 20); px(7, 7, [90, 70, 20]); px(8, 7, [90, 70, 20]); break;
    case 'pumpkin_side': for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) px(x, y, x % 4 === 0 ? [170, 95, 10] : [215, 130, 25]); break;
    case 'jack_o_lantern':
      paintTexture('pumpkin_side', 0, out);
      for (const [x, y] of [[4, 5], [5, 5], [10, 5], [11, 5], [4, 10], [5, 11], [6, 11], [7, 11], [8, 11], [9, 11], [10, 11], [11, 10]]) px(x, y, [255, 230, 80]);
      break;
    case 'cactus_side':
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        const edge = x === 0 || x === 15;
        const c = x % 4 === 1 ? [70, 120, 40] : [90, 150, 50];
        px(x, y, c, edge && (y % 4) !== 1 ? 0 : 255);
      }
      break;
    case 'cactus_top': case 'cactus_bottom':
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        const border = x === 0 || y === 0 || x === 15 || y === 15;
        const ring = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5)) > 5.5;
        px(x, y, ring ? [80, 135, 45] : [120, 175, 70], border ? 0 : 255);
      }
      break;
    case 'torch':
      sprite(() => {
        for (let y = 8; y < 16; y++) { px(7, y, [120, 85, 45]); px(8, y, [95, 65, 35]); }
        px(7, 6, [255, 240, 150]); px(8, 6, [255, 210, 90]); px(7, 7, [255, 180, 60]); px(8, 7, [240, 150, 40]);
      });
      break;
    case 'short_grass': case 'fern': case 'sugar_cane':
      sprite(() => {
        const n = name === 'sugar_cane' ? 3 : 9;
        for (let k = 0; k < n; k++) {
          const x = name === 'sugar_cane' ? 3 + k * 4 : 1 + Math.floor(r() * 14);
          const h = name === 'sugar_cane' ? 16 : 5 + Math.floor(r() * 9);
          for (let y = 16 - h; y < 16; y++) { const g = 120 + (r() - 0.5) * 60; px(x, y, [g, g, g]); if (name === 'sugar_cane') px(x + 1, y, [g * 0.85, g * 0.85, g * 0.85]); }
        }
      });
      break;
    case 'dandelion': case 'poppy': case 'cornflower': case 'oxeye_daisy': {
      const petal = { dandelion: [250, 220, 40], poppy: [220, 30, 30], cornflower: [70, 100, 230], oxeye_daisy: [240, 240, 240] }[name];
      sprite(() => {
        for (let y = 8; y < 16; y++) px(7, y, [60, 130, 40]);
        px(6, 12, [60, 130, 40]); px(8, 11, [60, 130, 40]);
        for (let y = 4; y < 8; y++) for (let x = 5; x < 10; x++) if ((x - 7) ** 2 + (y - 5.5) ** 2 < 5) px(x, y, petal);
        px(7, 5, name === 'oxeye_daisy' ? [240, 200, 40] : petal.map((v) => v * 0.7));
      });
      break;
    }
    case 'oak_sapling': case 'birch_sapling': case 'spruce_sapling':
      sprite(() => {
        for (let y = 9; y < 16; y++) px(7, y, [100, 75, 40]);
        const leaf = name === 'spruce_sapling' ? [50, 90, 50] : name === 'birch_sapling' ? [110, 160, 70] : [70, 140, 40];
        for (let y = 2; y < 10; y++) for (let x = 3; x < 13; x++) if ((x - 7.5) ** 2 + (y - 6) ** 2 < 14 && r() < 0.8) px(x, y, leaf);
      });
      break;
    case 'brown_mushroom': case 'red_mushroom':
      sprite(() => {
        for (let y = 10; y < 16; y++) { px(7, y, [220, 210, 190]); px(8, y, [200, 190, 170]); }
        const cap = name === 'red_mushroom' ? [200, 30, 30] : [150, 110, 80];
        for (let y = 6; y < 10; y++) for (let x = 4; x < 12; x++) if (y > 6 || (x > 4 && x < 11)) px(x, y, cap);
        if (name === 'red_mushroom') { px(6, 7, [240, 240, 240]); px(9, 8, [240, 240, 240]); }
      });
      break;
    case 'dead_bush':
      sprite(() => { for (let y = 6; y < 16; y++) { px(7 + ((y % 3) - 1), y, [120, 80, 40]); } for (let x = 3; x < 13; x++) px(x, 8 + (x % 3), [140, 95, 50]); });
      break;
    default:
      if (name.startsWith('destroy_stage')) { clear(); break; }
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) px(x, y, ((x >> 2) + (y >> 2)) & 1 ? [255, 0, 255] : [20, 20, 20]);
  }
}

function paintGlyph(out) {
  // An asymmetric "F" in the top-left corner reveals mirroring / rotation of the UV mapping.
  const F = ['###', '#..', '##.', '#..', '#..'];
  for (let y = 0; y < 5; y++) for (let x = 0; x < 3; x++) {
    if (F[y][x] !== '#') continue;
    const i = ((y + 1) * 16 + x + 1) * 4;
    out[i] = 255; out[i + 1] = 0; out[i + 2] = 0; out[i + 3] = 255;
  }
}

function fallbackTextures(glyph) {
  const data = new Uint8Array(16 * 16 * 4 * TEXTURE_LAYER_COUNT);
  for (const t of TEXTURES) {
    for (let f = 0; f < t.frames; f++) {
      const out = data.subarray((t.layer + f) * 1024, (t.layer + f + 1) * 1024);
      paintTexture(t.name, f, out);
      if (glyph && t.kind === 'block') paintGlyph(out);
    }
  }
  return { size: 16, layers: TEXTURE_LAYER_COUNT, data };
}

// -------------------------------------------------------------------------------------------
// GL
// -------------------------------------------------------------------------------------------
const canvas = document.getElementById('c');
const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, powerPreference: 'high-performance' });
if (!gl) throw new Error('WebGL2 unavailable');

const VS = `#version 300 es
layout(location = 0) in uvec3 aData;
uniform mat4 uViewProj;
uniform vec3 uOffset;      // section origin - camera position
uniform float uTime;
uniform float uFrame;
const float FACE_SHADE[7] = float[7](${FACE_SHADE.map((v) => v.toFixed(3)).join(', ')});
const float AO_CURVE[4] = float[4](0.5, 0.7, 0.85, 1.0);
out vec2 vUV;
flat out float vLayer;
out vec2 vLight;
out float vShade;
out vec3 vTint;
out vec3 vPos;
void main() {
  uint w0 = aData.x, w1 = aData.y, w2 = aData.z;
  vec3 p = vec3(uvec3(w0, w0 >> 9u, w0 >> 18u) & 511u) / 16.0 - 1.0 + uOffset;
  uint ao = (w0 >> 27u) & 3u;
  uint face = (w0 >> 29u) & 7u;
  uint anim = (w1 >> 30u) & 3u;
  float layer = float(w1 & 255u);
  if (anim == 3u) layer += uFrame;
  if (anim == 1u) p.xz += vec2(sin(uTime * 1.7 + p.x * 0.6 + p.z * 0.3), cos(uTime * 1.3 + p.z * 0.5)) * 0.05;
  if (anim == 2u) p += vec3(sin(uTime * 2.1 + p.y * 3.0 + p.z), 0.0, cos(uTime * 1.9 + p.x * 3.0)) * 0.01;
  vPos = p;
  gl_Position = uViewProj * vec4(p, 1.0);
  vUV = vec2(uvec2(w1 >> 8u, w1 >> 13u) & 31u) / 16.0;
  vLayer = layer;
  vLight = vec2(uvec2(w1 >> 18u, w1 >> 24u) & 63u) / 60.0;
  vShade = FACE_SHADE[face] * AO_CURVE[ao];
  vTint = vec3(uvec3(w2, w2 >> 8u, w2 >> 16u) & 255u) / 255.0;
}`;
const FS = (pass) => `#version 300 es
precision highp float;
precision highp sampler2DArray;
#define PASS ${pass}
uniform sampler2DArray uTex;
uniform float uDaylight;
uniform vec3 uSkyTint;
uniform vec3 uFogColor;
uniform vec2 uFog;
in vec2 vUV;
flat in float vLayer;
in vec2 vLight;
in float vShade;
in vec3 vTint;
in vec3 vPos;
out vec4 fragColor;
float lightCurve(float l) { return l / (4.0 - 3.0 * l); }
vec3 lightColor(float sky, float blk, float daylight, vec3 skyTint) {
  vec3 s = vec3(lightCurve(sky) * daylight) * skyTint;
  vec3 b = vec3(lightCurve(blk)) * vec3(1.0, 0.92, 0.82);
  return max(max(s, b), vec3(0.035));
}
void main() {
  vec4 tex = texture(uTex, vec3(vUV, vLayer));
  vec3 albedo;
  float alpha = 1.0;
#if PASS == 0
  albedo = tex.rgb * mix(vTint, vec3(1.0), tex.a);
#elif PASS == 1
  if (tex.a < 0.5) discard;
  albedo = tex.rgb * vTint;
#else
  albedo = tex.rgb * vTint;
  alpha = tex.a;
#endif
  vec3 col = albedo * lightColor(vLight.x, vLight.y, uDaylight, uSkyTint) * vShade;
  float d = length(vPos);
  col = mix(col, uFogColor, clamp((d - uFog.x) / (uFog.y - uFog.x), 0.0, 1.0));
  fragColor = vec4(col, alpha);
}`;

function compile(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) + '\n' + src);
  return s;
}
function program(pass) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl.VERTEX_SHADER, VS));
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, FS(pass)));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const u = {};
  for (const n of ['uViewProj', 'uOffset', 'uTime', 'uFrame', 'uTex', 'uDaylight', 'uSkyTint', 'uFogColor', 'uFog']) u[n] = gl.getUniformLocation(p, n);
  return { p, u };
}

async function loadTextures() {
  if (!DEBUG_TEX) {
    try {
      const T = await import('../src/render/textures.js');
      const tex = T.generateTextures();
      let levels = null;
      if (T.buildMipChain && T.getLayerAlphaModes) levels = T.buildMipChain(tex.data, tex.size, tex.layers, T.getLayerAlphaModes());
      return { tex, levels, source: 'src/render/textures.js' };
    } catch (e) {
      console.warn('textures.js unavailable, using built-in fallback textures:', e.message);
    }
  }
  return { tex: fallbackTextures(DEBUG_TEX), levels: null, source: DEBUG_TEX ? 'built-in (debug glyph)' : 'built-in fallback' };
}

// -------------------------------------------------------------------------------------------
// Main
// -------------------------------------------------------------------------------------------
const VIEWS_SHOWCASE = [
  { eye: [34, 86, 42], at: [5, 64, 6] },          // 0 overview from the south-east
  { eye: [-1, 69.5, 15], at: [-2, 63, 5] },        // 1 pond, waterfall, aquarium
  { eye: [6, 68, 18], at: [10, 64, 11] },          // 2 plants, cacti, lava
  { eye: [22.5, 65.6, -7.4], at: [21, 64.5, -12] },// 3 inside the hut
  { eye: [-4, 67, 1], at: [-6, 64.5, -6] },        // 4 block row (orientation)
  { eye: [-4, 68.5, 30], at: [-11, 64.5, 19] },    // 5 overhang (sideways sky light, AO)
  { eye: [-6, 70, 9], at: [-14, 64.5, 1] },        // 6 staircase (AO in inside corners)
];
const VIEWS_TERRAIN = [
  { eye: [34, 104, 36], at: [8, 66, 8] },
  { eye: [-12, 92, 30], at: [10, 66, 4] },
  { eye: [8, 86, -14], at: [8, 62, 16] },
];
// Linear fog (start, end) in blocks: the preview only meshes 3x3 chunks, so keep it light.
const FOG = params.has('fog') ? params.get('fog').split(',').map(Number) : [48, 110];

async function main() {
  const t0 = performance.now();
  if (SCENE === 'terrain') buildTerrain(Number(params.get('seed') || 12345), Number(params.get('cx') || 0), Number(params.get('cz') || 0));
  else buildShowcase();
  const tGen = performance.now() - t0;

  const { tex, levels, source } = await loadTextures();
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
  const nLevels = levels ? levels.length : 1;
  gl.texStorage3D(gl.TEXTURE_2D_ARRAY, nLevels, gl.RGBA8, 16, 16, tex.layers);
  if (levels) {
    levels.forEach((lv, i) => gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, i, 0, 0, 0, 16 >> i, 16 >> i, tex.layers, gl.RGBA, gl.UNSIGNED_BYTE, lv));
  } else {
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, 0, 16, 16, tex.layers, gl.RGBA, gl.UNSIGNED_BYTE, tex.data);
  }
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, levels ? gl.NEAREST_MIPMAP_LINEAR : gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAX_LEVEL, nLevels - 1);

  // Mesh the inner 3x3 chunks with the worker pipeline.
  const region = new Uint8Array(REGION_VOLUME);
  const light = new Uint8Array(REGION_VOLUME);
  const meshes = [];
  let quads = [0, 0, 0], tLight = 0, tMesh = 0, maxQuads = 0;
  for (let cz = -1; cz <= 1; cz++) {
    for (let cx = -1; cx <= 1; cx++) {
      const nb = [];
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) nb.push(chunks.get(key(cx + dx, cz + dz)) || null);
      const a = performance.now();
      buildRegion(nb, region);
      computeLight(region, light);
      const b = performance.now();
      const tints = tintSource ? tintSource(cx, cz) : null;
      const sections = meshChunk(region, light, 0xffff, tints, { smoothLighting: SMOOTH });
      const c = performance.now();
      tLight += b - a; tMesh += c - b;
      for (const s of sections) {
        ['opaque', 'cutout', 'translucent'].forEach((layer, li) => {
          const data = s[layer];
          if (!data) return;
          const vao = gl.createVertexArray();
          gl.bindVertexArray(vao);
          const vbo = gl.createBuffer();
          gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
          gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
          gl.enableVertexAttribArray(0);
          gl.vertexAttribIPointer(0, 3, gl.UNSIGNED_INT, 12, 0);
          const n = data.length / 12;
          quads[li] += n;
          maxQuads = Math.max(maxQuads, n);
          meshes.push({ vao, layer: li, quads: n, origin: [cx * 16, s.sy * 16, cz * 16] });
        });
      }
    }
  }
  // Shared quad index buffer (0,1,2)(0,2,3).
  const ibo = gl.createBuffer();
  const idx = new Uint32Array(maxQuads * 6);
  for (let q = 0; q < maxQuads; q++) idx.set([q * 4, q * 4 + 1, q * 4 + 2, q * 4, q * 4 + 2, q * 4 + 3], q * 6);
  for (const m of meshes) { gl.bindVertexArray(m.vao); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo); }
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
  gl.bindVertexArray(null);

  const progs = [program(0), program(1), program(2)];
  const views = SCENE === 'terrain' ? VIEWS_TERRAIN : VIEWS_SHOWCASE;
  let eye, yaw, pitch;
  if (params.has('cam')) {
    const v = params.get('cam').split(',').map(Number);
    eye = v.slice(0, 3); yaw = (v[3] * Math.PI) / 180; pitch = (v[4] * Math.PI) / 180;
  } else {
    const v = views[Math.min(VIEW, views.length - 1)];
    eye = v.eye;
    const d = [v.at[0] - eye[0], v.at[1] - eye[1], v.at[2] - eye[2]];
    yaw = Math.atan2(-d[0], -d[2]);
    pitch = Math.atan2(d[1], Math.hypot(d[0], d[2]));
  }
  const daylight = computeDaylight(TIME);
  const night = 1 - (daylight - 0.2) / 0.8;
  const skyTint = [1 - 0.35 * night, 1 - 0.25 * night, 1];
  const fogColor = [0.62 * daylight + 0.02, 0.76 * daylight + 0.03, 1.0 * daylight + 0.05];
  const proj = mat4Create(), view = mat4Create(), vp = mat4Create();

  info.textContent = `scene ${SCENE} view ${VIEW}  smooth ${SMOOTH}  textures: ${source}\n` +
    `world gen ${tGen.toFixed(0)} ms | 9 chunks: light ${tLight.toFixed(1)} ms, mesh ${tMesh.toFixed(1)} ms ` +
    `(avg ${((tLight + tMesh) / 9).toFixed(2)} ms/chunk)\nquads opaque ${quads[0]}  cutout ${quads[1]}  translucent ${quads[2]}`;
  if (params.get('hud') === '0') info.style.display = 'none';

  let frames = 0;
  const start = performance.now();
  function frame() {
    const w = Math.floor(canvas.clientWidth * devicePixelRatio), h = Math.floor(canvas.clientHeight * devicePixelRatio);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    gl.viewport(0, 0, w, h);
    gl.clearColor(fogColor[0], fogColor[1], fogColor[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    mat4Perspective(proj, (70 * Math.PI) / 180, w / h, 0.05, 500);
    mat4ViewRotation(view, yaw, pitch);
    mat4Multiply(vp, proj, view);
    const time = (performance.now() - start) / 1000;
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
    const center = (m) => [m.origin[0] + 8 - eye[0], m.origin[1] + 8 - eye[1], m.origin[2] + 8 - eye[2]];
    for (let layer = 0; layer < 3; layer++) {
      const { p, u } = progs[layer];
      gl.useProgram(p);
      gl.uniformMatrix4fv(u.uViewProj, false, vp);
      gl.uniform1f(u.uTime, time);
      gl.uniform1f(u.uFrame, Math.floor(time * 8) % 16);
      gl.uniform1i(u.uTex, 0);
      gl.uniform1f(u.uDaylight, daylight);
      gl.uniform3fv(u.uSkyTint, skyTint);
      gl.uniform3fv(u.uFogColor, fogColor);
      gl.uniform2f(u.uFog, FOG[0], FOG[1]);
      if (layer === 2) {
        gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.disable(gl.CULL_FACE);
      } else {
        gl.disable(gl.BLEND); gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK); gl.frontFace(gl.CCW);
      }
      const list = meshes.filter((m) => m.layer === layer);
      if (layer === 2) list.sort((a, b) => Math.hypot(...center(b)) - Math.hypot(...center(a)));
      for (const m of list) {
        gl.uniform3f(u.uOffset, m.origin[0] - eye[0], m.origin[1] - eye[1], m.origin[2] - eye[2]);
        gl.bindVertexArray(m.vao);
        gl.drawElements(gl.TRIANGLES, m.quads * 6, gl.UNSIGNED_INT, 0);
      }
    }
    gl.bindVertexArray(null);
    frames++;
    if (frames === 3) window.__ready = true;
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

main().catch((e) => {
  info.textContent = 'ERROR: ' + (e.stack || e.message);
  console.error(e);
});
