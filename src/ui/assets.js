// Procedural pixel-art assets for the UI (browser only: uses canvas). Everything is original art in
// Minecraft's spirit, painted once at startup and handed to CSS as data URLs (CSS custom properties
// on #ui-root, see UIManager). Block textures (dirt background, stone logo) come from the shared
// texture generator: game.textures if the integrator provides it, otherwise
// src/render/textures.js generateTextures() is imported lazily; a procedural fallback keeps the UI
// working if neither is available.
import { TEXTURE_INDEX, getItem, isBlockItem, BLOCKS, RENDER_LAYER, LAYER, TINT_TYPE } from '../world/registry.js';
import { DEFAULT_TINTS } from '../config.js';

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------
/** Deterministic PRNG (mulberry32). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

export function ctx2d(c) {
  const g = c.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingEnabled = false;
  return g;
}

function hex(c) {
  if (Array.isArray(c)) return c.length === 4 ? c : [c[0], c[1], c[2], 255];
  const v = parseInt(c.slice(1), 16);
  if (c.length === 9) return [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255, 255];
}

/** Pixel writer over an ImageData. */
class Pix {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.canvas = makeCanvas(w, h);
    this.g = ctx2d(this.canvas);
    this.img = this.g.createImageData(w, h);
    this.d = this.img.data;
  }
  set(x, y, c, a) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const [r, g, b, al] = hex(c);
    const i = (y * this.w + x) * 4;
    this.d[i] = r; this.d[i + 1] = g; this.d[i + 2] = b; this.d[i + 3] = a ?? al;
  }
  get(x, y) {
    const i = (y * this.w + x) * 4;
    return [this.d[i], this.d[i + 1], this.d[i + 2], this.d[i + 3]];
  }
  rect(x, y, w, h, c, a) {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) this.set(i, j, c, a);
  }
  /** Paint a character map with a palette; '.' and ' ' are transparent. */
  map(rows, pal, ox = 0, oy = 0) {
    rows.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) {
        const ch = row[x];
        if (ch === '.' || ch === ' ') continue;
        const c = pal[ch];
        if (c) this.set(ox + x, oy + y, c);
      }
    });
    return this;
  }
  flush() {
    this.g.putImageData(this.img, 0, 0);
    return this.canvas;
  }
  url() {
    return this.flush().toDataURL('image/png');
  }
}

function shade(c, k) {
  const [r, g, b, a] = hex(c);
  const f = (v) => Math.max(0, Math.min(255, Math.round(v * k)));
  return [f(r), f(g), f(b), a];
}

function add(c, d) {
  const [r, g, b, a] = hex(c);
  const f = (v) => Math.max(0, Math.min(255, Math.round(v + d)));
  return [f(r), f(g), f(b), a];
}

// ---------------------------------------------------------------------------------------------
// Block textures (from generateTextures()) with a procedural fallback
// ---------------------------------------------------------------------------------------------
let texturePromise = null;

/**
 * Resolve the shared texture set { size, layers, data }: game.textures (or game.icons.textures)
 * when available, else generateTextures() from src/render/textures.js (imported once), else null.
 */
export function getTextureSet(game) {
  const direct = game?.textures ?? game?.icons?.textures ?? null;
  if (direct && direct.data) return Promise.resolve(direct);
  if (!texturePromise) {
    texturePromise = import('../render/textures.js')
      .then((m) => (typeof m.generateTextures === 'function' ? m.generateTextures() : null))
      .catch((err) => {
        console.warn('[ui] textures unavailable, using procedural UI fallbacks:', err?.message ?? err);
        return null;
      });
  }
  return texturePromise;
}

/** 16x16 RGBA (Uint8ClampedArray) of a texture layer by name, or null. */
export function textureRGBA(textures, name) {
  if (!textures || !textures.data) return null;
  const layer = TEXTURE_INDEX.get(name);
  if (layer === undefined) return null;
  const size = textures.size ?? 16;
  const n = size * size * 4;
  const off = layer * n;
  if (off + n > textures.data.length) return null;
  return { size, data: new Uint8ClampedArray(textures.data.buffer, textures.data.byteOffset + off, n) };
}

