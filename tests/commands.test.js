import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCommand, getCompletions, resolveItem, resolveBlock, COMMAND_LIST } from '../src/game/commands.js';
import { Inventory, makeStack } from '../src/game/inventory.js';
import { BLOCK, ITEM } from '../src/world/registry.js';

/** Minimal game mock: player, world (a Map of edited blocks over stone below y=64), chat capture. */
function mockGame(overrides = {}) {
  const blocks = new Map();
  const chat = [];
  const drops = [];
  const spawned = [];
  const player = {
    x: 10.5, y: 64, z: -3.5, vx: 1, vy: 2, vz: 3, yaw: 0, pitch: 0,
    mode: 'survival', health: 20, dead: false, inventory: new Inventory(), spawnPoint: { x: 0.5, y: 70, z: 0.5 },
    setPosition(x, y, z) { this.x = x; this.y = y; this.z = z; },
    damage(amount, cause) {
      this.lastCause = cause;
      this.health = Math.max(0, this.health - amount);
      if (this.health === 0) this.dead = true;
      return true;
    },
  };
  const world = {
    getBlock(x, y, z) {
      const k = `${x},${y},${z}`;
      if (blocks.has(k)) return blocks.get(k);
      return y < 64 ? BLOCK.STONE : BLOCK.AIR;
    },
    setBlock(x, y, z, id) {
      if (Math.abs(x) > 1000) return false; // "unloaded"
      blocks.set(`${x},${y},${z}`, id);
      return true;
    },
  };
  const game = {
    player, world, time: 1000, chat, drops, spawned, blocks,
    worldMeta: { seed: 123456, seedText: 'hello', spawn: { x: 0.5, y: 70, z: 0.5 } },
    addChatMessage(text, color) { chat.push({ text, color }); },
    setGameMode(m) { player.mode = m; },
    setTime(t) { this.time = t; },
    dropFromPlayer(s) { drops.push(s); },
    spawnItem(s, x, y, z) { spawned.push({ s, x, y, z }); },
    ...overrides,
  };
  return game;
}

const last = (g) => g.chat[g.chat.length - 1];
const isError = (m) => m.color === '#FF5555';
const errors = (g) => g.chat.filter(isError);

test('/help lists every command, /help <cmd> shows usage', () => {
  const g = mockGame();
  runCommand(g, '/help');
  const text = g.chat.map((m) => m.text).join('\n');
  for (const c of COMMAND_LIST) assert.ok(text.includes(`/${c.name}`), c.name);
  for (const name of ['help', 'gamemode', 'time', 'tp', 'give', 'clear', 'kill', 'seed', 'spawnpoint', 'setblock', 'fill']) {
    assert.ok(COMMAND_LIST.some((c) => c.name === name), name);
  }
  g.chat.length = 0;
  runCommand(g, '/help give');
  assert.match(g.chat[0].text, /\/give/);
  runCommand(g, '/help nope');
  assert.ok(isError(g.chat.find((m) => m.color)));
});

test('unknown commands report an error with context', () => {
  const g = mockGame();
  runCommand(g, '/frobnicate 1 2');
  assert.ok(isError(g.chat[0]));
  assert.match(g.chat[0].text, /未知的命令/);
  assert.match(g.chat[1].text, /<--\[这里\]/);
  runCommand(g, '/');
  assert.ok(isError(last(g)));
});

test('/gamemode accepts English, numeric and Chinese names', () => {
  const g = mockGame();
  runCommand(g, '/gamemode creative');
  assert.equal(g.player.mode, 'creative');
  assert.match(last(g).text, /创造模式/);
  runCommand(g, '/gamemode 0');
  assert.equal(g.player.mode, 'survival');
  runCommand(g, '/gamemode 创造');
  assert.equal(g.player.mode, 'creative');
  runCommand(g, '/gamemode s');
  assert.equal(g.player.mode, 'survival');
  runCommand(g, '/gamemode spectator');
  assert.ok(isError(g.chat.at(-2)));
  runCommand(g, '/gamemode');
  assert.ok(errors(g).length >= 2);
});

