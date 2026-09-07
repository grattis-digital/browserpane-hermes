import WebSocket from 'ws';
import { GpuStatus } from './gpu-status.mjs';
import { GpuStatusError } from './gpu-status-error.mjs';

try {
  await new GpuStatus(fetch, WebSocket).check();
} catch (error) {
  console.error(`GPU readiness check failed code=${GpuStatusError.code(error)}; refusing silent software fallback`);
  process.exitCode = 1;
}
