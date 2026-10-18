// Multiplayer client (docs/MULTIPLAYER.md). One instance per connection to the dedicated server:
//   * connect()        WebSocket handshake ('hello' with the player name and the name's token) -> 'welcome'
//   * chunkSource      Storage-like object for the World replica: loadChunk() subscribes to a chunk and
//                      resolves with its blocks (or null: the client generates pristine chunks itself);
//                      changes of subscribed chunks arrive as 'b' batches (buffered while a chunk loads)
//   * remoteHooks      World `remote` option: local edits -> 'e', unloaded chunks -> 'unsub'
//   * update(dt)       per frame (Game.update): position (20 Hz), inventory / state / record sync,
//                      the frame's attack, chest / furnace changes, other players, name tags, the
//                      player list (held Tab) with the round-trip time (ping every 5 s)
//   * server messages  entity states, other players, effects, damage / pushes / items for the local
//                      player, chat, time, difficulty, containers
import {
  PROTOCOL_VERSION, WS_PATH, POSITION_HZ, decodeChunkFrame, packStack, unpackStack, sameStack, q2, qa,
} from './protocol.js';
import { rleDecode } from '../world/storage.js';
import { CHUNK_VOLUME } from '../config.js';
import { chunkKeyNum } from '../world/chunk.js';
import { createBlockEntity, FurnaceBlockEntity, blockEntityFromJSON } from '../game/blockentities.js';
import { RemotePlayers, PF } from './replica.js';

const TOKEN_KEY = 'webcraft-mp-tokens';
const NAME_KEY = 'webcraft-mp-name';
const SAVE_EVERY = 10;          // s between full player records
const INV_EVERY = 0.25;         // s between inventory mirror updates (when changed)
const PING_EVERY = 5;           // s between latency probes

/** The page of the public server (other copies of the game, e.g. GitHub Pages, have no server). */
export const PUBLIC_SERVER_PAGE = 'https://gservice.site/webcraft/';

/** Default server URL: wss://<host><page dir>ws (https) / ws:// (http). */
export function defaultServerUrl() {
  const loc = globalThis.location;
  if (!loc) return `ws://127.0.0.1:8787/webcraft/${WS_PATH}`;
  const dir = loc.pathname.replace(/[^/]*$/, '');
  return `${loc.protocol === 'https:' ? 'wss:' : 'ws:'}//${loc.host}${dir}${WS_PATH}`;
}

/** Status endpoint next to the WebSocket (online count for the title screen). */
export function statusUrl() {
  const loc = globalThis.location;
  if (!loc) return null;
  return `${loc.pathname.replace(/[^/]*$/, '')}status`;
}

