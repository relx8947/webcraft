// Regression tests for the wave-1 review findings fixed in the world modules (docs/notes/review-wave1.json):
// WORLD-1 / CODE-2 atomic snapshot saves, CODE-1 destroy() failures keep the world, WORLD-4 batched
// background unload saves, WORLD-5 Storage.open fallback, WORLD-2 floating gravel, WORLD-3 / SURV-2 leaf
// decay, AUDIO-2 popped-block hook, WORLD-7 world lock fallback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BLOCK } from '../src/world/registry.js';
import { handleMessage } from '../src/world/worker.js';
import { World } from '../src/world/world.js';
import { Storage } from '../src/world/storage.js';
import { BlockUpdater } from '../src/world/blockupdates.js';

const settle = async (n = 4) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

class FakePool {
  constructor() {
    this.size = 4;
    this.queue = [];
    this.nextId = 1;
  }

  init(seed, worldType) {
    handleMessage({ type: 'init', seed, worldType });
  }

  submit(job, priority = 0) {
    return new Promise((resolve, reject) => {
      job.jobId = this.nextId++;
      this.queue.push({ job, priority, resolve, reject });
    });
  }

  cancel(pred) {
    this.queue = this.queue.filter((e) => {
      if (!pred(e.job, e.priority)) return true;
      const err = new Error('cancelled');
      err.cancelled = true;
      e.reject(err);
      return false;
    });
  }

  reprioritize() {}

  get pending() {
    return this.queue.length;
  }

  runAll() {
    while (this.queue.length > 0) {
      this.queue.sort((a, b) => a.priority - b.priority);
      const e = this.queue.shift();
      const out = handleMessage(e.job);
      if (out.message.type === 'error') e.reject(new Error(out.message.message));
      else e.resolve(out.message);
    }
  }
}

class FakeRenderer {
  constructor() {
    this.sections = new Map();
  }

  setSectionMesh(cx, sy, cz, opaque, cutout, translucent) {
    const key = `${cx},${sy},${cz}`;
    if (!opaque && !cutout && !translucent) this.sections.delete(key);
    else this.sections.set(key, { opaque, cutout, translucent });
  }

  removeChunk(cx, cz) {
    for (let sy = 0; sy < 16; sy++) this.sections.delete(`${cx},${sy},${cz}`);
  }
}

function makeEnv({ rd = 2, storage = null, worldType = 'flat', worldId = 'rv', ...extra } = {}) {
  const pool = new FakePool();
  const renderer = new FakeRenderer();
  const drops = [];
  const world = new World({
    seed: 7, worldType, worldId, storage, pool, renderer, renderDistance: rd, smoothLighting: true,
    onDropItem: (itemId, count, x, y, z) => drops.push({ itemId, count, x, y, z }), ...extra,
  });
  return { world, pool, renderer, drops };
}

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

/** Storage whose writes can be made to fail; counts chunk writes per call. */
function flakyStorage() {
  const s = Storage.memory();
  s.fail = false;
  s.calls = [];
  const saveChunks = s.saveChunks.bind(s);
  s.saveChunks = (worldId, chunks) => {
    s.calls.push(chunks.length);
    if (s.fail) return Promise.reject(new Error('QuotaExceededError (test)'));
    return saveChunks(worldId, chunks);
  };
  const saveSnapshot = s.saveSnapshot.bind(s);
  s.saveSnapshot = (...args) => (s.fail ? Promise.reject(new Error('QuotaExceededError (test)')) : saveSnapshot(...args));
  return s;
}

// ---------------------------------------------------------------------------------------------

