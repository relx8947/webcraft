#!/usr/bin/env node
// Lighting + meshing benchmark (Node). Builds realistic synthetic 3x3-chunk regions (noise hills,
// mountains, caves with lava and torches, trees, water, desert, snow) and times every stage of a
// worker mesh job: buildRegion -> computeLight -> meshChunk (all 16 sections) -> extractChunkLight.
//
//   node tools/mesher-bench.mjs                     # synthetic terrain, 40 timed runs per scenario
//   node tools/mesher-bench.mjs --runs 100 --seed 7
//   node tools/mesher-bench.mjs --worldgen          # also bench the real src/world/worldgen.js (if present)
//
// Budget (SPEC §9.2 / §11): light + mesh of a typical surface chunk < 25 ms (target < 12 ms).

import { performance } from 'node:perf_hooks';
import { buildRegion, computeLight, extractChunkLight, regionMaxY } from '../src/world/lighting.js';
import { meshChunk } from '../src/world/mesher.js';
import { REGION_VOLUME, CHUNK_VOLUME } from '../src/config.js';
import { createTerrain, neighbourhood } from './mesher-terrain.mjs';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? Number(args[i + 1]) : def;
};
const RUNS = opt('--runs', 40);
const SEED = opt('--seed', 12345);
const USE_WORLDGEN = args.includes('--worldgen');

const regionBuf = new Uint8Array(REGION_VOLUME);
const lightBuf = new Uint8Array(REGION_VOLUME);
const chunkLight = new Uint8Array(CHUNK_VOLUME);

function stats(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))];
  return { med: q(0.5), p95: q(0.95), min: s[0], mean: s.reduce((a, b) => a + b, 0) / s.length };
}

function countQuads(sections) {
  const c = { opaque: 0, cutout: 0, translucent: 0, bytes: 0 };
  for (const s of sections) {
    for (const k of ['opaque', 'cutout', 'translucent']) {
      if (s[k]) { c[k] += s[k].length / 12; c.bytes += s[k].byteLength; }
    }
  }
  return c;
}

function runScenario(name, chunks, tints, smooth) {
  const t = { region: [], light: [], mesh: [], extract: [], total: [] };
  let sections = null;
  const once = () => {
    const t0 = performance.now();
    const region = buildRegion(chunks, regionBuf);
    const t1 = performance.now();
    const light = computeLight(region, lightBuf);
    const t2 = performance.now();
    sections = meshChunk(region, light, 0xffff, tints, { smoothLighting: smooth });
    const t3 = performance.now();
    extractChunkLight(light, chunkLight);
    const t4 = performance.now();
    return [t1 - t0, t2 - t1, t3 - t2, t4 - t3, t4 - t0];
  };
  for (let i = 0; i < 8; i++) once();             // JIT warm-up
  for (let i = 0; i < RUNS; i++) {
    const r = once();
    t.region.push(r[0]); t.light.push(r[1]); t.mesh.push(r[2]); t.extract.push(r[3]); t.total.push(r[4]);
  }
  const maxY = regionMaxY(buildRegion(chunks, regionBuf));
  return { name, smooth, maxY, quads: countQuads(sections), t: Object.fromEntries(Object.entries(t).map(([k, v]) => [k, stats(v)])) };
}

function describe(chunk) {
  let water = 0, lava = 0, air = 0;
  for (let i = 0; i < chunk.length; i++) {
    const v = chunk[i];
    if (v === 0) air++;
    else if (v === 14) water++;
    else if (v === 15) lava++;
  }
  return { water, lava, air };
}

const fmt = (x) => x.toFixed(2).padStart(6);

function printTable(results) {
  console.log('\nscenario                     smooth maxY | region  light   mesh  extract | light+mesh med  p95   | quads opq/cut/trn    KB');
  console.log('-'.repeat(132));
  for (const r of results) {
    const lm = r.t.light.med + r.t.mesh.med;
    const lmP95 = r.t.light.p95 + r.t.mesh.p95;
    console.log(
      `${r.name.padEnd(28)} ${String(r.smooth).padEnd(6)} ${String(r.maxY).padStart(4)} |` +
      `${fmt(r.t.region.med)} ${fmt(r.t.light.med)} ${fmt(r.t.mesh.med)} ${fmt(r.t.extract.med)} |` +
      `       ${fmt(lm)} ${fmt(lmP95)} | ${String(r.quads.opaque).padStart(5)}/${String(r.quads.cutout).padStart(5)}/${String(r.quads.translucent).padStart(5)} ${String(Math.round(r.quads.bytes / 1024)).padStart(5)}`);
  }
}

