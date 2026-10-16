// Inventory screens: survival inventory (2x2 crafting), crafting table (3x3), the creative inventory
// (tabs, search, scrolling item grid, inventory tab with destroy slot) and the container screens of
// block entities (furnace with flame + arrow progress, chest). Mouse/keyboard handling maps DOM events
// onto ContainerModel (slots.js), which implements Minecraft's semantics: left/right click, shift-click
// (craft-all on the result, container routing), drag splitting, double-click gathering, number keys 1-9
// over a slot, Q / Ctrl+Q to throw, clicking outside to drop, middle-click (creative).
import { ContainerModel, slotKey } from './slots.js';
import { createItemView, setItemView } from './itemview.js';
import { h, place, gp, capturePointer } from './dom.js';
import { PlayerModel } from './playermodel.js';
import { renderFormatted } from './text.js';
import { ALL_ITEM_IDS, CREATIVE_TABS, getItem, maxDurability } from '../world/registry.js';
import { CONTAINER_REACH } from '../game/blockentities.js';

/** DOM mouse button -> Minecraft button (0 left, 1 right, 2 middle). */
const MC_BUTTON = { 0: 0, 1: 2, 2: 1 };
/** Bit in PointerEvent.buttons for a Minecraft button. */
const BUTTON_BIT = { 0: 1, 1: 2, 2: 4 };

/** Tooltip lines for a stack (name + durability). */
export function stackTooltip(stack, extra = []) {
  const it = getItem(stack.id);
  const lines = [{ text: it?.displayName ?? `#${stack.id}` }];
  const max = maxDurability(stack.id);
  if (max > 0 && (stack.damage ?? 0) > 0) lines.push({ text: `耐久度：${max - stack.damage} / ${max}`, color: '#AAAAAA' });
  return lines.concat(extra);
}

/** Base class for screens made of slots. */
export class ContainerScreen {
  /**
   * @param {import('./ui.js').UIManager} ui
   * @param {object} o  name, gridWidth, creative, width, height (panel size in GUI px)
   */
  constructor(ui, { name, gridWidth = 0, creative = false, width = 176, height = 166, container = null }) {
    this.ui = ui;
    this.game = ui.game;
    this.name = name;
    this.inGame = true;
    this.pausesGame = false;
    const player = this.game.player;
    /** Open block entity (chest / furnace) or null. */
    this.container = container;
    this.renderedContainer = -1;
    this.model = new ContainerModel({
      inventory: player.inventory,
      gridWidth,
      creative,
      container,
      onDrop: (s) => ui.dropStack(s),
      getSelectedSlot: () => player.selectedSlot ?? 0,
    });
    this.width = width;
    this.height = height;
    this.el = h('div', { className: `screen screen-container screen-${name}` });
    this.panel = h('div', { className: 'mc-panel container-panel' });
    this.panel.style.left = `calc(var(--g) * (var(--hw) - ${Math.floor(width / 2)}))`;
    this.panel.style.top = `calc(var(--g) * (var(--hh) - ${Math.floor(height / 2)}))`;
    this.panel.style.width = gp(width);
    this.panel.style.height = gp(height);
    this.el.appendChild(this.panel);
    this.slots = [];
    this.slotByEl = new Map();
    this.hover = null;
    this.drag = null;
    this.lastClick = { time: 0, key: null };
    this.lastShift = null;
    this.renderedModel = -1;
    this.renderedInv = -1;
    this.models = [];

    this.el.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    this.el.addEventListener('pointermove', (e) => this.onPointerMove(e));
    // A slot appearing under a resting cursor (page switches) fires pointerover without a move.
    this.el.addEventListener('pointerover', (e) => {
      this.ui.trackMouse(e);
      this.setHover(this.slotFromTarget(e.target));
    });
    this.el.addEventListener('contextmenu', (e) => e.preventDefault());
    this.el.addEventListener('mousedown', (e) => {
      if (e.button === 1) e.preventDefault(); // no middle-click autoscroll
    });
    this.el.addEventListener('pointerleave', () => this.setHover(null));
  }

