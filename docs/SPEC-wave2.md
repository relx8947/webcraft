# WebCraft — Wave 2 Specification (mobs, combat, survival, containers, fluids, farming)

Wave 1 delivered a complete, integrated engine (see docs/SPEC.md — still the base contract — and
docs/notes/*.md). Wave 2 adds the remaining core Minecraft survival gameplay. Read docs/SPEC.md,
this file, and the CURRENT code of every module you touch or call (the code is the truth for wave-1
APIs; many modules grew richer than SPEC.md describes — e.g. entities.js already has Entity,
FallingBlockEntity, PrimedTntEntity, explosions and the third-person PlayerAvatar; the entity renderer
already draws Minecraft ModelPart box models with skins for the player; interaction.js already does
buckets and TNT ignition hooks).

Same rules as wave 1: pure ES modules, zero dependencies, Chinese UI text, Minecraft-faithful
behaviour and numbers (Java Edition), complete features, no per-frame allocations in hot paths,
tests + harness screenshots for verification, only edit files you own (§2).

---------------------------------------------------------------------------------------------------

## 1. New registry content (already added to blocks.js / items.js by the lead — append-only ids)

Blocks:
| id | name | notes |
|----|------|-------|
| 95–98 | `chest`, `chest_north`, `chest_east`, `chest_west` | renderType `chest` (see §5.3), facing variants like furnace, interact `chest` |
| 99–102 | `lit_furnace`, `lit_furnace_north/_east/_west` | hidden, item `furnace`, emission 13, front `furnace_front_on` |
| 103–109 | `water_flowing_1` … `water_flowing_7` | flowing water, level 1..7 |
| 110 | `water_falling` | falling water column (level 8, full height) |
| 111–117 | `lava_flowing_1` … `lava_flowing_7` | flowing lava (overworld lava uses levels 2, 4, 6) |
| 118 | `lava_falling` | falling lava |
| 119 | `farmland` | dry farmland (top at 15/16, renderType `farmland`) |
| 120 | `farmland_moist` | hydrated farmland (darker top texture) |
| 121–128 | `wheat_0` … `wheat_7` | crop stages, renderType `crop` |
| 129–132 | `wall_torch_north/_south/_east/_west` | hidden torch variants attached to the block behind (`needsSupport: 'wall'`, `wallFacing`, registry `WALL_FACE[id]`); `getPlacementBlock(torch, face)` returns them for side faces |

Items: `mutton` 303, `cooked_mutton` 304, `chicken` 305, `cooked_chicken` 306, `arrow` 307,
`bow` 308 (durability 384), `spider_eye` 309, `wheat_seeds` 310 (places `wheat_0` on farmland),
`wheat` 311, hoes 312–316 (`wooden_hoe` … `diamond_hoe`, tool type `hoe`), spawn eggs 317–324
(`pig_spawn_egg`, `cow_spawn_egg`, `sheep_spawn_egg`, `chicken_spawn_egg`, `zombie_spawn_egg`,
`skeleton_spawn_egg`, `creeper_spawn_egg`, `spider_spawn_egg`, creative tab `spawn` = 刷怪蛋).
Extra item textures (not items): `bow_pulling_0`, `bow_pulling_1`, `bow_pulling_2`.

Support rules: use registry `canStay(id, getBlock, x, y, z)` everywhere (placement, neighbour updates,
random ticks) instead of `hasSupport` — it covers floor support, wall torches (block behind), cactus
(no solid horizontal neighbours) and sugar cane (water next to the block below). Neighbour updates
must re-check the block above AND the 4 horizontal neighbours of a changed cell.

Registry helpers added for liquids (use these everywhere instead of comparing with BLOCK.WATER/LAVA):
`LIQUID_KIND[id]` (0 none, 1 water, 2 lava), `LIQUID_LEVEL[id]` (0 source, 1..7 flowing, 8 falling),
`isWater(id)`, `isLava(id)`, `liquidBlock(kind, level)` → id, `liquidHeight(id)` → surface height of
a lone cell in blocks (source 8/9 … level 7 1/9, falling 1.0 — Minecraft `1 − (level+1)/9`).
`short_grass`/`fern` now drop `wheat_seeds` with 12.5 % chance (Minecraft). Wheat drops: stage 7 →
1 wheat + 1–4 seeds, younger → 1 seed; pick block on wheat gives seeds (new block field `pickItem`;
the block field `item` always names a BASE BLOCK). Farmland drops dirt. Flowing/falling liquids have
no item (`itemForBlock` → 0).

Settings: `difficulty` ('peaceful' | 'easy' | 'normal' | 'hard', default 'normal') in DEFAULT_SETTINGS.

New textures (registry TEXTURES) start out rendered by a magenta/black "missing texture" fallback in
textures.js until the ART agent paints them (textures.js exports `MISSING_TEXTURES`; it must end empty).
New render types `chest`, `crop`, `farmland` render as plain cubes / cross until the WORLD agent
implements them in the mesher (registry `RENDER` already has CHEST 6, CROP 7, FARMLAND 8).

## 2. Ownership (wave 2)

| Agent | Owns (may edit) |
|---|---|
| MOBS | `src/game/entities.js`, `src/game/particles.js`, `src/game/mobs.js` (new), `src/game/mobai.js` (new, optional), `src/render/entityrenderer.js`, `src/render/mobmodels.js` (new, optional) |
| SURVIVAL | `src/game/player.js`, `src/game/interaction.js`, `src/game/input.js` |
| WORLD | `src/world/world.js`, `src/world/fluids.js` (new), `src/world/blockupdates.js`, `src/world/chunk.js`, `src/world/worker.js`, `src/world/mesher.js`, `src/world/lighting.js`, `src/world/storage.js` |
| CONTAINERS | `src/game/blockentities.js` (new), `src/ui/*`, `src/game/crafting.js`, `src/game/commands.js`, `css/style.css`, `index.html` |
| ART | `src/render/textures.js`, `src/game/audio.js` (only if a needed sound is missing) |
| INTEGRATOR (after the others) | `src/game.js`, `src/main.js`, everything else |
| FIXER | `src/render/renderer.js`, `src/render/shaders.js`, `src/world/worldgen.js`, `src/util/noise.js`, `src/game.js`, `src/main.js`, `src/world/workerpool.js` — wave-1 review findings in files nobody else owns (no new features) |
Shared files (`config.js`, `blocks.js`, `items.js`, `registry.js`, `physics.js`, `math.js`): additive changes only if unavoidable; list them.
Everyone: replace `=== BLOCK.WATER` / `=== BLOCK.LAVA` checks in YOUR files with the liquid helpers.

## 3. Mobs & combat (MOBS agent; player side by SURVIVAL)

### 3.1 Mob types (Minecraft Java numbers; Chinese names)
| type | 名称 | size (w×h) | HP | speed (b/s walk) | drops |
|---|---|---|---|---|---|
| pig | 猪 | 0.9×0.9 | 10 | ~2.5 | porkchop 1–3 (cooked if burning) |
| cow | 牛 | 0.9×1.4 | 10 | ~2.0 | beef 1–3, leather 0–2 |
| sheep | 羊 | 0.9×1.3 | 8 | ~2.3 | white_wool 1 (unless sheared — no shears: always), mutton 1–2 |
| chicken | 鸡 | 0.4×0.7 | 4 | ~2.5 | chicken 1, feather 0–2; slow fall (flaps) |
| zombie | 僵尸 | 0.6×1.95 | 20 | ~2.3 (chases faster) | rotten_flesh 0–2 |
| skeleton | 骷髅 | 0.6×1.99 | 20 | ~2.5 | bone 0–2, arrow 0–2 |
| creeper | 苦力怕 | 0.6×1.7 | 20 | ~2.5 | gunpowder 0–2 |
| spider | 蜘蛛 | 1.4×0.9 | 16 | ~3.0 | string 0–2, spider_eye (1/3) |

### 3.2 Behaviour
* Physics via PhysicsBody (gravity, collisions, step over 1-block ledges by jumping, swimming up in
  water, flow push from `world.fluids?.flowVector`), body/head yaw like LivingEntity, idle look-around,
  look at nearby players.
* Passive: wander (random target within ~10 blocks, pauses), panic run for ~5 s after being hurt,
  avoid cliffs > 3 blocks and lava, chickens drift down slowly, sheep occasionally eat grass
  (grass_block → dirt with head-down animation). Ambient sounds every ~8–20 s (`game.audio.play('pig'…)`).
* Zombie: targets survival players within 35 blocks (line of sight or within 16), walks/jumps toward
  them (simple local obstacle handling + optional short-range A* on a block grid), melee 3 dmg
  (easy 2, hard 4.5) with 1 s cooldown and knockback; burns in daylight when sky-exposed (sky light 15,
  daylight ≥ 0.8, not in water): 1 dmg/s + flame visual + smoke particles.
* Skeleton: keeps 4–15 blocks distance, strafes, draws bow and shoots an Arrow every ~2–3 s (velocity
  ~1.6·20 b/s, inaccuracy by difficulty, damage 2–4 by speed), burns in daylight.
* Creeper: approaches; within 3 blocks starts a 1.5 s fuse (hiss sound `creeper_hiss`, white flashing,
  swelling), explodes with power 3 via `game.entities.explode(...)` if the player is still within 7
  blocks, else defuses. Does not burn.
* Spider: hostile at night/dark, neutral when its light ≥ 12 unless attacked; climbs walls (when
  colliding horizontally, rise at ~4 b/s), leaps at the target when 2–6 blocks away, melee 2 dmg.
* Hostiles ignore creative players and dead players. Peaceful difficulty removes hostiles.
* `hurt(amount, cause, attacker)`: 0.5 s invulnerability (only higher damage overrides, like
  Minecraft), red tint (hurtTime), knockback away from the attacker (Minecraft 0.4 strength,
  +sprint bonus), death at ≤ 0 HP → 1 s fall-over death animation (rotate 90° about Z, red), then
  poof smoke particles, drops via `game.spawnItem`, removal. Fall damage like the player.
* Arrow entity: gravity 20 b/s², drag, raycast against blocks and entity AABBs each step (no
  tunnelling), sticks into blocks (stays 60 s, player-shot arrows on the ground can be picked up in
  survival), damages the first entity hit (not the shooter during the first 0.25 s), knockback, sound.
  Rendered as a small 3D arrow (two crossed quads using the `arrow` texture or a box model).

### 3.3 Spawning (MobSpawner)
* `onChunkGenerated(cx, cz)` (fired by World the first time a chunk is generated — not when loaded
  from storage): 10 % of chunks in grassy biomes get a group of 2–4 passive animals of one type
  (pig/cow/sheep/chicken weighted 10/8/12/10) on grass blocks with sky access.
* Ongoing passive spawn: rare (every ~20 s try) when fewer than 10 passive mobs within 96 blocks.
* Hostile: every 1 s try up to N spots in loaded, meshed chunks 24–64 blocks from the player where
  the block below is solid+opaque, 2 air cells above, block light ≤ 7 and effective sky light
  (`sky * daylightLevel`) ≤ 7 (so: night surfaces, caves). Weights zombie 100 / skeleton 100 /
  creeper 100 / spider 100. Cap ~20 hostiles within 128 blocks; easy halves the rate.
* Despawn: hostiles farther than 128 blocks immediately; beyond 32 blocks random 1/800 per tick
  after 30 s. Passive mobs never despawn (they are persisted).
* Entities in chunks that are not generated/meshed are frozen (not updated) to avoid falling through
  unloaded terrain.
* Persistence: `EntityManager.serialize()` must include mobs (type, position, yaw, health, age…);
  the integrator stores it in world meta and restores it on load.

### 3.4 APIs (EntityManager additions, mobs.js)
```js
// src/game/mobs.js
export const MOB_TYPES                        // definitions by key
export class Mob extends Entity               // type 'mob', mobType, health, maxHealth, hurt(amount, cause, attacker), knockback(dx, dz, strength)
export class Arrow extends Entity
export class MobSpawner { constructor(game); update(dt); onChunkGenerated(cx, cz) }
export function spawnMob(game, mobType, x, y, z, { persistent } = {}) -> Mob   // spawn eggs, /summon
// EntityManager (entities.js)
raycastEntities(ox, oy, oz, dx, dy, dz, maxDist, { exclude, filter } = {}) -> { entity, distance } | null
spawnArrow(x, y, z, vx, vy, vz, { shooter = null, damage = 2, critical = false, pickup = false }) -> Arrow
countEntities(predicate, x, z, radius) -> number
```
Rendering: EntityRenderItem `{ kind: 'model', model: '<mobType>', x, y, z, bodyYaw, headYaw,
headPitch, limbSwing, limbSwingAmount, age, hurt, death, attack, swell (creeper 0..1), onFire,
sheared, light, shadowY, shadow, shadowRadius }` drawn by the entity renderer with Minecraft model
geometry and box-UV skins (painted procedurally at startup, original pixel art in Minecraft's style;
spider eyes emissive). Burning mobs show a fire overlay or flames + smoke.

### 3.5 Player side (SURVIVAL agent)
* Attack: on LMB, raycast entities (reach 3 survival / 5 creative, measured from the eye) and blocks;
  if an entity is closer than the targeted block, attack it instead of mining: damage = held tool
  damage (`ITEMS[id].tool.damage`, hand 1), critical ×1.5 when falling (vy < 0, not on ground, not in
  water, not flying) with crit particles, knockback (sprinting +), swords lose 1 durability, other
  tools 2; exhaustion 0.1. Swing animation always. (1.8-style: no attack cooldown.)
* Taking damage from mobs: `player.damage(amount, cause, message, attacker)` with knockback via
  `player.knockback(dx, dz, strength)`; death messages: 玩家被僵尸杀死了 / 玩家被骷髅射杀 /
  玩家被苦力怕炸死了 / 玩家被蜘蛛杀死了.
* Bow: hold RMB with a bow and arrows (or creative): charge up to 1 s (`bow_pulling_0..2` hand
  frames), release fires `spawnArrow` with velocity `charge-curve × 3 × 20` b/s (Minecraft power
  formula), damage scaling, crit at full charge; consumes an arrow (survival), bow durability −1.
* Spawn eggs: RMB on a block face spawns the mob on that face (creative doesn't consume).

## 4. Hunger (SURVIVAL agent)
Minecraft rules: food 0–20, saturation (≤ food, starts 5), exhaustion; exhaustion ≥ 4 → −1 saturation
or (if 0) −1 food. Costs: sprint 0.1/m, swim 0.01/m, jump 0.05, sprint-jump 0.2, attack 0.1, block
break 0.005, damage taken 0.1, healing 6 per HP from saturation. Regen: food ≥ 18 → +1 HP / 4 s (fast
+1 HP / 0.5 s when food 20 and saturation > 0). Starvation at food 0: 1 dmg / 4 s down to 10 HP (easy),
1 HP (normal), death (hard). Sprinting disabled when food ≤ 6. Peaceful: food never drops, health
regenerates. Eating: hold RMB with food (when food < 20) for 1.6 s → +hunger/+saturation, crunch
sounds every 0.2 s, food particles at the mouth, `burp` at the end; HandState gets
`useAction: 'eat' | 'bow' | null` and `useProgress 0..1` (the MOBS agent renders the eat bob / bow pull
in the first-person hand). Food values are in items.js (`food: { hunger, saturation }`).

## 5. World mechanics (WORLD agent)
### 5.1 Fluids (`src/world/fluids.js`, wired into world.js)
Minecraft 1.12 dynamic liquid rules: tick delay water 5 ticks, lava 30 ticks; level step water 1,
lava 2 (max spread water 7, lava 3 blocks); flowing cells take the minimum neighbour level + step and
dry up when no longer fed; a cell with liquid above becomes falling (full height); liquid flows down
first, otherwise horizontally toward the nearest drop found within 4 blocks (all directions if none);
two adjacent water sources over a solid/source floor create a new source; lava + water: lava source →
obsidian, flowing lava → cobblestone, lava flowing onto water → stone. Liquids wash away replaceable
non-solid blocks and support-needing plants/torches (dropping their items). Generated water is
static until disturbed (setBlock schedules updates for the changed cell's liquid neighbours).
Budget the number of updates per tick (keep frame times smooth); updates in unloaded chunks are
dropped or deferred. Export `flowVector(world, x, y, z, out)` (Minecraft's flow direction) for
entity pushing.
### 5.2 Liquid rendering (mesher.js)
All water ids are the same liquid (and all lava ids). Corner heights = Minecraft average of the
(up to 4) liquid cells around each corner (a corner touching a cell with the same liquid above is
full height); top faces sloped accordingly (heights quantised to 1/16 is fine), side faces follow the
corner heights with matching UVs; falling liquids are full height; no faces between cells of the same
liquid; anim = 3 as before.
### 5.3 Shapes
* `chest`: Minecraft chest box — 14/16 wide (inset 1/16 on all sides), 14/16 tall, textures `chest_top`
  (top/bottom), `chest_side`, `chest_front` (facing variant), with a small 2×4×1 px latch on the front
  if feasible. Collision/selection box [1/16, 0, 1/16, 15/16, 14/16, 15/16] (registry already set).
* `crop`: wheat-style '#' — four vertical planes at 4/16 and 12/16 along X and Z, each double-sided,
  top 1 block (Minecraft wheat), `anim` 1 on the top vertices, cutout, own-cell light.
* wall torches (`WALL_FACE[id] >= 0`): Minecraft wall-torch model — the torch post tilted 22.5° away from
  the wall (toward `WALL_FACE`), its base touching the wall at 3.5/16 height; floor torches unchanged.
* `farmland`: full cube with the top at 15/16 (top texture `farmland` / `farmland_moist`, sides dirt).
### 5.4 Random ticks additions
Wheat grows one stage with Minecraft probability (light ≥ 9 above, faster on moist farmland);
farmland becomes moist if water within 4 blocks horizontally (same y or 1 above), dries back to dirt
when dry and empty; trampling not required. World fires `onChunkGenerated(fn)` callbacks (first
generation only). Liquids get scheduled updates as described.

## 6. Containers (CONTAINERS agent)
* `src/game/blockentities.js`: `BlockEntityManager { constructor(game); get(x,y,z); getOrCreate(x,y,z,type);
  remove(x,y,z) -> stacks (to drop); onBlockChanged(x,y,z,oldId,newId); tick(dt); serialize(); deserialize(arr) }`.
  Furnace `{ type: 'furnace', slots: [input, fuel, output], burnTime, burnTotal, cookTime }` with
  Minecraft smelting (10 s per item, fuel burn times from item `fuel`, lit while burning: swap the block
  to the matching `lit_furnace*` variant and back, preserving facing). Chest `{ type: 'chest', slots: Array(27) }`.
  Breaking a container drops its contents. Persisted in world meta by the integrator.
* UI: `ui.openFurnace(blockEntity)`, `ui.openChest(blockEntity)` built on ContainerScreen (Minecraft
  layouts, flame + arrow progress for the furnace, shift-click routing: smeltables → input, fuels →
  fuel, output → inventory), live updates while open.
* Recipes: chest (ring of 8 planks), bow (3 sticks + 3 string), arrow (flint over stick over feather
  → 4), 5 hoes, bread (3 wheat in a row), wheat → seeds? (no). Smelting additions: mutton, chicken,
  plus make sure all Minecraft basics exist (sand → glass, cobblestone → stone, ores → ingots,
  logs → charcoal, meats → cooked, clay → bricks block (simplification), cactus → nothing).
* Options: difficulty selector (和平/简单/普通/困难). Creative tab `spawn` (刷怪蛋).
* Commands: `/summon <pig|cow|sheep|chicken|zombie|skeleton|creeper|spider> [x y z]`,
  `/difficulty <peaceful|easy|normal|hard>`, `/kill @e` (all mobs) and `/kill @e[type=<mob>]`,
  `/time` etc. unchanged. Use the APIs in §3.4 (`spawnMob`).

## 7. Art (ART agent)
Paint every new texture (blocks, crops, items, spawn eggs with Minecraft-like two-tone spots in each
mob's colours, bow + 3 pulling frames, 5 hoes, seeds, wheat, mutton/chicken raw+cooked, spider eye,
arrow, chest top/side/front, furnace_front_on with the glowing fire, farmland dry/moist tops) in the
same style as wave 1, icons included (IconFactory handles new render types: chest → cube icon,
crop → sprite of the last stage texture used by the item (seeds item has its own sprite), farmland →
cube). `MISSING_TEXTURES` must be empty and the texture tests green. Review the full preview sheet.

## 8. Integration (INTEGRATOR, after all wave-2 agents)
Wire: MobSpawner (update every frame, `world.onChunkGenerated` → `spawner.onChunkGenerated`),
mob + block-entity persistence in world meta, `onInteractBlock` routing (chest/furnace → UI, TNT
already), block-entity ticking and `onBlockChanged` (drop contents), difficulty from settings
(peaceful despawns hostiles), F5 also showing mobs correctly, hunger HUD, sounds; then fix the
wave-1 review findings (docs/notes/review-wave1.json) and verify everything end-to-end with the
harness (screenshots of each mob by day/night, combat, creeper explosion, skeleton arrows, furnace
smelting iron, chest storage persisting across save/load, water/lava flowing and making
obsidian/cobblestone, farming wheat → bread, eating restoring hunger).
