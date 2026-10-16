#!/usr/bin/env node
// Renders the standard renderer screenshots (tools/out/render-*.png) through tools/harness.mjs.
//   node tools/render-shots.mjs            all shots
//   node tools/render-shots.mjs noon dusk  only the named shots
// Extra URL parameters for every shot can be given with  --extra "filter=classic&hud=0".
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const SHOTS = {
  // yaw: 0 = north (-Z), +90 = west (-X), -90 = east (+X); the sun rises in the east and sets in the west
  noon: 'time=0.25&t=3',
  sunset: 'time=0.49&yaw=90&pitch=4&t=3',
  sunrise: 'time=0.012&yaw=-90&pitch=6&t=3',
  dusk: 'time=0.53&yaw=80&pitch=8&t=3',
  midnight: 'time=0.75&pitch=10&t=3',
  midnightCave: 'time=0.75&view=chamber&t=3',
  sun: 'time=0.36&yaw=90&pitch=50&t=3',
  moon: 'time=0.82&yaw=90&pitch=60&t=3',
  clouds: 'time=0.3&pitch=25&yaw=10&t=3',
  cloudsAbove: 'time=0.3&y=205&pitch=-20&yaw=30&rd=8&t=3',
  underwater: 'time=0.25&x=15.5&y=59.5&z=22.5&yaw=-20&pitch=8&underwater=1&t=3',
  lava: 'time=0.25&x=48.5&y=66.6&z=46.5&yaw=20&pitch=-20&lava=1&t=3',
  select: 'time=0.25&x=26.5&y=69.6&z=48.5&yaw=0&pitch=-55&select=26,66,46&crack=6&t=3',
  cave: 'time=0.25&view=cave&t=3',
  closeup: 'time=0.25&x=25.6&y=68.4&z=47.2&yaw=10&pitch=-35&t=3',
  aquarium: 'time=0.25&view=aquarium&t=3',
  lake: 'time=0.25&view=lake&t=3',
  hand: 'time=0.25&hand=1&t=3',
  far: 'time=0.25&y=110&pitch=-25&rd=8&t=3',
};

function run(name, query, extra) {
  const url = `tools/render-test.html?${query}${extra ? '&' + extra : ''}`;
  const out = `tools/out/render-${name}.png`;
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['tools/harness.mjs', '--url', url, '--wait-for', 'window.__ready', '--sleep', '700',
      '--screenshot', out, '--quiet'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    p.stdout.on('data', (d) => { log += d; });
    p.stderr.on('data', (d) => { log += d; });
    p.on('close', (code) => resolve({ name, code, log, out }));
  });
}

const args = process.argv.slice(2);
let extra = '';
const names = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--extra') extra = args[++i];
  else names.push(args[i]);
}
const list = (names.length ? names : Object.keys(SHOTS)).filter((n) => SHOTS[n] !== undefined);
const CONCURRENCY = 4;
let failed = 0;
for (let i = 0; i < list.length; i += CONCURRENCY) {
  const batch = list.slice(i, i + CONCURRENCY).map((n) => run(n, SHOTS[n], extra));
  for (const r of await Promise.all(batch)) {
    const errs = r.log.split('\n').filter((l) => /error|FAILED|pageerror|warn/i.test(l));
    console.log(`${r.code === 0 ? 'ok  ' : 'FAIL'} ${r.name.padEnd(12)} -> ${r.out}${errs.length ? '\n     ' + errs.join('\n     ') : ''}`);
    if (r.code !== 0) failed++;
  }
}
process.exit(failed ? 1 : 0);
