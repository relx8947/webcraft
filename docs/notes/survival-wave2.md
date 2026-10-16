# SURVIVAL agent notes — wave 2 (player.js, interaction.js, input.js)

Scope: SPEC-wave2 §3.5 (player side of combat, bows, spawn eggs) and §4 (hunger, eating), plus farming
(hoe, seeds), the `canStay` support rules, flowing liquids for the player, source-only buckets and the
Ctrl+W mitigation. Files: `src/game/player.js`, `src/game/interaction.js`, `src/game/input.js`,
`tests/survival.test.js` (32 tests), `tests/player.test.js` (wave-1 tests, updated where the rules
changed), harness scripts `tools/steps/surv-eat-farm.json`, `surv-combat.json`, `surv-bow.json`,
`surv-mobs.json`, `surv-crit.json`, `surv-torch-respawn.json`.
Wave-1 design (movement model, camera, mining…) is unchanged and documented in `docs/notes/player.md`.

## Hunger (player.js, Minecraft FoodData 1.9+)

| rule | value |
|---|---|
| food / saturation / exhaustion | 0..20 / 0..food (starts 5) / 0..40 |
| exhaustion > 4 | −4, then −1 saturation, or −1 food when saturation is 0 (never in peaceful) |
| sprinting on the ground | 0.1 per metre (walking / sneaking free) |
| swimming | 0.01 per metre (3D distance when the eyes are under water) |
| jump / sprint-jump | 0.05 / 0.2 |
| attack (hit landed) / block broken | 0.1 / 0.005 (interaction.js) |
| damage taken | 0.1, except fall, drown, starve, suffocation, void, kill, generic, fire (burning), poison |
| fast regeneration | food 20 and saturation > 0: every 10 ticks heal min(sat, 6)/6, exhaustion += min(sat, 6) |
| regeneration | food ≥ 18: +1 HP every 80 ticks, +6 exhaustion |
| starvation | food 0: 1 damage every 80 ticks while HP > 10 (easy), > 1 (normal), always (hard) |
| peaceful | +1 HP every 20 ticks, +1 food every 10 ticks, food never drops |
| sprinting | needs food > 6 (or creative); a sprint ends when food drops to 6 |

Everything runs on a 20 Hz tick accumulator inside `_updateStatus`, so the integer timers are exact
at any frame rate. Creative players get no exhaustion (`addExhaustion` ignores it). The difficulty
comes from `game.settings.difficulty` (`'peaceful' | 'easy' | 'normal' | 'hard'`, default normal) via
`player.difficulty`. Health is a float now (fast regeneration heals fractions); the HUD shows `ceil`.

Food side effects (Minecraft): rotten flesh 80 % / raw chicken 30 % → Hunger for 30 s (+0.005
exhaustion per tick); spider eye → Poison for 5 s (1 damage at 100/75/50/25 ticks left, never below
1 HP, cause `'poison'`). `player.poisonTicks` / `player.hungerTicks` are public (an integrator could tint
the hearts / food icons like Minecraft).

API: `addExhaustion(n)`, `eat(hunger, saturation)` (FoodData.eat), `consumeFood(itemId, rng)` (items.js
`food` values + effects), `addEffect('poison'|'hunger', seconds)`, `canEat()`, `difficulty` getter,
constants `EXHAUSTION`, `MAX_FOOD`, `EAT_TIME` (1.6 s), `BOW_FULL_DRAW` (1 s), `KNOCKBACK_STRENGTH`.
Serialized: `food, saturation, exhaustion, foodTimer, poisonTicks, hungerTicks`; `respawn()` resets to
20 / 5 / 0.

## Item use: eating and bows

The use state lives on the player (`usingItem` `'eat' | 'bow' | null`, `useItemId`, `useSlot`,
`useTime` seconds; `startUsingItem` / `stopUsingItem`) and is driven by interaction.js:

* Right click (Minecraft.startUseItem order): 1) interactive block unless sneaking with an item;
  2) the held item on the clicked face: hoe → till, wheat seeds → plant, spawn egg → spawn, block item →
  place; 3) the item itself: bucket (scoop / pour), food → start eating, bow → start drawing.
* While using: movement input ×0.2, no sprinting, no attacking / mining / pick block (clicks swallowed
  like Minecraft), switching hotbar slot or losing the item cancels, `input.active === false` (screen
  opened, pointer lock lost) cancels without shooting.
* Eating: needs `food < 20` (creative always). 20 Hz ticks: when ≤ 25 of the 32 ticks remain and the
  remaining count is a multiple of 4 (ticks 9, 13, …, 29) → 5 food particles 0.6 in front of the mouth
  (`particles.spawnItemBreak(itemId, …)`) + `eat` sound (volume 0.5/1, pitch ±0.2); at 32 ticks (1.6 s):
  16 particles + `eat`, food values + effects, `burp` (0.5, pitch 0.9–1.0), one item used in survival,
  hand re-equips. Holding the button keeps eating the next item 4 ticks later.
