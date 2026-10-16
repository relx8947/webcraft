# UI agent notes — screens, HUD, crafting, commands

Owner files: `index.html`, `css/style.css`, `src/ui/*.js`, `src/game/crafting.js`, `src/game/commands.js`,
tests `tests/crafting.test.js`, `tests/commands.test.js`, `tests/ui-slots.test.js`, `tests/ui-font.test.js`,
visual/integration pages `tools/ui-test.html`, `tools/ui-interact.js`, `tools/ui-keys.json`.

## Module map

| file | role |
|---|---|
| `src/ui/ui.js` | `UIManager`: screen switching, input routing, key listener, GUI scale, game events, cursor stack + tooltip |
| `src/ui/hud.js` | hotbar, hearts/food/air, item-name toast, action bar, damage flash, vignette, F3 overlay + axis gizmo, FPS, "click to play" hint |
| `src/ui/chat.js` | `ChatLog` (fading lines above the hotbar) and `ChatScreen` (input, history, Tab completion) |
| `src/ui/containers.js` | survival inventory, crafting table, creative inventory (DOM layer) |
| `src/ui/slots.js` | **pure** `ContainerModel`: Minecraft click semantics (Node-tested) |
| `src/ui/menus.js` | title, world list, create world, confirm, options, about, loading, pause, death, message |
| `src/ui/assets.js` | procedural pixel art (panel, slots, buttons, hotbar, hearts, food, bubbles, tabs, skin, icons), dirt background from the shared textures, fallback icons |
| `src/ui/logo.js` | stone-cube "WEBCRAFT" logo + pixel "方块世界" subtitle (canvas) |
| `src/ui/font.js` | runtime-generated TrueType pixel font for ASCII ("WebCraft Pixel"), loaded via `FontFace` |
| `src/ui/playermodel.js` | inventory player preview: canvas 2D, affine-mapped crisp skin faces, looks at the mouse |
| `src/ui/itemview.js`, `dom.js`, `text.js` | item stack view, widgets (Button/Slider/TextField), § formatting codes, strings |
| `src/game/crafting.js` | data-driven shaped/shapeless recipes with tags + mirroring, `SMELTING` |
| `src/game/commands.js` | `/help /gamemode /time /tp /give /clear /kill /seed /spawnpoint /setworldspawn /setblock /fill /say /me`, Tab completion |

## Integration (for `src/game.js` / `src/main.js`)

```js
game.textures = textures;              // optional but avoids a second generateTextures() (game.icons.textures also works)
const ui = new UIManager(game, document.getElementById('ui-root'));
game.ui = ui;
ui.showTitle();
// every frame, after rendering and BEFORE input.endFrame():
ui.update(dt);
// F1 / F3 come from Input actions (the UI does not bind them itself unless options.handleHudKeys):
if (input.pressed('debug')) ui.toggleDebug();
if (input.pressed('hideHud')) ui.toggleHud();
```

* **Screen keys are handled by the UI itself** (capture-phase `keydown` on `window`): `E` inventory (survival or
  creative by `player.mode`), `T` chat, `/` chat prefilled with "/", `Escape` pause / close, `1-9` and `Q`
  over slots. Routing the Input actions `inventory`/`chat`/`command`/`pause` to `ui.open*()` is not needed
  (and harmless: all `open*` are idempotent and Input reads idle while a screen is open).
* Input routing: opening a screen sets `game.input.enabled = false` and calls `input.exitLock()`. Closing calls
  `input.requestLock()` immediately (inside the user gesture) and re-enables input in the next `ui.update()`.
  Verified with the real `Input` (`tools/ui-test.html?realinput=1`).
* Lost pointer lock while playing (no screen open) → the UI opens the pause menu itself (via
  `input.onLockChange`). game.js does not have to do it (doing it too is harmless).
* `game.addChatMessage(text, color)` must **emit `'chat'` (text, color)**; the UI listens to that event. Don't
  also call `ui.addChatMessage` (that one adds a line directly, for code that does not use events).
  Text may contain Minecraft § codes (`§c` red, `§e` yellow, `§7` grey, `§l` bold …).