  // ------------------------------------------------------------------ building
  /** Add a slot; (x, y) is the item position inside `parent` (Minecraft slot coordinates). */
  addSlot(ref, x, y, { big = false, parent = this.panel, className = '' } = {}) {
    const size = big ? 26 : 18;
    const off = big ? 5 : 1;
    const el = h('div', { className: `slot${big ? ' slot-big' : ''}${className ? ' ' + className : ''}` });
    place(el, { x: x - off, y: y - off, w: size, hgt: size });
    const view = createItemView();
    el.appendChild(view);
    parent.appendChild(el);
    const entry = { el, view, ref };
    this.slots.push(entry);
    this.slotByEl.set(el, entry);
    return entry;
  }

  /** Player inventory: 27 main slots at (x, y) and the hotbar at (x, hotbarY). */
  addInventorySlots(x, y, hotbarY, parent = this.panel) {
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 9; c++) this.addSlot({ kind: 'inv', index: 9 + r * 9 + c }, x + c * 18, y + r * 18, { parent });
    }
    for (let c = 0; c < 9; c++) this.addSlot({ kind: 'inv', index: c }, x + c * 18, hotbarY, { parent });
  }

  addGrid(width, x, y) {
    for (let r = 0; r < width; r++) {
      for (let c = 0; c < width; c++) this.addSlot({ kind: 'grid', index: r * width + c }, x + c * 18, y + r * 18);
    }
  }

  addLabel(text, x, y, parent = this.panel) {
    const el = h('div', { className: 'container-label', text });
    place(el, { x, y });
    parent.appendChild(el);
    return el;
  }

  /** Title centred over the panel width (Minecraft furnace / chest titles). */
  addCenteredLabel(text, y, parent = this.panel) {
    const el = h('div', { className: 'container-label container-label-center', text });
    place(el, { x: 0, y, w: this.width });
    parent.appendChild(el);
    return el;
  }

  addImage(className, x, y, w, hgt, parent = this.panel) {
    const el = h('div', { className });
    place(el, { x, y, w, hgt });
    parent.appendChild(el);
    return el;
  }

  /** Black preview box with the 3D player model (`pixel` = GUI px per skin pixel). */
  addPlayerPreview(x, y, w, hgt, pixel, parent = this.panel) {
    const box = h('div', { className: 'player-box' });
    place(box, { x, y, w, hgt });
    const model = new PlayerModel();
    box.appendChild(model.el);
    parent.appendChild(box);
    this.models.push({ model, box, pixel, w: w - 2, hgt: hgt - 2, key: 0 });
    return box;
  }

  /** Size and draw the player previews (every frame while open; cheap: ~30 faces). */
  renderModels() {
    const scale = this.ui.scale; // device pixels per GUI pixel
    const t = performance.now() / 1000;
    for (let i = 0; i < this.models.length; i++) {
      const m = this.models[i];
      if (!m.box.offsetParent) continue;
      if (m.key !== scale) {
        m.key = scale;
        const s = Math.max(1, Math.round(m.pixel * scale));
        const wDev = Math.round(m.w * scale);
        const hDev = Math.round(m.hgt * scale);
        m.model.setSize(wDev, hDev, s, Math.round((hDev - 32 * s) / 2 + s));
        m.model.el.style.width = gp(m.w);
        m.model.el.style.height = gp(m.hgt);
      }
      m.model.render(t);
    }
  }

  // ------------------------------------------------------------------ lifecycle
  onOpen() {
    this.render(true);
    this.resolveHover();
  }

  /**
   * Hover the slot under the current mouse position even if the mouse does not move (Minecraft picks
   * the hovered slot from the mouse position every frame): after opening and after page switches.
   */
  resolveHover() {
    const m = this.ui.mouse;
    if (!(m.x >= 0 && m.y >= 0) || typeof document === 'undefined' || !document.elementFromPoint) return;
    const el = document.elementFromPoint(m.x, m.y);
    this.setHover(el && this.el.contains(el) ? this.slotFromTarget(el) : null);
  }

  onClose() {
    this.drag = null;
    // Dying with the screen open: like Minecraft, the grid and the held stack fall with the rest of the
    // (already dropped) inventory instead of going back into it. Creative deaths keep the inventory.
    if (this.game.player?.dead && this.game.player.mode !== 'creative') this.model.dropAll();
    else this.model.close();
    this.ui.setCursorStack(null);
    this.ui.hideTooltip();
  }

  update() {
    this.render(false);
    this.renderModels();
  }

  // ------------------------------------------------------------------ rendering
  render(force) {
    const inv = this.model.inventory;
    const cv = this.container ? this.container.version : 0;
    if (!force && this.renderedModel === this.model.version && this.renderedInv === inv.version &&
      this.renderedContainer === cv) return;
    this.renderedModel = this.model.version;
    this.renderedInv = inv.version;
    this.renderedContainer = cv;
    let preview = null;
    let dragKeys = null;
    if (this.drag && this.drag.refs.length > 1) {
      preview = new Map();
      const plan = this.model.planDrag(this.drag.refs, this.drag.button);
      for (const s of plan.stacks) preview.set(slotKey(s.ref), s.stack);
      preview.remaining = plan.remaining;
    }
    if (this.drag) dragKeys = this.drag.keys;
    const icons = this.ui.icons;
    for (const s of this.slots) {
      const key = slotKey(s.ref);
      const stack = preview?.get(key) ?? this.model.get(s.ref);
      setItemView(s.view, stack, icons);
      s.el.classList.toggle('drag', !!dragKeys && dragKeys.has(key) && this.drag.refs.length > 1);
    }
    const cur = this.model.cursor;
    if (preview && cur) this.ui.setCursorStack(preview.remaining > 0 ? { ...cur, count: preview.remaining } : null);
    else this.ui.setCursorStack(cur);
    this.refreshTooltip();
  }

  // ------------------------------------------------------------------ hover / tooltip
  slotFromTarget(target) {
    const el = target?.closest?.('.slot');
    return el ? this.slotByEl.get(el) ?? null : null;
  }

  setHover(entry) {
    if (this.hover === entry) return;
    this.hover = entry;
    this.refreshTooltip();
  }

  /** Extra tooltip lines (creative search shows the tab name). */
  tooltipExtra() {
    return [];
  }

  refreshTooltip() {
    const s = this.hover;
    const stack = s && !this.model.cursor ? this.model.get(s.ref) : null;
    if (!stack) {
      if (!this.hoverTooltip) this.ui.hideTooltip();
      return;
    }
    this.ui.showTooltip(stackTooltip(stack, this.tooltipExtra(stack)));
  }

  // ------------------------------------------------------------------ pointer input
  isOutside(target) {
    return target === this.el;
  }

  onPointerDown(e) {
    const button = MC_BUTTON[e.button];
    if (button === undefined) return;
    this.ui.trackMouse(e);
    const entry = this.slotFromTarget(e.target);
    if (!entry) {
      if (this.isOutside(e.target)) {
        this.model.clickOutside(button === 1 ? 1 : 0);
        this.render(true);
      }
      return;
    }
    e.preventDefault();
    const ref = entry.ref;
    const key = slotKey(ref);
    const now = performance.now();
    if (button === 2) {
      if (this.model.creative) {
        if (this.model.cursor && this.model.isStorage(ref)) this.beginDrag(ref, 2, false);
        else this.model.middleClick(ref);
      }
      this.render(true);
      return;
    }
    if (e.shiftKey) {
      const stack = this.model.get(ref);
      const last = this.lastShift;
      if (last && last.key === key && now - last.time < 250 && last.id) {
        this.model.shiftDoubleClick(ref, last.id);
        this.lastShift = null;
      } else {
        this.lastShift = { key, time: now, id: stack?.id ?? 0 };
        this.model.shiftClick(ref);
      }
      this.render(true);
      return;
    }
    const isDouble = button === 0 && this.lastClick.key === key && now - this.lastClick.time < 250;
    this.lastClick = { key, time: now };
    if (!this.model.cursor || !this.model.isStorage(ref)) {
      this.model.click(ref, button);
      this.render(true);
      return;
    }
    this.beginDrag(ref, button, isDouble);
  }

  beginDrag(ref, button, isDouble) {
    this.drag = { button, refs: [], keys: new Set(), start: ref, double: isDouble };
    if (this.model.canDragInto(ref, button, 0)) {
      this.drag.refs.push(ref);
      this.drag.keys.add(slotKey(ref));
    }
    this.render(true);
  }

  onPointerMove(e) {
    this.ui.trackMouse(e);
    const entry = this.slotFromTarget(e.target);
    this.setHover(entry);
    const d = this.drag;
    if (d) {
      if (!(e.buttons & BUTTON_BIT[d.button])) {
        this.endDrag(e);
      } else if (entry && !d.keys.has(slotKey(entry.ref)) && this.model.canDragInto(entry.ref, d.button, d.refs.length)) {
        d.refs.push(entry.ref);
        d.keys.add(slotKey(entry.ref));
        this.render(true);
      }
    }
    this.lookAtMouse(e.clientX, e.clientY);
  }

  /** Global pointerup (forwarded by UIManager so releases outside the window also end drags). */
  onPointerUp(e) {
    if (this.drag) this.endDrag(e);
  }

  /**
   * Finish a press-drag-release with a held stack (Minecraft QUICK_CRAFT): several slots → split; exactly
   * one slot → a plain click on THAT slot (not on the start slot); no valid slot → a click on the slot
   * under the pointer at release, or a drop when released outside the window. `e` = the releasing
   * pointer event (absent when the window lost focus: the start slot is clicked).
   */
  endDrag(e) {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    if (d.double && d.button === 0 && !this.model.get(d.start)) {
      this.model.pickupAll(d.start);
    } else if (d.refs.length > 1) {
      this.model.drag(d.refs, d.button);
    } else if (d.refs.length === 1) {
      if (d.button === 2) this.model.drag(d.refs, 2);
      else this.model.click(d.refs[0], d.button);
    } else if (!e) {
      if (d.button !== 2) this.model.click(d.start, d.button);
    } else {
      const entry = this.slotFromTarget(e.target);
      if (entry) {
        if (d.button !== 2) this.model.click(entry.ref, d.button);
      } else if (this.isOutside(e.target) && d.button !== 2) {
        this.model.clickOutside(d.button === 1 ? 1 : 0);
      }
    }
    this.render(true);
  }

  /** Turn the player previews toward a client-space point (eyes = 28 skin px above the feet). */
  lookAtMouse(x, y) {
    for (const { model } of this.models) {
      if (!model.el.offsetParent || !model.width) continue;
      const r = model.el.getBoundingClientRect();
      const k = r.height / model.height; // client px per canvas px
      const eyeX = r.left + r.width / 2;
      const eyeY = r.top + (model.height - model.feet - 28 * model.pixel) * k;
      const unit = this.ui.unit;
      model.lookAt((x - eyeX) / unit, (y - eyeY) / unit);
    }
  }

  // ------------------------------------------------------------------ keyboard
  /** Keys while the screen is open. Returns true when handled. */
  onKeyDown(e) {
    const hover = this.hover;
    if (/^Digit[1-9]$/.test(e.code) && hover) {
      this.model.swapHotbar(hover.ref, Number(e.code.slice(5)) - 1);
      this.render(true);
      return true;
    }
    if (e.code === 'KeyQ' && hover) {
      this.model.throwFrom(hover.ref, e.ctrlKey || e.metaKey);
      this.render(true);
      return true;
    }
    return false;
  }
}

