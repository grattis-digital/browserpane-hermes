import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

/** Test-owned Python process using the identical controller/worker as Hermes. */
export class WorkflowWarmDriver {
  #child; #pending; #buffer = ''; #failure; #signal;
  constructor(signal) { this.#signal = signal; }
  async start(python, root, endpoint, downloads) {
    assert(!this.#child);
    const ready = this.#response();
    this.#child = spawn(python, [fileURLToPath(new URL('../hermes/workflow_warm_fixture.py', import.meta.url)), root, endpoint, downloads], {
      env: { PATH: process.env.PATH, LANG: 'C.UTF-8', PYTHONDONTWRITEBYTECODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.#child.stdout.on('data', chunk => this.#receive(chunk));
    this.#child.stderr.on('data', () => {}); // Endpoint/SDK errors never copied into reports.
    this.#child.on('error', error => this.#fail(error));
    this.#child.on('close', () => this.#fail(new Error('Owned warm worker exited')));
    assert.equal((await ready).ready, true);
  }
  #fail(error) { this.#failure = error; this.#pending?.reject(error); }
  #receive(chunk) {
    this.#buffer += chunk;
    if (this.#buffer.length > 65536) { this.#fail(new Error('Fixture response limit')); this.#child.kill('SIGKILL'); return; }
    const position = this.#buffer.indexOf('\n');
    if (position < 0) return;
    try {
      assert(this.#pending, 'Unsolicited fixture response');
      const value = JSON.parse(this.#buffer.slice(0, position));
      this.#buffer = this.#buffer.slice(position + 1); assert.equal(this.#buffer, '');
      this.#pending.resolve(value);
    } catch (error) { this.#fail(error); }
  }
  #response() {
    assert(!this.#pending, 'No unbounded command queue');
    this.#signal?.throwIfAborted();
    if (this.#failure) return Promise.reject(this.#failure);
    return new Promise((resolve, reject) => {
      const finish = (error, value) => {
        clearTimeout(timer); this.#signal?.removeEventListener('abort', abort); this.#pending = undefined;
        if (error) reject(error); else resolve(value);
      };
      const abort = () => finish(new Error('Owned fixture command interrupted'));
      const timer = setTimeout(() => finish(new Error('Owned fixture command timeout')), 60000);
      this.#signal?.addEventListener('abort', abort, { once: true });
      this.#pending = { resolve: value => finish(null, value), reject: error => finish(error) };
    });
  }
  async command(args) {
    assert(this.#child && this.#child.exitCode === null);
    const response = this.#response();
    this.#child.stdin.write(JSON.stringify(args) + '\n', error => { if (error) this.#fail(error); });
    return response;
  }
  async execute(runId, op = 'run') {
    assert(['run', 'reconcile'].includes(op));
    const started = performance.now(), deadline = started + 60000;
    let value = await this.command({ op, run_id: runId }), polls = 0;
    while (value.active) {
      assert(performance.now() < deadline, 'Owned warm run exceeded deadline');
      await delay(value.pollAfterMs, undefined, { signal: this.#signal });
      value = await this.command({ op: 'status', run_id: runId }); polls++;
    }
    return { ...value, toolWallMs: performance.now() - started, statusPolls: polls };
  }
  async close() {
    if (!this.#child || this.#child.exitCode !== null || this.#child.signalCode !== null) return;
    const exited = once(this.#child, 'close');
    const timer = setTimeout(() => this.#child.kill('SIGKILL'), 30000);
    try {
      this.#child.stdin.end(); // EOF requests cooperative service cleanup in its owning process.
      await exited;
    } finally { clearTimeout(timer); }
  }
}
