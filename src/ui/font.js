// Pixel font for the UI, generated at runtime (no font files, no network): original 5x7-style glyphs
// for printable ASCII are turned into a TrueType font (square contours) and registered with the
// FontFace API under the family "WebCraft Pixel". CSS lists it first, so Latin letters, digits and
// punctuation render blocky like Minecraft while Chinese falls back to Microsoft YaHei / PingFang.
//
// Glyph grid: 8 rows per glyph — rows 0..6 sit on/above the baseline (cap height 7), row 7 is the
// descender. One font pixel = 1/8 em, so with CSS font-size = 8 GUI pixels one glyph pixel is exactly
// one GUI pixel. Advance = glyph width + 1 (letter spacing), space = 4.
// buildPixelFont() is pure (Node-testable); loadPixelFont() needs a browser.

export const PIXEL_FONT_FAMILY = 'WebCraft Pixel';

// '#' = ink, anything else = empty. Rows may be omitted at the bottom.
const GLYPHS = {
  ' ': ['...'],
  '!': ['#', '#', '#', '#', '#', '.', '#'],
  '"': ['#.#', '#.#'],
  '#': ['.#.#.', '.#.#.', '#####', '.#.#.', '#####', '.#.#.', '.#.#.'],
  '$': ['..#..', '.####', '#....', '.###.', '....#', '####.', '..#..'],
  '%': ['#...#', '#..#.', '...#.', '..#..', '.#...', '.#..#', '#...#'],
  '&': ['..#..', '.#.#.', '..#..', '.##.#', '#..#.', '#..#.', '.##.#'],
  "'": ['#', '#'],
  '(': ['..#', '.#.', '#..', '#..', '#..', '.#.', '..#'],
  ')': ['#..', '.#.', '..#', '..#', '..#', '.#.', '#..'],
  '*': ['.....', '..#..', '#.#.#', '.###.', '#.#.#', '..#..'],
  '+': ['.....', '..#..', '..#..', '#####', '..#..', '..#..'],
  ',': ['.', '.', '.', '.', '.', '.', '#', '#'],
  '-': ['.....', '.....', '.....', '#####'],
  '.': ['.', '.', '.', '.', '.', '.', '#'],
  '/': ['....#', '...#.', '...#.', '..#..', '.#...', '.#...', '#....'],
  '0': ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  '1': ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '#####'],
  '2': ['.###.', '#...#', '....#', '..##.', '.#...', '#...#', '#####'],
  '3': ['.###.', '#...#', '....#', '..##.', '....#', '#...#', '.###.'],
  '4': ['...##', '..#.#', '.#..#', '#...#', '#####', '....#', '....#'],
  '5': ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  '6': ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
  '7': ['#####', '#...#', '....#', '...#.', '..#..', '..#..', '..#..'],
  '8': ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  '9': ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
  ':': ['.', '.', '#', '.', '.', '.', '#'],
  ';': ['.', '.', '#', '.', '.', '.', '#', '#'],
  '<': ['...#', '..#.', '.#..', '#...', '.#..', '..#.', '...#'],
  '=': ['.....', '.....', '#####', '.....', '.....', '#####'],
  '>': ['#...', '.#..', '..#.', '...#', '..#.', '.#..', '#...'],
  '?': ['.###.', '#...#', '....#', '...#.', '..#..', '.....', '..#..'],
  '@': ['.####.', '#....#', '#..###', '#.#..#', '#..###', '#.....', '.####.'],
  'A': ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  'B': ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  'C': ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  'D': ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  'E': ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  'F': ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  'G': ['.####', '#....', '#....', '#..##', '#...#', '#...#', '.###.'],
  'H': ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  'I': ['###', '.#.', '.#.', '.#.', '.#.', '.#.', '###'],
  'J': ['....#', '....#', '....#', '....#', '#...#', '#...#', '.###.'],
  'K': ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  'L': ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  'M': ['#...#', '##.##', '#.#.#', '#...#', '#...#', '#...#', '#...#'],
  'N': ['#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#', '#...#'],
  'O': ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  'P': ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  'Q': ['.###.', '#...#', '#...#', '#...#', '#...#', '#..#.', '.##.#'],
  'R': ['####.', '#...#', '#...#', '####.', '#..#.', '#...#', '#...#'],
  'S': ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  'T': ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  'U': ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  'V': ['#...#', '#...#', '#...#', '#...#', '.#.#.', '.#.#.', '..#..'],
  'W': ['#...#', '#...#', '#...#', '#...#', '#.#.#', '##.##', '#...#'],
  'X': ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  'Y': ['#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..', '..#..'],
  'Z': ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
  '[': ['###', '#..', '#..', '#..', '#..', '#..', '###'],
  '\\': ['#....', '.#...', '.#...', '..#..', '...#.', '...#.', '....#'],
  ']': ['###', '..#', '..#', '..#', '..#', '..#', '###'],
  '^': ['..#..', '.#.#.', '#...#'],
  '_': ['.....', '.....', '.....', '.....', '.....', '.....', '.....', '#####'],
  '`': ['#.', '.#'],
  'a': ['.....', '.....', '.###.', '....#', '.####', '#...#', '.####'],
  'b': ['#....', '#....', '#.##.', '##..#', '#...#', '#...#', '####.'],
  'c': ['.....', '.....', '.###.', '#...#', '#....', '#...#', '.###.'],
  'd': ['....#', '....#', '.##.#', '#..##', '#...#', '#...#', '.####'],
  'e': ['.....', '.....', '.###.', '#...#', '#####', '#....', '.####'],
  'f': ['..##', '.#..', '####', '.#..', '.#..', '.#..', '.#..'],
  'g': ['.....', '.....', '.####', '#...#', '#...#', '.####', '....#', '####.'],
  'h': ['#....', '#....', '#.##.', '##..#', '#...#', '#...#', '#...#'],
  'i': ['#', '.', '#', '#', '#', '#', '#'],
  'j': ['...#', '....', '...#', '...#', '...#', '...#', '#..#', '.##.'],
  'k': ['#...', '#...', '#..#', '#.#.', '##..', '#.#.', '#..#'],
  'l': ['#.', '#.', '#.', '#.', '#.', '#.', '.#'],
  'm': ['.....', '.....', '##.#.', '#.#.#', '#.#.#', '#...#', '#...#'],
  'n': ['.....', '.....', '####.', '#...#', '#...#', '#...#', '#...#'],
  'o': ['.....', '.....', '.###.', '#...#', '#...#', '#...#', '.###.'],
  'p': ['.....', '.....', '#.##.', '##..#', '#...#', '####.', '#....', '#....'],
  'q': ['.....', '.....', '.##.#', '#..##', '#...#', '.####', '....#', '....#'],
  'r': ['.....', '.....', '#.##.', '##..#', '#....', '#....', '#....'],
  's': ['.....', '.....', '.####', '#....', '.###.', '....#', '####.'],
  't': ['.#.', '.#.', '###', '.#.', '.#.', '.#.', '..#'],
  'u': ['.....', '.....', '#...#', '#...#', '#...#', '#...#', '.####'],
  'v': ['.....', '.....', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  'w': ['.....', '.....', '#...#', '#...#', '#.#.#', '#.#.#', '.####'],
  'x': ['.....', '.....', '#...#', '.#.#.', '..#..', '.#.#.', '#...#'],
  'y': ['.....', '.....', '#...#', '#...#', '#...#', '.####', '....#', '####.'],
  'z': ['.....', '.....', '#####', '...#.', '..#..', '.#...', '#####'],
  '{': ['..##', '.#..', '.#..', '#...', '.#..', '.#..', '..##'],
  '|': ['#', '#', '#', '#', '#', '#', '#', '#'],
  '}': ['##..', '..#.', '..#.', '...#', '..#.', '..#.', '##..'],
  '~': ['......', '......', '.##..#', '#..##.'],
  '°': ['.#.', '#.#', '.#.'],                                    // °
  '·': ['.', '.', '.', '#'],                                     // ·
  '×': ['.....', '.....', '#...#', '.#.#.', '..#..', '.#.#.', '#...#'], // ×
};

