# World agent notes — chunk.js, world.js, blockupdates.js, workerpool.js, worker.js, storage.js

Files: `src/world/{chunk,world,blockupdates,workerpool,worker,storage}.js`, tests `tests/world.test.js`
(33 tests) and `tests/storage.test.js` (9 tests), browser test `tools/world-test.html` (+ `tools/world-steps.json`
page-reload persistence run, `tools/world-shots.json` screenshots).

## API (SPEC §8 / §9.6 — implemented as specified, additions marked ➕)

```js
// workerpool.js
new WorkerPool(count = clamp(hardwareConcurrency - 2, 2, 8), { maxInFlight = 2, createWorker }➕)
pool.init(seed, worldType); pool.submit(job, priority, transfer) -> Promise<reply>; pool.cancel(pred(job, prio))
pool.reprioritize(fn(job, oldPrio) -> prio); pool.pending; pool.terminate()
pool.size, pool.queued, pool.inFlight, pool.liveWorkers, pool.getStats()➕; JobCancelledError, defaultWorkerCount()➕
// world.js
new World({ seed, worldType, worldId, storage, pool, renderer, renderDistance, smoothLighting, onDropItem,
            onFallingBlock➕, uploadBudgetMs➕ = 4, tickRadius➕ = 8, maxMeshJobs➕, generator➕ })
await world.init(); world.update(px, py, pz, dt); getBlock; setBlock(x, y, z, id, { update = true }) -> bool
getLight -> packed (0xF0 unknown/outside); getTopY; isChunkGenerated; isChunkMeshed; isAreaReady(x, z, r)
setRenderDistance(n); setSmoothLighting(b); remeshAll(); tick(rng, timeOfDay➕); onBlockChanged(fn) -> unsubscribe➕
await save(); await destroy(); stats() -> { loaded, meshed, pendingGenerate, pendingMesh, modified, idle➕, ... }
world.seed / worldType / worldId / renderDistance, world.generator➕ (main-thread WorldGenerator, lazy),
world.getBiome(x, z)➕, world.findSpawn()➕, world.getChunk(cx, cz)➕ (debug), world.onDropItem / onFallingBlock (settable)
// storage.js
await Storage.open({ name, indexedDB }➕) (never rejects; memory fallback + one console.warn), Storage.memory()➕
listWorlds, saveWorldMeta, loadWorldMeta, deleteWorld, getChunkKeys, loadChunk, saveChunks; persistent➕, backend➕, close()➕
rleEncode(u8), rleDecode(u8, length?) (pure); encodeChunkRecord / decodeChunkRecord➕, newWorldId()➕
// blockupdates.js
new BlockUpdater(world, { onDropItem, onFall, rng, budget }); blockChanged(x, y, z); enqueue; process(limit); pending
// chunk.js (pure helpers, Node-tested)
chunkKeyNum/keyCX/keyCZ, computeHeightmap, sectionMaskUpTo, editDirtyRange, rectDistance, chunkCenterDistance,
classifyChunk + SET_MESH/SET_GEN/SET_KEEP, circularOrder, Chunk, ChunkState
// worker.js
handleMessage(msg) -> { message, transfer } | null (exported for Node tests), hashSection(o, c, t)
```

## Streaming (world.js + chunk.js)

* **Sets** (all distances from the player's exact XZ position, recomputed whenever the player moved > 2 blocks or
  the render distance changed):
  * *mesh*: chunks intersecting the circle of radius `16·rd` blocks. The renderer draws sections within its fog end
    `0.95·16·rd` (+1), so every visible chunk is meshed — no holes at the horizon, even with the player at a chunk
    corner (tested). ≈ π·rd² + 4·rd chunks (rd 8: 241).
  * *gen*: chunks whose 3×3 neighbourhood contains a mesh chunk (meshing needs all 8 neighbours) ≈ "rd + 1".
  * *keep*: 5×5 neighbourhood; READY chunks outside it are unloaded ≈ "beyond rd + 2" (one ring of hysteresis, so
    walking back and forth across a border never thrashes). Not-yet-loaded chunks that leave the gen set are dropped
    and their queued jobs cancelled.
