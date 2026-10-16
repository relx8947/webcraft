import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateTextures, getLayerAlphaModes, buildMipChain, generateMiscTextures, paintTexture,
  hasTexturePainter, renderIconPixels, MISSING_TEXTURES,
} from '../src/render/textures.js';
import { TEXTURES, TEXTURE_LAYER_COUNT, BLOCK, ITEM, ALL_ITEM_IDS, SPAWN_EGG_MOBS } from '../src/world/registry.js';

const tex = generateTextures();
const modes = getLayerAlphaModes();
const LAYER = 1024;
const entry = (name) => TEXTURES.find((t) => t.name === name);
const layerOf = (name, frame = 0) => tex.data.subarray((entry(name).layer + frame) * LAYER, (entry(name).layer + frame + 1) * LAYER);
const px = (d, x, y) => {
  const i = (y * 16 + x) * 4;
  return [d[i], d[i + 1], d[i + 2], d[i + 3]];
};

test('one layer per texture frame, RGBA 16x16', () => {
  assert.equal(tex.size, 16);
  assert.equal(tex.layers, TEXTURE_LAYER_COUNT);
  assert.equal(tex.data.length, TEXTURE_LAYER_COUNT * 16 * 16 * 4);
  assert.ok(tex.data instanceof Uint8Array);
});

test('every registry texture has a painter; unknown names throw', () => {
  const missing = TEXTURES.filter((t) => !hasTexturePainter(t.name)).map((t) => t.name);
  assert.deepEqual(missing, []);
  assert.throws(() => paintTexture('definitely_not_a_texture'), /no painter/);
  // paintTexture agrees with generateTextures for every layer (frames included).
  for (const t of TEXTURES) {
    for (let f = 0; f < t.frames; f++) assert.deepEqual(paintTexture(t.name, f), layerOf(t.name, f), `${t.name}#${f}`);
  }
});

test('alpha modes per layer follow the registry (frames expanded)', () => {
  assert.equal(modes.length, TEXTURE_LAYER_COUNT);
  for (const t of TEXTURES) for (let f = 0; f < t.frames; f++) assert.equal(modes[t.layer + f], t.alphaMode, t.name);
  assert.ok(modes.every((m) => ['opaque', 'tintmask', 'cutout', 'translucent'].includes(m)));
});

test('opaque layers are fully opaque, cutout layers binary, translucent layers partially transparent', () => {
  for (let L = 0; L < TEXTURE_LAYER_COUNT; L++) {
    const d = tex.data.subarray(L * LAYER, (L + 1) * LAYER);
    let opaque = 0;
    for (let i = 3; i < LAYER; i += 4) {
      const a = d[i];
      if (modes[L] === 'opaque') assert.equal(a, 255, `layer ${L} alpha`);
      if (modes[L] === 'cutout' || modes[L] === 'tintmask') assert.ok(a === 0 || a === 255, `layer ${L} alpha ${a}`);
      if (a === 255) opaque++;
    }
    if (modes[L] === 'cutout') assert.ok(opaque >= 8, `cutout layer ${L} is (nearly) empty`);
  }
});

test('tint-mask textures: grass top fully tinted, grass side fringe 3-6 px, tinted texels grey', () => {
  const top = layerOf('grass_block_top');
  for (let i = 0; i < 256; i++) {
    assert.equal(top[i * 4 + 3], 0);
    assert.ok(top[i * 4] === top[i * 4 + 1] && top[i * 4 + 1] === top[i * 4 + 2]);
  }
  const side = layerOf('grass_block_side');
  for (let x = 0; x < 16; x++) {
    let depth = 0;
    while (depth < 16 && px(side, x, depth)[3] === 0) depth++;
    assert.ok(depth >= 3 && depth <= 6, `column ${x} fringe depth ${depth}`);
    for (let y = depth; y < 16; y++) assert.equal(px(side, x, y)[3], 255, `dirt below the fringe at ${x},${y}`);
    for (let y = 0; y < depth; y++) {
      const [r, g, b] = px(side, x, y);
      assert.ok(r === g && g === b, 'fringe texel must be grayscale');
    }
  }
  // Dirt part of the side matches the dirt block below the fringe.
  const dirt = layerOf('dirt');
  assert.deepEqual(px(side, 5, 12), px(dirt, 5, 12));
});

