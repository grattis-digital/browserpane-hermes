import test from 'node:test';
import assert from 'node:assert/strict';
import { GatewayAdmin, trustedBootstrap } from '../server/gateway-admin.mjs';

test('ticket bootstrap rejects absent, foreign and cross-site origins', () => {
  const origin = 'https://viewer.test';
  assert(trustedBootstrap({ origin, 'sec-fetch-site': 'same-origin' }, origin));
  assert(!trustedBootstrap({}, origin));
  assert(!trustedBootstrap({ origin: 'https://foreign.test' }, origin));
  assert(!trustedBootstrap({ origin, 'sec-fetch-site': 'cross-site' }, origin));
});

function fixture(existing = false) {
  let token = 'private-admin-token';
  let creates = 0;
  let tickets = 0;
  let fail = false;
  const sessions = existing ? [{ id: 'one', state: 'ready', labels: { application: 'browserpane-hermes' } }] : [];
  const admin = new GatewayAdmin({
    gatewayUrl: 'https://viewer.test:4433/', certHashUrl: '/browser/cert-hash',
    readToken: async () => token,
    fetchFn: async (url, options) => {
      assert.equal(options.headers.Authorization, `Bearer ${token}`);
      if (fail) { fail = false; return { ok: false, status: 503 }; }
      let body;
      if (url.endsWith('/access-tokens')) {
        body = { token_type: 'session_connect_ticket', token: `ticket-${++tickets}` };
      } else if (options.method === 'GET') body = { sessions };
      else {
        assert.equal(JSON.parse(options.body).idle_timeout_sec, 3153600000);
        creates++;
        body = { id: 'one', state: 'ready', labels: { application: 'browserpane-hermes' } };
        sessions.push(body);
      }
      return { ok: true, json: async () => body };
    },
  });
  return { admin, counts: () => ({ creates, tickets }), fail: () => { fail = true; },
    rotate: () => { token = 'replacement-private-token'; sessions.length = 0; } };
}

test('concurrent viewers share one session, receive separate scoped tickets and no admin token', async () => {
  const f = fixture();
  const results = await Promise.all(Array.from({ length: 8 }, () => f.admin.bootstrap()));
  assert.deepEqual(f.counts(), { creates: 1, tickets: 8 });
  assert.equal(new Set(results.map((item) => item.connectTicket)).size, 8);
  assert(!JSON.stringify(results).includes('private'));
  assert.deepEqual(Object.keys(results[0]).sort(), ['certHashUrl', 'connectTicket', 'gatewayUrl']);
});

test('adopts existing static session after HTTP service restart', async () => {
  const f = fixture(true);
  await f.admin.bootstrap();
  assert.deepEqual(f.counts(), { creates: 0, tickets: 1 });
});

test('recreates only gateway session metadata after certificate/token rotation', async () => {
  const f = fixture();
  await f.admin.bootstrap();
  f.rotate();
  await f.admin.bootstrap();
  assert.deepEqual(f.counts(), { creates: 2, tickets: 2 });
});

test('failed gateway request does not poison subsequent reconnects or leak response bodies', async () => {
  const f = fixture();
  f.fail();
  await assert.rejects(f.admin.bootstrap(), /^Error: Gateway request failed \(503\)$/);
  await f.admin.bootstrap();
  assert.deepEqual(f.counts(), { creates: 1, tickets: 1 });
});
