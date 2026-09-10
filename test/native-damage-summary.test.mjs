import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeNativeDamage } from '../scripts/render-pilot/native-damage-summary.mjs';
import { DiagnosticCdp } from '../scripts/render-pilot/diagnostic-cdp.mjs';

const draw = (rect = '32,239 24x24') => ({ name: 'DirectRenderer::DrawFrame ProcessForOverlays',
  ts: 100, args: { root_damage_rect: rect, privateData: 'must not escape' } });
const swap = { name: 'NativeViewGLSurfaceEGL:RealSwapBuffers', ts: 200, args: { width: 1280, height: 720 } };

test('extracts only bounded geometry; never invents causal frame mapping', () => {
  const summary = summarizeNativeDamage([swap, draw(), { name: 'private layer snapshot', args: { secret: 1 } }]);
  assert.equal(summary.rootDamage[0].pixels, 576);
  assert.equal(summary.fullSurfacePixels, 921600);
  assert.equal(summary.eglSwaps.length, 1);
  assert(!JSON.stringify(summary).includes('private'));
  assert.match(summary.scope, /no causal frame join/);
});

test('fails on missing, malformed, out-of-bounds or truncated trace evidence', () => {
  for (const events of [[], [draw()], [swap], [draw('unknown'), swap], [draw('0,0 1281x720'), swap],
    [draw('-1,0 24x24'), swap], [draw(), { ...swap, ts: NaN }],
    [draw(), { ...swap, args: { width: 640, height: 480 } }],
    [...Array.from({ length: 129 }, () => draw()), swap], Array(200001).fill(null)]) {
    assert.throws(() => summarizeNativeDamage(events));
  }
});

test('supports native damaged swaps without requiring ordinary full swaps', () => {
  const result = summarizeNativeDamage([draw(), { name: 'egl::Surface::swapWithDamage' }]);
  assert.equal(result.eglSwaps.length, 0);
  assert.equal(result.counts['egl::Surface::swapWithDamage'], 1);
});

const damageSwap = (args = {}, ts = 300) => ({ name: 'NativeViewGLSurfaceEGL:SurfaceDamageSwap',
  ts, args: { x: 32, y: 457, width: 24, height: 24, ...args } });

test('reports patched KHR rectangles separately with explicit coordinate origin and no success claim', () => {
  const result = summarizeNativeDamage([damageSwap({ privateData: 'secret' }), draw(), swap,
    damageSwap({ y: 0 }, 250), { name: 'egl::Surface::swapWithDamage' }]);
  assert.deepEqual(result.eglDamageSwaps, [
    { timestampUs: 250, x: 32, y: 0, width: 24, height: 24, pixels: 576, origin: 'bottom-left', topLeftY: 696 },
    { timestampUs: 300, x: 32, y: 457, width: 24, height: 24, pixels: 576, origin: 'bottom-left', topLeftY: 239 }
  ]);
  assert.equal(result.eglSwaps.length, 1);
  assert.equal(result.counts['NativeViewGLSurfaceEGL:SurfaceDamageSwap'], 2);
  assert(!JSON.stringify(result).includes('secret'));
  assert.match(result.scope, /no causal frame join, successful-presentation proof/);
  const selectiveOnly = summarizeNativeDamage([draw(), damageSwap()]);
  assert.equal(selectiveOnly.eglSwaps.length, 0);
  assert.equal(selectiveOnly.eglDamageSwaps.length, 1);
});

test('rejects malformed, empty, overflowing or excessive KHR geometry rather than inventing savings', () => {
  for (const args of [{ x: -1 }, { x: 1280 }, { y: 720 }, { width: 0 }, { height: 0 },
    { width: 1281 }, { height: 721 }, { x: Number.MAX_SAFE_INTEGER }, { width: Infinity },
    { x: 1.5 }, { y: '2' }, { height: undefined }]) {
    assert.throws(() => summarizeNativeDamage([draw(), damageSwap(args)]));
  }
  assert.throws(() => summarizeNativeDamage([draw(), damageSwap({}, NaN)]));
  assert.throws(() => summarizeNativeDamage([draw(), ...Array.from({ length: 129 }, () => damageSwap())]));
});

class Socket extends EventTarget {
  messages = [];
  closed = false;
  send(text) { this.messages.push(JSON.parse(text)); }
  close() { this.closed = true; this.dispatchEvent(new Event('close')); }
  receive(data) { this.dispatchEvent(new MessageEvent('message', { data })); }
}

test('diagnostic CDP rejects malformed messages and pending calls without leaking timers', async () => {
  const socket = new Socket(), cdp = new DiagnosticCdp(socket);
  const pending = cdp.call('test');
  socket.receive('not-json');
  await assert.rejects(pending);
  await assert.rejects(cdp.call('test'));
  assert(socket.closed);
  assert.equal(socket.messages.length, 1);
});

test('diagnostic listener bounds fail closed and socket close rejects pending work', async () => {
  for (const fail of ['listener', 'close', 'oversize', 'send']) {
    const socket = new Socket(), cdp = new DiagnosticCdp(socket);
    cdp.on('test-event', () => { throw new Error('bound'); });
    if (fail === 'send') socket.send = () => { throw new Error('send failed'); };
    const pending = cdp.call('test');
    if (fail === 'listener') socket.receive(JSON.stringify({ method: 'test-event' }));
    if (fail === 'close') socket.close();
    if (fail === 'oversize') socket.receive('x'.repeat(2 * 1024 * 1024 + 1));
    await assert.rejects(pending);
    assert(socket.closed);
  }
});

test('diagnostic request bound, success and protocol rejection', async () => {
  const socket = new Socket(), cdp = new DiagnosticCdp(socket);
  const calls = Array.from({ length: 8 }, () => cdp.call('test'));
  assert.throws(() => cdp.call('overflow'), /request bound/);
  for (const [i, message] of socket.messages.entries()) socket.receive(JSON.stringify({ id: message.id, result: i }));
  assert.deepEqual(await Promise.all(calls), [0, 1, 2, 3, 4, 5, 6, 7]);
  const rejected = cdp.call('reject');
  socket.receive(JSON.stringify({ id: 9, error: { message: 'private browser data' } }));
  await assert.rejects(rejected, { message: 'Diagnostic CDP rejected operation' });
  cdp.close();
  assert(!socket.messages.some(message => message.method === 'Browser.close'));
});
