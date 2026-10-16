# World agent — wave 2 notes (liquids, shapes, support rules, random ticks, review fixes)

Files: `src/world/fluids.js` (new), `src/world/{world,blockupdates,mesher,lighting,storage}.js` (changed;
`chunk.js` / `worker.js` unchanged). Tests: `tests/fluids.test.js` (15), `tests/mesher-shapes.test.js` (6),
`tests/world-wave2.test.js` (8), `tests/world-review.test.js` (9), updated `tests/mesher.test.js` /
`tests/world.test.js`. Harness: `tools/fluids-helpers.js` + `tools/steps/fluids-{pour,scenes,channel,shapes,
slopes,stress,obsidian,shore}.json`, `tools/steps/world-snapshot-reload.json` (screenshots in `tools/out/w2/`), e.g.
`node tools/harness.mjs --url "index.html?autostart=1&seed=42&mode=creative" --wait-for window.__ready --steps tools/steps/fluids-pour.json`.

Verified in the real game (headless Edge, RTX 4070): a real right click with a water bucket makes the exact
Minecraft diamond (1/4/8/…/28 cells per level = 113) and scooping it dries everything; waterfalls from towers and
fountains; a river channel opened with a real left click fills with levels 1→7 and pours into a pit as a falling
column; obsidian in a cobblestone ring from a real bucket click onto a lava pit; cobblestone walls where water meets
flowing lava; lava pouring from a natural cave lake into a new tunnel; 25 water + 4 lava sources on a 64×64 platform
(14 k updates, then a full drain of 36 k) at a constant 60 fps (max frame 17 ms, world update 0.85 ms/frame).

## API (additions; nothing removed)

```js
// fluids.js
new FluidSimulator(world, { onDropItem, onEffect, isAreaLoaded, rng, maxUpdatesPerTick = 4096, budgetMs = 2 })
  .schedule(x, y, z, delay) / .isScheduled / .neighborChanged(x, y, z) / .tick() / .dropChunk(cx, cz)
  .scanChunk(cx, cz, blocks, maxY) / .clear() / .pending / .counters / .stats()
  .flowVector(x, y, z, out) or .flowVector(world, x, y, z, out)          // both call forms work
flowVector(world, x, y, z, out = [0,0,0]) -> out                       // Minecraft BlockLiquid.getFlow, normalized
canFlowInto(id), BLOCKS_FLUID, TICK_DELAY [0,5,30], LEVEL_STEP [0,1,2], SLOPE_DISTANCE [0,4,2], KIND_WATER/LAVA
// world.js
new World({ ..., onEffect(name, x, y, z), onBlockPopped(id, x, y, z), fluidBudgetMs = 2 })   // also settable later
world.fluids                                  // the FluidSimulator (entities: world.fluids.flowVector(x, y, z, out))
world.onChunkGenerated(fn(cx, cz)) -> unsubscribe   // first generation only (persisted), queued until a listener exists
world.isAreaLoaded(x, z, r)                   // every chunk within r blocks has its blocks
world.saveSnapshot(meta = null) -> Promise<{chunks}>   // atomic, synchronous-start save (pagehide-safe)
world.destroy({ save = true } = {})           // a failed final save leaves the world usable (rejects)
world.stats().pendingFluids / .fluidUpdates
// blockupdates.js
new BlockUpdater(world, { onDropItem, onFall, onBlockPopped, fluids, rng, budget }); .changed(x, y, z); .pop(x, y, z, { effects })
// storage.js
storage.saveWorldData(worldId, name, value) / loadWorldData(worldId, name)      // small per-world records
storage.saveSnapshot(worldId, meta, chunks, data) (= saveAllSync)              // ONE transaction, commit()
storage.acquireWorldLock(worldId) -> { release(), supported } | null           // Web Locks (null: held elsewhere)
storage.requestPersistence() -> boolean                                        // navigator.storage.persist()
```

## Liquids (SPEC-wave2 §5.1) — `fluids.js`

Port of Minecraft 1.12 `BlockDynamicLiquid.updateTick` with the 1.13+ lava/water interactions:
* Levels: 0 source, 1..7 flowing, 8 falling (registry `LIQUID_LEVEL`). Water ticks every 5 game ticks, lava every 30;
  step 1 / 2 (water spreads 7, lava 3 blocks); drop search 4 / 2 blocks.
* Non-source cell: min level of the horizontal same-liquid neighbours (falling counts as 0) + step; >= 8 or none → dries
  (air). Same liquid above → falling. Water with ≥ 2 horizontal sources over a solid block or a water source → source
  (infinite water). Receding lava waits ×4 with p = 3/4.
* Spreading: down first (as falling); otherwise sources, and flowing/falling liquid standing on something that stops
  liquids, spread sideways (falling → level 1) toward the nearest drop within 4 (lava 2) blocks, all directions when
  none (Minecraft `getPossibleFlowDirections` / `getSlopeDistance`, same tie rules and N-E-S-W order).
