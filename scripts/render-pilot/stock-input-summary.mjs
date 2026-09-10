import assert from 'node:assert/strict';
import { StockTraceSummary } from './stock-trace-summary.mjs';

// Chromium supplies components in one latency record. Never join rounded 64-bit
// numeric trace IDs from JSON. Fixture sequences use unique handler-time marks.
export class StockInputSummary {
  static extract(events) {
    assert(Array.isArray(events) && events.length <= 200000);
    const marks = events.filter(e => e.ph === 'I' && /^bph-input-\d+$/.test(e.name));
    const fields = ['INPUT_EVENT_LATENCY_ORIGINAL', 'INPUT_EVENT_LATENCY_RENDERER_MAIN',
      'INPUT_EVENT_LATENCY_RENDERING_SCHEDULED_MAIN', 'INPUT_EVENT_LATENCY_RENDERER_SWAP',
      'DISPLAY_COMPOSITOR_RECEIVED_FRAME', 'INPUT_EVENT_GPU_SWAP_BUFFER', 'INPUT_EVENT_LATENCY_FRAME_SWAP'];
    const records = [], missing = [];
    for (const event of events) {
      if (marks.length === 0) break; // Wheel/drag/animation have separate qualification, not keyed latency pairs.
      if (event.ph !== 'b' || event.name !== 'InputLatency::RawKeyDown') continue;
      const components = event.args?.chrome_latency_info?.component_info;
      assert(Array.isArray(components) && components.length < 64, 'Input component bound');
      const times = fields.map(name => {
        const matches = components.filter(c => c.component_type === 'COMPONENT_' + name);
        assert(matches.length <= 1, 'Duplicate input component');
        return matches[0]?.time_us;
      });
      if (times.some(t => t === undefined)) { missing.push(event.ts); continue; }
      assert(times.every(t => Number.isSafeInteger(t) && t >= 0), 'Invalid input component time');
      assert(times.every((t, i) => i === 0 || t >= times[i - 1]), 'Input component order');
      const candidates = marks.filter(m => m.ts >= times[1] && m.ts <= times[3]);
      assert(candidates.length === 1, 'Ambiguous/missing fixture sequence in input interval');
      const sequence = Number(candidates[0].name.slice('bph-input-'.length));
      assert(!records.some(r => r.sequence === sequence), 'Repeated input sequence');
      records.push({ sequence, originalUs: times[0], frameSwapUs: times.at(-1),
        browserInputToSwapUs: times.at(-1) - times[0],
        dispatchUs: times[1] - times[0], handlerToScheduleUs: times[2] - times[1],
        scheduleToRendererSwapUs: times[3] - times[2],
        rendererToDisplayUs: times[4] - times[3], displayToGpuSwapUs: times[5] - times[4],
        gpuSwapUs: times[6] - times[5] });
      assert(records.length <= 128, 'Input record bound');
    }
    return { records, missingComponents: missing.length,
      scope: 'Chromium input-component intervals to FRAME_SWAP; unique synthetic handler mark associates sequence. Not viewer/host capture frame IDs or physical presentation.' };
  }

  static pair(input, samples) {
    assert(input.records.length === samples.length && input.missingComponents === 0, 'Incomplete Chromium input coverage');
    const pairs = samples.map(sample => {
      const record = input.records.find(r => r.sequence === sample.sequence);
      assert(record && sample.matched, 'Missing measured input sequence');
      const remainderUs = sample.latencyMs * 1000 - record.browserInputToSwapUs;
      assert(remainderUs >= 0, 'Chromium interval exceeds observed end-to-end duration');
      return { ...record, endToEndUs: sample.latencyMs * 1000, remainderUs };
    });
    const summary = {};
    for (const field of ['endToEndUs', 'browserInputToSwapUs', 'remainderUs', 'dispatchUs',
      'handlerToScheduleUs', 'scheduleToRendererSwapUs', 'rendererToDisplayUs', 'displayToGpuSwapUs', 'gpuSwapUs']) {
      summary[field] = StockTraceSummary.distribution(pairs.map(row => row[field]));
    }
    return { pairs, summary,
      scope: 'Paired duration subtraction, not cross-host timestamp subtraction. Remainder is unassigned input/capture/transport/viewer work and waits; its components are not separately timed.' };
  }
}
