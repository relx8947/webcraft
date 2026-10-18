// Menu screens: title, world list, create world, confirm, options, about, loading, pause, death, the
// "could not save" screen and a generic message screen. Layouts follow Minecraft's GUI-pixel positions
// (height / 4 + n etc.).
import { h, gp, place, cx, fy, Button, Slider, TextField, label } from './dom.js';
import {
  renderFormatted, MODE_NAMES, WORLD_TYPE_NAMES, SPLASHES, formatDate, DIFFICULTY_NAMES, DIFFICULTY_ORDER,
} from './text.js';
import { measurePixelText } from './font.js';
import { paintLogo, paintSubtitle } from './logo.js';
import { BLOCK } from '../world/registry.js';
import { DEFAULT_SETTINGS } from '../config.js';
import { statusUrl, loadSavedName } from '../net/client.js';
import { validName } from '../net/protocol.js';

export const VERSION = 'WebCraft 1.1';

/** Shown on the title / world list / create screens while the browser storage is unusable. */
const STORAGE_WARNING = '§c浏览器禁止了本地存储：世界不会被保存，关闭页面后就会丢失';

/** True when the game's storage fell back to memory (IndexedDB blocked / unavailable). */
function storageBlocked(game) {
  return game?.storage?.persistent === false;
}

/** Base for menu screens. */
class MenuScreen {
  constructor(ui, name, { inGame = false, pausesGame = false, background } = {}) {
    this.ui = ui;
    this.game = ui.game;
    this.name = name;
    this.inGame = inGame;
    this.pausesGame = pausesGame;
    const bg = background ?? (inGame ? 'bg-dim' : 'bg-dirt');
    this.el = h('div', { className: `screen screen-${name} ${bg}` });
    this.buttons = [];
    this.storageWarn = null;
    this.storageShown = false;
  }

  onOpen() {}
  onClose() {}
  update() {
    this.updateStorageWarning();
  }

  /** A red line (hidden until the storage turns out to be unusable; storage opens asynchronously). */
  addStorageWarning(y) {
    this.storageWarn = this.text(STORAGE_WARNING, y, 'storage-warning');
    this.storageWarn.style.display = 'none';
    this.updateStorageWarning();
    return this.storageWarn;
  }

  updateStorageWarning() {
    if (!this.storageWarn) return;
    const show = storageBlocked(this.game);
    if (show === this.storageShown) return;
    this.storageShown = show;
    this.storageWarn.style.display = show ? '' : 'none';
    this.onStorageWarning?.(show);
  }
  /** Escape pressed: return true if handled. Default: go back if possible. */
  onEscape() {
    if (this.back) {
      this.back();
      return true;
    }
    return false;
  }
  onKeyDown() {
    return false;
  }

  /** Centred title text at y (GUI px). */
  title(text, y = 20, className = '') {
    const el = label(text, `screen-title ${className}`);
    place(el, { x: 0, y, w: '100%' });
    this.el.appendChild(el);
    return el;
  }

  /** Centred line of text. */
  text(text, y, className = '') {
    const el = label(text, `screen-text ${className}`);
    el.style.top = typeof y === 'number' ? gp(y) : y;
    this.el.appendChild(el);
    return el;
  }

  /** Button at (x, y) — numbers are GUI px, strings raw CSS (use cx()/fy()). */
  button(text, x, y, width, onClick, opts = {}) {
    const b = new Button({ label: text, width, onClick, ...opts });
    b.el.style.left = typeof x === 'number' ? gp(x) : x;
    b.el.style.top = typeof y === 'number' ? gp(y) : y;
    this.el.appendChild(b.el);
    this.buttons.push(b);
    return b;
  }
}

