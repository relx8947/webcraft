import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorldGenerator, BIOMES, BIOME_ID, parseSeed, debugBuildTree } from '../src/world/worldgen.js';
import { hashString } from '../src/util/noise.js';
import { BLOCK, BLOCKS, IS_SOLID, RENDER_TYPE, RENDER, hasSupport } from '../src/world/registry.js';
import { SEA_LEVEL } from '../src/config.js';

const SEED = 12345;
const gen = new WorldGenerator(SEED);
const idx = (x, y, z) => (y << 8) | (z << 4) | x;
const LOGS = new Set([BLOCK.OAK_LOG, BLOCK.OAK_LOG_X, BLOCK.OAK_LOG_Z, BLOCK.BIRCH_LOG, BLOCK.SPRUCE_LOG]);
const LEAVES = new Set([BLOCK.OAK_LEAVES, BLOCK.BIRCH_LEAVES, BLOCK.SPRUCE_LEAVES]);

/** Generate a (2r+1)^2 block of chunks around (cx, cz) and return a world-coordinate accessor. */
function region(g, cx, cz, r) {
  const chunks = new Map();
  for (let dz = -r; dz <= r; dz++) {
    for (let dx = -r; dx <= r; dx++) chunks.set((cx + dx) + ',' + (cz + dz), g.generateChunk(cx + dx, cz + dz));
  }
  const get = (x, y, z) => {
    if (y < 0 || y > 255) return BLOCK.AIR;
    const c = chunks.get((x >> 4) + ',' + (z >> 4));
    return c ? c[(y << 8) | ((z & 15) << 4) | (x & 15)] : -1;
  };
  return { chunks, get, x0: (cx - r) * 16, x1: (cx + r + 1) * 16, z0: (cz - r) * 16, z1: (cz + r + 1) * 16 };
}

/** Find a column of the given biome near the origin (2D sampling only). */
function findBiome(g, biomeName, maxR = 3000) {
  const id = BIOMES.find((b) => b.name === biomeName).id;
  for (let r = 0; r <= maxR; r += 24) {
    const steps = Math.max(8, Math.floor(r / 12));
    for (let k = 0; k < steps; k++) {
      const a = (k / steps) * Math.PI * 2;
      const x = Math.round(r * Math.cos(a));
      const z = Math.round(r * Math.sin(a));
      if (g.sampleColumn(x, z).biome === id) return { x, z };
    }
  }
  return null;
}

test('parseSeed: integers map mod 2^32, text is hashed', () => {
  assert.equal(parseSeed('12345'), 12345);
  assert.equal(parseSeed('  42 '), 42);
  assert.equal(parseSeed('0'), 0);
  assert.equal(parseSeed('-1'), 4294967295);
  assert.equal(parseSeed('4294967296'), 0);
  assert.equal(parseSeed('4294967297'), 1);
  assert.equal(parseSeed('+7'), 7);
  // Minecraft-style 64-bit seed: exact low 32 bits
  assert.equal(parseSeed('8678942899319966093'), Number(BigInt('8678942899319966093') & 0xffffffffn));
  assert.equal(parseSeed('-8678942899319966093'), Number(BigInt.asUintN(32, -8678942899319966093n)));
  assert.equal(parseSeed('glacier'), hashString('glacier'));
  assert.equal(parseSeed('我的世界'), hashString('我的世界'));
  assert.equal(parseSeed('12a'), hashString('12a'));
  assert.equal(parseSeed('1.5'), hashString('1.5'));
  for (const s of ['abc', '123', '-99', 'x y z']) {
    const v = parseSeed(s);
    assert.ok(Number.isInteger(v) && v >= 0 && v <= 0xffffffff);
  }
});

