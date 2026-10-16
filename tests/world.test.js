// World manager tests: chunk helpers, block updates, worker protocol, WorkerPool (fake workers) and the
// World itself driven by a fake pool that runs the real worker code (worldgen + lighting + mesher)
// synchronously under Node.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BLOCK, ITEM, IS_SOLID, itemForBlock } from '../src/world/registry.js';
import {
  chunkKeyNum, keyCX, keyCZ, computeHeightmap, sectionMaskUpTo, editDirtyRange, classifyChunk,
  chunkCenterDistance, circularOrder, Chunk, SET_MESH, SET_GEN, SET_KEEP,
} from '../src/world/chunk.js';
import { BlockUpdater } from '../src/world/blockupdates.js';
import { handleMessage, hashSection } from '../src/world/worker.js';
import { WorkerPool } from '../src/world/workerpool.js';
import { World } from '../src/world/world.js';
import { Storage } from '../src/world/storage.js';
import { WorldGenerator } from '../src/world/worldgen.js';
import { buildRegion, computeLight, extractChunkLight } from '../src/world/lighting.js';
import { meshChunk } from '../src/world/mesher.js';
import { mulberry32 } from '../src/util/noise.js';

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

const settle = async (n = 4) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

/** Pool stand-in: queues jobs, runs them on demand through the real worker message handler. */
class FakePool {
  constructor() {
    this.size = 4;
    this.queue = [];
    this.seq = 0;
    this.nextId = 1;
    this.log = [];
    this.inits = [];
    this.fail = null;          // (job) => string|null: error message to return instead of running
  }

  init(seed, worldType) {
    this.inits.push([seed, worldType]);
    handleMessage({ type: 'init', seed, worldType });
  }

  submit(job, priority = 0) {
    return new Promise((resolve, reject) => {
      job.jobId = this.nextId++;
      this.queue.push({ job, priority, seq: this.seq++, resolve, reject });
    });
  }

  cancel(pred) {
    let n = 0;
    this.queue = this.queue.filter((e) => {
      if (!pred(e.job, e.priority)) return true;
      const err = new Error('cancelled');
      err.cancelled = true;
      e.reject(err);
      n++;
      return false;
    });
    return n;
  }

  reprioritize(fn) {
    for (const e of this.queue) {
      const p = fn(e.job, e.priority);
      if (typeof p === 'number' && Number.isFinite(p)) e.priority = p;
    }
  }

  get pending() {
    return this.queue.length;
  }

  sorted() {
    return this.queue.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
  }

  /** Remove (without running) the first queued job matching pred. */
  take(pred) {
    this.sorted();
    const i = this.queue.findIndex((e) => pred(e.job, e));
    return i < 0 ? null : this.queue.splice(i, 1)[0];
  }

  run(entry) {
    const j = entry.job;
    this.log.push({ type: j.type, cx: j.cx, cz: j.cz, tier: j.tier, priority: entry.priority, mask: j.sectionMask });
    const failure = this.fail ? this.fail(j) : null;
    if (failure) {
      entry.reject(new Error(failure));
      return;
    }
    const out = handleMessage(j);
    if (out.message.type === 'error') entry.reject(new Error(out.message.message));
    else entry.resolve(out.message);
  }

  runAll(limit = Infinity) {
    let n = 0;
    while (this.queue.length > 0 && n < limit) {
      this.sorted();
      this.run(this.queue.shift());
      n++;
    }
    return n;
  }
}

class FakeRenderer {
  constructor() {
    this.sections = new Map();
    this.calls = 0;
    this.removed = [];
  }

  setSectionMesh(cx, sy, cz, opaque, cutout, translucent) {
    this.calls++;
    const key = `${cx},${sy},${cz}`;
    if (!opaque && !cutout && !translucent) this.sections.delete(key);
    else this.sections.set(key, { opaque, cutout, translucent });
  }

  removeChunk(cx, cz) {
    this.removed.push([cx, cz]);
    for (let sy = 0; sy < 16; sy++) this.sections.delete(`${cx},${sy},${cz}`);
  }
}

function makeEnv({ rd = 2, storage = null, worldType = 'flat', seed = 7, worldId = 'test', ...extra } = {}) {
  const pool = new FakePool();
  const renderer = new FakeRenderer();
  const drops = [];
  const world = new World({
    seed, worldType, worldId, storage, pool, renderer, renderDistance: rd, smoothLighting: true,
    onDropItem: (itemId, count, x, y, z) => drops.push({ itemId, count, x, y, z }), ...extra,
  });
  return { world, pool, renderer, drops };
}

/** Frame loop until the world reports idle. */
async function runUntilIdle(env, px = 8, pz = 8, maxFrames = 400) {
  for (let f = 0; f < maxFrames; f++) {
    env.world.update(px, 70, pz, 1 / 60);
    env.pool.runAll();
    await settle();
    env.world.update(px, 70, pz, 1 / 60);
    if (env.world.stats().idle && env.pool.pending === 0) return f;
  }
  throw new Error('world did not become idle: ' + JSON.stringify(env.world.stats()));
}

/** Mesh of one section computed directly from the world's current blocks (reference result). */
function expectedSection(world, cx, cz, sy) {
  const chunks = [];
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) chunks.push(world.getChunk(cx + dx, cz + dz)?.blocks ?? null);
  }
  const region = buildRegion(chunks);
  const light = computeLight(region);
  const gen = new WorldGenerator(world.seed, world.worldType);
  const [s] = meshChunk(region, light, 1 << sy, gen.getTints(cx, cz), { smoothLighting: world.smoothLighting });
  return s;
}

function assertSectionMatches(env, cx, cz, sy) {
  const exp = expectedSection(env.world, cx, cz, sy);
  const got = env.renderer.sections.get(`${cx},${sy},${cz}`) ?? { opaque: null, cutout: null, translucent: null };
  for (const k of ['opaque', 'cutout', 'translucent']) {
    assert.deepEqual(got[k] ?? null, exp[k] ?? null, `section ${cx},${sy},${cz} layer ${k}`);
  }
}

const scripted = (values, fallback = 0.5) => {
  let i = 0;
  return () => (i < values.length ? values[i++] : fallback);
};

// ---------------------------------------------------------------------------------------------
// chunk.js helpers
// ---------------------------------------------------------------------------------------------

test('chunk keys round-trip for negative and large coordinates', () => {
  const seen = new Set();
  for (const [cx, cz] of [[0, 0], [-1, 0], [0, -1], [-1, -1], [123, -456], [-1875000, 1875000], [33554431, -33554431]]) {
    const k = chunkKeyNum(cx, cz);
    assert.ok(Number.isSafeInteger(k));
    assert.equal(keyCX(k), cx);
    assert.equal(keyCZ(k), cz);
    assert.ok(!seen.has(k));
    seen.add(k);
  }
});