/** Survival inventory: player preview, 2x2 crafting grid, 27 + 9 slots. */
export class InventoryScreen extends ContainerScreen {
  constructor(ui) {
    super(ui, { name: 'inventory', gridWidth: 2 });
    this.addPlayerPreview(7, 7, 72, 72, 2);
    this.addLabel('合成', 97, 6);
    this.addGrid(2, 98, 18);
    this.addImage('craft-arrow-small', 135, 28, 16, 13);
    this.result = this.addSlot({ kind: 'result' }, 154, 28);
    this.addInventorySlots(8, 84, 142);
  }
}

/** Crafting table: 3x3 grid, big result slot, inventory. */
export class CraftingScreen extends ContainerScreen {
  constructor(ui) {
    super(ui, { name: 'crafting', gridWidth: 3 });
    this.addLabel('合成', 28, 6);
    this.addGrid(3, 30, 17);
    this.addImage('craft-arrow', 90, 35, 22, 15);
    this.result = this.addSlot({ kind: 'result' }, 124, 35, { big: true });
    this.addLabel('物品栏', 8, 72);
    this.addInventorySlots(8, 84, 142);
  }
}

// ---------------------------------------------------------------------------------------------
// Block entity containers (furnace, chest)
// ---------------------------------------------------------------------------------------------

