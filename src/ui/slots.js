// Container slot logic with Minecraft (Java Edition) click semantics. Pure (no DOM): the inventory
// screens in containers.js map DOM elements to slot refs and forward mouse/keyboard actions here,
// and tests/ui-slots.test.js exercises it under Node.
//
// Slot refs:   { kind: 'inv', index }      player inventory slot (0..8 hotbar, 9..35 main)
//              { kind: 'grid', index }     crafting grid cell (row-major, gridWidth x gridWidth)
//              { kind: 'result' }          crafting output (take-only)
//              { kind: 'creative', itemId } infinite creative source (itemId 0 = empty cell)
//              { kind: 'destroy' }         creative "destroy item" slot
//              { kind: 'container', index } slot of an open container (chest / furnace block entity)
// Mouse buttons use the Minecraft/LWJGL convention: 0 = left, 1 = right, 2 = middle.
//
// Containers (src/game/blockentities.js) bring their own slot rules, like Minecraft's Slot / Menu:
//   container.get(i) / set(i, stack), size, mayPlace(i, stack) (furnace output: take only; fuel slot:
//   fuels + buckets), slotMax(i, stack), quickMoveOut(i) -> 'reverse' | 'forward' (shift-click into the
//   inventory: hotbar-first from the right, or main-first), quickMoveIn(stack) -> slot indices | null
//   (shift-click from the inventory; null = the item does not go in, move it hotbar <-> main instead).
import { maxStackSize } from '../world/registry.js';
import { canMerge, makeStack } from '../game/inventory.js';
import { matchRecipe, consumeIngredients } from '../game/crafting.js';

const HOTBAR = [0, 1, 2, 3, 4, 5, 6, 7, 8];
const MAIN = Array.from({ length: 27 }, (_, i) => i + 9);
/** Shift-click target order for crafting results: hotbar right-to-left, then main bottom-up (MC). */
const RESULT_ORDER = [...HOTBAR].reverse().concat([...MAIN].reverse());
/** Order used when moving items out of the crafting grid: main inventory first, then the hotbar. */
const INVENTORY_ORDER = MAIN.concat(HOTBAR);
/** The whole player inventory in menu order (main rows top-down, then the hotbar). */
const ALL_INVENTORY = INVENTORY_ORDER;

function copy(s, count = s.count) {
  return { id: s.id, count, damage: s.damage ?? 0 };
}

/** Stable string key for a slot ref (Map keys, DOM datasets). */
export function slotKey(ref) {
  switch (ref.kind) {
    case 'inv': case 'grid': case 'container': return `${ref.kind}:${ref.index}`;
    case 'creative': return `creative:${ref.itemId}`;
    default: return ref.kind;
  }
}

export class ContainerModel {
  /**
   * @param {object} o
   * @param {import('../game/inventory.js').Inventory} o.inventory  player inventory (36 slots)
   * @param {number} [o.gridWidth=0]   0 = no crafting grid, 2 = inventory 2x2, 3 = crafting table
   * @param {boolean} [o.creative=false] creative semantics (middle-click clone, destroy slot, ...)
   * @param {(stack:object) => void} [o.onDrop]  throw a stack into the world (game.dropFromPlayer)
   * @param {() => number} [o.getSelectedSlot]  selected hotbar slot (creative shift-click fallback)
   * @param {object} [o.container] open container (block entity with the slot rules described above)
   */
  constructor({ inventory, gridWidth = 0, creative = false, onDrop = () => {}, getSelectedSlot = () => 0, container = null }) {
    this.inventory = inventory;
    this.gridWidth = gridWidth;
    this.grid = new Array(gridWidth * gridWidth).fill(null);
    this.creative = creative;
    /** Open container (chest / furnace block entity) or null. */
    this.container = container;
    /** True while the creative screen shows an item tab (hotbar shift-click deletes, as in MC). */
    this.creativeItemTab = false;
    this.onDrop = onDrop;
    this.getSelectedSlot = getSelectedSlot;
    /** Stack held by the mouse cursor, or null. */
    this.cursor = null;
    /** Current crafting output (fresh stack) and its recipe. */
    this.result = null;
    this.recipe = null;
    /** Incremented on every change made through this model (views re-render on change). */
    this.version = 0;
  }

