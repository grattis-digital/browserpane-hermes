import { readFile } from 'node:fs/promises';
import { RuntimeSettings } from './runtime-settings.mjs';
import { ListenerStatus } from './listener-status.mjs';

try {
  RuntimeSettings.fromEnvironment(process.env);
  const [tcp, tcp6] = await Promise.all([
    readFile('/proc/net/tcp', 'utf8'), readFile('/proc/net/tcp6', 'utf8').catch(error => {
      if (error.code === 'ENOENT') return ''; // Hosts may disable IPv6 entirely.
      throw error;
    }),
  ]);
  const listeners = ListenerStatus.inspect(tcp, tcp6);
  const response = await fetch('http://127.0.0.1:8090/healthz', {
    signal: AbortSignal.timeout(6000),
  });
  const report = { configuration: true, healthy: response.ok, ...listeners };
  console.log(JSON.stringify(report, null, 2));
  if (!Object.values(report).every(Boolean)) process.exitCode = 1;
} catch {
  console.error('Doctor could not complete. Check component readiness and configuration.');
  process.exitCode = 1;
}