const PX = 128;            // font units per pixel
const UPEM = PX * 8;       // 1 em = 8 pixels
const ASCENT = PX * 8;     // cap height 7 px + 1 px leading on top
const DESCENT = PX;        // 1 px descender

/** Pixel width of a glyph (max row length). */
function glyphWidth(rows) {
  return rows.reduce((w, r) => Math.max(w, r.length), 0);
}

/** Merge ink pixels into rectangles: horizontal runs, then identical runs stacked vertically. */
function glyphRects(rows) {
  const rects = [];
  const open = new Map(); // "x0,x1" -> rect still growing downwards
  for (let y = 0; y < rows.length; y++) {
    const runs = [];
    const row = rows[y];
    for (let x = 0; x < row.length; x++) {
      if (row[x] !== '#') continue;
      let e = x;
      while (e + 1 < row.length && row[e + 1] === '#') e++;
      runs.push([x, e + 1]);
      x = e;
    }
    const next = new Map();
    for (const [x0, x1] of runs) {
      const k = `${x0},${x1}`;
      const r = open.get(k);
      if (r && r.y1 === y) {
        r.y1 = y + 1;
        next.set(k, r);
        open.delete(k);
      } else {
        const nr = { x0, x1, y0: y, y1: y + 1 };
        rects.push(nr);
        next.set(k, nr);
      }
    }
    open.clear();
    for (const [k, r] of next) open.set(k, r);
  }
  return rects;
}

