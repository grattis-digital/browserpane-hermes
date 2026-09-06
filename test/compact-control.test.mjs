import test from 'node:test';
import assert from 'node:assert/strict';
import { RequestLedger } from '../server/compact/request-ledger.mjs';
import { SerialExecutor } from '../server/compact/executor.mjs';
import { PaneValidation } from '../server/compact/validation.mjs';
import { PaneSchemas } from '../server/compact/schemas.mjs';
import { PaneSession } from '../server/compact/session.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const newTab = { lease: 'lease', request: 1, steps: [{ op: 'new', url: 'https://example.test/' }] };

test('concurrent duplicates and lost-response retries share one exact action outcome', async () => {
  const ledger = new RequestLedger(2), gate = deferred(); let calls = 0;
  const work = async () => { calls++; await gate.promise; return { completed: 1 }; };
  const first = ledger.run(1, 'signature', work), second = ledger.run(1, 'signature', work);
  assert.equal(first, second); gate.resolve(); assert.deepEqual(await first, { completed: 1 });
  assert.equal(await ledger.run(1, 'signature', work), await first); assert.equal(calls, 1);
  assert.throws(() => ledger.run(1, 'different', work), { code: 'REQUEST_REUSED' });
});

test('errors are replayed and evicted or out-of-order request IDs never execute again', async () => {
  const ledger = new RequestLedger(2); let calls = 0;
  const fail = async () => { calls++; throw new Error('original'); };
  await assert.rejects(ledger.run(1, 'a', fail), /original/);
  await assert.rejects(ledger.run(1, 'a', fail), /original/); assert.equal(calls, 1);
  await ledger.run(3, 'b', async () => {}); await ledger.run(4, 'c', async () => {});
  assert.throws(() => ledger.run(1, 'a', fail), { code: 'REQUEST_EXPIRED' });
  assert.throws(() => ledger.run(2, 'd', fail), { code: 'REQUEST_EXPIRED' });
  for (const value of [0, -1, 1.5, NaN, Infinity, '5']) assert.throws(() => ledger.run(value, '', fail));
});

test('browser execution serializes clients and rejects overflowing or cancelled queued work', async () => {
  const executor = new SerialExecutor(1), gate = deferred(), order = [];
  const first = executor.run(async () => { order.push('first'); await gate.promise; order.push('finished'); });
  const abort = new AbortController();
  const second = executor.run(async () => order.push('must not run'), abort.signal);
  await assert.rejects(executor.run(async () => {}), { code: 'BUSY' });
  abort.abort(); await assert.rejects(second, { code: 'CANCELLED' });
  const third = executor.run(async () => order.push('third'));
  assert.deepEqual(order, ['first']); gate.resolve(); await Promise.all([first, third]);
  assert.deepEqual(order, ['first', 'finished', 'third']);
});

test('cancelling active input never releases its lock before the native operation settles', async () => {
  const executor = new SerialExecutor(), gate = deferred(), abort = new AbortController(); let ran = false;
  const first = executor.run(async () => gate.promise, abort.signal);
  abort.abort(); const second = executor.run(async () => { ran = true; });
  await Promise.resolve(); assert.equal(ran, false); gate.resolve();
  await Promise.all([first, second]); assert.equal(ran, true);
  executor.close(); await assert.rejects(executor.run(async () => {}), { code: 'CLOSED' });
});

test('all compact tool schemas are bounded and only input is annotated as mutating', () => {
  const tools = PaneSchemas.tools(); assert.equal(tools.length, 5);
  assert.deepEqual(tools.filter(tool => !tool.annotations.readOnlyHint).map(tool => tool.name), ['pane_act']);
  assert(Buffer.byteLength(JSON.stringify(tools)) < 6500);
  tools[0].inputSchema.properties.injected = {}; assert(!PaneSchemas.tools()[0].inputSchema.properties.injected);
});

test('validation rejects unknown fields, unsafe schemes, implicit replay and unbounded batches', () => {
  assert.deepEqual(PaneValidation.parse('pane_act', newTab), newTab);
  const invalid = [null, {}, { ...newTab, lease: undefined }, { ...newTab, force: true },
    { ...newTab, steps: Array.from({ length: 9 }, () => ({ op: 'new' })) },
    { ...newTab, steps: [{ op: 'new', url: 'javascript:alert(1)' }] },
    { ...newTab, steps: [{ op: 'new', url: 'file:///private' }] },
    { ...newTab, steps: [{ op: 'new', url: 'https://u:secret@example.test/' }] },
    { ...newTab, steps: [{ op: 'click', ref: 'e1' }] },
    { ...newTab, tab: 't1', view: 'v1', steps: [{ op: 'click', ref: 'css=button' }] },
    { ...newTab, tab: 't1', view: 'v1', steps: [{ op: 'click', ref: 'e1', text: 'ignored' }] },
    { ...newTab, wait: {} }, { ...newTab, wait: { text: '' } },
    { ...newTab, wait: { text: 'a', url: 'https://example.test/' } },
  ];
  for (const args of invalid) assert.throws(() => PaneValidation.parse('pane_act', args), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => PaneValidation.parse('browser_run_code', {}), { code: 'UNKNOWN_TOOL' });
});

test('reconnected sessions reject old leases before queueing even standalone tab creation', async () => {
  let calls = 0;
  const session = new PaneSession({ lease: 'new-lease', executor: { run() { calls++; } } });
  const result = await session.callTool('pane_act', newTab);
  assert.equal(result.isError, true); assert.equal(JSON.parse(result.content[0].text).error.code, 'STALE_SESSION');
  assert.equal(calls, 0);
  await session.close(); const closed = await session.callTool('pane_tabs', {});
  assert.equal(JSON.parse(closed.content[0].text).error.code, 'SESSION_CLOSED');
});
