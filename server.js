// Zero-dependency static file server for WebCraft.
//   node server.js            -> serves on http://127.0.0.1:8080 (next free port if busy)
//   node server.js --open     -> also opens the default browser
//   PORT=9000 node server.js
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

function handler(root) {
  return (req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      res.writeHead(400).end('Bad request');
      return;
    }
    let file = path.normalize(path.join(root, pathname));
    if (!file.startsWith(root)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    fs.stat(file, (err, st) => {
      if (!err && st.isDirectory()) {
        file = path.join(file, 'index.html');
      }
      fs.readFile(file, (err2, data) => {
        if (err2) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found: ' + pathname);
          return;
        }
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
          'Cache-Control': 'no-store',
        });
        res.end(data);
      });
    });
  };
}

/**
 * Start the server. Resolves with the http.Server once listening.
 * If the port is busy (and strictPort is false) the next ports are tried. Port 0 = random free port.
 */
export function startServer({ port = 8080, root = ROOT, host = '127.0.0.1', strictPort = false } = {}) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler(path.resolve(root)));
    let attempts = 0;
    const tryListen = (p) => {
      const onError = (err) => {
        if (err.code === 'EADDRINUSE' && !strictPort && p !== 0 && attempts++ < 20) {
          tryListen(p + 1);
        } else {
          reject(err);
        }
      };
      server.once('error', onError);
      server.listen(p, host, () => {
        server.off('error', onError);
        resolve(server);
      });
    };
    tryListen(port);
  });
}

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '""', url] : [url];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
  } catch {
    /* ignore */
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.PORT) || 8080;
  const server = await startServer({ port });
  const url = `http://127.0.0.1:${server.address().port}/`;
  console.log(`WebCraft 服务器已启动: ${url}`);
  console.log('按 Ctrl+C 停止服务器。');
  if (process.argv.includes('--open')) openBrowser(url);
}
