// Read-only, outside measurement intervals; never searches for an arbitrary browser.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { DiagnosticCdp } from './diagnostic-cdp.mjs';

const [token, json] = process.argv.slice(2);
assert.equal(token, process.env.BPANE_RENDER_PILOT);
assert.match(token, /^[a-f0-9-]{36}$/);
assert.equal(process.env.BPANE_PIPELINE_TEST, '1');
const expected = JSON.parse(json);
assert.deepEqual(Object.keys(expected).sort(), ['sha256', 'surfaceDamage']);
assert.match(expected.sha256, /^[a-f0-9]{64}$/);
assert.equal(typeof expected.surfaceDamage, 'boolean');
assert.equal(process.env.BPANE_CUSTOM_DAMAGE, String(Number(expected.surfaceDamage)));
const root = '/opt/browserpane-chromium';
const binary = `${root}/chrome`;
assert.equal(await realpath(binary), binary);
const size = (await stat(binary)).size;
assert(size > 1024 * 1024 && size < 2 * 1024 ** 3, 'Custom binary size bound');
const hash = createHash('sha256');
for await (const chunk of createReadStream(binary)) hash.update(chunk);
assert.equal(hash.digest('hex'), expected.sha256, 'Custom binary digest differs');
const pid = (await readFile('/tmp/bpane/chromium.pid', 'utf8')).trim();
assert.match(pid, /^[1-9][0-9]{0,8}$/);
assert.equal(await realpath(`/proc/${pid}/exe`), binary, 'Running browser is not the custom binary');
const args = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0');
const enabled = args.filter(arg => arg.startsWith('--enable-features='));
const disabled = args.filter(arg => arg.startsWith('--disable-features='));
const has = entries => entries.at(-1)?.split('=')[1].split(',').includes('BrowserPaneSurfaceDamage') ?? false;
assert.equal(has(enabled), expected.surfaceDamage);
assert.equal(has(disabled), !expected.surfaceDamage);
assert(!args.some(arg => /^--(no-sandbox|disable-gpu-sandbox)(=|$)/.test(arg)));
const manifest = JSON.parse(await readFile(`${root}/build.json`, 'utf8'));
assert.equal(manifest.revision, '4999cc1efed37c4d91dc4ce6ec4b0a50e2a9a8cb');
assert.equal(manifest.version, '152.0.7977.75');
assert.equal(manifest.files?.chrome, expected.sha256);
const cdp = await DiagnosticCdp.connect();
try {
  const version = await cdp.call('Browser.getVersion');
  assert.equal(version.product.split('/').at(-1), manifest.version);
  console.log(JSON.stringify({ sha256: expected.sha256, revision: manifest.revision,
    version: manifest.version, surfaceDamage: expected.surfaceDamage, runningBinaryVerified: true }));
} finally { cdp.close(); }
