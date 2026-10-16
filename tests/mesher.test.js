import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRegion, computeLight } from '../src/world/lighting.js';
import { meshChunk, decodeVertex, decodeMesh, VERTEX_WORDS, QUAD_WORDS } from '../src/world/mesher.js';
import { BLOCK, FACE_LAYERS, TEXTURE_INDEX, IS_OPAQUE } from '../src/world/registry.js';
import { CHUNK_VOLUME, FACE_NORMALS, DEFAULT_TINTS, blockIndex, regionIndex } from '../src/config.js';

// ---- helpers -------------------------------------------------------------------------------
const emptyChunks = () => Array.from({ length: 9 }, () => new Uint8Array(CHUNK_VOLUME));
function put(chunks, x, y, z, id) {
  const n = ((z >> 4) + 1) * 3 + ((x >> 4) + 1);
  chunks[n][blockIndex(x & 15, y, z & 15)] = id;
}
function fill(chunks, x0, y0, z0, x1, y1, z1, id) {
  for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) put(chunks, x, y, z, id);
}
/** Mesh a scene given as [[x, y, z, id], ...] (region coordinates) or a chunks array. */
function mesh(scene, { mask = 0xffff, smooth = true, tints = null } = {}) {
  let chunks = scene;
  if (!(scene.length === 9 && scene[0] instanceof Uint8Array)) {
    chunks = emptyChunks();
    for (const [x, y, z, id] of scene) put(chunks, x, y, z, id);
  }
  const region = buildRegion(chunks);
  const light = computeLight(region);
  return meshChunk(region, light, mask, tints, { smoothLighting: smooth });
}
const section = (res, sy) => res.find((s) => s.sy === sy);
const quads = (arr) => decodeMesh(arr).map((q) => q.verts);
function allQuads(res) {
  const out = [];
  for (const s of res) {
    for (const layer of ['opaque', 'cutout', 'translucent']) {
      for (const q of quads(s[layer])) out.push({ layer, sy: s.sy, q });
    }
  }
  return out;
}
const sub = (a, b) => [a.x - b.x, a.y - b.y, a.z - b.z];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
/** Geometric normal of triangle (0,1,2) — counter-clockwise front face direction. */
const normalOf = (q) => cross(sub(q[1], q[0]), sub(q[2], q[0]));
/** Vertex of the quad with texel coordinates (u, v). */
const atUV = (q, u, v) => q.find((p) => p.u === u && p.v === v);
const range = (q, k) => [Math.min(...q.map((p) => p[k])), Math.max(...q.map((p) => p[k]))];
const approx = (a, b) => Math.abs(a - b) < 1e-9;

/** Independent encoder following SPEC §7 bit layout. */
function encode(v) {
  const w0 = (Math.round(v.x * 16) + 16) | ((Math.round(v.y * 16) + 16) << 9) | ((Math.round(v.z * 16) + 16) << 18) | (v.ao << 27) | (v.face << 29);
  const w1 = v.layer | (v.u << 8) | (v.v << 13) | (v.sky << 18) | (v.block << 24) | (v.anim << 30);
  const w2 = v.r | (v.g << 8) | (v.b << 16);
  return [w0 >>> 0, w1 >>> 0, w2 >>> 0];
}

/** Assert every quad is a CCW quad whose geometric normal matches the face index (0..5). */
function checkCubeQuad(q, face) {
  const n = normalOf(q);
  const N = FACE_NORMALS[face];
  const len = Math.hypot(...n);
  assert.ok(len > 0, 'degenerate quad');
  assert.ok(approx(dot(n, N) / len, 1), `face ${face}: normal ${n} not along ${N}`);
  // second triangle (0,2,3) has the same orientation
  const n2 = cross(sub(q[2], q[0]), sub(q[3], q[0]));
  assert.ok(dot(n2, N) > 0, `face ${face}: second triangle flipped`);
}

/** UV orientation rules: u left-to-right seen from outside, v = 0 at the top edge (side faces). */
function checkUVFrame(q, face) {
  const p00 = atUV(q, range(q, 'u')[0], range(q, 'v')[0]);
  const p10 = atUV(q, range(q, 'u')[1], range(q, 'v')[0]);
  const p01 = atUV(q, range(q, 'u')[0], range(q, 'v')[1]);
  assert.ok(p00 && p10 && p01, 'quad must be axis aligned in texture space');
  const du = sub(p10, p00), dv = sub(p01, p00);
  const N = FACE_NORMALS[face];
  let U, V;
  if (face === 2) { U = [1, 0, 0]; V = [0, 0, 1]; }
  else if (face === 3) { U = [1, 0, 0]; V = [0, 0, -1]; }
  else { U = cross([-N[0], -N[1], -N[2]], [0, 1, 0]); V = [0, -1, 0]; }   // right = forward x up
  assert.ok(dot(du, U) > 0 && Math.abs(dot(du, V)) < 1e-9, `face ${face}: u axis ${du} expected along ${U}`);
  assert.ok(dot(dv, V) > 0 && Math.abs(dot(dv, U)) < 1e-9, `face ${face}: v axis ${dv} expected along ${V}`);
  // Texel-exact: geometry extent (in 1/16 block) equals texel extent along both axes.
  assert.ok(approx(Math.hypot(...du) * 16, range(q, 'u')[1] - range(q, 'u')[0]), `face ${face}: u stretched`);
  assert.ok(approx(Math.hypot(...dv) * 16, range(q, 'v')[1] - range(q, 'v')[0]), `face ${face}: v stretched`);
}

// ---- vertex format ------------------------------------------------------------------------------
test('decodeVertex round-trips the SPEC bit layout', () => {
  const cases = [
    { x: 0, y: 0, z: 0, ao: 0, face: 0, layer: 0, u: 0, v: 0, sky: 0, block: 0, anim: 0, r: 0, g: 0, b: 0 },
    { x: 16, y: 16, z: 16, ao: 3, face: 6, layer: 255, u: 16, v: 16, sky: 60, block: 60, anim: 3, r: 255, g: 255, b: 255 },
    { x: -1, y: 30, z: 7.5625, ao: 2, face: 5, layer: 131, u: 7, v: 13, sky: 59, block: 1, anim: 2, r: 97, g: 153, b: 97 },
    { x: 0.125, y: 0.875, z: 15.9375, ao: 1, face: 3, layer: 64, u: 9, v: 6, sky: 33, block: 47, anim: 1, r: 1, g: 2, b: 3 },
  ];
  for (const c of cases) {
    const [w0, w1, w2] = encode(c);
    assert.deepEqual(decodeVertex(w0, w1, w2), c);
    assert.equal(w2 >>> 24, 0, 'top 8 bits of w2 reserved');
  }
  assert.equal(VERTEX_WORDS, 3);
  assert.equal(QUAD_WORDS, 12);
});

