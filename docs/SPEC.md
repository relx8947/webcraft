# WebCraft — Architecture & Interface Specification

WebCraft is a Minecraft-like voxel sandbox that runs in the browser: **pure ES modules + WebGL2, no
dependencies, no build step**. UI language is **Simplified Chinese**. This document is the contract
between all modules. Read it fully before writing code. When the spec is silent, make a sensible
Minecraft-faithful decision and document it in your report.

Quality bar: this should feel like real Minecraft (Java Edition, survival + creative): good-looking
procedural pixel-art textures, smooth lighting with ambient occlusion, day/night cycle, biomes, caves,
trees, water, block breaking/placing with cracks + particles, inventory/crafting, sounds, saving.
It must be robust (no console errors), fast (60 FPS at render distance 8 on a desktop GPU), and the
code must be clean, commented where non-obvious, and free of placeholder TODOs.

---------------------------------------------------------------------------------------------------

## 1. Layout & ownership

```
minecraft/
  index.html               UI agent          (entry page; see §13.1)
  css/style.css            UI agent
  server.js                SHARED (done)      zero-dep static server: `node server.js [--open]`
  start.bat                SHARED (done)      Windows launcher
  package.json             SHARED (done)      "type": "module"
  docs/SPEC.md             this file
  docs/notes/<agent>.md    each agent: design notes, deviations, known issues
  src/config.js            SHARED (done)      constants, index helpers, daylight curve, default settings
  src/world/blocks.js      SHARED (done)      block definitions (data)
  src/world/items.js       SHARED (done)      item definitions (data)
  src/world/registry.js    SHARED (done)      ← import blocks/items/textures ONLY through this module
  src/util/noise.js        worldgen agent
  src/world/worldgen.js    worldgen agent
  src/world/lighting.js    mesher agent
  src/world/mesher.js      mesher agent
  src/world/chunk.js       world agent
  src/world/world.js       world agent
  src/world/blockupdates.js world agent
  src/world/workerpool.js  world agent
  src/world/worker.js      world agent
  src/world/storage.js     world agent
  src/util/math.js         SHARED (done)      mat4 helpers, Frustum, lookVector, clamp/lerp
  src/render/shaders.js    renderer agent
  src/render/renderer.js   renderer agent
  src/render/textures.js   textures agent
  src/render/entityrenderer.js  entities agent
  src/game/entities.js     entities agent
  src/game/particles.js    entities agent
  src/game/physics.js      SHARED (done)      PhysicsBody, raycast, rayBox, aabbIntersectsSolid
  src/game/input.js        player agent
  src/game/player.js       player agent
  src/game/interaction.js  player agent
  src/game/inventory.js    SHARED (done)      Inventory model, makeStack, canMerge
  src/game/crafting.js     UI agent
  src/game/commands.js     UI agent
  src/ui/*.js              UI agent
  src/game/audio.js        audio agent
  src/game.js, src/main.js integrator (after all modules exist)
  tests/*.test.js          each agent: Node unit tests (node:test + node:assert/strict); `npm test`
  tools/harness.mjs        SHARED (done)      headless browser runner (see §3)
  tools/*.html             each agent: standalone visual test pages for its module
```

Rules:
* Only edit files you own. Shared files (`config.js`, `blocks.js`, `items.js`, `registry.js`) may receive
  **additive** changes (new exports/helpers) if truly needed — never renumber ids or change existing
  semantics — and every such change must be listed in your report.
* Modules imported by the worker (`config.js`, `registry.js`, `blocks.js`, `items.js`, `noise.js`,
  `worldgen.js`, `lighting.js`, `mesher.js`, `worker.js`) must never touch `window`/`document`/DOM.
* Pure-logic modules must also run under Node (for tests): `physics.js`, `inventory.js`, `crafting.js`,
  `storage.js`'s RLE helpers, `textures.js`'s generator functions (not `IconFactory`).
* Use relative imports with explicit `.js` extensions (e.g. `import { BLOCK } from '../world/registry.js'`).
* Modern JS (ES2022), 2-space indent, semicolons, JSDoc on exported APIs. No TypeScript. No dependencies.
* No per-frame allocations in hot paths (render loop, physics, meshing inner loops) — reuse typed arrays.

## 2. Running

* `node server.js` → http://127.0.0.1:8080 (index.html). `start.bat` opens the browser too.
* `npm test` (= `node --test "tests/*.test.js"`) runs unit tests. A single file: `node --test tests/x.test.js`.
* Target browsers: Chrome/Edge 120+ (primary), Firefox 120+.

## 3. Headless test harness (use it!)

`tools/harness.mjs` launches headless Edge with the real GPU (RTX 4070 via ANGLE/D3D11), serves the
project on a random port (parallel runs are safe), streams console output, and can take screenshots,
evaluate JS and send input. In Git Bash, pass URLs **without a leading slash**.

```
node tools/harness.mjs --url tools/texture-preview.html --sleep 500 --screenshot tools/out/tex.png
node tools/harness.mjs --url "index.html?autostart=1&seed=42" --wait-for "window.__ready" --screenshot tools/out/game.png
node tools/harness.mjs --url index.html --steps tools/steps/smoke.json
```

Exit code 1 if the page logged errors / threw. You can (and should) look at screenshots with your
image-reading tool to verify visuals. Put throwaway outputs in `tools/out/` (git-ignored scratch).

## 4. Coordinates & conventions

* Right-handed, **Y up**. Block (x,y,z) occupies [x,x+1)×[y,y+1)×[z,z+1). Valid y: 0..255.
* Compass: **−Z = north, +Z = south, +X = east, −X = west**. The sun rises in the east (+X).
* Chunk: 16×16 columns, 256 high. `cx = x >> 4`, `cz = z >> 4`, local `x & 15`.
* Section: 16×16×16 slice of a chunk, `sy = y >> 4` (0..15).
* Chunk block storage: `Uint8Array(65536)`, index `blockIndex(x,y,z) = (y << 8) | (z << 4) | x` (local coords).
* **Face indices**: 0 = +X (east), 1 = −X (west), 2 = +Y (top), 3 = −Y (bottom), 4 = +Z (south), 5 = −Z (north).
  `FACE_NORMALS`, `FACE_SHADE = [0.6, 0.6, 1.0, 0.5, 0.8, 0.8, 0.9]` (index 6 = cross/sprite) in config.js.
