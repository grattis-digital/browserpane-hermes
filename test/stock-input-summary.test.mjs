import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StockInputSummary } from '../scripts/render-pilot/stock-input-summary.mjs';
import { StockTraceSummary } from '../scripts/render-pilot/stock-trace-summary.mjs';

const fields = ['INPUT_EVENT_LATENCY_ORIGINAL', 'INPUT_EVENT_LATENCY_RENDERER_MAIN',
  'INPUT_EVENT_LATENCY_RENDERING_SCHEDULED_MAIN', 'INPUT_EVENT_LATENCY_RENDERER_SWAP',
  'DISPLAY_COMPOSITOR_RECEIVED_FRAME', 'INPUT_EVENT_GPU_SWAP_BUFFER', 'INPUT_EVENT_LATENCY_FRAME_SWAP'];
const fixture = () => [{ ph: 'I', name: 'bph-input-4', ts: 125 },
  { ph: 'b', name: 'InputLatency::RawKeyDown', ts: 100, args: { chrome_latency_info: {
    trace_id: -6575681079400090000, component_info: fields.map((name, i) => ({
      component_type: 'COMPONENT_' + name, time_us: 100 + i * 20 })) } } }];

test('Chromium component timing pairs one unique handler mark without rounded trace IDs', () => {
  const result = StockInputSummary.extract(fixture());
  const record = result.records[0];
  assert.equal(record.sequence, 4); assert.equal(record.browserInputToSwapUs, 120);
  assert.equal(record.dispatchUs, 20); assert.equal(record.gpuSwapUs, 20);
  assert.equal(Object.hasOwn(record, 'trace_id'), false);
  const paired = StockInputSummary.pair(result, [{ sequence: 4, matched: true, latencyMs: .2 }]);
  assert.equal(paired.summary.remainderUs.p50Us, 80);
});
test('missing, duplicate, unordered and ambiguous Chromium components cannot create timing pairs', () => {
  const missing = fixture(); missing[1].args.chrome_latency_info.component_info.pop();
  const result = StockInputSummary.extract(missing);
  assert.equal(result.missingComponents, 1);
  assert.throws(() => StockInputSummary.pair(result, [{ sequence: 4, matched: true, latencyMs: 1 }]), /coverage/);
  for (const change of [events => events.push({ ph: 'I', name: 'bph-input-5', ts: 130 }),
    events => events[1].args.chrome_latency_info.component_info.push({ ...events[1].args.chrome_latency_info.component_info[0] }),
    events => { events[1].args.chrome_latency_info.component_info[2].time_us = 1; }]) {
    const events = fixture(); change(events); assert.throws(() => StockInputSummary.extract(events));
  }
  assert.throws(() => StockInputSummary.pair(StockInputSummary.extract(fixture()),
    [{ sequence: 4, matched: true, latencyMs: .01 }]), /exceeds/);
});
test('non-key workloads do not claim keyed latency coverage', () => {
  assert.deepEqual(StockInputSummary.extract(fixture().slice(1)).records, []);
});
test('thread CPU is distinct from elapsed wall time, with missing CPU coverage explicit', () => {
  const result = StockTraceSummary.summarize([
    { ph: 'X', ts: 1, name: 'gpu', pid: 1, tid: 1, dur: 100, tdur: 20 },
    { ph: 'X', ts: 110, name: 'gpu', pid: 1, tid: 1, dur: 10 },
  ]).durations[0];
  assert.equal(result.inclusiveTotalUs, 110); assert.equal(result.threadCpu.inclusiveTotalUs, 20);
  assert.equal(result.threadCpu.n, 1); assert.equal(result.n, 2);
});