// ---------------------------------------------------------------------------------------------
// Title
// ---------------------------------------------------------------------------------------------
export class TitleScreen extends MenuScreen {
  constructor(ui) {
    super(ui, 'title');
    this.logoWrap = h('div', { className: 'title-logo' });
    this.el.appendChild(this.logoWrap);
    this.setLogo(ui.textures);

    const splash = SPLASHES[Math.floor(Math.random() * SPLASHES.length)];
    const k = (1.8 * 100) / (measurePixelText(splash) + 32);
    this.splash = h('div', { className: 'title-splash' });
    this.splash.style.setProperty('--k', k.toFixed(4));
    const inner = h('div', { className: 'mc-text title-splash-text', text: splash });
    this.splash.appendChild(inner);
    this.el.appendChild(this.splash);

    const j = 48;
    this.button('单人游戏', cx(-100), fy(1 / 4, j), 200, () => ui.openWorldList());
    this.mpBtn = this.button('多人游戏', cx(-100), fy(1 / 4, j + 24), 200, () => ui.openMultiplayer());
    this.button('关于 WebCraft', cx(-100), fy(1 / 4, j + 48), 98, () => ui.setScreen(new AboutScreen(ui, () => ui.showTitle())));
    // The online count on the multiplayer button (best effort: offline / file pages just say 多人游戏).
    fetchServerStatus().then((st) => {
      if (st && this.ui.screen === this) this.mpBtn.setLabel(`多人游戏（${st.online} 人在线）`);
    });
    this.button('选项...', cx(2), fy(1 / 4, j + 48), 98, () => ui.openOptions(() => ui.showTitle()));
    this.fullscreen = this.button(fullscreenLabel(), cx(-100), fy(1 / 4, j + 76), 200, () => toggleFullscreen());
    this.onFs = () => this.fullscreen.setLabel(fullscreenLabel());
    document.addEventListener('fullscreenchange', this.onFs);

    const ver = label(VERSION, 'title-version');
    this.el.appendChild(ver);
    const copy = label('非官方作品 · 与 Mojang 无关', 'title-copy');
    this.el.appendChild(copy);
    this.addStorageWarning(fy(1 / 4, j + 102));
  }

  setLogo(textures) {
    this.logoWrap.textContent = '';
    const logo = paintLogo(textures);
    logo.className = 'title-logo-canvas';
    logo.style.width = gp(logo.width);
    logo.style.height = gp(logo.height);
    logo.style.left = `calc(var(--g) * (var(--hw) - ${Math.floor(logo.width / 2)}))`;
    const sub = paintSubtitle('方块世界');
    sub.className = 'title-subtitle';
    sub.style.width = gp(sub.width);
    sub.style.height = gp(sub.height);
    sub.style.left = `calc(var(--g) * (var(--hw) - ${Math.floor(sub.width / 2)}))`;
    sub.style.top = gp(30 + logo.height - 6);
    this.logoWrap.append(logo, sub);
  }

  onTexturesReady(textures) {
    this.setLogo(textures);
  }

  onClose() {
    document.removeEventListener('fullscreenchange', this.onFs);
  }
}

function fullscreenLabel() {
  return document.fullscreenElement ? '退出全屏' : '全屏';
}

/**
 * Toggle fullscreen. In fullscreen the Keyboard Lock API (Chrome/Edge) is engaged so browser shortcuts
 * such as Ctrl+W (sprint + forward) reach the game instead of closing the tab; holding Esc still exits.
 */
function toggleFullscreen() {
  if (document.fullscreenElement) {
    navigator.keyboard?.unlock?.();
    document.exitFullscreen?.().catch(() => {});
    return;
  }
  const p = document.documentElement.requestFullscreen?.();
  if (p && typeof p.then === 'function') {
    p.then(() => navigator.keyboard?.lock?.()).then(null, () => {});
  }
}

