import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PhysicsBody, raycast, aabbIntersectsSolid } from '../src/game/physics.js';
import { Inventory, makeStack } from '../src/game/inventory.js';
import { BLOCK, ITEM } from '../src/world/registry.js';
import { mat4Create, mat4Perspective, mat4ViewRotation, mat4Multiply, Frustum, lookVector } from '../src/util/math.js';

// Flat test world: stone for y < 64, plus explicit overrides.
function makeWorld(overrides = {}) {
  return {
    getBlock(x, y, z) {
      const k = `${x},${y},${z}`;
      if (k in overrides) return overrides[k];
      return y < 64 ? BLOCK.STONE : BLOCK.AIR;
    },
  };
}

test('body lands on the ground', () => {
  const w = makeWorld();
  const b = new PhysicsBody(0.6, 1.8);
  b.setPosition(0.5, 70, 0.5);
  for (let i = 0; i < 200; i++) {
    b.vy -= 32 * 0.01;
    b.move(w, 0, b.vy * 0.01, 0);
  }
  assert.ok(Math.abs(b.y - 64) < 1e-6, `y=${b.y}`);
  assert.equal(b.onGround, true);
  assert.equal(b.vy, 0);
});

test('body is blocked by a wall and slides', () => {
  const w = makeWorld({ '2,64,0': BLOCK.STONE, '2,65,0': BLOCK.STONE });
  const b = new PhysicsBody(0.6, 1.8);
  b.setPosition(1.5, 64, 0.5);
  b.move(w, 1, 0, 0.2);
  assert.ok(Math.abs(b.x - (2 - 0.3)) < 1e-6, `x=${b.x}`);
  assert.ok(Math.abs(b.z - 0.7) < 1e-6);
  assert.equal(b.collidedX, true);
});

test('raycast hits the top face and respects selection boxes', () => {
  const w = makeWorld({ '0,64,0': BLOCK.TORCH, '-1,64,5': BLOCK.STONE });
  const hit = raycast(w, 0.5, 66, 0.5, 0, -1, 0, 10);
  assert.equal(hit.blockId, BLOCK.TORCH);
  assert.equal(hit.face, 2);
  assert.ok(Math.abs(hit.distance - (66 - 64.625)) < 1e-9);
  const miss = raycast(w, 0.05, 66, 0.05, 0, -1, 0, 10); // torch is thin: ray passes beside it to stone
  assert.equal(miss.blockId, BLOCK.STONE);
  assert.equal(miss.y, 63);
  const side = raycast(w, -3, 64.5, 5.5, 1, 0, 0, 10);
  assert.equal(side.face, 1);
  assert.equal(side.x, -1);
});

test('aabbIntersectsSolid', () => {
  const w = makeWorld();
  assert.equal(aabbIntersectsSolid(w, 0, 64, 0, 1, 65.8, 1), false);
  assert.equal(aabbIntersectsSolid(w, 0, 63.9, 0, 1, 65, 1), true);
});

test('inventory add/merge/consume', () => {
  const inv = new Inventory();
  assert.equal(inv.add(makeStack(BLOCK.DIRT, 100)), 0);
  assert.equal(inv.get(0).count, 64);
  assert.equal(inv.get(1).count, 36);
  assert.equal(inv.add(makeStack(ITEM.DIAMOND_PICKAXE, 1)), 0);
  assert.equal(inv.get(2).id, ITEM.DIAMOND_PICKAXE);
  assert.equal(inv.count(BLOCK.DIRT), 100);
  assert.equal(inv.consume(BLOCK.DIRT, 50), true);
  assert.equal(inv.count(BLOCK.DIRT), 50);
  assert.equal(inv.damageItem(2, 1561), true);
  assert.equal(inv.get(2), null);
  const round = Inventory.deserialize(JSON.parse(JSON.stringify(inv.serialize())));
  assert.equal(round.count(BLOCK.DIRT), 50);
});

test('frustum culls boxes behind the camera', () => {
  const proj = mat4Perspective(mat4Create(), Math.PI / 2, 1, 0.1, 100);
  const view = mat4ViewRotation(mat4Create(), 0, 0); // looking -Z
  const vp = mat4Multiply(mat4Create(), proj, view);
  const f = new Frustum().setFromMatrix(vp);
  assert.equal(f.intersectsAABB(-1, -1, -11, 1, 1, -9), true);
  assert.equal(f.intersectsAABB(-1, -1, 9, 1, 1, 11), false);
  const v = lookVector(Math.PI / 2, 0);
  assert.ok(Math.abs(v[0] + 1) < 1e-9); // yaw +90° looks west (-X)
});
