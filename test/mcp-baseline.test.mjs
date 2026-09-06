import test from 'node:test';
import assert from 'node:assert/strict';
import { McpBaselineFixture } from '../scripts/mcp-baseline-fixture.mjs';
import { McpBaselineMetrics } from '../scripts/mcp-baseline-metrics.mjs';
import { McpBaselineSession } from '../scripts/mcp-baseline-session.mjs';
import { McpBenchmarkWorkflow } from '../scripts/mcp-baseline-workflow.mjs';
import { PlaywrightMcpBaselineBackend } from '../scripts/benchmark-mcp-baseline.mjs';
import { CompactMcpBenchmarkBackend } from '../scripts/mcp-compact-workflow.mjs';

test('byte accounting separates Unicode code points, UTF8 bytes and JSON bytes', () => {
  const result = { content: [{ type: 'text', text: 'Aé😀' }, { type: 'image', data: 'synthetic', mimeType: 'image/png' }] };
  const size = McpBaselineMetrics.size(result);
  assert.equal(size.textCodePoints, 3); assert.equal(size.textBytes, 7);
  assert.equal(size.jsonBytes, Buffer.byteLength(JSON.stringify(result)));
  assert.equal(size.estimatedTextTokensCharsDiv4, 1);
  assert.match(size.jsonSha256, /^[a-f0-9]{64}$/);
});

test('percentiles use nearest rank without interpolation and reject empty/invalid data', () => {
  assert.equal(McpBaselineMetrics.percentile([4, 1, 3, 2], 0.5), 2);
  assert.equal(McpBaselineMetrics.percentile(Array.from({ length: 20 }, (_, i) => i + 1), 0.95), 19);
  for (const values of [[], [-1], [NaN], [Infinity]]) assert.throws(() => McpBaselineMetrics.percentile(values, 0.5));
});

test('warmups are retained raw but excluded from summaries; MCP errors cannot pass', async () => {
  const metrics = new McpBaselineMetrics();
  await metrics.measure({ operation: 'read', iteration: 0, warmup: true }, async () => ({ content: [{ type: 'text', text: 'long warmup' }] }));
  await metrics.measure({ operation: 'read', iteration: 1, warmup: false }, async () => ({ content: [{ type: 'text', text: 'ok' }] }));
  assert.equal(metrics.samples().length, 2); assert.equal(metrics.summarize().read.latencyMs.samples, 1);
  assert.equal(metrics.summarize().read.textBytes.median, 2);
  await assert.rejects(metrics.measure({ operation: 'failed', iteration: 1 }, async () => ({ isError: true })), /MCP tool failed/);
  assert.equal(metrics.samples().at(-1).isError, true);
  assert(!Object.hasOwn(metrics.summarize(), 'failed'));
});

test('baseline references must originate from one exact named snapshot target', () => {
  assert.equal(PlaywrightMcpBaselineBackend.ref('- textbox "Full name" [ref=e12]', 'textbox', 'Full name'), 'e12');
  assert.throws(() => PlaywrightMcpBaselineBackend.ref('- textbox "Other" [ref=e12]', 'textbox', 'Full name'));
  assert.throws(() => PlaywrightMcpBaselineBackend.ref('- textbox "Full name" [ref=e1]\n- textbox "Full name" [ref=e2]', 'textbox', 'Full name'));
  assert.deepEqual(PlaywrightMcpBaselineBackend.value({ content: [{ type: 'text', text: '### Result\n{"ok":true}\n### Page\nunchanged' }] }), { ok: true });
  assert.throws(() => PlaywrightMcpBaselineBackend.value({ content: [{ type: 'text', text: '### Result\nnot json' }] }));
});

test('full-table observation cannot pass using only endpoints and cleanup is bounded', async () => {
  assert.throws(() => McpBenchmarkWorkflow.verifyTableObservation('ROW-000 ROW-119'), /every synthetic row/);
  McpBenchmarkWorkflow.verifyTableObservation(Array.from({ length: 120 }, (_, index) => `ROW-${String(index).padStart(3, '0')}`).join('\n'));
  await assert.rejects(McpBaselineSession.deadline(() => new Promise(() => {}), 5), /deadline/);
  assert.equal(await McpBaselineSession.deadline(async () => 'closed'), 'closed');
});

test('paginated operation totals sum calls before computing per-workflow percentiles', () => {
  const calls = [3, 8].map(latencyMs => ({ operation: 'observe.table', latencyMs, jsonBytes: 100, textBytes: 80, estimatedTextTokensCharsDiv4: 20 }));
  const operations = McpBaselineMetrics.totals(calls);
  assert.deepEqual(operations['observe.table'], { calls: 2, latencyMs: 11, jsonBytes: 200, textBytes: 160, estimatedTextTokensCharsDiv4: 40 });
  assert.equal(McpBaselineMetrics.summarizeTotals([{ operations }])['observe.table'].latencyMs.median, 11);
});

