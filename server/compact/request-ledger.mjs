import { PaneError } from './errors.mjs';

export class RequestLedger {
  #highest = 0;
  #records = new Map();
  #limit;

  constructor(limit = 64) { this.#limit = limit; }

  run(request, signature, work) {
    if (!Number.isSafeInteger(request) || request < 1) {
      throw new PaneError('INVALID_REQUEST', 'request must be a positive increasing integer.');
    }
    const prior = this.#records.get(request);
    if (prior) {
      if (prior.signature !== signature) throw new PaneError('REQUEST_REUSED', 'Use a new request number for different arguments.');
      return prior.promise;
    }
    if (request <= this.#highest) throw new PaneError('REQUEST_EXPIRED', 'Old request will not be executed again. Observe current state.');
    this.#highest = request;
    // Install before work starts, so concurrent duplicate requests share one
    // outcome even when the first HTTP response is lost. Errors are cached too.
    const promise = Promise.resolve().then(work);
    this.#records.set(request, { signature, promise });
    if (this.#records.size > this.#limit) this.#records.delete(this.#records.keys().next().value);
    return promise;
  }
}
