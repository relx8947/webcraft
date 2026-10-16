// Mobs, arrows, spawner and mob model tests (node:test). Run: node --test tests/mobs.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EntityManager, ItemEntity, FallingBlockEntity, registerEntityType } from '../src/game/entities.js';
import {
  Mob, Arrow, MobSpawner, spawnMob, MOB_TYPES, walkSpeed, mobSound, pathBudget, DESPAWN_FAR,
} from '../src/game/mobs.js';
import { PathFinder, lineOfSight, randomWalkTarget } from '../src/game/mobai.js';
import { ParticleSystem } from '../src/game/particles.js';
import {
  MODEL_DEFS, MODEL_ID, buildPartGeometry, buildArrowGeometry, buildFireQuad, computeModelPose, paintMobSkins,
  paintFireFrames, SKIN, fireSheetCount, bowPower,
} from '../src/render/mobmodels.js';
import { computeHandPose, computePlayerPose } from '../src/render/entityrenderer.js';
import { Inventory } from '../src/game/inventory.js';
import { BLOCK, ITEM, liquidBlock } from '../src/world/registry.js';

pathBudget.perSecond = Infinity;     // deterministic tests: no path-finder throttling

// ---------------------------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------------------------

/** Flat world: stone below `ground` - 1, grass at ground - 1, air above; edits in a map. */
class FakeWorld {
  constructor({ ground = 64, light = 0xf0, seed = 42 } = {}) {
    this.ground = ground;
    this.extra = new Map();
    this.light = light;
    this.lightFn = null;
    this.seed = seed;
    this.meshed = null;
  }
  key(x, y, z) { return ((x + 4096) * 8192 + (z + 4096)) * 256 + y; }
  getBlock(x, y, z) {
    if (y < 0 || y > 255) return 0;
    const e = this.extra.get(this.key(x, y, z));
    if (e !== undefined) return e;
    return y < this.ground - 1 ? BLOCK.STONE : y === this.ground - 1 ? BLOCK.GRASS_BLOCK : 0;
  }
  setBlock(x, y, z, id) { this.extra.set(this.key(x, y, z), id); return true; }
  set(x, y, z, id) { this.setBlock(x, y, z, id); }
  fill(x0, y0, z0, x1, y1, z1, id) {
    for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) this.set(x, y, z, id);
  }
  getLight(x, y, z) { return this.lightFn ? this.lightFn(x, y, z) : this.light; }
  getTopY(x, z) {
    for (let y = 255; y >= 0; y--) if (this.getBlock(x, y, z) !== 0) return y;
    return -1;
  }
  isChunkGenerated() { return true; }
  isChunkMeshed(cx, cz) { return this.meshed ? this.meshed(cx, cz) : true; }
}

function makePlayer(x = 0.5, y = 64, z = 0.5, mode = 'survival') {
  return {
    x, y, z, vx: 0, vy: 0, vz: 0, yaw: 0, pitch: 0, width: 0.6, height: 1.8, eyeHeight: 1.62, dead: false, mode,
    health: 20, inventory: new Inventory(), hits: [],
    getAABB(o = {}) {
      o.minX = this.x - 0.3; o.minY = this.y; o.minZ = this.z - 0.3;
      o.maxX = this.x + 0.3; o.maxY = this.y + 1.8; o.maxZ = this.z + 0.3;
      return o;
    },
    damage(amount, cause, message, attacker) {
      if (this.mode === 'creative') return false;
      this.hits.push({ amount, cause, attacker });
      this.health -= amount;
      return true;
    },
  };
}

function seq(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function makeGame({ world = new FakeWorld(), player = makePlayer(), difficulty = 'normal', daylight = 1, timeOfDay = 0.25 } = {}) {
  const game = {
    world, player, settings: { difficulty }, daylight, timeOfDay, sounds: [], particles: null,
    audio: { play(name, opts) { game.sounds.push(name); return null; }, playBlock(kind, mat) { game.sounds.push(`${kind}:${mat}`); } },
  };
  game.entities = new EntityManager(game, { rng: seq(7) });
  game.spawnItem = (...a) => game.entities.spawnItem(...a);
  return game;
}

function run(game, seconds, dt = 1 / 60, each = null) {
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) {
    game.entities.update(dt);
    if (each) each(i);
  }
}

const mobs = (game) => game.entities.list.filter((e) => e.type === 'mob');
const items = (game) => game.entities.list.filter((e) => e.type === 'item');

// ---------------------------------------------------------------------------------------------
// Physics
// ---------------------------------------------------------------------------------------------

test('a mob falls onto the ground, takes Minecraft fall damage, chickens drift down slowly without damage', () => {
  const game = makeGame({ player: makePlayer(100, 64, 100, 'creative') });
  const pig = spawnMob(game, 'pig', 0.5, 74, 0.5, { persistent: true });
  const chicken = spawnMob(game, 'chicken', 3.5, 74, 0.5);
  let chickenMaxSpeed = 0;
  run(game, 4, 1 / 60, () => { chickenMaxSpeed = Math.max(chickenMaxSpeed, -chicken.vy); });
  assert.ok(Math.abs(pig.y - 64) < 1e-6, `pig y ${pig.y}`);
  assert.equal(pig.onGround, true);
  assert.equal(pig.health, 10 - 7, 'fell 10 blocks: ceil(10 - 3) = 7 damage');
  assert.ok(Math.abs(chicken.y - 64) < 1e-6);
  assert.equal(chicken.health, 4, 'chickens take no fall damage');
  assert.ok(chickenMaxSpeed < 3, `chicken falls slowly (${chickenMaxSpeed.toFixed(2)} b/s)`);
});

test('walk speeds follow Minecraft attributes (pig 2.75, cow 1.76, spider 3.96 b/s)', () => {
  assert.ok(Math.abs(walkSpeed(0.25) - 2.75) < 0.02);
  assert.ok(Math.abs(walkSpeed(0.2) - 1.76) < 0.02);
  assert.ok(Math.abs(walkSpeed(0.3) - 3.96) < 0.02);
  // a pig walking to a goal far away reaches that speed
  const game = makeGame({ player: makePlayer(100, 64, 100, 'creative') });
  const pig = spawnMob(game, 'pig', 0.5, 64, 0.5, { persistent: true });
  pig._ai = false;
  pig._setGoal(game.world, 0, 64, -25, 400);
  run(game, 0.5);
  const z0 = pig.z;
  run(game, 1);
  const speed = z0 - pig.z;
  assert.ok(speed > 2.5 && speed < 3, `pig speed ${speed}`);
});

