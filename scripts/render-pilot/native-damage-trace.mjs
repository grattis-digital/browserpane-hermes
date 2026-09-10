import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { DiagnosticCdp } from './diagnostic-cdp.mjs';
import { summarizeNativeDamage } from './native-damage-summary.mjs';
import { XDamageObserver } from './xdamage-observer.mjs';

// Deliberately finite diagnostic, not a production source of capture authority.
const token = process.argv[2];
assert.equal(token, process.env.BPANE_RENDER_PILOT);
assert.match(token, /^[a-f0-9-]{36}$/);
const cdp = await DiagnosticCdp.connect();
let tracing = false, completionTimer, observer;
try {
  const { targetInfos } = await cdp.call('Target.getTargets');
  const pages = targetInfos.filter(target => target.type === 'page');
  assert.equal(pages.length, 1); assert.equal(pages[0].url, 'about:blank');
  const { sessionId } = await cdp.call('Target.attachToTarget', { targetId: pages[0].targetId, flatten: true });
  const state = await cdp.call('Runtime.evaluate', { expression:
    '({token:window.__renderPilot?.token,visible:document.visibilityState,focused:document.hasFocus(),sequence:window.__renderPilot?.sequence})',
    returnByValue: true }, sessionId);
  assert.equal(state.result.value.token, token);
  assert.equal(state.result.value.visible, 'visible'); assert(state.result.value.focused);
  const version = await cdp.call('Browser.getVersion');
  const info = await cdp.call('SystemInfo.getInfo');
  let layerPaintCount = 0, layerTreeCount = 0;
  cdp.on('LayerTree.layerPainted', () => { assert(++layerPaintCount <= 512, 'Layer paint bound'); });
  cdp.on('LayerTree.layerTreeDidChange', () => { assert(++layerTreeCount <= 64, 'Layer tree bound'); });
  await cdp.call('LayerTree.enable', {}, sessionId);
  const completed = new Promise((resolve, reject) => {
    completionTimer = setTimeout(() => reject(new Error('Trace completion deadline')), 20000);
    cdp.on('Tracing.tracingComplete', params => { clearTimeout(completionTimer); resolve(params); });
  });
  // Attach a rejection observer immediately; the awaited result still fails below.
  completed.catch(() => {});
  if (process.env.BPANE_CUSTOM_DAMAGE !== undefined) observer = await XDamageObserver.start(token);
  await cdp.call('Tracing.start', { transferMode: 'ReturnAsStream', streamFormat: 'json',
    traceConfig: { recordMode: 'recordUntilFull', traceBufferSizeInKb: 8192,
      includedCategories: ['viz', 'cc', 'gpu', 'gpu.angle', 'disabled-by-default-viz.quads'] } });
  tracing = true;
  const inputs = ['a', 'a', 'a', 's', 'd', 'u'];
  for (const key of inputs) {
    const args = { key, code: 'Key' + key.toUpperCase(), windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0) };
    await cdp.call('Input.dispatchKeyEvent', { ...args, type: 'keyDown', text: key }, sessionId);
    await cdp.call('Input.dispatchKeyEvent', { ...args, type: 'keyUp' }, sessionId);
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  const after = await cdp.call('Runtime.evaluate', { expression: 'window.__renderPilot.sequence', returnByValue: true }, sessionId);
  assert.equal(after.result.value, state.result.value.sequence + inputs.length);
  await cdp.call('Tracing.end'); tracing = false;
  const xdamage = observer ? await observer.finish() : undefined;
  observer = undefined;
  const result = await completed;
  assert(!result.dataLossOccurred, 'Trace buffer lost events');
  assert.equal(typeof result.stream, 'string');
  const chunks = []; let bytes = 0;
  try {
    for (let reads = 0; ; reads++) {
      assert(reads < 1024, 'Trace chunk bound');
      const chunk = await cdp.call('IO.read', { handle: result.stream, size: 65536 });
      const buffer = Buffer.from(chunk.data, chunk.base64Encoded ? 'base64' : 'utf8');
      bytes += buffer.length; assert(bytes <= 32 * 1024 * 1024, 'Trace byte bound');
      chunks.push(buffer);
      if (chunk.eof) break;
    }
  } finally { await cdp.call('IO.close', { handle: result.stream }); }
  const trace = Buffer.concat(chunks);
  const events = JSON.parse(trace).traceEvents;
  assert(Array.isArray(events) && events.length > 0 && events.length <= 200000);
  // Only synthetic test content. Raw trace remains private and never enters Git.
  const path = '/tmp/bpane/native-damage-' + token + '.json';
  await writeFile(path, trace, { flag: 'wx', mode: 0o600 });
  const summary = summarizeNativeDamage(events);
  console.log(JSON.stringify({ path, bytes, events: events.length, version: version.product,
    driverBugWorkarounds: info.gpu.driverBugWorkarounds, aux: info.gpu.auxAttributes,
    summary, xdamage, layerPaintCount, layerTreeCount,
    scope: 'Finite synthetic diagnostic; not input latency or production capture metadata' }));
} finally {
  try {
    if (tracing) await cdp.call('Tracing.end').catch(() => {});
    if (observer) await observer.close();
  } finally { clearTimeout(completionTimer); cdp.close(); }
}