  // ------------------------------------------------------------------ slot access
  /** Stack shown in a slot (creative sources report a single item). */
  get(ref) {
    switch (ref.kind) {
      case 'inv': return this.inventory.get(ref.index);
      case 'grid': return this.grid[ref.index] ?? null;
      case 'result': return this.result;
      case 'creative': return ref.itemId ? makeStack(ref.itemId, 1) : null;
      case 'container': return this.container ? this.container.get(ref.index) ?? null : null;
      default: return null;
    }
  }

  /** Replace the stack of a storage slot (inv / grid / container). */
  set(ref, stack) {
    const s = stack && stack.count > 0 ? stack : null;
    if (ref.kind === 'inv') {
      this.inventory.set(ref.index, s);
    } else if (ref.kind === 'grid') {
      this.grid[ref.index] = s;
      this.updateResult();
    } else if (ref.kind === 'container' && this.container) {
      this.container.set(ref.index, s);
    }
  }

  /** True for slots that hold real items (inventory, crafting grid, container slots). */
  isStorage(ref) {
    return ref.kind === 'inv' || ref.kind === 'grid' || (ref.kind === 'container' && !!this.container);
  }

  /** Slot.mayPlace: may `stack` be put into this slot by the player? */
  mayPlace(ref, stack) {
    if (!stack) return false;
    if (ref.kind === 'inv' || ref.kind === 'grid') return true;
    if (ref.kind === 'container' && this.container) return this.container.mayPlace(ref.index, stack) !== false;
    return false;
  }

  /** Slot.getMaxStackSize(stack): how many of `stack` fit into this slot. */
  slotMax(ref, stack) {
    if (ref.kind === 'container' && this.container && typeof this.container.slotMax === 'function') {
      return this.container.slotMax(ref.index, stack);
    }
    return maxStackSize(stack.id);
  }

  /** Refs of every container slot (empty array without a container). */
  containerRefs() {
    const c = this.container;
    if (!c) return [];
    const n = c.size ?? c.slots?.length ?? 0;
    const out = [];
    for (let i = 0; i < n; i++) out.push({ kind: 'container', index: i });
    return out;
  }

  /** Recompute the crafting output from the grid. */
  updateResult() {
    if (!this.gridWidth) {
      this.result = null;
      this.recipe = null;
      return;
    }
    const m = matchRecipe(this.grid, this.gridWidth);
    this.result = m ? m.result : null;
    this.recipe = m ? m.recipe : null;
  }

  _changed() {
    this.version++;
  }

  _setCursor(stack) {
    this.cursor = stack && stack.count > 0 ? stack : null;
  }

  // ------------------------------------------------------------------ crafting output
  /** Consume one set of ingredients for the current result. */
  _craftOnce() {
    consumeIngredients(this.grid, this.gridWidth, this.recipe);
    this.updateResult();
  }

  /** Take the result onto the cursor (both mouse buttons). Returns true if something was crafted. */
  _takeResult() {
    const r = this.result;
    if (!r) return false;
    const cur = this.cursor;
    if (!cur) {
      this.cursor = copy(r);
    } else if (canMerge(cur, r) && cur.count + r.count <= maxStackSize(r.id)) {
      this.cursor = copy(cur, cur.count + r.count);
    } else {
      return false;
    }
    this._craftOnce();
    return true;
  }

  /** Shift-click on the result: craft repeatedly into the inventory (hotbar right-to-left first). */
  _craftAll() {
    let guard = 0;
    while (this.result && guard++ < 640) {
      const r = copy(this.result);
      const left = this._mergeInto(copy(r), RESULT_ORDER);
      if (left === r.count) break; // nothing fits any more
      if (left > 0) this.onDrop(copy(r, left)); // Minecraft drops what did not fit
      this._craftOnce();
      if (!this.result || this.result.id !== r.id) break;
    }
  }