test('computeHeightmap matches a brute-force scan', () => {
  const rnd = mulberry32(99);
  const blocks = new Uint8Array(65536);
  const expect = new Int16Array(256).fill(-1);
  for (let c = 0; c < 256; c++) {
    if (c % 17 === 3) continue;                     // some empty columns
    const top = Math.floor(rnd() * 256);
    for (let y = 0; y <= top; y++) if (y === top || rnd() < 0.5) blocks[(y << 8) | c] = 1 + (y % 5);
    expect[c] = top;
  }
  const hm = new Int16Array(256);
  const maxY = computeHeightmap(blocks, hm);
  assert.deepEqual(hm, expect);
  assert.equal(maxY, Math.max(...expect));
  assert.equal(computeHeightmap(new Uint8Array(65536), hm), -1);
  assert.ok(hm.every((v) => v === -1));
});

test('Chunk.updateHeight keeps heightmap and maxY exact', () => {
  const c = new Chunk(0, 0);
  const b = new Uint8Array(65536);
  for (let i = 0; i < 256 * 4; i++) b[i] = 1;     // y 0..3
  c.setBlocks(b);
  assert.equal(c.maxY, 3);
  b[(10 << 8) | 5] = 1; c.updateHeight(5, 10, 0, 1);
  assert.equal(c.heightmap[5], 10);
  assert.equal(c.maxY, 10);
  b[(10 << 8) | 5] = 0; c.updateHeight(5, 10, 0, 0);
  assert.equal(c.heightmap[5], 3);
  assert.equal(c.maxY, 3);
  for (let y = 0; y <= 3; y++) { b[(y << 8) | 7] = 0; c.updateHeight(7, y, 0, 0); }
  assert.equal(c.heightmap[7], -1);
});

test('section masks and edit dirty ranges follow SPEC §9.6', () => {
  assert.equal(sectionMaskUpTo(-1), 0);
  assert.equal(sectionMaskUpTo(0), 1);
  assert.equal(sectionMaskUpTo(1), 3);
  assert.equal(sectionMaskUpTo(15), 0xffff);
  assert.equal(sectionMaskUpTo(20), 0xffff);
  // edit in the middle of chunk (0,0) at y = 70: chunks -1..1 both ways, sections 0..5 ((70+15)>>4 = 5)
  let r = editDirtyRange(8, 70, 8);
  assert.deepEqual([r.cx0, r.cx1, r.cz0, r.cz1], [-1, 1, -1, 1]);
  assert.equal(r.mask, 0b111111);
  assert.deepEqual([r.gx0, r.gx1, r.gz0, r.gz1], [0, 0, 0, 0]);
  // chunk corner: geometry neighbours on both axes
  r = editDirtyRange(16, 250, -1);
  assert.deepEqual([r.gx0, r.gx1, r.gz0, r.gz1], [0, 1, -1, 0]);
  assert.deepEqual([r.cx0, r.cx1, r.cz0, r.cz1], [0, 1, -1, 0]);
  assert.equal(r.mask, 0xffff);
  r = editDirtyRange(0, 0, 0);
  assert.equal(r.mask, 1);
  assert.deepEqual([r.cx0, r.cx1], [-1, 0]);
});

test('streaming sets: mesh ⊂ gen ⊂ keep, neighbours of mesh chunks are generated, radius ~rd', () => {
  for (const rd of [2, 5, 8, 16]) {
    for (const [px, pz] of [[8, 8], [0.1, 15.9], [-123.4, 77.7]]) {
      const pcx = Math.floor(px / 16), pcz = Math.floor(pz / 16);
      let mesh = 0;
      for (let dz = -rd - 4; dz <= rd + 4; dz++) {
        for (let dx = -rd - 4; dx <= rd + 4; dx++) {
          const cx = pcx + dx, cz = pcz + dz;
          const f = classifyChunk(px, pz, cx, cz, rd);
          if (f & SET_MESH) assert.ok(f & SET_GEN && f & SET_KEEP);
          if (f & SET_GEN) assert.ok(f & SET_KEEP);
          if (!(f & SET_MESH)) continue;
          mesh++;
          for (let j = -1; j <= 1; j++) {
            for (let i = -1; i <= 1; i++) assert.ok(classifyChunk(px, pz, cx + i, cz + j, rd) & SET_GEN);
          }
          // a mesh chunk intersects the render circle
          assert.ok(chunkCenterDistance(px, pz, cx, cz) < rd + 0.75);
        }
      }
      assert.ok(mesh >= Math.PI * rd * rd, `rd ${rd}: ${mesh} mesh chunks`);
      assert.ok(mesh <= Math.PI * (rd + 1) * (rd + 1), `rd ${rd}: ${mesh} mesh chunks`);
      // anything visible (within the renderer's fog end 0.95*16*rd + 1) is in the mesh set
      for (let dz = -rd - 2; dz <= rd + 2; dz++) {
        for (let dx = -rd - 2; dx <= rd + 2; dx++) {
          const cx = pcx + dx, cz = pcz + dz;
          const nx = Math.max(cx * 16 - px, 0, px - (cx * 16 + 16));
          const nz = Math.max(cz * 16 - pz, 0, pz - (cz * 16 + 16));
          if (Math.hypot(nx, nz) <= 0.95 * 16 * rd + 1) assert.ok(classifyChunk(px, pz, cx, cz, rd) & SET_MESH);
        }
      }
    }
  }
  // far chunks are dropped entirely
  assert.equal(classifyChunk(8, 8, 50, 0, 8), 0);
});

test('circularOrder lists offsets nearest first', () => {
  const o = circularOrder(5);
  let prev = -1;
  let n = 0;
  for (let i = 0; i < o.length; i += 2) {
    const d = o[i] * o[i] + o[i + 1] * o[i + 1];
    assert.ok(d >= prev);
    assert.ok(d <= 25);
    prev = d;
    n++;
  }
  assert.equal(o[0], 0);
  assert.equal(o[1], 0);
  assert.equal(n, 81);
});

// ---------------------------------------------------------------------------------------------
// blockupdates.js (plain voxel map)
// ---------------------------------------------------------------------------------------------

function mapWorld() {
  const m = new Map();
  const w = {
    sets: 0,
    getBlock: (x, y, z) => (y < 0 || y > 255 ? 0 : m.get(`${x},${y},${z}`) ?? 0),
    setBlock: (x, y, z, id) => {
      w.sets++;
      if (id === 0) m.delete(`${x},${y},${z}`);
      else m.set(`${x},${y},${z}`, id);
      return true;
    },
  };
  return w;
}

