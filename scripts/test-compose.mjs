#!/usr/bin/env node
// Synthetic, key-free qualification. Every Docker mutation targets this unique project.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { createSocket } from 'node:dgram';
import https from 'node:https';

const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [browserRef, hermesRef] = process.argv.slice(2);
if (!browserRef || !hermesRef || process.argv.length !== 4) {
  throw new Error('Usage: node scripts/test-compose.mjs BROWSER_IMAGE HERMES_IMAGE (already built locally)');
}
const token = randomBytes(8).toString('hex');
const project = `bph-compose-${token}`;
const label = 'io.browserpane.bundle-test';
const directory = await mkdtemp(join(tmpdir(), 'bph-compose-'));
const docker = async (...args) => (await execute('docker', args, {
  cwd: root, env, timeout: 240000, maxBuffer: 1024 * 1024,
})).stdout.trim();
const env = { ...process.env, BIND_ADDRESS: '127.0.0.1', VIEWER_HOST: 'localhost', TZ: 'UTC' };
const compose = (...args) => docker('compose', '--project-directory', root, '--env-file', '.env.example',
  '-p', project, '-f', 'compose.yaml', '-f', join(directory, 'override.json'), ...args);
const inspect = async (kind, id) => JSON.parse(await docker(kind, 'inspect', id))[0];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const owned = (details, kind) => {
  const labels = kind === 'container' ? details.Config.Labels : details.Labels;
  assert.equal(labels?.[label], token, 'Refusing unowned Docker resource');
  assert.equal(labels?.['com.docker.compose.project'], project, 'Wrong Compose project');
};

async function freePort(udp = false) {
  const socket = udp ? createSocket('udp4') : createServer();
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    if (udp) socket.bind(0, '127.0.0.1', resolve);
    else socket.listen(0, '127.0.0.1', resolve);
  });
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return String(port);
}

async function request(ca, path, method = 'GET', headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host: '127.0.0.1', servername: 'localhost', port: env.HTTPS_PORT,
      path, method, ca, headers: { Host: `localhost:${env.HTTPS_PORT}`, ...headers } }, response => {
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 1024 * 1024) req.destroy(new Error('Oversized fixture HTTP response'));
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('HTTPS fixture timeout')));
    req.end();
  });
}

async function waitHealthy(id) {
  for (let attempt = 0; attempt < 90; attempt++) {
    const details = await inspect('container', id);
    owned(details, 'container');
    assert.equal(details.State.Running, true, 'Fixture service stopped unexpectedly');
    if (details.State.Health?.Status === 'healthy') return;
    await pause(1000);
  }
  throw new Error('Fixture service health deadline expired');
}

