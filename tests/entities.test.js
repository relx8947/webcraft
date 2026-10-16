// Entities, particles and entity-renderer geometry tests (node:test). Run: node --test tests/entities.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EntityManager, Entity, ItemEntity, FallingBlockEntity, PrimedTntEntity,
  ITEM_DESPAWN_TIME, MAX_ITEM_ENTITIES, SOFT_ITEM_CAP, COLLECT_TIME, TNT_FUSE,
} from '../src/game/entities.js';
import {
  ParticleSystem, PARTICLE_STRIDE, PROCEDURAL_LAYER, STYLE, FULL_BRIGHT, DEFAULT_PARTICLE_CAPACITY,
  particleLayerFor, particleColorFor,
} from '../src/game/particles.js';
import {
  buildSpriteModel, buildCubeModel, buildArmModel, buildCactusModel, buildCrossModel, buildTorchModel,
  buildBoxModel, computeHandPose, computePlayerPose, renderAmount, paintSkinTexture, PLAYER_PARTS,
} from '../src/render/entityrenderer.js';
import { PlayerAvatar } from '../src/game/entities.js';
import { Inventory, makeStack } from '../src/game/inventory.js';
import { BLOCK, ITEM, FACE_LAYERS, TEXTURE_INDEX, maxStackSize } from '../src/world/registry.js';
import { DEFAULT_TINTS } from '../src/config.js';

// ---------------------------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------------------------

/** Typed-array world: x,z in [-32,32), y in [0,128); outside: `fill` below `ground`, air above. */
class FakeWorld {
  constructor({ ground = 64, fill = BLOCK.STONE } = {}) {
    this.ground = ground;
    this.fillId = fill;
    this.data = new Uint8Array(64 * 128 * 64);
    this.light = 0xf0;
    this.lightFn = null;
    this.generated = null;   // optional (cx, cz) => bool
    for (let y = 0; y < Math.min(ground, 128); y++) {
      for (let z = 0; z < 64; z++) for (let x = 0; x < 64; x++) this.data[(y * 64 + z) * 64 + x] = fill;
    }
  }
  _i(x, y, z) {
    if (x < -32 || x >= 32 || z < -32 || z >= 32 || y < 0 || y >= 128) return -1;
    return (y * 64 + (z + 32)) * 64 + (x + 32);
  }
  getBlock(x, y, z) {
    if (y < 0 || y > 255) return 0;
    const i = this._i(x, y, z);
    if (i >= 0) return this.data[i];
    return y < this.ground ? this.fillId : 0;
  }
  setBlock(x, y, z, id) {
    const i = this._i(x, y, z);
    if (i < 0) return false;
    this.data[i] = id;
    return true;
  }
  set(x, y, z, id) { this.data[this._i(x, y, z)] = id; }
  fill(x0, y0, z0, x1, y1, z1, id) {
    for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) this.set(x, y, z, id);
  }
  getLight(x, y, z) { return this.lightFn ? this.lightFn(x, y, z) : this.light; }
  isChunkGenerated(cx, cz) { return this.generated ? this.generated(cx, cz) : true; }
}

function makePlayer(x = 0.5, y = 64, z = 0.5, mode = 'survival') {
  return {
    x, y, z, vx: 0, vy: 0, vz: 0, yaw: 0, pitch: 0, width: 0.6, height: 1.8, eyeHeight: 1.62,
    dead: false, mode, inventory: new Inventory(), damageTaken: [],
    getAABB(out = {}) {
      out.minX = this.x - 0.3; out.minY = this.y; out.minZ = this.z - 0.3;
      out.maxX = this.x + 0.3; out.maxY = this.y + 1.8; out.maxZ = this.z + 0.3;
      return out;
    },
    damage(amount, cause) { this.damageTaken.push([amount, cause]); return true; },
  };
}

function makeGame(world = new FakeWorld(), player = null) {
  const game = {
    world, player,
    sounds: [],
    particleCalls: [],
    audio: { play(name, opts) { game.sounds.push([name, opts]); }, playBlock(kind, mat) { game.sounds.push([kind, mat]); } },
    particles: {
      spawnSplash(...a) { game.particleCalls.push(['splash', ...a]); },
      spawnSmoke(...a) { game.particleCalls.push(['smoke', ...a]); },
      spawnExplosion(...a) { game.particleCalls.push(['explosion', ...a]); },
    },
  };
  return game;
}

/** Deterministic rng for the manager. */
function seq(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function run(mgr, seconds, dt = 1 / 60) {
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) mgr.update(dt);
}

// ---------------------------------------------------------------------------------------------
// ItemEntity physics
// ---------------------------------------------------------------------------------------------

test('a dropped item falls and rests on the ground', () => {
  const game = makeGame();
  const em = new EntityManager(game, { rng: seq(3) });
  const e = em.spawnItem(makeStack(BLOCK.DIRT, 3), 0.5, 70, 0.5, 0, 0, 0);
  assert.ok(e instanceof ItemEntity);
  run(em, 3);
  assert.ok(Math.abs(e.y - 64) < 1e-6, `y = ${e.y}`);
  assert.equal(e.onGround, true);
  assert.equal(e.vy, 0);
  assert.ok(Math.abs(e.x - 0.5) < 1e-9 && Math.abs(e.z - 0.5) < 1e-9);
  assert.equal(em.count, 1);
});

test('falling speed approaches the Minecraft item terminal velocity (~39 b/s)', () => {
  const game = makeGame(new FakeWorld({ ground: 0 }));
  const em = new EntityManager(game);
  const e = em.spawnItem(makeStack(BLOCK.DIRT), 0.5, 4000, 0.5, 0, 0, 0);
  run(em, 15, 0.05);
  assert.ok(e.vy < -37 && e.vy > -40.5, `vy = ${e.vy}`);
});

test('physics is frame-rate independent', () => {
  const ys = [1 / 20, 1 / 60, 1 / 144].map((dt) => {
    const em = new EntityManager(makeGame());
    const e = em.spawnItem(makeStack(BLOCK.DIRT), 0.5, 70, 0.5, 0, 6, 0);
    run(em, 0.5, dt);
    return e.y;
  });
  assert.ok(Math.abs(ys[0] - ys[2]) < 0.15 && Math.abs(ys[1] - ys[2]) < 0.05, ys.join(' '));
});

test('spawning without a velocity pops the item like Minecraft (±0.1, 0.2, ±0.1 b/tick)', () => {
  const em = new EntityManager(makeGame());
  for (let i = 0; i < 20; i++) {
    const e = em.spawnItem(makeStack(BLOCK.STONE), 0.5, 65, 0.5);
    assert.equal(e.vy, 4);
    assert.ok(Math.abs(e.vx) <= 2 && Math.abs(e.vz) <= 2);
    assert.ok(e.seed >= 0 && e.seed < 1);
    assert.equal(e.pickupDelay, 0.5);
  }
});

test('ground friction stops items quickly, ice lets them slide', () => {
  const slide = (ground) => {
    const w = new FakeWorld();
    w.fill(-32, 63, -32, 31, 63, 31, ground);
    const em = new EntityManager(makeGame(w));
    const e = em.spawnItem(makeStack(BLOCK.DIRT), -20, 64, 0.5, 6, 0, 0);
    run(em, 3);
    return e.x + 20;
  };
  // Minecraft: 0.3 b/tick on stone (friction 0.6·0.98 per tick) slides ~0.7 blocks, on ice ~7.6
  const stone = slide(BLOCK.STONE), ice = slide(BLOCK.ICE);
  assert.ok(stone > 0.4 && stone < 0.8, `stone ${stone}`);
  assert.ok(ice > 6 && ice < 8, `ice ${ice}`);
});

