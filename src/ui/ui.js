// UIManager — every screen and the HUD (SPEC §9.8 / §13). Owns #ui-root:
//   crosshair (direct child, mix-blend-mode: difference against the game canvas)
//   .hud           hotbar, bars, chat log, F3, vignettes (hud.js, chat.js)
//   .screen-layer  the current screen (menus.js, containers.js, chat.js)
//   .overlay-layer item stack held by the mouse + tooltip
// Input routing: while a screen is open game.input.enabled = false and the pointer lock is released;
// closing re-locks immediately (inside the user gesture) and re-enables input on the next update()
// (so the key that closed the screen cannot leak into the game). Screen keys (E, Escape, T, /, 1-9,
// Q over slots) are handled by this module's own capture-phase key listener.
import { buildGuiAssets, buildTextureAssets, getTextureSet, FallbackIcons } from './assets.js';
import { loadPixelFont } from './font.js';
import { h, setClickSound } from './dom.js';
import { Hud } from './hud.js';
import { ChatLog, ChatScreen } from './chat.js';
import {
  InventoryScreen, CraftingScreen, CreativeScreen, ContainerScreen, FurnaceScreen, ChestScreen, fillTooltip,
} from './containers.js';
import {
  TitleScreen, WorldListScreen, OptionsScreen, LoadingScreen, PauseScreen, DeathScreen, MessageScreen,
  SaveFailedScreen, MultiplayerScreen,
} from './menus.js';
import { MultiplayerClient } from '../net/client.js';
import { createItemView, setItemView } from './itemview.js';
import { deathMessage } from './text.js';

const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'email', 'password', 'number', 'tel']);

function isTextField(el) {
  if (!el || !el.tagName) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === 'TEXTAREA') return true;
  return el.tagName === 'INPUT' && TEXT_INPUT_TYPES.has(el.type);
}

/** Interpret 'playerDied' event arguments: a message, a cause key, or an object with either. */
function deathTextFromArgs(args) {
  for (const a of args) {
    if (typeof a === 'string' && a) return /[^\x00-\x7f]/.test(a) ? a : deathMessage(a);
    if (a && typeof a === 'object') {
      if (typeof a.message === 'string' && a.message) return a.message;
      if (typeof a.cause === 'string') return deathMessage(a.cause);
      if (typeof a.deathCause === 'string') return deathMessage(a.deathCause);
    }
  }
  return '';
}