test('tinted cutout textures (leaves, grass, fern, sugar cane) are painted grayscale', () => {
  for (const t of TEXTURES.filter((e) => e.tinted && e.alphaMode === 'cutout')) {
    const d = layerOf(t.name);
    for (let i = 0; i < 256; i++) {
      if (d[i * 4 + 3] === 0) continue;
      assert.ok(d[i * 4] === d[i * 4 + 1] && d[i * 4 + 1] === d[i * 4 + 2], `${t.name} texel ${i} not grey`);
    }
  }
  for (const name of ['oak_leaves', 'birch_leaves', 'spruce_leaves']) {
    const d = layerOf(name);
    let holes = 0;
    for (let i = 3; i < LAYER; i += 4) if (d[i] === 0) holes++;
    assert.ok(holes / 256 >= 0.25 && holes / 256 <= 0.35, `${name} hole ratio ${holes / 256}`);
  }
});

test('translucent textures: water alpha ~170-190, ice translucent, crack overlays neutral + growing', () => {
  for (let f = 0; f < 16; f++) {
    const d = layerOf('water_still', f);
    for (let i = 3; i < LAYER; i += 4) assert.ok(d[i] >= 170 && d[i] <= 192, `water alpha ${d[i]}`);
  }
  const ice = layerOf('ice');
  for (let i = 3; i < LAYER; i += 4) assert.ok(ice[i] > 120 && ice[i] < 230);
  let prev = 0;
  for (let s = 0; s < 10; s++) {
    const d = layerOf(`destroy_stage_${s}`);
    let dark = 0;
    for (let i = 0; i < 256; i++) {
      const a = d[i * 4 + 3];
      if (a === 0) assert.deepEqual([d[i * 4], d[i * 4 + 1], d[i * 4 + 2]], [128, 128, 128], 'neutral transparent texel');
      else if (a > 200) dark++;
    }
    assert.ok(dark > prev, `stage ${s} must add cracks`);
    prev = dark;
  }
  assert.ok(prev > 100, 'stage 9 is heavily cracked');
});

test('torch occupies columns 7-8, rows 6-15 (mesher sub-rect); cactus side body opaque', () => {
  const torch = layerOf('torch');
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const inside = (x === 7 || x === 8) && y >= 6;
      assert.equal(px(torch, x, y)[3], inside ? 255 : 0, `torch ${x},${y}`);
    }
  }
  const cactus = layerOf('cactus_side');
  for (let y = 0; y < 16; y++) for (let x = 1; x < 15; x++) assert.equal(px(cactus, x, y)[3], 255);
  const ctop = layerOf('cactus_top');
  assert.equal(px(ctop, 0, 5)[3], 0, 'cactus top has a transparent 1-px rim');
  assert.equal(px(ctop, 5, 5)[3], 255);
});

test('deterministic: two runs produce identical bytes', () => {
  const again = generateTextures();
  assert.deepEqual(again.data, tex.data);
  const m1 = generateMiscTextures();
  const m2 = generateMiscTextures();
  assert.deepEqual(m1.clouds.data, m2.clouds.data);
  assert.deepEqual(m1.sun.data, m2.sun.data);
  assert.deepEqual(m1.moon.data, m2.moon.data);
});

test('block textures are not flat stubs', () => {
  for (const t of TEXTURES.filter((e) => e.kind === 'block')) {
    const d = layerOf(t.name);
    const colours = new Set();
    for (let i = 0; i < 256; i++) {
      if (d[i * 4 + 3] || t.alphaMode === 'tintmask') colours.add((d[i * 4] << 16) | (d[i * 4 + 1] << 8) | d[i * 4 + 2]);
    }
    assert.ok(colours.size >= 3, `${t.name} has only ${colours.size} colours`);
  }
});

/** Mean absolute RGB difference between two columns (or rows) of a layer. */
function lineDiff(d, a, b, vertical) {
  let s = 0;
  for (let k = 0; k < 16; k++) {
    const i = (vertical ? k * 16 + a : a * 16 + k) * 4;
    const j = (vertical ? k * 16 + b : b * 16 + k) * 4;
    s += Math.abs(d[i] - d[j]) + Math.abs(d[i + 1] - d[j + 1]) + Math.abs(d[i + 2] - d[j + 2]);
  }
  return s / 16;
}

