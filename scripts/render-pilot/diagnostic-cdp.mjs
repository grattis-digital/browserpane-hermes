import assert from 'node:assert/strict';

// Only the ephemeral browser inside an ownership-checked pilot container.
export class DiagnosticCdp {
  #socket;
  #pending = new Map();
  #sequence = 0;
  #events = new Map();
  #failure;

  static async connect() {
    assert.equal(process.env.BPANE_PIPELINE_TEST, '1');
    const endpoint = await fetch('http://127.0.0.1:9222/json/version',
      { signal: AbortSignal.timeout(3000) }).then(response => response.json());
    const url = new URL(endpoint.webSocketDebuggerUrl);
    assert.equal(url.protocol, 'ws:'); assert.equal(url.hostname, '127.0.0.1');
    assert.equal(url.port, '9222'); assert(url.pathname.startsWith('/devtools/browser/'));
    const socket = new WebSocket(url);
    const client = new DiagnosticCdp(socket);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Diagnostic CDP connect deadline')), 3000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Diagnostic CDP connect error')); }, { once: true });
    }).catch(error => { client.close(); throw error; });
    return client;
  }

  constructor(socket) {
    this.#socket = socket;
    socket.addEventListener('message', event => {
      if (this.#failure) return;
      try {
        assert(typeof event.data === 'string' && event.data.length <= 2 * 1024 * 1024, 'CDP message bound');
        const message = JSON.parse(event.data);
        if (message.method) this.#events.get(message.method)?.(message.params);
        const waiter = this.#pending.get(message.id);
        if (!waiter) return;
        this.#pending.delete(message.id); clearTimeout(waiter.timer);
        if (message.error) waiter.reject(new Error('Diagnostic CDP rejected operation'));
        else waiter.resolve(message.result);
      } catch (error) { this.close(error); }
    });
    socket.addEventListener('close', () => this.close());
    socket.addEventListener('error', () => this.close(new Error('Diagnostic CDP socket error')));
  }

  on(method, listener) { this.#events.set(method, listener); }

  call(method, params = {}, sessionId) {
    if (this.#failure) return Promise.reject(this.#failure);
    assert(this.#pending.size < 8, 'Diagnostic CDP request bound');
    return new Promise((resolve, reject) => {
      const id = ++this.#sequence;
      const timer = setTimeout(() => { this.#pending.delete(id); reject(new Error('Diagnostic CDP deadline: ' + method)); }, 8000);
      this.#pending.set(id, { resolve, reject, timer });
      try { this.#socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
      catch (error) { this.close(error); }
    });
  }

  close(error = new Error('Diagnostic CDP closed')) {
    if (this.#failure) return;
    this.#failure = error;
    for (const waiter of this.#pending.values()) {
      clearTimeout(waiter.timer); waiter.reject(error);
    }
    this.#pending.clear(); this.#events.clear();
    this.#socket.close(); // Never Browser.close or attach to a saved profile.
  }
}
