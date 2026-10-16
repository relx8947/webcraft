// In-game HUD: hotbar with selection, item-name toast, action bar, hearts (flash on damage, shake when
// low, green while poisoned), food (shakes when saturation is 0, green while the Hunger effect lasts),
// air bubbles, red damage flash, light-dependent vignette, F3 debug overlay (+ axis gizmo in place of
// the crosshair), optional FPS counter and a "click to play" hint when the pointer is not locked. All
// positions follow Minecraft's GUI-pixel layout.
// update() runs every frame, so it is diffed and allocation-free on the steady path: icon states are
// small integer codes mapped to precomputed CSS strings, opacities are quantised to 1/100 steps.
import { h, gp } from './dom.js';
import { createItemView, setItemView } from './itemview.js';
import { getItem, BLOCKS } from '../world/registry.js';

const TICK = 0.05;

/** Precomputed opacity strings 0.00 .. 1.00. */
const OPACITY = Array.from({ length: 101 }, (_, i) => (i === 100 ? '1' : (i / 100).toFixed(2)));
const q100 = (v) => Math.max(0, Math.min(100, Math.round(v * 100)));

// Heart backgrounds by index = fill (0 none, 1 half, 2 full) + 3 * flashFill (0..2) + 9 * highlight
// + 18 * poisoned (Minecraft heart_poisoned_* sprites while the Poison effect lasts).
const HEART_VARIANTS = 36;
const HEART_BG = [];
for (let code = 0; code < HEART_VARIANTS; code++) {
  const fill = code % 3;
  const flash = Math.floor(code / 3) % 3;
  const hl = Math.floor(code / 9) % 2 === 1;
  const p = code >= 18 ? 'heart-poison' : 'heart';
  const layers = [];
  if (fill === 2) layers.push(`var(--img-${p}-full)`);
  else if (fill === 1) layers.push(`var(--img-${p}-half)`);
  if (flash === 2) layers.push(`var(--img-${p}-flash-full)`);
  else if (flash === 1) layers.push(`var(--img-${p}-flash-half)`);
  layers.push(hl ? 'var(--img-heart-container-flash)' : 'var(--img-heart-container)');
  HEART_BG.push(layers.join(', '));
}
// Food backgrounds by index = fill (0..2) + 3 * hungerEffect (Minecraft food_*_hunger sprites).
const FOOD_VARIANTS = 6;
const FOOD_BG = [
  'var(--img-food-empty)', 'var(--img-food-half), var(--img-food-empty)', 'var(--img-food-full), var(--img-food-empty)',
  'var(--img-food-hunger-empty)', 'var(--img-food-hunger-half), var(--img-food-hunger-empty)',
  'var(--img-food-hunger-full), var(--img-food-hunger-empty)',
];
const BUBBLE_BG = ['none', 'var(--img-bubble-pop)', 'var(--img-bubble)'];
const SHIFT_Y = { '-1': `translateY(${gp(-1)})`, 0: '', 1: `translateY(${gp(1)})` };

/**
 * Readable GPU name for the F3 screen: ANGLE strings such as
 * "ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 (0x00002786) Direct3D11 vs_5_0 ps_5_0, D3D11)" become
 * "NVIDIA GeForce RTX 4070"; other strings are returned unchanged.
 */
export function shortGpuName(name) {
  let s = String(name ?? '').trim();
  const m = /^ANGLE \((.*)\)$/.exec(s);
  if (m) {
    const parts = m[1].split(', ');        // ANGLE (vendor, renderer, driver)
    s = parts.length >= 2 ? parts[1] : parts[0];
  }
  return s.replace(/\s*\(0x[0-9a-f]+\)/gi, '').replace(/\s+(?:Direct3D|D3D)\d+.*$/i, '').trim();
}

/** 0 = empty, 1 = half, 2 = full for icon i of a 0..20 value. */
function fillCode(i, value) {
  const v = i * 2 + 1;
  return v < value ? 2 : v === value ? 1 : 0;
}

