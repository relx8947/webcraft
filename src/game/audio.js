// WebCraft audio (SPEC §9.9) — every sound is synthesized at runtime with WebAudio; no audio files.
//
// Layers (everything except AudioEngine works on ANY BaseAudioContext, so the exact same code renders
// into an OfflineAudioContext for the self-check in tools/audio-test.html):
//   * pure DSP helpers (Node-testable): makeNoise, makeImpulse, spatialize, composePiece
//   * SynthKit      per-context helpers: cached noise buffers (white / pink / brown), envelopes, filters,
//                   "grain clouds" (one noise source + one gain curve for dozens of crunchy grains)
//   * recipes       block material families like Minecraft's SoundType: a `dig` sound (break + place)
//                   and a `step` sound (step, hit = step at half pitch, land = step at 0.75 pitch) per
//                   material; named sounds (UI, player, items, explosions, mobs)
//   * PianoSampler  piano notes rendered once by additive synthesis (stretched partials, two-stage
//                   decay, detuned unison strings, hammer noise) in an OfflineAudioContext — i.e. off the
//                   main thread — then replayed as cheap AudioBufferSourceNodes
//   * composePiece  generative C418-style pieces (slow, sparse, major-7 / pentatonic harmony)
//   * SoundCore     mixer (sound / music buses, two convolution reverbs on send buses, soft limiter),
//                   voices (max 24, the oldest is dropped), positional audio (linear distance falloff
//                   like Minecraft, stereo pan relative to the listener yaw, rear / distance damping),
//                   the music scheduler (look-ahead, a piece every few minutes)
//   * AudioEngine   the public API: lazily creates the AudioContext on the first user gesture, never
//                   throws when WebAudio is missing, ignores play() before unlock().

import { mulberry32 } from '../util/noise.js';

/** Block sound kinds (SPEC §9.9). */
export const BLOCK_KINDS = Object.freeze(['break', 'place', 'step', 'hit', 'land']);
/** Block sound materials (`block.sound` values in blocks.js). */
export const BLOCK_MATERIALS = Object.freeze([
  'stone', 'wood', 'gravel', 'grass', 'sand', 'glass', 'wool', 'snow', 'metal', 'water',
]);

const TAU = Math.PI * 2;
const DEFAULT_MAX_VOICES = 24;
const CURVE_RATE = 2000;          // control points per second of grain-cloud gain curves
const NOISE_SECONDS = 3;          // length of the cached (looping) noise buffers
const PIANO_RATE = 32000;         // sample rate of the rendered piano notes

/** Seeded PRNG (re-exported from util/noise.js for tests and the test page). */
export { mulberry32 };

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
function finite(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
function midiToHz(m) {
  return 440 * Math.pow(2, (m - 69) / 12);
}

// ---------------------------------------------------------------------------------------------------
// Pure DSP helpers
// ---------------------------------------------------------------------------------------------------

/**
 * Noise samples, DC-free and peak-normalised to ±1. The tail is cross-faded into the head so the
 * buffer loops without a click.
 * @param {'white'|'pink'|'brown'} color
 * @param {number} length samples
 * @param {() => number} rng uniform [0,1)
 * @returns {Float32Array}
 */
export function makeNoise(color, length, rng = Math.random) {
  const fade = Math.max(1, Math.min(2048, length >> 3));
  const n = length + fade;
  const d = new Float32Array(n);
  if (color === 'pink') {
    // Paul Kellet's refined pink filter (−3 dB/octave, ±0.05 dB above 9 Hz).
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < n; i++) {
      const w = rng() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.016898;
      d[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
      b6 = w * 0.115926;
    }
  } else if (color === 'brown') {
    // Leaky integrator (−6 dB/octave); the leak keeps it from drifting.
    let last = 0;
    for (let i = 0; i < n; i++) {
      last = (last + 0.02 * (rng() * 2 - 1)) / 1.02;
      d[i] = last;
    }
  } else {
    for (let i = 0; i < n; i++) d[i] = rng() * 2 - 1;
  }
  let mean = 0;
  for (let i = 0; i < n; i++) mean += d[i];
  mean /= n;
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = d[i] - mean;
  // Equal-power cross-fade: sample 0 continues the sequence right after sample length-1.
  for (let i = 0; i < fade && i < length; i++) {
    const k = (i / fade) * (Math.PI / 2);
    out[i] = out[i] * Math.sin(k) + (d[length + i] - mean) * Math.cos(k);
  }
  let peak = 0;
  for (let i = 0; i < length; i++) {
    const a = out[i] < 0 ? -out[i] : out[i];
    if (a > peak) peak = a;
  }
  const s = peak > 0 ? 1 / peak : 1;
  for (let i = 0; i < length; i++) out[i] *= s;
  return out;
}

/**
 * Stereo reverb impulse response: a few early reflections, then exponentially decaying noise
 * (−60 dB at `seconds`) whose high frequencies die faster (time-varying one-pole lowpass), with a
 * soft onset. Left/right are decorrelated. Peak-normalised (ConvolverNode.normalize handles loudness).
 * @returns {[Float32Array, Float32Array]}
 */
export function makeImpulse(sampleRate, seconds, {
  rng = Math.random, preDelay = 0.01, attack = 0.015, brightness = 7000, darkening = 0.12, early = 8,
} = {}) {
  const len = Math.max(2, Math.floor(sampleRate * seconds));
  const pre = Math.min(len - 1, Math.floor(preDelay * sampleRate));
  const tail = Math.max(1e-3, seconds - preDelay);
  const chans = [new Float32Array(len), new Float32Array(len)];
  for (const d of chans) {
    let lp = 0;
    let lp2 = 0;
    for (let i = pre; i < len; i++) {
      const t = (i - pre) / sampleRate;
      const x = t / tail;
      const env = Math.pow(10, -3 * x) * Math.min(1, t / attack);
      const fc = brightness * Math.pow(darkening, x) + 250;
      const a = 1 - Math.exp(-TAU * fc / sampleRate);
      lp += a * ((rng() * 2 - 1) - lp);
      lp2 += a * (lp - lp2);
      d[i] = lp2 * env;
    }
    // Early reflections relative to the tail level right after the onset.
    let ref = 0;
    const n0 = Math.min(len, pre + Math.floor(0.05 * sampleRate));
    for (let i = pre; i < n0; i++) ref += d[i] * d[i];
    ref = Math.sqrt(ref / Math.max(1, n0 - pre));
    for (let e = 0; e < early; e++) {
      const tt = preDelay + 0.003 + rng() * 0.05;
      const i = Math.floor(tt * sampleRate);
      if (i < len) d[i] += (rng() < 0.5 ? -1 : 1) * ref * (2 + rng() * 4) * Math.pow(10, -3 * tt / seconds);
    }
    let peak = 0;
    for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(d[i]));
    if (peak > 0) for (let i = 0; i < len; i++) d[i] /= peak;
  }
  return chans;
}

/**
 * Positional parameters of a sound at (x, y, z) heard by a listener at (lx, ly, lz) looking along
 * `yaw` (SPEC §4: forward = (−sin yaw, 0, −cos yaw), right = (cos yaw, 0, −sin yaw)).
 * Minecraft uses OpenAL's linear clamped model: gain = 1 − distance / range, silent beyond `range`.
 * Pan follows the lateral offset (centred for sources at the listener), sources behind and far away
 * are slightly darker (lowpass cutoff in Hz).
 * @returns {{ gain: number, pan: number, lowpass: number, distance: number }}
 */
export function spatialize(lx, ly, lz, yaw, x, y, z, range, out = {}) {
  const dx = x - lx, dy = y - ly, dz = z - lz;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  out.distance = dist;
  if (!(dist < range)) {
    out.gain = 0; out.pan = 0; out.lowpass = 20000;
    return out;
  }
  const s = Math.sin(yaw), c = Math.cos(yaw);
  const side = dx * c - dz * s;
  const front = -dx * s - dz * c;
  out.gain = 1 - dist / range;
  out.pan = clamp(side / Math.max(dist, 1.5), -1, 1) * 0.9;
  const behind = front < 0 ? clamp(-front / Math.max(dist, 1), 0, 1) : 0;
  out.lowpass = Math.max(2500, 20000 * (1 - 0.5 * dist / range) * (1 - 0.5 * behind * clamp(dist / 4, 0, 1)));
  return out;
}

/** Peak / RMS / audible length of an AudioBuffer-like object ({ numberOfChannels, getChannelData, sampleRate }). */
export function analyzeBuffer(buffer, { floorDb = -60 } = {}) {
  let peak = 0, sum = 0, n = 0, last = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i++) {
      const a = d[i] < 0 ? -d[i] : d[i];
      if (a > peak) peak = a;
      sum += d[i] * d[i];
    }
    n += d.length;
  }
  const floor = peak * Math.pow(10, floorDb / 20);
  let first = -1;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i++) {
      if (Math.abs(d[i]) > floor) {
        if (first < 0 || i < first) first = i;
        if (i > last) last = i;
      }
    }
  }
  // RMS over the audible part only (the rendered buffer is usually longer than the sound).
  let asum = 0, an = 0;
  if (first >= 0) {
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const d = buffer.getChannelData(c);
      for (let i = first; i <= last; i++) asum += d[i] * d[i];
      an += last - first + 1;
    }
  }
  const rms = an ? Math.sqrt(asum / an) : 0;
  const db = (v) => (v > 0 ? 20 * Math.log10(v) : -Infinity);
  return {
    peak, rms, peakDb: db(peak), rmsDb: db(rms), totalRms: n ? Math.sqrt(sum / n) : 0,
    start: first < 0 ? 0 : first / buffer.sampleRate,
    length: first < 0 ? 0 : (last - first) / buffer.sampleRate,
  };
}

// ---------------------------------------------------------------------------------------------------
// SynthKit: per-context node helpers shared by every recipe
// ---------------------------------------------------------------------------------------------------

const noiseCache = new Map(); // `${color}@${sampleRate}` -> AudioBuffer (AudioBuffers are not bound to a context)

function getNoiseBuffer(ctx, color) {
  const key = color + '@' + ctx.sampleRate;
  let buf = noiseCache.get(key);
  if (!buf) {
    const len = Math.floor(ctx.sampleRate * NOISE_SECONDS);
    const data = makeNoise(color, len, mulberry32(color === 'white' ? 0x5eed1 : color === 'pink' ? 0x5eed2 : 0x5eed3));
    buf = ctx.createBuffer(1, len, ctx.sampleRate);
    buf.getChannelData(0).set(data);
    noiseCache.set(key, buf);
  }
  return buf;
}

/**
 * Node factory bound to one BaseAudioContext. Recipes only talk to the context through a kit, so the
 * same recipe renders in the live AudioContext and in an OfflineAudioContext.
 */
export class SynthKit {
  /** @param {BaseAudioContext} ctx  @param {() => number} rng */
  constructor(ctx, rng = Math.random) {
    this.ctx = ctx;
    this.rng = rng;
    this.nyquist = ctx.sampleRate / 2;
    this.noise = {
      white: getNoiseBuffer(ctx, 'white'),
      pink: getNoiseBuffer(ctx, 'pink'),
      brown: getNoiseBuffer(ctx, 'brown'),
    };
    /** When set to an array, every started source node is pushed into it (voice stealing stops them). */
    this.sources = null;
  }

  r(lo = 0, hi = 1) { return lo + (hi - lo) * this.rng(); }
  ri(lo, hi) { return lo + Math.min(hi - lo, Math.floor(this.rng() * (hi - lo + 1))); }
  chance(p) { return this.rng() < p; }
  pick(arr) { return arr[Math.min(arr.length - 1, Math.floor(this.rng() * arr.length))]; }
  /** Clamp a frequency to the valid (positive, below Nyquist) range. */
  hz(f) { return clamp(finite(f, 1000), 10, this.nyquist * 0.95); }

  gain(value, dest) {
    const g = this.ctx.createGain();
    g.gain.value = value;
    if (dest) g.connect(dest);
    return g;
  }

  filter(type, freq, q = 0.707, dest) {
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = this.hz(freq);
    f.Q.value = q;
    if (dest) f.connect(dest);
    return f;
  }

  /**
   * GainNode with an attack/hold/decay envelope connected to `dest`: 0 -> peak in `a` s (linear),
   * hold, then exponential decay reaching -60 dB after `d` s.
   */
  env(dest, t, a, d, peak, hold = 0) {
    const g = this.ctx.createGain();
    const p = g.gain;
    a = Math.max(5e-4, a);
    p.setValueAtTime(0, t);
    p.linearRampToValueAtTime(peak, t + a);
    if (hold > 0) p.setValueAtTime(peak, t + a + hold);
    p.setTargetAtTime(0, t + a + hold, Math.max(1e-3, d) / 6.9);
    g.connect(dest);
    return g;
  }

  /** Looping noise source starting at a random offset; plays [t, t + dur]. */
  noiseSource(color, t, dur, rate = 1) {
    const s = this.ctx.createBufferSource();
    const buf = this.noise[color] ?? this.noise.white;
    s.buffer = buf;
    s.loop = true;
    s.playbackRate.value = clamp(finite(rate, 1), 0.05, 16);
    s.start(t, this.rng() * buf.duration * 0.95);
    s.stop(t + Math.max(0.005, dur));
    if (this.sources) this.sources.push(s);
    return s;
  }

  /** Oscillator playing [t, t + dur]; the frequency is set with an automation event at `t`. */
  osc(type, freq, t, dur) {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(this.hz(freq), t);
    o.start(t);
    o.stop(t + Math.max(0.005, dur));
    if (this.sources) this.sources.push(o);
    return o;
  }
}

function chain(a, b) {
  a.connect(b);
  return b;
}

/**
 * Filtered noise burst. o: { c color, ft filter type ('none' = unfiltered), f, q, f1 sweep target,
 * sw sweep time, a attack, hold, d decay to -60 dB, g peak gain, rate, hp, lp }. Returns the end time.
 */
function nz(k, out, t, o) {
  const a = Math.max(5e-4, o.a ?? 0.002);
  const d = Math.max(0.005, o.d ?? 0.1);
  const hold = o.hold ?? 0;
  const end = t + a + hold + d;
  let node = k.noiseSource(o.c ?? 'white', t, end - t + 0.02, o.rate ?? 1);
  if (o.ft !== 'none') {
    const f = k.filter(o.ft ?? 'bandpass', o.f ?? 1000, o.q ?? 0.9);
    if (o.f1) {
      f.frequency.setValueAtTime(k.hz(o.f ?? 1000), t);
      f.frequency.exponentialRampToValueAtTime(k.hz(o.f1), t + (o.sw ?? a + hold + d));
    }
    node = chain(node, f);
  }
  if (o.hp) node = chain(node, k.filter('highpass', o.hp, 0.7));
  if (o.lp) node = chain(node, k.filter('lowpass', o.lp, 0.7));
  node.connect(k.env(out, t, a, d, o.g ?? 0.5, hold));
  return end;
}

/**
 * Oscillator tone. o: { w wave, f, f1 glide target, gl glide time, a, hold, d, g, det cents, lp }.
 * Returns the end time.
 */
function tone(k, out, t, o) {
  const a = Math.max(5e-4, o.a ?? 0.002);
  const d = Math.max(0.005, o.d ?? 0.2);
  const hold = o.hold ?? 0;
  const end = t + a + hold + d;
  const osc = k.osc(o.w ?? 'sine', o.f, t, end - t + 0.02);
  if (o.f1) osc.frequency.exponentialRampToValueAtTime(k.hz(o.f1), t + (o.gl ?? a + hold + d));
  if (o.det) osc.detune.value = o.det;
  let node = osc;
  if (o.lp) node = chain(node, k.filter('lowpass', o.lp, o.lq ?? 0.7));
  node.connect(k.env(out, t, a, d, o.g ?? 0.3, hold));
  return end;
}

/**
 * Grain cloud: `n` tiny noise grains spread over [t, t + spread] through ONE filter whose centre
 * frequency jumps per grain, amplitude from one precomputed gain curve -> 3-5 nodes for any number of
 * grains. o: { n, spread, skew (>1 clusters grains early), c, ft, f: [lo, hi], q, a, d: [lo, hi],
 * g: [lo, hi], fall (s, exponential falloff of grain gains), hp, lp }. Returns the end time.
 */
function crunch(k, out, t, o) {
  const n = Math.max(1, Math.round(o.n));
  const a = o.a ?? 0.0008;
  const spread = Math.max(0.001, o.spread);
  const dur = spread + a + o.d[1] + 0.004;
  const len = Math.ceil(dur * CURVE_RATE) + 2;
  const curve = new Float32Array(len);
  const fil = k.filter(o.ft ?? 'bandpass', o.f[0], o.q ?? 1.2);
  const times = new Float64Array(n);
  for (let i = 0; i < n; i++) times[i] = Math.pow(k.rng(), o.skew ?? 1) * spread;
  times.sort();
  for (let i = 0; i < n; i++) {
    const gt = times[i];
    const gd = k.r(o.d[0], o.d[1]);
    let gg = k.r(o.g[0], o.g[1]);
    if (o.fall) gg *= Math.exp(-gt / o.fall);
    const j0 = Math.ceil(gt * CURVE_RATE);
    const j1 = Math.min(len - 1, Math.ceil((gt + a + gd) * CURVE_RATE));
    for (let j = j0; j <= j1; j++) {
      const tt = j / CURVE_RATE - gt;
      curve[j] += gg * (tt < a ? tt / a : Math.exp(-6.9 * (tt - a) / gd));
    }
    fil.frequency.setValueAtTime(k.hz(k.r(o.f[0], o.f[1])), t + gt);
  }
  curve[0] = 0;
  curve[len - 1] = 0;
  const curveDur = (len - 1) / CURVE_RATE;
  let node = chain(k.noiseSource(o.c ?? 'white', t, curveDur + 0.01, o.rate ?? 1), fil);
  if (o.hp) node = chain(node, k.filter('highpass', o.hp, 0.7));
  if (o.lp) node = chain(node, k.filter('lowpass', o.lp, 0.7));
  const g = k.ctx.createGain();
  g.gain.value = 0;
  g.gain.setValueCurveAtTime(curve, t, curveDur);
  node.connect(g);
  g.connect(out);
  return t + curveDur;
}

/** Water bubble: a sine whose pitch rises while it decays (shrinking bubble resonance). */
function bubble(k, out, t, f, d, g) {
  return tone(k, out, t, { f, f1: f * k.r(1.4, 2.2), gl: d, a: 0.002, d, g });
}

/**
 * Voiced sound: oscillator(s) through parallel formant bandpasses with an overall envelope.
 * o: { w, f: [[time, hz], ...] pitch contour (exponential segments), formants: [[f, q, g, f1?], ...]
 * (f1 = linear formant glide over the sound), a, hold, d, g, det (2nd oscillator detune, cents),
 * vib: [rate Hz, depth cents], am: [rate Hz, depth 0..1] (growl / bleat), breath (aspiration noise
 * gain), lp }. Returns the end time.
 */
function voice(k, out, t, o) {
  const a = Math.max(5e-4, o.a ?? 0.01);
  const hold = o.hold ?? 0;
  const d = o.d ?? 0.2;
  const dur = a + hold + d;
  const end = t + dur;
  let target = k.env(out, t, a, d, o.g ?? 0.5, hold);
  if (o.lp) target = k.filter('lowpass', o.lp, 0.7, target);
  if (o.am) {
    const amg = k.gain(1 - o.am[1] / 2, target);
    const lfo = k.osc(o.amw ?? 'sine', o.am[0], t, dur + 0.02);
    lfo.connect(k.gain(o.am[1] / 2, amg.gain));
    target = amg;
  }
  const bus = k.gain(1);
  for (const [f, q, g, f1] of o.formants) {
    const bp = k.filter('bandpass', f, q);
    if (f1) {
      bp.frequency.setValueAtTime(k.hz(f), t);
      bp.frequency.linearRampToValueAtTime(k.hz(f1), end);
    }
    bus.connect(bp);
    bp.connect(k.gain(g, target));
  }
  let vib = null;
  if (o.vib) {
    vib = k.gain(o.vib[1]);
    k.osc('sine', o.vib[0], t, dur + 0.02).connect(vib);
  }
  const n = o.det ? 2 : 1;
  for (let i = 0; i < n; i++) {
    const osc = k.osc(o.w ?? 'sawtooth', o.f[0][1], t, dur + 0.02);
    for (let j = 1; j < o.f.length; j++) {
      osc.frequency.exponentialRampToValueAtTime(k.hz(o.f[j][1]), t + Math.min(o.f[j][0], dur));
    }
    if (i === 1) osc.detune.value = o.det;
    if (vib) vib.connect(osc.detune);
    osc.connect(bus);
  }
  if (o.breath) k.noiseSource('pink', t, dur + 0.02).connect(k.gain(o.breath, bus));
  return end;
}

