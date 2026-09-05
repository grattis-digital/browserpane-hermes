import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeSettings } from '../server/runtime-settings.mjs';

const fixture = () => ({ VIEWER_ORIGIN: 'https://localhost:8443', GATEWAY_URL: 'https://localhost:4433' });

test('normalizes HTTPS origin, default port and safe base without changing gateway port', () => {
  const settings = RuntimeSettings.fromEnvironment({
    VIEWER_ORIGIN: 'https://VIEWER.test:443/', GATEWAY_URL: 'https://viewer.test:4433/',
    VIEWER_BASE: '/browser///', VIEWER_HOST: 'viewer.test', BIND_ADDRESS: '127.0.0.1',
  });
  assert.deepEqual(settings, { origin: 'https://viewer.test', gatewayUrl: 'https://viewer.test:4433/', base: '/browser' });
  assert(Object.isFrozen(settings));
  assert.equal(RuntimeSettings.fromEnvironment({ ...fixture(), VIEWER_BASE: '/' }).base, '');
});

for (const value of [undefined, '', 'http://localhost', 'file:///etc/passwd', 'https://u:secret@localhost',
  'https://localhost/path', 'https://localhost/?token=secret', 'https://localhost/#secret',
  'https://localhost:0', 'https://localhost:99999', 'https://local_host', 'https://[::1]']) {
  test(`rejects unsupported normal origin ${String(value).replaceAll('secret', '[redacted]')}`, () => {
    assert.throws(() => RuntimeSettings.fromEnvironment({ ...fixture(), VIEWER_ORIGIN: value }), error =>
      error.code === 'INVALID_CONFIGURATION' && !error.message.includes('secret'));
  });
}

test('requires same gateway hostname and explicit valid bind address', () => {
  for (const changes of [{ GATEWAY_URL: 'https://other.test:4433' }, { VIEWER_HOST: 'other.test' },
    { BIND_ADDRESS: '0.0.0.0' }, { BIND_ADDRESS: '::' }, { BIND_ADDRESS: 'bad' },
    { BIND_ADDRESS: '224.0.0.1' }, { VIEWER_BASE: '/a/../b' }, { VIEWER_BASE: '/%2f' }]) {
    assert.throws(() => RuntimeSettings.fromEnvironment({ ...fixture(), ...changes }), { code: 'INVALID_CONFIGURATION' });
  }
});

test('isolated fixture opt-in permits only loopback HTTP viewer, never HTTP gateway', () => {
  assert.equal(RuntimeSettings.fromEnvironment({ ...fixture(), BPANE_PIPELINE_TEST: '1',
    VIEWER_ORIGIN: 'http://localhost:18090' }).origin, 'http://localhost:18090');
  for (const changes of [{ VIEWER_ORIGIN: 'http://viewer.test' }, { GATEWAY_URL: 'http://localhost:4433' },
    { VIEWER_ORIGIN: 'http://localhost:18090/path' }]) {
    assert.throws(() => RuntimeSettings.fromEnvironment({ ...fixture(), BPANE_PIPELINE_TEST: '1', ...changes }));
  }
});
