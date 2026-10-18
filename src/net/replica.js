// Client replicas of the server's entities and of the other players (multiplayer).
//
// RemoteEntityManager replaces the EntityManager while connected: it does not simulate anything. The
// server's 10 Hz entity states (server/session.mjs entityState) create / update real entity objects
// (ItemEntity, Mob, Arrow ...) so the renderer, raycasts and placement checks work unchanged; positions
// and angles are interpolated toward each new state over one snapshot interval, and the visual timers
// (hurt flash, death tip-over, swing, limb swing, item bob) run locally. Everything the local player does
// to entities is forwarded to the server: spawning items / arrows / TNT / mobs, hitting mobs (hurt + the
// sprint knockback push of the same click are sent as one 'at' message).
//
// RemotePlayers keeps the other players: a PlayerAvatar per player (same model and animation as the local
// third-person view) plus a name tag drawn by the client (src/net/client.js).
import {
  EntityManager, ItemEntity, FallingBlockEntity, PrimedTntEntity, Arrow, PlayerAvatar, DEFAULT_PICKUP_DELAY,
  THROW_PICKUP_DELAY,
} from '../game/entities.js';
import { Mob, MOB_TYPES } from '../game/mobs.js';
import { containerType } from '../game/blockentities.js';
import { unpackStack, packStack } from './protocol.js';
import { PLAYER } from '../config.js';

const TICKS = 20;
const TAU = Math.PI * 2;
const HURT_TIME = 0.5;
const SWING_TIME = 0.3;
const COLLECT_TIME = 3 / TICKS;
const SNAP_DT = 0.1;

const now = () => performance.now() / 1000;

function wrap(a) {
  return a - TAU * Math.floor((a + Math.PI) / TAU);
}

function lerpAngle(a, b, t) {
  return a + wrap(b - a) * t;
}

/** Interpolation state shared by entity replicas and remote players. */
class Track {
  constructor(x, y, z, a, b, c) {
    this.fx = x; this.fy = y; this.fz = z; this.fa = a; this.fb = b; this.fc = c;
    this.tx = x; this.ty = y; this.tz = z; this.ta = a; this.tb = b; this.tc = c;
    this.x = x; this.y = y; this.z = z; this.a = a; this.b = b; this.c = c;
    this.t0 = 0;
    this.dur = SNAP_DT;
    this.last = now();
  }

  /** New target: interpolate from the current pose over the time since the previous target. */
  target(x, y, z, a, b, c) {
    const t = now();
    this.fx = this.x; this.fy = this.y; this.fz = this.z; this.fa = this.a; this.fb = this.b; this.fc = this.c;
    this.tx = x; this.ty = y; this.tz = z; this.ta = a; this.tb = b; this.tc = c;
    this.dur = Math.max(0.05, Math.min(0.25, t - this.last));
    this.last = t;
    this.t0 = t;
    const dx = x - this.x, dy = y - this.y, dz = z - this.z;
    if (dx * dx + dy * dy + dz * dz > 64) this.snap();       // teleported: no sliding across the map
  }

  snap() {
    this.x = this.fx = this.tx; this.y = this.fy = this.ty; this.z = this.fz = this.tz;
    this.a = this.fa = this.ta; this.b = this.fb = this.tb; this.c = this.fc = this.tc;
  }

  step() {
    const k = Math.min(1, (now() - this.t0) / this.dur);
    this.x = this.fx + (this.tx - this.fx) * k;
    this.y = this.fy + (this.ty - this.fy) * k;
    this.z = this.fz + (this.tz - this.fz) * k;
    this.a = lerpAngle(this.fa, this.ta, k);
    this.b = lerpAngle(this.fb, this.tb, k);
    this.c = this.fc + (this.tc - this.fc) * k;
  }
}

// =====================================================================================================
// Entities
// =====================================================================================================

export class RemoteEntityManager extends EntityManager {
  /**
   * @param {object} game
   * @param {import('./client.js').MultiplayerClient} client
   */
  constructor(game, client) {
    super(game);
    this.client = client;
    /** id -> replica entity */
    this.byId = new Map();
    this._attack = null;          // pending { id, d, kb } of this frame
    this._lightTimer = 0;
  }

  // ---- forwarded spawns -------------------------------------------------------------------------

