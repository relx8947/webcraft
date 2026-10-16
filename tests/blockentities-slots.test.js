// ContainerModel (src/ui/slots.js) with block entity containers: Minecraft's ChestMenu /
// AbstractFurnaceMenu click, shift-click, drag, swap and gather rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContainerModel, slotKey } from '../src/ui/slots.js';
import { FurnaceBlockEntity, ChestBlockEntity } from '../src/game/blockentities.js';
import { Inventory, makeStack } from '../src/game/inventory.js';
import { ITEM } from '../src/world/registry.js';

const inv = (i) => ({ kind: 'inv', index: i });
const box = (i) => ({ kind: 'container', index: i });
const simple = (s) => (s ? [s.id, s.count] : null);

function setup(container) {
  const inventory = new Inventory();
  const dropped = [];
  const m = new ContainerModel({ inventory, container, onDrop: (s) => dropped.push(s) });
  return { m, inventory, dropped };
}

test('slot keys and storage for container slots', () => {
  const { m } = setup(new ChestBlockEntity(0, 0, 0));
  assert.equal(slotKey(box(5)), 'container:5');
  assert.equal(m.isStorage(box(0)), true);
  const noContainer = setup(null).m;
  assert.equal(noContainer.isStorage(box(0)), false);
  assert.equal(noContainer.get(box(0)), null);
});

test('chest: clicks move stacks between the chest and the inventory; version changes', () => {
  const chest = new ChestBlockEntity(0, 0, 0);
  const { m, inventory } = setup(chest);
  inventory.set(0, makeStack(ITEM.COBBLESTONE, 40));
  const v0 = chest.version;
  m.click(inv(0), 0);
  m.click(box(4), 0);
  assert.deepEqual(simple(chest.get(4)), [ITEM.COBBLESTONE, 40]);
  assert.equal(inventory.get(0), null);
  assert.ok(chest.version > v0);
  m.click(box(4), 1); // right: take half
  assert.deepEqual(simple(m.cursor), [ITEM.COBBLESTONE, 20]);
  m.click(box(5), 1); // right: place one
  assert.deepEqual(simple(chest.get(5)), [ITEM.COBBLESTONE, 1]);
  m.click(box(4), 0); // merge back
  assert.deepEqual(simple(chest.get(4)), [ITEM.COBBLESTONE, 39]);
  assert.equal(m.cursor, null);
});

test('chest: shift-click inventory -> chest fills from the first slot, chest -> hotbar from the right', () => {
  const chest = new ChestBlockEntity(0, 0, 0);
  const { m, inventory } = setup(chest);
  inventory.set(20, makeStack(ITEM.DIRT, 64));
  inventory.set(3, makeStack(ITEM.DIAMOND_SWORD, 1, 9));
  m.shiftClick(inv(20));
  assert.deepEqual(simple(chest.get(0)), [ITEM.DIRT, 64]);
  assert.equal(inventory.get(20), null);
  m.shiftClick(inv(3));
  assert.deepEqual(simple(chest.get(1)), [ITEM.DIAMOND_SWORD, 1]);
  assert.equal(chest.get(1).damage, 9);
  m.shiftClick(box(0));
  assert.deepEqual(simple(inventory.get(8)), [ITEM.DIRT, 64], 'hotbar right-to-left first (moveItemStackTo reverse)');
  // merging into existing stacks in the chest first
  chest.set(10, makeStack(ITEM.TORCH, 60));
  inventory.set(9, makeStack(ITEM.TORCH, 10));
  m.shiftClick(inv(9));
  assert.deepEqual(simple(chest.get(10)), [ITEM.TORCH, 64]);
  assert.deepEqual(simple(chest.get(0)), [ITEM.TORCH, 6]);
  assert.equal(inventory.get(9), null);
});

test('chest: shift-click into a full chest does nothing (no hotbar <-> main fallback)', () => {
  const chest = new ChestBlockEntity(0, 0, 0);
  for (let i = 0; i < 27; i++) chest.set(i, makeStack(ITEM.STONE, 64));
  const { m, inventory } = setup(chest);
  inventory.set(30, makeStack(ITEM.DIRT, 5));
  m.shiftClick(inv(30));
  assert.deepEqual(simple(inventory.get(30)), [ITEM.DIRT, 5]);
  for (let i = 0; i < 9; i++) assert.equal(inventory.get(i), null);
});

