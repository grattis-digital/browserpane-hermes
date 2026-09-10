import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

// Native sidecar is diagnostic-only and dies with the owned browser container.
export class XDamageObserver {
  #child;
  #lines = [];
  #buffer = '';
  #bytes = 0;
  #failure;
  #ready;
  #done;
  #timer;

  constructor(child) {
    this.#child = child;
    let ready, fail;
    this.#ready = new Promise((resolve, reject) => { ready = resolve; fail = reject; });
    this.#ready.catch(() => {});
    this.#timer = setTimeout(() => this.#stop(new Error('XDamage observer deadline')), 14000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', data => {
      try {
        this.#bytes += data.length;
        assert(this.#bytes <= 256 * 1024, 'XDamage output bound');
        this.#buffer += data;
        let newline;
        while ((newline = this.#buffer.indexOf('\n')) >= 0) {
          const value = JSON.parse(this.#buffer.slice(0, newline));
          this.#buffer = this.#buffer.slice(newline + 1);
          assert(this.#lines.length < 1026, 'XDamage event bound');
          this.#lines.push(value);
          if (this.#lines.length === 1) {
            assert.deepEqual(value, { ready: true, width: 1280, height: 720 }); ready();
          }
        }
      } catch (error) { fail(error); this.#stop(error); }
    });
    child.stdin.on('error', error => this.#stop(error));
    this.#done = new Promise((resolve, reject) => {
      child.once('error', error => { clearTimeout(this.#timer); fail(error); reject(error); });
      child.once('close', code => {
        clearTimeout(this.#timer);
        try {
          if (this.#failure) throw this.#failure;
          assert.equal(code, 0, 'XDamage observer failed');
          assert.equal(this.#buffer, '');
          const result = XDamageObserver.validate(this.#lines);
          ready(); resolve(result);
        } catch (error) { fail(error); reject(error); }
      });
    });
    this.#done.catch(() => {});
  }

  static async start(token) {
    assert.match(token, /^[a-f0-9-]{36}$/);
    const observer = new XDamageObserver(spawn('/opt/browserpane-chromium/bph-xdamage-observer',
      [token], { stdio: ['pipe', 'pipe', 'inherit'] }));
    await observer.#ready;
    return observer;
  }

  static validate(lines) {
    assert(lines.length >= 2 && lines.length <= 1026);
    assert.deepEqual(lines[0], { ready: true, width: 1280, height: 720 });
    assert.deepEqual(lines.at(-1), { done: true, rectangles: lines.length - 2 });
    let previous = 0;
    for (const value of lines.slice(1, -1)) {
      assert.deepEqual(Object.keys(value).sort(), ['height', 'ms', 'width', 'x', 'y']);
      assert(Number.isFinite(value.ms) && value.ms >= previous && value.ms <= 12500);
      previous = value.ms;
      assert([value.x, value.y, value.width, value.height].every(Number.isInteger));
      assert(value.x >= 0 && value.y >= 0 && value.width > 0 && value.height > 0);
      assert(value.x + value.width <= 1280 && value.y + value.height <= 720);
    }
    return lines.slice(1, -1);
  }

  #stop(error) { this.#failure ??= error; this.#child.kill('SIGTERM'); }
  async finish() { this.#child.stdin.end(); return this.#done; }
  async close() { this.#child.stdin.end(); await this.#done; }
}
