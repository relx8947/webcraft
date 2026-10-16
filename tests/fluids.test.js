// Liquid flow tests (src/world/fluids.js + blockupdates.js): Minecraft rules on a plain voxel map, the
// scheduler (de-duplication, budgets, chunk drops, scans) and flowVector.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BLOCK, ITEM, LIQUID_KIND, LIQUID_LEVEL, liquidBlock } from '../src/world/registry.js';
import { FluidSimulator, flowVector, TICK_DELAY } from '../src/world/fluids.js';
import { BlockUpdater } from '../src/world/blockupdates.js';

const W = 1, L = 2;

/** Voxel map world with the real BlockUpdater + FluidSimulator wired like World does. */
class VoxelWorld {
  constructor({ fluidOptions = {}, loaded = null } = {}) {
    this.m = new Map();
    this.drops = [];
    this.effects = [];
    this.sets = 0;
    this.fluids = new FluidSimulator(this, {
      onDropItem: (id, n, x, y, z) => this.drops.push({ id, n, x, y, z }),
      onEffect: (name, x, y, z) => this.effects.push({ name, x, y, z }),
      isAreaLoaded: loaded,
      rng: () => 0.5,
      ...fluidOptions,
    });
    this.updater = new BlockUpdater(this, {
      fluids: this.fluids,
      onDropItem: (id, n, x, y, z) => this.drops.push({ id, n, x, y, z }),
      rng: () => 0.99,
    });
  }

  getBlock(x, y, z) {
    if (y < 0 || y > 255) return 0;
    return this.m.get(`${x},${y},${z}`) ?? 0;
  }

  setBlock(x, y, z, id, opts) {
    if (y < 0 || y > 255) return false;
    this.sets++;
    if (id === 0) this.m.delete(`${x},${y},${z}`);
    else this.m.set(`${x},${y},${z}`, id);
    if (!opts || opts.update !== false) this.updater.blockChanged(x, y, z);
    return true;
  }

  /** Place without any block updates (scene setup). */
  put(x, y, z, id) {
    if (id === 0) this.m.delete(`${x},${y},${z}`);
    else this.m.set(`${x},${y},${z}`, id);
  }

  fill(x0, y0, z0, x1, y1, z1, id) {
    for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) this.put(x, y, z, id);
  }

  ticks(n) {
    for (let i = 0; i < n; i++) this.fluids.tick();
  }

  /** Tick until no liquid update is pending (or maxTicks). Returns the ticks used. */
  settle(maxTicks = 2000) {
    let t = 0;
    while (this.fluids.pending > 0 && t < maxTicks) {
      this.fluids.tick();
      t++;
    }
    assert.equal(this.fluids.pending, 0, `liquids did not settle within ${maxTicks} ticks`);
    return t;
  }

  /** Liquid cells of a kind in a y layer: Map 'x,z' -> level. */
  layer(y, kind) {
    const out = new Map();
    for (const [k, id] of this.m) {
      const [x, yy, z] = k.split(',').map(Number);
      if (yy === y && LIQUID_KIND[id] === kind) out.set(`${x},${z}`, LIQUID_LEVEL[id]);
    }
    return out;
  }

  count(kind) {
    let n = 0;
    for (const id of this.m.values()) if (LIQUID_KIND[id] === kind) n++;
    return n;
  }
}

const level = (w, x, y, z) => {
  const id = w.getBlock(x, y, z);
  return LIQUID_KIND[id] ? LIQUID_LEVEL[id] : -1;
};

// ---------------------------------------------------------------------------------------------
// Water
// ---------------------------------------------------------------------------------------------

