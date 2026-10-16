// Non-block item definitions (pure data). Item ids < 256 are block items (id == block id);
// non-block items start at 256. IDs are persisted: append only. Import through ./registry.js.

export const ITEM_DEFS = [];

const BASE = Object.freeze({
  maxStack: 64,
  texture: null,       // item texture name (in the shared texture array); defaults to item name
  tool: null,          // { type: 'pickaxe'|'axe'|'shovel'|'sword', tier, speed, durability, damage }
  food: null,          // { hunger, saturation }
  fuel: 0,             // furnace burn time in seconds
  durability: 0,       // for non-tool damageable items (flint_and_steel, bow)
  spawnMob: null,      // spawn eggs: mob type key (docs/SPEC-wave2.md §3)
  creativeTab: 'materials',
});

function item(id, name, displayName, props = {}) {
  if (ITEM_DEFS[id]) throw new Error(`duplicate item id ${id}`);
  if (id < 256) throw new Error('non-block item ids start at 256');
  ITEM_DEFS[id] = { ...BASE, texture: name, ...props, id, name, displayName };
}

item(256, 'stick', '木棍', { fuel: 5 });
item(257, 'coal', '煤炭', { fuel: 80 });
item(258, 'charcoal', '木炭', { fuel: 80 });
item(259, 'iron_ingot', '铁锭');
item(260, 'gold_ingot', '金锭');
item(261, 'diamond', '钻石');
item(262, 'redstone', '红石粉');
item(263, 'lapis_lazuli', '青金石');
item(264, 'flint', '燧石');
item(265, 'flint_and_steel', '打火石', { maxStack: 1, durability: 64, creativeTab: 'tools' });
item(266, 'apple', '苹果', { food: { hunger: 4, saturation: 2.4 }, creativeTab: 'food' });
item(267, 'porkchop', '生猪排', { food: { hunger: 3, saturation: 1.8 }, creativeTab: 'food' });
item(268, 'cooked_porkchop', '熟猪排', { food: { hunger: 8, saturation: 12.8 }, creativeTab: 'food' });
item(269, 'beef', '生牛肉', { food: { hunger: 3, saturation: 1.8 }, creativeTab: 'food' });
item(270, 'cooked_beef', '牛排', { food: { hunger: 8, saturation: 12.8 }, creativeTab: 'food' });
item(271, 'rotten_flesh', '腐肉', { food: { hunger: 4, saturation: 0.8 }, creativeTab: 'food' });
item(272, 'bread', '面包', { food: { hunger: 5, saturation: 6 }, creativeTab: 'food' });
item(273, 'gunpowder', '火药');
item(274, 'leather', '皮革');
item(275, 'feather', '羽毛');
item(276, 'string', '线');
item(277, 'bone', '骨头');

// Tools: ids 280..299 = 5 materials x [sword, shovel, pickaxe, axe]
export const TOOL_MATERIALS = Object.freeze([
  // name,      zh,  tier, speed, durability, damage bonus
  ['wooden', '木', 0, 2, 59, 0],
  ['stone', '石', 1, 4, 131, 1],
  ['iron', '铁', 2, 6, 250, 2],
  ['golden', '金', 0, 12, 32, 0],
  ['diamond', '钻石', 3, 8, 1561, 3],
]);
const TOOL_KINDS = [
  // type,     zh,  base damage
  ['sword', '剑', 4],
  ['shovel', '锹', 1],
  ['pickaxe', '镐', 2],
  ['axe', '斧', 3],
];
TOOL_MATERIALS.forEach(([mat, matZh, tier, speed, durability, bonus], mi) => {
  TOOL_KINDS.forEach(([type, typeZh, baseDamage], ki) => {
    item(280 + mi * 4 + ki, `${mat}_${type}`, `${matZh}${typeZh}`, {
      maxStack: 1,
      creativeTab: 'tools',
      fuel: mat === 'wooden' ? 10 : 0,
      tool: { type, tier, speed, durability, damage: baseDamage + bonus },
    });
  });
});

item(300, 'bucket', '桶', { maxStack: 16, creativeTab: 'tools' });
item(301, 'water_bucket', '水桶', { maxStack: 1, creativeTab: 'tools' });
item(302, 'lava_bucket', '熔岩桶', { maxStack: 1, creativeTab: 'tools', fuel: 1000 });

// ---- wave 2 (docs/SPEC-wave2.md) ------------------------------------------------------------
item(303, 'mutton', '生羊肉', { food: { hunger: 2, saturation: 1.2 }, creativeTab: 'food' });
item(304, 'cooked_mutton', '熟羊肉', { food: { hunger: 6, saturation: 9.6 }, creativeTab: 'food' });
item(305, 'chicken', '生鸡肉', { food: { hunger: 2, saturation: 1.2 }, creativeTab: 'food' });
item(306, 'cooked_chicken', '熟鸡肉', { food: { hunger: 6, saturation: 7.2 }, creativeTab: 'food' });
item(307, 'arrow', '箭', { creativeTab: 'tools' });
item(308, 'bow', '弓', { maxStack: 1, durability: 384, fuel: 15, creativeTab: 'tools' });
item(309, 'spider_eye', '蜘蛛眼', { food: { hunger: 2, saturation: 3.2 }, creativeTab: 'food' });
item(310, 'wheat_seeds', '小麦种子', { creativeTab: 'materials' });
item(311, 'wheat', '小麦', { creativeTab: 'materials' });
// Hoes: ids 312..316 in TOOL_MATERIALS order (wooden, stone, iron, golden, diamond)
TOOL_MATERIALS.forEach(([mat, matZh, tier, speed, durability], mi) => {
  item(312 + mi, `${mat}_hoe`, `${matZh}锄`, {
    maxStack: 1, creativeTab: 'tools', fuel: mat === 'wooden' ? 10 : 0,
    tool: { type: 'hoe', tier, speed, durability, damage: 1 },
  });
});
export const SPAWN_EGG_MOBS = Object.freeze([
  ['pig', '猪'], ['cow', '牛'], ['sheep', '羊'], ['chicken', '鸡'],
  ['zombie', '僵尸'], ['skeleton', '骷髅'], ['creeper', '苦力怕'], ['spider', '蜘蛛'],
]);
SPAWN_EGG_MOBS.forEach(([mob, zh], i) => {
  item(317 + i, `${mob}_spawn_egg`, `${zh}刷怪蛋`, { creativeTab: 'spawn', spawnMob: mob });
}); // ids 317..324

// Item-sprite textures that are not items themselves (bow pulling animation frames).
export const EXTRA_ITEM_TEXTURES = Object.freeze(['bow_pulling_0', 'bow_pulling_1', 'bow_pulling_2']);

// Fuel values for block items (seconds). Merged by registry.js.
export const BLOCK_FUEL = Object.freeze({
  oak_planks: 15, birch_planks: 15, spruce_planks: 15,
  oak_log: 15, birch_log: 15, spruce_log: 15,
  oak_sapling: 5, birch_sapling: 5, spruce_sapling: 5,
  crafting_table: 15, bookshelf: 15, coal_block: 800, chest: 15,
});

export const CREATIVE_TABS = Object.freeze([
  { id: 'building', name: '建筑方块' },
  { id: 'decoration', name: '装饰性方块' },
  { id: 'nature', name: '自然方块' },
  { id: 'tools', name: '工具' },
  { id: 'food', name: '食物' },
  { id: 'materials', name: '原材料' },
  { id: 'spawn', name: '刷怪蛋' },
]);
