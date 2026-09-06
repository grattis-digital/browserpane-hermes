import { createServer } from 'node:http';
import { InitializeRequestSchema, JSONRPCRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { CompactHttpError, CompactHttpRequest } from './http-request.mjs';
import { CompactHttpSession } from './http-session.mjs';

/** Private Compose-only MCP listener; no browser origins or unauthenticated web UI. */
export class CompactMcpHttpServer {
  constructor({ createSession, host = '0.0.0.0', port = 8931,
    allowedHosts = ['browserpane:8931', 'localhost:8931', '127.0.0.1:8931'], maxSessions = 8,
    idleTimeoutMs = 30 * 60_000, requestTimeoutMs = 90_000, bodyTimeoutMs = 10_000,
    closeTimeoutMs = 5_000, onError = error => console.error(error.message),
  }) {
    if (typeof createSession !== 'function') throw new TypeError('createSession is required');
    if (!Number.isInteger(maxSessions) || maxSessions < 1 || maxSessions > 8) throw new RangeError('maxSessions must be 1..8');
    for (const value of [idleTimeoutMs, requestTimeoutMs, bodyTimeoutMs, closeTimeoutMs]) {
      if (!Number.isInteger(value) || value < 1 || value > 30 * 60_000) throw new RangeError('Timeout must be 1..1800000 ms');
    }
    this.options = { createSession, host, port, maxSessions, idleTimeoutMs, requestTimeoutMs, bodyTimeoutMs, closeTimeoutMs };
    this.allowedHosts = new Set(allowedHosts);
    this.onError = error => { try { onError(error); } catch { /* Logging cannot break cleanup. */ } };
    this.sessions = new Map();
    this.reservations = new Set();
    this.requests = new Set();
    this.listenController = new AbortController();
    this.closed = false;
    this.http = createServer((req, res) => { this.handle(req, res).catch(() => this.onError(new Error('Compact MCP request failed'))); });
    this.http.maxConnections = 32;
    this.http.maxRequestsPerSocket = 100;
    this.http.headersTimeout = bodyTimeoutMs;
    this.http.requestTimeout = requestTimeoutMs;
    this.http.keepAliveTimeout = 5_000;
    this.http.on('connection', socket => socket.setNoDelay(true));
    this.http.on('error', () => this.onError(new Error('Compact MCP listener failed')));
  }

  async start() {
    if (this.closed || this.started) throw new Error('Compact MCP server already started or closed');
    this.started = true;
    await new Promise((resolve, reject) => {
      const failed = error => { this.cancelStart = undefined; this.http.off('listening', ready).off('error', failed); reject(error); };
      const ready = () => { this.cancelStart = undefined; this.http.off('error', failed); resolve(); };
      this.cancelStart = () => failed(new Error('Compact MCP server closed during startup'));
      this.http.once('error', failed).once('listening', ready);
      this.http.listen({ port: this.options.port, host: this.options.host, signal: this.listenController.signal });
    });
    if (this.closed) {
      await new Promise(resolve => this.http.close(resolve));
      throw new Error('Compact MCP server closed during startup');
    }
    this.sweepTimer = setInterval(() => this.expireIdle(), Math.min(this.options.idleTimeoutMs, 30_000));
    this.sweepTimer.unref();
    return this.http.address();
  }

  expireIdle() {
    const cutoff = Date.now() - this.options.idleTimeoutMs;
    for (const session of this.reservations) {
      if (!session.activeRequests && !session.operations.size && session.lastUsed <= cutoff) session.close();
    }
  }

  create() {
    if (this.closed) throw new CompactHttpError(503, 'Server is closing');
    if (this.reservations.size >= this.options.maxSessions) throw new CompactHttpError(503, 'Session capacity reached');
    const session = new CompactHttpSession({
      createSession: this.options.createSession, onError: this.onError,
      onInitialized: (id, value) => { if (!this.closed && !value.closed) this.sessions.set(id, value); },
      onDisposed: value => {
        this.reservations.delete(value);
        for (const [id, current] of this.sessions) if (current === value) this.sessions.delete(id);
      },
    });
    this.reservations.add(session);
    return session;
  }

  async handle(req, res) {
    let request, session, sessionClosed, acquired = false, handling = false;
    try {
      CompactHttpRequest.validate(req, this.allowedHosts);
      if (this.closed) throw new CompactHttpError(503, 'Server is closing');
      if (this.requests.size >= 16) throw new CompactHttpError(429, 'Server request limit reached');
      request = new CompactHttpRequest(req, res, this.options.requestTimeoutMs);
      this.requests.add(request);
      const id = req.headers['mcp-session-id'];
      if (id !== undefined) {
        session = typeof id === 'string' ? this.sessions.get(id) : undefined;
        if (!session) throw new CompactHttpError(404, 'Session not found');
        session.acquire(); acquired = true;
      }
      const body = await request.readBody(this.options.bodyTimeoutMs);
      if (!session) {
        if (req.method !== 'POST' || !JSONRPCRequestSchema.safeParse(body).success || !InitializeRequestSchema.safeParse(body).success) {
          throw new CompactHttpError(400, 'Initialize a session first');
        }
        session = this.create();
        session.acquire(); acquired = true;
      }
      handling = true;
      if (req.method === 'POST') {
        sessionClosed = () => request.controller.abort(new CompactHttpError(503, 'Request interrupted; completion may be unknown'));
        session.controller.signal.addEventListener('abort', sessionClosed, { once: true });
      }
      await request.wait(session.handle(req, res, body, request.controller.signal));
      if (!session.transport.sessionId) session.close();
    } catch (error) {
      CompactHttpRequest.fail(res, error);
      if (handling && session && !(error instanceof CompactHttpError && error.status === 409)) session.close();
      if (!(error instanceof CompactHttpError)) this.onError(new Error('Compact MCP request failed'));
    } finally {
      if (acquired) session.release();
      if (sessionClosed) session.controller.signal.removeEventListener('abort', sessionClosed);
      if (request) { request.dispose(); this.requests.delete(request); }
    }
  }

  close() {
    if (this.cleanup) return this.cleanup;
    this.closed = true;
    this.cancelStart?.();
    this.listenController.abort();
    clearInterval(this.sweepTimer);
    for (const request of this.requests) request.controller.abort(new CompactHttpError(503, 'Server is closing'));
    const sessions = [...this.reservations].map(session => session.close());
    this.cleanup = (async () => {
      let timer;
      const deadline = new Promise(resolve => { timer = setTimeout(resolve, this.options.closeTimeoutMs); });
      const stopped = new Promise(resolve => this.http.close(resolve));
      this.http.closeAllConnections();
      try { await Promise.race([Promise.allSettled([stopped, ...sessions]), deadline]); }
      finally { clearTimeout(timer); }
    })();
    return this.cleanup;
  }
}
