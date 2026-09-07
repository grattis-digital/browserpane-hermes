import test from 'node:test';
import assert from 'node:assert/strict';
import { CompactBrowserFixture } from './compact-browser-fixture.mjs';
import { ActionRunner } from '../server/compact/action-runner.mjs';

class FlowFixture extends CompactBrowserFixture {
  calls = [];
  snapshots = 0;
  waits = 0;
  disposed = 0;
  onSnapshot = async () => {};
  onInput = async () => {};
  onWait = async () => {};
  constructor(t) {
    super(); t.after(() => this.close());
    this.pages[0].snapshotText = '- button "Save" [ref=e1]\n- button "Confirm" [ref=e2]';
    const tab = this.browser.tab(), snapshot = tab.snapshot.bind(tab);
    tab.snapshot = async () => { await this.onSnapshot(++this.snapshots); return snapshot(); };
    this.pages[0].locator = () => ({ elementHandle: async () => ({
      evaluate: async () => 'same', dispose: async () => { this.disposed++; },
    }) });
    this.actions = new ActionRunner(this.browser, {
      perform: async (_tab, step) => { this.calls.push(step.ref); await this.onInput(); },
      wait: async () => { this.waits++; await this.onWait(); },
    }, () => 0);
  }
  async run() {
    const session = this.session(), view = await this.call(session, 'pane_tabs');
    const args = { lease: view.lease, request: 1, observe: 'none', stages: [
      { steps: [{ op: 'click', target: { name: 'Save' } }], wait: { text: 'Ready' } },
      { steps: [{ op: 'click', target: { name: 'Confirm' } }] },
    ] };
    const result = await this.call(session, 'pane_flow', args);
    const calls = [...this.calls];
    assert.deepEqual(await this.call(session, 'pane_flow', args), result);
    assert.deepEqual(this.calls, calls, 'Replaying a stopped flow must not issue input');
    return result;
  }
}

test('popup during stage capture or awaited preflight prevents even the first input', async t => {
  for (const boundary of [1, 2]) {
    const f = new FlowFixture(t);
    f.onSnapshot = async count => { if (count === boundary) await f.context.newPage(); };
    const result = await f.run();
    assert.equal(result.stopped, 'new_tab'); assert.equal(result.completed, 0);
    assert.equal(result.stages, 0); assert.equal(result.failedStage, 0);
    assert.deepEqual(f.calls, []); assert.equal(f.waits, 0);
    assert.equal(f.disposed, boundary === 2 ? 1 : 0);
  }
});

test('popup during successful or failed wait retains the applied prefix and blocks every later stage', async t => {
  for (const failWait of [false, true]) {
    const f = new FlowFixture(t);
    f.onWait = async () => { await f.context.newPage(); if (failWait) throw new Error('Synthetic timeout'); };
    const result = await f.run();
    assert.equal(result.stopped, 'new_tab'); assert.equal(result.completed, 1);
    assert.equal(result.stages, 0); assert.equal(result.failedStage, 0);
    assert.deepEqual(f.calls, ['e1']); assert.equal(f.disposed, 1);
    if (failWait) { assert.equal(result.error.code, 'POSTCONDITION_FAILED'); assert.equal(result.mayHaveActed, true); }
  }
});

test('flow-wide popup baseline survives completed stages and simultaneous navigation', async t => {
  const between = new FlowFixture(t);
  between.onSnapshot = async count => { if (count === 3) await between.context.newPage(); };
  const result = await between.run();
  assert.equal(result.stopped, 'new_tab'); assert.equal(result.completed, 1);
  assert.equal(result.stages, 1); assert.equal(result.failedStage, 1);
  assert.deepEqual(between.calls, ['e1']);
  const simultaneous = new FlowFixture(t);
  simultaneous.onInput = async () => { await simultaneous.pages[0].goto('about:blank'); await simultaneous.context.newPage(); };
  const both = await simultaneous.run();
  assert.equal(both.stopped, 'new_tab'); assert.equal(both.completed, 1);
  assert.equal(both.stages, 0); assert.equal(simultaneous.waits, 0);
  assert.deepEqual(simultaneous.calls, ['e1']);
});

test('malformed stages return INVALID_ARGUMENT before snapshots, input or request recording', async t => {
  const f = new FlowFixture(t), session = f.session();
  const { lease } = await f.call(session, 'pane_tabs');
  for (const stage of [{}, { wait: { text: 'Ready' } }, { steps: [] }, { steps: null }, { steps: 'click' }]) {
    const result = await session.callTool('pane_flow', { lease, request: 1, stages: [stage] });
    assert.equal(result.isError, true);
    assert.equal(JSON.parse(result.content[0].text).error.code, 'INVALID_ARGUMENT');
  }
  assert.equal(f.snapshots, 0); assert.deepEqual(f.calls, []);
  const valid = await f.call(session, 'pane_flow', { lease, request: 1, observe: 'none',
    stages: [{ steps: [{ op: 'click', target: { name: 'Save' } }] }] });
  assert.equal(valid.completed, 1); assert.deepEqual(f.calls, ['e1']);
});