// ---------------------------------------------------------------------------------------------------
// Block material recipes. Like Minecraft's SoundType every material has a `dig` sound (used for break
// and place) and a `step` sound (used for step, hit = step at half pitch, land = step at 0.75 pitch).
// Signature: (kit, out, t, p, kind) -> end time; p = pitch factor (frequencies x p, durations / p,
// exactly what replaying a sample faster does).
// ---------------------------------------------------------------------------------------------------

function digStone(k, out, t, p, kind) {
  const T = (s) => s / p, F = (f) => f * p;
  // Bright impact + gritty crumbling fragments over a small low thud (pick on rubble).
  let end = nz(k, out, t, { c: 'white', f: F(k.r(1900, 2600)), q: 0.6, a: 0.0006, d: T(0.05), g: 0.55 });
  end = Math.max(end, crunch(k, out, t, {
    n: k.ri(10, 14), spread: T(0.11), skew: 1.5, f: [F(900), F(4500)], q: 1.5,
    d: [T(0.008), T(0.03)], g: [0.3, 0.7], fall: T(0.07),
  }));
  end = Math.max(end, nz(k, out, t, { c: 'brown', ft: 'lowpass', f: F(600), q: 0.7, a: 0.0012, d: T(0.09), g: 0.45 }));
  end = Math.max(end, tone(k, out, t, { f: F(k.r(100, 125)), f1: F(65), gl: T(0.06), a: 0.0015, d: T(0.07), g: 0.12 }));
  if (kind === 'break') {
    end = Math.max(end, crunch(k, out, t + T(0.04), {
      n: k.ri(6, 9), spread: T(0.15), skew: 1.3, f: [F(800), F(3500)], q: 1.4,
      d: [T(0.01), T(0.03)], g: [0.12, 0.32], fall: T(0.1),
    }));
  }
  return end;
}

function stepStone(k, out, t, p) {
  const T = (s) => s / p, F = (f) => f * p;
  // Hard-soled "tk": clicky transient, a few grains of grit, a little sole thud.
  let end = nz(k, out, t, { c: 'white', f: F(k.r(2600, 3400)), q: 0.9, a: 0.0005, d: T(0.03), g: 0.6 });
  end = Math.max(end, crunch(k, out, t, {
    n: k.ri(3, 5), spread: T(0.03), skew: 1.3, f: [F(1500), F(5000)], q: 1.8,
    d: [T(0.005), T(0.015)], g: [0.25, 0.5],
  }));
  end = Math.max(end, nz(k, out, t, { c: 'brown', ft: 'lowpass', f: F(400), q: 0.7, a: 0.001, d: T(0.04), g: 0.35 }));
  return end;
}

/**
 * Hollow wooden knock: a few inharmonic plate modes with a slight pitch drop, resonant noise around
 * them (the woody colour) — f0 already includes the pitch factor.
 */
function knock(k, out, t, f0, decay, g) {
  let end = t;
  const modes = [[1, 1, 1], [k.r(2.0, 2.3), 0.65, 0.6], [k.r(3.2, 3.6), 0.4, 0.45], [k.r(4.8, 5.4), 0.25, 0.3]];
  for (const [ratio, gm, dm] of modes) {
    const f = f0 * ratio;
    end = Math.max(end, tone(k, out, t, { f, f1: f * 0.96, gl: decay * dm, a: 0.001, d: decay * dm, g: g * gm }));
  }
  return Math.max(end, nz(k, out, t, { c: 'pink', f: f0 * 2.1, q: 2.2, a: 0.001, d: decay * 0.5, g: g * 1.6 }));
}

function digWood(k, out, t, p, kind) {
  const T = (s) => s / p, F = (f) => f * p;
  let end = knock(k, out, t, F(k.r(230, 300)), T(0.11), 0.22);
  end = Math.max(end, nz(k, out, t, { c: 'white', f: F(2400), q: 0.8, a: 0.0005, d: T(0.018), g: 0.35 }));
  end = Math.max(end, nz(k, out, t, { c: 'brown', ft: 'lowpass', f: F(450), a: 0.001, d: T(0.06), g: 0.35 }));
  end = Math.max(end, crunch(k, out, t, {
    n: k.ri(4, 7), spread: T(0.07), skew: 1.3, f: [F(1100), F(3200)], q: 2.2,
    d: [T(0.008), T(0.022)], g: [0.15, 0.4],
  }));
  if (kind === 'break') {
    // Splintering fibres and a second, smaller knock as the block gives way.
    end = Math.max(end, crunch(k, out, t + T(0.03), {
      n: k.ri(6, 9), spread: T(0.14), skew: 1.2, f: [F(900), F(2800)], q: 2.8,
      d: [T(0.01), T(0.025)], g: [0.12, 0.3], fall: T(0.1),
    }));
    end = Math.max(end, knock(k, out, t + T(k.r(0.05, 0.08)), F(k.r(260, 340)), T(0.07), 0.1));
  }
  return end;
}

function stepWood(k, out, t, p) {
  const T = (s) => s / p, F = (f) => f * p;
  let end = knock(k, out, t, F(k.r(330, 420)), T(0.06), 0.2);
  end = Math.max(end, nz(k, out, t, { c: 'white', f: F(3000), q: 0.9, a: 0.0005, d: T(0.012), g: 0.3 }));
  end = Math.max(end, nz(k, out, t, { c: 'brown', ft: 'lowpass', f: F(350), a: 0.001, d: T(0.04), g: 0.3 }));
  return end;
}

function digGravel(k, out, t, p, kind) {
  const T = (s) => s / p, F = (f) => f * p;
  let end = nz(k, out, t, { c: 'brown', ft: 'lowpass', f: F(900), q: 0.7, a: 0.004, d: T(0.16), g: 0.45 });
  end = Math.max(end, crunch(k, out, t, {
    n: k.ri(16, 22), spread: T(0.15), skew: 1.3, f: [F(800), F(3600)], q: 1.3,
    d: [T(0.008), T(0.03)], g: [0.25, 0.7], fall: T(0.12),
  }));
  end = Math.max(end, crunch(k, out, t, {
    n: k.ri(8, 12), spread: T(0.12), skew: 1.2, f: [F(3000), F(6500)], q: 2,
    d: [T(0.004), T(0.012)], g: [0.1, 0.3],
  }));
  if (kind === 'break') {
    end = Math.max(end, crunch(k, out, t + T(0.08), {
      n: k.ri(6, 9), spread: T(0.15), skew: 1.1, f: [F(1000), F(4000)], q: 1.5,
      d: [T(0.006), T(0.02)], g: [0.08, 0.2], fall: T(0.1),
    }));
  }
  return end;
}

function stepGravel(k, out, t, p) {
  const T = (s) => s / p, F = (f) => f * p;
  let end = nz(k, out, t, { c: 'brown', ft: 'lowpass', f: F(700), q: 0.7, a: 0.003, d: T(0.08), g: 0.4 });
  end = Math.max(end, crunch(k, out, t, {
    n: k.ri(9, 13), spread: T(0.07), skew: 1.2, f: [F(900), F(3800)], q: 1.4,
    d: [T(0.006), T(0.022)], g: [0.25, 0.65], fall: T(0.06),
  }));
  return end;
}

function digGrass(k, out, t, p) {
  const T = (s) => s / p, F = (f) => f * p;
  let end = nz(k, out, t, {
    c: 'pink', f: F(k.r(3800, 4600)), f1: F(2400), q: 0.6, a: 0.003, d: T(0.17), g: 0.5, hp: F(1400),
  });
  end = Math.max(end, crunch(k, out, t, {
    n: k.ri(9, 13), spread: T(0.12), skew: 1.4, f: [F(2500), F(6500)], q: 1,
    d: [T(0.005), T(0.02)], g: [0.2, 0.5], fall: T(0.1),
  }));
  end = Math.max(end, nz(k, out, t, { c: 'brown', ft: 'lowpass', f: F(260), a: 0.002, d: T(0.05), g: 0.15 }));
  return end;
}

function stepGrass(k, out, t, p) {
  const T = (s) => s / p, F = (f) => f * p;
  let end = nz(k, out, t, {
    c: 'pink', f: F(k.r(2800, 3800)), f1: F(2000), q: 0.6, a: 0.005, d: T(0.08), g: 0.45, hp: F(1200),
  });
  end = Math.max(end, crunch(k, out, t, {
    n: k.ri(4, 6), spread: T(0.05), f: [F(2500), F(6000)], q: 1, d: [T(0.004), T(0.014)], g: [0.15, 0.4],
  }));
  return end;
}

function digSand(k, out, t, p) {
  const T = (s) => s / p, F = (f) => f * p;
  let end = nz(k, out, t, { c: 'pink', f: F(k.r(2600, 3400)), f1: F(1800), q: 0.7, a: T(0.012), d: T(0.2), g: 0.5 });
  end = Math.max(end, crunch(k, out, t, {
    n: k.ri(12, 18), spread: T(0.16), f: [F(3500), F(8000)], q: 0.9, d: [T(0.003), T(0.009)], g: [0.06, 0.18],
  }));
  end = Math.max(end, nz(k, out, t, { c: 'brown', ft: 'lowpass', f: F(320), a: 0.006, d: T(0.09), g: 0.18 }));
  return end;
}

function stepSand(k, out, t, p) {
  const T = (s) => s / p, F = (f) => f * p;
  let end = nz(k, out, t, { c: 'pink', f: F(k.r(2000, 2600)), f1: F(1500), q: 0.6, a: T(0.01), d: T(0.1), g: 0.45 });
  end = Math.max(end, crunch(k, out, t, {
    n: k.ri(5, 7), spread: T(0.06), f: [F(3000), F(7000)], q: 0.9, d: [T(0.003), T(0.008)], g: [0.05, 0.14],
  }));
  return end;
}

function shatter(k, out, t, p) {
  const T = (s) => s / p, F = (f) => f * p;
  let end = nz(k, out, t, { c: 'white', ft: 'highpass', f: F(1800), q: 0.7, a: 0.0005, d: T(0.06), g: 0.55 });
  end = Math.max(end, nz(k, out, t, { c: 'white', f: F(6500), q: 0.7, a: 0.002, d: T(0.3), g: 0.22 }));
  const pings = k.ri(10, 14);
  for (let i = 0; i < pings; i++) {
    const tt = t + Math.pow(k.rng(), 1.8) * T(0.28);
    const f = F(k.r(1800, 7000));
    end = Math.max(end, tone(k, out, tt, { f, a: 0.0008, d: T(k.r(0.06, 0.4)), g: k.r(0.04, 0.12) }));
    if (k.chance(0.5)) tone(k, out, tt, { f: f * k.r(1.5, 2.8), a: 0.0008, d: T(k.r(0.04, 0.2)), g: k.r(0.02, 0.06) });
  }
  end = Math.max(end, crunch(k, out, t, {
    n: 10, spread: T(0.3), skew: 1.5, f: [F(4000), F(9000)], q: 4, d: [T(0.004), T(0.015)],
    g: [0.1, 0.35], fall: T(0.15),
  }));
  end = Math.max(end, nz(k, out, t, { c: 'brown', ft: 'lowpass', f: F(280), a: 0.0015, d: T(0.07), g: 0.25 }));
  return end;
}

function digGlass(k, out, t, p, kind) {
  if (kind === 'break') return shatter(k, out, t, p);
  // Minecraft places glass with the stone dig sound; a faint ping keeps it glassy.
  const end = digStone(k, out, t, p, kind);
  tone(k, out, t, { f: p * k.r(2500, 4000), a: 0.0008, d: 0.12 / p, g: 0.035 });
  return end;
}

function stepGlass(k, out, t, p, kind) {
  const end = stepStone(k, out, t, p, kind);
  tone(k, out, t, { f: p * k.r(3000, 4500), a: 0.0008, d: 0.06 / p, g: 0.03 });
  return end;
}

function digWool(k, out, t, p) {
  const T = (s) => s / p, F = (f) => f * p;
  let end = nz(k, out, t, { c: 'brown', ft: 'lowpass', f: F(480), q: 0.6, a: T(0.008), d: T(0.16), g: 1 });
  end = Math.max(end, nz(k, out, t, { c: 'pink', ft: 'lowpass', f: F(1400), q: 0.6, a: T(0.012), d: T(0.11), g: 0.1 }));
  end = Math.max(end, tone(k, out, t, { f: F(85), f1: F(55), gl: T(0.08), a: T(0.006), d: T(0.09), g: 0.18 }));
  return end;
}

function stepWool(k, out, t, p) {
  const T = (s) => s / p, F = (f) => f * p;
  let end = nz(k, out, t, { c: 'brown', ft: 'lowpass', f: F(400), q: 0.6, a: T(0.01), d: T(0.09), g: 0.85 });
  end = Math.max(end, nz(k, out, t, { c: 'pink', ft: 'lowpass', f: F(1100), q: 0.6, a: T(0.01), d: T(0.07), g: 0.08 }));
  return end;
}

function digSnow(k, out, t, p) {
  const T = (s) => s / p, F = (f) => f * p;
  let end = nz(k, out, t, { c: 'pink', f: F(1100), q: 0.7, a: T(0.01), d: T(0.17), g: 0.4 });
  end = Math.max(end, crunch(k, out, t, {
    n: k.ri(12, 16), spread: T(0.14), skew: 1.2, f: [F(1100), F(2800)], q: 4.5,
    d: [T(0.01), T(0.03)], g: [0.2, 0.5], fall: T(0.12),
  }));
  end = Math.max(end, nz(k, out, t, { c: 'brown', ft: 'lowpass', f: F(350), a: 0.004, d: T(0.08), g: 0.3 }));
  return end;
}

function stepSnow(k, out, t, p) {
  const T = (s) => s / p, F = (f) => f * p;
  let end = nz(k, out, t, { c: 'pink', f: F(1000), q: 0.7, a: T(0.008), d: T(0.09), g: 0.35 });
  end = Math.max(end, crunch(k, out, t, {
    n: k.ri(6, 9), spread: T(0.07), f: [F(1100), F(2600)], q: 4.5, d: [T(0.008), T(0.025)], g: [0.2, 0.45],
  }));
  end = Math.max(end, nz(k, out, t, { c: 'brown', ft: 'lowpass', f: F(300), a: 0.003, d: T(0.05), g: 0.25 }));
  return end;
}

// Partial ratios of a struck free metal bar / plate (inharmonic -> metallic).
const METAL_RATIOS = [1, 2.32, 4.25, 6.63, 9.38];

// Relative partial levels: the upper partials carry the "clank" (a dominant fundamental = a bell).
const METAL_LEVELS = [0.6, 1, 0.8, 0.55, 0.35];

function clank(k, out, t, f0, decay, g, partials = 5) {
  let end = t;
  for (let i = 0; i < partials; i++) {
    const f = f0 * METAL_RATIOS[i] * k.r(0.985, 1.015);
    if (f > k.nyquist * 0.9) break;
    const d = decay / (1 + 0.4 * i);
    const gi = g * METAL_LEVELS[i];
    end = Math.max(end, tone(k, out, t, { f, a: 0.0008, d, g: gi }));
    tone(k, out, t, { f: f * 1.0035, a: 0.0008, d: d * 0.8, g: gi * 0.5 }); // beating partner
  }
  return end;
}

function digMetal(k, out, t, p, kind) {
  const T = (s) => s / p, F = (f) => f * p;
  let end = nz(k, out, t, { c: 'white', f: F(3500), q: 0.8, a: 0.0005, d: T(0.035), g: 0.5 });
  end = Math.max(end, crunch(k, out, t, {
    n: k.ri(4, 6), spread: T(0.05), skew: 1.4, f: [F(2000), F(6000)], q: 2, d: [T(0.005), T(0.015)], g: [0.2, 0.4],
  }));
  end = Math.max(end, nz(k, out, t, { c: 'brown', ft: 'lowpass', f: F(350), a: 0.0012, d: T(0.06), g: 0.35 }));
  end = Math.max(end, clank(k, out, t, F(k.r(520, 680)), T(kind === 'break' ? 0.4 : 0.3), 0.1));
  if (kind === 'break') {
    end = Math.max(end, crunch(k, out, t + T(0.02), {
      n: 5, spread: T(0.1), f: [F(3000), F(6000)], q: 6, d: [T(0.006), T(0.02)], g: [0.1, 0.25],
    }));
  }
  return end;
}

function stepMetal(k, out, t, p) {
  const T = (s) => s / p, F = (f) => f * p;
  let end = nz(k, out, t, { c: 'white', f: F(3600), q: 1, a: 0.0005, d: T(0.022), g: 0.45 });
  end = Math.max(end, nz(k, out, t, { c: 'brown', ft: 'lowpass', f: F(300), a: 0.001, d: T(0.04), g: 0.35 }));
  end = Math.max(end, clank(k, out, t, F(k.r(900, 1200)), T(0.09), 0.05, 3));
  return end;
}

function digWater(k, out, t, p, kind) {
  const T = (s) => s / p, F = (f) => f * p;
  let end;
  if (kind === 'place') {
    // Bucket emptied: a pour with low glugging bubbles.
    end = nz(k, out, t, { c: 'pink', f: F(1100), f1: F(700), q: 0.8, a: T(0.04), hold: T(0.12), d: T(0.35), g: 0.4 });
    end = Math.max(end, nz(k, out, t, { c: 'white', ft: 'highpass', f: F(2500), a: T(0.02), d: T(0.25), g: 0.12 }));
    const n = k.ri(6, 9);
    for (let i = 0; i < n; i++) {
      end = Math.max(end, bubble(k, out, t + T(k.r(0, 0.4)), F(k.r(180, 420)), T(k.r(0.05, 0.12)), k.r(0.08, 0.16)));
    }
  } else {
    // Bucket filled / water scooped (and every other kind): a short "gloop".
    end = nz(k, out, t, { c: 'pink', f: F(500), f1: F(1400), q: 1.2, a: T(0.02), d: T(0.25), g: 0.35 });
    const n = k.ri(4, 6);
    for (let i = 0; i < n; i++) {
      end = Math.max(end, bubble(k, out, t + T(k.r(0, 0.22)), F(k.r(250, 600)), T(k.r(0.04, 0.09)), k.r(0.12, 0.22)));
    }
  }
  return end;
}

function stepWater(k, out, t, p) {
  const T = (s) => s / p, F = (f) => f * p;
  let end = nz(k, out, t, { c: 'white', f: F(1500), f1: F(900), q: 0.7, a: T(0.005), d: T(0.12), g: 0.35 });
  for (let i = 0; i < 2; i++) {
    end = Math.max(end, bubble(k, out, t + T(k.r(0, 0.05)), F(k.r(400, 900)), T(0.05), 0.1));
  }
  return end;
}

/** material -> [dig recipe (break, place), step recipe (step, hit, land)] */
const MATERIAL_RECIPES = {
  stone: [digStone, stepStone],
  wood: [digWood, stepWood],
  gravel: [digGravel, stepGravel],
  grass: [digGrass, stepGrass],
  sand: [digSand, stepSand],
  glass: [digGlass, stepGlass],
  wool: [digWool, stepWool],
  snow: [digSnow, stepSnow],
  metal: [digMetal, stepMetal],
  water: [digWater, stepWater],
};

