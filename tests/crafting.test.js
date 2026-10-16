import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  matchRecipe, consumeIngredients, RECIPES, SMELTING, TAGS, registerShaped, findRecipesFor, getSmeltingResult,
} from '../src/game/crafting.js';
import { ITEM, itemId, getItem } from '../src/world/registry.js';
import { makeStack } from '../src/game/inventory.js';

/** Build a grid from rows of item names ('.' = empty). */
function grid(rows, width = rows.length) {
  const g = new Array(width * width).fill(null);
  rows.forEach((row, y) => {
    row.split(/\s+/).forEach((name, x) => {
      if (name !== '.') g[y * width + x] = makeStack(itemId(name), 1);
    });
  });
  return g;
}

function craft(rows, width) {
  const m = matchRecipe(grid(rows, width), width);
  return m ? [getItem(m.result.id).name, m.result.count] : null;
}

test('every recipe compiles and produces a real item', () => {
  assert.ok(RECIPES.length >= 45);
  for (const r of RECIPES) {
    assert.ok(getItem(r.result.id), r.id);
    assert.ok(r.result.count >= 1);
  }
  assert.equal(TAGS.planks.length, 3);
});

test('logs -> 4 planks of the same wood, in any grid cell', () => {
  for (const wood of ['oak', 'birch', 'spruce']) {
    assert.deepEqual(craft([`${wood}_log .`, '. .'], 2), [`${wood}_planks`, 4]);
    assert.deepEqual(craft(['. .', `. ${wood}_log`], 2), [`${wood}_planks`, 4]);
    assert.deepEqual(craft(['. . .', '. . .', `. . ${wood}_log`], 3), [`${wood}_planks`, 4]);
  }
  assert.equal(craft(['oak_log oak_log', '. .'], 2), null, 'two logs are not a recipe');
});

test('sticks and crafting table accept any (mixed) planks', () => {
  assert.deepEqual(craft(['oak_planks .', 'birch_planks .'], 2), ['stick', 4]);
  assert.deepEqual(craft(['. spruce_planks', '. spruce_planks'], 2), ['stick', 4]);
  assert.deepEqual(craft(['. . .', '. . birch_planks', '. . oak_planks'], 3), ['stick', 4]);
  assert.deepEqual(craft(['oak_planks birch_planks', 'spruce_planks oak_planks'], 2), ['crafting_table', 1]);
  assert.equal(craft(['oak_planks oak_planks', '. .'], 2), null, 'horizontal planks are not sticks');
});

test('torches from coal or charcoal', () => {
  assert.deepEqual(craft(['coal .', 'stick .'], 2), ['torch', 4]);
  assert.deepEqual(craft(['. charcoal', '. stick'], 2), ['torch', 4]);
  assert.equal(craft(['stick .', 'coal .'], 2), null, 'upside-down torch');
});

test('all 20 tools with standard shapes', () => {
  const mats = { wooden: 'oak_planks', stone: 'cobblestone', iron: 'iron_ingot', golden: 'gold_ingot', diamond: 'diamond' };
  for (const [mat, m] of Object.entries(mats)) {
    assert.deepEqual(craft([`${m} . .`, `${m} . .`, 'stick . .'], 3), [`${mat}_sword`, 1], `${mat} sword`);
    assert.deepEqual(craft([`. ${m} .`, '. stick .', '. stick .'], 3), [`${mat}_shovel`, 1], `${mat} shovel`);
    assert.deepEqual(craft([`${m} ${m} ${m}`, '. stick .', '. stick .'], 3), [`${mat}_pickaxe`, 1], `${mat} pickaxe`);
    assert.deepEqual(craft([`${m} ${m} .`, `${m} stick .`, '. stick .'], 3), [`${mat}_axe`, 1], `${mat} axe`);
    // mirrored axe
    assert.deepEqual(craft([`. ${m} ${m}`, `. stick ${m}`, '. stick .'], 3), [`${mat}_axe`, 1], `${mat} axe mirrored`);
  }
  // wooden tools with mixed planks (tag per cell)
  assert.deepEqual(craft(['oak_planks birch_planks spruce_planks', '. stick .', '. stick .'], 3), ['wooden_pickaxe', 1]);
  // a 2x2 sword fits a 2x2 grid only partially: 3-high patterns can never match in the inventory grid
  assert.equal(craft(['iron_ingot .', 'stick .'], 2), null);
});

