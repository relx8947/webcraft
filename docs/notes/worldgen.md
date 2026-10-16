# World generation notes (worldgen agent)

Files: `src/util/noise.js`, `src/world/worldgen.js`, `tests/noise.test.js`, `tests/worldgen.test.js`,
`tools/worldgen-map.html` (+ `tools/worldgen-map-worker.mjs`, `tools/worldgen-view-worker.mjs`),
`tools/worldgen-real.html`.

## Public API (SPEC §9.1) and additions

```js
// noise.js
hashString(str) -> uint32            // FNV-1a over UTF-16 units + murmur3 finalizer
mulberry32(seed) -> () => [0,1)
hash3i(seed, x, y, z) -> uint32      // per-position randomness
SimplexNoise(seed): noise2D, noise3D -> [-1, 1] (scaled so extremes reach ~±1, clamped)
fbm2D(noise, x, y, octaves, persistence = 0.5, lacunarity = 2) -> [-1, 1]
// additions: hash3f (hash3i as float), fbm3D, ridged2D ([0,1] ridged multifractal)

// worldgen.js
parseSeed(text) -> uint32            // /^[+-]?\d+$/ -> BigInt mod 2^32 (64-bit MC seeds work), else hashString
BIOMES                               // frozen objects { id, name, displayName, grassColor, foliageColor,
                                     //   mapColor, temperature, precipitation, water? }
new WorldGenerator(seed, worldType = 'default')   // 'flat' supported; string seeds go through parseSeed
  generateChunk(cx, cz) -> Uint8Array(65536)      // fresh array each call (transferable)
  getBiome(x, z) -> BIOMES entry                  // exactly the biome used during generation
  getTints(cx, cz) -> { grass, foliage }           // Uint32Array(256) each, z*16+x, r | g<<8 | b<<16;
                                                  // fresh copies (internally cached, 128 chunks)
  findSpawn() -> { x, z, y }                      // y = first free block above the ground (additive)
  growTree(access, x, y, z, kind, rng) -> bool
// additions: BIOME_ID (name -> id), sampleColumn(x, z) (cheap 2D sample for tools / debug),
//            debugBuildTree(kind, seed), WorldGenerator#_debugTreesFor(cx, cz) (tests)
```

`growTree` kinds: `'oak'` (10% large), `'large_oak'`, `'birch'`, `'tall_birch'`, `'spruce'` (30% pine),
`'pine'`, the sapling names (`'oak_sapling'`…) or sapling block ids. The block below (x, y-1, z) must be
grass/dirt/snowy grass (it becomes dirt); every log cell and the 3x3 column around the upper trunk must be
free (air, leaves, replaceable plants, saplings), otherwise nothing is placed and `false` is returned.
Leaves only fill air/replaceable cells; logs replace air/leaves/plants.

## Biomes (18)

海洋 ocean, 深海 deep_ocean, 冻洋 frozen_ocean, 沙滩 beach, 积雪沙滩 snowy_beach, 石岸 stony_shore,
河流 river, 冻河 frozen_river, 平原 plains, 森林 forest, 桦木森林 birch_forest, 针叶林 taiga, 雪原 snowy_plains,
积雪针叶林 snowy_taiga, 沙漠 desert, 山地 mountains, 雪峰 snowy_peaks, 繁花森林 flower_forest.
Typical shares over 6000² blocks (seed 12345): ocean 19%, deep ocean 12%, forest 12%, taiga 9%, desert 9%,
plains 7%, frozen ocean 7%, birch forest 5%, snowy taiga 5%, snowy plains 5%, mountains 4%, beach 3%,
river 1.5%, others < 1%. Biome regions are several hundred to ~1500 blocks across.

## Terrain model (1.18-inspired)

