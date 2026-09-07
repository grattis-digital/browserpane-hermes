import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { arch, platform } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { McpBaselineMetrics } from './mcp-baseline-metrics.mjs';
import { McpBaselineSession } from './mcp-baseline-session.mjs';
import { WorkflowReportDriver } from './workflow-report-driver.mjs';
import { WorkflowReportFixture } from './workflow-report-fixture.mjs';

async function main() {
  const samples = Number(process.argv[2] ?? 3);
  assert(Number.isInteger(samples) && samples >= 1 && samples <= 30);
  const token = randomUUID(), fixture = new WorkflowReportFixture(token);
  let session;
  const metrics = new McpBaselineMetrics(), controller = new AbortController();
  const interrupt = () => controller.abort(new Error('Workflow benchmark interrupted'));
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, interrupt);
  const report = { schemaVersion: 1, samples, modelCalls: 0, billedTokens: null, costUsd: null, trials: [],
    environment: { platform: platform(), architecture: arch(), node: process.version },
    scope: 'Owned synthetic export over real HTTP MCP. Fresh profile per paired parameter case; both arms share that profile. Scripted drivers, NOT learned workflows, bulk-download endurance, model tests, or Raspberry Pi measurements.',
    accounting: 'totalMs includes observation, navigation, input, download and independent oracle; startup excluded. JSON bytes are MCP results, not wire bytes or tokens. No timing threshold.' };
  try {
    report.harnessSha256 = Object.fromEntries(await Promise.all(['benchmark-workflow-learning', 'workflow-report-driver',
      'workflow-report-fixture', 'workflow-report-oracle'].map(async name => [name,
      createHash('sha256').update(await readFile(new URL(`${name}.mjs`, import.meta.url))).digest('hex')])));
    fixture.select('2026-01'); await fixture.start();
    for (let index = 0; index < samples; index++) {
      controller.signal.throwIfAborted();
      session = new McpBaselineSession(); await session.start(fixture, { engine: 'compact' });
      const driver = new WorkflowReportDriver(session, fixture, metrics, controller.signal);
      const period = `${2025 + Math.floor(index / 12)}-${String(index % 12 + 1).padStart(2, '0')}`;
      // Alternate ordering to reduce systematic warm-cache ordering bias.
      for (const mode of index % 2 ? ['batched', 'separate'] : ['separate', 'batched']) {
        const trial = await driver.run(period, 'none', mode);
        report.trials.push(trial); assert.equal(trial.verified, true);
      }
      await session.close(); session = undefined;
    }
    session = new McpBaselineSession(); await session.start(fixture, { engine: 'compact' });
    const driver = new WorkflowReportDriver(session, fixture, metrics, controller.signal);
    for (const fault of ['wrong-period', 'empty', 'wrong-schema', 'wrong-value']) {
      const trial = await driver.run('2026-06', fault, 'batched');
      report.trials.push(trial); assert.equal(trial.toolCompleted, true); assert.equal(trial.verified, false);
    }
    report.passed = true;
  } catch (error) { report.passed = false; report.error = error.message; process.exitCode = 1; }
  finally {
    const cleanup = await Promise.allSettled([session?.close(), fixture.close()]);
    if (cleanup.some(row => row.status === 'rejected')) { report.passed = false; report.cleanupFailed = true; process.exitCode = 1; }
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(signal, interrupt);
    report.summary = Object.fromEntries(['separate', 'batched'].map(mode => {
      const rows = report.trials.filter(row => row.mode === mode && row.fault === 'none');
      return [mode, rows.length ? Object.fromEntries(['totalMs', 'mcpMs', 'mcpCalls', 'responseJsonBytes']
        .map(key => [key, McpBaselineMetrics.distribution(rows.map(row => row[key]))])) : null];
    }));
    const directory = new URL('../test-results/', import.meta.url);
    await mkdir(directory, { recursive: true });
    const output = new URL(`workflow-learning-${token}.json`, directory);
    await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ passed: report.passed, output: fileURLToPath(output), summary: report.summary, error: report.error }, null, 2));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