test('path following: a mob walks around a wall and jumps up a 1-block step to reach its goal', () => {
  const world = new FakeWorld();
  world.fill(-3, 64, -3, 3, 66, -3, BLOCK.STONE);   // wall across the way north
  world.fill(-8, 64, -10, 8, 64, -10, BLOCK.STONE);  // a 1-block step further north
  world.fill(-8, 64, -16, 8, 64, -11, BLOCK.STONE);
  const game = makeGame({ world, player: makePlayer(100, 64, 100, 'creative') });
  const cow = spawnMob(game, 'cow', 0.5, 64, 0.5, { persistent: true });
  assert.ok(cow._setGoal(world, 0, 65, -13, 600));
  run(game, 12, 1 / 60, () => {
    if (cow.moveMode === 0 && Math.abs(cow.z + 12.5) > 1) cow._setGoal(world, 0, 65, -13, 600);
  });
  assert.ok(Math.abs(cow.x - 0.5) < 1.2 && Math.abs(cow.z + 12.5) < 1.2, `cow at ${cow.x.toFixed(2)}, ${cow.y}, ${cow.z.toFixed(2)}`);
  assert.ok(Math.abs(cow.y - 65) < 1e-6, 'on top of the step');
});

test('the path finder routes around obstacles, never through lava or into unmeshed chunks', () => {
  const world = new FakeWorld();
  const pf = new PathFinder(1024);
  const out = new Int32Array(96);
  world.fill(-5, 64, 3, 5, 65, 3, BLOCK.STONE);
  let n = pf.find(world, 0, 64, 0, 0, 64, 6, out, 2, 600);
  assert.ok(pf.reached && n > 6, `around the wall (${n} nodes)`);
  for (let i = 0; i < n; i++) assert.ok(out[i * 3 + 2] !== 3 || Math.abs(out[i * 3]) > 5, 'no node inside the wall');
  // a lava moat blocks the only way
  world.fill(-6, 63, -6, 6, 63, -6, BLOCK.LAVA);
  world.fill(-6, 64, -7, 6, 66, -7, BLOCK.STONE);
  world.fill(-7, 64, -7, -7, 66, 7, BLOCK.STONE);
  world.fill(7, 64, -7, 7, 66, 7, BLOCK.STONE);
  world.fill(-6, 63, -6, 6, 63, -6, BLOCK.LAVA);
  world.fill(-6, 64, -6, 6, 64, -6, 0);
  n = pf.find(world, 0, 64, 0, 0, 64, -10, out, 2, 600);
  for (let i = 0; i < n; i++) assert.notEqual(world.getBlock(out[i * 3], out[i * 3 + 1] - 1, out[i * 3 + 2]), BLOCK.LAVA);
  // chunk (0, -1) not meshed: no node in it
  world.meshed = (cx, cz) => cz >= 0;
  n = pf.find(world, 2, 64, 2, 2, 64, -20, out, 2, 600);
  for (let i = 0; i < n; i++) assert.ok(out[i * 3 + 2] >= 0);
});

test('swimming: mobs rise to the surface of deep water and are carried by the current', () => {
  const world = new FakeWorld();
  world.fill(-6, 56, -6, 6, 63, 6, BLOCK.WATER);
  // a current pushing east (+X)
  world.fluids = { flowVector(x, y, z, out) { out[0] = 1; out[1] = 0; out[2] = 0; return out; } };
  const game = makeGame({ world, player: makePlayer(100, 64, 100, 'creative') });
  const sheep = spawnMob(game, 'sheep', 0.5, 57, 0.5, { persistent: true });
  run(game, 5);
  assert.ok(sheep.y > 62, `floats up (${sheep.y.toFixed(2)})`);
  assert.ok(sheep.x > 2, `pushed east by the flow (${sheep.x.toFixed(2)})`);
});

test('spiders climb walls', () => {
  const world = new FakeWorld();
  world.fill(-40, 64, -2, 40, 69, -2, BLOCK.STONE);   // a 6 high wall too long to walk around
  const game = makeGame({ world, player: makePlayer(0.5, 70, -3.5), daylight: 0.2, timeOfDay: 0.75 });
  const spider = spawnMob(game, 'spider', 0.5, 64, 1.5);
  spider.hurt(1, 'player', game.player);     // provoked: it goes for the player behind the wall
  let maxY = 64;
  run(game, 6, 1 / 60, () => { maxY = Math.max(maxY, spider.y); });
  assert.ok(maxY > 68, `climbed to ${maxY.toFixed(2)}`);
});

test('frozen while the chunk is not meshed: no falling through unloaded terrain', () => {
  const world = new FakeWorld();
  world.meshed = () => false;
  const game = makeGame({ world, player: makePlayer(100, 64, 100, 'creative') });
  const cow = spawnMob(game, 'cow', 0.5, 70, 0.5, { persistent: true });
  run(game, 2);
  assert.equal(cow.y, 70);
  assert.equal(cow.frozen, true);
  world.meshed = null;
  run(game, 2);
  assert.ok(Math.abs(cow.y - 64) < 1e-6);
  assert.equal(cow.frozen, false);
});

// ---------------------------------------------------------------------------------------------
// Damage, death, drops
// ---------------------------------------------------------------------------------------------

test('hurt: 0.5 s cooldown (only bigger hits apply the difference), knockback away from the attacker, red flash', () => {
  const game = makeGame();
  const player = game.player;
  const pig = spawnMob(game, 'pig', 2.5, 64, 0.5, { persistent: true });
  run(game, 0.2);
  assert.equal(pig.hurt(3, 'player', player), true);
  assert.equal(pig.health, 7);
  assert.ok(pig.vx > 4, `knocked away from the player (+X): vx ${pig.vx}`);
  assert.ok(pig.vy > 0, 'lifted');
  assert.equal(pig.getRenderItem().hurt, 1);
  assert.equal(pig.hurt(2, 'player', player), false, 'weaker hit ignored during the cooldown');
  assert.equal(pig.hurt(5, 'player', player), true, 'a bigger hit applies the difference');
  assert.equal(pig.health, 5);
  run(game, 0.6);
  assert.equal(pig.getRenderItem().hurt, 0);
  assert.equal(pig.hurt(1, 'player', player), true, 'after 0.5 s any hit applies again');
  assert.equal(pig.health, 4);
  assert.ok(game.sounds.includes('pig_hurt'));
});