export class UIManager {
  /**
   * @param {object} game   the Game (SPEC §9.10)
   * @param {HTMLElement} root  #ui-root
   * @param {object} [options]
   * @param {boolean} [options.handleHudKeys=false]  also bind F1 / F3 here (standalone pages); in the
   *        game these come from Input actions 'hideHud' / 'debug' via game.js -> toggleHud()/toggleDebug()
   * @param {boolean} [options.automation]  suppress the "click to play" hint (default: URL has autostart)
   */
  constructor(game, root, options = {}) {
    this.game = game;
    this.root = root ?? document.getElementById('ui-root');
    this.options = { handleHudKeys: false, ...options };
    this.automation = options.automation ?? /[?&]autostart=1/.test(location.search);
    this.root.classList.add('mc-ui');

    // ---- assets
    const gui = buildGuiAssets();
    for (const [k, v] of Object.entries(gui.cssVars)) this.root.style.setProperty(k, v);
    this.textures = game.textures ?? game.icons?.textures ?? null;
    this.applyTextureAssets(this.textures);
    if (!this.textures) {
      getTextureSet(game).then((tex) => {
        if (!tex) return;
        this.textures = tex;
        this.applyTextureAssets(tex);
        this.screen?.onTexturesReady?.(tex);
      });
    }
    this.fontReady = loadPixelFont();

    // ---- layers
    this.crosshair = h('div', { className: 'crosshair' });
    this.chatLog = new ChatLog();
    this.hud = new Hud(this);
    this.hud.el.appendChild(this.chatLog.el);
    this.screenLayer = h('div', { className: 'screen-layer' });
    this.overlay = h('div', { className: 'overlay-layer' });
    this.cursorView = createItemView('item cursor-item');
    this.tooltipEl = h('div', { className: 'tooltip' });
    this.tooltipEl.style.display = 'none';
    this.cursorView.style.display = 'none';
    this.overlay.append(this.cursorView, this.tooltipEl);
    this.root.append(this.crosshair, this.hud.el, this.screenLayer, this.overlay);

    // ---- state
    this.screen = null;
    this.hudHidden = false;
    this.debugVisible = false;
    this.chatHistory = [];
    this.lastCreativeTab = null;
    this.mouse = { x: -1000, y: -1000 };
    this.pendingEnable = false;
    this.pausedByUI = false;
    this.lastLockLoss = 0;
    this.cursorStack = null;
    this.tooltipShown = false;
    this.unit = 1;
    this.scale = 1;
    this.guiWidth = 320;
    this.guiHeight = 240;

    setClickSound(() => this.playClick());

    // ---- listeners
    this.listeners = [];
    const on = (target, type, fn, opts) => {
      target.addEventListener(type, fn, opts);
      this.listeners.push([target, type, fn, opts]);
    };
    on(window, 'resize', () => this.updateScale());
    on(window, 'keydown', (e) => this.onKeyDown(e), true);
    // The pointer position is tracked even without a screen, so a screen opening under a resting cursor
    // knows the hovered slot right away (number keys, Q, tooltip — review UI-3).
    on(window, 'pointermove', (e) => this.trackMouse(e), true);
    on(window, 'pointerup', (e) => this.screen?.onPointerUp?.(e));
    on(window, 'blur', () => this.screen?.onPointerUp?.());
    on(this.root, 'contextmenu', (e) => {
      if (!isTextField(e.target)) e.preventDefault();
    });
    on(window, 'pointerdown', () => this.game.audio?.unlock?.(), { once: true, capture: true });

    const ev = (name, fn) => {
      if (typeof game.on === 'function') {
        game.on(name, fn);
        this.listeners.push([null, name, fn]);
      }
    };
    ev('settingsChanged', () => this.updateScale());
    ev('chat', (text, color) => {
      if (text && typeof text === 'object') this.chatLog.add(text.text, text.color);
      else this.chatLog.add(text, color);
    });
    ev('loadingProgress', (a, b) => {
      if (a && typeof a === 'object') this.setLoadingProgress(a.fraction ?? a.progress ?? 0, a.text ?? a.message);
      else this.setLoadingProgress(a, b);
    });
    ev('playerDied', (...args) => this.openDeath(deathTextFromArgs(args)));
    ev('playerRespawned', () => {
      if (this.screen instanceof DeathScreen) this.enterGame();
    });
    ev('gameModeChanged', () => {
      // swap survival <-> creative inventory in place (never via "no screen", which would re-lock)
      if ((this.screen instanceof InventoryScreen || this.screen instanceof CreativeScreen) && this.canOpenGameScreen()) {
        this.setScreen(this.createInventoryScreen());
      }
    });
    ev('worldLoaded', () => this.hud.reset());
    ev('worldUnloaded', () => {
      this.chatLog.clear();
      this.hud.reset();
      if (this.screen && this.screen.inGame) this.setScreen(null, { relock: false });
    });

    const input = game.input;
    if (input && typeof input.onLockChange === 'function') {
      input.onLockChange((locked) => {
        if (locked) {
          // a lock request that resolved after a screen opened: give the pointer back to the screen
          if (this.screen) input.exitLock?.();
          return;
        }
        if (this.game.state === 'playing' && !this.screen && !this.game.player?.dead) {
          this.lastLockLoss = performance.now();
          this.openPause();
        }
      });
    }
    this.updateScale();
  }

  // ------------------------------------------------------------------ assets / scale
  get icons() {
    const ic = this.game.icons;
    if (ic && typeof ic.getIcon === 'function') return ic;
    if (!this.fallbackIcons) this.fallbackIcons = new FallbackIcons(this.textures);
    return this.fallbackIcons;
  }

  applyTextureAssets(textures) {
    const t = buildTextureAssets(textures);
    for (const [k, v] of Object.entries(t.cssVars)) this.root.style.setProperty(k, v);
    if (this.fallbackIcons) this.fallbackIcons.textures = textures;
  }

