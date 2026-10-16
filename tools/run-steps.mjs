#!/usr/bin/env node
// Run several harness step files (in parallel batches) and summarise: node tools/run-steps.mjs [-j N] spec...
//   spec = steps.json[@url]   (default url: index.html?autostart=1&seed=42&mode=survival&nomusic=1)
//   spec = suite.txt          one spec per line (# comments), e.g. tools/steps/regression.txt
// A spec whose url has no "autostart" waits for nothing; autostart urls wait for window.__ready.
// Logs: tools/out/runs/<steps>.log. Exit code 1 if any run failed (page errors, failed step).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
let jobs = 2;
const specs = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '-j') jobs = Number(args[++i]) || 2;
  else if (args[i].endsWith('.txt')) {
    for (const line of fs.readFileSync(args[i], 'utf8').split(String.fromCharCode(10))) {
      const t = line.trim();
      if (t && !t.startsWith('#')) specs.push(t);
    }
  } else specs.push(args[i]);
}
const DEFAULT_URL = 'index.html?autostart=1&seed=42&mode=survival&nomusic=1';
fs.mkdirSync('tools/out/runs', { recursive: true });

function run(spec) {
  const at = spec.indexOf('@');
  const steps = at >= 0 ? spec.slice(0, at) : spec;
  const url = at >= 0 ? spec.slice(at + 1) : DEFAULT_URL;
  const hargs = ['tools/harness.mjs', '--url', url, '--steps', steps, '--timeout', '420000', '--quiet'];
  if (url.includes('autostart')) hargs.push('--wait-for', 'window.__ready', '--wait-timeout', '90000');
  const log = path.join('tools/out/runs', path.basename(steps, '.json') + '.log');
  const t0 = Date.now();
  return new Promise((resolve) => {
    const p = spawn(process.execPath, hargs, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => {
      fs.writeFileSync(log, out);
      const errs = out.split('\n')
        .filter((l) => /\[pageerror\]|\[console\.(error|warn|assert)\]|\[log\.error\]|failed|timeout|error:/i.test(l))
        .slice(0, 6);
      resolve({ steps, code, s: ((Date.now() - t0) / 1000).toFixed(0), errs, log });
    });
  });
}

const results = [];
const queue = specs.slice();
async function worker() {
  while (queue.length) {
    const r = await run(queue.shift());
    results.push(r);
    console.log(`${r.code === 0 ? 'PASS' : 'FAIL'} ${r.steps} (${r.s}s)${r.errs.length ? '\n      ' + r.errs.join('\n      ') : ''}`);
  }
}
await Promise.all(Array.from({ length: jobs }, worker));
const fails = results.filter((r) => r.code !== 0);
console.log(`\n${results.length - fails.length}/${results.length} passed`);
process.exit(fails.length ? 1 : 0);
