// Game (docs/SPEC.md §9.10): the central object every module talks to. Owns the state machine
// (title / loading / playing), the world lifecycle (create / start / save / quit), the frame loop
// (player → interaction → 20 TPS ticks → entities / particles → world streaming → render → UI),
// settings, chat / commands, the F-keys and the debug / automation API used by headless tests.
//
// Frame order (SPEC §9.10, SPEC-wave2 §8):
//   dt = min(0.1, frame delta)
//   playing && !paused: player.update → interaction.update → fixed 20 TPS ticks (time, world.tick with
//                       liquids / random ticks, block entities = furnaces) → entities.update (mobs,
//                       arrows, items) → mob spawner → particles.update
//   world.update (always while a world exists: chunk streaming / uploads also run behind menus)
//   render (playing only; title / loading screens are opaque) → ui.update → input.endFrame
//
// Spawning a new world: findSpawn() (dry land near the origin) → wait until the spawn area (radius 2
// chunks) is generated + meshed → pick the safest standing spot around that column (solid, non-leaf,
// non-liquid ground with two free cells above) → enter. window.__ready becomes true once a frame of
// the ready world has been rendered.
//
// Saving (persistent worlds): every 30 s of play, when the game is paused (Minecraft's "Saving and
// pausing game..."), on quit, and when the tab is hidden / closed. The world meta and the chunk writes
// are started in the same task, so a page that is going away still gets its IndexedDB transactions
// created; while there is unsaved progress a beforeunload confirmation guards against Ctrl+W (Ctrl is
// the sprint key) and accidental tab closes. Failed saves are reported to the player (chat line + the
// 'saveFailed' event); "save and quit" keeps the world open when saving fails. A world can be open in
// only one tab at a time (WorldLocks, like Minecraft's session.lock).

import {
  DEFAULT_SETTINGS, SETTINGS_STORAGE_KEY, DAY_TICKS, TICKS_PER_SECOND, computeDaylight, skyLightLevelAt,
} from './config.js';
import {
  BLOCKS, BLOCK, ITEM, IS_SOLID, IS_OPAQUE, IS_LIQUID, DEFAULT_CREATIVE_HOTBAR, itemId, getItem,
} from './world/registry.js';
import { World } from './world/world.js';
import { Storage, newWorldId } from './world/storage.js';
import { parseSeed } from './world/worldgen.js';
import { Player } from './game/player.js';
import { Interaction } from './game/interaction.js';
import { EntityManager } from './game/entities.js';
import { ParticleSystem } from './game/particles.js';
import { MobSpawner, spawnMob, MOB_TYPES } from './game/mobs.js';
import { BlockEntityManager } from './game/blockentities.js';
import { makeStack } from './game/inventory.js';
import { runCommand, resolveItem, resolveBlock } from './game/commands.js';

const DEG = Math.PI / 180;
const MAX_PITCH = 89.9 * DEG;
const MAX_FRAME_DT = 0.1;
const MAX_TICKS_PER_FRAME = 10;
const AUTOSAVE_SECONDS = 30;
const SPAWN_RADIUS = 2;                 // chunks around the player meshed before entering a world
const NEW_WORLD_TIME = 1000;            // SPEC §10: new worlds start in the morning
const SAFE_SPAWN_SEARCH = 12;           // blocks around the spawn column searched for a dry standing spot
const LOADING_UPLOAD_BUDGET_MS = 12;    // GPU upload budget per frame behind the loading screen
const PLAYING_UPLOAD_BUDGET_MS = 4;     // ... and while playing (SPEC §11)
const SAVE_ERROR_CHAT_MS = 60000;       // the same save error is repeated in chat at most once a minute
const SAVE_RETRY_SECONDS = 5;           // after a failed save the next autosave comes this much sooner
const PARK_INTERVAL = 1;                // s between passes that park / restore entities of unloaded chunks
const VERSION = '1.1';

/** Named times accepted by the `time=` URL parameter (same values as /time set). */
const TIME_NAMES = Object.freeze({
  sunrise: 0, day: 1000, morning: 1000, noon: 6000, sunset: 12000, dusk: 12500, night: 13000,
  midnight: 18000, dawn: 23000,
});

/** Chinese + English compass names by quadrant of the internal yaw (0 = north, +90° = west). */
const FACING = [
  ['北', 'north', 'Z 负方向', 'Towards negative Z'],
  ['西', 'west', 'X 负方向', 'Towards negative X'],
  ['南', 'south', 'Z 正方向', 'Towards positive Z'],
  ['东', 'east', 'X 正方向', 'Towards positive X'],
];
const FACE_NAMES = ['东 east', '西 west', '上 up', '下 down', '南 south', '北 north'];
const MODE_NAMES = { survival: '生存 survival', creative: '创造 creative' };

// Ground a player may be spawned on: solid and opaque, not leaves, not harmful (sand / gravel are fine:
// generated terrain never leaves them hanging).
const SAFE_GROUND = new Uint8Array(256);
for (const b of BLOCKS) {
  if (!b) continue;
  SAFE_GROUND[b.id] = IS_SOLID[b.id] && IS_OPAQUE[b.id] && !IS_LIQUID[b.id] && !(b.damage > 0) &&
    !b.name.endsWith('_leaves') ? 1 : 0;
}

const DIFFICULTIES = Object.freeze(['peaceful', 'easy', 'normal', 'hard']);
const DIFFICULTY_NAMES = Object.freeze({ peaceful: '和平', easy: '简单', normal: '普通', hard: '困难' });

/**
 * Validate a (partial) settings object against DEFAULT_SETTINGS: unknown keys are dropped, numbers are
 * clamped to the ranges of the options screen, booleans coerced, `difficulty` must be one of
 * peaceful / easy / normal / hard. Settings added to DEFAULT_SETTINGS later keep working: numbers must
 * be finite, strings short.
 * @param {object} partial
 * @returns {object} only the valid keys of `partial`
 */
export function sanitizeSettings(partial) {
  const out = {};
  if (!partial || typeof partial !== 'object') return out;
  const num = (v, lo, hi, int = false) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return undefined;
    const c = Math.min(hi, Math.max(lo, n));
    return int ? Math.round(c) : c;
  };
  for (const [key, value] of Object.entries(partial)) {
    if (!(key in DEFAULT_SETTINGS)) continue;
    let v;
    switch (key) {
      case 'renderDistance': v = num(value, 2, 32, true); break;
      case 'fov': v = num(value, 30, 110, true); break;
      case 'mouseSensitivity': v = num(value, 0.05, 4); break;
      case 'soundVolume':
      case 'musicVolume': v = num(value, 0, 1); break;
      case 'guiScale': v = num(value, 0, 8, true); break;
      case 'brightness': v = num(value, 0, 1); break;
      case 'difficulty': v = DIFFICULTIES.includes(value) ? value : undefined; break;
      default:
        switch (typeof DEFAULT_SETTINGS[key]) {
          case 'boolean': v = !!value; break;
          case 'number': v = num(value, -Infinity, Infinity); break;
          case 'string': v = typeof value === 'string' && value.length <= 64 ? value : undefined; break;
          default: v = undefined;
        }
    }
    if (v !== undefined) out[key] = v;
  }
  return out;
}

/** Load settings from localStorage (merged over DEFAULT_SETTINGS). Never throws. */
export function loadSettings() {
  const s = { ...DEFAULT_SETTINGS };
  try {
    const raw = globalThis.localStorage?.getItem(SETTINGS_STORAGE_KEY);
    if (raw) Object.assign(s, sanitizeSettings(JSON.parse(raw)));
  } catch (err) {
    console.warn('[game] could not read saved settings, using defaults:', err);
  }
  return s;
}

/** Parse a `time=` value: ticks, or a name (noon, night, ...). Returns NaN if invalid. */
export function parseTimeParam(text) {
  if (text === null || text === undefined || text === '') return NaN;
  const named = TIME_NAMES[String(text).toLowerCase()];
  if (named !== undefined) return named;
  const n = Number(text);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : NaN;
}

/** Short Chinese reason of a failed save (IndexedDB / storage errors), for chat lines and messages. */
export function describeSaveError(err) {
  const name = err?.name ?? '';
  if (name === 'QuotaExceededError') return '存储空间不足';
  if (name === 'InvalidStateError' || name === 'UnknownError' || name === 'AbortError') return '浏览器存储出错';
  if (name === 'NotAllowedError' || name === 'SecurityError') return '浏览器不允许本页面保存数据';
  const msg = String(err?.message ?? err ?? '');
  return msg ? `存储出错（${msg.length > 40 ? msg.slice(0, 40) + '…' : msg}）` : '存储出错';
}

const WORLD_LOCK_PREFIX = 'webcraft-world-';     // same lock name as Storage.acquireWorldLock
const WORLD_LOCK_CHANNEL = 'webcraft-worlds';
const WORLD_LOCK_QUERY_MS = 250;

/**
 * Per-world session lock (Minecraft's session.lock): a world can be open in only one tab / window, so a
 * forgotten tab can never overwrite newer progress with its stale state when it is closed.
 * Uses the Web Locks API (the lock is held until release() or until the tab goes away). Where it is
 * unavailable (insecure origin such as a LAN address, old browser) the other tabs are asked over a
 * BroadcastChannel instead; without either, worlds are simply not locked.
 */
