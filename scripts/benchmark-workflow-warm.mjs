import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir, arch, platform } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { McpBaselineSession } from './mcp-baseline-session.mjs';
import { WorkflowReportFixture } from './workflow-report-fixture.mjs';
import { WorkflowReportOracle } from './workflow-report-oracle.mjs';
import { WorkflowReplayDriver } from './workflow-replay-driver.mjs';
import { WorkflowWarmDriver } from './workflow-warm-driver.mjs';

/** Same recipe/SDK/verifier in both arms; never resets the browser between exports. */
class WarmBenchmark {
  #fixture; #session; #warm; #root; #python; #signal;
  constructor(fixture, session, warm, root, python, signal) {
    this.#fixture = fixture; this.#session = session; this.#warm = warm;
    this.#root = root; this.#python = python; this.#signal = signal;
  }
  async trial(period, mode, suffix) {
    this.#signal.throwIfAborted();
    const expected = this.#fixture.select(period), session = this.#session;
    const driver = new WorkflowReplayDriver(this.#python, this.#root, session, this.#fixture, this.#signal);
    const setupStarted = performance.now();
    const options = mode === 'warm' ? { store: join(this.#root, 'workflow-runs'), catalog: join(this.#root, 'workflow-catalog') }
      : { store: join(this.#root, 'cold-runs') };
    const runId = await driver.prepare(expected, suffix, session.endpoint(), options);
    const operatorSetupMs = performance.now() - setupStarted, page = session.initialPage();
    const before = new Set(await session.artifactFiles());
    const event = page.waitForEvent('download', { timeout: 30000 }); event.catch(() => {});
    const execution = mode === 'warm' ? await this.#warm.execute(runId) : await driver.command('run', ['--run-id', runId]);
    const result = mode === 'warm' ? execution : execution.result;
    if (!result?.verified) {
      throw new Error(JSON.stringify({ mode, suffix, result, diagnostics: await this.#fixture.diagnostics(page),
        filesAdded: (await session.artifactFiles()).filter(name => !before.has(name)).length }));
    }
    assert.equal(result.mcpCalls, 5);
    assert.equal(result.policyWaitMs, 0); assert(!('pacing' in result));
    const download = await event;
    const added = (await session.artifactFiles()).filter(name => !before.has(name));
    assert.equal(added.length, 1);
    const csv = await session.readArtifact(added[0]);
    const verdict = WorkflowReportOracle.verify(expected, await this.#fixture.evidence(page, download, csv));
    assert.equal(verdict.verified, true, JSON.stringify(verdict));
    const duplicate = mode === 'warm' ? await this.#warm.execute(runId) : (await driver.command('run', ['--run-id', runId])).result;
    assert.equal(duplicate.verified, true);
    const diagnostic = await this.#fixture.diagnostics(page);
    assert.equal(diagnostic.clicks, 1); assert.equal(diagnostic.serverRequests, 1);
    assert.equal((await session.artifactFiles()).length, before.size + 1);
    session.initialPage(); session.assertHealthy();
    return { mode, period, operatorSetupMs, ...result,
      wallMs: mode === 'warm' ? result.toolWallMs : execution.wallMs, independentOracle: verdict };
  }
}

async function main() {
  const samples = Number(process.argv[2] ?? 3), token = randomUUID();
  assert(Number.isInteger(samples) && samples >= 1 && samples <= 30);
  const python = process.env.BPANE_WORKFLOW_PYTHON ?? 'python3';
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bph-warm-fixture-')));
  const controller = new AbortController(), interrupt = () => controller.abort();
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, interrupt);
  const fixture = new WorkflowReportFixture(token), session = new McpBaselineSession();
  const warm = new WorkflowWarmDriver(controller.signal);
  const report = { samples, trials: [], modelCalls: 0, billedTokens: null, costUsd: null,
    environment: { platform: platform(), architecture: arch(), node: process.version },
    scope: 'One persistent owned Chromium/profile/tab; same Python recipe, SDK, five MCP calls and verifier. No model, Pi or real-site performance claim.',
    accounting: 'Alternating cold CLI/warm in-process service. Initial warm run separate. Wall time includes tool polling/stdio versus process startup; operator review/registration excluded. No download/profile resets, safety flag changes or run retries.' };
  try {
    fixture.select('2024-12'); await fixture.start();
    await session.start(fixture, { engine: 'compact' }); report.browser = session.metadata();
    await warm.start(python, root, session.endpoint(), session.artifactDirectory());
    assert.deepEqual((await warm.command({ op: 'discover' })).executions, []);
    const benchmark = new WarmBenchmark(fixture, session, warm, root, python, controller.signal);
    report.initialWarm = await benchmark.trial('2024-12', 'warm', 'initial');
    for (let index = 0; index < samples; index++) {
      const period = `${2025 + Math.floor(index / 12)}-${String(index % 12 + 1).padStart(2, '0')}`;
      for (const mode of index % 2 ? ['warm', 'cold'] : ['cold', 'warm']) {
        report.trials.push(await benchmark.trial(period, mode, `${mode}-${index}`));
      }
    }
    report.worker = await warm.command({ fixture: 'metrics' });
    assert.equal(report.worker.opened, 1, 'Every warm run must reuse the same initialized SDK connection');
    const closed = await warm.command({ fixture: 'close' });
    assert.equal(closed.metrics.closed, 1); assert.equal(closed.metrics.sameTask, true);
    report.exports = (await session.artifactFiles()).length;
    assert.equal(report.exports, 2 * samples + 1);
    report.passed = true;
  } catch (error) { report.passed = false; report.error = error.message; process.exitCode = 1; }
  finally {
    await warm.close();
    const results = await Promise.allSettled([session.close(), fixture.close()]);
    if (results.some(row => row.status === 'rejected')) { report.passed = false; report.cleanupFailed = true; process.exitCode = 1; }
    assert(basename(root).startsWith('bph-warm-fixture-')); assert.equal(await realpath(root), root);
    await rm(root, { recursive: true });
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(signal, interrupt);
    const directory = new URL('../test-results/', import.meta.url); await mkdir(directory, { recursive: true });
    const output = new URL(`workflow-warm-${token}.json`, directory);
    await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ passed: report.passed, trials: report.trials.length, output: fileURLToPath(output), error: report.error }, null, 2));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
