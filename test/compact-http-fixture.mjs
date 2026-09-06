import { request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CompactMcpHttpServer } from '../server/compact/http-server.mjs';

export class CompactHttpFixture {
  static tools = [{ name: 'observe', description: 'Synthetic observation', inputSchema: { type: 'object' } }];
  static result = { content: [{ type: 'text', text: 'synthetic' }] };
  static init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'fixture', version: '1' },
  } };
  static call(id) { return { jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'observe', arguments: {} } }; }
  static deferred() {
    let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve };
  }
  static async until(predicate) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (predicate()) return;
      await delay(10);
    }
    throw new Error('Synthetic condition did not become ready');
  }

  static async create(t, options = {}) {
    const fixture = new CompactHttpFixture();
    const state = { created: 0, closed: 0, calls: [], errors: [] };
    const server = new CompactMcpHttpServer({ host: '127.0.0.1', port: 0, allowedHosts: ['localhost'],
      onError: error => state.errors.push(error.message),
      createSession: () => {
        state.created += 1;
        return { listTools: () => this.tools, callTool: async (...args) => { state.calls.push(args); return this.result; },
          close: async () => { state.closed += 1; } };
      }, ...options,
    });
    const { port } = await server.start();
    server.allowedHosts.add(`127.0.0.1:${port}`); // Exact ephemeral authority, never a wildcard.
    Object.assign(fixture, { t, state, server, port });
    t.after(() => server.close());
    return fixture;
  }

  raw(body = CompactHttpFixture.init, headers = {}, method = 'POST', path = '/mcp') {
    return new Promise((resolve, reject) => {
      const req = this.request(headers, method, path, resolve);
      req.on('error', reject); req.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body));
    });
  }

  request(headers, method, path, resolve) {
    const requestHeaders = {
      Host: 'localhost', Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', ...headers,
    };
    const pairs = Object.entries(requestHeaders).flatMap(([name, value]) => [value].flat().flatMap(item => [name, item]));
    return httpRequest({ host: '127.0.0.1', port: this.port, path, method, headers: pairs }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
  }

  async connect() {
    const client = new Client({ name: 'fixture', version: '1' });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${this.port}/mcp`));
    this.t.after(() => client.close());
    await client.connect(transport);
    return { client, transport };
  }
}
