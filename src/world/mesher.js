// Chunk mesher: region + light -> per-section vertex buffers (docs/SPEC.md §7).
// Pure module (worker / main thread / Node), no DOM access.
//
// Vertex format (3 x uint32 per vertex, 4 vertices per quad, quads drawn as (0,1,2)(0,2,3)):
//   w0 = x | y << 9 | z << 18 | ao << 27 | face << 29
//        x,y,z = round(p*16) + 16, p = position relative to the section origin in blocks
//        ao 0 (darkest) .. 3 (unoccluded); face 0..5 = directional shade index, 6 = unshaded sprite
//   w1 = layer | u << 8 | v << 13 | sky << 18 | block << 24 | anim << 30
//        u,v texel coords 0..16 (v = 0 at the top edge of the texture); sky/block = light x 4 (0..60)
//        anim 0 none, 1 plant sway (top vertices), 2 leaves, 3 animated liquid texture
//   w2 = r | g << 8 | b << 16 (tint, 0xFFFFFF = none)
//
// Geometry conventions (every quad is counter-clockwise seen from its outside):
//   vertex order = texel (u,v) (0,0) (0,16) (16,16) (16,0) = top-left, bottom-left, bottom-right,
//   top-right as seen from outside. u runs left-to-right as seen from outside; for side faces v = 0
//   is the top edge; top face: u along +X, v along +Z; bottom face: u along +X, v along -Z.
//   Partial faces (torch, lowered liquid surface, cactus) use the planar mapping of the full face,
//   i.e. the texel sub-rectangle matching their geometry, so texels are never stretched.
//
// Render types:
//   cube    6 faces, culled against opaque neighbours (and same-id neighbours when CULL_SAME).
//           Leaves are "fancy": faces between leaves are kept (they are not opaque), anim 2.
//   cross   two diagonal double-sided planes (0.15 -> 0.85, i.e. 2/16 -> 14/16 after quantisation),
//           own-cell light, ao 3, face 6, anim 1 on the top vertices.
//   torch   2x10 px post (px 7..9) with texel sub-rect u 7..9 / v 6..16, top u 7..9 / v 6..8,
//           bottom u 7..9 / v 13..15 (only when the block below is not opaque); own-cell light,
//           ao 3, face 6 (unshaded, like Minecraft's "shade": false torch model).
//           Wall torches (registry WALL_FACE[id] >= 0): Minecraft's wall-torch model — the same post with
//           its base centred on the wall surface at 3/16 height, tilted toward WALL_FACE by a shear of
//           4 px over its 10 px height (21.8 degrees; Minecraft rotates by 22.5 degrees about the base,
//           which the 1/16 vertex grid cannot represent); the bottom end reaches 1 px into the wall.
//   liquid  Minecraft's fluid renderer: all ids of a liquid kind (source, flowing 1..7, falling) are one
//           liquid. Corner heights = weighted average of the (up to 4) cells around the corner
//           (BlockFluidRenderer.getFluidHeight: sources weight 11 at 8/9, flowing level L weight 1 at
//           1 - (L+1)/9, non-solid non-liquid cells weight 1 at 0, solid blocks ignored; full height if
//           one of them is falling or has the same liquid above), quantised to 1/16 (min 1/16) — shared
//           by every cell around a corner, so surfaces are seamless between levels and across chunks.
//           The top face (sloped, planar u/v) is drawn unless the same liquid is above; side faces toward
//           cells that are neither the same liquid nor opaque follow the corner heights (texel rows
//           match the trapezoid); bottom face only when the block below is neither liquid nor opaque;
//           anim 3; smooth light without AO (fluids have no ambient occlusion in Minecraft); the
//           surface takes max(sampled light, own cell light) so lava surfaces are fully bright.
//   cactus  Minecraft cactus model: sides inset by 1/16 along their normal but full width (texels 0..16, the
//           spines in columns 0/15 overhang the corners), top/bottom 14/16 (texels 1..15) flush at the block
//           boundary (culled by opaque blocks or another cactus), sides never culled.
//   chest   Minecraft chest: box 1..15 x 0..14 x 1..15 px with each face texture mapped in full (uniform
//           14/16 scale), front texture on the facing side and a 2x4x1 px latch (px 7..9 x 7..11) on
//           the front using texels u 7..9 / v 4..8 of the front texture. Own-cell light, directional
//           shade, no AO (Minecraft draws chests as unshaded-AO block entities).
//   crop    Minecraft crop model ('#'): planes at 4/16 and 12/16 along X and Z, 16 px tall from -1/16 to
//           15/16 (crops stand on 15/16-high farmland), each double-sided with the back mirrored like a
//           card; face 6, own-cell light, anim 1 on the top vertices.
//   farmland  15/16-high block: top at 15/16 (lit + AO from the layer above like a full top face), sides
//           v 1..16 culled by opaque blocks and other farmland, bottom culled by opaque blocks.
// Geometry may reach 1 px outside its cell (crop bottoms, wall-torch bases): positions stay within the
// SPEC §7 range p in [-1, 30].
//
// Smooth lighting (per vertex): the 4 cells in front of the vertex (p+N, side1, side2, corner);
// ao = (side1 && side2) ? 0 : 3 - (side1 + side2 + corner) (IS_OPAQUE); light = average of the
// non-opaque samples (corner excluded when both sides are opaque), stored x4. Faces that are inset
// from the block boundary (cactus sides) sample the block's own layer instead, like Minecraft.
// The quad diagonal is flipped (vertices emitted v1,v2,v3,v0) when ao0+ao2 < ao1+ao3, or, with
// equal AO sums, when light0+light2 < light1+light3.