test('emitted words use the documented layout (stone block at a known spot)', () => {
  const res = mesh([[5, 70, 9, BLOCK.STONE]], { mask: 1 << 4 });
  const s = section(res, 4);
  assert.ok(s.opaque instanceof Uint32Array);
  assert.equal(s.opaque.length % QUAD_WORDS, 0);
  for (let k = 0; k < s.opaque.length; k += 3) {
    const w0 = s.opaque[k], w1 = s.opaque[k + 1], w2 = s.opaque[k + 2];
    const xs = w0 & 511, ys = (w0 >>> 9) & 511, zs = (w0 >>> 18) & 511;
    assert.ok(xs === 5 * 16 + 16 || xs === 6 * 16 + 16);
    assert.ok(ys === 6 * 16 + 16 || ys === 7 * 16 + 16);   // y 70 = section 4, local 6
    assert.ok(zs === 9 * 16 + 16 || zs === 10 * 16 + 16);
    assert.equal(w1 & 255, FACE_LAYERS[BLOCK.STONE * 6]);
    assert.equal(w2, 0xffffff);
  }
});

// ---- culling / counts ---------------------------------------------------------------------------
test('single cube: 6 CCW quads with correct normals, positions and UV frames', () => {
  const res = mesh([[3, 40, 4, BLOCK.STONE]]);
  const s = section(res, 2);
  const qs = quads(s.opaque);
  assert.equal(qs.length, 6);
  assert.equal(s.cutout, null);
  assert.equal(s.translucent, null);
  const faces = qs.map((q) => q[0].face).sort();
  assert.deepEqual(faces, [0, 1, 2, 3, 4, 5]);
  for (const q of qs) {
    const f = q[0].face;
    checkCubeQuad(q, f);
    checkUVFrame(q, f);
    assert.deepEqual(range(q, 'u'), [0, 16]);
    assert.deepEqual(range(q, 'v'), [0, 16]);
    for (const p of q) {
      assert.ok(p.x === 3 || p.x === 4);
      assert.ok(p.y === 8 || p.y === 9);   // 40 - 32
      assert.ok(p.z === 4 || p.z === 5);
      assert.equal(p.face, f);
      assert.equal(p.ao, 3);
      // the cell below a floating block only gets sideways sky light (14): (14 + 3 * 15) / 4 * 4 = 59
      assert.equal(p.sky, f === 3 ? 59 : 60);
      assert.equal(p.anim, 0);
    }
    // the face lies on the correct plane
    const N = FACE_NORMALS[f];
    const axis = N.findIndex((c) => c !== 0);
    const key = ['x', 'y', 'z'][axis];
    const want = [3, 8, 4][axis] + (N[axis] > 0 ? 1 : 0);
    for (const p of q) assert.equal(p[key], want);
  }
});

test('two adjacent cubes: 10 quads; opaque neighbours hide faces', () => {
  assert.equal(quads(section(mesh([[3, 40, 4, BLOCK.STONE], [4, 40, 4, BLOCK.DIRT]]), 2).opaque).length, 10);
  assert.equal(quads(section(mesh([[3, 40, 4, BLOCK.STONE], [3, 41, 4, BLOCK.STONE]]), 2).opaque).length, 10);
  // fully buried block: nothing
  const chunks = emptyChunks();
  fill(chunks, 0, 30, 0, 4, 34, 4, BLOCK.STONE);
  const res = mesh(chunks);   // y 30..34 spans sections 1 and 2
  assert.equal(quads(section(res, 1).opaque).length + quads(section(res, 2).opaque).length, 5 * 5 * 6);   // outer shell only
});

test('glass-glass faces are culled, leaves-leaves faces are kept (fancy leaves)', () => {
  const g = section(mesh([[3, 40, 4, BLOCK.GLASS], [4, 40, 4, BLOCK.GLASS]]), 2);
  assert.equal(g.opaque, null);
  assert.equal(quads(g.cutout).length, 10);
  const l = section(mesh([[3, 40, 4, BLOCK.OAK_LEAVES], [4, 40, 4, BLOCK.OAK_LEAVES]]), 2);
  assert.equal(quads(l.cutout).length, 12);
  for (const q of quads(l.cutout)) for (const p of q) assert.equal(p.anim, 2);
  // different translucent cubes keep their shared faces; stone next to glass keeps its face
  const mix = section(mesh([[3, 40, 4, BLOCK.STONE], [4, 40, 4, BLOCK.GLASS]]), 2);
  assert.equal(quads(mix.opaque).length, 6);
  assert.equal(quads(mix.cutout).length, 5);
  const ice = section(mesh([[3, 40, 4, BLOCK.ICE], [4, 40, 4, BLOCK.ICE], [5, 40, 4, BLOCK.GLASS]]), 2);
  assert.equal(quads(ice.translucent).length, 10);
  assert.equal(quads(ice.cutout).length, 6);
});

test('layer routing (by texture layer of the block, on a bedrock base)', () => {
  const cases = [
    [BLOCK.STONE, 'opaque'], [BLOCK.GRASS_BLOCK, 'opaque'], [BLOCK.LAVA, 'opaque'], [BLOCK.GLOWSTONE, 'opaque'],
    [BLOCK.OAK_LOG_X, 'opaque'], [BLOCK.GLASS, 'cutout'], [BLOCK.OAK_LEAVES, 'cutout'], [BLOCK.POPPY, 'cutout'],
    [BLOCK.TORCH, 'cutout'], [BLOCK.CACTUS, 'cutout'], [BLOCK.SUGAR_CANE, 'cutout'],
    [BLOCK.WATER, 'translucent'], [BLOCK.ICE, 'translucent'],
  ];
  const bedrockLayer = FACE_LAYERS[BLOCK.BEDROCK * 6];
  for (const [id, layer] of cases) {
    const base = id === BLOCK.CACTUS ? BLOCK.SAND : id === BLOCK.SUGAR_CANE ? BLOCK.DIRT : BLOCK.BEDROCK;
    const s = section(mesh([[3, 40, 4, base], [3, 41, 4, id]]), 2);
    const own = new Set(Array.from({ length: 6 }, (_, f) => FACE_LAYERS[id * 6 + f]));
    for (const l of ['opaque', 'cutout', 'translucent']) {
      const mine = quads(s[l]).filter((q) => own.has(q[0].layer) && q[0].layer !== bedrockLayer);
      if (l === layer) assert.ok(mine.length > 0, `block ${id} must emit into ${l}`);
      else assert.equal(mine.length, 0, `block ${id} must not emit into ${l}`);
    }
  }
});

test('chunk borders: neighbour chunk blocks cull faces and y limits are respected', () => {
  // +X face of a block at local x=15 is hidden by a block in the east neighbour chunk
  let s = section(mesh([[15, 40, 4, BLOCK.STONE], [16, 40, 4, BLOCK.STONE]]), 2);
  assert.equal(quads(s.opaque).filter((q) => q[0].face === 0).length, 0);
  assert.equal(quads(s.opaque).length, 5);
  s = section(mesh([[0, 40, 0, BLOCK.STONE], [-1, 40, 0, BLOCK.STONE], [0, 40, -1, BLOCK.STONE]]), 2);
  assert.equal(quads(s.opaque).length, 4);
  // y = 0: no bottom face; y = 255: top face present, lit by open sky
  const bottom = section(mesh([[2, 0, 2, BLOCK.BEDROCK]]), 0);
  assert.equal(quads(bottom.opaque).length, 5);
  assert.ok(!quads(bottom.opaque).some((q) => q[0].face === 3));
  const top = section(mesh([[2, 255, 2, BLOCK.STONE]]), 15);
  const topFace = quads(top.opaque).find((q) => q[0].face === 2);
  assert.ok(topFace);
  for (const p of topFace) { assert.equal(p.y, 16); assert.equal(p.sky, 60); }
});

