// Chat commands (pure: no DOM). runCommand(game, text) never throws — all feedback and errors go to
// game.addChatMessage(text, color) in Chinese. Messages may contain Minecraft formatting codes
// (§a, §c, §7 ...) which the chat UI renders. getCompletions() powers Tab completion in the chat UI.
//
// Coordinates accept absolute values, `~` (relative to the player's feet) and `^` (local:
// ^left ^up ^forward along the look direction) like Minecraft. /give and /setblock accept internal
// names (diamond_pickaxe, minecraft:stone), Chinese display names (钻石镐) and numeric ids.
// Entity selectors (/kill): @s @p @a @r = the player; @e = every mob, narrowed with
// [type=zombie | type=!zombie, distance=..10, limit=3, sort=nearest|furthest|random|arbitrary];
// type=item / arrow / tnt / falling_block / player select those entities instead of mobs.
// /summon uses spawnMob() of src/game/mobs.js, imported on first use (the command completes
// asynchronously the first time; runCommand then returns a Promise that never rejects).
import {
  BLOCKS, ALL_ITEM_IDS, getItem, blockByName, maxStackSize, itemDisplayName, getDrops, ITEM, SPAWN_EGG_MOBS,
} from '../world/registry.js';
import { makeStack } from './inventory.js';
import { containerType } from './blockentities.js';
import { WORLD_HEIGHT, DAY_TICKS, DEFAULT_SETTINGS } from '../config.js';

const ERROR_COLOR = '#FF5555';
const FILL_LIMIT = 32768;
const MAX_GIVE = 64 * 36;
const COORD_LIMIT = 30000000;

/** Error with an optional pointer to the offending token (index into the token list). */
class CommandError extends Error {
  constructor(message, tokenIndex = -1) {
    super(message);
    this.tokenIndex = tokenIndex;
  }
}

/** Split into whitespace-separated tokens with their character offsets. */
function tokenize(text) {
  const out = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(text))) out.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Name resolution
// ---------------------------------------------------------------------------------------------
const ITEM_LOOKUP = new Map();   // normalized key -> item id
const BLOCK_LOOKUP = new Map();  // normalized key -> block id (includes hidden variants by name)
for (const id of ALL_ITEM_IDS) {
  const it = getItem(id);
  ITEM_LOOKUP.set(it.name, id);
  if (!ITEM_LOOKUP.has(it.displayName)) ITEM_LOOKUP.set(it.displayName, id);
}
for (const b of BLOCKS) {
  BLOCK_LOOKUP.set(b.name, b.id);
}
for (const b of BLOCKS) {
  // Chinese names map to the visible base block (variants share their base's display name).
  if (!b.hidden && !BLOCK_LOOKUP.has(b.displayName)) BLOCK_LOOKUP.set(b.displayName, b.id);
}
BLOCK_LOOKUP.set('空气', 0);

function normalizeName(token) {
  let t = String(token).trim().toLowerCase();
  if (t.startsWith('minecraft:')) t = t.slice(10);
  return t.replace(/\s+/g, '_');
}

/** Resolve an item token (internal name, minecraft:name, Chinese name or numeric id) to an id or null. */
export function resolveItem(token) {
  const t = normalizeName(token);
  if (!t) return null;
  if (/^\d+$/.test(t)) return getItem(Number(t)) ? Number(t) : null;
  return ITEM_LOOKUP.get(t) ?? null;
}

/** Resolve a block token (internal names incl. variants like oak_log_x, Chinese names, ids) or null. */
export function resolveBlock(token) {
  const t = normalizeName(token);
  if (!t) return null;
  if (/^\d+$/.test(t)) return BLOCKS[Number(t)] ? Number(t) : null;
  return BLOCK_LOOKUP.get(t) ?? null;
}

/** Levenshtein distance (small strings only). */
function editDistance(a, b) {
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

/** Up to `limit` names similar to an unknown token (for "did you mean" hints). */
function similarNames(token, keys, limit = 5) {
  const t = normalizeName(token);
  if (!t) return [];
  const scored = [];
  for (const k of keys) {
    let score;
    if (k.includes(t) || (t.length >= 3 && k.length >= 3 && t.includes(k))) score = 0;
    else {
      // compare with the whole name and with each word of it (diamond_pickaxe -> diamond, pickaxe)
      score = Math.min(editDistance(t, k), ...k.split('_').map((w) => editDistance(t, w) + 0.5));
      if (score > Math.max(1, Math.floor(t.length / 3))) continue;
    }
    scored.push([score, k]);
  }
  scored.sort((x, y) => x[0] - y[0] || x[1].length - y[1].length);
  return scored.slice(0, limit).map((e) => e[1]);
}

function itemNameKeys() {
  return ALL_ITEM_IDS.map((id) => getItem(id).name);
}
function itemZhKeys() {
  return ALL_ITEM_IDS.map((id) => getItem(id).displayName);
}

// ---------------------------------------------------------------------------------------------
// Argument helpers
// ---------------------------------------------------------------------------------------------
const SELECTORS = new Set(['@s', '@p', '@a', '@r', '@e', '玩家']);

function isSelector(tok) {
  return !!tok && (SELECTORS.has(tok) || /^@[spare]\[.*\]$/.test(tok));
}

function parseNumberToken(tok, index, what = '数字') {
  const v = Number(tok);
  if (tok === '' || !Number.isFinite(v)) throw new CommandError(`无效的${what}：“${tok}”`, index);
  return v;
}

function parseIntToken(tok, index, min, max) {
  if (!/^[+-]?\d+$/.test(tok)) throw new CommandError(`无效的整数：“${tok}”`, index);
  const v = Number(tok);
  if (v < min) throw new CommandError(`整数不能小于 ${min}，找到 ${v}`, index);
  if (v > max) throw new CommandError(`整数不能大于 ${max}，找到 ${v}`, index);
  return v;
}

/** Player feet position + look basis (yaw/pitch per SPEC §4). */
function playerFrame(player) {
  const yaw = player.yaw ?? 0;
  const pitch = player.pitch ?? 0;
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const sy = Math.sin(yaw), cy = Math.cos(yaw);
  return {
    pos: [player.x ?? 0, player.y ?? 0, player.z ?? 0],
    forward: [-sy * cp, sp, -cy * cp],
    up: [sy * sp, cp, cy * sp],
    left: [-cy, 0, sy],
  };
}

/**
 * Parse three coordinate tokens starting at token index `i`.
 * @param {boolean} block  block coordinates (floored) instead of entity coordinates
 * @returns {number[]} [x, y, z]
 */
function parsePosition(ctx, i, { block = false } = {}) {
  const toks = ctx.tokens;
  if (i + 2 >= toks.length) throw new CommandError('坐标不完整：需要 x y z 三个值', toks.length);
  const raw = [toks[i].text, toks[i + 1].text, toks[i + 2].text];
  const player = ctx.player;
  const local = raw.map((t) => t.startsWith('^'));
  let out;
  if (local.some(Boolean)) {
    if (!local.every(Boolean)) throw new CommandError('不能混用世界坐标与局部坐标（^ 需要同时用于三个坐标）', i + local.indexOf(false));
    if (!player) throw new CommandError('局部坐标需要一个玩家');
    const f = playerFrame(player);
    const [l, u, fw] = raw.map((t, k) => (t.length > 1 ? parseNumberToken(t.slice(1), i + k, '坐标') : 0));
    out = [0, 1, 2].map((a) => f.pos[a] + f.left[a] * l + f.up[a] * u + f.forward[a] * fw);
  } else {
    const base = player ? [player.x, player.y, player.z] : [0, 0, 0];
    out = raw.map((t, a) => {
      if (t.startsWith('~')) {
        if (!player) throw new CommandError('相对坐标需要一个玩家', i + a);
        const off = t.length > 1 ? parseNumberToken(t.slice(1), i + a, '坐标') : 0;
        return base[a] + off;
      }
      const v = parseNumberToken(t, i + a, '坐标');
      // Entity coordinates: integer x/z mean the block centre (Minecraft behaviour).
      if (!block && a !== 1 && /^[+-]?\d+$/.test(t)) return v + 0.5;
      return v;
    });
  }
  for (let a = 0; a < 3; a++) {
    if (Math.abs(out[a]) > COORD_LIMIT) throw new CommandError('坐标超出了世界的范围', i + a);
  }
  return block ? out.map(Math.floor) : out;
}

function fmt(v) {
  return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/\.?0+$/, '');
}

