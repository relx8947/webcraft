// Single import point for blocks, items and the texture-layer table.
// Pure module (works in Node, workers and the main thread).
import { BLOCK_DEFS, EXTRA_BLOCK_TEXTURES, ANIMATED_TEXTURES, TINT_MASK_TEXTURES, WOOL_COLORS } from './blocks.js';
import { ITEM_DEFS, BLOCK_FUEL, CREATIVE_TABS, TOOL_MATERIALS, EXTRA_ITEM_TEXTURES, SPAWN_EGG_MOBS } from './items.js';

export { CREATIVE_TABS, TOOL_MATERIALS, WOOL_COLORS, SPAWN_EGG_MOBS };

export const RENDER = Object.freeze({ NONE: 0, CUBE: 1, CROSS: 2, TORCH: 3, LIQUID: 4, CACTUS: 5, CHEST: 6, CROP: 7, FARMLAND: 8 });
export const LAYER = Object.freeze({ OPAQUE: 0, CUTOUT: 1, TRANSLUCENT: 2 });
export const TINT = Object.freeze({ NONE: 0, GRASS: 1, FOLIAGE: 2, BIRCH: 3, SPRUCE: 4 });

const RENDER_BY_NAME = { none: 0, cube: 1, cross: 2, torch: 3, liquid: 4, cactus: 5, chest: 6, crop: 7, farmland: 8 };
const LAYER_BY_NAME = { opaque: 0, cutout: 1, translucent: 2 };
const TINT_BY_NAME = { grass: 1, foliage: 2, birch: 3, spruce: 4 };
const FACING_FACE = { east: 0, west: 1, south: 4, north: 5 };

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------
export const BLOCKS = BLOCK_DEFS;              // dense array, index = block id
export const BLOCK_COUNT = BLOCK_DEFS.length;
export const BLOCK = {};                       // BLOCK.GRASS_BLOCK === 2
const blockMap = new Map();
for (const b of BLOCKS) {
  BLOCK[b.name.toUpperCase()] = b.id;
  blockMap.set(b.name, b);
}
Object.freeze(BLOCK);

export function blockByName(name) {
  return blockMap.get(name);
}
export function blockId(name) {
  const b = blockMap.get(name);
  if (!b) throw new Error(`unknown block '${name}'`);
  return b.id;
}

function resolveFaces(b) {
  const t = b.tex;
  if (t == null) return null;
  if (typeof t === 'string') return [t, t, t, t, t, t];
  if (t.px) return [t.px, t.nx, t.py, t.ny, t.pz, t.nz];
  if (t.end) {
    if (t.axis === 'x') return [t.end, t.end, t.side, t.side, t.side, t.side];
    if (t.axis === 'z') return [t.side, t.side, t.side, t.side, t.end, t.end];
    return [t.side, t.side, t.end, t.end, t.side, t.side];
  }
  if (t.top) {
    const f = [t.side, t.side, t.top, t.bottom ?? t.top, t.side, t.side];
    if (t.front) f[FACING_FACE[t.facing ?? 'south']] = t.front;
    return f;
  }
  throw new Error(`bad texture spec for block ${b.name}`);
}

// UV rotation (90°) per face, used by sideways logs so the bark grain follows the log axis.
function resolveRotations(b) {
  const t = b.tex;
  if (t && typeof t === 'object' && t.end) {
    if (t.axis === 'x') return [0, 0, 1, 1, 1, 1];
    if (t.axis === 'z') return [1, 1, 0, 0, 0, 0];
  }
  return [0, 0, 0, 0, 0, 0];
}

for (const b of BLOCKS) {
  b.faces = resolveFaces(b);
  b.faceRotation = resolveRotations(b);
}

// ---------------------------------------------------------------------------
// Texture table: every texture lives in ONE TEXTURE_2D_ARRAY (blocks, extras, items).
// ---------------------------------------------------------------------------
export const TEXTURES = [];                    // { name, layer, frames, kind, alphaMode, tinted }
export const TEXTURE_INDEX = new Map();        // name -> layer of first frame
const tintMask = new Set(TINT_MASK_TEXTURES);

