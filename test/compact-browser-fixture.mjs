import { EventEmitter } from 'node:events';
import { SharedBrowser } from '../server/compact/browser.mjs';
import { PaneSession } from '../server/compact/session.mjs';
import { SerialExecutor } from '../server/compact/executor.mjs';
import { RequestLedger } from '../server/compact/request-ledger.mjs';
import { ObservationStore } from '../server/compact/observations.mjs';
import { ActionRunner } from '../server/compact/action-runner.mjs';
import { ActionSteps } from '../server/compact/action-steps.mjs';

class SyntheticPage extends EventEmitter {
  constructor(url) { super(); this.address = url; this.closed = false; this.navigations = []; this.activations = 0; }
  isClosed() { return this.closed; }
  url() { return this.address; }
  async title() { return 'Synthetic shared tab'; }
  setDefaultTimeout() {}
  setDefaultNavigationTimeout() {}
  async _snapshotForAI() { return { full: '- heading "Synthetic shared tab" [level=1]' }; }
  async goto(url) { this.address = url; this.navigations.push(url); this.emit('framenavigated'); }
  async bringToFront() { this.activations++; }
  async close() { this.closed = true; this.emit('close'); }
}

/** In-memory browser boundary: all page creation, navigation and focus are counted. */
export class CompactBrowserFixture {
  constructor(urls = ['https://fixture.test/first', 'https://fixture.test/second']) {
    this.pages = urls.map(url => new SyntheticPage(url));
    this.creations = 0; this.connected = true; this.sessionCount = 0;
    this.context = new EventEmitter();
    this.context.pages = () => this.pages.filter(page => !page.isClosed());
    this.context.newPage = async () => {
      this.creations++;
      const page = new SyntheticPage('about:blank');
      this.pages.push(page); this.context.emit('page', page); return page;
    };
    this.connection = { isConnected: () => this.connected, close: async () => { this.connected = false; } };
    this.browser = new SharedBrowser(this.connection, this.context, async () => {}, '/synthetic-shared/downloads');
    this.browser.start();
    this.executor = new SerialExecutor();
    this.actions = new ActionRunner(this.browser, new ActionSteps(this.browser), () => 0);
  }
  session() {
    const lease = `lease-${++this.sessionCount}`;
    return new PaneSession({ browser: this.browser, executor: this.executor, actions: this.actions,
      observations: new ObservationStore(), ledger: new RequestLedger(), lease });
  }
  async call(session, name, args = {}) {
    return JSON.parse((await session.callTool(name, args)).content[0].text);
  }
  async close() { this.executor.close(); await this.browser.disconnect(); }
}
