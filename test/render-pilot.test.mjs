import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { PixelWaiter } from '../scripts/render-pilot/pixel-waiter.mjs';
import { RenderOracle } from '../scripts/render-pilot/oracle.mjs';
import { RenderRpc } from '../scripts/render-pilot/rpc.mjs';

class PixelFixture {
  constructor() {
    this.time = 0; this.batches = 1; this.rgb = [0, 0, 0]; this.frames = new Map(); this.timers = new Map(); this.listeners = new Map(); this.id = 0;
    const context = { getImageData: () => ({ data: [...this.rgb, 255] }) };
    this.canvas = { width: 1280, height: 720, getContext: () => context };
    this.session = { connected: true, getRenderDiagnostics: () => ({ backend: 'canvas2d' }),
      getTileCacheStats: () => ({ batchesQueued: this.batches }) };
    this.sandbox = { window: { browserpaneSession: this.session }, document: {
      visibilityState: 'visible', querySelector: () => this.canvas,
      addEventListener: (name, listener) => this.listeners.set(name, listener),
      removeEventListener: name => this.listeners.delete(name),
    }, performance: { now: () => this.time }, Uint8Array,
    requestAnimationFrame: fn => { const id = ++this.id; this.frames.set(id, fn); return id; },
    cancelAnimationFrame: id => this.frames.delete(id),
    setTimeout: fn => { const id = ++this.id; this.timers.set(id, fn); return id; }, clearTimeout: id => this.timers.delete(id) };
    this.token = randomUUID();
    this.sandbox.args = { token: this.token, key: 'a', points: [{ x: 44, y: 200, rgb: [45, 71, 159] }], width: 1280, height: 720 };
  }
  arm() { return runInNewContext(`(${PixelWaiter.arm})(args)`, this.sandbox); }
  input(extra = {}) { this.listeners.get('keydown')({ key: 'a', repeat: false, isTrusted: true, ...extra }); }
  tick() { this.time += 16; const frames = [...this.frames.values()]; this.frames.clear(); frames.forEach(fn => fn()); }
  result() { return this.sandbox.window.__renderPixelWaiter.result; }
  clean() { assert.equal(this.frames.size, 0); assert.equal(this.listeners.size, 0); assert.equal(this.timers.size, 0); }
}

test('input pixel observer waits for async completion of the SAME queued batch', async () => {
  const fixture = new PixelFixture(); fixture.arm(); fixture.input();
  fixture.batches++; fixture.tick();
  assert(fixture.sandbox.window.__renderPixelWaiter.active);
  fixture.rgb = [45, 71, 159]; fixture.tick();
  const result = await fixture.result();
  assert(result.matched); assert.equal(result.latencyMs, 32); assert.equal(result.pixelReads, 2);
  fixture.clean();
});

test('observer does not read pixels before input and an actual incoming batch', async () => {
  const fixture = new PixelFixture(); fixture.arm(); fixture.rgb = [45, 71, 159]; fixture.tick();
  fixture.input(); fixture.tick(); assert.equal(fixture.sandbox.window.__renderPixelWaiter.reads, 0);
  fixture.batches++; fixture.tick(); assert((await fixture.result()).matched); fixture.clean();
});

test('wrong pixels time out and retain an explicit failed sample', async () => {
  const fixture = new PixelFixture(); fixture.arm(); fixture.input(); fixture.batches++; fixture.tick();
  [...fixture.timers.values()][0]();
  const result = await fixture.result(); assert.equal(result.reason, 'pixel-timeout'); assert.equal(result.latencyMs, null);
  fixture.clean();
});

test('session and geometry changes fail closed', async () => {
  for (const change of [f => { f.canvas.width = 800; }, f => { f.sandbox.window.browserpaneSession = {}; },
    f => { f.sandbox.document.visibilityState = 'hidden'; }]) {
    const fixture = new PixelFixture(); fixture.arm(); fixture.input(); change(fixture); fixture.tick();
    assert.equal((await fixture.result()).reason, 'session-or-geometry-changed'); fixture.clean();
  }
});

