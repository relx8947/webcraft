# Integration notes (src/game.js, src/main.js)

Owner: integrator. Implements SPEC §9.10 and wires together every module from wave 1 / 1b.

## Files

| file | role |
|---|---|
| `src/main.js` | bootstrap. Order: settings (localStorage + URL overrides) → `generateTextures` / `generateMiscTextures` → `Renderer` (with `EntityRendererClass`, `buildMipChain`, `alphaModes`; a fatal Chinese message if WebGL2 is missing) → `IconFactory`, `Storage.open()` (not awaited), `WorkerPool`, `AudioEngine`, `Input` → `Game` → `UIManager` → title screen or `autostart`. |
| `src/game.js` | `Game` class: state machine, world lifecycle, frame loop, FrameState, settings, chat/commands, F-keys, spawn placement, debug / automation API, `getDebugInfo` (F3). Also exports `sanitizeSettings`, `loadSettings`, `parseTimeParam`. |
| `tests/game.test.js` | 11 Node integration tests. They drive `Game` with the real World, worker code (through an in-process pool), Player, Interaction, entities, particles, commands and an in-memory Storage. |
| `tools/steps/integ-*.json` | harness scripts that send real CDP input (see Verification). |

## Frame loop (`Game._frame`)

`dt = min(0.1, delta)`. Each frame runs these steps in order:

1. `update(dt)`:
   - **Loading:** `world.update` and the loading progress check.
   - **Playing:**
     1. F1 / F3 / F5, and any pending debug teleport.
     2. If not paused: `player.update`, then `interaction.update`, then fixed 20 TPS ticks (`time++`, `world.tick(rng, timeOfDay)`, at most 10 per frame), then `entities.update`, then `particles.update`, then the autosave timer.
     3. `world.update(player.x, player.y, player.z, dt)` always runs, so streaming continues behind the pause menu.
2. `render()`: playing state only, because title and loading screens are opaque DOM.
3. `ui.update(dt)`.
4. `audio.update(dt)`, on every screen, so title music is scheduled too.
5. `input.endFrame()`.
6. Resolve `debug.waitIdle` / `debug.frames` waiters.

## FrameState

`render()` fills one reused FrameState object (SPEC §9.3) each frame:

| field | source |
|---|---|
| `camera` | `player.getCameraState(cam, perspective)` |
| `time` | animation clock, seconds of unpaused play |
| `selection` | `null` while F1 hides the HUD or the player is dead |
| `breaking` | `interaction.breaking` |
| `entities` | `entities.getRenderList()`: the manager-owned, allocation-free array. It includes the player model while `perspective > 0`. |
| `particles` | `particles.getRenderData()` |
| `hand` | only in first person, alive, HUD shown |
| `underwater` / `inLava` | from the player's eye |
| `clouds` | from settings |
| `voidFogScale` | see Changes to other modules |

`audio.setListener(camera)` is called every frame.

## World lifecycle

- **`createWorld({ name, seedText, mode, worldType, temporary })`:**
  - An empty seed text gives a random uint32; otherwise the seed is `parseSeed(text)`.
  - The id comes from `newWorldId()`. The world starts at time 1000.
  - The meta is saved immediately unless `temporary`. That flag is non-enumerable, so it is never stored; autostart worlds use it.
- **`startWorld(meta)`:**
  1. Quits the current world, if any.
  2. Creates a `World` with `storage = null` for temporary worlds and these callbacks:
     - `onDropItem` → `entities.popItem` (block centre, Minecraft popResource).
     - `onFallingBlock` → `entities.spawnFallingBlock`, so sand and gravel fall as animated entities.
     - `uploadBudgetMs` 12 while loading, reset to 4 when play starts.
  3. Creates Player, Interaction, EntityManager and ParticleSystem.
  4. Awaits `world.init()`, then sets up the player:
     - **New world:** `findSpawn()`, `spawnPoint`, `respawn({ emit: false })`, game mode, and the creative hotbar (`DEFAULT_CREATIVE_HOTBAR`).
     - **Saved world:** `player.deserialize(meta.player)`.
  5. Waits, with frames driving it, until `world.isAreaReady(player, 2)`, emitting `loadingProgress`.
  6. Places the player:
     - **New world:** `_placeAtSafeSpawn()` searches rings of up to 12 blocks for solid, opaque, non-leaf, non-harmful ground with 2 free dry cells. The first pass also requires the 8 neighbouring head cells to be free, so the player is not pressed against a trunk.
     - **Saved world:** `_ensureNotInsideBlocks()`.
  7. Restores `meta.entities` (saved items, falling blocks, TNT), sets `state = 'playing'`, emits `worldLoaded`, and saves a new world once.
  8. `window.__ready` becomes true after the first rendered frame.
