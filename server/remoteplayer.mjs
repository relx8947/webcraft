// Server-side stand-in for a connected player. The browser simulates its own player (movement, health,
// hunger, inventory); this object mirrors what the server needs and forwards everything the shared
// simulation does to a player (damage, knockback, pushes, item pickup, teleports, game mode) to the client:
//   x, y, z, yaw, pitch, flags      from the client's 20 Hz position messages
//   mode, dead, health              from state messages
//   inventory                       mirror of the client's inventory (updated by 'inv' messages); add() =
//                                   item pickup / /give -> 'give' to the client
//   vx / vy / vz                    reads give the client-reported velocity; writes (explosions, mob pushes)
//                                   are accumulated and sent as one 'vel' push per tick
import { Inventory } from '../src/game/inventory.js';
import { PLAYER } from '../src/config.js';
import { packStack } from '../src/net/protocol.js';

/** Position flag bits (client -> server 'p' messages, relayed to the other players). */
export const PF = Object.freeze({
  SNEAK: 1, SPRINT: 2, FLY: 4, GROUND: 8, DEAD: 16, SWING: 32, BOW: 64, EAT: 128, FIRE: 256, WATER: 512,
});

class MirrorInventory extends Inventory {
  constructor(player) {
    super(36);
    this.player = player;
  }

  /** Item pickup / give: what fits in the mirror is sent to the client (which adds it to the real one). */
  add(stack) {
    const before = stack && stack.count > 0 ? stack.count : 0;
    const left = super.add(stack);
    const taken = before - left;
    if (taken > 0) this.player.send({ t: 'give', s: packStack({ id: stack.id, count: taken, damage: stack.damage ?? 0 }) });
    return left;
  }

  /** Replace every slot (client 'inv' message). */
  load(slots) {
    for (let i = 0; i < this.size; i++) this.slots[i] = slots[i] ?? null;
    this.version++;
  }
}

