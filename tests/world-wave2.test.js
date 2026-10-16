// World tests for wave 2 (docs/SPEC-wave2.md §5): liquids through the real World (chunk borders, meshes,
// unload / reload re-scheduling, budgets), onChunkGenerated, support rules after neighbour changes, random
// ticks of crops / farmland / sugar cane, effects and flowVector. A fake pool runs the real worker code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BLOCK, ITEM, LIQUID_KIND, LIQUID_LEVEL } from '../src/world/registry.js';
import { handleMessage } from '../src/world/worker.js';
import { World } from '../src/world/world.js';
import { Storage } from '../src/world/storage.js';
import { WorldGenerator } from '../src/world/worldgen.js';
import { buildRegion, computeLight } from '../src/world/lighting.js';
import { meshChunk } from '../src/world/mesher.js';

const settle = async (n = 4) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

/** Pool stand-in: runs queued jobs through the real worker message handler on demand. */
class FakePool {
  constructor() {
    this.size = 4;
    this.queue = [];
    this.nextId = 1;
    this.generated = [];
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
      if (e.job.type === 'generate') this.generated.push(`${e.job.cx},${e.job.cz}`);
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

function makeEnv({ rd = 2, storage = null, worldType = 'flat', seed = 7, worldId = 'w2', ...extra } = {}) {
  const pool = new FakePool();
  const renderer = new FakeRenderer();
  const drops = [];
  const effects = [];
  const world = new World({
    seed, worldType, worldId, storage, pool, renderer, renderDistance: rd, smoothLighting: true,
    onDropItem: (itemId, count, x, y, z) => drops.push({ itemId, count, x, y, z }),
    onEffect: (name, x, y, z) => effects.push({ name, x, y, z }),
    ...extra,
  });
  return { world, pool, renderer, drops, effects };
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

/** Game ticks with frames in between (meshing keeps up). */
async function ticks(env, n, rng = () => 0.99) {
  for (let i = 0; i < n; i++) {
    env.world.tick(rng);
    if (i % 10 === 9) await runUntilIdle(env);
  }
  await runUntilIdle(env);
}

function assertSectionMatches(env, cx, cz, sy) {
  const chunks = [];
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) chunks.push(env.world.getChunk(cx + dx, cz + dz)?.blocks ?? null);
  }
  const region = buildRegion(chunks);
  const gen = new WorldGenerator(env.world.seed, env.world.worldType);
  const [exp] = meshChunk(region, computeLight(region), 1 << sy, gen.getTints(cx, cz), { smoothLighting: true });
  const got = env.renderer.sections.get(`${cx},${sy},${cz}`) ?? { opaque: null, cutout: null, translucent: null };
  for (const k of ['opaque', 'cutout', 'translucent']) {
    assert.deepEqual(got[k] ?? null, exp[k] ?? null, `section ${cx},${sy},${cz} layer ${k}`);
  }
}

const level = (world, x, y, z) => {
  const id = world.getBlock(x, y, z);
  return LIQUID_KIND[id] ? LIQUID_LEVEL[id] : -1;
};

// ---------------------------------------------------------------------------------------------
// Liquids in the World
// ---------------------------------------------------------------------------------------------

test('World: water flows across chunk borders and the meshes match the world data', async () => {
  const env = makeEnv();
  const { world } = env;
  await runUntilIdle(env);
  // flat world: grass at y = 3. Pour water at the corner of four chunks.
  assert.ok(world.setBlock(-1, 4, -1, BLOCK.WATER));
  assert.ok(world.fluids.isScheduled(-1, 4, -1));
  await ticks(env, 60);
  assert.equal(world.fluids.pending, 0, 'settled');
  for (const [x, z] of [[-1, -1], [0, -1], [-1, 0], [0, 0], [6, -1], [-1, 6], [-8, -1]]) {
    const d = Math.abs(x + 1) + Math.abs(z + 1);
    assert.equal(level(world, x, 4, z), d, `level at ${x},${z}`);
  }
  assert.equal(world.getBlock(7, 4, -1), BLOCK.AIR);
  assert.ok(world.getChunk(0, 0).modified && world.getChunk(-1, -1).modified, 'every touched chunk is modified');
  for (const [cx, cz] of [[-1, -1], [0, -1], [-1, 0], [0, 0]]) assertSectionMatches(env, cx, cz, 0);
  // grass under water turns into dirt on random ticks (Minecraft: liquid above)
  world._tickGrass(BLOCK.GRASS_BLOCK, 0, 3, 0, () => 0.5);
  assert.equal(world.getBlock(0, 3, 0), BLOCK.DIRT);
  // scooping the source dries everything up again
  world.setBlock(-1, 4, -1, BLOCK.AIR);
  await ticks(env, 120);
  for (let z = -9; z <= 7; z++) for (let x = -9; x <= 7; x++) assert.equal(LIQUID_KIND[world.getBlock(x, 4, z)], 0, `${x},${z}`);
  assertSectionMatches(env, 0, 0, 0);
});

test('World: lava + water make obsidian / cobblestone and fire onEffect fizz; flowVector via world.fluids', async () => {
  const env = makeEnv();
  const { world, effects } = env;
  await runUntilIdle(env);
  world.setBlock(4, 3, 4, BLOCK.AIR);
  world.setBlock(4, 3, 4, BLOCK.LAVA);                  // lava in a 1-deep hole
  world.setBlock(2, 4, 4, BLOCK.WATER);                 // water two blocks away flows over it
  await ticks(env, 40);
  assert.equal(world.getBlock(4, 3, 4), BLOCK.OBSIDIAN);
  assert.ok(effects.some((e) => e.name === 'fizz' && e.x === 4.5 && e.y === 3.5 && e.z === 4.5));
  const v = world.fluids.flowVector(4, 4, 4, [0, 0, 0]);
  assert.ok(v[0] > 0.9, `downstream: ${v}`);
  const v2 = world.fluids.flowVector(world, 4, 4, 4, [0, 0, 0]);
  assert.deepEqual(v2, v);
});

test('World: chunks reloaded from storage get their unsettled liquids re-scheduled', async () => {
  const storage = Storage.memory();
  const env = makeEnv({ storage });
  const { world } = env;
  await runUntilIdle(env);
  world.setBlock(8, 4, 8, BLOCK.WATER);
  world.tick();
  for (let i = 0; i < 6; i++) world.tick();             // first ring only
  assert.equal(level(world, 9, 4, 8), 1);
  assert.equal(world.getBlock(10, 4, 8), BLOCK.AIR);
  await world.save();
  await world.destroy();
  const env2 = makeEnv({ storage });
  await runUntilIdle(env2);
  assert.equal(level(env2.world, 9, 4, 8), 1, 'restored mid-flow');
  assert.ok(env2.world.fluids.pending > 0, 'unsettled cells were scheduled again');
  await ticks(env2, 60);
  assert.equal(level(env2.world, 15, 4, 8), 7, 'the flow completed after the reload');
  assert.equal(env2.world.fluids.pending, 0);
});

test('World: unloading a chunk drops its liquid ticks; the water resumes when it comes back', async () => {
  const env = makeEnv({ storage: Storage.memory() });
  const { world } = env;
  await runUntilIdle(env);
  world.setBlock(8, 4, 8, BLOCK.WATER);
  for (let i = 0; i < 6; i++) world.tick();
  assert.ok(world.fluids.pending > 0);
  await runUntilIdle(env, 4000, 8);                     // walk far away: chunk (0, 0) unloads
  assert.equal(world.getChunk(0, 0), null);
  assert.equal(world.fluids.pending, 0, 'ticks of unloaded chunks are dropped');
  await runUntilIdle(env, 8, 8);                        // come back: restored from the unload buffer / storage
  assert.ok(world.fluids.pending > 0, 're-scheduled after the reload');
  await ticks(env, 60);
  assert.equal(level(world, 15, 4, 8), 7);
});

// ---------------------------------------------------------------------------------------------
// onChunkGenerated
// ---------------------------------------------------------------------------------------------

test('World: onChunkGenerated fires once per chunk ever generated (not for storage loads), persisted', async () => {
  const storage = Storage.memory();
  const env = makeEnv({ storage });
  const seen = [];
  const early = [];
  // events before the first listener are delivered to it
  await runUntilIdle(env);
  env.world.onChunkGenerated((cx, cz) => early.push(`${cx},${cz}`));
  assert.ok(early.length > 0, 'queued events delivered');
  assert.equal(new Set(early).size, early.length, 'each chunk once');
  assert.deepEqual(new Set(early), new Set(env.pool.generated));
  const off = env.world.onChunkGenerated((cx, cz) => seen.push(`${cx},${cz}`));
  // walk away and back: chunks are generated again (unmodified ones are not saved) but not "new"
  await runUntilIdle(env, 4000, 8);
  const farCount = seen.length;
  assert.ok(farCount > 0, 'new chunks far away fire');
  const regenBefore = env.pool.generated.length;
  await runUntilIdle(env, 8, 8);
  assert.ok(env.pool.generated.length > regenBefore, 'the home chunks were generated again');
  assert.equal(seen.length, farCount, 'but did not fire again');
  off();
  // a new World instance on the same storage remembers which chunks were generated
  env.world.setBlock(3, 10, 3, BLOCK.STONE);
  await env.world.save();
  await env.world.destroy();
  const env2 = makeEnv({ storage });
  const seen2 = [];
  env2.world.onChunkGenerated((cx, cz) => seen2.push(`${cx},${cz}`));
  await runUntilIdle(env2);
  assert.equal(seen2.length, 0, 'nothing is new at home after a reload');
  assert.equal(env2.world.getBlock(3, 10, 3), BLOCK.STONE);
  // storage keys exclude the per-world data record
  const keys = await storage.getChunkKeys('w2');
  assert.ok([...keys].every((k) => /^-?\d+,-?\d+$/.test(k)));
  assert.ok((await storage.loadWorldData('w2', 'populated')) instanceof Int32Array);
  await storage.deleteWorld('w2');
  assert.equal(await storage.loadWorldData('w2', 'populated'), null);
});

// ---------------------------------------------------------------------------------------------
// Support rules (registry canStay) after neighbour changes
// ---------------------------------------------------------------------------------------------

test('World: wall torches, cacti and crops pop when a horizontal / lower neighbour changes', async () => {
  const env = makeEnv();
  const { world, drops } = env;
  await runUntilIdle(env);
  // wall torch on a stone block: removing the stone (horizontal neighbour) pops the torch
  world.setBlock(5, 4, 5, BLOCK.STONE);
  world.setBlock(5, 4, 4, BLOCK.WALL_TORCH_NORTH);      // points north, attached to the stone at z = 5
  assert.equal(world.getBlock(5, 4, 4), BLOCK.WALL_TORCH_NORTH);
  world.setBlock(5, 4, 5, BLOCK.AIR);
  assert.equal(world.getBlock(5, 4, 4), BLOCK.AIR);
  assert.ok(drops.some((d) => d.itemId === BLOCK.TORCH), 'drops a torch item');
  // a wall torch placed without a wall pops at once
  world.setBlock(9, 6, 9, BLOCK.WALL_TORCH_EAST);
  assert.equal(world.getBlock(9, 6, 9), BLOCK.AIR);
  // cactus on sand: a block placed beside it breaks it
  world.setBlock(12, 3, 12, BLOCK.SAND);
  world.setBlock(12, 4, 12, BLOCK.CACTUS);
  world.setBlock(12, 5, 12, BLOCK.CACTUS);
  assert.equal(world.getBlock(12, 5, 12), BLOCK.CACTUS);
  world.setBlock(13, 5, 12, BLOCK.DIRT);
  assert.equal(world.getBlock(12, 5, 12), BLOCK.AIR, 'the upper cactus touching the dirt pops');
  assert.equal(world.getBlock(12, 4, 12), BLOCK.CACTUS, 'the lower one stays');
  // wheat on farmland: a solid block on the farmland's neighbour does nothing, on top of a farmland
  // without crop it turns into dirt, and a crop whose farmland becomes dirt pops
  world.setBlock(2, 3, 12, BLOCK.FARMLAND);
  world.setBlock(2, 4, 12, BLOCK.WHEAT_3);
  world.setBlock(3, 3, 12, BLOCK.FARMLAND);
  world.setBlock(3, 4, 12, BLOCK.STONE);
  assert.equal(world.getBlock(3, 3, 12), BLOCK.DIRT, 'solid block on farmland -> dirt');
  assert.equal(world.getBlock(2, 4, 12), BLOCK.WHEAT_3);
  world.setBlock(2, 3, 12, BLOCK.DIRT);
  assert.equal(world.getBlock(2, 4, 12), BLOCK.AIR, 'crop without farmland pops');
  assert.ok(drops.some((d) => d.itemId === ITEM.WHEAT_SEEDS));
  await runUntilIdle(env);
  assertSectionMatches(env, 0, 0, 0);
});

// ---------------------------------------------------------------------------------------------
// Random ticks
// ---------------------------------------------------------------------------------------------

test('World: wheat grows with light on farmland (faster on moist), farmland hydrates and dries', async () => {
  const env = makeEnv();
  const { world } = env;
  await runUntilIdle(env);
  // a 3x3 field, water in the middle row end
  for (let z = 4; z <= 6; z++) for (let x = 4; x <= 6; x++) world.setBlock(x, 3, z, BLOCK.FARMLAND);
  world.setBlock(5, 4, 5, BLOCK.WHEAT_0);
  await runUntilIdle(env);
  // growth chance: lone crop on dry farmland: f = 1 + 1 + 8 * 0.25 = 4 -> 1 / (floor(25 / 4) + 1) = 1/7
  assert.equal(world._growthChance(5, 4, 5), 4);
  world._tickCrop(BLOCK.WHEAT_0, 5, 4, 5, () => 0.2);   // 0.2 * 7 = 1.4 -> 1: no growth
  assert.equal(world.getBlock(5, 4, 5), BLOCK.WHEAT_0);
  world._tickCrop(BLOCK.WHEAT_0, 5, 4, 5, () => 0.1);   // 0.7 -> 0: grows
  assert.equal(world.getBlock(5, 4, 5), BLOCK.WHEAT_1);
  // darkness stops growth
  world._skyDarken = 11;
  world._tickCrop(BLOCK.WHEAT_1, 5, 4, 5, () => 0);
  assert.equal(world.getBlock(5, 4, 5), BLOCK.WHEAT_1);
  world._skyDarken = 0;
  // farmland: dry without water and without crop -> dirt; with a crop it stays
  world._tickFarmland(BLOCK.FARMLAND, 4, 3, 4, () => 0.5);
  assert.equal(world.getBlock(4, 3, 4), BLOCK.DIRT);
  world._tickFarmland(BLOCK.FARMLAND, 5, 3, 5, () => 0.5);
  assert.equal(world.getBlock(5, 3, 5), BLOCK.FARMLAND, 'a crop keeps dry farmland');
  // water within 4 blocks hydrates; moist farmland gives f = 1 + 3 + ...
  world.setBlock(9, 3, 5, BLOCK.WATER);                 // 4 blocks east of x = 5
  world._tickFarmland(BLOCK.FARMLAND, 5, 3, 5, () => 0.5);
  assert.equal(world.getBlock(5, 3, 5), BLOCK.FARMLAND_MOIST);
  assert.ok(world._growthChance(5, 4, 5) > 4);
  // too far (5 blocks): no water -> dry, and without a crop it reverts to dirt
  world._tickFarmland(BLOCK.FARMLAND, 4, 3, 5, () => 0.5);
  assert.equal(world.getBlock(4, 3, 5), BLOCK.DIRT);
  world._tickFarmland(BLOCK.FARMLAND, 5, 3, 6, () => 0.5);
  assert.equal(world.getBlock(5, 3, 6), BLOCK.FARMLAND_MOIST, '4 blocks away (dx 4, dz 1): moist');
  // water removed: moist dries with p = 1/7 per random tick
  world.setBlock(9, 3, 5, BLOCK.GRASS_BLOCK);
  world._tickFarmland(BLOCK.FARMLAND_MOIST, 5, 3, 5, () => 0.5);
  assert.equal(world.getBlock(5, 3, 5), BLOCK.FARMLAND_MOIST);
  world._tickFarmland(BLOCK.FARMLAND_MOIST, 5, 3, 5, () => 0.1);
  assert.equal(world.getBlock(5, 3, 5), BLOCK.FARMLAND);
  // the whole cycle through tick(): wheat reaches stage 7 eventually
  let n = 0;
  const rng = () => ((n = (n * 1103515245 + 12345) >>> 0) / 4294967296);
  for (let i = 0; i < 4000 && world.getBlock(5, 4, 5) !== BLOCK.WHEAT_7; i++) world._tickCrop(world.getBlock(5, 4, 5), 5, 4, 5, rng);
  assert.equal(world.getBlock(5, 4, 5), BLOCK.WHEAT_7);
  world._tickCrop(BLOCK.WHEAT_7, 5, 4, 5, () => 0);
  assert.equal(world.getBlock(5, 4, 5), BLOCK.WHEAT_7, 'mature wheat stays');
});

test('World: sugar cane pops on random ticks once its water is gone; plants without support pop', async () => {
  const env = makeEnv();
  const { world, drops } = env;
  await runUntilIdle(env);
  world.setBlock(6, 3, 7, BLOCK.WATER);
  world.setBlock(6, 4, 6, BLOCK.SUGAR_CANE);            // ground (6, 3, 6) has water at (6, 3, 7)
  world.setBlock(6, 5, 6, BLOCK.SUGAR_CANE);
  assert.equal(world.getBlock(6, 5, 6), BLOCK.SUGAR_CANE);
  // the water is diagonal to the cane: a liquid change re-checks the cells diagonally above it
  world.setBlock(6, 3, 7, BLOCK.DIRT);
  assert.equal(world.getBlock(6, 4, 6), BLOCK.AIR, 'the cane pops as soon as its water is gone');
  assert.equal(world.getBlock(6, 5, 6), BLOCK.AIR, 'the stack cascades');
  assert.equal(drops.filter((d) => d.itemId === BLOCK.SUGAR_CANE).length, 2);
  // without block updates (e.g. a change made with { update: false }) random ticks still catch it
  world.setBlock(6, 3, 7, BLOCK.WATER);
  world.setBlock(6, 4, 6, BLOCK.SUGAR_CANE);
  world.setBlock(6, 5, 6, BLOCK.SUGAR_CANE);
  world.setBlock(6, 3, 7, BLOCK.DIRT, { update: false });
  assert.equal(world.getBlock(6, 4, 6), BLOCK.SUGAR_CANE, 'still standing until a random tick');
  world._tickStackPlant(BLOCK.SUGAR_CANE, 6, 5, 6, () => 0.5);
  assert.equal(world.getBlock(6, 5, 6), BLOCK.SUGAR_CANE, 'the upper cane stands on cane');
  world._tickStackPlant(BLOCK.SUGAR_CANE, 6, 4, 6, () => 0.5);
  assert.equal(world.getBlock(6, 4, 6), BLOCK.AIR);
  assert.equal(world.getBlock(6, 5, 6), BLOCK.AIR, 'the stack cascades');
  assert.equal(drops.filter((d) => d.itemId === BLOCK.SUGAR_CANE).length, 4);
  // a flower that somehow sits on stone pops on its random tick
  world.setBlock(9, 3, 9, BLOCK.STONE);
  world.setBlock(9, 4, 9, BLOCK.POPPY, { update: false });
  world._randomTick(7, BLOCK.POPPY, 9, 4, 9, () => 0.5);
  assert.equal(world.getBlock(9, 4, 9), BLOCK.AIR);
});