test('BIOMES table has the required biomes with Chinese names', () => {
  const names = new Map(BIOMES.map((b) => [b.name, b]));
  const required = {
    ocean: '海洋', deep_ocean: '深海', beach: '沙滩', plains: '平原', forest: '森林', birch_forest: '桦木森林',
    taiga: '针叶林', snowy_plains: '雪原', desert: '沙漠', mountains: '山地', river: '河流',
  };
  for (const [name, zh] of Object.entries(required)) {
    assert.ok(names.has(name), `missing biome ${name}`);
    assert.equal(names.get(name).displayName, zh);
  }
  BIOMES.forEach((b, i) => {
    assert.equal(b.id, i);
    assert.match(b.displayName, /[一-鿿]/);
    assert.ok(Number.isInteger(b.grassColor) && Number.isInteger(b.foliageColor));
  });
  // packed r | g << 8 | b << 16
  assert.equal(names.get('plains').grassColor, 0x91 | (0xbd << 8) | (0x59 << 16));
  assert.equal(names.get('desert').foliageColor, 0xae | (0xa4 << 8) | (0x2a << 16));
  assert.equal(BIOME_ID.DESERT, names.get('desert').id);
});

test('generation is deterministic and seed-dependent', () => {
  const a = new WorldGenerator(SEED).generateChunk(3, -2);
  const b = new WorldGenerator(SEED).generateChunk(3, -2);
  assert.ok(a instanceof Uint8Array && a.length === 65536);
  assert.deepEqual(a, b);
  const c = new WorldGenerator(SEED + 1).generateChunk(3, -2);
  let diff = 0;
  for (let i = 0; i < 65536; i++) if (a[i] !== c[i]) diff++;
  assert.ok(diff > 1000, 'another seed gives another world');
  // every byte is a valid block id
  for (let i = 0; i < 65536; i++) assert.ok(BLOCKS[a[i]], `invalid id ${a[i]}`);
});

test('chunks are independent of generation order (features crossing borders match)', () => {
  const order = [];
  for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) order.push([dx - 9, dz + 4]);
  const g1 = new WorldGenerator(777);
  const first = new Map(order.map(([x, z]) => [x + ',' + z, g1.generateChunk(x, z)]));
  const g2 = new WorldGenerator(777);
  for (const [x, z] of [...order].reverse()) {
    // interleave unrelated far-away chunks to disturb any internal caches
    g2.generateChunk(x + 100, z - 50);
    assert.deepEqual(g2.generateChunk(x, z), first.get(x + ',' + z), `chunk ${x},${z}`);
  }
});

test('trees crossing chunk borders are derived identically by every chunk they touch', () => {
  let crossing = 0;
  let checked = 0;
  const spots = ['forest', 'taiga', 'birch_forest', 'flower_forest', 'snowy_taiga'].map((n) => findBiome(gen, n)).filter(Boolean);
  for (const [cx, cz] of spots.map((p) => [p.x >> 4, p.z >> 4])) {
    const r = region(gen, cx, cz, 1);
    const trees = gen._debugTreesFor(cx, cz);
    for (const t of trees) {
      const tcx = t.x >> 4;
      const tcz = t.z >> 4;
      if (tcx !== cx || tcz !== cz) {
        crossing++;
        // the trunk's own chunk lists the same tree
        const own = gen._debugTreesFor(tcx, tcz).find((u) => u.x === t.x && u.z === t.z);
        assert.deepEqual(own, t);
      }
      if (Math.abs(tcx - cx) <= 1 && Math.abs(tcz - cz) <= 1) {
        // trunk base stands on soil and its first log exists
        const base = r.get(t.x, t.y, t.z);
        const below = r.get(t.x, t.y - 1, t.z);
        assert.ok(LOGS.has(base), `trunk at ${t.x},${t.y},${t.z} is ${BLOCKS[base]?.name}`);
        assert.ok(below === BLOCK.DIRT, `soil under trunk is ${BLOCKS[below]?.name}`);
        checked++;
      }
    }
  }
  assert.ok(crossing > 5, `found ${crossing} border-crossing trees`);
  assert.ok(checked > 20);
});

