import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ScrollbarProbe } from '../scripts/render-pilot/scrollbar-probe.mjs';

test('native scrollbar thumb identification excludes short arrow glyphs', () => {
  const pixels = Array.from({ length: 200 }, (_, y) => {
    const c = (y >= 3 && y < 9) || (y >= 40 && y < 65) ? 140 : 252;
    return [c, c, c, 255];
  }).flat();
  assert.deepEqual(ScrollbarProbe.locate(pixels, 200), { top: 40, height: 25, center: 52.5 });
});
test('missing or ambiguous native thumb fails rather than silently measuring a track click', () => {
  for (const ranges of [[], [[30, 50], [70, 90]]]) {
    const pixels = Array.from({ length: 200 }, (_, y) => {
      const c = ranges.some(([a, b]) => y >= a && y < b) ? 140 : 252;
      return [c, c, c, 255];
    }).flat();
    assert.throws(() => ScrollbarProbe.locate(pixels, 200), /thumb/);
  }
});
