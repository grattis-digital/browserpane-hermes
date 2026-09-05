import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('build uses upstream transport without replacement plugins', async () => {
  const build = await readFile('scripts/build.mjs', 'utf8');
  assert(!build.includes('plugins:'));
  assert(!build.includes('onResolve'));
  const transport = await readFile('upstream/code/web/bpane-client/js/session-transport-runtime.ts', 'utf8');
  assert(transport.includes('serverCertificateHashes'));
  assert(transport.includes('readDatagrams'));
});

test('deployment selects upstream performance defaults and startup', async () => {
  const compose = await readFile('compose.yaml', 'utf8');
  assert(compose.includes('./runtime/host-runtime.env'));
  assert(!compose.includes('BPANE_H264_MODE: off'));
  const start = await readFile('runtime/start.sh', 'utf8');
  assert(start.includes('setsid bash /app/upstream/start-host.sh'));
  assert(!start.includes('chromium --'));
  const dockerfile = await readFile('Dockerfile', 'utf8');
  assert(dockerfile.includes('xcvt'));
  assert(dockerfile.includes('COPY --from=gateway-builder'));
});

test('Pi capture density matches Chromium without replacing the rendering stack', async () => {
  const compose = await readFile('compose.yaml', 'utf8');
  const app = await readFile('client/app.ts', 'utf8');
  assert.match(compose, /BPANE_DEVICE_SCALE:\s*"1"/);
  assert.match(app, /hiDpi:\s*false/);
  assert.match(app, /resizeSource:\s*'container'/);
  assert.match(app, /renderBackend:\s*'auto'/);
  assert.match(app, /scrollCopy:\s*true/);
  assert(!app.includes('setDeviceMetricsOverride'));
  assert(!app.includes('getDevicePixelRatio ='));
});