test('2x2 vs 3x3: big recipes need the crafting table, small ones work anywhere', () => {
  assert.equal(craft(['cobblestone cobblestone', 'cobblestone cobblestone'], 2), null);
  assert.deepEqual(craft(['cobblestone cobblestone cobblestone', 'cobblestone . cobblestone', 'cobblestone cobblestone cobblestone'], 3), ['furnace', 1]);
  assert.equal(craft(['cobblestone cobblestone cobblestone', 'cobblestone cobblestone cobblestone', 'cobblestone cobblestone cobblestone'], 3), null, 'filled ring');
  // 2x2 recipes in every position of the 3x3 grid
  for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
    const g = new Array(9).fill(null);
    for (const [x, y] of [[0, 0], [1, 0], [0, 1], [1, 1]]) g[(y + dy) * 3 + x + dx] = makeStack(ITEM.SAND, 1);
    assert.equal(matchRecipe(g, 3).result.id, ITEM.SANDSTONE);
  }
  assert.deepEqual(craft(['stone stone', 'stone stone'], 2), ['stone_bricks', 4]);
  assert.deepEqual(craft(['string string', 'string string'], 2), ['white_wool', 1]);
});

test('other Minecraft recipes', () => {
  assert.deepEqual(craft(['gunpowder sand gunpowder', 'sand gunpowder sand', 'gunpowder sand gunpowder'], 3), ['tnt', 1]);
  assert.deepEqual(craft(['pumpkin .', 'torch .'], 2), ['jack_o_lantern', 1]);
  assert.deepEqual(craft(['iron_ingot . iron_ingot', '. iron_ingot .', '. . .'], 3), ['bucket', 1]);
  assert.deepEqual(craft(['. . .', 'iron_ingot . iron_ingot', '. iron_ingot .'], 3), ['bucket', 1]);
  assert.deepEqual(craft(['flint iron_ingot', '. .'], 2), ['flint_and_steel', 1]);
  assert.deepEqual(craft(['. iron_ingot', 'flint .'], 2), ['flint_and_steel', 1], 'shapeless in any order');
  assert.deepEqual(craft(['diorite cobblestone', '. .'], 2), ['andesite', 2]);
});

test('storage blocks both ways', () => {
  for (const [mat, block] of [['iron_ingot', 'iron_block'], ['gold_ingot', 'gold_block'], ['diamond', 'diamond_block'], ['coal', 'coal_block'], ['lapis_lazuli', 'lapis_block']]) {
    assert.deepEqual(craft([`${mat} ${mat} ${mat}`, `${mat} ${mat} ${mat}`, `${mat} ${mat} ${mat}`], 3), [block, 1]);
    assert.deepEqual(craft([`${block} .`, '. .'], 2), [mat, 9]);
  }
  assert.equal(craft(['iron_ingot iron_ingot iron_ingot', 'iron_ingot gold_ingot iron_ingot', 'iron_ingot iron_ingot iron_ingot'], 3), null);
});

test('extra items in the grid prevent a match', () => {
  assert.equal(craft(['oak_planks dirt', 'oak_planks .'], 2), null);
  assert.equal(craft(['coal stick', 'stick .'], 2), null);
});

test('consumeIngredients removes one item per occupied cell', () => {
  const g = grid(['oak_planks .', 'oak_planks .'], 2);
  g[0].count = 3;
  const m = matchRecipe(g, 2);
  assert.equal(m.result.id, ITEM.STICK);
  consumeIngredients(g, 2, m.recipe);
  assert.equal(g[0].count, 2);
  assert.equal(g[2], null);
  assert.equal(g[1], null);
  assert.equal(matchRecipe(g, 2), null, 'one plank left is not a recipe');
});