test('items inside a solid block are pushed out toward the closest free side', () => {
  // Inside a stone block whose only open side is up: pops up and lands on top.
  const w = new FakeWorld();
  w.fill(-1, 64, -1, 1, 64, 1, BLOCK.STONE);
  const em = new EntityManager(makeGame(w), { rng: seq(5) });
  const up = em.spawnItem(makeStack(BLOCK.DIRT), 0.5, 64.3, 0.5, 0, 0, 0);
  run(em, 2);
  assert.ok(Math.abs(up.y - 65) < 1e-6, `y = ${up.y}`);
  // A lone block: the closest free side wins (here a horizontal one, like Minecraft).
  const w1 = new FakeWorld();
  w1.set(0, 64, 0, BLOCK.STONE);
  const em1 = new EntityManager(makeGame(w1), { rng: seq(5) });
  const side = em1.spawnItem(makeStack(BLOCK.DIRT), 0.5, 64.3, 0.2, 0, 0, 0);
  run(em1, 2);
  assert.ok(side.z < 0 && Math.abs(side.y - 64) < 1e-6, `${side.x} ${side.y} ${side.z}`);
  // Walled in on every side but the east one, close to it: pushed east.
  const w2 = new FakeWorld();
  w2.fill(-2, 64, -2, 2, 66, 2, BLOCK.STONE);
  w2.set(1, 64, 0, 0);
  const em2 = new EntityManager(makeGame(w2), { rng: seq(6) });
  const east = em2.spawnItem(makeStack(BLOCK.DIRT), 0.85, 64.1, 0.5, 0, 0, 0);
  run(em2, 1);
  assert.ok(east.x > 1.1 && east.x < 2, `x = ${east.x}`);
  assert.equal(w2.getBlock(Math.floor(east.x), Math.floor(east.y), Math.floor(east.z)), 0);
});

test('items float up in water and stay near the surface', () => {
  const w = new FakeWorld({ ground: 60 });
  w.fill(-3, 60, -3, 3, 66, 3, BLOCK.WATER);   // surface at 66 + 14/16
  const game = makeGame(w);
  const em = new EntityManager(game);
  const e = em.spawnItem(makeStack(BLOCK.DIRT), 0.5, 61, 0.5, 0, 0, 0);
  run(em, 8);
  assert.ok(e.y > 63, `rising: y = ${e.y}`);
  run(em, 25);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < 600; i++) {
    em.update(1 / 60);
    lo = Math.min(lo, e.y); hi = Math.max(hi, e.y);
  }
  const surface = 66 + 14 / 16;
  assert.ok(lo > surface - 0.6 && hi < surface, `bobbing between ${lo} and ${hi}`);
});

test('items falling into water splash; lava burns them', () => {
  const w = new FakeWorld({ ground: 60 });
  w.fill(-3, 60, -3, 3, 62, 3, BLOCK.WATER);
  w.fill(10, 60, 10, 12, 62, 12, BLOCK.LAVA);
  const game = makeGame(w);
  const em = new EntityManager(game);
  em.spawnItem(makeStack(BLOCK.DIRT), 0.5, 70, 0.5, 0, 0, 0);
  run(em, 2);
  assert.ok(game.particleCalls.some((c) => c[0] === 'splash'), 'splash particles');
  assert.ok(game.sounds.some((s) => s[0] === 'splash'), 'splash sound');
  const burnt = em.spawnItem(makeStack(BLOCK.DIRT), 11.5, 64, 11.5, 0, 0, 0);
  run(em, 1);
  assert.equal(burnt.removed, true);
  assert.ok(game.particleCalls.some((c) => c[0] === 'smoke'), 'smoke when burning');
});

test('cactus destroys items that touch it (5 ticks), neighbours survive', () => {
  const w = new FakeWorld();
  w.set(0, 64, 0, BLOCK.CACTUS);
  const em = new EntityManager(makeGame(w));
  const onTop = em.spawnItem(makeStack(BLOCK.DIRT), 0.5, 66, 0.5, 0, 0, 0);
  const beside = em.spawnItem(makeStack(BLOCK.DIRT), 2.5, 64, 0.5, 0, 0, 0);
  run(em, 0.3);
  assert.equal(onTop.removed, false, 'still falling');
  run(em, 1);
  assert.equal(onTop.removed, true);
  assert.equal(beside.removed, false);
  const thrown = em.spawnItem(makeStack(BLOCK.DIRT), 2.5, 64.2, 0.5, -6, 0, 0);   // slides into the cactus side
  run(em, 1);
  assert.equal(thrown.removed, true);
});

test('items despawn after 300 s and die below y = -64', () => {
  const em = new EntityManager(makeGame());
  const e = em.spawnItem(makeStack(BLOCK.DIRT), 0.5, 64, 0.5, 0, 0, 0);
  run(em, ITEM_DESPAWN_TIME - 1, 0.1);
  assert.equal(e.removed, false);
  run(em, 1.5, 0.1);
  assert.equal(e.removed, true);
  assert.equal(em.count, 0);
  assert.equal(em.list.length, 0);

  const em2 = new EntityManager(makeGame(new FakeWorld({ ground: 0 })));
  const v = em2.spawnItem(makeStack(BLOCK.DIRT), 0.5, 10, 0.5, 0, 0, 0);
  run(em2, 6);
  assert.equal(v.removed, true);
});

test('entities in chunks that are not loaded are frozen', () => {
  const w = new FakeWorld();
  w.generated = () => false;
  const em = new EntityManager(makeGame(w));
  const e = em.spawnItem(makeStack(BLOCK.DIRT), 0.5, 80, 0.5, 0, 0, 0);
  run(em, 2);
  assert.equal(e.y, 80);
  w.generated = null;
  run(em, 3);
  assert.ok(Math.abs(e.y - 64) < 1e-6);
});

test('light is sampled at floor(x), floor(y + 0.1), floor(z) every update', () => {
  const w = new FakeWorld();
  w.lightFn = (x, y) => ((x & 3) << 4) | ((y - 60) & 15);
  const em = new EntityManager(makeGame(w));
  const e = em.spawnItem(makeStack(BLOCK.DIRT), 2.5, 64, 7.5, 0, 0, 0);
  run(em, 1);
  assert.equal(e.light, ((2 & 3) << 4) | 4);
  assert.equal(e.getRenderItem().light, e.light);
});

// ---------------------------------------------------------------------------------------------
// Pickup
// ---------------------------------------------------------------------------------------------

test('pickup respects the delay, adds to the inventory, pops and flies into the player', () => {
  const player = makePlayer(0.5, 64, 0.5);
  const game = makeGame(new FakeWorld(), player);
  const em = new EntityManager(game, { rng: seq(9) });
  const e = em.spawnItem(makeStack(BLOCK.COBBLESTONE, 5), 1.2, 64, 0.5, 0, 0, 0, 0.5);
  run(em, 0.3);
  assert.equal(player.inventory.count(BLOCK.COBBLESTONE), 0, 'still in the pickup delay');
  run(em, 0.3);
  assert.equal(player.inventory.count(BLOCK.COBBLESTONE), 5);
  assert.equal(e.collecting, true);
  const pop = game.sounds.find((s) => s[0] === 'pop');
  assert.ok(pop, 'pop sound');
  assert.equal(pop[1].volume, 0.2);
  assert.ok(pop[1].pitch >= 0.5 && pop[1].pitch <= 2);
  run(em, COLLECT_TIME + 0.05);
  assert.equal(e.removed, true);
  assert.equal(em.count, 0);
  assert.equal(player.inventory.count(BLOCK.COBBLESTONE), 5, 'picked up exactly once');
});

test('picked-up items fly (ease-in) to the midpoint of the player\'s feet and eyes, like ItemPickupParticle', () => {
  for (const eyeHeight of [1.62, 1.27]) {
    const player = makePlayer(0.5, 64, 0.5);
    player.eyeHeight = eyeHeight;
    const em = new EntityManager(makeGame(new FakeWorld(), player));
    const e = em.spawnItem(makeStack(BLOCK.DIRT), 1.5, 64, 0.5, 0, 0, 0, 0);
    e._sleep = 1e9;                       // resting: no physics before the pickup
    em.update(1e-4);
    assert.equal(e.collecting, true);
    const sx = e.x, sy = e.y;
    em.update(COLLECT_TIME * 0.5);        // t = 0.5 -> ease-in factor 0.25
    const ty = 64 + eyeHeight / 2;
    assert.ok(Math.abs(e.y - (sy + (ty - sy) * 0.25)) < 0.01, `quarter of the way up at t = 0.5 (y = ${e.y})`);
    assert.ok(Math.abs(e.x - (sx + (0.5 - sx) * 0.25)) < 0.01, 'quarter of the way in');
    em.update(COLLECT_TIME * 0.499);
    assert.ok(Math.abs(e.y - ty) < 0.01, `ends at (feet + eyes) / 2 = ${ty} (y = ${e.y})`);
    em.update(COLLECT_TIME * 0.01);
    assert.equal(e.removed, true);
  }
});

