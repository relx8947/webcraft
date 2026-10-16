#!/usr/bin/env node
// Screenshot every UI screen of tools/ui-test.html into tools/out/ui-*.png and run the in-page
// interaction tests. Usage: node tools/ui-screenshots.mjs [--only name,name] [--no-tests]
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = [
  ['title', 'screen=title'],
  ['worlds', 'screen=worlds'],
  ['create', 'screen=create'],
  ['options', 'screen=options'],
  ['about', 'screen=about'],
  ['loading', 'screen=loading'],
  ['pause', 'screen=pause'],
  ['inventory', 'screen=inventory&mx=520&my=170'],
  ['crafting', 'screen=crafting'],
  ['creative', 'screen=creative'],
  ['creative-tools', 'screen=creative&tab=tools'],
  ['creative-search', 'screen=creative&search=%E9%92%BB%E7%9F%B3'],
  ['creative-inv', 'screen=creative&tab=inventory'],
  ['chat', 'screen=chat&prefill=/give%20dia'],
  ['death', 'screen=death&chat=1'],
  ['hud', 'screen=hud&chat=1'],
  ['hud-f3', 'screen=hud&f3=1&water=1&air=140&health=7&food=9'],
  ['hud-low', 'screen=hud&fps=1&health=3&damage=1&slot=4'],
  // wave 2
  ['furnace', 'screen=furnace&burn=0.6&cook=0.5'],
  ['furnace-full', 'screen=furnace&burn=1&cook=0.95'],
  ['furnace-empty', 'screen=furnace&burn=0&cook=0&empty=1'],
  ['chest', 'screen=chest'],
  ['creative-spawn', 'screen=creative&tab=spawn'],
  ['options-difficulty', 'screen=options'],
  ['hud-effects', 'screen=hud&poison=1&hungry=1&health=13&food=11&saturation=0'],
  ['savefailed', 'screen=savefailed'],
  ['title-nostorage', 'screen=title&storage=memory'],
  ['worlds-nostorage', 'screen=worlds&storage=memory'],
];

const args = process.argv.slice(2);
const onlyIdx = args.indexOf('--only');
const only = onlyIdx >= 0 ? new Set(args[onlyIdx + 1].split(',')) : null;
let failed = 0;

function harness(extra) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools/harness.mjs'), ...extra], { cwd: ROOT, encoding: 'utf8' });
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}

for (const [name, query] of SHOTS) {
  if (only && !only.has(name)) continue;
  const file = `tools/out/ui-${name}.png`;
  const r = harness(['--url', `tools/ui-test.html?${query}`, '--wait-for', 'window.__ready', '--sleep', '400', '--screenshot', file, '--quiet']);
  const ok = r.code === 0;
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${file}${ok ? '' : '\n' + r.out}`);
}

if (!args.includes('--no-tests')) {
  for (const fn of ['run', 'runFlow', 'runContainers', 'runReviewFixes']) {
    const r = harness(['--url', 'tools/ui-test.html?screen=hud&realinput=1', '--wait-for', 'window.__ready', '--sleep', '200', '--quiet',
      '--eval', `import('/tools/ui-interact.js').then((m) => m.${fn}()).then((r) => JSON.stringify({ passed: r.passed, failed: r.failed, failures: r.failed ? r.results : [] }))`]);
    const m = /=> "(.*)"/.exec(r.out);
    const res = m ? JSON.parse(JSON.parse(`"${m[1]}"`)) : null;
    const ok = r.code === 0 && res && res.failed === 0;
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} interaction ${fn}: ${res ? `${res.passed} passed, ${res.failed} failed` : r.out}`);
    if (res?.failures?.length) console.log(JSON.stringify(res.failures, null, 2));
  }
}
process.exit(failed ? 1 : 0);