* **Loading order**: new chunks are started nearest-first (centre distance); saved chunks (index from
  `storage.getChunkKeys` at `init()`) are read from storage (≤ 24 concurrent reads, coalesced by Storage into one
  IndexedDB transaction per task), everything else is generated in the pool. Generation jobs are tiny, so all of them
  are queued at once with priority = distance; `pool.reprioritize` re-sorts them as the player moves and
  `pool.cancel` drops the ones whose chunk was unloaded (jobs carry `owner` + chunk `uid`, so a re-created chunk never
  receives a stale result).
* **Priorities** (lower = sooner): tier 0 edits `-2e6 + d`, tier 1 remesh of already visible chunks `-1e6 + d`, tier 2
  generation / first mesh `d` (d = centre distance in chunks). Mesh jobs of tiers 1–2 are throttled to
  `maxMeshJobs = 3 × workers` outstanding because their block copies are taken at submission.
* **Mesh jobs**: the 3×3 neighbourhood is copied into pooled 64 KiB buffers but only up to each chunk's highest block
  (`heightmap` max; typically ~30 % of the chunk), transferred, padded with air by the worker *in place*, and the
  buffers are transferred back (`returnBuffers`) for reuse — no allocation churn. The worker returns the centre chunk's
  light trimmed above the region's highest block + 15 (`trimLight`; everything above is exactly 0xF0): stored light is
  5.2 MB instead of 15.1 MB at rd 8.
* **Uploads**: results are queued per chunk/section and uploaded in `update()` under `uploadBudgetMs` (4 ms) nearest
  first (at least one chunk per frame). Each section carries a 53-bit hash of its three layers; a section whose hash
  equals what the renderer already holds is not re-uploaded (most light-only remeshes after an edit are skipped).
  `isChunkMeshed` = every section uploaded at least once.

## Edits (SPEC §9.6)

* `setBlock` writes the block, updates the heightmap, marks the chunk modified, increments the global edit sequence
  `seq`, then marks dirty sections: every chunk intersecting `[x−15, x+15]×[z−15, z+15]`, sections `0..(y+15)>>4`
  (only chunks whose first mesh was already submitted; the others are fully meshed later anyway). Chunks containing
  the 3×3×3 cube around the edit (faces, AO, liquid surface strips, plant joints) are *urgent*.
* Next `update()`: all urgent chunks are submitted at top priority as one **group**; the group's results are held
  until every member returned and then uploaded together, without budget, in one frame — breaking a block on a chunk
  border never shows a one-frame hole. Light-only neighbours follow as tier 1.
* **Races**: dirty bits are cleared only when a job is submitted, and the job is stamped with `seq`. Each section
  remembers the `seq` of the newest result applied or waiting for upload; older results for that section are
  ignored (out-of-order replies cannot regress the display), and edits made while a job runs set the dirty bits
  again → re-queued. Failed/cancelled jobs restore their mask. Light keeps the newest `seq` too. `remeshAll` /
  `setSmoothLighting` bump an epoch: queued mesh jobs are cancelled and late results of the old epoch are dropped.
* Latency (browser, 60 Hz, edit made before `world.update` like `interaction.update`): the worker result is back after
  ~4.7 ms and the section is on the GPU in the **next frame** (16.7 ms, i.e. the change is visible in the first frame
  after the edit). Remeshing is per chunk: one job per affected chunk containing all its dirty sections.

## Block updates (blockupdates.js)

Queue-based (no recursion, budgeted per call, leftovers processed in `tick`). After a change at (x,y,z) the cell and
the one above are checked:
* `NEEDS_SUPPORT` + `!hasSupport(id, below)` → becomes air, loot via `getDrops(id, 0, rng)` (no tool: short grass drops
  nothing, flowers/torches/cane/cactus drop themselves, dead bush sticks) → `onDropItem(itemId, count, x+.5, y+.5, z+.5)`,
  then the cell above is checked (cascades: sugar cane / cactus stacks, a flower on falling sand…). The changed cell
  itself is also checked, so `/setblock` of a torch in mid-air pops it.
