// Audio test page: buttons for every sound and the music, a positional-audio map, and a headless
// self-check that renders every sound into an OfflineAudioContext (peak / RMS / length + spectrograms).
//   node tools/harness.mjs --url "tools/audio-test.html?selfcheck=1" --wait-for "window.__audioCheck" ...
//   (&loudness=1 also compares every sound with its loudness target; ~1 min longer)
import {
  AudioEngine, SOUND_NAMES, BLOCK_KINDS, BLOCK_MATERIALS, renderSoundOffline, renderMusicOffline,
  analyzeBuffer, composePiece, ensurePianoSamples, pieceMidis,
} from '../src/game/audio.js';

const params = new URLSearchParams(location.search);
const SELF = params.has('selfcheck');
const $ = (id) => document.getElementById(id);

const engine = new AudioEngine({ soundVolume: 0.8, musicVolume: 0.5 }, { force: SELF });
window.__audio = engine;

const LISTENER = { x: 0, y: 64, z: 0, yaw: 0 };

async function ready() {
  engine.unlock();
  const ctx = engine.ctx;
  if (ctx && ctx.state !== 'running') {
    try { await ctx.resume(); } catch { /* ignore */ }
  }
  return engine.unlocked;
}

function btn(parent, label, onClick, cls) {
  const b = document.createElement('button');
  b.textContent = label;
  if (cls) b.className = cls;
  b.addEventListener('click', onClick);
  parent.appendChild(b);
  return b;
}

// ------------------------------------------------------------------------------------------ controls
$('unlock').addEventListener('click', () => ready());
$('vol-sound').addEventListener('input', (e) => engine.setVolumes(Number(e.target.value), undefined));
$('vol-music').addEventListener('input', (e) => engine.setVolumes(undefined, Number(e.target.value)));
$('underwater').addEventListener('change', (e) => engine.setUnderwater(e.target.checked));
$('spam').addEventListener('click', async () => {
  await ready();
  for (let i = 0; i < 60; i++) {
    const mat = BLOCK_MATERIALS[i % BLOCK_MATERIALS.length];
    engine.playBlock(BLOCK_KINDS[i % BLOCK_KINDS.length], mat, LISTENER.x + (i % 7) - 3, 64, LISTENER.z - 2);
  }
});

for (const name of SOUND_NAMES) {
  btn($('named'), name, async () => {
    await ready();
    engine.play(name);
  });
}

{
  const table = $('blocks');
  const head = document.createElement('tr');
  head.appendChild(document.createElement('th'));
  for (const kind of BLOCK_KINDS) {
    const th = document.createElement('th');
    th.textContent = kind;
    head.appendChild(th);
  }
  table.appendChild(head);
  for (const mat of BLOCK_MATERIALS) {
    const tr = document.createElement('tr');
    const th = document.createElement('th');
    th.textContent = mat;
    th.style.textAlign = 'right';
    tr.appendChild(th);
    for (const kind of BLOCK_KINDS) {
      const td = document.createElement('td');
      btn(td, kind, async () => {
        await ready();
        engine.playBlock(kind, mat, LISTENER.x, LISTENER.y - 1, LISTENER.z);
      });
      tr.appendChild(td);
    }
    table.appendChild(tr);
  }
}

$('music-start').addEventListener('click', async () => {
  await ready();
  engine.startMusic();
});
$('music-now').addEventListener('click', async () => {
  await ready();
  const s = $('seed').value.trim();
  engine.playMusicNow(s === '' ? undefined : Number(s));
});
$('music-stop').addEventListener('click', () => engine.stopMusic());

// ------------------------------------------------------------------------------------ positional map
const posSel = $('pos-sound');
for (const n of SOUND_NAMES) posSel.add(new Option(n, n));
for (const m of BLOCK_MATERIALS) for (const k of BLOCK_KINDS) posSel.add(new Option(`${k}:${m}`, `${k}:${m}`));
posSel.value = 'pig';
const pos = $('pos');
const pctx = pos.getContext('2d');
const SCALE = 150 / 20; // px per block (20 blocks visible to each side)
const marks = [];