/** Growable big-endian byte writer. */
class Writer {
  constructor(size = 1024) {
    this.buf = new Uint8Array(size);
    this.view = new DataView(this.buf.buffer);
    this.pos = 0;
  }
  ensure(n) {
    if (this.pos + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.pos + n) size *= 2;
    const b = new Uint8Array(size);
    b.set(this.buf);
    this.buf = b;
    this.view = new DataView(b.buffer);
  }
  u8(v) { this.ensure(1); this.view.setUint8(this.pos, v); this.pos += 1; }
  u16(v) { this.ensure(2); this.view.setUint16(this.pos, v & 0xffff); this.pos += 2; }
  i16(v) { this.ensure(2); this.view.setInt16(this.pos, v); this.pos += 2; }
  u32(v) { this.ensure(4); this.view.setUint32(this.pos, v >>> 0); this.pos += 4; }
  tag(s) { for (let i = 0; i < 4; i++) this.u8(s.charCodeAt(i)); }
  bytes(arr) { this.ensure(arr.length); this.buf.set(arr, this.pos); this.pos += arr.length; }
  pad4() { while (this.pos % 4) this.u8(0); }
  done() { return this.buf.slice(0, this.pos); }
}

function checksum(bytes) {
  const padded = new Uint8Array((bytes.length + 3) & ~3);
  padded.set(bytes);
  const v = new DataView(padded.buffer);
  let sum = 0;
  for (let i = 0; i < padded.length; i += 4) sum = (sum + v.getUint32(i)) >>> 0;
  return sum;
}

function utf16be(str) {
  const out = new Uint8Array(str.length * 2);
  for (let i = 0; i < str.length; i++) {
    out[i * 2] = str.charCodeAt(i) >> 8;
    out[i * 2 + 1] = str.charCodeAt(i) & 0xff;
  }
  return out;
}

/**
 * Build the TrueType font binary.
 * @returns {ArrayBuffer}
 */
