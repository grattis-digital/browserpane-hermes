import { ObservationError } from './observation-error.mjs';

/** Validates untrusted snapshot bytes and the deliberately small projection API. */
export class ObservationInput {
  static snapshot(snapshot) {
    if (typeof snapshot !== 'string') throw new ObservationError('invalid_snapshot', 'Snapshot must be a string.');
    if (Buffer.byteLength(snapshot, 'utf8') > 1024 * 1024)
      throw new ObservationError('snapshot_too_large', 'Snapshot exceeds the 1 MiB raw limit; narrow the browser observation.');
    const lines = snapshot === '' ? [] : snapshot.split('\n');
    if (lines.length > 32768)
      throw new ObservationError('snapshot_too_large', 'Snapshot exceeds the 32768-line raw limit.');
    return lines;
  }

  static capture(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new ObservationError('invalid_observation', 'Observation input must be an object.');
    const { tab, document, url, title, snapshot, detail = 'full', filter = '', offset = 0,
      limit = 120, maxChars = 6000, since } = input;
    this.#string(tab, 'tab', 128, false);
    this.#integer(document, 'document', 1, Number.MAX_SAFE_INTEGER);
    this.#string(url, 'url', 8192);
    this.#string(title, 'title', 4096);
    if (detail !== 'full' && detail !== 'controls')
      throw new ObservationError('invalid_projection', 'Detail must be full or controls.');
    this.#string(filter, 'filter', 256);
    this.#integer(offset, 'offset', 0, 32768);
    this.#integer(limit, 'limit', 1, 500);
    this.#integer(maxChars, 'maxChars', 64, 24576);
    if (since !== undefined) this.#string(since, 'since', 128, false);
    return { tab, document, url, title, snapshot, lines: this.snapshot(snapshot), since,
      projection: { detail, filter, offset, limit, maxChars } };
  }

  static #string(value, field, maximum, empty = true) {
    if (typeof value !== 'string' || (!empty && !value.length) || value.length > maximum)
      throw new ObservationError('invalid_observation', `Invalid ${field}.`);
  }

  static #integer(value, field, minimum, maximum) {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
      throw new ObservationError('invalid_projection', `Invalid ${field}.`);
  }
}
