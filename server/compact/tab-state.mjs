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

  constructor(id, page) { this.#id = id; this.#page = page; }
  get id() { return this.#id; }
  get page() { return this.#page; }
  get document() { return this.#document; }
  get mutation() { return this.#mutation; }
  get dialog() { return this.#dialog; }

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

  async snapshot() {
    if (this.#dialog) return '';
    // Explicitly pinned private Playwright adapter, qualified by real-browser
    // tests. No tracking key: delta state belongs to our MCP client, not a Page.
    return (await this.#page._snapshotForAI({ timeout: 3000 })).full;
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