test('furnace: shift-click routes smeltables to the input, fuels to the fuel slot, others hotbar <-> main', () => {
  const f = new FurnaceBlockEntity(0, 0, 0);
  const { m, inventory } = setup(f);
  inventory.set(10, makeStack(ITEM.IRON_ORE, 12));
  inventory.set(11, makeStack(ITEM.COAL, 7));
  inventory.set(12, makeStack(ITEM.OAK_LOG, 5));
  inventory.set(13, makeStack(ITEM.DIRT, 9));
  inventory.set(2, makeStack(ITEM.LAVA_BUCKET, 1));
  m.shiftClick(inv(10));
  assert.deepEqual(simple(f.get(0)), [ITEM.IRON_ORE, 12]);
  m.shiftClick(inv(11));
  assert.deepEqual(simple(f.get(1)), [ITEM.COAL, 7]);
  m.shiftClick(inv(12));
  assert.deepEqual(simple(inventory.get(12)), [ITEM.OAK_LOG, 5], 'logs are smeltable: input slot is taken -> nothing moves');
  assert.equal(f.get(1).id, ITEM.COAL);
  m.shiftClick(inv(13));
  assert.deepEqual(simple(inventory.get(0)), [ITEM.DIRT, 9], 'neither smeltable nor fuel: main -> hotbar');
  m.shiftClick(inv(0));
  assert.deepEqual(simple(inventory.get(9)), [ITEM.DIRT, 9], 'hotbar -> main');
  m.shiftClick(inv(2));
  assert.deepEqual(simple(inventory.get(2)), [ITEM.LAVA_BUCKET, 1], 'fuel slot taken by coal');
  // input -> inventory: main first; output -> hotbar from the right
  f.set(2, makeStack(ITEM.IRON_INGOT, 5));
  m.shiftClick(box(2));
  assert.deepEqual(simple(inventory.get(8)), [ITEM.IRON_INGOT, 5]);
  assert.equal(f.get(2), null);
  m.shiftClick(box(0));
  assert.deepEqual(simple(inventory.get(10)), [ITEM.IRON_ORE, 12], 'back to the first free main slot');
  assert.equal(f.get(0), null);
});

test('furnace output is take-only; same item on the cursor takes as many as fit', () => {
  const f = new FurnaceBlockEntity(0, 0, 0);
  const { m } = setup(f);
  f.set(2, makeStack(ITEM.GLASS, 10));
  m.cursor = makeStack(ITEM.GLASS, 60);
  m.click(box(2), 0);
  assert.deepEqual(simple(m.cursor), [ITEM.GLASS, 64]);
  assert.deepEqual(simple(f.get(2)), [ITEM.GLASS, 6]);
  m.click(box(2), 1);
  assert.deepEqual(simple(m.cursor), [ITEM.GLASS, 64], 'cursor full');
  m.cursor = makeStack(ITEM.DIRT, 3);
  m.click(box(2), 0);
  assert.deepEqual(simple(m.cursor), [ITEM.DIRT, 3], 'no swap into the output');
  assert.deepEqual(simple(f.get(2)), [ITEM.GLASS, 6]);
  m.cursor = null;
  m.click(box(2), 1);
  assert.deepEqual(simple(m.cursor), [ITEM.GLASS, 3], 'right click takes half');
  f.set(2, null);
  m.click(box(2), 0);
  assert.equal(f.get(2), null, 'cannot place into the empty output');
  assert.deepEqual(simple(m.cursor), [ITEM.GLASS, 3]);
});

test('furnace fuel slot: only fuels (and buckets, max 1); swaps respect the rules', () => {
  const f = new FurnaceBlockEntity(0, 0, 0);
  const { m } = setup(f);
  m.cursor = makeStack(ITEM.DIRT, 10);
  m.click(box(1), 0);
  assert.equal(f.get(1), null, 'dirt is not a fuel');
  m.cursor = makeStack(ITEM.COAL, 10);
  m.click(box(1), 0);
  assert.deepEqual(simple(f.get(1)), [ITEM.COAL, 10]);
  m.cursor = makeStack(ITEM.DIRT, 10);
  m.click(box(1), 0);
  assert.deepEqual(simple(f.get(1)), [ITEM.COAL, 10], 'no swap with a non-fuel');
  m.cursor = makeStack(ITEM.OAK_PLANKS, 5);
  m.click(box(1), 0);
  assert.deepEqual(simple(f.get(1)), [ITEM.OAK_PLANKS, 5], 'swap with another fuel');
  assert.deepEqual(simple(m.cursor), [ITEM.COAL, 10]);
  f.set(1, null);
  m.cursor = makeStack(ITEM.BUCKET, 3);
  m.click(box(1), 0);
  assert.deepEqual(simple(f.get(1)), [ITEM.BUCKET, 1], 'buckets stack to 1 in the fuel slot');
  assert.deepEqual(simple(m.cursor), [ITEM.BUCKET, 2]);
  m.click(box(1), 0);
  assert.deepEqual(simple(f.get(1)), [ITEM.BUCKET, 1]);
  assert.deepEqual(simple(m.cursor), [ITEM.BUCKET, 2]);
});

test('drag splitting skips slots that refuse the item', () => {
  const f = new FurnaceBlockEntity(0, 0, 0);
  const { m } = setup(f);
  m.cursor = makeStack(ITEM.IRON_ORE, 9);
  assert.equal(m.canDragInto(box(0), 0, 0), true);
  assert.equal(m.canDragInto(box(1), 0, 1), false, 'ore is not a fuel');
  assert.equal(m.canDragInto(box(2), 0, 1), false, 'output');
  assert.equal(m.canDragInto(inv(0), 0, 1), true);
  m.drag([box(0), inv(0), inv(1)], 0);
  assert.deepEqual(simple(f.get(0)), [ITEM.IRON_ORE, 3]);
  m.cursor = makeStack(ITEM.COAL, 4);
  m.drag([box(0), box(1)], 1);
  assert.deepEqual(simple(f.get(1)), [ITEM.COAL, 1], 'right drag places one into the fuel slot');
  assert.deepEqual(simple(f.get(0)), [ITEM.IRON_ORE, 3], 'coal does not merge into ore');
  assert.deepEqual(simple(m.cursor), [ITEM.COAL, 3]);
});

