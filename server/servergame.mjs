// The dedicated server's simulation host: one persistent world shared by every connected player.
// It is the "game" facade the shared modules expect (src/game/*.js read game.world, game.entities,
// game.players, game.audio, game.particles, game.settings, game.timeOfDay ...), runs the 20 TPS loop
// (world ticks with liquids / random ticks, furnaces, entities, mobs, natural spawning), and replicates the
// results to the sessions (server/session.mjs):
//   blocks    every block change of a chunk a client subscribed to, batched per tick ('b')
//   entities  10 Hz snapshots of the entities near each player ('e' updates, 'ed' removals)
//   players   10 Hz positions of the other players ('pu'), joins / leaves ('pj' / 'pl')
//   effects   sounds and particles the simulation plays, to the players in earshot ('fx')
//   time      every second ('tm')
// The world is saved (chunks, entities, chests / furnaces, player records, server data) every minute and
// on shutdown, through the regular Storage API on a disk backend (server/filestorage.mjs).
import { World } from '../src/world/world.js';
import { EntityManager } from '../src/game/entities.js';
import { MobSpawner, spawnMob, MOB_TYPES } from '../src/game/mobs.js';
import { BlockEntityManager, containerType } from '../src/game/blockentities.js';
import { runCommand, COMMAND_LIST } from '../src/game/commands.js';
import { DAY_TICKS, TICKS_PER_SECOND, computeDaylight } from '../src/config.js';
import { BLOCKS, BLOCK, IS_SOLID, IS_OPAQUE, IS_LIQUID, getDrops } from '../src/world/registry.js';
import { rleEncode } from '../src/world/storage.js';
import { WorldGenerator } from '../src/world/worldgen.js';
import { chunkKeyNum, ChunkState } from '../src/world/chunk.js';
import { encodeChunkFrame, packStack, q2, qa, SNAPSHOT_HZ } from '../src/net/protocol.js';

const TICK_MS = 1000 / TICKS_PER_SECOND;
const SNAPSHOT_EVERY = Math.round(TICKS_PER_SECOND / SNAPSHOT_HZ);
const AUTOSAVE_TICKS = 60 * TICKS_PER_SECOND;
const VIEWER_EVERY = 5;                 // ticks between viewer (chunk streaming centre) updates
const PARK_EVERY = TICKS_PER_SECOND;    // ticks between parking passes
const ENTITY_RANGE = 96;                // entities are replicated within this horizontal distance
const PLAYER_RANGE = 256;               // other players are replicated within this distance
const PARTICLE_RANGE = 48;
const NEW_WORLD_TIME = 1000;
const DIFFICULTIES = ['peaceful', 'easy', 'normal', 'hard'];

/** Particle calls forwarded to clients (the others are high-rate trails clients draw for themselves). */
const FORWARDED_PARTICLES = new Set([
  'spawnBlockBreak', 'spawnPoof', 'spawnSmoke', 'spawnExplosion', 'spawnSplash', 'spawnItemBreak', 'spawnCrit',
]);

const r2 = q2;