test('/time set/add/query', () => {
  const g = mockGame();
  runCommand(g, '/time set night');
  assert.equal(g.time, 13000);
  runCommand(g, '/time set noon');
  assert.equal(g.time, 6000);
  runCommand(g, '/time set 1d');
  assert.equal(g.time, 24000);
  runCommand(g, '/time add 30s');
  assert.equal(g.time, 24600);
  runCommand(g, '/time add 100');
  assert.equal(g.time, 24700);
  runCommand(g, '/time query daytime');
  assert.match(last(g).text, /700/);
  runCommand(g, '/time query day');
  assert.match(last(g).text, /1/);
  runCommand(g, '/time set banana');
  assert.ok(isError(g.chat.at(-2)));
  assert.equal(g.time, 24700);
});

test('/tp absolute (centred), relative ~ and local ^ coordinates', () => {
  const g = mockGame();
  runCommand(g, '/tp 100 70 -20');
  assert.deepEqual([g.player.x, g.player.y, g.player.z], [100.5, 70, -19.5]);
  assert.equal(g.player.vy, 0, 'velocity reset');
  runCommand(g, '/tp ~ ~5 ~-1.5');
  assert.deepEqual([g.player.x, g.player.y, g.player.z], [100.5, 75, -21]);
  runCommand(g, '/tp @s 1.25 64 2.75');
  assert.deepEqual([g.player.x, g.player.y, g.player.z], [1.25, 64, 2.75]);
  // yaw 0 = looking north (-Z): ^ ^ ^10 moves 10 blocks north, ^2 ^ ^ two blocks west
  runCommand(g, '/tp ^ ^ ^10');
  assert.ok(Math.abs(g.player.z - (2.75 - 10)) < 1e-9 && Math.abs(g.player.x - 1.25) < 1e-9);
  runCommand(g, '/tp ^2 ^ ^');
  assert.ok(Math.abs(g.player.x - (1.25 - 2)) < 1e-9);
  // Minecraft yaw 90 (west) -> our yaw +pi/2
  runCommand(g, '/tp 0 64 0 90 -30');
  assert.ok(Math.abs(g.player.yaw - Math.PI / 2) < 1e-9);
  assert.ok(Math.abs(g.player.pitch - Math.PI / 6) < 1e-9);
  runCommand(g, '/tp ~ ~ ^1');
  assert.ok(isError(g.chat.at(-2)), 'mixing ~ and ^ is an error');
  runCommand(g, '/tp 1 2');
  assert.ok(isError(g.chat.at(-2)));
  runCommand(g, '/tp a b c');
  assert.ok(isError(g.chat.at(-2)));
});

test('/give accepts internal, namespaced and Chinese names, overflow is dropped', () => {
  const g = mockGame();
  runCommand(g, '/give diamond_pickaxe');
  assert.equal(g.player.inventory.count(ITEM.DIAMOND_PICKAXE), 1);
  runCommand(g, '/give minecraft:stone 100');
  assert.equal(g.player.inventory.count(ITEM.STONE), 100);
  runCommand(g, '/give 钻石 5');
  assert.equal(g.player.inventory.count(ITEM.DIAMOND), 5);
  assert.match(last(g).text, /5 个\[钻石\]/);
  runCommand(g, '/give @s 火把 3');
  assert.equal(g.player.inventory.count(ITEM.TORCH), 3);
  runCommand(g, '/give dimond');
  assert.ok(isError(g.chat.at(-2)));
  assert.match(g.chat.at(-2).text, /未知的物品/);
  runCommand(g, '/give stone 0');
  assert.ok(isError(g.chat.at(-2)));
  // fill the inventory, then overflow goes to dropFromPlayer
  const full = mockGame();
  for (let i = 0; i < 36; i++) full.player.inventory.set(i, makeStack(ITEM.DIRT, 64));
  runCommand(full, '/give glass 70');
  assert.deepEqual(full.drops.map((s) => s.count), [64, 6]);
});

test('/clear removes everything or a given item', () => {
  const g = mockGame();
  g.player.inventory.add(makeStack(ITEM.DIRT, 10));
  g.player.inventory.add(makeStack(ITEM.STONE, 5));
  runCommand(g, '/clear dirt 4');
  assert.equal(g.player.inventory.count(ITEM.DIRT), 6);
  runCommand(g, '/clear @s 石头 0');
  assert.equal(g.player.inventory.count(ITEM.STONE), 5, 'max 0 only counts');
  runCommand(g, '/clear');
  assert.ok(g.player.inventory.isEmpty());
  assert.match(last(g).text, /11/);
  runCommand(g, '/clear');
  assert.ok(isError(last(g)));
});

