// Mob models (docs/SPEC-wave2.md §3.4): Minecraft ModelPart geometry for every mob (exact boxes, pivots,
// texture offsets, mirroring and CubeDeformation inflation of the Java Edition LayerDefinitions), the
// procedural skins painted at startup (original pixel art in Minecraft's style, classic box-UV layouts),
// the burning-entity fire frames (Minecraft Alpha's procedural flame automaton), the arrow texture, and the
// per-mob setupAnim poses (QuadrupedModel, HumanoidModel + zombie / skeleton arms, CreeperModel,
// SpiderModel, ChickenModel, SheepModel eating) used by the entity renderer.
//
// Pure module (no WebGL): everything here is exported for Node tests.
//
// Conventions:
//  * Model space is Minecraft's: px units, +Y DOWN, the front of a mob faces -Z; a standing model's feet are
//    at y = 24 px. LivingEntityRenderer maps it to the world with Ry(bodyYaw)·Rz(death flip)·S(-1, -1, 1)·
//    T(0, -1.501, 0) (see computeModelPose), so model -X is the mob's right side (world +X when facing north).
//  * Skins are 64x64 RGBA layers of one texture array (SKIN.*). 64x32 Minecraft layouts use the top half.
//  * Vertex format (shared with entityrenderer.js): pos.xyz (px), normal.xyz, u, v (in 1/16 of the 64 px
//    layer, i.e. px / 4), face slot 6 (= instance layer 0).
//  * Skin alpha: 255 opaque, 0 transparent (cutout), 128..254 = opaque AND emissive (drawn full-bright when
//    the instance has the emissive flag: spider eyes, fire).

export const SKIN_SIZE = 64;
const UV = 16 / SKIN_SIZE;            // px -> shader UV units (the mesh shader multiplies by 1/16)
const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

/** Fire animation frames (layers SKIN.FIRE0 .. SKIN.FIRE0 + FIRE_FRAMES - 1). */
export const FIRE_FRAMES = 16;

/** Layers of the entity skin texture array. */
export const SKIN = Object.freeze({
  PLAYER: 0, ZOMBIE: 1, SKELETON: 2, CREEPER: 3, SPIDER: 4, PIG: 5, COW: 6, SHEEP: 7, SHEEP_FUR: 8, CHICKEN: 9,
  ARROW: 10, FIRE0: 11,
});
export const SKIN_LAYERS = SKIN.FIRE0 + FIRE_FRAMES;

/** Skin alpha that marks an opaque, emissive texel (spider eyes, fire). */
export const EMISSIVE_ALPHA = 200;

// ===================================================================================================
// Model definitions (Minecraft LayerDefinitions)
// ===================================================================================================

/**
 * A model part: pivot (px), default rotation (radians, x y z) and its boxes
 * [x, y, z, w, h, d, u, v, mirror, grow].
 */
function part(name, pivot, boxes, rot = [0, 0, 0]) {
  return Object.freeze({ name, pivot: Object.freeze(pivot), rot: Object.freeze(rot), boxes: Object.freeze(boxes) });
}

const HALF_PI = Math.PI / 2;

// QuadrupedModel.createBodyMesh(legHeight) legs: right hind, left hind, right front, left front.
function quadLegs(legHeight, hindZ, frontZ, x, u = 0, v = 16, grow = 0, mirrorLeft = false) {
  const y = 24 - legHeight;
  const box = (m) => [[-2, 0, -2, 4, legHeight, 4, u, v, m, grow]];
  return [
    part('right_hind_leg', [-x, y, hindZ], box(false)),
    part('left_hind_leg', [x, y, hindZ], box(mirrorLeft)),
    part('right_front_leg', [-x, y, frontZ], box(false)),
    part('left_front_leg', [x, y, frontZ], box(mirrorLeft)),
  ];
}

/**
 * Every model the entity renderer draws: parts (geometry + rest pose), skin layer, animation kind, the right
 * arm part for held items, render scale, death flip angle and a bounding sphere for culling.
 */