* Bow: needs an arrow (creative not). Releasing after t seconds: power `f = (t² + 2t)/3`, no shot when
  `f < 0.1` (t < 0.14 s), capped at 1; `entities.spawnArrow(x, eyeY − 0.1, z, v…, { shooter: player,
  damage: 2, critical: f === 1, pickup: survival })` with `v = normalize(look + gaussian·0.0075)·f·60 b/s +
  player motion (vertical only while airborne, 1.9+)`; `bow_shoot` sound with Minecraft's pitch; survival
  uses the first arrow stack and 1 bow durability (384). FOV narrows up to 15 % (`f² `-eased like
  Minecraft's `getFovModifier`).
* HandState gains `useAction` (`'eat' | 'bow' | null`), `useProgress` (eating: elapsed / 1.6 s; bow:
  seconds drawn capped at 1 — Minecraft's pulling frames switch at 0.65 / 0.9) and `useTime` (s).

## Combat (interaction.js / player.js)

* Picking (GameRenderer.pick): the block ray (reach 4.5 / 5) first, then attackable mobs (`type ===
  'mob'`, alive, `hurt()`) along the same ray up to the block hit via `entities.raycastEntities(eye,
  dir, maxDist, { exclude: player, filter })`, or — while that API is missing — a scan of
  `entities.list` against AABBs grown by 0.1. A mob within attack reach (3 survival, 5 creative) becomes
  `interaction.targetEntity` and hides the block target (no outline, no mining / placing behind it);
  a mob in front of the block but out of reach makes the ray MISS (Minecraft 1.8). Blocks without a
  collision box (short grass, flowers, crops, torches) do not shield mobs (modern behaviour).
* LMB click on a mob (1.8: no cooldown, one hit per click, swing always): damage = `tool.damage` of the
  held item (hand / other items 1), ×1.5 critical when `fallDistance > 0 && vy < 0 && !onGround &&
  !inWater && !inLava && !flying`; `mob.hurt(damage, 'player', player)` — the mob applies Minecraft's
  standard knockback itself (SPEC-wave2 §3.2). If the hit landed (`hurt` did not return `false`):
  sprint bonus `mob.push(view·0.5 b/tick, 0.1 b/tick up)` and the attacker's horizontal velocity ×0.6 /
  sprint ends (1.8 w-tap), crit particles (`particles.spawnCrit(x, y, z, w, h)` if available, else a
  burst of `spawnItemBreak` bits), durability −1 sword / −2 other tools (not in creative), exhaustion 0.1,
  sound `attack_hit` / `attack_crit` at the mob (Minecraft 1.9+ attack.strong / attack.crit); a hit the
  mob shrugs off (`hurt` returned false, e.g. its hurt cooldown) plays `attack_swish` (attack.nodamage).
* `player.damage(amount, cause, message, attacker)`: `attacker` (a mob, or a projectile whose `shooter`
  is a mob) gives the death message and — for a full (non-cooldown) hit that is not an explosion —
  Minecraft's 0.4 knockback away from the attacker / shooter, applied at the start of the next frame.
  `player.knockback(dx, dz, strength = 0.4)` (Minecraft LivingEntity.knockback: velocity halved,
  `strength` b/tick along (dx, dz) = AWAY from the source, 0.4 b/tick lift capped; the first tick on the
  ground keeps ground friction like a jump) replaces the default knockback when called for the same hit
  (same frame), so callers may use either or both without doubling. If an attacker hit the player in
  the same frame, the push is oriented away from it even if (dx, dz) points toward it (tolerates
  Minecraft's "toward the source" convention). Creative / dead players ignore knockback.
  Measured: a standard hit carries the player 1.96 blocks with a 1.153-block hop (Minecraft 2.07 /
  1.153; the take-off speed 8.86 b/s reproduces Minecraft's 0.4 b/tick lift under our drag model, and
  the first tick keeps ground friction with Minecraft's move-then-friction displacement). A hit swallowed
  by the hurt cooldown gives no knockback, even if the caller also calls knockback().
* Death messages (`deathMessageFor(cause, attacker)`): 玩家被僵尸杀死了 / 玩家被蜘蛛杀死了 (any mob by
  `mobType`, names from items.js `SPAWN_EGG_MOBS`), 玩家被骷髅射杀 (cause `'arrow'`/`'projectile'` or an
  attacker with `type === 'arrow'`, name from its `shooter`; without one 玩家被箭射杀), 玩家被苦力怕炸死了
  (`'explosion'` with a creeper attacker; TNT stays 玩家爆炸了). An explicit `message` always wins.

## Spawn eggs, hoes, seeds, placement

* Spawn egg (items.js `spawnMob`): the clicked block's cell if it has no collision box (plants), else
  the cell across the clicked face; `spawnMob(game, type, x + 0.5, y, z + 0.5, { persistent: true })`
  from `src/game/mobs.js`, imported lazily (preloaded as soon as an egg is held; a missing module only
  logs a warning). `interaction.spawnMob` can override it (tests). Survival uses the egg, creative not.
* Hoe (`tool.type === 'hoe'`): grass / snowy grass / dirt, any face but the bottom, air above →
  `farmland`, sound `hoe_till` (Minecraft item.hoe.till), −1 durability.
* Wheat seeds: top face of `farmland` / `farmland_moist` with air above → `wheat_0` (checked with
  `canStay`), `place:grass` sound, one seed used.
* Block placement uses registry `canStay(id, getBlock, x, y, z)` (floor support, wall torches need the
  block behind, cactus needs four non-solid sides, sugar cane needs water — flowing too — next to its
  ground). Torches: the `getPlacementBlock` variant first (side face → wall torch), then the floor /
  walls in the player's look order (Minecraft StandingAndWallBlockItem); a bottom-face click never
  places the floor torch first. Successful uses that change the stack (or any use in creative) re-equip
  the hand (Minecraft `itemUsed` dip).

## Liquids

* No `BLOCK.WATER / BLOCK.LAVA` comparisons remain: the player's fluid depth, eye check and splash
  height use `LIQUID_KIND` + `liquidHeight` (source 8/9, flowing level L (8 − L)/9, falling 1, full
  height under the same liquid) — flowing water swims, drowns, cancels fall damage like still water;
  flowing lava burns.
* Flow push (Minecraft updateFluidHeightAndDoFluidPushing): `world.fluids.flowVector(x, y, z, out)` of
  every liquid cell overlapping the body (scaled by depth below 0.4), averaged per liquid → target
  velocity shift 1.4 b/s in water, 0.093 b/s in lava (20·0.014/(1 − 0.8) etc.), computed once per frame.
* Buckets pick up sources only (`bucketRaycast`: Minecraft ClipContext.Fluid.SOURCE_ONLY — flowing
  liquid is see-through, so a source behind a flowing cell can be scooped). Pouring replaces flowing
  liquid with a source and washes out non-solid blocks (torches, flowers, crops — they drop).

## Wave-1 review findings (docs/notes/review-wave1.json) in my files

* **PLAYER-4 / CODE-2 (Ctrl+W closes the tab)** — browsers never deliver their reserved shortcuts to
  pages, so Ctrl (sprint) + W closes the tab outside fullscreen. My part: the first Ctrl-sprint outside
  fullscreen shows a one-time action-bar tip (`CTRL_SPRINT_TIP`: 双击 W 即可疾跑 …) via
  `ui.showActionText`; double-tap W sprinting (always worked) needs no Ctrl; `input.fullscreen` tells
  whether the UI's fullscreen mode (src/ui/menus.js, which engages the Keyboard Lock API) is active.
  The beforeunload confirmation and the atomic unload save (CODE-2's main part) belong to the FIXER
  (game.js / storage).
* **PLAYER-1 / SURV-1 (no wall torches)** — placement side fixed: side faces give wall torches via
  getPlacementBlock + registry `canStay`, falling back through the floor / walls in the look order like
  Minecraft's StandingAndWallBlockItem (bottom faces never try the floor first). Verified with real
  clicks (tools/steps/surv-torch-respawn.json, screenshot walltorch.png). Popping on support loss and the
  tilted model are WORLD's.
* **PLAYER-3 / CODE-6 (sugar cane without water, cactus next to blocks)** — placement uses `canStay`
  (tests for both rules, flowing water counts); neighbour updates are WORLD's (blockupdates.js).
* **PLAYER-2 / CODE-4 (respawn ignores the /spawnpoint y)** — fixed in respawn(): a personal spawn point
  (`spawnPoint.forced === true`, or — while /spawnpoint does not set the flag — any spawn point that
  differs from `worldMeta.spawn`) is used exactly when its feet and head cells are free of solids and
  liquids (Minecraft isPossibleToRespawnInThis); otherwise the player goes to the world spawn with the
  chat notice 你的重生点已被阻挡. The world spawn keeps following the terrain but now lands on the highest
  solid / liquid block (torches, flowers and grass no longer lift the player). `forced` is serialized.
  Verified: /spawnpoint inside a closed plank room → /kill → 重生 → exactly at the spawn point.
  Suggested for CONTAINERS: /spawnpoint could store `forced: true` (and /setworldspawn `forced: false`).

## Integration notes

* `game.settings.difficulty` must survive `sanitizeSettings` in game.js (currently only numbers /
  booleans pass; strings are dropped) — accept `'peaceful' | 'easy' | 'normal' | 'hard'`.
* MOBS (already wired that way): melee `player.damage(dmg, 'mob', undefined, mob)`, arrows
  `player.damage(dmg, 'arrow', undefined, arrow)` (shooter → 玩家被骷髅射杀, knockback from the shooter),
  explosions `player.damage(dmg, 'explosion', undefined, creeper)` (玩家被苦力怕炸死了; the explosion
  pushes the player itself, damage() adds no knockback for explosions). `Mob.hurt` applies the
  standard knockback; interaction.js only adds the sprint bonus with `mob.push`, so nothing doubles.
* Particles: `spawnCrit(x, y, z, width, height)` (MOBS, Minecraft crit emitter) — in use; eating uses
  `spawnItemBreak(itemId, …)`.
* Audio (all present in audio.js): `eat`, `burp`, `bow_shoot`, `hoe_till`, `attack_hit`, `attack_crit`,
  `attack_swish`, `fall_small` / `fall_big` (fall damage ≤ / > 4, on top of `hurt`, Minecraft 1.9+).
* Third-person (F5) poses can read `player.usingItem` / `player.useTime`.

## Tests / verification

* `node --test tests/survival.test.js` — 32 tests: exhaustion costs (sprint, walk, jumps, sprint-jumps,
  swim, damage, creative), saturation → food, fast / slow regeneration numbers, starvation per
  difficulty, peaceful, sprint ≤ 6 food, eating (1.6 s, tick-9 first crunch then every 4 ticks, 7 eat +
  burp, values, caps, release / slot switch cancel, full, creative, ×0.2 walking), food effects, attack
  damage per tool, durability, exhaustion, crits ×1.5, sprint knockback, reach 3/5 + MISS + grass,
  raycastEntities API path, mob damage knockback (single, flipped, explosions none, creative),
  death messages, bow speed 60 b/s / power curve / min power / creative / zoom / slowdown / cancel,
  spawn eggs, hoe, seeds, wall torches + fallback, cactus + sugar cane rules, buckets on flowing
  liquids, flowing-water physics, flow push, serialization, personal spawn points (exact / obstructed /
  world spawn), the Ctrl-sprint tip.
* `tests/player.test.js` (50): unchanged rules still pass; tests that measured damage now pin food to
  17 (Minecraft's fast regeneration would heal in between), the regeneration test checks the food cost,
  the eye test uses the 8/9 surface.
* Real game with the MOBS agent's mobs (`tools/steps/surv-mobs.json`): a real right click with a pig
  spawn egg spawns the pig on the clicked face (egg used); two real diamond-sword clicks (7 + 7) kill it
  (red flash, knockback, 3 porkchops, sword durability 2); a zombie egg at night: the zombie hits the
  player 3 × 3 (≈2.2 blocks of knockback each) and the death screen reads 玩家被僵尸杀死了.
* Crit with real input (`tools/steps/surv-crit.json`): a real Space jump, then a real click while
  falling on a cow with an iron sword → 6 × 1.5 = 9 damage, MOBS's `spawnCrit` sparkles, red tint,
  knockback (screenshot tools/out/surv/crit.png).
* Bow with real input (`tools/steps/surv-bow.json`): 1.2 s hold → pulling frames + 15 % zoom, release →
  one arrow at 58.8 b/s (crit, pickup), 4 arrows left, bow durability 1, `bow_shoot`; the arrow sticks in
  the terrain; a 0.3 s draw shoots at 12.9 b/s, a short tap shoots nothing.
* Real game (headless Edge, real CDP input): `tools/steps/surv-eat-farm.json` (hold RMB on bread:
  food 10 → 15, saturation 6, 7 crunches + burp; real right clicks till 3 grass blocks and plant 3
  seeds), `tools/steps/surv-combat.json` (an Entity-based test mob: real clicks deal 1 (hand), 5 (diamond
  pickaxe, −2 durability), 7.5 (falling crit after a real Space jump), sprint hit after a real W
  double tap pushes it 5.8 blocks and ends the sprint; mob damage pushes the player ≈2 blocks with
  hurt tilt). 0 console errors in every run.
* Knockback calibration (tools/out/surv/kb-sim.mjs): a standard hit on flat ground carries the player
  1.96 blocks with a 1.153-block hop; Minecraft 1.8's per-tick simulation gives 2.07 / 1.153.

## Known limitations

* The spawn-egg path imports mobs.js lazily (preloaded as soon as an egg is held) so interaction.js
  still loads in builds without mobs.js; the first click resolves in a microtask once the integrator
  imports mobs.js statically.
* No potion-effect HUD (poison / hunger effects are not visible except through damage / food loss).
* Minecraft's "doomed to fall" death messages (CombatTracker) are not reproduced.
* Eating cannot be interrupted by damage (same as Java).
