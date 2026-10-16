# Renderer notes (src/render/renderer.js, src/render/shaders.js)

Owner: renderer agent. Implements SPEC §9.3 (WebGL2 world renderer) plus the §9.5 hooks.

## Integration (game.js)

```js
import { Renderer } from './render/renderer.js';
import { generateTextures, generateMiscTextures, buildMipChain, getLayerAlphaModes } from './render/textures.js';
import { EntityRenderer } from './render/entityrenderer.js';

const renderer = new Renderer(canvas, {
  textures: generateTextures(), misc: generateMiscTextures(), EntityRendererClass: EntityRenderer,
  buildMipChain, alphaModes: getLayerAlphaModes(),          // optional, see "Textures" below
});
renderer.onContextRestored = () => game.world?.remeshAll(); // GPU meshes are gone after a context loss
const fit = () => renderer.resize(innerWidth, innerHeight, devicePixelRatio);
fit(); addEventListener('resize', fit);                    // or call renderer.resizeToDisplaySize() per frame
// every frame:
renderer.render(frameState);                               // SPEC §9.3 FrameState
renderer.getStats();  // { sections, visibleSections, drawCalls, triangles, gpuMemoryBytes } (object is reused)
```

* `setSectionMesh(cx, sy, cz, opaque, cutout, translucent)` copies the data to the GPU immediately — the caller
  may reuse or transfer the arrays afterwards. Empty arrays count as `null`; all `null` deletes the section.
  VAO/VBO objects of a section layer are reused when a section is re-meshed.
* `removeChunk(cx, cz)`, `clearAll()`, `hasSection(cx, sy, cz)`, `dispose()` (frees everything).
* `frame.breaking.stage` must be 0..9; a negative/missing stage (e.g. interaction.breakStage === -1) draws no cracks.
* The constructor throws (Chinese + English message) if WebGL2 is unavailable — main.js should catch it.
* `renderer.entityRenderer` is (re)created inside the renderer; after a context restore it is a NEW instance,
  so do not cache it.
* `renderer.textureArray` is the shared `TEXTURE_2D_ARRAY` (also passed to the entity renderer as `ctx.texture`).

## Frame order

1. Sky: full-screen gradient + sunrise/sunset glow (one shader), sun & moon (additive, textured quads from
   `misc.sun/moon`, MC sizes 30/20 at distance 100), stars (1500 points, twinkling, rotate with the sun about
   the Z axis, hidden behind the sun/moon cores).
2. Opaque (front-to-back), cutout (front-to-back, `discard a < 0.5`). Back-face culling, depth write.
3. Crack overlay for opaque/cutout geometry, selection outline.
4. `EntityRenderer.renderEntities` + `renderParticles`.
5. Translucent (sections back-to-front; inside each section the quads are sorted back to front and drawn in one
   double-sided pass, see "Translucent sorting"), then the crack overlay for translucent blocks (ice).
6. Clouds (depth pre-pass + one blended layer).
7. `EntityRenderer.renderHand` (it clears depth itself).
8. Underwater / lava full-screen tint (multiply).

