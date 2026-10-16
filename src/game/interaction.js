// Block / entity targeting, attacking, breaking, placing, block use, item use (eating, bows, spawn
// eggs, hoes, seeds, buckets), pick block, item dropping, hotbar selection and the first-person hand
// animation (SPEC §9.7, HandState §9.5, SPEC-wave2 §3.5 and §4).
//
// Minecraft rules reproduced here:
//   * targeting (GameRenderer.pick): blocks within 4.5 (survival) / 5 (creative) from the eye, liquids
//     are not targetable; mobs are searched along the same ray up to the block hit — a mob closer than
//     the block is targeted instead (no block outline, no mining, no placing behind it); attack reach
//     is 3 (survival) / 5 (creative) and a mob between that and the block makes the ray MISS. Blocks
//     without a collision box (short grass, flowers, crops, torches) do not shield mobs (modern
//     behaviour; 1.8 made tall grass eat the clicks).
//   * attacking (Player.attack, 1.8 style without cooldown): on click, damage = held tool damage
//     (items.js tool.damage, hand / other items 1), ×1.5 critical hit while falling (not on ground,
//     not in water, not flying) with crit particles; Mob.hurt(damage, 'player', player) applies the
//     standard knockback; sprinting adds 0.5 b/tick of knockback along the view (and stops the sprint,
//     the player slows to 60 %); swords lose 1 durability, other tools 2; exhaustion 0.1.
//   * survival breaking: progress += dt / getBreakTime(block, held item, {eye in water, on ground});
//     crack stage = floor(progress·10); "hit" sound every 4 ticks + crack particles; 5-tick
//     (0.25 s) delay after a block breaks; instant blocks break on contact (max one per tick while
//     sweeping); switching target or item restarts; bedrock & co. never progress.
//   * on break: setBlock(AIR), drops popped like Minecraft (±0.25 jitter, 0.2 b/tick up, 0.5 s
//     pickup delay), break particles + sound, tool durability −1 (swords −2) unless the block is
//     instant-break, "break_tool" when it breaks, exhaustion 0.005. Survival-broken ice above a solid
//     block or liquid turns into water.
//   * creative: instant breaking (not with a sword), 0.15 s repeat while held, no drops.
//   * right click (Minecraft.startUseItem): 1) interactive block (unless sneaking with an item);
//     2) the item on the clicked face: hoe tills grass / dirt with air above into farmland (not from
//     below, −1 durability), wheat seeds plant wheat on the top face of farmland, spawn eggs spawn
//     their mob on the face (creative keeps the egg), block items are placed; 3) the item itself:
//     buckets (source blocks only), food (hold 1.6 s while food < 20 or in creative: crunch sounds +
//     particles every 4 ticks from tick 8, then food, side effects and a burp), bows (hold up to 1 s
//     with arrows or in creative, release to shoot via entities.spawnArrow with Minecraft's power curve
//     f = (t² + 2t)/3 → speed f·3 b/tick, crit at full draw, one arrow + 1 durability in survival).
//     While an item is used the player walks at 20 %, cannot sprint, attack or pick blocks; releasing
//     the button (or switching slots) ends the use. Held right button repeats every 4 ticks.
//   * sounds (Minecraft 1.9+ names): attack_hit / attack_crit when a hit lands, attack_swish when the
//     mob shrugs it off, bow_shoot, hoe_till, eat (crunches) + burp.
//   * placing: into the clicked block if it is replaceable (short grass, …, not the same block),
//     else into the neighbour cell across the clicked face (must be replaceable: air, liquids,
//     plants); placement variants from getPlacementBlock; support rules from registry canStay (floor
//     support, wall torches need the block behind, cactus needs free sides, sugar cane water next to
//     its ground); torches fall back to the floor / another wall like Minecraft's StandingAndWallBlockItem;
//     refused if the block's collision box intersects the player or a non-item entity; survival
//     consumes one item; nothing is placed while mining a block. Successful uses that change the
//     stack (or any use in creative) re-equip the hand (Minecraft itemUsed dip).
//   * pick block (MMB): Minecraft Inventory.setPickedItem (creative) / pickSlot (survival).
//   * drop: Q one item, Ctrl+Q the whole stack, key repeat while held; via game.dropFromPlayer.
//   * hotbar: keys 1–9 and the wheel (wheel down = next slot).
//   * hand: 0.3 s swing (restartable from its second half), equip animation when the held item
//     changes (lower to 0, swap, raise; 0.4 per tick), view bobbing and turning sway, item use state.
import { raycast, rayBox, boxesIntersect } from './physics.js';
import { makeStack } from './inventory.js';
import { EAT_TIME, BOW_FULL_DRAW } from './player.js';
import {
  BLOCKS, BLOCK, ITEM, IS_REPLACEABLE, IS_LIQUID, IS_SOLID, LIQUID_KIND, LIQUID_LEVEL, RENDER, RENDER_TYPE,
  getBreakTime, getDrops, getPlacementBlock, canStay, getCollisionBox, getSelectionBox,
  itemForBlock, getItem, isBlockItem, blockId,
} from '../world/registry.js';
import { FACE_NORMALS, PLAYER } from '../config.js';

const TICKS = 20;
/** Duration of one arm swing (Minecraft: 6 ticks). */
export const SWING_TIME = 6 / TICKS;
/** Attack reach for entities (Minecraft 1.8 pick: 3 in survival); creative 5. */
export const ENTITY_REACH_SURVIVAL = 3;
export const ENTITY_REACH_CREATIVE = 5;
/** Damage of a hit without a tool (and with non-tool items). */
export const HAND_DAMAGE = 1;
/** Critical hit multiplier (falling). */
export const CRIT_MULTIPLIER = 1.5;
const SPRINT_KNOCKBACK = 0.5 * TICKS;     // extra knockback when sprinting (0.5 b/tick along the view)
const SPRINT_KNOCKBACK_LIFT = 0.1 * TICKS;
const ENTITY_PICK_MARGIN = 0.1;           // Minecraft entity pick radius (getPickRadius / border 0.1)
const CREATIVE_BREAK_REPEAT = 0.15;
const BREAK_DELAY = 5 / TICKS;            // destroyDelay after a survival block break
const INSTANT_BREAK_INTERVAL = 1 / TICKS; // max one instant-break block per tick when sweeping
const HIT_SOUND_INTERVAL = 4 / TICKS;
const HIT_PARTICLE_INTERVAL = 2 / TICKS;
const USE_REPEAT = 4 / TICKS;             // rightClickDelay
const DROP_REPEAT_DELAY = 0.5;            // keyboard auto-repeat for a held Q
const DROP_REPEAT = 0.05;
const EQUIP_RATE = 0.4 * TICKS;           // equip height change per second
const ITEM_PICKUP_DELAY = 0.5;
const THROWN_PICKUP_DELAY = 2;
const EAT_TICKS = Math.round(EAT_TIME * TICKS);   // 32
const BOW_MIN_POWER = 0.1;                // weaker releases do not shoot
const ARROW_SPEED = 3 * TICKS;            // b/s at full power (Minecraft 3 b/tick)
const ARROW_BASE_DAMAGE = 2;
const ARROW_INACCURACY = 0.0075;          // Minecraft shoot(): gaussian · 0.0075 · inaccuracy (1 for players)
const HOTBAR_ACTIONS = ['hotbar1', 'hotbar2', 'hotbar3', 'hotbar4', 'hotbar5', 'hotbar6', 'hotbar7', 'hotbar8', 'hotbar9'];

