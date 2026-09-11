import test from 'node:test';
import assert from 'node:assert/strict';
import { upscaleFixture } from './helpers/smart-upscale-fixture.mjs';

test('original default allocates no GPU/overlay; enable is local, disable is immediate', async t => {
  const f = upscaleFixture(t);
  await f.step();
  assert.equal(f.creations.length, 0); assert.equal(f.overlay(), null);
  assert.equal(f.source.dataset.bpaneEnhancement, undefined);
  f.select('smart'); await f.step(); await f.step(61);
  assert.equal(f.creations.length, 1); assert.equal(f.renders.length, 2);
  assert(f.bitmaps.every(bitmap => bitmap.closed === 1));
  assert.equal(f.overlay().width, 512);
  assert.equal(f.source.width, 256); assert.equal(f.source.height, 128);
  f.select('original');
  assert.equal(f.overlay(), null); assert.equal(f.source.dataset.bpaneEnhancement, undefined);
  assert.equal(f.creations[0].renderer.destroyCalls, 1);
  await f.step(); assert.equal(f.frames.size, 0); assert.equal(f.timers.size, 0);
});

for (const [name, options, message] of [
  ['WebGPU absent', { gpu: false }, /WebGPU/], ['insecure origin', { secure: false }, /HTTPS/],
  ['Canvas2D fallback', { renderer: 'canvas2d' }, /WebGL/], ['native-density display', { dpr: 1 }, /native pixel density/],
]) test(`${name} keeps original pixels without initializing the model`, async t => {
  const f = upscaleFixture(t, options); f.select('smart'); await f.step();
  assert.equal(f.creations.length, 0); assert.equal(f.overlay(), null); assert.match(f.status.textContent, message);
});

test('denied local storage is not fatal and invalid preferences cannot enable inference', async t => {
  const f = upscaleFixture(t, { storage: { getItem() { throw Error('denied'); }, setItem() { throw Error('denied'); } } });
  await f.step(); assert.equal(f.creations.length, 0);
  f.select('smart'); await f.step(); assert(f.overlay());
  f.select('invalid'); await f.step(); assert.equal(f.overlay(), null);
});

test('repeated refresh does not initialize twice; a late canceled model is destroyed', async t => {
  let resolve;
  const f = upscaleFixture(t, { create: renderer => new Promise(done => { resolve = () => done(renderer); }) });
  f.select('smart'); await f.step();
  f.controller.refresh(); await f.step(); assert.equal(f.creations.length, 1);
  f.select('original'); assert(f.creations[0].signal.aborted);
  resolve(); await f.step();
  assert.equal(f.overlay(), null); assert.equal(f.creations[0].renderer.destroyCalls, 1);
});

test('initialization deadline aborts ownership and a late result cannot resurrect the overlay', async t => {
  let resolve;
  const f = upscaleFixture(t, { create: renderer => new Promise(done => { resolve = () => done(renderer); }) });
  f.select('smart'); await f.step(); await f.step(10001);
  assert(f.creations[0].signal.aborted); assert.match(f.status.textContent, /timed out/);
  resolve(); await f.step(); assert.equal(f.overlay(), null); assert.equal(f.creations[0].renderer.destroyCalls, 1);
});

test('visibility, resize and reconnect dispose old presentation resources', async t => {
  const f = upscaleFixture(t); f.select('smart'); await f.step();
  const first = f.overlay();
  f.resize(300, 140); await f.step();
  assert.notEqual(f.overlay(), first); assert.equal(first.width, 1);
  assert.equal(f.creations[0].renderer.destroyCalls, 1); assert.equal(f.overlay().width, 600);
  f.hide(true); assert.equal(f.overlay(), null);
  await f.step(); assert.match(f.status.textContent, /hidden/);
  f.hide(false); await f.step(); assert(f.overlay());
  f.controller.attach(null); assert.equal(f.overlay(), null);
  f.controller.attach(f.source); await f.step(); assert(f.overlay());
});