/**
 * Screen of a block entity: closes itself when the block entity is removed (block broken / exploded),
 * when the player moves more than 8 blocks away from it or dies (Minecraft AbstractContainerMenu.stillValid).
 */
export class BlockEntityScreen extends ContainerScreen {
  constructor(ui, opts) {
    super(ui, opts);
    this.blockEntity = opts.container;
  }

  /** Still usable: the entity exists and the player is alive and within reach of the block centre. */
  stillValid() {
    const be = this.blockEntity;
    const p = this.game.player;
    if (!be || be.removed || !p || p.dead || this.game.state !== 'playing') return false;
    if (!Number.isFinite(p.x)) return true;
    const dx = p.x - (be.x + 0.5), dy = p.y - (be.y + 0.5), dz = p.z - (be.z + 0.5);
    return dx * dx + dy * dy + dz * dz <= CONTAINER_REACH * CONTAINER_REACH;
  }

  update(dt) {
    if (!this.stillValid()) {
      // (while the world unloads the UI manager closes in-game screens itself)
      if (this.ui.screen === this && this.game.state === 'playing') this.ui.closeScreen();
      return;
    }
    super.update(dt);
  }

  /** Sound at the block centre. */
  playBlockSound(name, volume, pitch) {
    const be = this.blockEntity;
    if (be) this.game.audio?.play?.(name, { x: be.x + 0.5, y: be.y + 0.5, z: be.z + 0.5, volume, pitch });
  }
}

