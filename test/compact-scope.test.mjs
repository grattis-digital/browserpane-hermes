import test from 'node:test';
import assert from 'node:assert/strict';
import { CompactBrowserFixture as Fixture } from './compact-browser-fixture.mjs';
import { ObservationStore } from '../server/compact/observations.mjs';
import { ObservationRefs } from '../server/compact/observation-refs.mjs';
import { PaneValidation } from '../server/compact/validation.mjs';
import { PaneMetrics } from '../server/compact/metrics.mjs';

const coverage = { scope: 'page', depth: 2, nodeLimit: 256, visitedNodes: 3,
  depthLimited: true, nodeLimited: false, framesDeferred: 0, complete: false };
const raw = '- main [ref=e1]:\n  - button "Save" [ref=e2]';
function fixture(t) {
  const f = new Fixture(['about:blank']); t.after(() => f.close());
  f.requests = [];
  f.pages[0]._snapshotForAI = async options => {
    f.requests.push(options);
    return { full: raw, coverage: { visitedNodes: 3, depthLimited: true, nodeLimited: false, framesDeferred: 0 } };
  };
  return f;
}

test('outline caps traversal in the browser, reports scope, and keeps cached pagination capture-free', async t => {
  const f = fixture(t), timings = [], session = f.session({ metrics: new PaneMetrics({ enabled: true, sink: line => timings.push(JSON.parse(line)) }) });
  const first = await f.call(session, 'pane_view', { capture: 'outline', depth: 2, limit: 1 });
  assert.deepEqual(f.requests, [{ timeout: 3000, maxDepth: 2, maxNodes: 256, includeFrames: false, selector: undefined }]);
  assert.deepEqual(first.coverage, coverage);
  const next = await f.call(session, 'pane_view', { cursor: first.cursor });
  assert.deepEqual(next.coverage, coverage); assert.equal(next.state, first.state);
  assert.equal(f.requests.length, 1); assert.equal(timings[0].snapshotNodes, 3);
  assert.equal(timings[1].stateHits, 1); assert.equal(timings[1].snapshots, undefined);
  assert.equal(f.creations, 0);
});

test('scoping requires a returned ref in the latest same-client view, not a guessed selector', async t => {
  const f = fixture(t), a = f.session(), b = f.session();
  const first = await f.call(a, 'pane_view', { capture: 'outline', limit: 1 });
  for (const [session, root, code] of [[a, 'e2', 'STALE_REF'], [b, 'e1', 'STALE_VIEW']]) {
    const result = await f.call(session, 'pane_view', { tab: first.tab, view: first.view, root });
    assert.equal(result.error.code, code);
  }
  assert.equal(f.requests.length, 1);
  const expanded = await f.call(a, 'pane_view', { tab: first.tab, view: first.view, root: 'e1' });
  assert.equal(expanded.coverage.scope, 'e1');
  assert.equal(f.requests[1].selector, 'aria-ref=e1'); assert.equal(f.requests[1].maxNodes, 1024);
  assert.equal((await f.call(a, 'pane_view', { tab: first.tab, view: first.view, root: 'e1' })).error.code, 'STALE_VIEW');
});

test('missing adapter coverage and a detached or renamed scope never fall back to full capture', async t => {
  const f = fixture(t), session = f.session();
  f.pages[0]._snapshotForAI = async () => ({ full: raw });
  assert.equal((await f.call(session, 'pane_view', { capture: 'outline' })).error.code, 'SNAPSHOT_ADAPTER');
  f.pages[0]._snapshotForAI = async () => ({ full: '', scopeMissing: true });
  await assert.rejects(f.browser.tab().snapshot({ root: 'e1' }), { code: 'STALE_REF' });
});

test('scope fields cannot change an immutable state or weaken whole-page guarded workflows', async t => {
  const f = fixture(t), session = f.session();
  const first = await f.call(session, 'pane_view', { capture: 'outline' });
  const result = await f.call(session, 'pane_flow', { lease: first.lease, request: 1, tab: first.tab, view: first.view,
    stages: [{ steps: [{ op: 'click', target: { role: 'button', name: 'Save' } }] }] });
  assert.equal(result.error.code, 'SCOPED_VIEW'); assert.equal(result.completed, 0); assert.equal(f.requests.length, 1);
  for (const args of [{ root: 'e1' }, { root: 'css=main', tab: 't1', view: 'v1' }, { view: 'v1' },
    { enterFrame: true }, { depth: 3 }, { capture: 'outline', depth: 0 }, { capture: 'outline', depth: 7 },
    { state: 'v1', capture: 'full' }, { state: 'v1', tab: 't1', view: 'v1', root: 'e1' }])
    assert.throws(() => PaneValidation.parse('pane_view', args), { code: 'INVALID_ARGUMENT' });
});

test('frame entry requires an observed iframe, not an arbitrary element', async t => {
  const f = fixture(t), session = f.session(), first = await f.call(session, 'pane_view', { capture: 'outline' });
  const result = await f.call(session, 'pane_view', { tab: first.tab, view: first.view, root: 'e1', enterFrame: true });
  assert.equal(result.error.code, 'INVALID_ARGUMENT'); assert.equal(f.requests.length, 1);
});

test('coverage is immutable, survives reprojection, and cannot claim wider completeness', () => {
  const store = new ObservationStore();
  const input = { tab: 't1', document: 1, url: 'about:blank', title: '', snapshot: raw, coverage };
  const view = store.capture(input); view.coverage.complete = true;
  const inspected = store.inspect(view.view); assert.equal(inspected.coverage.complete, false);
  inspected.coverage.scope = 'e99'; assert.equal(store.inspect(view.view).coverage.scope, 'page');
  const cached = store.reproject(view.state); assert.deepEqual(cached.coverage, coverage);
  for (const patch of [{ complete: true }, { visitedNodes: 257 }, { depth: -1 }, { nodeLimit: 100000 },
    { framesDeferred: 4 }, { arbitrary: true }, { scope: 'css=body' }])
    assert.throws(() => store.capture({ ...input, coverage: { ...coverage, ...patch } }), { code: 'invalid_coverage' });
  const different = store.capture({ ...input, coverage: { ...coverage, scope: 'e1' }, since: cached.view });
  assert.equal(different.reset, true); assert.equal(different.mode, 'full');
});

test('target keys ignore subtree indentation and inherited cursor presentation, not semantic state', () => {
  assert.equal(ObservationRefs.signature('    - button "Save" [ref=e1]:'), ObservationRefs.signature('- button "Save" [ref=e1] [cursor=pointer]'));
  for (const line of ['- button "Buy" [ref=e1]', '- button "Save" [disabled] [ref=e1]', '- button "Save" [ref=e2]'])
    assert.notEqual(ObservationRefs.signature(line), ObservationRefs.signature('- button "Save" [ref=e1]'));
});
