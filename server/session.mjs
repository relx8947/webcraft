// One WebSocket connection of the dedicated server: handshake (name + name token), validation and rate
// limits of everything the client sends, and the per-client replication state (subscribed chunks, block
// change batches, last entity / player states sent). Message list: docs/MULTIPLAYER.md.
import crypto from 'node:crypto';
import {
  PROTOCOL_VERSION, CHAT_MAX, validName, packStack, unpackStack, sameStack, q2, qa,
} from '../src/net/protocol.js';
import { BLOCKS, BLOCK, VALID_BLOCK_IDS, IS_LIQUID } from './blocks-allowed.mjs';
import { MOB_TYPES } from '../src/game/mobs.js';
import { COMMAND_LIST } from '../src/game/commands.js';
import { chunkKeyNum } from '../src/world/chunk.js';
import { RemotePlayer, PF } from './remoteplayer.mjs';

const HELLO_TIMEOUT_MS = 10000;
const REACH = 8;                         // max distance eye -> block centre for edits (survival reach 4.5 + lag)
const ENTITY_REACH = 7;
const MAX_SUBS = 2000;
const VIEW_MAX = 16;

/** Token bucket rate limiter. */
class Bucket {
  constructor(rate, burst) {
    this.rate = rate;
    this.burst = burst;
    this.tokens = burst;
    this.last = performance.now();
  }

  take(n = 1) {
    const now = performance.now();
    this.tokens = Math.min(this.burst, this.tokens + (now - this.last) / 1000 * this.rate);
    this.last = now;
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }
}

/** Commands everyone may use; every other command needs operator rights. */
const PUBLIC_COMMANDS = new Set(['help', 'me', 'seed', 'list', 'login', 'kill']);
const COMMAND_NAMES = new Map();
for (const c of COMMAND_LIST) {
  COMMAND_NAMES.set(c.name, c.name);
  for (const a of c.aliases) COMMAND_NAMES.set(a, c.name);
}
for (const n of ['list', 'login', 'op', 'deop', 'kick', 'ban', 'unban', 'save', 'forget', 'status']) COMMAND_NAMES.set(n, n);

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const int = (v) => Number.isInteger(v);

export class Session {
  /**
   * @param {import('./servergame.mjs').ServerGame} server
   * @param {import('./ws.mjs').WebSocketConnection} ws
   * @param {string} ip
   */
  constructor(server, ws, ip) {
    this.server = server;
    this.ws = ws;
    this.ip = ip;
    this.player = null;
    this.ready = false;
    this.rd = 8;
    /** Subscribed chunk keys (chunkKeyNum). */
    this.subs = new Set();
    this._blocks = [];               // queued block changes [x, y, z, id, ...]
    this._known = new Map();         // entity id -> last state string sent
    this._knownPlayers = new Map();  // player id -> last state string sent
    this._limits = {
      msg: new Bucket(300, 600),
      edit: new Bucket(40, 80),
      chat: new Bucket(1, 5),
      spawn: new Bucket(20, 60),
      attack: new Bucket(10, 20),
      cmd: new Bucket(2, 6),
    };
    this._helloTimer = setTimeout(() => this.close(4000, '握手超时'), HELLO_TIMEOUT_MS);
    this._lastRecord = null;
    ws.on('message', (data, isBinary) => this._onMessage(data, isBinary));
    ws.on('close', () => this._onClose());
  }

  send(msg) {
    if (this.ws.readyState === 1) this.ws.send(JSON.stringify(msg));
  }

  sendRaw(text) {
    if (this.ws.readyState === 1) this.ws.send(text);
  }

  close(code, reason) {
    this.ws.close(code, reason);
  }

  // =================================================================================================
  // Incoming
  // =================================================================================================

  _onMessage(data, isBinary) {
    if (!this._limits.msg.take()) {
      this.close(4008, '发送的消息太多了');
      return;
    }
    if (isBinary) return;            // clients only send JSON
    let m;
    try {
      m = JSON.parse(data);
    } catch {
      return;
    }
    if (!m || typeof m !== 'object' || typeof m.t !== 'string') return;
    try {
      if (!this.player) {
        if (m.t === 'hello') this._hello(m);
        return;
      }
      const h = HANDLERS[m.t];
      if (h) h.call(this, m);
    } catch (err) {
      this.server.log('error', `message '${m.t}' from ${this.player?.name ?? this.ip} failed:`, err);
    }
  }