export const MODEL_DEFS = Object.freeze([
  {
    // Minecraft PlayerModel (wide arms), 64x64 skin; posed by entityrenderer.computePlayerPose
    name: 'player', skin: SKIN.PLAYER, anim: 'player', scale: 0.9375, flip: 90, sphere: [0.9, 1.4], bbox: [0.6, 1.8],
    parts: [
      part('head', [0, 0, 0], [[-4, -8, -4, 8, 8, 8, 0, 0]]),
      part('body', [0, 0, 0], [[-4, 0, -2, 8, 12, 4, 16, 16]]),
      part('right_arm', [-5, 2, 0], [[-3, -2, -2, 4, 12, 4, 40, 16]]),
      part('left_arm', [5, 2, 0], [[-1, -2, -2, 4, 12, 4, 32, 48]]),
      part('right_leg', [-1.9, 12, 0], [[-2, 0, -2, 4, 12, 4, 0, 16]]),
      part('left_leg', [1.9, 12, 0], [[-2, 0, -2, 4, 12, 4, 16, 48]]),
    ],
    hand: 2, handX: 0,
  },
  {
    // ZombieModel: HumanoidModel.createMesh (64x64 texture, mirrored left limbs at the classic offsets)
    name: 'zombie', skin: SKIN.ZOMBIE, anim: 'zombie', scale: 1, flip: 90, sphere: [1.0, 1.4], bbox: [0.6, 1.95],
    parts: [
      part('head', [0, 0, 0], [[-4, -8, -4, 8, 8, 8, 0, 0]]),
      part('body', [0, 0, 0], [[-4, 0, -2, 8, 12, 4, 16, 16]]),
      part('right_arm', [-5, 2, 0], [[-3, -2, -2, 4, 12, 4, 40, 16]]),
      part('left_arm', [5, 2, 0], [[-1, -2, -2, 4, 12, 4, 40, 16, true]]),
      part('right_leg', [-1.9, 12, 0], [[-2, 0, -2, 4, 12, 4, 0, 16]]),
      part('left_leg', [1.9, 12, 0], [[-2, 0, -2, 4, 12, 4, 0, 16, true]]),
    ],
    hand: 2, handX: 0,
  },
  {
    // SkeletonModel: thin 2x12x2 limbs (64x32)
    name: 'skeleton', skin: SKIN.SKELETON, anim: 'skeleton', scale: 1, flip: 90, sphere: [1.0, 1.4], bbox: [0.6, 1.99],
    parts: [
      part('head', [0, 0, 0], [[-4, -8, -4, 8, 8, 8, 0, 0]]),
      part('body', [0, 0, 0], [[-4, 0, -2, 8, 12, 4, 16, 16]]),
      part('right_arm', [-5, 2, 0], [[-1, -2, -1, 2, 12, 2, 40, 16]]),
      part('left_arm', [5, 2, 0], [[-1, -2, -1, 2, 12, 2, 40, 16, true]]),
      part('right_leg', [-2, 12, 0], [[-1, 0, -1, 2, 12, 2, 0, 16]]),
      part('left_leg', [2, 12, 0], [[-1, 0, -1, 2, 12, 2, 0, 16, true]]),
    ],
    hand: 2, handX: 1,      // SkeletonModel.translateToHand: the right arm pivot moves 1 px inward (x += 1)
  },
  {
    // CreeperModel (64x32)
    name: 'creeper', skin: SKIN.CREEPER, anim: 'creeper', scale: 1, flip: 90, sphere: [0.85, 1.2], bbox: [0.6, 1.7],
    parts: [
      part('head', [0, 6, 0], [[-4, -8, -4, 8, 8, 8, 0, 0]]),
      part('body', [0, 6, 0], [[-4, 0, -2, 8, 12, 4, 16, 16]]),
      part('right_hind_leg', [-2, 18, 4], [[-2, 0, -2, 4, 6, 4, 0, 16]]),
      part('left_hind_leg', [2, 18, 4], [[-2, 0, -2, 4, 6, 4, 0, 16]]),
      part('right_front_leg', [-2, 18, -4], [[-2, 0, -2, 4, 6, 4, 0, 16]]),
      part('left_front_leg', [2, 18, -4], [[-2, 0, -2, 4, 6, 4, 0, 16]]),
    ],
  },
  {
    // SpiderModel (64x32): head, neck (body0), abdomen (body1), 8 legs (left legs mirrored)
    name: 'spider', skin: SKIN.SPIDER, anim: 'spider', scale: 1, flip: 180, sphere: [0.5, 1.5], bbox: [1.4, 0.9], emissive: true,
    parts: [
      part('head', [0, 15, -3], [[-4, -4, -8, 8, 8, 8, 32, 4]]),
      part('body0', [0, 15, 0], [[-3, -3, -3, 6, 6, 6, 0, 0]]),
      part('body1', [0, 15, 9], [[-5, -4, -6, 10, 8, 12, 0, 12]]),
      part('right_hind_leg', [-4, 15, 2], [[-15, -1, -1, 16, 2, 2, 18, 0]]),
      part('left_hind_leg', [4, 15, 2], [[-1, -1, -1, 16, 2, 2, 18, 0, true]]),
      part('right_middle_hind_leg', [-4, 15, 1], [[-15, -1, -1, 16, 2, 2, 18, 0]]),
      part('left_middle_hind_leg', [4, 15, 1], [[-1, -1, -1, 16, 2, 2, 18, 0, true]]),
      part('right_middle_front_leg', [-4, 15, 0], [[-15, -1, -1, 16, 2, 2, 18, 0]]),
      part('left_middle_front_leg', [4, 15, 0], [[-1, -1, -1, 16, 2, 2, 18, 0, true]]),
      part('right_front_leg', [-4, 15, -1], [[-15, -1, -1, 16, 2, 2, 18, 0]]),
      part('left_front_leg', [4, 15, -1], [[-1, -1, -1, 16, 2, 2, 18, 0, true]]),
    ],
  },
  {
    // PigModel: QuadrupedModel(6) with the snout box on the head (64x32)
    name: 'pig', skin: SKIN.PIG, anim: 'quadruped', scale: 1, flip: 90, sphere: [0.5, 1.0], bbox: [0.9, 0.9],
    parts: [
      part('head', [0, 12, -6], [[-4, -4, -8, 8, 8, 8, 0, 0], [-2, 0, -9, 4, 3, 1, 16, 16]]),
      part('body', [0, 11, 2], [[-5, -10, -7, 10, 16, 8, 28, 8]], [HALF_PI, 0, 0]),
      ...quadLegs(6, 7, -5, 3),
    ],
  },
  {
    // CowModel (64x32): head with horns, body with udder, 12 px legs (left legs mirrored)
    name: 'cow', skin: SKIN.COW, anim: 'quadruped', scale: 1, flip: 90, sphere: [0.75, 1.3], bbox: [0.9, 1.4],
    parts: [
      part('head', [0, 4, -8], [[-4, -4, -6, 8, 8, 6, 0, 0], [-5, -5, -4, 1, 3, 1, 22, 0], [4, -5, -4, 1, 3, 1, 22, 0]]),
      part('body', [0, 5, 2], [[-6, -10, -7, 12, 18, 10, 18, 4], [-2, 2, -8, 4, 6, 1, 52, 0]], [HALF_PI, 0, 0]),
      ...quadLegs(12, 7, -6, 4, 0, 16, 0, true),
    ],
  },
  {
    // SheepModel (64x32) + SheepFurModel overlay (wool, inflated boxes, tinted by the fleece colour)
    name: 'sheep', skin: SKIN.SHEEP, anim: 'sheep', scale: 1, flip: 90, sphere: [0.7, 1.2], bbox: [0.9, 1.3],
    parts: [
      part('head', [0, 6, -8], [[-3, -4, -6, 6, 6, 8, 0, 0]]),
      part('body', [0, 5, 2], [[-4, -10, -7, 8, 16, 6, 28, 8]], [HALF_PI, 0, 0]),
      ...quadLegs(12, 7, -5, 3),
    ],
    overlay: {
      skin: SKIN.SHEEP_FUR,
      parts: [
        part('head', [0, 6, -8], [[-3, -4, -4, 6, 6, 6, 0, 0, false, 0.6]]),
        part('body', [0, 5, 2], [[-4, -10, -7, 8, 16, 6, 28, 8, false, 1.75]], [HALF_PI, 0, 0]),
        part('right_hind_leg', [-3, 12, 7], [[-2, 0, -2, 4, 6, 4, 0, 16, false, 0.5]]),
        part('left_hind_leg', [3, 12, 7], [[-2, 0, -2, 4, 6, 4, 0, 16, false, 0.5]]),
        part('right_front_leg', [-3, 12, -5], [[-2, 0, -2, 4, 6, 4, 0, 16, false, 0.5]]),
        part('left_front_leg', [3, 12, -5], [[-2, 0, -2, 4, 6, 4, 0, 16, false, 0.5]]),
      ],
    },
  },
  {
    // ChickenModel (64x32): head, beak, wattle ("red_thing"), body, legs, wings
    name: 'chicken', skin: SKIN.CHICKEN, anim: 'chicken', scale: 1, flip: 90, sphere: [0.4, 0.7], bbox: [0.4, 0.7],
    parts: [
      part('head', [0, 15, -4], [[-2, -6, -2, 4, 6, 3, 0, 0]]),
      part('beak', [0, 15, -4], [[-2, -4, -4, 4, 2, 2, 14, 0]]),
      part('red_thing', [0, 15, -4], [[-1, -2, -3, 2, 2, 2, 14, 4]]),
      part('body', [0, 16, 0], [[-3, -4, -3, 6, 8, 6, 0, 9]], [HALF_PI, 0, 0]),
      part('right_leg', [-2, 19, 1], [[-1, 0, -3, 3, 5, 3, 26, 0]]),
      part('left_leg', [1, 19, 1], [[-1, 0, -3, 3, 5, 3, 26, 0]]),
      part('right_wing', [-4, 13, 0], [[0, 0, -3, 1, 4, 6, 24, 13]]),
      part('left_wing', [4, 13, 0], [[-1, 0, -3, 1, 4, 6, 24, 13]]),
    ],
  },
  {
    // Arrow (ArrowRenderer): 2 crossed shaft planes + the nock square, one part posed directly
    name: 'arrow', skin: SKIN.ARROW, anim: 'arrow', scale: 1, flip: 0, sphere: [0, 0.6], bbox: [0.5, 0.5], parts: [],
  },
].map((d, i) => Object.freeze({ ...d, id: i })));

/**
 * Number of flame sheets Minecraft's renderFlame stacks on a burning entity of bounding box (w, h): sheets
 * of height 1.4·w·1.4 every 0.45·w·1.4 until the box height is covered.
 */
export function fireSheetCount(w, h) {
  let f3 = h / (w * 1.4);
  let n = 0;
  while (f3 > 0 && n < 32) { f3 -= 0.45; n++; }
  return n;
}

/** Model id by name ('player', 'zombie', ..., 'arrow'). */
export const MODEL_ID = Object.freeze(Object.fromEntries(MODEL_DEFS.map((d) => [d.name, d.id])));
/** Largest part count of any model (+ overlay). */
export const MAX_MODEL_PARTS = 12;

// ===================================================================================================
// Geometry
// ===================================================================================================

function pushQuad(out, ps, uvs, n) {
  for (const k of [0, 1, 2, 0, 2, 3]) {
    const p = ps[k], t = uvs[k];
    out.push(p[0], p[1], p[2], n[0], n[1], n[2], t[0], t[1], 6);
  }
}

/**
 * Minecraft ModelPart.Cube: box (x, y, z) size (w, h, d) px, texture offset (u, v), optional mirror (UVs
 * flipped horizontally, east/west faces swapped) and CubeDeformation `grow` (inflates the box, not the UVs).
 * Appends 36 vertices (6 faces, counter-clockwise from outside) to `out`.
 */
export function buildModelBox(x, y, z, w, h, d, u, v, mirror = false, grow = 0, out = []) {
  let x0 = x - grow, x1 = x + w + grow;
  const y0 = y - grow, y1 = y + h + grow, z0 = z - grow, z1 = z + d + grow;
  if (mirror) { const t = x0; x0 = x1; x1 = t; }
  const V = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  const f4 = u, f5 = u + d, f6 = u + d + w, f7 = u + d + w + w, f8 = u + d + w + d, f9 = u + d + w + d + w;
  const f10 = v, f11 = v + d, f12 = v + d + h;
  const polys = [
    [[5, 4, 0, 1], f5, f10, f6, f11, [0, -1, 0]],   // DOWN (model -Y: the top of a standing part)
    [[2, 3, 7, 6], f6, f11, f7, f10, [0, 1, 0]],    // UP
    [[0, 4, 7, 3], f4, f11, f5, f12, [-1, 0, 0]],   // WEST (the mob's right side)
    [[1, 0, 3, 2], f5, f11, f6, f12, [0, 0, -1]],   // NORTH (front)
    [[5, 1, 2, 6], f6, f11, f8, f12, [1, 0, 0]],    // EAST (left side)
    [[4, 5, 6, 7], f8, f11, f9, f12, [0, 0, 1]],    // SOUTH (back)
  ];
  for (const [idx, u1, v1, u2, v2, n0] of polys) {
    const n = mirror ? [-n0[0], n0[1], n0[2]] : n0;
    let ps = idx.map((i) => V[i]);
    let uvs = [[u2 * UV, v1 * UV], [u1 * UV, v1 * UV], [u1 * UV, v2 * UV], [u2 * UV, v2 * UV]];
    const e1 = [ps[1][0] - ps[0][0], ps[1][1] - ps[0][1], ps[1][2] - ps[0][2]];
    const e2 = [ps[2][0] - ps[0][0], ps[2][1] - ps[0][1], ps[2][2] - ps[0][2]];
    const c = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    if (c[0] * n[0] + c[1] * n[1] + c[2] * n[2] < 0) { ps = ps.slice().reverse(); uvs = uvs.slice().reverse(); }
    pushQuad(out, ps, uvs, n);
  }
  return out;
}