async function main() {
  console.log(`mesher-bench: ${RUNS} timed runs per scenario (median / p95 in ms), node ${process.version}`);
  const terrain = createTerrain(SEED);
  const cache = new Map();

  // Pick representative chunks by sampling the synthetic height field.
  const pick = (pred, label) => {
    for (let r = 0; r < 60; r++) {
      for (let a = 0; a < 8 * (r + 1); a++) {
        const ang = (a / (8 * (r + 1))) * Math.PI * 2;
        const cx = Math.round(Math.cos(ang) * r), cz = Math.round(Math.sin(ang) * r);
        let lo = 999, hi = -1, sum = 0;
        for (let i = 0; i < 16; i += 3) {
          for (let j = 0; j < 16; j += 3) {
            const h = terrain.heightAt(cx * 16 + i, cz * 16 + j);
            lo = Math.min(lo, h); hi = Math.max(hi, h); sum += h;
          }
        }
        if (pred(lo, hi, sum / 36)) return { cx, cz, label };
      }
    }
    return { cx: 0, cz: 0, label: label + ' (fallback)' };
  };
  const scenarios = [
    pick((lo, hi, avg) => lo > 64 && hi < 80, 'plains/forest surface'),
    pick((lo, hi, avg) => lo > 63 && hi - lo > 14 && hi < 110, 'hills'),
    pick((lo, hi, avg) => hi > 115, 'mountains'),
    pick((lo, hi, avg) => hi < 58, 'ocean'),
    pick((lo, hi, avg) => lo < 62 && hi > 64, 'coast'),
  ];

  const results = [];
  for (const s of scenarios) {
    const chunks = neighbourhood(terrain, s.cx, s.cz, cache);
    const tints = terrain.getTints(s.cx, s.cz);
    const d = describe(chunks[4]);
    const name = `${s.label} (${s.cx},${s.cz})`;
    console.log(`  ${name}: water ${d.water}, lava ${d.lava}, air ${d.air}`);
    results.push(runScenario(name, chunks, tints, true));
  }
  results.push(runScenario(results[0].name.replace(/ \(.*/, '') + ' flat-light', neighbourhood(terrain, scenarios[0].cx, scenarios[0].cz, cache), terrain.getTints(scenarios[0].cx, scenarios[0].cz), false));

  // Worst-case style: Swiss-cheese underground (lots of internal faces) with many torches.
  {
    const chunks = [];
    for (let n = 0; n < 9; n++) {
      const c = new Uint8Array(CHUNK_VOLUME);
      for (let i = 0; i < CHUNK_VOLUME; i++) {
        const y = i >> 8;
        if (y > 120) continue;
        const h = Math.imul(i * 2654435761 + n * 97, 2246822519) >>> 0;
        const r = (h >>> 8) / 16777216;
        c[i] = r < 0.35 ? 0 : r < 0.36 ? 46 /* torch */ : r < 0.37 ? 14 /* water */ : 1;
      }
      chunks.push(c);
    }
    results.push(runScenario('random noise y<=120 (worst)', chunks, null, true));
  }

  if (USE_WORLDGEN) {
    try {
      const { WorldGenerator } = await import('../src/world/worldgen.js');
      const gen = new WorldGenerator(SEED, 'default');
      const wcache = new Map();
      const sp = gen.findSpawn ? gen.findSpawn() : { x: 0, z: 0 };
      const coords = [[sp.x >> 4, sp.z >> 4], [(sp.x >> 4) + 7, (sp.z >> 4) - 4], [(sp.x >> 4) - 12, (sp.z >> 4) + 9]];
      for (const [cx, cz] of coords) {
        const gchunks = [];
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            const k = `${cx + dx},${cz + dz}`;
            if (!wcache.has(k)) wcache.set(k, gen.generateChunk(cx + dx, cz + dz));
            gchunks.push(wcache.get(k));
          }
        }
        results.push(runScenario(`worldgen (${cx},${cz})`, gchunks, gen.getTints(cx, cz), true));
      }
    } catch (e) {
      console.log(`  (real worldgen unavailable: ${e.message})`);
    }
  }

  printTable(results);
  const surface = results.filter((r) => !/worst|flat/.test(r.name));
  const worstLM = Math.max(...surface.map((r) => r.t.light.med + r.t.mesh.med));
  console.log(`\nworst surface-chunk light+mesh median: ${worstLM.toFixed(2)} ms (budget 25 ms, target 12 ms) -> ${worstLM < 12 ? 'OK (< 12 ms)' : worstLM < 25 ? 'OK (< 25 ms)' : 'OVER BUDGET'}`);
}

main();