  _hello(m) {
    const server = this.server;
    const meta = server.worldMeta;
    if (m.v !== PROTOCOL_VERSION) {
      this.send({ t: 'deny', r: '游戏版本和服务器不一致，请刷新页面（Ctrl+F5）后重试。' });
      this.close(4001, 'version');
      return;
    }
    const name = typeof m.name === 'string' ? m.name.trim() : '';
    if (!validName(name)) {
      this.send({ t: 'deny', r: '名字只能包含 1-16 个汉字、字母、数字、下划线或减号。' });
      this.close(4002, 'name');
      return;
    }
    const ban = meta.bans[name.toLowerCase()] ?? meta.bans['ip:' + this.ip];
    if (ban) {
      this.send({ t: 'deny', r: `你已被禁止进入这个服务器${ban.reason ? '：' + ban.reason : ''}` });
      this.close(4003, 'banned');
      return;
    }
    if (server.findPlayer(name)) {
      this.send({ t: 'deny', r: '这个名字的玩家已经在线了。' });
      this.close(4004, 'online');
      return;
    }
    if (server.players.length >= server.config.maxPlayers) {
      this.send({ t: 'deny', r: `服务器已满（${server.config.maxPlayers} 人），请稍后再来。` });
      this.close(4005, 'full');
      return;
    }
    // Names are claimed by the first browser that uses them (a random token kept in its localStorage).
    const key = name.toLowerCase();
    let rec = meta.players[key];
    if (rec && rec.token && rec.token !== m.token) {
      this.send({ t: 'deny', r: '这个名字已经被别人使用了，请换一个名字。（如果这是你的名字，请使用第一次进入时的浏览器。）' });
      this.close(4006, 'claimed');
      return;
    }
    if (!rec) {
      rec = meta.players[key] = { name, token: crypto.randomBytes(16).toString('hex'), created: Date.now(), rec: null };
    }
    rec.lastSeen = Date.now();
    rec.ip = this.ip;
    clearTimeout(this._helloTimer);
    this.rd = int(m.rd) ? Math.max(2, Math.min(VIEW_MAX, m.rd)) : 8;
    const p = new RemotePlayer(this, rec.name);
    p.id = server.allocPlayerId();
    if (rec.rec) {
      const r = rec.rec;
      if (finite(r.x) && finite(r.y) && finite(r.z)) { p.x = r.x; p.y = r.y; p.z = r.z; }
      p.mode = r.mode === 'creative' ? 'creative' : 'survival';
      p.dead = !!r.dead;
      if (Array.isArray(r.inventory)) p.inventory.load(r.inventory.map((s) => (s ? { id: s.id, count: s.count, damage: s.damage ?? 0 } : null)));
      if (r.spawnPoint) p._spawnPoint = r.spawnPoint;
    } else {
      p.x = meta.spawn.x; p.y = meta.spawn.y; p.z = meta.spawn.z;
    }
    this.player = p;
    this._record = rec;
    server.addPlayer(this);
    this.send({
      t: 'welcome', id: p.id, name: rec.name, token: rec.token,
      world: { name: meta.name, seed: meta.seed, type: meta.worldType, spawn: meta.spawn },
      time: server.time, difficulty: server.settings.difficulty, op: server.isOp(rec.name),
      rec: rec.rec, players: server.players.filter((q) => q !== p).map((q) => ({ id: q.id, n: q.name })),
      motd: server.config.motd ?? '',
      maxView: VIEW_MAX,
    });
    this.ready = true;
    server.chat(`§e${rec.name} 加入了游戏`);
    server.log('info', `${rec.name} joined from ${this.ip} (${server.players.length} online)`);
  }

  _onClose() {
    clearTimeout(this._helloTimer);
    const server = this.server;
    if (!this.player) return;
    this.storePlayerRecord();
    server.removePlayer(this);
    server.chat(`§e${this.player.name} 离开了游戏`);
    server.log('info', `${this.player.name} left (${server.players.length} online)`);
    this.ready = false;
  }