  // ------------------------------------------------------------------ helpers
  /**
   * Merge `stack` into inventory slots in `order`: first into existing stacks, then into the first
   * empty slot (Container.mergeItemStack). Returns the count that did not fit.
   */
  _mergeInto(stack, order) {
    const inv = this.inventory;
    const max = maxStackSize(stack.id);
    let remaining = stack.count;
    if (max > 1) {
      for (const i of order) {
        if (remaining <= 0) break;
        const s = inv.get(i);
        if (s && canMerge(s, stack) && s.count < max) {
          const n = Math.min(max - s.count, remaining);
          inv.set(i, copy(s, s.count + n));
          remaining -= n;
        }
      }
    }
    if (remaining > 0) {
      for (const i of order) {
        if (!inv.get(i)) {
          const n = Math.min(max, remaining);
          inv.set(i, copy(stack, n));
          remaining -= n;
          break;
        }
      }
    }
    return remaining;
  }

  // ------------------------------------------------------------------ mouse actions
  /**
   * Plain click (Minecraft PICKUP): pick up / place / merge / swap; right button splits or places one.
   * @param {object} ref
   * @param {number} button 0 left, 1 right
   */
  click(ref, button = 0) {
    if (!ref) return;
    if (ref.kind === 'result') {
      if (this._takeResult()) this._changed();
      return;
    }
    if (ref.kind === 'creative') {
      this._clickCreative(ref, button);
      return;
    }
    if (ref.kind === 'destroy') {
      if (this.cursor) {
        this.cursor = null;
        this._changed();
      }
      return;
    }
    if (!this.isStorage(ref)) return;
    const slot = this.get(ref);
    const cur = this.cursor;
    if (!slot && !cur) return;
    if (!slot) {
      if (!this.mayPlace(ref, cur)) return;
      const n = button === 0 ? Math.min(cur.count, this.slotMax(ref, cur)) : 1;
      if (n <= 0) return;
      this.set(ref, copy(cur, n));
      this._setCursor(copy(cur, cur.count - n));
    } else if (!cur) {
      const n = button === 0 ? slot.count : Math.ceil(slot.count / 2);
      this._setCursor(copy(slot, n));
      this.set(ref, copy(slot, slot.count - n));
    } else if (this.mayPlace(ref, cur)) {
      if (canMerge(slot, cur)) {
        const room = this.slotMax(ref, slot) - slot.count;
        const n = Math.min(room, button === 0 ? cur.count : 1);
        if (n <= 0) return;
        this.set(ref, copy(slot, slot.count + n));
        this._setCursor(copy(cur, cur.count - n));
      } else if (cur.count <= this.slotMax(ref, cur)) {
        // different items (or unstackable tools): swap cursor and slot
        this.set(ref, copy(cur));
        this._setCursor(copy(slot));
      } else {
        return;
      }
    } else if (canMerge(slot, cur)) {
      // Take-only slot (furnace output) with the same item on the cursor: take as many as fit (Minecraft).
      const n = Math.min(slot.count, maxStackSize(cur.id) - cur.count);
      if (n <= 0) return;
      this._setCursor(copy(cur, cur.count + n));
      this.set(ref, copy(slot, slot.count - n));
    } else {
      return;
    }
    this._changed();
  }

  /** Creative source cell. Left takes a full stack, right takes one; clicking with an item deletes it. */
  _clickCreative(ref, button) {
    const id = ref.itemId;
    const cur = this.cursor;
    if (!cur) {
      if (!id) return;
      this.cursor = makeStack(id, button === 0 ? maxStackSize(id) : 1);
    } else if (id && cur.id === id && (cur.damage ?? 0) === 0 && maxStackSize(id) > 1) {
      if (button === 0) this.cursor = copy(cur, maxStackSize(id));
      else this._setCursor(copy(cur, cur.count - 1));
    } else if (button === 0) {
      this.cursor = null; // dropping an item into the creative grid destroys it
    } else {
      this._setCursor(copy(cur, cur.count - 1));
    }
    this._changed();
  }

