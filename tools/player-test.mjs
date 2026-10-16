// Player sandbox (test page for src/game/input.js, player.js, interaction.js). It runs the real modules in
// a browser on a small floating island with a self-contained WebGL2 voxel renderer (test-only: the game
// renders with src/render/*). Textures come from src/render/textures.js when available (flat colours
// otherwise).
//
// URL parameters:
//   auto=1          automation: input.allowUnlocked (keys / buttons work without pointer lock)
//   mode=creative   start in creative mode            x,y,z,yaw,pitch   start pose (angles in degrees)
//   hud=0           hide the text HUD and help         tex=0             flat colours (skip textures.js)
//   bob=0           view bobbing off                   fov=N             base vertical FOV
// window.__test exposes the game objects and helpers for tools/harness.mjs (--eval / --steps).
import { Input } from '../src/game/input.js';
import { Player } from '../src/game/player.js';
import { Interaction } from '../src/game/interaction.js';
import { PhysicsBody } from '../src/game/physics.js';
import { makeStack } from '../src/game/inventory.js';
import {
  BLOCK, BLOCKS, ITEMS, ITEM, FACE_LAYERS, FACE_ROTATION, RENDER_TYPE, RENDER, RENDER_LAYER, LAYER, TINT_TYPE, TINT,
  IS_OPAQUE, CULL_SAME, NEEDS_SUPPORT, HAS_GRAVITY, IS_REPLACEABLE, IS_SOLID, TEXTURES, TEXTURE_LAYER_COUNT,
  TEXTURE_INDEX, getSelectionBox, itemDisplayName, isBlockItem, itemId, maxDurability, hasSupport, getDrops,
  DEFAULT_CREATIVE_HOTBAR,
} from '../src/world/registry.js';
import { DEFAULT_SETTINGS, DEFAULT_TINTS, FACE_SHADE } from '../src/config.js';
import {
  mat4Create, mat4Perspective, mat4ViewRotation, mat4Multiply, mat4Identity, mat4Translate, mat4RotateX,
  mat4RotateY, mat4RotateZ, mat4Scale,
} from '../src/util/math.js';

const P = new URLSearchParams(location.search);
const num = (k, d) => (P.has(k) && P.get(k) !== '' && Number.isFinite(Number(P.get(k))) ? Number(P.get(k)) : d);
const DEG = Math.PI / 180;
const $ = (id) => document.getElementById(id);

// ================================================================================================
// World: 64 x 64 x 96 floating island (x, z in [-32, 32)), the void around it.
// ================================================================================================
const SIZE = 64, HEIGHT = 96, HALF = 32, GROUND = 40;

class SandboxWorld {
  constructor() {
    this.data = new Uint8Array(SIZE * SIZE * HEIGHT);
    this.dirty = new Set();
    this.onDrop = null;
  }
  inside(x, y, z) {
    return x >= -HALF && x < HALF && z >= -HALF && z < HALF && y >= 0 && y < HEIGHT;
  }
  idx(x, y, z) {
    return (y * SIZE + (z + HALF)) * SIZE + (x + HALF);
  }
  getBlock(x, y, z) {
    return this.inside(x, y, z) ? this.data[this.idx(x, y, z)] : 0;
  }
  set(x, y, z, id) {
    if (this.inside(x, y, z)) this.data[this.idx(x, y, z)] = id;
  }
  fill(x0, y0, z0, x1, y1, z1, id) {
    for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) this.set(x, y, z, id);
  }
  /** Game-facing edit with neighbour updates (support pop-off, falling sand) like the real world. */
  setBlock(x, y, z, id) {
    if (!this.inside(x, y, z)) return false;
    const i = this.idx(x, y, z);
    if (this.data[i] === id) return true;
    this.data[i] = id;
    this.markDirty(x, z);
    this._update(x, y + 1, z);
    if (HAS_GRAVITY[id]) this._fall(x, y, z);
    return true;
  }
  _update(x, y, z) {
    for (let guard = 0; guard < HEIGHT; guard++, y++) {
      const id = this.getBlock(x, y, z);
      if (HAS_GRAVITY[id] && !IS_SOLID[this.getBlock(x, y - 1, z)]) { this._fall(x, y, z); return; }
      if (!id || !NEEDS_SUPPORT[id] || hasSupport(id, this.getBlock(x, y - 1, z))) return;
      this.data[this.idx(x, y, z)] = 0;
      for (const d of getDrops(id, 0)) this.onDrop?.(d.id, x, y, z);
    }
  }
  _fall(x, y, z) {
    const id = this.getBlock(x, y, z);
    let ty = y;
    while (ty > 0 && IS_REPLACEABLE[this.getBlock(x, ty - 1, z)]) ty--;
    if (ty === y) return;
    this.data[this.idx(x, y, z)] = 0;
    this.data[this.idx(x, ty, z)] = id;
    this._update(x, y + 1, z);
  }
  markDirty(x, z) {
    const lx = x + HALF, lz = z + HALF;
    for (const dx of [-1, 0, 1]) for (const dz of [-1, 0, 1]) {
      const cx = (lx + dx) >> 4, cz = (lz + dz) >> 4;
      if (cx >= 0 && cx < 4 && cz >= 0 && cz < 4) this.dirty.add(cz * 4 + cx);
    }
  }
  getTopY(x, z) {
    for (let y = HEIGHT - 1; y >= 0; y--) if (this.getBlock(x, y, z)) return y;
    return -1;
  }
  getLight() { return 0xf0; }
  isAreaReady() { return true; }
}