  /** Keep the player's latest saved record (client 'save' messages) in the world meta. */
  storePlayerRecord() {
    if (this._record && this._lastRecord) this._record.rec = this._lastRecord;
  }

  // =================================================================================================
  // Outgoing replication
  // =================================================================================================

  queueBlock(x, y, z, id) {
    this._blocks.push(x, y, z, id);
  }

  flushBlocks() {
    if (this._blocks.length === 0) return;
    this.send({ t: 'b', l: this._blocks });
    this._blocks = [];
  }

  /** Entities near the player: full states of new / changed ones, removals of gone ones. */
  sendEntitySnapshot(entities) {
    const p = this.player;
    const range = Math.min(96, this.rd * 16);
    const r2 = range * range;
    const seen = new Set();
    let updates = null;
    for (const e of entities.list) {
      if (e.removed) continue;
      const dx = e.x - p.x, dz = e.z - p.z;
      if (dx * dx + dz * dz > r2) continue;
      const s = entityState(e);
      if (!s) continue;
      seen.add(e.id);
      const key = JSON.stringify(s);
      if (this._known.get(e.id) === key) continue;
      this._known.set(e.id, key);
      (updates ??= []).push(s);
    }
    let gone = null;
    for (const id of this._known.keys()) {
      if (!seen.has(id)) {
        this._known.delete(id);
        (gone ??= []).push(id);
      }
    }
    if (updates) this.send({ t: 'e', l: updates });
    if (gone) this.send({ t: 'ed', l: gone });
  }

  sendPlayerSnapshot(players) {
    const me = this.player;
    let updates = null;
    const seen = new Set();
    for (const q of players) {
      if (q === me) continue;
      const dx = q.x - me.x, dz = q.z - me.z;
      if (dx * dx + dz * dz > 256 * 256) continue;
      seen.add(q.id);
      const s = [q.id, q2(q.x), q2(q.y), q2(q.z), qa(q.yaw), qa(q.pitch), q.flags, q.heldItem, q.mode === 'creative' ? 1 : 0];
      const key = s.join(',');
      if (this._knownPlayers.get(q.id) === key) continue;
      this._knownPlayers.set(q.id, key);
      (updates ??= []).push(s);
    }
    let hidden = null;
    for (const id of this._knownPlayers.keys()) {
      if (!seen.has(id)) {
        this._knownPlayers.delete(id);
        (hidden ??= []).push(id);
      }
    }
    if (updates) this.send({ t: 'pu', l: updates });
    if (hidden) this.send({ t: 'ph', l: hidden });
  }

  // =================================================================================================
  // Helpers
  // =================================================================================================

  _inReach(x, y, z, reach) {
    const p = this.player;
    const dx = x - p.x, dy = y - (p.y + 1.62), dz = z - p.z;
    return dx * dx + dy * dy + dz * dz <= reach * reach;
  }

  get isOp() {
    return this.server.isOp(this.player.name);
  }
}

// =================================================================================================
// Entity states (also used by the client to build replicas, see src/net/replica.js)
// =================================================================================================

/**
 * Compact state array of an entity: [id, kind, x, y, z, ...kind fields], or null for entities that are not
 * replicated.
 *   item   'i' x y z [stack] seed collectorPlayerId
 *   falling'f' x y z blockId
 *   tnt    't' x y z fuse
 *   arrow  'r' x y z yaw pitch inGround critical shake
 *   mob    'm' x y z bodyYaw headYaw pitch mobType flags swell heldItem color eatTicks useTicks
 */
