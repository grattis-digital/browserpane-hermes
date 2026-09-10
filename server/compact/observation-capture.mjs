import { PaneError } from './errors.mjs';
import { ObservationRefs } from './observation-refs.mjs';

/** Browser capture and immutable-state projection, without session/lease ownership. */
export class ObservationCapture {
  static async run(tab, options, trace, observations) {
    if (options.state) {
      const source = observations.source(options.state);
      if (!source || source.tab !== tab.id) throw new PaneError('STALE_STATE', 'Observation state expired or belongs to another tab.');
      tab.assert(source.document, source.mutation);
      if (tab.page.url() !== source.url) throw new PaneError('STALE_STATE', 'Tab URL changed. Capture a fresh pane_view.');
      const { state, tab: _tab, ...projection } = options;
      trace?.increment('stateHits');
      return trace ? trace.span('projectionMs', () => observations.reproject(state, projection))
        : observations.reproject(state, projection);
    }
    const document = tab.document, mutation = tab.mutation;
    const work = () => tab.snapshot(options);
    const snapshotWork = trace ? trace.span('snapshotMs', work) : work();
    const [snapshot, title] = await Promise.all([snapshotWork, tab.dialog ? '' : tab.page.title()]);
    trace?.increment('snapshots'); trace?.increment('snapshotBytes', Buffer.byteLength(snapshot, 'utf8'));
    tab.assert(document, mutation);
    if (options.root && !options.enterFrame && !ObservationRefs.from(snapshot).has(options.root))
      throw new PaneError('STALE_REF', 'Scope changed since observation. Capture a fresh outline.');
    if (tab.coverage) trace?.increment('snapshotNodes', tab.coverage.visitedNodes);
    const capture = () => observations.capture({ ...options, tab: tab.id, document, mutation,
      url: tab.page.url().slice(0, 4096), title: title.slice(0, 300), snapshot, coverage: tab.coverage });
    return trace ? trace.span('projectionMs', capture) : capture();
  }
}
