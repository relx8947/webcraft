# FIXER notes (wave 2): wave-1 review findings in unowned files

Owner during the wave-2 build phase: FIXER. Files edited: `src/game.js`, `src/main.js`,
`src/render/shaders.js`, `src/render/renderer.js`, `tests/game.test.js`, `tests/renderer.test.js`, the new
regression tool `tools/save-robustness.mjs`, plus `docs/notes/renderer.md` and one block in `docs/SPEC.md`
§9.3. No new wave-2 features: mobs, block entities, hunger HUD, difficulty, fluids `onEffect` and so on are
left for the integrator to wire.

The input was `docs/notes/review-wave1.json` (23 findings). Each fix was reproduced first, then
checked in the real game (headless Edge, real tab close / reload / second tab where relevant).

## Finding status

| id | status | what was done / evidence |
|---|---|---|
| CODE-1 | **fixed** (game side). The UI part belongs to CONTAINERS, see below | `quitToTitle()` no longer detaches or destroys a world it could not save. The world stays open, the player gets a red chat line (`无法保存世界：存储空间不足…`), and `'saveFailed'` (err, kind) is emitted. The promise rejects with `Error{ saveFailed: true, cause }`. Saves are atomic now, so no newer meta sits next to older chunks. Autosave, pause and unload failures are reported in chat (at most once a minute per error) and retried 5 s later instead of 30 s. Recovery is announced (`§a世界已成功保存。`). A safety net covers the current `ui.saveAndQuit`, which shows the title screen even after a failure: the title is replaced by `无法保存世界 / <原因>。世界仍然开着，进度没有丢失…` with a [返回] button back to the pause menu. Evidence: `tools/out/fixer/savefail.json` (QuotaExceededError injected → message screen, world kept → storage restored → quit saves; all 5 stone edits and 9 diamonds are in storage). Node test `save and quit keeps the world open…`. |
| CODE-2 | **fixed** | Every save, whether autosave, pause, quit, `visibilitychange: hidden` or `pagehide`, goes through the WORLD agent's `World.saveSnapshot(meta)`. That writes the meta and all modified and unloaded chunks in ONE IndexedDB transaction, created synchronously inside the event. Unload saves bypass the save queue. The pause menu saves (`setPaused(true)`, Minecraft's "Saving and pausing game…"). A `beforeunload` confirmation is active while a persistent world has unsaved progress. Evidence: `node tools/save-robustness.mjs`, 11/11 checks with real `Page.close` / `Page.reload`. 169 modified chunks persist 169/169 (before: 16–96/169). Inventory and blocks are always consistent. |
| CODE-3 | **fixed** | Per-world session lock, `WorldLocks` in game.js. It uses Web Locks (`navigator.locks`, lock name `webcraft-world-<id>`, the same name as the WORLD agent's `Storage.acquireWorldLock`) with a BroadcastChannel fallback for insecure origins such as LAN IPs. `startWorld` refuses with `这个世界已在另一个标签页中打开。请先在那里保存并退出，然后再进入。` (shown by the existing UI message path). `deleteWorld` refuses while the world is open anywhere. The lock is released after the final save, or by the browser when the tab dies. Evidence: save-robustness `locks` (tab B cannot open or delete; after A's save & quit, B opens it); screenshot `tools/out/fixer/locks-tabB.png`; Node test with a fake LockManager. The optional saveSeq optimistic-concurrency check was not added: the lock covers the scenario. |
| PLAYER-4 | **fixed** (game side) | `beforeunload` calls `preventDefault()` and sets `returnValue = ''` only while a persistent world has unsaved progress (play since the last save, a save in flight, or modified chunks). Ctrl+W pressed while sprinting with Ctrl, Ctrl+R and tab close now show "Leave site?". The save starts in the same handler, so it has finished by the time the player confirms. No dialog after pausing (already saved). No dialog for automation runs (autostart / automation=1), so scripted reloads keep working. Evidence: save-robustness `ui-close` (dialog shown, all data persisted) and `ui-pause` (no dialog). The optional toggle-sprint option and Ctrl+W tip are in input.js (SURVIVAL) and the UI (CONTAINERS); not done. |
| WORLD-1 | **fixed** (game side; the storage side is the WORLD agent's `saveSnapshot` + `tx.commit()`) | Same as CODE-2: `_saveForUnload()` creates the transaction synchronously in `visibilitychange` / `pagehide`. Evidence: save-robustness `close`, `close-many`, `reload`. |
| CODE-5 | **already fixed / verified** | Fixed by the integrator before wave 2: `main.js` passes `sessionOverrides` and `_persistSettings` writes the stored value back. Re-verified with `index.html?…&rd=3`: `applySettings({fov:80})` stores `renderDistance: 8` (live 3), and an explicit change to 5 is persisted. |
| WORLD-5 | **fixed** (game side; storage.js is fixed by WORLD) | `main.js` catches a rejecting `Storage.open()` and falls back to `Storage.memory()`. `Game._storageReady` also falls back, so a broken storage promise can no longer make every world operation reject. Evidence: `tools/out/fixer/idb-throw.html` (`window.indexedDB` getter throws SecurityError). The game starts with the memory backend and shows a chat warning, `tools/out/fixer/idb-throw.png`. |
| WORLD-6 | **partly fixed** (game side). The title / world-list notice belongs to CONTAINERS | Entering a persistent world while storage is memory-only posts `§e注意：浏览器不允许本页面使用存储（IndexedDB），这个世界不会被保存，关闭页面后就会丢失。`. Save failures are surfaced as described under CODE-1. Creating a world calls `storage.requestPersistence()` (best effort, `navigator.storage.persist`). Still open for the UI: a persistent red notice on the title / world-list / create-world screens when `game.storage.persistent === false`. |
| WORLD-7 | **fixed** | Same as CODE-3. |
| AUDIO-2 | **fixed** (game side; the hook is the WORLD agent's) | `World({ onBlockPopped })` is wired to `particles.spawnBlockBreak` + `audio.playBlock('break', sound, centre)`. Evidence: `tools/out/fixer/popped.json` — breaking the stone under a torch and the sand under a 2-high cactus logs particles and break sounds for the torch (wood), both cactus blocks (wool = cactus sound) and the mined blocks. |
| SURV-4 | **fixed** | `GLSL_LIGHT` (shaders.js; the entity renderer imports it, so terrain, entities, particles and the hand all follow) applies Minecraft's lightmap post-processing at the default brightness (50 %) instead of the `0.035` floor: lerp 4 % to 0.75, half of `1-(1-c)^4`, lerp 4 % to 0.75. Unlit = 0.0995 (Minecraft), full = 0.985, light levels stay distinct. `computeSkyTint` is now Minecraft's lightmap sky colour (blue moonlight). Luminance (median, tools/out/fixer/light.json): unlit cave 2 → 7, moonlit grass 12 → 21, dusk 22 → 36, noon 115 → 113 (unchanged). Screenshots `tools/out/fixer/light-*.png` (before: `light-before/`), `tools/out/integ-cave1/2.png`. SPEC §9.3 updated. A 亮度 slider was not added: it needs a setting (shared config.js), the options UI (CONTAINERS) and a uniform. |
| flaky test | **fixed** | tests/game.test.js "survival breaking drops an item that the player picks up": the player now walks onto the drop (it steers toward it, holding forward). Only item entities are counted, so mobs from the future spawner cannot break it. 67 consecutive runs passed (12 + 30 + 25). |
| PLAYER-1, SURV-1, CODE-6, PLAYER-3, WORLD-2 | skipped (owners SURVIVAL / WORLD / lead; marked partly-fixed in the review) | not FIXER files |
| SURV-2, WORLD-3, WORLD-4 | skipped (owner WORLD) | not FIXER files (the WORLD agent is working on them) |
| AUDIO-1 | skipped (owner ART) | audio.js |
| CODE-4, PLAYER-2 | skipped (owners SURVIVAL / CONTAINERS) | player.js / commands.js |
| SURV-3 | already fixed by the lead (registry.js) | — |

No review finding concerns renderer.js (beyond SURV-4), worldgen.js, noise.js or workerpool.js.
I also read those files for obvious defects and found nothing that needed a change. One related fix in
game.js: `sanitizeSettings` dropped the new `difficulty` setting, so the wave-2 options screen and
`/difficulty` could never change it through `applySettings`. It now accepts
peaceful/easy/normal/hard, and future number/string settings are validated generically.

## Save design (game.js)

```
autosave (30 s of play) ─┐
pause menu opens ─────────┤                       one IndexedDB transaction over ['worlds','chunks']:
save & quit ──────────────┼─ _saveNow() ─ _snapshotMeta(meta) ─ world.saveSnapshot(meta) ─ meta + modified chunks
visibilitychange hidden ──┤   (serialized on _saveChain;        (created synchronously, tx.commit();
pagehide ─────────────────┘    unload saves bypass the chain)    falls back to saveWorldMeta + world.save())
beforeunload: hasUnsavedProgress() → save now + preventDefault (not in automation runs)
```

* `_dirty` is set by every unpaused frame and cleared when a save takes its snapshot.
  `hasUnsavedProgress()` = `_dirty`, a save in flight, or `world.stats().modified > 0`.
* `quitToTitle({ discard })`. On save failure it rejects with `{ saveFailed: true, cause }` and the
  world stays open; `discard: true` unloads without saving. It passes `world.destroy({ save: !discard })`;
  **WORLD agent: please honour `{ save: false }` in destroy()** — today the option is ignored, so
  a discard still writes the chunks (but not the meta).
* `startWorld()` takes the world lock first. It rejects with a Chinese message when another tab has the
  world, and also when the currently open world cannot be saved (`saveFailed`).
* `deleteWorld()` refuses the open world and worlds open in another tab.
* Events: `'saveFailed'` (err, kind: 'autosave' | 'pause' | 'quit' | 'unload' | 'initial').
* Public helpers: `describeSaveError(err)` (short Chinese reason), `WorldLocks` (injectable
  `{ locks, channel }` for tests), `game.storage.persistent`, `game.hasUnsavedProgress()`.

## For the integrator / CONTAINERS (UI, src/ui/*)

* `ui.saveAndQuit()` should catch `err.saveFailed` and show a screen `无法保存世界：<err.message>`
  with [重试] (saveAndQuit again), [不保存并退出] (`game.quitToTitle({ discard: true })`, then the title)
  and [返回游戏]. Until then, game.js's safety net replaces the wrongly shown title with a one-button
  message that leads back to the pause menu. That works, but it offers no "quit without saving".
* Show a persistent notice on the title / world-list / create-world screens when
  `game.storage.persistent === false` (WORLD-6).
* Optional: mark worlds that are open in another tab (`navigator.locks.query()`, lock name
  `webcraft-world-<id>`).
* `world.onEffect` ('fizz': lava + water) is not wired yet. It is a wave-2 feature: the integrator should wire it.

## Verification

* `npm test`: 470/470 at the last full run. tests/game.test.js has 17 tests (+6 new: quit failure, discard,
  synchronous atomic unload snapshot, pause save + beforeunload, world lock, describeSaveError).
  tests/renderer.test.js has 28 (light model checked against Minecraft's 0.0995 / monotone levels, sky tint).
* `node tools/save-robustness.mjs`: 11/11 checks (close, close-many with 169 chunks, reload, ui-close
  with the beforeunload dialog, ui-pause, locks), real tab close and reload in one browser profile.
* Integration step files (real input) all pass with 0 page errors: walk-break-place, death, death-reload,
  ui-flow1, ui-create, ui-saveload (edits, inventory and time survive a page reload), options, tnt,
  survival, place, inv, craft, f3-chat, cave, tour (screenshots inspected).

## Limitations

* The beforeunload dialog only appears after a user gesture on the page (a browser rule); every
  real player has clicked to play.
* Browsers may still kill a page before an IndexedDB transaction created during `pagehide` commits
  (e.g. the OS shutting down). The transaction now exists and is committed explicitly, which the
  tests show is enough for normal tab closes and reloads.
* Without Web Locks and BroadcastChannel (very old browsers) worlds are not locked.
