// The player: Minecraft-faithful movement physics, survival status effects, hunger, knockback, the
// item-use state (eating / drawing a bow), death / respawn and the first-person camera
// (SPEC §9.7, SPEC-wave2 §3.5 and §4).
//
// Movement model. Minecraft integrates per 50 ms tick:  d = m + a·input  (displacement this tick),
// m' = d·f  (friction). The steady speed is 20·a/(1−f) b/s. We convert every regime to the equivalent
// continuous system  dv/dt = K·(vmax·input − v)  with  K = −20·ln f  and  vmax = 20·a/(1−f), and
// integrate it EXACTLY (exponential solution) per sub-step of <= 1/60 s, so walking 4.317 b/s,
// sprinting 5.612, sneaking 1.30, flying 10.89 / 21.78, ice sliding, water drag etc. come out
// identical at any frame rate. Vertical motion uses the same scheme (Minecraft drag 0.98/tick and
// gravity 0.08 b/tick² → K = 0.404/s, terminal velocity 78.4 b/s, i.e. gravity 31.7 b/s²).
// Details that matter for the feel are kept: 0.98 input scale, diagonal normalisation only above
// length 1, sneak ×0.3, sprint ×1.3 (air control 0.026), sprint-jump +0.2 b/tick boost, the jump tick
// still using ground friction (JUMP_TICK window), 10-tick jump cooldown while holding Space, the
// Minecraft sneak edge guard (0.05 back-off steps against a box lowered by 0.6), water/lava physics
// of 1.13+ (slow sink, Space/Shift swim, hop out of the water against a ledge, pushed by flowing
// liquids), creative flight (double-tap Space; Space/Shift up/down; landing ends it; sprint-fly ×2)
// and minor-collision rules for sprinting along walls. Using an item (eating, drawing a bow) slows
// the movement input to ×0.2 and stops sprinting.
//
// Hunger (Minecraft FoodData, 1.9+ numbers): food 0..20, saturation <= food (starts at 5), exhaustion;
// exhaustion > 4 costs one saturation point or, without saturation, one food point (never in
// peaceful). Costs: sprinting 0.1/m, swimming 0.01/m, jump 0.05, sprint-jump 0.2, attack 0.1, block
// break 0.005, damage taken 0.1, healing 6 per HP. Regeneration: food 20 with saturation → +1 HP
// (paid from saturation) every 0.5 s; food >= 18 → +1 HP every 4 s. Starvation at food 0: 1 damage
// every 4 s down to 10 HP (easy) / 1 HP (normal) / death (hard). Peaceful: +1 HP per second and +1 food
// per 0.5 s. Sprinting needs food > 6. Food side effects: rotten flesh (80 %) and raw chicken (30 %)
// give 30 s of Hunger (+0.1 exhaustion/s), spider eyes 5 s of Poison (1 damage per 1.25 s, never
// below 1 HP). Creative players accumulate no exhaustion.
import { PhysicsBody, aabbIntersectsSolid, raycast } from './physics.js';
import { Inventory } from './inventory.js';
import {
  BLOCKS, BLOCK, ITEM, IS_LIQUID, IS_OPAQUE, IS_SOLID, LIQUID_KIND, liquidHeight, getItem, SPAWN_EGG_MOBS,
} from '../world/registry.js';
import { PLAYER } from '../config.js';
import { clamp, lookVector } from '../util/math.js';

const TICKS = 20;
const DEG = Math.PI / 180;
const MAX_STEP = 1 / 60;                 // physics sub-step (s)
const MAX_FRAME = 0.25;                  // longer frames are clamped (tab switch, breakpoint)

// ---- look
/** Radians of yaw/pitch per mouse "look unit" (Minecraft: 0.15° per count at 100 % sensitivity). */
export const LOOK_RADIANS_PER_UNIT = 0.15 * DEG;
const MAX_PITCH = 89.9 * DEG;

// ---- ground / air (Minecraft attributes, per tick)
const INPUT_SCALE = 0.98;
const SNEAK_INPUT = 0.3;
const WALK_ACCEL = 0.1;                  // movement speed attribute
const SPRINT_MULT = 1.3;
const AIR_ACCEL = 0.02;
const AIR_ACCEL_SPRINT = 0.026;
const AIR_FRICTION = 0.91;
const K_AIR = -TICKS * Math.log(AIR_FRICTION);                       // 1.886 /s
const VMAX_AIR = TICKS * AIR_ACCEL / (1 - AIR_FRICTION);             // 4.44 b/s (×0.98 input)
const VMAX_AIR_SPRINT = TICKS * AIR_ACCEL_SPRINT / (1 - AIR_FRICTION);

// ---- vertical
const K_GRAVITY = -TICKS * Math.log(0.98);                           // 0.404 /s
/** Terminal fall speed (b/s) = 20 · 0.08 · 0.98 / 0.02. */
export const TERMINAL_VELOCITY = TICKS * 0.08 * 0.98 / 0.02;         // 78.4
/** Equivalent constant gravity (b/s²). */
export const GRAVITY = TERMINAL_VELOCITY * K_GRAVITY;                // 31.68
/** Jump take-off speed giving Minecraft's 1.2522-block jump apex under this drag model. */
export const JUMP_VELOCITY = 9.2474;
const SPRINT_JUMP_BOOST = 0.2 * TICKS;   // 4 b/s along the facing direction
const JUMP_TICK = 1 / TICKS;             // ground friction still applies during the jump tick
const JUMP_COOLDOWN = 10 / TICKS;        // noJumpDelay while Space is held

// ---- creative flight
const FLY_ACCEL = 0.05;
const VMAX_FLY = TICKS * FLY_ACCEL / (1 - AIR_FRICTION);             // 11.1 (×0.98 → 10.89 b/s)
const FLY_VERTICAL_SPEED = TICKS * 0.15 / (1 - 0.6);                 // 7.5 b/s
const K_FLY_VERTICAL = -TICKS * Math.log(0.6);

// ---- fluids (Minecraft 1.13+)
const K_WATER = -TICKS * Math.log(0.8);
const VMAX_WATER = TICKS * 0.02 / (1 - 0.8);                         // 2 (×0.98 → 1.96 b/s)
const WATER_SINK = 0.5;                  // idle sink speed (gravity/16 per tick)
const WATER_SWIM = 4.0;                  // Space +0.04 b/tick² → rise 3.5 b/s; Shift sinks 4.5 b/s
const K_LAVA = -TICKS * Math.log(0.5);
const VMAX_LAVA = TICKS * 0.02 / (1 - 0.5);                          // 0.8 b/s
const LAVA_SINK = 0.8;
const LAVA_SWIM = 1.6;                   // Space → rise 0.8 b/s
const FLUID_JUMP_THRESHOLD = 0.4;        // shallower than this (and on ground) → a normal jump
const FLUID_HOP_SPEED = 0.3 * TICKS;     // hop out of the water when pushing against a low ledge
/** Flowing liquids push with 0.014 (water) / 0.00233 (lava) b/tick² → target velocity shift (b/s). */
const WATER_FLOW_PUSH = TICKS * 0.014 / (1 - 0.8);                   // 1.4 b/s
const LAVA_FLOW_PUSH = TICKS * (0.014 / 6) / (1 - 0.5);              // 0.093 b/s
/**
 * Rendered surface height of a still liquid cell in wave 1 (kept for compatibility). The player now
 * uses registry liquidHeight() (Minecraft 1 − (level + 1)/9, full height under the same liquid).
 */
export const LIQUID_SURFACE = 14 / 16;

// ---- misc rules
const DOUBLE_TAP = 7 / TICKS;            // double-tap window for flight toggle and sprint
const EDGE_STEP = 0.05;                  // sneak edge guard back-off increment
const EDGE_DROP = 0.6;                   // max step height used by the edge guard probe
const MINOR_COLLISION = 0.13962634;      // 8°: sprinting survives glancing wall contact
const STEP_LENGTH = 0.6;                 // distance → step counter scale (a step per 1.67 blocks)
const FOV_SPRINT = 1.10;
const FOV_FLYING = 1.10;
const FOV_UNDERWATER = 60 / 70;
const THIRD_PERSON_DISTANCE = 4;

// ---- survival
export const MAX_HEALTH = 20;
export const MAX_AIR = 300;              // ticks
const HURT_DURATION = 0.5;               // s (10 ticks) — camera tilt / red flash
const INVULNERABLE_TIME = 1.0;           // s; only bigger hits apply during the first half
const VOID_Y = -64;
const FIRE_SECONDS = 15;

// ---- hunger (Minecraft FoodData; SPEC-wave2 §4)
export const MAX_FOOD = 20;
const START_SATURATION = 5;
const EXHAUSTION_PER_POINT = 4;
const MAX_EXHAUSTION = 40;
/** Exhaustion costs (Minecraft 1.9+). */
export const EXHAUSTION = Object.freeze({
  SPRINT: 0.1,          // per metre sprinted on the ground
  SWIM: 0.01,           // per metre moved in water (3D with the eyes under water)
  JUMP: 0.05,
  SPRINT_JUMP: 0.2,
  ATTACK: 0.1,          // per hit that landed
  BLOCK_BREAK: 0.005,   // per block broken in survival
  DAMAGE: 0.1,          // per damage event (see NO_HUNGER_DAMAGE)
  HEAL: 6,              // per health point regenerated from food
  HUNGER_EFFECT: 0.005, // per tick while the Hunger effect lasts
});
const REGEN_TICKS = 80;                  // food >= 18: +1 HP every 4 s
const FAST_REGEN_TICKS = 10;             // food 20 + saturation: +min(saturation, 6)/6 HP every 0.5 s
const STARVE_TICKS = 80;                 // food 0: 1 damage every 4 s
const PEACEFUL_HEAL_TICKS = 20;          // peaceful: +1 HP per second
const PEACEFUL_FOOD_TICKS = 10;          // peaceful: +1 food per 0.5 s
const POISON_INTERVAL = 25;              // Poison I: 1 damage every 25 ticks
const FOOD_TICK = 1 / TICKS;
/** Eating takes 32 ticks (Minecraft ItemFood use duration). */
export const EAT_TIME = 32 / TICKS;
/** Seconds of drawing for a full-power bow shot. */
export const BOW_FULL_DRAW = 1;
const USE_ITEM_SLOWDOWN = 0.2;           // movement input ×0.2 while using an item
const BOW_FOV_ZOOM = 0.15;               // a fully drawn bow narrows the FOV by 15 %
/** Standard knockback strength (Minecraft LivingEntity.knockback, blocks per tick). */
export const KNOCKBACK_STRENGTH = 0.4;
// Take-off speed giving Minecraft's knockback hop (vy 0.4 b/tick → 1.1531-block apex) under this drag model.
const KNOCKBACK_VY = 8.8607;

