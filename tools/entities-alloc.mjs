#!/usr/bin/env node
// Per-frame allocation probe for the entity / particle / hand rendering path in the real browser (V8's sampling
// heap profiler over CDP, including objects that were already collected by minor / major GCs).
//
//   node tools/entities-alloc.mjs [--url <page>] [--frames 3000] [--warmup 6000] [--tiers]
//
// Runs window.__allocLoop(n) of tools/entity-test.html (particle spawns + update, EntityManager update +
// getRenderList, renderEntities / renderParticles / renderHand) and prints the bytes allocated per frame with
// the top allocation sites (attributed to the allocating function; inlined callees count for their caller).
// The default page is the game's case: only the EntityManager's render items (200 drops, TNT, falling sand,
// the third-person player model). --tiers prints the V8 tier (Ignition / Sparkplug / Maglev / TurboFan) of the
// hot functions. Exit code 0; 2 on harness failures.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
};
const PAGE = arg('--url', 'tools/entity-test.html?view=scene&live=1&hud=0&probe=manager&items=200&perspective=1').replace(/^\/+/, '');
const FRAMES = Math.max(100, Number(arg('--frames', 3000)) | 0);
const WARMUP = Math.max(0, Number(arg('--warmup', 6000)) | 0);   // JIT tier-up (Maglev -> TurboFan) before measuring
const TIERS = args.includes('--tiers');   // print the JIT tier of the hot functions (V8 natives syntax)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/** Minimal CDP client over the global WebSocket (Node 22). */
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const pending = new Map();
    let nextId = 1;
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
      if (msg.id && pending.has(msg.id)) {
        const { res, rej, method } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(`${method}: ${msg.error.message}`));
        else res(msg.result);
      } else if (msg.method === 'Runtime.exceptionThrown') {
        console.log('[pageerror]', msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text);
      }
    });
    ws.addEventListener('open', () => resolve({
      send(method, params = {}) {
        const id = nextId++;
        return new Promise((res, rej) => {
          pending.set(id, { res, rej, method });
          ws.send(JSON.stringify({ id, method, params }));
        });
      },
      close() { try { ws.close(); } catch { /* ignore */ } },
    }), { once: true });
    ws.addEventListener('error', () => reject(new Error('CDP websocket error')), { once: true });
  });
}

const server = await startServer({ port: 0, root: ROOT });
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webcraft-alloc-'));
const browser = spawn(findBrowser(), [
  '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${userDataDir}`, '--no-first-run',
  '--no-default-browser-check', '--disable-extensions', '--use-angle=d3d11', '--ignore-gpu-blocklist',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--window-size=1280,720',
  ...(TIERS ? ['--js-flags=--allow-natives-syntax'] : []), 'about:blank',
], { stdio: 'ignore' });
let page = null;
let code = 0;
try {
  const portFile = path.join(userDataDir, 'DevToolsActivePort');
  let port = 0;
  for (let i = 0; i < 150 && !port; i++) {
    await sleep(100);
    if (fs.existsSync(portFile)) port = Number(fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0]) || 0;
  }
  if (!port) throw new Error('browser did not start');
  let target = null;
  for (let i = 0; i < 50 && !target; i++) {
    target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page');
    if (!target) await sleep(100);
  }
  page = await connect(target.webSocketDebuggerUrl);
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  const evaluate = async (expression) => {
    const r = await page.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  await page.send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/${PAGE}` });
  for (let t = 0; t < 300; t++) {
    await sleep(100);
    try { if (await evaluate('!!window.__ready && typeof window.__allocLoop === "function"')) break; } catch { /* navigating */ }
  }
  await evaluate(`window.__allocLoop(${WARMUP})`);                    // warm-up (JIT tiers, buffer growth, sprite models)
  // active JIT tier of the hot functions (V8 natives; the status bit layout changes between V8 versions)
  const tiers = async (label) => {
    if (!TIERS) return;
    const st = await evaluate(`(async () => { const r = await import('/src/render/entityrenderer.js'); const e = await import('/src/game/entities.js'); const p = await import('/src/game/particles.js');
      const fns = { renderEntities: r.EntityRenderer.prototype.renderEntities, renderParticles: r.EntityRenderer.prototype.renderParticles,
        renderHand: r.EntityRenderer.prototype.renderHand, computeHandPose: r.computeHandPose, computePlayerPose: r.computePlayerPose,
        'EntityManager.update': e.EntityManager.prototype.update, getRenderList: e.EntityManager.prototype.getRenderList,
        'ParticleSystem._step': p.ParticleSystem.prototype._step, getRenderData: p.ParticleSystem.prototype.getRenderData };
      const out = {}; for (const [k, f] of Object.entries(fns)) {
        out[k] = %ActiveTierIsTurbofan(f) ? 'TurboFan' : %ActiveTierIsMaglev(f) ? 'Maglev' : %ActiveTierIsSparkplug(f) ? 'Sparkplug' : 'Ignition'; } return out; })()`);
    console.log(`  tiers ${label}: ${Object.entries(st).map(([k, v]) => k + '=' + v).join(', ')}`);
  };
  await tiers('after warm-up');
  await page.send('HeapProfiler.enable');
  await page.send('HeapProfiler.collectGarbage');
  await page.send('HeapProfiler.startSampling', {
    samplingInterval: 16, includeObjectsCollectedByMinorGC: true, includeObjectsCollectedByMajorGC: true,
  });
  const t0 = performance.now();
  await evaluate(`window.__allocLoop(${FRAMES})`);
  const ms = performance.now() - t0;
  const { profile } = await page.send('HeapProfiler.stopSampling');
  let total = 0;
  const sites = new Map();
  const walk = (n) => {
    if (n.selfSize) {
      total += n.selfSize;
      const f = n.callFrame;
      const k = `${f.functionName || '(anonymous)'} ${f.url.split('/').slice(-2).join('/')}:${f.lineNumber + 1}`;
      sites.set(k, (sites.get(k) ?? 0) + n.selfSize);
    }
    for (const c of n.children) walk(c);
  };
  walk(profile.head);
  await tiers('after the measured frames');
  const counts = await evaluate('({ entities: (window.__manager() ? window.__manager().count : 0), particles: window.__particles.count, instances: window.__er.stats.instances, draws: window.__er.stats.drawCalls })');
  console.log(`${PAGE}: ${FRAMES} frames in ${ms.toFixed(0)} ms (${(ms / FRAMES).toFixed(3)} ms/frame incl. GPU sync-free submit)`);
  console.log(`  live entities ${counts.entities}, particles ${counts.particles}, instances ${counts.instances}, draws ${counts.draws}`);
  console.log(`  allocated: ${(total / FRAMES).toFixed(1)} B/frame (sampled, includes the probe's own Runtime.evaluate)`);
  for (const [k, v] of [...sites].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`    ${(v / FRAMES).toFixed(2).padStart(9)} B/frame  ${k}`);
  }
} catch (err) {
  console.error('[entities-alloc] failed:', err);
  code = 2;
} finally {
  page?.close();
  try { browser.kill(); } catch { /* ignore */ }
  server.close();
  await sleep(300);
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}
process.exit(code);
