import { errors } from 'playwright-core';
import { PaneError } from './errors.mjs';

export class TabState {
  #page;
  #id;
  #document = 1;
  #mutation = 0;
  #dialog;
  #downloads = [];
  #listeners = [];
  #pendingDialogAction;
  #coverage;

  constructor(id, page) { this.#id = id; this.#page = page; }
  get id() { return this.#id; }
  get page() { return this.#page; }
  get document() { return this.#document; }
  get mutation() { return this.#mutation; }
  get dialog() { return this.#dialog; }
  get coverage() { return this.#coverage ? structuredClone(this.#coverage) : undefined; }

  attach(forwardDownload, directory) {
    this.#listen('framenavigated', () => { this.#document++; });
    this.#listen('frameattached', () => { this.#document++; });
    this.#listen('framedetached', () => { this.#document++; });
    this.#listen('dialog', dialog => { this.#dialog = dialog; this.#mutation++; });
    this.#listen('download', download => {
      const record = { file: download.suggestedFilename().slice(0, 200), status: 'pending' };
      this.#downloads.push(record);
      if (this.#downloads.length > 4) this.#downloads.shift();
      void forwardDownload(download, directory).then(path => {
        record.file = path.slice(0, 512); record.status = 'complete';
      }, () => { record.status = 'failed'; });
    });
    this.#page.setDefaultTimeout(3000);
    this.#page.setDefaultNavigationTimeout(10000);
  }

  #listen(name, handler) { this.#page.on(name, handler); this.#listeners.push([name, handler]); }
  consume() { this.#mutation++; }

  assert(document, mutation) {
    if (this.#page.isClosed()) throw new PaneError('TAB_CLOSED', 'The observed tab is closed.');
    if (document !== this.#document || mutation !== this.#mutation) {
      throw new PaneError('STALE_VIEW', 'Tab changed since observation. Call pane_view; do not guess a target.');
    }
  }

  async snapshot(options = {}) {
    this.#coverage = undefined;
    if (this.#dialog) return '';
    // Explicitly pinned private Playwright adapter, qualified by real-browser
    // tests. No tracking key: delta state belongs to our MCP client, not a Page.
    // A fresh snapshot walks the DOM, styles and child frames before projection.
    // Large pages on the Pi can take >10s. This is a ceiling, not a sleep; do not
    // race/retry it or return stale cached refs when the renderer is still busy.
    const bounded = options.capture === 'outline' || options.root !== undefined;
    const timeout = options.target || !bounded ? 15000 : options.capture === 'outline' ? 3000 : 5000;
    const depth = options.target ? 0 : options.capture === 'outline' ? (options.depth ?? 1) : undefined;
    const nodeLimit = options.target ? 1 : options.capture === 'outline' ? 256 : 1024;
    const selector = options.root ? `aria-ref=${options.root}${options.enterFrame ? ' >> internal:control=enter-frame >> body' : ''}` : undefined;
    try {
      const result = await this.#page._snapshotForAI({ timeout, ...(bounded ? {
        selector, maxDepth: depth, maxNodes: nodeLimit, includeFrames: false,
      } : {}) });
      if (result.scopeMissing) throw new PaneError('STALE_REF', 'Observed scope or target is no longer available. Capture a fresh outline.');
      if (bounded) {
        const raw = result.coverage;
        if (!raw || !Number.isSafeInteger(raw.visitedNodes) || raw.visitedNodes < 0 || raw.visitedNodes > nodeLimit ||
            typeof raw.depthLimited !== 'boolean' || typeof raw.nodeLimited !== 'boolean' ||
            !Number.isSafeInteger(raw.framesDeferred) || raw.framesDeferred < 0)
          throw new PaneError('SNAPSHOT_ADAPTER', 'Scoped snapshot adapter missing or invalid; verify the pinned dependency patch.');
        this.#coverage = { scope: options.root ?? 'page', ...(options.enterFrame ? { enterFrame: true } : {}),
          ...(depth !== undefined ? { depth } : {}), nodeLimit, ...raw,
          complete: !raw.depthLimited && !raw.nodeLimited && raw.framesDeferred === 0 };
      }
      return result.full;
    }
    catch (error) {
      if (!(error instanceof errors.TimeoutError)) throw error;
      throw new PaneError('SNAPSHOT_TIMEOUT', `Accessibility capture exceeded ${timeout / 1000}s. Let the page settle before a fresh pane_view; avoid immediate retries. Do not replay input.`, { cause: error });
    }
  }

  metadata() {
    return {
      ...(this.#dialog ? { dialog: { type: this.#dialog.type(), message: this.#dialog.message().slice(0, 1000) } } : {}),
      ...(this.#downloads.length ? { downloads: structuredClone(this.#downloads) } : {}),
    };
  }

  async handleDialog(accept, text) {
    if (!this.#dialog) throw new PaneError('NO_DIALOG', 'The observed dialog no longer exists.');
    const dialog = this.#dialog;
    const pending = this.#pendingDialogAction;
    let listener;
    const nextModal = new Promise(resolve => { listener = () => resolve({ modal: true }); this.#page.once('dialog', listener); });
    try {
      if (accept) await dialog.accept(text); else await dialog.dismiss();
      if (this.#dialog === dialog) this.#dialog = undefined;
      if (pending) {
        const outcome = await Promise.race([pending, nextModal]);
        if (!outcome.modal) this.#pendingDialogAction = undefined;
        if (outcome.error) throw new PaneError('INTERRUPTED_ACTION', 'The earlier dialog-interrupted action stopped. Observe current state.');
      }
    } finally { this.#page.off('dialog', listener); }
  }

  async act(work) {
    if (this.#dialog || this.#pendingDialogAction) throw new PaneError('DIALOG_OPEN', 'Handle the dialog before further browser input.');
    let listener;
    const modal = new Promise(resolve => { listener = () => resolve({ modal: true }); this.#page.once('dialog', listener); });
    const action = Promise.resolve().then(work).then(() => ({}), error => ({ error }));
    try {
      const result = await Promise.race([action, modal]);
      // Only an observed modal may suspend an action. No other input is allowed
      // until explicit dialog handling awaits its original completion.
      if (result.modal) this.#pendingDialogAction = action;
      if (result.error) throw result.error;
      return result;
    } finally { this.#page.off('dialog', listener); }
  }

  async releaseWhenSettled(cleanup) {
    if (!this.#pendingDialogAction) { await cleanup(); return; }
    // A dialog may pause Playwright after it issued input. Keep handles alive,
    // but return MCP control so the agent can explicitly handle that dialog.
    void this.#pendingDialogAction.then(cleanup).catch(() => {});
  }

  detach() {
    for (const [name, handler] of this.#listeners) this.#page.off(name, handler);
    this.#listeners.length = 0;
  }
}
