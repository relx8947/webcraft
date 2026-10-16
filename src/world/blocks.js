// Block definitions (pure data, no DOM). IDs are persisted in saved worlds:
// NEVER renumber — only append new ids. Always import blocks through ./registry.js,
// which resolves textures to layers and builds the fast lookup tables.
//
// Texture spec forms (`tex`):
//   'name'                                   all six faces
//   { top, bottom, side }                    side = all four horizontal faces
//   { top, bottom, side, front, facing }     front texture on one horizontal face (facing: 'south'|'north'|'east'|'west')
//   { end, side, axis }                      log-like; axis 'y' | 'x' | 'z' gets the end texture
//   { px, nx, py, ny, pz, nz }               explicit per face (+X east, -X west, +Y top, -Y bottom, +Z south, -Z north)

export const BLOCK_DEFS = [];

const BASE = Object.freeze({
  renderType: 'cube',      // 'none' | 'cube' | 'cross' | 'torch' | 'liquid' | 'cactus' | 'chest' | 'crop' | 'farmland'
  layer: 'opaque',         // 'opaque' | 'cutout' | 'translucent'
  solid: true,             // collides with entities
  opaque: true,            // full opaque cube: hides neighbour faces, blocks light, casts AO
  cullSame: false,         // faces between two blocks of the same id are hidden (glass, water, ice)
  lightEmission: 0,        // 0..15
  lightFilter: 0,          // extra light attenuation for non-opaque blocks (leaves/water/ice = 1)
  hardness: 1,             // Minecraft hardness; -1 = unbreakable, 0 = instant
  tool: null,              // 'pickaxe' | 'axe' | 'shovel' | null — tool that speeds up breaking
  toolTier: 0,             // minimum tier for drops when requiresTool (0 wood/gold, 1 stone, 2 iron, 3 diamond)
  requiresTool: false,     // true: breaking without the right tool type+tier drops nothing
  drops: undefined,        // undefined = drops itself; [] = nothing; [{ item, min, max, chance, alt }]
  sound: 'stone',          // 'stone'|'wood'|'gravel'|'grass'|'sand'|'glass'|'wool'|'snow'|'metal'|'water'
  replaceable: false,      // placing a block into this cell replaces it (air, liquids, short grass)
  tint: null,              // null | 'grass' | 'foliage' | 'birch' | 'spruce'
  gravity: false,          // falls when unsupported (sand, gravel)
  needsSupport: null,      // null | 'solid' | 'wall' | [block names] — supporting block required (below, or behind
                           // for 'wall'), else it pops off. Always check with registry canStay().
  wallFacing: null,        // wall torches: 'north'|'south'|'east'|'west' = direction it points away from the wall
  selectionBox: null,      // [x0,y0,z0,x1,y1,z1] in block units; null = full cube
  collisionBox: null,      // same format; null = full cube when solid
  slipperiness: 0.6,       // ground friction factor (ice 0.98)
  liquid: false,
  damage: 0,               // contact damage per hit (cactus 1, lava 4)
  interact: null,          // null | 'crafting' | 'furnace' | 'chest' | 'tnt'  (right-click behaviour)
  placement: null,         // null | { type: 'axis'|'facing', ...variant names }
  item: null,              // BASE BLOCK name of a hidden variant (drops/picks that block's item; null = itself)
  pickItem: null,          // non-block item given by pick block (crops -> seeds); overrides `item`
  creativeTab: 'building', // 'building' | 'decoration' | 'nature' (blocks); items use 'tools'|'food'|'materials'
  hidden: false,           // not obtainable as an item (variants, air, snowy grass)
});

function block(id, name, displayName, tex, props = {}) {
  if (BLOCK_DEFS[id]) throw new Error(`duplicate block id ${id}`);
  if (id !== BLOCK_DEFS.length) throw new Error(`block ids must be dense: expected ${BLOCK_DEFS.length}, got ${id} (${name})`);
  BLOCK_DEFS[id] = { ...BASE, ...props, id, name, displayName, tex };
}