// ---- sections ---------------------------------------------------------------------------------
test('section mask is honoured and empty sections give nulls', () => {
  const scene = [[1, 70, 1, BLOCK.STONE], [1, 90, 1, BLOCK.STONE]];   // sections 4 and 5
  const one = mesh(scene, { mask: 1 << 4 });
  assert.equal(one.length, 1);
  assert.equal(one[0].sy, 4);
  assert.equal(quads(one[0].opaque).length, 6);
  assert.deepEqual(mesh(scene, { mask: 0 }), []);
  const all = mesh(scene);
  assert.deepEqual(all.map((s) => s.sy), [...Array(16).keys()]);
  for (const s of all) {
    if (s.sy === 4 || s.sy === 5) assert.equal(quads(s.opaque).length, 6);
    else assert.deepEqual(s, { sy: s.sy, opaque: null, cutout: null, translucent: null });
  }
  const picked = mesh(scene, { mask: (1 << 5) | (1 << 9) | (1 << 0) });
  assert.deepEqual(picked.map((s) => s.sy), [0, 5, 9]);
  assert.equal(picked[0].opaque, null);
  assert.equal(picked[2].opaque, null);
  const empty = mesh(emptyChunks());
  assert.equal(empty.length, 16);
  for (const s of empty) assert.ok(s.opaque === null && s.cutout === null && s.translucent === null);
  // a non-empty but fully enclosed section yields nulls too
  const chunks = emptyChunks();
  fill(chunks, -16, 0, -16, 31, 47, 31, BLOCK.STONE);
  const solid = mesh(chunks, { mask: 0b111 });
  assert.equal(solid[0].opaque, null);
  assert.equal(solid[1].opaque, null);
  assert.equal(quads(solid[2].opaque).length, 256);   // top layer of the stone
});

test('blocks in neighbour chunks never produce geometry; results are exact-size copies', () => {
  const res = mesh([[-1, 40, 0, BLOCK.STONE], [16, 40, 0, BLOCK.STONE], [3, 40, 20, BLOCK.STONE]]);
  for (const s of res) assert.ok(s.opaque === null && s.cutout === null && s.translucent === null);
  const a = mesh([[3, 40, 4, BLOCK.STONE]]);
  const b = mesh([[3, 40, 4, BLOCK.GLASS], [8, 40, 8, BLOCK.STONE]]);
  assert.equal(section(a, 2).opaque.length, 6 * QUAD_WORDS);   // not clobbered by the second job
  assert.equal(section(a, 2).opaque.buffer.byteLength, 6 * QUAD_WORDS * 4);
  assert.equal(section(b, 2).cutout.length, 6 * QUAD_WORDS);
});

// ---- render types -------------------------------------------------------------------------------
test('cross plants: 4 double-sided quads, face 6, ao 3, own-cell light, sway on top vertices only', () => {
  const chunks = emptyChunks();
  fill(chunks, -16, 0, -16, 31, 39, 31, BLOCK.STONE);
  put(chunks, 3, 40, 4, BLOCK.POPPY);
  put(chunks, 8, 40, 8, BLOCK.TORCH);
  const s = section(mesh(chunks), 2);
  const qs = quads(s.cutout).filter((q) => q[0].layer === FACE_LAYERS[BLOCK.POPPY * 6]);
  assert.equal(qs.length, 4);
  const normals = [];
  for (const q of qs) {
    const n = normalOf(q);
    assert.ok(n[1] === 0, 'vertical plane');
    assert.ok(Math.abs(n[0]) > 0 && Math.abs(n[2]) > 0, 'diagonal plane');
    normals.push(n.map(Math.sign).join(','));
    for (const p of q) {
      assert.equal(p.face, 6);
      assert.equal(p.ao, 3);
      assert.equal(p.anim, p.y === 9 ? 1 : 0);
      assert.ok(p.x === 3 + 2 / 16 || p.x === 3 + 14 / 16);
      assert.ok(p.z === 4 + 2 / 16 || p.z === 4 + 14 / 16);
      assert.equal(p.sky, 60);
      assert.equal(p.block, 4 * (14 - 5 - 4));   // torch 14, Manhattan distance 9 from the plant cell
    }
    // texture upright and unmirrored from the viewing side: v=0 on top, u to the viewer's right
    const t0 = atUV(q, 0, 0), t1 = atUV(q, 16, 0), b0 = atUV(q, 0, 16);
    assert.ok(t0.y === 9 && b0.y === 8);
    const right = cross(normals.at(-1).split(',').map(Number).map((c) => -c), [0, 1, 0]);
    assert.ok(dot(sub(t1, t0), right) > 0, 'u runs left-to-right seen from the front');
  }
  assert.deepEqual(normals.sort(), ['-1,0,-1', '-1,0,1', '1,0,-1', '1,0,1']);
});

test('stacked sugar cane only sways at the top of the stack; mushrooms do not sway', () => {
  const s = section(mesh([[3, 40, 4, BLOCK.SAND], [3, 41, 4, BLOCK.SUGAR_CANE], [3, 42, 4, BLOCK.SUGAR_CANE], [6, 41, 6, BLOCK.RED_MUSHROOM], [6, 40, 6, BLOCK.STONE]]), 2);
  const cane = quads(s.cutout).filter((q) => q[0].layer === FACE_LAYERS[BLOCK.SUGAR_CANE * 6]);
  assert.equal(cane.length, 8);
  for (const q of cane) {
    for (const p of q) assert.equal(p.anim, approx(p.y, 11) ? 1 : 0, `cane vertex at y=${p.y}`);
  }
  const mush = quads(s.cutout).filter((q) => q[0].layer === FACE_LAYERS[BLOCK.RED_MUSHROOM * 6]);
  assert.equal(mush.length, 4);
  for (const q of mush) for (const p of q) assert.equal(p.anim, 0);
});

