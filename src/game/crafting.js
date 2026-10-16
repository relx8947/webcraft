// Crafting recipes + smelting table (pure: no DOM, runs in Node). SPEC §9.8.
//
// Recipes are plain data and compiled once at module load. Ingredient specs:
//   'item_name'            exactly that item
//   '#tag'                 any item of a tag (see TAGS), e.g. '#planks'
//   ['a', 'b', '#tag']     any of the alternatives
// Shaped recipes match the bounding box of the occupied grid cells (so a 2x2 recipe works anywhere in
// a 3x3 grid) and may be mirrored horizontally (Minecraft behaviour). Shapeless recipes match a
// multiset of ingredients in any position. New recipes can be added at runtime with registerShaped /
// registerShapeless.
import { itemByName, getItem } from '../world/registry.js';
import { makeStack } from './inventory.js';

/** Item tags usable as `#name` ingredients. */
export const TAGS = Object.freeze({
  planks: Object.freeze(['oak_planks', 'birch_planks', 'spruce_planks']),
  logs: Object.freeze(['oak_log', 'birch_log', 'spruce_log']),
  coals: Object.freeze(['coal', 'charcoal']),
});

/** Items that leave something behind in the grid when used as an ingredient (e.g. buckets). */
export const CRAFTING_REMAINDERS = Object.freeze({
  water_bucket: 'bucket',
  lava_bucket: 'bucket',
});

function idOf(name) {
  const it = itemByName(name);
  if (!it) throw new Error(`crafting: unknown item '${name}'`);
  return it.id;
}

/** Compile an ingredient spec into { label, ids: Set<number> }. */
function compileIngredient(spec) {
  const ids = new Set();
  const parts = Array.isArray(spec) ? spec : [spec];
  for (const p of parts) {
    if (typeof p === 'number') {
      if (!getItem(p)) throw new Error(`crafting: unknown item id ${p}`);
      ids.add(p);
    } else if (p.startsWith('#')) {
      const tag = TAGS[p.slice(1)];
      if (!tag) throw new Error(`crafting: unknown tag '${p}'`);
      for (const n of tag) ids.add(idOf(n));
    } else {
      ids.add(idOf(p));
    }
  }
  return Object.freeze({ label: parts.join('|'), ids });
}

function compileResult(result, count) {
  const id = typeof result === 'number' ? result : idOf(result);
  if (!getItem(id)) throw new Error(`crafting: unknown result ${result}`);
  return Object.freeze({ id, count: count ?? 1 });
}

/** All compiled recipes in priority order. */
export const RECIPES = [];

/**
 * Register a shaped recipe.
 * @param {object} def
 * @param {string[]} def.pattern  rows of equal length; ' ' = empty cell
 * @param {Object<string, string|string[]>} def.key  pattern char -> ingredient spec
 * @param {string|number} def.result item name or id
 * @param {number} [def.count=1]
 * @param {boolean} [def.mirror=true] also match the horizontally mirrored pattern
 * @param {string} [def.id] unique recipe id (defaults to the result name)
 */
export function registerShaped({ pattern, key, result, count = 1, mirror = true, id }) {
  const height = pattern.length;
  const width = pattern[0].length;
  if (!height || !width || height > 3 || width > 3) throw new Error('crafting: bad pattern size');
  const compiledKey = {};
  for (const [ch, spec] of Object.entries(key)) compiledKey[ch] = compileIngredient(spec);
  const cells = [];
  for (const row of pattern) {
    if (row.length !== width) throw new Error('crafting: ragged pattern');
    for (const ch of row) {
      if (ch === ' ') cells.push(null);
      else if (compiledKey[ch]) cells.push(compiledKey[ch]);
      else throw new Error(`crafting: pattern char '${ch}' has no key`);
    }
  }
  // Mirroring a horizontally symmetric pattern is a no-op; skip the second test in that case.
  let symmetric = true;
  for (let y = 0; y < height && symmetric; y++) {
    for (let x = 0; x < width; x++) {
      if (cells[y * width + x] !== cells[y * width + (width - 1 - x)]) { symmetric = false; break; }
    }
  }
  const r = Object.freeze({
    id: id ?? (typeof result === 'string' ? result : `item_${result}`),
    type: 'shaped', width, height, cells: Object.freeze(cells),
    mirror: mirror && !symmetric,
    ingredientCount: cells.filter(Boolean).length,
    result: compileResult(result, count),
  });
  RECIPES.push(r);
  return r;
}

/**
 * Register a shapeless recipe.
 * @param {object} def
 * @param {Array<string|string[]>} def.ingredients 1..9 ingredient specs
 * @param {string|number} def.result
 * @param {number} [def.count=1]
 * @param {string} [def.id]
 */