export class ServerGame {
  /**
   * @param {object} opts
   * @param {import('../src/world/storage.js').Storage} opts.storage
   * @param {import('../src/world/workerpool.js').WorkerPool} opts.pool
   * @param {object} opts.config server config (see server/main.mjs)
   * @param {(level: string, ...args: any[]) => void} [opts.log]
   */
  constructor({ storage, pool, config, log }) {
    this.storage = storage;
    this.pool = pool;
    this.config = config;
    this.log = log ?? ((level, ...a) => (level === 'error' ? console.error : console.log)(`[server]`, ...a));

    // ---- game facade (shared modules) ----
    this.world = null;
    this.entities = null;
    this.blockEntities = null;
    this.spawner = null;
    this.worldMeta = null;
    this.settings = { difficulty: 'normal' };
    /** Connected players (RemotePlayer); the shared modules iterate this list. */
    this.players = [];
    this.player = null;              // there is no "local" player on the server
    this.perspective = 0;
    this.interaction = null;
    this.ui = null;
    this.time = NEW_WORLD_TIME;
    this.audio = {
      play: (name, opts) => this._audio(name, opts),
      playBlock: (kind, sound, x, y, z) => this._fx(['b', kind, sound, r2(x), r2(y), r2(z)], x, y, z, 16),
    };
    this.particles = new Proxy({}, {
      get: (_, method) => (FORWARDED_PARTICLES.has(method) ? (...args) => this._particles(method, args) : undefined),
    });

    // ---- server state ----
    /** @type {Set<import('./session.mjs').Session>} */
    this.sessions = new Set();
    this._nextPlayerId = 1;
    this._parked = new Map();        // 'cx,cz' -> entity records of unloaded chunks
    this._fxQueue = [];              // [msgArray, x, y, z, range] per effect of this tick
    this._voiceId = 1;
    this._ticks = 0;
    this._timer = null;
    this._lastTick = 0;
    this._saving = null;
    this._rng = Math.random;
    this._pendingEdits = [];         // edits waiting for their chunk { session, x, y, z, id, breakTool, until }
    this._counts = null;             // entityCounts() cache
    this._countsTick = -1;
    /** Open container screens: 'x,y,z' -> { be, viewers: Set<Session>, state: string } */
    this.containers = new Map();
    this.stats = { ticks: 0, slowTicks: 0, maxTickMs: 0, lastTickMs: 0 };
  }

  // =================================================================================================
  // Facade
  // =================================================================================================

  get timeOfDay() {
    const t = this.time % DAY_TICKS;
    return (t < 0 ? t + DAY_TICKS : t) / DAY_TICKS;
  }

  get daylight() {
    return computeDaylight(this.timeOfDay);
  }

  setTime(ticks) {
    const t = Math.floor(Number(ticks));
    if (!Number.isFinite(t)) return;
    this.time = Math.max(0, t);
    this.broadcast({ t: 'tm', t: this.time });
  }

  setDifficulty(d) {
    if (!DIFFICULTIES.includes(d) || d === this.settings.difficulty) return;
    this.settings.difficulty = d;
    this.broadcast({ t: 'df', d });
  }

  /** The shared commands call this to change the difficulty. */
  applySettings(partial) {
    if (partial && typeof partial.difficulty === 'string') this.setDifficulty(partial.difficulty);
  }

  spawnItem(stack, x, y, z, vx, vy, vz, pickupDelay) {
    return this.entities ? this.entities.spawnItem(stack, x, y, z, vx, vy, vz, pickupDelay) : null;
  }

  spawnMob(type, x, y, z, opts) {
    if (!this.entities || !this.world) return null;
    return spawnMob(this, type, x, y, z, opts);
  }

  emit() {}

  addChatMessage(text) {
    this.log('info', `[chat] ${text}`);
  }

  // =================================================================================================
  // Lifecycle
  // =================================================================================================

