# CONTAINERS agent notes — wave 2 (block entities, furnace / chest screens, recipes, commands, options)

Scope: SPEC-wave2 §6 (+ the UI side of difficulty, spawn eggs and hunger), plus the wave-1 review findings
that concern my files. Owned files: `src/game/blockentities.js` (new), `src/ui/*`, `src/game/crafting.js`,
`src/game/commands.js`, `css/style.css`, `index.html` (unchanged); tests `tests/blockentities.test.js`,
`tests/blockentities-slots.test.js`, `tests/crafting.test.js`, `tests/commands.test.js`; visual / DOM tests
`tools/ui-test.html`, `tools/ui-interact.js` (`runContainers()`), `tools/ui-screenshots.mjs`; real-game
harness scripts `tools/steps/containers-*.json`. **No shared file was changed.**

## 1. What the integrator must wire (game.js)

Everything else is self-contained; until this is done chests / furnaces behave like plain blocks
(right click places the held block against them).

```js
import { BlockEntityManager } from './game/blockentities.js';

// startWorld(): right after World / Player / Interaction / EntityManager / ParticleSystem exist
this.blockEntities = new BlockEntityManager(this).attach(world);   // attach = world.onBlockChanged hook

// loading a saved world (any time; entities of chunks that are not loaded yet simply wait):
if (Array.isArray(meta.blockEntities)) this.blockEntities.deserialize(meta.blockEntities);

// update(): inside the fixed 20 TPS loop, after world.tick(...) — never while paused
this.blockEntities.tick(1 / TICKS_PER_SECOND);      // tick(dt) per frame also works (whole ticks accumulate)

// saving (_saveNow / the meta given to world.saveSnapshot — same atomic transaction as the chunks):
meta.blockEntities = this.blockEntities.serialize(); // small JSON array, empty idle containers are skipped

// onInteractBlock(x, y, z, blockId, ctx): FIRST line (before the TNT branch)
if (this.blockEntities?.useBlock(x, y, z, blockId, ctx)) return true;   // opens ui.openFurnace / ui.openChest

// _detachWorld():
this.blockEntities?.detach(); this.blockEntities?.clear(); this.blockEntities = null;
```

* `onBlockChanged` is wired by `attach(world)`: every `world.setBlock` that replaces a chest / furnace by
  anything that is not the same kind of container drops the contents (player breaking, explosions,
  `/setblock … destroy`, fluids — nothing to do in game.js). Placing a container creates its entity.
  The lit ↔ unlit furnace swap is the same kind and keeps the entity.
* The UI side needs nothing: `useBlock` calls `game.ui.openFurnace(be)` / `game.ui.openChest(be)`.
* Optional: F3 line `方块实体 ${game.blockEntities.count}`; `blockEntities.dirty` is set on every change.
* `sanitizeSettings` already accepts `difficulty` (checked in the current game.js); the UI and `/difficulty`
  additionally fall back to writing `settings.difficulty` directly if a string were ever dropped.
* `/summon` imports `src/game/mobs.js` itself (guarded dynamic import). An optional
  `game.spawnMob(type, x, y, z, opts)` facade is preferred when present (not required).

## 2. Block entities (`src/game/blockentities.js`, pure, Node-tested)

```js
export class BlockEntityManager {
  constructor(game, { rng } = {})
  get(x, y, z) -> BlockEntity | null
  getOrCreate(x, y, z, 'furnace' | 'chest') -> BlockEntity | null    // another type there is replaced (drops)
  remove(x, y, z) -> stacks[]            // removes WITHOUT dropping, returns copies (caller drops / discards)
  onBlockChanged(x, y, z, oldId, newId)  // drops contents when a container block is replaced
  useBlock(x, y, z, blockId, ctx) -> bool// right click: open the screen (true = click consumed)
  tick(dt = 0.05)                        // whole 20 Hz ticks, max 40 per call
  serialize() -> object[]; deserialize(arr) -> count
  attach(world) -> this; detach(); clear(); dropContents(be); count; list (iterator); dirty; ticks
}
export class BlockEntity { type, x, y, z, slots, version, removed, size, get(i), set(i, stack), changed(),
  mayPlace(i, stack), slotMax(i, stack), quickMoveOut(i), quickMoveIn(stack), isEmpty(), takeAll(), serialize() }
export class ChestBlockEntity      // 27 slots
export class FurnaceBlockEntity    // slots [input, fuel, output]; burnTicks, burnTotalTicks, cookTicks,
                                   // cookTotalTicks (ticks) + SPEC getters burnTime, burnTotal, cookTime,
                                   // cookTotal (seconds), lit, litProgress, cookProgress, canSmelt(), tick()
// helpers: containerType(id), litFurnaceOf(id), unlitFurnaceOf(id), fuelTicks(itemId), isFuel, isSmeltable,
// cookTicksFor(stack), cleanStack, displayTickChance(dx, dy, dz), createBlockEntity, blockEntityFromJSON,
// constants DEFAULT_COOK_TICKS 200, CONTAINER_REACH 8, CHEST_SIZE, FURNACE_SIZE, FURNACE_INPUT/FUEL/OUTPUT
```