export class WorldLocks {
  /**
   * @param {{ locks?: LockManager|null, channel?: BroadcastChannel|null }} [env] injectable for tests;
   *   defaults: navigator.locks, and a BroadcastChannel fallback in browsers without it
   */
  constructor({ locks = globalThis.navigator?.locks ?? null, channel } = {}) {
    this.locks = locks && typeof locks.request === 'function' ? locks : null;
    /** @type {Map<string, () => void>} world id -> release */
    this._held = new Map();
    this._pending = new Map();       // query nonce -> resolve(busy)
    this._channel = null;
    if (this.locks) return;
    let ch = channel;
    if (ch === undefined && typeof window !== 'undefined' && typeof BroadcastChannel === 'function') {
      try {
        ch = new BroadcastChannel(WORLD_LOCK_CHANNEL);
      } catch {
        ch = null;
      }
    }
    if (!ch) return;
    this._channel = ch;
    ch.onmessage = (e) => {
      const m = e.data;
      if (!m || typeof m !== 'object') return;
      if (m.type === 'query' && this._held.has(m.id)) ch.postMessage({ type: 'busy', id: m.id, nonce: m.nonce });
      else if (m.type === 'busy') this._pending.get(m.nonce)?.(true);
    };
  }

  /** Is world `id` locked by this game instance? */
  holds(id) {
    return this._held.has(id);
  }

  /**
   * Take the lock of world `id`. Resolves true when this instance holds it, false when another tab has
   * the world open. Never rejects (a broken lock API opens the world unlocked, with a warning).
   */
  async acquire(id) {
    if (this._held.has(id)) return true;
    if (this.locks) {
      try {
        return await new Promise((resolve, reject) => {
          this.locks.request(WORLD_LOCK_PREFIX + id, { ifAvailable: true }, (lock) => {
            if (!lock) {
              resolve(false);
              return undefined;
            }
            // Returning a pending promise keeps the lock until release() resolves it.
            return new Promise((release) => {
              this._held.set(id, release);
              resolve(true);
            });
          }).catch(reject);
        });
      } catch (err) {
        console.warn('[game] world lock unavailable, opening the world without it:', err);
        return true;
      }
    }
    if (this._channel) {
      const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      const busy = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), WORLD_LOCK_QUERY_MS);
        this._pending.set(nonce, (v) => {
          clearTimeout(timer);
          resolve(v);
        });
        try {
          this._channel.postMessage({ type: 'query', id, nonce });
        } catch {
          clearTimeout(timer);
          resolve(false);
        }
      });
      this._pending.delete(nonce);
      if (busy) return false;
    }
    this._held.set(id, () => {});
    return true;
  }

  /** Release the lock of world `id` (no-op if not held). */
  release(id) {
    const release = this._held.get(id);
    if (!release) return;
    this._held.delete(id);
    release();
  }
}

const fmt = (v, digits) => (Number.isFinite(v) ? v.toFixed(digits) : '?');
const wrapDeg = (d) => {
  let a = ((d + 180) % 360 + 360) % 360 - 180;
  if (a === -180) a = 180;
  return a;
};

export class Game {
  /**
   * @param {object} deps
   * @param {HTMLCanvasElement} deps.canvas
   * @param {import('./render/renderer.js').Renderer} deps.renderer
   * @param {import('./game/input.js').Input} deps.input
   * @param {import('./game/audio.js').AudioEngine|null} deps.audio
   * @param {Promise<import('./world/storage.js').Storage>|import('./world/storage.js').Storage} deps.storage
   * @param {import('./world/workerpool.js').WorkerPool} deps.pool
   * @param {object} deps.icons IconFactory
   * @param {object} deps.textures generateTextures() result (UI backgrounds, entity renderer)
   * @param {object} deps.settings live settings object (mutated in place by applySettings)
   * @param {object} [deps.options] { automation, persistSettings = true, music = true, sessionOverrides,
   *   worldLocks (a WorldLocks; default: a new one over navigator.locks) }
   */
  constructor({ canvas, renderer, input, audio = null, storage, pool, icons, textures, settings, options = {} }) {
    this.canvas = canvas;
    this.renderer = renderer;
    this.input = input;
    this.audio = audio;
    this.pool = pool;
    this.icons = icons;
    this.textures = textures;
    /** Live settings object (one instance for the whole session; Input / Audio / UI read it live). */
    this.settings = settings;
    this.options = { automation: false, persistSettings: true, music: true, ...options };
    /** Settings overridden for this session only (URL parameters): key -> value to persist instead. */
    this._sessionOverrides = { ...(options.sessionOverrides ?? {}) };
    /** @type {import('./ui/ui.js').UIManager|null} set by main.js right after construction */
    this.ui = null;

    /**
     * Set once storage is open. `storage.persistent === false` means IndexedDB is unusable (blocked
     * site data, private mode...) and worlds only live in memory for this session.
     * @type {import('./world/storage.js').Storage|null}
     */
    this.storage = null;
    this._storageReady = Promise.resolve(storage).then((s) => s ?? Storage.memory(), (err) => {
      console.warn('[game] storage unavailable, worlds will not be saved in this session:', err);
      return Storage.memory();
    }).then((s) => {
      this.storage = s;
      return s;
    });

    // ---- world state (null outside a world) ----
    this.world = null;
    this.player = null;
    this.interaction = null;
    this.entities = null;
    this.particles = null;
    /** Natural mob spawning (mobs.js MobSpawner) of the open world. */
    this.spawner = null;
    /** Chests and furnaces of the open world (blockentities.js). */
    this.blockEntities = null;
    /** Saved records of entities whose chunk is unloaded, by chunk key 'cx,cz' (see _updateParking). */
    this._parked = new Map();
    this._parkTimer = 0;
    this.worldMeta = null;
    /** 'title' | 'loading' | 'playing' */
    this.state = 'title';
    this.paused = false;
    /** World time in ticks (20 per second). */
    this.time = 0;
    this.fps = 0;
    this.playerName = '玩家';
    /** 0 = first person; 1/2 = third person (only when a player model exists). */
    this.perspective = 0;

    this._listeners = new Map();
    this._tickAcc = 0;
    this._animTime = 0;
    this._autosaveTimer = 0;
    this._saveChain = Promise.resolve();
    this._savesRunning = 0;             // saves started and not settled yet
    this._dirty = false;                // unpaused play since the last save started (beforeunload guard)
    this._saveErrorShown = 0;           // performance.now() of the last save error posted in chat
    this._saveErrorText = '';
    this._saveFailedSince = false;      // a save failed and no save succeeded since (chat reports recovery)
    this._quitting = null;
    this._starting = false;             // startWorld before _loading exists (lock / quit of the old world)
    this._loading = null;               // { resolve, reject, meta, isNew, started }
    this._temporary = false;            // current world is not persisted (autostart without save=1)
    this._worldLocks = options.worldLocks ?? new WorldLocks();
    this._lockedWorldId = null;         // id of the world whose lock this game holds
    this._unloadGuard = false;          // beforeunload listener registered
    this._readySignalled = false;
    this._waiters = [];                 // debug.waitIdle / nextFrame resolvers
    this._lastFrameTime = 0;
    this._fpsFrames = 0;
    this._fpsTime = 0;
    this._rng = Math.random;
    this._cam = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0, fov: 70 };
    this._loggedErrors = new Set();
    this._screenshotPending = false;
    this._pendingTp = null;
    this._perf = { frames: 0, totalMs: 0, maxMs: 0, over33: 0, over50: 0, updateMs: 0, renderMs: 0, long: [], since: 0 };

    /** FrameState handed to the renderer every frame (SPEC §9.3), reused. */
    this.frame = {
      camera: this._cam, timeOfDay: 0.25, daylight: 1, time: 0, renderDistance: 8,
      underwater: false, inLava: false, clouds: true, voidFogScale: 1 / 32, brightness: 0.5,
      selection: null, breaking: null, entities: [], particles: null, hand: null,
    };

