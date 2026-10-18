// Bootstrap (docs/SPEC.md §9.10): settings → textures → Renderer (+ EntityRenderer) → IconFactory →
// Storage / WorkerPool / AudioEngine / Input → Game → UIManager → title screen (or an automatic world
// for tests, see the URL parameters below) → frame loop.
//
// URL parameters (automation / debugging):
//   autostart=1   create a new temporary world and enter it immediately (not saved unless save=1)
//   seed=<text>   world seed (number or text)          mode=survival|creative     type=default|flat
//   rd=<n>        render distance for this session      time=<ticks>|noon|night|… (applied on entering)
//   nomusic=1     no background music                   save=1   persist the autostart world
//   automation=1  mouse / keyboard work without pointer lock (implied by autostart=1)
//   mp=1&name=<n> join the multiplayer server right away (tests; implies automation)
// window.__game = the Game; window.__ready = true once the spawn area is meshed and a frame rendered.

import { Game, loadSettings, parseTimeParam, sanitizeSettings } from './game.js';
import { Renderer } from './render/renderer.js';
import { EntityRenderer } from './render/entityrenderer.js';
import {
  generateTextures, generateMiscTextures, buildMipChain, getLayerAlphaModes, IconFactory,
} from './render/textures.js';
import { Storage } from './world/storage.js';
import { WorkerPool } from './world/workerpool.js';
import { AudioEngine } from './game/audio.js';
import { Input } from './game/input.js';
import { UIManager } from './ui/ui.js';

const params = new URLSearchParams(location.search);
const flag = (name) => params.get(name) === '1' || params.get(name) === 'true';

globalThis.__ready = false;

/** Full-screen error message (used when WebGL2 or a module fails before the UI exists). */
function showFatal(title, detail) {
  const root = document.getElementById('ui-root') ?? document.body;
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;' +
    'justify-content:center;gap:12px;background:#1d1510;color:#fff;font:16px "Microsoft YaHei",sans-serif;' +
    'text-align:center;padding:24px;z-index:100';
  const h = document.createElement('div');
  h.style.cssText = 'font-size:22px;color:#ff5555';
  h.textContent = title;
  const p = document.createElement('div');
  p.style.cssText = 'color:#bbb;max-width:720px;white-space:pre-wrap';
  p.textContent = detail;
  box.append(h, p);
  root.appendChild(box);
}

async function main() {
  const canvas = document.getElementById('game-canvas');
  const automation = flag('autostart') || flag('automation') || !!params.get('mp');

  // ---- settings (URL overrides are session-only)
  const settings = loadSettings();
  const sessionOverrides = {};
  if (params.has('rd')) {
    const rd = sanitizeSettings({ renderDistance: params.get('rd') });
    if ('renderDistance' in rd) {
      sessionOverrides.renderDistance = settings.renderDistance;   // keep the stored value on disk
      settings.renderDistance = rd.renderDistance;
    }
  }

  // ---- textures + renderer
  const textures = generateTextures();
  const misc = generateMiscTextures();
  let renderer;
  try {
    renderer = new Renderer(canvas, {
      textures, misc, EntityRendererClass: EntityRenderer, buildMipChain, alphaModes: getLayerAlphaModes(),
    });
  } catch (err) {
    console.error('[main] renderer initialisation failed:', err);
    showFatal('无法启动 WebCraft', '你的浏览器或显卡不支持 WebGL2，或者它被禁用了。\n' +
      '请使用最新版的 Chrome / Edge / Firefox，并确认已开启硬件加速。\n\n' + String(err?.message ?? err));
    return;
  }
  const fit = () => renderer.resize(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1);
  fit();
  window.addEventListener('resize', fit);

  // ---- services
  const icons = new IconFactory(textures);
  // Storage.open() falls back to memory itself; this also covers browsers where merely touching
  // window.indexedDB throws (blocked site data), which would otherwise break every world operation.
  // game.storage.persistent === false then, and entering a world shows a warning in chat.
  const storage = Storage.open().catch((err) => {
    console.warn('[main] IndexedDB unavailable, worlds will not be saved in this session:', err);
    return Storage.memory();
  });
  const pool = new WorkerPool();
  const audio = new AudioEngine(settings);
  const input = new Input(canvas, settings);
  input.enabled = false;                  // title screen: no game input until a world is entered
  input.allowUnlocked = automation;

  const game = new Game({
    canvas, renderer, input, audio, storage, pool, icons, textures, settings,
    options: { automation, music: !flag('nomusic'), sessionOverrides },
  });
  renderer.onContextRestored = () => game.world?.remeshAll();
  globalThis.__game = game;

  const ui = new UIManager(game, document.getElementById('ui-root'), { automation });
  game.ui = ui;
  game.start();

  if (flag('autostart')) {
    const time = parseTimeParam(params.get('time'));
    if (Number.isFinite(time)) {
      game.on('worldLoaded', function applyTime() {
        game.off('worldLoaded', applyTime);
        game.setTime(time);
      });
    }
    try {
      const meta = await game.createWorld({
        name: '自动测试世界',
        seedText: params.get('seed') ?? '',
        mode: params.get('mode') === 'creative' ? 'creative' : 'survival',
        worldType: params.get('type') === 'flat' ? 'flat' : 'default',
        temporary: !flag('save'),
      });
      await ui.startWorld(meta);
    } catch (err) {
      console.error('[main] autostart failed:', err);
      ui.showTitle();
    }
  } else if (params.get('mp')) {
    // Automation: join the multiplayer server right away as `name`.
    ui.showTitle();
    ui.startMultiplayer(params.get('name') || 'Tester');
  } else {
    ui.showTitle();
  }
}

main().catch((err) => {
  console.error('[main] startup failed:', err);
  showFatal('WebCraft 启动失败', String(err?.stack ?? err));
});