  /** Load (or create) the world and start the tick loop. */
  async start() {
    const id = this.config.worldId;
    let meta = await this.storage.loadWorldMeta(id);
    if (!meta) {
      const seed = this.config.seed ?? (Math.random() * 4294967296) >>> 0;
      const gen = new WorldGenerator(seed >>> 0, this.config.worldType);
      const sp = gen.findSpawn();
      meta = {
        id, name: this.config.worldName ?? 'WebCraft 公共世界', seed: seed >>> 0, seedText: String(seed >>> 0),
        worldType: this.config.worldType === 'flat' ? 'flat' : 'default', mode: 'survival',
        created: Date.now(), lastPlayed: Date.now(), time: NEW_WORLD_TIME,
        spawn: { x: Math.floor(sp.x) + 0.5, y: sp.y, z: Math.floor(sp.z) + 0.5 },
        difficulty: 'normal', players: {}, ops: [...(this.config.ops ?? [])], bans: {}, entities: [], blockEntities: [],
      };
      await this.storage.saveWorldMeta(meta);
      this.log('info', `created world '${id}' (seed ${meta.seed})`);
    }
    meta.players ??= {};
    meta.ops ??= [];
    meta.bans ??= {};
    for (const op of this.config.ops ?? []) if (!meta.ops.includes(op)) meta.ops.push(op);
    this.worldMeta = meta;
    this.time = Number.isFinite(meta.time) ? meta.time : NEW_WORLD_TIME;
    this.settings.difficulty = DIFFICULTIES.includes(meta.difficulty) ? meta.difficulty : 'normal';

    const world = new World({
      seed: meta.seed >>> 0,
      worldType: meta.worldType,
      worldId: id,
      storage: this.storage,
      pool: this.pool,
      renderer: null,
      renderDistance: this.config.simDistance,
      tickRadius: this.config.simDistance,
      lightOnly: true,
      uploadBudgetMs: 1000,
      onDropItem: (itemId, count, x, y, z) => this.entities?.popItem(itemId, count, x, y, z),
      onFallingBlock: (blockId, x, y, z) => !!this.entities?.spawnFallingBlock(blockId, x + 0.5, y, z + 0.5),
      onBlockPopped: (blockId, x, y, z) => this._blockBreakEffects(blockId, x, y, z),
      onEffect: (name, x, y, z) => {
        if (name === 'fizz') {
          this._audio('fizz', { x, y, z, volume: 0.5, pitch: 1 + (Math.random() - Math.random()) * 0.2 });
          this._particles('spawnSmoke', [x, y + 0.7, z, 8]);
        }
      },
    });
    this.world = world;
    this.entities = new EntityManager(this);
    this.blockEntities = new BlockEntityManager(this).attach(world);
    if (Array.isArray(meta.blockEntities)) this.blockEntities.deserialize(meta.blockEntities);
    this.spawner = new MobSpawner(this);
    world.onChunkGenerated((cx, cz) => this.spawner?.onChunkGenerated(cx, cz));
    world.onBlockChanged((x, y, z, oldId, newId) => this._onBlockChanged(x, y, z, oldId, newId));
    await world.init();
    // Saved entities wait (parked) until their chunk is loaded again.
    for (const rec of Array.isArray(meta.entities) ? meta.entities : []) {
      if (!rec || !Number.isFinite(rec.x) || !Number.isFinite(rec.z)) continue;
      this._park(rec);
    }
    world.setViewers([]);
    this._lastTick = performance.now();
    this._timer = setInterval(() => this._loop(), TICK_MS / 2);
    this.log('info', `world '${id}' ready (seed ${meta.seed}, spawn ${meta.spawn.x} ${meta.spawn.y} ${meta.spawn.z})`);
  }

  /** Stop the loop and save everything. */
  async stop() {
    clearInterval(this._timer);
    this._timer = null;
    for (const s of [...this.sessions]) s.close(1001, '服务器正在重启');
    await this.save();
  }

  _loop() {
    const now = performance.now();
    let n = 0;
    while (now - this._lastTick >= TICK_MS && n < 5) {
      this._lastTick += TICK_MS;
      n++;
      const t0 = performance.now();
      try {
        this.tick(TICK_MS / 1000);
      } catch (err) {
        this.log('error', 'tick failed:', err);
      }
      const ms = performance.now() - t0;
      this.stats.lastTickMs = ms;
      if (ms > this.stats.maxTickMs) this.stats.maxTickMs = ms;
      if (ms > TICK_MS) this.stats.slowTicks++;
    }
    if (now - this._lastTick > 1000) this._lastTick = now;   // fell far behind: skip, do not replay
  }

  // =================================================================================================
  // Tick
  // =================================================================================================