/** Procedural stand-in textures (used only when the texture generator is unavailable). */
function fallbackTexture(name) {
  const r = rng([...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7));
  const base = name === 'dirt' ? [134, 96, 67] : name === 'stone' ? [125, 125, 125] : [120, 110, 100];
  const data = new Uint8ClampedArray(16 * 16 * 4);
  for (let i = 0; i < 256; i++) {
    const v = (r() - 0.5) * (name === 'dirt' ? 50 : 34) + (r() < 0.08 ? -30 : 0);
    data[i * 4] = base[0] + v;
    data[i * 4 + 1] = base[1] + v;
    data[i * 4 + 2] = base[2] + v * (name === 'dirt' ? 0.8 : 1);
    data[i * 4 + 3] = 255;
  }
  return { size: 16, data };
}

function textureOrFallback(textures, name) {
  return textureRGBA(textures, name) ?? fallbackTexture(name);
}

/** Tiled background texture (Minecraft draws dirt at 2 GUI px per texel, colour 0x404040). */
export function dirtBackgroundURL(textures, brightness = 0.25) {
  const t = textureOrFallback(textures, 'dirt');
  const p = new Pix(t.size, t.size);
  for (let i = 0; i < t.size * t.size; i++) {
    p.d[i * 4] = t.data[i * 4] * brightness;
    p.d[i * 4 + 1] = t.data[i * 4 + 1] * brightness;
    p.d[i * 4 + 2] = t.data[i * 4 + 2] * brightness;
    p.d[i * 4 + 3] = 255;
  }
  return p.url();
}

// ---------------------------------------------------------------------------------------------
// GUI textures
// ---------------------------------------------------------------------------------------------
const K = '#000000';
const W = '#FFFFFF';
const PANEL = '#C6C6C6';
const DARK = '#555555';

/** 9x9 nine-slice of the container background (rounded black outline, 2 px bevel). */
function panelNine(face = PANEL, hi = W, lo = DARK) {
  const p = new Pix(9, 9);
  const n = 9;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const corner = (x + y < 2) || (n - 1 - x + y < 2) || (x + n - 1 - y < 2) || (2 * (n - 1) - x - y < 2);
      if (corner) continue;
      const edge = x === 0 || y === 0 || x === n - 1 || y === n - 1 ||
        (x === 1 && y === 1) || (x === n - 2 && y === 1) || (x === 1 && y === n - 2) || (x === n - 2 && y === n - 2);
      if (edge) {
        p.set(x, y, K);
        continue;
      }
      const h = x <= 2 || y <= 2;
      const s = x >= n - 3 || y >= n - 3;
      p.set(x, y, h && s ? face : h ? hi : s ? lo : face);
    }
  }
  return p.url();
}

/** Inventory slot (dark top-left, white bottom-right) of `size` px. */
function slotURL(size = 18, face = '#8B8B8B') {
  const p = new Pix(size, size);
  p.rect(0, 0, size, size, face);
  for (let i = 0; i < size - 1; i++) {
    p.set(i, 0, '#373737');
    p.set(0, i, '#373737');
    p.set(i + 1, size - 1, W);
    p.set(size - 1, i + 1, W);
  }
  return p.url();
}

