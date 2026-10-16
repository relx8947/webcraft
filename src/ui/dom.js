// Tiny DOM helpers + Minecraft-style widgets (button, slider, text field). Sizes are in GUI pixels
// and expressed as calc(var(--g) * n) so everything follows the GUI scale.
import { renderFormatted } from './text.js';

/** Pointer capture that never throws (synthetic / already released pointers). */
export function capturePointer(el, id, on = true) {
  try {
    if (on) el.setPointerCapture?.(id);
    else if (el.hasPointerCapture?.(id)) el.releasePointerCapture(id);
  } catch {
    // not an active pointer: capture is only an optimisation for drags leaving the element
  }
}

/** CSS length for n GUI pixels. */
export const gp = (n) => `calc(var(--g) * ${n})`;

let clickSound = null;
/** Hook called when any widget is activated (UIManager plays the 'click' sound). */
export function setClickSound(fn) {
  clickSound = fn;
}
export function playClick() {
  if (clickSound) clickSound();
}

/**
 * Create an element. `props`: className, text, html-free attributes (dataset via data-*), style object,
 * and on* event handlers. Children may be nodes or strings.
 */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'className') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

/** Absolutely positioned box in GUI pixels (x/y may be raw CSS strings for centred layouts). */
export function place(el, { x, y, w, hgt, right, bottom } = {}) {
  const v = (n) => (typeof n === 'number' ? gp(n) : n);
  if (x !== undefined) el.style.left = v(x);
  if (y !== undefined) el.style.top = v(y);
  if (right !== undefined) el.style.right = v(right);
  if (bottom !== undefined) el.style.bottom = v(bottom);
  if (w !== undefined) el.style.width = v(w);
  if (hgt !== undefined) el.style.height = v(hgt);
  return el;
}

// Screen metrics in whole GUI pixels are published by UIManager as unitless CSS variables
// (--gw, --gh, --hw = gw/2, --hh = gh/2, --qh = gh/4, --h6 = gh/6, all floored like Minecraft's
// integer maths) so that layouts land on exact device pixels.
/** Centre-anchored x: (screen width / 2) + dx GUI pixels. */
export const cx = (dx) => `calc(var(--g) * (var(--hw) + ${dx}))`;
const FRACTION_VARS = new Map([[0, null], [1 / 6, '--h6'], [1 / 4, '--qh'], [1 / 2, '--hh'], [1, '--gh']]);
/** y = fraction of the screen height (0, 1/6, 1/4, 1/2 or 1) + dy GUI pixels. */
export const fy = (fraction, dy) => {
  const v = FRACTION_VARS.get(fraction);
  if (v === undefined) throw new Error(`fy: unsupported fraction ${fraction}`);
  return v ? `calc(var(--g) * (var(${v}) + ${dy}))` : gp(dy);
};

/** Minecraft text label (white with shadow by default; supports § codes). */
export function label(text, className = '') {
  const el = h('div', { className: `mc-text ${className}`.trim() });
  renderFormatted(el, text);
  return el;
}

/** Grey bevelled 20 px high button. */
export class Button {
  /**
   * @param {object} o
   * @param {string} o.label
   * @param {number} [o.width=200]  GUI pixels
   * @param {() => void} o.onClick
   * @param {boolean} [o.disabled]
   * @param {string} [o.tooltip]
   */
  constructor({ label: text, width = 200, onClick, disabled = false, tooltip }) {
    this.onClick = onClick;
    this.el = h('button', { type: 'button', className: 'mc-button', title: tooltip });
    this.el.style.width = gp(width);
    this.textEl = h('span', { className: 'mc-button-label' });
    this.el.appendChild(this.textEl);
    this.setLabel(text);
    this.setDisabled(disabled);
    // keep keyboard focus off buttons on mouse use (Space must not re-trigger them)
    this.el.addEventListener('mousedown', (e) => e.preventDefault());
    this.el.addEventListener('click', (e) => {
      e.preventDefault();
      if (this.disabled) return;
      playClick();
      this.onClick?.(e);
    });
  }
  setLabel(text) {
    this.label = text;
    renderFormatted(this.textEl, text);
  }
  setDisabled(d) {
    this.disabled = !!d;
    this.el.classList.toggle('disabled', this.disabled);
    this.el.setAttribute('aria-disabled', String(this.disabled));
  }
}