function itemLabel(id) {
  return `[${itemDisplayName(id)}]`;
}

function requireWorld(ctx) {
  if (!ctx.world) throw new CommandError('当前没有加载世界');
  return ctx.world;
}

function requirePlayer(ctx) {
  if (!ctx.player) throw new CommandError('该命令需要一个玩家');
  return ctx.player;
}

/** Skip an optional leading target selector (only the local player exists). Returns next index. */
function skipTarget(ctx, i) {
  return isSelector(ctx.tokens[i]?.text) ? i + 1 : i;
}

function bestToolFor(blockIdValue) {
  const b = BLOCKS[blockIdValue];
  if (!b || !b.tool) return 0;
  const id = ITEM[`DIAMOND_${b.tool.toUpperCase()}`];
  return id ?? 0;
}

function dropBlockItems(ctx, id, x, y, z) {
  if (!id || typeof ctx.game.spawnItem !== 'function') return;
  for (const d of getDrops(id, bestToolFor(id))) {
    ctx.game.spawnItem(makeStack(d.id, d.count), x + 0.5, y + 0.5, z + 0.5);
  }
}

/**
 * /setblock and /fill without "destroy" clear a replaced container instead of dropping its contents
 * (Minecraft SetBlockCommand / FillCommand: Clearable.tryClear). "destroy" keeps the drops (the block
 * entity manager drops them when the block changes).
 */
function clearContainer(ctx, oldId, x, y, z) {
  if (!containerType(oldId)) return;
  ctx.game.blockEntities?.remove?.(x, y, z);
}

/** Give a stack to the player: inventory first, overflow is dropped at the player's feet. */
function giveToPlayer(ctx, id, count) {
  const player = requirePlayer(ctx);
  const inv = player.inventory;
  let left = inv ? inv.add(makeStack(id, count)) : count;
  const max = maxStackSize(id);
  while (left > 0) {
    const n = Math.min(max, left);
    if (typeof ctx.game.dropFromPlayer === 'function') ctx.game.dropFromPlayer(makeStack(id, n));
    left -= n;
  }
}

function playerName(game) {
  return game.playerName || '玩家';
}

// ---------------------------------------------------------------------------------------------
// Mobs, entities, difficulty
// ---------------------------------------------------------------------------------------------
/** Summonable mob types (Minecraft entity ids) -> Chinese names (items.js SPAWN_EGG_MOBS). */
const MOB_NAMES = new Map(SPAWN_EGG_MOBS);
const SUMMONABLE = Object.freeze([...MOB_NAMES.keys()]);
const HOSTILE_MOBS = new Set(['zombie', 'skeleton', 'creeper', 'spider']);
/** Non-mob entity types usable in selectors (EntityManager entity.type) with Chinese names. */
const OTHER_ENTITY_NAMES = new Map([
  ['item', '物品'], ['arrow', '箭'], ['tnt', '已激活的TNT'], ['falling_block', '下落的方块'], ['player', '玩家'],
]);
const SELECTOR_TYPES = Object.freeze([...SUMMONABLE, ...OTHER_ENTITY_NAMES.keys()]);
const ENTITY_LOOKUP = new Map();
for (const [id, zh] of [...MOB_NAMES, ...OTHER_ENTITY_NAMES]) {
  ENTITY_LOOKUP.set(id, id);
  ENTITY_LOOKUP.set(zh, id);
}
ENTITY_LOOKUP.set('primed_tnt', 'tnt');

/** Resolve a mob token (pig, minecraft:pig, 猪) to its type or null. */
export function resolveMobType(token) {
  const t = ENTITY_LOOKUP.get(normalizeName(token));
  return t && MOB_NAMES.has(t) ? t : null;
}

function resolveEntityType(token) {
  return ENTITY_LOOKUP.get(normalizeName(token)) ?? null;
}

// spawnMob() of the MOBS agent's src/game/mobs.js, loaded on first use (guarded: a missing / broken
// module only makes /summon report an error).
let mobsModule = null;
let mobsLoading = null;
function loadMobsModule() {
  if (mobsModule) return Promise.resolve(mobsModule);
  if (!mobsLoading) {
    mobsLoading = import('./mobs.js').then((m) => {
      mobsModule = m;
      return m;
    }, (err) => {
      mobsLoading = null;
      if (typeof console !== 'undefined') console.warn('[commands] mobs.js could not be loaded:', err?.message ?? err);
      return null;
    });
  }
  return mobsLoading;
}