- **Saving (`saveWorld()`):**
  - What is written: `meta.lastPlayed`, `time`, `player.serialize()`, `mode`, `entities.serialize()`, then `storage.saveWorldMeta(meta)` and `world.save()`. Temporary worlds are never written.
  - Calls are serialized.
  - When it runs: autosave every 30 s of unpaused play, on `visibilitychange` → hidden, on `pagehide`, and on quit.
- **`quitToTitle()`:** saves, detaches (clears entities and particles), then `await world.destroy()`, `renderer.clearAll()`, emits `worldUnloaded`, and sets `state = 'title'`. If called during loading, it aborts and rejects the pending `startWorld`.
- **Dead player:** a player saved while dead (quit from the death screen) reloads dead, and the UI reopens the death screen from `player.dead`.

## Input, screens, F-keys

- `input.enabled = false` on the title screen. The UI owns screen routing: E, T, /, Esc, pause on pointer-lock loss, and re-locking when a screen closes.
- `input.allowUnlocked` is set by `autostart=1` or `automation=1`. In that mode the UI also hides the click-to-play hint and never pauses on lock loss.
- F1 and F3 come from the Input actions `hideHud` / `debug` and are routed by `Game._handleKeys`.
- F5 cycles 0 → 1 → 2 only when `renderer.entityRenderer.supportsPlayerModel` is set, which the entities agent added. It is ignored otherwise.
- F2 is a DOM keydown listener. The next rendered frame is saved with `canvas.toBlob` and downloaded as `webcraft_YYYY-MM-DD_HH.MM.SS.png`, with a chat confirmation.
- Chat: `addChatMessage(text, color)` only emits `'chat'`; the UI listens, so lines are not duplicated. `runCommand(text)` calls `commands.runCommand(this, text)`.
- TNT: `game.onInteractBlock` handles TNT plus flint and steel: it removes the block, spawns `spawnPrimedTnt`, and costs 1 durability in survival. Otherwise it returns false so the held block is placed.

## Settings

`applySettings(partial)`:

- Validates with `sanitizeSettings` (clamps, drops unknown keys) and mutates the one live settings object, which Input, Audio and UI read live.
- Applies changes:
  - render distance → `world.setRenderDistance`
  - smooth lighting → `world.setSmoothLighting` (remesh)
  - volumes → `audio.setVolumes`
  - FOV, sensitivity, invert Y, view bobbing, GUI scale and clouds are read live, so they need no call.
- Persists to `localStorage['webcraft.settings']` and emits `settingsChanged(changed, settings)`.
- URL `rd=` is session-only: the stored value is kept on disk unless the player changes the setting.

## URL parameters / automation API

- **URL parameters:** `autostart=1`, `seed`, `mode`, `type`, `rd`, `time` (ticks or noon/night/midnight/…), `nomusic=1`, `save=1`, `automation=1`.
- **Globals:** `window.__game`, `window.__ready`.
- **`game.debug` (SPEC):**
  - `tp(x, y, z)`: without y, it waits for the area and lands on a safe surface spot (returns a Promise).
  - `look(yaw, pitch)`, `setTime`, `setBlock(x, y, z, nameOrId)`, `getBlock`, `give(name, count)`, `setMode`.
  - `waitIdle(ms)`: resolves when the world is idle and the area is ready.
  - `stats()`, `hideHud(bool)`.
- **`game.debug` (extras):** `lookDeg`, `lookAt`, `blockName`, `select`, `target`, `mine`, `use`, `findBiome(name)`, `frames(n)`, `perf(reset)` (frame-time stats plus long-frame timestamps).

## F3 (getDebugInfo)

The left column shows, in Chinese with Minecraft's English terms:

- version and FPS
- chunks meshed / loaded, render distance, pending gen / mesh / upload
- entity and particle counts
- XYZ, block, chunk-local / chunk coordinates
- facing (北 north …, axis direction, Minecraft yaw / pitch)
- light: effective, sky and block at the eye
- biome (Chinese + id), day / time / seed, mode
- targeted block and face

The right column comes from the UI: browser, memory, CPU, display, GPU, renderer stats.

## Changes to other modules

All changes are in modules from finished owners. ENTITIES, WORLD and AUDIO files were not edited.

