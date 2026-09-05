import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { ViewerInputProbe } from '../scripts/viewer-input-probe.mjs';

function environment() {
  let now = 0, id = 0;
  const timers = new Map(), sent = [], forwarded = [];
  const original = function (...args) { forwarded.push({ receiver: this, args }); return 'original-result'; };
  const runtime = Object.create({ handle: original });
  const session = { connected: true, controlRuntime: runtime, sendFrame(channel, payload) { sent.push({ channel, payload }); } };
  const window = { browserpaneSession: session, __pipelineFixtureToken: 'owned',
    __pipelineInputWitness: { clicks: 0, last: null }, scrollX: 0, scrollY: 0 };
  const context = { window, document: { hasFocus: () => true }, Uint8Array, Uint32Array, DataView,
    crypto: { getRandomValues(array) { array.set([0x12345678, 0x11223344, 0x55667788]); return array; } },
    performance: { now: () => now },
    setTimeout: (fn, delay) => { timers.set(++id, { fn, at: now + delay }); return id; },
    setInterval: (fn, delay) => { timers.set(++id, { fn, at: now + delay, repeat: delay }); return id; },
    clearTimeout: timer => timers.delete(timer), clearInterval: timer => timers.delete(timer) };
  return { window, context, timers, sent, forwarded, original, runtime, session,
    invoke: (method, argument) => runInNewContext(`(${method.toString()})(argument)`, { ...context, argument }),
    tick(ms) {
      const end = now + ms;
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [key, timer] = next; now = timer.at;
        if (timer.repeat) timer.at += timer.repeat; else timers.delete(key);
        timer.fn();
      }
      now = end;
    },
    clean(expected = original) { assert.equal(runtime.handle, expected); assert.equal(Object.hasOwn(runtime, 'handle'), false);
      assert.equal(Object.hasOwn(runtime, '__bpaneTestInputBarrier'), false); assert.equal(timers.size, 0); },
  };
}

test('input barrier sends exact Ping bytes and accepts only its complete matching Pong', async () => {
  const env = environment(), promise = env.invoke(ViewerInputProbe.flushHostInput, {});
  assert.equal(env.sent.length, 1); assert.equal(env.sent[0].channel, 0x0a);
  assert.deepEqual([...env.sent[0].payload], [4, 0x78, 0x56, 0x34, 0x92, 0x44, 0x33, 0x22, 0x11, 0x88, 0x77, 0x66, 0x55]);
  const pong = env.sent[0].payload.slice(); pong[0] = 5;
  const wrongSeq = pong.slice(); wrongSeq[1] ^= 1;
  const wrongTime = pong.slice(); wrongTime[12] ^= 1;
  const longer = new Uint8Array(14); longer.set(pong);
  for (const payload of [new Uint8Array(), pong.slice(0, 12), longer, wrongSeq, wrongTime, env.sent[0].payload]) {
    assert.equal(env.runtime.handle(payload, 'extra'), 'original-result');
  }
  assert.equal(env.timers.size, 2);
  assert(env.forwarded.every(call => call.receiver === env.runtime && call.args[1] === 'extra'));
  env.tick(73); assert.equal(env.runtime.handle(pong), 'original-result');
  const result = await promise;
  assert.equal(result.seq, 0x92345678); assert.equal(result.elapsedMs, 73);
  assert.equal(env.forwarded.length, 7); env.clean();
});

test('input barrier restores an existing own handler descriptor, including synchronous replies', async () => {
  const env = environment();
  Object.defineProperty(env.runtime, 'handle', { value: env.original, writable: false, configurable: true });
  const before = Object.getOwnPropertyDescriptor(env.runtime, 'handle');
  env.session.sendFrame = (_channel, ping) => { const pong = ping.slice(); pong[0] = 5; env.runtime.handle(pong); };
  await env.invoke(ViewerInputProbe.flushHostInput, {});
  assert.deepEqual(Object.getOwnPropertyDescriptor(env.runtime, 'handle'), before);
  assert.equal(env.timers.size, 0); assert.equal(Object.hasOwn(env.runtime, '__bpaneTestInputBarrier'), false);
});