const DIFFICULTIES = Object.freeze(['peaceful', 'easy', 'normal', 'hard']);
const DIFFICULTY_NAMES = Object.freeze({ peaceful: '和平', easy: '简单', normal: '普通', hard: '困难' });
const DIFFICULTY_ALIASES = {
  peaceful: 'peaceful', p: 'peaceful', 0: 'peaceful', 和平: 'peaceful',
  easy: 'easy', e: 'easy', 1: 'easy', 简单: 'easy',
  normal: 'normal', n: 'normal', 2: 'normal', 普通: 'normal',
  hard: 'hard', h: 'hard', 3: 'hard', 困难: 'hard',
};

/** The current difficulty ('peaceful' | 'easy' | 'normal' | 'hard'). */
export function getDifficulty(game) {
  const d = game?.settings?.difficulty;
  return DIFFICULTIES.includes(d) ? d : DEFAULT_SETTINGS.difficulty;
}

/**
 * Set settings.difficulty through game.applySettings (persisted, emits settingsChanged). If the game's
 * settings validation drops the string (older sanitizeSettings), the live settings object is updated
 * directly so the difficulty still applies for this session.
 */
export function setDifficulty(game, difficulty) {
  if (!DIFFICULTIES.includes(difficulty)) return false;
  if (typeof game.applySettings === 'function') game.applySettings({ difficulty });
  if (game.settings?.difficulty !== difficulty) {
    if (game.settings && !Object.isFrozen(game.settings)) game.settings.difficulty = difficulty;
    else game.settings = { ...(game.settings ?? {}), difficulty };
    game.emit?.('settingsChanged', { difficulty }, game.settings);
  }
  return true;
}

/** Selector type of an entity: the mob type for mobs, else the entity type ('item', 'arrow', ...). */
function entityTypeOf(e) {
  return e.type === 'mob' ? e.mobType : e.type;
}

/** Chinese name of an entity for messages. */
function entityName(e, game) {
  if (e === PLAYER_TARGET) return playerName(game);
  if (e.type === 'mob') return MOB_NAMES.get(e.mobType) ?? e.mobType ?? '生物';
  if (e.type === 'item' && e.stack) return itemDisplayName(e.stack.id);
  return OTHER_ENTITY_NAMES.get(e.type) ?? '实体';
}

/** Stand-in for the local player in entity selections. */
const PLAYER_TARGET = Object.freeze({ type: 'player' });

function parseRange(text, index, what) {
  const m = /^([+-]?\d+(?:\.\d+)?)?(\.\.)?([+-]?\d+(?:\.\d+)?)?$/.exec(text);
  if (!m || (!m[1] && !m[3])) throw new CommandError(`无效的${what}范围：“${text}”`, index);
  if (!m[2]) {
    const v = Number(m[1]);
    return { min: v, max: v };
  }
  return { min: m[1] ? Number(m[1]) : -Infinity, max: m[3] ? Number(m[3]) : Infinity };
}

/**
 * Parse an entity selector token (@e[type=zombie,distance=..10,limit=2,sort=nearest] …).
 * @returns {{ base: string, type: string|null, notTypes: Set<string>, distance: {min,max}|null, limit: number, sort: string }}
 */
function parseSelector(tok, index) {
  const m = /^@([spare])(?:\[(.*)\])?$/.exec(tok);
  if (!m) throw new CommandError(`无效的目标选择器：“${tok}”`, index);
  const sel = { base: m[1], type: null, notTypes: new Set(), distance: null, limit: Infinity, sort: 'arbitrary' };
  const body = (m[2] ?? '').trim();
  if (!body) return sel;
  for (const part of body.split(',')) {
    const eq = part.indexOf('=');
    if (eq < 0) throw new CommandError(`无效的选择器参数：“${part.trim()}”`, index);
    const key = part.slice(0, eq).trim().toLowerCase();
    let val = part.slice(eq + 1).trim();
    switch (key) {
      case 'type': {
        const neg = val.startsWith('!');
        if (neg) val = val.slice(1);
        const t = resolveEntityType(val);
        if (!t) throw new CommandError(`未知的实体类型：“${val}”`, index);
        if (neg) sel.notTypes.add(t);
        else if (sel.type && sel.type !== t) throw new CommandError('选择器参数 type 只能指定一次', index);
        else sel.type = t;
        break;
      }
      case 'distance': {
        const r = parseRange(val, index, '距离');
        if (r.min < 0 && Number.isFinite(r.min)) throw new CommandError('距离不能为负数', index);
        sel.distance = { min: Math.max(0, r.min), max: r.max };
        break;
      }
      case 'limit': {
        if (!/^\d+$/.test(val) || Number(val) < 1) throw new CommandError(`无效的数量限制：“${val}”`, index);
        sel.limit = Number(val);
        break;
      }
      case 'sort':
        if (!['nearest', 'furthest', 'random', 'arbitrary'].includes(val)) throw new CommandError(`未知的排序方式：“${val}”`, index);
        sel.sort = val;
        break;
      default:
        throw new CommandError(`未知的选择器参数：“${key}”`, index);
    }
  }
  return sel;
}

/** Entities (and PLAYER_TARGET) matched by an @e selector. Without a type, @e means every mob. */
function selectEntities(ctx, sel) {
  const game = ctx.game;
  const player = ctx.player;
  const out = [];
  const list = game.entities?.list ?? game.entities?.entities ?? [];
  for (const e of list) {
    if (!e || e.removed || e.dead) continue;
    const t = entityTypeOf(e);
    if (sel.type ? t !== sel.type : e.type !== 'mob') continue;
    if (sel.notTypes.has(t)) continue;
    out.push(e);
  }
  if (sel.type === 'player' && player && !player.dead && !sel.notTypes.has('player')) out.push(PLAYER_TARGET);
  const px = player?.x ?? 0, py = player?.y ?? 0, pz = player?.z ?? 0;
  const dist = (e) => {
    const s = e === PLAYER_TARGET ? player : e;
    const x = s.x ?? s.body?.x ?? 0, y = s.y ?? s.body?.y ?? 0, z = s.z ?? s.body?.z ?? 0;
    return Math.hypot(x - px, y - py, z - pz);
  };
  let res = out;
  if (sel.distance) res = res.filter((e) => { const d = dist(e); return d >= sel.distance.min && d <= sel.distance.max; });
  if (sel.sort === 'nearest') res.sort((a, b) => dist(a) - dist(b));
  else if (sel.sort === 'furthest') res.sort((a, b) => dist(b) - dist(a));
  else if (sel.sort === 'random') {
    for (let i = res.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [res[i], res[j]] = [res[j], res[i]];
    }
  }
  if (res.length > sel.limit) res = res.slice(0, sel.limit);
  return res;
}

