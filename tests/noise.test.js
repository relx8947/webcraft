import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashString, mulberry32, hash3i, hash3f, SimplexNoise, fbm2D, fbm3D, ridged2D } from '../src/util/noise.js';

test('hashString is a stable uint32 with good spread', () => {
  assert.equal(hashString('webcraft'), hashString('webcraft'));
  const seen = new Set();
  for (let i = 0; i < 2000; i++) {
    const h = hashString('seed' + i);
    assert.ok(Number.isInteger(h) && h >= 0 && h <= 0xffffffff);
    seen.add(h);
  }
  assert.equal(seen.size, 2000, 'no collisions among 2000 short strings');
  assert.notEqual(hashString('a'), hashString('b'));
  assert.notEqual(hashString('ab'), hashString('ba'));
  assert.ok(Number.isInteger(hashString('')));
  assert.notEqual(hashString('我的世界'), hashString('我的世'));
});

test('mulberry32 is deterministic and uniform in [0,1)', () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  const c = mulberry32(43);
  let same = 0;
  let sum = 0;
  const buckets = new Array(10).fill(0);
  for (let i = 0; i < 100000; i++) {
    const v = a();
    assert.equal(v, b());
    if (v === c()) same++;
    assert.ok(v >= 0 && v < 1);
    sum += v;
    buckets[Math.floor(v * 10)]++;
  }
  assert.ok(same < 5);
  assert.ok(Math.abs(sum / 100000 - 0.5) < 0.01);
  for (const n of buckets) assert.ok(Math.abs(n - 10000) < 600, `bucket ${n}`);
});

test('hash3i is deterministic, argument-sensitive and well distributed', () => {
  assert.equal(hash3i(1, 2, 3, 4), hash3i(1, 2, 3, 4));
  const base = hash3i(7, 10, 20, 30);
  assert.notEqual(base, hash3i(8, 10, 20, 30));
  assert.notEqual(base, hash3i(7, 11, 20, 30));
  assert.notEqual(base, hash3i(7, 10, 21, 30));
  assert.notEqual(base, hash3i(7, 10, 20, 31));
  assert.notEqual(hash3i(7, 1, 2, 3), hash3i(7, 3, 2, 1), 'argument order matters');
  // negative coordinates work and stay in uint32 range
  const h = hash3i(123, -5000, -7, -99999);
  assert.ok(Number.isInteger(h) && h >= 0 && h <= 0xffffffff);
  // bucket test over a grid of neighbouring positions (where weak hashes show patterns)
  const buckets = new Array(16).fill(0);
  let bits = 0;
  let n = 0;
  for (let x = -40; x < 40; x++) {
    for (let z = -40; z < 40; z++) {
      const v = hash3i(99, x, 64, z);
      buckets[v >>> 28]++;
      bits += v & 1;
      n++;
    }
  }
  for (const b of buckets) assert.ok(Math.abs(b - n / 16) < n / 16 * 0.2, `bucket ${b}`);
  assert.ok(Math.abs(bits / n - 0.5) < 0.03);
  const f = hash3f(1, 2, 3, 4);
  assert.ok(f >= 0 && f < 1);
});

test('SimplexNoise: deterministic per seed, bounded, zero-mean, continuous', () => {
  const n1 = new SimplexNoise(1234);
  const n2 = new SimplexNoise(1234);
  const n3 = new SimplexNoise(4321);
  let diff = 0;
  let sum2 = 0;
  let sum3 = 0;
  let min = Infinity;
  let max = -Infinity;
  const N = 50000;
  for (let i = 0; i < N; i++) {
    const x = (i * 0.731) % 500 - 250;
    const y = (i * 0.377) % 300 - 150;
    const z = (i * 0.193) % 200 - 100;
    const a = n1.noise2D(x, y);
    assert.equal(a, n2.noise2D(x, y));
    if (Math.abs(a - n3.noise2D(x, y)) > 1e-9) diff++;
    const b = n1.noise3D(x, y, z);
    assert.equal(b, n2.noise3D(x, y, z));
    for (const v of [a, b]) {
      assert.ok(v >= -1 && v <= 1, `out of range ${v}`);
      if (v < min) min = v;
      if (v > max) max = v;
    }
    sum2 += a;
    sum3 += b;
  }
  assert.ok(diff > N * 0.95, 'different seeds give different noise');
  assert.ok(Math.abs(sum2 / N) < 0.03 && Math.abs(sum3 / N) < 0.03, 'zero mean');
  assert.ok(min < -0.7 && max > 0.7, `uses most of the range (${min}, ${max})`);
  // continuity: tiny steps produce tiny changes
  for (let i = 0; i < 1000; i++) {
    const x = i * 0.37;
    const y = i * 0.11;
    assert.ok(Math.abs(n1.noise2D(x, y) - n1.noise2D(x + 1e-4, y)) < 0.01);
    assert.ok(Math.abs(n1.noise3D(x, y, 1.5) - n1.noise3D(x, y + 1e-4, 1.5)) < 0.01);
  }
  // values at integer lattice points are not all zero (no lattice artefacts in fBm thanks to offsets)
  let nonzero = 0;
  for (let i = 0; i < 100; i++) if (Math.abs(fbm2D(n1, i, i * 2, 4)) > 1e-6) nonzero++;
  assert.ok(nonzero > 90);
});

test('fractal helpers stay in range', () => {
  const n = new SimplexNoise(5);
  for (let i = 0; i < 20000; i++) {
    const x = i * 0.0173;
    const y = i * 0.0291;
    const f2 = fbm2D(n, x, y, 6);
    const f3 = fbm3D(n, x, y, x - y, 4, 0.6, 2.1);
    const r = ridged2D(n, x, y, 5);
    assert.ok(f2 >= -1 && f2 <= 1);
    assert.ok(f3 >= -1 && f3 <= 1);
    assert.ok(r >= 0 && r <= 1);
  }
  assert.equal(fbm2D(n, 3.3, 4.4, 1), n.noise2D(3.3, 4.4), 'one octave = plain noise');
});

test('noise performance', () => {
  const n = new SimplexNoise(9);
  let s = 0;
  const t0 = performance.now();
  for (let i = 0; i < 200000; i++) s += n.noise3D(i * 0.37, i * 0.11, i * 0.07);
  const ms = performance.now() - t0;
  assert.ok(Number.isFinite(s));
  assert.ok(ms < 200, `200k noise3D took ${ms.toFixed(1)} ms`);
});
