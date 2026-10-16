// Mesher tests for the wave-2 shapes (chest, crop, farmland, wall torch) and the farmland light rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRegion, computeLight } from '../src/world/lighting.js';
import { meshChunk, decodeMesh } from '../src/world/mesher.js';
import { BLOCK, FACE_LAYERS, TEXTURE_INDEX, WALL_FACE } from '../src/world/registry.js';
import { CHUNK_VOLUME, FACE_NORMALS, blockIndex, regionIndex } from '../src/config.js';

// ---- helpers -------------------------------------------------------------------------------
const emptyChunks = () => Array.from({ length: 9 }, () => new Uint8Array(CHUNK_VOLUME));
function put(chunks, x, y, z, id) {
  const n = ((z >> 4) + 1) * 3 + ((x >> 4) + 1);
  chunks[n][blockIndex(x & 15, y, z & 15)] = id;
}
function fill(chunks, x0, y0, z0, x1, y1, z1, id) {
  for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) put(chunks, x, y, z, id);
}
function mesh(scene) {
  let chunks = scene;
  if (!(scene.length === 9 && scene[0] instanceof Uint8Array)) {
    chunks = emptyChunks();
    for (const [x, y, z, id] of scene) put(chunks, x, y, z, id);
  }
  const region = buildRegion(chunks);
  return { res: meshChunk(region, computeLight(region), 0xffff, null), region };
}
const section = (res, sy) => res.find((s) => s.sy === sy);
const quads = (arr) => decodeMesh(arr).map((q) => q.verts);
const sub = (a, b) => [a.x - b.x, a.y - b.y, a.z - b.z];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const normalOf = (q) => cross(sub(q[1], q[0]), sub(q[2], q[0]));
const range = (q, k) => [Math.min(...q.map((p) => p[k])), Math.max(...q.map((p) => p[k]))];
const approx = (a, b) => Math.abs(a - b) < 1e-9;
const centroid = (pts) => pts.reduce((a, p) => [a[0] + p.x / pts.length, a[1] + p.y / pts.length, a[2] + p.z / pts.length], [0, 0, 0]);
/** Every quad's normal points away from the centre of the shape (convex boxes, sheared or not). */
function assertOutward(qs, center) {
  for (const q of qs) {
    const n = normalOf(q);
    const c = centroid(q);
    assert.ok(Math.hypot(...n) > 0, 'non-degenerate');
    assert.ok(dot(n, [c[0] - center[0], c[1] - center[1], c[2] - center[2]]) > 0, `inward face ${JSON.stringify(q.map((p) => [p.x, p.y, p.z]))}`);
    const n2 = cross(sub(q[2], q[0]), sub(q[3], q[0]));
    assert.ok(dot(n, n2) > 0, 'both triangles share the orientation (planar, convex)');
  }
}
const FACE_OF = (q) => [0, 1, 2, 3, 4, 5].find((f) => {
  const n = normalOf(q);
  return dot(n, FACE_NORMALS[f]) / Math.hypot(...n) > 0.999;
});

