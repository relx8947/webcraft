// Keyboard / mouse input: pointer lock with raw mouse deltas, per-frame edge detection, key bindings
// by KeyboardEvent.code, and an automation mode for headless tests (SPEC §9.7).
//
// Browser module at runtime, but every DOM object is injected (`env`), so the logic also runs under
// Node tests with fake EventTargets.
//
// Semantics (all reads return idle values while `active` is false):
//   active          = enabled && (locked || allowUnlocked)
//   isDown(a)       = a bound key/button is held now, OR was pressed at some point during this frame
//                     (so a tap shorter than one frame - e.g. a synthetic down+up - is never lost)
//   pressed(a)      = went down during this frame (edge), released(a) = went up during this frame
//   mouseDX/mouseDY = pointer movement since the last endFrame(), multiplied by
//                     settings.mouseSensitivity, Y negated when settings.invertY ("look units":
//                     Minecraft-style counts at 100 % sensitivity; the player maps 1 unit -> 0.15 deg)
//   rawMouseDX/DY   = the same without sensitivity / invert
//   wheel           = whole wheel notches since the last endFrame() (+ = scrolled down / toward the user)
// Edges are only recorded for events that happen while active and after the most recent
// (re)activation, so e.g. the E key that closes the inventory never re-opens it on the same frame.
//
// Ctrl+W: browsers never hand their reserved shortcuts (Ctrl+W/N/T, Ctrl+Tab …) to a page, so pressing
// W while the sprint key (Ctrl) is held closes the tab outside fullscreen. Mitigations: sprinting by
// double-tapping W (player.js shows a one-time tip when Ctrl-sprint is used outside fullscreen, see
// `fullscreen`), the page's beforeunload confirmation (game.js) and the UI's fullscreen mode, which
// engages the Keyboard Lock API (src/ui/menus.js).

/** Every game action (SPEC §9.7). */
export const ACTIONS = Object.freeze([
  'forward', 'back', 'left', 'right', 'jump', 'sneak', 'sprint',
  'inventory', 'drop', 'chat', 'command', 'debug', 'hideHud', 'perspective',
  'attack', 'use', 'pickBlock',
  'hotbar1', 'hotbar2', 'hotbar3', 'hotbar4', 'hotbar5', 'hotbar6', 'hotbar7', 'hotbar8', 'hotbar9',
  'pause',
]);

/** Default bindings: KeyboardEvent.code values, or 'Mouse0'..'Mouse4' for mouse buttons. */
export const DEFAULT_KEY_BINDINGS = Object.freeze({
  forward: ['KeyW'], back: ['KeyS'], left: ['KeyA'], right: ['KeyD'],
  jump: ['Space'], sneak: ['ShiftLeft', 'ShiftRight'], sprint: ['ControlLeft', 'ControlRight'],
  inventory: ['KeyE'], drop: ['KeyQ'], chat: ['KeyT'], command: ['Slash', 'NumpadDivide'],
  debug: ['F3'], hideHud: ['F1'], perspective: ['F5'],
  attack: ['Mouse0'], use: ['Mouse2'], pickBlock: ['Mouse1'],
  hotbar1: ['Digit1'], hotbar2: ['Digit2'], hotbar3: ['Digit3'], hotbar4: ['Digit4'], hotbar5: ['Digit5'],
  hotbar6: ['Digit6'], hotbar7: ['Digit7'], hotbar8: ['Digit8'], hotbar9: ['Digit9'],
  pause: ['Escape'],
});

const ACTION_INDEX = new Map(ACTIONS.map((a, i) => [a, i]));
const N_ACTIONS = ACTIONS.length;

// Keys whose browser default is kept even while the game has the input (fullscreen, devtools).
const KEEP_DEFAULT = new Set(['F11', 'F12']);
// Single mouse events larger than this are spurious (known Chromium pointer-lock spikes).
const MAX_MOUSE_EVENT_DELTA = 1500;


function defaultNow() {
  return globalThis.performance ? globalThis.performance.now() : Date.now();
}