* `game.runCommand(text)` → `runCommand(game, text)` from `src/game/commands.js`.
* Loading: `ui.startWorld(meta)` shows the loading screen, awaits `game.startWorld(meta)` and calls
  `ui.enterGame()` if `game.state === 'playing'` afterwards. game.js may additionally call
  `ui.showLoading(text)`, `ui.setLoadingProgress(f, text)` or emit `'loadingProgress'` with `(fraction, text)` or
  `({ fraction|progress, text })`, and/or call `ui.enterGame()` itself (idempotent).
* Death: `player._die` emits `'playerDied'` with the Chinese message → death screen. Fallback: if
  `player.dead === true` without an event the UI opens it anyway. "重生" calls `game.respawn()` if it exists,
  else `player.respawn()`; `'playerRespawned'` also closes the screen. Open crafting grids / cursor stacks are
  dropped (survival) when the death screen replaces an inventory screen.
* `game.quitToTitle()` (pause → "保存并退出到标题画面", death → "返回标题画面") should save, unload and set
  `state = 'title'`; the UI shows a "正在保存世界" screen while it runs and the title screen afterwards.
* The UI calls `game.setPaused(true/false)` for the pause menu (and options opened from it).
* `ui.hudHidden` (F1) — the renderer's hand/selection outline should be hidden too (pass `hand: null`).
* `game.getDebugInfo()` is only called while F3 is visible; the right column shows renderer stats
  (`renderer.getStats()`), GPU name (`renderer.gl`), memory, `entities.count`, targeted block
  (`interaction.target`).
* Settings: every control calls `game.applySettings({ key: value })`; the UI rescales on `settingsChanged`.
  Render distance is applied on slider release, everything else live.
* Items thrown from screens (Q, clicking outside, overflow on close) go through `game.dropFromPlayer(stack)`.
* Optional: `game.playerName` (default "玩家"), `game.respawn()`.
* "Click to play" hint is shown when playing with no screen and no pointer lock; it is suppressed when the URL
  contains `autostart=1` (automation) or with `new UIManager(game, root, { automation: true })`.

## Decisions / deviations from the spec

* `UIManager(game, root, options)` — extra optional `options` (`handleHudKeys`, `automation`).
* Extra public methods: `openWorldList()`, `startWorld(meta)`, `saveAndQuit()`, `respawn()`, `showMessage()`,
  `showPauseMenu()` (pause replacing the current screen), `applySetting(k, v)`, `postChat()`,
  `addChatMessage()`, `setHudHidden(b)`, `dropStack()`, `destroy()`; fields `hudHidden`, `debugVisible`,
  `scale`/`unit` (device px / CSS px per GUI pixel), `hud.flashDamage()`.
  `openOptions(back?, inGame?)` and `showActionText(text, seconds = 3)` take optional extra params.
* **GUI scale** works like Minecraft in *device* pixels: auto = largest integer factor keeping ≥ 320×240 GUI
  pixels; `settings.guiScale` 1–4 is capped to that. All CSS sizes are `calc(var(--g) * n)`; screen metrics are
  published as integer CSS vars (`--hw`, `--hh`, `--qh` …) so layouts land on whole device pixels.
* **Font**: printable ASCII uses a pixel font generated at runtime (TrueType built in JS, `FontFace`, no
  files/network); CJK falls back to Microsoft YaHei / PingFang SC. Stack:
  `"WebCraft Pixel", "Minecraft", "Microsoft YaHei", "PingFang SC", sans-serif`. Text layers use
  `will-change: transform` so Chrome uses grayscale AA (no ClearType colour fringes on the pixel font); the
  crosshair stays outside those layers so `mix-blend-mode: difference` inverts the game canvas.
* Text shadow offset = round(⅔ · scale) device px (2 px at the common scale 3; Minecraft uses 1 GUI px).
* Creative inventory follows the task: left click takes a full stack, shift-click sends a stack to the hotbar
  (fills an existing partial stack, else first empty slot, else the selected slot), middle click / number
  keys / Ctrl+Q give full stacks; right click takes one; clicking a creative cell with a held stack deletes
  it (Minecraft); shift-click on a hotbar slot in an item tab deletes it; shift-click on the destroy slot
  clears the inventory (Minecraft). Typing in the search tab goes into the search box (E does not close it,
  like Minecraft); `T` in other creative tabs jumps to search.