export function buildPixelFont(family = PIXEL_FONT_FAMILY) {
  const chars = Object.keys(GLYPHS).sort((a, b) => a.charCodeAt(0) - b.charCodeAt(0));
  // glyph 0 = .notdef (empty), then one glyph per char in code order
  const glyphs = [{ code: -1, rows: [], width: 4 }];
  for (const ch of chars) glyphs.push({ code: ch.charCodeAt(0), rows: GLYPHS[ch], width: glyphWidth(GLYPHS[ch]) });

  // ---- glyf / loca / hmtx
  const glyf = new Writer(8192);
  const loca = [];
  const metrics = [];
  let maxPoints = 0, maxContours = 0;
  let fxMin = 0, fyMin = 0, fxMax = 0, fyMax = 0;
  let maxAdvance = 0, totalAdvance = 0;
  for (const g of glyphs) {
    loca.push(glyf.pos);
    const advance = (g.width + 1) * PX;
    maxAdvance = Math.max(maxAdvance, advance);
    totalAdvance += advance;
    const rects = glyphRects(g.rows);
    if (!rects.length) {
      metrics.push([advance, 0]);
      continue;
    }
    const contours = rects.map((r) => {
      const x0 = r.x0 * PX, x1 = r.x1 * PX;
      const yTop = (7 - r.y0) * PX, yBot = (7 - r.y1) * PX;
      // clockwise in y-up font space
      return [[x0, yBot], [x0, yTop], [x1, yTop], [x1, yBot]];
    });
    const pts = contours.flat();
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const xMin = Math.min(...xs), xMax = Math.max(...xs), yMin = Math.min(...ys), yMax = Math.max(...ys);
    fxMin = Math.min(fxMin, xMin); fyMin = Math.min(fyMin, yMin);
    fxMax = Math.max(fxMax, xMax); fyMax = Math.max(fyMax, yMax);
    maxPoints = Math.max(maxPoints, pts.length);
    maxContours = Math.max(maxContours, contours.length);
    glyf.i16(contours.length);
    glyf.i16(xMin); glyf.i16(yMin); glyf.i16(xMax); glyf.i16(yMax);
    let end = -1;
    for (const c of contours) { end += c.length; glyf.u16(end); }
    glyf.u16(0); // no instructions
    for (let i = 0; i < pts.length; i++) glyf.u8(0x01); // on-curve, 16-bit deltas
    let px = 0;
    for (const [x] of pts) { glyf.i16(x - px); px = x; }
    let py = 0;
    for (const [, y] of pts) { glyf.i16(y - py); py = y; }
    glyf.pad4();
    metrics.push([advance, xMin]);
  }
  loca.push(glyf.pos);
  const glyfBytes = glyf.done();

  const locaW = new Writer();
  for (const off of loca) locaW.u32(off);

  const hmtx = new Writer();
  for (const [adv, lsb] of metrics) { hmtx.u16(adv); hmtx.i16(lsb); }

  // ---- cmap (format 4): consecutive codes with consecutive glyph ids share a segment
  const segs = [];
  for (let gi = 1; gi < glyphs.length; gi++) {
    const code = glyphs[gi].code;
    const last = segs[segs.length - 1];
    if (last && code === last.end + 1 && gi === last.glyph + (code - last.start)) last.end = code;
    else segs.push({ start: code, end: code, glyph: gi });
  }
  segs.push({ start: 0xffff, end: 0xffff, glyph: 0, delta: 1 });
  const segCount = segs.length;
  let pow = 1, log = 0;
  while (pow * 2 <= segCount) { pow *= 2; log++; }
  const cmap = new Writer();
  cmap.u16(0); cmap.u16(1);              // version, numTables
  cmap.u16(3); cmap.u16(1); cmap.u32(12); // Windows Unicode BMP
  cmap.u16(4); cmap.u16(16 + segCount * 8); cmap.u16(0);
  cmap.u16(segCount * 2); cmap.u16(pow * 2); cmap.u16(log); cmap.u16(segCount * 2 - pow * 2);
  for (const s of segs) cmap.u16(s.end);
  cmap.u16(0);
  for (const s of segs) cmap.u16(s.start);
  for (const s of segs) cmap.u16(s.delta ?? (s.glyph - s.start));
  for (let i = 0; i < segCount; i++) cmap.u16(0);

  // ---- head
  const head = new Writer();
  head.u16(1); head.u16(0); head.u32(0x00010000);
  head.u32(0);               // checkSumAdjustment (patched below)
  head.u32(0x5f0f3cf5);
  head.u16(0x000b);          // baseline at 0, lsb at 0, integer ppem
  head.u16(UPEM);
  head.u32(0); head.u32(0); head.u32(0); head.u32(0); // created / modified
  head.i16(fxMin); head.i16(fyMin); head.i16(fxMax); head.i16(fyMax);
  head.u16(0); head.u16(8); head.i16(2);
  head.i16(1);               // long loca
  head.i16(0);

  // ---- hhea
  const hhea = new Writer();
  hhea.u16(1); hhea.u16(0);
  hhea.i16(ASCENT); hhea.i16(-DESCENT); hhea.i16(0);
  hhea.u16(maxAdvance);
  hhea.i16(0); hhea.i16(0); hhea.i16(fxMax);
  hhea.i16(1); hhea.i16(0); hhea.i16(0);
  for (let i = 0; i < 4; i++) hhea.i16(0);
  hhea.i16(0); hhea.u16(glyphs.length);

  // ---- maxp
  const maxp = new Writer();
  maxp.u32(0x00010000); maxp.u16(glyphs.length);
  maxp.u16(maxPoints); maxp.u16(maxContours); maxp.u16(0); maxp.u16(0);
  maxp.u16(2); maxp.u16(0); maxp.u16(0); maxp.u16(0); maxp.u16(0); maxp.u16(0); maxp.u16(0);
  maxp.u16(0); maxp.u16(0);

  // ---- OS/2 (version 4)
  const os2 = new Writer();
  os2.u16(4);
  os2.i16(Math.round(totalAdvance / glyphs.length));
  os2.u16(400); os2.u16(5); os2.u16(0);
  os2.i16(UPEM / 2); os2.i16(UPEM / 2); os2.i16(0); os2.i16(PX); // subscript
  os2.i16(UPEM / 2); os2.i16(UPEM / 2); os2.i16(0); os2.i16(PX * 4); // superscript
  os2.i16(PX); os2.i16(PX * 3);  // strikeout size / position
  os2.i16(0);                    // family class
  os2.bytes(new Uint8Array([2, 0, 6, 9, 0, 0, 0, 0, 0, 0])); // panose (monospace-ish sans)
  os2.u32(1); os2.u32(0); os2.u32(0); os2.u32(0);              // Basic Latin
  os2.tag('WCFT');
  os2.u16(0x0040 | 0x0080);      // REGULAR | USE_TYPO_METRICS
  os2.u16(glyphs[1].code); os2.u16(glyphs[glyphs.length - 1].code);
  os2.i16(ASCENT); os2.i16(-DESCENT); os2.i16(0);
  os2.u16(ASCENT); os2.u16(DESCENT);
  os2.u32(1); os2.u32(0);
  os2.i16(PX * 5); os2.i16(PX * 7); os2.u16(0); os2.u16(32); os2.u16(1);

  // ---- name
  const names = [
    [1, family], [2, 'Regular'], [3, `${family} Regular 1.0`], [4, family], [5, 'Version 1.0'],
    [6, family.replace(/\s+/g, '') + '-Regular'],
  ];
  const strings = names.map(([, s]) => utf16be(s));
  const name = new Writer();
  name.u16(0); name.u16(names.length); name.u16(6 + names.length * 12);
  let off = 0;
  names.forEach(([id], i) => {
    name.u16(3); name.u16(1); name.u16(0x0409); name.u16(id);
    name.u16(strings[i].length); name.u16(off);
    off += strings[i].length;
  });
  for (const s of strings) name.bytes(s);

  // ---- post (version 3: no glyph names)
  const post = new Writer();
  post.u32(0x00030000); post.u32(0);
  post.i16(-PX); post.i16(PX);
  post.u32(0); post.u32(0); post.u32(0); post.u32(0); post.u32(0);

  // ---- gasp: no grid-fitting, grayscale off -> crisp aliased squares where honoured
  const gasp = new Writer();
  gasp.u16(1); gasp.u16(1); gasp.u16(0xffff); gasp.u16(0x0000);

  const tables = [
    ['OS/2', os2.done()], ['cmap', cmap.done()], ['gasp', gasp.done()], ['glyf', glyfBytes],
    ['head', head.done()], ['hhea', hhea.done()], ['hmtx', hmtx.done()], ['loca', locaW.done()],
    ['maxp', maxp.done()], ['name', name.done()], ['post', post.done()],
  ].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  const numTables = tables.length;
  let sp = 1, es = 0;
  while (sp * 2 <= numTables) { sp *= 2; es++; }
  const font = new Writer(glyfBytes.length + 8192);
  font.u32(0x00010000); font.u16(numTables); font.u16(sp * 16); font.u16(es); font.u16(numTables * 16 - sp * 16);
  let offset = 12 + numTables * 16;
  const placed = [];
  for (const [tag, data] of tables) {
    font.tag(tag); font.u32(checksum(data)); font.u32(offset); font.u32(data.length);
    placed.push([tag, offset, data]);
    offset += (data.length + 3) & ~3;
  }
  let headOffset = 0;
  for (const [tag, at, data] of placed) {
    if (tag === 'head') headOffset = at;
    font.bytes(data);
    font.pad4();
  }
  const bytes = font.done();
  const adjust = (0xb1b0afba - checksum(bytes)) >>> 0;
  new DataView(bytes.buffer).setUint32(headOffset + 8, adjust);
  return bytes.buffer;
}

