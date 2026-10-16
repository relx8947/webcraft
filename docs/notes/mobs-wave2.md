# MOBS agent notes — wave 2 (mobs, combat entities, arrows, mob rendering)

Files (owned): `src/game/mobs.js` (new), `src/game/mobai.js` (new), `src/render/mobmodels.js` (new),
`src/game/entities.js`, `src/game/particles.js`, `src/render/entityrenderer.js`; tests `tests/mobs.test.js`
(40 tests); visual page `tools/mob-test.html`; harness helper `tools/mob-wire.js` + steps `tools/steps/mobs-*.json`.
SPEC-wave2 §3.1–3.4 plus the first-person `useAction` hand and the wave-2 liquid / support rules in my files.

## Integration (for the integrator — game.js)

```js
import { MobSpawner } from './game/mobs.js';          // importing mobs.js also registers mob persistence
// startWorld, after creating game.entities:
game.spawner = new MobSpawner(game);
const unsub = world.onChunkGenerated((cx, cz) => game.spawner.onChunkGenerated(cx, cz));
// loop (playing, not paused), right after entities.update(dt):
game.spawner.update(dt);
// save / load: unchanged — meta.entities = entities.serialize() / entities.deserialize(meta.entities)
//   (mobs and arrows are included; saved mobs found before mobs.js is loaded are kept and restored later)
// quit: unsubscribe onChunkGenerated, game.spawner = null
```
* `game.settings.difficulty` must reach the game as a string (`'peaceful' | 'easy' | 'normal' | 'hard'`):
  `sanitizeSettings` in game.js currently drops strings. Peaceful removes hostiles on their next update.
* The spawner reads `game.player`, `game.world` (`getBlock`, `getLight`, `getTopY`, `isChunkMeshed`, `seed`),
  `game.entities`, `game.settings.difficulty`, `game.daylight`, `game.timeOfDay` (all exist on Game).
* Debug suggestion: `game.debug.summon(type, dist)` = `tools/mob-wire.js` `spawnInFront`.
* `tools/mob-wire.js` `wire(game)` wires a running game exactly like the snippet above (harness use only).

## Public API

```js
// src/game/mobs.js
export const MOB_TYPES          // pig cow sheep chicken zombie skeleton creeper spider: name (Chinese), hostile, width,
                                // height, eyeHeight, health, speed (attribute), drops, sounds, ai, model ...
export class Mob extends Entity // type 'mob', mobType, health, maxHealth, dead, hostile, persistent, target,
                                // hurt(amount, cause, attacker) -> bool, knockback(dx, dz, strength = 0.4),
                                // kill() (like /kill: normal death with loot), setFleece(i), getRenderItem(),
                                // serialize(), static fromJSON(rec)
export { Arrow }                // re-exported from entities.js
export class MobSpawner         // constructor(game, { rng }); update(dt); onChunkGenerated(cx, cz) -> count;
                                // spawnHostiles(), spawnPassive(); hostileCap 20, passiveCap 10; stats
export function spawnMob(game, mobType, x, y, z, { persistent = false, yaw } = {}) -> Mob | null
export function walkSpeed(speedAttribute, modifier, slip) -> b/s;  mobSound(name);  pathBudget
// src/game/entities.js (additions)
EntityManager.raycastEntities(ox, oy, oz, dx, dy, dz, maxDist, { exclude, filter } = {}) -> { entity, distance } | null
EntityManager.spawnArrow(x, y, z, vx, vy, vz, { shooter, damage = 2, critical, pickup }) -> Arrow   // velocity b/s
EntityManager.countEntities(predicate | 'mob' | 'arrow' | '<mobType>' | null, x, z, radius) -> number
export class Arrow extends Entity;  registerEntityType(type, fromJSON);  createModelRenderItem(model);
export function scaleMobDamage(game, amount), liquidSurface(world, x, y, z, id), fluidFlow(world, body, kind, out)
explode(x, y, z, power, { breakBlocks, source, dropChance, attacker })    // attacker -> player.damage(..., attacker)
// src/game/particles.js (additions)
spawnCrit(x, y, z, width, height)   // the hit entity's box (SURVIVAL uses it for critical hits)
spawnCritTrail(x, y, z, vx, vy, vz) // fully drawn arrows
spawnPoof(x, y, z, width, height)   // a dying mob
// src/render/mobmodels.js: MODEL_DEFS, MODEL_ID, SKIN, buildModelBox, buildPartGeometry, computeModelPose,
//   paintMobSkins, paintFireFrames, fireSheetCount, bowPower (pure, tested)
// src/render/entityrenderer.js: thirdPersonTransform, handUseTicks (+ supportsMobModels = true)
```