function addTexture(name, kind, alphaMode, tinted) {
  if (TEXTURE_INDEX.has(name)) return;
  const frames = ANIMATED_TEXTURES[name] ?? 1;
  const layer = TEXTURES.length === 0 ? 0 : TEXTURES[TEXTURES.length - 1].layer + TEXTURES[TEXTURES.length - 1].frames;
  TEXTURES.push({ name, layer, frames, kind, alphaMode, tinted });
  TEXTURE_INDEX.set(name, layer);
}

for (const b of BLOCKS) {
  if (!b.faces) continue;
  for (const name of b.faces) {
    let alphaMode;
    if (tintMask.has(name)) alphaMode = 'tintmask';
    else alphaMode = b.layer; // 'opaque' | 'cutout' | 'translucent'
    const tinted = tintMask.has(name) || (b.tint != null && b.layer !== 'opaque');
    addTexture(name, 'block', alphaMode, tinted);
  }
}
for (const name of EXTRA_BLOCK_TEXTURES) addTexture(name, 'overlay', 'translucent', false);
for (const it of ITEM_DEFS) {
  if (it) addTexture(it.texture, 'item', 'cutout', false);
}
for (const name of EXTRA_ITEM_TEXTURES) addTexture(name, 'item', 'cutout', false);
export const TEXTURE_LAYER_COUNT = TEXTURES[TEXTURES.length - 1].layer + TEXTURES[TEXTURES.length - 1].frames;
if (TEXTURE_LAYER_COUNT > 256) throw new Error('texture array exceeds 256 layers (vertex format limit)');

export function textureLayer(name) {
  const l = TEXTURE_INDEX.get(name);
  if (l === undefined) throw new Error(`unknown texture '${name}'`);
  return l;
}

for (const b of BLOCKS) {
  b.faceLayers = b.faces ? b.faces.map((n) => TEXTURE_INDEX.get(n)) : [0, 0, 0, 0, 0, 0];
}

// ---------------------------------------------------------------------------
// Fast lookup tables (index = block id; sized 256 so any byte is a safe index)
// ---------------------------------------------------------------------------
export const IS_OPAQUE = new Uint8Array(256);
export const IS_SOLID = new Uint8Array(256);
export const IS_LIQUID = new Uint8Array(256);
export const IS_REPLACEABLE = new Uint8Array(256);
export const RENDER_TYPE = new Uint8Array(256);
export const RENDER_LAYER = new Uint8Array(256);
export const LIGHT_EMISSION = new Uint8Array(256);
export const LIGHT_FILTER = new Uint8Array(256);
export const CULL_SAME = new Uint8Array(256);
export const TINT_TYPE = new Uint8Array(256);
export const NEEDS_SUPPORT = new Uint8Array(256);
export const HAS_GRAVITY = new Uint8Array(256);
export const FACE_LAYERS = new Uint8Array(256 * 6);   // [id * 6 + face]
export const FACE_ROTATION = new Uint8Array(256 * 6); // [id * 6 + face] 1 = rotate UVs 90°

for (const b of BLOCKS) {
  const i = b.id;
  IS_OPAQUE[i] = b.opaque ? 1 : 0;
  IS_SOLID[i] = b.solid ? 1 : 0;
  IS_LIQUID[i] = b.liquid ? 1 : 0;
  IS_REPLACEABLE[i] = b.replaceable ? 1 : 0;
  RENDER_TYPE[i] = RENDER_BY_NAME[b.renderType];
  RENDER_LAYER[i] = LAYER_BY_NAME[b.layer];
  LIGHT_EMISSION[i] = b.lightEmission;
  LIGHT_FILTER[i] = b.lightFilter;
  CULL_SAME[i] = b.cullSame ? 1 : 0;
  TINT_TYPE[i] = b.tint ? TINT_BY_NAME[b.tint] : 0;
  NEEDS_SUPPORT[i] = b.needsSupport ? 1 : 0;
  HAS_GRAVITY[i] = b.gravity ? 1 : 0;
  for (let f = 0; f < 6; f++) {
    FACE_LAYERS[i * 6 + f] = b.faceLayers[f];
    FACE_ROTATION[i * 6 + f] = b.faceRotation[f];
  }
}