test('torch: 2x10 px post with texel sub-rects, CCW, bottom only over non-opaque blocks', () => {
  const onStone = section(mesh([[3, 40, 4, BLOCK.STONE], [3, 41, 4, BLOCK.TORCH]]), 2);
  const tq = quads(onStone.cutout);
  assert.equal(tq.length, 5);
  const onGlass = section(mesh([[3, 40, 4, BLOCK.GLASS], [3, 41, 4, BLOCK.TORCH]]), 2);
  const gq = quads(onGlass.cutout).filter((q) => q[0].layer === FACE_LAYERS[BLOCK.TORCH * 6]);
  assert.equal(gq.length, 6);
  const center = [3.5, 9 + 5 / 16, 4.5];
  for (const q of gq) {
    const n = normalOf(q);
    const c = [0, 1, 2, 3].reduce((a, k) => [a[0] + q[k].x / 4, a[1] + q[k].y / 4, a[2] + q[k].z / 4], [0, 0, 0]);
    assert.ok(dot(n, [c[0] - center[0], c[1] - center[1], c[2] - center[2]]) > 0, 'outward winding');
    for (const p of q) {
      assert.equal(p.face, 6);
      assert.equal(p.ao, 3);
      assert.equal(p.block, 56);            // own cell: torch light 14
      assert.ok(p.x >= 3 + 7 / 16 - 1e-9 && p.x <= 3 + 9 / 16 + 1e-9);
      assert.ok(p.z >= 4 + 7 / 16 - 1e-9 && p.z <= 4 + 9 / 16 + 1e-9);
      assert.ok(p.y >= 9 - 1e-9 && p.y <= 9 + 10 / 16 + 1e-9);
    }
    const ny = Math.sign(n[1]);
    assert.deepEqual(range(q, 'u'), [7, 9]);
    if (ny > 0) { assert.deepEqual(range(q, 'v'), [6, 8]); checkUVFrame(q, 2); }
    else if (ny < 0) { assert.deepEqual(range(q, 'v'), [13, 15]); checkUVFrame(q, 3); }
    else {
      assert.deepEqual(range(q, 'v'), [6, 16]);
      // v=6 at the top of the post, u to the right seen from outside
      const face = [0, 1, 4, 5].find((f) => dot(FACE_NORMALS[f], n) > 0);
      checkUVFrame(q, face);
      assert.ok(approx(atUV(q, 7, 6).y, 9 + 10 / 16));
    }
  }
});

/** Height (px above y0) of every top-face vertex of a liquid quad list, keyed 'x,z' (blocks); asserts sharing. */
function topCorners(qs, y0) {
  const out = new Map();
  for (const q of qs.filter((q) => q[0].face === 2)) {
    for (const p of q) {
      const key = `${p.x},${p.z}`;
      const h = Math.round((p.y - y0) * 16);
      if (out.has(key)) assert.equal(out.get(key), h, `corner ${key} must be shared exactly (seamless)`);
      out.set(key, h);
    }
  }
  return out;
}

/** Minecraft corner height (px) from the levels of the liquid cells around a corner (+ count of empty cells). */
function mcCorner(levels, empty = 0) {
  let d = 9 * empty, w = empty;
  for (const l of levels) {
    if (l === 0) { d += 11; w += 11; } else { d += l + 1; w += 1; }
  }
  return Math.min(16, Math.max(1, Math.round(16 - (16 * d) / (9 * w))));
}

test('water: source in a hole sits at 14/16 (8/9 quantised), sides follow it with texel rows 2..16', () => {
  // A source surrounded by stone on all sides except above: every corner is the source height.
  const scene = [[3, 40, 4, BLOCK.STONE], [3, 41, 4, BLOCK.WATER]];
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) scene.push([3 + dx, 41, 4 + dz, BLOCK.STONE]);
  const s = section(mesh(scene), 2);
  const wq = quads(s.translucent);
  assert.equal(wq.length, 1, 'only the surface (sides face stone)');
  const top = wq[0];
  checkCubeQuad(top, 2);
  checkUVFrame(top, 2);
  for (const p of top) {
    assert.ok(approx(p.y, 9 + 14 / 16));
    assert.equal(p.anim, 3);
    assert.equal(p.ao, 3);
    assert.equal(p.layer, TEXTURE_INDEX.get('water_still'));
  }
  // Open on the east: the side face follows the corner heights and its texels start at row 16 - h.
  const open = scene.filter(([x, , z]) => !(x === 4 && z === 4));
  const s2 = section(mesh(open), 2);
  const side = quads(s2.translucent).filter((q) => q[0].face === 0);
  assert.equal(side.length, 1);
  const q = side[0];
  checkCubeQuad(q, 0);
  for (const p of q) {
    assert.equal(p.v, 16 - Math.round((p.y - 9) * 16), 'planar texel rows on the trapezoid');
    assert.ok(p.y === 9 || p.y > 9 + 8 / 16, 'bottom at the block bottom, top near the surface');
  }
  assert.deepEqual(range(q, 'u'), [0, 16]);
});

test('liquid corner heights follow Minecraft: lone source 11/16, lake 14/16, flowing levels, falling full', () => {
  // lone source on stone with air all around: (11 * 1/9 + 3 * 1) / 14 -> 1 - 0.302 -> 11/16
  let s = section(mesh([[3, 40, 4, BLOCK.STONE], [3, 41, 4, BLOCK.WATER]]), 2);
  let top = topCorners(quads(s.translucent), 9);
  assert.equal(top.size, 4);
  for (const h of top.values()) assert.equal(h, mcCorner([0], 3));
  assert.equal(mcCorner([0], 3), 11);
  assert.equal(quads(s.translucent).length, 5, 'top + 4 sides (stone below: no bottom)');
  // a 3x3 lake on a stone floor with stone walls: every corner at 14/16
  const lake = emptyChunks();
  fill(lake, 0, 40, 0, 6, 41, 6, BLOCK.STONE);
  fill(lake, 2, 41, 2, 4, 41, 4, BLOCK.WATER);
  top = topCorners(quads(section(mesh(lake), 2).translucent), 9);
  assert.equal(top.size, 16);
  for (const h of top.values()) assert.equal(h, 14);
  // a flowing row on stone, walled in on both sides: source, levels 1..7 -> heights fall step by step
  const row = emptyChunks();
  fill(row, 0, 40, 0, 12, 40, 6, BLOCK.STONE);
  fill(row, 0, 41, 2, 12, 41, 2, BLOCK.STONE);
  fill(row, 0, 41, 4, 12, 41, 4, BLOCK.STONE);
  put(row, 1, 41, 3, BLOCK.WATER);
  for (let l = 1; l <= 7; l++) put(row, 1 + l, 41, 3, BLOCK[`WATER_FLOWING_${l}`]);
  put(row, 0, 41, 3, BLOCK.STONE);
  put(row, 9, 41, 3, BLOCK.STONE);
  top = topCorners(quads(section(mesh(row), 2).translucent), 9);
  assert.equal(top.get('1,3'), mcCorner([0]));
  assert.equal(top.get('2,3'), mcCorner([0, 1]));
  for (let l = 1; l < 7; l++) assert.equal(top.get(`${2 + l},3`), mcCorner([l, l + 1]), `between level ${l} and ${l + 1}`);
  assert.equal(top.get('9,3'), mcCorner([7]));
  const heights = [...Array(9).keys()].map((k) => top.get(`${1 + k},3`));
  for (let k = 1; k < heights.length; k++) assert.ok(heights[k] <= heights[k - 1], `monotone slope ${heights}`);
  assert.ok(heights[8] >= 1 && heights[8] <= 3, 'the thin end of the stream');
  // falling water (or the same liquid above) makes every corner it touches full height
  s = section(mesh([[3, 40, 4, BLOCK.STONE], [4, 40, 4, BLOCK.STONE], [3, 41, 4, BLOCK.WATER_FALLING], [4, 41, 4, BLOCK.WATER_FLOWING_1]]), 2);
  top = topCorners(quads(s.translucent), 9);
  assert.equal(top.get('4,4'), 16);
  assert.equal(top.get('4,5'), 16);
  assert.equal(top.get('3,4'), 16);
  assert.equal(top.get('5,4'), mcCorner([1], 3), 'the far corner of the flowing cell');
  s = section(mesh([[3, 40, 4, BLOCK.STONE], [4, 40, 4, BLOCK.STONE], [3, 41, 4, BLOCK.WATER], [3, 42, 4, BLOCK.WATER], [4, 41, 4, BLOCK.WATER_FLOWING_1]]), 2);
  top = topCorners(quads(s.translucent).filter((q) => q.every((p) => p.y <= 10)), 9);
  assert.equal(top.get('4,4'), 16, 'water above the neighbour: full height at the shared corners');
});

