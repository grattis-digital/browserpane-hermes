import runtimeAssert from 'node:assert/strict';
import RuntimeWebSocket from 'ws';

/** Concatenated into disposable-runtime helpers; never initializes a Playwright context. */
export class RuntimeCdp {
  sequence = 0;
  pending = new Map();
  static methods = new Set(['Runtime.evaluate', 'SystemInfo.getProcessInfo', 'Target.createTarget',
    'Target.activateTarget', 'Network.getCookies', 'Network.setCookie']);

  static async json(path) {
    runtimeAssert(['/json/list', '/json/version'].includes(path));
    const response = await fetch(`http://127.0.0.1:9222${path}`, { signal: AbortSignal.timeout(3000) });
    runtimeAssert(response.ok);
    const text = await response.text(); runtimeAssert(text.length < 1024 * 1024, 'Oversized fixture CDP metadata');
    return JSON.parse(text);
  }
  static async browser() { return this.connect((await this.json('/json/version')).webSocketDebuggerUrl); }
  static async pages() { return (await this.json('/json/list')).filter(page => page.type === 'page'); }
  static async pageByUrl(url) {
    const matches = (await this.pages()).filter(page => page.url === url);
    runtimeAssert.equal(matches.length, 1, 'Exactly one already-existing owned fixture page is required');
    return { page: await this.connect(matches[0].webSocketDebuggerUrl), id: matches[0].id };
  }
  static async connect(value) {
    const endpoint = new URL(value);
    runtimeAssert.equal(endpoint.protocol, 'ws:'); runtimeAssert.equal(endpoint.hostname, '127.0.0.1');
    runtimeAssert.equal(endpoint.port, '9222'); runtimeAssert.equal(endpoint.username + endpoint.password, '');
    runtimeAssert.match(endpoint.pathname, /^\/devtools\/(page|browser)\/[a-zA-Z0-9-]+$/);
    const client = new RuntimeCdp(new RuntimeWebSocket(endpoint, { maxPayload: 1024 * 1024 }));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { client.close(); reject(new Error('Fixture CDP connection timed out')); }, 3000);
      client.socket.once('open', () => { clearTimeout(timer); resolve(); });
      client.socket.once('error', error => { clearTimeout(timer); reject(error); });
    });
    return client;
  }
  static async until(check, message) {
    const deadline = Date.now() + 15000;
    do {
      try { if (await check()) return; } catch { /* A lazily restored document may still be creating its context. */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    throw new Error(message);
  }
  constructor(socket) {
    this.socket = socket;
    socket.on('message', data => {
      try {
        const message = JSON.parse(data.toString()), pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id); clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error('Fixture CDP command failed'));
        else pending.resolve(message.result);
      } catch { this.close(); }
    });
    const failed = () => {
      for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error('Fixture CDP disconnected')); }
      this.pending.clear();
    };
    socket.on('error', failed).on('close', failed);
  }
  async send(method, params = {}) {
    runtimeAssert(RuntimeCdp.methods.has(method), 'Unapproved fixture CDP method');
    runtimeAssert(this.pending.size < 8, 'Fixture CDP concurrency limit');
    runtimeAssert.equal(this.socket.readyState, RuntimeWebSocket.OPEN);
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const finish = error => { clearTimeout(timer); this.pending.delete(id); reject(error); };
      const timer = setTimeout(() => finish(new Error('Fixture CDP command timed out')), 3000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.socket.send(JSON.stringify({ id, method, params }), error => { if (error) finish(error); }); }
      catch (error) { finish(error); }
    });
  }
  async evaluate(read, value) {
    const response = await this.send('Runtime.evaluate', {
      expression: `(${read})(${JSON.stringify(value)})`, returnByValue: true, awaitPromise: true,
    });
    runtimeAssert(!response.exceptionDetails, 'Synthetic state query failed');
    return response.result.value;
  }
  close() { this.socket.terminate(); }
}
