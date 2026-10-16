# Textures agent notes (`src/render/textures.js`)

Procedural 16×16 pixel art for every entry of `TEXTURES` (registry), the mip chain, sky textures
and inventory icons. SPEC §5.2, §5.3, §9.4.

## Public API

| export | notes |
|---|---|
| `generateTextures()` → `{ size: 16, layers, data }` | RGBA8, layer-major in registry order, **row 0 = top of the picture** (= `v = 0`). Pure, deterministic, ~13–20 ms (Node / Edge). Throws `no painter for texture '<name>'` if the registry gains a texture without a painter. |
| `getLayerAlphaModes()` → `string[]` | one entry per layer (animated frames expanded): `opaque` / `tintmask` / `cutout` / `translucent`. |
| `buildMipChain(data, size, layers, alphaModes)` → `Uint8Array[]` | levels `0..log2(size)` (16, 8, 4, 2, 1 px). **`levels[0] === data`** (no copy). `size` must be a power of two. ~7 ms. |
| `generateMiscTextures()` → `{ sun, moon, clouds }` | sun/moon `{ width: 32, height: 32, data }` RGBA; clouds `{ width: 256, height: 256, data }` one byte per cell (0/255). ~20 ms. |
| `IconFactory` (browser) | `new IconFactory(textures)`, `getIcon(itemId)` → cached 48×48 PNG data URL. All 126 icons ≈ 60 ms on first use, then free. |

Additive exports (not in the spec, useful for tests/tools/other agents):

* `paintTexture(name, frame = 0)` → `Uint8Array(1024)` — one layer with the registry alpha rules applied.
* `hasTexturePainter(name)` → `bool`.
* `renderIconPixels(textures, itemId, size = 48)` → `Uint8ClampedArray` — the pure (Node-safe) icon
  rasteriser behind `IconFactory`; any icon size works (e.g. 32 or 64 for other GUI scales).

## Determinism

