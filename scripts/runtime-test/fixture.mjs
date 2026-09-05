// Executed only in the launcher's separately labelled, network-isolated sidecar.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
assert.match(process.env.BPANE_RUNTIME_TEST_ID ?? '', /^[a-f0-9-]{36}$/);
const path = `/${process.env.BPANE_RUNTIME_TEST_ID}`;
const server = createServer((request, response) => {
  if (request.url !== path) { response.writeHead(404).end(); return; }
  response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
  response.end('<!doctype html><title>Disposable profile fixture</title><h1>Shared persistent browser</h1>');
});
server.listen(9130, '0.0.0.0');
process.once('SIGTERM', () => server.close());
