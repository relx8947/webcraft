// Unit tests for src/game/audio.js. WebAudio does not exist in Node, so a strict mock BaseAudioContext
// is used: it enforces the real API rules (finite times/values, no exponential ramp to 0, no double
// start, no stop before start, curve overlap, enum values) and records the node graph so the tests can
// check that every source is started, stopped and actually reaches the destination.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AudioEngine, SoundCore, SOUND_NAMES, BLOCK_KINDS, BLOCK_MATERIALS, makeNoise, makeImpulse, spatialize,
  composePiece, pieceMidis, analyzeBuffer, mulberry32,
} from '../src/game/audio.js';

// ------------------------------------------------------------------------------------------- mock
function finiteOrThrow(v, what) {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new TypeError(`${what} must be finite, got ${v}`);
}

class MockParam {
  constructor(owner, value) {
    this.owner = owner;
    this.ctx = owner.ctx;
    this._value = value;
    this.events = [];
  }
  get value() { return this._value; }
  set value(v) { finiteOrThrow(v, 'AudioParam.value'); this._value = v; }
  _time(t) {
    finiteOrThrow(t, 'time');
    if (t < 0) throw new RangeError(`negative time ${t}`);
  }
  _noCurveOverlap(t) {
    for (const e of this.events) {
      if (e.type === 'curve' && t >= e.time && t < e.time + e.dur) throw new Error('NotSupportedError: event inside a value curve');
    }
  }
  _push(e) {
    this._noCurveOverlap(e.time);
    this.events.push(e);
    return this;
  }
  setValueAtTime(v, t) { finiteOrThrow(v, 'value'); this._time(t); return this._push({ type: 'set', v, time: t }); }
  linearRampToValueAtTime(v, t) { finiteOrThrow(v, 'value'); this._time(t); return this._push({ type: 'linear', v, time: t }); }
  exponentialRampToValueAtTime(v, t) {
    finiteOrThrow(v, 'value');
    this._time(t);
    if (v === 0) throw new RangeError('exponentialRampToValueAtTime to 0');
    return this._push({ type: 'exp', v, time: t });
  }
  setTargetAtTime(v, t, tc) {
    finiteOrThrow(v, 'value');
    this._time(t);
    finiteOrThrow(tc, 'timeConstant');
    if (tc < 0) throw new RangeError('negative time constant');
    return this._push({ type: 'target', v, time: t, tc });
  }
  setValueCurveAtTime(curve, t, dur) {
    this._time(t);
    finiteOrThrow(dur, 'duration');
    if (!(dur > 0)) throw new RangeError('curve duration must be > 0');
    if (curve.length < 2) throw new Error('InvalidStateError: curve too short');
    for (const v of curve) finiteOrThrow(v, 'curve value');
    for (const e of this.events) {
      if (e.time >= t && e.time < t + dur) throw new Error('NotSupportedError: curve overlaps an event');
    }
    return this._push({ type: 'curve', curve: Float32Array.from(curve), time: t, dur });
  }
  cancelScheduledValues(t) {
    this._time(t);
    this.events = this.events.filter((e) => e.time < t);
    return this;
  }
  cancelAndHoldAtTime(t) { return this.cancelScheduledValues(t); }
}

class MockNode {
  constructor(ctx, kind) {
    this.ctx = ctx;
    this.kind = kind;
    this.outputs = new Set();
    ctx.nodes.push(this);
  }
  connect(dest) {
    if (!(dest instanceof MockNode) && !(dest instanceof MockParam)) throw new TypeError('invalid connect() destination');
    if (dest.ctx !== this.ctx) throw new Error('InvalidAccessError: nodes from different contexts');
    this.outputs.add(dest);
    return dest;
  }
  disconnect() { this.outputs.clear(); }
}