* Entity position = **center of the AABB bottom** (feet). Player AABB 0.6×1.8×0.6, eye height 1.62
  (sneaking 1.27).
* **Camera / look direction**: `yaw` (radians) rotates about +Y, `pitch` (radians, + = up, clamp ±89.9°).
  Forward vector: `f = (−sin(yaw)·cos(pitch), sin(pitch), −cos(yaw)·cos(pitch))`. yaw 0 looks north (−Z),
  yaw +π/2 looks west (−X). Moving the mouse right **decreases** yaw.
  Horizontal move basis: forward `(−sin yaw, 0, −cos yaw)`, right `(cos yaw, 0, −sin yaw)`.
  View matrix = `Rx(−pitch) · Ry(−yaw) · T(−eye)` (column-vector convention, gl-matrix style column-major).
* Time: `game.time` in ticks (20/s). `timeOfDay = (time mod 24000) / 24000` with 0 = sunrise, 0.25 = noon,
  0.5 = sunset, 0.75 = midnight. Sun direction `(cos(2πt), sin(2πt), 0)`, moon opposite.
  `daylight = computeDaylight(timeOfDay)` ∈ [0.2, 1] (config.js) scales sky light.
* Units: seconds for durations in APIs unless named `*Ticks`.

## 5. Registry (src/world/registry.js — done, read the source)

Exports (main ones): `BLOCKS` (dense array by id), `BLOCK` (UPPER_SNAKE → id, e.g. `BLOCK.GRASS_BLOCK`),
`blockByName`, `blockId(name)`; `ITEMS` (sparse by id), `ITEM` (UPPER_SNAKE → id, block items share the
block id), `getItem(id)`, `itemByName`, `itemId(name)`, `itemDisplayName(id)`, `maxStackSize(id)`,
`isBlockItem(id)`, `maxDurability(id)`, `itemForBlock(blockId)`, `ALL_ITEM_IDS`, `CREATIVE_TABS`;
texture table `TEXTURES` (`{name, layer, frames, kind, alphaMode, tinted}` in layer order),
`TEXTURE_INDEX` (name → first layer), `TEXTURE_LAYER_COUNT` (≤ 256), `textureLayer(name)`;
lookup tables (`Uint8Array(256)` indexed by block id): `IS_OPAQUE, IS_SOLID, IS_LIQUID, IS_REPLACEABLE,
RENDER_TYPE, RENDER_LAYER, LIGHT_EMISSION, LIGHT_FILTER, CULL_SAME, TINT_TYPE, NEEDS_SUPPORT, HAS_GRAVITY`,
`FACE_LAYERS[id*6+face]`, `FACE_ROTATION[id*6+face]`; enums `RENDER {NONE,CUBE,CROSS,TORCH,LIQUID,CACTUS}`,
`LAYER {OPAQUE,CUTOUT,TRANSLUCENT}`, `TINT {NONE,GRASS,FOLIAGE,BIRCH,SPRUCE}`;
gameplay helpers `canHarvest`, `getBreakTime(blockId, toolItemId, {inWater, onGround})` (seconds),
`getDrops(blockId, toolItemId, rng)`, `getPlacementBlock(itemId, face, yaw)` (resolves log axis / facing
variants), `hasSupport(id, belowId)`, `getSelectionBox(id)`, `getCollisionBox(id)`, `DEFAULT_CREATIVE_HOTBAR`.

### 5.1 Block properties (see blocks.js header for the full list)
`renderType` cube|cross|torch|liquid|cactus|none · `layer` opaque|cutout|translucent · `solid` · `opaque`
· `cullSame` · `lightEmission` · `lightFilter` · `hardness` · `tool`/`toolTier`/`requiresTool` · `drops`
· `sound` · `replaceable` · `tint` · `gravity` · `needsSupport` · `selectionBox` · `collisionBox` ·
`slipperiness` · `liquid` · `damage` · `interact` · `placement` · `item` · `creativeTab` · `hidden`.
Hidden variants (`oak_log_x`, `furnace_east`, `snowy_grass_block`…) drop/pick their base item.

### 5.2 Textures
All textures are 16×16 RGBA and live in **one `TEXTURE_2D_ARRAY`** in `TEXTURES` order: block face
textures, animated frames (`water_still`, `lava_still`: 16 consecutive layers each), `destroy_stage_0..9`
(crack overlays), then item sprites. The layer index of block faces is precomputed in `FACE_LAYERS`.
Texture image orientation: row 0 = top of the picture. Side faces map v=0 to the top edge of the block.

### 5.3 Alpha semantics (IMPORTANT, shared by mesher, renderer, entity renderer, icons, particles)
* `alphaMode 'opaque'`: alpha = 255 everywhere.
* `alphaMode 'tintmask'` (`grass_block_top`, `grass_block_side`): opaque texture whose **alpha is a tint
  mask**: alpha 0 → pixel is grayscale and fully multiplied by the biome tint; alpha 255 → coloured,
  untinted pixel (e.g. the dirt part of the grass side). Shading rule for opaque geometry:
  `rgb = tex.rgb * mix(tint, vec3(1), tex.a)`; never discard.
* `alphaMode 'cutout'`: alpha is binary coverage (0 or 255); discard if `a < 0.5`; `rgb = tex.rgb * tint`.
  Tinted cutout textures (leaves, short_grass, fern, sugar_cane) are painted grayscale.
