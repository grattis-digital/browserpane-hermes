import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const composeAvailable = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' }).status === 0;

test('rendered default Compose publishes only loopback HTTPS and direct QUIC', {
  skip: !composeAvailable && 'Docker Compose CLI required for interpolation checks',
}, () => {
  const config = JSON.parse(execFileSync('docker', [
    'compose', '--env-file', '.env.example', 'config', '--format', 'json',
  ], { encoding: 'utf8', env: { ...process.env, BIND_ADDRESS: '127.0.0.1',
    VIEWER_HOST: 'localhost', HTTPS_PORT: '8443', GATEWAY_PORT: '4433', TZ: 'UTC' } }));
  assert.deepEqual(Object.keys(config.services).sort(), ['browserpane', 'hermes', 'web']);
  const ports = Object.entries(config.services).flatMap(([service, value]) =>
    (value.ports ?? []).map(port => ({ service, target: port.target, published: String(port.published),
      host: port.host_ip, protocol: port.protocol })));
  assert.deepEqual(ports, [
    { service: 'browserpane', target: 4433, published: '4433', host: '127.0.0.1', protocol: 'udp' },
    { service: 'web', target: 8443, published: '8443', host: '127.0.0.1', protocol: 'tcp' },
  ]);
  for (const [name, service] of Object.entries(config.services)) {
    assert(!service.privileged && service.network_mode !== 'host');
    assert(!service.devices?.length);
    assert.deepEqual(service.cap_drop, ['ALL']);
    assert.deepEqual(service.cap_add ?? [], name === 'web' ? ['NET_BIND_SERVICE'] : []);
    assert((service.security_opt ?? []).some(value => value.startsWith('no-new-privileges')));
    for (const volume of service.volumes ?? []) assert(!volume.source.includes('docker.sock'));
  }
  const mounts = name => config.services[name].volumes.filter(volume => volume.type === 'volume')
    .map(volume => `${volume.source}:${volume.target}`).sort();
  assert.deepEqual(mounts('browserpane'), ['browser-data:/data', 'shared-files:/shared']);
  assert.deepEqual(mounts('hermes'), ['hermes-data:/opt/data', 'shared-files:/shared']);
  assert.equal(config.services.browserpane.environment.VIEWER_ORIGIN, 'https://localhost:8443');
  assert.equal(config.services.browserpane.environment.BPANE_PIPELINE_TEST, undefined);
  assert.equal(config.services.browserpane.environment.BPANE_CHROMIUM_SANDBOX_MODE, 'strict');
  assert.equal(config.services.browserpane.environment.BPANE_CDP_PROXY_ENABLE, '0');
  assert.equal(config.services.browserpane.environment.BPANE_MCP_TIMINGS, '0');
});

test('tracked capture defaults match pinned upstream without copying its initial browsing URL', async () => {
  const defaults = await readFile('runtime/host-runtime.env', 'utf8');
  const upstream = await readFile('upstream/deploy/host-runtime.env', 'utf8');
  const assignments = text => new Map(text.split('\n').filter(line => /^[A-Z_]+=/.test(line))
    .map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  for (const [key, value] of assignments(defaults)) assert.equal(value, assignments(upstream).get(key), key);
  assert(!defaults.includes('BPANE_URL='));
  assert(!defaults.includes('RUST_LOG='));
});

test('Caddy proxy routes are exclusive and never expose a generic internal upstream', async () => {
  const file = await readFile('config/Caddyfile', 'utf8');
  assert.match(file, /admin off/);
  assert.match(file, /tls internal/);
  assert.match(file, /protocols h1 h2/);
  assert.match(file, /@viewer path \/browser \/browser\/\*/);
  assert.match(file, /handle @viewer\s*\{\s*reverse_proxy browserpane:8090/);
  assert.match(file, /handle\s*\{\s*respond 404/);
  assert(!/8931|8932|9222|9223/.test(file));
});