/**
 * Level trims in dB per material for [break, place, step, hit, land], calibrated with
 * tools/audio-calibrate.mjs (max 100 ms A-weighted loudness, 4-5 variations each, measured through the
 * settled master limiter — renderSoundOffline plays after a silent pre-roll, i.e. what the player hears)
 * to the targets break -28, place -29, step -40, hit -37, land -34 LA; soft materials (grass, sand, snow,
 * water) 1 dB and wool 2 dB lower, glass shatter -25 and metal break -27 (re-run the tool after editing a
 * recipe; its check() compares every sound with its target).
 */
const BLOCK_TRIM_DB = {
  stone: [-1.7, -1.4, 2, 1.5, 1.3],
  wood: [0.3, 0.5, 0.7, 2.1, 1.7],
  gravel: [-0.9, -1.1, 1.7, 3.4, 1.6],
  grass: [0.2, 0.3, 2.9, 1.8, 1.9],
  sand: [1.2, 1.1, 3.2, 1.6, 2.1],
  glass: [-6.9, -1.6, 1.5, 1.1, 0.7],
  wool: [-2.4, -2.1, 0.4, 3, 1.1],
  snow: [3, 2.9, 3.6, 4.1, 4.1],
  metal: [-6.5, -6.8, 1.7, 0.6, 0.8],
  water: [0.6, -2.2, -1, 0.7, -0.9],
};
const KIND_INDEX = { break: 0, place: 1, step: 2, hit: 3, land: 4 };

/**
 * Per-kind playback like Minecraft (break/place: dig at volume (v+1)/2, pitch 0.8; step: step sound at
 * 0.15 volume; hit: step at volume 0.25, pitch 0.5; land: step at volume 0.5, pitch 0.75).
 * `gain` values are relative to our recipes; `vary` = random pitch spread; `reverb` = send level.
 */
const KIND_PARAMS = {
  break: { step: false, gain: 1, pitch: 0.8, vary: 0.08, reverb: 0.12 },
  place: { step: false, gain: 0.9, pitch: 0.8, vary: 0.06, reverb: 0.1 },
  step: { step: true, gain: 0.3, pitch: 1, vary: 0.1, reverb: 0.06 },
  hit: { step: true, gain: 0.42, pitch: 0.5, vary: 0.05, reverb: 0.08 },
  land: { step: true, gain: 0.6, pitch: 0.75, vary: 0.05, reverb: 0.08 },
};

/** Extra low body thud for landings (feet hitting the ground), softer on soft materials. */
function landThud(k, out, t, material) {
  const soft = material === 'wool' || material === 'snow' || material === 'sand' || material === 'grass';
  return nz(k, out, t, { c: 'brown', ft: 'lowpass', f: soft ? 160 : 210, a: 0.003, d: 0.1, g: soft ? 0.35 : 0.5 });
}

// ---------------------------------------------------------------------------------------------------
// Named sounds. Same signature as the material recipes: (kit, out, t, p) -> end time.
// ---------------------------------------------------------------------------------------------------

/** UI button: crisp mechanical click. */
function sClick(k, out, t, p) {
  nz(k, out, t, { c: 'white', f: 3000 * p, q: 1.3, a: 0.0004, d: 0.014, g: 0.6 });
  tone(k, out, t, { w: 'triangle', f: 1750 * p, f1: 1150 * p, gl: 0.015, a: 0.0005, d: 0.03, g: 0.22 });
  return tone(k, out, t, { f: 420 * p, a: 0.0005, d: 0.02, g: 0.2 });
}

/** Item pickup: rising "bloop". */
function sPop(k, out, t, p) {
  nz(k, out, t, { c: 'white', ft: 'highpass', f: 2500, a: 0.0005, d: 0.008, g: 0.12 });
  return tone(k, out, t, { f: 330 * p, f1: 880 * p, gl: 0.04 / p, a: 0.001, d: 0.075 / p, g: 0.45 });
}

/** Player hurt: short "oof" — falling glottal pitch through rounded-vowel formants, breathy tail. */
function sHurt(k, out, t, p) {
  const T = (s) => s / p, F = (f) => f * p;
  const end = voice(k, out, t, {
    w: 'sawtooth', det: 9, f: [[0, F(170)], [T(0.035), F(182)], [T(0.2), F(105)]],
    formants: [[F(500), 5, 1, F(400)], [F(1000), 7, 0.55, F(800)], [F(2450), 9, 0.16]],
    a: T(0.012), hold: T(0.05), d: T(0.15), g: 0.9, breath: 0.25, lp: F(4000),
  });
  nz(k, out, t + T(0.11), { c: 'white', ft: 'highpass', f: F(2400), a: T(0.02), d: T(0.08), g: 0.06 });
  return end;
}

/** Player death: longer, deeper groan sliding down, then the body hitting the ground. */
function sDeath(k, out, t, p) {
  const T = (s) => s / p, F = (f) => f * p;
  let end = voice(k, out, t, {
    w: 'sawtooth', det: 11, f: [[0, F(150)], [T(0.08), F(162)], [T(0.6), F(78)]],
    formants: [[F(620), 5, 1, F(450)], [F(1150), 7, 0.5, F(800)], [F(2500), 9, 0.15]],
    a: T(0.02), hold: T(0.12), d: T(0.5), g: 0.9, breath: 0.3, am: [18, 0.35], lp: F(3500),
  });
  end = Math.max(end, nz(k, out, t + T(0.3), { c: 'brown', ft: 'lowpass', f: 190, a: 0.004, d: 0.25, g: 0.6 }));
  return end;
}

/** Big water splash: impact, spray, body and bubbles. */
function sSplash(k, out, t, p) {
  const T = (s) => s / p, F = (f) => f * p;
  let end = nz(k, out, t, { c: 'white', f: F(1200), f1: F(700), q: 0.6, a: 0.002, d: T(0.45), g: 0.5 });
  end = Math.max(end, nz(k, out, t, { c: 'white', ft: 'highpass', f: F(3500), a: T(0.01), d: T(0.6), g: 0.2 }));
  end = Math.max(end, nz(k, out, t, { c: 'brown', ft: 'lowpass', f: F(500), a: 0.003, d: T(0.25), g: 0.5 }));
  end = Math.max(end, crunch(k, out, t + T(0.02), {
    n: 14, spread: T(0.6), skew: 1.4, f: [F(2000), F(6000)], q: 3, d: [0.004, 0.015], g: [0.1, 0.3], fall: T(0.3),
  }));
  for (let i = 0; i < 8; i++) {
    end = Math.max(end, bubble(k, out, t + T(k.r(0.02, 0.5)), F(k.r(350, 1300)), T(k.r(0.03, 0.08)), k.r(0.04, 0.1)));
  }
  return end;
}

/** Swimming stroke: soft swell of water noise with a couple of bubbles. */
function sSwim(k, out, t, p) {
  const T = (s) => s / p, F = (f) => f * p;
  let end = nz(k, out, t, { c: 'pink', f: F(700), f1: F(1500), q: 0.8, a: T(0.08), d: T(0.32), g: 0.45 });
  end = Math.max(end, nz(k, out, t, { c: 'white', ft: 'highpass', f: F(3000), a: T(0.06), d: T(0.2), g: 0.06 }));
  const n = k.ri(2, 3);
  for (let i = 0; i < n; i++) {
    end = Math.max(end, bubble(k, out, t + T(k.r(0.05, 0.25)), F(k.r(300, 700)), T(k.r(0.04, 0.08)), k.r(0.05, 0.1)));
  }
  return end;
}

/** Explosion: blast crack, deep rumble, sub-bass drop, crackle and falling debris. */
function sExplode(k, out, t, p) {
  const T = (s) => s / p, F = (f) => f * p;
  let end = nz(k, out, t, { c: 'white', ft: 'highpass', f: F(250), a: 0.0008, d: T(0.35), g: 1 });
  end = Math.max(end, nz(k, out, t, {
    c: 'brown', ft: 'lowpass', f: F(220), f1: F(60), sw: T(1.5), q: 0.8, a: 0.004, d: T(2.8), g: 1.2,
  }));
  end = Math.max(end, tone(k, out, t, { f: F(58), f1: F(26), gl: T(0.7), a: 0.003, d: T(1.2), g: 0.45 }));
  end = Math.max(end, nz(k, out, t, { c: 'pink', f: F(450), q: 0.6, a: 0.002, d: T(1.1), g: 0.85 }));
  end = Math.max(end, crunch(k, out, t, {
    n: 36, spread: T(1.8), skew: 1.6, f: [F(1200), F(5000)], q: 2.5, d: [0.003, 0.014], g: [0.1, 0.45], fall: T(0.6),
  }));
  end = Math.max(end, crunch(k, out, t + T(0.1), {
    n: 20, spread: T(1.2), skew: 1.2, c: 'pink', f: [F(300), F(1200)], q: 1.5, d: [0.02, 0.06], g: [0.1, 0.3], fall: T(0.6),
  }));
  return end;
}

/** Sizzling hiss with flutter + crackle. o.swell: slow fade-in (creeper), o.crackle: crackle count. */
function hiss(k, out, t, p, o) {
  const T = (s) => s / p, F = (f) => f * p;
  const a = T(o.a), hold = T(o.hold), d = T(o.d);
  const env = k.env(out, t, a, d, o.g, hold);
  const flutter = k.gain(0.8, env);
  const dur = a + hold + d + 0.02;
  k.osc('sine', o.flutter, t, dur).connect(k.gain(0.12, flutter.gain));
  k.osc('sine', o.flutter * 1.618, t, dur).connect(k.gain(0.08, flutter.gain));
  const hp = k.filter('highpass', F(o.hp), 0.7);
  k.noiseSource('white', t, dur).connect(hp);
  hp.connect(k.filter('bandpass', F(o.bp), 0.5, flutter));
  let end = t + dur;
  if (o.crackle) {
    end = Math.max(end, crunch(k, out, t + a * 0.5, {
      n: o.crackle, spread: hold + d * 0.5, f: [F(2000), F(6000)], q: 3, d: [0.003, 0.01], g: [0.1, 0.3],
    }));
  }
  return end;
}

/** TNT fuse. */
function sFuse(k, out, t, p) {
  return hiss(k, out, t, p, { a: 0.03, hold: 1.1, d: 0.45, g: 0.45, hp: 3000, bp: 6000, flutter: 13, crackle: 18 });
}

/** Creeper about to explode: the fuse hiss swelling in. */
function sCreeperHiss(k, out, t, p) {
  return hiss(k, out, t, p, { a: 0.3, hold: 1.0, d: 0.3, g: 0.4, hp: 2500, bp: 4500, flutter: 9, crackle: 5 });
}

/** One chewing munch (call repeatedly while eating). */
function sEat(k, out, t, p) {
  const T = (s) => s / p, F = (f) => f * p;
  let end = nz(k, out, t, { c: 'brown', ft: 'lowpass', f: F(700), a: 0.004, d: T(0.07), g: 0.55 });
  end = Math.max(end, crunch(k, out, t, {
    n: k.ri(7, 11), spread: T(0.07), skew: 1.2, f: [F(1200), F(3800)], q: 1.6, d: [0.006, 0.02], g: [0.25, 0.6], fall: T(0.06),
  }));
  end = Math.max(end, crunch(k, out, t + T(0.01), {
    n: 4, spread: T(0.08), c: 'pink', f: [F(600), F(1400)], q: 2, d: [0.01, 0.03], g: [0.1, 0.25],
  }));
  return end;
}

/** Burp after eating: croaky low voice with vocal-fry roughness. */
function sBurp(k, out, t, p) {
  const T = (s) => s / p, F = (f) => f * p;
  return voice(k, out, t, {
    w: 'sawtooth', f: [[0, F(98)], [T(0.12), F(106)], [T(0.35), F(78)]],
    formants: [[F(480), 4, 1], [F(950), 5, 0.5], [F(2300), 8, 0.12]],
    a: T(0.025), hold: T(0.14), d: T(0.18), g: 0.8, am: [F(32), 0.7], amw: 'triangle', breath: 0.2, lp: 2500,
  });
}

/** Tool breaking: snap + bright inharmonic pings + rattle. */
function sBreakTool(k, out, t, p) {
  const T = (s) => s / p, F = (f) => f * p;
  let end = nz(k, out, t, { c: 'white', f: F(2600), q: 0.8, a: 0.0004, d: T(0.05), g: 0.6 });
  const ratios = [1850, 3230, 4870];
  for (let i = 0; i < 3; i++) {
    const f = F(ratios[i] * k.r(0.97, 1.03));
    end = Math.max(end, tone(k, out, t, { f, f1: f * 0.97, a: 0.0005, d: T(0.3) / (1 + i * 0.5), g: 0.16 / (1 + i * 0.5) }));
  }
  end = Math.max(end, crunch(k, out, t + T(0.01), {
    n: 5, spread: T(0.12), f: [F(3000), F(7000)], q: 5, d: [0.004, 0.012], g: [0.1, 0.25],
  }));
  return end;
}

/** Flint and steel strike (extra). */
function sIgnite(k, out, t, p) {
  const T = (s) => s / p, F = (f) => f * p;
  let end = nz(k, out, t, { c: 'white', f: F(4500), q: 2, a: 0.001, d: T(0.07), g: 0.5 });
  end = Math.max(end, nz(k, out, t, { c: 'white', f: F(2000), q: 1.2, a: 0.0005, d: T(0.02), g: 0.3 }));
  end = Math.max(end, crunch(k, out, t + T(0.01), {
    n: 8, spread: T(0.12), f: [F(3000), F(8000)], q: 4, d: [0.002, 0.008], g: [0.1, 0.3],
  }));
  return end;
}

/** Lava/fire extinguished by water (extra). */
function sFizz(k, out, t, p) {
  return hiss(k, out, t, p, { a: 0.01, hold: 0.05, d: 0.5, g: 0.4, hp: 2500, bp: 5000, flutter: 17, crackle: 8 });
}

/** Pig "oink": nasal grunt(s), gruff amplitude roughness and a snort. */
function sPig(k, out, t, p) {
  const T = (s) => s / p, F = (f) => f * p;
  const n = k.chance(0.6) ? 2 : 1;
  let end = t;
  for (let i = 0; i < n; i++) {
    const tt = t + i * T(0.19);
    const f0 = F(k.r(210, 250));
    end = voice(k, out, tt, {
      w: 'sawtooth', f: [[0, f0 * 0.9], [T(0.05), f0 * 1.15], [T(0.16), f0 * 0.85]],
      formants: [[F(340), 4, 1], [F(1100), 6, 0.45], [F(2400), 8, 0.12]],
      a: T(0.012), hold: T(0.04), d: T(i ? 0.09 : 0.12), g: 0.75, am: [F(45), 0.45], breath: 0.35, lp: F(3000),
    });
  }
  nz(k, out, t, { c: 'pink', f: F(900), q: 1.5, a: 0.01, d: T(0.15), g: 0.12 });
  return end;
}

/** Cow "moo": slow pitch arc, formants opening from "mm" to "oo", gentle vibrato. */
function sCow(k, out, t, p) {
  const T = (s) => s / p, F = (f) => f * p;
  return voice(k, out, t, {
    w: 'sawtooth', det: 7, f: [[0, F(98)], [T(0.3), F(122)], [T(0.75), F(112)], [T(1.15), F(88)]],
    formants: [[F(280), 5, 1, F(430)], [F(650), 6, 0.45, F(880)], [F(2300), 9, 0.1]],
    a: T(0.15), hold: T(0.65), d: T(0.4), g: 0.85, vib: [4.5, 12], breath: 0.15, lp: F(1800),
  });
}

/** Sheep "baa": bright vowel with the trembling bleat (fast tremolo + vibrato). */
function sSheep(k, out, t, p) {
  const T = (s) => s / p, F = (f) => f * p;
  return voice(k, out, t, {
    w: 'sawtooth', det: 12, f: [[0, F(290)], [T(0.08), F(310)], [T(0.6), F(255)]],
    formants: [[F(760), 5, 1], [F(1250), 7, 0.6], [F(2600), 9, 0.25]],
    a: T(0.03), hold: T(0.38), d: T(0.25), g: 0.7, vib: [6, 25], am: [7.5, 0.7], breath: 0.12, lp: F(4000),
  });
}

/** Chicken: two or three quick clucks, the last one a little longer. */
function sChicken(k, out, t, p) {
  const T = (s) => s / p, F = (f) => f * p;
  const n = k.ri(2, 3);
  let end = t, tt = t;
  for (let i = 0; i < n; i++) {
    const last = i === n - 1;
    const f0 = F(k.r(560, 680)) * (last ? 1.15 : 1);
    end = voice(k, out, tt, {
      w: 'sawtooth', f: [[0, f0], [T(0.02), f0 * 1.35], [T(last ? 0.12 : 0.06), f0 * 0.9]],
      formants: [[F(950), 4, 1], [F(2100), 6, 0.5], [F(3300), 8, 0.2]],
      a: T(0.004), hold: T(last ? 0.04 : 0.015), d: T(last ? 0.1 : 0.05), g: 0.55, lp: F(5000),
    });
    tt += T(k.r(0.08, 0.12));
  }
  return end;
}

/** Zombie groan: low rough voice, slow "uhh-ohh" formant glide. */
function sZombie(k, out, t, p) {
  const T = (s) => s / p, F = (f) => f * p;
  return voice(k, out, t, {
    w: 'sawtooth', det: 14, f: [[0, F(82)], [T(0.35), F(98)], [T(0.9), F(84)], [T(1.25), F(70)]],
    formants: [[F(520), 5, 1, F(430)], [F(980), 6, 0.5, F(780)], [F(2400), 8, 0.15]],
    a: T(0.18), hold: T(0.6), d: T(0.45), g: 0.9, am: [F(26), 0.55], amw: 'triangle', breath: 0.35, lp: F(2200),
  });
}

/** Zombie hurt: short pained rough cry. */
function sZombieHurt(k, out, t, p) {
  const T = (s) => s / p, F = (f) => f * p;
  return voice(k, out, t, {
    w: 'sawtooth', det: 10, f: [[0, F(150)], [T(0.04), F(165)], [T(0.3), F(95)]],
    formants: [[F(700), 5, 1, F(560)], [F(1200), 6, 0.5, F(950)], [F(2500), 8, 0.15]],
    a: T(0.01), hold: T(0.06), d: T(0.22), g: 0.9, am: [F(34), 0.5], breath: 0.3, lp: F(2800),
  });
}

// ---------------------------------------------------------------------------------------------------
// Wave 2 sounds (docs/SPEC-wave2.md): skeleton / spider / creeper / passive-mob hurt and death, the
// generic death poof, combat (swing, hit, crit), bow and arrows, hoe, chest, fire, mob steps, falls, lava.
// ---------------------------------------------------------------------------------------------------

/**
 * Raspy chittering hiss: band-passed noise chopped by a fast LFO (spiders). Times / frequencies are in
 * "pitch 1" units and scaled by p. o: { c, f, f1 (sweep target), q, rate (LFO Hz), rate1 (LFO sweep
 * target), depth 0..1, a, hold, d, g }. Returns the end time.
 */
function chitter(k, out, t, p, o) {
  const T = (s) => s / p, F = (f) => f * p;
  const a = T(o.a ?? 0.01), hold = T(o.hold ?? 0), d = T(o.d ?? 0.15);
  const dur = a + hold + d;
  const depth = clamp(o.depth ?? 0.8, 0, 1);
  const env = k.env(out, t, a, d, o.g ?? 0.5, hold);
  const am = k.gain(1 - depth / 2, env);
  const lfo = k.osc(o.lfo ?? 'square', F(o.rate ?? 40), t, dur + 0.02);
  if (o.rate1) lfo.frequency.exponentialRampToValueAtTime(k.hz(F(o.rate1)), t + dur);
  lfo.connect(k.gain(depth / 2, am.gain));
  const bp = k.filter('bandpass', F(o.f), o.q ?? 1.2, am);
  if (o.f1) {
    bp.frequency.setValueAtTime(k.hz(F(o.f)), t);
    bp.frequency.exponentialRampToValueAtTime(k.hz(F(o.f1)), t + dur);
  }
  k.noiseSource(o.c ?? 'white', t, dur + 0.02).connect(bp);
  return t + dur;
}

