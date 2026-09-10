import assert from 'node:assert/strict';
import test from 'node:test';
import { ViewerPipelineMetrics, CaptureTimingSummary } from '../scripts/viewer-pipeline-metrics.mjs';

const fixture = (n = 1, epoch = 1) => ({epoch, elapsedMs:n*100,
  transfer:{rxBytes:n*1000,txBytes:n*30},
  cache:{fills:n,qoiDecodes:0,zstdDecodes:n, hits:n*2,cacheMisses:0,evictions:0,scrollCopies:n},
  tiles:{commandBytes:n*300,imageCommands:n,commands:{batchEnd:n,cacheHit:n*2,gridConfig:1,videoRegion:0},
    scrollHealth:{hostScrollPotentialTilesTotal:n*20,hostScrollSavedTilesTotal:n*15,hostScrollFallbacksTotal:0,
      hostScrollExposedStripTilesTotal:n*3,hostScrollInteriorResidualTilesTotal:n*2}},
  video:{decodedFrames:0,droppedFrames:0,datagramBytes:0}});

test('real-viewer counters separate warm deltas, cache reuse and actual application bytes',()=>{
  const metrics=new ViewerPipelineMetrics();
  assert.equal(metrics.observe(fixture()).kind,'initial-session');
  const interval=metrics.observe(fixture(2));
  assert.equal(interval.kind,'interval');
  assert.equal(interval.delta.receivedBytes,1000);
  assert.equal(interval.delta.tileCommandBytes,300);
  assert.equal(interval.delta.cacheHits,2);
  assert.equal(interval.delta.snapshotHeaders,0);
  assert.equal(interval.bytesPerBatch,300);
  assert.equal(interval.scrollReuseFraction,.75);
  assert.match(interval.scope,/NOT input latency/);
});
test('reconnect and counter rollback never produce fabricated negative or clamped savings',()=>{
  const metrics=new ViewerPipelineMetrics();
  metrics.observe(fixture(10));
  assert.equal(metrics.observe(fixture(1,2)).kind,'new-session');
  const reset=fixture(2,2);reset.cache.hits=0;
  const result=metrics.observe(reset);
  assert.equal(result.kind,'counter-reset');
  assert.deepEqual(result.counters,['cacheHits']);
});
test('zero-work intervals have no invented throughput or reuse ratio',()=>{
  const metrics=new ViewerPipelineMetrics();metrics.observe(fixture());
  const result=metrics.observe(fixture());
  assert.equal(result.bytesPerBatch,null);
  assert.equal(result.scrollReuseFraction,null);
});
test('missing, non-finite, negative and unsafe counters fail instead of looking like zero work',()=>{
  for(const value of [undefined,NaN,Infinity,-1,Number.MAX_SAFE_INTEGER+1]) {
    const data=fixture();data.cache.hits=value;
    assert.throws(()=>new ViewerPipelineMetrics().observe(data),/pipeline counter/);
  }
  const metrics=new ViewerPipelineMetrics();metrics.observe(fixture(2));
  assert.throws(()=>metrics.observe(fixture()),/clock rolled back/);
});
const timing = n => `WARN bpane_capture_timings: capture timings capture_seq=${n} capture_us=${n*100} scroll_us=3 classify_us=4 dirty_us=5 encode_send_us=6 total_us=${n*100+18} budget_wait_us=0 interval_us=16666 dirty_tiles=2`;
test('host timings are bounded-sample distributions, separate from viewer/input latency',()=>{
  const result=CaptureTimingSummary.parse(`unrelated log\n${timing(1)}\n\x1b[32m${timing(2)}\x1b[0m`);
  assert.equal(result.observedCaptures,2);
  assert.deepEqual(result.phases.capture_us,{p50:100,p95:200,max:200});
  assert.match(result.scope,/no exact input\/frame join/);
});
test('missing or malformed phase records cannot claim host timing coverage',()=>{
  assert.throws(()=>CaptureTimingSummary.parse('ordinary log'),/No opt-in/);
  assert.throws(()=>CaptureTimingSummary.parse(timing(1).replace('scroll_us=3','scroll_us=nan')),/Invalid/);
});