// birch_log is left out on purpose: its sparse black marks (drawn with wrap-around, so it tiles by
// construction) make this edge statistic meaningless.
test('natural block textures tile seamlessly (edge seam no worse than interior)', () => {
  const natural = ['stone', 'dirt', 'grass_block_top', 'cobblestone', 'mossy_cobblestone', 'sand', 'gravel',
    'bedrock', 'clay', 'snow', 'granite', 'diorite', 'andesite', 'obsidian', 'oak_log', 'spruce_log',
    'oak_leaves', 'birch_leaves', 'spruce_leaves', 'glowstone', 'coal_block', 'white_wool',
    'red_wool', 'sandstone_top', 'sandstone_bottom', 'coal_ore', 'diamond_ore', 'lava_still', 'water_still', 'ice',
    'farmland', 'farmland_moist'];
  for (const name of natural) {
    const d = layerOf(name);
    for (const vertical of [true, false]) {
      let interior = 0;
      let worst = 0;
      for (let k = 0; k < 15; k++) {
        const v = lineDiff(d, k, k + 1, vertical);
        interior += v;
        worst = Math.max(worst, v);
      }
      interior /= 15;
      const seam = lineDiff(d, 15, 0, vertical);
      // Crisp pixel art has sharp interior edges too: the wrap-around edge must look like an
      // ordinary interior edge (no worse than ~the average and never beyond the worst one).
      assert.ok(seam <= Math.max(interior * 1.8, worst) + 6, `${name} ${vertical ? 'x' : 'y'} seam ${seam.toFixed(1)} vs ${interior.toFixed(1)}`);
    }
  }
});

test('animated liquids: 16 distinct frames that loop smoothly', () => {
  for (const name of ['water_still', 'lava_still']) {
    assert.equal(entry(name).frames, 16);
    const diff = (a, b) => {
      let s = 0;
      for (let i = 0; i < LAYER; i++) s += Math.abs(a[i] - b[i]);
      return s / 256;
    };
    let maxStep = 0;
    for (let f = 0; f < 15; f++) {
      const step = diff(layerOf(name, f), layerOf(name, f + 1));
      assert.ok(step > 0, `${name} frames ${f}/${f + 1} identical`);
      maxStep = Math.max(maxStep, step);
    }
    const wrap = diff(layerOf(name, 15), layerOf(name, 0));
    assert.ok(wrap > 0 && wrap <= maxStep * 1.25, `${name} loop step ${wrap.toFixed(1)} vs max ${maxStep.toFixed(1)}`);
  }
});

test('mip chain: sizes, opaque/cutout/tintmask rules, coverage preserved', () => {
  const mips = buildMipChain(tex.data, tex.size, tex.layers, modes);
  assert.equal(mips.length, 5);
  assert.equal(mips[0], tex.data);
  [16, 8, 4, 2, 1].forEach((s, k) => assert.equal(mips[k].length, s * s * 4 * tex.layers, `level ${k}`));
  for (let k = 1; k < 5; k++) {
    const s = 16 >> k;
    const n = s * s;
    for (let L = 0; L < tex.layers; L++) {
      let cov = 0;
      for (let i = 0; i < n; i++) {
        const a = mips[k][(L * n + i) * 4 + 3];
        if (modes[L] === 'opaque') assert.equal(a, 255);
        if (modes[L] === 'cutout') assert.ok(a === 0 || a === 255);
        if (a === 255) cov++;
      }
      if (modes[L] === 'cutout') {
        let cov0 = 0;
        for (let i = 0; i < 256; i++) if (tex.data[(L * 256 + i) * 4 + 3] === 255) cov0++;
        assert.ok(Math.abs(cov / n - cov0 / 256) <= 0.5 / n + 1e-9, `layer ${L} level ${k} coverage`);
      }
    }
  }
  // Tint mask averaged: grass top stays fully tinted, grass side partially at 1x1.
  const top = entry('grass_block_top').layer;
  assert.equal(mips[4][top * 4 + 3], 0);
  const side = entry('grass_block_side').layer;
  assert.ok(mips[4][side * 4 + 3] > 150 && mips[4][side * 4 + 3] < 255);
  // Alpha-weighted colour: averaged leaves stay grey-bright, not darkened by empty texels.
  const leaves = entry('oak_leaves').layer;
  assert.ok(mips[4][leaves * 4] > 90, 'no dark fringe from transparent texels');
});

