import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { XDamageObserver } from '../scripts/render-pilot/xdamage-observer.mjs';

const ready = { ready: true, width: 1280, height: 720 };
const rect = { ms: 10, x: 32, y: 96, width: 24, height: 24 };
const lines = values => [ready, ...values, { done: true, rectangles: values.length }];

test('XDamage geometry stays bounded and explicitly separate from pixel reads', () => {
  assert.deepEqual(XDamageObserver.validate(lines([rect])), [rect]);
  assert.deepEqual(XDamageObserver.validate(lines([])), []);
  for (const value of [{ ...rect, x: -1 }, { ...rect, y: 720 }, { ...rect, width: 0 },
    { ...rect, height: 721 }, { ...rect, ms: NaN }, { ...rect, ms: 13000 },
    { ...rect, x: '32' }, { ...rect, private: 'data' }]) {
    assert.throws(() => XDamageObserver.validate(lines([value])));
  }
  assert.throws(() => XDamageObserver.validate(lines([rect, { ...rect, ms: 9 }])));
  assert.throws(() => XDamageObserver.validate([ready, rect, { done: true, rectangles: 0 }]));
  assert.throws(() => XDamageObserver.validate(lines(Array(1025).fill(rect))));
});

class Child extends EventEmitter {
  stdout = new PassThrough();
  stdin = new PassThrough();
  killed = false;
  kill() { this.killed = true; queueMicrotask(() => this.emit('close', null)); }
}

test('observer drains chunked evidence and closes after explicit finish', async () => {
  const child = new Child(), observer = new XDamageObserver(child);
  const data = lines([rect]).map(value => JSON.stringify(value)).join('\n') + '\n';
  child.stdout.write(data.slice(0, 12)); child.stdout.write(data.slice(12));
  const finished = observer.finish(); child.emit('close', 0);
  assert.deepEqual(await finished, [rect]);
  assert(child.stdin.writableEnded);
});

test('malformed, oversized and incomplete evidence cannot become success', async () => {
  for (const data of ['not-json\n', 'x'.repeat(256 * 1024 + 1), JSON.stringify(ready) + '\n']) {
    const child = new Child(), observer = new XDamageObserver(child);
    child.stdout.write(data);
    const result = observer.finish();
    if (!child.killed) child.emit('close', 0);
    await assert.rejects(result);
  }
});