test('BlockUpdater: support popping cascades upward and drops loot', () => {
  const w = mapWorld();
  const drops = [];
  const u = new BlockUpdater(w, { onDropItem: (id, n, x, y, z) => drops.push([id, n, x, y, z]), rng: () => 0 });
  w.setBlock(0, 0, 0, BLOCK.STONE);
  w.setBlock(0, 1, 0, BLOCK.DIRT);
  for (let y = 2; y < 6; y++) w.setBlock(0, y, 0, BLOCK.SUGAR_CANE);
  w.setBlock(0, 1, 0, 0);
  u.blockChanged(0, 1, 0);
  for (let y = 2; y < 6; y++) assert.equal(w.getBlock(0, y, 0), 0);
  assert.equal(drops.length, 4);
  assert.deepEqual(drops[0], [BLOCK.SUGAR_CANE, 1, 0.5, 2.5, 0.5]);
  assert.equal(u.pending, 0);
  // short grass drops wheat seeds (12.5 %, rng = 0 here); a torch drops itself
  w.setBlock(3, 0, 0, BLOCK.TORCH);
  w.setBlock(4, 0, 0, BLOCK.SHORT_GRASS);
  drops.length = 0;
  u.blockChanged(3, -1, 0);
  u.blockChanged(4, -1, 0);
  assert.equal(w.getBlock(3, 0, 0), 0);
  assert.equal(w.getBlock(4, 0, 0), 0);
  assert.deepEqual(drops.map((d) => d[0]), [BLOCK.TORCH, ITEM.WHEAT_SEEDS]);
});

test('BlockUpdater: gravity — falling, landing, replacing, breaking, void, cascades', () => {
  const w = mapWorld();
  const drops = [];
  const u = new BlockUpdater(w, { onDropItem: (id, n) => drops.push(id), rng: () => 0.99 });
  for (let x = 0; x < 8; x++) w.setBlock(x, 1, 0, BLOCK.STONE);
  // a column of sand and gravel falls down onto the stone, one after another
  w.setBlock(0, 10, 0, BLOCK.SAND);
  w.setBlock(0, 11, 0, BLOCK.GRAVEL);
  w.setBlock(0, 12, 0, BLOCK.SAND);
  w.setBlock(0, 13, 0, BLOCK.CACTUS);               // cactus on sand: pops when its support moves away
  u.blockChanged(0, 10, 0);
  assert.equal(w.getBlock(0, 2, 0), BLOCK.SAND);
  assert.equal(w.getBlock(0, 3, 0), BLOCK.GRAVEL);
  assert.equal(w.getBlock(0, 4, 0), BLOCK.SAND);
  for (let y = 5; y < 14; y++) assert.equal(w.getBlock(0, y, 0), 0, `y=${y}`);
  assert.deepEqual(drops, [BLOCK.CACTUS]);
  // through water, replacing it at the bottom
  w.setBlock(1, 2, 0, BLOCK.WATER);
  w.setBlock(1, 3, 0, BLOCK.WATER);
  w.setBlock(1, 6, 0, BLOCK.SAND);
  u.blockChanged(1, 6, 0);
  assert.equal(w.getBlock(1, 2, 0), BLOCK.SAND);
  assert.equal(w.getBlock(1, 3, 0), BLOCK.WATER);
  // onto short grass: replaces it
  w.setBlock(2, 2, 0, BLOCK.SHORT_GRASS);
  w.setBlock(2, 9, 0, BLOCK.GRAVEL);
  u.blockChanged(2, 9, 0);
  assert.equal(w.getBlock(2, 2, 0), BLOCK.GRAVEL);
  // onto a torch: breaks into an item, torch stays
  drops.length = 0;
  w.setBlock(3, 2, 0, BLOCK.TORCH);
  w.setBlock(3, 7, 0, BLOCK.SAND);
  u.blockChanged(3, 7, 0);
  assert.equal(w.getBlock(3, 2, 0), BLOCK.TORCH);
  assert.equal(w.getBlock(3, 7, 0), 0);
  assert.deepEqual(drops, [itemForBlock(BLOCK.SAND)]);
  // a sand block resting on a flower does not fall (flowers are not replaceable; the poppy needs dirt)
  w.setBlock(4, 1, 0, BLOCK.DIRT);
  w.setBlock(4, 2, 0, BLOCK.POPPY);
  w.setBlock(4, 3, 0, BLOCK.SAND);
  u.blockChanged(4, 3, 0);
  assert.equal(w.getBlock(4, 3, 0), BLOCK.SAND);
  // nothing below: falls out of the world
  w.setBlock(20, 5, 20, BLOCK.SAND);
  u.blockChanged(20, 5, 20);
  assert.equal(w.getBlock(20, 5, 20), 0);
  assert.ok(![...Array(6).keys()].some((y) => w.getBlock(20, y, 20) !== 0));
});

test('BlockUpdater: onFall hook takes over falling blocks (falling entities)', () => {
  const w = mapWorld();
  const falls = [];
  let accept = true;
  const u = new BlockUpdater(w, { onFall: (id, x, y, z) => { falls.push([id, x, y, z, w.getBlock(x, y, z)]); return accept; } });
  w.setBlock(0, 0, 0, BLOCK.STONE);
  w.setBlock(0, 5, 0, BLOCK.SAND);
  w.setBlock(0, 6, 0, BLOCK.GRAVEL);
  u.blockChanged(0, 5, 0);
  assert.deepEqual(falls, [[BLOCK.SAND, 0, 5, 0, 0], [BLOCK.GRAVEL, 0, 6, 0, 0]], 'cell already air when called');
  for (let y = 1; y < 8; y++) assert.equal(w.getBlock(0, y, 0), 0, 'entity system places them later');
  accept = false;                                         // hook declines: instant fall
  w.setBlock(0, 9, 0, BLOCK.SAND);
  u.blockChanged(0, 9, 0);
  assert.equal(w.getBlock(0, 1, 0), BLOCK.SAND);
  assert.equal(falls.length, 3);
});

test('BlockUpdater: budget leaves work for later, re-entrant calls are queued', () => {
  const w = mapWorld();
  const u = new BlockUpdater(w, { budget: 3 });
  w.setBlock(0, 0, 0, BLOCK.STONE);
  for (let y = 10; y < 30; y++) w.setBlock(0, y, 0, BLOCK.SAND);
  u.blockChanged(0, 10, 0);
  assert.ok(u.pending > 0);
  let guard = 0;
  while (u.pending > 0 && guard++ < 1000) u.process();
  for (let y = 1; y <= 20; y++) assert.equal(w.getBlock(0, y, 0), BLOCK.SAND);
  assert.equal(w.getBlock(0, 21, 0), 0);
  assert.ok(IS_SOLID[BLOCK.SAND]);
});

// ---------------------------------------------------------------------------------------------
// worker.js
// ---------------------------------------------------------------------------------------------

