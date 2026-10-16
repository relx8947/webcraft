# Mesher agent notes — `src/world/lighting.js`, `src/world/mesher.js`

## API (SPEC §9.2, implemented as specified)

```js
// lighting.js
buildRegion(chunks /* Uint8Array[9], (dz+1)*3+(dx+1) */, out?) -> Uint8Array(REGION_VOLUME)
computeLight(region, out?) -> Uint8Array(REGION_VOLUME)        // packed sky<<4 | block, region layout
extractChunkLight(regionLight, out?) -> Uint8Array(65536)       // centre chunk, chunk layout
// mesher.js
meshChunk(region, light, sectionMask, tints, options = { smoothLighting: true })
  -> [{ sy, opaque, cutout, translucent }]   // one entry per requested section, ascending sy; null = empty layer
decodeVertex(w0, w1, w2) -> { x, y, z, ao, face, layer, u, v, sky, block, anim, r, g, b }
```

Additive exports (not in the spec, safe to ignore): `regionMaxY(region)`, `centerMaxY(region)`
(lighting.js); `decodeMesh(uint32Array) -> [{ verts: [decodeVertex x4] }]`, `VERTEX_WORDS = 3`,
`QUAD_WORDS = 12` (mesher.js).

* `decodeVertex`: `x, y, z` are in blocks relative to the section origin (`(s - 16) / 16`); `sky` and
  `block` are the stored ×4 values (0..60) — divide by 4 for the light level.
* `buildRegion`: a missing (null/undefined) neighbour chunk is treated as all air. Mesh only when all
  8 neighbours exist, otherwise border faces and light leaks appear (as in any voxel engine).
* `meshChunk`: `light` may be null (it is then computed); `tints` may be null (`DEFAULT_TINTS`);
  every returned typed array is an exact-size copy (`slice`) and can be transferred.
* All three functions reuse module-level scratch memory; they are synchronous and not re-entrant
  (fine: JS is single threaded, each worker has its own module instance).

## Light (SPEC §6)

* Region rows are copied 4 bytes at a time (Uint32 views; an unaligned input falls back to bytes).
* `regionMaxY` (highest non-air block) is found by a backwards Uint32 scan. Everything above it is
  filled with `0xF0` (open sky) in one `fill`; only `y <= maxY` is scanned by the direct pass and the
  emitter scan. Block light may still rise above `maxY` (torch on a pillar top) — the BFS handles it.
* Sky direct pass per column exactly as specified, recording per column the lowest directly lit y
  (`floor`) and the height above which everything is 15 (`top15`).
* Sky seeds: within a column the direct pass already satisfies the propagation rule vertically, so
  only horizontal improvements are possible, and only below the highest `top15` of the 4 neighbours.
  Those candidate cells are checked against their horizontal neighbours and seeded only if they can
  actually brighten one. This keeps the sky BFS proportional to the shadowed volume (caves, overhangs,
  canopies), not to the whole lit air volume.
* Propagation uses 16 level buckets (grow-only `Int32Array`s, packed coords `x | z<<6 | y<<12`)
  instead of one FIFO ring: all level-L cells are expanded before any level L-1 cell, and since the
  cost of entering a cell depends only on that cell, each cell is finalised the first time it is
  improved (a FIFO from mixed-level seeds re-expands areas when a brighter seed arrives later).
  Stale entries are skipped; level-1 cells are never queued.