/** Vertices of one model part (all its boxes). */
export function buildPartGeometry(p) {
  const out = [];
  for (const b of p.boxes) buildModelBox(b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7], !!b[8], b[9] ?? 0, out);
  return out;
}

/**
 * Minecraft ArrowRenderer geometry in arrow model space (x = flight direction, units of 1/16 px · 0.05625 are
 * applied by the pose): the nock square at x = -7 (both sides) and four 16x4 shaft quads at 90° steps about X
 * (two crossed double-sided planes). UVs: Minecraft's 32x32 arrow.png stored at 2x in a 64 px layer.
 */
export function buildArrowGeometry() {
  const out = [];
  const t = (u, v) => [u * 64 * UV, v * 64 * UV];   // Minecraft UV (0..1 of the 32 px texture) -> shader units
  const n0 = [0, 0, 0];
  pushQuad(out, [[-7, -2, -2], [-7, -2, 2], [-7, 2, 2], [-7, 2, -2]],
    [t(0, 0.15625), t(0.15625, 0.15625), t(0.15625, 0.3125), t(0, 0.3125)], n0);
  pushQuad(out, [[-7, 2, -2], [-7, 2, 2], [-7, -2, 2], [-7, -2, -2]],
    [t(0, 0.15625), t(0.15625, 0.15625), t(0.15625, 0.3125), t(0, 0.3125)], n0);
  for (let j = 0; j < 4; j++) {
    const a = (j + 1) * HALF_PI;
    const c = Math.cos(a), s = Math.sin(a);
    const rot = (x, y, z) => [x, y * c - z * s, y * s + z * c];   // rotate about X
    pushQuad(out, [rot(-8, -2, 0), rot(8, -2, 0), rot(8, 2, 0), rot(-8, 2, 0)],
      [t(0, 0), t(0.5, 0), t(0.5, 0.15625), t(0, 0.15625)], n0);
  }
  return out;
}

/**
 * Burning-entity flame sheet (EntityRenderDispatcher.renderFlame): a unit quad x ∈ [-0.5, 0.5], y ∈ [0, 1]
 * facing -Z (toward the camera once posed), the whole 16 px fire frame. `flipU` mirrors the texture.
 */
export function buildFireQuad(flipU = false) {
  const out = [];
  const u0 = flipU ? 16 : 0, u1 = flipU ? 0 : 16;
  // vertices TL, BL, BR, TR as seen from -Z (x grows to the viewer's left when looking along +Z)
  pushQuad(out, [[0.5, 1, 0], [0.5, 0, 0], [-0.5, 0, 0], [-0.5, 1, 0]], [[u0, 0], [u0, 16], [u1, 16], [u1, 0]], [0, 0, 0]);
  return out;
}

// ===================================================================================================
// Skins
// ===================================================================================================