  /**
   * GUI scale like Minecraft: the largest integer factor (in device pixels) that keeps at least
   * 320x240 GUI pixels, or settings.guiScale (1-8) capped to that maximum.
   */
  updateScale() {
    const dpr = window.devicePixelRatio || 1;
    const dw = Math.floor(window.innerWidth * dpr);
    const dh = Math.floor(window.innerHeight * dpr);
    let max = 1;
    while (max < 16 && dw / (max + 1) >= 320 && dh / (max + 1) >= 240) max++;
    /** Largest GUI scale the window allows (the options button only offers Auto and 1..maxScale). */
    this.maxScale = max;
    const setting = Math.max(0, Math.min(8, (this.game.settings?.guiScale ?? 0) | 0));
    const scale = setting > 0 ? Math.min(setting, max) : max;
    const unit = scale / dpr;
    const gw = Math.floor(dw / scale);
    const gh = Math.floor(dh / scale);
    if (unit === this.unit && gw === this.guiWidth && gh === this.guiHeight && this.scaleSet) return;
    this.scaleSet = true;
    this.unit = unit;
    this.scale = scale;
    this.guiWidth = gw;
    this.guiHeight = gh;
    const s = this.root.style;
    s.setProperty('--g', `${unit}px`);
    s.setProperty('--ts', `${Math.max(1, Math.round((scale * 2) / 3)) / dpr}px`);
    s.setProperty('--gw', String(gw));
    s.setProperty('--gh', String(gh));
    s.setProperty('--hw', String(Math.floor(gw / 2)));
    s.setProperty('--hh', String(Math.floor(gh / 2)));
    s.setProperty('--qh', String(Math.floor(gh / 4)));
    s.setProperty('--h6', String(Math.floor(gh / 6)));
  }

  playClick() {
    this.game.audio?.play?.('click');
  }

  // ------------------------------------------------------------------ screen management
  /** Current screen name ('title', 'worlds', 'inventory', 'chat', ...) or null in game. */
  get currentScreen() {
    return this.screen ? this.screen.name : null;
  }

  isScreenOpen() {
    return !!this.screen;
  }

  /**
   * Replace the current screen (null = back to the game).
   * @param {object|null} next
   * @param {{ relock?: boolean }} [opts] relock: request the pointer lock when returning to the game
   */
  setScreen(next, { relock = true } = {}) {
    const prev = this.screen;
    if (prev === next) return;
    if (prev) {
      try {
        prev.onClose?.();
      } finally {
        prev.el.remove();
      }
    }
    this.screen = next ?? null;
    this.hideTooltip();
    this.setCursorStack(null);
    const game = this.game;
    const input = game.input;
    if (next) {
      this.screenLayer.appendChild(next.el);
      if (input) {
        input.enabled = false;
        this.pendingEnable = false;
        if (input.locked) input.exitLock?.();
      }
      if (next.pausesGame && game.state === 'playing') {
        if (!game.paused) {
          game.setPaused?.(true);
          this.pausedByUI = true;
        }
      } else if (next.inGame && this.pausedByUI) {
        game.setPaused?.(false);
        this.pausedByUI = false;
      }
      next.onOpen?.();
    } else {
      if (this.pausedByUI) {
        game.setPaused?.(false);
        this.pausedByUI = false;
      }
      if (game.state === 'playing' && relock) {
        this.pendingEnable = true;
        this.requestLock();
      }
    }
    this.root.classList.toggle('screen-open', !!next);
  }

  /** Ask Input for the pointer lock (one request in flight at a time; failures are silent). */
  requestLock() {
    const input = this.game.input;
    if (!input || input.locked || typeof input.requestLock !== 'function' || this.lockRequest) return;
    try {
      const r = input.requestLock();
      if (r && typeof r.then === 'function') {
        this.lockRequest = r;
        const done = () => {
          if (this.lockRequest === r) this.lockRequest = null;
        };
        r.then(done, done);
      }
    } catch {
      // the browser refused (e.g. no user gesture); the "click to play" hint covers this
    }
  }

