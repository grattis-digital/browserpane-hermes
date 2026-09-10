import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HostTimingWindow } from '../scripts/render-pilot/host-timing-window.mjs';
import { RenderOracle } from '../scripts/render-pilot/oracle.mjs';

const fields = 'capture_us=10 scroll_us=2 classify_us=3 dirty_us=4 encode_send_us=5 total_us=24 budget_wait_us=6 interval_us=16666 dirty_tiles=1 readback_requested_pixels=576 readback_repair_bytes=0 readback_repair_us=0 x11_request_us=8 x11_copy_us=2 x11_copy_bytes=2304 x11_shm_requests=1 x11_get_image_requests=0 readback_regional=true readback_fallback=false';
test('host timing windows exclude cold oracle and earlier phases', () => {
  const start = Date.parse('2026-01-01T00:00:01Z');
  const logs = [0, 1, 2, 3].map(n => `2026-01-01T00:00:0${n}.123456Z WARN bpane_capture_timings: capture timings capture_seq=${n + 1} ${fields}`).join('\n');
  const result = HostTimingWindow.parse(logs, start, start + 1500);
  assert.equal(result.timings.observedCaptures, 2);
  assert.equal(result.readback.firstSequence, 2); assert.equal(result.readback.lastSequence, 3);
  assert.match(result.timings.scope, /Selected phase/);
  assert.match(result.scope, /Not a causal/);
});
test('missing timestamp, empty interval and malformed bounds cannot report host timing coverage', () => {
  assert.throws(() => HostTimingWindow.parse('bpane_capture_timings: capture timings ' + fields, 1, 2), /timestamp/);
  assert.throws(() => HostTimingWindow.parse('', 1, 2), /No opt-in/);
  assert.throws(() => HostTimingWindow.parse('', 2, 1));
});
test('per-process CPU counts retain start-time identity, expose churn and reject rollback', () => {
  const before = { '1:10': { role: 'gpu', cpuUsec: 100 }, '2:12': { role: 'host', cpuUsec: 10 } };
  const after = { '1:10': { role: 'gpu', cpuUsec: 1000100 }, '2:15': { role: 'host', cpuUsec: 99 } };
  const result = RenderOracle.processDelta(before, after, 2);
  assert.equal(result.meanCpuCoresByRole.gpu, .5); assert.equal(result.started, 1); assert.equal(result.exited, 1);
  after['1:10'].cpuUsec = 0;
  assert.throws(() => RenderOracle.processDelta(before, after, 2), /counter/);
});