test('every leaves block belongs to a tree (no orphan canopies at chunk borders)', () => {
  const f = findBiome(gen, 'forest');
  const r = region(gen, f.x >> 4, f.z >> 4, 2);
  let leaves = 0;
  // inner area: at least 6 blocks away from the region edge so every trunk is loaded
  for (let x = r.x0 + 6; x < r.x1 - 6; x++) {
    for (let z = r.z0 + 6; z < r.z1 - 6; z++) {
      for (let y = 60; y < 200; y++) {
        if (!LEAVES.has(r.get(x, y, z))) continue;
        leaves++;
        let found = false;
        for (let dy = -9; dy <= 2 && !found; dy++) {
          for (let dx = -5; dx <= 5 && !found; dx++) {
            for (let dz = -5; dz <= 5 && !found; dz++) if (LOGS.has(r.get(x + dx, y + dy, z + dz))) found = true;
          }
        }
        assert.ok(found, `orphan leaves at ${x},${y},${z}`);
      }
    }
  }
  assert.ok(leaves > 200, `region has trees (${leaves} leaves)`);
});

test('bedrock floor: y=0 solid, y=1..4 random, none above', () => {
  for (const [cx, cz] of [[0, 0], [7, -3], [-20, 11]]) {
    const b = gen.generateChunk(cx, cz);
    const counts = [0, 0, 0, 0, 0, 0];
    for (let y = 0; y <= 5; y++) {
      for (let i = 0; i < 256; i++) if (b[(y << 8) | i] === BLOCK.BEDROCK) counts[y]++;
    }
    assert.equal(counts[0], 256);
    for (let y = 1; y <= 4; y++) assert.ok(counts[y] > 0 && counts[y] < 256, `y=${y}: ${counts[y]}`);
    assert.ok(counts[1] > counts[4], 'denser at the bottom');
    for (let y = 5; y < 256; y++) for (let i = 0; i < 256; i++) assert.notEqual(b[(y << 8) | i], BLOCK.BEDROCK);
  }
});

test('no floating water or lava (no fluid next to air below its surface)', () => {
  for (const [cx, cz] of [[0, 0], [2, -9], [-12, -27], [19, -6]]) {
    const r = region(gen, cx, cz, 1);
    let water = 0;
    for (let x = cx * 16; x < cx * 16 + 16; x++) {
      for (let z = cz * 16; z < cz * 16 + 16; z++) {
        for (let y = 1; y < 255; y++) {
          const id = r.get(x, y, z);
          if (id !== BLOCK.WATER && id !== BLOCK.LAVA) continue;
          if (id === BLOCK.WATER) {
            water++;
            assert.ok(y <= SEA_LEVEL, 'water only up to sea level');
          } else {
            assert.ok(y <= 10, `lava at y=${y}`);
          }
          for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]]) {
            assert.notEqual(r.get(x + dx, y + dy, z + dz), BLOCK.AIR, `${BLOCKS[id].name} at ${x},${y},${z} touches air`);
          }
          if (r.get(x, y + 1, z) === BLOCK.AIR) {
            assert.equal(y, id === BLOCK.WATER ? SEA_LEVEL : 10, 'open fluid surface only at its level');
          }
        }
      }
    }
    if (cx === 0 && cz === 0) assert.ok(water > 0, 'origin chunk has some water to test');
  }
});

test('caves exist, lava fills cave air at y <= 10, and ores sit at Minecraft-like depths', () => {
  const maxY = {};
  const count = {};
  let caveAir = 0;
  let lava = 0;
  const names = ['coal_ore', 'iron_ore', 'gold_ore', 'redstone_ore', 'diamond_ore', 'lapis_ore'];
  for (let i = 0; i < 24; i++) {
    const b = gen.generateChunk(i * 3 - 30, (i % 5) * 7 - 14);
    for (let y = 1; y < 40; y++) {
      for (let c = 0; c < 256; c++) {
        const id = b[(y << 8) | c];
        if (id === BLOCK.AIR) caveAir++;
        if (id === BLOCK.LAVA) lava++;
        if (id === BLOCK.AIR) assert.ok(y > 10, 'cave air below y=11 must be lava');
      }
    }
    for (let k = 0; k < 65536; k++) {
      const name = BLOCKS[b[k]].name;
      if (!names.includes(name)) continue;
      const y = k >> 8;
      count[name] = (count[name] ?? 0) + 1;
      maxY[name] = Math.max(maxY[name] ?? 0, y);
    }
  }
  assert.ok(caveAir > 1000, `caves present (${caveAir})`);
  assert.ok(lava > 100, `lava present (${lava})`);
  for (const n of names) assert.ok(count[n] > 0, `${n} generated`);
  assert.ok(maxY.diamond_ore <= 20 && maxY.redstone_ore <= 20, 'diamonds / redstone below 16 (+vein size)');
  assert.ok(maxY.gold_ore <= 36 && maxY.lapis_ore <= 36, 'gold / lapis below 32');
  assert.ok(maxY.iron_ore <= 68, 'iron below 64');
  assert.ok(count.coal_ore > count.iron_ore && count.iron_ore > count.gold_ore && count.gold_ore > count.diamond_ore);
  const perChunk = (n) => count[n] / 24;
  assert.ok(perChunk('coal_ore') > 60 && perChunk('coal_ore') < 260, `coal ${perChunk('coal_ore')}`);
  assert.ok(perChunk('diamond_ore') > 0.5 && perChunk('diamond_ore') < 10, `diamond ${perChunk('diamond_ore')}`);
});