class MockSource extends MockNode {
  constructor(ctx, kind) {
    super(ctx, kind);
    this.started = false;
    this.startTime = null;
    this.stopTime = null;
    ctx.sources.push(this);
  }
  start(when = 0, offset = 0) {
    if (this.started) throw new Error('InvalidStateError: start() called twice');
    finiteOrThrow(when, 'start time');
    if (when < 0) throw new RangeError('negative start time');
    finiteOrThrow(offset, 'offset');
    if (offset < 0) throw new RangeError('negative offset');
    this.started = true;
    this.startTime = when;
  }
  stop(when = 0) {
    if (!this.started) throw new Error('InvalidStateError: stop() before start()');
    finiteOrThrow(when, 'stop time');
    if (when < 0) throw new RangeError('negative stop time');
    this.stopTime = when;
  }
}

const FILTER_TYPES = new Set(['lowpass', 'highpass', 'bandpass', 'lowshelf', 'highshelf', 'peaking', 'notch', 'allpass']);
const OSC_TYPES = new Set(['sine', 'square', 'sawtooth', 'triangle']);

class MockBuffer {
  constructor(channels, length, sampleRate) {
    if (!(length > 0) || !(sampleRate >= 3000)) throw new Error('NotSupportedError: bad buffer');
    this.numberOfChannels = channels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.duration = length / sampleRate;
    this._data = Array.from({ length: channels }, () => new Float32Array(length));
  }
  getChannelData(c) { return this._data[c]; }
}

class MockAudioContext {
  constructor() {
    this.sampleRate = 48000;
    this.currentTime = 0;
    this.state = 'suspended';
    this.nodes = [];
    this.sources = [];
    this.destination = new MockNode(this, 'destination');
    this.resumeCalls = 0;
    this.onstatechange = null;
    MockAudioContext.instances.push(this);
  }
  resume() {
    this.resumeCalls++;
    this.state = 'running';
    this.onstatechange?.();
    return Promise.resolve();
  }
  suspend() { this.state = 'suspended'; return Promise.resolve(); }
  close() { this.state = 'closed'; return Promise.resolve(); }
  createGain() {
    const n = new MockNode(this, 'gain');
    n.gain = new MockParam(n, 1);
    return n;
  }
  createBiquadFilter() {
    const n = new MockNode(this, 'biquad');
    let type = 'lowpass';
    Object.defineProperty(n, 'type', {
      get: () => type,
      set: (v) => { if (!FILTER_TYPES.has(v)) throw new TypeError('bad filter type ' + v); type = v; },
    });
    n.frequency = new MockParam(n, 350);
    n.Q = new MockParam(n, 1);
    n.gain = new MockParam(n, 0);
    n.detune = new MockParam(n, 0);
    return n;
  }
  createOscillator() {
    const n = new MockSource(this, 'oscillator');
    let type = 'sine';
    Object.defineProperty(n, 'type', {
      get: () => type,
      set: (v) => { if (!OSC_TYPES.has(v)) throw new TypeError('bad oscillator type ' + v); type = v; },
    });
    n.frequency = new MockParam(n, 440);
    n.detune = new MockParam(n, 0);
    return n;
  }
  createBufferSource() {
    const n = new MockSource(this, 'buffer');
    n.buffer = null;
    n.loop = false;
    n.playbackRate = new MockParam(n, 1);
    n.detune = new MockParam(n, 0);
    return n;
  }
  createStereoPanner() {
    const n = new MockNode(this, 'panner');
    n.pan = new MockParam(n, 0);
    return n;
  }
  createConvolver() {
    const n = new MockNode(this, 'convolver');
    let buffer = null;
    Object.defineProperty(n, 'buffer', {
      get: () => buffer,
      set: (b) => {
        if (b.sampleRate !== this.sampleRate) throw new Error('NotSupportedError: convolver sample rate');
        if (![1, 2, 4].includes(b.numberOfChannels)) throw new Error('NotSupportedError: convolver channels');
        buffer = b;
      },
    });
    n.normalize = true;
    return n;
  }
  createWaveShaper() {
    const n = new MockNode(this, 'shaper');
    let curve = null;
    let oversample = 'none';
    Object.defineProperty(n, 'curve', {
      get: () => curve,
      set: (c) => {
        if (c !== null && !(c instanceof Float32Array && c.length >= 2)) throw new TypeError('InvalidStateError: bad curve');
        if (c) for (const v of c) finiteOrThrow(v, 'curve value');
        curve = c;
      },
    });
    Object.defineProperty(n, 'oversample', {
      get: () => oversample,
      set: (v) => { if (!['none', '2x', '4x'].includes(v)) throw new TypeError('bad oversample ' + v); oversample = v; },
    });
    return n;
  }
  createDynamicsCompressor() {
    const n = new MockNode(this, 'compressor');
    for (const p of ['threshold', 'knee', 'ratio', 'attack', 'release']) n[p] = new MockParam(n, 0);
    return n;
  }
  createBuffer(ch, len, sr) { return new MockBuffer(ch, len, sr); }
}
MockAudioContext.instances = [];

