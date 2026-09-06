import assert from 'node:assert/strict';
import { basename, dirname } from 'node:path';
import { createServer } from 'node:net';
import { CompactRuntime } from '../server/compact/main.mjs';

// Child process only. The parent creates both the endpoint and temporary directory;
// never accept a personal/default CDP endpoint or a persistent shared directory.
const [endpoint, output] = process.argv.slice(2), url = new URL(endpoint);
assert.equal(url.protocol, 'http:'); assert.equal(url.hostname, '127.0.0.1');
assert(Number(url.port) > 0 && Number(url.port) <= 65535);
assert.equal(url.pathname, '/'); assert(!url.username && !url.password && !url.search && !url.hash);
assert.equal(basename(output), 'artifacts'); assert(basename(dirname(output)).startsWith('bpane-mcp-baseline-'));
const reservation = createServer();
await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
// Exact ephemeral authority; a port-binding race is a startup failure, not a wildcard.
const runtime = await CompactRuntime.create({ endpoint, host: '127.0.0.1', port,
  allowedHosts: [`127.0.0.1:${port}`], downloadDirectory: output, sharedDirectory: output });
let closed = false;
async function close() {
  if (closed) return; closed = true;
  try { await runtime.close(); } finally { process.exitCode = 0; }
}
process.once('SIGTERM', close); process.once('SIGINT', close);
const address = await runtime.start();
process.stderr.write(`Listening on http://127.0.0.1:${address.port}\n`);
