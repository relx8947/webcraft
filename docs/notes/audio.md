# Audio agent notes — src/game/audio.js

Files: `src/game/audio.js` (the whole engine), `tests/audio.test.js` (18 Node tests with a strict mock
AudioContext), `tools/audio-test.html` + `tools/audio-test.mjs` (buttons for every sound and the music,
positional map, headless self-check), `tools/audio-calibrate.mjs` (loudness calibration helper).

Everything is synthesized with WebAudio at runtime — no audio files, no dependencies.

## Integration (src/main.js / src/game.js)

```js
import { AudioEngine } from './game/audio.js';
const audio = new AudioEngine(settings);              // reads settings.soundVolume / musicVolume
game.audio = audio;
if (!params.has('nomusic')) audio.startMusic();       // once at startup; keep it running (title + game)
game.on('settingsChanged', () => audio.setVolumes(game.settings.soundVolume, game.settings.musicVolume));
// every frame (title screen too — update() schedules the music):
if (game.player) {
  const cam = player.getCameraState();                 // eye position + yaw (SPEC §4)
  audio.setListener(cam.x, cam.y, cam.z, cam.yaw);
  audio.setUnderwater(player.eyeInWater);              // optional: muffles sound effects under water
}
audio.update(dt);
```

* **Unlocking**: the UI already calls `audio.unlock()` on the first `pointerdown`. The engine also arms its own
  capture-phase gesture listeners (`pointerdown/pointerup/mousedown/keydown/touchend`) and removes them once
  the context runs, so keyboard-only starts work too. No AudioContext is created before a user gesture
  (`navigator.userActivation.hasBeenActive`), so the console never shows Chrome's autoplay warning.
  `play()` before unlock returns `null`; `startMusic()` before unlock is remembered.
* The tab being hidden suspends the AudioContext (music pauses exactly where it was) and visible resumes it
  (`options.suspendWhenHidden`, default on).
* Automation (`autostart=1` harness runs): nothing to do — without a gesture the engine stays silent and
  costs nothing. To exercise it from the harness, `--eval "window.__game.audio.unlock()"` works because the
  harness evaluates with `userGesture: true`.

## Public API (SPEC §9.9) and additions

| call | notes |
|---|---|
| `new AudioEngine(settings, options?)` | options: `maxVoices` (24), `autoUnlock` (true), `suspendWhenHidden` (true), `AudioContextClass` (tests), `seed`, `force` |
| `unlock()` | create / resume the context; returns false when unavailable or no gesture yet |
| `setVolumes(sound, music)` | 0..1, smoothed; **no arguments = re-read the settings object** |
| `setListener(x, y, z, yaw)` | camera eye + yaw; also re-pans long sounds (fuse, explosion tail) |
| `playBlock(kind, material, x, y, z, opts?)` | kinds `break place step hit land`; all 10 `block.sound` materials; unknown material → stone, unknown kind → null |
| `play(name, { x, y, z, volume, pitch })` | omit x/y/z for UI sounds; `volume > 1` extends the audible range like Minecraft (gain capped at 1) |
| `startMusic(opts?)` / `stopMusic(opts?)` / `update(dt)` | `opts.delay` (first piece, default 3–9 s), `opts.fade` (default 2.5 s) |
| extra: `setUnderwater(bool)` | lowpass on the sound-effect bus (650 Hz) |
| extra: `playMusicNow(seed?)`, `musicStatus` | test page / debug (`{ state, piece, position, nextIn }`) |
| extra: `unlocked`, `available`, `destroy()` | |

`play()` / `playBlock()` return a **voice handle** (or `null`): `stop(fade = 0.05)`, `setPosition(x, y, z)`
(follow a moving source, e.g. a primed TNT entity or a hissing creeper), `playing`.

Named sounds (`SOUND_NAMES`): the spec list `click pop hurt death splash swim explode fuse eat burp break_tool
pig cow sheep chicken zombie zombie_hurt creeper_hiss` plus extras **`ignite`** (flint and steel) and **`fizz`**
(water meets lava / fire extinguished). Every name/material used by `player.js`, `interaction.js` and
`ui/*.js` exists with a matching signature (verified by grep: `land/step` from player, `hit/break/place` from
interaction incl. `water` for bucket scoop/pour, `hurt death splash swim break_tool click`).