Conventions: `hurt(amount, cause, attacker)` applies Minecraft's standard 0.4 knockback away from the attacker
itself (arrows: along their flight); `knockback(dx, dz, s)` pushes along (dx, dz) = AWAY from the source (the
SURVIVAL agent's sprint bonus uses `mob.push(...)` directly). Mobs damage the player through
`player.damage(amount, 'mob', undefined, mob)` (difficulty-scaled here, knockback + death message there);
arrows `player.damage(amount, 'arrow', undefined, arrow)`; creeper blasts pass the creeper as attacker
(玩家被苦力怕炸死了).

### 'model' EntityRenderItem (player avatar, mobs, arrows share ONE object shape)
`kind 'model', model, modelId, x y z, bodyYaw, headYaw, headPitch, limbSwing, limbSwingAmount, attack, sneaking,
age, hurt, death, light, itemId, shadowY, shadow, shadowRadius, swell, onFire, sheared, aggressive, eat, flap,
useTime, color, shake` (SPEC §3.4 fields + modelId, aggressive (zombie arms up / drawing a bow), eat (sheep
eating ticks), flap (chicken wings), useTime (bow draw ticks), color (fleece tint), shake (arrow)). Arrows use
bodyYaw = atan2(vx, vz) and headPitch = atan2(vy, horizontal) like Minecraft's arrow rotation.

## Mobs (Minecraft Java numbers)

| type | box | HP | walk (b/s) | AI | drops |
|---|---|---|---|---|---|
| pig 猪 | 0.9×0.9 | 10 | 2.75 (0.25) | stroll, panic ×1.25, look | porkchop 1–3 (cooked if burning) |
| cow 牛 | 0.9×1.4 | 10 | 1.76 (0.2) | stroll, panic ×2, tempt (wheat) | beef 1–3, leather 0–2 |
| sheep 羊 | 0.9×1.3 | 8 | 2.33 (0.23) | stroll, panic, eat grass, tempt (wheat) | wool of its fleece colour, mutton 1–2 |
| chicken 鸡 | 0.4×0.7 | 4 | 2.75 (0.25) | stroll, panic ×1.4, slow fall, tempt (seeds) | chicken 1, feather 0–2 |
| zombie 僵尸 | 0.6×1.95 | 20 | 2.33, chase ×1.15 (3.1) | target 35 (LOS or 16), melee 3 (1 s), burns | rotten flesh 0–2 (+ rare iron) |
| skeleton 骷髅 | 0.6×1.99 | 20 | 2.75 | RangedBowAttack: 15 radius, strafe, 20-tick draw, 40/20-tick interval | bone 0–2, arrow 0–2 |
| creeper 苦力怕 | 0.6×1.7 | 20 | 2.75 | approach, fuse within 3, explode (power 3) unless the target leaves 7 / LOS | gunpowder 0–2 |
| spider 蜘蛛 | 1.4×0.9 | 16 | 3.96 (0.3) | hunts in the dark / when provoked, climbs walls 4 b/s, leaps 2–6 blocks, melee 2 | string 0–2, spider eye 1/3 (player kills) |

* **Movement**: Minecraft's travel() as a continuous system (see the mobs.js header): ground speed
  `20·(s·m)²·0.216/slip³/(1 − 0.91·slip)` (ice is slippery for mobs too), air / water / lava control, gravity
  0.08 b/tick² with drag 0.98, jump 0.42 b/tick (1.25 blocks) for 1-block steps (MoveControl: waypoint higher than
  0.6 or walking into a wall, head room checked), FloatGoal in liquids (rise 2.4 b/s until 0.4 below the surface;
  hop out onto ledges), flowing water / lava push (0.014 / 0.0023 b/tick² along `world.fluids.flowVector`),
  chicken slow fall (×0.6 per tick, ~2.3 b/s), spider climbing, fall damage ceil(d − 3) (not chickens).
* **Rotation**: yaw turns to the next waypoint at 90°/tick, body follows the movement (BodyRotationControl),
  head (10°/tick, 30° when targeting) within ±75° of the body; LookAtPlayerGoal (2 %/tick within 6–8 blocks,
  2–4 s) and RandomLookAroundGoal; walk cycle from the distance walked (WalkAnimationState, eased 0.4/tick).
* **Path finding** (`mobai.js` PathFinder): A* on the block grid, 8 directions without corner cutting, step up 1
  (jump), drop ≤ 3 (4 for hostiles), swim (extra cost), never through lava / cactus / unmeshed chunks; bounded
  by 300–600 node expansions; partial paths lead to the closest node. One shared, allocation-free instance;
  `pathBudget` limits searches to 40/s (bursts of 3); chasing mobs steer directly for 0.15–0.3 s when no token is
  left.
  Paths are re-planned every 0.75–1.25 s while chasing (sooner when the target moved a block), stuck detection
  (no progress for 2 s) drops the path.
* **Targeting**: throttled line of sight (voxel DDA against collision boxes every 10 ticks per mob, at once for a
  new target — Sensing cache),
  revenge on the attacker, creative / dead players ignored, a target unseen for 3 s beyond 16 blocks is lost.
* **Combat**: hurt rules exactly like the player (0.5 s: only bigger hits apply the difference), red overlay for
  0.5 s, knockback 0.4 (+ hop on the ground), panic 5 s for animals, death: drops at once (cooked meat when
  burning, player-only drops), 1 s tip-over (90°, spiders 180°) with the red overlay, then the poof particles
  and removal. Suffocation and cactus contact 1 damage, lava 4 + fire 15 s, fire 1/s, drowning (not undead).
* **Daylight burning** (zombies, skeletons — Mob.isSunBurnTick): sky light 15 at the eyes, daylight ≥ 0.8, not in
  water → random ignition (8 s), 1 damage/s, flames + smoke; skeletons flee into the shade (FleeSunGoal).
* **Difficulty**: mob melee / arrows / explosions on the player: easy min(a/2 + 1, a), normal a, hard ×1.5
  (Minecraft Player.hurt scaling, e.g. zombie 2.5 / 3 / 4.5); skeleton inaccuracy 14 − 4·difficulty, shot interval
  40 ticks (20 on hard), arrow base damage 2·power + gauss·0.25 + 0.11·difficulty; zombies with an iron sword /
  shovel 1 % (5 % hard). Peaceful: hostiles removed, none spawned (spawnMob refuses them).
* **Sounds** (`game.audio.play`, names resolved against audio.js `resolveSoundName` with fallbacks): ambient
  every 8–20 s (creepers silent), hurt / death per type, step sounds (zombie / skeleton / spider steps, the block
  step at 0.15 for animals), creeper hiss that follows the creeper and stops when it defuses / dies, bow_shoot,
  arrow_hit, arrow_hit_player (the shooter's ding), fizz when water extinguishes a burning mob, fall_small/big.
* **Sheep**: natural fleece colours (white 81.8 %, black / gray / light gray 5 %, brown 3 %, pink 0.16 %, tint =
  Sheep.createSheepColor), wool drop of that colour, EatBlockGoal (1/1000 per tick on grass: 40-tick head-down
  animation, grass → dirt or short grass eaten, block particles). Sheep are never sheared (no shears item) but
  the `sheared` render path is complete.

## Spawning (MobSpawner)
* `onChunkGenerated(cx, cz)`: 10 % of chunks (deterministic hash of the world seed and chunk) get a group of 2–4
  animals of one type (pig/cow/sheep/chicken weighted 10/8/12/10) on grass with sky access, persistent. The
  World fires it only on the first generation (remembered in storage), so groups are never duplicated.
* Passive: every 15–25 s a group of 2–4 on lit (raw light > 8) grass 24–80 blocks away while fewer than 10
  animals are within 96 blocks.
* Hostile: every 1 s (2 s on easy) 3 attempts at columns 24–64 blocks away, half at the surface, half in cave
  air pockets (first valid cell upward from a random height), solid opaque floor, body fits, block light ≤ 7 and
  sky·daylight ≤ 7 with Minecraft's randomised darkness test (sky > rnd·32 rejects, effective light ≤ rnd·8), groups
  of 1–3, cap 20 within 128 blocks.
* Despawn: hostiles beyond 128 blocks at once, beyond 32 blocks 1/800 per tick after 30 s; animals and egg /
  command mobs (`persistent`) never. Entities in chunks that are not meshed are frozen (not updated, not drawn);
  frozen hostiles still despawn by distance.

## Arrows (entities.js)
AbstractArrow: gravity 0.05 b/tick², drag 0.99 (0.6 in water, bubbles), per sub-step (≤ 1 tick) a swept point ray
against block collision boxes (no tunnelling) and entity boxes grown by 0.3 (the shooter only after 0.25 s, the
player included); hit damage `ceil(speed · base)` + crit bonus `rand(dmg/2 + 2)`, knockback along the flight,
`arrow_hit` sound; deflected arrows bounce back ×0.1. Block hit: stuck 0.05 before the hit point with a 7-tick
shake, stays 60 s, falls again when its block disappears. Survival player arrows on the ground are picked up
(player box + 1 / 0.5, fly-in + pop), creative shots vanish when a creative player touches them, skeleton
arrows stay. Rendered with Minecraft's ArrowRenderer geometry (two crossed planes + nock) and an original arrow
texture. Persisted (flying and stuck).

## Rendering (entityrenderer.js + mobmodels.js)
* **Models**: the Java LayerDefinitions exactly — QuadrupedModel (pig with its snout box, cow with horns and the
  udder on the body box, sheep + the SheepFurModel overlay inflated 0.6 / 1.75 / 0.5), ChickenModel (head, beak,
  wattle, body, legs, wings), HumanoidModel (zombie, 64×64 layout with mirrored left limbs; skeleton 2×12×2
  limbs), CreeperModel (4 legs), SpiderModel (head, neck, abdomen, 8 legs at the Minecraft angles). Box UVs
  with Minecraft's mirroring (ModelPart.Cube) and CubeDeformation inflation.
* **Poses**: LivingEntityRenderer (Ry(180 − bodyYaw) · death flip · S(−1, −1, 1) · T(0, −1.501, 0)), each
  model's setupAnim: walk cycles, head look, zombie arms (−π/2.25, −π/1.5 when attacking, swing + bob),
  skeleton BOW_AND_ARROW (and zombie-like arms without a bow), spider leg swing, chicken wing flap
  (Chicken.flap / flapSpeed), sheep eating (head lowered 9 px + the 28.7 rad/s nibble), creeper swelling
  (CreeperRenderer.scale incl. the sin(f·100) wobble) and white flashing (getWhiteOverlayProgress), hurt / death
  red overlay (OverlayTexture 0.3 red), held items through ItemInHandLayer (skeleton arm offset) with the
  bow's own third-person transform and the bow_pulling_0..2 frames while drawing.
* **Skins**: painted procedurally at startup (≈ 15 ms) into one 64×64×27 texture array (player, 8 mobs, fleece,
  arrow, 16 fire frames): original pixel art in Minecraft's style (pink pig with snout nostrils, brown/white
  cow with a blaze, muzzle, horns and udder, curly fleece, white chicken with orange beak / red wattle and
  1-texel legs (cutout), green zombie in a torn teal shirt, bone skeleton with ribcage, camouflage creeper with
  the face, dark hairy spider). Skin alpha 128..254 = emissive: the spider's eyes glow at night (shader flag).
* **Fire**: EntityRenderDispatcher.renderFlame — camera-facing stacked sheets (0.45 apart, ×0.9 narrower,
  alternately mirrored) with animated frames from Minecraft Alpha's procedural fire automaton, full-bright;
  burning mobs are lit by block light 15 and emit smoke.
* **Instancing**: every model part (77 skinned models) is its own instanced model; 40–150 mobs cost one draw
  per part kind in use (~50–65 draws) and ≈ 0.44 ms render CPU per frame.
* **Hand**: `useAction 'eat'` = applyEatTransform (food bobs at the mouth from the 1.6 s use) + applyItemArmTransform;
  `'bow'` = the drawn-bow pose (pull from `useTime` or `useProgress`, tremble at full draw) with the pulling
  frames. F5: the avatar shows BOW_AND_ARROW while drawing and flames when the player burns.

## Wave-2 rule changes in my files
* No `BLOCK.WATER / BLOCK.LAVA` comparisons left: items, mobs, particles (drips, specks, droplets, bubbles,
  ambient lava) use `LIQUID_KIND` + `liquidHeight` (every flowing / falling level, Minecraft surface heights).
* Items and mobs are pushed by currents (`world.fluids.flowVector(x, y, z, out)`).
* Falling blocks land with `canStay` (not `hasSupport`).
* Wall torches: ambient flames at Minecraft's wall-torch position (0.27 toward the wall, 0.22 higher); as falling
  blocks / items they are drawn as the floor torch (render type torch / base item).

## Verification
* `node --test tests/mobs.test.js` — 40 tests: falling + fall damage + chicken slow fall, walk speeds, path
  following around a wall and up a step, path finder (walls, lava, unmeshed chunks), swimming + current, spider
  climbing, freezing in unmeshed chunks, hurt cooldown / knockback / red flash, death animation / poof / drops
  (cooked when burning, wool, mutton), lava + water, zombie chase + difficulty damage + creative immunity, line of
  sight / 16-block sensing, daylight burning (night, shade, water, creepers immune), skeleton drawing + shooting +
  distance, creeper fuse / swell / explosion / defuse, creeper attacker for death messages, spiders neutral by day /
  hunting at night, peaceful, despawning, arrows (arc, sticking, shake, falling again, 60 s, no tunnelling through
  glass / mobs, damage formula, knockback, shooter grace, pickup), raycastEntities / countEntities, persistence
  (mobs, arrows, unregistered types), chunk-generation spawning (rate, determinism), hostile spawning (dark only,
  distance, cap, daylight, torches, peaceful, easy rate), passive spawning, sheep eating grass, canStay landing,
  item flow push, sound fallbacks, mob separation, model geometry (winding, UVs, painted texels, emissive eyes),
  poses (feet, facing, legs, death, swelling, eating, skeleton aim + bow in hand), fire sheets, bow power,
  first-person eat / bow poses, F5 bow pose, the shared render-item shape, random walk targets.
* Whole project `npm test`: green except the ART-pending texture tests (see the task notes).
* `tools/mob-test.html`: `view=line|poses|closeup|sheep|arrows|hand|live` (+ `time=night`, `walk=1`, `anim=1`,
  `mob=`, `face=`, `spin=1`, `use=eat|bow`, `p=`) — screenshots in `tools/out/mobs/` were all checked.
* Real game (headless Edge + RTX 4070, `tools/steps/mobs-*.json`): every mob placed in the world (day: undead burn),
  zombies chasing and hitting a survival player at night, creeper fuse → explosion crater + 玩家被苦力怕炸死了,
  skeleton drawing and shooting the player, real-input sword hits (knockback, panic), spawn egg, real-input bow
  draw (pulling frames) → arrow hits a cow (red flash, crit sparkles), animals from chunk generation, F5, 30 s of
  night spawning (14 hostiles, 9 in caves, 60 FPS). 0 console errors.
* Performance: 149 mobs (48 placed + chunk animals) at 60 FPS: update 0.35–0.39 ms, render 0.44 ms CPU per
  frame, 63–65 draws. Allocation (V8 sampling profiler, `node tools/entities-alloc.mjs --url
  "tools/mob-test.html?view=live&n=3&hud=0"`): static mob scenes ≈ 260 B/frame; 25 live mobs ≈ 1.4 KB/frame,
  mostly the doubles V8 boxes for the non-inlined `PhysicsBody.move` call (physics.js is shared) — a minor GC
  every few minutes.

## Known limitations / deliberate choices
* No breeding / babies / shearing / chicken eggs (no shears or egg items); tempting with wheat / seeds works.
* Zombies do not break doors, call reinforcements or convert to drowned; spiders have no jockeys; no charged
  creepers; no armour / equipment drops other than the held item.
* Path finding is grid A* with a fixed budget (no doors, fences, ladders); very wide mobs (spiders) may get stuck
  in 1-wide corridors and then climb or wait.
* Mob-vs-player pushing is one-way per frame (the player is pushed by the manager, not by player.js).
* Arrows do not stick visibly in mobs / the player; burning arrows do not exist.