  tick(dt) {
    this._ticks++;
    this.stats.ticks++;
    const world = this.world;
    const active = this.players.length > 0;
    if (this._ticks % VIEWER_EVERY === 0) this._updateViewers();
    world.update(NaN, NaN, NaN, dt);
    if (active) {
      this.time++;
      world.tick(this._rng, this.timeOfDay);
      this.blockEntities.tick(dt);
      this.entities.update(dt);
      this.spawner.update(dt);
      if (this._pendingEdits.length > 0) this._retryPendingEdits();
    }
    if (this._ticks % PARK_EVERY === 0) this._updateParking();
    for (const p of this.players) p.flush();
    this._flushEffects();
    for (const s of this.sessions) s.flushBlocks();
    if (this._ticks % SNAPSHOT_EVERY === 0) {
      for (const s of this.sessions) {
        if (s.player) {
          s.sendEntitySnapshot(this.entities);
          s.sendPlayerSnapshot(this.players);
        }
      }
    }
    if (this._ticks % 5 === 0) this._updateContainers();
    if (this._ticks % TICKS_PER_SECOND === 0) this.broadcast({ t: 'tm', t: this.time });
    if (this._ticks % AUTOSAVE_TICKS === 0) this.save().catch((err) => this.log('error', 'autosave failed:', err));
  }

  _updateViewers() {
    const rd = this.config.simDistance;
    const list = [];
    for (const p of this.players) list.push({ x: p.x, z: p.z, rd });
    this.world.setViewers(list);
  }

  // =================================================================================================
  // Players
  // =================================================================================================

  allocPlayerId() {
    return this._nextPlayerId++;
  }

  addPlayer(session) {
    const p = session.player;
    this.players.push(p);
    this.sessions.add(session);
    this._updateViewers();
    this.broadcast({ t: 'pj', id: p.id, n: p.name }, session);
  }

  removePlayer(session) {
    const p = session.player;
    this.sessions.delete(session);
    if (!p) return;
    const i = this.players.indexOf(p);
    if (i >= 0) this.players.splice(i, 1);
    // Mobs forget a player that left.
    for (const e of this.entities?.list ?? []) {
      if (e.target === p) e.target = null;
      if (e.lastAttacker === p) e.lastAttacker = null;
      if (e.collector === p) e.collector = null;
    }
    for (const c of this.containers.values()) c.viewers.delete(session);
    this.broadcast({ t: 'pl', id: p.id });
    this._updateViewers();
  }

  findPlayer(name) {
    const n = String(name).toLowerCase();
    return this.players.find((p) => p.name.toLowerCase() === n) ?? null;
  }

  isOp(name) {
    return this.worldMeta.ops.includes(name);
  }

  /** Send a message to every session with a player (except `except`). */
  broadcast(msg, except = null) {
    const text = JSON.stringify(msg);
    for (const s of this.sessions) if (s !== except && s.player) s.sendRaw(text);
  }

  /** Chat line to everyone (and the server log). */
  chat(text) {
    this.log('info', `[chat] ${text.replace(/§./g, '')}`);
    this.broadcast({ t: 'chat', m: text });
  }

  // =================================================================================================
  // Blocks
  // =================================================================================================

  _onBlockChanged(x, y, z, oldId, newId) {
    if (this.sessions.size === 0) return;
    const key = chunkKeyNum(x >> 4, z >> 4);
    for (const s of this.sessions) if (s.subs.has(key)) s.queueBlock(x, y, z, newId);
  }