test('sky textures: sun/moon 32x32 with transparent corners, 256x256 tileable clouds ~40%', () => {
  const misc = generateMiscTextures();
  for (const k of ['sun', 'moon']) {
    const m = misc[k];
    assert.equal(m.width, 32);
    assert.equal(m.height, 32);
    assert.equal(m.data.length, 32 * 32 * 4);
    assert.equal(m.data[3], 0, `${k} corner transparent`);
    assert.equal(m.data[(16 * 32 + 16) * 4 + 3], 255, `${k} centre opaque`);
  }
  const c = misc.clouds;
  assert.equal(c.width, 256);
  assert.equal(c.height, 256);
  assert.equal(c.data.length, 65536);
  let on = 0;
  for (const v of c.data) {
    assert.ok(v === 0 || v === 255);
    if (v) on++;
  }
  assert.ok(on / 65536 > 0.35 && on / 65536 < 0.45, `coverage ${on / 65536}`);
  // Tiles: wrap-around neighbours disagree no more often than interior neighbours.
  let interior = 0;
  let seam = 0;
  for (let y = 0; y < 256; y++) {
    seam += c.data[y * 256 + 255] !== c.data[y * 256] ? 1 : 0;
    for (let x = 0; x < 255; x++) interior += c.data[y * 256 + x] !== c.data[y * 256 + x + 1] ? 1 : 0;
  }
  assert.ok(seam / 256 <= (interior / (255 * 256)) * 2 + 0.02);
});

test('generateTextures is fast (< 150 ms)', () => {
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    generateTextures();
    best = Math.min(best, performance.now() - t0);
  }
  assert.ok(best < 150, `generateTextures took ${best.toFixed(1)} ms`);
});

test('item sprites have transparent backgrounds and solid bodies', () => {
  for (const t of TEXTURES.filter((e) => e.kind === 'item')) {
    const d = layerOf(t.name);
    for (const [x, y] of [[0, 0], [15, 0], [0, 15]]) assert.equal(px(d, x, y)[3], 0, `${t.name} corner ${x},${y}`);
    let solid = 0;
    for (let i = 3; i < LAYER; i += 4) if (d[i]) solid++;
    assert.ok(solid >= 20, `${t.name} only ${solid} texels`);
  }
});

test('icon pixels: isometric tinted grass block, flat sprites, empty air', () => {
  const size = 48;
  const grass = renderIconPixels(tex, BLOCK.GRASS_BLOCK, size);
  assert.equal(grass.length, size * size * 4);
  const at = (p, x, y) => [p[(y * size + x) * 4], p[(y * size + x) * 4 + 1], p[(y * size + x) * 4 + 2], p[(y * size + x) * 4 + 3]];
  const topPx = at(grass, 24, 8);
  assert.equal(topPx[3], 255);
  assert.ok(topPx[1] > topPx[0] && topPx[1] > topPx[2], `grass top should be green: ${topPx}`);
  assert.equal(at(grass, 1, 1)[3], 0, 'corner transparent');
  // Left (south, shade 0.8) is brighter than right (east, shade 0.6) on a uniform-ish block.
  const stone = renderIconPixels(tex, BLOCK.STONE, size);
  let left = 0;
  let right = 0;
  for (let y = 26; y < 40; y++) {
    for (let x = 6; x < 18; x++) left += at(stone, x, y)[1];
    for (let x = 30; x < 42; x++) right += at(stone, x, y)[1];
  }
  assert.ok(left > right * 1.15, 'south face lighter than east face');
  const air = renderIconPixels(tex, BLOCK.AIR, size);
  assert.ok(air.every((v) => v === 0));
  const diamond = renderIconPixels(tex, ITEM.DIAMOND, size);
  assert.ok(diamond.some((v, i) => i % 4 === 3 && v === 255));
  // Every item id renders something.
  for (const id of ALL_ITEM_IDS) {
    const p = renderIconPixels(tex, id, size);
    let n = 0;
    for (let i = 3; i < p.length; i += 4) if (p[i] > 0) n++;
    assert.ok(n > 20, `icon ${id} is empty`);
  }
  // Tinted cross plant uses the default grass tint.
  const sg = renderIconPixels(tex, BLOCK.SHORT_GRASS, size);
  let green = 0;
  for (let i = 0; i < sg.length; i += 4) if (sg[i + 3] && sg[i + 1] > sg[i] && sg[i + 1] > sg[i + 2]) green++;
  assert.ok(green > 50);
  // Hidden variants render as their base item; unknown ids are transparent.
  assert.deepEqual(renderIconPixels(tex, BLOCK.FURNACE_NORTH, size), renderIconPixels(tex, BLOCK.FURNACE, size));
  assert.deepEqual(renderIconPixels(tex, BLOCK.OAK_LOG_X, size), renderIconPixels(tex, BLOCK.OAK_LOG, size));
  assert.ok(renderIconPixels(tex, 9999, size).every((v) => v === 0));
  // Other icon sizes work (pure rasteriser).
  assert.equal(renderIconPixels(tex, BLOCK.STONE, 32).length, 32 * 32 * 4);
});

