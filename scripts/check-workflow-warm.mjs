import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { McpBaselineSession } from './mcp-baseline-session.mjs';
import { WorkflowReportFixture } from './workflow-report-fixture.mjs';
import { WorkflowReportOracle } from './workflow-report-oracle.mjs';
import { WorkflowReplayDriver } from './workflow-replay-driver.mjs';
import { WorkflowWarmDriver } from './workflow-warm-driver.mjs';
import { WorkflowMcpProxy } from './workflow-mcp-proxy.mjs';

async function main() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bph-warm-fixture-')));
  const python = process.env.BPANE_WORKFLOW_PYTHON ?? 'python3', controller = new AbortController();
  const interrupt = () => controller.abort();
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, interrupt);
  const fixture = new WorkflowReportFixture(randomUUID()), session = new McpBaselineSession();
  let warm = new WorkflowWarmDriver(controller.signal), proxy, release, reached;
  const held = new Promise(resolve => { release = resolve; });
  const dispatched = new Promise(resolve => { reached = resolve; });
  const checks = [];
  try {
    const expected = fixture.select('2026-06'); await fixture.start();
    await session.start(fixture, { engine: 'compact' });
    proxy = new WorkflowMcpProxy(session.endpoint(), { after: async tool => {
      if (tool === 'pane_flow') { reached(); await held; }
    } });
    await proxy.start();
    const driver = new WorkflowReplayDriver(python, root, session, fixture, controller.signal);
    const options = { store: join(root, 'workflow-runs'), catalog: join(root, 'workflow-catalog') };
    const first = await driver.prepare(expected, 'first', proxy.endpoint(), options);
    const second = await driver.prepare(expected, 'second', proxy.endpoint(), options);
    await warm.start(python, root, proxy.endpoint(), session.artifactDirectory());
    const page = session.initialPage(), event = page.waitForEvent('download', { timeout: 30000 }); event.catch(() => {});
    assert.equal((await warm.command({ op: 'run', run_id: first })).active, true);
    await McpBaselineSession.deadline(() => dispatched, 10000);
    assert.equal((await warm.command({ op: 'run', run_id: first })).active, true);
    assert.equal((await warm.command({ op: 'run', run_id: second })).error, 'WORKER_BUSY');
    assert.equal((await warm.command({ op: 'status', run_id: second })).state, 'approved');
    checks.push('one active run; duplicate joins; other ID rejected without consuming approval');
    const cancelled = await warm.command({ op: 'cancel', run_id: first });
    assert.equal(cancelled.cancelRequested, true); assert.equal(cancelled.active, true);
    assert.equal(cancelled.state, 'exporting'); assert.equal(cancelled.verified, false);
    release();
    let state, deadline = performance.now() + 10000;
    do {
      assert(performance.now() < deadline); await delay(10, undefined, { signal: controller.signal });
      state = await warm.command({ op: 'status', run_id: first });
    } while (state.active);
    assert.equal(state.state, 'uncertain'); assert.equal(state.code, 'CANCEL_REQUESTED');
    checks.push('cancel after actual export stays uncertain; later verification was not dispatched');
    const before = proxy.calls().length;
    assert.equal((await warm.execute(first)).state, 'uncertain'); assert.equal(proxy.calls().length, before);
    const reconciled = await warm.execute(first, 'reconcile');
    assert.equal(reconciled.verified, true); assert.equal(reconciled.cancelRequested, true);
    assert.equal(reconciled.policyWaitMs, 0); assert(!('pacing' in reconciled));
    assert(proxy.calls().slice(before).every(name => name === 'pane_view'));
    const files = await session.artifactFiles(); assert.equal(files.length, 1);
    const verdict = WorkflowReportOracle.verify(expected, await fixture.evidence(page, await event, await session.readArtifact(files[0])));
    assert.equal(verdict.verified, true); assert.equal((await fixture.diagnostics(page)).clicks, 1);
    checks.push('read-only reconciliation verifies the actual artifact with one trusted click and no replay');
    await warm.command({ fixture: 'close' }); await warm.close();
    warm = new WorkflowWarmDriver(controller.signal);
    await warm.start(python, root, proxy.endpoint(), session.artifactDirectory());
    assert.equal((await warm.execute(first)).verified, true);
    assert.equal((await warm.command({ op: 'cancel', run_id: second })).state, 'stopped');
    assert.equal((await warm.execute(second)).state, 'stopped');
    assert.equal((await warm.command({ fixture: 'metrics' })).opened, 0);
    assert.equal(proxy.calls().filter(name => name === 'pane_flow').length, 1);
    checks.push('worker process restart preserves catalog/journal; duplicate and cancelled runs open no connection');
    session.assertHealthy();
    console.log(JSON.stringify({ passed: true, checks, modelCalls: 0, scope: 'Owned local Chromium, real Python SDK/service; not Pi.' }, null, 2));
  } finally {
    release(); await warm.close();
    const cleanup = await Promise.allSettled([proxy?.close(), session.close(), fixture.close()]);
    assert(cleanup.every(row => row.status === 'fulfilled'));
    assert(basename(root).startsWith('bph-warm-fixture-')); assert.equal(await realpath(root), root);
    await rm(root, { recursive: true });
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(signal, interrupt);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
