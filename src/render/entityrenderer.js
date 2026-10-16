// Entity renderer (SPEC §9.5, SPEC-wave2 §3.4): dropped items, block entities (falling blocks, primed TNT),
// 'model' entities (the player in third-person views, every mob, arrows), burning-entity flames, entity
// shadows, particles and the first-person hand, drawn with WebGL2 into the world renderer's frame
// (camera-relative, shared texture array, the canonical lightColor() of §9.3, fog per ctx).
//
// Mobs (wave 2): Minecraft ModelPart geometry and procedural box-UV skins from mobmodels.js live in one
// 64x64 skin texture array (player, 8 mobs, sheep fleece, arrow, 16 fire frames). Every model part is its own
// instanced model, so 40+ mobs cost one draw per part kind. Per instance: hurt / death red overlay, creeper
// white flash + swelling, sheep fleece tint, emissive skin texels (spider eyes, fire; alpha 128..254) drawn
// full-bright, held items (zombie tools, skeleton bow with the pulling frames) through ItemInHandLayer.
// Burning entities get Minecraft's stacked flame sheets (EntityRenderDispatcher.renderFlame). The hand
// renders HandState.useAction ('eat': applyEatTransform; 'bow': the drawn-bow pose with bow_pulling_0..2).
//
// Design:
//  * Instanced rendering. Static model geometry (cube, inset cactus box, cross, torch post, the six Steve
//    model parts and one extruded model per item sprite, built lazily) lives in one VBO; every visible entity
//    copy / model part is an instance (3x4 camera-relative model matrix + packed face layers / UV rotations /
//    alpha mode / tint / flash / light). Instances are grouped by model with a counting sort into one
//    preallocated dynamic buffer (bufferSubData) and drawn with one drawArraysInstanced per model in use.
//    No per-frame allocations once the buffers have grown to the scene's needs.
//  * Player model: Minecraft PlayerModel parts with a procedural 64x64 Steve skin and HumanoidModel.setupAnim
//    (walk cycle, head look, item arm, attack swing, crouch, idle sway), LivingEntityRenderer rotations (death
//    tip-over, red hurt overlay) and ItemInHandLayer + "thirdperson_righthand" transforms for the held item.
//  * Shadows: Minecraft's soft disc on the block under items / TNT / falling blocks / the player.
//  * Dropped items follow Minecraft's ItemEntityRenderer: bob sin(age·2 + φ)·0.1 + 0.1, spin age + φ,
//    "ground" display transforms (blocks: +3 px, scale 0.25; generated sprites: +2 px, scale 0.5) and
//    getRenderAmount copies (2 > 1, 3 > 16, 4 > 32, 5 > 48): blocks scatter ±0.15, sprites stack 1.5 px
//    apart with a little jitter.
//  * Sprite items (and cross/torch blocks) are extruded like ItemModelGenerator: front + back quad and one
//    1/16-thick edge quad per run of boundary texels, generated from the sprite's alpha, read back once
//    from the texture array on the GPU (no CPU copy of the textures is needed).
//  * §5.3: OPAQUE-layer blocks use rgb·mix(tint, 1, a) (tint mask), everything else discards a < 0.5 and
//    uses rgb·tint; translucent blocks (ice, water) are alpha blended in a second draw. DEFAULT_TINTS.
//  * Shading: the world's FACE_SHADE generalised to arbitrary normals (n.x²·0.6 + n.z²·0.8 + n.y²·(1 | 0.5)),
//    so spinning items shade continuously; plants / torches are unshaded (0.9) like in the mesher.
//  * Hand: Minecraft's ItemInHandRenderer pose chains, verbatim: renderPlayerArm for the empty hand
//    (Steve arm, skin + cyan sleeve, 4x12x4 box with the classic skin UV layout), applyItemArmTransform +
//    applyItemArmAttackTransform + the block / generated "firstperson_righthand" display transforms for
//    held items, plus the HandState view bob / sway. Own projection (fov 70, near 0.01), depth cleared.
//  * Particles: one instanced draw of camera-facing quads straight from the stride-12 particle data;
//    textured particles sample a 4x4 texel window (cutout), layer 255 particles are procedural pixel art
//    (smoke puff, explosion ball, splash droplet, bubble ring, torch flame, lava pop, drip, underwater
//    speck), also cutout -> no sorting and no blending needed.
import { GLSL_LIGHT, createProgram } from './shaders.js';
import {
  BLOCKS, ITEMS, ITEM, FACE_LAYERS, FACE_ROTATION, RENDER_TYPE, RENDER, RENDER_LAYER, LAYER, TINT_TYPE,
  TEXTURE_LAYER_COUNT, TEXTURE_INDEX, itemForBlock,
} from '../world/registry.js';
import { DEFAULT_TINTS } from '../config.js';
import { mat4Perspective } from '../util/math.js';
import {
  MODEL_DEFS, MODEL_ID, SKIN_LAYERS, SKIN, FIRE_FRAMES, paintMobSkins, paintFireFrames, buildPartGeometry,
  buildArrowGeometry, buildFireQuad, computeModelPose, bowPower, fireSheetCount,
} from './mobmodels.js';

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

const VERTEX_FLOATS = 9;            // pos.xyz, normal.xyz, u, v (texels), face slot
const VERTEX_BYTES = VERTEX_FLOATS * 4;
const INSTANCE_FLOATS = 16;         // 3 x vec4 matrix rows + uvec4 info
const INSTANCE_BYTES = INSTANCE_FLOATS * 4;
const PARTICLE_FLOATS = 12;
const PARTICLE_BYTES = PARTICLE_FLOATS * 4;
const SHADOW_FLOATS = 6;            // camera-relative xyz, radius, alpha, packed light

const HAND_FOV = 70 * DEG;
const HAND_NEAR = 0.01;
const HAND_FAR = 100;

/** Alpha modes of an instance (shader rule). */
export const MODE = Object.freeze({ OPAQUE: 0, CUTOUT: 1, TRANSLUCENT: 2 });

// fixed models, then the skinned models (skin texture array): every part of every MODEL_DEFS entry (base
// parts, then overlay parts; the arrow is one model), then the two flame sheets (plain, mirrored)
const M_CUBE = 0;
const M_CACTUS = 1;
const M_CROSS = 2;
const M_TORCH = 3;
const M_SKIN0 = 4;
/** First skinned model of each model definition (relative to M_SKIN0), its base / overlay part counts. */
const DEF_FIRST = new Int16Array(MODEL_DEFS.length);
const DEF_PARTS = new Int16Array(MODEL_DEFS.length);
const DEF_OVERLAY = new Int16Array(MODEL_DEFS.length);
/** Flame sheets of a burning entity of each model (renderFlame stack for its bounding box). */
const DEF_FIRE = new Int16Array(MODEL_DEFS.length);
let skinModelCount = 0;
for (const d of MODEL_DEFS) {
  DEF_FIRE[d.id] = d.bbox && d.anim !== 'arrow' ? fireSheetCount(d.bbox[0], d.bbox[1]) : 0;
  DEF_FIRST[d.id] = skinModelCount;
  DEF_PARTS[d.id] = d.anim === 'arrow' ? 1 : d.parts.length;
  DEF_OVERLAY[d.id] = d.overlay ? d.overlay.parts.length : 0;
  skinModelCount += DEF_PARTS[d.id] + DEF_OVERLAY[d.id];
}
const FIRE_MODEL = skinModelCount;          // + 1: mirrored sheet
skinModelCount += 2;
const SKIN_MODEL_COUNT = skinModelCount;
const DEF_PLAYER = MODEL_ID.player;
const DEF_ARROW = MODEL_ID.arrow;
// the 6 player parts (head, body, right arm, left arm, right leg, left leg)
const M_PART0 = M_SKIN0 + DEF_FIRST[DEF_PLAYER];
const M_ARM = M_PART0 + 2;
// draw slots (one instanced draw each): fixed models, blended cubes, one per skinned model (skin texture), then
// one per sprite layer
const SLOT_CUBE = 0;
const SLOT_CACTUS = 1;
const SLOT_CROSS = 2;
const SLOT_TORCH = 3;
const SLOT_BLEND = 4;
const SLOT_SKIN0 = 5;
const SLOT_PART0 = SLOT_SKIN0 + DEF_FIRST[DEF_PLAYER];
const SLOT_FIRE = SLOT_SKIN0 + FIRE_MODEL;
const SLOT_SPRITE0 = SLOT_SKIN0 + SKIN_MODEL_COUNT;
const SLOT_COUNT = SLOT_SPRITE0 + 256;
const SLOT_MODEL = new Int16Array(SLOT_SPRITE0);
SLOT_MODEL.set([M_CUBE, M_CACTUS, M_CROSS, M_TORCH, M_CUBE]);
for (let k = 0; k < SKIN_MODEL_COUNT; k++) SLOT_MODEL[SLOT_SKIN0 + k] = M_SKIN0 + k;

// player model (Minecraft PlayerRenderer: 15/16 scale, rendered 1.501 down in flipped model space)
const PLAYER_SCALE = 0.9375;
const FLASH_RED = 1 << 8;          // instance light word flag: the flash colour is red (hurt overlay)
const EMISSIVE_BIT = 1 << 24;      // instance info word 1 flag: skin texels with alpha < 0.99 are full-bright
const HURT_FLASH = Math.round(0.3 * 255);   // OverlayTexture red rows: mix(red, colour, 0.7)
const FLEECE_WHITE = (230 | (230 << 8) | (230 << 16)) >>> 0;   // Sheep.createSheepColor(WHITE) = 0.9019608
const BOW_ID = ITEM.BOW ?? -1;
const BOW_PULLING = ['bow_pulling_0', 'bow_pulling_1', 'bow_pulling_2'].map((n) => TEXTURE_INDEX.get(n) ?? -1);
const ARROW_SCALE = 0.05625;       // ArrowRenderer

// per-item render kinds
const K_NONE = 0;
const K_CUBE = 1;
const K_SPRITE = 2;

// Minecraft display transforms
const GROUND_BLOCK_SCALE = 0.25, GROUND_BLOCK_UP = 3 / 16;
const GROUND_SPRITE_SCALE = 0.5, GROUND_SPRITE_UP = 2 / 16;
const SPRITE_COPY_STEP = 0.09375 * GROUND_SPRITE_SCALE;   // ItemEntityRenderer: 1.5 px between sprite copies
const MAX_COPIES = 5;                                     // renderAmount() maximum

// Angles used as call arguments are module constants: passing a preexisting number never allocates, while a
// fractional value computed on the spot is boxed by V8 whenever the callee is not inlined.
const R_M90 = -90 * DEG, R_180 = 180 * DEG, R_45 = 45 * DEG, R_M45 = -45 * DEG, R_25 = 25 * DEG, R_55 = 55 * DEG;
const R_75 = 75 * DEG, R_120 = 120 * DEG, R_200 = 200 * DEG, R_M135 = -135 * DEG;
const R_M80 = -80 * DEG, R_260 = 260 * DEG, R_M40 = -40 * DEG, R_90 = 90 * DEG;
const R_10 = 10 * DEG, R_30 = 30 * DEG;
const R_BOW_X = -13.935 * DEG, R_BOW_Y = 35.3 * DEG, R_BOW_Z = -9.785 * DEG;

// ===================================================================================================
// Model geometry (pure; exported for tests)
// ===================================================================================================

// Face frames identical to the mesher (src/world/mesher.js): normal axis/sign, texture U/V axes/signs and
// the full face's (u=0, v=0) corner in px. Vertex order TL, BL, BR, TR = counter-clockwise from outside.
const FACE_FRAMES = [
  { na: 0, ns: 1, ua: 2, us: -1, va: 1, vs: -1, o: [16, 16, 16] },
  { na: 0, ns: -1, ua: 2, us: 1, va: 1, vs: -1, o: [0, 16, 0] },
  { na: 1, ns: 1, ua: 0, us: 1, va: 2, vs: 1, o: [0, 16, 0] },
  { na: 1, ns: -1, ua: 0, us: 1, va: 2, vs: -1, o: [0, 0, 16] },
  { na: 2, ns: 1, ua: 0, us: 1, va: 1, vs: -1, o: [0, 16, 16] },
  { na: 2, ns: -1, ua: 0, us: -1, va: 1, vs: -1, o: [16, 16, 0] },
];
const QUAD_TV = [[0, 0], [0, 1], [1, 1], [1, 0]];
const FACE_NORMALS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
// SEL[f][k][axis]: whether corner k of face f sits at the max (1) or min (0) side of a box.
const SEL = FACE_FRAMES.map((F) => QUAD_TV.map(([tu, tv]) => {
  const p = [0, 0, 0];
  p[F.na] = F.ns > 0 ? 16 : 0;
  p[F.ua] = F.o[F.ua] + tu * 16 * F.us;
  p[F.va] = F.o[F.va] + tv * 16 * F.vs;
  return p.map((c) => (c ? 1 : 0));
}));

/** Push one quad (4 corners, CCW from outside) as two triangles into `out` (plain array). */
function pushQuad(out, ps, uvs, normal, face) {
  for (const k of [0, 1, 2, 0, 2, 3]) {
    const p = ps[k], t = uvs[k];
    out.push(p[0], p[1], p[2], normal[0], normal[1], normal[2], t[0], t[1], face);
  }
}

/**
 * Face f of the box [x0,x1]x[y0,y1]x[z0,z1] given in px (block-local, 0..16), positions converted to the
 * centred model space (px / 16 - 0.5). UVs use the mesher's planar mapping of the full face (+du, dv).
 */
function boxFace(out, f, x0, y0, z0, x1, y1, z1, { du = 0, dv = 0, shaded = true, slot = f } = {}) {
  const F = FACE_FRAMES[f];
  const ps = [], uvs = [];
  for (let k = 0; k < 4; k++) {
    const s = SEL[f][k];
    const P = [s[0] ? x1 : x0, s[1] ? y1 : y0, s[2] ? z1 : z0];
    ps.push([P[0] / 16 - 0.5, P[1] / 16 - 0.5, P[2] / 16 - 0.5]);
    uvs.push([(P[F.ua] - F.o[F.ua]) * F.us + du, (P[F.va] - F.o[F.va]) * F.vs + dv]);
  }
  pushQuad(out, ps, uvs, shaded ? FACE_NORMALS[f] : [0, 0, 0], slot);
}