// ---------------------------------------------------------------------------------------- wave 2
const lumaOf = ([r, g, b]) => 0.299 * r + 0.587 * g + 0.114 * b;
function meanOf(d, x0, y0, x1, y1, f = lumaOf) {
  let s = 0;
  let n = 0;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { s += f(px(d, x, y)); n++; }
  return s / n;
}
const opaqueCount = (d) => { let n = 0; for (let i = 3; i < LAYER; i += 4) if (d[i] === 255) n++; return n; };
const grey = ([r, g, b]) => Math.max(r, g, b) - Math.min(r, g, b) < 10;

test('wave 2: every new texture is painted (no missing-texture checker left)', () => {
  assert.deepEqual(MISSING_TEXTURES, []);
  for (const name of ['chest_top', 'chest_side', 'chest_front', 'furnace_front_on', 'farmland', 'farmland_moist',
    'bow_pulling_0', 'bow_pulling_1', 'bow_pulling_2', 'wheat_seeds', 'wheat', 'arrow', 'bow']) {
    const d = layerOf(name);
    // The checker is magenta (248, 0, 248) / black: no painted texture may contain that magenta.
    for (let i = 0; i < 256; i++) assert.ok(!(d[i * 4] === 248 && d[i * 4 + 1] === 0 && d[i * 4 + 2] === 248), name);
  }
});

test('wave 2: chest faces = whole box faces (mesher maps them in full), latch where the lock box samples', () => {
  const front = layerOf('chest_front');
  const side = layerOf('chest_side');
  const top = layerOf('chest_top');
  // Latch: grey iron texels at cols 7..8, rows 4..7 (the mesher's lock box: front u 7..9 v 4..8,
  // top row 4, bottom row 7, sides column 7); lit top-left texel much brighter than the bottom one.
  for (let y = 4; y <= 7; y++) for (let x = 7; x <= 8; x++) assert.ok(grey(px(front, x, y)), `latch texel ${x},${y}`);
  assert.ok(lumaOf(px(front, 7, 4)) > lumaOf(px(front, 8, 7)) + 60, 'latch is lit from the top-left');
  // The side has no latch: no grey texels.
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) assert.ok(!grey(px(side, x, y)), `side ${x},${y} is wood`);
  for (const d of [front, side]) {
    // The gap under the lid (row 6) is much darker than the boards around it.
    const gap = meanOf(d, 1, 6, 5, 6);
    const lid = meanOf(d, 1, 1, 14, 4);
    const base = meanOf(d, 1, 7, 14, 14);
    assert.ok(gap < lid * 0.45 && gap < base * 0.45, `gap ${gap.toFixed(0)} vs lid ${lid.toFixed(0)} / base ${base.toFixed(0)}`);
    // Box edges on the outer ring, darker than the boards.
    assert.ok(meanOf(d, 1, 0, 14, 0) < lid && meanOf(d, 15, 1, 15, 14) < base && meanOf(d, 1, 15, 14, 15) < base, 'edges');
  }
  // Top: edge ring darker than the boards.
  assert.ok(meanOf(top, 1, 15, 14, 15) < meanOf(top, 1, 1, 14, 14) * 0.75, 'lid edge');
  // Warm oak: red > green > blue on the boards.
  const [r, g, b] = px(side, 6, 9);
  assert.ok(r > g && g > b, `chest wood colour ${[r, g, b]}`);
});