  /** Shift-click (QUICK_MOVE). */
  shiftClick(ref) {
    if (!ref) return;
    switch (ref.kind) {
      case 'result':
        this._craftAll();
        break;
      case 'creative':
        if (!ref.itemId) return;
        this._creativeToHotbar(ref.itemId);
        break;
      case 'destroy':
        if (!this.creative) return;
        this.inventory.clear(); // MC: shift-clicking the destroy slot clears the whole inventory
        break;
      case 'grid': {
        const s = this.get(ref);
        if (!s) return;
        const left = this._mergeInto(copy(s), INVENTORY_ORDER);
        this.set(ref, copy(s, left));
        break;
      }
      case 'container': {
        // Container -> player inventory (ChestMenu / AbstractFurnaceMenu.quickMoveStack).
        const s = this.get(ref);
        if (!s || !this.container) return;
        const order = this.container.quickMoveOut?.(ref.index) === 'forward' ? INVENTORY_ORDER : RESULT_ORDER;
        const left = this._mergeInto(copy(s), order);
        if (left === s.count) return;
        this.set(ref, left > 0 ? copy(s, left) : null);
        break;
      }
      case 'inv': {
        const s = this.get(ref);
        if (!s) return;
        if (this.creative && this.creativeItemTab) {
          // Item tabs only show the hotbar; Minecraft deletes the shift-clicked hotbar stack there.
          if (ref.index >= 9) return;
          this.inventory.set(ref.index, null);
          break;
        }
        if (this.container) {
          // Player inventory -> container slots chosen by the container (chest: any; furnace: smeltables
          // to the input, fuels to the fuel slot). null: the item does not go in -> hotbar <-> main.
          const targets = this.container.quickMoveIn?.(s) ?? null;
          if (targets) {
            const left = this._mergeIntoContainer(copy(s), targets);
            if (left === s.count) return;
            this.inventory.set(ref.index, left > 0 ? copy(s, left) : null);
            break;
          }
        }
        const target = ref.index < 9 ? MAIN : HOTBAR;
        const left = this._mergeInto(copy(s), target);
        if (left !== s.count) this.inventory.set(ref.index, left > 0 ? copy(s, left) : null);
        break;
      }
      default:
        return;
    }
    this._changed();
  }

  /**
   * Minecraft moveItemStackTo over container slots `indices`: merge into matching stacks first, then
   * put the rest into the first empty slot that accepts it. Returns the count that did not fit.
   */
  _mergeIntoContainer(stack, indices) {
    const c = this.container;
    let remaining = stack.count;
    if (maxStackSize(stack.id) > 1) {
      for (const i of indices) {
        if (remaining <= 0) break;
        const ref = { kind: 'container', index: i };
        const s = c.get(i);
        if (s && canMerge(s, stack) && this.mayPlace(ref, stack)) {
          const n = Math.min(this.slotMax(ref, s) - s.count, remaining);
          if (n > 0) {
            c.set(i, copy(s, s.count + n));
            remaining -= n;
          }
        }
      }
    }
    if (remaining > 0) {
      for (const i of indices) {
        const ref = { kind: 'container', index: i };
        if (!c.get(i) && this.mayPlace(ref, stack)) {
          const n = Math.min(this.slotMax(ref, stack), remaining);
          if (n <= 0) continue;
          c.set(i, copy(stack, n));
          remaining -= n;
          break;
        }
      }
    }
    return remaining;
  }

  /**
   * Shift + double-click: quick-move every stack of the same item from the clicked section (the crafting
   * grid, the open container, the whole player inventory in a container screen, else hotbar / main).
   */
  shiftDoubleClick(ref, itemId) {
    if (!ref || !itemId || !this.isStorage(ref)) return;
    let section;
    if (ref.kind === 'grid') section = this.grid.map((_, i) => ({ kind: 'grid', index: i }));
    else if (ref.kind === 'container') section = this.containerRefs();
    else if (this.container) section = ALL_INVENTORY.map((i) => ({ kind: 'inv', index: i }));
    else section = (ref.index < 9 ? HOTBAR : MAIN).map((i) => ({ kind: 'inv', index: i }));
    for (const r of section) {
      const s = this.get(r);
      if (s && s.id === itemId) this.shiftClick(r);
    }
  }