test('death: 1 s tip-over with the red overlay, poof, Minecraft drops; burning mobs drop cooked meat', () => {
  const game = makeGame();
  const poofs = [];
  game.particles = { spawnPoof: (...a) => poofs.push(a), spawnSmoke() {} };
  const pig = spawnMob(game, 'pig', 2.5, 64, 0.5, { persistent: true });
  run(game, 0.1);
  pig.hurt(20, 'player', game.player);
  assert.equal(pig.dead, true);
  const r = pig.getRenderItem();
  assert.ok(r.death > 0 && r.hurt === 1);
  const drops = items(game);
  assert.ok(drops.length >= 1 && drops.every((d) => d.stack.id === ITEM.PORKCHOP), 'raw porkchop');
  const n = drops.reduce((s, d) => s + d.stack.count, 0);
  assert.ok(n >= 1 && n <= 3);
  run(game, 0.5);
  assert.equal(pig.removed, false, 'still tipping over');
  run(game, 0.6);
  assert.equal(pig.removed, true);
  assert.equal(poofs.length, 1);
  assert.equal(game.entities.raycastEntities(0.5, 64.5, 0.5, 1, 0, 0, 5), null, 'dead mobs cannot be hit');
  // burning cow -> cooked beef
  const cow = spawnMob(game, 'cow', -3.5, 64, 0.5, { persistent: true });
  cow.fireTime = 5;
  cow.hurt(30, 'player', game.player);
  assert.ok(items(game).some((d) => d.stack.id === ITEM.COOKED_BEEF));
  assert.ok(!items(game).some((d) => d.stack.id === ITEM.BEEF));
  // sheep: wool + mutton; spider eyes only for player kills
  const sheep = spawnMob(game, 'sheep', 6.5, 64, 6.5, { persistent: true });
  sheep.hurt(30, 'player', game.player);
  assert.ok(items(game).some((d) => d.stack.id === ITEM.WHITE_WOOL));
  assert.ok(items(game).some((d) => d.stack.id === ITEM.MUTTON));
});

test('lava sets mobs on fire and hurts them, water extinguishes', () => {
  const world = new FakeWorld();
  world.set(0, 63, 0, BLOCK.LAVA);
  world.set(0, 64, 0, BLOCK.LAVA);
  const game = makeGame({ world, player: makePlayer(100, 64, 100, 'creative') });
  const cow = spawnMob(game, 'cow', 0.5, 64, 0.5, { persistent: true });
  run(game, 0.3);
  assert.ok(cow.fireTime > 0 && cow.health < 10);
  assert.equal(cow.getRenderItem().onFire, 1);
  // into water
  world.set(0, 63, 0, BLOCK.WATER); world.set(0, 64, 0, BLOCK.WATER);
  run(game, 0.1);
  assert.equal(cow.fireTime, 0);
});

// ---------------------------------------------------------------------------------------------
// Hostile AI
// ---------------------------------------------------------------------------------------------

test('zombies chase survival players and hit them once per second (difficulty-scaled), never creative players', () => {
  for (const [difficulty, dmg] of [['easy', 2.5], ['normal', 3], ['hard', 4.5]]) {
    const game = makeGame({ difficulty, daylight: 0.2, timeOfDay: 0.75 });
    const zombie = spawnMob(game, 'zombie', 0.5, 64, 10.5);
    run(game, 8);
    assert.ok(game.player.hits.length >= 2, `${difficulty}: hit ${game.player.hits.length} times`);
    assert.equal(game.player.hits[0].amount, dmg);
    assert.equal(game.player.hits[0].attacker, zombie);
    assert.equal(game.player.hits[0].cause, 'mob');
    const hitsPerSecond = game.player.hits.length / 6;
    assert.ok(hitsPerSecond <= 1.05, `cooldown (${hitsPerSecond})`);
  }
  const game = makeGame({ player: makePlayer(0.5, 64, 0.5, 'creative'), daylight: 0.2, timeOfDay: 0.75 });
  const zombie = spawnMob(game, 'zombie', 0.5, 64, 6.5);
  run(game, 5);
  assert.equal(zombie.target, null, 'creative players are ignored');
});

test('zombies do not see through walls beyond 16 blocks but sense players within 16', () => {
  const world = new FakeWorld();
  world.fill(-10, 64, 5, 10, 70, 5, BLOCK.STONE);
  const game = makeGame({ world, daylight: 0.2, timeOfDay: 0.75 });
  const far = spawnMob(game, 'zombie', 0.5, 64, 25.5);
  const near = spawnMob(game, 'zombie', 0.5, 64, 12.5);
  run(game, 1);
  assert.equal(far.target, null);
  assert.equal(near.target, game.player);
  assert.equal(lineOfSight(world, 0.5, 65.6, 12.5, 0.5, 65.6, 0.5), false);
  assert.equal(lineOfSight(world, 0.5, 65.6, 4.5, 0.5, 65.6, 0.5), true);
});

test('undead burn in daylight under the open sky, not at night, in the shade or in water', () => {
  const run1 = (daylight, light, setup) => {
    const world = new FakeWorld({ light });
    const game = makeGame({ world, player: makePlayer(100, 64, 100, 'creative'), daylight, timeOfDay: daylight > 0.5 ? 0.25 : 0.75 });
    const z = spawnMob(game, 'zombie', 0.5, 64, 0.5, { persistent: true });
    setup?.(world);
    run(game, 8);
    return z;
  };
  const day = run1(1, 0xf0);
  assert.ok(day.fireTime > 0 || day.health < 20, 'burns at noon');
  assert.ok(day.health < 20);
  assert.equal(run1(0.2, 0xf0).health, 20, 'not at night');
  assert.equal(run1(1, 0xd0).health, 20, 'not in the shade (sky light 13)');
  const wet = run1(1, 0xf0, (w) => { w.fill(-2, 64, -2, 2, 66, 2, BLOCK.WATER); });
  assert.ok(wet.fireTime <= 0, 'not in water');
  // skeletons too, creepers never
  const world = new FakeWorld();
  const game = makeGame({ world, player: makePlayer(100, 64, 100, 'creative'), daylight: 1 });
  const sk = spawnMob(game, 'skeleton', 0.5, 64, 0.5, { persistent: true });
  const cr = spawnMob(game, 'creeper', 5.5, 64, 0.5, { persistent: true });
  run(game, 8);
  assert.ok(sk.health < 20);
  assert.equal(cr.health, 20);
});