/** 200x20 button texture: state 'normal' | 'hover' | 'disabled'. */
function buttonCanvas(state) {
  const p = new Pix(200, 20);
  const r = rng(state === 'normal' ? 11 : state === 'hover' ? 12 : 13);
  const cfg = {
    normal: { face: [111, 111, 111], hi: [170, 170, 170], lo: [86, 86, 86], lo2: [70, 70, 70], noise: 9 },
    hover: { face: [122, 133, 196], hi: [189, 198, 255], lo: [90, 100, 162], lo2: [74, 82, 140], noise: 8 },
    disabled: { face: [44, 44, 44], hi: [44, 44, 44], lo: [44, 44, 44], lo2: [38, 38, 38], noise: 3 },
  }[state];
  for (let y = 0; y < 20; y++) {
    for (let x = 0; x < 200; x++) {
      if (x === 0 || y === 0 || x === 199 || y === 19) {
        p.set(x, y, K);
        continue;
      }
      let c;
      if (y === 18) c = cfg.lo2;
      else if (y === 17 || x === 198) c = cfg.lo;
      else if (y === 1 || x === 1) c = cfg.hi;
      else c = cfg.face;
      const n = (r() - 0.5) * cfg.noise + (r() < 0.06 ? -cfg.noise * 0.6 : 0);
      p.set(x, y, add(c, n));
    }
  }
  return p.flush();
}

/** 8x20 slider handle cut from the button texture (left 4 + right 4 columns). */
function sliderHandleURL(btn) {
  const c = makeCanvas(8, 20);
  const g = ctx2d(c);
  g.drawImage(btn, 0, 0, 4, 20, 0, 0, 4, 20);
  g.drawImage(btn, 196, 0, 4, 20, 4, 0, 4, 20);
  return c.toDataURL('image/png');
}

/** Hotbar strip 182x22 and the 24x24 selection frame. */
function hotbarURLs() {
  const p = new Pix(182, 22);
  for (let y = 0; y < 22; y++) {
    for (let x = 0; x < 182; x++) {
      if (x === 0 || y === 0 || x === 181 || y === 21) {
        p.set(x, y, [0, 0, 0, 200]);
        continue;
      }
      const sx = (x - 1) % 20; // 0..19 within a slot cell
      const sy = y - 1;        // 0..19
      const border = sx === 0 || sx === 19 || sy === 0 || sy === 19;
      if (border) {
        const light = sx === 0 || sy === 0;
        p.set(x, y, light ? [150, 150, 150, 235] : [104, 104, 104, 235]);
      } else {
        p.set(x, y, [44, 44, 44, 130]);
      }
    }
  }
  const s = new Pix(24, 24);
  for (let y = 0; y < 24; y++) {
    for (let x = 0; x < 24; x++) {
      const d = Math.min(x, y, 23 - x, 23 - y);
      if (d === 0) s.set(x, y, [0, 0, 0, 220]);
      else if (d === 1) s.set(x, y, x + y < 24 ? [255, 255, 255, 255] : [208, 208, 208, 255]);
      else if (d === 2) s.set(x, y, [150, 150, 150, 255]);
    }
  }
  return { hotbar: p.url(), select: s.url() };
}

// ---- 9x9 HUD icons ----------------------------------------------------------------------------
const HEART = [
  '.KKK.KKK.',
  'KiiiKiiiK',
  'KiiiiiiiK',
  'KiiiiiiiK',
  'KiiiiiiiK',
  '.KiiiiiK.',
  '..KiiiK..',
  '...KiK...',
  '....K....',
];
const HEART_FILL = [
  '.........',
  '.LLr.rrr.',
  '.LWrrrrr.',
  '.Lrrrrrd.',
  '.rrrrrdd.',
  '..rrrdd..',
  '...rdd...',
  '....d....',
  '.........',
];
const FOOD = [
  '.....KKK.',
  '....KMMmK',
  '...KMMmmK',
  '...KMmmdK',
  '..KmmmddK',
  '.KBKdddK.',
  'KBbKKKK..',
  'KbbK.....',
  '.KK......',
];
const BUBBLE = [
  '..OOOOO..',
  '.OllbbbO.',
  'OlWbbbbbO',
  'OlbbbbbbO',
  'ObbbbbbbO',
  'ObbbbbbdO',
  'ObbbbbddO',
  '.ObbbddO.',
  '..OOOOO..',
];
const BUBBLE_POP = [
  '..O...O..',
  '.O.....O.',
  'O..W....O',
  '.........',
  '.........',
  '.........',
  'O.......O',
  '.O.....O.',
  '..O...O..',
];