/** Kill the local player (Minecraft /kill on a player; works in creative too). */
function killPlayer(ctx) {
  const player = requirePlayer(ctx);
  if (player.dead) throw new CommandError(`${playerName(ctx.game)}已经死亡`);
  if (typeof player.kill === 'function') player.kill();
  else if (typeof player.damage === 'function') player.damage(1e9, 'kill');
  else player.health = 0;
  if (!player.dead && player.health > 0) throw new CommandError(`无法杀死${playerName(ctx.game)}`);
}

/** Kill / remove one selected entity. */
function killEntity(ctx, e) {
  if (e === PLAYER_TARGET) {
    killPlayer(ctx);
    return;
  }
  if (e.type === 'mob') {
    if (typeof e.kill === 'function') e.kill();
    else if (typeof e.hurt === 'function') e.hurt(1e9, 'kill');
    else if (typeof e.remove === 'function') e.remove();
    else e.removed = true;
  } else if (typeof e.remove === 'function') {
    e.remove();
  } else {
    e.removed = true;
  }
}

/** True for tokens that address the local player (@s @p @a @r with or without arguments, the name). */
function isPlayerTarget(tok, game) {
  return (SELECTORS.has(tok) && tok !== '@e') || /^@[spar]\[.*\]$/.test(tok) || tok === playerName(game);
}

// ---------------------------------------------------------------------------------------------
// Command table
// ---------------------------------------------------------------------------------------------
const MODE_ALIASES = {
  survival: 'survival', s: 'survival', 0: 'survival', 生存: 'survival', 生存模式: 'survival',
  creative: 'creative', c: 'creative', 1: 'creative', 创造: 'creative', 创造模式: 'creative',
};
const MODE_NAMES = { survival: '生存模式', creative: '创造模式' };
const TIME_NAMES = {
  day: 1000, noon: 6000, night: 13000, midnight: 18000,
  白天: 1000, 早上: 1000, 中午: 6000, 正午: 6000, 夜晚: 13000, 晚上: 13000, 午夜: 18000,
};
const FILL_MODES = ['replace', 'destroy', 'keep', 'hollow', 'outline'];
const SETBLOCK_MODES = ['replace', 'keep', 'destroy'];

/** Parse a duration: "100" ticks, "5s" seconds, "2d" days. */
function parseTicks(tok, index) {
  const m = /^([+-]?\d+(?:\.\d+)?)([dst]?)$/i.exec(tok ?? '');
  if (!m) throw new CommandError(`无效的时间：“${tok ?? ''}”`, index);
  const unit = m[2].toLowerCase();
  const mult = unit === 'd' ? DAY_TICKS : unit === 's' ? 20 : 1;
  return Math.round(parseFloat(m[1]) * mult);
}

function setTime(game, ticks) {
  const t = Math.max(0, Math.round(ticks));
  if (typeof game.setTime === 'function') game.setTime(t);
  else game.time = t;
  return t;
}

/**
 * Command definitions. `run(ctx)` throws CommandError for user errors.
 * `complete(argIndex, ctx)` returns candidate strings for argument `argIndex` (0-based after the name).
 */