  spawnItem(stack, x, y, z, vx, vy, vz, pickupDelay = DEFAULT_PICKUP_DELAY) {
    if (!stack || !(stack.count > 0)) return null;
    // Without a velocity the server picks Minecraft's random pop itself.
    const v = Number.isFinite(vx) && Number.isFinite(vy) && Number.isFinite(vz) ? [vx, vy, vz] : undefined;
    this.client.send({ t: 's', k: 'item', s: packStack(stack), p: [x, y, z], v, d: pickupDelay });
    return null;
  }

  popItem(itemId, count, x, y, z, pickupDelay = DEFAULT_PICKUP_DELAY) {
    const r = Math.random;
    const px = x + (r() - 0.5) * 0.5, py = y + (r() - 0.5) * 0.5 - 0.125, pz = z + (r() - 0.5) * 0.5;
    return this.spawnItem({ id: itemId, count, damage: 0 }, px, py, pz, (r() * 0.2 - 0.1) * TICKS, 0.2 * TICKS,
      (r() * 0.2 - 0.1) * TICKS, pickupDelay);
  }

  dropFromPlayer(stack, player = this.game?.player) {
    if (!stack || !(stack.count > 0) || !player) return null;
    // Minecraft Player.drop: from the eyes - 0.3, 0.3 b/tick along the look, a little random spread.
    const r = Math.random;
    const yaw = player.yaw ?? 0, pitch = player.pitch ?? 0;
    const cp = Math.cos(pitch);
    const f = 0.3 * TICKS;
    const ang = r() * TAU, spread = 0.02 * r() * TICKS;
    const vx = -Math.sin(yaw) * cp * f + Math.cos(ang) * spread;
    const vy = Math.sin(pitch) * f + 0.1 * TICKS + (r() - r()) * 0.1 * TICKS;
    const vz = -Math.cos(yaw) * cp * f + Math.sin(ang) * spread;
    return this.spawnItem(stack, player.x, player.y + PLAYER.EYE_HEIGHT - 0.3, player.z, vx, vy, vz, THROW_PICKUP_DELAY);
  }

  spawnFallingBlock() {
    return null;                  // the server's block updates make sand fall
  }

  spawnPrimedTnt(x, y, z, fuse) {
    this.client.send({ t: 's', k: 'tnt', p: [x, y, z], f: fuse });
    return null;
  }

  spawnArrow(x, y, z, vx, vy, vz, { damage = 2, critical = false, pickup = false } = {}) {
    this.client.send({ t: 's', k: 'arrow', p: [x, y, z], v: [vx, vy, vz], dmg: damage, crit: critical, pick: pickup });
    return null;
  }

  /** Spawn eggs (interaction.spawnMob hook). */
  spawnMobRequest(type, x, y, z, opts = {}) {
    this.client.send({ t: 's', k: 'mob', mt: type, p: [x, y, z], yaw: opts.yaw, ps: opts.persistent });
    return null;
  }

  explode() {
    return 0;
  }

  serialize() {
    return [];
  }

  deserialize() {
    return 0;
  }

  // ---- replication ------------------------------------------------------------------------------

  /** Apply entity state arrays from the server. */
  applyStates(list) {
    for (const s of list) {
      if (!Array.isArray(s) || s.length < 5) continue;
      const id = s[0];
      let e = this.byId.get(id);
      if (e && e._kind !== s[1]) {
        this._drop(e);
        e = undefined;
      }
      if (!e) {
        e = this._create(s);
        if (!e) continue;
        e._netId = id;
        e._kind = s[1];
        this.byId.set(id, e);
        this.add(e);
        this._applyState(e, s, true);
      } else {
        this._applyState(e, s, false);
      }
    }
  }

  /** Entities that left the server's view (or died / were picked up). */
  removeIds(ids) {
    for (const id of ids) {
      const e = this.byId.get(id);
      if (!e) continue;
      this.byId.delete(id);
      // A picked-up item finishes its fly-in first.
      if (e.collector && e.collectTime < COLLECT_TIME) e._removeAfterCollect = true;
      else e.remove();
    }
  }

  _drop(e) {
    this.byId.delete(e._netId);
    e.remove();
  }