test('wave 2: lit furnace = furnace front + fire in the opening', () => {
  const off = layerOf('furnace_front');
  const on = layerOf('furnace_front_on');
  for (let y = 0; y <= 2; y++) for (let x = 0; x < 16; x++) assert.deepEqual(px(on, x, y), px(off, x, y), `stone ${x},${y}`);
  let fire = 0;
  for (let y = 8; y <= 12; y++) {
    for (let x = 3; x <= 12; x++) {
      const [r, g, b] = px(on, x, y);
      if (r > 200 && r >= g && g > b) fire++;
    }
  }
  assert.ok(fire >= 15, `fire texels ${fire}`);
  // Hottest at the bottom of the opening.
  assert.ok(meanOf(on, 3, 12, 12, 12) > meanOf(on, 3, 8, 12, 8) + 60);
});

test('wave 2: farmland furrows, moist farmland darker', () => {
  const dry = layerOf('farmland');
  const wet = layerOf('farmland_moist');
  const mDry = meanOf(dry, 0, 0, 15, 15);
  const mWet = meanOf(wet, 0, 0, 15, 15);
  assert.ok(mWet < mDry * 0.65, `moist ${mWet.toFixed(0)} vs dry ${mDry.toFixed(0)}`);
  // Furrows: some row of every 4-row band is clearly darker than the band mean (the groove).
  for (const d of [dry, wet]) {
    for (let band = 0; band < 4; band++) {
      const rows = [0, 1, 2, 3].map((k) => meanOf(d, 0, band * 4 + k, 15, band * 4 + k));
      const mean = rows.reduce((a, v) => a + v, 0) / 4;
      assert.ok(Math.min(...rows) < mean * 0.85, `band ${band} has a groove`);
    }
  }
});

test('wave 2: wheat grows stage by stage, green to golden, standing on the bottom edge', () => {
  let prevCount = 0;
  let prevTop = 16;
  for (let s = 0; s < 8; s++) {
    const d = layerOf(`wheat_stage_${s}`);
    const count = opaqueCount(d);
    assert.ok(count > prevCount, `stage ${s} adds pixels (${count} <= ${prevCount})`);
    let top = 16;
    for (let y = 15; y >= 0; y--) for (let x = 0; x < 16; x++) if (px(d, x, y)[3]) top = Math.min(top, y);
    const height = 16 - top;
    assert.ok(top <= prevTop, `stage ${s} at least as tall as the previous one`);
    assert.ok(height >= 2 * s + 1 && height <= 2 * s + 4, `stage ${s} height ${height}`);
    // Every plant stands on the ground row.
    let ground = 0;
    for (let x = 0; x < 16; x++) if (px(d, x, 15)[3]) ground++;
    assert.ok(ground >= 5, `stage ${s} ground texels ${ground}`);
    const mean = [0, 1, 2].map((c) => {
      let sum = 0;
      let n = 0;
      for (let i = 0; i < 256; i++) if (d[i * 4 + 3]) { sum += d[i * 4 + c]; n++; }
      return sum / n;
    });
    if (s <= 3) assert.ok(mean[1] > mean[0] + 30 && mean[1] > mean[2] + 30, `stage ${s} is green: ${mean.map(Math.round)}`);
    if (s === 7) assert.ok(mean[0] > mean[2] + 70 && mean[0] >= mean[1], `stage 7 is golden: ${mean.map(Math.round)}`);
    prevCount = count;
    prevTop = top;
  }
});