export class Input {
  /**
   * @param {HTMLCanvasElement|EventTarget} canvas  pointer-lock target; receives mousedown/wheel/contextmenu
   * @param {object} settings  live settings object (mouseSensitivity, invertY); replace via `input.settings = s`
   * @param {{window?: EventTarget, document?: EventTarget, now?: () => number}} env  injectable for tests
   */
  constructor(canvas, settings = {}, env = {}) {
    this.canvas = canvas;
    this.settings = settings || {};
    this._win = env.window ?? globalThis.window ?? null;
    this._doc = env.document ?? globalThis.document ?? null;
    this._now = env.now ?? defaultNow;

    /** Automation mode: keys, buttons and mouse movement work without pointer lock. */
    this.allowUnlocked = false;
    /** In normal mode, a click on the canvas while enabled but unlocked re-requests the lock. */
    this.autoLock = true;

    this._enabled = true;
    this._held = new Set();                     // physical codes currently down
    this._bindings = new Map();                 // code -> action indices
    this._heldCount = new Uint8Array(N_ACTIONS);
    this._pressed = new Uint8Array(N_ACTIONS);
    this._released = new Uint8Array(N_ACTIONS);
    this._edgeEpoch = -Infinity;                // events with timeStamp <= epoch never produce edges
    this._dx = 0; this._dy = 0; this._rawDX = 0; this._rawDY = 0;
    this._wheelAcc = 0; this._wheelSteps = 0;
    this._skipMoves = 0;
    this._lockListeners = [];
    this._lastLocked = false;
    this._listeners = [];

    this.setBindings(DEFAULT_KEY_BINDINGS);
    this._attach();
  }

  // ------------------------------------------------------------------ state

  /** False while a UI screen is open: every action reads as idle and no edges are recorded. */
  get enabled() { return this._enabled; }
  set enabled(v) {
    v = !!v;
    if (v === this._enabled) return;
    this._enabled = v;
    this._resetFrameState();
    this._edgeEpoch = this._now();
  }

  /** True when the canvas currently owns the pointer lock. */
  get locked() {
    return !!this._doc && !!this.canvas && this._doc.pointerLockElement === this.canvas;
  }

  /** Whether game actions are live right now. */
  get active() {
    return this._enabled && (this.allowUnlocked || this.locked);
  }

  /** True while the page is in element fullscreen (where the UI engages the Keyboard Lock API). */
  get fullscreen() {
    return !!this._doc?.fullscreenElement;
  }

  get mouseDX() { return this.active ? this._dx : 0; }
  get mouseDY() { return this.active ? this._dy : 0; }
  get rawMouseDX() { return this.active ? this._rawDX : 0; }
  get rawMouseDY() { return this.active ? this._rawDY : 0; }
  get wheel() { return this.active ? this._wheelSteps : 0; }

  /** Action held now (or tapped during this frame). Unknown actions read false. */
  isDown(action) {
    const i = ACTION_INDEX.get(action);
    if (i === undefined || !this.active) return false;
    return this._heldCount[i] > 0 || this._pressed[i] === 1;
  }

  /** Action went down during this frame. */
  pressed(action) {
    const i = ACTION_INDEX.get(action);
    return i !== undefined && this.active && this._pressed[i] === 1;
  }

  /** Action went up during this frame. */
  released(action) {
    const i = ACTION_INDEX.get(action);
    return i !== undefined && this.active && this._released[i] === 1;
  }

  /** Raw physical key/button state by code ('KeyQ', 'ControlLeft', 'Mouse0' ...), gated by `active`. */
  isKeyDown(code) {
    return this.active && this._held.has(code);
  }

  /** Call once at the end of every frame: clears edges and accumulated mouse / wheel motion. */
  endFrame() {
    this._resetFrameState();
  }

  /** Release every key and button (window blur, lost lock, screen change). Same-frame taps are dropped too. */
  releaseAll() {
    const allowEdges = this.active;
    for (const code of this._held) this._setCodeState(code, false, allowEdges);
    this._held.clear();
    this._heldCount.fill(0);
    this._pressed.fill(0);
    this._wheelAcc = 0;
  }

  /** Replace the bindings: { action: [code, ...] }. Missing actions keep no binding. */
  setBindings(bindings) {
    this._bindings.clear();
    for (const [action, codes] of Object.entries(bindings)) {
      const i = ACTION_INDEX.get(action);
      if (i === undefined || !Array.isArray(codes)) continue;
      for (const code of codes) {
        if (!this._bindings.has(code)) this._bindings.set(code, []);
        const list = this._bindings.get(code);
        if (!list.includes(i)) list.push(i);
      }
    }
    this._heldCount.fill(0);
    for (const code of this._held) {
      const list = this._bindings.get(code);
      if (list) for (const i of list) this._heldCount[i]++;
    }
  }

