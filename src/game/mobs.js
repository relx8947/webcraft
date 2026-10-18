// Mobs (docs/SPEC-wave2.md §3): the 8 Minecraft mobs (pig, cow, sheep, chicken, zombie, skeleton, creeper,
// spider) with Minecraft Java numbers, the Mob entity (physics, AI, combat, burning, drops, persistence), the
// MobSpawner (initial animals on chunk generation, passive and hostile spawning by light level, caps,
// despawning, difficulty) and spawnMob(). Arrows live in entities.js (EntityManager.spawnArrow) and are
// re-exported here. Pure logic (runs in Node with a fake world / game).
//
// Units: positions in blocks, velocities in blocks/s, times in seconds. Minecraft's per-tick rules are run on
// a 20 Hz AI tick; movement is integrated per frame with the same continuous model as the player:
//   ground  dv/dt = K·(vmax − v), K = −20·ln(slip·0.91), vmax = 20·(s·m)²·(0.216/slip³)/(1 − slip·0.91)
//   air     K = −20·ln 0.91, vmax = 20·0.02·s·m/0.09          water K = −20·ln 0.8, vmax = 20·0.02·s·m/0.2
//   vertical: gravity 0.08 b/tick², drag 0.98 (terminal 78.4 b/s), jump 0.42 b/tick (1.25 blocks)
// with s = the movement-speed attribute and m the goal's speed modifier (Minecraft MoveControl / travel()).
import {
  Entity, Arrow, registerEntityType, createModelRenderItem, liquidSurface, fluidFlow, scaleMobDamage,
} from './entities.js';
import { makeStack } from './inventory.js';
import { playersOf, nearestPlayer } from './players.js';
import { aabbIntersectsSolid, PhysicsBody } from './physics.js';
import * as audioModule from './audio.js';
import {
  BLOCKS, BLOCK, ITEM, IS_OPAQUE, LIQUID_KIND, getCollisionBox, maxDurability,
} from '../world/registry.js';
import { PLAYER } from '../config.js';
import {
  pathFinder, lineOfSight, rawBrightness, brightnessOf, randomWalkTarget, shadePosition, groundNear, passable,
} from './mobai.js';

export { Arrow };

const TICKS = 20;
const TICK = 1 / TICKS;
const DEG = Math.PI / 180;
const TAU = Math.PI * 2;
const DZ = -0;                       // double-field initialiser (see entities.js)
const MAX_STEP = 1 / TICKS;          // physics sub-step

// ---- Minecraft movement constants (see the header)
const K_GRAVITY = -TICKS * Math.log(0.98);
const TERMINAL = TICKS * 0.08 * 0.98 / 0.02;              // 78.4 b/s
const JUMP_VELOCITY = 9.2474;                              // 1.25-block jump (same as the player)
const K_AIR = -TICKS * Math.log(0.91);
const K_WATER = -TICKS * Math.log(0.8);
const K_LAVA = -TICKS * Math.log(0.5);
const WATER_SINK = 0.5;                                    // idle sinking speed in water (b/s)
const WATER_RISE = 2.4;                                    // FloatGoal: jumping in water rises ~2.4 b/s
const CLIMB_SPEED = 0.2 * TICKS;                           // spiders: 0.2 b/tick up a wall
const CLIMB_MAX_FALL = 0.15 * TICKS;
const JUMP_COOLDOWN = 10 * TICK;                           // noJumpDelay
const VOID_Y = -64;

// ---- combat / status
const HURT_TIME = 10 * TICK;                               // red flash
const INVULNERABLE_TIME = 20 * TICK;                       // only bigger hits override in the first half
const DEATH_TIME = 20 * TICK;                              // tip-over, then poof
const KNOCKBACK = 0.4 * TICKS;                             // b/s (0.4 b/tick)
const KNOCKBACK_LIFT = 0.4 * TICKS;
const SWING_TIME = 6 * TICK;
const MAX_AIR = 300;                                       // ticks of breath
const HEAD_LIMIT = 75 * DEG;                               // max head yaw relative to the body

// ---- spawning / despawning (Minecraft NaturalSpawner, Mob.checkDespawn)
export const DESPAWN_FAR = 128;
export const DESPAWN_NEAR = 32;
const DESPAWN_IDLE = 30;                                   // s (600 ticks) before random despawning
const DESPAWN_CHANCE = 1 / 800;                            // per tick

/** Difficulty ids (Minecraft Difficulty.getId). */
const DIFFICULTY_ID = { peaceful: 0, easy: 1, normal: 2, hard: 3 };

/** Allocation budget of the path finder: path searches per second (shared by every mob). */
export const pathBudget = { perSecond: 40, burst: 3, tokens: 3, last: -1 };

function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function takePathToken() {
  const b = pathBudget;
  if (!Number.isFinite(b.perSecond)) return true;
  const t = now();
  if (b.last < 0) b.last = t;
  b.tokens = Math.min(b.burst, b.tokens + (t - b.last) * b.perSecond / 1000);
  b.last = t;
  if (b.tokens >= 1) {
    b.tokens -= 1;
    return true;
  }
  return false;
}

