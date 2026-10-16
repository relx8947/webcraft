#!/usr/bin/env node
// Save-robustness regression checks with REAL tab closes / reloads / two tabs in one headless Edge
// profile (tools/harness.mjs drives a single page and its Browser.close skips beforeunload, so it cannot
// test these). Zero dependencies, Node >= 22. Exit code 1 if a check fails or the page logged errors.
//
//   node tools/save-robustness.mjs [scenario ...]        (default: all)
//
// Scenarios (docs/notes/review-wave1.json CODE-2 / CODE-3 / PLAYER-4 / WORLD-1 / WORLD-7):
//   close       edit 12 blocks + inventory + position, close the tab -> everything persisted
//   close-many  same with 169 modified chunks (one atomic snapshot transaction on pagehide)
//   reload      same, Page.reload instead of closing
//   ui-close    a world created through the game API without autostart (no automation mode): closing the
//               tab shows the beforeunload confirmation (defuses Ctrl+W while sprinting); accept -> persisted
//   ui-pause    open the pause menu (which saves) -> closing needs no confirmation, everything persisted
//   locks       world open in tab A -> tab B can neither open nor delete it; A saves & quits -> B opens it
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ALL = ['close', 'close-many', 'reload', 'ui-close', 'ui-pause', 'locks'];
const scenarios = process.argv.length > 2 ? process.argv.slice(2) : ALL;

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject, method } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const fn of this.listeners.get(msg.method) ?? []) fn(msg.params, msg.sessionId);
      }
    });
  }
  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener('open', () => resolve(new CDP(ws)), { once: true });
      ws.addEventListener('error', () => reject(new Error('CDP websocket error')), { once: true });
    });
  }
  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });
  }
  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }
}

function findBrowser() {
  const candidates = [
    process.env.BROWSER_PATH,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium',
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error('No Chromium-based browser found (set BROWSER_PATH).');
}

/** One browser profile per scenario (IndexedDB starts empty). */
async function withBrowser(fn) {
  const server = await startServer({ port: 0, root: ROOT });
  const base = `http://127.0.0.1:${server.address().port}`;
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webcraft-save-'));
  const browser = spawn(findBrowser(), [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${userDataDir}`, '--no-first-run',
    '--no-default-browser-check', '--disable-extensions', '--disable-sync', '--use-angle=d3d11',
    '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding', '--autoplay-policy=no-user-gesture-required', '--window-size=1280,720',
    'about:blank',
  ], { stdio: 'ignore' });
  let cdp = null;
  try {
    let port = null, wsPath = null;
    for (let i = 0; i < 150 && !port; i++) {
      await sleep(100);
      const f = path.join(userDataDir, 'DevToolsActivePort');
      if (fs.existsSync(f)) {
        const l = fs.readFileSync(f, 'utf8').split(/\r?\n/);
        if (l[0]) { port = Number(l[0]); wsPath = l[1]; }
      }
    }
    if (!port) throw new Error('browser did not start');
    cdp = await CDP.connect(`ws://127.0.0.1:${port}${wsPath}`);
    const ctx = { cdp, base, errors: [], dialogs: [] };
    cdp.on('Page.javascriptDialogOpening', (p) => ctx.dialogs.push(p.type));
    cdp.on('Runtime.exceptionThrown', (p) => ctx.errors.push(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text));
    cdp.on('Runtime.consoleAPICalled', (p) => {
      if (p.type === 'error') ctx.errors.push(p.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
    });
    return await fn(ctx);
  } finally {
    try { await cdp?.send('Browser.close'); } catch { /* ignore */ }
    try { browser.kill(); } catch { /* ignore */ }
    server.close();
    await sleep(500);
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

async function openPage({ cdp }, url) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false }, sessionId);
  await cdp.send('Page.navigate', { url }, sessionId);
  return sessionId;
}

async function evaluate({ cdp }, sessionId, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }, sessionId);
  if (r.exceptionDetails) throw new Error('eval failed: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
  return r.result.value;
}

async function waitFor(ctx, sessionId, expr, timeout = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      if (await evaluate(ctx, sessionId, `!!(${expr})`)) return;
    } catch { /* navigating */ }
    await sleep(200);
  }
  throw new Error('timeout waiting for ' + expr);
}