/** Unit cube centred on the origin, per-face slots 0..5 (instance face layers), mesher UVs. */
export function buildCubeModel() {
  const out = [];
  for (let f = 0; f < 6; f++) boxFace(out, f, 0, 0, 0, 16, 16, 16);
  return out;
}

/** Cactus: 14/16 wide box (texels 1..15), like the mesher. */
export function buildCactusModel() {
  const out = [];
  for (let f = 0; f < 6; f++) boxFace(out, f, 1, 0, 1, 15, 16, 15);
  return out;
}

/** Torch post: 2x10 px (u 7..9, v 6..16; top v 6..8; bottom v 13..15), unshaded like the mesher. */
export function buildTorchModel() {
  const out = [];
  for (let f = 0; f < 6; f++) {
    const dv = f === 2 ? -1 : f === 3 ? 6 : 0;
    boxFace(out, f, 7, 0, 7, 9, 10, 9, { dv, shaded: false });
  }
  return out;
}

/** Cross plant: two diagonal double-sided planes from 2/16 to 14/16 (mesher CROSS_VERTS), slot 6. */
export function buildCrossModel() {
  const A = 2, B = 14;
  const quads = [
    [[B, 16, B, 0, 0], [B, 0, B, 0, 16], [A, 0, A, 16, 16], [A, 16, A, 16, 0]],
    [[A, 16, A, 0, 0], [A, 0, A, 0, 16], [B, 0, B, 16, 16], [B, 16, B, 16, 0]],
    [[A, 16, B, 0, 0], [A, 0, B, 0, 16], [B, 0, A, 16, 16], [B, 16, A, 16, 0]],
    [[B, 16, A, 0, 0], [B, 0, A, 0, 16], [A, 0, B, 16, 16], [A, 16, B, 16, 0]],
  ];
  const out = [];
  for (const q of quads) {
    pushQuad(out, q.map((v) => [v[0] / 16 - 0.5, v[1] / 16 - 0.5, v[2] / 16 - 0.5]), q.map((v) => [v[3], v[4]]), [0, 0, 0], 6);
  }
  return out;
}

/**
 * Minecraft ModelPart cube: box (x, y, z) size (w, h, d) in px of Minecraft model space (+Y down) with the
 * classic box UV layout at texture offset (u0, v0) of a `texSize`² skin. UVs are stored in 1/16 of the
 * texture (the mesh shader multiplies texel coordinates by 1/16), positions stay in px (the pose chain
 * scales by 1/16). Faces are counter-clockwise from outside, face slot 6 (instance layer 0).
 */
export function buildBoxModel(x, y, z, w, h, d, u0, v0, texSize = 64) {
  const x0 = x, x1 = x + w, y0 = y, y1 = y + h, z0 = z, z1 = z + d;
  const v = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  const f4 = u0, f5 = u0 + d, f6 = u0 + d + w, f7 = u0 + d + w + w, f8 = u0 + d + w + d, f9 = u0 + d + w + d + w;
  const f10 = v0, f11 = v0 + d, f12 = v0 + d + h;
  // [vertex indices], u1, v1, u2, v2, normal  (ModelPart.Polygon: v[0]->(u2,v1) v[1]->(u1,v1) v[2]->(u1,v2) v[3]->(u2,v2))
  const polys = [
    [[5, 4, 0, 1], f5, f10, f6, f11, [0, -1, 0]],   // DOWN (-Y in model space: the top of a standing part)
    [[2, 3, 7, 6], f6, f11, f7, f10, [0, 1, 0]],    // UP
    [[0, 4, 7, 3], f4, f11, f5, f12, [-1, 0, 0]],   // WEST
    [[1, 0, 3, 2], f5, f11, f6, f12, [0, 0, -1]],   // NORTH (front)
    [[5, 1, 2, 6], f6, f11, f8, f12, [1, 0, 0]],    // EAST
    [[4, 5, 6, 7], f8, f11, f9, f12, [0, 0, 1]],    // SOUTH (back)
  ];
  const k = 16 / texSize;
  const out = [];
  for (const [idx, u1, v1, u2, v2, n] of polys) {
    let ps = idx.map((i) => v[i]);
    let uvs = [[u2 * k, v1 * k], [u1 * k, v1 * k], [u1 * k, v2 * k], [u2 * k, v2 * k]];
    // keep counter-clockwise-from-outside winding (verified, but cheap to guarantee)
    const e1 = [ps[1][0] - ps[0][0], ps[1][1] - ps[0][1], ps[1][2] - ps[0][2]];
    const e2 = [ps[2][0] - ps[0][0], ps[2][1] - ps[0][1], ps[2][2] - ps[0][2]];
    const c = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    if (c[0] * n[0] + c[1] * n[1] + c[2] * n[2] < 0) { ps = ps.slice().reverse(); uvs = uvs.slice().reverse(); }
    pushQuad(out, ps, uvs, n, 6);
  }
  return out;
}

/**
 * Minecraft PlayerModel (wide arms) parts: [box x, y, z, w, h, d, skin u, v] in px, Minecraft model space.
 * Order: head, body, right arm, left arm, right leg, left leg.
 */
export const PLAYER_PARTS = Object.freeze([
  [-4, -8, -4, 8, 8, 8, 0, 0],
  [-4, 0, -2, 8, 12, 4, 16, 16],
  [-3, -2, -2, 4, 12, 4, 40, 16],
  [-1, -2, -2, 4, 12, 4, 32, 48],
  [-2, 0, -2, 4, 12, 4, 0, 16],
  [-2, 0, -2, 4, 12, 4, 16, 48],
]);

/** The player's right arm (first-person hand) — skin region (40, 16). */
export function buildArmModel() {
  return buildBoxModel(...PLAYER_PARTS[2]);
}

/**
 * Steve skin, 64x64 RGBA, classic layout (head, body, arms, legs; overlay layers empty). Same palette and
 * design as the inventory preview (src/ui/assets.js paintSkin), so the third-person model, the first-person
 * arm and the GUI player match.
 */
export function paintSkinTexture() {
  const S = 64;
  const px = new Uint8Array(S * S * 4);
  let s = 0x2545f491;
  const rnd = () => {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
  const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const SKIN = hex('#C68E68'), SKIN_D = hex('#A9724F'), HAIR = hex('#3B2615'), HAIR_L = hex('#4E331D');
  const SHIRT = hex('#16A3A8'), SHIRT_D = hex('#0E8287'), PANTS = hex('#3439A3'), PANTS_D = hex('#262A82');
  const SHOE = hex('#6B6B6B'), WHITE_C = hex('#FFFFFF'), EYE = hex('#3E4FA8'), NOSE = hex('#8E5B3E'), MOUTH = hex('#6C4129');
  const set = (x, y, c, n = 10) => {
    const k = (rnd() - 0.5) * n;
    const o = (y * S + x) * 4;
    px[o] = Math.max(0, Math.min(255, Math.round(c[0] + k)));
    px[o + 1] = Math.max(0, Math.min(255, Math.round(c[1] + k)));
    px[o + 2] = Math.max(0, Math.min(255, Math.round(c[2] + k)));
    px[o + 3] = 255;
  };
  const fill = (x, y, w, h, c, n) => { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) set(x + i, y + j, c, n); };
  // head (8x8x8 at 0,0)
  fill(8, 0, 8, 8, HAIR, 14);            // top
  fill(16, 0, 8, 8, SKIN_D, 8);          // bottom (chin)
  fill(0, 8, 32, 8, SKIN, 10);           // sides + front + back
  fill(24, 8, 8, 8, HAIR, 12);           // back of the head: hair
  fill(0, 8, 8, 2, HAIR, 12);            // right side hair
  fill(16, 8, 8, 2, HAIR, 12);           // left side hair
  fill(0, 10, 5, 3, HAIR, 12);           // hair over the back half of the sides
  fill(19, 10, 5, 3, HAIR, 12);
  fill(6, 10, 1, 2, HAIR_L, 8);          // sideburns
  fill(17, 10, 1, 2, HAIR_L, 8);
  // face (front at 8,8)
  fill(8, 8, 8, 2, HAIR, 12);
  set(8, 10, HAIR_L); set(15, 10, HAIR_L);
  set(9, 12, WHITE_C, 0); set(10, 12, EYE, 0); set(13, 12, EYE, 0); set(14, 12, WHITE_C, 0);
  set(11, 13, NOSE, 0); set(12, 13, NOSE, 0);
  for (let x = 10; x <= 13; x++) set(x, 14, MOUTH, 0);
  set(9, 14, SKIN_D); set(14, 14, SKIN_D);
  for (let x = 9; x <= 14; x++) set(x, 15, SKIN_D, 6);
  // body (8x12x4 at 16,16)
  fill(20, 16, 8, 4, SHIRT, 12);         // top
  fill(28, 16, 8, 4, SHIRT_D, 10);       // bottom
  fill(16, 20, 24, 12, SHIRT, 12);       // sides + front + back
  for (let x = 22; x <= 25; x++) set(x, 20, SKIN, 6);   // collar
  set(23, 21, SKIN, 6); set(24, 21, SKIN, 6);
  fill(16, 30, 24, 2, SHIRT_D, 8);       // hem
  // arms (4x12x4 at 40,16 and 32,48)
  for (const [ux, uy] of [[40, 16], [32, 48]]) {
    fill(ux + 4, uy, 4, 4, SHIRT, 10);   // top (shoulder)
    fill(ux + 8, uy, 4, 4, SKIN_D, 8);   // bottom (hand)
    fill(ux, uy + 4, 16, 12, SKIN, 10);  // four sides
    fill(ux, uy + 4, 16, 4, SHIRT, 12);  // sleeves
    fill(ux, uy + 8, 16, 1, SHIRT_D, 8);
    for (let x = ux; x < ux + 16; x++) set(x, uy + 15, SKIN_D, 8);   // knuckles
  }
  // legs (4x12x4 at 0,16 and 16,48)
  for (const [ux, uy] of [[0, 16], [16, 48]]) {
    fill(ux + 4, uy, 4, 4, PANTS, 10);
    fill(ux + 8, uy, 4, 4, SHOE, 8);
    fill(ux, uy + 4, 16, 12, PANTS, 12);
    fill(ux, uy + 4, 16, 1, PANTS_D, 8);
    fill(ux, uy + 13, 16, 3, SHOE, 10);
  }
  return px;
}

/**
 * Extruded item model (Minecraft ItemModelGenerator) from a 16x16 alpha mask (row 0 = top of the
 * picture). Model space: x, y in [-0.5, 0.5] with u -> +x and v -> -y, 1/16 thick around z = 0. Front
 * (+Z) and back (-Z) quads cover the sprite (the shader discards transparent texels); every maximal run
 * of opaque texels bordering transparency (or the sprite edge) gets one edge quad sampling those texels.
 * @param {ArrayLike<number>|null} alpha 256 alpha values; null = fully opaque square
 * @returns {number[]} triangle vertices, VERTEX_FLOATS each, face slot 6
 */
export function buildSpriteModel(alpha, threshold = 128) {
  const solid = (c, r) => c >= 0 && c < 16 && r >= 0 && r < 16 && (!alpha || alpha[r * 16 + c] >= threshold);
  const out = [];
  const h = 0.5 / 16;
  const X = (c) => c / 16 - 0.5;
  const Y = (r) => 0.5 - r / 16;
  // front / back
  pushQuad(out, [[-0.5, 0.5, h], [-0.5, -0.5, h], [0.5, -0.5, h], [0.5, 0.5, h]], [[0, 0], [0, 16], [16, 16], [16, 0]], [0, 0, 1], 6);
  pushQuad(out, [[0.5, 0.5, -h], [0.5, -0.5, -h], [-0.5, -0.5, -h], [-0.5, 0.5, -h]], [[16, 0], [16, 16], [0, 16], [0, 0]], [0, 0, -1], 6);
  // horizontal edges (up / down) per row
  for (let r = 0; r < 16; r++) {
    for (const [dr, up] of [[-1, true], [1, false]]) {
      let c = 0;
      while (c < 16) {
        if (!(solid(c, r) && !solid(c, r + dr))) { c++; continue; }
        const c0 = c;
        while (c < 16 && solid(c, r) && !solid(c, r + dr)) c++;
        const y = up ? Y(r) : Y(r + 1);
        const xa = X(c0), xb = X(c);
        const v = r + 0.5;
        if (up) {
          pushQuad(out, [[xa, y, -h], [xa, y, h], [xb, y, h], [xb, y, -h]], [[c0, v], [c0, v], [c, v], [c, v]], [0, 1, 0], 6);
        } else {
          pushQuad(out, [[xa, y, h], [xa, y, -h], [xb, y, -h], [xb, y, h]], [[c0, v], [c0, v], [c, v], [c, v]], [0, -1, 0], 6);
        }
      }
    }
  }
  // vertical edges (left / right) per column
  for (let c = 0; c < 16; c++) {
    for (const [dc, left] of [[-1, true], [1, false]]) {
      let r = 0;
      while (r < 16) {
        if (!(solid(c, r) && !solid(c + dc, r))) { r++; continue; }
        const r0 = r;
        while (r < 16 && solid(c, r) && !solid(c + dc, r)) r++;
        const x = left ? X(c) : X(c + 1);
        const ya = Y(r0), yb = Y(r);
        const u = c + 0.5;
        if (left) {
          pushQuad(out, [[x, ya, -h], [x, yb, -h], [x, yb, h], [x, ya, h]], [[u, r0], [u, r], [u, r], [u, r0]], [-1, 0, 0], 6);
        } else {
          pushQuad(out, [[x, ya, h], [x, yb, h], [x, yb, -h], [x, ya, -h]], [[u, r0], [u, r], [u, r], [u, r0]], [1, 0, 0], 6);
        }
      }
    }
  }
  return out;
}