test('/kill, /seed, /spawnpoint, /setworldspawn', () => {
  const g = mockGame();
  runCommand(g, '/seed');
  assert.match(last(g).text, /123456/);
  runCommand(g, '/spawnpoint');
  assert.deepEqual(g.player.spawnPoint, { x: 10.5, y: 64, z: -3.5, forced: true }, 'personal spawn points are forced (exact y)');
  runCommand(g, '/spawnpoint 5 80 ~2');
  assert.deepEqual(g.player.spawnPoint, { x: 5.5, y: 80, z: -1.5, forced: true });
  runCommand(g, '/setworldspawn 1 2 3');
  assert.deepEqual(g.worldMeta.spawn, { x: 1.5, y: 2, z: 3.5 });
  assert.deepEqual(g.player.spawnPoint, { x: 5.5, y: 80, z: -1.5, forced: true }, 'a personal spawn point is kept');
  runCommand(g, '/kill');
  assert.equal(g.player.dead, true);
  assert.equal(g.player.lastCause, 'kill');
  runCommand(g, '/kill');
  assert.ok(isError(last(g)));
  const noWorld = mockGame({ worldMeta: null, world: null });
  runCommand(noWorld, '/seed');
  assert.ok(isError(last(noWorld)));
});

test('/setblock with names, modes and errors', () => {
  const g = mockGame();
  runCommand(g, '/setblock 1 70 2 diamond_block');
  assert.equal(g.world.getBlock(1, 70, 2), BLOCK.DIAMOND_BLOCK);
  runCommand(g, '/setblock ~ ~1 ~ 玻璃');
  assert.equal(g.world.getBlock(10, 65, -4), BLOCK.GLASS);
  runCommand(g, '/setblock 1 70 2 stone keep');
  assert.ok(isError(last(g)), 'keep fails on an occupied cell');
  runCommand(g, '/setblock 1 63 2 air destroy');
  assert.equal(g.world.getBlock(1, 63, 2), BLOCK.AIR);
  assert.equal(g.spawned[0].s.id, ITEM.COBBLESTONE, 'destroy drops the block item');
  runCommand(g, '/setblock 1 300 2 stone');
  assert.ok(isError(g.chat.at(-2)));
  runCommand(g, '/setblock 5000 70 0 stone');
  assert.match(last(g).text, /尚未加载/);
  runCommand(g, '/setblock 1 70 2 unobtainium');
  assert.ok(isError(g.chat.at(-2)));
  runCommand(g, '/setblock 0 70 0 oak_log_x');
  assert.equal(g.world.getBlock(0, 70, 0), BLOCK.OAK_LOG_X, 'hidden variants by internal name');
});

test('/fill modes and the volume limit', () => {
  const g = mockGame();
  runCommand(g, '/fill 0 70 0 2 72 2 stone');
  assert.match(last(g).text, /27/);
  runCommand(g, '/fill 0 70 0 2 72 2 glass hollow');
  assert.equal(g.world.getBlock(1, 71, 1), BLOCK.AIR);
  assert.equal(g.world.getBlock(0, 70, 0), BLOCK.GLASS);
  runCommand(g, '/fill 0 70 0 2 72 2 dirt outline');
  assert.equal(g.world.getBlock(1, 71, 1), BLOCK.AIR, 'outline keeps the inside');
  assert.equal(g.world.getBlock(2, 72, 2), BLOCK.DIRT);
  runCommand(g, '/fill 0 70 0 2 72 2 sand keep');
  assert.equal(g.world.getBlock(1, 71, 1), BLOCK.SAND);
  assert.equal(g.world.getBlock(0, 70, 0), BLOCK.DIRT);
  runCommand(g, '/fill 0 70 0 2 72 2 bricks replace sand');
  assert.equal(g.world.getBlock(1, 71, 1), BLOCK.BRICKS);
  assert.equal(g.world.getBlock(0, 70, 0), BLOCK.DIRT);
  runCommand(g, '/fill 0 0 0 100 100 100 stone');
  assert.ok(isError(last(g)));
  assert.match(last(g).text, /32768/);
  runCommand(g, '/fill 0 70 0 2 72 2 bricks replace sand');
  assert.ok(isError(last(g)), 'nothing filled');
});

