import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StockTraceSummary } from '../scripts/render-pilot/stock-trace-summary.mjs';

const event = (ph, ts, name, extra = {}) => ({ ph, ts, name, pid: 1, tid: 2, ...extra });
test('stock trace selects supported categories without enabling screenshots or every category', () => {
  const available = ['cc', 'viz', 'gpu', 'blink.user_timing', 'input', 'disabled-by-default-devtools.screenshot'];
  const selection = StockTraceSummary.categories(available);
  assert.deepEqual(selection.included, ['cc', 'viz', 'gpu', 'input', 'blink.user_timing']);
  assert(selection.unavailable.includes('gpu.angle'));
  assert.throws(() => StockTraceSummary.categories(['gpu']), /required/);
});
test('nested B/E and X spans retain inclusive wall durations, not an additive latency budget', () => {
  const result = StockTraceSummary.summarize([
    event('M', 0, 'thread_name', { args: { name: 'CrGpuMain' } }),
    event('B', 10, 'outer'), event('B', 20, 'inner'), event('E', 25), event('E', 50),
    event('X', 80, 'outer', { dur: 20 }), event('E', 100), event('B', 110, 'incomplete'),
  ]);
  assert.equal(result.durations[0].inclusiveTotalUs, 60);
  assert.equal(result.durations[0].n, 2);
  assert.equal(result.durations[1].inclusiveTotalUs, 5);
  assert.equal(result.gpuDurations.length, 2);
  assert.equal(result.unmatchedEnds, 1); assert.equal(result.unmatchedBegins, 1);
  assert.match(result.scope, /NOT GPU execution/);
});
test('trace summary exports bounded geometry/owned marks but no arbitrary args or URLs', () => {
  const result = StockTraceSummary.summarize([
    event('I', 1, 'bph-input-5'), event('I', 2, 'bph-clock-start'),
    event('I', 3, 'DirectRenderer::DrawFrame ProcessForOverlays', { args: { root_damage_rect: '32,239 24x24', secret: 'private' } }),
    event('X', 4, 'https://private.invalid', { dur: 2 }), event('X', 7, 'egl::Surface::swap', { dur: 3, args: { secret: 'private' } }),
  ]);
  assert.equal(result.damage[0].pixels, 576); assert.equal(result.marks.length, 2);
  assert.equal(result.durations.length, 1); assert(!JSON.stringify(result).includes('private'));
});
test('malformed, oversized, out-of-bounds and mismatched traces fail closed', () => {
  for (const input of [[], Array(200001).fill({}), [event('X', 1, 'gpu', { dur: -1 })],
    [event('B', 1, 'a'), event('E', 2, 'b')],
    [event('I', 1, 'DirectRenderer::DrawFrame ProcessForOverlays', { args: { root_damage_rect: '0,0 1281x720' } })]]) {
    assert.throws(() => StockTraceSummary.summarize(input));
  }
});
