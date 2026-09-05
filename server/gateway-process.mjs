import { spawn, execFileSync } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { isIP } from 'node:net';
import { RuntimeSettings } from './runtime-settings.mjs';

// Hash-pinned WebTransport certificates use P-256 and live no longer than 14 days.
// Refresh the gateway (not Chromium) every 7 days, before the 10-day cert expires.
const directory = '/tmp/bpane/gateway';
const gatewayUrl = new URL(RuntimeSettings.fromEnvironment(process.env).gatewayUrl);
let child;
let stopping = false;
let rotation = false;
const rotate = () => { rotation = true; child?.kill('SIGTERM'); };
process.on('SIGTERM', () => { stopping = true; child?.kill('SIGTERM'); });
process.on('SIGINT', () => { stopping = true; child?.kill('SIGTERM'); });
process.on('SIGHUP', rotate);
await mkdir(directory, { recursive: true, mode: 0o700 });
while (!stopping) {
  await rm(`${directory}/token`, { force: true });
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256',
    '-nodes', '-days', '10', '-subj', `/CN=${gatewayUrl.hostname}`,
    '-addext', `subjectAltName=${isIP(gatewayUrl.hostname) ? 'IP' : 'DNS'}:${gatewayUrl.hostname}`,
    '-keyout', `${directory}/key.pem`, '-out', `${directory}/cert.pem`], { stdio: 'ignore' });
  child = spawn('/usr/local/bin/bpane-gateway', [
    '--cert', `${directory}/cert.pem`, '--key', `${directory}/key.pem`,
    '--port', '4433', '--bind', '0.0.0.0', '--api-port', '8932', '--api-bind', '127.0.0.1',
    '--public-gateway-url', gatewayUrl.href,
    '--agent-socket', process.env.BPANE_SOCKET_PATH,
    '--runtime-backend', 'static_single', '--runtime-cdp-endpoint', 'http://127.0.0.1:9222',
    '--runtime-idle-timeout-secs', '3153600000', '--token-file', `${directory}/token`,
  ], { stdio: 'inherit', env: { ...process.env, RUST_LOG: 'warn' } });
  rotation = false;
  const timer = setTimeout(rotate, 7 * 24 * 60 * 60 * 1000);
  const code = await new Promise((resolve, reject) => {
    child.once('exit', resolve);
    child.once('error', reject);
  });
  clearTimeout(timer);
  if (!stopping && !rotation) throw new Error(`Gateway exited unexpectedly (${code})`);
  if (rotation && !stopping) console.log('Refreshing WebTransport certificate; browser remains running');
}