* `alphaMode 'translucent'`: real alpha blending (water, ice, crack overlays); `rgb = tex.rgb * tint`.
* Rule for anything drawing a **block** texture outside of chunk meshes (icons, dropped items, held
  items, particles): if `RENDER_LAYER[blockId] === LAYER.OPAQUE` use the opaque/tintmask rule, otherwise
  the cutout/translucent rule. Tint colour for those uses `DEFAULT_TINTS` (config.js) by `TINT_TYPE`.

## 6. Chunk neighbourhood ("region"), lighting

Meshing a chunk needs its 8 neighbours (faces, AO and light at borders). The worker copies the 3×3
chunks into one **region** array of 48×48×256 bytes:
`regionIndex(x,y,z) = (y*48 + (z+16))*48 + (x+16)` for x,z ∈ [−16,32) (center chunk = [0,16)).
Neighbour array order everywhere: `index = (dz+1)*3 + (dx+1)` for dx,dz ∈ {−1,0,1}; center = 4.

Light is **recomputed from scratch per mesh job** on the region (exact, because light travels at most
14 blocks and the center chunk is 16 blocks from the region edge). Packed byte: `(sky << 4) | block`.
Rules (Minecraft-like):
1. Opaque cells have light 0 (but an emissive opaque block — glowstone, jack o'lantern — still acts as
   a source for its neighbours).
2. Sky light, direct pass: per column from the top down, level starts at 15; at each non-opaque cell
   `level -= LIGHT_FILTER[id]`, cell sky = level; stop at the first opaque cell or level 0.
3. Sky light, spread: BFS from lit cells into non-opaque neighbours (all 6 directions):
   `new = level − 1 − LIGHT_FILTER[neighbour]`, keep the max.
4. Block light: sources `LIGHT_EMISSION[id]`, same BFS rule.
Result must equal the classic max-over-paths definition. Only the center chunk (+1 border for smooth
lighting) is consumed; the worker also returns the center chunk's light (`Uint8Array(65536)`, chunk
layout) so the main thread can answer `world.getLight()` (entity brightness, mob spawning).

## 7. Chunk mesh vertex format (mesher → renderer contract)

Each section yields up to three meshes (`opaque`, `cutout`, `translucent`) as `Uint32Array`, **3 uint32
per vertex, 4 vertices per quad**, quads drawn as triangles (0,1,2)(0,2,3) via a shared index buffer.
Front faces are **counter-clockwise** seen from outside; back-face culling is enabled for opaque and cutout
passes, disabled for translucent. Double-sided geometry (cross plants) is emitted as two quads.

```
w0 = x | y << 9 | z << 18 | ao << 27 | face << 29
     x,y,z: 9 bits each = (local position in 1/16 block) + 16, i.e. stored = round(p*16) + 16 where p is
            relative to the section origin (cx*16, sy*16, cz*16); p ∈ [−1, 30].   decode: p = (s − 16) / 16
     ao:    2 bits, 0 = darkest … 3 = unoccluded
     face:  3 bits, 0..5 = face index (directional shade), 6 = cross/sprite
w1 = layer | u << 8 | v << 13 | sky << 18 | block << 24 | anim << 30
     layer: 8 bits texture array layer
     u, v:  5 bits each, texel coordinates 0..16 (v = 0 at top edge of the texture)
     sky:   6 bits = smooth-lighting sky value ×4 (0..60);   block: 6 bits likewise
     anim:  2 bits, 0 none, 1 = plant sway (set on the TOP vertices of cross plants only),
            2 = leaf rustle (all vertices of leaves), 3 = animated texture (liquids: 16 frames at
            consecutive layers, frame = floor(time*8) mod 16 added to the layer in the shader)
w2 = r | g << 8 | b << 16      biome/tint colour (255,255,255 = no tint); top 8 bits reserved (0)
```

Smooth lighting & AO (per vertex, Minecraft style): for a face with normal N at block p, sample the
4 cells in front of the vertex (p+N, side1, side2, corner). `ao = (side1 && side2) ? 0 : 3 − (side1 + side2 + corner)`
using `IS_OPAQUE`. Light = average of the non-opaque samples among the 4 (if both sides are opaque the
corner is excluded), stored ×4 (0..60). With smooth lighting off, use the light of p+N for all 4
vertices (×4) and ao = 3. Flip the quad diagonal (emit vertices rotated by one: v1,v2,v3,v0) when
`ao0 + ao2 < ao1 + ao3` (and analogously for light) to avoid anisotropy artifacts.

Face culling: a face of block A toward neighbour B is emitted iff B is not opaque, **except** when
`CULL_SAME[A]` and B == A (glass, water, ice). Leaves are "fancy" (faces between leaves are kept).
Liquids: top face at height 14/16 when the block above is not the same liquid (side faces follow that
height); faces toward the same liquid or opaque blocks are skipped. Water is translucent (alpha from the
texture), lava is drawn in the opaque layer. Cross plants: two diagonal planes (0.15→0.85), each
double-sided, own-cell light, ao 3, face 6. Torch: 2×10 px post centered (px 7..9, height 0..10/16)
using the torch texture sub-rect (u 7..9, v 6..16; top face u 7..9, v 6..8). Cactus: sides inset by 1/16 along their normal, full width (texels 0..16: the edge spines overhang, Minecraft model).
`FACE_ROTATION[id*6+face]` = 1 → rotate that face's UVs by 90° (sideways logs).
Tint per vertex: `TINT_TYPE` grass/foliage → biome colour of the column (from worldgen tints),
birch → (128,167,85), spruce → (97,153,97), none → white.

## 8. Worker protocol (world agent implements worker.js + workerpool.js)

```
main → worker  { type: 'init', seed, worldType }                       // on every world start
main → worker  { type: 'generate', jobId, cx, cz }
worker → main  { type: 'generated', jobId, cx, cz, blocks }            // transfer blocks.buffer
main → worker  { type: 'mesh', jobId, cx, cz, chunks: Uint8Array[9], sectionMask, smoothLighting }
               // chunks are fresh copies (transferred); sectionMask: 16-bit, bit sy = mesh that section
worker → main  { type: 'meshed', jobId, cx, cz, sections: [{ sy, opaque, cutout, translucent }], light }
               // only requested sections; empty layers are null; light = Uint8Array(65536) chunk layout
worker → main  { type: 'error', jobId, message }
```
Worker internals: `buildRegion` → `computeLight` → `meshChunk` (reuse the region/light buffers between
jobs), tints from `generator.getTints(cx, cz)`.

