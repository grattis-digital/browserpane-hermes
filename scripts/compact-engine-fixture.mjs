import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import downloads from '../server/mcp-downloads.cjs';
import { SharedBrowser } from '../server/compact/browser.mjs';
import { SerialExecutor } from '../server/compact/executor.mjs';
import { RequestLedger } from '../server/compact/request-ledger.mjs';
import { ObservationStore } from '../server/compact/observations.mjs';
import { SharedUploads } from '../server/compact/uploads.mjs';
import { ActionSteps } from '../server/compact/action-steps.mjs';
import { ActionRunner } from '../server/compact/action-runner.mjs';
import { PaneSession } from '../server/compact/session.mjs';

/** Owns a fresh profile and CDP attachment; accepts no existing browser endpoint. */
export class CompactEngineFixture {
  #temporary;
  #identity;
  #context;
  #browser;
  #executor;
  #actions;
  #sessions = [];
  #counter = 0;

  async start() {
    this.#temporary = await mkdtemp(join(tmpdir(), 'bpane-compact-engine-'));
    this.#identity = await realpath(this.#temporary);
    const profile = join(this.#temporary, 'profile');
    await mkdir(join(this.#temporary, 'shared'));
    this.#context = await chromium.launchPersistentContext(profile, { executablePath: chromium.executablePath(),
      headless: true, chromiumSandbox: true,
      viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, serviceWorkers: 'block',
      args: ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--disable-background-networking'] });
    // The launcher connection is only an oracle: don't let its default dialog
    // auto-dismiss race the separate compact CDP attachment's explicit handler.
    for (const page of this.#context.pages()) page.on('dialog', () => {});
    this.#context.on('page', page => page.on('dialog', () => {}));
    await this.#context.route('**/*', route => route.abort('blockedbyclient'));
    const [port] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n');
    assert.match(port, /^\d+$/);
    const connection = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    this.#browser = new SharedBrowser(connection, connection.contexts()[0], downloads.forwardDownload, join(this.#temporary, 'shared'));
    this.#browser.start(); this.#executor = new SerialExecutor();
    this.#actions = new ActionRunner(this.#browser, new ActionSteps(this.#browser, new SharedUploads(join(this.#temporary, 'shared'))), () => performance.now());
    return this;
  }

  async reset(html) {
    const page = this.#context.pages()[0];
    await page.goto('about:blank'); await page.setContent(html);
    return page;
  }

  session() {
    const lease = `test-lease-${++this.#counter}`;
    const session = { lease, request: 0, engine: new PaneSession({ browser: this.#browser, executor: this.#executor,
      actions: this.#actions, observations: new ObservationStore(), ledger: new RequestLedger(), lease }) };
    this.#sessions.push(session); return session;
  }

  async call(session, name, args = {}) {
    const result = await session.engine.callTool(name, args);
    return { ...JSON.parse(result.content[0].text), isError: result.isError === true };
  }

  view(session, options = {}) { return this.call(session, 'pane_view', options); }

  act(session, view, steps, extra = {}) {
    return this.call(session, 'pane_act', { lease: session.lease, request: ++session.request,
      ...(view ? { tab: view.tab, view: view.view } : {}), steps, ...extra });
  }

  static ref(view, name) {
    const lines = view.text.split('\n').filter(line => line.includes(`"${name}"`));
    assert.equal(lines.length, 1, `Expected exactly one synthetic target: ${name}`);
    const ref = lines[0].match(/\[ref=([a-z0-9]+)\]/)?.[1]; assert(ref); return ref;
  }

  sharedPath(name) { return join(this.#temporary, 'shared', name); }
  pageFor(tab) { return this.#browser.tab(tab).page; }

  async waitForTabs(count) {
    const deadline = performance.now() + 3000;
    while (this.#context.pages().length !== count && performance.now() < deadline) await delay(10);
    assert.equal(this.#context.pages().length, count, 'Actual browser tab count must match the completed lifecycle operation');
  }

  async assertOwnership() {
    for (const session of this.#sessions) await session.engine.close();
    const page = this.#context.pages()[0]; assert(!page.isClosed());
    await page.evaluate(() => { window.__compactOwnershipMarker = 'still-shared'; });
    await this.#browser.disconnect(); this.#browser = undefined;
    assert(this.#context.browser().isConnected());
    assert.equal(await page.evaluate(() => window.__compactOwnershipMarker), 'still-shared');
  }

  async close() {
    const errors = [], attempt = async work => { try { await work(); } catch (error) { errors.push(error); } };
    for (const session of this.#sessions) await attempt(() => session.engine.close());
    this.#executor?.close();
    await attempt(async () => { await this.#browser?.disconnect(); });
    // The launcher oracle observes dialogs handled by a separate CDP client.
    // Pinned Playwright retains those now-stale Dialog objects in this context;
    // context.close() tries dismissing old beforeunload dialogs on closed pages.
    // Close the explicitly owned launcher browser instead, without suppressing errors.
    await attempt(async () => {
      const owned = this.#context?.browser();
      await owned?.close();
      if (owned) assert.equal(owned.isConnected(), false, 'Owned Chromium must disconnect on cleanup');
    });
    await attempt(async () => {
      if (!this.#temporary) return;
      assert(basename(this.#temporary).startsWith('bpane-compact-engine-'));
      assert.equal(await realpath(this.#temporary), this.#identity);
      await rm(this.#temporary, { recursive: true }); this.#temporary = undefined;
    });
    if (errors.length) throw new AggregateError(errors, 'Owned compact engine fixture cleanup failed');
  }
}
