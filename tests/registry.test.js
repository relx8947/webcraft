import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as R from '../src/world/registry.js';

test('registry basics', () => {
  assert.equal(R.BLOCK.AIR, 0);
  assert.equal(R.BLOCKS.length, R.BLOCK_COUNT);
  assert.ok(R.TEXTURE_LAYER_COUNT <= 256);
  for (const b of R.BLOCKS) {
    if (b.id === 0) continue;
    for (const l of b.faceLayers) assert.ok(Number.isInteger(l) && l >= 0 && l < R.TEXTURE_LAYER_COUNT, b.name);
  }
});

test('break times match Minecraft', () => {
  assert.equal(R.getBreakTime(R.BLOCK.STONE, 0), 7.5);
  assert.equal(R.getBreakTime(R.BLOCK.STONE, R.ITEM.WOODEN_PICKAXE), 1.15);
  assert.equal(R.getBreakTime(R.BLOCK.DIRT, 0), 0.75);
  assert.equal(R.getBreakTime(R.BLOCK.BEDROCK, 0), Infinity);
  assert.equal(R.getBreakTime(R.BLOCK.TORCH, 0), 0);
});

test('drops and variants', () => {
  assert.deepEqual(R.getDrops(R.BLOCK.STONE, 0), []);
  assert.deepEqual(R.getDrops(R.BLOCK.STONE, R.ITEM.STONE_PICKAXE), [{ id: R.BLOCK.COBBLESTONE, count: 1 }]);
  assert.equal(R.itemForBlock(R.BLOCK.OAK_LOG_X), R.BLOCK.OAK_LOG);
  assert.equal(R.getPlacementBlock(R.ITEM.OAK_LOG, 0, 0), R.BLOCK.OAK_LOG_X);
  assert.equal(R.getPlacementBlock(R.ITEM.OAK_LOG, 2, 0), R.BLOCK.OAK_LOG);
});
