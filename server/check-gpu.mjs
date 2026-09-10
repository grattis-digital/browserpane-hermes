import WebSocket from 'ws';
import { GpuStatus } from './gpu-status.mjs';
import { GpuStatusError } from './gpu-status-error.mjs';
import { GpuCaptureHealth } from './gpu-capture-health.mjs';

try {
  const decode = process.env.BPANE_GPU_DECODE ?? 'off';
  GpuStatusError.require(['off', 'v4l2'].includes(decode), 'GPU_VIDEO_MODE_INVALID');
  await new GpuStatus(fetch, WebSocket).check({ requireVideoDecode: decode === 'v4l2' });
  if (process.env.BPANE_GPU_TAIL === '1') await new GpuCaptureHealth().check();
} catch (error) {
  console.error(`GPU readiness check failed code=${GpuStatusError.code(error)}; refusing silent software fallback`);
  process.exitCode = 1;
}