  /** Current contents of chunk (cx, cz) for a subscribing client: a frame (pristine or RLE data). */
  async chunkFrame(cx, cz, seq) {
    const world = this.world;
    const live = () => {
      const c = world.getChunk(cx, cz);
      if (!c || c.state !== ChunkState.READY || !c.blocks) return null;
      return encodeChunkFrame(cx, cz, seq, !c.fromStorage && c.editCount === 0 ? null : rleEncode(c.blocks));
    };
    const now = live();
    if (now) return now;
    // Not loaded here: unchanged since the last save (only loaded chunks change).
    const pending = world._unloadSaves.get(cx + ',' + cz);
    if (pending) return encodeChunkFrame(cx, cz, seq, rleEncode(pending.blocks));
    const keys = world._savedKeys;
    if (keys && !keys.has(cx + ',' + cz)) return encodeChunkFrame(cx, cz, seq, null);
    const blocks = await this.storage.loadChunk(this.worldMeta.id, cx, cz).catch(() => null);
    // The chunk may have been loaded (and edited) while we were reading: use the live copy then.
    return live() ?? encodeChunkFrame(cx, cz, seq, blocks ? rleEncode(blocks) : null);
  }

  /** Block id at (x, y, z), or -1 when the chunk is not loaded on the server. */
  blockAt(x, y, z) {
    const c = this.world.getChunk(x >> 4, z >> 4);
    if (!c || c.state !== ChunkState.READY || !c.blocks) return -1;
    return this.world.getBlock(x, y, z);
  }

  /**
   * Apply a client edit now or once its chunk is loaded (up to 5 s later). `breakTool` (item id, 0 = hand)
   * marks a survival break: the server pops the drops of the block that is really there, so a block two
   * players break at once, or an edit the server refuses, drops nothing extra.
   */
  applyEdit(session, x, y, z, id, breakTool) {
    if (this.blockAt(x, y, z) < 0) {
      this._pendingEdits.push({ session, x, y, z, id, breakTool, until: this._ticks + 5 * TICKS_PER_SECOND });
      return;
    }
    this._doEdit(session, x, y, z, id, breakTool);
  }

  _doEdit(session, x, y, z, id, breakTool) {
    const world = this.world;
    const before = world.getBlock(x, y, z);
    if (before === id) return;
    if (!world.setBlock(x, y, z, id)) {
      session.queueBlock(x, y, z, world.getBlock(x, y, z));
      return;
    }
    const p = session.player;
    if (breakTool !== undefined && before !== BLOCK.AIR && !IS_LIQUID[before] && p.mode !== 'creative') {
      for (const d of getDrops(before, breakTool, Math.random)) {
        this.entities.popItem(d.id, d.count, x + 0.5, y + 0.5, z + 0.5);
      }
    }
    // Flint and steel (or fire) on TNT: the client asks for the primed TNT right after this edit.
    if (before === BLOCK.TNT && breakTool === undefined) session.noteTntIgnition(x, y, z);
  }

  _retryPendingEdits() {
    const keep = [];
    for (const e of this._pendingEdits) {
      if (!this.sessions.has(e.session)) continue;
      if (this.blockAt(e.x, e.y, e.z) >= 0) this._doEdit(e.session, e.x, e.y, e.z, e.id, e.breakTool);
      else if (this._ticks < e.until) keep.push(e);
    }
    this._pendingEdits = keep;
  }

  _blockBreakEffects(id, x, y, z) {
    const def = BLOCKS[id];
    if (!def || id === BLOCK.AIR) return;
    this._particles('spawnBlockBreak', [x, y, z, id]);
    this.audio.playBlock('break', def.sound, x + 0.5, y + 0.5, z + 0.5);
  }

  // =================================================================================================
  // Effects
  // =================================================================================================

