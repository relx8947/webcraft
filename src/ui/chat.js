// Chat: ChatLog shows messages bottom-left above the hotbar (they fade out after 10 s like Minecraft;
// with the chat open the last 100 can be scrolled), ChatScreen is the input line opened with T or "/"
// (sent-message history on Up/Down, command suggestions with Tab, Enter sends: "/..." goes to
// game.runCommand, everything else is posted as "<玩家> text").
import { h, gp } from './dom.js';
import { renderFormatted } from './text.js';
import { getCompletions } from '../game/commands.js';

const VISIBLE_SECONDS = 10;
const MAX_LINES = 100;
const CLOSED_LINES = 10;
const OPEN_LINES = 20;

export class ChatLog {
  constructor() {
    this.el = h('div', { className: 'chat' });
    this.lines = [];
    this.scroll = 0;
    this.open = false;
  }

  /** Add a message (§ formatting codes allowed; `color` = default CSS colour). */
  add(text, color) {
    const el = h('div', { className: 'chat-line' });
    const span = h('span', { className: 'mc-text chat-text' });
    renderFormatted(span, String(text ?? ''), color || '#FFFFFF');
    el.appendChild(span);
    this.el.appendChild(el);
    this.lines.push({ el, time: performance.now(), shown: true, opacity: '' });
    while (this.lines.length > MAX_LINES) this.lines.shift().el.remove();
    if (this.open && this.scroll > 0) this.scroll++;
  }

  clear() {
    for (const l of this.lines) l.el.remove();
    this.lines.length = 0;
    this.scroll = 0;
  }

  scrollBy(n) {
    const max = Math.max(0, this.lines.length - OPEN_LINES);
    this.scroll = Math.max(0, Math.min(max, this.scroll + n));
  }

  /** Per-frame visibility / fading. */
  update(open) {
    if (open !== this.open) {
      this.open = open;
      this.scroll = 0;
      this.el.classList.toggle('open', open);
    }
    const now = performance.now();
    const n = this.lines.length;
    for (let i = 0; i < n; i++) {
      const line = this.lines[i];
      const fromEnd = n - 1 - i;
      let show;
      let opacity = 1;
      if (open) {
        show = fromEnd >= this.scroll && fromEnd < this.scroll + OPEN_LINES;
      } else {
        const age = (now - line.time) / 1000;
        show = fromEnd < CLOSED_LINES && age < VISIBLE_SECONDS;
        if (show) {
          const a = Math.max(0, Math.min(1, (1 - age / VISIBLE_SECONDS) * 10));
          opacity = a * a;
        }
      }
      if (show !== line.shown) {
        line.shown = show;
        line.el.style.display = show ? '' : 'none';
      }
      const op = opacity >= 1 ? '' : opacity.toFixed(3);
      if (show && op !== line.opacity) {
        line.opacity = op;
        line.el.style.opacity = op;
      }
    }
  }
}

export class ChatScreen {
  /**
   * @param {import('./ui.js').UIManager} ui
   * @param {string} prefill
   */
  constructor(ui, prefill = '') {
    this.ui = ui;
    this.game = ui.game;
    this.name = 'chat';
    this.inGame = true;
    this.pausesGame = false;
    this.transparent = true;
    this.el = h('div', { className: 'screen screen-chat' });
    this.box = h('div', { className: 'chat-input' });
    this.input = h('input', { type: 'text', spellcheck: 'false', autocomplete: 'off', maxlength: '256' });
    this.box.appendChild(this.input);
    this.suggest = h('div', { className: 'chat-suggest' });
    this.usage = h('div', { className: 'mc-text chat-usage' });
    this.el.append(this.suggest, this.usage, this.box);
    this.input.value = prefill;
    this.historyIndex = ui.chatHistory.length;
    this.draft = '';
    this.options = [];
    this.selected = -1;
    this.completion = null;
    this.measure = null;

    this.input.addEventListener('keydown', (e) => this.onInputKey(e));
    this.input.addEventListener('input', () => {
      this.completion = null;
      this.refreshSuggestions();
    });
    this.el.addEventListener('wheel', (e) => {
      e.preventDefault();
      ui.chatLog.scrollBy(e.deltaY < 0 ? 1 : -1);
    }, { passive: false });
    this.el.addEventListener('pointerdown', (e) => {
      const item = e.target.closest?.('.chat-suggest-item');
      if (item) {
        e.preventDefault();
        this.applyOption(Number(item.dataset.index));
        return;
      }
      if (e.target !== this.input) e.preventDefault();
      this.focus();
    });
  }

  onOpen() {
    this.focus();
    this.refreshSuggestions();
  }

  onClose() {
    this.input.blur();
  }

  update() {}

  focus() {
    this.input.focus({ preventScroll: true });
    const n = this.input.value.length;
    this.input.setSelectionRange(n, n);
  }