import { REGION_VOLUME, DEFAULT_TINTS } from '../config.js';
import {
  BLOCKS, RENDER, TINT, IS_OPAQUE, IS_SOLID, IS_LIQUID, RENDER_TYPE, RENDER_LAYER, CULL_SAME, TINT_TYPE,
  FACE_LAYERS, FACE_ROTATION, LIQUID_KIND, LIQUID_LEVEL, WALL_FACE,
} from './registry.js';
import { computeLight, centerMaxY } from './lighting.js';

/** uint32 words per vertex / per quad. */
export const VERTEX_WORDS = 3;
export const QUAD_WORDS = 12;

const RS = 48;                    // region extent along X/Z
const LY = RS * RS;               // region index step along Y
const VOL = REGION_VOLUME;
const AXIS_STEP = [1, LY, RS];    // region index step along x, y, z

/** Region index offset of the face neighbour, by face index. */
const NOFF = Int32Array.of(1, -1, LY, -LY, RS, -RS);

// Face frames: normal axis/sign, texture U and V axes/signs, and the full face's (u=0, v=0) corner
// in px (block-local, 0..16). Axes: 0 = x, 1 = y, 2 = z.
const FACE_FRAMES = [
  { na: 0, ns: 1, ua: 2, us: -1, va: 1, vs: -1, o: [16, 16, 16] }, // 0 +X east  (u toward -Z)
  { na: 0, ns: -1, ua: 2, us: 1, va: 1, vs: -1, o: [0, 16, 0] },   // 1 -X west  (u toward +Z)
  { na: 1, ns: 1, ua: 0, us: 1, va: 2, vs: 1, o: [0, 16, 0] },     // 2 +Y top   (u +X, v +Z)
  { na: 1, ns: -1, ua: 0, us: 1, va: 2, vs: -1, o: [0, 0, 16] },   // 3 -Y bottom (u +X, v -Z)
  { na: 2, ns: 1, ua: 0, us: 1, va: 1, vs: -1, o: [0, 16, 16] },   // 4 +Z south (u toward +X)
  { na: 2, ns: -1, ua: 0, us: -1, va: 1, vs: -1, o: [16, 16, 0] }, // 5 -Z north (u toward -X)
];
// (u, v) of the four vertices in units of a full face: TL, BL, BR, TR (counter-clockwise from outside).
const QUAD_TV = [[0, 0], [0, 1], [1, 1], [1, 0]];

// Per face*4+vertex: whether the vertex sits at the max (1) or min (0) side of the box per axis.
const SELX = new Uint8Array(24), SELY = new Uint8Array(24), SELZ = new Uint8Array(24);
// Full-cube corner positions (px) and texel coordinates (plain and rotated by 90 degrees).
const CPX = new Int32Array(24), CPY = new Int32Array(24), CPZ = new Int32Array(24);
const CU = new Int32Array(24), CV = new Int32Array(24), RU = new Int32Array(24), RV = new Int32Array(24);
// Planar texture mapping per face: u = (P[ua] - o[ua]) * us, v = (P[va] - o[va]) * vs.
const FUA = new Int32Array(6), FUS = new Int32Array(6), FUO = new Int32Array(6);
const FVA = new Int32Array(6), FVS = new Int32Array(6), FVO = new Int32Array(6);
// Smooth lighting: 3x3 cells in the plane in front of the face, grid g = (b+1)*3 + (a+1) with a
// along +U-axis and b along +V-axis; per vertex the grid indices of side1, side2 and corner.
const OFF9 = new Int32Array(54);
const S1 = new Uint8Array(24), S2 = new Uint8Array(24), SC = new Uint8Array(24);

for (let f = 0; f < 6; f++) {
  const F = FACE_FRAMES[f];
  FUA[f] = F.ua; FUS[f] = F.us; FUO[f] = F.o[F.ua];
  FVA[f] = F.va; FVS[f] = F.vs; FVO[f] = F.o[F.va];
  for (let b = -1; b <= 1; b++) {
    for (let a = -1; a <= 1; a++) OFF9[f * 9 + (b + 1) * 3 + (a + 1)] = a * AXIS_STEP[F.ua] + b * AXIS_STEP[F.va];
  }
  for (let k = 0; k < 4; k++) {
    const [tu, tv] = QUAD_TV[k];
    const p = [0, 0, 0];
    p[F.na] = F.ns > 0 ? 16 : 0;
    p[F.ua] = F.o[F.ua] + tu * 16 * F.us;
    p[F.va] = F.o[F.va] + tv * 16 * F.vs;
    const fk = f * 4 + k;
    CPX[fk] = p[0]; CPY[fk] = p[1]; CPZ[fk] = p[2];
    SELX[fk] = p[0] ? 1 : 0; SELY[fk] = p[1] ? 1 : 0; SELZ[fk] = p[2] ? 1 : 0;
    CU[fk] = tu * 16; CV[fk] = tv * 16;
    RU[fk] = tv * 16; RV[fk] = 16 - tu * 16;   // 90 degree rotation (cyclic shift of the corners)
    const sa = p[F.ua] ? 1 : -1;
    const sb = p[F.va] ? 1 : -1;
    S1[fk] = 4 + sa;
    S2[fk] = 4 + 3 * sb;
    SC[fk] = 4 + sa + 3 * sb;
  }
}

