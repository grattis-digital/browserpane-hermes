import assert from 'node:assert/strict';

/** Independent, closed synthetic-report oracle. Never trusts a banner/tool status. */
export class WorkflowReportOracle {
  static period(value) { return typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value); }

  static verify(expected, artifact) {
    assert(WorkflowReportOracle.period(expected?.period), 'Invalid expected reporting period');
    assert(Array.isArray(expected.rows) && expected.rows.length > 0 && expected.rows.length <= 1000);
    const rows = new Map();
    for (const row of expected.rows) {
      assert(/^ITEM-\d{4}$/.test(row.code) && Number.isSafeInteger(row.quantity) && row.quantity >= 0);
      assert(!rows.has(row.code)); rows.set(row.code, row.quantity);
    }
    const fail = reason => ({ verified: false, reason });
    if (!artifact || artifact.completed !== true) return fail('INCOMPLETE_DOWNLOAD');
    if (artifact.requests !== 1 || artifact.clicks !== 1 || artifact.trusted !== true) return fail('DUPLICATE_OR_UNTRUSTED_INPUT');
    if (artifact.requestedPeriod !== expected.period) return fail('WRONG_REQUEST_PERIOD');
    if (artifact.filename !== `report-${expected.period}.csv`) return fail('WRONG_FILENAME');
    if (typeof artifact.csv !== 'string' || artifact.csv.length > 32768) return fail('ARTIFACT_SIZE');
    const lines = artifact.csv.replaceAll('\r\n', '\n').split('\n');
    if (lines.at(-1) === '') lines.pop();
    if (lines.shift() !== 'period,code,quantity') return fail('WRONG_SCHEMA');
    if (lines.length !== rows.size) return fail('WRONG_ROW_COUNT');
    const seen = new Set();
    for (const line of lines) {
      // Deliberately not a general CSV parser: quotes/formulas/extra columns fail closed.
      const fields = line.split(',');
      if (fields.length !== 3 || !/^\d+$/.test(fields[2])) return fail('INVALID_ROW');
      const [period, code, quantity] = fields;
      if (period !== expected.period) return fail('WRONG_CONTENT_PERIOD');
      if (!rows.has(code) || seen.has(code) || Number(quantity) !== rows.get(code)) return fail('WRONG_CONTENT');
      seen.add(code);
    }
    return { verified: true, rows: seen.size };
  }
}
