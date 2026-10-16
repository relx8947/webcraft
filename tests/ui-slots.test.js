import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContainerModel, slotKey } from '../src/ui/slots.js';
import { Inventory, makeStack } from '../src/game/inventory.js';
import { ITEM } from '../src/world/registry.js';

const inv = (i) => ({ kind: 'inv', index: i });
const grid = (i) => ({ kind: 'grid', index: i });
const RESULT = { kind: 'result' };

function setup(opts = {}) {
  const inventory = new Inventory();
  const dropped = [];
  const m = new ContainerModel({ inventory, onDrop: (s) => dropped.push(s), ...opts });
  return { m, inventory, dropped };
}

function simple(s) {
  return s ? [s.id, s.count] : null;
}

test('left click picks up and places whole stacks, right click splits / places one', () => {
  const { m, inventory } = setup();
  inventory.set(9, makeStack(ITEM.DIRT, 33));
  m.click(inv(9), 1); // right: take half (ceil)
  assert.deepEqual(simple(m.cursor), [ITEM.DIRT, 17]);
  assert.deepEqual(simple(inventory.get(9)), [ITEM.DIRT, 16]);
  m.click(inv(10), 1); // right on empty: place one
  assert.deepEqual(simple(inventory.get(10)), [ITEM.DIRT, 1]);
  assert.equal(m.cursor.count, 16);
  m.click(inv(9), 0); // left on same item: merge everything
  assert.deepEqual(simple(inventory.get(9)), [ITEM.DIRT, 32]);
  assert.equal(m.cursor, null);
  m.click(inv(9), 0); // pick up all
  assert.deepEqual(simple(m.cursor), [ITEM.DIRT, 32]);
  assert.equal(inventory.get(9), null);
  m.click(inv(11), 0);
  assert.deepEqual(simple(inventory.get(11)), [ITEM.DIRT, 32]);
  assert.equal(m.cursor, null);
});

test('merging respects the max stack size and different items swap', () => {
  const { m, inventory } = setup();
  inventory.set(0, makeStack(ITEM.STONE, 60));
  inventory.set(1, makeStack(ITEM.STONE, 10));
  inventory.set(2, makeStack(ITEM.DIAMOND_PICKAXE, 1, 100));
  m.click(inv(1), 0);
  m.click(inv(0), 0);
  assert.equal(inventory.get(0).count, 64);
  assert.deepEqual(simple(m.cursor), [ITEM.STONE, 6]);
  m.click(inv(2), 0); // swap with the pickaxe
  assert.deepEqual(simple(inventory.get(2)), [ITEM.STONE, 6]);
  assert.equal(m.cursor.id, ITEM.DIAMOND_PICKAXE);
  assert.equal(m.cursor.damage, 100, 'damage travels with the stack');
  // two damaged tools never merge: they swap
  inventory.set(3, makeStack(ITEM.DIAMOND_PICKAXE, 1, 5));
  m.click(inv(3), 0);
  assert.equal(inventory.get(3).damage, 100);
  assert.equal(m.cursor.damage, 5);
});

test('crafting result: click takes one craft, shift-click crafts all into the hotbar from the right', () => {
  const { m, inventory } = setup({ gridWidth: 2 });
  m.set(grid(0), makeStack(ITEM.OAK_LOG, 3));
  assert.deepEqual(simple(m.result), [ITEM.OAK_PLANKS, 4]);
  m.click(RESULT, 0);
  assert.deepEqual(simple(m.cursor), [ITEM.OAK_PLANKS, 4]);
  assert.equal(m.grid[0].count, 2);
  m.click(RESULT, 0); // same item on cursor: stacks onto it
  assert.equal(m.cursor.count, 8);
  m.click(inv(20), 0);
  m.shiftClick(RESULT);
  assert.equal(m.grid[0], null);
  assert.equal(m.result, null);
  assert.deepEqual(simple(inventory.get(20)), [ITEM.OAK_PLANKS, 12], 'merged into the existing stack first');
  assert.equal(inventory.get(8), null);
});

test('shift-click craft-all fills the rightmost hotbar slot first', () => {
  const { m, inventory } = setup({ gridWidth: 3 });
  for (let i = 0; i < 9; i++) m.set(grid(i), makeStack(ITEM.IRON_INGOT, 2));
  assert.equal(m.result.id, ITEM.IRON_BLOCK);
  m.shiftClick(RESULT);
  assert.deepEqual(simple(inventory.get(8)), [ITEM.IRON_BLOCK, 2]);
  assert.ok(m.grid.every((s) => s === null));
});

test('result cannot be taken onto a different cursor item', () => {
  const { m } = setup({ gridWidth: 2 });
  m.set(grid(0), makeStack(ITEM.OAK_LOG, 1));
  m.cursor = makeStack(ITEM.DIRT, 1);
  m.click(RESULT, 0);
  assert.equal(m.cursor.id, ITEM.DIRT);
  assert.equal(m.grid[0].count, 1);
});