// ---- chest -----------------------------------------------------------------------------------
test('chest: 14/16 box with the full texture on every face, front by facing, latch on the front', () => {
  const variants = [[BLOCK.CHEST, 4], [BLOCK.CHEST_NORTH, 5], [BLOCK.CHEST_EAST, 0], [BLOCK.CHEST_WEST, 1]];
  for (const [id, front] of variants) {
    const { res } = mesh([[3, 40, 4, BLOCK.STONE], [3, 41, 4, id]]);
    const chestTex = ['chest_top', 'chest_side', 'chest_front'].map((n) => TEXTURE_INDEX.get(n));
    const qs = quads(section(res, 2).opaque).filter((q) => chestTex.includes(q[0].layer));
    assert.equal(qs.length, 5 + 5, `${id}: 5 box faces (bottom on stone culled) + 5 latch faces`);
    const box = qs.filter((q) => q.every((p) => p.x >= 3 + 1 / 16 - 1e-9 && p.x <= 3 + 15 / 16 + 1e-9 &&
      p.z >= 4 + 1 / 16 - 1e-9 && p.z <= 4 + 15 / 16 + 1e-9));
    const latch = qs.filter((q) => !box.includes(q));
    assert.equal(box.length, 5);
    assert.equal(latch.length, 5);
    for (const q of box) {
      const f = FACE_OF(q);
      assert.equal(q[0].face, f, 'face index = geometric direction');
      assert.deepEqual(range(q, 'u'), [0, 16], 'full texture');
      assert.deepEqual(range(q, 'v'), [0, 16]);
      for (const p of q) {
        assert.ok(p.y >= 9 - 1e-9 && p.y <= 9 + 14 / 16 + 1e-9, 'height 14/16');
        assert.equal(p.ao, 3);
      }
      const want = f === 2 || f === 3 ? 'chest_top' : f === front ? 'chest_front' : 'chest_side';
      assert.equal(q[0].layer, TEXTURE_INDEX.get(want), `face ${f} of ${id}`);
    }
    assertOutward(box, [3.5, 9 + 7 / 16, 4.5]);
    // latch: 2 x 4 x 1 px in front of the front face, picture u 7..9 / v 4..8 of the front texture
    const pts = latch.flat();
    const N = FACE_NORMALS[front];
    const out = pts.map((p) => Math.round(dot([p.x - 3.5, 0, p.z - 4.5], N) * 16));
    assert.deepEqual([Math.min(...out), Math.max(...out)], [7, 8], 'latch from the chest front (7 px) to the block edge');
    const lateral = pts.map((p) => Math.round(((p.x - 3.5) * (1 - Math.abs(N[0])) + (p.z - 4.5) * (1 - Math.abs(N[2]))) * 16));
    assert.deepEqual([Math.min(...lateral), Math.max(...lateral)], [-1, 1], '2 px wide, centred');
    const lc = centroid(pts);
    assert.deepEqual(range(latch.flat(), 'y').map((v) => Math.round((v - 9) * 16)), [7, 11]);
    for (const q of latch) assert.equal(q[0].layer, TEXTURE_INDEX.get('chest_front'));
    const latchFront = latch.find((q) => FACE_OF(q) === front);
    assert.deepEqual(range(latchFront, 'u'), [7, 9]);
    assert.deepEqual(range(latchFront, 'v'), [4, 8]);
    assertOutward(latch, lc);
  }
  // an opaque block in front hides the latch; air below shows the bottom face
  const { res } = mesh([[3, 41, 4, BLOCK.CHEST], [3, 41, 5, BLOCK.STONE]]);
  const chestTex = ['chest_top', 'chest_side', 'chest_front'].map((n) => TEXTURE_INDEX.get(n));
  const qs = quads(section(res, 2).opaque).filter((q) => chestTex.includes(q[0].layer));
  assert.equal(qs.length, 6, 'all 6 box faces, no latch');
});

test('chest light is the own cell (no AO), with directional face shading', () => {
  const chunks = emptyChunks();
  fill(chunks, -16, 0, -16, 31, 40, 31, BLOCK.STONE);
  put(chunks, 3, 41, 4, BLOCK.CHEST);
  put(chunks, 4, 41, 4, BLOCK.STONE);              // a wall next to it: no AO darkening on the chest
  const { res, region } = mesh(chunks);
  const light = computeLight(region);
  const own = light[regionIndex(3, 41, 4)];
  for (const q of quads(section(res, 2).opaque).filter((q) => q[0].layer === TEXTURE_INDEX.get('chest_top'))) {
    for (const p of q) {
      assert.equal(p.sky, (own >> 4) * 4);
      assert.equal(p.ao, 3);
    }
  }
});