Climate noises (domain-warped fBm, normalised to ~N(0,1)): continentalness (~2600-block features, slight
land bias within ~1400 blocks of the origin so spawns are on a continent), erosion, weirdness ("peaks and
valleys", PV = 1 - |3|w| - 2|), temperature (~1900), humidity (~1500), river noise (warped), lake noise,
cave-entrance noise.

Height is ONE continuous function of these (no per-biome switches), so biome borders never create cliffs:
`base(C)` (monotone spline: deep ocean 27 → coast 62 → inland 84) + hills (amplitude from erosion, fading
toward the coast) + PV ridges/valleys + mountains (`mtn = f(C) * f(E)`, ridged noise², soft-capped above
175) + a soft floor at ~63 for inland terrain (so only explicit lakes/rivers go below sea level) + sea-floor
undulation. A 3D density `d = (H - y) + jag * fbm3D` is sampled on a world-aligned 4×8×4 grid (only inside
`|H - y| < jag + 12`; outside the density is exactly `H - y`) and trilinearly interpolated. `jag` grows in
mountains (overhangs, cliffs) and is suppressed near rivers. Per-column 2D details are added after
interpolation: small bumps, desert dunes (smooth "desertness" weight), jagged peak noise, river channels
(|r| < 0.05, bed at 55.5, valley walls blending back over ~5x the width; the valley floor rises with the
mountain factor, so rivers end in dry mountain valleys), lakes (basins in low, flat land only).

Surface rules per solid run (top-down): grass/dirt (3±1 deep), snowy grass in cold biomes, desert sand over
sandstone, beaches sand over sandstone (snow-covered in cold regions), stony shores, stone on steep slopes
(slope ≥ 3 in mountains / above y 120, ≥ 6 elsewhere above y 72), snow blocks above a temperature-dependent
snow line (~124-164) with stone on steep faces, snowy grass in the band below it. Underwater: sand, gravel
on deep floors, clay/gravel/dirt patches in rivers and lakes (smooth, large patches). Water fills all air
≤ 62; frozen climates put ice on the y=62 surface (rivers/lakes fully, frozen oceans as ragged floes that
thin out toward the biome edge).

Caves: cheese caverns (fBm, mostly deep) + two spaghetti networks (intersection of two noise zero-sets,
varying radius) on a 4×4×4 grid; the raw noise fields are interpolated per block and combined afterwards
(interpolating the non-linear tunnel function lost most tunnels). Caves pinch off below the surface except
in "entrance zones" (a 2D noise), where tunnels may open. Ravines: Minecraft canyon carver (1/70 chunks,
~84-112 steps, tall ellipsoids with per-y jagged width), replayed from every origin chunk within 9 chunks.
Cave/ravine air at y ≤ 10 is lava. No carving where any water lies within 3 blocks above (column and its 8
neighbours), so there is never floating water. Sand/gravel left hanging over carved air becomes
sandstone/stone. Bedrock: y=0 solid, y=1..4 with probability 80/60/40/20%.

Ores (classic Minecraft vein shape: spheres along a short random segment; veins of the 3×3 neighbouring
chunks are replayed and clipped): dirt, gravel, granite, diorite, andesite blobs (size 33); coal 20 × 17
(y 0-128) + 8 × 17 (y 128-220, mountains); iron 20 × 9 (≤ 64); gold 2 × 9 (≤ 32); redstone 8 × 8 (≤ 16);
diamond 1 × 8 (≤ 16); lapis 1 × 7 (triangle around 16). Measured per chunk: coal ~157, iron ~82, gold ~9,
redstone ~23, diamond ~3, lapis ~3.

## Features & order independence

Everything is a pure function of (seed, world position): there is no state carried between chunks.

* Extended area: `_prepare` computes per-column data (climate, biome, top solid y, lowest water y, slope,
  surface block, carve ceiling) for the chunk plus a 6-block margin, from the same world-aligned grid and
  with identical arithmetic, so a margin column is bit-identical to the same column computed by its own
  chunk (verified: bounded scans = full scans on 33k columns; order-independence tests).
* Trees: at most one per world-aligned 4×4 cell (offset 0..2, trunks ≥ 2 apart). Whether a cell has a tree,
  its kind and shape depend only on the cell hash and that column's extended data (soil, slope, climate
  mix, no cave-entrance zone, not cut by a ravine — trees never float). Each chunk replays all trees whose
  reach (≤ 5) touches it, in global (z, x) cell order; logs replace leaves, leaves only fill air, so overlaps
  resolve identically in every chunk. Density comes from smooth climate weights (soft forest edges); types
  mix by climate (spruce/pine in cold, birch in wet, large oaks mostly in plains).