test('pickup reach: within 1.5 blocks horizontally and the player box grown by 0.5 vertically', () => {
  const cases = [
    [1.4, 0, 0, true], [0, 0, 1.45, true], [1.0, 0, 1.0, true], [1.7, 0, 0, false], [1.2, 0, 1.2, false],
    [0, -0.6, 0, true], [0, -0.9, 0, false], [0, 2.2, 0, true], [0, 2.4, 0, false],
  ];
  for (const [dx, dy, dz, expect] of cases) {
    const player = makePlayer(0.5, 64, 0.5);
    const w = new FakeWorld();
    const em = new EntityManager(makeGame(w, player));
    const e = em.spawnItem(makeStack(BLOCK.DIRT), 0.5 + dx, 64 + dy, 0.5 + dz, 0, 0, 0, 0);
    // keep the item where it is (resting state, no physics step) for this geometric check
    e._sleep = 1e9;
    em.update(1 / 60);
    assert.equal(player.inventory.count(BLOCK.DIRT) > 0, expect, `offset ${dx},${dy},${dz}`);
  }
});

test('only what fits is taken; the rest stays on the ground', () => {
  const player = makePlayer(0.5, 64, 0.5);
  const inv = player.inventory;
  for (let i = 0; i < 36; i++) inv.set(i, makeStack(BLOCK.STONE, 64));
  inv.set(5, makeStack(BLOCK.DIRT, 60));
  const game = makeGame(new FakeWorld(), player);
  const em = new EntityManager(game);
  const e = em.spawnItem(makeStack(BLOCK.DIRT, 10), 1, 64, 0.5, 0, 0, 0, 0);
  em.update(1 / 60);
  assert.equal(inv.get(5).count, 64);
  assert.equal(e.removed, false);
  assert.equal(e.collecting, false);
  assert.equal(e.count, 6);
  const ghost = em.list.find((x) => x !== e);
  assert.ok(ghost && ghost.collecting && ghost.count === 4, 'a ghost copy of the taken part flies in');
  run(em, 0.5);
  assert.equal(e.count, 6, 'nothing more fits');
  assert.equal(em.count, 1);
});

test('creative players swallow items that do not fit; dead players pick up nothing', () => {
  const creative = makePlayer(0.5, 64, 0.5, 'creative');
  for (let i = 0; i < 36; i++) creative.inventory.set(i, makeStack(BLOCK.STONE, 64));
  const em = new EntityManager(makeGame(new FakeWorld(), creative));
  const e = em.spawnItem(makeStack(BLOCK.DIRT, 3), 1, 64, 0.5, 0, 0, 0, 0);
  em.update(1 / 60);
  assert.equal(e.collecting, true);

  const dead = makePlayer(0.5, 64, 0.5);
  dead.dead = true;
  const em2 = new EntityManager(makeGame(new FakeWorld(), dead));
  const d = em2.spawnItem(makeStack(BLOCK.DIRT, 3), 1, 64, 0.5, 0, 0, 0, 0);
  run(em2, 1);
  assert.equal(d.collecting, false);
  assert.equal(dead.inventory.count(BLOCK.DIRT), 0);
});

// ---------------------------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------------------------

test('identical nearby stacks merge (larger absorbs smaller, delay max, age min)', () => {
  const em = new EntityManager(makeGame());
  const a = em.spawnItem(makeStack(BLOCK.DIRT, 10), 0.5, 64, 0.5, 0, 0, 0, 0.5);
  const b = em.spawnItem(makeStack(BLOCK.DIRT, 20), 1.2, 64, 0.5, 0, 0, 0, 1.5);
  a.age = 5;
  run(em, 2.2);
  assert.equal(em.count, 1);
  assert.equal(a.removed, true);
  assert.equal(b.count, 30);
  assert.ok(Math.abs(b.x - 1.2) < 1e-9, 'the bigger stack stays where it was');
  assert.ok(b.age < 5, 'age = min');
});

test('stacks do not merge when too far apart, different, full or unstackable', () => {
  const em = new EntityManager(makeGame());
  em.spawnItem(makeStack(BLOCK.DIRT, 10), 0.5, 64, 0.5, 0, 0, 0);
  em.spawnItem(makeStack(BLOCK.DIRT, 10), 1.6, 64, 0.5, 0, 0, 0);          // 1.1 apart: gap 0.85 > 0.5
  em.spawnItem(makeStack(BLOCK.STONE, 10), 0.5, 64, 4.5, 0, 0, 0);
  em.spawnItem(makeStack(BLOCK.COBBLESTONE, 10), 0.6, 64, 4.5, 0, 0, 0);   // different item
  em.spawnItem(makeStack(BLOCK.SAND, 40), 0.5, 64, 8.5, 0, 0, 0);
  em.spawnItem(makeStack(BLOCK.SAND, 30), 0.6, 64, 8.5, 0, 0, 0);          // 70 > 64
  em.spawnItem(makeStack(ITEM.IRON_PICKAXE, 1), 4.5, 64, 0.5, 0, 0, 0);
  em.spawnItem(makeStack(ITEM.IRON_PICKAXE, 1), 4.6, 64, 0.5, 0, 0, 0);    // max stack 1
  em.spawnItem(makeStack(ITEM.DIAMOND_SWORD, 1, 5), 8.5, 64, 0.5, 0, 0, 0);
  em.spawnItem(makeStack(ITEM.DIAMOND_SWORD, 1, 0), 8.6, 64, 0.5, 0, 0, 0);
  run(em, 5);
  assert.equal(em.count, 10);
  assert.equal(maxStackSize(ITEM.IRON_PICKAXE), 1);
});

test('items at different heights merge only after landing', () => {
  const em = new EntityManager(makeGame());
  const a = em.spawnItem(makeStack(BLOCK.DIRT, 1), 0.5, 64, 0.5, 0, 0, 0);
  em.spawnItem(makeStack(BLOCK.DIRT, 1), 0.6, 75, 0.5, 0, 0, 0);
  run(em, 0.3);
  assert.equal(em.count, 2);
  run(em, 4);
  assert.equal(em.count, 1);
  assert.equal(em.list[0].count, 2);
  assert.ok(a.removed || a.count === 2);
});

// ---------------------------------------------------------------------------------------------
// Manager API
// ---------------------------------------------------------------------------------------------

test('getRenderList appends reused EntityRenderItem objects', () => {
  const em = new EntityManager(makeGame());
  const e = em.spawnItem(makeStack(ITEM.DIAMOND, 7), 0.5, 64, 0.5, 0, 0, 0);
  run(em, 0.5);
  const out = [];
  em.getRenderList(out);
  assert.equal(out.length, 1);
  const r = out[0];
  assert.deepEqual(Object.keys(r).sort(), ['age', 'count', 'itemId', 'kind', 'light', 'seed', 'x', 'y', 'z',
    'shadowY', 'shadow', 'shadowRadius'].sort());
  assert.equal(r.kind, 'item');
  // Minecraft item shadow: radius 0.15, (0.75 - height / 2) · 0.5 on the block top under the item
  assert.equal(r.shadowY, 64);
  assert.equal(r.shadowRadius, 0.15);
  assert.ok(Math.abs(r.shadow - 0.375) < 1e-9);
  assert.equal(r.itemId, ITEM.DIAMOND);
  assert.equal(r.count, 7);
  assert.ok(Math.abs(r.age - 0.5) < 1e-9);
  assert.equal(r.y, e.y);
  out.length = 0;
  em.update(1 / 60);
  em.getRenderList(out);
  assert.equal(out[0], r, 'same object every frame (no allocations)');
  assert.equal(out[0].age, e.age);
});