$('yaw').addEventListener('input', (e) => {
  LISTENER.yaw = (Number(e.target.value) * Math.PI) / 180;
  $('yaw-v').textContent = `${e.target.value}°`;
});

pos.addEventListener('click', async (e) => {
  await ready();
  const r = pos.getBoundingClientRect();
  const x = LISTENER.x + (e.clientX - r.left - 150) / SCALE;
  const z = LISTENER.z + (e.clientY - r.top - 150) / SCALE;
  const v = posSel.value;
  let voice;
  if (v.includes(':')) {
    const [kind, mat] = v.split(':');
    voice = engine.playBlock(kind, mat, x, LISTENER.y, z);
  } else {
    voice = engine.play(v, { x, y: LISTENER.y, z });
  }
  marks.push({ x, z, t: performance.now(), heard: !!voice, label: v });
  if (marks.length > 12) marks.shift();
});

function drawMap() {
  const c = pctx;
  c.fillStyle = '#121315';
  c.fillRect(0, 0, 300, 300);
  c.strokeStyle = '#1f2226';
  for (let i = -20; i <= 20; i += 4) {
    c.beginPath(); c.moveTo(150 + i * SCALE, 0); c.lineTo(150 + i * SCALE, 300); c.stroke();
    c.beginPath(); c.moveTo(0, 150 + i * SCALE); c.lineTo(300, 150 + i * SCALE); c.stroke();
  }
  c.strokeStyle = '#3b4b3a';
  for (const rad of [8, 16]) {
    c.beginPath(); c.arc(150, 150, rad * SCALE, 0, Math.PI * 2); c.stroke();
  }
  c.fillStyle = '#777';
  c.font = '11px Consolas, monospace';
  c.fillText('N (−Z)', 132, 12); c.fillText('S', 146, 296); c.fillText('E', 288, 154); c.fillText('W', 4, 154);
  // listener arrow: forward = (−sin yaw, −cos yaw) in (x, z)
  const fx = -Math.sin(LISTENER.yaw), fz = -Math.cos(LISTENER.yaw);
  c.strokeStyle = '#9fd37a'; c.fillStyle = '#9fd37a'; c.lineWidth = 2;
  c.beginPath(); c.moveTo(150, 150); c.lineTo(150 + fx * 22, 150 + fz * 22); c.stroke();
  c.beginPath(); c.arc(150, 150, 4, 0, Math.PI * 2); c.fill();
  c.lineWidth = 1;
  const now = performance.now();
  for (const m of marks) {
    const age = (now - m.t) / 4000;
    if (age > 1) continue;
    c.globalAlpha = 1 - age;
    c.fillStyle = m.heard ? '#f5c542' : '#c55';
    c.beginPath(); c.arc(150 + (m.x - LISTENER.x) * SCALE, 150 + (m.z - LISTENER.z) * SCALE, 4, 0, Math.PI * 2); c.fill();
    const text = m.heard ? m.label : m.label + ' (silent)';
    const px = 150 + (m.x - LISTENER.x) * SCALE;
    const tw = c.measureText(text).width;
    c.fillText(text, px + 6 + tw > 298 ? px - 6 - tw : px + 6, 146 + (m.z - LISTENER.z) * SCALE);
    c.globalAlpha = 1;
  }
}

