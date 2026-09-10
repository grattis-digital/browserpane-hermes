import assert from 'node:assert/strict';
import test from 'node:test';
import { ScrollbarDragProbe } from '../scripts/scrollbar-drag-probe.mjs';

const geometry = () => ({ box: { x: 0, y: 80, width: 640, height: 360 },
  width: 1280, height: 720, innerWidth: 1280, innerHeight: 640,
  clientWidth: 1262, clientHeight: 622, scrollHeight: 9000, scrollY: 1800 });

test('maps the real native thumb and outside release across viewer scaling', () => {
  const g = geometry();
  const thumb = ScrollbarDragProbe.thumb(g);
  assert.equal(thumb.x, 635.5);
  assert.equal(thumb.top, 120);
  assert.equal(thumb.halfThumb, 622 * 622 / 9000 / 4);
  assert(Math.abs(thumb.y - (thumb.top + thumb.halfThumb + 1800 / (9000 - 622) * thumb.travel)) < 1e-9);
  assert(thumb.outside.y < g.box.y && thumb.outside.y > 0);
});

test('rejects guessed minimum thumbs, missing scrollbars and invalid geometry', () => {
  for (const change of [{ scrollHeight: 622 }, { clientWidth: 1280 },
    { scrollHeight: 1000000 }, { scrollY: -1 }, { width: NaN },
    { width: 2560 }, { box: { x: 0, y: 0, width: 640, height: 360 } }]) {
    assert.throws(() => ScrollbarDragProbe.thumb({ ...geometry(), ...change }));
  }
});

class DragFixture {
  calls = [];
  observations = [{ y: 1800, wheels: 5, moves: 0, buttons: null },
    { y: 3100, wheels: 5, moves: 2, buttons: 1 },
    { y: 3100, wheels: 5, moves: 4, buttons: 0 }];
  constructor(failCheckpoint = false) {
    this.probe = new ScrollbarDragProbe({ geometry: async () => geometry(),
      mouse: { move: async (...xy) => this.calls.push(['move', ...xy]),
        down: async () => this.calls.push(['down']), up: async () => this.calls.push(['up']) },
      inspect: async () => this.observations.shift(), sleep: async () => {}, barrier: async () => {},
      checkpoint: async name => {
        if (failCheckpoint) throw new Error('pixel oracle failed');
        return { pixels: 0, document: { y: name === 'scrollbar-held-jump' ? 6100 : 3100 } };
      } });
  }
}

test('requires jump, reversal, button release and no wheel delivery', async () => {
  const f = new DragFixture();
  assert.equal((await f.probe.run()).releaseVerified, true);
  assert.equal(f.calls.filter(c => c[0] === 'up').length, 1);
  for (const change of [{ buttons: 1 }, { y: 4000 }, { wheels: 6 }, { moves: 2 }]) {
    const invalid = new DragFixture();
    Object.assign(invalid.observations[2], change);
    await assert.rejects(invalid.probe.run());
  }
});

test('releases the local pointer if a held-drag checkpoint fails', async () => {
  const f = new DragFixture(true);
  await assert.rejects(f.probe.run(), /pixel oracle failed/);
  assert.deepEqual(f.calls.at(-1), ['up']);
});
