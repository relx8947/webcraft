# ART agent — wave 2 notes

Owner of `src/render/textures.js` and `src/game/audio.js` (+ `tests/textures.test.js`, `tools/texture-preview.html`).
Covers docs/SPEC-wave2.md §7 (all new textures + icons), the wave-2 sounds, and review finding AUDIO-1.

## 1. Textures (all 39 new registry textures painted — `MISSING_TEXTURES` is empty)

Same style rules as wave 1 (docs/notes/textures.md): small palettes, light from the top-left, per-name seeded
painters, hand-authored maps for anything that must be recognisable, auto 1-px item outlines.

| texture | design |
|---|---|
| `chest_front`, `chest_side`, `chest_top` | Warm orange oak (5 board shades + dark/lit edge colours). The WORLD mesher maps **each texture in full** onto the 14/16 box (uniform 14/16 scale), so the whole tile is one box face: outer ring = box edges (lit top/left, dark right/bottom, bevelled corners). Sides/front: lid = rows 0..5 (lit top edge, one board, lower edge), **gap row 6**, base = rows 7..15 (two boards, seam row 11, bottom edge). Top: edge ring + three boards (seams rows 5, 10). Front: dark-iron latch at **cols 7..8 / rows 4..7** = exactly the texels the mesher's 2×4×1 px lock box samples (front u 7..9 v 4..8, top row 4, bottom row 7, sides column 7), outlined (cols 6/9, row 8) with a drop shadow. |
| `furnace_front_on` | `furnace_front` (same seed, identical stone) + three flame tongues over white-hot embers in the lower opening, glowing embers in the vent, fire light on the ledge and a faint warm cast on the surrounding stone. |
| `farmland`, `farmland_moist` | Crumbly soil grain with 4 straight furrows per tile (period 4 rows: dark groove, lit slope, crest, shaded slope; staggered steps were tried and read as bricks/planks), crumbs fallen into the grooves, clods/pebbles on the ridges. Moist = same pattern in dark wet browns (mean luma < 0.65 × dry). Tile seamlessly (tested). |
| `wheat_stage_0..7` | Five plants per tile (bases 3 px apart so ears never overlap), staggered heights, height = 2 + 2·stage px (matches the selection box growth), leaves from stage 2 (steep blades, ≤ 1 px out so plants never join), colour fresh green → yellow-green → gold, ears from stage 5 (3/4/5 px, lit left grains, dark husk outline), awns at stages 6–7. Every plant stands on row 15 (the crop model puts row 15 on the 15/16 farmland surface). Cutout, untinted. |
| `wheat_seeds` | Six small tilted olive grains with room between them. |
| `wheat` | Diagonal sheaf: thin stalks (bottom-left), twine tie, ears fanning toward the top-right with a grain/husk pattern, pale awns. |
| `mutton`, `cooked_mutton` | Lamb leg: meat with fat streaks (upper right), white bone with knob (lower left); cooked = browns, toasted bone. |
| `chicken`, `cooked_chicken` | Roast bird seen from the side: plump body, wing line, two drumsticks pointing up-right with bone knobs; raw pale pink, cooked golden brown. |
| `spider_eye` | Glossy red-purple eye: dark pupil, bright highlight, bloodshot rim. |
| `arrow` | Hand-drawn along the anti-diagonal: flint head at the **top-right** (point at texel (13,2)), shaft on x + y = 15, white/grey fletching + nock at the bottom-left. (Entity renderers that reuse it for a flying arrow: rotate the quad by 45° so the head leads.) |
| `bow`, `bow_pulling_0..2` | **Minecraft orientation**: the stave bulges toward the top-left (tips top-right / bottom-left, tapered, dark leather grip), string on the anti-diagonal. Pulling frames: the string forms a V toward the bottom-right (1.5 / 2.5 / 3.5 px), the tips bend back, and the nocked arrow (mirrored item arrow, 7 px) points to the **top-left**, its head reaching the grip at full draw. The MOBS agent's first-person BOW pose (Minecraft's ItemInHandRenderer UseAnim.BOW) turns texture top-left into "forward"; verified in game with the harness (tools/out/art/bow-pull-*.png, scratch). |
| `wooden_hoe` … `diamond_hoe` | Fifth `TOOL_SHAPES` entry (shared handle, the five head palettes): flat head on top of the handle, blade hooking down on the left. |
| `<mob>_spawn_egg` ×8 | One shared egg (dome-lit, 5 shades of the primary colour, dark outline) + one shared spot set in the secondary colour (Minecraft's base + overlay idea). Colours: pig f0a5a2/db635f, cow 443626/a1a1a1, sheep e7e7e7/ffb5b5, chicken e2e2e2/e0120e, zombie 00afaf/799c65, skeleton c1c1c1/494949, creeper 0da70b/161616, spider 342d27/a80e0e. Eggs for mobs added later without an entry get hash-derived colours (never a missing texture). |

Missing-texture path: kept as a **safety net** (a registry texture without a painter is drawn as the magenta/black
checker and one `console.warn` lists them); with the current registry it is never used (`MISSING_TEXTURES = []`,
asserted by the tests).

## 2. Icons (`IconFactory` / `renderIconPixels`)

* The isometric rasteriser now works on arbitrary boxes (`boxFaces(box, over)`): planar UVs like the mesher's
  partial faces, or a per-face `uv` texel rect stretched over the face (model-element style), `layerFace` to
  sample another face's texture.
* `chest` → the 14/16 box with full-face textures **plus the 3D lock** using the mesher's texel rects (so the
  icon matches the world). `farmland` → box with the top at 15/16 (dirt sides rows 1..15). `crop` → flat sprite.
  Cactus unchanged (inset sides).