/**
 * Shown once per session on the action bar the first time the player sprints with Ctrl outside
 * fullscreen: browsers reserve Ctrl+W (close tab), so W pressed while Ctrl is held closes the game.
 */
export const CTRL_SPRINT_TIP = '提示：双击 W 即可疾跑 —— 按住 Ctrl 再按 W 会关闭浏览器标签页（全屏时不会）';
let ctrlSprintTipShown = false;

/** Chinese death messages per damage cause (mob kills: see deathMessageFor). */
export const DEATH_MESSAGES = Object.freeze({
  fall: '玩家摔死了',
  drown: '玩家淹死了',
  lava: '玩家试图在熔岩里游泳',
  fire: '玩家被烧死了',
  cactus: '玩家被戳死了',
  contact: '玩家被戳死了',
  void: '玩家掉出了这个世界',
  suffocation: '玩家在墙里窒息而亡',
  explosion: '玩家爆炸了',
  starve: '玩家饿死了',
  arrow: '玩家被箭射杀',
  magic: '玩家被魔法杀死了',
  poison: '玩家被魔法杀死了',
  kill: '玩家死了',
  generic: '玩家死了',
});
const BYPASS_CREATIVE = new Set(['void', 'kill']);
/** Damage causes that cost no exhaustion (Minecraft: sources that bypass armour). */
const NO_HUNGER_DAMAGE = new Set(['fall', 'drown', 'starve', 'suffocation', 'void', 'kill', 'generic', 'fire', 'poison', 'magic']);
/** Mob display names by mob type (pig → 猪 …) for death messages. */
const MOB_NAMES = Object.freeze(Object.fromEntries(SPAWN_EGG_MOBS));

/** Food side effects (Minecraft): item id → { effect, seconds, chance }. */
const FOOD_EFFECTS = new Map([
  [ITEM.ROTTEN_FLESH, { effect: 'hunger', seconds: 30, chance: 0.8 }],
  [ITEM.CHICKEN, { effect: 'hunger', seconds: 30, chance: 0.3 }],
  [ITEM.SPIDER_EYE, { effect: 'poison', seconds: 5, chance: 1 }],
]);

/** The entity a hit really comes from: the shooter of a projectile, else the entity itself. */
function damageSource(attacker) {
  if (!attacker || typeof attacker !== 'object') return null;
  const shooter = attacker.shooter ?? attacker.owner ?? null;
  return shooter && typeof shooter === 'object' ? shooter : attacker;
}

function mobDisplayName(e) {
  if (!e || typeof e !== 'object') return null;
  if (typeof e.mobType === 'string' && MOB_NAMES[e.mobType]) return MOB_NAMES[e.mobType];
  if (typeof e.displayName === 'string' && e.displayName) return e.displayName;
  return null;
}

/**
 * Minecraft-style Chinese death message for `cause` with an optional attacker (a mob, or a projectile
 * whose `shooter` is a mob): 玩家被僵尸杀死了 / 玩家被骷髅射杀 / 玩家被苦力怕炸死了 / 玩家被蜘蛛杀死了 …
 * @param {string} cause
 * @param {object|null} [attacker]
 */
export function deathMessageFor(cause, attacker = null) {
  const projectile = cause === 'arrow' || cause === 'projectile' ||
    (!!attacker && typeof attacker === 'object' && (attacker.type === 'arrow' || attacker.isProjectile === true));
  const name = mobDisplayName(damageSource(attacker));
  if (cause === 'explosion') return name ? `玩家被${name}炸死了` : DEATH_MESSAGES.explosion;
  if (projectile) return `玩家被${name ?? '箭'}射杀`;
  if (name) return `玩家被${name}杀死了`;
  return DEATH_MESSAGES[cause] ?? DEATH_MESSAGES.generic;
}

// Shared scratch for exact exponential integration (no allocations in the physics loop).
let _iv = 0;
let _id = 0;
/** Exact solution of dv/dt = K·(target − v) over h: sets _iv (new velocity) and _id (displacement). */
function integrate(v, target, K, h) {
  const e = Math.exp(-K * h);
  const d = v - target;
  _iv = target + d * e;
  _id = target * h + d * (1 - e) / K;
}

function shrinkTowardZero(d) {
  return d < EDGE_STEP && d >= -EDGE_STEP ? 0 : d > 0 ? d - EDGE_STEP : d + EDGE_STEP;
}

/** Fraction of the remaining gap closed after dt for a per-tick easing factor (Minecraft lerps). */
function ease(perTick, dt) {
  return 1 - Math.pow(1 - perTick, dt * TICKS);
}

function groundParams(slip, sprinting) {
  const f = slip * 0.91;
  const accel = WALK_ACCEL * (sprinting ? SPRINT_MULT : 1) * (0.216 / (slip * slip * slip));
  _gK = -TICKS * Math.log(f);
  _gV = TICKS * accel / (1 - f);
}
let _gK = 0;
let _gV = 0;

