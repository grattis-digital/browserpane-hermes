// Run inside the candidate with --network none and no host mounts/devices.
// Package/negotiation checks only: never launches Chromium or claims Pi decoding.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';

const query = (...args) => execFileSync('dpkg-query', args, { encoding: 'utf8' }).trim();
const version = '1:152.0.7977.82-1~deb12u1+rpt1';
for (const name of ['chromium', 'chromium-common', 'chromium-sandbox']) {
  assert.equal(query('-W', '-f=${Version}', name), version);
  assert.equal(query('-W', '-f=${Architecture}', name), 'arm64');
}
assert.equal(query('-W', '-f=${Version}', 'zenoty'), '0.2');
assert.match(execFileSync('/usr/lib/chromium/chromium', ['--version'], { encoding: 'utf8' }), /152\.0\.7977\.82/);
const libraries = execFileSync('ldd', ['/usr/lib/chromium/chromium'], { encoding: 'utf8' });
assert(!libraries.includes('not found'), 'Chromium shared-library dependencies must resolve');

const root = '/opt/browserpane/h264ify';
const manifest = JSON.parse(readFileSync(`${root}/manifest.json`, 'utf8'));
assert.equal(manifest.version, '2.0.1'); assert.equal(manifest.manifest_version, 3);
assert.deepEqual(manifest.permissions, ['scripting', 'storage']);
assert.deepEqual(manifest.host_permissions, ['*://*.youtube.com/*', '*://*.youtube-nocookie.com/*', '*://*.youtu.be/*']);
assert.equal(manifest.update_url, undefined);
assert.match(readFileSync(`${root}/LICENSE`, 'utf8'), /Copyright \(c\) 2015 erkserkserks/);
const script = readFileSync(`${root}/src/inject/inject.js`, 'utf8');
assert(script.length < 16384);
// Exercise the pinned dependency only in an isolated synthetic realm.
const realm = { localStorage: {}, navigator: {}, window: {}, document: {} };
const videoPrototype = { canPlayType: () => 'probably' };
realm.document.createElement = () => Object.create(videoPrototype);
realm.window.MediaSource = { isTypeSupported: () => true };
runInNewContext(script, realm, { timeout: 1000 });
for (const codec of ['video/webm; codecs="vp9"', 'video/mp4; codecs="av01.0.05M.08"', 'video/webm; codecs="vp8"']) {
  assert(!realm.window.MediaSource.isTypeSupported(codec));
  assert(!realm.document.createElement('video').canPlayType(codec));
}
assert.equal(realm.window.MediaSource.isTypeSupported('video/mp4; codecs="avc1.64001f"'), true);
assert.equal(realm.document.createElement('video').canPlayType('video/mp4; codecs="avc1.64001f"'), 'probably');
assert.equal(realm.window.MediaSource.isTypeSupported('audio/mp4; codecs="mp4a.40.2"'), true);
const entries = execFileSync('tar', ['-tzf', '/app/source.tar.gz'], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }).split('\n');
for (const file of ['Dockerfile.gpu-decode', 'compose.gpu-decode.yaml', 'server/gpu-video-status.mjs']) assert(entries.includes(file));
console.log(JSON.stringify({ packageCheck: 'passed', chromium: version, extension: manifest.version,
  syntheticCodecNegotiation: 'passed', hardwareDecode: 'not-tested', browserLaunched: false }));