test('surface: grass with dirt below on land, biome-dependent surface blocks', () => {
  const b = gen.generateChunk(0, 0);
  let grassTop = 0;
  for (let z = 0; z < 16; z++) {
    for (let x = 0; x < 16; x++) {
      let y = 255;
      while (y > 0 && (b[idx(x, y, z)] === BLOCK.AIR || !IS_SOLID[b[idx(x, y, z)]] || LEAVES.has(b[idx(x, y, z)]))) y--;
      if (b[idx(x, y, z)] === BLOCK.GRASS_BLOCK) {
        grassTop++;
        assert.equal(b[idx(x, y - 1, z)], BLOCK.DIRT);
      }
    }
  }
  assert.ok(grassTop > 0);
  // desert: sand surface with sandstone underneath
  const d = findBiome(gen, 'desert');
  assert.ok(d, 'a desert exists near the origin');
  const db = gen.generateChunk(d.x >> 4, d.z >> 4);
  let sandCols = 0;
  for (let i = 0; i < 256; i++) {
    let y = 255;
    while (y > 0 && !IS_SOLID[db[(y << 8) | i]]) y--;
    if (db[(y << 8) | i] === BLOCK.SAND || db[(y << 8) | i] === BLOCK.CACTUS) sandCols++;
  }
  assert.ok(sandCols > 128, `desert chunk mostly sand (${sandCols})`);
  let sandstone = 0;
  for (let k = 0; k < 65536; k++) if (db[k] === BLOCK.SANDSTONE) sandstone++;
  assert.ok(sandstone > 256);
});

test('cacti never touch other blocks horizontally and stand on sand; sugar cane is next to water', () => {
  const d = findBiome(gen, 'desert');
  const r = region(gen, d.x >> 4, d.z >> 4, 2);
  let cacti = 0;
  let canes = 0;
  for (let x = r.x0 + 1; x < r.x1 - 1; x++) {
    for (let z = r.z0 + 1; z < r.z1 - 1; z++) {
      for (let y = 60; y < 200; y++) {
        const id = r.get(x, y, z);
        if (id === BLOCK.CACTUS) {
          cacti++;
          for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            assert.equal(r.get(x + dx, y, z + dz), BLOCK.AIR, `cactus at ${x},${y},${z} touches a block`);
          }
          const below = r.get(x, y - 1, z);
          assert.ok(below === BLOCK.SAND || below === BLOCK.CACTUS);
          assert.ok(r.get(x, y - 3, z) !== BLOCK.CACTUS || r.get(x, y - 1, z) !== BLOCK.CACTUS ||
            r.get(x, y - 2, z) !== BLOCK.CACTUS, 'at most 3 tall');
        }
      }
    }
  }
  assert.ok(cacti > 0, 'desert has cacti');
  // sugar cane anywhere in a few regions with water
  for (const [cx, cz] of [[0, 0], [2, 1], [-2, 2]]) {
    const w = region(gen, cx, cz, 2);
    for (let x = w.x0 + 1; x < w.x1 - 1; x++) {
      for (let z = w.z0 + 1; z < w.z1 - 1; z++) {
        for (let y = SEA_LEVEL + 1; y < SEA_LEVEL + 4; y++) {
          if (w.get(x, y, z) !== BLOCK.SUGAR_CANE || w.get(x, y - 1, z) === BLOCK.SUGAR_CANE) continue;
          canes++;
          const ground = w.get(x, y - 1, z);
          assert.ok(hasSupport(BLOCK.SUGAR_CANE, ground), `cane on ${BLOCKS[ground].name}`);
          const wet = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => w.get(x + dx, y - 1, z + dz) === BLOCK.WATER);
          assert.ok(wet, `sugar cane at ${x},${y},${z} without adjacent water`);
          let h = 0;
          while (w.get(x, y + h, z) === BLOCK.SUGAR_CANE) h++;
          assert.ok(h >= 1 && h <= 3);
        }
      }
    }
  }
  assert.ok(canes > 0, 'some sugar cane near the origin');
});

