# Entities agent notes — entities.js, particles.js, entityrenderer.js

> Wave 2 (mobs, arrows, mob rendering, liquid helpers, raycastEntities / spawnArrow / countEntities, the
> first-person eat / bow poses) is documented in `docs/notes/mobs-wave2.md`; this file describes wave 1.

Files: `src/game/entities.js`, `src/game/particles.js`, `src/render/entityrenderer.js`; tests in
`tests/entities.test.js` (51 tests); visual page `tools/entity-test.html`; simulation benchmark
`tools/entities-bench.mjs`; per-frame allocation probe `tools/entities-alloc.mjs` (Edge + V8 sampling heap
profiler). SPEC §9.5 (+ the third-person player model used by game.js for F5).

## Public API (SPEC §9.5 + additive extras)

```js
// src/game/entities.js
export class EntityManager {
  constructor(game, { rng } = {})            // game: world, player, audio, particles, interaction, perspective (read lazily)
  spawnItem(stack, x, y, z, vx, vy, vz, pickupDelay = 0.5) -> ItemEntity | null   // SPEC (null for invalid input)
  update(dt); getRenderList(out) -> out; clear(); count                             // SPEC
  // extras
  list / entities                            // live entities (array, spawn order)
  add(entity) -> entity                      // any Entity subclass (mobs later)
  popItem(itemId, count, cx, cy, cz, delay?) // Minecraft Block.popResource from the block centre (splits stacks)
  dropFromPlayer(stack, player = game.player)// Minecraft Player.drop throw (2 s pickup delay)
  spawnFallingBlock(blockId, x, y, z)        // FallingBlockEntity at the centre-bottom (caller removes the block)
  spawnPrimedTnt(x, y, z, fuse = 4, { sound = true })
  explode(x, y, z, power = 4, { breakBlocks = true, source, dropChance }) -> destroyed block count
  anyEntityInBox(box) -> bool                // entities with blocksBuilding (not items) — used by interaction.js
  getEntitiesInBox(box, out = [], filter)
  serialize() -> array; deserialize(array)   // items / falling blocks / TNT (for world saves)
  avatar                                     // PlayerAvatar of game.player (third-person model, see below)
}
export class Entity { id, type, body: PhysicsBody, age, removed, light, blocksBuilding, shadowRadius,
  shadowStrength, x/y/z/vx/vy/vz, update(dt, game), getRenderItem(), hurt(amount, cause), push(vx, vy, vz),
  remove(), getAABB(out), updateLight(world), updateShadow(world), serialize() }
export class ItemEntity, FallingBlockEntity, PrimedTntEntity
export class PlayerAvatar { update(dt, player, world, attacking); getRenderItem(player, hand); reset() }
// constants: ITEM_DESPAWN_TIME 300, PICKUP_RADIUS 1.5, COLLECT_TIME 0.15, MAX_ITEM_ENTITIES 6000, SOFT_ITEM_CAP 2048, ...

// src/game/particles.js
export class ParticleSystem {
  constructor(game, { capacity = 4096, seed, ambient = true } = {})
  spawnBlockBreak(x, y, z, blockId); spawnBlockHit(x, y, z, face, blockId, count = 2)
  spawnSplash(x, y, z, width = 0.6); spawnSmoke(x, y, z, count = 8); spawnExplosion(x, y, z, power = 4)
  // extras
  spawnBubble(x, y, z), spawnItemBreak(itemId, x, y, z, count = 5), spawnTorchFlame(x, y, z),
  spawnLavaPop(x, y, z), spawnDrip(x, y, z, lava), spawnUnderwaterSpeck(x, y, z), animateTick(x, y, z)
  update(dt); getRenderData() -> { count, data }; clear(); count; capacity; ambient
}
export const PARTICLE_STRIDE = 12, PROCEDURAL_LAYER = 255, FULL_BRIGHT = 255,
  STYLE = { SMOKE, EXPLOSION, DROPLET, BUBBLE, FLAME, LAVA, DRIP, SPECK }
export function particleLayerFor(blockId), particleColorFor(blockId)

// src/render/entityrenderer.js
export class EntityRenderer {
  constructor(gl, textureArray, { textureData, layers } = {})   // options are optional (see below)
  renderEntities(ctx, items); renderParticles(ctx, particles); renderHand(ctx, hand); dispose()
  stats                                       // { drawCalls, instances, particles, spriteModels }
  supportsPlayerModel = true                  // game.js enables F5 only when this is set
}
// pure helpers (tested): buildSpriteModel(alpha), buildCubeModel(), buildBoxModel(...), buildArmModel(),
// computeHandPose(m, hand, kind), computePlayerPose(item, rx, ry, rz, parts, held, heldKind), PLAYER_PARTS,
// renderAmount(count), paintSkinTexture()
```