// ===================================================================================================
// 3x4 affine matrices (row-major rows [r0 r1 r2 t]); every op post-multiplies like a PoseStack.
// ===================================================================================================

function aIdentity(m) {
  m[0] = 1; m[1] = 0; m[2] = 0; m[3] = 0;
  m[4] = 0; m[5] = 1; m[6] = 0; m[7] = 0;
  m[8] = 0; m[9] = 0; m[10] = 1; m[11] = 0;
  return m;
}
function aCopy(out, m) {
  for (let i = 0; i < 12; i++) out[i] = m[i];
  return out;
}
function aTranslate(m, x, y, z) {
  m[3] += m[0] * x + m[1] * y + m[2] * z;
  m[7] += m[4] * x + m[5] * y + m[6] * z;
  m[11] += m[8] * x + m[9] * y + m[10] * z;
  return m;
}
function aRotX(m, a) {
  if (a === 0) return m;
  const c = Math.cos(a), s = Math.sin(a);
  for (let r = 0; r < 12; r += 4) {
    const m1 = m[r + 1], m2 = m[r + 2];
    m[r + 1] = m1 * c + m2 * s;
    m[r + 2] = m2 * c - m1 * s;
  }
  return m;
}
function aRotY(m, a) {
  if (a === 0) return m;
  const c = Math.cos(a), s = Math.sin(a);
  for (let r = 0; r < 12; r += 4) {
    const m0 = m[r], m2 = m[r + 2];
    m[r] = m0 * c - m2 * s;
    m[r + 2] = m0 * s + m2 * c;
  }
  return m;
}
function aRotZ(m, a) {
  if (a === 0) return m;
  const c = Math.cos(a), s = Math.sin(a);
  for (let r = 0; r < 12; r += 4) {
    const m0 = m[r], m1 = m[r + 1];
    m[r] = m0 * c + m1 * s;
    m[r + 1] = m1 * c - m0 * s;
  }
  return m;
}
function aScale(m, x, y = x, z = x) {
  for (let r = 0; r < 12; r += 4) {
    m[r] *= x; m[r + 1] *= y; m[r + 2] *= z;
  }
  return m;
}

/** Ticks the bow of HandState `hand` has been drawn (useTime s, else useProgress 0..1 of the 1 s full draw). */
export function handUseTicks(hand) {
  const t = +hand.useTime;
  if (Number.isFinite(t) && t >= 0) return t * 20;
  const p = +hand.useProgress;
  return Number.isFinite(p) ? Math.min(1, Math.max(0, p)) * 20 : 0;
}

/**
 * Minecraft first-person pose (view space) for HandState `hand`, written into `m` (3x4). Returns the model
 * to draw: 'arm' (Minecraft model space px), 'block' or 'sprite' (centred unit models), or null.
 * `hand.useAction` 'eat' (applyEatTransform: the food bobs at the mouth) and 'bow' (the drawn bow, pull from
 * useTime / useProgress) replace the swing transforms like ItemInHandRenderer.renderArmWithItem.
 * Exported for tests.
 */
export function computeHandPose(m, hand, kind) {
  aIdentity(m);
  const bx = +hand.bobX || 0, by = +hand.bobY || 0;
  if (bx || by) aTranslate(m, bx, by, 0);
  aRotZ(m, -(+hand.bobRoll || 0));
  aRotX(m, -(+hand.bobPitch || 0));
  aRotX(m, -(+hand.swayPitch || 0));
  aRotY(m, -(+hand.swayYaw || 0));
  const swing = Math.min(1, Math.max(0, +hand.swing || 0));
  const eq = 1 - Math.min(1, Math.max(0, Number.isFinite(+hand.equip) ? +hand.equip : 1));
  const sq = Math.sqrt(swing);
  if (kind === 'arm') {
    // ItemInHandRenderer.renderPlayerArm (right arm)
    aTranslate(m, -0.3 * Math.sin(sq * Math.PI) + 0.64000005, 0.4 * Math.sin(sq * TAU) - 0.6 - eq * 0.6,
      -0.4 * Math.sin(swing * Math.PI) - 0.71999997);
    aRotY(m, R_45);
    aRotY(m, Math.sin(sq * Math.PI) * 70 * DEG);
    aRotZ(m, Math.sin(swing * swing * Math.PI) * -20 * DEG);
    aTranslate(m, -1, 3.6, 3.5);
    aRotZ(m, R_120);
    aRotX(m, R_200);
    aRotY(m, R_M135);
    aTranslate(m, 5.6, 0, 0);
    // PlayerModel right arm part: pivot (-5, 2, 0) px, zRot 0.1 (bobModelPart at age 0), px -> blocks
    aTranslate(m, -5 / 16, 2 / 16, 0);
    aRotZ(m, 0.1);
    aScale(m, 1 / 16);
    return 'arm';
  }
  const use = hand.useAction;
  if (use === 'eat') {
    // applyEatTransform (use duration 32 ticks), then applyItemArmTransform; no swing while using
    const p = Math.min(1, Math.max(0, +hand.useProgress || 0));
    const f1 = 1 - p;                       // remaining ticks / use duration
    const f = f1 * 32;
    if (f1 < 0.8) aTranslate(m, 0, Math.abs(Math.cos(f / 4 * Math.PI) * 0.1), 0);
    const f3 = 1 - Math.pow(f1, 27);
    aTranslate(m, f3 * 0.6, f3 * -0.5, 0);
    aRotY(m, f3 * R_90);
    aRotX(m, f3 * R_10);
    aRotZ(m, f3 * R_30);
    aTranslate(m, 0.56, -0.52 - eq * 0.6, -0.72);
  } else if (use === 'bow') {
    // UseAnim.BOW: applyItemArmTransform, the drawn-bow offset, pull (+ the full-draw tremble), stretch
    aTranslate(m, 0.56, -0.52 - eq * 0.6, -0.72);
    aTranslate(m, -0.2785682, 0.18344387, 0.15731531);
    aRotX(m, R_BOW_X);
    aRotY(m, R_BOW_Y);
    aRotZ(m, R_BOW_Z);
    const ticks = handUseTicks(hand);
    const pull = bowPower(ticks);
    if (pull > 0.1) aTranslate(m, 0, Math.sin((ticks - 0.1) * 1.3) * (pull - 0.1) * 0.004, 0);
    aTranslate(m, 0, 0, pull * 0.04);
    aScale(m, 1, 1, 1 + pull * 0.2);
    aRotY(m, R_M45);
  } else {
    // renderArmWithItem: swing offset, applyItemArmTransform, applyItemArmAttackTransform
    aTranslate(m, -0.4 * Math.sin(sq * Math.PI), 0.2 * Math.sin(sq * TAU), -0.2 * Math.sin(swing * Math.PI));
    aTranslate(m, 0.56, -0.52 - eq * 0.6, -0.72);
    aRotY(m, (45 + Math.sin(swing * swing * Math.PI) * -20) * DEG);
    const f1 = Math.sin(sq * Math.PI);
    aRotZ(m, f1 * -20 * DEG);
    aRotX(m, f1 * -80 * DEG);
    aRotY(m, R_M45);
  }
  if (kind === 'block') {
    // block.json firstperson_righthand: rotation [0, 45, 0], scale 0.4
    aRotY(m, R_45);
    aScale(m, 0.4);
    return 'block';
  }
  // item/generated + handheld firstperson_righthand: translation [1.13, 3.2, 1.13] px, rotation
  // [0, -90, 25] (quaternion = Rx·Ry·Rz), scale 0.68
  aTranslate(m, 1.13 / 16, 3.2 / 16, 1.13 / 16);
  aRotY(m, R_M90);
  aRotZ(m, R_25);
  aScale(m, 0.68);
  return 'sprite';
}

/**
 * Minecraft "thirdperson_righthand" display transforms (block.json, item/handheld.json, item/bow.json,
 * item/generated.json): translate, rotationXYZ, scale. Exported for tests.
 */
export function thirdPersonTransform(m, kind) {
  if (kind === 'bow') {
    aTranslate(m, -1 / 16, -2 / 16, 2.5 / 16);
    aRotX(m, R_M80);
    aRotY(m, R_260);
    aRotZ(m, R_M40);
    aScale(m, 0.9);
  } else if (kind === 'block') {
    aTranslate(m, 0, 2.5 / 16, 0);
    aRotX(m, R_75);
    aRotY(m, R_45);
    aScale(m, 0.375);
  } else if (kind === 'handheld') {
    aTranslate(m, 0, 4 / 16, 0.5 / 16);
    aRotY(m, R_M90);
    aRotZ(m, R_55);
    aScale(m, 0.85);
  } else {
    aTranslate(m, 0, 3 / 16, 1 / 16);
    aScale(m, 0.55);
  }
}

const _poseBase = new Float64Array(12);
const _poseTmp = new Float64Array(12);
const _poseRot = new Float64Array(6 * 3);
const _posePivot = new Float64Array(6 * 3);

/**
 * Minecraft player model pose for a 'model' EntityRenderItem (LivingEntityRenderer + PlayerRenderer +
 * HumanoidModel.setupAnim: walk cycle, head look, item-holding arm, attack swing, crouch, idle arm sway,
 * death tip-over). Writes 6 part matrices (head, body, right arm, left arm, right leg, left leg; 3x4 each,
 * for px-space part models) into `parts` and the held item's matrix into `held` (if given) using the
 * third-person display transform `heldKind` ('block' | 'handheld' | 'sprite'). (rx, ry, rz) = position
 * relative to the camera. Exported for tests.
 */
export function computePlayerPose(r, rx, ry, rz, parts, held = null, heldKind = 'sprite') {
  // All matrix math is written out (no helper calls with computed arguments): this runs per model per frame
  // and must not allocate (V8 boxes fractional arguments of calls it does not inline).
  const crouch = !!r.sneaking;
  // ---- base = T(rel + crouch offset) · Ry(bodyYaw) · Rz(flip) · S(-k, -k, k) · T(0, -1.501, 0) ----
  // PlayerRenderer.getRenderOffset, LivingEntityRenderer.setupRotations (rotY(180 - yBodyRot) in SPEC yaw,
  // getFlipDegrees for the death tip-over), scale(-1, -1, 1) with the player's 15/16, translate(0, -1.501, 0)
  const yaw = +r.bodyYaw || 0;
  const cyw = Math.cos(yaw), syw = Math.sin(yaw);
  let cf = 1, sf = 0;
  const deathTicks = (+r.death || 0) * 20;
  if (deathTicks > 0) {
    const flip = Math.min(1, Math.sqrt(Math.max(0, (deathTicks - 1) / 20 * 1.6))) * 90 * DEG;
    cf = Math.cos(flip);
    sf = Math.sin(flip);
  }
  const k = PLAYER_SCALE;
  const B = _poseBase;
  B[0] = -k * cyw * cf; B[1] = k * cyw * sf;   B[2] = k * syw;
  B[4] = -k * sf;       B[5] = -k * cf;        B[6] = 0;
  B[8] = k * syw * cf;  B[9] = -k * syw * sf;  B[10] = k * cyw;
  B[3] = rx - 1.501 * B[1];
  B[7] = ry + (crouch ? -0.125 : 0) - 1.501 * B[5];
  B[11] = rz - 1.501 * B[9];

  // ---- HumanoidModel.setupAnim ----
  const limb = +r.limbSwing || 0;
  const amt = Math.min(1, Math.max(0, +r.limbSwingAmount || 0));
  const age = (+r.age || 0) * 20;
  const headX = -(+r.headPitch || 0);                              // Minecraft pitch: + = down
  let headY = (yaw - (+r.headYaw || 0) + Math.PI) % TAU;           // netHeadYaw, wrapped to [-pi, pi)
  if (headY < 0) headY += TAU;
  headY -= Math.PI;
  let rArmX = Math.cos(limb * 0.6662 + Math.PI) * amt;
  let lArmX = Math.cos(limb * 0.6662) * amt;
  let rArmY = 0, lArmY = 0, rArmZ = 0, lArmZ = 0;
  const rLegX = Math.cos(limb * 0.6662) * 1.4 * amt;
  const lLegX = Math.cos(limb * 0.6662 + Math.PI) * 1.4 * amt;
  const headY0 = headY;
  if ((r.itemId | 0) === BOW_ID && r.aggressive) {
    // ArmPose.BOW_AND_ARROW while drawing a bow (the avatar sets aggressive)
    rArmY = -0.1 + headY0; lArmY = 0.1 + headY0 + 0.4;
    rArmX = -Math.PI / 2 + headX; lArmX = -Math.PI / 2 + headX;
  } else if ((r.itemId | 0) > 0) {
    rArmX = rArmX * 0.5 - Math.PI / 10;     // ArmPose.ITEM
  }
  let bodyY = 0;
  let rArmPX = -5, rArmPZ = 0, lArmPX = 5, lArmPZ = 0;
  const att = Math.min(1, Math.max(0, +r.attack || 0));
  if (att > 0) {                                                   // setupAttackAnimation (right arm)
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
  let bodyX = 0, headPY = 0, bodyPY = 0, armPY = 2, legPY = 12, legPZ = 0.1;
  if (crouch) {
    bodyX = 0.5; rArmX += 0.4; lArmX += 0.4;
    legPZ = 4; legPY = 12.2; headPY = 4.2; bodyPY = 3.2; armPY = 5.2;
  }
  const swayZ = Math.cos(age * 0.09) * 0.05 + 0.05, swayX = Math.sin(age * 0.067) * 0.05;   // bobModelPart
  rArmZ += swayZ; rArmX += swayX; lArmZ -= swayZ; lArmX -= swayX;

  const P = _posePivot, R = _poseRot;
  P[0] = 0; P[1] = headPY; P[2] = 0;             R[0] = headX; R[1] = headY; R[2] = 0;
  P[3] = 0; P[4] = bodyPY; P[5] = 0;             R[3] = bodyX; R[4] = bodyY; R[5] = 0;
  P[6] = rArmPX; P[7] = armPY; P[8] = rArmPZ;    R[6] = rArmX; R[7] = rArmY; R[8] = rArmZ;
  P[9] = lArmPX; P[10] = armPY; P[11] = lArmPZ;  R[9] = lArmX; R[10] = lArmY; R[11] = lArmZ;
  P[12] = -1.9; P[13] = legPY; P[14] = legPZ;    R[12] = rLegX; R[13] = 0; R[14] = 0;
  P[15] = 1.9; P[16] = legPY; P[17] = legPZ;     R[15] = lLegX; R[16] = 0; R[17] = 0;
  const m = _poseTmp;
  for (let p = 0; p < 6; p++) {
    // ModelPart.translateAndRotate: base · T(pivot / 16) · Rz · Ry · Rx; the part geometry is in px (· 1/16)
    const ax = R[p * 3], ay = R[p * 3 + 1], az = R[p * 3 + 2];
    const cx = Math.cos(ax), sx = Math.sin(ax), cy = Math.cos(ay), sy = Math.sin(ay), cz = Math.cos(az), sz = Math.sin(az);
    const q00 = cz * cy, q01 = cz * sy * sx - sz * cx, q02 = cz * sy * cx + sz * sx;
    const q10 = sz * cy, q11 = sz * sy * sx + cz * cx, q12 = sz * sy * cx - cz * sx;
    const q20 = -sy, q21 = cy * sx, q22 = cy * cx;
    const px = P[p * 3] / 16, py = P[p * 3 + 1] / 16, pz = P[p * 3 + 2] / 16;
    for (let row = 0; row < 12; row += 4) {
      const b0 = B[row], b1 = B[row + 1], b2 = B[row + 2];
      m[row] = b0 * q00 + b1 * q10 + b2 * q20;
      m[row + 1] = b0 * q01 + b1 * q11 + b2 * q21;
      m[row + 2] = b0 * q02 + b1 * q12 + b2 * q22;
      m[row + 3] = B[row + 3] + b0 * px + b1 * py + b2 * pz;
    }
    if (p === 2 && held) {
      // ItemInHandLayer: translateToHand, rotX(-90), rotY(180), translate(1/16, 0.125, -0.625), display
      aCopy(held, m);
      aRotX(held, R_M90);
      aRotY(held, R_180);
      aTranslate(held, 1 / 16, 0.125, -0.625);
      thirdPersonTransform(held, heldKind);
    }
    const o = p * 12;
    for (let row = 0; row < 12; row += 4) {
      parts[o + row] = m[row] / 16;
      parts[o + row + 1] = m[row + 1] / 16;
      parts[o + row + 2] = m[row + 2] / 16;
      parts[o + row + 3] = m[row + 3];
    }
  }
}

/** Minecraft ItemEntityRenderer.getRenderAmount. */
export function renderAmount(count) {
  return count > 48 ? 5 : count > 32 ? 4 : count > 16 ? 3 : count > 1 ? 2 : 1;
}

// small deterministic hash -> [-1, 1) for stack copy offsets (Minecraft seeds by item id)
function hashSigned(a, b) {
  let x = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35);
  x ^= x >>> 15; x = Math.imul(x, 0x2c1b3c6d); x ^= x >>> 12; x = Math.imul(x, 0x297a2d39); x ^= x >>> 15;
  return ((x >>> 0) / 4294967296) * 2 - 1;
}

