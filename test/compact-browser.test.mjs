import test from 'node:test';
import assert from 'node:assert/strict';
import { CompactBrowserFixture as Fixture } from './compact-browser-fixture.mjs';
import { CompactHttpFixture } from './compact-http-fixture.mjs';
import { PaneSchemas } from '../server/compact/schemas.mjs';
import { PaneMetrics } from '../server/compact/metrics.mjs';

const fixture = (t, urls) => { const f = new Fixture(urls); t.after(() => f.close()); return f; };
const navigation = (view, request = 1) => ({ lease: view.lease, request, tab: view.tab, view: view.view,
  steps: [{ op: 'navigate', url: 'https://fixture.test/reused' }] });

test('omitted tab reuses the first existing tab without creation, navigation or focus changes', async t => {
  const f = fixture(t), a = f.session(), b = f.session();
  for (const session of [a, b, a, b]) {
    const listed = await f.call(session, 'pane_tabs');
    assert.deepEqual(listed.tabs.map(tab => [tab.tab, tab.default]), [['t1', true], ['t2', undefined]]);
    assert.equal((await f.call(session, 'pane_view')).tab, 't1');
  }
  assert.equal(f.creations, 0);
  assert(f.pages.every(page => page.navigations.length === 0 && page.activations === 0));
});

test('state pagination and semantic query reuse one immutable Chromium snapshot', async t => {
  const f = fixture(t), session = f.session();
  f.pages[0].snapshotText = '- main [ref=e1]:\n  - button "Save" [ref=e2]\n  - button "Save draft" [ref=e3]';
  const first = await f.call(session, 'pane_view', { limit: 2 });
  const next = await f.call(session, 'pane_view', { state: first.state, offset: first.next, limit: 2 });
  assert.equal(next.state, first.state); assert.match(next.text, /Save draft/); assert.equal(f.pages[0].snapshotCalls, 1);
  const found = await f.call(session, 'pane_view', { state: first.state,
    query: { role: 'button', name: 'save', exact: true } });
  assert.equal(found.matches, 1); assert.match(found.text, /"Save"/); assert.doesNotMatch(found.text, /Save draft/);
  assert.equal(f.pages[0].snapshotCalls, 1);
  await f.pages[0].goto('https://fixture.test/changed');
  assert.equal((await f.call(session, 'pane_view', { state: first.state })).error.code, 'STALE_VIEW');
});

test('session timings distinguish fresh snapshots from state cache hits without content', async t => {
  const f = fixture(t), lines = [];
  const session = f.session({ metrics: new PaneMetrics({ enabled: true, sink: line => lines.push(line) }) });
  f.pages[0].snapshotText = '- button "Private label must not be logged" [ref=e1]';
  const first = await f.call(session, 'pane_view');
  await f.call(session, 'pane_view', { state: first.state, query: { role: 'button' } });
  const [fresh, cached] = lines.map(JSON.parse);
  assert.equal(fresh.snapshots, 1); assert.equal(fresh.stateHits, undefined);
  assert.equal(cached.snapshots, undefined); assert.equal(cached.stateHits, 1);
  assert(lines.every(line => !line.includes('Private label')));
});

test('default prefers web/new-tab pages over internal UI but does not hide any existing tab', async t => {
  for (const preferred of ['https://fixture.test/', 'http://fixture.test/', 'about:blank', 'chrome://newtab/']) {
    const f = fixture(t, ['chrome-extension://synthetic/options.html', 'devtools://devtools/bundled/', preferred]);
    assert.equal(f.browser.tab().id, 't3');
    assert.equal((await f.browser.list()).length, 3);
    assert.equal(f.browser.tab('t1').page, f.pages[0]);
    assert.equal(f.creations, 0);
  }
  const internal = fixture(t, ['chrome://settings/', 'devtools://devtools/bundled/']);
  assert.equal(internal.browser.tab().id, 't1'); // No replacement tab is invented.
});

test('default stays pinned through popup creation, explicit selection, focus and navigation', async t => {
  const f = fixture(t), session = f.session();
  const first = await f.call(session, 'pane_view');
  const second = await f.call(session, 'pane_view', { tab: 't2' });
  await f.call(session, 'pane_act', { ...navigation(second), steps: [{ op: 'activate' }] });
  await f.context.newPage();
  await f.pages[0].goto('chrome://settings/');
  assert.equal((await f.call(session, 'pane_view')).tab, first.tab);
  assert.equal(f.pages[1].activations, 1);
  assert.equal(f.creations, 1); // The simulated popup only.
});