test('water on flat ground spreads into the Minecraft diamond of radius 7 with levels = distance', () => {
  const w = new VoxelWorld();
  w.fill(-12, 0, -12, 12, 0, 12, BLOCK.STONE);
  w.setBlock(0, 1, 0, BLOCK.WATER);
  assert.ok(w.fluids.isScheduled(0, 1, 0), 'a placed source is scheduled');
  w.ticks(TICK_DELAY[W] - 1);
  assert.equal(w.getBlock(1, 1, 0), 0, 'nothing happens before the 5-tick delay');
  w.ticks(1);
  assert.equal(level(w, 1, 1, 0), 1, 'first ring after 5 ticks');
  assert.equal(w.getBlock(2, 1, 0), 0);
  w.ticks(5);
  assert.equal(level(w, 2, 1, 0), 2, 'one block further every 5 ticks');
  w.settle();
  const layer = w.layer(1, W);
  assert.equal(layer.size, 113, '1 + 4 * (1 + 2 + ... + 7) cells');
  for (let z = -10; z <= 10; z++) {
    for (let x = -10; x <= 10; x++) {
      const d = Math.abs(x) + Math.abs(z);
      const got = layer.get(`${x},${z}`);
      if (d <= 7) assert.equal(got, d, `level at ${x},${z}`);
      else assert.equal(got, undefined, `no water at ${x},${z}`);
    }
  }
  assert.equal(w.count(W), 113, 'nothing anywhere else');
});

test('water flows toward the nearest drop, falls down as a column and spreads again at the bottom', () => {
  const w = new VoxelWorld();
  w.fill(-14, 0, -14, 14, 0, 14, BLOCK.STONE);      // ground
  w.fill(-6, 5, -3, 0, 5, 3, BLOCK.STONE);          // platform; its east edge at x = 0 is 2 blocks from the source
  w.setBlock(-1, 6, 0, BLOCK.WATER);
  w.settle();
  // on the platform the water runs straight east to the edge (nearest drop), not in a diamond
  assert.equal(level(w, 0, 6, 0), 1);
  assert.equal(level(w, 1, 6, 0), 2, 'one cell beyond the edge, over the drop');
  for (const [x, z] of [[-2, 0], [-1, 1], [-1, -1], [0, 1], [0, -1]]) assert.equal(w.getBlock(x, 6, z), 0, `dry at ${x},${z}`);
  // the falling column
  for (let y = 1; y <= 5; y++) assert.equal(level(w, 1, y, 0), 8, `falling at y=${y}`);
  // spreading on the ground around the landing cell (radius 7, levels 1..7), the platform does not block y = 1
  assert.equal(level(w, 2, 1, 0), 1);
  assert.equal(level(w, 1, 1, 3), 3);
  assert.equal(level(w, 8, 1, 0), 7);
  assert.equal(w.getBlock(9, 1, 0), 0);
  assert.equal(level(w, -6, 1, 0), 7);
  assert.equal(w.layer(1, W).size, 113);
});

test('two water sources create a new source between them (infinite water), not over air', () => {
  const w = new VoxelWorld();
  w.fill(-3, 0, -3, 5, 0, 3, BLOCK.STONE);
  w.fill(-3, 1, -3, 5, 1, 3, BLOCK.STONE);
  w.fill(0, 1, 0, 2, 1, 0, BLOCK.AIR);              // 3x1 trench
  w.setBlock(0, 1, 0, BLOCK.WATER);
  w.setBlock(2, 1, 0, BLOCK.WATER);
  w.settle();
  assert.equal(w.getBlock(1, 1, 0), BLOCK.WATER, 'middle became a source');
  // 2x2 pool with two diagonal sources -> all four are sources
  const p = new VoxelWorld();
  p.fill(-3, 0, -3, 3, 1, 3, BLOCK.STONE);
  p.fill(0, 1, 0, 1, 1, 1, BLOCK.AIR);
  p.setBlock(0, 1, 0, BLOCK.WATER);
  p.setBlock(1, 1, 1, BLOCK.WATER);
  p.settle();
  for (const [x, z] of [[0, 0], [1, 0], [0, 1], [1, 1]]) assert.equal(p.getBlock(x, 1, z), BLOCK.WATER, `${x},${z}`);
  // the same trench over air (no floor under the middle cell): the middle cell keeps flowing down
  const a = new VoxelWorld();
  a.fill(-3, 1, -3, 5, 1, 3, BLOCK.STONE);
  a.fill(0, 1, 0, 2, 1, 0, BLOCK.AIR);
  a.fill(0, 0, 0, 2, 0, 0, BLOCK.STONE);
  a.put(1, 0, 0, BLOCK.AIR);
  a.fill(-3, -1, -3, 5, -1, 3, BLOCK.AIR);
  a.setBlock(0, 1, 0, BLOCK.WATER);
  a.setBlock(2, 1, 0, BLOCK.WATER);
  a.ticks(60);
  assert.notEqual(a.getBlock(1, 1, 0), BLOCK.WATER, 'no source over a hole');
  assert.equal(level(a, 1, 0, 0), 8, 'falls into the hole');
});