/** Hidden orientation variant of an existing block (shares all properties, drops/picks the base). */
function variant(id, name, baseName, tex, extra = {}) {
  const base = BLOCK_DEFS.find((b) => b && b.name === baseName);
  if (!base) throw new Error(`variant base ${baseName} not found`);
  const { id: _i, name: _n, tex: _t, placement: _p, ...rest } = base;
  block(id, name, base.displayName, tex, { ...rest, placement: null, hidden: true, item: baseName, ...extra });
}

// ---- presets ---------------------------------------------------------------
const STONE_LIKE = { hardness: 1.5, tool: 'pickaxe', requiresTool: true, sound: 'stone' };
const ORE = (tier, extra = {}) => ({ hardness: 3, tool: 'pickaxe', requiresTool: true, toolTier: tier, sound: 'stone', creativeTab: 'nature', ...extra });
const WOOD = { hardness: 2, tool: 'axe', sound: 'wood' };
const LOG = { hardness: 2, tool: 'axe', sound: 'wood', creativeTab: 'nature' };
const LEAVES = {
  layer: 'cutout', opaque: false, lightFilter: 1, hardness: 0.2, sound: 'grass', creativeTab: 'nature',
};
const CROSS = {
  renderType: 'cross', layer: 'cutout', solid: false, opaque: false, hardness: 0, sound: 'grass',
  creativeTab: 'decoration', needsSupport: ['grass_block', 'dirt', 'snowy_grass_block'],
  selectionBox: [0.3125, 0, 0.3125, 0.6875, 0.625, 0.6875],
};
const PLANT = { ...CROSS, replaceable: true, drops: [], creativeTab: 'nature', selectionBox: [0.125, 0, 0.125, 0.875, 0.8125, 0.875] };
const SAPLING = { ...CROSS, creativeTab: 'nature', selectionBox: [0.1, 0, 0.1, 0.9, 0.8, 0.9] };
const WOOL = { hardness: 0.8, sound: 'wool', creativeTab: 'building' };
const METAL = (tier) => ({ hardness: 5, tool: 'pickaxe', requiresTool: true, toolTier: tier, sound: 'metal' });