const COMMANDS = [
  {
    name: 'help', aliases: ['?', '帮助'], usage: '/help [命令]', desc: '显示命令列表或某个命令的用法',
    run(ctx) {
      const arg = ctx.tokens[1]?.text;
      if (arg && !/^\d+$/.test(arg)) {
        const cmd = findCommand(arg.replace(/^\//, ''));
        if (!cmd) throw new CommandError(`未知的命令：“${arg}”`, 1);
        ctx.say(`§e${cmd.usage}`);
        ctx.say(`§7${cmd.desc}`);
        if (cmd.aliases?.length) ctx.say(`§7别名：${cmd.aliases.map((a) => '/' + a).join('、')}`);
        return;
      }
      ctx.say('§2--- 命令列表（输入 /help <命令> 查看详细用法） ---');
      for (const c of COMMANDS) ctx.say(`§6${c.usage} §7- ${c.desc}`);
    },
    complete(i) {
      return i === 0 ? COMMANDS.map((c) => c.name) : [];
    },
  },
  {
    name: 'gamemode', aliases: ['gm'], usage: '/gamemode <survival|creative> [玩家]', desc: '设置游戏模式（生存 / 创造）',
    run(ctx) {
      const tok = ctx.tokens[1]?.text;
      if (!tok) throw new CommandError('缺少参数：游戏模式（survival 或 creative）', 1);
      const mode = MODE_ALIASES[tok.toLowerCase()];
      if (!mode) {
        if (/^(adventure|spectator|a|2|3|冒险|旁观)/i.test(tok)) throw new CommandError(`WebCraft 暂不支持该游戏模式：“${tok}”`, 1);
        throw new CommandError(`未知的游戏模式：“${tok}”`, 1);
      }
      requirePlayer(ctx);
      if (typeof ctx.game.setGameMode === 'function') ctx.game.setGameMode(mode);
      else if (typeof ctx.player.setGameMode === 'function') ctx.player.setGameMode(mode);
      else ctx.player.mode = mode;
      ctx.say(`已将自己的游戏模式设置为${MODE_NAMES[mode]}`);
    },
    complete(i) {
      return i === 0 ? ['survival', 'creative'] : i === 1 ? ['@s'] : [];
    },
  },
  {
    name: 'time', usage: '/time <set|add|query> <值>', desc: '更改或查询时间（day noon night midnight，或刻数 / 5s / 1d）',
    run(ctx) {
      const sub = ctx.tokens[1]?.text?.toLowerCase();
      const val = ctx.tokens[2]?.text;
      const game = ctx.game;
      const now = Math.floor(game.time ?? 0);
      if (sub === 'set') {
        if (val === undefined) throw new CommandError('缺少参数：时间', 2);
        const named = TIME_NAMES[val.toLowerCase()];
        const ticks = named ?? parseTicks(val, 2);
        if (ticks < 0) throw new CommandError('时间不能为负数', 2);
        const t = setTime(game, ticks);
        ctx.say(`已将时间设为 ${t}`);
      } else if (sub === 'add') {
        if (val === undefined) throw new CommandError('缺少参数：时间', 2);
        const ticks = parseTicks(val, 2);
        const t = setTime(game, now + ticks);
        ctx.say(`已将时间设为 ${t % DAY_TICKS}（增加了 ${ticks} 刻）`);
      } else if (sub === 'query') {
        const what = (val ?? 'daytime').toLowerCase();
        if (what === 'daytime') ctx.say(`当前时间为 ${now % DAY_TICKS}`);
        else if (what === 'gametime') ctx.say(`当前游戏刻为 ${now}`);
        else if (what === 'day') ctx.say(`当前是第 ${Math.floor(now / DAY_TICKS)} 天`);
        else throw new CommandError(`未知的查询类型：“${val}”（daytime、gametime 或 day）`, 2);
      } else {
        throw new CommandError(sub ? `未知的子命令：“${ctx.tokens[1].text}”（set、add 或 query）` : '缺少参数：set、add 或 query', 1);
      }
    },
    complete(i, ctx) {
      if (i === 0) return ['set', 'add', 'query'];
      const sub = ctx.tokens[1]?.text?.toLowerCase();
      if (i === 1 && sub === 'set') return ['day', 'noon', 'night', 'midnight'];
      if (i === 1 && sub === 'query') return ['daytime', 'gametime', 'day'];
      return [];
    },
  },
  {
    name: 'tp', aliases: ['teleport'], usage: '/tp [玩家] <x> <y> <z> [水平角] [垂直角]', desc: '传送玩家（支持 ~ 相对坐标和 ^ 局部坐标）',
    run(ctx) {
      const player = requirePlayer(ctx);
      let i = skipTarget(ctx, 1);
      if (i >= ctx.tokens.length) {
        if (i > 1) {
          ctx.say(`已将${playerName(ctx.game)}传送到${playerName(ctx.game)}`);
          return;
        }
        throw new CommandError('缺少参数：目标坐标', 1);
      }
      const [x, y, z] = parsePosition(ctx, i);
      i += 3;
      let yaw = player.yaw ?? 0;
      let pitch = player.pitch ?? 0;
      const rot = (tok, idx, cur, toOurs) => {
        // Relative offsets are given in Minecraft degrees; both axes have the opposite sign here.
        if (tok.startsWith('~')) return cur - (tok.length > 1 ? parseNumberToken(tok.slice(1), idx, '角度') : 0) * Math.PI / 180;
        const deg = parseNumberToken(tok, idx, '角度');
        // Minecraft yaw: 0 = south, 90 = west; ours: 0 = north, +pi/2 = west. Pitch sign flips.
        return toOurs === 'yaw' ? Math.PI - deg * Math.PI / 180 : -deg * Math.PI / 180;
      };
      if (ctx.tokens[i]) yaw = rot(ctx.tokens[i].text, i, yaw, 'yaw');
      if (ctx.tokens[i + 1]) {
        pitch = rot(ctx.tokens[i + 1].text, i + 1, pitch, 'pitch');
        const lim = 89.9 * Math.PI / 180;
        pitch = Math.max(-lim, Math.min(lim, pitch));
      }
      if (typeof player.setPosition === 'function') player.setPosition(x, y, z);
      else { player.x = x; player.y = y; player.z = z; }
      player.vx = 0; player.vy = 0; player.vz = 0;
      if (ctx.tokens[i]) {
        player.yaw = yaw;
        player.pitch = pitch;
      }
      ctx.say(`已将${playerName(ctx.game)}传送到 ${fmt(x)}, ${fmt(y)}, ${fmt(z)}`);
    },
    complete(i, ctx) {
      const start = isSelector(ctx.tokens[1]?.text) ? 1 : 0;
      if (i === 0) return ['@s', ...coordSuggestions(ctx, 0, false)];
      return i - start < 3 ? coordSuggestions(ctx, i - start, false) : [];
    },
  },
  {
    name: 'give', usage: '/give [玩家] <物品> [数量]', desc: '给予物品（英文 ID 或中文名，例如 /give 钻石镐）',
    run(ctx) {
      const i = skipTarget(ctx, 1);
      const tok = ctx.tokens[i]?.text;
      if (!tok) throw new CommandError('缺少参数：物品', i);
      const id = resolveItem(tok);
      if (id == null || id === 0) {
        const hint = similarNames(tok, /[^\x00-\x7f]/.test(tok) ? itemZhKeys() : itemNameKeys());
        throw new CommandError(`未知的物品：“${tok}”${hint.length ? `（你是不是想找：${hint.join('、')}）` : ''}`, i);
      }
      const countTok = ctx.tokens[i + 1]?.text;
      const count = countTok === undefined ? 1 : parseIntToken(countTok, i + 1, 1, MAX_GIVE);
      giveToPlayer(ctx, id, count);
      ctx.say(`已将 ${count} 个${itemLabel(id)}给予${playerName(ctx.game)}`);
    },
    complete(i, ctx) {
      const start = isSelector(ctx.tokens[1]?.text) ? 1 : 0;
      if (i === start) return i === 0 ? ['@s', ...itemNameKeys()] : itemNameKeys();
      if (i === start + 1) return ['1', '16', '64'];
      return [];
    },
  },
  {
    name: 'clear', usage: '/clear [玩家] [物品] [最大数量]', desc: '清除物品栏中的物品',
    run(ctx) {
      const player = requirePlayer(ctx);
      const inv = player.inventory;
      const i = skipTarget(ctx, 1);
      const tok = ctx.tokens[i]?.text;
      let id = null;
      if (tok !== undefined) {
        id = resolveItem(tok);
        if (id == null) throw new CommandError(`未知的物品：“${tok}”`, i);
      }
      const maxTok = ctx.tokens[i + 1]?.text;
      const max = maxTok === undefined ? Infinity : parseIntToken(maxTok, i + 1, 0, 1e9);
      let found = 0;
      for (let s = 0; s < inv.size; s++) {
        const st = inv.get(s);
        if (st && (id == null || st.id === id)) found += st.count;
      }
      if (max === 0) {
        if (!found) throw new CommandError(`在${playerName(ctx.game)}的物品栏中找不到匹配的物品`);
        ctx.say(`在${playerName(ctx.game)}的物品栏中找到了 ${found} 个匹配的物品`);
        return;
      }
      let removed = 0;
      for (let s = inv.size - 1; s >= 0 && removed < max; s--) {
        const st = inv.get(s);
        if (!st || (id != null && st.id !== id)) continue;
        const n = Math.min(st.count, max - removed);
        inv.set(s, st.count - n > 0 ? { id: st.id, count: st.count - n, damage: st.damage ?? 0 } : null);
        removed += n;
      }
      if (!removed) throw new CommandError(`在${playerName(ctx.game)}的物品栏中找不到物品`);
      ctx.say(`已从${playerName(ctx.game)}的物品栏中移除 ${removed} 个物品`);
    },
    complete(i, ctx) {
      const start = isSelector(ctx.tokens[1]?.text) ? 1 : 0;
      if (i === start) return i === 0 ? ['@s', ...itemNameKeys()] : itemNameKeys();
      return [];
    },
  },
  {
    name: 'kill', usage: '/kill [目标]', desc: '杀死玩家或实体（@e 为所有生物，@e[type=zombie] 为某种生物）',
    run(ctx) {
      const tok = ctx.tokens[1]?.text;
      if (ctx.tokens.length > 2) throw new CommandError('多余的参数', 2);
      if (tok === undefined || isPlayerTarget(tok, ctx.game)) {
        killPlayer(ctx);
        ctx.say(`已杀死${playerName(ctx.game)}`);
        return;
      }
      if (!tok.startsWith('@e')) throw new CommandError('未找到实体', 1);
      const sel = parseSelector(tok, 1);
      const targets = selectEntities(ctx, sel);
      if (!targets.length) throw new CommandError('未找到实体');
      const name = entityName(targets[0], ctx.game);
      for (const e of targets) killEntity(ctx, e);
      ctx.say(targets.length === 1 ? `已杀死${name}` : `已杀死${targets.length}个实体`);
    },
    complete(i) {
      return i === 0 ? ['@s', '@e', ...SELECTOR_TYPES.map((t) => `@e[type=${t}]`)] : [];
    },
  },
  {
    name: 'summon', usage: '/summon <实体> [x y z]',
    desc: `在指定位置召唤一个生物（${SUMMONABLE.join(' ')}）`,
    run(ctx) {
      const tok = ctx.tokens[1]?.text;
      if (!tok) throw new CommandError('缺少参数：实体类型', 1);
      const type = resolveMobType(tok);
      if (!type) throw new CommandError(`未知的实体：“${tok}”（可召唤：${SUMMONABLE.join('、')}）`, 1);
      const world = requireWorld(ctx);
      let pos;
      if (ctx.tokens.length > 2) {
        pos = parsePosition(ctx, 2);
        if (ctx.tokens.length > 5) throw new CommandError('多余的参数（WebCraft 不支持 NBT 数据）', 5);
      } else {
        const p = requirePlayer(ctx);
        pos = [p.x, p.y, p.z];
      }
      const [x, y, z] = pos;
      if (!(y >= 0 && y < WORLD_HEIGHT)) throw new CommandError('无效的召唤位置', ctx.tokens.length > 2 ? 3 : -1);
      if (typeof world.isChunkGenerated === 'function' && !world.isChunkGenerated(Math.floor(x) >> 4, Math.floor(z) >> 4)) {
        throw new CommandError('该位置尚未加载');
      }
      if (HOSTILE_MOBS.has(type) && getDifficulty(ctx.game) === 'peaceful') {
        throw new CommandError('无法召唤实体：和平难度下不能生成敌对生物');
      }
      const game = ctx.game;
      const finish = (mob) => {
        if (!mob) throw new CommandError('无法召唤实体');
        ctx.say(`已召唤新的${MOB_NAMES.get(type)}`);
      };
      // Minecraft: summoned mobs are not persistent (they may despawn like natural ones).
      if (typeof game.spawnMob === 'function') return finish(game.spawnMob(type, x, y, z, { persistent: false }));
      if (!game.entities) throw new CommandError('无法召唤实体：实体系统尚未就绪');
      if (mobsModule && typeof mobsModule.spawnMob === 'function') {
        return finish(mobsModule.spawnMob(game, type, x, y, z, { persistent: false }));
      }
      return loadMobsModule().then((m) => {
        if (!m || typeof m.spawnMob !== 'function') throw new CommandError('无法召唤实体：生物模块不可用');
        if (game.world !== world) throw new CommandError('无法召唤实体：世界已经关闭');
        return finish(m.spawnMob(game, type, x, y, z, { persistent: false }));
      });
    },
    complete(i, ctx) {
      if (i === 0) return SUMMONABLE.slice();
      return i <= 3 ? coordSuggestions(ctx, i - 1, false) : [];
    },
    completeZh(i) {
      return i === 0 ? [...MOB_NAMES.values()] : [];
    },
  },
  {
    name: 'difficulty', usage: '/difficulty [peaceful|easy|normal|hard]', desc: '查询或设置难度（和平 / 简单 / 普通 / 困难）',
    run(ctx) {
      const tok = ctx.tokens[1]?.text;
      const cur = getDifficulty(ctx.game);
      if (tok === undefined) {
        ctx.say(`难度为${DIFFICULTY_NAMES[cur]}`);
        return;
      }
      const d = DIFFICULTY_ALIASES[tok.toLowerCase()];
      if (!d) throw new CommandError(`未知的难度：“${tok}”（peaceful、easy、normal 或 hard）`, 1);
      if (d === cur) throw new CommandError(`难度未被改变，它已经是${DIFFICULTY_NAMES[d]}`);
      setDifficulty(ctx.game, d);
      ctx.say(`难度已被设置为${DIFFICULTY_NAMES[d]}`);
    },
    complete(i) {
      return i === 0 ? DIFFICULTIES.slice() : [];
    },
    completeZh(i) {
      return i === 0 ? Object.values(DIFFICULTY_NAMES) : [];
    },
  },
  {
    name: 'seed', usage: '/seed', desc: '显示世界种子',
    run(ctx) {
      const meta = ctx.game.worldMeta;
      const seed = meta?.seed ?? ctx.world?.seed;
      if (seed === undefined || seed === null) throw new CommandError('当前没有加载世界');
      const extra = meta?.seedText && String(meta.seedText) !== String(seed) ? ` §7（由文本“${meta.seedText}”生成）` : '';
      ctx.say(`种子：[§a${seed}§f]${extra}`);
    },
  },
  {
    name: 'spawnpoint', usage: '/spawnpoint [玩家] [x y z]', desc: '设置玩家的重生点（默认为当前位置）',
    run(ctx) {
      const player = requirePlayer(ctx);
      const i = skipTarget(ctx, 1);
      const [x, y, z] = ctx.tokens.length > i
        ? parsePosition(ctx, i, { block: true })
        : [Math.floor(player.x), Math.floor(player.y), Math.floor(player.z)];
      // forced: a personal respawn position used exactly (when its feet / head cells are free), like
      // Minecraft's /spawnpoint — not snapped to the top of the column like the world spawn.
      player.spawnPoint = { x: x + 0.5, y, z: z + 0.5, forced: true };
      ctx.say(`已将${playerName(ctx.game)}的重生点设置为 ${x}, ${y}, ${z}`);
    },
    complete(i, ctx) {
      const start = isSelector(ctx.tokens[1]?.text) ? 1 : 0;
      if (i === 0) return ['@s', ...coordSuggestions(ctx, 0, true)];
      return i - start < 3 ? coordSuggestions(ctx, i - start, true) : [];
    },
  },
  {
    name: 'setworldspawn', usage: '/setworldspawn [x y z]', desc: '设置世界出生点',
    run(ctx) {
      const player = requirePlayer(ctx);
      const [x, y, z] = ctx.tokens.length > 1
        ? parsePosition(ctx, 1, { block: true })
        : [Math.floor(player.x), Math.floor(player.y), Math.floor(player.z)];
      const meta = ctx.game.worldMeta;
      const old = meta?.spawn;
      const spawn = { x: x + 0.5, y, z: z + 0.5 };
      if (meta) meta.spawn = spawn;
      // Players without a personal spawn point (/spawnpoint) follow the world spawn.
      const sp = player.spawnPoint;
      const follows = !sp || sp.forced === false ||
        (sp.forced !== true && old && sp.x === old.x && sp.y === old.y && sp.z === old.z);
      if (follows) player.spawnPoint = { ...spawn, forced: false };
      ctx.say(`已将世界出生点设置为 ${x}, ${y}, ${z}`);
    },
    complete(i, ctx) {
      return i < 3 ? coordSuggestions(ctx, i, true) : [];
    },
  },
  {
    name: 'setblock', usage: '/setblock <x> <y> <z> <方块> [replace|keep|destroy]', desc: '将指定位置更改为某个方块',
    run(ctx) {
      const world = requireWorld(ctx);
      const [x, y, z] = parsePosition(ctx, 1, { block: true });
      const tok = ctx.tokens[4]?.text;
      if (!tok) throw new CommandError('缺少参数：方块', 4);
      const id = resolveBlock(tok);
      if (id == null) throw new CommandError(`未知的方块：“${tok}”`, 4);
      const mode = (ctx.tokens[5]?.text ?? 'replace').toLowerCase();
      if (!SETBLOCK_MODES.includes(mode)) throw new CommandError(`未知的模式：“${ctx.tokens[5].text}”`, 5);
      if (y < 0 || y >= WORLD_HEIGHT) throw new CommandError(`该位置超出了世界的限制（y 必须在 0 到 ${WORLD_HEIGHT - 1} 之间）`, 2);
      const old = world.getBlock(x, y, z);
      if (old === id || (mode === 'keep' && old !== 0)) throw new CommandError('无法放置方块');
      if (mode === 'destroy') dropBlockItems(ctx, old, x, y, z);
      else clearContainer(ctx, old, x, y, z);
      if (!world.setBlock(x, y, z, id)) throw new CommandError('该位置尚未加载');
      ctx.say(`已更改位于 ${x}, ${y}, ${z} 的方块`);
    },
    complete(i, ctx) {
      if (i < 3) return coordSuggestions(ctx, i, true);
      if (i === 3) return blockNameKeys();
      if (i === 4) return SETBLOCK_MODES;
      return [];
    },
  },
  {
    name: 'fill', usage: '/fill <x1> <y1> <z1> <x2> <y2> <z2> <方块> [replace|destroy|keep|hollow|outline] [被替换的方块]',
    desc: `用方块填充一个区域（最多 ${FILL_LIMIT} 个方块）`,
    run(ctx) {
      const world = requireWorld(ctx);
      const a = parsePosition(ctx, 1, { block: true });
      const b = parsePosition(ctx, 4, { block: true });
      const tok = ctx.tokens[7]?.text;
      if (!tok) throw new CommandError('缺少参数：方块', 7);
      const id = resolveBlock(tok);
      if (id == null) throw new CommandError(`未知的方块：“${tok}”`, 7);
      const mode = (ctx.tokens[8]?.text ?? 'replace').toLowerCase();
      if (!FILL_MODES.includes(mode)) throw new CommandError(`未知的填充模式：“${ctx.tokens[8].text}”`, 8);
      let filter = null;
      if (ctx.tokens[9]) {
        if (mode !== 'replace') throw new CommandError('只有 replace 模式可以指定被替换的方块', 9);
        filter = resolveBlock(ctx.tokens[9].text);
        if (filter == null) throw new CommandError(`未知的方块：“${ctx.tokens[9].text}”`, 9);
      }
      const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]);
      const y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1]);
      const z0 = Math.min(a[2], b[2]), z1 = Math.max(a[2], b[2]);
      const volume = (x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1);
      if (volume > FILL_LIMIT) throw new CommandError(`指定区域内的方块太多（最大值为 ${FILL_LIMIT}，指定值为 ${volume}）`);
      if (y0 < 0 || y1 >= WORLD_HEIGHT) throw new CommandError(`该区域超出了世界的限制（y 必须在 0 到 ${WORLD_HEIGHT - 1} 之间）`);
      if (typeof world.isChunkGenerated === 'function') {
        for (let cx = x0 >> 4; cx <= x1 >> 4; cx++) {
          for (let cz = z0 >> 4; cz <= z1 >> 4; cz++) {
            if (!world.isChunkGenerated(cx, cz)) throw new CommandError('该区域尚未加载');
          }
        }
      }
      let changed = 0;
      for (let y = y0; y <= y1; y++) {
        for (let z = z0; z <= z1; z++) {
          for (let x = x0; x <= x1; x++) {
            const edge = x === x0 || x === x1 || y === y0 || y === y1 || z === z0 || z === z1;
            let target = id;
            if (mode === 'outline' && !edge) continue;
            if (mode === 'hollow' && !edge) target = 0;
            const old = world.getBlock(x, y, z);
            if (mode === 'keep' && old !== 0) continue;
            if (filter !== null && old !== filter) continue;
            if (old === target) continue;
            if (mode === 'destroy') dropBlockItems(ctx, old, x, y, z);
            else clearContainer(ctx, old, x, y, z);
            if (world.setBlock(x, y, z, target)) changed++;
          }
        }
      }
      if (!changed) throw new CommandError('没有方块被填充');
      ctx.say(`成功填充了 ${changed} 个方块`);
    },
    complete(i, ctx) {
      if (i < 3) return coordSuggestions(ctx, i, true);
      if (i < 6) return coordSuggestions(ctx, i - 3, true);
      if (i === 6 || i === 8) return blockNameKeys();
      if (i === 7) return FILL_MODES;
      return [];
    },
  },
  {
    name: 'say', usage: '/say <消息>', desc: '在聊天栏中广播一条消息',
    run(ctx) {
      const msg = ctx.rest(1);
      if (!msg) throw new CommandError('缺少参数：消息', 1);
      ctx.say(`[${playerName(ctx.game)}] ${msg}`);
    },
  },
  {
    name: 'me', usage: '/me <动作>', desc: '显示一条关于自己的动作消息',
    run(ctx) {
      const msg = ctx.rest(1);
      if (!msg) throw new CommandError('缺少参数：动作', 1);
      ctx.say(`* ${playerName(ctx.game)} ${msg}`);
    },
  },
];

