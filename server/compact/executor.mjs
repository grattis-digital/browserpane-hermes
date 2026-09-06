import { PaneError } from './errors.mjs';

// One owner for the shared browser. Aborted queued work never starts. Running
// work retains the lock until its browser operation actually finishes: a timeout
// must not let a late click overlap the next client's command.
export class SerialExecutor {
  #queue = [];
  #running = false;
  #closed = false;
  #limit;

  constructor(limit = 8) { this.#limit = limit; }

  run(work, signal) {
    if (this.#closed) return Promise.reject(new PaneError('CLOSED', 'MCP is stopping.'));
    if (signal?.aborted) return Promise.reject(new PaneError('CANCELLED', 'Request cancelled before execution.'));
    if (this.#queue.length >= this.#limit) return Promise.reject(new PaneError('BUSY', 'Browser queue is full.'));
    return new Promise((resolve, reject) => {
      const item = { work, signal, resolve, reject, abort: undefined };
      item.abort = () => {
        const index = this.#queue.indexOf(item);
        if (index < 0) return;
        this.#queue.splice(index, 1);
        reject(new PaneError('CANCELLED', 'Request cancelled before execution.'));
      };
      signal?.addEventListener('abort', item.abort, { once: true });
      this.#queue.push(item);
      void this.#drain();
    });
  }

  async #drain() {
    if (this.#running) return;
    this.#running = true;
    try {
      while (this.#queue.length) {
        const item = this.#queue.shift();
        item.signal?.removeEventListener('abort', item.abort);
        try { item.resolve(await item.work(item.signal)); }
        catch (error) { item.reject(error); }
      }
    } finally { this.#running = false; }
  }

  close() {
    this.#closed = true;
    for (const item of this.#queue.splice(0)) {
      item.signal?.removeEventListener('abort', item.abort);
      item.reject(new PaneError('CLOSED', 'MCP is stopping.'));
    }
  }
}