  closeScreen() {
    const s = this.screen;
    if (!s) return;
    if (this.game.state === 'playing' && s.inGame) this.setScreen(null);
    else if (this.game.state === 'playing' && s instanceof OptionsScreen) this.showPauseMenu();
    else if (!(s instanceof LoadingScreen) && !(s instanceof TitleScreen)) this.showTitle();
  }

  showTitle() {
    this.setScreen(new TitleScreen(this));
  }

  openWorldList() {
    this.setScreen(new WorldListScreen(this));
  }

  openMultiplayer() {
    this.setScreen(new MultiplayerScreen(this));
  }

  /** Connect to the dedicated server as `name` and enter its world (loading screen meanwhile). */
  async startMultiplayer(name) {
    this.showLoading('正在连接服务器');
    const client = new MultiplayerClient(this.game, { name, renderDistance: this.game.settings?.renderDistance ?? 8 });
    try {
      await client.connect();
      this.setLoadingProgress(0, '正在进入世界…');
      await this.game.startRemoteWorld(client);
      if (this.game.state === 'playing' && this.screen instanceof LoadingScreen) {
        this.enterGame();
        const motd = client.welcome?.motd;
        if (motd) this.game.addChatMessage(`§6${motd}`);
        this.game.addChatMessage('§7按 T 聊天，按住 Tab 查看在线玩家');
      }
    } catch (err) {
      client.disconnect();
      if (this.game.remote === client) await this.game.quitToTitle({ discard: true }).catch(() => {});
      console.warn('[ui] multiplayer failed:', err);
      this.showMessage('无法进入服务器', String(err?.message ?? err), () => this.openMultiplayer());
    }
  }

  /** Loading screen with a title line; progress via setLoadingProgress(). */
  showLoading(text = '正在加载世界') {
    if (this.screen instanceof LoadingScreen) this.screen.setTitle(text);
    else this.setScreen(new LoadingScreen(this, text));
  }

  setLoadingProgress(fraction, text) {
    if (!(this.screen instanceof LoadingScreen)) {
      if (this.game.state === 'playing' && !this.screen) return; // late progress events after entering
      this.showLoading();
    }
    this.screen.setProgress(fraction, text);
  }

  /** World ready: close every screen, show the HUD and grab the pointer. */
  enterGame() {
    this.hud.reset();
    if (this.screen) this.setScreen(null);
    this.pendingEnable = true;
    this.requestLock();
  }

  /** Survival or creative inventory screen for the player's current mode. */
  createInventoryScreen() {
    return this.game.player.mode === 'creative' ? new CreativeScreen(this) : new InventoryScreen(this);
  }

  /** Pause menu (no-op while another screen is open — Escape closes that one first). */
  openPause() {
    if (this.game.state !== 'playing' || this.screen) return;
    this.setScreen(new PauseScreen(this));
  }

  /** Pause menu replacing the current screen (e.g. coming back from the options screen). */
  showPauseMenu() {
    if (this.game.state !== 'playing') return;
    this.setScreen(new PauseScreen(this));
  }

  /** Options screen. `back` defaults to the pause menu in game and the title screen otherwise. */
  openOptions(back, inGame) {
    const playing = this.game.state === 'playing';
    const ig = inGame ?? playing;
    this.setScreen(new OptionsScreen(this, back ?? (() => (playing ? this.showPauseMenu() : this.showTitle())), ig));
  }

  canOpenGameScreen() {
    const g = this.game;
    return g.state === 'playing' && !!g.player && !g.player.dead && !!g.player.inventory;
  }

  openInventory() {
    if (!this.canOpenGameScreen()) return;
    if (this.screen instanceof ContainerScreen) return;
    if (this.screen) return;
    this.setScreen(this.createInventoryScreen());
  }

  openCraftingTable() {
    if (!this.canOpenGameScreen()) return;
    if (this.screen instanceof CraftingScreen) return;
    this.setScreen(new CraftingScreen(this));
  }

