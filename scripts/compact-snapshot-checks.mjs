import assert from 'node:assert/strict';

/** Renderer stalls only in the caller-owned disposable Chromium, never a live endpoint. */
export class CompactSnapshotChecks {
  static async #busy(page, work) {
    const started = page.waitForEvent('console', { predicate: message => message.text() === 'owned-snapshot-busy', timeout: 10000 });
    // The console event is emitted before blocking the renderer. Both CDP
    // connections see the same busy thread; no extra tab or guessed sleep.
    const busy = page.evaluate(() => {
      console.info('owned-snapshot-busy');
      const end = performance.now() + 4200;
      while (performance.now() < end) { /* Owned synthetic main-thread load. */ }
    }).then(() => ({}), error => ({ error }));
    try { await started; return await work(); }
    finally { const result = await busy; if (result.error) throw result.error; }
  }

  static async run(fixture) {
    const page = await fixture.reset('<button id="save">Snapshot save</button><script>window.saved=0;save.onclick=()=>saved++;</script>');
    const session = fixture.session(), initial = await fixture.view(session);
    assert(!initial.isError);
    const managed = fixture.pageFor(initial.tab);
    await this.#busy(page, () => assert.rejects(managed._snapshotForAI({ timeout: 3000 }), { name: 'TimeoutError' }));
    const started = performance.now();
    const view = await this.#busy(page, () => fixture.view(session));
    assert(!view.isError, JSON.stringify(view)); assert.equal(view.tab, initial.tab);
    assert.match(view.text, /Snapshot save/); assert(performance.now() - started >= 3000);
    const cached = await fixture.view(session, { state: view.state, detail: 'controls' });
    assert(!cached.isError); assert.equal(cached.state, view.state);
    const ref = view.text.match(/\[ref=([^\]]+)\]/)?.[1]; assert(ref);
    const acted = await this.#busy(page, () => fixture.act(session, cached, [{ op: 'click', ref }], { observe: 'none' }));
    assert(!acted.isError, JSON.stringify(acted)); assert.equal(acted.completed, 1);
    assert.equal(await page.evaluate(() => window.saved), 1);
    const replay = await fixture.call(session, 'pane_act', { lease: session.lease, request: session.request,
      tab: cached.tab, view: cached.view, steps: [{ op: 'click', ref }], observe: 'none' });
    assert.deepEqual(replay, acted); assert.equal(await page.evaluate(() => window.saved), 1);
    await fixture.waitForTabs(1);
  }
}
