// Unit tests for src/render/shaders.js and src/render/renderer.js (pure helpers + Renderer against a mock
// WebGL2 context). Visual verification lives in tools/render-test.html (see docs/notes/renderer.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROGRAMS, AO_CURVE, GLSL_LIGHT, FRAME_UBO_LAYOUT, FRAME_UBO_FLOATS, createProgram,
} from '../src/render/shaders.js';
import {
  Renderer, sectionKey, accumulateMeshBounds, radixSortHigh16, buildQuadIndices, registryAlphaModes,
  buildMipChainFallback, dilateTransparentTexels, generateStars, computeSkyState, computeSkyTint, buildCloudMesh,
  cloudRange, generateFallbackMisc,
} from '../src/render/renderer.js';
import { FACE_SHADE } from '../src/config.js';
import { TEXTURE_LAYER_COUNT, TEXTURE_INDEX } from '../src/world/registry.js';

const near = (a, b, eps = 1e-3) => Math.abs(a - b) <= eps;

// ---------------------------------------------------------------------------------------------------
// shaders.js
// ---------------------------------------------------------------------------------------------------

test('every program is complete GLSL ES 3.00', () => {
  const names = ['terrainOpaque', 'terrainCutout', 'terrainTranslucent', 'crack', 'sky', 'stars', 'celestial', 'clouds',
    'outline', 'overlay'];
  for (const n of names) {
    assert.ok(PROGRAMS[n], n);
    for (const stage of ['vs', 'fs']) {
      const src = PROGRAMS[n][stage];
      assert.ok(src.startsWith('#version 300 es\n'), `${n}.${stage} header`);
      assert.match(src, /void main\(\)/);
      // balanced braces
      assert.equal((src.match(/{/g) || []).length, (src.match(/}/g) || []).length, `${n}.${stage} braces`);
    }
  }
});