test('removing the source dries the flowing water up completely', () => {
  const w = new VoxelWorld();
  w.fill(-12, 0, -12, 12, 0, 12, BLOCK.STONE);
  w.setBlock(0, 1, 0, BLOCK.WATER);
  w.settle();
  assert.equal(w.count(W), 113);
  w.setBlock(0, 1, 0, BLOCK.AIR);     // bucket scoop
  const t = w.settle();
  assert.equal(w.count(W), 0, 'all flowing water is gone');
  assert.ok(t >= 7 * 5, `drying takes time (${t} ticks)`);
  // a waterfall dries up from the top when its source is removed
  const f = new VoxelWorld();
  f.fill(-10, 0, -10, 10, 0, 10, BLOCK.STONE);
  f.fill(-1, 1, -1, 1, 9, 1, BLOCK.STONE);
  f.setBlock(0, 10, 0, BLOCK.WATER);
  f.settle();
  assert.ok(f.count(W) > 100);
  f.setBlock(0, 10, 0, BLOCK.AIR);
  f.settle();
  assert.equal(f.count(W), 0);
});

test('water washes away torches, flowers and crops with drops; sugar cane and solid blocks stop it', () => {
  const w = new VoxelWorld();
  w.fill(-9, 0, -9, 9, 0, 9, BLOCK.STONE);
  w.put(3, 1, 0, BLOCK.TORCH);
  w.put(0, 0, 3, BLOCK.DIRT);
  w.put(0, 1, 3, BLOCK.POPPY);
  w.put(-3, 0, 3, BLOCK.FARMLAND);
  w.put(-3, 1, 3, BLOCK.WHEAT_0);
  w.put(-2, 0, 0, BLOCK.SAND);
  w.put(-2, 0, -1, BLOCK.WATER);                     // the cane needs water next to its ground block
  w.put(-2, 1, -1, BLOCK.STONE);                     // covered: otherwise it is a drop the stream runs into
  w.put(-2, 1, 0, BLOCK.SUGAR_CANE);                 // blocks the flow like Minecraft's reeds (not washed away)
  w.put(0, 1, -2, BLOCK.COBBLESTONE);
  w.setBlock(0, 1, 0, BLOCK.WATER);
  w.settle();
  assert.equal(level(w, 3, 1, 0), 3, 'torch cell holds water now');
  assert.equal(level(w, 0, 1, 3), 3, 'poppy cell holds water now');
  assert.equal(level(w, -3, 1, 3), 6, 'wheat cell holds water now');
  assert.equal(w.getBlock(-2, 1, 0), BLOCK.SUGAR_CANE, 'sugar cane is not washed away');
  assert.equal(w.getBlock(0, 1, -2), BLOCK.COBBLESTONE);
  assert.equal(level(w, -3, 1, 0), 5, 'water flows around the cane (longer path: 5 instead of 3)');
  assert.equal(level(w, 0, 1, -3), 5, 'and around the cobblestone');
  const byId = (id) => w.drops.filter((d) => d.id === id);
  assert.equal(byId(BLOCK.TORCH).length, 1, 'torch dropped');
  assert.deepEqual([byId(BLOCK.TORCH)[0].x, byId(BLOCK.TORCH)[0].y, byId(BLOCK.TORCH)[0].z], [3.5, 1.5, 0.5]);
  assert.equal(byId(BLOCK.POPPY).length, 1, 'poppy dropped');
  assert.equal(byId(ITEM.WHEAT_SEEDS).length, 1, 'young wheat drops a seed');
  assert.equal(w.drops.length, 3);
  // a wall torch on a block in the stream is washed away too
  const t = new VoxelWorld();
  t.fill(-9, 0, -9, 9, 0, 9, BLOCK.STONE);
  t.put(3, 1, 1, BLOCK.STONE);
  t.put(3, 1, 0, BLOCK.WALL_TORCH_NORTH);           // attached to the stone at z = 1, pointing north
  t.setBlock(0, 1, 0, BLOCK.WATER);
  t.settle();
  assert.equal(level(t, 3, 1, 0), 3);
  assert.equal(t.drops.filter((d) => d.id === BLOCK.TORCH).length, 1);
});

