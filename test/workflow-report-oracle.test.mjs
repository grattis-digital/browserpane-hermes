import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowReportOracle } from '../scripts/workflow-report-oracle.mjs';

class ReportCase {
  expected() { return { period: '2026-03', rows: [{ code: 'ITEM-0001', quantity: 3 }, { code: 'ITEM-0002', quantity: 6 }] }; }
  artifact(changes = {}) { return { completed: true, requests: 1, clicks: 1, trusted: true, requestedPeriod: '2026-03',
    filename: 'report-2026-03.csv', csv: 'period,code,quantity\n2026-03,ITEM-0001,3\n2026-03,ITEM-0002,6\n', ...changes }; }
}

test('business verifier accepts exact held-out periods, rows and quantities', () => {
  const fixture = new ReportCase();
  assert.deepEqual(WorkflowReportOracle.verify(fixture.expected(), fixture.artifact()), { verified: true, rows: 2 });
  for (let month = 1; month <= 12; month++) {
    const period = `2027-${String(month).padStart(2, '0')}`;
    const expected = { period, rows: [{ code: 'ITEM-0001', quantity: month }] };
    assert(WorkflowReportOracle.verify(expected, fixture.artifact({ requestedPeriod: period,
      filename: `report-${period}.csv`, csv: `period,code,quantity\n${period},ITEM-0001,${month}\n` })).verified);
  }
});

test('completion and success banners do not override wrong or incomplete business results', () => {
  const fixture = new ReportCase();
  for (const changes of [{ completed: false }, { clicks: 2 }, { requests: 2 }, { trusted: false },
    { filename: 'report.csv' }, { requestedPeriod: '2026-02' }, { csv: '' }, { csv: 'x'.repeat(32769) },
    { csv: fixture.artifact().csv.replaceAll('2026-03', '2026-02') },
    { csv: fixture.artifact().csv.replace('code', 'description') },
    { csv: fixture.artifact().csv.replace('ITEM-0002', 'ITEM-0001') },
    { csv: fixture.artifact().csv.replace(',6', ',7') }, { csv: fixture.artifact().csv.replace(',6', ',=3+3') },
    { csv: fixture.artifact().csv + '2026-03,ITEM-0003,9\n' }]) {
    assert.equal(WorkflowReportOracle.verify(fixture.expected(), fixture.artifact({ banner: 'Success!', toolCompleted: true, ...changes })).verified, false);
  }
});

test('invalid expected contracts fail before interpreting an artifact', () => {
  const fixture = new ReportCase();
  for (const expected of [{ period: '2026-13', rows: [] }, { period: '2026-01', rows: [] },
    { period: '2026-03', rows: [{ code: 'ITEM-0001', quantity: -1 }] }]) {
    assert.throws(() => WorkflowReportOracle.verify(expected, fixture.artifact()));
  }
});