// ---------------------------------------------------------------------------
// Liquids (docs/SPEC-wave2.md §1): sources, flowing levels 1..7, falling (8)
// ---------------------------------------------------------------------------
export const LIQUID = Object.freeze({ NONE: 0, WATER: 1, LAVA: 2 });
export const LIQUID_KIND = new Uint8Array(256);   // 0 none, 1 water, 2 lava
export const LIQUID_LEVEL = new Uint8Array(256);  // 0 source, 1..7 flowing, 8 falling
const LIQUID_IDS = [[], [], []];                  // [kind][level] -> id
for (const b of BLOCKS) {
  let kind = 0;
  let level = 0;
  if (b.name === 'water') kind = 1;
  else if (b.name === 'lava') kind = 2;
  const m = /^(water|lava)_(flowing_(\d)|falling)$/.exec(b.name);
  if (m) {
    kind = m[1] === 'water' ? 1 : 2;
    level = m[3] ? Number(m[3]) : 8;
  }
  if (kind) {
    LIQUID_KIND[b.id] = kind;
    LIQUID_LEVEL[b.id] = level;
    LIQUID_IDS[kind][level] = b.id;
  }
}
export function isWater(id) {
  return LIQUID_KIND[id] === 1;
}
export function isLava(id) {
  return LIQUID_KIND[id] === 2;
}
/** Block id of a liquid kind (1 water, 2 lava) at a level (0 source, 1..7 flowing, 8 falling); 0 if invalid. */
export function liquidBlock(kind, level) {
  return LIQUID_IDS[kind]?.[level] ?? 0;
}
/** Surface height (blocks) of a lone liquid cell: Minecraft 1 - (level + 1) / 9; falling = 1. */
export function liquidHeight(id) {
  if (!LIQUID_KIND[id]) return 0;
  const level = LIQUID_LEVEL[id];
  return level >= 8 ? 1 : 1 - (level + 1) / 9;
}

// Support rules: resolved to Set of block ids, or 'solid'.
const SUPPORT = [];
for (const b of BLOCKS) {
  if (!b.needsSupport) continue;
  SUPPORT[b.id] = b.needsSupport === 'solid' || b.needsSupport === 'wall' ? b.needsSupport : new Set(b.needsSupport.map(blockId));
}

/**
 * True if `id` can stay on top of `belowId` (always true for blocks without support needs and for
 * wall torches, which are supported from behind). Floor rule only — prefer canStay().
 */
export function hasSupport(id, belowId) {
  const s = SUPPORT[id];
  if (!s || s === 'wall') return true;
  if (s === 'solid') return IS_SOLID[belowId] === 1 && RENDER_TYPE[belowId] === RENDER.CUBE;
  return s.has(belowId);
}

/**
 * Face index (SPEC §4) a wall torch points toward, or -1 (not a wall torch). The supporting block is
 * the neighbour in the opposite direction.
 */
export const WALL_FACE = new Int8Array(256).fill(-1);
for (const b of BLOCKS) if (b.wallFacing) WALL_FACE[b.id] = FACING_FACE[b.wallFacing];

const SUGAR_CANE_ID = blockId('sugar_cane');
const CACTUS_ID = blockId('cactus');
const H4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/**
 * Full Minecraft survival rule for block `id` at (x, y, z): support below / behind (wall torches),
 * cactus needs 4 non-solid horizontal neighbours, sugar cane needs water next to the block it stands
 * on (unless it stands on sugar cane). `getBlock(x, y, z)` -> id. Use this everywhere (placement,
 * neighbour updates, random ticks) instead of hasSupport().
 */