test('worker: generate matches WorldGenerator, mesh with trimmed inputs equals full inputs', () => {
  handleMessage({ type: 'init', seed: 4242, worldType: 'default' });
  const gen = new WorldGenerator(4242);
  const g = handleMessage({ type: 'generate', jobId: 1, cx: 3, cz: -2 });
  assert.equal(g.message.type, 'generated');
  assert.equal(g.message.jobId, 1);
  assert.deepEqual(g.message.blocks, gen.generateChunk(3, -2));
  assert.deepEqual(g.transfer, [g.message.blocks.buffer]);

  const full = [];
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) full.push(gen.generateChunk(3 + dx, -2 + dz));
  const hm = new Int16Array(256);
  const trimmed = full.map((b) => {
    const len = (computeHeightmap(b, hm) + 1) << 8;
    const buf = new ArrayBuffer(65536);
    const v = new Uint8Array(buf, 0, len);
    v.set(b.subarray(0, len));
    new Uint8Array(buf).fill(0xee, len);             // garbage beyond the view must be ignored
    return v;
  });
  const a = handleMessage({ type: 'mesh', jobId: 2, cx: 3, cz: -2, chunks: full.map((b) => b.slice()), sectionMask: 0xffff, smoothLighting: true });
  const b = handleMessage({ type: 'mesh', jobId: 3, cx: 3, cz: -2, chunks: trimmed, sectionMask: 0xffff, smoothLighting: true, returnBuffers: true });
  assert.equal(a.message.type, 'meshed');
  assert.equal(b.message.type, 'meshed');
  assert.equal(a.message.sections.length, 16);
  assert.deepEqual(b.message.sections, a.message.sections);
  assert.deepEqual(b.message.light, a.message.light);
  assert.equal(b.message.buffers.length, 9);
  assert.ok(a.message.sections.some((s) => s.hash !== 0));
  // trimmed light: exact prefix of the full light, everything above is open sky (0xF0)
  const t = handleMessage({ type: 'mesh', jobId: 5, cx: 3, cz: -2, chunks: full.map((x) => x.slice()), sectionMask: 1, smoothLighting: true, trimLight: true });
  const tl = t.message.light;
  assert.ok(tl.length < 65536 && tl.length % 256 === 0, `trimmed to ${tl.length}`);
  assert.deepEqual(tl, a.message.light.subarray(0, tl.length));
  assert.ok(a.message.light.subarray(tl.length).every((v) => v === 0xf0));
  // only requested sections are returned
  const c = handleMessage({ type: 'mesh', jobId: 4, cx: 3, cz: -2, chunks: full.map((x) => x.slice()), sectionMask: 0b1010, smoothLighting: false });
  assert.deepEqual(c.message.sections.map((s) => s.sy), [1, 3]);
  // errors become replies
  const e = handleMessage({ type: 'nope', jobId: 9 });
  assert.equal(e.message.type, 'error');
  assert.equal(e.message.jobId, 9);
  const e2 = handleMessage({ type: 'mesh', jobId: 10, cx: 0, cz: 0, chunks: [new Uint8Array(100)] });
  assert.equal(e2.message.type, 'error');
});

test('worker: hashSection is 0 for empty sections and sensitive to content', () => {
  assert.equal(hashSection(null, null, null), 0);
  const a = Uint32Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12);
  const h = hashSection(a, null, null);
  assert.ok(h > 0 && Number.isSafeInteger(h));
  assert.equal(hashSection(a.slice(), null, null), h);
  assert.notEqual(hashSection(null, a, null), h, 'layer matters');
  const b = a.slice();
  b[5] ^= 1;
  assert.notEqual(hashSection(b, null, null), h);
});

// ---------------------------------------------------------------------------------------------
// workerpool.js (fake workers)
// ---------------------------------------------------------------------------------------------

class FakeWorker {
  constructor(index, created) {
    this.index = index;
    this.posted = [];
    this.terminated = false;
    this.onmessage = null;
    this.onerror = null;
    created.push(this);
  }

  postMessage(msg, transfer) {
    if (this.throwOnPost) throw new Error('DataCloneError');
    this.posted.push({ msg, transfer });
  }

  terminate() {
    this.terminated = true;
  }

  reply(msg) {
    this.onmessage({ data: msg });
  }

  lastJob() {
    for (let i = this.posted.length - 1; i >= 0; i--) if (this.posted[i].msg.jobId) return this.posted[i].msg;
    return null;
  }
}

function makePool(n = 1, maxInFlight = 1) {
  const created = [];
  const pool = new WorkerPool(n, { maxInFlight, createWorker: (i) => new FakeWorker(i, created) });
  return { pool, created };
}

test('WorkerPool: priority order, FIFO ties, at most maxInFlight per worker', async () => {
  const { pool, created } = makePool(1, 1);
  pool.init(123, 'flat');
  assert.deepEqual(created[0].posted[0].msg, { type: 'init', seed: 123, worldType: 'flat' });
  const done = [];
  const sub = (name, p) => pool.submit({ type: 'generate', name }, p).then((r) => done.push([name, r.type]));
  sub('A', 5);
  sub('B', 9); sub('C', 1); sub('D', 5); sub('E', 3); sub('F', 1);
  const w = created[0];
  assert.equal(w.posted.length, 2, 'init + one job in flight');
  assert.equal(pool.pending, 6);
  assert.equal(pool.inFlight, 1);
  const order = [];
  for (let i = 0; i < 6; i++) {
    const job = w.lastJob();
    order.push(job.name);
    w.reply({ type: 'generated', jobId: job.jobId });
  }
  await settle();
  assert.deepEqual(order, ['A', 'C', 'F', 'E', 'D', 'B']);
  assert.equal(done.length, 6);
  assert.equal(pool.pending, 0);
});

test('WorkerPool: distributes over workers, cancel and reprioritize queued jobs', async () => {
  const { pool, created } = makePool(2, 2);
  const results = [];
  const rejected = [];
  for (let i = 0; i < 10; i++) {
    pool.submit({ type: 'generate', i }, i).then((r) => results.push(r.i), (e) => rejected.push([i, e.cancelled === true]));
  }
  assert.equal(created[0].posted.length + created[1].posted.length, 4, '2 workers x 2 in flight');
  assert.equal(pool.queued, 6);
  const n = pool.cancel((job) => job.i % 2 === 1);
  assert.ok(n >= 2);
  await settle();
  assert.ok(rejected.every(([i, c]) => i % 2 === 1 && c));
  pool.reprioritize((job) => (job.i === 8 ? -1 : undefined));
  // finish one job on worker 0: the next dispatched must be job 8
  const j = created[0].lastJob();
  created[0].reply({ type: 'generated', jobId: j.jobId, i: j.i });
  assert.equal(created[0].lastJob().i, 8);
  await settle();
  assert.deepEqual(results, [j.i]);
});

test('WorkerPool: error replies reject, crashes restart the worker and fail its jobs', async () => {
  const { pool, created } = makePool(1, 2);
  const errOut = console.error;
  const logged = [];
  console.error = (...a) => logged.push(a.join(' '));
  try {
    pool.init(5, 'default');
    const p1 = pool.submit({ type: 'mesh', k: 1 }, 0);
    const p2 = pool.submit({ type: 'mesh', k: 2 }, 0);
    const p3 = pool.submit({ type: 'mesh', k: 3 }, 0);
    const w = created[0];
    w.reply({ type: 'error', jobId: w.posted[1].msg.jobId, message: 'boom' });
    await assert.rejects(p1, /boom/);
    // crash: the in-flight jobs (2 and 3) fail, a new worker is spawned and gets the init message again
    w.onerror({ message: 'kaputt', preventDefault() {} });
    await assert.rejects(p2, /crashed/);
    await assert.rejects(p3, /crashed/);
    assert.equal(created.length, 2);
    assert.ok(w.terminated);
    assert.deepEqual(created[1].posted[0].msg, { type: 'init', seed: 5, worldType: 'default' });
    const p4 = pool.submit({ type: 'generate' }, 0);
    const job = created[1].lastJob();
    created[1].reply({ type: 'generated', jobId: job.jobId, ok: 1 });
    assert.equal((await p4).ok, 1);
    // post failures reject just that job
    created[1].throwOnPost = true;
    await assert.rejects(pool.submit({ type: 'generate' }, 0), /DataCloneError/);
    created[1].throwOnPost = false;
    assert.ok(logged.some((l) => l.includes('kaputt')));
  } finally {
    console.error = errOut;
  }
});