test('number keys over container slots (SWAP) and Q (THROW)', () => {
  const f = new FurnaceBlockEntity(0, 0, 0);
  const { m, inventory, dropped } = setup(f);
  f.set(2, makeStack(ITEM.COOKED_BEEF, 4));
  m.swapHotbar(box(2), 0);
  assert.deepEqual(simple(inventory.get(0)), [ITEM.COOKED_BEEF, 4], 'empty hotbar slot takes the output');
  assert.equal(f.get(2), null);
  f.set(2, makeStack(ITEM.COOKED_BEEF, 2));
  m.swapHotbar(box(2), 0);
  assert.deepEqual(simple(f.get(2)), [ITEM.COOKED_BEEF, 2], 'nothing can be placed into the output');
  inventory.set(1, makeStack(ITEM.DIRT, 5));
  m.swapHotbar(box(1), 1);
  assert.equal(f.get(1), null, 'dirt cannot go into the fuel slot');
  inventory.set(2, makeStack(ITEM.COAL, 5));
  m.swapHotbar(box(1), 2);
  assert.deepEqual(simple(f.get(1)), [ITEM.COAL, 5]);
  assert.equal(inventory.get(2), null);
  inventory.set(3, makeStack(ITEM.BUCKET, 4));
  f.set(1, null);
  m.swapHotbar(box(1), 3);
  assert.deepEqual(simple(f.get(1)), [ITEM.BUCKET, 1]);
  assert.deepEqual(simple(inventory.get(3)), [ITEM.BUCKET, 3]);
  m.throwFrom(box(2), false);
  assert.deepEqual(simple(dropped.at(-1)), [ITEM.COOKED_BEEF, 1]);
  m.throwFrom(box(2), true);
  assert.deepEqual(simple(dropped.at(-1)), [ITEM.COOKED_BEEF, 1]);
  assert.equal(f.get(2), null);
});

test('double click gathers from the container first; shift + double click moves every stack', () => {
  const chest = new ChestBlockEntity(0, 0, 0);
  const { m, inventory } = setup(chest);
  chest.set(0, makeStack(ITEM.ARROW, 10));
  chest.set(1, makeStack(ITEM.ARROW, 64));
  inventory.set(9, makeStack(ITEM.ARROW, 20));
  m.cursor = makeStack(ITEM.ARROW, 1);
  m.pickupAll(box(5));
  assert.deepEqual(simple(m.cursor), [ITEM.ARROW, 64]);
  // pass 1 takes the non-full stacks in menu order (container, then inventory): 1 + 10 + 20 = 31,
  // pass 2 tops up from the full stack: 64 - 31 = 33 taken, 31 left
  assert.equal(chest.get(0), null);
  assert.equal(inventory.get(9), null);
  assert.deepEqual(simple(chest.get(1)), [ITEM.ARROW, 31], 'full stacks only in the second pass');
  m.cursor = null;
  // shift + double click on the inventory: every arrow stack of the player's inventory goes in
  inventory.set(0, makeStack(ITEM.ARROW, 5));
  inventory.set(30, makeStack(ITEM.ARROW, 7));
  m.shiftDoubleClick(inv(30), ITEM.ARROW);
  assert.equal(inventory.count(ITEM.ARROW), 0);
  assert.deepEqual(simple(chest.get(1)), [ITEM.ARROW, 43], 'merged into the existing chest stack');
  // and back out
  m.shiftDoubleClick(box(1), ITEM.ARROW);
  assert.equal(inventory.count(ITEM.ARROW), 43);
  assert.equal(chest.get(1), null);
});

test('closing returns the cursor to the inventory; container contents stay', () => {
  const chest = new ChestBlockEntity(0, 0, 0);
  const { m, inventory } = setup(chest);
  chest.set(0, makeStack(ITEM.GOLD_INGOT, 12));
  m.click(box(0), 1);
  m.close();
  assert.deepEqual(simple(inventory.get(0)), [ITEM.GOLD_INGOT, 6]);
  assert.deepEqual(simple(chest.get(0)), [ITEM.GOLD_INGOT, 6]);
  assert.equal(m.cursor, null);
});

test('taking the furnace input restarts its progress (via the container)', () => {
  const f = new FurnaceBlockEntity(0, 0, 0);
  const { m } = setup(f);
  f.set(0, makeStack(ITEM.IRON_ORE, 4));
  f.cookTicks = 150;
  m.click(box(0), 1); // take half: same item stays -> progress kept
  assert.equal(f.cookTicks, 150);
  m.click(box(0), 0); // put back
  m.click(box(0), 0); // take all -> empty -> reset
  assert.equal(f.cookTicks, 0);
});