test('entity shadows: full block below, fading with height, none higher up or on partial blocks', () => {
  const w = new FakeWorld();
  w.set(5, 64, 5, BLOCK.CACTUS);
  const em = new EntityManager(makeGame(w));
  const at = (x, y, z) => {
    const e = em.spawnItem(makeStack(BLOCK.DIRT), x, y, z, 0, 0, 0);
    return e.getRenderItem();
  };
  let r = at(0.5, 64, 0.5);
  assert.deepEqual([r.shadowY, +r.shadow.toFixed(4)], [64, 0.375]);
  r = at(2.5, 65, 0.5);
  assert.deepEqual([r.shadowY, +r.shadow.toFixed(4)], [64, 0.125]);
  r = at(4.5, 66.5, 0.5);
  assert.equal(r.shadow, 0);
  r = at(5.5, 65, 5.5);                       // on top of a cactus (not a full block)
  assert.equal(r.shadow, 0);
  const tnt = em.spawnPrimedTnt(8.5, 64, 8.5);
  em.update(1 / 60);
  const tr = tnt.getRenderItem();
  assert.equal(tr.shadowRadius, 0.5);
  assert.ok(tr.shadow > 0.3 && tr.shadowY === 64);
});

test('spawnItem validates its input and copies the stack', () => {
  const em = new EntityManager(makeGame());
  assert.equal(em.spawnItem(null, 0, 64, 0), null);
  assert.equal(em.spawnItem(makeStack(BLOCK.DIRT, 0), 0, 64, 0), null);
  assert.equal(em.spawnItem(makeStack(9999, 1), 0, 64, 0), null);
  assert.equal(em.spawnItem(makeStack(BLOCK.DIRT, 1), NaN, 64, 0), null);
  const s = makeStack(BLOCK.DIRT, 4);
  const e = em.spawnItem(s, 0.5, 64, 0.5);
  s.count = 1;
  assert.equal(e.count, 4);
  assert.equal(em.count, 1);
});

test('popItem splits big stacks; dropFromPlayer throws along the look direction', () => {
  const player = makePlayer(0.5, 64, 0.5);
  player.yaw = Math.PI / 2;   // looking west (-X)
  const em = new EntityManager(makeGame(new FakeWorld(), player), { rng: seq(4) });
  em.popItem(BLOCK.DIRT, 150, 0.5, 64.5, 0.5);
  assert.equal(em.count, 3);
  assert.deepEqual(em.list.map((e) => e.count), [64, 64, 22]);
  for (const e of em.list) {
    assert.ok(Math.abs(e.x - 0.5) <= 0.25 && Math.abs(e.z - 0.5) <= 0.25);
    assert.ok(e.y >= 64.5 - 0.25 - 0.125 - 1e-9 && e.y <= 64.5 + 0.25 - 0.125 + 1e-9);
  }
  const t = em.dropFromPlayer(makeStack(ITEM.STICK, 1));
  assert.equal(t.pickupDelay, 2);
  assert.ok(t.vx < -4, `thrown west: vx = ${t.vx}`);
  assert.ok(Math.abs(t.y - (64 + 1.62 - 0.3)) < 1e-9);
});

test('anyEntityInBox ignores items and sees building-blocking entities', () => {
  const em = new EntityManager(makeGame());
  em.spawnItem(makeStack(BLOCK.DIRT), 0.5, 64, 0.5, 0, 0, 0);
  const box = { minX: 0, minY: 64, minZ: 0, maxX: 1, maxY: 65, maxZ: 1 };
  assert.equal(em.anyEntityInBox(box), false);
  const fb = em.spawnFallingBlock(BLOCK.SAND, 0.5, 64.5, 0.5);
  assert.ok(fb instanceof FallingBlockEntity);
  assert.equal(em.anyEntityInBox(box), true);
  assert.equal(em.anyEntityInBox({ minX: 3, minY: 64, minZ: 3, maxX: 4, maxY: 65, maxZ: 4 }), false);
  assert.equal(em.getEntitiesInBox(box).length, 2);
  assert.equal(em.entities, em.list);
  for (const e of em.entities) assert.equal(typeof e.getAABB, 'function');
});

test('a custom Entity subclass plugs into the manager', () => {
  class Dummy extends Entity {
    constructor() { super(0.6, 1.8); this.type = 'dummy'; this.blocksBuilding = true; this.ticks = 0; }
    update(dt) { this.age += dt; this.ticks++; if (this.age > 1) this.remove(); }
    getRenderItem() { return { kind: 'model', x: this.x, y: this.y, z: this.z }; }
  }
  const em = new EntityManager(makeGame());
  const d = em.add(new Dummy().setPosition(0.5, 64, 0.5));
  run(em, 0.5);
  assert.ok(d.ticks > 0);
  assert.equal(em.getRenderList([])[0].kind, 'model');
  assert.equal(em.anyEntityInBox({ minX: 0, minY: 64, minZ: 0, maxX: 1, maxY: 65, maxZ: 1 }), true);
  run(em, 1);
  assert.equal(em.count, 0);
});

test('the item cap evicts the oldest items', () => {
  const em = new EntityManager(makeGame());
  const first = em.spawnItem(makeStack(BLOCK.DIRT), 0.5, 64, 0.5, 0, 0, 0);
  // unstackable tools never coalesce
  for (let i = 0; i < MAX_ITEM_ENTITIES + 9; i++) em.spawnItem(makeStack(ITEM.IRON_PICKAXE), (i % 80) * 3 - 120, 64, Math.floor(i / 80) * 3 - 120, 0, 0, 0);
  assert.equal(first.removed, true);
  em.update(1 / 60);
  assert.ok(em.count <= MAX_ITEM_ENTITIES);
});

test('drop storms beyond the soft cap coalesce without losing items', () => {
  const em = new EntityManager(makeGame());
  let total = 0;
  for (let y = 0; y < 16; y++) {
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 32; x++) { em.popItem(BLOCK.COBBLESTONE, 1, x - 15.5, 64.5 + y, z - 7.5); total++; }
    }
  }
  assert.equal(total, 8192);
  assert.ok(em.count < SOFT_ITEM_CAP + 200, `entities ${em.count}`);
  const sum = em.list.reduce((s, e) => s + e.count, 0);
  assert.equal(sum, total, 'every cobblestone is still there');
});

test('serialize / deserialize round-trips items, falling blocks and TNT', () => {
  const em = new EntityManager(makeGame());
  em.spawnItem(makeStack(ITEM.IRON_SWORD, 1, 17), 1.5, 64, 2.5, 0, 0, 0, 1);
  em.spawnFallingBlock(BLOCK.GRAVEL, 3.5, 70, 3.5);
  em.add(new PrimedTntEntity(2.5)).setPosition(5.5, 64, 5.5);
  const snap = JSON.parse(JSON.stringify(em.serialize()));
  const em2 = new EntityManager(makeGame());
  em2.deserialize(snap);
  assert.equal(em2.count, 3);
  const item = em2.list.find((e) => e.type === 'item');
  assert.deepEqual([item.itemId, item.count, item.stack.damage, item.x, item.z], [ITEM.IRON_SWORD, 1, 17, 1.5, 2.5]);
  assert.equal(em2.list.find((e) => e.type === 'falling_block').blockId, BLOCK.GRAVEL);
  assert.equal(em2.list.find((e) => e.type === 'tnt').fuse, 2.5);
  em2.clear();
  assert.equal(em2.count, 0);
});

// ---------------------------------------------------------------------------------------------
// Falling blocks, TNT, explosions
// ---------------------------------------------------------------------------------------------