  /** Current bindings as { action: [codes] }. */
  getBindings() {
    const out = {};
    for (const a of ACTIONS) out[a] = [];
    for (const [code, list] of this._bindings) for (const i of list) out[ACTIONS[i]].push(code);
    return out;
  }

  // ------------------------------------------------------------------ pointer lock

  /**
   * Request pointer lock on the canvas (needs a user gesture). Prefers raw, OS-unaccelerated movement
   * (`unadjustedMovement`) and falls back to a plain request. Never throws; resolves to `locked`.
   */
  requestLock() {
    const c = this.canvas;
    if (!c || typeof c.requestPointerLock !== 'function') return Promise.resolve(false);
    if (this.locked) return Promise.resolve(true);
    const plain = () => {
      try {
        const p = c.requestPointerLock();
        if (p && typeof p.then === 'function') return p.then(() => this.locked, () => false);
      } catch { /* not allowed right now (no user gesture / lock cooldown) */ }
      return Promise.resolve(this.locked);
    };
    try {
      const p = c.requestPointerLock({ unadjustedMovement: true });
      if (p && typeof p.then === 'function') return p.then(() => this.locked, () => plain());
      return Promise.resolve(this.locked);   // legacy browsers: lock arrives via pointerlockchange
    } catch {
      return plain();
    }
  }

  exitLock() {
    try {
      if (this.locked && this._doc && typeof this._doc.exitPointerLock === 'function') this._doc.exitPointerLock();
    } catch { /* ignore */ }
  }

  /** fn(locked: boolean) on every pointer-lock change. Returns an unsubscribe function. */
  onLockChange(fn) {
    this._lockListeners.push(fn);
    return () => {
      const i = this._lockListeners.indexOf(fn);
      if (i >= 0) this._lockListeners.splice(i, 1);
    };
  }

  /** Remove every DOM listener (call when the game is torn down). */
  destroy() {
    for (const [target, type, fn, opts] of this._listeners) target.removeEventListener(type, fn, opts);
    this._listeners.length = 0;
    this._lockListeners.length = 0;
    this.releaseAll();
  }

  // ------------------------------------------------------------------ internals

  _resetFrameState() {
    this._pressed.fill(0);
    this._released.fill(0);
    this._dx = 0; this._dy = 0; this._rawDX = 0; this._rawDY = 0;
    this._wheelSteps = 0;
  }

  _edgeAllowed(e) {
    if (!this.active) return false;
    const ts = e && typeof e.timeStamp === 'number' ? e.timeStamp : this._now();
    return ts > this._edgeEpoch;
  }

  /** Apply a physical code transition to the bound actions. */
  _setCodeState(code, down, allowEdges) {
    const list = this._bindings.get(code);
    if (!list) return;
    for (const i of list) {
      if (down) {
        if (this._heldCount[i]++ === 0 && allowEdges) this._pressed[i] = 1;
      } else if (this._heldCount[i] > 0) {
        if (--this._heldCount[i] === 0 && allowEdges) this._released[i] = 1;
      }
    }
  }

  _codeDown(code, e) {
    if (this._held.has(code)) return;
    this._held.add(code);
    this._setCodeState(code, true, this._edgeAllowed(e));
  }

  _codeUp(code, e) {
    if (!this._held.has(code)) return;
    this._held.delete(code);
    this._setCodeState(code, false, this._edgeAllowed(e));
  }

  _listen(target, type, fn, opts) {
    if (!target || typeof target.addEventListener !== 'function') return;
    target.addEventListener(type, fn, opts);
    this._listeners.push([target, type, fn, opts]);
  }

  _shouldBlockKey(e, code) {
    if (!this.active) return false;
    if (KEEP_DEFAULT.has(code)) return false;
    // Keep devtools shortcuts (Ctrl+Shift+I/J/C) usable.
    if (e.ctrlKey && e.shiftKey && (code === 'KeyI' || code === 'KeyJ' || code === 'KeyC')) return false;
    // Everything else: Space/arrows would scroll, Tab moves focus, F1/F3/F5 open help/find/reload,
    // Slash/Quote open quick-find, Ctrl+S/D/F/... open dialogs, Alt focuses the menu bar.
    return true;
  }