function iconURL(rows, pal, mask) {
  const p = new Pix(9, 9);
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (mask && !mask(x, y)) continue;
      const c = pal[row[x]];
      if (c) p.set(x, y, c);
    }
  });
  return p.url();
}

function hudIconURLs() {
  const container = { K: '#000000', i: '#2E2E2E' };
  const flashContainer = { K: '#FFFFFF', i: '#2E2E2E' };
  const red = { L: '#FF7676', W: '#FFFFFF', r: '#E81A1A', d: '#A30808' };
  const pale = { L: '#FFFFFF', W: '#FFFFFF', r: '#F2C8C8', d: '#D59C9C' };
  // Poison: sickly yellow-green hearts (Minecraft heart_poisoned_*).
  const poison = { L: '#DCEB7E', W: '#FFFFFF', r: '#94AE2E', d: '#5A6E16' };
  const poisonPale = { L: '#FFFFFF', W: '#FFFFFF', r: '#DCE6B0', d: '#BCC98A' };
  const left = (x) => x <= 4;
  const food = { K: '#3A1F0C', M: '#E09A4F', m: '#B8682A', d: '#8A4515', B: '#F5F1E6', b: '#C9C2B0' };
  const foodEmpty = { K: '#120A04', M: '#2E2E2E', m: '#2E2E2E', d: '#2E2E2E', B: '#2E2E2E', b: '#2E2E2E' };
  // Hunger effect: greenish, spoiled-looking drumsticks and a green-tinted outline (food_*_hunger).
  const foodHunger = { K: '#26300C', M: '#AEBE5C', m: '#87973A', d: '#5D6C20', B: '#E4E9C6', b: '#B6BD90' };
  const foodHungerEmpty = { K: '#1B2608', M: '#2C3222', m: '#2C3222', d: '#2C3222', B: '#2C3222', b: '#2C3222' };
  const foodHalf = (x) => x >= 4;
  const bubble = { O: '#2D4FA8', l: '#C3DBFF', W: '#FFFFFF', b: '#6E9BEE', d: '#4670D4' };
  return {
    heartContainer: iconURL(HEART, container),
    heartContainerFlash: iconURL(HEART, flashContainer),
    heartFull: iconURL(HEART_FILL, red),
    heartHalf: iconURL(HEART_FILL, red, left),
    heartFlashFull: iconURL(HEART_FILL, pale),
    heartFlashHalf: iconURL(HEART_FILL, pale, left),
    heartPoisonFull: iconURL(HEART_FILL, poison),
    heartPoisonHalf: iconURL(HEART_FILL, poison, left),
    heartPoisonFlashFull: iconURL(HEART_FILL, poisonPale),
    heartPoisonFlashHalf: iconURL(HEART_FILL, poisonPale, left),
    foodEmpty: iconURL(FOOD, foodEmpty),
    foodFull: iconURL(FOOD, food),
    foodHalf: iconURL(FOOD, food, foodHalf),
    foodHungerEmpty: iconURL(FOOD, foodHungerEmpty),
    foodHungerFull: iconURL(FOOD, foodHunger),
    foodHungerHalf: iconURL(FOOD, foodHunger, foodHalf),
    bubble: iconURL(BUBBLE, bubble),
    bubblePop: iconURL(BUBBLE_POP, { O: '#6E9BEE', W: '#FFFFFF' }),
  };
}

// ---- furnace progress sprites (Minecraft furnace GUI: 14x14 flame, 24x16 arrow) -------------------
const FURNACE_FLAME = [
  '......r.......',
  '.....ro.......',
  '.....oor......',
  '....royo....r.',
  '..r.oyyo...ro.',
  '..roryYyr.roo.',
  '.royrYYyorryr.',
  '.royYYwYyoyyo.',
  'royYYwwYYyYyor',
  'royYwwwwYYYyor',
  'roYYwwwwwYYyor',
  '.roYYwwwwYYor.',
  '..rooyyyyyoor.',
  '...rrooooorr..',
];

