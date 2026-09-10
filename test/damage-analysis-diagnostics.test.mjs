import assert from 'node:assert/strict';
import test from 'node:test';
import { DamageAnalysisDiagnostics } from '../scripts/damage-analysis-diagnostics.mjs';

const line = n => `WARN bpane_capture_timings: capture timings capture_seq=${n} damage_rects=2 damage_area=8192 damage_width=1280 damage_height=720 readback_choice="broad_damage" damage_reason="known" classify_current_tiles=3 classify_previous_tiles=1 classify_reused_tiles=4 classify_inactive_tiles=0`;

test('reports exact eligibility reasons and separate current/baseline hash work', () => {
  const result = DamageAnalysisDiagnostics.parse(line(1) + '\n' + line(2));
  assert.equal(result.choices.broad_damage, 2);
  assert.equal(result.reasons.known, 2);
  assert.equal(result.totals.classify_previous_tiles, 2);
  assert.equal(result.totals.classify_current_tiles, 6);
  assert.equal(result.rows[0].damage_area, 8192);
});

test('rejects old/mixed diagnostics, malformed reasons/counters and restarted runs', () => {
  for (const logs of ['', line(1).replace('damage_reason="known"', 'damage_reason="guess"'),
    line(1).replace('classify_reused_tiles=4', ''), line(1).replace('damage_area=8192', 'damage_area=-1'),
    line(2) + '\n' + line(1)]) assert.throws(() => DamageAnalysisDiagnostics.parse(logs));
});