test('terrain shaders embed FACE_SHADE / AO_CURVE and the canonical light model', () => {
  const vs = PROGRAMS.terrainOpaque.vs;
  const list = (a) => a.map((v) => (Number.isInteger(v) ? v.toFixed(1) : String(v))).join(', ');
  assert.ok(vs.includes(`const float FACE_SHADE[7] = float[7](${list([...FACE_SHADE])});`));
  assert.deepEqual([...AO_CURVE], [0.5, 0.7, 0.85, 1.0]);
  assert.ok(vs.includes(`const float AO_CURVE[4] = float[4](${list([...AO_CURVE])});`));
  assert.ok(GLSL_LIGHT.includes('float lightCurve(float l) { return l / (4.0 - 3.0 * l); }'));
  assert.ok(GLSL_LIGHT.includes('vec3 b = vec3(lightCurve(blk)) * vec3(1.0, 0.92, 0.82);'));
  // Minecraft lightmap post-processing at the default brightness (50 %) instead of a 0.035 floor
  assert.ok(GLSL_LIGHT.includes('vec3 c = mix(clamp(max(s, b), 0.0, 1.0), vec3(0.75), 0.04);'));
  assert.ok(GLSL_LIGHT.includes('c = mix(c, 1.0 - g * g, skyTint.a);'));   // brightness option, default 0.5
  assert.ok(GLSL_LIGHT.includes('return mix(c, vec3(0.75), 0.04);'));
  for (const n of ['terrainOpaque', 'terrainCutout', 'terrainTranslucent']) assert.ok(PROGRAMS[n].fs.includes(GLSL_LIGHT));
  // alpha semantics per pass (SPEC §5.3)
  assert.match(PROGRAMS.terrainOpaque.fs, /#define PASS_OPAQUE/);
  assert.ok(PROGRAMS.terrainOpaque.fs.includes('tex.rgb * mix(vTint, vec3(1.0), tex.a)'));
  assert.ok(PROGRAMS.terrainCutout.fs.includes('if (tex.a < 0.5) discard;'));
  assert.match(PROGRAMS.terrainTranslucent.fs, /#define PASS_TRANSLUCENT/);
});

test('FrameUniforms layout matches the GLSL block (std140, vec4-aligned members)', () => {
  const src = PROGRAMS.sky.fs;
  const block = src.slice(src.indexOf('uniform FrameUniforms {'), src.indexOf('};', src.indexOf('uniform FrameUniforms {')));
  const members = [...block.matchAll(/^\s*(mat4|vec4)\s+u(\w+);/gm)].map((m) => [m[1], m[2]]);
  let offset = 0;
  for (const [type, name] of members) {
    const key = name[0].toLowerCase() + name.slice(1);
    assert.equal(FRAME_UBO_LAYOUT[key], offset, `offset of ${key}`);
    offset += type === 'mat4' ? 16 : 4;
  }
  assert.equal(offset, FRAME_UBO_FLOATS);
  assert.equal(Object.keys(FRAME_UBO_LAYOUT).length, members.length);
});

// ---------------------------------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------------------------------

test('sectionKey is unique around the origin and for large coordinates', () => {
  const seen = new Set();
  for (let cx = -3; cx <= 3; cx++) for (let cz = -3; cz <= 3; cz++) for (let sy = 0; sy < 16; sy++) seen.add(sectionKey(cx, sy, cz));
  assert.equal(seen.size, 7 * 7 * 16);
  assert.notEqual(sectionKey(100000, 3, -100000), sectionKey(-100000, 3, 100000));
  assert.ok(Number.isSafeInteger(sectionKey(-524287, 15, 524287)));
});

function packVertex(px, py, pz) {
  return [((px + 16) | ((py + 16) << 9) | ((pz + 16) << 18)) >>> 0, 0, 0];
}

test('accumulateMeshBounds finds the vertex extent (1/16 units + 16)', () => {
  const v = Uint32Array.from([...packVertex(0, 0, 0), ...packVertex(16, 8, 4), ...packVertex(-16, 30 * 16, 3)]);
  const b = accumulateMeshBounds(v, [511, 511, 511, 0, 0, 0]);
  assert.deepEqual(b, [0, 16, 16, 32, 30 * 16 + 16, 20]);
});

test('radixSortHigh16 sorts by the high 16 bits and is stable', () => {
  const n = 500;
  const keys = new Uint32Array(n);
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed; };
  for (let i = 0; i < n; i++) keys[i] = (((rnd() >>> 20) << 16) | i) >>> 0;
  const ref = [...keys].sort((a, b) => (a >>> 16) - (b >>> 16) || (a & 0xffff) - (b & 0xffff));
  radixSortHigh16(keys, n, new Uint32Array(n), new Uint32Array(256));
  assert.deepEqual([...keys], ref);
});

test('buildQuadIndices emits (0,1,2)(0,2,3) per quad', () => {
  assert.deepEqual([...buildQuadIndices(2)], [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
});

test('registryAlphaModes expands animated frames', () => {
  const modes = registryAlphaModes(TEXTURE_LAYER_COUNT);
  assert.equal(modes.length, TEXTURE_LAYER_COUNT);
  const water = TEXTURE_INDEX.get('water_still');
  const lava = TEXTURE_INDEX.get('lava_still');
  for (let f = 0; f < 16; f++) {
    assert.equal(modes[water + f], 'translucent');
    assert.equal(modes[lava + f], 'opaque');
  }
  assert.equal(modes[TEXTURE_INDEX.get('grass_block_top')], 'tintmask');
  assert.equal(modes[TEXTURE_INDEX.get('oak_leaves')], 'cutout');
  assert.equal(modes[TEXTURE_INDEX.get('destroy_stage_3')], 'translucent');
});

function solidLayer(data, layer, rgba) {
  for (let i = 0; i < 256; i++) data.set(rgba, layer * 1024 + i * 4);
}

test('fallback mip chain: sizes, alpha-weighted colour, coverage-preserving cutout', () => {
  const layers = 3;
  const data = new Uint8Array(16 * 16 * 4 * layers);
  solidLayer(data, 0, [200, 100, 50, 255]);
  // layer 1: cutout, every 4th texel opaque red, the rest transparent black (25 % coverage)
  for (let i = 0; i < 256; i++) data.set(i % 4 === 0 ? [255, 0, 0, 255] : [0, 0, 0, 0], 1024 + i * 4);
  // layer 2: tint mask (alpha = mask)
  for (let i = 0; i < 256; i++) data.set([128, 128, 128, i < 128 ? 0 : 255], 2048 + i * 4);
  const levels = buildMipChainFallback(data, 16, layers, ['opaque', 'cutout', 'tintmask']);
  assert.equal(levels.length, 5);
  assert.deepEqual(levels.map((l) => l.length), [16, 8, 4, 2, 1].map((s) => s * s * 4 * layers));
  const l1 = levels[1];
  assert.deepEqual([...l1.subarray(0, 4)], [200, 100, 50, 255]);
  let covered = 0;
  for (let i = 0; i < 64; i++) {
    const o = 64 * 4 + i * 4;
    if (l1[o + 3]) {
      covered++;
      assert.deepEqual([...l1.subarray(o, o + 3)], [255, 0, 0], 'no dark fringe from transparent texels');
    }
    assert.ok(l1[o + 3] === 0 || l1[o + 3] === 255, 'cutout alpha stays binary');
  }
  assert.ok(Math.abs(covered / 64 - 0.25) <= 0.26, `coverage ${covered / 64}`);
  assert.ok(covered > 0, 'thin features do not vanish');
  // tint mask alpha is averaged, not thresholded
  const last = levels[4];
  assert.ok(near(last[2 * 4 + 3], 128, 1));
});

test('dilateTransparentTexels fills invisible texels from neighbours only', () => {
  const data = new Uint8Array(16 * 16 * 4 * 2);
  solidLayer(data, 0, [0, 0, 0, 0]);
  data.set([10, 200, 30, 255], (5 * 16 + 5) * 4);
  solidLayer(data, 1, [1, 2, 3, 255]);
  dilateTransparentTexels(data, 16, 2, ['cutout', 'opaque']);
  for (let i = 0; i < 256; i++) {
    assert.deepEqual([...data.subarray(i * 4, i * 4 + 3)], [10, 200, 30]);
    assert.equal(data[i * 4 + 3], i === 85 ? 255 : 0, 'alpha untouched');
    assert.deepEqual([...data.subarray(1024 + i * 4, 1024 + i * 4 + 4)], [1, 2, 3, 255]);
  }
});

test('generateStars: unit directions, deterministic', () => {
  const a = generateStars(200, 5), b = generateStars(200, 5);
  assert.deepEqual(a, b);
  for (let i = 0; i < 200; i++) {
    const o = i * 6;
    assert.ok(near(Math.hypot(a[o], a[o + 1], a[o + 2]), 1, 1e-5));
    assert.ok(a[o + 3] >= 1.5 && a[o + 3] <= 4);
  }
});

test('computeSkyState follows the Minecraft day cycle', () => {
  const noon = computeSkyState(0.25, 8, 70);
  assert.ok(near(noon.zenith[0], 0.4733) && near(noon.zenith[1], 0.656) && near(noon.zenith[2], 1));
  assert.equal(noon.sunrise[3], 0);
  assert.equal(noon.starBrightness, 0);
  assert.ok(near(noon.cloudBrightness, 1));
  assert.ok(noon.horizon[0] > noon.zenith[0] && noon.horizon[2] <= 1.0001, 'horizon is lighter than the zenith');
  const sunset = computeSkyState(0.5, 8, 70);
  assert.equal(sunset.sunSide, -1, 'sun sets in the west (-X)');
  assert.ok(sunset.sunrise[3] > 0.9 && sunset.sunrise[0] > sunset.sunrise[1] && sunset.sunrise[1] > sunset.sunrise[2]);
  const sunrise = computeSkyState(0.0, 8, 70);
  assert.equal(sunrise.sunSide, 1, 'sun rises in the east (+X)');
  const night = computeSkyState(0.75, 8, 70);
  assert.ok(night.zenith.every((v) => v === 0));
  assert.ok(near(night.starBrightness, 0.5) && near(night.cloudBrightness, 0.1));
  assert.ok(night.horizon[2] > night.horizon[0], 'night horizon is dark blue');
  const deep = computeSkyState(0.25, 8, 8);
  assert.ok(deep.horizon[0] < noon.horizon[0] * 0.1, 'void fog darkening deep underground');
  const flatWorld = computeSkyState(0.25, 8, 5.6, {}, 1);
  assert.ok(near(flatWorld.horizon[0], noon.horizon[0]), 'flat worlds (clear-colour scale 1) only darken below y = 1');
  assert.ok(near(Math.hypot(...noon.sunDir), 1) && near(noon.sunDir[1], 1));
});

test('computeSkyTint is white by day and bluish at night', () => {
  assert.deepEqual(computeSkyTint(1).map((v) => +v.toFixed(6)), [1, 1, 1]);
  const n = computeSkyTint(0.2);
  assert.ok(n[2] > n[1] && n[1] === n[0]);
  // daylight * tint = Minecraft's lightmap sky colour (0.95 d + 0.05) * lerp((d, d, 1), 1, 0.35)
  assert.deepEqual(n.map((v) => +(v * 0.2).toFixed(4)), [0.1152, 0.1152, 0.24]);
});

test('the light model keeps unlit places faintly visible (Minecraft lightmap, default brightness)', () => {
  // JS mirror of GLSL_LIGHT (checked against the shader source in the test above)
  const curve = (l) => l / (4 - 3 * l);
  const mix = (a, b, t) => a + (b - a) * t;
  const light = (sky, blk, daylight, tint, gamma = 0.5) => [0, 1, 2].map((i) => {
    const s = curve(sky) * daylight * tint[i];
    const b = curve(blk) * [1, 0.92, 0.82][i];
    let c = mix(Math.min(1, Math.max(0, Math.max(s, b))), 0.75, 0.04);
    c = mix(c, 1 - (1 - c) ** 4, gamma);
    return mix(c, 0.75, 0.04);
  });
  const dark = light(0, 0, 1, [1, 1, 1]);
  assert.ok(Math.abs(dark[0] - 0.0995) < 0.002, `unlit cell ${dark[0]} (Minecraft 0.0995)`);
  const full = light(1, 0, 1, [1, 1, 1]);
  assert.ok(full[0] > 0.97 && full[0] <= 1);
  // every light level stays distinguishable (monotone, no flattening near black)
  let prev = -1;
  for (let l = 0; l <= 15; l++) {
    const v = light(0, l / 15, 1, [1, 1, 1])[0];
    assert.ok(v > prev + 0.005, `block light ${l}`);
    prev = v;
  }
  const night = light(1, 0, 0.2, computeSkyTint(0.2));
  assert.ok(night[2] > night[0] && night[0] > dark[0], 'moonlit surface: bluish, brighter than a cave');
  // the 亮度 option (review RENDER-5): Minecraft's Moody / Bright ends at light 0
  assert.ok(Math.abs(light(0, 0, 1, [1, 1, 1], 0)[0] - 0.0588) < 0.002, 'moody');
  assert.ok(Math.abs(light(0, 0, 1, [1, 1, 1], 1)[0] - 0.1402) < 0.003, 'bright');
});

test('buildCloudMesh: faces between cells are removed and runs merged', () => {
  const W = 8, H = 8;
  const bmp = new Uint8Array(W * H);
  const out = new Float32Array(16 * 256);
  assert.equal(buildCloudMesh(bmp, W, H, 0, 0, 3, out), 0);
  bmp[0] = 255;   // one cell at (0, 0)
  assert.equal(buildCloudMesh(bmp, W, H, 0, 0, 3, out), 6);
  bmp[1] = 255;   // and its east neighbour: merged top/bottom/north/south + two end caps
  assert.equal(buildCloudMesh(bmp, W, H, 0, 0, 3, out), 6);
  // top face of the merged run spans x 0..24 at y = 4 (thickness)
  let maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < 6 * 4; i++) { maxX = Math.max(maxX, out[i * 4]); maxY = Math.max(maxY, out[i * 4 + 1]); }
  assert.equal(maxX, 24);
  assert.equal(maxY, 4);
  // wrapping: the bitmap repeats
  assert.equal(buildCloudMesh(bmp, W, H, 8, 8, 0, out), 6);
  // too small output buffer
  assert.equal(buildCloudMesh(bmp, W, H, 0, 0, 3, new Float32Array(16 * 2)), -1);
});

test('cloudRange grows with render distance within limits', () => {
  assert.equal(cloudRange(2), 256);
  assert.ok(cloudRange(12) > cloudRange(8));
  assert.equal(cloudRange(32), 640);
});

test('generateFallbackMisc returns complete images', () => {
  const m = generateFallbackMisc();
  for (const k of ['sun', 'moon']) assert.equal(m[k].data.length, m[k].width * m[k].height * 4);
  assert.equal(m.clouds.data.length, 256 * 256);
  const filled = m.clouds.data.reduce((a, v) => a + (v ? 1 : 0), 0) / m.clouds.data.length;
  assert.ok(filled > 0.1 && filled < 0.7, `cloud coverage ${filled}`);
});

// ---------------------------------------------------------------------------------------------------
// Renderer against a mock WebGL2 context
// ---------------------------------------------------------------------------------------------------

function makeMockGL(width = 800, height = 600) {
  const calls = [];
  const live = { buffer: 0, vao: 0, texture: 0, sampler: 0, program: 0 };
  const consts = new Map([['INVALID_INDEX', 0xffffffff]]);
  let nextId = 1;
  let currentProgram = null;
  const draws = [];
  const lastUniform = new Map();
  const make = (kind) => { live[kind]++; return { kind, id: nextId++, alive: true }; };
  const kill = (kind) => (o) => { if (o && o.alive) { o.alive = false; live[kind]--; } };
  const target = {
    drawingBufferWidth: width, drawingBufferHeight: height,
    createBuffer: () => make('buffer'), deleteBuffer: kill('buffer'),
    createVertexArray: () => make('vao'), deleteVertexArray: kill('vao'),
    createTexture: () => make('texture'), deleteTexture: kill('texture'),
    createSampler: () => make('sampler'), deleteSampler: kill('sampler'),
    createProgram: () => ({ ...make('program'), shaders: [], uniforms: [] }), deleteProgram: kill('program'),
    createShader: (type) => ({ type, src: '' }),
    shaderSource: (sh, src) => { sh.src = src; },
    attachShader: (p, sh) => { p.shaders.push(sh); },
    linkProgram: (p) => {
      const names = new Set();
      for (const sh of p.shaders) for (const m of sh.src.matchAll(/^\s*uniform\s+\w+\s+(\w+)\s*;/gm)) names.add(m[1]);
      p.uniforms = [...names];
    },
    getShaderParameter: () => true,
    getProgramParameter: (p, pname) => (pname === consts.get('ACTIVE_UNIFORMS') ? p.uniforms.length : true),
    getActiveUniform: (p, i) => ({ name: p.uniforms[i] }),
    getUniformLocation: (p, name) => ({ program: p, name }),
    getUniformBlockIndex: () => 0,
    getExtension: () => null,
    getParameter: (pname) => (pname === consts.get('MAX_VIEWPORT_DIMS') ? Int32Array.of(16384, 16384) : 8),
    isContextLost: () => false,
    useProgram: (p) => { currentProgram = p; },
    uniform3f: (loc, x, y, z) => { if (loc) lastUniform.set(loc.name, [x, y, z]); },
    drawElements: (mode, count) => {
      draws.push({ program: currentProgram, count, offset: lastUniform.get('uSectionOffset'), name: currentProgram?.label });
    },
    drawArrays: (mode, first, count) => { draws.push({ program: currentProgram, count, name: currentProgram?.label }); },
  };
  const gl = new Proxy(target, {
    get(t, prop) {
      if (prop in t) return t[prop];
      if (typeof prop === 'string' && /^[A-Z0-9_]+$/.test(prop)) {
        if (!consts.has(prop)) consts.set(prop, 0x8000 + consts.size);
        return consts.get(prop);
      }
      return (...args) => { calls.push([prop, args]); };
    },
  });
  return { gl, calls, live, draws };
}

function makeCanvas(gl) {
  const listeners = {};
  return {
    width: 800, height: 600,
    getContext: (type) => (type === 'webgl2' ? gl : null),
    addEventListener: (type, fn) => { listeners[type] = fn; },
    removeEventListener: (type) => { delete listeners[type]; },
    listeners,
  };
}

function makeTextures() {
  const layers = TEXTURE_LAYER_COUNT;
  const data = new Uint8Array(16 * 16 * 4 * layers).fill(255);
  return { size: 16, layers, data };
}

/** A section mesh with `quads` quads at local block (bx, by, bz). */
function quadMesh(quads, bx = 8, by = 8, bz = 8) {
  const out = new Uint32Array(quads * 12);
  for (let q = 0; q < quads; q++) {
    for (let v = 0; v < 4; v++) {
      const o = (q * 4 + v) * 3;
      const px = bx * 16 + (v === 1 || v === 2 ? 16 : 0), py = by * 16 + (v >= 2 ? 16 : 0), pz = bz * 16;
      out[o] = ((px + 16) | ((py + 16) << 9) | ((pz + 16) << 18) | (3 << 27) | (4 << 29)) >>> 0;
      out[o + 1] = (1 | (60 << 18)) >>> 0;
      out[o + 2] = 0xffffff;
    }
  }
  return out;
}

class RecordingEntityRenderer {
  static instances = [];
  constructor(gl, texture) {
    this.gl = gl; this.texture = texture; this.log = [];
    RecordingEntityRenderer.instances.push(this);
  }
  renderEntities(ctx, items) { this.log.push(['entities', items.length, ctx.cameraPos.slice(), ctx.fogEnd]); }
  renderParticles(ctx, p) { this.log.push(['particles', p.count]); }
  renderHand(ctx, hand) { this.log.push(['hand', hand.itemId, ctx.aspect]); }
}

function baseFrame(extra = {}) {
  return {
    camera: { x: 8, y: 70, z: 8, yaw: 0, pitch: 0, roll: 0, fov: 70 },
    timeOfDay: 0.25, daylight: 1, time: 12.5, renderDistance: 8, underwater: false, inLava: false, clouds: true,
    selection: null, breaking: null, entities: [], particles: null, hand: null, ...extra,
  };
}

function labelPrograms(r) {
  for (const [name, p] of Object.entries(r.programs)) p.program.label = name;
}

test('Renderer: section upload, replace, delete and stats', () => {
  const { gl, live } = makeMockGL();
  const r = new Renderer(makeCanvas(gl), { textures: makeTextures() });
  const baseBuffers = live.buffer, baseVaos = live.vao;
  r.setSectionMesh(0, 4, 0, quadMesh(10), quadMesh(2), null);
  assert.equal(r.getStats().sections, 1);
  assert.equal(live.buffer, baseBuffers + 2);
  assert.equal(live.vao, baseVaos + 2);
  const mem1 = r.getStats().gpuMemoryBytes;
  // replace: reuse the existing layer objects, add a translucent layer (vertex + own element buffer), drop cutout
  r.setSectionMesh(0, 4, 0, quadMesh(20), null, quadMesh(1));
  assert.equal(live.buffer, baseBuffers + 3);
  assert.equal(r.getStats().gpuMemoryBytes - mem1, (20 - 10 + 1 - 2) * 48 + 1 * 24);
  // empty arrays count as null
  r.setSectionMesh(1, 4, 0, new Uint32Array(0), null, null);
  assert.equal(r.getStats().sections, 1);
  r.setSectionMesh(1, 4, 0, quadMesh(1), null, null);
  r.setSectionMesh(1, 5, 0, quadMesh(1), null, null);
  assert.equal(r.getStats().sections, 3);
  r.removeChunk(1, 0);
  assert.equal(r.getStats().sections, 1);
  r.setSectionMesh(0, 4, 0, null, null, null);
  assert.equal(r.getStats().sections, 0);
  assert.equal(live.buffer, baseBuffers);
  assert.equal(live.vao, baseVaos);
  for (let i = 0; i < 5; i++) r.setSectionMesh(i, 0, i, quadMesh(1), quadMesh(1), quadMesh(1));
  r.clearAll();
  assert.equal(live.buffer, baseBuffers);
  assert.equal(live.vao, baseVaos);
  assert.equal(r.vertexBytes, 0);
});

test('Renderer: index buffer grows for big meshes', () => {
  const { gl } = makeMockGL();
  const r = new Renderer(makeCanvas(gl), { textures: makeTextures() });
  const before = r.indexQuads;
  r.setSectionMesh(0, 0, 0, quadMesh(before + 5), null, null);
  assert.ok(r.indexQuads >= before + 5);
});

test('Renderer: frustum + distance culling and front-to-back / back-to-front ordering', () => {
  const { gl, draws } = makeMockGL();
  const r = new Renderer(makeCanvas(gl), { textures: makeTextures() });
  labelPrograms(r);
  // camera at (8, 70, 8) looking north (-Z): sections at cz = -1, -2, -3 are in front, cz = 2 behind
  for (const cz of [-3, -1, -2, 2]) r.setSectionMesh(0, 4, cz, quadMesh(1), null, quadMesh(1));
  r.setSectionMesh(0, 4, -40, quadMesh(1), null, null);   // far beyond the fog end
  r.render(baseFrame());
  assert.equal(r.getStats().visibleSections, 3);
  const opaque = draws.filter((d) => d.name === 'terrainOpaque').map((d) => d.offset[2]);
  assert.deepEqual(opaque, [-16 - 8, -32 - 8, -48 - 8], 'front to back (offset = section origin - floor(camera))');
  const trans = draws.filter((d) => d.name === 'terrainTranslucent').map((d) => d.offset[2]);
  assert.deepEqual(trans, [-56, -40, -24], 'back to front, one double-sided pass per section');
});

/** A translucent section mesh: one +Y quad per [x, y, z] block (section-local) of `cells`. */
function topQuads(cells) {
  const out = new Uint32Array(cells.length * 12);
  cells.forEach(([bx, by, bz], q) => {
    for (let v = 0; v < 4; v++) {
      const o = (q * 4 + v) * 3;
      const px = bx * 16 + (v === 1 || v === 2 ? 16 : 0), py = by * 16 + 16, pz = bz * 16 + (v >= 2 ? 16 : 0);
      out[o] = ((px + 16) | ((py + 16) << 9) | ((pz + 16) << 18) | (3 << 27) | (2 << 29)) >>> 0;
      out[o + 1] = (1 | (60 << 18)) >>> 0;
      out[o + 2] = 0xffffff;
    }
  });
  return out;
}

test('Renderer: translucent quads are re-sorted back to front inside a section (review RENDER-1)', () => {
  const { gl, calls } = makeMockGL();
  const r = new Renderer(makeCanvas(gl), { textures: makeTextures() });
  // camera at (8, 70, 8) looking north; the section at cz = -1 spans z -16..0; quads at local z 15, 2, 9
  r.setSectionMesh(0, 4, -1, null, null, topQuads([[8, 4, 15], [8, 4, 2], [8, 4, 9]]));
  const ebo = () => calls.filter((c) => c[0] === 'bufferSubData' && c[1][0] === gl.ELEMENT_ARRAY_BUFFER).pop();
  r.render(baseFrame());
  const first = ebo();
  assert.ok(first, 'sorted on the first frame');
  const order = (call) => [...call[1][2]].filter((_, i) => i % 6 === 0).map((v) => v / 4);
  // world z of the quads: -16 + 15.5, -16 + 2.5, -16 + 9.5 -> farthest first: 2, 9, 15 = quads 1, 2, 0
  assert.deepEqual(order(first), [1, 2, 0]);
  // a tiny camera move does not re-sort; crossing to the other side reverses the order
  const n0 = calls.length;
  r.render(baseFrame({ camera: { x: 8, y: 70, z: 8.1, yaw: 0, pitch: 0, roll: 0, fov: 70 } }));
  assert.equal(calls.slice(n0).filter((c) => c[0] === 'bufferSubData' && c[1][0] === gl.ELEMENT_ARRAY_BUFFER).length, 0);
  r.render(baseFrame({ camera: { x: 8, y: 70, z: -30, yaw: Math.PI, pitch: 0, roll: 0, fov: 70 } }));
  assert.deepEqual(order(ebo()), [0, 2, 1]);
  // coplanar opposite faces at the same distance: the back-facing one is drawn first
  const pair = topQuads([[8, 4, 8], [8, 4, 8]]);
  for (let v = 0; v < 4; v++) pair[(4 + v) * 3] = ((pair[(4 + v) * 3] & ~(7 << 29)) | (3 << 29)) >>> 0;   // quad 1 = -Y
  r.setSectionMesh(0, 4, -1, null, null, pair);
  r.render(baseFrame());   // camera above the plane (y 70 vs 69): the -Y face is the back face
  assert.deepEqual(order(ebo()), [1, 0]);
});

test('Renderer: hooks receive the §9.5 ctx and run in order', () => {
  const { gl, draws } = makeMockGL();
  RecordingEntityRenderer.instances.length = 0;
  const r = new Renderer(makeCanvas(gl), { textures: makeTextures(), EntityRendererClass: RecordingEntityRenderer });
  labelPrograms(r);
  assert.ok(r.entityRenderer instanceof RecordingEntityRenderer);
  assert.equal(r.entityRenderer.texture, r.textureArray);
  r.setSectionMesh(0, 4, -1, quadMesh(1), quadMesh(1), quadMesh(1));
  r.setSectionMesh(0, 4, 0, quadMesh(1, 8, 5, 4), null, null);   // contains the breaking block (8, 69, 4)
  const frame = baseFrame({
    entities: [{ kind: 'item', x: 8, y: 70, z: 0, itemId: 1, count: 1, age: 0, seed: 0, light: 0xf0 }],
    particles: { count: 2, data: new Float32Array(24) },
    hand: { itemId: 0, swing: 0, equip: 1, bobX: 0, bobY: 0, light: 0xf0 },
    selection: { x: 8, y: 69, z: 4, box: [0, 0, 0, 1, 1, 1] },
    breaking: { x: 8, y: 69, z: 4, stage: 3 },
  });
  r.render(frame);
  const er = r.entityRenderer;
  assert.deepEqual(er.log.map((e) => e[0]), ['entities', 'particles', 'hand']);
  assert.deepEqual(er.log[0][2], [8, 70, 8]);
  assert.ok(near(er.log[0][3], 0.95 * 8 * 16));
  const ctx = r.ctx;
  for (const k of ['gl', 'proj', 'viewRot', 'viewProj', 'cameraPos', 'camRight', 'camUp', 'fogColor', 'fogStart', 'fogEnd',
    'daylight', 'skyTint', 'time', 'aspect', 'texture']) assert.ok(k in ctx, k);
  assert.ok(near(ctx.camRight[0], 1) && near(ctx.camUp[1], 1), 'yaw 0: right = +X, up = +Y');
  assert.ok(near(ctx.aspect, 800 / 600));
  const names = draws.map((d) => d.name).filter(Boolean);
  const idx = (n) => names.indexOf(n);
  assert.ok(idx('sky') < idx('terrainOpaque') && idx('terrainOpaque') < idx('terrainCutout'));
  assert.ok(idx('terrainCutout') < idx('crack') && idx('crack') < idx('outline'));
  assert.ok(idx('outline') < idx('terrainTranslucent') && idx('terrainTranslucent') < idx('clouds'));
  // stats count draws and triangles
  const st = r.getStats();
  assert.equal(st.drawCalls, draws.length);
  assert.ok(st.triangles > 0);
});

test('Renderer: crack overlay only for a valid stage on an existing section', () => {
  const { gl, draws } = makeMockGL();
  const r = new Renderer(makeCanvas(gl), { textures: makeTextures() });
  labelPrograms(r);
  r.setSectionMesh(0, 4, 0, quadMesh(2, 8, 5, 4), quadMesh(1, 8, 5, 4), null);
  const count = (frame) => {
    draws.length = 0;
    r.render(frame);
    return draws.filter((d) => d.name === 'crack').length;
  };
  assert.equal(count(baseFrame({ breaking: { x: 8, y: 69, z: 4, stage: 4 } })), 2, 'opaque + cutout layers');
  assert.equal(count(baseFrame({ breaking: { x: 8, y: 69, z: 4, stage: -1 } })), 0, 'stage -1 = not breaking');
  assert.equal(count(baseFrame({ breaking: { x: 8, y: 69, z: 4 } })), 0, 'missing stage');
  assert.equal(count(baseFrame({ breaking: { x: 300, y: 69, z: 4, stage: 2 } })), 0, 'no mesh there');
});

test('Renderer: underwater and lava frames use flat fog and skip clouds and celestial bodies', () => {
  for (const medium of ['underwater', 'inLava']) {
    const { gl, draws } = makeMockGL();
    const r = new Renderer(makeCanvas(gl), { textures: makeTextures() });
    labelPrograms(r);
    r.render(baseFrame({ [medium]: true }));
    const names = draws.map((d) => d.name);
    assert.ok(!names.includes('clouds') && !names.includes('celestial') && !names.includes('stars'));
    assert.equal(names[names.length - 1], 'overlay', 'screen tint last');
    assert.ok(r.ctx.fogEnd <= 20);
  }
});

test('Renderer: a throwing hook is reported once and does not break the frame', () => {
  const { gl } = makeMockGL();
  class Bad { constructor() {} renderEntities() { throw new Error('boom'); } }
  const errors = [];
  const orig = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  try {
    const r = new Renderer(makeCanvas(gl), { textures: makeTextures(), EntityRendererClass: Bad });
    const f = baseFrame({ entities: [{ kind: 'block', blockId: 1, x: 0, y: 0, z: 0, scale: 1, light: 0, flash: 0 }] });
    r.render(f);
    r.render(f);
  } finally {
    console.error = orig;
  }
  assert.equal(errors.length, 1);
  assert.match(errors[0], /renderEntities/);
});

test('Renderer: context loss drops GPU state, restoration rebuilds and notifies', () => {
  const { gl } = makeMockGL();
  RecordingEntityRenderer.instances.length = 0;
  const canvas = makeCanvas(gl);
  const r = new Renderer(canvas, { textures: makeTextures(), EntityRendererClass: RecordingEntityRenderer });
  r.setSectionMesh(0, 0, 0, quadMesh(3), null, null);
  let prevented = false;
  canvas.listeners.webglcontextlost({ preventDefault: () => { prevented = true; } });
  assert.ok(prevented && r.contextLost);
  assert.equal(r.getStats().sections, 0);
  r.setSectionMesh(0, 0, 0, quadMesh(3), null, null);   // ignored while lost
  assert.equal(r.getStats().sections, 0);
  r.render(baseFrame());                                // no-op
  let restored = 0;
  r.onContextRestored = () => { restored++; };
  canvas.listeners.webglcontextrestored({});
  assert.equal(restored, 1);
  assert.equal(r.contextLost, false);
  assert.equal(RecordingEntityRenderer.instances.length, 2, 'entity renderer recreated with the new texture');
  r.setSectionMesh(0, 0, 0, quadMesh(3), null, null);
  assert.equal(r.getStats().sections, 1);
});

test('Renderer: resize honours DPR and the pixel budget', () => {
  const { gl } = makeMockGL();
  const canvas = makeCanvas(gl);
  const r = new Renderer(canvas, { textures: makeTextures() });
  r.resize(1000, 500, 2);
  assert.deepEqual([canvas.width, canvas.height], [2000, 1000]);
  assert.equal(r.pixelRatio, 2);
  r.resize(4000, 3000, 3);
  assert.ok(canvas.width * canvas.height <= 3840 * 2160);
  assert.ok(near(canvas.width / canvas.height, 4 / 3, 0.01));
});

test('Renderer: dispose frees every GL object', () => {
  const { gl, live } = makeMockGL();
  const r = new Renderer(makeCanvas(gl), { textures: makeTextures() });
  r.setSectionMesh(0, 0, 0, quadMesh(3), quadMesh(3), quadMesh(3));
  r.dispose();
  assert.deepEqual(live, { buffer: 0, vao: 0, texture: 0, sampler: 0, program: 0 });
});

test('createProgram maps uniforms and binds the frame block', () => {
  const { gl, calls } = makeMockGL();
  const p = createProgram(gl, PROGRAMS.outline.vs, PROGRAMS.outline.fs, 'outline');
  for (const u of ['uBoxMin', 'uBoxMax', 'uLineWidth', 'uColor']) assert.ok(p.uniforms[u], u);
  assert.ok(calls.some(([name]) => name === 'uniformBlockBinding'));
});
