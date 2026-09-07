import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { McpBaselineSession } from './mcp-baseline-session.mjs';
import { WorkflowReportFixture } from './workflow-report-fixture.mjs';
import { WorkflowReportOracle } from './workflow-report-oracle.mjs';
import { WorkflowReplayDriver } from './workflow-replay-driver.mjs';
import { WorkflowWarmDriver } from './workflow-warm-driver.mjs';
import { WorkflowMcpProxy } from './workflow-mcp-proxy.mjs';

/** Dedicated policy integration: real browser/SDK, zero deliberate sleep budgets. */
async function main() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bph-warm-fixture-pacing-')));
  const python = process.env.BPANE_WORKFLOW_PYTHON ?? 'python3', controller = new AbortController();
  const interrupt = () => controller.abort();
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, interrupt);
  const fixture = new WorkflowReportFixture(randomUUID()), session = new McpBaselineSession();
  let warm = new WorkflowWarmDriver(controller.signal), proxy;
  try {
    const expected = fixture.select('2026-06'); await fixture.start();
    await session.start(fixture, { engine: 'compact' });
    proxy = new WorkflowMcpProxy(session.endpoint()); await proxy.start();
    const driver = new WorkflowReplayDriver(python, root, session, fixture, controller.signal);
    const options = { store: join(root, 'workflow-runs'), catalog: join(root, 'workflow-catalog') };
    const pacing = { schema: 1, version: 1, origin: new URL(fixture.url('report')).origin,
      minIntervalMs: 0, jitterMs: 0, maxActions: 2, windowMs: 3600000, maxWaitMs: 0 };
    const first = await driver.prepare(expected, 'paced', proxy.endpoint(), { ...options, pacing });
    const invalid = join(root, 'null-policy.json'); await writeFile(invalid, 'null', { mode: 0o600, flag: 'wx' });
    const rejected = await driver.command('review', ['--pacing', invalid]);
    assert.equal(rejected.result.error, 'INVALID_PACING_POLICY'); assert.equal(proxy.calls().length, 0);
    const page = session.initialPage(), event = page.waitForEvent('download', { timeout: 15000 }); event.catch(() => {});
    const result = (await driver.command('run', ['--run-id', first])).result;
    assert.equal(result.verified, true, JSON.stringify(result)); assert.equal(result.mcpCalls, 5);
    assert.equal(result.policyWaitMs, 0); assert.equal(result.pacing.admissions, 2);
    const files = await session.artifactFiles(); assert.equal(files.length, 1);
    const oracle = WorkflowReportOracle.verify(expected, await fixture.evidence(page, await event, await session.readArtifact(files[0])));
    assert.equal(oracle.verified, true);
    const second = await driver.prepare(expected, 'limited', proxy.endpoint(), { ...options, pacing });
    await warm.start(python, root, proxy.endpoint(), session.artifactDirectory());
    const before = proxy.calls().length;
    const blocked = await warm.execute(second);
    assert.equal(blocked.state, 'stopped'); assert.equal(blocked.code, 'PACING_DEFERRED');
    assert.equal(blocked.policyWaitMs, 0); assert.equal(blocked.mcpCalls, 0);
    assert.equal(blocked.active, false); assert.equal(proxy.calls().length, before);
    assert.equal((await fixture.diagnostics(page)).clicks, 1);
    // A new explicitly unpaced review remains unpaced even with a populated ledger.
    const third = await driver.prepare(fixture.select('2026-07'), 'unpaced', proxy.endpoint(), options);
    const unpaced = await warm.execute(third);
    assert.equal(unpaced.verified, true); assert.equal(unpaced.policyWaitMs, 0); assert(!('pacing' in unpaced));
    assert.equal(unpaced.mcpCalls, 5); assert.equal((await session.artifactFiles()).length, 2);
    await warm.command({ fixture: 'close' }); await warm.close();
    warm = new WorkflowWarmDriver(controller.signal);
    await warm.start(python, root, proxy.endpoint(), session.artifactDirectory());
    const completedCalls = proxy.calls().length;
    assert.equal((await warm.execute(second)).state, 'stopped');
    assert.equal((await warm.execute(first)).pacing.admissions, 2);
    assert.equal(proxy.calls().length, completedCalls);
    assert.equal((await warm.command({ fixture: 'metrics' })).opened, 0);
    session.assertHealthy();
    console.log(JSON.stringify({ passed: true, coldWarmSharedBudget: true, explicitOff: true,
      restartNoReplay: true, policyWaitMs: 0, modelCalls: 0,
      scope: 'Owned local Chromium and real Python SDK/service; virtual waits tested separately; not Pi.' }));
  } finally {
    await warm.close();
    const cleanup = await Promise.allSettled([proxy?.close(), session.close(), fixture.close()]);
    assert(cleanup.every(row => row.status === 'fulfilled'));
    assert(basename(root).startsWith('bph-warm-fixture-pacing-')); assert.equal(await realpath(root), root);
    await rm(root, { recursive: true });
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(signal, interrupt);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
