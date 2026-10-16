# Integration notes — wave 2 (mobs, combat, hunger, bow, furnace / chest, fluids, farming)

Owner: integrator (after the MOBS, SURVIVAL, WORLD, CONTAINERS, ART and FIXER agents). Wave-1 integration is
described in `docs/notes/integration.md`; this file covers what was wired and fixed in wave 2 (SPEC-wave2 §8).
Running log with timestamps: `docs/notes/integration-progress.md`.

## 1. Wiring (src/game.js)

```js
import { MobSpawner, spawnMob, MOB_TYPES } from './game/mobs.js';      // also registers mob persistence
import { BlockEntityManager } from './game/blockentities.js';
```

| where | what |
|---|---|
| `startWorld` → `new World({...})` | `onEffect: (name, x, y, z) => this._worldEffect(...)`: `'fizz'` (lava meets water → obsidian / cobblestone / stone) plays `fizz` at volume 0.5 (pitch ±0.2) and 8 smoke puffs 0.7 above the block centre (Minecraft LAVA_FIZZ). `onBlockPopped` (FIXER) stays. |
| `startWorld`, after the managers exist | `this.blockEntities = new BlockEntityManager(this).attach(world)` (placing a chest / furnace creates its entity, replacing it by anything else drops the contents; the lit ↔ unlit furnace swap keeps it); `deserialize(meta.blockEntities)` right away (entities of chunks that are not loaded wait). `this.spawner = new MobSpawner(this)` + `world.onChunkGenerated((cx, cz) => spawner.onChunkGenerated(cx, cz))` (events of chunks generated before the listener are queued by the world). |
| `update()`, inside the 20 TPS loop after `world.tick` | `blockEntities.tick(1 / 20)` (furnaces smelt on the world clock, frozen while paused). |
| `update()`, after `entities.update(dt)` | `spawner.update(dt)`, then once a second `_updateParking()` (§2). |
| `_snapshotMeta` (every save path, same atomic transaction as the chunks) | `meta.entities = entities.serialize()` + every parked record; `meta.blockEntities = blockEntities.serialize()`. |
| `_updateLoading` (saved worlds) | saved entities in meshed chunks are deserialized; the others are parked with their chunk (no 5000 Mob objects at load for a well-explored world). |
| `onInteractBlock` (first line) | `if (this.blockEntities?.useBlock(x, y, z, blockId, ctx)) return true;` → `ui.openFurnace` / `ui.openChest` (a chest under a solid block stays shut but consumes the click). TNT + flint and steel unchanged. |
| `_detachWorld` | unsubscribe `onChunkGenerated`, `spawner = null`, clear the parked records, `blockEntities.detach(); clear(); = null`. |
| `spawnMob(type, x, y, z, opts)` | facade used by `/summon` (CONTAINERS prefers it) and the debug API. |
| constructor | `playerDied` → the death message is also posted in chat (Minecraft). |
| settings | `difficulty` (FIXER's `sanitizeSettings` enum) is read live by mobs, spawner, player hunger; new `brightness` 0..1 (§3). |
| F3 (`getDebugInfo`) | `实体 E: n · 生物 m（敌对 h）· 粒子 P`, `方块实体 · 液体更新 · 远处实体 · 难度`, and Minecraft's "Targeted Entity" (`目标实体` + health) under the targeted block. Version 1.1. |
| `debug` API | `summon(type, dist = 6, side = 0, { y, persistent })` (standing spot nearest to the player's feet level), `mobs(r)` (type, position, health, target, frozen, onFire, distance), `clearMobs()`. |

Nothing else was needed: the HUD hunger bar, poison / hunger icons, the furnace / chest screens, eating and bow
hand poses, F5 mob rendering and the sound names were already complete in the owners' modules.

## 2. Entities of unloaded chunks ("parking")

Wave-1 entities lived in one global list. With wave 2 every newly generated chunk can add a group of animals,
so the live list would grow without bound while exploring (and frozen mobs of unloaded chunks would be kept
forever). Like Minecraft, which stores entities with their chunk:

* Once a second, every entity whose chunk is no longer loaded (`!world.isChunkGenerated`) is serialized,
  removed from the live list and its record kept in `game._parked` (Map 'cx,cz' → records). Non-persistent mobs
  (natural hostiles, `/summon` mobs) are dropped instead — Minecraft despawns them at that distance anyway.
* Records come back (`entities.deserialize`) as soon as their chunk is meshed again.
* Saves include the parked records, so animals, items, arrows and TNT far away persist exactly.
* Per-frame entity work is therefore bounded by the loaded area (≈ 100–150 mobs at render distance 8) however
  far the player travels. F3 shows the parked count (`远处实体`); `game.parkedEntities`.

## 3. Review findings and polish done by the integrator

All 30 findings of `docs/notes/review-wave1.json` are now `fixed` (the owners fixed theirs; `integratorNote`
on the 12 completed here).

| id | change |
|---|---|
| RENDER-1 | Per-quad back-to-front sorting of translucent geometry (renderer.js + shaders.js): own element buffer per translucent section layer, quad centres / faces decoded at upload, nearest sections re-sorted when the camera moved max(0.25, d/16) blocks (24 576 quads per frame budget), one double-sided draw per section, back-facing quads nudged 2e-6·w behind coplanar front faces in the vertex shader (replaces the polygon offset; depth writes stay on for the clouds). Ice seen from under water and water behind ice are now visible from every side (before/after: `tools/out/w2int/render1-compare.png`, `render1b-crop.png`). Unit test added. Cost: +0.12 ms render CPU when flying over an ocean, total draws 465 → 380. |
| RENDER-2 | Cactus sides use Minecraft's model elements (inset along the normal, full width, texels 0..16): the edge spines overhang. Mesher test updated, mesher notes + SPEC §7 wording. |
| RENDER-3 | The crack overlay no longer discards on the block texture's alpha (`uAlphaTest` removed): glass and leaves crack over their whole faces like Minecraft's crumbling render type. |
| RENDER-5 | Brightness option: `settings.brightness` (default 0.5) → `FrameState.brightness` → `skyTint.a` (frame UBO + the entity renderer's `uSkyTint`, now vec4) → `GLSL_LIGHT` mixes Minecraft's notGamma curve by it: light 0 = 0.059 (昏暗) / 0.0995 (默认) / 0.14 (明亮), tested. Options screen: **亮度** slider next to 难度; the CONTAINERS agent's “操作说明...” button moved to the pause menu, because 8 option rows do not fit a 240-GUI-px window (the 完成 button fell off a 1280×720 screen). |
| UI-1, UI-4 | (CONTAINERS) re-verified with real CDP keys: Ctrl + E opens the inventory, Ctrl + Esc the pause menu, no crosshair in either F5 view (`tools/steps/w2-ui-review.json`). |
| CODE-1, WORLD-6, UI-2/3/6/7 | (FIXER / WORLD / CONTAINERS) confirmed by `containers-savefail.json` and the DOM suite `runReviewFixes` (11/11) on the integrated build. |

Other fixes / polish:

* Mob footsteps played at volume 0.15 although the ART agent calibrated the `*_step` sounds (and
  `playBlock('step')`) to in-game loudness: ~16 dB too quiet → volume 1 (mobs.js `_steps`).
* Liquid ambience (ART's wave-2 sounds were not used by anyone): Minecraft's WaterFluid / LavaFluid
  `animateTick` in the particle display tick — flowing water burbles (`water_flow`, 1/64), lava with air above pops
  (`lava_pop` with its particle, 1/100) and rumbles (`lava_ambient`, 1/200).
* `tools/steps/integ-survival.json` (wave-1 script) assumed every entity is an item; it now filters items.
* GUI scale: the settings cap of 4 (game.js `sanitizeSettings`, ui.js, the options button) is now 8, so large
  screens get Minecraft's full range (2560×1440: 自动, 1..6); the window still limits it.
* Death messages are also posted in chat (Minecraft); F3 shows the targeted entity.
* `tools/run-steps.mjs` (new): runs many harness scripts in parallel and summarises (`tools/steps/regression.txt`
  = the whole browser regression: 20 integrator scripts, 30 module-owner scripts, 16 wave-1 scripts = 66).

## 4. Verification

* `npm test`: **524 / 524** (new: 2 wave-2 wiring tests in tests/game.test.js — chunk animals, chest / furnace
  routing + smelting on the game clock, mobs + containers + parked records through save & reload, peaceful,
  brightness; 1 translucent-sorting test; cactus test updated).
* DOM suites (`node tools/ui-screenshots.mjs`): run 58, runFlow 21, runContainers 44, runReviewFixes 11 — all pass.
* Browser regression (`node tools/run-steps.mjs -j 3 tools/steps/regression.txt`): **66 / 66 pass**, no console error or warning in any log (§4.2); `w2-guiscale.json`, added to the suite afterwards, passes too.
* `node tools/save-robustness.mjs` (FIXER, real tab close / reload / two tabs): **11 / 11** with the wave-2 meta (entities incl. parked records, block entities).

### 4.1 End-to-end checks (headless Edge + RTX 4070, real CDP mouse / keyboard; screenshots inspected)

| script | checked |
|---|---|
| `w2-mobs-lineup` | all 8 mobs by day (zombie + skeleton catch fire, skeleton holds its bow), at night (spider eyes glow), F5 behind / front |
| `w2-hostile` | zombie targets and chases (arms raised), hits 20 → 15.5 → 11 HP with hurt tilt + sounds; skeleton draws and shoots (arrows hit, `bow_shoot`, `arrow_hit`) |
| `w2-creeper` | hiss, swelling + white flashing at 2.8 blocks, explosion (`explode`), player 20 → 2 HP, crater |
| `w2-combat` | real sword clicks: knockback hop, red flash, tip-over + poof; pig → porkchop, **burning cow → cooked beef** + leather; pig spawn egg (survival uses one); chat-typed `/summon sheep`, `/summon 苦力怕 ~ ~ ~-6`, `/kill @e[type=creeper]` |
| `w2-hunger` | food 5: double-tap W does not sprint; bread held 1.6 s: food 5 → 10, saturation 6, crunch + burp; starvation: easy stops at 10 HP, normal at 1 HP, hard → death screen 玩家饿死了; peaceful refills food + health |
| `w2-bow` | 1.15 s draw: pulling frames + FOV 75 → 64, release → crit arrow hits a cow 9 dmg, 1 arrow + 1 durability used; second arrow sticks in a plank wall |
| `w2-furnace` | furnace placed and opened by right click; ore + coal moved with real clicks; lit_furnace after 2.5 s; iron ingot after 10 s, taken into the inventory; block light 12 in front of the lit furnace in a closed room at night |
| `w2-chest-persist` | world created through the UI; chest placed / opened by right click; 9 diamonds, 5 apples, a damaged sword stored with real clicks; save & quit → **page reload** → world list → enter → same contents (damage kept) |
| `w2-mob-persist` | through the UI: mobs near the player identical after save & quit + reload (76 = 66 live + 10 parked); tracked animals wandered (median 8.9 blocks in 20 s) |
| `w2-fluids` | real lava bucket into a 3×3 pit (source + flowing levels 2 / 4), real water bucket beside it → 1 obsidian + 8 cobblestone with 9 fizz effects; waterfall from a pillar (falling column + spreading pool) |
| `w2-farming` | real hoe clicks till 3 grass blocks, seeds planted with real clicks; forced random ticks (the world's own `_tickFarmland` / `_tickCrop`): farmland → moist, wheat 0 → 7 in 47 ticks per crop; harvested with real clicks (wheat + seeds), bread crafted at the crafting table with real clicks, eaten: food 12 → 17 |
| `w2-wander` | 9 nearby animals all moved within 30 s (median 7.4, max 18 blocks), none fell off cliffs or into water |
| `w2-night60` | **75 s survival night with real WASD / jump / double-tap sprint / attacks / torch placing / eating** and natural spawning: hostiles fill to the cap (20) within 25 s, a skeleton shoots the player to death, respawn, a zombie attacks; 59.9 fps, max frame 100 ms (only the AudioContext creation at the first key press), **0 console errors / warnings** |
| `w2-perf` | 140 mobs (100 chunk animals + 40 summoned, 20 hostiles chasing a boxed-in player, 97 active) at render distance 8, 1920×1080: **60 fps**, update 0.38 ms + render 0.42 ms CPU per frame, max frame 16.9 ms, 538 draws |
| `w2-render1`, `w2-render1b` | RENDER-1 before / after (run the same scripts against `tools/out/backup-w2-preintegration/index.html` for the old build) |
| `w2-options`, `w2-ui-review`, `w2-cmds` | options layout + brightness slider, UI-1 / UI-4 with real keys, README command examples |
| `w2-ocean-perf` | sprint-flying over a deep ocean (translucent sorting cost) |
| `w2-showcase` | the showcase screenshots `tools/out/w2-*.png` (1600×900) |

### 4.2 Browser regression

`node tools/run-steps.mjs -j 3 tools/steps/regression.txt` (66 scripts: integrator w2-*, mobs-*, surv-*,
containers-*, fluids-*, lead-walltorch, world-snapshot-reload, wave-1 integ-*): **66 / 66 passed**
(`tools/out/runs/_regression-summary.txt`, per-script logs in `tools/out/runs/`), none with a console warning. `containers-savefail.json`
is run separately: it logs the intentionally simulated QuotaExceededError through `console.error` (expected).

## 5. Performance (RTX 4070, headless Edge, rd 8)

| scene | fps | update CPU | render CPU | notes |
|---|---|---|---|---|
| 140 mobs, 20 hostiles chasing, 1080p | 60 | 0.38 ms | 0.42 ms | max frame 16.9 ms |
| 75 s night survival, 720p | 59.9 | 0.42 ms | 0.44 ms | one 100 ms frame at the first key press (AudioContext) |
| sprint-flying over a deep ocean, 1080p | 59.5 | 0.31 ms | 0.51 ms | old build 0.39 ms render (no sorting) |

## 6. Known issues / limitations (after integration)

* Mob features not in wave 2: breeding, babies, shearing, eggs, door breaking, jockeys, charged creepers, armour.
  Path finding has no doors / ladders; wide spiders can stall in 1-wide corridors.
* No chest lid animation / double chests; no furnace XP; flowing liquids use the still texture; lava does not
  start fires; no rain.
* Parked (far away) entities are restored only when their chunk is meshed again; non-persistent hostiles and
  summoned mobs are dropped when their chunk unloads (Minecraft despawns them at that distance too).
* The headless harness cannot hear: sound levels were checked by the ART agent's measurements, not by ear.

## 7. Files changed by the integrator

`src/game.js`, `src/config.js` (`brightness` setting), `src/render/renderer.js`, `src/render/shaders.js`,
`src/render/entityrenderer.js` (`uSkyTint` vec4), `src/world/mesher.js` (cactus), `src/game/mobs.js` (step volume),
`src/game/particles.js` (liquid ambience sounds), `src/ui/menus.js` (亮度 slider, 操作说明 in the pause menu,
version 1.1, GUI scale cap), `src/ui/ui.js` (GUI scale cap), tests (`game.test.js`, `renderer.test.js`, `mesher.test.js`), `tools/ui-interact.js` (options /
pause check), `tools/run-steps.mjs` (new), `tools/steps/w2-*.json` + `tools/steps/regression.txt` (new),
`tools/steps/integ-survival.json`, docs (`README.md`, this file, `integration-progress.md`, `renderer.md`,
`mesher.md`, `SPEC.md` §7 cactus, `review-wave1.json` statuses). A copy of the tree before integration is in
`tools/out/backup-w2-preintegration/`.
