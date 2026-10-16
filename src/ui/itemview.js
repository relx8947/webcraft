// Item stack view used by the hotbar, inventory screens and the mouse cursor: 16x16 GUI px icon,
// stack count (bottom-right, shadowed) and the durability bar for damaged tools.
import { maxDurability } from '../world/registry.js';

/** Create an empty item view element. */
export function createItemView(className = 'item') {
  const el = document.createElement('div');
  el.className = `${className} empty`;
  const img = document.createElement('img');
  img.className = 'item-icon';
  img.alt = '';
  img.draggable = false;
  img.decoding = 'sync';
  const count = document.createElement('span');
  count.className = 'item-count';
  const dur = document.createElement('div');
  dur.className = 'item-dur';
  const bar = document.createElement('div');
  dur.appendChild(bar);
  el.append(img, dur, count);
  el._img = img;
  el._count = count;
  el._dur = dur;
  el._bar = bar;
  el._id = -1;
  el._n = -1;
  el._dmg = -1;
  return el;
}

/** Durability colour: green (new) -> red (broken), like Minecraft's HSV ramp. */
export function durabilityColor(fraction) {
  const hue = Math.max(0, Math.min(1, fraction)) * 120;
  return `hsl(${hue.toFixed(0)}, 100%, 50%)`;
}

/**
 * Show `stack` in an item view (no-op when unchanged).
 * @param {HTMLElement} el      from createItemView()
 * @param {object|null} stack   { id, count, damage }
 * @param {{ getIcon(id): string }} icons
 * @param {{ showOne?: boolean }} [opts] showOne: draw "1" counts too (not used by Minecraft)
 */
export function setItemView(el, stack, icons, opts) {
  const id = stack && stack.count > 0 ? stack.id : 0;
  const n = id ? stack.count : 0;
  const dmg = id ? stack.damage ?? 0 : 0;
  if (el._id === id && el._n === n && el._dmg === dmg) return;
  if (el._id !== id) {
    el._id = id;
    if (id) {
      el._img.src = icons ? icons.getIcon(id) : '';
      el.classList.remove('empty');
    } else {
      el._img.removeAttribute('src');
      el.classList.add('empty');
    }
  }
  el._n = n;
  el._dmg = dmg;
  el._count.textContent = n > 1 || (opts?.showOne && n === 1) ? String(n) : '';
  const max = id ? maxDurability(id) : 0;
  if (max > 0 && dmg > 0) {
    const frac = (max - dmg) / max;
    el._dur.style.display = '';
    el._bar.style.width = `calc(var(--g) * ${Math.max(0, Math.round(13 * frac))})`;
    el._bar.style.backgroundColor = durabilityColor(frac);
  } else {
    el._dur.style.display = 'none';
  }
}

/** Force the next setItemView() to redraw (e.g. after the icon source changed). */
export function invalidateItemView(el) {
  el._id = -1;
  el._n = -1;
  el._dmg = -1;
}