## 9. Module APIs

### 9.1 noise.js + worldgen.js (worldgen agent)
```js
// noise.js
export function hashString(str) -> uint32
export function mulberry32(seed) -> () => float in [0,1)
export function hash3i(seed, x, y, z) -> uint32   // fast integer hash for per-position randomness
export class SimplexNoise { constructor(seed); noise2D(x, y) -> [-1,1]; noise3D(x, y, z) -> [-1,1] }
export function fbm2D(noise, x, y, octaves, persistence = 0.5, lacunarity = 2) -> ~[-1,1]
// worldgen.js
export function parseSeed(text) -> uint32     // integer strings -> that number (mod 2^32); other text -> hash
export const BIOMES                           // [{ id, name, displayName (Chinese), ... }]
export class WorldGenerator {
  constructor(seed, worldType = 'default')    // worldType: 'default' | 'flat'
  generateChunk(cx, cz) -> Uint8Array(65536)  // deterministic, < 15 ms typical
  getBiome(x, z) -> biome object
  getTints(cx, cz) -> { grass: Uint32Array(256), foliage: Uint32Array(256) }  // index z*16+x, packed r|g<<8|b<<16
  findSpawn() -> { x, z }                     // dry land column near the origin
  growTree(access, x, y, z, kind, rng) -> bool // access = { getBlock(x,y,z), setBlock(x,y,z,id) }; for saplings
}
```
Terrain requirements: seeded and deterministic; continent/ocean noise, rivers, beaches, smooth biome
blending (no cliffs at biome borders); biomes at least: ocean, beach, plains, forest, birch forest,
taiga (spruce), snowy plains (snowy grass, frozen water → ice), desert (sand/sandstone, cactus, dead
bush), mountains (tall, stone/snow peaks, steep slopes exposing stone) and rivers. 3D caves (spaghetti +
cheese) that do not breach under water, lava below y=11 in caves, ores with Minecraft-like
distribution (coal, iron, gold, diamond, redstone, lapis, plus granite/diorite/andesite, dirt and
gravel blobs), bedrock floor (y=0 solid, y=1..4 random). Features: oak/birch/spruce trees with
proper leaf shapes, cacti, sugar cane next to water, tall grass, ferns, flowers, mushrooms, pumpkins
(rare), clay/sand/gravel on river/ocean floors. Features crossing chunk borders must be generated
deterministically from neighbour chunk seeds so they match exactly. Flat world: bedrock y=0, dirt
y=1..2, grass y=3. Sea level 62 (water fills air for y ≤ 62).

### 9.2 lighting.js + mesher.js (mesher agent)
```js
// lighting.js
export function buildRegion(chunks /* Uint8Array[9] */, out /* optional Uint8Array(REGION_VOLUME) */) -> Uint8Array
export function computeLight(region, out /* optional */) -> Uint8Array   // packed sky<<4|block, region layout
export function extractChunkLight(regionLight, out /* optional Uint8Array(65536) */) -> Uint8Array
// mesher.js
export function meshChunk(region, light, sectionMask, tints, options = { smoothLighting: true })
  -> Array<{ sy, opaque: Uint32Array|null, cutout: Uint32Array|null, translucent: Uint32Array|null }>
```
Performance: light + mesh of a typical surface chunk (all 16 sections) < 25 ms in a worker. Only scan
y up to the region's highest non-air block + 2.

### 9.3 Renderer (renderer agent): shaders.js, renderer.js (math.js is shared/done)
```js
export class Renderer {
  constructor(canvas, { textures, misc, EntityRendererClass })
      // textures = generateTextures(), misc = generateMiscTextures(); EntityRendererClass = the class
      // from src/render/entityrenderer.js, injected by game.js (no static import → renderer.js is
      // testable on its own). If absent, entity/particle/hand passes are skipped.
  gl                                         // WebGL2RenderingContext
  entityRenderer                             // new EntityRendererClass(gl, textureArray) or null
  resize(cssWidth, cssHeight, devicePixelRatio)
  setSectionMesh(cx, sy, cz, opaque, cutout, translucent)  // Uint32Array|null each; all null = delete
  removeChunk(cx, cz)                        // delete all 16 section meshes of a chunk
  clearAll()
  render(frame)                              // see FrameState below
  getStats() -> { sections, drawCalls, triangles, gpuMemoryBytes }
}
```
**FrameState** (built by game.js every frame):
```js
{
  camera: { x, y, z, yaw, pitch, roll, fov },   // eye position (world), radians, vertical FOV degrees
  timeOfDay, daylight, time,                    // time = seconds (animation clock)
  renderDistance,                               // chunks
  underwater, inLava,                           // camera inside water / lava
  clouds: true,
  selection: { x, y, z, box: [x0,y0,z0,x1,y1,z1] } | null,   // box relative to block, block units
  breaking: { x, y, z, stage: 0..9 } | null,
  entities: EntityRenderItem[],                 // §9.5
  particles: { count, data: Float32Array } | null,
  hand: HandState | null,
}
```
Rendering requirements:
* WebGL2, `{ antialias: false, alpha: false, powerPreference: 'high-performance' }`. Texture array with
  mipmaps from `buildMipChain` (MAG nearest, MIN `NEAREST_MIPMAP_LINEAR`, max level 4, anisotropic if
  available). One VAO + VBO per section layer, integer attribute (`vertexAttribIPointer`, `uvec3`), one
  shared `Uint32` element buffer (grow as needed).