function hash(x, z, s) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(z | 0, 668265263) ^ Math.imul(s | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function buildIsland(w) {
  const B = BLOCK;
  for (let z = -HALF; z < HALF; z++) {
    for (let x = -HALF; x < HALF; x++) {
      const edge = Math.max(Math.abs(x + 0.5), Math.abs(z + 0.5));
      const depth = edge > 28 ? 6 + Math.floor(hash(x, z, 1) * 4) : 40;
      for (let y = GROUND - depth; y < GROUND; y++) {
        let id = B.STONE;
        if (y === GROUND - 1) id = B.GRASS_BLOCK;
        else if (y >= GROUND - 4) id = B.DIRT;
        else if (y === 0) id = B.BEDROCK;
        w.set(x, y, z, id);
      }
    }
  }
  // North: steps (1 high, 2 high) and a stair to a 4-high sneaking platform.
  w.fill(-3, 40, -8, 1, 40, -7, B.OAK_PLANKS);
  w.fill(3, 40, -8, 5, 41, -7, B.COBBLESTONE);
  w.fill(-8, 40, -14, -4, 43, -10, B.STONE_BRICKS);
  for (let i = 0; i < 4; i++) w.fill(-3 + i, 40, -12, -3 + i, 40 + i - 1, -11, i ? B.BRICKS : 0);
  // Tower for fall damage tests (top at y = 52).
  w.fill(8, 40, -14, 9, 51, -13, B.STONE);
  // East: 2-deep pool with a 1-high ledge around it.
  w.fill(7, 37, -4, 12, 39, 4, B.WATER);
  w.fill(7, 36, -4, 12, 36, 4, B.SAND);
  // West: ice rink.
  w.fill(-15, 39, -4, -6, 39, 4, B.ICE);
  // South: cactus garden, lava pit, interactive blocks.
  w.fill(1, 39, 6, 5, 39, 9, B.SAND);
  w.set(2, 40, 7, B.CACTUS); w.set(2, 41, 7, B.CACTUS); w.set(4, 40, 8, B.CACTUS);
  w.fill(-5, 38, 7, -3, 39, 9, B.LAVA);
  w.set(2, 40, -3, B.CRAFTING_TABLE); w.set(3, 40, -3, B.FURNACE); w.set(4, 40, -3, B.TNT);
  w.set(5, 40, -3, B.GLASS); w.set(6, 40, -3, B.BEDROCK); w.set(-2, 40, -3, B.GRAVEL);
  w.set(-3, 40, -3, B.STONE); w.set(-3, 41, -3, B.TORCH); w.set(0, 40, -3, B.OAK_LOG); w.set(1, 40, -3, B.OAK_LOG_X);
  // Trees.
  const tree = (x, z, log, leaves, h) => {
    for (let y = 40; y < 40 + h; y++) w.set(x, y, z, log);
    for (let y = 40 + h - 3; y <= 40 + h; y++) {
      const r = y >= 40 + h - 1 ? 1 : 2;
      for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) === r && Math.abs(dz) === r && (y === 40 + h || hash(x + dx, z + dz, y) < 0.5)) continue;
        if (!w.getBlock(x + dx, y, z + dz)) w.set(x + dx, y, z + dz, leaves);
      }
    }
  };
  tree(-10, 10, B.OAK_LOG, B.OAK_LEAVES, 5);
  tree(14, 14, B.BIRCH_LOG, B.BIRCH_LEAVES, 6);
  tree(-18, -18, B.SPRUCE_LOG, B.SPRUCE_LEAVES, 7);
  // Plants.
  const plants = [B.SHORT_GRASS, B.SHORT_GRASS, B.SHORT_GRASS, B.FERN, B.DANDELION, B.POPPY, B.CORNFLOWER, B.OXEYE_DAISY];
  for (let z = -HALF + 1; z < HALF - 1; z++) {
    for (let x = -HALF + 1; x < HALF - 1; x++) {
      if (Math.abs(x) < 4 && Math.abs(z) < 4) continue;
      if (w.getBlock(x, 39, z) !== B.GRASS_BLOCK || w.getBlock(x, 40, z)) continue;
      const r = hash(x, z, 7);
      if (r < 0.12) w.set(x, 40, z, plants[Math.floor(hash(x, z, 9) * plants.length)]);
    }
  }
}

// ================================================================================================
// Renderer (test-only): per-chunk meshes, one texture array, hand, selection, cracks, dropped items.
// ================================================================================================
const canvas = $('c');
const gl = canvas.getContext('webgl2', { antialias: false, alpha: false });
if (!gl) throw new Error('WebGL2 not available');