### Furnace = Minecraft `AbstractFurnaceBlockEntity.serverTick`, tick-exact
* Fire (`burnTicks`) decreases first; a new fuel item is only lit when the input can be smelted
  (`canSmelt`: recipe exists, output empty or same item with room); fuel burn time = items.js `fuel`
  seconds × 20 (coal / charcoal 1600 = 8 items, planks / logs 300, stick 100, coal block 16000, lava
  bucket 20000 leaving its **empty bucket** in the fuel slot, wooden tools 200, bow 300 …).
* Cooking: +1 per lit tick while smeltable, result at 200 ticks (10 s) — fuel is consumed and the first
  progress tick happen on the same tick, so one coal smelts exactly 8 items and the fire goes out on tick
  1601. Not smeltable / output blocked while burning → progress 0; without fire progress decays by 2 / tick.
* Changing the input to a different item (or emptying it) restarts the progress; adding more of the
  same item keeps it (Minecraft `setItem`). Output stacks to 64.
* Lit state: after each tick the block is swapped to the `lit_furnace*` variant with the same facing
  (or back) via `world.setBlock` — only when it changes (2 world edits per fire). A lit block without fire
  (e.g. `/setblock lit_furnace`) is turned off on its first tick (self-healing; Minecraft would keep it lit).
* Display ticks: Minecraft's `FurnaceBlock.animateTick` (smoke + flame at the front face — facing from the
  block's texture spec — and a 10 % `fire_crackle`) with the exact odds of `ClientLevel.animateTick`'s
  random block sampling around the player (`displayTickChance`: ≈ 0.18 / tick next to the player, 0 beyond
  31 blocks). Uses `particles.spawnTorchFlame` (flame + smoke) — particles.js is not edited.
* Furnaces in unloaded chunks (`world.isChunkGenerated` false) are frozen; a furnace whose block vanished
  without a notification is removed and drops its items; chests are validated the same way once a second.

### Drops (`Containers.dropContents`)
Random point inside the cell, each stack split into parts of 10–30 items, hop `triangle(0 / 0.2, 0.115)`
b/tick, pickup delay 0 (Minecraft) — items next to the player are collected immediately. Through
`game.spawnItem` (fallback `entities.spawnItem`). Damage values (tools) are kept.

### Persistence format
`{ type: 'chest'|'furnace', x, y, z, items: [[id, count, damage] | null …], burn, burnTotal, cook, cookTotal }`
(furnace fields in ticks). `deserialize` validates everything (integer positions, y 0..255, known types,
existing item ids, counts clamped to the max stack, NaN-safe ticks) and never throws.

## 3. Screens (`src/ui/containers.js`, `src/ui/slots.js`, `src/ui/ui.js`)

* `ui.openFurnace(be)` / `ui.openChest(be)` (no-op when dead, another type, or a removed entity).
* **FurnaceScreen** — Minecraft furnace GUI 176×166: title 熔炉 centred, input (56, 17), fuel (56, 53),
  big output slot (116, 35), inventory label 物品栏 and the player inventory at (8, 84) / hotbar (8, 142).
  Flame (56, 36): `ceil(lit · 13) + 1` rows from the bottom of a 14×14 fire sprite; arrow (79, 34):
  `ceil(progress · 24)` columns of a white 24×16 arrow over the grey one (modern `AbstractFurnaceScreen`).
  Sprites are original pixel art (assets.js `furnaceFlame*`, `furnaceArrow*`).