// ===================================================================================================
// Shaders
// ===================================================================================================

const HEADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2DArray;
`;

const MESH_VS = `${HEADER}
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec3 aUVF;      // u, v (texels), face slot (0..5 cube face, 6 = layer slot 0)
layout(location = 3) in vec4 aM0;       // model matrix rows; translation (w) is camera-relative
layout(location = 4) in vec4 aM1;
layout(location = 5) in vec4 aM2;
layout(location = 6) in uvec4 aInfo;    // x layers 0-3 | y layers 4-5, rot<<16, mode<<22, emissive<<24 | z tint, flash<<24 | w light, red<<8
uniform mat4 uViewProj;
out vec3 vUVL;
out vec3 vRel;
out vec3 vTint;
out vec2 vLight;
out float vShade;
out float vFlash;
flat out vec3 vFlashColor;
flat out uint vMode;
flat out uint vEmissive;
void main() {
  vec4 p = vec4(aPos, 1.0);
  vec3 rel = vec3(dot(aM0, p), dot(aM1, p), dot(aM2, p));
  vec3 n = vec3(dot(aM0.xyz, aNormal), dot(aM1.xyz, aNormal), dot(aM2.xyz, aNormal));
  float nl = dot(n, n);
  if (nl < 1e-10) {
    vShade = 0.9;                                  // unshaded geometry (FACE_SHADE[6])
  } else {
    n *= inversesqrt(nl);
    vec3 n2 = n * n;
    vShade = n2.x * 0.6 + n2.z * 0.8 + n2.y * (n.y > 0.0 ? 1.0 : 0.5);
  }
  uint face = uint(aUVF.z + 0.5);
  uint layer;
  if (face < 4u) layer = (aInfo.x >> (face * 8u)) & 255u;
  else if (face < 6u) layer = (aInfo.y >> ((face - 4u) * 8u)) & 255u;
  else layer = aInfo.x & 255u;
  vec2 uv = aUVF.xy;
  if (face < 6u && ((aInfo.y >> (16u + face)) & 1u) == 1u) uv = vec2(uv.y, 16.0 - uv.x);
  vUVL = vec3(uv * 0.0625, float(layer));
  vMode = (aInfo.y >> 22u) & 3u;
  vEmissive = (aInfo.y >> 24u) & 1u;
  vTint = vec3(uvec3(aInfo.z, aInfo.z >> 8u, aInfo.z >> 16u) & 255u) * (1.0 / 255.0);
  vFlash = float(aInfo.z >> 24u) * (1.0 / 255.0);
  vFlashColor = (aInfo.w & 256u) != 0u ? vec3(1.0, 0.0, 0.0) : vec3(1.0);   // hurt overlay is red
  uint l = aInfo.w & 255u;
  vLight = vec2(float(l >> 4u), float(l & 15u)) * (1.0 / 15.0);
  vRel = rel;
  gl_Position = uViewProj * vec4(rel, 1.0);
}`;

const MESH_FS = `${HEADER}
uniform sampler2DArray uTex;
uniform vec3 uFogColor;
uniform vec3 uFog;        // start, end, 1 / (end - start)
uniform float uDaylight;
uniform vec4 uSkyTint;     // rgb sky-light tint, a = brightness option (GLSL_LIGHT)
in vec3 vUVL;
in vec3 vRel;
in vec3 vTint;
in vec2 vLight;
in float vShade;
in float vFlash;
flat in vec3 vFlashColor;
flat in uint vMode;
flat in uint vEmissive;
out vec4 fragColor;
${GLSL_LIGHT}
void main() {
  vec4 t = texture(uTex, vUVL);
  // emissive skin texels (alpha 128..254: spider eyes, fire) ignore light and shading
  bool glow = vEmissive == 1u && t.a < 0.99;
  vec3 albedo;
  float alpha = 1.0;
  if (vMode == 0u) {
    albedo = t.rgb * mix(vTint, vec3(1.0), t.a);    // opaque / tint-mask rule
  } else {
    if (vMode == 1u && t.a < 0.5) discard;           // cutout
    if (vMode == 2u) {                               // translucent (blended draw)
      if (t.a < 0.004) discard;
      alpha = t.a;
    }
    albedo = t.rgb * vTint;
  }
  albedo = mix(albedo, vFlashColor, vFlash);
  vec3 col = glow ? albedo : albedo * lightColor(vLight.x, vLight.y, uDaylight, uSkyTint) * vShade;
  float fog = clamp((length(vRel) - uFog.x) * uFog.z, 0.0, 1.0);
  fragColor = vec4(mix(col, uFogColor, fog), alpha);
}`;

const PARTICLE_VS = `${HEADER}
layout(location = 0) in vec4 aPosSize;   // world xyz, size
layout(location = 1) in vec4 aTex;       // layer, u0, v0, uvSize
layout(location = 2) in vec4 aColor;     // r, g, b, packed light
uniform mat4 uViewProj;
uniform vec3 uCamHi;
uniform vec3 uCamLo;
uniform vec3 uRight;
uniform vec3 uUp;
out vec2 vUV;
out vec3 vRel;
out vec2 vLight;
flat out vec4 vTex;
flat out vec3 vColor;
const vec2 CORNERS[6] = vec2[6](vec2(-1.0, -1.0), vec2(1.0, -1.0), vec2(1.0, 1.0),
                                vec2(-1.0, -1.0), vec2(1.0, 1.0), vec2(-1.0, 1.0));
void main() {
  vec2 c = CORNERS[gl_VertexID];
  vec3 rel = (aPosSize.xyz - uCamHi) - uCamLo;
  rel += (uRight * c.x + uUp * c.y) * (aPosSize.w * 0.5);
  vUV = vec2(c.x, -c.y) * 0.5 + 0.5;
  vTex = aTex;
  vColor = aColor.rgb;
  float l = floor(aColor.w + 0.5);
  vLight = vec2(floor(l / 16.0), mod(l, 16.0)) * (1.0 / 15.0);
  vRel = rel;
  gl_Position = uViewProj * vec4(rel, 1.0);
}`;

const PARTICLE_FS = `${HEADER}
uniform sampler2DArray uTex;
uniform vec3 uFogColor;
uniform vec3 uFog;
uniform float uDaylight;
uniform vec4 uSkyTint;     // rgb sky-light tint, a = brightness option (GLSL_LIGHT)
in vec2 vUV;
in vec3 vRel;
in vec2 vLight;
flat in vec4 vTex;
flat in vec3 vColor;
out vec4 fragColor;
${GLSL_LIGHT}
float hash21(vec2 p) {
  uvec2 q = uvec2(ivec2(floor(p)) + 4096) * uvec2(1597334673u, 3812015801u);
  uint n = (q.x ^ q.y) * 1597334673u;
  return float(n >> 8u) * (1.0 / 16777216.0);
}
void main() {
  vec3 albedo;
  if (vTex.x < 254.5) {
    vec4 t = texture(uTex, vec3((vTex.yz + vUV * vTex.w) * 0.0625, vTex.x));
    if (t.a < 0.5) discard;
    albedo = t.rgb * vColor;
  } else {
    // procedural pixel art: style = u0, phase = v0 (0..1), seed = uvSize
    int style = int(vTex.y + 0.5);
    float phase = clamp(vTex.z, 0.0, 1.0);
    vec2 sd = vec2(floor(vTex.w * 251.0), floor(vTex.w * 653.0));
    float N = style == 1 ? 16.0 : (style == 2 || style == 7) ? 4.0 : 8.0;
    vec2 q = min(floor(vUV * N), vec2(N - 1.0));
    vec2 d = q + 0.5 - N * 0.5;                      // texel centre relative to the sprite centre
    float r = length(d);
    float hq = hash21(q + sd);
    float shade = 1.0;
    if (style == 0) {
      // smoke puff (Minecraft generic_7..0: a soft blob that shrinks over its life), lit from the top-left
      float R = mix(3.9, 1.3, phase) + (hq - 0.5) * 0.35;
      if (r > R) discard;
      if (r > R - 1.0) shade = d.x + d.y > 0.0 ? 0.84 : 1.08;
    } else if (style == 1) {
      // explosion ball: clumpy grey-white cloud that breaks up
      float R = 7.7 - phase * 1.6 + (hq - 0.5) * 1.2;
      if (r > R) discard;
      float blob = hash21(floor(q * 0.5) + sd + 17.0);
      if (hq < phase * phase * 1.1 - 0.05) discard;
      shade = 0.78 + blob * 0.3;
      if (r < R * 0.5) shade += 0.12;
      if (r > R - 1.5) shade -= 0.12;
      if (d.x + d.y < -R * 0.75) shade += 0.1;
      shade *= 1.0 - phase * 0.25;
    } else if (style == 2) {
      // splash droplet
      if (r > 1.6) discard;
      shade = (q.x < 1.5 && q.y < 1.5) ? 1.15 : 0.92;
    } else if (style == 3) {
      // bubble ring with a highlight
      bool ring = abs(r - 2.75) < 0.75;
      bool glint = q.x == 2.0 && q.y == 2.0;
      if (!ring && !glint) discard;
      shade = glint ? 1.25 : 0.95;
    } else if (style == 4) {
      // torch flame: pointed top, round bottom, white-yellow core, orange rim (flickers with the phase)
      float row = q.y;
      float flick = hash21(vec2(floor(phase * 6.0), 3.0) + sd) - 0.5;
      float hw = row < 1.5 ? 0.6 : row < 3.5 ? 1.6 : row < 6.5 ? 2.6 : 1.6;
      float dx = d.x - (row < 3.5 ? flick : 0.0);
      if (abs(dx) > hw || row < 0.5 && flick > 0.25) discard;
      vec3 c = abs(dx) < hw - 1.0 && row > 2.5 ? vec3(1.0, 0.96, 0.7) : row < 2.5 ? vec3(0.98, 0.42, 0.08) : vec3(1.0, 0.68, 0.16);
      albedo = c * vColor;
    } else if (style == 5) {
      // lava pop: glowing blob, yellow core, dark orange rim
      if (r > 2.7) discard;
      vec3 c = r < 1.2 ? vec3(1.0, 0.92, 0.45) : r > 2.0 ? vec3(0.86, 0.3, 0.04) : vec3(1.0, 0.55, 0.1);
      albedo = c * vColor;
    } else if (style == 6) {
      // drip: a small drop with a glint
      if (r > 1.3) discard;
      shade = (q.x < 3.5 && q.y < 3.5) ? 1.3 : 1.0;
    } else if (style == 8) {
      // crit sparkle: a four-pointed star with a bright core whose arms shrink over its life
      vec2 a = abs(d);
      float arm = 3.6 - phase * 2.2;
      bool core = a.x < 1.0 && a.y < 1.0;
      if (!core && !((a.x < 0.6 && a.y < arm) || (a.y < 0.6 && a.x < arm))) discard;
      shade = core ? 1.3 : 0.95;
    } else {
      // underwater speck: a 2x2 dot
      if (r > 0.8) discard;
    }
    if (style < 4 || style > 5) albedo = vColor * shade;
  }
  vec3 col = albedo * lightColor(vLight.x, vLight.y, uDaylight, uSkyTint);
  float fog = clamp((length(vRel) - uFog.x) * uFog.z, 0.0, 1.0);
  fragColor = vec4(mix(col, uFogColor, fog), 1.0);
}`;

// Entity shadows (Minecraft "shadow.png"): a soft dark disc on the top of the block under the entity.
const SHADOW_VS = `${HEADER}
layout(location = 0) in vec4 aPosR;      // camera-relative centre on the block top, radius
layout(location = 1) in vec2 aAlphaLight; // alpha, packed light
uniform mat4 uViewProj;
out vec2 vQ;
out vec3 vRel;
out vec2 vLight;
flat out float vAlpha;
const vec2 CORNERS[6] = vec2[6](vec2(-1.0, -1.0), vec2(1.0, -1.0), vec2(1.0, 1.0),
                                vec2(-1.0, -1.0), vec2(1.0, 1.0), vec2(-1.0, 1.0));