test('a falling block lands in its cell, or drops as an item on a torch', () => {
  const w = new FakeWorld();
  const em = new EntityManager(makeGame(w));
  em.spawnFallingBlock(BLOCK.SAND, 0.5, 70, 0.5);
  run(em, 3);
  assert.equal(w.getBlock(0, 64, 0), BLOCK.SAND);
  assert.equal(em.count, 0);
  w.set(3, 64, 3, BLOCK.TORCH);
  em.spawnFallingBlock(BLOCK.GRAVEL, 3.5, 70, 3.5);
  run(em, 3);
  assert.equal(w.getBlock(3, 64, 3), BLOCK.TORCH);
  const drop = em.list.find((e) => e.type === 'item');
  assert.ok(drop && drop.itemId === BLOCK.GRAVEL, 'dropped as an item');
});

test('primed TNT renders flashing and swelling, then explodes', () => {
  const w = new FakeWorld();
  const player = makePlayer(3.5, 64, 0.5);
  const game = makeGame(w, player);
  const em = new EntityManager(game, { rng: seq(11) });
  w.set(4, 64, 0, BLOCK.TNT);
  const tnt = em.spawnPrimedTnt(0.5, 64, 0.5);
  assert.ok(tnt instanceof PrimedTntEntity);
  assert.ok(game.sounds.some((s) => s[0] === 'fuse'));
  const flashes = new Set();
  let maxScale = 1;
  for (let t = 0; t < TNT_FUSE - 0.05; t += 1 / 60) {
    em.update(1 / 60);
    const r = tnt.getRenderItem();
    flashes.add(r.flash > 0);
    maxScale = Math.max(maxScale, r.scale);
    assert.equal(r.kind, 'block');
    assert.equal(r.blockId, BLOCK.TNT);
  }
  assert.ok(flashes.has(true) && flashes.has(false), 'flashes on and off');
  assert.ok(maxScale > 1.05 && maxScale <= 1.3, `swells: ${maxScale}`);
  run(em, 0.2);
  assert.equal(tnt.removed, true);
  assert.ok(game.sounds.some((s) => s[0] === 'explode'));
  assert.ok(game.particleCalls.some((c) => c[0] === 'explosion'));
  assert.equal(w.getBlock(0, 63, 0), 0, 'crater');
  assert.equal(w.getBlock(1, 63, 0), 0);
  assert.notEqual(w.getBlock(0, 55, 0), 0, 'limited radius');
  assert.ok(player.damageTaken.length === 1 && player.damageTaken[0][1] === 'explosion' && player.damageTaken[0][0] > 5);
  assert.ok(player.vx > 1, `knocked back east: ${player.vx}`);
  // the TNT block in range was primed (chain reaction)
  assert.equal(w.getBlock(4, 64, 0), 0);
  assert.ok(em.list.some((e) => e.type === 'tnt'));
});

test('explosions respect blast resistance (bedrock, obsidian, water) and destroy nearby items', () => {
  const w = new FakeWorld();
  w.fill(-1, 63, -1, 1, 63, 1, BLOCK.OBSIDIAN);
  w.set(0, 62, 0, BLOCK.BEDROCK);
  w.set(-2, 64, 0, BLOCK.DIRT);
  w.set(0, 65, 2, BLOCK.OAK_PLANKS);
  const game = makeGame(w);
  const em = new EntityManager(game, { rng: seq(2) });
  const item = em.spawnItem(makeStack(BLOCK.DIRT), 1.5, 64, 0.5, 0, 0, 0);
  const far = em.spawnItem(makeStack(BLOCK.DIRT), 7.5, 64, 0.5, 0, 0, 0);
  const n = em.explode(0.5, 64.06, 0.5, 4);
  assert.ok(n >= 2, `destroyed ${n}`);
  assert.equal(w.getBlock(-2, 64, 0), 0);
  assert.equal(w.getBlock(0, 65, 2), 0);
  assert.equal(w.getBlock(0, 63, 0), BLOCK.OBSIDIAN);
  assert.equal(w.getBlock(0, 62, 0), BLOCK.BEDROCK);
  assert.equal(item.removed, true, 'item at the centre destroyed');
  assert.equal(far.removed, false);
  assert.ok(Math.hypot(far.vx, far.vy, far.vz) > 0, 'far item pushed');

  const water = new FakeWorld({ ground: 60 });
  water.fill(-6, 60, -6, 6, 70, 6, BLOCK.WATER);
  const em2 = new EntityManager(makeGame(water), { rng: seq(3) });
  assert.equal(em2.explode(0.5, 65, 0.5, 4), 0, 'nothing breaks under water');
});

// ---------------------------------------------------------------------------------------------
// Particles
// ---------------------------------------------------------------------------------------------

test('block break spawns Minecraft 4x4x4 (shape-dependent) terrain particles', () => {
  const ps = new ParticleSystem({ world: new FakeWorld() }, { seed: 1 });
  ps.spawnBlockBreak(0, 64, 0, BLOCK.STONE);
  assert.equal(ps.count, 64);
  ps.clear();
  ps.spawnBlockBreak(0, 64, 0, BLOCK.TORCH);
  assert.equal(ps.count, 2 * 3 * 2);
  ps.clear();
  ps.spawnBlockBreak(0, 64, 0, BLOCK.AIR);
  assert.equal(ps.count, 0);
  ps.spawnBlockBreak(0, 64, 0, 999);
  assert.equal(ps.count, 0);
});

test('particle render data: stride 12, texture window, §5.3 colour, light', () => {
  const w = new FakeWorld();
  w.light = (13 << 4) | 5;
  const ps = new ParticleSystem({ world: w }, { seed: 2 });
  ps.spawnBlockBreak(0, 64, 0, BLOCK.OAK_LEAVES);
  const d = ps.getRenderData();
  assert.equal(d.count, 64);
  assert.equal(PARTICLE_STRIDE, 12);
  const foliage = DEFAULT_TINTS.foliage;
  for (let i = 0; i < d.count; i++) {
    const o = i * 12;
    assert.ok(d.data[o] >= 0 && d.data[o] <= 1 && d.data[o + 1] >= 64 && d.data[o + 1] <= 65);
    assert.ok(d.data[o + 3] >= 0.1 - 1e-6 && d.data[o + 3] <= 0.2 + 1e-6, `size ${d.data[o + 3]}`);
    assert.equal(d.data[o + 4], FACE_LAYERS[BLOCK.OAK_LEAVES * 6 + 4]);
    assert.ok(d.data[o + 5] >= 0 && d.data[o + 5] <= 12 && d.data[o + 6] >= 0 && d.data[o + 6] <= 12);
    assert.equal(d.data[o + 7], 4);
    assert.ok(Math.abs(d.data[o + 8] - foliage[0] / 255 * 0.6) < 1e-6);
    assert.ok(Math.abs(d.data[o + 10] - foliage[2] / 255 * 0.6) < 1e-6);
    assert.equal(d.data[o + 11], (13 << 4) | 5);
  }
  // grass blocks use their dirt texture (tint-mask textures cannot be tinted per particle), untinted
  assert.equal(particleLayerFor(BLOCK.GRASS_BLOCK), TEXTURE_INDEX.get('dirt'));
  assert.deepEqual(particleColorFor(BLOCK.GRASS_BLOCK).map((v) => +v.toFixed(4)), [0.6, 0.6, 0.6]);
  // sideways logs show bark, rotated furnaces their front
  assert.equal(particleLayerFor(BLOCK.OAK_LOG_Z), TEXTURE_INDEX.get('oak_log'));
  assert.equal(particleLayerFor(BLOCK.FURNACE_EAST), TEXTURE_INDEX.get('furnace_front'));
  assert.equal(particleLayerFor(BLOCK.AIR), -1);
});

test('broken-block particles take the light of the neighbours (the cell itself is still dark)', () => {
  const w = new FakeWorld();
  w.lightFn = (x, y, z) => (x === 0 && y === 64 && z === 0 ? 0 : y === 65 ? 0xf0 : 0x30);
  const ps = new ParticleSystem({ world: w }, { seed: 3 });
  ps.spawnBlockBreak(0, 64, 0, BLOCK.DIRT);
  assert.equal(ps.getRenderData().data[11], 0xf0);
});

