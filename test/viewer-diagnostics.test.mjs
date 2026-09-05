import test from 'node:test';
import assert from 'node:assert/strict';
import { ViewerDiagnostics } from '../scripts/viewer-diagnostics.mjs';
import { runInNewContext } from 'node:vm';

test('viewer diagnostics omit credentials, query values, fragments and ticket/token fields', () => {
  const output = ViewerDiagnostics.redact('https://operator:password@localhost:24433/connect?session_ticket=private#secret '
    + 'token=private authorization: BearerPrivate cookie="private" ' + 'a'.repeat(64));
  for (const secret of ['operator', 'password@', 'private', '#secret', 'BearerPrivate', 'a'.repeat(64)]) assert(!output.includes(secret), secret);
  assert(output.includes('https://localhost:24433/connect'));
});
test('viewer diagnostics have bounded event count and remain structured with long or malformed URLs', () => {
  const diagnostics = new ViewerDiagnostics();
  for (let index = 0; index < 100; index++) diagnostics.record({ message: 'https://invalid[' + '\n"'.repeat(10000) });
  assert.equal(diagnostics.events.length, 60);
  assert(diagnostics.events.every(event => event.message.length <= 16384));
  assert.doesNotThrow(() => JSON.stringify(diagnostics.events));
});
test('diagnostics preserve errors and numeric connection counters without including raw long values', () => {
  const value = ViewerDiagnostics.clean({ counts: { qoi: 0, zstd: 2 }, status: 'Connecting…',
    events: [{ name: 'WebTransportError', message: 'Opening handshake failed: ERR_QUIC_PROTOCOL_ERROR', ticket: 'short-secret' }] });
  assert.deepEqual(value.counts, { qoi: 0, zstd: 2 });
  assert.equal(value.events[0].name, 'WebTransportError');
  assert(value.events[0].message.includes('ERR_QUIC_PROTOCOL_ERROR'));
  assert.equal(value.events[0].ticket, '[redacted]');
});
test('snapshot reads the session transfer and tile-cache public counter shapes', async () => {
  const context = {
    window: { browserpaneSession: {
      getSessionStats: () => ({ transfer: { rxBytes: 1200, rxFrames: 18, txBytes: 43 }, rxBytes: -1 }),
      getTileCacheStats: () => ({ qoiDecodes: 2, zstdDecodes: 7, fills: 11, hits: 13, solidFills: -1 }),
    }, __bpaneViewerConnectionDiagnostics: [{ type: 'ready' }] },
    document: { visibilityState: 'visible', querySelector: selector => selector === '#status'
      ? { textContent: 'Connected' } : { width: 1280, height: 720 } },
    isSecureContext: true, WebTransport: function WebTransport() {},
  };
  const snapshot = await new ViewerDiagnostics().snapshot({
    async evaluate(callback) { return runInNewContext(`(${callback.toString()})()`, context); },
  });
  assert.deepEqual(snapshot.state.counts, { rxBytes: 1200, rxFrames: 18, txBytes: 43,
    qoi: 2, zstd: 7, fills: 11, hits: 13 });
  assert.deepEqual(snapshot.state.canvas, { width: 1280, height: 720 });
  assert.equal(snapshot.state.hasSession, true);
});
test('connection observer preserves constructor identity, arguments and ready/closed behavior', async () => {
  let install;
  const diagnostics = new ViewerDiagnostics();
  await diagnostics.observe({ on() {}, async addInitScript(callback) { install = callback; } }, 'test');
  class NativeTransport {
    constructor(...args) { this.args = args; this.ready = Promise.resolve(); this.closed = Promise.reject(new Error('Opening handshake failed')); }
  }
  const context = { window: { WebTransport: NativeTransport } };
  runInNewContext(`(${install.toString()})()`, context);
  const options = { serverCertificateHashes: [] };
  const transport = new context.window.WebTransport('https://localhost/?ticket=not-recorded', options);
  assert(transport instanceof NativeTransport);
  assert.equal(transport.args[1], options);
  await transport.ready;
  await assert.rejects(transport.closed, /Opening handshake failed/);
  const events = context.window.__bpaneViewerConnectionDiagnostics;
  assert.deepEqual(Array.from(events, event => event.type), ['constructed', 'ready', 'closed-rejected']);
  assert(!JSON.stringify(events).includes('not-recorded'));
});
