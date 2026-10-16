// Loudness calibration helper for src/game/audio.js (run inside the browser through the harness):
//   node tools/harness.mjs --url tools/audio-test.html --eval "import('/tools/audio-calibrate.mjs').then(m => m.run())"
// For every sound: mean / max peak (dBFS) and "loudness" = max A-weighted RMS over 100 ms windows,
// averaged over several random variations (dry, i.e. without the reverb send). renderSoundOffline plays
// each sound after a silent pre-roll, so the master limiter has settled exactly as in the running game.
// check() compares everything with TARGETS (±1.5 dB, peaks below 0 dBFS):
//   node tools/harness.mjs --url tools/audio-test.html --eval "import('/tools/audio-calibrate.mjs').then(m => m.check())"
import { renderSoundOffline, SOUND_NAMES, BLOCK_KINDS, BLOCK_MATERIALS } from '../src/game/audio.js';

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < half; j++) {
        const a = i + j, b = a + half;
        const vr = re[b] * cr - im[b] * ci;
        const vi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - vr; im[b] = im[a] - vi;
        re[a] += vr; im[a] += vi;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

function aWeight(f) {
  const f2 = f * f;
  const ra = (12194 ** 2 * f2 * f2) / ((f2 + 20.6 ** 2) * Math.sqrt((f2 + 107.7 ** 2) * (f2 + 737.9 ** 2)) * (f2 + 12194 ** 2));
  return ra * 1.2589; // +2.0 dB -> 1 at 1 kHz
}

const NFFT = 8192;
let weights = null;

/** { peakDb, loudDb, len40 } of a buffer. */
export function measure(buffer) {
  const sr = buffer.sampleRate;
  if (!weights || weights.sr !== sr) {
    weights = new Float64Array(NFFT / 2 + 1);
    for (let k = 0; k <= NFFT / 2; k++) weights[k] = aWeight((k * sr) / NFFT) ** 2;
    weights.sr = sr;
  }
  const n = buffer.length;
  const x = new Float32Array(n);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) x[i] += d[i] / buffer.numberOfChannels;
  }
  let peak = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(d[i]));
  }
  let last = 0;
  const thr = peak * 0.01;
  for (let i = 0; i < n; i++) if (Math.abs(x[i]) > thr) last = i;
  const win = Math.round(0.1 * sr), hop = Math.round(0.025 * sr);
  const re = new Float64Array(NFFT), im = new Float64Array(NFFT);
  let best = 0;
  for (let s = 0; s + hop < Math.min(n, last + win); s += hop) {
    re.fill(0); im.fill(0);
    for (let i = 0; i < win && s + i < n; i++) re[i] = x[s + i];
    fft(re, im);
    let e = 0;
    for (let k = 0; k <= NFFT / 2; k++) e += (re[k] * re[k] + im[k] * im[k]) * weights[k] * (k === 0 || k === NFFT / 2 ? 1 : 2);
    const rms2 = e / (NFFT * win);
    if (rms2 > best) best = rms2;
  }
  return { peakDb: 20 * Math.log10(peak + 1e-12), loudDb: 10 * Math.log10(best + 1e-24), len40: last / sr };
}

const SECONDS = { explode: 3.5, fuse: 2, creeper_hiss: 2, death: 1.4, cow: 1.8, zombie: 1.8, splash: 1.3, sheep: 1.2 };

export async function run({ seeds = 4, only = null } = {}) {
  const specs = [
    ...SOUND_NAMES.map((n) => ({ label: n, spec: n })),
    ...BLOCK_MATERIALS.flatMap((mat) => BLOCK_KINDS.map((kind) => ({ label: `${kind}:${mat}`, spec: { kind, material: mat } }))),
  ].filter((s) => !only || only.some((o) => s.label.includes(o)));
  const out = {};
  for (const s of specs) {
    const acc = { peak: 0, peakMax: -200, loud: 0, len: 0 };
    for (let seed = 1; seed <= seeds; seed++) {
      const buf = await renderSoundOffline(s.spec, { seconds: SECONDS[s.label] ?? 1, seed: seed * 977, reverb: false });
      const m = measure(buf);
      acc.peak += m.peakDb / seeds;
      acc.peakMax = Math.max(acc.peakMax, m.peakDb);
      acc.loud += m.loudDb / seeds;
      acc.len += m.len40 / seeds;
    }
    out[s.label] = [+acc.peak.toFixed(1), +acc.peakMax.toFixed(1), +acc.loud.toFixed(1), +acc.len.toFixed(2)];
  }
  return out;
}

/**
 * Intended loudness (A-weighted max-100 ms, dB; what tools/audio-calibrate.mjs measures through the settled
 * limiter) of every named sound and block sound — the calibration targets of src/game/audio.js.
 */