export function registerShapeless({ ingredients, result, count = 1, id }) {
  if (!ingredients.length || ingredients.length > 9) throw new Error('crafting: bad ingredient count');
  const r = Object.freeze({
    id: id ?? (typeof result === 'string' ? result : `item_${result}`),
    type: 'shapeless',
    ingredients: Object.freeze(ingredients.map(compileIngredient)),
    ingredientCount: ingredients.length,
    result: compileResult(result, count),
  });
  RECIPES.push(r);
  return r;
}

// ---------------------------------------------------------------------------------------------
// Recipe list (Minecraft Java Edition, restricted to the items that exist in WebCraft)
// ---------------------------------------------------------------------------------------------
for (const wood of ['oak', 'birch', 'spruce']) {
  registerShapeless({ id: `${wood}_planks`, ingredients: [`${wood}_log`], result: `${wood}_planks`, count: 4 });
}
registerShaped({ pattern: ['#', '#'], key: { '#': '#planks' }, result: 'stick', count: 4 });
registerShaped({ pattern: ['##', '##'], key: { '#': '#planks' }, result: 'crafting_table' });
registerShaped({ pattern: ['C', '#'], key: { C: '#coals', '#': 'stick' }, result: 'torch', count: 4 });
registerShaped({ pattern: ['###', '# #', '###'], key: { '#': 'cobblestone' }, result: 'furnace' });

// Tools: 5 materials x sword / shovel / pickaxe / axe (standard shapes, sticks as handles).
const TOOL_MATERIAL_INGREDIENT = {
  wooden: '#planks', stone: 'cobblestone', iron: 'iron_ingot', golden: 'gold_ingot', diamond: 'diamond',
};
const TOOL_PATTERNS = {
  sword: ['X', 'X', '#'],
  shovel: ['X', '#', '#'],
  pickaxe: ['XXX', ' # ', ' # '],
  axe: ['XX', 'X#', ' #'],
};
for (const [mat, ing] of Object.entries(TOOL_MATERIAL_INGREDIENT)) {
  for (const [kind, pattern] of Object.entries(TOOL_PATTERNS)) {
    registerShaped({ pattern, key: { X: ing, '#': 'stick' }, result: `${mat}_${kind}` });
  }
}

// Hoes (wave 2): two material cells on top, the handle below the inner one (mirrorable, like Minecraft).
for (const [mat, ing] of Object.entries(TOOL_MATERIAL_INGREDIENT)) {
  registerShaped({ pattern: ['XX', ' #', ' #'], key: { X: ing, '#': 'stick' }, result: `${mat}_hoe` });
}

// Wave 2 (docs/SPEC-wave2.md §6): chest, bow, arrows, bread.
registerShaped({ pattern: ['###', '# #', '###'], key: { '#': '#planks' }, result: 'chest' });
registerShaped({ pattern: [' #X', '# X', ' #X'], key: { '#': 'stick', X: 'string' }, result: 'bow' });
registerShaped({ pattern: ['X', '#', 'Y'], key: { X: 'flint', '#': 'stick', Y: 'feather' }, result: 'arrow', count: 4 });
registerShaped({ pattern: ['###'], key: { '#': 'wheat' }, result: 'bread' });

registerShaped({ pattern: ['##', '##'], key: { '#': 'sand' }, result: 'sandstone' });
registerShaped({ pattern: ['##', '##'], key: { '#': 'stone' }, result: 'stone_bricks', count: 4 });
registerShaped({ pattern: ['##', '##'], key: { '#': 'string' }, result: 'white_wool' });
registerShaped({ pattern: ['X#X', '#X#', 'X#X'], key: { X: 'gunpowder', '#': 'sand' }, result: 'tnt' });
registerShaped({ pattern: ['P', 'T'], key: { P: 'pumpkin', T: 'torch' }, result: 'jack_o_lantern' });
registerShaped({ pattern: ['X X', ' X '], key: { X: 'iron_ingot' }, result: 'bucket' });
registerShapeless({ ingredients: ['iron_ingot', 'flint'], result: 'flint_and_steel' });
registerShapeless({ ingredients: ['diorite', 'cobblestone'], result: 'andesite', count: 2 });

// Storage blocks (3x3 -> block) and back (block -> 9).
for (const [material, block] of [
  ['iron_ingot', 'iron_block'], ['gold_ingot', 'gold_block'], ['diamond', 'diamond_block'],
  ['coal', 'coal_block'], ['lapis_lazuli', 'lapis_block'],
]) {
  registerShaped({ pattern: ['###', '###', '###'], key: { '#': material }, result: block });
  registerShapeless({ id: `${material}_from_${block}`, ingredients: [block], result: material, count: 9 });
}

// ---------------------------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------------------------
function occupied(s) {
  return !!s && s.count > 0;
}

function matchShaped(r, grid, width, minX, minY, mirrored) {
  for (let y = 0; y < r.height; y++) {
    for (let x = 0; x < r.width; x++) {
      const ing = r.cells[y * r.width + (mirrored ? r.width - 1 - x : x)];
      const s = grid[(minY + y) * width + minX + x];
      if (!ing) {
        if (occupied(s)) return false;
      } else if (!occupied(s) || !ing.ids.has(s.id)) {
        return false;
      }
    }
  }
  return true;
}

