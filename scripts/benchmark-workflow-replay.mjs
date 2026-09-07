import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir, arch, platform } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { McpBaselineSession } from './mcp-baseline-session.mjs';
import { McpBaselineMetrics } from './mcp-baseline-metrics.mjs';
import { WorkflowReportFixture } from './workflow-report-fixture.mjs';
import { WorkflowReportDriver } from './workflow-report-driver.mjs';
import { WorkflowReportOracle } from './workflow-report-oracle.mjs';
import { WorkflowReplayDriver } from './workflow-replay-driver.mjs';

async function main() {
  const samples = Number(process.argv[2] ?? 3), token = randomUUID();
  assert(Number.isInteger(samples) && samples >= 1 && samples <= 30);
  const python = process.env.BPANE_WORKFLOW_PYTHON ?? 'python3';
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bph-replay-fixture-')));
  const fixture = new WorkflowReportFixture(token), controller = new AbortController();
  const interrupt = () => controller.abort();
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, interrupt);
  const report = { samples, trials: [], modelCalls: 0, billedTokens: null, costUsd: null,
    environment: { platform: platform(), architecture: arch(), node: process.version },
    scope: 'Owned synthetic report fixture. Separate JS baseline versus guarded Python recipe/SDK CLI; not an LLM, Pi, or language speed comparison.',
    accounting: 'Fresh profile per parameter pair, alternating order. Both arms share the browser. CLI wall time includes Python startup, connection and discovery; recipe executionMs includes connection but excludes Python startup. SDK-serialized result bytes, not wire bytes/tokens. Review/approval excluded and separately timed.' };
  let session;
  try {
    fixture.select('2026-01'); await fixture.start();
    for (let index = 0; index < samples; index++) {
      controller.signal.throwIfAborted();
      session = new McpBaselineSession(); await session.start(fixture, { engine: 'compact' });
      const period = `${2025 + Math.floor(index / 12)}-${String(index % 12 + 1).padStart(2, '0')}`;
      const modes = index % 2 ? ['recipe', 'separate'] : ['separate', 'recipe'];
      for (const mode of modes) {
        if (mode === 'separate') {
          const driver = new WorkflowReportDriver(session, fixture, new McpBaselineMetrics(), controller.signal);
          report.trials.push(await driver.run(period, 'none', mode)); continue;
        }
        const expected = fixture.select(period), driver = new WorkflowReplayDriver(python, root, session, fixture, controller.signal);
        const reviewStarted = performance.now(), runId = await driver.prepare(expected, `case-${index}`);
        const reviewMs = performance.now() - reviewStarted;
        const page = session.initialPage(), downloadWork = page.waitForEvent('download', { timeout: 30000 });
        downloadWork.catch(() => {});
        const execution = await driver.command('run', ['--run-id', runId]);
        assert.equal(execution.exitCode, 0, JSON.stringify(execution)); assert.equal(execution.result.verified, true);
        assert.equal(execution.result.policyWaitMs, 0); assert(!('pacing' in execution.result));
        const download = await downloadWork;
        const actualFile = (await fixture.diagnostics(page)).requestedPeriod;
        assert.equal(actualFile, period);
        const files = await session.artifactFiles();
        const matching = files.filter(name => name.startsWith(`report-${period}`)).sort();
        const csv = await session.readArtifact(matching.find(name => name.includes(' (')) ?? matching[0]);
        const verdict = WorkflowReportOracle.verify(expected, await fixture.evidence(page, download, csv));
        assert.equal(verdict.verified, true);
        const duplicate = await driver.command('run', ['--run-id', runId]);
        assert.equal(duplicate.exitCode, 0); assert.equal(duplicate.result.verified, true);
        assert.equal((await fixture.diagnostics(page)).clicks, 1);
        report.trials.push({ mode, period, reviewMs, cliWallMs: execution.wallMs, ...execution.result, independentOracle: verdict });
      }
      session.assertHealthy(); await session.close(); session = undefined;
    }
    report.passed = true;
  } catch (error) { report.passed = false; report.error = error.message; process.exitCode = 1; }
  finally {
    const results = await Promise.allSettled([session?.close(), fixture.close()]);
    if (results.some(row => row.status === 'rejected')) { report.passed = false; report.cleanupFailed = true; process.exitCode = 1; }
    assert(basename(root).startsWith('bph-replay-fixture-')); assert.equal(await realpath(root), root);
    await rm(root, { recursive: true });
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(signal, interrupt);
    const directory = new URL('../test-results/', import.meta.url); await mkdir(directory, { recursive: true });
    const output = new URL(`workflow-replay-${token}.json`, directory);
    await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ passed: report.passed, trials: report.trials.length, output: fileURLToPath(output), error: report.error }, null, 2));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