  /**
   * Furnace screen of a furnace block entity (src/game/blockentities.js): input / fuel / output slots,
   * flame + arrow progress, live while the furnace ticks. Closes itself when the furnace is broken or
   * the player walks away (> 8 blocks).
   */
  openFurnace(blockEntity) {
    if (!this.canOpenGameScreen() || !blockEntity || blockEntity.removed || blockEntity.type !== 'furnace') return;
    if (this.screen instanceof FurnaceScreen && this.screen.blockEntity === blockEntity) return;
    this.setScreen(new FurnaceScreen(this, blockEntity));
  }

  /** Chest screen (27 slots) of a chest block entity; same lifetime rules as openFurnace. */
  openChest(blockEntity) {
    if (!this.canOpenGameScreen() || !blockEntity || blockEntity.removed || blockEntity.type !== 'chest') return;
    if (this.screen instanceof ChestScreen && this.screen.blockEntity === blockEntity) return;
    this.setScreen(new ChestScreen(this, blockEntity));
  }

  openChat(prefill = '') {
    if (this.game.state !== 'playing' || (this.screen && !(this.screen instanceof ChatScreen))) return;
    if (this.screen instanceof ChatScreen) return;
    this.setScreen(new ChatScreen(this, prefill));
  }

  openDeath(message = '') {
    // Multiplayer: "Alice爆炸了" like the chat line everyone else sees.
    const name = this.game.remote?.name;
    if (name && message.startsWith('玩家')) message = name + message.slice(2);
    if (this.screen instanceof DeathScreen) {
      this.screen.setMessage(message);
      return;
    }
    if (this.game.state !== 'playing') return;
    this.setScreen(new DeathScreen(this, message || deathMessage('generic', name || undefined)));
  }

  showMessage(title, message = '', onButton = null) {
    this.setScreen(new MessageScreen(this, { title, message, onButton }));
  }

  /** Start a world from the list / create screen (loading screen until game.startWorld resolves). */
  async startWorld(meta) {
    this.showLoading('正在加载世界');
    try {
      await this.game.startWorld(meta);
      if (this.game.state === 'playing' && this.screen instanceof LoadingScreen) this.enterGame();
    } catch (err) {
      console.warn('[ui] startWorld failed:', err);
      this.showMessage('无法加载世界', String(err?.message ?? err), () => this.openWorldList());
    }
  }

  /**
   * Pause/death menu: save and go back to the title screen. If saving fails the world stays open
   * (game.quitToTitle rejects with `saveFailed`) and a screen explains why, offering 重试 / 返回游戏 /
   * 不保存并退出 instead of pretending everything was saved. `discard` quits without saving.
   * @param {{ discard?: boolean }} [opts]
   */
  async saveAndQuit({ discard = false } = {}) {
    const title = this.game.remote ? '正在断开连接' : discard ? '正在退出世界' : '正在保存世界';
    this.setScreen(new MessageScreen(this, { title }));
    try {
      await this.game.quitToTitle?.(discard ? { discard: true } : undefined);
    } catch (err) {
      if (err?.saveFailed && this.game.world && this.game.state === 'playing') {
        // The game paused itself for the failed quit: leaving the screens later must resume it.
        if (this.game.paused) this.pausedByUI = true;
        this.setScreen(new SaveFailedScreen(this, err));
        return;
      }
      console.warn('[ui] quitToTitle failed:', err);
    }
    if (this.game.world && this.game.state === 'playing') return; // still in the world (cancelled)
    if (!(this.screen instanceof TitleScreen)) this.showTitle();
  }

  respawn() {
    const g = this.game;
    if (typeof g.respawn === 'function') g.respawn();
    else g.player?.respawn?.();
    this.enterGame();
  }

  // ------------------------------------------------------------------ settings / chat helpers
  /**
   * Apply one setting through game.applySettings (emits settingsChanged). If the game's validation
   * drops a string value (an older sanitizeSettings that only knows numbers / booleans discards the
   * 'difficulty' string), the live settings object is updated directly so the option still works.
   */
  applySetting(key, value) {
    const g = this.game;
    const hasApply = typeof g.applySettings === 'function';
    if (hasApply) g.applySettings({ [key]: value });
    if (!hasApply || (typeof value === 'string' && g.settings?.[key] !== value)) {
      const s = g.settings;
      if (s && !Object.isFrozen(s)) s[key] = value;
      else g.settings = { ...(s ?? {}), [key]: value }; // works for frozen defaults too
      if (hasApply) g.emit?.('settingsChanged', { [key]: value }, g.settings);
    }
    this.updateScale();
  }

