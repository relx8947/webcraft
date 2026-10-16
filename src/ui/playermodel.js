// Player preview for the inventory screens, rendered on a 2D canvas: the blocky character is made of
// textured boxes (classic 64x64 skin layout) projected orthographically; every visible face is an
// affine-mapped drawImage with image smoothing off, so skin texels stay perfectly crisp. It turns its
// body and head toward the mouse like Minecraft's inventory model (atan(d / 40) rule) and idly sways
// its arms. Faces are back-face culled and depth sorted (painter's algorithm). render() runs every
// frame while an inventory is open and does not allocate (preallocated matrices / face records).
import { paintSkin } from './assets.js';

let skinCanvas = null;

function skin() {
  if (!skinCanvas) skinCanvas = paintSkin();
  return skinCanvas;
}

// Light direction (front-top-right), normalised.
const LX = 0.35 / Math.hypot(0.35, 0.75, 1);
const LY = 0.75 / Math.hypot(0.35, 0.75, 1);
const LZ = 1 / Math.hypot(0.35, 0.75, 1);

// Box corner index = x | y << 1 | z << 2 (bit set = max side). Faces: [axis, sign, TL, TR, BL] where
// TL/TR/BL are the corners at the texture's top-left, top-right and bottom-left as seen from outside.
const FACES = [
  [2, 1, 6, 7, 4],   // front (+z)
  [2, -1, 3, 2, 1],  // back (-z)
  [0, -1, 2, 6, 0],  // right side of the character (-x)
  [0, 1, 7, 3, 5],   // left side (+x)
  [1, 1, 2, 3, 6],   // top
  [1, -1, 4, 5, 0],  // bottom
];

/** Texture rect for face f of a box with size (w, h, d) at UV (u, v) — classic box UV layout. */
function faceUV(f, u, v, w, h, d) {
  switch (f) {
    case 0: return [u + d, v + d, w, h];
    case 1: return [u + d + w + d, v + d, w, h];
    case 2: return [u, v + d, d, h];
    case 3: return [u + d + w, v + d, d, h];
    case 4: return [u + d, v, w, d];
    default: return [u + d + w, v, w, d];
  }
}

/** Body parts: size, pivot (skin px, origin = feet centre, y up), box centre offset from the pivot, UV. */
const PARTS = [
  { kind: 0, size: [4, 12, 4], pivot: [-2, 12, 0], offset: [0, -6, 0], uv: [0, 16] },   // right leg
  { kind: 0, size: [4, 12, 4], pivot: [2, 12, 0], offset: [0, -6, 0], uv: [16, 48] },   // left leg
  { kind: 0, size: [8, 12, 4], pivot: [0, 24, 0], offset: [0, -6, 0], uv: [16, 16] },   // body
  { kind: 1, size: [4, 12, 4], pivot: [-5, 22, 0], offset: [-1, -4, 0], uv: [40, 16] }, // right arm
  { kind: 2, size: [4, 12, 4], pivot: [5, 22, 0], offset: [1, -4, 0], uv: [32, 48] },   // left arm
  { kind: 3, size: [8, 8, 8], pivot: [0, 24, 0], offset: [0, 4, 0], uv: [0, 0] },       // head
].map((p) => ({ ...p, uvs: [0, 1, 2, 3, 4, 5].map((f) => faceUV(f, p.uv[0], p.uv[1], ...p.size)) }));

/** 3x3 rotation helpers writing into a Float64Array(9) (row-major). */
function setRotXY(m, ax, ay) {
  // R = Rx(ax) * Ry(ay)
  const cx = Math.cos(ax), sx = Math.sin(ax), cy = Math.cos(ay), sy = Math.sin(ay);
  m[0] = cy; m[1] = 0; m[2] = sy;
  m[3] = sx * sy; m[4] = cx; m[5] = -sx * cy;
  m[6] = -cx * sy; m[7] = sx; m[8] = cx * cy;
}
function setRotYX(m, ay, ax) {
  // R = Ry(ay) * Rx(ax)
  const cx = Math.cos(ax), sx = Math.sin(ax), cy = Math.cos(ay), sy = Math.sin(ay);
  m[0] = cy; m[1] = sy * sx; m[2] = sy * cx;
  m[3] = 0; m[4] = cx; m[5] = -sx;
  m[6] = -sy; m[7] = cy * sx; m[8] = cy * cx;
}
function setRotXZ(m, ax, az) {
  // R = Rx(ax) * Rz(az)
  const cx = Math.cos(ax), sx = Math.sin(ax), cz = Math.cos(az), sz = Math.sin(az);
  m[0] = cz; m[1] = -sz; m[2] = 0;
  m[3] = cx * sz; m[4] = cx * cz; m[5] = -sx;
  m[6] = sx * sz; m[7] = sx * cz; m[8] = cx;
}
function mul3(out, a, b) {
  for (let r = 0; r < 3; r++) {
    const a0 = a[r * 3], a1 = a[r * 3 + 1], a2 = a[r * 3 + 2];
    out[r * 3] = a0 * b[0] + a1 * b[3] + a2 * b[6];
    out[r * 3 + 1] = a0 * b[1] + a1 * b[4] + a2 * b[7];
    out[r * 3 + 2] = a0 * b[2] + a1 * b[5] + a2 * b[8];
  }
}