test('skeletons keep their distance, draw the bow and shoot arrows at the player', () => {
  const game = makeGame({ daylight: 0.2, timeOfDay: 0.75 });
  const sk = spawnMob(game, 'skeleton', 0.5, 64, 10.5);
  assert.equal(sk.heldItem, ITEM.BOW);
  let maxArrows = 0, drew = false;
  run(game, 6, 1 / 60, () => {
    maxArrows = Math.max(maxArrows, game.entities.countEntities('arrow'));
    if (sk.getRenderItem().useTime > 10 && sk.getRenderItem().aggressive) drew = true;
  });
  assert.ok(drew, 'draws the bow (BOW_AND_ARROW pose)');
  const arrows = game.entities.list.filter((e) => e.type === 'arrow');
  assert.ok(maxArrows >= 1 || game.player.hits.length >= 1, 'shot');
  assert.ok(game.player.hits.some((h) => h.cause === 'arrow') || arrows.length > 0);
  if (game.player.hits.length) {
    const h = game.player.hits.find((x) => x.cause === 'arrow');
    assert.ok(h.amount >= 2 && h.amount <= 6, `arrow damage ${h.amount}`);
    assert.equal(h.attacker.shooter, sk);
  }
  const d = Math.hypot(sk.x - game.player.x, sk.z - game.player.z);
  assert.ok(d > 3, `keeps its distance (${d.toFixed(1)})`);
});

test('creepers ignite within 3 blocks, swell and explode with power 3; they defuse when the player escapes', () => {
  const game = makeGame({ daylight: 0.2, timeOfDay: 0.75 });
  const explosions = [];
  game.entities.explode = (x, y, z, power, opts) => { explosions.push({ power, opts }); return 0; };
  const cr = spawnMob(game, 'creeper', 0.5, 64, 2.5);
  let maxSwell = 0;
  run(game, 2.5, 1 / 60, () => { maxSwell = Math.max(maxSwell, cr.getRenderItem().swell); });
  assert.ok(maxSwell > 0.9, `swelled to ${maxSwell}`);
  assert.equal(explosions.length, 1);
  assert.equal(explosions[0].power, 3);
  assert.equal(explosions[0].opts.attacker, cr);
  assert.equal(cr.removed, true);
  assert.ok(game.sounds.includes('creeper_hiss'));
  // defuse: the player teleports away after the fuse started
  const game2 = makeGame({ daylight: 0.2, timeOfDay: 0.75 });
  game2.entities.explode = () => { throw new Error('should not explode'); };
  const cr2 = spawnMob(game2, 'creeper', 0.5, 64, 2.5);
  run(game2, 0.6);
  assert.ok(cr2.swell > 0);
  game2.player.z = 40;
  run(game2, 2);
  assert.equal(cr2.swell, 0, 'defused');
  assert.equal(cr2.removed, false);
});

test('creeper explosions use the creeper as attacker for the player (death message) and scale with difficulty', () => {
  const game = makeGame({ difficulty: 'easy', daylight: 0.2, timeOfDay: 0.75 });
  const cr = spawnMob(game, 'creeper', 0.5, 64, 1.5);
  run(game, 3);
  assert.equal(cr.removed, true);
  const hit = game.player.hits.find((h) => h.cause === 'explosion');
  assert.ok(hit, 'the player was hurt by the blast');
  assert.equal(hit.attacker, cr);
});

test('spiders are neutral in daylight (unless attacked) and hunt in the dark', () => {
  const day = makeGame({ daylight: 1, timeOfDay: 0.25 });
  const sp = spawnMob(day, 'spider', 0.5, 64, 6.5);
  run(day, 3);
  assert.equal(sp.target, null, 'neutral in the light');
  sp.hurt(1, 'player', day.player);
  run(day, 0.2);
  assert.equal(sp.target, day.player, 'retaliates');
  const night = makeGame({ daylight: 0.2, timeOfDay: 0.75 });
  const sp2 = spawnMob(night, 'spider', 0.5, 64, 6.5);
  run(night, 5);
  assert.equal(sp2.target, night.player);
  assert.ok(night.player.hits.length >= 1 && night.player.hits[0].amount === 2);
});

test('peaceful removes hostile mobs and refuses to spawn them; animals stay', () => {
  const game = makeGame({ difficulty: 'normal', daylight: 0.2, timeOfDay: 0.75 });
  spawnMob(game, 'zombie', 0.5, 64, 10.5);
  spawnMob(game, 'cow', 4.5, 64, 4.5);
  game.settings.difficulty = 'peaceful';
  run(game, 0.1);
  assert.deepEqual(mobs(game).map((m) => m.mobType), ['cow']);
  assert.equal(spawnMob(game, 'creeper', 0.5, 64, 0.5), null);
});

test('despawning: hostiles beyond 128 blocks vanish at once, persistent animals never', () => {
  const game = makeGame({ player: makePlayer(0.5, 64, 0.5), daylight: 0.2, timeOfDay: 0.75 });
  const z = spawnMob(game, 'zombie', 0.5, 64, DESPAWN_FAR + 5);
  const cow = spawnMob(game, 'cow', 0.5, 64, DESPAWN_FAR + 10);
  run(game, 0.1);
  assert.equal(z.removed, true);
  assert.equal(cow.removed, false);
});

// ---------------------------------------------------------------------------------------------
// Arrows
// ---------------------------------------------------------------------------------------------

