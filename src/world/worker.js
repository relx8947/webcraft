// World worker (docs/SPEC.md §8): chunk generation and light + mesh jobs. Module worker, no DOM.
//
// Protocol
//   main -> worker  { type: 'init', seed, worldType }
//   main -> worker  { type: 'generate', jobId, cx, cz }
//   worker -> main  { type: 'generated', jobId, cx, cz, blocks, ms }               (blocks.buffer transferred)
//   main -> worker  { type: 'mesh', jobId, cx, cz, chunks: Uint8Array[9], sectionMask, smoothLighting,
//                     returnBuffers?, trimLight? }
//   worker -> main  { type: 'meshed', jobId, cx, cz, sections: [{ sy, opaque, cutout, translucent, hash }],
//                     light, ms, buffers? }
//   worker -> main  { type: 'error', jobId, message }
//
// Mesh jobs: `chunks` are the 3x3 neighbourhood ((dz+1)*3 + (dx+1), centre 4), fresh copies that are
// transferred. An entry may be shorter than 65536 bytes (a whole number of 256-byte layers): the
// missing top layers are air — World sends only the layers up to each chunk's highest block. When the
// view starts at offset 0 of a buffer of at least 65536 bytes it is extended in place, otherwise it is
// copied into a scratch buffer. With `returnBuffers` the input buffers are transferred back in `buffers`
// so the main thread can reuse them. `light` is the centre chunk's packed light (chunk layout, 65536
// bytes); with `trimLight` only the layers up to the region's highest block + 15 are returned (every
// cell above is exactly 0xF0). Extra result fields (additive to the spec): `hash` per section (53-bit
// hash of the three layers, 0 = empty section, lets World skip re-uploading identical meshes) and `ms`.
//
// Region / light buffers are reused between jobs. `handleMessage` is exported so tests can run jobs
// synchronously under Node; the message handler is only installed inside a worker global scope.

import { CHUNK_VOLUME, REGION_VOLUME } from '../config.js';
import { WorldGenerator } from './worldgen.js';
import { buildRegion, computeLight, extractChunkLight, regionMaxY } from './lighting.js';
import { meshChunk } from './mesher.js';

let generator = null;
let regionBuf = null;
let lightBuf = null;
let chunkLightBuf = null;
const scratch = [];
const fullViews = new Array(9).fill(null);
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** 53-bit hash of a section's three mesh layers (0 only for an empty section). */
export function hashSection(opaque, cutout, translucent) {
  let h1 = 0xdeadbeef | 0;
  let h2 = 0x41c6ce57 | 0;
  let any = false;
  const layers = [opaque, cutout, translucent];
  for (let l = 0; l < 3; l++) {
    const a = layers[l];
    const n = a ? a.length : 0;
    if (n > 0) any = true;
    h1 = Math.imul(h1 ^ (n + l * 0x9e3779b1), 2654435761);
    h2 = Math.imul(h2 ^ (n + l * 0x85ebca77), 1597334677);
    for (let i = 0; i < n; i++) {
      const w = a[i];
      h1 = Math.imul(h1 ^ w, 2654435761);
      h2 = Math.imul(h2 ^ w, 1597334677);
      h1 ^= h1 >>> 15;
      h2 ^= h2 >>> 13;
    }
  }
  if (!any) return 0;
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const h = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return h === 0 ? 1 : h;
}

/** A full 65536-byte view of chunk i of a mesh job (extending trimmed inputs with air). */
function fullChunk(src, i, owners) {
  if (src == null) return null;
  if (!(src instanceof Uint8Array)) throw new TypeError(`mesh job chunk ${i} is not a Uint8Array`);
  if (src.length === CHUNK_VOLUME) return src;
  if (src.length > CHUNK_VOLUME || (src.length & 255) !== 0) {
    throw new RangeError(`mesh job chunk ${i} has a bad length (${src.length})`);
  }
  if (src.byteOffset === 0 && src.buffer.byteLength >= CHUNK_VOLUME && owners.get(src.buffer) === 1) {
    const full = new Uint8Array(src.buffer, 0, CHUNK_VOLUME);
    full.fill(0, src.length);
    return full;
  }
  let s = scratch[i];
  if (!s) s = scratch[i] = new Uint8Array(CHUNK_VOLUME);
  s.set(src);
  s.fill(0, src.length);
  return s;
}