test('/say and /me', () => {
  const g = mockGame();
  runCommand(g, '/say 大家好 hello');
  assert.equal(last(g).text, '[玩家] 大家好 hello');
  runCommand(g, '/me 挖了一块钻石');
  assert.equal(last(g).text, '* 玩家 挖了一块钻石');
});

test('name resolution helpers', () => {
  assert.equal(resolveItem('Diamond Pickaxe'), ITEM.DIAMOND_PICKAXE);
  assert.equal(resolveItem('钻石镐'), ITEM.DIAMOND_PICKAXE);
  assert.equal(resolveItem('minecraft:oak_log'), ITEM.OAK_LOG);
  assert.equal(resolveItem('256'), ITEM.STICK);
  assert.equal(resolveItem('oak_log_x'), null, 'variants are not items');
  assert.equal(resolveBlock('air'), BLOCK.AIR);
  assert.equal(resolveBlock('空气'), BLOCK.AIR);
  assert.equal(resolveBlock('橡木原木'), BLOCK.OAK_LOG);
  assert.equal(resolveBlock('furnace_east'), BLOCK.FURNACE_EAST);
  assert.equal(resolveBlock('stick'), null);
});

test('tab completion', () => {
  const g = mockGame();
  let c = getCompletions(g, '/ga');
  assert.deepEqual(c.options, ['gamemode']);
  assert.equal(c.start, 1);
  c = getCompletions(g, '/gamemode c');
  assert.deepEqual(c.options, ['creative']);
  assert.equal(c.start, 10);
  c = getCompletions(g, '/give diamond_p');
  assert.ok(c.options.includes('diamond_pickaxe'));
  assert.match(c.usage, /\/give/);
  c = getCompletions(g, '/give 钻石');
  assert.ok(c.options.includes('钻石镐'));
  c = getCompletions(g, '/time set ');
  assert.deepEqual(c.options, ['day', 'noon', 'night', 'midnight']);
  c = getCompletions({ ...g, interaction: { target: { x: 4, y: 65, z: -7 } } }, '/setblock ');
  assert.deepEqual(c.options, ['4 65 -7']);
  c = getCompletions(g, '/setblock 1 2 3 dia');
  assert.ok(c.options.includes('diamond_block') && c.options.includes('diamond_ore'));
  assert.equal(getCompletions(g, 'hello'), null);
});

test('unknown item names get "did you mean" hints', () => {
  const g = mockGame();
  runCommand(g, '/give dimond');
  const msg = g.chat.find((m) => m.color === '#FF5555').text;
  assert.match(msg, /你是不是想找：diamond/);
  g.chat.length = 0;
  runCommand(g, '/give 钻石稿');
  assert.ok(g.chat.some((m) => /未知的物品/.test(m.text)));
});

// ---------------------------------------------------------------------------------------------
// Wave 2: /setworldspawn following, /summon, /difficulty, /kill with entity selectors
// ---------------------------------------------------------------------------------------------

test('/setworldspawn moves the respawn point of players that follow the world spawn', () => {
  const g = mockGame();
  g.player.spawnPoint = { x: 0.5, y: 70, z: 0.5 }; // same as the world spawn: follows it
  runCommand(g, '/setworldspawn 8 66 -4');
  assert.deepEqual(g.player.spawnPoint, { x: 8.5, y: 66, z: -3.5, forced: false });
  runCommand(g, '/setworldspawn 9 67 -5');
  assert.deepEqual(g.player.spawnPoint, { x: 9.5, y: 67, z: -4.5, forced: false }, 'forced:false keeps following');
});

/** Mock game with entities (fake mobs / items) and a spawnMob facade recording calls. */
function entityGame(overrides = {}) {
  const g = mockGame(overrides);
  const list = [];
  g.entities = { list };
  g.settings = { difficulty: 'normal' };
  g.summoned = [];
  g.spawnMob = (type, x, y, z, opts) => {
    const mob = { type: 'mob', mobType: type, x, y, z, opts, removed: false, dead: false, kill() { this.dead = true; } };
    g.summoned.push(mob);
    list.push(mob);
    return mob;
  };
  g.applySettings = (partial) => Object.assign(g.settings, partial);
  return g;
}

