// Multiplayer wire protocol shared by the browser client (src/net/) and the dedicated server (server/).
// See docs/MULTIPLAYER.md for the full message list. Text frames carry JSON objects { t: type, ... };
// binary frames carry chunk data (encodeChunkFrame / decodeChunkFrame).
//
// Positions travel as plain numbers rounded with q2 (1/100 block) and angles with qa (1/1000 rad):
// the server is in mainland China behind a ~3 Mbit/s uplink, so the JSON is kept short.

export const PROTOCOL_VERSION = 1;

/** Path of the WebSocket endpoint below the page (https://host/webcraft/ws). */
export const WS_PATH = 'ws';

/** Player names: 1-16 characters, letters (any script), digits, '_' and '-'. */
export const NAME_MAX = 16;
const NAME_RE = /^[\p{L}\p{N}_-]{1,16}$/u;

export function validName(name) {
  return typeof name === 'string' && NAME_RE.test(name);
}

/** Longest chat line accepted by the server (characters). */
export const CHAT_MAX = 200;

/** Entity snapshot rate (Hz) and the delay clients render behind the newest snapshot (s). */
export const SNAPSHOT_HZ = 10;
export const INTERP_DELAY = 0.12;
/** Player position updates sent by clients (Hz). */
export const POSITION_HZ = 20;

export const q2 = (v) => Math.round(v * 100) / 100;
export const qa = (v) => Math.round(v * 1000) / 1000;

// ---------------------------------------------------------------------------------------------------
// Binary frames
// ---------------------------------------------------------------------------------------------------

export const BIN_CHUNK = 1;

/** Chunk payload kinds: the client generates PRISTINE chunks itself from the seed. */
export const CHUNK_PRISTINE = 0;
export const CHUNK_DATA = 1;

/**
 * Chunk reply: [u8 BIN_CHUNK][i32 cx][i32 cz][u32 seq][u8 kind][RLE bytes (kind CHUNK_DATA)]. `seq` echoes
 * the subscription request, so a reply to an older subscription of the same chunk is recognised.
 * @param {Uint8Array|null} rle rleEncode()d blocks, or null for a pristine chunk
 * @returns {Uint8Array}
 */
export function encodeChunkFrame(cx, cz, seq, rle) {
  const n = rle ? rle.length : 0;
  const out = new Uint8Array(14 + n);
  const dv = new DataView(out.buffer);
  out[0] = BIN_CHUNK;
  dv.setInt32(1, cx, true);
  dv.setInt32(5, cz, true);
  dv.setUint32(9, seq >>> 0, true);
  out[13] = rle ? CHUNK_DATA : CHUNK_PRISTINE;
  if (rle) out.set(rle, 14);
  return out;
}

/** @returns {{ cx: number, cz: number, seq: number, rle: Uint8Array|null } | null} null for other frames */
export function decodeChunkFrame(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (u8.length < 14 || u8[0] !== BIN_CHUNK) return null;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const cx = dv.getInt32(1, true);
  const cz = dv.getInt32(5, true);
  const seq = dv.getUint32(9, true);
  const rle = u8[13] === CHUNK_DATA ? u8.subarray(14) : null;
  return { cx, cz, seq, rle };
}

// ---------------------------------------------------------------------------------------------------
// Stacks
// ---------------------------------------------------------------------------------------------------

/** Stack -> compact array [id, count, damage] (null stays null). */
export function packStack(s) {
  return s && s.count > 0 ? [s.id | 0, s.count | 0, (s.damage ?? 0) | 0] : null;
}

/** Inverse of packStack, validated (bad input -> null). */
export function unpackStack(a) {
  if (!Array.isArray(a) || a.length < 2) return null;
  const id = a[0] | 0, count = a[1] | 0, damage = (a[2] ?? 0) | 0;
  if (id <= 0 || count <= 0 || count > 64 || damage < 0) return null;
  return { id, count, damage };
}

export function sameStack(a, b) {
  if (!a || !b) return !a && !b;
  return a.id === b.id && a.count === b.count && (a.damage ?? 0) === (b.damage ?? 0);
}