  _audio(name, opts = {}) {
    const x = opts?.x, y = opts?.y, z = opts?.z;
    const positioned = Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z);
    const vol = Number.isFinite(opts?.volume) ? opts.volume : 1;
    const voice = this._voiceId++;
    const msg = ['a', name, positioned ? r2(x) : null, positioned ? r2(y) : null, positioned ? r2(z) : null,
      Math.round(vol * 100) / 100, Math.round((Number.isFinite(opts?.pitch) ? opts.pitch : 1) * 1000) / 1000, voice];
    this._fx(msg, x, y, z, positioned ? 16 * Math.max(1, vol) + 4 : Infinity);
    return {
      stop: () => this._fx(['s', voice], x, y, z, positioned ? 16 * Math.max(1, vol) + 8 : Infinity),
    };
  }

  _particles(method, args) {
    const a = args.map((v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v));
    this._fx(['p', method, ...a], args[0], args[1], args[2], PARTICLE_RANGE);
  }

  _fx(msg, x, y, z, range) {
    if (this.sessions.size === 0) return;
    this._fxQueue.push(msg, x, y, z, range);
  }

  _flushEffects() {
    const q = this._fxQueue;
    if (q.length === 0) return;
    for (const s of this.sessions) {
      const p = s.player;
      if (!p || !s.ready) continue;
      let list = null;
      for (let i = 0; i < q.length; i += 5) {
        const range = q[i + 4];
        if (range !== Infinity) {
          const dx = q[i + 1] - p.x, dy = q[i + 2] - p.y, dz = q[i + 3] - p.z;
          if (!(dx * dx + dy * dy + dz * dz <= range * range)) continue;
        }
        (list ??= []).push(q[i]);
      }
      if (list) s.send({ t: 'fx', l: list });
    }
    q.length = 0;
  }

  // =================================================================================================
  // Entities
  // =================================================================================================

  /**
   * Live entities by type ('item', 'mob', 'arrow', 'tnt', ...), counted once per tick; callers that add an
   * entity bump the count themselves.
   */
  entityCounts() {
    if (this._countsTick !== this._ticks) {
      const c = this._counts = Object.create(null);
      for (const e of this.entities.list) if (!e.removed) c[e.type] = (c[e.type] ?? 0) + 1;
      this._countsTick = this._ticks;
    }
    return this._counts;
  }

  /** Mobs within `radius` blocks (horizontal) of (x, z). */
  mobsNear(x, z, radius) {
    const r2 = radius * radius;
    let n = 0;
    for (const e of this.entities.list) {
      if (e.type !== 'mob' || e.removed) continue;
      const dx = e.x - x, dz = e.z - z;
      if (dx * dx + dz * dz <= r2) n++;
    }
    return n;
  }

  /** Entity by network id (= entity id), or null. */
  entityById(id) {
    for (const e of this.entities.list) if (e.id === id && !e.removed) return e;
    return null;
  }

  _park(rec) {
    const key = (Math.floor(rec.x) >> 4) + ',' + (Math.floor(rec.z) >> 4);
    let recs = this._parked.get(key);
    if (!recs) this._parked.set(key, (recs = []));
    recs.push(rec);
  }

  /** Game._updateParking: entities live with their chunks (see src/game.js). */
  _updateParking() {
    const world = this.world;
    const ents = this.entities;
    if (this._parked.size > 0) {
      let restore = null;
      for (const [key, recs] of this._parked) {
        const i = key.indexOf(',');
        if (!world.isChunkMeshed(Number(key.slice(0, i)), Number(key.slice(i + 1)))) continue;
        this._parked.delete(key);
        (restore ??= []).push(...recs);
      }
      if (restore) {
        try {
          ents.deserialize(restore);
        } catch (err) {
          this.log('error', 'restoring parked entities failed:', err);
        }
      }
    }
    for (const e of ents.list) {
      if (e.removed) continue;
      const cx = Math.floor(e.x) >> 4, cz = Math.floor(e.z) >> 4;
      if (world.isChunkGenerated(cx, cz)) continue;
      let rec = null;
      if (e.type !== 'mob' || e.persistent) {
        try { rec = e.serialize(); } catch { rec = null; }
      }
      e.remove();
      if (rec) this._park(rec);
    }
  }

  // =================================================================================================
  // Containers (chest / furnace screens)
  // =================================================================================================

  /** A player opens the container at (x, y, z): returns the block entity or null (not a container / blocked). */
  openContainer(session, x, y, z) {
    const id = this.blockAt(x, y, z);
    if (id < 0) return null;
    const type = containerType(id);
    if (!type) return null;
    if (type === 'chest') {
      const above = this.world.getBlock(x, y + 1, z);
      if (IS_SOLID[above] && IS_OPAQUE[above]) return null;
    }
    const be = this.blockEntities.getOrCreate(x, y, z, type);
    if (!be) return null;
    const key = `${x},${y},${z}`;
    let c = this.containers.get(key);
    if (!c || c.be !== be) this.containers.set(key, (c = { be, viewers: new Set(), state: '' }));
    c.viewers.add(session);
    return be;
  }

  closeContainer(session, x, y, z) {
    const key = `${x},${y},${z}`;
    const c = this.containers.get(key);
    if (!c) return;
    c.viewers.delete(session);
    if (c.viewers.size === 0) this.containers.delete(key);
  }

  /** Push changed container contents (furnace progress, other players' clicks) to their viewers. */
  _updateContainers(force = null) {
    for (const [key, c] of this.containers) {
      if (c.be.removed) {
        for (const s of c.viewers) s.send({ t: 'cx', x: c.be.x, y: c.be.y, z: c.be.z });
        this.containers.delete(key);
        continue;
      }
      const state = JSON.stringify(c.be.serialize());
      if (state === c.state && force !== c) continue;
      c.state = state;
      for (const s of c.viewers) s.send({ t: 'ct', be: c.be.serialize() });
    }
  }

  // =================================================================================================
  // Commands
  // =================================================================================================

  /** Run a chat command for `session` (permission checks in session.mjs). */
  runCommand(session, text) {
    const p = session.player;
    const game = this;
    const ctx = {
      player: p,
      players: this.players,
      world: this.world,
      entities: this.entities,
      blockEntities: this.blockEntities,
      settings: this.settings,
      worldMeta: this.worldMeta,
      interaction: null,
      playerName: p.name,
      get time() { return game.time; },
      set time(v) { game.setTime(v); },
      setTime: (t) => this.setTime(t),
      setGameMode: (mode) => p.setGameMode(mode),
      applySettings: (s) => this.applySettings(s),
      spawnItem: (...a) => this.spawnItem(...a),
      spawnMob: (...a) => this.spawnMob(...a),
      dropFromPlayer: (stack) => this.entities.dropFromPlayer(stack, p),
      addChatMessage: (t, color) => session.send({ t: 'chat', m: t, c: color }),
      emit: () => {},
    };
    const before = p.inventory.serialize();
    const done = () => {
      // /clear and friends change the mirror directly: give the client the result.
      const after = p.inventory.serialize();
      if (JSON.stringify(after) !== JSON.stringify(before)) session.send({ t: 'invset', sl: p.inventory.slots.map(packStack) });
      p.flush();
    };
    const r = runCommand(ctx, text);
    if (r && typeof r.then === 'function') r.then(done, done);
    else done();
  }

  // =================================================================================================
  // Saving
  // =================================================================================================

  save() {
    if (this._saving) return this._saving.then(() => this.save());
    const meta = this.worldMeta;
    if (!meta || !this.world) return Promise.resolve();
    meta.lastPlayed = Date.now();
    meta.time = this.time;
    meta.difficulty = this.settings.difficulty;
    const list = this.entities.serialize();
    for (const recs of this._parked.values()) for (const r of recs) list.push(r);
    meta.entities = list;
    meta.blockEntities = this.blockEntities.serialize();
    for (const s of this.sessions) s.storePlayerRecord();
    const p = this.world.saveSnapshot(meta).then(() => {
      this._saving = null;
    }, (err) => {
      this._saving = null;
      throw err;
    });
    this._saving = p;
    return p;
  }

  /** Status for /list and the log. */
  status() {
    return {
      players: this.players.map((p) => p.name),
      entities: this.entities?.list.length ?? 0,
      chunks: this.world?.stats().loaded ?? 0,
      time: this.time,
      tps: this.stats,
    };
  }
}

export { MOB_TYPES, COMMAND_LIST, q2, qa };