function finite(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function wrapAngle(a) {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

/** Rotate `a` toward `b` by at most `max` radians. */
function approachAngle(a, b, max) {
  const d = wrapAngle(b - a);
  if (d > max) return a + max;
  if (d < -max) return a - max;
  return b;
}

/** SPEC yaw (0 = north, +π/2 = west) of the direction (dx, dz). */
/** Filters for nearestPlayer (module functions: no closure per AI tick). */
let _temptItems = null;
function holdsTemptItem(p) {
  if (p.dead || _temptItems === null) return false;
  const stack = typeof p.getSelectedStack === 'function' ? p.getSelectedStack() : null;
  return !!stack && _temptItems.includes(stack.id);
}
function isAlive(p) {
  return !p.dead;
}

/** A player hostile mobs may target: alive, survival (not creative / spectator), with a position. */
function isTargetable(p) {
  return !!p && !p.dead && p.mode !== 'creative' && p.mode !== 'spectator' && finite(p.x);
}

function yawOf(dx, dz) {
  return Math.atan2(-dx, -dz);
}

function gaussian(rnd) {
  let u = 0, v = 0;
  while (u === 0) u = rnd();
  while (v === 0) v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v);
}

// ===================================================================================================
// Mob types
// ===================================================================================================

/**
 * Mob definitions (SPEC-wave2 §3.1, Minecraft Java attributes). speed = movement-speed attribute (walk speed
 * in b/s = 20·speed²/0.454 on normal ground); drops: [{ item, min, max, chance, cooked, player, rare }]
 * (`cooked` = item when the mob dies burning, `player` = only when killed by a player).
 */
export const MOB_TYPES = Object.freeze({
  pig: {
    name: '猪', hostile: false, width: 0.9, height: 0.9, eyeHeight: 0.765, health: 10, speed: 0.25, panic: 1.25,
    shadow: 0.7, ai: 'passive', model: 'pig', look: 6,
    drops: [{ item: 'porkchop', min: 1, max: 3, cooked: 'cooked_porkchop' }],
    sounds: { ambient: 'pig', hurt: 'pig_hurt', death: 'pig_death', step: null },
  },
  cow: {
    name: '牛', hostile: false, width: 0.9, height: 1.4, eyeHeight: 1.3, health: 10, speed: 0.2, panic: 2.0,
    shadow: 0.7, ai: 'passive', model: 'cow', look: 6,
    drops: [{ item: 'beef', min: 1, max: 3, cooked: 'cooked_beef' }, { item: 'leather', min: 0, max: 2 }],
    sounds: { ambient: 'cow', hurt: 'cow_hurt', death: 'cow_death', step: null },
  },
  sheep: {
    name: '羊', hostile: false, width: 0.9, height: 1.3, eyeHeight: 1.235, health: 8, speed: 0.23, panic: 1.25,
    shadow: 0.7, ai: 'passive', model: 'sheep', look: 6,
    drops: [{ item: 'white_wool', min: 1, max: 1, wool: true }, { item: 'mutton', min: 1, max: 2, cooked: 'cooked_mutton' }],
    sounds: { ambient: 'sheep', hurt: 'sheep_hurt', death: 'sheep_death', step: null },
  },
  chicken: {
    name: '鸡', hostile: false, width: 0.4, height: 0.7, eyeHeight: 0.644, health: 4, speed: 0.25, panic: 1.4,
    shadow: 0.3, ai: 'passive', model: 'chicken', look: 6, slowFall: true,
    drops: [{ item: 'feather', min: 0, max: 2 }, { item: 'chicken', min: 1, max: 1, cooked: 'cooked_chicken' }],
    sounds: { ambient: 'chicken', hurt: 'chicken_hurt', death: 'chicken_death', step: null },
  },
  zombie: {
    name: '僵尸', hostile: true, width: 0.6, height: 1.95, eyeHeight: 1.74, health: 20, speed: 0.23, chase: 1.15,
    shadow: 0.5, ai: 'zombie', model: 'zombie', look: 8, undead: true, attack: 3, followRange: 35,
    drops: [{ item: 'rotten_flesh', min: 0, max: 2 }, { item: 'iron_ingot', min: 1, max: 1, chance: 0.025 / 3, player: true }],
    sounds: { ambient: 'zombie', hurt: 'zombie_hurt', death: 'zombie_death', step: 'zombie_step' },
  },
  skeleton: {
    name: '骷髅', hostile: true, width: 0.6, height: 1.99, eyeHeight: 1.74, health: 20, speed: 0.25, chase: 1.0,
    shadow: 0.5, ai: 'skeleton', model: 'skeleton', look: 8, undead: true, followRange: 16,
    drops: [{ item: 'bone', min: 0, max: 2 }, { item: 'arrow', min: 0, max: 2 }],
    sounds: { ambient: 'skeleton', hurt: 'skeleton_hurt', death: 'skeleton_death', step: 'skeleton_step' },
  },
  creeper: {
    name: '苦力怕', hostile: true, width: 0.6, height: 1.7, eyeHeight: 1.445, health: 20, speed: 0.25, chase: 1.0,
    shadow: 0.5, ai: 'creeper', model: 'creeper', look: 8, followRange: 16,
    drops: [{ item: 'gunpowder', min: 0, max: 2 }],
    sounds: { ambient: null, hurt: 'creeper_hurt', death: 'creeper_death', step: null },
  },
  spider: {
    name: '蜘蛛', hostile: true, width: 1.4, height: 0.9, eyeHeight: 0.65, health: 16, speed: 0.3, chase: 1.0,
    shadow: 0.8, ai: 'spider', model: 'spider', look: 8, climbs: true, attack: 2, followRange: 16,
    drops: [{ item: 'string', min: 0, max: 2 }, { item: 'spider_eye', min: 0, max: 1, chance: 1 / 3, player: true }],
    sounds: { ambient: 'spider', hurt: 'spider_hurt', death: 'spider_death', step: 'spider_step' },
  },
});

/** Every mob type key. */
export const MOB_TYPE_KEYS = Object.freeze(Object.keys(MOB_TYPES));

/** Ground friction by block id (Minecraft slipperiness / "friction"). */
const SLIP = new Float64Array(256).fill(0.6);
for (const bl of BLOCKS) if (bl) SLIP[bl.id] = bl.slipperiness ?? 0.6;

/**
 * Natural fleece colours (Sheep.getRandomSheepColor): [wool colour, chance in %, render tint] with the tint of
 * Sheep.createSheepColor (white 0.902, others the dye colour · 0.75), packed r | g << 8 | b << 16.
 */
const FLEECE = Object.freeze([
  ['white', 81.836, 0xe6e6e6], ['black', 5, 0x191616], ['gray', 5, 0x3d3b35], ['light_gray', 5, 0x717676],
  ['brown', 3, 0x253f62], ['pink', 0.164, 0x7f68b6],
].map(([color, chance, tint]) => Object.freeze({ color, chance, tint, wool: BLOCK[`${color.toUpperCase()}_WOOL`] ?? BLOCK.WHITE_WOOL })));

/** Index into FLEECE of a random natural fleece colour. */
function randomFleece(rnd) {
  let r = rnd() * 100;
  for (let i = 0; i < FLEECE.length; i++) {
    r -= FLEECE[i].chance;
    if (r < 0) return i;
  }
  return 0;
}

/** TemptGoal items: animals follow a player holding them (cows / sheep: wheat, chickens: seeds). */
const TEMPT = Object.freeze({ cow: [ITEM.WHEAT], sheep: [ITEM.WHEAT], chicken: [ITEM.WHEAT_SEEDS] });
const PASSIVE_TYPES = Object.freeze(['pig', 'cow', 'sheep', 'chicken']);
const PASSIVE_WEIGHTS = Object.freeze([10, 8, 12, 10]);
const HOSTILE_TYPES = Object.freeze(['zombie', 'skeleton', 'creeper', 'spider']);

// resolved item ids of the drops
for (const def of Object.values(MOB_TYPES)) {
  for (const d of def.drops) {
    d.id = ITEM[d.item.toUpperCase()] ?? 0;
    d.cookedId = d.cooked ? ITEM[d.cooked.toUpperCase()] ?? 0 : 0;
  }
  def.cells = Math.max(1, Math.ceil(def.height - 1e-6));
  Object.freeze(def);
}

/** Walk speed (b/s) on normal ground for a speed attribute × modifier (Minecraft terminal velocity). */
export function walkSpeed(speed, modifier = 1, slip = 0.6) {
  const sm = speed * modifier;
  return TICKS * sm * sm * (0.216 / (slip * slip * slip)) / (1 - slip * 0.91);
}

// ===================================================================================================
// Sounds (fall back to existing names when a specific sound is missing)
// ===================================================================================================

const SOUND_FALLBACKS = {
  pig_hurt: ['pig'], pig_death: ['pig_hurt', 'pig'], cow_hurt: ['cow'], cow_death: ['cow_hurt', 'cow'],
  sheep_hurt: ['sheep'], sheep_death: ['sheep_hurt', 'sheep'], chicken_hurt: ['chicken'],
  chicken_death: ['chicken_hurt', 'chicken'], zombie_death: ['zombie_hurt'], skeleton: [],
  skeleton_hurt: ['zombie_hurt'], skeleton_death: ['death'], creeper_hurt: ['hurt'], creeper_death: ['death'],
  spider: [], spider_hurt: ['hurt'], spider_death: ['death'], creeper_hiss: ['fuse'], arrow_hit: [],
  bow_shoot: ['bow'], mob_death: ['poof'],
};
const _soundCache = new Map();

/** The sound name to play for `name` (itself, an alias known to audio.js, or a fallback), or null. */
export function mobSound(name) {
  if (!name) return null;
  let r = _soundCache.get(name);
  if (r !== undefined) return r;
  const resolve = typeof audioModule.resolveSoundName === 'function' ? audioModule.resolveSoundName
    : (n) => (Array.isArray(audioModule.SOUND_NAMES) && audioModule.SOUND_NAMES.includes(n) ? n : null);
  r = resolve(name) ? name : null;
  if (!r) for (const alt of SOUND_FALLBACKS[name] ?? []) if (resolve(alt)) { r = alt; break; }
  _soundCache.set(name, r);
  return r;
}

function playSound(game, name, x, y, z, volume = 1, pitch = 1) {
  const s = mobSound(name);
  if (s) game?.audio?.play?.(s, { x, y, z, volume, pitch });
  return s !== null;
}

// ===================================================================================================
// MobBody: PhysicsBody.move without boxed arguments
// ===================================================================================================

const BODY_EPS = 1e-7;

/**
 * A PhysicsBody whose per-frame move reads the displacement from its own velocity (`moveFor(world, h)` = move by
 * v·h). Same axis-separated collision as PhysicsBody.move (Y, then X, then Z, collision boxes of every touched
 * cell) but without fractional call arguments, which V8 has to box (allocate) for every non-inlined call —
 * mobs move every frame.
 */
class MobBody extends PhysicsBody {
  moveFor(world, h) {
    const dx = this.vx * h, dy = this.vy * h, dz = this.vz * h;
    const hw = this.width / 2;
    let minX = this.x - hw, minY = this.y, minZ = this.z - hw;
    let maxX = this.x + hw, maxY = this.y + this.height, maxZ = this.z + hw;
    // collect the collision boxes of every cell the swept box touches
    const x0 = Math.floor(dx < 0 ? minX + dx : minX), x1 = Math.floor(dx > 0 ? maxX + dx : maxX);
    const y0 = Math.max(0, Math.floor(dy < 0 ? minY + dy : minY)), y1 = Math.min(255, Math.floor(dy > 0 ? maxY + dy : maxY));
    const z0 = Math.floor(dz < 0 ? minZ + dz : minZ), z1 = Math.floor(dz > 0 ? maxZ + dz : maxZ);
    let n = 0;
    for (let y = y0; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          const box = getCollisionBox(world.getBlock(x, y, z));
          if (!box) continue;
          if (n + 6 > this._boxes.length) {
            const grown = new Float64Array(this._boxes.length * 2);
            grown.set(this._boxes);
            this._boxes = grown;
          }
          const bb = this._boxes;
          bb[n] = x + box[0]; bb[n + 1] = y + box[1]; bb[n + 2] = z + box[2];
          bb[n + 3] = x + box[3]; bb[n + 4] = y + box[4]; bb[n + 5] = z + box[5];
          n += 6;
        }
      }
    }
    const b = this._boxes;
    const E = BODY_EPS;
    let ady = dy;
    if (dy !== 0) {
      for (let i = 0; i < n; i += 6) {
        if (b[i + 3] <= minX + E || b[i] >= maxX - E || b[i + 5] <= minZ + E || b[i + 2] >= maxZ - E) continue;
        if (ady > 0 && b[i + 1] >= maxY - E) ady = Math.min(ady, b[i + 1] - maxY);
        else if (ady < 0 && b[i + 4] <= minY + E) ady = Math.max(ady, b[i + 4] - minY);
      }
      minY += ady; maxY += ady;
    }
    let adx = dx;
    if (dx !== 0) {
      for (let i = 0; i < n; i += 6) {
        if (b[i + 4] <= minY + E || b[i + 1] >= maxY - E || b[i + 5] <= minZ + E || b[i + 2] >= maxZ - E) continue;
        if (adx > 0 && b[i] >= maxX - E) adx = Math.min(adx, b[i] - maxX);
        else if (adx < 0 && b[i + 3] <= minX + E) adx = Math.max(adx, b[i + 3] - minX);
      }
      minX += adx; maxX += adx;
    }
    let adz = dz;
    if (dz !== 0) {
      for (let i = 0; i < n; i += 6) {
        if (b[i + 4] <= minY + E || b[i + 1] >= maxY - E || b[i + 3] <= minX + E || b[i] >= maxX - E) continue;
        if (adz > 0 && b[i + 2] >= maxZ - E) adz = Math.min(adz, b[i + 2] - maxZ);
        else if (adz < 0 && b[i + 5] <= minZ + E) adz = Math.max(adz, b[i + 5] - minZ);
      }
      minZ += adz; maxZ += adz;
    }
    this.collidedX = adx !== dx;
    this.collidedY = ady !== dy;
    this.collidedZ = adz !== dz;
    this.onGround = dy < 0 && this.collidedY;
    if (this.collidedX) this.vx = 0;
    if (this.collidedY) this.vy = 0;
    if (this.collidedZ) this.vz = 0;
    this.x = (minX + maxX) / 2;
    this.y = minY;
    this.z = (minZ + maxZ) / 2;
  }
}

// ===================================================================================================
// Mob
// ===================================================================================================

// movement modes
const MOVE_NONE = 0;
const MOVE_PATH = 1;
const MOVE_DIRECT = 2;
const MOVE_STRAFE = 3;

const PATH_MAX = 32;                 // waypoints kept per mob
const _flowDir = new Float64Array(3);
const _pos = new Int32Array(3);
const _away = [0, 0];

/**
 * A living mob (SPEC-wave2 §3.4): type 'mob', `mobType` key of MOB_TYPES. Health, Minecraft hurt / knockback /
 * death rules, fall / lava / fire / drowning damage, daylight burning (undead), the per-type AI and the model
 * render item.
 */
export class Mob extends Entity {
  /**
   * @param {string} mobType key of MOB_TYPES
   * @param {{ rng?: () => number, persistent?: boolean }} [opts]
   */
  constructor(mobType, opts = {}) {
    const def = MOB_TYPES[mobType];
    if (!def) throw new Error(`unknown mob type '${mobType}'`);
    super(def.width, def.height);
    this.body = new MobBody(def.width, def.height);
    this.type = 'mob';
    this.mobType = mobType;
    this.def = def;
    this.hostile = def.hostile;
    this.blocksBuilding = true;
    this.freezeUnmeshed = true;
    this.pushable = true;
    this.pickable = true;
    this.persistent = !!opts.persistent || !def.hostile;
    this.maxHealth = def.health;
    this.health = DZ;
    this.health = def.health;
    this.dead = false;
    this.shadowRadius = def.shadow;
    this.rnd = opts.rng ?? Math.random;
    // rotation (SPEC yaw convention), animation
    this.yaw = DZ;
    this.bodyYaw = DZ;
    this.headYaw = DZ;
    this.pitch = DZ;
    this.limbSwing = DZ;
    this.limbSwingAmount = DZ;
    this._lx = NaN; this._lz = NaN;
    this.attackAnim = DZ;            // s since the swing started (< 0: none)
    this.attackAnim = -1;
    // status
    this.hurtTime = DZ;
    this.deathTime = DZ;
    this.invulnerable = DZ;
    this.lastHurt = DZ;
    this.fireTime = DZ;
    this._fireTimer = DZ;
    this.air = DZ;                   // ticks of breath (fractional)
    this.air = MAX_AIR;
    this.fallDistance = DZ;
    this.waterDepth = DZ;
    this.lavaDepth = DZ;
    this.inWater = false;
    this.inLava = false;
    this.lastAttacker = null;
    this._attackerTime = DZ;         // s since the last hit by an attacker (revenge / panic memory)
    this._playerHurt = DZ;           // s since the player last hurt it (Minecraft lastHurtByPlayerTime: 5 s)
    this._playerHurt = 1e9;
    this.killedByPlayer = false;
    // equipment / appearance
    this.heldItem = 0;
    this.sheared = false;
    this.color = -1;               // fleece tint (packed rgb, -1 = default white)
    this.fleece = 0;               // index into FLEECE (sheep)
    // AI
    this._aiAcc = DZ;
    this._aiAcc = (this.id % 20) * TICK * 0.05;
    this._ticks = this.id % 20;      // staggers periodic checks between mobs
    this.target = null;
    this._canSee = false;
    this._sightOf = null;            // target of the cached line-of-sight result
    this._sightTick = 0;
    this._seeTime = 0;               // ticks with (+) / without (-) line of sight to the target
    this._unseen = 0;
    this.moveMode = MOVE_NONE;
    this.speedMod = DZ;
    this.speedMod = 1;
    this._goalX = DZ; this._goalY = DZ; this._goalZ = DZ;          // direct-steering target (blocks)
    this._goalCX = 0; this._goalCY = -999; this._goalCZ = 0;        // planned goal cell
    this._strafeF = DZ; this._strafeR = DZ;
    this.path = new Int32Array(PATH_MAX * 3);
    this.pathLen = 0;
    this.pathIndex = 0;
    this._repath = DZ;
    this._stuck = DZ;
    this._stuckX = DZ; this._stuckZ = DZ;
    this._wantJump = false;
    this._jumpCooldown = DZ;
    this._idle = DZ;                 // s until the next wander may start
    this._idle = 1 + this.rnd() * 5;
    this._panic = DZ;
    this._lookMode = 0;              // 0 none, 1 player, 2 random direction, 3 target
    this._lookLock = false;          // the AI drives the look this tick (tempted animals)
    this._lookPlayer = null;         // player looked at (look mode 1)
    this._temptedBy = null;          // nearest player holding the tempt item (set by _tempted)
    this._lookTimer = DZ;
    this._lookYaw = DZ;
    this._lookPitch = DZ;
    this._ambient = DZ;
    this._ambient = 8 + this.rnd() * 12;
    this._stepDist = DZ;
    this._frameDist = DZ;
    this._noAction = DZ;
    this._attackCooldown = DZ;
    this._raiseArm = 0;
    this.aggressive = false;
    // type specific
    this.swell = 0;                  // creeper: ticks 0..30
    this._oldSwell = 0;
    this._swellDir = -1;
    this._hiss = null;
    this.eatTicks = DZ;              // sheep: eating animation (ticks left)
    this.flap = DZ; this.flapSpeed = DZ; this._flapping = DZ;   // chicken
    this.useTicks = DZ;              // skeleton: bow drawing (ticks)
    this._attackTime = DZ;
    this._attackTime = -1;
    this._strafeTime = -1;
    this._strafeCW = false;
    this._strafeBack = false;
    this._climbing = false;
    this._collidedH = false;
    this._render = createModelRenderItem(def.model);
    this._render.shadowRadius = def.shadow;
    this.light = 0xf0;
  }