// ---- crops -----------------------------------------------------------------------------------
test("crop: Minecraft '#' model — 4 planes, double-sided, from -1/16 to 15/16, sway on top", () => {
  for (let age = 0; age < 8; age++) {
    const id = BLOCK[`WHEAT_${age}`];
    const { res } = mesh([[3, 40, 4, BLOCK.FARMLAND], [3, 41, 4, id]]);
    const qs = quads(section(res, 2).cutout);
    assert.equal(qs.length, 8);
    const tex = TEXTURE_INDEX.get(`wheat_stage_${age}`);
    const planes = new Map();
    for (const q of qs) {
      for (const p of q) {
        assert.equal(p.face, 6);
        assert.equal(p.ao, 3);
        assert.equal(p.layer, tex);
        assert.equal(p.anim, approx(p.y, 9 + 15 / 16) ? 1 : 0, 'anim 1 only on the top vertices');
      }
      assert.deepEqual(range(q, 'y'), [9 - 1 / 16, 9 + 15 / 16]);
      assert.deepEqual(range(q, 'u'), [0, 16]);
      assert.deepEqual(range(q, 'v'), [0, 16]);
      const n = normalOf(q);
      const axis = Math.abs(n[0]) > 0 ? 'x' : 'z';
      const pos = q[0][axis];
      assert.ok(q.every((p) => approx(p[axis], pos)), 'vertical plane');
      assert.ok(approx(pos - Math.floor(pos), 4 / 16) || approx(pos - Math.floor(pos), 12 / 16), `plane at ${pos}`);
      const key = `${axis}${pos}`;
      if (!planes.has(key)) planes.set(key, []);
      planes.get(key).push(q);
    }
    assert.equal(planes.size, 4);
    for (const [key, pair] of planes) {
      assert.equal(pair.length, 2, key);
      const [a, b] = pair;
      assert.ok(dot(normalOf(a), normalOf(b)) < 0, 'two opposite sides');
      // a card: the same texel at the same point on both sides (back mirrored)
      for (const p of a) {
        const twin = b.find((r) => approx(r.x, p.x) && approx(r.y, p.y) && approx(r.z, p.z));
        assert.ok(twin, 'same corners');
        assert.equal(twin.u, p.u);
        assert.equal(twin.v, p.v);
      }
    }
  }
});

// ---- farmland --------------------------------------------------------------------------------
test('farmland: top at 15/16 (own texture, dry / moist), dirt sides with texel rows 1..16, culling', () => {
  for (const [id, topTex] of [[BLOCK.FARMLAND, 'farmland'], [BLOCK.FARMLAND_MOIST, 'farmland_moist']]) {
    const { res } = mesh([[3, 40, 4, BLOCK.STONE], [3, 41, 4, id], [4, 41, 4, BLOCK.FARMLAND], [2, 41, 4, BLOCK.DIRT]]);
    // quads of the farmland cell (3, 41, 4): centroid strictly inside its column (neighbours' faces lie
    // on the shared planes x = 3 / x = 4 or outside)
    const own = quads(section(res, 2).opaque).filter((q) => {
      const c = centroid(q);
      return c[0] > 3 && c[0] < 4 && c[2] >= 4 && c[2] <= 5 && c[1] >= 9 && c[1] <= 10;
    });
    const top = own.filter((q) => q[0].face === 2 && q.every((p) => approx(p.y, 9 + 15 / 16)));
    assert.equal(top.length, 1, 'top at 15/16');
    assert.equal(top[0][0].layer, TEXTURE_INDEX.get(topTex));
    assert.deepEqual(range(top[0], 'u'), [0, 16]);
    assert.deepEqual(range(top[0], 'v'), [0, 16]);
    const sides = own.filter((q) => q[0].face !== 2 && q[0].face !== 3 && q.some((p) => approx(p.y, 9 + 15 / 16)));
    // west: dirt (opaque) culls it; east: farmland culls it; north and south are open
    assert.equal(sides.length, 2, 'only the north and south sides');
    for (const q of sides) {
      assert.deepEqual(range(q, 'y'), [9, 9 + 15 / 16]);
      assert.deepEqual(range(q, 'v'), [1, 16], 'planar texel rows 1..16');
      assert.equal(q[0].layer, TEXTURE_INDEX.get('dirt'));
    }
    assert.equal(own.filter((q) => q[0].face === 3).length, 0, 'stone below culls the bottom');
  }
});

test('farmland blocks light like Minecraft (opacity 255) but is lit by its neighbours', () => {
  const chunks = emptyChunks();
  fill(chunks, -16, 0, -16, 31, 40, 31, BLOCK.STONE);
  fill(chunks, 2, 36, 2, 6, 39, 6, BLOCK.AIR);      // a cave right below the field
  fill(chunks, 1, 40, 1, 7, 40, 7, BLOCK.FARMLAND);   // the field is the cave's roof
  const region = buildRegion(chunks);
  const light = computeLight(region);
  const at = (x, y, z) => light[regionIndex(x, y, z)];
  assert.equal(at(4, 39, 4) >> 4, 0, 'no sky light leaks through the farmland into the cave');
  assert.equal(at(4, 40, 4) >> 4, 15, 'the farmland cell itself shows its brightest neighbour (the sky above)');
  assert.equal(at(4, 41, 4) >> 4, 15);
  // torch light in the cave does not shine up through the field either, but the field cell shows it
  put(chunks, 4, 37, 4, BLOCK.TORCH);
  const l2 = computeLight(buildRegion(chunks));
  assert.equal(l2[regionIndex(4, 39, 4)] & 15, 12);
  assert.equal(l2[regionIndex(4, 40, 4)] & 15, 12, 'neighbour brightness from below');
  assert.equal(l2[regionIndex(4, 41, 4)] & 15, 0, 'no torch light above the field');
});

