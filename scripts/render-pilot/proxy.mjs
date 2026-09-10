// Test-only HTTPS ingress. Stream with normal Node backpressure; never buffer bodies.
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { request } from 'node:http';
import { readFileSync } from 'node:fs';

assert.equal(process.env.BPANE_PIPELINE_TEST, '1');
assert.match(process.env.BPANE_RENDER_PILOT ?? '', /^[a-f0-9-]{36}$/);
const origin = new URL(process.env.VIEWER_ORIGIN);
createServer({ key: readFileSync('/tmp/bpane/gateway/key.pem'), cert: readFileSync('/tmp/bpane/gateway/cert.pem') }, (incoming, outgoing) => {
  if (incoming.headers.host !== origin.host || !incoming.url?.startsWith('/browser/')) {
    outgoing.writeHead(403); outgoing.end(); return;
  }
  const upstream = request({ hostname: '127.0.0.1', port: 8090, path: incoming.url,
    method: incoming.method, headers: incoming.headers, timeout: 10000 }, response => {
    outgoing.writeHead(response.statusCode, response.headers); response.pipe(outgoing);
  });
  upstream.on('timeout', () => upstream.destroy());
  upstream.on('error', () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
  incoming.on('aborted', () => upstream.destroy());
  outgoing.on('close', () => upstream.destroy());
  incoming.pipe(upstream);
}).listen(8443, '0.0.0.0');
