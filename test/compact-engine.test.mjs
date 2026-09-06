import test from 'node:test';
import assert from 'node:assert/strict';
import { ActionRunner } from '../server/compact/action-runner.mjs';
import { FlowRunner } from '../server/compact/flow-runner.mjs';
import { PaneError } from '../server/compact/errors.mjs';
import { RequestLedger } from '../server/compact/request-ledger.mjs';
import { SerialExecutor } from '../server/compact/executor.mjs';
import { PaneSession } from '../server/compact/session.mjs';
import { ObservationStore } from '../server/compact/observations.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function runnerFixture() {
  let evaluations = 0, disposed = 0, now = 0;
  const controller = new AbortController(), calls = [], browser = { popupVersion: 0 };
  const fixture = { controller, calls, browser, evaluate: () => 'same', perform: async () => {} };
  const handle = { evaluate: async () => fixture.evaluate(++evaluations), dispose: async () => { disposed++; } };
  const tab = { document: 1, mutation: 0, dialog: undefined, snapshot: async () => '- button "Save" [ref=e1]',
    page: { locator: () => ({ elementHandle: async () => handle }), isClosed: () => false },
    act: async work => { await work(); return {}; }, releaseWhenSettled: async release => release() };
  fixture.tab = tab; fixture.disposed = () => disposed; fixture.time = value => { now = value; };
  fixture.runner = new ActionRunner(browser, { perform: async (...args) => { calls.push(args[1]); return fixture.perform(...args); }, wait: async () => {} }, () => now);
  fixture.observation = { document: 1, refs: new Map([['e1', '- button "Save" [ref=e1]']]) };
  fixture.run = steps => fixture.runner.run(tab, { steps }, fixture.observation, controller.signal);
  return fixture;
}

test('cancelled queued work never executes; a running operation keeps exclusive ownership until settled', async () => {
  const executor = new SerialExecutor(2), gate = deferred(), events = [], abort = new AbortController();
  const first = executor.run(async () => { events.push('start'); await gate.promise; events.push('finish'); });
  const queued = executor.run(async () => events.push('cancelled'), abort.signal);
  const rejection = assert.rejects(queued, { code: 'CANCELLED' }); abort.abort(); await rejection;
  const last = executor.run(async () => events.push('last'));
  assert.deepEqual(events, ['start']); gate.resolve(); await Promise.all([first, last]);
  assert.deepEqual(events, ['start', 'finish', 'last']); executor.close();
  await assert.rejects(executor.run(() => {}), { code: 'CLOSED' });
});

test('queue backpressure and shutdown cannot release an unfinished operation early', async () => {
  const executor = new SerialExecutor(1), gate = deferred(); let finished = false;
  const running = executor.run(async () => { await gate.promise; finished = true; });
  const queued = executor.run(() => assert.fail('Queued work must not start after shutdown'));
  await assert.rejects(executor.run(() => {}), { code: 'BUSY' });
  const rejection = assert.rejects(queued, { code: 'CLOSED' }); executor.close(); await rejection;
  assert.equal(finished, false); gate.resolve(); await running; assert.equal(finished, true);
});

test('request ledger shares concurrent outcomes, rejects argument changes, and never replays evicted IDs', async () => {
  const ledger = new RequestLedger(2), gate = deferred(); let calls = 0;
  const work = () => { calls++; return gate.promise; };
  const first = ledger.run(1, 'same', work), retry = ledger.run(1, 'same', work);
  assert.equal(first, retry); await Promise.resolve(); assert.equal(calls, 1);
  assert.throws(() => ledger.run(1, 'different', work), { code: 'REQUEST_REUSED' });
  gate.resolve({ completed: 1 }); assert.deepEqual(await first, { completed: 1 });
  await ledger.run(2, 'two', () => {}); await ledger.run(3, 'three', () => {});
  assert.throws(() => ledger.run(1, 'same', work), { code: 'REQUEST_EXPIRED' }); assert.equal(calls, 1);
  const failed = ledger.run(4, 'failed', () => { throw new PaneError('FAILED', 'Synthetic failure'); });
  await assert.rejects(failed, { code: 'FAILED' }); assert.equal(ledger.run(4, 'failed', work), failed);
});

test('cancellation during an awaited guard prevents the next input', async () => {
  const fixture = runnerFixture();
  fixture.evaluate = count => { if (count === 2) fixture.controller.abort(); return 'same'; };
  const result = await fixture.run([{ op: 'click', ref: 'e1' }]);
  assert.equal(result.error.code, 'CANCELLED'); assert.equal(result.completed, 0); assert.equal(result.mayHaveActed, false);
  assert.equal(fixture.calls.length, 0); assert.equal(fixture.disposed(), 1);
});

test('changed signatures fail preflight and detached/changed handles cannot be retargeted', async () => {
  const fixture = runnerFixture(); fixture.tab.snapshot = async () => '- button "Purchase" [ref=e1]';
  await assert.rejects(fixture.run([{ op: 'click', ref: 'e1' }]), { code: 'STALE_REF' });
  assert.equal(fixture.calls.length, 0);
  for (const descriptor of [null, 'different']) {
    const testCase = runnerFixture(); testCase.evaluate = count => count === 1 ? 'same' : descriptor;
    const result = await testCase.run([{ op: 'click', ref: 'e1' }]);
    assert.equal(result.error.code, 'TARGET_CHANGED'); assert.equal(testCase.calls.length, 0); assert.equal(testCase.disposed(), 1);
  }
});