test('flowing / falling water filters light exactly like source water; flowing lava emits 15', () => {
  const light = (id) => {
    const chunks = emptyChunks();
    fill(chunks, -16, 0, -16, 31, 20, 31, BLOCK.STONE);
    fill(chunks, 4, 21, 4, 4, 30, 4, id);              // a 10-high column of the liquid in open air
    return computeLight(buildRegion(chunks));
  };
  const src = light(BLOCK.WATER);
  for (const id of [BLOCK.WATER_FLOWING_1, BLOCK.WATER_FLOWING_7, BLOCK.WATER_FALLING]) {
    const l = light(id);
    for (let y = 21; y <= 31; y++) assert.equal(l[regionIndex(4, y, 4)], src[regionIndex(4, y, 4)], `y=${y}`);
  }
  assert.equal(src[regionIndex(4, 30, 4)] >> 4, 14, 'one level per water cell, direct pass');
  const lava = light(BLOCK.LAVA_FLOWING_6);
  assert.equal(lava[regionIndex(4, 25, 4)] & 15, 15);
  assert.equal(lava[regionIndex(5, 25, 4)] & 15, 14);
});

// ---- wall torches ----------------------------------------------------------------------------
test('wall torch: the post leans 4 px away from the wall, base centred on the wall at 3/16', () => {
  const cases = [
    [BLOCK.WALL_TORCH_EAST, [1, 0], [2, 41, 4]],     // wall (stone) on the -X side
    [BLOCK.WALL_TORCH_WEST, [-1, 0], [4, 41, 4]],
    [BLOCK.WALL_TORCH_SOUTH, [0, 1], [3, 41, 3]],
    [BLOCK.WALL_TORCH_NORTH, [0, -1], [3, 41, 5]],
  ];
  for (const [id, [nx, nz], wall] of cases) {
    assert.ok(WALL_FACE[id] >= 0);
    const { res } = mesh([[...wall, BLOCK.STONE], [3, 41, 4, id]]);
    const qs = quads(section(res, 2).cutout).filter((q) => q[0].layer === FACE_LAYERS[BLOCK.TORCH * 6]);
    assert.equal(qs.length, 6, 'six faces (the bottom is visible from below)');
    const pts = qs.flat();
    for (const p of pts) {
      assert.equal(p.face, 6);
      assert.equal(p.ao, 3);
      assert.equal(p.block, 56, 'own cell: torch light 14');
    }
    // distance from the wall plane along the facing direction
    const wallPlane = nx !== 0 ? (nx > 0 ? 3 : 4) : (nz > 0 ? 4 : 5);
    const dist = (p) => (nx !== 0 ? (p.x - wallPlane) * nx : (p.z - wallPlane) * nz) * 16;
    const bottom = pts.filter((p) => approx(p.y, 9 + 3 / 16));
    const top = pts.filter((p) => approx(p.y, 9 + 13 / 16));
    assert.equal(bottom.length + top.length, pts.length, 'every vertex at 3/16 or 13/16');
    assert.deepEqual([Math.min(...bottom.map(dist)), Math.max(...bottom.map(dist))].map(Math.round), [-1, 1], 'base straddles the wall');
    assert.deepEqual([Math.min(...top.map(dist)), Math.max(...top.map(dist))].map(Math.round), [3, 5], 'top 4 px out');
    assertOutward(qs, centroid(pts));
    for (const q of qs) {
      const n = normalOf(q);
      const ny = n[1] / Math.hypot(...n);
      assert.deepEqual(range(q, 'u'), [7, 9]);
      if (ny > 0.99) assert.deepEqual(range(q, 'v'), [6, 8]);
      else if (ny < -0.99) assert.deepEqual(range(q, 'v'), [13, 15]);
      else assert.deepEqual(range(q, 'v'), [6, 16]);
    }
  }
});
