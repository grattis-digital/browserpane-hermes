import assert from 'node:assert/strict';
import test from 'node:test';
import { ScrollGestureProbe } from '../scripts/scroll-gesture-probe.mjs';

test('traces contain small deltas, burst, decay, reversal, pauses and nested diagonal input', () => {
  const traces = ScrollGestureProbe.scenarios();
  assert.equal(traces.length, 6);
  assert(traces.some(t => t.events.some(e => Math.abs(e.dy) === 1)));
  assert(traces.some(t => t.events.some(e => e.dy < 0) && t.events.some(e => e.dy > 0)));
  assert(traces.some(t => t.events.some((e, i) => i && e.atMs - t.events[i - 1].atMs > 250)));
  assert(traces.some(t => t.target === 'nested' && t.events.some(e => e.dx && e.dy)));
  const changed = ScrollGestureProbe.scenarios(); changed[0].events[0].dy = 1;
  assert.equal(traces[0].events[0].dy, 120, 'No shared mutable trace state');
});

test('schedules by absolute time and records injection delay rather than pretending a fast burst', async () => {
  let now = 0;
  const seen = [];
  const probe = new ScrollGestureProbe({ clock: () => now, sleep: async ms => { now += ms; },
    wheel: async (dx, dy) => { seen.push([now, dx, dy]); now += 20; } });
  const result = await probe.run({ name: 'test', events: [
    { atMs: 0, dx: 0, dy: 120 }, { atMs: 5, dx: 0, dy: -120 }, { atMs: 100, dx: 3, dy: 9 },
  ] });
  assert.deepEqual(seen, [[0, 0, 120], [20, 0, -120], [100, 3, 9]]);
  assert.equal(result.maxLateMs, 15);
});

test('validates complete trace before sending input and rejects unbounded schedules', async () => {
  const probe = new ScrollGestureProbe({ clock: () => 0, sleep: async () => {},
    wheel: async () => { assert.fail('Must not send invalid trace'); } });
  for (const events of [[], [{ atMs: -.5, dx: 0, dy: 1 }], [{ atMs: 5001, dx: 0, dy: 1 }], [{ atMs: 0, dx: NaN, dy: 1 }],
    [{ atMs: 1, dx: 0, dy: 1 }, { atMs: 0, dx: 0, dy: 1 }]]) {
    await assert.rejects(probe.run({ name: 'invalid', events }));
  }
});