const VS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aUVL;
layout(location=2) in vec3 aTint;
layout(location=3) in vec2 aShadeMode;
uniform mat4 uViewProj;
uniform mat4 uModel;
uniform vec3 uOffset;
out vec3 vUVL; out vec3 vTint; out float vShade; out float vMode; out float vDist;
void main() {
  vec3 p = (uModel * vec4(aPos, 1.0)).xyz + uOffset;
  gl_Position = uViewProj * vec4(p, 1.0);
  vUVL = aUVL; vTint = aTint; vShade = aShadeMode.x; vMode = aShadeMode.y; vDist = length(p);
}`;
const FS = `#version 300 es
precision highp float; precision highp sampler2DArray;
uniform sampler2DArray uTex;
uniform vec3 uFog; uniform vec2 uFogRange; uniform float uFrame; uniform float uBright;
in vec3 vUVL; in vec3 vTint; in float vShade; in float vMode; in float vDist;
out vec4 o;
void main() {
  float mode = vMode;
  vec3 uvl = vUVL;
  if (mode > 9.5) { mode -= 10.0; uvl.z += uFrame; }
  vec4 t = texture(uTex, uvl);
  if (mode > 2.5) { o = vec4(mix(vec3(0.5), t.rgb, t.a), 1.0); return; }      // crack overlay (multiply blend)
  vec3 c;
  float a = 1.0;
  if (mode < 0.5) c = t.rgb * mix(vTint, vec3(1.0), t.a);                     // opaque: tint mask in alpha
  else { if (mode < 1.5 && t.a < 0.5) discard; c = t.rgb * vTint; if (mode > 1.5) a = t.a; }
  c *= vShade * uBright;
  float f = clamp((vDist - uFogRange.x) / (uFogRange.y - uFogRange.x), 0.0, 1.0);
  o = vec4(mix(c, uFog, f), a);
}`;
const LINE_VS = `#version 300 es
layout(location=0) in vec3 aPos;
uniform mat4 uViewProj; uniform vec3 uOffset;
void main() { gl_Position = uViewProj * vec4(aPos + uOffset, 1.0); }`;
const LINE_FS = `#version 300 es
precision mediump float; uniform vec4 uColor; out vec4 o; void main() { o = uColor; }`;

function compile(vs, fs) {
  const mk = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, mk(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i);
    u[info.name] = gl.getUniformLocation(p, info.name);
  }
  return { p, u };
}
const prog = compile(VS, FS);
const lineProg = compile(LINE_VS, LINE_FS);

async function loadTextureData() {
  if (P.get('tex') !== '0') {
    try {
      const T = await import('../src/render/textures.js');
      const t = T.generateTextures();
      if (t && t.data && t.data.length >= 16 * 16 * 4 * TEXTURE_LAYER_COUNT) return { data: t.data, source: 'textures.js' };
    } catch (e) {
      console.warn('[player-test] textures.js unavailable, using flat colours:', e.message);
    }
  }
  const data = new Uint8Array(16 * 16 * 4 * TEXTURE_LAYER_COUNT);
  for (const t of TEXTURES) {
    let h = 0;
    for (const ch of t.name) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
    const base = [80 + (h & 127), 80 + ((h >> 8) & 127), 80 + ((h >> 16) & 127)];
    for (let f = 0; f < t.frames; f++) {
      for (let i = 0; i < 256; i++) {
        const o = ((t.layer + f) * 256 + i) * 4;
        const n = ((i * 37) % 23) - 11;
        data[o] = base[0] + n; data[o + 1] = base[1] + n; data[o + 2] = base[2] + n;
        data[o + 3] = t.alphaMode === 'cutout' ? (((i >> 4) + i) % 3 ? 255 : 0) : t.alphaMode === 'translucent' ? 160 : 255;
      }
    }
  }
  return { data, source: 'flat colours' };
}

const tex = gl.createTexture();
async function initTextures() {
  const { data, source } = await loadTextureData();
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
  gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.RGBA8, 16, 16, TEXTURE_LAYER_COUNT, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAX_LEVEL, 4);
  return source;
}

// ---- mesh building
const FACE_CORNERS = [
  [[1, 1, 1], [1, 1, 0], [1, 0, 0], [1, 0, 1]],
  [[0, 1, 0], [0, 1, 1], [0, 0, 1], [0, 0, 0]],
  [[0, 1, 0], [1, 1, 0], [1, 1, 1], [0, 1, 1]],
  [[0, 0, 1], [1, 0, 1], [1, 0, 0], [0, 0, 0]],
  [[0, 1, 1], [1, 1, 1], [1, 0, 1], [0, 0, 1]],
  [[1, 1, 0], [0, 1, 0], [0, 0, 0], [1, 0, 0]],
];
const NORMALS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const TINTS = [[1, 1, 1], ...[DEFAULT_TINTS.grass, DEFAULT_TINTS.foliage, DEFAULT_TINTS.birch, DEFAULT_TINTS.spruce].map((c) => c.map((v) => v / 255))];
const LIQUID_TOP = 14 / 16;
const FLOATS = 11;

function blockMode(id) {
  const layer = RENDER_LAYER[id];
  let m = layer === LAYER.OPAQUE ? 0 : layer === LAYER.CUTOUT ? 1 : 2;
  if (RENDER_TYPE[id] === RENDER.LIQUID) m += 10;
  return m;
}

/** Quad for `face` of box [x0..x1]×[y0..y1]×[z0..z1] (block-relative), UVs derived from the box. */
function pushFace(out, ox, oy, oz, face, box, layer, tint, shade, mode, rot = 0, vShift = 0) {
  const c = FACE_CORNERS[face];
  const vs = [];
  for (let k = 0; k < 4; k++) {
    const lx = box[0] + c[k][0] * (box[3] - box[0]);
    const ly = box[1] + c[k][1] * (box[4] - box[1]);
    const lz = box[2] + c[k][2] * (box[5] - box[2]);
    let u, v;
    if (face === 0) { u = 1 - lz; v = 1 - ly; }
    else if (face === 1) { u = lz; v = 1 - ly; }
    else if (face === 4) { u = lx; v = 1 - ly; }
    else if (face === 5) { u = 1 - lx; v = 1 - ly; }
    else if (face === 2) { u = lx; v = lz; }
    else { u = lx; v = 1 - lz; }
    v += vShift;
    if (rot) { const t = u; u = v; v = 1 - t; }
    vs.push([ox + lx, oy + ly, oz + lz, u, v]);
  }
  for (const k of [0, 1, 2, 0, 2, 3]) {
    const p = vs[k];
    out.push(p[0], p[1], p[2], p[3], p[4], layer, tint[0], tint[1], tint[2], shade, mode);
  }
}

function pushCross(out, ox, oy, oz, layer, tint, mode) {
  const a = 0.15, b = 0.85;
  const quads = [[[a, 1, a], [b, 1, b], [b, 0, b], [a, 0, a]], [[a, 1, b], [b, 1, a], [b, 0, a], [a, 0, b]]];
  const uv = [[0, 0], [1, 0], [1, 1], [0, 1]];
  for (const q of quads) {
    for (const k of [0, 1, 2, 0, 2, 3]) {
      out.push(ox + q[k][0], oy + q[k][1], oz + q[k][2], uv[k][0], uv[k][1], layer, tint[0], tint[1], tint[2], FACE_SHADE[6], mode);
    }
  }
}

const FULL = [0, 0, 0, 1, 1, 1];
const CACTUS_FACE_BOX = [
  [0, 0, 0, 15 / 16, 1, 1], [1 / 16, 0, 0, 1, 1, 1], FULL, FULL, [0, 0, 0, 1, 1, 15 / 16], [0, 0, 1 / 16, 1, 1, 1],
];
function meshBlock(w, x, y, z, id, ox, oy, oz, solid, trans) {
  const rt = RENDER_TYPE[id];
  const tint = TINTS[TINT_TYPE[id]];
  const mode = blockMode(id);
  const out = RENDER_LAYER[id] === LAYER.TRANSLUCENT ? trans : solid;
  if (rt === RENDER.CROSS) { pushCross(out, ox, oy, oz, FACE_LAYERS[id * 6], tint, mode); return; }
  if (rt === RENDER.TORCH) {
    const box = [7 / 16, 0, 7 / 16, 9 / 16, 10 / 16, 9 / 16];
    for (let f = 0; f < 6; f++) {
      if (f === 3) continue;
      // SPEC §7: post texels u 7..9, v 6..16; the top uses v 6..8.
      pushFace(out, ox, oy, oz, f, box, FACE_LAYERS[id * 6 + f], tint, FACE_SHADE[f], mode, 0, f === 2 ? -1 / 16 : 0);
    }
    return;
  }
  let box = FULL;
  if (rt === RENDER.LIQUID && w.getBlock(x, y + 1, z) !== id) box = [0, 0, 0, 1, LIQUID_TOP, 1];
  for (let f = 0; f < 6; f++) {
    const n = NORMALS[f];
    const nb = w.getBlock(x + n[0], y + n[1], z + n[2]);
    if (rt === RENDER.LIQUID) {
      if (nb === id || IS_OPAQUE[nb]) continue;
    } else if (IS_OPAQUE[nb] && !(rt === RENDER.CACTUS)) continue;
    else if (CULL_SAME[id] && nb === id) continue;
    let b = box;
    if (rt === RENDER.CACTUS) {
      if (f >= 2 && f <= 3 && nb === id) continue;
      b = CACTUS_FACE_BOX[f];                         // sides inset by 1/16
    }
    pushFace(out, ox, oy, oz, f, b, FACE_LAYERS[id * 6 + f], tint, FACE_SHADE[f], mode, FACE_ROTATION[id * 6 + f]);
  }
}

class Mesh {
  constructor() {
    this.vao = gl.createVertexArray();
    this.vbo = gl.createBuffer();
    this.count = 0;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    const stride = FLOATS * 4;
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 12);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 3, gl.FLOAT, false, stride, 24);
    gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 2, gl.FLOAT, false, stride, 36);
    gl.bindVertexArray(null);
  }
  upload(arr) {
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(arr), gl.DYNAMIC_DRAW);
    this.count = arr.length / FLOATS;
  }
  draw() {
    if (!this.count) return;
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, this.count);
  }
}

const chunks = [];
for (let i = 0; i < 16; i++) chunks.push({ solid: new Mesh(), trans: new Mesh(), ox: (i % 4) * 16 - HALF, oz: (i >> 2) * 16 - HALF });

function rebuildChunk(w, i) {
  const c = chunks[i];
  const solid = [], trans = [];
  for (let y = 0; y < HEIGHT; y++) {
    for (let z = c.oz; z < c.oz + 16; z++) {
      for (let x = c.ox; x < c.ox + 16; x++) {
        const id = w.data[w.idx(x, y, z)];
        if (id) meshBlock(w, x, y, z, id, x - c.ox, y, z - c.oz, solid, trans);
      }
    }
  }
  c.solid.upload(solid);
  c.trans.upload(trans);
}

const itemMeshes = new Map();
/** Unit cube (or flat sprite for non-block items) centred on the origin, for the hand and dropped items. */
function itemMesh(id) {
  let m = itemMeshes.get(id);
  if (m) return m;
  const arr = [];
  const it = ITEMS[id];
  if (it && it.isBlock && RENDER_TYPE[id] !== RENDER.CROSS && RENDER_TYPE[id] !== RENDER.TORCH) {
    const tint = TINTS[TINT_TYPE[id]];
    const mode = blockMode(id) % 10;
    for (let f = 0; f < 6; f++) pushFace(arr, -0.5, -0.5, -0.5, f, FULL, FACE_LAYERS[id * 6 + f], tint, FACE_SHADE[f], mode, FACE_ROTATION[id * 6 + f]);
  } else {
    const layer = it && it.isBlock ? FACE_LAYERS[id * 6] : (it?.layer ?? 0);
    const tint = it && it.isBlock ? TINTS[TINT_TYPE[id]] : TINTS[0];
    pushFace(arr, -0.5, -0.5, 0, 4, [0, 0, 0, 1, 1, 0], layer, tint, 1, 1);
  }
  m = new Mesh();
  m.upload(arr);
  itemMeshes.set(id, m);
  return m;
}

const lineVao = gl.createVertexArray();
const lineVbo = gl.createBuffer();
gl.bindVertexArray(lineVao);
gl.bindBuffer(gl.ARRAY_BUFFER, lineVbo);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0);
gl.bindVertexArray(null);
const crackMesh = new Mesh();

const proj = mat4Create(), view = mat4Create(), viewProj = mat4Create(), model = mat4Create(), ident = mat4Create();
const handProj = mat4Create();

// ================================================================================================
// Game facade
// ================================================================================================
const world = new SandboxWorld();
buildIsland(world);
const settings = { ...DEFAULT_SETTINGS, fov: num('fov', 70), viewBobbing: P.get('bob') !== '0' };
const logLines = [];
function log(msg) {
  logLines.push(msg);
  if (logLines.length > 14) logLines.shift();
}

class ItemEntities {
  constructor() { this.list = []; }
  spawn(stack, x, y, z, vx = (Math.random() - 0.5) * 4, vy = 4, vz = (Math.random() - 0.5) * 4, delay = 0.5) {
    const body = new PhysicsBody(0.25, 0.25);
    body.setPosition(x, y, z);
    body.vx = vx; body.vy = vy; body.vz = vz;
    this.list.push({ kind: 'item', body, stack: { ...stack }, age: 0, delay, seed: Math.random() });
  }
  update(dt, player) {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const e = this.list[i];
      const b = e.body;
      e.age += dt;
      e.delay -= dt;
      b.vy = Math.max(b.vy - 16 * dt, -40);
      const drag = Math.pow(0.98, dt * 20);
      const fr = b.onGround ? Math.pow(0.6 * 0.98, dt * 20) : drag;
      b.vx *= fr; b.vz *= fr; b.vy *= drag;
      b.move(world, b.vx * dt, b.vy * dt, b.vz * dt);
      const dx = player.x - b.x, dy = player.y + 0.9 - b.y, dz = player.z - b.z;
      if (!player.dead && e.delay <= 0 && dx * dx + dy * dy + dz * dz < 1.5 * 1.5) {
        const left = player.inventory.add(e.stack);
        if (left < e.stack.count) {
          game.audio.play('pop');
          if (left === 0) { this.list.splice(i, 1); continue; }
          e.stack.count = left;
        }
      }
      if (e.age > 300 || b.y < -64) this.list.splice(i, 1);
    }
  }
}

const entities = new ItemEntities();
const game = {
  world, settings, entities,
  particles: {
    breaks: 0, hits: 0,
    spawnBlockBreak() { this.breaks++; }, spawnBlockHit() { this.hits++; }, spawnSplash() { log('水花粒子'); },
  },
  audio: {
    count: 0,
    playBlock(kind, material) { this.count++; if (kind !== 'step' || logLines.at(-1) !== `step:${material}`) log(`${kind}:${material}`); },
    play(name) { this.count++; log(name); },
  },
  ui: { openCraftingTable() { log('打开工作台 (ui.openCraftingTable)'); } },
  emit(evt, ...args) {
    log(`event ${evt} ${args.join(' ')}`);
    if (evt === 'playerDied') { $('deathmsg').textContent = args[0]; $('death').style.display = 'flex'; input.exitLock(); }
    if (evt === 'playerRespawned') $('death').style.display = 'none';
  },
  spawnItem(stack, x, y, z, vx, vy, vz, delay) { entities.spawn(stack, x, y, z, vx, vy, vz, delay); },
  dropFromPlayer(stack) {
    const p = game.player;
    const cp = Math.cos(p.pitch), sp = Math.sin(p.pitch);
    entities.spawn(stack, p.x, p.y + p.eyeHeight - 0.3, p.z, -Math.sin(p.yaw) * cp * 6, sp * 6 + 2, -Math.cos(p.yaw) * cp * 6, 2);
  },
  onInteractBlock(x, y, z, id, ctx) {
    if (id === BLOCK.TNT) {
      if (ctx.itemId !== ITEM.FLINT_AND_STEEL) return false;
      world.setBlock(x, y, z, 0);
      log('TNT 被点燃 (onInteractBlock)');
      return true;
    }
    log(`onInteractBlock ${BLOCKS[id].name} @ ${x},${y},${z}`);
    return true;
  },
};
world.onDrop = (item, x, y, z) => entities.spawn(makeStack(item, 1), x + 0.5, y + 0.3, z + 0.5);

const input = new Input(canvas, settings);
input.allowUnlocked = P.get('auto') === '1';
const player = new Player(game);
const interaction = new Interaction(game);
game.player = player;
game.interaction = interaction;
game.input = input;
player.spawnPoint = { x: 0, y: GROUND, z: 0 };
player.setGameMode(P.get('mode') === 'creative' ? 'creative' : 'survival');
player.setPosition(num('x', 0.5), num('y', GROUND), num('z', 0.5));
player.yaw = num('yaw', 0) * DEG;
player.pitch = num('pitch', 0) * DEG;
const startItems = player.mode === 'creative'
  ? DEFAULT_CREATIVE_HOTBAR.map((n) => makeStack(itemId(n), 1))
  : [makeStack(ITEM.WOODEN_PICKAXE, 1), makeStack(ITEM.STONE_SHOVEL, 1), makeStack(BLOCK.DIRT, 32), makeStack(BLOCK.COBBLESTONE, 64),
     makeStack(BLOCK.OAK_LOG, 16), makeStack(BLOCK.TORCH, 16), makeStack(ITEM.BUCKET, 1), makeStack(BLOCK.SAND, 16), makeStack(ITEM.FLINT_AND_STEEL, 1)];
startItems.forEach((s, i) => player.inventory.set(i, s));
if (player.mode !== 'creative') {
  player.inventory.set(9, makeStack(BLOCK.FURNACE, 4));
  player.inventory.set(10, makeStack(BLOCK.GLASS, 64));
  player.inventory.set(11, makeStack(ITEM.DIAMOND_SWORD, 1));
}

$('respawn').addEventListener('click', () => { player.respawn(); input.requestLock(); });
// Diagnostics for the harness: were browser defaults suppressed? (registered after Input's listeners)
const diag = { keys: {}, wheelPrevented: null, contextPrevented: null };
window.addEventListener('keydown', (e) => { diag.keys[e.code] = e.defaultPrevented; });
canvas.addEventListener('wheel', (e) => { diag.wheelPrevented = e.defaultPrevented; }, { passive: true });
canvas.addEventListener('contextmenu', (e) => { diag.contextPrevented = e.defaultPrevented; });
window.addEventListener('keydown', (e) => {
  if (!input.active) return;
  if (e.code === 'KeyG') { player.setGameMode(player.mode === 'creative' ? 'survival' : 'creative'); log(`gamemode ${player.mode}`); }
  if (e.code === 'KeyR') { player.spawnPoint = { x: player.x, y: player.y, z: player.z }; log('spawn point set'); }
});
if (P.get('hud') === '0') { $('hud').style.display = 'none'; $('help').style.display = 'none'; $('log').style.display = 'none'; }

// ================================================================================================
// Frame
// ================================================================================================
function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.floor(canvas.clientWidth * dpr), h = Math.floor(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
}

function drawWorld(cam, time) {
  const aspect = canvas.width / canvas.height;
  mat4Perspective(proj, cam.fov * DEG, aspect, 0.05, 400);
  mat4ViewRotation(view, cam.yaw, cam.pitch, cam.roll);
  mat4Multiply(viewProj, proj, view);
  let fog = [0.62, 0.76, 1.0], fogRange = [70, 110];
  if (player.eyeInWater) { fog = [0.05, 0.12, 0.45]; fogRange = [1, 16]; }
  if (player.eyeInLava) { fog = [0.8, 0.25, 0.02]; fogRange = [0.1, 1.5]; }
  gl.clearColor(fog[0], fog[1], fog[2], 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.useProgram(prog.p);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
  gl.uniform1i(prog.u.uTex, 0);
  gl.uniformMatrix4fv(prog.u.uViewProj, false, viewProj);
  gl.uniformMatrix4fv(prog.u.uModel, false, ident);
  gl.uniform3fv(prog.u.uFog, fog);
  gl.uniform2fv(prog.u.uFogRange, fogRange);
  gl.uniform1f(prog.u.uFrame, Math.floor(time * 8) % 16);
  gl.uniform1f(prog.u.uBright, 1);
  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LEQUAL);
  gl.disable(gl.CULL_FACE);
  gl.disable(gl.BLEND);
  for (const c of chunks) {
    gl.uniform3f(prog.u.uOffset, c.ox - cam.x, -cam.y, c.oz - cam.z);
    c.solid.draw();
  }
  // Dropped items: small spinning cubes / sprites with a bob.
  for (const e of entities.list) {
    const b = e.body;
    const blocky = isBlockItem(e.stack.id) && RENDER_TYPE[e.stack.id] !== RENDER.CROSS && RENDER_TYPE[e.stack.id] !== RENDER.TORCH;
    mat4Identity(model);
    mat4Translate(model, model, 0, 0.125 + Math.sin(e.age * 2 + e.seed * 6) * 0.05 + 0.05, 0);
    mat4RotateY(model, model, e.age * 1.5 + e.seed * 6);
    mat4Scale(model, model, blocky ? 0.25 : 0.4, blocky ? 0.25 : 0.4, blocky ? 0.25 : 0.4);
    gl.uniformMatrix4fv(prog.u.uModel, false, model);
    gl.uniform3f(prog.u.uOffset, b.x - cam.x, b.y - cam.y, b.z - cam.z);
    itemMesh(e.stack.id).draw();
  }
  gl.uniformMatrix4fv(prog.u.uModel, false, ident);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  for (const c of chunks) {
    gl.uniform3f(prog.u.uOffset, c.ox - cam.x, -cam.y, c.oz - cam.z);
    c.trans.draw();
  }
  // Crack overlay on the block being mined (multiply blend).
  const br = interaction.breaking;
  if (br) {
    const arr = [];
    const sb = getSelectionBox(BLOCKS[world.getBlock(br.x, br.y, br.z)] ? world.getBlock(br.x, br.y, br.z) : 0);
    const layer = TEXTURE_INDEX.get('destroy_stage_' + br.stage);
    for (let f = 0; f < 6; f++) pushFace(arr, 0, 0, 0, f, sb, layer, [1, 1, 1], 1, 3);
    crackMesh.upload(arr);
    gl.blendFunc(gl.DST_COLOR, gl.SRC_COLOR);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(-1, -1);
    gl.depthMask(false);
    gl.uniform3f(prog.u.uOffset, br.x - cam.x, br.y - cam.y, br.z - cam.z);
    crackMesh.draw();
    gl.depthMask(true);
    gl.disable(gl.POLYGON_OFFSET_FILL);
  }
  // Selection outline.
  const sel = interaction.selection;
  if (sel) {
    const e = 0.002, b = sel.box;
    const x0 = b[0] - e, y0 = b[1] - e, z0 = b[2] - e, x1 = b[3] + e, y1 = b[4] + e, z1 = b[5] + e;
    const v = [
      x0, y0, z0, x1, y0, z0, x1, y0, z0, x1, y0, z1, x1, y0, z1, x0, y0, z1, x0, y0, z1, x0, y0, z0,
      x0, y1, z0, x1, y1, z0, x1, y1, z0, x1, y1, z1, x1, y1, z1, x0, y1, z1, x0, y1, z1, x0, y1, z0,
      x0, y0, z0, x0, y1, z0, x1, y0, z0, x1, y1, z0, x1, y0, z1, x1, y1, z1, x0, y0, z1, x0, y1, z1,
    ];
    gl.useProgram(lineProg.p);
    gl.uniformMatrix4fv(lineProg.u.uViewProj, false, viewProj);
    gl.uniform3f(lineProg.u.uOffset, sel.x - cam.x, sel.y - cam.y, sel.z - cam.z);
    gl.uniform4f(lineProg.u.uColor, 0, 0, 0, 0.6);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(lineVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, lineVbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(v), gl.STREAM_DRAW);
    gl.drawArrays(gl.LINES, 0, v.length / 3);
    gl.useProgram(prog.p);
  }
  gl.disable(gl.BLEND);
}

/** First-person hand from HandState, following Minecraft's ItemInHandRenderer transforms. */
function drawHand() {
  const h = interaction.getHandState();
  if (player.dead) return;
  gl.clear(gl.DEPTH_BUFFER_BIT);
  mat4Perspective(handProj, 70 * DEG, canvas.width / canvas.height, 0.05, 10);
  gl.useProgram(prog.p);
  gl.uniformMatrix4fv(prog.u.uViewProj, false, handProj);
  gl.uniform3f(prog.u.uOffset, 0, 0, 0);
  gl.uniform2f(prog.u.uFogRange, 1000, 1001);
  const sky = (h.light >> 4) / 15, blk = (h.light & 15) / 15;
  const curve = (l) => l / (4 - 3 * l);
  gl.uniform1f(prog.u.uBright, Math.max(0.1, Math.max(curve(sky), curve(blk))));
  const s = h.swing, eq = 1 - h.equip;
  const m = mat4Identity(model);
  // View bobbing and turning sway (bobView + xBob/yBob in Minecraft).
  mat4Translate(m, m, h.bobX, h.bobY, 0);
  mat4RotateZ(m, m, -h.bobRoll);
  mat4RotateX(m, m, -h.bobPitch);
  mat4RotateX(m, m, h.swayPitch);
  mat4RotateY(m, m, -h.swayYaw);
  const sq = Math.sqrt(s);
  if (h.itemId) {
    mat4Translate(m, m, -0.4 * Math.sin(sq * Math.PI), 0.2 * Math.sin(sq * Math.PI * 2), -0.2 * Math.sin(s * Math.PI));
    mat4Translate(m, m, 0.56, -0.52 - eq * 0.6, -0.72);
    const f = Math.sin(s * s * Math.PI), f1 = Math.sin(sq * Math.PI);
    mat4RotateY(m, m, (45 + f * -20) * DEG);
    mat4RotateZ(m, m, f1 * -20 * DEG);
    mat4RotateX(m, m, f1 * -80 * DEG);
    mat4RotateY(m, m, -45 * DEG);
    const blocky = isBlockItem(h.itemId) && RENDER_TYPE[h.itemId] !== RENDER.CROSS && RENDER_TYPE[h.itemId] !== RENDER.TORCH;
    if (blocky) {
      mat4RotateY(m, m, 45 * DEG);
      mat4Scale(m, m, 0.4, 0.4, 0.4);
    } else {
      mat4Translate(m, m, 1.13 / 16, 3.2 / 16, 1.13 / 16);
      mat4RotateY(m, m, -90 * DEG);
      mat4RotateZ(m, m, 25 * DEG);
      mat4Scale(m, m, 0.68, 0.68, 0.68);
    }
    gl.uniformMatrix4fv(prog.u.uModel, false, m);
    itemMesh(h.itemId).draw();
  } else {
    // Empty hand: an arm-coloured box swinging like Minecraft's renderPlayerArm.
    const f2 = -0.3 * Math.sin(sq * Math.PI), f3 = 0.4 * Math.sin(sq * Math.PI * 2), f4 = -0.4 * Math.sin(s * Math.PI);
    mat4Translate(m, m, f2 + 0.64, f3 - 0.6 - eq * 0.6, f4 - 0.72);
    mat4RotateY(m, m, 45 * DEG);
    mat4RotateY(m, m, Math.sin(sq * Math.PI) * 70 * DEG);
    mat4RotateZ(m, m, Math.sin(s * s * Math.PI) * -20 * DEG);
    mat4RotateX(m, m, -75 * DEG);
    mat4RotateZ(m, m, 10 * DEG);
    mat4Translate(m, m, -0.15, 0.3, 0);
    mat4Scale(m, m, 0.25, 0.75, 0.25);
    gl.uniformMatrix4fv(prog.u.uModel, false, m);
    itemMesh(BLOCK.ORANGE_WOOL).draw();
  }
  gl.uniform1f(prog.u.uBright, 1);
  gl.uniformMatrix4fv(prog.u.uModel, false, ident);
}

const hotbarEls = [];
for (let i = 0; i < 9; i++) {
  const d = document.createElement('div');
  d.className = 'slot';
  $('hotbar').appendChild(d);
  hotbarEls.push(d);
}
let hotbarVersion = -1, hotbarSel = -1;
function updateHud(fps) {
  const p = player;
  const inv = p.inventory;
  if (inv.version !== hotbarVersion || p.selectedSlot !== hotbarSel) {
    hotbarVersion = inv.version; hotbarSel = p.selectedSlot;
    for (let i = 0; i < 9; i++) {
      const s = inv.get(i);
      const el = hotbarEls[i];
      el.className = 'slot' + (i === p.selectedSlot ? ' sel' : '');
      let html = s ? itemDisplayName(s.id) : '';
      if (s && s.count > 1) html += `<span class="n">${s.count}</span>`;
      const md = s ? maxDurability(s.id) : 0;
      if (s && md && s.damage) html += `<span class="d" style="width:${Math.round(34 * (1 - s.damage / md))}px"></span>`;
      el.innerHTML = html;
    }
  }
  $('hp').textContent = p.mode === 'creative' ? '创造模式' : `生命 ${p.health.toFixed(0)}/20`;
  $('air').textContent = p.mode !== 'creative' && p.air < 300 ? `氧气 ${Math.ceil(p.air / 30)}/10` : '';
  $('flash').style.opacity = String(p.hurtTime > 0 ? (p.hurtTime / p.hurtDuration) * 0.9 : 0);
  $('water').style.display = p.eyeInWater ? 'block' : 'none';
  $('lava').style.display = p.eyeInLava ? 'block' : 'none';
  $('log').textContent = logLines.join('\n');
  if (P.get('hud') === '0') return;
  const cam = p.getCameraState();
  const t = interaction.target;
  const br = interaction.breaking;
  const hs = Math.hypot(p.vx, p.vz);
  $('hud').textContent = [
    `WebCraft player sandbox   ${fps.toFixed(0)} fps   ${input.locked ? 'pointer locked' : input.allowUnlocked ? 'automation mode' : 'click to lock the pointer'}`,
    `pos ${p.x.toFixed(2)} ${p.y.toFixed(2)} ${p.z.toFixed(2)}   yaw ${(p.yaw / DEG).toFixed(1)} pitch ${(p.pitch / DEG).toFixed(1)}`,
    `vel ${p.vx.toFixed(2)} ${p.vy.toFixed(2)} ${p.vz.toFixed(2)}   horizontal ${hs.toFixed(3)} b/s`,
    `${p.mode} ${p.onGround ? 'onGround ' : ''}${p.flying ? 'flying ' : ''}${p.sprinting ? 'sprinting ' : ''}${p.sneaking ? 'sneaking ' : ''}${p.inWater ? 'inWater ' : ''}${p.eyeInWater ? 'eyeInWater ' : ''}${p.inLava ? 'inLava ' : ''}${p.onFire ? 'onFire ' : ''}${p.frozen ? 'frozen' : ''}`,
    `health ${p.health}  air ${p.air.toFixed(0)}  fall ${p.fallDistance.toFixed(2)}  hurt ${p.hurtTime.toFixed(2)}`,
    `camera fov ${cam.fov.toFixed(1)}  roll ${(cam.roll / DEG).toFixed(2)}°  eye ${p.eyeHeight.toFixed(3)}`,
    `target ${t ? `${BLOCKS[t.blockId].name} ${t.x},${t.y},${t.z} face ${t.face} d=${t.distance.toFixed(2)}` : '-'}`,
    `breaking ${br ? `${(br.progress * 100).toFixed(0)}% stage ${br.stage}` : '-'}   items ${entities.list.length}`,
  ].join('\n');
}

let last = performance.now();
let fpsSmooth = 60;
let frames = 0;
let elapsed = 0;
const stats = { frames: 0, playerMs: 0, interactionMs: 0 };
function frame(now) {
  const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
  last = now;
  elapsed += dt;
  if (dt > 0) fpsSmooth += (1 / dt - fpsSmooth) * 0.05;
  resize();
  const t0 = performance.now();
  player.update(dt, input);
  const t1 = performance.now();
  interaction.update(dt, input);
  const t2 = performance.now();
  stats.frames++; stats.playerMs += t1 - t0; stats.interactionMs += t2 - t1;
  entities.update(dt, player);
  for (const i of world.dirty) rebuildChunk(world, i);
  world.dirty.clear();
  gl.viewport(0, 0, canvas.width, canvas.height);
  drawWorld(player.getCameraState(), elapsed);
  drawHand();
  updateHud(fpsSmooth);
  input.endFrame();
  frames++;
  if (frames === 2) window.__test.ready = true;
  requestAnimationFrame(frame);
}

// ================================================================================================
// Automation hooks
// ================================================================================================
window.__test = {
  ready: false, game, player, interaction, input, world, entities, stats, diag, log: logLines,
  state() {
    const p = player, t = interaction.target, br = interaction.breaking;
    return {
      x: +p.x.toFixed(4), y: +p.y.toFixed(4), z: +p.z.toFixed(4), vx: +p.vx.toFixed(3), vy: +p.vy.toFixed(3), vz: +p.vz.toFixed(3),
      yaw: +(p.yaw / DEG).toFixed(2), pitch: +(p.pitch / DEG).toFixed(2), onGround: p.onGround, flying: p.flying,
      sprinting: p.sprinting, sneaking: p.sneaking, inWater: p.inWater, eyeInWater: p.eyeInWater, health: p.health,
      air: +p.air.toFixed(1), dead: p.dead, mode: p.mode, slot: p.selectedSlot,
      held: p.getSelectedStack(), target: t ? [t.x, t.y, t.z, t.face, BLOCKS[t.blockId].name] : null,
      breaking: br ? +br.progress.toFixed(3) : null, fov: +p.getCameraState().fov.toFixed(2), items: entities.list.length,
      locked: input.locked, active: input.active,
    };
  },
  tp(x, y, z) { player.setPosition(x, y, z); return this.state(); },
  look(yawDeg, pitchDeg) { player.yaw = yawDeg * DEG; player.pitch = pitchDeg * DEG; return this.state(); },
  setMode(m) { player.setGameMode(m); return player.mode; },
  give(name, count = 1, slot = player.selectedSlot) { player.inventory.set(slot, makeStack(itemId(name), count)); return player.getSelectedStack(); },
  getBlock(x, y, z) { return BLOCKS[world.getBlock(x, y, z)].name; },
  setBlock(x, y, z, name) { return world.setBlock(x, y, z, BLOCK[name.toUpperCase()]); },
  /** Resolve after `ms` of real frames. */
  wait(ms) { return new Promise((r) => setTimeout(r, ms)); },
};

initTextures().then((source) => {
  log(`textures: ${source}`);
  for (let i = 0; i < 16; i++) rebuildChunk(world, i);
  requestAnimationFrame((t) => { last = t; frame(t); });
});
