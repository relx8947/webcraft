// Harness helper (tools only): wire the MobSpawner into a running game the way game.js does it
// (docs/notes/mobs-wave2.md "Integration"), for real-game tests before / independently of the integrator.
//   node tools/harness.mjs --url "index.html?autostart=1&seed=42" --wait-for "window.__ready" \
//     --eval "import('/tools/mob-wire.js').then((m) => m.wire(window.__game))"
// wire(game) is idempotent; it returns { spawner, mobs } and exposes window.__mobs = the mobs.js module.
export async function wire(game) {
  if (game.__mobWire) return game.__mobWire;
  const mobs = await import('../src/game/mobs.js');
  if (game.spawner) {
    game.__mobWire = { spawner: game.spawner, mobs };
    globalThis.__mobs = mobs;
    return game.__mobWire;
  }
  const spawner = new mobs.MobSpawner(game);
  game.spawner = spawner;
  const world = game.world;
  if (typeof world.onChunkGenerated === 'function') world.onChunkGenerated((cx, cz) => spawner.onChunkGenerated(cx, cz));
  const ents = game.entities;
  const update = ents.update.bind(ents);
  ents.update = (dt) => {
    update(dt);
    spawner.update(dt);
  };
  game.__mobWire = { spawner, mobs };
  globalThis.__mobs = mobs;
  return game.__mobWire;
}

/** Spawn `type` on the surface `dist` blocks in front of the player (yaw facing the player). */
export function spawnInFront(game, type, dist = 6, side = 0) {
  const mobs = globalThis.__mobs;
  const p = game.player;
  const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw);
  const rx = Math.cos(p.yaw), rz = -Math.sin(p.yaw);
  const x = Math.floor(p.x + fx * dist + rx * side) + 0.5, z = Math.floor(p.z + fz * dist + rz * side) + 0.5;
  let y = game.world.getTopY(Math.floor(x), Math.floor(z)) + 1;
  // stand on the ground below plants (short grass is not solid)
  return mobs.spawnMob(game, type, x, y, z, { persistent: true, yaw: Math.atan2(fx, fz) });
}

/** One-line summary of the mobs within `r` blocks. */
export function summary(game, r = 64) {
  const p = game.player;
  return game.entities.list.filter((e) => e.type === 'mob' && Math.hypot(e.x - p.x, e.z - p.z) < r)
    .map((m) => `${m.mobType}@${m.x.toFixed(1)},${m.y.toFixed(1)},${m.z.toFixed(1)} hp${m.health}${m.target ? ' T' : ''}${m.frozen ? ' F' : ''}`)
    .join(' | ');
}