/** Characters covered by the pixel font (CSS unicode-range syntax). */
export function pixelFontUnicodeRange() {
  return 'U+0020-007E, U+00B0, U+00B7, U+00D7';
}

let loading = null;

/**
 * Register the pixel font with document.fonts (browser only). Resolves to true when the font is
 * usable, false if the browser rejected it (the CSS stack then falls back to system fonts).
 */
export function loadPixelFont(family = PIXEL_FONT_FAMILY) {
  if (loading) return loading;
  if (typeof FontFace === 'undefined' || typeof document === 'undefined' || !document.fonts) {
    loading = Promise.resolve(false);
    return loading;
  }
  loading = (async () => {
    try {
      const face = new FontFace(family, buildPixelFont(family), {
        style: 'normal', weight: '400', unicodeRange: pixelFontUnicodeRange(),
      });
      document.fonts.add(face);
      await face.load();
      return true;
    } catch (err) {
      console.warn('[ui] pixel font unavailable, using system fonts:', err?.message ?? err);
      return false;
    }
  })();
  return loading;
}

/** Glyph advance in font pixels (used for layout estimates). Unknown chars count as 8 (CJK width). */
export function measurePixelText(text) {
  let w = 0;
  for (const ch of text) {
    const g = GLYPHS[ch];
    w += g ? glyphWidth(g) + 1 : 8;
  }
  return w;
}

/** Raw glyph rows (for canvas-drawn pixel text such as the logo). */
export function getGlyph(ch) {
  return GLYPHS[ch] ?? null;
}