/** GET the server's status ({ online, max, players, motd }) or null (no server next to this page). */
export async function fetchServerStatus() {
  const url = statusUrl();
  if (!url || location.protocol === 'file:') return null;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 4000);
    const res = await fetch(url, { cache: 'no-store', signal: ctl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const st = await res.json();
    return st && Number.isFinite(st.online) ? st : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Multiplayer
// ---------------------------------------------------------------------------------------------
export class MultiplayerScreen extends MenuScreen {
  constructor(ui) {
    super(ui, 'multiplayer');
    this.back = () => ui.showTitle();
    this.title('多人游戏', 20);
    this.status = this.text('§7正在查询服务器…', 44, 'mp-status');
    this.players = this.text('', 56, 'mp-players');
    this.text('你的名字', 78, 'field-label');
    this.nameField = new TextField({ width: 200, value: loadSavedName(), maxLength: 16, onEnter: () => this.join() });
    place(this.nameField.el, { x: cx(-100), y: 89 });
    this.el.appendChild(this.nameField.el);
    this.hint = this.text('§7汉字、字母、数字、下划线，最多 16 个字', 112, 'field-hint');
    this.text('§7名字会绑定到这个浏览器，别人不能冒用；世界里的东西所有人共享', 124, 'field-hint');
    this.joinBtn = this.button('加入游戏', cx(-155), fy(1, -28), 150, () => this.join());
    this.button('返回', cx(5), fy(1, -28), 150, () => this.back());
    this.refreshStatus();
  }

  onOpen() {
    this.nameField.focus();
  }

  async refreshStatus() {
    const st = await fetchServerStatus();
    if (this.ui.screen !== this) return;
    if (!st) {
      renderFormatted(this.status, '§c暂时连不上服务器，可以稍后再试');
      return;
    }
    renderFormatted(this.status, `§a服务器在线 §f${st.online} / ${st.max} 人${st.world ? ` · ${st.world}` : ''}`);
    const names = (st.players ?? []).slice(0, 8).join('、');
    renderFormatted(this.players, names ? `§7${names}${st.players.length > 8 ? ' 等' : ''}` : (st.motd ? `§7${st.motd}` : ''));
  }

  join() {
    const name = this.nameField.value.trim();
    if (!validName(name)) {
      renderFormatted(this.hint, '§c名字只能包含 1-16 个汉字、字母、数字、下划线或减号');
      this.nameField.focus();
      return;
    }
    this.ui.startMultiplayer(name);
  }
}

// ---------------------------------------------------------------------------------------------
// World list
// ---------------------------------------------------------------------------------------------
export class WorldListScreen extends MenuScreen {
  constructor(ui) {
    super(ui, 'worlds');
    this.back = () => ui.showTitle();
    this.title('选择世界', 16);
    this.list = h('div', { className: 'list-area' });
    this.list.style.top = gp(32);
    this.list.style.bottom = gp(64);
    this.inner = h('div', { className: 'list-inner' });
    this.list.appendChild(this.inner);
    this.el.appendChild(this.list);
    this.status = label('正在读取世界列表…', 'list-status');
    this.list.appendChild(this.status);
    this.worlds = [];
    this.selected = -1;
    this.entries = [];

    this.playBtn = this.button('进入选中的世界', cx(-154), fy(1, -52), 150, () => this.play(), { disabled: true });
    this.button('创建新的世界', cx(4), fy(1, -52), 150, () => ui.setScreen(new CreateWorldScreen(ui)));
    this.deleteBtn = this.button('删除', cx(-154), fy(1, -28), 150, () => this.confirmDelete(), { disabled: true });
    this.button('取消', cx(4), fy(1, -28), 150, () => this.back());
    this.addStorageWarning(29);
  }

  /** Make room for the storage warning line between the title and the list. */
  onStorageWarning(show) {
    this.list.style.top = gp(show ? 41 : 32);
  }

  async onOpen() {
    try {
      const worlds = typeof this.game.listWorlds === 'function' ? await this.game.listWorlds() : [];
      this.worlds = Array.isArray(worlds) ? worlds : [];
    } catch (err) {
      console.warn('[ui] listWorlds failed:', err);
      this.worlds = [];
      renderFormatted(this.status, `§c无法读取世界列表：${err?.message ?? err}`);
      return;
    }
    this.renderList();
  }

  renderList() {
    this.inner.textContent = '';
    this.entries = [];
    this.status.style.display = this.worlds.length ? 'none' : '';
    if (!this.worlds.length) renderFormatted(this.status, '§7还没有世界。点击“创建新的世界”开始冒险吧！');
    this.worlds.forEach((w, i) => {
      const entry = h('div', { className: 'world-entry' });
      const icon = h('div', { className: 'world-icon' });
      const img = h('img', { alt: '', draggable: 'false' });
      const iconId = w.worldType === 'flat' ? BLOCK.GRASS_BLOCK : w.mode === 'creative' ? BLOCK.CRAFTING_TABLE : BLOCK.GRASS_BLOCK;
      img.src = this.ui.icons.getIcon(iconId);
      const play = h('div', { className: 'world-play' });
      icon.append(img, play);
      const texts = h('div', { className: 'world-texts' });
      const name = label(w.name || '新的世界', 'world-name');
      const line2 = label(`§7${formatDate(w.lastPlayed)}${w.seedText ? ` · 种子：${w.seedText}` : ''}`, 'world-line');
      const typeName = WORLD_TYPE_NAMES[w.worldType] ?? '默认';
      const unsaved = storageBlocked(this.game) ? ' §c（不会保存）' : '';
      const line3 = label(`§7${MODE_NAMES[w.mode] ?? '生存模式'}${w.worldType === 'flat' ? `，${typeName}` : ''}${unsaved}`, 'world-line');
      texts.append(name, line2, line3);
      entry.append(icon, texts);
      entry.addEventListener('mousedown', (e) => e.preventDefault());
      entry.addEventListener('click', (e) => {
        if (e.target.closest('.world-icon')) {
          this.select(i);
          this.play();
          return;
        }
        if (this.selected === i && e.detail >= 2) this.play();
        else this.select(i);
      });
      this.inner.appendChild(entry);
      this.entries.push(entry);
    });
    this.select(this.worlds.length ? 0 : -1);
  }

  select(i) {
    this.selected = i;
    this.entries.forEach((e, k) => e.classList.toggle('selected', k === i));
    this.playBtn.setDisabled(i < 0);
    this.deleteBtn.setDisabled(i < 0);
    // scroll only the list itself (scrollIntoView could also scroll overflow:hidden ancestors)
    const el = this.entries[i];
    if (el) {
      const top = el.offsetTop;
      const bottom = top + el.offsetHeight;
      const box = this.inner;
      if (top < box.scrollTop) box.scrollTop = top;
      else if (bottom > box.scrollTop + box.clientHeight) box.scrollTop = bottom - box.clientHeight;
    }
  }

  play() {
    const w = this.worlds[this.selected];
    if (w) this.ui.startWorld(w);
  }

  confirmDelete() {
    const w = this.worlds[this.selected];
    if (!w) return;
    const ui = this.ui;
    ui.setScreen(new ConfirmScreen(ui, {
      title: '你确定要删除这个世界吗？',
      message: `“${w.name}”将会永久失去！（真的很久！）`,
      yes: '删除',
      no: '取消',
      onYes: async () => {
        try {
          if (typeof this.game.deleteWorld === 'function') await this.game.deleteWorld(w.id);
        } catch (err) {
          console.warn('[ui] deleteWorld failed:', err);
        }
        ui.openWorldList();
      },
      onNo: () => ui.openWorldList(),
    }));
  }

  onKeyDown(e) {
    if (!this.worlds.length) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const d = e.key === 'ArrowDown' ? 1 : -1;
      this.select(Math.max(0, Math.min(this.worlds.length - 1, this.selected + d)));
      return true;
    }
    if (e.key === 'Enter') {
      this.play();
      return true;
    }
    if (e.key === 'Delete') {
      this.confirmDelete();
      return true;
    }
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Create world
// ---------------------------------------------------------------------------------------------
const MODE_DESCRIPTIONS = {
  survival: ['寻找资源、合成物品、建造家园，', '注意你的生命值和饥饿值'],
  creative: ['无限的资源、自由飞翔，', '并且能够瞬间破坏方块'],
};
const TYPE_DESCRIPTIONS = {
  default: '包含山脉、森林、海洋与洞穴的自然世界',
  flat: '一片完全平坦的草地，适合自由建造',
};

export class CreateWorldScreen extends MenuScreen {
  constructor(ui) {
    super(ui, 'create');
    this.back = () => ui.openWorldList();
    this.mode = 'survival';
    this.worldType = 'default';
    this.title('创建新的世界', 15);

    this.text('世界名称', 36, 'field-label');
    this.nameField = new TextField({ width: 200, value: '新的世界', maxLength: 32, onEnter: () => this.create() });
    place(this.nameField.el, { x: cx(-100), y: 47 });
    this.el.appendChild(this.nameField.el);

    this.text('世界生成器的种子', 74, 'field-label');
    this.seedField = new TextField({ width: 200, value: '', maxLength: 32, onEnter: () => this.create() });
    place(this.seedField.el, { x: cx(-100), y: 85 });
    this.el.appendChild(this.seedField.el);
    this.text('留空以生成随机种子', 108, 'field-hint');

    this.modeBtn = this.button('', cx(-155), 124, 150, () => {
      this.mode = this.mode === 'survival' ? 'creative' : 'survival';
      this.refresh();
    });
    this.typeBtn = this.button('', cx(5), 124, 150, () => {
      this.worldType = this.worldType === 'default' ? 'flat' : 'default';
      this.refresh();
    });
    this.desc1 = this.text('', 149, 'desc');
    this.desc2 = this.text('', 159, 'desc');
    this.desc3 = this.text('', 173, 'desc desc-type');

    this.createBtn = this.button('创建新的世界', cx(-155), fy(1, -28), 150, () => this.create());
    this.button('取消', cx(5), fy(1, -28), 150, () => this.back());
    this.addStorageWarning(188);
    this.refresh();
  }

  refresh() {
    this.modeBtn.setLabel(`游戏模式：${this.mode === 'survival' ? '生存' : '创造'}`);
    this.typeBtn.setLabel(`世界类型：${WORLD_TYPE_NAMES[this.worldType]}`);
    const [a, b] = MODE_DESCRIPTIONS[this.mode];
    renderFormatted(this.desc1, a);
    renderFormatted(this.desc2, b);
    renderFormatted(this.desc3, TYPE_DESCRIPTIONS[this.worldType]);
  }

  onOpen() {
    this.nameField.focus();
  }

  async create() {
    if (this.busy) return;
    this.busy = true;
    this.createBtn.setDisabled(true);
    const name = this.nameField.value.trim() || '新的世界';
    const seedText = this.seedField.value.trim();
    try {
      const meta = await this.game.createWorld({ name, seedText, mode: this.mode, worldType: this.worldType });
      this.ui.startWorld(meta);
    } catch (err) {
      console.warn('[ui] createWorld failed:', err);
      this.ui.showMessage('无法创建世界', String(err?.message ?? err), () => this.ui.openWorldList());
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Confirm / message
// ---------------------------------------------------------------------------------------------
export class ConfirmScreen extends MenuScreen {
  constructor(ui, { title, message, yes = '是', no = '否', onYes, onNo, inGame = false }) {
    super(ui, 'confirm', { inGame, pausesGame: inGame });
    this.back = onNo;
    this.title(title, 70);
    this.text(message, 90, 'confirm-message');
    this.button(yes, cx(-155), fy(1 / 6, 96), 150, () => onYes());
    this.button(no, cx(5), fy(1 / 6, 96), 150, () => onNo());
  }
}

export class MessageScreen extends MenuScreen {
  constructor(ui, { title, message = '', button = '返回', onButton = null, inGame = false }) {
    super(ui, 'message', { inGame });
    this.title(title, 0, 'message-title').style.top = fy(1 / 2, -30);
    if (message) this.text(`§7${message}`, fy(1 / 2, -12), 'message-text');
    if (onButton) {
      this.back = onButton;
      this.button(button, cx(-100), fy(1 / 2, 20), 200, onButton);
    }
  }

  /** Without a button (e.g. "正在保存世界") the screen cannot be dismissed. */
  onEscape() {
    if (this.back) this.back();
    return true;
  }
}

// ---------------------------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------------------------
const onOff = (v) => (v ? '开' : '关');
/** settings.guiScale range accepted by the game's settings validation (0 = auto). */
const GUI_SCALE_SETTING_MAX = 8;

export class OptionsScreen extends MenuScreen {
  /**
   * @param {object} ui
   * @param {() => void} back   called by "完成" / Escape
   * @param {boolean} inGame    opened from the pause menu
   */
  constructor(ui, back, inGame = false) {
    super(ui, 'options', { inGame, pausesGame: inGame });
    this.back = back;
    this.title('选项', 15);
    const s = () => ({ ...DEFAULT_SETTINGS, ...(this.game.settings ?? {}) });
    const set = (key, value) => ui.applySetting(key, value);
    const controls = [
      new Slider({
        min: 30, max: 110, value: s().fov,
        format: (v) => `视场角：${v === 110 ? 'Quake Pro' : v}`,
        onInput: (v) => set('fov', v),
      }),
      new Slider({
        min: 2, max: 16, value: s().renderDistance,
        format: (v) => `渲染距离：${v} 区块`,
        onChange: (v) => set('renderDistance', v),
      }),
      new Slider({
        min: 0.1, max: 2, step: 0.05, value: s().mouseSensitivity,
        format: (v) => `鼠标灵敏度：${v <= 0.1 ? '*哈欠*' : v >= 2 ? '超高速！！！' : Math.round(v * 100) + '%'}`,
        onInput: (v) => set('mouseSensitivity', v),
      }),
      this.toggle('invertY', '反转鼠标'),
      this.toggle('viewBobbing', '视角摇晃'),
      this.toggle('smoothLighting', '平滑光照'),
      this.toggle('clouds', '云'),
      this.toggle('showFps', '显示帧率'),
      new Slider({
        min: 0, max: 1, step: 0.01, value: s().soundVolume,
        format: (v) => `音效：${v <= 0 ? '关' : Math.round(v * 100) + '%'}`,
        onInput: (v) => set('soundVolume', v),
      }),
      new Slider({
        min: 0, max: 1, step: 0.01, value: s().musicVolume,
        format: (v) => `音乐：${v <= 0 ? '关' : Math.round(v * 100) + '%'}`,
        onInput: (v) => set('musicVolume', v),
      }),
      new Button({
        label: '', width: 150,
        onClick: () => {
          // Minecraft: Auto, then 1..(largest scale the window allows); the label shows the size in use.
          const max = this.guiScaleMax();
          const cur = Math.min(s().guiScale | 0, max);
          set('guiScale', (cur + 1) % (max + 1));
          this.refresh();
        },
      }),
      new Button({ label: '', width: 150, onClick: () => toggleFullscreen() }),
      // Minecraft's difficulty button: 和平 -> 简单 -> 普通 -> 困难 -> 和平 (settings.difficulty)
      new Button({
        label: '', width: 150,
        onClick: () => {
          const cur = DIFFICULTY_ORDER.indexOf(s().difficulty);
          set('difficulty', DIFFICULTY_ORDER[(Math.max(0, cur) + 1) % DIFFICULTY_ORDER.length]);
          this.refresh();
        },
      }),
      // Minecraft's brightness (gamma) slider: 昏暗 (Moody) .. 默认 .. 明亮 (Bright), applied live.
      // (The controls list moved to the pause menu: 7 rows is all a 240-GUI-px-high window can show.)
      new Slider({
        min: 0, max: 1, step: 0.01, value: s().brightness ?? 0.5,
        format: (v) => `亮度：${v <= 0 ? '昏暗' : v >= 1 ? '明亮' : Math.abs(v - 0.5) < 0.005 ? '默认' : '+' + Math.round(v * 100) + '%'}`,
        onInput: (v) => set('brightness', v),
      }),
    ];
    this.guiBtn = controls[10];
    this.fsBtn = controls[11];
    this.difficultyBtn = controls[12];
    this.controls = controls;
    controls.forEach((c, i) => {
      c.el.style.left = cx(-155 + (i % 2) * 160);
      c.el.style.top = fy(1 / 6, -12 + 24 * Math.floor(i / 2));
      this.el.appendChild(c.el);
    });
    this.brightnessSlider = controls[13];
    this.button('完成', cx(-100), fy(1 / 6, 168), 200, () => this.back());
    this.onFs = () => this.refresh();
    document.addEventListener('fullscreenchange', this.onFs);
    this.refresh();
  }

  toggle(key, name) {
    const b = new Button({
      label: '', width: 150,
      onClick: () => {
        const v = !({ ...DEFAULT_SETTINGS, ...(this.game.settings ?? {}) })[key];
        this.ui.applySetting(key, v);
        b.setLabel(`${name}：${onOff(v)}`);
      },
    });
    b.setLabel(`${name}：${onOff(({ ...DEFAULT_SETTINGS, ...(this.game.settings ?? {}) })[key])}`);
    return b;
  }

  /** Highest selectable GUI scale: the window's maximum, capped at the settings limit (4). */
  guiScaleMax() {
    return Math.max(1, Math.min(GUI_SCALE_SETTING_MAX, this.ui.maxScale ?? GUI_SCALE_SETTING_MAX));
  }

  /** Relabel when the window size changes the largest usable GUI scale. */
  update() {
    super.update();
    if (this.ui.maxScale !== this.shownMaxScale) this.refresh();
  }

  refresh() {
    this.shownMaxScale = this.ui.maxScale;
    const gs = Math.min((this.game.settings?.guiScale ?? 0) | 0, this.guiScaleMax());
    this.guiBtn.setLabel(`界面尺寸：${gs === 0 ? '自动' : gs}`);
    this.fsBtn.setLabel(`全屏：${onOff(!!document.fullscreenElement)}`);
    const d = this.game.settings?.difficulty ?? DEFAULT_SETTINGS.difficulty;
    this.difficultyBtn.setLabel(`难度：${DIFFICULTY_NAMES[d] ?? DIFFICULTY_NAMES.normal}`);
  }

  onClose() {
    document.removeEventListener('fullscreenchange', this.onFs);
  }
}

// ---------------------------------------------------------------------------------------------
// About
// ---------------------------------------------------------------------------------------------
const CONTROLS = [
  ['W A S D', '移动'], ['空格', '跳跃 / 游泳上浮'], ['左 Shift', '潜行'], ['双击 W / 左 Ctrl', '疾跑'],
  ['鼠标左键', '破坏方块 / 攻击'], ['鼠标右键', '放置 / 使用 / 进食 / 拉弓'], ['鼠标中键', '选取方块'], ['滚轮 / 1-9', '选择物品栏'],
  ['E', '物品栏'], ['Q', '丢弃物品'], ['T', '聊天'], ['/', '输入命令'],
  ['F1', '隐藏界面'], ['F3', '调试信息'], ['F5', '切换视角'], ['双击空格', '飞行（创造模式）'],
  ['Shift + 点击', '快速移动物品'], ['Esc', '暂停 / 关闭界面'],
];

export class AboutScreen extends MenuScreen {
  /**
   * @param {object} ui
   * @param {() => void} back
   * @param {boolean} [inGame] opened from the in-game options (dim background, keeps the game paused)
   */
  constructor(ui, back, inGame = false) {
    super(ui, 'about', { inGame, pausesGame: inGame });
    this.back = back;
    this.title('关于 WebCraft', 16);
    const area = h('div', { className: 'list-area about-area' });
    area.style.top = gp(32);
    area.style.bottom = gp(40);
    const body = h('div', { className: 'about-body' });
    body.append(
      label('WebCraft（方块世界）是一个运行在浏览器中的方块沙盒游戏。', 'about-p'),
      label('§7纯 JavaScript ES 模块 + WebGL2 编写，零依赖、无需构建；所有纹理、声音与音乐均由程序实时生成。', 'about-p'),
      label('§7这是一个致敬《我的世界》的同人作品，与 Mojang Studios 和 Microsoft 无关。', 'about-p'),
      label('§e操作说明', 'about-h'),
    );
    const table = h('div', { className: 'about-controls' });
    for (const [k, v] of CONTROLS) table.append(label(`§e${k}`, 'about-key'), label(v, 'about-val'));
    body.append(table, label('§7在聊天栏中输入 /help 查看全部命令。', 'about-p'));
    area.appendChild(body);
    this.el.appendChild(area);
    this.button('完成', cx(-100), fy(1, -30), 200, () => this.back());
  }
}

// ---------------------------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------------------------
const TIPS = [
  '按 F3 可以查看坐标和调试信息。',
  '在物品栏中按住 Shift 点击可以快速移动物品。',
  '双击物品栏中的物品可以把同类物品收集到一起。',
  '按住鼠标左键拖动可以把物品平均分配到多个格子里。',
  '用工作台可以合成 3×3 的配方。',
  '火把可以照亮洞穴。',
  '在聊天栏输入 /help 查看所有命令。',
  '创造模式下双击空格键可以飞行。',
  '鼠标中键可以选取你看着的方块。',
  '按 F1 可以隐藏界面来截图。',
  '疾跑推荐双击 W：在浏览器中 Ctrl+W 可能会关闭标签页（全屏模式下不会）。',
  '选项中可以调整渲染距离、视场角、界面尺寸和难度。',
  '熔炉需要燃料：一块煤炭可以烧炼 8 个物品。',
  '把铁矿石放进熔炉烧炼，就能得到铁锭。',
  '用锄头开垦泥土，再种下小麦种子；靠近水的耕地长得更快。',
  '三个小麦可以合成一个面包。',
  '夜晚和黑暗的洞穴里会生成怪物，记得多放火把！',
  '听到嘶嘶声就快跑——苦力怕要爆炸了！',
  '饥饿值不足 7 格时无法疾跑；饿极了还会掉血。',
  '箱子上方压着方块时打不开。',
  '在箱子和熔炉中按住 Shift 点击，可以把物品快速移进或移出。',
  '弓需要箭才能射击，按住右键蓄力，满弓伤害最高。',
];

export class LoadingScreen extends MenuScreen {
  constructor(ui, text = '正在加载世界') {
    super(ui, 'loading');
    this.titleEl = this.text(text, fy(1 / 2, -34), 'loading-title');
    this.statusEl = this.text('', fy(1 / 2, -14), 'loading-status');
    this.bar = h('div', { className: 'loading-bar' });
    this.fill = h('div', { className: 'loading-fill' });
    this.bar.appendChild(this.fill);
    place(this.bar, { x: cx(-91), y: fy(1 / 2, 2), w: 182, hgt: 5 });
    this.el.appendChild(this.bar);
    const tip = TIPS[Math.floor(Math.random() * TIPS.length)];
    this.text(`§7提示：${tip}`, fy(1, -20), 'loading-tip');
    this.setProgress(0, '');
  }

  setTitle(text) {
    renderFormatted(this.titleEl, text);
  }

  setProgress(fraction, text) {
    const f = Math.max(0, Math.min(1, Number(fraction) || 0));
    this.fill.style.width = `${(f * 100).toFixed(1)}%`;
    if (text !== undefined && text !== null) renderFormatted(this.statusEl, text ? `§7${text}` : '');
  }

  onEscape() {
    return true; // cannot leave while loading
  }
}

// ---------------------------------------------------------------------------------------------
// Pause
// ---------------------------------------------------------------------------------------------
export class PauseScreen extends MenuScreen {
  constructor(ui) {
    super(ui, 'pause', { inGame: true, pausesGame: true });
    this.title('游戏菜单', 40);
    this.button('回到游戏', cx(-100), fy(1 / 4, 8), 200, () => ui.closeScreen());
    this.button('选项...', cx(-100), fy(1 / 4, 32), 200, () => ui.openOptions(() => ui.showPauseMenu(), true));
    this.button('操作说明...', cx(-100), fy(1 / 4, 56), 200,
      () => ui.setScreen(new AboutScreen(ui, () => ui.showPauseMenu(), true)));
    this.quitBtn = this.button(ui.game.remote ? '断开连接' : '保存并退出到标题画面', cx(-100), fy(1 / 4, 80), 200,
      () => ui.saveAndQuit());
  }

  onEscape() {
    this.ui.closeScreen();
    return true;
  }
}

// ---------------------------------------------------------------------------------------------
// Saving failed (save & quit): the world is still open, nothing is lost yet
// ---------------------------------------------------------------------------------------------
export class SaveFailedScreen extends MenuScreen {
  /**
   * @param {object} ui
   * @param {Error} err  rejection of game.quitToTitle() (`saveFailed`, message "无法保存世界：<reason>")
   */
  constructor(ui, err) {
    super(ui, 'save-failed', { inGame: true, pausesGame: true });
    const reason = String(err?.message ?? err ?? '').replace(/^无法保存世界[：:]\s*/, '') || '未知错误';
    this.title('无法保存世界', 0, 'save-failed-title').style.top = fy(1 / 4, 0);
    this.text(`§7${reason}`, fy(1 / 4, 20), 'save-failed-reason');
    this.text('§7世界仍然开着，进度没有丢失。可以重试，或者返回游戏稍后再保存。', fy(1 / 4, 34), 'save-failed-hint');
    this.button('重试', cx(-100), fy(1 / 4, 56), 200, () => ui.saveAndQuit());
    this.button('返回游戏', cx(-100), fy(1 / 4, 80), 200, () => ui.closeScreen());
    this.button('§c不保存并退出', cx(-100), fy(1 / 4, 116), 200, () => {
      ui.setScreen(new ConfirmScreen(ui, {
        title: '你确定要不保存就退出吗？',
        message: '自上次保存以来的进度将会永久丢失！',
        yes: '不保存并退出',
        no: '取消',
        inGame: true,
        onYes: () => ui.saveAndQuit({ discard: true }),
        onNo: () => ui.setScreen(new SaveFailedScreen(ui, err)),
      }));
    });
  }

  /** Escape: back to the pause menu (the world stays open). */
  onEscape() {
    this.ui.showPauseMenu();
    return true;
  }
}

// ---------------------------------------------------------------------------------------------
// Death
// ---------------------------------------------------------------------------------------------
export class DeathScreen extends MenuScreen {
  constructor(ui, message = '') {
    super(ui, 'death', { inGame: true, background: 'bg-death' });
    this.title('你死了！', 0, 'death-title').style.top = gp(52);
    this.msg = this.text(message || '', 85, 'death-message');
    this.respawnBtn = this.button('重生', cx(-100), fy(1 / 4, 72), 200, () => ui.respawn(), { disabled: true });
    this.titleBtn = this.button('返回标题画面', cx(-100), fy(1 / 4, 96), 200, () => ui.saveAndQuit(), { disabled: true });
    this.timer = 1;
  }

  setMessage(message) {
    if (message) renderFormatted(this.msg, message);
  }

  update(dt) {
    if (this.timer > 0) {
      this.timer -= dt;
      if (this.timer <= 0) {
        this.respawnBtn.setDisabled(false);
        this.titleBtn.setDisabled(false);
      }
    }
  }

  onEscape() {
    return true;
  }
}