test('wave 2: bow frames, arrow orientation, spawn eggs in their mob colours', () => {
  const frames = ['bow', 'bow_pulling_0', 'bow_pulling_1', 'bow_pulling_2'].map((n) => layerOf(n));
  for (let i = 0; i < frames.length; i++) {
    for (let j = i + 1; j < frames.length; j++) assert.notDeepEqual(frames[i], frames[j], `bow frames ${i}/${j} differ`);
  }
  // Pulled frames carry a grey flint arrowhead in the top-left corner region; the resting bow does not.
  const greyIn = (d, x0, y0, x1, y1) => {
    let n = 0;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (px(d, x, y)[3] && grey(px(d, x, y)) && lumaOf(px(d, x, y)) > 120) n++;
    return n;
  };
  assert.equal(greyIn(frames[0], 0, 0, 5, 5), 0, 'resting bow has no arrow');
  for (let k = 1; k < 4; k++) assert.ok(greyIn(frames[k], 0, 0, 5, 5) >= 2, `bow_pulling_${k - 1} arrowhead`);
  // Item arrow: head at the top-right, fletching at the bottom-left.
  const arrow = layerOf('arrow');
  assert.ok(greyIn(arrow, 10, 0, 15, 5) >= 3, 'arrow head top-right');
  assert.ok(greyIn(arrow, 0, 9, 6, 15) >= 4, 'arrow fletching bottom-left');
  // Eggs: distinct, egg-shaped (opaque centre) and shaded two-tone.
  const eggs = SPAWN_EGG_MOBS.map(([mob]) => layerOf(`${mob}_spawn_egg`));
  for (let i = 0; i < eggs.length; i++) {
    assert.equal(px(eggs[i], 8, 8)[3], 255);
    for (let j = i + 1; j < eggs.length; j++) assert.notDeepEqual(eggs[i], eggs[j]);
    const colours = new Set();
    for (let k = 0; k < 256; k++) if (eggs[i][k * 4 + 3]) colours.add((eggs[i][k * 4] << 16) | (eggs[i][k * 4 + 1] << 8) | eggs[i][k * 4 + 2]);
    assert.ok(colours.size >= 8, `${SPAWN_EGG_MOBS[i][0]} egg shading + spots (${colours.size} colours)`);
  }
  // Creeper egg: green body with near-black spots.
  const creeper = layerOf('creeper_spawn_egg');
  let green = 0;
  let dark = 0;
  for (let k = 0; k < 256; k++) {
    if (!creeper[k * 4 + 3]) continue;
    const [r, g, b] = [creeper[k * 4], creeper[k * 4 + 1], creeper[k * 4 + 2]];
    if (g > r + 60 && g > b + 60) green++;
    else if (r + g + b < 90) dark++;
  }
  assert.ok(green > 40 && dark > 8, `creeper egg green ${green} dark ${dark}`);
});

test('wave 2 icons: chest box with its lock, crops -> seeds, hidden variants -> their item', () => {
  const size = 48;
  const at = (p, x, y) => [p[(y * size + x) * 4], p[(y * size + x) * 4 + 1], p[(y * size + x) * 4 + 2], p[(y * size + x) * 4 + 3]];
  const chest = renderIconPixels(tex, BLOCK.CHEST, size);
  const cube = renderIconPixels(tex, BLOCK.OAK_PLANKS, size);
  let inset = 0;
  let lock = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (at(cube, x, y)[3] && !at(chest, x, y)[3]) inset++;
      const c = at(chest, x, y);
      if (c[3] && x < size / 2 && grey(c)) lock++;
    }
  }
  assert.ok(inset > 60, `chest icon is the smaller 14/16 box (${inset} px)`);
  assert.ok(lock >= 6, `chest icon shows the lock on the front (left) face (${lock} px)`);
  // Hidden blocks: lit furnace -> furnace, chest variants -> chest, crops -> seeds, farmland -> dirt.
  assert.deepEqual(renderIconPixels(tex, BLOCK.LIT_FURNACE_EAST, size), renderIconPixels(tex, BLOCK.FURNACE, size));
  assert.deepEqual(renderIconPixels(tex, BLOCK.CHEST_WEST, size), chest);
  assert.deepEqual(renderIconPixels(tex, BLOCK.WHEAT_3, size), renderIconPixels(tex, ITEM.WHEAT_SEEDS, size));
  assert.deepEqual(renderIconPixels(tex, BLOCK.FARMLAND_MOIST, size), renderIconPixels(tex, BLOCK.DIRT, size));
  // Every wave-2 item has a crisp sprite icon (binary alpha, a solid body).
  for (const name of ['mutton', 'cooked_mutton', 'chicken', 'cooked_chicken', 'spider_eye', 'arrow', 'bow', 'wheat_seeds',
    'wheat', 'wooden_hoe', 'stone_hoe', 'iron_hoe', 'golden_hoe', 'diamond_hoe', ...SPAWN_EGG_MOBS.map(([m]) => `${m}_spawn_egg`)]) {
    const p = renderIconPixels(tex, ITEM[name.toUpperCase()], size);
    let solid = 0;
    for (let i = 3; i < p.length; i += 4) {
      assert.ok(p[i] === 0 || p[i] === 255, `${name} icon alpha`);
      if (p[i]) solid++;
    }
    assert.ok(solid > 200, `${name} icon body ${solid}`);
  }
});