  /** Put a full stack of a creative item into the hotbar. */
  _creativeToHotbar(id) {
    const inv = this.inventory;
    const max = maxStackSize(id);
    if (max > 1) {
      for (let i = 0; i < 9; i++) {
        const s = inv.get(i);
        if (s && s.id === id && (s.damage ?? 0) === 0 && s.count < max) {
          inv.set(i, makeStack(id, max));
          return;
        }
      }
    }
    let slot = inv.firstEmpty(0, 9);
    if (slot < 0) slot = this.getSelectedSlot();
    inv.set(slot, makeStack(id, max));
  }

  /** Double-click with an item on the cursor (PICKUP_ALL): gather matching stacks into the cursor. */
  pickupAll(ref) {
    const cur = this.cursor;
    if (!cur || (ref && ref.kind === 'result')) return;
    const max = maxStackSize(cur.id);
    if (max <= 1) return;
    // Menu slot order: container slots, crafting grid, then the player inventory (main, hotbar).
    const order = this.containerRefs()
      .concat(this.grid.map((_, i) => ({ kind: 'grid', index: i })))
      .concat(INVENTORY_ORDER.map((i) => ({ kind: 'inv', index: i })));
    let count = cur.count;
    for (let pass = 0; pass < 2 && count < max; pass++) {
      for (const r of order) {
        if (count >= max) break;
        const s = this.get(r);
        if (!s || !canMerge(s, cur)) continue;
        if (pass === 0 && s.count >= max) continue; // first pass skips full stacks
        const n = Math.min(max - count, s.count);
        this.set(r, copy(s, s.count - n));
        count += n;
      }
    }
    if (count !== cur.count) {
      this.cursor = copy(cur, count);
      this._changed();
    }
  }

  /** Middle click (CLONE, creative only): full stack copy of the hovered item onto an empty cursor. */
  middleClick(ref) {
    if (!this.creative || this.cursor || !ref) return;
    const s = this.get(ref);
    if (!s) return;
    this.cursor = { id: s.id, count: maxStackSize(s.id), damage: s.damage ?? 0 };
    this._changed();
  }

  /**
   * Whether a slot may join a drag-split (QUICK_CRAFT) with `setSize` slots already in it.
   * @param {number} button 0 left (even split), 1 right (one each), 2 middle (creative full stacks)
   */
  canDragInto(ref, button, setSize) {
    const cur = this.cursor;
    if (!cur || !ref || !this.isStorage(ref) || !this.mayPlace(ref, cur)) return false;
    const s = this.get(ref);
    if (s && !canMerge(s, cur)) return false;
    if (button === 2) return this.creative;
    return cur.count > setSize;
  }

  /**
   * Distribution plan for a drag over `refs` (MC computeStackSize). Does not modify anything.
   * @returns {{ stacks: Array<{ ref, stack }>, remaining: number }}
   */
  planDrag(refs, button) {
    const cur = this.cursor;
    if (!cur || !refs.length) return { stacks: [], remaining: cur ? cur.count : 0 };
    const max = maxStackSize(cur.id);
    const per = button === 0 ? Math.floor(cur.count / refs.length) : button === 1 ? 1 : max;
    let remaining = cur.count;
    const stacks = [];
    for (const ref of refs) {
      if (!this.mayPlace(ref, cur)) continue;
      const s = this.get(ref);
      if (s && !canMerge(s, cur)) continue;
      const existing = s ? s.count : 0;
      const target = Math.min(this.slotMax(ref, cur), existing + per);
      const added = target - existing;
      if (added <= 0) continue;
      stacks.push({ ref, stack: copy(cur, target) });
      if (button !== 2) remaining -= added;
    }
    return { stacks, remaining };
  }

  /** Apply a drag-split over several slots. */
  drag(refs, button) {
    if (!this.cursor || !refs.length) return;
    const plan = this.planDrag(refs, button);
    for (const { ref, stack } of plan.stacks) this.set(ref, stack);
    this._setCursor(copy(this.cursor, plan.remaining));
    this._changed();
  }