/** True when `node` has a path to the context destination (through nodes or modulated params). */
function reachesDestination(node, seen = new Set()) {
  if (node === node.ctx.destination) return true;
  if (seen.has(node)) return false;
  seen.add(node);
  for (const out of node.outputs) {
    const next = out instanceof MockParam ? out.owner : out;
    if (reachesDestination(next, seen)) return true;
  }
  return false;
}

function newCore(opts = {}) {
  const ctx = new MockAudioContext();
  ctx.state = 'running';
  const core = new SoundCore(ctx, { rng: mulberry32(1234), strict: true, ...opts });
  return { ctx, core };
}

// ------------------------------------------------------------------------------------ pure helpers
test('makeNoise: normalised, DC-free, colour tilt, seamless loop', () => {
  const n = 48000;
  const slope = {};
  for (const color of ['white', 'pink', 'brown']) {
    const d = makeNoise(color, n, mulberry32(7));
    assert.equal(d.length, n);
    let peak = 0, mean = 0, sq = 0, diff = 0;
    for (let i = 0; i < n; i++) {
      assert.ok(Number.isFinite(d[i]));
      peak = Math.max(peak, Math.abs(d[i]));
      mean += d[i];
      sq += d[i] * d[i];
      if (i) diff += (d[i] - d[i - 1]) ** 2;
    }
    assert.ok(Math.abs(peak - 1) < 1e-6, `${color} peak ${peak}`);
    assert.ok(Math.abs(mean / n) < 0.05, `${color} DC ${mean / n}`);
    slope[color] = diff / sq; // high-frequency share
    // loop seam: the jump from the last to the first sample is a normal sample-to-sample step
    const seam = Math.abs(d[0] - d[n - 1]);
    assert.ok(seam < 6 * Math.sqrt(diff / n) + 1e-3, `${color} loop seam ${seam}`);
  }
  assert.ok(slope.white > slope.pink && slope.pink > slope.brown, JSON.stringify(slope));
});

test('makeImpulse: stereo, decaying, decorrelated channels', () => {
  const [l, r] = makeImpulse(48000, 1.5, { rng: mulberry32(3) });
  assert.equal(l.length, 72000);
  assert.equal(r.length, 72000);
  const energy = (d, a, b) => { let e = 0; for (let i = a; i < b; i++) e += d[i] * d[i]; return e; };
  const first = energy(l, 0, 7200), last = energy(l, 64800, 72000);
  assert.ok(first > 0 && last < first * 0.01, `tail ${last} vs head ${first}`);
  let peak = 0;
  for (const v of l) peak = Math.max(peak, Math.abs(v));
  assert.ok(Math.abs(peak - 1) < 1e-6);
  let lr = 0, ll = 0, rr = 0;
  for (let i = 0; i < l.length; i++) { lr += l[i] * r[i]; ll += l[i] * l[i]; rr += r[i] * r[i]; }
  assert.ok(Math.abs(lr / Math.sqrt(ll * rr)) < 0.5, 'channels should be decorrelated');
});