* Tree shapes: classic MC oak/birch crown (radii 2,2,1,1 with random corners), tall birch, fancy oak
  (crown + 2-4 branch clusters, MC 5-layer clusters), MC spruce ("taiga2" layered cone), MC pine ("taiga1").
* Cacti / dead bushes: one candidate per 4×4 cell at offsets 1..2 → never adjacent to each other; a cactus
  also needs all 4 neighbour columns lower than its base, only desert (no trees/grass) within 5 blocks and
  no water within 5 (no sugar cane next to it). 1-3 tall.
* Sugar cane: 1-3 tall on grass/sand/dirt at y=62 with water horizontally adjacent (cross-border water
  checked from the extended data). Grass/fern/flower patches by biome (flower species by low-frequency
  noise → single-colour patches), mushrooms under forest canopies and on dark cave floors (y > 11, roofed),
  rare pumpkin patches (1/40 chunks, kept inside the chunk).

## Tints

`getTints` blends Minecraft biome colours with smooth weights from temperature/humidity (logistic steps
with the same thresholds as biome selection), mountains (windswept-hills colour on high rugged ground) and
rivers/coasts (toward the plains colour with a ~50-block falloff; cold areas keep the snowy colour). The
largest step between adjacent columns is ~4/255 per channel; values are continuous across chunk borders.

## Performance (measured)

* `generateChunk`: 1.8-2.0 ms average in Node (100 chunks, test), 2.0 ms on the Edge main thread,
  ~3.6-3.9 ms per chunk in 16 parallel workers (CPU contention). Spec budget: 15 ms.
* `getTints`: ~0.4 ms (cached per chunk afterwards). `getBiome` / `sampleColumn`: ~10-20 µs.
* No per-chunk allocations besides the result array (all scratch buffers are reused).

## Tools

* `tools/worldgen-map.html?seed=…&x=…&z=…&size=1024` (default): shaded 1024² surface map (biome tints,
  hillshade, water depth, origin/spawn markers), labelled biome map with percentages and timing, and a
  cave/ore cross-section strip. `mode=section` (two 512-wide slices, ore histogram per y band),
  `mode=overview&step=8` (8000² blocks from 2D samples; `relief=1`), `mode=view` (CPU raymarched 3D preview
  with sun shadows/AO/water; `gallery=oak,large_oak,…` shows trees grown via `growTree`).
* `tools/worldgen-real.html?seed=…&x=…&z=…&yaw=…&pitch=…&dist=…&up=…&rd=…`: renders generated terrain
  through the real engine (lighting.js, mesher.js, renderer.js, textures.js; imported dynamically).

## Known limitations / decisions

* No aquifers or flowing fluids: caves below sea level are dry (protected from water by the 3-block rule).
* No snow layers block exists, so snowy biomes use snowy grass/snow blocks and trees carry no snow.
* Lakes inside land report the surrounding land biome (as in Minecraft); rivers are river/frozen_river.
* River courses are zero-lines of a 2D noise (like MC 1.18 weirdness rivers): occasionally a short river
  forms a loop or ends in a lake; rivers reaching the coast merge with the sea.
* `hashString` is FNV-1a + finalizer, not Java's `String.hashCode`, so text seeds do not match Minecraft's
  numeric seeds (terrain differs anyway).
* `findSpawn` may generate a few chunks on the calling thread (~2 ms each); the result is cached.