// ---------------------------------------------------------------------------------------------
// Lava and lava/water interactions
// ---------------------------------------------------------------------------------------------

test('lava spreads 3 blocks in steps of 2 (levels 2, 4, 6) every 30 ticks', () => {
  const w = new VoxelWorld();
  w.fill(-8, 0, -8, 8, 0, 8, BLOCK.STONE);
  w.setBlock(0, 1, 0, BLOCK.LAVA);
  w.ticks(TICK_DELAY[L] - 1);
  assert.equal(w.getBlock(1, 1, 0), 0, 'nothing before 30 ticks');
  w.ticks(1);
  assert.equal(level(w, 1, 1, 0), 2);
  w.settle();
  const layer = w.layer(1, L);
  assert.equal(layer.size, 25, 'diamond of radius 3');
  for (const [k, l] of layer) {
    const [x, z] = k.split(',').map(Number);
    assert.equal(l, 2 * (Math.abs(x) + Math.abs(z)), `level at ${k}`);
  }
  assert.equal(w.getBlock(4, 1, 0), 0);
  // removing the lava source: the flow recedes (slowly, Minecraft's 4x delay with p = 3/4)
  w.setBlock(0, 1, 0, BLOCK.AIR);
  const t = w.settle(5000);
  assert.equal(w.count(L), 0);
  assert.ok(t > 3 * TICK_DELAY[L], `${t} ticks`);
});

test('water on a lava source makes obsidian, next to flowing lava cobblestone, with the fizz effect', () => {
  // water poured next to a lava source
  const w = new VoxelWorld();
  w.fill(-6, 0, -6, 6, 1, 6, BLOCK.STONE);
  w.fill(0, 1, 0, 3, 1, 0, BLOCK.AIR);               // 4x1 trench
  w.setBlock(0, 1, 0, BLOCK.LAVA);
  w.setBlock(1, 1, 0, BLOCK.WATER);
  assert.equal(w.getBlock(0, 1, 0), BLOCK.OBSIDIAN, 'lava source next to water: obsidian at once');
  assert.equal(w.effects.length, 1);
  assert.deepEqual(w.effects[0], { name: 'fizz', x: 0.5, y: 1.5, z: 0.5 });
  // water flowing onto a lava source from above (classic obsidian making)
  const a = new VoxelWorld();
  a.fill(-6, 0, -6, 6, 0, 6, BLOCK.STONE);
  a.fill(-6, 1, -6, 6, 1, 6, BLOCK.STONE);
  a.put(0, 1, 0, BLOCK.AIR);
  a.setBlock(0, 1, 0, BLOCK.LAVA);                   // lava pool in a 1x1 hole
  a.setBlock(-2, 2, 0, BLOCK.WATER);                 // water on the ground two blocks away flows over it
  a.settle();
  assert.equal(a.getBlock(0, 1, 0), BLOCK.OBSIDIAN);
  assert.ok(a.effects.some((e) => e.name === 'fizz'));
  // flowing lava touched by water -> cobblestone
  const c = new VoxelWorld();
  c.fill(-6, 0, -6, 12, 1, 6, BLOCK.STONE);
  c.fill(0, 1, 0, 9, 1, 0, BLOCK.AIR);               // 10x1 corridor
  c.setBlock(0, 1, 0, BLOCK.LAVA);
  c.settle();
  assert.deepEqual([1, 2, 3].map((x) => level(c, x, 1, 0)), [2, 4, 6]);
  c.setBlock(6, 1, 0, BLOCK.WATER);                  // water flows west and meets the lava front at x = 3
  c.settle();
  assert.equal(c.getBlock(3, 1, 0), BLOCK.COBBLESTONE, 'flowing lava + water -> cobblestone');
  assert.equal(c.getBlock(0, 1, 0), BLOCK.LAVA, 'the source is untouched');
  assert.equal(level(c, 4, 1, 0), 2, 'water stops at the cobblestone');
  assert.ok(c.effects.length >= 1);
});