Hints for later waves: item pickup `play('pop', { x, y, z })` (variation built in — do not pass Minecraft's
pitch 2); TNT `play('fuse', pos)` → handle, then `play('explode', pos)` (64-block range built in); eating
`play('eat', pos)` every 4 ticks + `play('burp', pos)`; mob hurt: `play('pig', { ...pos, pitch: 1.3 })` style
(or `zombie_hurt`); creeper `creeper_hiss` then `explode`.

## Design

* **Context-agnostic core.** `SoundCore` (mixer, voices, positional audio, music scheduler) and all recipes
  work on any `BaseAudioContext`. `AudioEngine` only adds lazy creation, gestures and fault tolerance. The
  self-check renders through the identical graph into `OfflineAudioContext`s (`renderSoundOffline`,
  `renderMusicOffline`).
* **Mixer**: voice → fader (stealing) → amp (volume × distance) → lowpass → StereoPanner → sfx bus;
  amp → reverb send (short 1.3 s generated room IR, `ConvolverNode`) whose level falls off slower than the
  dry signal (distant sounds are relatively wetter); sfx bus → underwater lowpass → sound volume → master;
  music → per-piece gain → music bus (long 3.6 s hall IR send) → music volume → master → soft limiter
  (`DynamicsCompressor`, −6 dB threshold, only catches explosion peaks) → destination.
* **Building blocks**: cached white/pink/brown noise buffers (3 s, seamless loop, random start offset per
  use), AR envelopes, filter sweeps, oscillator glides, formant voices (sawtooth sources through parallel
  bandpass formants with vibrato / AM growl / breath noise), **grain clouds** (dozens of crunchy grains with
  one noise source + one filter + one `setValueCurveAtTime` gain curve → 3–5 nodes regardless of grain count),
  bubbles (rising sines), inharmonic metal partials, wooden knock modes.