test('batch reports an exact applied prefix and never starts steps after failure or navigation', async () => {
  const steps = Array.from({ length: 3 }, () => ({ op: 'click', ref: 'e1' }));
  const fixture = runnerFixture(); fixture.perform = async () => { if (fixture.calls.length === 2) throw new Error('Synthetic failure'); };
  const failure = await fixture.run(steps);
  assert.equal(failure.completed, 1); assert.equal(failure.failedStep, 1); assert.equal(failure.mayHaveActed, true);
  assert.equal(fixture.calls.length, 2); assert.equal(fixture.disposed(), 1);
  const navigated = runnerFixture(); navigated.perform = async () => { navigated.tab.document++; };
  const result = await navigated.run(steps);
  assert.equal(result.completed, 1); assert.equal(result.stopped, 'navigation'); assert.equal(navigated.calls.length, 1);
});

function sessionsFixture() {
  const executor = new SerialExecutor(), tab = { id: 't1', document: 1, mutation: 0,
    page: { url: () => 'https://fixture.invalid/', title: async () => 'Fixture', isClosed: () => false },
    snapshot: async () => '- button "Save" [ref=e1]', metadata: () => ({}), consume() { this.mutation++; },
    assert(document, mutation) { if (document !== this.document || mutation !== this.mutation) throw new PaneError('STALE_VIEW', 'Changed'); } };
  let actions = 0, ids = 0;
  const browser = { tab: () => tab, list: async () => [] };
  const create = lease => new PaneSession({ browser, executor, lease, ledger: new RequestLedger(),
    observations: new ObservationStore({ idFactory: () => `v${++ids}` }),
    actions: { run: async () => { actions++; return { completed: 1 }; } } });
  const invoke = async (session, name, args) => JSON.parse((await session.callTool(name, args)).content[0].text);
  return { create, invoke, tab, actions: () => actions, executor };
}

test('leases, latest observations and shared mutation epochs prevent stale or cross-client actions', async () => {
  const fixture = sessionsFixture(), a = fixture.create('lease-a'), b = fixture.create('lease-b');
  const viewA = await fixture.invoke(a, 'pane_view', {}), viewB = await fixture.invoke(b, 'pane_view', {});
  const args = { tab: 't1', view: viewA.view, lease: 'lease-a', request: 1, steps: [{ op: 'click', ref: 'e1' }], observe: 'none' };
  assert.equal((await fixture.invoke(b, 'pane_act', args)).error.code, 'STALE_SESSION');
  const first = await fixture.invoke(a, 'pane_act', args); assert.equal(first.completed, 1);
  assert.deepEqual(await fixture.invoke(a, 'pane_act', args), first); assert.equal(fixture.actions(), 1);
  const stale = await fixture.invoke(b, 'pane_act', { ...args, view: viewB.view, lease: 'lease-b' });
  assert.equal(stale.error.code, 'STALE_VIEW'); assert.equal(fixture.actions(), 1);
  await a.close(); assert.equal((await fixture.invoke(a, 'pane_tabs', {})).error.code, 'SESSION_CLOSED'); fixture.executor.close();
});

test('semantic flow resolves unique targets per verified stage and replays one recorded outcome', async () => {
  const executor = new SerialExecutor(); let ids = 0, calls = 0;
  const tab = { id: 't1', document: 1, mutation: 0, dialog: undefined,
    snapshotText: '- textbox "Email" [ref=e1]\n- button "Continue" [ref=e2]',
    snapshot: async function() { return this.snapshotText; },
    page: { url: () => 'https://fixture.invalid/', title: async () => 'Fixture', isClosed: () => false },
    metadata: () => ({}), consume() { this.mutation++; },
    assert(document, mutation) { if (document !== this.document || mutation !== this.mutation) throw new PaneError('STALE_VIEW', 'Changed'); } };
  const actions = { run: async (_tab, args, observation) => {
    calls++; assert.equal(observation.refs.size, args.steps.length);
    if (calls === 1) {
      assert.deepEqual(args.steps.map(step => [step.op, step.ref]), [['fill', 'e1'], ['click', 'e2']]);
      tab.snapshotText = '- button "Finish" [ref=e3]';
    } else assert.deepEqual(args.steps, [{ op: 'click', ref: 'e3' }]);
    return { completed: args.steps.length };
  } };
  const browser = { tab: () => tab };
  const observations = new ObservationStore({ idFactory: () => `v${++ids}` });
  const session = new PaneSession({ browser, executor, actions, lease: 'lease',
    flow: new FlowRunner({ browser, actions, observations }), ledger: new RequestLedger(), observations });
  const args = { lease: 'lease', request: 1, observe: 'none', stages: [{ steps: [
    { op: 'fill', target: { role: 'textbox', name: 'Email' }, text: 'user@example.invalid' },
    { op: 'click', target: { role: 'button', name: 'Continue' } },
  ], wait: { text: 'next' } }, { steps: [{ op: 'click', target: { role: 'button', name: 'Finish' } }] }] };
  const invoke = async value => JSON.parse((await session.callTool('pane_flow', value)).content[0].text);
  const result = await invoke(args);
  assert.equal(result.completed, 3); assert.equal(result.stages, 2); assert.equal(calls, 2);
  assert.deepEqual(await invoke(args), result); assert.equal(calls, 2);
  tab.snapshotText = '- button "Save" [ref=e4]\n- button "Save" [ref=e5]';
  const ambiguous = await invoke({ lease: 'lease', request: 2, observe: 'none',
    stages: [{ steps: [{ op: 'click', target: { role: 'button', name: 'Save' } }] }] });
  assert.equal(ambiguous.error.code, 'AMBIGUOUS_TARGET'); assert.equal(calls, 2);
  executor.close();
});