test('WORLD-1 / CODE-2: saveSnapshot writes meta, loaded + unloaded chunks and data records at once', async () => {
  const storage = Storage.memory();
  const env = makeEnv({ storage });
  const { world } = env;
  await runUntilIdle(env);
  world.setBlock(3, 10, 3, BLOCK.GOLD_BLOCK);
  world.setBlock(-20, 10, 3, BLOCK.DIAMOND_BLOCK);
  // a chunk with an edit that was unloaded but not written yet stays in the unload buffer
  world._unloadSaves.set('9,9', { id: '9,9', cx: 9, cz: 9, blocks: new Uint8Array(65536).fill(BLOCK.STONE, 0, 256) });
  const meta = { id: 'rv', name: 'snapshot', time: 1234 };
  const p = world.saveSnapshot(meta);
  // the records were taken synchronously: later edits are not part of this snapshot but stay modified
  world.setBlock(4, 10, 3, BLOCK.IRON_BLOCK);
  const res = await p;
  assert.equal(res.chunks, 3);
  assert.equal(world._unloadSaves.size, 0);
  assert.equal(world.getChunk(-2, 0).modified, false);
  assert.equal(world.getChunk(0, 0).modified, true, 'edited after the snapshot started');
  assert.equal((await storage.loadWorldMeta('rv')).time, 1234);
  assert.ok((await storage.loadChunk('rv', 9, 9)) instanceof Uint8Array);
  assert.ok((await storage.loadWorldData('rv', 'populated')) instanceof Int32Array);
  await world.saveSnapshot(null);
  const env2 = makeEnv({ storage });
  await runUntilIdle(env2);
  assert.equal(env2.world.getBlock(3, 10, 3), BLOCK.GOLD_BLOCK);
  assert.equal(env2.world.getBlock(4, 10, 3), BLOCK.IRON_BLOCK);
  assert.equal(env2.world.getBlock(-20, 10, 3), BLOCK.DIAMOND_BLOCK);
  // a failing snapshot keeps everything modified for the next try
  const flaky = flakyStorage();
  const env3 = makeEnv({ storage: flaky, worldId: 'rv3' });
  await runUntilIdle(env3);
  env3.world.setBlock(1, 9, 1, BLOCK.STONE);
  flaky.fail = true;
  await assert.rejects(env3.world.saveSnapshot({ id: 'rv3' }));
  assert.equal(env3.world.getChunk(0, 0).modified, true);
  flaky.fail = false;
  await env3.world.saveSnapshot({ id: 'rv3' });
  assert.equal(env3.world.getChunk(0, 0).modified, false);
});

test('CODE-1: a failed final save leaves the world loaded, visible and editable; save:false quits', async () => {
  const storage = flakyStorage();
  const env = makeEnv({ storage, worldId: 'rv1' });
  const { world, renderer } = env;
  await runUntilIdle(env);
  world.setBlock(5, 9, 5, BLOCK.BRICKS);
  const meshes = renderer.sections.size;
  storage.fail = true;
  const p = world.destroy();
  assert.equal(world.setBlock(6, 9, 5, BLOCK.STONE), false, 'no edits during the final save');
  await assert.rejects(p, /QuotaExceeded/);
  assert.equal(renderer.sections.size, meshes, 'meshes are still there');
  assert.equal(world.getBlock(5, 9, 5), BLOCK.BRICKS);
  assert.equal(world.setBlock(6, 9, 5, BLOCK.STONE), true, 'editable again');
  assert.equal(world.getChunk(0, 0).modified, true);
  world.tick();
  // retry succeeds
  storage.fail = false;
  await world.destroy();
  assert.equal(renderer.sections.size, 0);
  assert.equal((await storage.loadChunk('rv1', 0, 0))[(9 << 8) | (5 << 4) | 6], BLOCK.STONE);
  // quitting without saving
  const s2 = flakyStorage();
  const env2 = makeEnv({ storage: s2, worldId: 'rv2' });
  await runUntilIdle(env2);
  env2.world.setBlock(5, 9, 5, BLOCK.BRICKS);
  s2.fail = true;
  await env2.world.destroy({ save: false });
  assert.equal(env2.renderer.sections.size, 0);
  assert.equal(s2.calls.length, 0, 'nothing was written');
});

test('WORLD-4: background unload saves write at most 16 chunks per frame', async () => {
  const storage = flakyStorage();
  const env = makeEnv({ storage, rd: 4, worldId: 'rv4' });
  const { world } = env;
  await runUntilIdle(env);
  let edited = 0;
  for (let cz = -4; cz <= 4; cz++) for (let cx = -4; cx <= 4; cx++) if (world.setBlock(cx * 16 + 3, 12, cz * 16 + 3, BLOCK.STONE)) edited++;
  assert.ok(edited > 40);
  world.update(100000, 70, 8, 1 / 60);                 // teleport: everything unloads
  assert.ok(world._unloadSaves.size > 16);
  assert.ok(storage.calls.every((n) => n <= 16), `per-call sizes ${storage.calls}`);
  for (let i = 0; i < 20 && world._unloadSaves.size > 0; i++) {
    await settle();
    world.update(100000, 70, 8, 1 / 60);
  }
  assert.equal(world._unloadSaves.size, 0, 'all written over a few frames');
  assert.ok(storage.calls.every((n) => n <= 16), `per-call sizes ${storage.calls}`);
  assert.equal((await storage.getChunkKeys('rv4')).size, edited);
  // save() / destroy() still write everything that is queued
  world.update(8, 70, 8, 1 / 60);
  env.pool.runAll();
  await world.destroy();
});

