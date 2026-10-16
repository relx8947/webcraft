// Page-side helpers for the liquid / shape harness runs (tools/steps/fluids-*.json). Loaded with
//   {"eval": "import('/tools/fluids-helpers.js').then((m) => m.install())"}
// then used as window.__fx.* from later eval steps. Builds test scenes with game.debug.setBlock and reports
// liquid statistics. Not used by the game itself.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function install() {
  const reg = await import('../src/world/registry.js');
  const game = window.__game;
  const dbg = game.debug;
  const { BLOCKS, BLOCK, ITEM, LIQUID_KIND, LIQUID_LEVEL } = reg;

  const fx = {
    /** Fill a box with a block (names or ids), no matter what is there. */
    fill(x0, y0, z0, x1, y1, z1, block) {
      const id = typeof block === 'number' ? block : BLOCK[block.toUpperCase()];
      let n = 0;
      for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) if (game.world.setBlock(x, y, z, id)) n++;
      return n;
    },
    /** Put the held item into the hotbar slot and select it. */
    hold(name, slot = 0) {
      const id = ITEM[name.toUpperCase()];
      const inv = game.player.inventory;
      inv.set(slot, { id, count: 1, damage: 0 });
      game.player.selectedSlot = slot;
      return game.player.getSelectedStack();
    },
    /** Teleport (hovering, creative flight) and look at a point. */
    view(x, y, z, lx, ly, lz, fly = true) {
      if (game.player.mode === 'creative') game.player.flying = fly;
      dbg.tp(x, y, z);
      game.player.vx = game.player.vy = game.player.vz = 0;
      dbg.lookAt(lx, ly, lz);
      return [game.player.x, game.player.y, game.player.z];
    },
    /** Liquid census of a box: { water: {level: count}, lava: {...} }. */
    census(x0, y0, z0, x1, y1, z1) {
      const out = { water: {}, lava: {} };
      for (let y = y0; y <= y1; y++) {
        for (let z = z0; z <= z1; z++) {
          for (let x = x0; x <= x1; x++) {
            const id = game.world.getBlock(x, y, z);
            const k = LIQUID_KIND[id];
            if (!k) continue;
            const m = k === 1 ? out.water : out.lava;
            m[LIQUID_LEVEL[id]] = (m[LIQUID_LEVEL[id]] ?? 0) + 1;
          }
        }
      }
      return out;
    },
    /** Names of the blocks in a row (debugging). */
    row(x0, x1, y, z) {
      const r = [];
      for (let x = x0; x <= x1; x++) r.push(BLOCKS[game.world.getBlock(x, y, z)].name);
      return r;
    },
    /** Wait until no liquid update is pending (or timeout), then for the meshes. */
    async settle(timeoutMs = 20000) {
      const t0 = performance.now();
      while (game.world.fluids.pending > 0 && performance.now() - t0 < timeoutMs) await sleep(100);
      await dbg.waitIdle(10000);
      await dbg.frames(3);
      return { pending: game.world.fluids.pending, ms: Math.round(performance.now() - t0), stats: game.world.fluids.stats() };
    },
    sleep,
    effects: [],
  };
  // Record effects (the integrator wires world.onEffect to audio/particles; keep whatever is there).
  const prev = game.world.onEffect;
  game.world.onEffect = (name, x, y, z) => {
    fx.effects.push({ name, x, y, z });
    if (typeof prev === 'function') prev(name, x, y, z);
  };
  window.__fx = fx;
  return 'fx installed';
}
