import { PaneError } from './errors.mjs';
import { ObservationRefs } from './observation-refs.mjs';

/** Executes bounded semantic stages against the one shared browser tab. */
export class FlowRunner {
  #browser;
  #actions;
  #observations;

  constructor({ browser, actions, observations }) {
    this.#browser = browser;
    this.#actions = actions;
    this.#observations = observations;
  }

  async run(args, signal, trace, observe) {
    let tab, activeStage = 0;
    const popupVersion = this.#browser.popupVersion;
    const outcome = { request: args.request, completed: 0, stages: 0 };
    try {
      tab = this.#browser.tab(args.tab);
      for (const [stageIndex, stage] of args.stages.entries()) {
        activeStage = stageIndex;
        if (this.#browser.popupVersion !== popupVersion) { outcome.stopped = 'new_tab'; outcome.failedStage = stageIndex; break; }
        if (signal?.aborted) throw new PaneError('CANCELLED', 'Flow cancelled before the next stage.');
        if (tab.dialog) throw new PaneError('DIALOG_OPEN', 'Handle the dialog before starting a semantic flow.');
        const internal = await observe(tab, { detail: 'controls', limit: 1, maxChars: 64 }, trace);
        if (this.#browser.popupVersion !== popupVersion) { outcome.stopped = 'new_tab'; outcome.failedStage = stageIndex; break; }
        const observed = this.#observations.inspect(internal.view);
        const { steps, refs } = this.#resolveSteps(observed.snapshot, stage.steps);
        tab.consume();
        const result = await this.#actions.run(tab, { steps, wait: stage.wait },
          { document: observed.document, refs, popupVersion }, signal, trace);
        this.#applyStageResult(outcome, result, stageIndex, steps.length);
        if (result.error || result.completed !== steps.length ||
          (result.stopped && result.stopped !== 'navigation')) break;
      }
    } catch (error) {
      outcome.error = PaneError.describe(error); outcome.failedStage = activeStage;
      if (this.#browser.popupVersion !== popupVersion) outcome.stopped = 'new_tab';
    }
    if (tab) outcome.tab = tab.id;
    await this.#appendObservation(outcome, tab, args, signal, trace, observe);
    if (outcome.error || outcome.stopped || outcome.stages !== args.stages.length)
      outcome.recovery = 'Inspect current state before a new action. Retry the same request only to recover this recorded outcome.';
    return outcome;
  }

  #resolveSteps(snapshot, requested) {
    const refs = new Map();
    const steps = requested.map(step => {
      if (step.op === 'navigate') return { ...step };
      const matches = ObservationRefs.find(snapshot, step.target, 2);
      if (!matches.size) throw new PaneError('TARGET_NOT_FOUND', 'Semantic target was not present in the current accessibility state.');
      if (matches.size !== 1) throw new PaneError('AMBIGUOUS_TARGET', 'Semantic target matched more than one element; narrow role or name.');
      const [ref, signature] = matches.entries().next().value;
      refs.set(ref, signature);
      const { target: _target, ...resolved } = step;
      return { ...resolved, ref };
    });
    return { steps, refs };
  }

  #applyStageResult(outcome, result, stageIndex, stepCount) {
    outcome.completed += result.completed;
    if (result.stopped && result.stopped !== 'navigation') outcome.stopped = result.stopped;
    if (result.error) {
      outcome.error = result.error; outcome.failedStage = stageIndex;
      if (result.failedStep !== undefined) outcome.failedStep = result.failedStep;
      if (result.mayHaveActed !== undefined) outcome.mayHaveActed = result.mayHaveActed;
      return;
    }
    if (result.completed !== stepCount || outcome.stopped) {
      outcome.stopped = result.stopped ?? 'partial_stage'; outcome.failedStage = stageIndex;
      if (result.pendingStep !== undefined) outcome.pendingStep = result.pendingStep;
      return;
    }
    outcome.stages++;
  }

  async #appendObservation(outcome, tab, args, signal, trace, observe) {
    if (!tab || tab.page.isClosed() || ['new_tab', 'dialog', 'tab_closed'].includes(outcome.stopped) ||
      args.observe === 'none' || signal?.aborted) return;
    try { outcome.observation = await observe(tab, {}, trace); }
    catch (error) {
      outcome.observationError = PaneError.describe(error);
      outcome.recovery = 'Flow outcome is above. Observe again; do not replay completed or uncertain input.';
    }
  }
}
