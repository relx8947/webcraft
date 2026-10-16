// Benchmark of the entity / particle simulation (Node): node tools/entities-bench.mjs
// Measures EntityManager.update with many falling / resting / merging items and ParticleSystem.update with
// a full pool, on a flat test world whose getBlock goes through a Map lookup like a real chunked world.
import { EntityManager } from '../src/game/entities.js';
import { ParticleSystem } from '../src/game/particles.js';
import { BLOCK } from '../src/world/registry.js';
import { Inventory } from '../src/game/inventory.js';

/** Chunked world stand-in: Map of numeric chunk keys -> Uint8Array(65536), flat stone below y = 64. */
class ChunkWorld {
  constructor() {
    this.chunks = new Map();
  }
  _chunk(cx, cz) {
    const k = (cx & 0x7fff) * 32768 + (cz & 0x7fff);   // Smi key: no boxing in Map.get
    let c = this.chunks.get(k);
    if (!c) {
      c = new Uint8Array(65536);
      for (let y = 0; y < 64; y++) c.fill(BLOCK.STONE, y << 8, (y + 1) << 8);
      this.chunks.set(k, c);
    }
    return c;
  }
  getBlock(x, y, z) {
    if (y < 0 || y > 255) return 0;
    return this._chunk(x >> 4, z >> 4)[(y << 8) | ((z & 15) << 4) | (x & 15)];
  }
  getLight() { return 0xf0; }
  isChunkGenerated() { return true; }
}

function bench(name, frames, fn) {
  for (let i = 0; i < 30; i++) fn();     // warm-up
  const t = [];
  for (let i = 0; i < frames; i++) {
    const a = performance.now();
    fn();
    t.push(performance.now() - a);
  }
  t.sort((p, q) => p - q);
  const avg = t.reduce((p, q) => p + q, 0) / t.length;
  console.log(`${name.padEnd(58)} avg ${avg.toFixed(3)} ms  p95 ${t[Math.floor(frames * 0.95)].toFixed(3)} ms`);
}

const world = new ChunkWorld();
const player = { x: 0.5, y: 64, z: 0.5, height: 1.8, dead: false, mode: 'survival', inventory: new Inventory() };
const game = { world, player: null, audio: null, particles: null };

// 1. 1000 items raining down (always awake), distinct ids so they do not merge
{
  const em = new EntityManager(game);
  const ids = [BLOCK.STONE, BLOCK.DIRT, BLOCK.SAND, BLOCK.GRAVEL, BLOCK.OAK_LOG, BLOCK.GLASS, BLOCK.COBBLESTONE, BLOCK.OAK_PLANKS];
  const respawn = () => {
    em.clear();
    for (let i = 0; i < 1000; i++) em.spawnItem({ id: ids[i % 8], count: 64 }, (i % 40) * 2 - 40, 200 + (i % 7), Math.floor(i / 40) * 2 - 25, 0, 0, 0);
  };
  respawn();
  let n = 0;
  bench('EntityManager.update: 1000 falling items', 300, () => {
    if (++n % 200 === 0) respawn();
    em.update(1 / 60);
  });
}

// 2. 3000 resting items (sleeping) + pickup checks
{
  const em = new EntityManager({ ...game, player });
  for (let i = 0; i < 3000; i++) em.spawnItem({ id: BLOCK.STONE + (i % 2), count: 64 }, (i % 60) - 30.5, 64, Math.floor(i / 60) - 25.5 + 4, 0, 0, 0);
  for (let i = 0; i < 60; i++) em.update(1 / 60);
  bench(`EntityManager.update: ${em.count} resting items`, 300, () => em.update(1 / 60));
}

// 3. merge storm: /fill ... destroy of 16x8x16 stone -> 2048 cobblestone drops in one frame
{
  const em = new EntityManager(game);
  for (let y = 0; y < 8; y++) for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) em.popItem(BLOCK.COBBLESTONE, 1, x + 0.5, 64.5 + y, z + 0.5);
  const t0 = performance.now();
  let frames = 0;
  let worst = 0;
  while (frames < 600) {
    const a = performance.now();
    em.update(1 / 60);
    worst = Math.max(worst, performance.now() - a);
    frames++;
    if (em.count <= 64) break;
  }
  console.log(`${'merge storm: 2048 drops'.padEnd(58)} ${frames} frames (${(frames / 60).toFixed(1)} s sim) -> ${em.count} stacks, worst frame ${worst.toFixed(2)} ms, total ${(performance.now() - t0).toFixed(0)} ms`);
}

