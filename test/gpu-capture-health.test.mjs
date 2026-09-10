import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { GpuCaptureHealth } from '../server/gpu-capture-health.mjs';

const metadata = () => ({ isSocket: () => true, uid: 10000, mode: 0o600 });
class Socket extends EventEmitter {
  destroyed = false;
  destroy() { this.destroyed = true; }
}
function fixture(chunks, event = 'end', info = metadata()) {
  const socket = new Socket();
  const health = new GpuCaptureHealth(({ path }) => {
    assert.equal(path, '/tmp/.X11-unix/bpane-gpu-health.sock');
    queueMicrotask(() => {
      for (const chunk of chunks) socket.emit('data', Buffer.from(chunk));
      if (event) socket.emit(event);
    });
    return socket;
  }, async () => info);
  return { socket, health };
}
test('GPU supervisor reply accepts stream fragmentation and releases connection', async () => {
  const { socket, health } = fixture(['BP', 'H1 ', 'OK\n']);
  await health.check(); assert.equal(socket.destroyed, true);
});
test('failed, truncated, oversized and closed supervisor replies fail readiness', async () => {
  for (const [chunks, event] of [[['BPH1 NO\n'], 'end'], [['BPH1 O'], 'end'],
    [['BPH1 OK\nextra'], 'end'], [[], 'error']]) {
    const { socket, health } = fixture(chunks, event);
    await assert.rejects(health.check()); assert.equal(socket.destroyed, true);
  }
});
test('a silent health peer times out without holding a connection forever', async () => {
  const { socket, health } = fixture([], null);
  await assert.rejects(health.check(), /TIMEOUT/); assert.equal(socket.destroyed, true);
});
test('health refuses foreign ownership, public modes, regular files and symlinks', async () => {
  for (const info of [{ ...metadata(), uid: 0 }, { ...metadata(), mode: 0o666 },
    { ...metadata(), isSocket: () => false }]) {
    await assert.rejects(fixture([], 'end', info).health.check(), /SOCKET_INVALID/);
  }
});
test('capture health is opt-in and ordinary supervisor restart remains enabled', () => {
  for (const file of ['server/main.mjs', 'server/check-gpu.mjs']) {
    assert.match(readFileSync(file, 'utf8'), /process.env.BPANE_GPU_TAIL === '1'/);
  }
  assert.match(readFileSync('Dockerfile.gpu-dummy', 'utf8'), /CMD bpane-vulkan-probe --health/);
  assert.match(readFileSync('runtime/watch-gpu.sh', 'utf8'), /failures.*-lt 3.*exit 1/);
});