/** Lit flame (fire colours) or the empty grey silhouette drawn into the GUI background. */
function furnaceFlameURL(lit) {
  const p = new Pix(14, 14);
  const pal = lit
    ? { r: '#B42A0C', o: '#EE6418', y: '#FDAA22', Y: '#FFDC40', w: '#FFF7B0' }
    : { r: '#8B8B8B', o: '#8B8B8B', y: '#8B8B8B', Y: '#8B8B8B', w: '#8B8B8B' };
  p.map(FURNACE_FLAME, pal);
  return p.url();
}

/** 24x16 progress arrow (the crafting arrow's shape, 23x15): grey background or white progress. */
function furnaceArrowURL(color) {
  const p = new Pix(24, 16);
  const w = 23, h = 15, mid = 7, headLen = 8;
  for (let y = mid - 2; y <= mid + 2; y++) for (let x = 0; x < w - headLen; x++) p.set(x, y, color);
  for (let x = w - headLen; x < w; x++) {
    const half = w - 1 - x;
    for (let y = mid - half; y <= mid + half; y++) if (y >= 0 && y < h) p.set(x, y, color);
  }
  return p.url();
}

// ---- creative tabs / scrollbar / arrow -----------------------------------------------------------
/** 28x32 tab. `bottom` tabs hang below the panel; `selected` tabs use the panel colours. */
function tabURL(bottom, selected) {
  const w = 28, h = 32;
  const face = selected ? PANEL : '#A3A3A3';
  const hi = selected ? W : '#D8D8D8';
  const lo = selected ? DARK : '#6A6A6A';
  const p = new Pix(w, h);
  for (let yy = 0; yy < h; yy++) {
    // build top-tab geometry, flip vertically for bottom tabs
    const y = bottom ? h - 1 - yy : yy;
    for (let x = 0; x < w; x++) {
      const round = (y === 0 && (x < 2 || x > w - 3)) || (y === 1 && (x < 1 || x > w - 2));
      if (round) continue;
      const outline = y === 0 || x === 0 || x === w - 1 || (y === 1 && (x === 1 || x === w - 2));
      if (outline) {
        p.set(x, yy, K);
        continue;
      }
      const isHi = x <= 2 || y <= 2;
      const isLo = x >= w - 3;
      let c = isHi && isLo ? face : isHi ? hi : isLo ? lo : face;
      if (bottom && y <= 2 && !isLo) c = hi;
      if (bottom && y <= 2 && isLo) c = lo;
      p.set(x, yy, c);
    }
  }
  return p.url();
}

function scrollURLs() {
  const thumb = (enabled) => {
    const p = new Pix(12, 15);
    const face = enabled ? PANEL : '#9D9D9D';
    const hi = enabled ? W : '#C4C4C4';
    const lo = enabled ? DARK : '#5E5E5E';
    for (let y = 0; y < 15; y++) {
      for (let x = 0; x < 12; x++) {
        if (x === 0 || y === 0 || x === 11 || y === 14) p.set(x, y, K);
        else if (x === 1 || y === 1) p.set(x, y, hi);
        else if (x === 10 || y === 13) p.set(x, y, lo);
        else p.set(x, y, face);
      }
    }
    if (enabled) for (const y of [5, 7, 9]) for (let x = 3; x <= 8; x++) p.set(x, y, x === 8 ? hi : lo);
    return p.url();
  };
  return { scrollThumb: thumb(true), scrollThumbOff: thumb(false) };
}

/** Crafting arrow (w x h, h odd): shaft of 5 px, triangular head with the tip at the right edge. */
function arrowURL(w = 22, h = 15) {
  const p = new Pix(w, h);
  const c = '#8B8B8B';
  const mid = (h - 1) / 2;
  const headLen = mid + 1;
  for (let y = mid - 2; y <= mid + 2; y++) for (let x = 0; x < w - headLen; x++) p.set(x, y, c);
  for (let x = w - headLen; x < w; x++) {
    const half = w - 1 - x;
    for (let y = mid - half; y <= mid + half; y++) p.set(x, y, c);
  }
  return p.url();
}

