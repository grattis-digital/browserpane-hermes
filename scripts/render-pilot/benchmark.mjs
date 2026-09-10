import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { RenderRpc } from './rpc.mjs';
import { RenderOracle } from './oracle.mjs';
import { PixelWaiter } from './pixel-waiter.mjs';
import { ViewerPipelineMetrics } from '../viewer-pipeline-metrics.mjs';
import { ViewerInputProbe } from '../viewer-input-probe.mjs';
import { CaptureTimingSummary } from '../viewer-pipeline-metrics.mjs';
import { ReadbackDiagnostics } from '../readback-diagnostics.mjs';
import { DamageAnalysisDiagnostics } from '../damage-analysis-diagnostics.mjs';
import { RenderPilotCleanup } from './cleanup.mjs';
import { GpuStatus } from '../../server/gpu-status.mjs';
import { StockWorkloads } from './stock-workloads.mjs';
import { StockInputSummary } from './stock-input-summary.mjs';
import { PilotTab } from './single-tab.mjs';

// Operator-only explicit config; never run in CI or use an existing browser/profile.
const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
assert.equal(config.allowLan, true);
assert(Number.isInteger(config.samples) && config.samples >= 3 && config.samples <= 40);
const report = { date: new Date().toISOString(), phases: [], passed: false,
  scope: 'Synthetic keyboard-to-readable-viewer-pixel latency; actual damage/tile/cache/QUIC stack; not native wheel, physical scanout, site load or video throughput',
  accounting: 'IP-layer bytes from owned firewall chain, not Ethernet bytes. CPU intervals include harness checkpoint/wait overhead. Full-surface correctness readbacks are outside measured intervals.' };
