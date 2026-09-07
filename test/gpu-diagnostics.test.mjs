import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { GpuStatus } from '../server/gpu-status.mjs';
import { GpuStatusError } from '../server/gpu-status-error.mjs';

const good = () => ({ auxAttributes: { glRenderer: 'V3D', sandboxed: true, processCrashCount: 0 },
  featureStatus: { gpu_compositing: 'enabled', rasterization: 'enabled' } });
const metadata = async () => ({ ok: true, json: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/test' }) });

test('GPU readiness classifies fallback, crash and sandbox independently without raw data', () => {
  for (const [change, code] of [
    [gpu => { gpu.auxAttributes.glRenderer = 'SECRET software'; }, 'GPU_RENDERER_MISMATCH'],
    [gpu => { gpu.auxAttributes.sandboxed = false; }, 'GPU_SANDBOX_INACTIVE'],
    [gpu => { gpu.auxAttributes.processCrashCount = 2; }, 'GPU_PROCESS_CRASHED'],
    [gpu => { gpu.featureStatus.rasterization = 'disabled'; }, 'GPU_RASTERIZATION_DISABLED'],
    [gpu => { gpu.featureStatus.gpu_compositing = 'disabled'; }, 'GPU_COMPOSITING_DISABLED'],
  ]) {
    const gpu = good(); change(gpu);
    assert.throws(() => GpuStatus.validate(gpu), { code, message: code });
  }
  assert.equal(GpuStatusError.code(new Error('SECRET')), 'GPU_CHECK_FAILED');
  assert.equal(GpuStatusError.code({ code: 'SECRET' }), 'GPU_CHECK_FAILED');
});

test('HTTP timeout and metadata/network failure have distinct bounded codes', async () => {
  for (const [fetch, code] of [
    [async () => { throw Object.assign(new Error('SECRET'), { name: 'TimeoutError' }); }, 'GPU_CDP_HTTP_TIMEOUT'],
    [async () => { throw new Error('SECRET'); }, 'GPU_CDP_HTTP_UNAVAILABLE'],
    [async () => ({ ok: false }), 'GPU_CDP_HTTP_STATUS'],
    [async () => ({ ok: true, json: async () => { throw new Error('SECRET'); } }), 'GPU_CDP_METADATA_INVALID'],
  ]) await assert.rejects(new GpuStatus(fetch, null).check(), { code, message: code });
});

test('CDP query timeout is not classified as a GPU crash and closes its socket', async () => {
  const calls = [];
  class Socket extends EventEmitter {
    close() { calls.push('close'); this.emit('close'); }
    terminate() { calls.push('terminate'); }
  }
  const timers = { setTimeout: (callback, ms) => { assert.equal(ms, 2500); queueMicrotask(callback); return 1; },
    clearTimeout: id => { assert.equal(id, 1); calls.push('clear'); } };
  await assert.rejects(new GpuStatus(metadata, Socket, timers).check(), { code: 'GPU_CDP_QUERY_TIMEOUT' });
  assert.deepEqual(calls, ['clear', 'close', 'terminate']);
});

test('CDP rejection and malformed replies preserve distinct reasons and omit server messages', async () => {
  for (const [raw, code] of [['not JSON SECRET', 'GPU_CDP_RESPONSE_INVALID'],
    [JSON.stringify({ id: 1, error: { message: 'SECRET' } }), 'GPU_CDP_QUERY_REJECTED']]) {
    class Socket extends EventEmitter {
      constructor() { super(); queueMicrotask(() => this.emit('open')); }
      send() { queueMicrotask(() => this.emit('message', raw)); }
      close() { this.emit('close'); }
    }
    await assert.rejects(new GpuStatus(metadata, Socket).check(), { code, message: code });
  }
});
