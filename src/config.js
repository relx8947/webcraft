// Global constants shared by every module (main thread AND workers — no DOM access here).

export const CHUNK_SIZE = 16;          // blocks along X and Z
export const CHUNK_SHIFT = 4;
export const CHUNK_MASK = 15;
export const WORLD_HEIGHT = 256;       // valid y: 0..255
export const SECTION_HEIGHT = 16;
export const SECTIONS_PER_CHUNK = 16;  // WORLD_HEIGHT / SECTION_HEIGHT
export const CHUNK_AREA = 256;         // 16 * 16
export const CHUNK_VOLUME = 65536;     // 16 * 16 * 256
export const SEA_LEVEL = 62;           // world generation fills air with water for y <= SEA_LEVEL
export const MAX_LIGHT = 15;

// 3x3-chunk neighbourhood used by lighting + meshing (see docs/SPEC.md §6).
export const REGION_SIZE = 48;
export const REGION_OFFSET = 16;
export const REGION_VOLUME = 48 * 48 * 256;

export const TICKS_PER_SECOND = 20;
export const DAY_TICKS = 24000;        // one full day = 20 real minutes

export const PLAYER = Object.freeze({
  WIDTH: 0.6,
  HEIGHT: 1.8,
  SNEAK_HEIGHT: 1.5,
  EYE_HEIGHT: 1.62,
  SNEAK_EYE_HEIGHT: 1.27,
  REACH_SURVIVAL: 4.5,
  REACH_CREATIVE: 5.0,
});

// Face indices used everywhere (mesher, raycast, placement, textures).
export const FACE = Object.freeze({ PX: 0, NX: 1, PY: 2, NY: 3, PZ: 4, NZ: 5 });
export const FACE_NORMALS = Object.freeze([
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
]);
// Directional shading per face index (index 6 = cross/sprite geometry).
export const FACE_SHADE = Object.freeze([0.6, 0.6, 1.0, 0.5, 0.8, 0.8, 0.9]);

// Default biome tint colours (used for icons, held items, particles, dropped items).
export const DEFAULT_TINTS = Object.freeze({
  grass: [145, 189, 89],
  foliage: [119, 171, 47],
  birch: [128, 167, 85],
  spruce: [97, 153, 97],
});

/** Index into a chunk's Uint8Array(65536). x,z in [0,16), y in [0,256). */
export function blockIndex(x, y, z) {
  return (y << 8) | (z << 4) | x;
}

/** Index into a 48x48x256 region array. x,z in [-16,32) (center chunk occupies [0,16)), y in [0,256). */
export function regionIndex(x, y, z) {
  return (y * 48 + (z + 16)) * 48 + (x + 16);
}

export function chunkKey(cx, cz) {
  return cx + ',' + cz;
}

/**
 * Sky brightness multiplier for a time of day.
 * timeOfDay in [0,1): 0 = sunrise, 0.25 = noon, 0.5 = sunset, 0.75 = midnight.
 * Returns 0.2 (night) .. 1.0 (day) with smooth dawn/dusk transitions.
 */
export function computeDaylight(timeOfDay) {
  const s = Math.sin(timeOfDay * Math.PI * 2);
  let k = (s + 0.2) / 0.6;
  k = k < 0 ? 0 : k > 1 ? 1 : k;
  return 0.2 + 0.8 * (k * k * (3 - 2 * k));
}

/** Effective sky light level (0..15) at this time of day — used by game logic (mob spawning, burning). */
export function skyLightLevelAt(timeOfDay) {
  return Math.round(4 + 11 * (computeDaylight(timeOfDay) - 0.2) / 0.8);
}

export const DEFAULT_SETTINGS = Object.freeze({
  renderDistance: 8,      // chunks (radius)
  fov: 75,                // vertical degrees
  mouseSensitivity: 1.0,  // multiplier
  invertY: false,
  viewBobbing: true,
  smoothLighting: true,
  clouds: true,
  soundVolume: 0.8,
  musicVolume: 0.5,
  showFps: false,
  guiScale: 0,            // 0 = auto
  difficulty: 'normal',   // 'peaceful' | 'easy' | 'normal' | 'hard'
  brightness: 0.5,        // 亮度 (Minecraft gamma): 0 = 昏暗 (Moody), 0.5 = default, 1 = 明亮 (Bright)
});

export const SETTINGS_STORAGE_KEY = 'webcraft.settings';