// Cross plants: 4 quads x 4 vertices x (x, y, z, u, v) in px. Planes from 2/16 to 14/16
// (0.15/0.85 quantised to the 1/16 vertex grid); each plane twice with opposite winding, u running
// left-to-right as seen from that side so the sprite is never mirrored.
const CA = 2, CB = 14;
const CROSS_VERTS = Int8Array.from([
  CB, 16, CB, 0, 0, CB, 0, CB, 0, 16, CA, 0, CA, 16, 16, CA, 16, CA, 16, 0, // plane A, normal (+1,0,-1)
  CA, 16, CA, 0, 0, CA, 0, CA, 0, 16, CB, 0, CB, 16, 16, CB, 16, CB, 16, 0, // plane A, normal (-1,0,+1)
  CA, 16, CB, 0, 0, CA, 0, CB, 0, 16, CB, 0, CA, 16, 16, CB, 16, CA, 16, 0, // plane B, normal (+1,0,+1)
  CB, 16, CA, 0, 0, CB, 0, CA, 0, 16, CA, 0, CB, 16, 16, CA, 16, CB, 16, 0, // plane B, normal (-1,0,-1)
]);

// Crops: 8 quads x 4 vertices x (x, y, z, u, v) in px, counter-clockwise from the side each quad faces.
// Planes x = 4, x = 12 (u = z on both sides) and z = 4, z = 12 (u = 16 - x on both sides): the back of a
// plane shows the mirror image, like Minecraft's crop model (uv [16, 0, 0, 16] on the second face).
const CROP_VERTS = Int8Array.from([
  4, 15, 0, 0, 0, 4, -1, 0, 0, 16, 4, -1, 16, 16, 16, 4, 15, 16, 16, 0,       // x = 4, facing -X
  4, 15, 16, 16, 0, 4, -1, 16, 16, 16, 4, -1, 0, 0, 16, 4, 15, 0, 0, 0,       // x = 4, facing +X
  12, 15, 0, 0, 0, 12, -1, 0, 0, 16, 12, -1, 16, 16, 16, 12, 15, 16, 16, 0,   // x = 12, facing -X
  12, 15, 16, 16, 0, 12, -1, 16, 16, 16, 12, -1, 0, 0, 16, 12, 15, 0, 0, 0,   // x = 12, facing +X
  16, 15, 4, 0, 0, 16, -1, 4, 0, 16, 0, -1, 4, 16, 16, 0, 15, 4, 16, 0,       // z = 4, facing -Z
  0, 15, 4, 16, 0, 0, -1, 4, 16, 16, 16, -1, 4, 0, 16, 16, 15, 4, 0, 0,       // z = 4, facing +Z
  16, 15, 12, 0, 0, 16, -1, 12, 0, 16, 0, -1, 12, 16, 16, 0, 15, 12, 16, 0,   // z = 12, facing -Z
  0, 15, 12, 16, 0, 0, -1, 12, 16, 16, 16, -1, 12, 0, 16, 16, 15, 12, 0, 0,   // z = 12, facing +Z
]);

// Chests: the face carrying the front texture (the one horizontal face whose texture differs from the
// other three), -1 if none; and the latch box (px) in front of each horizontal face.
const CHEST_FRONT = new Int8Array(256).fill(-1);
for (const b of BLOCKS) {
  if (b.renderType !== 'chest') continue;
  const L = b.faceLayers;
  for (const f of [0, 1, 4, 5]) {
    const others = [0, 1, 4, 5].filter((g) => g !== f);
    if (others.every((g) => L[g] !== L[f]) && others.every((g) => L[g] === L[others[0]])) CHEST_FRONT[b.id] = f;
  }
}
const LATCH_BOX = [
  [15, 7, 7, 16, 11, 9],    // 0 +X
  [0, 7, 7, 1, 11, 9],      // 1 -X
  null, null,
  [7, 7, 15, 9, 11, 16],    // 4 +Z
  [7, 7, 0, 9, 11, 1],      // 5 -Z
];
const OPPOSITE_FACE = Uint8Array.of(1, 0, 3, 2, 5, 4);

// Per-block animation class and sway eligibility.
const ANIM = new Uint8Array(256);        // 2 = leaves, 3 = liquid (whole block)
const SWAYS = new Uint8Array(256);       // cross plants whose top vertices sway (anim 1)
for (const b of BLOCKS) {
  if (b.liquid) ANIM[b.id] = 3;
  else if (b.renderType === 'cube' && b.name.endsWith('_leaves')) ANIM[b.id] = 2;
  if (b.renderType === 'cross' && !b.name.endsWith('_mushroom')) SWAYS[b.id] = 1;
}

const packRGB = (c) => (c[0] | (c[1] << 8) | (c[2] << 16)) >>> 0;
const WHITE = 0xffffff;
const DEFAULT_GRASS = packRGB(DEFAULT_TINTS.grass);
const DEFAULT_FOLIAGE = packRGB(DEFAULT_TINTS.foliage);
const BIRCH_TINT = packRGB(DEFAULT_TINTS.birch);     // (128,167,85), SPEC §7
const SPRUCE_TINT = packRGB(DEFAULT_TINTS.spruce);   // (97,153,97)

// Light averaging: value x4 / count.
const AVG = Float64Array.of(0, 4, 2, 4 / 3, 1);

// ---------------------------------------------------------------------------------------------
// Per-job state (module level so the hot helpers stay monomorphic and allocation free)
// ---------------------------------------------------------------------------------------------
let RG = null;            // region blocks
let LT = null;            // region light
let SMOOTH = true;
let TG = null;            // grass tints (Uint32Array(256)) or null
let TF = null;            // foliage tints or null

// Grow-only scratch output per render layer (opaque, cutout, translucent).
const bufs = [new Uint32Array(1 << 16), new Uint32Array(1 << 15), new Uint32Array(1 << 15)];
const lens = new Int32Array(3);