* Opaque emitters (glowstone, jack o'lantern) keep light 0 and directly relax their 6 neighbours.
* Exactness is tested against a brute-force Bellman-Ford fixpoint of the SPEC rules on random regions
  (all 590k cells compared, all levels 0..15 occur).

## Mesh (SPEC §7)

Face frames (vertex order = texel (0,0) (0,16) (16,16) (16,0) = TL, BL, BR, TR seen from outside,
which is counter-clockwise from outside for every face):

| face | plane | u axis | v axis | (u,v)=(0,0) corner |
|------|-------|--------|--------|--------------------|
| 0 +X | x=1 | -Z | -Y | (1,1,1) |
| 1 -X | x=0 | +Z | -Y | (0,1,0) |
| 2 +Y | y=1 | +X | +Z | (0,1,0) |
| 3 -Y | y=0 | +X | -Z | (0,0,1) |
| 4 +Z | z=1 | +X | -Y | (0,1,1) |
| 5 -Z | z=0 | -X | -Y | (1,1,0) |

Partial faces use the same planar mapping, so the texel rectangle always matches the geometry
(no stretched pixels). `FACE_ROTATION` = 1 rotates the corners' texel coordinates by one position
(a 90° rotation, never a mirror): the bark grain then runs along the log axis on all 4 side faces.

Smooth lighting: the 3×3 cells in front of the face are read once per face (bounds-checked in y:
below the world = opaque, above = open sky), then AO/light per vertex exactly as specified, ×4
rounded; diagonal flip when `ao0+ao2 < ao1+ao3`, ties broken by `sky+block` sums. Flat mode: light of
p+N, ao 3. Tests check every cube face of random scenes against an independent implementation.

### Decisions where the spec is silent (Minecraft-faithful)

1. **Torch faces use face index 6** (unshaded, like Minecraft's `"shade": false` torch model), own-cell
   light, ao 3. Bottom face (texels u 7..9, v 13..15 as in Minecraft's model) only when the block
   below is not opaque (a torch on glass/leaves). Top face u 7..9 / v 6..8 per spec.
2. **Liquids: no AO** (Minecraft's fluid renderer has none — avoids dark shore lines on water), smooth
   light from the cells in front; the **surface uses max(sampled, own cell)** like Minecraft
   (`max(light(pos), light(above))`) so lava surfaces are fully bright. Faces against the same liquid
   are culled, *except* the 2/16 strip of a full-height liquid block (same liquid above) above a
   neighbouring lowered surface of that liquid — closes the hole Minecraft also fills.
   Surface under an opaque block: stays at 14/16 and is culled (per spec).
3. **Cactus = Minecraft's cactus model** (integrator wave 2, review RENDER-2): sides inset by 1/16 along
   their normal but spanning the full block width with texels 0..16, so the spines in texture columns
   0 / 15 overhang the corners (cutout); top/bottom 14/16 flush at the block boundary with texels 1..15, culled
   against opaque blocks **and another cactus** (no inner faces in stacks). Inset sides are never
   culled and are lit from the block's own layer (Minecraft samples the own position for faces that
   are not on the block boundary).
4. **Cross plants**: 0.15→0.85 quantises to 2/16→14/16 on the 1/16 vertex grid. Sway (anim 1) is set
   on the top vertices, except where the same plant continues above (stacked sugar cane keeps its
   joints closed — only the top of the stack sways) and for mushrooms (rigid).
5. Bottom faces at y = 0 are never emitted (nothing can see them); top faces at y = 255 are.
6. Leaves are detected by name (`*_leaves`, cube render type) for anim 2; liquids by `liquid`.
7. Glass/ice/leaves never cast AO and are excluded from the light average only if opaque (they are
   not) — exactly per spec (`IS_OPAQUE`).

## Performance (Node 22, this machine; `node tools/mesher-bench.mjs --worldgen`)

light + mesh of all 16 sections, median of 30 runs (region copy ~0.1 ms, light extraction ~0.01 ms):

| scenario | light | mesh | total | quads (opaque/cutout/translucent) |
|---|---|---|---|---|
| synthetic plains/forest | 0.51 | 0.57 | 1.08 ms | 1085 / 1204 / 0 |
| synthetic hills | 0.85 | 0.68 | 1.54 ms | 2993 / 42 / 0 |
| synthetic mountains (maxY 171) | 1.58 | 1.02 | 2.60 ms | 4720 / 195 / 0 |
| synthetic ocean | 0.47 | 0.38 | 0.85 ms | 361 / 0 / 256 |
| real worldgen chunks (3) | ~0.70 | ~0.57 | ~1.28 ms | 1039–2207 / 0–1580 / 0–256 |
| worst case: random 35% air noise up to y=120 | 2.51 | 3.76 | 6.27 ms | 33573 / 1802 / 900 |

Budget 25 ms, target 12 ms: met by ~10× on real terrain, ~2× on the pathological noise case. In the
browser preview (Edge) 9 chunks average ~2.1 ms per chunk including first-call JIT warm-up.

## Verification

* `node --test tests/lighting.test.js tests/mesher.test.js` — 43 tests (region layout, canonical light
  setups, brute-force exactness, counts/culling for every render type, winding + UV frames + texel
  exactness for every face, AO, flip, flat mode, tints, rotation, sections/masks, random-id fuzzing of
  every emitted word, soft perf budget).
* `tools/mesher-preview.html` — standalone WebGL2 page running the real pipeline on a 5×5-chunk world
  (`?scene=showcase|terrain&view=0..6&t=0.75&smooth=0&tex=debug`; `tex=debug` paints an "F" glyph on
  every block texture to check UV orientation / mirroring). Screenshots in `tools/out/`.
* `tools/mesher-bench.mjs` — timings (synthetic terrain from `tools/mesher-terrain.mjs`, optional real
  worldgen with `--worldgen`).

## Known limitations

* Liquids are static sources only (no flow levels / sloped surfaces) — matches the block set.
* Water faces against glass/leaves are coplanar with the glass/leaves face; seen from *inside* the
  water both are drawn (translucent pass has culling off) and may fight slightly. Outside views are
  unaffected (the glass face toward the water is back-facing there).
* Biome tint is per column of the centre chunk (as specified); no cross-chunk tint blending.

## Integration (worker.js / world.js)

```js
import { REGION_VOLUME } from '../config.js';
import { buildRegion, computeLight, extractChunkLight } from './lighting.js';
import { meshChunk } from './mesher.js';
const regionBuf = new Uint8Array(REGION_VOLUME);   // reused across jobs
const lightBuf = new Uint8Array(REGION_VOLUME);
// on { type: 'mesh', jobId, cx, cz, chunks, sectionMask, smoothLighting }:
const region = buildRegion(msg.chunks, regionBuf);
const light = computeLight(region, lightBuf);
const sections = meshChunk(region, light, msg.sectionMask, generator.getTints(msg.cx, msg.cz),
  { smoothLighting: msg.smoothLighting });
const chunkLight = extractChunkLight(light);       // fresh array -> transferable
const transfer = [chunkLight.buffer];
for (const s of sections) for (const k of ['opaque', 'cutout', 'translucent']) if (s[k]) transfer.push(s[k].buffer);
postMessage({ type: 'meshed', jobId: msg.jobId, cx: msg.cx, cz: msg.cz, sections, light: chunkLight }, transfer);
```

* Every requested section gets an entry, so `renderer.setSectionMesh(cx, sy, cz, s.opaque, s.cutout,
  s.translucent)` with all-null correctly deletes a section that became empty.
* Renderer: face 6 is used by cross plants **and torches** (unshaded); positions never leave 0..16 per
  axis within a section; anim 1 only on top vertices of cross plants, 2 on every leaf vertex, 3 on
  every liquid vertex (add `floor(time*8) mod 16` to the layer).
