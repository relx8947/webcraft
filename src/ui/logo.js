// Title-screen artwork: the blocky "WEBCRAFT" logo built from stone-textured cubes (letters use the
// pixel-font glyph shapes, one cube per glyph pixel, with bevels and an extruded 3D depth) and the
// pixel-art "方块世界" subtitle. Both return canvases at GUI-pixel resolution; CSS scales them with
// image-rendering: pixelated.
import { getGlyph } from './font.js';
import { makeCanvas, ctx2d, textureOrFallback } from './assets.js';

const CELL = 6;   // canvas pixels per letter cube
const DEPTH = 5;  // extrusion depth (pixels)

/**
 * Paint the logo.
 * @param {object|null} textures  generateTextures() result (stone texture), or null for the fallback
 * @param {string} [text]
 * @returns {HTMLCanvasElement}
 */
export function paintLogo(textures, text = 'WEBCRAFT') {
  const glyphs = [...text].map((ch) => getGlyph(ch) ?? getGlyph('?'));
  const cols = glyphs.reduce((w, g) => w + g.reduce((m, r) => Math.max(m, r.length), 0) + 1, -1);
  const rows = 7;
  const grid = Array.from({ length: rows }, () => new Uint8Array(cols));
  let ox = 0;
  for (const g of glyphs) {
    const w = g.reduce((m, r) => Math.max(m, r.length), 0);
    for (let y = 0; y < rows; y++) {
      const row = g[y] ?? '';
      for (let x = 0; x < w; x++) if (row[x] === '#') grid[y][ox + x] = 1;
    }
    ox += w + 1;
  }
  const on = (x, y) => y >= 0 && y < rows && x >= 0 && x < cols && grid[y][x] === 1;

  const pad = 2;
  const W = cols * CELL + pad * 2;
  const H = rows * CELL + DEPTH + pad * 2;
  const canvas = makeCanvas(W, H);
  const g = ctx2d(canvas);
  const img = g.createImageData(W, H);
  const d = img.data;
  const stone = textureOrFallback(textures, 'stone');
  const S = stone.size;
  const put = (x, y, r, gg, b) => {
    const i = (y * W + x) * 4;
    d[i] = Math.max(0, Math.min(255, r));
    d[i + 1] = Math.max(0, Math.min(255, gg));
    d[i + 2] = Math.max(0, Math.min(255, b));
    d[i + 3] = 255;
  };
  const texel = (tx, ty) => {
    const i = ((((ty % S) + S) % S) * S + (((tx % S) + S) % S)) * 4;
    return [stone.data[i], stone.data[i + 1], stone.data[i + 2]];
  };

  // 1) extrusion: darker copies shifted downwards, back to front
  for (let k = DEPTH; k >= 1; k--) {
    const f = 0.42 - k * 0.035;
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        if (!on(cx, cy)) continue;
        for (let py = 0; py < CELL; py++) {
          for (let px = 0; px < CELL; px++) {
            const tx = cx * CELL + px, ty = cy * CELL + py;
            const [r, gg, b] = texel(tx, ty + k);
            put(pad + tx, pad + ty + k, r * f, gg * f, b * f);
          }
        }
      }
    }
  }
  // 2) front faces with per-cube bevels and a top-to-bottom light gradient
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      if (!on(cx, cy)) continue;
      const up = on(cx, cy - 1), down = on(cx, cy + 1), left = on(cx - 1, cy), right = on(cx + 1, cy);
      for (let py = 0; py < CELL; py++) {
        for (let px = 0; px < CELL; px++) {
          const tx = cx * CELL + px, ty = cy * CELL + py;
          let [r, gg, b] = texel(tx, ty);
          let k = 1.22 - 0.38 * (ty / (rows * CELL));
          let add = 0;
          if (py === 0) add += up ? 10 : 46;
          if (px === 0) add += left ? 6 : 26;
          if (py === CELL - 1) add -= down ? 12 : 40;
          if (px === CELL - 1) add -= right ? 8 : 26;
          r = r * k + add; gg = gg * k + add; b = b * k + add;
          put(pad + tx, pad + ty, r, gg, b);
        }
      }
    }
  }
  // 3) dark outline around everything for contrast on the dirt background
  const alpha = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) alpha[i] = d[i * 4 + 3];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (alpha[y * W + x]) continue;
      let near = false;
      for (let dy = -1; dy <= 1 && !near; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < W && yy < H && alpha[yy * W + xx]) { near = true; break; }
        }
      }
      if (near) {
        const i = (y * W + x) * 4;
        d[i] = 16; d[i + 1] = 16; d[i + 2] = 16; d[i + 3] = 235;
      }
    }
  }
  g.putImageData(img, 0, 0);
  return canvas;
}

/**
 * Pixel-art subtitle: system CJK font rendered small, thresholded to hard pixels, gold gradient and
 * a dark outline, like Minecraft's edition banner.
 */
export function paintSubtitle(text = '方块世界', fontPx = 13) {
  const font = `bold ${fontPx}px "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif`;
  const probe = ctx2d(makeCanvas(4, 4));
  probe.font = font;
  const spacing = 2;
  const chars = [...text];
  const widths = chars.map((c) => Math.ceil(probe.measureText(c).width));
  const tw = widths.reduce((a, b) => a + b, 0) + spacing * (chars.length - 1);
  const W = tw + 6, H = fontPx + 8;
  const c = makeCanvas(W, H);
  const g = ctx2d(c);
  g.font = font;
  g.textBaseline = 'alphabetic';
  g.fillStyle = '#fff';
  let x = 3;
  chars.forEach((ch, i) => {
    g.fillText(ch, x, 3 + Math.round(fontPx * 0.86));
    x += widths[i] + spacing;
  });
  const img = g.getImageData(0, 0, W, H);
  const d = img.data;
  const mask = new Uint8Array(W * H);
  let top = H, bottom = 0;
  for (let i = 0; i < W * H; i++) {
    if (d[i * 4 + 3] > 120) {
      mask[i] = 1;
      const y = (i / W) | 0;
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  }
  d.fill(0);
  const span = Math.max(1, bottom - top);
  const set = (i, r, gg, b, a = 255) => { d[i * 4] = r; d[i * 4 + 1] = gg; d[i * 4 + 2] = b; d[i * 4 + 3] = a; };
  // drop shadow + outline first
  for (let y = 0; y < H; y++) {
    for (let xx = 0; xx < W; xx++) {
      const i = y * W + xx;
      if (mask[i]) continue;
      const n = (dx, dy) => {
        const X = xx + dx, Y = y + dy;
        return X >= 0 && Y >= 0 && X < W && Y < H && mask[Y * W + X];
      };
      if (n(-1, 0) || n(1, 0) || n(0, -1) || n(0, 1)) set(i, 58, 34, 8);
      else if (n(-1, -1) || n(-2, -2) || n(0, -2) || n(-1, -2)) set(i, 30, 18, 4, 200);
    }
  }
  for (let i = 0; i < W * H; i++) {
    if (!mask[i]) continue;
    const t = (((i / W) | 0) - top) / span;
    set(i, 255, Math.round(236 - 70 * t), Math.round(120 - 95 * t));
  }
  g.putImageData(img, 0, 0);
  return c;
}