test('matchRecipe returns fresh result stacks', () => {
  const g = grid(['oak_log .', '. .'], 2);
  const a = matchRecipe(g, 2).result;
  a.count = 99;
  assert.equal(matchRecipe(g, 2).result.count, 4);
});

test('registerShaped validates and extends the recipe list', () => {
  assert.throws(() => registerShaped({ pattern: ['#'], key: { '#': 'no_such_item' }, result: 'stone' }));
  assert.throws(() => registerShaped({ pattern: ['#X'], key: { '#': 'stone' }, result: 'stone' }));
  assert.equal(findRecipesFor(ITEM.TORCH).length, 1);
});

test('smelting table', () => {
  assert.equal(SMELTING.get(ITEM.IRON_ORE).output.id, ITEM.IRON_INGOT);
  assert.equal(SMELTING.get(ITEM.SAND).output.id, ITEM.GLASS);
  assert.equal(SMELTING.get(ITEM.COBBLESTONE).output.id, ITEM.STONE);
  assert.equal(SMELTING.get(ITEM.OAK_LOG).output.id, ITEM.CHARCOAL);
  assert.equal(SMELTING.get(ITEM.BEEF).output.id, ITEM.COOKED_BEEF);
  assert.equal(SMELTING.get(ITEM.IRON_ORE).time, 10);
  assert.ok(Object.isFrozen(SMELTING.get(ITEM.SAND).output));
  const r = getSmeltingResult(ITEM.GOLD_ORE);
  r.output.count = 5;
  assert.equal(getSmeltingResult(ITEM.GOLD_ORE).output.count, 1);
  assert.equal(getSmeltingResult(ITEM.DIRT), null);
});

// ---------------------------------------------------------------------------------------------
// Wave 2 recipes (docs/SPEC-wave2.md §6)
// ---------------------------------------------------------------------------------------------

test('chest: a ring of 8 planks (any, mixed) in the crafting table', () => {
  assert.deepEqual(craft(['oak_planks oak_planks oak_planks', 'oak_planks . oak_planks', 'oak_planks oak_planks oak_planks'], 3), ['chest', 1]);
  assert.deepEqual(craft(['birch_planks oak_planks spruce_planks', 'spruce_planks . birch_planks', 'oak_planks oak_planks birch_planks'], 3), ['chest', 1]);
  assert.equal(craft(['oak_planks oak_planks oak_planks', 'oak_planks oak_planks oak_planks', 'oak_planks oak_planks oak_planks'], 3), null, 'filled ring is not a chest');
  assert.equal(craft(['oak_log oak_log oak_log', 'oak_log . oak_log', 'oak_log oak_log oak_log'], 3), null, 'logs do not make a chest');
  // the cobblestone ring is still the furnace
  assert.deepEqual(craft(['cobblestone cobblestone cobblestone', 'cobblestone . cobblestone', 'cobblestone cobblestone cobblestone'], 3), ['furnace', 1]);
});

test('bow: 3 sticks + 3 string, both orientations', () => {
  assert.deepEqual(craft(['. stick string', 'stick . string', '. stick string'], 3), ['bow', 1]);
  assert.deepEqual(craft(['string stick .', 'string . stick', 'string stick .'], 3), ['bow', 1], 'mirrored');
  assert.equal(craft(['. stick string', 'stick . string', '. stick .'], 3), null, 'missing string');
  assert.equal(getItem(findRecipesFor(ITEM.BOW)[0].result.id).durability, 384);
});

test('arrows: flint over stick over feather -> 4 (any column)', () => {
  assert.deepEqual(craft(['flint . .', 'stick . .', 'feather . .'], 3), ['arrow', 4]);
  assert.deepEqual(craft(['. . flint', '. . stick', '. . feather'], 3), ['arrow', 4]);
  assert.equal(craft(['feather . .', 'stick . .', 'flint . .'], 3), null, 'upside down');
  assert.equal(craft(['flint .', 'stick .'], 2), null, 'needs the feather (and a 3-high grid)');
});