test('device failure removes enhancement and does not auto-retry until user opts in again', async t => {
  const f = upscaleFixture(t); f.select('smart'); await f.step();
  f.losses[0]('Client GPU lost'); assert.equal(f.overlay(), null);
  f.controller.refresh(); await f.step(100); assert.equal(f.creations.length, 1);
  assert.match(f.status.textContent, /GPU lost/);
  f.select('smart'); await f.step(); assert.equal(f.creations.length, 2);
});

test('oversized captures fall back and moving to native density releases the overlay', async t => {
  const f = upscaleFixture(t); f.select('smart'); await f.step();
  f.resize(3840, 2160); await f.step(); assert.equal(f.overlay(), null); assert.match(f.status.textContent, /Full HD/);
  f.resize(256, 128); await f.step(); assert(f.overlay());
  f.window.devicePixelRatio = 1; f.controller.refresh(); await f.step();
  assert.equal(f.overlay(), null); assert.match(f.status.textContent, /native pixel density/);
});

test('Quality replaces Balanced, clears the overlay and never reads enhanced pixels', async t => {
  const f = upscaleFixture(t); f.select('smart'); await f.step(); await f.step(61);
  const old = f.overlay();
  f.select('smart-quality');
  assert.equal(f.overlay(), null); assert.equal(f.controller.diagnostics().stats, undefined);
  assert.equal(f.creations[0].renderer.destroyCalls, 1);
  await f.step(); await f.step(61);
  assert.notEqual(f.overlay(), old);
  assert.deepEqual(f.creations.map(item => item.mode), ['balanced', 'quality']);
  assert(f.renders.every(item => item.canvas === f.source));
  assert.equal(f.controller.diagnostics().mode, 'quality'); assert.match(f.status.textContent, /Quality/);
  assert.equal(f.window.localStorage.getItem('browserpane.enhancement.v1'), 'smart-quality');
  f.select('smart'); await f.step();
  assert.equal(f.creations[1].renderer.destroyCalls, 1);
  assert.equal(f.controller.diagnostics().mode, 'balanced');
});

for (const [stored, expected] of [['smart', 'balanced'], ['smart-quality', 'quality'], ['unknown', 'original']]) {
  test(`stored preference ${stored} restores ${expected} without changing legacy preferences`, async t => {
    const f = upscaleFixture(t, { storage: { getItem: () => stored } }); await f.step();
    assert.equal(f.controller.diagnostics().mode, expected);
    assert.equal(f.creations.length, expected === 'original' ? 0 : 1);
    if (expected !== 'original') assert.equal(f.creations[0].mode, expected);
  });
}

test('switching models during initialization aborts the previous model and ignores its errors', async t => {
  const waiting = [];
  const f = upscaleFixture(t, { create: renderer => new Promise(resolve => waiting.push(() => resolve(renderer))) });
  f.select('smart'); await f.step();
  f.select('smart-quality'); await f.step();
  assert(f.creations[0].signal.aborted);
  waiting[1](); await f.step(); const overlay = f.overlay(); assert(overlay);
  waiting[0](); await f.step();
  f.losses[0]('Old model error'); await f.step();
  assert.equal(f.overlay(), overlay); assert.match(f.status.textContent, /Quality/);
  assert.equal(f.creations[0].renderer.destroyCalls, 1);
  assert.equal(f.creations[1].renderer.destroyCalls, 0);
});

test('switching models fences old in-flight pixels and Quality retains video bypass', async t => {
  const waiting = [];
  const f = upscaleFixture(t, { render: bitmap => new Promise(resolve => waiting.push(() => resolve(bitmap()))) });
  f.select('smart'); await f.step(); await f.step(61);
  const oldContext = f.contexts.get(f.overlay());
  f.select('smart-quality'); await f.step();
  waiting.shift()(); await f.step();
  assert.equal(oldContext.draws.length, 0); assert.equal(f.bitmaps[0].closed, 1);
  const context = f.contexts.get(f.overlay()); const clears = context.clears.length;
  f.damage('video'); assert.equal(context.clears.length, clears + 1);
  await f.step(749); assert.equal(waiting.length, 0);
  await f.step(1); assert.equal(waiting.length, 1);
  f.select('original'); waiting.shift()(); await f.step();
  assert.equal(context.draws.length, 0); assert.equal(f.overlay(), null);
});