export function entityState(e) {
  const b = e.body;
  switch (e.type) {
    case 'item':
      return [e.id, 'i', q2(b.x), q2(b.y), q2(b.z), packStack(e.stack), Math.round(e.seed * 1000) / 1000,
        e.collector && e.collector.isPlayer ? e.collector.id : 0];
    case 'falling_block':
      return [e.id, 'f', q2(b.x), q2(b.y), q2(b.z), e.blockId];
    case 'tnt':
      return [e.id, 't', q2(b.x), q2(b.y), q2(b.z), Math.round(e.fuse * 20)];
    case 'arrow':
      return [e.id, 'r', q2(b.x), q2(b.y), q2(b.z), qa(e.yaw), qa(e.pitch), e.inGround ? 1 : 0, e.critical ? 1 : 0,
        e.shake > 0 ? Math.round(e.shake) : 0];
    case 'mob': {
      const flags = (e.dead ? 1 : 0) | (e.hurtTime > 0 ? 2 : 0) | (e.fireTime > 0 ? 4 : 0) | (e.sheared ? 8 : 0) |
        (e.aggressive ? 16 : 0) | (e.attackAnim >= 0 ? 32 : 0);
      return [e.id, 'm', q2(b.x), q2(b.y), q2(b.z), qa(e.bodyYaw), qa(e.headYaw), qa(e.pitch), e.mobType, flags,
        e.swell | 0, e.heldItem | 0, e.color, e.eatTicks > 0 ? Math.round(e.eatTicks) : 0, Math.round(e.useTicks || 0)];
    }
    default:
      return null;
  }
}

// =================================================================================================
// Handlers (this = Session)
// =================================================================================================