test('WorkerPool: terminate rejects everything and later submits', async () => {
  const { pool, created } = makePool(1, 1);
  const a = pool.submit({ type: 'generate' }, 0);
  const b = pool.submit({ type: 'generate' }, 1);
  pool.terminate();
  await assert.rejects(a, /terminated/);
  await assert.rejects(b, /terminated/);
  await assert.rejects(pool.submit({ type: 'generate' }, 0), /terminated/);
  assert.ok(created[0].terminated);
  assert.equal(pool.pending, 0);
});

// ---------------------------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------------------------

test('World: streams the area nearest-first, meshes it and answers block queries', async () => {
  const env = makeEnv({ rd: 2 });
  const { world, pool, renderer } = env;
  assert.equal(world.isAreaReady(8, 8, 1), false);
  await world.init();
  assert.deepEqual(pool.inits, [[7, 'flat']]);
  await runUntilIdle(env);
  let meshN = 0, genN = 0;
  for (let cz = -6; cz <= 6; cz++) {
    for (let cx = -6; cx <= 6; cx++) {
      const f = classifyChunk(8, 8, cx, cz, 2);
      if (f & SET_MESH) {
        meshN++;
        assert.ok(world.isChunkMeshed(cx, cz), `${cx},${cz} meshed`);
      }
      if (f & SET_GEN) {
        genN++;
        assert.ok(world.isChunkGenerated(cx, cz));
      }
    }
  }
  const st = world.stats();
  assert.equal(st.loaded, genN);
  assert.equal(st.meshed, meshN);
  assert.equal(st.pendingGenerate, 0);
  assert.equal(st.pendingMesh, 0);
  assert.equal(st.modified, 0);
  // generation ran nearest-first
  const gens = pool.log.filter((e) => e.type === 'generate').map((e) => chunkCenterDistance(8, 8, e.cx, e.cz));
  for (let i = 1; i < gens.length; i++) assert.ok(gens[i] >= gens[i - 1] - 1e-9);
  // flat world: only section 0 has geometry; renderer holds exactly one section per meshed chunk
  assert.equal(renderer.sections.size, meshN);
  assertSectionMatches(env, 0, 0, 0);
  assertSectionMatches(env, -1, 1, 0);
  assert.ok(world.isAreaReady(8, 8, 1));
  assert.ok(world.isAreaReady(8, 8, 6), 'chunks outside the render distance do not block readiness');
  assert.equal(world.isAreaReady(5000, 8, 0), false);
  // block queries
  assert.equal(world.getBlock(5, 3, 5), BLOCK.GRASS_BLOCK);
  assert.equal(world.getBlock(-5, 0, -9), BLOCK.BEDROCK);
  assert.equal(world.getBlock(5, 4, 5), BLOCK.AIR);
  assert.equal(world.getBlock(5, -1, 5), BLOCK.AIR);
  assert.equal(world.getBlock(5, 256, 5), BLOCK.AIR);
  assert.equal(world.getBlock(100000, 3, 5), BLOCK.AIR);
  assert.equal(world.getTopY(5, 5), 3);
  assert.equal(world.getTopY(-17, 20), 3);
  assert.equal(world.getTopY(100000, 5), -1);
  assert.equal(world.getLight(5, 4, 5), 0xf0);
  assert.equal(world.getLight(5, 2, 5), 0);
  assert.equal(world.getLight(5, 300, 5), 0xf0);
  assert.equal(world.getLight(100000, 4, 0), 0xf0);
  assert.equal(world.seed, 7);
});

test('World: setBlock validation, heightmap, events and modified flags', async () => {
  const env = makeEnv();
  const { world } = env;
  await runUntilIdle(env);
  assert.equal(world.setBlock(5, -1, 5, BLOCK.STONE), false);
  assert.equal(world.setBlock(5, 256, 5, BLOCK.STONE), false);
  assert.equal(world.setBlock(5, 10, 5, 250), false);
  assert.equal(world.setBlock(5, 10, 5, 1.5), false);
  assert.equal(world.setBlock(9000, 10, 5, BLOCK.STONE), false);
  const events = [];
  const off = world.onBlockChanged((...a) => events.push(a));
  assert.equal(world.setBlock(5, 10, 5, BLOCK.STONE), true);
  assert.deepEqual(events, [[5, 10, 5, BLOCK.AIR, BLOCK.STONE]]);
  assert.equal(world.getBlock(5, 10, 5), BLOCK.STONE);
  assert.equal(world.getTopY(5, 5), 10);
  assert.equal(world.setBlock(5, 10, 5, BLOCK.STONE), true, 'same id: success, no event');
  assert.equal(events.length, 1);
  assert.ok(world.getChunk(0, 0).modified);
  assert.equal(world.getChunk(1, 0).modified, false);
  world.setBlock(5, 10, 5, BLOCK.AIR);
  assert.equal(world.getTopY(5, 5), 3);
  off();
  world.setBlock(6, 10, 6, BLOCK.STONE);
  assert.equal(events.length, 2);
  assert.equal(world.stats().modified, 1);
});

test('World: edits remesh the edited chunk + geometry neighbours first, light neighbours next', async () => {
  const env = makeEnv();
  const { world, pool } = env;
  await runUntilIdle(env);
  pool.log.length = 0;
  world.setBlock(15, 4, 8, BLOCK.STONE);               // x = 15: chunk (1,0) shows the stone's neighbour faces
  world.update(8, 70, 8);
  const q = pool.sorted().map((e) => ({ cx: e.job.cx, cz: e.job.cz, tier: e.job.tier, mask: e.job.sectionMask }));
  assert.ok(q.length >= 2);
  assert.deepEqual(q.slice(0, 2).map((e) => [e.cx, e.cz, e.tier]).sort(), [[0, 0, 0], [1, 0, 0]]);
  for (const e of q) assert.equal(e.mask, 0b11, 'sections 0..(4+15)>>4');
  const touched = new Set(q.map((e) => `${e.cx},${e.cz}`));
  // light range [0, 30] x [-7, 23] -> chunks x 0..1, z -1..1
  for (const k of ['0,-1', '1,-1', '0,0', '1,0', '0,1', '1,1']) assert.ok(touched.has(k), k);
  assert.equal(touched.size, 6);
  for (const e of q.slice(2)) assert.equal(e.tier, 1);
  await runUntilIdle(env);
  assertSectionMatches(env, 0, 0, 0);
  assertSectionMatches(env, 1, 0, 0);
  assertSectionMatches(env, 0, 1, 0);
  // hash skipping: light-only remeshes of untouched sections did not re-upload identical meshes
  assert.ok(world.stats().uploadsSkipped > 0);
});