export function loadSavedName() {
  try {
    return localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
}

function loadTokens() {
  try {
    return JSON.parse(localStorage.getItem(TOKEN_KEY) ?? '{}') ?? {};
  } catch {
    return {};
  }
}

function saveToken(name, token) {
  try {
    const t = loadTokens();
    t[name.toLowerCase()] = token;
    localStorage.setItem(TOKEN_KEY, JSON.stringify(t));
    localStorage.setItem(NAME_KEY, name);
  } catch { /* storage blocked: the name works for this session only */ }
}

export class MultiplayerClient {
  /**
   * @param {object} game   the Game
   * @param {{ url?: string, name: string, renderDistance?: number }} opts
   */
  constructor(game, { url = defaultServerUrl(), name, renderDistance = 8 }) {
    this.game = game;
    this.url = url;
    this.name = name;
    this.renderDistance = renderDistance;
    this.ws = null;
    this.welcome = null;
    this.playerId = 0;
    this.op = false;
    this.closed = false;
    this.closeReason = '';
    /** Called once when the connection ends while playing: (reason) => void. */
    this.onDisconnect = null;
    this.players = new RemotePlayers();
    /** Chunk loads waiting for the server: 'cx,cz' -> { seq, resolve } */
    this._pending = new Map();
    this._seq = 1;
    this._subQueue = [];
    this._unsubQueue = [];
    this._subscribed = new Set();          // chunkKeyNum of subscribed chunks
    this._buffered = new Map();            // chunkKeyNum -> [x, y, z, id, ...] waiting for the chunk
    this._posTimer = 0;
    this._lastPos = '';
    this._invTimer = 0;
    this._invVersion = -1;
    this._invSlot = -1;
    this._saveTimer = SAVE_EVERY;
    this._state = '';
    this._swingSeen = 0;
    this._container = null;                // { be, slots: packed[], version }
    this._tags = new Map();                // ghost id -> name tag element
    this._tagLayer = null;
    this._listEl = null;                   // player list overlay (held Tab)
    this._listShown = false;
    this._listTimer = 0;
    this._pingTimer = 0;
    /** Last measured round-trip time (ms), or null. */
    this.rtt = null;
    this._applyingRemote = false;

    const self = this;
    this.chunkSource = {
      persistent: false,
      getChunkKeys: async () => null,
      loadChunk: (worldId, cx, cz) => self._requestChunk(cx, cz),
      saveChunks: async () => {},
      saveSnapshot: async () => {},
      saveWorldData: async () => {},
      loadWorldData: async () => null,
      saveWorldMeta: async () => {},
    };
    this.remoteHooks = {
      // breakTool: survival break with that held item (0 = hand), the server pops the drops.
      onEdit: (x, y, z, id, old, breakTool) => self.send(Number.isInteger(breakTool)
        ? { t: 'e', x, y, z, id, br: breakTool } : { t: 'e', x, y, z, id }),
      onUnload: (cx, cz) => self._unsubscribe(cx, cz),
    };
  }

  // =================================================================================================
  // Connection
  // =================================================================================================

  /** Open the connection; resolves with the 'welcome' message, rejects with a readable Error. */
  connect() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (msg) => {
        if (settled) return;
        settled = true;
        reject(new Error(msg));
      };
      let ws;
      try {
        ws = new WebSocket(this.url);
      } catch (err) {
        fail(`无法连接服务器：${err?.message ?? err}`);
        return;
      }
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      const timer = setTimeout(() => {
        fail('连接服务器超时');
        try { ws.close(); } catch { /* ignore */ }
      }, 15000);
      ws.onopen = () => {
        const token = loadTokens()[this.name.toLowerCase()];
        ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, name: this.name, token, rd: this.renderDistance }));
      };
      ws.onmessage = (e) => {
        if (typeof e.data !== 'string') {
          this._onBinary(e.data);
          return;
        }
        let m;
        try {
          m = JSON.parse(e.data);
        } catch {
          return;
        }
        if (!settled) {
          if (m.t === 'welcome') {
            settled = true;
            clearTimeout(timer);
            this.welcome = m;
            this.playerId = m.id;
            this.name = m.name;
            this.op = !!m.op;
            saveToken(m.name, m.token);
            for (const p of m.players ?? []) this.players.join(p.id, p.n);
            // Closing the tab: send the latest record (position, inventory) while the socket still works.
            this._onPageHide = () => this._sendRecord();
            globalThis.addEventListener?.('pagehide', this._onPageHide);
            this._onKey = (ev) => this._onTabKey(ev);
            globalThis.addEventListener?.('keydown', this._onKey, true);
            globalThis.addEventListener?.('keyup', this._onKey, true);
            resolve(m);
          } else if (m.t === 'deny') {
            clearTimeout(timer);
            this.closeReason = m.r;
            fail(m.r || '服务器拒绝了连接');
          }
          return;
        }
        this._onMessage(m);
      };
      ws.onclose = (e) => {
        clearTimeout(timer);
        const wasOpen = settled;
        fail(this.closeReason || `无法连接服务器（${e.code}）`);
        this._onClosed(wasOpen ? (this.closeReason || closeText(e.code)) : null);
      };
      ws.onerror = () => {};
    });
  }

  send(msg) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(msg));
  }

  /** Leave the server (the last player record is sent first). */
  disconnect() {
    if (this.closed) return;
    this._sendRecord();
    this.closed = true;
    try { this.ws?.close(1000, 'bye'); } catch { /* ignore */ }
    this._cleanup();
  }

  _onClosed(reason) {
    if (this.closed) return;
    this.closed = true;
    this._cleanup();
    if (reason !== null && typeof this.onDisconnect === 'function') this.onDisconnect(reason);
  }

  _cleanup() {
    for (const p of this._pending.values()) p.resolve(null);
    this._pending.clear();
    this._buffered.clear();
    this.players.clear();
    this._removeTags();
    if (this._onPageHide) globalThis.removeEventListener?.('pagehide', this._onPageHide);
    this._onPageHide = null;
    if (this._onKey) {
      globalThis.removeEventListener?.('keydown', this._onKey, true);
      globalThis.removeEventListener?.('keyup', this._onKey, true);
    }
    this._onKey = null;
    this._listEl?.remove();
    this._listEl = null;
  }

  // =================================================================================================
  // Chunks
  // =================================================================================================

  _requestChunk(cx, cz) {
    if (this.closed) return Promise.resolve(null);
    const key = cx + ',' + cz;
    const seq = this._seq++;
    const prev = this._pending.get(key);
    if (prev) prev.resolve(null);
    this._subscribed.add(chunkKeyNum(cx, cz));
    this._subQueue.push(cx, cz, seq);
    return new Promise((resolve) => this._pending.set(key, { seq, resolve }));
  }

  _unsubscribe(cx, cz) {
    const k = chunkKeyNum(cx, cz);
    if (!this._subscribed.delete(k)) return;
    this._buffered.delete(k);
    const key = cx + ',' + cz;
    const p = this._pending.get(key);
    if (p) {
      this._pending.delete(key);
      p.resolve(null);
    }
    this._unsubQueue.push(cx, cz);
  }

  _onBinary(buf) {
    const f = decodeChunkFrame(buf);
    if (!f) return;
    const key = f.cx + ',' + f.cz;
    const p = this._pending.get(key);
    if (!p || (f.seq !== undefined && f.seq !== p.seq)) return;    // superseded subscription
    this._pending.delete(key);
    let blocks = null;
    if (f.rle) {
      try {
        blocks = rleDecode(f.rle, CHUNK_VOLUME);
      } catch (err) {
        console.warn('[mp] bad chunk data', key, err);
      }
    }
    p.resolve(blocks);
  }

  /** Block changes from the server: applied now, or once their chunk has loaded. */
  _applyBlocks(l) {
    const world = this.game.world;
    if (!world || !Array.isArray(l)) return;
    for (let i = 0; i + 3 < l.length; i += 4) {
      const x = l[i], y = l[i + 1], z = l[i + 2], id = l[i + 3];
      const cx = x >> 4, cz = z >> 4;
      const k = chunkKeyNum(cx, cz);
      if (!this._subscribed.has(k)) continue;
      const c = world.getChunk(cx, cz);
      if (c && c.state === 3 && c.blocks) {
        world.setBlock(x, y, z, id, { remote: true });
      } else {
        let b = this._buffered.get(k);
        if (!b) this._buffered.set(k, (b = []));
        b.push(x, y, z, id);
      }
    }
  }

  _flushBuffered() {
    if (this._buffered.size === 0) return;
    const world = this.game.world;
    for (const [k, list] of this._buffered) {
      const x0 = list[0], z0 = list[2];
      const c = world.getChunk(x0 >> 4, z0 >> 4);
      if (!c) {
        this._buffered.delete(k);
        continue;
      }
      if (c.state !== 3 || !c.blocks) continue;
      this._buffered.delete(k);
      for (let i = 0; i < list.length; i += 4) world.setBlock(list[i], list[i + 1], list[i + 2], list[i + 3], { remote: true });
    }
  }

  // =================================================================================================
  // Per frame
  // =================================================================================================

  update(dt) {
    if (this.closed) return;
    const game = this.game;
    if (this._subQueue.length > 0) {
      this.send({ t: 'sub', c: this._subQueue });
      this._subQueue = [];
    }
    if (this._unsubQueue.length > 0) {
      this.send({ t: 'unsub', c: this._unsubQueue });
      this._unsubQueue = [];
    }
    this._flushBuffered();
    game.entities?.flushAttack?.();
    const rd = game.settings?.renderDistance;
    if (Number.isInteger(rd) && rd !== this.renderDistance) {
      this.renderDistance = rd;           // entity / player replication range on the server
      this.send({ t: 'rd', rd });
    }
    const player = game.player;
    if (player && game.state === 'playing') {
      this._sendPosition(dt, player);
      this._syncInventory(dt, player);
      this._syncState(player);
      this._saveTimer -= dt;
      if (this._saveTimer <= 0) {
        this._saveTimer = SAVE_EVERY;
        this._sendRecord();
      }
      this._syncContainer();
    }
    this._pingTimer -= dt;
    if (this._pingTimer <= 0) {
      this._pingTimer = PING_EVERY;
      this.send({ t: 'ping', n: Math.round(performance.now()) });
    }
    this.players.update(dt, game.world);
    this._updateTags();
    if (this._listShown) {
      if (game.state !== 'playing' || game.ui?.screen) this._listShown = false;
      this._listTimer -= dt;
      if (!this._listShown || this._listTimer <= 0) this._renderList();
    }
  }

  _sendPosition(dt, player) {
    this._posTimer -= dt;
    if (this._posTimer > 0) return;
    this._posTimer = 1 / POSITION_HZ;
    const hand = this.game.interaction?.getHandState?.();
    let f = 0;
    if (player.sneaking) f |= PF.SNEAK;
    if (player.sprinting) f |= PF.SPRINT;
    if (player.flying) f |= PF.FLY;
    if (player.onGround) f |= PF.GROUND;
    if (player.dead) f |= PF.DEAD;
    if (hand && hand.swing > 0) f |= PF.SWING;
    if (player.usingItem === 'bow') f |= PF.BOW;
    if (player.usingItem === 'eat' || player.usingItem === 'food') f |= PF.EAT;
    if (player.fireTime > 0) f |= PF.FIRE;
    if (player.inWater) f |= PF.WATER;
    const msg = {
      t: 'p', x: q2(player.x), y: q2(player.y), z: q2(player.z), yw: qa(player.yaw), pt: qa(player.pitch),
      v: [q2(player.vx), q2(player.vy), q2(player.vz)], f, s: player.selectedSlot,
    };
    const key = `${msg.x},${msg.y},${msg.z},${msg.yw},${msg.pt},${f},${msg.s}`;
    if (key === this._lastPos && !(f & PF.SWING)) return;
    this._lastPos = key;
    this.send(msg);
  }

  _syncInventory(dt, player) {
    this._invTimer -= dt;
    const inv = player.inventory;
    if (this._invTimer > 0 || (inv.version === this._invVersion && player.selectedSlot === this._invSlot)) return;
    this._invTimer = INV_EVERY;
    this._invVersion = inv.version;
    this._invSlot = player.selectedSlot;
    this.send({ t: 'inv', sl: inv.slots.map(packStack), s: player.selectedSlot });
  }

  _syncState(player) {
    const s = `${player.mode},${player.dead},${Math.round(player.health)}`;
    if (s === this._state) return;
    this._state = s;
    this.send({ t: 'st', mode: player.mode, dead: player.dead, hp: player.health });
  }

  _sendRecord() {
    const p = this.game.player;
    if (!p || this.closed) return;
    try {
      this.send({ t: 'save', rec: p.serialize() });
    } catch (err) {
      console.warn('[mp] could not send the player record', err);
    }
  }

  // =================================================================================================
  // Incoming
  // =================================================================================================

  playerById(id) {
    if (id === this.playerId) return this.game.player;
    return this.players.get(id);
  }

  _onMessage(m) {
    const h = HANDLERS[m.t];
    if (!h) return;
    try {
      h.call(this, m);
    } catch (err) {
      console.warn(`[mp] handling '${m.t}' failed:`, err);
    }
  }

  // =================================================================================================
  // Containers
  // =================================================================================================

  /** Right click on a chest / furnace: ask the server (the screen opens with its reply). */
  openContainer(x, y, z) {
    this.send({ t: 'co', x, y, z });
  }

  _containerState(o, open) {
    const game = this.game;
    let c = this._container;
    if (!c || c.be.x !== o.x || c.be.y !== o.y || c.be.z !== o.z || c.be.type !== o.type) {
      if (!open) return;
      const be = createBlockEntity(o.type, o.x, o.y, o.z);
      if (!be) return;
      c = this._container = { be, slots: [], version: -1 };
    }
    const be = c.be;
    const fresh = blockEntityFromJSON(o);
    if (!fresh) return;
    for (let i = 0; i < be.size; i++) be.slots[i] = fresh.slots[i];
    if (be instanceof FurnaceBlockEntity) {
      be.burnTicks = fresh.burnTicks;
      be.burnTotalTicks = fresh.burnTotalTicks;
      be.cookTicks = fresh.cookTicks;
      be.cookTotalTicks = fresh.cookTotalTicks;
    }
    be.version++;
    c.slots = be.slots.map(packStack);
    c.version = be.version;
    if (open) {
      if (be.type === 'furnace') game.ui?.openFurnace?.(be);
      else game.ui?.openChest?.(be);
    }
  }

  /** Local clicks in the open container screen -> slot changes for the server; closing -> 'cc'. */
  _syncContainer() {
    const c = this._container;
    if (!c) return;
    const be = c.be;
    const screen = this.game.ui?.screen;
    if (be.removed || !screen || screen.blockEntity !== be) {
      this.send({ t: 'cc', x: be.x, y: be.y, z: be.z });
      be.removed = true;
      this._container = null;
      return;
    }
    if (be.version === c.version) return;
    const changes = [];
    for (let i = 0; i < be.size; i++) {
      const now = packStack(be.get(i));
      const before = c.slots[i];
      if (!sameStack(unpackStack(now), unpackStack(before))) changes.push([i, before, now]);
    }
    c.version = be.version;
    c.slots = be.slots.map(packStack);
    if (changes.length > 0) this.send({ t: 'cs', x: be.x, y: be.y, z: be.z, ch: changes });
  }

  // =================================================================================================
  // Name tags
  // =================================================================================================

  _updateTags() {
    const game = this.game;
    const cam = game.frame?.camera;
    const canvas = game.canvas;
    if (!cam || !canvas || game.state !== 'playing' || game.ui?.hudHidden) {
      for (const el of this._tags.values()) el.style.display = 'none';
      return;
    }
    if (!this._tagLayer) {
      const root = document.getElementById('ui-root') ?? document.body;
      this._tagLayer = document.createElement('div');
      this._tagLayer.className = 'mp-tags';
      root.prepend(this._tagLayer);
    }
    const w = canvas.clientWidth || window.innerWidth, h = canvas.clientHeight || window.innerHeight;
    const fov = (cam.fov ?? 70) * Math.PI / 180;
    const f = 1 / Math.tan(fov / 2);
    const aspect = w / h;
    const sy = Math.sin(cam.yaw), cyw = Math.cos(cam.yaw), sp = Math.sin(cam.pitch), cp = Math.cos(cam.pitch);
    // camera basis (yaw 0 looks toward -z, see SPEC §4): forward, right, up
    const fx = -sy * cp, fy = sp, fz = -cyw * cp;
    const rx = cyw, rz = -sy;
    const ux = sy * sp, uy = cp, uz = cyw * sp;
    const seen = new Set();
    for (const g of this.players.map.values()) {
      if (!g.visible || !g.track || g.dead) continue;
      seen.add(g.id);
      let el = this._tags.get(g.id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'mp-tag';
        el.textContent = g.name;
        this._tagLayer.appendChild(el);
        this._tags.set(g.id, el);
      }
      if (el.textContent !== g.name) el.textContent = g.name;
      const dx = g.x - cam.x, dy = g.y + (g.sneaking ? 1.75 : 2.05) - cam.y, dz = g.z - cam.z;
      const depth = dx * fx + dy * fy + dz * fz;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (depth < 0.1 || dist > 64) {
        el.style.display = 'none';
        continue;
      }
      const px = (dx * rx + dz * rz) / depth * f / aspect;
      const py = (dx * ux + dy * uy + dz * uz) / depth * f;
      if (Math.abs(px) > 1.2 || Math.abs(py) > 1.2) {
        el.style.display = 'none';
        continue;
      }
      el.style.display = '';
      el.style.transform = `translate(${((px + 1) / 2 * w).toFixed(1)}px, ${((1 - py) / 2 * h).toFixed(1)}px) translate(-50%, -100%)`;
      el.style.opacity = g.sneaking ? '0.45' : '1';
    }
    for (const [id, el] of this._tags) {
      if (!seen.has(id)) {
        el.remove();
        this._tags.delete(id);
      }
    }
  }

  // =================================================================================================
  // Player list (held Tab)
  // =================================================================================================

  _onTabKey(e) {
    if (e.code !== 'Tab') return;
    const game = this.game;
    // Open screens (chat: Tab completes commands) keep the key.
    const show = e.type === 'keydown' && game.state === 'playing' && !game.ui?.screen;
    if (!show && !this._listShown) return;
    e.preventDefault();
    if (show === this._listShown) return;
    this._listShown = show;
    this._renderList();
  }

  _renderList() {
    this._listTimer = 0.5;
    if (!this._listShown) {
      if (this._listEl) this._listEl.style.display = 'none';
      return;
    }
    if (!this._listEl) {
      const root = document.getElementById('ui-root') ?? document.body;
      this._listEl = document.createElement('div');
      this._listEl.className = 'mp-list';
      root.appendChild(this._listEl);
    }
    const names = [...this.players.map.values()].map((g) => g.name).sort((a, b) => a.localeCompare(b));
    names.unshift(this.name);
    const el = this._listEl;
    el.replaceChildren();
    const add = (cls, text) => {
      const d = document.createElement('div');
      d.className = cls;
      d.textContent = text;
      el.appendChild(d);
      return d;
    };
    add('mp-list-title', `${this.welcome?.world?.name ?? '多人游戏'} · ${names.length} 人在线`);
    const grid = add('mp-list-grid', '');
    for (const n of names) {
      const row = document.createElement('div');
      row.className = n === this.name ? 'mp-list-name mp-list-me' : 'mp-list-name';
      row.textContent = n;
      grid.appendChild(row);
    }
    add('mp-list-foot', this.rtt === null ? '延迟测量中…' : `延迟 ${this.rtt} ms`);
    el.style.display = '';
  }

  _removeTags() {
    for (const el of this._tags.values()) el.remove();
    this._tags.clear();
    this._tagLayer?.remove();
    this._tagLayer = null;
  }
}

