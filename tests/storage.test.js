import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rleEncode, rleDecode, Storage, encodeChunkRecord, decodeChunkRecord, newWorldId,
} from '../src/world/storage.js';
import { WorldGenerator } from '../src/world/worldgen.js';
import { mulberry32 } from '../src/util/noise.js';

function roundTrip(data) {
  const enc = rleEncode(data);
  const dec = rleDecode(enc, data.length);
  assert.deepEqual(dec, data);
  assert.deepEqual(rleDecode(enc), data, 'decoding without a length gives the same result');
  return enc;
}

test('rle: empty, tiny and edge-case inputs round-trip', () => {
  assert.equal(rleEncode(new Uint8Array(0)).length, 0);
  assert.equal(rleDecode(new Uint8Array(0), 0).length, 0);
  for (const arr of [[7], [7, 7], [7, 7, 7], [1, 2], [1, 2, 3], [0, 0, 0, 1], [1, 0, 0, 0], [5, 5, 6, 6, 6, 7]]) {
    roundTrip(Uint8Array.from(arr));
  }
  // runs that cross varint length boundaries (1, 2 and 3 header bytes)
  for (const n of [3, 4, 66, 67, 68, 129, 130, 8194, 8195, 8196, 65536, 100000]) {
    const a = new Uint8Array(n).fill(9);
    const enc = roundTrip(a);
    assert.ok(enc.length <= 5, `run of ${n} encodes to ${enc.length} bytes`);
  }
  // literals crossing varint boundaries
  for (const n of [63, 64, 65, 128, 8192, 8193, 70000]) {
    const a = new Uint8Array(n);
    for (let i = 0; i < n; i++) a[i] = i & 1 ? 200 : i % 251;
    const enc = roundTrip(a);
    assert.ok(enc.length <= n + Math.ceil(n / 64) + 5, `literal of ${n} encodes to ${enc.length} bytes`);
  }
});

test('rle: random data expands by at most n/64 + 5 bytes and round-trips', () => {
  const rnd = mulberry32(1234);
  for (let k = 0; k < 200; k++) {
    const n = Math.floor(rnd() * 3000);
    const a = new Uint8Array(n);
    // mixture of noise and runs
    let i = 0;
    while (i < n) {
      const v = Math.floor(rnd() * 4);
      const len = rnd() < 0.5 ? 1 : Math.floor(rnd() * 40);
      for (let j = 0; j < len && i < n; j++) a[i++] = v;
    }
    const enc = roundTrip(a);
    assert.ok(enc.length <= n + Math.ceil(n / 64) + 5);
  }
});

test('rle: real terrain chunks compress well', () => {
  const gen = new WorldGenerator(12345);
  let total = 0;
  for (let i = 0; i < 4; i++) {
    const blocks = gen.generateChunk(i * 7 - 3, i * 5 + 2);
    const enc = roundTrip(blocks);
    total += enc.length;
    assert.ok(enc.length < 24000, `chunk compressed to ${enc.length} bytes`);
  }
  const air = rleEncode(new Uint8Array(65536));
  assert.ok(air.length <= 4, `air chunk ${air.length} bytes`);
  assert.ok(total / 4 < 16000, `average ${total / 4}`);
});

test('rle: corrupt input is rejected with RangeError', () => {
  const a = new Uint8Array(1000);
  for (let i = 0; i < 1000; i++) a[i] = (i * 7) % 13;
  const enc = rleEncode(a);
  assert.throws(() => rleDecode(enc, 999), RangeError);
  assert.throws(() => rleDecode(enc, 1001), RangeError);
  assert.throws(() => rleDecode(enc.subarray(0, enc.length - 1), 1000), RangeError);
  assert.throws(() => rleDecode(Uint8Array.of(0x80, 0x80, 0x80, 0x80, 0x80, 0x01), 10), RangeError);
  assert.throws(() => rleDecode(Uint8Array.of(0x01), 3), RangeError, 'run without a value byte');
  assert.throws(() => rleEncode([1, 2, 3]), TypeError);
});

test('chunk records: encode/decode, validation', () => {
  const blocks = new Uint8Array(65536);
  blocks[123] = 5;
  blocks[65535] = 9;
  const rec = encodeChunkRecord(blocks);
  assert.equal(rec.f, 1);
  assert.equal(rec.n, 65536);
  assert.deepEqual(decodeChunkRecord(rec), blocks);
  assert.throws(() => encodeChunkRecord(new Uint8Array(10)), TypeError);
  assert.throws(() => decodeChunkRecord({ f: 2, n: 65536, d: new Uint8Array(1) }), RangeError);
  assert.throws(() => decodeChunkRecord({ f: 1, n: 100, d: rec.d }), RangeError);
});