- `src/render/renderer.js`:
  - **Problem:** flat worlds rendered a black sky, because the camera at y ≈ 5.6 triggered Minecraft's void-fog darkening below y = 32.
  - **Fix:** `computeSkyState(…, voidScale = 1/32)` takes Minecraft's clear-colour scale, and `render()` reads an optional `frame.voidFogScale`. game.js passes 1 for flat worlds (Minecraft `FlatLevelSource` → 1.0), so the sky only darkens below y = 1. A unit test was added in `tests/renderer.test.js`.
- `src/ui/hud.js`:
  - The F3 right column shows a short GPU name (`shortGpuName`: "NVIDIA GeForce RTX 4070" instead of the full ANGLE string, which overlapped the left column).
  - The right column shows visible / total sections.
  - It no longer repeats the entity count and target block (those are in `getDebugInfo`).
- `src/game/interaction.js`: when a tool breaks, item-break particles now spawn in front of the eyes (`particles.spawnItemBreak`, Minecraft `breakItem`), next to the existing sound.

## Verification

- **Unit tests:** `npm test` → 342 / 342 pass.
- **Harness runs:** headless Edge with the RTX 4070. Every run ended with 0 console errors and 0 warnings. Screenshots are in `tools/out/integ-*.png`, each inspected.

| steps file | what it checks |
|---|---|
| `integ-walk-break-place.json` | real W key walks 7 blocks; real LMB breaks grass → dirt drop → walking picks it up; real RMB places blocks |
| `integ-place.json` | dirt and torch placement with real right clicks, hotbar key 2 |
| `integ-ui-create.json`, `integ-ui-flow1.json` | title → 单人游戏 → 创建新的世界 → typed name / seed → world loads; Esc → pause menu |
| `integ-ui-saveload.json` | create (creative, seed 12345) → edits + item + time → 保存并退出 → **page reload** → world list → enter: edits, position, yaw, time, inventory restored |
| `integ-death-reload.json` | /kill with drops on the ground → 返回标题画面 → re-enter: the death screen comes back, the dropped items were restored, 重生 works |
| `integ-inv.json`, `integ-craft.json` | E inventory, 2×2 planks, crafting table opened by right click, stone pickaxe crafted with real clicks |
| `integ-survival.json` | survival log mining with crack stages and hit particles, drop, pickup, Q throw |
| `integ-f3-chat.json` | F3, chat and commands with real keys (/give /time /gamemode /seed /tp, plain chat), F1, F5 |
| `integ-options.json` | options from pause: FOV, render distance 8 → 4 (chunks unload), smooth lighting off (remesh), show FPS, GUI scale; applied live and persisted |
| `integ-death.json` | death screen, respawn at the spawn point |
| `integ-tnt.json` | flint and steel ignites TNT; fuse, explosion, crater, drops, player damage |
| `integ-tour.json`, `integ-cave.json` | biome / time tour: noon, sunset, night, underwater, torch-lit cave, desert, snowy plains, snowy taiga, birch forest, flower forest, mountains, peaks |
| `integ-walk60.json` | 60 s walking, turning, jumping, sprinting and strafing with real input |

Autostart worlds were checked with seeds 42, 1, minecraft, -123456789, 999999 and 12345, in survival and creative, and in flat worlds (777, 2024).

## Performance

Measured at render distance 8, 1920×1080, headless Edge, RTX 4070, 8 workers, `debug.stats()` / `debug.perf()`:

- **Frame rate:** 60 FPS (vsync), average frame 16.67 ms, max 16.8 ms over 300 frames.
- **CPU per frame:** `update` 0.19 ms, `render` 0.39 ms.
- **World:** 313 chunks loaded, 241 meshed. Generation averages 5.4 ms and light + mesh 5.2 ms per chunk in workers (8 in parallel).
- **Renderer:** 1301 sections stored, 264 visible, 452 draw calls, 375 k triangles, 41.6 MB GPU memory.
- **Load time:** the spawn area (radius 2) is ready about 0.2–0.4 s after the page loads.
- **60 s walk:** 59.9 FPS average, 0.21 ms update, 0.41 ms render.
  - One 83 ms frame occurs at the first key press: the AudioEngine creates its AudioContext (~0.1 s) on the first user gesture.
  - For real players that gesture is the click on the title screen, so it never happens in game.

## Known issues / notes

- ENTITIES was still finishing when these notes were written. Its live API, including the player avatar, `getRenderList()` and `supportsPlayerModel`, is already wired and verified.
- Inherited from the modules: no fluid flow, no mobs / hunger / furnace UI, and CJK text uses the system font.
- Every live AudioContext test used `audio.unlock()` from an eval with a user gesture. Sound quality was not listened to; headless runs cannot.