function findCommand(name) {
  const n = String(name).toLowerCase();
  return COMMANDS.find((c) => c.name === n || c.aliases?.includes(n)) ?? null;
}

function blockNameKeys() {
  return BLOCKS.filter((b) => !b.hidden || b.id === 0).map((b) => b.name);
}

/** Coordinate suggestion for argument `k` (0..2) of a triple: targeted block or "~". */
function coordSuggestions(ctx, k, block) {
  const t = ctx.game.interaction?.target;
  const parts = t && block ? [String(t.x), String(t.y), String(t.z)] : ['~', '~', '~'];
  return [parts.slice(k).join(' ')];
}

/** Public command list (name, usage, description) — e.g. for a help screen. */
export const COMMAND_LIST = Object.freeze(COMMANDS.map((c) => Object.freeze({
  name: c.name, aliases: c.aliases ?? [], usage: c.usage, desc: c.desc,
})));

function makeContext(game, body) {
  const tokens = tokenize(body);
  return {
    game,
    player: game.player ?? null,
    world: game.world ?? null,
    tokens,
    body,
    rest(i) {
      return tokens[i] ? body.slice(tokens[i].start).trim() : '';
    },
    say(text, color) {
      if (typeof game.addChatMessage === 'function') game.addChatMessage(text, color);
    },
  };
}