test('plants are always supported', () => {
  const r = region(gen, 0, 0, 2);
  let plants = 0;
  for (let x = r.x0; x < r.x1; x++) {
    for (let z = r.z0; z < r.z1; z++) {
      for (let y = 1; y < 255; y++) {
        const id = r.get(x, y, z);
        if (RENDER_TYPE[id] !== RENDER.CROSS) continue;
        plants++;
        assert.ok(hasSupport(id, r.get(x, y - 1, z)), `${BLOCKS[id].name} at ${x},${y},${z} on ${BLOCKS[r.get(x, y - 1, z)].name}`);
      }
    }
  }
  assert.ok(plants > 50);
});

test('frozen biomes freeze their water surface', () => {
  const s = findBiome(gen, 'frozen_river') ?? findBiome(gen, 'frozen_ocean');
  assert.ok(s, 'a frozen water biome exists');
  const b = gen.generateChunk(s.x >> 4, s.z >> 4);
  let ice = 0;
  for (let i = 0; i < 256; i++) if (b[(SEA_LEVEL << 8) | i] === BLOCK.ICE) ice++;
  assert.ok(ice > 0, 'ice on the water surface');
});

test('getBiome matches the generator and biomes are large', () => {
  const b0 = gen.getBiome(0, 0);
  assert.ok(BIOMES.includes(b0));
  assert.equal(gen.getBiome(0.7, 0.2), gen.getBiome(0, 0), 'fractional coordinates use the block');
  // per-column biome used during generation equals getBiome()
  gen.generateChunk(-3, 5);
  for (let z = 0; z < 16; z += 5) {
    for (let x = 0; x < 16; x += 5) {
      const e = (z + 6) * 28 + (x + 6);
      assert.equal(gen.colBiome[e], gen.getBiome(-48 + x, 80 + z).id);
    }
  }
  // biome regions are hundreds of blocks: along a line most neighbours (16 apart) share the biome
  let same = 0;
  let total = 0;
  let prev = gen.getBiome(-2000, 300).id;
  for (let x = -2000 + 16; x < 2000; x += 16) {
    const id = gen.getBiome(x, 300).id;
    if (id === prev) same++;
    total++;
    prev = id;
  }
  assert.ok(same / total > 0.8, `biome coherence ${same}/${total}`);
  const found = new Set();
  for (let x = -3000; x <= 3000; x += 100) for (let z = -3000; z <= 3000; z += 100) found.add(gen.getBiome(x, z).name);
  for (const n of ['ocean', 'deep_ocean', 'beach', 'plains', 'forest', 'birch_forest', 'taiga', 'snowy_plains', 'desert', 'mountains', 'river']) {
    assert.ok(found.has(n), `biome ${n} occurs within 3000 blocks`);
  }
});

test('terrain heights are smooth across biome borders and mountains are tall', () => {
  let maxJump = 0;
  let maxH = 0;
  for (let z = -1500; z <= 1500; z += 50) {
    let prev = gen.sampleColumn(-1500, z).height;
    for (let x = -1499; x <= 1500; x++) {
      const h = gen.sampleColumn(x, z).height;
      if (x % 3 === 0) maxH = Math.max(maxH, h);
      maxJump = Math.max(maxJump, Math.abs(h - prev));
      prev = h;
    }
  }
  assert.ok(maxJump < 12, `largest height step between adjacent columns ${maxJump.toFixed(1)}`);
  assert.ok(maxH > 150 && maxH < 240, `highest point ${maxH.toFixed(0)}`);
});

