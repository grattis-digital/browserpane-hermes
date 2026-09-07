import assert from 'node:assert/strict';
import { CompactEngineFixture } from './compact-engine-fixture.mjs';

/** Real Chromium regressions against only the caller's disposable fixture. */
export class CompactBoundaryChecks {
  static async run(fixture) {
    await this.#popupWait(fixture);
    await this.#pagination(fixture);
    await this.#validation(fixture);
  }

  static async #popupWait(fixture) {
    const session = fixture.session();
    const page = await fixture.reset(`<button id="start">Start</button><button id="confirm">Confirm</button><p id="status"></p>
      <script>window.confirmations=0;window.events=[];
      document.querySelector('#start').onclick=()=>{
        events.push('start');
        setTimeout(()=>{window.open('about:blank');events.push('popup');},150);
        setTimeout(()=>{document.querySelector('#status').textContent='Ready';events.push('ready');},450);
      };
      document.querySelector('#confirm').onclick=()=>{confirmations++;events.push('confirm');};</script>`);
    const args = { lease: session.lease, request: ++session.request, observe: 'none', stages: [
      { steps: [{ op: 'click', target: { role: 'button', name: 'Start' } }], wait: { text: 'Ready', timeoutMs: 3000 } },
      { steps: [{ op: 'click', target: { role: 'button', name: 'Confirm' } }] },
    ] };
    const result = await fixture.call(session, 'pane_flow', args);
    assert.equal(result.isError, false); assert.equal(result.stopped, 'new_tab');
    assert.equal(result.completed, 1); assert.equal(result.stages, 0); assert.equal(result.failedStage, 0);
    assert.equal(result.observation, undefined);
    await fixture.waitForTabs(2);
    assert.deepEqual(await fixture.call(session, 'pane_flow', args), result);
    assert.equal(await page.evaluate(() => confirmations), 0);
    const tabs = (await fixture.call(session, 'pane_tabs')).tabs;
    const opened = tabs.find(tab => tab.tab !== result.tab); assert(opened);
    const view = await fixture.view(session, { tab: opened.tab });
    const closed = await fixture.act(session, view, [{ op: 'close' }]); assert.equal(closed.isError, false);
    await fixture.waitForTabs(1);
  }

  static async #pagination(fixture) {
    const session = fixture.session();
    await fixture.reset('<p>Intro</p><button>Save first</button><p>Middle</p><button>Save second</button><button>Delete</button>');
    const query = { role: 'button', name: 'Save', exact: false };
    const full = await fixture.view(session, { query });
    // A focused body can add a structural ancestor; count it, never discard it.
    const limit = full.text.split('\n').findIndex(line => line.includes('"Save first"')) + 1;
    assert(limit > 0);
    const first = await fixture.view(session, { state: full.state, query, limit });
    assert.equal(first.isError, false); assert.match(first.text, /Save first/);
    const next = await fixture.view(session, { cursor: first.cursor });
    assert.equal(next.isError, false); assert.match(next.text, /Save second/);
    assert.doesNotMatch(next.text, /Save first|Delete/); assert.equal(next.cursor, undefined);
    assert.equal(next.state, first.state); assert.equal(next.total, full.total); assert.equal(next.matches, 2);
    const unreturned = await fixture.act(session, next, [{ op: 'click', ref: CompactEngineFixture.ref(first, 'Save first') }], { observe: 'none' });
    assert.equal(unreturned.error.code, 'STALE_REF'); assert.equal(unreturned.completed, 0);
  }

  static async #validation(fixture) {
    const session = fixture.session();
    const result = await fixture.call(session, 'pane_flow', { lease: session.lease, request: 1, stages: [{}] });
    assert.equal(result.isError, true); assert.equal(result.error.code, 'INVALID_ARGUMENT');
    assert.equal(result.completed, 0);
  }
}
