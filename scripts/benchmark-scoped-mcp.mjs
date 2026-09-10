import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { CompactEngineFixture as Fixture } from './compact-engine-fixture.mjs';
import { CompactMcpHttpServer } from '../server/compact/http-server.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/** Equal business outcome, not equal page coverage. No remote endpoint or model. */
class ScopedMcpBenchmark {
  #fixture;
  #client;
  #request = 0;
  constructor(fixture, client) { this.#fixture = fixture; this.#client = client; }

  async trial(mode) {
    const rows = Array.from({ length: 3000 }, (_, i) => `<article><h2>Result ${i}</h2><p>Research text ${i}</p></article>`).join('');
    const page = await this.#fixture.reset(`<header><h1>Research fixture</h1></header><main aria-label="Workspace">
      <form aria-label="Search panel"><label>Topic<input id="topic"></label><button id="save" type="button">Search</button></form>
      <section aria-label="Results">${rows}</section></main><p id="result"></p>
      <script>window.calls=0;save.onclick=()=>{calls++;document.getElementById('result').textContent=topic.value;};</script>`);
    const listed = JSON.parse((await this.#client.callTool({ name: 'pane_tabs', arguments: {} })).content[0].text);
    const tab = this.#fixture.tabFor(listed.tabs[0].tab), managed = tab.page;
    const cdp = await managed.context().newCDPSession(managed);
    await cdp.send('Performance.enable');
    const renderer = async () => (await cdp.send('Performance.getMetrics')).metrics.find(m => m.name === 'TaskDuration').value;
    const counts = { toolCalls: 0, fullCaptures: 0, scopedCaptures: 0, targetCaptures: 0, visitedNodes: 0, rawBytes: 0, outputBytes: 0 };
    const originalCapture = managed._snapshotForAI.bind(managed), originalSnapshot = tab.snapshot.bind(tab);
    let guardSnapshot;
    managed._snapshotForAI = async options => {
      const result = await originalCapture(options);
      counts[options.maxNodes === 1 ? 'targetCaptures' : options.maxNodes ? 'scopedCaptures' : 'fullCaptures']++;
      counts.visitedNodes += result.coverage.visitedNodes;
      counts.rawBytes += Buffer.byteLength(result.full);
      return result;
    };
    if (mode === 'full-baseline') {
      // Reproduce the preceding guard algorithm: one full-page capture per
      // preflight, reused for all target refs. Never multiply baseline work.
      tab.snapshot = async options => {
        if (options?.target) return guardSnapshot ??= await originalSnapshot();
        return originalSnapshot();
      };
    }
    const call = async (name, args) => {
      const reply = await this.#client.callTool({ name, arguments: args });
      counts.toolCalls++; counts.outputBytes += Buffer.byteLength(JSON.stringify(reply));
      const data = JSON.parse(reply.content[0].text); assert(!reply.isError, JSON.stringify(data)); return data;
    };
    try {
      const before = await renderer(), started = performance.now();
      let view = await call('pane_view', mode === 'scoped' ? { capture: 'outline', depth: 1 } : {});
      if (mode === 'scoped') {
        view = await call('pane_view', { tab: view.tab, view: view.view, root: Fixture.ref(view, 'Workspace'), capture: 'outline', depth: 1 });
        view = await call('pane_view', { tab: view.tab, view: view.view, root: Fixture.ref(view, 'Search panel') });
      }
      const result = await call('pane_act', { lease: view.lease, request: ++this.#request, tab: view.tab, view: view.view,
        steps: [{ op: 'fill', ref: Fixture.ref(view, 'Topic'), text: 'Verified research' },
          { op: 'click', ref: Fixture.ref(view, 'Search') }] });
      const totalMs = performance.now() - started, rendererTaskMs = ((await renderer()) - before) * 1000;
      assert.equal(result.completed, 2); assert(!result.observationError);
      assert.equal(await page.locator('#topic').inputValue(), 'Verified research');
      assert.equal(await page.locator('#result').textContent(), 'Verified research');
      assert.equal(await page.evaluate(() => window.calls), 1);
      await this.#fixture.waitForTabs(1);
      if (mode === 'full-baseline') assert.equal(counts.fullCaptures, 3);
      else { assert.equal(counts.fullCaptures, 0); assert.equal(counts.targetCaptures, 2); }
      return { mode, totalMs, rendererTaskMs, ...counts, verified: true };
    } finally {
      managed._snapshotForAI = originalCapture; tab.snapshot = originalSnapshot;
      await cdp.detach();
    }
  }

  static summarize(trials) {
    return Object.fromEntries(['full-baseline', 'scoped'].map(mode => {
      const selected = trials.filter(trial => trial.mode === mode);
      const median = key => {
        const values = selected.map(trial => trial[key]).sort((a, b) => a - b), mid = Math.floor(values.length / 2);
        return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
      };
      return [mode, Object.fromEntries(['totalMs', 'rendererTaskMs', 'toolCalls', 'fullCaptures', 'scopedCaptures',
        'targetCaptures', 'visitedNodes', 'rawBytes', 'outputBytes'].map(key => [key, median(key)]))];
    }));
  }
}

const rounds = Number(process.argv[2] ?? 5);
assert(Number.isSafeInteger(rounds) && rounds >= 1 && rounds <= 10, 'Use 1..10 measured pairs');
const fixture = new Fixture(), client = new Client({ name: 'owned-scoped-benchmark', version: '1' });
let server, transport;
try {
  await fixture.start();
  server = new CompactMcpHttpServer({ host: '127.0.0.1', port: 0, allowedHosts: [], createSession: () => fixture.session().engine });
  const { port } = await server.start(); server.allowedHosts.add(`127.0.0.1:${port}`);
  transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
  await client.connect(transport);
  const benchmark = new ScopedMcpBenchmark(fixture, client), trials = [];
  for (let round = 0; round <= rounds; round++) {
    const order = round % 2 ? ['scoped', 'full-baseline'] : ['full-baseline', 'scoped'];
    for (const mode of order) {
      const trial = await benchmark.trial(mode);
      if (round) trials.push({ round, ...trial }); // One warm-up pair excluded.
    }
  }
  const report = { passed: true, scope: 'Local owned Chromium146, one tab, actual MCP HTTP; no Pi or LLM latency claim',
    comparison: 'Same verified form outcome; scoped discovery intentionally omits unrelated article content',
    runtime: { node: process.version, platform: process.platform, architecture: process.arch },
    rounds, summary: ScopedMcpBenchmark.summarize(trials), trials };
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/scoped-mcp.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  const errors = [], attempt = async work => { try { await work(); } catch (error) { errors.push(error); } };
  if (transport?.sessionId) await attempt(() => transport.terminateSession());
  await attempt(() => client.close()); await attempt(async () => { await server?.close(); });
  await attempt(() => fixture.close());
  if (errors.length) throw new AggregateError(errors, 'Owned scoped benchmark cleanup failed');
}
