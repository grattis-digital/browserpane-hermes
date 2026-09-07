import { PaneError } from './errors.mjs';
import { ElementGuard } from './element-guard.mjs';
import { ObservationRefs } from './observation-refs.mjs';

export class ActionRunner {
  #browser;
  #steps;
  #now;
  constructor(browser, steps, now) { this.#browser = browser; this.#steps = steps; this.#now = now; }

  async wait(tab, condition, trace) {
    if (trace) await trace.span('waitMs', () => this.#steps.wait(tab, condition));
    else await this.#steps.wait(tab, condition);
  }

  async #guards(tab, steps, observation, trace) {
    const refs = [...new Set(steps.flatMap(step => [step.ref, step.to].filter(Boolean)))];
    const guards = new Map();
    if (!refs.length) return guards;
    const snapshot = trace ? await trace.span('guardSnapshotMs', () => tab.snapshot()) : await tab.snapshot();
    if (observation.requiredSnapshot !== undefined && snapshot !== observation.requiredSnapshot)
      throw new PaneError('STALE_VIEW', 'Page state changed during guarded-flow preflight; no input was started.');
    const current = ObservationRefs.from(snapshot);
    try {
      for (const ref of refs) {
        const signature = observation.refs.get(ref);
        if (!signature || current.get(ref) !== signature) throw new PaneError('STALE_REF', 'Target missing or changed since this view. Observe again.');
        const handle = await tab.page.locator(`aria-ref=${ref}`).elementHandle({ timeout: 1000 });
        if (!handle) throw new PaneError('STALE_REF', 'Target detached. Observe again.');
        try {
          const descriptor = await handle.evaluate(ElementGuard.describe);
          if (descriptor === null) throw new PaneError('STALE_REF', 'Target detached. Observe again.');
          guards.set(ref, new ElementGuard(handle, descriptor));
        } catch (error) { await handle.dispose(); throw error; }
      }
      return guards;
    } catch (error) { await Promise.allSettled([...guards.values()].map(guard => guard.dispose())); throw error; }
  }

  async run(tab, args, observation, signal, trace) {
    const outcome = { completed: 0 };
    const popups = observation.popupVersion ?? this.#browser.popupVersion;
    const guards = trace
      ? await trace.span('guardMs', () => this.#guards(tab, args.steps, observation, trace))
      : await this.#guards(tab, args.steps, observation);
    if (tab.document !== observation.document && this.#browser.popupVersion === popups) {
      await Promise.allSettled([...guards.values()].map(guard => guard.dispose()));
      throw new PaneError('STALE_VIEW', 'Document changed during preflight; no input was started.');
    }
    const document = tab.document;
    const deadline = this.#now() + 15000;
    try {
      for (const [index, step] of args.steps.entries()) {
        let issued = false;
        try {
          if (signal?.aborted) throw new PaneError('CANCELLED', 'Cancelled; remaining steps were not started.');
          if (this.#browser.popupVersion !== popups) { outcome.stopped = 'new_tab'; break; }
          if (tab.document !== document) { outcome.stopped = 'navigation'; break; }
          if (tab.dialog) { outcome.stopped = 'dialog'; break; }
          if (this.#now() >= deadline) throw new PaneError('BATCH_TIMEOUT', 'Batch deadline reached; remaining steps were not started.');
          if (step.ref) await guards.get(step.ref).assert();
          if (step.to) await guards.get(step.to).assert();
          if (signal?.aborted) throw new PaneError('CANCELLED', 'Cancelled before input; remaining steps were not started.');
          if (this.#now() >= deadline) throw new PaneError('BATCH_TIMEOUT', 'Batch deadline reached before input.');
          if (this.#browser.popupVersion !== popups) { outcome.stopped = 'new_tab'; break; }
          if (tab.document !== document) throw new PaneError('STALE_VIEW', 'Document changed while checking target.');
          if (tab.dialog) { outcome.stopped = 'dialog'; break; }
          // Click completion includes Playwright's post-input CDP/navigation
          // fence. A loaded Pi can pause that fence beyond 3s after a successful
          // download. Keep its checks; use the navigation budget, never a retry.
          // Compute the remaining budget AFTER awaited target guards.
          const navigates = step.op === 'navigate' || step.op === 'back' || step.op === 'click';
          const timeout = Math.min(navigates ? 10000 : 3000, deadline - this.#now());
          if (timeout <= 0) throw new PaneError('BATCH_TIMEOUT', 'Batch deadline reached before input.');
          issued = true;
          const perform = () => tab.act(() => this.#steps.perform(tab, step, guards, timeout, signal));
          const result = trace ? await trace.span('inputMs', perform) : await perform();
          if (result.modal) { outcome.stopped = 'dialog'; outcome.pendingStep = index; break; }
          outcome.completed++;
          if (step.op === 'close') { outcome.stopped = tab.page.isClosed() ? 'tab_closed' : 'close_requested'; break; }
          if (tab.page.isClosed()) { outcome.stopped = 'tab_closed'; break; }
          if (this.#browser.popupVersion !== popups) { outcome.stopped = 'new_tab'; break; }
          if (tab.document !== document) { outcome.stopped = 'navigation'; break; }
        } catch (error) {
          outcome.error = PaneError.describe(error); outcome.failedStep = index;
          outcome.mayHaveActed = issued; break;
        }
      }
      if (!outcome.error && (!outcome.stopped || outcome.stopped === 'navigation') &&
        !tab.dialog && !tab.page.isClosed() && args.wait) {
        try {
          if (trace) await trace.span('waitMs', () => this.#steps.wait(tab, args.wait));
          else await this.#steps.wait(tab, args.wait);
        }
        catch (error) { outcome.error = { ...PaneError.describe(error), code: 'POSTCONDITION_FAILED' }; outcome.mayHaveActed = true; }
      }
      if (this.#browser.popupVersion !== popups) outcome.stopped = 'new_tab';
      else if (tab.dialog) outcome.stopped = 'dialog';
      else if (tab.page.isClosed()) outcome.stopped = 'tab_closed';
      return outcome;
    } finally { await tab.releaseWhenSettled(() => Promise.allSettled([...guards.values()].map(guard => guard.dispose()))); }
  }
}