export class Hud {
  constructor(ui) {
    this.ui = ui;
    this.game = ui.game;
    this.el = h('div', { className: 'hud' });

    this.vignette = h('div', { className: 'hud-vignette' });
    this.damageFlash = h('div', { className: 'hud-damage' });
    this.el.append(this.vignette, this.damageFlash);

    // --- hotbar
    this.hotbar = h('div', { className: 'hotbar' });
    this.hotbarSel = h('div', { className: 'hotbar-select' });
    this.hotbarViews = [];
    for (let i = 0; i < 9; i++) {
      const v = createItemView();
      v.style.left = gp(3 + i * 20);
      v.style.top = gp(3);
      this.hotbar.appendChild(v);
      this.hotbarViews.push(v);
    }
    this.hotbar.appendChild(this.hotbarSel);

    // --- status bars
    this.bars = h('div', { className: 'hud-bars' });
    this.hearts = [];
    this.foods = [];
    this.bubbles = [];
    for (let i = 0; i < 10; i++) {
      const heart = h('div', { className: 'hud-icon heart' });
      heart.style.left = gp(i * 8);
      this.hearts.push(heart);
      const food = h('div', { className: 'hud-icon food' });
      food.style.left = gp(182 - 9 - i * 8);
      this.foods.push(food);
      const bubble = h('div', { className: 'hud-icon bubble' });
      bubble.style.left = gp(182 - 9 - i * 8);
      this.bubbles.push(bubble);
    }
    this.heartRow = h('div', { className: 'hud-row hud-hearts' }, this.hearts);
    this.foodRow = h('div', { className: 'hud-row hud-food' }, this.foods);
    this.airRow = h('div', { className: 'hud-row hud-air' }, this.bubbles);
    this.bars.append(this.heartRow, this.foodRow, this.airRow);

    // --- texts
    this.itemName = h('div', { className: 'mc-text hud-item-name' });
    this.actionText = h('div', { className: 'mc-text hud-action' });
    this.fpsEl = h('div', { className: 'mc-text hud-fps' });
    this.lockHint = h('div', { className: 'hud-lock-hint' }, h('span', { className: 'mc-text', text: '点击屏幕以继续游戏' }));

    // --- F3
    this.debug = h('div', { className: 'debug' });
    this.debugLeft = h('div', { className: 'debug-col debug-left' });
    this.debugRight = h('div', { className: 'debug-col debug-right' });
    this.debug.append(this.debugLeft, this.debugRight);
    this.gizmo = h('canvas', { className: 'debug-gizmo', width: '64', height: '64' });
    this.gizmoAxes = [
      { x: 0, y: 0, z: 0, color: '#FF3030' },
      { x: 0, y: 0, z: 0, color: '#30FF30' },
      { x: 0, y: 0, z: 0, color: '#3060FF' },
    ];
    this.gizmoOrder = [0, 1, 2];

    this.el.append(this.bars, this.hotbar, this.itemName, this.actionText, this.debug, this.gizmo, this.fpsEl, this.lockHint);

    // --- state (all numeric; DOM writes only on change)
    this.ticks = 0;
    this.tickAcc = 0;
    this.rand = 0x2f6b9a1;
    this.invVersion = -1;
    this.selected = -1;
    this.selectedId = -1;
    this.nameTime = 0;
    this.actionTime = 0;
    this.lastHealth = -1;
    this.shownHealth = 0;
    this.healthUpdateTicks = 0;
    this.lastHealthChange = 0;
    this.damageTime = 0;
    this.darkness = 0;
    this.heartCodes = new Int8Array(10).fill(-1);
    this.foodCodes = new Int8Array(10).fill(-1);
    this.bubbleCodes = new Int8Array(10).fill(-1);
    this.heartShake = new Int8Array(10);
    this.foodShake = new Int8Array(10);
    this.op = { name: -1, action: -1, damage: -1, vignette: -1 };
    this.shown = { air: null, debug: null, fps: null, hint: null, crosshair: null };
    this.fpsValue = -1;
    this.lockSince = 0;
    this.mode = null;
    this.gpuName = null;
    this.debugAcc = 1;
  }