/** Perfect matching of stacks to ingredients (tiny backtracking; at most 9 x 9). */
function matchShapeless(r, stacks) {
  const used = new Array(r.ingredients.length).fill(false);
  const assign = (i) => {
    if (i === stacks.length) return true;
    for (let j = 0; j < r.ingredients.length; j++) {
      if (!used[j] && r.ingredients[j].ids.has(stacks[i].id)) {
        used[j] = true;
        if (assign(i + 1)) return true;
        used[j] = false;
      }
    }
    return false;
  };
  return assign(0);
}

/**
 * Find the recipe matching a crafting grid.
 * @param {(object|null)[]} grid  row-major width*width stacks ({id, count, damage}) or null
 * @param {number} width          2 (inventory) or 3 (crafting table)
 * @returns {{ result: {id, count, damage}, recipe: object } | null}  result is a fresh stack
 */
export function matchRecipe(grid, width) {
  let minX = width, minY = width, maxX = -1, maxY = -1;
  const stacks = [];
  for (let i = 0; i < width * width; i++) {
    const s = grid[i];
    if (!occupied(s)) continue;
    const x = i % width;
    const y = (i / width) | 0;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    stacks.push(s);
  }
  if (!stacks.length) return null;
  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;
  for (const r of RECIPES) {
    if (r.ingredientCount !== stacks.length) continue;
    let ok;
    if (r.type === 'shaped') {
      if (r.width !== bw || r.height !== bh) continue;
      ok = matchShaped(r, grid, width, minX, minY, false) || (r.mirror && matchShaped(r, grid, width, minX, minY, true));
    } else {
      ok = matchShapeless(r, stacks);
    }
    if (ok) return { result: makeStack(r.result.id, r.result.count), recipe: r };
  }
  return null;
}

/**
 * Remove one item from every occupied cell (called when the crafted result is taken). Cells that run
 * out become null; container ingredients (water bucket ...) leave their remainder item behind.
 * @param {(object|null)[]} grid  mutated in place
 * @param {number} width
 * @param {object} [recipe]  the matched recipe (kept for API symmetry / future per-recipe rules)
 */
export function consumeIngredients(grid, width, recipe) {
  for (let i = 0; i < width * width; i++) {
    const s = grid[i];
    if (!occupied(s)) {
      grid[i] = null;
      continue;
    }
    const remainder = CRAFTING_REMAINDERS[getItem(s.id)?.name];
    if (s.count > 1) {
      grid[i] = { id: s.id, count: s.count - 1, damage: s.damage ?? 0 };
    } else {
      grid[i] = remainder ? makeStack(idOf(remainder), 1) : null;
    }
  }
}

/** All recipes producing `itemIdValue` (for recipe hints / tests). */
export function findRecipesFor(itemIdValue) {
  return RECIPES.filter((r) => r.result.id === itemIdValue);
}

// ---------------------------------------------------------------------------------------------
// Smelting (the furnace in src/game/blockentities.js). time = seconds per item (Minecraft: 200 ticks).
// Entries are frozen: clone `output` before putting it into an inventory.
// ---------------------------------------------------------------------------------------------
/** @type {Map<number, { output: {id, count, damage}, time: number }>} */
export const SMELTING = new Map();

/** Register a smelting recipe (input item name/id -> output item name/id). */
export function registerSmelting(input, output, count = 1, time = 10) {
  const inId = typeof input === 'number' ? input : idOf(input);
  const outId = typeof output === 'number' ? output : idOf(output);
  SMELTING.set(inId, Object.freeze({ output: Object.freeze(makeStack(outId, count)), time }));
}

for (const [input, output] of [
  ['iron_ore', 'iron_ingot'], ['gold_ore', 'gold_ingot'], ['coal_ore', 'coal'],
  ['diamond_ore', 'diamond'], ['redstone_ore', 'redstone'], ['lapis_ore', 'lapis_lazuli'],
  ['sand', 'glass'], ['cobblestone', 'stone'], ['stone_bricks', 'cracked_stone_bricks'],
  ['oak_log', 'charcoal'], ['birch_log', 'charcoal'], ['spruce_log', 'charcoal'],
  ['porkchop', 'cooked_porkchop'], ['beef', 'cooked_beef'],
  ['mutton', 'cooked_mutton'], ['chicken', 'cooked_chicken'],
  // Minecraft smelts clay balls into bricks; WebCraft has no clay ball / brick items, so the clay block
  // becomes a bricks block (SPEC-wave2 §6 simplification). Cactus has no result (no dyes in WebCraft).
  ['clay', 'bricks'],
]) {
  registerSmelting(input, output);
}

/** Smelting result for an input item id (fresh stack) or null. */
export function getSmeltingResult(itemIdValue) {
  const r = SMELTING.get(itemIdValue);
  return r ? { output: makeStack(r.output.id, r.output.count), time: r.time } : null;
}