test('a closed default falls back only for a fresh untargeted observation, never for old input', async t => {
  const f = fixture(t), session = f.session(), old = await f.call(session, 'pane_view');
  await f.pages[0].close();
  const next = await f.call(session, 'pane_view');
  assert.equal(next.tab, 't2');
  assert.equal((await f.call(session, 'pane_act', navigation(old))).error.code, 'UNKNOWN_TAB');
  assert.equal((await f.call(session, 'pane_act', { ...navigation(next, 2), view: old.view })).error.code, 'STALE_VIEW');
  assert.equal((await f.call(session, 'pane_view', { tab: old.tab })).error.code, 'UNKNOWN_TAB');
  assert.equal(f.pages[1].navigations.length, 0);
  assert.equal(f.creations, 0);
});

test('closed pages pending their close event and unknown explicit IDs never retarget implicitly', t => {
  const f = fixture(t);
  assert.equal(f.browser.tab().id, 't1');
  f.pages[0].closed = true;
  assert.equal(f.browser.tab().id, 't2');
  for (const id of ['t1', 'missing', '', null]) assert.throws(() => f.browser.tab(id), { code: 'UNKNOWN_TAB' });
  f.connected = false;
  assert.throws(() => f.browser.tab(), { code: 'DISCONNECTED' });
  assert.equal(f.creations, 0);
});

test('zero tabs remain zero during discovery/observation; only explicit new creates and retries do not duplicate', async t => {
  const f = fixture(t, []), session = f.session();
  const list = await f.call(session, 'pane_tabs');
  assert.deepEqual(list.tabs, []);
  assert.equal((await f.call(session, 'pane_view')).error.code, 'NO_TAB');
  assert.equal(f.creations, 0);
  const args = { lease: list.lease, request: 1, steps: [{ op: 'new' }] };
  const created = await f.call(session, 'pane_act', args);
  assert.equal(created.completed, 1);
  assert.deepEqual(await f.call(session, 'pane_act', args), created);
  assert.equal((await f.call(session, 'pane_view')).tab, created.tab);
  assert.equal(f.creations, 1);
});

test('navigate in place stays view-guarded and replay-safe; deliberate new does not replace the default', async t => {
  const f = fixture(t), a = f.session(), b = f.session();
  const view = await f.call(a, 'pane_view'), stale = await f.call(b, 'pane_view');
  const args = navigation(view), result = await f.call(a, 'pane_act', args);
  assert.equal(result.completed, 1);
  assert.deepEqual(await f.call(a, 'pane_act', args), result);
  assert.equal((await f.call(b, 'pane_act', navigation(stale))).error.code, 'STALE_VIEW');
  assert.deepEqual(f.pages[0].navigations, ['https://fixture.test/reused']);
  assert.equal(f.creations, 0);
  const created = await f.call(a, 'pane_act', { lease: view.lease, request: 2, steps: [{ op: 'new' }] });
  assert.equal(created.tab, 't3'); assert.equal(f.creations, 1);
  assert.equal((await f.call(b, 'pane_view')).tab, 't1');
});

test('real MCP HTTP clients share the same default across delete/reconnect without creating pages', async t => {
  const f = fixture(t);
  const http = await CompactHttpFixture.create(t, { createSession: () => f.session() });
  const a = await http.connect(), b = await http.connect();
  const observe = async client => JSON.parse((await client.callTool({ name: 'pane_view', arguments: {} })).content[0].text);
  await a.client.listTools(); await b.client.listTools();
  const initial = await observe(a.client);
  assert.equal((await observe(b.client)).tab, initial.tab);
  await a.transport.terminateSession();
  const reconnected = await http.connect(), fresh = await observe(reconnected.client);
  assert.equal(fresh.tab, initial.tab); assert.notEqual(fresh.lease, initial.lease);
  const old = JSON.parse((await reconnected.client.callTool({ name: 'pane_act', arguments: navigation(initial) })).content[0].text);
  assert.equal(old.error.code, 'STALE_SESSION');
  await f.pages[0].close();
  assert.equal((await observe(b.client)).tab, 't2');
  assert.equal((await observe(reconnected.client)).tab, 't2');
  assert.equal(f.creations, 0);
  assert(f.pages.every(page => page.navigations.length === 0 && page.activations === 0));
});

test('model-facing guidance leads with existing-tab reuse and leaves intentional new available', () => {
  const tools = PaneSchemas.tools(), view = tools.find(tool => tool.name === 'pane_view');
  const act = tools.find(tool => tool.name === 'pane_act');
  assert.match(view.description, /Start with \{\}.*reuse/);
  assert.match(act.description, /navigate\(url\) in place/);
  assert.match(act.description, /new creates an extra tab/);
  assert.match(view.description, /state requeries/);
  assert.match(view.description, /cursor: reply.cursor/);
  assert.equal(act.inputSchema.properties.steps.items.properties.op.enum.at(-1), 'new');
});