function makeRng(seed) {
  let s = (seed >>> 0) || 0x9e3779b9;
  return () => {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

function hex(h) {
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}

/** Small pixel-art painter on a 64x64 RGBA skin with box-UV face helpers. */
class SkinPainter {
  constructor(seed) {
    this.data = new Uint8Array(SKIN_SIZE * SKIN_SIZE * 4);
    this.rnd = makeRng(seed);
  }

  set(x, y, c, a = 255) {
    if (x < 0 || y < 0 || x >= SKIN_SIZE || y >= SKIN_SIZE) return;
    const o = (y * SKIN_SIZE + x) * 4;
    const col = typeof c === 'string' ? hex(c) : c;
    this.data[o] = col[0]; this.data[o + 1] = col[1]; this.data[o + 2] = col[2]; this.data[o + 3] = a;
  }

  get(x, y) {
    const o = (y * SKIN_SIZE + x) * 4;
    return [this.data[o], this.data[o + 1], this.data[o + 2], this.data[o + 3]];
  }

  /** Multiply the colour of a texel (keeps alpha). */
  tone(x, y, k) {
    const o = (y * SKIN_SIZE + x) * 4;
    for (let i = 0; i < 3; i++) this.data[o + i] = Math.max(0, Math.min(255, Math.round(this.data[o + i] * k)));
  }

  /** Fill a rect: each texel picks a palette colour by weight ([[hex, weight], ...]) or one colour. */
  fill(x, y, w, h, pal, a = 255) {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, this.pick(pal), a);
  }

  pick(pal) {
    if (typeof pal === 'string' || !Array.isArray(pal[0])) return pal;
    let total = 0;
    for (const e of pal) total += e[1];
    let r = this.rnd() * total;
    for (const e of pal) {
      r -= e[1];
      if (r <= 0) return e[0];
    }
    return pal[pal.length - 1][0];
  }

  /** Box-UV face rects of a box (u, v, w, h, d): [x, y, width, height] per face name. */
  static faces(u, v, w, h, d) {
    return {
      top: [u + d, v, w, d], bottom: [u + d + w, v, w, d],
      right: [u, v + d, d, h], front: [u + d, v + d, w, h], left: [u + d + w, v + d, d, h], back: [u + d + w + d, v + d, w, h],
    };
  }

  /** Fill all six faces of a box with a palette. */
  box(u, v, w, h, d, pal, a = 255) {
    const f = SkinPainter.faces(u, v, w, h, d);
    for (const k in f) this.fill(...f[k], pal, a);
    return f;
  }

  /** Darken (k < 1) or lighten a rect. */
  shade(x, y, w, h, k) {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.tone(x + i, y + j, k);
  }

  /** Paint a small "pixel map" (rows of characters) at (x, y): chars map to colours in `key` ('.' = skip). */
  map(x, y, rows, key, a = 255) {
    rows.forEach((row, j) => {
      for (let i = 0; i < row.length; i++) {
        const ch = row[i];
        if (ch === '.' || ch === ' ') continue;
        const c = key[ch];
        if (c === undefined) continue;
        if (Array.isArray(c) && Array.isArray(c[0])) this.set(x + i, y + j, this.pick(c), a);
        else if (typeof c === 'object' && !Array.isArray(c)) this.set(x + i, y + j, c.c, c.a ?? a);
        else this.set(x + i, y + j, c, a);
      }
    });
  }
}

// ---- pig ---------------------------------------------------------------------------------------
function paintPig() {
  const p = new SkinPainter(0x51a1);
  const PINK = [['#F0A5A2', 6], ['#EC9B98', 4], ['#F4B0AC', 3], ['#E8928F', 1]];
  const PINK_D = [['#E3908D', 3], ['#DB8481', 2]];
  // head 8x8x8 at (0, 0)
  const head = p.box(0, 0, 8, 8, 8, PINK);
  p.shade(...head.bottom, 0.9);
  // face: eyes (white outside, black pupil inside) + brows
  const [fx, fy] = head.front;
  p.map(fx, fy + 2, [
    '........',
    'wb....bw',
  ], { w: '#F2F2F2', b: '#141414' });
  p.set(fx, fy + 2, '#E6918E'); p.set(fx + 7, fy + 2, '#E6918E');
  // snout 4x3x1 at (16, 16)
  const sn = p.box(16, 16, 4, 3, 1, [['#E8908E', 3], ['#EC9997', 2]]);
  const [sx, sy] = sn.front;
  p.fill(sx, sy, 4, 3, [['#F2A8A6', 3], ['#EFA2A0', 2]]);
  p.set(sx, sy + 1, '#A0515A'); p.set(sx + 3, sy + 1, '#A0515A');
  p.set(sx, sy, '#E9999A'); p.set(sx + 3, sy, '#E9999A');
  p.fill(sx, sy + 2, 4, 1, '#E4908F');
  // body 10x16x8 at (28, 8): belly (front) lighter, back (top) slightly darker
  const body = p.box(28, 8, 10, 16, 8, PINK);
  p.fill(...body.front, [['#F4B2AE', 4], ['#F0A7A4', 3]]);
  p.fill(...body.back, [['#EC9C98', 4], ['#F0A5A2', 3], ['#E59490', 2]]);
  for (const k of ['right', 'left']) {
    const [x, y, w, h] = body[k];
    // the belly side of each flank is a little lighter
    for (let j = 0; j < h; j++) p.tone(k === 'right' ? x + w - 1 : x, y + j, 1.04);
  }
  // rear end: tail curl
  const [rx, ry] = body.bottom;
  p.set(rx + 5, ry + 1, '#E08A88'); p.set(rx + 4, ry + 2, '#D88380'); p.set(rx + 5, ry + 2, '#E08A88');
  // legs 4x6x4 at (0, 16), hooves at the bottom
  const leg = p.box(0, 16, 4, 6, 4, PINK);
  for (const k of ['right', 'front', 'left', 'back']) {
    const [x, y, w, h] = leg[k];
    p.fill(x, y + h - 1, w, 1, [['#B4706E', 3], ['#A86866', 2]]);
    p.fill(x, y + h - 2, w, 1, PINK_D);
  }
  p.fill(...leg.bottom, [['#A86866', 3], ['#9C605E', 2]]);
  return p.data;
}

// ---- cow ---------------------------------------------------------------------------------------
function paintCow() {
  const p = new SkinPainter(0xc0c0);
  const BROWN = [['#433024', 5], ['#3B2A1F', 4], ['#4E3929', 3], ['#352519', 2]];
  const WHITE = [['#E9E9E9', 5], ['#DEDEDE', 3], ['#F5F5F5', 2], ['#CFCFCF', 1]];
  const rnd = p.rnd;
  /** Brown base with seeded white blotches (cow pattern) over a rect. */
  const patches = (x, y, w, h, blobs, minR, maxR) => {
    p.fill(x, y, w, h, BROWN);
    for (let b = 0; b < blobs; b++) {
      const cx = x + rnd() * w, cy = y + rnd() * h;
      const rx = minR + rnd() * (maxR - minR), ry = minR + rnd() * (maxR - minR);
      for (let j = 0; j < h; j++) {
        for (let i = 0; i < w; i++) {
          const dx = (x + i + 0.5 - cx) / rx, dy = (y + j + 0.5 - cy) / ry;
          if (dx * dx + dy * dy < 1 - rnd() * 0.25) p.set(x + i, y + j, p.pick(WHITE));
        }
      }
    }
  };
  // head 8x8x6 at (0, 0)
  const head = p.box(0, 0, 8, 8, 6, BROWN);
  const [fx, fy] = head.front;
  // white blaze, eyes, pink-grey muzzle with nostrils
  p.map(fx, fy, [
    '...ww...',
    '..wwww..',
    '...ww...',
    'kwb..bwk',
    '...ww...',
    '.mmmmmm.',
    '.mnmmnm.',
    '.mmmmmm.',
  ], {
    w: WHITE, k: '#2E2018', b: '#0F0F0F', m: [['#A99189', 3], ['#B39C93', 2], ['#9E877F', 1]], n: '#4A3830',
  });
  p.set(fx + 1, fy + 3, '#F0F0F0'); p.set(fx + 6, fy + 3, '#F0F0F0');
  p.set(fx + 2, fy + 3, '#101010'); p.set(fx + 5, fy + 3, '#101010');
  // the muzzle wraps onto the sides and the bottom of the head
  for (const k of ['right', 'left']) {
    const [x, y, w] = head[k];
    const front = k === 'right' ? x + w - 1 : x;
    for (let j = 5; j < 8; j++) p.set(front, y + j, p.pick([['#A99189', 3], ['#9E877F', 1]]));
  }
  p.fill(head.bottom[0], head.bottom[1] + head.bottom[3] - 2, head.bottom[2], 2, [['#A99189', 3], ['#9E877F', 1]]);
  // white patch on one side of the head
  p.fill(head.left[0] + 1, head.left[1] + 1, 3, 3, WHITE);
  p.set(head.left[0] + 1, head.left[1] + 3, p.pick(BROWN));
  // horns 1x3x1 at (22, 0)
  p.box(22, 0, 1, 3, 1, [['#D9D3C4', 3], ['#C7C0AE', 2]]);
  p.fill(23, 0, 1, 1, '#E8E4D8');
  // body 12x18x10 at (18, 4) with white blotches
  const body = SkinPainter.faces(18, 4, 12, 18, 10);
  patches(...body.top, 2, 2, 3.2);
  patches(...body.bottom, 2, 2, 3);
  patches(...body.right, 4, 2.2, 4.2);
  patches(...body.left, 4, 2.2, 4.2);
  patches(...body.front, 3, 2.5, 4.5);
  patches(...body.back, 4, 2.2, 4);
  // udder 4x6x1 at (52, 0)
  const ud = p.box(52, 0, 4, 6, 1, [['#E9A9A6', 3], ['#E09C99', 2]]);
  const [ux, uy] = ud.front;
  p.set(ux, uy + 5, '#D98C8A'); p.set(ux + 3, uy + 5, '#D98C8A');
  p.set(ux + 1, uy + 4, '#F2B9B6'); p.set(ux + 2, uy + 4, '#F2B9B6');
  // legs 4x12x4 at (0, 16): brown with white socks, grey hooves
  const leg = SkinPainter.faces(0, 16, 4, 12, 4);
  for (const k of ['right', 'front', 'left', 'back']) {
    const [x, y, w, h] = leg[k];
    p.fill(x, y, w, h, BROWN);
    for (let j = 6; j < h - 2; j++) for (let i = 0; i < w; i++) if (j > 7 || rnd() < 0.5) p.set(x + i, y + j, p.pick(WHITE));
    p.fill(x, y + h - 2, w, 2, [['#5A5651', 3], ['#4A4743', 2]]);
  }
  p.fill(...leg.top, BROWN);
  p.fill(...leg.bottom, [['#4A4743', 3], ['#3E3B38', 2]]);
  return p.data;
}

// ---- sheep (sheared body) + fur ----------------------------------------------------------------------
const SHEEP_SKIN = [['#D8BEA9', 4], ['#D2B6A0', 3], ['#DEC6B3', 2], ['#C9AC95', 1]];
const WOOL = [['#F2F2F2', 6], ['#FBFBFB', 3], ['#E4E4E4', 3], ['#D8D8D8', 1]];

function paintSheep() {
  const p = new SkinPainter(0x5eef);
  // head 6x6x8 at (0, 0): the face sticks out of the fleece; the rest (seen only when sheared) is skin
  const head = p.box(0, 0, 6, 6, 8, SHEEP_SKIN);
  const FACE = [['#E3CCBA', 4], ['#DCC3AF', 3], ['#E9D6C7', 2]];
  const [fx, fy] = head.front;
  p.fill(fx, fy, 6, 6, FACE);
  p.map(fx, fy, [
    '......',
    'bw..wb',
    '......',
    '..nn..',
    '..mm..',
    '......',
  ], { b: '#191919', w: '#EDEDED', n: '#C79E8C', m: '#B58576' });
  // the two face columns of each side and the chin are skin too
  for (const k of ['right', 'left']) {
    const [x, y, w, h] = head[k];
    for (let j = 0; j < h; j++) {
      for (let c = 0; c < 2; c++) p.set(k === 'right' ? x + w - 1 - c : x + c, y + j, p.pick(FACE));
    }
  }
  p.fill(head.bottom[0], head.bottom[1] + head.bottom[3] - 2, head.bottom[2], 2, FACE);
  p.fill(head.top[0], head.top[1] + head.top[3] - 2, head.top[2], 2, FACE);
  // body 8x16x6 at (28, 8): pinkish skin (visible only when sheared)
  const body = p.box(28, 8, 8, 16, 6, SHEEP_SKIN);
  for (let n = 0; n < 40; n++) {
    const k = ['right', 'front', 'left', 'back'][n & 3];
    const [x, y, w, h] = body[k];
    p.tone(x + Math.floor(p.rnd() * w), y + Math.floor(p.rnd() * h), 0.93);
  }
  // legs 4x12x4 at (0, 16): skin (the top half is hidden under the fleece unless sheared), dark hooves
  const leg = SkinPainter.faces(0, 16, 4, 12, 4);
  for (const k of ['right', 'front', 'left', 'back']) {
    const [x, y, w, h] = leg[k];
    p.fill(x, y, w, 6, SHEEP_SKIN);
    p.fill(x, y + 6, w, h - 6, [['#D7C3B2', 4], ['#CDB8A6', 3], ['#E0CEBF', 1]]);
    p.fill(x, y + h - 1, w, 1, [['#8E7B6E', 3], ['#7F6D61', 2]]);
  }
  p.fill(...leg.top, SHEEP_SKIN);
  p.fill(...leg.bottom, [['#8E7B6E', 3], ['#7F6D61', 2]]);
  return p.data;
}

/** Curly wool: palette noise + small light curls with a darker underside. */
function woolFill(p, x, y, w, h) {
  p.fill(x, y, w, h, WOOL);
  const n = Math.max(1, Math.round(w * h / 7));
  for (let k = 0; k < n; k++) {
    const cx = x + Math.floor(p.rnd() * w), cy = y + Math.floor(p.rnd() * h);
    p.set(cx, cy, '#F8F8F8');
    if (cy + 1 < y + h) p.set(cx, cy + 1, p.pick([['#D4D4D4', 2], ['#CBCBCB', 1]]));
  }
}

function paintSheepFur() {
  const p = new SkinPainter(0xf0f0);
  for (const [u, v, w, h, d] of [[0, 0, 6, 6, 6], [28, 8, 8, 16, 6], [0, 16, 4, 6, 4]]) {
    const f = SkinPainter.faces(u, v, w, h, d);
    for (const k in f) woolFill(p, ...f[k]);
  }
  // the bottom edge of the leg fur is a little shadowed (tufts)
  const leg = SkinPainter.faces(0, 16, 4, 6, 4);
  for (const k of ['right', 'front', 'left', 'back']) {
    const [x, y, w, h] = leg[k];
    for (let i = 0; i < w; i++) p.tone(x + i, y + h - 1, 0.9);
  }
  return p.data;
}

// ---- chicken -------------------------------------------------------------------------------------
function paintChicken() {
  const p = new SkinPainter(0xc41c);
  const WHITE = [['#FFFFFF', 5], ['#F3F3F3', 4], ['#E8E8E8', 2]];
  const head = p.box(0, 0, 4, 6, 3, WHITE);
  const [fx, fy] = head.front;
  p.set(fx, fy + 1, '#111111'); p.set(fx + 3, fy + 1, '#111111');
  for (const k of ['right', 'left']) {
    const [x, y, w] = head[k];
    p.set(k === 'right' ? x + w - 1 : x, y + 1, '#111111');
  }
  p.box(14, 0, 4, 2, 2, [['#F7B42C', 4], ['#EFA51D', 3], ['#FFC447', 1]]);    // beak
  p.box(14, 4, 2, 2, 2, [['#DE2525', 4], ['#C61B1B', 3], ['#EE3A3A', 1]]);     // wattle
  const body = p.box(0, 9, 6, 8, 6, WHITE);
  p.shade(...body.front, 0.96);   // underside
  for (let n = 0; n < 10; n++) {
    const [x, y, w, h] = body[['right', 'left', 'back'][n % 3]];
    p.tone(x + Math.floor(p.rnd() * w), y + Math.floor(p.rnd() * h), 0.9);
  }
  // wings 1x4x6 at (24, 13): white, feather tips slightly grey
  const wing = p.box(24, 13, 1, 4, 6, WHITE);
  for (const k of ['right', 'left']) {
    const [x, y, w, h] = wing[k];
    for (let i = 0; i < w; i++) p.set(x + i, y + h - 1, p.pick([['#DCDCDC', 2], ['#D0D0D0', 1]]));
  }
  // legs 3x5x3 at (26, 0): a thin yellow leg (centre texel column) with toes, the rest transparent
  const leg = SkinPainter.faces(26, 0, 3, 5, 3);
  const LEG = [['#E9A21A', 3], ['#D98F0E', 2]];
  for (const k of ['right', 'front', 'left', 'back']) {
    const [x, y, w, h] = leg[k];
    for (let j = 0; j < h; j++) p.set(x + 1, y + j, p.pick(LEG));
    if (k === 'front' || k === 'right' || k === 'left') for (let i = 0; i < w; i++) p.set(x + i, y + h - 1, p.pick(LEG));
  }
  p.set(leg.top[0] + 1, leg.top[1] + 1, '#E9A21A');
  p.map(leg.bottom[0], leg.bottom[1], ['ttt', '.t.', '.t.'], { t: LEG });
  return p.data;
}

// ---- zombie --------------------------------------------------------------------------------------
function paintZombie() {
  const p = new SkinPainter(0x2b1e);
  const SKIN = [['#5C8D49', 5], ['#52823F', 4], ['#67994F', 3], ['#4A7638', 2], ['#71A35A', 1]];
  const SKIN_D = [['#42692F', 3], ['#3B5F2A', 2]];
  const SHIRT = [['#1F9C9C', 5], ['#1A8C8C', 4], ['#25A9A9', 2], ['#167A7A', 2]];
  const PANTS = [['#3F449E', 5], ['#363B8E', 4], ['#4A50AE', 2], ['#2E327C', 2]];
  // head
  const head = p.box(0, 0, 8, 8, 8, SKIN);
  p.fill(...head.top, [['#4C7A3A', 4], ['#56853F', 3], ['#43702F', 2]]);
  const [fx, fy] = head.front;
  p.map(fx, fy, [
    '........',
    '........',
    '........',
    '.ee..ee.',
    '...nn...',
    '........',
    '..mmmm..',
    '........',
  ], { e: '#0C0C0C', n: '#3A5A2C', m: SKIN_D });
  p.set(fx + 2, fy + 2, '#4A7638'); p.set(fx + 5, fy + 2, '#4A7638');
  p.set(fx + 1, fy + 4, '#46703A'); p.set(fx + 6, fy + 4, '#46703A');
  // a few darker rot spots on the head
  for (let n = 0; n < 8; n++) {
    const k = ['right', 'left', 'back', 'top'][n & 3];
    const [x, y, w, h] = head[k];
    p.set(x + Math.floor(p.rnd() * w), y + Math.floor(p.rnd() * h), p.pick(SKIN_D));
  }
  // body: torn shirt over green skin, pants at the bottom
  const body = p.box(16, 16, 8, 12, 4, SHIRT);
  for (const k of ['right', 'front', 'left', 'back']) {
    const [x, y, w, h] = body[k];
    p.fill(x, y + h - 2, w, 2, PANTS);
    for (let i = 0; i < w; i++) {
      // ragged hem: skin shows through above the trousers here and there
      if (p.rnd() < 0.45) p.set(x + i, y + h - 3, p.pick(SKIN));
      if (p.rnd() < 0.2) p.set(x + i, y + h - 4, p.pick(SKIN));
    }
  }
  const [bx, by] = body.front;
  for (let i = 2; i < 6; i++) p.set(bx + i, by, p.pick(SKIN));         // collar
  p.set(bx + 3, by + 1, p.pick(SKIN)); p.set(bx + 4, by + 1, p.pick(SKIN));
  p.set(bx + 5, by + 5, p.pick(SKIN)); p.set(bx + 2, by + 7, p.pick(SKIN));   // holes
  p.fill(...body.bottom, PANTS);
  // arms: skin with a short torn sleeve at the shoulder
  const arm = p.box(40, 16, 4, 12, 4, SKIN);
  for (const k of ['right', 'front', 'left', 'back']) {
    const [x, y, w] = arm[k];
    p.fill(x, y, w, 3, SHIRT);
    for (let i = 0; i < w; i++) if (p.rnd() < 0.5) p.set(x + i, y + 3, p.pick(SHIRT));
  }
  p.fill(...arm.top, SHIRT);
  p.fill(...arm.bottom, SKIN_D);
  // legs: trousers, bare dark feet
  const leg = p.box(0, 16, 4, 12, 4, PANTS);
  for (const k of ['right', 'front', 'left', 'back']) {
    const [x, y, w, h] = leg[k];
    p.fill(x, y + h - 2, w, 2, [['#3A3F45', 3], ['#30353A', 2]]);
    for (let i = 0; i < w; i++) if (p.rnd() < 0.3) p.set(x + i, y + h - 3, p.pick(SKIN));
  }
  p.fill(...leg.bottom, [['#30353A', 3], ['#282C30', 2]]);
  return p.data;
}

// ---- skeleton --------------------------------------------------------------------------------------
function paintSkeleton() {
  const p = new SkinPainter(0x5c3e);
  const BONE = [['#C6C6C6', 5], ['#BBBBBB', 4], ['#D2D2D2', 3], ['#ADADAD', 1]];
  const DARK = [['#3C3C3C', 3], ['#333333', 2], ['#474747', 1]];
  const head = p.box(0, 0, 8, 8, 8, BONE);
  const [fx, fy] = head.front;
  p.map(fx, fy, [
    '........',
    '........',
    '........',
    '.kk..kk.',
    '.kk..kk.',
    '...dd...',
    '.ttttttt',
    '........',
  ], { k: '#101010', d: '#2A2A2A', t: '#5A5A5A' });
  // mouth: teeth (alternating light / dark)
  for (let i = 1; i < 7; i++) p.set(fx + i, fy + 6, i % 2 ? '#3A3A3A' : '#9A9A9A');
  p.set(fx + 7, fy + 6, p.pick(BONE));
  p.set(fx + 1, fy + 2, '#A5A5A5'); p.set(fx + 6, fy + 2, '#A5A5A5');
  // cracks and shading on the skull
  for (let n = 0; n < 6; n++) {
    const k = ['right', 'left', 'back', 'top'][n & 3];
    const [x, y, w, h] = head[k];
    p.set(x + Math.floor(p.rnd() * w), y + Math.floor(p.rnd() * h), '#9E9E9E');
  }
  p.shade(...head.bottom, 0.85);
  // body: ribcage (ribs + spine with dark gaps), pelvis at the bottom
  const body = p.box(16, 16, 8, 12, 4, DARK);
  const rib = (x, y, w, h, spine) => {
    for (let j = 0; j < h; j++) {
      const row = j;
      for (let i = 0; i < w; i++) {
        let bone = false;
        if (row < 7) bone = row % 2 === 0 || (spine && (i === 3 || i === 4));
        else if (row === 7 || row === 8) bone = spine && (i === 3 || i === 4);
        else if (row === 9) bone = true;
        else bone = spine ? i <= 2 || i >= 5 : (i === 0 || i === w - 1);
        if (bone) p.set(x + i, y + j, p.pick(BONE));
      }
    }
  };
  rib(...body.front, true);
  rib(...body.back, true);
  rib(...body.right, false);
  rib(...body.left, false);
  p.fill(...body.top, BONE);
  p.fill(...body.bottom, DARK);
  // arms and legs: thin bones with darker joints
  for (const [u, v] of [[40, 16], [0, 16]]) {
    const f = p.box(u, v, 2, 12, 2, BONE);
    for (const k of ['right', 'front', 'left', 'back']) {
      const [x, y, w, h] = f[k];
      for (let i = 0; i < w; i++) p.set(x + i, y + Math.floor(h / 2), '#A0A0A0');
      for (let i = 0; i < w; i++) p.set(x + i, y + h - 1, '#ABABAB');
    }
  }
  return p.data;
}

// ---- creeper -------------------------------------------------------------------------------------
const CREEPER_GREEN = [
  ['#4EAF45', 9], ['#3F9A37', 7], ['#5FC452', 5], ['#2F7F2A', 3], ['#86D57D', 3], ['#B7C8B3', 2], ['#256B22', 1],
];

function paintCreeper() {
  const p = new SkinPainter(0xc4ee);
  // clustered camouflage: 2x2 blocks with per-texel variation
  const camo = (x, y, w, h) => {
    for (let j = 0; j < h; j += 2) {
      for (let i = 0; i < w; i += 2) {
        const base = p.pick(CREEPER_GREEN);
        for (let b = 0; b < 4; b++) {
          const xi = i + (b & 1), yj = j + (b >> 1);
          if (xi >= w || yj >= h) continue;
          p.set(x + xi, y + yj, p.rnd() < 0.6 ? base : p.pick(CREEPER_GREEN));
        }
      }
    }
  };
  for (const [u, v, w, h, d] of [[0, 0, 8, 8, 8], [16, 16, 8, 12, 4], [0, 16, 4, 6, 4]]) {
    const f = SkinPainter.faces(u, v, w, h, d);
    for (const k in f) camo(...f[k]);
  }
  // the face
  const [fx, fy] = SkinPainter.faces(0, 0, 8, 8, 8).front;
  p.map(fx, fy, [
    '........',
    '........',
    '.kk..kk.',
    '.kd..dk.',
    '...dd...',
    '..kkkk..',
    '..kddk..',
    '..k..k..',
  ], { k: '#0A0A0A', d: '#1E1E1E' });
  // dark feet
  const leg = SkinPainter.faces(0, 16, 4, 6, 4);
  for (const k of ['right', 'front', 'left', 'back']) {
    const [x, y, w, h] = leg[k];
    for (let i = 0; i < w; i++) p.tone(x + i, y + h - 1, 0.62);
  }
  p.shade(...leg.bottom, 0.55);
  return p.data;
}

// ---- spider --------------------------------------------------------------------------------------
function paintSpider() {
  const p = new SkinPainter(0x5b1d);
  const BODY = [['#352E29', 5], ['#2C2622', 4], ['#3F3731', 3], ['#241F1C', 2], ['#4B423B', 1]];
  // neck (body0) 6x6x6 at (0, 0)
  p.box(0, 0, 6, 6, 6, BODY);
  // abdomen (body1) 10x8x12 at (0, 12): darker with a lighter hairy pattern on the back
  const ab = p.box(0, 12, 10, 8, 12, BODY);
  const [tx, ty, tw, th] = ab.top;      // the back of the abdomen faces up
  for (let j = 0; j < th; j++) {
    for (let i = 0; i < tw; i++) {
      const d = Math.abs(i + 0.5 - tw / 2);
      if ((j % 4 === 1 && d < 3.5) || (d < 1 && j % 2 === 0)) p.set(tx + i, ty + j, p.pick([['#5A4E44', 2], ['#4E443B', 2]]));
    }
  }
  for (const k of ['right', 'left', 'back', 'front']) {
    const [x, y, w, h] = ab[k];
    for (let n = 0; n < w * h / 9; n++) p.set(x + Math.floor(p.rnd() * w), y + Math.floor(p.rnd() * h), '#51473F');
  }
  // head 8x8x8 at (32, 4) with red eyes (emissive) and fangs
  const head = p.box(32, 4, 8, 8, 8, BODY);
  const [fx, fy] = head.front;
  const E = { c: '#D41E26', a: EMISSIVE_ALPHA }, H = { c: '#FF5A4E', a: EMISSIVE_ALPHA }, S = { c: '#A8161C', a: EMISSIVE_ALPHA };
  p.map(fx, fy, [
    '........',
    '..s..s..',
    '.HE..HE.',
    '.EE..EE.',
    '...ss...',
    '........',
    '..f..f..',
    '..f..f..',
  ], { H, E, s: S, f: '#6B5E53' });
  p.set(fx, fy + 2, { c: '#A8161C' }.c, EMISSIVE_ALPHA);
  p.set(fx + 7, fy + 2, '#A8161C', EMISSIVE_ALPHA);
  // legs 16x2x2 at (18, 0): dark with lighter joints / bristles
  const leg = p.box(18, 0, 16, 2, 2, BODY);
  for (const k of ['front', 'back', 'top', 'bottom']) {
    const [x, y, w, h] = leg[k];
    for (let i = 0; i < w; i += 1) {
      if (i === 5 || i === 11) for (let j = 0; j < h; j++) p.set(x + i, y + j, '#594E45');
      else if (p.rnd() < 0.15) p.set(x + i, y + Math.floor(p.rnd() * h), '#4A413A');
    }
  }
  return p.data;
}

// ---- arrow (Minecraft arrow.png layout, 32x32 painted at 2x) ---------------------------------------------
function paintArrow() {
  const p = new SkinPainter(0xa770);
  const put = (x, y, c, a = 255) => {
    for (let k = 0; k < 4; k++) p.set(x * 2 + (k & 1), y * 2 + (k >> 1), c, a);
  };
  // side image (16x5) at (0, 0): fletching at the left (rear), shaft, iron head at the right (tip)
  const side = [
    'ff..........hh..',
    '.ff.........hhh.',
    'sffssssssssshhhh',
    '.ff.........hhh.',
    'ff..........hh..',
  ];
  const key = {
    f: [['#E8E8E8', 3], ['#D2D2D2', 2], ['#F6F6F6', 1]],
    s: [['#8A6A3E', 3], ['#7A5C34', 2], ['#9B7A4A', 1]],
    h: [['#9A9A9A', 3], ['#B5B5B5', 2], ['#7D7D7D', 1]],
  };
  side.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const c = key[row[x]];
      if (c) put(x, y, p.pick(c));
    }
  });
  put(15, 2, '#D9D9D9');
  // back (nock) 5x5 at (0, 5): feathers seen from behind
  const back = ['f...f', '.f.f.', '..s..', '.f.f.', 'f...f'];
  back.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const c = key[row[x]];
      if (c) put(x, 5 + y, p.pick(c));
    }
  });
  return p.data;
}

