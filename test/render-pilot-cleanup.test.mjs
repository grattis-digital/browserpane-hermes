import assert from 'node:assert/strict';
import test from 'node:test';
import { RenderPilotCleanup } from '../scripts/render-pilot/cleanup.mjs';

test('remote completion and owner exit precede potentially slow local browser shutdown', async () => {
  const order = [];
  const result = await RenderPilotCleanup.run({ call: async op => { order.push(op); return { cleaned: true }; },
    close: async () => { order.push('owner-exit'); return { code: 0 }; } },
  { close: async () => { order.push('viewer-close'); } });
  assert.deepEqual(order, ['finish', 'owner-exit', 'viewer-close']);
  assert(result.ok);
});

test('each cleanup boundary still runs after errors and every error makes the run fail', async () => {
  const order = [];
  const result = await RenderPilotCleanup.run({ call: async () => { order.push('finish'); throw Error('finish failure'); },
    close: async () => { order.push('exit'); throw Error('exit failure'); } },
  { close: async () => { order.push('viewer'); throw Error('viewer failure'); } });
  assert.deepEqual(order, ['finish', 'exit', 'viewer']);
  assert(!result.ok); assert.equal(result.cleanupError, 'finish failure');
  assert.equal(result.ownerExitError, 'exit failure'); assert.equal(result.viewerCleanupError, 'viewer failure');
});