  onInputKey(e) {
    if (e.isComposing || e.keyCode === 229) return; // IME composition (Pinyin etc.) owns these keys
    switch (e.key) {
      case 'Enter': {
        e.preventDefault();
        this.send();
        return;
      }
      case 'Tab': {
        e.preventDefault();
        if (!this.options.length) return;
        const dir = e.shiftKey ? -1 : 1;
        const next = this.completion
          ? (this.completion.index + dir + this.options.length) % this.options.length
          : this.selected >= 0 ? this.selected : 0;
        this.applyOption(next, true);
        return;
      }
      case 'ArrowUp':
      case 'ArrowDown': {
        e.preventDefault();
        const dir = e.key === 'ArrowUp' ? -1 : 1;
        if (this.completion && this.options.length) {
          // while Tab-cycling, the arrows move through the suggestions
          this.applyOption((this.completion.index + dir + this.options.length) % this.options.length, true);
        } else {
          this.historyStep(dir);
        }
        return;
      }
      case 'PageUp':
        e.preventDefault();
        this.ui.chatLog.scrollBy(OPEN_LINES - 1);
        return;
      case 'PageDown':
        e.preventDefault();
        this.ui.chatLog.scrollBy(-(OPEN_LINES - 1));
        return;
      default:
    }
  }

  historyStep(dir) {
    const hist = this.ui.chatHistory;
    if (!hist.length) return;
    if (this.historyIndex === hist.length) this.draft = this.input.value;
    const next = Math.max(0, Math.min(hist.length, this.historyIndex + dir));
    if (next === this.historyIndex) return;
    this.historyIndex = next;
    this.input.value = next === hist.length ? this.draft : hist[next];
    this.focus();
    this.completion = null;
    this.refreshSuggestions();
  }

  send() {
    const text = this.input.value.trim();
    if (text) {
      const hist = this.ui.chatHistory;
      if (hist[hist.length - 1] !== text) hist.push(text);
      while (hist.length > 100) hist.shift();
      if (text.startsWith('/')) {
        if (typeof this.game.runCommand === 'function') this.game.runCommand(text);
      } else {
        this.ui.postChat(`<${this.game.playerName || '玩家'}> ${text}`);
      }
    }
    // Close only the chat: a command may already have replaced it (e.g. /kill opens the death screen).
    if (this.ui.screen === this) this.ui.closeScreen();
  }

  // ------------------------------------------------------------------ suggestions
  refreshSuggestions() {
    const text = this.input.value;
    const c = text.startsWith('/') ? getCompletions(this.game, text) : null;
    this.current = c;
    this.options = c ? c.options : [];
    this.selected = this.options.length ? 0 : -1;
    const showUsage = c && !this.options.length && c.usage;
    this.usage.style.display = showUsage ? '' : 'none';
    if (showUsage) renderFormatted(this.usage, c.usage, '#AAAAAA');
    this.renderSuggestions();
  }

  /** Text width in GUI pixels (to align the list under the token being completed). */
  textWidth(str) {
    if (!this.measure) {
      this.measure = document.createElement('canvas').getContext('2d');
    }
    const style = getComputedStyle(this.input);
    this.measure.font = `${style.fontSize} ${style.fontFamily}`;
    return this.measure.measureText(str).width / this.ui.unit;
  }

  renderSuggestions() {
    const opts = this.options;
    if (!opts.length) {
      this.suggest.style.display = 'none';
      return;
    }
    this.suggest.style.display = '';
    const max = 10;
    let first = 0;
    if (this.selected >= max) first = this.selected - max + 1;
    this.suggest.textContent = '';
    const shown = opts.slice(first, first + max);
    shown.forEach((o, i) => {
      const idx = first + i;
      const item = h('div', { className: `chat-suggest-item${idx === this.selected ? ' selected' : ''}`, 'data-index': String(idx) });
      item.textContent = o;
      this.suggest.appendChild(item);
    });
    const start = this.current ? this.current.start : 0;
    const offset = Math.min(this.textWidth(this.input.value.slice(0, start)), Math.max(0, this.ui.guiWidth - 120));
    this.suggest.style.left = gp(3 + Math.round(offset));
  }

  /** Replace the token being completed with option `index`. */
  applyOption(index, cycling = false) {
    const base = this.completion?.base ?? this.current;
    if (!base || !this.options[index]) return;
    const text = this.completion?.text ?? this.input.value;
    const value = text.slice(0, base.start) + this.options[index];
    this.input.value = value;
    this.focus();
    if (cycling) {
      // keep the original options while cycling with Tab
      this.completion = { index, base, text };
      this.selected = index;
      this.renderSuggestions();
    } else {
      this.completion = null;
      this.refreshSuggestions();
    }
  }
}