test('lava flowing down onto water turns it into stone; water never flows into lava', () => {
  const w = new VoxelWorld();
  w.fill(-6, 0, -6, 6, 0, 6, BLOCK.STONE);
  w.fill(-6, 1, -6, 6, 1, 6, BLOCK.STONE);
  w.put(0, 1, 0, BLOCK.AIR);
  w.setBlock(0, 1, 0, BLOCK.WATER);                  // water pool cell
  w.fill(1, 2, 0, 1, 4, 0, BLOCK.STONE);
  w.setBlock(1, 5, 0, BLOCK.LAVA);                   // lava on a pillar next to the pool flows down onto it
  w.settle(5000);
  assert.equal(w.getBlock(0, 1, 0), BLOCK.STONE, 'the water under the lava fall became stone');
  assert.ok(w.effects.some((e) => e.name === 'fizz' && e.y === 1.5));
  // water next to flowing lava never replaces it: the lava solidifies instead
  const v = new VoxelWorld();
  v.fill(-6, 0, -6, 6, 0, 6, BLOCK.STONE);
  v.setBlock(0, 1, 0, BLOCK.LAVA);
  v.settle();
  v.setBlock(5, 1, 0, BLOCK.WATER);
  v.settle(5000);
  assert.equal(v.count(L) > 0, true, 'some lava survives behind the cobblestone wall');
  for (let x = -4; x <= 4; x++) {
    for (let z = -4; z <= 4; z++) {
      const id = v.getBlock(x, 1, z);
      if (LIQUID_KIND[id] !== L) continue;
      // no lava cell may touch water horizontally
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) assert.notEqual(LIQUID_KIND[v.getBlock(x + dx, 1, z + dz)], W);
    }
  }
});

test('a cactus breaks when lava flows beside it or liquid covers it (Minecraft CactusBlock)', () => {
  const w = new VoxelWorld();
  w.fill(-6, 0, -6, 6, 0, 6, BLOCK.SAND);
  w.put(2, 1, 0, BLOCK.CACTUS);
  w.put(-2, 1, 0, BLOCK.CACTUS);
  w.setBlock(0, 1, 0, BLOCK.LAVA);                     // lava reaches (1, 1, 0) and (-1, 1, 0) after 30 ticks
  w.ticks(TICK_DELAY[L] + 1);
  assert.equal(w.getBlock(2, 1, 0), 0, 'lava beside it');
  assert.equal(w.getBlock(-2, 1, 0), 0);
  assert.equal(w.drops.filter((d) => d.id === BLOCK.CACTUS).length, 2);
  const v = new VoxelWorld();
  v.fill(-6, 0, -6, 6, 0, 6, BLOCK.SAND);
  v.put(0, 1, 0, BLOCK.CACTUS);
  v.put(0, 2, 0, BLOCK.CACTUS);
  v.put(1, 3, 0, BLOCK.STONE);
  v.setBlock(0, 3, 0, BLOCK.WATER);                    // water on top of the stack
  assert.equal(v.getBlock(0, 2, 0), 0, 'liquid above');
  assert.equal(v.getBlock(0, 1, 0), BLOCK.CACTUS, 'the lower one only after the water reaches it');
});

test('lava burns plants it flows into (fizz, no drops)', () => {
  const w = new VoxelWorld();
  w.fill(-6, 0, -6, 6, 0, 6, BLOCK.DIRT);
  w.put(1, 1, 0, BLOCK.POPPY);
  w.setBlock(0, 1, 0, BLOCK.LAVA);
  w.settle();
  assert.equal(level(w, 1, 1, 0), 2);
  assert.equal(w.drops.length, 0);
  assert.ok(w.effects.some((e) => e.name === 'fizz' && e.x === 1.5));
});

// ---------------------------------------------------------------------------------------------
// flowVector
// ---------------------------------------------------------------------------------------------

