import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

// One in-flight operation; finite remote owner cleans on stdin EOF or watchdog.
export class RenderRpc {
  #child;
  #sequence = 0;
  #pending = new Map();
  #buffer = '';
  #stderr = '';
  #exit;
  #ready;
  #exited = false;
  #failure = null;

  constructor(child) {
    this.#child = child;
    this.#ready = this.#wait(0, 330000);
    this.#exit = new Promise(resolve => child.once('close', (code, signal) => {
      this.#exited = true;
      for (const value of this.#pending.values()) {
        clearTimeout(value.timer); value.reject(new Error(`Pilot exited ${code}/${signal}: ${this.#stderr}`));
      }
      this.#pending.clear(); resolve({ code, signal });
    }));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => this.#receive(chunk));
    child.stderr.on('data', chunk => { this.#stderr = (this.#stderr + chunk).slice(-4000); });
    child.on('error', error => {
      this.#exited = true;
      for (const value of this.#pending.values()) { clearTimeout(value.timer); value.reject(error); }
      this.#pending.clear();
    });
    child.stdin.on('error', () => {}); // Exit/deadline rejects the in-flight operation.
  }

  static launch({ ssh, remoteConfig }) {
    assert.match(ssh, /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*@[a-zA-Z0-9][a-zA-Z0-9.-]*$/);
    assert.match(remoteConfig, /^\/tmp\/bph-render-pilot\.[a-zA-Z0-9]+\/[a-z0-9-]+\.json$/);
    const directory = remoteConfig.slice(0, remoteConfig.lastIndexOf('/'));
    return new RenderRpc(spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8',
      '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=3', ssh,
      `sudo -n python3 -u ${directory}/code/run.py ${remoteConfig}`], { stdio: ['pipe', 'pipe', 'pipe'] }));
  }

  #wait(id, milliseconds) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id); this.#child.stdin.end(); reject(new Error('Pilot RPC deadline'));
      }, milliseconds);
      this.#pending.set(id, { resolve, reject, timer });
    });
  }

  #receive(chunk) {
    try {
      this.#buffer += chunk;
      assert(this.#buffer.length <= 8 * 1024 * 1024, 'Pilot RPC response bound');
      let newline;
      while ((newline = this.#buffer.indexOf('\n')) !== -1) {
        const message = JSON.parse(this.#buffer.slice(0, newline));
        this.#buffer = this.#buffer.slice(newline + 1);
        if (Object.hasOwn(message, 'error')) {
          // The owner's watchdog may fail BETWEEN requests and report the
          // previous ID. Preserve that terminal cause instead of dropping it.
          this.#failure = new Error(message.error || 'Pilot operation rejected without a message');
          for (const value of this.#pending.values()) { clearTimeout(value.timer); value.reject(this.#failure); }
          this.#pending.clear(); this.#child.stdin.end();
          continue;
        }
        const waiter = this.#pending.get(message.id);
        if (!waiter) continue; // Final cleanup notification after an error.
        this.#pending.delete(message.id); clearTimeout(waiter.timer);
        waiter.resolve(message.result);
      }
    } catch (error) {
      this.#child.stdin.end();
      for (const waiter of this.#pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
      this.#pending.clear();
    }
  }

  ready() { return this.#ready; }

  async call(op) {
    if (this.#failure) throw this.#failure;
    assert(!this.#exited && !this.#child.stdin.destroyed, 'Pilot is no longer running');
    assert(['sample', 'install', 'inspect', 'gpu', 'pixels', 'timings', 'native-damage-trace', 'stock-trace-start', 'stock-trace-stop', 'finish'].includes(op));
    assert.equal(this.#pending.size, 0, 'Concurrent pilot operations are forbidden');
    const id = ++this.#sequence, response = this.#wait(id, op === 'finish' ? 150000 : 30000);
    this.#child.stdin.write(JSON.stringify({ id, op }) + '\n');
    return response;
  }

  async close() {
    this.#child.stdin.end();
    // Remote cleanup is bounded independently. Do not kill it mid-cleanup.
    return this.#exit;
  }
}