* Liquids flow into air and non-solid blocks: plants, torches (also wall torches), crops, mushrooms are washed away with
  their drops (`getDrops`, e.g. short grass → 12.5 % seeds, young wheat → 1 seed). Lava burns them (fizz, no drops).
  Solid blocks and **sugar cane** stop liquids (Minecraft's REEDS exception — cane farms work as in Minecraft).
* Lava with water above or beside it: source → obsidian, flowing/falling → cobblestone (1.13+: every non-source
  level); lava flowing down into water → stone; each fires `onEffect('fizz', centre)`. Water never flows into lava;
  lava never flows sideways into water (1.13+). Lava checks happen immediately on neighbour changes.
* Scheduling: ticks are scheduled when a liquid is placed or any of its 6 neighbours changes (BlockUpdater), de-duplicated
  per cell (keeps the earlier tick). Ring of 256 tick buckets + carry list; per tick at most 4096 updates and 2 ms
  (`fluidBudgetMs`), leftovers run first next tick. Cells whose neighbourhood (slope distance + 1) is not loaded are
  deferred by 20 ticks. Unloading a chunk drops its ticks; chunks loaded from storage (or the unload buffer) are
  scanned: flowing/falling cells and sources next to air/washable blocks (in loaded chunks) are re-scheduled.
  Generated terrain is static until disturbed (no scan for generated chunks).
* Cost: 2.6–5 µs per update in Node (merged-flood benchmark: 35 k updates in 181 ms; drain 57 k in 152 ms).

## Rendering (SPEC-wave2 §5.2, §5.3) — `mesher.js`, `lighting.js`

* Liquids: every corner height is Minecraft's `getFluidHeight` average of the 4 cells around the corner (source
  weight 11 at 8/9, flowing L weight 1 at 1−(L+1)/9, non-solid non-liquid cells weight 1 at 0, solid ignored, full
  height when one of them is falling or has the same liquid above), quantised to 1/16 with a 1/16 minimum. Every cell
  around a corner computes the same value → seamless surfaces between levels and across chunks (tested on random
  puddles meshed as two chunks). Top face sloped (planar u/v); side faces toward non-same-liquid, non-opaque cells
  follow the corner heights with `v = 16 − h` (texels match the trapezoid); the top is drawn under opaque blocks too
  (visible through the gap, like Minecraft); the old "2/16 strip" hack is gone. Lone source in a hole 14/16, lake
  14/16, lone source in the open 11/16 (Minecraft-exact). anim 3, no AO, surface light max(above, own).