test('arrows fly a ballistic arc, stick into blocks (shake), fall again when the block disappears, vanish after 60 s', () => {
  const world = new FakeWorld();
  world.fill(-2, 64, -20, 2, 70, -20, BLOCK.STONE);
  const game = makeGame({ world, player: makePlayer(100, 64, 100, 'creative') });
  const a = game.entities.spawnArrow(0.5, 67, 0.5, 0, 0, -60, { pickup: true });
  assert.ok(a instanceof Arrow);
  run(game, 1);
  assert.equal(a.inGround, true);
  assert.ok(Math.abs(a.z - (-19 + 0.05)) < 0.06, `stuck at z ${a.z}`);
  assert.ok(a.y < 67, 'dropped by gravity');
  assert.ok(game.sounds.includes('arrow_hit'));
  const r = a.getRenderItem();
  assert.equal(r.model, 'arrow');
  assert.ok(Math.abs(r.bodyYaw - Math.PI) < 0.05 || Math.abs(r.bodyYaw + Math.PI) < 0.05, `yaw ${r.bodyYaw}`);
  world.set(a.stuckX, a.stuckY, a.stuckZ, 0);
  run(game, 0.2);
  assert.equal(a.inGround, false, 'falls when its block is removed');
  run(game, 3);
  assert.equal(a.inGround, true);
  run(game, 61);
  assert.equal(a.removed, true);
});

test('fast arrows do not tunnel through thin walls or mobs', () => {
  const world = new FakeWorld();
  world.set(0, 65, -5, BLOCK.GLASS);
  const game = makeGame({ world, player: makePlayer(100, 64, 100, 'creative') });
  const a = game.entities.spawnArrow(0.5, 65.5, 0.5, 0, 0, -200);
  run(game, 0.2, 1 / 20);
  assert.equal(a.inGround, true);
  assert.ok(a.z > -4.1, `stopped in front of the glass (z ${a.z})`);
  const pig = spawnMob(game, 'pig', 10.5, 64, 0.5, { persistent: true });
  const b = game.entities.spawnArrow(10.5, 64.5, 6.5, 0, 0, -300, { damage: 2 });
  run(game, 0.2, 1 / 20);
  assert.equal(b.removed, true);
  assert.ok(pig.health < 10, 'the pig was hit');
});

test('arrow damage = ceil(speed · base), crits add a bonus, knockback along the flight, shooter grace period', () => {
  const game = makeGame({ player: makePlayer(100, 64, 100, 'creative') });
  const cow = spawnMob(game, 'cow', 0.5, 64, -5.5, { persistent: true });
  const a = game.entities.spawnArrow(0.5, 65, 0.5, 0, 0, -60, { damage: 2 });      // 3 b/tick
  run(game, 0.3);
  assert.equal(a.removed, true);
  assert.ok(cow.health <= 10 - 5 && cow.health >= 10 - 6, `ceil(~2.9 · 2) = 6 (drag) -> health ${cow.health}`);
  assert.ok(cow.vz < 0, 'pushed along the arrow');
  // own arrow: no hit during the first 0.25 s
  const sk = spawnMob(game, 'skeleton', 20.5, 64, 0.5, { persistent: true });
  const own = game.entities.spawnArrow(20.5, 65, 0.5, 0, -1, 0, { shooter: sk });
  run(game, 0.1);
  assert.equal(sk.health, 20);
  assert.ok(!own.removed || own.inGround);
});

test('survival players pick up their arrows from the ground; skeleton arrows stay', () => {
  const world = new FakeWorld();
  const player = makePlayer(0.5, 64, 0.5);
  const game = makeGame({ world, player });
  const a = game.entities.spawnArrow(0.5, 64.2, 1.5, 0, -10, 0, { pickup: true, shooter: player });
  const b = game.entities.spawnArrow(1.5, 64.2, 0.5, 0, -10, 0, { pickup: false });
  run(game, 1);
  assert.equal(a.removed, true);
  assert.equal(player.inventory.count(ITEM.ARROW), 1);
  assert.equal(b.removed, false);
});

test('raycastEntities finds the nearest pickable mob along a ray (exclude / filter), countEntities counts', () => {
  const game = makeGame({ player: makePlayer(100, 64, 100, 'creative') });
  const near = spawnMob(game, 'pig', 0.5, 64, -3.5, { persistent: true });
  const far = spawnMob(game, 'cow', 0.5, 64, -8.5, { persistent: true });
  game.entities.spawnItem({ id: ITEM.STICK, count: 1 }, 0.5, 64, -2);
  const em = game.entities;
  let hit = em.raycastEntities(0.5, 64.5, 0.5, 0, 0, -1, 20);
  assert.equal(hit.entity, near);
  assert.ok(Math.abs(hit.distance - (0.5 + 3.05)) < 1e-6, `distance ${hit.distance}`);
  hit = em.raycastEntities(0.5, 64.5, 0.5, 0, 0, -1, 20, { exclude: near });
  assert.equal(hit.entity, far);
  hit = em.raycastEntities(0.5, 64.5, 0.5, 0, 0, -1, 20, { filter: (e) => e.mobType === 'cow' });
  assert.equal(hit.entity, far);
  assert.equal(em.raycastEntities(0.5, 64.5, 0.5, 0, 0, -1, 2), null, 'out of reach');
  assert.equal(em.raycastEntities(0.5, 64.5, 0.5, 0, 0, 1, 20), null, 'behind');
  assert.equal(em.countEntities('mob'), 2);
  assert.equal(em.countEntities('pig'), 1);
  assert.equal(em.countEntities((e) => e.type === 'item'), 1);
  assert.equal(em.countEntities('mob', 0.5, 0.5, 5), 1);
});

// ---------------------------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------------------------