test('World: out-of-order and racing mesh results never lose an edit', async () => {
  const env = makeEnv();
  const { world, pool } = env;
  await runUntilIdle(env);
  world.setBlock(4, 4, 4, BLOCK.STONE);
  world.update(8, 70, 8);
  const j1 = pool.take((job) => job.type === 'mesh' && job.cx === 0 && job.cz === 0);
  assert.ok(j1);
  world.setBlock(6, 4, 4, BLOCK.GLASS);                // second edit while job 1 is "running"
  world.update(8, 70, 8);
  const j2 = pool.take((job) => job.type === 'mesh' && job.cx === 0 && job.cz === 0);
  assert.ok(j2);
  pool.run(j2);                                         // newer result arrives first
  await settle();
  world.update(8, 70, 8);
  assertSectionMatches(env, 0, 0, 0);
  pool.run(j1);                                         // stale result arrives late: must be ignored
  await settle();
  world.update(8, 70, 8);
  assertSectionMatches(env, 0, 0, 0);
  // race the other way: job submitted, edit happens before its result is applied
  world.setBlock(8, 4, 8, BLOCK.BRICKS);
  world.update(8, 70, 8);
  const j3 = pool.take((job) => job.type === 'mesh' && job.cx === 0 && job.cz === 0);
  world.setBlock(9, 4, 8, BLOCK.BRICKS);
  pool.run(j3);
  await settle();
  await runUntilIdle(env);
  assertSectionMatches(env, 0, 0, 0);
  assert.equal(world.getBlock(9, 4, 8), BLOCK.BRICKS);
});

test('World: block updates — popping with drops and falling sand', async () => {
  const env = makeEnv();
  const { world, drops } = env;
  await runUntilIdle(env);
  for (let y = 4; y <= 6; y++) assert.ok(world.setBlock(6, y, 6, BLOCK.SUGAR_CANE));
  world.setBlock(6, 3, 6, BLOCK.AIR);
  for (let y = 4; y <= 6; y++) assert.equal(world.getBlock(6, y, 6), BLOCK.AIR);
  assert.equal(drops.length, 3);
  assert.ok(drops.every((d) => d.itemId === BLOCK.SUGAR_CANE && d.count === 1 && d.x === 6.5 && d.z === 6.5));
  world.setBlock(10, 20, 10, BLOCK.SAND);
  assert.equal(world.getBlock(10, 20, 10), BLOCK.AIR);
  assert.equal(world.getBlock(10, 4, 10), BLOCK.SAND);
  world.setBlock(3, 4, 3, BLOCK.SHORT_GRASS);
  world.setBlock(3, 9, 3, BLOCK.GRAVEL);
  assert.equal(world.getBlock(3, 4, 3), BLOCK.GRAVEL);
  world.setBlock(2, 30, 2, BLOCK.SAND, { update: false });
  assert.equal(world.getBlock(2, 30, 2), BLOCK.SAND, 'update: false skips block updates');
  // with a falling-entity hook the column is handed over block by block
  const falls = [];
  world.onFallingBlock = (id, x, y, z) => { falls.push([id, x, y, z]); return true; };
  world.setBlock(2, 29, 2, BLOCK.AIR);                    // nothing changes for the sand at 30 (air below it was already there)
  world.setBlock(2, 31, 2, BLOCK.GRAVEL, { update: false });
  world.setBlock(2, 30, 2, BLOCK.SAND);                   // same id: no change, no update
  assert.equal(falls.length, 0);
  world.setBlock(2, 30, 2, BLOCK.GRAVEL);                 // a change triggers the update
  assert.deepEqual(falls, [[BLOCK.GRAVEL, 2, 30, 2], [BLOCK.GRAVEL, 2, 31, 2]]);
  assert.equal(world.getBlock(2, 30, 2), BLOCK.AIR);
  assert.equal(world.getBlock(2, 31, 2), BLOCK.AIR);
  world.onFallingBlock = null;
  await runUntilIdle(env);
  assertSectionMatches(env, 0, 0, 0);
  assertSectionMatches(env, 0, 0, 1);
});

test('World: unloading saves modified chunks, returning restores them (with and without storage)', async () => {
  for (const storage of [Storage.memory(), null]) {
    const env = makeEnv({ storage });
    const { world, renderer } = env;
    await runUntilIdle(env);
    world.setBlock(5, 10, 5, BLOCK.GLASS);
    await runUntilIdle(env, 4000, 8);
    assert.equal(world.getChunk(0, 0), null, 'unloaded');
    assert.ok(renderer.removed.some(([cx, cz]) => cx === 0 && cz === 0));
    assert.ok(![...renderer.sections.keys()].some((k) => k === '0,0,0'));
    await settle();
    const keys = await world.storage.getChunkKeys('test');
    assert.ok(keys.has('0,0'), 'written to storage');
    assert.equal(keys.size, 1, 'only modified chunks are written');
    await runUntilIdle(env, 8, 8);
    assert.equal(world.getBlock(5, 10, 5), BLOCK.GLASS);
    assert.ok(world.getChunk(0, 0).fromStorage);
    assert.equal(world.getChunk(0, 0).modified, false);
    assertSectionMatches(env, 0, 0, 0);
  }
});

test('World: an unloaded chunk wanted again before its save finished keeps its edits', async () => {
  const env = makeEnv({ storage: Storage.memory() });
  const { world } = env;
  await runUntilIdle(env);
  world.setBlock(1, 9, 1, BLOCK.OBSIDIAN);
  world.setRenderDistance(2);
  // move away and straight back within the same frame sequence (no time for the write)
  world.update(4000, 70, 8);
  assert.equal(world.getChunk(0, 0), null);
  world.update(8, 70, 8);
  assert.equal(world.getChunk(0, 0).state, 3, 'restored from the pending-save buffer without a job');
  assert.equal(world.getBlock(1, 9, 1), BLOCK.OBSIDIAN);
  assert.ok(world.getChunk(0, 0).modified);
  await runUntilIdle(env);
});

