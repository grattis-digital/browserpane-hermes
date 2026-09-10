import assert from 'node:assert/strict';
import { RenderFixture } from './fixture.mjs';
import { StockFixture } from './stock-fixture.mjs';
import { PilotTab } from './single-tab.mjs';

assert.equal(process.env.BPANE_PIPELINE_TEST, '1');
const task = JSON.parse(process.argv[2]);
assert.equal(task.token, process.env.BPANE_RENDER_PILOT);
assert(['install','inspect','gpu'].includes(task.op));
const endpoint = await fetch('http://127.0.0.1:9222/json/version', { signal: AbortSignal.timeout(3000) }).then(r => r.json());
const socket = new WebSocket(endpoint.webSocketDebuggerUrl);
let sequence = 0;
const pending = new Map();
const call = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = ++sequence;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP deadline: ' + method)); }, 8000);
  pending.set(id, { resolve, reject, timer });
  socket.send(JSON.stringify({ id, method, params, ...(sessionId ? {sessionId} : {}) }));
});
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data), waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id); clearTimeout(waiter.timer);
  if (message.error) waiter.reject(new Error('CDP operation rejected'));
  else waiter.resolve(message.result);
});
try {
  await new Promise((resolve,reject) => {
    const timer = setTimeout(() => reject(new Error('CDP connect deadline')), 3000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP connect failed')); }, { once: true });
  });
  const tabState = PilotTab.inspect((await call('Target.getTargets')).targetInfos);
  let result;
  if (task.op === 'gpu') {
    const info = await call('SystemInfo.getInfo');
    result = { features: info.gpu.featureStatus, aux: {
      glRenderer: info.gpu.auxAttributes.glRenderer, sandboxed: info.gpu.auxAttributes.sandboxed,
      processCrashCount: info.gpu.auxAttributes.processCrashCount } };
  } else {
    const { sessionId } = await call('Target.attachToTarget', { targetId: tabState.targetId, flatten: true });
    const fn = task.op === 'install' ? RenderFixture.install : RenderFixture.inspect;
    const reply = await call('Runtime.evaluate', { expression: `(${fn})(${JSON.stringify({token:task.token})})`, returnByValue: true }, sessionId);
    assert(!reply.exceptionDetails, 'Fixture rejected operation');
    result = reply.result.value;
    if (task.op === 'install' && process.env.BPANE_STOCK_GPU_WORKLOADS === '1') {
      const stock = await call('Runtime.evaluate', { expression: `(${StockFixture.install})(${JSON.stringify({ token: task.token })})`, returnByValue: true }, sessionId);
      assert(!stock.exceptionDetails && stock.result.value === true, 'Stock fixture rejected install');
    }
    if (task.op === 'install') await call('Page.bringToFront', {}, sessionId);
  }
  console.log(JSON.stringify({ ...result, tabState }));
} finally {
  for (const waiter of pending.values()) clearTimeout(waiter.timer);
  socket.close(); // Disconnect only; never Browser.close.
}
