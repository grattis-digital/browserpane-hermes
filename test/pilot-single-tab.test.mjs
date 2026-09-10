import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PilotTab } from '../scripts/render-pilot/single-tab.mjs';

const page = { type: 'page', url: 'about:blank', targetId: 'synthetic-fixture' };
test('pilot reuses its one blank tab without counting workers as tabs', () => {
  const state = PilotTab.inspect([page, { type: 'service_worker' }]);
  assert.deepEqual(state, { count: 1, targetId: page.targetId });
  PilotTab.assertSame(state, state);
});
test('missing, additional and website tabs fail instead of creating or closing tabs', () => {
  for (const targets of [[], [page, { ...page, targetId: 'extra' }], [{ ...page, url: 'https://example.invalid/' }], [{ ...page, targetId: '' }]]) {
    assert.throws(() => PilotTab.inspect(targets));
  }
});
test('one replacement tab cannot masquerade as the original session', () => {
  const state = PilotTab.inspect([page]);
  assert.throws(() => PilotTab.assertSame(state, { count: 1, targetId: 'replacement' }), /changed/);
  assert.throws(() => PilotTab.assertSame(undefined, state), /initial tab/);
});