test('World: save() + a new World instance restore edits; destroy removes meshes', async () => {
  const storage = Storage.memory();
  const env1 = makeEnv({ storage });
  await runUntilIdle(env1);
  env1.world.setBlock(7, 12, 7, BLOCK.BRICKS);
  env1.world.setBlock(-20, 5, 3, BLOCK.GLOWSTONE);
  assert.equal(env1.world.stats().modified, 2);
  await env1.world.save();
  assert.equal(env1.world.stats().modified, 0);
  await env1.world.destroy();
  assert.equal(env1.renderer.sections.size, 0);
  assert.equal(env1.world.setBlock(1, 5, 1, BLOCK.STONE), false, 'closed worlds reject edits');
  env1.world.update(8, 70, 8);                           // no-op
  const env2 = makeEnv({ storage });
  await runUntilIdle(env2);
  assert.equal(env2.world.getBlock(7, 12, 7), BLOCK.BRICKS);
  assert.equal(env2.world.getBlock(-20, 5, 3), BLOCK.GLOWSTONE);
  assert.equal(env2.world.stats().loadedFromStorage, 2);
  assertSectionMatches(env2, 0, 0, 0);
  assertSectionMatches(env2, -2, 0, 0);
  // glowstone light reaches the neighbour chunk (-1, 0) in the restored world
  assert.equal(env2.world.getLight(-19, 5, 3) & 15, 14);
  // destroy of a world with unsaved edits saves them first
  env2.world.setBlock(0, 20, 0, BLOCK.STONE);
  await env2.world.destroy();
  const keys = await storage.getChunkKeys('test');
  assert.deepEqual([...keys].sort(), ['-2,0', '0,0']);
  assert.equal((await storage.loadChunk('test', 0, 0))[(20 << 8)], BLOCK.STONE);
});

test('World: random ticks — grass spreads to lit dirt, dies under opaque blocks', async () => {
  const env = makeEnv();
  const { world } = env;
  await runUntilIdle(env);
  world.setBlock(6, 3, 6, BLOCK.DIRT);
  await runUntilIdle(env);
  // target offsets (+1, 0, 0): rng 0.9 -> +1, 0.7 -> floor(3.5) - 3 = 0, 0.5 -> 0
  world._tickGrass(BLOCK.GRASS_BLOCK, 5, 3, 6, scripted([0.9, 0.7, 0.5], 0));
  assert.equal(world.getBlock(6, 3, 6), BLOCK.GRASS_BLOCK);
  // dirt covered by an opaque block is not converted
  world.setBlock(6, 3, 6, BLOCK.DIRT);
  world.setBlock(6, 4, 6, BLOCK.STONE);
  world._tickGrass(BLOCK.GRASS_BLOCK, 5, 3, 6, scripted([0.9, 0.7, 0.5], 0));
  assert.equal(world.getBlock(6, 3, 6), BLOCK.DIRT);
  // grass under an opaque block turns into dirt
  world.setBlock(7, 4, 7, BLOCK.STONE);
  world._tickGrass(BLOCK.GRASS_BLOCK, 7, 3, 7, () => 0.5);
  assert.equal(world.getBlock(7, 3, 7), BLOCK.DIRT);
  // at night (sky light 4) grass does not spread
  world.setBlock(6, 4, 6, BLOCK.AIR);
  world._skyDarken = 11;
  world._tickGrass(BLOCK.GRASS_BLOCK, 5, 3, 6, scripted([0.9, 0.7, 0.5], 0));
  assert.equal(world.getBlock(6, 3, 6), BLOCK.DIRT);
  world._skyDarken = 0;
  // integration through tick(): the dirt patch heals with a seeded rng
  await runUntilIdle(env);
  const rng = mulberry32(2024);
  let n = 0;
  while (world.getBlock(6, 3, 6) !== BLOCK.GRASS_BLOCK && n < 60000) {
    world.tick(rng, 0.25);
    n++;
  }
  assert.equal(world.getBlock(6, 3, 6), BLOCK.GRASS_BLOCK, `healed after ${n} ticks`);
  assert.equal(world.getBlock(7, 3, 7), BLOCK.DIRT, 'still covered');
});

test('World: saplings grow into trees, sugar cane and cactus grow up to 3 blocks', async () => {
  const env = makeEnv();
  const { world } = env;
  await runUntilIdle(env);
  world.setBlock(8, 4, 8, BLOCK.OAK_SAPLING);
  world.setBlock(4, 3, 9, BLOCK.WATER);                // sugar cane needs water next to its ground block
  world.setBlock(3, 4, 9, BLOCK.SUGAR_CANE);
  world.setBlock(12, 3, 3, BLOCK.SAND);
  world.setBlock(12, 4, 3, BLOCK.CACTUS);
  await runUntilIdle(env);
  // dark sapling (no light information or light < 9) does not grow
  world._skyDarken = 11;
  world._tickSapling(BLOCK.OAK_SAPLING, 8, 4, 8, () => 0);
  assert.equal(world.getBlock(8, 4, 8), BLOCK.OAK_SAPLING);
  world._skyDarken = 0;
  world._tickSapling(BLOCK.OAK_SAPLING, 8, 4, 8, () => 0.5);   // 0.5 >= 1/14: no growth this time
  assert.equal(world.getBlock(8, 4, 8), BLOCK.OAK_SAPLING);
  world._tickSapling(BLOCK.OAK_SAPLING, 8, 4, 8, mulberry32(5));
  let tries = 0;
  const rng = mulberry32(77);
  while (world.getBlock(8, 4, 8) === BLOCK.OAK_SAPLING && tries++ < 500) world._tickSapling(BLOCK.OAK_SAPLING, 8, 4, 8, rng);
  assert.equal(world.getBlock(8, 4, 8), BLOCK.OAK_LOG);
  assert.equal(world.getBlock(8, 3, 8), BLOCK.DIRT);
  let leaves = 0;
  for (let y = 5; y < 20; y++) for (let z = 4; z < 13; z++) for (let x = 4; x < 13; x++) if (world.getBlock(x, y, z) === BLOCK.OAK_LEAVES) leaves++;
  assert.ok(leaves > 20, `${leaves} leaves`);
  // sugar cane
  const always = () => 0;
  world._tickStackPlant(BLOCK.SUGAR_CANE, 3, 4, 9, always);
  assert.equal(world.getBlock(3, 5, 9), BLOCK.SUGAR_CANE);
  world._tickStackPlant(BLOCK.SUGAR_CANE, 3, 5, 9, always);
  assert.equal(world.getBlock(3, 6, 9), BLOCK.SUGAR_CANE);
  world._tickStackPlant(BLOCK.SUGAR_CANE, 3, 6, 9, always);
  assert.equal(world.getBlock(3, 7, 9), BLOCK.AIR, 'max height 3');
  world._tickStackPlant(BLOCK.SUGAR_CANE, 3, 4, 9, always);
  assert.equal(world.getBlock(3, 7, 9), BLOCK.AIR);
  // cactus with 1/16 chance
  world._tickStackPlant(BLOCK.CACTUS, 12, 4, 3, () => 0.5);
  assert.equal(world.getBlock(12, 5, 3), BLOCK.AIR);
  world._tickStackPlant(BLOCK.CACTUS, 12, 4, 3, () => 0.01);
  assert.equal(world.getBlock(12, 5, 3), BLOCK.CACTUS);
  await runUntilIdle(env);
  assertSectionMatches(env, 0, 0, 0);
});

