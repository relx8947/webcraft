// Worker for tools/worldgen-map.html: generates chunks and returns compact per-column summaries
// (top block, heights, water depth, biome, tints) or full block arrays.
import { WorldGenerator } from '../src/world/worldgen.js';
import { BLOCK, IS_LIQUID } from '../src/world/registry.js';

let gen = null;

const AIR = BLOCK.AIR;
const WATER = BLOCK.WATER;
const ICE = BLOCK.ICE;

function summarize(cx, cz) {
  const t0 = performance.now();
  const b = gen.generateChunk(cx, cz);
  const ms = performance.now() - t0;
  const top = new Uint8Array(256);     // top non-air block (plants included)
  const topY = new Uint8Array(256);
  const ground = new Uint8Array(256);  // top solid terrain block under plants / water
  const groundY = new Uint8Array(256);
  const depth = new Uint8Array(256);   // water depth
  const biome = new Uint8Array(256);
  for (let lz = 0; lz < 16; lz++) {
    for (let lx = 0; lx < 16; lx++) {
      const c = (lz << 4) | lx;
      let y = 255;
      while (y > 0 && b[(y << 8) | c] === AIR) y--;
      top[c] = b[(y << 8) | c];
      topY[c] = y;
      let d = 0;
      let gy = y;
      while (gy > 0) {
        const id = b[(gy << 8) | c];
        if (id === WATER || id === ICE) d++;
        else if (!(IS_LIQUID[id]) && id !== AIR) break;
        gy--;
      }
      depth[c] = d;
      ground[c] = b[(gy << 8) | c];
      groundY[c] = gy;
      biome[c] = gen.colBiome[(lz + 6) * 28 + lx + 6];
    }
  }
  const t = gen.getTints(cx, cz);
  return { cx, cz, top, topY, ground, groundY, depth, biome, grass: t.grass, foliage: t.foliage, ms };
}

self.onmessage = (ev) => {
  const m = ev.data;
  try {
    if (m.type === 'init') {
      gen = new WorldGenerator(m.seed, m.worldType || 'default');
      self.postMessage({ type: 'ready' });
    } else if (m.type === 'map') {
      const out = m.chunks.map(([cx, cz]) => summarize(cx, cz));
      self.postMessage({ type: 'map', id: m.id, out });
    } else if (m.type === 'overview') {
      // m.chunks = [{ x0, z, step, w, row }]: one row of 2D samples per entry
      const out = [];
      for (const r of m.chunks) {
        const h = new Float32Array(r.w);
        const b = new Uint8Array(r.w);
        const rv = new Float32Array(r.w);
        for (let i = 0; i < r.w; i++) {
          const s = gen.sampleColumn(r.x0 + i * r.step, r.z);
          h[i] = s.height;
          b[i] = s.biome;
          rv[i] = s.river;
        }
        out.push({ row: r.row, h, b, rv });
      }
      self.postMessage({ type: 'overview', id: m.id, out });
    } else if (m.type === 'full') {
      const out = [];
      const transfer = [];
      for (const [cx, cz] of m.chunks) {
        const blocks = gen.generateChunk(cx, cz);
        out.push({ cx, cz, blocks });
        transfer.push(blocks.buffer);
      }
      self.postMessage({ type: 'full', id: m.id, out }, transfer);
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err && err.stack || err) });
  }
};