test('spatialize: linear falloff, pan follows the yaw convention (SPEC §4), rear damping', () => {
  const o = {};
  // Facing north (yaw 0): east (+X) is on the right.
  spatialize(0, 0, 0, 0, 5, 0, 0, 16, o);
  assert.ok(o.pan > 0.5, `east should pan right, got ${o.pan}`);
  spatialize(0, 0, 0, 0, -5, 0, 0, 16, o);
  assert.ok(o.pan < -0.5);
  // Facing south (yaw PI): east is on the left. Facing west (yaw PI/2): north (-Z) is on the right.
  spatialize(0, 0, 0, Math.PI, 5, 0, 0, 16, o);
  assert.ok(o.pan < -0.5);
  spatialize(0, 0, 0, Math.PI / 2, 0, 0, -5, 16, o);
  assert.ok(o.pan > 0.5);
  // Straight ahead / behind: centred.
  spatialize(0, 0, 0, 0, 0, 0, -6, 16, o);
  assert.ok(Math.abs(o.pan) < 1e-9);
  // Linear distance gain, silent at / beyond the range, full at the listener.
  spatialize(0, 64, 0, 0, 0, 64, 8, 16, o);
  assert.ok(Math.abs(o.gain - 0.5) < 1e-9);
  spatialize(0, 0, 0, 0, 0, 16, 0, 16, o);
  assert.equal(o.gain, 0);
  spatialize(0, 0, 0, 0, 100, 0, 0, 16, o);
  assert.equal(o.gain, 0);
  spatialize(3, 4, 5, 1, 3, 4, 5, 16, o);
  assert.equal(o.gain, 1);
  assert.equal(o.pan, 0);
  // Behind is darker than in front at the same distance.
  const front = spatialize(0, 0, 0, 0, 0, 0, -8, 16, {}).lowpass;
  const back = spatialize(0, 0, 0, 0, 0, 0, 8, 16, {}).lowpass;
  assert.ok(back < front);
});

test('analyzeBuffer: peak, rms and audible length', () => {
  const b = new MockBuffer(1, 48000, 48000);
  const d = b.getChannelData(0);
  for (let i = 0; i < 4800; i++) d[i] = 0.5 * Math.sin(i * 0.1);
  const a = analyzeBuffer(b);
  assert.ok(Math.abs(a.peak - 0.5) < 0.01);
  assert.ok(Math.abs(a.length - 0.1) < 0.005);
  assert.ok(a.rms > 0.3 && a.rms < 0.4);
});

// --------------------------------------------------------------------------------------- composer
test('composePiece: deterministic, valid, in key, calm', () => {
  const MODES = {
    major: [0, 2, 4, 5, 7, 9, 11], lydian: [0, 2, 4, 6, 7, 9, 11], mixolydian: [0, 2, 4, 5, 7, 9, 10],
    dorian: [0, 2, 3, 5, 7, 9, 10], aeolian: [0, 2, 3, 5, 7, 8, 10],
  };
  assert.deepEqual(composePiece(42), composePiece(42));
  assert.notDeepEqual(composePiece(1).events, composePiece(2).events);
  const styles = new Set();
  for (let seed = 1; seed <= 60; seed++) {
    const p = composePiece(seed * 7919);
    styles.add(p.style);
    assert.ok(p.duration >= 60 && p.duration <= 260, `duration ${p.duration}`);
    assert.ok(p.bpm >= 50 && p.bpm <= 84);
    assert.ok(p.gain > 0.5 && p.gain < 1.8);
    const scale = new Set(MODES[p.mode].map((iv) => (iv + p.key) % 12));
    let prev = 0, melody = 0;
    for (const e of p.events) {
      assert.ok(e.t >= prev - 1e-9, 'events sorted');
      prev = e.t;
      assert.ok(e.t >= 0 && e.t < p.duration);
      assert.ok(e.dur > 0 && e.dur < 30);
      assert.ok(e.vel > 0 && e.vel <= 1);
      assert.ok(Number.isInteger(e.midi) && e.midi >= 33 && e.midi <= 96, `midi ${e.midi}`);
      assert.ok(scale.has(e.midi % 12), `note ${e.midi} not in ${p.keyName} ${p.mode}`);
      if (e.inst === 'pad') assert.ok(p.pad);
      if (e.inst === 'piano' && e.midi >= 64) melody++;
    }
    assert.ok(melody >= 8, `seed ${seed}: melody too sparse (${melody})`);
    // Sparse and calm: never more than ~4 note onsets per second on average.
    assert.ok(p.events.length / p.duration < 4.5);
    assert.ok(pieceMidis(p).length > 4);
  }
  assert.ok(styles.size >= 4, [...styles].join());
});