test('flowVector points downstream, toward drops, and down along walls for falling water', () => {
  const w = new VoxelWorld();
  w.fill(-12, 0, -12, 12, 0, 12, BLOCK.STONE);
  w.setBlock(0, 1, 0, BLOCK.WATER);
  w.settle();
  const v = flowVector(w, 3, 1, 0);
  assert.ok(v[0] > 0.99 && Math.abs(v[2]) < 1e-9 && v[1] === 0, `east of the source flows east: ${v}`);
  const d = flowVector(w, 2, 1, 2, new Float64Array(3));
  assert.ok(Math.abs(d[0] - Math.SQRT1_2) < 1e-9 && Math.abs(d[2] - Math.SQRT1_2) < 1e-9, `diagonal: ${[...d]}`);
  assert.deepEqual([...flowVector(w, 0, 1, 0)], [0, 0, 0], 'a source surrounded symmetrically does not push');
  assert.deepEqual([...flowVector(w, 0, 5, 0)], [0, 0, 0], 'air');
  assert.deepEqual([...flowVector(w, 20, 1, 0)], [0, 0, 0], 'outside');
  // fractional coordinates are floored; the instance method accepts both call forms
  assert.deepEqual(w.fluids.flowVector(3.7, 1.2, 0.4), flowVector(w, 3, 1, 0));
  assert.deepEqual(w.fluids.flowVector(w, 3, 1, 0, [9, 9, 9]), flowVector(w, 3, 1, 0));
  // a falling column in a shaft pushes down (solid faces beside it)
  const f = new VoxelWorld();
  f.fill(-10, 0, -10, 10, 0, 10, BLOCK.STONE);
  f.fill(-1, 1, -1, 1, 9, 1, BLOCK.STONE);
  f.fill(0, 1, 0, 0, 9, 0, BLOCK.AIR);               // 1x1 shaft from y = 1 to 9
  f.setBlock(0, 10, 0, BLOCK.WATER);
  f.settle();
  assert.equal(level(f, 0, 5, 0), 8);
  const g = flowVector(f, 0, 5, 0);
  assert.ok(g[1] < -0.99, `falling water in a shaft: ${g}`);
  // flow toward a drop: water next to an edge flows over it
  const e = new VoxelWorld();
  e.fill(-6, 4, -6, 0, 4, 6, BLOCK.STONE);
  e.setBlock(-1, 5, 0, BLOCK.WATER);
  e.settle();
  const h = flowVector(e, 0, 5, 0);
  assert.ok(h[0] > 0.9, `toward the edge: ${h}`);
});

test('large merged floods settle and drain completely (no oscillation), lava pockets included', () => {
  const w = new VoxelWorld();
  w.fill(-25, 0, -25, 25, 0, 25, BLOCK.STONE);
  for (let i = -25; i <= 25; i++) {                       // basin walls
    w.put(i, 1, -25, BLOCK.STONE); w.put(i, 1, 25, BLOCK.STONE);
    w.put(-25, 1, i, BLOCK.STONE); w.put(25, 1, i, BLOCK.STONE);
  }
  w.fill(-3, 0, -3, 3, 0, 3, BLOCK.AIR);                  // a pit in the middle
  w.fill(-3, -1, -3, 3, -1, 3, BLOCK.STONE);
  for (let x = -20; x <= 20; x += 8) for (let z = -20; z <= 20; z += 8) w.setBlock(x, 1, z, BLOCK.WATER);
  w.setBlock(14, 1, -9, BLOCK.LAVA);
  const t1 = w.settle(4000);
  assert.ok(w.count(W) > 1000, `${w.count(W)} water cells`);
  for (let x = -20; x <= 20; x += 8) for (let z = -20; z <= 20; z += 8) w.setBlock(x, 1, z, BLOCK.AIR);
  const t2 = w.settle(6000);
  assert.equal(w.count(W) - w.layer(0, W).size, 0, 'only the pit (sources made by the infinite-water rule) may keep water');
  assert.ok(t1 < 1000 && t2 < 3000, `ticks ${t1} / ${t2}`);
  assert.equal(w.fluids.pending, 0);
});

// ---------------------------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------------------------