* **Camera-relative rendering**: never put large world coordinates in matrices; pass
  `sectionOrigin − cameraPos` as a uniform and use a rotation-only view matrix. Same for all other draws.
* Frustum culling per section; opaque sorted front-to-back, translucent back-to-front.
* Passes: sky (gradient + sunrise/sunset glow toward the sun, stars at night, sun & moon quads using
  `misc.sun`/`misc.moon`), opaque, cutout (discard alpha<0.5), entities + particles (EntityRenderer),
  3D clouds (Minecraft-style flat boxes at y≈192 from `misc.clouds` bitmap, drifting +X, fog-faded),
  translucent (water/ice, depth write on), block selection outline (thin dark lines, slightly expanded
  `selection.box`), crack overlay (`destroy_stage_N`, multiply blend `DST_COLOR, SRC_COLOR`, polygon
  offset), then the first-person hand (EntityRenderer.renderHand, own projection, cleared depth).
* Lighting in shaders (canonical, shared with entity renderer):
  ```glsl
  float lightCurve(float l) { return l / (4.0 - 3.0 * l); }               // l in [0,1]
  vec3 lightColor(float sky, float blk, float daylight, vec3 skyTint) {    // sky, blk in [0,1]
    vec3 s = vec3(lightCurve(sky) * daylight) * skyTint;                   // skyTint: bluish at night
    vec3 b = vec3(lightCurve(blk)) * vec3(1.0, 0.92, 0.82);                // warm torch light
    // wave 2 (review SURV-4): Minecraft's lightmap post-processing at the default brightness (50 %)
    // replaces the former max(max(s, b), vec3(0.035)) floor: unlit = 0.0995, full light = 0.985
    vec3 c = mix(clamp(max(s, b), 0.0, 1.0), vec3(0.75), 0.04);
    vec3 g = 1.0 - c; g *= g;
    c = mix(c, 1.0 - g * g, 0.5);
    return mix(c, vec3(0.75), 0.04);
  }
  ```
  The code in src/render/shaders.js (`GLSL_LIGHT`, also used by the entity renderer) is canonical.
  Terrain fragment = albedo × lightColor × FACE_SHADE[face] × AO_CURVE[ao] with
  `AO_CURVE = [0.5, 0.7, 0.85, 1.0]` (interpolated per vertex), then fog.
* Fog: linear in distance from camera, start `0.6·rd·16`, end `0.95·rd·16`, colour = sky horizon colour
  (tinted by daylight/sunset). Underwater: dense blue fog (end ≈ 12–20 blocks) + blue tint; lava: orange.
* Sway animations from `anim` bits (subtle), animated liquid textures, no visible seams/T-junction
  sparkles, no z-fighting.

### 9.4 Textures (textures agent): src/render/textures.js
```js
export function generateTextures() -> { size: 16, layers: TEXTURE_LAYER_COUNT, data: Uint8Array }   // pure
export function getLayerAlphaModes() -> string[]  // per layer (frames expanded)
export function buildMipChain(data, size, layers, alphaModes) -> Uint8Array[]  // levels 0..4 (16..1 px)
export function generateMiscTextures() -> {
  sun: { width, height, data }, moon: { width, height, data },           // RGBA, transparent background
  clouds: { width: 256, height: 256, data /* Uint8Array 0|255 per cell */ },
}
export class IconFactory {   // browser only (canvas)
  constructor(textures /* result of generateTextures() */)
  getIcon(itemId) -> string  // data URL of a 48×48 crisp pixel-art icon, cached
}
```
Painters must exist for **every** name in `TEXTURES` (and every frame of animated ones), deterministic
(seeded per texture name), original pixel art in Minecraft's spirit (do not copy Mojang assets).
Icons: cube-like blocks drawn isometrically (top + south face (left, shade 0.8) + east face (right,
shade 0.6)), cross/torch blocks and items as flat sprites; apply §5.3 tint rules with `DEFAULT_TINTS`.
Mip chain: colour averaged with alpha weighting (no dark fringes), cutout alpha re-thresholded to
preserve coverage, tintmask alpha averaged.

### 9.5 Entities, particles, entity rendering (entities agent)
```js
// src/game/entities.js
export class EntityManager {
  constructor(game)
  spawnItem(stack, x, y, z, vx, vy, vz, pickupDelay = 0.5) -> ItemEntity   // velocity optional (random pop)
  update(dt)                 // physics, pickup by player (radius ~1.5, magnet toward player), merging,
                             // despawn after 300 s, sets e.light = world.getLight(...) each update
  getRenderList(out) -> out  // appends EntityRenderItem objects
  clear()
  count
}
// src/game/particles.js
export class ParticleSystem {
  constructor(game)
  spawnBlockBreak(x, y, z, blockId)            // ~64 small textured bits with random velocities
  spawnBlockHit(x, y, z, face, blockId)        // a few bits on the hit face while mining
  spawnSplash(x, y, z), spawnSmoke(x, y, z, count), spawnExplosion(x, y, z)
  update(dt)
  getRenderData() -> { count, data: Float32Array }   // stride 12 (below)
}
// src/render/entityrenderer.js
export class EntityRenderer {
  constructor(gl, textureArray /* WebGLTexture TEXTURE_2D_ARRAY */)
  renderEntities(ctx, items /* EntityRenderItem[] */)
  renderParticles(ctx, particles /* {count, data} */)
  renderHand(ctx, hand /* HandState */)      // clears depth itself, own projection (fov 70)
}
```
`ctx` (built by the Renderer each frame): `{ gl, proj, viewRot /* rotation-only view */, viewProj
/* proj*viewRot */, cameraPos [x,y,z], camRight [x,y,z], camUp [x,y,z], fogColor [r,g,b], fogStart, fogEnd,
daylight, skyTint [r,g,b], time, aspect, texture }`. Draw with camera-relative positions.

