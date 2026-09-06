import { TabState } from './tab-state.mjs';
import { PaneError } from './errors.mjs';

export class SharedBrowser {
  #browser;
  #context;
  #tabs = new Map();
  #counter = 0;
  #popupVersion = 0;
  #forward;
  #directory;
  #pageHandler;

  constructor(browser, context, forwardDownload, downloadDirectory) {
    this.#browser = browser; this.#context = context;
    this.#forward = forwardDownload; this.#directory = downloadDirectory;
  }

  start() {
    this.#pageHandler = page => { this.#popupVersion++; this.#register(page); };
    this.#context.on('page', this.#pageHandler);
    for (const page of this.#context.pages()) this.#register(page);
  }

  #register(page) {
    for (const tab of this.#tabs.values()) if (tab.page === page) return tab;
    if (this.#tabs.size >= 64) return undefined;
    const tab = new TabState(`t${++this.#counter}`, page);
    this.#tabs.set(tab.id, tab);
    tab.attach(this.#forward, this.#directory);
    page.once('close', () => { tab.detach(); this.#tabs.delete(tab.id); });
    return tab;
  }

  get popupVersion() { return this.#popupVersion; }
  get connected() { return this.#browser.isConnected(); }

  tab(id) {
    if (!this.connected) throw new PaneError('DISCONNECTED', 'Browser disconnected. Reconnect after service recovery.');
    if (id === undefined && this.#tabs.size === 1) return this.#tabs.values().next().value;
    const tab = this.#tabs.get(id);
    if (!tab || tab.page.isClosed()) throw new PaneError('UNKNOWN_TAB', 'Call pane_tabs and select an existing tab ID.');
    return tab;
  }

  async list() {
    return Promise.all([...this.#tabs.values()].map(async tab => ({
      tab: tab.id, url: tab.page.url().slice(0, 4096),
      title: tab.dialog ? '' : (await tab.page.title()).slice(0, 300),
      ...tab.metadata(),
    })));
  }

  async create() {
    if (this.#context.pages().length >= 64) throw new PaneError('TAB_LIMIT', 'Close an unneeded tab before creating another.');
    const page = await this.#context.newPage();
    const tab = this.#register(page);
    if (!tab) throw new PaneError('TAB_LIMIT', 'New tab exists but the tab registry is full.');
    return tab;
  }

  async closeTab(tab) {
    if (this.#context.pages().length <= 1) throw new PaneError('LAST_TAB', 'Keep the last shared browser tab open.');
    await tab.page.close({ runBeforeUnload: true });
  }

  async disconnect() {
    this.#context.off('page', this.#pageHandler);
    for (const tab of this.#tabs.values()) tab.detach();
    this.#tabs.clear();
    // The pinned connectOverCDP adapter closes its connection, not Chromium.
    // Session close never calls this; only process shutdown owns it.
    await this.#browser.close();
  }
}