function addMob(g, mobType, x, y, z) {
  const mob = { type: 'mob', mobType, x, y, z, removed: false, dead: false, killed: 0, kill() { this.dead = true; this.killed++; } };
  g.entities.list.push(mob);
  return mob;
}

function addItem(g, id, x, y, z) {
  const e = { type: 'item', stack: makeStack(id, 1), x, y, z, removed: false, remove() { this.removed = true; } };
  g.entities.list.push(e);
  return e;
}

test('/summon spawns mobs at the player or at coordinates (English, namespaced, Chinese names)', () => {
  const g = entityGame();
  runCommand(g, '/summon zombie');
  assert.equal(g.summoned.length, 1);
  assert.deepEqual([g.summoned[0].mobType, g.summoned[0].x, g.summoned[0].y, g.summoned[0].z], ['zombie', 10.5, 64, -3.5]);
  assert.equal(g.summoned[0].opts.persistent, false, 'summoned mobs may despawn like in Minecraft');
  assert.equal(last(g).text, '已召唤新的僵尸');
  runCommand(g, '/summon minecraft:pig 1 70 2');
  assert.deepEqual([g.summoned[1].mobType, g.summoned[1].x, g.summoned[1].y, g.summoned[1].z], ['pig', 1.5, 70, 2.5]);
  runCommand(g, '/summon 苦力怕 ~ ~1 ~');
  assert.equal(g.summoned[2].mobType, 'creeper');
  assert.equal(g.summoned[2].y, 65);
  assert.equal(last(g).text, '已召唤新的苦力怕');
  for (const t of ['cow', 'sheep', 'chicken', 'skeleton', 'spider']) runCommand(g, `/summon ${t}`);
  assert.deepEqual(g.summoned.map((m) => m.mobType).slice(3), ['cow', 'sheep', 'chicken', 'skeleton', 'spider']);
  assert.equal(errors(g).length, 0);
});

test('/summon errors: unknown entity, missing type, bad / unloaded position, extra args, peaceful hostiles', () => {
  const g = entityGame();
  g.world.isChunkGenerated = (cx) => Math.abs(cx) < 10;
  runCommand(g, '/summon dragon');
  assert.ok(isError(g.chat.at(-2)));
  assert.match(g.chat.at(-2).text, /未知的实体/);
  runCommand(g, '/summon');
  assert.ok(isError(g.chat.at(-2)));
  runCommand(g, '/summon pig 1 2');
  assert.ok(isError(g.chat.at(-2)), 'incomplete coordinates');
  runCommand(g, '/summon pig 1 300 2');
  assert.match(errors(g).at(-1).text, /无效的召唤位置/);
  runCommand(g, '/summon pig 5000 70 0');
  assert.match(last(g).text, /尚未加载/);
  runCommand(g, '/summon pig 1 70 2 {NoAI:1b}');
  assert.match(errors(g).at(-1).text, /多余的参数/);
  g.settings.difficulty = 'peaceful';
  runCommand(g, '/summon zombie');
  assert.match(last(g).text, /和平难度/);
  runCommand(g, '/summon cow');
  assert.equal(last(g).text, '已召唤新的牛', 'animals can be summoned in peaceful');
  assert.equal(g.summoned.length, 1);
  g.spawnMob = () => null;
  runCommand(g, '/summon cow');
  assert.match(last(g).text, /无法召唤实体/);
});