/** Rattling bones: `groups` clusters of hollow clacks (narrow resonant noise grains). */
function rattle(k, out, t, p, o) {
  const T = (s) => s / p, F = (f) => f * p;
  let end = t;
  let tt = t;
  for (let i = 0; i < o.groups; i++) {
    end = Math.max(end, crunch(k, out, tt, {
      n: k.ri(o.n[0], o.n[1]), spread: T(o.spread), skew: 1.1, f: [F(o.f[0]), F(o.f[1])], q: o.q ?? 7,
      d: [T(0.01), T(0.026)], g: [0.35 * o.g, 0.8 * o.g],
    }));
    tt += T(o.spread + k.r(o.gap[0], o.gap[1]));
  }
  return end;
}

/** Skeleton ambient: clusters of rattling bones, a hollow knock of the skull, a faint raspy breath. */
function sSkeleton(k, out, t, p) {
  const T = (s) => s / p, F = (f) => f * p;
  let end = rattle(k, out, t, p, { groups: k.ri(2, 3), n: [4, 7], spread: 0.11, gap: [0.05, 0.12], f: [1100, 2600], q: 8, g: 1 });
  end = Math.max(end, nz(k, out, t, { c: 'pink', f: F(850), f1: F(600), q: 2.5, a: T(0.06), hold: T(0.12), d: T(0.25), g: 0.12 }));
  end = Math.max(end, knock(k, out, t + T(k.r(0.02, 0.25)), F(k.r(520, 700)), T(0.05), 0.07));
  return end;
}

/** Skeleton hurt: a dry crack, a quick clatter and a hollow knock. */
function sSkeletonHurt(k, out, t, p) {
  const T = (s) => s / p, F = (f) => f * p;
  let end = nz(k, out, t, { c: 'white', ft: 'highpass', f: F(2200), a: 0.0006, d: T(0.04), g: 0.28 });
  end = Math.max(end, crunch(k, out, t + T(0.005), {
    n: k.ri(8, 11), spread: T(0.15), skew: 1.4, f: [F(1300), F(3000)], q: 4.5, d: [T(0.01), T(0.026)], g: [0.6, 1.2], fall: T(0.12),
  }));
  end = Math.max(end, knock(k, out, t, F(k.r(560, 680)), T(0.07), 0.1));
  end = Math.max(end, nz(k, out, t, { c: 'pink', f: F(1100), q: 1.5, a: T(0.01), d: T(0.13), g: 0.3 }));
  return end;
}

/** Skeleton death: the hurt crack, then the bones collapse into a pile (falling rattle, settling thud). */
function sSkeletonDeath(k, out, t, p) {
  const T = (s) => s / p, F = (f) => f * p;
  let end = sSkeletonHurt(k, out, t, p);
  end = Math.max(end, crunch(k, out, t + T(0.12), {
    n: 16, spread: T(0.5), skew: 1.3, f: [F(1000), F(2400)], q: 4.5, d: [T(0.012), T(0.032)], g: [0.5, 1.1], fall: T(0.35),
  }));
  end = Math.max(end, crunch(k, out, t + T(0.45), {
    n: 9, spread: T(0.35), skew: 1.2, f: [F(700), F(1600)], q: 4, d: [T(0.014), T(0.034)], g: [0.35, 0.8], fall: T(0.25),
  }));
  end = Math.max(end, nz(k, out, t + T(0.42), { c: 'brown', ft: 'lowpass', f: F(320), a: 0.004, d: T(0.14), g: 0.18 }));
  return end;
}

/** Spider ambient: two raspy chittering hisses, a throaty growl under the first. */
function sSpider(k, out, t, p) {
  const T = (s) => s / p, F = (f) => f * p;
  let end = chitter(k, out, t, p, { f: k.r(2600, 3200), f1: 1900, q: 1.3, rate: k.r(38, 50), depth: 0.85, a: 0.015, hold: 0.08, d: 0.12, g: 0.55 });
  end = Math.max(end, chitter(k, out, t, p, { c: 'brown', f: 420, q: 1.5, rate: 31, depth: 0.7, a: 0.02, hold: 0.06, d: 0.1, g: 0.5 }));
  const t2 = t + T(k.r(0.24, 0.3));
  end = Math.max(end, chitter(k, out, t2, p, { f: k.r(2300, 2800), f1: 1600, q: 1.3, rate: k.r(44, 56), depth: 0.85, a: 0.01, hold: 0.12, d: 0.16, g: 0.5 }));
  end = Math.max(end, crunch(k, out, t2, { n: 6, spread: T(0.22), f: [F(2500), F(5500)], q: 3, d: [0.003, 0.01], g: [0.1, 0.3] }));
  return end;
}

/** Spider hurt: a sharp fast chitter with a thin screech on top. */
function sSpiderHurt(k, out, t, p) {
  const T = (s) => s / p, F = (f) => f * p;
  let end = chitter(k, out, t, p, { f: 3600, f1: 2400, q: 1.5, rate: 62, depth: 0.9, a: 0.005, hold: 0.05, d: 0.12, g: 0.6 });
  end = Math.max(end, voice(k, out, t, {
    w: 'sawtooth', f: [[0, F(820)], [T(0.04), F(980)], [T(0.2), F(640)]],
    formants: [[F(2200), 6, 1], [F(3400), 8, 0.5]], a: T(0.006), hold: T(0.04), d: T(0.14), g: 0.35, am: [F(55), 0.6], lp: F(5000),
  }));
  return end;
}

/** Spider death: the hurt screech, then a long chitter slowing down and dropping, a soft thud. */
function sSpiderDeath(k, out, t, p) {
  const T = (s) => s / p, F = (f) => f * p;
  let end = sSpiderHurt(k, out, t, p);
  end = Math.max(end, chitter(k, out, t + T(0.12), p, { f: 2600, f1: 900, q: 1.2, rate: 46, rate1: 14, depth: 0.85, a: 0.02, hold: 0.25, d: 0.45, g: 0.5 }));
  end = Math.max(end, nz(k, out, t + T(0.5), { c: 'brown', ft: 'lowpass', f: F(220), a: 0.004, d: T(0.15), g: 0.4 }));
  return end;
}

/** Creeper hurt: a dry crumpling "kssh" (crushed leaves) with a short hiss. */
function sCreeperHurt(k, out, t, p) {
  const T = (s) => s / p, F = (f) => f * p;
  let end = crunch(k, out, t, {
    n: k.ri(22, 30), spread: T(0.22), skew: 1.4, f: [F(900), F(5200)], q: 1.4, d: [T(0.005), T(0.018)], g: [0.2, 0.55], fall: T(0.15),
  });
  end = Math.max(end, nz(k, out, t, { c: 'white', f: F(3000), f1: F(1800), q: 0.9, a: T(0.01), d: T(0.22), g: 0.7 }));
  end = Math.max(end, nz(k, out, t, { c: 'brown', ft: 'lowpass', f: F(400), a: 0.003, d: T(0.06), g: 0.12 }));
  return end;
}

/** Creeper death: the crumple, a fading fizz and a long crackle. */
function sCreeperDeath(k, out, t, p) {
  const T = (s) => s / p, F = (f) => f * p;
  let end = sCreeperHurt(k, out, t, p);
  end = Math.max(end, hiss(k, out, t + T(0.08), p, { a: 0.02, hold: 0.15, d: 0.45, g: 0.32, hp: 2200, bp: 4200, flutter: 11, crackle: 10 }));
  end = Math.max(end, crunch(k, out, t + T(0.2), {
    n: 18, spread: T(0.45), skew: 1.2, f: [F(700), F(3800)], q: 1.4, d: [T(0.005), T(0.02)], g: [0.15, 0.45], fall: T(0.3),
  }));
  return end;
}

/** Zombie death: a long falling groan, then the body hitting the ground. */
function sZombieDeath(k, out, t, p) {
  const T = (s) => s / p, F = (f) => f * p;
  let end = voice(k, out, t, {
    w: 'sawtooth', det: 14, f: [[0, F(135)], [T(0.08), F(150)], [T(0.7), F(66)]],
    formants: [[F(640), 5, 1, F(430)], [F(1100), 6, 0.5, F(760)], [F(2450), 8, 0.14]],
    a: T(0.015), hold: T(0.18), d: T(0.6), g: 0.9, am: [F(24), 0.6], amw: 'triangle', breath: 0.35, lp: F(2400),
  });
  end = Math.max(end, nz(k, out, t + T(0.55), { c: 'brown', ft: 'lowpass', f: 200, a: 0.004, d: 0.22, g: 0.55 }));
  return end;
}

/** Pig hurt / death: a nasal squeal. */
function sPigHurt(k, out, t, p) {
  const T = (s) => s / p, F = (f) => f * p;
  const f0 = F(k.r(560, 640));
  return voice(k, out, t, {
    w: 'sawtooth', det: 8, f: [[0, f0 * 0.85], [T(0.06), f0 * 1.3], [T(0.28), f0 * 0.95]],
    formants: [[F(1000), 4, 1], [F(2100), 6, 0.55], [F(3300), 8, 0.22]],
    a: T(0.008), hold: T(0.1), d: T(0.2), g: 0.7, vib: [11, 45], am: [F(40), 0.3], breath: 0.25, lp: F(5500),
  });
}

/** Cow hurt: a short, distressed "mmuh". */
function sCowHurt(k, out, t, p) {
  const T = (s) => s / p, F = (f) => f * p;
  return voice(k, out, t, {
    w: 'sawtooth', det: 7, f: [[0, F(130)], [T(0.07), F(168)], [T(0.38), F(112)]],
    formants: [[F(330), 5, 1, F(520)], [F(760), 6, 0.5, F(980)], [F(2400), 9, 0.12]],
    a: T(0.025), hold: T(0.1), d: T(0.28), g: 0.85, vib: [6, 20], breath: 0.2, lp: F(2200),
  });
}

/** Sheep hurt: a short, high trembling bleat. */
function sSheepHurt(k, out, t, p) {
  const T = (s) => s / p, F = (f) => f * p;
  return voice(k, out, t, {
    w: 'sawtooth', det: 12, f: [[0, F(350)], [T(0.05), F(395)], [T(0.32), F(300)]],
    formants: [[F(820), 5, 1], [F(1350), 7, 0.6], [F(2700), 9, 0.25]],
    a: T(0.015), hold: T(0.12), d: T(0.18), g: 0.7, vib: [7, 30], am: [9, 0.75], breath: 0.15, lp: F(4500),
  });
}

/** Chicken hurt: a harsh squawk and a flutter of feathers. */
function sChickenHurt(k, out, t, p) {
  const T = (s) => s / p, F = (f) => f * p;
  const f0 = F(k.r(820, 960));
  let end = voice(k, out, t, {
    w: 'sawtooth', f: [[0, f0], [T(0.025), f0 * 1.45], [T(0.16), f0 * 0.95]],
    formants: [[F(1150), 3.5, 1], [F(2400), 5, 0.6], [F(3700), 7, 0.3]],
    a: T(0.003), hold: T(0.05), d: T(0.11), g: 0.6, am: [F(75), 0.45], breath: 0.3, lp: F(6000),
  });
  end = Math.max(end, crunch(k, out, t + T(0.02), {
    n: 6, spread: T(0.15), c: 'pink', f: [F(1500), F(4000)], q: 1, d: [T(0.01), T(0.025)], g: [0.1, 0.25],
  }));
  return end;
}

/** Generic mob death "poof": a soft airy puff as the body turns into smoke. */
function sMobDeath(k, out, t, p) {
  const T = (s) => s / p, F = (f) => f * p;
  let end = nz(k, out, t, { c: 'pink', ft: 'lowpass', f: F(3200), f1: F(500), sw: T(0.22), q: 0.8, a: T(0.012), d: T(0.26), g: 0.6 });
  end = Math.max(end, nz(k, out, t + T(0.02), { c: 'white', ft: 'highpass', f: F(4500), a: T(0.02), d: T(0.18), g: 0.08 }));
  end = Math.max(end, nz(k, out, t, { c: 'brown', ft: 'lowpass', f: F(180), a: 0.004, d: T(0.08), g: 0.3 }));
  return end;
}

/** Arm / weapon swing: a short swell of air noise sweeping upward. */
function sAttackSwish(k, out, t, p) {
  const T = (s) => s / p, F = (f) => f * p;
  return nz(k, out, t, { c: 'pink', f: F(k.r(600, 750)), f1: F(k.r(2000, 2600)), sw: T(0.11), q: 1.4, a: T(0.05), d: T(0.12), g: 0.6 });
}

/** Strong melee hit: body thump, a slap and a little crunch. */
function sAttackHit(k, out, t, p) {
  const T = (s) => s / p, F = (f) => f * p;
  let end = nz(k, out, t, { c: 'brown', ft: 'lowpass', f: F(320), a: 0.003, d: T(0.09), g: 0.35 });
  end = Math.max(end, tone(k, out, t, { f: F(130), f1: F(80), gl: T(0.06), a: 0.002, d: T(0.08), g: 0.12 }));
  end = Math.max(end, nz(k, out, t, { c: 'pink', f: F(650), q: 1.2, a: 0.002, d: T(0.07), g: 0.7 }));
  end = Math.max(end, nz(k, out, t, { c: 'white', f: F(1700), q: 0.8, a: 0.001, d: T(0.05), g: 0.6 }));
  end = Math.max(end, crunch(k, out, t, { n: 4, spread: T(0.035), f: [F(1500), F(4000)], q: 1.6, d: [T(0.006), T(0.016)], g: [0.25, 0.5] }));
  return end;
}

/** Critical hit: the hit with a sharper crack and a short bright metallic ring. */
function sAttackCrit(k, out, t, p) {
  const T = (s) => s / p, F = (f) => f * p;
  let end = sAttackHit(k, out, t, p);
  end = Math.max(end, nz(k, out, t, { c: 'white', ft: 'highpass', f: F(3000), a: 0.001, d: T(0.07), g: 0.4 }));
  end = Math.max(end, clank(k, out, t, F(k.r(1500, 1700)), T(0.3), 0.07, 4));
  return end;
}

/** Bow release: the string's damped low twang and the arrow's "fwip" of air. */
function sBowShoot(k, out, t, p) {
  const T = (s) => s / p, F = (f) => f * p;
  const f0 = F(k.r(118, 140));
  let end = tone(k, out, t, { w: 'triangle', f: f0 * 1.06, f1: f0, gl: T(0.04), a: 0.0015, d: T(0.18), g: 0.18 });
  end = Math.max(end, tone(k, out, t, { w: 'sawtooth', f: f0 * 2.01, f1: f0 * 1.98, a: 0.0015, d: T(0.1), g: 0.2, lp: F(2600) }));
  end = Math.max(end, tone(k, out, t, { f: f0 * 3.02, a: 0.001, d: T(0.06), g: 0.1 }));
  end = Math.max(end, nz(k, out, t, { c: 'white', f: F(900), f1: F(3200), sw: T(0.09), q: 1.1, a: T(0.01), d: T(0.13), g: 0.75 }));
  end = Math.max(end, nz(k, out, t, { c: 'white', f: F(2500), q: 1.2, a: 0.001, d: T(0.02), g: 0.25 }));
  return end;
}

/** Arrow hitting a block or mob: "thwock" — the head biting in, a woody knock, the shaft quivering. */
function sArrowHit(k, out, t, p) {
  const T = (s) => s / p, F = (f) => f * p;
  let end = nz(k, out, t, { c: 'white', f: F(2600), q: 1, a: 0.001, d: T(0.03), g: 0.35 });
  end = Math.max(end, nz(k, out, t, { c: 'pink', f: F(900), q: 1.4, a: 0.002, d: T(0.06), g: 0.6 }));
  end = Math.max(end, knock(k, out, t, F(k.r(300, 380)), T(0.09), 0.2));
  end = Math.max(end, voice(k, out, t + T(0.01), {
    w: 'sawtooth', f: [[0, F(95)], [T(0.18), F(80)]], formants: [[F(500), 2, 1], [F(1100), 3, 0.4]],
    a: T(0.004), d: T(0.18), g: 0.18, am: [F(32), 0.9], lp: F(1400),
  }));
  return end;
}

/** The shooter's confirmation "ding" when an arrow hits a mob. */
function sArrowHitPlayer(k, out, t, p) {
  const T = (s) => s / p, F = (f) => f * p;
  let end = tone(k, out, t, { f: F(1880), a: 0.001, d: T(0.32), g: 0.32 });
  end = Math.max(end, tone(k, out, t, { f: F(1880 * 2.76), a: 0.001, d: T(0.12), g: 0.08 }));
  end = Math.max(end, tone(k, out, t + T(0.07), { f: F(2510), a: 0.001, d: T(0.28), g: 0.2 }));
  return end;
}

/** Hoe tilling: the blade scraping through soil, clods crumbling. */
function sHoeTill(k, out, t, p) {
  const T = (s) => s / p, F = (f) => f * p;
  let end = nz(k, out, t, { c: 'pink', f: F(700), f1: F(1600), sw: T(0.12), q: 1.2, a: T(0.02), hold: T(0.04), d: T(0.12), g: 0.5 });
  end = Math.max(end, crunch(k, out, t + T(0.02), {
    n: k.ri(12, 16), spread: T(0.18), skew: 1.3, f: [F(800), F(3500)], q: 1.4, d: [T(0.006), T(0.022)], g: [0.25, 0.65], fall: T(0.14),
  }));
  end = Math.max(end, nz(k, out, t, { c: 'brown', ft: 'lowpass', f: F(320), a: 0.003, d: T(0.08), g: 0.4 }));
  return end;
}

/** Creaking wooden hinge: stick-slip pulses (a wobbling low sawtooth chopped by a square LFO) through woody formants. */
function creak(k, out, t, p, o) {
  const T = (s) => s / p, F = (f) => f * p;
  const dur = T(o.d);
  const f = [[0, F(o.f0)]];
  for (let i = 1; i <= 5; i++) f.push([(dur * i) / 5, F(o.f0 * k.r(0.75, 1.35))]);
  return voice(k, out, t, {
    w: 'sawtooth', f, formants: [[F(720), 4, 1], [F(1500), 6, 0.6], [F(2900), 8, 0.3]],
    a: T(0.03), hold: dur * 0.5, d: dur * 0.5, g: o.g, am: [F(o.am ?? 23), 0.75], amw: 'square', breath: 0.1, lp: F(4000),
  });
}

/** Chest opening: the latch, a creaking lid, the lid settling open. */
function sChestOpen(k, out, t, p) {
  const T = (s) => s / p, F = (f) => f * p;
  let end = knock(k, out, t, F(k.r(300, 360)), T(0.05), 0.08);
  end = Math.max(end, creak(k, out, t + T(0.03), p, { f0: k.r(85, 105), d: 0.42, g: 0.35 }));
  end = Math.max(end, knock(k, out, t + T(0.42), F(k.r(170, 210)), T(0.08), 0.12));
  return end;
}

/** Chest closing: a short creak and the lid thudding shut. */
function sChestClose(k, out, t, p) {
  const T = (s) => s / p, F = (f) => f * p;
  let end = creak(k, out, t, p, { f0: k.r(95, 120), d: 0.22, g: 0.3, am: 30 });
  end = Math.max(end, knock(k, out, t + T(0.2), F(k.r(220, 260)), T(0.12), 0.2));
  end = Math.max(end, nz(k, out, t + T(0.2), { c: 'pink', f: F(1200), q: 1.2, a: 0.002, d: T(0.05), g: 0.45 }));
  end = Math.max(end, nz(k, out, t + T(0.2), { c: 'brown', ft: 'lowpass', f: F(300), a: 0.003, d: T(0.08), g: 0.15 }));
  return end;
}

/** Fire crackle (lit furnace, burning mobs): sparse sharp pops over a soft breathy roar. */
function sFireCrackle(k, out, t, p) {
  const T = (s) => s / p, F = (f) => f * p;
  let end = nz(k, out, t, { c: 'brown', ft: 'lowpass', f: F(500), a: T(0.15), hold: T(0.3), d: T(0.3), g: 0.25 });
  end = Math.max(end, nz(k, out, t, { c: 'pink', f: F(1800), q: 0.7, a: T(0.1), hold: T(0.3), d: T(0.3), g: 0.06 }));
  end = Math.max(end, crunch(k, out, t + T(0.02), { n: k.ri(9, 14), spread: T(0.65), f: [F(1500), F(5500)], q: 3, d: [0.002, 0.008], g: [0.2, 0.7] }));
  return end;
}

