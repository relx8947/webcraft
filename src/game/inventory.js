// Inventory data model (pure; runs in Node). Stacks are plain objects { id, count, damage }.
// `damage` = durability used (tools); stacks only merge when id and damage match and maxStack > 1.
import { maxStackSize, maxDurability, getItem } from '../world/registry.js';

export function makeStack(id, count = 1, damage = 0) {
  return { id, count, damage };
}

export function cloneStack(s) {
  return s ? { id: s.id, count: s.count, damage: s.damage ?? 0 } : null;
}

export function canMerge(a, b) {
  return !!a && !!b && a.id === b.id && (a.damage ?? 0) === (b.damage ?? 0) && maxStackSize(a.id) > 1;
}

/** Slots 0..8 = hotbar, 9..35 = main inventory. `version` increments on every mutation. */
export class Inventory {
  constructor(size = 36) {
    this.size = size;
    this.slots = new Array(size).fill(null);
    this.version = 0;
  }

  get(i) {
    return this.slots[i] ?? null;
  }

  set(i, stack) {
    this.slots[i] = stack && stack.count > 0 ? stack : null;
    this.version++;
  }

  /** Call after mutating a stack object in place. */
  changed() {
    this.version++;
  }

  /**
   * Add a stack (not mutated). Merges into existing stacks first (hotbar first), then fills empty
   * slots in the same order. Returns the leftover count (0 = everything fit).
   */
  add(stack) {
    if (!stack || stack.count <= 0) return 0;
    let remaining = stack.count;
    const max = maxStackSize(stack.id);
    const damage = stack.damage ?? 0;
    for (let i = 0; i < this.size && remaining > 0; i++) {
      const s = this.slots[i];
      if (s && canMerge(s, stack) && s.count < max) {
        const n = Math.min(max - s.count, remaining);
        s.count += n;
        remaining -= n;
      }
    }
    for (let i = 0; i < this.size && remaining > 0; i++) {
      if (!this.slots[i]) {
        const n = Math.min(max, remaining);
        this.slots[i] = { id: stack.id, count: n, damage };
        remaining -= n;
      }
    }
    if (remaining !== stack.count) this.version++;
    return remaining;
  }

  /** True if the whole stack would fit. */
  canAdd(stack) {
    const max = maxStackSize(stack.id);
    let room = 0;
    for (let i = 0; i < this.size; i++) {
      const s = this.slots[i];
      if (!s) room += max;
      else if (canMerge(s, stack)) room += max - s.count;
      if (room >= stack.count) return true;
    }
    return false;
  }

  /** Remove up to `count` items from slot i. Returns the removed stack or null. */
  removeFromSlot(i, count = Infinity) {
    const s = this.slots[i];
    if (!s) return null;
    const n = Math.min(count, s.count);
    s.count -= n;
    if (s.count <= 0) this.slots[i] = null;
    this.version++;
    return { id: s.id, count: n, damage: s.damage ?? 0 };
  }

  count(id) {
    let n = 0;
    for (const s of this.slots) if (s && s.id === id) n += s.count;
    return n;
  }

  /** Remove `count` items of `id` (from the last slots first). Returns false (and changes nothing) if not enough. */
  consume(id, count) {
    if (this.count(id) < count) return false;
    for (let i = this.size - 1; i >= 0 && count > 0; i--) {
      const s = this.slots[i];
      if (s && s.id === id) {
        const n = Math.min(count, s.count);
        s.count -= n;
        count -= n;
        if (s.count <= 0) this.slots[i] = null;
      }
    }
    this.version++;
    return true;
  }

  findSlot(id) {
    for (let i = 0; i < this.size; i++) if (this.slots[i] && this.slots[i].id === id) return i;
    return -1;
  }

  firstEmpty(start = 0, end = this.size) {
    for (let i = start; i < end; i++) if (!this.slots[i]) return i;
    return -1;
  }

  /**
   * Add `amount` durability damage to the tool in slot i. Returns true if the tool broke
   * (slot cleared). Items without durability are untouched (returns false).
   */
  damageItem(i, amount = 1) {
    const s = this.slots[i];
    if (!s) return false;
    const max = maxDurability(s.id);
    if (!max) return false;
    s.damage = (s.damage ?? 0) + amount;
    if (s.damage >= max) {
      this.slots[i] = null;
      this.version++;
      return true;
    }
    this.version++;
    return false;
  }

  clear() {
    this.slots.fill(null);
    this.version++;
  }

  isEmpty() {
    return this.slots.every((s) => !s);
  }

  serialize() {
    return this.slots.map((s) => (s ? [s.id, s.count, s.damage ?? 0] : null));
  }

  static deserialize(arr, size = 36) {
    const inv = new Inventory(size);
    if (Array.isArray(arr)) {
      arr.forEach((s, i) => {
        if (s && i < size && getItem(s[0]) && s[1] > 0) {
          inv.slots[i] = { id: s[0], count: Math.min(s[1], maxStackSize(s[0])), damage: s[2] ?? 0 };
        }
      });
    }
    return inv;
  }
}