  /** Post a chat line through the game (which emits 'chat' back to the UI). */
  postChat(text, color) {
    if (typeof this.game.addChatMessage === 'function') this.game.addChatMessage(text, color);
    else this.chatLog.add(text, color);
  }

  /** Add a line to the chat log directly (use when not routing through game events). */
  addChatMessage(text, color) {
    this.chatLog.add(text, color);
  }

  dropStack(stack) {
    if (!stack || stack.count <= 0) return;
    if (typeof this.game.dropFromPlayer === 'function') this.game.dropFromPlayer(stack);
  }

  // ------------------------------------------------------------------ HUD toggles
  toggleDebug() {
    this.debugVisible = !this.debugVisible;
  }

  toggleHud() {
    this.hudHidden = !this.hudHidden;
  }

  setHudHidden(hidden) {
    this.hudHidden = !!hidden;
  }

  showActionText(text, seconds) {
    this.hud.showActionText(text, seconds);
  }

  // ------------------------------------------------------------------ cursor stack / tooltip
  trackMouse(e) {
    this.mouse.x = e.clientX;
    this.mouse.y = e.clientY;
    if (this.cursorStack) this.positionCursor();
    if (this.tooltipShown) this.positionTooltip();
  }

  setCursorStack(stack) {
    this.cursorStack = stack && stack.count > 0 ? stack : null;
    if (!this.cursorStack) {
      this.cursorView.style.display = 'none';
      return;
    }
    setItemView(this.cursorView, this.cursorStack, this.icons);
    this.cursorView.style.display = '';
    this.positionCursor();
  }

  positionCursor() {
    const u = this.unit;
    this.cursorView.style.transform = `translate(${Math.round(this.mouse.x - 8 * u)}px, ${Math.round(this.mouse.y - 8 * u)}px)`;
  }

  /** Show a tooltip (lines: [{ text, color }]) next to the mouse. */
  showTooltip(lines) {
    fillTooltip(this.tooltipEl, lines);
    this.tooltipEl.style.display = '';
    this.tooltipShown = true;
    this.positionTooltip();
  }

  hideTooltip() {
    if (!this.tooltipShown) return;
    this.tooltipShown = false;
    this.tooltipEl.style.display = 'none';
  }