test('liquid surfaces are seamless between cells of different levels and across chunk borders', () => {
  // A random puddle of mixed levels straddling the chunk border at x = 16, meshed as two chunks.
  const rnd = mulberry32(5);
  const chunks = emptyChunks();
  fill(chunks, 8, 40, 8, 23, 40, 23, BLOCK.STONE);
  const ids = [BLOCK.WATER, BLOCK.WATER_FLOWING_1, BLOCK.WATER_FLOWING_3, BLOCK.WATER_FLOWING_6, BLOCK.WATER_FALLING, BLOCK.AIR, BLOCK.STONE];
  for (let z = 10; z < 22; z++) for (let x = 10; x < 22; x++) put(chunks, x, 41, z, ids[Math.floor(rnd() * ids.length)]);
  const region = buildRegion(chunks);
  const res = meshChunk(region, computeLight(region), 1 << 2, null);
  // Mesh the east neighbour by shifting the 3x3 window one chunk east (column 2 becomes the centre).
  const shifted = emptyChunks();
  for (let dz = 0; dz < 3; dz++) for (let dx = 0; dx < 2; dx++) shifted[dz * 3 + dx] = chunks[dz * 3 + dx + 1];
  const r2 = buildRegion(shifted);
  const res2 = meshChunk(r2, computeLight(r2), 1 << 2, null);
  const corners = new Map();
  const add = (qs, ox) => {
    for (const q of qs.filter((q) => q[0].face === 2)) {
      for (const p of q) {
        const key = `${p.x + ox},${p.z}`;
        const hgt = Math.round((p.y - 9) * 16);
        if (corners.has(key)) assert.equal(corners.get(key), hgt, `corner ${key}`);
        corners.set(key, hgt);
      }
    }
  };
  add(quads(res[0].translucent), 0);
  add(quads(res2[0].translucent), 16);
  assert.ok(corners.size > 40, `${corners.size} shared corners checked`);
  let border = 0;
  for (const k of corners.keys()) if (k.startsWith('16,')) border++;
  assert.ok(border > 3, 'corners on the chunk border were compared');
  // vertical faces span from the block bottom to the corner heights, texel rows matching
  for (const r of [res[0], res2[0]]) {
    for (const q of quads(r.translucent)) {
      const f = q[0].face;
      if (f === 2 || f === 3) continue;
      for (const p of q) assert.ok(p.y >= 9 && p.y <= 10 && p.v === 16 - Math.round((p.y - 9) * 16));
    }
  }
});

test('water culling: against stone and water hidden, against air/glass/plants visible, bottom over air', () => {
  // water pair + stone wall on the east
  let s = section(mesh([[3, 41, 4, BLOCK.WATER], [4, 41, 4, BLOCK.WATER], [5, 41, 4, BLOCK.STONE], [3, 40, 4, BLOCK.STONE], [4, 40, 4, BLOCK.STONE]]), 2);
  let wq = quads(s.translucent);
  assert.equal(wq.filter((q) => q[0].face === 0).length, 0);       // east: stone at x=5, water at x=4
  assert.equal(wq.filter((q) => q[0].face === 1).length, 1);       // west of x=3
  assert.equal(wq.filter((q) => q[0].face === 3).length, 0);       // stone below
  assert.equal(wq.length, 2 + 1 + 2 + 2);
  // flowing water next to a source: no face between them (one liquid)
  s = section(mesh([[3, 41, 4, BLOCK.WATER], [4, 41, 4, BLOCK.WATER_FLOWING_3], [3, 40, 4, BLOCK.STONE], [4, 40, 4, BLOCK.STONE]]), 2);
  wq = quads(s.translucent);
  assert.equal(wq.filter((q) => (q[0].face === 0 || q[0].face === 1) && q.every((p) => approx(p.x, 4))).length, 0);
  // glass and plants next to water: water faces visible, bottom face over air
  s = section(mesh([[3, 41, 4, BLOCK.WATER], [4, 41, 4, BLOCK.GLASS], [2, 41, 4, BLOCK.SHORT_GRASS]]), 2);
  wq = quads(s.translucent);
  assert.equal(wq.length, 6);
  assert.equal(wq.filter((q) => q[0].face === 3).length, 1);
  // water above lava: no bottom face; lava has its own (opaque layer) faces
  s = section(mesh([[3, 41, 4, BLOCK.WATER], [3, 40, 4, BLOCK.LAVA]]), 2);
  assert.equal(quads(s.translucent).filter((q) => q[0].face === 3).length, 0);
  const lq = quads(s.opaque);
  assert.equal(lq.length, 6);   // lava top (water above is not the same liquid) + 4 sides + bottom
  for (const q of lq) for (const p of q) assert.equal(p.anim, 3);
  // stacked water: lower block has no top and full-height sides; the upper surface uses corner heights
  s = section(mesh([[3, 41, 4, BLOCK.WATER], [3, 42, 4, BLOCK.WATER]]), 2);
  wq = quads(s.translucent);
  const lowerSides = wq.filter((q) => q[0].face !== 2 && q[0].face !== 3 && range(q, 'y')[0] === 9);
  assert.equal(lowerSides.length, 4);
  for (const q of lowerSides) { assert.deepEqual(range(q, 'y'), [9, 10]); assert.deepEqual(range(q, 'v'), [0, 16]); }
  assert.equal(wq.filter((q) => q[0].face === 2).length, 1);
  assert.ok(approx(wq.find((q) => q[0].face === 2)[0].y, 10 + 11 / 16));
  // a surface under an opaque block is still drawn (visible through the gap, like Minecraft)
  s = section(mesh([[3, 41, 4, BLOCK.WATER], [3, 42, 4, BLOCK.STONE]]), 2);
  assert.equal(quads(s.translucent).filter((q) => q[0].face === 2).length, 1);
});

test('lava uses the same corner rules (its own kind) and stays in the opaque layer', () => {
  const s = section(mesh([[3, 40, 4, BLOCK.STONE], [4, 40, 4, BLOCK.STONE], [3, 41, 4, BLOCK.LAVA], [4, 41, 4, BLOCK.LAVA_FLOWING_2],
    [5, 41, 4, BLOCK.WATER_FLOWING_1], [5, 40, 4, BLOCK.STONE]]), 2);
  const lq = quads(s.opaque).filter((q) => q[0].anim === 3);
  const top = topCorners(lq, 9);
  // corner between the lava source and the level-2 lava, two air cells on the other side
  assert.equal(top.get('4,4'), mcCorner([0, 2], 2));
  // the water next to the lava is a different liquid: faces exist on both sides of x = 5
  assert.equal(lq.filter((q) => q[0].face === 0 && q.every((p) => approx(p.x, 5))).length, 1);
  assert.equal(quads(s.translucent).filter((q) => q[0].face === 1 && q.every((p) => approx(p.x, 5))).length, 1);
});