* **Voices**: max 24 (the oldest is faded out in 25 ms and its sources stopped), at most 3 identical sounds
  per 35 ms (a `/fill` or chain reaction cannot flood the graph), finished voices are disconnected in
  `update()`. Random pitch per play (triangular ±vary, like Minecraft's `(r − r)·k`) and ±10 % level; every recipe also
  randomizes its internals (grain timing, mode frequencies, bubble counts), so repeats never sound identical.
* **Block sounds** follow Minecraft's `SoundType`: one *dig* recipe per material (break and place, pitch 0.8)
  and one *step* recipe (step pitch 1, hit = pitch 0.5, land = pitch 0.75 + a low body thud). Pitch scales
  frequencies up and durations down together (like resampling a recording). Glass breaks with a shatter
  (crack + shimmer + ~12 sine pings + tinkle grains) but places/steps like stone with a faint ping (as in
  Minecraft); water = bucket fill "gloop" (break), pour (place), splashy steps.
* **Positional audio**: Minecraft/OpenAL linear clamped falloff `gain = 1 − d / range` (range 16 blocks,
  64 for explosions, × volume when volume > 1), equal-power pan from the lateral offset relative to the
  listener yaw (`right = (cos yaw, 0, −sin yaw)`, centred within 1.5 blocks), slight lowpass for sources
  behind and far away. Sounds are skipped entirely when inaudible. Until `setListener()` has been called
  sounds play centred (a forgotten call never makes the game silent).
* **Loudness calibration**: `tools/audio-calibrate.mjs` measures the max 100 ms A-weighted RMS of every sound
  (5 random variations). Targets: break −28, place −29, step −40, hit −37, land −34 LA (soft materials 1–2 dB
  lower, glass shatter −25, metal −27); hurt/death −22, explosion −21 (peak ≈ −2 dBFS), splash −24, mobs
  −24…−28, UI click −30. The trims live in `BLOCK_TRIM_DB` and `SOUNDS[name].gain` — **re-run the tool after
  editing a recipe**.

## Music

* `composePiece(seed)` (pure, deterministic): mode (major / lydian / aeolian / dorian / mixolydian), key,
  58–80 bpm, 4/4 or 3/4, a curated diatonic progression (only chords with perfect fifths, no dominant 7ths or
  ♭9s — maj7/add9 colours), style `arp` (Wet-Hands-like broken chords 1-5-8-9-10), `block` (rolled maj7/add9
  voicings), `pulse`, `sparse`, `waltz`; form intro (accompaniment only) → A (motif) → B (new motif, higher,
  thinner texture) → A → rolled final chord with ritardando. Melodies repeat/mutate a 2-bar motif, chord tones
  on strong beats, pentatonic tones on long notes, rests between phrases, phrase-arc dynamics, timing jitter,
  breathing rubato. 40 % of pieces add a very soft pad. Pieces last ~2–3 minutes; a partial loudness
  normalisation from the note energy keeps dense and sparse pieces at similar levels.
* **Piano**: additive synthesis (up to 20 stretched partials with string inharmonicity, hammer-position comb,
  per-partial decay, two detuned unison strings per partial = fast "prompt" + long "aftersound" decay with
  gentle beating, felt-hammer noise) rendered once per 3 semitones into 32 kHz buffers by an
  `OfflineAudioContext` (rendering runs off the main thread; ~25 ms per note) and replayed with
  `playbackRate`, velocity → level + lowpass brightness, damper at note-off, per-note stereo position.
  Samples are rendered lazily for the notes of the next piece (~0.3 s before the first piece). If
  `OfflineAudioContext` is unavailable, a live 4-partial fallback voice is used.
* **Scheduling**: one-second look-ahead (`update()` + a 250 ms interval fallback while music is wanted); after
  a hitch the piece slides instead of bursting or dropping notes; first piece 3–9 s after `startMusic()`, then
  1.5–4 minutes of silence between pieces; `stopMusic()` fades the piece out (default 2.5 s).
  Music volume 0 → notes are not even scheduled.

## Verification

* `node --test tests/audio.test.js` → 18 tests: noise colours/loop seam, impulse decay/decorrelation,
  spatialisation vs the SPEC yaw convention, composer validity (in key, sorted, ranges, density) over 60
  seeds, every sound and every kind×material building a valid graph that reaches the destination (strict mock
  enforcing WebAudio rules), voice stealing, spam guard, ranges, listener-following voices, volumes, the music
  cycle incl. hitch handling and the silence gap, AudioEngine lazy unlock / no-WebAudio / throwing context.
* `node tools/harness.mjs --url "tools/audio-test.html?selfcheck=1" --wait-for "window.__audioCheck" --wait-timeout 200000 --eval "JSON.stringify(window.__audioCheck.summary)"`
  → renders all 70 sounds + a 28 s music excerpt offline (peak / RMS / length / NaN checks, spectrograms) and
  exercises the live engine (all sounds, 80-sound burst → 24 voices, range checks, bad input, music start/stop):
  PASS, no page errors. Loudest sound: explosion ≈ −1.5 dBFS peak (the soft limiter catches overlaps);
  quietest: steps ≈ −23…−27 dBFS peak.
  Page modes: `&big=1&dry=1&only=stone,wood` (large dry spectrograms), `?piano=1` (piano timbre),
  `?roll=7,42` (piano rolls of generated pieces).
* Cost: `play()`/`playBlock()` ≈ 0.12 ms main-thread per call; a 28 s music excerpt renders offline in
  ~1.4 s including both reverbs (≈ 5 % of one core in real time).

## Known limitations

* Sounds are synthesized, not recordings: they are Minecraft-like in character (crunchy stone, hollow wood,
  crunchy gravel, shattering glass, "oof" hurt…) but not identical to Mojang's samples (which may not be used).
* No occlusion / cave reverb (Minecraft has none either); one global SFX reverb.
* Moving sources keep their start position unless the caller uses the handle's `setPosition()`.
* `BLOCK_TRIM_DB` / `SOUNDS[*].gain` are calibration data — re-run `tools/audio-calibrate.mjs` when a recipe
  changes.

## Wave 2 update (ART agent, see docs/notes/art-wave2.md)

* 32 new sounds (skeleton / spider / creeper / zombie death, passive-mob hurt, `mob_death`, combat, bow + arrows,
  hoe, chest, fire crackle, mob steps, falls, lava pop, water / lava ambience) and `SOUND_ALIASES` / `resolveSoundName()`; unknown names
  passed to `AudioEngine.play()` log one warning each.
* Review finding AUDIO-1 fixed: offline renders (calibration, self-check) now play after a silent pre-roll so the
  master limiter has settled (`RENDER_PREROLL`), a WaveShaper soft clipper after the limiter keeps the output below
  full scale, and every gain / trim was recalibrated to the targets above as heard in game.
  `tools/audio-calibrate.mjs` exports `TARGETS` and `check()`.