// ---- 16x16 pictograms ----------------------------------------------------------------------------
function chestIconURL() {
  const p = new Pix(16, 16);
  p.map([
    '................',
    '..KKKKKKKKKKKK..',
    '.KwwwwwwwwwwwwK.',
    '.KwWWWWWWWWWWwK.',
    '.KwWWWWWWWWWWwK.',
    '.KddddddddddddK.',
    '.KKKKKKggKKKKKK.',
    '.KwwwwwgGgwwwwK.',
    '.KwWWWWgggWWwwK.',
    '.KwWWWWWWWWWWwK.',
    '.KwWWWWWWWWWWwK.',
    '.KwWWWWWWWWWWwK.',
    '.KwWWWWWWWWWWwK.',
    '.KddddddddddddK.',
    '..KKKKKKKKKKKK..',
    '................',
  ], { K: '#2B1A0B', w: '#8A5A2B', W: '#A7713A', d: '#5E3B19', g: '#9E9E9E', G: '#E6E6E6' });
  return p.url();
}

function searchIconURL() {
  const p = new Pix(16, 16);
  p.map([
    '................',
    '....KKKKK.......',
    '...KlllllK......',
    '..KlWWllllK.....',
    '..KlWlllllK.....',
    '..KllllllbK.....',
    '..KllllllbK.....',
    '...KllbbbK......',
    '....KKKKKhK.....',
    '.........KhhK...',
    '..........KhhK..',
    '...........KhhK.',
    '............KhK.',
    '.............K..',
    '................',
    '................',
  ], { K: '#2A2A2A', l: '#A9D6F5', W: '#FFFFFF', b: '#6CA8D8', h: '#8B5A2B' });
  return p.url();
}

function destroyIconURL() {
  const p = new Pix(16, 16);
  const rows = [];
  for (let y = 0; y < 16; y++) {
    let row = '';
    for (let x = 0; x < 16; x++) {
      const d1 = Math.abs(x - y), d2 = Math.abs(x - (15 - y));
      const inside = x >= 3 && x <= 12 && y >= 3 && y <= 12;
      row += inside && (d1 === 0 || d2 === 0) ? 'R' : inside && (d1 === 1 || d2 === 1) ? 'r' : '.';
    }
    rows.push(row);
  }
  p.map(rows, { R: '#E83030', r: '#9C1C1C' });
  return p.url();
}

