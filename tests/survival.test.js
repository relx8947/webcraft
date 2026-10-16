// Survival tests for wave 2 (node:test): hunger, eating, combat, bows, spawn eggs, farming, support
// rules, buckets on flowing liquids, fluid physics and the Ctrl+W tip.
// Run: node --test tests/survival.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Player, EXHAUSTION, EAT_TIME, KNOCKBACK_STRENGTH, DEATH_MESSAGES, deathMessageFor, MAX_FOOD, CTRL_SPRINT_TIP,
} from '../src/game/player.js';
import { Interaction, ENTITY_REACH_SURVIVAL, bucketRaycast } from '../src/game/interaction.js';
import { Input } from '../src/game/input.js';
import { BLOCK, ITEM, liquidBlock, liquidHeight, maxDurability } from '../src/world/registry.js';
import { makeStack } from '../src/game/inventory.js';

// ---------------------------------------------------------------------------------------------
// Fakes (same model as tests/player.test.js)
// ---------------------------------------------------------------------------------------------

/** Typed-array world: x,z in [-32,32), y in [0,128); outside: stone below `ground`, air above. */
class FakeWorld {
  constructor({ ground = 64, fill = BLOCK.STONE } = {}) {
    this.ground = ground;
    this.fillId = fill;
    this.data = new Uint8Array(64 * 128 * 64);
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
  getTopY(x, z) {
    for (let y = 127; y >= 0; y--) if (this.getBlock(x, y, z)) return y;
    return -1;
  }
  getLight() { return 0xf0; }
  isAreaReady() { return true; }
}

class FakeInput {
  constructor() {
    this.held = new Set(); this.down = new Set(); this.up = new Set(); this.keys = new Set();
    this.mouseDX = 0; this.mouseDY = 0; this.wheel = 0;
  }
  isDown(a) { return this.held.has(a) || this.down.has(a); }
  pressed(a) { return this.down.has(a); }
  released(a) { return this.up.has(a); }
  isKeyDown(code) { return this.keys.has(code); }
  press(...as) { for (const a of as) { if (!this.held.has(a)) this.down.add(a); this.held.add(a); } }
  release(...as) { for (const a of as) { if (this.held.has(a)) this.up.add(a); this.held.delete(a); } }
  tap(a) { this.down.add(a); this.up.add(a); }
  endFrame() { this.down.clear(); this.up.clear(); this.mouseDX = 0; this.mouseDY = 0; this.wheel = 0; }
}

/** A mob stand-in with the SPEC-wave2 Mob surface used by the player side. */
class FakeMob {
  constructor(mobType, x, y, z, { width = 0.9, height = 0.9, health = 10 } = {}) {
    this.type = 'mob';
    this.mobType = mobType;
    this.x = x; this.y = y; this.z = z;
    this.width = width; this.height = height;
    this.health = health;
    this.hits = [];
    this.pushes = [];
    this.invulnerable = false;
  }
  getAABB(out = {}) {
    const hw = this.width / 2;
    out.minX = this.x - hw; out.minY = this.y; out.minZ = this.z - hw;
    out.maxX = this.x + hw; out.maxY = this.y + this.height; out.maxZ = this.z + hw;
    return out;
  }
  hurt(amount, cause, attacker) {
    if (this.invulnerable) return false;
    this.hits.push({ amount, cause, attacker });
    this.health -= amount;
    return true;
  }
  push(vx, vy, vz) { this.pushes.push([vx, vy, vz]); }
}

function makeGame(world = new FakeWorld(), mode = 'survival', settings = {}) {
  const game = {
    world,
    settings: { fov: 70, viewBobbing: false, mouseSensitivity: 1, invertY: false, difficulty: 'normal', ...settings },
    events: [], sounds: [], soundOpts: [], spawned: [], dropped: [], arrows: [], crits: 0, itemBreaks: [],
    ui: { openCraftingTable() {} },
    entities: null,
    emit(evt, ...args) { this.events.push([evt, ...args]); },
    spawnItem(stack, x, y, z, vx, vy, vz, delay) { this.spawned.push({ stack, x, y, z, vx, vy, vz, delay }); },
    dropFromPlayer(stack) { this.dropped.push(stack); },
  };
  game.audio = {
    playBlock(kind, material) { game.sounds.push(kind + ':' + material); },
    play(name, opts) { game.sounds.push(name); game.soundOpts.push([name, opts]); },
  };
  game.particles = {
    spawnBlockHit() {}, spawnBlockBreak() {}, spawnSplash() {},
    spawnItemBreak(itemId, x, y, z, count) { game.itemBreaks.push({ itemId, x, y, z, count }); },
    spawnCrit() { game.crits++; },
  };
  game.player = new Player(game);
  game.player.setGameMode(mode);
  game.interaction = new Interaction(game);
  return game;
}

/** Entity manager stand-in: a list of mobs, optional raycastEntities, spawnArrow recording. */
function fakeEntities(game, mobs = [], { withRaycast = false } = {}) {
  const ents = {
    list: mobs,
    rayCalls: 0,
    spawnArrow(x, y, z, vx, vy, vz, opts) {
      const a = { x, y, z, vx, vy, vz, ...opts };
      game.arrows.push(a);
      return a;
    },
  };
  if (withRaycast) {
    // Minimal reference implementation of the SPEC-wave2 API (ray vs AABBs grown by 0.1).
    ents.raycastEntities = (ox, oy, oz, dx, dy, dz, maxDist, { exclude, filter } = {}) => {
      ents.rayCalls++;
      let best = null, bestT = maxDist;
      for (const e of mobs) {
        if (e === exclude || (filter && !filter(e))) continue;
        const b = e.getAABB({});
        let t0 = 0, t1 = bestT;
        let ok = true;
        for (const [o, d, lo, hi] of [[ox, dx, b.minX - 0.1, b.maxX + 0.1], [oy, dy, b.minY - 0.1, b.maxY + 0.1], [oz, dz, b.minZ - 0.1, b.maxZ + 0.1]]) {
          if (Math.abs(d) < 1e-12) { if (o < lo || o > hi) ok = false; continue; }
          let a = (lo - o) / d, c = (hi - o) / d;
          if (a > c) [a, c] = [c, a];
          t0 = Math.max(t0, a); t1 = Math.min(t1, c);
        }
        if (ok && t0 <= t1) { best = e; bestT = t0; }
      }
      return best ? { entity: best, distance: bestT } : null;
    };
  }
  game.entities = ents;
  return ents;
}

function run(game, input, seconds, dt = 1 / 60, each) {
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) {
    each?.(i, i * dt);
    game.player.update(dt, input);
    game.interaction.update(dt, input);
    input.endFrame();
  }
}

