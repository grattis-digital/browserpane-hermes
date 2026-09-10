import assert from 'node:assert/strict';

// Reported presentation feedback, not physical scanout or XDamage delivery.
// Several Chromium latency tracks can describe the same presentation; dedup
// identical endpoints instead of counting those as separate frames.
export class StockPresentationSummary {
  static extract(events) {
    assert(Array.isArray(events) && events.length <= 200000);
    const pending = new Map(), unique = new Map();
    let unmatched = 0;
    for (const event of [...events].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0))) {
      if (event.name !== 'SwapEndToPresentationCompositorFrame' || !['b', 'e'].includes(event.ph)) continue;
      assert(typeof event.id2?.local === 'string' && /^0x[0-9a-f]+$/.test(event.id2.local), 'Unsafe presentation track ID');
      assert(Number.isSafeInteger(event.ts) && event.ts >= 0, 'Invalid presentation timestamp');
      const key = event.pid + ':' + event.id2.local;
      if (event.ph === 'b') {
        assert(!pending.has(key), 'Duplicate presentation track');
        pending.set(key, event.ts);
      } else {
        const start = pending.get(key);
        if (start === undefined) { unmatched++; continue; }
        pending.delete(key);
        assert(event.ts >= start, 'Presentation time order');
        unique.set(start + ':' + event.ts, { frameSwapUs: start, presentationFeedbackUs: event.ts,
          reportedWaitUs: event.ts - start });
      }
      assert(pending.size <= 2048 && unique.size <= 2048, 'Presentation record bound');
    }
    return { records: [...unique.values()], unmatched: unmatched + pending.size,
      scope: 'Chromium-reported swap-end to presentation-feedback timestamps, deduplicated by endpoints; NOT physical scanout or a host-capture frame join' };
  }
}