// The quad being built.
const qx = new Int32Array(4), qy = new Int32Array(4), qz = new Int32Array(4);
const qu = new Int32Array(4), qv = new Int32Array(4);
const qao = new Int32Array(4), qsky = new Int32Array(4), qblk = new Int32Array(4), qan = new Int32Array(4);
// Smooth lighting samples.
const OP9 = new Uint8Array(9), LV9 = new Uint8Array(9);

function tintOf(id, x, z) {
  switch (TINT_TYPE[id]) {
    case TINT.GRASS: return TG ? TG[(z << 4) | x] & 0xffffff : DEFAULT_GRASS;
    case TINT.FOLIAGE: return TF ? TF[(z << 4) | x] & 0xffffff : DEFAULT_FOLIAGE;
    case TINT.BIRCH: return BIRCH_TINT;
    case TINT.SPRUCE: return SPRUCE_TINT;
    default: return WHITE;
  }
}

/** Append the current quad to a layer's scratch buffer (with the AO/light diagonal flip). */
function emit(layer, face, tex, tint) {
  let buf = bufs[layer];
  let n = lens[layer];
  if (n + QUAD_WORDS > buf.length) {
    const g = new Uint32Array(buf.length * 2);
    g.set(buf.subarray(0, n));
    bufs[layer] = buf = g;
  }
  const a02 = qao[0] + qao[2];
  const a13 = qao[1] + qao[3];
  let s = 0;
  if (a02 < a13) s = 1;
  else if (a02 === a13 && qsky[0] + qblk[0] + qsky[2] + qblk[2] < qsky[1] + qblk[1] + qsky[3] + qblk[3]) s = 1;
  const hi0 = face << 29;
  for (let t = 0; t < 4; t++) {
    const k = (t + s) & 3;
    buf[n] = (qx[k] + 16) | ((qy[k] + 16) << 9) | ((qz[k] + 16) << 18) | (qao[k] << 27) | hi0;
    buf[n + 1] = tex | (qu[k] << 8) | (qv[k] << 13) | (qsky[k] << 18) | (qblk[k] << 24) | (qan[k] << 30);
    buf[n + 2] = tint;
    n += 3;
  }
  lens[layer] = n;
}

/**
 * Smooth light (+ optional AO) for the current quad of face f. `base` = region index of the cell
 * layer the samples are taken from (p+N for faces on the block boundary), `own` = the block itself
 * (fallback light when every sample is opaque).
 */
function shadeSmooth(base, f, own, withAO) {
  const o9 = f * 9;
  for (let g = 0; g < 9; g++) {
    const j = base + OFF9[o9 + g];
    if (j < 0) { OP9[g] = 1; LV9[g] = 0; }               // below the world: solid
    else if (j >= VOL) { OP9[g] = 0; LV9[g] = 0xf0; }    // above the world: open sky
    else { OP9[g] = IS_OPAQUE[RG[j]]; LV9[g] = LT[j]; }
  }
  const c0 = OP9[4];
  const l0 = LV9[4];
  for (let k = 0; k < 4; k++) {
    const fk = f * 4 + k;
    const g1 = S1[fk], g2 = S2[fk], gc = SC[fk];
    const o1 = OP9[g1], o2 = OP9[g2], oc = OP9[gc];
    const both = o1 & o2;
    qao[k] = withAO ? (both ? 0 : 3 - (o1 + o2 + oc)) : 3;
    let ss = 0, bs = 0, cnt = 0;
    if (c0 === 0) { ss += l0 >> 4; bs += l0 & 15; cnt++; }
    if (o1 === 0) { const l = LV9[g1]; ss += l >> 4; bs += l & 15; cnt++; }
    if (o2 === 0) { const l = LV9[g2]; ss += l >> 4; bs += l & 15; cnt++; }
    if (oc === 0 && both === 0) { const l = LV9[gc]; ss += l >> 4; bs += l & 15; cnt++; }
    if (cnt === 0) {
      const l = LT[own];
      qsky[k] = (l >> 4) << 2;
      qblk[k] = (l & 15) << 2;
    } else {
      const m = AVG[cnt];
      qsky[k] = (ss * m + 0.5) | 0;
      qblk[k] = (bs * m + 0.5) | 0;
    }
  }
}

/** Flat light: the light of `base` (or of the block itself when base is opaque) on all 4 vertices. */
function shadeFlat(base, own) {
  let l;
  if (base < 0) l = LT[own];
  else if (base >= VOL) l = 0xf0;
  else l = IS_OPAQUE[RG[base]] === 1 ? LT[own] : LT[base];
  const s = (l >> 4) << 2, b = (l & 15) << 2;
  for (let k = 0; k < 4; k++) { qsky[k] = s; qblk[k] = b; qao[k] = 3; }
}

/** Light of the block's own cell, ao 3 (cross plants, torches). */
function shadeOwn(own) {
  const l = LT[own];
  const s = (l >> 4) << 2, b = (l & 15) << 2;
  for (let k = 0; k < 4; k++) { qsky[k] = s; qblk[k] = b; qao[k] = 3; }
}

function shade(base, f, own, withAO) {
  if (SMOOTH) shadeSmooth(base, f, own, withAO);
  else shadeFlat(base, own);
}

/**
 * Fill the quad positions/texels for face f of the box [x0,x1]x[y0,y1]x[z0,z1] (block-local px)
 * using the full face's planar texture mapping (+ texel offset du, dv).
 */