* **ChestScreen** — generic 3-row chest GUI 176×168: 箱子 (8, 6), 27 slots at (8 + 18c, 18 + 18r),
  物品栏 (8, 74), inventory (8, 85) / hotbar (8, 143). `chest_open` / `chest_close` at the chest
  (volume 0.5, pitch 0.9–1.0).
* **Live**: the screens re-render when `be.version` changes (furnace ticks, other edits) and update the
  progress elements every frame (style writes only when a pixel value changes).
* **Closing**: E / Esc as before; the screen closes itself when the entity is removed (block broken /
  exploded / replaced), the player dies, or walks more than 8 blocks from the block centre (Minecraft
  `stillValid`). The cursor stack returns to the inventory (or drops, or falls on death).
* **Slot rules** (Minecraft Slot / Menu, implemented in the pure `ContainerModel` with the container's
  `mayPlace` / `slotMax` / `quickMoveIn` / `quickMoveOut`):
  - furnace output is take-only (clicking with the same item takes as many as fit, never swaps);
  - fuel slot: fuels and empty buckets only (buckets stack to 1 there); input: anything;
  - shift-click inventory → furnace: smeltables → input, else fuels → fuel, else hotbar ↔ main (if the
    target slot is occupied by another item nothing moves — Minecraft); furnace output → hotbar
    right-to-left first, input / fuel → main inventory first; chest ↔ inventory (chest slots in order;
    chest → hotbar from the right; a full chest does not fall back to hotbar ↔ main);
  - drag splitting skips slots that refuse the item, number keys (SWAP) and Q (THROW) follow the rules,
    double-click gathering takes container slots first, shift + double-click moves every stack of the item
    from the clicked container / the whole player inventory.

## 4. Recipes and smelting (`src/game/crafting.js`)
New shaped recipes: chest (ring of 8 `#planks`), bow (` #X`/`# X`/` #X`, stick + string, mirrorable),
arrows (flint / stick / feather → 4), the 5 hoes (`XX`/` #`/` #`, mirrorable, mixed planks OK), bread
(3 wheat in a row; 3 wide → crafting table). Smelting adds mutton → cooked mutton, chicken → cooked
chicken, clay block → bricks block (SPEC simplification: no clay ball / brick items); everything else of
the Minecraft basics was already there (ores, sand → glass, cobblestone → stone, logs → charcoal, raw
meats, stone bricks → cracked). Cactus smelts to nothing (no dyes). All smelts take 200 ticks.

## 5. Commands (`src/game/commands.js`)
* `/summon <pig|cow|sheep|chicken|zombie|skeleton|creeper|spider> [x y z]` — English ids, `minecraft:`
  prefix, Chinese names (猪, 苦力怕 …); integer x/z = block centre; errors: unknown entity (lists the
  valid ones), bad / unloaded position, extra arguments (no NBT), hostile mob in peaceful. Uses
  `spawnMob(game, type, x, y, z, { persistent: false })` of mobs.js (summoned mobs may despawn, like
  Minecraft). The first use imports mobs.js asynchronously (`runCommand` then returns a Promise that never
  rejects); afterwards it is synchronous. Message 已召唤新的僵尸.
* `/difficulty [peaceful|easy|normal|hard|和平|简单|普通|困难|0-3|p|e|n|h]` — query 难度为普通, set
  难度已被设置为困难, unchanged → error 难度未被改变，它已经是… (Minecraft). Via `game.applySettings`
  (persisted, `settingsChanged`) with a direct-write fallback; exported `getDifficulty`, `setDifficulty`.