const HANDLERS = {
  /** Position / look / flags (20 Hz). */
  p(m) {
    this.player.applyPosition(m);
  },

  /** Chunk subscriptions: reply with the chunk's contents, then stream its changes. */
  sub(m) {
    if (!Array.isArray(m.c)) return;
    const server = this.server;
    for (let i = 0; i + 2 < m.c.length && i < 1536; i += 3) {
      const cx = m.c[i], cz = m.c[i + 1], seq = m.c[i + 2];
      if (!int(cx) || !int(cz) || !int(seq)) continue;
      const key = chunkKeyNum(cx, cz);
      if (!this.subs.has(key) && this.subs.size >= MAX_SUBS) break;
      this.subs.add(key);
      server.chunkFrame(cx, cz, seq).then((frame) => {
        // Changes queued before this reply describe the state the reply already contains or older:
        // they are harmless (the reply is applied first, then the batch on the next tick).
        if (this.subs.has(key) && this.ws.readyState === 1) this.ws.send(frame);
      }, (err) => server.log('error', `chunk ${cx},${cz} for ${this.player.name} failed:`, err));
    }
  },

  unsub(m) {
    if (!Array.isArray(m.c)) return;
    for (let i = 0; i + 1 < m.c.length; i += 2) {
      if (int(m.c[i]) && int(m.c[i + 1])) this.subs.delete(chunkKeyNum(m.c[i], m.c[i + 1]));
    }
  },

  /** Block edits of the player (break / place / use). */
  e(m) {
    const x = m.x, y = m.y, z = m.z, id = m.id;
    if (!int(x) || !int(y) || !int(z) || !int(id) || y < 0 || y > 255) return;
    const server = this.server;
    const current = server.blockAt(x, y, z);
    const reject = () => {
      if (current >= 0) this.queueBlock(x, y, z, current);
    };
    if (!this._limits.edit.take() || this.player.dead) return reject();
    if (!VALID_BLOCK_IDS[id] && !(this.isOp && BLOCKS[id])) return reject();
    if (!this._inReach(x + 0.5, y + 0.5, z + 0.5, REACH) && !this.isOp) return reject();
    server.applyEdit(this, x, y, z, id);
  },

  /** Entity spawns caused by the player: item drops, arrows, lit TNT, spawn eggs. */
  s(m) {
    const server = this.server;
    const p = this.player;
    if (!this._limits.spawn.take()) return;
    const pos = Array.isArray(m.p) ? m.p : null;
    if (!pos || !finite(pos[0]) || !finite(pos[1]) || !finite(pos[2])) return;
    const [x, y, z] = pos;
    if (!this._inReach(x, y, z, 10)) return;
    const v = Array.isArray(m.v) ? m.v.map((n) => (finite(n) ? Math.max(-80, Math.min(80, n)) : 0)) : [0, 0, 0];
    switch (m.k) {
      case 'item': {
        const stack = unpackStack(m.s);
        if (!stack) return;
        const delay = finite(m.d) ? Math.max(0, Math.min(10, m.d)) : undefined;
        server.entities.spawnItem(stack, x, y, z, v[0], v[1], v[2], delay);
        break;
      }
      case 'arrow': {
        const damage = finite(m.dmg) ? Math.max(0, Math.min(10, m.dmg)) : 2;
        server.entities.spawnArrow(x, y, z, v[0], v[1], v[2], { shooter: p, damage, critical: !!m.crit, pickup: !!m.pick });
        break;
      }
      case 'tnt':
        server.entities.spawnPrimedTnt(x, y, z, finite(m.f) ? Math.max(0.5, Math.min(8, m.f)) : undefined);
        break;
      case 'mob': {
        if (!MOB_TYPES[m.mt]) return;
        server.spawnMob(m.mt, x, y, z, { persistent: !!m.ps, yaw: finite(m.yaw) ? m.yaw : undefined });
        break;
      }
      default:
    }
  },

  /** The player hit an entity. */
  at(m) {
    if (!int(m.id) || !this._limits.attack.take() || this.player.dead) return;
    const e = this.server.entityById(m.id);
    if (!e || !this._inReach(e.x, e.y + (e.height || 1) / 2, e.z, ENTITY_REACH)) return;
    const dmg = finite(m.d) ? Math.max(0, Math.min(30, m.d)) : 1;
    e.hurt(dmg, 'player', this.player);
    if (Array.isArray(m.kb) && typeof e.push === 'function') {
      const k = m.kb.map((n) => (finite(n) ? Math.max(-20, Math.min(20, n)) : 0));
      e.push(k[0], k[1], k[2]);
    }
  },

  /** Inventory mirror (item pickup decisions, /give, saving). */
  inv(m) {
    if (!Array.isArray(m.sl) || m.sl.length !== 36) return;
    this.player.inventory.load(m.sl.map(unpackStack));
    if (int(m.s) && m.s >= 0 && m.s <= 8) this.player.selectedSlot = m.s;
  },

  /** Player state for the server's logic (game mode, death). */
  st(m) {
    const p = this.player;
    if (m.mode === 'survival' || (m.mode === 'creative' && (p.mode === 'creative' || this.isOp))) p.mode = m.mode;
    if (typeof m.dead === 'boolean') p.dead = m.dead;
    if (finite(m.hp)) p.health = Math.max(0, Math.min(20, m.hp));
  },

  /** The full player record (Player.serialize()) for persistence. */
  save(m) {
    const r = m.rec;
    if (!r || typeof r !== 'object' || !finite(r.x) || !finite(r.y) || !finite(r.z)) return;
    const text = JSON.stringify(r);
    if (text.length > 20000) return;
    const rec = JSON.parse(text);
    // The game mode is the server's decision (only operators switch to creative themselves).
    rec.mode = this.player.mode;
    if (rec.mode !== 'creative') rec.flying = false;
    this._lastRecord = rec;
  },

  /** Death message of the player (broadcast to everyone). */
  died(m) {
    const p = this.player;
    p.dead = true;
    let text = typeof m.m === 'string' ? m.m.slice(0, 80).replace(/§./g, '') : '';
    if (!text) text = '死了';
    this.server.chat(`${p.name}${text.startsWith('玩家') ? text.slice(2) : text}`);
  },

  /** Chat line or command. */
  chat(m) {
    let text = typeof m.m === 'string' ? m.m.trim() : '';
    if (!text) return;
    if (text.length > CHAT_MAX) text = text.slice(0, CHAT_MAX);
    if (text.startsWith('/')) {
      if (!this._limits.cmd.take()) {
        this.send({ t: 'chat', m: '§c命令发送得太快了', c: '#FF5555' });
        return;
      }
      runServerCommand(this, text);
      return;
    }
    if (!this._limits.chat.take()) {
      this.send({ t: 'chat', m: '§c你说话太快了，休息一下吧', c: '#FF5555' });
      return;
    }
    text = text.replace(/§/g, '');
    this.server.chat(`<${this.player.name}> ${text}`);
  },

  /** Open / change / close a chest or furnace screen. */
  co(m) {
    if (!int(m.x) || !int(m.y) || !int(m.z)) return;
    if (!this._inReach(m.x + 0.5, m.y + 0.5, m.z + 0.5, REACH)) return;
    const be = this.server.openContainer(this, m.x, m.y, m.z);
    if (!be) {
      this.send({ t: 'cx', x: m.x, y: m.y, z: m.z });
      return;
    }
    this.send({ t: 'ct', be: be.serialize(), open: true });
  },

  cs(m) {
    if (!int(m.x) || !int(m.y) || !int(m.z) || !Array.isArray(m.ch)) return;
    const c = this.server.containers.get(`${m.x},${m.y},${m.z}`);
    if (!c || !c.viewers.has(this) || c.be.removed) {
      this.send({ t: 'cx', x: m.x, y: m.y, z: m.z });
      return;
    }
    const be = c.be;
    let conflict = false;
    for (const ch of m.ch.slice(0, 64)) {
      if (!Array.isArray(ch) || !int(ch[0]) || ch[0] < 0 || ch[0] >= be.size) continue;
      const from = unpackStack(ch[1]);
      const to = unpackStack(ch[2]);
      if (!sameStack(be.get(ch[0]), from)) {
        conflict = true;
        continue;
      }
      be.set(ch[0], to);
    }
    if (conflict) this.send({ t: 'ct', be: be.serialize() });
    // Other viewers get the change on the next container update (state string compare).
  },

  cc(m) {
    if (int(m.x) && int(m.y) && int(m.z)) this.server.closeContainer(this, m.x, m.y, m.z);
  },

  /** Keep-alive / latency probe. */
  ping(m) {
    this.send({ t: 'pong', n: m.n });
  },

  /** View distance change. */
  rd(m) {
    if (int(m.rd)) this.rd = Math.max(2, Math.min(VIEW_MAX, m.rd));
  },
};