test('tints: packed colours, smooth and continuous across chunk borders', () => {
  const a = gen.getTints(0, 0);
  const b = gen.getTints(1, 0);
  assert.ok(a.grass instanceof Uint32Array && a.grass.length === 256 && a.foliage.length === 256);
  const ch = (p, s) => (p >> s) & 255;
  for (const t of [a, b]) {
    for (let i = 0; i < 256; i++) {
      assert.equal(t.grass[i] >>> 24, 0, 'top byte reserved');
      const g = ch(t.grass[i], 8);
      assert.ok(g > ch(t.grass[i], 16) && g > 100, 'grass is green-ish');
    }
  }
  // continuity: column x=15 of chunk 0 vs x=0 of chunk 1
  for (let z = 0; z < 16; z++) {
    const p = a.grass[z * 16 + 15];
    const q = b.grass[z * 16];
    for (const s of [0, 8, 16]) assert.ok(Math.abs(ch(p, s) - ch(q, s)) <= 6, 'continuous at the border');
  }
  // returned arrays are copies (callers may transfer them)
  a.grass[0] = 0;
  assert.notEqual(gen.getTints(0, 0).grass[0], 0);
  // different climates give different colours
  const desert = findBiome(gen, 'desert');
  const snowy = findBiome(gen, 'snowy_plains');
  const td = gen.getTints(desert.x >> 4, desert.z >> 4).grass[(desert.z & 15) * 16 + (desert.x & 15)];
  const ts = gen.getTints(snowy.x >> 4, snowy.z >> 4).grass[(snowy.z & 15) * 16 + (snowy.x & 15)];
  assert.ok(ch(td, 0) > ch(ts, 0) + 30, 'desert grass is yellower than snowy grass');
});

test('findSpawn returns a dry land column near the origin', () => {
  for (const seed of [SEED, 1, 987654321, hashString('spawn test')]) {
    const g = new WorldGenerator(seed);
    const s = g.findSpawn();
    assert.ok(Number.isInteger(s.x) && Number.isInteger(s.z) && Number.isInteger(s.y));
    assert.ok(Math.hypot(s.x, s.z) < 3000, `spawn ${s.x},${s.z} near origin`);
    const b = g.generateChunk(s.x >> 4, s.z >> 4);
    const lx = s.x & 15;
    const lz = s.z & 15;
    const ground = b[idx(lx, s.y - 1, lz)];
    assert.ok([BLOCK.GRASS_BLOCK, BLOCK.SAND, BLOCK.SNOWY_GRASS_BLOCK, BLOCK.DIRT].includes(ground), `ground ${BLOCKS[ground].name}`);
    assert.ok(s.y - 1 >= SEA_LEVEL);
    assert.ok(!IS_SOLID[b[idx(lx, s.y, lz)]] && !IS_SOLID[b[idx(lx, s.y + 1, lz)]], 'room for the player');
    assert.notEqual(b[idx(lx, s.y, lz)], BLOCK.WATER);
    assert.deepEqual(g.findSpawn(), s, 'cached');
  }
});

test('flat world type', () => {
  const g = new WorldGenerator(5, 'flat');
  const b = g.generateChunk(-3, 8);
  for (let i = 0; i < 256; i++) {
    assert.equal(b[i], BLOCK.BEDROCK);
    assert.equal(b[256 + i], BLOCK.DIRT);
    assert.equal(b[512 + i], BLOCK.DIRT);
    assert.equal(b[768 + i], BLOCK.GRASS_BLOCK);
    for (let y = 4; y < 256; y++) assert.equal(b[(y << 8) | i], BLOCK.AIR);
  }
  assert.equal(g.getBiome(100, 100).name, 'plains');
  assert.deepEqual(g.findSpawn(), { x: 0, z: 0, y: 4 });
  const t = g.getTints(0, 0);
  assert.equal(t.grass[0], 0x91 | (0xbd << 8) | (0x59 << 16));
});