// --------------------------------------------------------------------------------------- SoundCore
test('SoundCore: every named sound builds a valid graph that reaches the destination', () => {
  const { ctx, core } = newCore();
  for (const name of SOUND_NAMES) {
    const before = ctx.sources.length;
    const v = core.play(name);
    assert.ok(v, name);
    const created = ctx.sources.slice(before);
    assert.ok(created.length > 0, `${name} created no sources`);
    for (const s of created) {
      assert.ok(s.started && s.stopTime !== null && s.stopTime > s.startTime, `${name}: source not started/stopped`);
      assert.ok(reachesDestination(s), `${name}: dangling ${s.kind}`);
    }
    assert.ok(v.endTime > v.startTime && v.endTime - v.startTime < 6, `${name} length ${v.endTime - v.startTime}`);
    ctx.currentTime += 5; // let it finish
    core.update(0.016);
  }
  assert.equal(core.voiceCount, 0, 'finished voices are released');
});

test('SoundCore: every block kind x material plays (unknown material -> stone)', () => {
  const { ctx, core } = newCore();
  core.setListener(0.5, 65.62, 0.5, 0.3);
  for (const material of BLOCK_MATERIALS) {
    for (const kind of BLOCK_KINDS) {
      const before = ctx.sources.length;
      const v = core.playBlock(kind, material, 2.5, 64.5, 0.5);
      assert.ok(v, `${kind}:${material}`);
      for (const s of ctx.sources.slice(before)) assert.ok(reachesDestination(s), `${kind}:${material} dangling ${s.kind}`);
      ctx.currentTime += 3;
      core.update(0.016);
    }
  }
  assert.ok(core.playBlock('step', 'unobtainium', 0, 64, 0));
  assert.equal(core.playBlock('dance', 'stone', 0, 64, 0), null);
  assert.equal(core.play('no_such_sound'), null);
});

test('SoundCore: voice limiter drops the oldest voices', () => {
  const { ctx, core } = newCore({ maxVoices: 24 });
  const voices = [];
  for (let i = 0; i < 100; i++) {
    voices.push(core.playBlock(BLOCK_KINDS[i % 5], BLOCK_MATERIALS[i % 10], 0, 64, 0));
    ctx.currentTime += 0.004; // a burst: same key only every 10 sounds = 40 ms (spam guard is 35 ms)
  }
  assert.ok(core.voiceCount <= 24, `voices ${core.voiceCount}`);
  const stolen = voices.filter((v) => v && v.stopped);
  assert.ok(stolen.length > 0);
  // The oldest were stolen: the first voice is stopped, the newest is not.
  assert.ok(voices[0].stopped);
  assert.ok(!voices[99].stopped);
  // A stolen voice fades out (fader ramps to 0) and its sources are stopped soon.
  const v = voices[0];
  assert.ok(v.input.gain.events.some((e) => e.type === 'linear' && e.v === 0));
  for (const s of v.sources) assert.ok(s.stopTime <= v.endTime + 0.05);
});

test('SoundCore: spam guard limits identical sounds in the same instant', () => {
  const { core } = newCore();
  let played = 0;
  for (let i = 0; i < 10; i++) if (core.playBlock('break', 'stone', 0, 64, 0)) played++;
  assert.equal(played, 3);
  assert.ok(core.playBlock('break', 'wood', 0, 64, 0), 'other sounds are unaffected');
});

test('SoundCore: positional range, volume extends range, non-positional before setListener', () => {
  const { core } = newCore();
  // Before the listener is known everything is played centred (never silently dropped).
  assert.ok(core.play('pig', { x: 1000, y: 64, z: 0 }));
  core.setListener(0, 64, 0, 0);
  assert.equal(core.play('pig', { x: 30, y: 64, z: 0 }), null, 'pig beyond 16 blocks is inaudible');
  assert.ok(core.play('pig', { x: 30, y: 64, z: 0, volume: 2 }), 'volume 2 doubles the range');
  assert.ok(core.play('explode', { x: 40, y: 64, z: 0 }), 'explosions carry 64 blocks');
  const v = core.play('cow', { x: 4, y: 64, z: 0 });
  assert.ok(v.pan && v.pan.pan.value > 0.5, 'east of a north-facing listener pans right');
  assert.ok(v.amp.gain.value < v.level, 'distance attenuation');
  // UI sounds ignore positions.
  const c = core.play('click', { x: 500, y: 0, z: 0 });
  assert.ok(c && !c.positional && !c.pan);
  // Garbage input never throws.
  assert.doesNotThrow(() => core.play('pop', { x: NaN, y: Infinity, volume: NaN, pitch: -5 }));
  assert.doesNotThrow(() => core.setListener(NaN, 0, 0, 0));
});