* `/kill` — no argument / `@s @p @a @r` (with any arguments) / the player name: the player (as before).
  `@e` = **every mob** (SPEC; Minecraft would include items and the player). Selector arguments:
  `type=<mob>|item|arrow|tnt|falling_block|player` (also Chinese names, `!` negation), `distance=..10`
  (ranges `a..b`, `..b`, `a..`, `a`), `limit=N`, `sort=nearest|furthest|random|arbitrary`. Unknown
  arguments / types are errors; nothing matched → 未找到实体. Mobs die through `mob.kill()` (death animation;
  the MOBS agent's loot rules apply), other entities are removed. 已杀死僵尸 / 已杀死3个实体.
* `/setblock` and `/fill` without `destroy` now clear replaced containers instead of dropping their contents
  (Minecraft `Clearable.tryClear`); `destroy` drops them (and the block) like breaking.
* `/spawnpoint` stores `forced: true` (review CODE-4 / PLAYER-2; player.js respawns exactly there when the
  feet / head cells are free); `/setworldspawn` moves the spawn of players that follow the world spawn
  (`forced: false`) and keeps personal ones.
* Tab completion: mob ids (Chinese input → Chinese mob / difficulty names), `@e[type=…]` candidates,
  difficulty names, coordinates.

## 6. Options, creative, HUD, menus
* Options: **难度：普通** button cycling 和平 → 简单 → 普通 → 困难 (`settings.difficulty`), and
  **操作说明...** opening the controls list (AboutScreen, dim background + paused when opened in game). Both are
  appended as the 7th row, so existing control indices / click positions are unchanged.
* Creative: the **刷怪蛋** tab (CREATIVE_TABS `spawn`, 8 eggs, pig egg icon). Tab grid: building /
  decoration / nature on top, tools / food / materials / spawn eggs below (Minecraft 1.19.3+ also puts spawn
  eggs in the bottom row); the wave-1 `i % 3` layout would have put the 7th tab on top of 工具.
* HUD (player.js already provides the data): hearts turn poison-green while `player.poisonTicks > 0`,
  drumsticks turn green while `player.hungerTicks > 0` (Minecraft heart_poisoned / food_*_hunger, original
  art), the food bar shake with 0 saturation (`tick % (food·3 + 1)`, ±1 px per icon) was already in place.
* Controls list / loading tips updated for wave 2 (eating, bow, furnace, farming, creepers, Shift-click…).

## 7. Wave-1 review findings (docs/notes/review-wave1.json) concerning my files

| id | status |
|---|---|
| CODE-1 (save & quit silently discards on a failed save) | **fixed (UI part)**: `ui.saveAndQuit()` handles the `saveFailed` rejection of the FIXER's `quitToTitle`: new `SaveFailedScreen` (reason, “世界仍然开着，进度没有丢失”) with 重试 / 返回游戏 / 不保存并退出 (confirmation → `quitToTitle({ discard: true })`); Esc → pause menu; the game resumes correctly when leaving it (also from the death screen). Storage-unavailable warning on title / world list / create screens (see WORLD-6). Verified in the real game with a simulated QuotaExceededError (`containers-savefail.json`). |
| CODE-2 (unload loses block edits) | handled by FIXER (atomic snapshot, save on pause, beforeunload) — the UI's pause menu calls `game.setPaused(true)`, which now saves; nothing else in my files. |
| PLAYER-4 (Ctrl+W closes the tab) | FIXER: beforeunload; SURVIVAL: keyboard lock in fullscreen. **UI part added**: the first Ctrl-sprint in a window posts a one-time chat tip (双击 W / 全屏); the controls list now shows “双击 W / 左 Ctrl”. Verified in the real game (`containers-ctrlhint.json`). |
| CODE-4 / PLAYER-2 (/spawnpoint y ignored on respawn) | **fixed (command part)**: `/spawnpoint` stores `forced: true`, `/setworldspawn` updates followers with `forced: false`; player.js (SURVIVAL) honours the flag. |
| WORLD-6 (memory-only storage invisible) | **fixed (UI part)**: red line 浏览器禁止了本地存储：世界不会被保存，关闭页面后就会丢失 on title, world list (list moved down) and create screens, worlds marked （不会保存）; game.js (FIXER) posts the chat warning and requests persistent storage. |
| UI-1 (holding Ctrl blocks E / T / / / Esc) | **fixed**: `UIManager.onKeyDown` no longer bails out on `ctrlKey` (Alt / Meta still do). Reproduced with the reviewer's `ctrl.json` before, passes after; DOM check in `runReviewFixes`. |
| UI-2 (/kill from chat closes the death screen for a frame) | **fixed**: `ChatScreen.send()` closes only itself (`if (ui.screen === this)`). `killflicker.json`: chat → death, no `setScreen(null)` / `requestLock` in between. |
| UI-3 (keys / tooltip need a mouse move) | **fixed**: the pointer is tracked with no screen open, `ContainerScreen.resolveHover()` (elementFromPoint) on open and after creative tab switches, plus a `pointerover` listener. `hovernomove.json`: hover + tooltip + Digit1 without moving. |
| UI-4 (crosshair in F5 views) | **fixed**: crosshair and F3 gizmo only when `game.perspective === 0`. `f5.json`: hidden in both third-person views. |
| UI-5 (/spawnpoint y) | already fixed (see CODE-4). |
| UI-6 (GUI-scale button offers unusable sizes) | **fixed**: `ui.maxScale` (window maximum); the button cycles Auto, 1..min(maxScale, 4) and relabels on resize. (4 = the cap of game.js `sanitizeSettings`; raising it there would let large screens offer 5 / 6 — the UI already supports it via `GUI_SCALE_SETTING_MAX`.) `guiscale.json` at 800×600: 自动 → 1 → 2 → 自动. |
| UI-7 (single-slot drag clicks the start slot) | **fixed**: `endDrag(e)`: one slot → click on that slot (middle button: creative fill), none → click the slot under the pointer at release / drop outside / nothing on the panel. `b-inv4.json` X5: diamonds land in slot 20, logs stay. |

The reviewer's other UI scripts (inventory, creative ×3, chat ×3, death, select, lock, invert, water, HUD,
menus, options, about) still run without failures or page errors against the new code.

