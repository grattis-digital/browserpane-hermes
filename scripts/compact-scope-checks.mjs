import assert from 'node:assert/strict';
import { CompactEngineFixture as Fixture } from './compact-engine-fixture.mjs';

/** Scoped observation and stale-reference checks in the caller-owned browser only. */
export class CompactScopeChecks {
  static async run(fixture) {
    await this.#transparentWrappers(fixture);
    await this.#progressive(fixture);
    await this.#framesAndShadow(fixture);
    await this.#externalLabels(fixture);
    await fixture.waitForTabs(1);
  }

  static async #transparentWrappers(fixture) {
    await fixture.reset(`${'<div>'.repeat(20)}<main aria-label="Nested workspace"><button>Inside</button></main>${'</div>'.repeat(20)}`);
    const view = await fixture.view(fixture.session(), { capture: 'outline' });
    assert(!view.isError, JSON.stringify(view));
    assert(Fixture.ref(view, 'Nested workspace'));
    assert.equal(view.coverage.depth, 1);
    assert(view.coverage.visitedNodes < 30);
  }

  static async #progressive(fixture) {
    const rows = Array.from({ length: 3000 }, (_, i) => `<article><h2>Result ${i}</h2><p>Long synthetic research result ${i}</p></article>`).join('');
    const page = await fixture.reset(`<main aria-label="Workspace"><form aria-label="Search panel">
      <label>Topic<input id="topic"></label><button id="save" type="button">Search</button></form>
      <section aria-label="Results">${rows}</section></main><aside aria-label="Sidebar"><button>Other action</button></aside>
      <p id="status"></p><script>window.saved=0;save.onclick=()=>{saved++;document.getElementById('status').textContent=topic.value;};</script>`);
    const session = fixture.session(), other = fixture.session();
    let view = await fixture.view(session, { capture: 'outline', depth: 1 });
    assert(!view.isError, JSON.stringify(view)); assert.equal(view.coverage.complete, false);
    assert(view.coverage.visitedNodes < 20); assert(!view.text.includes('Result 2999'));
    const workspace = Fixture.ref(view, 'Workspace');
    view = await fixture.view(session, { tab: view.tab, view: view.view, root: workspace, capture: 'outline', depth: 1 });
    assert(!view.isError); assert(view.coverage.visitedNodes < 10);
    const panel = Fixture.ref(view, 'Search panel');
    view = await fixture.view(session, { tab: view.tab, view: view.view, root: panel });
    assert(!view.isError, JSON.stringify(view)); assert.equal(view.coverage.scope, panel); assert.equal(view.coverage.complete, true);
    assert(!view.text.includes('Result 2999')); assert(!view.text.includes('Other action'));
    // Another client's outline/expansion must not silently remap our exact refs.
    let elsewhere = await fixture.view(other, { capture: 'outline', depth: 1 });
    elsewhere = await fixture.view(other, { tab: elsewhere.tab, view: elsewhere.view, root: Fixture.ref(elsewhere, 'Sidebar') });
    assert(!elsewhere.isError);
    const acted = await fixture.act(session, view, [
      { op: 'fill', ref: Fixture.ref(view, 'Topic'), text: 'Scoped research' },
      { op: 'click', ref: Fixture.ref(view, 'Search') },
    ]);
    assert(!acted.isError, JSON.stringify(acted)); assert.equal(acted.completed, 2);
    assert.equal(await page.locator('#topic').inputValue(), 'Scoped research');
    assert.equal(await page.evaluate(() => window.saved), 1);
    assert.equal(await page.locator('#status').textContent(), 'Scoped research');
    assert(acted.observation.coverage); assert(acted.observation.coverage.visitedNodes <= 256);
    const deep = await fixture.view(session, { capture: 'outline', depth: 6, maxChars: 24576, limit: 500 });
    assert(!deep.isError); assert.equal(deep.coverage.nodeLimited, true); assert.equal(deep.coverage.visitedNodes, 256);
    assert.equal(deep.coverage.complete, false);
    const strict = await fixture.flow(session, [{ steps: [{ op: 'click', target: { role: 'button', name: 'Search' } }] }], { tab: deep.tab, view: deep.view });
    assert.equal(strict.error.code, 'SCOPED_VIEW'); assert.equal(await page.evaluate(() => window.saved), 1);
  }

  static async #framesAndShadow(fixture) {
    const page = await fixture.reset('<main aria-label="Frame workspace"><div id="shadow"></div><iframe></iframe></main>');
    await page.locator('#shadow').evaluate(element => {
      const root = element.attachShadow({ mode: 'open' });
      root.innerHTML = '<button>Shadow action</button>';
      root.querySelector('button').onclick = () => { window.shadowClicked = true; };
    });
    await page.locator('iframe').evaluate(element => { element.srcdoc = '<button onclick="window.frameClicked=true">Frame action</button>'; });
    await page.frameLocator('iframe').getByRole('button').waitFor({ state: 'visible' });
    const session = fixture.session();
    let view = await fixture.view(session, { capture: 'outline', depth: 5 });
    assert(!view.isError); assert.equal(view.coverage.framesDeferred, 1);
    assert(view.text.includes('Shadow action')); assert(!view.text.includes('Frame action'));
    // The private adapter also tolerates tracking with deliberately deferred
    // frames. MCP itself owns deltas per session and does not use this track key.
    const tracked = { timeout: 3000, maxDepth: 5, maxNodes: 256, includeFrames: false, track: 'owned-scope-test' };
    await fixture.pageFor(view.tab)._snapshotForAI(tracked);
    const incremental = await fixture.pageFor(view.tab)._snapshotForAI(tracked);
    assert.equal(incremental.coverage.framesDeferred, 1);
    assert(!incremental.full.includes('Frame action'));
    const frameRef = view.text.match(/- iframe \[ref=([^\]]+)\]/)?.[1]; assert(frameRef);
    view = await fixture.view(session, { tab: view.tab, view: view.view, root: frameRef, enterFrame: true });
    assert(!view.isError, JSON.stringify(view)); assert.equal(view.coverage.enterFrame, true);
    const frameAction = await fixture.act(session, view, [{ op: 'click', ref: Fixture.ref(view, 'Frame action') }], { observe: 'none' });
    assert(!frameAction.isError, JSON.stringify(frameAction));
    assert.equal(await page.frames()[1].evaluate(() => window.frameClicked), true);
    view = await fixture.view(session, { capture: 'outline', depth: 5 });
    const shadowAction = await fixture.act(session, view, [{ op: 'click', ref: Fixture.ref(view, 'Shadow action') }], { observe: 'none' });
    assert(!shadowAction.isError, JSON.stringify(shadowAction));
    assert.equal(await page.evaluate(() => window.shadowClicked), true);
  }

  static async #externalLabels(fixture) {
    const page = await fixture.reset('<span id="label">Approve draft</span><main aria-label="Panel"><button id="target" aria-labelledby="label">Go</button></main><script>window.calls=0;target.onclick=()=>calls++;</script>');
    const session = fixture.session();
    let view = await fixture.view(session, { capture: 'outline', depth: 1 });
    view = await fixture.view(session, { tab: view.tab, view: view.view, root: Fixture.ref(view, 'Panel') });
    const target = Fixture.ref(view, 'Approve draft');
    await page.locator('#label').evaluate(element => { element.textContent = 'Approve payment'; });
    const changed = await fixture.act(session, view, [{ op: 'click', ref: target }], { observe: 'none' });
    assert.equal(changed.error.code, 'STALE_REF'); assert.equal(await page.evaluate(() => window.calls), 0);
    view = await fixture.view(session, { capture: 'outline', depth: 5 });
    const replacementRef = Fixture.ref(view, 'Approve payment');
    await page.locator('#target').evaluate(element => { element.outerHTML = element.outerHTML; });
    const replaced = await fixture.act(session, view, [{ op: 'click', ref: replacementRef }], { observe: 'none' });
    assert.equal(replaced.error.code, 'STALE_REF'); assert.equal(await page.evaluate(() => window.calls), 0);
  }
}