// Torch-like block items (placement type 'torch'): floor + wall variants by name.
const TORCH_VARIANTS = new Map();
for (const b of BLOCKS) {
  const p = b.placement;
  if (!p || p.type !== 'torch') continue;
  TORCH_VARIANTS.set(b.id, {
    floor: blockId(p.floor), north: blockId(p.north), south: blockId(p.south), east: blockId(p.east), west: blockId(p.west),
  });
}
const TILLABLE = new Set([BLOCK.GRASS_BLOCK, BLOCK.DIRT, BLOCK.SNOWY_GRASS_BLOCK]);
const FARMLAND_IDS = new Set([BLOCK.FARMLAND, BLOCK.FARMLAND_MOIST]);

// spawnMob(game, mobType, x, y, z, opts) from mobs.js, loaded on demand (the module may not exist in
// stripped-down builds; a failed load is retried at most every 5 s, and only when an egg is used).
let mobsModule = null;
let mobsLoading = null;
let mobsFailedAt = -Infinity;
const MOBS_RETRY_MS = 5000;
function nowMs() {
  return globalThis.performance ? globalThis.performance.now() : Date.now();
}
function loadMobsModule() {
  if (mobsModule) return Promise.resolve(mobsModule);
  if (!mobsLoading) {
    if (nowMs() - mobsFailedAt < MOBS_RETRY_MS) return Promise.resolve(null);
    mobsLoading = import('./mobs.js').then((m) => {
      mobsModule = m;
      return m;
    }, (err) => {
      mobsLoading = null;
      if (mobsFailedAt === -Infinity) console.warn('[interaction] mobs.js is not available, spawn eggs do nothing:', err?.message ?? err);
      mobsFailedAt = nowMs();
      return null;
    });
  }
  return mobsLoading;
}

