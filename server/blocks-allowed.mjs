// Block ids a player may set with an edit message: every block except the states only the simulation
// creates (flowing / falling liquids, lit furnaces, grown wheat, moist farmland) and bedrock. Operators may
// set any block (their client runs /setblock-like tools through commands anyway).
import { BLOCKS, BLOCK, IS_LIQUID } from '../src/world/registry.js';

const DENY = /^(water_flowing_\d|water_falling|lava_flowing_\d|lava_falling|lit_furnace.*|wheat_[1-7]|farmland_moist|bedrock)$/;

export const VALID_BLOCK_IDS = new Uint8Array(256);
for (const b of BLOCKS) if (b && !DENY.test(b.name)) VALID_BLOCK_IDS[b.id] = 1;

export { BLOCKS, BLOCK, IS_LIQUID };
