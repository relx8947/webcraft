// worker_threads entry of the dedicated server: runs the browser's world worker protocol
// (src/world/worker.js handleMessage: generate / light jobs) behind a MessagePort.
import { parentPort } from 'node:worker_threads';
import { handleMessage } from '../src/world/worker.js';

parentPort.on('message', (msg) => {
  const reply = handleMessage(msg);
  if (reply) parentPort.postMessage(reply.message, reply.transfer);
});