function init(msg) {
  generator = new WorldGenerator(msg.seed >>> 0, msg.worldType === 'flat' ? 'flat' : 'default');
  return null;
}

function requireGenerator() {
  if (!generator) throw new Error('world worker used before init');
  return generator;
}

function generate(msg) {
  const t0 = now();
  const blocks = requireGenerator().generateChunk(msg.cx, msg.cz);
  return {
    message: { type: 'generated', jobId: msg.jobId, cx: msg.cx, cz: msg.cz, blocks, ms: now() - t0 },
    transfer: [blocks.buffer],
  };
}

function mesh(msg) {
  const t0 = now();
  const gen = requireGenerator();
  const chunks = msg.chunks;
  if (!Array.isArray(chunks) || chunks.length !== 9) throw new TypeError('mesh job needs chunks: Uint8Array[9]');
  const owners = new Map();
  for (const c of chunks) if (c) owners.set(c.buffer, (owners.get(c.buffer) ?? 0) + 1);
  for (let i = 0; i < 9; i++) fullViews[i] = fullChunk(chunks[i], i, owners);
  if (!regionBuf) {
    regionBuf = new Uint8Array(REGION_VOLUME);
    lightBuf = new Uint8Array(REGION_VOLUME);
    chunkLightBuf = new Uint8Array(CHUNK_VOLUME);
  }
  let sections;
  let chunkLight;
  try {
    const region = buildRegion(fullViews, regionBuf);
    const light = computeLight(region, lightBuf);
    const mask = typeof msg.sectionMask === 'number' ? msg.sectionMask & 0xffff : 0xffff;
    sections = meshChunk(region, light, mask, gen.getTints(msg.cx, msg.cz), {
      smoothLighting: msg.smoothLighting !== false,
    });
    const full = extractChunkLight(light, chunkLightBuf);
    // trimLight: above the region's highest block + 15 every cell is exactly 0xF0 (open sky, no block
    // light can reach that high), so only the layers below are returned.
    const layers = msg.trimLight ? Math.min(256, regionMaxY(region) + 16) : 256;
    chunkLight = full.slice(0, layers << 8);
  } finally {
    fullViews.fill(null);
  }
  const transfer = [chunkLight.buffer];
  for (const s of sections) {
    s.hash = hashSection(s.opaque, s.cutout, s.translucent);
    if (s.opaque) transfer.push(s.opaque.buffer);
    if (s.cutout) transfer.push(s.cutout.buffer);
    if (s.translucent) transfer.push(s.translucent.buffer);
  }
  const message = {
    type: 'meshed', jobId: msg.jobId, cx: msg.cx, cz: msg.cz, sections, light: chunkLight, ms: 0,
  };
  if (msg.returnBuffers) {
    const buffers = [...owners.keys()].filter((b) => b.byteLength > 0);
    message.buffers = buffers;
    transfer.push(...buffers);
  }
  message.ms = now() - t0;
  return { message, transfer };
}

/**
 * Run one protocol message. Never throws: failures become { type: 'error', jobId, message } replies.
 * @param {object} msg
 * @returns {{ message: object, transfer: Transferable[] } | null} reply (null for 'init')
 */
export function handleMessage(msg) {
  const jobId = msg && msg.jobId !== undefined ? msg.jobId : null;
  try {
    if (!msg || typeof msg !== 'object') throw new TypeError('bad message');
    switch (msg.type) {
      case 'init': return init(msg);
      case 'generate': return generate(msg);
      case 'mesh': return mesh(msg);
      default: throw new Error(`unknown job type '${msg.type}'`);
    }
  } catch (err) {
    const text = err && err.stack ? String(err.stack) : String(err);
    return { message: { type: 'error', jobId, message: text }, transfer: [] };
  }
}

// Install the handler only inside a worker (importing this module elsewhere has no side effects).
if (typeof WorkerGlobalScope !== 'undefined' && typeof self !== 'undefined' && self instanceof WorkerGlobalScope) {
  self.onmessage = (e) => {
    const reply = handleMessage(e.data);
    if (reply) self.postMessage(reply.message, reply.transfer);
  };
}