test('compact adapter sums full pagination then reads an exact observed table summary over MCP', async () => {
  const text = Array.from({ length: 120 }, (_, index) => `- row "ROW-${String(index).padStart(3, '0')} Synthetic inventory item ${index} ${index + 1}" [ref=e${index}]:`).join('\n');
  const payloads = [{ v: 1, lease: 'owned', tabs: [{ tab: 't1' }] },
    { v: 1, lease: 'owned', tab: 't1', view: 'view0', mode: 'full', text: '' },
    { v: 1, lease: 'owned', tab: 't1', view: 'view1', mode: 'full', text: '- table [ref=e999]:\n' + text.split('\n').slice(0, 60).join('\n'), next: 60 },
    { v: 1, lease: 'owned', tab: 't1', view: 'view2', mode: 'full', text: '- table [ref=e999]:\n' + text.split('\n').slice(60).join('\n') },
    { v: 1, lease: 'owned', tab: 't1', view: 'view2', data: { rows: 120, headers: ['Code', 'Description', 'Quantity'],
      first: ['ROW-000', 'Synthetic inventory item 0', '1'], last: ['ROW-119', 'Synthetic inventory item 119', '120'],
      numeric: { column: 2, count: 120, nonNumeric: 0, sum: 7260, min: 1, max: 120 } } }];
  const requests = [], metrics = new McpBaselineMetrics();
  const backend = new CompactMcpBenchmarkBackend({ callTool: async request => {
    requests.push(request); assert(payloads.length); return { content: [{ type: 'text', text: JSON.stringify(payloads.shift()) }] };
  } }, metrics);
  await backend.initialize(); backend.trial(0, false);
  await backend.observeTable();
  assert.deepEqual(await backend.readTable(), { rows: 120, total: 7260, first: 'ROW-000', last: 'ROW-119' });
  assert.equal(metrics.samples().length, 3); assert.equal(requests[3].arguments.offset, 60);
  assert.deepEqual(requests.at(-1), { name: 'pane_read', arguments: { tab: 't1', view: 'view2', ref: 'e999', mode: 'summary', column: 2 } });
  assert.equal(payloads.length, 0);
});

test('compact navigation cannot silently repair an empty automatic observation with a later full view', async () => {
  const url = 'http://127.0.0.1:12345/owned/form';
  const payloads = [{ v: 1, lease: 'owned', tabs: [{ tab: 't1' }] },
    { v: 1, lease: 'owned', tab: 't1', view: 'old', mode: 'full', text: '' },
    { v: 1, lease: 'owned', completed: 1, observation: { tab: 't1', view: 'new', url, mode: 'full', text: '', offset: 480 } }];
  const backend = new CompactMcpBenchmarkBackend({ callTool: async () => ({ content: [{ type: 'text', text: JSON.stringify(payloads.shift()) }] }) },
    new McpBaselineMetrics());
  await backend.initialize(); backend.trial(0, false);
  await assert.rejects(backend.navigate(url, 'navigate.form'), /stale previous-page projection/);
  assert.equal(payloads.length, 0);
});

function receipt() {
  const expected = McpBenchmarkWorkflow.expected(3);
  const events = [['input', 'full-name', expected.fullName], ['input', 'email', expected.email],
    ['input', 'plan', expected.plan], ['click', 'consent', true], ['click', 'BUTTON'], ['submit', 'contact']]
    .map(([type, target, value], index) => ({ type, target, value, trusted: target !== 'plan', wallMs: 100 + index }));
  return { expected, state: { receipt: { ...expected, events } } };
}

test('state oracle accepts Playwright select semantics but requires trusted fill/click/submit', () => {
  const { state, expected } = receipt();
  assert.equal(McpBenchmarkWorkflow.verifyReceipt(state, expected).submitWallMs, 105);
  for (const mutation of [
    value => { value.receipt.email = 'wrong@example.invalid'; },
    value => { value.receipt.events[0].trusted = false; },
    value => { value.receipt.events.push({ ...value.receipt.events[4] }); },
    value => { value.receipt.events[5].trusted = false; },
  ]) { const altered = structuredClone(state); mutation(altered); assert.throws(() => McpBenchmarkWorkflow.verifyReceipt(altered, expected)); }
});

test('fixture serves only synthetic loopback paths and does not accept POST mutations', async () => {
  const fixture = new McpBaselineFixture();
  try {
    await fixture.start(); assert.match(fixture.origin(), /^http:\/\/127\.0\.0\.1:\d+$/);
    for (const page of ['form', 'receipt', 'table']) {
      const response = await fetch(fixture.url(page)); assert.equal(response.status, 200);
      assert(response.headers.get('content-security-policy').includes("default-src 'none'"));
      assert((await response.text()).includes(fixture.token()));
    }
    assert.equal((await fetch(fixture.origin() + '/unowned')).status, 404);
    assert.equal((await fetch(fixture.url('form'), { method: 'POST' })).status, 404);
    assert.equal((fixture.html('table').match(/<tr>/g) ?? []).length, 121);
    await assert.rejects(fixture.read({ url: () => 'https://unowned.invalid' }, 'form'), /exact synthetic page/);
  } finally { await fixture.close(); }
});