test('WORLD-5: Storage.open falls back to memory when reading indexedDB throws', async () => {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    get() { throw new Error('SecurityError: The operation is insecure. (test)'); },
  });
  const warn = console.warn;
  console.warn = () => {};
  try {
    const s = await Storage.open();
    assert.equal(s.backend, 'memory');
    assert.equal(s.persistent, false);
    await s.saveWorldMeta({ id: 'x' });
    assert.equal((await s.listWorlds()).length, 1);
  } finally {
    console.warn = warn;
    if (had) Object.defineProperty(globalThis, 'indexedDB', had);
    else delete globalThis.indexedDB;
  }
});

test('WORLD-2: a floating gravel ceiling collapses when a block next to it is mined', () => {
  const m = new Map();
  const w = {
    getBlock: (x, y, z) => (y < 0 || y > 255 ? 0 : m.get(`${x},${y},${z}`) ?? 0),
    setBlock: (x, y, z, id) => {
      if (id === 0) m.delete(`${x},${y},${z}`);
      else m.set(`${x},${y},${z}`, id);
      return true;
    },
  };
  const u = new BlockUpdater(w, {});
  for (let x = -3; x <= 9; x++) for (let z = -3; z <= 3; z++) w.setBlock(x, 0, z, BLOCK.STONE);
  for (let x = 0; x < 5; x++) w.setBlock(x, 5, 0, BLOCK.GRAVEL);     // generated floating strip
  w.setBlock(-1, 5, 0, BLOCK.STONE);
  w.setBlock(-1, 5, 0, 0);                                            // mine the stone next to it
  u.blockChanged(-1, 5, 0);
  for (let x = 0; x < 5; x++) {
    assert.equal(w.getBlock(x, 5, 0), 0, `gravel ${x} fell`);
    assert.equal(w.getBlock(x, 1, 0), BLOCK.GRAVEL, `landed ${x}`);
  }
});

test('AUDIO-2: popped blocks are reported (break effects) but falling blocks landing are not', async () => {
  const popped = [];
  const env = makeEnv({ onBlockPopped: (id, x, y, z) => popped.push([id, x, y, z]) });
  const { world } = env;
  await runUntilIdle(env);
  world.setBlock(5, 4, 5, BLOCK.TORCH);
  world.setBlock(5, 3, 5, BLOCK.AIR);
  assert.deepEqual(popped, [[BLOCK.TORCH, 5, 4, 5]]);
  world.setBlock(9, 10, 9, BLOCK.SAND);                 // falls instantly (no falling-entity hook)
  assert.equal(world.getBlock(9, 4, 9), BLOCK.SAND);
  assert.equal(popped.length, 1);
});

