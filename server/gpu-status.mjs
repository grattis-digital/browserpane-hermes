/** Pure hardware gate plus a bounded, read-only browser-level CDP query. */
export class GpuStatus {
  static validate(gpu) {
    const aux = gpu?.auxAttributes, status = gpu?.featureStatus;
    if (!aux || !/V3D/.test(aux.glRenderer ?? '') ||
        /SwiftShader|llvmpipe|software|disabled/i.test(aux.glRenderer ?? '') ||
        aux.sandboxed !== true || Number(aux.processCrashCount) !== 0 ||
        status?.gpu_compositing !== 'enabled' ||
        !['enabled', 'enabled_force'].includes(status?.rasterization)) {
      throw new Error('V3D rendering, GPU rasterization and active crash-free GPU sandbox are required');
    }
  }

  #fetch;
  #Socket;
  constructor(fetch, Socket) { this.#fetch = fetch; this.#Socket = Socket; }

  async check() {
    const response = await this.#fetch('http://127.0.0.1:9222/json/version', { signal: AbortSignal.timeout(2500) });
    if (!response.ok) throw new Error('GPU status endpoint unavailable');
    const { webSocketDebuggerUrl } = await response.json();
    const url = new URL(webSocketDebuggerUrl);
    if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || url.port !== '9222' ||
        url.username || url.password || url.search || url.hash || !url.pathname.startsWith('/devtools/browser/')) {
      throw new Error('GPU status endpoint is not private browser CDP');
    }
    const gpu = await new Promise((resolve, reject) => {
      const socket = new this.#Socket(url.href);
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true; clearTimeout(timer); socket.close();
        if (error) reject(error); else resolve(value);
      };
      const timer = setTimeout(() => { finish(new Error('GPU status query timed out')); socket.terminate(); }, 2500);
      socket.once('open', () => socket.send(JSON.stringify({ id: 1, method: 'SystemInfo.getInfo' })));
      socket.once('error', () => finish(new Error('GPU status connection failed')));
      socket.once('close', () => finish(new Error('GPU status connection closed')));
      socket.on('message', raw => {
        try {
          const message = JSON.parse(raw);
          if (message.id !== 1) return;
          if (message.error) throw new Error('GPU status query rejected');
          finish(null, message.result?.gpu);
        } catch { finish(new Error('GPU status response invalid')); }
      });
    });
    GpuStatus.validate(gpu);
  }
}