/** Standard normal sample (Box-Muller; no allocation). */
function gaussian(rng) {
  let u = rng();
  if (u < 1e-12) u = 1e-12;
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

/** A living mob that can be targeted and hit (SPEC-wave2 Mob: type 'mob', hurt(), health). */
function isAttackable(e) {
  return !!e && e.removed !== true && e.dead !== true && e.dying !== true && e.type === 'mob' &&
    typeof e.hurt === 'function' && !(e.health <= 0);
}

const _hitBox = { t: 0, face: 0 };

/**
 * Voxel ray for buckets (Minecraft ClipContext.Fluid.SOURCE_ONLY): stops at block selection boxes and
 * at liquid SOURCE cells; flowing / falling liquid is see-through. Returns { x, y, z, face, blockId,
 * distance } or null.
 */
export function bucketRaycast(world, ox, oy, oz, dx, dy, dz, maxDist) {
  const len = Math.hypot(dx, dy, dz);
  if (len === 0) return null;
  dx /= len; dy /= len; dz /= len;
  let x = Math.floor(ox), y = Math.floor(oy), z = Math.floor(oz);
  const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
  const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;
  const tDeltaX = stepX ? Math.abs(1 / dx) : Infinity;
  const tDeltaY = stepY ? Math.abs(1 / dy) : Infinity;
  const tDeltaZ = stepZ ? Math.abs(1 / dz) : Infinity;
  let tMaxX = stepX > 0 ? (x + 1 - ox) / dx : stepX < 0 ? (x - ox) / dx : Infinity;
  let tMaxY = stepY > 0 ? (y + 1 - oy) / dy : stepY < 0 ? (y - oy) / dy : Infinity;
  let tMaxZ = stepZ > 0 ? (z + 1 - oz) / dz : stepZ < 0 ? (z - oz) / dz : Infinity;
  let t = 0;
  for (let guard = 0; guard < 1024 && t <= maxDist; guard++) {
    if (y >= 0 && y < 256) {
      const id = world.getBlock(x, y, z);
      if (id !== 0 && (!IS_LIQUID[id] || LIQUID_LEVEL[id] === 0)) {
        const box = getSelectionBox(id);
        const hit = rayBox(ox, oy, oz, dx, dy, dz,
          x + box[0], y + box[1], z + box[2], x + box[3], y + box[4], z + box[5], _hitBox);
        if (hit && hit.t <= maxDist) return { x, y, z, face: hit.face, blockId: id, distance: hit.t };
      }
    }
    if (tMaxX < tMaxY) {
      if (tMaxX < tMaxZ) { x += stepX; t = tMaxX; tMaxX += tDeltaX; }
      else { z += stepZ; t = tMaxZ; tMaxZ += tDeltaZ; }
    } else if (tMaxY < tMaxZ) {
      y += stepY; t = tMaxY; tMaxY += tDeltaY;
    } else {
      z += stepZ; t = tMaxZ; tMaxZ += tDeltaZ;
    }
  }
  return null;
}

export class Interaction {
  /** @param {object} game  game facade: player, world, audio, particles, entities, ui, spawnItem, dropFromPlayer */
  constructor(game) {
    this.game = game;
    /** Targeted block { x, y, z, face, blockId, distance, px, py, pz } or null. */
    this.target = null;
    /** Targeted mob (closer than the targeted block, within attack reach) or null. */
    this.targetEntity = null;
    /** Distance from the eye to the targeted mob. */
    this.targetEntityDistance = 0;
    /** Survival mining state { x, y, z, progress 0..1, stage 0..9, blockId, toolId } or null. */
    this.breaking = null;
    /**
     * Optional override for spawning mobs from spawn eggs: (game, mobType, x, y, z, opts) => mob.
     * Defaults to spawnMob from mobs.js (loaded on demand).
     */
    this.spawnMob = null;
    /** Random source for arrow spread and food effects (tests may replace it). */
    this.rng = Math.random;

    this._target = { x: 0, y: 0, z: 0, face: 0, blockId: 0, distance: 0, px: 0, py: 0, pz: 0 };
    this._breaking = { x: 0, y: 0, z: 0, progress: 0, stage: 0, blockId: 0, toolId: 0 };
    this._mining = false;                 // survival mining in progress (even before progress shows)
    this._selection = { x: 0, y: 0, z: 0, box: null };
    this._hand = {
      itemId: 0, swing: -0, equip: -0, bobX: -0, bobY: -0, light: 0xf0,
      bobRoll: -0, bobPitch: -0, swayYaw: -0, swayPitch: -0, count: 0,
      useAction: null, useProgress: -0, useTime: -0,
    };
    this._swingTime = -1;                 // < 0: not swinging
    this._handItem = 0;                   // item currently drawn in the hand
    this._equip = 0;                      // 0 lowered .. 1 raised
    this._breakDelay = 0;
    this._instantCooldown = 0;
    this._creativeRepeat = 0;
    this._hitSound = 0;
    this._hitParticles = 0;
    this._useRepeat = 0;
    this._useTicks = 0;                   // whole ticks of the current item use
    this._useAcc = 0;
    this._dropTimer = 0;
    this._errors = new Set();
    this._blockBox = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };
    this._entityBox = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };
    this._entityHit = { entity: null, distance: 0 };
    this._rayOpts = { exclude: null, filter: isAttackable };
    this._eye = [0, 0, 0];
    this._dir = [0, 0, -1];
    this._cell = [0, 0, 0];
    this._breakOpts = { inWater: false, onGround: true };
    this._getBlock = (x, y, z) => {
      const w = this.game?.world;
      return w ? w.getBlock(x, y, z) : 0;
    };
  }

  /** Selection outline for the renderer: { x, y, z, box } (box relative to the block) or null. */
  get selection() {
    const t = this.target;
    if (!t) return null;
    const s = this._selection;
    s.x = t.x; s.y = t.y; s.z = t.z;
    s.box = getSelectionBox(t.blockId);
    return s;
  }

  /** Crack stage for the renderer (−1 = none). */
  get breakStage() {
    return this.breaking ? this.breaking.stage : -1;
  }

  /** Start (or restart from its second half) the 0.3 s arm swing. */
  swing() {
    if (this._swingTime < 0 || this._swingTime >= SWING_TIME / 2) this._swingTime = 0;
  }

  /**
   * Per-frame update (after player.update).
   * @param {number} dt
   * @param {Input|null} input
   */
  update(dt, input) {
    dt = dt > 0 ? Math.min(dt, 0.25) : 0;
    const player = this.game?.player;
    this._updateActions(dt, input, player, this.game?.world);
    // Animate after this frame's actions so a new swing / item switch shows up immediately.
    this._updateHand(dt, player);
  }

  _updateActions(dt, input, player, world) {
    if (!player || !world || player.dead) {
      this.target = null;
      this.targetEntity = null;
      this._cancelMining();
      if (player?.usingItem) player.stopUsingItem();
      return;
    }
    if (this._breakDelay > 0) this._breakDelay = Math.max(0, this._breakDelay - dt);
    if (this._instantCooldown > 0) this._instantCooldown = Math.max(0, this._instantCooldown - dt);

    if (input) this._handleHotbar(input, player);
    this._updateTarget(world, player);
    if (!input || player.frozen) {
      this._cancelMining();
      if (player.usingItem) player.stopUsingItem();
      return;
    }
    this._handleDrop(dt, input, player);
    if (player.usingItem) {
      // Minecraft: while an item is in use, attack and pick-block clicks are swallowed.
      this._cancelMining();
      this._updateUsing(dt, input, player, world);
      return;
    }
    if (input.pressed('pickBlock')) this.pickBlock();
    this._handleAttack(dt, input, player, world);
    this._handleUse(dt, input, player, world);
  }

  // ------------------------------------------------------------------ targeting

  _updateTarget(world, player) {
    const eye = player.getEyePosition(this._eye);
    const dir = player.getLookVector(this._dir);
    const creative = player.mode === 'creative';
    const reach = creative ? PLAYER.REACH_CREATIVE : PLAYER.REACH_SURVIVAL;
    const hit = raycast(world, eye[0], eye[1], eye[2], dir[0], dir[1], dir[2], reach);
    this.targetEntity = null;
    if (hit) {
      const t = this._target;
      t.x = hit.x; t.y = hit.y; t.z = hit.z;
      t.face = hit.face; t.blockId = hit.blockId; t.distance = hit.distance;
      t.px = hit.px; t.py = hit.py; t.pz = hit.pz;
      this.target = t;
    } else {
      this.target = null;
    }
    // Mobs along the ray, up to the block hit (Minecraft GameRenderer.pick). Blocks without a collision
    // box (short grass, flowers, crops, torches) do not shield mobs standing in / behind them.
    const shield = hit && getCollisionBox(hit.blockId) ? hit.distance : reach;
    const eh = this._raycastEntities(eye, dir, shield, player);
    if (eh) {
      if (eh.distance <= (creative ? ENTITY_REACH_CREATIVE : ENTITY_REACH_SURVIVAL)) {
        this.target = null;
        this.targetEntity = eh.entity;
        this.targetEntityDistance = eh.distance;
      } else if (!hit || eh.distance < hit.distance) {
        this.target = null;               // Minecraft MISS: a mob out of attack reach in front of the block
      }
    }
  }

  /**
   * Closest attackable mob hit by the ray within maxDist: entities.raycastEntities (SPEC-wave2 §3.4)
   * when available, else a scan of entities.list against the AABBs grown by 0.1. Returns a reused
   * { entity, distance } or null.
   */
  _raycastEntities(eye, dir, maxDist, player) {
    const ents = this.game?.entities;
    if (!ents || !(maxDist > 0)) return null;
    const out = this._entityHit;
    if (typeof ents.raycastEntities === 'function') {
      let hit = null;
      try {
        this._rayOpts.exclude = player;
        hit = ents.raycastEntities(eye[0], eye[1], eye[2], dir[0], dir[1], dir[2], maxDist, this._rayOpts);
      } catch (err) {
        this._logOnce('raycastEntities', err);
        return null;
      }
      if (!hit || !isAttackable(hit.entity) || !(hit.distance <= maxDist)) return null;
      out.entity = hit.entity;
      out.distance = Math.max(0, +hit.distance || 0);
      return out;
    }
    const list = ents.list ?? ents.entities;
    if (!Array.isArray(list)) return null;
    const box = this._entityBox;
    let best = null, bestT = maxDist;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!isAttackable(e) || e === player || typeof e.getAABB !== 'function') continue;
      e.getAABB(box);
      const hit = rayBox(eye[0], eye[1], eye[2], dir[0], dir[1], dir[2],
        box.minX - ENTITY_PICK_MARGIN, box.minY - ENTITY_PICK_MARGIN, box.minZ - ENTITY_PICK_MARGIN,
        box.maxX + ENTITY_PICK_MARGIN, box.maxY + ENTITY_PICK_MARGIN, box.maxZ + ENTITY_PICK_MARGIN, _hitBox);
      if (hit && hit.t <= bestT) {
        best = e;
        bestT = hit.t;
      }
    }
    if (!best) return null;
    out.entity = best;
    out.distance = bestT;
    return out;
  }

  // ------------------------------------------------------------------ hotbar

  _handleHotbar(input, player) {
    for (let i = 0; i < 9; i++) if (input.pressed(HOTBAR_ACTIONS[i])) player.selectedSlot = i;
    const w = input.wheel | 0;
    if (w) player.selectedSlot = (((player.selectedSlot + w) % 9) + 9) % 9;
  }

  // ------------------------------------------------------------------ attacking / breaking

  _cancelMining() {
    this._mining = false;
    this.breaking = null;
  }

  _handleAttack(dt, input, player, world) {
    const held = input.isDown('attack');
    if (!held) {
      this._cancelMining();
      this._creativeRepeat = 0;
      return;
    }
    const click = input.pressed('attack');
    if (click) this.swing();
    // A mob in the crosshair: attack it on click, never mine "through" it.
    if (this.targetEntity) {
      this._cancelMining();
      if (click) this.attackEntity(this.targetEntity);
      return;
    }
    const t = this.target;
    if (!t) {
      this._cancelMining();
      return;
    }

    if (player.mode === 'creative') {
      this._cancelMining();
      this._creativeRepeat -= dt;
      if (click || this._creativeRepeat <= 0) {
        this._creativeRepeat = CREATIVE_BREAK_REPEAT;
        const tool = getItem(player.getSelectedStack()?.id ?? 0)?.tool;
        if (!tool || tool.type !== 'sword') {   // Minecraft: swords cannot break blocks in creative
          this.breakBlock(t.x, t.y, t.z, { drops: false });
          this.swing();
        }
      }
      return;
    }

    // ---- survival
    const stack = player.getSelectedStack();
    const toolId = stack ? stack.id : 0;
    const b = this._breaking;
    if (!this._mining || b.x !== t.x || b.y !== t.y || b.z !== t.z || b.blockId !== t.blockId || b.toolId !== toolId) {
      this._mining = true;
      b.x = t.x; b.y = t.y; b.z = t.z;
      b.blockId = t.blockId; b.toolId = toolId;
      b.progress = 0; b.stage = 0;
      this.breaking = null;
      this._hitSound = 0;
      this._hitParticles = 0;
    }
    this.swing();
    if (this._breakDelay > 0) return;

    const opts = this._breakOpts;
    opts.inWater = player.eyeInWater;
    opts.onGround = player.onGround || player.flying;
    const time = getBreakTime(t.blockId, toolId, opts);
    if (time === 0) {
      if (this._instantCooldown <= 0) {
        this._instantCooldown = INSTANT_BREAK_INTERVAL;
        this.breakBlock(t.x, t.y, t.z, { drops: true });
        this._cancelMining();
      }
      return;
    }

    // Hit feedback (also on unbreakable blocks, like Minecraft).
    this._hitSound -= dt;
    if (this._hitSound <= 0) {
      this._hitSound += HIT_SOUND_INTERVAL;
      if (this._hitSound <= 0) this._hitSound = HIT_SOUND_INTERVAL;
      this.game.audio?.playBlock?.('hit', BLOCKS[t.blockId].sound, t.x + 0.5, t.y + 0.5, t.z + 0.5);
    }
    this._hitParticles -= dt;
    if (this._hitParticles <= 0) {
      this._hitParticles += HIT_PARTICLE_INTERVAL;
      if (this._hitParticles <= 0) this._hitParticles = HIT_PARTICLE_INTERVAL;
      this.game.particles?.spawnBlockHit?.(t.x, t.y, t.z, t.face, t.blockId);
    }
    if (time === Infinity) {
      this.breaking = null;
      return;
    }

    b.progress += dt / time;
    if (b.progress >= 1) {
      this.breakBlock(t.x, t.y, t.z, { drops: true });
      this._breakDelay = BREAK_DELAY;
      this._cancelMining();
    } else {
      b.stage = Math.min(9, Math.floor(b.progress * 10));
      this.breaking = b;
    }
  }

  /**
   * Hit `entity` with the held item (Minecraft 1.8 Player.attack). Returns true if the hit landed
   * (entity.hurt did not return false).
   */
  attackEntity(entity) {
    const game = this.game;
    const player = game?.player;
    if (!player || player.dead || !isAttackable(entity)) return false;
    const stack = player.getSelectedStack();
    const tool = stack ? getItem(stack.id)?.tool ?? null : null;
    let damage = tool && tool.damage > 0 ? tool.damage : HAND_DAMAGE;
    const crit = player.fallDistance > 0 && player.vy < 0 && !player.onGround && !player.inWater &&
      !player.inLava && !player.flying;
    if (crit) damage *= CRIT_MULTIPLIER;
    const knock = player.sprinting ? 1 : 0;
    let landed;
    try {
      landed = entity.hurt(damage, 'player', player);
    } catch (err) {
      this._logOnce('hurt', err);
      return false;
    }
    const eyeY = player.y + player.eyeHeight;
    if (landed === false) {
      // Minecraft 1.9+ ENTITY_PLAYER_ATTACK_NODAMAGE: the swing found no opening (hurt cooldown).
      game.audio?.play?.('attack_swish', { x: player.x, y: eyeY, z: player.z });
      return false;
    }
    game.audio?.play?.(crit ? 'attack_crit' : 'attack_hit', { x: entity.x, y: entity.y + (entity.height || 1) * 0.5, z: entity.z });
    if (knock > 0) {
      // Sprint knockback: +0.5 b/tick along the view and a small lift; the attacker slows down.
      const fx = -Math.sin(player.yaw), fz = -Math.cos(player.yaw);
      if (typeof entity.push === 'function') entity.push(fx * SPRINT_KNOCKBACK * knock, SPRINT_KNOCKBACK_LIFT, fz * SPRINT_KNOCKBACK * knock);
      player.vx *= 0.6;
      player.vz *= 0.6;
      player.sprinting = false;
    }
    if (crit) this._critParticles(entity);
    if (tool && player.mode !== 'creative') this._damageHeldItem(player, tool.type === 'sword' ? 1 : 2);
    player.addExhaustion?.(0.1);
    return true;
  }

  /** Minecraft crit particles around the hit entity (EntityCrit2FX emitter). */
  _critParticles(entity) {
    const ps = this.game?.particles;
    if (!ps) return;
    const w = Number.isFinite(entity.width) ? entity.width : 0.6;
    const h = Number.isFinite(entity.height) ? entity.height : 1.8;
    if (typeof ps.spawnCrit === 'function') {
      ps.spawnCrit(entity.x, entity.y, entity.z, w, h);
      return;
    }
    // Fallback without a crit particle style: a burst of small pale bits at the hit point.
    if (typeof ps.spawnItemBreak === 'function') ps.spawnItemBreak(ITEM.FEATHER, entity.x, entity.y + h * 0.5, entity.z, 8);
  }

  /** Durability loss for the selected item; plays the tool-break sound + particles when it breaks. */
  _damageHeldItem(player, amount) {
    const stack = player.getSelectedStack();
    if (!stack) return false;
    const brokenId = stack.id;
    const broke = player.inventory.damageItem(player.selectedSlot, amount);
    if (broke) this._breakItemEffects(player, brokenId);
    return broke;
  }

  _breakItemEffects(player, itemId) {
    const game = this.game;
    const eyeY = player.y + player.eyeHeight;
    game.audio?.play?.('break_tool', { x: player.x, y: eyeY, z: player.z });
    // Minecraft LivingEntity.breakItem: item particles in front of the eyes.
    const look = player.getLookVector(this._dir);
    game.particles?.spawnItemBreak?.(itemId, player.x + look[0] * 0.5, eyeY - 0.1 + look[1] * 0.5,
      player.z + look[2] * 0.5);
  }

  /**
   * Break the block at (x, y, z) with particles and sound. With { drops: true } (survival) the
   * block's drops pop out, the held tool loses durability and the player gets 0.005 exhaustion.
   * Returns false if nothing was broken.
   */
  breakBlock(x, y, z, { drops = true } = {}) {
    const game = this.game;
    const world = game.world;
    const player = game.player;
    const id = world.getBlock(x, y, z);
    if (id === BLOCK.AIR || IS_LIQUID[id]) return false;
    // Minecraft IceBlock.playerDestroy: survival-broken ice melts into water above solid ground / liquid.
    let replacement = BLOCK.AIR;
    if (drops && id === BLOCK.ICE) {
      const below = world.getBlock(x, y - 1, z);
      if (IS_SOLID[below] || IS_LIQUID[below]) replacement = BLOCK.WATER;
    }
    if (!world.setBlock(x, y, z, replacement)) return false;
    game.particles?.spawnBlockBreak?.(x, y, z, id);
    game.audio?.playBlock?.('break', BLOCKS[id].sound, x + 0.5, y + 0.5, z + 0.5);
    if (drops && player) {
      const stack = player.getSelectedStack();
      const toolId = stack ? stack.id : 0;
      for (const d of getDrops(id, toolId, Math.random)) this._popItem(d.id, d.count, x, y, z);
      const tool = stack ? getItem(stack.id)?.tool : null;
      if (tool && BLOCKS[id].hardness > 0) this._damageHeldItem(player, tool.type === 'sword' ? 2 : 1);
      player.addExhaustion?.(0.005);
    }
    return true;
  }

  /** Minecraft Block.popResource: random offset inside the block, small random hop. */
  _popItem(itemId, count, x, y, z) {
    const r = Math.random;
    const px = x + 0.5 + (r() - 0.5) * 0.5;
    const py = y + 0.5 + (r() - 0.5) * 0.5 - 0.125;
    const pz = z + 0.5 + (r() - 0.5) * 0.5;
    const vx = (r() * 0.2 - 0.1) * TICKS;
    const vy = 0.2 * TICKS;
    const vz = (r() * 0.2 - 0.1) * TICKS;
    this._spawnItem(makeStack(itemId, count), px, py, pz, vx, vy, vz, ITEM_PICKUP_DELAY);
  }

  _spawnItem(stack, x, y, z, vx, vy, vz, delay) {
    const game = this.game;
    if (typeof game.spawnItem === 'function') game.spawnItem(stack, x, y, z, vx, vy, vz, delay);
    else game.entities?.spawnItem?.(stack, x, y, z, vx, vy, vz, delay);
  }

  // ------------------------------------------------------------------ use / place

  _handleUse(dt, input, player, world) {
    if (!input.isDown('use')) {
      this._useRepeat = 0;
      return;
    }
    this._useRepeat -= dt;
    const click = input.pressed('use');
    if (!click && this._useRepeat > 0) return;
    this._useRepeat = USE_REPEAT;
    if (this._mining && player.mode !== 'creative') return;   // Minecraft: no use while destroying
    this.useItem();
  }

  /**
   * Right-click action (Minecraft.startUseItem): block interaction, the held item on the targeted
   * face (hoe, seeds, spawn egg, block placement), then the item on its own (buckets, food, bow).
   * Returns true if something happened.
   */
  useItem() {
    const game = this.game;
    const player = game.player;
    const world = game.world;
    if (!player || !world || player.dead || player.usingItem) return false;
    const t = this.target;
    const stack = player.getSelectedStack();
    const itemId = stack ? stack.id : 0;
    const item = itemId ? getItem(itemId) : null;

    if (t) {
      const def = BLOCKS[t.blockId];
      if (def.interact && !(player.sneaking && stack)) {
        if (def.interact === 'crafting') {
          if (typeof game.ui?.openCraftingTable === 'function') {
            game.ui.openCraftingTable();
            this.swing();
            return true;
          }
        } else if (typeof game.onInteractBlock === 'function') {
          const handled = game.onInteractBlock(t.x, t.y, t.z, t.blockId, {
            itemId, stack, slot: player.selectedSlot, face: t.face, sneaking: player.sneaking, player,
          });
          if (handled !== false) {
            this.swing();
            return true;
          }
        }
      }
      if (stack && item) {
        if (item.tool?.type === 'hoe') {
          if (this._useHoe(player, world, t)) return true;
        } else if (itemId === ITEM.WHEAT_SEEDS) {
          if (this._plantSeeds(player, world, t)) return true;
        } else if (item.spawnMob) {
          return this._useSpawnEgg(player, world, t, item.spawnMob);
        } else if (isBlockItem(itemId)) {
          return this.placeBlock(stack, t);
        }
      }
    }

    if (itemId === ITEM.BUCKET) return this._scoopLiquid(player, world);
    if (itemId === ITEM.WATER_BUCKET || itemId === ITEM.LAVA_BUCKET) return this._pourLiquid(player, world, itemId);
    if (item?.food) return this._startEating(player, stack);
    if (itemId === ITEM.BOW) return this._startDrawing(player, stack);
    return false;
  }

  /** Minecraft itemUsed: after a use that changed the stack (or any use in creative) the hand re-equips. */
  _afterUse(player, countChanged) {
    this.swing();
    if ((countChanged || player.mode === 'creative') && player.getSelectedStack()) this._equip = 0;
  }

  /** Cell a block would go into when clicking target `t` with item `itemId` (or null). */
  _placementCell(t, itemId, world, out) {
    let x, y, z;
    if (IS_REPLACEABLE[t.blockId] && itemForBlock(t.blockId) !== itemId) {
      x = t.x; y = t.y; z = t.z;
    } else {
      const n = FACE_NORMALS[t.face];
      x = t.x + n[0]; y = t.y + n[1]; z = t.z + n[2];
      if (y < 0 || y > 255) return null;
      const cur = world.getBlock(x, y, z);
      if (!IS_REPLACEABLE[cur] || (cur !== BLOCK.AIR && itemId !== 0 && itemForBlock(cur) === itemId)) return null;
    }
    if (y < 0 || y > 255) return null;
    out[0] = x; out[1] = y; out[2] = z;
    return out;
  }

  /**
   * Block ids to try for placing item `itemId` against `face`: the getPlacementBlock variant first;
   * torches then try the floor and the walls in the order the player looks at them (Minecraft
   * StandingAndWallBlockItem with BlockPlaceContext.getNearestLookingDirections).
   */
  _placementCandidates(itemId, face, player) {
    const primary = getPlacementBlock(itemId, face, player.yaw);
    const tv = TORCH_VARIANTS.get(itemId);
    if (!primary || !tv) return primary ? [primary] : [];
    const look = player.getLookVector(this._dir);
    // Directions the player looks toward: down (floor torch), and the 4 horizontals (wall torch
    // attached to the block in that direction, pointing back at the player), most aligned first.
    const dirs = [
      { d: -look[1], id: tv.floor },       // looking down → standing torch
      { d: look[0], id: tv.west },         // looking east (+X): wall to the east, torch points west
      { d: -look[0], id: tv.east },
      { d: look[2], id: tv.north },        // looking south (+Z): torch points north
      { d: -look[2], id: tv.south },
    ];
    dirs.sort((a, b) => b.d - a.d);
    // The clicked face decides first — except a bottom face (torches never hang from a ceiling).
    const out = face === 3 ? [] : [primary];
    for (const e of dirs) if (!out.includes(e.id)) out.push(e.id);
    return out;
  }

  /**
   * Place the block item `stack` against target `t` following Minecraft's rules. Returns true on success.
   */
  placeBlock(stack, t = this.target) {
    const game = this.game;
    const player = game.player;
    const world = game.world;
    if (!t || !stack || !isBlockItem(stack.id)) return false;
    const cell = this._placementCell(t, stack.id, world, this._cell);
    if (!cell) return false;
    const [x, y, z] = cell;
    let placeId = 0;
    for (const id of this._placementCandidates(stack.id, t.face, player)) {
      if (canStay(id, this._getBlock, x, y, z)) {
        placeId = id;
        break;
      }
    }
    if (!placeId) return false;
    const cb = getCollisionBox(placeId);
    if (cb) {
      const bb = this._blockBox;
      bb.minX = x + cb[0]; bb.minY = y + cb[1]; bb.minZ = z + cb[2];
      bb.maxX = x + cb[3]; bb.maxY = y + cb[4]; bb.maxZ = z + cb[5];
      if (boxesIntersect(player.getAABB(), bb)) return false;
      if (this._entityInBox(bb)) return false;
    }
    if (!world.setBlock(x, y, z, placeId)) return false;
    game.audio?.playBlock?.('place', BLOCKS[placeId].sound, x + 0.5, y + 0.5, z + 0.5);
    const survival = player.mode !== 'creative';
    if (survival) player.inventory.removeFromSlot(player.selectedSlot, 1);
    this._afterUse(player, survival);
    return true;
  }

  /**
   * True if a non-item entity overlaps `box`. Uses entities.anyEntityInBox(box) when provided,
   * otherwise scans entities.entities / entities.list for objects with getAABB(out) or x,y,z,width,height.
   */
  _entityInBox(box) {
    const ents = this.game.entities;
    if (!ents) return false;
    if (typeof ents.anyEntityInBox === 'function') return !!ents.anyEntityInBox(box);
    const list = ents.entities ?? ents.list ?? null;
    if (!list || typeof list[Symbol.iterator] !== 'function') return false;
    const eb = this._entityBox;
    for (const e of list) {
      if (!e || e.dead || e.removed) continue;
      if (e.kind === 'item' || e.type === 'item' || e.isItem) continue;
      if (typeof e.getAABB === 'function') {
        if (boxesIntersect(e.getAABB(eb), box)) return true;
      } else if (e.body && typeof e.body.getAABB === 'function') {
        if (boxesIntersect(e.body.getAABB(eb), box)) return true;
      } else if (Number.isFinite(e.x) && Number.isFinite(e.width) && Number.isFinite(e.height)) {
        const hw = e.width / 2;
        eb.minX = e.x - hw; eb.minY = e.y; eb.minZ = e.z - hw;
        eb.maxX = e.x + hw; eb.maxY = e.y + e.height; eb.maxZ = e.z + hw;
        if (boxesIntersect(eb, box)) return true;
      }
    }
    return false;
  }

  // ------------------------------------------------------------------ hoe, seeds, spawn eggs

  /** Minecraft HoeItem.useOn: grass / dirt with air above (not clicked from below) → farmland. */
  _useHoe(player, world, t) {
    if (t.face === 3 || !TILLABLE.has(t.blockId)) return false;
    if (t.y + 1 <= 255 && world.getBlock(t.x, t.y + 1, t.z) !== BLOCK.AIR) return false;
    if (!world.setBlock(t.x, t.y, t.z, BLOCK.FARMLAND)) return false;
    this.game.audio?.play?.('hoe_till', { x: t.x + 0.5, y: t.y + 0.5, z: t.z + 0.5 });   // Minecraft item.hoe.till
    if (player.mode !== 'creative') this._damageHeldItem(player, 1);
    this._afterUse(player, false);
    return true;
  }

  /** Minecraft ItemSeeds.onItemUse: the top face of farmland with air above → wheat (stage 0). */
  _plantSeeds(player, world, t) {
    if (t.face !== 2 || !FARMLAND_IDS.has(t.blockId)) return false;
    const x = t.x, y = t.y + 1, z = t.z;
    if (y > 255 || world.getBlock(x, y, z) !== BLOCK.AIR) return false;
    if (!canStay(BLOCK.WHEAT_0, this._getBlock, x, y, z)) return false;
    if (!world.setBlock(x, y, z, BLOCK.WHEAT_0)) return false;
    this.game.audio?.playBlock?.('place', BLOCKS[BLOCK.WHEAT_0].sound, x + 0.5, y + 0.5, z + 0.5);
    const survival = player.mode !== 'creative';
    if (survival) player.inventory.removeFromSlot(player.selectedSlot, 1);
    this._afterUse(player, survival);
    return true;
  }

  /**
   * Spawn egg on a block face (Minecraft SpawnEggItem.useOn): the mob appears in the clicked cell if
   * that block has no collision box (plants, torches), else in the cell across the clicked face, at
   * the cell's bottom centre. Survival consumes the egg, creative keeps it.
   */
  _useSpawnEgg(player, world, t, mobType) {
    let x = t.x, y = t.y, z = t.z;
    if (getCollisionBox(t.blockId)) {
      const n = FACE_NORMALS[t.face];
      x += n[0]; y += n[1]; z += n[2];
    }
    if (y < 0 || y > 255 || getCollisionBox(world.getBlock(x, y, z))) return false;
    const slot = player.selectedSlot;
    const eggId = player.getSelectedStack()?.id ?? 0;
    const spawn = (fn) => {
      if (this.game.world !== world || this.game.player !== player || player.dead) return false;
      let mob = null;
      try {
        mob = fn(this.game, mobType, x + 0.5, y, z + 0.5, { persistent: true });
      } catch (err) {
        this._logOnce('spawnMob', err);
        return false;
      }
      if (!mob) return false;
      const survival = player.mode !== 'creative';
      if (survival) {
        const s = player.inventory.get(slot);
        if (s && s.id === eggId) player.inventory.removeFromSlot(slot, 1);
      }
      this._afterUse(player, survival);
      return true;
    };
    if (typeof this.spawnMob === 'function') return spawn(this.spawnMob);
    if (mobsModule && typeof mobsModule.spawnMob === 'function') return spawn(mobsModule.spawnMob);
    // First use before mobs.js finished loading: spawn as soon as it is there (the click is consumed).
    loadMobsModule().then((m) => {
      if (m && typeof m.spawnMob === 'function') spawn(m.spawnMob);
    });
    return true;
  }

  // ------------------------------------------------------------------ buckets

  _scoopLiquid(player, world) {
    const eye = player.getEyePosition(this._eye);
    const dir = player.getLookVector(this._dir);
    const reach = player.mode === 'creative' ? PLAYER.REACH_CREATIVE : PLAYER.REACH_SURVIVAL;
    // Only liquid SOURCES can be picked up; flowing liquid is see-through for the bucket.
    const hit = bucketRaycast(world, eye[0], eye[1], eye[2], dir[0], dir[1], dir[2], reach);
    if (!hit || !LIQUID_KIND[hit.blockId] || LIQUID_LEVEL[hit.blockId] !== 0) return false;
    const filled = LIQUID_KIND[hit.blockId] === 2 ? ITEM.LAVA_BUCKET : ITEM.WATER_BUCKET;
    if (!world.setBlock(hit.x, hit.y, hit.z, BLOCK.AIR)) return false;
    this.game.audio?.playBlock?.('break', BLOCKS[hit.blockId].sound, hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
    const inv = player.inventory;
    if (player.mode === 'creative') {
      if (inv.findSlot(filled) < 0) inv.add(makeStack(filled, 1));
      this._afterUse(player, false);
      return true;
    }
    const slot = player.selectedSlot;
    const s = inv.get(slot);
    if (s && s.count <= 1) {
      inv.set(slot, makeStack(filled, 1));
    } else {
      inv.removeFromSlot(slot, 1);
      if (inv.add(makeStack(filled, 1)) > 0) this._dropStack(makeStack(filled, 1), player);
    }
    this._afterUse(player, true);
    return true;
  }

  _pourLiquid(player, world, itemId) {
    const t = this.target;
    if (!t) return false;
    let x, y, z;
    if (IS_REPLACEABLE[t.blockId]) {
      x = t.x; y = t.y; z = t.z;
    } else {
      const n = FACE_NORMALS[t.face];
      x = t.x + n[0]; y = t.y + n[1]; z = t.z + n[2];
    }
    if (y < 0 || y > 255) return false;
    const cur = world.getBlock(x, y, z);
    if (cur !== BLOCK.AIR && !IS_REPLACEABLE[cur]) {
      // Minecraft BucketItem.emptyContents: liquids also replace non-solid blocks (torches, flowers,
      // crops), which drop as items.
      if (IS_SOLID[cur] || BLOCKS[cur].interact || RENDER_TYPE[cur] === RENDER.NONE) return false;
      for (const d of getDrops(cur, 0, Math.random)) this._popItem(d.id, d.count, x, y, z);
    }
    const liquid = itemId === ITEM.LAVA_BUCKET ? BLOCK.LAVA : BLOCK.WATER;
    if (!world.setBlock(x, y, z, liquid)) return false;
    this.game.audio?.playBlock?.('place', BLOCKS[liquid].sound, x + 0.5, y + 0.5, z + 0.5);
    if (player.mode !== 'creative') player.inventory.set(player.selectedSlot, makeStack(ITEM.BUCKET, 1));
    this._afterUse(player, false);
    return true;
  }

  // ------------------------------------------------------------------ item use: eating, bows

  /** Start eating the selected food (Minecraft: only when hungry, always in creative). */
  _startEating(player, stack) {
    if (!player.canEat()) return false;
    player.startUsingItem('eat', stack.id, player.selectedSlot);
    this._useTicks = 0;
    this._useAcc = 0;
    return true;
  }

  /** Start drawing the selected bow (needs arrows unless creative). */
  _startDrawing(player, stack) {
    if (player.mode !== 'creative' && player.inventory.findSlot(ITEM.ARROW) < 0) return false;
    player.startUsingItem('bow', stack.id, player.selectedSlot);
    this._useTicks = 0;
    this._useAcc = 0;
    return true;
  }

  /** Item use in progress: advance it, finish eating, or end it when the button is released. */
  _updateUsing(dt, input, player, world) {
    const stack = player.getSelectedStack();
    if (!stack || stack.id !== player.useItemId || player.selectedSlot !== player.useSlot) {
      player.stopUsingItem();
      return;
    }
    if (input.active === false) {
      // A screen opened / the pointer lock was lost: abort without shooting.
      player.stopUsingItem();
      return;
    }
    if (!input.isDown('use')) {
      // Shoot only on a real release edge: a button that was let go during a pause (no frames ran) or
      // behind a screen just cancels the draw.
      if (player.usingItem === 'bow' && input.released('use')) this.releaseBow();
      player.stopUsingItem();
      this._useRepeat = 0;
      return;
    }
    player.useTime += dt;
    if (player.usingItem !== 'eat') return;
    // Minecraft LivingEntity.updatingUsingItem on the 20 Hz tick: effects every 4 ticks once at most
    // 25 ticks remain, completion after 32 ticks.
    this._useAcc += dt;
    while (this._useAcc >= 1 / TICKS && player.usingItem === 'eat') {
      this._useAcc -= 1 / TICKS;
      const remaining = EAT_TICKS - this._useTicks;
      this._useTicks++;
      if (remaining <= 25 && remaining % 4 === 0) this._eatingEffects(player, stack.id, 5);
      if (remaining <= 1) this._finishEating(player, stack);
    }
  }

  /** Crunch: food particles at the mouth + the eat sound (Minecraft spawnItemParticles / eat sound). */
  _eatingEffects(player, itemId, count) {
    const game = this.game;
    const r = this.rng;
    // A point 0.6 in front of the eyes, 0.3–0.9 below them, rotated with the view (Minecraft).
    const ox = (r() - 0.5) * 0.3, oy = -r() * 0.6 - 0.3, oz = 0.6;
    const cp = Math.cos(player.pitch), sp = Math.sin(player.pitch);
    const y1 = oy * cp + oz * sp;                  // pitch rotation about the view's right axis
    const z1 = -oy * sp + oz * cp;
    const sy = Math.sin(player.yaw), cy = Math.cos(player.yaw);
    // forward = (−sin yaw, −cos yaw), right = (cos yaw, −sin yaw)
    const x = player.x + cy * ox - sy * z1;
    const y = player.y + player.eyeHeight + y1;
    const z = player.z - sy * ox - cy * z1;
    game.particles?.spawnItemBreak?.(itemId, x, y, z, count);
    game.audio?.play?.('eat', {
      x: player.x, y: player.y + player.eyeHeight, z: player.z,
      volume: 0.5 + 0.5 * (r() < 0.5 ? 0 : 1), pitch: (r() - r()) * 0.2 + 1,
    });
  }

  /** Eating done: 16 particles + crunch, food values and side effects, burp, one item consumed. */
  _finishEating(player, stack) {
    const itemId = stack.id;
    this._eatingEffects(player, itemId, 16);
    player.consumeFood(itemId, this.rng);
    this.game.audio?.play?.('burp', {
      x: player.x, y: player.y + player.eyeHeight, z: player.z, volume: 0.5, pitch: this.rng() * 0.1 + 0.9,
    });
    const survival = player.mode !== 'creative';
    if (survival) player.inventory.removeFromSlot(player.useSlot, 1);
    player.stopUsingItem();
    this._useRepeat = USE_REPEAT;
    if (player.getSelectedStack()) this._equip = 0;
  }

  /**
   * Release a drawn bow (Minecraft BowItem.releaseUsing): power f = (t² + 2t)/3 for t seconds drawn
   * (max 1); f < 0.1 does not shoot. The arrow leaves the eye (−0.1) along the view with Minecraft's
   * spread at f·3 b/tick plus the player's motion, crit at full power; survival consumes the first
   * arrow stack and 1 bow durability. Returns true if an arrow was fired.
   */
  releaseBow() {
    const game = this.game;
    const player = game?.player;
    if (!player || player.dead || player.usingItem !== 'bow') return false;
    const creative = player.mode === 'creative';
    const arrowSlot = creative ? -1 : player.inventory.findSlot(ITEM.ARROW);
    if (!creative && arrowSlot < 0) return false;
    const t = Math.min(player.useTime, 3600);
    let f = (t * t + 2 * t) / 3;
    if (f < BOW_MIN_POWER) return false;
    if (f > 1) f = 1;
    const ents = game.entities;
    if (!ents || typeof ents.spawnArrow !== 'function') return false;
    const r = this.rng;
    const look = player.getLookVector(this._dir);
    let dx = look[0] + gaussian(r) * ARROW_INACCURACY;
    let dy = look[1] + gaussian(r) * ARROW_INACCURACY;
    let dz = look[2] + gaussian(r) * ARROW_INACCURACY;
    const len = Math.hypot(dx, dy, dz) || 1;
    const speed = f * ARROW_SPEED;
    dx = dx / len * speed + player.vx;
    dy = dy / len * speed + (player.onGround ? 0 : player.vy);
    dz = dz / len * speed + player.vz;
    const x = player.x, y = player.y + player.eyeHeight - 0.1, z = player.z;
    let arrow = null;
    try {
      arrow = ents.spawnArrow(x, y, z, dx, dy, dz, {
        shooter: player, damage: ARROW_BASE_DAMAGE, critical: f >= 1, pickup: !creative,
      });
    } catch (err) {
      this._logOnce('spawnArrow', err);
      return false;
    }
    if (!arrow) return false;
    game.audio?.play?.('bow_shoot', { x, y, z, volume: 1, pitch: 1 / (r() * 0.4 + 1.2) + f * 0.5 });
    if (!creative) {
      player.inventory.removeFromSlot(arrowSlot, 1);
      this._damageHeldItem(player, 1);
    }
    return true;
  }

  // ------------------------------------------------------------------ pick block

  /** Middle click: Minecraft's pick-block behaviour for the current target. */
  pickBlock() {
    const player = this.game.player;
    const t = this.target;
    if (!player || !t) return false;
    const itemId = itemForBlock(t.blockId);
    if (!itemId) return false;
    const inv = player.inventory;
    const slot = inv.findSlot(itemId);
    if (slot >= 0 && slot < 9) {
      player.selectedSlot = slot;
      return true;
    }
    if (slot >= 9) {
      // Swap it from the main inventory into a suitable hotbar slot.
      const sel = this._suitableHotbarSlot(player);
      player.selectedSlot = sel;
      const a = inv.get(sel);
      inv.set(sel, inv.get(slot));
      inv.set(slot, a);
      return true;
    }
    if (player.mode !== 'creative') return false;
    const sel = this._suitableHotbarSlot(player);
    player.selectedSlot = sel;
    const current = inv.get(sel);
    if (current) {
      const free = inv.firstEmpty();
      if (free >= 0) inv.set(free, current);
    }
    inv.set(sel, makeStack(itemId, 1));
    return true;
  }

  /** The selected slot if empty, else the next empty hotbar slot, else the selected slot. */
  _suitableHotbarSlot(player) {
    const inv = player.inventory;
    for (let i = 0; i < 9; i++) {
      const j = (player.selectedSlot + i) % 9;
      if (!inv.get(j)) return j;
    }
    return player.selectedSlot;
  }

  // ------------------------------------------------------------------ dropping

  _handleDrop(dt, input, player) {
    if (input.pressed('drop')) {
      this.dropSelected(this._ctrlDown(input));
      this._dropTimer = DROP_REPEAT_DELAY;
    } else if (input.isDown('drop')) {
      this._dropTimer -= dt;
      for (let n = 0; this._dropTimer <= 0 && n < 8; n++) {
        this._dropTimer += DROP_REPEAT;
        if (!this.dropSelected(this._ctrlDown(input))) break;
      }
    }
  }

  _ctrlDown(input) {
    if (typeof input.isKeyDown === 'function') return input.isKeyDown('ControlLeft') || input.isKeyDown('ControlRight');
    return input.isDown('sprint');
  }

  /** Throw one item (or the whole stack) from the selected slot. Returns true if something was dropped. */
  dropSelected(wholeStack = false) {
    const player = this.game.player;
    if (!player || player.dead) return false;
    const inv = player.inventory;
    const s = inv.get(player.selectedSlot);
    if (!s) return false;
    const removed = inv.removeFromSlot(player.selectedSlot, wholeStack ? s.count : 1);
    if (!removed) return false;
    this._dropStack(removed, player);
    this.swing();
    return true;
  }

  /** game.dropFromPlayer(stack) or a Minecraft-style throw from the eye along the look direction. */
  _dropStack(stack, player) {
    const game = this.game;
    if (typeof game.dropFromPlayer === 'function') {
      game.dropFromPlayer(stack);
      return;
    }
    const r = Math.random;
    const cp = Math.cos(player.pitch), sp = Math.sin(player.pitch);
    const a = r() * Math.PI * 2, f = 0.02 * r();
    const vx = (-Math.sin(player.yaw) * cp * 0.3 + Math.cos(a) * f) * TICKS;
    const vy = (sp * 0.3 + 0.1 + (r() - r()) * 0.1) * TICKS;
    const vz = (-Math.cos(player.yaw) * cp * 0.3 + Math.sin(a) * f) * TICKS;
    this._spawnItem(stack, player.x, player.y + player.eyeHeight - 0.3, player.z, vx, vy, vz, THROWN_PICKUP_DELAY);
  }

  // ------------------------------------------------------------------ hand

  _updateHand(dt, player) {
    if (this._swingTime >= 0) {
      this._swingTime += dt;
      if (this._swingTime >= SWING_TIME) this._swingTime = -1;
    }
    const stack = player ? player.getSelectedStack() : null;
    const want = stack ? stack.id : 0;
    const target = want === this._handItem ? 1 : 0;
    const step = EQUIP_RATE * dt;
    const d = target - this._equip;
    this._equip += d > step ? step : d < -step ? -step : d;
    if (this._equip < 0.1) this._handItem = want;   // swap the drawn item while the hand is down
    // Holding a spawn egg: load mobs.js ahead of the first click (once; failures retry on use only).
    if (want >= 256 && !mobsModule && !mobsLoading && mobsFailedAt === -Infinity &&
        typeof this.spawnMob !== 'function' && getItem(want)?.spawnMob) {
      loadMobsModule();
    }
  }

  /**
   * HandState (§9.5) for the first-person renderer, reused every call:
   * { itemId, swing 0..1 (0 = idle), equip 0..1 (1 = raised), bobX, bobY (view-space translation,
   *   blocks), light (packed sky<<4|block at the eye), bobRoll, bobPitch (radians), swayYaw,
   *   swayPitch (radians, hand lag when turning), count,
   *   useAction 'eat' | 'bow' | null, useProgress 0..1 (eating: elapsed / 1.6 s; bow: seconds drawn,
   *   capped at 1 — Minecraft's pulling frames switch at 0.65 and 0.9), useTime (seconds) }.
   */
  getHandState() {
    const h = this._hand;
    const player = this.game?.player;
    h.itemId = this._handItem;
    h.swing = this._swingTime >= 0 ? Math.min(1, this._swingTime / SWING_TIME) : 0;
    h.equip = this._equip;
    h.useAction = null;
    h.useProgress = 0;
    h.useTime = 0;
    if (player) {
      const bob = player.getViewBob();
      h.bobX = bob.x; h.bobY = bob.y; h.bobRoll = bob.roll; h.bobPitch = bob.pitch;
      const sway = player.getHandSway();
      h.swayYaw = sway.yaw; h.swayPitch = sway.pitch;
      const s = player.getSelectedStack();
      h.count = s && s.id === this._handItem ? s.count : 0;
      const use = player.usingItem;
      if (use && player.useItemId === this._handItem) {
        h.useAction = use;
        h.useTime = player.useTime;
        h.useProgress = Math.min(1, player.useTime / (use === 'eat' ? EAT_TIME : BOW_FULL_DRAW));
      }
      const world = this.game.world;
      if (world && typeof world.getLight === 'function') {
        const e = player.getEyePosition(this._eye);
        h.light = world.getLight(Math.floor(e[0]), Math.floor(e[1]), Math.floor(e[2]));
      }
    }
    return h;
  }

  /** Log an error from a teammate API once (keeps the frame loop alive). */
  _logOnce(kind, err) {
    const key = kind + ':' + (err?.message ?? String(err));
    if (this._errors.has(key)) return;
    this._errors.add(key);
    console.error(`[interaction] ${kind} failed:`, err);
  }
}