// --------------------------------------------------------------------------------------- frame loop
let last = performance.now();
let statusTimer = 0;
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  engine.setListener(LISTENER.x, LISTENER.y, LISTENER.z, LISTENER.yaw);
  engine.update(dt);
  drawMap();
  statusTimer -= dt;
  if (statusTimer <= 0) {
    statusTimer = 0.25;
    const st = engine.musicStatus;
    const p = st.piece;
    const ctx = engine.ctx;
    $('status').textContent = [
      `context: ${ctx ? `${ctx.state} @ ${ctx.sampleRate} Hz` : 'not created (click to unlock)'}   voices: ${engine.core ? engine.core.voiceCount : 0}`,
      `music: ${st.state}${st.state === 'waiting' ? ` (next in ${st.nextIn.toFixed(1)} s)` : ''}${st.state === 'playing' ? ` ${st.position.toFixed(1)} / ${p.duration.toFixed(0)} s` : ''}`,
      p ? `piece #${p.seed}: ${p.key} ${p.mode}, ${p.bpm} bpm ${p.meter}/4, ${p.style}${p.pad ? ' + pad' : ''}, degrees [${p.progression}]` : '',
    ].join('\n');
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ------------------------------------------------------------------------------- analysis drawing
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

function mono(buffer) {
  const out = new Float32Array(buffer.length);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i++) out[i] += d[i] / buffer.numberOfChannels;
  }
  return out;
}