### EntityRenderItem (as produced by getRenderList)
* `{ kind: 'item', x, y, z, itemId, count, age, seed, light }` and `{ kind: 'block', blockId, x, y, z, scale, light,
  flash }` exactly as in SPEC, plus three **additive optional** fields: `shadowY` (top of the block receiving the
  shadow), `shadow` (alpha, 0 = none), `shadowRadius`. Items without them simply get no shadow. `'block'` items keep
  their bottom at `y` when scaled (primed TNT swells upward instead of into the ground).
* `{ kind: 'model', model: 'player', x, y, z, bodyYaw, headYaw, headPitch, limbSwing, limbSwingAmount, attack,
  sneaking, age, hurt, death, light, itemId, shadowY, shadow, shadowRadius }` — the local player, appended by
  `getRenderList` only while `game.perspective > 0` (F5). Angles use the SPEC §4 convention (radians, yaw 0 =
  north); `death` = seconds since death (tip-over), `hurt` > 0 = red overlay. Same shape as SPEC-wave2's mob items
  (`model: '<mobType>'`), so wave 2 only adds geometry/skins.

### Particle data (stride 12)
`x, y, z, size (quad edge, blocks), layer, u0, v0, uvSize (texels), r, g, b, light (packed)`.
* Textured (layer < 255): a `uvSize`×`uvSize` texel window at (u0, v0); `r,g,b` = colour multiplier; texels with
  alpha < 0.5 are discarded.
* Procedural (layer 255): `u0` = style (0 smoke, 1 explosion, 2 splash droplet, 3 bubble, 4 torch flame, 5 lava
  pop, 6 drip, 7 underwater speck), `v0` = phase 0..1 (age / lifetime), `uvSize` = per-particle seed; `r,g,b` =
  colour; drawn as pixel art in the shader.
* `light` 255 = full bright (explosions, flames, lava).

## Minecraft behaviour reproduced

Per-tick constants are converted to seconds and integrated in sub-steps of at most one tick (frame-rate
independent; tested at 20/60/144 fps).

* **ItemEntity** (0.25×0.25 PhysicsBody): gravity 0.04 b/tick² (16 b/s², terminal ≈ 39 b/s), drag 0.98/tick,
  ground friction `slipperiness·0.98` per tick (≈0.7 blocks of slide on stone, ≈7.5 on ice), random pop
  (±0.1, 0.2, ±0.1 b/tick) when spawned without a velocity, `moveTowardsClosestSpace` when inside a solid block
  (N/S/W/E/up, the closest open side, 0.1–0.3 b/tick, no collision while stuck), floats when submerged deeper
  than 0.1 (no gravity, +0.0005 b/tick² while slower than 0.06 b/tick → slow rise and gentle bobbing at the
  14/16 surface), horizontal drag 0.99 (water) / 0.95 (lava), splash particles + sound when falling into water,
  burns in lava (2 ticks, smoke), destroyed by cactus contact (5 ticks), destroyed / pushed by explosions,
  despawn after 300 s, removed below y = −64, `light = world.getLight(floor(x), floor(y + 0.1), floor(z))`.
  Resting items sleep and only re-check their support every 4 ticks (cheap with thousands of drops).