  _create(s) {
    switch (s[1]) {
      case 'i': {
        const stack = unpackStack(s[5]);
        if (!stack) return null;
        return new ItemEntity(stack, Number.isFinite(s[6]) ? s[6] : 0.5);
      }
      case 'f':
        return new FallingBlockEntity(s[5] | 0);
      case 't':
        return new PrimedTntEntity((s[5] | 0) / TICKS);
      case 'r':
        return new Arrow({ critical: !!s[8] });
      case 'm': {
        if (!MOB_TYPES[s[8]]) return null;
        const m = new Mob(s[8], { persistent: true });
        m.hurt = (amount) => this._hurt(m, amount);
        m.push = (vx, vy, vz) => this._push(m, vx, vy, vz);
        m.knockback = () => {};
        return m;
      }
      default:
        return null;
    }
  }

  _applyState(e, s, first) {
    const x = s[2], y = s[3], z = s[4];
    switch (s[1]) {
      case 'i': {
        const stack = unpackStack(s[5]);
        if (stack) { e.stack.id = stack.id; e.stack.count = stack.count; e.stack.damage = stack.damage; }
        const collector = s[7] | 0;
        if (collector && !e.collector) {
          const p = this.client.playerById(collector);
          if (p) e.startCollect(p);
        }
        break;
      }
      case 'f':
        e.blockId = s[5] | 0;
        break;
      case 't':
        e.fuse = (s[5] | 0) / TICKS;
        break;
      case 'r':
        e.inGround = !!s[7];
        e.critical = !!s[8];
        e.shake = s[9] | 0;
        break;
      case 'm': {
        const flags = s[9] | 0;
        const dead = (flags & 1) !== 0;
        if (dead && !e.dead) {
          e.dead = true;
          e.deathTime = 0;
          e.pickable = false;
          e.pushable = false;
        }
        if ((flags & 2) !== 0 && !e._wasHurt) e.hurtTime = HURT_TIME;
        e._wasHurt = (flags & 2) !== 0;
        e.fireTime = (flags & 4) !== 0 ? 1 : 0;
        e.sheared = (flags & 8) !== 0;
        e.aggressive = (flags & 16) !== 0;
        if ((flags & 32) !== 0 && !e._wasSwinging) e.attackAnim = 0;
        e._wasSwinging = (flags & 32) !== 0;
        e.swell = s[10] | 0;
        e._oldSwell = e.swell;
        e.heldItem = s[11] | 0;
        e.color = Number.isFinite(s[12]) ? s[12] : -1;
        e.eatTicks = s[13] | 0;
        e.useTicks = s[14] | 0;
        break;
      }
      default:
    }
    // Pose: x y z + up to three angles (mobs: body yaw, head yaw, pitch; arrows: yaw, pitch).
    let a = 0, b = 0, c = 0;
    if (s[1] === 'm') { a = s[5]; b = s[6]; c = s[7]; }
    else if (s[1] === 'r') { a = s[5]; c = s[6]; }
    if (first || !e._track) {
      e._track = new Track(x, y, z, a, b, c);
      e.setPosition(x, y, z);
    } else if (!e.collector) {
      e._track.target(x, y, z, a, b, c);
    }
  }

  /** Local hit on a replica mob: forwarded with this frame's knockback push (see interaction.attackEntity). */
  _hurt(m, amount) {
    if (m.dead || m.removed) return false;
    this._attack = { t: 'at', id: m._netId, d: Math.round(amount * 100) / 100 };
    return true;
  }

  _push(m, vx, vy, vz) {
    if (this._attack && this._attack.id === m._netId) this._attack.kb = [vx, vy, vz].map((v) => Math.round(v * 100) / 100);
  }

  /** Send the hit of this frame (called by the client after the interaction update). */
  flushAttack() {
    if (!this._attack) return;
    this.client.send(this._attack);
    this._attack = null;
  }

  // ---- per frame ---------------------------------------------------------------------------------