test('all 5 hoes with the standard shape (and mirrored)', () => {
  const mats = { wooden: 'oak_planks', stone: 'cobblestone', iron: 'iron_ingot', golden: 'gold_ingot', diamond: 'diamond' };
  for (const [mat, m] of Object.entries(mats)) {
    assert.deepEqual(craft([`${m} ${m} .`, '. stick .', '. stick .'], 3), [`${mat}_hoe`, 1], `${mat} hoe`);
    assert.deepEqual(craft([`. ${m} ${m}`, '. stick .', '. stick .'], 3), [`${mat}_hoe`, 1], `${mat} hoe mirrored`);
    assert.deepEqual(craft([`${m} ${m}`, '. stick'], 2), null, `${mat}: two rows are not a hoe`);
    const it = getItem(itemId(`${mat}_hoe`));
    assert.equal(it.tool.type, 'hoe');
  }
  // the axe (one more material cell) is unaffected
  assert.deepEqual(craft(['iron_ingot iron_ingot .', 'iron_ingot stick .', '. stick .'], 3), ['iron_axe', 1]);
  // mixed planks for the wooden hoe
  assert.deepEqual(craft(['birch_planks spruce_planks .', '. stick .', '. stick .'], 3), ['wooden_hoe', 1]);
});

test('bread: three wheat in a row (crafting table only)', () => {
  assert.deepEqual(craft(['wheat wheat wheat', '. . .', '. . .'], 3), ['bread', 1]);
  assert.deepEqual(craft(['. . .', '. . .', 'wheat wheat wheat'], 3), ['bread', 1]);
  assert.equal(craft(['wheat wheat', '. .'], 2), null, 'two wheat are not bread');
  assert.equal(craft(['wheat . .', 'wheat . .', 'wheat . .'], 3), null, 'a column is not bread');
  assert.equal(craft(['wheat_seeds wheat_seeds wheat_seeds', '. . .', '. . .'], 3), null);
});

test('every wave-2 item with a recipe can be crafted and nothing else changed', () => {
  for (const name of ['chest', 'bow', 'arrow', 'bread', 'wooden_hoe', 'stone_hoe', 'iron_hoe', 'golden_hoe', 'diamond_hoe']) {
    assert.ok(findRecipesFor(itemId(name)).length >= 1, name);
  }
  // no recipe produces spawn eggs, seeds or raw meat
  for (const name of ['pig_spawn_egg', 'wheat_seeds', 'mutton', 'chicken', 'spider_eye']) {
    assert.equal(findRecipesFor(itemId(name)).length, 0, name);
  }
});

test('smelting: wave-2 meats, clay -> bricks, every Minecraft basic, outputs exist', () => {
  const expect = {
    iron_ore: 'iron_ingot', gold_ore: 'gold_ingot', coal_ore: 'coal', diamond_ore: 'diamond', redstone_ore: 'redstone',
    lapis_ore: 'lapis_lazuli', sand: 'glass', cobblestone: 'stone', stone_bricks: 'cracked_stone_bricks',
    oak_log: 'charcoal', birch_log: 'charcoal', spruce_log: 'charcoal',
    porkchop: 'cooked_porkchop', beef: 'cooked_beef', mutton: 'cooked_mutton', chicken: 'cooked_chicken', clay: 'bricks',
  };
  for (const [input, output] of Object.entries(expect)) {
    const r = SMELTING.get(itemId(input));
    assert.ok(r, `${input} smelts`);
    assert.equal(r.output.id, itemId(output), input);
    assert.equal(r.output.count, 1);
    assert.equal(r.time, 10, '200 ticks');
  }
  for (const [id, r] of SMELTING) {
    assert.ok(getItem(id), `input ${id}`);
    assert.ok(getItem(r.output.id), `output of ${id}`);
  }
  assert.equal(SMELTING.get(ITEM.CACTUS), undefined, 'cactus smelts to nothing (no dyes)');
  assert.equal(SMELTING.get(ITEM.COOKED_BEEF), undefined, 'cooked food does not smelt again');
});