/** Skeleton footstep: a couple of bony clicks. */
function sSkeletonStep(k, out, t, p) {
  const T = (s) => s / p, F = (f) => f * p;
  let end = crunch(k, out, t, { n: 3, spread: T(0.035), f: [F(1400), F(2800)], q: 8, d: [T(0.01), T(0.018)], g: [0.55, 0.8] });
  end = Math.max(end, nz(k, out, t, { c: 'brown', ft: 'lowpass', f: F(400), a: 0.001, d: T(0.03), g: 0.25 }));
  return end;
}

/** Spider footsteps: a light skitter of eight legs. */
function sSpiderStep(k, out, t, p) {
  const T = (s) => s / p, F = (f) => f * p;
  return crunch(k, out, t, { n: k.ri(5, 8), spread: T(0.09), f: [F(2200), F(6000)], q: 2, d: [T(0.003), T(0.01)], g: [0.2, 0.5] });
}

/** Zombie footstep: a heavy, dragging shuffle. */
function sZombieStep(k, out, t, p) {
  const T = (s) => s / p, F = (f) => f * p;
  let end = nz(k, out, t, { c: 'brown', ft: 'lowpass', f: F(320), a: 0.004, d: T(0.09), g: 0.6 });
  end = Math.max(end, nz(k, out, t + T(0.01), { c: 'pink', f: F(900), f1: F(600), q: 1, a: T(0.01), d: T(0.1), g: 0.18 }));
  end = Math.max(end, crunch(k, out, t, { n: 4, spread: T(0.05), f: [F(800), F(2600)], q: 1.3, d: [T(0.006), T(0.016)], g: [0.15, 0.4] }));
  return end;
}

/** Fall damage (small): a dull crunchy thud. */
function sFallSmall(k, out, t, p) {
  const T = (s) => s / p, F = (f) => f * p;
  let end = nz(k, out, t, { c: 'brown', ft: 'lowpass', f: F(280), a: 0.004, d: T(0.12), g: 0.35 });
  end = Math.max(end, nz(k, out, t, { c: 'pink', f: F(700), q: 1.1, a: 0.003, d: T(0.1), g: 0.6 }));
  end = Math.max(end, crunch(k, out, t, { n: 7, spread: T(0.06), skew: 1.3, f: [F(600), F(2400)], q: 1.2, d: [T(0.008), T(0.024)], g: [0.35, 0.75] }));
  return end;
}

/** Fall damage (big, > 4 hearts): a heavy bone-crunching impact. */
function sFallBig(k, out, t, p) {
  const T = (s) => s / p, F = (f) => f * p;
  let end = nz(k, out, t, { c: 'brown', ft: 'lowpass', f: F(220), a: 0.004, d: T(0.2), g: 0.4 });
  end = Math.max(end, tone(k, out, t, { f: F(85), f1: F(48), gl: T(0.12), a: 0.003, d: T(0.15), g: 0.15 }));
  end = Math.max(end, nz(k, out, t, { c: 'pink', f: F(600), q: 1, a: 0.003, d: T(0.16), g: 0.65 }));
  end = Math.max(end, nz(k, out, t, { c: 'white', ft: 'highpass', f: F(1600), a: 0.001, d: T(0.04), g: 0.25 }));
  end = Math.max(end, crunch(k, out, t, {
    n: 12, spread: T(0.13), skew: 1.4, f: [F(500), F(2600)], q: 1.4, d: [T(0.01), T(0.028)], g: [0.4, 0.9], fall: T(0.09),
  }));
  return end;
}

/** Lava pop: a bursting bubble of molten rock. */
function sLavaPop(k, out, t, p) {
  const T = (s) => s / p, F = (f) => f * p;
  let end = tone(k, out, t, { f: F(k.r(260, 340)), f1: F(k.r(620, 760)), gl: T(0.045), a: 0.002, d: T(0.07), g: 0.4 });
  end = Math.max(end, nz(k, out, t, { c: 'white', f: F(1300), q: 1.3, a: 0.001, d: T(0.03), g: 0.3 }));
  end = Math.max(end, nz(k, out, t, { c: 'brown', ft: 'lowpass', f: F(300), a: 0.003, d: T(0.06), g: 0.12 }));
  return end;
}

/** Flowing water ambience (Minecraft liquid.water): a soft swelling burble with a few small bubbles. */
function sWaterFlow(k, out, t, p) {
  const T = (s) => s / p, F = (f) => f * p;
  const dur = T(k.r(1.0, 1.4));
  const env = k.env(out, t, dur * 0.35, dur * 0.65, 0.5, 0);
  const am = k.gain(0.75, env);
  k.osc('sine', k.r(3, 5.5), t, dur + 0.02).connect(k.gain(0.25, am.gain));
  const bp = k.filter('bandpass', F(k.r(550, 750)), 1.4, am);
  bp.frequency.setValueAtTime(k.hz(F(650)), t);
  bp.frequency.linearRampToValueAtTime(k.hz(F(k.r(800, 1000))), t + dur);
  k.noiseSource('pink', t, dur + 0.02).connect(bp);
  let end = t + dur;
  const n = k.ri(4, 7);
  for (let i = 0; i < n; i++) {
    end = Math.max(end, bubble(k, out, t + k.r(0.05, 0.9) * dur, F(k.r(500, 1300)), T(k.r(0.03, 0.07)), k.r(0.05, 0.12)));
  }
  return end;
}

/** Lava ambience (Minecraft liquid.lava): a deep molten rumble with slow heavy bubbles and a faint crackle. */
function sLavaAmbient(k, out, t, p) {
  const T = (s) => s / p, F = (f) => f * p;
  let end = nz(k, out, t, { c: 'brown', ft: 'lowpass', f: F(260), q: 0.8, a: T(0.3), hold: T(0.35), d: T(0.5), g: 0.7 });
  end = Math.max(end, nz(k, out, t, { c: 'pink', f: F(420), q: 1.2, a: T(0.25), hold: T(0.3), d: T(0.45), g: 0.18 }));
  const n = k.ri(2, 3);
  for (let i = 0; i < n; i++) {
    end = Math.max(end, bubble(k, out, t + T(k.r(0.1, 0.8)), F(k.r(110, 190)), T(k.r(0.08, 0.14)), k.r(0.15, 0.25)));
  }
  end = Math.max(end, crunch(k, out, t + T(0.1), { n: k.ri(4, 7), spread: T(0.8), f: [F(1500), F(4000)], q: 3, d: [0.002, 0.007], g: [0.05, 0.15] }));
  return end;
}

/**
 * Named sound table. gain: loudness trim (calibrated with tools/audio-calibrate.mjs through the settled
 * limiter to A-weighted 100 ms loudness targets: hurt/death -22, explode -22.5, splash -23, mob voices
 * -23.5..-30, mob steps -39..-42, combat -25..-33, UI click -30 LA; see TARGETS in that tool); vary: random
 * pitch spread (triangular, ±); reverb: send
 * level; range: audible distance in blocks at volume 1 (volume > 1 extends it like Minecraft);
 * positional: false = always centred (UI).
 */
const SOUNDS = {
  click: { fn: sClick, gain: 0.934, vary: 0.02, reverb: 0, positional: false },
  pop: { fn: sPop, gain: 0.445, vary: 0.25, reverb: 0.04 },
  hurt: { fn: sHurt, gain: 0.544, vary: 0.1, reverb: 0.06 },
  death: { fn: sDeath, gain: 0.653, vary: 0.06, reverb: 0.08 },
  splash: { fn: sSplash, gain: 0.893, vary: 0.12, reverb: 0.12 },
  swim: { fn: sSwim, gain: 0.942, vary: 0.15, reverb: 0.08 },
  explode: { fn: sExplode, gain: 0.35, vary: 0.12, reverb: 0.3, range: 64 },
  fuse: { fn: sFuse, gain: 0.38, vary: 0.05, reverb: 0.08 },
  eat: { fn: sEat, gain: 1.21, vary: 0.2, reverb: 0.03 },
  burp: { fn: sBurp, gain: 0.871, vary: 0.1, reverb: 0.05 },
  break_tool: { fn: sBreakTool, gain: 0.658, vary: 0.1, reverb: 0.1 },
  pig: { fn: sPig, gain: 0.793, vary: 0.15, reverb: 0.08 },
  cow: { fn: sCow, gain: 0.4, vary: 0.12, reverb: 0.1 },
  sheep: { fn: sSheep, gain: 0.5, vary: 0.12, reverb: 0.08 },
  chicken: { fn: sChicken, gain: 0.25, vary: 0.15, reverb: 0.06 },
  zombie: { fn: sZombie, gain: 0.53, vary: 0.1, reverb: 0.12 },
  zombie_hurt: { fn: sZombieHurt, gain: 0.537, vary: 0.1, reverb: 0.1 },
  creeper_hiss: { fn: sCreeperHiss, gain: 0.38, vary: 0.04, reverb: 0.08 },
  ignite: { fn: sIgnite, gain: 1.3, vary: 0.15, reverb: 0.06 },
  fizz: { fn: sFizz, gain: 0.398, vary: 0.2, reverb: 0.08 },
  // ---- wave 2 ----
  skeleton: { fn: sSkeleton, gain: 2.45, vary: 0.15, reverb: 0.1 },
  skeleton_hurt: { fn: sSkeletonHurt, gain: 1.54, vary: 0.12, reverb: 0.1 },
  skeleton_death: { fn: sSkeletonDeath, gain: 1.68, vary: 0.1, reverb: 0.12 },
  skeleton_step: { fn: sSkeletonStep, gain: 0.755, vary: 0.12, reverb: 0.05 },
  spider: { fn: sSpider, gain: 0.647, vary: 0.15, reverb: 0.1 },
  spider_hurt: { fn: sSpiderHurt, gain: 0.852, vary: 0.12, reverb: 0.1 },
  spider_death: { fn: sSpiderDeath, gain: 0.887, vary: 0.1, reverb: 0.12 },
  spider_step: { fn: sSpiderStep, gain: 0.631, vary: 0.15, reverb: 0.04 },
  creeper_hurt: { fn: sCreeperHurt, gain: 0.708, vary: 0.12, reverb: 0.1 },
  creeper_death: { fn: sCreeperDeath, gain: 0.78, vary: 0.1, reverb: 0.12 },
  zombie_death: { fn: sZombieDeath, gain: 0.72, vary: 0.1, reverb: 0.12 },
  zombie_step: { fn: sZombieStep, gain: 0.61, vary: 0.12, reverb: 0.05 },
  pig_hurt: { fn: sPigHurt, gain: 0.284, vary: 0.12, reverb: 0.08 },
  cow_hurt: { fn: sCowHurt, gain: 0.408, vary: 0.12, reverb: 0.1 },
  sheep_hurt: { fn: sSheepHurt, gain: 0.406, vary: 0.12, reverb: 0.08 },
  chicken_hurt: { fn: sChickenHurt, gain: 0.26, vary: 0.15, reverb: 0.06 },
  mob_death: { fn: sMobDeath, gain: 0.602, vary: 0.15, reverb: 0.06 },
  attack_swish: { fn: sAttackSwish, gain: 0.85, vary: 0.12, reverb: 0.03 },
  attack_hit: { fn: sAttackHit, gain: 1.26, vary: 0.1, reverb: 0.05 },
  attack_crit: { fn: sAttackCrit, gain: 0.804, vary: 0.08, reverb: 0.07 },
  bow_shoot: { fn: sBowShoot, gain: 0.977, vary: 0.12, reverb: 0.08 },
  arrow_hit: { fn: sArrowHit, gain: 0.991, vary: 0.15, reverb: 0.1 },
  arrow_hit_player: { fn: sArrowHitPlayer, gain: 0.215, vary: 0.04, reverb: 0.04 },
  hoe_till: { fn: sHoeTill, gain: 0.943, vary: 0.1, reverb: 0.08 },
  chest_open: { fn: sChestOpen, gain: 1.43, vary: 0.1, reverb: 0.1 },
  chest_close: { fn: sChestClose, gain: 1.16, vary: 0.1, reverb: 0.1 },
  fire_crackle: { fn: sFireCrackle, gain: 0.84, vary: 0.15, reverb: 0.06 },
  fall_small: { fn: sFallSmall, gain: 1.26, vary: 0.08, reverb: 0.06 },
  fall_big: { fn: sFallBig, gain: 1.22, vary: 0.08, reverb: 0.08 },
  lava_pop: { fn: sLavaPop, gain: 0.674, vary: 0.2, reverb: 0.08 },
  water_flow: { fn: sWaterFlow, gain: 0.66, vary: 0.15, reverb: 0.1 },
  lava_ambient: { fn: sLavaAmbient, gain: 0.507, vary: 0.15, reverb: 0.1 },
};

/**
 * Every named sound accepted by play(): the SPEC §9.9 list, the wave-1 extras 'ignite' and 'fizz' and
 * the wave-2 sounds (mobs, combat, bow, hoe, chest, fire, falls, lava; docs/notes/art-wave2.md).
 */
export const SOUND_NAMES = Object.freeze(Object.keys(SOUNDS));

/**
 * Alternative names accepted by play() (Minecraft-style or obvious variants), resolved to a SOUND_NAMES
 * entry. Passive mobs use their hurt sound for death like Minecraft.
 */
export const SOUND_ALIASES = Object.freeze({
  poof: 'mob_death', death_poof: 'mob_death', mob_poof: 'mob_death',
  bow: 'bow_shoot', shoot: 'bow_shoot', bow_release: 'bow_shoot',
  bowhit: 'arrow_hit', arrow_land: 'arrow_hit', successful_hit: 'arrow_hit_player',
  till: 'hoe_till', hoe: 'hoe_till',
  swing: 'attack_swish', swish: 'attack_swish', attack_sweep: 'attack_swish', attack_nodamage: 'attack_swish',
  hit: 'attack_hit', attack: 'attack_hit', attack_strong: 'attack_hit', attack_weak: 'attack_hit',
  crit: 'attack_crit', critical: 'attack_crit',
  fire: 'fire_crackle', burn: 'fire_crackle', furnace: 'fire_crackle', furnace_crackle: 'fire_crackle',
  fallsmall: 'fall_small', fallbig: 'fall_big', fall: 'fall_small',
  lava: 'lava_pop', lavapop: 'lava_pop', liquid_lava: 'lava_ambient', liquid_water: 'water_flow',
  water_ambient: 'water_flow', water: 'water_flow',
  chestopen: 'chest_open', open_chest: 'chest_open', chestclosed: 'chest_close', chest_closed: 'chest_close',
  close_chest: 'chest_close',
  pig_say: 'pig', pig_ambient: 'pig', pig_death: 'pig_hurt',
  cow_say: 'cow', cow_ambient: 'cow', cow_death: 'cow_hurt',
  sheep_say: 'sheep', sheep_ambient: 'sheep', sheep_death: 'sheep_hurt',
  chicken_say: 'chicken', chicken_ambient: 'chicken', chicken_death: 'chicken_hurt',
  zombie_say: 'zombie', zombie_ambient: 'zombie',
  skeleton_say: 'skeleton', skeleton_ambient: 'skeleton',
  spider_say: 'spider', spider_ambient: 'spider',
  creeper_say: 'creeper_hurt', creeper_fuse: 'creeper_hiss', creeper_primed: 'creeper_hiss',
});

/** Canonical sound for a name or alias, or null when unknown. */
export function resolveSoundName(name) {
  if (typeof name !== 'string') return null;
  if (Object.prototype.hasOwnProperty.call(SOUNDS, name)) return name;
  return Object.prototype.hasOwnProperty.call(SOUND_ALIASES, name) ? SOUND_ALIASES[name] : null;
}

// ---------------------------------------------------------------------------------------------------
// Piano: notes are rendered once by additive synthesis in an OfflineAudioContext (rendering runs on the
// audio engine's thread, not the main thread) and replayed as buffer sources (3-4 nodes per note).
// Model: stretched (inharmonic) partials, a hammer-position comb, brightness roll-off, higher partials
// decaying faster, two detuned unison strings per partial (a loud fast-decaying "prompt" part and a
// quieter long "aftersound" -> the typical two-stage piano decay with gentle beating), hammer noise.
// ---------------------------------------------------------------------------------------------------

const PIANO_LOW = 33;   // A1
const PIANO_HIGH = 96;  // C7
const PIANO_STEP = 3;   // one rendered sample every 3 semitones (replayed at most 1 semitone off)
const pianoCache = new Map(); // sample midi -> AudioBuffer | null (unavailable) | Promise (rendering)
let pianoQueue = Promise.resolve();

function pianoSampleFor(midi) {
  const m = clamp(Math.round(midi), PIANO_LOW, PIANO_HIGH);
  return PIANO_LOW + Math.round((m - PIANO_LOW) / PIANO_STEP) * PIANO_STEP;
}
/** Rendered length of a sample (low notes ring longer). */
function pianoSeconds(m) {
  return clamp(9.5 - (m - 36) * 0.1, 3.5, 9.5);
}
/** -60 dB decay time of the fundamental's long component. */
function pianoT60(m) {
  return 14 * Math.pow(2, -(m - 36) / 20);
}

function offlineContextClass() {
  return globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext || null;
}

/** startRendering() as a promise (also for old WebKit, which only fires `oncomplete`). */
function renderContext(ctx) {
  return new Promise((resolve, reject) => {
    ctx.oncomplete = (e) => resolve(e.renderedBuffer);
    let r;
    try {
      r = ctx.startRendering();
    } catch (err) {
      reject(err);
      return;
    }
    if (r && typeof r.then === 'function') r.then(resolve, reject);
  });
}

function pianoPartial(k, out, t, f, amp, t60, stopAt) {
  const o = k.ctx.createOscillator();
  o.frequency.value = k.hz(f);
  const g = k.ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(amp, t + 0.0025);
  g.gain.setTargetAtTime(0, t + 0.0025, t60 / 6.9);
  o.connect(g);
  g.connect(out);
  o.start(t);
  o.stop(Math.min(stopAt, t + t60 * 1.2 + 0.01));
}

/** Additive piano note (MIDI `m`, fairly strong velocity) into `out` starting at `t`. */
function buildPianoNote(k, out, t, m, seconds) {
  const f0 = midiToHz(m);
  const B = 0.00007 * Math.pow(2, (m - 21) / 19);   // string stiffness (inharmonicity)
  const t60 = pianoT60(m);
  const maxF = Math.min(k.nyquist * 0.9, 10000);
  const hammerPos = 1 / 7.7;
  const stopAt = t + seconds;
  for (let n = 1; n <= 20; n++) {
    const fn = n * f0 * Math.sqrt(1 + B * n * n);
    if (fn > maxF) break;
    let amp = Math.pow(n, -1.1) * (0.25 + 0.75 * Math.abs(Math.sin(Math.PI * n * hammerPos)));
    amp *= Math.exp(-fn / 3800);
    if (f0 < 110) amp *= n === 1 ? 0.55 : n === 2 ? 0.85 : 1;  // small soundboards radiate weak lows
    const tn = t60 / (1 + 0.5 * (n - 1));
    const det = k.r(0.5, 1.5) * (n === 1 ? 1 : 1.3);         // cents between the unison strings
    pianoPartial(k, out, t, fn * Math.pow(2, det / 2400), amp * 0.62, tn * 0.22, stopAt);
    pianoPartial(k, out, t, fn * Math.pow(2, -det / 2400), amp * 0.38, tn, stopAt);
  }
  nz(k, out, t, { c: 'white', f: Math.min(4500, 2.2 * f0 + 900), q: 0.7, a: 0.0006, d: 0.035, g: 0.025 });
  nz(k, out, t, { c: 'brown', ft: 'lowpass', f: 240, a: 0.001, d: 0.06, g: 0.05 });
}

