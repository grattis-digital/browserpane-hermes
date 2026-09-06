import assert from 'node:assert/strict';
import { McpBaselineMetrics } from './mcp-baseline-metrics.mjs';
import { McpBenchmarkWorkflow } from './mcp-baseline-workflow.mjs';

/** Compact adapter: every browser interaction crosses the same real HTTP MCP boundary. */
export class CompactMcpBenchmarkBackend {
  #client; #metrics; #meta; #lease; #view; #request = 0; #text = ''; #signal;
  constructor(client, metrics, signal) { this.#client = client; this.#metrics = metrics; this.#signal = signal; }
  trial(iteration, warmup) { this.#meta = { iteration, warmup }; }
  static value(result) {
    assert.equal(result.content?.length, 1); assert.equal(result.content[0].type, 'text');
    const value = JSON.parse(McpBaselineMetrics.text(result)); assert.equal(value.v, 1); return value;
  }
  async initialize() {
    const tabs = CompactMcpBenchmarkBackend.value(await this.#client.callTool({ name: 'pane_tabs', arguments: {} }));
    assert.equal(tabs.tabs.length, 1, 'Fresh benchmark owns exactly one initial tab'); this.#lease = tabs.lease;
    const view = CompactMcpBenchmarkBackend.value(await this.#client.callTool({ name: 'pane_view', arguments: { tab: tabs.tabs[0].tab } }));
    this.#accept(view); return { leaseAndInitialViewCalls: 2, excludedFromWorkflowTiming: true };
  }
  #accept(view) {
    assert.equal(view.lease ?? this.#lease, this.#lease); assert.equal(typeof view.view, 'string');
    if (view.mode === 'delta') {
      assert.equal(view.base, this.#view.view); const lines = this.#text === '' ? [] : this.#text.split('\n');
      const splice = view.splice; assert(Number.isInteger(splice.start) && splice.start >= 0 && splice.start <= lines.length);
      assert(Number.isInteger(splice.deleteCount) && splice.deleteCount >= 0 && splice.deleteCount <= lines.length - splice.start);
      assert(splice.lines.every(line => typeof line === 'string'));
      lines.splice(splice.start, splice.deleteCount, ...splice.lines); this.#text = lines.join('\n');
    } else { assert.equal(view.mode, 'full'); assert.equal(typeof view.text, 'string'); this.#text = view.text; }
    this.#view = view;
  }
  async #call(operation, name, args, extra = {}) {
    this.#signal?.throwIfAborted();
    const result = await this.#metrics.measure({ ...this.#meta, operation, tool: name, ...extra,
      argumentJsonBytes: Buffer.byteLength(JSON.stringify(args)) }, () => this.#client.callTool({ name, arguments: args }, undefined,
      { timeout: 15000, signal: this.#signal }));
    return CompactMcpBenchmarkBackend.value(result);
  }
  async #act(operation, steps, wait) {
    const args = { lease: this.#lease, request: ++this.#request, tab: this.#view.tab, view: this.#view.view,
      steps, observe: 'delta', ...(wait ? { wait } : {}) };
    const value = await this.#call(operation, 'pane_act', args, { wait: wait ?? null });
    assert.equal(value.completed, steps.length, 'Compact must execute every requested action exactly once');
    assert(!value.error && !value.observationError); assert(value.observation, 'Action must return its resulting observation');
    this.#accept(value.observation); return value;
  }
  async navigate(url, operation) {
    await this.#act(operation, [{ op: 'navigate', url }]); assert.equal(this.#view.url, url);
    if (operation === 'navigate.form') {
      assert(this.#text.includes('textbox "Full name"') && this.#text.includes('button "Save contact"'),
        'Navigation result must show the new form, not a stale previous-page projection');
    } else if (operation === 'navigate.table') assert(this.#text.includes('ROW-000'), 'New table observation must start at its first row');
  }
  async observeForm() { this.#accept(await this.#call('observe.form', 'pane_view', { tab: this.#view.tab })); }
  #ref(role, name) {
    const lines = this.#text.split('\n').filter(line => line.includes(`${role} "${name}"`));
    assert.equal(lines.length, 1, 'Expected one exact compact snapshot control');
    const ref = lines[0].match(/\[ref=([a-z0-9]+)\]/)?.[1]; assert(ref); return ref;
  }
  #fields(values) {
    return [{ op: 'fill', ref: this.#ref('textbox', 'Full name'), text: values.fullName },
      { op: 'fill', ref: this.#ref('textbox', 'Email address'), text: values.email },
      { op: 'select', ref: this.#ref('combobox', 'Plan'), values: [values.plan] },
      { op: 'check', ref: this.#ref('checkbox', 'Accept terms'), checked: values.consent }];
  }
  fill(values) { return this.#act('fill.form', this.#fields(values)); }
  submit() { return this.#act('submit.navigate', [{ op: 'click', ref: this.#ref('button', 'Save contact') }], { text: 'Contact saved', timeoutMs: 5000 }); }
  fillAndSubmit(values) {
    return this.#act('fill+submit.navigate', [...this.#fields(values), { op: 'click', ref: this.#ref('button', 'Save contact') }],
      { text: 'Contact saved', timeoutMs: 5000 });
  }
  async readReceipt() {
    this.#accept(await this.#call('read.receipt', 'pane_view', { tab: this.#view.tab }));
    const values = [...this.#text.matchAll(/^\s*- definition(?: \[ref=[a-z0-9]+\])?: (.*)$/gm)].map(match => match[1]);
    assert.equal(values.length, 4, 'Receipt values must be read from the returned accessibility text');
    const [fullName, email, plan, consent] = values.map(value => value.startsWith('"') ? JSON.parse(value) : value);
    assert(['true', 'false'].includes(String(consent))); return { fullName, email, plan, consent: String(consent) === 'true' };
  }
  async #table(operation, options = {}) {
    const pages = []; let offset = 0;
    for (let page = 0; page < 20; page++) {
      const view = await this.#call(operation, 'pane_view', { tab: this.#view.tab, ...options, offset }, { page, projection: options });
      this.#accept(view); assert(!view.truncatedLines?.length, 'No shortened row may count toward equal-information reads'); pages.push(this.#text);
      if (view.next === undefined) { const text = pages.join('\n'); McpBenchmarkWorkflow.verifyTableObservation(text); return text; }
      assert(Number.isInteger(view.next) && view.next > offset, 'Pagination must make forward progress'); offset = view.next;
    }
    throw new Error('Synthetic table unexpectedly exceeded 20 bounded pages');
  }
  async observeTable() { await this.#table('observe.table'); }
  async readTable() {
    const tables = [...this.#text.matchAll(/^\s*- table \[ref=([a-z0-9]+)\]:?$/gm)];
    assert.equal(tables.length, 1, 'Summary must target the exact table from the latest returned view');
    const value = await this.#call('read.table', 'pane_read', { tab: this.#view.tab, view: this.#view.view,
      ref: tables[0][1], mode: 'summary', column: 2 });
    const { headers, rows, first, last, numeric } = value.data;
    assert.deepEqual(headers, ['Code', 'Description', 'Quantity']);
    assert.deepEqual(first, ['ROW-000', 'Synthetic inventory item 0', '1']);
    assert.deepEqual(last, ['ROW-119', 'Synthetic inventory item 119', '120']);
    assert.deepEqual(numeric, { column: 2, count: 120, nonNumeric: 0, sum: 7260, min: 1, max: 120 });
    return { rows, total: numeric.sum, first: first[0], last: last[0] };
  }
  lastCompletedWallMs() { return this.#metrics.samples().at(-1).completedWallMs; }
}