/** Start a persistent world: autostart (automation mode) or through the game API like the UI does. */
async function startWorld(ctx, viaUi, rd = 4) {
  const sid = await openPage(ctx, viaUi ? `${ctx.base}/index.html?nomusic=1`
    : `${ctx.base}/index.html?autostart=1&save=1&seed=1&type=flat&mode=survival&nomusic=1&rd=${rd}`);
  if (viaUi) {
    await waitFor(ctx, sid, 'window.__game && window.__game.ui && window.__game.storage');
    await evaluate(ctx, sid, `(async () => { const g = __game; const m = await g.createWorld({ name: 'save test', seedText: '1', mode: 'survival', worldType: 'flat' }); await g.ui.startWorld(m); return g.state; })()`);
  }
  await waitFor(ctx, sid, 'window.__ready');
  await sleep(2000);   // the initial save of the new world
  // a real click: sticky user activation, which browsers require before showing beforeunload dialogs
  await ctx.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 640, y: 360, button: 'left', clickCount: 1 }, sid);
  await ctx.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 640, y: 360, button: 'left', clickCount: 1 }, sid);
  return { sid, worldId: await evaluate(ctx, sid, '__game.worldMeta.id') };
}

/** Edits "since the last autosave": 12 gold blocks, `wide` chunks with one gold block each, 9 diamonds, a new position. */
function edit(ctx, sid, wide) {
  return evaluate(ctx, sid, `(() => {
    const d = __game.debug;
    for (let x = 2; x < 14; x++) d.setBlock(x, 10, 5, 'gold_block');
    let n = 0;
    for (let cx = -${wide}; cx <= ${wide}; cx++) for (let cz = -${wide}; cz <= ${wide}; cz++) if (d.setBlock(cx * 16 + 8, 12, cz * 16 + 8, 'gold_block')) n++;
    d.give('diamond', 9);
    d.tp(7.5, 11, 5.5);
    return { chunks: n, modified: __game.world.stats().modified, unsaved: __game.hasUnsavedProgress() };
  })()`);
}

/** Read the stored world from a fresh tab. */
async function persisted(ctx, worldId, wide) {
  const sid = await openPage(ctx, `${ctx.base}/index.html?nomusic=1`);
  await waitFor(ctx, sid, 'document.readyState === "complete"');
  await sleep(800);
  return evaluate(ctx, sid, `(async () => {
    const { Storage } = await import('/src/world/storage.js');
    const { BLOCK } = await import('/src/world/registry.js');
    const s = await Storage.open();
    const id = ${JSON.stringify(worldId)};
    const meta = await s.loadWorldMeta(id);
    const idx = (x, y, z) => (y << 8) | (z << 4) | x;
    const c00 = await s.loadChunk(id, 0, 0);
    let row = 0;
    if (c00) for (let x = 2; x < 14; x++) if (c00[idx(x, 10, 5)] === BLOCK.GOLD_BLOCK) row++;
    let wide = 0;
    for (let cx = -${wide}; cx <= ${wide}; cx++) for (let cz = -${wide}; cz <= ${wide}; cz++) {
      const b = await s.loadChunk(id, cx, cz);
      if (b && b[idx(8, 12, 8)] === BLOCK.GOLD_BLOCK) wide++;
    }
    const inv = meta?.player?.inventory?.filter(Boolean) ?? [];
    return { row, wide, diamonds: inv.filter((s) => s[0] === 261).reduce((n, s) => n + s[1], 0),
      pos: meta?.player ? [meta.player.x, meta.player.y, meta.player.z] : null };
  })()`);
}