test('World: ice melts next to a torch, not in the dark', async () => {
  const env = makeEnv();
  const { world } = env;
  await runUntilIdle(env);
  world.setBlock(4, 4, 12, BLOCK.ICE);
  world.setBlock(5, 4, 12, BLOCK.TORCH);
  world.setBlock(4, 4, 2, BLOCK.ICE);
  await runUntilIdle(env);
  assert.ok((world.getLight(4, 4, 12) & 15) > 10);
  world._tickIce(4, 4, 12);
  world._tickIce(4, 4, 2);
  assert.equal(world.getBlock(4, 4, 12), BLOCK.WATER);
  assert.equal(world.getBlock(4, 4, 2), BLOCK.ICE);
});

test('World: setSmoothLighting / remeshAll re-upload everything and drop stale results', async () => {
  const env = makeEnv({ worldType: 'default', seed: 12345 });
  const { world, renderer, pool } = env;
  await runUntilIdle(env);
  world.setBlock(3, world.getTopY(3, 3) + 1, 3, BLOCK.GLOWSTONE);
  world.update(8, 70, 8);
  const stale = pool.take((job) => job.type === 'mesh');
  assert.ok(stale);
  world.setSmoothLighting(false);
  assert.equal(pool.queue.filter((e) => e.job.type === 'mesh').length, 0, 'queued mesh jobs cancelled');
  const calls = renderer.calls;
  pool.run(stale);                                        // old-epoch result: dropped
  await runUntilIdle(env);
  assert.ok(renderer.calls > calls);
  for (const [cx, cz] of [[0, 0], [1, 0], [-1, -1]]) {
    for (let sy = 0; sy < 16; sy++) assertSectionMatches(env, cx, cz, sy);
  }
  // remeshAll after a "context loss": every section is uploaded again even if unchanged
  renderer.sections.clear();
  world.remeshAll();
  await runUntilIdle(env);
  for (let sy = 0; sy < 16; sy++) assertSectionMatches(env, 0, 0, sy);
});

test('World: default terrain — every meshed section equals a direct mesh of the world data', async () => {
  const env = makeEnv({ worldType: 'default', seed: 9876, rd: 2 });
  const { world } = env;
  await runUntilIdle(env, -40, 100);
  let checked = 0;
  for (let cz = 3; cz <= 9; cz++) {
    for (let cx = -6; cx <= 1; cx++) {
      if (!world.isChunkMeshed(cx, cz)) continue;
      for (let sy = 0; sy < 16; sy++) assertSectionMatches(env, cx, cz, sy);
      checked++;
    }
  }
  assert.ok(checked >= 12, `${checked} chunks checked`);
  // light from the stored (trimmed) chunk light equals the reference computation for every cell
  const c = world.getChunk(-3, 6);
  const top = world.getTopY(-40, 100);
  assert.ok(top > 0);
  assert.equal(world.getLight(-40, top + 1, 100) >> 4, 15);
  assert.ok(c.light.length < 65536, 'light is stored trimmed');
  const chunks = [];
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) chunks.push(world.getChunk(-3 + dx, 6 + dz).blocks);
  const ref = extractChunkLight(computeLight(buildRegion(chunks)));
  let mismatches = 0;
  for (let y = 0; y < 256; y++) {
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        if (world.getLight(-48 + x, y, 96 + z) !== ref[(y << 8) | (z << 4) | x]) mismatches++;
      }
    }
  }
  assert.equal(mismatches, 0);
});

test('World: render distance changes unload far chunks and remove their meshes', async () => {
  const env = makeEnv({ rd: 6 });
  const { world, renderer } = env;
  await runUntilIdle(env);
  const before = world.stats().loaded;
  world.setRenderDistance(2);
  await runUntilIdle(env);
  const after = world.stats().loaded;
  assert.ok(after < before);
  for (const k of [...renderer.sections.keys()]) {
    const [cx, , cz] = k.split(',').map(Number);
    assert.ok(classifyChunk(8, 8, cx, cz, 2) !== 0, `mesh ${k} belongs to a loaded chunk`);
  }
  assert.ok(renderer.removed.length > 0);
  world.setRenderDistance(5);
  await runUntilIdle(env);
  assert.ok(world.stats().loaded > after);
  assert.equal(world.renderDistance, 5);
  world.setRenderDistance(100);
  assert.equal(world.renderDistance, 32);
  world.setRenderDistance(0);
  assert.equal(world.renderDistance, 2);
});

test('World: queued jobs of chunks left behind are cancelled; priorities follow the player', async () => {
  const env = makeEnv({ rd: 3 });
  const { world, pool } = env;
  await world.init();
  world.update(8, 70, 8);
  const n0 = pool.pending;
  assert.ok(n0 > 20);
  world.update(5000, 70, 8);
  for (const e of pool.queue) assert.ok(e.job.cx > 200, 'only jobs around the new position remain');
  // reprioritized: the nearest queued job is next
  const first = pool.sorted()[0].job;
  const d0 = chunkCenterDistance(5000, 8, first.cx, first.cz);
  for (const e of pool.queue) assert.ok(chunkCenterDistance(5000, 8, e.job.cx, e.job.cz) >= d0 - 1e-9);
  await runUntilIdle(env, 5000, 8);
});

test('World: failing jobs are retried, then fall back without freezing the player', async () => {
  const errOut = console.error;
  const logged = [];
  console.error = (...a) => logged.push(a.map(String).join(' '));
  try {
    const env = makeEnv();
    const { world, pool } = env;
    pool.fail = (job) => (job.cx === 0 && job.cz === 0 ? `synthetic ${job.type} failure` : null);
    await runUntilIdle(env);
    assert.ok(world.isChunkGenerated(0, 0), 'generated on the main thread after 3 worker failures');
    assert.equal(world.getBlock(3, 3, 3), BLOCK.GRASS_BLOCK);
    assert.ok(world.isChunkMeshed(0, 0), 'gave up meshing: does not block isAreaReady');
    assert.ok(world.isAreaReady(8, 8, 1));
    assert.ok(logged.some((l) => l.includes('synthetic generate failure')));
    assert.ok(logged.some((l) => l.includes('giving up meshing chunk 0,0')));
    // an edit retries the mesh once the problem is gone
    pool.fail = null;
    world.setBlock(2, 4, 2, BLOCK.STONE);
    await runUntilIdle(env);
    assertSectionMatches(env, 0, 0, 0);
  } finally {
    console.error = errOut;
  }
});

test('World: unknown saved-chunk index probes storage for every chunk', async () => {
  const storage = Storage.memory();
  const blocks = new WorldGenerator(7, 'flat').generateChunk(1, 0);
  blocks[(20 << 8) | 5] = BLOCK.DIAMOND_BLOCK;
  await storage.saveChunks('test', [{ cx: 1, cz: 0, blocks }]);
  const failing = Object.create(storage);
  failing.getChunkKeys = async () => { throw new Error('index unavailable'); };
  const warn = console.warn;
  console.warn = () => {};
  try {
    const env = makeEnv({ storage: failing });
    await runUntilIdle(env);
    assert.equal(env.world.getBlock(21, 20, 0), BLOCK.DIAMOND_BLOCK);
    assert.ok(env.world.isChunkMeshed(0, 0));
  } finally {
    console.warn = warn;
  }
});
