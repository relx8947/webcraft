#!/usr/bin/env node
// Tile several PNG screenshots into one image (row-major), e.g. to compare a time-of-day sequence.
//   node tools/render-montage.mjs out.png columns in1.png in2.png ...
import fs from 'node:fs';
import { decodePNG, encodePNG } from './render-crop.mjs';

const [out, colsArg, ...inputs] = process.argv.slice(2);
if (!out || !inputs.length) {
  console.error('usage: render-montage.mjs out.png columns in1.png [in2.png ...]');
  process.exit(2);
}
const imgs = inputs.map((p) => decodePNG(fs.readFileSync(p)));
const cols = Math.max(1, Number(colsArg) || 4);
const rows = Math.ceil(imgs.length / cols);
const w = Math.max(...imgs.map((i) => i.width)), h = Math.max(...imgs.map((i) => i.height));
const pad = 4;
const W = cols * w + (cols + 1) * pad, H = rows * h + (rows + 1) * pad;
const data = new Uint8Array(W * H * 4);
for (let i = 3; i < data.length; i += 4) data[i] = 255;
imgs.forEach((img, k) => {
  const ox = pad + (k % cols) * (w + pad), oy = pad + Math.floor(k / cols) * (h + pad);
  for (let y = 0; y < img.height; y++) {
    data.set(img.data.subarray(y * img.width * 4, (y + 1) * img.width * 4), ((oy + y) * W + ox) * 4);
  }
});
fs.writeFileSync(out, encodePNG(W, H, data));
console.log(`montage ${cols}x${rows} -> ${out}`);