* Hidden blocks still show their item: crops → `wheat_seeds` (block `pickItem`), farmland → dirt,
  `lit_furnace*` → furnace, `chest_*` → chest.

## 3. Sounds (src/game/audio.js) — names for the other agents / integrator

All synthesized with the existing building blocks (formant voices, grain clouds, knocks, metal partials, hiss),
pitch-scalable like the wave-1 recipes, calibrated (see §4). New `SOUND_NAMES`:

| name | use | Minecraft equivalent |
|---|---|---|
| `skeleton`, `skeleton_hurt`, `skeleton_death`, `skeleton_step` | ambient bone rattle, hurt crack + clatter, collapse, bony footstep | mob.skeleton.* |
| `spider`, `spider_hurt`, `spider_death`, `spider_step` | raspy chitter, screech, dying chitter, skitter | mob.spider.* |
| `creeper_hurt`, `creeper_death` | dry crumpling "kssh", longer crumple + fizz | mob.creeper.say / death |
| `zombie_death`, `zombie_step` | falling groan + body thud, heavy shuffle | mob.zombie.death / step |
| `pig_hurt`, `cow_hurt`, `sheep_hurt`, `chicken_hurt` | squeal, short "mmuh", high bleat, squawk + feathers (also use them for death, like Minecraft) | *.hurt |
| `mob_death` | soft airy "poof" when the body turns to smoke | (particles) |
| `attack_swish`, `attack_hit`, `attack_crit` | arm/weapon swing, strong hit (thump + slap), critical (crack + metallic ring) | entity.player.attack.* |
| `bow_shoot`, `arrow_hit`, `arrow_hit_player` | string twang + "fwip" (play with Minecraft's pitch `1/(r·0.4+1.2) + charge·0.5`), "thwock" + shaft quiver, the shooter's confirmation ding | random.bow / bowhit / successful_hit |
| `hoe_till` | blade scraping through soil | item.hoe.till |
| `chest_open`, `chest_close` | latch + creaking lid, creak + thud | block.chest.open / close |
| `fire_crackle` | crackling fire (lit furnace ambient, burning mobs) | block.furnace.fire_crackle |
| `fall_small`, `fall_big` | fall-damage crunch (≤ 4 / > 4 damage) | damage.fallsmall / fallbig |
| `lava_pop` | lava bubble pop | liquid.lavapop |
| `water_flow`, `lava_ambient` | flowing-water burble, deep molten rumble (random ambience near flowing water / lava) | liquid.water / liquid.lava |

`SOUND_ALIASES` (exported) accepts obvious variants: `bow`→`bow_shoot` (already used by interaction.js),
`poof`, `crit`, `hit`, `swing`, `till`, `fire`/`furnace`, `<mob>_say|_ambient`, `pig|cow|sheep|chicken_death`
→ hurt, `creeper_say`, `fallsmall`/`fallbig`, … `resolveSoundName(name)` is exported. `AudioEngine.play()` with an
unknown name now logs **one `console.warn` per name** (also before the audio is unlocked, so harness runs catch
typos); it still never throws.

Suggested wiring (owners decide): mobs — ambient `<mob>` every 8–20 s, `<mob>_hurt` on damage (passive deaths:
hurt sound), `zombie|skeleton|spider|creeper_death`, then `mob_death` with the smoke; `skeleton_step` /
`spider_step` / `zombie_step` instead of block steps; `arrow_hit` where an arrow lands, `arrow_hit_player` to the
shooter. Player — `attack_hit` / `attack_crit` on a hit (plus the mob's hurt sound), optional quiet
`attack_swish` on a miss; `fall_small`/`fall_big` with fall damage. Interaction — `hoe_till` (currently Minecraft
1.8's farmland step sound is used, also fine). Containers — `chest_open` / `chest_close`, `fire_crackle` every
~1–3 s near a lit furnace. World — `lava_pop` occasionally at exposed lava, `water_flow` / `lava_ambient` now and
then near flowing liquids (Minecraft: a random chance per animate tick).

**Volume convention (important for mob steps):** every sound is calibrated to its in-game loudness at
`volume: 1`. `playBlock('step', …)` already contains Minecraft's step factor (the `step` kind plays the material
step at Minecraft's 0.15 volume), and the `*_step` mob sounds are calibrated to the same loudness as player steps
(−39…−42 LA). So mob footsteps must be played with volume 1 (like Minecraft's Entity.playStepSound, which uses the
same formula for players and mobs). As of this writing src/game/mobs.js passes `volume: 0.15` for mob steps (both
`*_step` and the `playBlock('step')` fallback), which makes them ~16 dB quieter than the player's — drop that factor.

## 4. Review finding AUDIO-1 (confirmed, owner art) — fixed

Verified first (tools/out/art/verify-audio1.mjs): the same sounds rendered after a 0.3 s silent pre-roll (warm
limiter, as in game) were 3–14 dB louder than the calibration (cold limiter) measured — click −29.7 → −22.0 LA,
step:stone −39.0 → −26.6, pop −32.3 → −21.6 — and peaked above full scale (click +1.0, attack_hit +1.1, explode
+0.3 dBFS). Fix:

1. `renderSoundOffline` / `renderMusicOffline` render through `renderWarm`: `RENDER_PREROLL` (0.3 s) of silence via
   `OfflineAudioContext.suspend()`, then the sound; the returned buffer starts at that moment (same timeline as
   before for every consumer). Old engines without `suspend` fall back to the cold render.
2. Output ceiling after the limiter: a `WaveShaperNode` soft clipper (identity up to ±0.8, smooth tanh knee toward
   ±0.98, 2× oversampling, 0.5 pre-gain so the curve covers ±2 input) — the destination can no longer exceed full
   scale even for transients faster than the 2 ms limiter attack. `SoundCore.limiter` / `.ceiling` reference the
   nodes (meter taps).
3. Recalibrated **all 100 sounds** of that time (50 named, 50 kind × material; the two liquid ambiences added later
   were calibrated the same way) so their warm loudness equals the designed
   targets (the old cold measurements, which matched the documented targets): 4 measure/correct passes because
   the limiter is nonlinear. Result: every sound within 0.3 dB of its target (4 variations), loudest peak −1.9
   dBFS; steps again ~12 dB below breaking (−39.3 vs −27.5 LA). `BLOCK_TRIM_DB` and the `SOUNDS` gains changed
   accordingly (e.g. click gain 5 → 0.93, explode 1.12 → 0.35, step trims 7–14 dB lower).
4. `tools/audio-calibrate.mjs` now exports `TARGETS` and `check({ seeds, tolerance = 1.5 })` → `{ ok, worst,
   maxPeakDb, failures }` (fails on > 1.5 dB deviation or a peak ≥ 0 dBFS); currently ok over all 102 sounds:
   worst 0.7 dB (3 variations), max peak −2.1 dBFS. The self-check page fails peaks ≥ 0.98 (now meaningful) and,
   with `tools/audio-test.html?selfcheck=1&loudness=1`, also runs `check()`.
5. Live check in the running game (analyser on the ceiling output, tools/out/art/live-meter.js): UI clicks −6 …
   −7 dBFS (were +0.3 … +2.3), three simultaneous explosions −5.1 dBFS, a burst of 20 block sounds −3.4 dBFS,
   no sample at or above full scale.

Music: unchanged (its loudness was measured on long renders where the cold start does not matter).

## 5. Tests and tools

* `tests/textures.test.js` (24 tests, +7): no missing textures / no checker magenta; chest edges, gap, latch at
  the lock-box texels; lit furnace = furnace + fire; farmland grooves + moist darker + seamless tiling; wheat
  grows (more pixels, height 2·s+1..2·s+4, on the ground row, green → golden); bow frames distinct with the
  arrowhead top-left, arrow head top-right / fletching bottom-left; eggs distinct and two-tone; icons (chest box
  inset + lock pixels, hidden variants → items, crisp binary-alpha sprites for every new item). Also fixed a test
  helper misuse (`map(layerOf)` passed the index as the frame).
* `tests/audio.test.js` (20 tests, +2; shared file, additive): the mock gained `createWaveShaper`; new tests for
  the wave-2 sound names, aliases, prototype-key safety, the unknown-name warning, and the output ceiling
  (curve identity below 0.8, < 0.981 everywhere, monotonic, wired master → limiter → shaper → destination).
* `tools/texture-preview.html`: new default section `wave2` (chest faces + lock texels, furnace off/lit, wheat
  stages on farmland, dry/moist fields, bow draw sequence + arrow, eggs, big icons).
* `tools/audio-calibrate.mjs` (additive): `TARGETS`, `check()`, header updated. `tools/audio-test.mjs` (additive):
  `&loudness=1` option of the self-check.
* Harness checks done: preview sheet, creative inventory (spawn-egg and food tabs), chests/furnaces day + night,
  wheat field with the WORLD agent's '#' crop model, held bow/hoe/egg, first-person bow draw at 0.25 and full
  pull, full audio self-check (all sounds + music + live engine: PASS), mobs spawned with `spawnMob` and
  hurt/killed (every hurt/death name resolves, no warnings). Scratch scripts / screenshots: tools/out/art/.

## 6. Known limitations

* Chest textures are designed for the mesher's full-face mapping (as implemented). If the mapping were changed to
  planar sub-rects (cols 1..14 / rows 2..15) the outer edge ring would be cropped (still reads as a chest).
* The arrow item sprite is diagonal; a flying-arrow renderer reusing it must rotate it 45°.
* Sounds are synthesized approximations of Minecraft's character, not recordings; mob voices were checked by
  spectrogram and loudness, not by ear (headless).