/** Close (or reload) the tab like a user; accept a beforeunload dialog if one appears. */
async function leave(ctx, sid, how) {
  ctx.dialogs.length = 0;
  const p = how === 'reload' ? ctx.cdp.send('Page.reload', {}, sid) : ctx.cdp.send('Page.close', {}, sid);
  p.catch(() => {});
  await sleep(1500);
  const dialogs = ctx.dialogs.slice();
  if (dialogs.length) await ctx.cdp.send('Page.handleJavaScriptDialog', { accept: true }, sid).catch(() => {});
  await sleep(1500);
  return dialogs;
}

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? ' ' + JSON.stringify(detail) : ''}`);
}

async function runScenario(name) {
  await withBrowser(async (ctx) => {
    if (name === 'locks') {
      const a = await startWorld(ctx, false);
      const b = await openPage(ctx, `${ctx.base}/index.html?nomusic=1`);
      await waitFor(ctx, b, 'window.__game && window.__game.ui && window.__game.storage');
      const openB = `(async () => { const g = __game; const w = (await g.listWorlds()).find((m) => m.id === ${JSON.stringify(a.worldId)}); await g.ui.startWorld(w); return { state: g.state, world: !!g.world }; })()`;
      const r1 = await evaluate(ctx, b, openB);
      check('locks: a second tab cannot open the world', r1.state === 'title' && !r1.world, r1);
      const del = await evaluate(ctx, b, `(async () => { try { await __game.deleteWorld(${JSON.stringify(a.worldId)}); return 'deleted'; } catch (e) { return 'refused'; } })()`);
      check('locks: ... nor delete it', del === 'refused', del);
      await evaluate(ctx, a.sid, '(async () => { await __game.ui.saveAndQuit(); return __game.state; })()');
      const r2 = await evaluate(ctx, b, openB);
      check('locks: after save & quit in tab A, tab B opens it', r2.state === 'playing' && r2.world, r2);
    } else {
      const viaUi = name.startsWith('ui-');
      const wide = name === 'close-many' ? 6 : 0;
      const { sid, worldId } = await startWorld(ctx, viaUi, wide ? 8 : 4);
      const e = await edit(ctx, sid, wide);
      if (name === 'ui-pause') {
        const st = await evaluate(ctx, sid, `(async () => { __game.ui.openPause(); await new Promise((r) => setTimeout(r, 1500)); return { paused: __game.paused, unsaved: __game.hasUnsavedProgress() }; })()`);
        check('ui-pause: opening the pause menu saves', st.paused && !st.unsaved, st);
      }
      const dialogs = await leave(ctx, sid, name === 'reload' ? 'reload' : 'close');
      if (name === 'ui-close') check('ui-close: closing asks for confirmation (beforeunload)', dialogs.includes('beforeunload'), dialogs);
      if (name === 'ui-pause') check('ui-pause: nothing unsaved, no confirmation', dialogs.length === 0, dialogs);
      const p = await persisted(ctx, worldId, wide);
      const total = (2 * wide + 1) ** 2;
      check(`${name}: blocks, inventory and position persisted`,
        p.row === 12 && p.wide === total && p.diamonds === 9 && p.pos && p.pos[0] === 7.5 && p.pos[2] === 5.5,
        { edits: e, stored: p });
    }
    if (ctx.errors.length) check(`${name}: no page errors`, false, ctx.errors.slice(0, 3));
  });
}

for (const s of scenarios) {
  if (!ALL.includes(s)) {
    console.error(`unknown scenario ${s} (${ALL.join(', ')})`);
    process.exit(2);
  }
  try {
    await runScenario(s);
  } catch (err) {
    check(`${s}: ran`, false, String(err?.message ?? err));
  }
}
const failed = checks.filter((c) => !c.ok).length;
console.log(failed ? `${failed} check(s) failed` : `all ${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