Deviations from the order listed in SPEC §9.3 (all for correctness, same visible result otherwise):
* **Translucent before clouds** (Minecraft's order). Clouds-first would make water seen through clouds from
  above disappear (cloud depth rejects it).
* **Selection outline and crack overlay before the translucent pass** (again Minecraft's order): the
  outline/cracks of a block under water are then correctly seen *through* the water surface instead of being
  hidden by the water's depth. Cracks on translucent blocks (ice) are drawn right after the translucent pass.
* **Underwater tint after the hand** so the hand is tinted too.

State handed to the entity renderer hooks: viewport = full canvas, depth test `LEQUAL` + depth write on,
blending off, culling on (`BACK`, CCW front faces), texture unit 0 = texture array with **no sampler object**
(i.e. the texture's own SPEC filtering: MAG `NEAREST`, MIN `NEAREST_MIPMAP_LINEAR`), no VAO bound. Hooks may
change any state; the renderer re-establishes what it needs. A hook that throws is logged once
(`console.error`) and skipped for that frame.

`ctx` (one object, updated in place every frame — do not keep references to its arrays across frames if you
need old values): `{ gl, proj, viewRot, viewProj, cameraPos, camRight, camUp, fogColor, fogStart, fogEnd,
daylight, skyTint, time, aspect, texture }`. `proj` uses near 0.05 / far 2048 and the frame's vertical FOV.
`fogColor` is the horizon sky colour in the look direction (MC style); underwater/lava it is the flat fog colour.

## Camera-relative precision (no cracks, no sparkles, no jitter)

* View matrix is rotation-only (`mat4ViewRotation`), world positions never enter a matrix.
* Section vertices: `local/16 - 1 + (sectionOrigin - floor(camera))` is computed exactly (small integers and
  1/16 steps), then `camera - floor(camera)` is subtracted. Vertices shared by neighbouring sections are
  therefore bit-identical → watertight across section borders. `invariant gl_Position` is used in every terrain
  program (terrain and crack passes produce identical depths).
* The per-draw state is a single `uniform3f` (integer section offset). All other per-frame state lives in one
  std140 uniform block (`FrameUniforms`, binding 0, uploaded once per frame).
* Animation phases use `world position mod 256` (exact) and frequencies that are multiples of 2π/256, and the
  animation clock is wrapped to 256 s, so animations never jump and stay precise for very long sessions/huge
  coordinates.

## Shading (SPEC §5.3 / §9.3)

* Opaque: `rgb = tex.rgb * mix(tint, 1, tex.a)` (tint mask), never discards. Cutout: discard `a < 0.5`,
  `rgb * tint`. Translucent: `rgb * tint`, alpha from the texture, blended.
* Terrain = albedo × `lightColor(sky, block, daylight, skyTint)` × `FACE_SHADE[face]` × `AO_CURVE[ao]`
  (FACE_SHADE and AO_CURVE are interpolated per vertex; the light values are interpolated and the curve is
  applied per fragment, like Minecraft's lightmap lookup). `GLSL_LIGHT` is exported from shaders.js and
  imported by the entity renderer (terrain, entities, particles and the hand share one definition).
* **Wave 2 (review SURV-4): Minecraft's lightmap post-processing.** `lightColor` combines sky and block
  light as in SPEC §9.3 (`max(s, b)`), then applies Minecraft's `LightTexture` steps at the default
  brightness (50 %) instead of the spec's `max(…, 0.035)` floor: lerp 4 % toward 0.75, mix half of
  `1 − (1 − c)^4`, lerp 4 % toward 0.75. Unlit cells come out at 0.0995 (Minecraft's value; the old floor
  made caves ~1 % bright = black), full light at 0.985, and every light level stays distinct (no flattening
  of dim torch falloff). Measured with tools/out/fixer/light.json: unlit cave median luminance 2 → 7,
  noon unchanged (115 → 113), moonlit grass 12 → 21.
* **Integrator wave 2 (review RENDER-5): brightness option.** The notGamma mix factor is the 亮度 setting
  (`settings.brightness` 0..1, default 0.5 → `FrameState.brightness` → `skyTint.a` in the frame UBO and in the
  entity renderer's `uSkyTint` vec4). Light 0 gives 0.059 (昏暗 / Moody), 0.0995 (default), 0.14 (明亮 / Bright),
  exactly Minecraft's values; the slider sits next to 难度 in the options screen.
* `skyTint` (computed by the renderer, passed in `ctx`, multiplied by `daylight` in `lightColor`) is
  Minecraft's lightmap sky colour: `daylight · skyTint = (0.95·d + 0.05) · mix((d, d, 1), 1, 0.35)` with
  `d = daylight` (0.2..1): white by day, blue moonlight at night.
* Animations: `anim 1` plant sway (top vertices, whole plant leans coherently, ±0.055 blocks), `anim 2` leaf
  rustle (all vertices, ±0.012 blocks, phase from the vertex position so shared vertices move together),
  `anim 3` liquid frames `floor(time*8) mod 16`.

## Sky, fog, clouds

* Colours follow Minecraft Java's formulas: plains sky `#79A7FF` × brightness (`clamp(sunY*2+0.5)`), fog colour
  `(0.753, 0.847, 1.0)` brightness-scaled and blended toward the sky by render distance, `getSunriseColor`
  (colour + alpha), star brightness, cloud brightness, darkening of the sky/fog below y = 32 ("void fog").
* The sky gradient is the analytic version of MC's fogged sky plane; the sunset glow reproduces MC's sunrise
  fan (strongest on the horizon toward the sun, up to ~18° high, fading over ±90° azimuth) and the fog colour
  leans toward the sunrise colour when looking at the sun.
* **Fog colour = the sky colour in the fragment's direction** (same GLSL function). Fully fogged terrain is
  therefore invisible against the sky at any elevation (no fog-coloured mountain silhouettes, no visible world
  edge). Sections whose nearest point is beyond the fog end are culled.
* Fog is linear in distance, start `0.6·rd·16`, end `0.95·rd·16`. Underwater: flat blue fog (start 1, end 18,
  colour scaled by daylight) + multiplicative tint `(0.72, 0.86, 1)`. Lava: fog `(0.6, 0.12, 0)`, end 2.5,
  tint `(1, 0.62, 0.36)`. Sky/sun/moon/stars/clouds are skipped in both.
* Clouds: Minecraft "fancy" clouds from `misc.clouds` (each bitmap cell = 12×12 blocks, 4 thick, bottom at
  y = 192), faces between filled cells removed, runs merged along X, shades top 1.0 / bottom 0.7 / X 0.9 /
  Z 0.8, alpha 0.8, drifting +X at 0.6 blocks/s. The mesh is rebuilt only when the camera's cloud cell changes
  (or the render distance changes). Range `clamp(rd·16·2.5, 256, 640)` blocks, fading out over its second half
  (alpha → 0 and colour → sky colour). A depth pre-pass ensures only the nearest cloud surface is blended.

## Selection outline and cracks

* Outline: the 12 edges of `selection.box` (+0.002) drawn as screen-space quads, width `max(2.5, W/1920·2.5)`
  px, black at 40 % alpha, pulled 0.15 % toward the camera (MC "view offset Z layering"), clipped against the
  near plane in the vertex shader, stencil test so overlapping corners are not blended twice, depth tested.
* Cracks: the section containing the breaking block is re-drawn with the crack program (same vertex shader =
  identical depth, plus polygon offset −1/−2), keeping only fragments whose block cell
  (`floor(position - normal/2)`) is the breaking block → cracks follow the real model (cubes, plants, torches,
  cactus, liquids). Like Minecraft's crumbling render type the block texture's alpha is not consulted, so glass
  and leaves crack over their whole faces (review RENDER-3; the cell test alone confines the cracks). Blend `(DST_COLOR, SRC_COLOR)` with the
  crack texel premultiplied toward neutral grey (`mix(0.5, rgb, a)`), so any `destroy_stage_N` art works
  (transparent = no change). The pass is scissored to the block's screen rectangle.

## Textures and filtering

* Texture array: `texStorage3D(RGBA8, levels)` with the mip chain from (in order of preference) `textures.mips`,
  the injected `buildMipChain(data, size, layers, alphaModes)`, or an internal equivalent
  (`buildMipChainFallback`: alpha-weighted colour, coverage-preserving cutout alpha, averaged tint masks).
  `alphaModes` defaults to the registry's table (same as `getLayerAlphaModes()`).
* Every level is copied once at load and fully transparent texels of cutout/translucent layers get their
  neighbours' colour ("dilation"). Invisible with nearest sampling; prevents dark fringes whenever linear
  filtering blends across coverage edges.
* The texture **object** keeps the SPEC parameters (MAG `NEAREST`, MIN `NEAREST_MIPMAP_LINEAR`, max level 4,
  clamp) for the entity renderer. Terrain is drawn with a **sampler object** instead:
  `filtering: 'smooth'` (default) = trilinear + anisotropic (8×) and, in the shader, magnified texels snapped
  to texel centres with ~1 px anti-aliased texel edges — crisp Minecraft pixels without stair-step crawling and
  without the blur that anisotropic filtering forces on magnification under ANGLE/D3D11.
  `filtering: 'classic'` = exactly the SPEC filtering (nearest texels, `NEAREST_MIPMAP_LINEAR`).
  This is a deliberate, documented deviation in the default look (tested side by side; both are crisp up close,
  'smooth' shimmers less at distance).
* Missing/incomplete `misc` textures are replaced by built-in fallbacks (sun, moon, cloud bitmap) with a warning.
* Moon phases are not rendered: `misc.moon` is a single image.

## Robustness

* `webglcontextlost` is `preventDefault()`-ed; all GPU-side state is dropped (sections forgotten, rendering
  and uploads become no-ops). On `webglcontextrestored` every program/buffer/texture/sampler is rebuilt, the
  EntityRenderer is re-created with the new texture and `onContextRestored()` is called (wire it to
  `world.remeshAll()`). Verified with `WEBGL_lose_context` in the test page.
* Deleting a section or layer deletes its VBO + VAO; the shared index buffer (Uint32, quads (0,1,2)(0,2,3))
  grows by doubling when a mesh needs more quads.
* `resize()` caps the drawing buffer at 3840×2160 pixels (aspect preserved) and `MAX_VIEWPORT_DIMS`.

## Performance (RTX 4070, headless Edge, 1920×1080, tools/render-test.html `__bench`)

| scene | stored sections | visible | draws | triangles | render() CPU | full frame (CPU+GPU, synced) | throughput |
|---|---|---|---|---|---|---|---|
| rd 8 | 1 764 | 140 | 331 | 133 k | 0.10 ms | 0.54 ms | 0.15 ms |
| rd 16, terrain stacked twice | 8 712 | 595 | 1 386 | 529 k | 0.27 ms | 1.16 ms | 0.56 ms |
| stress: a mesh in every section, rd 16 | 19 321 | 2 474 | 5 117 | 843 k | 1.37 ms | 6.4 ms | 4.6 ms |

* Per frame: one UBO upload, one sort (allocation-free LSD radix sort of 32-bit keys: 16-bit quantised distance
  + 16-bit index), visibility = distance cull (fog end) + inlined frustum test against tight per-section bounds
  (computed from the vertex data at upload, plus 0.1 for sway).
* No objects/arrays/closures are created per frame; fractional uniforms are uploaded from preallocated
  `Float32Array`s (`uniform*fv`). Measured with `performance.memory` over thousands of frames: the per-section
  work allocates nothing; what remains (≈100 B/frame) are a few doubles V8 boxes for once-per-frame calls
  into the shared math helpers — negligible for the young-generation GC.

## Test page / tools

* `tools/render-test.html` — self-contained test world (64×64 periodic map tiled to any render distance,
  hills, lake with ice, trees, flowers/grass, torch-lit cave with lava + glowstone, glass aquarium, a floating
  test platform with one block of each kind), sky/block light BFS, a compact §7 mesher with AO + smooth light,
  placeholder textures (used only if textures.js fails to load), a mock EntityRenderer exercising the ctx
  contract. URL parameters: `x y z yaw pitch roll fov` (degrees), `view=overview|aquarium|cave|chamber|lake|platform`,
  `aim=x,y,z`, `time` (0..1), `t` (fixed animation clock), `underwater=1`, `lava=1`, `select=x,y,z`, `crack=N`,
  `rd`, `tiles`, `stack=2`, `stress=N`, `filter=smooth|classic`, `aniso=N`, `clouds=0`, `smooth=0`,
  `entities=mock|real|none`, `hand=1`, `hud=0`, `cross=0`, `mesher=real` (integration check with
  src/world/lighting.js + mesher.js), `lost=1` (context loss/restore test).
  `window.__bench(n)` measures render() CPU time, synced frame time and throughput.
* `node tools/render-shots.mjs [names]` renders the standard screenshots to `tools/out/render-*.png`.
* `node tools/render-crop.mjs in.png out.png x y w h [scale]` and `node tools/render-montage.mjs out.png cols a.png b.png …`
  for pixel-level inspection.
* `node --test tests/renderer.test.js` — shader source checks (light model, FACE_SHADE/AO_CURVE, UBO layout),
  pure helpers (sky colours, clouds, mips, dilation, sort, bounds, stars) and the Renderer against a mock WebGL2
  context (resource lifetime, culling and draw order, hook order and ctx, underwater/lava, context loss, resize,
  dispose).

## Known limitations

* Translucent sorting is by quad centre (Minecraft's approach); intersecting or very large translucent quads can
  still composite in the wrong order in rare configurations. Coplanar water/glass/ice faces never z-fight.
* Clouds behind a translucent surface (e.g. seen through an ice wall) are hidden by the surface's depth
  (Minecraft has the same behaviour).
* The sky colour is the plains colour (no per-biome sky/fog/water colours: FrameState has no biome).

## Translucent sorting (integrator, wave 2 — review RENDER-1)

Two facing passes per section could never order a near back face against a far front face: ice seen from under
water vanished (the water surface, a back face from below, wrote depth first) and water behind ice disappeared
when seen from one side. Now:

* Every translucent section layer owns an element buffer (`L.ebo`, DYNAMIC_DRAW). At upload the quad centres
  (section-local blocks, decoded from the §7 positions) and faces are stored (`L.centers`, `L.faces`) and the
  buffer holds the emission order.
* Each frame, `_sortTranslucent` walks the visible sections nearest-first and re-sorts those whose camera moved
  more than max(0.25, distance / 16) blocks since their last sort, within a budget of 24 576 quads per frame.
  Key = quantised squared distance · 2 + (camera behind the quad) — at equal distance the back-facing quad goes
  first — then the quad index; one `Float64Array.sort()` and one `bufferSubData` per re-sorted section.
* One draw per section with culling off; back-facing quads are pushed `2e-6 · w` deeper in the vertex shader
  (`dot(FACE_NORMAL[face], pos) > 0`) instead of the old polygon offset, so coplanar opposite faces still never
  z-fight. Depth writes stay on (clouds are drawn next and need the water / ice depth).
* Cost: flying at 20 b/s over a deep ocean (1080p, rd 8) +0.12 ms render CPU per frame (0.39 → 0.51 ms), 59.5
  fps either way; total draw calls drop (465 → 380: one translucent draw per section instead of two). Verified
  visually before/after (`tools/out/w2int/render1-compare.png`, `render1b-crop.png`) and by a unit test in
  `tests/renderer.test.js`.