// 4. full particle pool
{
  const ps = new ParticleSystem({ world }, { seed: 1 });
  const refill = () => {
    while (ps.count < ps.capacity - 64) ps.spawnBlockBreak(Math.floor(Math.random() * 40) - 20, 64, Math.floor(Math.random() * 40) - 20, BLOCK.DIRT);
  };
  refill();
  bench(`ParticleSystem.update + getRenderData: ~${ps.count} particles`, 300, () => {
    refill();
    ps.update(1 / 60);
    ps.getRenderData();
  });
}

// 4b. ambient display ticks (1334 random block reads per 20 Hz tick) around a player with torches nearby
{
  const w2 = new ChunkWorld();
  for (let i = 0; i < 40; i++) {
    const c = w2._chunk((i * 7) % 5 - 2, (i * 3) % 5 - 2);
    c[(64 << 8) | (((i * 5) & 15) << 4) | ((i * 11) & 15)] = BLOCK.TORCH;
  }
  const amb = new ParticleSystem({ world: w2, player: { x: 0.5, y: 64, z: 0.5, eyeHeight: 1.62, dead: false } }, { seed: 3 });
  const plain = new ParticleSystem({ world: w2, player: null }, { seed: 3 });
  bench('ParticleSystem.update with ambient display ticks', 600, () => amb.update(1 / 60));
  bench('ParticleSystem.update without (same world)', 600, () => plain.update(1 / 60));
  console.log(`${'  ambient particles alive'.padEnd(58)} ${amb.count}`);
}

// 5. allocation volume of a steady-state frame, measured with V8's sampling heap profiler (counts garbage
//    collected by minor GCs too — heapUsed deltas hide it): 500 items around a moving player (third-person
//    avatar on), ambient particles from a torch, render list + particle data.
{
  const { Session } = await import('node:inspector/promises');
  const w = new ChunkWorld();
  w._chunk(0, 0)[(64 << 8) | (3 << 4) | 5] = BLOCK.TORCH;
  const p = { ...player, yaw: 0, pitch: 0, eyeHeight: 1.62 };
  const hand = { itemId: 0, swing: 0 };
  const g = { world: w, player: p, perspective: 1, interaction: { getHandState: () => hand } };
  const em = new EntityManager(g);
  for (let i = 0; i < 500; i++) em.spawnItem({ id: BLOCK.STONE + (i % 3), count: 1 }, (i % 25) * 2 - 25, 64 + (i % 5), Math.floor(i / 25) * 2 + 10, 0, 0, 0);
  const ps = new ParticleSystem(g, { seed: 2 });
  let list = [];
  const own = () => { p.x += 0.001; em.update(1 / 60); ps.update(1 / 60); list = em.getRenderList(); ps.getRenderData(); };
  const reset = () => { p.x += 0.001; em.update(1 / 60); ps.update(1 / 60); list.length = 0; em.getRenderList(list); ps.getRenderData(); };
  const session = new Session();
  session.connect();
  await session.post('HeapProfiler.enable');
  for (const [name, frame] of [['getRenderList() (manager-owned array)', own], ['list.length = 0; getRenderList(list)', reset]]) {
    for (let i = 0; i < 2000; i++) frame();
    await session.post('HeapProfiler.startSampling', { samplingInterval: 64, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
    for (let i = 0; i < 2000; i++) frame();
    const { profile } = await session.post('HeapProfiler.stopSampling');
    let total = 0;
    const walk = (n) => { total += n.selfSize; n.children.forEach(walk); };
    walk(profile.head);
    console.log(`${('allocated per frame, ' + name).padEnd(58)} ${(total / 2000).toFixed(0)} B`);
  }
  session.disconnect();
}
