// Text helpers for the UI: Minecraft formatting codes (§a, §l, ...) -> DOM spans, UI strings
// (splash texts, death messages, mode names) and small formatting utilities.
// parseFormatted() is pure; renderFormatted() needs a DOM.

/** Minecraft colour codes (text colour, shadow = colour / 4 like the game). */
export const COLOR_CODES = Object.freeze({
  0: '#000000', 1: '#0000AA', 2: '#00AA00', 3: '#00AAAA', 4: '#AA0000', 5: '#AA00AA', 6: '#FFAA00',
  7: '#AAAAAA', 8: '#555555', 9: '#5555FF', a: '#55FF55', b: '#55FFFF', c: '#FF5555', d: '#FF55FF',
  e: '#FFFF55', f: '#FFFFFF',
});

/** Shadow colour Minecraft uses for a text colour: (rgb & 0xFCFCFC) >> 2. */
export function shadowColor(css) {
  const m = /^#([0-9a-f]{6})$/i.exec(css ?? '');
  if (!m) return '#3F3F3F';
  const v = (parseInt(m[1], 16) & 0xfcfcfc) >> 2;
  return '#' + v.toString(16).padStart(6, '0');
}

/**
 * Split text with § codes into styled segments.
 * @returns {Array<{ text, color, bold, italic, underline, strike }>}
 */
export function parseFormatted(text, defaultColor = '#FFFFFF') {
  const out = [];
  let style = { color: defaultColor, bold: false, italic: false, underline: false, strike: false };
  let buf = '';
  const flush = () => {
    if (buf) out.push({ text: buf, ...style });
    buf = '';
  };
  const s = String(text ?? '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '§' && i + 1 < s.length) {
      const code = s[i + 1].toLowerCase();
      i++;
      flush();
      if (COLOR_CODES[code]) {
        style = { color: COLOR_CODES[code], bold: false, italic: false, underline: false, strike: false };
      } else if (code === 'r') {
        style = { color: defaultColor, bold: false, italic: false, underline: false, strike: false };
      } else if (code === 'l') style = { ...style, bold: true };
      else if (code === 'o') style = { ...style, italic: true };
      else if (code === 'n') style = { ...style, underline: true };
      else if (code === 'm') style = { ...style, strike: true };
      continue;
    }
    buf += ch;
  }
  flush();
  return out;
}

/** Remove formatting codes. */
export function stripFormatting(text) {
  return String(text ?? '').replace(/§./g, '');
}

/** Fill `el` with spans for formatted text. */
export function renderFormatted(el, text, defaultColor = '#FFFFFF') {
  el.textContent = '';
  for (const seg of parseFormatted(text, defaultColor)) {
    const span = document.createElement('span');
    span.textContent = seg.text;
    if (seg.color !== '#FFFFFF') {
      span.style.color = seg.color;
      span.style.setProperty('--sh', shadowColor(seg.color));
    }
    const cls = [];
    if (seg.bold) cls.push('fmt-b');
    if (seg.italic) cls.push('fmt-i');
    if (seg.underline) cls.push('fmt-u');
    if (seg.strike) cls.push('fmt-s');
    if (cls.length) span.className = cls.join(' ');
    el.appendChild(span);
  }
  return el;
}

export const MODE_NAMES = Object.freeze({ survival: '生存模式', creative: '创造模式' });
export const WORLD_TYPE_NAMES = Object.freeze({ default: '默认', flat: '超平坦' });
/** settings.difficulty values in Minecraft's cycling order and their Chinese names. */
export const DIFFICULTY_ORDER = Object.freeze(['peaceful', 'easy', 'normal', 'hard']);
export const DIFFICULTY_NAMES = Object.freeze({ peaceful: '和平', easy: '简单', normal: '普通', hard: '困难' });

/** Death message for a damage cause (Minecraft's Chinese phrasing). */
export function deathMessage(cause, name = '玩家') {
  const table = {
    fall: '%s落地过猛',
    lava: '%s试图在熔岩里游泳',
    drown: '%s淹死了',
    drowning: '%s淹死了',
    cactus: '%s被戳死了',
    void: '%s掉出了这个世界',
    kill: '%s被杀死了',
    starve: '%s饿死了',
    starvation: '%s饿死了',
    suffocation: '%s在墙里窒息而亡',
    fire: '%s被烧死了',
    explosion: '%s爆炸了',
    mob: '%s被杀死了',
    arrow: '%s被箭射杀',
    projectile: '%s被箭射杀',
    poison: '%s被魔法杀死了',
    magic: '%s被魔法杀死了',
  };
  return (table[cause] ?? '%s死了').replace('%s', name);
}

/** Splash texts for the title screen (original, Chinese + English). */
export const SPLASHES = Object.freeze([
  '100% 纯 JavaScript！',
  '零依赖！',
  '无需安装！',
  '方块！',
  'WebGL2!',
  '也试试原版！',
  'Also try the real one!',
  '在浏览器里挖矿！',
  'Punch some trees!',
  '撸树！',
  '像素完美！',
  'Now with 3D clouds!',
  '现已加入云朵！',
  '按 F3 看看！',
  '欢迎回来！',
  'Hello, world!',
  '64 是神奇的数字！',
  'Ctrl+Q!',
  '别挖脚下的方块！',
  'Never dig straight down!',
  '小心岩浆！',
  'Diamonds!',
  '钻石！',
  '火把不够用了！',
  'ES modules!',
  '没有构建步骤！',
  '程序生成！',
  'Procedurally generated!',
  '每个世界都独一无二！',
  '种子很重要！',
  '日出日落！',
  'Smooth lighting!',
  '环境光遮蔽！',
  '去造一座房子吧！',
  'Mind the gap!',
  '再挖一格！',
  '睡前再看一眼！',
  '也可以在超平坦里建造！',
  '方块世界，无限可能！',
  'Made with canvas!',
  '开源精神！',
  '比看起来更好玩！',
  'Craft all the things!',
  '工作台在哪？',
  '仙人掌会扎人！',
  '甘蔗长在水边！',
  '找到下界了吗？还没有！',
  '刷新试试！',
  '16 × 16 × 256！',
]);

/** "2026/10/12 08:30" from a timestamp. */
export function formatDate(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