test('WORLD-3 / SURV-2: leaves without a log within 6 steps decay after the trunk is cut', async () => {
  const storage = Storage.memory();
  const env = makeEnv({ storage, worldId: 'leaf' });
  const { world, drops } = env;
  await runUntilIdle(env);
  // tree: trunk 4..8 at (8, z 8), canopy around the top, placed like a growing sapling does (natural
  // leaves); player-placed leaves: a hedge far away and a few leaves right next to the trunk
  world._naturalPlacement = true;
  for (let y = 4; y <= 8; y++) world.setBlock(8, y, 8, BLOCK.OAK_LOG);
  for (let y = 7; y <= 9; y++) {
    for (let z = 6; z <= 10; z++) {
      for (let x = 6; x <= 10; x++) if (world.getBlock(x, y, z) === BLOCK.AIR) world.setBlock(x, y, z, BLOCK.OAK_LEAVES);
    }
  }
  world._naturalPlacement = false;
  for (let x = 20; x < 26; x++) world.setBlock(x, 4, 20, BLOCK.OAK_LEAVES);
  world.setBlock(9, 5, 8, BLOCK.OAK_LEAVES);
  world.setBlock(7, 5, 8, BLOCK.OAK_LEAVES);
  assert.equal(world._placedLeaves.size, 8);
  const leaves = () => {
    let n = 0;
    for (let y = 4; y <= 12; y++) for (let z = 4; z <= 12; z++) for (let x = 4; x <= 12; x++) if (world.getBlock(x, y, z) === BLOCK.OAK_LEAVES) n++;
    return n;
  };
  const total = leaves();
  assert.ok(total > 60);
  // random ticks on every leaf while the trunk stands: nothing decays
  const tickAll = () => {
    for (let y = 4; y <= 12; y++) for (let z = 4; z <= 12; z++) for (let x = 4; x <= 12; x++) {
      const id = world.getBlock(x, y, z);
      if (id === BLOCK.OAK_LEAVES) world._randomTick(8, id, x, y, z, () => 0.5);
    }
    for (let x = 20; x < 26; x++) world._randomTick(8, BLOCK.OAK_LEAVES, x, 4, 20, () => 0.5);
  };
  tickAll();
  assert.equal(leaves(), total);
  // cut the trunk: the canopy becomes candidates and decays on random ticks, dropping loot sometimes
  for (let y = 4; y <= 8; y++) world.setBlock(8, y, 8, BLOCK.AIR);
  assert.ok(world._decayCandidates.size >= total);
  // candidates survive a save / reload
  await world.save();
  const env2 = makeEnv({ storage, worldId: 'leaf' });
  await runUntilIdle(env2);
  assert.ok(env2.world._decayCandidates.size >= total, 'candidates restored');
  await env2.world.destroy({ save: false });
  for (let i = 0; i < 4 && leaves() > 2; i++) tickAll();
  assert.equal(leaves(), 2, 'the trunkless canopy is gone, the two player-placed leaves stay');
  assert.equal(world.getBlock(9, 5, 8), BLOCK.OAK_LEAVES);
  for (let x = 20; x < 26; x++) assert.equal(world.getBlock(x, 4, 20), BLOCK.OAK_LEAVES, 'player hedge stays');
  assert.equal(drops.length, drops.filter((d) => d.itemId === BLOCK.OAK_SAPLING || d.itemId > 255).length, 'only loot');
  // natural leaves still connected to another log survive
  world._naturalPlacement = true;
  world.setBlock(30, 4, 30, BLOCK.OAK_LOG);
  world.setBlock(31, 4, 30, BLOCK.OAK_LEAVES);
  world._naturalPlacement = false;
  world.setBlock(29, 4, 30, BLOCK.OAK_LOG);
  world.setBlock(29, 4, 30, BLOCK.AIR);                 // a log removed nearby marks the leaf
  assert.ok(world._decayCandidates.has('31,4,30'));
  world._randomTick(8, BLOCK.OAK_LEAVES, 31, 4, 30, () => 0.5);
  assert.equal(world.getBlock(31, 4, 30), BLOCK.OAK_LEAVES, 'still next to a log');
  assert.ok(!world._decayCandidates.has('31,4,30'), 'checked once, then forgotten');
  // player-placed leaves are remembered across a save / reload; breaking one forgets it
  world.setBlock(20, 4, 20, BLOCK.AIR);
  await world.save();
  const env3 = makeEnv({ storage, worldId: 'leaf' });
  await runUntilIdle(env3);
  assert.ok(env3.world._placedLeaves.has('21,4,20'));
  assert.ok(!env3.world._placedLeaves.has('20,4,20'));
});

test('saplings grow natural (decaying) leaves', async () => {
  const env = makeEnv({ worldId: 'sap' });
  const { world } = env;
  await runUntilIdle(env);
  world.setBlock(8, 4, 8, BLOCK.OAK_SAPLING);
  let n = 0;
  const rng = () => ((n = (n * 1103515245 + 12345) >>> 0) / 4294967296);
  for (let i = 0; i < 500 && world.getBlock(8, 4, 8) === BLOCK.OAK_SAPLING; i++) world._tickSapling(BLOCK.OAK_SAPLING, 8, 4, 8, rng);
  assert.equal(world.getBlock(8, 4, 8), BLOCK.OAK_LOG);
  assert.equal(world._placedLeaves.size, 0, 'grown leaves are natural');
});

test('WORLD-7: acquireWorldLock falls back gracefully without Web Locks', async () => {
  const s = Storage.memory();
  const lock = await s.acquireWorldLock('w');
  assert.ok(lock);
  assert.equal(typeof lock.release, 'function');
  lock.release();
  assert.equal(typeof await s.requestPersistence(), 'boolean');
});