  _attach() {
    const win = this._win, doc = this._doc, canvas = this.canvas;

    this._listen(win, 'keydown', (e) => {
      const code = e.code;
      if (code && code !== 'Unidentified' && !e.isComposing) this._codeDown(code, e);
      if (this._shouldBlockKey(e, code) && e.cancelable !== false) e.preventDefault();
    });
    this._listen(win, 'keyup', (e) => {
      const code = e.code;
      if (code && code !== 'Unidentified') this._codeUp(code, e);
      if (this._shouldBlockKey(e, code) && e.cancelable !== false) e.preventDefault();
    });
    this._listen(win, 'blur', () => this.releaseAll());
    this._listen(doc, 'visibilitychange', () => {
      if (doc.visibilityState === 'hidden' || doc.hidden) this.releaseAll();
    });

    this._listen(canvas, 'mousedown', (e) => {
      const button = typeof e.button === 'number' ? e.button : 0;
      if (this._enabled && !this.allowUnlocked && !this.locked) {
        if (this.autoLock) this.requestLock();
        if (e.cancelable !== false) e.preventDefault();
        return;   // the click that grabs the pointer is not a game click
      }
      this._codeDown('Mouse' + button, e);
      // Middle click would start autoscroll, back/forward buttons would navigate.
      if (e.cancelable !== false) e.preventDefault();
    });
    this._listen(win, 'mouseup', (e) => {
      const button = typeof e.button === 'number' ? e.button : 0;
      const code = 'Mouse' + button;
      const wasGameButton = this._held.has(code);
      this._codeUp(code, e);
      if ((wasGameButton || button >= 3) && this.active && e.cancelable !== false) e.preventDefault();
    });
    this._listen(canvas, 'auxclick', (e) => { if (e.cancelable !== false) e.preventDefault(); });
    this._listen(canvas, 'contextmenu', (e) => { if (e.cancelable !== false) e.preventDefault(); });
    this._listen(canvas, 'dragstart', (e) => { if (e.cancelable !== false) e.preventDefault(); });
    this._listen(canvas, 'selectstart', (e) => { if (e.cancelable !== false) e.preventDefault(); });

    this._listen(doc, 'mousemove', (e) => {
      if (!this.active) return;
      if (this._skipMoves > 0) { this._skipMoves--; return; }
      const dx = e.movementX || 0;
      const dy = e.movementY || 0;
      if (Math.abs(dx) > MAX_MOUSE_EVENT_DELTA || Math.abs(dy) > MAX_MOUSE_EVENT_DELTA) return;
      const s = this.settings;
      const sens = Number.isFinite(s?.mouseSensitivity) ? s.mouseSensitivity : 1;
      this._rawDX += dx;
      this._rawDY += dy;
      this._dx += dx * sens;
      this._dy += dy * sens * (s?.invertY ? -1 : 1);
    });

    this._listen(canvas, 'wheel', (e) => {
      if (!this.active) return;
      if (e.cancelable !== false) e.preventDefault();   // no page scroll / Ctrl+wheel zoom
      // Shift+wheel arrives as horizontal scroll in Chromium: treat it the same (sneak + scroll).
      const d = e.deltaY !== 0 ? e.deltaY : (e.deltaX || 0);
      if (!d) return;
      let steps;
      if (e.deltaMode === 2) steps = Math.sign(d);                                   // pages
      else if (e.deltaMode === 1) steps = Math.sign(d) * Math.max(1, Math.round(Math.abs(d) / 3)); // lines
      else if (Math.abs(d) >= 40) steps = Math.sign(d) * Math.max(1, Math.round(Math.abs(d) / 100)); // wheel notch
      else {                                                                          // touchpad: accumulate
        this._wheelAcc += d / 100;
        steps = Math.trunc(this._wheelAcc);
        this._wheelAcc -= steps;
      }
      this._wheelSteps += steps;
    }, { passive: false });

    this._listen(doc, 'pointerlockchange', () => {
      const locked = this.locked;
      if (locked === this._lastLocked) return;
      this._lastLocked = locked;
      if (locked) {
        // Keys already held keep working, but nothing that happened before the lock counts as an edge.
        this._resetFrameState();
        this._edgeEpoch = this._now();
        this._skipMoves = 1;   // the first locked move event can carry a bogus jump
      } else {
        this.releaseAll();
        this._resetFrameState();
      }
      for (const fn of this._lockListeners.slice()) {
        try { fn(locked); } catch (err) { setTimeout(() => { throw err; }); }
      }
    });
    this._listen(doc, 'pointerlockerror', () => {
      // The lock was refused (no user gesture / re-lock cooldown); a later canvas click retries.
    });
  }
}
