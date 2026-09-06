import test from 'node:test';
import assert from 'node:assert/strict';
import { PaneMetrics } from '../server/compact/metrics.mjs';

test('opt-in timing records aggregate phases without page or input content', async () => {
  let now = 0; const lines = [];
  const trace = new PaneMetrics({ enabled: true, now: () => now, sink: line => lines.push(line) }).start('pane_view');
  now = 2; trace.queueDone();
  await trace.span('snapshotMs', async () => { now = 9; });
  await trace.span('snapshotMs', async () => { now = 12; });
  trace.increment('snapshots', 2); now = 15;
  trace.finish({ content: [{ type: 'text', text: '{"v":1}' }] });
  const record = JSON.parse(lines[0]);
  assert.deepEqual({ kind: record.kind, v: record.v, id: record.id, tool: record.tool, queueMs: record.queueMs,
    snapshotMs: record.snapshotMs, snapshots: record.snapshots, totalMs: record.totalMs, ok: record.ok },
  { kind: 'bpane_mcp_timing', v: 1, id: 'm1', tool: 'pane_view', queueMs: 2,
    snapshotMs: 10, snapshots: 2, totalMs: 15, ok: true });
  assert(!lines[0].includes('http')); assert(!lines[0].includes('selector'));
});

test('disabled timing collection has no trace or sink side effect', () => {
  let calls = 0;
  assert.equal(new PaneMetrics({ enabled: false, sink: () => { calls++; } }).start('pane_act'), undefined);
  assert.equal(calls, 0);
});

test('diagnostic sink failure cannot change a completed browser result', () => {
  const trace = new PaneMetrics({ enabled: true, sink: () => { throw new Error('log unavailable'); } }).start('pane_tabs');
  assert.doesNotThrow(() => trace.finish({ content: [{ type: 'text', text: '{"v":1}' }] }));
});