const MAGMA = [[0, 0, 4], [40, 11, 84], [101, 21, 110], [159, 42, 99], [212, 72, 66], [245, 125, 21], [250, 193, 39], [252, 255, 164]];
function colormap(v) {
  const x = Math.max(0, Math.min(1, v)) * (MAGMA.length - 1);
  const i = Math.min(MAGMA.length - 2, Math.floor(x));
  const f = x - i;
  const a = MAGMA[i], b = MAGMA[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

/** Log-frequency spectrogram (40 Hz .. 16 kHz, -90..0 dBFS). */
function drawSpectrogram(canvas, buffer, seconds) {
  const W = canvas.width, H = canvas.height;
  const c = canvas.getContext('2d');
  const img = c.createImageData(W, H);
  const data = mono(buffer);
  const sr = buffer.sampleRate;
  const N = seconds < 0.4 ? 256 : seconds < 1 ? 512 : 1024;
  const total = Math.min(data.length, Math.floor(seconds * sr));
  const re = new Float32Array(N), im = new Float32Array(N), win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
  const fmin = 40, fmax = 16000;
  const rowBins = [];
  for (let y = 0; y <= H; y++) rowBins.push((fmin * Math.pow(fmax / fmin, 1 - y / H) / sr) * N);
  for (let x = 0; x < W; x++) {
    const center = Math.floor(((x + 0.5) / W) * total);
    for (let i = 0; i < N; i++) {
      const idx = center - N / 2 + i;
      re[i] = (idx >= 0 && idx < data.length ? data[idx] : 0) * win[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let y = 0; y < H; y++) {
      const b0 = rowBins[y + 1], b1 = rowBins[y];
      let mag = 0;
      for (let b = Math.floor(b0); b <= Math.ceil(b1) && b < N / 2; b++) mag = Math.max(mag, Math.hypot(re[b], im[b]));
      const db = 20 * Math.log10(mag / (N / 4) + 1e-9);
      const [r, g, bl] = colormap((db + 90) / 90);
      const o = (y * W + x) * 4;
      img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = bl; img.data[o + 3] = 255;
    }
  }
  c.putImageData(img, 0, 0);
  // guide lines at 100 Hz, 1 kHz, 10 kHz
  c.fillStyle = 'rgba(255,255,255,0.18)';
  for (const f of [100, 1000, 10000]) c.fillRect(0, Math.round(H * (1 - Math.log(f / fmin) / Math.log(fmax / fmin))), W, 1);
}

/** Length until the signal stays below -40 dB of its peak. */
function audibleLength(buffer) {
  const d = mono(buffer);
  let peak = 0;
  for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
  let last = 0;
  for (let i = 0; i < d.length; i++) if (Math.abs(d[i]) > peak * 0.01) last = i;
  return last / buffer.sampleRate;
}

/** Min/max waveform with a -6 dBFS guide line. */
function drawWave(canvas, buffer, seconds) {
  const W = canvas.width, H = canvas.height;
  const c = canvas.getContext('2d');
  c.fillStyle = '#111'; c.fillRect(0, 0, W, H);
  c.strokeStyle = '#333';
  for (const lv of [0.5, -0.5]) {
    c.beginPath(); c.moveTo(0, H / 2 - lv * H / 2); c.lineTo(W, H / 2 - lv * H / 2); c.stroke();
  }
  const data = mono(buffer);
  const total = Math.min(data.length, Math.floor(seconds * buffer.sampleRate));
  c.fillStyle = '#7fc8ff';
  for (let x = 0; x < W; x++) {
    const a = Math.floor((x / W) * total), b = Math.floor(((x + 1) / W) * total);
    let lo = 0, hi = 0;
    for (let i = a; i < b; i++) { if (data[i] < lo) lo = data[i]; if (data[i] > hi) hi = data[i]; }
    const y0 = H / 2 - hi * H / 2, y1 = H / 2 - lo * H / 2;
    c.fillRect(x, y0, 1, Math.max(1, y1 - y0));
  }
}

function hasNaN(buffer) {
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const d = buffer.getChannelData(ch);
    for (let i = 0; i < d.length; i += 7) if (!Number.isFinite(d[i])) return true;
  }
  return false;
}

// -------------------------------------------------------------------------------------- self-check
const SECONDS = {
  explode: 4.2, fuse: 2.6, creeper_hiss: 2.4, death: 2.2, cow: 2.4, zombie: 2.4, splash: 2,
  sheep: 1.8, swim: 1.6, 'break:metal': 2, 'place:metal': 1.8, 'break:glass': 1.8,
};
const fmt = (v) => (Number.isFinite(v) ? v.toFixed(1) : '-inf');

const BIG = params.has('big');
function card(label, info, ok, buffer, seconds, wide) {
  if (!wide) seconds = Math.min(seconds, Math.max(0.2, audibleLength(buffer) * 1.25 + 0.05));
  const div = document.createElement('div');
  div.className = 'card' + (ok ? '' : ' bad');
  const t = document.createElement('div');
  t.className = 't';
  t.innerHTML = `<b>${label}</b><span>${info.right ?? ''}</span>`;
  div.appendChild(t);
  const spec = document.createElement('canvas');
  spec.width = wide ? 960 : BIG ? 464 : 224; spec.height = wide ? 150 : BIG ? 150 : 64;
  const wave = document.createElement('canvas');
  wave.width = spec.width; wave.height = wide ? 40 : BIG ? 40 : 22;
  div.appendChild(spec);
  div.appendChild(wave);
  const m = document.createElement('div');
  m.className = 'm';
  m.textContent = info.text;
  div.appendChild(m);
  drawSpectrogram(spec, buffer, seconds);
  drawWave(wave, buffer, seconds);
  return div;
}

async function realtimeCheck() {
  const out = { ok: true, notes: [] };
  const fail = (msg) => { out.ok = false; out.notes.push('FAIL ' + msg); };
  if (!(await ready())) {
    out.notes.push('realtime AudioContext not running (no audio device?) — skipped');
    return out;
  }
  const ctx = engine.ctx;
  out.sampleRate = ctx.sampleRate;
  out.baseLatency = ctx.baseLatency;
  engine.setListener(0, 64, 0, 0);
  // every sound through the live engine
  for (const n of SOUND_NAMES) if (!engine.play(n, { x: 1, y: 64, z: -2 })) fail('live play ' + n);
  // voice limiter: 80 more sounds in one burst
  const t0 = performance.now();
  let calls = 0;
  for (let i = 0; i < 80; i++) {
    const mat = BLOCK_MATERIALS[i % BLOCK_MATERIALS.length];
    engine.playBlock(BLOCK_KINDS[(i >> 1) % BLOCK_KINDS.length], mat, (i % 9) - 4, 63, -3);
    calls++;
  }
  out.playMs = (performance.now() - t0) / calls;
  const voices = engine.core.voiceCount;
  if (voices > 24) fail(`voice limit exceeded: ${voices}`);
  out.voicesAfterBurst = voices;
  // positional range: pig at 30 blocks is silent, an explosion (range 64) is not
  if (engine.play('pig', { x: 30, y: 64, z: 0 })) fail('pig audible at 30 blocks');
  if (!engine.play('explode', { x: 30, y: 64, z: 0, volume: 0.3 })) fail('explosion inaudible at 30 blocks');
  // unknown names / bad input never throw
  engine.play('nope');
  engine.playBlock('dance', 'stone', 0, 0, 0);
  engine.playBlock('step', 'unknown-material', NaN, 0, 0);
  engine.play('pop', { x: Infinity, volume: NaN, pitch: -3 });
  // music: a piece must start playing
  const m0 = performance.now();
  engine.playMusicNow(7);
  while (engine.musicStatus.state !== 'playing' && performance.now() - m0 < 15000) {
    await new Promise((r) => setTimeout(r, 100));
  }
  out.musicStartMs = performance.now() - m0;
  if (engine.musicStatus.state !== 'playing') fail('music did not start: ' + engine.musicStatus.state);
  await new Promise((r) => setTimeout(r, 1500));
  out.musicPosition = engine.musicStatus.position;
  if (!(out.musicPosition > 0.5)) fail('music clock not advancing');
  engine.stopMusic({ fade: 0.5 });
  if (engine.musicStatus.state !== 'off') fail('stopMusic did not stop');
  return out;
}

async function selfCheck() {
  const t0 = performance.now();
  $('summary').textContent = 'running…';
  const box = $('checks');
  box.innerHTML = '';
  const specs = [
    ...SOUND_NAMES.map((n) => ({ label: n, spec: n })),
    ...BLOCK_MATERIALS.flatMap((mat) => BLOCK_KINDS.map((kind) => ({ label: `${kind}:${mat}`, spec: { kind, material: mat } }))),
  ];
  const only = params.get('only');
  const results = [];
  for (const s of specs.filter((x) => !only || only.split(',').some((o) => x.label.includes(o)))) {
    const seconds = SECONDS[s.label] ?? 1.5;
    const r0 = performance.now();
    let res;
    try {
      const buf = await renderSoundOffline(s.spec, { seconds, seed: Number(params.get('sseed') ?? 7), reverb: !params.has('dry') });
      const a = analyzeBuffer(buf);
      const nan = hasNaN(buf);
      const ok = !nan && a.peak < 0.98 && a.peak > 0.01 && a.rms > 0.001 && a.length > 0.01;
      res = { label: s.label, peakDb: +a.peakDb.toFixed(1), rmsDb: +a.rmsDb.toFixed(1), length: +a.length.toFixed(3), ms: Math.round(performance.now() - r0), ok, nan };
      box.appendChild(card(s.label, {
        right: `${fmt(a.peakDb)} dB`,
        text: `rms ${fmt(a.rmsDb)} dB · ${a.length.toFixed(2)} s · ${res.ms} ms · view ${Math.min(seconds, Math.max(0.2, audibleLength(buf) * 1.25 + 0.05)).toFixed(2)} s`,
      }, ok, buf, seconds));
    } catch (err) {
      res = { label: s.label, ok: false, error: String(err && err.stack || err) };
      console.error('[selfcheck]', s.label, err);
    }
    results.push(res);
    console.log(`[selfcheck] ${res.label.padEnd(14)} ${res.ok ? 'ok ' : 'BAD'} peak ${fmt(res.peakDb)} dB  rms ${fmt(res.rmsDb)} dB  len ${res.length}s  ${res.ms}ms`);
  }

  // Music excerpt through the full chain (piano samples rendered first).
  const seed = Number(params.get('seed') ?? 7);
  const piece = composePiece(seed);
  const p0 = performance.now();
  await ensurePianoSamples(pieceMidis(piece));
  const pianoMs = Math.round(performance.now() - p0);
  const m0 = performance.now();
  const { buffer } = await renderMusicOffline({ seed, seconds: 28 });
  const musicMs = Math.round(performance.now() - m0);
  const ma = analyzeBuffer(buffer);
  const musicOk = !hasNaN(buffer) && ma.peak < 0.98 && ma.peak > 0.02;
  const music = {
    seed, mode: piece.mode, key: piece.keyName, bpm: piece.bpm, meter: piece.meter, style: piece.style,
    progression: piece.progression, pad: piece.pad, duration: +piece.duration.toFixed(1), notes: piece.events.length,
    peakDb: +ma.peakDb.toFixed(1), rmsDb: +ma.rmsDb.toFixed(1), pianoRenderMs: pianoMs, renderMs: musicMs, ok: musicOk,
  };
  const mc = card(`music #${seed}: ${piece.keyName} ${piece.mode}, ${piece.bpm} bpm, ${piece.style}${piece.pad ? ' + pad' : ''}`, {
    right: `${fmt(ma.peakDb)} dB`,
    text: `first 28 s · rms ${fmt(ma.rmsDb)} dB · piano samples ${pianoMs} ms · render ${musicMs} ms · ${piece.events.length} notes, ${piece.duration.toFixed(0)} s`,
  }, musicOk, buffer, 28, true);
  mc.id = 'music-card';
  mc.style.gridColumn = '1 / -1';
  box.prepend(mc);
  console.log('[selfcheck] music', JSON.stringify(music));

  const realtime = await realtimeCheck();
  console.log('[selfcheck] realtime', JSON.stringify(realtime));

  // &loudness=1: every sound vs its calibration target (as heard in game, dry), see tools/audio-calibrate.mjs.
  let loudness = null;
  if (params.has('loudness')) {
    const { check } = await import('./audio-calibrate.mjs');
    loudness = await check({ seeds: 3 });
    console.log('[selfcheck] loudness', JSON.stringify(loudness));
  }
  const bad = results.filter((r) => !r.ok);
  const ok = bad.length === 0 && musicOk && realtime.ok && (!loudness || loudness.ok);
  const summary = {
    ok, sounds: results.length, bad: bad.map((r) => r.label), music, realtime, loudness,
    loudest: results.filter((r) => r.ok).sort((a, b) => b.peakDb - a.peakDb).slice(0, 3).map((r) => `${r.label} ${r.peakDb}`),
    quietest: results.filter((r) => r.ok).sort((a, b) => a.peakDb - b.peakDb).slice(0, 3).map((r) => `${r.label} ${r.peakDb}`),
    totalMs: Math.round(performance.now() - t0),
  };
  const el = $('summary');
  el.className = ok ? 'ok' : 'bad';
  el.textContent = `${ok ? 'PASS' : 'FAIL'} — ${results.length} sounds, ${bad.length} bad${bad.length ? ': ' + summary.bad.join(', ') : ''}; ` +
    `music ${musicOk ? 'ok' : 'BAD'} (${music.peakDb} dB peak); realtime ${realtime.ok ? 'ok' : 'BAD'} ` +
    `(play() ${realtime.playMs?.toFixed(3) ?? '-'} ms/call, ${realtime.voicesAfterBurst ?? '-'} voices after burst, music start ${Math.round(realtime.musicStartMs ?? 0)} ms); ${summary.totalMs} ms total`;
  window.__audioCheck = { ok, summary, results };
  return window.__audioCheck;
}

/** ?piano=1: isolated piano notes (timbre check) — C2..C6 at two velocities. */
async function pianoCheck() {
  const notes = [36, 48, 60, 72, 84];
  const events = [];
  notes.forEach((midi, i) => {
    events.push({ t: i * 2.4, midi, vel: 0.35, dur: 1.6, inst: 'piano' });
    events.push({ t: i * 2.4 + 1.2, midi, vel: 0.8, dur: 3, inst: 'piano' });
  });
  const piece = { events, duration: 14, gain: 1, seed: 0 };
  const { buffer } = await renderMusicOffline({ piece, seconds: 13 });
  const a = analyzeBuffer(buffer);
  const box = $('checks');
  box.innerHTML = '';
  const c = card('piano notes C2 C3 C4 C5 C6 (soft, loud)', { right: `${fmt(a.peakDb)} dB`, text: 'timbre check' }, a.peak < 0.98, buffer, 13, true);
  c.style.gridColumn = '1 / -1';
  box.appendChild(c);
  const chord = { events: [48, 55, 64, 71, 74].map((midi, i) => ({ t: 0.1 + i * 0.12, midi, vel: 0.5, dur: 5, inst: 'piano' })), duration: 7, gain: 1 };
  const r2 = await renderMusicOffline({ piece: chord, seconds: 6 });
  const c2 = card('rolled Cmaj9 chord (C3 G3 E4 B4 D5)', { right: `${fmt(analyzeBuffer(r2.buffer).peakDb)} dB`, text: 'reverb tail + beating' }, true, r2.buffer, 6, true);
  c2.style.gridColumn = '1 / -1';
  box.appendChild(c2);
  window.__pianoCheck = { peakDb: a.peakDb };
}

/** ?roll=seed1,seed2: piano-roll view of generated pieces (structure / harmony check). */
function drawRolls(seeds) {
  const box = $('checks');
  box.innerHTML = '';
  const names = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
  for (const seed of seeds) {
    const p = composePiece(seed);
    const div = document.createElement('div');
    div.className = 'card';
    div.style.gridColumn = '1 / -1';
    const t = document.createElement('div');
    t.className = 't';
    t.innerHTML = `<b>#${seed}: ${p.keyName} ${p.mode}, ${p.bpm} bpm ${p.meter}/4, ${p.style}${p.pad ? ' + pad' : ''}, degrees [${p.progression}] x${p.barsPerChord} bar, ${p.cycles} cycles</b><span>${p.duration.toFixed(0)} s, ${p.events.length} notes, gain ${(20 * Math.log10(p.gain)).toFixed(1)} dB</span>`;
    div.appendChild(t);
    const cv = document.createElement('canvas');
    const W = 1220, H = 260;
    cv.width = W; cv.height = H;
    const c = cv.getContext('2d');
    c.fillStyle = '#111'; c.fillRect(0, 0, W, H);
    const lo = 30, hi = 92, secs = Math.min(p.duration, 100);
    const y = (midi) => H - ((midi - lo + 0.5) / (hi - lo + 1)) * H;
    for (let mm = lo; mm <= hi; mm++) {
      if (mm % 12 === p.key) { c.fillStyle = '#2a2d31'; c.fillRect(0, y(mm) - 2, W, 4); }
    }
    c.fillStyle = '#555'; c.font = '10px Consolas, monospace';
    for (let s = 0; s < secs; s += 10) c.fillText(s + 's', (s / secs) * W + 2, 10);
    for (const e of p.events) {
      if (e.t > secs) break;
      const x0 = (e.t / secs) * W, x1 = (Math.min(e.t + e.dur, secs) / secs) * W;
      const a = 0.25 + e.vel;
      c.fillStyle = e.inst === 'pad' ? `rgba(120,160,255,${0.25})` : e.midi >= 64 ? `rgba(255,200,80,${a})` : `rgba(120,220,140,${a * 0.8})`;
      c.fillRect(x0, y(e.midi) - 1.5, Math.max(2, x1 - x0), 3);
      c.fillStyle = '#fff';
      c.fillRect(x0, y(e.midi) - 1.5, 1.5, 3);
    }
    c.fillStyle = '#888';
    for (const mm of [36, 48, 60, 72, 84]) c.fillText(names[mm % 12] + (mm / 12 - 1), 2, y(mm) + 3);
    div.appendChild(cv);
    box.appendChild(div);
  }
  window.__rolls = true;
}

$('run-check').addEventListener('click', () => selfCheck());
if (params.has('piano')) pianoCheck();
if (params.has('roll')) drawRolls(params.get('roll').split(',').map(Number));
if (SELF) selfCheck();