* Chest: 1..15 × 0..14 × 1..15 px box, each face shows its whole 16×16 texture (uniform 14/16 scale), front by facing
  (the horizontal face whose texture differs), a 2×4×1 px latch at px 7..9 × 7..11 in front (texels u 7..9 / v 4..8 of
  `chest_front` — lines up with the ART agent's painted latch), own-cell light, directional shade, no AO; latch hidden
  when an opaque block is in front, bottom culled on opaque ground.
* Crop: Minecraft's crop model — planes at 4/16 and 12/16 on X and Z, from −1/16 to 15/16 (stands on 15/16 farmland),
  double-sided with the back mirrored like a card, face 6, own light, anim 1 on top vertices.
* Farmland: top at 15/16 (lit + AO from the layer above like a full top), dirt sides v 1..16 culled by opaque blocks
  and other farmland, bottom culled by opaque blocks; cubes below farmland skip their hidden top face.
* Wall torches (`WALL_FACE >= 0`): the floor-torch post sheared 4 px over its 10 px height away from the wall (21.8°;
  a 22.5° rotation is not representable on the 1/16 vertex grid), base centred on the wall surface at 3/16, top at
  13/16, rotated per facing (orientation-preserving → CCW kept). Floor torches unchanged.
* Lighting: farmland blocks light like Minecraft (opacity 255: caves under fields stay dark) but stores the max of its
  6 neighbours per channel afterwards (Minecraft `useNeighborBrightness`), so it renders lit and is a neutral sample.
  Flowing water/lava inherit water's filter 1 / lava's emission 15 from the registry variants.
* Geometry may extend 1 px outside its cell (crop bottoms, wall-torch bases) — within SPEC §7's p ∈ [−1, 30]; the
  fuzz test bounds were widened accordingly.
* Mesh time unchanged: `node tools/mesher-bench.mjs --worldgen` worst surface chunk 2.7 ms median (budget 25).

## Support rules, block updates, random ticks

* `blockupdates.js`: every change checks the cell and its 6 neighbours (cascading through the same queue); registry
  `canStay` everywhere (floor support, wall torches' block behind, cactus without solid neighbours, sugar cane with
  water next to its ground); additionally a cactus breaks with lava beside it or liquid above it (Minecraft
  `CactusBlock`). Farmland under a solid block → dirt. Liquids → `fluids.neighborChanged`. Floating gravel/sand falls when
  a neighbour changes (review WORLD-2). `onBlockPopped(id, x, y, z)` for break effects (review AUDIO-2).
* `world.setBlock`: a liquid appearing/vanishing also re-checks the 4 cells diagonally above (sugar cane whose water was
  scooped pops immediately); removing a log marks leaves within 4 blocks as decay candidates.
* Random ticks (3 per section, unchanged rate): wheat grows with Minecraft probability `1 / (floor(25 / f) + 1)`
  (`getGrowthChance`: moist farmland around ×3, rows halve it) when light ≥ 9 above (1.12: with sky darkening), and pops
  without farmland; farmland becomes moist with water within ±4 (same y or +1), moist dries with p = 1/7 per tick
  (Minecraft's 7-step moisture), dry without crop → dirt; plants (flowers, grass, mushrooms, saplings, cane, cactus)
  re-check `canStay` (Minecraft BlockBush); leaves decay (below).
* Leaf decay (review WORLD-3 / SURV-2): leaves within 4 blocks of a removed log (and neighbours of decayed leaves)
  become candidates; a candidate's random tick runs a bounded BFS (6 steps through leaves, preallocated typed arrays)
  and decays it (loot: saplings/apples, no effects) if no log is reachable — only once the 13×13 area is loaded.
  Player/command-placed leaves are remembered as persistent and never decay; leaves grown from saplings are natural.
  Every generated leaf has a log within 6 steps (checked for seeds 42, 1, 12345, 777, 2024, 99, −5). Candidates and
  placed leaves are saved as per-world records.
* `onChunkGenerated`: fired after a chunk generated for the first time in this world; the set of generated chunks is
  saved (`populated` record) so walking away and back (unmodified chunks are regenerated, not stored) never fires again;
  storage loads never fire. Events before the first listener are queued (≤ 4096) and delivered to it.

## Wave-1 review findings (docs/notes/review-wave1.json) — world-owned parts

| id | status | what was done |
|---|---|---|
| WORLD-1 / CODE-2 | fixed (world/storage side) | `world.saveSnapshot(meta)` → `storage.saveSnapshot`: meta + all modified chunks + unload buffer + data records in ONE IndexedDB transaction created synchronously and `commit()`ed; modified flags cleared only on success. All puts now `commit()`. Browser check: 25/25 edits survive `saveSnapshot` + immediate `location.reload()` (`tools/steps/world-snapshot-reload.json`). game.js (FIXER) already uses it for every save. |
| CODE-1 | fixed (world side) | `destroy()` freezes edits during the final save but keeps meshes; on failure it rejects and the world is fully usable again; `destroy({ save: false })` quits without saving. |
| WORLD-2 | fixed | 6-neighbour checks + canStay (floating gravel ceilings collapse in a chain; cactus/cane rules). |
| WORLD-3 / SURV-2 | fixed | leaf decay as above. |
| WORLD-4 | fixed | background unload saves write ≤ 16 chunks per frame; save()/destroy() still flush everything. |
| WORLD-5 | fixed | `Storage.open` catches a throwing `indexedDB` getter → memory fallback (tested). |
| WORLD-6 | storage side done | `storage.persistent`/`backend` already exposed; `requestPersistence()` added. The UI warning belongs to CONTAINERS/FIXER. |
| WORLD-7 | storage side done | `acquireWorldLock(worldId)` (Web Locks; verified in Edge: second request → null). game.js has its own WorldLocks with the same lock name. |
| AUDIO-2 | fixed (world side) | `onBlockPopped` hook (game.js wires it to particles + break sound). |
| PLAYER-1 / SURV-1 | world side done | wall-torch support via canStay + 6-neighbour checks, wall-torch model in the mesher (placement is SURVIVAL's). |
| CODE-6 / PLAYER-3 | world side done | cane needs water (pops at once when it is scooped, or on a random tick), cactus pops next to solids/lava/under liquid. Not done (shared `blocks.js`): `snowy_grass_block` as sugar-cane ground. |

## Integration notes (for the integrator)

* Wire the fizz: `new World({ ..., onEffect: (name, x, y, z) => { if (name === 'fizz') { audio.play('fizz', { x, y, z,
  volume: 0.5 }); particles.spawnSmoke(x, y + 0.7, z, 8); } } })` (Minecraft: extinguish sound, 8 large smoke).
* Wire mobs: `world.onChunkGenerated((cx, cz) => spawner.onChunkGenerated(cx, cz))` (events before registration are queued).
* F3 could show `world.stats().pendingFluids`.
* Entities already use `world.fluids.flowVector(x, y, z, out)`.

## Known limitations / deviations

* One falling state (level 8) instead of 1.12's 8..15 — behaviour identical (falling spreads with level 1).
* Flowing liquids use the still texture (no `water_flow` texture / scroll direction; the vertex format has no flow
  direction — a renderer could encode it in the reserved high byte of w2).
* Corner heights are quantised to 1/16 (min 1/16), so the thinnest Minecraft films are 1 px thick.
* Wall torch tilt is 21.8° (shear) instead of 22.5° (rotation) and the base is at 3/16 instead of 3.5/16 (1/16 grid).
* Lava does not set fire (no fire block). No rain (farmland only hydrates from water).
* Leaves of wave-1 saves placed by the player are not known as persistent (they may decay if a log next to them is
  removed); everything placed from now on is remembered.