test('/summon uses spawnMob() from src/game/mobs.js when the game has no spawnMob facade', async (t) => {
  let mobs;
  try {
    mobs = await import('../src/game/mobs.js');
  } catch (err) {
    t.skip(`mobs.js not available: ${err.message}`);
    return;
  }
  if (typeof mobs.spawnMob !== 'function') {
    t.skip('mobs.js has no spawnMob yet');
    return;
  }
  const g = mockGame();
  const added = [];
  g.settings = { difficulty: 'normal' };
  g.world.getLight = () => 0xf0;
  g.world.isChunkGenerated = () => true;
  g.entities = { list: added, rng: Math.random, add(e) { e.manager = this; added.push(e); return e; } };
  const r = runCommand(g, '/summon sheep 3 70 4');
  if (r && typeof r.then === 'function') await r;
  assert.equal(errors(g).length, 0, JSON.stringify(g.chat));
  assert.equal(added.length, 1);
  assert.equal(added[0].mobType, 'sheep');
  assert.equal(last(g).text, '已召唤新的羊');
  // the module is cached afterwards: the next summon completes synchronously
  const r2 = runCommand(g, '/summon chicken');
  assert.equal(r2, undefined);
  assert.equal(added.length, 2);
});

test('/difficulty queries and sets settings.difficulty (English, Chinese, numbers)', () => {
  const g = entityGame();
  runCommand(g, '/difficulty');
  assert.equal(last(g).text, '难度为普通');
  runCommand(g, '/difficulty hard');
  assert.equal(g.settings.difficulty, 'hard');
  assert.equal(last(g).text, '难度已被设置为困难');
  runCommand(g, '/difficulty 和平');
  assert.equal(g.settings.difficulty, 'peaceful');
  runCommand(g, '/difficulty 1');
  assert.equal(g.settings.difficulty, 'easy');
  runCommand(g, '/difficulty easy');
  assert.ok(isError(last(g)), 'unchanged difficulty is an error (Minecraft)');
  assert.match(last(g).text, /已经是简单/);
  runCommand(g, '/difficulty insane');
  assert.ok(isError(g.chat.at(-2)));
  assert.equal(g.settings.difficulty, 'easy');
  // a game whose settings validation drops strings still gets the difficulty (session fallback)
  const strict = entityGame();
  const events = [];
  strict.applySettings = () => {};
  strict.emit = (name, changed) => events.push([name, changed]);
  runCommand(strict, '/difficulty hard');
  assert.equal(strict.settings.difficulty, 'hard');
  assert.deepEqual(events, [['settingsChanged', { difficulty: 'hard' }]]);
});

test('/kill @e kills every mob, @e[type=…] filters, items and players need an explicit type', () => {
  const g = entityGame();
  const z1 = addMob(g, 'zombie', 12, 64, -3);
  const z2 = addMob(g, 'zombie', 40, 64, -3);
  const pig = addMob(g, 'pig', 11, 64, -3);
  const item = addItem(g, ITEM.DIAMOND, 10, 64, -3);
  runCommand(g, '/kill @e[type=zombie]');
  assert.ok(z1.dead && z2.dead && !pig.dead && !item.removed);
  assert.equal(last(g).text, '已杀死2个实体');
  runCommand(g, '/kill @e[type=zombie]');
  assert.match(last(g).text, /未找到实体/, 'dead mobs are not selected again');
  runCommand(g, '/kill @e');
  assert.ok(pig.dead && !item.removed, '@e = all mobs only');
  assert.equal(last(g).text, '已杀死猪');
  runCommand(g, '/kill @e[type=item]');
  assert.ok(item.removed);
  assert.equal(last(g).text, '已杀死钻石');
  assert.equal(g.player.dead, false);
});

test('/kill selector arguments: negation, distance, limit, sort, Chinese types and errors', () => {
  const g = entityGame();
  const near = addMob(g, 'skeleton', 12.5, 64, -3.5);    // 2 blocks
  const mid = addMob(g, 'spider', 16.5, 64, -3.5);       // 6 blocks
  const far = addMob(g, 'creeper', 40.5, 64, -3.5);      // 30 blocks
  runCommand(g, '/kill @e[type=!creeper,distance=..10]');
  assert.ok(near.dead && mid.dead && !far.dead);
  near.dead = false; mid.dead = false;
  runCommand(g, '/kill @e[sort=nearest,limit=1]');
  assert.ok(near.dead && !mid.dead && !far.dead);
  assert.equal(last(g).text, '已杀死骷髅');
  runCommand(g, '/kill @e[sort=furthest,limit=1]');
  assert.ok(far.dead && !mid.dead);
  runCommand(g, '/kill @e[type=蜘蛛]');
  assert.ok(mid.dead);
  runCommand(g, '/kill @e[type=dragon]');
  assert.match(g.chat.at(-2).text, /未知的实体类型/);
  runCommand(g, '/kill @e[foo=1]');
  assert.match(g.chat.at(-2).text, /未知的选择器参数/);
  runCommand(g, '/kill @e[limit=0]');
  assert.ok(isError(g.chat.at(-2)));
  runCommand(g, '/kill @e[distance=abc]');
  assert.ok(isError(g.chat.at(-2)));
  runCommand(g, '/kill nobody');
  assert.match(errors(g).at(-1).text, /未找到实体/);
  assert.equal(g.player.dead, false);
  runCommand(g, '/kill @e[type=player]');
  assert.equal(g.player.dead, true, 'type=player selects the player');
});