export class PlayerModel {
  constructor() {
    this.el = document.createElement('canvas');
    this.el.className = 'player-model';
    this.ctx = this.el.getContext('2d');
    this.yaw = 0;
    this.headYaw = 0;
    this.pitch = 0;
    this.width = 0;
    this.height = 0;
    this.pixel = 1;
    this.feet = 0;
    // scratch
    this.body = new Float64Array(9);
    this.part = new Float64Array(9);
    this.full = new Float64Array(9);
    this.corners = new Float64Array(24);
    this.faces = Array.from({ length: PARTS.length * 6 }, () => ({
      uv: null, ax: 0, ay: 0, bx: 0, by: 0, cx: 0, cy: 0, depth: 0, light: 1,
    }));
    this.order = [];
  }

  /**
   * Size the canvas in device pixels.
   * @param {number} w,h      canvas size (device px)
   * @param {number} pixel    device px per skin pixel
   * @param {number} feet     distance of the feet from the canvas bottom (device px)
   */
  setSize(w, h, pixel, feet) {
    w = Math.max(1, Math.round(w));
    h = Math.max(1, Math.round(h));
    if (w !== this.width || h !== this.height) {
      this.width = w;
      this.height = h;
      this.el.width = w;
      this.el.height = h;
    }
    this.pixel = pixel;
    this.feet = feet;
  }

  /** Face a point (dx, dy) in GUI pixels relative to the model's eyes (Minecraft's atan(d/40) rule). */
  lookAt(dx, dy) {
    const a = Math.atan(dx / 40) * 20 * Math.PI / 180;
    this.yaw = a;
    this.headYaw = a;
    this.pitch = Math.atan(dy / 40) * 20 * Math.PI / 180;
  }

  /** Draw the model. `time` (seconds) drives the idle arm sway. */
  render(time = 0) {
    const g = this.ctx;
    if (!this.width) return;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.width, this.height);
    g.imageSmoothingEnabled = false;
    const tex = skin();
    const s = this.pixel;
    const ox = this.width / 2;
    const oy = this.height - this.feet;
    const swingZ = Math.cos(time * 1.8) * 0.05 + 0.05;
    const swingX = Math.sin(time * 1.34) * 0.05;
    const B = this.body;
    setRotXY(B, this.pitch * 0.35, this.yaw);
    const P = this.part;
    const M = this.full;
    const C = this.corners;
    let nFaces = 0;
    for (let pi = 0; pi < PARTS.length; pi++) {
      const p = PARTS[pi];
      if (p.kind === 3) setRotYX(P, this.headYaw, this.pitch);
      else if (p.kind === 1) setRotXZ(P, swingX, -swingZ);
      else if (p.kind === 2) setRotXZ(P, -swingX, swingZ);
      else { P[0] = 1; P[1] = 0; P[2] = 0; P[3] = 0; P[4] = 1; P[5] = 0; P[6] = 0; P[7] = 0; P[8] = 1; }
      mul3(M, B, P);
      // translation = B * pivot
      const px = p.pivot[0], py = p.pivot[1], pz = p.pivot[2];
      const tx = B[0] * px + B[1] * py + B[2] * pz;
      const ty = B[3] * px + B[4] * py + B[5] * pz;
      const tz = B[6] * px + B[7] * py + B[8] * pz;
      const hw = p.size[0] / 2, hh = p.size[1] / 2, hd = p.size[2] / 2;
      for (let c = 0; c < 8; c++) {
        const x = p.offset[0] + (c & 1 ? hw : -hw);
        const y = p.offset[1] + (c & 2 ? hh : -hh);
        const z = p.offset[2] + (c & 4 ? hd : -hd);
        C[c * 3] = M[0] * x + M[1] * y + M[2] * z + tx;
        C[c * 3 + 1] = M[3] * x + M[4] * y + M[5] * z + ty;
        C[c * 3 + 2] = M[6] * x + M[7] * y + M[8] * z + tz;
      }
      for (let f = 0; f < 6; f++) {
        const F = FACES[f];
        const axis = F[0], sign = F[1], tl = F[2], tr = F[3], bl = F[4];
        // view-space normal = sign * column `axis` of M
        const nx = sign * M[axis], ny = sign * M[3 + axis], nz = sign * M[6 + axis];
        if (nz <= 1e-4) continue;
        const rec = this.faces[nFaces++];
        rec.uv = p.uvs[f];
        rec.ax = ox + C[tl * 3] * s; rec.ay = oy - C[tl * 3 + 1] * s;
        rec.bx = ox + C[tr * 3] * s; rec.by = oy - C[tr * 3 + 1] * s;
        rec.cx = ox + C[bl * 3] * s; rec.cy = oy - C[bl * 3 + 1] * s;
        rec.depth = (C[tr * 3 + 2] + C[bl * 3 + 2]) * 0.5;
        rec.light = Math.min(1, 0.6 + 0.5 * Math.max(0, nx * LX + ny * LY + nz * LZ));
      }
    }
    const order = this.order;
    order.length = nFaces;
    for (let i = 0; i < nFaces; i++) order[i] = this.faces[i];
    order.sort(byDepth);
    g.fillStyle = '#000';
    for (let i = 0; i < nFaces; i++) {
      const f = order[i];
      const u = f.uv[0], v = f.uv[1], tw = f.uv[2], th = f.uv[3];
      g.setTransform((f.bx - f.ax) / tw, (f.by - f.ay) / tw, (f.cx - f.ax) / th, (f.cy - f.ay) / th, f.ax, f.ay);
      g.drawImage(tex, u, v, tw, th, 0, 0, tw, th);
      if (f.light < 0.999) {
        g.globalAlpha = 1 - f.light;
        g.fillRect(0, 0, tw, th);
        g.globalAlpha = 1;
      }
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
  }
}

function byDepth(a, b) {
  return a.depth - b.depth;
}
