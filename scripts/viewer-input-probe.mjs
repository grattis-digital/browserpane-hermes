// Disposable-test probes, serialized into the viewer/owned fixture respectively.
// A matching Pong drains earlier commands through the SAME reliable writer and
// sequential host dispatcher. It does not prove Chrome painted, or drain future
// resize retries; the pixel oracle must still settle and assert actual movement.
export class ViewerInputProbe {
  static flushHostInput = ({ timeoutMs = 8000 } = {}) => {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 8000) throw new Error('Invalid input barrier timeout');
    const session = window.browserpaneSession, runtime = session?.controlRuntime;
    if (!runtime || typeof runtime.handle !== 'function' || typeof session.sendFrame !== 'function') throw new Error('Viewer input transport unavailable');
    const activeKey = '__bpaneTestInputBarrier';
    if (Object.hasOwn(runtime, activeKey)) throw new Error('Viewer input barrier already active');
    const original = runtime.handle, descriptor = Object.getOwnPropertyDescriptor(runtime, 'handle');
    const nonce = crypto.getRandomValues(new Uint32Array(3));
    const seq = (nonce[0] | 0x80000000) >>> 0;
    const ping = new Uint8Array(13), view = new DataView(ping.buffer);
    ping[0] = 0x04; view.setUint32(1, seq, true);
    view.setUint32(5, nonce[1], true); view.setUint32(9, nonce[2], true);
    const expected = ping.slice(); expected[0] = 0x05;
    const started = performance.now(), marker = {};
    return new Promise((resolve, reject) => {
      let settled = false, deadline, watchdog;
      const current = () => window.browserpaneSession === session && session.controlRuntime === runtime
        && session.connected !== false;
      const finish = (error, failed = true) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline); clearInterval(watchdog);
        if (runtime.handle === observer) {
          if (descriptor) Object.defineProperty(runtime, 'handle', descriptor);
          else delete runtime.handle;
        }
        if (runtime[activeKey] === marker) delete runtime[activeKey];
        if (failed) reject(error); else resolve({ elapsedMs: performance.now() - started, seq });
      };
      function observer(...args) {
        const payload = args[0];
        const matches = payload instanceof Uint8Array && payload.length === expected.length
          && expected.every((byte, index) => payload[index] === byte);
        let result;
        try { result = Reflect.apply(original, this, args); }
        catch (error) { finish(error); throw error; }
        if (!current()) finish(new Error('Viewer session changed during input barrier'));
        else if (matches) finish(undefined, false);
        return result;
      }
      try {
        Object.defineProperty(runtime, activeKey, { value: marker, configurable: true });
        Object.defineProperty(runtime, 'handle', { value: observer, configurable: true, writable: true });
        deadline = setTimeout(() => finish(new Error('Host input barrier timed out')), timeoutMs);
        watchdog = setInterval(() => {
          if (!current()) finish(new Error('Viewer session changed during input barrier'));
          else if (runtime.handle !== observer) finish(new Error('Viewer input observer replaced during barrier'));
        }, 25);
        if (!current()) finish(new Error('Viewer session changed during input barrier'));
        else session.sendFrame(0x0a, ping);
      } catch (error) { finish(error); }
    });
  };

  static waitForClick = token => {
    if (typeof token !== 'string' || token.length === 0 || token.length > 128) throw new Error('Invalid fixture token');
    const started = performance.now();
    return new Promise((resolve, reject) => {
      let settled = false, deadline, watchdog;
      const finish = (error, result) => {
        if (settled) return;
        settled = true; clearTimeout(deadline); clearInterval(watchdog);
        if (result === undefined) reject(error); else resolve(result);
      };
      const poll = () => {
        try {
          if (window.__pipelineFixtureToken !== token) throw new Error('Unowned input fixture');
          const witness = window.__pipelineInputWitness;
          if (!witness || !Number.isInteger(witness.clicks) || witness.clicks < 0) throw new Error('Missing or invalid click witness');
          if (window.scrollX !== 0 || window.scrollY !== 0) throw new Error('Input readiness click changed document scroll');
          if (witness.clicks > 1) throw new Error('Input readiness requires exactly one click');
          if (witness.clicks === 0) return;
          const last = witness.last;
          if (!last || last.isTrusted !== true || last.button !== 0
            || !Number.isFinite(last.clientX) || !Number.isFinite(last.clientY)) throw new Error('Input readiness requires a trusted primary click');
          if (!document.hasFocus()) return;
          finish(null, { elapsedMs: performance.now() - started, clicks: 1, focused: true,
            clientX: last.clientX, clientY: last.clientY, scrollX: 0, scrollY: 0 });
        } catch (error) { finish(error); }
      };
      deadline = setTimeout(() => finish(new Error('Trusted focused content click timed out')), 8000);
      watchdog = setInterval(poll, 25);
      poll();
    });
  };
}