  get eyeHeight() { return this.def.eyeHeight; }

  /** Sheep fleece colour (index into the natural colours: 0 white, 1 black, 2 gray, 3 light gray, 4 brown, 5 pink). */
  setFleece(i) {
    const f = FLEECE[i] ?? FLEECE[0];
    this.fleece = FLEECE.indexOf(f);
    this.color = this.fleece === 0 ? -1 : f.tint;
    return this;
  }
  get alive() { return !this.dead && !this.removed; }
  /** Same as `dead` (interaction.js checks `dying` too). */
  get dying() { return this.dead; }

  // -------------------------------------------------------------------------------------------
  // Render item
  // -------------------------------------------------------------------------------------------

  getRenderItem() {
    const r = this._render;
    const b = this.body;
    r.x = b.x; r.y = b.y; r.z = b.z;
    r.bodyYaw = this.bodyYaw;
    r.headYaw = this.headYaw;
    r.headPitch = this.pitch;
    r.limbSwing = this.limbSwing;
    r.limbSwingAmount = this.dead ? 0 : this.limbSwingAmount;
    r.attack = this.attackAnim >= 0 ? Math.min(1, this.attackAnim / SWING_TIME) : 0;
    r.age = this.age;
    r.hurt = this.hurtTime > 0 || this.dead ? 1 : 0;
    r.death = this.dead ? Math.max(1e-3, this.deathTime) : 0;
    r.light = this.fireTime > 0 ? (this.light & 0xf0) | 15 : this.light;
    r.itemId = this.heldItem;
    r.shadowY = this.shadow.y;
    r.shadow = this.shadow.alpha;
    r.swell = this.swell > 0 || this._oldSwell > 0 ? this._swelling() : 0;
    r.onFire = this.fireTime > 0 ? 1 : 0;
    r.sheared = this.sheared;
    r.aggressive = this.aggressive;
    r.eat = this.eatTicks > 0 ? Math.max(0.001, this.eatTicks - Math.min(1, this._aiAcc * TICKS)) : 0;
    r.flap = (Math.sin(this.flap) + 1) * this.flapSpeed;
    r.useTime = this.useTicks;
    r.color = this.color;
    return r;
  }

  /** Creeper swelling 0..~1.07 (Creeper.getSwelling: lerp(oldSwell, swell, partial tick) / (maxSwell − 2)). */
  _swelling() {
    const t = Math.min(1, this._aiAcc * TICKS);
    return (this._oldSwell + (this.swell - this._oldSwell) * t) / 28;
  }

  // -------------------------------------------------------------------------------------------
  // Damage
  // -------------------------------------------------------------------------------------------

  /**
   * Damage the mob (SPEC-wave2 §3.2). Minecraft rules: for 0.5 s after a hit only a bigger hit applies (the
   * difference); a full hit flashes red, knocks the mob back away from the attacker (0.4) and plays the hurt
   * sound; at 0 health the mob dies (drops, death sound, 1 s tip-over, poof). Returns true if damage was dealt.
   * @param {number} amount
   * @param {string} [cause]   'player' | 'arrow' | 'explosion' | 'fall' | 'lava' | 'fire' | 'drown' | 'mob' ...
   * @param {object|null} [attacker] the player, a mob, or a projectile (with `shooter`)
   */
  hurt(amount, cause = 'generic', attacker = null) {
    if (this.dead || this.removed || !(amount > 0)) return false;
    const game = this.manager?.game;
    let dealt, full = false;
    if (this.invulnerable > INVULNERABLE_TIME / 2) {
      if (amount <= this.lastHurt) return false;
      dealt = amount - this.lastHurt;
      this.lastHurt = amount;
    } else {
      dealt = amount;
      full = true;
      this.lastHurt = amount;
      this.invulnerable = INVULNERABLE_TIME;
      this.hurtTime = HURT_TIME;
    }
    this.health = Math.max(0, this.health - dealt);
    this._noAction = 0;
    // who did it: the shooter of a projectile counts (revenge, death by player)
    const src = attacker && typeof attacker === 'object' ? (attacker.shooter ?? attacker) : null;
    if (src && src !== this) {
      this.lastAttacker = src;
      this._attackerTime = 0;
      if (src === game?.player || src.isPlayer === true || src.type === 'player' || (src.inventory && src.type !== 'mob')) this._playerHurt = 0;
    }
    // player-only loot when the player hurt it within the last 5 s (fall / fire deaths after a hit count too)
    this.killedByPlayer = this._playerHurt < 5;
    if (full && attacker && cause !== 'explosion') {
      // LivingEntity.hurt -> knockback(0.4) away from the source (arrows: along their flight)
      let dx, dz;
      if (attacker.type === 'arrow' && attacker.body) {
        dx = attacker.body.vx; dz = attacker.body.vz;
      } else {
        dx = this.body.x - (finite(attacker.x) ? attacker.x : this.body.x);
        dz = this.body.z - (finite(attacker.z) ? attacker.z : this.body.z);
      }
      this.knockback(dx, dz, 0.4);
    }
    if (full && (cause === 'player' || cause === 'arrow' || cause === 'mob')) this._panic = 5;   // PanicGoal
    if (this.health <= 0) {
      this._die(game, cause);
    } else if (full) {
      const b = this.body;
      playSound(game, this.def.sounds.hurt, b.x, b.y + this.def.eyeHeight, b.z, 1, this._voicePitch());
    }
    return true;
  }

  /**
   * Knock the mob back (Minecraft LivingEntity.knockback): velocity halved, `strength` b/tick added along
   * (dx, dz) — the direction AWAY from the source — and a hop of up to 0.4 b/tick when on the ground.
   */
  knockback(dx, dz, strength = 0.4) {
    if (this.removed || !(strength > 0)) return;
    const b = this.body;
    let len = Math.sqrt(dx * dx + dz * dz);
    if (!(len > 1e-4)) {
      const a = this.rnd() * TAU;
      dx = Math.cos(a); dz = Math.sin(a); len = 1;
    }
    const s = strength * TICKS / len;
    b.vx = b.vx / 2 + dx * s;
    b.vz = b.vz / 2 + dz * s;
    if (b.onGround) b.vy = Math.min(KNOCKBACK_LIFT, b.vy / 2 + strength * TICKS);
  }

  /**
   * Kill outright like Minecraft's /kill (Entity.kill: generic kill damage): the normal death with tip-over,
   * sound and loot. (Peaceful removes hostiles with remove() instead: no drops.)
   */
  kill() {
    if (this.dead || this.removed) return;
    this.invulnerable = 0;
    this.hurt(Math.max(1, this.health) * 1000, 'kill');
  }

  _voicePitch() {
    return (this.rnd() - this.rnd()) * 0.2 + 1;
  }

  _die(game, cause) {
    this.dead = true;
    this.pickable = false;
    this.deathTime = 0;
    this.pushable = false;
    this._stopHiss();
    this.moveMode = MOVE_NONE;
    this.target = null;
    this.aggressive = false;
    this.eatTicks = 0;
    const b = this.body;
    playSound(game, this.def.sounds.death, b.x, b.y + this.def.eyeHeight, b.z, 1, this._voicePitch());
    if (cause !== 'void') this._dropLoot(game);
  }

  /** Minecraft loot tables (cooked meat when burning, player-only rare drops). */
  _dropLoot(game) {
    const rnd = this.rnd;
    const b = this.body;
    const burning = this.fireTime > 0;
    for (const d of this.def.drops) {
      if (d.player && !this.killedByPlayer) continue;
      if (d.wool && this.sheared) continue;
      if (d.chance !== undefined && rnd() >= d.chance) continue;
      const n = d.min + Math.floor(rnd() * (d.max - d.min + 1));
      if (n <= 0) continue;
      let id = burning && d.cookedId ? d.cookedId : d.id;
      if (d.wool) id = FLEECE[this.fleece]?.wool ?? id;    // the fleece colour's wool
      if (id) this._spawnDrop(game, makeStack(id, n), b.x, b.y + 0.1, b.z);
    }
    // equipment: skeletons drop their bow / zombies their tool with 8.5 % (player kills), randomly damaged
    if (this.heldItem && this.killedByPlayer && rnd() < 0.085) {
      const max = maxDurability(this.heldItem);
      const dmg = max > 0 ? Math.floor(max - 3 - rnd() * Math.max(1, max - 3)) : 0;
      this._spawnDrop(game, makeStack(this.heldItem, 1, Math.max(0, dmg)), b.x, b.y + 0.1, b.z);
    }
  }

  _spawnDrop(game, stack, x, y, z) {
    if (game && typeof game.spawnItem === 'function') game.spawnItem(stack, x, y, z);
    else this.manager?.spawnItem?.(stack, x, y, z);
  }

  // -------------------------------------------------------------------------------------------
  // Update
  // -------------------------------------------------------------------------------------------

  /** Called by the manager while the mob's chunk is not ready: despawn rules only. */
  updateFrozen(dt, game) {
    this._despawnCheck(game, dt, false);
  }

  update(dt, game) {
    this.age += dt;
    const world = game?.world;
    if (!world) return;
    const b = this.body;
    if (!finite(b.x) || !finite(b.y) || !finite(b.z)) {
      this.remove();
      return;
    }
    if (this.hurtTime > 0) this.hurtTime = Math.max(0, this.hurtTime - dt);
    if (this.invulnerable > 0) this.invulnerable = Math.max(0, this.invulnerable - dt);
    if (this.attackAnim >= 0) {
      this.attackAnim += dt;
      if (this.attackAnim >= SWING_TIME) this.attackAnim = -1;
    }
    this._attackerTime += dt;
    this._playerHurt += dt;
    if (this._attackCooldown > 0) this._attackCooldown -= dt;
    if (this._jumpCooldown > 0) this._jumpCooldown -= dt;

    if (this.dead) {
      this.deathTime += dt;
      this._physics(world, dt, game, false);
      if (this.deathTime >= DEATH_TIME) {
        game?.particles?.spawnPoof?.(b.x, b.y, b.z, b.width, b.height);
        this.remove();
        return;
      }
      this._animate(dt);
      this.updateLight(world);
      this.updateShadow(world);
      return;
    }

    if (this._despawnCheck(game, dt, true)) return;

    // ---- environment
    this._updateFluids(world);
    this._statusEffects(world, dt, game);
    if (this.dead || this.removed) return;

    // ---- AI at 20 Hz
    this._aiAcc += dt;
    let ticks = 0;
    while (this._aiAcc >= TICK && ticks < 3) {
      this._aiAcc -= TICK;
      ticks++;
      this._ticks++;
      this._aiTick(world, game);
      if (this.removed || this.dead) return;
    }
    if (this._aiAcc >= TICK) this._aiAcc = 0;

    // ---- movement + animation
    this._physics(world, dt, game, true);
    if (this.removed) return;
    this._animate(dt);
    this._steps(world, game);
    this._sampleLight(world);
    this.updateShadow(world);
  }

  /** Light at the eyes (Entity.getLightProbePosition). */
  _sampleLight(world) {
    if (typeof world.getLight !== 'function') return;
    const b = this.body;
    const l = world.getLight(Math.floor(b.x), Math.floor(b.y + this.def.eyeHeight), Math.floor(b.z));
    this.light = finite(l) ? l & 255 : 0xf0;
  }

