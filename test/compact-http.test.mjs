import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { CompactMcpHttpServer } from '../server/compact/http-server.mjs';
import { CompactHttpFixture } from './compact-http-fixture.mjs';

const { tools, result, init, call, deferred, until } = CompactHttpFixture;
const fixture = (t, options) => CompactHttpFixture.create(t, options);

test('real SDK initializes, discovers, calls and deletes only session-owned state', async t => {
  const f = await fixture(t), { client, transport } = await f.connect();
  assert.match(transport.sessionId, /^[\da-f-]{36}$/);
  assert.deepEqual((await client.listTools()).tools, tools);
  assert.deepEqual(await client.callTool({ name: 'observe' }), result);
  const id = transport.sessionId; await transport.terminateSession(); await delay(10);
  assert.equal(f.state.closed, 1); assert.equal(f.state.calls.length, 1);
  assert.equal((await f.raw(call(2), { 'mcp-session-id': id })).status, 404);
});

test('rejects foreign, empty, duplicate Hosts and every Origin without creating a session', async t => {
  const f = await fixture(t);
  for (const headers of [{ Host: 'evil.example' }, { Host: '' }, { Host: ['localhost', 'localhost'] }, { Origin: 'null' }, { Origin: '' }]) {
    assert.equal((await f.raw(init, headers)).status, 403);
  }
  assert.equal(f.state.created, 0);
});

test('path, methods, health GET and unsupported encodings are explicit and have no CORS', async t => {
  const f = await fixture(t);
  for (const method of ['GET', 'PUT', 'OPTIONS', 'PATCH']) {
    const response = await f.raw(undefined, {}, method);
    assert.equal(response.status, 405); assert.equal(response.headers.allow, 'POST, DELETE');
    assert.equal(response.headers['access-control-allow-origin'], undefined);
  }
  assert.equal((await f.raw(init, {}, 'POST', '/mcp?tools=legacy')).status, 404);
  assert.equal((await f.raw(init, { 'Content-Encoding': 'gzip' })).status, 415);
});

test('malformed JSON, arrays, non-initialize and unknown sessions cannot allocate state', async t => {
  const f = await fixture(t);
  for (const body of ['{', [init], null, call(2), { ...init, jsonrpc: '1.0' }]) assert.equal((await f.raw(body)).status, 400);
  assert.equal((await f.raw(init, { 'mcp-session-id': 'missing' })).status, 404);
  assert.equal((await f.raw(undefined, {}, 'DELETE')).status, 400);
  assert.equal(f.state.created, 0);
});

test('both declared and chunked bodies are limited to 64 KiB', async t => {
  const f = await fixture(t), body = 'x'.repeat(65537);
  assert.equal((await f.raw(body, { 'Content-Length': String(body.length) })).status, 413);
  assert.equal((await f.raw(body, { 'Transfer-Encoding': 'chunked' })).status, 413);
  assert.equal(f.state.created, 0);
  const prefix = JSON.stringify({ ...init, params: { ...init.params, padding: '' } });
  assert.equal((await f.raw(prefix.replace('"padding":""', `"padding":"${'x'.repeat(65536 - prefix.length)}"`))).status, 200);
});

test('SDK content negotiation and protocol version validation are preserved', async t => {
  const f = await fixture(t);
  assert.equal((await f.raw(init, { Accept: 'application/json' })).status, 406);
  assert.equal((await f.raw(init, { 'Content-Type': 'text/plain' })).status, 415);
  const response = await f.raw(), headers = { 'mcp-session-id': response.headers['mcp-session-id'] };
  assert.equal((await f.raw(call(2), { ...headers, 'mcp-protocol-version': 'invalid' })).status, 400);
  assert.equal((await f.raw(init, headers)).status, 400);
});

test('session creation races reserve capacity before awaiting the factory', async t => {
  const gate = deferred(); let created = 0, closed = 0;
  const f = await fixture(t, { maxSessions: 1, createSession: async () => {
    created += 1; await gate.promise; return { listTools: () => tools, callTool: async () => result, close: async () => { closed += 1; } };
  } });
  const first = f.raw(); await until(() => created === 1);
  assert.equal((await f.raw()).status, 503); assert.equal(created, 1);
  gate.resolve(); assert.equal((await first).status, 200); await f.server.close(); assert.equal(closed, 1);
});

