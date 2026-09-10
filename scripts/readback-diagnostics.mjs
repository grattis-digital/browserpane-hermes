import assert from 'node:assert/strict';

// Backward-compatible optional diagnostics, kept separate from latency runs.
export class ReadbackDiagnostics {
  static parse(logs) {
    assert.equal(typeof logs, 'string');
    const rows = [];
    const fields = ['capture_seq', 'readback_requested_pixels', 'readback_repair_bytes', 'readback_repair_us',
      'x11_request_us', 'x11_copy_us', 'x11_copy_bytes', 'x11_shm_requests', 'x11_get_image_requests'];
    for (const line of logs.replace(/\x1b\[[0-9;]*m/g, '').split('\n')) {
      if (!line.includes('bpane_capture_timings') || !line.includes('capture timings')) continue;
      assert(line.includes('readback_regional='), 'Missing readback instrumentation; do not combine different builds');
      const row = {};
      for (const field of fields) {
        const match = line.match(new RegExp(`\\b${field}=(\\d+)(?=\\s|$)`));
        assert(match && Number.isSafeInteger(Number(match[1])), `Invalid readback metric: ${field}`);
        row[field] = Number(match[1]);
      }
      for (const field of ['readback_regional', 'readback_fallback']) {
        const match = line.match(new RegExp(`\\b${field}=(true|false)(?=\\s|$)`));
        assert(match, `Invalid readback boolean: ${field}`); row[field] = match[1] === 'true';
      }
      assert(!rows.length || row.capture_seq > rows.at(-1).capture_seq, 'Capture restart/duplicate; split the run');
      rows.push(row);
    }
    assert(rows.length, 'No capture diagnostics');
    const metrics = {};
    for (const field of fields.slice(1)) {
      const values = rows.map(row => row[field]).sort((a, b) => a - b);
      const sum = values.reduce((a, b) => a + b, 0);
      assert(Number.isSafeInteger(sum));
      metrics[field] = { sum, p50: values[Math.ceil(values.length * .5) - 1],
        p95: values[Math.ceil(values.length * .95) - 1], max: values.at(-1) };
    }
    return { observedCaptures: rows.length, firstSequence: rows[0].capture_seq,
      lastSequence: rows.at(-1).capture_seq, regionalCaptures: rows.filter(r => r.readback_regional).length,
      fallbacks: rows.filter(r => r.readback_fallback).length, metrics,
      scope: 'Diagnostic log sample only. X11 request includes server wait/readback/synchronization and socket parsing, not a GPU timer. Copy bytes are explicit application copies, not memory-bus traffic. No per-input attribution.' };
  }
}