/**
 * Furnace (Minecraft furnace GUI, 176x166): input (56, 17), fuel (56, 53), output (116, 35, big slot),
 * flame (56, 36) shrinking with the remaining fuel, arrow (79, 34) filling with the cooking progress.
 */
export class FurnaceScreen extends BlockEntityScreen {
  constructor(ui, furnace) {
    super(ui, { name: 'furnace', container: furnace, creative: ui.game.player?.mode === 'creative' });
    this.addCenteredLabel('熔炉', 6);
    this.addSlot({ kind: 'container', index: 0 }, 56, 17);
    this.addImage('furnace-flame-bg', 56, 36, 14, 14);
    this.flame = this.addImage('furnace-flame', 56, 36, 14, 14);
    this.addSlot({ kind: 'container', index: 1 }, 56, 53);
    this.addImage('furnace-arrow-bg', 79, 34, 24, 16);
    this.arrow = this.addImage('furnace-arrow', 79, 34, 0, 16);
    this.result = this.addSlot({ kind: 'container', index: 2 }, 116, 35, { big: true });
    this.addLabel('物品栏', 8, 72);
    this.addInventorySlots(8, 84, 142);
    this.flameHeight = -1;
    this.arrowWidth = -1;
    this.updateProgress();
  }

  /** Flame = fire left (ceil(lit·13) + 1 rows from the bottom), arrow = ceil(progress·24) columns. */
  updateProgress() {
    const f = this.blockEntity;
    const k = f && f.burnTicks > 0 ? Math.min(14, Math.ceil(f.litProgress * 13) + 1) : 0;
    if (k !== this.flameHeight) {
      this.flameHeight = k;
      const s = this.flame.style;
      s.display = k > 0 ? '' : 'none';
      s.top = gp(36 + 14 - k);
      s.height = gp(k);
    }
    const w = f ? Math.min(24, Math.ceil(f.cookProgress * 24)) : 0;
    if (w !== this.arrowWidth) {
      this.arrowWidth = w;
      this.arrow.style.width = gp(w);
      this.arrow.style.display = w > 0 ? '' : 'none';
    }
  }