async function renderPianoSample(m) {
  const OAC = offlineContextClass();
  if (!OAC) return null;
  const seconds = pianoSeconds(m);
  const ctx = new OAC(1, Math.ceil(seconds * PIANO_RATE), PIANO_RATE);
  const k = new SynthKit(ctx, mulberry32(0x9a1 + m * 7919));
  const out = ctx.createGain();
  out.gain.setValueAtTime(1, Math.max(0, seconds - 0.35));
  out.gain.linearRampToValueAtTime(0, seconds - 0.005);
  out.connect(ctx.destination);
  buildPianoNote(k, out, 0, m, seconds);
  const buf = await renderContext(ctx);
  const d = buf.getChannelData(0);
  let peak = 0;
  for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
  if (peak > 0) {
    const s = 0.7 / peak;
    for (let i = 0; i < d.length; i++) d[i] *= s;
  }
  return buf;
}

/**
 * Make sure the piano samples covering `midis` exist (rendered one after another). Resolves when they
 * are ready (or unavailable -> the live fallback voice is used). Never rejects.
 */
export function ensurePianoSamples(midis) {
  const jobs = [];
  for (const s of new Set(Array.from(midis, pianoSampleFor))) {
    const v = pianoCache.get(s);
    if (v === undefined) {
      const job = pianoQueue
        .then(() => renderPianoSample(s))
        .catch(() => null)
        .then((buf) => { pianoCache.set(s, buf); });
      pianoQueue = job;
      pianoCache.set(s, job);
      jobs.push(job);
    } else if (v && typeof v.then === 'function') {
      jobs.push(v);
    }
  }
  return Promise.all(jobs).then(() => undefined);
}

function velocityGain(vel) {
  return 0.06 + 0.94 * Math.pow(clamp(vel, 0, 1), 1.6);
}

/** Simple live piano (3-4 decaying partials) used when no rendered sample is available. */
function livePiano(k, out, t, midi, vel, dur) {
  const f0 = midiToHz(midi);
  const amp = velocityGain(vel) * 0.32;
  const len = Math.min(pianoT60(midi), dur + 0.6);
  const harm = [1, 0.4, 0.18, 0.08];
  let end = t;
  for (let n = 1; n <= 4; n++) {
    end = Math.max(end, tone(k, out, t, {
      f: f0 * n, a: 0.003, d: len / (1 + 0.6 * (n - 1)), g: amp * harm[n - 1], det: n === 1 ? 0 : 1.5,
    }));
  }
  return end;
}

/** Piano note: rendered sample (repitched, velocity -> level + brightness, damper at note-off). */
function playPiano(k, out, t, midi, vel, dur) {
  const s = pianoSampleFor(midi);
  const buf = pianoCache.get(s);
  if (!buf || typeof buf.then === 'function') return livePiano(k, out, t, midi, vel, dur);
  const ctx = k.ctx;
  const rate = Math.pow(2, (midi - s) / 12);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = rate;
  const lp = k.filter('lowpass', 900 + 9000 * vel * vel, 0.5);
  const g = ctx.createGain();
  const amp = velocityGain(vel);
  const off = t + Math.max(0.05, dur);
  let end = t + buf.duration / rate;
  g.gain.setValueAtTime(amp, t);
  if (off < end - 0.05) {
    g.gain.setValueAtTime(amp, off);
    g.gain.setTargetAtTime(0, off, 0.14); // damper
    end = Math.min(end, off + 1);
  }
  src.connect(lp);
  lp.connect(g);
  g.connect(out);
  src.start(t);
  src.stop(end);
  if (k.sources) k.sources.push(src);
  return end;
}

/** Soft warm pad (detuned triangle + filtered saw, slow attack, long release). */
function playPad(k, out, t, midi, vel, dur) {
  const ctx = k.ctx;
  const f = midiToHz(midi);
  const atk = clamp(dur * 0.35, 0.4, 2.5);
  const rel = 2.8;
  const holdEnd = t + Math.max(atk, dur);
  const end = holdEnd + rel;
  const peak = 0.018 * clamp(vel, 0, 1);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(peak, t + atk);
  g.gain.setValueAtTime(peak, holdEnd);
  g.gain.setTargetAtTime(0, holdEnd, rel / 6);
  g.connect(out);
  const lp = k.filter('lowpass', Math.min(2400, 500 + f * 2), 0.3, g);
  const o1 = k.osc('triangle', f, t, end - t + 0.02);
  o1.detune.value = -5;
  o1.connect(lp);
  const o2 = k.osc('sawtooth', f, t, end - t + 0.02);
  o2.detune.value = 6;
  o2.connect(k.gain(0.3, lp));
  return end;
}

// ---------------------------------------------------------------------------------------------------
// Generative composer (pure): calm C418-flavoured pieces — slow tempo, soft piano, sparse melodies on
// a repeated motif, maj7 / add9 harmony, pentatonic-leaning long notes, rests, a final rolled chord.
// ---------------------------------------------------------------------------------------------------

const MODES = {
  major: [0, 2, 4, 5, 7, 9, 11],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
};
const MODE_WEIGHTS = [['major', 0.34], ['lydian', 0.16], ['aeolian', 0.22], ['dorian', 0.16], ['mixolydian', 0.12]];
/** Chord progressions as scale degrees (0 = tonic); only degrees with a perfect fifth are used. */
const PROGRESSIONS = {
  major: [[0, 3], [0, 3, 5, 3], [0, 5, 3, 4], [3, 0, 3, 4], [0, 2, 3, 3], [5, 3, 0, 4], [0, 4, 5, 3], [3, 4, 2, 5], [0, 5, 1, 4]],
  lydian: [[0, 1], [0, 1, 0, 4], [0, 2, 1, 0], [0, 1, 5, 4]],
  mixolydian: [[0, 6, 3, 0], [0, 3, 6, 3], [0, 6, 0, 3]],
  dorian: [[0, 3], [0, 3, 0, 6], [0, 2, 3, 6], [0, 6, 3, 3]],
  aeolian: [[0, 5, 2, 6], [0, 6, 5, 6], [5, 6, 0, 0], [0, 3, 5, 4], [0, 5, 3, 6]],
};
const KEY_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
/** Two-bar melody rhythms: [onset beat, length in beats]. */
const RHYTHMS_4 = [
  [[0, 1.5], [1.5, 0.5], [2, 2], [4, 3]],
  [[0, 2], [2, 1], [3, 1], [4, 4]],
  [[1, 1], [2, 1.5], [3.5, 0.5], [4, 4]],
  [[0, 3], [3, 1], [4, 2], [6, 2]],
  [[0.5, 0.5], [1, 1], [2, 2], [5, 3]],
  [[0, 1], [1, 1], [2, 1], [3, 1], [4, 4]],
  [[2, 2], [4, 1.5], [5.5, 0.5], [6, 2]],
  [[0, 4], [4, 4]],
  [[0, 1], [1, 2], [3, 1], [4, 1], [5, 3]],
];
const RHYTHMS_3 = [
  [[0, 2], [2, 1], [3, 3]],
  [[0, 1], [1, 1], [2, 1], [3, 3]],
  [[1, 1], [2, 1], [3, 3]],
  [[0, 3], [3, 2], [5, 1]],
  [[0, 1.5], [1.5, 0.5], [2, 1], [3, 3]],
];
const ARP_PATTERNS = [
  [0, 1, 2, 3, 4, 3, 2, 1],
  [0, 1, 2, 4, 3, 4, 2, 1],
  [0, 2, 1, 3, 2, 4, 3, 1],
  [0, 1, 2, 3, 5, 4, 3, 2],
];
const STEP_CHOICES = [-2, -1, -1, 1, 1, 2, -3, 3, 0, -1, 1, 2, -2];

/** Diatonic chord on scale degree `deg`: intervals above its root (0 = tone omitted). */
function chordInfo(scale, deg) {
  const at = (i) => scale[(deg + i) % 7] + 12 * Math.floor((deg + i) / 7) - scale[deg];
  const third = at(2);
  const fifth = at(4);
  let seventh = at(6);
  let ninth = at(8);
  if (third === 4 && seventh === 10) seventh = 0; // no dominant sevenths (keeps it dreamy)
  if (ninth === 13) ninth = 0;                    // no flat nines
  return { deg, rootPc: scale[deg], third, fifth, seventh, ninth };
}

/**
 * Compose one piece. Deterministic for a given seed.
 * @returns {{ seed, mode, key, keyName, bpm, meter, style, progression, barsPerChord, pad, cycles,
 *   duration, events: Array<{ t, midi, vel, dur, inst: 'piano'|'pad' }> }}  times/durations in seconds
 */
export function composePiece(seed) {
  const r = mulberry32((seed >>> 0) ^ 0x6d2b79f5);
  const rf = (lo, hi) => lo + (hi - lo) * r();
  const ri = (lo, hi) => lo + Math.min(hi - lo, Math.floor(r() * (hi - lo + 1)));
  const pick = (a) => a[Math.min(a.length - 1, Math.floor(r() * a.length))];

  let wsum = 0;
  for (const [, w] of MODE_WEIGHTS) wsum += w;
  let x = r() * wsum;
  let mode = MODE_WEIGHTS[0][0];
  for (const [m, w] of MODE_WEIGHTS) {
    if ((x -= w) <= 0) { mode = m; break; }
  }
  const scale = MODES[mode];
  const key = pick([0, 2, 3, 5, 7, 8, 9, 10]);
  const meter = r() < 0.18 ? 3 : 4;
  const style = meter === 3 ? 'waltz' : pick(['arp', 'arp', 'arp', 'block', 'pulse', 'sparse']);
  const bpm = style === 'arp' ? ri(66, 80) : style === 'pulse' ? ri(62, 74) : ri(56, 70);
  const prog = pick(PROGRESSIONS[mode]);
  const barsPerChord = prog.length <= 2 ? 2 : r() < 0.45 ? 2 : 1;
  const usePad = r() < 0.4;
  const arp = pick(ARP_PATTERNS);
  const beat = 60 / bpm;
  const chordBeats = barsPerChord * meter;
  const cycleBeats = prog.length * chordBeats;
  const cycles = clamp(Math.round(rf(100, 170) / (cycleBeats * beat)), 3, 10);
  const body = cycles - 1;
  const aLen = Math.max(1, Math.round(body * 0.45));
  const bLen = Math.min(body - aLen, Math.max(0, Math.round(body * 0.25)));
  const sections = ['intro'];
  for (let i = 0; i < body; i++) sections.push(i < aLen ? 'A' : i < aLen + bLen ? 'B' : 'A');
  const outroBeats = meter * 2;
  const mainBeats = cycles * cycleBeats;
  const totalBeats = mainBeats + outroBeats;

  // Tempo map: gentle breathing rubato, ritardando into the final chord.
  const phase = rf(0, TAU);
  const beatTimes = new Float64Array(totalBeats + 2);
  for (let b = 1; b < beatTimes.length; b++) {
    const breathe = 1 + 0.035 * Math.sin((TAU * b) / cycleBeats + phase);
    const toEnd = mainBeats - b;
    let rit = 1;
    if (toEnd < 0) rit = 1.35;
    else if (toEnd < meter * 2) {
      const u = 1 - toEnd / (meter * 2);
      rit = 1 + 0.3 * u * u * (3 - 2 * u);
    }
    beatTimes[b] = beatTimes[b - 1] + beat * breathe * rit;
  }
  const timeAt = (pos) => {
    const p = clamp(pos, 0, totalBeats);
    const i = Math.min(Math.floor(p), totalBeats);
    return beatTimes[i] + (beatTimes[i + 1] - beatTimes[i]) * (p - i);
  };

  const events = [];
  const add = (pos, midi, vel, durBeats, inst = 'piano', jitter = 0.008) => {
    const t0 = Math.max(0, timeAt(pos) + (r() * 2 - 1) * jitter);
    const t1 = timeAt(pos + durBeats);
    events.push({ t: t0, midi: Math.round(midi), vel: clamp(vel, 0.05, 1), dur: Math.max(0.1, t1 - t0), inst });
  };

  const bassOf = (ch) => {
    const b = 36 + ((key + ch.rootPc) % 12);
    return b > 44 ? b - 12 : b;
  };
  const accBase = rf(0.27, 0.36);
  const melBase = rf(0.44, 0.56);

  function accompany(start, ch, sec) {
    const bass = bassOf(ch);
    const av = accBase * (sec === 'intro' ? 0.9 : sec === 'B' ? 0.85 : 1);
    const len = chordBeats;
    const fit = (m) => (m > 70 ? m - 12 : m);
    const s = sec === 'B' && style === 'arp' ? 'block' : style;
    if (s === 'arp') {
      const tones = ch.ninth
        ? [0, ch.fifth, 12, ch.ninth, 12 + ch.third, 12 + ch.fifth]
        : [0, ch.fifth, 12, 12 + ch.third, 12 + ch.fifth, 24];
      for (let bar = 0; bar < barsPerChord; bar++) {
        for (let i = 0; i < 8; i++) {
          const pos = start + bar * meter + i * 0.5;
          const sustain = Math.min(6, start + len - pos + 0.5);
          const accent = i === 0 ? (bar === 0 ? 1.15 : 0.95) : 0.82 + 0.15 * r();
          add(pos, fit(bass + tones[arp[i]]), av * accent, sustain);
        }
      }
    } else if (s === 'block') {
      add(start, bass, av * 1.1, len + 0.5);
      const upper = [12 + ch.third, 12 + (ch.seventh || ch.fifth), ch.ninth ? 12 + ch.ninth : 24];
      upper.forEach((iv, i) => add(start + 0.06 * (i + 1), fit(bass + iv), av * (0.85 - i * 0.05), len));
      if (len >= 4 && r() < 0.5) {
        upper.forEach((iv, i) => add(start + len / 2 + 0.05 * i, fit(bass + iv), av * 0.6, len / 2));
      }
    } else if (s === 'pulse') {
      add(start, bass, av * 1.1, len + 0.5);
      const dyad = r() < 0.5 ? [12 + ch.third, 12 + ch.fifth] : [ch.fifth + 12, ch.ninth ? 12 + ch.ninth : 24];
      for (let b = 0; b < len; b++) {
        // Full dyad on strong beats, a single soft tone on weak beats (keeps the pulse gentle).
        const strong = b % 2 === 0;
        const tones = strong ? dyad : [dyad[b % 4 === 1 ? 0 : 1]];
        for (const iv of tones) add(start + b + 0.02, fit(bass + iv), av * (b % meter === 0 ? 0.78 : strong ? 0.66 : 0.55), 0.95);
      }
    } else if (s === 'sparse') {
      add(start, bass, av * 1.1, len + 1);
      const colours = [12 + ch.third, 12 + ch.fifth, ch.ninth ? 12 + ch.ninth : 24];
      add(start + ri(1, Math.max(1, len - 2)), fit(bass + pick(colours)), av * 0.8, len);
      if (len >= 6 && r() < 0.5) add(start + len / 2 + ri(1, 2), fit(bass + pick(colours)), av * 0.7, len / 2);
    } else {
      // waltz (3/4): bass on 1, soft dyad on 2 and 3
      for (let bar = 0; bar < barsPerChord; bar++) {
        const p0 = start + bar * 3;
        add(p0, bass, av * (bar === 0 ? 1.1 : 0.9), 3.2);
        for (let b = 1; b < 3; b++) {
          add(p0 + b, fit(bass + 12 + ch.third), av * 0.62, 0.95);
          add(p0 + b + 0.02, fit(bass + 12 + ch.fifth), av * 0.58, 0.95);
        }
      }
    }
    if (usePad && sec !== 'intro') {
      for (const iv of [12, 12 + ch.fifth, 24 + ch.third]) add(start, bass + iv, 0.7, len + 0.3, 'pad', 0);
    }
  }

  // Melody material.
  const melLo = 64, melHi = 86;
  const pcIn = (m) => (((m - key) % 12) + 12) % 12;
  const scalePitches = [];
  for (let m = melLo - 5; m <= melHi + 5; m++) if (scale.includes(pcIn(m))) scalePitches.push(m);
  const pentDegrees = scale[2] === 4 ? [0, 1, 2, 4, 5] : [0, 2, 3, 4, 6];
  const pent = new Set(pentDegrees.map((d) => scale[d]));
  const chordAtPos = (pos) => chordInfo(scale, prog[Math.floor((pos % cycleBeats) / chordBeats) % prog.length]);
  const chordPcs = (ch) => {
    const s = new Set([0, ch.third, ch.fifth]);
    if (ch.seventh) s.add(ch.seventh);
    if (ch.ninth) s.add(ch.ninth % 12);
    return new Set([...s].map((iv) => (key + ch.rootPc + iv) % 12));
  };
  const clampIdx = (i) => clamp(i, 0, scalePitches.length - 1);
  const nearest = (idx, ok) => {
    for (let dlt = 0; dlt <= 4; dlt++) {
      for (const s of dlt ? [dlt, -dlt] : [0]) {
        const j = clampIdx(idx + s);
        if (ok(scalePitches[j])) return j;
      }
    }
    return clampIdx(idx);
  };
  const idxNear = (midi) => {
    let best = 0;
    for (let i = 0; i < scalePitches.length; i++) {
      if (Math.abs(scalePitches[i] - midi) < Math.abs(scalePitches[best] - midi)) best = i;
    }
    return best;
  };
  const makeMotif = () => {
    const rhythm = pick(meter === 4 ? RHYTHMS_4 : RHYTHMS_3);
    return { rhythm, steps: rhythm.map((_, i) => (i === 0 ? 0 : pick(STEP_CHOICES))) };
  };
  const mutate = (m) => {
    const steps = m.steps.slice();
    const i = 1 + Math.floor(r() * Math.max(1, steps.length - 1));
    if (i < steps.length) steps[i] = pick(STEP_CHOICES);
    return { rhythm: m.rhythm, steps };
  };
  const motifA = makeMotif();
  const motifA2 = r() < 0.5 ? mutate(motifA) : motifA;
  const motifB = makeMotif();
  const phraseBeats = 2 * meter;
  let prevIdx = -1;

  function phrase(motif, pos, center, cadence) {
    const ch0 = chordPcs(chordAtPos(pos));
    let idx = nearest(prevIdx >= 0 ? Math.round((prevIdx + idxNear(center)) / 2) : idxNear(center),
      (m) => ch0.has(m % 12));
    const notes = motif.rhythm.length;
    for (let i = 0; i < notes; i++) {
      const [on, len] = motif.rhythm[i];
      if (i > 0) idx = clampIdx(idx + motif.steps[i]);
      if (scalePitches[idx] > melHi) idx = clampIdx(idx - 7);
      if (scalePitches[idx] < melLo) idx = clampIdx(idx + 7);
      const at = pos + on;
      const strong = on % (meter === 4 ? 2 : 3) === 0 || len >= 2;
      const pcs = chordPcs(chordAtPos(at));
      if (strong) idx = nearest(idx, (m) => pcs.has(m % 12));
      else if (len >= 1.5) idx = nearest(idx, (m) => pent.has(pcIn(m)));
      const last = i === notes - 1;
      let midi = scalePitches[idx];
      let dur = len + 0.25;
      if (last && cadence) {
        idx = nearest(idx, (m) => pcIn(m) === 0);
        midi = scalePitches[idx];
        dur = len + 3;
      } else if (last) {
        dur = len + 1.5;
      }
      if (i > 0 && !last && r() < 0.07) continue;
      const arc = 0.92 + 0.16 * Math.sin((Math.PI * on) / phraseBeats);
      const vel = melBase * (0.9 + 0.2 * r()) * (strong ? 1.05 : 0.95) * arc;
      add(at, midi, vel, dur, 'piano', 0.012);
      if (len >= 2 && r() < 0.15) {
        const h = nearest(clampIdx(idx - 2), (m) => pcs.has(m % 12));
        if (scalePitches[h] < midi) add(at + 0.03, scalePitches[h], vel * 0.7, dur);
      }
    }
    prevIdx = idx;
  }

  for (let c = 0; c < cycles; c++) {
    const sec = sections[c];
    const cycleStart = c * cycleBeats;
    for (let j = 0; j < prog.length; j++) accompany(cycleStart + j * chordBeats, chordInfo(scale, prog[j]), sec);
    if (sec === 'intro') continue;
    const nPhrases = Math.max(1, Math.round(cycleBeats / phraseBeats));
    for (let ph = 0; ph < nPhrases; ph++) {
      const pos = cycleStart + ph * phraseBeats;
      const lastPhrase = c === cycles - 1 && ph === nPhrases - 1;
      if (!lastPhrase && !(c === 1 && ph === 0) && r() < (sec === 'B' ? 0.25 : 0.15)) continue;
      const motif = sec === 'B' ? motifB : ph % 2 === 1 ? motifA2 : motifA;
      phrase(motif, pos, sec === 'B' ? 79 : 74, lastPhrase);
    }
  }

  // Outro: rolled tonic chord + a last high tonic, left to ring.
  const tonic = chordInfo(scale, 0);
  const bass = bassOf(tonic);
  const roll = [0, tonic.fifth, 12, 12 + tonic.third, 24 + (tonic.ninth ? tonic.ninth - 12 : tonic.fifth), 24 + 12 + tonic.third];
  roll.forEach((iv, i) => add(mainBeats + i * 0.14, bass + iv, accBase * (1.05 - i * 0.07), outroBeats + 2, 'piano', 0));
  const top = scalePitches[nearest(idxNear(76), (m) => pcIn(m) === 0)];
  add(mainBeats + 1.5, top, melBase * 0.75, outroBeats, 'piano', 0);
  if (usePad) for (const iv of [12, 12 + tonic.fifth, 24 + tonic.third]) add(mainBeats, bass + iv, 0.6, outroBeats, 'pad', 0);

  events.sort((a, b) => a.t - b.t);
  // Loudness estimate (sum of note energies per 30 s) -> partial normalisation, so dense pieces are a
  // little softer and sparse ones a little louder (calibrated with tools/audio-calibrate.mjs).
  let energy = 0;
  for (const e of events) {
    if (e.inst !== 'piano') continue;
    const g = velocityGain(e.vel);
    energy += g * g * Math.min(e.dur, 3);
  }
  const energyDb = 10 * Math.log10(Math.max(1e-6, (energy * 30) / Math.max(30, events.length ? events[events.length - 1].t : 30)));
  const gain = Math.pow(10, clamp(0.6 * (8.5 - energyDb), -5, 5) / 20);
  return {
    seed: seed >>> 0, mode, key, keyName: KEY_NAMES[key], bpm, meter, style, progression: prog.slice(),
    barsPerChord, pad: usePad, cycles, duration: timeAt(totalBeats) + 5, gain, events,
  };
}