export class RemotePlayer {
  /**
   * @param {object} session  sends messages to the client (session.send(obj))
   * @param {string} name
   */
  constructor(session, name) {
    this.session = session;
    this.name = name;
    this.isPlayer = true;
    this.id = 0;                     // network id (set by the server)
    this.x = 0; this.y = 0; this.z = 0;
    this.yaw = 0; this.pitch = 0;
    this._vx = 0; this._vy = 0; this._vz = 0;
    this._push = [0, 0, 0];
    this._pushPending = false;
    this.flags = 0;
    this.selectedSlot = 0;
    this.heldItem = 0;
    this.mode = 'survival';
    this.health = 20;
    this.dead = false;
    this.width = PLAYER.WIDTH;
    this.eyeHeight = PLAYER.EYE_HEIGHT;
    this._spawnPoint = null;
    this.inventory = new MirrorInventory(this);
    this.lastAttacker = null;
    /** Pending teleport for the client: { x, y, z, yaw?, pitch? } (sent by flush()). */
    this._tp = null;
    this._aabb = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };
  }

  send(msg) {
    this.session.send(msg);
  }

  get sneaking() { return (this.flags & PF.SNEAK) !== 0; }
  get sprinting() { return (this.flags & PF.SPRINT) !== 0; }
  get flying() { return (this.flags & PF.FLY) !== 0; }
  get onGround() { return (this.flags & PF.GROUND) !== 0; }
  get inWater() { return (this.flags & PF.WATER) !== 0; }
  get height() { return this.sneaking ? 1.5 : PLAYER.HEIGHT; }

  // Velocity: reads = last reported motion, writes = impulses forwarded to the client.
  get vx() { return this._vx; }
  set vx(v) { this._addPush(0, v - this._vx); }
  get vy() { return this._vy; }
  set vy(v) { this._addPush(1, v - this._vy); }
  get vz() { return this._vz; }
  set vz(v) { this._addPush(2, v - this._vz); }

  _addPush(axis, dv) {
    if (!Number.isFinite(dv) || dv === 0) return;
    this._push[axis] += dv;
    this._pushPending = true;
  }

  getAABB(out = this._aabb) {
    const hw = this.width / 2;
    out.minX = this.x - hw; out.maxX = this.x + hw;
    out.minY = this.y; out.maxY = this.y + this.height;
    out.minZ = this.z - hw; out.maxZ = this.z + hw;
    return out;
  }

  getSelectedStack() {
    return this.inventory.get(this.selectedSlot);
  }

  /** Mobs, arrows and explosions hurt the player: the client applies it (armor, hurt cooldown, death). */
  damage(amount, cause = 'generic', message, attacker = null) {
    if (this.dead || !(amount > 0) || this.mode === 'creative') return false;
    const src = attacker?.shooter ?? attacker;
    if (src?.isPlayer && src !== this && !this.session.server?.config?.pvp) return false;
    const a = describeAttacker(attacker);
    if (attacker) this.lastAttacker = attacker;
    this.send({ t: 'hurt', a: Math.round(amount * 100) / 100, c: cause, m: typeof message === 'string' ? message : undefined, by: a });
    return true;
  }

  knockback(dx, dz, strength = 0.4) {
    if (this.dead || this.mode === 'creative') return false;
    this.send({ t: 'kb', dx: Math.round(dx * 1000) / 1000, dz: Math.round(dz * 1000) / 1000, s: strength });
    return true;
  }

  kill(message) {
    if (this.dead) return;
    this.send({ t: 'kill', m: typeof message === 'string' ? message : undefined });
    this.dead = true;              // optimistic (commands check it); the client confirms with a state message
    this.health = 0;
  }

  heal() {}

  setPosition(x, y, z) {
    this.x = x; this.y = y; this.z = z;
    this._tp = { x, y, z };
  }

  setGameMode(mode) {
    if (mode !== 'survival' && mode !== 'creative') return;
    this.mode = mode;
    this.send({ t: 'mode', m: mode });
  }

  /** Personal spawn point; assigning one (/spawnpoint) tells the client. */
  get spawnPoint() { return this._spawnPoint; }
  set spawnPoint(sp) {
    this._spawnPoint = sp ? { ...sp } : null;
    this.send({ t: 'spawnpoint', p: this._spawnPoint });
  }

  /** Send what accumulated during this tick (pushes, teleports). */
  flush() {
    if (this._pushPending) {
      const p = this._push;
      const r = (v) => Math.round(v * 1000) / 1000;
      if (this.mode !== 'creative' && !this.dead) this.send({ t: 'vel', v: [r(p[0]), r(p[1]), r(p[2])] });
      p[0] = 0; p[1] = 0; p[2] = 0;
      this._pushPending = false;
    }
    if (this._tp) {
      const tp = this._tp;
      this._tp = null;
      this.send({ t: 'tp', x: tp.x, y: tp.y, z: tp.z, yaw: tp.yaw, pitch: tp.pitch });
    }
  }

  /** Apply a client position message. */
  applyPosition(m) {
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const x = num(m.x), y = num(m.y), z = num(m.z);
    if (x !== null && y !== null && z !== null && Math.abs(x) < 3e7 && Math.abs(z) < 3e7 && y > -1000 && y < 1000) {
      this.x = x; this.y = y; this.z = z;
    }
    const yaw = num(m.yw), pitch = num(m.pt);
    if (yaw !== null) this.yaw = yaw;
    if (pitch !== null) this.pitch = Math.max(-1.6, Math.min(1.6, pitch));
    const v = Array.isArray(m.v) ? m.v : null;
    if (v) {
      this._vx = num(v[0]) ?? 0; this._vy = num(v[1]) ?? 0; this._vz = num(v[2]) ?? 0;
    }
    if (Number.isInteger(m.f)) {
      this.flags = m.f & 0xffff;
      this.dead = (this.flags & PF.DEAD) !== 0;
    }
    if (Number.isInteger(m.s) && m.s >= 0 && m.s <= 8) this.selectedSlot = m.s;
    const held = this.getSelectedStack();
    this.heldItem = held ? held.id : 0;
  }
}

/** Attacker summary sent with 'hurt' (death messages, knockback direction). */
export function describeAttacker(attacker) {
  if (!attacker || typeof attacker !== 'object') return undefined;
  const src = attacker.shooter ?? attacker;
  const out = {};
  if (Number.isFinite(src.x)) { out.x = Math.round(src.x * 100) / 100; out.z = Math.round(src.z * 100) / 100; }
  if (src.isPlayer) {
    out.k = 'player';
    out.n = src.name;
  } else if (src.type === 'mob') {
    out.k = 'mob';
    out.mt = src.mobType;
  }
  if (attacker.type === 'arrow') out.arrow = 1;
  return out;
}