  /**
   * Peaceful removes hostiles; hostiles despawn beyond 128 blocks from the player at once and beyond 32 blocks
   * with 1/800 per tick after 30 s without action (Mob.checkDespawn). Returns true when removed.
   */
  _despawnCheck(game, dt, active) {
    if (this.hostile && game?.settings?.difficulty === 'peaceful') {
      this._stopHiss();
      this.remove();
      return true;
    }
    if (this.persistent) return false;
    const p = nearestPlayer(game, this.body.x, this.body.y, this.body.z);
    if (!p) return false;
    const dx = p.x - this.body.x, dy = p.y - this.body.y, dz = p.z - this.body.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > DESPAWN_FAR * DESPAWN_FAR) {
      this.remove();
      return true;
    }
    if (!active) return false;
    if (d2 < DESPAWN_NEAR * DESPAWN_NEAR) {
      this._noAction = 0;
      return false;
    }
    this._noAction += dt;
    if (this._noAction > DESPAWN_IDLE && this.rnd() < DESPAWN_CHANCE * dt * TICKS) {
      this.remove();
      return true;
    }
    return false;
  }

  _updateFluids(world) {
    const b = this.body;
    const hw = b.width / 2 - 0.001;
    const x0 = Math.floor(b.x - hw), x1 = Math.floor(b.x + hw);
    const z0 = Math.floor(b.z - hw), z1 = Math.floor(b.z + hw);
    const y0 = Math.max(0, Math.floor(b.y)), y1 = Math.min(255, Math.floor(b.y + b.height));
    let water = 0, lava = 0;
    for (let y = y0; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          const id = world.getBlock(x, y, z);
          const kind = LIQUID_KIND[id];
          if (kind === 0) continue;
          const top = liquidSurface(world, x, y, z, id) - b.y;
          if (kind === 1) { if (top > water) water = top; } else if (top > lava) lava = top;
        }
      }
    }
    this.waterDepth = water;
    this.lavaDepth = lava;
    this.inWater = water > 0.001;
    this.inLava = lava > 0.001;
  }

  /** Lava, fire, drowning, daylight burning (per frame, timed like Minecraft's ticks). */
  _statusEffects(world, dt, game) {
    const b = this.body;
    if (this.inLava) {
      this.hurt(4, 'lava');
      this.fireTime = Math.max(this.fireTime, 15);
      if (this.dead) return;
    }
    if (this.inWater && this.fireTime > 0) {
      this.fireTime = 0;
      playSound(game, 'fizz', b.x, b.y + b.height / 2, b.z, 0.7, 1.6);
    }
    if (this.fireTime > 0) {
      this.fireTime = Math.max(0, this.fireTime - dt);
      this._fireTimer += dt;
      if (this._fireTimer >= 1) {
        this._fireTimer -= 1;
        if (!this.inLava) this.hurt(1, 'fire');
        if (this.dead) return;
      }
      // smoke rising from burning mobs
      if (this.rnd() < dt * 4) game?.particles?.spawnSmoke?.(b.x, b.y + b.height * 0.8, b.z, 1);
    } else {
      this._fireTimer = 0.95;
    }
    // suffocation (eyes inside an opaque full block) and cactus contact: 1 damage per hit cooldown
    {
      const ex = Math.floor(b.x), ey = Math.floor(b.y + this.def.eyeHeight), ez = Math.floor(b.z);
      const eid = world.getBlock(ex, ey, ez);
      if (IS_OPAQUE[eid] && getCollisionBox(eid)) {
        this.hurt(1, 'suffocation');
        if (this.dead) return;
      } else if (this._touchesCactus(world)) {
        this.hurt(1, 'cactus');
        if (this.dead) return;
      }
    }
    // drowning (undead do not drown)
    if (!this.def.undead) {
      const eyeY = b.y + this.def.eyeHeight;
      const eyeId = world.getBlock(Math.floor(b.x), Math.floor(eyeY), Math.floor(b.z));
      const eyeWet = LIQUID_KIND[eyeId] === 1 && eyeY < liquidSurface(world, Math.floor(b.x), Math.floor(eyeY), Math.floor(b.z), eyeId);
      if (eyeWet) {
        this.air -= dt * TICKS;
        if (this.air <= -20) {
          this.air = 0;
          this.hurt(2, 'drown');
          if (this.dead) return;
        }
      } else {
        this.air = Math.min(MAX_AIR, this.air + dt * TICKS * 4);
      }
    }
  }

  /** True if the body box grown by 0.001 touches a cactus (Minecraft CactusBlock.entityInside). */
  _touchesCactus(world) {
    const b = this.body;
    const hw = b.width / 2 + 0.001;
    const x0 = Math.floor(b.x - hw), x1 = Math.floor(b.x + hw);
    const z0 = Math.floor(b.z - hw), z1 = Math.floor(b.z + hw);
    const y0 = Math.floor(b.y - 0.001), y1 = Math.floor(b.y + b.height);
    for (let y = y0; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) if (world.getBlock(x, y, z) === BLOCK.CACTUS) return true;
      }
    }
    return false;
  }

  /** Daylight burning (Mob.isSunBurnTick): undead in sky light at their eyes during the day ignite (8 s). */
  _sunBurnTick(world, game) {
    if (!this.def.undead || this.inWater) return;
    const daylight = finite(game?.daylight) ? game.daylight : 1;
    if (daylight < 0.8) return;
    const b = this.body;
    const ex = Math.floor(b.x), ey = Math.floor(b.y + this.def.eyeHeight), ez = Math.floor(b.z);
    if (typeof world.getLight !== 'function') return;
    const l = world.getLight(ex, ey, ez);
    if (!finite(l) || ((l & 255) >> 4) < 15) return;
    const f = brightnessOf(rawBrightness(world, game?.timeOfDay ?? 0.25, ex, ey, ez));
    if (f > 0.5 && this.rnd() * 30 < (f - 0.4) * 2) this.fireTime = Math.max(this.fireTime, 8);
  }

  // -------------------------------------------------------------------------------------------
  // Physics (per frame)
  // -------------------------------------------------------------------------------------------

  _physics(world, dt, game, active) {
    const b = this.body;
    if (!(dt > 0)) return;
    let left = dt > 0.25 ? 0.25 : dt;
    // current
    let flowing = false;
    if ((this.inWater || this.inLava) && fluidFlow(world, b, this.inWater ? 1 : 2, _flowDir)) flowing = true;
    while (left > 1e-9) {
      const h = left > MAX_STEP ? MAX_STEP : left;
      left -= h;
      this._physicsStep(world, h, game, active, flowing);
      if (this.removed) return;
    }
  }

  _physicsStep(world, h, game, active, flowing) {
    const b = this.body;
    const def = this.def;
    const moving = active && this.moveMode !== MOVE_NONE;
    // ---- desired horizontal velocity (direction + speed)
    let tx = 0, tz = 0;
    let dirLen = 0;
    if (moving) {
      if (this.moveMode === MOVE_STRAFE) {
        // MoveControl.strafe: forward / sideways relative to the facing
        const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
        const fx = -sy, fz = -cy, rx = cy, rz = -sy;
        tx = fx * this._strafeF + rx * this._strafeR;
        tz = fz * this._strafeF + rz * this._strafeR;
        dirLen = Math.sqrt(tx * tx + tz * tz);
      } else {
        // walk in the facing direction (Minecraft moves along yRot, turning toward the target)
        tx = -Math.sin(this.yaw); tz = -Math.cos(this.yaw);
        dirLen = 1;
      }
    }
    const strafe = this.moveMode === MOVE_STRAFE;
    // MoveControl.strafe: speed 0.5·attribute with the (forward, right) input itself (length 0.71)
    const sm = strafe ? def.speed * 0.5 : def.speed * this.speedMod;
    const input = strafe ? dirLen : sm;
    let K, vmax;
    if (this.inLava) {
      K = K_LAVA; vmax = TICKS * 0.02 * input / 0.5;
    } else if (this.inWater) {
      K = K_WATER; vmax = TICKS * 0.02 * input / 0.2;
    } else if (b.onGround) {
      const slip = SLIP[world.getBlock(Math.floor(b.x), Math.floor(b.y - 0.5000001), Math.floor(b.z))];
      const f = slip * 0.91;
      K = -TICKS * Math.log(f);
      vmax = TICKS * input * sm * (0.216 / (slip * slip * slip)) / (1 - f);
    } else {
      K = K_AIR; vmax = TICKS * 0.02 * input / 0.09;
    }
    let gx = 0, gz = 0;
    if (dirLen > 1e-6) {
      gx = tx / dirLen * vmax;
      gz = tz / dirLen * vmax;
    }
    const e = Math.exp(-K * h);
    // keep momentum in the air (knockback, leaps): only accelerate toward the target, never brake below it
    if (b.onGround || this.inWater || this.inLava || dirLen > 0) {
      b.vx = gx + (b.vx - gx) * e;
      b.vz = gz + (b.vz - gz) * e;
    } else {
      b.vx *= Math.exp(-K_AIR * h);
      b.vz *= Math.exp(-K_AIR * h);
    }
    if (flowing) {
      const push = (this.inWater ? 0.014 : 0.0023333333) * TICKS * TICKS * h;
      b.vx += _flowDir[0] * push; b.vy += _flowDir[1] * push; b.vz += _flowDir[2] * push;
    }

    // ---- vertical
    if (this.inWater || this.inLava) {
      // FloatGoal: jump in liquids deeper than the threshold (chickens float on the surface)
      const thresh = def.eyeHeight < 0.4 ? 0 : 0.4;
      const depth = this.inWater ? this.waterDepth : this.lavaDepth;
      const swim = active && depth > thresh;
      const target = swim ? WATER_RISE : -WATER_SINK;
      const kv = this.inLava ? K_LAVA : K_WATER;
      b.vy = target + (b.vy - target) * Math.exp(-kv * h);
      // hop out of the liquid onto a ledge
      if (active && this._collidedH && depth < 1.2 && this._jumpCooldown <= 0) {
        b.vy = Math.max(b.vy, 0.3 * TICKS);
        this._jumpCooldown = JUMP_COOLDOWN;
      }
      this.fallDistance = 0;
    } else {
      if (this._wantJump && b.onGround && this._jumpCooldown <= 0) {
        b.vy = JUMP_VELOCITY;
        this._jumpCooldown = JUMP_COOLDOWN;
      }
      const ev = Math.exp(-K_GRAVITY * h);
      b.vy = -TERMINAL + (b.vy + TERMINAL) * ev;
      if (def.slowFall && b.vy < 0) {
        // Chicken.aiStep: falling speed ×0.6 per tick -> drifts down at ~2.3 b/s
        b.vy *= Math.pow(0.6, h * TICKS);
      }
      if (this._climbing) {
        // spiders: wall climbing (LivingEntity.handleOnClimbable / onClimbable)
        if (b.vy < -CLIMB_MAX_FALL) b.vy = -CLIMB_MAX_FALL;
        if (this._collidedH && active) b.vy = Math.max(b.vy, CLIMB_SPEED);
        this.fallDistance = 0;
      }
    }

    // ---- move
    const y0 = b.y;
    const wasGround = b.onGround;
    b.moveFor(world, h);
    this._collidedH = b.collidedX || b.collidedZ;
    if (def.climbs) this._climbing = this._collidedH;
    const dy = b.y - y0;
    if (b.onGround) {
      if (!wasGround || this.fallDistance > 0) this._land(world, game);
      this.fallDistance = 0;
    } else if (dy < 0 && !this.inWater && !this._climbing) {
      this.fallDistance -= dy;
    }
    if (b.y < VOID_Y) {
      this.hurt(1000, 'void');
      this.remove();
    }
  }

  /** Fall damage like the player (ceil(fallDistance − 3)); chickens never take any. */
  _land(world, game) {
    const fd = this.fallDistance;
    this.fallDistance = 0;
    if (fd > 3 && !this.def.slowFall && !this.inWater) {
      const dmg = Math.ceil(fd - 3 - 1e-4);
      if (dmg > 0) {
        this.hurt(dmg, 'fall');
        const b = this.body;
        playSound(game, dmg > 4 ? 'fall_big' : 'fall_small', b.x, b.y, b.z, 1, 1);
      }
    }
  }

  /** Step sounds every 1/0.6 blocks walked (Entity.playStepSound). */
  _steps(world, game) {
    const b = this.body;
    if (!b.onGround || this.inWater) return;
    if (this._lx !== this._lx) return;      // NaN: no motion history yet
    const dist = this._frameDist;
    if (!(dist > 0)) return;
    this._stepDist += dist * 0.6;
    if (this._stepDist < 1) return;
    this._stepDist -= 1;
    if (this._stepDist > 1) this._stepDist = 0;
    const s = this.def.sounds.step;
    if (s && playSound(game, s, b.x, b.y, b.z, 1, 1)) return;
    const id = world.getBlock(Math.floor(b.x), Math.floor(b.y - 0.2), Math.floor(b.z));
    const mat = BLOCKS[id]?.sound;
    if (mat && id !== 0) game?.audio?.playBlock?.('step', mat, b.x, b.y, b.z);
  }

  // -------------------------------------------------------------------------------------------
  // Animation (per frame): walk cycle, body / head rotation, chicken flap
  // -------------------------------------------------------------------------------------------

  _animate(dt) {
    const b = this.body;
    const k = dt * TICKS;
    if (this._lx !== this._lx) { this._lx = b.x; this._lz = b.z; }   // NaN: first frame
    const dx = b.x - this._lx, dz = b.z - this._lz;
    this._lx = b.x; this._lz = b.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    this._frameDist = dist;
    if (dist > 4 * k + 1) {
      this.limbSwingAmount = 0;
    } else {
      // WalkAnimationState: speed target min(1, distance per tick · 4), eased 0.4 per tick
      const target = this.dead ? 0 : Math.min(1, (dist / Math.max(1e-6, k)) * 4);
      this.limbSwingAmount += (target - this.limbSwingAmount) * (1 - Math.pow(0.6, k));
      this.limbSwing += this.limbSwingAmount * k;
    }
    if (this.dead) return;
    // (angle math written out: no helper calls with fractional arguments in this per-frame path)
    // body: follows the movement direction while moving (BodyRotationControl), stays within 75° of the head
    const strafe = this.moveMode === MOVE_STRAFE;
    let body = this.bodyYaw;
    if (dist > 0.01 * k || strafe) {
      let d = this.yaw - body;
      d -= TAU * Math.floor((d + Math.PI) / TAU);
      const max = strafe ? 15 * DEG * k : (1 - Math.pow(0.7, k)) * Math.abs(d) + 1e-3;
      body += d > max ? max : d < -max ? -max : d;
    }
    // head: look target or the body direction
    let wantYaw = body, wantPitch = 0, rate = 10 * DEG * k;
    if (this._lookMode !== 0) {
      wantYaw = this._lookYaw;
      wantPitch = this._lookPitch;
      rate = (this._lookMode === 3 ? 30 : 10) * DEG * k;
    }
    let head = this.headYaw;
    let dh = wantYaw - head;
    dh -= TAU * Math.floor((dh + Math.PI) / TAU);
    head += dh > rate ? rate : dh < -rate ? -rate : dh;
    const pr = 40 * DEG * k, dp = wantPitch - this.pitch;
    this.pitch += dp > pr ? pr : dp < -pr ? -pr : dp;
    let rel = head - body;
    rel -= TAU * Math.floor((rel + Math.PI) / TAU);
    if (rel > HEAD_LIMIT) body = head - HEAD_LIMIT;
    else if (rel < -HEAD_LIMIT) body = head + HEAD_LIMIT;
    this.bodyYaw = body - TAU * Math.floor((body + Math.PI) / TAU);
    this.headYaw = head - TAU * Math.floor((head + Math.PI) / TAU);
    // chicken wings (Chicken.aiStep, per tick)
    if (this.def.slowFall) {
      const ground = b.onGround;
      this.flapSpeed = Math.min(1, Math.max(0, this.flapSpeed + (ground ? -1 : 4) * 0.3 * k));
      if (!ground && this._flapping < 1) this._flapping = 1;
      this._flapping *= Math.pow(0.9, k);
      this.flap += this._flapping * 2 * k;
    }
  }

  // -------------------------------------------------------------------------------------------
  // AI (20 Hz)
  // -------------------------------------------------------------------------------------------

  _aiTick(world, game) {
    const def = this.def;
    this._lookLock = false;
    if (this.eatTicks > 0) this.eatTicks = Math.max(0, this.eatTicks - 1);
    if (this._panic > 0) this._panic = Math.max(0, this._panic - TICK);
    if (this._idle > 0) this._idle -= TICK;
    if (def.undead) this._sunBurnTick(world, game);
    this._ambientSound(game);
    switch (def.ai) {
      case 'zombie': this._tickZombie(world, game); break;
      case 'skeleton': this._tickSkeleton(world, game); break;
      case 'creeper': this._tickCreeper(world, game); break;
      case 'spider': this._tickSpider(world, game); break;
      default: this._tickPassive(world, game); break;
    }
    this._tickMovement(world);
    this._tickLook(game);
  }

  _ambientSound(game) {
    const name = this.def.sounds.ambient;
    if (!name) return;
    this._ambient -= TICK;
    if (this._ambient > 0) return;
    this._ambient = 8 + this.rnd() * 12;
    const b = this.body;
    playSound(game, name, b.x, b.y + this.def.eyeHeight, b.z, 1, this._voicePitch());
  }

  /** The nearest player that is a valid target for hostile mobs (alive, survival), or null. */
  _validPlayer(game) {
    const b = this.body;
    return nearestPlayer(game, b.x, b.y, b.z, Infinity, isTargetable);
  }

  _distSq(e) {
    const b = this.body;
    const dx = e.x - b.x, dy = e.y - b.y, dz = e.z - b.z;
    return dx * dx + dy * dy + dz * dz;
  }

  /**
   * Line of sight from the eyes to the target's eyes (Sensing cache): recomputed every 10 ticks per mob
   * (staggered by id), at once for a new target.
   */
  _updateSight(world, target) {
    if (!target) { this._canSee = false; this._sightOf = null; return false; }
    if (target !== this._sightOf || this._ticks - this._sightTick >= 10) {
      this._sightOf = target;
      this._sightTick = this._ticks;
      const b = this.body;
      const eh = finite(target.eyeHeight) ? target.eyeHeight : PLAYER.EYE_HEIGHT;
      this._canSee = lineOfSight(world, b.x, b.y + this.def.eyeHeight, b.z, target.x, target.y + eh, target.z);
    }
    return this._canSee;
  }

  /**
   * Hostile targeting (NearestAttackableTargetGoal + HurtByTargetGoal): the survival player within the follow
   * range seen (zombies also sense it within 16 blocks); kept while in range and seen within the last 3 s.
   */
  _updateTarget(world, game, mustBeDark = false) {
    const p = this._validPlayer(game);
    const range = this.def.followRange ?? 16;
    // A target stays a target while it is targetable and in range, even when another player comes closer.
    const t = this.target;
    if (t && (!isTargetable(t) || !playersOf(game).includes(t) || this._distSq(t) > range * range)) this.target = null;
    if (this.target) {
      const seen = this._updateSight(world, this.target);
      this._unseen = seen ? 0 : this._unseen + 1;
      if (this._unseen > 60 && this._distSq(this.target) > 16 * 16) this.target = null;
      return;
    }
    if (!p) return;
    // revenge: a player hurt us recently
    const la = this.lastAttacker;
    if (la && this._attackerTime < 5 && isTargetable(la) && playersOf(game).includes(la) && this._distSq(la) <= range * range) {
      this.target = la;
      this._unseen = 0;
      return;
    }
    if (mustBeDark) return;
    if ((this._ticks + this.id) % 10 !== 0) return;      // reducedTickDelay(10)
    const d2 = this._distSq(p);
    if (d2 > range * range) return;
    const sees = this._updateSight(world, p);
    if (sees || (this.mobType === 'zombie' && d2 < 16 * 16)) {
      this.target = p;
      this._unseen = 0;
    }
  }

  // ---- passive animals --------------------------------------------------------------------------

  _tickPassive(world, game) {
    const b = this.body;
    const def = this.def;
    // PanicGoal (hurt recently or burning): run to random spots nearby at the panic speed
    if (this._panic > 0 || this.fireTime > 0) {
      this.speedMod = def.panic;
      this.eatTicks = 0;
      if (this.moveMode === MOVE_NONE || this._pathDone()) {
        const src = this.lastAttacker;
        let away = null;
        if (src && finite(src.x)) { _away[0] = src.x; _away[1] = src.z; away = _away; }
        if (randomWalkTarget(world, this.rnd, Math.floor(b.x), Math.floor(b.y), Math.floor(b.z), 5, 4, def.cells, true,
          game?.timeOfDay ?? 0.25, _pos, false, away)) {
          this._setGoal(world, _pos[0], _pos[1], _pos[2], 200);
        }
      }
      return;
    }
    // TemptGoal: follow a nearby player holding the animal's food
    if (this._tempted(game)) {
      const p = this._temptedBy;
      this.eatTicks = 0;
      this._lookMode = 3;
      this._lookLock = true;
      this._lookAt(p.x, p.y + (finite(p.eyeHeight) ? p.eyeHeight : PLAYER.EYE_HEIGHT), p.z);
      if (this._distSqXZ(p) < 2.5 * 2.5) {
        if (this.moveMode !== MOVE_NONE) this._stop();
      } else {
        this._chase(world, p, 1.25);
      }
      return;
    }
    if (this._lookMode === 3) this._lookMode = 0;
    // sheep: EatBlockGoal
    if (this.mobType === 'sheep') {
      if (this.eatTicks > 0) {
        this.moveMode = MOVE_NONE;
        if (this.eatTicks === 4) this._eatGrass(world, game);
        return;
      }
      if (this.moveMode === MOVE_NONE && this.rnd() < 1 / 1000 && this._canEatHere(world)) {
        this.eatTicks = 40;
        return;
      }
    }
    // WaterAvoidingRandomStrollGoal: a new walk every ~6 s on average when idle
    if (this.moveMode === MOVE_NONE || this._pathDone()) {
      if (this.moveMode !== MOVE_NONE) this._stop();
      if (this._idle <= 0 && this.rnd() < 1 / 120 * 1) {
        this.speedMod = 1;
        if (randomWalkTarget(world, this.rnd, Math.floor(b.x), Math.floor(b.y), Math.floor(b.z), 10, 7, def.cells, true,
          game?.timeOfDay ?? 0.25, _pos, false)) {
          this._setGoal(world, _pos[0], _pos[1], _pos[2], 200);
        }
        this._idle = 2 + this.rnd() * 4;
      }
    }
  }

  /**
   * True while a survival / creative player holding this animal's tempt item is within 10 blocks; the nearest
   * such player is kept in `_temptedBy`.
   */
  _tempted(game) {
    const items = TEMPT[this.mobType];
    this._temptedBy = null;
    if (!items) return false;
    const b = this.body;
    _temptItems = items;
    this._temptedBy = nearestPlayer(game, b.x, b.y, b.z, 10, holdsTemptItem);
    _temptItems = null;
    return this._temptedBy !== null;
  }

  _canEatHere(world) {
    const b = this.body;
    const x = Math.floor(b.x), y = Math.floor(b.y), z = Math.floor(b.z);
    const here = world.getBlock(x, y, z);
    return here === BLOCK.SHORT_GRASS || world.getBlock(x, y - 1, z) === BLOCK.GRASS_BLOCK;
  }

  /** EatBlockGoal at 4 ticks left: short grass is eaten, else the grass block below turns into dirt. */
  _eatGrass(world, game) {
    const b = this.body;
    const x = Math.floor(b.x), y = Math.floor(b.y), z = Math.floor(b.z);
    if (world.getBlock(x, y, z) === BLOCK.SHORT_GRASS) {
      if (typeof world.setBlock === 'function' && world.setBlock(x, y, z, 0)) {
        game?.particles?.spawnBlockBreak?.(x, y, z, BLOCK.SHORT_GRASS);
        game?.audio?.playBlock?.('break', 'grass', x + 0.5, y + 0.5, z + 0.5);
      }
    } else if (world.getBlock(x, y - 1, z) === BLOCK.GRASS_BLOCK) {
      game?.particles?.spawnBlockBreak?.(x, y - 1, z, BLOCK.GRASS_BLOCK);
      game?.audio?.playBlock?.('break', 'grass', x + 0.5, y - 0.5, z + 0.5);
      if (typeof world.setBlock === 'function') world.setBlock(x, y - 1, z, BLOCK.DIRT);
    }
    this.sheared = false;    // Sheep.ate(): the fleece grows back
  }

  // ---- zombie -------------------------------------------------------------------------------------

  _tickZombie(world, game) {
    this._updateTarget(world, game);
    const t = this.target;
    if (!t) {
      this._raiseArm = 0;
      this.aggressive = false;
      this._wander(world, game, 1);
      return;
    }
    this._chase(world, t, this.def.chase);
    this._raiseArm++;
    // MeleeAttackGoal: reach² = (2·width)² + target width, 20-tick cooldown
    const reach = (this.body.width * 2) ** 2 + (finite(t.width) ? t.width : PLAYER.WIDTH);
    const d2 = this._distSqXZ(t);
    // ZombieAttackGoal: arms up after 5 ticks of chasing while the next attack is less than half a cooldown away
    this.aggressive = this._raiseArm >= 5 && this._attackCooldown < 0.5;
    if (d2 <= reach && Math.abs(t.y - this.body.y) < 1.5 && this._attackCooldown <= 0 && this._canSee) {
      this._attackCooldown = 1;
      this._meleeHit(game, t, this.def.attack);
    }
  }

  _distSqXZ(e) {
    const dx = e.x - this.body.x, dz = e.z - this.body.z;
    return dx * dx + dz * dz;
  }

  /**
   * LivingEntity.doHurtTarget on the player: difficulty-scaled damage; player.damage() applies Minecraft's
   * standard knockback away from the attacker (and the death message from our mobType).
   */
  _meleeHit(game, t, damage) {
    this.attackAnim = 0;
    const scaled = scaleMobDamage(game, damage);
    if (scaled <= 0 || typeof t.damage !== 'function') return;
    t.damage(scaled, 'mob', undefined, this);
  }

  /** Walk toward the target: path finding (re-planned when the target moves), direct steering when close. */
  _chase(world, t, speedMod) {
    this.speedMod = speedMod;
    this._lookMode = 3;
    this._lookAt(t.x, t.y + (finite(t.eyeHeight) ? t.eyeHeight : PLAYER.EYE_HEIGHT), t.z);
    const d2 = this._distSqXZ(t);
    const dy = Math.abs(t.y - this.body.y);
    if (d2 < 2.25 && dy < 1.5) {
      // close enough: steer straight at it (MeleeAttackGoal keeps pushing into the target)
      this.moveMode = MOVE_DIRECT;
      this._goalX = t.x; this._goalY = t.y; this._goalZ = t.z;
      this._repath = 0;          // plan as soon as it gets away again
      return;
    }
    this._repath -= TICK;
    const tx = Math.floor(t.x), ty = Math.floor(t.y), tz = Math.floor(t.z);
    const moved = Math.abs(tx - this._goalCX) + Math.abs(tz - this._goalCZ) > 1 || Math.abs(ty - this._goalCY) > 1;
    if (this._repath <= 0 || this.moveMode === MOVE_NONE || (moved && this._repath < 0.6) || this._pathDone()) {
      const r = this._setGoal(world, tx, ty, tz, 300, true);
      if (!r) {
        // no path: head straight for it until the next plan
        this.moveMode = MOVE_DIRECT;
        this._goalX = t.x; this._goalY = t.y; this._goalZ = t.z;
      }
      // a full plan holds ~1 s; without a path-finder token (budget) try again soon
      this._repath = r === 2 ? 0.15 + this.rnd() * 0.15 : 0.75 + this.rnd() * 0.5;
    } else if (this.moveMode === MOVE_DIRECT) {
      this._goalX = t.x; this._goalY = t.y; this._goalZ = t.z;
    }
  }

  _wander(world, game, speedMod) {
    if (this.moveMode === MOVE_NONE || this._pathDone()) {
      if (this.moveMode !== MOVE_NONE) this._stop();
      if (this._idle <= 0 && this.rnd() < 1 / 120) {
        const b = this.body;
        this.speedMod = speedMod;
        if (randomWalkTarget(world, this.rnd, Math.floor(b.x), Math.floor(b.y), Math.floor(b.z), 10, 7, this.def.cells, false,
          game?.timeOfDay ?? 0.25, _pos, false)) {
          this._setGoal(world, _pos[0], _pos[1], _pos[2], 200);
        }
        this._idle = 2 + this.rnd() * 4;
      }
    }
  }

  // ---- skeleton -----------------------------------------------------------------------------------

  _tickSkeleton(world, game) {
    this._updateTarget(world, game);
    const t = this.target;
    const b = this.body;
    if (!t) {
      this.aggressive = false;
      this.useTicks = 0;
      this._seeTime = 0;
      this._strafeTime = -1;
      // FleeSunGoal: burning in daylight -> into the shade
      if (this.fireTime > 0 && this.moveMode === MOVE_NONE &&
          shadePosition(world, this.rnd, Math.floor(b.x), Math.floor(b.y), Math.floor(b.z), this.def.cells, _pos)) {
        this.speedMod = 1;
        this._setGoal(world, _pos[0], _pos[1], _pos[2], 200);
        return;
      }
      this._wander(world, game, 1);
      return;
    }
    // RangedBowAttackGoal(1.0, 20 / 40 ticks, 15 blocks)
    const d2 = this._distSq(t);
    const sees = this._updateSight(world, t);
    if (sees !== (this._seeTime > 0)) this._seeTime = 0;
    this._seeTime += sees ? 1 : -1;
    const radius2 = 15 * 15;
    if (d2 <= radius2 && this._seeTime >= 20) {
      if (this.moveMode === MOVE_PATH || this.moveMode === MOVE_DIRECT) this._stop();
      this._strafeTime++;
    } else {
      this._chase(world, t, 1);
      this._strafeTime = -1;
    }
    if (this._strafeTime >= 20) {
      if (this.rnd() < 0.3) this._strafeCW = !this._strafeCW;
      if (this.rnd() < 0.3) this._strafeBack = !this._strafeBack;
      this._strafeTime = 0;
    }
    if (this._strafeTime > -1) {
      if (d2 > radius2 * 0.75) this._strafeBack = false;
      else if (d2 < radius2 * 0.25) this._strafeBack = true;
      this.moveMode = MOVE_STRAFE;
      this.speedMod = 1;
      this._strafeF = this._strafeBack ? -0.5 : 0.5;
      this._strafeR = this._strafeCW ? 0.5 : -0.5;
      // keep facing the target while strafing (lookAt 30°/tick)
      this.yaw = approachAngle(this.yaw, yawOf(t.x - b.x, t.z - b.z), 30 * DEG);
    }
    this._lookMode = 3;
    this._lookAt(t.x, t.y + (finite(t.eyeHeight) ? t.eyeHeight : PLAYER.EYE_HEIGHT), t.z);
    // drawing and shooting
    const interval = game?.settings?.difficulty === 'hard' ? 20 : 40;
    if (this.useTicks > 0) {
      if (!sees && this._seeTime < -60) {
        this.useTicks = 0;
      } else if (sees) {
        this.useTicks++;
        if (this.useTicks >= 20) {
          this._shootArrow(game, t, bowPowerTicks(this.useTicks));
          this.useTicks = 0;
          this._attackTime = interval;
        }
      } else {
        this.useTicks++;
      }
    } else if (--this._attackTime <= 0 && this._seeTime >= -60) {
      this.useTicks = 1;
    }
    this.aggressive = this.useTicks > 0;
  }

  /** AbstractSkeleton.performRangedAttack: aim at a third of the target's height, lead by distance. */
  _shootArrow(game, t, power) {
    const mgr = this.manager ?? game?.entities;
    if (!mgr || typeof mgr.spawnArrow !== 'function') return;
    const b = this.body;
    const sx = b.x, sy = b.y + this.def.eyeHeight - 0.1, sz = b.z;
    const th = finite(t.height) ? t.height : PLAYER.HEIGHT;
    const dx = t.x - sx, dy = t.y + th / 3 - sy, dz = t.z - sz;
    const hd = Math.sqrt(dx * dx + dz * dz);
    const diff = DIFFICULTY_ID[game?.settings?.difficulty] ?? 2;
    const inacc = 14 - diff * 4;
    const rnd = this.rnd;
    let vx = dx, vy = dy + hd * 0.2, vz = dz;
    const len = Math.sqrt(vx * vx + vy * vy + vz * vz) || 1;
    vx /= len; vy /= len; vz /= len;
    const spread = 0.0172275 * inacc;
    vx += (rnd() - rnd()) * spread; vy += (rnd() - rnd()) * spread; vz += (rnd() - rnd()) * spread;
    const v = 1.6 * TICKS;
    const damage = power * 2 + gaussian(rnd) * 0.25 + diff * 0.11;
    mgr.spawnArrow(sx, sy, sz, vx * v, vy * v, vz * v, { shooter: this, damage, critical: false, pickup: false });
    playSound(game, 'bow_shoot', sx, sy, sz, 1, 1 / (rnd() * 0.4 + 0.8));
  }

  // ---- creeper ------------------------------------------------------------------------------------

  _tickCreeper(world, game) {
    this._updateTarget(world, game);
    const t = this.target;
    // SwellGoal: within 3 blocks start the fuse; defuse beyond 7 blocks or without line of sight
    let dir = -1;
    const swelling = this._swellDir > 0 || (t && this._distSq(t) < 9);
    if (t && swelling) {
      const sees = this._updateSight(world, t);
      dir = this._distSq(t) > 49 || !sees ? -1 : 1;
      this._stop();
      this._lookMode = 3;
      this._lookAt(t.x, t.y + (finite(t.eyeHeight) ? t.eyeHeight : PLAYER.EYE_HEIGHT), t.z);
    } else if (t) {
      this._chase(world, t, this.def.chase);
    } else {
      this._wander(world, game, 1);
    }
    this._swellDir = dir;
    this._oldSwell = this.swell;
    // Creeper.tick: the primed hiss when the fuse starts (again after a defuse)
    if (dir > 0 && this.swell === 0) this._startHiss(game);
    this.swell = Math.max(0, this.swell + dir);
    if (this.swell === 0 && dir < 0) this._stopHiss();
    if (this._hiss && typeof this._hiss.setPosition === 'function') {
      const b = this.body;
      this._hiss.setPosition(b.x, b.y + 1, b.z);
    }
    if (this.swell >= 30) this._explode(game);
  }

  _startHiss(game) {
    this._stopHiss();
    const b = this.body;
    const s = mobSound('creeper_hiss');
    // Minecraft plays CREEPER_PRIMED at pitch 0.5 (the recipe is pitched for that already)
    this._hiss = s ? game?.audio?.play?.(s, { x: b.x, y: b.y + 1, z: b.z, volume: 1, pitch: 1 }) ?? null : null;
  }

  _stopHiss() {
    const h = this._hiss;
    this._hiss = null;
    if (h && typeof h.stop === 'function') {
      try { h.stop(0.1); } catch { /* voice already gone */ }
    }
  }

  onRemoved() {
    this._stopHiss();
  }

  /** Creeper.explodeCreeper: power 3 at the feet, the creeper disappears (no drops). */
  _explode(game) {
    const b = this.body;
    this._hiss = null;            // the hiss runs out by itself into the blast
    this.dead = true;
    this.pickable = false;
    this.remove();
    const mgr = this.manager ?? game?.entities;
    mgr?.explode?.(b.x, b.y, b.z, 3, { source: this, attacker: this });
  }

  // ---- spider -------------------------------------------------------------------------------------

  _tickSpider(world, game) {
    const b = this.body;
    const bright = brightnessOf(rawBrightness(world, game?.timeOfDay ?? 0.25, Math.floor(b.x), Math.floor(b.y + 0.5), Math.floor(b.z)));
    const light = bright >= 0.5;
    // SpiderTargetGoal: only hunts in the dark (unless provoked); SpiderAttackGoal gives up in the light (1 %)
    if (this.target && light && this.lastAttacker !== this.target && this.rnd() < 0.01) this.target = null;
    this._updateTarget(world, game, light);
    const t = this.target;
    if (!t) {
      this.aggressive = false;
      this._wander(world, game, 0.8);
      return;
    }
    this._chase(world, t, this.def.chase);
    const d2 = this._distSq(t);
    // LeapAtTargetGoal(0.4): 2..4 blocks away, on the ground, 1 in 5 ticks
    if (b.onGround && d2 >= 4 && d2 <= 36 && this._canSee && this.rnd() < 0.2) {
      let lx = t.x - b.x, lz = t.z - b.z;
      const l = Math.sqrt(lx * lx + lz * lz);
      if (l > 1e-4) {
        lx = lx / l * 0.4 * TICKS + b.vx * 0.2;
        lz = lz / l * 0.4 * TICKS + b.vz * 0.2;
        b.vx = lx; b.vz = lz; b.vy = 0.4 * TICKS;
        this._jumpCooldown = JUMP_COOLDOWN;
      }
    }
    // SpiderAttackGoal: reach² = 4 + target width
    const reach = 4 + (finite(t.width) ? t.width : PLAYER.WIDTH);
    if (this._distSqXZ(t) <= reach && Math.abs(t.y - b.y) < 1.6 && this._attackCooldown <= 0 && this._canSee) {
      this._attackCooldown = 1;
      this._meleeHit(game, t, this.def.attack);
    }
  }

  // ---- movement goals -------------------------------------------------------------------------------

  /**
   * Plan a path to the feet cell (x, y, z). Without a path-finder token (budget) a chasing mob steers
   * directly for a moment (`direct`), others simply wait. Returns 1 (path), 2 (steering directly for lack of a
   * token) or 0 (no path).
   */
  _setGoal(world, x, y, z, maxNodes, direct = false) {
    this._goalCX = x; this._goalCY = y; this._goalCZ = z;
    if (!takePathToken()) {
      if (!direct) return 0;
      this.moveMode = MOVE_DIRECT;
      this._goalX = x + 0.5; this._goalY = y; this._goalZ = z + 0.5;
      return 2;
    }
    const b = this.body;
    const sx = Math.floor(b.x), sy = Math.floor(b.y + 0.01), sz = Math.floor(b.z);
    const n = pathFinder.find(world, sx, sy, sz, x, y, z, this.path, this.def.cells, maxNodes, this.hostile ? 4 : 3, 32,
      this.hostile ? 2 : 4);
    this.pathLen = n;
    this.pathIndex = 0;
    this._stuck = 0;
    this._stuckX = b.x; this._stuckZ = b.z;
    if (n <= 0) {
      this.moveMode = MOVE_NONE;
      return 0;
    }
    this.moveMode = MOVE_PATH;
    return 1;
  }

  _pathDone() {
    return this.moveMode === MOVE_PATH && this.pathIndex >= this.pathLen;
  }

  _stop() {
    this.moveMode = MOVE_NONE;
    this.pathLen = 0;
    this.pathIndex = 0;
    this._wantJump = false;
  }

  /**
   * Path following / direct steering (PathNavigation + MoveControl): turn toward the next waypoint (90°/tick),
   * advance waypoints when within reach, jump for higher waypoints and against 1-block walls, give up when
   * stuck for 2 s.
   */
  _tickMovement(world) {
    const b = this.body;
    this._wantJump = false;
    if (this.moveMode === MOVE_NONE || this.moveMode === MOVE_STRAFE) {
      if (this.moveMode === MOVE_STRAFE && this._collidedH && b.onGround) this._wantJump = true;
      return;
    }
    let gx, gy, gz;
    if (this.moveMode === MOVE_PATH) {
      const reach = b.width > 0.75 ? b.width / 2 : 0.75 - b.width / 2;
      while (this.pathIndex < this.pathLen) {
        const o = this.pathIndex * 3;
        const px = this.path[o] + 0.5, py = this.path[o + 1], pz = this.path[o + 2] + 0.5;
        if (Math.abs(b.x - px) < reach && Math.abs(b.z - pz) < reach && Math.abs(b.y - py) < 1) this.pathIndex++;
        else break;
      }
      if (this.pathIndex >= this.pathLen) {
        this.moveMode = MOVE_NONE;
        return;
      }
      const o = this.pathIndex * 3;
      gx = this.path[o] + 0.5; gy = this.path[o + 1]; gz = this.path[o + 2] + 0.5;
    } else {
      gx = this._goalX; gy = this._goalY; gz = this._goalZ;
      const dx = gx - b.x, dz = gz - b.z;
      if (dx * dx + dz * dz < 0.04) {
        this.moveMode = MOVE_NONE;
        return;
      }
    }
    const dx = gx - b.x, dz = gz - b.z;
    const hd = Math.sqrt(dx * dx + dz * dz);
    if (hd > 1e-3) this.yaw = approachAngle(this.yaw, yawOf(dx, dz), 90 * DEG);
    // MoveControl: jump when the waypoint is higher than a step and close, or when walking into a wall
    if (b.onGround && ((gy - b.y > 0.6 && hd < Math.max(1.2, b.width + 0.6)) || this._collidedH)) {
      if (passable(world, Math.floor(b.x), Math.floor(b.y) + this.def.cells, Math.floor(b.z))) this._wantJump = true;
    }
    // stuck detection: no progress for 2 s -> give up (the goal logic plans again)
    this._stuck += TICK;
    if (this._stuck >= 2) {
      const moved = Math.abs(b.x - this._stuckX) + Math.abs(b.z - this._stuckZ);
      this._stuck = 0;
      this._stuckX = b.x; this._stuckZ = b.z;
      if (moved < 0.5) this._stop();
    }
  }

  _lookAt(x, y, z) {
    const b = this.body;
    const dx = x - b.x, dy = y - (b.y + this.def.eyeHeight), dz = z - b.z;
    this._lookYaw = yawOf(dx, dz);
    this._lookPitch = Math.max(-40 * DEG, Math.min(40 * DEG, Math.atan2(dy, Math.sqrt(dx * dx + dz * dz))));
  }

  /** LookAtPlayerGoal (2 % per tick, 2–4 s) and RandomLookAroundGoal (2 % per tick, 1–2 s). */
  _tickLook(game) {
    if (this._lookMode === 3 && (this.target || this._lookLock)) return;
    if (this._lookMode === 3) this._lookMode = 0;
    if (this._lookTimer > 0) {
      this._lookTimer -= TICK;
      if (this._lookMode === 1) {
        const p = this._lookPlayer;
        if (p && !p.dead && finite(p.x)) this._lookAt(p.x, p.y + (finite(p.eyeHeight) ? p.eyeHeight : 1.62), p.z);
      }
      if (this._lookTimer <= 0) this._lookMode = 0;
      return;
    }
    const rnd = this.rnd;
    if (this.moveMode !== MOVE_NONE && this.moveMode !== MOVE_STRAFE) return;
    const range = this.def.look;
    const p = nearestPlayer(game, this.body.x, this.body.y, this.body.z, range, isAlive);
    if (p && rnd() < 0.02 && this._distSq(p) < range * range) {
      this._lookMode = 1;
      this._lookPlayer = p;
      this._lookTimer = (40 + Math.floor(rnd() * 40)) * TICK;
      this._lookAt(p.x, p.y + (finite(p.eyeHeight) ? p.eyeHeight : 1.62), p.z);
    } else if (rnd() < 0.02) {
      this._lookMode = 2;
      this._lookTimer = (20 + Math.floor(rnd() * 20)) * TICK;
      this._lookYaw = this.bodyYaw + (rnd() * 2 - 1) * Math.PI;
      this._lookPitch = 0;
    }
  }

  // -------------------------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------------------------

  serialize() {
    if (this.removed || this.dead) return null;
    const b = this.body;
    const out = {
      type: 'mob', mob: this.mobType, x: b.x, y: b.y, z: b.z, vx: b.vx, vy: b.vy, vz: b.vz,
      yaw: this.yaw, health: this.health, age: this.age, persistent: this.persistent,
    };
    if (this.fireTime > 0) out.fire = this.fireTime;
    if (this.heldItem) out.held = this.heldItem;
    if (this.sheared) out.sheared = true;
    if (this.fleece) out.fleece = this.fleece;
    if (this.air < MAX_AIR) out.air = this.air;
    return out;
  }

  /** A Mob from a serialize() record (not added to a manager), or null for invalid records. */
  static fromJSON(s, rng) {
    if (!s || !MOB_TYPES[s.mob] || !finite(s.x) || !finite(s.y) || !finite(s.z)) return null;
    const m = new Mob(s.mob, { persistent: !!s.persistent, rng });
    m.setPosition(s.x, s.y, s.z);
    m.body.vx = finite(s.vx) ? s.vx : 0;
    m.body.vy = finite(s.vy) ? s.vy : 0;
    m.body.vz = finite(s.vz) ? s.vz : 0;
    if (finite(s.yaw)) { m.yaw = wrapAngle(s.yaw); m.bodyYaw = m.yaw; m.headYaw = m.yaw; }
    if (finite(s.health) && s.health > 0) m.health = Math.min(m.maxHealth, s.health);
    if (finite(s.age)) m.age = s.age;
    if (finite(s.fire)) m.fireTime = s.fire;
    if (finite(s.held)) m.heldItem = s.held | 0;
    if (finite(s.fleece) && FLEECE[s.fleece | 0]) m.setFleece(s.fleece | 0);
    if (finite(s.air)) m.air = s.air;
    m.sheared = !!s.sheared;
    return m;
  }
}

