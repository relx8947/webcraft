#!/usr/bin/env node
// Headless browser test harness (Edge/Chrome via the Chrome DevTools Protocol). Zero dependencies, Node >= 22.
//
// Usage:
//   node tools/harness.mjs --url /index.html?autostart=1 --wait-for "window.__ready" --screenshot out.png
//   node tools/harness.mjs --url /tools/texture-preview.html --sleep 1000 --screenshot tex.png
//   node tools/harness.mjs --url /index.html --steps tools/steps/smoke.json
//
// Options:
//   --url <path|url>        Page to open. Paths are served from the project root by a built-in static server.
//                           Prefer paths WITHOUT a leading slash in Git Bash (e.g. --url index.html?autostart=1);
//                           MSYS-mangled "/x" paths are repaired automatically.
//   --width <px>            Viewport width  (default 1280)
//   --height <px>           Viewport height (default 720)
//   --wait-for <js expr>    Poll until the expression is truthy (after load).
//   --wait-timeout <ms>     Timeout for --wait-for and waitFor steps (default 60000)
//   --sleep <ms>            Sleep after load / wait-for, before evals/steps.
//   --eval <js>             Evaluate (awaits promises) and print the JSON result. Repeatable.
//   --steps <file.json>     JSON array of steps (see below). Runs after --eval.
//   --screenshot <file>     Final screenshot (PNG).
//   --timeout <ms>          Hard overall timeout (default 180000).
//   --allow-errors          Exit 0 even if page errors / console.error happened.
//   --quiet                 Do not print console.log/info/debug messages (errors & warnings still printed).
//   --headful               Show the browser window.
//
// Steps (objects, executed in order):
//   {"eval": "js"}                       evaluate + print result
//   {"waitFor": "js", "timeout": 30000}  poll until truthy
//   {"sleep": 500}
//   {"screenshot": "path.png"}
//   {"key": "KeyW", "action": "down"|"up"|"press"}   (press = down+up)
//   {"type": "text"}                     insert text into focused element
//   {"click": [x, y], "button": "left"|"right"|"middle"}
//   {"mouseDown": [x, y], "button": "left"} / {"mouseUp": [x, y], "button": "left"}
//   {"move": [x, y]}
//   {"wheel": [x, y, deltaY]}
//   {"log": "message"}
//
// Exit codes: 0 ok, 1 page errors (uncaught exceptions, console.error, failed loads) or failed step, 2 harness failure.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const opts = { evals: [], width: 1280, height: 720, waitTimeout: 60000, timeout: 180000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--url': opts.url = next(); break;
      case '--width': opts.width = Number(next()); break;
      case '--height': opts.height = Number(next()); break;
      case '--wait-for': opts.waitFor = next(); break;
      case '--wait-timeout': opts.waitTimeout = Number(next()); break;
      case '--sleep': opts.sleep = Number(next()); break;
      case '--eval': opts.evals.push(next()); break;
      case '--steps': opts.steps = next(); break;
      case '--screenshot': opts.screenshot = next(); break;
      case '--timeout': opts.timeout = Number(next()); break;
      case '--allow-errors': opts.allowErrors = true; break;
      case '--quiet': opts.quiet = true; break;
      case '--headful': opts.headful = true; break;
      default:
        console.error(`Unknown option ${a}`);
        process.exit(2);
    }
  }
  return opts;
}