/** MIDI notes of a piece that use the piano (for ensurePianoSamples). */
export function pieceMidis(piece) {
  const s = new Set();
  for (const e of piece.events) if (e.inst === 'piano') s.add(e.midi);
  return [...s];
}

// ---------------------------------------------------------------------------------------------------
// SoundCore: mixer, voices, positional audio and the music scheduler on any BaseAudioContext.
//
//   voice: recipe -> input (fader, used when stolen) -> amp (volume x distance) -> [lowpass -> pan] -> sfxIn
//                                                       amp -> send -> sfxVerbIn (short room reverb)
//   sfxIn + sfx reverb -> sfxFilter (underwater lowpass) -> soundBus (sound volume) -> master
//   piece -> [per-note pan] -> pieceOut -> musicIn, pieceOut -> send -> musicVerbIn (long hall reverb)
//   musicIn + music reverb -> musicBus (music volume) -> master -> soft limiter -> destination
// ---------------------------------------------------------------------------------------------------

const irCache = new Map(); // `${kind}@${sampleRate}` -> AudioBuffer

function getImpulse(ctx, kind) {
  const key = kind + '@' + ctx.sampleRate;
  let buf = irCache.get(key);
  if (!buf) {
    const music = kind === 'music';
    const [l, r] = makeImpulse(ctx.sampleRate, music ? 3.6 : 1.3, music
      ? { rng: mulberry32(0xbeef), preDelay: 0.025, attack: 0.03, brightness: 5200, darkening: 0.15, early: 6 }
      : { rng: mulberry32(0xcafe), preDelay: 0.008, attack: 0.01, brightness: 6500, darkening: 0.1, early: 10 });
    buf = ctx.createBuffer(2, l.length, ctx.sampleRate);
    buf.getChannelData(0).set(l);
    buf.getChannelData(1).set(r);
    irCache.set(key, buf);
  }
  return buf;
}

let ceilingCache = null;
/**
 * Transfer curve of the output ceiling for inputs in [-2, 2] (the shaper sees input × 0.5): identity up
 * to |x| = 0.8, then 0.8 + 0.18·tanh((|x| − 0.8) / 0.18) — continuous slope, asymptote 0.98.
 */
export function ceilingCurve() {
  if (ceilingCache) return ceilingCache;
  const n = 4097; // odd: 0 is a sample point; the linear part is reproduced exactly by interpolation
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = ((i / (n - 1)) * 2 - 1) * 2;
    const a = Math.abs(x);
    c[i] = a <= 0.8 ? x : Math.sign(x) * (0.8 + 0.18 * Math.tanh((a - 0.8) / 0.18));
  }
  ceilingCache = c;
  return c;
}

const MUSIC_LOOKAHEAD = 1.0;       // seconds of music scheduled ahead
const MUSIC_PREPARE = 3;           // start composing / rendering samples this long before a piece
const MUSIC_GAP = [90, 240];       // silence between pieces (s)
const MUSIC_FIRST_DELAY = [3, 9];  // first piece after startMusic() (s)

/** A playing sound. Returned by play() / playBlock(): `stop(fade)`, `setPosition(x, y, z)`, `playing`. */
class Voice {
  constructor(core, key, positional, x, y, z, range) {
    this.core = core;
    this.key = key;
    this.positional = positional;
    this.x = x; this.y = y; this.z = z;
    this.range = range;
    this.level = 1;
    this.reverb = 0;
    this.sources = [];
    this.input = null; this.amp = null; this.lp = null; this.pan = null; this.send = null; this.out = null;
    this.startTime = 0;
    this.endTime = 0;
    this.stopped = false;
  }

  /** True until the sound has finished (or was stopped). */
  get playing() {
    return !this.stopped && this.core.ctx.currentTime < this.endTime;
  }

  /** Fade out over `fade` seconds and stop every source of this voice. */
  stop(fade = 0.05) {
    if (this.stopped) return;
    this.stopped = true;
    const now = this.core.ctx.currentTime;
    fade = Math.max(0.005, finite(fade, 0.05));
    try {
      const g = this.input.gain;
      g.cancelScheduledValues(now);
      g.setValueAtTime(1, now);
      g.linearRampToValueAtTime(0, now + fade);
    } catch { /* already disconnected */ }
    for (const s of this.sources) {
      try { s.stop(now + fade + 0.01); } catch { /* not started / already stopped */ }
    }
    this.endTime = Math.min(this.endTime, now + fade + 0.03);
  }

  /** Move a playing positional sound (e.g. a hissing creeper). */
  setPosition(x, y, z) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
    this.x = x; this.y = y; this.z = z;
    if (this.positional && !this.stopped) this.core._spatialize(this, false);
  }
}

/**
 * Context-agnostic sound system. AudioEngine wraps one for the live AudioContext; the self-check
 * creates one per OfflineAudioContext. options: { soundVolume, musicVolume, maxVoices, rng, strict }
 * (strict: recipe errors are thrown instead of being swallowed).
 */
export class SoundCore {
  constructor(ctx, { soundVolume = 1, musicVolume = 1, maxVoices = DEFAULT_MAX_VOICES, rng = Math.random, strict = false } = {}) {
    this.ctx = ctx;
    this.rng = rng;
    this.strict = strict;
    this.kit = new SynthKit(ctx, rng);
    this.maxVoices = Math.max(1, maxVoices | 0);
    this.voices = [];   // active voices, oldest first
    this.dying = [];    // stolen voices fading out
    this.listener = { x: 0, y: 0, z: 0, yaw: 0, set: false };
    this.soundVolume = clamp(finite(soundVolume, 1), 0, 1);
    this.musicVolume = clamp(finite(musicVolume, 1), 0, 1);
    this.underwater = false;
    this.music = {
      state: 'off', nextAt: 0, piece: null, start: 0, next: 0, out: null, send: null, gen: 0, seed: null, fading: [],
    };
    this._recent = new Map();
    this._sp = { gain: 1, pan: 0, lowpass: 20000, distance: 0 };
    this._warned = false;
    this.limiter = null;   // master DynamicsCompressor (when available)
    this.ceiling = null;   // output soft clipper, the last node before the destination (when available)
    this._buildMixer();
  }

  _buildMixer() {
    const ctx = this.ctx;
    const k = this.kit;
    this.master = k.gain(1);
    let tail = this.master;
    if (typeof ctx.createDynamicsCompressor === 'function') {
      // Soft limiter: only rare peaks (explosions, many simultaneous sounds) are compressed. Note that
      // WebAudio adds an automatic make-up gain (about +2.1 dB with these settings) and that a fresh
      // compressor starts with heavy gain reduction for ~0.1 s; offline renders therefore play their
      // sound after a silent pre-roll (renderWarm), so calibration measures what the player hears.
      const lim = ctx.createDynamicsCompressor();
      lim.threshold.value = -6;
      lim.knee.value = 6;
      lim.ratio.value = 12;
      lim.attack.value = 0.002;
      lim.release.value = 0.2;
      this.master.connect(lim);
      tail = lim;
      this.limiter = lim;
    }
    if (typeof ctx.createWaveShaper === 'function') {
      // Output ceiling: transients shorter than the limiter's 2 ms attack can still overshoot, so a
      // soft clipper (linear up to ±0.8, saturating smoothly toward ±0.98) guarantees |x| < 1 at the
      // destination. The curve spans an input of ±2 (+6 dBFS), hence the 0.5 pre-gain.
      const pre = k.gain(0.5);
      const shaper = ctx.createWaveShaper();
      shaper.curve = ceilingCurve();
      shaper.oversample = '2x';
      tail.connect(pre);
      pre.connect(shaper);
      tail = shaper;
      this.ceiling = shaper; // last node before the destination (tap it to meter the output)
    }
    tail.connect(ctx.destination);
    this.soundBus = k.gain(this.soundVolume, this.master);
    this.sfxFilter = k.filter('lowpass', 20000, 0.707, this.soundBus);
    this.sfxIn = k.gain(1, this.sfxFilter);
    this.sfxVerbIn = k.gain(1);
    this.musicBus = k.gain(this.musicVolume, this.master);
    this.musicIn = k.gain(1, this.musicBus);
    this.musicVerbIn = k.gain(1);
    if (typeof ctx.createConvolver === 'function') {
      const sfxVerb = ctx.createConvolver();
      sfxVerb.buffer = getImpulse(ctx, 'sfx');
      this.sfxVerbIn.connect(sfxVerb);
      sfxVerb.connect(k.gain(0.8, this.sfxFilter));
      const musicVerb = ctx.createConvolver();
      musicVerb.buffer = getImpulse(ctx, 'music');
      this.musicVerbIn.connect(musicVerb);
      musicVerb.connect(k.gain(0.9, this.musicBus));
    }
  }

  _ramp(param, value, tc = 0.03) {
    const now = this.ctx.currentTime;
    param.cancelScheduledValues(now);
    param.setTargetAtTime(value, now, tc);
  }

  /** Bus volumes 0..1 (non-finite arguments are ignored). */
  setVolumes(sound, music) {
    if (Number.isFinite(sound)) {
      this.soundVolume = clamp(sound, 0, 1);
      this._ramp(this.soundBus.gain, this.soundVolume);
    }
    if (Number.isFinite(music)) {
      this.musicVolume = clamp(music, 0, 1);
      this._ramp(this.musicBus.gain, this.musicVolume);
    }
  }

  /** Muffle sound effects while the camera is under water. */
  setUnderwater(flag) {
    flag = !!flag;
    if (flag === this.underwater) return;
    this.underwater = flag;
    this._ramp(this.sfxFilter.frequency, flag ? 650 : 20000, 0.08);
  }