test('liquid surfaces are lit by max(cell above, own cell): lava surfaces are fully bright', () => {
  const chunks = emptyChunks();
  fill(chunks, -16, 0, -16, 31, 39, 31, BLOCK.STONE);
  fill(chunks, 1, 39, 1, 3, 39, 3, BLOCK.LAVA);        // lava pool flush with the ground
  fill(chunks, 12, 39, 12, 14, 39, 14, BLOCK.WATER);   // far enough to get no lava light
  const s = section(mesh(chunks), 2);
  const lavaTop = quads(s.opaque).filter((q) => q[0].anim === 3 && q[0].face === 2);
  assert.equal(lavaTop.length, 9);
  for (const q of lavaTop) for (const p of q) { assert.equal(p.block, 60); assert.equal(p.sky, 60); assert.ok(approx(p.y, 7 + 14 / 16)); }
  const waterTop = quads(s.translucent).filter((q) => q[0].face === 2);
  assert.equal(waterTop.length, 9);
  for (const q of waterTop) for (const p of q) { assert.equal(p.sky, 60); assert.equal(p.block, 0); }
});

test('cactus: inset full-width sides (spines overhang), flush top, no faces between stacked cacti', () => {
  const s = section(mesh([[3, 40, 4, BLOCK.SAND], [3, 41, 4, BLOCK.CACTUS], [3, 42, 4, BLOCK.CACTUS]]), 2);
  const cq = quads(s.cutout);
  assert.equal(cq.length, 4 + 4 + 1);   // two layers of sides + one top
  for (const q of cq) {
    const f = q[0].face;
    checkCubeQuad(q, f);
    checkUVFrame(q, f);
    // Minecraft's cactus model (review RENDER-2): the top is 14/16 (texels 1..15); the sides are inset by
    // 1/16 along their normal but span the full width, so the edge spines (texture columns 0/15) are drawn.
    assert.deepEqual(range(q, 'u'), f === 2 ? [1, 15] : [0, 16]);
    if (f === 2) {
      assert.deepEqual(range(q, 'v'), [1, 15]);
      for (const p of q) assert.ok(approx(p.y, 11));
    } else {
      assert.deepEqual(range(q, 'v'), [0, 16]);
      const N = FACE_NORMALS[f];
      const axis = N.findIndex((c) => c !== 0);
      const key = ['x', 'y', 'z'][axis];
      const base = [3, 0, 4][axis];
      for (const p of q) assert.ok(approx(p[key], base + (N[axis] > 0 ? 15 / 16 : 1 / 16)));
    }
  }
  // inset sides are never culled, even by opaque neighbours
  const walled = section(mesh([[3, 40, 4, BLOCK.SAND], [3, 41, 4, BLOCK.CACTUS], [4, 41, 4, BLOCK.STONE], [2, 41, 4, BLOCK.STONE]]), 2);
  assert.equal(quads(walled.cutout).length, 5);
  for (const q of quads(walled.cutout)) for (const p of q) assert.ok(p.sky > 0, 'lit from its own cell');
});

// ---- smooth lighting & AO -------------------------------------------------------------------
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function topFaceOf(res, x, y, z) {
  const s = section(res, y >> 4);
  return quads(s.opaque).find((q) => q[0].face === 2 && q.every((p) => p.x >= x && p.x <= x + 1 && p.z >= z && p.z <= z + 1 && approx(p.y, (y & 15) + 1)));
}

/** Independent implementation of the SPEC §7 per-vertex rule for a full cube face. */
function expectVertex(region, light, b, f, p) {
  const N = FACE_NORMALS[f];
  const [a1, a2] = [0, 1, 2].filter((a) => N[a] === 0);
  const c0 = [b[0] + N[0], b[1] + N[1], b[2] + N[2]];
  const d1 = [0, 0, 0], d2 = [0, 0, 0];
  d1[a1] = p[a1] > b[a1] + 0.5 ? 1 : -1;
  d2[a2] = p[a2] > b[a2] + 0.5 ? 1 : -1;
  const add = (u, v) => [u[0] + v[0], u[1] + v[1], u[2] + v[2]];
  const s1 = add(c0, d1), s2 = add(c0, d2), cc = add(s1, d2);
  const opq = (c) => (c[1] < 0 ? 1 : c[1] > 255 ? 0 : IS_OPAQUE[region[regionIndex(c[0], c[1], c[2])]]);
  const lt = (c) => (c[1] < 0 ? 0 : c[1] > 255 ? 0xf0 : light[regionIndex(c[0], c[1], c[2])]);
  const o1 = opq(s1), o2 = opq(s2), oc = opq(cc);
  const ao = o1 && o2 ? 0 : 3 - (o1 + o2 + oc);
  const samples = [];
  if (!opq(c0)) samples.push(lt(c0));
  if (!o1) samples.push(lt(s1));
  if (!o2) samples.push(lt(s2));
  if (!oc && !(o1 && o2)) samples.push(lt(cc));
  assert.ok(samples.length > 0);
  const avg = (sh) => Math.round((samples.reduce((acc, l) => acc + ((l >> sh) & 15), 0) * 4) / samples.length);
  return { ao, sky: avg(4), block: avg(0), flatSky: (lt(c0) >> 4) * 4, flatBlock: (lt(c0) & 15) * 4 };
}

function randomCubeScene(seed) {
  const rnd = mulberry32(seed);
  const chunks = emptyChunks();
  fill(chunks, -16, 0, -16, 31, 29, 31, BLOCK.STONE);
  for (let y = 30; y < 46; y++) {
    for (let z = -3; z < 19; z++) {
      for (let x = -3; x < 19; x++) {
        const r = rnd();
        const id = r < 0.33 ? BLOCK.STONE : r < 0.38 ? BLOCK.GLASS : r < 0.43 ? BLOCK.OAK_LEAVES : r < 0.46 ? BLOCK.TORCH
          : r < 0.47 ? BLOCK.GLOWSTONE : r < 0.5 ? BLOCK.DIRT : BLOCK.AIR;
        put(chunks, x, y, z, id);
      }
    }
  }
  fill(chunks, -16, 47, -16, 31, 47, 10, BLOCK.STONE);   // partial roof: sideways sky light
  return chunks;
}

