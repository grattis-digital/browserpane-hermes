import assert from 'node:assert/strict';
import { createServer, request as forward } from 'node:http';

/** Owned-loopback fault injector. Not shipped or configurable as a production proxy. */
export class WorkflowMcpProxy {
  #server; #target; #before; #after; #errors = []; #calls = [];
  constructor(target, { before = async () => {}, after = async () => {} } = {}) {
    this.retarget(target); this.#before = before; this.#after = after;
  }
  retarget(target) {
    const parsed = new URL(target);
    assert.equal(parsed.hostname, '127.0.0.1'); assert.equal(parsed.protocol, 'http:'); assert.equal(parsed.pathname, '/mcp');
    assert(!parsed.username && !parsed.password && !parsed.search && !parsed.hash); this.#target = parsed;
  }
  async start() {
    this.#server = createServer((req, res) => {
      this.#handle(req, res).catch(error => { this.#errors.push(error.message); res.destroy(); });
    });
    this.#server.requestTimeout = 30000;
    await new Promise((resolve, reject) => { this.#server.once('error', reject); this.#server.listen(0, '127.0.0.1', resolve); });
  }
  endpoint() { assert(this.#server); return `http://127.0.0.1:${this.#server.address().port}/mcp`; }
  calls() { return [...this.#calls]; }
  async #handle(req, res) {
    assert.equal(req.url, '/mcp'); assert(['POST', 'GET', 'DELETE'].includes(req.method));
    let body = Buffer.alloc(0);
    for await (const chunk of req) { assert(body.length + chunk.length <= 65536); body = Buffer.concat([body, chunk]); }
    const message = body.length ? JSON.parse(body) : {};
    const tool = message.method === 'tools/call' ? message.params.name : undefined;
    if (tool) { assert(this.#calls.length < 256); this.#calls.push(tool); }
    await this.#before(tool);
    await new Promise((resolve, reject) => {
      const upstream = forward(this.#target, { method: req.method, headers: { ...req.headers, host: this.#target.host } }, incoming => {
        if (!tool) {
          res.writeHead(incoming.statusCode, incoming.headers); incoming.pipe(res);
          incoming.once('end', resolve); incoming.once('error', reject); res.once('close', () => { incoming.destroy(); resolve(); });
          return;
        }
        let output = Buffer.alloc(0);
        incoming.on('data', chunk => {
          if (output.length + chunk.length > 131072) { incoming.destroy(new Error('Owned proxy output limit')); return; }
          output = Buffer.concat([output, chunk]);
        });
        incoming.once('error', reject);
        incoming.once('end', () => {
          this.#after(tool).then(() => { res.writeHead(incoming.statusCode, incoming.headers); res.end(output); resolve(); }, reject);
        });
      });
      upstream.setTimeout(25000, () => upstream.destroy(new Error('Owned proxy timeout')));
      upstream.once('error', reject); upstream.end(body);
    });
  }
  async close() {
    if (!this.#server) return;
    const server = this.#server; this.#server = undefined; server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    assert.deepEqual(this.#errors, []);
  }
}