  /** Number key 1-9 over a slot (SWAP): exchange with hotbar slot `n` (cursor must be empty). */
  swapHotbar(ref, n) {
    if (!ref || this.cursor || n < 0 || n > 8) return;
    const inv = this.inventory;
    const hot = inv.get(n);
    switch (ref.kind) {
      case 'creative':
        if (!ref.itemId) return;
        inv.set(n, makeStack(ref.itemId, maxStackSize(ref.itemId)));
        break;
      case 'result': {
        const r = this.result;
        if (!r) return;
        if (!hot) {
          inv.set(n, copy(r));
        } else if (canMerge(hot, r) && hot.count + r.count <= maxStackSize(r.id)) {
          inv.set(n, copy(hot, hot.count + r.count));
        } else {
          let empty = -1;
          for (let i = 0; i < inv.size; i++) if (i !== n && !inv.get(i)) { empty = i; break; }
          if (empty < 0) return;
          inv.set(empty, hot);
          inv.set(n, copy(r));
        }
        this._craftOnce();
        break;
      }
      case 'inv':
      case 'grid': {
        if (ref.kind === 'inv' && ref.index === n) return;
        const s = this.get(ref);
        if (!s && !hot) return;
        this.set(ref, hot ? copy(hot) : null);
        inv.set(n, s ? copy(s) : null);
        break;
      }
      case 'container': {
        // AbstractContainerMenu SWAP with the slot rules (take-only output, fuel-only fuel slot).
        if (!this.container) return;
        const s = this.get(ref);
        if (!s && !hot) return;
        if (!hot) {
          inv.set(n, copy(s));
          this.set(ref, null);
        } else if (!this.mayPlace(ref, hot)) {
          return;
        } else {
          const max = this.slotMax(ref, hot);
          if (hot.count > max) {
            // only part of the hotbar stack fits: put that part in, the slot's stack goes elsewhere
            this.set(ref, copy(hot, max));
            inv.set(n, copy(hot, hot.count - max));
            if (s) {
              const left = inv.add(copy(s));
              if (left > 0) this.onDrop(copy(s, left));
            }
          } else {
            this.set(ref, copy(hot));
            inv.set(n, s ? copy(s) : null);
          }
        }
        break;
      }
      default:
        return;
    }
    this._changed();
  }

  /** Q over a slot (THROW): drop one item, or the whole stack with `all` (Ctrl+Q). */
  throwFrom(ref, all = false) {
    if (!ref || this.cursor) return;
    switch (ref.kind) {
      case 'creative':
        if (!ref.itemId) return;
        this.onDrop(makeStack(ref.itemId, all ? maxStackSize(ref.itemId) : 1));
        break;
      case 'result':
        if (!this.result) return;
        this.onDrop(copy(this.result));
        this._craftOnce();
        break;
      case 'inv':
      case 'grid':
      case 'container': {
        if (!this.isStorage(ref)) return;
        const s = this.get(ref);
        if (!s) return;
        const n = all ? s.count : 1;
        this.onDrop(copy(s, n));
        this.set(ref, copy(s, s.count - n));
        break;
      }
      default:
        return;
    }
    this._changed();
  }

  /** Click outside the window: drop the cursor stack (left) or a single item (right). */
  clickOutside(button = 0) {
    const cur = this.cursor;
    if (!cur) return;
    const n = button === 0 ? cur.count : 1;
    this.onDrop(copy(cur, n));
    this._setCursor(copy(cur, cur.count - n));
    this._changed();
  }

  /** Drop the crafting grid and the cursor stack into the world (player died with the screen open). */
  dropAll() {
    for (let i = 0; i < this.grid.length; i++) {
      if (this.grid[i]) this.onDrop(copy(this.grid[i]));
      this.grid[i] = null;
    }
    if (this.cursor) this.onDrop(copy(this.cursor));
    this.cursor = null;
    this.updateResult();
    this._changed();
  }

  /** Screen closed: return crafting grid + cursor items to the inventory, drop what does not fit. */
  close() {
    const back = [];
    for (let i = 0; i < this.grid.length; i++) {
      if (this.grid[i]) back.push(this.grid[i]);
      this.grid[i] = null;
    }
    if (this.cursor) back.push(this.cursor);
    this.cursor = null;
    for (const s of back) {
      const left = this.inventory.add(s);
      if (left > 0) this.onDrop(copy(s, left));
    }
    this.updateResult();
    this._changed();
  }
}
