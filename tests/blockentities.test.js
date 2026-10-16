import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BlockEntityManager, FurnaceBlockEntity, ChestBlockEntity, containerType, litFurnaceOf, unlitFurnaceOf,
  fuelTicks, isFuel, cookTicksFor, displayTickChance, blockEntityFromJSON, CHEST_SIZE,
} from '../src/game/blockentities.js';
import { BLOCK, ITEM } from '../src/world/registry.js';
import { makeStack } from '../src/game/inventory.js';

/** Map-backed world with onBlockChanged listeners (like World) and optional unloaded chunks. */
function mockWorld() {
  const blocks = new Map();
  const listeners = [];
  const unloaded = new Set();
  return {
    blocks, unloaded, setCalls: 0,
    getBlock(x, y, z) {
      return blocks.get(`${x},${y},${z}`) ?? 0;
    },
    setBlock(x, y, z, id) {
      if (unloaded.has(`${x >> 4},${z >> 4}`)) return false;
      const old = this.getBlock(x, y, z);
      if (old === id) return true;
      this.setCalls++;
      blocks.set(`${x},${y},${z}`, id);
      for (const fn of listeners.slice()) fn(x, y, z, old, id);
      return true;
    },
    onBlockChanged(fn) {
      listeners.push(fn);
      return () => {
        const i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    isChunkGenerated(cx, cz) {
      return !unloaded.has(`${cx},${cz}`);
    },
    listenerCount: () => listeners.length,
  };
}

function seeded(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function setup() {
  const world = mockWorld();
  const spawned = [];
  const opened = [];
  const sounds = [];
  const flames = [];
  const game = {
    world,
    player: { x: 0.5, y: 64, z: 3.5, dead: false },
    spawnItem(stack, x, y, z, vx, vy, vz, delay) {
      spawned.push({ stack, x, y, z, vx, vy, vz, delay });
    },
    ui: {
      openFurnace(be) { opened.push(['furnace', be]); },
      openChest(be) { opened.push(['chest', be]); },
    },
    audio: { play(name, o) { sounds.push([name, o]); } },
    particles: { spawnTorchFlame(x, y, z) { flames.push([x, y, z]); } },
  };
  const mgr = new BlockEntityManager(game, { rng: seeded(7) }).attach(world);
  return { world, game, mgr, spawned, opened, sounds, flames };
}

const ticks = (mgr, n) => {
  for (let i = 0; i < n; i++) mgr.tick(1 / 20);
};
const simple = (s) => (s ? [s.id, s.count] : null);
const total = (spawned, id) => spawned.filter((d) => d.stack.id === id).reduce((n, d) => n + d.stack.count, 0);

test('block tables: container types and lit / unlit furnace variants keep the facing', () => {
  assert.equal(containerType(BLOCK.FURNACE), 'furnace');
  assert.equal(containerType(BLOCK.LIT_FURNACE_WEST), 'furnace');
  assert.equal(containerType(BLOCK.CHEST_EAST), 'chest');
  assert.equal(containerType(BLOCK.STONE), null);
  assert.equal(containerType(BLOCK.CRAFTING_TABLE), null);
  const pairs = [
    [BLOCK.FURNACE, BLOCK.LIT_FURNACE], [BLOCK.FURNACE_NORTH, BLOCK.LIT_FURNACE_NORTH],
    [BLOCK.FURNACE_EAST, BLOCK.LIT_FURNACE_EAST], [BLOCK.FURNACE_WEST, BLOCK.LIT_FURNACE_WEST],
  ];
  for (const [unlit, lit] of pairs) {
    assert.equal(litFurnaceOf(unlit), lit);
    assert.equal(litFurnaceOf(lit), lit);
    assert.equal(unlitFurnaceOf(lit), unlit);
    assert.equal(unlitFurnaceOf(unlit), unlit);
  }
  assert.equal(litFurnaceOf(BLOCK.CHEST), -1);
});

test('fuel values come from items.js (seconds -> ticks)', () => {
  assert.equal(fuelTicks(ITEM.COAL), 1600);
  assert.equal(fuelTicks(ITEM.CHARCOAL), 1600);
  assert.equal(fuelTicks(ITEM.OAK_PLANKS), 300);
  assert.equal(fuelTicks(ITEM.STICK), 100);
  assert.equal(fuelTicks(ITEM.LAVA_BUCKET), 20000);
  assert.equal(fuelTicks(ITEM.COAL_BLOCK), 16000);
  assert.equal(fuelTicks(ITEM.BOW), 300);
  assert.equal(fuelTicks(ITEM.WOODEN_PICKAXE), 200);
  assert.equal(isFuel(ITEM.DIRT), false);
  assert.equal(isFuel(ITEM.BUCKET), false);
  assert.equal(cookTicksFor(makeStack(ITEM.IRON_ORE, 1)), 200);
  assert.equal(cookTicksFor(null), 200);
});

test('placing a container block creates its entity; breaking drops the contents (Containers.dropContents)', () => {
  const { world, mgr, spawned } = setup();
  world.setBlock(2, 64, 3, BLOCK.CHEST_NORTH);
  const chest = mgr.get(2, 64, 3);
  assert.ok(chest instanceof ChestBlockEntity);
  assert.equal(chest.size, CHEST_SIZE);
  chest.set(0, makeStack(ITEM.COBBLESTONE, 64));
  chest.set(5, makeStack(ITEM.DIAMOND, 3));
  chest.set(26, makeStack(ITEM.IRON_PICKAXE, 1, 17));
  world.setBlock(2, 64, 3, BLOCK.AIR);
  assert.equal(mgr.get(2, 64, 3), null);
  assert.equal(chest.removed, true);
  assert.equal(total(spawned, ITEM.COBBLESTONE), 64);
  assert.equal(total(spawned, ITEM.DIAMOND), 3);
  const pick = spawned.find((d) => d.stack.id === ITEM.IRON_PICKAXE);
  assert.equal(pick.stack.damage, 17, 'tool damage is kept');
  for (const d of spawned) {
    assert.ok(d.stack.count >= 1 && d.stack.count <= 30, 'stacks split into parts of 10..30');
    assert.ok(d.x >= 2.125 && d.x <= 2.875 && d.z >= 3.125 && d.z <= 3.875 && d.y >= 64 && d.y <= 64.75, 'inside the cell');
    assert.ok(d.vy > 0, 'small hop');
    assert.equal(d.delay, 0);
  }
  assert.ok(spawned.filter((d) => d.stack.id === ITEM.COBBLESTONE).length >= 3, '64 cobblestone in 3+ parts');
});

test('furnace: one iron ore smelts in exactly 200 ticks; coal lights immediately and lasts 1600 ticks', () => {
  const { world, mgr } = setup();
  world.setBlock(0, 64, 0, BLOCK.FURNACE);
  const f = mgr.get(0, 64, 0);
  assert.ok(f instanceof FurnaceBlockEntity);
  f.set(0, makeStack(ITEM.IRON_ORE, 3));
  f.set(1, makeStack(ITEM.COAL, 2));
  ticks(mgr, 1);
  assert.equal(f.burnTicks, 1600, 'coal consumed on the first tick');
  assert.equal(f.burnTotalTicks, 1600);
  assert.deepEqual(simple(f.get(1)), [ITEM.COAL, 1]);
  assert.equal(f.cookTicks, 1);
  assert.equal(world.getBlock(0, 64, 0), BLOCK.LIT_FURNACE, 'lit while burning');
  ticks(mgr, 198);
  assert.equal(f.get(2), null);
  assert.equal(f.cookTicks, 199);
  ticks(mgr, 1);
  assert.deepEqual(simple(f.get(2)), [ITEM.IRON_INGOT, 1], 'tick 200');
  assert.deepEqual(simple(f.get(0)), [ITEM.IRON_ORE, 2]);
  assert.equal(f.cookTicks, 0);
  assert.ok(Math.abs(f.burnTime - 1401 / 20) < 1e-9, 'SPEC burnTime getter in seconds');
  assert.equal(f.cookTotal, 10);
  ticks(mgr, 400);
  assert.deepEqual(simple(f.get(2)), [ITEM.IRON_INGOT, 3]);
  assert.equal(f.get(0), null);
  assert.deepEqual(simple(f.get(1)), [ITEM.COAL, 1], 'no second coal while the fire still burns');
  // nothing left to smelt: the fire burns out (lit on tick 1 for 1600 ticks -> out on tick 1601)
  ticks(mgr, 1000);
  assert.equal(f.burnTicks, 1);
  assert.equal(world.getBlock(0, 64, 0), BLOCK.LIT_FURNACE);
  ticks(mgr, 1);
  assert.equal(f.burnTicks, 0);
  assert.equal(world.getBlock(0, 64, 0), BLOCK.FURNACE);
  assert.deepEqual(simple(f.get(1)), [ITEM.COAL, 1], 'fuel is not wasted without input');
});

test('furnace: one coal smelts exactly 8 items, a stick half an item (progress then decays by 2/tick)', () => {
  const { world, mgr } = setup();
  world.setBlock(0, 64, 0, BLOCK.FURNACE);
  const f = mgr.get(0, 64, 0);
  f.set(0, makeStack(ITEM.SAND, 20));
  f.set(1, makeStack(ITEM.COAL, 1));
  ticks(mgr, 1600);
  assert.deepEqual(simple(f.get(2)), [ITEM.GLASS, 8]);
  assert.equal(f.burnTicks, 1);
  ticks(mgr, 1);
  assert.equal(f.burnTicks, 0);
  assert.equal(world.getBlock(0, 64, 0), BLOCK.FURNACE);
  assert.deepEqual(simple(f.get(2)), [ITEM.GLASS, 8]);

  f.set(1, makeStack(ITEM.STICK, 1));
  ticks(mgr, 100);
  assert.equal(f.cookTicks, 100);
  assert.equal(f.get(1), null);
  ticks(mgr, 1);
  assert.equal(f.burnTicks, 0);
  assert.equal(f.cookTicks, 98, 'decays by 2 per tick without fire');
  ticks(mgr, 9);
  assert.equal(f.cookTicks, 80);
  ticks(mgr, 100);
  assert.equal(f.cookTicks, 0);
  assert.deepEqual(simple(f.get(2)), [ITEM.GLASS, 8], 'half an item is not enough');
});

test('furnace: lava bucket leaves an empty bucket; planks / logs / tools burn their Minecraft times', () => {
  const { world, mgr } = setup();
  world.setBlock(0, 64, 0, BLOCK.FURNACE_EAST);
  const f = mgr.get(0, 64, 0);
  f.set(0, makeStack(ITEM.BEEF, 1));
  f.set(1, makeStack(ITEM.LAVA_BUCKET, 1));
  ticks(mgr, 1);
  assert.deepEqual(simple(f.get(1)), [ITEM.BUCKET, 1]);
  assert.equal(f.burnTicks, 20000);
  assert.equal(world.getBlock(0, 64, 0), BLOCK.LIT_FURNACE_EAST, 'facing preserved');
  ticks(mgr, 199);
  assert.deepEqual(simple(f.get(2)), [ITEM.COOKED_BEEF, 1]);
  // the bucket in the fuel slot is not a fuel
  f.burnTicks = 1;
  f.set(0, makeStack(ITEM.MUTTON, 1));
  ticks(mgr, 2);
  assert.equal(f.burnTicks, 0);
  assert.equal(world.getBlock(0, 64, 0), BLOCK.FURNACE_EAST);
  assert.deepEqual(simple(f.get(1)), [ITEM.BUCKET, 1]);
});

test('furnace: fuel is only lit for something it can smelt (no input, unsmeltable input, full / other output)', () => {
  const { world, mgr } = setup();
  world.setBlock(0, 64, 0, BLOCK.FURNACE);
  const f = mgr.get(0, 64, 0);
  f.set(1, makeStack(ITEM.COAL, 5));
  ticks(mgr, 20);
  assert.equal(f.burnTicks, 0, 'no input');
  f.set(0, makeStack(ITEM.DIRT, 5));
  ticks(mgr, 20);
  assert.equal(f.burnTicks, 0, 'dirt cannot be smelted');
  f.set(0, makeStack(ITEM.IRON_ORE, 5));
  f.set(2, makeStack(ITEM.IRON_INGOT, 64));
  ticks(mgr, 20);
  assert.equal(f.burnTicks, 0, 'output full');
  f.set(2, makeStack(ITEM.GOLD_INGOT, 1));
  ticks(mgr, 20);
  assert.equal(f.burnTicks, 0, 'different item in the output');
  assert.deepEqual(simple(f.get(1)), [ITEM.COAL, 5]);
  assert.equal(world.getBlock(0, 64, 0), BLOCK.FURNACE);
  f.set(2, makeStack(ITEM.IRON_INGOT, 63));
  ticks(mgr, 200);
  assert.deepEqual(simple(f.get(2)), [ITEM.IRON_INGOT, 64], 'stacks up to 64');
  ticks(mgr, 200);
  assert.deepEqual(simple(f.get(2)), [ITEM.IRON_INGOT, 64]);
  assert.deepEqual(simple(f.get(0)), [ITEM.IRON_ORE, 4], 'stops when the output is full');
  assert.equal(f.cookTicks, 0, 'no progress while blocked');
  assert.ok(f.burnTicks > 0, 'the fire keeps burning (Minecraft)');
});

test('furnace: changing the input item resets the progress, adding more of the same keeps it', () => {
  const { world, mgr } = setup();
  world.setBlock(0, 64, 0, BLOCK.FURNACE);
  const f = mgr.get(0, 64, 0);
  f.set(0, makeStack(ITEM.IRON_ORE, 1));
  f.set(1, makeStack(ITEM.COAL, 1));
  ticks(mgr, 100);
  assert.equal(f.cookTicks, 100);
  f.set(0, makeStack(ITEM.IRON_ORE, 5));
  assert.equal(f.cookTicks, 100, 'same item: progress kept');
  f.set(0, makeStack(ITEM.GOLD_ORE, 5));
  assert.equal(f.cookTicks, 0, 'other item: restart');
  ticks(mgr, 200);
  assert.deepEqual(simple(f.get(2)), [ITEM.GOLD_INGOT, 1]);
  f.set(0, null);
  assert.equal(f.cookTicks, 0);
  assert.equal(f.cookProgress, 0);
});

test('furnace progress getters (flame / arrow fractions)', () => {
  const f = new FurnaceBlockEntity(0, 0, 0);
  assert.equal(f.litProgress, 0);
  assert.equal(f.cookProgress, 0);
  assert.equal(f.lit, false);
  f.burnTicks = 400;
  f.burnTotalTicks = 1600;
  f.cookTicks = 50;
  assert.equal(f.litProgress, 0.25);
  assert.equal(f.cookProgress, 0.25);
  assert.equal(f.lit, true);
  f.burnTotalTicks = 0;
  f.burnTicks = 100;
  assert.equal(f.litProgress, 0.5, 'missing total counts as 200 ticks (Minecraft)');
});

test('slot rules: furnace output take-only, fuel slot fuels + buckets (max 1), quick-move routing', () => {
  const f = new FurnaceBlockEntity(0, 0, 0);
  const s = (id, n = 1) => makeStack(id, n);
  assert.equal(f.mayPlace(0, s(ITEM.DIRT)), true);
  assert.equal(f.mayPlace(1, s(ITEM.COAL)), true);
  assert.equal(f.mayPlace(1, s(ITEM.LAVA_BUCKET)), true);
  assert.equal(f.mayPlace(1, s(ITEM.BUCKET)), true);
  assert.equal(f.mayPlace(1, s(ITEM.DIRT)), false);
  assert.equal(f.mayPlace(2, s(ITEM.IRON_INGOT)), false);
  assert.equal(f.slotMax(1, s(ITEM.BUCKET)), 1);
  assert.equal(f.slotMax(1, s(ITEM.COAL)), 64);
  assert.deepEqual(f.quickMoveIn(s(ITEM.IRON_ORE)), [0]);
  assert.deepEqual(f.quickMoveIn(s(ITEM.OAK_LOG)), [0], 'smeltable wins over fuel');
  assert.deepEqual(f.quickMoveIn(s(ITEM.COAL)), [1]);
  assert.equal(f.quickMoveIn(s(ITEM.DIRT)), null);
  assert.equal(f.quickMoveOut(2), 'reverse');
  assert.equal(f.quickMoveOut(0), 'forward');
  const c = new ChestBlockEntity(0, 0, 0);
  assert.equal(c.quickMoveIn(s(ITEM.DIRT)).length, 27);
  assert.equal(c.mayPlace(13, s(ITEM.DIAMOND_SWORD)), true);
});

test('lit state is restored on the block even when it was changed behind the furnace\'s back', () => {
  const { world, mgr } = setup();
  world.setBlock(0, 64, 0, BLOCK.FURNACE_NORTH);
  const f = mgr.get(0, 64, 0);
  world.blocks.set('0,64,0', BLOCK.LIT_FURNACE_NORTH); // e.g. /setblock lit_furnace without fire
  ticks(mgr, 1);
  assert.equal(world.getBlock(0, 64, 0), BLOCK.FURNACE_NORTH);
  assert.equal(mgr.get(0, 64, 0), f, 'same family keeps the entity');
});

test('furnaces in unloaded chunks are frozen; a furnace whose block vanished drops its items', () => {
  const { world, mgr, spawned } = setup();
  world.setBlock(40, 64, 0, BLOCK.FURNACE);
  const f = mgr.get(40, 64, 0);
  f.set(0, makeStack(ITEM.IRON_ORE, 2));
  f.set(1, makeStack(ITEM.COAL, 1));
  world.unloaded.add('2,0');
  ticks(mgr, 300);
  assert.equal(f.burnTicks, 0);
  assert.equal(f.get(2), null);
  world.unloaded.delete('2,0');
  ticks(mgr, 1);
  assert.equal(f.burnTicks, 1600);
  // the block is replaced without an onBlockChanged notification (e.g. edited while detached)
  world.blocks.set('40,64,0', BLOCK.STONE);
  ticks(mgr, 1);
  assert.equal(mgr.get(40, 64, 0), null);
  assert.equal(total(spawned, ITEM.IRON_ORE), 2);
});

test('lit swap goes through world.setBlock only when the state changes', () => {
  const { world, mgr } = setup();
  world.setBlock(0, 64, 0, BLOCK.FURNACE);
  const f = mgr.get(0, 64, 0);
  f.set(0, makeStack(ITEM.COBBLESTONE, 64));
  f.set(1, makeStack(ITEM.COAL, 1));
  const before = world.setCalls;
  ticks(mgr, 1000);
  assert.equal(world.setCalls - before, 1, 'one swap to lit');
  ticks(mgr, 700);
  assert.equal(world.setCalls - before, 2, 'and one back');
  assert.deepEqual(simple(f.get(2)), [ITEM.STONE, 8]);
});

test('replacing a container by another container or with /setblock of the same family', () => {
  const { world, mgr, spawned } = setup();
  world.setBlock(1, 64, 1, BLOCK.CHEST);
  mgr.get(1, 64, 1).set(3, makeStack(ITEM.APPLE, 2));
  world.setBlock(1, 64, 1, BLOCK.CHEST_WEST);
  assert.deepEqual(simple(mgr.get(1, 64, 1).get(3)), [ITEM.APPLE, 2], 'turning a chest keeps its contents');
  world.setBlock(1, 64, 1, BLOCK.FURNACE);
  assert.equal(total(spawned, ITEM.APPLE), 2);
  assert.ok(mgr.get(1, 64, 1) instanceof FurnaceBlockEntity);
});

test('useBlock opens the screens, refuses blocked chests (Minecraft), ignores other blocks', () => {
  const { world, mgr, opened } = setup();
  world.setBlock(0, 64, 0, BLOCK.CHEST);
  world.setBlock(1, 64, 0, BLOCK.FURNACE_WEST);
  assert.equal(mgr.useBlock(0, 64, 0, BLOCK.CHEST), true);
  assert.equal(mgr.useBlock(1, 64, 0, BLOCK.FURNACE_WEST), true);
  assert.deepEqual(opened.map((o) => o[0]), ['chest', 'furnace']);
  assert.equal(opened[0][1], mgr.get(0, 64, 0));
  world.setBlock(0, 65, 0, BLOCK.STONE);
  assert.equal(mgr.useBlock(0, 64, 0, BLOCK.CHEST), true, 'consumed');
  assert.equal(opened.length, 2, 'a solid block on top keeps the lid shut');
  world.setBlock(0, 65, 0, BLOCK.GLASS);
  assert.equal(mgr.useBlock(0, 64, 0, BLOCK.CHEST), true);
  assert.equal(opened.length, 3, 'glass on top does not block');
  assert.equal(mgr.useBlock(5, 64, 5, BLOCK.CRAFTING_TABLE), false);
  // a container block from an old save without entity gets one on first use
  world.blocks.set('9,64,9', BLOCK.CHEST);
  assert.equal(mgr.get(9, 64, 9), null);
  mgr.useBlock(9, 64, 9, BLOCK.CHEST);
  assert.ok(mgr.get(9, 64, 9));
});

test('serialize / deserialize round trip (chest contents, furnace state); idle containers are skipped', () => {
  const { world, mgr } = setup();
  world.setBlock(3, 70, -5, BLOCK.CHEST);
  world.setBlock(-8, 12, 30, BLOCK.FURNACE);
  world.setBlock(7, 70, 7, BLOCK.CHEST); // empty
  const chest = mgr.get(3, 70, -5);
  chest.set(0, makeStack(ITEM.DIAMOND, 7));
  chest.set(13, makeStack(ITEM.DIAMOND_SWORD, 1, 250));
  chest.set(26, makeStack(ITEM.TORCH, 64));
  const f = mgr.get(-8, 12, 30);
  f.set(0, makeStack(ITEM.CHICKEN, 5));
  f.set(1, makeStack(ITEM.OAK_PLANKS, 3));
  ticks(mgr, 123);
  const data = JSON.parse(JSON.stringify(mgr.serialize()));
  assert.equal(data.length, 2, 'the empty chest is not saved');

  const { mgr: mgr2, world: world2 } = setup();
  world2.blocks.set('3,70,-5', BLOCK.CHEST);
  world2.blocks.set('-8,12,30', BLOCK.LIT_FURNACE);
  assert.equal(mgr2.deserialize(data), 2);
  const c2 = mgr2.get(3, 70, -5);
  assert.deepEqual(c2.slots, chest.slots);
  assert.equal(c2.get(13).damage, 250);
  const f2 = mgr2.get(-8, 12, 30);
  assert.deepEqual(f2.slots, f.slots);
  assert.equal(f2.burnTicks, f.burnTicks);
  assert.equal(f2.burnTotalTicks, 300);
  assert.equal(f2.cookTicks, 123 % 200);
  assert.equal(f2.cookTotalTicks, 200);
  // both continue identically
  ticks(mgr, 500);
  ticks(mgr2, 500);
  assert.deepEqual(f2.slots, f.slots);
  assert.equal(f2.burnTicks, f.burnTicks);
  assert.equal(f2.cookTicks, f.cookTicks);
});

test('deserialize skips / repairs invalid data and never throws', () => {
  const { mgr } = setup();
  const n = mgr.deserialize([
    null, 5, 'x', {},
    { type: 'barrel', x: 0, y: 0, z: 0, items: [] },
    { type: 'chest', x: 0.5, y: 0, z: 0, items: [] },
    { type: 'chest', x: 0, y: 300, z: 0, items: [] },
    { type: 'chest', x: 1, y: 2, z: 3, items: [[ITEM.DIRT, 500, 0], [9999, 1, 0], 'junk', [ITEM.STONE, -4, 0], [ITEM.APPLE, 2.7, 0]] },
    { type: 'furnace', x: 4, y: 5, z: 6, items: null, burn: 'a', burnTotal: -5, cook: 1e9, cookTotal: NaN },
  ]);
  assert.equal(n, 2);
  const c = mgr.get(1, 2, 3);
  assert.deepEqual(simple(c.get(0)), [ITEM.DIRT, 64], 'count clamped to the max stack');
  assert.equal(c.get(1), null, 'unknown item id');
  assert.equal(c.get(2), null);
  assert.equal(c.get(3), null, 'negative count');
  assert.deepEqual(simple(c.get(4)), [ITEM.APPLE, 2]);
  const f = mgr.get(4, 5, 6);
  assert.equal(f.burnTicks, 0);
  assert.equal(f.burnTotalTicks, 0);
  assert.equal(f.cookTotalTicks, 200);
  assert.ok(f.cookTicks <= f.cookTotalTicks);
  assert.equal(blockEntityFromJSON({ type: 'chest', x: 'a', y: 1, z: 1 }), null);
  assert.equal(mgr.deserialize('nope'), 0);
});

test('remove() returns the stacks without dropping; clear() forgets everything; detach() unsubscribes', () => {
  const { world, mgr, spawned } = setup();
  world.setBlock(0, 64, 0, BLOCK.CHEST);
  mgr.get(0, 64, 0).set(1, makeStack(ITEM.COAL, 9));
  const stacks = mgr.remove(0, 64, 0);
  assert.deepEqual(stacks.map(simple), [[ITEM.COAL, 9]]);
  assert.equal(spawned.length, 0);
  assert.deepEqual(mgr.remove(0, 64, 0), []);
  world.setBlock(1, 64, 0, BLOCK.FURNACE);
  assert.equal(mgr.count, 1);
  mgr.clear();
  assert.equal(mgr.count, 0);
  assert.equal(world.listenerCount(), 1);
  mgr.detach();
  assert.equal(world.listenerCount(), 0);
  world.setBlock(2, 64, 0, BLOCK.CHEST);
  assert.equal(mgr.get(2, 64, 0), null, 'detached: no more block notifications');
});

test('tick(dt) accumulates whole 20 Hz ticks and caps long stalls', () => {
  const { mgr } = setup();
  mgr.tick(0.1);
  assert.equal(mgr.ticks, 2);
  mgr.tick(0.025);
  assert.equal(mgr.ticks, 2);
  mgr.tick(0.025);
  assert.equal(mgr.ticks, 3);
  for (let i = 0; i < 60; i++) mgr.tick(1 / 60);
  assert.equal(mgr.ticks, 23, '60 frames at 60 fps = 20 ticks');
  mgr.tick(10);
  assert.ok(mgr.ticks <= 23 + 40, 'at most 40 ticks per call');
  mgr.tick(0);
  mgr.tick(-1);
  mgr.tick(NaN);
});

test('display ticks: odds of ClientLevel.animateTick, flames at the front face, crackle sound', () => {
  assert.ok(Math.abs(displayTickChance(0, 0, 0) - 667 * (1 / 4096 + 1 / 32768)) < 1e-12);
  assert.ok(displayTickChance(5, 0, 0) > 0.1 && displayTickChance(5, 0, 0) < 0.13);
  assert.equal(displayTickChance(32, 0, 0), 0);
  assert.ok(displayTickChance(20, 0, 0) > 0, 'the outer pass reaches 31 blocks');

  const { world, mgr, flames, sounds, game } = setup();
  world.setBlock(0, 64, 0, BLOCK.FURNACE); // front faces south (+Z)
  const f = mgr.get(0, 64, 0);
  f.set(0, makeStack(ITEM.COBBLESTONE, 64));
  f.set(1, makeStack(ITEM.COAL_BLOCK, 1));
  ticks(mgr, 2000);
  const expected = 2000 * displayTickChance(0, 0, -3);
  assert.ok(flames.length > expected * 0.7 && flames.length < expected * 1.3, `${flames.length} flames, ~${expected.toFixed(0)} expected`);
  for (const [x, y, z] of flames) {
    assert.ok(Math.abs(z - (0.5 + 0.52)) < 1e-9, 'on the south face');
    assert.ok(x >= 0.2 && x <= 0.8 && y >= 64 && y <= 64 + 6 / 16);
  }
  assert.ok(sounds.length > 0 && sounds.every(([n]) => n === 'fire_crackle'));
  assert.ok(sounds.length < flames.length * 0.25);
  // far away or dead: nothing
  flames.length = 0;
  game.player.x = 100;
  ticks(mgr, 200);
  assert.equal(flames.length, 0);
});


test('chests whose block vanished without a notification drop their items (checked once a second)', () => {
  const { world, mgr, spawned } = setup();
  world.setBlock(5, 64, 5, BLOCK.CHEST);
  mgr.get(5, 64, 5).set(4, makeStack(ITEM.DIAMOND, 3));
  world.blocks.set('5,64,5', BLOCK.AIR);
  world.unloaded.add('0,0');
  ticks(mgr, 40);
  assert.ok(mgr.get(5, 64, 5), 'unloaded chunk: kept');
  world.unloaded.delete('0,0');
  ticks(mgr, 20);
  assert.equal(mgr.get(5, 64, 5), null);
  assert.equal(total(spawned, ITEM.DIAMOND), 3);
  // a healthy chest is left alone
  world.setBlock(6, 64, 5, BLOCK.CHEST_EAST);
  mgr.get(6, 64, 5).set(0, makeStack(ITEM.STICK, 2));
  ticks(mgr, 100);
  assert.ok(mgr.get(6, 64, 5));
});