test('SoundCore: long voices follow the listener; setPosition moves them', () => {
  const { core } = newCore();
  core.setListener(0, 64, 0, 0);
  const v = core.play('fuse', { x: 4, y: 64, z: 0 });
  const n0 = v.pan.pan.events.length;
  core.setListener(0, 64, 0, Math.PI); // turn around: the fuse is now on the left
  const last = v.pan.pan.events.at(-1);
  assert.ok(v.pan.pan.events.length > n0 && last.v < 0, 'pan updated after turning');
  v.setPosition(-4, 64, 0);
  assert.ok(v.pan.pan.events.at(-1).v > 0);
  v.stop(0.1);
  assert.ok(v.stopped && !v.playing);
});

test('SoundCore: volumes and underwater filter', () => {
  const { core } = newCore({ soundVolume: 0.8, musicVolume: 0.5 });
  assert.equal(core.soundBus.gain.value, 0.8);
  assert.equal(core.musicBus.gain.value, 0.5);
  core.setVolumes(0.3, 2);
  assert.equal(core.soundBus.gain.events.at(-1).v, 0.3);
  assert.equal(core.musicBus.gain.events.at(-1).v, 1, 'clamped to 1');
  core.setVolumes(0, undefined);
  assert.equal(core.play('hurt'), null, 'muted sounds create no nodes');
  core.setUnderwater(true);
  assert.ok(core.sfxFilter.frequency.events.at(-1).v < 1000);
});

test('SoundCore: music cycle schedules notes ahead, survives hitches, stops cleanly', async () => {
  const { ctx, core } = newCore({ musicVolume: 1 });
  core.startMusic({ delay: 0 });
  assert.equal(core.musicStatus.state, 'waiting');
  core.update(0);
  assert.equal(core.musicStatus.state, 'preparing');
  await new Promise((r) => setTimeout(r, 10)); // ensurePianoSamples (no OfflineAudioContext in Node -> live fallback)
  assert.equal(core.musicStatus.state, 'playing');
  const piece = core.music.piece;
  let scheduled = 0;
  for (let i = 0; i < 40; i++) {
    const before = ctx.sources.length;
    ctx.currentTime += 0.25;
    core.update(0.25);
    for (const s of ctx.sources.slice(before)) {
      assert.ok(s.startTime >= ctx.currentTime - 1e-9, 'never schedule into the past');
      assert.ok(s.startTime <= ctx.currentTime + 1.05, 'look-ahead is bounded');
      assert.ok(reachesDestination(s));
    }
    scheduled += ctx.sources.length - before;
  }
  assert.ok(scheduled > 10, `notes scheduled: ${scheduled}`);
  // A 20 s hitch: the piece slides instead of bursting all missed notes at once.
  const next = core.music.next;
  ctx.currentTime += 20;
  const before = ctx.sources.length;
  core.update(0);
  assert.ok(core.music.next - next < 40, 'no burst of missed notes');
  for (const s of ctx.sources.slice(before)) assert.ok(s.startTime >= ctx.currentTime - 1e-9);
  assert.equal(core.music.piece, piece);
  core.stopMusic({ fade: 1 });
  assert.equal(core.musicStatus.state, 'off');
  ctx.currentTime += 2;
  core.update(0);
  assert.equal(core.music.fading.length, 0, 'faded piece detached');
});

test('SoundCore: finished piece -> silence of a few minutes -> next piece', async () => {
  const { ctx, core } = newCore();
  core.startMusic({ delay: 0 });
  core.update(0);
  await new Promise((r) => setTimeout(r, 10));
  const p = core.music.piece;
  for (let t = 0; t < p.duration + 2; t += 0.5) {
    ctx.currentTime += 0.5;
    core.update(0.5);
  }
  const st = core.musicStatus;
  assert.equal(st.state, 'waiting');
  assert.ok(st.nextIn >= 60 && st.nextIn <= 300, `gap ${st.nextIn}`);
});