test('shift-click moves between hotbar and main inventory; grid goes to main first', () => {
  const { m, inventory } = setup({ gridWidth: 2 });
  inventory.set(0, makeStack(ITEM.COBBLESTONE, 10));
  m.shiftClick(inv(0));
  assert.equal(inventory.get(0), null);
  assert.deepEqual(simple(inventory.get(9)), [ITEM.COBBLESTONE, 10]);
  m.shiftClick(inv(9));
  assert.deepEqual(simple(inventory.get(0)), [ITEM.COBBLESTONE, 10]);
  m.set(grid(3), makeStack(ITEM.SAND, 5));
  m.shiftClick(grid(3));
  assert.equal(m.grid[3], null);
  assert.deepEqual(simple(inventory.get(9)), [ITEM.SAND, 5]);
});

test('shift-click leaves what does not fit', () => {
  const { m, inventory } = setup();
  for (let i = 0; i < 9; i++) inventory.set(i, makeStack(ITEM.STONE, 64));
  inventory.set(9, makeStack(ITEM.DIRT, 5));
  m.shiftClick(inv(9));
  assert.deepEqual(simple(inventory.get(9)), [ITEM.DIRT, 5]);
});

test('drag splitting: left distributes evenly, right places one per slot', () => {
  const { m, inventory } = setup();
  m.cursor = makeStack(ITEM.DIRT, 10);
  const refs = [inv(9), inv(10), inv(11)];
  assert.ok(m.canDragInto(inv(9), 0, 0));
  const plan = m.planDrag(refs, 0);
  assert.equal(plan.remaining, 1);
  m.drag(refs, 0);
  assert.deepEqual(refs.map((r) => inventory.get(r.index).count), [3, 3, 3]);
  assert.equal(m.cursor.count, 1);
  m.cursor = makeStack(ITEM.DIRT, 2);
  m.drag([inv(12), inv(9)], 1);
  assert.equal(inventory.get(12).count, 1);
  assert.equal(inventory.get(9).count, 4);
  assert.equal(m.cursor, null);
  // cannot drag into a slot holding another item or more slots than items
  m.cursor = makeStack(ITEM.STONE, 2);
  assert.equal(m.canDragInto(inv(9), 0, 0), false);
  assert.equal(m.canDragInto(inv(20), 0, 2), false);
  assert.equal(m.canDragInto(RESULT, 0, 0), false);
});

test('drag split caps at the max stack size and returns the rest', () => {
  const { m, inventory } = setup();
  inventory.set(9, makeStack(ITEM.DIRT, 60));
  m.cursor = makeStack(ITEM.DIRT, 20);
  m.drag([inv(9), inv(10)], 0);
  assert.equal(inventory.get(9).count, 64);
  assert.equal(inventory.get(10).count, 10);
  assert.equal(m.cursor.count, 6);
});

test('double click gathers matching stacks (non-full first)', () => {
  const { m, inventory } = setup();
  inventory.set(9, makeStack(ITEM.DIRT, 64));
  inventory.set(10, makeStack(ITEM.DIRT, 5));
  inventory.set(11, makeStack(ITEM.DIRT, 7));
  inventory.set(12, makeStack(ITEM.STONE, 7));
  m.cursor = makeStack(ITEM.DIRT, 1);
  m.pickupAll(inv(13));
  assert.equal(m.cursor.count, 64);
  assert.equal(inventory.get(10), null);
  assert.equal(inventory.get(11), null);
  assert.equal(inventory.get(9).count, 13);
  assert.equal(inventory.get(12).count, 7);
});

test('number keys swap with the hotbar, Q throws', () => {
  const { m, inventory, dropped } = setup({ gridWidth: 2 });
  inventory.set(15, makeStack(ITEM.TORCH, 12));
  inventory.set(2, makeStack(ITEM.STICK, 3));
  m.swapHotbar(inv(15), 2);
  assert.deepEqual(simple(inventory.get(2)), [ITEM.TORCH, 12]);
  assert.deepEqual(simple(inventory.get(15)), [ITEM.STICK, 3]);
  m.throwFrom(inv(2));
  assert.deepEqual(simple(dropped[0]), [ITEM.TORCH, 1]);
  assert.equal(inventory.get(2).count, 11);
  m.throwFrom(inv(2), true);
  assert.deepEqual(simple(dropped[1]), [ITEM.TORCH, 11]);
  assert.equal(inventory.get(2), null);
  // result to hotbar via number key crafts once
  m.set(grid(0), makeStack(ITEM.BIRCH_LOG, 2));
  m.swapHotbar(RESULT, 4);
  assert.deepEqual(simple(inventory.get(4)), [ITEM.BIRCH_PLANKS, 4]);
  assert.equal(m.grid[0].count, 1);
});