export class Player {
  /** @param {object} game  the game facade (SPEC §9.10); world/audio/particles are read lazily. */
  constructor(game) {
    this.game = game;
    this.body = new PhysicsBody(PLAYER.WIDTH, PLAYER.HEIGHT);
    this.yaw = 0;
    this.pitch = 0;
    /** 'survival' | 'creative' */
    this.mode = 'survival';
    this.flying = false;
    this.sneaking = false;
    this.sprinting = false;
    this.inWater = false;
    this.inLava = false;
    this.eyeInWater = false;
    this.eyeInLava = false;
    /** Depth of water / lava above the feet (blocks, 0 = not in it). */
    this.waterHeight = 0;
    this.lavaHeight = 0;
    this.health = MAX_HEALTH;
    /** Hunger (Minecraft FoodData): food 0..20, saturation 0..food, exhaustion 0..40. */
    this.food = MAX_FOOD;
    this.saturation = START_SATURATION;
    this.exhaustion = 0;
    /** Remaining food-effect durations in ticks (Minecraft Poison I / Hunger I from food). */
    this.poisonTicks = 0;
    this.hungerTicks = 0;
    /** Remaining breath in ticks (0..300). */
    this.air = MAX_AIR;
    this.dead = false;
    this.deathTime = 0;
    this.deathMessage = '';
    this.fallDistance = 0;
    /** Seconds left burning (after touching lava). */
    this.fireTime = 0;
    /** Seconds left of the hurt animation (camera tilt / red flash); counts down from hurtDuration. */
    this.hurtTime = 0;
    this.hurtDuration = HURT_DURATION;
    /** The entity that last hurt the player (mob, or projectile with a shooter), or null. */
    this.lastAttacker = null;
    /**
     * Item use in progress (driven by interaction.js): 'eat' | 'bow' | null, the item id, the hotbar
     * slot it came from and the seconds it has been used (useTime).
     */
    this.usingItem = null;
    this.useItemId = 0;
    this.useSlot = -1;
    this.useTime = 0;
    this.inventory = new Inventory(36);
    this.selectedSlot = 0;
    /** World spawn column; respawn() places the player on top of it. */
    this.spawnPoint = { x: 0, y: 64, z: 0 };
    /** True while physics waits for the surrounding chunks (world.isAreaReady). */
    this.frozen = false;

    this._eyeHeight = PLAYER.EYE_HEIGHT;   // smoothed camera eye height
    this._fovMod = 1;
    this._walkDist = 0;                     // view-bobbing phase (Minecraft walkDist)
    this._bob = 0;                          // view-bobbing amplitude
    this._lagYaw = 0;                       // hand sway (Minecraft xBob/yBob)
    this._lagPitch = 0;
    this._moveDist = 0;                     // step-sound distance counter
    this._nextStep = 1;
    this._jumpDelay = 0;
    this._jumpTap = 0;
    this._forwardTap = 0;
    this._groundTime = 0;
    this._groundWindow = 0;
    this._windowSlip = 0.6;
    this._kbExtraX = 0;                     // knockback displacement still owed during the ground window
    this._kbExtraZ = 0;
    this._invulnerable = 0;
    this._lastHurt = 0;
    this._drownTimer = 0;
    this._fireTimer = 0;
    this._foodTimer = 0;                    // FoodData.tickTimer (ticks)
    this._foodAcc = 0;                      // seconds not yet consumed by 20 Hz food ticks
    this._peacefulTicks = 0;
    this._wasInWater = false;
    this._snapPending = false;
    this._forcedSpawn = false;              // the pending respawn targets a personal spawn point
    this._sprintDust = 0;
    // Knockback bookkeeping (see knockback() / damage()): frame counter, the default knockback a hit
    // schedules for the next frame, the frame of the last explicit knockback and of the last attacker.
    this._frame = 0;
    this._kbFrame = -1;
    this._kbX = 0;
    this._kbZ = 0;
    this._kbS = 0;
    this._kbExplicitFrame = -1;
    this._attackerFrame = -1;
    this._blockedFrame = -1;
    // Flowing-liquid push (target velocity shift, b/s) computed once per frame.
    this._flowX = 0;
    this._flowY = 0;
    this._flowZ = 0;
    this._flowOut = [0, 0, 0];
    this._ctl = { ix: 0, iz: 0, forward: 0, jump: false, sneakKey: false };
    this._aabb = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };
    this._cam = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0, fov: 70 };
    this._bobOut = { x: 0, y: 0, roll: 0, pitch: 0 };
    this._swayOut = { yaw: 0, pitch: 0 };
    this._eye = [0, 0, 0];
    this._look = [0, 0, -1];
    this._look3p = [0, 0, -1];
  }

  // ------------------------------------------------------------------ body passthrough
  get x() { return this.body.x; }
  set x(v) { this.body.x = v; }
  get y() { return this.body.y; }
  set y(v) { this.body.y = v; }
  get z() { return this.body.z; }
  set z(v) { this.body.z = v; }
  get vx() { return this.body.vx; }
  set vx(v) { this.body.vx = v; }
  get vy() { return this.body.vy; }
  set vy(v) { this.body.vy = v; }
  get vz() { return this.body.vz; }
  set vz(v) { this.body.vz = v; }
  get onGround() { return this.body.onGround; }
  set onGround(v) { this.body.onGround = v; }
  get width() { return this.body.width; }
  get height() { return this.body.height; }
  /** Current (smoothed) eye height above the feet. */
  get eyeHeight() { return this._eyeHeight; }
  get creative() { return this.mode === 'creative'; }
  get onFire() { return this.fireTime > 0; }
  /** Difficulty from the settings: 'peaceful' | 'easy' | 'normal' (default) | 'hard'. */
  get difficulty() {
    const d = this.game?.remoteDifficulty ?? this.game?.settings?.difficulty;
    return d === 'peaceful' || d === 'easy' || d === 'hard' ? d : 'normal';
  }

  getAABB(out = this._aabb) {
    return this.body.getAABB(out);
  }

  getSelectedStack() {
    return this.inventory.get(this.selectedSlot);
  }

  /** Eye (camera) position without view bobbing. Writes into `out` (a reused array by default). */
  getEyePosition(out = this._eye) {
    out[0] = this.body.x;
    out[1] = this.body.y + this._eyeHeight;
    out[2] = this.body.z;
    return out;
  }

  getLookVector(out = this._look) {
    return lookVector(this.yaw, this.pitch, out);
  }

  // ------------------------------------------------------------------ frame update

  /**
   * Per-frame update: look, movement + physics (sub-stepped), flight/swimming, fall damage,
   * drowning, lava/fire/cactus/void/suffocation damage, hunger + regeneration, camera smoothing.
   * @param {number} dt  frame time (s)
   * @param {Input|null} input
   */
  update(dt, input) {
    dt = dt > 0 ? Math.min(dt, MAX_FRAME) : 0;
    this._frame++;
    this._tickTimers(dt);
    const world = this.game?.world;
    if (this.dead) {
      this._kbFrame = -1;
      if (this.usingItem) this.stopUsingItem();
      this.deathTime += dt;
      this._updateCamera(dt);
      return;
    }

    // Look (always allowed, even while the terrain is still loading).
    if (input) {
      this.yaw -= input.mouseDX * LOOK_RADIANS_PER_UNIT;
      this.pitch = clamp(this.pitch - input.mouseDY * LOOK_RADIANS_PER_UNIT, -MAX_PITCH, MAX_PITCH);
      if (this.yaw > Math.PI || this.yaw <= -Math.PI) {
        const wrapped = Math.atan2(Math.sin(this.yaw), Math.cos(this.yaw));
        this._lagYaw += wrapped - this.yaw;
        this.yaw = wrapped;
      }
    }

    const ready = !!world && (typeof world.isAreaReady !== 'function' ||
      world.isAreaReady(Math.floor(this.body.x), Math.floor(this.body.z), 1));
    this.frozen = !ready;
    if (!ready) {
      this._updateCamera(dt);
      return;
    }
    if (this._snapPending) this._snapToColumnTop(world);
    if (this.mode !== 'creative') this.flying = false;
    if (this._kbFrame >= 0) this._applyPendingKnockback(world);

    this._computeFlow(world);
    const ctl = this._readControls(input, world);
    const n = Math.max(1, Math.ceil(dt / MAX_STEP - 1e-9));
    const h = dt / n;
    for (let i = 0; i < n && h > 0; i++) this._step(h, world, ctl);

    this._updateFluids(world);
    this._updateEyeFluids(world);
    this._updateStatus(dt, world);
    this._updateCamera(dt);
  }

  // ------------------------------------------------------------------ controls

  _readControls(input, world) {
    const ctl = this._ctl;
    const has = !!input;
    const fwd = (has && input.isDown('forward') ? 1 : 0) - (has && input.isDown('back') ? 1 : 0);
    const str = (has && input.isDown('right') ? 1 : 0) - (has && input.isDown('left') ? 1 : 0);
    ctl.forward = fwd;
    ctl.jump = has && input.isDown('jump');
    ctl.sneakKey = has && input.isDown('sneak');

    // Creative: double-tap Space toggles flight.
    if (has && input.pressed('jump') && this.mode === 'creative') {
      if (this._jumpTap > 0) {
        this.flying = !this.flying;
        this._jumpTap = 0;
      } else {
        this._jumpTap = DOUBLE_TAP;
      }
    }

    // Sneaking (Shift while not flying); stays crouched while there is no head room to stand up.
    if (ctl.sneakKey && !this.flying) this._setSneaking(true);
    else if (this.sneaking) this._setSneaking(false, world);

    // Sprinting: double-tap W (on ground / flying) or the sprint key while moving forward. Not while
    // sneaking, swimming, using an item, or hungry (food <= 6, Minecraft).
    const using = this.usingItem !== null;
    const canSprint = !this.sneaking && !this.inWater && !this.inLava && !using &&
      (this.food > 6 || this.mode === 'creative');
    if (using) this._forwardTap = 0;
    if (has && input.pressed('forward') && canSprint && !this.sprinting && (this.body.onGround || this.flying)) {
      if (this._forwardTap > 0) {
        this.sprinting = true;
        this._forwardTap = 0;
      } else {
        this._forwardTap = DOUBLE_TAP;
      }
    }
    if (!this.sprinting && canSprint && fwd > 0 && has && input.isDown('sprint')) {
      this.sprinting = true;
      if (!ctrlSprintTipShown && input.fullscreen !== true && typeof this.game?.ui?.showActionText === 'function') {
        ctrlSprintTipShown = true;
        this.game.ui.showActionText(CTRL_SPRINT_TIP, 8);
      }
    }
    if (this.sprinting && (fwd <= 0 || !canSprint)) this.sprinting = false;

    let fw = fwd * INPUT_SCALE;
    let st = str * INPUT_SCALE;
    if (this.sneaking) { fw *= SNEAK_INPUT; st *= SNEAK_INPUT; }
    if (using) { fw *= USE_ITEM_SLOWDOWN; st *= USE_ITEM_SLOWDOWN; }
    const len2 = fw * fw + st * st;
    if (len2 > 1) {
      const l = Math.sqrt(len2);
      fw /= l; st /= l;
    }
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    // forward = (−sin yaw, −cos yaw), right = (cos yaw, −sin yaw)   (SPEC §4)
    ctl.ix = -sy * fw + cy * st;
    ctl.iz = -cy * fw - sy * st;
    return ctl;
  }

  /** Change the crouch state (and hitbox height). Standing up fails when the head would collide. */
  _setSneaking(on, world = this.game?.world) {
    if (on === this.sneaking) return true;
    const b = this.body;
    if (!on && world) {
      const hw = b.width / 2;
      if (aabbIntersectsSolid(world, b.x - hw, b.y, b.z - hw, b.x + hw, b.y + PLAYER.HEIGHT, b.z + hw)) return false;
    }
    this.sneaking = on;
    b.height = on ? PLAYER.SNEAK_HEIGHT : PLAYER.HEIGHT;
    if (on) this.sprinting = false;
    return true;
  }

  // ------------------------------------------------------------------ physics sub-step

  _step(h, world, ctl) {
    const b = this.body;
    this._updateFluids(world);
    const inWater = this.inWater;
    const inLava = this.inLava;
    if (inWater) {
      this.fallDistance = 0;
      this.fireTime = 0;
    } else if (inLava) {
      this.fallDistance *= Math.pow(0.5, h * TICKS);
    }
    if (this.flying) this.fallDistance = 0;
    if (inWater && !this._wasInWater) this._splash(world);
    this._wasInWater = inWater;
    if (inWater || inLava || this.flying) this._groundWindow = 0;
    if (this.sprinting && inWater) this.sprinting = false;

    // ---- jumping / swimming intent (Minecraft LivingEntity.aiStep)
    if (this._jumpDelay > 0) this._jumpDelay = Math.max(0, this._jumpDelay - h);
    if (!ctl.jump) this._jumpDelay = 0;
    const startedOnGround = b.onGround;
    let swimUp = false;
    if (ctl.jump && !this.flying) {
      const fluidH = inWater ? this.waterHeight : inLava ? this.lavaHeight : 0;
      if ((inWater || inLava) && !(startedOnGround && fluidH <= FLUID_JUMP_THRESHOLD)) swimUp = true;
      else if (startedOnGround && this._jumpDelay <= 0) this._jump(world, h);
    }

    // ---- horizontal velocity (exact exponential integration)
    const ix = ctl.ix, iz = ctl.iz;
    const inFluid = inWater || inLava;
    // Flowing liquids shift the target velocity (Minecraft adds 0.014 b/tick² along the flow).
    const fx = inFluid ? this._flowX : 0, fz = inFluid ? this._flowZ : 0;
    let dx, dz, nvx, nvz;
    if (inFluid || this.flying || startedOnGround || this._groundWindow <= 0) {
      this._kbExtraX = 0;
      this._kbExtraZ = 0;
      let K, vmax;
      if (inWater) { K = K_WATER; vmax = VMAX_WATER; }
      else if (inLava) { K = K_LAVA; vmax = VMAX_LAVA; }
      else if (this.flying) { K = K_AIR; vmax = VMAX_FLY * (this.sprinting ? 2 : 1); }
      else if (startedOnGround) { groundParams(this._slipperinessBelow(world), this.sprinting); K = _gK; vmax = _gV; }
      else { K = K_AIR; vmax = this.sprinting ? VMAX_AIR_SPRINT : VMAX_AIR; }
      integrate(b.vx, vmax * ix + fx, K, h); nvx = _iv; dx = _id;
      integrate(b.vz, vmax * iz + fz, K, h); nvz = _iv; dz = _id;
    } else {
      // Airborne right after a jump / knockback: the rest of the tick still uses ground friction.
      const t1 = Math.min(h, this._groundWindow);
      const t2 = h - t1;
      groundParams(this._windowSlip, this.sprinting);
      integrate(b.vx, _gV * ix, _gK, t1); nvx = _iv; dx = _id;
      integrate(b.vz, _gV * iz, _gK, t1); nvz = _iv; dz = _id;
      if (this._kbExtraX !== 0 || this._kbExtraZ !== 0) {
        const k = t1 / JUMP_TICK;
        dx += this._kbExtraX * k;
        dz += this._kbExtraZ * k;
      }
      if (t2 > 0) {
        const vmax = this.sprinting ? VMAX_AIR_SPRINT : VMAX_AIR;
        integrate(nvx, vmax * ix, K_AIR, t2); nvx = _iv; dx += _id;
        integrate(nvz, vmax * iz, K_AIR, t2); nvz = _iv; dz += _id;
      }
      this._groundWindow -= t1;
    }

    // ---- vertical velocity
    let vK, vTarget;
    if (this.flying) {
      vK = K_FLY_VERTICAL;
      vTarget = FLY_VERTICAL_SPEED * ((ctl.jump ? 1 : 0) - (ctl.sneakKey ? 1 : 0));
    } else if (inWater) {
      vK = K_WATER;
      vTarget = -WATER_SINK + (swimUp ? WATER_SWIM : 0) - (ctl.sneakKey ? WATER_SWIM : 0) + this._flowY;
    } else if (inLava) {
      vK = K_LAVA;
      vTarget = -LAVA_SINK + (swimUp ? LAVA_SWIM : 0) + this._flowY;
    } else {
      vK = K_GRAVITY;
      vTarget = -TERMINAL_VELOCITY;
    }
    integrate(b.vy, vTarget, vK, h);
    const nvy = _iv;
    const dy = _id;

    // ---- sneak edge guard (Minecraft maybeBackOffFromEdge)
    if (this.sneaking && startedOnGround && !this.flying && dy <= 0 && (dx !== 0 || dz !== 0)) {
      const ox = dx, oz = dz;
      this._backOffFromEdge(world, dx, dz);
      dx = _edgeX; dz = _edgeZ;
      if (dx !== ox) nvx = 0;
      if (dz !== oz) nvz = 0;
    }

    // ---- move
    const x0 = b.x, y0 = b.y, z0 = b.z;
    b.vx = nvx; b.vy = nvy; b.vz = nvz;
    b.move(world, dx, dy, dz);
    const mx = b.x - x0, my = b.y - y0, mz = b.z - z0;
    const hitWall = b.collidedX || b.collidedZ;

    if (hitWall && this.sprinting && !this._isMinorCollision(mx, mz, ix, iz)) this.sprinting = false;

    // Hop out of the water / lava when swimming against a ledge whose top is near the surface.
    if (hitWall && inFluid && this._isFreeForHop(world, y0)) {
      if (b.vy < FLUID_HOP_SPEED) b.vy = FLUID_HOP_SPEED;
    }

    // ---- ground contact, fall distance, landing
    if (b.onGround) {
      if (this.fallDistance > 0) {
        // Like Minecraft's checkFallDamage: a move that ends in water cancels the fall.
        this._updateFluids(world);
        if (this.inWater) {
          if (!this._wasInWater) this._splash(world);
          this._wasInWater = true;
        } else {
          this._land(world);
        }
      }
      this.fallDistance = 0;
      this._groundWindow = 0;
      if (this.flying) this.flying = false;
      this._groundTime = startedOnGround ? this._groundTime + h : 0;
    } else {
      if (my < 0 && !this.flying && !inWater) this.fallDistance -= my;
      this._groundTime = 0;
    }

    // ---- distance counters: hunger, view bobbing, step / swim sounds, sprint dust
    const hd = Math.sqrt(mx * mx + mz * mz);
    if (!this.flying) {
      // Minecraft Player.checkMovementStatistics: swimming 0.01/m (3D with the eyes under water),
      // sprinting on the ground 0.1/m; walking and sneaking are free.
      if (inWater) {
        const d = this.eyeInWater ? Math.sqrt(hd * hd + my * my) : hd;
        if (d > 0) this.addExhaustion(EXHAUSTION.SWIM * d);
      } else if (this.sprinting && b.onGround && hd > 0) {
        this.addExhaustion(EXHAUSTION.SPRINT * hd);
      }
    }
    this._walkDist += hd * STEP_LENGTH;
    if (hd > 0 && (b.onGround || inWater) && !this.flying) {
      this._moveDist += hd * STEP_LENGTH;
      if (this._moveDist > this._nextStep) {
        this._nextStep = Math.floor(this._moveDist) + 1;
        if (inWater) this._playSwim();
        else this._playStep(world);
      }
    }
    if (this.sprinting && b.onGround && hd > 0) {
      this._sprintDust -= h;
      if (this._sprintDust <= 0) {
        this._sprintDust = 0.15;
        const id = this._groundBlockId(world);
        if (id) this.game?.particles?.spawnBlockHit?.(_gbx, _gby, _gbz, 2, id);
      }
    }
  }

  _jump(world, h) {
    const b = this.body;
    b.vy = JUMP_VELOCITY;
    if (this.sprinting) {
      b.vx -= Math.sin(this.yaw) * SPRINT_JUMP_BOOST;
      b.vz -= Math.cos(this.yaw) * SPRINT_JUMP_BOOST;
    }
    this.addExhaustion(this.sprinting ? EXHAUSTION.SPRINT_JUMP : EXHAUSTION.JUMP);
    this._jumpDelay = JUMP_COOLDOWN;
    if (!this.inWater && !this.inLava) {
      // This sub-step already runs with ground friction; keep it for the rest of the jump tick.
      this._groundWindow = Math.max(0, JUMP_TICK - this._groundTime - h);
      this._windowSlip = this._slipperinessBelow(world);
    }
  }

  /** Minecraft maybeBackOffFromEdge: shrink (dx, dz) in 0.05 steps until there is ground below. */
  _backOffFromEdge(world, dx, dz) {
    const box = this.body.getAABB(this._aabb);
    while (dx !== 0 && this._wouldFall(world, box, dx, 0)) dx = shrinkTowardZero(dx);
    while (dz !== 0 && this._wouldFall(world, box, 0, dz)) dz = shrinkTowardZero(dz);
    while (dx !== 0 && dz !== 0 && this._wouldFall(world, box, dx, dz)) {
      dx = shrinkTowardZero(dx);
      dz = shrinkTowardZero(dz);
    }
    _edgeX = dx;
    _edgeZ = dz;
  }

  /** No collision for the box moved by (ox, −0.6, oz) = no ground within a step below. */
  _wouldFall(world, box, ox, oz) {
    return !aabbIntersectsSolid(world, box.minX + ox, box.minY - EDGE_DROP, box.minZ + oz,
      box.maxX + ox, box.maxY - EDGE_DROP, box.maxZ + oz);
  }

  /** A wall contact is "minor" when the actual motion stays within 8° of the wanted direction. */
  _isMinorCollision(mx, mz, ix, iz) {
    const a = ix * ix + iz * iz;
    const m = mx * mx + mz * mz;
    if (a < 1e-5 || m < 1e-10) return false;
    const c = clamp((ix * mx + iz * mz) / Math.sqrt(a * m), -1, 1);
    return Math.acos(c) < MINOR_COLLISION;
  }

  /** Box raised 0.6 above the sub-step start has neither solid blocks nor liquid in it. */
  _isFreeForHop(world, y0) {
    const b = this.body;
    const box = b.getAABB(this._aabb);
    const oy = y0 - b.y + 0.6;
    const ox = b.collidedX ? 0 : b.vx / TICKS;
    const oz = b.collidedZ ? 0 : b.vz / TICKS;
    const x0 = box.minX + ox, x1 = box.maxX + ox, z0 = box.minZ + oz, z1 = box.maxZ + oz;
    const y0b = box.minY + oy, y1b = box.maxY + oy;
    if (aabbIntersectsSolid(world, x0, y0b, z0, x1, y1b, z1)) return false;
    for (let y = Math.floor(y0b); y <= Math.floor(y1b - 1e-7); y++) {
      for (let z = Math.floor(z0); z <= Math.floor(z1 - 1e-7); z++) {
        for (let x = Math.floor(x0); x <= Math.floor(x1 - 1e-7); x++) {
          if (IS_LIQUID[world.getBlock(x, y, z)]) return false;
        }
      }
    }
    return true;
  }

  _slipperinessBelow(world) {
    const b = this.body;
    const id = world.getBlock(Math.floor(b.x), Math.floor(b.y - 0.5000001), Math.floor(b.z));
    return BLOCKS[id]?.slipperiness ?? 0.6;
  }

  /** Block the feet stand on (center first, then the AABB corners); sets _gbx/_gby/_gbz. 0 = none. */
  _groundBlockId(world) {
    const b = this.body;
    const y = Math.floor(b.y - 0.2);
    const hw = b.width / 2 - 0.001;
    for (let i = 0; i < 5; i++) {
      const px = i === 0 ? b.x : b.x + (i & 1 ? hw : -hw);
      const pz = i === 0 ? b.z : b.z + (i & 2 ? hw : -hw);
      const x = Math.floor(px), z = Math.floor(pz);
      const id = world.getBlock(x, y, z);
      if (id !== 0 && !IS_LIQUID[id]) {
        _gbx = x; _gby = y; _gbz = z;
        return id;
      }
    }
    return 0;
  }

  // ------------------------------------------------------------------ fluids

  /**
   * Water / lava depth above the feet. A liquid cell's surface is Minecraft's fluid height
   * (registry liquidHeight: source 8/9, flowing level L (8 − L)/9, falling 1), or the full cell when
   * the same liquid is above — so flowing water counts like still water.
   */
  _updateFluids(world) {
    const b = this.body;
    const hw = b.width / 2 - 0.001;
    const x0 = Math.floor(b.x - hw), x1 = Math.floor(b.x + hw);
    const z0 = Math.floor(b.z - hw), z1 = Math.floor(b.z + hw);
    const y0 = Math.floor(b.y + 0.001), y1 = Math.floor(b.y + b.height - 0.001);
    let water = 0, lava = 0;
    for (let y = y0; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          const id = world.getBlock(x, y, z);
          const kind = LIQUID_KIND[id];
          if (kind === 0) continue;
          const top = y + (LIQUID_KIND[world.getBlock(x, y + 1, z)] === kind ? 1 : liquidHeight(id));
          const depth = top - b.y;
          if (depth <= 0) continue;
          if (kind === 1) { if (depth > water) water = depth; }
          else if (depth > lava) lava = depth;
        }
      }
    }
    this.waterHeight = water;
    this.lavaHeight = lava;
    this.inWater = water > 0;
    this.inLava = lava > 0;
    b.inWater = this.inWater;
    b.inLava = this.inLava;
  }

  /** Eyes below the surface of the liquid cell they are in (same surface rule as _updateFluids). */
  _updateEyeFluids(world) {
    const b = this.body;
    const ey = b.y + this._eyeHeight;
    const x = Math.floor(b.x), y = Math.floor(ey), z = Math.floor(b.z);
    const id = world.getBlock(x, y, z);
    const kind = LIQUID_KIND[id];
    let inside = false;
    if (kind !== 0) {
      const top = y + (LIQUID_KIND[world.getBlock(x, y + 1, z)] === kind ? 1 : liquidHeight(id));
      inside = ey < top;
    }
    this.eyeInWater = inside && kind === 1;
    this.eyeInLava = inside && kind === 2;
  }

  /**
   * Flowing-liquid push (Minecraft Entity.updateFluidHeightAndDoFluidPushing): the flow directions
   * of the liquid cells overlapping the body (scaled down in cells shallower than 0.4) are averaged
   * per liquid and turned into a target velocity shift of 1.4 b/s (water) / 0.093 b/s (lava). Uses
   * `world.fluids.flowVector(x, y, z, out)` when the world simulates flowing liquids.
   */
  _computeFlow(world) {
    this._flowX = 0; this._flowY = 0; this._flowZ = 0;
    const fluids = world.fluids;
    if (!fluids || typeof fluids.flowVector !== 'function') return;
    const b = this.body;
    const hw = b.width / 2 - 0.001;
    const x0 = Math.floor(b.x - hw), x1 = Math.floor(b.x + hw);
    const z0 = Math.floor(b.z - hw), z1 = Math.floor(b.z + hw);
    const y0 = Math.floor(b.y + 0.001), y1 = Math.floor(b.y + b.height - 0.001);
    let wx = 0, wy = 0, wz = 0, wn = 0, lx = 0, ly = 0, lz = 0, ln = 0;
    const out = this._flowOut;
    for (let y = y0; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          const id = world.getBlock(x, y, z);
          const kind = LIQUID_KIND[id];
          if (kind === 0) continue;
          const depth = y + (LIQUID_KIND[world.getBlock(x, y + 1, z)] === kind ? 1 : liquidHeight(id)) - b.y;
          if (depth <= 0) continue;
          out[0] = 0; out[1] = 0; out[2] = 0;
          const r = fluids.flowVector(x, y, z, out);
          const v = r && typeof r === 'object' ? r : out;
          let vx = +(v[0] ?? v.x) || 0, vy = +(v[1] ?? v.y) || 0, vz = +(v[2] ?? v.z) || 0;
          if (depth < 0.4) { vx *= depth; vy *= depth; vz *= depth; }
          if (kind === 1) { wx += vx; wy += vy; wz += vz; wn++; } else { lx += vx; ly += vy; lz += vz; ln++; }
        }
      }
    }
    if (wn > 0) {
      this._flowX += wx / wn * WATER_FLOW_PUSH;
      this._flowY += wy / wn * WATER_FLOW_PUSH;
      this._flowZ += wz / wn * WATER_FLOW_PUSH;
    }
    if (ln > 0) {
      this._flowX += lx / ln * LAVA_FLOW_PUSH;
      this._flowY += ly / ln * LAVA_FLOW_PUSH;
      this._flowZ += lz / ln * LAVA_FLOW_PUSH;
    }
  }

  // ------------------------------------------------------------------ status effects

  _tickTimers(dt) {
    if (this.hurtTime > 0) this.hurtTime = Math.max(0, this.hurtTime - dt);
    if (this._invulnerable > 0) this._invulnerable = Math.max(0, this._invulnerable - dt);
    if (this._jumpTap > 0) this._jumpTap = Math.max(0, this._jumpTap - dt);
    if (this._forwardTap > 0) this._forwardTap = Math.max(0, this._forwardTap - dt);
  }

  _updateStatus(dt, world) {
    const survival = this.mode !== 'creative';
    const b = this.body;

    // Breath and drowning: 300 ticks of air, then 2 damage every second; refills 4 ticks per tick.
    if (this.eyeInWater && survival) {
      const before = this.air;
      this.air -= TICKS * dt;
      if (this.air <= 0) {
        this._drownTimer += before > 0 ? -this.air / TICKS : dt;
        this.air = 0;
        while (this._drownTimer >= 1 && !this.dead) {
          this._drownTimer -= 1;
          this.damage(2, 'drown');
        }
      }
    } else {
      this.air = Math.min(MAX_AIR, this.air + 4 * TICKS * dt);
      this._drownTimer = 0;
    }
    if (this.dead) return;

    // Lava: 4 damage per hit (the 0.5 s hurt cooldown paces it) and 15 s of burning.
    if (this.inLava) {
      if (survival) this.fireTime = FIRE_SECONDS;
      this.damage(4, 'lava');
      if (this.dead) return;
    }
    if (this.fireTime > 0) {
      if (this.inWater || !survival) {
        this.fireTime = 0;
        this._fireTimer = 0;
      } else {
        this.fireTime = Math.max(0, this.fireTime - dt);
        this._fireTimer += dt;
        if (this._fireTimer >= 1) {
          this._fireTimer -= 1;
          if (!this.inLava) this.damage(1, 'fire');
          if (this.dead) return;
        }
      }
    }

    // Contact damage (cactus): any touched cell of a damaging solid block.
    const contact = this._contactDamageBlock(world);
    if (contact) {
      this.damage(BLOCKS[contact].damage, contact === BLOCK.CACTUS ? 'cactus' : 'contact');
      if (this.dead) return;
    }

    // Void.
    if (b.y < VOID_Y) {
      this.damage(4, 'void');
      if (this.dead) return;
    }

    // Suffocation: head inside an opaque full block.
    if (survival && this._isHeadInWall(world)) {
      this.damage(1, 'suffocation');
      if (this.dead) return;
    }

    // Hunger, regeneration, starvation and food effects on Minecraft's 20 Hz tick.
    this._foodAcc += dt;
    while (this._foodAcc >= FOOD_TICK && !this.dead) {
      this._foodAcc -= FOOD_TICK;
      this._foodTick();
    }
  }

  /** One 50 ms tick of food effects + Minecraft FoodData.tick + the peaceful bonus (Player.aiStep). */
  _foodTick() {
    const difficulty = this.difficulty;
    const peaceful = difficulty === 'peaceful';
    // Food effects (Hunger I: 0.005 exhaustion per tick; Poison I: 1 damage every 25 ticks, not below 1 HP).
    if (this.hungerTicks > 0) {
      this.hungerTicks--;
      this.addExhaustion(EXHAUSTION.HUNGER_EFFECT);
    }
    if (this.poisonTicks > 0) {
      if (this.poisonTicks % POISON_INTERVAL === 0 && this.health > 1) this.damage(1, 'poison');
      this.poisonTicks--;
      if (this.dead) return;
    }
    // FoodData.tick
    if (this.exhaustion > EXHAUSTION_PER_POINT) {
      this.exhaustion -= EXHAUSTION_PER_POINT;
      if (this.saturation > 0) this.saturation = Math.max(0, this.saturation - 1);
      else if (!peaceful) this.food = Math.max(0, this.food - 1);
    }
    const hurt = this.health > 0 && this.health < MAX_HEALTH;
    if (this.saturation > 0 && hurt && this.food >= MAX_FOOD) {
      if (++this._foodTimer >= FAST_REGEN_TICKS) {
        const f = Math.min(this.saturation, 6);
        this.heal(f / 6);
        this.addExhaustion(f);
        this._foodTimer = 0;
      }
    } else if (this.food >= 18 && hurt) {
      if (++this._foodTimer >= REGEN_TICKS) {
        this.heal(1);
        this.addExhaustion(EXHAUSTION.HEAL);
        this._foodTimer = 0;
      }
    } else if (this.food <= 0) {
      if (++this._foodTimer >= STARVE_TICKS) {
        if (this.health > 10 || difficulty === 'hard' || (this.health > 1 && difficulty === 'normal')) {
          this.damage(1, 'starve');
        }
        this._foodTimer = 0;
      }
    } else {
      this._foodTimer = 0;
    }
    // Peaceful: health regenerates and the food bar refills.
    if (peaceful && !this.dead) {
      this._peacefulTicks = (this._peacefulTicks + 1) % PEACEFUL_HEAL_TICKS;
      if (this._peacefulTicks === 0 && this.health < MAX_HEALTH) this.heal(1);
      if (this._peacefulTicks % PEACEFUL_FOOD_TICKS === 0 && this.food < MAX_FOOD) this.food++;
    }
  }

  _contactDamageBlock(world) {
    const b = this.body;
    const hw = b.width / 2 - 1e-4;
    const x0 = Math.floor(b.x - hw), x1 = Math.floor(b.x + hw);
    const z0 = Math.floor(b.z - hw), z1 = Math.floor(b.z + hw);
    const y0 = Math.floor(b.y + 1e-4), y1 = Math.floor(b.y + b.height - 1e-4);
    for (let y = y0; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          const id = world.getBlock(x, y, z);
          if (id && !IS_LIQUID[id] && BLOCKS[id].damage > 0) return id;
        }
      }
    }
    return 0;
  }

  _isHeadInWall(world) {
    const b = this.body;
    const ey = Math.floor(b.y + this._eyeHeight);
    const r = b.width * 0.4;
    for (let i = 0; i < 4; i++) {
      const x = Math.floor(b.x + (i & 1 ? r : -r));
      const z = Math.floor(b.z + (i & 2 ? r : -r));
      const id = world.getBlock(x, ey, z);
      if (IS_OPAQUE[id] && IS_SOLID[id]) return true;
    }
    return false;
  }

  // ------------------------------------------------------------------ hunger / food

  /** Add exhaustion (Minecraft Player.causeFoodExhaustion); ignored in creative and when dead. */
  addExhaustion(amount) {
    if (!(amount > 0) || this.dead || this.mode === 'creative') return;
    this.exhaustion = Math.min(MAX_EXHAUSTION, this.exhaustion + amount);
  }

  /** Minecraft FoodData.eat: +hunger (max 20) and +saturation (capped at the new food level). */
  eat(hunger, saturation) {
    if (!(hunger >= 0) || !(saturation >= 0)) return;
    this.food = Math.min(MAX_FOOD, this.food + hunger);
    this.saturation = Math.min(this.food, this.saturation + saturation);
  }

  /**
   * Apply a food item (items.js `food: { hunger, saturation }`) and its Minecraft side effects
   * (rotten flesh / raw chicken → Hunger, spider eye → Poison). Returns false if the item is not food.
   * @param {number} itemId
   * @param {() => number} [rng]
   */
  consumeFood(itemId, rng = Math.random) {
    const food = getItem(itemId)?.food;
    if (!food) return false;
    this.eat(food.hunger, food.saturation);
    const fx = FOOD_EFFECTS.get(itemId);
    if (fx && rng() < fx.chance) this.addEffect(fx.effect, fx.seconds);
    return true;
  }

  /** Start (or extend) a food effect: 'poison' | 'hunger' for `seconds`. */
  addEffect(effect, seconds) {
    const ticks = Math.max(0, Math.round(seconds * TICKS));
    if (effect === 'poison') this.poisonTicks = Math.max(this.poisonTicks, ticks);
    else if (effect === 'hunger') this.hungerTicks = Math.max(this.hungerTicks, ticks);
  }

  /** Minecraft Player.canEat: creative players always can, survival players while food < 20. */
  canEat() {
    return !this.dead && (this.mode === 'creative' || this.food < MAX_FOOD);
  }

  // ------------------------------------------------------------------ item use (eating, bow)

  /** Begin using the item in hotbar `slot` ('eat' | 'bow'); interaction.js drives the use. */
  startUsingItem(kind, itemId, slot) {
    this.usingItem = kind;
    this.useItemId = itemId;
    this.useSlot = slot;
    this.useTime = 0;
    this.sprinting = false;
  }

  stopUsingItem() {
    this.usingItem = null;
    this.useItemId = 0;
    this.useSlot = -1;
    this.useTime = 0;
  }

  // ------------------------------------------------------------------ damage / knockback

  /**
   * Apply damage. Returns true if any damage was dealt. Creative players only take 'void'/'kill'.
   * Minecraft hurt cooldown: for 0.5 s after a hit only a bigger hit applies (the difference).
   * A full hit from an `attacker` (mob, or projectile with a `shooter`) knocks the player back away
   * from it (0.4, Minecraft) on the next frame unless knockback() is called for the same hit.
   * @param {number} amount half-hearts
   * @param {string} cause  key of DEATH_MESSAGES ('fall','drown','lava','fire','cactus','void','mob','arrow',...)
   * @param {string} [message] custom death message
   * @param {object|null} [attacker] entity that caused the damage (death message, knockback)
   */
  damage(amount, cause = 'generic', message, attacker = null) {
    if (this.dead || !(amount > 0)) return false;
    if (this.mode === 'creative' && !BYPASS_CREATIVE.has(cause)) return false;
    let dealt;
    let fullHit = false;
    if (this._invulnerable > INVULNERABLE_TIME / 2) {
      if (amount <= this._lastHurt) {
        if (attacker) this._blockedFrame = this._frame;   // a knockback() for this hit is ignored too
        return false;
      }
      dealt = amount - this._lastHurt;
      this._lastHurt = amount;
    } else {
      dealt = amount;
      fullHit = true;
      this._lastHurt = amount;
      this._invulnerable = INVULNERABLE_TIME;
      this.hurtTime = HURT_DURATION;
    }
    this.health = Math.max(0, this.health - dealt);
    if (!NO_HUNGER_DAMAGE.has(cause)) this.addExhaustion(EXHAUSTION.DAMAGE);
    if (attacker && typeof attacker === 'object') {
      this.lastAttacker = attacker;
      this._attackerFrame = this._frame;
      if (fullHit && cause !== 'explosion' && this._kbExplicitFrame !== this._frame) {
        const src = damageSource(attacker);
        if (src && Number.isFinite(src.x) && Number.isFinite(src.z)) {
          this._kbFrame = this._frame;
          this._kbX = this.body.x - src.x;
          this._kbZ = this.body.z - src.z;
          this._kbS = KNOCKBACK_STRENGTH;
        }
      }
    }
    if (this.health <= 0) {
      this._die(cause, message, attacker);
    } else if (fullHit) {
      this._sound('hurt');
    }
    return true;
  }

  heal(amount) {
    if (this.dead || !(amount > 0)) return;
    this.health = Math.min(MAX_HEALTH, this.health + amount);
  }

  /**
   * Knock the player back (Minecraft LivingEntity.knockback): the velocity is halved, `strength`
   * blocks/tick (0.4 = a normal hit) are added horizontally along (dx, dz) — the direction AWAY from
   * the source — plus a 0.4 b/tick hop. Ignored in creative and when dead. When an attacker damaged
   * the player during this frame the push is oriented away from it whatever the sign of (dx, dz), and
   * it replaces the default knockback damage() scheduled for that hit.
   * @returns {boolean} true if applied
   */
  knockback(dx, dz, strength = KNOCKBACK_STRENGTH) {
    if (this.dead || this.mode === 'creative' || !(strength > 0)) return false;
    // Minecraft knocks back only with a hit that landed: not after one swallowed by the hurt cooldown.
    if (this._blockedFrame === this._frame && this._attackerFrame !== this._frame) return false;
    let x = Number.isFinite(dx) ? dx : 0;
    let z = Number.isFinite(dz) ? dz : 0;
    if (this._attackerFrame === this._frame) {
      const src = damageSource(this.lastAttacker);
      if (src && Number.isFinite(src.x) && Number.isFinite(src.z)) {
        const ax = this.body.x - src.x, az = this.body.z - src.z;
        if (x * ax + z * az < 0) { x = -x; z = -z; }
      }
    }
    this._kbExplicitFrame = this._frame;
    if (this._kbFrame === this._frame) this._kbFrame = -1;
    this._applyKnockback(x, z, Math.min(strength, 4), this.game?.world);
    return true;
  }

  _applyPendingKnockback(world) {
    const f = this._kbFrame;
    this._kbFrame = -1;
    if (f !== this._kbExplicitFrame && this.mode !== 'creative') this._applyKnockback(this._kbX, this._kbZ, this._kbS, world);
  }

  _applyKnockback(dx, dz, strength, world) {
    const b = this.body;
    let len = Math.sqrt(dx * dx + dz * dz);
    if (!(len > 1e-4)) {
      // Minecraft picks a tiny random direction when the source is exactly at the target.
      const a = Math.random() * Math.PI * 2;
      dx = Math.cos(a); dz = Math.sin(a); len = 1;
    }
    const s = strength * TICKS / len;
    b.vx = b.vx / 2 + dx * s;
    b.vz = b.vz / 2 + dz * s;
    b.vy = Math.min(KNOCKBACK_VY, b.vy / 2 + KNOCKBACK_VY * Math.min(1, strength / KNOCKBACK_STRENGTH));
    if (b.onGround && !this.inWater && !this.inLava) {
      // Like a jump: lifted off the ground, but the first tick still uses ground friction. Minecraft
      // moves the whole knockback velocity during that tick and applies the friction afterwards; the
      // exponential window covers less ground, so the difference is added over the window.
      b.onGround = false;
      const slip = world ? this._slipperinessBelow(world) : 0.6;
      this._groundWindow = JUMP_TICK;
      this._windowSlip = slip;
      const f = slip * 0.91;
      const lag = JUMP_TICK * (1 - (1 - f) / -Math.log(f));
      this._kbExtraX = b.vx * lag;
      this._kbExtraZ = b.vz * lag;
    }
  }

  /** Kill the player outright (also in creative), e.g. /kill. */
  kill(message) {
    if (this.dead) return;
    this.health = 0;
    this.hurtTime = HURT_DURATION;
    this._die('kill', message);
  }

  _die(cause, message, attacker = null) {
    const b = this.body;
    this.dead = true;
    this.health = 0;
    this.deathTime = 0;
    this.flying = false;
    this.sprinting = false;
    this.stopUsingItem();
    this._kbFrame = -1;
    this._setSneaking(false);
    b.vx = 0; b.vz = 0;
    this.deathMessage = typeof message === 'string' && message ? message : deathMessageFor(cause, attacker);
    if (this.mode !== 'creative') this._dropInventory();
    this._sound('death');
    this.game?.emit?.('playerDied', this.deathMessage);
  }

  /** Survival death: scatter the whole inventory like Minecraft (2 s pickup delay). */
  _dropInventory() {
    const g = this.game;
    if (!g || typeof g.spawnItem !== 'function') return;
    const b = this.body;
    const inv = this.inventory;
    for (let i = 0; i < inv.size; i++) {
      const s = inv.get(i);
      if (!s) continue;
      const speed = Math.random() * 0.5 * TICKS;
      const angle = Math.random() * Math.PI * 2;
      g.spawnItem({ id: s.id, count: s.count, damage: s.damage ?? 0 },
        b.x, b.y + PLAYER.EYE_HEIGHT - 0.3, b.z,
        -Math.sin(angle) * speed, 0.2 * TICKS, Math.cos(angle) * speed, 2);
    }
    inv.clear();
  }

  _land(world) {
    const fd = this.fallDistance;
    const id = this._groundBlockId(world);
    if (fd > 3 && this.mode !== 'creative') {
      const dmg = Math.ceil(fd - 3 - 1e-4);
      if (dmg > 0) {
        // Minecraft causeFallDamage: the small / big fall sound on top of the hurt sound.
        this._sound(dmg > 4 ? 'fall_big' : 'fall_small');
        this.damage(dmg, 'fall');
        if (id) {
          const bursts = Math.min(6, 1 + Math.ceil(dmg / 2));
          for (let i = 0; i < bursts; i++) this.game?.particles?.spawnBlockHit?.(_gbx, _gby, _gbz, 2, id);
        }
      }
    }
    if (fd >= 0.5 && id) {
      const b = this.body;
      this.game?.audio?.playBlock?.('land', BLOCKS[id].sound, b.x, b.y, b.z);
      this._nextStep = this._moveDist + 1;   // no extra footstep right after the landing thud
    }
  }

  _playStep(world) {
    const id = this._groundBlockId(world);
    if (!id) return;
    const b = this.body;
    this.game?.audio?.playBlock?.('step', BLOCKS[id].sound, b.x, b.y, b.z);
  }

  _playSwim() {
    const b = this.body;
    const v = Math.sqrt(b.vx * b.vx * 0.2 + b.vy * b.vy + b.vz * b.vz * 0.2) / TICKS;
    const volume = Math.min(1, v * 0.35);
    if (volume > 0.01) this._sound('swim', volume);
  }

  _splash(world) {
    const b = this.body;
    const v = Math.sqrt(b.vx * b.vx * 0.2 + b.vy * b.vy + b.vz * b.vz * 0.2) / TICKS;
    const volume = Math.min(1, v * 0.2);
    if (volume < 0.02) return;
    const bx = Math.floor(b.x), by = Math.floor(b.y), bz = Math.floor(b.z);
    const id = world.getBlock(bx, by, bz);
    let sy = by + LIQUID_SURFACE;
    if (LIQUID_KIND[id] !== 0) {
      sy = by + (LIQUID_KIND[world.getBlock(bx, by + 1, bz)] === LIQUID_KIND[id] ? 1 : liquidHeight(id));
    }
    this.game?.audio?.play?.('splash', { x: b.x, y: sy, z: b.z, volume });
    if (volume >= 0.1) this.game?.particles?.spawnSplash?.(b.x, sy, b.z);
  }

  _sound(name, volume = 1) {
    const b = this.body;
    this.game?.audio?.play?.(name, { x: b.x, y: b.y + this._eyeHeight, z: b.z, volume });
  }

  // ------------------------------------------------------------------ camera

  _updateCamera(dt) {
    // Smooth crouch eye height (Minecraft Camera: eyeHeight += (target − eyeHeight)·0.5 per tick).
    const eyeTarget = this.sneaking ? PLAYER.SNEAK_EYE_HEIGHT : PLAYER.EYE_HEIGHT;
    this._eyeHeight += (eyeTarget - this._eyeHeight) * ease(0.5, dt);
    if (Math.abs(eyeTarget - this._eyeHeight) < 1e-4) this._eyeHeight = eyeTarget;
    // FOV modifier (flying ×1.1, sprinting ×1.1, drawing a bow up to ×0.85), eased 0.5 per tick.
    let fovTarget = (this.flying ? FOV_FLYING : 1) * (this.sprinting ? FOV_SPRINT : 1);
    if (this.usingItem === 'bow') {
      let f = this.useTime / BOW_FULL_DRAW;
      f = f > 1 ? 1 : f * f;
      fovTarget *= 1 - f * BOW_FOV_ZOOM;
    }
    this._fovMod += (fovTarget - this._fovMod) * ease(0.5, dt);
    // View-bob amplitude follows the horizontal motion while on the ground (0.4 per tick).
    const b = this.body;
    const hs = Math.sqrt(b.vx * b.vx + b.vz * b.vz);
    const bobTarget = b.onGround && !this.dead && !this.flying ? Math.min(0.1, hs / TICKS * 0.546) : 0;
    this._bob += (bobTarget - this._bob) * ease(0.4, dt);
    // Hand sway: the held item lags behind the view rotation (0.5 per tick).
    this._lagYaw += (this.yaw - this._lagYaw) * ease(0.5, dt);
    this._lagPitch += (this.pitch - this._lagPitch) * ease(0.5, dt);
  }

  /**
   * View-bobbing state: view-space translation (x, y in blocks) and rotations (roll, pitch in
   * radians) Minecraft applies to the camera and the first-person hand. Zero when bobbing is off.
   */
  getViewBob(out = this._bobOut) {
    const enabled = this.game?.settings?.viewBobbing !== false && !this.dead;
    if (!enabled || this._bob < 1e-5) {
      out.x = 0; out.y = 0; out.roll = 0; out.pitch = 0;
      return out;
    }
    const f1 = -this._walkDist * Math.PI;
    const bob = this._bob;
    const s = Math.sin(f1);
    out.x = s * bob * 0.5;
    out.y = -Math.abs(Math.cos(f1) * bob);
    out.roll = -s * bob * 3 * DEG;
    out.pitch = -Math.abs(Math.cos(f1 - 0.2) * bob) * 5 * DEG;
    return out;
  }

  /** Hand sway angles (radians): how far the held item lags behind the view rotation (Minecraft ×0.1). */
  getHandSway(out = this._swayOut) {
    out.yaw = (this.yaw - this._lagYaw) * 0.1;
    out.pitch = (this.pitch - this._lagPitch) * 0.1;
    return out;
  }

  /**
   * Camera for the renderer: eye position (with view bobbing), yaw, pitch, roll (hurt tilt, bobbing,
   * death tilt), vertical fov in degrees (settings.fov × sprint/flying/bow modifier, narrower under water).
   * `perspective` (F5): 0 = first person, 1 = third person behind, 2 = third person in front looking
   * back; third-person cameras sit 4 blocks away, pulled in when a block is in the way (Minecraft
   * Camera.getMaxZoom). Returns a reused object unless `out` is given.
   */
  getCameraState(out = this._cam, perspective = 0) {
    const b = this.body;
    let x = b.x, y = b.y + this._eyeHeight, z = b.z;
    let pitch = this.pitch;
    let roll = 0;
    const bob = this.getViewBob();
    if (bob.x !== 0 || bob.y !== 0) {
      // The scene is translated by (bob.x, bob.y) in view space = the camera moves the other way.
      const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
      const sp = Math.sin(this.pitch), cp = Math.cos(this.pitch);
      // right = (cos yaw, 0, −sin yaw); up = (sin yaw·sin pitch, cos pitch, cos yaw·sin pitch)
      x -= bob.x * cy + bob.y * sy * sp;
      y -= bob.y * cp;
      z -= -bob.x * sy + bob.y * cy * sp;
      roll += bob.roll;
      pitch += bob.pitch;
    }
    if (this.hurtTime > 0) {
      const f = this.hurtTime / this.hurtDuration;
      roll += Math.sin(f * f * f * f * Math.PI) * 14 * DEG;
    }
    let fov = (Number.isFinite(this.game?.settings?.fov) ? this.game.settings.fov : 70) * this._fovMod;
    if (this.eyeInWater) fov *= FOV_UNDERWATER;
    if (this.dead) {
      const t = Math.min(this.deathTime * TICKS, 20);
      roll -= (40 - 8000 / (t + 200)) * DEG;
      fov /= (1 - 500 / (t + 500)) * 2 + 1;
    }
    out.x = x; out.y = y; out.z = z;
    out.yaw = this.yaw;
    out.pitch = clamp(pitch, -MAX_PITCH, MAX_PITCH);
    out.roll = roll;
    out.fov = fov;
    if (perspective === 1 || perspective === 2) {
      if (perspective === 2) {
        out.yaw = this.yaw + Math.PI;
        out.pitch = -out.pitch;
      }
      const f = lookVector(out.yaw, out.pitch, this._look3p);
      const dist = this._thirdPersonDistance(x, y, z, f, THIRD_PERSON_DISTANCE);
      out.x = x - f[0] * dist;
      out.y = y - f[1] * dist;
      out.z = z - f[2] * dist;
    }
    return out;
  }

  /** Minecraft Camera.getMaxZoom: shorten the camera boom when any of 8 offset rays hits a block. */
  _thirdPersonDistance(x, y, z, f, distance) {
    const world = this.game?.world;
    if (!world) return distance;
    for (let i = 0; i < 8; i++) {
      const ox = ((i & 1) * 2 - 1) * 0.1;
      const oy = (((i >> 1) & 1) * 2 - 1) * 0.1;
      const oz = (((i >> 2) & 1) * 2 - 1) * 0.1;
      const hit = raycast(world, x + ox, y + oy, z + oz, -f[0], -f[1], -f[2], distance);
      if (hit && hit.distance < distance) distance = hit.distance;
    }
    return Math.max(0, distance - 0.05);
  }

  // ------------------------------------------------------------------ teleport / modes / respawn

  /** Teleport (feet position). Clears velocity and fall distance. */
  setPosition(x, y, z) {
    const b = this.body;
    b.setPosition(x, y, z);
    b.vx = 0; b.vy = 0; b.vz = 0;
    b.onGround = false;
    this.fallDistance = 0;
    this._groundWindow = 0;
    this._kbFrame = -1;
    this._snapPending = false;
  }

  /** 'survival' | 'creative'. Leaving creative stops flying. */
  setGameMode(mode) {
    if (mode !== 'survival' && mode !== 'creative') return;
    this.mode = mode;
    if (mode !== 'creative') this.flying = false;
    else {
      this.fireTime = 0;
      this.fallDistance = 0;
      this.poisonTicks = 0;
    }
  }

  /**
   * Respawn with full health, food and air (emits 'playerRespawned' unless { emit: false } — use that
   * for the first spawn). The world spawn puts the player on the highest solid / liquid block of the
   * spawn column; a personal spawn point (/spawnpoint: `spawnPoint.forced`, or any point that differs
   * from the world spawn) is used exactly when its feet and head cells are free of solid blocks and
   * liquids, else the player falls back to the world spawn with a chat notice (Minecraft). The column
   * is resolved as soon as its chunk is loaded.
   */
  respawn({ emit = true } = {}) {
    const b = this.body;
    this.dead = false;
    this.deathTime = 0;
    this.deathMessage = '';
    this.health = MAX_HEALTH;
    this.food = MAX_FOOD;
    this.saturation = START_SATURATION;
    this.exhaustion = 0;
    this.poisonTicks = 0;
    this.hungerTicks = 0;
    this.air = MAX_AIR;
    this.fireTime = 0;
    this.hurtTime = 0;
    this.lastAttacker = null;
    this._invulnerable = 0;
    this._lastHurt = 0;
    this._drownTimer = 0;
    this._fireTimer = 0;
    this._foodTimer = 0;
    this._foodAcc = 0;
    this._kbFrame = -1;
    this.stopUsingItem();
    this.flying = false;
    this.sprinting = false;
    this._setSneaking(false);
    this.pitch = 0;
    const sp = this.spawnPoint ?? { x: 0, y: 64, z: 0 };
    const forced = this._isPersonalSpawn(sp);
    this._moveToSpawn(sp);
    this._forcedSpawn = forced;
    const world = this.game?.world;
    if (world && this._spawnAreaReady(world)) this._snapToColumnTop(world);
    if (emit) this.game?.emit?.('playerRespawned');
  }

  /** Place the feet at the spawn cell's bottom centre and wait for its chunk (_snapPending). */
  _moveToSpawn(sp) {
    const sx = Number.isFinite(sp?.x) ? sp.x : 0;
    const sz = Number.isFinite(sp?.z) ? sp.z : 0;
    this.setPosition(Math.floor(sx) + 0.5, Number.isFinite(sp?.y) ? sp.y : 64, Math.floor(sz) + 0.5);
    this._snapPending = true;
  }

  _spawnAreaReady(world) {
    return typeof world.isAreaReady !== 'function' ||
      world.isAreaReady(Math.floor(this.body.x), Math.floor(this.body.z), 1);
  }

  /** A /spawnpoint position (explicit `forced` flag, or different from the world spawn). */
  _isPersonalSpawn(sp) {
    if (!sp || typeof sp !== 'object') return false;
    if (typeof sp.forced === 'boolean') return sp.forced;
    const ws = this.game?.worldMeta?.spawn;
    if (!ws || !Number.isFinite(sp.y)) return false;
    return Math.floor(ws.x) !== Math.floor(sp.x) || Math.floor(ws.z) !== Math.floor(sp.z) ||
      Math.floor(ws.y) !== Math.floor(sp.y);
  }

  /**
   * Resolve the respawn position once its chunk is loaded: a personal spawn point is kept when the
   * feet and head cells are free (Minecraft isPossibleToRespawnInThis), otherwise (and for the world
   * spawn) the player stands on the highest solid or liquid block of the column — plants, torches and
   * other blocks without collision do not count.
   */
  _snapToColumnTop(world) {
    this._snapPending = false;
    const b = this.body;
    const bx = Math.floor(b.x), bz = Math.floor(b.z);
    if (this._forcedSpawn) {
      this._forcedSpawn = false;
      const y = Math.floor(b.y);
      if (y >= 0 && y < 255 && this._freeForRespawn(world, bx, y, bz) && this._freeForRespawn(world, bx, y + 1, bz)) {
        b.y = y;
        b.vy = 0;
        this.fallDistance = 0;
        return;
      }
      this.game?.addChatMessage?.('你的重生点已被阻挡', undefined);
      const ws = this.game?.worldMeta?.spawn;
      if (ws && Number.isFinite(ws.x) && Number.isFinite(ws.z)) {
        this._moveToSpawn(ws);
        if (!this._spawnAreaReady(world)) return;   // resolved by update() once that chunk is loaded
        this._snapPending = false;
      }
    }
    const x = Math.floor(b.x), z = Math.floor(b.z);
    let top = typeof world.getTopY === 'function' ? world.getTopY(x, z) : -1;
    if (!(top >= 0)) top = 255;
    // Highest motion-blocking block (solid or liquid) of the loaded column.
    while (top >= 0) {
      const id = world.getBlock(x, top, z);
      if (IS_SOLID[id] || IS_LIQUID[id]) break;
      top--;
    }
    if (top >= 0) {
      b.y = top + 1;
      b.vy = 0;
      this.fallDistance = 0;
    }
  }

  _freeForRespawn(world, x, y, z) {
    const id = world.getBlock(x, y, z);
    return !IS_SOLID[id] && !IS_LIQUID[id];
  }

  // ------------------------------------------------------------------ persistence

  serialize() {
    const b = this.body;
    return {
      x: b.x, y: b.y, z: b.z, vx: b.vx, vy: b.vy, vz: b.vz,
      yaw: this.yaw, pitch: this.pitch,
      mode: this.mode, flying: this.flying,
      health: this.health, food: this.food, saturation: this.saturation, exhaustion: this.exhaustion,
      foodTimer: this._foodTimer, poisonTicks: this.poisonTicks, hungerTicks: this.hungerTicks,
      air: this.air, fireTime: this.fireTime, fallDistance: this.fallDistance,
      dead: this.dead, deathMessage: this.deathMessage,
      selectedSlot: this.selectedSlot,
      spawnPoint: typeof this.spawnPoint.forced === 'boolean'
        ? { x: this.spawnPoint.x, y: this.spawnPoint.y, z: this.spawnPoint.z, forced: this.spawnPoint.forced }
        : { x: this.spawnPoint.x, y: this.spawnPoint.y, z: this.spawnPoint.z },
      inventory: this.inventory.serialize(),
    };
  }

  /** Restore from serialize() output (tolerates missing / invalid fields). Keeps the same Inventory object. */
  deserialize(obj) {
    if (!obj || typeof obj !== 'object') return;
    const num = (v, d) => (Number.isFinite(v) ? v : d);
    const b = this.body;
    b.setPosition(num(obj.x, b.x), num(obj.y, b.y), num(obj.z, b.z));
    b.vx = num(obj.vx, 0); b.vy = num(obj.vy, 0); b.vz = num(obj.vz, 0);
    this.yaw = num(obj.yaw, 0);
    this.pitch = clamp(num(obj.pitch, 0), -MAX_PITCH, MAX_PITCH);
    this._lagYaw = this.yaw;
    this._lagPitch = this.pitch;
    this.setGameMode(obj.mode === 'creative' ? 'creative' : 'survival');
    this.flying = this.mode === 'creative' && !!obj.flying;
    this.health = clamp(num(obj.health, MAX_HEALTH), 0, MAX_HEALTH);
    this.food = clamp(Math.round(num(obj.food, MAX_FOOD)), 0, MAX_FOOD);
    this.saturation = clamp(num(obj.saturation, START_SATURATION), 0, this.food);
    this.exhaustion = clamp(num(obj.exhaustion, 0), 0, MAX_EXHAUSTION);
    this._foodTimer = clamp(Math.floor(num(obj.foodTimer, 0)), 0, REGEN_TICKS);
    this.poisonTicks = clamp(Math.floor(num(obj.poisonTicks, 0)), 0, 20 * 60 * TICKS);
    this.hungerTicks = clamp(Math.floor(num(obj.hungerTicks, 0)), 0, 20 * 60 * TICKS);
    this.air = clamp(num(obj.air, MAX_AIR), 0, MAX_AIR);
    this.fireTime = Math.max(0, num(obj.fireTime, 0));
    this.fallDistance = Math.max(0, num(obj.fallDistance, 0));
    this.dead = !!obj.dead || this.health <= 0;
    this.deathMessage = this.dead ? (typeof obj.deathMessage === 'string' && obj.deathMessage ? obj.deathMessage : DEATH_MESSAGES.generic) : '';
    if (this.dead) this.health = 0;
    this.selectedSlot = clamp(Math.floor(num(obj.selectedSlot, 0)), 0, 8);
    const sp = obj.spawnPoint;
    if (sp && Number.isFinite(sp.x) && Number.isFinite(sp.z)) {
      this.spawnPoint = { x: sp.x, y: num(sp.y, 64), z: sp.z };
      if (typeof sp.forced === 'boolean') this.spawnPoint.forced = sp.forced;
    }
    const restored = Inventory.deserialize(obj.inventory, this.inventory.size);
    for (let i = 0; i < this.inventory.size; i++) this.inventory.slots[i] = restored.slots[i];
    this.inventory.changed();
    this.stopUsingItem();
    this._kbFrame = -1;
    this._snapPending = false;
  }
}

// Scratch outputs of helpers (module level: no per-call allocations).
let _edgeX = 0;
let _edgeZ = 0;
let _gbx = 0;
let _gby = 0;
let _gbz = 0;