// ---------------------------------------------------------------------------------------------
// Player skin (64x64, classic layout) — an original Steve-like character
// ---------------------------------------------------------------------------------------------
/** Paint the player skin; returns a canvas. */
export function paintSkin() {
  const p = new Pix(64, 64);
  const r = rng(4242);
  const noisy = (x, y, c, n = 10) => p.set(x, y, add(c, (r() - 0.5) * n));
  const fill = (x, y, w, h, c, n) => { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) noisy(x + i, y + j, c, n); };
  const SKIN = '#C68E68', SKIN_D = '#A9724F', HAIR = '#3B2615', HAIR_L = '#4E331D';
  const SHIRT = '#16A3A8', SHIRT_D = '#0E8287', PANTS = '#3439A3', PANTS_D = '#262A82', SHOE = '#6B6B6B';
  // head (8x8x8 at 0,0)
  fill(8, 0, 8, 8, HAIR, 14);            // top
  fill(16, 0, 8, 8, SKIN_D, 8);          // bottom (chin)
  fill(0, 8, 32, 8, SKIN, 10);           // sides + front + back
  fill(24, 8, 8, 8, HAIR, 12);           // back of head: hair
  fill(0, 8, 8, 2, HAIR, 12);            // right side hair (texture right = towards the face)
  fill(16, 8, 8, 2, HAIR, 12);           // left side hair (texture left = towards the face)
  fill(0, 10, 5, 3, HAIR, 12);           // hair over the back half of the sides
  fill(19, 10, 5, 3, HAIR, 12);
  fill(6, 10, 1, 2, HAIR_L, 8);          // sideburns next to the face
  fill(17, 10, 1, 2, HAIR_L, 8);
  // face (front at 8,8)
  fill(8, 8, 8, 2, HAIR, 12);
  noisy(8, 10, HAIR_L); noisy(15, 10, HAIR_L);
  p.set(9, 12, '#FFFFFF'); p.set(10, 12, '#3E4FA8');
  p.set(13, 12, '#3E4FA8'); p.set(14, 12, '#FFFFFF');
  p.set(11, 13, '#8E5B3E'); p.set(12, 13, '#8E5B3E');
  for (let x = 10; x <= 13; x++) p.set(x, 14, '#6C4129');
  p.set(9, 14, SKIN_D); p.set(14, 14, SKIN_D);
  for (let x = 9; x <= 14; x++) noisy(x, 15, SKIN_D, 6);
  // body (8x12x4 at 16,16)
  fill(20, 16, 8, 4, SHIRT, 12);         // top
  fill(28, 16, 8, 4, SHIRT_D, 10);       // bottom
  fill(16, 20, 24, 12, SHIRT, 12);       // sides + front + back
  for (let x = 22; x <= 25; x++) noisy(x, 20, SKIN, 6); // collar
  noisy(23, 21, SKIN, 6); noisy(24, 21, SKIN, 6);
  fill(16, 30, 24, 2, SHIRT_D, 8);       // hem
  // arms (4x12x4 at 40,16 and mirrored at 32,48)
  for (const [ux, uy] of [[40, 16], [32, 48]]) {
    fill(ux + 4, uy, 4, 4, SHIRT, 10);   // top (shoulder)
    fill(ux + 8, uy, 4, 4, SKIN_D, 8);   // bottom (hand)
    fill(ux, uy + 4, 16, 12, SKIN, 10);  // four sides
    fill(ux, uy + 4, 16, 4, SHIRT, 12);  // sleeves
    fill(ux, uy + 8, 16, 1, SHIRT_D, 8);
  }
  // legs (4x12x4 at 0,16 and 16,48)
  for (const [ux, uy] of [[0, 16], [16, 48]]) {
    fill(ux + 4, uy, 4, 4, PANTS, 10);
    fill(ux + 8, uy, 4, 4, SHOE, 8);
    fill(ux, uy + 4, 16, 12, PANTS, 12);
    fill(ux, uy + 4, 16, 1, PANTS_D, 8);
    fill(ux, uy + 13, 16, 3, SHOE, 10);
  }
  return p.flush();
}

// ---------------------------------------------------------------------------------------------
// Fallback item icons (only used when no IconFactory is available)
// ---------------------------------------------------------------------------------------------
export class FallbackIcons {
  constructor(textures = null) {
    this.textures = textures;
    this.cache = new Map();
  }

  /** Average colour of a block's top texture (for the fallback swatch). */
  _blockColor(id) {
    const b = BLOCKS[id];
    const name = b?.faces?.[2];
    const t = name ? textureRGBA(this.textures, name) : null;
    if (!t) return null;
    let r = 0, g = 0, bl = 0, n = 0;
    for (let i = 0; i < 256; i++) {
      if (t.data[i * 4 + 3] < 128) continue;
      r += t.data[i * 4]; g += t.data[i * 4 + 1]; bl += t.data[i * 4 + 2]; n++;
    }
    if (!n) return null;
    let c = [r / n, g / n, bl / n];
    const tint = TINT_TYPE[id];
    if (tint && RENDER_LAYER[id] !== LAYER.OPAQUE) {
      const tc = [null, DEFAULT_TINTS.grass, DEFAULT_TINTS.foliage, DEFAULT_TINTS.birch, DEFAULT_TINTS.spruce][tint];
      c = c.map((v, i) => (v * tc[i]) / 255);
    }
    return c.map(Math.round);
  }