  /** Deterministic per-tick randomness (heart shake, food jitter). */
  random() {
    this.rand ^= this.rand << 13;
    this.rand ^= this.rand >>> 17;
    this.rand ^= this.rand << 5;
    return (this.rand >>> 0) / 4294967296;
  }

  showActionText(text, seconds = 3) {
    this.actionText.textContent = text;
    this.actionTime = seconds;
  }

  /** Reset per-world state (new world / respawn). */
  reset() {
    this.invVersion = -1;
    this.selected = -1;
    this.selectedId = -1;
    this.lastHealth = -1;
    this.damageTime = 0;
    this.nameTime = 0;
    this.heartCodes.fill(-1);
    this.foodCodes.fill(-1);
    this.bubbleCodes.fill(-1);
  }

  /** External hook (e.g. game.js) to force the red flash. */
  flashDamage() {
    this.damageTime = 0.6;
  }

  setOpacity(el, key, value) {
    const q = q100(value);
    if (q !== this.op[key]) {
      this.op[key] = q;
      el.style.opacity = OPACITY[q];
    }
  }

  setShown(el, key, show) {
    if (this.shown[key] !== show) {
      this.shown[key] = show;
      el.style.display = show ? '' : 'none';
    }
  }

  /**
   * Per-frame update.
   * @param {number} dt seconds
   * @param {boolean} visible whether the HUD should be drawn at all
   */
  update(dt, visible) {
    const p = this.game.player;
    if (!visible || !p) {
      if (this.el.style.display !== 'none') this.el.style.display = 'none';
      return;
    }
    if (this.el.style.display === 'none') this.el.style.display = '';
    this.tickAcc += dt;
    let ticked = false;
    while (this.tickAcc >= TICK) {
      this.tickAcc -= TICK;
      this.ticks++;
      ticked = true;
    }
    const creative = p.mode === 'creative';
    if (this.mode !== p.mode) {
      this.mode = p.mode;
      this.el.classList.toggle('creative', creative);
      this.itemName.classList.toggle('creative', creative);
      this.heartCodes.fill(-1);
      this.foodCodes.fill(-1);
      this.lastHealth = -1;
    }
    this.updateHotbar(p);
    this.updateItemName(dt, p);
    if (!creative) this.updateBars(p, ticked);
    this.updateDamage(dt);
    this.updateVignette(dt, p);
    this.updateAction(dt);
    this.updateDebug(dt, p);
    this.updateFps();
    this.updateLockHint();
  }

  updateHotbar(p) {
    const inv = p.inventory;
    const sel = p.selectedSlot ?? 0;
    if (inv && inv.version !== this.invVersion) {
      this.invVersion = inv.version;
      for (let i = 0; i < 9; i++) setItemView(this.hotbarViews[i], inv.get(i), this.ui.icons);
    }
    if (sel !== this.selected) {
      this.selected = sel;
      this.hotbarSel.style.left = gp(-1 + sel * 20);
    }
  }

  updateItemName(dt, p) {
    const stack = p.inventory?.get(p.selectedSlot ?? 0);
    const id = stack ? stack.id : 0;
    if (id !== this.selectedId) {
      const first = this.selectedId === -1;
      this.selectedId = id;
      if (id && !first) {
        this.itemName.textContent = getItem(id)?.displayName ?? '';
        this.nameTime = 2.0;
      } else {
        this.nameTime = 0;
      }
    }
    if (this.nameTime > 0) this.nameTime = Math.max(0, this.nameTime - dt);
    this.setOpacity(this.itemName, 'name', this.nameTime / 0.5);
  }