// ---- definitions -----------------------------------------------------------
block(0, 'air', '空气', null, {
  renderType: 'none', solid: false, opaque: false, hardness: 0, replaceable: true, hidden: true, drops: [],
});
block(1, 'stone', '石头', 'stone', { ...STONE_LIKE, drops: [{ item: 'cobblestone' }] });
block(2, 'grass_block', '草方块', { top: 'grass_block_top', bottom: 'dirt', side: 'grass_block_side' }, {
  hardness: 0.6, tool: 'shovel', sound: 'grass', tint: 'grass', drops: [{ item: 'dirt' }], creativeTab: 'nature',
});
block(3, 'dirt', '泥土', 'dirt', { hardness: 0.5, tool: 'shovel', sound: 'gravel', creativeTab: 'nature' });
block(4, 'cobblestone', '圆石', 'cobblestone', { ...STONE_LIKE, hardness: 2 });
block(5, 'oak_planks', '橡木木板', 'oak_planks', { ...WOOD });
block(6, 'bedrock', '基岩', 'bedrock', { hardness: -1, sound: 'stone' });
block(7, 'sand', '沙子', 'sand', { hardness: 0.5, tool: 'shovel', sound: 'sand', gravity: true, creativeTab: 'nature' });
block(8, 'gravel', '沙砾', 'gravel', {
  hardness: 0.6, tool: 'shovel', sound: 'gravel', gravity: true, creativeTab: 'nature',
  drops: [{ item: 'flint', chance: 0.1, alt: 'gravel' }],
});
block(9, 'oak_log', '橡木原木', { end: 'oak_log_top', side: 'oak_log', axis: 'y' }, {
  ...LOG, placement: { type: 'axis', x: 'oak_log_x', y: 'oak_log', z: 'oak_log_z' },
});
variant(10, 'oak_log_x', 'oak_log', { end: 'oak_log_top', side: 'oak_log', axis: 'x' });
variant(11, 'oak_log_z', 'oak_log', { end: 'oak_log_top', side: 'oak_log', axis: 'z' });
block(12, 'oak_leaves', '橡树树叶', 'oak_leaves', {
  ...LEAVES, tint: 'foliage', drops: [{ item: 'oak_sapling', chance: 0.05 }, { item: 'apple', chance: 0.005 }],
});
block(13, 'glass', '玻璃', 'glass', {
  layer: 'cutout', opaque: false, cullSame: true, hardness: 0.3, sound: 'glass', drops: [],
});
block(14, 'water', '水', 'water_still', {
  renderType: 'liquid', layer: 'translucent', solid: false, opaque: false, cullSame: true, lightFilter: 1,
  hardness: -1, replaceable: true, liquid: true, sound: 'water', drops: [], creativeTab: 'nature',
});
block(15, 'lava', '熔岩', 'lava_still', {
  renderType: 'liquid', layer: 'opaque', solid: false, opaque: false, cullSame: true, lightEmission: 15,
  hardness: -1, replaceable: true, liquid: true, damage: 4, sound: 'water', drops: [], creativeTab: 'nature',
});
block(16, 'coal_ore', '煤矿石', 'coal_ore', ORE(0, { drops: [{ item: 'coal' }] }));
block(17, 'iron_ore', '铁矿石', 'iron_ore', ORE(1));
block(18, 'gold_ore', '金矿石', 'gold_ore', ORE(2));
block(19, 'diamond_ore', '钻石矿石', 'diamond_ore', ORE(2, { drops: [{ item: 'diamond' }] }));
block(20, 'redstone_ore', '红石矿石', 'redstone_ore', ORE(2, { drops: [{ item: 'redstone', min: 4, max: 5 }] }));
block(21, 'lapis_ore', '青金石矿石', 'lapis_ore', ORE(1, { drops: [{ item: 'lapis_lazuli', min: 4, max: 8 }] }));
block(22, 'snowy_grass_block', '积雪草方块', { top: 'snow', bottom: 'dirt', side: 'grass_block_snow' }, {
  hardness: 0.6, tool: 'shovel', sound: 'snow', drops: [{ item: 'dirt' }], hidden: true, item: 'grass_block',
});
block(23, 'snow_block', '雪块', 'snow', { hardness: 0.2, tool: 'shovel', sound: 'snow', creativeTab: 'nature' });
block(24, 'ice', '冰', 'ice', {
  layer: 'translucent', opaque: false, cullSame: true, lightFilter: 1, hardness: 0.5, tool: 'pickaxe',
  sound: 'glass', drops: [], slipperiness: 0.98, creativeTab: 'nature',
});
block(25, 'cactus', '仙人掌', { top: 'cactus_top', bottom: 'cactus_bottom', side: 'cactus_side' }, {
  renderType: 'cactus', layer: 'cutout', opaque: false, hardness: 0.4, sound: 'wool', damage: 1,
  needsSupport: ['sand', 'cactus'], creativeTab: 'nature',
  collisionBox: [0.0625, 0, 0.0625, 0.9375, 0.9375, 0.9375],
  selectionBox: [0.0625, 0, 0.0625, 0.9375, 1, 0.9375],
});
block(26, 'birch_log', '白桦原木', { end: 'birch_log_top', side: 'birch_log', axis: 'y' }, {
  ...LOG, placement: { type: 'axis', x: 'birch_log_x', y: 'birch_log', z: 'birch_log_z' },
});
variant(27, 'birch_log_x', 'birch_log', { end: 'birch_log_top', side: 'birch_log', axis: 'x' });
variant(28, 'birch_log_z', 'birch_log', { end: 'birch_log_top', side: 'birch_log', axis: 'z' });
block(29, 'birch_leaves', '白桦树叶', 'birch_leaves', {
  ...LEAVES, tint: 'birch', drops: [{ item: 'birch_sapling', chance: 0.05 }],
});
block(30, 'spruce_log', '云杉原木', { end: 'spruce_log_top', side: 'spruce_log', axis: 'y' }, {
  ...LOG, placement: { type: 'axis', x: 'spruce_log_x', y: 'spruce_log', z: 'spruce_log_z' },
});
variant(31, 'spruce_log_x', 'spruce_log', { end: 'spruce_log_top', side: 'spruce_log', axis: 'x' });
variant(32, 'spruce_log_z', 'spruce_log', { end: 'spruce_log_top', side: 'spruce_log', axis: 'z' });
block(33, 'spruce_leaves', '云杉树叶', 'spruce_leaves', {
  ...LEAVES, tint: 'spruce', drops: [{ item: 'spruce_sapling', chance: 0.05 }],
});
block(34, 'birch_planks', '白桦木板', 'birch_planks', { ...WOOD });
block(35, 'spruce_planks', '云杉木板', 'spruce_planks', { ...WOOD });
block(36, 'short_grass', '草丛', 'short_grass', { ...PLANT, tint: 'grass', drops: [{ item: 'wheat_seeds', chance: 0.125 }] });
block(37, 'fern', '蕨', 'fern', { ...PLANT, tint: 'grass', drops: [{ item: 'wheat_seeds', chance: 0.125 }] });
block(38, 'dandelion', '蒲公英', 'dandelion', { ...CROSS });
block(39, 'poppy', '虞美人', 'poppy', { ...CROSS });
block(40, 'cornflower', '矢车菊', 'cornflower', { ...CROSS });
block(41, 'oxeye_daisy', '滨菊', 'oxeye_daisy', { ...CROSS });
block(42, 'dead_bush', '枯萎的灌木', 'dead_bush', {
  ...PLANT, needsSupport: ['sand', 'dirt', 'grass_block'], drops: [{ item: 'stick', min: 0, max: 2 }],
});
block(43, 'sugar_cane', '甘蔗', 'sugar_cane', {
  ...CROSS, tint: 'grass', creativeTab: 'nature', needsSupport: ['grass_block', 'snowy_grass_block', 'dirt', 'sand', 'sugar_cane'],
  selectionBox: [0.125, 0, 0.125, 0.875, 1, 0.875],
});
block(44, 'brown_mushroom', '棕色蘑菇', 'brown_mushroom', {
  ...CROSS, lightEmission: 1, needsSupport: 'solid', creativeTab: 'nature',
  selectionBox: [0.3125, 0, 0.3125, 0.6875, 0.375, 0.6875],
});
block(45, 'red_mushroom', '红色蘑菇', 'red_mushroom', {
  ...CROSS, needsSupport: 'solid', creativeTab: 'nature',
  selectionBox: [0.3125, 0, 0.3125, 0.6875, 0.375, 0.6875],
});
block(46, 'torch', '火把', 'torch', {
  renderType: 'torch', layer: 'cutout', solid: false, opaque: false, lightEmission: 14, hardness: 0,
  sound: 'wood', needsSupport: 'solid', creativeTab: 'decoration',
  selectionBox: [0.375, 0, 0.375, 0.625, 0.625, 0.625],
  placement: { type: 'torch', floor: 'torch', north: 'wall_torch_north', south: 'wall_torch_south', east: 'wall_torch_east', west: 'wall_torch_west' },
});
// Minecraft's crafting table model: front texture on north + west, side texture on south + east.
block(47, 'crafting_table', '工作台', {
  px: 'crafting_table_side', nx: 'crafting_table_front', py: 'crafting_table_top', ny: 'oak_planks',
  pz: 'crafting_table_side', nz: 'crafting_table_front',
}, { ...WOOD, hardness: 2.5, interact: 'crafting', creativeTab: 'decoration' });
block(48, 'furnace', '熔炉', { top: 'furnace_top', bottom: 'furnace_top', side: 'furnace_side', front: 'furnace_front', facing: 'south' }, {
  ...STONE_LIKE, hardness: 3.5, interact: 'furnace', creativeTab: 'decoration',
  placement: { type: 'facing', south: 'furnace', north: 'furnace_north', east: 'furnace_east', west: 'furnace_west' },
});
variant(49, 'furnace_north', 'furnace', { top: 'furnace_top', bottom: 'furnace_top', side: 'furnace_side', front: 'furnace_front', facing: 'north' });
variant(50, 'furnace_east', 'furnace', { top: 'furnace_top', bottom: 'furnace_top', side: 'furnace_side', front: 'furnace_front', facing: 'east' });
variant(51, 'furnace_west', 'furnace', { top: 'furnace_top', bottom: 'furnace_top', side: 'furnace_side', front: 'furnace_front', facing: 'west' });
block(52, 'bricks', '砖块', 'bricks', { ...STONE_LIKE, hardness: 2 });
block(53, 'stone_bricks', '石砖', 'stone_bricks', { ...STONE_LIKE });
block(54, 'mossy_cobblestone', '苔石', 'mossy_cobblestone', { ...STONE_LIKE, hardness: 2 });
block(55, 'bookshelf', '书架', { top: 'oak_planks', bottom: 'oak_planks', side: 'bookshelf' }, {
  ...WOOD, hardness: 1.5, creativeTab: 'decoration',
});
block(56, 'tnt', 'TNT', { top: 'tnt_top', bottom: 'tnt_bottom', side: 'tnt_side' }, {
  hardness: 0, sound: 'grass', interact: 'tnt', creativeTab: 'decoration',
});
block(57, 'glowstone', '荧石', 'glowstone', { hardness: 0.3, sound: 'glass', lightEmission: 15, creativeTab: 'decoration' });
block(58, 'obsidian', '黑曜石', 'obsidian', { hardness: 50, tool: 'pickaxe', requiresTool: true, toolTier: 3, sound: 'stone' });
block(59, 'sandstone', '砂岩', { top: 'sandstone_top', bottom: 'sandstone_bottom', side: 'sandstone' }, {
  hardness: 0.8, tool: 'pickaxe', requiresTool: true, sound: 'stone',
});
block(60, 'clay', '黏土块', 'clay', { hardness: 0.6, tool: 'shovel', sound: 'gravel', creativeTab: 'nature' });
block(61, 'pumpkin', '南瓜', { top: 'pumpkin_top', bottom: 'pumpkin_top', side: 'pumpkin_side' }, {
  hardness: 1, tool: 'axe', sound: 'wood', creativeTab: 'nature',
});
block(62, 'jack_o_lantern', '南瓜灯', { top: 'pumpkin_top', bottom: 'pumpkin_top', side: 'pumpkin_side', front: 'jack_o_lantern', facing: 'south' }, {
  hardness: 1, tool: 'axe', sound: 'wood', lightEmission: 15, creativeTab: 'decoration',
  placement: { type: 'facing', south: 'jack_o_lantern', north: 'jack_o_lantern_north', east: 'jack_o_lantern_east', west: 'jack_o_lantern_west' },
});
variant(63, 'jack_o_lantern_north', 'jack_o_lantern', { top: 'pumpkin_top', bottom: 'pumpkin_top', side: 'pumpkin_side', front: 'jack_o_lantern', facing: 'north' });
variant(64, 'jack_o_lantern_east', 'jack_o_lantern', { top: 'pumpkin_top', bottom: 'pumpkin_top', side: 'pumpkin_side', front: 'jack_o_lantern', facing: 'east' });
variant(65, 'jack_o_lantern_west', 'jack_o_lantern', { top: 'pumpkin_top', bottom: 'pumpkin_top', side: 'pumpkin_side', front: 'jack_o_lantern', facing: 'west' });

