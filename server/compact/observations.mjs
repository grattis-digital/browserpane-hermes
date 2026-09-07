import { randomBytes } from 'node:crypto';
import { ObservationError } from './observation-error.mjs';
import { ObservationInput } from './observation-input.mjs';
import { ObservationProjection } from './observation-projection.mjs';
import { ObservationRefs } from './observation-refs.mjs';

/** Per-client history. Oldest views are evicted; unknown delta bases reset to full. */
export class ObservationStore {
  #idFactory;
  #views = new Map();
  #states = new Map();

  constructor({ idFactory = () => randomBytes(12).toString('base64url') } = {}) {
    if (typeof idFactory !== 'function') throw new ObservationError('invalid_id_factory', 'View ID factory must be callable.');
    this.#idFactory = idFactory;
  }

  /** Returns a wire view. Only an explicitly supplied, compatible `since` permits a delta. */
  capture(input) {
    const capture = ObservationInput.capture(input);
    ObservationRefs.from(capture.snapshot); // Validate all raw refs, including off-page duplicates.
    const view = this.#nextId();
    const state = view;
    this.#states.set(state, { state, tab: capture.tab, document: capture.document, mutation: capture.mutation,
      url: capture.url, title: capture.title, snapshot: capture.snapshot });
    while (this.#states.size > 4) this.#states.delete(this.#states.keys().next().value);
    return this.#project(capture, state, view);
  }

  /** Reprojects an immutable raw snapshot without asking Chromium to serialize it again. */
  reproject(state, options = {}) {
    const source = this.#states.get(state);
    if (!source) throw new ObservationError('unknown_state', 'Observation state expired; capture a fresh pane_view.');
    this.#states.delete(state); this.#states.set(state, source); // Bounded LRU touch.
    const capture = ObservationInput.capture({ ...source, ...options, tab: source.tab, document: source.document,
      mutation: source.mutation, url: source.url, title: source.title, snapshot: source.snapshot });
    return this.#project(capture, state, this.#nextId());
  }

  source(state) {
    if (typeof state !== 'string') return undefined;
    const source = this.#states.get(state);
    return source ? { state: source.state, tab: source.tab, document: source.document,
      mutation: source.mutation, url: source.url, title: source.title } : undefined;
  }

  /** A view-bound cursor retains its projection; interleaved queries cannot change it. */
  continuation(cursor) {
    const stored = this.#views.get(cursor);
    if (!stored || stored.next === undefined || !this.#states.has(stored.state)) return undefined;
    return { state: stored.state, ...structuredClone(stored.projection), offset: stored.next };
  }

  #project(capture, state, view) {
    const projected = ObservationProjection.create(capture.lines, capture.projection);
    const stored = { view, state, tab: capture.tab, document: capture.document, url: capture.url, title: capture.title,
      snapshot: capture.snapshot, projection: capture.projection, ...projected };
    const wire = this.#wire(stored, capture.since);
    this.#views.set(view, stored);
    while (this.#views.size > 4) this.#views.delete(this.#views.keys().next().value);
    return wire;
  }

  /** Defensive copies prevent clients/actions from changing a stored delta base or ref scope. */
  inspect(view) {
    if (typeof view !== 'string') return undefined;
    const stored = this.#views.get(view);
    return stored ? { ...stored, projection: structuredClone(stored.projection), refs: new Map(stored.refs),
      truncatedLines: [...stored.truncatedLines] } : undefined;
  }

  invalidateTab(tab) {
    if (typeof tab !== 'string') throw new ObservationError('invalid_observation', 'Invalid tab.');
    for (const [view, stored] of this.#views) if (stored.tab === tab) this.#views.delete(view);
    for (const [state, stored] of this.#states) if (stored.tab === tab) this.#states.delete(state);
  }

  clear() { this.#views.clear(); this.#states.clear(); }

  #nextId() {
    for (let attempt = 0; attempt < 4; attempt++) {
      const view = this.#idFactory();
      if (typeof view !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(view))
        throw new ObservationError('invalid_view_id', 'View ID factory returned an invalid ID.');
      if (!this.#views.has(view) && !this.#states.has(view)) return view;
    }
    throw new ObservationError('view_id_collision', 'View ID factory repeatedly returned a live ID.');
  }

  #wire(stored, since) {
    const { view, state, tab, document, url, title, projection, total, matches, next, truncated, truncatedLines, text } = stored;
    const wire = { view, state, tab, document, url, title, total, mode: 'full', text };
    if (projection.detail !== 'full') wire.detail = projection.detail;
    if (projection.filter) wire.filter = projection.filter;
    if (matches !== undefined) wire.matches = matches;
    if (projection.offset) wire.offset = projection.offset;
    if (projection.limit !== 120) wire.limit = projection.limit;
    if (projection.maxChars !== 6000) wire.maxChars = projection.maxChars;
    if (next !== undefined) { wire.next = next; wire.cursor = view; }
    if (truncated) { wire.truncated = true; wire.truncatedLines = [...truncatedLines]; }
    const base = since === undefined ? undefined : this.#views.get(since);
    if (!base || base.tab !== tab || base.document !== document ||
      JSON.stringify(base.projection) !== JSON.stringify(projection)) {
      if (since !== undefined) wire.reset = true;
      return wire;
    }
    const splice = this.#splice(base.text, text);
    const delta = { mode: 'delta', base: since, splice };
    if (Buffer.byteLength(JSON.stringify(delta), 'utf8') <
      Buffer.byteLength(JSON.stringify({ mode: 'full', text }), 'utf8')) {
      delete wire.text;
      Object.assign(wire, delta);
    } else wire.reset = true;
    return wire;
  }

  #splice(before, after) {
    const oldLines = before === '' ? [] : before.split('\n'), newLines = after === '' ? [] : after.split('\n');
    let start = 0, end = 0;
    while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++;
    while (end < oldLines.length - start && end < newLines.length - start &&
      oldLines[oldLines.length - 1 - end] === newLines[newLines.length - 1 - end]) end++;
    return { start, deleteCount: oldLines.length - start - end, lines: newLines.slice(start, newLines.length - end) };
  }
}
