import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { RuntimeCdp } from '../scripts/runtime-test/cdp.mjs';

class FixtureSocket extends EventEmitter {
  readyState = 1;
  messages = [];
  send(text, callback) { this.messages.push(JSON.parse(text)); callback?.(); }
  terminate() { this.readyState = 3; this.emit('close'); }
  reply(id, result) { this.emit('message', Buffer.from(JSON.stringify({ id, result }))); }
}

test('raw fixture observer rejects direct download-setting, browser-close and navigation CDP methods', async () => {
  const socket = new FixtureSocket(), client = new RuntimeCdp(socket);
  for (const method of ['Browser.setDownloadBehavior', 'Browser.close', 'Page.navigate', 'Target.closeTarget']) {
    await assert.rejects(client.send(method), /Unapproved/);
  }
  assert.equal(socket.messages.length, 0); assert.equal(client.pending.size, 0); client.close();
});

test('raw fixture query preserves structured arguments and cleans the matching pending response', async () => {
  const socket = new FixtureSocket(), client = new RuntimeCdp(socket), value = 'synthetic "quoted" λ\n';
  const pending = client.evaluate(argument => argument, value);
  assert.equal(socket.messages[0].method, 'Runtime.evaluate');
  assert.equal(socket.messages[0].params.expression, `(argument => argument)(${JSON.stringify(value)})`);
  socket.reply(socket.messages[0].id, { result: { value } });
  assert.equal(await pending, value); assert.equal(client.pending.size, 0); client.close();
});

test('raw fixture query bounds outstanding work and rejects all pending work on socket close', async () => {
  const socket = new FixtureSocket(), client = new RuntimeCdp(socket);
  const pending = Array.from({ length: 8 }, () => client.send('SystemInfo.getProcessInfo'));
  await assert.rejects(client.send('SystemInfo.getProcessInfo'), /concurrency limit/);
  const results = Promise.allSettled(pending); client.close();
  assert((await results).every(result => result.status === 'rejected'));
  assert.equal(client.pending.size, 0); assert.equal(socket.messages.length, 8);
});

test('raw fixture observer rejects foreign endpoints before opening a socket', async () => {
  for (const endpoint of ['ws://foreign.invalid:9222/devtools/page/owned', 'wss://127.0.0.1:9222/devtools/page/owned',
    'ws://127.0.0.1:9333/devtools/page/owned', 'ws://user:secret@127.0.0.1:9222/devtools/page/owned',
    'ws://127.0.0.1:9222/not-a-page']) await assert.rejects(RuntimeCdp.connect(endpoint));
});