export const TARGETS = {
  click: -29.9, pop: -32.5, hurt: -22.5, death: -22.2, splash: -23.3, swim: -29.8, explode: -22.6,
  fuse: -26.2, eat: -30.1, burp: -26.5, break_tool: -24.3, pig: -29.3, cow: -25, sheep: -26.2,
  chicken: -28.3, zombie: -25.4, zombie_hurt: -24.5, creeper_hiss: -27.4, ignite: -30, fizz: -28.7,
  skeleton: -26.5, skeleton_hurt: -24.6, skeleton_death: -24, skeleton_step: -40, spider: -26.5,
  spider_hurt: -24.5, spider_death: -24.1, spider_step: -42, creeper_hurt: -25.1, creeper_death: -24,
  zombie_death: -23.5, zombie_step: -39, pig_hurt: -25.6, cow_hurt: -24.7, sheep_hurt: -26,
  chicken_hurt: -27.1, mob_death: -31, attack_swish: -33, attack_hit: -27.4, attack_crit: -25.6,
  bow_shoot: -26.6, arrow_hit: -28.2, arrow_hit_player: -28.9, hoe_till: -28, chest_open: -28.5,
  chest_close: -28, fire_crackle: -32, fall_small: -27.1, fall_big: -24.9, lava_pop: -31.1, water_flow: -34, lava_ambient: -31,
  'break:stone': -27.5, 'place:stone': -28.1, 'step:stone': -39.4, 'hit:stone': -36.9, 'land:stone': -33.5,
  'break:wood': -28.4, 'place:wood': -29.3, 'step:wood': -40.4, 'hit:wood': -37.5, 'land:wood': -34,
  'break:gravel': -27.9, 'place:gravel': -28.8, 'step:gravel': -40.1, 'hit:gravel': -36.6,
  'land:gravel': -33.2, 'break:grass': -27.9, 'place:grass': -28.8, 'step:grass': -40.1, 'hit:grass': -37.1,
  'land:grass': -34.3, 'break:sand': -29, 'place:sand': -30, 'step:sand': -41.2, 'hit:sand': -38.1,
  'land:sand': -35.5, 'break:glass': -26.2, 'place:glass': -28, 'step:glass': -39.6, 'hit:glass': -37.2,
  'land:glass': -33.8, 'break:wool': -30.2, 'place:wool': -31, 'step:wool': -41.5, 'hit:wool': -37.5,
  'land:wool': -35.5, 'break:snow': -29.1, 'place:snow': -30.2, 'step:snow': -42, 'hit:snow': -39.1,
  'land:snow': -34.9, 'break:metal': -27.3, 'place:metal': -29.4, 'step:metal': -40.2, 'hit:metal': -36.9,
  'land:metal': -34.2, 'break:water': -27.2, 'place:water': -29.8, 'step:water': -41.3, 'hit:water': -38.1,
  'land:water': -35.1,
};

/**
 * Compare every sound with its TARGETS entry (rendered like the game hears it: after the limiter has
 * settled). Resolves to { ok, worst, maxPeakDb, failures: [label, loudDb, targetDb, peakDb][] };
 * a sound fails when its loudness is off by more than `tolerance` dB or it peaks at or above 0 dBFS.
 *   node tools/harness.mjs --url tools/audio-test.html --eval "import('/tools/audio-calibrate.mjs').then(m => m.check())"
 */
export async function check({ seeds = 3, tolerance = 1.5, only = null } = {}) {
  const r = await run({ seeds, only });
  const failures = [];
  let worst = 0;
  let maxPeakDb = -Infinity;
  for (const [label, [, peakMax, loud]] of Object.entries(r)) {
    const target = TARGETS[label];
    maxPeakDb = Math.max(maxPeakDb, peakMax);
    const dev = target === undefined ? 0 : Math.abs(loud - target);
    worst = Math.max(worst, dev);
    if (target === undefined || dev > tolerance || peakMax >= 0) failures.push([label, loud, target ?? null, peakMax]);
  }
  return { ok: failures.length === 0, worst: +worst.toFixed(2), maxPeakDb: +maxPeakDb.toFixed(1), failures };
}

/** Music loudness: 90th percentile of 400 ms A-weighted RMS windows (dB). */
export function musicLoudness(buffer) {
  const sr = buffer.sampleRate;
  if (!weights || weights.sr !== sr) measure(buffer);
  const n = buffer.length;
  const x = new Float32Array(n);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) x[i] += d[i] / buffer.numberOfChannels;
  }
  const win = Math.round(0.17 * sr), hop = Math.round(0.4 * sr);
  const re = new Float64Array(NFFT), im = new Float64Array(NFFT);
  const vals = [];
  for (let s0 = 0; s0 + win < n; s0 += hop) {
    re.fill(0); im.fill(0);
    for (let i = 0; i < win; i++) re[i] = x[s0 + i];
    fft(re, im);
    let e = 0;
    for (let k = 0; k <= NFFT / 2; k++) e += (re[k] * re[k] + im[k] * im[k]) * weights[k] * (k === 0 || k === NFFT / 2 ? 1 : 2);
    vals.push(10 * Math.log10(e / (NFFT * win) + 1e-24));
  }
  vals.sort((a, b) => a - b);
  return vals[Math.floor(vals.length * 0.9)];
}

/** Loudness of the first `seconds` of pieces (several per style) + the composer energy estimate. */
export async function musicSurvey({ perStyle = 3, seconds = 30, maxSeed = 80 } = {}) {
  const { renderMusicOffline, composePiece } = await import('../src/game/audio.js');
  const count = {};
  const rows = [];
  for (let seed = 1; seed <= maxSeed; seed++) {
    const p = composePiece(seed);
    if ((count[p.style] ?? 0) >= perStyle) continue;
    count[p.style] = (count[p.style] ?? 0) + 1;
    const { buffer } = await renderMusicOffline({ seed, seconds });
    let e = 0;
    for (const ev of p.events) {
      if (ev.t > seconds) break;
      if (ev.inst !== 'piano') continue;
      const g = 0.06 + 0.94 * Math.pow(ev.vel, 1.6);
      e += g * g * Math.min(ev.dur, 3);
    }
    const loud = musicLoudness(buffer);
    rows.push({ seed, style: p.style, bpm: p.bpm, pad: p.pad, energyDb: +(10 * Math.log10(e)).toFixed(1), loud: +loud.toFixed(1), diff: +(loud - 10 * Math.log10(e)).toFixed(1) });
  }
  return rows;
}