* Slot semantics implemented beyond the spec minimum: drag splitting with live preview (left = even split,
  right = one each, middle = full stacks in creative), double-click gathering, shift+double-click moves all
  stacks of that item, craft-all drops what does not fit (Minecraft), number keys on the result slot.
* Chat: Up/Down browse the sent history; while Tab-cycling suggestions they move through suggestions.
  Suggestions are shown live under the token being completed; the usage line appears when there are none.
* Unknown `/give` names get "你是不是想找" hints (substring + edit distance, English and Chinese).
* The fullscreen buttons engage the Keyboard Lock API, so Ctrl+W (sprint + forward) cannot close the tab
  in fullscreen; a loading-screen tip mentions double-tap-W sprinting.
* IME composition (Pinyin) keys never send chat / submit fields / close screens.
* `/kill` uses `player.kill()` (creative too, like Minecraft); `/time set` sets absolute time (Minecraft);
  integer x/z in `/tp` are block centres; `^` local coordinates are supported; `/fill` limit 32768.
* Recipe list (45): planks ×3 woods, sticks, crafting table, torches (coal/charcoal), furnace, 20 tools,
  sandstone, stone bricks, white wool, TNT, jack o'lantern, bucket, flint and steel, andesite, 5 storage
  blocks and their reverse. Smelting: ores, sand→glass, cobblestone→stone, stone bricks→cracked, logs→charcoal,
  raw meats. Tags `#planks`, `#logs`, `#coals`; `CRAFTING_REMAINDERS` supports bucket-style ingredients.
* No XP bar / armor slots (no such systems; the furnace and chest screens came in wave 2). The survival inventory uses the
  armor column for a larger player preview.

## Verification

* `node --test tests/crafting.test.js tests/commands.test.js tests/ui-slots.test.js tests/ui-font.test.js`
  → 47 tests pass (whole project `npm test`: 219 pass).
* `node tools/ui-screenshots.mjs` regenerates every screenshot (`tools/out/ui-*.png`) and runs the in-page
  interaction suites (exit code 1 on any failure / page error).
* `tools/ui-test.html?screen=…` screenshots of every screen (title, worlds, create, options, about, loading,
  pause, inventory, creative tabs/search/inventory tab, crafting, chat with suggestions, death, HUD, F3,
  underwater, low health) at 1280×720, 1920×1080, 854×480 and GUI scale 2, with and without textures.
* `import('/tools/ui-interact.js').then(m => m.run())` → 58 DOM-level interaction checks (slots, drag, double
  click, number keys, Q, crafting, creative tabs/search/scrollbar/destroy, chat, pause/options/sliders, HUD,
  death, perf) and `m.runFlow()` → 20 menu-flow checks; both pass with the mock input and with the real
  `Input` (`realinput=1`). `tools/ui-keys.json` checks trusted key events
  (T/"/" don't leak into the chat box, E types in the creative search).
* Cost: `ui.update()` ≈ 0.002 ms/frame (HUD), 0.006 ms with F3, 0.014 ms with an inventory + live 3D preview;
  the steady path allocates nothing (state codes → precomputed strings, pooled model faces).

## Known limitations

* Text is not literally pixel-perfect for CJK (system font, antialiased); Latin uses the pixel font.
* The pixel font covers printable ASCII plus ° · ×; other symbols fall back to the system font.
* The vignette brightness uses `world.getLight()` at the eye block; `game.daylight` scales sky light.
* `prefers-reduced-motion` disables the splash pulse and hint animation.
* No key-binding screen (Input supports `setBindings`, but DEFAULT_SETTINGS has no bindings field yet).
* Furnace / chest screens, block entities, difficulty, /summon, /difficulty, /kill @e: see docs/notes/containers-wave2.md (wave 2).
* The HUD has no XP bar (no experience system); hearts/food/air follow Minecraft 1.12 logic.