* `HAS_GRAVITY` with a replaceable block below (air, water, lava, short grass, fern, dead bush — Minecraft
  `FallingBlock.isFree`): with `onFallingBlock` set and returning true the block is removed and the game's falling
  entity takes over (entities.js `spawnFallingBlock` places it via `world.setBlock` when it lands). Otherwise
  (SPEC wave 1) it moves instantly through every cell without a collision box down to the first solid block; lands in
  a replaceable cell (replacing water / short grass) or breaks into its item on a torch / flower / sapling / cane;
  falls out of the world below y = 0. Columns fall block by block (each vacated cell re-checks the one above).
* Not implemented (no block states / registry rules): horizontal cactus breaking, sugar cane water requirement — the
  shared `hasSupport` (used by interaction.js for placement) is the single source of truth, so a block the player was
  allowed to place never pops immediately.

## Random ticks (`tick(rng, timeOfDay)`)

3 random blocks per section (up to the chunk's highest block) of every loaded *and lit* chunk within
`min(tickRadius = 8, rd)` chunks; light = `max(sky − darkening, block)` with darkening from `skyLightLevelAt(timeOfDay)`
(omit `timeOfDay` = full daylight). Rules (Minecraft):
* grass / snowy grass: under an opaque block or liquid → dirt; with light ≥ 9 above, 4 attempts to spread to dirt in
  x±1, y−3..+1, z±1 whose cell above is free and lit ≥ 4 (snowy grass spreads snowy grass).
* saplings: light ≥ 9 and a 1/14 chance (= two 1/7 growth stages without block states) → `generator.growTree(access,
  x, y, z, saplingId, rng)` on the lazily created main-thread `WorldGenerator`; only when all chunks within 8 blocks are
  loaded.
* sugar cane / cactus: air above and stack height < 3 → 1/16 chance (Minecraft age 0..15) to grow one block.
* ice: block light > 10 (`11 − opacity 1`) → water (melts next to torches).
Unit-tested with scripted RNGs and once end-to-end through `tick()` with a seeded RNG.

## Persistence

* Storage: IndexedDB `webcraft` v1, `worlds` (keyPath `id`), `chunks` (key `[worldId, cx, cz]`, value
  `{ f: 1, n: 65536, d: rle }`). `deleteWorld` deletes the meta and `IDBKeyRange.bound([id], [id, []])` in one
  transaction. `getChunkKeys` = `getAllKeys(range)`. Chunk reads issued in the same task share one transaction. The
  connection reopens itself after `versionchange` / unexpected close. `Storage.open()` never rejects: without
  IndexedDB (or if it cannot be opened within 8 s) it falls back to memory with a single `console.warn`.
* RLE: varint token stream (literal runs / repeat runs ≥ 3). Surface chunk 64 KiB → 4–12 KiB, air chunk 4 bytes;
  worst case ≤ n + n/64 + 5. Corrupt / truncated streams throw `RangeError` (World regenerates such a chunk with a
  warning instead of crashing).
* World: `save()` writes every modified chunk, 16 per transaction, compressing synchronously and yielding between
  batches; `modified` is cleared only if the chunk did not change meanwhile; concurrent saves are serialized.
  Unloading a modified chunk moves its block array into an *unload-save buffer* that is written in the background
  (retry after 5 s on failure, one warning) and that `_startLoads` consults first — a chunk unloaded and wanted again
  before the write finished gets its edits back (tested). `destroy()` = cancel jobs, remove meshes, `save()`; if
  saving fails it rejects and keeps the data so `save()` can be retried. With `storage: null` an internal memory
  Storage keeps edits of unloaded chunks for the session.

## Workers (worker.js, workerpool.js)

* Module workers (`new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })`). `init` creates the
  `WorldGenerator`; `generate` transfers `blocks.buffer`; `mesh` = `buildRegion` → `computeLight` → `meshChunk` with
  `generator.getTints` → `extractChunkLight` into reused region/light buffers. Every failure becomes
  `{ type: 'error', jobId, message }` (stack included).
* Pool: binary min-heap on (priority, submission order), at most `maxInFlight` (2) jobs per worker (one running, one
  in its port → no idle round trips, priorities stay fresh), least-loaded dispatch, `cancel` / `reprioritize` O(n),
  `postMessage` failures (DataCloneError) reject only that job, a crashed worker (`error` event, e.g. module load
  failure) has its jobs rejected and is restarted up to 3 times with the last `init` replayed; if all workers are dead
  queued jobs reject. World retries failed generation twice, then generates on the main thread (air if even that
  fails); failed meshing is retried twice and then given up (chunk counts as meshed so the player is not frozen
  forever) until the next edit.

## Performance (Edge headless, RTX 4070, 8 workers, seed 12345; `tools/world-test.html`)

| measurement | counting renderer | real Renderer |
|---|---|---|
| spawn area (r = 2) meshed + uploaded | 167 ms | 161–179 ms |
| full rd 8 (313 loaded, 241 meshed, 1100 sections, 30.5 MB) | 365–369 ms | 369–394 ms |
| full rd 12 (604 / 500) | — | 582–590 ms |
| full rd 16 (1013 / 877, 4057 sections, 106 MB) | — | 844 ms |
| reload rd 8 from IndexedDB in-page / after a page reload | 242–245 / 385 ms | 225–240 ms |
| worker: generate / light+mesh per chunk (avg, incl. JIT warm-up) | 4.7 / 4.8 ms (2.8 / 2.9 warm) | same |
| `world.update()` per frame while loading rd 8 / rd 16 | avg 0.5, max 1.6–2.7 ms | avg 1.6–2.1, max 2.9–4.1 ms |
| edit → section on the GPU | next frame (16.7 ms); worker result after 4.7 ms avg | same |
| 4096-block `/fill`-style edit: setBlock loop / remeshed + uploaded | 1–1.9 ms / 24–31 ms | same |
| ~10 000-block edit (plaza + monument) setBlock calls | 1.4–3.5 ms | same |
| save() of 6–8 modified chunks | 3–7 ms | same |
| flying 30 b/s (rd 8) / 60 b/s (rd 12) for 6 s | — | player area never unready, update max 0.6 / 1.3 ms, 0 frames > 50 ms |

No frame longer than 50 ms in any run; frame-interval p95 16.7–16.8 ms. Real pool alone: 64 chunks generated by 8
workers in 86 ms. Node micro-benchmarks: `getBlock` 2.6 ns (same chunk) / 4.1 ns (scattered), `getLight` 5 ns,
`setBlock` 0.38 µs including dirty marking and block updates (a maximal 32 768-block `/fill` ≈ 12 ms).
Node: `node --test tests/world.test.js tests/storage.test.js` → 42 tests in ~1.5 s.

## Verification

* `tests/world.test.js`: keys, heightmaps, dirty ranges, streaming-set invariants (every visible chunk meshed, all
  mesh-chunk neighbours generated), block updates (popping/gravity/void/budget/onFall), worker protocol (generate ==
  WorldGenerator, trimmed inputs == full inputs, trimmed light == prefix of full light), WorkerPool (heap order, FIFO
  ties, in-flight limit, cancel, reprioritize, error replies, crash + restart + init replay, DataCloneError,
  terminate), World end-to-end with a fake pool running the real worker code: nearest-first loading, block queries,
  edit priorities and groups, out-of-order/racing results, unload/save/restore with and without storage, save +
  new instance, random ticks, tree growth, ice, smooth-lighting epochs, context-loss remesh, render-distance changes,
  job cancellation on teleport, failure fallbacks, unknown storage index. Every meshed section of a default-terrain
  world is compared word for word with a direct `meshChunk` of the world data, and `getLight` with a direct
  `computeLight` for all 65 536 cells of a chunk.
* `tests/storage.test.js`: RLE edge cases, varint boundaries, random data, real chunks, corrupt input; Storage
  memory backend CRUD / ordering / isolation / deleteWorld.
* Browser: `node tools/harness.mjs --url "tools/world-test.html?rd=8" --wait-for window.__done` (timings, IndexedDB
  self-test, edits, bulk edits, save, in-page reload, fast flight, verification of ~9 850 edited cells);
  `--steps tools/world-steps.json` (real page reload → phase 2 reopens the world from IndexedDB);
  `?render=1` + `--steps tools/world-shots.json` → `tools/out/world-{monument,overview,hole,monument-night,
  monument-flat}.png` (looked at: correct geometry at chunk borders, fallen sand, AO/flat difference, torch/glowstone
  light at night, fog edge without missing chunks).
* `node tools/harness.mjs --url tools/world-pool-test.html --wait-for window.__result`: WorkerPool with real module
  workers — priority order, reprioritize, cancel, error replies, 8-worker throughput, terminate, and a worker module
  that fails to load (3 restarts per slot, then every job rejects) — 19 checks.

## Integration (src/game.js)

```js
const storage = await Storage.open();                    // main.js, once
const pool = new WorkerPool();                           // main.js, once (shared by all worlds)
// startWorld(meta):
const world = new World({ seed: meta.seed, worldType: meta.worldType, worldId: meta.id, storage /* null for autostart temp worlds */,
  pool, renderer, renderDistance: settings.renderDistance, smoothLighting: settings.smoothLighting,
  onDropItem: (id, count, x, y, z) => game.spawnItem(makeStack(id, count), x, y - 0.25, z),   // block centre given
  onFallingBlock: (id, x, y, z) => !!game.entities?.spawnFallingBlock(id, x + 0.5, y, z + 0.5) });  // optional
await world.init();                                      // broadcasts pool.init(seed, worldType) itself
// new world spawn: meta.spawn = (sp => ({ x: sp.x + 0.5, y: sp.y, z: sp.z + 0.5 }))(world.findSpawn())
// loading screen: call world.update(spawn.x, spawn.y, spawn.z, dt) every frame until
//   world.isAreaReady(spawn.x, spawn.z, 2)   (progress: world.stats().meshed / loaded)
// frame: player → interaction → ticks → entities → world.update(player.x, player.y, player.z, dt) → render
// tick (20 TPS): world.tick(rng, game.timeOfDay)
renderer.onContextRestored = () => game.world?.remeshAll();
world.onBlockChanged((x, y, z, oldId, newId) => game.emit('blockChanged', x, y, z, oldId, newId));
// settingsChanged: world.setRenderDistance(s.renderDistance); world.setSmoothLighting(s.smoothLighting)
// autosave / quit: await world.save() (+ storage.saveWorldMeta(meta)); quitToTitle: await world.destroy()
// game.debug.waitIdle: poll world.stats().idle;  F3: world.stats(), world.getBiome(x, z).displayName
```

* `isAreaReady(x, z, r)` takes **block** coordinates (as player.js calls it) and ignores chunks outside the render
  distance, so `isAreaReady(spawnX, spawnZ, 2)` also works at rd 2.
* Call `world.destroy()` before starting the next world on the shared pool (it cancels its queued jobs; replies of
  running jobs are ignored).
* `uploadBudgetMs` can be raised while the loading screen is shown (e.g. 12) and reset to 4 when playing.
* `onDropItem` gets the block centre; entities.spawnItem without a velocity adds Minecraft's random pop.

## Decisions / deviations

* Mesh radius is "intersects the 16·rd circle" (slightly more than centre distance ≤ rd) so the fog edge never shows
  missing chunks; gen/keep radii are neighbourhood closures of it (≈ rd+1 / rd+2 as specified).
* `tick(rng, timeOfDay)` takes an optional second argument (without it, sky light counts as full daylight).
* Mesh job `chunks` may be trimmed copies (whole 256-byte layers, missing top = air); `returnBuffers` / `trimLight`
  / `hash` / `ms` / `buffers` are additive protocol fields. A plain spec message (full 65 536-byte chunks) is still
  accepted and answered with full-size light.
* `getLight` returns 0xF0 for unknown cells, above **and below** the world.
* `setBlock` with the same id returns true without side effects; ids that are not blocks return false; a closed
  (destroying) world rejects edits.

## Known limitations

* Liquids do not flow (no fluid simulation): digging next to a lake leaves a vertical water wall; sand removed from
  under water leaves an air pocket.
* Grass spreading uses the light of the newest mesh job (a few ms stale after edits) — irrelevant for gameplay.
* Memory: block arrays are always 64 KiB per loaded chunk (rd 8 ≈ 20 MB, rd 16 ≈ 65 MB); light is trimmed.
* One World per pool at a time (the pool's workers hold one generator).