void main() {
  vec2 c = CORNERS[gl_VertexID];
  vec3 rel = aPosR.xyz + vec3(c.x, 0.0, c.y) * aPosR.w;
  vQ = c;
  vRel = rel;
  vAlpha = aAlphaLight.x;
  float l = floor(aAlphaLight.y + 0.5);
  vLight = vec2(floor(l / 16.0), mod(l, 16.0)) * (1.0 / 15.0);
  gl_Position = uViewProj * vec4(rel, 1.0);
}`;

const SHADOW_FS = `${HEADER}
uniform vec3 uFog;
uniform float uDaylight;
in vec2 vQ;
in vec3 vRel;
in vec2 vLight;
flat in float vAlpha;
out vec4 fragColor;
float lightCurve(float l) { return l / (4.0 - 3.0 * l); }
void main() {
  float d = length(vQ);
  float a = vAlpha * (1.0 - smoothstep(0.45, 1.0, d));
  // Minecraft scales the shadow by the brightness of the cell (none in the dark)
  a *= clamp(max(lightCurve(vLight.x) * uDaylight, lightCurve(vLight.y)), 0.0, 1.0);
  a *= 1.0 - clamp((length(vRel) - uFog.x) * uFog.z, 0.0, 1.0);
  if (a < 0.004) discard;
  fragColor = vec4(0.0, 0.0, 0.0, a);
}`;

// Read every texture-array layer into a 2D target (16 layers per row) for one readPixels.
const READBACK_VS = `${HEADER}
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)) * 2.0 - 1.0;
  gl_Position = vec4(p, 0.0, 1.0);
}`;
const READBACK_FS = `${HEADER}
uniform sampler2DArray uTex;
uniform int uLayers;
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int layer = (p.y / 16) * 16 + p.x / 16;
  o = layer < uLayers ? texelFetch(uTex, ivec3(p.x % 16, p.y % 16, layer), 0) : vec4(0.0);
}`;

// ===================================================================================================
// EntityRenderer
// ===================================================================================================

const TINT_RGB = [null, DEFAULT_TINTS.grass, DEFAULT_TINTS.foliage, DEFAULT_TINTS.birch, DEFAULT_TINTS.spruce];
const WHITE = 0xffffff;

/** Items using Minecraft's item/handheld model (tools, stick, bone): different third-person pose. */
function isHandheld(id) {
  const it = ITEMS[id];
  return !!it && (!!it.tool || it.name === 'stick' || it.name === 'bone');
}

/** Third-person display transform kind of a held item in `slot`. */
function heldKindOf(id, slot) {
  if (slot < SLOT_SPRITE0) return 'block';
  if (id === BOW_ID) return 'bow';
  return isHandheld(id) ? 'handheld' : 'sprite';
}

/** Texture layer of the drawn bow (bow_pulling_0..2 by BowItem.getPowerForTime), -1 when not drawing. */
function bowFrameLayer(useTicks) {
  if (!(useTicks > 0)) return -1;
  const pull = bowPower(useTicks);
  return BOW_PULLING[pull >= 0.9 ? 2 : pull >= 0.65 ? 1 : 0];
}

/** bowFrameLayer of a 'model' render item (reads useTime itself: no boxed argument per frame). */
function bowFrameLayerOf(it) {
  const t = +it.useTime;
  if (!(t > 0)) return -1;
  const f = t / 20;
  const pull = Math.min(1, (f * f + f * 2) / 3);
  return BOW_PULLING[pull >= 0.9 ? 2 : pull >= 0.65 ? 1 : 0];
}

/** Model definition id of a 'model' render item (modelId, else by name), -1 if unknown. */
function modelDefOf(it) {
  const id = it.modelId;
  if (typeof id === 'number' && id >= 0 && id < MODEL_DEFS.length && (id | 0) === id) return id;
  const byName = MODEL_ID[it.model];
  return byName === undefined ? -1 : byName;
}
function packTint(blockIdValue) {
  const c = TINT_RGB[TINT_TYPE[blockIdValue]];
  return c ? (c[0] | (c[1] << 8) | (c[2] << 16)) >>> 0 : WHITE;
}

/**
 * WebGL2 renderer for entities, particles and the first-person hand (SPEC §9.5). Created by the world
 * Renderer with its context and texture array; usable standalone (see tools/entity-test.html).
 */
export class EntityRenderer {
  /**
   * @param {WebGL2RenderingContext} gl
   * @param {WebGLTexture} textureArray  the shared TEXTURE_2D_ARRAY (§5.2)
   * @param {{ textureData?: Uint8Array, layers?: number }} [options] optional CPU copy of the level-0
   *   texture data (generateTextures().data): skips the one-time GPU read-back of sprite alpha
   */
  constructor(gl, textureArray, options = {}) {
    this.gl = gl;
    this.texture = textureArray;
    this.layerCount = options.layers ?? TEXTURE_LAYER_COUNT;
    this.meshProgram = createProgram(gl, MESH_VS, MESH_FS, 'entityMesh');
    this.particleProgram = createProgram(gl, PARTICLE_VS, PARTICLE_FS, 'entityParticles');
    this.shadowProgram = createProgram(gl, SHADOW_VS, SHADOW_FS, 'entityShadows');
    this.mu = this.meshProgram.uniforms;
    this.pu = this.particleProgram.uniforms;
    this.su = this.shadowProgram.uniforms;

    // sprite alpha (layer * 256 + texel), from the CPU copy or one GPU read-back
    this.alpha = null;
    if (options.textureData && options.textureData.length >= this.layerCount * 1024) {
      this.alpha = new Uint8Array(this.layerCount * 256);
      for (let i = 0; i < this.alpha.length; i++) this.alpha[i] = options.textureData[i * 4 + 3];
    } else {
      this.alpha = this._readBackAlpha();
    }

    // ---- static models ----
    this._mdata = new Float32Array(4096 * VERTEX_FLOATS);
    this._mlen = 0;                                  // vertices
    this.models = [];                                // { first, count } by fixed model id
    for (const build of [buildCubeModel, buildCactusModel, buildCrossModel, buildTorchModel]) {
      this.models.push(this._appendModel(build()));
    }
    // skinned models in DEF_FIRST order: every part of every model (base, then overlay), the arrow, the flames
    for (const d of MODEL_DEFS) {
      if (d.anim === 'arrow') {
        this.models.push(this._appendModel(buildArrowGeometry()));
        continue;
      }
      for (const part of d.parts) this.models.push(this._appendModel(buildPartGeometry(part)));
      if (d.overlay) for (const part of d.overlay.parts) this.models.push(this._appendModel(buildPartGeometry(part)));
    }
    this.models.push(this._appendModel(buildFireQuad(false)), this._appendModel(buildFireQuad(true)));
    this._spriteFirst = new Int32Array(256).fill(-1);
    this._spriteCount = new Int32Array(256);
    this.modelVBO = gl.createBuffer();
    this._modelCap = 0;
    this._uploadModels(true);

    // ---- instance buffers + VAOs ----
    this._instCap = 0;
    this._inst = null;
    this._instF = null;
    this._instU = null;
    this.instVBO = gl.createBuffer();
    this.meshVAO = gl.createVertexArray();
    this._setupMeshVAO(this.meshVAO, this.instVBO);
    this._ensureInstances(1024);
    this.handVBO = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.handVBO);
    gl.bufferData(gl.ARRAY_BUFFER, INSTANCE_BYTES * 2, gl.DYNAMIC_DRAW);
    this.handVAO = gl.createVertexArray();
    this._setupMeshVAO(this.handVAO, this.handVBO);
    this._handBuf = new ArrayBuffer(INSTANCE_BYTES);
    this._handF = new Float32Array(this._handBuf);
    this._handU = new Uint32Array(this._handBuf);

    this.particleVBO = gl.createBuffer();
    this.particleVAO = gl.createVertexArray();
    this._particleCap = 0;
    this._ensureParticles(4096);

    this.shadowVBO = gl.createBuffer();
    this.shadowVAO = gl.createVertexArray();
    this._shadowCap = 0;
    this._shadowF = null;
    this._ensureShadows(256);

    // ---- skins: player, mobs, sheep fleece, arrow, fire frames (64x64 layers of one array) ----
    this.skinTexture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.skinTexture);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, 64, 64, SKIN_LAYERS);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, SKIN.PLAYER, 64, 64, 1, gl.RGBA, gl.UNSIGNED_BYTE, paintSkinTexture());
    for (const [layer, px] of paintMobSkins()) {
      gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, layer, 64, 64, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    }
    paintFireFrames(FIRE_FRAMES).forEach((px, f) => {
      gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, SKIN.FIRE0 + f, 64, 64, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    });
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAX_LEVEL, 0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.texture);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    // ---- per-item / per-block render info (resolved lazily) ----
    const itemN = Math.max(512, ITEMS.length);
    this._iKind = new Int8Array(itemN).fill(-1);
    this._iSlot = new Int16Array(itemN);
    this._iL0 = new Uint32Array(itemN);
    this._iL1 = new Uint32Array(itemN);
    this._iTint = new Uint32Array(itemN);
    // stack copy offsets (ItemEntityRenderer, seeded by the item id): MAX_COPIES x xyz per item, copy 0 = 0
    this._iJitter = new Float64Array(itemN * MAX_COPIES * 3);
    this._bKind = new Int8Array(256).fill(-1);
    this._bSlot = new Int16Array(256);
    this._bL0 = new Uint32Array(256);
    this._bL1 = new Uint32Array(256);
    this._bTint = new Uint32Array(256);

    // ---- per-frame scratch ----
    this._counts = new Int32Array(SLOT_COUNT);
    this._offsets = new Int32Array(SLOT_COUNT);
    this._cursor = new Int32Array(SLOT_COUNT);
    this._itemSlot = new Int16Array(256);
    this._itemCopies = new Uint8Array(256);
    this._itemHeld = new Int16Array(256);            // 'model' items: slot of the held item (-1 = none)
    this._itemDef = new Int8Array(256);              // 'model' items: model definition id (-1 = other kinds)
    this._itemFire = new Uint8Array(256);            // 'model' items: flame sheets (burning)
    this._m = new Float64Array(12);
    this._m2 = new Float64Array(12);
    this._parts = new Float64Array(16 * 12);
    this._cam = new Float64Array(6);                 // camera x y z, horizontal right x z (+ spare)
    this._planes = new Float64Array(24);
    this._handProj = new Float32Array(16);
    this._v1 = new Float32Array(1);                  // uniform upload scratch (uniform*fv never boxes)
    this._v3 = new Float32Array(3);
    this._info = new Uint32Array(4);                 // instance info words scratch (see _writeInstance)
    /** Statistics of the last frame (draw calls, instances, particles). */
    this.stats = { drawCalls: 0, instances: 0, particles: 0, spriteModels: 0 };
    /** The 'model' kind with model: 'player' is supported (game.js enables F5 third-person views). */
    this.supportsPlayerModel = true;
    /** Mob models ('model' kind with model: <mob type>) and arrows are supported (SPEC-wave2 §3.4). */
    this.supportsMobModels = true;
  }

  // ---------------------------------------------------------------------------------------------
  // Resources
  // ---------------------------------------------------------------------------------------------

  /** One-time GPU read-back of every layer's alpha (16 layers per row of a 2D render target). */
  _readBackAlpha() {
    const gl = this.gl;
    if (!this.texture || gl.isContextLost()) return null;
    const layers = this.layerCount;
    const W = 256, H = Math.ceil(layers / 16) * 16;
    let prog = null, fbo = null, rt = null, vao = null;
    try {
      prog = createProgram(gl, READBACK_VS, READBACK_FS, 'entityReadback');
      rt = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, rt);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, W, H);
      fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, rt, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) return null;
      vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      gl.viewport(0, 0, W, H);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      gl.disable(gl.SCISSOR_TEST);
      gl.disable(gl.STENCIL_TEST);
      gl.colorMask(true, true, true, true);
      gl.useProgram(prog.program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.texture);
      gl.uniform1i(prog.uniforms.uTex, 0);
      gl.uniform1i(prog.uniforms.uLayers, layers);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      const px = new Uint8Array(W * H * 4);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const alpha = new Uint8Array(layers * 256);
      for (let l = 0; l < layers; l++) {
        const ox = (l % 16) * 16, oy = Math.floor(l / 16) * 16;
        for (let y = 0; y < 16; y++) {
          for (let x = 0; x < 16; x++) alpha[l * 256 + y * 16 + x] = px[((oy + y) * W + ox + x) * 4 + 3];
        }
      }
      return alpha;
    } catch (err) {
      console.warn('[entityrenderer] sprite alpha read-back failed, using flat sprites:', err);
      return null;
    } finally {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.bindVertexArray(null);
      gl.enable(gl.DEPTH_TEST);
      if (vao) gl.deleteVertexArray(vao);
      if (fbo) gl.deleteFramebuffer(fbo);
      if (rt) gl.deleteTexture(rt);
      if (prog) gl.deleteProgram(prog.program);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
  }

  /** Append model vertices (plain array) to the CPU model store. Returns { first, count }. */
  _appendModel(verts) {
    const count = verts.length / VERTEX_FLOATS;
    const need = (this._mlen + count) * VERTEX_FLOATS;
    if (need > this._mdata.length) {
      let size = this._mdata.length * 2;
      while (size < need) size *= 2;
      const grown = new Float32Array(size);
      grown.set(this._mdata.subarray(0, this._mlen * VERTEX_FLOATS));
      this._mdata = grown;
    }
    this._mdata.set(verts, this._mlen * VERTEX_FLOATS);
    const model = { first: this._mlen, count };
    this._mlen += count;
    return model;
  }

  /** Upload model vertices: everything (realloc) when the GPU buffer is too small, else the tail. */
  _uploadModels(all, fromVertex = 0) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.modelVBO);
    if (all || this._mlen > this._modelCap) {
      this._modelCap = Math.max(this._mdata.length / VERTEX_FLOATS, this._mlen);
      gl.bufferData(gl.ARRAY_BUFFER, this._modelCap * VERTEX_BYTES, gl.STATIC_DRAW);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this._mdata, 0, this._mlen * VERTEX_FLOATS);
    } else {
      gl.bufferSubData(gl.ARRAY_BUFFER, fromVertex * VERTEX_BYTES, this._mdata,
        fromVertex * VERTEX_FLOATS, (this._mlen - fromVertex) * VERTEX_FLOATS);
    }
  }

  _setupMeshVAO(vao, instVBO) {
    const gl = this.gl;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.modelVBO);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, VERTEX_BYTES, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, VERTEX_BYTES, 12);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 3, gl.FLOAT, false, VERTEX_BYTES, 24);
    gl.bindBuffer(gl.ARRAY_BUFFER, instVBO);
    for (let a = 3; a <= 6; a++) {
      gl.enableVertexAttribArray(a);
      gl.vertexAttribDivisor(a, 1);
    }
    this._pointInstances(0);
    gl.bindVertexArray(null);
  }

  /** Point the instance attributes (bound VAO, ARRAY_BUFFER = instance VBO) at instance `first`. */
  _pointInstances(first) {
    const gl = this.gl;
    const base = first * INSTANCE_BYTES;
    gl.vertexAttribPointer(3, 4, gl.FLOAT, false, INSTANCE_BYTES, base);
    gl.vertexAttribPointer(4, 4, gl.FLOAT, false, INSTANCE_BYTES, base + 16);
    gl.vertexAttribPointer(5, 4, gl.FLOAT, false, INSTANCE_BYTES, base + 32);
    gl.vertexAttribIPointer(6, 4, gl.UNSIGNED_INT, INSTANCE_BYTES, base + 48);
  }

  _ensureInstances(n) {
    if (n <= this._instCap) return;
    let cap = Math.max(1024, this._instCap);
    while (cap < n) cap *= 2;
    this._instCap = cap;
    this._inst = new ArrayBuffer(cap * INSTANCE_BYTES);
    this._instF = new Float32Array(this._inst);
    this._instU = new Uint32Array(this._inst);
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instVBO);
    gl.bufferData(gl.ARRAY_BUFFER, cap * INSTANCE_BYTES, gl.DYNAMIC_DRAW);
  }

  _ensureParticles(n) {
    if (n <= this._particleCap) return;
    let cap = Math.max(4096, this._particleCap);
    while (cap < n) cap *= 2;
    this._particleCap = cap;
    const gl = this.gl;
    gl.bindVertexArray(this.particleVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.particleVBO);
    gl.bufferData(gl.ARRAY_BUFFER, cap * PARTICLE_BYTES, gl.DYNAMIC_DRAW);
    for (let a = 0; a < 3; a++) {
      gl.enableVertexAttribArray(a);
      gl.vertexAttribPointer(a, 4, gl.FLOAT, false, PARTICLE_BYTES, a * 16);
      gl.vertexAttribDivisor(a, 1);
    }
    gl.bindVertexArray(null);
  }

  _ensureShadows(n) {
    if (n <= this._shadowCap) return;
    let cap = Math.max(256, this._shadowCap);
    while (cap < n) cap *= 2;
    this._shadowCap = cap;
    this._shadowF = new Float32Array(cap * SHADOW_FLOATS);
    const gl = this.gl;
    gl.bindVertexArray(this.shadowVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.shadowVBO);
    gl.bufferData(gl.ARRAY_BUFFER, cap * SHADOW_FLOATS * 4, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, SHADOW_FLOATS * 4, 0);
    gl.vertexAttribDivisor(0, 1);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, SHADOW_FLOATS * 4, 16);
    gl.vertexAttribDivisor(1, 1);
    gl.bindVertexArray(null);
  }

  /** Extruded model for a sprite layer (built on first use, then cached). Returns the vertex range. */
  _spriteModel(layer) {
    if (this._spriteFirst[layer] < 0) {
      const alpha = this.alpha && layer < this.layerCount ? this.alpha.subarray(layer * 256, layer * 256 + 256) : null;
      const from = this._mlen;
      const m = this._appendModel(buildSpriteModel(alpha));
      this._spriteFirst[layer] = m.first;
      this._spriteCount[layer] = m.count;
      const gl = this.gl;
      const before = this._modelCap;
      this._uploadModels(false, from);
      if (this._modelCap !== before) {
        // the model buffer was reallocated: re-point the static attributes of both VAOs
        this._setupMeshVAO(this.meshVAO, this.instVBO);
        this._setupMeshVAO(this.handVAO, this.handVBO);
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      this.stats.spriteModels++;
    }
    return layer;
  }

  // ---------------------------------------------------------------------------------------------
  // Item / block render info
  // ---------------------------------------------------------------------------------------------

  /** Fill the cube info (6 face layers, UV rotations, alpha mode, tint) of a block into table index i. */
  _cubeInfo(blockIdValue, L0, L1, T, i) {
    const b6 = blockIdValue * 6;
    const fl = FACE_LAYERS;
    L0[i] = (fl[b6] | (fl[b6 + 1] << 8) | (fl[b6 + 2] << 16) | (fl[b6 + 3] << 24)) >>> 0;
    let rot = 0;
    for (let f = 0; f < 6; f++) if (FACE_ROTATION[b6 + f]) rot |= 1 << f;
    const layer = RENDER_LAYER[blockIdValue];
    const mode = layer === LAYER.OPAQUE ? MODE.OPAQUE : layer === LAYER.TRANSLUCENT ? MODE.TRANSLUCENT : MODE.CUTOUT;
    L1[i] = (fl[b6 + 4] | (fl[b6 + 5] << 8) | (rot << 16) | (mode << 22)) >>> 0;
    T[i] = packTint(blockIdValue);
    return mode;
  }

  _resolveItem(id) {
    let kind = K_NONE;
    let it = ITEMS[id];
    if (!it && id > 0 && id < 256 && BLOCKS[id]) it = ITEMS[itemForBlock(id)];   // hidden variant -> base item
    if (it && it.isBlock) {
      const b = it.block;
      const rt = RENDER_TYPE[b];
      if (rt === RENDER.CUBE || rt === RENDER.CACTUS || rt === RENDER.LIQUID) {
        kind = K_CUBE;
        const mode = this._cubeInfo(b, this._iL0, this._iL1, this._iTint, id);
        this._iSlot[id] = rt === RENDER.CACTUS ? SLOT_CACTUS : mode === MODE.TRANSLUCENT ? SLOT_BLEND : SLOT_CUBE;
      } else if (rt === RENDER.CROSS || rt === RENDER.TORCH) {
        kind = K_SPRITE;
        const layer = FACE_LAYERS[b * 6];
        this._iSlot[id] = SLOT_SPRITE0 + layer;
        this._iL0[id] = layer;
        this._iL1[id] = (MODE.CUTOUT << 22) >>> 0;
        this._iTint[id] = packTint(b);
      }
    } else if (it && it.layer >= 0) {
      kind = K_SPRITE;
      this._iSlot[id] = SLOT_SPRITE0 + it.layer;
      this._iL0[id] = it.layer;
      this._iL1[id] = (MODE.CUTOUT << 22) >>> 0;
      this._iTint[id] = WHITE;
    }
    // stack copies: blocks scatter ±0.15 in 3D, sprites ±0.075 in their plane (copy 0 stays centred)
    const J = this._iJitter, jo = id * MAX_COPIES * 3;
    for (let k = 1; k < MAX_COPIES; k++) {
      if (kind === K_CUBE) {
        J[jo + k * 3] = hashSigned(id, k * 3) * 0.15;
        J[jo + k * 3 + 1] = hashSigned(id, k * 3 + 1) * 0.15;
        J[jo + k * 3 + 2] = hashSigned(id, k * 3 + 2) * 0.15;
      } else {
        J[jo + k * 3] = hashSigned(id, k * 2) * 0.075;
        J[jo + k * 3 + 1] = hashSigned(id, k * 2 + 1) * 0.075;
        J[jo + k * 3 + 2] = 0;
      }
    }
    this._iKind[id] = kind;
    return kind;
  }

  _resolveBlock(id) {
    let kind = K_NONE;
    const b = BLOCKS[id];
    if (b && id !== 0) {
      const rt = RENDER_TYPE[id];
      if (rt !== RENDER.NONE) {
        kind = K_CUBE;
        const mode = this._cubeInfo(id, this._bL0, this._bL1, this._bTint, id);
        if (rt === RENDER.CACTUS) this._bSlot[id] = SLOT_CACTUS;
        else if (rt === RENDER.CROSS) this._bSlot[id] = SLOT_CROSS;
        else if (rt === RENDER.TORCH) this._bSlot[id] = SLOT_TORCH;
        else this._bSlot[id] = mode === MODE.TRANSLUCENT ? SLOT_BLEND : SLOT_CUBE;
      }
    }
    this._bKind[id] = kind;
    return kind;
  }

  // ---------------------------------------------------------------------------------------------
  // Shared draw state
  // ---------------------------------------------------------------------------------------------

  _setMeshUniforms(ctx, viewProj) {
    const gl = this.gl;
    const u = this.mu;
    gl.useProgram(this.meshProgram.program);
    gl.uniformMatrix4fv(u.uViewProj, false, viewProj);
    gl.uniform1i(u.uTex, 0);
    this._setFogLight(ctx, u);
  }

  /** Fog + light uniforms from ctx (uploaded from scratch typed arrays: no per-frame allocations). */
  _setFogLight(ctx, u) {
    const gl = this.gl;
    const v = this._v3;
    const fc = ctx.fogColor;
    if (fc) {
      v[0] = fc[0]; v[1] = fc[1]; v[2] = fc[2];
    } else {
      v[0] = 0.75; v[1] = 0.85; v[2] = 1;
    }
    gl.uniform3fv(u.uFogColor, v);
    this._setFog(ctx, u);
    const st = ctx.skyTint;
    const v4 = this._v4 ?? (this._v4 = new Float32Array(4));
    if (st) {
      v4[0] = st[0]; v4[1] = st[1]; v4[2] = st[2];
      v4[3] = Number.isFinite(st[3]) ? st[3] : 0.5;      // brightness option (Minecraft gamma)
    } else {
      v4[0] = 1; v4[1] = 1; v4[2] = 1; v4[3] = 0.5;
    }
    gl.uniform4fv(u.uSkyTint, v4);
  }

  /** uFog (start, end, 1 / (end - start)) and uDaylight from ctx. */
  _setFog(ctx, u) {
    const gl = this.gl;
    const v = this._v3;
    const fs = Number.isFinite(ctx.fogStart) ? ctx.fogStart : 1e6;
    const fe = Number.isFinite(ctx.fogEnd) ? ctx.fogEnd : fs + 1;
    v[0] = fs; v[1] = fe; v[2] = 1 / Math.max(1e-3, fe - fs);
    gl.uniform3fv(u.uFog, v);
    this._v1[0] = Number.isFinite(ctx.daylight) ? ctx.daylight : 1;
    gl.uniform1fv(u.uDaylight, this._v1);
  }

  _bindTexture(ctx) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, ctx.texture ?? this.texture);
  }

  /**
   * Frustum planes (camera-relative, normalised) from a column-major viewProj into this._planes, in the order
   * left, right, bottom, top, near, far (row 3 ± row 0 / 1 / 2; a·x + b·y + c·z + d >= 0 inside).
   */
  _extractPlanes(m) {
    const p = this._planes;
    for (let i = 0; i < 6; i++) {
      const col = i >> 1;
      const sgn = (i & 1) === 0 ? 1 : -1;
      const a = m[3] + sgn * m[col], b = m[7] + sgn * m[4 + col];
      const c = m[11] + sgn * m[8 + col], d = m[15] + sgn * m[12 + col];
      const len = Math.sqrt(a * a + b * b + c * c) || 1;
      const o = i * 4;
      p[o] = a / len; p[o + 1] = b / len; p[o + 2] = c / len; p[o + 3] = d / len;
    }
  }

  /**
   * Write one instance (3x4 matrix `m`, info words `info[0..3]`: layers 0-3, layers 4-5 + rotations + mode,
   * tint + flash, light) into the CPU instance buffer at index `at`. Typed-array arguments only: callers never
   * pass computed numbers that V8 would have to box.
   */
  _writeInstance(F, U, at, m, info) {
    const o = at * INSTANCE_FLOATS;
    F[o] = m[0]; F[o + 1] = m[1]; F[o + 2] = m[2]; F[o + 3] = m[3];
    F[o + 4] = m[4]; F[o + 5] = m[5]; F[o + 6] = m[6]; F[o + 7] = m[7];
    F[o + 8] = m[8]; F[o + 9] = m[9]; F[o + 10] = m[10]; F[o + 11] = m[11];
    U[o + 12] = info[0]; U[o + 13] = info[1]; U[o + 14] = info[2]; U[o + 15] = info[3] & 0x1ff;
  }

  // ---------------------------------------------------------------------------------------------
  // Entities
  // ---------------------------------------------------------------------------------------------

  /**
   * Draw dropped items and block entities (SPEC §9.5 EntityRenderItem: kind 'item' | 'block').
   * @param {object} ctx  renderer context (§9.5)
   * @param {object[]} items
   */
  renderEntities(ctx, items) {
    const gl = this.gl;
    const n = items ? items.length : 0;
    this.stats.drawCalls = 0;
    this.stats.instances = 0;
    if (n === 0) return;
    if (this._itemSlot.length < n) {
      let cap = this._itemSlot.length;
      while (cap < n) cap *= 2;
      this._itemSlot = new Int16Array(cap);
      this._itemCopies = new Uint8Array(cap);
      this._itemHeld = new Int16Array(cap);
      this._itemDef = new Int8Array(cap);
      this._itemFire = new Uint8Array(cap);
    }
    const cam = ctx.cameraPos;
    const cx = cam[0], cy = cam[1], cz = cam[2];
    // camera for the per-entity helpers (typed array: no boxed arguments) + horizontal right vector (flames)
    const C = this._cam;
    C[0] = cx; C[1] = cy; C[2] = cz;
    const cr = ctx.camRight;
    let hx = cr ? cr[0] : 1, hz = cr ? cr[2] : 0;
    const hl = Math.sqrt(hx * hx + hz * hz);
    if (hl > 1e-6) { hx /= hl; hz /= hl; } else { hx = 1; hz = 0; }
    C[3] = hx; C[4] = hz;
    C[5] = Number.isFinite(ctx.time) ? ctx.time : 0;
    this._extractPlanes(ctx.viewProj);
    const maxDist = (Number.isFinite(ctx.fogEnd) ? ctx.fogEnd : 512) + 2;
    const maxD2 = maxDist * maxDist;
    const counts = this._counts;
    counts.fill(0);
    let total = 0;

    // ---- pass 1: model slot + copies per item (culled -> -1) ----
    // (The per-entity code of passes 1 and 3 calls no function with a computed fractional argument and writes
    // matrices directly: V8 would otherwise box those numbers, i.e. allocate per entity per frame.)
    const PL = this._planes;
    for (let i = 0; i < n; i++) {
      const it = items[i];
      let slot = -1, copies = 0, def = -1;
      if (it && Number.isFinite(it.x) && Number.isFinite(it.y) && Number.isFinite(it.z)) {
        const rx = it.x - cx, ry = it.y - cy, rz = it.z - cz;
        if (rx * rx + ry * ry + rz * rz <= maxD2) {
          // candidate model slot + copies, bounding sphere centred at (rx, ry + sh, rz) with radius sr
          let cand = -1, count = 0, sh = 0, sr = 0;
          const kind = it.kind;
          if (kind === 'item') {
            const id = it.itemId | 0;
            if (id > 0 && id < this._iKind.length) {
              const k = this._iKind[id] >= 0 ? this._iKind[id] : this._resolveItem(id);
              if (k !== K_NONE) {
                cand = this._iSlot[id];
                count = renderAmount(it.count | 0);
                sh = 0.3; sr = 0.7;
              }
            }
          } else if (kind === 'block') {
            const id = it.blockId | 0;
            if (id > 0 && id < 256) {
              const k = this._bKind[id] >= 0 ? this._bKind[id] : this._resolveBlock(id);
              if (k !== K_NONE) {
                const scale = Number.isFinite(it.scale) && it.scale > 0 ? it.scale : 1;
                cand = this._bSlot[id];
                count = 1;
                sh = scale * 0.5; sr = scale;
              }
            }
          } else if (kind === 'model') {
            def = modelDefOf(it);
            if (def >= 0) {
              const sp = MODEL_DEFS[def].sphere;
              cand = SLOT_SKIN0 + DEF_FIRST[def];
              sh = sp[0]; sr = sp[1];
            }
          }
          let visible = cand >= 0;
          if (visible) {
            const sy = ry + sh;
            for (let p = 0; p < 24; p += 4) {
              if (PL[p] * rx + PL[p + 1] * sy + PL[p + 2] * rz + PL[p + 3] < -sr) {
                visible = false;
                break;
              }
            }
          }
          if (visible) {
            slot = cand;
            copies = count;
            if (slot >= SLOT_SPRITE0) {
              this._spriteModel(slot - SLOT_SPRITE0);
            } else if (def >= 0) {
              // one instance in each part slot (+ overlay parts unless sheared), the held item in its own slot,
              // the flame sheets of a burning entity
              const d = MODEL_DEFS[def];
              let held = -1;
              const id = it.itemId | 0;
              if (d.hand !== undefined && id > 0 && id < this._iKind.length) {
                const k = this._iKind[id] >= 0 ? this._iKind[id] : this._resolveItem(id);
                if (k !== K_NONE) {
                  held = this._iSlot[id];
                  if (id === BOW_ID) {
                    const bl = bowFrameLayerOf(it);
                    if (bl >= 0) held = SLOT_SPRITE0 + bl;
                  }
                  if (held >= SLOT_SPRITE0) this._spriteModel(held - SLOT_SPRITE0);
                  counts[held]++;
                  total++;
                }
              }
              this._itemHeld[i] = held;
              const parts = DEF_PARTS[def] + (it.sheared ? 0 : DEF_OVERLAY[def]);
              for (let p = 0; p < parts; p++) counts[slot + p]++;
              total += parts;
              let fire = 0;
              if (it.onFire && DEF_FIRE[def] > 0) {
                fire = DEF_FIRE[def];
                for (let k = 0; k < fire; k++) counts[SLOT_FIRE + (((k >> 1) & 1) === 0 ? 1 : 0)]++;
                total += fire;
              }
              this._itemFire[i] = fire;
            }
          }
        }
      }
      this._itemSlot[i] = slot;
      this._itemCopies[i] = copies;
      this._itemDef[i] = slot >= 0 ? def : -1;
      if (slot >= 0 && def < 0) {
        counts[slot] += copies;
        total += copies;
      }
    }
    if (total === 0) return;

    // ---- pass 2: offsets (counting sort by slot) ----
    const offsets = this._offsets, cursor = this._cursor;
    let acc = 0;
    for (let s = 0; s < SLOT_COUNT; s++) {
      offsets[s] = acc;
      cursor[s] = acc;
      acc += counts[s];
    }
    this._ensureInstances(total);
    this._ensureShadows(n);
    const F = this._instF, U = this._instU;
    const S = this._shadowF;
    let shadows = 0;
    const m = this._m, m2 = this._m2;

    // ---- pass 3: instances ----
    for (let i = 0; i < n; i++) {
      const slot = this._itemSlot[i];
      if (slot < 0) continue;
      const it = items[i];
      const rx = it.x - cx, ry = it.y - cy, rz = it.z - cz;
      const light = (Number.isFinite(it.light) ? it.light : 0xf0) & 255;
      if (it.shadow > 0 && Number.isFinite(it.shadowY) && it.shadowRadius > 0) {
        const o = shadows++ * SHADOW_FLOATS;
        S[o] = rx; S[o + 1] = it.shadowY + 0.002 - cy; S[o + 2] = rz;
        S[o + 3] = it.shadowRadius; S[o + 4] = Math.min(1, it.shadow); S[o + 5] = light;
      }
      if (it.kind === 'item') {
        // ItemEntityRenderer: M = T(rel + (0, bob + 0.25·scale, 0)) · Ry(spin) · T(offset) · S(scale) per copy,
        // offset = copy jitter + "ground" display translation (+ the depth of the sprite stack)
        const id = it.itemId | 0;
        const copies = this._itemCopies[i];
        const l0 = this._iL0[id], l1 = this._iL1[id], tint = this._iTint[id];
        const age = Number.isFinite(it.age) ? it.age : 0;
        const phase = (Number.isFinite(it.seed) ? it.seed : 0) * TAU;
        const bob = Math.sin(age * 2 + phase) * 0.1 + 0.1;     // sin(ageTicks / 10 + bobOffs)·0.1 + 0.1
        const spin = age + phase;                              // ageTicks / 20 + bobOffs
        const cs = Math.cos(spin), sn = Math.sin(spin);
        const cube = slot < SLOT_SPRITE0;
        const ks = cube ? GROUND_BLOCK_SCALE : GROUND_SPRITE_SCALE;
        const up = cube ? GROUND_BLOCK_UP : GROUND_SPRITE_UP;
        const ty = ry + bob + 0.25 * ks;
        const zs = cube ? 0 : SPRITE_COPY_STEP;
        let zo = -zs * (copies - 1) * 0.5;
        const a = cs * ks, b = sn * ks;
        const J = this._iJitter, jo = id * MAX_COPIES * 3;
        for (let k = 0; k < copies; k++) {
          const ox = J[jo + k * 3], oy = J[jo + k * 3 + 1] + up, oz = J[jo + k * 3 + 2] + zo;
          const o = cursor[slot]++ * INSTANCE_FLOATS;
          F[o] = a; F[o + 1] = 0; F[o + 2] = b; F[o + 3] = rx + cs * ox + sn * oz;
          F[o + 4] = 0; F[o + 5] = ks; F[o + 6] = 0; F[o + 7] = ty + oy;
          F[o + 8] = -b; F[o + 9] = 0; F[o + 10] = a; F[o + 11] = rz - sn * ox + cs * oz;
          U[o + 12] = l0; U[o + 13] = l1; U[o + 14] = tint; U[o + 15] = light;
          zo += zs;
        }
      } else if (this._itemDef[i] === DEF_ARROW) {
        this._writeArrow(F, U, cursor[slot]++, it, light);
      } else if (this._itemDef[i] >= 0 && this._itemDef[i] !== DEF_PLAYER) {
        this._writeMob(F, U, cursor, i, it, light);
      } else if (this._itemDef[i] === DEF_PLAYER) {
        // player model: parts with the skin (hurt -> 30 % red overlay, like Minecraft's OverlayTexture). Posed
        // at the camera (integer arguments), the camera-relative position is added to the translations.
        const held = this._itemHeld[i];
        const id = it.itemId | 0;
        const heldKind = held < 0 ? 'sprite' : heldKindOf(id, held);
        computePlayerPose(it, 0, 0, 0, this._parts, held >= 0 ? m2 : null, heldKind);
        const hurt = it.hurt > 0;
        const info = this._info;
        info[0] = 0;
        info[1] = (MODE.OPAQUE << 22) >>> 0;
        info[2] = (WHITE | (hurt ? Math.round(0.3 * 255) << 24 : 0)) >>> 0;
        info[3] = hurt ? light | FLASH_RED : light;
        const P = this._parts;
        for (let p = 0; p < 6; p++) {
          for (let k = 0; k < 12; k++) m[k] = P[p * 12 + k];
          m[3] += rx; m[7] += ry; m[11] += rz;
          this._writeInstance(F, U, cursor[SLOT_PART0 + p]++, m, info);
        }
        if (held >= 0) {
          m2[3] += rx; m2[7] += ry; m2[11] += rz;
          info[0] = held >= SLOT_SPRITE0 ? held - SLOT_SPRITE0 : this._iL0[id];
          info[1] = this._iL1[id]; info[2] = this._iTint[id]; info[3] = light;
          this._writeInstance(F, U, cursor[held]++, m2, info);
        }
        if (this._itemFire[i] > 0) this._writeFire(F, U, cursor, i, it);
      } else {
        // block entity (falling block, primed TNT): T(rel + (0, scale / 2, 0)) · S(scale), bottom stays at y
        const id = it.blockId | 0;
        const scale = Number.isFinite(it.scale) && it.scale > 0 ? it.scale : 1;
        const flash = Number.isFinite(it.flash) ? Math.min(1, Math.max(0, it.flash)) : 0;
        const o = cursor[slot]++ * INSTANCE_FLOATS;
        F[o] = scale; F[o + 1] = 0; F[o + 2] = 0; F[o + 3] = rx;
        F[o + 4] = 0; F[o + 5] = scale; F[o + 6] = 0; F[o + 7] = ry + scale * 0.5;
        F[o + 8] = 0; F[o + 9] = 0; F[o + 10] = scale; F[o + 11] = rz;
        U[o + 12] = this._bL0[id]; U[o + 13] = this._bL1[id];
        U[o + 14] = (this._bTint[id] | (Math.round(flash * 255) << 24)) >>> 0;
        U[o + 15] = light;
      }
    }

    // ---- upload + draw ----
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instVBO);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this._instF, 0, total * INSTANCE_FLOATS);
    this._bindTexture(ctx);
    this._setMeshUniforms(ctx, ctx.viewProj);
    gl.bindVertexArray(this.meshVAO);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.disable(gl.BLEND);
    let skin = false;
    for (let s = 0; s < SLOT_COUNT; s++) {
      if (s === SLOT_BLEND || counts[s] === 0) continue;
      const part = s >= SLOT_SKIN0 && s < SLOT_SPRITE0;
      if (part !== skin) {
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, part ? this.skinTexture : (ctx.texture ?? this.texture));
        skin = part;
      }
      this._drawSlot(s, offsets[s], counts[s]);
    }
    if (skin) gl.bindTexture(gl.TEXTURE_2D_ARRAY, ctx.texture ?? this.texture);
    if (shadows > 0) this._drawShadows(ctx, shadows);
    if (counts[SLOT_BLEND] > 0) {
      if (shadows > 0) {
        this._setMeshUniforms(ctx, ctx.viewProj);
        gl.bindVertexArray(this.meshVAO);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.instVBO);
      }
      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
      this._drawSlot(SLOT_BLEND, offsets[SLOT_BLEND], counts[SLOT_BLEND]);
      gl.disable(gl.BLEND);
    }
    gl.bindVertexArray(null);
    this.stats.instances = total;
  }

  /**
   * Instances of one mob ('model' item i, definition _itemDef[i]): every part with its skin layer, the sheep
   * fleece overlay (tinted), the held item and the flame sheets. Hurt / dying -> red overlay; a swelling
   * creeper flashes white (CreeperRenderer.getWhiteOverlayProgress). Arguments are objects / typed arrays /
   * small integers only (no boxed numbers).
   */
  _writeMob(F, U, cursor, i, it, light) {
    const def = this._itemDef[i];
    const d = MODEL_DEFS[def];
    const C = this._cam;
    const rx = it.x - C[0], ry = it.y - C[1], rz = it.z - C[2];
    const held = this._itemHeld[i];
    const hm = this._m2;
    const nm = computeModelPose(d, it, 0, 0, 0, this._parts, held >= 0 ? hm : null);
    let flash = 0, red = false;
    if (it.hurt > 0 || it.death > 0) {
      flash = HURT_FLASH;
      red = true;
    } else if (it.swell > 0) {
      const f = +it.swell;
      const u = Math.floor(f * 10) % 2 === 0 ? 0 : Math.min(1, Math.max(0.5, f));
      flash = Math.round(Math.floor(u * 15) / 15 * 0.75 * 255);
    }
    const info = this._info;
    info[0] = d.skin;
    info[1] = ((MODE.CUTOUT << 22) | (d.emissive ? EMISSIVE_BIT : 0)) >>> 0;
    info[2] = (WHITE | (flash << 24)) >>> 0;
    info[3] = red ? light | FLASH_RED : light;
    const m = this._m;
    const P = this._parts;
    const base = SLOT_SKIN0 + DEF_FIRST[def];
    const np = DEF_PARTS[def];
    const parts = it.sheared ? np : Math.min(nm, np + DEF_OVERLAY[def]);
    for (let p = 0; p < parts; p++) {
      if (p === np) {
        // SheepFurModel: fleece skin tinted with the wool colour
        info[0] = d.overlay.skin;
        const c = typeof it.color === 'number' && it.color >= 0 ? it.color : FLEECE_WHITE;
        info[2] = ((c & 0xffffff) | (flash << 24)) >>> 0;
      }
      for (let k = 0; k < 12; k++) m[k] = P[p * 12 + k];
      m[3] += rx; m[7] += ry; m[11] += rz;
      this._writeInstance(F, U, cursor[base + p]++, m, info);
    }
    if (held >= 0) {
      const id = it.itemId | 0;
      thirdPersonTransform(hm, heldKindOf(id, held));
      hm[3] += rx; hm[7] += ry; hm[11] += rz;
      info[0] = held >= SLOT_SPRITE0 ? held - SLOT_SPRITE0 : this._iL0[id];
      info[1] = this._iL1[id]; info[2] = this._iTint[id]; info[3] = light;
      this._writeInstance(F, U, cursor[held]++, hm, info);
    }
    if (this._itemFire[i] > 0) this._writeFire(F, U, cursor, i, it);
  }

  /**
   * Minecraft's renderFlame for a burning entity: camera-facing (yaw only) fire sheets stacked upward, each
   * 0.9 times narrower and a little further from the camera, alternately mirrored, full-bright animated
   * fire frames (one frame per tick).
   */
  _writeFire(F, U, cursor, i, it) {
    const d = MODEL_DEFS[this._itemDef[i]];
    const C = this._cam;
    const rx = it.x - C[0], ry = it.y - C[1], rz = it.z - C[2];
    const rhx = C[3], rhz = C[4];             // camera right (horizontal)
    const fx = rhz, fz = -rhx;                // camera forward (horizontal)
    const f = d.bbox[0] * 1.4;
    const zoff = -0.3 + Math.floor(d.bbox[1] / f) * 0.02;
    let f1 = 0.5, f4 = 0, f5 = 0;
    const frame = Math.floor(C[5] * 20) % FIRE_FRAMES;
    const n = this._itemFire[i];
    const l1 = ((MODE.CUTOUT << 22) | EMISSIVE_BIT) >>> 0;
    for (let k = 0; k < n; k++) {
      const slot = SLOT_FIRE + (((k >> 1) & 1) === 0 ? 1 : 0);
      const o = cursor[slot]++ * INSTANCE_FLOATS;
      const w = 2 * f1 * f, h = 1.4 * f, z = (zoff + f5) * f;
      F[o] = -rhx * w; F[o + 1] = 0; F[o + 2] = fx * f; F[o + 3] = rx + fx * z;
      F[o + 4] = 0; F[o + 5] = h; F[o + 6] = 0; F[o + 7] = ry - f4 * f;
      F[o + 8] = -rhz * w; F[o + 9] = 0; F[o + 10] = fz * f; F[o + 11] = rz + fz * z;
      U[o + 12] = SKIN.FIRE0 + ((frame + ((k & 1) !== 0 ? FIRE_FRAMES / 2 : 0)) % FIRE_FRAMES);
      U[o + 13] = l1;
      U[o + 14] = WHITE;
      U[o + 15] = 0xff;
      f4 -= 0.45; f1 *= 0.9; f5 += 0.03;
    }
  }

  /**
   * ArrowRenderer: T(rel) · Ry(yRot - 90°) · Rz(xRot) · Rz(shake) · Rx(45°) · S(0.05625) · T(-4, 0, 0) with
   * Minecraft's yRot = atan2(vx, vz) (bodyYaw) and xRot = atan2(vy, horizontal) (headPitch) in radians.
   */
  _writeArrow(F, U, at, it, light) {
    const C = this._cam;
    const rx = it.x - C[0], ry = it.y - C[1], rz = it.z - C[2];
    const a = (+it.bodyYaw || 0) - Math.PI / 2;
    let b = +it.headPitch || 0;
    const shake = +it.shake || 0;
    if (shake > 0) b += -Math.sin(shake * 3) * shake * DEG;
    const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b);
    const cc = Math.SQRT1_2, sc = Math.SQRT1_2;   // 45° about X
    const s = ARROW_SCALE;
    // columns of Ry(a)·Rz(b)·Rx(45°), scaled
    const c0x = ca * cb, c0y = sb, c0z = -sa * cb;
    const c1x = -ca * sb * cc + sa * sc, c1y = cb * cc, c1z = sa * sb * cc + ca * sc;
    const c2x = ca * sb * sc + sa * cc, c2y = -cb * sc, c2z = -sa * sb * sc + ca * cc;
    const o = at * INSTANCE_FLOATS;
    F[o] = c0x * s; F[o + 1] = c1x * s; F[o + 2] = c2x * s; F[o + 3] = rx - 4 * s * c0x;
    F[o + 4] = c0y * s; F[o + 5] = c1y * s; F[o + 6] = c2y * s; F[o + 7] = ry - 4 * s * c0y;
    F[o + 8] = c0z * s; F[o + 9] = c1z * s; F[o + 10] = c2z * s; F[o + 11] = rz - 4 * s * c0z;
    U[o + 12] = SKIN.ARROW;
    U[o + 13] = (MODE.CUTOUT << 22) >>> 0;
    U[o + 14] = WHITE;
    U[o + 15] = light;
  }

  /** Blend the entity shadows onto the blocks below (after the opaque entity draws). */
  _drawShadows(ctx, count) {
    const gl = this.gl;
    const u = this.su;
    gl.useProgram(this.shadowProgram.program);
    gl.uniformMatrix4fv(u.uViewProj, false, ctx.viewProj);
    this._setFog(ctx, u);
    gl.bindVertexArray(this.shadowVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.shadowVBO);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this._shadowF, 0, count * SHADOW_FLOATS);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
    gl.depthMask(false);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(-1, -2);
    gl.disable(gl.CULL_FACE);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count);
    this.stats.drawCalls++;
    gl.enable(gl.CULL_FACE);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
  }

  _drawSlot(slot, first, count) {
    const gl = this.gl;
    let vFirst, vCount;
    if (slot >= SLOT_SPRITE0) {
      const layer = slot - SLOT_SPRITE0;
      vFirst = this._spriteFirst[layer];
      vCount = this._spriteCount[layer];
      if (vFirst < 0) return;
    } else {
      const model = this.models[SLOT_MODEL[slot]];
      vFirst = model.first;
      vCount = model.count;
    }
    this._pointInstances(first);
    gl.drawArraysInstanced(gl.TRIANGLES, vFirst, vCount, count);
    this.stats.drawCalls++;
  }

  // ---------------------------------------------------------------------------------------------
  // Particles
  // ---------------------------------------------------------------------------------------------

  /**
   * Draw particles: { count, data: Float32Array } with the stride-12 layout of particles.js.
   */
  renderParticles(ctx, particles) {
    const gl = this.gl;
    const data = particles?.data;
    const n = data ? Math.min(particles.count | 0, Math.floor(data.length / PARTICLE_FLOATS)) : 0;
    this.stats.particles = n;
    if (n <= 0) return;
    this._ensureParticles(n);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.particleVBO);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, n * PARTICLE_FLOATS);
    const u = this.pu;
    gl.useProgram(this.particleProgram.program);
    gl.uniformMatrix4fv(u.uViewProj, false, ctx.viewProj);
    gl.uniform1i(u.uTex, 0);
    // camera split into integer + fraction (precision far from the origin); uploads from scratch arrays
    const cam = ctx.cameraPos;
    const v = this._v3;
    const hx = Math.floor(cam[0]), hy = Math.floor(cam[1]), hz = Math.floor(cam[2]);
    v[0] = hx; v[1] = hy; v[2] = hz;
    gl.uniform3fv(u.uCamHi, v);
    v[0] = cam[0] - hx; v[1] = cam[1] - hy; v[2] = cam[2] - hz;
    gl.uniform3fv(u.uCamLo, v);
    const cr = ctx.camRight, cu = ctx.camUp;
    v[0] = cr[0]; v[1] = cr[1]; v[2] = cr[2];
    gl.uniform3fv(u.uRight, v);
    v[0] = cu[0]; v[1] = cu[1]; v[2] = cu[2];
    gl.uniform3fv(u.uUp, v);
    this._setFogLight(ctx, u);
    this._bindTexture(ctx);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(this.particleVAO);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, n);
    gl.bindVertexArray(null);
    gl.enable(gl.CULL_FACE);
  }

  // ---------------------------------------------------------------------------------------------
  // First-person hand
  // ---------------------------------------------------------------------------------------------

  /**
   * Draw the first-person hand / held item (SPEC §9.5 HandState). Clears the depth buffer itself and
   * uses its own projection (fov 70, near 0.01); the pose follows Minecraft's ItemInHandRenderer.
   */
  renderHand(ctx, hand) {
    if (!hand) return;
    const gl = this.gl;
    const id = hand.itemId | 0;
    let kind = 'arm', slot = -1;
    let vFirst = this.models[M_ARM].first, vCount = this.models[M_ARM].count;
    let l0 = 0, l1 = (MODE.OPAQUE << 22) >>> 0, tint = WHITE;
    if (id > 0) {
      if (id >= this._iKind.length) return;
      const k = this._iKind[id] >= 0 ? this._iKind[id] : this._resolveItem(id);
      if (k === K_NONE) return;
      slot = this._iSlot[id];
      l0 = this._iL0[id]; l1 = this._iL1[id]; tint = this._iTint[id];
      if (id === BOW_ID && hand.useAction === 'bow') {
        // the drawn bow shows the pulling frames (BowItem model overrides)
        const bl = bowFrameLayer(Math.max(1e-3, handUseTicks(hand)));
        if (bl >= 0) { slot = SLOT_SPRITE0 + bl; l0 = bl; }
      }
      if (k === K_SPRITE) {
        kind = 'sprite';
        const layer = slot - SLOT_SPRITE0;
        this._spriteModel(layer);
        vFirst = this._spriteFirst[layer];
        vCount = this._spriteCount[layer];
      } else {
        kind = 'block';
        const model = this.models[slot === SLOT_CACTUS ? M_CACTUS : M_CUBE];
        vFirst = model.first;
        vCount = model.count;
      }
    }
    computeHandPose(this._m, hand, kind);
    const info = this._info;
    info[0] = l0; info[1] = l1; info[2] = tint;
    info[3] = Number.isFinite(hand.light) ? hand.light : 0xf0;
    this._writeInstance(this._handF, this._handU, 0, this._m, info);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.handVBO);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this._handF);

    mat4Perspective(this._handProj, HAND_FOV, ctx.aspect > 0 ? ctx.aspect : 1, HAND_NEAR, HAND_FAR);
    gl.depthMask(true);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    const blend = slot === SLOT_BLEND;
    if (blend) {
      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
    } else {
      gl.disable(gl.BLEND);
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, kind === 'arm' ? this.skinTexture : (ctx.texture ?? this.texture));
    this._setMeshUniforms(ctx, this._handProj);
    gl.bindVertexArray(this.handVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.handVBO);
    this._pointInstances(0);
    gl.drawArraysInstanced(gl.TRIANGLES, vFirst, vCount, 1);
    gl.bindVertexArray(null);
    if (blend) gl.disable(gl.BLEND);
    if (kind === 'arm') gl.bindTexture(gl.TEXTURE_2D_ARRAY, ctx.texture ?? this.texture);
  }

  /** Free every GL resource. */
  dispose() {
    const gl = this.gl;
    if (gl.isContextLost()) return;
    gl.deleteProgram(this.meshProgram.program);
    gl.deleteProgram(this.particleProgram.program);
    gl.deleteProgram(this.shadowProgram.program);
    for (const b of [this.modelVBO, this.instVBO, this.handVBO, this.particleVBO, this.shadowVBO]) gl.deleteBuffer(b);
    for (const v of [this.meshVAO, this.handVAO, this.particleVAO, this.shadowVAO]) gl.deleteVertexArray(v);
    gl.deleteTexture(this.skinTexture);
  }
}