// ---- fire (Minecraft Alpha TextureFlamesFX automaton) -----------------------------------------------------
/**
 * FIRE_FRAMES consecutive 16x16 flame frames from Minecraft Alpha's procedural fire (heat diffusing upward
 * from a random bottom row), upscaled 4x into 64x64 RGBA layers; visible texels carry EMISSIVE_ALPHA.
 */
export function paintFireFrames(frames = FIRE_FRAMES) {
  const W = 16, H = 20;
  let cur = new Float32Array(W * H), nxt = new Float32Array(W * H);
  const rnd = makeRng(0xf12e);
  const step = () => {
    for (let i = 0; i < W; i++) {
      for (let j = 0; j < H; j++) {
        let k = 18;
        let f = cur[i + ((j + 1) % H) * W] * k;
        for (let i1 = i - 1; i1 <= i + 1; i1++) {
          for (let k1 = j; k1 <= j + 1; k1++) {
            if (i1 >= 0 && k1 >= 0 && i1 < W && k1 < H) f += cur[i1 + k1 * W];
            k++;
          }
        }
        nxt[i + j * W] = f / (k * 1.06);
        if (j >= H - 1) nxt[i + j * W] = rnd() * rnd() * rnd() * 4 + rnd() * 0.1 + 0.2;
      }
    }
    const t = cur; cur = nxt; nxt = t;
  };
  for (let w = 0; w < 60; w++) step();
  const out = [];
  for (let f = 0; f < frames; f++) {
    step();
    const px = new Uint8Array(SKIN_SIZE * SKIN_SIZE * 4);
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        let v = cur[x + y * W] * 1.8;
        v = Math.min(1, Math.max(0, v));
        if (v < 0.5) continue;
        const r = Math.round(v * 155 + 100), g = Math.round(v * v * 255), b = Math.round(v ** 10 * 255);
        for (let k = 0; k < 16; k++) {
          const o = ((y * 4 + (k >> 2)) * SKIN_SIZE + x * 4 + (k & 3)) * 4;
          px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = EMISSIVE_ALPHA;
        }
      }
    }
    out.push(px);
  }
  return out;
}