/** BowItem.getPowerForTime for `ticks` of drawing. */
function bowPowerTicks(ticks) {
  const f = ticks / 20;
  return Math.min(1, (f * f + f * 2) / 3);
}

registerEntityType('mob', (manager, s) => Mob.fromJSON(s, manager?.rng));

// ===================================================================================================
// spawnMob
// ===================================================================================================

/**
 * Spawn a mob of `mobType` with its feet at (x, y, z) (spawn eggs, /summon, the spawner). Skeletons get a bow,
 * zombies rarely an iron sword / shovel (Minecraft populateDefaultEquipmentSlots). Hostile mobs are refused
 * in peaceful. Returns the Mob or null.
 * @param {object} game  needs game.entities (EntityManager)
 * @param {string} mobType
 * @param {{ persistent?: boolean, yaw?: number }} [opts]
 */
export function spawnMob(game, mobType, x, y, z, { persistent = false, yaw } = {}) {
  const def = MOB_TYPES[mobType];
  const mgr = game?.entities;
  if (!def || !mgr || typeof mgr.add !== 'function') return null;
  if (!finite(x) || !finite(y) || !finite(z)) return null;
  if (def.hostile && game?.settings?.difficulty === 'peaceful') return null;
  const rnd = mgr.rng ?? Math.random;
  const m = new Mob(mobType, { persistent, rng: rnd });
  m.setPosition(x, y, z);
  const a = finite(yaw) ? yaw : rnd() * TAU - Math.PI;
  m.yaw = a; m.bodyYaw = a; m.headYaw = a;
  if (mobType === 'skeleton') m.heldItem = ITEM.BOW;
  else if (mobType === 'sheep') m.setFleece(randomFleece(rnd));
  else if (mobType === 'zombie' && rnd() < (game?.settings?.difficulty === 'hard' ? 0.05 : 0.01)) {
    m.heldItem = rnd() < 1 / 3 ? ITEM.IRON_SWORD : ITEM.IRON_SHOVEL;
  }
  const world = game.world;
  if (world) {
    m.updateLight(world);
    m.updateShadow(world);
  }
  return mgr.add(m);
}