## 8. Verification
* Node: `node --test tests/blockentities.test.js` (21: block tables, fuel table, eager creation + drops in
  10–30 parts inside the cell, 200-tick smelting with coal lit on tick 1 and out on tick 1601, 8 items per
  coal, stick = half an item + decay by 2, lava bucket remainder + facing-preserving lit swap, no fuel
  wasted without a smeltable input / with a blocked output, output stacking to 64, input-change reset,
  progress getters, slot rules, lit self-healing, unloaded chunks frozen + orphan furnaces / chests drop,
  exactly 2 block swaps per fire, container replacement, useBlock + blocked chest, serialize round trip that
  continues identically, robust deserialize, remove / clear / detach, tick accumulation, display-tick odds
  and flame positions), `tests/blockentities-slots.test.js` (12: chest / furnace click, shift-click routing,
  take-only output, fuel rules, drag, SWAP / THROW, gather, close), `tests/crafting.test.js` (20, every new
  recipe + all smelting entries), `tests/commands.test.js` (24, incl. /summon through the real mobs.js).
  Whole suite (`npm test`): 521 / 521 pass.
* DOM: `tools/ui-screenshots.mjs` → 28 screenshots + `run` 58, `runFlow` 21, `runContainers` 43,
  `runReviewFixes` 11 checks, all passing (furnace shift-click / live progress / output / auto-close, chest, spawn tab, difficulty button,
  poisoned / hungry HUD, save-failed flow). Screenshots looked at: `tools/out/ui-furnace*.png`,
  `ui-chest.png`, `ui-creative-spawn.png`, `ui-options-difficulty.png`, `ui-hud-effects.png`,
  `ui-savefailed.png`, `ui-title-nostorage.png`, `ui-worlds-nostorage.png`, `ui-create-nostorage.png`.
* Real game (headless Edge, real CDP mouse / keys; block entities wired by an eval exactly like §1):
  `containers-furnace.json` (right click opens the furnace, real clicks move ore + coal, iron ingot after
  10 s, taken with real clicks, lit furnace texture + light + flame particle at night, broken with a stone
  pickaxe → 7 ore + 4 coal + furnace drop), `containers-chest.json` (open / close sounds, real clicks incl.
  right-click split and a damaged pickaxe tooltip, serialize → clear → deserialize → reopened with the same
  contents, blocked by stone on top, broken → everything drops), `containers-commands.json` (Tab completion,
  /summon of 4 mobs incl. 猪, /kill @e[type=zombie], /difficulty peaceful removing the creeper, /kill @e,
  difficulty persisted), `containers-savefail.json`, `containers-ctrlhint.json`. 0 console errors (except the
  intentionally simulated save failure logged by game.js).

## 9. Known limitations
* No chest lid animation (chests are static block models) and no double chests.
* No furnace XP / recipe book (no XP system).
* Furnace particles come from the block entity manager's display ticks, so a lit furnace block without
  an entity would show none — every furnace placed through `world.setBlock` gets an entity, so in practice
  this only concerns blocks of old saves before their first use.
* The harness cannot send modifier keys with mouse events, so Shift-click was verified with DOM events
  (`runContainers`) and unit tests rather than CDP clicks.
