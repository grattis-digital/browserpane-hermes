import { createHash } from 'node:crypto';
import { PaneSchemas } from './schemas.mjs';
import { PaneValidation } from './validation.mjs';
import { PaneError } from './errors.mjs';
import { PaneReader } from './reader.mjs';

export class PaneSession {
  #browser;
  #executor;
  #observations;
  #ledger;
  #actions;
  #epochs = new Map();
  #latest = new Map();
  #closed = false;
  #lease;

  constructor({ browser, executor, observations, ledger, actions, lease }) {
    this.#browser = browser; this.#executor = executor; this.#observations = observations;
    this.#ledger = ledger; this.#actions = actions;
    this.#lease = lease;
  }
  listTools() { return PaneSchemas.tools(); }

  async callTool(name, input, { signal } = {}) {
    try {
      if (this.#closed) throw new PaneError('SESSION_CLOSED', 'Initialize a new MCP session.');
      const args = PaneValidation.parse(name, input);
      if (name === 'pane_act' && args.lease !== this.#lease) throw new PaneError('STALE_SESSION', 'Lease expired. Observe current state after reconnect; do not replay old mutations.');
      const work = () => this.#executor.run(() => this.#dispatch(name, args, signal), signal);
      if (name !== 'pane_act') return await work();
      const signature = createHash('sha256').update(JSON.stringify(this.#canonical(args))).digest('hex');
      return await this.#ledger.run(args.request, signature, work);
    } catch (error) { return this.#result({ error: PaneError.describe(error), completed: 0 }, true); }
  }

  #canonical(value) {
    if (Array.isArray(value)) return value.map(item => this.#canonical(item));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, this.#canonical(value[key])]));
  }

  #result(value, error = false) {
    return { content: [{ type: 'text', text: JSON.stringify({ v: 1, lease: this.#lease, ...value }) }], ...(error ? { isError: true } : {}) };
  }

  async #dispatch(name, args, signal) {
    if (this.#closed || signal?.aborted) throw new PaneError('CANCELLED', 'Session closed or request cancelled.');
    if (name === 'pane_tabs') return this.#result({ tabs: await this.#browser.list() });
    if (name === 'pane_view') return this.#result(await this.#observe(this.#browser.tab(args.tab), args));
    if (name === 'pane_act') return this.#act(args, signal);
    if (name === 'pane_read') return this.#read(args);
    return this.#image(args);
  }

  async #observe(tab, options = {}) {
    const document = tab.document, mutation = tab.mutation;
    const [snapshot, title] = await Promise.all([tab.snapshot(), tab.dialog ? '' : tab.page.title()]);
    tab.assert(document, mutation);
    const view = this.#observations.capture({ ...options, tab: tab.id, document,
      url: tab.page.url().slice(0, 4096), title: title.slice(0, 300), snapshot });
    this.#epochs.set(view.view, mutation);
    if (this.#epochs.size > 4) this.#epochs.delete(this.#epochs.keys().next().value);
    this.#latest.delete(tab.id);
    this.#latest.set(tab.id, view.view);
    if (this.#latest.size > 4) this.#latest.delete(this.#latest.keys().next().value);
    return { ...view, ...tab.metadata() };
  }

  #view(args) {
    const view = this.#observations.inspect(args.view);
    if (!view || view.tab !== args.tab || this.#latest.get(args.tab) !== args.view) {
      throw new PaneError('STALE_VIEW', 'Use the latest pane_view for this tab in this MCP session.');
    }
    const tab = this.#browser.tab(args.tab);
    tab.assert(view.document, this.#epochs.get(args.view));
    if (tab.page.url() !== view.url) throw new PaneError('STALE_VIEW', 'Tab URL changed. Observe again.');
    return { tab, view };
  }

  async #act(args, signal) {
    let tab, view;
    let outcome = { request: args.request, completed: 0 };
    try {
      if (args.steps[0].op === 'new') {
        outcome.mayHaveActed = true;
        tab = await this.#browser.create();
        if (signal?.aborted) throw new PaneError('CANCELLED', 'New tab created; navigation was cancelled.');
        const url = args.steps[0].url;
        if (url) await tab.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 });
        outcome.completed = 1;
        delete outcome.mayHaveActed;
        if (args.wait) await this.#actions.wait(tab, args.wait);
      } else {
        ({ tab, view } = this.#view(args));
        tab.consume(); // Invalidate every client's prior view before any input.
        if (args.steps[0].op === 'dialog') {
          outcome.mayHaveActed = true;
          await tab.handleDialog(args.steps[0].accept, args.steps[0].text);
          outcome.completed = 1;
          delete outcome.mayHaveActed;
          if (args.wait && !tab.dialog) await this.#actions.wait(tab, args.wait);
        } else {
          if (tab.dialog) throw new PaneError('DIALOG_OPEN', 'Handle the dialog before further input.');
          outcome = { request: args.request, ...await this.#actions.run(tab, args, view, signal) };
        }
      }
    } catch (error) { outcome.error = PaneError.describe(error); }
    if (tab) outcome.tab = tab.id;
    if (tab && !tab.page.isClosed() && !['close_requested', 'tab_closed'].includes(outcome.stopped) && args.observe !== 'none' && !signal?.aborted) {
      try {
        const options = view && view.document === tab.document
          ? { ...view.projection, ...(args.observe !== 'full' ? { since: view.view } : {}) } : {};
        outcome.observation = await this.#observe(tab, options);
      } catch (error) {
        outcome.observationError = PaneError.describe(error);
        outcome.recovery = 'Action outcome is above. Observe again; do not replay completed or uncertain input.';
      }
    }
    if (outcome.error || outcome.pendingStep !== undefined) outcome.recovery = 'Inspect current state before any new action. Retry the same request only to recover this recorded outcome.';
    return this.#result(outcome, Boolean(outcome.error));
  }

  async #image(args) {
    const { tab, view } = this.#view(args);
    if (tab.dialog) throw new PaneError('DIALOG_OPEN', 'Handle the dialog before capturing.');
    if (args.ref && !view.refs.has(args.ref)) throw new PaneError('STALE_REF', 'Screenshot ref is not in this observation.');
    const target = args.ref ? tab.page.locator(`aria-ref=${args.ref}`) : tab.page;
    const data = await target.screenshot({ type: 'jpeg', quality: 65, scale: 'css', timeout: 3000 });
    if (data.length > 1024 * 1024) throw new PaneError('IMAGE_LIMIT', 'Image exceeds 1 MiB; capture a smaller observed element.');
    return { content: [{ type: 'text', text: JSON.stringify({ v: 1, tab: tab.id, view: view.view, imageBytes: data.length }) },
      { type: 'image', data: data.toString('base64'), mimeType: 'image/jpeg' }] };
  }

  async #read(args) {
    const { tab, view } = this.#view(args);
    if (tab.dialog) throw new PaneError('DIALOG_OPEN', 'Handle the dialog before reading.');
    if (!view.refs.has(args.ref)) throw new PaneError('STALE_REF', 'Read ref is not in this observation.');
    const handle = await tab.page.locator(`aria-ref=${args.ref}`).elementHandle({ timeout: 1000 });
    if (!handle) throw new PaneError('STALE_REF', 'Observed element detached.');
    try {
      const value = await PaneReader.extract(handle, args);
      tab.assert(view.document, this.#epochs.get(args.view));
      return this.#result({ tab: tab.id, view: view.view, data: value });
    } finally { await handle.dispose(); }
  }

  async close() { this.#closed = true; this.#epochs.clear(); this.#latest.clear(); }
}