// ------------------------------------------------------------------------------------- AudioEngine
test('AudioEngine without WebAudio: available = false, every call is a safe no-op', () => {
  const a = new AudioEngine({ soundVolume: 1, musicVolume: 1 });
  assert.equal(a.available, false);
  assert.equal(a.unlock(), false);
  assert.equal(a.play('click'), null);
  assert.equal(a.playBlock('break', 'stone', 0, 0, 0), null);
  assert.doesNotThrow(() => {
    a.setListener(1, 2, 3, 4);
    a.setVolumes(0.5, 0.5);
    a.setVolumes();
    a.setUnderwater(true);
    a.startMusic();
    a.update(0.016);
    a.stopMusic();
    a.destroy();
  });
});

test('AudioEngine: lazy context on unlock, state carried over, play only when unlocked', async () => {
  MockAudioContext.instances.length = 0;
  const settings = { soundVolume: 0.7, musicVolume: 0.4 };
  const a = new AudioEngine(settings, { AudioContextClass: MockAudioContext, autoUnlock: false });
  assert.equal(a.available, true);
  assert.equal(MockAudioContext.instances.length, 0, 'no context before a gesture');
  assert.equal(a.play('click'), null, 'play before unlock is ignored');
  a.setListener(10, 70, -5, 1.2);
  a.setUnderwater(true);
  a.startMusic({ delay: 30 });
  assert.equal(a.musicStatus.state, 'locked');
  assert.equal(a.unlock(), true);
  assert.equal(MockAudioContext.instances.length, 1);
  assert.equal(a.unlock(), true);
  assert.equal(MockAudioContext.instances.length, 1, 'unlock is idempotent');
  await Promise.resolve();
  assert.equal(a.unlocked, true);
  const core = a.core;
  assert.deepEqual([core.listener.x, core.listener.y, core.listener.z, core.listener.yaw], [10, 70, -5, 1.2]);
  assert.equal(core.underwater, true);
  assert.equal(core.soundBus.gain.value, 0.7);
  assert.equal(core.musicBus.gain.value, 0.4);
  assert.equal(a.musicStatus.state, 'waiting');
  assert.ok(a.play('hurt', { x: 10, y: 70, z: -5 }));
  assert.ok(a.playBlock('place', 'wood', 11, 69, -5));
  settings.soundVolume = 0.25;
  a.setVolumes();
  assert.equal(core.soundBus.gain.events.at(-1).v, 0.25, 'setVolumes() re-reads the settings');
  a.stopMusic();
  assert.equal(a.musicStatus.state, 'off');
  a.destroy();
  assert.equal(MockAudioContext.instances[0].state, 'closed');
  assert.equal(a.play('click'), null);
});

test('AudioEngine: sounds play while the first resume() is pending, not while suspended later', async () => {
  const a = new AudioEngine({}, { AudioContextClass: MockAudioContext, autoUnlock: false });
  // A context whose resume() resolves later (like a real browser).
  a.unlock();
  const ctx = a.ctx;
  assert.ok(ctx);
  await Promise.resolve();
  ctx.state = 'suspended';
  a._resuming = false;
  assert.equal(a.play('click'), null, 'suspended (e.g. hidden tab) -> ignored');
  a._resuming = true;
  assert.ok(a.play('click'), 'resume pending -> scheduled');
  a.destroy();
});

test('AudioEngine: a throwing context never escapes', () => {
  class Broken { constructor() { throw new Error('no audio device'); } }
  const warn = console.warn;
  console.warn = () => {};
  try {
    const a = new AudioEngine({}, { AudioContextClass: Broken, autoUnlock: false });
    assert.equal(a.unlock(), false);
    assert.equal(a.available, false);
    assert.equal(a.play('click'), null);
    assert.doesNotThrow(() => a.update(0.1));
  } finally {
    console.warn = warn;
  }
});

