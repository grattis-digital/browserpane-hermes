import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StockPresentationSummary } from '../scripts/render-pilot/stock-presentation-summary.mjs';

const event = (ph, ts, id = '0xa') => ({ name: 'SwapEndToPresentationCompositorFrame', ph, ts, pid: 1, id2: { local: id } });
test('presentation feedback joins string local tracks and deduplicates identical reported endpoints', () => {
  const result = StockPresentationSummary.extract([
    event('b', 10), event('b', 10, '0xb'), event('e', 16010, '0xb'), event('e', 16010), event('e', 20, '0xc'),
  ]);
  assert.equal(result.records.length, 1); assert.equal(result.records[0].reportedWaitUs, 16000);
  assert.equal(result.unmatched, 1); assert.match(result.scope, /NOT physical/);
});
test('numeric identifiers and overlapping presentation tracks cannot fabricate feedback timing', () => {
  assert.throws(() => StockPresentationSummary.extract([event('b', 1, 9007199254740992)]), /ID/);
  assert.throws(() => StockPresentationSummary.extract([event('b', 1), event('b', 2)]), /Duplicate/);
});