  update(dt) {
    if (!(dt > 0)) return;
    const world = this.game?.world;
    this._lightTimer -= dt;
    const relight = this._lightTimer <= 0;
    if (relight) this._lightTimer = 0.25;
    const list = this.list;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e.removed) continue;
      e.age += dt;
      e.frozen = false;
      if (e.type === 'item' && e.collector) {
        this._updateCollect(e, dt);
        continue;
      }
      const t = e._track;
      if (t) {
        t.step();
        e.body.x = t.x; e.body.y = t.y; e.body.z = t.z;
      }
      if (e.type === 'mob') this._updateMob(e, dt);
      else if (e.type === 'arrow' && t) { e.yaw = t.a; e.pitch = t.c; }
      else if (e.type === 'tnt') e.fuse = Math.max(0, e.fuse - dt);
      if (world && (relight || e._needLight !== false)) {
        e._needLight = false;
        if (e.type === 'mob') e._sampleLight?.(world);
        else e.updateLight(world);
        e.updateShadow(world);
      }
    }
    this._compactReplicas();
    if (this.game?.player) this.avatar.update(dt, this.game.player, this.game.world, this._handSwing > 0);
  }

  _updateCollect(e, dt) {
    e.collectTime += dt;
    const p = e.collector;
    const t = Math.min(1, e.collectTime / COLLECT_TIME);
    const f = t * t;
    const eye = Number.isFinite(p.eyeHeight) ? p.eyeHeight : PLAYER.EYE_HEIGHT;
    e.body.x = e._cx + (p.x - e._cx) * f;
    e.body.y = e._cy + (p.y + eye / 2 - e._cy) * f;
    e.body.z = e._cz + (p.z - e._cz) * f;
    if (t >= 1 && (e._removeAfterCollect || !this.byId.has(e._netId))) e.remove();
  }

  _updateMob(e, dt) {
    const t = e._track;
    if (t) {
      e.bodyYaw = t.a;
      e.headYaw = t.b;
      e.pitch = t.c;
      e.yaw = t.a;
    }
    if (e.hurtTime > 0) e.hurtTime = Math.max(0, e.hurtTime - dt);
    if (e.attackAnim >= 0) {
      e.attackAnim += dt;
      if (e.attackAnim >= SWING_TIME) e.attackAnim = -1;
    }
    if (e.dead) e.deathTime += dt;
    // Limb swing from the replica's own motion (Mob._animate's walk animation).
    const b = e.body;
    const k = dt * TICKS;
    if (e._lx !== e._lx) { e._lx = b.x; e._lz = b.z; e._ly = b.y; }
    const dx = b.x - e._lx, dz = b.z - e._lz, dy = b.y - e._ly;
    e._lx = b.x; e._lz = b.z; e._ly = b.y;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist > 4 * k + 1) {
      e.limbSwingAmount = 0;
    } else {
      const target = e.dead ? 0 : Math.min(1, (dist / Math.max(1e-6, k)) * 4);
      e.limbSwingAmount += (target - e.limbSwingAmount) * (1 - Math.pow(0.6, k));
      e.limbSwing += e.limbSwingAmount * k;
    }
    if (e.def.slowFall) {
      const ground = Math.abs(dy) < 0.002 * k;
      e.flapSpeed = Math.min(1, Math.max(0, e.flapSpeed + (ground ? -1 : 4) * 0.3 * k));
      if (!ground && e._flapping < 1) e._flapping = 1;
      e._flapping *= Math.pow(0.9, k);
      e.flap += e._flapping * 2 * k;
    }
  }

  _compactReplicas() {
    const list = this.list;
    let w = 0;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e.removed) {
        if (this.byId.get(e._netId) === e) this.byId.delete(e._netId);
        e.manager = null;
        continue;
      }
      list[w++] = e;
    }
    list.length = w;
  }

  getRenderList(out) {
    const dst = super.getRenderList(out);
    this.client.players.appendRenderItems(dst);
    return dst;
  }

  clear() {
    super.clear();
    this.byId.clear();
    this._attack = null;
  }
}

// =====================================================================================================
// Other players
// =====================================================================================================

/** Position flag bits (same as server/remoteplayer.mjs PF). */
export const PF = Object.freeze({
  SNEAK: 1, SPRINT: 2, FLY: 4, GROUND: 8, DEAD: 16, SWING: 32, BOW: 64, EAT: 128, FIRE: 256, WATER: 512,
});