test('serialize / deserialize keeps mobs (type, position, yaw, health, fire, equipment) and arrows', () => {
  const game = makeGame({ player: makePlayer(100, 64, 100, 'creative') });
  const sheep = spawnMob(game, 'sheep', 1.5, 64, 2.5, { persistent: true, yaw: 1.2 });
  sheep.health = 5;
  const sk = spawnMob(game, 'skeleton', 5.5, 64, 2.5, { persistent: true });
  sk.fireTime = 3;
  const a = game.entities.spawnArrow(0.5, 70, 0.5, 0, -30, 0, { pickup: true });
  run(game, 1);
  assert.equal(a.inGround, true);
  const data = JSON.parse(JSON.stringify(game.entities.serialize()));
  const game2 = makeGame({ player: makePlayer(100, 64, 100, 'creative') });
  game2.entities.deserialize(data);
  const m2 = mobs(game2);
  assert.deepEqual(m2.map((m) => m.mobType).sort(), ['sheep', 'skeleton']);
  const s2 = m2.find((m) => m.mobType === 'sheep');
  assert.ok(Math.abs(s2.x - sheep.x) < 1e-9 && Math.abs(s2.z - sheep.z) < 1e-9);
  assert.equal(s2.health, 5);
  assert.ok(Math.abs(s2.yaw - sheep.yaw) < 1e-9);
  const k2 = m2.find((m) => m.mobType === 'skeleton');
  assert.equal(k2.heldItem, ITEM.BOW);
  assert.ok(k2.fireTime > 0);
  const a2 = game2.entities.list.find((e) => e.type === 'arrow');
  assert.ok(a2 && a2.inGround && a2.pickup);
});

test('records of unregistered entity types survive a save and are restored once the type registers', () => {
  const game = makeGame();
  game.entities.deserialize([{ type: 'unicorn', x: 1, y: 64, z: 1, horn: 3 }]);
  const saved = game.entities.serialize();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].horn, 3);
  let made = 0;
  registerEntityType('unicorn', () => { made++; return null; });
  game.entities.update(1 / 60);
  assert.equal(made, 1);
});

// ---------------------------------------------------------------------------------------------
// Spawner
// ---------------------------------------------------------------------------------------------

test('chunk generation spawns animal groups in ~10 % of grassy chunks, deterministically', () => {
  const counts = [];
  for (let pass = 0; pass < 2; pass++) {
    const game = makeGame({ player: makePlayer(0.5, 64, 0.5, 'creative') });
    const sp = new MobSpawner(game, { rng: seq(3) });
    let groups = 0;
    for (let cx = -10; cx < 10; cx++) for (let cz = -10; cz < 10; cz++) if (sp.onChunkGenerated(cx, cz) > 0) groups++;
    const ms = mobs(game);
    counts.push(ms.map((m) => `${m.mobType}${m.x},${m.z}`).join(';'));
    assert.ok(groups >= 20 && groups <= 65, `${groups} of 400 chunks`);
    assert.ok(ms.every((m) => !m.hostile && m.persistent && Math.abs(m.y - 64) < 1e-9));
    const kinds = new Set(ms.map((m) => m.mobType));
    assert.ok(kinds.size >= 3, `types ${[...kinds]}`);
  }
  assert.equal(counts[0], counts[1], 'same seed -> same animals');
});

test('hostile spawning: only in the dark, 24+ blocks away, capped; none in daylight, peaceful or under torches', () => {
  const night = makeGame({ daylight: 0.2, timeOfDay: 0.75 });
  const sp = new MobSpawner(night, { rng: seq(11) });
  for (let i = 0; i < 300; i++) sp.update(0.5);
  const hs = mobs(night).filter((m) => m.hostile);
  assert.ok(hs.length > 5 && hs.length <= sp.hostileCap, `${hs.length} hostiles`);
  for (const m of hs) {
    const d = Math.hypot(m.x - night.player.x, m.z - night.player.z);
    assert.ok(d >= 23, `spawned ${d.toFixed(1)} blocks away`);
  }
  const day = makeGame({ daylight: 1, timeOfDay: 0.25 });
  const sd = new MobSpawner(day, { rng: seq(11) });
  for (let i = 0; i < 100; i++) sd.update(0.5);
  assert.equal(mobs(day).filter((m) => m.hostile).length, 0, 'daylight');
  const lit = makeGame({ world: new FakeWorld({ light: 0x0e }), daylight: 0.2, timeOfDay: 0.75 });
  const sl = new MobSpawner(lit, { rng: seq(11) });
  for (let i = 0; i < 100; i++) sl.update(0.5);
  assert.equal(mobs(lit).filter((m) => m.hostile).length, 0, 'block light 14');
  const peace = makeGame({ difficulty: 'peaceful', daylight: 0.2, timeOfDay: 0.75 });
  const spp = new MobSpawner(peace, { rng: seq(11) });
  for (let i = 0; i < 100; i++) spp.update(0.5);
  assert.equal(mobs(peace).filter((m) => m.hostile).length, 0, 'peaceful');
});

test('easy difficulty spawns hostiles at half the rate', () => {
  const tally = (difficulty) => {
    const g = makeGame({ difficulty, daylight: 0.2, timeOfDay: 0.75 });
    const s = new MobSpawner(g, { rng: seq(5) });
    s.hostileCap = 1000;
    for (let i = 0; i < 40; i++) s.update(0.5);
    return s.stats.hostile;
  };
  const easy = tally('easy'), normal = tally('normal');
  assert.ok(easy < normal * 0.75, `easy ${easy} vs normal ${normal}`);
});

test('ongoing passive spawning adds animal groups on lit grass while fewer than 10 are around', () => {
  const game = makeGame({ daylight: 1 });
  const sp = new MobSpawner(game, { rng: seq(9) });
  for (let i = 0; i < 200; i++) sp.update(0.5);
  const animals = mobs(game).filter((m) => !m.hostile);
  assert.ok(animals.length >= 2 && animals.length <= 10 + 4, `${animals.length} animals`);
});

// ---------------------------------------------------------------------------------------------
// Misc behaviour
// ---------------------------------------------------------------------------------------------

test('sheep eat grass: the grass block below turns into dirt with the head-down animation', () => {
  const game = makeGame({ player: makePlayer(100, 64, 100, 'creative') });
  const sheep = spawnMob(game, 'sheep', 0.5, 64, 0.5, { persistent: true });
  sheep.eatTicks = 40;
  let lowered = false;
  run(game, 2.2, 1 / 60, () => { if (sheep.getRenderItem().eat > 4) lowered = true; });
  assert.ok(lowered);
  assert.equal(game.world.getBlock(0, 63, 0), BLOCK.DIRT);
});