function boxFace(f, bx, by, bz, x0, y0, z0, x1, y1, z1, du, dv, anim) {
  const ua = FUA[f], us = FUS[f], uo = FUO[f];
  const va = FVA[f], vs = FVS[f], vo = FVO[f];
  for (let k = 0; k < 4; k++) {
    const fk = f * 4 + k;
    const px = SELX[fk] ? x1 : x0;
    const py = SELY[fk] ? y1 : y0;
    const pz = SELZ[fk] ? z1 : z0;
    qx[k] = bx + px; qy[k] = by + py; qz[k] = bz + pz;
    const pu = ua === 0 ? px : ua === 1 ? py : pz;
    const pv = va === 0 ? px : va === 1 ? py : pz;
    qu[k] = (pu - uo) * us + du;
    qv[k] = (pv - vo) * vs + dv;
    qan[k] = anim;
  }
}

// ---------------------------------------------------------------------------------------------
// Render types. (i = region index, y = world y, bx/by/bz = block origin relative to the section in px)
// ---------------------------------------------------------------------------------------------

function meshCube(i, id, y, bx, by, bz, tint) {
  const layer = RENDER_LAYER[id];
  const anim = ANIM[id];
  const cullSame = CULL_SAME[id];
  const id6 = id * 6;
  for (let f = 0; f < 6; f++) {
    let nb;
    if (f === 2) nb = y < 255 ? RG[i + LY] : 0;
    else if (f === 3) {
      if (y === 0) continue;                 // never visible: nothing below the world
      nb = RG[i - LY];
    } else nb = RG[i + NOFF[f]];
    if (IS_OPAQUE[nb] === 1 || (cullSame === 1 && nb === id)) continue;
    if (f === 2 && RENDER_TYPE[nb] === RENDER.FARMLAND) continue;   // covered by farmland's full bottom
    const rot = FACE_ROTATION[id6 + f];
    const f4 = f * 4;
    for (let k = 0; k < 4; k++) {
      const fk = f4 + k;
      qx[k] = bx + CPX[fk];
      qy[k] = by + CPY[fk];
      qz[k] = bz + CPZ[fk];
      if (rot === 1) { qu[k] = RU[fk]; qv[k] = RV[fk]; } else { qu[k] = CU[fk]; qv[k] = CV[fk]; }
      qan[k] = anim;
    }
    shade(i + NOFF[f], f, i, true);
    emit(layer, f, FACE_LAYERS[id6 + f], tint);
  }
}

function meshCross(i, id, y, bx, by, bz, tint) {
  shadeOwn(i);
  // Stacked plants (sugar cane) only sway at the top of the stack so the joints stay closed.
  const sway = SWAYS[id] === 1 && (y >= 255 || RG[i + LY] !== id) ? 1 : 0;
  const layer = RENDER_LAYER[id];
  const tex = FACE_LAYERS[id * 6];
  for (let q = 0; q < 4; q++) {
    for (let k = 0; k < 4; k++) {
      const o = (q * 4 + k) * 5;
      qx[k] = bx + CROSS_VERTS[o];
      qy[k] = by + CROSS_VERTS[o + 1];
      qz[k] = bz + CROSS_VERTS[o + 2];
      qu[k] = CROSS_VERTS[o + 3];
      qv[k] = CROSS_VERTS[o + 4];
      qan[k] = CROSS_VERTS[o + 1] === 16 ? sway : 0;
    }
    emit(layer, 6, tex, tint);
  }
}

function meshTorch(i, id, y, bx, by, bz, tint) {
  const wall = WALL_FACE[id];
  if (wall >= 0) {
    meshWallTorch(i, id, bx, by, bz, tint, wall);
    return;
  }
  const layer = RENDER_LAYER[id];
  const id6 = id * 6;
  shadeOwn(i);
  for (let f = 0; f < 6; f++) {
    let dv = 0;
    if (f === 2) dv = -1;                     // top: u 7..9, v 6..8 (the lit end of the stick)
    else if (f === 3) {                       // bottom: u 7..9, v 13..15; hidden on opaque ground
      if (y === 0 || IS_OPAQUE[RG[i - LY]] === 1) continue;
      dv = 6;
    }
    boxFace(f, bx, by, bz, 7, 0, 7, 9, 10, 9, 0, dv, 0);
    emit(layer, 6, FACE_LAYERS[id6 + f], tint);
  }
}

/**
 * Wall torch pointing toward face `wall` (0 +X, 1 -X, 4 +Z, 5 -Z): the floor-torch post sheared away
 * from the wall (d = distance from the wall: -1..1 at the base, 3..5 at the top), lifted to 3/16 and
 * rotated into place. Shear and rotation preserve orientation, so the winding stays counter-clockwise.
 */
function meshWallTorch(i, id, bx, by, bz, tint, wall) {
  const layer = RENDER_LAYER[id];
  const id6 = id * 6;
  shadeOwn(i);
  for (let f = 0; f < 6; f++) {
    const dv = f === 2 ? -1 : f === 3 ? 6 : 0;
    boxFace(f, 0, 0, 0, 7, 0, 7, 9, 10, 9, 0, dv, 0);
    for (let k = 0; k < 4; k++) {
      const ly = qy[k];
      const d = qx[k] - 8 + ((ly * 2) / 5);   // 4 px of shear over the 10 px post (integer: ly is 0 or 10)
      const l = qz[k];                        // lateral position 7..9
      let X, Z;
      if (wall === 0) { X = d; Z = l; }
      else if (wall === 1) { X = 16 - d; Z = 16 - l; }
      else if (wall === 4) { X = 16 - l; Z = d; }
      else { X = l; Z = 16 - d; }
      qx[k] = bx + X;
      qy[k] = by + ly + 3;
      qz[k] = bz + Z;
    }
    emit(layer, 6, FACE_LAYERS[id6 + f], tint);
  }
}

// ---- liquids ------------------------------------------------------------------------------------

// Corner heights (px, 1..16) of the liquid cell being meshed, index x | z << 1 (0 = -X-Z corner).
const CH = new Int32Array(4);