class Ghost {
  constructor(id, name) {
    this.id = id;
    this.name = name;
    this.isPlayer = true;
    this.avatar = new PlayerAvatar();
    this.track = null;
    this.x = 0; this.y = 0; this.z = 0;
    this.yaw = 0; this.pitch = 0;
    this.flags = 0;
    this.heldItem = 0;
    this.creative = false;
    this.visible = false;
    this.eyeHeight = PLAYER.EYE_HEIGHT;
    this.hurtTime = 0;
    this.dead = false;
    this.deathTime = 0;
    this.fireTime = 0;
    this.usingItem = null;
    this.useTime = 0;
    this._swing = 0;
    this._hand = { itemId: 0, swing: 0, useAction: null, useTime: 0 };
  }

  get sneaking() { return (this.flags & PF.SNEAK) !== 0; }
  get flying() { return (this.flags & PF.FLY) !== 0; }
}

export class RemotePlayers {
  constructor() {
    /** id -> Ghost */
    this.map = new Map();
  }

  join(id, name) {
    let g = this.map.get(id);
    if (!g) this.map.set(id, (g = new Ghost(id, name)));
    g.name = name;
    return g;
  }

  leave(id) {
    this.map.delete(id);
  }

  hide(ids) {
    for (const id of ids) {
      const g = this.map.get(id);
      if (g) g.visible = false;
    }
  }

  get(id) {
    return this.map.get(id) ?? null;
  }

  /** 'pu' rows: [id, x, y, z, yaw, pitch, flags, heldItem, creative]. */
  apply(rows) {
    for (const r of rows) {
      const g = this.map.get(r[0]);
      if (!g) continue;
      const [, x, y, z, yaw, pitch, flags, held, creative] = r;
      if (!g.track || !g.visible) {
        g.track = new Track(x, y, z, yaw, pitch, 0);
        g.avatar.reset();
      } else {
        g.track.target(x, y, z, yaw, pitch, 0);
      }
      const wasDead = g.dead;
      g.flags = flags | 0;
      g.dead = (g.flags & PF.DEAD) !== 0;
      if (g.dead && !wasDead) g.deathTime = 0;
      if ((g.flags & PF.SWING) !== 0 && g._swing <= 0) g._swing = 1e-3;
      g.heldItem = held | 0;
      g.creative = !!creative;
      g.visible = true;
    }
  }

  update(dt, world) {
    for (const g of this.map.values()) {
      if (!g.visible || !g.track) continue;
      g.track.step();
      g.x = g.track.x; g.y = g.track.y; g.z = g.track.z;
      g.yaw = g.track.a; g.pitch = g.track.b;
      if (g.dead) g.deathTime += dt;
      g.fireTime = (g.flags & PF.FIRE) !== 0 ? 1 : 0;
      g.usingItem = (g.flags & PF.BOW) !== 0 ? 'bow' : null;
      g.useTime = g.usingItem ? g.useTime + dt : 0;
      if (g._swing > 0) {
        g._swing += dt / 0.3;
        if (g._swing >= 1) g._swing = 0;
      }
      g.avatar.update(dt, g, world, g._swing > 0);
    }
  }

  appendRenderItems(dst) {
    for (const g of this.map.values()) {
      if (!g.visible || !g.track) continue;
      const h = g._hand;
      h.itemId = g.heldItem;
      h.swing = g._swing;
      h.useAction = g.usingItem;
      h.useTime = g.useTime;
      dst.push(g.avatar.getRenderItem(g, h));
    }
  }

  clear() {
    this.map.clear();
  }
}

// =====================================================================================================
// Chests / furnaces
// =====================================================================================================

/**
 * Block entity manager stand-in while connected: containers live on the server. Right-clicking a chest
 * or furnace asks the server, whose reply opens the screen on a local copy (client.js _containerState).
 */
export class RemoteBlockEntities {
  constructor(game, client) {
    this.game = game;
    this.client = client;
    this.dirty = false;
  }

  get count() { return 0; }
  get list() { return []; }

  useBlock(x, y, z, blockId) {
    if (!containerType(blockId)) return false;
    this.client.openContainer(x, y, z);
    return true;
  }

  get() { return null; }
  getOrCreate() { return null; }
  remove() { return false; }
  attach() { return this; }
  detach() {}
  tick() {}
  clear() {}
  serialize() { return []; }
  deserialize() { return 0; }
}