  update(dt) {
    super.update(dt);
    if (this.ui.screen === this) this.updateProgress();
  }
}

/** Single chest (Minecraft generic_54 with 3 rows, 176x168): 27 slots, then the player inventory. */
export class ChestScreen extends BlockEntityScreen {
  constructor(ui, chest) {
    super(ui, { name: 'chest', container: chest, creative: ui.game.player?.mode === 'creative', height: 168 });
    this.addLabel('箱子', 8, 6);
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 9; c++) this.addSlot({ kind: 'container', index: r * 9 + c }, 8 + c * 18, 18 + r * 18);
    }
    this.addLabel('物品栏', 8, 74);
    this.addInventorySlots(8, 85, 143);
  }

  onOpen() {
    super.onOpen();
    // ChestBlockEntity.playSound: volume 0.5, pitch 0.9..1.0
    this.playBlockSound('chest_open', 0.5, 0.9 + Math.random() * 0.1);
  }

  onClose() {
    super.onClose();
    this.playBlockSound('chest_close', 0.5, 0.9 + Math.random() * 0.1);
  }
}

// ---------------------------------------------------------------------------------------------
// Creative inventory
// ---------------------------------------------------------------------------------------------
const CREATIVE_W = 195;
const CREATIVE_H = 136;
const GRID_COLS = 9;
const GRID_ROWS = 5;

/**
 * Grid cell of creative tab `i`: building / decoration / nature on top, tools, food, materials and spawn
 * eggs in the bottom row (Minecraft 1.19.3+ also has Spawn Eggs in the bottom row); column 5 is reserved
 * for the search (top) and inventory (bottom) tabs.
 */
function tabCell(i) {
  if (i < 3) return { row: 0, col: i };
  if (i < 8) return { row: 1, col: i - 3 };
  return { row: 0, col: Math.min(4, i - 5) };
}

/** Items per creative tab, in registry order. */
function tabItems(tabId) {
  return ALL_ITEM_IDS.filter((id) => getItem(id).creativeTab === tabId);
}

/** Search: Chinese display name, internal name (with or without underscores) or numeric id. */
export function searchItems(query) {
  const q = query.trim().toLowerCase();
  if (!q) return ALL_ITEM_IDS.slice();
  const qq = q.replace(/\s+/g, '_');
  return ALL_ITEM_IDS.filter((id) => {
    const it = getItem(id);
    return it.displayName.includes(query.trim()) || it.name.includes(qq) || it.name.replace(/_/g, ' ').includes(q) ||
      String(id) === q;
  });
}