async function cleanup() {
  const ids = (await docker('ps', '-aq', '--filter', `label=${label}=${token}`)).split('\n').filter(Boolean);
  for (const id of ids) {
    owned(await inspect('container', id), 'container');
    await docker('stop', '--time', '45', id);
    await docker('rm', id);
  }
  for (const kind of ['network', 'volume']) {
    const names = (await docker(kind, 'ls', '-q', '--filter', `label=${label}=${token}`)).split('\n').filter(Boolean);
    for (const name of names) {
      owned(await inspect(kind, name), kind);
      await docker(kind, 'rm', name);
    }
    assert.equal(await docker(kind, 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`),
      '', `Unexpected ${kind} remains; refusing to remove an unlabelled resource`);
  }
  assert.equal(await docker('ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`), '',
    'Unexpected container remains; refusing to remove an unlabelled resource');
}

let started = false;
try {
  const images = await Promise.all([browserRef, hermesRef].map(ref => docker('image', 'inspect', '--format', '{{.Id}}', ref)));
  for (const image of images) assert.match(image, /^sha256:[0-9a-f]{64}$/);
  env.HTTPS_PORT = await freePort();
  env.GATEWAY_PORT = await freePort(true);
  const labels = { [label]: token };
  await writeFile(join(directory, 'override.json'), JSON.stringify({ services: {
    browserpane: { image: images[0], labels, restart: 'no' },
    hermes: { image: images[1], labels, restart: 'no' },
    web: { labels, restart: 'no' },
  }, networks: { agent: { labels }, viewer: { labels } }, volumes: Object.fromEntries(
    ['browser-data', 'hermes-data', 'shared-files', 'caddy-data', 'caddy-config'].map(name => [name, { labels }])) }));
  await compose('config', '--quiet');
  console.log(`Starting owned disposable Compose project ${project}`);
  started = true;
  await compose('up', '-d', '--no-build');
  const ids = {};
  for (const service of ['browserpane', 'hermes', 'web']) {
    const id = await compose('ps', '-q', service);
    assert.match(id, /^[0-9a-f]{64}$/);
    const details = await inspect('container', id);
    owned(details, 'container');
    assert.equal(details.Config.Labels['com.docker.compose.service'], service);
    ids[service] = id;
    for (const ports of Object.values(details.NetworkSettings.Ports ?? {})) {
      for (const port of ports ?? []) assert.equal(port.HostIp, '127.0.0.1');
    }
  }
  console.log(`Fixture containers ready: browser=${ids.browserpane} hermes=${ids.hermes} web=${ids.web}`);
  await Promise.all([waitHealthy(ids.browserpane), waitHealthy(ids.hermes)]);
  const doctor = JSON.parse(await docker('exec', ids.browserpane, 'node', '/app/server/doctor.mjs'));
  assert(Object.values(doctor).every(value => value === true));
  const verification = await docker('exec', ids.hermes, 'python', '/opt/hermes-bundle/verify.py', '--mcp');
  const reportStart = verification.indexOf('{\n  "hermesRevision":');
  assert(reportStart >= 0, 'Hermes discovery report missing');
  const discovery = JSON.parse(verification.slice(reportStart)).mcpDiscovery;
  assert.equal(discovery.server, 'browserpane');
  assert.equal(discovery.nativeBrowserEnabled, false);
  for (const tool of ['browser_navigate', 'browser_evaluate', 'browser_tabs']) {
    assert(discovery.registeredTools.includes(`mcp__browserpane__${tool}`));
  }
  for (const tool of ['browser_close', 'browser_install']) {
    assert(!discovery.registeredTools.includes(`mcp__browserpane__${tool}`));
  }
  console.log(`Real Hermes MCP discovery passed (${discovery.registeredTools.length} filtered tools)`);
  await docker('cp', `${ids.web}:/data/caddy/pki/authorities/local/root.crt`, join(directory, 'root.crt'));
  const ca = await readFile(join(directory, 'root.crt'));
  const redirect = await request(ca, '/');
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers['alt-svc'], undefined, 'TCP ingress must not advertise unpublished HTTP/3');
  assert.equal(redirect.headers.location, '/browser/');
  assert.equal((await request(ca, '/browser/')).status, 200);
  for (const path of ['/mcp', '/api/v1/sessions', '/json/version', '/healthz']) {
    assert.equal((await request(ca, path)).status, 404, `Ingress must hide ${path}`);
  }
  assert.equal((await request(ca, '/browser/bootstrap', 'POST')).status, 403);
  const ticket = await request(ca, '/browser/bootstrap', 'POST', {
    Origin: `https://localhost:${env.HTTPS_PORT}`, 'Sec-Fetch-Site': 'same-origin',
  });
  assert.equal(ticket.status, 200);
  const bootstrap = JSON.parse(ticket.body);
  assert.equal(bootstrap.gatewayUrl, `https://localhost:${env.GATEWAY_PORT}/`);
  assert.equal(typeof bootstrap.connectTicket, 'string');
  assert.equal(bootstrap.certHashUrl, '/browser/cert-hash');
  assert.match((await request(ca, bootstrap.certHashUrl)).body, /^[A-Za-z0-9+/]{43}=$/);
  console.log('Trusted HTTPS, redirect, scoped bootstrap, hidden control routes and private listeners passed');
  console.log('Compose smoke passed; no CA was installed and no model was called.');
} finally {
  if (started) await cleanup();
  await rm(directory, { recursive: true, force: true });
  console.log('Removed only this test project\'s labelled containers, networks and volumes.');
}