test('every cube face of a random scene follows the per-vertex AO + smooth light rule and the diagonal rule', () => {
  const cubeIds = [BLOCK.STONE, BLOCK.GLASS, BLOCK.OAK_LEAVES, BLOCK.GLOWSTONE, BLOCK.DIRT];
  const cubeLayers = new Set(cubeIds.map((id) => FACE_LAYERS[id * 6]));
  for (const seed of [3, 4]) {
    const region = buildRegion(randomCubeScene(seed));
    const light = computeLight(region);
    let checked = 0, flipped = 0;
    const aoSeen = new Set();
    for (const smooth of [true, false]) {
      const res = meshChunk(region, light, 0xffff, null, { smoothLighting: smooth });
      for (const { sy, q } of allQuads(res)) {
        const f = q[0].face;
        if (f > 5 || !cubeLayers.has(q[0].layer)) continue;
        checkCubeQuad(q, f);
        const N = FACE_NORMALS[f];
        const cx = q.reduce((a, p) => a + p.x, 0) / 4;
        const cy = q.reduce((a, p) => a + p.y, 0) / 4 + sy * 16;
        const cz = q.reduce((a, p) => a + p.z, 0) / 4;
        const b = [Math.floor(cx - N[0] * 0.5), Math.floor(cy - N[1] * 0.5), Math.floor(cz - N[2] * 0.5)];
        for (const p of q) {
          const e = expectVertex(region, light, b, f, [p.x, p.y + sy * 16, p.z]);
          if (smooth) {
            assert.equal(p.ao, e.ao, `ao at ${b} face ${f}`);
            assert.equal(p.sky, e.sky, `sky at ${b} face ${f}`);
            assert.equal(p.block, e.block, `block light at ${b} face ${f}`);
            aoSeen.add(p.ao);
          } else {
            assert.equal(p.ao, 3);
            assert.equal(p.sky, e.flatSky);
            assert.equal(p.block, e.flatBlock);
          }
        }
        // Diagonal rule: the emitted diagonal (v0-v2) joins the pair with the larger AO sum, ties
        // broken by the larger light sum (equivalent to SPEC's "flip when ao0+ao2 < ao1+ao3").
        const A = (k) => q[k].ao, Lt = (k) => q[k].sky + q[k].block;
        assert.ok(A(0) + A(2) >= A(1) + A(3), 'diagonal along the brighter AO pair');
        if (A(0) + A(2) === A(1) + A(3)) assert.ok(Lt(0) + Lt(2) >= Lt(1) + Lt(3), 'light tie-break');
        if (smooth && (q[0].u !== 0 || q[0].v !== 0)) flipped++;
        checked++;
      }
    }
    assert.ok(checked > 1000, `checked ${checked} quads`);
    assert.ok(flipped > 20, `flipped quads exercised (${flipped})`);
    assert.deepEqual([...aoSeen].sort(), [0, 1, 2, 3]);
  }
});

test('AO in an inside corner (0 where both sides are opaque, corner excluded from the light)', () => {
  const chunks = emptyChunks();
  fill(chunks, -16, 0, -16, 31, 10, 31, BLOCK.STONE);
  put(chunks, 3, 11, 4, BLOCK.STONE);   // west wall
  put(chunks, 4, 11, 3, BLOCK.STONE);   // north wall
  put(chunks, 3, 11, 3, BLOCK.STONE);   // corner
  const q = topFaceOf(mesh(chunks), 4, 10, 4);
  assert.ok(q);
  const at = (x, z) => q.find((p) => p.x === x && p.z === z);
  assert.equal(at(4, 4).ao, 0);
  assert.equal(at(5, 4).ao, 2);   // north side opaque, corner (5,11,3) open
  assert.equal(at(4, 5).ao, 2);
  assert.equal(at(5, 5).ao, 3);
  assert.equal(at(4, 4).sky, 60);   // only the open cell in front counts
  checkCubeQuad(q, 2);
});

test('diagonal flip: emitted as v1,v2,v3,v0 when ao0+ao2 < ao1+ao3 (and by light on AO ties)', () => {
  const base = () => {
    const chunks = emptyChunks();
    fill(chunks, -16, 0, -16, 31, 10, 31, BLOCK.STONE);
    return chunks;
  };
  const first = (chunks) => {
    const q = topFaceOf(mesh(chunks), 4, 10, 4);
    checkCubeQuad(q, 2);
    return [q[0].x, q[0].z];
  };
  // canonical top-face order: v0 (x0,z0), v1 (x0,z1), v2 (x1,z1), v3 (x1,z0)
  assert.deepEqual(first(base()), [4, 4]);
  let c = base(); put(c, 3, 11, 3, BLOCK.STONE);   // darkens v0 -> flip
  assert.deepEqual(first(c), [4, 5]);
  c = base(); put(c, 5, 11, 5, BLOCK.STONE);       // darkens v2 -> flip
  assert.deepEqual(first(c), [4, 5]);
  c = base(); put(c, 3, 11, 5, BLOCK.STONE);       // darkens v1 -> keep
  assert.deepEqual(first(c), [4, 4]);
  // equal AO, brighter v1/v3 (torches in their corner cells) -> flip by light
  c = base(); put(c, 3, 11, 5, BLOCK.TORCH); put(c, 5, 11, 3, BLOCK.TORCH);
  const q = topFaceOf(mesh(c), 4, 10, 4);
  assert.deepEqual([q[0].x, q[0].z], [4, 5]);
  const at = (x, z) => q.find((p) => p.x === x && p.z === z);
  assert.equal(at(4, 4).block, 50);   // (12 + 13 + 13 + 12) / 4 * 4
  assert.equal(at(4, 5).block, 52);   // (12 + 13 + 13 + 14) / 4 * 4
  for (const p of q) assert.equal(p.ao, 3);
  // equal everything: keep
  c = base(); put(c, 3, 11, 3, BLOCK.TORCH); put(c, 5, 11, 5, BLOCK.TORCH);
  assert.deepEqual(first(c), [4, 4]);
});

test('smoothLighting=false: ao 3 and the light of the cell in front on all four vertices', () => {
  const chunks = emptyChunks();
  fill(chunks, -16, 0, -16, 31, 10, 31, BLOCK.STONE);
  put(chunks, 3, 11, 4, BLOCK.STONE);
  put(chunks, 4, 11, 3, BLOCK.STONE);
  put(chunks, 6, 11, 4, BLOCK.TORCH);
  const region = buildRegion(chunks);
  const light = computeLight(region);
  const res = meshChunk(region, light, 1, null, { smoothLighting: false });
  const q = topFaceOf(res, 4, 10, 4);
  for (const p of q) {
    assert.equal(p.ao, 3);
    assert.equal(p.sky, 60);
    assert.equal(p.block, 4 * 12);   // (4,11,4) is 2 steps from the torch
  }
  // torches keep own-cell light either way
  for (const tq of quads(section(res, 0).cutout)) for (const p of tq) assert.equal(p.block, 56);
});

