/** Pure hardware gate plus a bounded, read-only browser-level CDP query. */
export class GpuStatus {
  static validate(gpu) {
    const aux = gpu?.auxAttributes, status = gpu?.featureStatus;
    GpuStatusError.require(aux && status, 'GPU_STATUS_MISSING');
    GpuStatusError.require(/V3D/.test(aux.glRenderer ?? '') &&
      !/SwiftShader|llvmpipe|software|disabled/i.test(aux.glRenderer ?? ''), 'GPU_RENDERER_MISMATCH');
    GpuStatusError.require(aux.sandboxed === true, 'GPU_SANDBOX_INACTIVE');
    GpuStatusError.require(Number.isSafeInteger(Number(aux.processCrashCount)) &&
      Number(aux.processCrashCount) >= 0, 'GPU_STATUS_MISSING');
    GpuStatusError.require(Number(aux.processCrashCount) === 0, 'GPU_PROCESS_CRASHED');
    GpuStatusError.require(status.gpu_compositing === 'enabled', 'GPU_COMPOSITING_DISABLED');
    GpuStatusError.require(['enabled', 'enabled_force'].includes(status.rasterization), 'GPU_RASTERIZATION_DISABLED');
  }

  #fetch;
  #Socket;
  #timers;
  constructor(fetch, Socket, timers = { setTimeout, clearTimeout }) {
    this.#fetch = fetch; this.#Socket = Socket; this.#timers = timers;
  }

  async check() {
    let response, url;
    try {
      response = await this.#fetch('http://127.0.0.1:9222/json/version', { signal: AbortSignal.timeout(2500) });
    } catch (error) {
      throw new GpuStatusError(['TimeoutError', 'AbortError'].includes(error?.name) ? 'GPU_CDP_HTTP_TIMEOUT' : 'GPU_CDP_HTTP_UNAVAILABLE');
    }
    GpuStatusError.require(response.ok, 'GPU_CDP_HTTP_STATUS');
    try { url = new URL((await response.json()).webSocketDebuggerUrl); }
    catch { throw new GpuStatusError('GPU_CDP_METADATA_INVALID'); }
    if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || url.port !== '9222' ||
        url.username || url.password || url.search || url.hash || !url.pathname.startsWith('/devtools/browser/')) {
      throw new GpuStatusError('GPU_CDP_ENDPOINT_NOT_PRIVATE');
    }
    const gpu = await new Promise((resolve, reject) => {
      let socket;
      try { socket = new this.#Socket(url.href); }
      catch { reject(new GpuStatusError('GPU_CDP_SOCKET_FAILED')); return; }
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true; this.#timers.clearTimeout(timer); socket.close();
        if (error) reject(error); else resolve(value);
      };
      const timer = this.#timers.setTimeout(() => { finish(new GpuStatusError('GPU_CDP_QUERY_TIMEOUT')); socket.terminate(); }, 2500);
      socket.once('open', () => {
        try { socket.send(JSON.stringify({ id: 1, method: 'SystemInfo.getInfo' })); }
        catch { finish(new GpuStatusError('GPU_CDP_SOCKET_FAILED')); }
      });
      socket.once('error', () => finish(new GpuStatusError('GPU_CDP_SOCKET_FAILED')));
      socket.once('close', () => finish(new GpuStatusError('GPU_CDP_SOCKET_CLOSED')));
      socket.on('message', raw => {
        try {
          const message = JSON.parse(raw);
          if (message.id !== 1) return;
          if (message.error) { finish(new GpuStatusError('GPU_CDP_QUERY_REJECTED')); return; }
          finish(null, message.result?.gpu);
        } catch { finish(new GpuStatusError('GPU_CDP_RESPONSE_INVALID')); }
      });
    });
    GpuStatus.validate(gpu);
  }
}
import { GpuStatusError } from './gpu-status-error.mjs';
