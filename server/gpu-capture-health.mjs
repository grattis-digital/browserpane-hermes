import { createConnection } from 'node:net';
import { lstat } from 'node:fs/promises';
import { GpuStatusError } from './gpu-status-error.mjs';

/** Small liveness exchange with the supervisor; never captures or reads pixels. */
export class GpuCaptureHealth {
  #connect;
  #stat;
  constructor(connect = createConnection, stat = lstat) {
    this.#connect = connect;
    this.#stat = stat;
  }
  async check() {
    const path = '/tmp/.X11-unix/bpane-gpu-health.sock';
    const info = await this.#stat(path);
    if (!info.isSocket() || info.uid !== 10000 || (info.mode & 0o077) !== 0) {
      throw new GpuStatusError('GPU_CAPTURE_HEALTH_SOCKET_INVALID');
    }
    await new Promise((resolve, reject) => {
      const socket = this.#connect({ path });
      const expected = Buffer.from('BPH1 OK\n');
      let at = 0;
      let settled = false;
      const timer = setTimeout(() => finish(new GpuStatusError('GPU_CAPTURE_HEALTH_TIMEOUT')), 1500);
      const finish = error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(error); else resolve();
      };
      socket.on('data', data => {
        if (at + data.length > expected.length || !data.equals(expected.subarray(at, at + data.length))) {
          finish(new GpuStatusError('GPU_CAPTURE_UNHEALTHY')); return;
        }
        at += data.length;
      });
      socket.once('error', () => finish(new GpuStatusError('GPU_CAPTURE_UNAVAILABLE')));
      socket.once('end', () => finish(at === expected.length ? undefined : new GpuStatusError('GPU_CAPTURE_HEALTH_TRUNCATED')));
      socket.once('close', () => { if (!settled) finish(new GpuStatusError('GPU_CAPTURE_UNAVAILABLE')); });
    });
  }
}
