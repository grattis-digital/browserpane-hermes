import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { CompactHttpError } from './http-request.mjs';

/** One client's protocol/ref state. Closing it never owns Chromium's lifetime. */
export class CompactHttpSession {
  constructor({ createSession, onInitialized, onDisposed, onError }) {
    this.activeRequests = 0;
    this.lastUsed = Date.now();
    this.closed = false;
    this.operations = new Set();
    this.requests = new Map();
    this.onDisposed = onDisposed;
    this.onError = onError;
    this.controller = new AbortController();
    this.server = new Server({ name: 'browserpane-compact', version: '1.0.0' }, { capabilities: { tools: {} } });
    this.transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID, enableJsonResponse: true,
      onsessioninitialized: id => onInitialized(id, this),
    });
    this.server.onclose = () => { this.close(); };
    this.server.onerror = () => onError(new Error('Compact MCP protocol error'));
    this.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: this.engine.listTools() }));
    this.server.setRequestHandler(CallToolRequestSchema, (request, extra) => this.call(request, extra));
    // Keep this reservation until even a late or failed factory has been disposed.
    this.ready = Promise.resolve().then(createSession).then(async engine => {
      this.engine = engine;
      if (!engine || typeof engine.listTools !== 'function' || typeof engine.callTool !== 'function' || typeof engine.close !== 'function') {
        throw new Error('Invalid compact session implementation');
      }
      if (!this.closed) await this.server.connect(this.transport);
    });
    this.ready.catch(() => {}); // Observed by handle/close; never a detached rejection.
  }

  acquire() {
    if (this.closed) throw new CompactHttpError(404, 'Session not found');
    if (this.activeRequests >= 2) throw new CompactHttpError(429, 'Session request limit reached');
    this.activeRequests += 1;
    this.lastUsed = Date.now();
  }

  release() { this.activeRequests -= 1; this.lastUsed = Date.now(); }

  async handle(req, res, body, signal) {
    await this.ready;
    signal.throwIfAborted();
    if (this.closed) throw new CompactHttpError(404, 'Session not found');
    const id = body?.id;
    if (id !== undefined && this.requests.has(id)) throw new CompactHttpError(409, 'Request ID is already active');
    if (id !== undefined) this.requests.set(id, signal);
    try { await this.transport.handleRequest(req, res, body); }
    finally { if (id !== undefined) this.requests.delete(id); }
  }

  async call(request, extra) {
    const signal = AbortSignal.any([
      this.controller.signal, extra.signal,
      ...(this.requests.has(extra.requestId) ? [this.requests.get(extra.requestId)] : []),
    ]);
    signal.throwIfAborted();
    const operation = Promise.resolve().then(() => {
      signal.throwIfAborted();
      return this.engine.callTool(request.params.name, request.params.arguments ?? {}, { signal });
    });
    this.operations.add(operation);
    try { return await operation; }
    finally { this.operations.delete(operation); this.lastUsed = Date.now(); }
  }

  close() {
    if (this.cleanup) return this.cleanup;
    this.closed = true;
    this.controller.abort(new Error('MCP session closed'));
    this.cleanup = Promise.resolve().then(async () => {
      try { await this.server.close(); }
      catch { this.onError(new Error('Compact MCP protocol cleanup failed')); }
      await this.ready.catch(() => {});
      // A Playwright action may be uncancellable. Do not free its capacity early.
      await Promise.allSettled([...this.operations]);
      if (typeof this.engine?.close === 'function') await this.engine.close();
    }).catch(() => this.onError(new Error('Compact MCP session cleanup failed')))
      .finally(() => this.onDisposed(this));
    return this.cleanup;
  }
}
