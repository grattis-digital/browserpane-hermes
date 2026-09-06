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
  #flow;
  #epochs = new Map();
  #latest = new Map();
  #closed = false;
  #lease;
  #metrics;

  constructor({ browser, executor, observations, ledger, actions, flow, lease, metrics }) {
    this.#browser = browser; this.#executor = executor; this.#observations = observations;
    this.#ledger = ledger; this.#actions = actions;
    this.#flow = flow;
    this.#lease = lease;
    this.#metrics = metrics;
  }
  listTools() { return PaneSchemas.tools(); }

  async callTool(name, input, { signal } = {}) {
    const trace = this.#metrics?.start(name);
    let result;
    try {
      if (this.#closed) throw new PaneError('SESSION_CLOSED', 'Initialize a new MCP session.');
      const args = PaneValidation.parse(name, input);
      const mutating = name === 'pane_act' || name === 'pane_flow';
      if (mutating && args.lease !== this.#lease) throw new PaneError('STALE_SESSION', 'Lease expired. Observe current state after reconnect; do not replay old mutations.');
      let executed = false;
      const work = () => this.#executor.run(() => { executed = true; trace?.queueDone(); return this.#dispatch(name, args, signal, trace); }, signal);
      if (!mutating) result = await work();
      else {
        const signature = createHash('sha256').update(JSON.stringify(this.#canonical(args))).digest('hex');
        result = await this.#ledger.run(args.request, signature, work);
        if (!executed) trace?.increment('replays');
      }
    } catch (error) { result = this.#result({ error: PaneError.describe(error), completed: 0 }, true); }
    trace?.finish(result);
    return result;
  }

  #canonical(value) {
    if (Array.isArray(value)) return value.map(item => this.#canonical(item));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, this.#canonical(value[key])]));
  }

  #result(value, error = false) {
    return { content: [{ type: 'text', text: JSON.stringify({ v: 1, lease: this.#lease, ...value }) }], ...(error ? { isError: true } : {}) };
  }

  async #dispatch(name, args, signal, trace) {
    if (this.#closed || signal?.aborted) throw new PaneError('CANCELLED', 'Session closed or request cancelled.');
    if (name === 'pane_tabs') return this.#result({ tabs: await this.#browser.list() });
    if (name === 'pane_view') {
      let tab;
      if (args.state) {
        const source = this.#observations.source(args.state);
        if (!source) { trace?.increment('stateMisses'); throw new PaneError('STALE_STATE', 'Observation state expired. Capture a fresh pane_view.'); }
        if (args.tab !== undefined && args.tab !== source.tab) throw new PaneError('STALE_STATE', 'Observation state belongs to another tab.');
        tab = this.#browser.tab(source.tab);
      } else tab = this.#browser.tab(args.tab);
      return this.#result(await this.#observe(tab, args, trace));
    }
    if (name === 'pane_act') return this.#act(args, signal, trace);
    if (name === 'pane_flow') {
      const outcome = await this.#flow.run(args, signal, trace,
        (tab, options, activeTrace) => this.#observe(tab, options, activeTrace));
      return this.#result(outcome, Boolean(outcome.error));
    }
    if (name === 'pane_read') return this.#read(args, trace);
    return this.#image(args, trace);
  }

  async #observe(tab, options = {}, trace) {
    if (options.state) {
      const source = this.#observations.source(options.state);
      if (!source || source.tab !== tab.id) throw new PaneError('STALE_STATE', 'Observation state expired or belongs to another tab.');
      tab.assert(source.document, source.mutation);
      if (tab.page.url() !== source.url) throw new PaneError('STALE_STATE', 'Tab URL changed. Capture a fresh pane_view.');
      const { state, tab: _tab, ...projection } = options;
      trace?.increment('stateHits');
      const view = trace ? await trace.span('projectionMs', () => this.#observations.reproject(state, projection))
        : this.#observations.reproject(state, projection);
      this.#remember(tab.id, view, source.mutation);
      return { ...view, ...tab.metadata() };
    }
    const document = tab.document, mutation = tab.mutation;
    const snapshotWork = trace ? trace.span('snapshotMs', () => tab.snapshot()) : tab.snapshot();
    const [snapshot, title] = await Promise.all([snapshotWork, tab.dialog ? '' : tab.page.title()]);
    trace?.increment('snapshots');
    tab.assert(document, mutation);
    const capture = () => this.#observations.capture({ ...options, tab: tab.id, document, mutation,
      url: tab.page.url().slice(0, 4096), title: title.slice(0, 300), snapshot });
    const view = trace ? await trace.span('projectionMs', capture) : capture();
    this.#remember(tab.id, view, mutation);
    return { ...view, ...tab.metadata() };
  }

  #remember(tab, view, mutation) {
    this.#epochs.set(view.view, mutation);
    if (this.#epochs.size > 4) this.#epochs.delete(this.#epochs.keys().next().value);
    this.#latest.delete(tab);
    this.#latest.set(tab, view.view);
    if (this.#latest.size > 4) this.#latest.delete(this.#latest.keys().next().value);
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

  async #act(args, signal, trace) {
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
        if (args.wait) await this.#actions.wait(tab, args.wait, trace);
      } else {
        ({ tab, view } = this.#view(args));
        tab.consume(); // Invalidate every client's prior view before any input.
        if (args.steps[0].op === 'dialog') {
          outcome.mayHaveActed = true;
          await tab.handleDialog(args.steps[0].accept, args.steps[0].text);
          outcome.completed = 1;
          delete outcome.mayHaveActed;
          if (args.wait && !tab.dialog) await this.#actions.wait(tab, args.wait, trace);
        } else {
          if (tab.dialog) throw new PaneError('DIALOG_OPEN', 'Handle the dialog before further input.');
          outcome = { request: args.request, ...await this.#actions.run(tab, args, view, signal, trace) };
        }
      }
    } catch (error) { outcome.error = PaneError.describe(error); }
    if (tab) outcome.tab = tab.id;
    if (tab && !tab.page.isClosed() && !['close_requested', 'tab_closed'].includes(outcome.stopped) && args.observe !== 'none' && !signal?.aborted) {
      try {
        const options = view && view.document === tab.document
          ? { ...view.projection, ...(args.observe !== 'full' ? { since: view.view } : {}) } : {};
        outcome.observation = await this.#observe(tab, options, trace);
      } catch (error) {
        outcome.observationError = PaneError.describe(error);
        outcome.recovery = 'Action outcome is above. Observe again; do not replay completed or uncertain input.';
      }
    }
    if (outcome.error || outcome.pendingStep !== undefined) outcome.recovery = 'Inspect current state before any new action. Retry the same request only to recover this recorded outcome.';
    return this.#result(outcome, Boolean(outcome.error));
  }

  async #image(args, trace) {
    const { tab, view } = this.#view(args);
    if (tab.dialog) throw new PaneError('DIALOG_OPEN', 'Handle the dialog before capturing.');
    if (args.ref && !view.refs.has(args.ref)) throw new PaneError('STALE_REF', 'Screenshot ref is not in this observation.');
    const target = args.ref ? tab.page.locator(`aria-ref=${args.ref}`) : tab.page;
    const screenshot = () => target.screenshot({ type: 'jpeg', quality: 65, scale: 'css', timeout: 3000 });
    const data = trace ? await trace.span('imageMs', screenshot) : await screenshot();
    if (data.length > 1024 * 1024) throw new PaneError('IMAGE_LIMIT', 'Image exceeds 1 MiB; capture a smaller observed element.');
    return { content: [{ type: 'text', text: JSON.stringify({ v: 1, tab: tab.id, view: view.view, imageBytes: data.length }) },
      { type: 'image', data: data.toString('base64'), mimeType: 'image/jpeg' }] };
  }

  async #read(args, trace) {
    const { tab, view } = this.#view(args);
    if (tab.dialog) throw new PaneError('DIALOG_OPEN', 'Handle the dialog before reading.');
    if (!view.refs.has(args.ref)) throw new PaneError('STALE_REF', 'Read ref is not in this observation.');
    const handle = await tab.page.locator(`aria-ref=${args.ref}`).elementHandle({ timeout: 1000 });
    if (!handle) throw new PaneError('STALE_REF', 'Observed element detached.');
    try {
      const value = trace ? await trace.span('readMs', () => PaneReader.extract(handle, args)) : await PaneReader.extract(handle, args);
      tab.assert(view.document, this.#epochs.get(args.view));
      return this.#result({ tab: tab.id, view: view.view, data: value });
    } finally { await handle.dispose(); }
  }

  async close() { this.#closed = true; this.#epochs.clear(); this.#latest.clear(); this.#observations?.clear(); }
}
