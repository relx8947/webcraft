// WebCraft dedicated server (multiplayer). Node >= 22, zero dependencies.
//
//   node server/main.mjs                    WebSocket endpoint ws://127.0.0.1:8787/webcraft/ws
//   WEBCRAFT_STATIC=. node server/main.mjs  also serves the game itself (local development:
//                                           open http://127.0.0.1:8787/ and pick 多人游戏)
//
// Environment:
//   WEBCRAFT_PORT (8787)  WEBCRAFT_HOST (127.0.0.1)  WEBCRAFT_DATA (./data)  WEBCRAFT_WORLD (main)
//   WEBCRAFT_SEED         WEBCRAFT_WORLD_TYPE (default|flat)
//   WEBCRAFT_ADMIN_KEY    secret for /login <key> (makes the player an operator)
//   WEBCRAFT_OPS          comma-separated operator names
//   WEBCRAFT_MAX_PLAYERS (20)  WEBCRAFT_SIM_DISTANCE (5 chunks around each player)
//   WEBCRAFT_ORIGINS      comma-separated allowed page origins (default: gservice.site + localhost)
//   WEBCRAFT_MOTD         line shown when joining
//   WEBCRAFT_PVP          1 = players' arrows hurt other players (default off)
// Behind nginx the client address comes from X-Real-IP / X-Forwarded-For (trusted from 127.0.0.1 only).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acceptWebSocket } from './ws.mjs';
import { createNodePool } from './nodepool.mjs';
import { openFileStorage } from './filestorage.mjs';
import { ServerGame } from './servergame.mjs';
import { Session } from './session.mjs';
import { PROTOCOL_VERSION } from '../src/net/protocol.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;
const list = (v) => String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

export function loadConfig(overrides = {}) {
  return {
    port: Number(env.WEBCRAFT_PORT) || 8787,
    host: env.WEBCRAFT_HOST || '127.0.0.1',
    dataDir: path.resolve(env.WEBCRAFT_DATA || path.join(ROOT, 'data')),
    worldId: env.WEBCRAFT_WORLD || 'main',
    seed: env.WEBCRAFT_SEED ? (Number(env.WEBCRAFT_SEED) >>> 0) : undefined,
    worldType: env.WEBCRAFT_WORLD_TYPE === 'flat' ? 'flat' : 'default',
    adminKey: env.WEBCRAFT_ADMIN_KEY || '',
    ops: list(env.WEBCRAFT_OPS),
    maxPlayers: Number(env.WEBCRAFT_MAX_PLAYERS) || 20,
    simDistance: Math.max(3, Math.min(8, Number(env.WEBCRAFT_SIM_DISTANCE) || 5)),
    origins: env.WEBCRAFT_ORIGINS ? list(env.WEBCRAFT_ORIGINS) : null,
    motd: env.WEBCRAFT_MOTD || '',
    pvp: env.WEBCRAFT_PVP === '1',
    staticDir: env.WEBCRAFT_STATIC ? path.resolve(env.WEBCRAFT_STATIC) : null,
    maxPerIp: 4,
    ...overrides,
  };
}

const DEFAULT_ORIGIN = /^(https:\/\/(www\.)?gservice\.site|https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?)$/;

function originAllowed(config, origin) {
  if (!origin) return true;                     // non-browser clients (tests, tools)
  if (config.origins) return config.origins.includes(origin);
  return DEFAULT_ORIGIN.test(origin);
}

function clientIp(req) {
  const remote = req.socket.remoteAddress ?? '';
  const local = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  if (local) {
    const real = req.headers['x-real-ip'] || String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
    if (real) return String(real);
  }
  return remote.replace(/^::ffff:/, '');
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png',
};

function serveStatic(dir, req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  pathname = pathname.replace(/^\/webcraft(?=\/|$)/, '') || '/';
  let file = path.normalize(path.join(dir, pathname));
  if (!file.startsWith(dir)) {
    res.writeHead(403).end();
    return;
  }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

/**
 * Start the server. Resolves with { server (ServerGame), http, close() }.
 * @param {object} [overrides] config overrides (tests: { port: 0, dataDir })
 */
export async function startDedicatedServer(overrides = {}) {
  const config = loadConfig(overrides);
  const log = overrides.log ?? ((level, ...a) => {
    const line = `${new Date().toISOString()} ${level.toUpperCase()} ${a.map((x) => (x instanceof Error ? x.stack : String(x))).join(' ')}`;
    (level === 'error' ? console.error : console.log)(line);
  });
  const { storage } = openFileStorage(config.dataDir);
  const pool = createNodePool(overrides.workers);
  const game = new ServerGame({ storage, pool, config, log });
  await game.start();

  const perIp = new Map();
  const httpServer = http.createServer((req, res) => {
    const url = req.url ?? '/';
    if (/^(\/webcraft)?\/status(\?|$)/.test(url)) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({
        online: game.players.length, max: config.maxPlayers, players: game.players.map((p) => p.name),
        motd: config.motd, version: PROTOCOL_VERSION, world: game.worldMeta?.name ?? '',
      }));
      return;
    }
    if (config.staticDir) {
      serveStatic(config.staticDir, req, res);
      return;
    }
    res.writeHead(404).end();
  });
  httpServer.on('upgrade', (req, socket, head) => {
    const url = req.url ?? '';
    if (!/^(\/webcraft)?\/ws(\?|$)/.test(url) || !originAllowed(config, req.headers.origin)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const ip = clientIp(req);
    const n = perIp.get(ip) ?? 0;
    if (n >= config.maxPerIp) {
      socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const ws = acceptWebSocket(req, socket, head, { maxPayload: 256 * 1024 });
    if (!ws) return;
    perIp.set(ip, n + 1);
    ws.on('close', () => {
      const k = (perIp.get(ip) ?? 1) - 1;
      if (k <= 0) perIp.delete(ip);
      else perIp.set(ip, k);
    });
    new Session(game, ws, ip);   // eslint-disable-line no-new
  });
  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(config.port, config.host, resolve);
  });
  const addr = httpServer.address();
  log('info', `listening on ${addr.address}:${addr.port}${config.staticDir ? ` (serving ${config.staticDir})` : ''}`);

  let closing = null;
  const close = () => {
    if (closing) return closing;
    closing = (async () => {
      httpServer.close();
      await game.stop();
      pool.terminate();
    })();
    return closing;
  };
  return { game, http: httpServer, port: addr.port, close, config };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const srv = await startDedicatedServer();
  let stopping = false;
  const shutdown = (sig) => {
    if (stopping) return;
    stopping = true;
    srv.game.log('info', `${sig}: saving and shutting down`);
    srv.close().then(() => process.exit(0), (err) => {
      console.error(err);
      process.exit(1);
    });
    setTimeout(() => process.exit(1), 15000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