Each painter receives `mulberry32(hash('webcraft:' + name))`; output never depends on call order,
`Math.random` or the environment. Derived textures (grass side, ores, mossy variants, bookshelf,
jack o'lantern) paint their base with the *base texture's* seed, so e.g. the dirt under the grass
fringe is texel-identical to the dirt block, and every ore sits on the exact stone texture. The
ten crack stages share one growth order (seed `destroy_stage`), so each stage contains the previous.

## Art approach

* **Limited palettes + rank quantisation**: periodic value noise (lattice wraps every 16 px, random
  phase) is summed in a few octaves and quantised by *rank* into 4–7 palette shades with fixed
  shares (e.g. 7% / 19% / 48% / 20% / 6%). This yields crisp clusters and identical histograms per
  family. All noise is periodic, so natural textures tile seamlessly (unit-tested).
* **Cellular materials** (cobblestone, gravel, glowstone, leaf clumps): toroidal weighted Voronoi;
  1-px seams where a cell meets a different cell right/below; per-cell tone; a "dome" light term
  (height = distance to the border, lit from the top-left).
* **Hand-authored maps** (string grids + palettes) for everything that must be instantly
  recognisable: flowers, saplings, mushrooms, torch, crafting-table tools, furnace mouth, TNT label,
  jack o'lantern face, all items. Items get an automatic 1-px outline in a darker per-material
  colour (`itemSprite`); tools share four shapes (sword/shovel/pickaxe/axe) × five head palettes
  with a common stick handle running diagonally from the bottom-left. Exception: `string` is a
  thin white thread with a soft grey shadow instead of a hard outline (an outline turned the 1-px
  thread into a "chain").
* Light always comes from the top-left (highlights top/left, shadows bottom/right).

Texture-specific decisions:

* `grass_block_top`: grey (avg ≈ 0.63), alpha 0 everywhere. `grass_block_side`: the dirt texture
  (alpha 255) with a grey grass fringe of 3–4 px plus 1–2 px drips (alpha 0), lower lip shaded.
* Leaves: grey, binary alpha, hole share 30% (oak), 28% (birch), 26% (spruce).
* `glass`: light frame (top/left lighter) + diagonal shine streaks, everything else alpha 0.
* `water_still`: 16 frames, four blues (alpha 176–183) + ripple lines (alpha 188) formed by a
  moving contour band. Motion is a small circular drift + time-periodic noise → zero net drift,
  frame 15 → 0 is as smooth as any other step (unit-tested). `lava_still`: same scheme, 7 shades,
  opaque.
* `ice`: alpha 160–205, light-blue with white scratches.
* `torch`: only columns 7–8 are used; flame rows 6–7, charred row 8, stick rows 9–15 (SPEC §7
  sub-rects `u 7..9, v 6..16` sides, `v 6..8` top).
* Cactus: `cactus_side` columns 1–14 are fully opaque (the mesher insets side faces by 1/16);
  columns 0 and 15 are transparent except a few spine pixels, so spines poke out of the silhouette
  like in Minecraft. `cactus_top` / `cactus_bottom` have a transparent 1-px rim so the full-size
  top face matches the inset sides.
* Wool: one shared weave level map, 16 dye colours (Minecraft 1.14 dye values).
* Storage blocks: bevelled plates (iron/gold/diamond with brushed streaks, sparkles, facet lattice),
  lapis with a subtle bevel, coal block as dark noise.
* `destroy_stage_N`: transparent texels are **RGB 128, alpha 0** (neutral for the `2·src·dst`
  multiply blend); crack texels are dark grey alpha 235, a 1-px halo alpha 120. Stage 0 ≈ 5 crack
  texels at the centre, stage 9 = 145.

## Alpha contract enforcement (after painting)

* `opaque` → alpha forced to 255.
* `tintmask` → alpha binarised (0/255); every alpha-0 texel converted to grey (luma).
* `cutout` → alpha binarised; tinted cutouts (leaves, short grass, fern, sugar cane) converted to
  grey; RGB of transparent texels **bled from opaque neighbours** (iterative dilation) so no
  filter/mip level can pull in black.
* `translucent` → alpha kept (tinted ones would be greyed; none are tinted today).

## Mip chain

Each level is a box filter of level 0 (exact, no cumulative rounding):
`opaque` plain average + alpha 255; `tintmask` plain RGB average + averaged mask alpha;
`cutout` alpha-weighted RGB and alpha **re-thresholded to 0/255 keeping the k texels with the
highest averaged alpha, k = round(coverage₀ · texels)** — foliage keeps its density at distance;
`translucent` alpha-weighted RGB + averaged alpha. Consequence: very sparse cutouts (torch ≈ 8%
coverage) vanish at the 2×2 and 1×1 levels, which is coverage-correct.

## Icons

Orthographic Minecraft GUI view (pitch 30°, yaw 45°, block edge = 0.625 × icon width → 30 px at
48 px) rasterised per pixel with nearest sampling: top face (shade 1.0), south face on the left
(0.8), east face on the right (0.6), front-to-back compositing for cutout/translucent blocks.
Faces come from `FACE_LAYERS`, so crafting table / furnace / jack o'lantern show their front on
the left. Cactus sides are inset by 1/16 like the world mesh. §5.3 tint rules with
`DEFAULT_TINTS`: OPAQUE-layer blocks use `rgb·mix(tint, 1, a)` (alpha → 255), others `rgb·tint`.
Cross/torch blocks and items are flat 3× sprites. Air / unknown ids → transparent icon. Hidden
variant block ids (`oak_log_x`, `furnace_north`, `snowy_grass_block`, …) render as their base item
(via `itemForBlock`), so a pick-block of a sideways log still shows an upright log icon.

## Integration notes

* **Texture array upload** (verified in `tools/texture-scene.html`): `texStorage3D(TEXTURE_2D_ARRAY,
  5, RGBA8, 16, 16, layers)`, then `texSubImage3D(level k, …, 16>>k, 16>>k, layers, RGBA,
  UNSIGNED_BYTE, mips[k])`. No `UNPACK_FLIP_Y`, no premultiply. MAG `NEAREST`, MIN
  `NEAREST_MIPMAP_LINEAR`, `MAX_LEVEL 4`, anisotropy if available.
* Shader rules exactly as §5.3; for the crack overlay use `vec3 c = mix(vec3(0.5), tex.rgb, tex.a)`
  and then the `DST_COLOR, SRC_COLOR` blend (or discard `a < 0.05`) — transparent texels are
  already neutral grey, so even a plain `tex.rgb` works at mip level 0.
* Liquids: `frame = floor(time * 8) mod 16` added to the layer; both animations loop seamlessly.
* Sun/moon: straight alpha; fully transparent texels have RGB 0, so additive `SRC_ALPHA, ONE`
  (or even `ONE, ONE`) works; sample with `NEAREST`. Sun core = centre 16×16, halo to the edge;
  moon = 16×16 pale square with craters, no halo (a faint rim reads as a grey box on the night sky).
* Clouds: `data[y * 256 + x]`, 255 = cloud. ~40% coverage, tileable, majority-filtered blob
  outlines (no single-cell specks), meant as one cell per cloud column (Minecraft uses 12 blocks).
* Particles / dropped items / held items may sample any sub-rect of block layers using the same
  §5.3 rules; item layers have transparent backgrounds with a 1-px dark outline.
* `IconFactory.getIcon(id)` returns 48 px art made for GUI scale 3; display with
  `image-rendering: pixelated` when scaling.

## Verification

* `node --test tests/textures.test.js` — 17 tests: layer count/size, painter for every registry
  name (and `paintTexture` == `generateTextures` per layer), alpha rules per layer, tint-mask rules
  (grass top all alpha 0 + grey; side fringe depth 3–6, grey, dirt below), grey tinted cutouts and
  leaf hole ratio 25–35%, water/ice alpha ranges, neutral + growing crack stages, torch/cactus
  geometry, determinism (textures + misc), "no flat stub" colour counts, seamless tiling statistic
  for natural textures, animation loop smoothness, mip sizes/rules/coverage preservation, misc
  textures (sizes, transparency, cloud coverage + tiling), performance (< 150 ms), item sprite
  backgrounds, icon rasteriser (green grass top, south face lighter than east, every item non-empty,
  tinted grass sprite).
* `tools/texture-preview.html` (query: `section=textures,tiles,wall,icons,misc,mips,cracks`,
  `scale=N`, `filter=<regex>`): every texture ×N with tinted variants, animated strips, 3×3 tiling
  check, terrain/building "walls", all icons on light/dark slots, sky textures, mip chains, crack
  stages composited over stone.
* `tools/texture-scene.html?view=near|far|ground|top&t=<s>`: WebGL2 diorama using the real texture
  array + mip chain + §5.3 rules (validates upload, cutout/translucent behaviour and distant mips).

## Known limitations

* The isometric icon rasteriser samples one point per pixel (like Minecraft's GUI at scale 3), so
  texel widths alternate between 1 and 2 px on the faces.
* Sparse cutouts (torch, mushrooms) disappear at the smallest mip levels by design of coverage
  preservation.
* Art is original but necessarily simpler than hand-painted Minecraft assets in a few spots
  (crafting-table tools, flint-and-steel, rotten flesh).

## Wave 2 update (ART agent, see docs/notes/art-wave2.md)

* Painters for every wave-2 texture (chest, lit furnace, farmland, wheat stages, new food, bow + pulling
  frames, arrow, hoes, spawn eggs); `MISSING_TEXTURES` is empty (the checker fallback stays as a safety net).
* The icon rasteriser handles boxes (`boxFaces`: planar UVs or per-face texel rects): chest = 14/16 box with the
  3D lock (same UVs as the mesher), farmland = 15/16 box, crops = flat sprites.
