import { setImmediate as nextTurn } from 'node:timers/promises';
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
  #defaultTab;

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
    if (page.isClosed() || this.#tabs.size >= 64) return undefined;
    const tab = new TabState(`t${++this.#counter}`, page);
    this.#tabs.set(tab.id, tab);
    tab.attach(this.#forward, this.#directory);
    page.once('close', () => { tab.detach(); this.#tabs.delete(tab.id); });
    return tab;
  }

  get popupVersion() { return this.#popupVersion; }
  get connected() { return this.#browser.isConnected(); }

  #default() {
    const current = this.#tabs.get(this.#defaultTab);
    if (current && !current.page.isClosed()) return current;
    const tabs = [...this.#tabs.values()].filter(tab => !tab.page.isClosed());
    // Prefer a web/new-tab page to extension or DevTools UI on first selection.
    // Registration order is stable, but is not the visual Chrome tab-strip order.
    const tab = tabs.find(candidate => /^(?:https?:|about:blank(?:[#?]|$)|chrome:\/\/(?:newtab|new-tab-page)\/?$)/.test(candidate.page.url())) ?? tabs[0];
    this.#defaultTab = tab?.id;
    return tab;
  }

  tab(id) {
    this.#assertConnected();
    const tab = id === undefined ? this.#default() : this.#tabs.get(id);
    if (id === undefined && !tab) throw new PaneError('NO_TAB', 'No open shared tab. Call pane_tabs for a lease, then explicitly create one with pane_act new.');
    if (!tab || tab.page.isClosed()) throw new PaneError('UNKNOWN_TAB', 'Call pane_tabs and select an existing tab ID.');
    return tab;
  }

  async list() {
    this.#assertConnected();
    const records = await Promise.all([...this.#tabs.values()].map(async tab => ({ tab, title: await this.#title(tab) })));
    this.#assertConnected();
    // Reconcile after all title requests: a close can happen during any await.
    // Select/mark the surviving default now, not the one from before the await.
    const defaultTab = this.#default();
    return records.filter(({ tab, title }) => title !== undefined && !tab.page.isClosed()).map(({ tab, title }) => ({
      tab: tab.id, url: tab.page.url().slice(0, 4096),
      title,
      ...(tab === defaultTab ? { default: true } : {}),
      ...tab.metadata(),
    }));
  }

  #assertConnected() {
    if (!this.connected) throw new PaneError('DISCONNECTED', 'Browser disconnected. Reconnect after service recovery.');
  }

  async #title(tab) {
    if (tab.page.isClosed()) return undefined;
    try { return tab.dialog ? '' : (await tab.page.title()).slice(0, 300); }
    catch (error) {
      // The closing target's rejection may precede its close event by one turn.
      // No retries/message matching: only confirmed closure permits omission.
      if (!tab.page.isClosed()) await nextTurn();
      if (!tab.page.isClosed()) throw error;
      return undefined;
    }
  }

  assertCanCreate() {
    this.#assertConnected();
    if (this.#context.pages().some(page => !page.isClosed())) {
      throw new PaneError('TAB_EXISTS', 'Reuse the existing tab: call pane_view {} then navigate in place. new is only allowed when no tabs remain.');
    }
  }

  async create() {
    this.assertCanCreate();
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
