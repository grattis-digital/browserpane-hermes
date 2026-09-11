import test from 'node:test';
import assert from 'node:assert/strict';
import { upscaleFixture } from './helpers/smart-upscale-fixture.mjs';

test('a new tile synchronously clears its halo consumers and fences an in-flight result', async t => {
  const waiting = [];
  const f = upscaleFixture(t, { render: bitmap => new Promise(resolve => waiting.push(() => resolve(bitmap()))) });
  f.select('smart'); await f.step();
  const context = f.contexts.get(f.overlay());
  await f.step(61); assert.equal(f.renders.length, 1);
  const clears = context.clears.length;
  f.damage('tile', { x: 128, y: 1, w: 1, h: 1 });
  assert.equal(context.clears.length, clears + 1);
  assert.equal(context.clears.at(-1)[0], 0); // Neighbor needs the changed halo pixel.
  waiting.shift()(); await f.step();
  assert.equal(context.draws.length, 0); assert.equal(f.controller.diagnostics().stats.stale, 1);
  assert.equal(f.bitmaps[0].closed, 1);
  await f.step(61); assert.equal(f.renders.length, 2); // Latest state only, one job at a time.
  f.select('original'); waiting.shift()(); await f.step();
  assert.equal(context.draws.length, 0); assert.equal(f.bitmaps[1].closed, 1);
});

test('scroll and video bypass immediately and only settled content is re-enhanced', async t => {
  const f = upscaleFixture(t); f.select('smart'); await f.step(); await f.step(61);
  const context = f.contexts.get(f.overlay());
  assert.equal(f.renders.length, 2);
  f.damage('scroll', { x: 0, y: 13, w: 256, h: 100 });
  assert(context.clears.length >= 2);
  await f.step(119); assert.equal(f.renders.length, 2);
  await f.step(1); assert.equal(f.renders.length, 4);
  f.damage('video'); await f.step(749); assert.equal(f.renders.length, 4);
  f.damage('video'); await f.step(749); assert.equal(f.renders.length, 4);
  await f.step(1); assert.equal(f.renders.length, 6);
});

test('a stuck GPU cannot block raw view, accumulate jobs or survive the watchdog', async t => {
  const f = upscaleFixture(t, { render: () => new Promise(() => {}) });
  f.select('smart'); await f.step(); await f.step(61);
  for (let count = 0; count < 1000; count++) f.damage();
  assert.equal(f.renders.length, 1); assert.equal(f.controller.diagnostics().stats.pending, 2);
  await f.step(1501);
  assert.equal(f.overlay(), null); assert.equal(f.creations[0].renderer.destroyCalls, 1);
  assert.match(f.status.textContent, /timed out/); assert.equal(f.source.width, 256);
});

for (const preference of ['smart', 'smart-quality']) test(`${preference}: sustained slow patches trigger budget fallback after warm-up`, async t => {
  const waiting = [];
  const f = upscaleFixture(t, { render: bitmap => new Promise(resolve => waiting.push(() => resolve(bitmap()))) });
  f.resize(768, 128); f.select(preference); await f.step(); await f.step(61);
  for (let count = 0; count < 6; count++) {
    assert.equal(waiting.length, 1);
    await f.step(25); waiting.shift()(); await f.step();
  }
  assert.equal(f.overlay(), null); assert.match(f.status.textContent, /budget exceeded/);
  assert(f.bitmaps.every(bitmap => bitmap.closed === 1));
});