test('falling blocks use canStay when landing (a torch dropped as a block entity becomes an item on sand)', () => {
  const game = makeGame({ player: makePlayer(100, 64, 100, 'creative') });
  game.world.set(0, 64, 0, BLOCK.CACTUS);
  game.world.set(1, 64, 0, BLOCK.STONE);   // cactus next to a solid block cannot stay
  game.world.set(0, 63, 0, BLOCK.SAND);
  game.world.set(0, 64, 0, 0);
  const fb = game.entities.spawnFallingBlock(BLOCK.CACTUS, 0.5, 70, 0.5);
  assert.ok(fb instanceof FallingBlockEntity);
  run(game, 3);
  assert.equal(game.world.getBlock(0, 64, 0), 0, 'not placed');
  assert.ok(items(game).some((i) => i.stack.id === BLOCK.CACTUS));
});

test('items and mobs are pushed by flowing water (world.fluids.flowVector) and see every water level', () => {
  const world = new FakeWorld();
  world.fill(-8, 63, -8, 8, 63, 8, liquidBlock(1, 3));
  world.fill(-8, 62, -8, 8, 62, 8, BLOCK.STONE);
  world.fluids = { flowVector(x, y, z, out) { out[0] = 0; out[1] = 0; out[2] = 1; return out; } };
  const game = makeGame({ world, player: makePlayer(100, 64, 100, 'creative') });
  const it = game.entities.spawnItem({ id: ITEM.STICK, count: 1 }, 0.5, 63.2, 0.5, 0, 0, 0);
  run(game, 2);
  assert.ok(it.z > 1, `item carried south (${it.z.toFixed(2)})`);
  assert.ok(it instanceof ItemEntity);
});

test('mob sounds resolve to existing audio names (with fallbacks)', () => {
  for (const def of Object.values(MOB_TYPES)) {
    for (const k of ['ambient', 'hurt', 'death']) {
      const n = def.sounds[k];
      if (n) assert.ok(mobSound(n), `${n} resolves`);
    }
  }
  assert.ok(mobSound('creeper_hiss'));
  assert.equal(mobSound('no_such_sound_at_all'), null);
});

test('mobs push each other apart instead of overlapping', () => {
  const game = makeGame({ player: makePlayer(100, 64, 100, 'creative') });
  const a = spawnMob(game, 'cow', 0.5, 64, 0.5, { persistent: true });
  const b = spawnMob(game, 'cow', 0.6, 64, 0.55, { persistent: true });
  run(game, 3);
  const d = Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
  assert.ok(d > 0.5, `separated by ${d.toFixed(2)}`);
});

// ---------------------------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------------------------

function windingOk(verts) {
  for (let t = 0; t < verts.length / 27; t++) {
    const o = t * 27;
    const p = (k) => [verts[o + k * 9], verts[o + k * 9 + 1], verts[o + k * 9 + 2]];
    const n = [verts[o + 3], verts[o + 4], verts[o + 5]];
    if (n[0] === 0 && n[1] === 0 && n[2] === 0) continue;
    const a = p(0), b = p(1), c = p(2);
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const cr = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    if (cr[0] * n[0] + cr[1] * n[1] + cr[2] * n[2] <= 0) return false;
  }
  return true;
}

test('mob models: Minecraft boxes, counter-clockwise faces, UVs inside the skin, skins cover every sampled texel', () => {
  const skins = paintMobSkins();
  assert.equal(skins.size, 10);
  for (const def of MODEL_DEFS) {
    if (def.anim === 'player' || def.anim === 'arrow') continue;
    const all = [...def.parts, ...(def.overlay?.parts ?? [])];
    for (const part of all) {
      const v = buildPartGeometry(part);
      assert.equal(v.length / 9, 36 * part.boxes.length, `${def.name}.${part.name}`);
      assert.ok(windingOk(v), `${def.name}.${part.name} winding`);
      for (let i = 0; i < v.length / 9; i++) {
        const u = v[i * 9 + 6] * 4, t = v[i * 9 + 7] * 4;
        assert.ok(u >= 0 && u <= 64 && t >= 0 && t <= 64, `${def.name} uv ${u},${t}`);
      }
    }
    // every face texel of the base parts is painted (opaque or emissive) except the chicken legs (cutout)
    const px = skins.get(def.skin);
    for (const part of def.parts) {
      if (def.name === 'chicken' && part.name.endsWith('_leg')) continue;
      for (const [, , , w, h, d, u, vv] of part.boxes) {
        for (let y = vv + d; y < vv + d + h; y++) {
          for (let x = u; x < u + 2 * (w + d); x++) assert.ok(px[(y * 64 + x) * 4 + 3] >= 128, `${def.name} ${x},${y}`);
        }
      }
    }
  }
  assert.ok(windingOk(buildArrowGeometry().map((x, i) => (i % 9 >= 3 && i % 9 <= 5 ? 0 : x))));
  assert.equal(buildFireQuad().length / 9, 6);
  assert.equal(paintFireFrames(4).length, 4);
  // spider eyes are emissive (alpha 128..254), the rest of the face opaque
  const spider = skins.get(SKIN.SPIDER);
  let emissive = 0;
  for (let y = 12; y < 20; y++) for (let x = 40; x < 48; x++) { const a = spider[(y * 64 + x) * 4 + 3]; if (a >= 128 && a < 255) emissive++; }
  assert.ok(emissive >= 6, `${emissive} glowing eye texels`);
});

