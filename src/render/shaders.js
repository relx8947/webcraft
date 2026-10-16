// GLSL ES 3.00 sources for the world renderer (SPEC §9.3) + a small program compile helper.
//
// Every program shares the per-frame uniform block `FrameUniforms` (std140, binding point 0) so that
// camera / sky / fog / lighting state is uploaded once per frame instead of once per program.
// Per-draw state is a single uniform (the section offset) to keep thousands of draws cheap.
//
// Camera-relative rendering: positions are expressed relative to the camera. Section geometry is
// computed as  local + (sectionOrigin - floor(camera))  (exact small integers, identical for vertices
// shared by neighbouring sections -> no cracks/sparkles), then the fractional camera part is
// subtracted. The view matrix is rotation-only.

import { FACE_SHADE } from '../config.js';

/** Ambient-occlusion brightness per AO level 0 (darkest) .. 3 (unoccluded). SPEC §9.3. */
export const AO_CURVE = Object.freeze([0.5, 0.7, 0.85, 1.0]);

/** Binding point of the shared per-frame uniform block. */
export const FRAME_UBO_BINDING = 0;

/** Number of floats in the FrameUniforms block (std140, every member padded to vec4). */
export const FRAME_UBO_FLOATS = 16 * 2 + 4 * 11;

/** Float offsets of the FrameUniforms members (std140: mat4 = 16 floats, vec4 = 4 floats). */
export const FRAME_UBO_LAYOUT = Object.freeze({
  viewProj: 0,      // mat4  proj * viewRotation (camera-relative world -> clip)
  invViewProj: 16,  // mat4  inverse of the above (sky ray reconstruction)
  camFrac: 32,      // xyz camera - floor(camera); w animation time in seconds (wrapped, period 256 s)
  camWrap: 36,      // xyz floor(camera) mod 256 (animation phase origin); w liquid frame 0..15
  fog: 40,          // x start, y end, z 1/(end-start), w mode (0 air, 1 water, 2 lava)
  light: 44,        // x daylight, y star brightness, z cloud brightness, w sun angle (radians)
  skyTint: 48,      // rgb sky-light tint (bluish at night), w brightness option 0..1 (default 0.5)
  skyZenith: 52,    // rgb upper sky colour, w sun side (+1 = sun over +X/east, -1 = over -X/west)
  skyHorizon: 56,   // rgb horizon / fog colour, w haze density of the sky gradient
  sunrise: 60,      // rgb sunrise/sunset colour, a strength (0 = inactive)
  fogFlat: 64,      // rgb flat fog colour (underwater / lava), w 1 = use it instead of the sky colour
  sunDir: 68,       // xyz sun direction, w unused
  viewport: 72,     // xy viewport size in px, zw 1/size
});

const HEADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler2DArray;
`;

const FRAME_BLOCK = `
layout(std140) uniform FrameUniforms {
  mat4 uViewProj;
  mat4 uInvViewProj;
  vec4 uCamFrac;
  vec4 uCamWrap;
  vec4 uFog;
  vec4 uLight;
  vec4 uSkyTint;
  vec4 uSkyZenith;
  vec4 uSkyHorizon;
  vec4 uSunrise;
  vec4 uFogFlat;
  vec4 uSunDir;
  vec4 uViewport;
};
`;

/**
 * Canonical lighting (SPEC §9.3), shared with the entity renderer. sky/blk in [0,1].
 * The entity renderer may import this chunk to stay bit-identical.
 *
 * After combining sky and block light, Minecraft's lightmap post-processing (LightTexture) is applied
 * with the 亮度 (brightness / gamma) option: a 4 % lift toward grey, the "notGamma" curve 1 - (1 - c)^4
 * mixed in by the brightness, and another 4 % lift. `skyTint.a` carries the brightness (0 = 昏暗 Moody,
 * 0.5 = default, 1 = 明亮 Bright). At the default, unlit cells end at ~0.1 (Minecraft's 0.0995) instead
 * of the near-black 0.035 floor, so caves and ores stay faintly visible without torches; Moody gives
 * ~0.059 and Bright ~0.14, exactly like Minecraft. Full light stays ~0.985.
 */
export const GLSL_LIGHT = `
float lightCurve(float l) { return l / (4.0 - 3.0 * l); }
vec3 lightColor(float sky, float blk, float daylight, vec4 skyTint) {
  vec3 s = vec3(lightCurve(sky) * daylight) * skyTint.rgb;
  vec3 b = vec3(lightCurve(blk)) * vec3(1.0, 0.92, 0.82);
  vec3 c = mix(clamp(max(s, b), 0.0, 1.0), vec3(0.75), 0.04);
  vec3 g = 1.0 - c;
  g *= g;
  c = mix(c, 1.0 - g * g, skyTint.a);
  return mix(c, vec3(0.75), 0.04);
}
`;

/**
 * Minecraft-style sky colour along a normalised direction. Used by the sky pass AND as the fog colour of
 * every other pass, so fully fogged geometry dissolves exactly into the sky behind it.
 *  - gradient: the upper sky colour fades into the horizon colour near the horizon (MC's fogged sky plane)
 *  - sunrise/sunset: the horizon colour leans toward the sunrise colour when looking at the sun (MC fog
 *    rule) plus a glowing fan on the horizon toward the sun (MC renderSky triangle fan)
 *  - underwater / lava: a flat fog colour
 */
const GLSL_SKY = `
vec3 skyColor(vec3 d) {
  if (uFogFlat.w > 0.5) return uFogFlat.rgb;
  float side = uSkyZenith.w;
  float toSun = max(d.x * side, 0.0);
  vec3 horizon = mix(uSkyHorizon.rgb, uSunrise.rgb, toSun * uSunrise.a);
  float ke = max(d.y, 0.0) * uSkyHorizon.w;
  float haze = pow(1.0 + ke * ke * ke, -1.0 / 3.0);
  vec3 c = mix(uSkyZenith.rgb, horizon, haze);
  if (uSunrise.a > 0.0) {
    float h = length(d.xz);
    float az = h > 1e-5 ? toSun / h : 0.0;               // cos(azimuth from the sun's horizon point)
    float top = (0.30 * uSunrise.a + 0.06) * az + 1e-4;  // fan height (tan elevation) at this azimuth
    float e = d.y / max(h, 1e-5);                        // tan(elevation)
    float vert = e > 0.0 ? clamp(1.0 - e / top, 0.0, 1.0) : clamp(1.0 + e * 1.5, 0.0, 1.0);
    float glow = uSunrise.a * az * sqrt(az) * vert * vert;
    c = mix(c, uSunrise.rgb, glow);
  }
  return c;
}
`;

/**
 * Pixel-art texture sampling. Magnified texels stay crisp but their edges are anti-aliased over ~1 screen
 * pixel (no crawling stair-steps); at minification the plain trilinear/anisotropic sample is used.
 * Derivatives come from the unmodified coordinate so mip selection is correct.
 */
const GLSL_SAMPLE = `
uniform sampler2DArray uTex;
uniform float uSmoothTexels;   // 1 = anti-aliased texel edges (LINEAR sampler), 0 = classic nearest
vec4 sampleTexel(vec2 uv, float layer, vec2 gx, vec2 gy) {
  vec2 t = uv * 16.0;
  vec2 fw = max(abs(gx) + abs(gy), vec2(1e-6)) * 16.0;
  vec2 seam = floor(t + 0.5);
  vec2 aa = seam + clamp((t - seam) / fw, -0.5, 0.5);
  vec2 centre = floor(t) + 0.5;
  vec2 snapped = mix(centre, aa, uSmoothTexels);
  t = mix(snapped, t, clamp(fw * 2.0 - 1.0, 0.0, 1.0));
  return textureGrad(uTex, vec3(t * 0.0625, layer), gx, gy);
}
`;

function glslFloatArray(name, values) {
  const list = values.map((v) => (Number.isInteger(v) ? v.toFixed(1) : String(v))).join(', ');
  return `const float ${name}[${values.length}] = float[${values.length}](${list});`;
}

// ---------------------------------------------------------------------------------------------------
// Terrain (section meshes, SPEC §7 packed format)
// ---------------------------------------------------------------------------------------------------

const TERRAIN_VS = `
layout(location = 0) in uvec3 aData;
uniform vec3 uSectionOffset;   // section origin - floor(camera): exact integers
${FRAME_BLOCK}
${glslFloatArray('FACE_SHADE', [...FACE_SHADE])}
${glslFloatArray('AO_CURVE', [...AO_CURVE])}
const vec3 FACE_NORMAL[7] = vec3[7](vec3(1.0, 0.0, 0.0), vec3(-1.0, 0.0, 0.0), vec3(0.0, 1.0, 0.0),
  vec3(0.0, -1.0, 0.0), vec3(0.0, 0.0, 1.0), vec3(0.0, 0.0, -1.0), vec3(0.0));