  /** Listener (camera) position and yaw (SPEC §4); updates the panning of long sounds. */
  setListener(x, y, z, yaw) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
    const L = this.listener;
    L.x = x; L.y = y; L.z = z;
    L.yaw = finite(yaw, 0);
    L.set = true;
    const now = this.ctx.currentTime;
    for (const v of this.voices) {
      if (v.positional && !v.stopped && v.endTime - now > 0.1) this._spatialize(v, false);
    }
  }

  /** Apply distance gain / pan / damping to a voice. Returns the distance gain (0 = inaudible). */
  _spatialize(v, initial) {
    const sp = this._sp;
    const L = this.listener;
    if (v.positional && L.set) {
      spatialize(L.x, L.y, L.z, L.yaw, v.x, v.y, v.z, v.range, sp);
    } else {
      sp.gain = 1; sp.pan = 0; sp.lowpass = 20000; sp.distance = 0;
    }
    const amp = v.level * sp.gain;
    const send = v.reverb * v.level * Math.sqrt(sp.gain); // reverb falls off slower than the dry sound
    if (initial) {
      v.amp.gain.value = amp;
      if (v.send) v.send.gain.value = send;
      if (v.pan) v.pan.pan.value = sp.pan;
      if (v.lp) v.lp.frequency.value = this.kit.hz(sp.lowpass);
    } else {
      const now = this.ctx.currentTime;
      v.amp.gain.setTargetAtTime(amp, now, 0.03);
      if (v.send) v.send.gain.setTargetAtTime(send, now, 0.03);
      if (v.pan) v.pan.pan.setTargetAtTime(sp.pan, now, 0.03);
      if (v.lp) v.lp.frequency.setTargetAtTime(this.kit.hz(sp.lowpass), now, 0.03);
    }
    return sp.gain;
  }

  /**
   * Named sound. opts: { x, y, z (omit for a non-positional sound), volume = 1 (> 1 = audible further,
   * like Minecraft), pitch = 1 }. Returns a Voice or null when nothing was played.
   */
  play(name, opts) {
    const key = resolveSoundName(name);
    if (!key) return null;
    const def = SOUNDS[key];
    const o = opts || {};
    const volume = clamp(finite(o.volume, 1), 0, 16);
    const pitch = clamp(finite(o.pitch, 1), 0.25, 4) * (1 + (this.rng() - this.rng()) * def.vary);
    return this._start(key, def.fn, undefined, o.x, o.y, o.z, volume, pitch, def.gain, def.reverb,
      def.range ?? 16, def.positional !== false);
  }

  /** Block sound: kind 'break'|'place'|'step'|'hit'|'land', material = block.sound (unknown -> stone). */
  playBlock(kind, material, x, y, z, opts) {
    const kp = KIND_PARAMS[kind];
    if (!kp) return null;
    const mat = Object.prototype.hasOwnProperty.call(MATERIAL_RECIPES, material) ? material : 'stone';
    let fn = MATERIAL_RECIPES[mat][kp.step ? 1 : 0];
    if (kind === 'land') {
      const base = fn;
      fn = (k, out, t, p, kd) => Math.max(base(k, out, t, p, kd), landThud(k, out, t, mat));
    }
    const o = opts || {};
    const volume = clamp(finite(o.volume, 1), 0, 16);
    const pitch = kp.pitch * clamp(finite(o.pitch, 1), 0.25, 4) * (1 + (this.rng() - this.rng()) * kp.vary);
    const trim = Math.pow(10, BLOCK_TRIM_DB[mat][KIND_INDEX[kind]] / 20);
    return this._start(kind + ':' + mat, fn, kind, x, y, z, volume, pitch, kp.gain * trim, kp.reverb, 16, true);
  }

  _start(key, fn, kind, x, y, z, volume, pitch, gain, reverb, range, positional) {
    if (this.soundVolume <= 0 || !(volume > 0)) return null;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    this._prune(now);
    // Spam guard: at most 3 identical sounds per 35 ms (e.g. many blocks changing in one frame).
    const rec = this._recent.get(key);
    if (rec && now - rec.t < 0.035) {
      if (rec.n >= 3) return null;
      rec.n++;
    } else if (rec) {
      rec.t = now; rec.n = 1;
    } else {
      this._recent.set(key, { t: now, n: 1 });
    }
    const hasPos = positional && Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z);
    const effRange = range * Math.max(1, volume);
    if (hasPos && this.listener.set) {
      const L = this.listener;
      if (spatialize(L.x, L.y, L.z, L.yaw, x, y, z, effRange, this._sp).gain <= 0.002) return null;
    }
    while (this.voices.length >= this.maxVoices) this._steal(this.voices.shift());

    const k = this.kit;
    const v = new Voice(this, key, hasPos, x, y, z, effRange);
    // Small random level variation per play (±10 %), on top of the random pitch and recipe details.
    v.level = Math.min(volume, 1) * gain * (0.9 + 0.2 * this.rng());
    v.reverb = reverb;
    v.input = k.gain(1);
    v.amp = k.gain(0);
    v.input.connect(v.amp);
    let node = v.amp;
    if (hasPos) {
      v.lp = k.filter('lowpass', 20000, 0.707);
      node = chain(node, v.lp);
      if (typeof ctx.createStereoPanner === 'function') {
        v.pan = ctx.createStereoPanner();
        node = chain(node, v.pan);
      }
    }
    node.connect(this.sfxIn);
    v.out = node;
    if (reverb > 0) {
      v.send = k.gain(0, this.sfxVerbIn);
      v.amp.connect(v.send);
    }
    this._spatialize(v, true);
    const t = now + 0.005;
    k.sources = v.sources;
    let end;
    try {
      end = fn(k, v.input, t, pitch, kind);
    } catch (err) {
      k.sources = null;
      v.stop(0.005);
      this._disconnect(v);
      if (this.strict) throw err;
      this._warn(err);
      return null;
    }
    k.sources = null;
    v.startTime = t;
    v.endTime = finite(end, t + 1) + 0.05;
    this.voices.push(v);
    return v;
  }

  _steal(v) {
    v.stop(0.025);
    this.dying.push(v);
  }

  _disconnect(v) {
    try { v.out?.disconnect(); } catch { /* ignore */ }
    try { v.send?.disconnect(); } catch { /* ignore */ }
  }

  _prune(now) {
    let w = 0;
    for (let i = 0; i < this.voices.length; i++) {
      const v = this.voices[i];
      if (now >= v.endTime) this._disconnect(v);
      else this.voices[w++] = v;
    }
    this.voices.length = w;
    if (this.dying.length) {
      w = 0;
      for (let i = 0; i < this.dying.length; i++) {
        const v = this.dying[i];
        if (now >= v.endTime) this._disconnect(v);
        else this.dying[w++] = v;
      }
      this.dying.length = w;
    }
  }

  _warn(err) {
    if (this._warned) return;
    this._warned = true;
    console.warn('[audio] sound synthesis failed:', err);
  }

  /** Per-frame housekeeping: free finished voices, schedule music. */
  update() {
    const now = this.ctx.currentTime;
    this._prune(now);
    this._pumpMusic(now);
  }

  /** Number of active (not stolen) voices. */
  get voiceCount() {
    return this.voices.length;
  }

  // ------------------------------------------------------------------------------------------ music

  /** Begin the music cycle: first piece after `delay` s (default 3-9 s), then one every few minutes. */
  startMusic({ delay } = {}) {
    const m = this.music;
    if (m.state !== 'off') return;
    m.state = 'waiting';
    const d = Number.isFinite(delay) ? clamp(delay, 0, 3600)
      : MUSIC_FIRST_DELAY[0] + this.rng() * (MUSIC_FIRST_DELAY[1] - MUSIC_FIRST_DELAY[0]);
    m.nextAt = this.ctx.currentTime + d;
  }

  /** Fade out the current piece and stop the music cycle. */
  stopMusic({ fade = 2.5 } = {}) {
    const m = this.music;
    m.gen++;
    this._retirePiece(Math.max(0.05, finite(fade, 2.5)));
    m.state = 'off';
    m.piece = null;
  }

  /** Start a new piece now (crossfading out the current one); `seed` optional. Test page / debug. */
  playMusicNow(seed) {
    const m = this.music;
    m.gen++;
    this._retirePiece(1.5);
    m.state = 'waiting';
    m.nextAt = this.ctx.currentTime;
    m.seed = Number.isFinite(seed) ? seed >>> 0 : null;
    this._pumpMusic(this.ctx.currentTime);
  }

  /** { state: 'off'|'waiting'|'preparing'|'playing', piece, position (s), nextIn (s) } */
  get musicStatus() {
    const m = this.music;
    const now = this.ctx.currentTime;
    const p = m.piece;
    return {
      state: m.state,
      piece: p ? { seed: p.seed, mode: p.mode, key: p.keyName, bpm: p.bpm, meter: p.meter, style: p.style,
        progression: p.progression, pad: p.pad, duration: p.duration, notes: p.events.length } : null,
      position: m.state === 'playing' ? Math.max(0, now - m.start) : 0,
      nextIn: m.state === 'waiting' ? Math.max(0, m.nextAt - now) : 0,
    };
  }

  _pumpMusic(now) {
    const m = this.music;
    if (m.fading.length) {
      m.fading = m.fading.filter((f) => {
        if (now < f.at) return true;
        try { f.out.disconnect(); } catch { /* ignore */ }
        return false;
      });
    }
    if (m.state === 'waiting' && now >= m.nextAt - MUSIC_PREPARE) this._preparePiece();
    else if (m.state === 'playing') this._schedule(now, now + MUSIC_LOOKAHEAD);
  }

  _preparePiece() {
    const m = this.music;
    const seed = m.seed ?? Math.floor(this.rng() * 0x7fffffff);
    m.seed = null;
    const piece = composePiece(seed);
    const gen = ++m.gen;
    m.state = 'preparing';
    m.piece = piece;
    ensurePianoSamples(pieceMidis(piece)).then(() => {
      if (gen !== m.gen || m.state !== 'preparing') return;
      try {
        this._beginPiece(piece, Math.max(this.ctx.currentTime + 0.1, m.nextAt));
        this._schedule(this.ctx.currentTime, this.ctx.currentTime + MUSIC_LOOKAHEAD);
      } catch (err) {
        // e.g. the context was closed meanwhile: give up on this piece, never reject.
        m.state = 'off';
        if (this.strict) console.error(err);
        else this._warn(err);
      }
    });
  }

  _beginPiece(piece, when) {
    const m = this.music;
    const k = this.kit;
    m.state = 'playing';
    m.piece = piece;
    m.start = when;
    m.next = 0;
    m.out = k.gain(piece.gain ?? 1, this.musicIn);
    m.level = piece.gain ?? 1;
    m.send = k.gain(0.42, this.musicVerbIn);
    m.out.connect(m.send);
  }

  /** Schedule every event of the playing piece that starts before `horizon`. */
  _schedule(now, horizon) {
    const m = this.music;
    const p = m.piece;
    const ev = p.events;
    // Fell behind (throttled timer, long hitch): slide the piece instead of skipping or bunching notes.
    if (m.next < ev.length && m.start + ev[m.next].t < now - 0.05) m.start = now + 0.05 - ev[m.next].t;
    const k = this.kit;
    const ctx = this.ctx;
    const audible = this.musicVolume > 0.001;
    const panner = typeof ctx.createStereoPanner === 'function';
    while (m.next < ev.length && m.start + ev[m.next].t < horizon) {
      const e = ev[m.next++];
      if (!audible) continue;
      const when = m.start + e.t;
      try {
        if (e.inst === 'pad') {
          playPad(k, m.out, when, e.midi, e.vel, e.dur);
        } else {
          let dest = m.out;
          if (panner) {
            const pn = ctx.createStereoPanner();
            pn.pan.value = clamp((e.midi - 62) / 40, -0.45, 0.45); // low notes left, high notes right
            pn.connect(m.out);
            dest = pn;
          }
          playPiano(k, dest, when, e.midi, e.vel, e.dur);
        }
      } catch (err) {
        if (this.strict) throw err;
        this._warn(err);
      }
    }
    if (m.next >= ev.length && now > m.start + p.duration) {
      this._retirePiece(0);
      m.piece = null;
      m.state = 'waiting';
      m.nextAt = now + MUSIC_GAP[0] + this.rng() * (MUSIC_GAP[1] - MUSIC_GAP[0]);
    }
  }

  /** Detach the current piece output (fading it out over `fade` s; 0 = it already ended). */
  _retirePiece(fade) {
    const m = this.music;
    if (!m.out) return;
    const now = this.ctx.currentTime;
    if (fade > 0) {
      const g = m.out.gain;
      g.cancelScheduledValues(now);
      g.setValueAtTime(m.level ?? 1, now);
      g.linearRampToValueAtTime(0, now + fade);
    }
    m.fading.push({ out: m.out, at: now + (fade > 0 ? fade + 0.1 : 4) });
    m.out = null;
    m.send = null;
  }

  /** Schedule a whole pre-composed piece at `when` (offline rendering / tests). */
  schedulePiece(piece, when = this.ctx.currentTime + 0.05, horizon = Infinity) {
    this.music.gen++;
    this._retirePiece(0.05);
    this._beginPiece(piece, when);
    this._schedule(this.ctx.currentTime, when + horizon);
  }

  /** Stop everything and detach the mixer. */
  dispose() {
    for (const v of this.voices) { v.stop(0.01); this._disconnect(v); }
    this.voices.length = 0;
    this.stopMusic({ fade: 0.05 });
    try { this.master.disconnect(); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------------------------------
// AudioEngine: the public API (SPEC §9.9)
// ---------------------------------------------------------------------------------------------------

const GESTURE_EVENTS = ['pointerdown', 'pointerup', 'mousedown', 'keydown', 'touchend'];

/**
 * Game audio. The AudioContext is created lazily on the first user gesture (browsers refuse to start
 * audio earlier); until then every call is a cheap no-op (play() before unlock is ignored). Never
 * throws, also when WebAudio is unavailable (`available === false`).
 *
 *   const audio = new AudioEngine(settings);            // settings.soundVolume / musicVolume (0..1)
 *   audio.unlock();                                     // in a pointerdown/keydown handler (also automatic)
 *   audio.setListener(cam.x, cam.y, cam.z, cam.yaw);    // every frame
 *   audio.update(dt);                                   // every frame
 *   audio.playBlock('break', BLOCKS[id].sound, x + 0.5, y + 0.5, z + 0.5);
 *   audio.play('hurt', { x, y, z });  audio.play('click');
 *   audio.startMusic();  audio.stopMusic();
 */
export class AudioEngine {
  /**
   * @param {object} settings  soundVolume / musicVolume (0..1) are read at unlock (setVolumes later)
   * @param {object} [options] { maxVoices = 24, autoUnlock = true (window gesture listeners call unlock),
   *   suspendWhenHidden = true (suspend the context while the tab is hidden), AudioContextClass
   *   (dependency injection for tests), seed (deterministic variations), force (unlock without a
   *   recorded user activation) }
   */
  constructor(settings = {}, options = {}) {
    this.settings = settings || {};
    this.options = options || {};
    const AC = this.options.AudioContextClass ?? (globalThis.AudioContext || globalThis.webkitAudioContext);
    this._AC = typeof AC === 'function' ? AC : null;
    /** False when WebAudio is missing or failed: every method is then a no-op. */
    this.available = !!this._AC;
    /** @type {AudioContext|null} */
    this.ctx = null;
    /** @type {SoundCore|null} */
    this.core = null;
    this._soundVolume = clamp(finite(this.settings.soundVolume, 1), 0, 1);
    this._musicVolume = clamp(finite(this.settings.musicVolume, 1), 0, 1);
    this._listener = null;
    this._underwater = false;
    this._musicWanted = false;
    this._musicOpts = undefined;
    this._timer = null;
    this._gestureFn = null;
    this._visFn = null;
    this._warned = false;
    this._resuming = false;
    this._unknown = null;   // names passed to play() that do not exist (warned once each)
    if (this.available && this.options.autoUnlock !== false) this._armGestures();
    if (this.available && this.options.suspendWhenHidden !== false && typeof document !== 'undefined'
      && typeof document.addEventListener === 'function') {
      this._visFn = () => this._onVisibility();
      document.addEventListener('visibilitychange', this._visFn);
    }
  }

  /** True once the AudioContext exists and runs (sounds are audible). */
  get unlocked() {
    return !!this.ctx && this.ctx.state === 'running';
  }

  /**
   * Create / resume the AudioContext. Call from a user gesture (the UI does on the first pointerdown;
   * window gesture listeners also do unless options.autoUnlock === false). Returns false when audio is
   * unavailable or no user gesture has happened yet.
   */
  unlock() {
    if (!this.available) return false;
    try {
      if (!this.ctx) {
        const ua = typeof navigator !== 'undefined' ? navigator.userActivation : null;
        // Without any user activation the context would start suspended (and Chrome warns).
        if (ua && ua.hasBeenActive === false && !this.options.force) return false;
        this._createContext();
      }
      const ctx = this.ctx;
      if (ctx.state === 'running') {
        this._disarmGestures();
      } else if (ctx.state !== 'closed' && !this._hidden()) {
        const p = ctx.resume();
        if (p && typeof p.then === 'function') {
          this._resuming = true;
          p.then(() => {
            this._resuming = false;
            if (ctx.state === 'running') this._disarmGestures();
          }, () => { this._resuming = false; });
        }
      }
      return true;
    } catch (err) {
      this._fail(err);
      return false;
    }
  }

  /** Sounds play while running, or while a resume() requested by unlock() is pending (starts a few ms late). */
  _canPlay() {
    const ctx = this.ctx;
    return !!this.core && (ctx.state === 'running' || (this._resuming && ctx.state === 'suspended'));
  }

  _createContext() {
    let ctx;
    try {
      ctx = new this._AC({ latencyHint: 'interactive' });
    } catch {
      ctx = new this._AC();
    }
    this.ctx = ctx;
    this.core = new SoundCore(ctx, {
      soundVolume: this._soundVolume,
      musicVolume: this._musicVolume,
      maxVoices: this.options.maxVoices ?? DEFAULT_MAX_VOICES,
      rng: Number.isFinite(this.options.seed) ? mulberry32(this.options.seed) : Math.random,
    });
    if (this._listener) this.core.setListener(this._listener[0], this._listener[1], this._listener[2], this._listener[3]);
    if (this._underwater) this.core.setUnderwater(true);
    if (this._musicWanted) this.core.startMusic(this._musicOpts);
    ctx.onstatechange = () => {
      if (ctx.state === 'running') this._disarmGestures();
      else if (ctx.state !== 'closed' && this.options.autoUnlock !== false && !this._hidden()) this._armGestures();
    };
  }

  _hidden() {
    return typeof document !== 'undefined' && document.visibilityState === 'hidden';
  }

  _onVisibility() {
    const ctx = this.ctx;
    if (!ctx || ctx.state === 'closed') return;
    try {
      if (this._hidden()) {
        if (ctx.state === 'running') ctx.suspend()?.catch?.(() => {});
      } else if (ctx.state !== 'running') {
        ctx.resume()?.catch?.(() => {});
      }
    } catch { /* ignore */ }
  }

  _armGestures() {
    if (this._gestureFn || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
    this._gestureFn = () => this.unlock();
    for (const type of GESTURE_EVENTS) window.addEventListener(type, this._gestureFn, { capture: true, passive: true });
  }

  _disarmGestures() {
    if (!this._gestureFn) return;
    for (const type of GESTURE_EVENTS) window.removeEventListener(type, this._gestureFn, { capture: true });
    this._gestureFn = null;
  }

  _fail(err) {
    this.available = false;
    this._disarmGestures();
    this._warn(err);
  }

  _warn(err) {
    if (this._warned) return;
    this._warned = true;
    console.warn('[audio] disabled / degraded:', err);
  }

  /** Run `fn` against the core; any exception is swallowed (logged once). */
  _guard(fn, fallback) {
    try {
      return fn();
    } catch (err) {
      this._warn(err);
      return fallback;
    }
  }

  /**
   * Sound and music volume 0..1 (the options sliders). With no arguments the values are re-read from
   * the settings object given to the constructor.
   */
  setVolumes(sound, music) {
    if (sound === undefined && music === undefined) {
      sound = this.settings.soundVolume;
      music = this.settings.musicVolume;
    }
    if (Number.isFinite(sound)) this._soundVolume = clamp(sound, 0, 1);
    if (Number.isFinite(music)) this._musicVolume = clamp(music, 0, 1);
    if (this.core) this._guard(() => this.core.setVolumes(this._soundVolume, this._musicVolume));
  }

  /** Listener = camera eye position and yaw (SPEC §4). Call every frame. */
  setListener(x, y, z, yaw) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
    const l = this._listener ?? (this._listener = [0, 0, 0, 0]);
    l[0] = x; l[1] = y; l[2] = z; l[3] = finite(yaw, 0);
    if (this.core) this._guard(() => this.core.setListener(x, y, z, l[3]));
  }

  /** Muffle sound effects while the camera is under water (optional; game.js may call it per frame). */
  setUnderwater(flag) {
    this._underwater = !!flag;
    if (this.core) this._guard(() => this.core.setUnderwater(this._underwater));
  }

  /**
   * Block sound. kind: 'break'|'place'|'step'|'hit'|'land'; material: block.sound. Position = sound
   * origin in world coordinates. Returns a voice handle ({ stop(fade), setPosition(x,y,z), playing }) or null.
   */
  playBlock(kind, material, x, y, z, opts) {
    if (!this._canPlay()) return null;
    return this._guard(() => this.core.playBlock(kind, material, x, y, z, opts), null);
  }

  /**
   * Named sound (SOUND_NAMES). opts: { x, y, z } world position (omit for UI / non-positional sounds),
   * volume (default 1; > 1 extends the audible range like Minecraft), pitch (default 1).
   * Returns a voice handle or null (unknown name, inaudible, not unlocked yet, ...).
   */
  play(name, opts) {
    if (!resolveSoundName(name)) {
      // A typo in a caller would otherwise be silent forever: say so once per name (also before unlock).
      this._unknown ??= new Set();
      const key = String(name);
      if (!this._unknown.has(key) && this._unknown.size < 32) {
        this._unknown.add(key);
        console.warn(`[audio] unknown sound '${key}' (see SOUND_NAMES / SOUND_ALIASES in src/game/audio.js)`);
      }
      return null;
    }
    if (!this._canPlay()) return null;
    return this._guard(() => this.core.play(name, opts), null);
  }

  /**
   * Start the generative music cycle: the first piece begins shortly after (options.delay seconds,
   * default 3-9 s), then a new piece every few minutes with silence in between. Idempotent. Works
   * before unlock (music starts once audio is unlocked).
   */
  startMusic(opts) {
    if (!this.available) return;
    this._musicWanted = true;
    this._musicOpts = opts;
    if (this.core) this._guard(() => this.core.startMusic(opts));
    this._startTimer();
  }

  /** Fade the current piece out (options.fade seconds, default 2.5) and stop the music cycle. */
  stopMusic(opts) {
    this._musicWanted = false;
    if (this.core) this._guard(() => this.core.stopMusic(opts));
  }

  /** Start a new piece immediately (test page / debug); optional seed. */
  playMusicNow(seed) {
    if (!this.available) return;
    this._musicWanted = true;
    this._startTimer();
    if (this.core) this._guard(() => this.core.playMusicNow(seed));
  }

  /** Music state for debugging: { state, piece, position, nextIn }. */
  get musicStatus() {
    if (this.core) return this.core.musicStatus;
    return { state: this._musicWanted ? 'locked' : 'off', piece: null, position: 0, nextIn: 0 };
  }

  /** Per-frame housekeeping (frees finished voices, schedules music). */
  update(dt) {
    if (this.core) this._guard(() => this.core.update(dt));
  }

  _startTimer() {
    // Fallback pump so music keeps flowing even when update() is not called (loading screens...).
    if (this._timer || typeof setInterval !== 'function') return;
    this._timer = setInterval(() => {
      if (this.core && this.ctx.state === 'running') this._guard(() => this.core.update(0));
    }, 250);
    this._timer?.unref?.();
  }

  /** Release everything (closes the AudioContext). */
  destroy() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    this._disarmGestures();
    if (this._visFn) document.removeEventListener('visibilitychange', this._visFn);
    this._visFn = null;
    if (this.core) this._guard(() => this.core.dispose());
    if (this.ctx) {
      const ctx = this.ctx;
      try { ctx.close()?.catch?.(() => {}); } catch { /* ignore */ }
    }
    this.core = null;
    this.ctx = null;
    this.available = false;
  }
}

// ---------------------------------------------------------------------------------------------------
// Offline rendering helpers (self-check / test page)
// ---------------------------------------------------------------------------------------------------

/** Seconds of silence rendered before an offline sound so the master limiter has settled. */
export const RENDER_PREROLL = 0.3;

/**
 * Render into a fresh OfflineAudioContext the way it sounds in the running game: the mixer first runs
 * `RENDER_PREROLL` seconds of silence (a fresh DynamicsCompressor starts with up to −13 dB of gain
 * reduction and only reaches its steady make-up gain after ~0.1 s — calibrating against that cold state
 * made every sound 4–12 dB too loud in game), then `play(core)` runs. The returned buffer starts at that
 * moment (the pre-roll is cut off). Without OfflineAudioContext.suspend (old engines) it plays at once.
 */
async function renderWarm(seconds, sampleRate, seed, setup, play) {
  const OAC = offlineContextClass();
  if (!OAC) throw new Error('OfflineAudioContext is not available');
  const canSuspend = typeof OAC.prototype.suspend === 'function';
  const pre = canSuspend ? RENDER_PREROLL : 0;
  const ctx = new OAC(2, Math.max(1, Math.ceil((seconds + pre) * sampleRate)), sampleRate);
  const core = new SoundCore(ctx, { rng: mulberry32(seed), strict: true });
  if (setup) setup(core);
  let startFrame = 0;
  let failure = null;
  const go = () => {
    startFrame = Math.round(ctx.currentTime * sampleRate);
    try {
      play(core);
    } catch (err) {
      failure = err;
    }
  };
  if (pre > 0) {
    // Always resume, even if play() threw, or the render would never finish.
    ctx.suspend(pre).then(() => {
      go();
      return ctx.resume();
    });
  } else {
    go();
  }
  const rendered = await renderContext(ctx);
  if (failure) throw failure;
  if (startFrame <= 0) return rendered;
  const length = Math.max(1, rendered.length - startFrame);
  const out = ctx.createBuffer(rendered.numberOfChannels, length, sampleRate);
  for (let c = 0; c < rendered.numberOfChannels; c++) {
    out.getChannelData(c).set(rendered.getChannelData(c).subarray(startFrame, startFrame + length));
  }
  return out;
}

/**
 * Render one sound through the full mixer into an OfflineAudioContext, after the limiter has settled
 * (see renderWarm). spec: a SOUND_NAMES entry (or alias) or { kind, material }. options: { sampleRate =
 * 48000, seconds = 2, seed, volume, pitch, reverb = true }. Resolves to an AudioBuffer (stereo) that
 * starts 5 ms before the sound.
 */
export async function renderSoundOffline(spec, {
  sampleRate = 48000, seconds = 2, seed = 1, volume = 1, pitch = 1, reverb = true,
} = {}) {
  return renderWarm(seconds, sampleRate, seed, (core) => {
    if (!reverb) core.sfxVerbIn.gain.value = 0;
  }, (core) => {
    const v = typeof spec === 'string'
      ? core.play(spec, { volume, pitch })
      : core.playBlock(spec.kind, spec.material, undefined, undefined, undefined, { volume, pitch });
    if (!v) throw new Error('nothing was played for ' + JSON.stringify(spec));
  });
}

/**
 * Render the first `seconds` of a generated piece (or of `piece`, any { events, duration } object —
 * e.g. single test notes). Piano samples are rendered first when needed. Resolves to { buffer, piece }.
 */
export async function renderMusicOffline({ seed = 1, seconds = 30, sampleRate = 48000, piece = null } = {}) {
  piece = piece ?? composePiece(seed);
  await ensurePianoSamples(pieceMidis(piece));
  const dur = Math.max(1 / sampleRate, Math.min(seconds, piece.duration));
  const buffer = await renderWarm(dur, sampleRate, seed, null, (core) => {
    core.schedulePiece(piece, core.ctx.currentTime + 0.05, dur);
  });
  return { buffer, piece };
}