* **Pickup**: player alive, delay elapsed, item centre within 1.5 blocks of the player's axis horizontally and
  within the player box grown by 0.5 vertically. `inventory.add(stack)` returns the leftover → only what fit is
  taken; the taken part flies into the player — to `(feet + eyes) / 2`, over 3 ticks with an ease-in, i.e.
  Minecraft's ItemPickupParticle (this is the "magnet"; Java items are not attracted before pickup) — then
  disappears. Partial pickups leave the rest on the ground and send a ghost copy of the taken part. Creative
  players swallow items that do not fit (Minecraft `Inventory.add`). `pop` sound: volume 0.2, pitch
  `((r − r)·0.7 + 1)·2` clamped to [0.5, 2] (Minecraft's sound engine clamp); one pop per frame at most.
* **Merging** (`mergeWithNeighbours`): every 2 s, or 0.1 s after crossing a block border; boxes inflated by
  0.5 on x/z must intersect, same id + damage, both stackable and combined ≤ max stack; the larger stack
  absorbs the smaller (pickup delay = max, age = min). A spatial hash keeps it O(n).
* **Render** (`ItemEntityRenderer`): bob `sin(age·2 + φ)·0.1 + 0.1`, spin `age + φ` (φ = seed·2π), "ground"
  display transforms (blocks: +3 px, scale 0.25; generated sprites: +2 px, scale 0.5), copies per
  `getRenderAmount` (2 > 1, 3 > 16, 4 > 32, 5 > 48 — SPEC said 1–2 extra copies; Minecraft's thresholds used):
  block copies scatter ±0.15, sprite copies stack 1.5 px apart with ±0.075 jitter, offsets seeded by item id.
  Cube-like block items (cube, cactus, liquid render types) are cubes with per-face layers; cross / torch blocks
  and all other items are extruded sprites (Minecraft `item/generated`).
* **Shadows** (`EntityRenderDispatcher.renderShadow`): items radius 0.15 / strength 0.75, TNT, falling blocks and
  the player 0.5 / 1.0, drawn on the top of the full block in the cell under the feet (or the one below), alpha
  `(strength − height / 2)·0.5`, scaled by the cell's brightness, fogged.
* **FallingBlockEntity** (0.98³): gravity 0.04, drag 0.98, lands in its cell if replaceable + supported,
  otherwise drops as an item; safety removal after 30 s / below −64. Wired by game.js through
  `world.onFallingBlock` (sand / gravel).
* **PrimedTntEntity**: hop (random ±0.02, 0.2 b/tick), 80-tick fuse, friction 0.7 + bounce −0.5 on the ground,
  white flash every other 5 ticks (75 % white = Minecraft's overlay u=15), swelling during the last 10 ticks,
  explodes with power 4 at y + h/16.
* **Explosion** (`Explosion.explode`): 16³ surface rays, intensity `power·(0.7..1.3)`, 0.3-block steps losing
  `(resistance + 0.3)·0.3` (+0.225 per step); Minecraft blast resistances (stone family 6, planks 3, ores 3,
  obsidian 1200, liquids 100, bedrock ∞) — under water nothing breaks; drops with chance 1/power harvested as
  with the right diamond tool (stone → cobblestone); TNT in range is primed with a 10–29 tick fuse (chain
  reaction); entities and the player within 2·power take `(i² + i)/2·7·2p + 1` damage (cause `'explosion'`,
  Chinese death message 玩家爆炸了 exists in player.js) with exposure from the getSeenPercent ray grid and
  knockback; items close to the centre are destroyed (≥ 5 damage); sound `explode`, `spawnExplosion` particles.
* **PlayerAvatar** (LivingEntity / WalkAnimationState): limb swing from the horizontal distance walked (eased 0.4
  per tick), body yaw that follows the walking direction (walking backwards keeps facing forward), lags the head
  by at most 75° and is pulled along beyond 50°, turns to the head while the arm swings; light at the eyes.
* **Particles**: terrain particles exactly like `TerrainParticle` (velocity rule, +0.1 b/tick up, gravity 1,
  drag 0.98, ground friction 0.7, size 0.1–0.2, random 4×4 texel window, colour ×0.6, block tint by §5.3:
  OPAQUE-layer blocks untinted, others tinted with DEFAULT_TINTS); lifetime: Minecraft's distribution
  (4/(r·0.9 + 0.1) ticks) mapped linearly onto the SPEC's 0.4–1.5 s; block break = `ParticleEngine.destroy`
  grid over the selection box (64 for a full cube, 12 for a torch); hit = `crack` (0.1 outside the hit face,
  power 0.2, scale 0.6; 2 per call because interaction.js calls every 2 ticks); splash = droplets (0.1–0.3
  b/tick up, gravity 0.06, die when falling back into water) + bubbles (rise, pop when leaving water); smoke
  (dark grey, rises, shrinks); explosion = 8-tick emitter of 6 big full-bright puffs per tick within ±4 blocks
  + white "poof" puffs. Crude collision: a particle never enters a cell that has a collision box (axis by axis).
* **Ambient display ticks** (`ClientLevel.animateTick`, 20 Hz around the player's eyes, 2 × 667 random blocks
  within ±16 / ±32): torches → flame (full bright) + smoke wisp at (x+0.5, y+0.7, z+0.5); lava with air above →
  1/100 lava pop trailing smoke; liquid on a full solid block over open space → 1/10 drip that hangs 2 s, falls
  and splats; still water under water → 1/10 underwater speck. `ambient: false` disables them; off while dead.
* **Particle texture choice**: a side face (+Z) of the block; for placement variants (sideways logs, rotated
  furnaces) the base block's face (bark, furnace front); tint-mask textures (grass) fall back to the bottom
  face (dirt) — exactly Minecraft's grass-block particle texture, and the only way to honour §5.3 per texel.
* **Light of fresh break particles**: the broken cell still reports the opaque block's light (0) until the world
  relights it, so break particles take the max of the 6 neighbours; later light samples of 0 are ignored.

## Rendering design (entityrenderer.js)

* **Instanced**: one static model VBO (cube, inset cactus box, cross, torch post, the six Steve model parts, and one
  extruded model per sprite layer, built lazily) + one dynamic instance buffer. Per instance: 3×4 camera-relative
  model matrix (computed in float64 on the CPU → no precision loss far from the origin) + packed uvec4 (6 face
  layers, UV-rotation bits, alpha mode, tint, flash + flash colour, light). Instances are bucketed by model with a
  counting sort; one `drawArraysInstanced` per model in use (typically 10–30 per frame), translucent cubes (ice,
  water) in a second blended draw, then shadows. No per-frame allocations once buffers have grown.
* **Extruded sprites** (ItemModelGenerator): front + back quads (texel u → +x on both, so edges line up) and
  one 1/16-thick edge quad per maximal run of boundary texels, UVs pinned to the texel centre across the
  thickness. The sprite alpha comes from a **one-time GPU read-back** of the whole texture array (one
  texelFetch pass into a 256×H RGBA target + one readPixels at construction, ~4 ms; verified identical to
  generateTextures() alpha) because the Renderer passes only `(gl, textureArray)`. If an optional
  `{ textureData }` (generateTextures().data) is given the read-back is skipped; if the read-back fails the
  sprites degrade to flat double-sided quads.
* **Shading**: the canonical `GLSL_LIGHT` imported from shaders.js (bit-identical lightColor), §5.3 rules per
  instance mode (opaque/tint-mask `rgb·mix(tint,1,a)`, cutout `a<0.5` discard, translucent blend), directional
  shade `n.x²·0.6 + n.z²·0.8 + n.y²·(1 | 0.5)` = FACE_SHADE for axis-aligned faces, continuous while items spin;
  plants / torch unshaded 0.9 like the mesher; linear fog with ctx.fogColor/fogStart/fogEnd. The texture object's
  own filtering (NEAREST / NEAREST_MIPMAP_LINEAR) is used: the Renderer unbinds its terrain sampler first.
* **Player model** ('model' kind): Minecraft PlayerModel boxes (wide arms) with the classic box-UV layout on a
  procedural 64×64 Steve skin (same palette as the UI's player preview: skin #C68E68, cyan shirt #16A3A8, blue
  pants), PlayerRenderer scale 15/16, HumanoidModel.setupAnim (walk cycle, head look, ArmPose.ITEM, attack swing,
  crouch, idle arm sway), death tip-over and a 30 % red hurt overlay; the held item via ItemInHandLayer + the
  `thirdperson_righthand` display transforms (block / handheld / generated).
* **Hand** (ItemInHandRenderer, verbatim pose chains): HandState bob (`translate(bobX, bobY)`,
  `rotZ(−bobRoll)`, `rotX(−bobPitch)` = Minecraft bobView) and turn sway (`rotX(−swayPitch)`, `rotY(−swayYaw)`);
  empty hand = `renderPlayerArm` (+ PlayerModel right arm pivot (−5, 2, 0) px, zRot 0.1 from bobModelPart) with the
  Steve skin; items = swing offset + `applyItemArmTransform` (equip lowers by 0.6) + `applyItemArmAttackTransform`
  + the display transform (`block.json` firstperson_righthand: rotY 45°, scale 0.4; `item/generated`/`handheld`:
  translate (1.13, 3.2, 1.13) px, rotate (0, −90, 25), scale 0.68). Own projection: fov 70°, near 0.01,
  depth cleared first; view-space normals for shading so the held item looks the same wherever you look.
* **Particles**: one instanced draw straight from the stride-12 data (camera-facing quads using ctx.camRight /
  camUp, camera split into integer + fraction for precision). Procedural styles are pixel-art (8×8 smoke,
  16×16 explosion ball with a dissolving pattern, 4×4 droplet, 8×8 bubble ring, flame, lava blob, drip, speck)
  and alpha-tested like the textured ones, so particles need no sorting and no blending.
* GL state: every pass sets what it needs (depth, cull, blend, polygon offset for shadows); the Renderer restores
  its own state after the hooks. Context loss: the Renderer constructs a new EntityRenderer after restoration.

## Verification

* `node --test tests/entities.test.js` — 51 tests: falling/resting, terminal velocity, frame-rate independence,
  random pop, stone vs ice friction (Minecraft distances), push-out of solid blocks (closest side), floating in
  water (rise + bobbing below the surface), splash + lava burn, cactus kills, despawn at 300 s, void, frozen in
  unloaded chunks, light sampling, pickup (delay, inventory, pop sound, fly-in path to (feet + eyes)/2, exactly
  once), pickup reach geometry, partial pickup + ghost, creative swallow, dead players, merging rules (radius,
  ids, damage, max stack, unstackables, heights), render items (fields, reuse), shadows, validation, popItem /
  dropFromPlayer, anyEntityInBox, custom subclasses, item cap + storm coalescing without loss, serialize round
  trip, falling blocks (land / drop), TNT (flash, swell, crater, damage, knockback, chain), blast resistance,
  particles (break grid counts, data layout + §5.3 colour + light, neighbour light, hit faces, lifetimes,
  collision, fixed pool + buffer reuse, procedural styles, bubbles, ambient display ticks), renderer geometry
  (CCW winding of every model, sprite edge runs and UVs, getRenderAmount, hand poses, skin layout, player pose)
  and the player avatar. Whole project: `node --test tests/*.test.js` 342/342.
* `tools/entity-test.html` (own WebGL2 context, real texture array from textures.js): `view=scene|items|hand|
  handgrid|helditems|player|night|cave|ambient`, `hand=empty|block|pickaxe|sword|torch|flower|stick|<item>`,
  `swing`, `equip`, `t`, `time`, `particles=0`, `live=1` (real EntityManager + ParticleSystem incl. a TNT that
  explodes; `items=<n>`, `perspective=1`), `anim=1`, `ground=0`, plus `window.__bench(n, mult)` and
  `window.__allocLoop(n)` (`probe=manager` renders only the manager's list). handgrid / helditems need 2400×810
  for 16:9 cells.
  Screenshots checked: tools/out/ent2/*.png. 0 console errors in every view.
* Real game (`index.html?autostart=1&seed=42`, steps in tools/out/ent2/real-steps.json): drops of every kind on the
  ground, falling sand/gravel landing, walking over drops (46 items picked up), Q throws merging into one stack,
  F5 front view (Steve holding the selected block), TNT fuse flash, chain-primed TNT thrown by the blast, crater
  with drops — 0 console errors.
* Performance (RTX 4070 / Edge; Node 22 for simulation): renderEntities + renderParticles + renderHand CPU
  0.07 ms for ~500 entities (385 instances, 30 draws), 0.18 ms for ~3 900, 0.45 ms for ~11 800 (9 240 instances);
  EntityManager.update 0.31 ms for 1 000 falling items, 0.16 ms for 3 000 resting ones; ParticleSystem.update +
  getRenderData 0.31 ms for a full 4 096 pool, ambient display ticks 0.02 ms/frame. Allocation: see the section
  below. EntityRenderer construction ≈ 50 ms (shader compilation dominates; read-back ≈ 4 ms), once per context.

## Integration (as wired in src/game.js)

```js
import { EntityManager } from './game/entities.js';
import { ParticleSystem } from './game/particles.js';
import { EntityRenderer } from './render/entityrenderer.js';
renderer = new Renderer(canvas, { textures, misc, EntityRendererClass: EntityRenderer, buildMipChain, alphaModes });
// world start
game.entities = new EntityManager(game);
game.particles = new ParticleSystem(game);
new World({ ..., onDropItem: (id, n, x, y, z) => game.entities?.popItem(id, n, x, y, z),        // block centre
  onFallingBlock: (id, x, y, z) => !!game.entities?.spawnFallingBlock(id, x + 0.5, y, z + 0.5) });
// loop (playing, not paused), after player/interaction/ticks:
game.entities.update(dt); game.particles.update(dt);
// frame
f.entities.length = 0; game.entities.getRenderList(f.entities);   // what game.js does (SPEC form); recommended:
frame.entities = game.entities.getRenderList();   // manager-owned array, no per-frame regrowth (see below)
frame.particles = game.particles.getRenderData();
frame.hand = perspective === 0 && !hudHidden && !player.dead ? interaction.getHandState() : null;
// F5: game.perspective = 0 | 1 | 2 — the manager appends the player's 'model' item while it is > 0
// unload: entities.clear(); particles.clear();
// save: meta.entities = entities.serialize();   load (once the spawn area exists): entities.deserialize(meta.entities)
```
* **TNT** (`interact: 'tnt'` reaches `game.onInteractBlock`): with flint and steel →
  `world.setBlock(x, y, z, 0); entities.spawnPrimedTnt(x + 0.5, y, z + 0.5); inventory.damageItem(slot, 1);`
  return true; otherwise return false so the held block gets placed. Explosions use `world.setBlock`,
  `player.damage(n, 'explosion')`, player `vx/vy/vz` knockback, `audio.play('explode' | 'fuse')`.
* **Tool breaking**: interaction.js calls `particles.spawnItemBreak(itemId, x, y, z)` in front of the eyes next to
  the `break_tool` sound.
* `entities.count` / `particles.count` feed the F3 overlay. Entities in chunks reported unloaded by
  `world.isChunkGenerated(cx, cz)` are frozen instead of falling through the void.
* Audio names used: `pop`, `splash`, `fuse`, `explode` (all in the SPEC list); `playBlock('place', …)` when a
  falling block lands.
* Persistence: game.js stores `entities.serialize()` (items, falling blocks, lit TNT) in the world meta and
  restores it with `deserialize` — wave-2 mobs can extend `serialize()` / `deserialize()` by type.

## Per-frame allocations (V8) — rules for whoever extends these files

Measured with V8's sampling heap profiler (`tools/entities-alloc.mjs`, in Edge; `tools/entities-bench.mjs`, Node):
* renderEntities writes instance matrices with inline math and passes only small integers / typed arrays to
  helpers (V8 boxes a fractional number passed to a function it does not inline — one heap allocation per call);
  stack-copy offsets are precomputed per item id; uniforms go through `uniform*fv` from scratch arrays; frustum
  planes avoid `Math.hypot`; the player pose is computed at the origin and offset afterwards. Visual output was
  verified pixel-identical across all test views. Edge, manager-only scene of ~110 entities + the avatar + hand +
  particles: from ≈10 KB/frame (static test scene) / 3.5 KB/frame down to ≈1 KB/frame; what remains is JIT-tier
  dependent (Node: renderEntities ≈ 10 B/frame), plus ≈135 B/frame in the once-per-frame hand pose.
* **Hidden classes**: numeric fields that will ever hold fractional values are created as doubles (`DZ = -0`
  in entities.js, then the real value). A field created with integer `0` is rewritten on its first fractional
  store (new hidden class, old one deprecated); when that happens while the renderer already reads these objects
  its property accesses go megamorphic and every read of a double field allocates, forever. The render items now
  have exactly three hidden classes (item, block, model). Mob render items (wave 2) should follow the same rule.
* `EntityManager.update` clamps `dt` with a conditional (not `Math.min`) so the caller's number is passed on to
  every `entity.update(dt, game)` without re-boxing.
* Event-driven code (block break bursts, explosions) allocates in V8's lower tiers by nature; it is not per frame.
* The SPEC form `list.length = 0; getRenderList(list)` makes V8 regrow the array every frame (≈4 B per entity per
  frame); `getRenderList()` without an argument reuses a manager-owned array and allocates nothing.

## Known limitations / deliberate choices

* Only the player uses the `'model'` kind; mobs (wave 2) add their geometry/skins next to `PLAYER_PARTS`.
* Fluids have no flow yet, so items are not carried by currents (wave 2 adds `flowVector`). Item–player
  collisions are not simulated (items do not push the player). Liquids are detected with `BLOCK.WATER` /
  `BLOCK.LAVA` because the wave-2 liquid helpers do not exist yet.
* Shadows are one disc per entity at the receiving block's height (Minecraft clips per block, which only
  matters for wide shadows hanging over an edge).
* Translucent item cubes are blended without sorting (only ice / water items; copies of one stack can
  overlap in the wrong order).
* Above 2 048 items, drops landing in the same 4×4×4 cell during one frame coalesce into one stack (no items
  lost); beyond 6 000 items the oldest are discarded — protects the frame rate from `/fill … destroy`.
* The empty-hand arm and third-person model are Steve's (wide) model; no skin choice. The first-person hand has
  no hurt tilt (HandState carries none); the camera itself tilts.