// ===================================================================================================
// MobSpawner
// ===================================================================================================

/** Deterministic 0..1 hash of (seed, a, b, salt). */
function hash01(seed, a, b, salt) {
  let h = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(a, 0xc2b2ae35) ^ Math.imul(b, 0x27d4eb2f) ^ Math.imul(salt, 0x165667b1);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

function seededRng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickWeighted(rnd, types, weights) {
  let total = 0;
  for (const w of weights) total += w;
  let r = rnd() * total;
  for (let i = 0; i < types.length; i++) {
    r -= weights[i];
    if (r < 0) return types[i];
  }
  return types[types.length - 1];
}

/**
 * Natural spawning (SPEC-wave2 §3.3, Minecraft NaturalSpawner simplified): animals on first chunk generation
 * (10 % of grassy chunks, groups of 2–4), a rare passive spawn every ~20 s while fewer than 10 animals are
 * within 96 blocks, and every second (2 s on easy) a few hostile spawn attempts 24–64 blocks from the player
 * where it is dark enough (block light ≤ 7 and sky · daylight ≤ 7) with a cap of 20 hostiles within 128
 * blocks. Peaceful: no hostiles.
 */
export class MobSpawner {
  /**
   * @param {object} game  world, player, entities, settings, daylight / timeOfDay (read lazily)
   * @param {{ rng?: () => number }} [opts]
   */
  constructor(game, opts = {}) {
    this.game = game;
    this.rng = opts.rng ?? Math.random;
    this.hostileTimer = 1;
    this.passiveTimer = 20;
    /** Settings (tests may change them). */
    this.hostileCap = 20;
    this.passiveCap = 10;
    this.hostileAttempts = 3;
    this.minDistance = 24;
    this.maxDistance = 64;
    /** Statistics: spawned mobs by category. */
    this.stats = { hostile: 0, passive: 0, chunks: 0 };
  }

  /** Per-frame update (call while playing, after entities.update). */
  update(dt) {
    const game = this.game;
    if (!(dt > 0) || !game?.world || !game.entities) return;
    const players = playersOf(game);
    if (players.length === 0) return;
    const diff = game.settings?.difficulty ?? 'normal';
    this.hostileTimer -= dt;
    if (this.hostileTimer <= 0) {
      this.hostileTimer += diff === 'easy' ? 2 : 1;
      if (this.hostileTimer < 0) this.hostileTimer = 0.5;
      if (diff !== 'peaceful') {
        // Every player gets its own spawn attempts (multiplayer); the caps count mobs around that player.
        for (let i = 0; i < players.length; i++) {
          const p = players[i];
          if (!p || !finite(p.x)) continue;
          try { this.spawnHostiles(p); } catch (err) { console.error('[mobs] hostile spawning failed', err); }
        }
      }
    }
    this.passiveTimer -= dt;
    if (this.passiveTimer <= 0) {
      this.passiveTimer = 15 + this.rng() * 10;
      for (let i = 0; i < players.length; i++) {
        const p = players[i];
        if (!p || !finite(p.x)) continue;
        try { this.spawnPassive(p); } catch (err) { console.error('[mobs] passive spawning failed', err); }
      }
    }
  }

  /** Mobs of a category (hostile true / false) within `radius` blocks of player `p` (default: the player). */
  _count(hostile, radius, p = this._defaultPlayer()) {
    return this.game.entities.countEntities((e) => e.type === 'mob' && e.hostile === hostile && !e.dead, p.x, p.z, radius);
  }

  /** The single player (single player / tests), else the first one. */
  _defaultPlayer() {
    return this.game.player ?? playersOf(this.game)[0] ?? null;
  }

  /**
   * Light test for hostile spawns at the feet cell (SPEC: block light <= 7 and sky light · daylight <= 7),
   * randomised like Minecraft's Monster.isDarkEnoughToSpawn so a night fills up gradually: open sky rejects
   * sky/32 of the attempts, and the effective light must not exceed a random 0..7.
   */
  _darkEnough(world, x, y, z) {
    if (typeof world.getLight !== 'function') return false;
    const l = world.getLight(x, y, z);
    if (!finite(l)) return false;
    const sky = (l & 255) >> 4, blk = l & 15;
    const daylight = finite(this.game.daylight) ? this.game.daylight : 1;
    const eff = Math.max(blk, Math.floor(sky * daylight));
    if (blk > 7 || sky * daylight > 7) return false;
    const rnd = this.rng;
    if (sky > rnd() * 32) return false;
    return eff <= Math.floor(rnd() * 8);
  }

  /** True when any player is closer than minDistance to (x, y, z) (no spawning in someone's face). */
  _nearAnyPlayer(x, y, z) {
    const players = playersOf(this.game);
    if (players.length < 2) return false;      // the single player was already checked by the caller
    const m2 = this.minDistance * this.minDistance;
    for (let i = 0; i < players.length; i++) {
      const q = players[i];
      if (!q || !finite(q.x)) continue;
      const dx = x - q.x, dy = y - q.y, dz = z - q.z;
      if (dx * dx + dy * dy + dz * dz < m2) return true;
    }
    return false;
  }

  /** True if a mob of `type` fits at feet (x + 0.5, y, z + 0.5) on a solid opaque floor. */
  _spawnable(world, type, x, y, z, needOpaqueFloor) {
    const def = MOB_TYPES[type];
    if (y < 1 || y > 254) return false;
    const below = world.getBlock(x, y - 1, z);
    if (!getCollisionBox(below) || (needOpaqueFloor && !IS_OPAQUE[below])) return false;
    for (let k = 0; k < def.cells; k++) {
      const id = world.getBlock(x, y + k, z);
      if (getCollisionBox(id) || LIQUID_KIND[id]) return false;
    }
    const hw = def.width / 2;
    if (aabbIntersectsSolid(world, x + 0.5 - hw, y + 0.01, z + 0.5 - hw, x + 0.5 + hw, y + def.height, z + 0.5 + hw)) return false;
    return true;
  }

  _chunkReady(world, x, z) {
    if (typeof world.isChunkMeshed === 'function') return world.isChunkMeshed(x >> 4, z >> 4);
    return typeof world.isChunkGenerated !== 'function' || world.isChunkGenerated(x >> 4, z >> 4);
  }

  /**
   * One round of hostile spawn attempts: random columns 24–64 blocks from the player, half at the surface,
   * half at a random height (caves); groups of 1–4 of one type around a valid spot. Returns the number spawned.
   */
  spawnHostiles(p = this._defaultPlayer()) {
    const game = this.game;
    const world = game.world;
    if (!p || p.dead) return 0;
    let room = this.hostileCap - this._count(true, DESPAWN_FAR, p);
    if (room <= 0) return 0;
    const rnd = this.rng;
    let spawned = 0;
    for (let a = 0; a < this.hostileAttempts && room > 0; a++) {
      const ang = rnd() * TAU;
      const dist = this.minDistance + rnd() * (this.maxDistance - this.minDistance);
      const x = Math.floor(p.x + Math.cos(ang) * dist), z = Math.floor(p.z + Math.sin(ang) * dist);
      if (!this._chunkReady(world, x, z)) continue;
      const top = typeof world.getTopY === 'function' ? world.getTopY(x, z) : -1;
      if (top < 1) continue;
      const type = HOSTILE_TYPES[Math.floor(rnd() * HOSTILE_TYPES.length)];
      // half the attempts at the surface, half in a random height (caves): first air pocket upward
      let y = top + 1;
      if (rnd() < 0.5) {
        y = -1;
        for (let k = 0, y0 = 1 + Math.floor(rnd() * top); k < 16 && y0 + k <= top; k++) {
          if (this._validHostileSpot(world, type, x, y0 + k, z, p)) { y = y0 + k; break; }
        }
        if (y < 0) continue;
      } else if (!this._validHostileSpot(world, type, x, y, z, p)) {
        continue;
      }
      const group = 1 + Math.floor(rnd() * 3);
      for (let g = 0; g < group && room > 0; g++) {
        let gx = x, gy = y, gz = z;
        if (g > 0) {
          gx = x + Math.floor(rnd() * 7) - 3;
          gz = z + Math.floor(rnd() * 7) - 3;
          gy = groundNear(world, gx, y, gz, MOB_TYPES[type].cells, 3, 2);
          if (gy < 0 || !this._validHostileSpot(world, type, gx, gy, gz, p)) continue;
        }
        if (spawnMob(game, type, gx + 0.5, gy, gz + 0.5)) {
          spawned++;
          room--;
        }
      }
    }
    this.stats.hostile += spawned;
    return spawned;
  }

  _validHostileSpot(world, type, x, y, z, p) {
    if (!this._chunkReady(world, x, z)) return false;
    const dx = x + 0.5 - p.x, dy = y - p.y, dz = z + 0.5 - p.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 < this.minDistance * this.minDistance || d2 > DESPAWN_FAR * DESPAWN_FAR) return false;
    if (this._nearAnyPlayer(x + 0.5, y, z + 0.5)) return false;
    if (!this._spawnable(world, type, x, y, z, true)) return false;
    return this._darkEnough(world, x, y, z);
  }

  /** A group of 2–4 animals on lit grass 24–80 blocks away while fewer than 10 are within 96 blocks. */
  spawnPassive(p = this._defaultPlayer()) {
    const game = this.game;
    const world = game.world;
    if (!p || p.dead || this._count(false, 96, p) >= this.passiveCap) return 0;
    const rnd = this.rng;
    for (let a = 0; a < 4; a++) {
      const ang = rnd() * TAU;
      const dist = this.minDistance + rnd() * 56;
      const x = Math.floor(p.x + Math.cos(ang) * dist), z = Math.floor(p.z + Math.sin(ang) * dist);
      if (!this._chunkReady(world, x, z)) continue;
      const top = typeof world.getTopY === 'function' ? world.getTopY(x, z) : -1;
      if (top < 1 || world.getBlock(x, top, z) !== BLOCK.GRASS_BLOCK) continue;
      const y = top + 1;
      if (this._nearAnyPlayer(x + 0.5, y, z + 0.5)) continue;
      if (typeof world.getLight === 'function') {
        const l = world.getLight(x, y, z) & 255;
        if (Math.max(l >> 4, l & 15) <= 8) continue;      // Animal.isBrightEnoughToSpawn: raw light > 8
      }
      const type = pickWeighted(rnd, PASSIVE_TYPES, PASSIVE_WEIGHTS);
      const n = this._spawnGroup(world, type, x, z, 2 + Math.floor(rnd() * 3), rnd, 4);
      if (n > 0) {
        this.stats.passive += n;
        return n;
      }
    }
    return 0;
  }

  /** Spawn up to `count` animals of `type` on grass around column (x, z) (within ±spread). */
  _spawnGroup(world, type, x, z, count, rnd, spread) {
    let n = 0;
    for (let i = 0; i < count * 3 && n < count; i++) {
      const gx = i === 0 ? x : x + Math.floor(rnd() * (spread * 2 + 1)) - spread;
      const gz = i === 0 ? z : z + Math.floor(rnd() * (spread * 2 + 1)) - spread;
      const top = typeof world.getTopY === 'function' ? world.getTopY(gx, gz) : -1;
      if (top < 1 || world.getBlock(gx, top, gz) !== BLOCK.GRASS_BLOCK) continue;
      if (!this._spawnable(world, type, gx, top + 1, gz, false)) continue;
      if (spawnMob(this.game, type, gx + 0.5, top + 1, gz + 0.5, { persistent: true, yaw: rnd() * TAU - Math.PI })) n++;
    }
    return n;
  }

  /**
   * First generation of chunk (cx, cz) (World.onChunkGenerated): 10 % of the chunks (deterministic per world
   * seed and chunk) get a group of 2–4 animals of one type (pig / cow / sheep / chicken weighted 10/8/12/10)
   * on grass blocks with sky access. Returns the number spawned.
   */
  onChunkGenerated(cx, cz) {
    const game = this.game;
    const world = game?.world;
    if (!world || !game.entities) return 0;
    const seed = (world.seed ?? game.worldMeta?.seed ?? 0) >>> 0;
    if (hash01(seed, cx, cz, 1) >= 0.1) return 0;
    const rnd = seededRng(Math.floor(hash01(seed, cx, cz, 2) * 4294967296));
    const type = pickWeighted(rnd, PASSIVE_TYPES, PASSIVE_WEIGHTS);
    const count = 2 + Math.floor(rnd() * 3);
    // centre column: the first grass column found from a random start in the chunk
    for (let t = 0; t < 8; t++) {
      const x = cx * 16 + Math.floor(rnd() * 16), z = cz * 16 + Math.floor(rnd() * 16);
      const top = typeof world.getTopY === 'function' ? world.getTopY(x, z) : -1;
      if (top < 1 || world.getBlock(x, top, z) !== BLOCK.GRASS_BLOCK) continue;
      const n = this._spawnGroup(world, type, x, z, count, rnd, 3);
      if (n > 0) {
        this.stats.chunks++;
        this.stats.passive += n;
        return n;
      }
    }
    return 0;
  }
}

/** Passive / hostile type lists (for commands and tests). */
export const PASSIVE_MOBS = PASSIVE_TYPES;
export const HOSTILE_MOBS = HOSTILE_TYPES;
