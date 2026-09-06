import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { arch, cpus, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { McpBaselineFixture } from './mcp-baseline-fixture.mjs';
import { McpBaselineSession } from './mcp-baseline-session.mjs';
import { McpBaselineMetrics } from './mcp-baseline-metrics.mjs';
import { McpBenchmarkWorkflow } from './mcp-baseline-workflow.mjs';
import { CompactMcpBenchmarkBackend } from './mcp-compact-workflow.mjs';

/** Current MCP adapter. No tool is replaced with a direct Playwright action. */
export class PlaywrightMcpBaselineBackend {
  #client;
  #metrics;
  #meta;
  #snapshot;
  #signal;
  constructor(client, metrics, signal) { this.#client = client; this.#metrics = metrics; this.#signal = signal; }
  trial(iteration, warmup) { this.#meta = { iteration, warmup }; }
  async #call(operation, name, args) {
    this.#signal?.throwIfAborted();
    return this.#metrics.measure({ ...this.#meta, operation, tool: name,
      argumentJsonBytes: Buffer.byteLength(JSON.stringify(args)) },
    () => this.#client.callTool({ name, arguments: args }, undefined, { timeout: 15000, signal: this.#signal }));
  }
  static ref(snapshot, role, label) {
    const lines = snapshot.split('\n').filter(line => line.includes(`${role} "${label}"`));
    assert.equal(lines.length, 1, `Expected exactly one snapshot reference for ${role} ${label}`);
    const match = lines[0].match(/\[ref=([a-zA-Z0-9]+)\]/); assert(match, 'Snapshot reference missing'); return match[1];
  }
  static value(result) {
    const match = McpBaselineMetrics.text(result).match(/(?:^|\n)### Result\n([\s\S]*?)(?=\n### |$)/);
    assert(match, 'MCP read did not return a Result section'); return JSON.parse(match[1]);
  }
  navigate(url, operation) { return this.#call(operation, 'browser_navigate', { url }); }
  async observeForm() {
    const result = await this.#call('observe.form', 'browser_snapshot', {});
    this.#snapshot = McpBaselineMetrics.text(result);
  }
  async fill(values) {
    const fields = [['Full name', 'textbox', values.fullName], ['Email address', 'textbox', values.email],
      ['Plan', 'combobox', values.plan], ['Accept terms', 'checkbox', String(values.consent)]];
    return this.#call('fill.form', 'browser_fill_form', { fields: fields.map(([name, type, value]) =>
      ({ name, type, value, ref: PlaywrightMcpBaselineBackend.ref(this.#snapshot, type, name) })) });
  }
  submit() {
    return this.#call('submit.navigate', 'browser_click', { element: 'Save contact',
      ref: PlaywrightMcpBaselineBackend.ref(this.#snapshot, 'button', 'Save contact') });
  }
  fillAndSubmit(values) {
    const field = (role, label) => `page.locator(${JSON.stringify('aria-ref=' + PlaywrightMcpBaselineBackend.ref(this.#snapshot, role, label))})`;
    return this.#call('fill+submit.navigate', 'browser_run_code', { code: `async (page) => {
      await ${field('textbox', 'Full name')}.fill(${JSON.stringify(values.fullName)});
      await ${field('textbox', 'Email address')}.fill(${JSON.stringify(values.email)});
      await ${field('combobox', 'Plan')}.selectOption({label:${JSON.stringify(values.plan)}});
      await ${field('checkbox', 'Accept terms')}.setChecked(${JSON.stringify(values.consent)});
      await ${field('button', 'Save contact')}.click();
    }` });
  }
  async readReceipt() {
    const result = await this.#call('read.receipt', 'browser_evaluate', { function: `() => ({
      fullName:document.querySelector('#full-name').textContent,email:document.querySelector('#email').textContent,
      plan:document.querySelector('#plan').textContent,consent:document.querySelector('#consent').textContent==='true'})` });
    return PlaywrightMcpBaselineBackend.value(result);
  }
  async observeTable() {
    const result = await this.#call('observe.table', 'browser_snapshot', {});
    const text = McpBaselineMetrics.text(result);
    McpBenchmarkWorkflow.verifyTableObservation(text);
  }
  async readTable() {
    const result = await this.#call('read.table', 'browser_evaluate', { function: `() => {
      const rows=[...document.querySelectorAll('tbody tr')];return {rows:rows.length,
        total:rows.reduce((sum,row)=>sum+Number(row.cells[2].textContent),0),first:rows[0].cells[0].textContent,last:rows.at(-1).cells[0].textContent};}` });
    return PlaywrightMcpBaselineBackend.value(result);
  }
  lastCompletedWallMs() { return this.#metrics.samples().at(-1).completedWallMs; }
}

async function main() {
  const label = process.argv[2] ?? 'mcp-baseline', samples = Number(process.argv[3] ?? 12), warmups = Number(process.argv[4] ?? 2);
  const mode = process.argv[5] ?? 'separate'; assert(['separate', 'batched'].includes(mode));
  const engine = process.argv[6] ?? 'playwright'; assert(['playwright', 'compact'].includes(engine));
  assert.match(label, /^[a-z0-9-]{1,60}$/); assert(Number.isInteger(samples) && samples >= 1 && samples <= 30);
  assert(Number.isInteger(warmups) && warmups >= 0 && warmups <= 5);
  const root = fileURLToPath(new URL('../', import.meta.url)), fixture = new McpBaselineFixture(), session = new McpBaselineSession();
  const metrics = new McpBaselineMetrics(), require = createRequire(import.meta.url);
  const controller = new AbortController(), interrupt = () => controller.abort(new Error('Benchmark interrupted; cleaning owned resources'));
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, interrupt);
  const output = join(root, 'test-results', `${label}-${Date.now()}-${randomUUID().slice(0, 8)}.json`);
  const report = { label, date: new Date().toISOString(), samples, warmups, mode, engine, paidModelCalls: 0, trials: [],
    environment: { platform: platform(), arch: arch(), cpuModel: cpus()[0]?.model, logicalCpus: cpus().length, node: process.version },
    scope: 'Local synthetic Chromium146 comparison; actual separate-process MCP/HTTP/CDP. Not a Pi, production X11, viewer, concurrency or LLM benchmark.',
    accounting: { jsonBytes: 'Exact UTF-8 JSON.stringify(CallToolResult), excluding JSON-RPC/HTTP/TLS framing.',
      textBytes: 'Exact UTF-8 joined text content; image/audio token costs are not estimated.',
      estimatedTextTokensCharsDiv4: 'ceil(Unicode code points / 4). Heuristic only, not model tokenization or billed tokens; language/code/schema dependent.',
      latencyMs: 'Monotonic client call→complete MCP result, including transport/tool waits. Startup, schema/session setup and independent oracle checks excluded.',
      observationEquivalence: 'observe.table requires all120 row IDs; compact pagination calls and bytes are summed. read.table verifies identical120-row aggregate; baseline uses evaluate, compact uses declarative pane_read summary. Default compact first page alone is bounded, not equal information.',
      percentiles: 'Nearest rank: sorted[ceil(n*p)-1]; small-n p95 is noisy. Warmups excluded.',
      wallClockDiagnostics: 'Response-minus-DOM event timestamps approximate cross-process elapsed time; wall-clock shifts may affect these diagnostics, not monotonic latency.' } };
  try {
    const owned = ['benchmark-mcp-baseline', 'mcp-baseline-session', 'mcp-baseline-fixture', 'mcp-baseline-metrics', 'mcp-baseline-workflow',
      'mcp-compact-session', 'mcp-compact-workflow'];
    report.harnessSha256 = Object.fromEntries(await Promise.all(owned.map(async name => [name,
      createHash('sha256').update(await readFile(join(root, 'scripts', name + '.mjs'))).digest('hex')])));
    const tabSource = await readFile(join(dirname(require.resolve('playwright/package.json')), 'lib/mcp/browser/tab.js'), 'utf8');
    report.pinnedWaitSource = { sha256: createHash('sha256').update(tabSource).digest('hex'),
      hasHardcoded1000msPageTimer: /setTimeout\(f, 1e3\)/.test(tabSource),
      note: 'Source observation, not attribution of every call latency; read/evaluate timings expose the actual observed floor.' };
    if (engine === 'compact') report.engineSha256 = Object.fromEntries(await Promise.all((await readdir(join(root, 'server/compact')))
      .filter(name => name.endsWith('.mjs')).sort().map(async name => [name,
        createHash('sha256').update(await readFile(join(root, 'server/compact', name))).digest('hex')])));
    await fixture.start(); await session.start(fixture, { engine }); report.runtime = session.metadata(); controller.signal.throwIfAborted();
    const schemaStarted = performance.now(), schema = await session.client().listTools();
    assert(!schema.nextCursor, 'Unexpected paginated tool schema');
    const descriptors = JSON.stringify(schema.tools);
    report.schema = { latencyMs: performance.now() - schemaStarted, tools: schema.tools.length,
      toolNames: schema.tools.map(tool => tool.name), resultJsonBytes: Buffer.byteLength(JSON.stringify(schema)),
      toolDescriptorsJsonBytes: Buffer.byteLength(descriptors), estimatedDescriptorTokensCharsDiv4: Math.ceil([...descriptors].length / 4),
      sha256: createHash('sha256').update(descriptors).digest('hex') };
    const Adapter = engine === 'compact' ? CompactMcpBenchmarkBackend : PlaywrightMcpBaselineBackend;
    const backend = new Adapter(session.client(), metrics, controller.signal), workflow = new McpBenchmarkWorkflow(fixture, session);
    report.sessionSetup = backend.initialize ? await backend.initialize() : { calls: 0 };
    for (let iteration = 0; iteration < warmups + samples; iteration++) {
      backend.trial(iteration, iteration < warmups);
      const trial = await workflow.run(backend, iteration, { batched: mode === 'batched' });
      const calls = metrics.samples().filter(sample => sample.iteration === iteration);
      report.trials.push({ warmup: iteration < warmups, ...trial, toolCalls: calls.length,
        operations: McpBaselineMetrics.totals(calls),
        toolLatencySumMs: calls.reduce((sum, call) => sum + call.latencyMs, 0),
        outputJsonBytes: calls.reduce((sum, call) => sum + call.jsonBytes, 0),
        outputTextBytes: calls.reduce((sum, call) => sum + call.textBytes, 0),
        estimatedOutputTextTokensCharsDiv4: calls.reduce((sum, call) => sum + call.estimatedTextTokensCharsDiv4, 0) });
      console.log(`MCP baseline ${iteration + 1}/${warmups + samples}: state/event oracle passed`);
    }
    report.passed = true;
  } catch (error) { report.passed = false; report.error = String(error.message ?? error); process.exitCode = 1; }
  finally {
    const cleanup = await Promise.allSettled([session.close(), fixture.close()]);
    const failures = cleanup.filter(result => result.status === 'rejected');
    if (failures.length) { report.passed = false; report.cleanupError = failures.map(result => String(result.reason)); process.exitCode = 1; }
    else report.cleanup = 'Owned CLI, Chromium, temporary profile/artifacts and loopback fixture closed/removed';
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(signal, interrupt);
    report.raw = metrics.samples(); report.summary = metrics.summarize();
    const trials = report.trials.filter(trial => !trial.warmup);
    if (trials.length) report.workflowSummary = Object.fromEntries(['toolLatencySumMs', 'outputJsonBytes', 'outputTextBytes',
      'estimatedOutputTextTokensCharsDiv4'].map(key =>
      [key, McpBaselineMetrics.distribution(trials.map(trial => trial[key]))]));
    report.operationTotalsSummary = McpBaselineMetrics.summarizeTotals(trials);
    await mkdir(dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ passed: report.passed, output, schema: report.schema, summary: report.summary, error: report.error }, null, 2));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
