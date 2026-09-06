/** Bounded HTTP admission and body reading, before the SDK sees any payload. */
export class CompactHttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export class CompactHttpRequest {
  constructor(req, res, timeoutMs) {
    this.req = req;
    this.res = res;
    this.controller = new AbortController();
    this.disconnected = () => {
      if (!res.writableFinished) this.controller.abort(new CompactHttpError(499, 'Client disconnected'));
    };
    res.once('close', this.disconnected);
    this.timer = setTimeout(() => this.controller.abort(new CompactHttpError(504, 'Request deadline exceeded')), timeoutMs);
    this.timer.unref();
  }

  static validate(req, allowedHosts) {
    const hosts = req.rawHeaders.filter((_, index) => index % 2 === 0 && req.rawHeaders[index].toLowerCase() === 'host');
    if (hosts.length !== 1 || !allowedHosts.has(req.headers.host)) throw new CompactHttpError(403, 'Host is not allowed');
    if ('origin' in req.headers) throw new CompactHttpError(403, 'Browser origins are not allowed');
    if (req.url !== '/mcp') throw new CompactHttpError(404, 'Not found');
    if (!['POST', 'DELETE'].includes(req.method)) throw new CompactHttpError(405, 'Method not allowed');
    if (req.headers['content-encoding']) throw new CompactHttpError(415, 'Content encoding is not supported');
  }

  static fail(res, error) {
    if (res.destroyed || res.writableEnded) return;
    if (res.headersSent) { res.destroy(); return; }
    const status = error instanceof CompactHttpError ? error.status : 500;
    if (status === 499) { res.destroy(); return; }
    res.writeHead(status, {
      'Content-Type': 'application/json', 'Cache-Control': 'no-store', Connection: 'close',
      ...(status === 405 ? { Allow: 'POST, DELETE' } : {}),
      ...(status === 429 ? { 'Retry-After': '1' } : {}),
    });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: {
      code: -32000, message: error instanceof CompactHttpError ? error.message : 'Internal server error',
    } }));
  }

  async wait(promise) {
    const signal = this.controller.signal;
    if (signal.aborted) { promise.catch(() => {}); throw signal.reason; }
    let abort;
    const cancelled = new Promise((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
    });
    try { return await Promise.race([promise, cancelled]); }
    finally { signal.removeEventListener('abort', abort); }
  }

  async readBody(timeoutMs, maxBytes = 64 * 1024) {
    if (Number(this.req.headers['content-length']) > maxBytes) throw new CompactHttpError(413, 'Request body is too large');
    const chunks = [];
    let size = 0;
    const body = await new Promise((resolve, reject) => {
      const finish = (error, value) => {
        clearTimeout(timer);
        this.req.off('data', data).off('end', end).off('error', failure).off('aborted', aborted);
        this.controller.signal.removeEventListener('abort', cancelled);
        if (error) { this.req.pause(); reject(error); } else resolve(value);
      };
      const data = chunk => {
        size += chunk.length;
        if (size > maxBytes) return finish(new CompactHttpError(413, 'Request body is too large'));
        chunks.push(chunk);
      };
      const end = () => finish(undefined, Buffer.concat(chunks, size));
      const failure = () => finish(new CompactHttpError(400, 'Request body failed'));
      const aborted = () => finish(new CompactHttpError(499, 'Client disconnected'));
      const cancelled = () => finish(this.controller.signal.reason);
      const timer = setTimeout(() => finish(new CompactHttpError(408, 'Request body deadline exceeded')), timeoutMs);
      timer.unref();
      this.req.on('data', data).once('end', end).once('error', failure).once('aborted', aborted);
      this.controller.signal.addEventListener('abort', cancelled, { once: true });
      if (this.controller.signal.aborted) cancelled();
    });
    if (this.req.method === 'DELETE') {
      if (body.length) throw new CompactHttpError(400, 'DELETE must not contain a body');
      return undefined;
    }
    try {
      const parsed = JSON.parse(body.toString('utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Not one message');
      return parsed;
    } catch { throw new CompactHttpError(400, 'Expected one JSON-RPC message'); }
  }

  dispose() {
    clearTimeout(this.timer);
    this.res.off('close', this.disconnected);
  }
}