export class CreativeScreen extends ContainerScreen {
  constructor(ui) {
    super(ui, { name: 'creative', creative: true, width: CREATIVE_W, height: CREATIVE_H });
    this.el.classList.add('screen-creative');
    this.tabs = [
      ...CREATIVE_TABS.map((t, i) => ({ id: t.id, name: t.name, ...tabCell(i), items: tabItems(t.id) })),
      { id: 'search', name: '搜索物品', row: 0, col: 5, search: true },
      { id: 'inventory', name: '物品栏', row: 1, col: 5, inventory: true },
    ];
    this.tabEls = new Map();
    for (const t of this.tabs) this.buildTab(t);

    this.title = this.addLabel('', 8, 6);

    // --- item page: 9x5 grid + scrollbar + search field
    this.itemPage = h('div', { className: 'creative-page' });
    this.panel.appendChild(this.itemPage);
    this.gridSlots = [];
    for (let r = 0; r < GRID_ROWS; r++) {
      for (let c = 0; c < GRID_COLS; c++) {
        this.gridSlots.push(this.addSlot({ kind: 'creative', itemId: 0 }, 9 + c * 18, 18 + r * 18, { parent: this.itemPage }));
      }
    }
    this.scrollTrack = h('div', { className: 'creative-scroll' });
    place(this.scrollTrack, { x: 174, y: 17, w: 14, hgt: 114 });
    this.scrollThumb = h('div', { className: 'creative-thumb' });
    this.scrollTrack.appendChild(this.scrollThumb);
    this.itemPage.appendChild(this.scrollTrack);
    this.searchBox = h('div', { className: 'creative-search' });
    place(this.searchBox, { x: 81, y: 4, w: 90, hgt: 12 });
    this.searchInput = h('input', { type: 'text', spellcheck: 'false', autocomplete: 'off', maxlength: '50' });
    this.searchBox.appendChild(this.searchInput);
    this.itemPage.appendChild(this.searchBox);
    this.searchInput.addEventListener('input', () => {
      this.items = searchItems(this.searchInput.value);
      this.scrollRow = 0;
      this.layoutItems();
    });

    // --- inventory page
    this.invPage = h('div', { className: 'creative-page' });
    this.panel.appendChild(this.invPage);
    this.addPlayerPreview(64, 5, 66, 45, 1.25, this.invPage);
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 9; c++) this.addSlot({ kind: 'inv', index: 9 + r * 9 + c }, 9 + c * 18, 54 + r * 18, { parent: this.invPage });
    }
    this.destroySlot = this.addSlot({ kind: 'destroy' }, 173, 112, { parent: this.invPage, className: 'slot-destroy' });

    // hotbar row (both pages)
    for (let c = 0; c < 9; c++) this.addSlot({ kind: 'inv', index: c }, 9 + c * 18, 112);

    // scrolling
    this.scrollRow = 0;
    this.el.addEventListener('wheel', (e) => {
      if (this.tab.inventory) return;
      e.preventDefault();
      this.scrollBy(Math.sign(e.deltaY));
    }, { passive: false });
    this.thumbDrag = null;
    this.scrollTrack.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || this.maxScroll() <= 0) return;
      e.preventDefault();
      e.stopPropagation();
      this.thumbDrag = true;
      capturePointer(this.scrollTrack, e.pointerId);
      this.scrollToPointer(e.clientY);
    });
    this.scrollTrack.addEventListener('pointermove', (e) => {
      if (this.thumbDrag) this.scrollToPointer(e.clientY);
    });
    const stopThumb = (e) => {
      this.thumbDrag = null;
      capturePointer(this.scrollTrack, e.pointerId, false);
    };
    this.scrollTrack.addEventListener('pointerup', stopThumb);
    this.scrollTrack.addEventListener('pointercancel', stopThumb);

    const last = ui.lastCreativeTab && this.tabs.find((t) => t.id === ui.lastCreativeTab);
    this.selectTab(last ?? this.tabs[0]);
  }

  buildTab(t) {
    const top = t.row === 0;
    const x = t.col === 5 ? CREATIVE_W - 28 : t.col * 29;
    const y = top ? -28 : CREATIVE_H - 4;
    const el = h('div', { className: `ctab ${top ? 'ctab-top' : 'ctab-bottom'}` });
    place(el, { x, y, w: 28, hgt: 32 });
    let icon;
    if (t.search) icon = h('div', { className: 'ctab-icon ctab-icon-search' });
    else if (t.inventory) icon = h('div', { className: 'ctab-icon ctab-icon-chest' });
    else {
      icon = createItemView('item ctab-item');
      setItemView(icon, t.items.length ? { id: t.items[0], count: 1 } : null, this.ui.icons);
    }
    icon.style.top = gp(top ? 9 : 7);
    el.appendChild(icon);
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      if (this.tab !== t) {
        this.ui.playClick();
        this.selectTab(t);
      }
    });
    el.addEventListener('pointerenter', () => {
      this.hoverTooltip = true;
      this.ui.showTooltip([{ text: t.name }]);
    });
    el.addEventListener('pointerleave', () => {
      this.hoverTooltip = false;
      this.ui.hideTooltip();
    });
    this.panel.appendChild(el);
    this.tabEls.set(t.id, el);
  }

  selectTab(t) {
    this.tab = t;
    this.ui.lastCreativeTab = t.id;
    for (const [id, el] of this.tabEls) el.classList.toggle('selected', id === t.id);
    this.title.textContent = t.inventory ? '' : t.name;
    this.title.style.display = t.search ? 'none' : '';
    this.model.creativeItemTab = !t.inventory;
    this.itemPage.style.display = t.inventory ? 'none' : '';
    this.invPage.style.display = t.inventory ? '' : 'none';
    this.searchBox.style.display = t.search ? '' : 'none';
    this.panel.classList.toggle('creative-search-tab', !!t.search);
    this.panel.classList.toggle('creative-inventory-tab', !!t.inventory);
    if (t.search) {
      this.items = searchItems(this.searchInput.value);
      requestAnimationFrame(() => this.searchInput.focus({ preventScroll: true }));
    } else {
      this.items = t.items ?? [];
      if (document.activeElement === this.searchInput) this.searchInput.blur();
    }
    this.scrollRow = 0;
    this.layoutItems();
    this.render(true);
    this.resolveHover();
  }

  maxScroll() {
    return Math.max(0, Math.ceil((this.items?.length ?? 0) / GRID_COLS) - GRID_ROWS);
  }

  scrollBy(rows) {
    const next = Math.max(0, Math.min(this.maxScroll(), this.scrollRow + rows));
    if (next !== this.scrollRow) {
      this.scrollRow = next;
      this.layoutItems();
    }
  }

  scrollToPointer(clientY) {
    const r = this.scrollTrack.getBoundingClientRect();
    const unit = this.ui.unit;
    const t = (clientY - r.top - 1 * unit - 7.5 * unit) / (r.height - 2 * unit - 15 * unit);
    const next = Math.round(Math.max(0, Math.min(1, t)) * this.maxScroll());
    if (next !== this.scrollRow) {
      this.scrollRow = next;
      this.layoutItems();
    }
  }

  layoutItems() {
    const items = this.items ?? [];
    const start = this.scrollRow * GRID_COLS;
    this.gridSlots.forEach((s, i) => {
      s.ref = { kind: 'creative', itemId: items[start + i] ?? 0 };
    });
    const max = this.maxScroll();
    this.scrollThumb.classList.toggle('disabled', max <= 0);
    this.scrollThumb.style.top = gp(1 + (max > 0 ? Math.round((112 - 15) * (this.scrollRow / max)) : 0));
    this.render(true);
  }

  tooltipExtra(stack) {
    if (!this.tab?.search) return [];
    const tabId = getItem(stack.id)?.creativeTab;
    const tab = CREATIVE_TABS.find((t) => t.id === tabId);
    return tab ? [{ text: tab.name, color: '#5555FF' }] : [];
  }

  onKeyDown(e) {
    if (e.target === this.searchInput) return false;
    if (e.code === 'KeyT' && !this.tab.search) {
      this.selectTab(this.tabs.find((t) => t.search));
      return true;
    }
    return super.onKeyDown(e);
  }
}

/** Render a tooltip (lines of {text, color}) into an element (Minecraft's purple-bordered box). */
export function fillTooltip(el, lines) {
  el.textContent = '';
  lines.forEach((l, i) => {
    const row = h('div', { className: i === 0 ? 'tooltip-title' : 'tooltip-line' });
    renderFormatted(row, l.text, l.color ?? '#FFFFFF');
    el.appendChild(row);
  });
}
