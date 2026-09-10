import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { DiagnosticCdp } from './diagnostic-cdp.mjs';
import { StockTraceSummary } from './stock-trace-summary.mjs';
import { StockInputSummary } from './stock-input-summary.mjs';
import { StockPresentationSummary } from './stock-presentation-summary.mjs';

// Kept alive by ONE ownership-checked docker exec -i. EOF/deadline stops tracing.
// No restarts, browser flags, live profile access, screenshots or per-GL-call logs.
const [token, number] = process.argv.slice(2);
assert.equal(token, process.env.BPANE_RENDER_PILOT);
assert.equal(process.env.BPANE_STOCK_GPU_TRACE, '1');
assert.match(token, /^[a-f0-9-]{36}$/); assert.match(number, /^[1-8]$/);
const input = createInterface({ input: process.stdin });
let commandTimer, completionTimer, tracing = false;
const command = new Promise((resolve, reject) => {
  commandTimer = setTimeout(() => reject(new Error('Stock trace 60-second deadline')), 60000);
  input.once('line', line => resolve(line));
  input.once('close', () => reject(new Error('Trace controller EOF')));
});
command.catch(() => {});
let cdp;
try {
  cdp = await DiagnosticCdp.connect();
  const { targetInfos } = await cdp.call('Target.getTargets');
  const pages = targetInfos.filter(target => target.type === 'page');
  assert.equal(pages.length, 1); assert.equal(pages[0].url, 'about:blank');
  const { sessionId } = await cdp.call('Target.attachToTarget', { targetId: pages[0].targetId, flatten: true });
  const evaluate = expression => cdp.call('Runtime.evaluate', { expression, returnByValue: true }, sessionId);
  const state = await evaluate('({token:window.__renderPilot?.token,visible:document.visibilityState,focused:document.hasFocus()})');
  assert.equal(state.result.value.token, token); assert.equal(state.result.value.visible, 'visible');
  assert(state.result.value.focused);
  const categories = StockTraceSummary.categories((await cdp.call('Tracing.getCategories')).categories);
  const version = await cdp.call('Browser.getVersion'), gpu = (await cdp.call('SystemInfo.getInfo')).gpu;
  await cdp.call('Performance.enable', { timeDomain: 'timeTicks' }, sessionId);
  let maxBufferUsage = 0;
  cdp.on('Tracing.bufferUsage', value => { maxBufferUsage = Math.max(maxBufferUsage, value.percentFull ?? value.value ?? 0); });
  let complete;
  const completed = new Promise(resolve => { complete = resolve; });
  cdp.on('Tracing.tracingComplete', complete);
  await cdp.call('Tracing.start', { transferMode: 'ReturnAsStream', streamFormat: 'json',
    bufferUsageReportingInterval: 250, traceConfig: { recordMode: 'recordUntilFull',
      traceBufferSizeInKb: 8192, includedCategories: categories.included } });
  tracing = true;
  const clocks = [];
  const mark = async name => {
    const start = { wallMs: Date.now(), monotonicNs: process.hrtime.bigint().toString() };
    const result = await evaluate(`performance.mark(${JSON.stringify(name)}); true`);
    assert(!result.exceptionDetails);
    clocks.push({ name, before: start, after: { wallMs: Date.now(), monotonicNs: process.hrtime.bigint().toString() } });
  };
  await mark('bph-clock-start');
  const before = { processes: (await cdp.call('SystemInfo.getProcessInfo')).processInfo,
    metrics: (await cdp.call('Performance.getMetrics', {}, sessionId)).metrics };
  console.log(JSON.stringify({ ready: true, number: Number(number), version: version.product, categories, gpu }));
  assert.equal(await command, 'stop'); clearTimeout(commandTimer);
  await mark('bph-clock-end');
  const after = { processes: (await cdp.call('SystemInfo.getProcessInfo')).processInfo,
    metrics: (await cdp.call('Performance.getMetrics', {}, sessionId)).metrics,
    gpu: (await cdp.call('SystemInfo.getInfo')).gpu };
  await cdp.call('Tracing.end'); tracing = false;
  const result = await Promise.race([completed, new Promise((_, reject) => {
    completionTimer = setTimeout(() => reject(new Error('Stock trace completion deadline')), 15000);
  })]);
  clearTimeout(completionTimer);
  assert.equal(result.dataLossOccurred, false, 'Trace data loss');
  assert(maxBufferUsage < .95, 'Trace buffer pressure');
  assert.equal(typeof result.stream, 'string');
  const chunks = []; let bytes = 0;
  try {
    for (let reads = 0; ; reads++) {
      assert(reads < 512, 'Trace read bound');
      const chunk = await cdp.call('IO.read', { handle: result.stream, size: 65536 });
      const data = Buffer.from(chunk.data, chunk.base64Encoded ? 'base64' : 'utf8');
      bytes += data.length; assert(bytes <= 32 * 1024 * 1024, 'Trace byte bound'); chunks.push(data);
      if (chunk.eof) break;
    }
  } finally { await cdp.call('IO.close', { handle: result.stream }); }
  const trace = Buffer.concat(chunks), path = '/tmp/bpane/stock-gpu-' + token + '-' + number + '.json';
  // Exclusive raw file in the disposable container. The owner exports it after
  // successful summary validation; failures retain stderr, not unexported bytes.
  await writeFile(path, trace, { flag: 'wx', mode: 0o600 });
  const events = JSON.parse(trace).traceEvents;
  const summary = StockTraceSummary.summarize(events);
  const inputSummary = StockInputSummary.extract(events);
  const presentation = StockPresentationSummary.extract(events);
  for (const clock of clocks) assert.equal(summary.marks.filter(mark => mark.name === clock.name).length, 1, 'Missing/duplicate clock mark');
  console.log(JSON.stringify({ path, bytes, summary, inputSummary, presentation, clocks, before, after, maxBufferUsage,
    scope: 'Same-workload diagnostics. Clock mark occurs within recorded host bounds; not an exact causal capture/frame join.' }));
} finally {
  clearTimeout(commandTimer); clearTimeout(completionTimer); input.close();
  if (tracing) await cdp.call('Tracing.end').catch(() => {});
  cdp?.close();
}