EntityRenderItem (wave 1 kinds; `model` kind comes later for mobs):
```js
{ kind: 'item', x, y, z, itemId, count, age /* s */, seed /* 0..1 */, light /* packed */ }
{ kind: 'block', blockId, x, y, z /* center of bottom */, scale, light, flash /* 0..1 white overlay */ }
```
Dropped items: block items with cube-like render types → small spinning cube (0.25), plus 1–2 extra
copies for larger stacks; other items → spinning flat or extruded sprite; bobbing.
Particle data layout (Float32Array, stride 12): `x, y, z, size, layer, u0, v0, uvSize (texels), r, g, b, light`.
HandState: `{ itemId /* 0 = empty hand */, swing /* 0..1 progress, 0 = idle */, equip /* 0..1, 1 = fully
raised */, bobX, bobY, light /* packed */ }`. Empty hand = Steve-like arm; block = rotated cube;
item = extruded 3D sprite (Minecraft style) or tilted sprite.

### 9.6 World manager (world agent): chunk.js, world.js, blockupdates.js, workerpool.js, worker.js, storage.js
```js
export class WorkerPool {
  constructor(count = clamp(navigator.hardwareConcurrency - 2, 2, 8))
  init(seed, worldType)                  // broadcast 'init'
  submit(job, priority, transfer) -> Promise<result>   // lower priority value = sooner
  cancel(predicate)                      // drop queued (not yet dispatched) jobs
  reprioritize(fn)                       // recompute priorities of queued jobs (player moved)
  pending -> number; terminate()
}
export class World {
  constructor({ seed, worldType, worldId, storage /* Storage|null = no persistence */, pool, renderer,
                renderDistance, smoothLighting, onDropItem /* (itemId, count, x, y, z) */ })
  async init()                           // e.g. load index of saved chunk keys
  update(px, py, pz, dt)                 // per frame: load/unload, schedule gen/mesh (nearest first,
                                         // generate radius rd+1, mesh radius rd), apply results,
                                         // upload ≤ ~4 ms of meshes per frame
  getBlock(x, y, z) -> id                // AIR for unloaded or y out of range
  setBlock(x, y, z, id, { update = true } = {}) -> bool   // false if chunk not loaded / y invalid
  getLight(x, y, z) -> packed (sky<<4|block); 0xF0 when unknown/above world
  getTopY(x, z) -> y of highest non-air block or -1 (heightmap)
  isChunkGenerated(cx, cz), isChunkMeshed(cx, cz), isAreaReady(x, z, radiusChunks)
  setRenderDistance(n), setSmoothLighting(bool), remeshAll()
  tick(rng)                              // 20 TPS: random ticks (grass spread / dirt reversion under opaque
                                         // blocks, sapling growth via generator.growTree, sugar cane & cactus
                                         // growth) and scheduled block updates
  onBlockChanged(fn)                     // fn(x, y, z, oldId, newId)
  async save()                           // persist modified chunks (only those changed by the player/game)
  async destroy()                        // save, cancel jobs, remove meshes
  stats() -> { loaded, meshed, pendingGenerate, pendingMesh, modified }
}
```
* Editing: `setBlock` updates data, heightmap, marks the chunk modified and marks dirty every section
  whose light/geometry may change: all chunks whose XZ range intersects [x−15, x+15]×[z−15, z+15],
  sections from 0 up to `(y+15) >> 4` (sky light can change all the way down), plus geometry
  neighbours. The chunk containing the edit is remeshed with top priority so feedback is instant
  (< 50 ms). Results of mesh jobs that raced with later edits must be re-queued, never lost.
* blockupdates.js: after a change, blocks needing support (`NEEDS_SUPPORT` + `hasSupport`) above the
  changed cell pop off (dropping their item via `onDropItem`, cascading upward: sugar cane, cactus);
  gravity blocks (sand/gravel) with air/liquid below fall (wave 1: move instantly to the landing
  cell; drop as item if landing on a non-replaceable non-solid block like a torch).
* Storage (IndexedDB, db `webcraft`, stores `worlds` and `chunks`):
```js
export class Storage {
  static async open() -> Storage
  async listWorlds() -> meta[] (sorted by lastPlayed desc)
  async saveWorldMeta(meta)               // meta.id string; create or update
  async loadWorldMeta(id) -> meta|null
  async deleteWorld(id)                   // and all its chunks
  async getChunkKeys(worldId) -> Set<'cx,cz'>
  async loadChunk(worldId, cx, cz) -> Uint8Array|null
  async saveChunks(worldId, [{ cx, cz, blocks }])
}
export function rleEncode(u8) -> Uint8Array; export function rleDecode(u8, length) -> Uint8Array   // Node-testable
```
World meta: `{ id, name, seed, seedText, worldType, mode, created, lastPlayed, time, spawn: {x,y,z},
player: Player.serialize() | null }`.