  positionTooltip() {
    const u = this.unit;
    const el = this.tooltipEl;
    const w = el.offsetWidth;
    const hgt = el.offsetHeight;
    let x = this.mouse.x + 12 * u - 3 * u;
    let y = this.mouse.y - 12 * u - 3 * u;
    if (x + w > window.innerWidth) x = this.mouse.x - 16 * u - w;
    if (y + hgt + 6 * u > window.innerHeight) y = window.innerHeight - hgt - 6 * u;
    if (y < 4 * u) y = 4 * u;
    el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  // ------------------------------------------------------------------ keyboard
  onKeyDown(e) {
    if (e.isComposing || e.keyCode === 229) return; // keys that belong to an IME composition
    const game = this.game;
    const screen = this.screen;
    const inField = isTextField(e.target);
    const playing = game.state === 'playing';
    if (playing && !inField && (e.code === 'F1' || e.code === 'F3' || e.code === 'F5')) e.preventDefault();
    if (screen) {
      if (e.code === 'Escape' || e.key === 'Escape') {
        e.preventDefault();
        // Chrome may deliver the Escape that released the pointer lock right after we opened the
        // pause menu for it; do not close the menu again.
        if (screen instanceof PauseScreen && performance.now() - this.lastLockLoss < 300) return;
        if (!screen.onEscape?.()) this.closeScreen();
        return;
      }
      if (inField) return;
      if (screen.onKeyDown?.(e)) {
        e.preventDefault();
        return;
      }
      if (screen instanceof ContainerScreen && e.code === 'KeyE' && !e.repeat) {
        e.preventDefault();
        this.closeScreen();
        return;
      }
      if (this.options.handleHudKeys && playing && screen.inGame) this.handleHudKey(e);
      return;
    }
    // Ctrl is the sprint key: E / T / "/" / Esc must still work while it is held (Minecraft ignores
    // modifiers for these bindings). Browser-reserved Ctrl shortcuts never reach the page anyway.
    if (!playing || inField || e.altKey || e.metaKey) return;
    if (!game.player || game.player.dead) return;
    if (e.repeat) return;
    if (e.code === 'Escape') {
      e.preventDefault();
      this.openPause();
    } else if (e.code === 'KeyE') {
      e.preventDefault();
      this.openInventory();
    } else if (e.code === 'KeyT') {
      e.preventDefault();
      this.openChat('');
    } else if (e.code === 'Slash' || e.code === 'NumpadDivide' || e.key === '/') {
      e.preventDefault();
      this.openChat('/');
    } else if (this.options.handleHudKeys) {
      this.handleHudKey(e);
    }
  }

  handleHudKey(e) {
    if (e.code === 'F1') {
      e.preventDefault();
      this.toggleHud();
    } else if (e.code === 'F3') {
      e.preventDefault();
      this.toggleDebug();
    }
  }

  // ------------------------------------------------------------------ per frame
  /** Call once per frame (before input.endFrame()). */
  update(dt) {
    const game = this.game;
    const input = game.input;
    const step = Math.max(0, Math.min(0.25, Number(dt) || 0));
    if (this.pendingEnable && !this.screen) {
      if (input) input.enabled = true;
      this.pendingEnable = false;
    }
    if (this.screen && input && input.enabled) input.enabled = false;
    const player = game.player;
    const playing = game.state === 'playing' && !!player;
    // Fallbacks when the game does not route death / respawn through events.
    if (playing && player.dead === true && !(this.screen instanceof DeathScreen)) {
      this.openDeath(deathTextFromArgs([player.deathMessage ?? player.deathCause ?? player.lastDamageCause ?? '']));
    }
    if (this.screen instanceof DeathScreen && playing && player.dead === false && this.screen.timer <= 0) this.enterGame();
    const hudVisible = playing && (!this.hudHidden || !!this.screen);
    this.hud.update(step, hudVisible);
    if (playing && player.sprinting && !this.ctrlHintShown && !this.screen) this.checkCtrlSprintHint(input);
    this.chatLog.update(this.screen instanceof ChatScreen);
    // Minecraft draws the crosshair (and the F3 gizmo replacing it) only in first person.
    const crosshair = playing && !this.hudHidden && !this.debugVisible && !player.dead &&
      (game.perspective ?? 0) === 0 && (!this.screen || this.screen.transparent);
    const cv = crosshair ? '' : 'none';
    if (this.crosshair.style.display !== cv) this.crosshair.style.display = cv;
    this.screen?.update?.(step);
  }

  /**
   * Browsers reserve Ctrl+W (close tab) — with Ctrl as the sprint key, sprinting and pressing W again can
   * close the game outside fullscreen. The first time the player sprints with Ctrl in a window, a chat
   * line suggests double-tapping W or fullscreen (once per session).
   */
  checkCtrlSprintHint(input) {
    if (this.automation || typeof input?.isKeyDown !== 'function') return;
    if (!input.isKeyDown('ControlLeft') && !input.isKeyDown('ControlRight')) return;
    if (typeof document !== 'undefined' && document.fullscreenElement) return;
    this.ctrlHintShown = true;
    this.postChat('§e提示：在浏览器窗口中按住 Ctrl 再按 W 会关闭网页！建议双击 W 疾跑，或在选项中切换到全屏。');
  }

  /** Remove listeners and DOM (tests / hot reload). */
  destroy() {
    for (const [target, type, fn, opts] of this.listeners) {
      if (target) target.removeEventListener(type, fn, opts);
      else this.game.off?.(type, fn);
    }
    this.listeners.length = 0;
    this.setScreen(null);
    this.root.textContent = '';
    this.root.classList.remove('mc-ui', 'screen-open');
  }
}

export { deathMessage };
