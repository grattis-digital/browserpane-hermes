import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['client/enhancement/damage-grid.ts'], bundle: true,
  write: false, format: 'esm', platform: 'browser' });
const { DamageGrid, PATCH_SIZE, HALO, MAX_PIXELS } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

test('coalesces repeated damage with a fixed queue and no idle work', () => {
  const grid = new DamageGrid(1280, 720);
  assert.equal(grid.next(0), undefined);
  assert.equal(grid.delay(0), Infinity);
  for (let index = 0; index < 10000; index++) grid.invalidate({ x: 0, y: 0, w: 1280, h: 720 }, 'tile', 0);
  assert.equal(grid.pending(), 60);
  assert.equal(grid.next(59), undefined);
  const seen = new Set();
  for (let job; (job = grid.next(60));) { assert(!seen.has(job.index)); seen.add(job.index); }
  assert.equal(seen.size, 60);
  assert.equal(grid.pending(), 0);
});

test('neighbor-halo damage invalidates an in-flight result, including arbitrary pixel scroll', () => {
  const grid = new DamageGrid(300, 200);
  grid.invalidate({ x: 0, y: 0, w: 1, h: 1 }, 'tile', 0);
  const job = grid.next(60);
  assert(grid.isCurrent(job));
  const cleared = grid.invalidate({ x: 128, y: 0, w: 1, h: 1 }, 'tile', 65);
  assert.equal(cleared.x, 0);
  assert(!grid.isCurrent(job));
  assert.equal(grid.pending(), 2);
  grid.invalidate({ x: 0, y: 13, w: 300, h: 174 }, 'scroll', 100);
  assert.equal(grid.next(219), undefined);
  assert(grid.next(220));
});

test('video keeps its cooldown when later tile updates overlap it', () => {
  const grid = new DamageGrid(128, 128);
  grid.invalidate({ x: 10, y: 10, w: 2, h: 2 }, 'video', 10);
  grid.invalidate({ x: 10, y: 10, w: 2, h: 2 }, 'tile', 11);
  assert.equal(grid.next(759), undefined);
  assert(grid.next(760));
});

test('odd edges have bounded crops and complete gap-free output coverage', () => {
  const grid = new DamageGrid(259, 133);
  grid.invalidate({ x: 0, y: 0, w: 259, h: 133 }, 'reset', 0);
  const coverage = new Uint8Array(259 * 133);
  for (let job; (job = grid.next(100));) {
    const { input, output } = job;
    assert(input.w <= PATCH_SIZE + HALO * 2 && input.h <= PATCH_SIZE + HALO * 2);
    assert(input.x >= 0 && input.y >= 0 && input.x + input.w <= 259 && input.y + input.h <= 133);
    for (let y = output.y; y < output.y + output.h; y++) for (let x = output.x; x < output.x + output.w; x++) coverage[y * 259 + x]++;
  }
  assert(coverage.every(value => value === 1));
});

test('rejects unbounded shapes and malformed damage', () => {
  for (const [width, height] of [[0, 1], [-1, 1], [NaN, 1], [1.1, 20], [3840, 2160], [MAX_PIXELS, 1]]) {
    assert.throws(() => new DamageGrid(width, height), RangeError);
  }
  const grid = new DamageGrid(128, 128);
  for (const rect of [{ x: NaN, y: 0, w: 10, h: 10 }, { x: 1000, y: 0, w: 10, h: 10 }, { x: 0, y: 0, w: -1, h: 3 }]) {
    assert.equal(grid.invalidate(rect, 'tile', 0), undefined);
  }
  assert.equal(grid.pending(), 0);
});

test('bundled model remains numerically identical to the pinned WebSR weights', async () => {
  const text = await readFile('client/enhancement/model/cnn-2x-s.json', 'utf8');
  // Vendoring adds the conventional final newline; upstream JSON has none.
  assert.equal(createHash('sha256').update(text.trimEnd()).digest('hex'),
    'aecd5bf215a8962a13e38a8623433a7477f853ccdaefe8b6274f9aa6828368e0');
  const model = JSON.parse(text);
  const layers = Object.values(model.layers).filter(layer => layer.type === 'conv');
  assert.equal(layers.length, 4);
  layers.forEach((layer, index) => {
    assert.equal(layer.weights.length, index ? 288 : 144);
    assert.equal(layer.bias.length, 4);
    assert([...layer.weights, ...layer.bias].every(Number.isFinite));
  });
});

test('Quality weights retain their pin, seven spatial layers and three pointwise RGB heads', async () => {
  const text = await readFile('client/enhancement/model/cnn-2x-m.json', 'utf8');
  assert.equal(createHash('sha256').update(text.trimEnd()).digest('hex'),
    'f5833e47a3838c9f14558e413074219898deba8e73b661dcb54f38dca5eadcf7');
  const model = JSON.parse(text);
  const layers = Object.values(model.layers).filter(layer => layer.type === 'conv');
  assert.equal(layers.length, 10); assert.equal(model.layers.pixel_shuffle.inputs.length, 3);
  layers.forEach((layer, index) => {
    assert.equal(layer.weights.length, index >= 7 ? 224 : index ? 288 : 144);
    assert.equal(layer.bias.length, 4);
    assert([...layer.weights, ...layer.bias].every(Number.isFinite));
    if (index >= 7) assert.deepEqual(layer.inputs, layers.slice(0, 7).map(layer => layer.output));
  });
  assert(HALO >= 8, 'Seven 3×3 layers and the presentation neighborhood must fit the halo');
});