// ------------------------------------------------------------------------------------- wave 2 sounds
test('wave 2: mob / combat / item sounds exist; aliases resolve; unknown names warn once', async () => {
  const { SOUND_ALIASES, resolveSoundName } = await import('../src/game/audio.js');
  for (const name of [
    'skeleton', 'skeleton_hurt', 'skeleton_death', 'skeleton_step', 'spider', 'spider_hurt', 'spider_death', 'spider_step',
    'creeper_hurt', 'creeper_death', 'zombie_death', 'zombie_step', 'pig_hurt', 'cow_hurt', 'sheep_hurt', 'chicken_hurt',
    'mob_death', 'attack_swish', 'attack_hit', 'attack_crit', 'bow_shoot', 'arrow_hit', 'arrow_hit_player', 'hoe_till',
    'chest_open', 'chest_close', 'fire_crackle', 'fall_small', 'fall_big', 'lava_pop', 'water_flow', 'lava_ambient',
  ]) assert.ok(SOUND_NAMES.includes(name), name);
  // Every alias points at a real sound and never shadows one.
  for (const [alias, target] of Object.entries(SOUND_ALIASES)) {
    assert.ok(SOUND_NAMES.includes(target), `${alias} -> ${target}`);
    assert.ok(!SOUND_NAMES.includes(alias), `alias ${alias} shadows a sound`);
  }
  assert.equal(resolveSoundName('bow'), 'bow_shoot');
  assert.equal(resolveSoundName('pig_death'), 'pig_hurt');
  assert.equal(resolveSoundName('toString'), null, 'prototype keys are not sounds');
  assert.equal(resolveSoundName(42), null);
  // play() accepts aliases (played as the canonical sound).
  const { ctx, core } = newCore();
  const before = ctx.sources.length;
  const v = core.play('poof', { x: 0, y: 64, z: 0 });
  assert.ok(v && v.key === 'mob_death' && ctx.sources.length > before);
  assert.equal(core.play('constructor'), null);
  // AudioEngine: an unknown name logs one warning per name, even before the context is unlocked.
  const warnings = [];
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const engine = new AudioEngine({}, { AudioContextClass: MockAudioContext, autoUnlock: false, suspendWhenHidden: false });
    assert.equal(engine.play('skeleton_rattle_typo'), null);
    assert.equal(engine.play('skeleton_rattle_typo'), null);
    assert.equal(engine.play('skeleton'), null, 'known sound before unlock: silently ignored');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /skeleton_rattle_typo/);
  } finally {
    console.warn = warn;
  }
});

test('mixer output ceiling: a soft clipper after the limiter keeps |x| < 1 (review AUDIO-1)', async () => {
  const { ceilingCurve } = await import('../src/game/audio.js');
  const c = ceilingCurve();
  const n = c.length;
  // Shaper input u = 0.5·x spans [-1, 1]: the curve maps x in [-2, 2].
  const at = (x) => {
    const pos = ((x / 2 + 1) / 2) * (n - 1);
    const i = Math.min(n - 2, Math.floor(pos));
    return c[i] + (c[i + 1] - c[i]) * (pos - i);
  };
  for (const x of [-0.8, -0.5, -0.1, 0, 0.1, 0.33, 0.5, 0.79]) assert.ok(Math.abs(at(x) - x) < 1e-5, `identity at ${x}`);
  for (let i = 0; i < n; i++) assert.ok(Math.abs(c[i]) < 0.981, 'never reaches full scale');
  for (let i = 1; i < n; i++) assert.ok(c[i] >= c[i - 1], 'monotonic');
  assert.ok(at(1.2) > 0.9 && at(2) > 0.97, 'saturates smoothly toward 0.98');
  // The mixer routes master -> limiter -> 0.5 pre-gain -> shaper -> destination.
  const { ctx, core } = newCore();
  const shaper = ctx.nodes.find((nd) => nd.kind === 'shaper');
  assert.ok(shaper && shaper.curve === c && shaper.outputs.has(ctx.destination));
  assert.equal(shaper.oversample, '2x');
  assert.ok(reachesDestination(core.master));
  const v = core.play('explode');
  for (const s of v.sources) assert.ok(reachesDestination(s));
});
