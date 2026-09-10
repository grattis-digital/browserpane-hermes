import assert from 'node:assert/strict';
import test from 'node:test';
import { ReadbackDiagnostics } from '../scripts/readback-diagnostics.mjs';

const row = sequence => `WARN bpane_capture_timings: capture timings capture_seq=${sequence} readback_regional=true readback_fallback=false readback_requested_pixels=63 readback_repair_bytes=252 readback_repair_us=3 x11_request_us=150 x11_copy_us=2 x11_copy_bytes=252 x11_shm_requests=1 x11_get_image_requests=0`;
test('counts copies separately from X11 request wait, preserving bounded sample provenance', () => {
  const result = ReadbackDiagnostics.parse(row(5) + '\n' + row(6));
  assert.equal(result.regionalCaptures, 2); assert.equal(result.firstSequence, 5);
  assert.equal(result.metrics.x11_copy_bytes.sum, 504);
  assert.equal(result.metrics.x11_request_us.p95, 150);
  assert.equal(result.fallbacks, 0);
});
test('rejects missing fields, unsafe counters, bad booleans and session restarts', () => {
  for (const logs of ['', row(1).replace('x11_copy_bytes=252', ''), row(1).replace('readback_regional=true', 'readback_regional=1'),
    row(1).replace('x11_copy_bytes=252', 'x11_copy_bytes=999999999999999999999'), row(9)+'\n'+row(1)]) {
    assert.throws(() => ReadbackDiagnostics.parse(logs));
  }
});