  updateBars(p, ticked) {
    const health = Math.max(0, Math.min(20, Math.ceil(p.health ?? 20)));
    const now = performance.now();
    if (this.lastHealth < 0) {
      this.lastHealth = health;
      this.shownHealth = health;
    }
    if (health < this.lastHealth) {
      this.healthUpdateTicks = this.ticks + 20;
      this.lastHealthChange = now;
      this.damageTime = 0.6;
    } else if (health > this.lastHealth) {
      this.healthUpdateTicks = this.ticks + 10;
      this.lastHealthChange = now;
    }
    if (now - this.lastHealthChange > 1000) this.shownHealth = health;
    this.lastHealth = health;
    const highlight = this.healthUpdateTicks > this.ticks && Math.floor((this.healthUpdateTicks - this.ticks) / 3) % 2 === 1;
    const food = Math.max(0, Math.min(20, Math.ceil(p.food ?? 20)));
    // Food effects of player.js (Minecraft MobEffects.POISON / HUNGER): tinted hearts / drumsticks.
    const poisoned = p.poisonTicks > 0 ? 18 : 0;
    const hungry = p.hungerTicks > 0 ? 3 : 0;
    if (ticked) {
      for (let i = 0; i < 10; i++) this.heartShake[i] = health <= 4 ? Math.floor(this.random() * 2) : 0;
      // Gui.renderPlayerHealth: with no saturation left, every (food·3 + 1)th tick each icon jitters ±1 px.
      const jitter = typeof p.saturation === 'number' && p.saturation <= 0 && this.ticks % (food * 3 + 1) === 0;
      for (let i = 0; i < 10; i++) this.foodShake[i] = jitter ? Math.floor(this.random() * 3) - 1 : 0;
    }
    for (let i = 0; i < 10; i++) {
      const bg = fillCode(i, health) + (highlight ? 3 * fillCode(i, this.shownHealth) + 9 : 0) + poisoned;
      const code = bg + HEART_VARIANTS * this.heartShake[i];
      if (code !== this.heartCodes[i]) {
        this.heartCodes[i] = code;
        const el = this.hearts[i];
        el.style.backgroundImage = HEART_BG[bg];
        el.style.transform = SHIFT_Y[this.heartShake[i]];
      }
    }
    for (let i = 0; i < 10; i++) {
      const bg = fillCode(i, food) + hungry;
      const code = bg + FOOD_VARIANTS * (this.foodShake[i] + 1);
      if (code !== this.foodCodes[i]) {
        this.foodCodes[i] = code;
        const el = this.foods[i];
        el.style.backgroundImage = FOOD_BG[bg];
        el.style.transform = SHIFT_Y[this.foodShake[i]];
      }
    }
    const air = Math.max(0, Math.min(300, p.air ?? 300));
    const showAir = !!p.eyeInWater || air < 300;
    this.setShown(this.airRow, 'air', showAir);
    if (showAir) {
      const full = Math.ceil(((air - 2) * 10) / 300);
      const popping = Math.ceil((air * 10) / 300) - full;
      for (let i = 0; i < 10; i++) {
        const code = i < full ? 2 : i < full + popping ? 1 : 0;
        if (code !== this.bubbleCodes[i]) {
          this.bubbleCodes[i] = code;
          this.bubbles[i].style.backgroundImage = BUBBLE_BG[code];
        }
      }
    }
  }

  updateDamage(dt) {
    if (this.damageTime > 0) this.damageTime = Math.max(0, this.damageTime - dt);
    const k = Math.min(1, this.damageTime / 0.6);
    this.setOpacity(this.damageFlash, 'damage', k * k * 0.9);
  }

