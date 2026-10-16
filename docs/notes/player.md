# Player agent notes — input.js, player.js, interaction.js

Files: `src/game/input.js`, `src/game/player.js`, `src/game/interaction.js`, tests in
`tests/player.test.js` (50 tests), browser sandbox `tools/player-test.html` + `tools/player-test.mjs`,
real-input harness script `tools/player-steps.json`.

## Movement model (player.js)

Minecraft integrates once per 50 ms tick: `d = m + a·input` (this tick's displacement), `m' = d·f`.
Every regime is converted to the equivalent continuous system `dv/dt = K·(vmax·input − v)` with
`K = −20·ln f` and `vmax = 20·a/(1−f)` and integrated **exactly** (exponential solution) per sub-step
(≤ 1/60 s). Steady speeds therefore match Minecraft to the last digit at any frame rate, and the total
displacement for any input pulse equals Minecraft's (same DC gain).

| regime | Minecraft per tick | here |
|---|---|---|
| ground | accel `0.1·0.216/slip³` (×1.3 sprint), friction `slip·0.91` | walk 4.317, sprint 5.612, sneak 1.295 b/s; ice keeps momentum (τ 0.44 s) |
| air | accel 0.02 (0.026 sprint), friction 0.91 | |
| vertical | `(vy − 0.08)·0.98` | K 0.404/s, terminal 78.4 b/s ⇒ gravity 31.7 b/s² |
| jump | vy = 0.42 b/tick (+0.2 facing when sprinting) | v0 = 9.2474 b/s (tuned so the apex is Minecraft's 1.2522), +4 b/s boost |
| flight | accel 0.05 (×2 sprint), friction 0.91; vertical `(vy ± 0.15)·0.6` | 10.89 / 21.78 b/s, ±7.5 b/s |
| water (1.13+) | accel 0.02, friction 0.8, gravity 0.005, Space +0.04, Shift −0.04 | swim 1.96 b/s, sink 0.5, rise 3.5, dive 4.5 b/s |
| lava | accel 0.02, friction 0.5, gravity 0.02, Space +0.04 | 0.78 / sink 0.8 / rise 0.8 b/s |

Other Minecraft details reproduced: 0.98 input scale, diagonal normalisation only above length 1,
the jump tick still uses ground friction (`JUMP_TICK` window, so sprint-jumping is frame-rate
independent: 4.29 blocks per jump vs Minecraft 4.28), 10-tick jump cooldown while Space is held,
fluid jump threshold 0.4 (shallow water = normal jump, else swim), hop out of water/lava against a
ledge (`isFree(+0.6)` → 0.3 b/tick), sneak edge guard (`maybeBackOffFromEdge`, 0.05 steps against the
box lowered by 0.6), crouch hitbox 1.5 high and staying crouched without headroom, sprint stops on a
*major* horizontal collision only (glancing contact < 8° keeps it), sprint stops when sneaking, not
moving forward or entering water; sprint starts with Ctrl (any time) or a double tap of W within 7
ticks (on ground / flying). Creative flight toggles on a double tap of Space within 7 ticks and ends
when touching the ground. Physics freezes while `world.isAreaReady(floor(x), floor(z), 1)` is false
(looking around still works).

Measured frame-rate independence: walking 4.317 b/s at 20/30/60/144/240 fps; apex 1.2522 ±0.004;
sprint-jump distance per jump equal at 30/60/144 fps.

Known, deliberate difference: the average sprint-jump *speed* is ≈7.5 b/s instead of Minecraft's 7.13
because Minecraft only notices the landing at the end of a tick (≈0.04 s later than the continuous
trajectory); the distance covered per jump (what matters for gaps) is the same.

## Status effects

* Fall damage `ceil(fallDistance − 3)` on landing; fall distance accumulates only while moving down,
  resets in water (re-checked after the landing move, like `checkFallDamage`), halves per tick in
  lava, is 0 while flying; creative players take none.
* Damage cooldown (Minecraft `invulnerableTime`): for 0.5 s after a hit only a bigger hit applies
  (the difference) → lava 4 per 0.5 s, cactus 1 per 0.5 s, void 4 per 0.5 s, suffocation 1 per 0.5 s.
* Drowning: air 300 ticks, −20/s with the eye under the 14/16 water surface (survival only), at 0:
  2 damage 1 s later and every second; refills +80/s (4 per tick).
* Lava sets 15 s of fire (1 damage/s outside lava, water extinguishes). `player.onFire` /
  `fireTime` for a fire overlay.
* Cactus (any non-liquid block with `damage > 0`) hurts when the AABB touches its cell (the
  collision box is inset 1/16, so walking into it hurts).
* Void below y = −64 (also in creative), suffocation when the head is inside an opaque solid block.
* Regeneration +1 HP every 4 s while food ≥ 18 (food stays 20; field kept, hunger not simulated).
* Death: `dead = true`, inventory scattered in survival (Minecraft `dropAll`, 2 s pickup delay),
  `game.emit('playerDied', message)`; `DEATH_MESSAGES` (Chinese) per cause: 玩家摔死了, 玩家淹死了,
  玩家试图在熔岩里游泳, 玩家被烧死了, 玩家被戳死了, 玩家掉出了这个世界, 玩家在墙里窒息而亡,
  玩家爆炸了, 玩家死了 …; `damage(amount, cause, message?)` accepts a custom message.
* `respawn()` → spawn column (`floor(spawnPoint) + 0.5`), placed on top of the column as soon as the
  chunk is ready (`getTopY + 1`), full health/air, emits `playerRespawned` (pass `{ emit: false }` for
  the very first spawn of a new world).

## Camera (getCameraState)

* View bobbing exactly like `GameRenderer.bobView` (walkDist phase, bob amplitude ≤ 0.1, translate
  x/y in view space + 3° roll + 5° pitch); off when `settings.viewBobbing === false`.
* FOV modifier eased 0.5/tick: sprint ×1.10 (task spec; Minecraft's formula gives 1.15), flying ×1.10;
  under water ×6/7 (Minecraft); on death the FOV narrows slightly and the camera rolls (Minecraft).
* Hurt tilt `sin(f⁴π)·14°` roll with `f = hurtTime / 0.5`.
* Eye height eases 0.5/tick between 1.62 and 1.27 when (un)crouching; `eyeInWater` / `eyeInLava`
  use that smoothed eye against the 14/16 liquid surface (full height when the same liquid is above).
* `getCameraState(out, perspective)`: 1 = third person behind, 2 = in front looking back, 4 blocks with
  Minecraft's 8-ray `getMaxZoom` wall clipping (needs a player model to be useful).

## Interaction

* Target: `raycast` from the (smoothed) eye, reach 4.5 / 5, liquids skipped.
* Survival mining: `progress += dt / getBreakTime(block, held item, {inWater: eyeInWater, onGround})`,
  stage `min(9, floor(progress·10))` (first crack shown immediately — Minecraft hides the first 10 %),
  hit sound every 4 ticks, crack particles every 2 ticks, continuous arm swing, restart on target /
  item change, 5-tick delay after a break, instant blocks break at most once per tick when sweeping,
  unbreakable blocks keep the hit feedback but never progress. Stone + wooden pickaxe = 1.15 s
  (verified). Drops via `getDrops` popped like `Block.popResource`. Tools lose 1 durability per
  non-instant block (swords 2), `break_tool` sound. Survival-broken ice turns into water above a solid
  block / liquid (`IceBlock.playerDestroy`).
* Creative: instant break on click and every 0.15 s while held, no drops, swords cannot break blocks.
* Placing (click → immediately, held → every 4 ticks; nothing while mining): replaceable target
  (short grass, fern, dead bush — not the same item) is replaced in place, otherwise the neighbour
  across the clicked face must be replaceable (air, water, lava, plants); `getPlacementBlock`
  variants (log axis, furnace/jack o'lantern facing); `hasSupport`; refused when the block's
  collision box intersects the player or any non-item entity (see integration); one item consumed in
  survival; `place` sound; swing.
* Use: block with `interact: 'crafting'` → `game.ui.openCraftingTable()`; other interactive blocks →
  `game.onInteractBlock(x, y, z, blockId, ctx)` (ctx = `{ itemId, stack, slot, face, sneaking, player }`);
  the click is consumed unless the hook returns `false` (e.g. TNT without flint and steel → place the
  held block instead). Minecraft rule: sneaking **with an item in hand** skips block interaction;
  sneaking with an empty hand still opens the table.
* Buckets: empty bucket scoops water/lava (fluid ray), filled buckets pour into the placement cell and
  become empty (creative keeps the empty bucket and adds a filled one if missing).
* Pick block: Minecraft `setPickedItem` (creative: select existing hotbar stack / swap from the main
  inventory / put 1 item into the selected-or-next-empty slot, moving a displaced stack into the
  inventory) and `pickSlot` (survival: select or swap only).
* Drop: Q one item, Ctrl+Q stack (physical Ctrl via `input.isKeyDown`), auto-repeat after 0.5 s while
  held (every 0.05 s), swing; via `game.dropFromPlayer(stack)` (fallback: Minecraft throw with
  `game.spawnItem`, 2 s pickup delay).
* Hotbar: 1–9 and wheel notches (down = next slot, wraps).
* HandState: `{ itemId, swing, equip, bobX, bobY, light, bobRoll, bobPitch, swayYaw, swayPitch, count }`.
  `swing` 0..1 over 0.3 s (restartable from the second half), `equip` follows Minecraft's
  `mainHandHeight` (±0.4/tick toward 0 when the held item changes, the drawn item swaps below 0.1,
  then back to 1), `bobX/bobY` = view-space translation of the hand (blocks, Minecraft bobView, 0 when
  bobbing is off), `bobRoll/bobPitch` the matching rotations, `swayYaw/swayPitch` the turning lag
  (`(view − lagged view)·0.1`), `light` = packed light at the eye.

## Input

* Bindings by `KeyboardEvent.code` (`DEFAULT_KEY_BINDINGS`; both Shift / Ctrl keys), mouse buttons as
  `Mouse0..4`. `active = enabled && (locked || allowUnlocked)`; inactive input reads idle.
* `isDown` = held now **or pressed during this frame** (a down+up inside one frame is never lost —
  important for CDP-driven tests). Edges are only recorded for events newer than the last
  (re)activation (`enabled = true` / pointer lock gained), so the E that closes the inventory cannot
  reopen it in the same frame regardless of listener order.
* Pointer lock with `{ unadjustedMovement: true }` (raw mouse), plain fallback, never throws; the
  first locked move event and single events > 1500 counts are dropped (Chromium spikes); a canvas
  click while enabled-but-unlocked re-requests the lock (`autoLock`) and is not a game click.
* `mouseDX/mouseDY` already include `settings.mouseSensitivity` (1.0 = Minecraft 100 % = 0.15°/count,
  applied by the player) and `settings.invertY`; `rawMouseDX/rawMouseDY` without. Settings are read
  live from the object given to the constructor (reassign `input.settings` if it is replaced).
* `wheel` = whole notches per frame (+ = down). Pixel deltas ≥ 40 count per event (Chrome 100/notch,
  Firefox ≈50), small touchpad deltas accumulate, line/page modes handled, Shift+wheel (Chromium
  reports deltaX) works.
* Default suppression while active: every key except F11/F12 and Ctrl+Shift+I/J/C (Space scroll, Tab
  focus, F1/F3/F5, quick-find, Ctrl+S/D/F dialogs, Alt menu), wheel scroll/zoom, middle-click
  autoscroll, back/forward buttons; the canvas context menu is always suppressed.
* Release everything on window blur, hidden tab and pointer-lock loss.
* Limitation: browsers do not let pages intercept **Ctrl+W** (closes the tab) outside fullscreen
  keyboard lock — sprinting with Ctrl while pressing W can close the tab. Double-tap W avoids it;
  the UI may want to show a tip.

## Integration (src/game.js)

```js
input = new Input(canvas, settings);            // keep input.enabled = false outside gameplay / while screens are open
input.allowUnlocked = automation;                // e.g. for autostart=1 harness runs (and skip "lock lost → pause" then)
player = new Player(game); interaction = new Interaction(game);
// new world:   player.spawnPoint = meta.spawn; player.respawn({ emit: false }); player.setGameMode(meta.mode)
// saved world: player.deserialize(meta.player)  (if player.dead afterwards → ui.openDeath(player.deathMessage))
// frame:  player.update(dt, input); interaction.update(dt, input); ...; render; input.endFrame()
frame.camera = player.getCameraState(undefined, perspective);
frame.underwater = player.eyeInWater; frame.inLava = player.eyeInLava;
frame.selection = interaction.selection;          // { x, y, z, box } | null
frame.breaking = interaction.breaking;            // { x, y, z, stage, progress, ... } | null
frame.hand = perspective === 0 && !player.dead ? interaction.getHandState() : null;
audio.setListener(cam.x, cam.y, cam.z, cam.yaw);
```

Game facade members used (all optional-chained except world/player): `world.getBlock/setBlock/
getTopY/getLight/isAreaReady`, `settings.fov/viewBobbing`, `audio.playBlock(kind, material, x, y, z)`
(kinds `step`, `land`, `hit`, `break`, `place`), `audio.play(name, {x, y, z, volume})` (`hurt`,
`death`, `splash`, `swim`, `break_tool`), `particles.spawnBlockBreak/spawnBlockHit/spawnSplash`
(`spawnBlockHit(x, y, z, 2, id)` is also used for sprint and landing dust), `spawnItem(stack, x, y, z,
vx, vy, vz, pickupDelay)`, `dropFromPlayer(stack)`, `emit('playerDied', msg)` / `emit('playerRespawned')`,
`ui.openCraftingTable()`, `onInteractBlock(...)`, and for placement blocking `entities.anyEntityInBox(box)`
if present, else `entities.entities` / `entities.list` (objects with `getAABB(out)`, `body.getAABB`, or
`x, y, z, width, height`; `kind === 'item'` is ignored, like Minecraft).

`player.getEyePosition()`, `getLookVector()`, `getCameraState()`, `getViewBob()`, `getHandSway()` and
`interaction.getHandState()` return reused objects (pass `out` to keep a copy).

## Not implemented (by design / later waves)

* Step-up (stepHeight 0.6): no block with a collision height ≤ 0.6 exists yet; add it in `_step` when
  slabs/snow layers arrive.
* Swimming pose / sprint-swimming, ladders, hunger & eating (food never drops), attacking entities
  (LMB currently only swings at air), fire blocks (flint and steel only reaches `onInteractBlock`).
* Landing plays `land` for every landing ≥ 0.5 blocks (Java only plays a step sound when the landing
  also crossed the step distance); crack stage starts at 0 immediately.