test('clicking outside drops the cursor; closing returns grid and cursor items', () => {
  const { m, inventory, dropped } = setup({ gridWidth: 3 });
  m.cursor = makeStack(ITEM.APPLE, 3);
  m.clickOutside(1);
  assert.deepEqual(simple(dropped[0]), [ITEM.APPLE, 1]);
  assert.equal(m.cursor.count, 2);
  m.set(grid(4), makeStack(ITEM.DIAMOND, 2));
  m.close();
  assert.equal(inventory.count(ITEM.DIAMOND), 2);
  assert.equal(inventory.count(ITEM.APPLE), 2);
  assert.equal(m.cursor, null);
  assert.ok(m.grid.every((s) => s === null));
});

test('closing with a full inventory drops the overflow', () => {
  const { m, inventory, dropped } = setup({ gridWidth: 2 });
  for (let i = 0; i < 36; i++) inventory.set(i, makeStack(ITEM.STONE, 64));
  m.set(grid(0), makeStack(ITEM.DIRT, 4));
  m.cursor = makeStack(ITEM.SAND, 9);
  m.close();
  assert.deepEqual(dropped.map(simple).sort(), [[ITEM.DIRT, 4], [ITEM.SAND, 9]].sort());
});

test('creative source slots: full stacks, deletes, middle click and hotbar shortcuts', () => {
  const { m, inventory, dropped } = setup({ creative: true, getSelectedSlot: () => 3 });
  const src = { kind: 'creative', itemId: ITEM.GLASS };
  m.click(src, 0);
  assert.deepEqual(simple(m.cursor), [ITEM.GLASS, 64], 'left click takes a full stack');
  m.click(src, 1);
  assert.equal(m.cursor.count, 63, 'right click with the same item removes one');
  m.click({ kind: 'creative', itemId: ITEM.DIRT }, 0);
  assert.equal(m.cursor, null, 'clicking another creative item with a stack deletes it');
  m.click(src, 1);
  assert.deepEqual(simple(m.cursor), [ITEM.GLASS, 1], 'right click takes one');
  m.cursor = null;
  m.shiftClick(src);
  assert.deepEqual(simple(inventory.get(0)), [ITEM.GLASS, 64], 'shift-click sends a stack to the hotbar');
  for (let i = 1; i < 9; i++) inventory.set(i, makeStack(ITEM.DIRT, 1));
  m.shiftClick({ kind: 'creative', itemId: ITEM.TORCH });
  assert.deepEqual(simple(inventory.get(3)), [ITEM.TORCH, 64], 'full hotbar replaces the selected slot');
  m.middleClick(inv(3));
  assert.deepEqual(simple(m.cursor), [ITEM.TORCH, 64]);
  m.click({ kind: 'destroy' }, 0);
  assert.equal(m.cursor, null);
  m.swapHotbar({ kind: 'creative', itemId: ITEM.BRICKS }, 5);
  assert.deepEqual(simple(inventory.get(5)), [ITEM.BRICKS, 64]);
  m.throwFrom({ kind: 'creative', itemId: ITEM.BRICKS }, true);
  assert.deepEqual(simple(dropped[0]), [ITEM.BRICKS, 64]);
  m.creativeItemTab = true;
  m.shiftClick(inv(5));
  assert.equal(inventory.get(5), null, 'shift-click on the hotbar in an item tab deletes');
  m.creativeItemTab = false;
  m.shiftClick({ kind: 'destroy' });
  assert.ok(inventory.isEmpty(), 'shift-click on the destroy slot clears the inventory');
});

test('middle click does nothing in survival', () => {
  const { m, inventory } = setup();
  inventory.set(0, makeStack(ITEM.DIRT, 5));
  m.middleClick(inv(0));
  assert.equal(m.cursor, null);
});

test('shift + double click moves every stack of that item in the section', () => {
  const { m, inventory } = setup();
  inventory.set(9, makeStack(ITEM.DIRT, 10));
  inventory.set(20, makeStack(ITEM.DIRT, 10));
  inventory.set(21, makeStack(ITEM.STONE, 10));
  m.shiftDoubleClick(inv(9), ITEM.DIRT);
  assert.equal(inventory.get(9), null);
  assert.equal(inventory.get(20), null);
  assert.deepEqual(simple(inventory.get(0)), [ITEM.DIRT, 20]);
  assert.equal(inventory.get(21).count, 10);
});

test('slotKey', () => {
  assert.equal(slotKey(inv(3)), 'inv:3');
  assert.equal(slotKey(RESULT), 'result');
  assert.equal(slotKey({ kind: 'creative', itemId: 5 }), 'creative:5');
});

test('dropAll throws the grid and cursor into the world', () => {
  const { m, inventory, dropped } = setup({ gridWidth: 2 });
  m.set(grid(1), makeStack(ITEM.COAL, 3));
  m.cursor = makeStack(ITEM.STICK, 2);
  m.dropAll();
  assert.equal(inventory.count(ITEM.COAL), 0);
  assert.deepEqual(dropped.map(simple), [[ITEM.COAL, 3], [ITEM.STICK, 2]]);
  assert.equal(m.cursor, null);
  assert.ok(m.grid.every((s) => s === null));
});