/**
 * Every mob skin layer except the player (layer 0, painted by entityrenderer.paintSkinTexture) and the fire
 * frames: Map layer -> Uint8Array(64*64*4).
 */
export function paintMobSkins() {
  return new Map([
    [SKIN.ZOMBIE, paintZombie()],
    [SKIN.SKELETON, paintSkeleton()],
    [SKIN.CREEPER, paintCreeper()],
    [SKIN.SPIDER, paintSpider()],
    [SKIN.PIG, paintPig()],
    [SKIN.COW, paintCow()],
    [SKIN.SHEEP, paintSheep()],
    [SKIN.SHEEP_FUR, paintSheepFur()],
    [SKIN.CHICKEN, paintChicken()],
    [SKIN.ARROW, paintArrow()],
  ]);
}

// ===================================================================================================
// Poses (LivingEntityRenderer + each model's setupAnim)
// ===================================================================================================

const _B = new Float64Array(12);         // base matrix (camera-relative, model px -> world blocks without 1/16)
const _M = new Float64Array(12);         // part matrix scratch
const _R = new Float64Array(MAX_MODEL_PARTS * 3);   // part rotations x, y, z (radians)
const _P = new Float64Array(MAX_MODEL_PARTS * 3);   // part pivots (px)

/** Minecraft netHeadYaw (radians) from SPEC yaws: body - head, wrapped to [-pi, pi). */
function netHeadYaw(it) {
  let a = ((+it.bodyYaw || 0) - (+it.headYaw || 0) + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

function restPose(parts, n) {
  for (let p = 0; p < n; p++) {
    const q = parts[p];
    _P[p * 3] = q.pivot[0]; _P[p * 3 + 1] = q.pivot[1]; _P[p * 3 + 2] = q.pivot[2];
    _R[p * 3] = q.rot[0]; _R[p * 3 + 1] = q.rot[1]; _R[p * 3 + 2] = q.rot[2];
  }
}

/** BowItem.getPowerForTime for `ticks` of drawing (0..1). */
export function bowPower(ticks) {
  const f = Math.max(0, ticks) / 20;
  return Math.min(1, (f * f + f * 2) / 3);
}

/** Sheep eating animation (Sheep.getHeadEatPositionScale / getHeadEatAngleScale), `eat` = ticks left 0..40. */
function sheepEat(eat, headPitch) {
  let pos = 0, angle = headPitch;
  if (eat > 0) {
    if (eat >= 4 && eat <= 36) pos = 1;
    else pos = eat < 4 ? eat / 4 : -(eat - 40) / 4;
    if (eat > 4 && eat <= 36) angle = Math.PI / 5 + 0.21991149 * Math.sin((eat - 4) / 32 * 28.7);
    else angle = Math.PI / 5;
  }
  _eatPos = pos;
  return angle;
}
let _eatPos = 0;

/**
 * HumanoidModel.setupAnim for mobs (zombie, skeleton): walk cycle, head look, BOW_AND_ARROW arm pose,
 * attack swing, idle arm bob, then AbstractZombieModel / SkeletonModel arm overrides.
 */
function setupHumanoidMob(def, it) {
  const limb = +it.limbSwing || 0;
  const amt = Math.min(1, Math.max(0, +it.limbSwingAmount || 0));
  const age = (+it.age || 0) * 20;
  const headX = -(+it.headPitch || 0);
  const headY = netHeadYaw(it);
  const R = _R, P = _P;
  R[0] = headX; R[1] = headY;
  let rArmX = Math.cos(limb * 0.6662 + Math.PI) * amt, lArmX = Math.cos(limb * 0.6662) * amt;
  let rArmY = 0, lArmY = 0, rArmZ = 0, lArmZ = 0;
  const legX = def.anim === 'skeleton' ? 2 : 1.9;
  R[12] = Math.cos(limb * 0.6662) * 1.4 * amt; R[13] = 0.005; R[14] = 0.005;
  R[15] = Math.cos(limb * 0.6662 + Math.PI) * 1.4 * amt; R[16] = -0.005; R[17] = -0.005;
  P[12] = -legX; P[13] = 12; P[14] = 0.1;
  P[15] = legX; P[16] = 12; P[17] = 0.1;
  const aggressive = !!it.aggressive;
  // skeletons only ever hold a bow: aggressive + holding it -> ArmPose.BOW_AND_ARROW
  const bow = def.anim === 'skeleton' && aggressive && (it.itemId | 0) > 0;
  if (bow) {
    // HumanoidModel.poseRightArm / poseLeftArm: BOW_AND_ARROW
    rArmY = -0.1 + headY; lArmY = 0.1 + headY + 0.4;
    rArmX = -HALF_PI + headX; lArmX = -HALF_PI + headX;
  } else if ((it.itemId | 0) > 0) {
    rArmX = rArmX * 0.5 - Math.PI / 10;   // ArmPose.ITEM
  }
  let bodyY = 0;
  let rArmPX = -5, rArmPZ = 0, lArmPX = 5, lArmPZ = 0;
  const att = Math.min(1, Math.max(0, +it.attack || 0));
  if (att > 0) {
    bodyY = Math.sin(Math.sqrt(att) * TAU) * 0.2;
    rArmPZ = Math.sin(bodyY) * 5; rArmPX = -Math.cos(bodyY) * 5;
    lArmPZ = -Math.sin(bodyY) * 5; lArmPX = Math.cos(bodyY) * 5;
    rArmY += bodyY; lArmY += bodyY; lArmX += bodyY;
    let g = 1 - att;
    g *= g; g *= g; g = 1 - g;
    const f1 = Math.sin(g * Math.PI);
    const f2 = Math.sin(att * Math.PI) * -(headX - 0.7) * 0.75;
    rArmX -= f1 * 1.2 + f2;
    rArmY += bodyY * 2;
    rArmZ += Math.sin(att * Math.PI) * -0.4;
  }
  // bobModelPart
  const swayZ = Math.cos(age * 0.09) * 0.05 + 0.05, swayX = Math.sin(age * 0.067) * 0.05;
  rArmZ += swayZ; rArmX += swayX; lArmZ -= swayZ; lArmX -= swayX;
  if (def.anim === 'zombie' || (def.anim === 'skeleton' && aggressive && !bow)) {
    // AnimationUtils.animateZombieArms (skeletons without a bow attack like zombies)
    const f = Math.sin(att * Math.PI);
    const f1 = Math.sin((1 - (1 - att) * (1 - att)) * Math.PI);
    rArmZ = 0; lArmZ = 0;
    rArmY = -(0.1 - f * 0.6); lArmY = 0.1 - f * 0.6;
    const f2 = def.anim === 'zombie' ? -Math.PI / (aggressive ? 1.5 : 2.25) : -HALF_PI;
    rArmX = f2; lArmX = f2;
    if (def.anim === 'zombie') {
      rArmX += f * 1.2 - f1 * 0.4; lArmX += f * 1.2 - f1 * 0.4;
    } else {
      rArmX -= f * 1.2 - f1 * 0.4; lArmX -= f * 1.2 - f1 * 0.4;
    }
    rArmZ += swayZ; lArmZ -= swayZ; rArmX += swayX; lArmX -= swayX;   // bobArms
  }
  R[3] = 0; R[4] = bodyY; R[5] = 0;
  R[6] = rArmX; R[7] = rArmY; R[8] = rArmZ;
  R[9] = lArmX; R[10] = lArmY; R[11] = lArmZ;
  P[6] = rArmPX; P[7] = 2; P[8] = rArmPZ;
  P[9] = lArmPX; P[10] = 2; P[11] = lArmPZ;
}

/** QuadrupedModel / CreeperModel legs: right hind, left hind, right front, left front from part index `first`. */
function quadLegSwing(it, first) {
  const limb = +it.limbSwing || 0;
  const amt = Math.min(1, Math.max(0, +it.limbSwingAmount || 0));
  const a = Math.cos(limb * 0.6662) * 1.4 * amt, b = Math.cos(limb * 0.6662 + Math.PI) * 1.4 * amt;
  _R[first * 3] = a; _R[(first + 1) * 3] = b; _R[(first + 2) * 3] = b; _R[(first + 3) * 3] = a;
}

const SPIDER_Q = Math.PI / 4, SPIDER_M = 0.58119464, SPIDER_Y = 0.3926991;
// SpiderModel rest angles of the 8 legs (right/left hind, middle hind, middle front, front)
const SPIDER_ZR = Float64Array.of(-SPIDER_Q, SPIDER_Q, -SPIDER_M, SPIDER_M, -SPIDER_M, SPIDER_M, -SPIDER_Q, SPIDER_Q);
const SPIDER_YR = Float64Array.of(SPIDER_Q, -SPIDER_Q, SPIDER_Y, -SPIDER_Y, -SPIDER_Y, SPIDER_Y, -SPIDER_Q, SPIDER_Q);
const _legY = new Float64Array(8);
const _legZ = new Float64Array(8);

function setupSpider(it) {
  const R = _R;
  R[0] = -(+it.headPitch || 0); R[1] = netHeadYaw(it);
  const limb = +it.limbSwing || 0;
  const amt = Math.min(1, Math.max(0, +it.limbSwingAmount || 0));
  const w = limb * 0.6662;
  const f3 = -(Math.cos(w * 2) * 0.4) * amt;
  const f4 = -(Math.cos(w * 2 + Math.PI) * 0.4) * amt;
  const f5 = -(Math.cos(w * 2 + HALF_PI) * 0.4) * amt;
  const f6 = -(Math.cos(w * 2 + Math.PI * 1.5) * 0.4) * amt;
  const f7 = Math.abs(Math.sin(w) * 0.4) * amt;
  const f8 = Math.abs(Math.sin(w + Math.PI) * 0.4) * amt;
  const f9 = Math.abs(Math.sin(w + HALF_PI) * 0.4) * amt;
  const f10 = Math.abs(Math.sin(w + Math.PI * 1.5) * 0.4) * amt;
  const dy = _legY, dz = _legZ;
  dy[0] = f3; dy[1] = -f3; dy[2] = f4; dy[3] = -f4; dy[4] = f5; dy[5] = -f5; dy[6] = f6; dy[7] = -f6;
  dz[0] = f7; dz[1] = -f7; dz[2] = f8; dz[3] = -f8; dz[4] = f9; dz[5] = -f9; dz[6] = f10; dz[7] = -f10;
  for (let k = 0; k < 8; k++) {
    const o = (3 + k) * 3;
    R[o] = 0; R[o + 1] = SPIDER_YR[k] + dy[k]; R[o + 2] = SPIDER_ZR[k] + dz[k];
  }
}

/**
 * Minecraft model pose for a 'model' EntityRenderItem of a mob (LivingEntityRenderer.setupRotations, render
 * scale incl. creeper swelling, the model's setupAnim). Writes one 3x4 camera-relative matrix per part (for
 * px-space part geometry) into `out` (12 floats each; overlay parts follow the base parts) and, for models
 * with a hand, the held-item hand matrix (ItemInHandLayer translateToHand + rotX(-90) rotY(180) translate)
 * into `hand` (if given). (rx, ry, rz) = position relative to the camera. Returns the number of matrices.
 * Allocation-free.
 */
export function computeModelPose(def, it, rx, ry, rz, out, hand = null) {
  // ---- base: T(rel) · Ry(bodyYaw) · Rz(flip) · S(-sx, -sy, sz) · T(0, -1.501, 0)
  const yaw = +it.bodyYaw || 0;
  const cyw = Math.cos(yaw), syw = Math.sin(yaw);
  let cf = 1, sf = 0;
  const deathTicks = (+it.death || 0) * 20;
  if (deathTicks > 0 && def.flip) {
    const flip = Math.min(1, Math.sqrt(Math.max(0, (deathTicks - 1) / 20 * 1.6))) * def.flip * DEG;
    cf = Math.cos(flip);
    sf = Math.sin(flip);
  }
  let sx = def.scale, sy = def.scale;
  const swell = +it.swell || 0;
  if (swell > 0) {
    // CreeperRenderer.scale
    const f1 = 1 + Math.sin(swell * 100) * swell * 0.01;
    let f = Math.min(1, Math.max(0, swell));
    f *= f; f *= f;
    sx *= (1 + f * 0.4) * f1;
    sy *= (1 + f * 0.1) / f1;
  }
  const B = _B;
  B[0] = -sx * cyw * cf; B[1] = sy * cyw * sf; B[2] = sx * syw;
  B[4] = -sx * sf; B[5] = -sy * cf; B[6] = 0;
  B[8] = sx * syw * cf; B[9] = -sy * syw * sf; B[10] = sx * cyw;
  B[3] = rx - 1.501 * B[1];
  B[7] = ry - 1.501 * B[5];
  B[11] = rz - 1.501 * B[9];

  // ---- setupAnim
  const parts = def.parts;
  const n = parts.length;
  restPose(parts, n);
  const headX = -(+it.headPitch || 0);
  switch (def.anim) {
    case 'zombie':
    case 'skeleton':
      setupHumanoidMob(def, it);
      break;
    case 'quadruped':
      _R[0] = headX; _R[1] = netHeadYaw(it);
      quadLegSwing(it, 2);
      break;
    case 'sheep': {
      const angle = sheepEat(+it.eat || 0, headX);
      _R[0] = angle; _R[1] = netHeadYaw(it);
      _P[1] = 6 + _eatPos * 9;
      quadLegSwing(it, 2);
      break;
    }
    case 'creeper':
      _R[0] = headX; _R[1] = netHeadYaw(it);
      quadLegSwing(it, 2);
      break;
    case 'spider':
      setupSpider(it);
      break;
    case 'chicken': {
      const hy = netHeadYaw(it);
      for (let p = 0; p < 3; p++) { _R[p * 3] = headX; _R[p * 3 + 1] = hy; }
      const limb = +it.limbSwing || 0;
      const amt = Math.min(1, Math.max(0, +it.limbSwingAmount || 0));
      _R[12] = Math.cos(limb * 0.6662) * 1.4 * amt;
      _R[15] = Math.cos(limb * 0.6662 + Math.PI) * 1.4 * amt;
      const flap = +it.flap || 0;
      _R[20] = flap; _R[23] = -flap;
      break;
    }
    default:
      break;
  }

  // ---- part matrices: base · T(pivot / 16) · Rz · Ry · Rx, geometry scaled by 1/16
  const m = _M;
  let count = 0;
  const overlay = def.overlay ? def.overlay.parts.length : 0;
  for (let k = 0; k < n + overlay; k++) {
    const p = k < n ? k : k - n;          // overlay part k-n shares the pose of base part k-n
    const ax = _R[p * 3], ay = _R[p * 3 + 1], az = _R[p * 3 + 2];
    const cx = Math.cos(ax), sxr = Math.sin(ax), cy = Math.cos(ay), syr = Math.sin(ay), cz = Math.cos(az), szr = Math.sin(az);
    const q00 = cz * cy, q01 = cz * syr * sxr - szr * cx, q02 = cz * syr * cx + szr * sxr;
    const q10 = szr * cy, q11 = szr * syr * sxr + cz * cx, q12 = szr * syr * cx - cz * sxr;
    const q20 = -syr, q21 = cy * sxr, q22 = cy * cx;
    let px = _P[p * 3], py = _P[p * 3 + 1], pz = _P[p * 3 + 2];
    for (let row = 0; row < 12; row += 4) {
      const b0 = B[row], b1 = B[row + 1], b2 = B[row + 2];
      m[row] = b0 * q00 + b1 * q10 + b2 * q20;
      m[row + 1] = b0 * q01 + b1 * q11 + b2 * q21;
      m[row + 2] = b0 * q02 + b1 * q12 + b2 * q22;
      m[row + 3] = B[row + 3] + (b0 * px + b1 * py + b2 * pz) / 16;
    }
    if (k === def.hand && hand) {
      // ItemInHandLayer: translateToHand (skeleton arms 1 px outward), rotX(-90), rotY(180), translate
      px += def.handX;
      for (let row = 0; row < 12; row += 4) {
        const b0 = B[row], b1 = B[row + 1], b2 = B[row + 2];
        hand[row] = m[row]; hand[row + 1] = m[row + 1]; hand[row + 2] = m[row + 2];
        hand[row + 3] = B[row + 3] + (b0 * px + b1 * py + b2 * pz) / 16;
      }
      handTransform(hand);
    }
    const o = count * 12;
    for (let row = 0; row < 12; row += 4) {
      out[o + row] = m[row] / 16;
      out[o + row + 1] = m[row + 1] / 16;
      out[o + row + 2] = m[row + 2] / 16;
      out[o + row + 3] = m[row + 3];
    }
    count++;
  }
  return count;
}

/** ItemInHandLayer after translateToHand: rotX(-90°), rotY(180°), translate(1/16, 0.125, -0.625). In place. */
function handTransform(m) {
  // rotX(-90): (r1, r2) -> (-r2, r1)
  for (let r = 0; r < 12; r += 4) {
    const m1 = m[r + 1], m2 = m[r + 2];
    m[r + 1] = -m2;
    m[r + 2] = m1;
  }
  // rotY(180): r0 -> -r0, r2 -> -r2
  for (let r = 0; r < 12; r += 4) {
    m[r] = -m[r];
    m[r + 2] = -m[r + 2];
  }
  const x = 1 / 16, y = 0.125, z = -0.625;
  m[3] += m[0] * x + m[1] * y + m[2] * z;
  m[7] += m[4] * x + m[5] * y + m[6] * z;
  m[11] += m[8] * x + m[9] * y + m[10] * z;
}