test('/kill without arguments, @s and @p still kill the player', () => {
  for (const cmd of ['/kill', '/kill @s', '/kill @p', '/kill 玩家', '/kill @a[distance=..5]']) {
    const g = entityGame();
    const pig = addMob(g, 'pig', 11, 64, -3);
    runCommand(g, cmd);
    assert.equal(g.player.dead, true, cmd);
    assert.equal(pig.dead, false, cmd);
  }
});

test('tab completion for /summon, /kill selectors and /difficulty', () => {
  const g = entityGame();
  let c = getCompletions(g, '/summon z');
  assert.deepEqual(c.options, ['zombie']);
  c = getCompletions(g, '/summon ');
  assert.equal(c.options.length, 8);
  c = getCompletions(g, '/summon 僵');
  assert.deepEqual(c.options, ['僵尸']);
  c = getCompletions(g, '/summon pig ');
  assert.deepEqual(c.options, ['~ ~ ~']);
  c = getCompletions(g, '/kill @e[type=sk');
  assert.deepEqual(c.options, ['@e[type=skeleton]']);
  c = getCompletions(g, '/difficulty ');
  assert.deepEqual(c.options, ['peaceful', 'easy', 'normal', 'hard']);
  c = getCompletions(g, '/difficulty 困');
  assert.deepEqual(c.options, ['困难']);
  for (const name of ['summon', 'difficulty', 'kill']) assert.ok(COMMAND_LIST.some((x) => x.name === name), name);
});


test('/setblock and /fill clear replaced containers (Minecraft), destroy mode drops their contents', async () => {
  const { BlockEntityManager } = await import('../src/game/blockentities.js');
  const g = mockGame();
  const listeners = [];
  const set = g.world.setBlock.bind(g.world);
  g.world.setBlock = (x, y, z, id) => {
    const old = g.world.getBlock(x, y, z);
    const ok = set(x, y, z, id);
    if (ok && old !== id) for (const fn of listeners) fn(x, y, z, old, id);
    return ok;
  };
  g.world.onBlockChanged = (fn) => { listeners.push(fn); return () => {}; };
  g.blockEntities = new BlockEntityManager(g).attach(g.world);
  runCommand(g, '/setblock 1 70 1 chest');
  g.blockEntities.get(1, 70, 1).set(0, makeStack(ITEM.DIAMOND, 4));
  runCommand(g, '/setblock 1 70 1 stone');
  assert.equal(g.blockEntities.get(1, 70, 1), null);
  assert.equal(g.spawned.filter((d) => d.s.id === ITEM.DIAMOND).length, 0, 'replace clears');
  runCommand(g, '/setblock 1 70 1 chest');
  g.blockEntities.get(1, 70, 1).set(0, makeStack(ITEM.DIAMOND, 4));
  runCommand(g, '/setblock 1 70 1 air destroy');
  assert.equal(g.spawned.filter((d) => d.s.id === ITEM.DIAMOND).reduce((n, d) => n + d.s.count, 0), 4, 'destroy drops');
  assert.ok(g.spawned.some((d) => d.s.id === ITEM.CHEST), 'and the chest itself');
  runCommand(g, '/setblock 2 70 2 furnace');
  g.blockEntities.get(2, 70, 2).set(0, makeStack(ITEM.IRON_ORE, 4));
  runCommand(g, '/fill 0 70 0 3 70 3 glass');
  assert.equal(g.blockEntities.get(2, 70, 2), null);
  assert.equal(g.spawned.filter((d) => d.s.id === ITEM.IRON_ORE).length, 0);
});
