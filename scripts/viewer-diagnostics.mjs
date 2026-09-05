// Bounded diagnostics for synthetic, disposable viewer tests only. No headers,
// response bodies, connection tickets, certificate hashes or full session objects.
export class ViewerDiagnostics {
  constructor() { this.events = []; }
  static redact(value) {
    return String(value).slice(0, 16384)
      .replace(/https?:\/\/[^\s"'<>]+/g, text => {
        try { const url = new URL(text); return url.origin + url.pathname + (url.search || url.hash ? '?[redacted]' : ''); }
        catch { return '[url redacted]'; }
      })
      .replace(/((?:token|ticket|authorization|cookie|password|secret)["']?\s*[:=]\s*["']?)[^\s,;"'}]+/gi, '$1[redacted]')
      .replace(/[A-Za-z0-9_+\/-]{32,}(?:={0,2})/g, '[long value redacted]');
  }
  static clean(value, depth = 0) {
    if (typeof value === 'string') return ViewerDiagnostics.redact(value);
    if (value === null || typeof value !== 'object') return value;
    if (depth >= 6) return '[depth limited]';
    if (Array.isArray(value)) return value.slice(0, 60).map(item => ViewerDiagnostics.clean(item, depth + 1));
    return Object.fromEntries(Object.entries(value).slice(0, 32)
      .map(([key, item]) => [key, /token|ticket|authorization|cookie|password|secret/i.test(key)
        ? '[redacted]' : ViewerDiagnostics.clean(item, depth + 1)]));
  }
  record(event) {
    if (this.events.length >= 60) return;
    this.events.push(ViewerDiagnostics.clean(event));
  }
  async observe(page, label) {
    page.on('console', message => {
      if (['error', 'warning'].includes(message.type())) this.record({ viewer: label, type: message.type(), message: message.text().slice(0, 1024) });
    });
    page.on('requestfailed', request => this.record({ viewer: label, type: 'requestfailed',
      url: request.url(), error: request.failure()?.errorText }));
    page.on('response', response => {
      if (response.status() >= 400 || /\/(bootstrap|cert-hash)(?:[?#]|$)/.test(response.url())) {
        this.record({ viewer: label, type: 'http', url: response.url(), status: response.status() });
      }
    });
    await page.addInitScript(() => {
      const events = []; window.__bpaneViewerConnectionDiagnostics = events;
      const record = (type, error) => {
        if (events.length < 20) events.push({ type, name: error?.name, message: String(error?.message ?? '').slice(0, 512) });
      };
      const Native = window.WebTransport;
      if (!Native) { record('unavailable'); return; }
      window.WebTransport = new Proxy(Native, { construct(Target, args, newTarget) {
        try {
          const transport = Reflect.construct(Target, args, newTarget);
          record('constructed');
          void transport.ready.then(() => record('ready'), error => record('ready-rejected', error));
          void transport.closed.then(() => record('closed'), error => record('closed-rejected', error));
          return transport;
        } catch (error) { record('constructor-threw', error); throw error; }
      } });
    });
  }
  async snapshot(page) {
    const timeout = new Promise(resolve => { const timer = setTimeout(() => resolve({ unavailable: 'diagnostic timeout' }), 3000); timer.unref(); });
    const state = await Promise.race([page.evaluate(() => {
      const session = window.browserpaneSession, canvas = document.querySelector('#screen canvas');
      const stats = session?.getSessionStats(), cache = session?.getTileCacheStats();
      const renderer = session?.getRenderDiagnostics?.();
      const render = renderer ? { backend: renderer.backend, reason: renderer.reason,
        software: renderer.software, renderer: renderer.renderer, vendor: renderer.vendor } : null;
      // A completed session already chose its context type. Check only that
      // advertised type, never probe an uninitialized canvas into another mode.
      const context = canvas && render ? canvas.getContext(render.backend === 'webgl2' ? 'webgl2' : '2d') : null;
      return { status: document.querySelector('#status')?.textContent, secureContext: isSecureContext,
        hasWebTransport: typeof WebTransport === 'function', visibility: document.visibilityState,
        hasSession: !!session, canvas: canvas ? { width: canvas.width, height: canvas.height } : null,
        counts: { rxBytes: stats?.transfer?.rxBytes, rxFrames: stats?.transfer?.rxFrames, txBytes: stats?.transfer?.txBytes,
          qoi: cache?.qoiDecodes, zstd: cache?.zstdDecodes, fills: cache?.fills, hits: cache?.hits },
        render, hasAdvertisedContext: !!context,
        transport: window.__bpaneViewerConnectionDiagnostics ?? [] };
    }).catch(error => ({ unavailable: error.message })), timeout]);
    return { events: this.events, state: ViewerDiagnostics.clean(state) };
  }
}