export const WOOL_COLORS = Object.freeze([
  ['white', '白色'], ['orange', '橙色'], ['magenta', '品红色'], ['light_blue', '淡蓝色'],
  ['yellow', '黄色'], ['lime', '黄绿色'], ['pink', '粉红色'], ['gray', '灰色'],
  ['light_gray', '淡灰色'], ['cyan', '青色'], ['purple', '紫色'], ['blue', '蓝色'],
  ['brown', '棕色'], ['green', '绿色'], ['red', '红色'], ['black', '黑色'],
]);
WOOL_COLORS.forEach(([color, zh], i) => {
  block(66 + i, `${color}_wool`, `${zh}羊毛`, `${color}_wool`, { ...WOOL });
}); // ids 66..81

block(82, 'iron_block', '铁块', 'iron_block', METAL(1));
block(83, 'gold_block', '金块', 'gold_block', { ...METAL(2), hardness: 3 });
block(84, 'diamond_block', '钻石块', 'diamond_block', METAL(2));
block(85, 'coal_block', '煤炭块', 'coal_block', METAL(0));
block(86, 'lapis_block', '青金石块', 'lapis_block', { ...METAL(1), hardness: 3 });
block(87, 'oak_sapling', '橡树树苗', 'oak_sapling', { ...SAPLING });
block(88, 'birch_sapling', '白桦树苗', 'birch_sapling', { ...SAPLING });
block(89, 'spruce_sapling', '云杉树苗', 'spruce_sapling', { ...SAPLING });
block(90, 'granite', '花岗岩', 'granite', { ...STONE_LIKE });
block(91, 'diorite', '闪长岩', 'diorite', { ...STONE_LIKE });
block(92, 'andesite', '安山岩', 'andesite', { ...STONE_LIKE });
block(93, 'mossy_stone_bricks', '苔石砖', 'mossy_stone_bricks', { ...STONE_LIKE });
block(94, 'cracked_stone_bricks', '裂纹石砖', 'cracked_stone_bricks', { ...STONE_LIKE });