### 9.7 Player, interaction, input (player agent; physics.js is shared/done)
```js
// physics.js (pure, SHARED/done — read the source for exact behaviour)
export class PhysicsBody {
  constructor(width, height)
  x, y, z, vx, vy, vz                       // feet position, velocity (blocks/s)
  onGround, collidedX, collidedY, collidedZ, inWater, inLava
  move(world, dx, dy, dz) -> void          // axis-separated AABB vs voxel collision (Y, then X, then Z)
  getAABB(out) -> { minX, minY, minZ, maxX, maxY, maxZ }
  updateFluidState(world)                  // sets inWater/inLava from overlapping blocks
}
export function raycast(world, ox, oy, oz, dx, dy, dz, maxDist, { includeLiquids = false } = {})
  -> { x, y, z, face, blockId, distance, px, py, pz } | null   // DDA; uses selection boxes
export function aabbIntersectsSolid(world, minX, minY, minZ, maxX, maxY, maxZ) -> bool
// input.js
export class Input {
  constructor(canvas, settings)
  enabled                                   // false while a UI screen is open (actions read as idle)
  isDown(action), pressed(action), released(action)   // edge-detected per frame
  mouseDX, mouseDY, wheel                   // accumulated since last endFrame()
  locked; requestLock(); exitLock(); onLockChange(fn)
  endFrame()
}
// actions: forward back left right jump sneak sprint inventory drop chat command debug hideHud
//          perspective attack(LMB) use(RMB) pickBlock(MMB) hotbar1..hotbar9 pause
// default keys: WASD, Space, ShiftLeft, ControlLeft, E, Q, T, Slash, F3, F1, F5, digits; Escape
// player.js
export class Player {
  constructor(game)
  x, y, z, vx, vy, vz, yaw, pitch, onGround, flying, sneaking, sprinting, inWater, eyeInWater, inLava,
  mode /* 'survival'|'creative' */, health /* 0..20 */, food /* 0..20 */, air /* 0..300 ticks */, dead,
  inventory /* Inventory */, selectedSlot /* 0..8 */, spawnPoint {x,y,z}
  update(dt, input)        // look, movement, physics, swimming/flying, fall damage, drowning, lava/cactus
                           // damage, natural regen; frozen while the player's chunk is not meshed
  getEyePosition() -> [x,y,z]; getLookVector() -> [x,y,z]
  getCameraState() -> { x, y, z, yaw, pitch, roll, fov }   // includes view bobbing + sprint FOV
  setPosition(x, y, z); setGameMode(mode)
  damage(amount, cause) -> bool; heal(amount); respawn()
  getSelectedStack() -> stack|null
  serialize() -> object; deserialize(obj)
}
// interaction.js
export class Interaction {
  constructor(game)
  update(dt, input)        // targeting, breaking (survival timing + cracks + hit particles + sounds, tool
                           // durability, drops via game.spawnItem; creative instant with 0.15 s repeat),
                           // placing (variants via getPlacementBlock, no placing inside entities/player,
                           // replaceable targets), use (crafting table -> game.ui.openCraftingTable()),
                           // pick block (MMB), drop (Q / Ctrl+Q), hotbar selection (1-9, wheel)
  target -> { x, y, z, face, blockId } | null
  breaking -> { x, y, z, progress } | null
  getHandState() -> HandState (§9.5)
}
```
Movement constants (Minecraft-like): walk 4.317 b/s, sprint 5.612, sneak 1.31, fly 10.9 (sprint-fly
21.6), gravity 32 b/s², jump velocity ≈ 9.0 (≈1.25 block jump), terminal velocity 78, water: slow,
buoyant, Space swims up; double-tap Space toggles flying (creative); double-tap W or Ctrl sprints;
sneaking prevents walking off edges. Fall damage `ceil(fallDistance − 3)` (not into water).
Drowning after 15 s underwater (2 dmg/s). Lava 4 dmg / 0.5 s. Regen +1 HP / 4 s when food ≥ 18.

### 9.8 UI, crafting, commands (UI agent; inventory.js is shared/done)
```js
// inventory.js (pure, SHARED/done — also: cloneStack, canAdd, firstEmpty, damageItem(i, n) -> broke, changed(), isEmpty())
export function makeStack(id, count = 1, damage = 0) -> { id, count, damage }
export function canMerge(a, b) -> bool
export class Inventory {
  constructor(size = 36)                   // 0..8 hotbar, 9..35 main
  slots; version                           // version++ on every mutation
  get(i); set(i, stack|null)
  add(stack) -> leftover count             // merge into same stacks (hotbar first), then empty slots
  removeFromSlot(i, count) -> stack|null
  count(id) -> number; consume(id, count) -> bool; findSlot(id) -> index|-1
  clear(); serialize() -> array; static deserialize(arr) -> Inventory
}
// crafting.js (pure)
export function matchRecipe(grid /* (stack|null)[] */, width /* 2|3 */) -> { result: stack, recipe } | null
export function consumeIngredients(grid, width, recipe) -> void
export const SMELTING   // Map inputItemId -> { output: stack, time: 10 }   (for the furnace, later wave)
// commands.js
export function runCommand(game, text) -> void  // /help /gamemode /time /tp /give /clear /kill /seed
                                                // /spawnpoint /setblock /fill — Chinese feedback via game.addChatMessage
// ui/ui.js
export class UIManager {
  constructor(game, root /* #ui-root */)
  showTitle(); showLoading(text); setLoadingProgress(fraction, text); enterGame();
  openPause(); openInventory(); openCraftingTable(); openChat(prefill = ''); openDeath(message);
  openOptions(); closeScreen(); isScreenOpen() -> bool; currentScreen -> string|null
  update(dt)              // HUD per frame (hotbar, hearts, food, air bubbles, crosshair, debug F3, chat fade)
  toggleDebug(); toggleHud(); showActionText(text)
}
```
Screens (Minecraft look: dirt-texture background, grey bevelled buttons, white text with dark shadow,
pixel-crisp item icons from `game.icons.getIcon(id)`): title (logo "WebCraft" + subtitle 方块世界,
单人游戏 / 选项 / 关于), world list (play/create/delete), create world (name, seed, 生存/创造, 默认/超平坦),
options (render distance 2–16, FOV, mouse sensitivity, invert Y, view bobbing, smooth lighting, clouds,
sound & music volume, show FPS), pause (回到游戏, 选项, 保存并退出到标题画面), survival inventory (2×2
crafting + result, 27 main + 9 hotbar), creative inventory (tabs from CREATIVE_TABS + search + scroll,
infinite stacks, delete slot), crafting table (3×3), chat (T, `/` prefilled, history, commands), death
screen (重生 / 返回标题画面), loading screen with progress. Slot interactions like Minecraft: left click
pick/place/swap, right click split/place one, shift-click quick-move (and craft-all on result), drag
spreading optional, closing returns grid + cursor items to inventory (or drops them).
Recipes (shaped unless noted; horizontal mirroring allowed; tags `#planks` = any of the 3 planks,
`#logs` = any of the 3 logs): log → 4 planks of the same wood; 2 planks stacked vertically → 4 sticks;
2×2 planks → crafting table; coal or charcoal above a stick → 4 torches; ring of 8 cobblestone →
furnace; all 20 tools (sword / shovel / pickaxe / axe × planks, cobblestone, iron ingot, gold ingot,
diamond, with sticks, standard Minecraft shapes); 2×2 sand → sandstone; 2×2 stone → 4 stone bricks;
3×3 iron ingots / gold ingots / diamonds / coal / lapis → storage block, and storage block → 9;
iron ingot + flint (shapeless) → flint and steel; pumpkin above torch → jack o'lantern; 3 iron ingots
in a V → bucket; 2×2 string → white wool; gunpowder/sand checkerboard (5 + 4) → TNT; stone bricks +
(nothing else) — keep the list Minecraft-faithful and data-driven so more can be added.