const float TAU256 = 0.02454369260617026;   // 2*pi/256: every animation is periodic in 256 blocks / 256 s
invariant gl_Position;
out vec2 vUV;
flat out float vLayer;
out vec2 vLight;
out float vShade;
out vec3 vTint;
out vec3 vPos;
#ifdef PASS_CRACK
out vec3 vQ;
flat out vec3 vNormal;
#endif
void main() {
  uint w0 = aData.x;
  uint w1 = aData.y;
  uint w2 = aData.z;
  vec3 local = vec3(uvec3(w0, w0 >> 9u, w0 >> 18u) & 511u) * 0.0625 - 1.0;
  vec3 q = local + uSectionOffset;
  uint ao = (w0 >> 27u) & 3u;
  uint face = min(w0 >> 29u, 6u);
  uint layer = w1 & 255u;
  uint anim = w1 >> 30u;
  vec3 p = q;
  if (anim == 3u) {
    layer += uint(uCamWrap.w + 0.5);
  } else if (anim != 0u) {
    vec3 wp = q + uCamWrap.xyz;            // world position mod 256 (exact)
    float t = uCamFrac.w;
    if (anim == 1u) {
      // plant sway: the whole top of the plant leans together (phase from the block cell)
      vec2 c = floor(wp.xz);
      float ph = (c.x * 29.0 + c.y * 17.0) * TAU256;
      float sx = sin(ph + t * 60.0 * TAU256) * 0.7 + sin(ph * 2.0 + t * 97.0 * TAU256) * 0.3;
      float sz = sin(ph * 3.0 + t * 71.0 * TAU256) * 0.7 + sin(ph + t * 113.0 * TAU256) * 0.3;
      p.xz += vec2(sx, sz) * 0.055;
    } else {
      // leaf rustle: tiny motion; phase from the vertex position so shared vertices move together
      float ph = (wp.x * 37.0 + wp.y * 23.0 + wp.z * 31.0) * TAU256;
      p += vec3(sin(ph + t * 83.0 * TAU256), sin(ph * 2.0 + t * 67.0 * TAU256) * 0.6,
                sin(ph * 3.0 + t * 101.0 * TAU256)) * 0.012;
    }
  }
  vPos = p - uCamFrac.xyz;
  gl_Position = uViewProj * vec4(vPos, 1.0);
#ifdef PASS_TRANSLUCENT
  // Translucent quads are drawn double-sided in one per-quad back-to-front pass (renderer.js). A quad seen
  // from behind sits a few depth units behind a coplanar front face (e.g. an ice face against the water
  // face on the same plane), so the pair never z-fights; this replaces the polygon offset of the old
  // back-faces-first pass.
  if (dot(FACE_NORMAL[face], vPos) > 0.0) gl_Position.z += 2e-6 * gl_Position.w;
#endif
  vUV = vec2(uvec2(w1 >> 8u, w1 >> 13u) & 31u) * 0.0625;
  vLayer = float(layer);
  vLight = min(vec2(uvec2(w1 >> 18u, w1 >> 24u) & 63u) * (1.0 / 60.0), vec2(1.0));
  vShade = FACE_SHADE[face] * AO_CURVE[ao];
  vTint = vec3(uvec3(w2, w2 >> 8u, w2 >> 16u) & 255u) * (1.0 / 255.0);
#ifdef PASS_CRACK
  vQ = q;
  vNormal = FACE_NORMAL[face];
#endif
}
`;

const TERRAIN_FS = `
${FRAME_BLOCK}
${GLSL_LIGHT}
${GLSL_SKY}
${GLSL_SAMPLE}
in vec2 vUV;
flat in float vLayer;
in vec2 vLight;
in float vShade;
in vec3 vTint;
in vec3 vPos;
out vec4 fragColor;
void main() {
  vec2 gx = dFdx(vUV);
  vec2 gy = dFdy(vUV);
  vec4 tex = sampleTexel(vUV, vLayer, gx, gy);
#if defined(PASS_OPAQUE)
  vec3 albedo = tex.rgb * mix(vTint, vec3(1.0), tex.a);   // tint mask (alpha 0 = fully tinted)
  float alpha = 1.0;
#elif defined(PASS_CUTOUT)
  if (tex.a < 0.5) discard;
  vec3 albedo = tex.rgb * vTint;
  float alpha = 1.0;
#else
  vec3 albedo = tex.rgb * vTint;
  float alpha = tex.a;
#endif
  vec3 col = albedo * lightColor(vLight.x, vLight.y, uLight.x, uSkyTint) * vShade;
  float dist = length(vPos);
  float fog = clamp((dist - uFog.x) * uFog.z, 0.0, 1.0);
  col = mix(col, skyColor(vPos / max(dist, 1e-4)), fog);
  fragColor = vec4(col, alpha);
}
`;

// Crack overlay: re-draws the breaking block's section with the destroy_stage texture, keeping only the
// fragments that belong to the breaking block (so cracks follow the real model: cubes, plants, torches).
// Output is blended with (DST_COLOR, SRC_COLOR): result = 2 * src * dst, src = 0.5 is neutral.
// Like Minecraft's crumbling render type the block texture's alpha is NOT consulted: glass and leaves crack
// over their whole faces (review RENDER-3), the cell test alone keeps the cracks on the block's own quads.
const CRACK_FS = `
${FRAME_BLOCK}
${GLSL_SAMPLE}
uniform vec3 uCrackCell;       // breaking block - floor(camera)
uniform float uCrackLayer;
in vec2 vUV;
flat in float vLayer;
in vec2 vLight;
in float vShade;
in vec3 vTint;
in vec3 vPos;
in vec3 vQ;
flat in vec3 vNormal;
out vec4 fragColor;
void main() {
  vec2 gx = dFdx(vUV);
  vec2 gy = dFdy(vUV);
  vec4 crack = sampleTexel(vUV, uCrackLayer, gx, gy);
  vec3 cell = floor(vQ - vNormal * 0.5);
  if (any(notEqual(cell, uCrackCell))) discard;
  fragColor = vec4(mix(vec3(0.5), crack.rgb, crack.a), 1.0);
}
`;

// ---------------------------------------------------------------------------------------------------
// Sky, stars, sun & moon
// ---------------------------------------------------------------------------------------------------

const FULLSCREEN_VS = `
${FRAME_BLOCK}
out vec4 vRay;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)) * 2.0 - 1.0;
  vRay = uInvViewProj * vec4(p, 0.0, 1.0);
  gl_Position = vec4(p, 0.0, 1.0);
}
`;

const SKY_FS = `
${FRAME_BLOCK}
${GLSL_SKY}
in vec4 vRay;
out vec4 fragColor;
void main() {
  vec3 d = normalize(vRay.xyz / vRay.w);
  fragColor = vec4(skyColor(d), 1.0);
}
`;

const STARS_VS = `
${FRAME_BLOCK}
layout(location = 0) in vec4 aStar;    // xyz unit direction (celestial frame), w size in px @1080p
layout(location = 1) in vec2 aTwinkle; // phase, angular speed (multiple of 2pi/256)
uniform float uPointScale;
out float vBright;
void main() {
  float a = uLight.w;
  float c = cos(a), s = sin(a);
  vec3 d = vec3(c * aStar.x - s * aStar.y, s * aStar.x + c * aStar.y, aStar.z);   // rotate with the sun (Z axis)
  gl_Position = uViewProj * vec4(d * 100.0, 1.0);
  gl_Position.z = gl_Position.w * 0.9999995;   // behind the sun/moon cores (they write depth 0.99999)
  float tw = 0.62 + 0.38 * sin(aTwinkle.x + uCamFrac.w * aTwinkle.y);
  vBright = uLight.y * tw * smoothstep(-0.02, 0.18, d.y);
  gl_PointSize = max(aStar.w * uPointScale, 1.0);
}
`;

const STARS_FS = `
in float vBright;
out vec4 fragColor;
void main() {
  vec2 p = abs(gl_PointCoord * 2.0 - 1.0);
  float r = max(p.x, p.y);
  float a = 1.0 - smoothstep(0.55, 1.0, r);
  fragColor = vec4(vec3(vBright * a), 1.0);
}
`;

const CELESTIAL_VS = `
${FRAME_BLOCK}
layout(location = 0) in vec2 aCorner;
uniform vec3 uCenter;
uniform vec3 uRight;
uniform vec3 uUp;
out vec2 vUV;
out vec3 vDir;
void main() {
  vec3 p = uCenter + aCorner.x * uRight + aCorner.y * uUp;
  vUV = vec2(aCorner.x * 0.5 + 0.5, 0.5 - aCorner.y * 0.5);
  vDir = p;
  gl_Position = uViewProj * vec4(p, 1.0);
}
`;

const CELESTIAL_FS = `
uniform sampler2D uImage;
uniform float uBrightness;
in vec2 vUV;
in vec3 vDir;
out vec4 fragColor;
void main() {
  vec4 t = texture(uImage, vUV);
  float horizonFade = smoothstep(-0.05, 0.025, normalize(vDir).y);
  fragColor = vec4(t.rgb * t.a * uBrightness * horizonFade, 1.0);   // additive (ONE, ONE)
  // the opaque core hides the stars drawn afterwards; everything in the world is nearer than this depth
  gl_FragDepth = t.a >= 0.5 && horizonFade > 0.5 ? 0.99999 : 1.0;
}
`;

// ---------------------------------------------------------------------------------------------------
// Clouds (Minecraft "fancy" 3D clouds)
// ---------------------------------------------------------------------------------------------------

const CLOUDS_VS = `
${FRAME_BLOCK}
layout(location = 0) in vec4 aPos;     // xyz relative to the cloud mesh origin, w face shade
uniform vec3 uCloudOffset;             // mesh origin - camera
out vec3 vPos;
out float vShade;
void main() {
  vPos = aPos.xyz + uCloudOffset;
  vShade = aPos.w;
  gl_Position = uViewProj * vec4(vPos, 1.0);
}
`;

const CLOUDS_FS = `
${FRAME_BLOCK}
${GLSL_SKY}
uniform vec4 uCloudFog;    // x fade start, y 1/(end-start), z alpha, w unused
in vec3 vPos;
in float vShade;
out vec4 fragColor;
void main() {
  float dist = length(vPos.xz);
  float f = clamp((dist - uCloudFog.x) * uCloudFog.y, 0.0, 1.0);
  vec3 col = vec3(uLight.z * vShade);
  col = mix(col, skyColor(normalize(vPos)), f * 0.75);
  fragColor = vec4(col, uCloudFog.z * (1.0 - f * f));
}
`;

// ---------------------------------------------------------------------------------------------------
// Block selection outline: 12 box edges drawn as screen-space quads of a fixed pixel width.
// ---------------------------------------------------------------------------------------------------

const OUTLINE_VS = `
${FRAME_BLOCK}
layout(location = 0) in vec3 aA;       // edge start corner (0/1 per axis)
layout(location = 1) in vec3 aB;       // edge end corner
layout(location = 2) in vec2 aParam;   // x: 0 = start / 1 = end, y: side -1 / +1
uniform vec3 uBoxMin;                  // camera-relative
uniform vec3 uBoxMax;
uniform float uLineWidth;              // px
void main() {
  // pull the lines very slightly toward the camera (MC "view offset Z layering")
  vec3 pa = mix(uBoxMin, uBoxMax, aA) * 0.9985;
  vec3 pb = mix(uBoxMin, uBoxMax, aB) * 0.9985;
  vec4 ca = uViewProj * vec4(pa, 1.0);
  vec4 cb = uViewProj * vec4(pb, 1.0);
  const float NEAR_W = 0.052;           // clip against the near plane (w = near = 0.05)
  if (ca.w < NEAR_W && cb.w < NEAR_W) { gl_Position = vec4(0.0, 0.0, -2.0, 1.0); return; }
  if (ca.w < NEAR_W) ca = mix(ca, cb, (NEAR_W - ca.w) / (cb.w - ca.w));
  else if (cb.w < NEAR_W) cb = mix(cb, ca, (NEAR_W - cb.w) / (ca.w - cb.w));
  vec2 sa = ca.xy / ca.w * uViewport.xy;
  vec2 sb = cb.xy / cb.w * uViewport.xy;
  vec2 dir = sb - sa;
  float len = length(dir);
  dir = len > 1e-6 ? dir / len : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  vec4 c = aParam.x < 0.5 ? ca : cb;
  float along = aParam.x < 0.5 ? -1.0 : 1.0;
  vec2 offPx = (nrm * aParam.y + dir * along) * (uLineWidth * 0.5);
  c.xy += offPx * 2.0 * uViewport.zw * c.w;   // pixels -> NDC (NDC spans 2 units)
  gl_Position = c;
}
`;

const OUTLINE_FS = `
uniform vec4 uColor;
out vec4 fragColor;
void main() { fragColor = uColor; }
`;

// Full-screen tint (underwater / lava), multiplicative: blend (DST_COLOR, ZERO).
const OVERLAY_VS = `
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)) * 2.0 - 1.0;
  gl_Position = vec4(p, 0.0, 1.0);
}
`;

const OVERLAY_FS = `
uniform vec4 uColor;
out vec4 fragColor;
void main() { fragColor = uColor; }
`;

/** Program sources by name: { vs, fs } (complete GLSL including the #version header). */
export const PROGRAMS = Object.freeze({
  terrainOpaque: { vs: HEADER + '#define PASS_OPAQUE\n' + TERRAIN_VS, fs: HEADER + '#define PASS_OPAQUE\n' + TERRAIN_FS },
  terrainCutout: { vs: HEADER + '#define PASS_CUTOUT\n' + TERRAIN_VS, fs: HEADER + '#define PASS_CUTOUT\n' + TERRAIN_FS },
  terrainTranslucent: {
    vs: HEADER + '#define PASS_TRANSLUCENT\n' + TERRAIN_VS, fs: HEADER + '#define PASS_TRANSLUCENT\n' + TERRAIN_FS,
  },
  crack: { vs: HEADER + '#define PASS_CRACK\n' + TERRAIN_VS, fs: HEADER + '#define PASS_CRACK\n' + CRACK_FS },
  sky: { vs: HEADER + FULLSCREEN_VS, fs: HEADER + SKY_FS },
  stars: { vs: HEADER + STARS_VS, fs: HEADER + STARS_FS },
  celestial: { vs: HEADER + CELESTIAL_VS, fs: HEADER + CELESTIAL_FS },
  clouds: { vs: HEADER + CLOUDS_VS, fs: HEADER + CLOUDS_FS },
  outline: { vs: HEADER + OUTLINE_VS, fs: HEADER + OUTLINE_FS },
  overlay: { vs: HEADER + OVERLAY_VS, fs: HEADER + OVERLAY_FS },
});

function withLineNumbers(src) {
  return src.split('\n').map((l, i) => String(i + 1).padStart(4) + ' | ' + l).join('\n');
}

function compileShader(gl, type, src, name) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS) && !gl.isContextLost()) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    const kind = type === gl.VERTEX_SHADER ? 'vertex' : 'fragment';
    throw new Error(`[shaders] ${name}: ${kind} shader failed to compile:\n${log}\n${withLineNumbers(src)}`);
  }
  return sh;
}

/**
 * Compile + link a program. Returns { program, uniforms } where `uniforms` maps every active uniform
 * name (without "[0]") to its location. The FrameUniforms block (if used) is bound to FRAME_UBO_BINDING
 * and sampler uniforms default to texture unit 0.
 */
export function createProgram(gl, vsSrc, fsSrc, name = 'program') {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc, name);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc, name);
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost()) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`[shaders] ${name}: link failed:\n${log}`);
  }
  const uniforms = {};
  const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) || 0;
  for (let i = 0; i < count; i++) {
    const info = gl.getActiveUniform(program, i);
    if (!info) continue;
    const uname = info.name.replace(/\[0\]$/, '');
    const loc = gl.getUniformLocation(program, info.name);
    if (loc !== null) uniforms[uname] = loc;
  }
  const blockIndex = gl.getUniformBlockIndex(program, 'FrameUniforms');
  if (blockIndex !== gl.INVALID_INDEX && blockIndex !== -1 && blockIndex != null) {
    gl.uniformBlockBinding(program, blockIndex, FRAME_UBO_BINDING);
  }
  return { program, uniforms, name };
}

/** Compile every program in PROGRAMS. Returns { name: { program, uniforms } }. */
export function createAllPrograms(gl) {
  const out = {};
  for (const [name, src] of Object.entries(PROGRAMS)) out[name] = createProgram(gl, src.vs, src.fs, name);
  return out;
}
