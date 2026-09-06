import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { X509Certificate, createHash } from 'node:crypto';
import { GatewayAdmin, trustedBootstrap } from './gateway-admin.mjs';
import { RuntimeSettings } from './runtime-settings.mjs';

const { base, origin, gatewayUrl } = RuntimeSettings.fromEnvironment(process.env);
const admin = new GatewayAdmin({ gatewayUrl, certHashUrl: `${base}/cert-hash` });
const files = new Map([
  ['/', ['/app/dist/index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['/app/dist/app.js', 'text/javascript; charset=utf-8']],
  ['/audio-worklet.js', ['/app/dist/audio-worklet.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['/app/dist/style.css', 'text/css; charset=utf-8']],
  ['/source', ['/app/source.tar.gz', 'application/gzip']],
]);

const server = createServer(async (request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ${new URL(gatewayUrl).origin}; img-src 'self' blob: data:; worker-src 'self' blob:; frame-ancestors 'self'`);
  let url;
  try { url = new URL(request.url, 'http://local'); }
  catch { response.writeHead(400).end(); return; }
  if (base && url.pathname === base) {
    response.writeHead(308, { Location: `${base}/` }).end(); return;
  }
  const path = url.pathname === '/healthz' ? '/healthz' :
    url.pathname.startsWith(`${base}/`) ? url.pathname.slice(base.length) : null;
  if (path === '/bootstrap' && request.method === 'POST') {
    if (!trustedBootstrap(request.headers, origin)) {
      response.writeHead(403).end(); return;
    }
    try {
      const result = await admin.bootstrap();
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(result));
    } catch (error) {
      console.error(error.message);
      response.writeHead(503).end('Browser gateway is starting; please reconnect');
    }
    return;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405).end(); return; }
  if (path === '/healthz') {
    try {
      await access('/tmp/bpane/agent.sock');
      const cdp = await fetch('http://127.0.0.1:9222/json/version', { signal: AbortSignal.timeout(1500) });
      const mcp = await fetch('http://127.0.0.1:8931/mcp', { signal: AbortSignal.timeout(1500) });
      const gateway = await fetch('http://127.0.0.1:8932/readyz', { signal: AbortSignal.timeout(1500) });
      response.writeHead(cdp.ok && gateway.ok && mcp.status < 500 && mcp.status !== 403 ? 200 : 503).end('browserpane-hermes');
    } catch { response.writeHead(503).end('starting'); }
    return;
  }
  if (path === '/cert-hash') {
    try {
      const certificate = new X509Certificate(await readFile('/tmp/bpane/gateway/cert.pem'));
      response.setHeader('Content-Type', 'text/plain');
      response.end(createHash('sha256').update(certificate.raw).digest('base64'));
    } catch { response.writeHead(503).end('starting'); }
    return;
  }
  const file = files.get(path);
  if (!file) { response.writeHead(404).end(); return; }
  response.setHeader('Content-Type', file[1]);
  if (path === '/source') response.setHeader('Content-Disposition', 'attachment; filename="browserpane-hermes-source.tar.gz"');
  if (request.method === 'HEAD') { response.end(); return; }
  const stream = createReadStream(file[0]);
  stream.on('error', () => { if (!response.headersSent) response.writeHead(500); response.end(); });
  stream.pipe(response);
});
server.requestTimeout = 15000;
server.headersTimeout = 10000;
server.maxConnections = 24;
server.listen(8090, '0.0.0.0', () => console.log('Single browser viewer ready on :8090'));
process.on('SIGTERM', () => { server.closeAllConnections(); server.close(() => process.exit(0)); });