/**
 * Minecraft corner height (BlockFluidRenderer.getFluidHeight) of the corner shared by the cells i, i+dx,
 * i+dz and i+dx+dz (region index offsets): full height if one of them is a falling cell of `kind` or has
 * `kind` above it; otherwise 1 - weighted mean depth, depth in ninths: source (L 0) weight 11 at 1/9,
 * flowing level L weight 1 at (L+1)/9, non-solid non-liquid cells weight 1 at 9/9 (height 0), solid
 * blocks ignored. Quantised to whole px, at least 1 px.
 */
function cornerHeight(i, dx, dz, kind, hasAbove) {
  let depth = 0;
  let weight = 0;
  for (let c = 0; c < 4; c++) {
    const j = i + ((c & 1) !== 0 ? dx : 0) + ((c & 2) !== 0 ? dz : 0);
    const id = RG[j];
    if (LIQUID_KIND[id] === kind) {
      const l = LIQUID_LEVEL[id];
      if (l >= 8 || (hasAbove && LIQUID_KIND[RG[j + LY]] === kind)) return 16;
      if (l === 0) { depth += 11; weight += 11; } else { depth += l + 1; weight += 1; }
    } else if (IS_SOLID[id] === 0) {
      depth += 9;
      weight += 1;
    }
  }
  const px = Math.round(16 - (16 * depth) / (9 * weight));
  return px < 1 ? 1 : px > 16 ? 16 : px;
}

/** boxFace of the full cell with the top vertices raised to the corner heights CH (v follows on sides). */
function liquidFace(f, bx, by, bz) {
  boxFace(f, bx, by, bz, 0, 0, 0, 16, 16, 16, 0, 0, 3);
  const f4 = f * 4;
  for (let k = 0; k < 4; k++) {
    const fk = f4 + k;
    if (SELY[fk] === 0) continue;
    const h = CH[SELX[fk] | (SELZ[fk] << 1)];
    qy[k] = by + h;
    if (f !== 2) qv[k] = 16 - h;
  }
}

function meshLiquid(i, id, y, bx, by, bz, tint) {
  const kind = LIQUID_KIND[id];
  const layer = RENDER_LAYER[id];
  const id6 = id * 6;
  const hasAbove = y < 255;
  const covered = hasAbove && LIQUID_KIND[RG[i + LY]] === kind;
  let sides = 0;
  for (let f = 0; f < 6; f++) {
    if (f === 2 || f === 3) continue;
    const nb = RG[i + NOFF[f]];
    if (IS_OPAQUE[nb] === 0 && LIQUID_KIND[nb] !== kind) sides |= 1 << f;
  }
  if (covered) {
    CH[0] = CH[1] = CH[2] = CH[3] = 16;
  } else {
    CH[0] = cornerHeight(i, -1, -RS, kind, hasAbove);
    CH[1] = cornerHeight(i, 1, -RS, kind, hasAbove);
    CH[2] = cornerHeight(i, -1, RS, kind, hasAbove);
    CH[3] = cornerHeight(i, 1, RS, kind, hasAbove);
    // Top surface (also under opaque blocks: it is visible through the gap, like Minecraft).
    liquidFace(2, bx, by, bz);
    shade(i + LY, 2, i, false);
    // Like Minecraft's fluid renderer the surface is lit by max(own cell, cell above): this is
    // what makes a lava surface fully bright (its own cell holds block light 15).
    const own = LT[i];
    const os = (own >> 4) << 2, ob = (own & 15) << 2;
    for (let k = 0; k < 4; k++) {
      if (qsky[k] < os) qsky[k] = os;
      if (qblk[k] < ob) qblk[k] = ob;
    }
    emit(layer, 2, FACE_LAYERS[id6 + 2], tint);
  }
  // Bottom (only above air / non-opaque, non-liquid blocks).
  if (y > 0) {
    const below = RG[i - LY];
    if (IS_LIQUID[below] === 0 && IS_OPAQUE[below] === 0) {
      boxFace(3, bx, by, bz, 0, 0, 0, 16, 16, 16, 0, 0, 3);
      shade(i - LY, 3, i, false);
      emit(layer, 3, FACE_LAYERS[id6 + 3], tint);
    }
  }
  // Sides toward cells that are neither this liquid nor opaque, up to the corner heights.
  if (sides === 0) return;
  for (let f = 0; f < 6; f++) {
    if ((sides & (1 << f)) === 0) continue;
    liquidFace(f, bx, by, bz);
    shade(i + NOFF[f], f, i, false);
    emit(layer, f, FACE_LAYERS[id6 + f], tint);
  }
}

// ---- chests, crops, farmland ----------------------------------------------------------------------

/** Texel rectangle [u0,u1] x [v0,v1] spread over the current quad (whose corners came from boxFace f). */
function quadUV(f, u0, v0, u1, v1) {
  const f4 = f * 4;
  for (let k = 0; k < 4; k++) {
    qu[k] = CU[f4 + k] === 0 ? u0 : u1;
    qv[k] = CV[f4 + k] === 0 ? v0 : v1;
  }
}