/** Minecraft option slider: dark track, 8 px handle, centred label. */
export class Slider {
  /**
   * @param {object} o
   * @param {number} o.min @param {number} o.max @param {number} [o.step=1] @param {number} o.value
   * @param {(v:number) => string} o.format   label text for a value
   * @param {(v:number) => void} [o.onInput] while dragging
   * @param {(v:number) => void} [o.onChange] on release (or keyboard change)
   * @param {number} [o.width=150]
   */
  constructor({ min, max, step = 1, value, format, onInput, onChange, width = 150 }) {
    Object.assign(this, { min, max, step, format, onInput, onChange });
    this.el = h('div', { className: 'mc-slider', tabindex: '0', role: 'slider' });
    this.el.style.width = gp(width);
    this.handle = h('div', { className: 'mc-slider-handle' });
    this.textEl = h('span', { className: 'mc-button-label' });
    this.el.append(this.handle, this.textEl);
    this.dragging = false;
    this.setValue(value);
    const fromEvent = (e) => {
      const r = this.el.getBoundingClientRect();
      const g = r.height / 20; // one GUI pixel in CSS px
      const t = (e.clientX - r.left - 4 * g) / Math.max(1, r.width - 8 * g);
      return this._snap(min + Math.max(0, Math.min(1, t)) * (max - min));
    };
    this.el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      this.dragging = true;
      capturePointer(this.el, e.pointerId);
      this.el.classList.add('active');
      this._set(fromEvent(e), false);
    });
    this.el.addEventListener('pointermove', (e) => {
      if (this.dragging) this._set(fromEvent(e), false);
    });
    const end = (e) => {
      if (!this.dragging) return;
      this.dragging = false;
      this.el.classList.remove('active');
      capturePointer(this.el, e.pointerId, false);
      playClick();
      this.onChange?.(this.value);
    };
    this.el.addEventListener('pointerup', end);
    this.el.addEventListener('pointercancel', end);
    this.el.addEventListener('keydown', (e) => {
      const d = e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : 0;
      if (!d) return;
      e.preventDefault();
      e.stopPropagation();
      this._set(this._snap(this.value + d * step), true);
    });
  }
  _snap(v) {
    const s = Math.round((v - this.min) / this.step) * this.step + this.min;
    const r = Math.max(this.min, Math.min(this.max, s));
    return Number(r.toFixed(6));
  }
  _set(v, commit) {
    if (v === this.value) return;
    this.setValue(v);
    this.onInput?.(v);
    if (commit) this.onChange?.(v);
  }
  /** Set without firing callbacks. */
  setValue(v) {
    this.value = this._snap(v);
    const t = (this.value - this.min) / (this.max - this.min || 1);
    this.handle.style.left = `calc((100% - var(--g) * 8) * ${t})`;
    renderFormatted(this.textEl, this.format(this.value));
    this.el.setAttribute('aria-valuenow', String(this.value));
  }
}

/** Black text field with grey border (Minecraft GuiTextField). */
export class TextField {
  constructor({ width = 200, value = '', placeholder = '', maxLength = 64, onEnter, onInput } = {}) {
    this.el = h('div', { className: 'mc-textfield' });
    this.el.style.width = gp(width);
    this.input = h('input', {
      type: 'text', spellcheck: 'false', autocomplete: 'off', maxlength: String(maxLength), placeholder,
    });
    this.input.value = value;
    this.el.appendChild(this.input);
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        onEnter?.(this.value);
      }
    });
    if (onInput) this.input.addEventListener('input', () => onInput(this.value));
  }
  get value() {
    return this.input.value;
  }
  set value(v) {
    this.input.value = v;
  }
  /** Focus with the caret at the end (like Minecraft's text fields). */
  focus() {
    this.input.focus({ preventScroll: true });
    const n = this.input.value.length;
    this.input.setSelectionRange(n, n);
  }
}
