// Dedicated multiplayer server (server/): handshake and name claims, edit validation, server-side break
// drops, spawn checks, chat permissions and persistence across a restart. Runs the real server on a free
// port with a temporary data directory and talks to it through Node's WebSocket client.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startDedicatedServer } from '../server/main.mjs';
import { PROTOCOL_VERSION, decodeChunkFrame } from '../src/net/protocol.js';
import { rleDecode } from '../src/world/storage.js';
import { BLOCK, ITEM, IS_SOLID } from '../src/world/registry.js';

const ADMIN_KEY = 'test-admin-key';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webcraft-mp-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function start() {
  return startDedicatedServer({
    port: 0, host: '127.0.0.1', dataDir, seed: 42, worldType: 'default', adminKey: ADMIN_KEY, ops: [],
    staticDir: null, origins: null, maxPerIp: 50, workers: 1, log: () => {},
  });
}

let srv = await start();
after(async () => {
  await srv.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

class Client {
  /** Connect and say hello: resolves with the client ({ welcome } or { deny } set). */
  static open(name, { token, v = PROTOCOL_VERSION } = {}) {
    const c = new Client();
    return new Promise((resolve, reject) => {
      const ws = c.ws = new WebSocket(`ws://127.0.0.1:${srv.port}/webcraft/ws`);
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', v, name, token, rd: 4 }));
      ws.onmessage = (e) => {
        if (typeof e.data !== 'string') {
          c.frames.push(decodeChunkFrame(e.data));
          return;
        }
        const m = JSON.parse(e.data);
        c.inbox.push(m);
        if (m.t === 'welcome') resolve(Object.assign(c, { welcome: m }));
        else if (m.t === 'deny') resolve(Object.assign(c, { deny: m.r }));
      };
      ws.onclose = () => resolve(c);
      ws.onerror = reject;
    });
  }

  constructor() {
    this.inbox = [];
    this.frames = [];
    this.welcome = null;
    this.deny = null;
  }

  send(msg) {
    this.ws.send(JSON.stringify(msg));
  }

  /** Wait for a message matching `pred` (already received or arriving within `ms`). */
  async waitFor(pred, ms = 3000) {
    const t0 = Date.now();
    for (;;) {
      const m = this.inbox.find(pred);
      if (m) return m;
      if (Date.now() - t0 > ms) return null;
      await sleep(20);
    }
  }

  chatLines() {
    return this.inbox.filter((m) => m.t === 'chat').map((m) => m.m);
  }

  close() {
    this.ws.close();
    return sleep(100);
  }
}

/** Wait until the server simulates the chunk containing (x, z). */
async function chunkReady(x, y, z) {
  for (let i = 0; i < 200 && srv.game.blockAt(x, y, z) < 0; i++) await sleep(25);
  assert.ok(srv.game.blockAt(x, y, z) >= 0, 'server loaded the chunk around the player');
}

const game = () => srv.game;
const spawn = () => game().worldMeta.spawn;
const ticks = (n) => sleep(n * 50 + 30);

let aliceToken = null;

test('handshake: welcome, name claims, version and name checks', async () => {
  const alice = await Client.open('Alice');
  assert.ok(alice.welcome, 'Alice is welcomed');
  assert.equal(alice.welcome.world.seed, 42);
  assert.equal(alice.welcome.op, false);
  assert.match(alice.welcome.token, /^[0-9a-f]{32}$/);
  aliceToken = alice.welcome.token;

  const twin = await Client.open('alice', { token: aliceToken });
  assert.match(twin.deny ?? '', /已经在线/, 'the same name cannot join twice');
  assert.match((await Client.open('Bob', { v: PROTOCOL_VERSION + 1 })).deny ?? '', /版本/);
  assert.match((await Client.open('bad name!')).deny ?? '', /名字/);
  await alice.close();

  const thief = await Client.open('Alice', { token: 'not-the-token' });
  assert.match(thief.deny ?? '', /已经被别人使用/, 'a claimed name needs its token');
  const back = await Client.open('Alice', { token: aliceToken });
  assert.ok(back.welcome, 'the owner gets back in with the token');
  await back.close();
});

test('edits: reach and block checks, drops of survival breaks come from the server', async () => {
  const alice = await Client.open('Alice', { token: aliceToken });
  const { x: sx, y: sy, z: sz } = spawn();
  alice.send({ t: 'p', x: sx, y: sy, z: sz, yw: 0, pt: 0, v: [0, 0, 0], f: 8, s: 0 });
  const bx = Math.floor(sx), by = Math.floor(sy) - 1, bz = Math.floor(sz);
  await chunkReady(bx, by, bz);
  const world = game().world;

  // Too far away: refused, the client gets the real block back.
  const far = world.getBlock(bx + 30, by, bz);
  alice.send({ t: 'e', x: bx + 30, y: by, z: bz, id: BLOCK.STONE });
  // Bedrock is not a player block.
  alice.send({ t: 'e', x: bx + 1, y: by + 3, z: bz, id: BLOCK.BEDROCK });
  await ticks(3);
  assert.equal(world.getBlock(bx + 30, by, bz), far);
  assert.equal(world.getBlock(bx + 1, by + 3, bz), BLOCK.AIR);

  // Survival break of the ground under the player: one set of drops, popped by the server.
  const before = world.getBlock(bx, by, bz);
  assert.ok(IS_SOLID[before], 'standing on solid ground');
  const itemsNear = () => game().entities.list.filter((e) => e.type === 'item' && !e.removed &&
    Math.abs(e.x - (bx + 0.5)) < 1.5 && Math.abs(e.z - (bz + 0.5)) < 1.5).length;
  const n0 = itemsNear();
  alice.send({ t: 'e', x: bx, y: by, z: bz, id: BLOCK.AIR, br: 0 });
  alice.send({ t: 'e', x: bx, y: by, z: bz, id: BLOCK.AIR, br: 0 });   // a second (stale) break drops nothing
  await ticks(2);
  assert.equal(world.getBlock(bx, by, bz), BLOCK.AIR);
  assert.equal(itemsNear() - n0, 1, 'exactly one drop');
  await alice.close();
});

test('spawns: primed TNT needs a lit TNT block, spawn eggs need the egg', async () => {
  const alice = await Client.open('Alice', { token: aliceToken });
  const { x: sx, y: sy, z: sz } = spawn();
  alice.send({ t: 'p', x: sx, y: sy + 1, z: sz, yw: 0, pt: 0, v: [0, 0, 0], f: 8, s: 0 });
  await chunkReady(sx, sy, sz);
  const ents = game().entities;
  const count = (pred) => ents.list.filter((e) => !e.removed && pred(e)).length;
  const tx = Math.floor(sx) + 3, ty = Math.floor(sy) + 4, tz = Math.floor(sz);

  alice.send({ t: 's', k: 'tnt', p: [tx + 0.5, ty, tz + 0.5] });
  await ticks(2);
  assert.equal(count((e) => e.type === 'tnt'), 0, 'no TNT out of thin air');

  alice.send({ t: 'e', x: tx, y: ty, z: tz, id: BLOCK.TNT });
  await ticks(1);
  alice.send({ t: 'e', x: tx, y: ty, z: tz, id: BLOCK.AIR });           // flint and steel
  alice.send({ t: 's', k: 'tnt', p: [tx + 0.5, ty, tz + 0.5] });
  alice.send({ t: 's', k: 'tnt', p: [tx + 0.5, ty, tz + 0.5] });          // only one per lit block
  await ticks(2);
  assert.equal(count((e) => e.type === 'tnt'), 1, 'the lit block becomes one primed TNT');
  for (const e of ents.list) if (e.type === 'tnt') e.remove();

  const zombies = () => count((e) => e.type === 'mob' && e.mobType === 'zombie');
  const z0 = zombies();
  alice.send({ t: 's', k: 'mob', mt: 'zombie', p: [sx + 2, sy, sz] });
  await ticks(2);
  assert.equal(zombies(), z0, 'no egg, no zombie');
  const slots = Array(36).fill(null);
  slots[0] = [ITEM.ZOMBIE_SPAWN_EGG, 1, 0];
  alice.send({ t: 'inv', sl: slots, s: 0 });
  alice.send({ t: 's', k: 'mob', mt: 'zombie', p: [sx + 2, sy, sz] });
  await ticks(2);
  assert.equal(zombies(), z0 + 1, 'the egg spawns its mob');
  for (const e of ents.list) if (e.type === 'mob') e.remove();
  await alice.close();
});

test('chat and commands: broadcast, operator-only commands, /login', async () => {
  const alice = await Client.open('Alice', { token: aliceToken });
  const bob = await Client.open('Bob');
  assert.ok(bob.welcome);
  alice.send({ t: 'chat', m: 'hello §cworld' });
  assert.ok(await bob.waitFor((m) => m.t === 'chat' && m.m === '<Alice> hello world'), 'chat reaches Bob without colour codes');

  alice.send({ t: 'chat', m: '/time set night' });
  assert.ok(await alice.waitFor((m) => m.t === 'chat' && /只有管理员/.test(m.m)));
  alice.send({ t: 'chat', m: '/login wrong' });
  assert.ok(await alice.waitFor((m) => m.t === 'chat' && /口令不正确/.test(m.m)));
  alice.send({ t: 'chat', m: `/login ${ADMIN_KEY}` });
  assert.ok(await alice.waitFor((m) => m.t === 'op' && m.op === true), 'the admin key makes Alice an operator');
  assert.ok(game().isOp('Alice'));

  alice.send({ t: 'chat', m: '/kick Bob 测试' });
  assert.ok(await bob.waitFor((m) => m.t === 'deny' && /请出/.test(m.r)), 'operators can kick');
  await alice.close();
});

test('persistence: block edits, chest contents and player records survive a restart', async () => {
  const alice = await Client.open('Alice', { token: aliceToken });
  const { x: sx, y: sy, z: sz } = spawn();
  alice.send({ t: 'p', x: sx, y: sy, z: sz, yw: 0, pt: 0, v: [0, 0, 0], f: 8, s: 0 });
  const cx = Math.floor(sx) - 2, cy = Math.floor(sy) + 3, cz = Math.floor(sz);
  await chunkReady(cx, cy, cz);
  alice.send({ t: 'e', x: cx - 1, y: cy, z: cz, id: BLOCK.STONE });
  alice.send({ t: 'e', x: cx, y: cy, z: cz, id: BLOCK.CHEST });
  await ticks(1);
  alice.send({ t: 'co', x: cx, y: cy, z: cz });
  assert.ok(await alice.waitFor((m) => m.t === 'ct' && m.be?.type === 'chest'), 'chest opens: ' + JSON.stringify([game().world.getBlock(cx, cy, cz), game().world.getBlock(cx, cy + 1, cz), alice.inbox.slice(-6)]));
  alice.send({ t: 'cs', x: cx, y: cy, z: cz, ch: [[0, null, [ITEM.DIAMOND, 3, 0]]] });
  alice.send({ t: 'cc', x: cx, y: cy, z: cz });
  const inv = [{ id: BLOCK.STONE, count: 10, damage: 0 }];
  alice.send({ t: 'save', rec: { x: sx + 1, y: sy, z: sz, yaw: 1.5, health: 15, inventory: inv } });
  await ticks(2);
  await alice.close();

  await srv.close();
  srv = await start();

  const again = await Client.open('Alice', { token: aliceToken });
  assert.ok(again.welcome, 'the name claim survives the restart');
  const rec = again.welcome.rec;
  assert.equal(rec.x, sx + 1);
  assert.equal(rec.health, 15);
  assert.deepEqual(rec.inventory, inv);
  assert.equal(again.welcome.op, true, 'operators stay operators');

  again.send({ t: 'p', x: sx, y: sy, z: sz, yw: 0, pt: 0, v: [0, 0, 0], f: 8, s: 0 });
  const ccx = cx >> 4, ccz = cz >> 4;
  again.send({ t: 'sub', c: [ccx, ccz, 1] });
  let frame = null;
  for (let i = 0; i < 100 && !frame; i++) {
    frame = again.frames.find((f) => f && f.cx === ccx && f.cz === ccz);
    await sleep(30);
  }
  assert.ok(frame && frame.rle, 'the edited chunk is sent as data, not regenerated');
  const blocks = rleDecode(frame.rle, 65536);
  const at = (x, y, z) => blocks[(y << 8) | ((z & 15) << 4) | (x & 15)];
  assert.equal(at(cx - 1, cy, cz), BLOCK.STONE);
  assert.equal(at(cx, cy, cz), BLOCK.CHEST);

  await chunkReady(cx, cy, cz);
  again.send({ t: 'co', x: cx, y: cy, z: cz });
  const ct = await again.waitFor((m) => m.t === 'ct');
  assert.deepEqual(ct?.be?.items?.[0], [ITEM.DIAMOND, 3, 0], 'chest contents are kept');
  await again.close();
});
