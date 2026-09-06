import assert from 'node:assert/strict';
import { McpBaselineFixture } from './mcp-baseline-fixture.mjs';

/** Backend contract: navigate/observeForm/fill/submit/readReceipt/observeTable/readTable.
 * Compact adapters may combine fill+submit; pages, values, oracle and completion checks stay identical.
 */
export class McpBenchmarkWorkflow {
  #fixture;
  #session;
  constructor(fixture, session) { this.#fixture = fixture; this.#session = session; }
  static expected(iteration) {
    assert(Number.isInteger(iteration) && iteration >= 0);
    return { fullName: `Casey Example ${iteration}`, email: `casey.${iteration}@example.invalid`, plan: 'Research', consent: true };
  }
  static verifyTableObservation(text) {
    const observed = [...new Set(text.match(/\bROW-\d{3}\b/g) ?? [])].sort();
    assert.deepEqual(observed, Array.from({ length: McpBaselineFixture.tableRows }, (_, index) => `ROW-${String(index).padStart(3, '0')}`),
      'Equal-information table observation must include every synthetic row, not just its endpoints');
  }
  static verifyReceipt(state, expected) {
    assert(state.receipt, 'Submission must navigate to a receipt containing submitted state');
    const { events, ...values } = state.receipt; assert.deepEqual(values, expected);
    assert(Array.isArray(events) && events.length > 0 && events.length < 80);
    for (const [target, value] of [['full-name', expected.fullName], ['email', expected.email], ['plan', expected.plan]]) {
      const inputs = events.filter(event => event.type === 'input' && event.target === target);
      assert.equal(inputs.length, 1, `${target} must receive exactly one completed fill/select input`);
      assert.equal(inputs[0].value, value);
      // Playwright selectOption intentionally dispatches synthetic input/change.
      if (target !== 'plan') assert.equal(inputs[0].trusted, true, `${target} input must be browser-generated`);
    }
    const consent = events.filter(event => event.type === 'click' && event.target === 'consent');
    assert.equal(consent.length, 1); assert.equal(consent[0].trusted, true); assert.equal(consent[0].value, true);
    const clicks = events.filter(event => event.type === 'click' && event.target === 'BUTTON');
    const submits = events.filter(event => event.type === 'submit');
    assert.equal(clicks.length, 1); assert.equal(clicks[0].trusted, true);
    assert.equal(submits.length, 1); assert.equal(submits[0].trusted, true);
    assert(events.indexOf(clicks[0]) < events.indexOf(submits[0]));
    assert(events.every(event => Number.isFinite(event.wallMs)));
    return { events, clickWallMs: clicks[0].wallMs, submitWallMs: submits[0].wallMs };
  }
  async run(backend, iteration, { batched = false } = {}) {
    const started = performance.now(), expected = McpBenchmarkWorkflow.expected(iteration);
    await backend.navigate(this.#fixture.url('form'), 'navigate.form');
    await this.#fixture.read(await this.#session.page(this.#fixture, 'form'), 'form');
    await backend.observeForm();
    if (batched) { assert.equal(typeof backend.fillAndSubmit, 'function'); await backend.fillAndSubmit(expected); }
    else { await backend.fill(expected); await backend.submit(); }
    const completedWallMs = backend.lastCompletedWallMs();
    const receipt = await this.#fixture.read(await this.#session.page(this.#fixture, 'receipt'), 'receipt');
    const events = McpBenchmarkWorkflow.verifyReceipt(receipt, expected);
    assert.deepEqual(await backend.readReceipt(), expected, 'MCP read must match independently verified page state');
    await backend.navigate(this.#fixture.url('table'), 'navigate.table');
    const table = await this.#fixture.read(await this.#session.page(this.#fixture, 'table'), 'table');
    assert.equal(table.rowCount, McpBaselineFixture.tableRows);
    await backend.observeTable();
    assert.deepEqual(await backend.readTable(), { rows: 120, total: 7260, first: 'ROW-000', last: 'ROW-119' });
    this.#session.assertHealthy();
    return { iteration, batched, elapsedIncludingOracleMs: performance.now() - started, expected,
      verifiedReceipt: true, verifiedTable: true, events: events.events,
      submitResponseAfterEventWallMs: completedWallMs - events.submitWallMs,
      submitResponseAfterReceiptReadyWallMs: completedWallMs - receipt.readyWallMs };
  }
}