// ---- wave 2 (docs/SPEC-wave2.md) ------------------------------------------------------------
const CHEST_TEX = (facing) => ({ top: 'chest_top', bottom: 'chest_top', side: 'chest_side', front: 'chest_front', facing });
block(95, 'chest', '箱子', CHEST_TEX('south'), {
  renderType: 'chest', opaque: false, hardness: 2.5, tool: 'axe', sound: 'wood', interact: 'chest',
  creativeTab: 'decoration',
  collisionBox: [0.0625, 0, 0.0625, 0.9375, 0.875, 0.9375],
  selectionBox: [0.0625, 0, 0.0625, 0.9375, 0.875, 0.9375],
  placement: { type: 'facing', south: 'chest', north: 'chest_north', east: 'chest_east', west: 'chest_west' },
});
variant(96, 'chest_north', 'chest', CHEST_TEX('north'));
variant(97, 'chest_east', 'chest', CHEST_TEX('east'));
variant(98, 'chest_west', 'chest', CHEST_TEX('west'));

const LIT_FURNACE_TEX = (facing) => ({ top: 'furnace_top', bottom: 'furnace_top', side: 'furnace_side', front: 'furnace_front_on', facing });
variant(99, 'lit_furnace', 'furnace', LIT_FURNACE_TEX('south'), { lightEmission: 13 });
variant(100, 'lit_furnace_north', 'furnace', LIT_FURNACE_TEX('north'), { lightEmission: 13 });
variant(101, 'lit_furnace_east', 'furnace', LIT_FURNACE_TEX('east'), { lightEmission: 13 });
variant(102, 'lit_furnace_west', 'furnace', LIT_FURNACE_TEX('west'), { lightEmission: 13 });

