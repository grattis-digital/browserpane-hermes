import assert from 'node:assert/strict';
import { CaptureTimingSummary } from '../viewer-pipeline-metrics.mjs';
import { ReadbackDiagnostics } from '../readback-diagnostics.mjs';

export class HostTimingWindow {
  static parse(logs, startMs, endMs) {
    assert(typeof logs === 'string' && logs.length <= 2 * 1024 * 1024);
    assert(Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs);
    const lines = logs.replace(/\x1b\[[0-9;]*m/g, '').split('\n').filter(line => {
      if (!line.includes('bpane_capture_timings') || !line.includes('capture timings')) return false;
      const match = /\b(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z)\b/.exec(line);
      assert(match && Number.isFinite(Date.parse(match[1])), 'Missing host log timestamp');
      const time = Date.parse(match[1]);
      return time >= startMs && time <= endMs;
    }).join('\n');
    const timings = CaptureTimingSummary.parse(lines);
    timings.scope = 'Selected phase completion-log sample; microseconds except dirty_tiles; no exact input/frame join or network/viewer timing';
    return { timings, readback: ReadbackDiagnostics.parse(lines),
      scope: 'Capture completion log timestamps within Pi wall-clock phase bounds (millisecond precision); boundary capture may start earlier. Not a causal input/frame mapping.' };
  }
}