function meshChest(i, id, y, bx, by, bz, tint) {
  const layer = RENDER_LAYER[id];
  const id6 = id * 6;
  shadeOwn(i);
  for (let f = 0; f < 6; f++) {
    // Only the bottom lies on the block boundary (culled by opaque ground); the other faces are inset.
    if (f === 3 && (y === 0 || IS_OPAQUE[RG[i - LY]] === 1)) continue;
    boxFace(f, bx, by, bz, 1, 0, 1, 15, 14, 15, 0, 0, 0);
    quadUV(f, 0, 0, 16, 16);
    emit(layer, f, FACE_LAYERS[id6 + f], tint);
  }
  const front = CHEST_FRONT[id];
  if (front < 0 || IS_OPAQUE[RG[i + NOFF[front]]] === 1) return;
  const b = LATCH_BOX[front];
  const tex = FACE_LAYERS[id6 + front];
  const back = OPPOSITE_FACE[front];
  for (let f = 0; f < 6; f++) {
    if (f === back) continue;
    boxFace(f, bx, by, bz, b[0], b[1], b[2], b[3], b[4], b[5], 0, 0, 0);
    if (f === front) quadUV(f, 7, 4, 9, 8);               // the latch picture: 2 x 4 texels
    else if (f === 2) quadUV(f, 7, 4, 9, 5);
    else if (f === 3) quadUV(f, 7, 7, 9, 8);
    else quadUV(f, 7, 4, 8, 8);                           // 1 px deep sides
    emit(layer, f, tex, tint);
  }
}

function meshCrop(i, id, y, bx, by, bz, tint) {
  shadeOwn(i);
  const layer = RENDER_LAYER[id];
  const tex = FACE_LAYERS[id * 6];
  for (let q = 0; q < 8; q++) {
    for (let k = 0; k < 4; k++) {
      const o = (q * 4 + k) * 5;
      qx[k] = bx + CROP_VERTS[o];
      qy[k] = by + CROP_VERTS[o + 1];
      qz[k] = bz + CROP_VERTS[o + 2];
      qu[k] = CROP_VERTS[o + 3];
      qv[k] = CROP_VERTS[o + 4];
      qan[k] = CROP_VERTS[o + 1] === 15 ? 1 : 0;
    }
    emit(layer, 6, tex, tint);
  }
}

function meshFarmland(i, id, y, bx, by, bz, tint) {
  const layer = RENDER_LAYER[id];
  const id6 = id * 6;
  // Top at 15/16: always visible (also under a block: through the 1 px gap); lit like a full top face.
  boxFace(2, bx, by, bz, 0, 0, 0, 16, 15, 16, 0, 0, 0);
  shade(i + LY, 2, i, true);
  emit(layer, 2, FACE_LAYERS[id6 + 2], tint);
  if (y > 0 && IS_OPAQUE[RG[i - LY]] === 0) {
    boxFace(3, bx, by, bz, 0, 0, 0, 16, 15, 16, 0, 0, 0);
    shade(i - LY, 3, i, true);
    emit(layer, 3, FACE_LAYERS[id6 + 3], tint);
  }
  for (let f = 0; f < 6; f++) {
    if (f === 2 || f === 3) continue;
    const nb = RG[i + NOFF[f]];
    if (IS_OPAQUE[nb] === 1 || RENDER_TYPE[nb] === RENDER.FARMLAND) continue;
    boxFace(f, bx, by, bz, 0, 0, 0, 16, 15, 16, 0, 0, 0);   // planar mapping: texel rows 1..16
    shade(i + NOFF[f], f, i, true);
    emit(layer, f, FACE_LAYERS[id6 + f], tint);
  }
}

function meshCactus(i, id, y, bx, by, bz, tint) {
  const layer = RENDER_LAYER[id];
  const id6 = id * 6;
  const above = y < 255 ? RG[i + LY] : 0;
  if (IS_OPAQUE[above] === 0 && above !== id) {
    boxFace(2, bx, by, bz, 1, 0, 1, 15, 16, 15, 0, 0, 0);
    shade(i + LY, 2, i, true);
    emit(layer, 2, FACE_LAYERS[id6 + 2], tint);
  }
  if (y > 0) {
    const below = RG[i - LY];
    if (IS_OPAQUE[below] === 0 && below !== id) {
      boxFace(3, bx, by, bz, 1, 0, 1, 15, 16, 15, 0, 0, 0);
      shade(i - LY, 3, i, true);
      emit(layer, 3, FACE_LAYERS[id6 + 3], tint);
    }
  }
  for (let f = 0; f < 6; f++) {
    if (f === 2 || f === 3) continue;
    // Minecraft's cactus model: each side is inset by 1/16 along its normal but spans the full width
    // (texels 0..16), so the spines in texture columns 0 / 15 stick out past the corners (cutout).
    // Never culled, lit from the block's own layer.
    if (f < 2) boxFace(f, bx, by, bz, 1, 0, 0, 15, 16, 16, 0, 0, 0);
    else boxFace(f, bx, by, bz, 0, 0, 1, 16, 16, 15, 0, 0, 0);
    shade(i, f, i, true);
    emit(layer, f, FACE_LAYERS[id6 + f], tint);
  }
}

// ---------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------

/** True if the centre chunk's section sy contains only air. */
function sectionIsEmpty(region, w32, sy) {
  const y0 = sy << 4;
  for (let y = y0; y < y0 + 16; y++) {
    for (let z = 0; z < 16; z++) {
      const row = (y * RS + z + 16) * RS + 16;
      if (w32) {
        const k = row >> 2;
        if ((w32[k] | w32[k + 1] | w32[k + 2] | w32[k + 3]) !== 0) return false;
      } else {
        for (let x = 0; x < 16; x++) if (region[row + x] !== 0) return false;
      }
    }
  }
  return true;
}