function findBrowser() {
  const candidates = [
    process.env.BROWSER_PATH,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error('No Chromium-based browser found (set BROWSER_PATH).');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Git Bash (MSYS) rewrites "/index.html" into "C:/Program Files/Git/index.html". Undo that, and also accept
// absolute filesystem paths inside the project. Returns a project-relative path ("/x?y") or the original URL.
function normalizeUrlArg(raw) {
  if (/^https?:\/\//.test(raw)) return raw;
  const qi = raw.search(/[?#]/);
  const p = qi >= 0 ? raw.slice(0, qi) : raw;
  const query = qi >= 0 ? raw.slice(qi) : '';
  if (!/^[A-Za-z]:[\\/]/.test(p)) return '/' + p.replace(/^\/+/, '') + query;
  const abs = path.resolve(p);
  if (abs.toLowerCase().startsWith(ROOT.toLowerCase() + path.sep)) {
    return '/' + path.relative(ROOT, abs).split(path.sep).join('/') + query;
  }
  const segs = p.replace(/\\/g, '/').split('/').slice(1);
  for (let i = 0; i < segs.length; i++) {
    const rel = segs.slice(i).join('/');
    if (rel && fs.existsSync(path.join(ROOT, rel))) return '/' + rel + query;
  }
  return '/' + segs[segs.length - 1] + query;
}

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
        for (const fn of this.listeners.get(msg.method) ?? []) fn(msg.params);
      }
    });
  }
  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener('open', () => resolve(new CDP(ws)), { once: true });
      ws.addEventListener('error', (e) => reject(new Error('CDP websocket error ' + (e.message ?? ''))), { once: true });
    });
  }
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }
  close() {
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

const KEY_INFO = (() => {
  const m = {
    Space: [' ', 32], Enter: ['Enter', 13], Escape: ['Escape', 27], Tab: ['Tab', 9], Backspace: ['Backspace', 8],
    ShiftLeft: ['Shift', 16], ShiftRight: ['Shift', 16], ControlLeft: ['Control', 17], ControlRight: ['Control', 17],
    AltLeft: ['Alt', 18], ArrowUp: ['ArrowUp', 38], ArrowDown: ['ArrowDown', 40], ArrowLeft: ['ArrowLeft', 37],
    ArrowRight: ['ArrowRight', 39], Slash: ['/', 191], Delete: ['Delete', 46],
  };
  for (let c = 65; c <= 90; c++) m['Key' + String.fromCharCode(c)] = [String.fromCharCode(c + 32), c];
  for (let d = 0; d <= 9; d++) m['Digit' + d] = [String(d), 48 + d];
  for (let f = 1; f <= 12; f++) m['F' + f] = ['F' + f, 111 + f];
  return m;
})();

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.url) {
    console.error('Missing --url');
    process.exit(2);
  }
  let server = null;
  let url = normalizeUrlArg(opts.url);
  if (!/^https?:\/\//.test(url)) {
    server = await startServer({ port: 0, root: ROOT });
    url = `http://127.0.0.1:${server.address().port}${url.startsWith('/') ? '' : '/'}${url}`;
  }

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webcraft-harness-'));
  const browserArgs = [
    opts.headful ? null : '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-sync',
    '--disable-features=msEdgeSidebarV2,EdgeCollections,msImplicitSignin,Translate',
    '--autoplay-policy=no-user-gesture-required',
    '--use-angle=d3d11',
    '--ignore-gpu-blocklist',
    '--enable-unsafe-swiftshader',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    `--window-size=${opts.width},${opts.height}`,
    'about:blank',
  ].filter(Boolean);
  const browser = spawn(findBrowser(), browserArgs, { stdio: ['ignore', 'ignore', 'ignore'] });

  let errors = 0;
  let cdp = null;
  let browserCdp = null;
  const cleanup = async () => {
    try { if (browserCdp) await Promise.race([browserCdp.send('Browser.close'), sleep(2000)]); } catch { /* ignore */ }
    cdp?.close();
    browserCdp?.close();
    try { browser.kill(); } catch { /* ignore */ }
    server?.close();
    await sleep(300);
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  };
  const hardTimer = setTimeout(async () => {
    console.error(`[harness] overall timeout ${opts.timeout}ms exceeded`);
    await cleanup();
    process.exit(2);
  }, opts.timeout);

  try {
    // Wait for DevToolsActivePort.
    const portFile = path.join(userDataDir, 'DevToolsActivePort');
    let port = null;
    let browserPath = null;
    for (let i = 0; i < 150 && !port; i++) {
      await sleep(100);
      if (fs.existsSync(portFile)) {
        const lines = fs.readFileSync(portFile, 'utf8').split(/\r?\n/);
        if (lines[0]) { port = Number(lines[0]); browserPath = lines[1]; }
      }
    }
    if (!port) throw new Error('browser did not start (no DevToolsActivePort)');
    browserCdp = await CDP.connect(`ws://127.0.0.1:${port}${browserPath}`);

    let target = null;
    for (let i = 0; i < 50 && !target; i++) {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find((t) => t.type === 'page');
      if (!target) await sleep(100);
    }
    if (!target) throw new Error('no page target');
    cdp = await CDP.connect(target.webSocketDebuggerUrl);

    const fmtArg = (a) => {
      if (a.type === 'string') return a.value;
      if (a.value !== undefined) return JSON.stringify(a.value);
      if (a.unserializableValue) return a.unserializableValue;
      return a.description ?? a.type;
    };
    cdp.on('Runtime.consoleAPICalled', (p) => {
      const text = p.args.map(fmtArg).join(' ');
      const lvl = p.type;
      if (lvl === 'error' || lvl === 'assert') {
        errors++;
        console.log(`[console.${lvl}] ${text}`);
      } else if (lvl === 'warning' || lvl === 'warn') {
        console.log(`[console.warn] ${text}`);
      } else if (!opts.quiet) {
        console.log(`[console.${lvl}] ${text}`);
      }
    });
    cdp.on('Runtime.exceptionThrown', (p) => {
      errors++;
      const d = p.exceptionDetails;
      const desc = d.exception?.description ?? d.text;
      console.log(`[pageerror] ${desc} (${d.url ?? ''}:${d.lineNumber ?? ''}:${d.columnNumber ?? ''})`);
    });
    cdp.on('Log.entryAdded', (p) => {
      const e = p.entry;
      if (e.level === 'error' && !/favicon.ico/.test(e.url ?? '')) {
        errors++;
        console.log(`[log.error] ${e.source}: ${e.text} ${e.url ?? ''}`);
      } else if (e.level === 'warning' && !opts.quiet) {
        console.log(`[log.warn] ${e.source}: ${e.text}`);
      }
    });
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Page.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: opts.width, height: opts.height, deviceScaleFactor: 1, mobile: false,
    });

    const evaluate = async (expr) => {
      const r = await cdp.send('Runtime.evaluate', {
        expression: expr, awaitPromise: true, returnByValue: true, userGesture: true,
      });
      if (r.exceptionDetails) {
        throw new Error('eval failed: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
      }
      return r.result.value;
    };
    const waitFor = async (expr, timeout) => {
      const t0 = Date.now();
      while (Date.now() - t0 < timeout) {
        try {
          if (await evaluate(`!!(${expr})`)) return Date.now() - t0;
        } catch { /* page may be navigating */ }
        await sleep(200);
      }
      throw new Error(`waitFor timeout (${timeout}ms): ${expr}`);
    };
    const screenshot = async (file) => {
      const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const out = path.resolve(file);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, Buffer.from(r.data, 'base64'));
      console.log(`[harness] screenshot -> ${out}`);
    };
    const key = async (code, type) => {
      const [k, vk] = KEY_INFO[code] ?? [code, 0];
      await cdp.send('Input.dispatchKeyEvent', {
        type, code, key: k, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
        text: type === 'keyDown' && k.length === 1 ? k : undefined,
      });
    };
    const mouse = async (type, x, y, button = 'none', extra = {}) => {
      await cdp.send('Input.dispatchMouseEvent', { type, x, y, button, clickCount: button === 'none' ? 0 : 1, ...extra });
    };

    console.log(`[harness] opening ${url}`);
    await cdp.send('Page.navigate', { url });
    await waitFor('document.readyState === "complete"', 30000);
    if (opts.waitFor) {
      const ms = await waitFor(opts.waitFor, opts.waitTimeout);
      console.log(`[harness] wait-for satisfied after ${ms}ms`);
    }
    if (opts.sleep) await sleep(opts.sleep);

    for (const e of opts.evals) {
      const v = await evaluate(e);
      console.log(`[eval] ${e}\n=> ${JSON.stringify(v, null, 2)}`);
    }

    if (opts.steps) {
      const steps = JSON.parse(fs.readFileSync(opts.steps, 'utf8'));
      for (const s of steps) {
        if (s.eval !== undefined) {
          const v = await evaluate(s.eval);
          console.log(`[eval] ${s.eval.length > 200 ? s.eval.slice(0, 200) + '…' : s.eval}\n=> ${JSON.stringify(v, null, 2)}`);
        } else if (s.waitFor !== undefined) {
          const ms = await waitFor(s.waitFor, s.timeout ?? opts.waitTimeout);
          console.log(`[harness] waitFor ok (${ms}ms): ${s.waitFor}`);
        } else if (s.sleep !== undefined) {
          await sleep(s.sleep);
        } else if (s.screenshot !== undefined) {
          await screenshot(s.screenshot);
        } else if (s.key !== undefined) {
          const action = s.action ?? 'press';
          if (action === 'down' || action === 'press') await key(s.key, 'keyDown');
          if (action === 'up' || action === 'press') await key(s.key, 'keyUp');
        } else if (s.type !== undefined) {
          await cdp.send('Input.insertText', { text: s.type });
        } else if (s.click !== undefined) {
          const [x, y] = s.click;
          await mouse('mouseMoved', x, y);
          await mouse('mousePressed', x, y, s.button ?? 'left');
          await mouse('mouseReleased', x, y, s.button ?? 'left');
        } else if (s.mouseDown !== undefined) {
          await mouse('mousePressed', s.mouseDown[0], s.mouseDown[1], s.button ?? 'left');
        } else if (s.mouseUp !== undefined) {
          await mouse('mouseReleased', s.mouseUp[0], s.mouseUp[1], s.button ?? 'left');
        } else if (s.move !== undefined) {
          await mouse('mouseMoved', s.move[0], s.move[1]);
        } else if (s.wheel !== undefined) {
          await mouse('mouseWheel', s.wheel[0], s.wheel[1], 'none', { deltaX: 0, deltaY: s.wheel[2] });
        } else if (s.log !== undefined) {
          console.log(`[step] ${s.log}`);
        } else {
          throw new Error('unknown step ' + JSON.stringify(s));
        }
      }
    }

    if (opts.screenshot) await screenshot(opts.screenshot);
  } catch (err) {
    console.log(`[harness] FAILED: ${err.message}`);
    clearTimeout(hardTimer);
    await cleanup();
    process.exit(1);
  }

  clearTimeout(hardTimer);
  await cleanup();
  if (errors > 0) {
    console.log(`[harness] done with ${errors} page error(s)`);
    process.exit(opts.allowErrors ? 0 : 1);
  }
  console.log('[harness] done, no page errors');
  process.exit(0);
}

main().catch(async (e) => {
  console.error('[harness] crashed:', e);
  process.exit(2);
});