    this.debug = this._createDebugApi();
    // Like Minecraft, the death message ("玩家被僵尸杀死了") is also posted in chat.
    this.on('playerDied', (msg) => {
      if (typeof msg === 'string' && msg) this.addChatMessage(msg);
    });
    this._frameCallback = (t) => this._frame(t);
    // Registered only while a persistent world is open (see _setUnloadGuard): Ctrl+W / Ctrl+R / closing
    // the tab ask for confirmation instead of silently dropping unsaved progress (Ctrl is the sprint
    // key, and browsers do not let pages cancel Ctrl+W otherwise). The save starts immediately, so it
    // has finished by the time the player confirms. Automation runs (autostart / automation=1) only
    // save: a dialog would block scripted reloads.
    this._onBeforeUnload = (e) => {
      if (!this.hasUnsavedProgress()) return;
      this._saveForUnload();
      if (this.options.automation) return;
      e.preventDefault();
      e.returnValue = '';
    };
    this._attachDomListeners();
    if (this.audio) this.audio.setVolumes(settings.soundVolume, settings.musicVolume);
  }

  // =================================================================================================
  // Events
  // =================================================================================================

  /** Subscribe to a game event (settingsChanged, worldLoaded, worldUnloaded, chat, ...). */
  on(evt, fn) {
    if (typeof fn !== 'function') return () => {};
    let list = this._listeners.get(evt);
    if (!list) this._listeners.set(evt, (list = []));
    list.push(fn);
    return () => this.off(evt, fn);
  }

  off(evt, fn) {
    const list = this._listeners.get(evt);
    if (!list) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }

  emit(evt, ...args) {
    const list = this._listeners.get(evt);
    if (!list || list.length === 0) return;
    for (const fn of list.slice()) {
      try {
        fn(...args);
      } catch (err) {
        this._logOnce(`event:${evt}`, `[game] '${evt}' listener failed:`, err);
      }
    }
  }

  // =================================================================================================
  // Time
  // =================================================================================================

  /** 0 = sunrise, 0.25 = noon, 0.5 = sunset, 0.75 = midnight (interpolated between ticks). */
  get timeOfDay() {
    const t = (this.time + this._tickAcc) % DAY_TICKS;
    return (t < 0 ? t + DAY_TICKS : t) / DAY_TICKS;
  }

  /** Sky light multiplier 0.2 (night) .. 1 (day). */
  get daylight() {
    return computeDaylight(this.timeOfDay);
  }

  /** Set the world time in ticks (absolute, like /time set). */
  setTime(ticks) {
    const t = Math.floor(Number(ticks));
    if (!Number.isFinite(t)) return;
    this.time = Math.max(0, t);
    this._tickAcc = 0;
    if (this.worldMeta) this.worldMeta.time = this.time;
  }

  // =================================================================================================
  // Loop
  // =================================================================================================

  /** Start the requestAnimationFrame loop (main.js calls this once). */
  start() {
    if (this._running) return;
    this._running = true;
    // Background music plays everywhere (title screen too); it begins after the first user gesture.
    if (this.options.music && this.audio) this.audio.startMusic();
    this._lastFrameTime = performance.now();
    requestAnimationFrame(this._frameCallback);
  }

  _frame(now) {
    requestAnimationFrame(this._frameCallback);
    const raw = Math.max(0, (now - this._lastFrameTime) / 1000);
    this._lastFrameTime = now;
    const dt = Math.min(MAX_FRAME_DT, raw);
    this._countFps(raw);
    try {
      const t0 = performance.now();
      this.update(dt);
      const t1 = performance.now();
      this.render();
      this._perf.updateMs += t1 - t0;
      this._perf.renderMs += performance.now() - t1;
    } catch (err) {
      this._logOnce('frame', '[game] frame failed:', err);
    }
    try {
      this.ui?.update(dt);
    } catch (err) {
      this._logOnce('ui', '[game] ui.update failed:', err);
    }
    if (this.audio) {
      // Music scheduling and voice cleanup run on every screen (title music too).
      if (this.state !== 'playing' || !this.player) this.audio.setUnderwater(false);
      this.audio.update(dt);
    }
    this.input?.endFrame();
    if (this._waiters.length > 0) this._checkWaiters();
  }

  _countFps(raw) {
    this._fpsFrames++;
    this._fpsTime += raw;
    if (this._fpsTime >= 0.5) {
      this.fps = this._fpsFrames / this._fpsTime;
      this._fpsFrames = 0;
      this._fpsTime = 0;
    }
    // Frame-time statistics for debug.perf() (interval between frames, ms).
    const ms = raw * 1000;
    const pf = this._perf;
    pf.frames++;
    pf.totalMs += ms;
    if (ms > pf.maxMs) pf.maxMs = ms;
    if (ms > 33.4) pf.over33++;
    if (ms > 50) {
      pf.over50++;
      if (pf.long.length < 16) pf.long.push({ atS: +((performance.now() - pf.since) / 1000).toFixed(2), ms: +ms.toFixed(1) });
    }
  }

  /** One frame of simulation (see the header for the order). */
  update(dt) {
    const world = this.world;
    if (!world) return;
    const player = this.player;
    if (this.state === 'loading') {
      world.update(player.x, player.y, player.z, dt);
      this._updateLoading();
      return;
    }
    if (this.state !== 'playing') return;
    const input = this.input;

    this._handleKeys(input);
    if (this._pendingTp) this._updatePendingTeleport();
    if (!this.paused) {
      player.update(dt, input);
      this.interaction.update(dt, input);
      this._tickAcc += dt * TICKS_PER_SECOND;
      let n = 0;
      while (this._tickAcc >= 1 && n < MAX_TICKS_PER_FRAME) {
        this._tickAcc -= 1;
        this.time++;
        n++;
        world.tick(this._rng, this.timeOfDay);
        // Furnaces smelt on the same 20 Hz clock as the world (Minecraft's block entity ticks).
        this.blockEntities?.tick(1 / TICKS_PER_SECOND);
      }
      if (this._tickAcc >= 1) this._tickAcc = 0.999;   // drop ticks we cannot catch up with
      this.entities.update(dt);
      this.spawner?.update(dt);
      this._parkTimer -= dt;
      if (this._parkTimer <= 0) {
        this._parkTimer = PARK_INTERVAL;
        this._updateParking();
      }
      this.particles.update(dt);
      this._animTime += dt;
      this._dirty = true;
      this._autosaveTimer += dt;
      if (this._autosaveTimer >= AUTOSAVE_SECONDS) {
        this._autosaveTimer = 0;
        if (!this._temporary) this.saveWorld().catch((err) => this._reportSaveError(err, 'autosave'));
      }
    }
    world.update(player.x, player.y, player.z, dt);
    this.audio?.setUnderwater(player.eyeInWater);
  }

  /** F-keys routed from Input actions (F1 / F3 / F5); F2 is handled by a DOM listener. */
  _handleKeys(input) {
    if (!input || !this.ui) return;
    if (input.pressed('debug')) this.ui.toggleDebug();
    if (input.pressed('hideHud')) this.ui.toggleHud();
    if (input.pressed('perspective') && this.hasPlayerModel) this.perspective = (this.perspective + 1) % 3;
  }

  /** True when the entity renderer can draw the player (third-person views via F5). */
  get hasPlayerModel() {
    const er = this.renderer?.entityRenderer;
    return !!er && er.supportsPlayerModel === true;
  }

  /** Build the FrameState and render (only while playing: title / loading screens are opaque). */
  render() {
    if (this.state !== 'playing' || !this.world || !this.renderer) return;
    const player = this.player;
    const interaction = this.interaction;
    const f = this.frame;
    const hudHidden = !!this.ui?.hudHidden;
    const cam = player.getCameraState(this._cam, this.perspective);
    f.camera = cam;
    f.timeOfDay = this.timeOfDay;
    f.daylight = computeDaylight(f.timeOfDay);
    f.time = this._animTime;
    f.renderDistance = this.settings.renderDistance;
    f.underwater = player.eyeInWater;
    f.inLava = player.eyeInLava;
    f.clouds = this.settings.clouds !== false;
    f.brightness = this.settings.brightness ?? 0.5;
    // Minecraft darkens the sky near the void: below y = 32, in flat worlds only below y = 1.
    f.voidFogScale = this.world.worldType === 'flat' ? 1 : 1 / 32;
    f.selection = hudHidden || player.dead ? null : interaction.selection;
    f.breaking = interaction.breaking;
    // Manager-owned array, refilled without reallocation; includes the player model in third person (F5).
    f.entities = this.entities.getRenderList();
    f.particles = this.particles.getRenderData();
    f.hand = this.perspective === 0 && !player.dead && !hudHidden ? interaction.getHandState() : null;
    this.audio?.setListener(cam.x, cam.y, cam.z, cam.yaw);
    this.renderer.render(f);
    if (this._screenshotPending) {
      this._screenshotPending = false;
      this._saveScreenshot();
    }
    if (!this._readySignalled) {
      this._readySignalled = true;
      globalThis.__ready = true;
    }
  }

  // =================================================================================================
  // Worlds
  // =================================================================================================

  /** All saved worlds, most recently played first. */
  async listWorlds() {
    const storage = await this._storageReady;
    return storage.listWorlds();
  }

  /**
   * Create a new world meta (and save it unless `temporary`).
   * @param {{ name?: string, seedText?: string, mode?: string, worldType?: string, temporary?: boolean }} opts
   * @returns {Promise<object>} world meta (SPEC §9.6)
   */
  async createWorld({ name = '新的世界', seedText = '', mode = 'survival', worldType = 'default', temporary = false } = {}) {
    const text = String(seedText ?? '').trim();
    const seed = text ? parseSeed(text) : (Math.random() * 4294967296) >>> 0;
    const now = Date.now();
    const meta = {
      id: newWorldId(),
      name: String(name || '新的世界').slice(0, 64),
      seed,
      seedText: text || String(seed),
      worldType: worldType === 'flat' ? 'flat' : 'default',
      mode: mode === 'creative' ? 'creative' : 'survival',
      created: now,
      lastPlayed: now,
      time: NEW_WORLD_TIME,
      spawn: null,
      player: null,
    };
    if (temporary) {
      Object.defineProperty(meta, 'temporary', { value: true, enumerable: false });
    } else {
      const storage = await this._storageReady;
      await storage.saveWorldMeta(meta);
      // Best effort: ask the browser not to evict the site's storage under disk pressure.
      if (storage.persistent && typeof storage.requestPersistence === 'function') storage.requestPersistence().catch(() => {});
    }
    return meta;
  }

  /** Delete a saved world and its chunks (refused while the world is open here or in another tab). */
  async deleteWorld(id) {
    const storage = await this._storageReady;
    if (this.worldMeta?.id === id || this._lockedWorldId === id) throw new Error('无法删除正在游玩的世界');
    if (!(await this._worldLocks.acquire(id))) throw new Error('这个世界正在另一个标签页中运行，无法删除');
    try {
      await storage.deleteWorld(id);
    } finally {
      this._worldLocks.release(id);
    }
  }

  /**
   * Load a world and enter it. Resolves once the spawn area is meshed and state === 'playing'.
   * Rejects when the world is already open in another tab / window (its session lock is taken).
   * @param {object} meta world meta from listWorlds() / createWorld()
   */
  async startWorld(meta) {
    if (!meta || typeof meta !== 'object') throw new TypeError('startWorld needs a world meta');
    if (this._loading || this._starting) throw new Error('另一个世界正在加载中');
    this._starting = true;
    let storage;
    try {
      if (this.world) await this.quitToTitle();
      storage = await this._storageReady;
      if (!meta.temporary) {
        if (!(await this._worldLocks.acquire(meta.id))) {
          throw new Error('这个世界已在另一个标签页中打开。请先在那里保存并退出，然后再进入。');
        }
        this._lockedWorldId = meta.id;
      }
    } finally {
      this._starting = false;
    }
    this.state = 'loading';
    this.paused = false;
    globalThis.__ready = false;
    this._readySignalled = false;
    this.emit('loadingProgress', 0, '正在准备世界…');

    const temporary = !!meta.temporary;
    this._temporary = temporary;
    this.worldMeta = meta;
    this.time = Number.isFinite(meta.time) ? Math.max(0, Math.floor(meta.time)) : NEW_WORLD_TIME;
    this._tickAcc = 0;
    this._animTime = 0;
    this._autosaveTimer = 0;
    this.perspective = 0;

    let world;
    try {
      world = new World({
        seed: meta.seed >>> 0,
        worldType: meta.worldType,
        worldId: meta.id,
        storage: temporary ? null : storage,
        pool: this.pool,
        renderer: this.renderer,
        renderDistance: this.settings.renderDistance,
        smoothLighting: this.settings.smoothLighting,
        // Popped / broken blocks drop like Minecraft's Block.popResource from the block centre.
        onDropItem: (id, count, x, y, z) => this.entities?.popItem(id, count, x, y, z),
        // Sand / gravel fall as entities (Minecraft FallingBlockEntity) instead of teleporting down.
        onFallingBlock: (id, x, y, z) => !!this.entities?.spawnFallingBlock(id, x + 0.5, y, z + 0.5),
        // A block that lost its support (torch, flower, sugar cane, cactus) breaks with its sound and
        // particles, like Minecraft's Level.destroyBlock (level event 2001).
        onBlockPopped: (id, x, y, z) => this._blockBreakEffects(id, x, y, z),
        // Lava meeting water (obsidian / cobblestone / stone) fizzes with smoke (level event 1501).
        onEffect: (name, x, y, z) => this._worldEffect(name, x, y, z),
        // Upload more meshes per frame while the loading screen hides the world (reset when playing).
        uploadBudgetMs: LOADING_UPLOAD_BUDGET_MS,
      });
      this.world = world;
      this.player = new Player(this);
      this.interaction = new Interaction(this);
      this.entities = new EntityManager(this);
      this.particles = new ParticleSystem(this);
      // Chests / furnaces: attach() follows every block change (placing creates the entity, breaking or
      // exploding a container drops its contents). Saved ones wait for their chunks to load.
      this.blockEntities = new BlockEntityManager(this).attach(world);
      if (Array.isArray(meta.blockEntities)) this.blockEntities.deserialize(meta.blockEntities);
      // Natural spawning: animals on first chunk generation (events before this are queued by the
      // world), hostiles in the dark, passive top-ups; mobs themselves persist through entities.
      this.spawner = new MobSpawner(this);
      this._unsubGen = world.onChunkGenerated((cx, cz) => this.spawner?.onChunkGenerated(cx, cz));
      this._unsubBlock = world.onBlockChanged((x, y, z, oldId, newId) => this.emit('blockChanged', x, y, z, oldId, newId));
    } catch (err) {
      await this._abortLoading();
      throw err;
    }

    const player = this.player;
    const isNew = !meta.player;
    try {
      await world.init();
      if (isNew) {
        const sp = world.findSpawn();
        meta.spawn = { x: Math.floor(sp.x) + 0.5, y: sp.y, z: Math.floor(sp.z) + 0.5 };
        player.setGameMode(meta.mode);
        player.spawnPoint = { ...meta.spawn };
        player.respawn({ emit: false });
        player.yaw = 0;
        if (meta.mode === 'creative') this._fillCreativeHotbar();
      } else {
        player.deserialize(meta.player);
        if (!meta.spawn) meta.spawn = { ...player.spawnPoint };
        // A player saved while dead gets the death screen again: the UI opens it for player.dead.
      }
    } catch (err) {
      await this._abortLoading();
      throw err;
    }

    await new Promise((resolve, reject) => {
      this._loading = { resolve, reject, meta, isNew, startedAt: performance.now() };
    });
    return meta;
  }

  /** Called every frame while loading: progress events, then enter the world once the area is ready. */
  _updateLoading() {
    const L = this._loading;
    const world = this.world;
    if (!L || !world) return;
    const player = this.player;
    const pcx = Math.floor(player.x) >> 4, pcz = Math.floor(player.z) >> 4;
    let gen = 0, meshed = 0;
    const R = SPAWN_RADIUS;
    for (let dz = -R - 1; dz <= R + 1; dz++) {
      for (let dx = -R - 1; dx <= R + 1; dx++) {
        if (world.isChunkGenerated(pcx + dx, pcz + dz)) gen++;
        if (Math.abs(dx) <= R && Math.abs(dz) <= R && world.isChunkMeshed(pcx + dx, pcz + dz)) meshed++;
      }
    }
    const genTotal = (2 * R + 3) ** 2, meshTotal = (2 * R + 1) ** 2;
    const fraction = 0.55 * (gen / genTotal) + 0.45 * (meshed / meshTotal);
    const text = gen < genTotal ? `正在生成地形… ${gen}/${genTotal}` : `正在构建区块… ${meshed}/${meshTotal}`;
    if (fraction !== L.lastFraction) {
      L.lastFraction = fraction;
      this.emit('loadingProgress', Math.min(0.99, fraction), text);
    }
    if (!world.isAreaReady(player.x, player.z, SPAWN_RADIUS)) return;

    // Area ready: place the player and enter.
    this._loading = null;
    world.uploadBudgetMs = PLAYING_UPLOAD_BUDGET_MS;
    try {
      if (L.isNew) this._placeAtSafeSpawn();
      else this._ensureNotInsideBlocks();
    } catch (err) {
      this._logOnce('spawn', '[game] spawn placement failed:', err);
    }
    // Saved entities come back once the chunks around them exist (they would fall otherwise): the ones
    // in the meshed spawn area now, every other record is parked until its chunk is loaded and meshed.
    if (!L.isNew && Array.isArray(L.meta.entities)) {
      const now = [];
      for (const rec of L.meta.entities) {
        if (!rec || !Number.isFinite(rec.x) || !Number.isFinite(rec.z)) continue;
        const cx = Math.floor(rec.x) >> 4, cz = Math.floor(rec.z) >> 4;
        if (world.isChunkMeshed(cx, cz)) {
          now.push(rec);
          continue;
        }
        const key = cx + ',' + cz;
        let recs = this._parked.get(key);
        if (!recs) this._parked.set(key, (recs = []));
        recs.push(rec);
      }
      try {
        this.entities.deserialize(now);
      } catch (err) {
        this._logOnce('entities', '[game] restoring entities failed:', err);
      }
    }
    this.state = 'playing';
    this.paused = false;
    this._dirty = false;
    this.emit('loadingProgress', 1, '完成');
    this.emit('worldLoaded', L.meta);
    if (!this._temporary) {
      this._setUnloadGuard(true);
      if (this.storage && this.storage.persistent === false) {
        this.addChatMessage('§e注意：浏览器不允许本页面使用存储（IndexedDB），这个世界不会被保存，关闭页面后就会丢失。');
      }
      if (L.isNew) this.saveWorld().catch((err) => this._reportSaveError(err, 'initial'));
    }
    L.resolve(L.meta);
  }

  async _abortLoading() {
    const world = this.world;
    this._loading = null;
    this._detachWorld();
    if (world) {
      try {
        await world.destroy();
      } catch { /* nothing to keep */ }
    }
    this._releaseWorldLock();
    this.state = 'title';
  }

  /** Release the session lock of the world this game had open (after its final save). */
  _releaseWorldLock() {
    const id = this._lockedWorldId;
    if (id === null) return;
    this._lockedWorldId = null;
    this._worldLocks.release(id);
  }

  /** Creative worlds start with Minecraft's default creative hotbar. */
  _fillCreativeHotbar() {
    const inv = this.player.inventory;
    DEFAULT_CREATIVE_HOTBAR.forEach((name, i) => {
      try {
        inv.set(i, makeStack(itemId(name), 1));
      } catch { /* unknown name: leave the slot empty */ }
    });
  }

  /**
   * New world: stand on the best column near the spawn column, update the world / player spawn point.
   */
  _placeAtSafeSpawn() {
    const meta = this.worldMeta;
    const best = this._findStandingSpot(meta.spawn.x, meta.spawn.z, SAFE_SPAWN_SEARCH) ??
      { x: Math.floor(meta.spawn.x) + 0.5, y: meta.spawn.y, z: Math.floor(meta.spawn.z) + 0.5 };
    meta.spawn = best;
    this.player.spawnPoint = { ...best };
    this.player.setPosition(best.x, best.y, best.z);
  }

  /**
   * Safest standing spot near column (x, z) within `radius` blocks, searching outward in rings:
   * first a spot whose surroundings are open (no solid blocks next to the head, e.g. not pressed
   * against a tree trunk), then any safe spot. Returns { x, y, z } (feet, column centre) or null.
   */
  _findStandingSpot(x, z, radius) {
    const x0 = Math.floor(x), z0 = Math.floor(z);
    for (let pass = 0; pass < 2; pass++) {
      for (let r = 0; r <= radius; r++) {
        for (let dz = -r; dz <= r; dz++) {
          for (let dx = -r; dx <= r; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
            const y = this._standingY(x0 + dx, z0 + dz, pass === 0);
            if (y >= 0) return { x: x0 + dx + 0.5, y, z: z0 + dz + 0.5 };
          }
        }
      }
    }
    return null;
  }

  /**
   * Feet y of a safe standing spot in column (x, z), or -1: solid opaque ground that is not leaves and
   * not harmful, with two free, dry cells above. With `open`, the 8 cells
   * around the body must not be solid either.
   */
  _standingY(x, z, open = false) {
    const world = this.world;
    let y = world.getTopY(x, z);
    if (y < 1) return -1;
    // Skip plants and other non-solid decorations on top down to the ground.
    while (y > 0) {
      const id = world.getBlock(x, y, z);
      if (IS_SOLID[id] || IS_LIQUID[id]) break;
      y--;
    }
    const ground = world.getBlock(x, y, z);
    if (!SAFE_GROUND[ground]) return -1;
    for (let k = 1; k <= 2; k++) {
      const id = world.getBlock(x, y + k, z);
      if (IS_SOLID[id] || IS_LIQUID[id]) return -1;
    }
    if (open) {
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dz === 0) continue;
          for (let k = 1; k <= 2; k++) {
            const id = world.getBlock(x + dx, y + k, z + dz);
            if (IS_SOLID[id] || IS_LIQUID[id]) return -1;
          }
        }
      }
    }
    return y + 1;
  }

  /**
   * Teleport to the surface of column (x, z): the player waits (frozen) until the area is meshed and is
   * then put on a safe standing spot near the column. Resolves with the final feet position.
   */
  teleportToSurface(x, z) {
    if (!this.player || !this.world) return Promise.reject(new Error('no world loaded'));
    const p = this.player;
    p.setPosition(Math.floor(x) + 0.5, Math.max(p.y, 64), Math.floor(z) + 0.5);
    p.vy = 0;
    if (this._pendingTp) this._pendingTp.resolve(null);
    return new Promise((resolve) => {
      this._pendingTp = { x: Math.floor(x), z: Math.floor(z), resolve };
    });
  }

  _updatePendingTeleport() {
    const t = this._pendingTp;
    const world = this.world;
    const p = this.player;
    if (!world.isAreaReady(t.x, t.z, 1)) {
      // Hold the player in place (physics is frozen anyway while the area is not ready).
      p.vx = 0; p.vy = 0; p.vz = 0;
      return;
    }
    this._pendingTp = null;
    const spot = this._findStandingSpot(t.x, t.z, 8);
    const top = world.getTopY(t.x, t.z);
    const pos = spot ?? { x: t.x + 0.5, y: top >= 0 ? top + 1 : p.y, z: t.z + 0.5 };
    p.setPosition(pos.x, pos.y, pos.z);
    t.resolve([pos.x, pos.y, pos.z]);
  }

  /** Saved world: if the stored position is inside solid blocks (edited externally), lift the player. */
  _ensureNotInsideBlocks() {
    const world = this.world;
    const p = this.player;
    const x = Math.floor(p.x), z = Math.floor(p.z);
    let y = Math.floor(p.y);
    let guard = 0;
    while (y < 255 && guard++ < 256 &&
      (IS_SOLID[world.getBlock(x, y, z)] || IS_SOLID[world.getBlock(x, y + 1, z)])) y++;
    if (y !== Math.floor(p.y)) p.setPosition(p.x, y, p.z);
  }

  /**
   * Save the current world (meta + player + entities + modified chunks). Calls are serialized; temporary
   * worlds are not saved. Resolves to true when something was written. Rejects when storage failed: the
   * data stays in memory and the next save writes it again.
   */
  saveWorld() {
    const run = () => this._saveNow();
    const p = this._saveChain.then(run, run);
    this._saveChain = p.catch(() => {});
    return p;
  }

  /** A persistent world is open and playing (temporary autostart worlds are never written). */
  _canSave() {
    return !!this.world && !!this.worldMeta && !this._temporary && this.state === 'playing';
  }

  async _saveNow() {
    if (!this._canSave()) return false;
    const world = this.world;
    const meta = this.worldMeta;
    // Once storage is open nothing is awaited before the writes start (see _saveForUnload).
    const storage = this.storage ?? await this._storageReady;
    if (this.world !== world || !this._canSave()) return false;
    this._snapshotMeta(meta);
    // The meta and every modified chunk go into ONE IndexedDB transaction that is created right here,
    // synchronously: all or nothing (a failed chunk write cannot leave a newer inventory behind), and a
    // page that is being closed still commits it. Writing the chunks only after the meta had committed
    // lost every block edit since the last autosave when a tab was closed.
    let write;
    try {
      write = typeof world.saveSnapshot === 'function'
        ? world.saveSnapshot(meta)
        : Promise.all([storage.saveWorldMeta(meta), world.save()]);
    } catch (err) {
      write = Promise.reject(err);
    }
    this._savesRunning++;
    try {
      await write;
    } catch (err) {
      this._dirty = true;
      throw err;
    } finally {
      this._savesRunning--;
    }
    if (this._saveFailedSince) {
      this._saveFailedSince = false;
      this.addChatMessage('§a世界已成功保存。');
    }
    return true;
  }

  /** Copy the live game state into the world meta (storage keeps a structured clone of it). */
  _snapshotMeta(meta) {
    meta.lastPlayed = Date.now();
    meta.time = this.time;
    if (this.player) {
      meta.player = this.player.serialize();
      meta.mode = this.player.mode;
    }
    // Dropped items, falling blocks, lit TNT, arrows and mobs (a few hundred bytes per entity), including
    // the ones parked with their unloaded chunks.
    if (this.entities) {
      const list = this.entities.serialize();
      for (const recs of this._parked.values()) for (const r of recs) list.push(r);
      meta.entities = list;
    }
    // Chest / furnace contents and furnace progress: in the same atomic snapshot as the chunks.
    if (this.blockEntities) meta.blockEntities = this.blockEntities.serialize();
    this._dirty = false;
  }

  /**
   * The page is being hidden or closed: start a save right now (synchronously, inside the event)
   * instead of queueing it behind a save in progress, so its transaction exists before the page goes
   * away. Skipped when a running save already holds everything (nothing was played since it started).
   */
  _saveForUnload() {
    if (!this._canSave() || !this.storage) return;
    if (this._savesRunning > 0 && !this._dirty) return;
    const p = this._saveNow();
    const prev = this._saveChain;
    this._saveChain = Promise.allSettled([prev, p]);
    p.catch((err) => this._reportSaveError(err, 'unload'));
  }

  /** True while leaving the page would lose progress: play since the last save, or a save in flight. */
  hasUnsavedProgress() {
    if (!this._canSave()) return false;
    if (this._dirty || this._savesRunning > 0) return true;
    try {
      return (this.world.stats().modified ?? 0) > 0;
    } catch {
      return true;
    }
  }

  /**
   * A save failed: log it, tell the player in chat (the same message at most once a minute) and emit
   * 'saveFailed' (err, kind) for screens that want to show more.
   */
  _reportSaveError(err, kind) {
    this._dirty = true;
    this._saveFailedSince = true;
    // Retry soon instead of after a full autosave interval (the data is only in memory meanwhile).
    this._autosaveTimer = Math.max(this._autosaveTimer, AUTOSAVE_SECONDS - SAVE_RETRY_SECONDS);
    this._logOnce(`save:${kind}`, `[game] ${kind} save failed:`, err);
    const text = describeSaveError(err);
    const now = performance.now();
    if (this.state === 'playing' && (text !== this._saveErrorText || now - this._saveErrorShown > SAVE_ERROR_CHAT_MS)) {
      this._saveErrorText = text;
      this._saveErrorShown = now;
      const hint = err?.name === 'QuotaExceededError' ? '（可以删除不需要的世界或清理浏览器数据）' : '，稍后会再试';
      this.addChatMessage(`§c无法保存世界：${text}${hint}`);
    }
    this.emit('saveFailed', err, kind);
  }

  /**
   * Save, unload the world and return to the title state (the UI then shows the title screen).
   * If saving fails, nothing is unloaded and nothing is lost: the world stays open, the player
   * is told why (chat line, 'saveFailed' event) and the promise rejects with an Error that has
   * `saveFailed: true` and `cause`; a later quitToTitle() tries again. A UI that does not handle that
   * rejection and shows the title screen anyway gets the failure message on top of it, leading back
   * to the pause menu.
   * @param {{ discard?: boolean }} [opts] discard: unload without saving (explicit "quit without saving")
   */
  quitToTitle({ discard = false } = {}) {
    if (this._quitting) return this._quitting;
    const p = this._quit(discard);
    this._quitting = p;
    const clear = () => {
      if (this._quitting === p) this._quitting = null;
    };
    p.then(clear, clear);
    return p;
  }

  async _quit(discard) {
    if (this._loading) {
      const L = this._loading;
      await this._abortLoading();
      L.reject(new Error('加载已取消'));
      return;
    }
    if (!this.world) {
      this.state = 'title';
      return;
    }
    if (!discard) {
      try {
        await this.saveWorld();
      } catch (err) {
        this._reportSaveError(err, 'quit');
        this._noTitleOverOpenWorld(err);
        const e = new Error(`无法保存世界：${describeSaveError(err)}`);
        e.saveFailed = true;
        e.cause = err;
        throw e;
      }
    }
    await this._unloadWorld(discard);
  }

  /**
   * Safety net for UIs that go to the title screen after a failed "save and quit" even though the world
   * is still open: replace that title screen with the reason, leading back to the pause menu.
   */
  _noTitleOverOpenWorld(err) {
    const ui = this.ui;
    if (!ui || typeof ui.showMessage !== 'function') return;
    const world = this.world;
    setTimeout(() => {
      if (this.world !== world || this.state !== 'playing' || ui.currentScreen !== 'title') return;
      const back = () => (typeof ui.showPauseMenu === 'function' ? ui.showPauseMenu() : ui.closeScreen?.());
      ui.showMessage('无法保存世界', `${describeSaveError(err)}。世界仍然开着，进度没有丢失，可以稍后再试。`, back);
    }, 0);
  }

  /** Unload the (saved or discarded) world and release its lock. */
  async _unloadWorld(discard = false) {
    const world = this.world;
    this.state = 'title';
    this.paused = false;
    globalThis.__ready = false;
    this._readySignalled = false;
    this._detachWorld();
    // destroy() frees meshes and jobs after a final save (normally nothing is left to write);
    // { save: false } asks it to skip that save when quitting without saving.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await world.destroy({ save: !discard });
        break;
      } catch (err) {
        if (attempt === 1 && !discard) console.warn('[game] unloading the world failed:', err);
      }
    }
    this.renderer?.clearAll();
    this._releaseWorldLock();
    this.emit('worldUnloaded');
  }

  /** Register / remove the beforeunload confirmation (only while a persistent world is open). */
  _setUnloadGuard(on) {
    if (on === this._unloadGuard || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
    this._unloadGuard = on;
    if (on) window.addEventListener('beforeunload', this._onBeforeUnload);
    else window.removeEventListener('beforeunload', this._onBeforeUnload);
  }

  _detachWorld() {
    this._setUnloadGuard(false);
    this._unsubBlock?.();
    this._unsubBlock = null;
    this._unsubGen?.();
    this._unsubGen = null;
    if (this._pendingTp) {
      this._pendingTp.resolve(null);
      this._pendingTp = null;
    }
    this.spawner = null;
    this._parked.clear();
    this.blockEntities?.detach();
    this.blockEntities?.clear();
    this.blockEntities = null;
    this.entities?.clear();
    this.particles?.clear?.();
    this.world = null;
    this.player = null;
    this.interaction = null;
    this.entities = null;
    this.particles = null;
    this.worldMeta = null;
    this._temporary = false;
    this.frame.entities = [];
    this.frame.selection = null;
    this.frame.breaking = null;
    this.frame.hand = null;
    this.frame.particles = null;
  }

  // =================================================================================================
  // Gameplay facade
  // =================================================================================================

  /**
   * Pause (pause menu) / resume the simulation. Rendering, streaming and UI keep running. Pausing saves
   * the world, like Minecraft's integrated server ("Saving and pausing game...").
   */
  setPaused(paused) {
    const was = this.paused;
    this.paused = !!paused;
    if (this.paused && !was && this._canSave()) {
      this._autosaveTimer = 0;
      this.saveWorld().catch((err) => this._reportSaveError(err, 'pause'));
    }
  }

  /** 'survival' | 'creative' */
  setGameMode(mode) {
    if (mode !== 'survival' && mode !== 'creative') return;
    if (!this.player) return;
    this.player.setGameMode(mode);
    if (this.worldMeta) this.worldMeta.mode = mode;
    this.emit('gameModeChanged', mode);
  }

  /** Death screen "重生": respawn at the spawn point (emits playerRespawned). */
  respawn() {
    this.player?.respawn();
  }

  /** Run a chat command ("/give ..."); feedback arrives as chat messages. */
  runCommand(text) {
    runCommand(this, text);
  }

  /** Post a chat line (may contain § formatting codes). The UI listens to the 'chat' event. */
  addChatMessage(text, color) {
    this.emit('chat', String(text ?? ''), color);
  }

  /** Spawn a dropped item entity (SPEC §9.5). */
  spawnItem(stack, x, y, z, vx, vy, vz, pickupDelay) {
    return this.entities ? this.entities.spawnItem(stack, x, y, z, vx, vy, vz, pickupDelay) : null;
  }

  /**
   * Spawn a mob (spawn eggs, /summon, debug): `type` is a MOB_TYPES key, (x, y, z) the feet position.
   * Returns the Mob or null (unknown type, hostile mob in peaceful, no world).
   * @param {{ persistent?: boolean, yaw?: number }} [opts]
   */
  spawnMob(type, x, y, z, opts) {
    if (!this.entities || !this.world) return null;
    return spawnMob(this, type, x, y, z, opts);
  }

  /**
   * Entities live with their chunks, like Minecraft saving entities in the chunk: once a chunk is unloaded
   * its entities (animals, items, arrows...) leave the live list and are kept as saved records; they come
   * back when the chunk is meshed again. However far the player travels, per-frame entity work stays
   * bounded by the loaded area. Non-persistent mobs (natural hostiles, /summon) are dropped instead —
   * Minecraft would despawn them at that distance anyway.
   */
  _updateParking() {
    const world = this.world;
    const ents = this.entities;
    if (!world || !ents) return;
    if (this._parked.size > 0) {
      let restore = null;
      for (const [key, recs] of this._parked) {
        const i = key.indexOf(',');
        if (!world.isChunkMeshed(Number(key.slice(0, i)), Number(key.slice(i + 1)))) continue;
        this._parked.delete(key);
        if (restore) for (const r of recs) restore.push(r);
        else restore = recs;
      }
      if (restore) {
        try {
          ents.deserialize(restore);
        } catch (err) {
          this._logOnce('unpark', '[game] restoring parked entities failed:', err);
        }
      }
    }
    const list = ents.list;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e.removed) continue;
      const cx = Math.floor(e.x) >> 4, cz = Math.floor(e.z) >> 4;
      if (world.isChunkGenerated(cx, cz)) continue;
      let rec = null;
      if (e.type !== 'mob' || e.persistent) {
        try {
          rec = e.serialize();
        } catch {
          rec = null;
        }
      }
      e.remove();
      if (!rec) continue;
      const key = cx + ',' + cz;
      let recs = this._parked.get(key);
      if (!recs) this._parked.set(key, (recs = []));
      recs.push(rec);
    }
  }

  /** Number of entity records parked with unloaded chunks. */
  get parkedEntities() {
    let n = 0;
    for (const recs of this._parked.values()) n += recs.length;
    return n;
  }

  /** Break sound + particles of block `id` that was removed at (x, y, z) without the player mining it. */
  _blockBreakEffects(id, x, y, z) {
    const def = BLOCKS[id];
    if (!def || id === BLOCK.AIR) return;
    this.particles?.spawnBlockBreak?.(x, y, z, id);
    this.audio?.playBlock?.('break', def.sound, x + 0.5, y + 0.5, z + 0.5);
  }

  /**
   * World effects (World onEffect): 'fizz' = lava meeting water turned into obsidian / cobblestone /
   * stone at the block centre (x, y, z): Minecraft's LAVA_FIZZ level event — the extinguish sound at
   * volume 0.5 and 8 large smoke puffs over the block.
   */
  _worldEffect(name, x, y, z) {
    if (name !== 'fizz') return;
    const r = this._rng;
    this.audio?.play('fizz', { x, y, z, volume: 0.5, pitch: 1 + (r() - r()) * 0.2 });
    this.particles?.spawnSmoke?.(x, y + 0.7, z, 8);
  }

  /** Throw a stack from the player's eyes (Q key, items dropped from inventory screens). */
  dropFromPlayer(stack) {
    if (!stack || !(stack.count > 0) || !this.entities || !this.player) return null;
    return this.entities.dropFromPlayer(stack, this.player);
  }

  /**
   * Right-click on an interactive block other than the crafting table (interaction.js hook).
   * Chest / furnace → their screens (a chest under a solid block stays shut but consumes the click);
   * TNT + flint and steel → primed TNT. Returns false to let the click place the held block instead.
   */
  onInteractBlock(x, y, z, blockId, ctx) {
    if (this.blockEntities?.useBlock(x, y, z, blockId, ctx)) return true;
    const def = BLOCKS[blockId];
    if (def?.interact === 'tnt' && ctx?.itemId === ITEM.FLINT_AND_STEEL && this.entities) {
      if (!this.world.setBlock(x, y, z, BLOCK.AIR)) return false;
      this.entities.spawnPrimedTnt(x + 0.5, y, z + 0.5);
      if (this.player.mode !== 'creative') this.player.inventory.damageItem(ctx.slot, 1);
      this.audio?.play('click', { x: x + 0.5, y: y + 0.5, z: z + 0.5, pitch: 0.6 });
      return true;
    }
    return false;
  }

  // =================================================================================================
  // Settings
  // =================================================================================================

  /**
   * Change settings (validated), persist them and apply them to every subsystem; emits settingsChanged.
   * @param {object} partial
   */
  applySettings(partial) {
    const clean = sanitizeSettings(partial);
    const changed = {};
    for (const [k, v] of Object.entries(clean)) {
      if (this.settings[k] !== v) {
        this.settings[k] = v;
        changed[k] = v;
        delete this._sessionOverrides[k];      // an explicit change replaces a URL override
      }
    }
    if (Object.keys(changed).length === 0) return;
    if ('renderDistance' in changed) this.world?.setRenderDistance(changed.renderDistance);
    if ('smoothLighting' in changed) this.world?.setSmoothLighting(changed.smoothLighting);
    if ('soundVolume' in changed || 'musicVolume' in changed) {
      this.audio?.setVolumes(this.settings.soundVolume, this.settings.musicVolume);
    }
    if (this.input && this.input.settings !== this.settings) this.input.settings = this.settings;
    this._persistSettings();
    this.emit('settingsChanged', changed, this.settings);
  }

  _persistSettings() {
    if (!this.options.persistSettings) return;
    try {
      const stored = { ...this.settings, ...this._sessionOverrides };
      globalThis.localStorage?.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(stored));
    } catch (err) {
      this._logOnce('settings', '[game] could not save settings:', err);
    }
  }

  // =================================================================================================
  // Debug screen (F3)
  // =================================================================================================

  /** Left column of the F3 overlay (Chinese labels with Minecraft's English terms). */
  getDebugInfo() {
    const lines = [];
    lines.push(`WebCraft ${VERSION}（${Math.round(this.fps)} fps）`);
    const world = this.world;
    const p = this.player;
    if (!world || !p) return lines;
    const st = world.stats();
    lines.push(`区块 C: ${st.meshed}/${st.loaded} · 距离 ${st.renderDistance} · 待处理 ${st.pendingGenerate}/${st.pendingMesh}/${st.uploadQueue}`);
    let mobs = 0, hostile = 0;
    for (const e of this.entities?.list ?? []) {
      if (e.type !== 'mob' || e.removed) continue;
      mobs++;
      if (e.hostile) hostile++;
    }
    lines.push(`实体 E: ${this.entities?.count ?? 0} · 生物 ${mobs}（敌对 ${hostile}）· 粒子 P: ${this.particles?.count ?? 0}`);
    const diff = DIFFICULTY_NAMES[this.settings.difficulty] ?? this.settings.difficulty;
    lines.push(`方块实体 ${this.blockEntities?.count ?? 0} · 液体更新 ${st.pendingFluids ?? 0} · 远处实体 ${this.parkedEntities} · 难度 ${diff}`);
    lines.push('');
    lines.push(`XYZ: ${fmt(p.x, 3)} / ${fmt(p.y, 5)} / ${fmt(p.z, 3)}`);
    const bx = Math.floor(p.x), by = Math.floor(p.y), bz = Math.floor(p.z);
    lines.push(`方块 Block: ${bx} ${by} ${bz}`);
    lines.push(`区块 Chunk: ${bx & 15} ${by & 15} ${bz & 15} in ${bx >> 4} ${by >> 4} ${bz >> 4}`);
    const f = FACING[((Math.round(p.yaw / (Math.PI / 2)) % 4) + 4) % 4];
    const mcYaw = wrapDeg(180 - p.yaw / DEG);
    const mcPitch = -p.pitch / DEG;
    lines.push(`朝向 Facing: ${f[0]} ${f[1]}（${f[2]} / ${f[3]}）(${fmt(mcYaw, 1)} / ${fmt(mcPitch, 1)})`);
    const eye = Math.min(255, Math.max(0, Math.floor(p.y + p.eyeHeight)));
    const light = world.getLight(bx, eye, bz);
    const sky = light >> 4, blk = light & 15;
    const skyNow = Math.max(0, sky - (15 - skyLightLevelAt(this.timeOfDay)));
    lines.push(`光照 Light: ${Math.max(skyNow, blk)}（天空 sky ${sky}，方块 block ${blk}）`);
    let biome = null;
    try {
      biome = world.getBiome(bx, bz);
    } catch { /* generator unavailable */ }
    if (biome) lines.push(`生物群系 Biome: ${biome.displayName} ${biome.name}`);
    const day = Math.floor(this.time / DAY_TICKS) + 1;
    lines.push(`第 ${day} 天 Day ${day} · 时间 ${Math.floor(this.time % DAY_TICKS)} · 种子 ${this.worldMeta?.seed ?? '?'}`);
    lines.push(`模式: ${MODE_NAMES[p.mode] ?? p.mode}${p.flying ? ' · 飞行' : ''}`);
    const t = this.interaction?.target;
    if (t) {
      const b = BLOCKS[t.blockId];
      lines.push('');
      lines.push(`目标方块 Targeted Block: ${t.x} ${t.y} ${t.z}`);
      lines.push(`${b ? `${b.displayName} ${b.name}` : `#${t.blockId}`} · ${FACE_NAMES[t.face] ?? t.face}`);
    }
    const te = this.interaction?.targetEntity;
    if (te && !te.removed) {
      const def = te.mobType ? MOB_TYPES[te.mobType] : null;
      lines.push('');
      lines.push(`目标实体 Targeted Entity: ${def ? `${def.name} ${te.mobType}` : te.type}`);
      if (Number.isFinite(te.health)) lines.push(`生命值 Health: ${fmt(te.health, 1)} / ${te.maxHealth ?? '?'}`);
    }
    return lines;
  }

  // =================================================================================================
  // Screenshots (F2)
  // =================================================================================================

  /** Request a screenshot of the next rendered frame (downloaded as a PNG). */
  takeScreenshot() {
    this._screenshotPending = true;
  }

  _saveScreenshot() {
    const canvas = this.canvas;
    if (!canvas || typeof canvas.toBlob !== 'function') return;
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const name = `webcraft_${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_` +
      `${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}.png`;
    // toBlob snapshots the drawing buffer synchronously (we are right after render()).
    canvas.toBlob((blob) => {
      if (!blob) {
        this.addChatMessage('§c无法保存截图', undefined);
        return;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      this.addChatMessage(`已保存截图为 §n${name}`);
    }, 'image/png');
  }

  // =================================================================================================
  // DOM hooks
  // =================================================================================================

  _attachDomListeners() {
    if (typeof window === 'undefined') return;
    window.addEventListener('keydown', (e) => {
      if (e.code !== 'F2' || e.repeat || this.state !== 'playing') return;
      e.preventDefault();
      this.takeScreenshot();
    });
    // Save when the tab is hidden (switching tabs, minimising, the first step of closing) and when the
    // page goes away. The writes are started synchronously inside the event (see _saveForUnload).
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this._saveForUnload();
    });
    window.addEventListener('pagehide', () => this._saveForUnload());
  }

  // =================================================================================================
  // Debug / automation API (window.__game.debug)
  // =================================================================================================

  _createDebugApi() {
    const game = this;
    const needWorld = () => {
      if (!game.world || !game.player) throw new Error('no world loaded');
      return game.world;
    };
    const blockOf = (v) => {
      const id = typeof v === 'number' ? v : resolveBlock(String(v));
      if (id === null || id === undefined || !BLOCKS[id]) throw new Error(`unknown block ${v}`);
      return id;
    };
    return {
      /**
       * Teleport the player's feet to (x, y, z). Without y (null / undefined) the player is put on a
       * safe spot on the surface once the area is loaded; the returned promise resolves then.
       */
      tp(x, y, z) {
        needWorld();
        if (!Number.isFinite(y)) return game.teleportToSurface(x, z);
        game.player.setPosition(x, y, z);
        return Promise.resolve([game.player.x, game.player.y, game.player.z]);
      },
      /**
       * Nearest column of biome `name` ('desert', 'snowy_plains', 'mountains', ... or the Chinese
       * display name) within `maxDist` blocks of the player (spiral search, 32-block grid) or null.
       */
      findBiome(name, maxDist = 6000) {
        const world = needWorld();
        const gen = world.generator;
        const px = Math.floor(game.player.x), pz = Math.floor(game.player.z);
        const step = 32;
        const match = (b) => b && (b.name === name || b.displayName === name);
        for (let r = 0; r * step <= maxDist; r++) {
          for (let dz = -r; dz <= r; dz++) {
            for (let dx = -r; dx <= r; dx++) {
              if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
              const x = px + dx * step, z = pz + dz * step;
              if (match(gen.getBiome(x, z))) return { x, z, distance: Math.round(Math.hypot(x - px, z - pz)) };
            }
          }
        }
        return null;
      },
      /** Frame statistics since the last reset: { frames, avgMs, maxMs, over33, over50, update/render CPU ms }. */
      perf(reset = false) {
        const p = game._perf;
        const n = Math.max(1, p.frames);
        const out = {
          frames: p.frames, avgFrameMs: +(p.totalMs / n).toFixed(2), fps: +(1000 * p.frames / Math.max(1, p.totalMs)).toFixed(1),
          maxFrameMs: +p.maxMs.toFixed(1), framesOver33ms: p.over33, framesOver50ms: p.over50,
          avgUpdateCpuMs: +(p.updateMs / n).toFixed(3), avgRenderCpuMs: +(p.renderMs / n).toFixed(3),
          longFrames: p.long.slice(),
        };
        if (reset) {
          Object.assign(p, { frames: 0, totalMs: 0, maxMs: 0, over33: 0, over50: 0, updateMs: 0, renderMs: 0, since: performance.now() });
          p.long.length = 0;
        }
        return out;
      },
      /** Look direction in radians (SPEC §4: yaw 0 = north, +π/2 = west; pitch + = up). */
      look(yaw, pitch = 0) {
        needWorld();
        const p = game.player;
        p.yaw = Math.atan2(Math.sin(yaw), Math.cos(yaw));
        p.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, pitch));
        p._lagYaw = p.yaw;
        p._lagPitch = p.pitch;
        return [p.yaw, p.pitch];
      },
      /** Same as look() with degrees. */
      lookDeg(yawDeg, pitchDeg = 0) {
        return this.look(yawDeg * DEG, pitchDeg * DEG);
      },
      /** Turn the camera toward a world point (e.g. a block centre x + 0.5, y + 0.5, z + 0.5). */
      lookAt(x, y, z) {
        needWorld();
        const e = game.player.getEyePosition([0, 0, 0]);
        const dx = x - e[0], dy = y - e[1], dz = z - e[2];
        const yaw = Math.atan2(-dx, -dz);
        const pitch = Math.atan2(dy, Math.hypot(dx, dz));
        return this.look(yaw, pitch);
      },
      setTime(t) {
        const v = typeof t === 'string' ? parseTimeParam(t) : t;
        game.setTime(v);
        return game.time;
      },
      setBlock(x, y, z, nameOrId) {
        return needWorld().setBlock(x, y, z, blockOf(nameOrId));
      },
      /** Block id at (x, y, z). */
      getBlock(x, y, z) {
        return needWorld().getBlock(x, y, z);
      },
      /** Block name at (x, y, z). */
      blockName(x, y, z) {
        return BLOCKS[needWorld().getBlock(x, y, z)]?.name ?? null;
      },
      /** Add items to the inventory; returns the count that did not fit. */
      give(name, count = 1) {
        needWorld();
        const id = typeof name === 'number' ? name : resolveItem(String(name));
        if (id === null || id === undefined || !getItem(id)) throw new Error(`unknown item ${name}`);
        return game.player.inventory.add(makeStack(id, Math.max(1, count | 0)));
      },
      setMode(m) {
        game.setGameMode(m);
        return game.player?.mode;
      },
      /** Select hotbar slot 0..8. */
      select(slot) {
        needWorld();
        game.player.selectedSlot = Math.max(0, Math.min(8, slot | 0));
        return game.player.selectedSlot;
      },
      /** Currently targeted block (copy) or null. */
      target() {
        const t = game.interaction?.target;
        return t ? { x: t.x, y: t.y, z: t.z, face: t.face, blockId: t.blockId, name: BLOCKS[t.blockId]?.name } : null;
      },
      /** Break the targeted block (or x, y, z) like the player does (drops in survival). */
      mine(x, y, z) {
        needWorld();
        const t = Number.isFinite(x) ? { x, y, z } : game.interaction.target;
        if (!t) return false;
        return game.interaction.breakBlock(t.x, t.y, t.z, { drops: game.player.mode !== 'creative' });
      },
      /** Right-click (use / place the held item) on the current target. */
      use() {
        needWorld();
        return game.interaction.useItem();
      },
      /** Resolves when the world is idle (nothing to generate / mesh / upload) and the area is ready. */
      waitIdle(timeoutMs = 60000) {
        return new Promise((resolve) => {
          game._waiters.push({ kind: 'idle', resolve, deadline: performance.now() + timeoutMs });
        });
      },
      /** Resolves after `n` more frames were rendered. */
      frames(n = 1) {
        return new Promise((resolve) => {
          game._waiters.push({ kind: 'frames', resolve, left: Math.max(1, n | 0) });
        });
      },
      stats() {
        const r = game.renderer?.getStats?.();
        return {
          state: game.state,
          fps: Math.round(game.fps * 10) / 10,
          world: game.world ? game.world.stats() : null,
          renderer: r ? { ...r } : null,
          entities: game.entities?.count ?? 0,
          particles: game.particles?.count ?? 0,
          pool: game.pool?.getStats?.() ?? null,
          player: game.player ? {
            x: game.player.x, y: game.player.y, z: game.player.z, yaw: game.player.yaw, pitch: game.player.pitch,
            mode: game.player.mode, health: game.player.health, onGround: game.player.onGround,
            frozen: game.player.frozen, dead: game.player.dead,
          } : null,
          time: game.time,
        };
      },
      hideHud(hidden = true) {
        game.ui?.setHudHidden(hidden);
        return !!game.ui?.hudHidden;
      },
      /**
       * Spawn mob `type` on the ground `dist` blocks in front of the player (`side` blocks to the right),
       * facing the player. Persistent like a spawn egg. Returns a short description or null.
       */
      summon(type, dist = 6, side = 0, opts = {}) {
        const world = needWorld();
        if (!MOB_TYPES[type]) throw new Error(`unknown mob ${type}`);
        const p = game.player;
        const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw);
        const rx = Math.cos(p.yaw), rz = -Math.sin(p.yaw);
        const x = Math.floor(p.x + fx * dist + rx * side), z = Math.floor(p.z + fz * dist + rz * side);
        let y = opts.y;
        if (!Number.isFinite(y)) {
          // the standing spot nearest to the player's feet level (0, +1, -1, +2, ... within 24 blocks:
          // hills, caves, rooms), else the surface
          y = -1;
          const fy = Math.floor(p.y);
          for (let k = 0; k <= 48 && y < 0; k++) {
            const yy = fy + (k & 1 ? (k + 1) >> 1 : -(k >> 1));
            if (yy < 1 || yy > 254) continue;
            if (IS_SOLID[world.getBlock(x, yy - 1, z)] && !IS_SOLID[world.getBlock(x, yy, z)] &&
              !IS_SOLID[world.getBlock(x, yy + 1, z)]) y = yy;
          }
          if (y < 0) y = world.getTopY(x, z) + 1;
        }
        const m = game.spawnMob(type, x + 0.5, y, z + 0.5, { persistent: opts.persistent ?? true, yaw: Math.atan2(fx, fz) });
        return m ? { type, x: m.x, y: m.y, z: m.z, id: game.entities.list.indexOf(m) } : null;
      },
      /** Live mobs within `r` blocks: [{ type, x, y, z, health, target, frozen }]. */
      mobs(r = 128) {
        needWorld();
        const p = game.player;
        const out = [];
        for (const e of game.entities.list) {
          if (e.type !== 'mob' || e.removed || Math.hypot(e.x - p.x, e.z - p.z) > r) continue;
          out.push({
            type: e.mobType, x: +e.x.toFixed(2), y: +e.y.toFixed(2), z: +e.z.toFixed(2), health: e.health,
            dead: !!e.dead, target: !!e.target, frozen: !!e.frozen, onFire: e.fireTime > 0,
            dist: +Math.hypot(e.x - p.x, e.y - p.y, e.z - p.z).toFixed(1),
          });
        }
        return out;
      },
      /** Remove every mob silently (no drops). Returns how many were removed. */
      clearMobs() {
        needWorld();
        let n = 0;
        for (const e of game.entities.list) {
          if (e.type === 'mob' && !e.removed) {
            e.remove();
            n++;
          }
        }
        return n;
      },
    };
  }

  _checkWaiters() {
    const now = performance.now();
    const w = this._waiters;
    let k = 0;
    for (let i = 0; i < w.length; i++) {
      const it = w[i];
      let done = false;
      if (it.kind === 'frames') {
        if (--it.left <= 0) {
          it.resolve(true);
          done = true;
        }
      } else if (it.kind === 'idle') {
        const world = this.world;
        const ok = !!world && this.state === 'playing' && world.stats().idle &&
          world.isAreaReady(this.player.x, this.player.z, SPAWN_RADIUS);
        if (ok || now > it.deadline) {
          it.resolve(ok);
          done = true;
        }
      }
      if (!done) w[k++] = it;
    }
    w.length = k;
  }

  _logOnce(kind, text, err) {
    const key = kind + ':' + (err && err.message ? err.message : String(err));
    if (this._loggedErrors.has(key)) return;
    this._loggedErrors.add(key);
    console.error(text, err);
  }
}