function meshSection(w32, sy, yMax) {
  const y0 = sy << 4;
  const y1 = Math.min(y0 + 15, yMax);
  for (let y = y0; y <= y1; y++) {
    const by = (y - y0) << 4;
    for (let z = 0; z < 16; z++) {
      const row = (y * RS + z + 16) * RS + 16;
      if (w32) {
        const k = row >> 2;
        if ((w32[k] | w32[k + 1] | w32[k + 2] | w32[k + 3]) === 0) continue;   // 16 air blocks
      }
      const bz = z << 4;
      for (let x = 0; x < 16; x++) {
        const i = row + x;
        const id = RG[i];
        if (id === 0) continue;
        const rt = RENDER_TYPE[id];
        if (rt === RENDER.NONE) continue;
        const bx = x << 4;
        const tint = tintOf(id, x, z);
        if (rt === RENDER.CUBE) meshCube(i, id, y, bx, by, bz, tint);
        else if (rt === RENDER.CROSS) meshCross(i, id, y, bx, by, bz, tint);
        else if (rt === RENDER.LIQUID) meshLiquid(i, id, y, bx, by, bz, tint);
        else if (rt === RENDER.TORCH) meshTorch(i, id, y, bx, by, bz, tint);
        else if (rt === RENDER.CACTUS) meshCactus(i, id, y, bx, by, bz, tint);
        else if (rt === RENDER.CHEST) meshChest(i, id, y, bx, by, bz, tint);
        else if (rt === RENDER.CROP) meshCrop(i, id, y, bx, by, bz, tint);
        else if (rt === RENDER.FARMLAND) meshFarmland(i, id, y, bx, by, bz, tint);
      }
    }
  }
}

function takeLayer(l) {
  const n = lens[l];
  return n === 0 ? null : bufs[l].slice(0, n);
}

/**
 * Build the meshes of the requested sections of the centre chunk of a region.
 * @param {Uint8Array} region result of buildRegion()
 * @param {Uint8Array} light result of computeLight(region) (computed here when null/undefined)
 * @param {number} sectionMask 16-bit mask, bit sy = mesh section sy
 * @param {{grass: Uint32Array, foliage: Uint32Array}|null} tints centre-chunk biome colours, index
 *   z*16+x, packed r|g<<8|b<<16 (WorldGenerator.getTints); null = DEFAULT_TINTS
 * @param {{smoothLighting?: boolean}} [options]
 * @returns {Array<{sy: number, opaque: Uint32Array|null, cutout: Uint32Array|null, translucent: Uint32Array|null}>}
 *   one entry per requested section in ascending sy order; layers without geometry are null.
 *   Arrays are exact-size copies (safe to transfer).
 */
export function meshChunk(region, light, sectionMask, tints, options = { smoothLighting: true }) {
  if (!region || region.length !== VOL) throw new RangeError(`region must have ${VOL} bytes`);
  if (!light) light = computeLight(region);
  else if (light.length !== VOL) throw new RangeError(`light must have ${VOL} bytes`);
  const mask = typeof sectionMask === 'number' ? sectionMask & 0xffff : 0xffff;
  const result = [];
  const w32 = (region.byteOffset & 3) === 0 ? new Uint32Array(region.buffer, region.byteOffset, VOL >> 2) : null;
  const yMax = centerMaxY(region);
  RG = region;
  LT = light;
  SMOOTH = !options || options.smoothLighting !== false;
  TG = tints && tints.grass ? tints.grass : null;
  TF = tints && tints.foliage ? tints.foliage : null;
  try {
    for (let sy = 0; sy < 16; sy++) {
      if ((mask & (1 << sy)) === 0) continue;
      const entry = { sy, opaque: null, cutout: null, translucent: null };
      result.push(entry);
      if ((sy << 4) > yMax || sectionIsEmpty(region, w32, sy)) continue;
      lens[0] = lens[1] = lens[2] = 0;
      meshSection(w32, sy, yMax);
      entry.opaque = takeLayer(0);
      entry.cutout = takeLayer(1);
      entry.translucent = takeLayer(2);
    }
  } finally {
    lens[0] = lens[1] = lens[2] = 0;
    RG = null;
    LT = null;
    TG = null;
    TF = null;
  }
  return result;
}

/**
 * Decode one vertex (debugging / tests).
 * @returns {{x:number,y:number,z:number,ao:number,face:number,layer:number,u:number,v:number,
 *   sky:number,block:number,anim:number,r:number,g:number,b:number}} x,y,z in blocks relative to
 *   the section origin; sky/block are the stored x4 values (0..60, divide by 4 for the level).
 */
export function decodeVertex(w0, w1, w2) {
  w0 >>>= 0; w1 >>>= 0; w2 >>>= 0;
  return {
    x: ((w0 & 511) - 16) / 16,
    y: (((w0 >>> 9) & 511) - 16) / 16,
    z: (((w0 >>> 18) & 511) - 16) / 16,
    ao: (w0 >>> 27) & 3,
    face: (w0 >>> 29) & 7,
    layer: w1 & 255,
    u: (w1 >>> 8) & 31,
    v: (w1 >>> 13) & 31,
    sky: (w1 >>> 18) & 63,
    block: (w1 >>> 24) & 63,
    anim: (w1 >>> 30) & 3,
    r: w2 & 255,
    g: (w2 >>> 8) & 255,
    b: (w2 >>> 16) & 255,
  };
}

/**
 * Decode a whole mesh into quads (debugging / tests): [{ verts: [decodeVertex x4] }].
 * @param {Uint32Array} mesh
 */
export function decodeMesh(mesh) {
  const quads = [];
  if (!mesh) return quads;
  for (let q = 0; q + QUAD_WORDS <= mesh.length; q += QUAD_WORDS) {
    const verts = [];
    for (let k = 0; k < 4; k++) verts.push(decodeVertex(mesh[q + k * 3], mesh[q + k * 3 + 1], mesh[q + k * 3 + 2]));
    quads.push({ verts });
  }
  return quads;
}
