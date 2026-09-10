import assert from 'node:assert/strict';

// Deterministic, human-shaped stress traces, NOT recordings of actual people.
// Wheel events enter the viewer's normal input path; never call remote scrollBy.
export class ScrollGestureProbe {
  #clock;
  #sleep;
  #wheel;

  constructor({ clock, sleep, wheel }) {
    this.#clock = clock;
    this.#sleep = sleep;
    this.#wheel = wheel;
  }

  static scenarios() {
    const trace = (name, values, spacing, target = 'document') => ({ name, target,
      events: values.map((dy, i) => ({ atMs: i * spacing, dx: 0, dy })) });
    return [
      trace('wheel-burst', [120, 120, 240, 120, 360, 120], 8),
      trace('momentum-tail', [4, 9, 19, 37, 83, 161, 127, 89, 61, 37, 21, 13, 7, 3, 1], 9),
      trace('momentum-reversal', [171, 133, 97, 51, -3, -11, -37, -97, -191, -67, -13, -1], 11),
      { ...trace('pause-resume', [39, 19, -23, -43, -121, 91, 17], 10),
        events: [0, 9, 270, 281, 295, 810, 819].map((atMs, i) => ({
          atMs, dx: 0, dy: [39, 19, -23, -43, -121, 91, 17][i],
        })) },
      trace('nested-momentum', [17, 61, 137, 211, 73, -191, -131, 7], 13, 'nested'),
      { name: 'nested-diagonal', target: 'nested', events: [
        { atMs: 0, dx: 131, dy: 97 }, { atMs: 12, dx: 193, dy: 131 },
        { atMs: 23, dx: -157, dy: -67 }, { atMs: 41, dx: -131, dy: 127 },
      ] },
    ];
  }

  async run(trace) {
    assert(trace && typeof trace.name === 'string');
    assert(Array.isArray(trace.events) && trace.events.length > 0 && trace.events.length <= 256);
    let previousAt = -1;
    for (const event of trace.events) {
      assert(Number.isFinite(event.atMs) && event.atMs >= 0 && event.atMs >= previousAt && event.atMs <= 5000);
      assert(Number.isFinite(event.dx) && Math.abs(event.dx) <= 1024);
      assert(Number.isFinite(event.dy) && Math.abs(event.dy) <= 1024);
      previousAt = event.atMs;
    }
    const start = this.#clock();
    const samples = [];
    for (const event of trace.events) {
      const wait = start + event.atMs - this.#clock();
      if (wait > 0) await this.#sleep(wait);
      const issuedMs = this.#clock() - start;
      await this.#wheel(event.dx, event.dy);
      samples.push({ ...event, issuedMs, completedMs: this.#clock() - start,
        lateMs: Math.max(0, issuedMs - event.atMs) });
    }
    return { name: trace.name, target: trace.target, samples,
      maxLateMs: Math.max(...samples.map(sample => sample.lateMs)),
      scope: 'Viewer wheel injection schedule, not host receipt or input-to-pixel latency' };
  }
}