  getIcon(id) {
    if (this.cache.has(id)) return this.cache.get(id);
    const it = getItem(id);
    const c = makeCanvas(48, 48);
    const g = ctx2d(c);
    let col = isBlockItem(id) ? this._blockColor(id) : null;
    if (!col) {
      const h = [...(it?.name ?? String(id))].reduce((a, ch) => (a * 33 + ch.charCodeAt(0)) >>> 0, 5381) % 360;
      g.fillStyle = `hsl(${h} 45% 45%)`;
    } else {
      g.fillStyle = `rgb(${col[0]},${col[1]},${col[2]})`;
    }
    const inset = isBlockItem(id) ? 4 : 10;
    g.fillRect(inset, inset, 48 - inset * 2, 48 - inset * 2);
    g.strokeStyle = 'rgba(0,0,0,0.6)';
    g.lineWidth = 3;
    g.strokeRect(inset + 1.5, inset + 1.5, 45 - inset * 2, 45 - inset * 2);
    g.fillStyle = '#fff';
    g.font = 'bold 16px "Microsoft YaHei", "PingFang SC", sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.shadowColor = 'rgba(0,0,0,0.8)';
    g.shadowOffsetX = 1;
    g.shadowOffsetY = 1;
    g.fillText((it?.displayName ?? '?').slice(0, 2), 24, 25);
    const url = c.toDataURL('image/png');
    this.cache.set(id, url);
    return url;
  }
}

// ---------------------------------------------------------------------------------------------
// Bundle
// ---------------------------------------------------------------------------------------------
/**
 * Paint all texture-independent GUI images. Returns { cssVars: {name: 'url(...)'}, urls, canvases }.
 */
export function buildGuiAssets() {
  const btn = buttonCanvas('normal');
  const btnHover = buttonCanvas('hover');
  const btnOff = buttonCanvas('disabled');
  const hb = hotbarURLs();
  const icons = hudIconURLs();
  const scroll = scrollURLs();
  const urls = {
    panel: panelNine(),
    slot: slotURL(18),
    slotBig: slotURL(26),
    slotDark: slotURL(18, '#6F6F6F'),
    button: btn.toDataURL('image/png'),
    buttonHover: btnHover.toDataURL('image/png'),
    buttonDisabled: btnOff.toDataURL('image/png'),
    sliderHandle: sliderHandleURL(btn),
    sliderHandleHover: sliderHandleURL(btnHover),
    hotbar: hb.hotbar,
    hotbarSelect: hb.select,
    tabTop: tabURL(false, false),
    tabTopSel: tabURL(false, true),
    tabBottom: tabURL(true, false),
    tabBottomSel: tabURL(true, true),
    arrow: arrowURL(22, 15),
    arrowSmall: arrowURL(16, 13),
    furnaceFlame: furnaceFlameURL(true),
    furnaceFlameOff: furnaceFlameURL(false),
    furnaceArrow: furnaceArrowURL('#FFFFFF'),
    furnaceArrowOff: furnaceArrowURL('#8B8B8B'),
    iconChest: chestIconURL(),
    iconSearch: searchIconURL(),
    iconDestroy: destroyIconURL(),
    ...scroll,
    ...icons,
  };
  const cssVars = {};
  for (const [k, v] of Object.entries(urls)) {
    cssVars[`--img-${k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())}`] = `url("${v}")`;
  }
  return { urls, cssVars };
}

/** Texture-dependent images (dirt backgrounds). */
export function buildTextureAssets(textures) {
  const urls = {
    dirt: dirtBackgroundURL(textures, 0.25),
    dirtDark: dirtBackgroundURL(textures, 0.125),
  };
  const cssVars = {};
  for (const [k, v] of Object.entries(urls)) {
    cssVars[`--img-${k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())}`] = `url("${v}")`;
  }
  return { urls, cssVars };
}

export { textureOrFallback, shade };