/** Build the Minecraft-style error context line: "...input<--[这里]". */
function errorContext(body, tokens, tokenIndex) {
  const full = '/' + body;
  let start, end;
  if (tokenIndex >= 0 && tokenIndex < tokens.length) {
    start = tokens[tokenIndex].start + 1;
    end = tokens[tokenIndex].end + 1;
  } else {
    start = end = full.length;
  }
  const before = full.slice(Math.max(0, start - 10), start);
  const bad = full.slice(start, end);
  return `§7${start > 10 ? '…' : ''}${before}§c§n${bad}§r§c§o<--[这里]`;
}

/**
 * Execute a chat command. `text` may start with "/" (it is stripped). Never throws. Commands that
 * finish asynchronously (the first /summon loads mobs.js) make it return a Promise that resolves when
 * the command is done (and never rejects); otherwise it returns undefined.
 * @param {object} game  needs addChatMessage; uses player, world, worldMeta, entities, settings,
 *                       setGameMode, setTime, applySettings, spawnItem, dropFromPlayer, interaction
 *                       when available (and an optional game.spawnMob(type, x, y, z, opts) facade)
 * @param {string} text
 * @returns {undefined|Promise<void>}
 */
export function runCommand(game, text) {
  const body = String(text ?? '').replace(/^\s*\//, '').trim();
  const say = (t, c) => {
    if (typeof game.addChatMessage === 'function') game.addChatMessage(t, c);
  };
  if (!body) {
    say('未知的命令。输入 /help 查看命令列表', ERROR_COLOR);
    return undefined;
  }
  const ctx = makeContext(game, body);
  const name = ctx.tokens[0].text;
  const cmd = findCommand(name);
  if (!cmd) {
    say(`未知的命令：“/${name}”。输入 /help 查看命令列表`, ERROR_COLOR);
    say(errorContext(body, ctx.tokens, 0));
    return undefined;
  }
  const report = (err) => {
    if (err instanceof CommandError) {
      say(err.message, ERROR_COLOR);
      if (err.tokenIndex >= 0) say(errorContext(body, ctx.tokens, err.tokenIndex));
    } else {
      say(`执行命令时出现意外错误：${err?.message ?? err}`, ERROR_COLOR);
      if (typeof console !== 'undefined') console.warn('[commands]', err);
    }
  };
  try {
    const r = cmd.run(ctx);
    if (r && typeof r.then === 'function') return r.then(() => undefined, report);
  } catch (err) {
    report(err);
  }
  return undefined;
}

/**
 * Tab-completion candidates for the token under the end of `text`.
 * @returns {{ start: number, end: number, options: string[], usage: string|null } | null}
 *   replace text.slice(start, end) with one of `options`.
 */
export function getCompletions(game, text) {
  if (typeof text !== 'string' || !text.startsWith('/')) return null;
  const body = text.slice(1);
  const ctx = makeContext(game, body);
  const toks = ctx.tokens;
  const trailingSpace = body.length === 0 || /\s$/.test(body);
  const argPos = trailingSpace ? toks.length : toks.length - 1; // 0 = command name
  const partial = trailingSpace ? '' : toks[toks.length - 1].text;
  const start = trailingSpace ? text.length : toks[toks.length - 1].start + 1;
  let options;
  let usage = null;
  let cmd = null;
  if (argPos === 0) {
    options = COMMANDS.map((c) => c.name);
  } else {
    cmd = findCommand(toks[0].text);
    if (!cmd) return { start, end: text.length, options: [], usage: null };
    usage = cmd.usage;
    options = cmd.complete ? cmd.complete(argPos - 1, ctx) : [];
  }
  const p = partial.toLowerCase();
  let filtered;
  if (/[^\x00-\x7f]/.test(partial)) {
    // Chinese input: the command's Chinese candidates (mob / difficulty names), else item / block names.
    const zh = cmd?.completeZh ? cmd.completeZh(argPos - 1, ctx) : null;
    filtered = [...new Set(zh ?? [...itemZhKeys(), ...BLOCKS.filter((b) => !b.hidden).map((b) => b.displayName)])]
      .filter((n) => n.includes(partial));
  } else {
    const head = options.filter((o) => o.toLowerCase().startsWith(p));
    const inner = p.length >= 2 ? options.filter((o) => !o.toLowerCase().startsWith(p) && o.toLowerCase().includes(p)) : [];
    filtered = head.concat(inner);
  }
  filtered = [...new Set(filtered)].filter((o) => o !== partial || filtered.length > 1).slice(0, 60);
  return { start, end: text.length, options: filtered, usage };
}