test('hit particles appear just outside the hit face and are small', () => {
  const ps = new ParticleSystem({ world: new FakeWorld() }, { seed: 4 });
  for (let f = 0; f < 6; f++) {
    ps.clear();
    ps.spawnBlockHit(0, 63, 0, f, BLOCK.STONE);
    const d = ps.getRenderData();
    assert.equal(d.count, 2);
    for (let i = 0; i < 2; i++) {
      const x = d.data[i * 12], y = d.data[i * 12 + 1], z = d.data[i * 12 + 2];
      const out = [x > 1, x < 0, y > 64, y < 63, z > 1, z < 0];
      assert.ok(out[f], `face ${f}: ${x} ${y} ${z}`);
      assert.ok(d.data[i * 12 + 3] <= 0.2 * 0.6 + 1e-6);
    }
  }
});

test('terrain particles live 0.4..1.5 s, fall and never sink into the ground', () => {
  const ps = new ParticleSystem({ world: new FakeWorld() }, { seed: 5 });
  ps.spawnBlockBreak(0, 64, 0, BLOCK.DIRT);
  let minY = Infinity;
  let t = 0;
  for (let k = 0; k < 23; k++, t += 1 / 60) {   // 0.383 s
    ps.update(1 / 60);
    const d = ps.getRenderData();
    for (let i = 0; i < d.count; i++) minY = Math.min(minY, d.data[i * 12 + 1]);
  }
  assert.equal(ps.count, 64, 'nothing dies before 0.4 s');
  for (; t < 1.6; t += 1 / 60) {
    ps.update(1 / 60);
    const d = ps.getRenderData();
    for (let i = 0; i < d.count; i++) minY = Math.min(minY, d.data[i * 12 + 1]);
  }
  assert.equal(ps.count, 0, 'all gone after 1.5 s');
  assert.ok(minY >= 64, `min y ${minY}`);
});

test('the particle pool is fixed-size: overflow recycles slots, output buffers are reused', () => {
  const ps = new ParticleSystem({ world: new FakeWorld() }, { seed: 6 });
  assert.equal(ps.capacity, DEFAULT_PARTICLE_CAPACITY);
  for (let i = 0; i < 200; i++) ps.spawnBlockBreak(i % 10, 64, 0, BLOCK.STONE);   // 12800 requested
  assert.equal(ps.count, DEFAULT_PARTICLE_CAPACITY);
  const a = ps.getRenderData();
  ps.update(1 / 60);
  const b = ps.getRenderData();
  assert.equal(a, b);
  assert.equal(a.data, b.data);
  assert.equal(a.data.length, DEFAULT_PARTICLE_CAPACITY * PARTICLE_STRIDE);
  assert.ok(b.count <= DEFAULT_PARTICLE_CAPACITY);
  const small = new ParticleSystem(null, { capacity: 100, seed: 1 });
  for (let i = 0; i < 10; i++) small.spawnSmoke(0, 64, 0, 50);
  assert.equal(small.count, 100);
  small.update(0.1);   // no world: still fine
});

test('procedural particles: smoke, explosion (full bright), splash droplets and bubbles', () => {
  const w = new FakeWorld({ ground: 60 });
  w.fill(-4, 60, -4, 4, 63, 4, BLOCK.WATER);
  const ps = new ParticleSystem({ world: w }, { seed: 7 });
  ps.spawnSmoke(0.5, 70, 0.5, 10);
  ps.spawnExplosion(0.5, 70, 0.5);
  ps.spawnSplash(0.5, 63 + 14 / 16, 0.5);
  ps.update(0.05);
  const d = ps.getRenderData();
  const styles = new Set();
  let explosionLight = -1;
  for (let i = 0; i < d.count; i++) {
    const o = i * 12;
    assert.equal(d.data[o + 4], PROCEDURAL_LAYER);
    const style = d.data[o + 5];
    styles.add(style);
    assert.ok(d.data[o + 6] >= 0 && d.data[o + 6] <= 1, 'phase in [0,1]');
    assert.ok(d.data[o + 7] >= 0 && d.data[o + 7] < 1, 'seed');
    if (style === STYLE.EXPLOSION) explosionLight = d.data[o + 11];
  }
  assert.deepEqual([...styles].sort(), [STYLE.SMOKE, STYLE.EXPLOSION, STYLE.DROPLET, STYLE.BUBBLE].sort());
  assert.equal(explosionLight, FULL_BRIGHT);
  // the explosion emitter keeps adding big puffs for 8 ticks
  const before = [...Array(d.count).keys()].filter((i) => d.data[i * 12 + 5] === STYLE.EXPLOSION).length;
  ps.update(0.2);
  const d2 = ps.getRenderData();
  const after = [...Array(d2.count).keys()].filter((i) => d2.data[i * 12 + 5] === STYLE.EXPLOSION).length;
  assert.ok(after > before, `${before} -> ${after}`);
  for (let k = 0; k < 120; k++) ps.update(1 / 30);
  assert.equal(ps.count, 0, 'everything expires');
});

function styleCounts(ps) {
  const d = ps.getRenderData();
  const out = {};
  for (let i = 0; i < d.count; i++) {
    if (d.data[i * 12 + 4] !== PROCEDURAL_LAYER) continue;
    const s = d.data[i * 12 + 5];
    out[s] = (out[s] ?? 0) + 1;
  }
  return out;
}

test('ambient display ticks: lava pops (1/100 per selected surface block) trail smoke', () => {
  const w = new FakeWorld({ ground: 60 });
  w.fill(-10, 59, -10, 10, 59, 10, BLOCK.LAVA);               // lava sea with air above
  const ps = new ParticleSystem({ world: w, player: makePlayer(0.5, 60, 0.5) }, { seed: 4 });
  let pops = 0, smoke = 0;
  for (let i = 0; i < 180; i++) {
    ps.update(1 / 60);
    const c = styleCounts(ps);
    pops = Math.max(pops, c[STYLE.LAVA] ?? 0);
    smoke = Math.max(smoke, c[STYLE.SMOKE] ?? 0);
  }
  assert.ok(pops >= 2, `lava pops ${pops}`);
  assert.ok(smoke >= 1, `smoke trails ${smoke}`);
  const d = ps.getRenderData();
  for (let i = 0; i < d.count; i++) {
    if (d.data[i * 12 + 5] === STYLE.LAVA) assert.equal(d.data[i * 12 + 11], FULL_BRIGHT);
  }
});

test('ambient display ticks: torch flames + smoke, drips under liquids, underwater specks', () => {
  const w = new FakeWorld();
  w.set(2, 64, 0, BLOCK.TORCH);
  w.fill(-5, 68, -5, 5, 68, 5, BLOCK.STONE);                  // ceiling ...
  w.fill(-5, 69, -5, 5, 70, 5, BLOCK.WATER);                  // ... holding water
  const player = makePlayer(0.5, 64, 0.5);
  const ps = new ParticleSystem({ world: w, player }, { seed: 9 });
  for (let i = 0; i < 90; i++) ps.update(1 / 60);              // 1.5 s
  let c = styleCounts(ps);
  assert.ok(c[STYLE.FLAME] > 0, 'torch flames');
  assert.ok(c[STYLE.SMOKE] > 0, 'torch smoke');
  assert.ok(c[STYLE.DRIP] > 3, 'drips hanging under the ceiling');
  assert.ok(c[STYLE.SPECK] > 0, 'underwater specks');
  const d = ps.getRenderData();
  for (let i = 0; i < d.count; i++) {
    const o = i * 12;
    if (d.data[o + 5] === STYLE.FLAME) {
      assert.ok(Math.abs(d.data[o] - 2.5) < 0.15 && Math.abs(d.data[o + 1] - 64.7) < 0.15 && Math.abs(d.data[o + 2] - 0.5) < 0.15);
      assert.equal(d.data[o + 11], FULL_BRIGHT);
    }
    if (d.data[o + 5] === STYLE.DRIP) assert.ok(Math.abs(d.data[o + 1] - 67.95) < 1e-3, `hanging drip at ${d.data[o + 1]}`);
    if (d.data[o + 5] === STYLE.SPECK) assert.ok(d.data[o + 1] >= 69 && d.data[o + 1] < 70, 'specks inside the water');
  }
  for (let i = 0; i < 90; i++) ps.update(1 / 60);              // drips released after 2 s fall and splat
  const d2 = ps.getRenderData();
  let falling = 0, splats = 0;
  for (let i = 0; i < d2.count; i++) {
    const o = i * 12;
    if (d2.data[o + 4] !== PROCEDURAL_LAYER) continue;
    if (d2.data[o + 5] === STYLE.DRIP && d2.data[o + 1] < 67.9) falling++;
    if (d2.data[o + 5] === STYLE.DROPLET && Math.abs(d2.data[o + 1] - 64.01) < 0.02 && d2.data[o + 10] > 0.9) splats++;
  }
  assert.ok(falling + splats > 0, `released drips: ${falling} falling, ${splats} splats`);
});

