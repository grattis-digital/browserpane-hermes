import test from 'node:test';
import assert from 'node:assert/strict';
import { CompactBrowserFixture } from './compact-browser-fixture.mjs';
import { ObservationStore } from '../server/compact/observations.mjs';

const snapshot = '- paragraph: Intro\n- button "Save first" [ref=e1]\n- paragraph: Middle\n- button "Save second" [ref=e2]\n- button "Delete" [ref=e3]';
const fixture = t => {
  const f = new CompactBrowserFixture(); t.after(() => f.close());
  f.pages[0].snapshotText = snapshot; return f;
};

test('cursor preserves query, filter, detail and budgets without recapture or duplicate results', async t => {
  for (const options of [{ query: { role: 'button', name: 'Save', exact: false } }, { filter: 'Save' },
    { detail: 'controls', filter: 'Save', query: { role: 'button' } }]) {
    const f = fixture(t), session = f.session();
    const first = await f.call(session, 'pane_view', { ...options, limit: 1, maxChars: 100 });
    const next = await f.call(session, 'pane_view', { cursor: first.cursor });
    assert.match(first.text, /Save first/); assert.match(next.text, /Save second/);
    assert.doesNotMatch(next.text, /Save first|Delete|paragraph/);
    assert.equal(next.total, 2); assert.equal(next.state, first.state);
    assert.equal(next.limit, 1); assert.equal(next.maxChars, 100);
    assert.equal(next.next, undefined); assert.equal(next.cursor, undefined);
    assert.equal(f.pages[0].snapshotCalls, 1);
    const replay = await f.call(session, 'pane_view', { cursor: first.cursor });
    assert.equal(replay.text, next.text); assert.equal(replay.offset, next.offset);
    assert.equal(f.pages[0].snapshotCalls, 1);
  }
});

test('interleaved queries cannot change a cursor; state remains an independent raw snapshot', async t => {
  const f = fixture(t), session = f.session();
  const first = await f.call(session, 'pane_view', { query: { name: 'Save', exact: false }, limit: 1 });
  const different = await f.call(session, 'pane_view', { state: first.state, query: { name: 'Delete' } });
  assert.match(different.text, /Delete/);
  const next = await f.call(session, 'pane_view', { cursor: first.cursor });
  assert.match(next.text, /Save second/); assert.equal(next.matches, 2);
  const raw = await f.call(session, 'pane_view', { state: first.state });
  assert.equal(raw.text, snapshot); assert.equal(raw.matches, undefined);
  assert.equal(f.pages[0].snapshotCalls, 1);
});

test('cursor budgets can increase to recover from context-only pages without changing selection', async t => {
  const f = fixture(t), session = f.session();
  f.pages[0].snapshotText = `- region "${'Context'.repeat(10)}" [ref=e1]:\n  - button "Save" [ref=e2]`;
  const first = await f.call(session, 'pane_view', { query: { name: 'Save' }, limit: 1, maxChars: 64 });
  const blocked = await f.call(session, 'pane_view', { cursor: first.cursor });
  assert.equal(blocked.next, first.next); assert.doesNotMatch(blocked.text, /\[ref=/);
  const recovered = await f.call(session, 'pane_view', { cursor: blocked.cursor, maxChars: 1000, limit: 2 });
  assert.match(recovered.text, /button "Save" \[ref=e2\]/); assert.equal(recovered.cursor, undefined);
  assert.equal(f.pages[0].snapshotCalls, 1);
});

test('foreign, evicted and terminal cursors fail closed without recapturing', async t => {
  const f = fixture(t), a = f.session(), b = f.session();
  const first = await f.call(a, 'pane_view', { limit: 1 });
  assert.equal((await f.call(b, 'pane_view', { cursor: first.cursor })).error.code, 'STALE_CURSOR');
  const full = await f.call(a, 'pane_view', { state: first.state });
  assert.equal((await f.call(a, 'pane_view', { cursor: full.view })).error.code, 'STALE_CURSOR');
  for (let n = 0; n < 4; n++) await f.call(a, 'pane_view', { state: first.state, limit: 1 });
  assert.equal((await f.call(a, 'pane_view', { cursor: first.cursor })).error.code, 'STALE_CURSOR');
  assert.equal(f.pages[0].snapshotCalls, 1);
});

test('navigation, mutation and closed tabs invalidate continuation without retargeting', async t => {
  for (const change of ['navigate', 'mutate', 'close']) {
    const f = fixture(t), session = f.session();
    const first = await f.call(session, 'pane_view', { limit: 1 });
    if (change === 'navigate') await f.pages[0].goto('about:blank');
    if (change === 'mutate') f.browser.tab().consume();
    if (change === 'close') await f.pages[0].close();
    const result = await f.call(session, 'pane_view', { cursor: first.cursor });
    assert.equal(result.error.code, change === 'close' ? 'UNKNOWN_TAB' : 'STALE_VIEW');
    assert.equal(f.pages[0].snapshotCalls, 1); assert.equal(f.pages[1].snapshotCalls, 0);
  }
});

test('cursor cannot mix projections, sources, offsets, tabs or delta bases', async t => {
  const f = fixture(t), session = f.session();
  for (const key of ['state', 'since', 'tab', 'offset', 'query', 'filter', 'detail']) {
    const value = key === 'offset' ? 0 : key === 'query' ? { name: 'Save' } : key === 'detail' ? 'full' : 'x';
    const result = await f.call(session, 'pane_view', { cursor: 'x', [key]: value });
    assert.equal(result.error.code, 'INVALID_ARGUMENT');
  }
  assert.equal((await f.call(session, 'pane_view', { cursor: '' })).error.code, 'STALE_CURSOR');
  assert.equal(f.pages[0].snapshotCalls, 0);
});

test('continuation copies are isolated and cannot outlive raw state or tab invalidation', () => {
  let ids = 0;
  const store = new ObservationStore({ idFactory: () => `v${++ids}` });
  const input = { tab: 't1', document: 1, mutation: 0, url: 'about:blank', title: '', snapshot,
    query: { name: 'Save', exact: false }, limit: 1 };
  const first = store.capture(input), options = store.continuation(first.cursor);
  options.query.name = 'Delete'; assert.equal(store.continuation(first.cursor).query.name, 'Save');
  const recent = store.reproject(first.state, { limit: 1 });
  for (let n = 0; n < 4; n++) store.capture(input);
  assert.equal(store.continuation(recent.cursor), undefined);
  const last = store.capture(input); store.invalidateTab('t1');
  assert.equal(store.continuation(last.cursor), undefined);
});
