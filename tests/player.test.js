// Player / interaction / input tests (node:test). Run: node --test tests/player.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Player, JUMP_VELOCITY, MAX_AIR, DEATH_MESSAGES, LOOK_RADIANS_PER_UNIT } from '../src/game/player.js';
import { Interaction, SWING_TIME } from '../src/game/interaction.js';
import { Input, ACTIONS } from '../src/game/input.js';
import { BLOCK, ITEM } from '../src/world/registry.js';
import { makeStack } from '../src/game/inventory.js';

// ---------------------------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------------------------

/** Typed-array world: x,z in [-32,32), y in [0,128); outside: stone below `ground`, air above. */
class FakeWorld {
  constructor({ ground = 64, fill = BLOCK.STONE } = {}) {
    this.ground = ground;
    this.fillId = fill;
    this.data = new Uint8Array(64 * 128 * 64);
    this.ready = true;
    this.changes = [];
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
    this.changes.push([x, y, z, this.data[i], id]);
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
  isAreaReady() { return this.ready; }
}

/** Minimal Input stand-in with explicit per-frame edges. */
class FakeInput {
  constructor() {
    this.held = new Set();
    this.down = new Set();
    this.up = new Set();
    this.keys = new Set();
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

function makeGame(world = new FakeWorld(), mode = 'survival') {
  const game = {
    world,
    settings: { fov: 70, viewBobbing: true, mouseSensitivity: 1, invertY: false },
    events: [], sounds: [], spawned: [], dropped: [], particles: { hits: 0, breaks: 0, splashes: 0 },
    ui: { crafting: 0, openCraftingTable() { this.crafting++; } },
    entities: null,
    emit(evt, ...args) { this.events.push([evt, ...args]); },
    spawnItem(stack, x, y, z, vx, vy, vz, delay) { this.spawned.push({ stack, x, y, z, vx, vy, vz, delay }); },
    dropFromPlayer(stack) { this.dropped.push(stack); },
  };
  game.audio = {
    playBlock(kind, material, x, y, z) { game.sounds.push(kind + ':' + material); },
    play(name) { game.sounds.push(name); },
  };
  game.particles = {
    hits: 0, breaks: 0, splashes: 0,
    spawnBlockHit() { this.hits++; }, spawnBlockBreak() { this.breaks++; }, spawnSplash() { this.splashes++; },
  };
  game.player = new Player(game);
  game.player.setGameMode(mode);
  game.interaction = new Interaction(game);
  return game;
}

/** Advance `seconds` at a fixed frame time; `each(frameIndex, t)` runs before every frame. */
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

/** Steady horizontal speed with the given held actions (measured over the last second). */
function steadySpeed({ actions, mode = 'survival', flying = false, fps = 60, y = 64, setup, warmup = 2 } = {}) {
  const world = new FakeWorld();
  setup?.(world);
  const game = makeGame(world, mode);
  const p = game.player;
  p.setPosition(0.5, y, 0.5);
  p.flying = flying;
  const input = new FakeInput();
  input.press(...actions);
  run(game, input, warmup, 1 / fps);
  const z0 = p.z, x0 = p.x;
  run(game, input, 1, 1 / fps);
  return Math.hypot(p.x - x0, p.z - z0);
}

// ---------------------------------------------------------------------------------------------
// Movement
// ---------------------------------------------------------------------------------------------

test('walking speed is 4.317 b/s at any frame rate', () => {
  for (const fps of [20, 30, 60, 144, 240]) {
    near(steadySpeed({ actions: ['forward'], fps }), 4.317, 0.005, `walk @${fps}fps`);
  }
});

test('sprint 5.612, sneak 1.295, diagonal normalisation', () => {
  near(steadySpeed({ actions: ['forward', 'sprint'] }), 5.612, 0.005, 'sprint');
  near(steadySpeed({ actions: ['forward', 'sneak'] }), 1.295, 0.005, 'sneak');
  // Diagonal input (0.98, 0.98) has length > 1 → normalised to 1: only 2 % faster than straight.
  near(steadySpeed({ actions: ['forward', 'right'] }), 4.317 / 0.98, 0.005, 'diagonal walk');
});

test('creative flying 10.89 b/s, sprint-flying 21.78 b/s, Space/Shift vertical 7.5 b/s', () => {
  // Air friction 0.91/tick: time constant 0.53 s, so warm up longer.
  near(steadySpeed({ actions: ['forward'], mode: 'creative', flying: true, y: 90, warmup: 6 }), 10.889, 0.01, 'fly');
  near(steadySpeed({ actions: ['forward', 'sprint'], mode: 'creative', flying: true, y: 90, warmup: 6 }), 21.778, 0.02, 'sprint-fly');
  const game = makeGame(new FakeWorld(), 'creative');
  const p = game.player;
  p.setPosition(0.5, 80, 0.5);
  p.flying = true;
  const input = new FakeInput();
  input.press('jump');
  run(game, input, 1);
  let y0 = p.y;
  run(game, input, 1);
  near(p.y - y0, 7.5, 0.02, 'fly up');
  input.release('jump');
  input.press('sneak');
  run(game, input, 1);
  y0 = p.y;
  run(game, input, 1);
  near(y0 - p.y, 7.5, 0.02, 'fly down');
  assert.equal(p.sneaking, false, 'Shift while flying descends instead of sneaking');
});

test('jump apex ≈ 1.25 blocks, lands after ≈ 0.56 s, frame-rate independent', () => {
  for (const fps of [240, 60, 30]) {
    const game = makeGame();
    const p = game.player;
    p.setPosition(0.5, 64, 0.5);
    const input = new FakeInput();
    run(game, input, 0.2, 1 / fps);
    assert.equal(p.onGround, true);
    input.tap('jump');
    let peak = 0, land = null, t = 0;
    run(game, input, 1, 1 / fps, () => {
      t += 1 / fps;
      peak = Math.max(peak, p.y - 64);
      if (land === null && t > 0.1 && p.onGround) land = t;
    });
    near(peak, 1.2522, fps >= 60 ? 0.004 : 0.02, `apex @${fps}`);
    near(land, 0.5626, 2 / fps + 0.005, `airtime @${fps}`);
    assert.equal(p.y, 64);
    assert.equal(p.vy, 0);
    assert.equal(p.health, 20, 'a normal jump never hurts');
  }
  assert.ok(JUMP_VELOCITY > 9 && JUMP_VELOCITY < 9.5);
});

test('holding jump re-jumps on landing; jumps onto a 1-block step but not a 2-block wall', () => {
  const world = new FakeWorld();
  world.fill(-3, 64, -30, 3, 64, -3, BLOCK.STONE);  // 1-high step north of the player
  const game = makeGame(world);
  const p = game.player;
  p.setPosition(0.5, 64, 0.5);
  const input = new FakeInput();
  run(game, input, 0.1);
  input.press('jump');
  let jumps = 0, prevVy = 0;
  run(game, input, 2.2, 1 / 60, () => {
    if (prevVy <= 0 && p.vy > 0) jumps++;   // take-off (landing + re-jump can share one frame)
    prevVy = p.vy;
  });
  assert.equal(jumps, 4, 'auto re-jump every ≈0.58 s while Space is held');
  input.release('jump');
  run(game, input, 1);
  input.press('forward', 'jump');
  run(game, input, 1.5);
  input.release('forward', 'jump');
  run(game, input, 1);
  assert.equal(p.y, 65, 'climbed the 1-block step');
  assert.ok(p.z < -2.3, 'standing on the step');

  const world2 = new FakeWorld();
  world2.fill(-3, 64, -30, 3, 65, -3, BLOCK.STONE); // 2-high wall
  const game2 = makeGame(world2);
  game2.player.setPosition(0.5, 64, 0.5);
  const input2 = new FakeInput();
  input2.press('forward', 'jump');
  run(game2, input2, 2);
  assert.ok(game2.player.y < 65.3, 'cannot climb a 2-block wall');
  near(game2.player.z, -2 + 0.3, 1e-6, 'pressed against the wall');
});

test('walls stop movement; sprinting stops on a head-on collision but survives glancing contact', () => {
  const world = new FakeWorld();
  world.fill(-30, 64, -3, 30, 66, -3, BLOCK.STONE);   // wall along X at z = -3
  const game = makeGame(world);
  const p = game.player;
  p.setPosition(0.5, 64, 0.5);
  const input = new FakeInput();
  input.press('forward', 'sprint');
  run(game, input, 0.3);
  assert.equal(p.sprinting, true);
  run(game, input, 1.5);
  near(p.z, -2 + 0.3, 1e-6, 'stopped by the wall');
  assert.equal(p.vz, 0);
  input.release('sprint');
  run(game, input, 0.1);
  assert.equal(p.sprinting, false, 'head-on collision stops sprinting');

  // Glancing: facing 5° off the wall direction while sprinting along it.
  const world2 = new FakeWorld();
  world2.fill(-1, 64, -30, -1, 66, 30, BLOCK.STONE);  // wall along Z at x = -1 (west)
  const game2 = makeGame(world2);
  const p2 = game2.player;
  p2.setPosition(0.31, 64, 20.5);
  p2.yaw = 5 * Math.PI / 180;                          // north, slightly toward the west wall
  const input2 = new FakeInput();
  input2.press('forward', 'sprint');
  run(game2, input2, 0.5);
  input2.release('sprint');
  run(game2, input2, 1.5);
  near(p2.x, 0.3, 1e-6, 'sliding along the wall');
  assert.equal(p2.sprinting, true, 'minor collision keeps sprinting');
});

test('sneaking prevents walking off edges (Minecraft edge guard); walking off without sneaking falls', () => {
  const world = new FakeWorld({ ground: 60 });
  world.fill(-2, 60, -2, 2, 63, 2, BLOCK.STONE);      // 5x5 platform, top at y = 64
  const cases = [
    { actions: ['forward', 'sneak'], z: [-2.3, -2.25] },
    { actions: ['forward'], fall: true },
    { actions: ['left', 'back', 'sneak'], x: [-2.3, -2.25], z: [3.25, 3.3] },
  ];
  for (const c of cases) {
    const game = makeGame(world);
    const p = game.player;
    p.setPosition(0.5, 64, 0.5);
    const input = new FakeInput();
    input.press(...c.actions);
    run(game, input, 4);
    if (c.fall) {
      assert.ok(p.y < 63, `walked off: y=${p.y}`);
      continue;
    }
    assert.equal(p.y, 64, `${c.actions} stays on the platform`);
    assert.equal(p.onGround, true);
    // The box may overhang until only a sliver of it is still supported (0.05 back-off steps).
    if (c.x) assert.ok(p.x > c.x[0] && p.x < c.x[1], `x=${p.x}`);
    assert.ok(p.z > c.z[0] && p.z < c.z[1], `z=${p.z}`);
  }
});

test('sneaking: lower eye (smoothly), smaller hitbox, stays crouched without headroom', () => {
  const world = new FakeWorld();
  const game = makeGame(world);
  const p = game.player;
  p.setPosition(0.5, 64, 0.5);
  const input = new FakeInput();
  input.press('sneak');
  run(game, input, 1 / 60);
  assert.equal(p.sneaking, true);
  assert.equal(p.height, 1.5);
  assert.ok(p.eyeHeight < 1.62 && p.eyeHeight > 1.27, 'eye height eases down');
  run(game, input, 0.6);
  near(p.eyeHeight, 1.27, 1e-3);
  // Mid-air under a ceiling 1.6 above the feet: the 1.8 standing box would not fit.
  p.setPosition(0.5, 64.4, 0.5);
  world.set(0, 66, 0, BLOCK.STONE);
  input.release('sneak');
  p.update(0, input);
  assert.equal(p.sneaking, true, 'no room to stand: stays crouched');
  world.set(0, 66, 0, BLOCK.AIR);
  p.update(0, input);
  assert.equal(p.sneaking, false, 'stands up once there is room');
  assert.equal(p.height, 1.8);
});

test('ice keeps momentum: slides much further than stone after releasing W', () => {
  const slide = (block) => {
    const world = new FakeWorld();
    world.fill(-31, 63, -31, 31, 63, 31, block);
    const game = makeGame(world);
    const p = game.player;
    p.setPosition(0.5, 64, 25.5);
    const input = new FakeInput();
    input.press('forward');
    run(game, input, 4);
    const speed = Math.abs(p.vz);
    input.release('forward');
    const z0 = p.z;
    run(game, input, 3);
    return { dist: z0 - p.z, speed };
  };
  const stone = slide(BLOCK.STONE);
  const ice = slide(BLOCK.ICE);
  near(stone.speed, 4.317, 0.01, 'stone walk speed');
  near(ice.speed, 4.157, 0.02, 'ice walk speed');
  near(stone.dist, 4.317 / 12.103, 0.01, 'stone stop distance');
  near(ice.dist, 4.157 / 2.290, 0.05, 'ice slide distance');
  assert.ok(ice.dist > 4 * stone.dist);
});

test('sprint-jumping covers ≈4.29 blocks per jump at any frame rate (Minecraft ≈4.28)', () => {
  const perJump = [];
  for (const fps of [30, 60, 144]) {
    const game = makeGame();
    const p = game.player;
    p.setPosition(0.5, 64, 30);
    p.yaw = 0;
    const input = new FakeInput();
    input.press('forward', 'sprint', 'jump');
    let jumps = 0, prevVy = 0, zStart = null, zEnd = null;
    run(game, input, 8, 1 / fps, () => {
      if (prevVy <= 0 && p.vy > 0) {          // take-off
        jumps++;
        if (jumps === 4) zStart = p.z;
        if (jumps === 9) zEnd = p.z;
      }
      prevVy = p.vy;
    });
    assert.ok(zEnd !== null, 'made enough jumps');
    perJump.push((zStart - zEnd) / 5);
  }
  for (const d of perJump) near(d, 4.29, 0.1, 'distance per sprint-jump');
  near(perJump[0], perJump[2], 0.08, 'frame-rate independent');
});

test('flying: double-tap Space toggles in creative only; single taps do not; landing ends flight', () => {
  const game = makeGame(new FakeWorld(), 'creative');
  const p = game.player;
  p.setPosition(0.5, 64, 0.5);
  const input = new FakeInput();
  run(game, input, 0.1);
  input.tap('jump');
  run(game, input, 0.6);
  assert.equal(p.flying, false, 'single tap = normal jump');
  run(game, input, 0.5);
  input.tap('jump');
  run(game, input, 0.15);
  input.press('jump');
  run(game, input, 0.1);
  assert.equal(p.flying, true, 'double tap toggles flight');
  run(game, input, 0.5);
  input.release('jump');
  run(game, input, 0.6);                               // vertical speed decays (0.6 per tick)
  const y = p.y;
  run(game, input, 1);
  near(p.y, y, 0.01, 'hovering while flying');
  assert.ok(p.y > 65.5);
  // Descend with Shift until touching the ground: flight ends.
  input.press('sneak');
  run(game, input, 2);
  assert.equal(p.onGround, true);
  assert.equal(p.flying, false, 'landing ends flight');
  assert.equal(p.health, 20);

  const s = makeGame(new FakeWorld(), 'survival');
  s.player.setPosition(0.5, 64, 0.5);
  const si = new FakeInput();
  for (let i = 0; i < 3; i++) { si.tap('jump'); run(s, si, 0.1); }
  assert.equal(s.player.flying, false, 'survival cannot fly');
});

test('double-tap W starts sprinting; sneaking or releasing W stops it', () => {
  const game = makeGame();
  const p = game.player;
  p.setPosition(0.5, 64, 0.5);
  const input = new FakeInput();
  run(game, input, 0.05);
  input.press('forward');
  run(game, input, 0.1);
  input.release('forward');
  run(game, input, 0.1);
  assert.equal(p.sprinting, false);
  input.press('forward');
  run(game, input, 0.1);
  assert.equal(p.sprinting, true, 'double tap within 0.35 s');
  input.press('sneak');
  run(game, input, 0.05);
  assert.equal(p.sprinting, false, 'sneaking stops sprint');
  input.release('sneak');
  input.press('sprint');
  run(game, input, 0.05);
  assert.equal(p.sprinting, true, 'Ctrl + W sprints');
  input.release('forward', 'sprint');
  run(game, input, 0.05);
  assert.equal(p.sprinting, false, 'releasing W stops sprint');
});

// ---------------------------------------------------------------------------------------------
// Swimming, damage, status effects
// ---------------------------------------------------------------------------------------------

test('swimming: slow sink 0.5 b/s, Space rises 3.5 b/s, Shift sinks 4.5 b/s, swim speed 1.96 b/s', () => {
  const world = new FakeWorld();
  world.fill(-8, 30, -8, 8, 90, 8, BLOCK.WATER);
  const measure = (startY, actions, axis = 'y') => {
    const game = makeGame(world);
    const p = game.player;
    p.setPosition(0.5, startY, 0.5);
    const input = new FakeInput();
    input.press(...actions);
    run(game, input, 2);
    const a0 = axis === 'y' ? p.y : p.z;
    run(game, input, 1);
    assert.equal(p.inWater, true);
    assert.equal(p.eyeInWater, true);
    return (axis === 'y' ? p.y : p.z) - a0;
  };
  near(measure(70, []), -0.5, 0.01, 'idle sink');
  near(measure(40, ['jump']), 3.5, 0.02, 'swim up');
  near(measure(80, ['sneak']), -4.5, 0.03, 'dive');
  near(-measure(60, ['forward'], 'z'), 1.96, 0.01, 'swim forward');
});

test('swimming against a ledge hops out of the water', () => {
  const world = new FakeWorld({ ground: 65 });       // solid up to y=64, standing level 65
  world.fill(-3, 64, -3, 3, 64, 3, BLOCK.WATER);      // 1-deep pool: floor 64, surface 64.875
  const game = makeGame(world);
  const p = game.player;
  p.setPosition(0.5, 64, 0.5);
  const input = new FakeInput();
  input.press('forward', 'jump');
  let hopAt = null;
  run(game, input, 3, 1 / 60, (i, t) => { if (hopAt === null && p.y >= 65) hopAt = t; });
  input.release('forward', 'jump');
  run(game, input, 1);
  assert.ok(hopAt !== null && hopAt < 2.2, `hopped out at ${hopAt}s`);
  assert.equal(p.y, 65, 'standing on the ledge');
  assert.ok(p.z < -3.3 && !p.inWater);
  assert.equal(p.health, 20);
  // Without Space the feet stay too deep: no hop.
  const g2 = makeGame(world);
  g2.player.setPosition(0.5, 64, 0.5);
  const i2 = new FakeInput();
  i2.press('forward');
  run(g2, i2, 3);
  assert.ok(g2.player.y < 64.5, 'no hop without swimming up');
});

function fallFrom(height, { mode = 'survival', setup } = {}) {
  const world = new FakeWorld();
  setup?.(world);
  const game = makeGame(world, mode);
  const p = game.player;
  p.food = 17;                               // no natural regeneration while measuring damage
  p.setPosition(0.5, 64 + height, 0.5);
  run(game, new FakeInput(), Math.sqrt(height / 10) + 1.5);
  return game;
}

test('fall damage = ceil(distance - 3); not into water; not in creative', () => {
  for (const [h, dmg] of [[1.25, 0], [3, 0], [3.5, 1], [4, 1], [10, 7], [22, 19]]) {
    const g = fallFrom(h);
    assert.equal(g.player.onGround, true);
    assert.equal(g.player.health, 20 - dmg, `fall ${h}`);
    if (dmg > 0) {
      assert.ok(g.sounds.includes('hurt'), 'hurt sound');
      assert.ok(g.sounds.includes(dmg > 4 ? 'fall_big' : 'fall_small'), 'fall damage sound');
      assert.ok(g.particles.hits > 0, 'landing dust');
    }
    if (h >= 1) assert.ok(g.sounds.includes('land:stone'), 'landing sound');
  }
  const dead = fallFrom(23);
  assert.equal(dead.player.dead, true);
  assert.deepEqual(dead.events.find((e) => e[0] === 'playerDied'), ['playerDied', '玩家摔死了']);
  assert.ok(dead.sounds.includes('death'));
  const water = fallFrom(30, { setup: (w) => w.set(0, 64, 0, BLOCK.WATER) });
  assert.equal(water.player.health, 20, 'landing in 1-deep water is safe');
  assert.ok(water.sounds.includes('splash'));
  assert.equal(fallFrom(30, { mode: 'creative' }).player.health, 20, 'creative takes no fall damage');
});

test('drowning: 15 s of air, then 2 damage per second; air refills outside water', () => {
  const world = new FakeWorld();
  world.fill(-4, 64, -4, 4, 75, 4, BLOCK.WATER);
  const game = makeGame(world);
  const p = game.player;
  p.food = 17;                               // no natural regeneration
  p.setPosition(0.5, 64, 0.5);
  const input = new FakeInput();
  run(game, input, 14.9);
  assert.equal(p.health, 20);
  near(p.air, 2, 2.5, 'air nearly gone');
  run(game, input, 0.2);
  assert.equal(p.air, 0);
  assert.equal(p.health, 20, 'no damage at the moment air runs out');
  run(game, input, 0.95);                    // t = 16.05
  assert.equal(p.health, 18, 'first drowning hit 1 s after air ran out');
  run(game, input, 1);                       // t = 17.05
  assert.equal(p.health, 16);
  p.setPosition(10.5, 64, 10.5);             // out of the water
  run(game, input, 1);
  near(p.air, 80, 1.5, 'air refills 4 ticks per tick');
  run(game, input, 3);
  assert.equal(p.air, MAX_AIR);
  p.setPosition(0.5, 64, 0.5);
  run(game, input, 40);
  assert.equal(p.dead, true);
  assert.equal(p.deathMessage, '玩家淹死了');
});

test('lava: 4 damage every 0.5 s, sets the player on fire; water extinguishes', () => {
  const world = new FakeWorld();
  world.fill(-3, 64, -3, 3, 65, 3, BLOCK.LAVA);
  world.fill(10, 64, 10, 12, 64, 12, BLOCK.WATER);
  const game = makeGame(world);
  const p = game.player;
  p.food = 17;                               // no natural regeneration
  p.setPosition(0.5, 64.5, 0.5);
  const input = new FakeInput();
  run(game, input, 1 / 60);
  assert.equal(p.inLava, true);
  assert.equal(p.health, 16);
  assert.ok(p.onFire && p.hurtTime > 0);
  run(game, input, 0.4);
  assert.equal(p.health, 16, 'hurt cooldown');
  run(game, input, 0.15);
  assert.equal(p.health, 12);
  // Climb out: burning keeps hurting 1 per second, water puts it out.
  p.setPosition(20.5, 64, 20.5);
  run(game, input, 2.05);
  assert.ok(p.health <= 11 && p.health >= 10, `fire damage (health ${p.health})`);
  p.setPosition(11.5, 64, 11.5);
  run(game, input, 0.1);
  assert.equal(p.onFire, false, 'water extinguishes');
  const h = p.health;
  run(game, input, 2);
  assert.ok(p.health >= h);
  p.setPosition(0.5, 64.5, 0.5);
  run(game, input, 3);
  assert.equal(p.dead, true);
  assert.equal(p.deathMessage, DEATH_MESSAGES.lava);
  assert.equal(DEATH_MESSAGES.lava, '玩家试图在熔岩里游泳');
});

test('cactus contact, void and suffocation damage; regeneration +1 HP per 4 s', () => {
  const world = new FakeWorld();
  world.set(0, 64, -2, BLOCK.CACTUS);
  const game = makeGame(world);
  const p = game.player;
  p.food = 17;                               // no natural regeneration while measuring damage
  p.setPosition(0.5, 64, 0.5);
  const input = new FakeInput();
  input.press('forward');
  run(game, input, 1);
  near(p.z, -1 - 1 / 16 + 0.3, 1e-6, 'blocked by the inset cactus box');
  assert.ok(p.health <= 19 && p.health >= 18, `cactus hurts (health ${p.health})`);
  input.release('forward');
  p.setPosition(5.5, 64, 5.5);
  p.health = 10;
  p.food = 20;                               // food >= 18 without saturation: slow regeneration
  p.saturation = 0;
  p.exhaustion = 0;
  run(game, input, 4.05);
  assert.equal(p.health, 11, 'regen after 4 s');
  run(game, input, 4);
  assert.equal(p.health, 12);
  assert.equal(p.food, 18, 'two healed points cost 12 exhaustion: 2 food points (+4 pending)');
  near(p.exhaustion, 4, 0.01);
  p.food = 17;
  // Suffocation: head inside stone.
  world.set(5, 65, 5, BLOCK.STONE);
  run(game, input, 0.05);
  assert.equal(p.health, 11);
  world.set(5, 65, 5, BLOCK.AIR);
  // Void: also kills creative players.
  const g2 = makeGame(new FakeWorld(), 'creative');
  g2.player.setPosition(0.5, -70, 0.5);
  run(g2, new FakeInput(), 0.05);
  assert.equal(g2.player.health, 16);
  run(g2, new FakeInput(), 3);
  assert.equal(g2.player.dead, true);
  assert.equal(g2.player.deathMessage, '玩家掉出了这个世界');
});

test('damage rules: creative immunity, hurt cooldown only lets bigger hits through', () => {
  const game = makeGame();
  const p = game.player;
  p.food = 17;                               // no natural regeneration
  assert.equal(p.damage(3, 'generic'), true);
  assert.equal(p.health, 17);
  assert.equal(p.hurtTime, 0.5);
  assert.equal(p.damage(2, 'generic'), false, 'smaller hit during cooldown');
  assert.equal(p.damage(5, 'generic'), true, 'bigger hit applies the difference');
  assert.equal(p.health, 15);
  run(game, new FakeInput(), 0.55);
  assert.equal(p.damage(1, 'generic'), true);
  assert.equal(p.health, 14);
  p.setGameMode('creative');
  run(game, new FakeInput(), 1);
  assert.equal(p.damage(10, 'fall'), false);
  assert.equal(p.damage(4, 'void'), true);
  p.heal(100);
  assert.equal(p.health, 20);
});

test('death drops the survival inventory, emits playerDied; respawn on top of the spawn column', () => {
  const world = new FakeWorld();
  world.fill(10, 64, 10, 10, 69, 10, BLOCK.STONE);   // pillar: column top y = 69
  const game = makeGame(world);
  const p = game.player;
  p.setPosition(0.5, 64, 0.5);
  p.inventory.add(makeStack(BLOCK.DIRT, 40));
  p.inventory.add(makeStack(ITEM.IRON_PICKAXE, 1));
  p.inventory.set(20, makeStack(BLOCK.STONE, 5));
  p.air = 100;
  p.damage(25, 'explosion');
  assert.equal(p.dead, true);
  assert.equal(p.deathMessage, '玩家爆炸了');
  assert.equal(game.spawned.length, 3);
  assert.ok(game.spawned.every((s) => s.delay === 2 && s.vy > 0));
  assert.equal(p.inventory.isEmpty(), true);
  assert.deepEqual(game.events.at(-1), ['playerDied', '玩家爆炸了']);
  // Dead players do not move.
  const input = new FakeInput();
  input.press('forward');
  const z = p.z;
  run(game, input, 0.5);
  assert.equal(p.z, z);
  assert.ok(p.getCameraState().roll !== 0, 'death tilt');
  p.spawnPoint = { x: 10, y: 0, z: 10 };
  p.respawn();
  assert.equal(p.dead, false);
  assert.equal(p.health, 20);
  assert.equal(p.air, MAX_AIR);
  assert.deepEqual([p.x, p.y, p.z], [10.5, 70, 10.5]);
  assert.deepEqual(game.events.at(-1), ['playerRespawned']);
  // Creative deaths keep the inventory.
  const g2 = makeGame(new FakeWorld(), 'creative');
  g2.player.inventory.add(makeStack(BLOCK.DIRT, 3));
  g2.player.kill();
  assert.equal(g2.player.dead, true);
  assert.equal(g2.spawned.length, 0);
  assert.equal(g2.player.inventory.count(BLOCK.DIRT), 3);
});

test('physics freezes until world.isAreaReady(x, z, 1); respawn snaps once the column loads', () => {
  const world = new FakeWorld();
  world.ready = false;
  const calls = [];
  const orig = world.isAreaReady.bind(world);
  world.isAreaReady = (x, z, r) => { calls.push([x, z, r]); return orig(); };
  const game = makeGame(world);
  const p = game.player;
  p.spawnPoint = { x: 3, y: 120, z: 4 };
  p.respawn({ emit: false });
  assert.deepEqual([p.x, p.y, p.z], [3.5, 120, 4.5], 'not snapped while the area is not ready');
  const input = new FakeInput();
  input.press('forward');
  input.mouseDX = 100;
  game.player.update(1 / 60, input);
  assert.equal(p.frozen, true);
  near(p.yaw, -100 * LOOK_RADIANS_PER_UNIT, 1e-9, 'looking around still works');
  run(game, input, 1);
  assert.deepEqual([p.x, p.y, p.z], [3.5, 120, 4.5]);
  assert.deepEqual(calls[0], [3, 4, 1]);
  world.ready = true;
  game.player.update(1 / 60, new FakeInput());
  assert.equal(p.frozen, false);
  assert.equal(p.y, 64, 'snapped on top of the column');
  assert.equal(game.events.length, 0, 'respawn({ emit: false }) is silent');
  // Without a heightmap answer the column is scanned.
  world.getTopY = () => -1;
  world.set(3, 64, 4, BLOCK.OAK_PLANKS);
  p.respawn({ emit: false });
  assert.equal(p.y, 65);
});

test('camera: sprint FOV +10 % eased, underwater FOV, view bobbing, hurt tilt, look clamp', () => {
  const world = new FakeWorld();
  const game = makeGame(world);
  const p = game.player;
  p.setPosition(0.5, 64, 25.5);
  const input = new FakeInput();
  run(game, input, 0.1);
  let cam = p.getCameraState();
  assert.equal(cam.fov, 70);
  near(cam.y, 64 + 1.62, 1e-9);
  assert.equal(cam.roll, 0);
  input.press('forward', 'sprint');
  run(game, input, 1 / 60);
  cam = p.getCameraState();
  assert.ok(cam.fov > 70 && cam.fov < 77, 'FOV eases toward +10 %');
  let maxDy = 0, maxRoll = 0;
  run(game, input, 1, 1 / 60, () => {
    const c = p.getCameraState();
    maxDy = Math.max(maxDy, Math.abs(c.y - (p.y + 1.62)));
    maxRoll = Math.max(maxRoll, Math.abs(c.roll));
  });
  near(p.getCameraState().fov, 77, 0.01, 'sprint FOV');
  assert.ok(maxDy > 0.05 && maxDy <= 0.1 + 1e-9, `view bob height ${maxDy}`);
  assert.ok(maxRoll > 0 && maxRoll < 0.3 * Math.PI / 180 + 1e-9, `view bob roll ${maxRoll}`);
  game.settings.viewBobbing = false;
  cam = p.getCameraState();
  near(cam.y, p.y + 1.62, 1e-9, 'no bobbing when disabled');
  input.release('forward', 'sprint');
  run(game, input, 1);
  near(p.getCameraState().fov, 70, 0.01);
  p.damage(1, 'generic');
  run(game, input, 0.05);
  assert.ok(p.getCameraState().roll > 0.05, 'hurt tilt');
  run(game, input, 0.5);
  assert.equal(p.getCameraState().roll, 0);
  // Mouse look: right = yaw decreases; pitch clamps at ±89.9°.
  const yaw0 = p.yaw;
  input.mouseDX = 200;
  input.mouseDY = -100000;
  game.player.update(1 / 60, input);
  near(p.yaw, yaw0 - 200 * LOOK_RADIANS_PER_UNIT, 1e-9);
  near(p.pitch, 89.9 * Math.PI / 180, 1e-9);
  // Under water: narrower FOV.
  world.fill(-2, 64, -2, 2, 70, 2, BLOCK.WATER);
  p.setPosition(0.5, 64, 0.5);
  run(game, new FakeInput(), 0.1);
  assert.equal(p.eyeInWater, true);
  near(p.getCameraState().fov, 60, 1e-6);
});

test('third-person cameras (F5): 4 blocks behind / in front, pulled in by walls', () => {
  const world = new FakeWorld();
  const game = makeGame(world);
  const p = game.player;
  p.setPosition(0.5, 64, 0.5);
  run(game, new FakeInput(), 0.05);
  p.yaw = 0; p.pitch = 0;
  game.settings.viewBobbing = false;
  const back = { ...p.getCameraState(undefined, 1) };
  near(back.z, 0.5 + 4 - 0.05, 1e-9, 'behind the player (south when looking north)');
  near(back.y, 64 + 1.62, 1e-9);
  assert.equal(back.yaw, 0);
  const front = { ...p.getCameraState(undefined, 2) };
  near(front.z, 0.5 - 4 + 0.05, 1e-9, 'in front, looking back');
  near(front.yaw, Math.PI, 1e-12);
  world.fill(-3, 64, 2, 3, 67, 2, BLOCK.STONE);        // wall 1.5 blocks behind the player's centre
  const clipped = p.getCameraState(undefined, 1);
  assert.ok(clipped.z < 2 && clipped.z > 1.2, `camera pulled in front of the wall (z=${clipped.z})`);
  near(p.getCameraState().z, 0.5, 1e-9, 'first person unchanged');
});

test('eyeInWater uses the liquid surface (source 8/9, full height under water)', () => {
  const world = new FakeWorld();
  world.set(0, 64, 0, BLOCK.WATER);
  world.set(0, 65, 0, BLOCK.WATER);                    // surface at 65 + 8/9 = 65.889
  const game = makeGame(world, 'creative');
  const p = game.player;
  const check = (feetY) => {
    p.setPosition(0.5, feetY, 0.5);
    p.flying = true;
    p.update(1e-6, new FakeInput());
    return p.eyeInWater;
  };
  assert.equal(check(65 + 8 / 9 - 1.62 - 0.005), true);
  assert.equal(check(65 + 8 / 9 - 1.62 + 0.005), false);
  assert.equal(check(64.5 - 1.62), true, 'full height where water is above');
});

test('serialize / deserialize round trip keeps the inventory object', () => {
  const game = makeGame(new FakeWorld(), 'creative');
  const p = game.player;
  p.setPosition(1.25, 70, -3.5);
  p.yaw = 1; p.pitch = -0.5; p.flying = true; p.health = 13; p.air = 120; p.selectedSlot = 4;
  p.spawnPoint = { x: 7, y: 65, z: 9 };
  p.inventory.add(makeStack(BLOCK.GLASS, 12));
  const data = JSON.parse(JSON.stringify(p.serialize()));
  const g2 = makeGame();
  const inv = g2.player.inventory;
  g2.player.deserialize(data);
  const q = g2.player;
  assert.equal(q.inventory, inv);
  assert.deepEqual([q.x, q.y, q.z, q.yaw, q.pitch], [1.25, 70, -3.5, 1, -0.5]);
  assert.equal(q.mode, 'creative');
  assert.equal(q.flying, true);
  assert.equal(q.health, 13);
  assert.equal(q.air, 120);
  assert.equal(q.selectedSlot, 4);
  assert.deepEqual(q.spawnPoint, { x: 7, y: 65, z: 9 });
  assert.equal(q.inventory.count(BLOCK.GLASS), 12);
  g2.player.deserialize({ health: 'x', mode: 'hacker', inventory: 5, selectedSlot: 99 });
  assert.equal(q.mode, 'survival');
  assert.equal(q.selectedSlot, 8);
  assert.equal(q.health, 20);
});

// ---------------------------------------------------------------------------------------------
// Interaction
// ---------------------------------------------------------------------------------------------

/** Player standing at (0.5, 64, 0.5) on flat stone, optionally holding `item` in slot 0. */
function aimGame({ mode = 'survival', setup, item } = {}) {
  const world = new FakeWorld();
  setup?.(world);
  const game = makeGame(world, mode);
  const p = game.player;
  p.setPosition(0.5, 64, 0.5);
  run(game, new FakeInput(), 0.05);
  if (item) p.inventory.set(0, item);
  return game;
}

test('targeting: reach 4.5 (survival) / 5 (creative) from the eye; liquids are skipped', () => {
  const setup = (w) => { w.set(0, 65, -5, BLOCK.STONE); w.set(0, 65, -2, BLOCK.WATER); };
  for (const [mode, hit] of [['survival', false], ['creative', true]]) {
    const game = aimGame({ mode, setup });
    const p = game.player;
    p.yaw = 0;
    p.pitch = 0;
    p.setPosition(0.5, 64, 0.8);                       // eye level ray to the face at z = -4: 4.8 away
    run(game, new FakeInput(), 1 / 60);
    const t = game.interaction.target;
    if (hit) assert.deepEqual([t.x, t.y, t.z, t.face, t.blockId], [0, 65, -5, 4, BLOCK.STONE]);
    else assert.equal(t, null, 'out of survival reach (4.8 > 4.5)');
  }
});

test('breaking stone with a wooden pickaxe takes 1.15 s: cracks, hit sounds, drop pop, durability', () => {
  const game = aimGame({ setup: (w) => w.set(0, 64, -2, BLOCK.STONE), item: makeStack(ITEM.WOODEN_PICKAXE, 1) });
  const p = game.player, world = game.world, it = game.interaction;
  lookAt(p, 0.5, 64.5, -1);
  const input = new FakeInput();
  run(game, input, 1 / 60);
  assert.deepEqual([it.target.x, it.target.y, it.target.z, it.target.face], [0, 64, -2, 4]);
  input.press('attack');
  let brokeAt = null;
  const stages = [];
  run(game, input, 2, 1 / 60, (i, t) => {
    if (brokeAt === null && world.getBlock(0, 64, -2) === 0) brokeAt = t;
    if (brokeAt === null && it.breaking) stages.push(it.breaking.stage);
  });
  near(brokeAt, 1.15, 1 / 60 + 1e-9, 'break time');
  assert.equal(stages[0], 0);
  assert.equal(stages.at(-1), 9);
  assert.ok(stages.every((s, i) => i === 0 || s >= stages[i - 1]), 'crack stages only grow');
  const hits = game.sounds.filter((s) => s === 'hit:stone').length;
  assert.ok(hits >= 6 && hits <= 9, `hit sounds ${hits}`);
  assert.ok(game.sounds.includes('break:stone'));
  assert.equal(game.particles.breaks, 1);
  assert.ok(game.particles.hits >= 10);
  assert.equal(game.spawned.length, 1);
  const drop = game.spawned[0];
  assert.deepEqual(drop.stack, { id: BLOCK.COBBLESTONE, count: 1, damage: 0 });
  assert.equal(drop.delay, 0.5);
  near(drop.vy, 4, 1e-9);
  assert.ok(Math.abs(drop.vx) <= 2 && Math.abs(drop.vz) <= 2);
  assert.ok(Math.abs(drop.x - 0.5) <= 0.25 && Math.abs(drop.z + 1.5) <= 0.25);
  assert.equal(p.inventory.get(0).damage, 1, 'pickaxe durability −1');
  assert.ok(it.getHandState().swing > 0, 'arm swings while mining');
});

test('stone by hand takes 7.5 s and drops nothing; dirt 0.75 s with a 0.25 s delay between blocks', () => {
  const game = aimGame({ setup: (w) => w.set(0, 64, -2, BLOCK.STONE) });
  lookAt(game.player, 0.5, 64.5, -1);
  const input = new FakeInput();
  input.press('attack');
  let brokeAt = null;
  run(game, input, 7.7, 1 / 20, (i, t) => { if (brokeAt === null && game.world.getBlock(0, 64, -2) === 0) brokeAt = t; });
  near(brokeAt, 7.5, 0.051);
  assert.equal(game.spawned.length, 0, 'stone needs a pickaxe to drop');

  const g2 = aimGame({ setup: (w) => { w.set(0, 65, -2, BLOCK.DIRT); w.set(0, 65, -3, BLOCK.GRASS_BLOCK); } });
  lookAt(g2.player, 0.5, 65.62, -1);
  const i2 = new FakeInput();
  i2.press('attack');
  const times = [];
  run(g2, i2, 2.2, 1 / 60, (i, t) => {
    if (times.length === 0 && g2.world.getBlock(0, 65, -2) === 0) times.push(t);
    if (times.length === 1 && g2.world.getBlock(0, 65, -3) === 0) times.push(t);
  });
  near(times[0], 0.75, 1 / 60 + 1e-9, 'dirt by hand');
  near(times[1], 0.75 + 0.25 + 0.9, 2 / 60 + 1e-9, 'grass after the 5-tick delay');
  assert.deepEqual(g2.spawned.map((s) => s.stack.id), [BLOCK.DIRT, BLOCK.DIRT], 'grass block drops dirt');
});

test('instant blocks break on contact; bedrock never breaks in survival but does in creative', () => {
  const game = aimGame({ setup: (w) => w.set(0, 65, -2, BLOCK.TNT), item: makeStack(ITEM.STONE_PICKAXE, 1) });
  lookAt(game.player, 0.5, 65.62, -1);
  const input = new FakeInput();
  input.press('attack');
  run(game, input, 2 / 60);
  assert.equal(game.world.getBlock(0, 65, -2), 0);
  assert.equal(game.spawned[0].stack.id, BLOCK.TNT);
  assert.equal(game.player.inventory.get(0).damage, 0, 'instant blocks do not wear tools');

  const g2 = aimGame({ setup: (w) => w.set(0, 65, -2, BLOCK.BEDROCK), item: makeStack(ITEM.DIAMOND_PICKAXE, 1) });
  lookAt(g2.player, 0.5, 65.62, -1);
  const i2 = new FakeInput();
  i2.press('attack');
  run(g2, i2, 3);
  assert.equal(g2.world.getBlock(0, 65, -2), BLOCK.BEDROCK);
  assert.equal(g2.interaction.breaking, null);
  assert.ok(g2.sounds.includes('hit:stone'), 'hit feedback on bedrock');

  const g3 = aimGame({ mode: 'creative', setup: (w) => w.set(0, 65, -2, BLOCK.BEDROCK) });
  lookAt(g3.player, 0.5, 65.62, -1);
  const i3 = new FakeInput();
  i3.press('attack');
  run(g3, i3, 1 / 60);
  assert.equal(g3.world.getBlock(0, 65, -2), 0);
  assert.equal(g3.spawned.length, 0, 'creative: no drops');
});

test('creative: instant breaking repeats every 0.15 s while held; swords cannot break', () => {
  for (const [item, expected] of [[null, [6, 7]], [makeStack(ITEM.DIAMOND_SWORD, 1), [0, 0]]]) {
    const game = aimGame({ mode: 'creative', setup: (w) => w.set(0, 65, -2, BLOCK.STONE), item });
    lookAt(game.player, 0.5, 65.62, -1);
    const input = new FakeInput();
    input.press('attack');
    let breaks = 0;
    run(game, input, 1, 1 / 60, () => {
      if (game.world.getBlock(0, 65, -2) === 0) { breaks++; game.world.set(0, 65, -2, BLOCK.STONE); }
    });
    if (game.world.getBlock(0, 65, -2) === 0) breaks++;
    assert.ok(breaks >= expected[0] && breaks <= expected[1], `breaks ${breaks}`);
    assert.equal(game.spawned.length, 0);
  }
});

test('survival-broken ice melts into water above solid ground; creative removes it', () => {
  for (const [mode, below, expected] of [['survival', BLOCK.STONE, BLOCK.WATER], ['survival', BLOCK.AIR, BLOCK.AIR], ['creative', BLOCK.STONE, BLOCK.AIR]]) {
    const game = aimGame({ mode, setup: (w) => { w.set(0, 65, -2, BLOCK.ICE); w.set(0, 64, -2, below); } });
    lookAt(game.player, 0.5, 65.62, -1);
    const input = new FakeInput();
    input.press('attack');
    run(game, input, 1);
    assert.equal(game.world.getBlock(0, 65, -2), expected, `${mode} over ${below}`);
    assert.equal(game.spawned.length, 0, 'ice drops nothing');
  }
});

test('tool durability: −1 per block, swords −2, broken tools vanish with a sound', () => {
  const g = aimGame({ setup: (w) => w.set(0, 65, -2, BLOCK.DIRT), item: makeStack(ITEM.WOODEN_PICKAXE, 1, 58) });
  lookAt(g.player, 0.5, 65.62, -1);
  const input = new FakeInput();
  input.press('attack');
  run(g, input, 1);
  assert.equal(g.world.getBlock(0, 65, -2), 0);
  assert.equal(g.player.inventory.get(0), null, 'pickaxe used up (59 uses)');
  assert.ok(g.sounds.includes('break_tool'));

  const g2 = aimGame({ setup: (w) => w.set(0, 65, -2, BLOCK.DIRT), item: makeStack(ITEM.WOODEN_SWORD, 1) });
  lookAt(g2.player, 0.5, 65.62, -1);
  const i2 = new FakeInput();
  i2.press('attack');
  run(g2, i2, 1);
  assert.equal(g2.player.inventory.get(0).damage, 2, 'swords lose 2 per block');
});

test('placing: neighbour cell, never inside the player, replaceable targets, through water, consumption', () => {
  const game = aimGame({
    item: makeStack(BLOCK.DIRT, 10),
    setup: (w) => { w.set(1, 64, -2, BLOCK.SHORT_GRASS); w.set(-1, 64, -2, BLOCK.WATER); },
  });
  const p = game.player, world = game.world, it = game.interaction;
  const input = new FakeInput();
  const click = () => { run(game, input, 1 / 60); input.tap('use'); run(game, input, 1 / 60); input.release('use'); };
  // Straight down: the cell above the clicked block is where the player stands.
  p.yaw = 0; p.pitch = -Math.PI / 2 + 1e-3;
  click();
  assert.equal(world.getBlock(0, 64, 0), 0, 'refused inside the player');
  assert.equal(p.inventory.get(0).count, 10);
  // Ground two blocks north.
  lookAt(p, 0.5, 64, -1.5);
  run(game, input, 1 / 60);
  assert.deepEqual([it.target.x, it.target.y, it.target.z, it.target.face], [0, 63, -2, 2]);
  click();
  assert.equal(world.getBlock(0, 64, -2), BLOCK.DIRT);
  assert.equal(p.inventory.get(0).count, 9, 'survival consumes one');
  assert.ok(game.sounds.includes('place:gravel'));
  assert.ok(it.getHandState().swing > 0, 'placing swings the arm');
  // Short grass is replaced in place (not stacked on top).
  lookAt(p, 1.5, 64.3, -1.5);
  click();
  assert.equal(world.getBlock(1, 64, -2), BLOCK.DIRT);
  assert.equal(world.getBlock(1, 65, -2), 0);
  // Water is not targetable: the ray hits the floor below and the block replaces the water.
  lookAt(p, -0.5, 64, -1.5);
  run(game, input, 1 / 60);
  assert.deepEqual([it.target.x, it.target.y, it.target.z], [-1, 63, -2]);
  click();
  assert.equal(world.getBlock(-1, 64, -2), BLOCK.DIRT);
  assert.equal(p.inventory.get(0).count, 7);
  // Creative never consumes.
  p.setGameMode('creative');
  lookAt(p, 0.5, 65, -1.5);
  click();
  assert.equal(world.getBlock(0, 65, -2), BLOCK.DIRT);
  assert.equal(p.inventory.get(0).count, 7);
});

test('placing: support rules (torches, flowers) and orientation variants (logs, furnaces)', () => {
  const game = aimGame({
    setup: (w) => { w.set(0, 66, -2, BLOCK.STONE); w.set(2, 63, -2, BLOCK.GRASS_BLOCK); },
  });
  const p = game.player, world = game.world, inv = p.inventory;
  const input = new FakeInput();
  const clickAt = (x, y, z) => { lookAt(p, x, y, z); run(game, input, 1 / 60); input.tap('use'); run(game, input, 1 / 60); input.release('use'); };
  inv.set(0, makeStack(BLOCK.TORCH, 4));
  clickAt(0.5, 66.5, -1);                              // south face of the floating block
  assert.equal(world.getBlock(0, 66, -1), BLOCK.WALL_TORCH_SOUTH, 'clicking a wall face attaches a wall torch');
  world.set(0, 66, -1, 0);
  clickAt(0.5, 64, -1.5);
  assert.equal(world.getBlock(0, 64, -2), BLOCK.TORCH, 'torch on the ground');
  inv.set(0, makeStack(BLOCK.DANDELION, 4));
  clickAt(-0.5, 64, -1.5);
  assert.equal(world.getBlock(-1, 64, -2), 0, 'flowers do not grow on stone');
  clickAt(2.5, 64, -1.5);
  assert.equal(world.getBlock(2, 64, -2), BLOCK.DANDELION, 'flower on grass');
  inv.set(0, makeStack(BLOCK.OAK_LOG, 4));
  clickAt(0.5, 66.5, -1);
  assert.equal(world.getBlock(0, 66, -1), BLOCK.OAK_LOG_Z, 'log axis follows the clicked face');
  clickAt(1.5, 64, -0.5);
  assert.equal(world.getBlock(1, 64, -1), BLOCK.OAK_LOG, 'upright log on a top face');
  inv.set(0, makeStack(BLOCK.FURNACE, 1));
  clickAt(-1.5, 64, 0.5);                              // looking due west
  assert.equal(world.getBlock(-2, 64, 0), BLOCK.FURNACE_EAST, 'furnace front faces the player (east)');
});

test('placing is refused where an entity stands (items do not block); repeats every 0.2 s', () => {
  const game = aimGame({ mode: 'creative', item: makeStack(BLOCK.STONE, 64) });
  const p = game.player, world = game.world;
  const input = new FakeInput();
  lookAt(p, 0.5, 64, -1.5);
  const click = () => { run(game, input, 1 / 60); input.tap('use'); run(game, input, 1 / 60); input.release('use'); };
  game.entities = { entities: [{ kind: 'item', x: 0.5, y: 64, z: -1.5, width: 0.25, height: 0.25 }] };
  click();
  assert.equal(world.getBlock(0, 64, -2), BLOCK.STONE, 'item entities never block placement');
  world.set(0, 64, -2, 0);
  game.entities = { entities: [{ x: 0.4, y: 64, z: -1.6, width: 0.9, height: 1.4 }] };
  click();
  assert.equal(world.getBlock(0, 64, -2), 0, 'refused: a mob stands there');
  const box = { minX: 0, minY: 64, minZ: -2, maxX: 1, maxY: 65, maxZ: -1 };
  game.entities = { anyEntityInBox: (b) => b.minX === box.minX && b.minZ === box.minZ };
  click();
  assert.equal(world.getBlock(0, 64, -2), 0, 'anyEntityInBox hook');
  game.entities = null;
  input.press('use');
  let placed = 0;
  run(game, input, 1, 1 / 60, () => {
    if (world.getBlock(0, 64, -2)) { placed++; world.set(0, 64, -2, 0); }
  });
  assert.equal(placed, 5, 'held right button places every 4 ticks');
});

test('no placing while mining a block in survival', () => {
  const game = aimGame({ setup: (w) => w.set(0, 64, -2, BLOCK.STONE), item: makeStack(BLOCK.DIRT, 5) });
  const p = game.player;
  lookAt(p, 0.5, 64.5, -1);
  const input = new FakeInput();
  input.press('attack');
  run(game, input, 0.3);
  input.tap('use');
  run(game, input, 0.1);
  assert.equal(game.world.getBlock(0, 64, -1), 0);
  assert.equal(p.inventory.get(0).count, 5);
});

test('use: crafting table opens the UI (not when sneaking with an item); onInteractBlock hook', () => {
  const game = aimGame({ setup: (w) => { w.set(0, 64, -2, BLOCK.CRAFTING_TABLE); w.set(2, 64, -2, BLOCK.FURNACE); } });
  const p = game.player, world = game.world;
  const input = new FakeInput();
  const clickAt = (x, y, z) => { lookAt(p, x, y, z); run(game, input, 1 / 60); input.tap('use'); run(game, input, 1 / 60); input.release('use'); };
  clickAt(0.5, 64.5, -1);
  assert.equal(game.ui.crafting, 1, 'empty hand opens the crafting table');
  input.press('sneak');
  clickAt(0.5, 64.5, -1);
  assert.equal(game.ui.crafting, 2, 'sneaking with an empty hand still opens it');
  p.inventory.set(0, makeStack(BLOCK.DIRT, 3));
  clickAt(0.5, 64.5, -1);
  assert.equal(game.ui.crafting, 2, 'sneak + item: no interaction');
  assert.equal(world.getBlock(0, 64, -1), BLOCK.DIRT, '... places against the table instead');
  input.release('sneak');
  world.set(0, 64, -1, 0);
  run(game, input, 0.3);                               // stand up (eye height eases back)
  clickAt(0.5, 64.5, -1);
  assert.equal(game.ui.crafting, 3);
  const calls = [];
  game.onInteractBlock = (x, y, z, id, ctx) => { calls.push([x, y, z, id, ctx.itemId, ctx.face]); };
  clickAt(2.5, 64.5, -1);
  assert.deepEqual(calls, [[2, 64, -2, BLOCK.FURNACE, BLOCK.DIRT, 4]]);
  assert.equal(world.getBlock(2, 64, -1), 0, 'handled: nothing placed');
  game.onInteractBlock = () => false;
  clickAt(2.5, 64.5, -1);
  assert.equal(world.getBlock(2, 64, -1), BLOCK.DIRT, 'returning false falls through to placement');
});

test('buckets scoop and pour water / lava', () => {
  const game = aimGame({
    item: makeStack(ITEM.BUCKET, 1),
    setup: (w) => { w.set(0, 64, -2, BLOCK.WATER); w.set(2, 64, -2, BLOCK.LAVA); },
  });
  const p = game.player, world = game.world, inv = p.inventory;
  const input = new FakeInput();
  const clickAt = (x, y, z) => { lookAt(p, x, y, z); run(game, input, 1 / 60); input.tap('use'); run(game, input, 1 / 60); input.release('use'); };
  clickAt(0.5, 64.8, -1.5);
  assert.equal(world.getBlock(0, 64, -2), 0, 'water scooped');
  assert.equal(inv.get(0).id, ITEM.WATER_BUCKET);
  clickAt(1.5, 64, -2.5);
  assert.equal(world.getBlock(1, 64, -3), BLOCK.WATER, 'water poured on the clicked face');
  assert.equal(inv.get(0).id, ITEM.BUCKET);
  inv.set(0, makeStack(ITEM.BUCKET, 3));
  clickAt(2.5, 64.8, -1.5);
  assert.equal(world.getBlock(2, 64, -2), 0);
  assert.equal(inv.get(0).count, 2);
  assert.equal(inv.count(ITEM.LAVA_BUCKET), 1, 'filled bucket goes to another slot');
  const c = aimGame({ mode: 'creative', item: makeStack(ITEM.BUCKET, 1), setup: (w) => w.set(0, 64, -2, BLOCK.WATER) });
  lookAt(c.player, 0.5, 64.8, -1.5);
  const ci = new FakeInput();
  run(c, ci, 1 / 60);
  ci.tap('use');
  run(c, ci, 1 / 60);
  assert.equal(c.player.inventory.get(0).id, ITEM.BUCKET, 'creative keeps the empty bucket');
  assert.equal(c.player.inventory.count(ITEM.WATER_BUCKET), 1);
});

test('pick block (middle click): creative fills the hotbar, survival selects / swaps existing stacks', () => {
  const setup = (w) => { w.set(0, 64, -2, BLOCK.STONE); w.set(1, 64, -2, BLOCK.OAK_LOG_X); };
  const game = aimGame({ mode: 'creative', setup });
  const p = game.player, inv = p.inventory;
  const input = new FakeInput();
  const pickAt = (x, y, z) => { lookAt(p, x, y, z); run(game, input, 1 / 60); input.tap('pickBlock'); run(game, input, 1 / 60); };
  p.selectedSlot = 3;
  pickAt(0.5, 64.5, -1);
  assert.deepEqual(inv.get(3), { id: BLOCK.STONE, count: 1, damage: 0 });
  pickAt(1.5, 64.5, -1);
  assert.equal(p.selectedSlot, 4, 'next empty hotbar slot');
  assert.equal(inv.get(4).id, BLOCK.OAK_LOG, 'variants pick their base item');
  pickAt(0.5, 64.5, -1);
  assert.equal(p.selectedSlot, 3, 'existing hotbar stack is selected');
  for (let i = 0; i < 9; i++) inv.set(i, makeStack(BLOCK.GLASS + 0, 1));
  inv.set(0, makeStack(BLOCK.BRICKS, 1));
  p.selectedSlot = 0;
  pickAt(0.5, 64.5, -1);
  assert.equal(inv.get(0).id, BLOCK.STONE, 'full hotbar: replaces the selected slot');
  assert.equal(inv.get(9).id, BLOCK.BRICKS, '... moving the old stack into the inventory');

  const s = aimGame({ setup });
  const sp = s.player, sinv = sp.inventory;
  const si = new FakeInput();
  const spick = () => { lookAt(sp, 0.5, 64.5, -1); run(s, si, 1 / 60); si.tap('pickBlock'); run(s, si, 1 / 60); };
  spick();
  assert.equal(sinv.isEmpty(), true, 'survival never creates items');
  sinv.set(5, makeStack(BLOCK.STONE, 7));
  spick();
  assert.equal(sp.selectedSlot, 5);
  sinv.set(5, null);
  sinv.set(20, makeStack(BLOCK.STONE, 9));
  sinv.set(0, makeStack(BLOCK.DIRT, 1));
  sp.selectedSlot = 0;
  spick();
  assert.equal(sp.selectedSlot, 1, 'swapped into the first empty hotbar slot');
  assert.equal(sinv.get(1).count, 9);
  assert.equal(sinv.get(20), null);
});

test('drop: Q throws one, Ctrl+Q the stack, holding Q repeats; fallback throw without dropFromPlayer', () => {
  const game = aimGame({ item: makeStack(BLOCK.DIRT, 40) });
  const p = game.player, inv = p.inventory;
  const input = new FakeInput();
  input.tap('drop');
  run(game, input, 1 / 60);
  assert.deepEqual(game.dropped, [{ id: BLOCK.DIRT, count: 1, damage: 0 }]);
  assert.equal(inv.get(0).count, 39);
  input.press('drop');
  run(game, input, 1);
  input.release('drop');
  run(game, input, 1 / 60);
  const thrown = game.dropped.reduce((n, s) => n + s.count, 0);
  assert.ok(thrown >= 11 && thrown <= 12, `held Q repeats (${thrown})`);
  input.keys.add('ControlLeft');
  input.tap('drop');
  run(game, input, 1 / 60);
  assert.equal(inv.get(0), null, 'Ctrl+Q throws the whole stack');
  assert.equal(game.dropped.at(-1).count, 40 - thrown);
  input.keys.clear();
  delete game.dropFromPlayer;
  inv.set(0, makeStack(BLOCK.STONE, 2));
  p.yaw = 0; p.pitch = 0;
  input.tap('drop');
  run(game, input, 1 / 60);
  const item = game.spawned.at(-1);
  assert.equal(item.delay, 2);
  assert.ok(item.vz < -5 && item.vy > 0, 'thrown forward');
  near(item.y, p.y + 1.62 - 0.3, 1e-9);
});

test('hotbar: number keys and the mouse wheel (down = next slot, wrapping)', () => {
  const game = aimGame();
  const p = game.player;
  const input = new FakeInput();
  input.tap('hotbar5');
  run(game, input, 1 / 60);
  assert.equal(p.selectedSlot, 4);
  input.wheel = 1;
  run(game, input, 1 / 60);
  assert.equal(p.selectedSlot, 5);
  input.wheel = -7;
  run(game, input, 1 / 60);
  assert.equal(p.selectedSlot, 7);
  input.wheel = 3;
  run(game, input, 1 / 60);
  assert.equal(p.selectedSlot, 1);
});

test('hand state: 0.3 s swing, equip animation on item change, light and bobbing', () => {
  const game = aimGame({ item: makeStack(BLOCK.DIRT, 1) });
  const p = game.player, it = game.interaction;
  p.inventory.set(1, makeStack(BLOCK.STONE, 1));
  const input = new FakeInput();
  run(game, input, 0.5);
  let h = it.getHandState();
  assert.equal(h.itemId, BLOCK.DIRT);
  assert.equal(h.equip, 1);
  assert.equal(h.swing, 0);
  assert.equal(h.light, 0xf0);
  it.swing();
  run(game, input, 0.15);
  near(it.getHandState().swing, 0.5, 0.06);
  it.swing();                                          // second half: restarts
  near(it.getHandState().swing, 0, 1e-9);
  run(game, input, SWING_TIME + 0.02);
  assert.equal(it.getHandState().swing, 0);
  // Switch item: the hand lowers, swaps the drawn item, then raises again (≈0.3 s).
  input.tap('hotbar2');
  run(game, input, 1 / 60);
  h = it.getHandState();
  assert.ok(h.equip < 1);
  assert.equal(h.itemId, BLOCK.DIRT, 'still drawing the old item while lowering');
  let swappedAt = null;
  run(game, input, 0.4, 1 / 60, (i, t) => { if (swappedAt === null && it.getHandState().itemId === BLOCK.STONE) swappedAt = t; });
  assert.ok(swappedAt > 0.08 && swappedAt < 0.2, `swap at ${swappedAt}`);
  assert.equal(it.getHandState().equip, 1);
  input.press('forward');
  let bob = 0;
  run(game, input, 1, 1 / 60, () => { bob = Math.max(bob, Math.abs(it.getHandState().bobY)); });
  assert.ok(bob > 0.05, 'hand bobs while walking');
});

// ---------------------------------------------------------------------------------------------
// Input (fake DOM: EventTargets standing in for window / document / canvas)
// ---------------------------------------------------------------------------------------------

function makeDom() {
  const win = new EventTarget();
  const doc = new EventTarget();
  doc.pointerLockElement = null;
  doc.visibilityState = 'visible';
  const canvas = new EventTarget();
  canvas.lockRequests = [];
  canvas.requestPointerLock = (opts) => {
    canvas.lockRequests.push(opts);
    doc.pointerLockElement = canvas;
    doc.dispatchEvent(new Event('pointerlockchange'));
    return Promise.resolve();
  };
  doc.exitPointerLock = () => {
    doc.pointerLockElement = null;
    doc.dispatchEvent(new Event('pointerlockchange'));
  };
  return { win, doc, canvas };
}

function ev(type, props = {}) {
  const e = new Event(type, { cancelable: true });
  for (const [k, v] of Object.entries(props)) Object.defineProperty(e, k, { value: v });
  return e;
}

function makeInput(settings = { mouseSensitivity: 1, invertY: false }, unlocked = true) {
  const dom = makeDom();
  const input = new Input(dom.canvas, settings, { window: dom.win, document: dom.doc });
  input.allowUnlocked = unlocked;
  return { input, ...dom };
}

test('Input: per-frame edges, taps shorter than a frame, key repeat, shared bindings', () => {
  const { input, win } = makeInput();
  assert.ok(ACTIONS.includes('pickBlock') && ACTIONS.length === 27);
  win.dispatchEvent(ev('keydown', { code: 'KeyW' }));
  assert.equal(input.isDown('forward'), true);
  assert.equal(input.pressed('forward'), true);
  assert.equal(input.released('forward'), false);
  input.endFrame();
  assert.equal(input.isDown('forward'), true);
  assert.equal(input.pressed('forward'), false);
  win.dispatchEvent(ev('keydown', { code: 'KeyW', repeat: true }));
  assert.equal(input.pressed('forward'), false, 'auto-repeat is not a new press');
  win.dispatchEvent(ev('keyup', { code: 'KeyW' }));
  assert.equal(input.released('forward'), true);
  assert.equal(input.isDown('forward'), false);
  input.endFrame();
  // A tap within one frame still reads as down for that frame.
  win.dispatchEvent(ev('keydown', { code: 'Space' }));
  win.dispatchEvent(ev('keyup', { code: 'Space' }));
  assert.equal(input.isDown('jump'), true);
  assert.equal(input.pressed('jump'), true);
  assert.equal(input.released('jump'), true);
  input.endFrame();
  assert.equal(input.isDown('jump'), false);
  // Both shift keys sneak; releasing one keeps the action held.
  win.dispatchEvent(ev('keydown', { code: 'ShiftLeft' }));
  win.dispatchEvent(ev('keydown', { code: 'ShiftRight' }));
  win.dispatchEvent(ev('keyup', { code: 'ShiftLeft' }));
  assert.equal(input.isDown('sneak'), true);
  assert.equal(input.released('sneak'), false);
  assert.equal(input.isKeyDown('ShiftRight'), true);
  assert.equal(input.isDown('nonsense'), false);
  input.destroy();
});

test('Input: disabled reads idle; events from before re-enabling never become edges', () => {
  const { input, win } = makeInput();
  input.enabled = false;
  win.dispatchEvent(ev('keydown', { code: 'KeyW' }));
  assert.equal(input.isDown('forward'), false);
  // The UI closes the inventory on the same E keydown that our listener sees afterwards.
  win.addEventListener('keydown', (e) => { if (e.code === 'KeyE') input.enabled = true; });
  win.dispatchEvent(ev('keydown', { code: 'KeyE' }));
  assert.equal(input.enabled, true);
  assert.equal(input.pressed('inventory'), false, 'E that closed the screen does not reopen it');
  assert.equal(input.isDown('forward'), true, 'keys held through the screen keep working');
  assert.equal(input.pressed('forward'), false);
  win.dispatchEvent(ev('keyup', { code: 'KeyE' }));
  input.endFrame();
  win.dispatchEvent(ev('keydown', { code: 'KeyE' }));
  assert.equal(input.pressed('inventory'), true);

  // Listener order reversed: the UI listener runs first and enables input before ours sees the key.
  const dom = makeDom();
  dom.win.addEventListener('keydown', (e) => { if (e.code === 'KeyE') input2.enabled = true; });
  const input2 = new Input(dom.canvas, {}, { window: dom.win, document: dom.doc });
  input2.allowUnlocked = true;
  input2.enabled = false;
  dom.win.dispatchEvent(ev('keydown', { code: 'KeyE' }));
  assert.equal(input2.enabled, true);
  assert.equal(input2.pressed('inventory'), false);
  input.destroy();
  input2.destroy();
});

test('Input: window blur and hidden tab release everything', () => {
  const { input, win, doc, canvas } = makeInput();
  win.dispatchEvent(ev('keydown', { code: 'KeyW' }));
  canvas.dispatchEvent(ev('mousedown', { button: 0 }));
  input.endFrame();
  win.dispatchEvent(new Event('blur'));
  assert.equal(input.isDown('forward'), false);
  assert.equal(input.isDown('attack'), false);
  assert.equal(input.released('forward'), true);
  win.dispatchEvent(ev('keydown', { code: 'KeyD' }));
  doc.visibilityState = 'hidden';
  doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(input.isDown('right'), false);
  input.destroy();
});

test('Input: preventDefault for game keys while active; context menu always blocked', () => {
  const { input, win, canvas } = makeInput();
  const key = (code, extra = {}) => { const e = ev('keydown', { code, ...extra }); win.dispatchEvent(e); return e.defaultPrevented; };
  assert.equal(key('Space'), true, 'Space would scroll');
  assert.equal(key('Tab'), true);
  assert.equal(key('F5'), true, 'F5 is perspective, not reload');
  assert.equal(key('F3'), true);
  assert.equal(key('Slash'), true);
  assert.equal(key('KeyS', { ctrlKey: true }), true, 'Ctrl+S while sprinting');
  assert.equal(key('F12'), false, 'devtools stay reachable');
  assert.equal(key('KeyI', { ctrlKey: true, shiftKey: true }), false);
  input.enabled = false;
  assert.equal(key('Space'), false, 'UI screens (chat) get normal typing');
  const cm = ev('contextmenu');
  canvas.dispatchEvent(cm);
  assert.equal(cm.defaultPrevented, true);
  input.destroy();
});

test('Input: mouse buttons, wheel notches, sensitivity, invertY and spike filtering', () => {
  const settings = { mouseSensitivity: 2, invertY: true };
  const { input, win, doc, canvas } = makeInput(settings);
  const md = ev('mousedown', { button: 1 });
  canvas.dispatchEvent(md);
  assert.equal(md.defaultPrevented, true, 'no middle-click autoscroll');
  canvas.dispatchEvent(ev('mousedown', { button: 0 }));
  canvas.dispatchEvent(ev('mousedown', { button: 2 }));
  assert.equal(input.pressed('pickBlock'), true);
  assert.equal(input.pressed('attack'), true);
  assert.equal(input.pressed('use'), true);
  input.endFrame();
  win.dispatchEvent(ev('mouseup', { button: 0 }));
  assert.equal(input.released('attack'), true);
  assert.equal(input.isDown('use'), true);
  input.endFrame();
  const wheel = (props) => { const e = ev('wheel', { deltaMode: 0, deltaX: 0, ...props }); canvas.dispatchEvent(e); return e; };
  assert.equal(wheel({ deltaY: 100 }).defaultPrevented, true);
  assert.equal(input.wheel, 1);
  wheel({ deltaY: -200 });
  assert.equal(input.wheel, -1);
  input.endFrame();
  wheel({ deltaY: 3, deltaMode: 1 });                  // Firefox: 3 lines per notch
  assert.equal(input.wheel, 1);
  input.endFrame();
  for (let i = 0; i < 4; i++) wheel({ deltaY: 30 });   // touchpad: accumulates
  assert.equal(input.wheel, 1);
  input.endFrame();
  wheel({ deltaY: 0, deltaX: 100 });                   // Shift+wheel (sneaking) scrolls horizontally
  assert.equal(input.wheel, 1);
  input.endFrame();
  doc.dispatchEvent(ev('mousemove', { movementX: 10, movementY: 5 }));
  doc.dispatchEvent(ev('mousemove', { movementX: 5000, movementY: 0 }));   // spike
  assert.equal(input.rawMouseDX, 10);
  assert.equal(input.mouseDX, 20);
  assert.equal(input.mouseDY, -10, 'invertY');
  settings.mouseSensitivity = 0.5;                     // live settings object
  input.endFrame();
  doc.dispatchEvent(ev('mousemove', { movementX: 10, movementY: 0 }));
  assert.equal(input.mouseDX, 5);
  input.enabled = false;
  assert.equal(input.mouseDX, 0);
  assert.equal(input.wheel, 0);
  input.destroy();
});

test('Input: pointer lock gating, click-to-lock, onLockChange, raw movement request', () => {
  const { input, win, doc, canvas } = makeInput(undefined, false);
  const changes = [];
  const off = input.onLockChange((locked) => changes.push(locked));
  win.dispatchEvent(ev('keydown', { code: 'KeyW' }));
  assert.equal(input.active, false);
  assert.equal(input.isDown('forward'), false, 'nothing works without the lock');
  canvas.dispatchEvent(ev('mousedown', { button: 0 }));
  assert.equal(canvas.lockRequests.length, 1, 'clicking the canvas grabs the pointer');
  assert.deepEqual(canvas.lockRequests[0], { unadjustedMovement: true });
  assert.equal(input.locked, true);
  assert.deepEqual(changes, [true]);
  assert.equal(input.isDown('attack'), false, 'the grabbing click is not an attack');
  assert.equal(input.isDown('forward'), true, 'held keys work once locked');
  assert.equal(input.pressed('forward'), false);
  doc.dispatchEvent(ev('mousemove', { movementX: 300, movementY: 0 }));   // first locked move skipped
  doc.dispatchEvent(ev('mousemove', { movementX: 4, movementY: 2 }));
  assert.equal(input.mouseDX, 4);
  input.exitLock();
  assert.equal(input.locked, false);
  assert.deepEqual(changes, [true, false]);
  assert.equal(input.isDown('forward'), false);
  off();
  input.requestLock();
  assert.deepEqual(changes, [true, false], 'unsubscribed');
  input.destroy();
});

test('Input: rebinding and destroy', () => {
  const { input, win } = makeInput();
  input.setBindings({ ...input.getBindings(), jump: ['KeyJ'] });
  win.dispatchEvent(ev('keydown', { code: 'Space' }));
  assert.equal(input.isDown('jump'), false);
  win.dispatchEvent(ev('keydown', { code: 'KeyJ' }));
  assert.equal(input.isDown('jump'), true);
  assert.deepEqual(input.getBindings().forward, ['KeyW']);
  input.destroy();
  win.dispatchEvent(ev('keydown', { code: 'KeyW' }));
  assert.equal(input.isDown('forward'), false, 'listeners removed');
});

// ---------------------------------------------------------------------------------------------
// Performance
// ---------------------------------------------------------------------------------------------

test('performance: player + interaction update well under budget', () => {
  const world = new FakeWorld();
  world.fill(-6, 64, -6, -4, 70, 6, BLOCK.STONE);
  world.fill(4, 63, -6, 6, 63, 6, BLOCK.WATER);
  const game = makeGame(world);
  const p = game.player;
  p.setPosition(0.5, 64, 0.5);
  p.pitch = -0.4;
  const input = new FakeInput();
  input.press('forward', 'sprint', 'jump', 'attack');
  run(game, input, 1);
  const frames = 4000;
  const t0 = performance.now();
  for (let i = 0; i < frames; i++) {
    p.yaw += 0.02;
    game.player.update(1 / 60, input);
    game.interaction.update(1 / 60, input);
    game.interaction.getHandState();
    p.getCameraState();
    input.endFrame();
  }
  const ms = (performance.now() - t0) / frames;
  console.log(`# player+interaction: ${(ms * 1000).toFixed(1)} µs per 60 Hz frame`);
  assert.ok(ms < 0.5, `${ms} ms per frame`);
});