function closeText(code) {
  if (code === 1006) return '与服务器的连接意外断开了';
  if (code === 1001) return '服务器正在重启，请稍后再进入';
  if (code === 1008) return '网络太慢，服务器断开了连接';
  return `与服务器的连接已断开（${code}）`;
}

// =====================================================================================================
// Server message handlers (this = MultiplayerClient)
// =====================================================================================================

const HANDLERS = {
  b(m) { this._applyBlocks(m.l); },
  e(m) { if (Array.isArray(m.l)) this.game.entities?.applyStates?.(m.l); },
  ed(m) { if (Array.isArray(m.l)) this.game.entities?.removeIds?.(m.l); },
  pj(m) {
    this.players.join(m.id, m.n);
  },
  pl(m) { this.players.leave(m.id); },
  pu(m) { if (Array.isArray(m.l)) this.players.apply(m.l); },
  ph(m) { if (Array.isArray(m.l)) this.players.hide(m.l); },
  tm(m) {
    const g = this.game;
    if (!Number.isFinite(m.t)) return;
    // Small drifts are corrected softly (no visible jump of the sun).
    if (Math.abs(m.t - g.time) > 40) g.setTime(m.t, { local: true });
    else g.time = m.t;
  },
  df(m) {
    this.game.remoteDifficulty = m.d;
    this.game.addChatMessage(`§7难度已设置为${({ peaceful: '和平', easy: '简单', normal: '普通', hard: '困难' })[m.d] ?? m.d}`);
  },
  fx(m) {
    const g = this.game;
    for (const e of m.l ?? []) {
      if (!Array.isArray(e)) continue;
      try {
        if (e[0] === 'a') {
          const [, name, x, y, z, volume, pitch, voice] = e;
          const opts = x === null ? { volume, pitch } : { x, y, z, volume, pitch };
          const v = g.audio?.play?.(name, opts);
          if (voice && v && typeof v.stop === 'function') (this._voices ??= new Map()).set(voice, v);
          if (this._voices && this._voices.size > 64) this._voices.delete(this._voices.keys().next().value);
        } else if (e[0] === 'b') {
          g.audio?.playBlock?.(e[1], e[2], e[3], e[4], e[5]);
        } else if (e[0] === 'p') {
          const fn = g.particles?.[e[1]];
          if (typeof fn === 'function') fn.apply(g.particles, e.slice(2));
        } else if (e[0] === 's') {
          const v = this._voices?.get(e[1]);
          if (v) {
            this._voices.delete(e[1]);
            try { v.stop(0.1); } catch { /* gone */ }
          }
        }
      } catch { /* a bad effect never breaks the game */ }
    }
  },
  hurt(m) {
    const p = this.game.player;
    if (!p) return;
    const by = m.by;
    let attacker = null;
    if (by) {
      attacker = { x: by.x, z: by.z };
      if (by.k === 'mob') { attacker.type = 'mob'; attacker.mobType = by.mt; }
      if (by.k === 'player') { attacker.isPlayer = true; attacker.name = by.n; attacker.type = 'player'; }
      if (by.arrow) attacker = { type: 'arrow', shooter: attacker, x: by.x, z: by.z };
    }
    p.damage(m.a, m.c, m.m, attacker);
  },
  kb(m) { this.game.player?.knockback(m.dx, m.dz, m.s); },
  kill(m) { this.game.player?.kill(m.m); },
  vel(m) {
    const p = this.game.player;
    if (!p || !Array.isArray(m.v) || p.dead || p.mode === 'creative') return;
    p.vx += m.v[0]; p.vy += m.v[1]; p.vz += m.v[2];
  },
  give(m) {
    const p = this.game.player;
    const s = unpackStack(m.s);
    if (!p || !s) return;
    const left = p.inventory.add(s);
    if (left > 0 && p.mode !== 'creative') this.game.entities?.dropFromPlayer?.({ id: s.id, count: left, damage: s.damage }, p);
  },
  invset(m) {
    const p = this.game.player;
    if (!p || !Array.isArray(m.sl)) return;
    for (let i = 0; i < p.inventory.size; i++) p.inventory.slots[i] = unpackStack(m.sl[i]);
    p.inventory.changed();
  },
  tp(m) {
    const p = this.game.player;
    if (!p || !Number.isFinite(m.x)) return;
    p.setPosition(m.x, m.y, m.z);
    p.vx = 0; p.vy = 0; p.vz = 0;
    if (Number.isFinite(m.yaw)) p.yaw = m.yaw;
    if (Number.isFinite(m.pitch)) p.pitch = m.pitch;
  },
  mode(m) { this.game.setGameMode(m.m, { remote: true }); },
  spawnpoint(m) {
    const p = this.game.player;
    if (p && m.p && Number.isFinite(m.p.x)) p.spawnPoint = { ...m.p };
  },
  chat(m) { this.game.addChatMessage(m.m, m.c); },
  ct(m) { if (m.be) this._containerState(m.be, !!m.open); },
  cx(m) {
    const c = this._container;
    if (c && c.be.x === m.x && c.be.y === m.y && c.be.z === m.z) c.be.removed = true;
  },
  op(m) {
    this.op = !!m.op;
  },
  deny(m) {
    this.closeReason = m.r || '你已断开连接';
  },
  pong(m) {
    if (Number.isFinite(m.n)) this.rtt = Math.max(0, Math.round(performance.now() - m.n));
  },
};