export function canStay(id, getBlock, x, y, z) {
  const s = SUPPORT[id];
  if (!s) return true;
  if (s === 'wall') {
    const f = WALL_FACE[id];
    const nx = f === 0 ? 1 : f === 1 ? -1 : 0;
    const nz = f === 4 ? 1 : f === 5 ? -1 : 0;
    const behind = getBlock(x - nx, y, z - nz);
    return IS_SOLID[behind] === 1 && RENDER_TYPE[behind] === RENDER.CUBE;
  }
  const below = getBlock(x, y - 1, z);
  if (!hasSupport(id, below)) return false;
  if (id === CACTUS_ID) {
    for (const [dx, dz] of H4) if (IS_SOLID[getBlock(x + dx, y, z + dz)] === 1) return false;
  } else if (id === SUGAR_CANE_ID && below !== SUGAR_CANE_ID) {
    for (const [dx, dz] of H4) if (LIQUID_KIND[getBlock(x + dx, y - 1, z + dz)] === 1) return true;
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Items (block items use the block id; non-block items are >= 256)
// ---------------------------------------------------------------------------
export const ITEMS = [];   // sparse, index = item id
export const ITEM = {};    // ITEM.DIAMOND_PICKAXE === 298, ITEM.STONE === 1
const itemMap = new Map();

for (const b of BLOCKS) {
  if (b.id === 0 || b.hidden) continue;
  ITEMS[b.id] = {
    id: b.id, name: b.name, displayName: b.displayName, maxStack: 64, isBlock: true, block: b.id,
    texture: null, layer: -1, tool: null, food: null, durability: 0,
    fuel: BLOCK_FUEL[b.name] ?? 0, creativeTab: b.creativeTab,
  };
}
for (const it of ITEM_DEFS) {
  if (!it) continue;
  ITEMS[it.id] = { ...it, isBlock: false, block: 0, layer: TEXTURE_INDEX.get(it.texture) };
}
for (const it of ITEMS) {
  if (!it) continue;
  ITEM[it.name.toUpperCase()] = it.id;
  itemMap.set(it.name, it);
  Object.freeze(it);
}
Object.freeze(ITEM);

/** Ordered list of item ids (blocks first in id order, then items) — creative inventory order. */
export const ALL_ITEM_IDS = Object.freeze(ITEMS.map((it) => it && it.id).filter((id) => id != null));

export function getItem(id) {
  return ITEMS[id];
}
export function itemByName(name) {
  return itemMap.get(name);
}
export function itemId(name) {
  const it = itemMap.get(name);
  if (!it) throw new Error(`unknown item '${name}'`);
  return it.id;
}
export function itemDisplayName(id) {
  return ITEMS[id]?.displayName ?? `#${id}`;
}
export function maxStackSize(id) {
  return ITEMS[id]?.maxStack ?? 64;
}
export function isBlockItem(id) {
  return id > 0 && id < 256 && !!ITEMS[id];
}
/** Max durability for damageable items (0 = not damageable). */
export function maxDurability(id) {
  const it = ITEMS[id];
  if (!it) return 0;
  return it.tool ? it.tool.durability : it.durability;
}
/** Item id obtained when picking/dropping a block (variants map to their base item). */
export function itemForBlock(blockIdValue) {
  const b = BLOCKS[blockIdValue];
  if (!b || b.id === 0) return 0;
  if (b.pickItem) return itemId(b.pickItem);
  if (b.item) return itemId(b.item);
  return ITEMS[b.id] ? b.id : 0;
}

// ---------------------------------------------------------------------------
// Gameplay helpers
// ---------------------------------------------------------------------------
export function getToolInfo(id) {
  return ITEMS[id]?.tool ?? null;
}

/** Whether breaking blockId with item `toolId` (0 = hand) yields drops. */
export function canHarvest(blockIdValue, toolId) {
  const b = BLOCKS[blockIdValue];
  if (!b.requiresTool) return true;
  const tool = getToolInfo(toolId);
  return !!tool && tool.type === b.tool && tool.tier >= b.toolTier;
}

/**
 * Survival break time in seconds (Minecraft formula). 0 = instant, Infinity = unbreakable.
 */
export function getBreakTime(blockIdValue, toolId, { inWater = false, onGround = true } = {}) {
  const b = BLOCKS[blockIdValue];
  if (!b || b.hardness < 0) return Infinity;
  if (b.hardness === 0) return 0;
  const tool = getToolInfo(toolId);
  let speed = 1;
  if (tool && b.tool && tool.type === b.tool) speed = tool.speed;
  if (inWater) speed /= 5;
  if (!onGround) speed /= 5;
  const perTick = speed / b.hardness / (canHarvest(blockIdValue, toolId) ? 30 : 100);
  if (perTick >= 1) return 0;
  // The epsilon absorbs float error (e.g. 1 / (2 / 3 / 30) = 45.000000000000004): Minecraft's float
  // progress reaches 1.0 after exactly 45 ticks for coal ore with a wooden pickaxe.
  return Math.ceil(1 / perTick - 1e-9) / 20;
}

/** Items dropped when a survival player breaks a block. rng() -> [0,1). */
export function getDrops(blockIdValue, toolId, rng = Math.random) {
  const b = BLOCKS[blockIdValue];
  if (!b || b.id === 0 || !canHarvest(blockIdValue, toolId)) return [];
  if (b.drops === undefined) {
    const id = itemForBlock(blockIdValue);
    return id ? [{ id, count: 1 }] : [];
  }
  const out = [];
  for (const d of b.drops) {
    if (rng() < (d.chance ?? 1)) {
      const min = d.min ?? 1;
      const max = d.max ?? min;
      const count = min + Math.floor(rng() * (max - min + 1));
      if (count > 0) out.push({ id: itemId(d.item), count });
    } else if (d.alt) {
      out.push({ id: itemId(d.alt), count: 1 });
    }
  }
  return out;
}

/**
 * Block id to place for a block item, given the clicked face (0..5) and player yaw
 * (resolves log axis / furnace facing variants). Returns 0 if the item is not placeable.
 */
export function getPlacementBlock(itemIdValue, face, yaw) {
  const it = ITEMS[itemIdValue];
  if (!it || !it.isBlock) return 0;
  const b = BLOCKS[it.block];
  const p = b.placement;
  if (!p) return b.id;
  if (p.type === 'axis') {
    const axis = face <= 1 ? 'x' : face <= 3 ? 'y' : 'z';
    return blockId(p[axis]);
  }
  if (p.type === 'torch') {
    // Clicking a side face attaches a wall torch pointing away from that face; top/bottom -> floor torch.
    const dir = face === 0 ? 'east' : face === 1 ? 'west' : face === 4 ? 'south' : face === 5 ? 'north' : 'floor';
    return blockId(p[dir]);
  }
  if (p.type === 'facing') {
    // Front faces the player: player looking east (+X) => front faces west.
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    let dir;
    if (Math.abs(fx) > Math.abs(fz)) dir = fx > 0 ? 'west' : 'east';
    else dir = fz > 0 ? 'north' : 'south';
    return blockId(p[dir]);
  }
  return b.id;
}

/** Selection box of a block in block units [x0,y0,z0,x1,y1,z1]. */
const FULL_BOX = Object.freeze([0, 0, 0, 1, 1, 1]);
export function getSelectionBox(id) {
  return BLOCKS[id]?.selectionBox ?? FULL_BOX;
}
/** Collision box or null when the block is not solid. */
export function getCollisionBox(id) {
  const b = BLOCKS[id];
  if (!b || !b.solid) return null;
  return b.collisionBox ?? FULL_BOX;
}

export const DEFAULT_CREATIVE_HOTBAR = Object.freeze([
  'grass_block', 'dirt', 'stone', 'cobblestone', 'oak_planks', 'oak_log', 'glass', 'torch', 'bricks',
]);