  updateVignette(dt, p) {
    const world = this.game.world;
    let bright = 1;
    if (world && typeof world.getLight === 'function') {
      const eyeY = (p.y ?? 0) + (typeof p.eyeHeight === 'number' ? p.eyeHeight : 1.62);
      const packed = world.getLight(Math.floor(p.x ?? 0), Math.floor(eyeY), Math.floor(p.z ?? 0));
      const daylight = typeof this.game.daylight === 'number' ? this.game.daylight : 1;
      bright = Math.max(((packed >> 4) & 15) * daylight, packed & 15) / 15;
    }
    this.darkness += (1 - bright - this.darkness) * Math.min(1, dt * 1.2);
    this.setOpacity(this.vignette, 'vignette', 0.32 + 0.5 * this.darkness);
  }

  updateAction(dt) {
    if (this.actionTime > 0) this.actionTime = Math.max(0, this.actionTime - dt);
    this.setOpacity(this.actionText, 'action', this.actionTime);
  }

  // ------------------------------------------------------------------ F3
  rendererName() {
    if (this.gpuName !== null) return this.gpuName;
    this.gpuName = '';
    try {
      const gl = this.game.renderer?.gl;
      if (gl) {
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        this.gpuName = shortGpuName(String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? ''));
      }
    } catch {
      this.gpuName = '';
    }
    return this.gpuName;
  }

  rightDebugLines() {
    const lines = [];
    const nav = typeof navigator !== 'undefined' ? navigator : {};
    lines.push(`WebCraft · ${nav.userAgentData?.brands?.find((b) => !/Not/i.test(b.brand))?.brand ?? '浏览器'}`);
    const mem = typeof performance !== 'undefined' ? performance.memory : null;
    if (mem) {
      const used = Math.round(mem.usedJSHeapSize / 1048576);
      const limit = Math.round(mem.jsHeapSizeLimit / 1048576);
      lines.push(`内存: ${Math.round((used / limit) * 100)}% ${used}/${limit}MB`);
    }
    if (nav.hardwareConcurrency) lines.push(`CPU: ${nav.hardwareConcurrency} 线程`);
    lines.push('');
    const dpr = window.devicePixelRatio || 1;
    lines.push(`显示: ${Math.round(window.innerWidth * dpr)}x${Math.round(window.innerHeight * dpr)} (WebGL2)`);
    const gpu = this.rendererName();
    if (gpu) lines.push(gpu.length > 40 ? gpu.slice(0, 39) + '…' : gpu);
    const stats = typeof this.game.renderer?.getStats === 'function' ? this.game.renderer.getStats() : null;
    if (stats) {
      lines.push(`区段: ${stats.visibleSections ?? 0}/${stats.sections ?? 0}  绘制调用: ${stats.drawCalls ?? 0}`);
      lines.push(`三角形: ${(stats.triangles ?? 0).toLocaleString('en-US')}`);
      lines.push(`显存: ${((stats.gpuMemoryBytes ?? 0) / 1048576).toFixed(1)} MB`);
    }
    // Entity counts and the targeted block are part of the left column (game.getDebugInfo()).
    if (typeof this.game.getDebugInfo !== 'function') {
      const ents = this.game.entities?.count;
      if (typeof ents === 'number') lines.push(`实体: ${ents}`);
      const t = this.game.interaction?.target;
      if (t) {
        lines.push('');
        lines.push(`目标方块: ${t.x}, ${t.y}, ${t.z}`);
        const b = BLOCKS[t.blockId];
        if (b) lines.push(`${b.displayName} (${b.name})`);
      }
    }
    return lines;
  }

  /** Show `lines` in a debug column, touching only the rows that changed. */
  setLines(col, lines) {
    const n = lines ? lines.length : 0;
    while (col.children.length < n) col.appendChild(h('div', { className: 'debug-line' }));
    for (let i = 0; i < col.children.length; i++) {
      const el = col.children[i];
      if (i >= n) {
        if (el._shown !== false) {
          el._shown = false;
          el.style.display = 'none';
        }
        continue;
      }
      const text = String(lines[i] ?? '');
      if (el._text !== text) {
        el._text = text;
        el.textContent = text;
        el.classList.toggle('blank', text === '');
      }
      if (el._shown !== true) {
        el._shown = true;
        el.style.display = '';
      }
    }
  }

  updateDebug(dt, p) {
    const on = !!this.ui.debugVisible;
    this.setShown(this.debug, 'debug', on);
    // The axis gizmo replaces the crosshair, so like it it is drawn in first person only.
    const gizmoOn = on && (this.game.perspective ?? 0) === 0;
    if (this.shown.gizmo !== gizmoOn) {
      this.shown.gizmo = gizmoOn;
      this.gizmo.style.display = gizmoOn ? '' : 'none';
    }
    if (!on) return;
    this.setLines(this.debugLeft, typeof this.game.getDebugInfo === 'function' ? this.game.getDebugInfo() : null);
    this.debugAcc += dt;
    if (this.debugAcc >= 0.25) {
      this.debugAcc = 0;
      this.setLines(this.debugRight, this.rightDebugLines());
    }
    if (gizmoOn) this.drawGizmo(p);
  }

  /** Minecraft's F3 axis gizmo: red X, green Y, blue Z rotated with the camera. */
  drawGizmo(p) {
    const c = this.gizmo;
    const dpr = window.devicePixelRatio || 1;
    const size = Math.round(this.ui.unit * dpr * 22);
    if (c.width !== size) {
      c.width = size;
      c.height = size;
    }
    const g = c.getContext('2d');
    g.clearRect(0, 0, size, size);
    const yaw = p.yaw ?? 0;
    const pitch = p.pitch ?? 0;
    const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
    // view = Rx(-pitch) * Ry(-yaw) applied to the world axes (x right, y up on screen)
    const ax = this.gizmoAxes;
    for (let i = 0; i < 3; i++) {
      const x = i === 0 ? 1 : 0, y = i === 1 ? 1 : 0, z = i === 2 ? 1 : 0;
      const x1 = x * cy - z * sy;
      const z1 = x * sy + z * cy;
      ax[i].x = x1;
      ax[i].y = y * cp - z1 * sp;
      ax[i].z = y * sp + z1 * cp;
    }
    const o = this.gizmoOrder;
    o[0] = 0; o[1] = 1; o[2] = 2;
    for (let i = 0; i < 2; i++) {
      for (let j = 0; j < 2 - i; j++) {
        if (ax[o[j]].z > ax[o[j + 1]].z) {
          const t = o[j];
          o[j] = o[j + 1];
          o[j + 1] = t;
        }
      }
    }
    const len = size * 0.42;
    const mid = size / 2;
    g.lineCap = 'square';
    g.lineWidth = Math.max(1, Math.round(this.ui.unit * dpr));
    for (let k = 0; k < 3; k++) {
      const a = ax[o[k]];
      g.strokeStyle = a.color;
      g.beginPath();
      g.moveTo(mid, mid);
      g.lineTo(mid + a.x * len, mid - a.y * len);
      g.stroke();
    }
  }

  updateFps() {
    const show = !!this.game.settings?.showFps && !this.ui.debugVisible;
    this.setShown(this.fpsEl, 'fps', show);
    if (show) {
      const v = Math.round(this.game.fps ?? 0);
      if (v !== this.fpsValue) {
        this.fpsValue = v;
        this.fpsEl.textContent = `${v} FPS`;
      }
    }
  }

  updateLockHint() {
    const input = this.game.input;
    const want = !!input && this.game.state === 'playing' && !this.ui.screen && !input.locked && !this.ui.hudHidden &&
      !this.ui.automation && !this.game.player?.dead;
    const now = performance.now();
    if (!want) this.lockSince = 0;
    else if (!this.lockSince) this.lockSince = now;
    this.setShown(this.lockHint, 'hint', want && now - this.lockSince > 600);
  }
}