test('Storage.open without IndexedDB falls back to memory (one warning)', async () => {
  const warn = console.warn;
  const msgs = [];
  console.warn = (...a) => msgs.push(a.join(' '));
  try {
    const s1 = await Storage.open();
    const s2 = await Storage.open();
    assert.equal(s1.backend, 'memory');
    assert.equal(s1.persistent, false);
    assert.equal(s2.backend, 'memory');
    assert.equal(msgs.length, 1, 'single warning');
    const s3 = await Storage.open({ indexedDB: null });
    assert.equal(s3.backend, 'memory');
    assert.equal(msgs.length, 1);
  } finally {
    console.warn = warn;
  }
});

test('Storage (memory): world meta CRUD, sorting, isolation from caller mutations', async () => {
  const s = Storage.memory();
  assert.deepEqual(await s.listWorlds(), []);
  const a = { id: 'a', name: '世界A', seed: 1, lastPlayed: 100, player: { x: 1 } };
  const b = { id: 'b', name: '世界B', seed: 2, lastPlayed: 300 };
  const c = { id: 'c', name: '世界C', seed: 3, lastPlayed: 200 };
  await s.saveWorldMeta(a);
  await s.saveWorldMeta(b);
  await s.saveWorldMeta(c);
  a.player.x = 999;                                  // stored copy must not change
  assert.deepEqual((await s.listWorlds()).map((m) => m.id), ['b', 'c', 'a']);
  const la = await s.loadWorldMeta('a');
  assert.equal(la.player.x, 1);
  la.name = 'changed';
  assert.equal((await s.loadWorldMeta('a')).name, '世界A');
  await s.saveWorldMeta({ ...a, lastPlayed: 400, name: 'A2' });
  assert.deepEqual((await s.listWorlds()).map((m) => m.id), ['a', 'b', 'c']);
  assert.equal((await s.loadWorldMeta('a')).name, 'A2');
  assert.equal(await s.loadWorldMeta('zzz'), null);
  await assert.rejects(s.saveWorldMeta({ name: 'no id' }), TypeError);
  await assert.rejects(s.saveWorldMeta(null), TypeError);
});

test('Storage (memory): chunks save/load/keys, deleteWorld removes only that world', async () => {
  const s = Storage.memory();
  const mk = (v) => {
    const u = new Uint8Array(65536);
    u.fill(v, 0, 4096);
    u[60000] = v + 1;
    return u;
  };
  const b1 = mk(1);
  await s.saveChunks('w1', [{ cx: 0, cz: 0, blocks: b1 }, { cx: -3, cz: 7, blocks: mk(2) }]);
  b1[0] = 77;                                        // encoded synchronously: later mutations don't leak
  await s.saveChunks('w2', [{ cx: 0, cz: 0, blocks: mk(3) }]);
  await s.saveWorldMeta({ id: 'w1', name: 'one' });
  await s.saveWorldMeta({ id: 'w2', name: 'two' });
  assert.deepEqual([...(await s.getChunkKeys('w1'))].sort(), ['-3,7', '0,0']);
  const l = await s.loadChunk('w1', 0, 0);
  assert.equal(l[0], 1);
  assert.equal(l[60000], 2);
  assert.equal((await s.loadChunk('w1', -3, 7))[0], 2);
  assert.equal(await s.loadChunk('w1', 5, 5), null);
  // overwrite
  await s.saveChunks('w1', [{ cx: 0, cz: 0, blocks: mk(9) }]);
  assert.equal((await s.loadChunk('w1', 0, 0))[0], 9);
  await s.deleteWorld('w1');
  assert.equal((await s.getChunkKeys('w1')).size, 0);
  assert.equal(await s.loadWorldMeta('w1'), null);
  assert.equal((await s.loadChunk('w2', 0, 0))[0], 3, 'other worlds untouched');
  assert.deepEqual((await s.listWorlds()).map((m) => m.id), ['w2']);
  await assert.rejects(s.saveChunks('w1', [{ cx: 0, cz: 0, blocks: new Uint8Array(5) }]), TypeError);
  await s.saveChunks('w1', []);
});

test('newWorldId produces distinct string ids', () => {
  const ids = new Set();
  for (let i = 0; i < 100; i++) ids.add(newWorldId());
  assert.equal(ids.size, 100);
  for (const id of ids) assert.match(id, /^w[0-9a-z]+$/);
});