test('factory failure cleans its reservation so a subsequent initialize succeeds', async t => {
  let attempts = 0;
  const f = await fixture(t, { maxSessions: 1, createSession: () => {
    if (++attempts === 1) throw new Error('private diagnostic must not leak');
    return { listTools: () => tools, callTool: async () => result, close: async () => {} };
  } });
  const failed = await f.raw(); assert.equal(failed.status, 500); assert(!failed.body.includes('private diagnostic'));
  await delay(10); assert.equal((await f.raw()).status, 200);
});

test('per-session request concurrency is limited while another session remains usable', async t => {
  const gate = deferred(); let running = 0;
  const f = await fixture(t, { createSession: () => ({ listTools: () => tools, close: async () => {},
    callTool: async () => { running += 1; await gate.promise; return result; } }) });
  const id = (await f.raw()).headers['mcp-session-id'], headers = { 'mcp-session-id': id };
  const first = f.raw(call(2), headers), second = f.raw(call(3), headers); await until(() => running === 2);
  assert.equal(running, 2); assert.equal((await f.raw(call(4), headers)).status, 429);
  assert.equal((await f.raw()).status, 200); gate.resolve();
  assert.equal((await first).status, 200); assert.equal((await second).status, 200);
});

test('idle expiry never expires an active backend action', async t => {
  const gate = deferred(); let closed = 0;
  const f = await fixture(t, { idleTimeoutMs: 30, createSession: () => ({ listTools: () => tools,
    close: async () => { closed += 1; }, callTool: async () => { await gate.promise; return result; } }) });
  const id = (await f.raw()).headers['mcp-session-id'], headers = { 'mcp-session-id': id };
  const pending = f.raw(call(2), headers); await delay(80); assert.equal(closed, 0);
  gate.resolve(); assert.equal((await pending).status, 200); await delay(100);
  assert.equal(closed, 1); assert.equal((await f.raw(call(3), headers)).status, 404);
});

test('deadline aborts the handler but retains capacity until uncancellable work settles', async t => {
  const gate = deferred(); let signal, closed = 0;
  const f = await fixture(t, { maxSessions: 1, requestTimeoutMs: 60, createSession: () => ({ listTools: () => tools,
    close: async () => { closed += 1; }, callTool: async (_name, _args, options) => { signal = options.signal; await gate.promise; return result; } }) });
  const id = (await f.raw()).headers['mcp-session-id'];
  assert.equal((await f.raw(call(2), { 'mcp-session-id': id })).status, 504);
  assert(signal.aborted); assert.equal(closed, 0); assert.equal((await f.raw()).status, 503);
  gate.resolve(); await delay(20); assert.equal(closed, 1); assert.equal((await f.raw()).status, 200);
});

test('shutdown is bounded and disposes a late factory exactly once', async t => {
  const gate = deferred(); let closed = 0;
  const f = await fixture(t, { closeTimeoutMs: 20, createSession: async () => {
    await gate.promise; return { listTools: () => tools, callTool: async () => result, close: async () => { closed += 1; } };
  } });
  const pending = f.raw().catch(() => undefined); await delay(10);
  await f.server.close(); await pending; assert.equal(closed, 0);
  gate.resolve(); await delay(20); await f.server.close(); assert.equal(closed, 1);
});

test('duplicate in-flight IDs cannot overwrite the original request or execute twice', async t => {
  const gate = deferred(); let calls = 0;
  const f = await fixture(t, { createSession: () => ({ listTools: () => tools, close: async () => {},
    callTool: async () => { calls += 1; await gate.promise; return result; } }) });
  const headers = { 'mcp-session-id': (await f.raw()).headers['mcp-session-id'] };
  const first = f.raw(call(2), headers); await until(() => calls === 1);
  assert.equal((await f.raw(call(2), headers)).status, 409); assert.equal(calls, 1);
  gate.resolve(); assert.equal((await first).status, 200); assert.equal((await f.raw(call(3), headers)).status, 200);
});