test('ambient particles can be disabled and stop for dead players', () => {
  const w = new FakeWorld();
  w.set(2, 64, 0, BLOCK.TORCH);
  const player = makePlayer(0.5, 64, 0.5);
  const off = new ParticleSystem({ world: w, player }, { seed: 1, ambient: false });
  for (let i = 0; i < 60; i++) off.update(1 / 60);
  assert.equal(off.count, 0);
  player.dead = true;
  const dead = new ParticleSystem({ world: w, player }, { seed: 1 });
  for (let i = 0; i < 60; i++) dead.update(1 / 60);
  assert.equal(dead.count, 0);
});

test('bubbles pop when they leave the water', () => {
  const w = new FakeWorld({ ground: 60 });
  w.fill(-4, 60, -4, 4, 61, 4, BLOCK.WATER);
  const ps = new ParticleSystem({ world: w }, { seed: 8 });
  for (let i = 0; i < 20; i++) ps.spawnBubble(0.5, 61.8, 0.5);
  for (let k = 0; k < 90; k++) {
    ps.update(1 / 60);
    const d = ps.getRenderData();
    for (let i = 0; i < d.count; i++) assert.ok(d.data[i * 12 + 1] < 62 + 0.05, 'no bubble above the water');
  }
});

// ---------------------------------------------------------------------------------------------
// Entity renderer geometry (pure helpers)
// ---------------------------------------------------------------------------------------------

function triangleNormalsAgree(verts) {
  for (let t = 0; t < verts.length; t += 27) {
    const a = [verts[t], verts[t + 1], verts[t + 2]], b = [verts[t + 9], verts[t + 10], verts[t + 11]], c = [verts[t + 18], verts[t + 19], verts[t + 20]];
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const sn = [verts[t + 3], verts[t + 4], verts[t + 5]];
    if ((sn[0] || sn[1] || sn[2]) && n[0] * sn[0] + n[1] * sn[1] + n[2] * sn[2] <= 0) return false;
  }
  return true;
}

test('models are counter-clockwise from outside (back-face culling safe)', () => {
  for (const [name, m] of [['cube', buildCubeModel()], ['cactus', buildCactusModel()], ['torch', buildTorchModel()],
    ['arm', buildArmModel()], ['sprite', buildSpriteModel(null)]]) {
    assert.ok(triangleNormalsAgree(m), name);
    assert.equal(m.length % 9, 0);
  }
  assert.equal(buildCubeModel().length / 9, 36);
  assert.equal(buildCrossModel().length / 9, 24);
});

test('extruded sprite: front/back plus one edge quad per boundary run, UVs inside the texels', () => {
  const alpha = new Uint8Array(256);
  alpha[5 * 16 + 7] = 255;                       // single pixel
  let m = buildSpriteModel(alpha);
  assert.equal(m.length / 9 / 6, 6);             // front, back, up, down, left, right
  alpha[5 * 16 + 8] = 255;                       // 2x1 run: still one quad per side
  m = buildSpriteModel(alpha);
  assert.equal(m.length / 9 / 6, 6);
  alpha[6 * 16 + 8] = 255;                       // L shape: up 1, down 2, left 2, right 1 runs
  m = buildSpriteModel(alpha);
  assert.ok(triangleNormalsAgree(m));
  assert.equal(m.length / 9 / 6, 2 + 6);
  for (let v = 2 * 6; v < m.length / 9; v++) {   // edge quads only sample the opaque texels
    const u = m[v * 9 + 6], t = m[v * 9 + 7];
    assert.ok(u >= 7 && u <= 9 && t >= 5 && t <= 7, `uv ${u},${t}`);
  }
  // a real item sprite produces a closed, reasonably small mesh
  const stick = new Uint8Array(256);
  for (let i = 2; i < 14; i++) stick[(15 - i) * 16 + i] = 255;   // diagonal
  const sm = buildSpriteModel(stick);
  assert.ok(sm.length / 9 / 6 <= 2 + 4 * 12);
});

test('item stack copies follow Minecraft getRenderAmount', () => {
  assert.deepEqual([1, 2, 16, 17, 32, 33, 48, 49, 64].map(renderAmount), [1, 2, 2, 3, 3, 4, 4, 5, 5]);
});

test('hand pose: Minecraft layout in view space (right, low, in front), swing and equip move it', () => {
  const m = new Float64Array(12);
  const at = (mm, x, y, z) => [
    mm[0] * x + mm[1] * y + mm[2] * z + mm[3], mm[4] * x + mm[5] * y + mm[6] * z + mm[7], mm[8] * x + mm[9] * y + mm[10] * z + mm[11],
  ];
  computeHandPose(m, { itemId: ITEM.IRON_PICKAXE, swing: 0, equip: 1 }, 'sprite');
  const rest = at(m, 0, 0, 0);
  assert.ok(rest[0] > 0.3 && rest[1] < -0.1 && rest[2] < -0.5, `sprite rest ${rest}`);
  computeHandPose(m, { itemId: ITEM.IRON_PICKAXE, swing: 0, equip: 0 }, 'sprite');
  const lowered = at(m, 0, 0, 0);
  assert.ok(Math.abs(rest[1] - lowered[1] - 0.6) < 1e-9, 'equip 0 lowers by 0.6');
  computeHandPose(m, { itemId: ITEM.IRON_PICKAXE, swing: 0.3, equip: 1 }, 'sprite');
  const swung = at(m, 0, 0, 0);
  assert.ok(swung[0] < rest[0] - 0.1, 'the swing moves toward the centre');
  assert.equal(computeHandPose(m, { itemId: 0, swing: 0, equip: 1 }, 'arm'), 'arm');
  const hand = at(m, -1, 10, 0);     // hand end of the arm (px, Minecraft model space)
  const shoulder = at(m, -1, -2, 0);
  assert.ok(hand[1] > shoulder[1], 'the hand end is above the shoulder');
  assert.ok(hand[0] > 0.3 && hand[2] < -0.5, `arm ${hand}`);
  // a block in the hand: rotated 45°, scale 0.4
  computeHandPose(m, { itemId: BLOCK.STONE, swing: 0, equip: 1 }, 'block');
  const sx = Math.hypot(m[0], m[4], m[8]);
  assert.ok(Math.abs(sx - 0.4) < 1e-9);
  // bobbing translates in view space
  computeHandPose(m, { itemId: BLOCK.STONE, swing: 0, equip: 1, bobX: 0.05, bobY: -0.03 }, 'block');
  const bobbed = at(m, 0, 0, 0);
  computeHandPose(m, { itemId: BLOCK.STONE, swing: 0, equip: 1 }, 'block');
  const still = at(m, 0, 0, 0);
  assert.ok(Math.abs(bobbed[0] - still[0] - 0.05) < 1e-9 && Math.abs(bobbed[1] - still[1] + 0.03) < 1e-9);
});