function lookAt(player, x, y, z) {
  const e = player.getEyePosition([0, 0, 0]);
  const dx = x - e[0], dy = y - e[1], dz = z - e[2];
  player.yaw = Math.atan2(-dx, -dz);
  player.pitch = Math.atan2(dy, Math.hypot(dx, dz));
}

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ''} expected ${b} ± ${eps}, got ${a}`);
const count = (arr, v) => arr.filter((x) => x === v).length;

/** Player standing at (0.5, 64, 0.5) on flat stone holding `item` in slot 0. */
function standing({ mode = 'survival', item, setup, settings } = {}) {
  const world = new FakeWorld();
  setup?.(world);
  const game = makeGame(world, mode, settings);
  const p = game.player;
  p.setPosition(0.5, 64, 0.5);
  run(game, new FakeInput(), 0.05);
  if (item) p.inventory.set(0, item);
  return game;
}

/** Click RMB on a world point (one frame of press + release). */
function clickUse(game, input, x, y, z) {
  lookAt(game.player, x, y, z);
  run(game, input, 1 / 60);
  input.tap('use');
  run(game, input, 1 / 60);
  input.release('use');
}

// ---------------------------------------------------------------------------------------------
// Hunger
// ---------------------------------------------------------------------------------------------

test('exhaustion: sprinting 0.1/m, walking free, jumps 0.05 / sprint-jumps 0.2, swimming 0.01/m', () => {
  // Sprinting on flat ground.
  let g = standing();
  let p = g.player;
  const input = new FakeInput();
  input.press('forward', 'sprint');
  run(g, input, 0.5);
  p.exhaustion = 0;
  let x0 = p.x, z0 = p.z;
  run(g, input, 2);
  const sprinted = Math.hypot(p.x - x0, p.z - z0);
  assert.ok(sprinted > 10, `sprinted ${sprinted}`);
  near(p.exhaustion, EXHAUSTION.SPRINT * sprinted, 0.002, 'sprint exhaustion');
  // Walking costs nothing.
  input.release('sprint');
  p.sprinting = false;
  run(g, input, 0.5);
  p.exhaustion = 0;
  run(g, input, 2);
  assert.equal(p.exhaustion, 0, 'walking is free');
  // Jumps.
  input.release('forward');
  run(g, input, 0.5);
  p.exhaustion = 0;
  input.tap('jump');
  run(g, input, 1);
  near(p.exhaustion, EXHAUSTION.JUMP, 1e-9, 'jump');
  p.exhaustion = 0;
  input.press('forward', 'sprint');
  run(g, input, 0.3);
  p.exhaustion = 0;
  x0 = p.x; z0 = p.z;
  input.tap('jump');
  let groundDist = 0;
  let px = p.x, pz = p.z, wasGround = true;
  run(g, input, 1, 1 / 60, () => {
    // Exhaustion from distance only accrues on the ground while sprinting.
    if (wasGround) groundDist += Math.hypot(p.x - px, p.z - pz);
    px = p.x; pz = p.z; wasGround = p.onGround;
  });
  assert.ok(p.exhaustion >= EXHAUSTION.SPRINT_JUMP, `sprint-jump ${p.exhaustion}`);
  assert.ok(p.exhaustion < EXHAUSTION.SPRINT_JUMP + 0.1 * (groundDist + 1.5), 'only ground distance costs');
  // Swimming (horizontal, eyes above the water).
  const world = new FakeWorld();
  world.fill(-30, 64, -30, 30, 64, 30, BLOCK.WATER);
  g = makeGame(world);
  p = g.player;
  p.setPosition(0.5, 64.3, 0.5);
  const sw = new FakeInput();
  sw.press('forward');
  run(g, sw, 1);
  p.exhaustion = 0;
  x0 = p.x; z0 = p.z;
  const y0 = p.y;
  run(g, sw, 3);
  const swum = Math.hypot(p.x - x0, p.z - z0, p.y - y0);
  assert.ok(p.inWater && swum > 4, `swum ${swum}`);
  near(p.exhaustion, EXHAUSTION.SWIM * swum, 0.01, 'swim exhaustion');
});

test('exhaustion > 4 costs saturation first, then food; creative accumulates none', () => {
  const g = standing();
  const p = g.player;
  p.food = 17;                                  // no regeneration
  p.saturation = 2;
  p.addExhaustion(4.5);
  run(g, new FakeInput(), 0.05);
  assert.equal(p.saturation, 1);
  assert.equal(p.food, 17);
  near(p.exhaustion, 0.5, 1e-9);
  p.addExhaustion(3.6);
  run(g, new FakeInput(), 0.05);
  assert.equal(p.saturation, 0);
  p.addExhaustion(4.1);
  run(g, new FakeInput(), 0.05);
  assert.equal(p.food, 16, 'no saturation left: food drops');
  p.addExhaustion(100);
  near(p.exhaustion, 40, 1e-9, 'exhaustion is capped at 40');
  p.exhaustion = 0;
  p.setGameMode('creative');
  p.addExhaustion(10);
  assert.equal(p.exhaustion, 0, 'creative players get no exhaustion');
  // Damage costs 0.1 (not for fall / drown / starve / void / suffocation).
  const g2 = standing();
  const q = g2.player;
  q.food = 17;
  q.damage(2, 'lava');
  near(q.exhaustion, EXHAUSTION.DAMAGE, 1e-9, 'damage exhaustion');
  run(g2, new FakeInput(), 0.6);
  q.damage(2, 'fall');
  near(q.exhaustion, EXHAUSTION.DAMAGE, 1e-9, 'fall damage costs nothing');
});

test('regeneration: food 20 + saturation heals 1 HP / 0.5 s from saturation; food >= 18 1 HP / 4 s; below 18 none', () => {
  const g = standing();
  const p = g.player;
  const input = new FakeInput();
  p.health = 10;
  p.saturation = 6;
  run(g, input, 0.48);
  assert.equal(p.health, 10);
  run(g, input, 0.04);
  near(p.health, 11, 1e-9, 'fast regeneration after 10 ticks');
  near(p.exhaustion, 6, 1e-6, '6 exhaustion per healed point');
  run(g, input, 0.05);
  assert.equal(p.saturation, 5, 'paid from saturation on the next tick');
  near(p.exhaustion, 2, 1e-6);
  // Each later heal is min(saturation, 6)/6 HP: 5/6, 4/6, 3/6, 2/6, 2/6, 1/6 over the next 3 s.
  run(g, input, 2.95);
  near(p.health, 11 + (5 + 4 + 3 + 2 + 2 + 1) / 6, 1e-6, 'fast regeneration slows with the saturation');
  // food 19: slow regeneration.
  p.food = 19; p.saturation = 0; p.exhaustion = 0; p.health = 10;
  run(g, input, 3.9);
  assert.equal(p.health, 10);
  run(g, input, 0.15);
  assert.equal(p.health, 11);
  // food 17: none.
  p.food = 17; p.health = 10;
  run(g, input, 10);
  assert.equal(p.health, 10, 'no regeneration below food 18');
});

test('starvation at food 0: easy stops at 10 HP, normal at 1 HP, hard kills (玩家饿死了)', () => {
  const expectations = { easy: 10, normal: 1, hard: 0 };
  for (const [difficulty, floor] of Object.entries(expectations)) {
    const g = standing({ settings: { difficulty } });
    const p = g.player;
    p.food = 0; p.saturation = 0;
    const input = new FakeInput();
    run(g, input, 4.05);
    assert.equal(p.health, 19, `${difficulty}: 1 damage after 4 s`);
    run(g, input, 90);
    if (floor > 0) {
      assert.equal(p.health, floor, `${difficulty} stops at ${floor}`);
      assert.equal(p.dead, false);
    } else {
      assert.equal(p.dead, true, 'hard: starves to death');
      assert.equal(p.deathMessage, '玩家饿死了');
    }
  }
  const c = standing({ mode: 'creative' });
  c.player.food = 0;
  run(c, new FakeInput(), 10);
  assert.equal(c.player.health, 20, 'creative players do not starve');
});

test('peaceful: food never drops, health +1/s and food +1 per 0.5 s', () => {
  const g = standing({ settings: { difficulty: 'peaceful' } });
  const p = g.player;
  p.health = 10; p.food = 10; p.saturation = 0;
  run(g, new FakeInput(), 1.02);
  assert.equal(p.health, 11);
  assert.equal(p.food, 12);
  p.food = 15;
  p.addExhaustion(4.5);
  p.saturation = 0;
  const g2 = standing({ settings: { difficulty: 'peaceful' } });
  const q = g2.player;
  q.saturation = 0; q.food = 20;
  q.addExhaustion(40);
  run(g2, new FakeInput(), 1);
  assert.equal(q.food, 20, 'exhaustion never costs food in peaceful');
});

test('sprinting needs food > 6 (creative always); dropping to 6 stops the sprint', () => {
  const g = standing();
  const p = g.player;
  p.food = 6;
  const input = new FakeInput();
  input.press('forward', 'sprint');
  run(g, input, 0.3);
  assert.equal(p.sprinting, false, 'too hungry to sprint');
  p.food = 7;
  input.release('sprint');
  run(g, input, 0.05);
  input.press('sprint');
  run(g, input, 0.1);
  assert.equal(p.sprinting, true);
  p.food = 6;
  run(g, input, 0.05);
  assert.equal(p.sprinting, false);
  p.setGameMode('creative');
  input.release('sprint');
  run(g, input, 0.05);
  input.press('sprint');
  run(g, input, 0.1);
  assert.equal(p.sprinting, true, 'creative sprints at any food level');
});

// ---------------------------------------------------------------------------------------------
// Eating
// ---------------------------------------------------------------------------------------------

test('eating: hold 1.6 s → food values, crunch every 4 ticks, particles, burp, one item used', () => {
  const g = standing({ item: makeStack(ITEM.BREAD, 3) });
  const p = g.player, it = g.interaction;
  p.food = 10; p.saturation = 0;
  const input = new FakeInput();
  lookAt(p, 0.5, 63, -3);                       // looking at the ground: eating still works
  input.press('use');
  const crunchTimes = [];
  let finishedAt = null, startedAt = null;
  for (let frame = 1; frame <= 102; frame++) {
    const t = frame / 60;
    p.update(1 / 60, input);
    it.update(1 / 60, input);
    input.endFrame();
    if (startedAt === null && p.usingItem === 'eat') startedAt = t;
    if (finishedAt === null && p.food > 10) finishedAt = t;
    for (let i = crunchTimes.length; i < g.sounds.length; i++) crunchTimes.push([g.sounds[i], t - startedAt]);
  }
  assert.equal(p.food, 15, 'bread +5');
  near(p.saturation, 6, 1e-9, 'bread +6 saturation');
  assert.equal(p.inventory.get(0).count, 2, 'one bread eaten');
  near(finishedAt - startedAt, EAT_TIME, 0.04, 'eating takes 1.6 s');
  const eats = crunchTimes.filter(([s]) => s === 'eat');
  assert.equal(eats.length, 7, '6 crunches + the final one');
  near(eats[0][1], 9 / 20, 0.03, 'first crunch at tick 9');
  near(eats[1][1] - eats[0][1], 4 / 20, 0.03, 'then every 4 ticks');
  assert.equal(count(g.sounds, 'burp'), 1);
  assert.equal(g.itemBreaks.filter((b) => b.itemId === ITEM.BREAD).length, 7, 'food particles with every crunch');
  assert.ok(g.itemBreaks.some((b) => b.count === 16), 'burst of 16 at the end');
  // Holding on keeps eating (after the 4-tick use delay) while hungry.
  assert.ok(p.usingItem === 'eat' || p.food >= 15);
  input.release('use');
  run(g, input, 0.05);
  assert.equal(p.usingItem, null);
});

test('eating: released early or slot switched → nothing; full players cannot eat; creative can and keeps the item', () => {
  const g = standing({ item: makeStack(ITEM.COOKED_BEEF, 2) });
  const p = g.player, it = g.interaction;
  p.food = 15; p.saturation = 0;
  const input = new FakeInput();
  input.press('use');
  run(g, input, 1.4);
  assert.equal(p.usingItem, 'eat');
  const hs = it.getHandState();
  assert.equal(hs.useAction, 'eat');
  near(hs.useProgress, 1.4 / EAT_TIME, 0.03);
  input.release('use');
  run(g, input, 0.5);
  assert.equal(p.food, 15, 'released before 1.6 s: nothing eaten');
  assert.equal(p.inventory.get(0).count, 2);
  assert.equal(it.getHandState().useAction, null);
  // Switching the hotbar slot cancels.
  input.press('use');
  run(g, input, 1);
  input.tap('hotbar2');
  run(g, input, 1);
  assert.equal(p.usingItem, null);
  assert.equal(p.food, 15);
  input.release('use');
  input.tap('hotbar1');
  run(g, input, 0.1);
  // Steak: 8 / 12.8, capped at 20 and saturation <= food.
  input.press('use');
  run(g, input, 1.7);
  input.release('use');
  run(g, input, 0.1);
  assert.equal(p.food, 20);
  near(p.saturation, 12.8, 1e-9);
  // Full: no eating.
  input.press('use');
  run(g, input, 2);
  input.release('use');
  assert.equal(p.inventory.get(0).count, 1, 'cannot eat with a full food bar');
  // Creative: eats even when full, keeps the item.
  const c = standing({ mode: 'creative', item: makeStack(ITEM.APPLE, 1) });
  const ci = new FakeInput();
  ci.press('use');
  run(c, ci, 1.65);
  ci.release('use');
  run(c, ci, 0.05);
  assert.equal(c.player.inventory.get(0).count, 1);
  assert.ok(c.sounds.includes('burp'), 'creative players eat too');
});

test('eating slows walking to 20 % and stops sprinting', () => {
  const g = standing({ item: makeStack(ITEM.BREAD, 5) });
  const p = g.player;
  p.food = 5;
  const input = new FakeInput();
  input.press('forward', 'use');
  run(g, input, 1.0);
  const z0 = p.z;
  run(g, input, 0.5);
  near((z0 - p.z) / 0.5, 4.317 * 0.2, 0.05, 'walk speed while eating');
  assert.equal(p.sprinting, false);
});

test('food effects: rotten flesh → Hunger 30 s (80 %), spider eye → Poison: 4 damage over 5 s, never below 1 HP', () => {
  const g = standing();
  const p = g.player;
  p.food = 10;
  assert.equal(p.consumeFood(ITEM.ROTTEN_FLESH, () => 0.5), true);
  assert.equal(p.food, 14);
  assert.equal(p.hungerTicks, 600);
  p.exhaustion = 0;
  p.saturation = 0;
  run(g, new FakeInput(), 2);
  near(p.exhaustion, 2 * 20 * EXHAUSTION.HUNGER_EFFECT, 0.02, 'hunger effect: 0.1 exhaustion per second');
  const g2 = standing();
  const q = g2.player;
  q.food = 17;                                  // no regeneration
  q.consumeFood(ITEM.ROTTEN_FLESH, () => 0.9);
  assert.equal(q.hungerTicks, 0, '20 % of rotten flesh is safe');
  q.consumeFood(ITEM.SPIDER_EYE, () => 0);
  assert.equal(q.poisonTicks, 100);
  q.food = 17; q.saturation = 0;                // keep regeneration out of the measurement
  run(g2, new FakeInput(), 5.1);
  assert.equal(q.health, 16, 'poison: 4 damage');
  q.health = 2;
  q.consumeFood(ITEM.SPIDER_EYE, () => 0);
  q.food = 17; q.saturation = 0;
  run(g2, new FakeInput(), 6);
  assert.equal(q.health, 1, 'poison never kills');
  assert.equal(q.dead, false);
});

// ---------------------------------------------------------------------------------------------
// Attacking
// ---------------------------------------------------------------------------------------------

/** A pig 2 blocks north of a player standing at (0.5, 64, 0.5), looked at. */
function pigScene({ mode = 'survival', item, withRaycast = false, distance = 2 } = {}) {
  const g = standing({ mode, item });
  const pig = new FakeMob('pig', 0.5, 64, 0.5 - distance, { health: 1000 });
  fakeEntities(g, [pig], { withRaycast });
  lookAt(g.player, pig.x, 64.45, pig.z);
  run(g, new FakeInput(), 1 / 60);
  return { g, pig };
}

test('attack: hand 1 damage, swords / tools by items.js, swing, exhaustion 0.1; the mob is targeted instead of the block', () => {
  const { g, pig } = pigScene();
  const p = g.player, it = g.interaction;
  assert.equal(it.targetEntity, pig);
  assert.equal(it.target, null, 'no block outline behind the mob');
  const input = new FakeInput();
  p.exhaustion = 0;
  input.tap('attack');
  run(g, input, 1 / 60);
  assert.equal(pig.hits.length, 1);
  assert.deepEqual([pig.hits[0].amount, pig.hits[0].cause, pig.hits[0].attacker], [1, 'player', p]);
  assert.ok(it.getHandState().swing > 0, 'swing');
  near(p.exhaustion, EXHAUSTION.ATTACK, 1e-9);
  assert.ok(g.sounds.includes('attack_hit'), 'hit sound');
  // Holding the button does not repeat the attack (1.8: one hit per click).
  input.press('attack');
  run(g, input, 0.5);
  assert.equal(pig.hits.length, 2);
  input.release('attack');
  run(g, input, 0.05);
  // Diamond sword 7 damage, −1 durability; iron pickaxe 4 damage, −2 durability.
  p.inventory.set(0, makeStack(ITEM.DIAMOND_SWORD, 1));
  input.tap('attack');
  run(g, input, 1 / 60);
  assert.equal(pig.hits.at(-1).amount, 7);
  assert.equal(p.inventory.get(0).damage, 1);
  p.inventory.set(0, makeStack(ITEM.IRON_PICKAXE, 1));
  input.tap('attack');
  run(g, input, 1 / 60);
  assert.equal(pig.hits.at(-1).amount, 4);
  assert.equal(p.inventory.get(0).damage, 2);
  // Blocks and other items hit like the hand.
  p.inventory.set(0, makeStack(BLOCK.DIRT, 5));
  input.tap('attack');
  run(g, input, 1 / 60);
  assert.equal(pig.hits.at(-1).amount, 1);
  // A hit the mob ignores (invulnerable) costs nothing.
  p.inventory.set(0, makeStack(ITEM.WOODEN_SWORD, 1));
  pig.invulnerable = true;
  p.exhaustion = 0;
  input.tap('attack');
  run(g, input, 1 / 60);
  assert.equal(p.inventory.get(0).damage, 0, 'no durability for a hit that did not land');
  assert.equal(p.exhaustion, 0);
  assert.equal(g.sounds.at(-1), 'attack_swish', 'whoosh when the mob shrugs the hit off');
});

test('attack: critical hits ×1.5 while falling with crit particles; sprint hits add knockback and stop the sprint', () => {
  const { g, pig } = pigScene({ item: makeStack(ITEM.STONE_SWORD, 1) });
  const p = g.player;
  const input = new FakeInput();
  // Falling: fallDistance > 0, vy < 0, not on ground.
  p.setPosition(0.5, 65.2, 0.5);
  p.fallDistance = 0.4;
  p.vy = -3;
  lookAt(p, pig.x, 64.45, pig.z);
  input.tap('attack');
  run(g, input, 1 / 60);
  assert.equal(pig.hits.at(-1).amount, 5 * 1.5, 'stone sword crit');
  assert.equal(g.crits, 1, 'crit particles');
  assert.ok(g.sounds.includes('attack_crit'), 'crit sound');
  run(g, input, 0.6);
  // On the ground: no crit.
  lookAt(p, pig.x, 64.45, pig.z);
  input.tap('attack');
  run(g, input, 1 / 60);
  assert.equal(pig.hits.at(-1).amount, 5);
  assert.equal(g.crits, 1);
  // Sprinting: knockback bonus along the view (+0.5 b/tick, +0.1 up), player slowed and sprint ends.
  p.sprinting = true;
  p.vz = -5;
  p.yaw = 0; p.pitch = -0.2;
  pig.x = 0.5; pig.z = -1.2;
  run(g, input, 1 / 60);
  p.sprinting = true;
  const vz = p.vz;
  assert.ok(g.interaction.attackEntity(pig));
  const push = pig.pushes.at(-1);
  near(push[0], 0, 1e-9);
  near(push[1], 2, 1e-9);
  near(push[2], -10, 1e-9, 'pushed north (view direction) at 10 b/s');
  near(p.vz, vz * 0.6, 1e-9);
  assert.equal(p.sprinting, false);
});

test('attack reach: 3 in survival (MISS between 3 and the block), 5 in creative; blocks in front shield mobs', () => {
  // Mob 3.6 blocks away in front of a wall 4.3 away: survival cannot hit the mob nor mine the wall.
  const setup = (w) => w.fill(-2, 64, -5, 2, 66, -5, BLOCK.DIRT);
  let g = standing({ setup });
  const mob = new FakeMob('zombie', 0.5, 64, -3.1, { width: 0.6, height: 1.95 });
  fakeEntities(g, [mob]);
  lookAt(g.player, 0.5, 65.4, -5);
  run(g, new FakeInput(), 1 / 60);
  assert.equal(g.interaction.targetEntity, null, 'beyond attack reach');
  assert.equal(g.interaction.target, null, 'Minecraft MISS: the mob is in front of the block');
  const input = new FakeInput();
  input.press('attack');
  run(g, input, 1);
  assert.equal(mob.hits.length, 0);
  assert.equal(g.world.getBlock(0, 65, -5), BLOCK.DIRT, 'cannot mine through the mob');
  assert.ok(ENTITY_REACH_SURVIVAL === 3);
  // Creative: 5 blocks.
  g = standing({ mode: 'creative', setup });
  fakeEntities(g, [mob]);
  lookAt(g.player, 0.5, 65.4, -5);
  run(g, new FakeInput(), 1 / 60);
  assert.equal(g.interaction.targetEntity, mob);
  // A block between the player and the mob: the block is targeted.
  g = standing({ setup: (w) => w.fill(-2, 64, -2, 2, 66, -2, BLOCK.GLASS) });
  fakeEntities(g, [mob]);
  lookAt(g.player, 0.5, 65.4, -3.1);
  run(g, new FakeInput(), 1 / 60);
  assert.equal(g.interaction.targetEntity, null);
  assert.equal(g.interaction.target.blockId, BLOCK.GLASS);
  // Short grass (no collision box) does not shield a pig standing in it ...
  g = standing({ setup: (w) => { w.set(0, 64, -2, BLOCK.SHORT_GRASS); w.set(0, 64, -4, BLOCK.SHORT_GRASS); } });
  const pig = new FakeMob('pig', 0.5, 64, -1.5);
  fakeEntities(g, [pig]);
  lookAt(g.player, 0.5, 64.3, -1.5);
  run(g, new FakeInput(), 1 / 60);
  assert.equal(g.interaction.targetEntity, pig, 'the pig in the grass is targeted');
  // ... and grass in front of a pig that is out of attack reach can still be broken.
  pig.z = -4.5;
  lookAt(g.player, 0.5, 64.3, -3.6);
  run(g, new FakeInput(), 1 / 60);
  assert.equal(g.interaction.targetEntity, null);
  assert.equal(g.interaction.target?.blockId, BLOCK.SHORT_GRASS);
});

test('attack uses entities.raycastEntities (SPEC-wave2 §3.4) with exclude + filter when available', () => {
  const { g, pig } = pigScene({ withRaycast: true });
  assert.ok(g.entities.rayCalls > 0);
  assert.equal(g.interaction.targetEntity, pig);
  const input = new FakeInput();
  input.tap('attack');
  run(g, input, 1 / 60);
  assert.equal(pig.hits.length, 1);
  // Dead / dying mobs and non-mobs are never targeted.
  pig.health = 0;
  run(g, input, 1 / 60);
  assert.equal(g.interaction.targetEntity, null);
});

// ---------------------------------------------------------------------------------------------
// Being attacked
// ---------------------------------------------------------------------------------------------

test('mob damage: knockback away from the attacker (once), exhaustion, hurt sound; creative immune', () => {
  const g = standing();
  const p = g.player;
  p.food = 17;
  const zombie = new FakeMob('zombie', 0.5, 64, -1, { width: 0.6, height: 1.95 });
  assert.equal(p.damage(3, 'mob', undefined, zombie), true);
  assert.equal(p.health, 17);
  near(p.exhaustion, 0.1, 1e-9);
  assert.ok(g.sounds.includes('hurt'));
  run(g, new FakeInput(), 1 / 60);
  assert.ok(p.vz > 4, `pushed south, away from the zombie (vz ${p.vz})`);
  assert.ok(p.vy > 0, 'lifted');
  // Over a flat stone floor the knockback carries the player ≈2 blocks with a 1.15-block hop
  // (Minecraft 1.8: 2.07 / 1.153).
  let apex = 0;
  run(g, new FakeInput(), 1.5, 1 / 60, () => { apex = Math.max(apex, p.y - 64); });
  near(p.z - 0.5, 2.0, 0.12, 'knockback distance');
  near(apex, 1.153, 0.01, 'knockback hop');
  // Explicit knockback for the same hit replaces the default one (no double push), and callers
  // using Minecraft's "toward the attacker" convention still push the player away.
  const g2 = standing();
  const q = g2.player;
  q.food = 17;
  const z2 = new FakeMob('zombie', 0.5, 64, -1);
  q.damage(3, 'mob', undefined, z2);
  q.knockback(z2.x - q.x, z2.z - q.z, KNOCKBACK_STRENGTH);
  run(g2, new FakeInput(), 1 / 60);
  assert.ok(q.vz > 4 && q.vz < 8.5, `single knockback (vz ${q.vz})`);
  // A hit swallowed by the hurt cooldown brings no knockback, even when the caller asks for one.
  run(g2, new FakeInput(), 0.2);
  const vz0 = q.vz;
  assert.equal(q.damage(1, 'mob', undefined, z2), false);
  assert.equal(q.knockback(0, 1, KNOCKBACK_STRENGTH), false);
  run(g2, new FakeInput(), 1 / 60);
  assert.ok(Math.abs(q.vz) <= Math.abs(vz0) + 1e-9, 'no extra push from a blocked hit');
  // Explosions push on their own: no extra knockback from the attacker.
  const g3 = standing();
  g3.player.damage(4, 'explosion', undefined, new FakeMob('creeper', 0.5, 64, -1));
  run(g3, new FakeInput(), 1 / 60);
  near(g3.player.vz, 0, 1e-6);
  // Creative players take no mob damage and no knockback.
  const c = standing({ mode: 'creative' });
  assert.equal(c.player.damage(3, 'mob', undefined, zombie), false);
  assert.equal(c.player.knockback(1, 0), false);
  run(c, new FakeInput(), 1 / 60);
  near(c.player.vz, 0, 1e-6);
});

test('death messages per mob: 僵尸 / 骷髅射杀 / 苦力怕炸死了 / 蜘蛛; custom message wins', () => {
  const cases = [
    ['mob', new FakeMob('zombie', 0, 64, 0), '玩家被僵尸杀死了'],
    ['arrow', { type: 'arrow', x: 0, y: 65, z: 0, shooter: new FakeMob('skeleton', 0, 64, -8) }, '玩家被骷髅射杀'],
    ['explosion', new FakeMob('creeper', 0, 64, 0), '玩家被苦力怕炸死了'],
    ['mob', new FakeMob('spider', 0, 64, 0), '玩家被蜘蛛杀死了'],
  ];
  for (const [cause, attacker, msg] of cases) {
    assert.equal(deathMessageFor(cause, attacker), msg);
    const g = standing();
    g.player.damage(30, cause, undefined, attacker);
    assert.equal(g.player.dead, true);
    assert.equal(g.player.deathMessage, msg);
    assert.deepEqual(g.events.at(-1), ['playerDied', msg]);
  }
  assert.equal(deathMessageFor('explosion', null), DEATH_MESSAGES.explosion);
  assert.equal(deathMessageFor('arrow', { type: 'arrow' }), '玩家被箭射杀');
  const g = standing();
  g.player.damage(30, 'mob', '玩家被僵尸咬死了', new FakeMob('zombie', 0, 64, 0));
  assert.equal(g.player.deathMessage, '玩家被僵尸咬死了');
});

// ---------------------------------------------------------------------------------------------
// Bow
// ---------------------------------------------------------------------------------------------

function bowScene({ mode = 'survival', arrows = 5 } = {}) {
  const g = standing({ mode, item: makeStack(ITEM.BOW, 1) });
  if (arrows) g.player.inventory.set(5, makeStack(ITEM.ARROW, arrows));
  fakeEntities(g, []);
  g.player.yaw = 0;
  g.player.pitch = 0.1;
  return g;
}

function drawAndRelease(g, seconds) {
  const input = new FakeInput();
  input.press('use');
  run(g, input, seconds, 1 / 60);
  input.release('use');
  run(g, input, 1 / 60);
  return input;
}

test('bow: full draw (1 s) shoots at 3 b/tick (60 b/s), critical, damage 2, pickup; uses an arrow and 1 durability', () => {
  const g = bowScene();
  const p = g.player;
  const input = new FakeInput();
  input.press('use');
  run(g, input, 0.6);
  assert.equal(p.usingItem, 'bow');
  const hs = g.interaction.getHandState();
  assert.equal(hs.useAction, 'bow');
  near(hs.useProgress, 0.6, 0.03);
  run(g, input, 0.6);
  near(g.interaction.getHandState().useProgress, 1, 1e-9, 'capped at a full draw');
  input.release('use');
  run(g, input, 1 / 60);
  assert.equal(g.arrows.length, 1);
  const a = g.arrows[0];
  near(Math.hypot(a.vx, a.vy, a.vz), 60, 1.5, 'arrow speed');
  assert.equal(a.critical, true);
  assert.equal(a.damage, 2);
  assert.equal(a.pickup, true);
  assert.equal(a.shooter, p);
  near(a.y, p.y + p.eyeHeight - 0.1, 1e-9, 'from the eyes');
  // Along the view: yaw 0 = north (−Z), pitched up 0.1 rad.
  const look = p.getLookVector([0, 0, 0]);
  const dot = (a.vx * look[0] + a.vy * look[1] + a.vz * look[2]) / Math.hypot(a.vx, a.vy, a.vz);
  assert.ok(dot > 0.999, 'shot along the view');
  assert.equal(p.inventory.count(ITEM.ARROW), 4);
  assert.equal(p.inventory.get(0).damage, 1);
  assert.ok(g.sounds.includes('bow_shoot'));
  assert.equal(p.usingItem, null);
  assert.equal(maxDurability(ITEM.BOW), 384);
});

test('bow power curve: f = (t² + 2t)/3 → 0.5 s = 25 b/s, no crit; < 0.14 s does not shoot', () => {
  const g = bowScene();
  drawAndRelease(g, 0.5);
  assert.equal(g.arrows.length, 1);
  const f = (0.25 + 1) / 3;
  near(Math.hypot(g.arrows[0].vx, g.arrows[0].vy, g.arrows[0].vz), f * 60, 1.2);
  assert.equal(g.arrows[0].critical, false);
  drawAndRelease(g, 0.1);
  assert.equal(g.arrows.length, 1, 'too weak: no arrow');
  assert.equal(g.player.inventory.count(ITEM.ARROW), 4, 'and no arrow used');
});

test('bow: survival needs arrows; creative shoots without using arrows or durability; zoom + slowdown while drawing', () => {
  const g = bowScene({ arrows: 0 });
  const input = new FakeInput();
  input.press('use');
  run(g, input, 1);
  assert.equal(g.player.usingItem, null, 'no arrows: cannot draw');
  input.release('use');
  const c = bowScene({ mode: 'creative', arrows: 0 });
  const p = c.player;
  const fov0 = p.getCameraState().fov;
  const ci = new FakeInput();
  ci.press('use', 'forward');
  run(c, ci, 0.6);
  const z0 = p.z;
  run(c, ci, 0.5);
  near((z0 - p.z) / 0.5, 4.317 * 0.2, 0.05, 'walking while drawing');
  const fov = p.getCameraState().fov;
  near(fov / fov0, 1 - 0.15, 0.01, 'full draw narrows the FOV by 15 %');
  ci.release('use');
  run(c, ci, 1 / 60);
  assert.equal(c.arrows.length, 1);
  assert.equal(c.arrows[0].pickup, false, 'creative arrows cannot be picked up');
  assert.equal(p.inventory.get(0).damage ?? 0, 0);
});

test('bow: switching slots, opening a screen or pausing aborts the draw without shooting', () => {
  const g = bowScene();
  const input = new FakeInput();
  input.press('use');
  run(g, input, 0.8);
  input.tap('hotbar2');
  run(g, input, 1 / 60);
  assert.equal(g.player.usingItem, null);
  input.release('use');
  run(g, input, 1 / 60);
  assert.equal(g.arrows.length, 0);
  input.tap('hotbar1');
  input.press('use');
  run(g, input, 0.8);
  input.active = false;                         // UI screen opened (Input.active)
  run(g, input, 1 / 60);
  assert.equal(g.player.usingItem, null);
  assert.equal(g.arrows.length, 0);
  // Button let go while the game was paused (no frame saw the release edge): no shot on resume.
  input.active = true;
  input.release('use');
  input.endFrame();                             // the edge happened while no frames ran
  input.press('use');
  run(g, input, 0.8);
  assert.equal(g.player.usingItem, 'bow');
  input.held.delete('use');                     // released during a pause
  run(g, input, 1 / 60);
  assert.equal(g.player.usingItem, null);
  assert.equal(g.arrows.length, 0, 'resuming does not fire the bow');
});

// ---------------------------------------------------------------------------------------------
// Spawn eggs, hoes, seeds
// ---------------------------------------------------------------------------------------------

test('spawn eggs: the mob appears on the clicked face (cell centre); survival uses the egg, creative keeps it', () => {
  const g = standing({ item: makeStack(ITEM.PIG_SPAWN_EGG, 2), setup: (w) => w.set(2, 64, -2, BLOCK.SHORT_GRASS) });
  const calls = [];
  g.interaction.spawnMob = (game, type, x, y, z, opts) => { calls.push([game, type, x, y, z, opts]); return { type: 'mob' }; };
  const input = new FakeInput();
  clickUse(g, input, 0.5, 64, -1.5);           // top face of the ground block (0, 63, -2)
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(1, 5), ['pig', 0.5, 64, -1.5]);
  assert.equal(calls[0][0], g);
  assert.equal(calls[0][5].persistent, true);
  assert.equal(g.player.inventory.get(0).count, 1);
  clickUse(g, input, 2.5, 64.3, -1.5);         // short grass (no collision): spawned in its cell
  assert.deepEqual(calls[1].slice(1, 5), ['pig', 2.5, 64, -1.5]);
  assert.equal(g.player.inventory.get(0), null, 'both eggs used');
  const c = standing({ mode: 'creative', item: makeStack(ITEM.ZOMBIE_SPAWN_EGG, 1) });
  c.interaction.spawnMob = (game, type) => ({ type });
  clickUse(c, new FakeInput(), 0.5, 64, -1.5);
  assert.equal(c.player.inventory.get(0).count, 1, 'creative keeps the egg');
});

test('hoe: grass / dirt with air above → farmland (−1 durability, sound); not from below, not under a block, not stone', () => {
  const g = standing({
    item: makeStack(ITEM.WOODEN_HOE, 1),
    setup: (w) => {
      w.set(0, 63, -2, BLOCK.GRASS_BLOCK);
      w.set(1, 64, -2, BLOCK.DIRT);
      w.set(-1, 63, -2, BLOCK.GRASS_BLOCK); w.set(-1, 64, -2, BLOCK.DANDELION);
      w.set(0, 66, -2, BLOCK.GRASS_BLOCK);
    },
  });
  const p = g.player, world = g.world;
  const input = new FakeInput();
  clickUse(g, input, 0.5, 64, -1.5);
  assert.equal(world.getBlock(0, 63, -2), BLOCK.FARMLAND);
  assert.equal(p.inventory.get(0).damage, 1);
  assert.ok(g.sounds.includes('hoe_till'), 'tilling sound');
  clickUse(g, input, 1.5, 64.5, -1);           // south face of a dirt block on the ground
  assert.equal(world.getBlock(1, 64, -2), BLOCK.FARMLAND, 'side faces work');
  clickUse(g, input, -0.5, 64, -1.5);          // a flower on top
  assert.equal(world.getBlock(-1, 63, -2), BLOCK.GRASS_BLOCK, 'not under a plant');
  clickUse(g, input, 0.5, 66, -1.6);           // bottom face of a floating grass block
  assert.equal(world.getBlock(0, 66, -2), BLOCK.GRASS_BLOCK, 'not from below');
  clickUse(g, input, 2.5, 64, -1.5);           // stone
  assert.equal(world.getBlock(2, 63, -2), BLOCK.STONE);
  assert.equal(p.inventory.get(0).damage, 2, 'only successful tilling costs durability');
});

test('seeds: only on the top face of farmland with air above → wheat stage 0; one seed used', () => {
  const g = standing({
    item: makeStack(ITEM.WHEAT_SEEDS, 3),
    setup: (w) => {
      w.set(0, 63, -2, BLOCK.FARMLAND); w.set(1, 63, -2, BLOCK.FARMLAND_MOIST); w.set(-1, 63, -2, BLOCK.GRASS_BLOCK);
      w.set(3, 64, -2, BLOCK.FARMLAND);
    },
  });
  const p = g.player, world = g.world;
  const input = new FakeInput();
  clickUse(g, input, 0.5, 63.9375, -1.5);
  assert.equal(world.getBlock(0, 64, -2), BLOCK.WHEAT_0);
  assert.equal(p.inventory.get(0).count, 2);
  assert.ok(g.sounds.includes('place:grass'));
  clickUse(g, input, 3.5, 64.5, -1);           // south face of a raised farmland block
  assert.equal(world.getBlock(3, 64, -1), 0, 'not on the side');
  assert.equal(world.getBlock(3, 65, -2), 0);
  clickUse(g, input, 1.5, 63.9375, -1.5);
  assert.equal(world.getBlock(1, 64, -2), BLOCK.WHEAT_0, 'moist farmland');
  clickUse(g, input, -0.5, 64, -1.5);
  assert.equal(world.getBlock(-1, 64, -2), 0, 'not on grass');
  assert.equal(p.inventory.get(0).count, 1);
});

// ---------------------------------------------------------------------------------------------
// Support rules (registry canStay)
// ---------------------------------------------------------------------------------------------

test('wall torches attach to solid cubes; a side click without support falls back to the floor torch', () => {
  const g = standing({
    item: makeStack(BLOCK.TORCH, 10),
    setup: (w) => {
      w.set(0, 65, -2, BLOCK.STONE);            // wall at eye level
      w.set(-2, 65, 0, BLOCK.STONE);            // block west of the player
      w.set(2, 63, -2, BLOCK.SAND); w.set(2, 64, -2, BLOCK.CACTUS);   // cactus: not a support
      w.set(-2, 66, -2, BLOCK.GLASS);
    },
  });
  const world = g.world;
  const input = new FakeInput();
  clickUse(g, input, 0.5, 65.5, -1);           // south face of the stone
  assert.equal(world.getBlock(0, 65, -1), BLOCK.WALL_TORCH_SOUTH);
  clickUse(g, input, -1, 65.5, 0.5);           // east face of the western block → wall torch pointing east
  assert.equal(world.getBlock(-1, 65, 0), BLOCK.WALL_TORCH_EAST);
  clickUse(g, input, 2.5, 64.5, -1.0625 + 0.001);   // south face of the cactus: no wall support
  assert.equal(world.getBlock(2, 64, -1), BLOCK.TORCH, 'falls back to a floor torch on the stone below');
  clickUse(g, input, -1.5, 66.5, -1);          // south face of floating glass (solid cube) → wall torch
  assert.equal(world.getBlock(-2, 66, -1), BLOCK.WALL_TORCH_SOUTH);
  world.set(-2, 66, -1, 0);
  clickUse(g, input, -1.5, 66, -1.5);          // bottom face of the glass: torches never hang
  assert.equal(world.getBlock(-2, 65, -2), 0);
});

test('cactus needs sand and four free sides; sugar cane needs water next to its ground (or cane below)', () => {
  const g = standing({
    mode: 'creative',
    setup: (w) => {
      w.set(0, 63, -2, BLOCK.SAND); w.set(1, 64, -2, BLOCK.STONE);
      w.set(-2, 63, -2, BLOCK.SAND);
      w.set(3, 63, -2, BLOCK.GRASS_BLOCK); w.set(4, 63, -2, liquidBlock(1, 3));   // flowing water next to it
      w.set(3, 63, 2, BLOCK.GRASS_BLOCK);
    },
  });
  const p = g.player, world = g.world;
  const input = new FakeInput();
  p.inventory.set(0, makeStack(BLOCK.CACTUS, 10));
  clickUse(g, input, 0.5, 64, -1.5);
  assert.equal(world.getBlock(0, 64, -2), 0, 'solid block next to it');
  world.set(1, 64, -2, 0);
  clickUse(g, input, 0.5, 64, -1.5);
  assert.equal(world.getBlock(0, 64, -2), BLOCK.CACTUS);
  clickUse(g, input, -1.5, 64, -1.5);
  assert.equal(world.getBlock(-2, 64, -2), BLOCK.CACTUS);
  p.inventory.set(0, makeStack(BLOCK.SUGAR_CANE, 10));
  clickUse(g, input, 3.5, 64, -1.5);
  assert.equal(world.getBlock(3, 64, -2), BLOCK.SUGAR_CANE, 'water (even flowing) next to the grass');
  clickUse(g, input, 3.5, 65, -1.5);
  assert.equal(world.getBlock(3, 65, -2), BLOCK.SUGAR_CANE, 'stacks on sugar cane');
  clickUse(g, input, 3.5, 64, 2.5);
  assert.equal(world.getBlock(3, 64, 2), 0, 'no water: refused');
});

// ---------------------------------------------------------------------------------------------
// Buckets and liquids
// ---------------------------------------------------------------------------------------------

test('buckets pick up only sources (flowing water is see-through) and pour into flowing water / over torches', () => {
  const flowing = liquidBlock(1, 2);
  const g = standing({
    item: makeStack(ITEM.BUCKET, 1),
    setup: (w) => {
      w.set(0, 64, -2, flowing); w.set(0, 64, -3, BLOCK.WATER);     // flowing in front of a source
      w.set(2, 64, -2, flowing); w.set(2, 64, -3, BLOCK.STONE);     // flowing in front of stone
      w.set(-3, 64, -2, BLOCK.STONE); w.set(-2, 64, -2, BLOCK.WALL_TORCH_EAST);
    },
  });
  const p = g.player, world = g.world, inv = p.inventory;
  const input = new FakeInput();
  clickUse(g, input, 2.5, 64.4, -2.5);
  assert.equal(inv.get(0).id, ITEM.BUCKET, 'flowing water cannot be scooped');
  assert.equal(world.getBlock(2, 64, -2), flowing);
  clickUse(g, input, 0.5, 64.4, -2.5);
  assert.equal(inv.get(0).id, ITEM.WATER_BUCKET, 'the source behind the flowing water');
  assert.equal(world.getBlock(0, 64, -3), 0);
  assert.equal(world.getBlock(0, 64, -2), flowing);
  // Pour: the cell in front of the stone holds flowing water → becomes a source.
  clickUse(g, input, 2.5, 64.5, -2);
  assert.equal(world.getBlock(2, 64, -2), BLOCK.WATER);
  assert.equal(inv.get(0).id, ITEM.BUCKET);
  // A torch in the target cell is washed out (dropped) and replaced by the water.
  inv.set(0, makeStack(ITEM.WATER_BUCKET, 1));
  clickUse(g, input, -1.2, 64, -1.8);          // ground top face; the ray stays clear of the torch box
  assert.equal(world.getBlock(-2, 64, -2), BLOCK.WATER);
  assert.ok(g.spawned.some((s) => s.stack.id === BLOCK.TORCH), 'the torch dropped');
  // bucketRaycast helper: flowing liquid is transparent, sources stop the ray.
  const hit = bucketRaycast(world, 0.5, 64.5, 0.5, 0, 0, -1, 5);
  assert.equal(hit, null, 'nothing left north of the player within 5 blocks');
});

test('fluids: flowing water counts as water (swimming, eyes, fall damage) with Minecraft heights', () => {
  const level3 = liquidBlock(1, 3);
  near(liquidHeight(level3), 5 / 9, 1e-9);
  const world = new FakeWorld();
  world.set(0, 64, 0, level3);
  const g = makeGame(world);
  const p = g.player;
  p.setPosition(0.5, 64, 0.5);
  run(g, new FakeInput(), 0.1);
  assert.equal(p.inWater, true);
  near(p.waterHeight, 5 / 9, 1e-6);
  // A column of falling water is full height: eyes under water.
  world.fill(5, 64, 5, 5, 67, 5, liquidBlock(1, 8));
  p.setPosition(5.5, 64, 5.5);
  run(g, new FakeInput(), 0.1);
  assert.equal(p.eyeInWater, true);
  // Landing in a thin film of flowing water cancels fall damage.
  world.set(-5, 64, -5, liquidBlock(1, 7));
  p.food = 17;
  p.setPosition(-4.5, 80, -4.5);
  run(g, new FakeInput(), 3);
  assert.equal(p.health, 20);
  // Flowing lava hurts like lava.
  world.set(10, 64, 10, liquidBlock(2, 2));
  p.setPosition(10.5, 64, 10.5);
  run(g, new FakeInput(), 0.1);
  assert.equal(p.inLava, true);
  assert.ok(p.health < 20);
});

test('fluids: world.fluids.flowVector pushes the player along the current (1.4 b/s in water)', () => {
  const world = new FakeWorld();
  world.fill(-30, 64, -30, 30, 64, 30, liquidBlock(1, 1));
  const calls = [];
  world.fluids = {
    flowVector(x, y, z, out) {
      calls.push([x, y, z]);
      out[0] = 1; out[1] = 0; out[2] = 0;
      return out;
    },
  };
  const g = makeGame(world);
  const p = g.player;
  p.setPosition(0.5, 64, 0.5);
  run(g, new FakeInput(), 2);
  const x0 = p.x;
  run(g, new FakeInput(), 1);
  near(p.x - x0, 1.4, 0.05, 'drift speed');
  assert.ok(calls.length > 0);
  assert.equal(calls[0].length, 3);
});

test('serialize keeps hunger state; respawn restores food 20 / saturation 5', () => {
  const g = standing();
  const p = g.player;
  p.food = 7; p.saturation = 3.5; p.exhaustion = 2.25; p.hungerTicks = 100; p.poisonTicks = 40;
  const data = JSON.parse(JSON.stringify(p.serialize()));
  const g2 = standing();
  g2.player.deserialize(data);
  const q = g2.player;
  assert.deepEqual([q.food, q.saturation, q.exhaustion, q.hungerTicks, q.poisonTicks], [7, 3.5, 2.25, 100, 40]);
  g2.player.deserialize({ food: 5, saturation: 9 });
  assert.equal(q.saturation, 5, 'saturation never exceeds food');
  q.kill();
  q.respawn();
  assert.deepEqual([q.food, q.saturation, q.exhaustion, q.hungerTicks, q.poisonTicks], [MAX_FOOD, 5, 0, 0, 0]);
});

// ---------------------------------------------------------------------------------------------
// Respawn (review findings PLAYER-2 / CODE-4)
// ---------------------------------------------------------------------------------------------

test('respawn: a /spawnpoint under a roof is used exactly; obstructed → world spawn; plants do not lift the player', () => {
  const world = new FakeWorld();
  world.fill(3, 70, 3, 7, 70, 7, BLOCK.STONE);            // roof over (5, 64..69, 5)
  world.set(0, 64, 0, BLOCK.TORCH);                         // torch on the world spawn column
  const g = makeGame(world);
  g.chat = [];
  g.addChatMessage = (text) => g.chat.push(text);
  g.worldMeta = { spawn: { x: 0.5, y: 64, z: 0.5 } };
  const p = g.player;
  p.spawnPoint = { x: 5.5, y: 64, z: 5.5 };                 // /spawnpoint inside the "room"
  p.kill();
  p.respawn();
  assert.deepEqual([p.x, p.y, p.z], [5.5, 64, 5.5], 'exactly at the personal spawn point, not on the roof');
  assert.equal(g.chat.length, 0);
  // Obstructed (a block in the head cell): world spawn on the ground, not on top of the torch.
  world.set(5, 65, 5, BLOCK.DIRT);
  p.kill();
  p.respawn();
  assert.deepEqual([p.x, p.y, p.z], [0.5, 64, 0.5]);
  assert.deepEqual(g.chat, ['你的重生点已被阻挡']);
  // The world spawn itself keeps following the terrain (a pillar built on it).
  world.fill(0, 64, 0, 0, 66, 0, BLOCK.STONE);
  p.spawnPoint = { x: 0.5, y: 64, z: 0.5 };
  p.kill();
  p.respawn();
  assert.equal(p.y, 67, 'world spawn: on top of the column');
  // An explicit forced flag (from /spawnpoint) survives serialization.
  p.spawnPoint = { x: 5.5, y: 64, z: 5.5, forced: false };
  world.set(5, 65, 5, 0);
  const data = JSON.parse(JSON.stringify(p.serialize()));
  assert.equal(data.spawnPoint.forced, false);
  p.kill();
  p.respawn();
  assert.equal(p.y, 71, 'forced: false snaps to the surface (the roof)');
});

// ---------------------------------------------------------------------------------------------
// Ctrl+W (review finding PLAYER-4)
// ---------------------------------------------------------------------------------------------

test('Ctrl-sprinting outside fullscreen shows the double-tap-W tip once; double-tap W and fullscreen do not', () => {
  const g = standing();
  const tips = [];
  g.ui.showActionText = (text, seconds) => tips.push([text, seconds]);
  const p = g.player;
  const input = new FakeInput();
  // Double-tap W: no tip.
  input.tap('forward');
  run(g, input, 0.1);
  input.press('forward');
  run(g, input, 0.3);
  assert.equal(p.sprinting, true);
  assert.equal(tips.length, 0);
  input.release('forward');
  run(g, input, 0.2);
  // Ctrl-sprint in fullscreen (keyboard lock active): no tip.
  input.fullscreen = true;
  input.press('forward', 'sprint');
  run(g, input, 0.2);
  assert.equal(p.sprinting, true);
  assert.equal(tips.length, 0);
  input.release('forward', 'sprint');
  run(g, input, 0.2);
  // Windowed: the tip, once.
  input.fullscreen = false;
  for (let i = 0; i < 2; i++) {
    input.press('forward', 'sprint');
    run(g, input, 0.2);
    input.release('forward', 'sprint');
    run(g, input, 0.2);
  }
  assert.equal(tips.length, 1);
  assert.equal(tips[0][0], CTRL_SPRINT_TIP);
  assert.ok(CTRL_SPRINT_TIP.includes('双击 W'));
});

test('Input.fullscreen mirrors document.fullscreenElement', () => {
  const doc = new EventTarget();
  doc.fullscreenElement = null;
  const input = new Input(new EventTarget(), {}, { window: new EventTarget(), document: doc });
  assert.equal(input.fullscreen, false);
  doc.fullscreenElement = {};
  assert.equal(input.fullscreen, true);
  input.destroy();
});