test('real socket disconnect aborts the signal without freeing unresolved browser work', async t => {
  const gate = deferred(); let signal;
  const f = await fixture(t, { maxSessions: 1, createSession: () => ({ listTools: () => tools, close: async () => {},
    callTool: async (_name, _args, options) => { signal = options.signal; await gate.promise; return result; } }) });
  const headers = { 'mcp-session-id': (await f.raw()).headers['mcp-session-id'] };
  const req = f.request(headers, 'POST', '/mcp', () => {}); req.on('error', () => {}); req.end(JSON.stringify(call(2)));
  await until(() => signal); req.destroy(); await until(() => signal.aborted);
  assert.equal((await f.raw()).status, 503); gate.resolve(); await until(() => !f.server.reservations.size);
  assert.equal((await f.raw()).status, 200);
});

test('DELETE and an SDK close error retain active work without a retryable missing-session response', async t => {
  const gate = deferred(); let signal, closed = 0;
  const f = await fixture(t, { createSession: () => ({ listTools: () => tools, close: async () => { closed += 1; },
    callTool: async (_name, _args, options) => { signal = options.signal; await gate.promise; return result; } }) });
  const headers = { 'mcp-session-id': (await f.raw()).headers['mcp-session-id'] };
  const protocol = f.server.sessions.get(headers['mcp-session-id']).server;
  const close = protocol.close.bind(protocol);
  protocol.close = async () => { await close(); throw new Error('Synthetic SDK cleanup failure'); };
  const pending = f.raw(call(2), headers); await until(() => signal);
  assert.equal((await f.raw('', headers, 'DELETE')).status, 200); assert.equal((await pending).status, 503);
  assert(signal.aborted); assert.equal(closed, 0); assert.equal(f.server.reservations.size, 1);
  gate.resolve(); await until(() => closed === 1);
});

test('SDK cancellation reaches tools and its otherwise unanswered JSON request has a finite deadline', async t => {
  const gate = deferred(); let signal;
  const f = await fixture(t, { requestTimeoutMs: 100, createSession: () => ({ listTools: () => tools, close: async () => {},
    callTool: async (_name, _args, options) => { signal = options.signal; await gate.promise; return result; } }) });
  const headers = { 'mcp-session-id': (await f.raw()).headers['mcp-session-id'] };
  const pending = f.raw(call(2), headers); await until(() => signal);
  const cancellation = { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2 } };
  assert.equal((await f.raw(cancellation, headers)).status, 202); await until(() => signal.aborted);
  gate.resolve(); assert.equal((await pending).status, 504);
});

test('a partial slow body is timed out before session creation', async t => {
  const f = await fixture(t, { bodyTimeoutMs: 40 });
  const response = await new Promise(resolve => {
    const req = f.request({}, 'POST', '/mcp', resolve); t.after(() => req.destroy()); req.on('error', () => {}); req.write('{');
  });
  assert.equal(response.status, 408); assert.equal(f.state.created, 0);
});

test('startup shutdown race cannot leave a listening socket', async () => {
  const server = new CompactMcpHttpServer({ host: '127.0.0.1', port: 0, createSession: () => {} });
  const starting = server.start(); const rejected = assert.rejects(starting, /closed during startup/);
  await server.close(); await rejected; assert.equal(server.http.listening, false);
});

test('the default limit is eight live sessions and successful deletion releases one slot', async t => {
  const f = await fixture(t), ids = [];
  for (let index = 0; index < 8; index += 1) ids.push((await f.raw()).headers['mcp-session-id']);
  assert.equal(new Set(ids).size, 8); assert.equal((await f.raw()).status, 503);
  assert.equal((await f.raw('', { 'mcp-session-id': ids[0] }, 'DELETE')).status, 200);
  await until(() => f.state.closed === 1); assert.equal((await f.raw()).status, 200);
});