// ---- tints, rotation, positions ---------------------------------------------------------------
test('tints: grass/foliage from the column, birch/spruce constants, white otherwise', () => {
  const grass = new Uint32Array(256), foliage = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    grass[i] = i | (100 << 8) | (7 << 16);
    foliage[i] = 9 | (i << 8) | (200 << 16);
  }
  const scene = [
    [3, 40, 4, BLOCK.GRASS_BLOCK], [5, 40, 6, BLOCK.OAK_LEAVES], [7, 40, 8, BLOCK.BIRCH_LEAVES],
    [9, 40, 10, BLOCK.SPRUCE_LEAVES], [11, 40, 12, BLOCK.STONE], [13, 39, 14, BLOCK.DIRT], [13, 40, 14, BLOCK.SHORT_GRASS],
    [1, 40, 1, BLOCK.SNOWY_GRASS_BLOCK], [15, 40, 15, BLOCK.SUGAR_CANE], [15, 39, 15, BLOCK.DIRT],
  ];
  const colorOf = (res, x, z) => {
    const out = new Set();
    for (const { q } of allQuads(res)) {
      const cx = q.reduce((a, p) => a + p.x, 0) / 4, cz = q.reduce((a, p) => a + p.z, 0) / 4;
      if (Math.floor(cx) === x && Math.floor(cz) === z && q.some((p) => p.y > 8.01)) out.add(q.map((p) => `${p.r},${p.g},${p.b}`).join('|'));
    }
    return [...out];
  };
  const rgb = (c) => [c & 255, (c >>> 8) & 255, (c >>> 16) & 255].join(',');
  const quad4 = (c) => [c, c, c, c].join('|');
  const res = mesh(scene, { tints: { grass, foliage } });
  assert.deepEqual(colorOf(res, 3, 4), [quad4(rgb(grass[4 * 16 + 3]))]);
  assert.deepEqual(colorOf(res, 5, 6), [quad4(rgb(foliage[6 * 16 + 5]))]);
  assert.deepEqual(colorOf(res, 7, 8), [quad4('128,167,85')]);
  assert.deepEqual(colorOf(res, 9, 10), [quad4('97,153,97')]);
  assert.deepEqual(colorOf(res, 11, 12), [quad4('255,255,255')]);
  assert.ok(colorOf(res, 13, 14).includes(quad4(rgb(grass[14 * 16 + 13]))));
  assert.deepEqual(colorOf(res, 1, 1), [quad4('255,255,255')]);
  assert.ok(colorOf(res, 15, 15).includes(quad4(rgb(grass[15 * 16 + 15]))));
  const def = mesh(scene);
  assert.deepEqual(colorOf(def, 3, 4), [quad4(DEFAULT_TINTS.grass.join(','))]);
  assert.deepEqual(colorOf(def, 5, 6), [quad4(DEFAULT_TINTS.foliage.join(','))]);
});

test('FACE_ROTATION turns the texture by 90 degrees so log grain follows the log axis', () => {
  // The bark texture's vertical (v) axis must run along the log axis on every side face.
  const vAxisOf = (q) => {
    const a = atUV(q, 0, 0), b = q.find((p) => p.u === a.u && p.v !== a.v);
    return sub(b, a).map((c) => Math.abs(Math.sign(c)));
  };
  const cases = [[BLOCK.OAK_LOG, [0, 1, 0]], [BLOCK.OAK_LOG_X, [1, 0, 0]], [BLOCK.SPRUCE_LOG_Z, [0, 0, 1]], [BLOCK.BIRCH_LOG_X, [1, 0, 0]]];
  for (const [id, axis] of cases) {
    const qs = quads(section(mesh([[3, 40, 4, id]]), 2).opaque);
    assert.equal(qs.length, 6);
    for (const q of qs) {
      const f = q[0].face;
      checkCubeQuad(q, f);
      const N = FACE_NORMALS[f].map(Math.abs);
      if (N.every((c, i) => c === axis[i])) {
        checkUVFrame(q, f);                     // end grain: unrotated
      } else {
        assert.deepEqual(vAxisOf(q), axis, `block ${id} face ${f}`);
        assert.deepEqual(range(q, 'u'), [0, 16]);
        assert.deepEqual(range(q, 'v'), [0, 16]);
      }
    }
  }
});

test('positions are section-relative; blocks on section borders mesh into their own section', () => {
  const res = mesh([[2, 47, 2, BLOCK.STONE], [2, 48, 2, BLOCK.DIRT]]);
  const s2 = quads(section(res, 2).opaque), s3 = quads(section(res, 3).opaque);
  assert.equal(s2.length, 5);   // top hidden by the dirt above (next section)
  assert.equal(s3.length, 5);   // bottom hidden by the stone below
  for (const q of s2) for (const p of q) assert.ok(p.y === 15 || p.y === 16);
  for (const q of s3) for (const p of q) assert.ok(p.y === 0 || p.y === 1);
});

// ---- performance (soft budget; tools/mesher-bench.mjs has the full benchmark) -------------------
test('light + mesh of a terrain chunk stays well inside the 25 ms budget', async () => {
  const { createTerrain, neighbourhood } = await import('../tools/mesher-terrain.mjs');
  const terrain = createTerrain(4242);
  const chunks = neighbourhood(terrain, 3, -2);
  const tints = terrain.getTints(3, -2);
  const region = new Uint8Array(CHUNK_VOLUME * 9);
  const light = new Uint8Array(region.length);
  const times = [];
  for (let i = 0; i < 12; i++) {
    const t0 = performance.now();
    buildRegion(chunks, region);
    computeLight(region, light);
    const res = meshChunk(region, light, 0xffff, tints);
    times.push(performance.now() - t0);
    assert.equal(res.length, 16);
  }
  times.sort((a, b) => a - b);
  assert.ok(times[6] < 25, `median ${times[6].toFixed(2)} ms`);
});


// ---- robustness ---------------------------------------------------------------------------------
test('fuzz: random block ids over the full height produce only valid vertices', async () => {
  const { BLOCK_COUNT, TEXTURE_LAYER_COUNT } = await import('../src/world/registry.js');
  const rnd = mulberry32(99);
  const chunks = emptyChunks();
  for (const c of chunks) {
    for (let i = 0; i < c.length; i++) c[i] = rnd() < 0.5 ? 0 : Math.floor(rnd() * BLOCK_COUNT);
  }
  chunks[4][blockIndex(3, 255, 3)] = 250;   // unknown id: must be ignored, not crash
  for (const smooth of [true, false]) {
    const res = mesh(chunks, { smooth });
    assert.equal(res.length, 16);
    let quadCount = 0;
    for (const s of res) {
      for (const layer of ['opaque', 'cutout', 'translucent']) {
        const m = s[layer];
        if (!m) continue;
        assert.equal(m.length % QUAD_WORDS, 0);
        for (let q = 0; q < m.length; q += QUAD_WORDS) {
          const P = [];
          for (let k = 0; k < 4; k++) {
            const w0 = m[q + k * 3], w1 = m[q + k * 3 + 1], w2 = m[q + k * 3 + 2];
            const x = w0 & 511, y = (w0 >>> 9) & 511, z = (w0 >>> 18) & 511, face = w0 >>> 29;
            // inside the section, or at most 1 px outside (crop bottoms, wall-torch bases; SPEC §7 allows p in [-1, 30])
            assert.ok(x >= 15 && x <= 273 && y >= 15 && y <= 273 && z >= 15 && z <= 273, 'position inside the section');
            assert.ok(face <= 6);
            assert.ok((w1 & 255) < TEXTURE_LAYER_COUNT);
            assert.ok(((w1 >>> 8) & 31) <= 16 && ((w1 >>> 13) & 31) <= 16, 'texel coords 0..16');
            assert.ok(((w1 >>> 18) & 63) <= 60 && ((w1 >>> 24) & 63) <= 60, 'light x4 <= 60');
            assert.equal(w2 >>> 24, 0);
            P.push({ x, y, z, face });
          }
          const n = cross(sub(P[1], P[0]), sub(P[2], P[0]));
          assert.ok(Math.hypot(...n) > 0, 'non-degenerate');
          if (P[0].face < 6) assert.ok(dot(n, FACE_NORMALS[P[0].face]) > 0, 'normal matches the face index');
          quadCount++;
        }
      }
    }
    assert.ok(quadCount > 50000, `quads ${quadCount}`);
  }
});