test('scheduled ticks are de-duplicated, budgeted (overdue first) and dropped with their chunk', () => {
  const w = new VoxelWorld({ fluidOptions: { maxUpdatesPerTick: 5 } });
  const f = w.fluids;
  w.fill(0, 0, 0, 47, 0, 31, BLOCK.STONE);
  for (let x = 0; x < 20; x++) w.put(x, 1, 0, BLOCK.WATER_FLOWING_7);   // fed by nothing: dries up
  for (let x = 0; x < 20; x++) assert.ok(f.schedule(x, 1, 0, 5));
  assert.equal(f.schedule(0, 1, 0, 1), false, 'already scheduled: keeps the earlier tick');
  assert.equal(f.pending, 20);
  w.ticks(4);
  assert.equal(w.getBlock(0, 1, 0), BLOCK.WATER_FLOWING_7);
  w.ticks(1);
  assert.equal(f.counters.updates, 5, 'budget of 5 updates per tick');
  w.ticks(1);
  assert.equal(f.counters.updates, 10, 'leftovers run in the next ticks');
  w.settle();
  for (let x = 0; x < 20; x++) assert.equal(w.getBlock(x, 1, 0), 0, `x=${x} dried`);
  // dropChunk forgets the chunk's ticks
  w.put(40, 1, 0, BLOCK.WATER_FLOWING_3);
  f.schedule(40, 1, 0, 3);
  f.schedule(3, 1, 3, 3);
  const before = f.pending;
  f.dropChunk(2, 0);
  assert.equal(f.pending, before - 1);
  assert.equal(f.isScheduled(40, 1, 0), false);
  w.ticks(5);
  assert.equal(w.getBlock(40, 1, 0), BLOCK.WATER_FLOWING_3, 'dropped tick never ran');
  f.clear();
  assert.equal(f.pending, 0);
});

test('updates whose neighbourhood is not loaded are deferred until it is', () => {
  let loaded = false;
  const w = new VoxelWorld({ loaded: () => loaded });
  w.fill(-8, 0, -8, 8, 0, 8, BLOCK.STONE);
  w.setBlock(0, 1, 0, BLOCK.WATER);
  w.ticks(40);
  assert.equal(w.getBlock(1, 1, 0), 0, 'nothing flows while the area is not loaded');
  assert.ok(w.fluids.counters.deferred >= 1);
  assert.equal(w.fluids.pending, 1, 'still scheduled');
  loaded = true;
  w.settle();
  assert.equal(w.layer(1, W).size, 113);
});

test('scanChunk re-schedules flowing cells and unsettled sources of a loaded chunk only', () => {
  const w = new VoxelWorld();
  const blocks = new Uint8Array(65536);
  const at = (x, y, z) => (y << 8) | (z << 4) | x;
  for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) blocks[at(x, 0, z)] = BLOCK.STONE;
  // a settled pool (sources surrounded by stone), a source next to air, a flowing cell, a border source
  for (let x = 2; x <= 4; x++) {
    blocks[at(x, 1, 2)] = BLOCK.WATER;
    blocks[at(x, 1, 1)] = BLOCK.STONE;
    blocks[at(x, 1, 3)] = BLOCK.STONE;
  }
  blocks[at(1, 1, 2)] = BLOCK.STONE;
  blocks[at(5, 1, 2)] = BLOCK.STONE;
  blocks[at(8, 1, 8)] = BLOCK.WATER;                 // air around: unsettled
  blocks[at(10, 1, 10)] = BLOCK.WATER_FLOWING_4;
  blocks[at(0, 1, 12)] = BLOCK.WATER;                // at the chunk border (x = 0): neighbour x = -1 outside
  for (const [dx, dz] of [[1, 0], [0, 1], [0, -1]]) blocks[at(dx, 1, 12 + dz)] = BLOCK.STONE;
  const n = w.fluids.scanChunk(0, 0, blocks, 1);
  assert.equal(n, 3, 'unsettled source, flowing cell and the border source (its outside neighbour reads as air)');
  assert.ok(w.fluids.isScheduled(8, 1, 8));
  assert.ok(w.fluids.isScheduled(10, 1, 10));
  assert.ok(!w.fluids.isScheduled(3, 1, 2), 'settled pool is left alone');
  // with an isAreaLoaded hook, neighbours in unloaded chunks are skipped
  const u = new VoxelWorld({ loaded: (x) => x >= 0 });
  assert.equal(u.fluids.scanChunk(0, 0, blocks, 1), 2);
  assert.ok(!u.fluids.isScheduled(0, 1, 12));
});