// Flowing / falling liquids (level 1..7 flowing, 8 falling). Same look and physics as the sources.
for (let level = 1; level <= 7; level++) variant(102 + level, `water_flowing_${level}`, 'water', 'water_still', { item: null });
variant(110, 'water_falling', 'water', 'water_still', { item: null });
for (let level = 1; level <= 7; level++) variant(110 + level, `lava_flowing_${level}`, 'lava', 'lava_still', { item: null });
variant(118, 'lava_falling', 'lava', 'lava_still', { item: null });

const FARMLAND = {
  renderType: 'farmland', opaque: false, hardness: 0.6, tool: 'shovel', sound: 'gravel',
  drops: [{ item: 'dirt' }], hidden: true, item: 'dirt', creativeTab: 'nature',
  collisionBox: [0, 0, 0, 1, 0.9375, 1], selectionBox: [0, 0, 0, 1, 0.9375, 1],
};
block(119, 'farmland', '耕地', { top: 'farmland', bottom: 'dirt', side: 'dirt' }, { ...FARMLAND });
block(120, 'farmland_moist', '耕地', { top: 'farmland_moist', bottom: 'dirt', side: 'dirt' }, { ...FARMLAND });

for (let age = 0; age <= 7; age++) {
  block(121 + age, `wheat_${age}`, '小麦', `wheat_stage_${age}`, {
    renderType: 'crop', layer: 'cutout', solid: false, opaque: false, hardness: 0, sound: 'grass',
    needsSupport: ['farmland', 'farmland_moist'], hidden: true, pickItem: 'wheat_seeds', creativeTab: 'nature',
    selectionBox: [0, 0, 0, 1, (age + 1) * 2 / 16, 1],
    drops: age === 7
      ? [{ item: 'wheat' }, { item: 'wheat_seeds', min: 1, max: 4 }]
      : [{ item: 'wheat_seeds' }],
  });
}

