import assert from 'node:assert/strict';

// Offline, bounded diagnostics. Inclusive spans overlap: never sum them into a
// latency budget or interpret GL API wall time as GPU execution time.
export class StockTraceSummary {
  static categories(available) {
    assert(Array.isArray(available) && available.length <= 4096);
    const requested = ['benchmark', 'toplevel', 'cc', 'viz', 'gpu', 'gpu.angle',
      'input', 'latencyInfo', 'blink.user_timing', 'devtools.timeline',
      'disabled-by-default-viz.quads', 'disabled-by-default-gpu.service'];
    const included = requested.filter(name => available.includes(name));
    for (const name of ['cc', 'viz', 'gpu', 'blink.user_timing']) {
      assert(included.includes(name), 'Missing required trace category: ' + name);
    }
    return { included, unavailable: requested.filter(name => !included.includes(name)) };
  }

  static summarize(events) {
    assert(Array.isArray(events) && events.length > 0 && events.length <= 200000, 'Trace event bound');
    const threads = new Map(), processes = new Map(), stacks = new Map(), groups = new Map();
    const marks = [], damage = [], phases = {}, spans = [];
    let unmatchedEnds = 0;
    for (const event of events) {
      if (event.ph === 'M' && event.name === 'thread_name') threads.set(event.pid + ':' + event.tid, event.args?.name);
      if (event.ph === 'M' && event.name === 'process_name') processes.set(event.pid, event.args?.name);
    }
    for (const event of [...events].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0))) {
      phases[event.ph] = (phases[event.ph] ?? 0) + 1;
      if (!Number.isFinite(event.ts) || event.ts < 0) continue;
      if (/^bph-(clock-(start|end)|input-\d+|wheel-\d+|scroll-\d+|animation-(start|end))$/.test(event.name)) {
        assert(marks.length < 2048, 'Trace marker bound');
        marks.push({ name: event.name, ts: event.ts, pid: event.pid, tid: event.tid });
      }
      if (event.name === 'DirectRenderer::DrawFrame ProcessForOverlays') {
        const match = /^(\d+),(\d+) (\d+)x(\d+)$/.exec(event.args?.root_damage_rect ?? '');
        assert(match && damage.length < 2048, 'Invalid/bounded root damage');
        const [x, y, width, height] = match.slice(1).map(Number);
        assert(x + width <= 1280 && y + height <= 720, 'Unexpected diagnostic geometry');
        damage.push({ ts: event.ts, x, y, width, height, pixels: width * height });
      }
      const key = event.pid + ':' + event.tid;
      if (event.ph === 'B') {
        if (!stacks.has(key)) stacks.set(key, []);
        assert(stacks.get(key).length < 256, 'Trace nesting bound');
        stacks.get(key).push(event);
      } else if (event.ph === 'E') {
        const begin = stacks.get(key)?.pop();
        if (!begin) { unmatchedEnds++; continue; }
        assert(!event.name || event.name === begin.name, 'Mismatched trace span');
        spans.push({ ...begin, dur: event.ts - begin.ts,
          tdur: Number.isFinite(begin.tts) && Number.isFinite(event.tts) ? event.tts - begin.tts : undefined });
      } else if (event.ph === 'X') spans.push(event);
    }
    for (const event of spans) {
      assert(Number.isFinite(event.dur) && event.dur >= 0 && event.dur <= 120e6, 'Invalid trace duration');
      const name = event.name;
      // Do not export event arguments or dynamic URL-bearing names.
      if (typeof name !== 'string' || name.length > 180 || /https?:|file:|data:/.test(name)) continue;
      const key = event.pid + ':' + event.tid + ':' + name;
      if (!groups.has(key)) {
        assert(groups.size < 8192, 'Trace group bound');
        groups.set(key, { name, pid: event.pid, tid: event.tid, process: processes.get(event.pid),
          thread: threads.get(event.pid + ':' + event.tid), durations: [], threadTimes: [] });
      }
      groups.get(key).durations.push(event.dur);
      if (Number.isFinite(event.tdur) && event.tdur >= 0) groups.get(key).threadTimes.push(event.tdur);
    }
    const durations = [...groups.values()].map(({ durations: values, threadTimes, ...group }) => ({
      ...group, ...this.distribution(values), inclusiveTotalUs: values.reduce((a, b) => a + b, 0),
      threadCpu: threadTimes.length ? { ...this.distribution(threadTimes),
        inclusiveTotalUs: threadTimes.reduce((a, b) => a + b, 0) } : null,
    })).sort((a, b) => b.inclusiveTotalUs - a.inclusiveTotalUs);
    return { phases, marks, damage, durations: durations.slice(0, 160),
      gpuDurations: durations.filter(row => /gpu|viz|compositor|raster/i.test(row.thread ?? '')).slice(0, 160),
      unmatchedEnds, unmatchedBegins: [...stacks.values()].reduce((n, stack) => n + stack.length, 0),
      scope: 'Inclusive CPU-thread wall spans, possibly overlapping and blocking; NOT GPU execution time or a causal input/frame join' };
  }

  static distribution(values) {
    assert(values.length > 0 && values.every(v => Number.isFinite(v) && v >= 0));
    const sorted = [...values].sort((a, b) => a - b);
    return { n: sorted.length, p50Us: sorted[Math.ceil(sorted.length * .5) - 1],
      p95Us: sorted[Math.ceil(sorted.length * .95) - 1], maxUs: sorted.at(-1) };
  }
}