for (const failure of ['timeout', 'send-error', 'replacement', 'disconnect', 'handler-error']) {
  test(`input barrier always restores its observer on ${failure}`, async () => {
    const env = environment();
    if (failure === 'send-error') env.session.sendFrame = () => { throw new Error('Send failed'); };
    if (failure === 'handler-error') Object.getPrototypeOf(env.runtime).handle = env.original = () => { throw new Error('Handler failed'); };
    const promise = env.invoke(ViewerInputProbe.flushHostInput, {});
    const rejected = assert.rejects(promise, /timed out|Send failed|session changed|Handler failed/);
    if (failure === 'timeout') env.tick(8000);
    if (failure === 'replacement') { env.window.browserpaneSession = {}; env.tick(25); }
    if (failure === 'disconnect') { env.session.connected = false; env.tick(25); }
    if (failure === 'handler-error') assert.throws(() => env.runtime.handle(new Uint8Array([2])), /Handler failed/);
    await rejected; env.clean(env.original);
  });
}

test('concurrent probes are rejected and an unrelated replacement handler is never overwritten', async () => {
  const env = environment(), promise = env.invoke(ViewerInputProbe.flushHostInput, {});
  assert.throws(() => env.invoke(ViewerInputProbe.flushHostInput, {}), /already active/);
  const next = () => {}; env.runtime.handle = next;
  const rejected = assert.rejects(promise, /observer replaced/); env.tick(25); await rejected;
  assert.equal(env.runtime.handle, next); assert.equal(env.timers.size, 0);
  assert.equal(Object.hasOwn(env.runtime, '__bpaneTestInputBarrier'), false);
});

test('click readiness observes exactly one trusted focused click without generating input', async () => {
  const env = environment(); let focused = false; env.context.document.hasFocus = () => focused;
  const promise = env.invoke(ViewerInputProbe.waitForClick, 'owned');
  env.tick(25); assert.equal(env.timers.size, 2);
  env.window.__pipelineInputWitness = { clicks: 1, last: { isTrusted: true, button: 0, clientX: 50, clientY: 60 } };
  env.tick(25); assert.equal(env.timers.size, 2);
  focused = true; env.tick(25);
  const result = await promise;
  assert.equal(result.clicks, 1); assert.equal(result.focused, true); assert.equal(result.elapsedMs, 75);
  assert.equal(env.sent.length, 0); assert.equal(env.timers.size, 0);
});

for (const failure of ['no-click', 'no-focus', 'untrusted', 'wrong-button', 'repeat', 'scroll', 'ownership', 'missing']) {
  test(`click readiness fails closed and clears its timers on ${failure}`, async () => {
    const env = environment();
    env.window.__pipelineInputWitness = { clicks: 1, last: { isTrusted: true, button: 0, clientX: 50, clientY: 60 } };
    if (failure === 'no-click') env.window.__pipelineInputWitness.clicks = 0;
    if (failure === 'no-focus') env.context.document.hasFocus = () => false;
    if (failure === 'untrusted') env.window.__pipelineInputWitness.last.isTrusted = false;
    if (failure === 'wrong-button') env.window.__pipelineInputWitness.last.button = 2;
    if (failure === 'repeat') env.window.__pipelineInputWitness.clicks = 2;
    if (failure === 'scroll') env.window.scrollY = 1;
    if (failure === 'ownership') env.window.__pipelineFixtureToken = 'another';
    if (failure === 'missing') delete env.window.__pipelineInputWitness;
    const rejected = assert.rejects(env.invoke(ViewerInputProbe.waitForClick, 'owned'), /timed out|trusted primary|exactly one|changed document scroll|Unowned|witness/);
    env.tick(8000); await rejected; assert.equal(env.timers.size, 0); assert.equal(env.sent.length, 0);
  });
}