/** In-memory world access for growTree tests: grass floor at y=63. */
function testWorld() {
  const m = new Map();
  return {
    m,
    getBlock(x, y, z) {
      const k = x + ',' + y + ',' + z;
      if (m.has(k)) return m.get(k);
      if (y < 63) return BLOCK.DIRT;
      if (y === 63) return BLOCK.GRASS_BLOCK;
      return BLOCK.AIR;
    },
    setBlock(x, y, z, id) {
      m.set(x + ',' + y + ',' + z, id);
    },
  };
}

test('growTree grows every kind on open ground and refuses blocked spots', () => {
  let rs = 1;
  const rng = () => ((rs = (rs * 16807) % 2147483647) / 2147483647);
  for (const kind of ['oak', 'birch', 'spruce', 'large_oak', 'tall_birch', 'pine', BLOCK.OAK_SAPLING, 'spruce_sapling']) {
    const w = testWorld();
    w.setBlock(0, 64, 0, BLOCK.OAK_SAPLING);
    assert.equal(gen.growTree(w, 0, 64, 0, kind, rng), true, `grow ${kind}`);
    assert.ok(LOGS.has(w.getBlock(0, 64, 0)), 'sapling replaced by a log');
    assert.equal(w.getBlock(0, 63, 0), BLOCK.DIRT, 'grass under trunk becomes dirt');
    let leaves = 0;
    for (const id of w.m.values()) if (LEAVES.has(id)) leaves++;
    assert.ok(leaves > 10, `${kind} has leaves`);
  }
  // blocked by a solid block above the sapling
  const w = testWorld();
  w.setBlock(0, 67, 0, BLOCK.STONE);
  assert.equal(gen.growTree(w, 0, 64, 0, 'oak', rng), false);
  assert.equal(w.getBlock(0, 64, 0), BLOCK.AIR, 'nothing placed when blocked');
  // no soil below
  const w2 = testWorld();
  w2.setBlock(5, 63, 5, BLOCK.STONE);
  assert.equal(gen.growTree(w2, 5, 64, 5, 'birch', rng), false);
  // leaves never replace solid blocks
  const w3 = testWorld();
  w3.setBlock(2, 67, 0, BLOCK.COBBLESTONE);
  if (gen.growTree(w3, 0, 64, 0, 'oak', rng)) assert.equal(w3.getBlock(2, 67, 0), BLOCK.COBBLESTONE);
  // unknown kind
  assert.equal(gen.growTree(testWorld(), 0, 64, 0, 'palm', rng), false);
});

test('tree builders stay within their declared reach', () => {
  for (const kind of ['oak', 'large_oak', 'birch', 'tall_birch', 'spruce', 'pine']) {
    for (let s = 1; s < 60; s++) {
      const { height, blocks } = debugBuildTree(kind, s * 7919);
      assert.ok(height >= 4 && height <= 16);
      for (const b of blocks) {
        assert.ok(Math.abs(b.x) <= 5 && Math.abs(b.z) <= 5, `${kind} reach ${b.x},${b.z}`);
        assert.ok(b.y >= 0 && b.y <= height + 4);
      }
    }
  }
});

test('performance: generateChunk averages well under 15 ms', () => {
  const g = new WorldGenerator(424242);
  for (let i = 0; i < 6; i++) g.generateChunk(100 + i, 100); // warm-up (JIT)
  const N = 100;
  const t0 = performance.now();
  for (let i = 0; i < N; i++) g.generateChunk((i % 10) * 3 - 15, Math.floor(i / 10) * 3 - 15);
  const avg = (performance.now() - t0) / N;
  console.log(`# generateChunk average ${avg.toFixed(2)} ms over ${N} chunks`);
  assert.ok(avg < 15, `average ${avg.toFixed(2)} ms`);
  const t1 = performance.now();
  for (let i = 0; i < 50; i++) g.getTints(i, -i);
  const tints = (performance.now() - t1) / 50;
  console.log(`# getTints average ${tints.toFixed(2)} ms`);
  assert.ok(tints < 5);
});