test('untrusted and repeated input cannot become successful latency samples', async () => {
  for (const event of [{ isTrusted: false }, { repeat: true }]) {
    const fixture = new PixelFixture(); fixture.arm(); fixture.input(event);
    assert.equal((await fixture.result()).reason, 'invalid-input'); fixture.clean();
  }
});

test('observer validates bounded work and forbids overlap', () => {
  const fixture = new PixelFixture(); fixture.arm(); assert.throws(() => fixture.arm(), /already active/);
  for (const args of [{ key: 'Enter' }, { points: [] }, { timeoutMs: 9000 }, { token: 'live' }]) {
    const invalid = new PixelFixture(); Object.assign(invalid.sandbox.args, args); assert.throws(() => invalid.arm());
  }
});

test('scroll oracle checks marker and both sides of a half-tile transition independently', () => {
  const fixture = { dpr: 1, left: 0, top: 90, marker: { x: 44, y: 198 } };
  const before = RenderOracle.points(fixture, 1, 0), after = RenderOracle.points(fixture, 2, 32);
  assert.notDeepEqual(before[0].rgb, after[0].rgb);
  assert.notDeepEqual(before[1].rgb, after[1].rgb);
  assert.notDeepEqual(before[2].rgb, after[2].rgb);
  assert.throws(() => RenderOracle.points({ ...fixture, dpr: 2 }, 1, 0));
});

test('resource accounting rejects rolled back network or CPU counters', () => {
  const before = { monotonic: 1, network: { udp: { ipBytes: 100, packets: 2 } },
    containers: { browser: { cpuUsec: 1000, throttledUsec: 0 } } };
  const after = { monotonic: 2, network: { udp: { ipBytes: 200, packets: 3 } },
    containers: { browser: { cpuUsec: 501000, throttledUsec: 0, memoryBytes: 1048576 } } };
  assert.equal(RenderOracle.delta(before, after).containers.browser.meanCpuCores, .5);
  after.network.udp.ipBytes = 0; assert.throws(() => RenderOracle.delta(before, after), /rollback/);
});

test('remote pilot refuses arbitrary shell destinations and staging paths before spawning', () => {
  assert.throws(() => RenderRpc.launch({ ssh: '-oProxyCommand=anything', remoteConfig: '/tmp/no.json' }));
  assert.throws(() => RenderRpc.launch({ ssh: 'operator@test.invalid', remoteConfig: '/tmp/foo;touch anything' }));
});

test('RPC treats an empty remote assertion message as failure, never readiness', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  const rpc = new RenderRpc(child);
  const rejected = assert.rejects(rpc.ready(), /without a message/);
  child.stdout.write(JSON.stringify({ id: 0, error: '' }) + '\n');
  await rejected;
  child.emit('close', 1, null);
  await assert.rejects(rpc.call('sample'), /without a message/);
  assert.equal((await rpc.close()).code, 1);
});

test('RPC serializes requests and rejects pending work on remote exit', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  const rpc = new RenderRpc(child);
  child.stdout.write(JSON.stringify({ id: 0, result: { ready: true } }) + '\n');
  assert((await rpc.ready()).ready);
  const rejected = assert.rejects(rpc.call('sample'), /Pilot exited/);
  await assert.rejects(rpc.call('sample'), /Concurrent/);
  child.emit('close', 1, null);
  await rejected; await rpc.close();
});

test('RPC retains watchdog failure sent with the previous request ID', async () => {
  for (const pending of [false, true]) {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    const rpc = new RenderRpc(child);
    child.stdout.write(JSON.stringify({ id: 0, result: { ready: true } }) + '\n');
    await rpc.ready();
    const rejected = pending ? assert.rejects(rpc.call('sample'), /watchdog root cause/) : null;
    child.stdout.write(JSON.stringify({ id: 0, error: 'watchdog root cause' }) + '\n');
    if (rejected) await rejected;
    await assert.rejects(rpc.call('sample'), /watchdog root cause/);
    child.emit('close', 0, null);
    await rpc.close();
  }
});