// =================================================================================================
// Commands
// =================================================================================================

function say(session, text, color) {
  session.send({ t: 'chat', m: text, c: color });
}

function runServerCommand(session, text) {
  const server = session.server;
  const p = session.player;
  const body = text.replace(/^\/+/, '').trim();
  const [rawName, ...args] = body.split(/\s+/);
  const name = COMMAND_NAMES.get(rawName.toLowerCase());
  server.log('info', `${p.name} issued /${body}`);
  if (!name) {
    say(session, `未知的命令：“/${rawName}”。输入 /help 查看命令列表`, '#FF5555');
    return;
  }
  const op = session.isOp;
  if (!PUBLIC_COMMANDS.has(name) && !op) {
    say(session, '§c只有管理员才能使用这个命令', '#FF5555');
    return;
  }
  // Non-operators may only kill themselves.
  if (name === 'kill' && !op && args.length > 0 && args[0] !== '@s' && args[0] !== p.name) {
    say(session, '§c只有管理员才能杀死其他实体', '#FF5555');
    return;
  }
  const meta = server.worldMeta;
  switch (name) {
    case 'list': {
      const names = server.players.map((q) => (server.isOp(q.name) ? `§6${q.name}§r` : q.name));
      say(session, `当前有 ${names.length} 名玩家在线：${names.join('、')}`);
      return;
    }
    case 'login': {
      const key = server.config.adminKey;
      if (!key || args[0] !== key) {
        say(session, '§c口令不正确', '#FF5555');
        server.log('warn', `${p.name} failed /login`);
        return;
      }
      if (!meta.ops.includes(p.name)) meta.ops.push(p.name);
      session.send({ t: 'op', op: true });
      say(session, '§a你现在是管理员了');
      return;
    }
    case 'op':
    case 'deop': {
      const target = args[0];
      if (!target) return say(session, `用法：/${name} <玩家名>`);
      const i = meta.ops.indexOf(target);
      if (name === 'op' && i < 0) meta.ops.push(target);
      if (name === 'deop' && i >= 0) meta.ops.splice(i, 1);
      const s = [...server.sessions].find((x) => x.player?.name === target);
      s?.send({ t: 'op', op: name === 'op' });
      say(session, name === 'op' ? `已将 ${target} 设为管理员` : `已撤销 ${target} 的管理员权限`);
      return;
    }
    case 'kick':
    case 'ban': {
      const target = args[0];
      if (!target) return say(session, `用法：/${name} <玩家名> [原因]`);
      const reason = args.slice(1).join(' ').slice(0, 100);
      if (name === 'ban') {
        meta.bans[target.toLowerCase()] = { reason, by: p.name, at: Date.now() };
        const s0 = [...server.sessions].find((x) => x.player?.name.toLowerCase() === target.toLowerCase());
        if (s0 && args.includes('--ip')) meta.bans['ip:' + s0.ip] = { reason, by: p.name, at: Date.now() };
      }
      const s = [...server.sessions].find((x) => x.player?.name.toLowerCase() === target.toLowerCase());
      if (s) {
        s.send({ t: 'deny', r: `${name === 'ban' ? '你已被封禁' : '你被请出了服务器'}${reason ? '：' + reason : ''}` });
        s.close(4007, name);
      }
      say(session, name === 'ban' ? `已封禁 ${target}` : s ? `已将 ${target} 请出服务器` : `${target} 不在线`);
      return;
    }
    case 'unban': {
      const target = (args[0] ?? '').toLowerCase();
      if (!target) return say(session, '用法：/unban <玩家名|ip:地址>');
      delete meta.bans[target];
      say(session, `已解除 ${args[0]} 的封禁`);
      return;
    }
    case 'forget': {
      const target = (args[0] ?? '').toLowerCase();
      if (!meta.players[target]) return say(session, '没有这个玩家的记录');
      if (server.findPlayer(target)) return say(session, '这个玩家在线，不能清除名字');
      delete meta.players[target].token;
      say(session, `已释放名字 ${args[0]}：下一个使用这个名字的浏览器会获得它（背包与位置保留）`);
      return;
    }
    case 'save':
      server.save().then(() => say(session, '§a世界已保存'), (err) => say(session, `§c保存失败：${err.message}`, '#FF5555'));
      return;
    case 'status': {
      const st = server.status();
      say(session, `在线 ${st.players.length} · 实体 ${st.entities} · 区块 ${st.chunks} · 最慢的刻 ${st.tps.maxTickMs.toFixed(1)} ms · 超时刻 ${st.tps.slowTicks}`);
      return;
    }
    case 'tp': {
      // /tp <player> and /tp <player> <player> in addition to the coordinate forms.
      const a = args.filter((x) => x !== '@s');
      if (a.length >= 1 && a.length <= 2 && a.every((x) => server.findPlayer(x))) {
        const from = a.length === 2 ? server.findPlayer(a[0]) : p;
        const to = server.findPlayer(a[a.length - 1]);
        from.setPosition(to.x, to.y, to.z);
        from.flush();
        say(session, `已将 ${from.name} 传送到 ${to.name}`);
        return;
      }
      break;
    }
    case 'gamemode': {
      // /gamemode <mode> <player>
      const target = args[1] && args[1] !== '@s' ? server.findPlayer(args[1]) : null;
      if (target && target !== p) {
        const mode = /^(c|creative|1|创造)$/i.test(args[0]) ? 'creative' : /^(s|survival|0|生存)$/i.test(args[0]) ? 'survival' : null;
        if (!mode) return say(session, '§c未知的游戏模式', '#FF5555');
        target.setGameMode(mode);
        say(session, `已将 ${target.name} 的游戏模式设置为${mode === 'creative' ? '创造模式' : '生存模式'}`);
        return;
      }
      break;
    }
    case 'me': {
      const text2 = args.join(' ').replace(/§/g, '').slice(0, CHAT_MAX);
      if (!text2) return say(session, '用法：/me <动作>');
      server.chat(`* ${p.name} ${text2}`);
      return;
    }
    case 'say': {
      const text2 = args.join(' ').replace(/§/g, '').slice(0, CHAT_MAX);
      if (!text2) return say(session, '用法：/say <消息>');
      server.chat(`§d[${p.name}] ${text2}`);
      return;
    }
    case 'help':
      server.runCommand(session, text);
      say(session, '§7联机命令：/list 在线玩家 · /me 动作 · /login <口令> 管理员登录');
      if (op) say(session, '§7管理员：/op /deop /kick /ban /unban <玩家> · /forget <名字> · /save · /status · /tp <玩家> [玩家]');
      return;
    default:
  }
  server.runCommand(session, text);
}
