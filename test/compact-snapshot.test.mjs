import test from 'node:test';
import assert from 'node:assert/strict';
import { errors } from 'playwright-core';
import { CompactBrowserFixture as Fixture } from './compact-browser-fixture.mjs';

const fixture = t => { const f = new Fixture(['about:blank']); t.after(() => f.close()); return f; };

test('snapshot has its own finite 15s budget, no retry, no output clipping and no tab creation', async t => {
  const f = fixture(t), session = f.session(), calls = [];
  f.pages[0]._snapshotForAI = async options => { calls.push(options); return { full: '- button "Save" [ref=e1]' }; };
  const view = await f.call(session, 'pane_view');
  assert.equal(view.text, '- button "Save" [ref=e1]');
  assert.deepEqual(calls, [{ timeout: 15000 }]); assert.equal(f.creations, 0);
  await f.call(session, 'pane_view', { state: view.state, detail: 'controls' });
  assert.equal(calls.length, 1, 'Cached projection must not ask Chromium for another snapshot');
});

test('snapshot timeout is typed, preserves its cause and does not retry or serve cached refs', async t => {
  const f = fixture(t), session = f.session();
  await f.call(session, 'pane_view');
  const timeout = new errors.TimeoutError('Synthetic timeout'); let calls = 0;
  f.pages[0]._snapshotForAI = async () => { calls++; throw timeout; };
  await assert.rejects(f.browser.tab().snapshot(), error => error.code === 'SNAPSHOT_TIMEOUT' && error.cause === timeout);
  const failed = await f.call(session, 'pane_view');
  assert.equal(failed.error.code, 'SNAPSHOT_TIMEOUT');
  assert.match(failed.error.message, /avoid immediate retries/);
  assert.equal(failed.view, undefined); assert.equal(failed.text, undefined); assert.equal(calls, 2);
});

test('non-timeout browser failures keep their identity; a timeout-like message is not enough', async t => {
  const f = fixture(t), failure = new Error('Timeout 3000ms exceeded.');
  f.pages[0]._snapshotForAI = async () => { throw failure; };
  await assert.rejects(f.browser.tab().snapshot(), error => error === failure);
});

test('navigation during a slow snapshot cannot mint a view for the replacement document', async t => {
  const f = fixture(t), session = f.session();
  f.pages[0]._snapshotForAI = async () => {
    await f.pages[0].goto('https://fixture.test/changed'); return { full: '- button "Old" [ref=e1]' };
  };
  const result = await f.call(session, 'pane_view');
  assert.equal(result.error.code, 'STALE_VIEW'); assert.equal(result.view, undefined);
});

test('a cancelled slow capture keeps the shared queue until completion; queued cancellation does not recapture', async t => {
  const f = fixture(t), a = f.session(), b = f.session();
  const gate = Promise.withResolvers(), started = Promise.withResolvers(); let calls = 0;
  f.pages[0]._snapshotForAI = async () => { calls++; started.resolve(); await gate.promise; return { full: '' }; };
  const runningAbort = new AbortController(), queuedAbort = new AbortController();
  const running = a.callTool('pane_view', {}, { signal: runningAbort.signal });
  await started.promise;
  const queued = b.callTool('pane_view', {}, { signal: queuedAbort.signal });
  runningAbort.abort(); queuedAbort.abort();
  assert.equal(JSON.parse((await queued).content[0].text).error.code, 'CANCELLED');
  assert.equal(calls, 1); gate.resolve(); await running; assert.equal(calls, 1);
});

test('open dialogs skip snapshot work and repeated new requests cannot add a second tab', async t => {
  const f = fixture(t), session = f.session();
  f.pages[0].emit('dialog', { type: () => 'alert', message: () => 'Synthetic dialog' });
  const view = await f.call(session, 'pane_view');
  assert.equal(view.dialog.type, 'alert'); assert.equal(f.pages[0].snapshotCalls, 0);
  for (let request = 1; request <= 3; request++) {
    const result = await f.call(session, 'pane_act', { lease: view.lease, request, steps: [{ op: 'new' }] });
    assert.equal(result.error.code, 'TAB_EXISTS'); assert.equal(result.completed, 0);
    assert.equal(result.mayHaveActed, undefined);
  }
  assert.equal(f.creations, 0); assert.equal(f.context.pages().length, 1);
});

test('two clients recovering an empty browser create only one tab through the shared queue', async t => {
  const f = new Fixture([]); t.after(() => f.close());
  const a = f.session(), b = f.session();
  const left = await f.call(a, 'pane_tabs'), right = await f.call(b, 'pane_tabs');
  const results = await Promise.all([[a, left], [b, right]].map(([session, list]) =>
    f.call(session, 'pane_act', { lease: list.lease, request: 1, steps: [{ op: 'new' }] })));
  assert.equal(results.filter(result => result.completed === 1).length, 1);
  assert.equal(results.filter(result => result.error?.code === 'TAB_EXISTS').length, 1);
  assert.equal(f.creations, 1); assert.equal(f.context.pages().length, 1);
});
