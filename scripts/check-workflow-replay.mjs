import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { McpBaselineSession } from './mcp-baseline-session.mjs';
import { WorkflowReportFixture } from './workflow-report-fixture.mjs';
import { WorkflowReplayDriver } from './workflow-replay-driver.mjs';
import { WorkflowMcpProxy } from './workflow-mcp-proxy.mjs';

async function main() {
  const token = randomUUID(), root = await realpath(await mkdtemp(join(tmpdir(), 'bph-replay-check-')));
  const python = process.env.BPANE_WORKFLOW_PYTHON ?? 'python3', controller = new AbortController();
  const interrupt = () => controller.abort();
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, interrupt);
  const report = { cases: [], modelCalls: 0, scope: 'Owned Chromium + actual Python MCP SDK/CLI. Synthetic data only; no production/Pi/model tests.' };
  let session, fixture, proxy;
  try {
    for (const fault of ['none', 'wrong-period', 'empty', 'wrong-schema', 'wrong-value', 'renamed', 'duplicate',
      'wrong-marker', 'wrong-route', 'layout', 'human-change', 'dom-replacement', 'process-crash', 'browser-restart']) {
      controller.signal.throwIfAborted();
      fixture = new WorkflowReportFixture(randomUUID());
      const expected = fixture.select('2026-06', ['wrong-period', 'empty', 'wrong-schema', 'wrong-value'].includes(fault) ? fault : 'none');
      await fixture.start(); session = new McpBaselineSession(); await session.start(fixture, { engine: 'compact' });
      const page = session.initialPage();
      let injected = false, driver, crashed = false;
      proxy = new WorkflowMcpProxy(session.endpoint(), {
        before: async tool => {
          if (tool !== 'pane_flow') return;
          if (fault === 'human-change') await page.evaluate(() => { document.querySelector('h1').textContent = 'Another account'; });
          if (fault === 'dom-replacement') await page.evaluate(() => { const e = document.getElementById('export'); e.replaceWith(e.cloneNode(true)); });
        },
        after: async tool => {
          if (tool === 'pane_flow' && ['process-crash', 'browser-restart'].includes(fault) && !crashed) {
            crashed = true; driver.interruptOwnedChild(); return;
          }
          if (tool !== 'pane_act' || injected) return;
          injected = true;
          await page.evaluate(kind => {
            const link = document.getElementById('export');
            if (kind === 'renamed') link.textContent = 'Generate document';
            if (kind === 'duplicate') link.after(link.cloneNode(true));
            if (kind === 'wrong-marker') document.querySelector('h1').textContent = 'Another account';
            if (kind === 'layout') {
              const wrapper = document.createElement('section'); wrapper.style.padding = '50px';
              document.body.append(wrapper); wrapper.append(link);
            }
          }, fault);
          if (fault === 'wrong-route') await page.goto(fixture.url('report') + '?account=other');
        },
      });
      await proxy.start();
      driver = new WorkflowReplayDriver(python, root, session, fixture, controller.signal);
      const run = await driver.prepare(expected, fault, proxy.endpoint());
      const result = await driver.command('run', ['--run-id', run]);
      let final = result;
      if (['process-crash', 'browser-restart'].includes(fault)) {
        assert.equal(result.signal, 'SIGKILL');
        const duplicate = await driver.command('run', ['--run-id', run]);
        assert.equal(duplicate.result.state, 'exporting');
        if (fault === 'browser-restart') {
          assert.equal((await fixture.diagnostics(page)).clicks, 1);
          assert.equal((await session.artifactFiles()).length, 1);
          await session.restart(fixture); proxy.retarget(session.endpoint());
          // Read-only reconciliation must not navigate a restarted browser or reuse old tab/lease IDs.
        }
        const beforeReconcile = proxy.calls().length;
        final = await driver.command('reconcile', ['--run-id', run]);
        assert(proxy.calls().slice(beforeReconcile).every(tool => tool === 'pane_view'));
        assert.equal((await session.artifactFiles()).length, 1);
      }
      const success = ['none', 'layout', 'process-crash'].includes(fault);
      assert.equal(final.result?.verified, success, `${fault}: ${JSON.stringify(final)}`);
      assert.equal(final.result.policyWaitMs, 0); assert(!('pacing' in final.result));
      const clicks = fault === 'browser-restart' ? 1 : await page.evaluate(() => window.__workflowFixture.clicks);
      const noInput = ['renamed', 'duplicate', 'wrong-marker', 'wrong-route', 'human-change', 'dom-replacement'].includes(fault);
      assert.equal(clicks, noInput ? 0 : 1, `${fault}: no forbidden/duplicate export`);
      report.cases.push({ fault, verified: final.result.verified, state: final.result.state, code: final.result.code,
        clicks, processCrashReconciled: fault === 'process-crash' });
      session.assertHealthy(); await proxy.close(); proxy = undefined;
      await session.close(); session = undefined; await fixture.close(); fixture = undefined;
    }
    report.passed = true;
  } catch (error) { report.passed = false; report.error = error.message; process.exitCode = 1; }
  finally {
    const cleanup = await Promise.allSettled([proxy?.close(), session?.close(), fixture?.close()]);
    if (cleanup.some(row => row.status === 'rejected')) { report.passed = false; report.cleanupFailed = true; process.exitCode = 1; }
    assert(basename(root).startsWith('bph-replay-check-')); assert.equal(await realpath(root), root);
    await rm(root, { recursive: true });
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(signal, interrupt);
    const directory = new URL('../test-results/', import.meta.url); await mkdir(directory, { recursive: true });
    const output = new URL(`workflow-replay-check-${token}.json`, directory);
    await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ ...report, output: fileURLToPath(output) }, null, 2));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