test('Steve skin: classic 64x64 layout, opaque parts, cyan sleeve on the shoulder end of the arms', () => {
  const px = paintSkinTexture();
  assert.equal(px.length, 64 * 64 * 4);
  const at = (x, y) => [px[(y * 64 + x) * 4], px[(y * 64 + x) * 4 + 1], px[(y * 64 + x) * 4 + 2], px[(y * 64 + x) * 4 + 3]];
  // every texel used by the six parts is opaque
  for (const [, , , w, h, d, u, v] of PLAYER_PARTS) {
    for (let y = v + d; y < v + d + h; y++) for (let x = u; x < u + 2 * (w + d); x++) assert.equal(at(x, y)[3], 255, `${x},${y}`);
    for (let y = v; y < v + d; y++) for (let x = u + d; x < u + d + 2 * w; x++) assert.equal(at(x, y)[3], 255, `${x},${y}`);
  }
  for (const [ux, uy] of [[40, 16], [32, 48]]) {
    const sleeve = at(ux + 5, uy + 5), skin = at(ux + 5, uy + 12);
    assert.ok(sleeve[2] > sleeve[0] + 40, `cyan sleeve ${sleeve}`);
    assert.ok(skin[0] > skin[2] + 40, `skin ${skin}`);
  }
  const eye = at(10, 12);
  assert.ok(eye[2] > eye[0], 'blue eyes');
  assert.equal(at(40, 0)[3], 0, 'unused areas stay transparent');
  // box models: 6 faces, CCW, UVs inside the 64x64 skin (stored / 4)
  const arm = buildArmModel();
  assert.ok(triangleNormalsAgree(arm));
  for (let v = 0; v < arm.length / 9; v++) {
    const u = arm[v * 9 + 6] * 4, t = arm[v * 9 + 7] * 4;
    assert.ok(u >= 40 && u <= 56 && t >= 16 && t <= 32, `arm uv ${u},${t}`);
  }
  assert.deepEqual(buildBoxModel(...PLAYER_PARTS[0]).length / 9, 36);
});

test('player avatar: walk cycle, body yaw follows walking (backwards keeps facing), head limit 75°', () => {
  const av = new PlayerAvatar();
  const p = { x: 0.5, y: 64, z: 0.5, yaw: 0, pitch: 0, dead: false, sneaking: false, eyeHeight: 1.62 };
  const w = new FakeWorld();
  for (let i = 0; i < 60; i++) av.update(1 / 60, p, w);
  assert.ok(av.limbSwingAmount < 0.01, 'standing still');
  // walk north (forward) at 4.3 b/s for 1 s
  for (let i = 0; i < 60; i++) { p.z -= 4.317 / 60; av.update(1 / 60, p, w); }
  assert.ok(av.limbSwingAmount > 0.8, `walking ${av.limbSwingAmount}`);
  assert.ok(av.limbSwing > 10);
  assert.ok(Math.abs(av.bodyYaw) < 0.05, 'body faces the walking direction');
  // strafe west while looking north: the body turns toward the movement (≤ 75° from the head)
  for (let i = 0; i < 60; i++) { p.x -= 4.317 / 60; av.update(1 / 60, p, w); }
  assert.ok(av.bodyYaw > 0.6 && av.bodyYaw <= 75 * Math.PI / 180 + 1e-9, `strafing body ${av.bodyYaw}`);
  // walk backwards (south) while looking north: the body keeps facing north
  for (let i = 0; i < 60; i++) { p.z += 4.317 / 60; av.update(1 / 60, p, w); }
  assert.ok(Math.abs(av.bodyYaw) < 0.1, `backwards ${av.bodyYaw}`);
  // turn the head 120° while standing: the body follows to stay within 75°
  p.yaw = 2.1;
  for (let i = 0; i < 30; i++) av.update(1 / 60, p, w);
  assert.ok(Math.abs(p.yaw - av.bodyYaw) <= 75 * Math.PI / 180 + 1e-9);
  // teleport: no animation burst
  p.x += 500;
  av.update(1 / 60, p, w);
  assert.ok(av.limbSwingAmount < 0.5);
  const r = av.getRenderItem({ ...p, hurtTime: 0.3, getSelectedStack: () => null }, { itemId: ITEM.IRON_SWORD, swing: 0.4 });
  assert.equal(r.kind, 'model');
  assert.equal(r.model, 'player');
  assert.deepEqual([r.itemId, r.attack, r.hurt, r.headYaw], [ITEM.IRON_SWORD, 0.4, 1, 2.1]);
  assert.equal(r.shadowRadius, 0.5);
  assert.equal(r.shadowY, 64);
});

test('the manager appends the player model only in third-person views (game.perspective > 0)', () => {
  const player = makePlayer(0.5, 64, 0.5);
  const game = makeGame(new FakeWorld(), player);
  game.interaction = { getHandState: () => ({ itemId: BLOCK.STONE, swing: 0 }) };
  game.perspective = 0;
  const em = new EntityManager(game);
  em.update(1 / 60);
  assert.equal(em.getRenderList([]).length, 0);
  game.perspective = 1;
  em.update(1 / 60);
  const list = em.getRenderList([]);
  assert.equal(list.length, 1);
  assert.equal(list[0].kind, 'model');
  assert.equal(list[0].itemId, BLOCK.STONE);
  assert.equal(em.count, 0, 'the avatar is not an entity');
});

test('player pose: Minecraft layout (head on top, feet at y, legs swing opposite), item in the right hand', () => {
  const parts = new Float64Array(72);
  const held = new Float64Array(12);
  const at = (p, x, y, z) => {
    const m = parts.subarray(p * 12, p * 12 + 12);
    return [m[0] * x + m[1] * y + m[2] * z + m[3], m[4] * x + m[5] * y + m[6] * z + m[7], m[8] * x + m[9] * y + m[10] * z + m[11]];
  };
  const r = { bodyYaw: 0, headYaw: 0, headPitch: 0, limbSwing: 0, limbSwingAmount: 0, attack: 0, sneaking: false, age: 0, death: 0, itemId: 0 };
  computePlayerPose(r, 0, 0, 0, parts);
  const headTop = at(0, 0, -8, 0), feet = at(4, 0, 12, 0);
  assert.ok(Math.abs(feet[1]) < 0.01, `feet at y = ${feet[1]}`);
  assert.ok(Math.abs(headTop[1] - 1.875) < 0.01, `head top ${headTop[1]} (32 px · 15/16)`);
  const face = at(0, 0, -4, -4);   // front face centre of the head (model -Z)
  assert.ok(face[2] < -0.2, 'yaw 0 faces north (-Z)');
  const rArm = at(2, -1, 4, 0), lArm = at(3, 1, 4, 0);
  assert.ok(rArm[0] > 0.2 && lArm[0] < -0.2, 'facing north the right arm is east (+X)');
  // walking: legs swing in opposite directions
  computePlayerPose({ ...r, limbSwing: 1.2, limbSwingAmount: 1 }, 0, 0, 0, parts);
  const rFoot = at(4, 0, 12, 0), lFoot = at(5, 0, 12, 0);
  assert.ok(rFoot[2] * lFoot[2] < 0 && Math.abs(rFoot[2] - lFoot[2]) > 0.4, `${rFoot[2]} ${lFoot[2]}`);
  // looking west turns the body/head
  computePlayerPose({ ...r, bodyYaw: Math.PI / 2, headYaw: Math.PI / 2 }, 0, 0, 0, parts);
  assert.ok(at(0, 0, -4, -4)[0] < -0.2, 'faces west');
  // sneaking lowers the head; death tips the model over
  computePlayerPose({ ...r, sneaking: true }, 0, 0, 0, parts);
  assert.ok(at(0, 0, -8, 0)[1] < 1.75);
  computePlayerPose({ ...r, death: 2 }, 0, 0, 0, parts);
  assert.ok(at(0, 0, -8, 0)[1] < 0.6, 'lying on the ground');
  // the held item sits at the right hand
  computePlayerPose({ ...r, itemId: ITEM.IRON_SWORD }, 0, 0, 0, parts, held, 'handheld');
  const hand = at(2, -1, 10, 0);
  const item = [held[3], held[7], held[11]];
  assert.ok(Math.hypot(hand[0] - item[0], hand[1] - item[1], hand[2] - item[2]) < 0.6, `item ${item} hand ${hand}`);
});