const rpc = RenderRpc.launch(config);
let browser, page;
try {
  const ready = await rpc.ready();
  console.log(JSON.stringify({ stage: 'ready', mode: ready.mode }));
  report.owner = ready;
  if (ready.features.stockGpuTrace) report.diagnosticOnly = true;
  if (config.customChromium) {
    assert.equal(ready.customChromium?.sha256, config.customChromium.sha256);
    assert.equal(ready.customChromium?.surfaceDamage, config.customChromium.surfaceDamage);
    assert.equal(ready.customChromium?.runningBinaryVerified, true);
  }
  if (ready.features.nativeDamageTrace) {
    report.scope = 'Finite synthetic native-damage diagnostic; not input latency or throughput';
    report.diagnosticOnly = true;
  }
  assert.equal(ready.url, config.viewerUrl);
  report.tabState = (await rpc.call('install')).tabState;
  report.remoteGpu = await rpc.call('gpu');
  PilotTab.assertSame(report.tabState, report.remoteGpu.tabState);
  if (ready.mode !== 'cpu') GpuStatus.validate({ featureStatus: report.remoteGpu.features, auxAttributes: report.remoteGpu.aux });
  browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true });
  report.viewerVersion = browser.version();
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1,
    ignoreHTTPSErrors: true }); // Isolated synthetic HTTPS only; WebTransport remains certificate-hash pinned.
  page = await context.newPage();
  assert.equal(context.pages().length, 1, 'Viewer must retain one local tab');
  const errors = [], downloads = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('download', download => {
    downloads.push(download.suggestedFilename());
    void download.cancel().catch(error => errors.push('Download cancellation failed: ' + error.message));
  });
  report.errors = errors; report.downloads = downloads;
  await page.goto(ready.url, { timeout: 20000 });
  await page.locator('#resolution').selectOption('1280x720');
  await page.locator('#density').selectOption('1');
  await page.waitForFunction(() => window.browserpaneSession?.connected
    && document.querySelector('#screen canvas')?.width === 1280
    && document.querySelector('#screen canvas')?.height === 720, null, { timeout: 45000 });
  await page.waitForTimeout(2400); // Existing startup resize retries are outside measurements.
  console.log(JSON.stringify({ stage: 'viewer-connected', mode: ready.mode }));
  await page.locator('#screen canvas').first().click({ position: { x: 350, y: 400 } });
  await page.evaluate(ViewerInputProbe.flushHostInput);
  const fixture = await rpc.call('inspect');
  PilotTab.assertSame(report.tabState, fixture.tabState);
  console.log(JSON.stringify({ stage: 'fixture-focused', mode: ready.mode }));
  report.geometry = fixture;
  assert(fixture.focused && fixture.dpr === 1 && fixture.sequence === 0 && fixture.scrollY === 0);
  report.viewerRenderer = await page.evaluate(() => window.browserpaneSession.getRenderDiagnostics());
  report.coldOracle = await RenderOracle.checkpoint(page, rpc);
  console.log(JSON.stringify({ stage: 'cold-pixels-matched', mode: ready.mode }));
  if (ready.features.stockGpuWorkloads) report.controlRoundTripBefore = await StockWorkloads.controlRoundTrip(page);
  let sequence = 0, scrollY = 0;
  const phases = ready.features.nativeDamageTrace ? [] : [['sparse', 'a', 0], ['half-tile-scroll', 's', 32],
    ['tile-scroll', 'd', 64], ['cached-return', 'u', -64]];
  for (const [name, key, movement] of phases) {
    const phase = { name, warmup: [], samples: [] };
    report.phases.push(phase);
    let before, metrics;
    for (let i = 0; i < config.samples + 3; i++) {
      if (i === 3) {
        phase.traceStart = await StockWorkloads.begin(rpc, ready.features.stockGpuTrace);
        metrics = new ViewerPipelineMetrics();
        metrics.observe(await page.evaluate(RenderOracle.snapshot));
        before = await rpc.call('sample');
      }
      sequence++; scrollY = Math.max(0, scrollY + movement);
      await page.evaluate(PixelWaiter.arm, { token: ready.token, key,
        points: RenderOracle.points(fixture, sequence, scrollY), width: 1280, height: 720 });
      await page.keyboard.press(key);
      const result = await page.evaluate(PixelWaiter.result, ready.token);
      (i < 3 ? phase.warmup : phase.samples).push({ sequence, ...result });
      assert(result.matched, `${name} input ${sequence}: ${result.reason}`);
      await page.waitForTimeout(23 + i % 5 * 7); // Avoid a fixed phase-lock to the capture cadence.
    }
    phase.resources = RenderOracle.delta(before, await rpc.call('sample'));
    phase.pipeline = metrics.observe(await page.evaluate(RenderOracle.snapshot));
    await StockWorkloads.end(rpc, phase, ready.features.stockGpuTrace,
      ready.features.stockGpuWorkloads && ready.features.captureTimings);
    if (ready.features.stockGpuTrace) phase.inputBreakdown = StockInputSummary.pair(phase.trace.inputSummary, phase.samples);
    assert.equal(phase.pipeline.kind, 'interval');
    const actual = await rpc.call('inspect');
    PilotTab.assertSame(report.tabState, actual.tabState);
    assert.equal(actual.sequence, sequence); assert.equal(actual.trusted, sequence); assert.equal(actual.scrollY, scrollY);
    phase.oracle = await RenderOracle.checkpoint(page, rpc);
    const sorted = phase.samples.map(s => s.latencyMs).sort((a, b) => a-b);
    phase.latency = { n: sorted.length, p50: sorted[Math.ceil(sorted.length*.5)-1],
      p95: sorted[Math.ceil(sorted.length*.95)-1], max: sorted.at(-1) };
    console.log(JSON.stringify({ mode: ready.mode, phase: name, latency: phase.latency, resources: phase.resources, pipeline: phase.pipeline }));
  }
  if (ready.features.stockGpuWorkloads) {
    report.stockWorkloads = [];
    await StockWorkloads.run(page, rpc, ready.features, report.stockWorkloads);
    for (const workload of report.stockWorkloads) {
      PilotTab.assertSame(report.tabState, workload.before.tabState);
      PilotTab.assertSame(report.tabState, workload.after.tabState);
    }
    report.controlRoundTripAfter = await StockWorkloads.controlRoundTrip(page);
  }
  const idleMetrics = new ViewerPipelineMetrics();
  idleMetrics.observe(await page.evaluate(RenderOracle.snapshot));
  const idleStart = await rpc.call('sample');
  await page.waitForTimeout(3000);
  report.idle = { resources: RenderOracle.delta(idleStart, await rpc.call('sample')),
    pipeline: idleMetrics.observe(await page.evaluate(RenderOracle.snapshot)) };
  if (ready.features.nativeDamageTrace) {
    report.nativeDamageTrace = await rpc.call('native-damage-trace');
    report.nativeDamageOracle = await RenderOracle.checkpoint(page, rpc);
    if (ready.customChromium) {
      assert(report.nativeDamageTrace.xdamage?.length > 0, 'Custom diagnostic produced no XDamage evidence');
      const swaps = report.nativeDamageTrace.summary.eglDamageSwaps.length;
      if (ready.customChromium.surfaceDamage) assert(swaps > 0, 'Custom feature produced no selective EGL swaps');
      else assert.equal(swaps, 0, 'Disabled custom feature produced selective swaps');
    }
  }
  if (ready.mode === 'gpu-tail') {
    report.gpuLifecycle = [];
    // Same viewer page, browser process and remote tab. Outside timing windows.
    for (const [width, height] of [[1024, 768], [1920, 1080], [1280, 720]]) {
      await page.locator('#resolution').selectOption(`${width}x${height}`);
      await page.waitForFunction(({ width, height }) => {
        const canvas = document.querySelector('#screen canvas');
        return window.browserpaneSession?.connected && canvas?.width === width && canvas?.height === height;
      }, { width, height }, { timeout: 45000 });
      await page.waitForTimeout(1000);
      report.gpuLifecycle.push({ width, height });
    }
    report.gpuResizeOracle = await RenderOracle.checkpoint(page, rpc);
    await page.reload({ timeout: 20000 });
    await page.waitForFunction(() => window.browserpaneSession?.connected
      && document.querySelector('#screen canvas')?.width === 1280, null, { timeout: 45000 });
    await page.waitForTimeout(2400);
    report.gpuReconnectOracle = await RenderOracle.checkpoint(page, rpc);
  }
  report.remoteGpuAfter = await rpc.call('gpu');
  PilotTab.assertSame(report.tabState, report.remoteGpuAfter.tabState);
  assert.equal(context.pages().length, 1, 'Unexpected extra local viewer tab');
  if (ready.features.captureTimings) {
    const logs = await rpc.call('timings');
    report.captureTimings = CaptureTimingSummary.parse(logs);
    report.readback = ReadbackDiagnostics.parse(logs);
    report.damageAnalysis = DamageAnalysisDiagnostics.parse(logs);
    report.diagnosticOnly = true; // Do not pool its input timings with clean runs.
  }
  if (ready.mode !== 'cpu') GpuStatus.validate({ featureStatus: report.remoteGpuAfter.features, auxAttributes: report.remoteGpuAfter.aux });
  assert.equal(errors.length, 0); assert.equal(downloads.length, 0);
  report.passed = true;
} catch (error) {
  report.error = error.stack; process.exitCode = 1;
  if (page && !page.isClosed()) report.viewerState = await page.evaluate(() => ({
    connected: window.browserpaneSession?.connected, text: document.body.innerText.slice(0, 2000),
    render: window.browserpaneSession?.getRenderDiagnostics(), stats: window.browserpaneSession?.getSessionStats(),
  })).catch(() => null);
  console.error(error);
} finally {
  const cleanup = await RenderPilotCleanup.run(rpc, browser);
  Object.assign(report, cleanup);
  if (!cleanup.ok) { report.passed = false; process.exitCode = 1; }
  await writeFile(process.argv[3], JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
}