// Wall torches: hidden variants of `torch`, attached to the block behind them (wallFacing = the direction
// the torch leans toward / points away from the wall). Boxes are Minecraft's wall torch shapes.
variant(129, 'wall_torch_north', 'torch', 'torch', {
  needsSupport: 'wall', wallFacing: 'north', selectionBox: [0.34375, 0.1875, 0.6875, 0.65625, 0.8125, 1],
});
variant(130, 'wall_torch_south', 'torch', 'torch', {
  needsSupport: 'wall', wallFacing: 'south', selectionBox: [0.34375, 0.1875, 0, 0.65625, 0.8125, 0.3125],
});
variant(131, 'wall_torch_east', 'torch', 'torch', {
  needsSupport: 'wall', wallFacing: 'east', selectionBox: [0, 0.1875, 0.34375, 0.3125, 0.8125, 0.65625],
});
variant(132, 'wall_torch_west', 'torch', 'torch', {
  needsSupport: 'wall', wallFacing: 'west', selectionBox: [0.6875, 0.1875, 0.34375, 1, 0.8125, 0.65625],
});

// Extra (non-block-face) textures that must exist in the block texture array.
export const EXTRA_BLOCK_TEXTURES = Object.freeze([
  'destroy_stage_0', 'destroy_stage_1', 'destroy_stage_2', 'destroy_stage_3', 'destroy_stage_4',
  'destroy_stage_5', 'destroy_stage_6', 'destroy_stage_7', 'destroy_stage_8', 'destroy_stage_9',
]);

// Textures with consecutive animation frames: name -> frame count (frames occupy consecutive layers).
export const ANIMATED_TEXTURES = Object.freeze({ water_still: 16, lava_still: 16 });

// Opaque-layer textures whose ALPHA channel is a tint mask (alpha 0 = fully tinted grayscale pixel,
// alpha 255 = untinted coloured pixel). See docs/SPEC.md §5.3.
export const TINT_MASK_TEXTURES = Object.freeze(['grass_block_top', 'grass_block_side']);