### 9.9 Audio (audio agent): src/game/audio.js
```js
export class AudioEngine {
  constructor(settings)
  unlock()                                 // resume AudioContext on the first user gesture
  setVolumes(sound, music)
  setListener(x, y, z, yaw)
  playBlock(kind /* 'break'|'place'|'step'|'hit'|'land' */, material /* block.sound */, x, y, z)
  play(name, { x, y, z, volume = 1, pitch = 1 } = {})
      // 'click' 'pop' 'hurt' 'death' 'splash' 'swim' 'explode' 'fuse' 'eat' 'burp' 'break_tool'
      // 'pig' 'cow' 'sheep' 'chicken' 'zombie' 'zombie_hurt' 'creeper_hiss' (mob ones used later)
  startMusic(); stopMusic(); update(dt)    // procedural, calm, sparse ambient piano music
}
```
Everything synthesized with WebAudio (noise buffers, filters, envelopes, oscillators, a generated
reverb impulse). Positional sounds use distance attenuation + stereo panning relative to the listener.

### 9.10 Game (integrator): src/game.js, src/main.js
`main.js` loads settings (localStorage `webcraft.settings`), generates textures, creates the Renderer,
IconFactory, Storage, WorkerPool, AudioEngine, Input, UIManager and the `Game`, then shows the title.
```js
game = {
  canvas, renderer, input, ui, audio, storage, pool, icons, settings,
  world, player, interaction, entities, particles,     // null outside a world
  worldMeta, state /* 'title'|'loading'|'playing' */, paused, time /* ticks */, fps,
  get timeOfDay(), get daylight(),
  on(evt, fn), off(evt, fn), emit(evt, ...args),
  async listWorlds(), async createWorld({ name, seedText, mode, worldType }) -> meta,
  async startWorld(meta), async deleteWorld(id), async saveWorld(), async quitToTitle(),
  setPaused(bool), applySettings(partial), setGameMode(mode), setTime(ticks),
  runCommand(text), addChatMessage(text, color),
  spawnItem(stack, x, y, z, vx, vy, vz, pickupDelay), dropFromPlayer(stack),
  getDebugInfo() -> string[],
}
```
Events: `settingsChanged`, `worldLoaded`, `worldUnloaded`, `gameModeChanged`, `playerDied`,
`playerRespawned`, `chat`, `blockChanged`, `loadingProgress`.
Loop: `dt = min(0.1, frame delta)`; while playing and not paused: player.update → interaction.update →
fixed 20 TPS ticks (time, world.tick) → entities/particles update → world.update; always render; UI
update; input.endFrame. Autosave every 30 s and on quit / `visibilitychange` hidden.
Opening a screen exits pointer lock and disables game input; closing re-locks. Losing pointer lock
while playing opens the pause menu. Debug/automation hooks:
* URL params: `autostart=1` (new temporary world, not saved unless `save=1`), `seed=`, `mode=`,
  `type=`, `rd=`, `time=`, `nomusic=1`.
* `window.__game = game`; `window.__ready = true` once the spawn area (radius 2) is meshed and a frame
  rendered.
* `game.debug = { tp(x,y,z), look(yaw,pitch), setTime(t), setBlock(x,y,z,nameOrId), getBlock(x,y,z),
  give(name,count), setMode(m), waitIdle(timeoutMs) -> Promise, stats(), hideHud(bool) }`.

## 10. Gameplay reference values
* Break time: `getBreakTime` (registry). Creative: instant, 0.15 s between breaks while holding.
* Reach: survival 4.5, creative 5 (from the eye).
* Tool durability: −1 per block broken with it (swords −2), −1 per hit with a sword (others −2).
* Item pickup delay 0.5 s (2 s for player-thrown items). Stacks merge within 0.5 blocks.
* Player death drops the whole inventory (survival). Respawn at the world spawn point.
* New worlds start at time 1000 (morning). Creative hotbar: `DEFAULT_CREATIVE_HOTBAR`.

## 11. Performance targets
* 60 FPS at render distance 8 (RTX-class GPU), no long frames when crossing chunk borders.
* Chunk generation < 15 ms, light+mesh < 25 ms per chunk in workers; ≤ 4 ms/frame of GPU uploads.
* Memory: chunks unloaded beyond rd + 2 (meshes freed from the GPU, modified chunks saved first).

## 12. Testing expectations
* Every pure module ships Node tests (`tests/<module>.test.js`, run with `npm test`).
* Every visual module ships a standalone page in `tools/` and the agent must screenshot it with the
  harness and look at the result.
* Reports must list: files written, public API deviations from this spec (if any), test status,
  known limitations.

## 13. Misc contracts
### 13.1 index.html
```html
<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>WebCraft 方块世界</title>
<link rel="icon" href="data:,"><link rel="stylesheet" href="css/style.css"></head>
<body><canvas id="game-canvas"></canvas><div id="ui-root"></div>
<script type="module" src="src/main.js"></script></body></html>
```
The canvas fills the window; `#ui-root` overlays it (pointer-events only on interactive elements).
### 13.2 Settings object
`DEFAULT_SETTINGS` in config.js; persisted to localStorage key `webcraft.settings`; changes go through
`game.applySettings(partial)` which emits `settingsChanged`.
