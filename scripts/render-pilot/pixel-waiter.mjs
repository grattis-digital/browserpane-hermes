// This observer reads a few diagnostic pixels only AFTER actual viewer batches.
// It does not call flush(), change rendering, decode a substitute protocol, or
// use CDP to inject the measured input. Readback completion is not monitor scanout.
export class PixelWaiter {
  static arm = ({ token, key, points, width, height, timeoutMs = 3000 }) => {
    if (!/^[a-f0-9-]{36}$/.test(token) || !['a','s','d','u'].includes(key)
      || !Array.isArray(points) || points.length < 1 || points.length > 8
      || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 5000) throw new Error('Invalid pixel observation');
    if (window.__renderPixelWaiter?.active) throw new Error('Pixel observation already active');
    for (const p of points) {
      if (![p.x,p.y,...p.rgb].every(Number.isInteger) || p.x < 0 || p.y < 0 || p.x >= width || p.y >= height
        || p.rgb.length !== 3 || p.rgb.some(v => v < 0 || v > 255)) throw new Error('Invalid expected pixel');
    }
    const session = window.browserpaneSession, canvas = document.querySelector('#screen canvas');
    if (!session || !canvas || canvas.width !== width || canvas.height !== height) throw new Error('Viewer not ready');
    const renderer = session.getRenderDiagnostics();
    const context = canvas.getContext(renderer.backend === 'webgl2' ? 'webgl2' : '2d');
    if (!context) throw new Error('Viewer has no drawable context');
    const pixel = new Uint8Array(4);
    const state = { token, active: true, inputAt: null, reads: 0 };
    window.__renderPixelWaiter = state;
    const before = session.getTileCacheStats();
    let frame, deadline, settle;
    state.result = new Promise(resolve => { settle = resolve; });
    const finish = (reason, match = false) => {
      if (!state.active) return;
      state.active = false; cancelAnimationFrame(frame); clearTimeout(deadline);
      document.removeEventListener('keydown', input, true);
      const ended = performance.now();
      settle({ matched: match, reason, latencyMs: match ? ended - state.inputAt : null,
        inputObserved: state.inputAt !== null, pixelReads: state.reads,
        batchDelta: session.getTileCacheStats().batchesQueued - before.batchesQueued });
    };
    const matches = () => points.every(p => {
      if (renderer.backend === 'webgl2') context.readPixels(p.x, height - 1 - p.y, 1, 1, context.RGBA, context.UNSIGNED_BYTE, pixel);
      else pixel.set(context.getImageData(p.x, p.y, 1, 1).data);
      state.reads++;
      return p.rgb.every((v, index) => v === pixel[index]);
    });
    const tick = () => {
      try {
        if (window.browserpaneSession !== session || session.connected === false
          || canvas.width !== width || canvas.height !== height || document.visibilityState !== 'visible') return finish('session-or-geometry-changed');
        const batches = session.getTileCacheStats().batchesQueued;
        // Browser rendering has a microtask checkpoint before this rAF. The
        // readback additionally waits for these pixels; BatchEnd alone is not success.
        // Queued is not completed: retry on subsequent rAFs until the decoder's
        // asynchronous work is visible, even if no further batch arrives.
        if (state.inputAt !== null && batches > before.batchesQueued) {
          if (matches()) return finish(null, true);
        }
        frame = requestAnimationFrame(tick);
      } catch { finish('pixel-observer-failed'); }
    };
    function input(event) {
      if (event.key !== key) return;
      if (!event.isTrusted || event.repeat || state.inputAt !== null) return finish('invalid-input');
      state.inputAt = performance.now();
    }
    document.addEventListener('keydown', input, true);
    deadline = setTimeout(() => finish(state.inputAt === null ? 'input-not-observed' : 'pixel-timeout'), timeoutMs);
    frame = requestAnimationFrame(tick);
    return { armed: true };
  };

  static result = async token => {
    if (window.__renderPixelWaiter?.token !== token) throw new Error('Unowned pixel observer');
    return window.__renderPixelWaiter.result;
  };
}
