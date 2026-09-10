import assert from 'node:assert/strict';
import { RenderOracle } from './oracle.mjs';
import { ViewerPipelineMetrics } from '../viewer-pipeline-metrics.mjs';
import { HostTimingWindow } from './host-timing-window.mjs';
import { ViewerInputProbe } from '../viewer-input-probe.mjs';
import { ScrollbarProbe } from './scrollbar-probe.mjs';

// Same finite real-viewer workload with tracing on/off. Scroll tests assert
// movement + final whole-surface correctness, not transient/physical latency.
export class StockWorkloads {
  static async controlRoundTrip(page) {
    const samples = [];
    for (let i = 0; i < 5; i++) {
      samples.push((await page.evaluate(ViewerInputProbe.flushHostInput)).elapsedMs);
      await page.waitForTimeout(25);
    }
    const sorted = [...samples].sort((a, b) => a - b);
    return { samplesMs: samples, p50Ms: sorted[2], maxMs: sorted[4],
      scope: 'Reliable viewer/host control barrier round trip, including dispatch/queueing; not pure network RTT or painted feedback' };
  }

  static async begin(rpc, enabled) {
    return enabled ? rpc.call('stock-trace-start') : null;
  }

  static async end(rpc, phase, enabled, timings) {
    if (enabled) phase.trace = await rpc.call('stock-trace-stop');
    if (timings) {
      const logs = await rpc.call('timings');
      phase.hostWindow = HostTimingWindow.parse(logs, phase.resources.wallStartMs, phase.resources.wallEndMs);
      // Preserve cumulative source logs privately to audit window selection.
      phase.hostTimingLogs = logs;
    }
  }

  static async run(page, rpc, features, output = []) {
    for (const name of ['wheel', 'scrollbar', 'animation']) {
      const phase = { name };
      output.push(phase);
      const initial = await rpc.call('inspect');
      phase.before = initial;
      assert(initial.stock, 'Missing stock fixture');
      const rect = await page.locator('#screen canvas').first().boundingBox();
      assert(rect && Math.abs(rect.width - 1280) < .1 && Math.abs(rect.height - 720) < .1);
      if (name === 'wheel') await page.mouse.move(rect.x + 600, rect.y + initial.top + 300);
      if (name === 'scrollbar') {
        assert(initial.scrollbarWidth >= 8, 'Native scrollbar not visible');
        const x = Math.floor(initial.left + initial.innerWidth - initial.scrollbarWidth / 2);
        const pixels = await page.evaluate(ScrollbarProbe.column, { x, top: initial.top, height: initial.innerHeight });
        phase.scrollbarColumn = pixels; // Bounded synthetic diagnostic; outside measured interval.
        phase.thumb = ScrollbarProbe.locate(pixels, initial.innerHeight);
        phase.drag = { x: rect.x + x, y: rect.y + initial.top + phase.thumb.center, distance: 55 };
        await page.mouse.move(phase.drag.x, phase.drag.y);
      }
      phase.traceStart = await this.begin(rpc, features.stockGpuTrace);
      const metrics = new ViewerPipelineMetrics();
      metrics.observe(await page.evaluate(RenderOracle.snapshot));
      const before = await rpc.call('sample');
      if (name === 'wheel') {
        for (const delta of [7, 19, 43, 71, 109, 64, -11, -37, -83, 29, 13, -17]) {
          await page.mouse.wheel(0, delta);
          await page.waitForTimeout(31 + Math.abs(delta) % 37);
        }
      } else if (name === 'scrollbar') {
        await page.mouse.down();
        try {
          for (const offset of [4, 12, 27, 41, 55, 38, 21, 32, 44]) {
            await page.mouse.move(phase.drag.x, phase.drag.y + offset);
            await page.waitForTimeout(43);
          }
        } finally { await page.mouse.up(); }
      } else {
        await page.keyboard.press('g');
        await page.waitForTimeout(2000);
      }
      await page.evaluate(ViewerInputProbe.flushHostInput);
      await page.waitForTimeout(550);
      phase.resources = RenderOracle.delta(before, await rpc.call('sample'));
      phase.pipeline = metrics.observe(await page.evaluate(RenderOracle.snapshot));
      await this.end(rpc, phase, features.stockGpuTrace, features.captureTimings);
      phase.after = await rpc.call('inspect');
      if (name === 'animation') assert(phase.after.stock.animations === 1 && !phase.after.stock.animationActive);
      else assert(phase.after.scrollY !== initial.scrollY, name + ' did not move the remote page');
      if (name === 'scrollbar') {
        assert(phase.after.scrollY > initial.scrollY + 500, 'Scrollbar gesture did not drag the thumb down');
        assert(phase.after.stock.scrolls >= initial.stock.scrolls + 3, 'Missing continuous scrollbar movement');
      }
      if (name === 'wheel') assert(phase.after.stock.wheels > initial.stock.wheels, 'No remote wheel events');
      phase.oracle = await RenderOracle.checkpoint(page, rpc);
      console.log(JSON.stringify({ stage: 'stock-workload', name, scrollBefore: initial.scrollY,
        scrollAfter: phase.after.scrollY, pipeline: phase.pipeline, passed: true }));
    }
    return output;
  }
}