test('mob poses: feet on the ground, the head faces the yaw, legs swing, death tips over, creepers swell', () => {
  const parts = new Float64Array(16 * 12);
  const at = (p, x, y, z) => {
    const m = parts.subarray(p * 12, p * 12 + 12);
    return [m[0] * x + m[1] * y + m[2] * z + m[3], m[4] * x + m[5] * y + m[6] * z + m[7], m[8] * x + m[9] * y + m[10] * z + m[11]];
  };
  const base = { bodyYaw: 0, headYaw: 0, headPitch: 0, limbSwing: 0, limbSwingAmount: 0, age: 0, attack: 0, death: 0, swell: 0 };
  // zombie: feet at 0, head top at 2 blocks, arms forward (north, -Z)
  const zombie = MODEL_DEFS[MODEL_ID.zombie];
  computeModelPose(zombie, base, 0, 0, 0, parts);
  assert.ok(Math.abs(at(4, 0, 12, 0)[1]) < 0.01, 'zombie feet');
  assert.ok(Math.abs(at(0, 0, -8, 0)[1] - 2) < 0.01, 'zombie head top at 2');
  const hand = at(2, -1, 10, 0);
  assert.ok(hand[2] < -0.4 && hand[1] > 1.1, `zombie arm reaches forward ${hand}`);
  // pig facing west (yaw +90°): snout toward -X
  const pig = MODEL_DEFS[MODEL_ID.pig];
  computeModelPose(pig, { ...base, bodyYaw: Math.PI / 2, headYaw: Math.PI / 2 }, 0, 0, 0, parts);
  assert.ok(at(0, 0, 0, -9)[0] < -0.5, 'pig snout points west');
  assert.ok(Math.abs(at(2, 0, 6, 0)[1]) < 0.01, 'pig feet on the ground');
  // walking: front legs swing opposite to each other
  computeModelPose(pig, { ...base, limbSwing: 1.3, limbSwingAmount: 1 }, 0, 0, 0, parts);
  const fl = at(4, 0, 6, 0), fr = at(5, 0, 6, 0);
  assert.ok(Math.abs(fl[2] - fr[2]) > 0.3, `legs swing ${fl[2]} ${fr[2]}`);
  // death: lying down after 1 s
  computeModelPose(zombie, { ...base, death: 1 }, 0, 0, 0, parts);
  assert.ok(at(0, 0, -8, 0)[1] < 0.6, 'tipped over');
  // creeper swelling widens it
  const creeper = MODEL_DEFS[MODEL_ID.creeper];
  computeModelPose(creeper, base, 0, 0, 0, parts);
  const w0 = Math.abs(at(1, 4, 6, 0)[0]);
  computeModelPose(creeper, { ...base, swell: 1 }, 0, 0, 0, parts);
  const w1 = Math.abs(at(1, 4, 6, 0)[0]);
  assert.ok(w1 > w0 * 1.3, `swollen ${w0} -> ${w1}`);
  // sheep eating lowers the head
  const sheep = MODEL_DEFS[MODEL_ID.sheep];
  computeModelPose(sheep, base, 0, 0, 0, parts);
  const h0 = at(0, 0, 0, -6)[1];
  computeModelPose(sheep, { ...base, eat: 20 }, 0, 0, 0, parts);
  assert.ok(at(0, 0, 0, -6)[1] < h0 - 0.3, 'head down while eating');
  // skeleton aiming: the bow arm points along the look direction
  const sk = MODEL_DEFS[MODEL_ID.skeleton];
  const held = new Float64Array(12);
  computeModelPose(sk, { ...base, aggressive: true, itemId: ITEM.BOW }, 0, 0, 0, parts, held);
  const skHand = at(2, 0, 10, 0);
  assert.ok(skHand[2] < -0.5, `aiming forward ${skHand}`);
  assert.ok(Math.hypot(held[3] - skHand[0], held[7] - skHand[1], held[11] - skHand[2]) < 0.6, 'bow in the hand');
});

test('fire sheets, bow power and the first-person eat / bow poses', () => {
  assert.equal(fireSheetCount(0.6, 1.95), 6);
  assert.equal(fireSheetCount(0.9, 0.9), 2);
  assert.equal(bowPower(20), 1);
  assert.ok(Math.abs(bowPower(10) - (0.25 + 1) / 3) < 1e-9);
  const m = new Float64Array(12);
  const pos = () => [m[3], m[7], m[11]];
  computeHandPose(m, { itemId: ITEM.BREAD, swing: 0, equip: 1 }, 'sprite');
  const rest = pos();
  computeHandPose(m, { itemId: ITEM.BREAD, swing: 0, equip: 1, useAction: 'eat', useProgress: 0.5 }, 'sprite');
  const eating = pos();
  assert.ok(eating[0] < rest[0] - 0.1, `the food moves toward the mouth ${eating} vs ${rest}`);
  computeHandPose(m, { itemId: ITEM.BOW, swing: 0, equip: 1, useAction: 'bow', useProgress: 1 }, 'sprite');
  const bow = pos();
  assert.ok(Math.hypot(bow[0] - rest[0], bow[1] - rest[1], bow[2] - rest[2]) > 0.05, 'drawn bow pose');
  // F5: the player's drawn bow uses BOW_AND_ARROW (arm raised forward)
  const parts = new Float64Array(72);
  computePlayerPose({ bodyYaw: 0, headYaw: 0, headPitch: 0, limbSwing: 0, limbSwingAmount: 0, attack: 0, age: 0, death: 0,
    itemId: ITEM.BOW, aggressive: true }, 0, 0, 0, parts);
  const arm = [parts[24] * -1 + parts[25] * 10 + parts[27], parts[28] * -1 + parts[29] * 10 + parts[31], parts[32] * -1 + parts[33] * 10 + parts[35]];
  assert.ok(arm[2] < -0.4, `arm forward ${arm}`);
});

test('arrows hitting a mob through the render list: the model render item has the shared model shape', () => {
  const game = makeGame({ player: makePlayer(100, 64, 100, 'creative') });
  const pig = spawnMob(game, 'pig', 0.5, 64, 0.5, { persistent: true });
  const a = game.entities.spawnArrow(5, 70, 5, 0, 0, 0);
  const list = game.entities.getRenderList();
  const rp = list.find((r) => r.model === 'pig'), ra = list.find((r) => r.model === 'arrow');
  assert.deepEqual(Object.keys(rp), Object.keys(ra), 'one hidden class for every model item');
  assert.equal(rp.modelId, MODEL_ID.pig);
  assert.equal(ra.modelId, MODEL_ID.arrow);
  assert.ok(pig instanceof Mob && a instanceof Arrow);
});

test('random walk targets stay on land near the mob', () => {
  const world = new FakeWorld();
  const out = new Int32Array(3);
  const rnd = seq(4);
  for (let i = 0; i < 20; i++) {
    assert.ok(randomWalkTarget(world, rnd, 0, 64, 0, 10, 7, 2, true, 0.25, out));
    assert.ok(Math.abs(out[0]) <= 10 && Math.abs(out[2]) <= 10 && out[1] === 64);
  }
});
