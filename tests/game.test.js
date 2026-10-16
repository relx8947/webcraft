// Game (src/game.js) integration tests under Node: the real World / worker code (through an in-process
// pool), Player, Interaction, EntityManager, ParticleSystem, commands and an in-memory Storage, with
// stand-ins only for the DOM-bound pieces (renderer, input, UI, audio).
import test from 'node:test';
import assert from 'node:assert/strict';

import { Game, WorldLocks, sanitizeSettings, parseTimeParam, describeSaveError } from '../src/game.js';
import { DEFAULT_SETTINGS, DAY_TICKS } from '../src/config.js';
import { BLOCK, ITEM, IS_SOLID, BLOCKS } from '../src/world/registry.js';
import { Storage } from '../src/world/storage.js';
import { handleMessage } from '../src/world/worker.js';

/** WorkerPool stand-in: runs jobs through the real worker message handler on the next macrotask. */
class InlinePool {
  constructor() {
    this.size = 4;
    this.queue = [];
    this.scheduled = false;
  }

  init(seed, worldType) {
    handleMessage({ type: 'init', seed, worldType });
  }

  submit(job, priority = 0) {
    return new Promise((resolve, reject) => {
      this.queue.push({ job, priority, resolve, reject });
      this._schedule();
    });
  }

  _schedule() {
    if (this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      const batch = this.queue.sort((a, b) => a.priority - b.priority).splice(0, 16);
      for (const e of batch) {
        const out = handleMessage(e.job);
        if (out.message.type === 'error') e.reject(new Error(out.message.message));
        else e.resolve(out.message);
      }
      if (this.queue.length > 0) this._schedule();
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

  getStats() {
    return { workers: this.size, queued: this.queue.length };
  }
}

class StubRenderer {
  constructor() {
    this.sections = new Map();
    this.frames = [];
    this.entityRenderer = null;
  }

  setSectionMesh(cx, sy, cz, o, c, t) {
    const k = `${cx},${sy},${cz}`;
    if (!o && !c && !t) this.sections.delete(k);
    else this.sections.set(k, true);
  }

  removeChunk(cx, cz) {
    for (let sy = 0; sy < 16; sy++) this.sections.delete(`${cx},${sy},${cz}`);
  }

  clearAll() {
    this.sections.clear();
  }

  render(frame) {
    this.frames.push({ ...frame, camera: { ...frame.camera } });
    if (this.frames.length > 4) this.frames.shift();
  }

  getStats() {
    return { sections: this.sections.size, visibleSections: 0, drawCalls: 0, triangles: 0, gpuMemoryBytes: 0 };
  }
}

/** Input stand-in: idle unless `down` contains an action. */
class StubInput {
  constructor(settings) {
    this.settings = settings;
    this.enabled = true;
    this.down = new Set();
    this.pressedOnce = new Set();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheel = 0;
  }

  isDown(a) {
    return this.down.has(a) || this.pressedOnce.has(a);
  }

  pressed(a) {
    return this.pressedOnce.has(a);
  }

  released() {
    return false;
  }

  isKeyDown() {
    return false;
  }

  endFrame() {
    this.pressedOnce.clear();
  }
}

/** In-memory stand-in for navigator.locks (Web Locks API: request(name, { ifAvailable }, callback)). */
class FakeLockManager {
  constructor() {
    this.held = new Set();
  }

  request(name, opts, cb) {
    if (this.held.has(name)) return Promise.resolve(cb(null));
    this.held.add(name);
    return Promise.resolve(cb({ name })).finally(() => this.held.delete(name));
  }
}

function makeGame({ storage = Storage.memory(), locks = null } = {}) {
  const settings = { ...DEFAULT_SETTINGS, renderDistance: 2 };
  const renderer = new StubRenderer();
  const options = { persistSettings: false, music: false };
  if (locks) options.worldLocks = new WorldLocks({ locks });
  const game = new Game({
    canvas: null, renderer, input: new StubInput(settings), audio: null, storage, pool: new InlinePool(),
    icons: null, textures: null, settings, options,
  });
  const chat = [];
  game.on('chat', (text) => chat.push(text));
  return { game, renderer, storage, chat };
}

/** Make the storage's chunk writes fail (like a full disk) until the returned restore() is called. */
function breakChunkWrites(storage) {
  const saveChunks = storage.saveChunks, saveSnapshot = storage.saveSnapshot;
  const fail = () => {
    const err = new Error('The quota has been exceeded.');
    err.name = 'QuotaExceededError';
    return Promise.reject(err);
  };
  storage.saveChunks = fail;
  storage.saveSnapshot = fail;
  return () => {
    storage.saveChunks = saveChunks;
    storage.saveSnapshot = saveSnapshot;
  };
}

/** Run frames (update + render, as the rAF loop does) until `pred()` or the frame limit. */
async function frames(game, n = 1, pred = null) {
  for (let i = 0; i < n; i++) {
    game.update(1 / 60);
    game.render();
    game.input.endFrame();
    if (pred && pred()) return true;
    await new Promise((r) => setImmediate(r));
  }
  return pred ? pred() : true;
}

/** startWorld() resolves once the loading loop (driven by frames) has entered the world. */
async function enter(game, meta) {
  const p = game.startWorld(meta);
  let done = false;
  p.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; i < 4000 && !done; i++) {
    game.update(1 / 60);
    await new Promise((r) => setImmediate(r));
  }
  await p;
  assert.equal(game.state, 'playing');
}

test('sanitizeSettings validates, clamps and drops unknown keys', () => {
  assert.deepEqual(sanitizeSettings({ renderDistance: 40, fov: 10, bogus: 1, clouds: 0, soundVolume: '0.5' }),
    { renderDistance: 32, fov: 30, clouds: false, soundVolume: 0.5 });
  assert.deepEqual(sanitizeSettings({ renderDistance: 'x', guiScale: 2.6 }), { guiScale: 3 });
  assert.deepEqual(sanitizeSettings(null), {});
  // wave 2: difficulty is an enum (the options screen and /difficulty go through applySettings)
  assert.deepEqual(sanitizeSettings({ difficulty: 'hard' }), { difficulty: 'hard' });
  assert.deepEqual(sanitizeSettings({ difficulty: 'nightmare' }), {});
});

test('parseTimeParam accepts ticks and names', () => {
  assert.equal(parseTimeParam('noon'), 6000);
  assert.equal(parseTimeParam('MIDNIGHT'), 18000);
  assert.equal(parseTimeParam('1234'), 1234);
  assert.ok(Number.isNaN(parseTimeParam('')));
  assert.ok(Number.isNaN(parseTimeParam('-5')));
});

test('createWorld stores a meta; startWorld spawns the player on safe ground and renders', async () => {
  const { game, renderer, storage } = makeGame();
  const meta = await game.createWorld({ name: '测试', seedText: '12345', mode: 'survival', worldType: 'default' });
  assert.equal(meta.seed, 12345);
  assert.equal(meta.time, 1000);
  assert.equal((await storage.listWorlds()).length, 1);
  await enter(game, meta);
  await frames(game, 1);
  const p = game.player;
  const ground = game.world.getBlock(Math.floor(p.x), Math.floor(p.y) - 1, Math.floor(p.z));
  assert.ok(IS_SOLID[ground], `standing on ${BLOCKS[ground].name}`);
  assert.ok(!BLOCKS[ground].name.endsWith('_leaves'));
  for (let k = 0; k < 2; k++) {
    assert.ok(!IS_SOLID[game.world.getBlock(Math.floor(p.x), Math.floor(p.y) + k, Math.floor(p.z))], 'free head room');
  }
  assert.deepEqual([meta.spawn.x, meta.spawn.y, meta.spawn.z], [p.x, p.y, p.z]);
  assert.equal(globalThis.__ready, true);
  assert.ok(renderer.frames.length > 0);
  const f = renderer.frames.at(-1);
  assert.ok(Math.abs(f.camera.y - (p.y + 1.62)) < 0.2);
  assert.equal(f.renderDistance, 2);
  assert.ok(f.timeOfDay > 0 && f.timeOfDay < 0.1, 'morning');
  // physics runs once the area is ready: standing still keeps the player on the ground
  await frames(game, 30);
  assert.equal(p.frozen, false);
  assert.ok(Math.abs(p.y - meta.spawn.y) < 1e-6);
  await game.quitToTitle();
  assert.equal(game.state, 'title');
  assert.equal(game.world, null);
});

test('time advances at 20 ticks per second and pauses with the game', async () => {
  const { game } = makeGame();
  await enter(game, await game.createWorld({ seedText: '1', worldType: 'flat' }));
  const t0 = game.time;
  await frames(game, 60);
  assert.ok(Math.abs(game.time - t0 - 20) <= 1, `+${game.time - t0} ticks`);
  game.setPaused(true);
  const t1 = game.time;
  await frames(game, 30);
  assert.equal(game.time, t1);
  game.setPaused(false);
  game.setTime(18000);
  assert.ok(Math.abs(game.timeOfDay - 0.75) < 1e-9);
  assert.ok(game.daylight < 0.25);
  await game.quitToTitle();
});

test('edits, player state and time survive save -> quit -> startWorld from storage', async () => {
  const { game, storage } = makeGame();
  const meta = await game.createWorld({ name: 'persist', seedText: '77', mode: 'creative', worldType: 'flat' });
  await enter(game, meta);
  const p = game.player;
  assert.equal(p.mode, 'creative');
  assert.equal(p.inventory.get(0)?.id, BLOCK.GRASS_BLOCK, 'creative hotbar');
  const x = Math.floor(p.x) + 2, z = Math.floor(p.z);
  assert.ok(game.debug.setBlock(x, 4, z, 'gold_block'));
  assert.ok(game.debug.setBlock(x, 3, z, 'air'));
  game.debug.give('diamond', 5);
  p.setPosition(p.x + 0.25, 4, p.z - 0.75);
  p.yaw = 1.25;
  game.setTime(15000);
  await game.quitToTitle();

  const list = await storage.listWorlds();
  assert.equal(list.length, 1);
  const saved = list[0];
  assert.equal(saved.time, 15000);
  assert.ok(saved.player);
  await enter(game, saved);
  const q = game.player;
  assert.equal(game.world.getBlock(x, 4, z), BLOCK.GOLD_BLOCK);
  assert.equal(game.world.getBlock(x, 3, z), BLOCK.AIR);
  assert.equal(q.inventory.count(ITEM.DIAMOND), 5);
  assert.ok(Math.abs(q.yaw - 1.25) < 1e-9);
  assert.equal(game.time, 15000);
  assert.equal(q.mode, 'creative');
  await game.quitToTitle();
});

test('temporary worlds are not stored', async () => {
  const { game, storage } = makeGame();
  const meta = await game.createWorld({ seedText: '5', worldType: 'flat', temporary: true });
  await enter(game, meta);
  game.debug.setBlock(1, 4, 1, 'stone');
  assert.equal(await game.saveWorld(), false);
  await game.quitToTitle();
  assert.equal((await storage.listWorlds()).length, 0);
});

test('applySettings updates the live settings object and the world', async () => {
  const { game } = makeGame();
  const seen = [];
  game.on('settingsChanged', (changed) => seen.push(changed));
  await enter(game, await game.createWorld({ seedText: '3', worldType: 'flat', temporary: true }));
  const settings = game.settings;
  game.applySettings({ renderDistance: 3, smoothLighting: false, fov: 300, nonsense: 1 });
  assert.equal(game.settings, settings, 'same object (Input / Audio read it live)');
  assert.equal(settings.renderDistance, 3);
  assert.equal(settings.fov, 110);
  assert.equal(game.world.renderDistance, 3);
  assert.equal(game.world.smoothLighting, false);
  assert.deepEqual(seen.at(-1), { renderDistance: 3, smoothLighting: false, fov: 110 });
  const n = seen.length;
  game.applySettings({ renderDistance: 3 });
  assert.equal(seen.length, n, 'no event without a change');
  await game.quitToTitle();
});

test('commands run through game.runCommand and report via chat events', async () => {
  const { game, chat } = makeGame();
  await enter(game, await game.createWorld({ seedText: '9', worldType: 'flat', temporary: true }));
  game.runCommand('/time set midnight');
  assert.equal(game.time, 18000);
  game.runCommand('/gamemode creative');
  assert.equal(game.player.mode, 'creative');
  game.runCommand('/give diamond_pickaxe');
  assert.equal(game.player.inventory.count(ITEM.DIAMOND_PICKAXE), 1);
  game.runCommand('/seed');
  assert.ok(chat.some((t) => t.includes('9')));
  game.runCommand('/nonsense');
  assert.ok(chat.length >= 5);
  await game.quitToTitle();
});

test('survival breaking drops an item that the player picks up', async () => {
  const { game } = makeGame();
  await enter(game, await game.createWorld({ seedText: '11', worldType: 'flat', temporary: true }));
  const p = game.player;
  // a block standing on the ground next to the player (breaking the ground itself would drop the item
  // into a hole below the pickup box, exactly like Minecraft)
  const x = Math.floor(p.x) + 1, z = Math.floor(p.z);
  assert.ok(game.debug.setBlock(x, 4, z, 'dirt'));
  assert.ok(game.interaction.breakBlock(x, 4, z, { drops: true }));
  assert.equal(game.world.getBlock(x, 4, z), BLOCK.AIR);
  // count item entities only (mobs may exist once the wave-2 spawner is wired)
  const items = () => game.entities.list.filter((e) => e.type === 'item' && !e.removed);
  assert.equal(items().length, 1);
  const drop = items()[0];
  assert.ok(drop, 'an item entity was spawned');
  assert.equal(drop.stack.id, BLOCK.DIRT);
  // The drop pops with Minecraft's random velocity and may land out of reach (1.5 blocks), so walk
  // onto it like a player would: face it and hold W until the pickup happens.
  const input = game.input;
  const steer = () => {
    if (drop.removed || drop.collecting) {
      input.down.delete('forward');
      return;
    }
    if (Math.hypot(drop.x - p.x, drop.z - p.z) > 0.4) {
      game.debug.lookAt(drop.x, p.y + 1.62, drop.z);
      input.down.add('forward');
    } else {
      input.down.delete('forward');
    }
  };
  steer();
  const pickedUp = await frames(game, 300, () => {
    steer();
    return p.inventory.count(BLOCK.DIRT) === 1;
  });
  input.down.delete('forward');
  assert.ok(pickedUp, 'the dirt drop flies into the inventory');
  await game.quitToTitle();
});

test('getDebugInfo reports position, facing, biome and light', async () => {
  const { game } = makeGame();
  await enter(game, await game.createWorld({ seedText: '13', worldType: 'flat', temporary: true }));
  game.debug.look(Math.PI / 2, 0);   // west
  await frames(game, 2);
  const text = game.getDebugInfo().join('\n');
  assert.match(text, /XYZ: /);
  assert.match(text, /西 west/);
  assert.match(text, /平原 plains/);
  assert.match(text, /光照 Light: \d+/);
  await game.quitToTitle();
});

test('a new world starts at time 1000 and day count is derived from ticks', async () => {
  const { game } = makeGame();
  await enter(game, await game.createWorld({ seedText: '17', worldType: 'flat', temporary: true }));
  assert.ok(game.time >= 1000 && game.time < 1100);
  game.setTime(DAY_TICKS * 2 + 500);
  assert.match(game.getDebugInfo().join('\n'), /第 3 天/);
  await game.quitToTitle();
});

test('save and quit keeps the world open when saving fails; the next quit saves it', async () => {
  const { game, storage, chat } = makeGame();
  const failures = [];
  game.on('saveFailed', (err, kind) => failures.push([err.name, kind]));
  const meta = await game.createWorld({ name: 'fail', seedText: '21', worldType: 'flat' });
  await enter(game, meta);
  await frames(game, 2);
  const x = Math.floor(game.player.x) + 2, z = Math.floor(game.player.z);
  assert.ok(game.debug.setBlock(x, 4, z, 'gold_block'));
  const restore = breakChunkWrites(storage);
  await assert.rejects(game.quitToTitle(), (err) => err.saveFailed === true && err.cause?.name === 'QuotaExceededError');
  assert.equal(game.state, 'playing');
  assert.ok(game.world, 'world still loaded');
  assert.equal(game.world.getBlock(x, 4, z), BLOCK.GOLD_BLOCK);
  assert.deepEqual(failures.at(-1), ['QuotaExceededError', 'quit']);
  assert.ok(chat.some((t) => t.includes('无法保存世界') && t.includes('存储空间不足')), 'the player is told');
  assert.equal(game.hasUnsavedProgress(), true);
  // starting another world first has to quit this one: refused while it cannot be saved
  await assert.rejects(game.startWorld(await game.createWorld({ seedText: '1', worldType: 'flat', temporary: true })),
    (err) => err.saveFailed === true);
  assert.ok(game.world);
  assert.equal(game.worldMeta.id, meta.id);
  // storage works again: the next quit saves and unloads
  restore();
  await game.quitToTitle();
  assert.equal(game.state, 'title');
  assert.ok(chat.some((t) => t.includes('世界已成功保存')), 'recovery is reported');
  await enter(game, (await storage.listWorlds()).find((m) => m.id === meta.id));
  assert.equal(game.world.getBlock(x, 4, z), BLOCK.GOLD_BLOCK, 'the edit survived');
  await game.quitToTitle();
});

test('quitToTitle({ discard: true }) unloads without saving', async () => {
  const { game, storage } = makeGame();
  await enter(game, await game.createWorld({ name: 'discard', seedText: '22', worldType: 'flat' }));
  const restore = breakChunkWrites(storage);
  await game.quitToTitle({ discard: true });
  restore();
  assert.equal(game.state, 'title');
  assert.equal(game.world, null);
});

test('leaving the page writes the meta and every modified chunk in one transaction, synchronously', async () => {
  const { game, storage } = makeGame();
  const meta = await game.createWorld({ name: 'atomic', seedText: '23', worldType: 'flat' });
  await enter(game, meta);
  await game.saveWorld();
  const calls = [];
  const saveSnapshot = storage.saveSnapshot.bind(storage);
  storage.saveSnapshot = (id, m, chunks, data) => {
    calls.push({ id, meta: !!m, inventory: m?.player?.inventory.filter(Boolean), chunks: chunks.length });
    return saveSnapshot(id, m, chunks, data);
  };
  const x = Math.floor(game.player.x), z = Math.floor(game.player.z);
  for (let i = 0; i < 3; i++) game.debug.setBlock(x + 20 * i, 4, z, 'stone');   // three chunks
  game.debug.give('diamond', 2);
  // what visibilitychange / pagehide do: the transaction must exist when the event handler returns
  game._saveForUnload();
  assert.equal(calls.length, 1, 'issued synchronously inside the event');
  assert.deepEqual(calls[0], { id: meta.id, meta: true, inventory: [[ITEM.DIAMOND, 2, 0]], chunks: 3 });
  await game._saveChain;
  assert.equal(game.world.stats().modified, 0);
  await game.quitToTitle();
});

test('pausing saves the world; beforeunload only asks while progress is unsaved', async () => {
  const { game, storage } = makeGame();
  const meta = await game.createWorld({ name: 'pause', seedText: '24', worldType: 'flat' });
  await enter(game, meta);
  await frames(game, 3);
  assert.equal(game.hasUnsavedProgress(), true, 'playing = unsaved progress');
  game.debug.give('diamond', 3);
  game.setPaused(true);
  await frames(game, 5);
  await game._saveChain;
  assert.equal(game.hasUnsavedProgress(), false, 'saved on pause');
  const stored = await storage.loadWorldMeta(meta.id);
  assert.ok(stored.player.inventory.some((s) => s && s[0] === ITEM.DIAMOND), 'inventory saved by the pause');
  const ev = { prevented: false, returnValue: undefined, preventDefault() { this.prevented = true; } };
  game._onBeforeUnload(ev);
  assert.equal(ev.prevented, false, 'nothing to lose: no confirmation');
  game.setPaused(false);
  await frames(game, 2);
  const ev2 = { prevented: false, returnValue: undefined, preventDefault() { this.prevented = true; } };
  game._onBeforeUnload(ev2);
  assert.equal(ev2.prevented, true, 'unsaved play: the browser asks before closing');
  assert.equal(ev2.returnValue, '');
  await game.quitToTitle();
  // temporary worlds never ask
  await enter(game, await game.createWorld({ seedText: '25', worldType: 'flat', temporary: true }));
  await frames(game, 2);
  assert.equal(game.hasUnsavedProgress(), false);
  await game.quitToTitle();
});

test('a world open in one game cannot be opened (or deleted) by another until it is quit', async () => {
  const locks = new FakeLockManager();
  const storage = Storage.memory();
  const a = makeGame({ storage, locks }).game;
  const b = makeGame({ storage, locks }).game;
  const meta = await a.createWorld({ name: 'locked', seedText: '26', worldType: 'flat' });
  await enter(a, meta);
  const other = (await storage.listWorlds())[0];
  await assert.rejects(b.startWorld(other), /另一个标签页/);
  assert.equal(b.state, 'title');
  assert.equal(b.world, null);
  await assert.rejects(b.deleteWorld(meta.id), /另一个标签页/);
  await assert.rejects(a.deleteWorld(meta.id), /正在游玩/);
  await a.quitToTitle();
  await enter(b, (await storage.listWorlds())[0]);
  assert.equal(b.state, 'playing');
  await b.quitToTitle();
  await b.deleteWorld(meta.id);
  assert.equal((await storage.listWorlds()).length, 0);
});

test('describeSaveError explains storage failures in Chinese', () => {
  assert.match(describeSaveError({ name: 'QuotaExceededError' }), /存储空间不足/);
  assert.match(describeSaveError(new Error('boom')), /boom/);
});

// ---------------------------------------------------------------------------------------------------
// Wave 2 wiring (SPEC-wave2 §8): mob spawner, block entities, onInteractBlock routing, persistence,
// entities parked with unloaded chunks, settings (difficulty, brightness)
// ---------------------------------------------------------------------------------------------------

test('wave 2: chunk animals, chest / furnace routing + smelting, mobs and containers survive save & reload', async () => {
  const { game, storage } = makeGame();
  const opened = [];
  game.ui = { openChest: (be) => opened.push(['chest', be]), openFurnace: (be) => opened.push(['furnace', be]) };
  const meta = await game.createWorld({ name: 'wave2', seedText: '4242', worldType: 'flat', mode: 'creative' });
  await enter(game, meta);
  assert.ok(game.spawner && game.blockEntities, 'spawner and block entities exist while a world is open');
  // flat grass: 10 % of the generated chunks got a group of animals (queued events reach the spawner too)
  await frames(game, 2);
  const animals = () => game.entities.list.filter((e) => e.type === 'mob' && !e.removed);
  assert.ok(game.spawner.stats.chunks > 0 && animals().length > 0, `chunk groups ${game.spawner.stats.chunks}`);
  const w = game.world, p = game.player;
  const x = Math.floor(p.x) + 2, y = Math.floor(p.y), z = Math.floor(p.z);
  // a chest: placing creates its block entity, a right click opens it through onInteractBlock
  assert.ok(w.setBlock(x, y, z, BLOCK.CHEST));
  const chest = game.blockEntities.get(x, y, z);
  assert.ok(chest && chest.type === 'chest');
  chest.set(0, { id: ITEM.DIAMOND, count: 7, damage: 0 });
  assert.equal(game.onInteractBlock(x, y, z, BLOCK.CHEST, { itemId: 0, slot: 0 }), true);
  assert.equal(opened.at(-1)[0], 'chest');
  assert.equal(opened.at(-1)[1], chest);
  // a furnace smelts on the game's 20 Hz clock: 1 iron ore + coal -> 1 iron ingot after 10 s, lit meanwhile
  assert.ok(w.setBlock(x, y, z + 2, BLOCK.FURNACE));
  const furnace = game.blockEntities.get(x, y, z + 2);
  furnace.set(0, { id: ITEM.IRON_ORE, count: 1, damage: 0 });
  furnace.set(1, { id: ITEM.COAL, count: 1, damage: 0 });
  assert.equal(game.onInteractBlock(x, y, z + 2, BLOCK.FURNACE, { itemId: 0, slot: 0 }), true);
  assert.equal(opened.at(-1)[0], 'furnace');
  await frames(game, 30);
  assert.equal(BLOCKS[w.getBlock(x, y, z + 2)].name, 'lit_furnace', 'lit while burning');
  await frames(game, 600, () => furnace.get(2)?.count === 1);
  assert.equal(furnace.get(2)?.id, ITEM.IRON_INGOT);
  // a mob near the player, and one far away in a chunk that is not loaded: parked, not updated
  const pig = game.spawnMob('pig', p.x + 3.5, y, p.z + 0.5, { persistent: true });
  assert.ok(pig);
  const cow = game.spawnMob('cow', 5000.5, 5, 5000.5, { persistent: true });
  const zombie = game.spawnMob('zombie', 5003.5, 5, 5000.5);   // natural hostile: dropped, not parked
  game._updateParking();
  assert.ok(cow.removed && zombie.removed, 'entities of unloaded chunks leave the live list');
  assert.equal(game.parkedEntities, 1);
  await game.quitToTitle();
  // reload: chest contents, furnace output, the pig and the parked cow come back
  const saved = (await storage.listWorlds())[0];
  assert.ok(saved.entities.some((r) => r.mob === 'cow' && r.x === 5000.5), 'parked records are saved');
  assert.ok(Array.isArray(saved.blockEntities) && saved.blockEntities.length === 2);
  const { game: g2 } = makeGame({ storage });
  await enter(g2, saved);
  await frames(g2, 3);
  assert.equal(g2.blockEntities.get(x, y, z).get(0)?.count, 7);
  assert.equal(g2.blockEntities.get(x, y, z + 2).get(2)?.id, ITEM.IRON_INGOT);
  assert.ok(g2.entities.list.some((e) => e.type === 'mob' && e.mobType === 'pig' && Math.abs(e.x - pig.x) < 2));
  assert.ok(g2._parked.get('312,312')?.some((r) => r.mob === 'cow'), 'the far cow stays parked until its chunk is loaded');
  // records are only parked with chunks that are not meshed; a parking pass restores the others
  g2._updateParking();
  for (const key of g2._parked.keys()) {
    const [cx, cz] = key.split(',').map(Number);
    assert.ok(!g2.world.isChunkMeshed(cx, cz), `parked records of meshed chunk ${key}`);
  }
  // breaking the chest drops its contents
  const before = g2.entities.list.filter((e) => e.type === 'item' && !e.removed).length;
  g2.world.setBlock(x, y, z, BLOCK.AIR);
  assert.equal(g2.blockEntities.get(x, y, z), null);
  assert.ok(g2.entities.list.filter((e) => e.type === 'item' && !e.removed).length > before);
  await g2.quitToTitle();
  assert.equal(g2.blockEntities, null);
  assert.equal(g2.spawner, null);
});

test('wave 2: peaceful removes hostile mobs; difficulty and brightness are validated settings', async () => {
  const { game } = makeGame();
  await enter(game, await game.createWorld({ seedText: '77', worldType: 'flat' }));
  const p = game.player;
  const z = game.spawnMob('zombie', p.x + 4, Math.floor(p.y), p.z);
  assert.ok(z);
  game.applySettings({ difficulty: 'peaceful' });
  assert.equal(game.settings.difficulty, 'peaceful');
  await frames(game, 5);
  assert.ok(z.removed, 'hostile mobs vanish in peaceful');
  assert.equal(game.spawnMob('creeper', p.x + 4, Math.floor(p.y), p.z), null, 'and cannot be spawned');
  assert.deepEqual(sanitizeSettings({ brightness: 3 }), { brightness: 1 });
  assert.deepEqual(sanitizeSettings({ brightness: 'x' }), {});
  game.applySettings({ brightness: 0.25, difficulty: 'normal' });
  await frames(game, 1);
  assert.equal(game.frame.brightness, 0.25);
  assert.ok(game.getDebugInfo().some((l) => l.includes('难度 普通')));
  await game.quitToTitle();
});
