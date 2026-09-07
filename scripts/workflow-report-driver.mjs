import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { WorkflowReportOracle } from './workflow-report-oracle.mjs';

/** Scripted benchmark only: all inputs traverse real compact HTTP MCP. */
export class WorkflowReportDriver {
  #session; #fixture; #metrics; #request = 0; #signal;
  constructor(session, fixture, metrics, signal) {
    this.#session = session; this.#fixture = fixture; this.#metrics = metrics; this.#signal = signal;
  }
  async #call(name, args, operation) {
    const result = await this.#metrics.measure({ operation, tool: name }, () =>
      this.#session.client().callTool({ name, arguments: args }, undefined, { timeout: 15000, signal: this.#signal }));
    const value = JSON.parse(result.content[0].text);
    assert.equal(value.v, 1); assert(!value.error && !value.observationError);
    assert(!value.stopped || (operation === 'navigate' && value.stopped === 'navigation' && value.completed === 1));
    return value;
  }
  async run(period, fault, mode) {
    assert(['separate', 'batched'].includes(mode));
    const expected = this.#fixture.select(period, fault);
    const beforeCalls = this.#metrics.samples().length, started = performance.now();
    const view = await this.#call('pane_view', {}, 'observe');
    await this.#call('pane_act', { lease: view.lease, tab: view.tab, view: view.view, request: ++this.#request,
      steps: [{ op: 'navigate', url: this.#fixture.url('report') }], observe: 'full' }, 'navigate');
    const page = await this.#session.page(this.#fixture, 'report');
    const previous = new Set(await this.#session.artifactFiles());
    const input = { op: 'fill', target: { role: 'textbox', name: 'Reporting period', exact: true }, text: period };
    if (mode === 'separate') {
      const fill = await this.#call('pane_flow', { lease: view.lease, tab: view.tab, request: ++this.#request,
        stages: [{ steps: [input] }], observe: 'none' }, 'fill');
      assert.equal(fill.completed, 1); assert.equal(fill.stages, 1);
    }
    const downloadPromise = page.waitForEvent('download', { timeout: 15000 });
    // Observe rejection immediately even if the MCP call fails first.
    downloadPromise.catch(() => {});
    const click = { op: 'click', target: { role: 'link', name: 'Export report', exact: true } };
    const steps = mode === 'batched' ? [input, click] : [click];
    const result = await this.#call('pane_flow', { lease: view.lease, tab: view.tab, request: ++this.#request,
      stages: [{ steps, wait: { text: 'Report exported', timeoutMs: 5000 } }], observe: 'none' }, 'export');
    assert.equal(result.completed, steps.length); assert.equal(result.stages, 1);
    let download;
    try { download = await downloadPromise; }
    catch (error) {
      throw new Error(`No fixture download: ${JSON.stringify(await this.#fixture.diagnostics(page))}`, { cause: error });
    }
    // The MCP CDP connection owns download forwarding; the parent Download.path()
    // may refer to its other connection's nonexistent staging path. Verify the
    // actual atomically forwarded file in the owned MCP artifact directory.
    const deadline = performance.now() + 5000;
    let files;
    do {
      files = (await this.#session.artifactFiles()).filter(name => !previous.has(name));
      if (files.length) break;
      await delay(25, undefined, { signal: this.#signal });
    } while (performance.now() < deadline);
    assert.equal(files.length, 1, 'Exactly one new completed fixture artifact must be forwarded');
    const artifact = await this.#fixture.evidence(page, download, await this.#session.readArtifact(files[0]));
    const verdict = WorkflowReportOracle.verify(expected, artifact);
    this.#session.assertHealthy();
    const calls = this.#metrics.samples().slice(beforeCalls);
    return { period, fault, mode, toolCompleted: true, ...verdict, totalMs: performance.now() - started,
      mcpCalls: calls.length, mcpMs: calls.reduce((sum, row) => sum + row.latencyMs, 0),
      responseJsonBytes: calls.reduce((sum, row) => sum + row.jsonBytes, 0) };
  }
}
