import assert from 'node:assert/strict';

// Checkpoint accounting for the REAL viewer pipeline. No synthetic decoder,
// scheduling hooks, cache changes or production telemetry are introduced.
export class ViewerPipelineMetrics {
  #previous = null;

  observe(snapshot) {
    const { epoch, elapsedMs, transfer, cache, tiles, video } = snapshot;
    assert(Number.isSafeInteger(epoch) && epoch > 0);
    assert(Number.isFinite(elapsedMs) && elapsedMs >= 0);
    const values = {
      receivedBytes: transfer.rxBytes, sentBytes: transfer.txBytes,
      tileCommandBytes: tiles.commandBytes, tileBatches: tiles.commands.batchEnd,
      imageCommands: tiles.imageCommands, cacheCommands: tiles.commands.cacheHit,
      fills: cache.fills, qoiDecodes: cache.qoiDecodes, zstdDecodes: cache.zstdDecodes,
      cacheHits: cache.hits, cacheMisses: cache.cacheMisses, cacheEvictions: cache.evictions,
      scrollCopies: cache.scrollCopies, snapshotHeaders: tiles.commands.gridConfig,
      videoRegionCommands: tiles.commands.videoRegion, videoFrames: video.decodedFrames,
      videoDropped: video.droppedFrames, videoDatagramBytes: video.datagramBytes,
      scrollPotentialTiles: tiles.scrollHealth.hostScrollPotentialTilesTotal,
      scrollSavedTiles: tiles.scrollHealth.hostScrollSavedTilesTotal,
      scrollFallbacks: tiles.scrollHealth.hostScrollFallbacksTotal,
      scrollExposedTiles: tiles.scrollHealth.hostScrollExposedStripTilesTotal,
      scrollInteriorRepairTiles: tiles.scrollHealth.hostScrollInteriorResidualTilesTotal,
    };
    for (const [key, value] of Object.entries(values)) {
      assert(Number.isSafeInteger(value) && value >= 0, `Missing/invalid pipeline counter: ${key}`);
    }
    const previous = this.#previous;
    this.#previous = { epoch, elapsedMs, values };
    // Never mix a cold connection with warm-cache deltas or subtract counters
    // across reconnects. A counter rollback is visible, not clamped to zero.
    if (!previous || previous.epoch !== epoch) {
      return { kind: previous ? 'new-session' : 'initial-session', cumulative: values };
    }
    assert(elapsedMs >= previous.elapsedMs, 'Session clock rolled back');
    const reset = Object.keys(values).filter(key => values[key] < previous.values[key]);
    if (reset.length) return { kind: 'counter-reset', counters: reset, cumulative: values };
    const delta = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value - previous.values[key]]));
    return { kind: 'interval', elapsedMs: elapsedMs - previous.elapsedMs, delta,
      bytesPerBatch: delta.tileBatches ? delta.tileCommandBytes / delta.tileBatches : null,
      scrollReuseFraction: delta.scrollPotentialTiles ? delta.scrollSavedTiles / delta.scrollPotentialTiles : null,
      scope: 'Application counters between settled checkpoints; includes oracle waits, NOT input latency, FPS or QUIC wire bytes' };
  }
}

export class CaptureTimingSummary {
  static parse(logs) {
    assert.equal(typeof logs, 'string');
    const phases = ['capture_us', 'scroll_us', 'classify_us', 'dirty_us', 'encode_send_us',
      'total_us', 'budget_wait_us', 'interval_us', 'dirty_tiles'];
    const rows = [];
    for (const line of logs.replace(/\x1b\[[0-9;]*m/g, '').split('\n')) {
      if (!line.includes('bpane_capture_timings') || !line.includes('capture timings')) continue;
      const row = {};
      for (const phase of phases) {
        const match = line.match(new RegExp(`\\b${phase}=(\\d+)(?=\\s|$)`));
        assert(match && Number.isSafeInteger(Number(match[1])), `Invalid capture timing: ${phase}`);
        row[phase] = Number(match[1]);
      }
      rows.push(row);
    }
    assert(rows.length > 0, 'No opt-in capture timing records; do not claim host phase coverage');
    const phasesSummary = {};
    for (const phase of phases) {
      const sorted = rows.map(row => row[phase]).sort((a, b) => a - b);
      phasesSummary[phase] = { p50: sorted[Math.ceil(sorted.length * .5) - 1],
        p95: sorted[Math.ceil(sorted.length * .95) - 1], max: sorted.at(-1) };
    }
    return { observedCaptures: rows.length, phases: phasesSummary,
      scope: 'Bounded log sample across the complete test; microseconds except dirty_tiles; no exact input/frame join or network/viewer timing' };
  }
}
