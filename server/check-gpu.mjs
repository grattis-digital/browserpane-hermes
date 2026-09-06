import WebSocket from 'ws';
import { GpuStatus } from './gpu-status.mjs';

try {
  await new GpuStatus(fetch, WebSocket).check();
} catch {
  console.error('GPU readiness check failed; refusing silent software fallback');
  process.exitCode = 1;
}
