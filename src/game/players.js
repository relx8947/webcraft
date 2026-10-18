// Players of a game (multiplayer support for the shared simulation modules). Single player: the Game
// exposes `players` = [player]; the dedicated server lists every connected player (server/remoteplayer.mjs).
// Fake games in tests may only have `player`, which this helper wraps.

const NONE = Object.freeze([]);

/** Every player of `game` (array, do not mutate). */
export function playersOf(game) {
  const list = game?.players;
  if (list) return list;
  const p = game?.player;
  return p ? [p] : NONE;
}

/**
 * Nearest player to (x, y, z) accepted by `filter(player)` (all when omitted), within `maxDist` blocks.
 * Returns null when there is none.
 */
export function nearestPlayer(game, x, y, z, maxDist = Infinity, filter = null) {
  const list = playersOf(game);
  let best = null;
  let bestD2 = maxDist * maxDist;
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (!p || !Number.isFinite(p.x) || (filter !== null && !filter(p))) continue;
    const dx = p.x - x, dy = p.y - y, dz = p.z - z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 <= bestD2) {
      bestD2 = d2;
      best = p;
    }
  }
  return best;
}
