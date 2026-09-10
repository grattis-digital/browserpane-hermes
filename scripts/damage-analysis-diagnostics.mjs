import assert from 'node:assert/strict';

// Content-free counts. These explain choices, not GPU duration or wire savings.
export class DamageAnalysisDiagnostics {
  static parse(logs) {
    assert.equal(typeof logs, 'string');
    const rows = [], choices = {}, reasons = {};
    for (const line of logs.replace(/\x1b\[[0-9;]*m/g, '').split('\n')) {
      if (!line.includes('bpane_capture_timings') || !line.includes('capture timings')) continue;
      const row = {};
      for (const key of ['capture_seq', 'damage_rects', 'damage_area', 'damage_width', 'damage_height',
        'classify_current_tiles', 'classify_previous_tiles', 'classify_reused_tiles', 'classify_inactive_tiles']) {
        const match = line.match(new RegExp(`\\b${key}=(\\d+)(?=\\s|$)`));
        assert(match && Number.isSafeInteger(Number(match[1])), 'Invalid/missing analysis metric: ' + key);
        row[key] = Number(match[1]);
      }
      for (const [key, allowed] of [
        ['readback_choice', ['disabled', 'forced', 'no_history', 'unknown_damage', 'invalid_damage', 'broad_damage', 'regional']],
        ['damage_reason', ['unavailable', 'known', 'invalidated', 'empty', 'ack_failed', 'geometry_mismatch']],
      ]) {
        const match = line.match(new RegExp(`\\b${key}="?([a-z_]+)"?(?=\\s|$)`));
        assert(match && allowed.includes(match[1]), 'Invalid/missing decision: ' + key);
        row[key] = match[1];
      }
      assert(!rows.length || row.capture_seq > rows.at(-1).capture_seq, 'Split capture restart/duplicate runs');
      rows.push(row);
      choices[row.readback_choice] = (choices[row.readback_choice] ?? 0) + 1;
      reasons[row.damage_reason] = (reasons[row.damage_reason] ?? 0) + 1;
    }
    assert(rows.length, 'No damage-analysis diagnostics');
    const totals = {};
    for (const key of ['classify_current_tiles', 'classify_previous_tiles', 'classify_reused_tiles', 'classify_inactive_tiles']) {
      totals[key] = rows.reduce((sum, row) => sum + row[key], 0);
      assert(Number.isSafeInteger(totals[key]));
    }
    return { captures: rows.length, choices, reasons, totals, rows,
      scope: 'Diagnostic decisions and hash work; neither GPU timing nor an input/frame join' };
  }
}
